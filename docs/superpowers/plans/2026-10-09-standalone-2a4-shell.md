# План 2a4: оболочка этапа 2a — печать, сканеры, сон, тайм-аут запроса, имя устройства и «забывание» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оболочка «Маркиро Автоном» умеет то, что нужно цеху этапа 2a от компьютера: отправить байты этикетки на сетевой, COM- или USB-принтер с честным ответом «не отправлено» / «исход неизвестен», слушать несколько COM-сканеров и сообщать вебвью каждый скан, не давать компьютеру засыпать, ограничивать запрос к хосту коротким тайм-аутом, знать имя устройства, а «забывание» подключения не трогает данных устройства и не стирает неотправленного. Вебвью получает к этому обёртки `src/hardware/hardware.ts`; экраны цеха, которые ими пользуются, — планы 2a5–2a7.

**Architecture:**

- Шаг владельца (задача 1): `serialport =4.9.0`, `base64` для всех ОС, признаки `windows-sys` печати, питания и (из незакрытого шага 1f2) киоск-режима, `libudev-dev` в задании CI `standalone-rust`; ожидаемый дифф `Cargo.lock` — семь новых пакетов.
- Связь с хостом: `PinnedClient::send_within` и `DeviceState::request_within` с необязательным пределом; команда `host_request` принимает `timeoutMs` (100–10 000), истёкший предел — новый транспортный код `timeout` (задача 2).
- Имя устройства: `deviceName` в `DeviceStatus` и `device.json` (файл старой версии читается), обновляется ответом хоста при `device_refresh` и `device_select_line` (задача 3).
- Локальная база: классы таблиц `TABLE_CLASSES` (`Disposable`, `DeviceData`, `Workstation`) и тест, который падает на таблице без класса (задача 4); `device_forget` отказывает `unsent_facts`, пока у текущего подключения есть записи `outbox` без квитанции, принимает `keepUnsent`, а нечитаемую базу переносит в сторону и открывает новую (задача 5).
- Оборудование — порт облачной станции (`apps/station/src-tauri/src/{power,printer,scanner}.rs`) со строгими голыми кодами: `power.rs` и `power/windows.rs` (задача 6, без шага владельца на macOS), `printer.rs` и `printer/spooler.rs` (задача 7), `scanner.rs`, `scanner/runtime.rs` и его тесты (задача 8). Код под `cfg(windows)` лежит в отдельных файлах только на `std` и `windows-sys`, поэтому его проверяет крейт-пробник под `x86_64-pc-windows-msvc`.
- Вебвью: `src/hardware/hardware.ts` (`createTauriHardware`), `timeoutMs` в `src/host/client.ts`, `forget({ keepUnsent })` в `src/host/device.ts`, `deviceName` в `deviceStatusSchema`; документы `apps/standalone/AGENTS.md` и §16 спецификации этапа (задача 9).
- Хост, `proto`, `apps/station`, `packages/*` и `package.json`/`pnpm-lock.yaml` не меняются.

**Tech Stack:** Rust — Tauri 2.11 (`tauri::test`, mock runtime), reqwest 0.13.4, sqlx 0.8.6 (SQLite), `serialport` 4.9.0, `base64` 0.22.1, `windows-sys` 0.61.2 под `cfg(windows)`; вебвью — TypeScript 6 (strict), zod 4.4.3, `@tauri-apps/api` 2.11.1, Vitest 4.

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — решения 20, 24, 30, 34, §5.2 (Rust-часть), §5.3 (классы таблиц), §7 (тесты оболочки и ручной список), §8 (строка плана 2a4), §11 (В5, В7, В11), §13 («Оболочка»).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §5.1–5.2 (оболочка, перенесённые команды).
- `apps/standalone/AGENTS.md` — «Local database», «Network and TLS», «Device key and office session», «Logs», «Verification».
- План 1f2 (`docs/superpowers/plans/2026-10-07-standalone-1f2-kiosk-mode.md`): задача 1 (шаг владельца не сделан) и «Отклонения при исполнении»; итоговое ревью 1f2 (`.superpowers/sdd/1f2-final-review-report.md`): зависающий тест вместо падающего, застрявшие флаги, свойство «никого не запереть», ни разу не скомпилированный `cfg(windows)`.
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src-tauri/src/{printer,scanner,power}.rs`, `scanner/runtime.rs`, `scanner/runtime_tests.rs`, `power/windows.rs`, `apps/station/src/lib/hardware.ts`.

## Допущения по вопросам владельцу

Владелец сказал «по порядку», не ответив на вопросы раздела 11 спецификации этапа; план исполняет рекомендованные варианты:

- **В5 — одобрено, как рекомендовано.** `serialport = "=4.9.0"` (версия облачной станции в её `Cargo.lock`), `base64 = "=0.22.1"` для всех ОС, признаки `windows-sys` `Win32_Graphics_Printing`, `Win32_Security`, `Win32_System_Power`, `Win32_System_Threading` и заодно незакрытые шагом 1f2 `Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging`; `libudev-dev` в `standalone-rust`. Это задача 1 — шаг владельца.
- **В7 — вариант А с выходом Б для экрана отказа.** «Забывание» отказывает (`unsent_facts`), пока у записей `outbox` текущего подключения нет квитанции; подтверждение — аргумент `keepUnsent: true`, записи остаются на диске; нечитаемая база переименовывается, а не удаляется. Экран с подтверждением и числом записей — план 2a5 (здесь только команда и обёртка).
- **В11 — вариант А.** `set_system_awake(true)` вызывает рабочий экран смены, `false` — уход с него (план 2a7); здесь только команда.
- **В6 — значения по умолчанию.** 300 мс проверки кода ложатся в границы `timeoutMs` 100–10 000; само число задаёт план 2a6.
- Вопросы В1–В4, В8–В10, В12–В14 оболочку не затрагивают.

## Global Constraints

**Из спецификации этапа** (дословные значения)

- `apps/station`, `apps/api`, `apps/admin` и `packages/*` не меняются: модули облачной станции копируются, а не выносятся в общий пакет.
- Отказы оболочки — голые коды; текст ошибки системы в IPC не уходит, только в журнал процесса именем команды.
- Печать: `print_bytes(target, payloadBase64)`, `PrintTarget` — `{ kind: "serial", port, baud }`, `{ kind: "tcp", host, port }`, `{ kind: "usb", printer }`; таймауты соединения и записи по 5 с, `spawn_blocking`; `not_sent` до первой записи (разрешение адреса, `connect_timeout`, открытие порта, `OpenPrinterW`, `StartDocPrinterW`), `outcome_unknown` после (`write_all`, `flush`, `StartPagePrinter`, `WritePrinter`, короткая запись, `EndPagePrinter`, `EndDocPrinter`); плюс `invalid_target`, `unsupported` (USB вне Windows). `list_usb_printers()` — Windows: `EnumPrintersW`, уровень 2, `LOCAL | CONNECTIONS`; иначе `[]`.
- Сканеры: `list_serial_ports`, `configure_scanners([{ port, baud }])` (вся желаемая конфигурация сразу, порт в верхнем регистре, повтор порта и нулевая скорость отвергаются), `get_scanner_connections`, `close_scanners`; поток на порт, переподключение через 2 с, кадр — до CR/LF, буфер не больше 4096 байт, декодирование UTF-8 с заменой; события `standalone://scan` (строка) и `standalone://scanner-status` (`{ revision, scanners: [{ port, baud, status }] }`). Байт `0x1D` сохраняется.
- `set_system_awake(awake)` с одной арендой `PowerCreateRequest` / `PowerSetRequest` (`DisplayRequired`, `SystemRequired`); вне Windows ничего не делает.
- `host_request` получает необязательный `timeoutMs` (100–10 000; без него — 10 с, как сейчас); истёкший — транспортный код `timeout` (новый в `TRANSPORT_CODES`, `src/host/client.ts`).
- `DeviceStatus` и `device.json` получают `deviceName` (строка или `null` для файла старой версии); `device_refresh` сохраняет имя из `GET /v1/device`, как линию.
- `LocalDb::clear_copies` удаляет строки только таблиц класса «одноразовые»; класс «данные устройства» и класс «настройки рабочего места» (`workstation_settings`) не трогает; список классов — в Rust; тест `tests/local_db.rs` читает `pragma_table_list` и падает на таблице без класса.
- `device_forget` при неотправленных записях очереди текущего подключения отвечает `unsent_facts` и ничего не стирает; `remove_unopened` не удаляет файл, а переименовывает его вместе с `-wal` и `-shm` в `standalone-station.db.unreadable-<unix ms>` и открывает новую базу.
- Шаг владельца: `serialport = "=4.9.0"`, `base64` — для всех ОС, признаки `windows-sys` (см. выше); `Cargo.lock` обновляется с сетью; CI: `libudev-dev` в шаге `Install Linux webkit deps` задания `standalone-rust`.

**Код и процесс**

- Rust: голые коды отказов через `code()`, без `unwrap` в коде команд; `cargo fmt` чистый; сборка без предупреждений. TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках; именованные экспорты, `import type`; члены интерфейсов, которые передаются несвязанными, — свойства-функции.
- Тесты, которые ждут поток, сокет или событие, ограничены сроком и падают, а не висят: отправка печати — на своём потоке с `recv_timeout(10 с)`, запросы к молчащему хосту — под `tokio::time::timeout`, ожидание сканера — опрос с пределом 3 с.
- Свойство «не запереть»: отпустить сон (`set_system_awake(false)`) удаётся всегда, в том числе после отравленного мьютекса; `close_scanners` всегда закрывает все порты; «забывание» с `keepUnsent: true` всегда проходит, если хранилище в порядке.
- `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto`, `package.json` и `pnpm-lock.yaml` не меняются; `Cargo.lock` и `.github/workflows/ci.yml` меняет только задача 1.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- Задачи упорядочены так, чтобы без шага владельца исполнялись 2–6: питание (задача 6) на macOS не требует ни одного нового крейта, а печать и сканеры (7–8) требуют `base64` и `serialport` на всех ОС. Если владелец ещё не сделал задачу 1, исполнитель останавливается после задачи 6 и называет это в отчёте.
- `timeout` — только когда `timeoutMs` задан; без него зависший запрос, как и раньше, кончается `unreachable` по собственным пределам клиента (2 с на соединение вместе с рукопожатием TLS, 10 с на запрос): экраны этапа 1 читают `unreachable`.
- Имя устройства при подключении — имя, под которым оно подключалось, без пробелов по краям (так его хранит хост, `validate::device_name`); ответ хоста при `device_refresh` и `device_select_line` его обновляет. Переименование в офисе ревизии не берёт и доходит со следующей ревизией или переподключением.
- Новые коды сверх решения 20: `invalid_payload` (не base64 или пусто), `spooler_unavailable` (`list_usb_printers`, когда спулер не ответил — не пустой список), `invalid_scanners` (любая неверная конфигурация сканеров одним кодом: форма, пустое имя, NUL, скорость 0, повтор), `serial_unavailable` (`list_serial_ports`), `power_request_failed`. `print_bytes` и `configure_scanners` принимают аргумент как JSON и сами отвечают своим кодом на неверную форму, а не текстом Tauri.
- `printBytes` вебвью не бросает: `{ sent: true }` или `{ sent: false, code }`; неизвестный ответ и сбой IPC — `outcome_unknown` (так нельзя напечатать дубль).
- Классы таблиц — явный список имён; `clear_copies` удаляет только названные одноразовые таблицы и больше не читает `pragma_table_list` (таблицу новой миграции стирает только решение её плана). `PRAGMA defer_foreign_keys` убран: внешних ключей нет, а ключ между таблицами разных классов уронил бы «забывание» — правило записано в документ. Тест виртуальной таблицы FTS5 убран: обход теневых таблиц больше невозможен по построению.
- Подсчёт неотправленного — в той же транзакции `BEGIN IMMEDIATE`, что и очистка; при нечитаемом `device.json` считаются записи любого подключения, без подключения — никакие.
- Перенос нечитаемой базы захватывает и `-journal`; файл, который не удалось перенести, возвращает на место уже перенесённые (база не теряет WAL наполовину), новая база открывается сразу (`OnceLock`), без перезапуска.
- Оболочка пишет в stderr процесса имя команды, код и текст системы при сбое оборудования и число записей при отказе «забывания»; в сборке для Windows консоли нет — это журнал для разработки и поддержки.
- `set_system_awake(false)` проходит и после отравленного мьютекса (облако в этом случае отвечало ошибкой и держало экран включённым).
- COM-принтер заглушкой не проверяется: macOS не даёт настроек последовательного порта на псевдотерминале (`ENOTTY`, проверено) — ручной список.
- `src/hardware/hardware.ts` держит свои схемы Zod (ответы оболочки, не протокол хоста), как `src/app/lockdown.ts`.

## Контракт для 2a5–2a7

Команды оболочки (аргументы — как их шлёт вебвью, camelCase; ответ при успехе; отказ — голая строка):

| Команда                                                                                  | Аргументы                                             | Успех                                                    | Отказы                                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `host_request`                                                                           | `method`, `path`, `body`, `officeToken`, `timeoutMs?` | `{ status, body }`                                       | прежние + `timeout` (только при `timeoutMs`); `timeoutMs` вне 100–10 000 — `invalid_request` |
| `device_status`, `device_refresh`, `device_select_line`, `host_local_pair`, `host_claim` | как прежде                                            | `DeviceStatus` с `deviceName: string \| null`            | как прежде                                                                                   |
| `device_forget`                                                                          | `keepUnsent?: boolean`                                | `null`                                                   | `unsent_facts`, `storage`                                                                    |
| `print_bytes`                                                                            | `target` (`PrintTarget`), `payloadBase64`             | `null`                                                   | `not_sent`, `outcome_unknown`, `invalid_target`, `invalid_payload`, `unsupported`            |
| `list_usb_printers`                                                                      | —                                                     | `[{ name, port }]` (USB-порты первыми; вне Windows `[]`) | `spooler_unavailable`                                                                        |
| `list_serial_ports`                                                                      | —                                                     | `string[]`                                               | `serial_unavailable`                                                                         |
| `configure_scanners`                                                                     | `scanners: [{ port, baud }]`                          | `null`                                                   | `invalid_scanners`                                                                           |
| `get_scanner_connections`                                                                | —                                                     | `{ revision, scanners: [{ port, baud, status }] }`       | —                                                                                            |
| `close_scanners`                                                                         | —                                                     | `null`                                                   | —                                                                                            |
| `set_system_awake`                                                                       | `awake: boolean`                                      | `null`                                                   | `power_request_failed` (только `true`)                                                       |

События: `standalone://scan` — строка скана как есть (GS `\u001d` и префиксы AIM `]d2`, `]C1` сохранены); `standalone://scanner-status` — тот же снимок, что у `get_scanner_connections`, `revision` растёт с каждым изменением (подписаться, затем спросить, взять более новый).

Вебвью: `createTauriHardware(): HardwareApi` (`src/hardware/hardware.ts`) — `printBytes(target, bytes: Uint8Array): Promise<PrintResult>` (не бросает), `listUsbPrinters`, `listSerialPorts`, `configureScanners(scanners)`, `closeScanners`, `watchScanners(onSnapshot): Promise<stop>`, `onScan(listener): Promise<stop>`, `setSystemAwake(awake)`; ошибки — `HardwareError` с `code` из `HARDWARE_ERROR_CODES`. `HostRequestOptions.timeoutMs?: number` (`src/host/client.ts`), `TRANSPORT_CODES` с `timeout`; `DeviceApi.forget(options?: { keepUnsent?: boolean })`, `DEVICE_ERROR_CODES` с `unsent_facts` (`src/host/device.ts`); `DeviceStatus.deviceName: string | null`.

Локальная база: план, который добавляет таблицу, добавляет её в `TABLE_CLASSES` (`src-tauri/src/local_db.rs`) в той же правке — `floor_*` и `outbox` (2a5) как `TableClass::DeviceData`, `workstation_settings` (2a7) как `TableClass::Workstation`. Таблица `outbox` несёт столбцы `host_id`, `device_id`, `acked_at` (неотправленная — `acked_at IS NULL`); строки данных устройства несут `host_id` и `device_id` своего подключения; внешних ключей между таблицами разных классов нет. План 2a5 заменяет в `tests/local_db.rs` и `tests/ipc.rs` временную `outbox` (константа `OUTBOX`, только три столбца и `id`) своей таблицей из миграции.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на свою очередь он встречается в файле ровно один раз (фрагменты построены и проверены сценарием: применены по порядку к копии репозитория на `366e87f06`, результат совпал с кодом плана). Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше реализации.
- «Создать» — новый файл, ровно как в блоке. «Скопировать» — `cp` облачного файла; его SHA-256 на момент плана: `apps/station/src-tauri/src/scanner/runtime.rs` — `b620b1fd52d7ee9105eeffc5553645241ec4dec988ec9fdeef9c336619ff8923`, `runtime_tests.rs` — `fdd8bbd1b1206129de943ea93b0f54c92713bd53307ad4840923a07d6b967b2d`; другой хеш значит, что облачный файл менялся, и фрагменты задачи 8 надо сверить.
- Между планом и исполнением могли пройти планы 2a2 и 2a3 (они правят `src/i18n/ru.json`, `src/host/protocol.ts`, `apps/standalone/AGENTS.md` и спецификацию этапа). Фрагмент, который из-за них не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении». Если §16 спецификации уже занят, раздел задачи 9 получает следующий номер.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 пишется `\u001d` (в Rust — `\x1d` или `\u{1d}`).

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутация задачи 4 с временной миграцией убирается `rm`, а `git status --short` после неё пуст.

**Перед каждым коммитом**

- Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; TS, JSON, MD — `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`, затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `apps/standalone/dist`).
- Cargo — с `--offline --locked` (`--locked` доказывает, что `Cargo.lock` не меняется вне задачи 1). Наборы, которые слушают сокет на loopback или открывают псевдотерминал, в песочнице падают на `bind`: хост — `changes_stream`, `hello`, `no_secrets_in_logs`, `platform`; оболочка — `claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `host_request_timeout` (новый), `ipc`, `line`, `printer` (новый). В песочнице проходят библиотека оболочки, `local_db` и `lockdown`. Полный `cargo test --workspace` — вне песочницы.
- Крейт-пробник для Windows (задачи 6 и 7) собирается `cargo check --offline --target x86_64-pc-windows-msvc`; ему нужна установленная цель (`rustup target list --installed` показывает `x86_64-pc-windows-msvc`) и распаковка крейтов из локального кэша в `~/.cargo/registry/src`, поэтому команда идёт вне песочницы. Без цели шаг пропускается и называется в отчёте непроверенным.
- Новые TS-тесты не рендерят React: стенд с задержкой `setImmediate` им не нужен; один запуск с `--reporter=verbose` — без `stderr |`.

**Счёт тестов** (измерено на копии репозитория на `366e87f06` с кодом плана; если раньше исполнены 2a2 или 2a3, итоги хоста и Vitest больше на их тесты, а числа оболочки — те же)

- До плана: Vitest — 67 файлов, 1744 теста; cargo — 43 набора, 519 тестов (хост 359, `proto` 45, оболочка 115: библиотека 47, `claim` 4, `connection` 6, `device` 13, `host_probe` 2, `host_probe_proxy` 1, `ipc` 12, `line` 14, `local_db` 12, `lockdown` 4).
- По задачам (оболочка): 2 — библиотека 48, `host_request_timeout` 3, `ipc` 13; 3 — библиотека 49, `line` 15; 4 — `local_db` 12, `ipc` 13; 5 — `local_db` 16, `ipc` 15; 6 — библиотека 52, `ipc` 16; 7 — библиотека 60, `printer` 4, `ipc` 17; 8 — библиотека 76, `ipc` 18. Vitest: 2 — 1746; 3 — 1749; 5 — 1752; 9 — 68 файлов, 1776.
- После: Vitest — 68 файлов, 1776 тестов; cargo — 45 наборов, 566 тестов (оболочка 162).

## Файлы

Задачи выполняются по порядку; задача 1 — шаг владельца. Без неё исполняются задачи 2–6; задачи 7–9 ждут её (7 и 8 не компилируются без `base64` и `serialport`, документы задачи 9 описывают сделанный шаг).

<!-- prettier-ignore -->
```text
apps/standalone/src-tauri/Cargo.toml, apps/standalone/Cargo.lock,
.github/workflows/ci.yml (владелец)                                задача 1
apps/standalone/src-tauri/src/{host_client,device}.rs              задачи 2, 3
apps/standalone/src-tauri/src/lib.rs                               задачи 2, 3, 5–8
apps/standalone/src-tauri/tests/host_request_timeout.rs (новый)    задача 2
apps/standalone/src-tauri/tests/ipc.rs                             задачи 2–8
apps/standalone/src/host/client.ts, test/client.test.ts            задача 2
apps/standalone/src/i18n/ru.json                                   задачи 2, 5
apps/standalone/src-tauri/src/device_config.rs                     задача 3
apps/standalone/src-tauri/tests/line.rs                            задача 3
apps/standalone/src/host/protocol.ts, test/support/fixtures.ts     задача 3
apps/standalone/test/device.test.ts                                задачи 3, 5
apps/standalone/src-tauri/src/local_db.rs                          задачи 4, 5
apps/standalone/src-tauri/tests/local_db.rs                        задачи 4, 5
apps/standalone/src/host/device.ts                                 задача 5
apps/standalone/src-tauri/src/power.rs, power/windows.rs (новые)   задача 6
apps/standalone/src-tauri/src/printer.rs, printer/spooler.rs (новые),
apps/standalone/src-tauri/tests/printer.rs (новый)                 задача 7
apps/standalone/src-tauri/src/scanner.rs, scanner/runtime.rs,
scanner/runtime_tests.rs (новые)                                   задача 8
apps/standalone/src/hardware/hardware.ts, test/hardware.test.ts    задача 9
apps/standalone/AGENTS.md, спецификация этапа §16                  задача 9
```

---

### Task 1: Шаг владельца — зависимости, признаки `windows-sys` и CI

**Files:**

- Modify (владелец): `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/Cargo.lock` (командой Cargo с сетью), `.github/workflows/ci.yml`

**Interfaces:**

- Produces: крейты `base64` (все ОС) и `serialport` для задач 7–8; признаки `windows_sys::Win32::Graphics::{Gdi, Printing}`, `Win32::Security`, `Win32::System::{Power, Threading}`, `Win32::UI::WindowsAndMessaging` для кода под `cfg(windows)` задач 6–7 и `lockdown.rs` плана 1f2; `libudev-dev` для сборки `serialport` на Linux в CI.

Шаг владельца закрывает и задачу 1 плана 1f2: без `Win32_Graphics_Gdi` и `Win32_UI_WindowsAndMessaging` задание `standalone-windows-build` не компилирует `lockdown.rs` уже сейчас. `Win32_Security` приходит и с `Win32_Security_Cryptography` (зависимость признаков `windows-sys`), но записан явно, как в облачном манифесте; без `Win32_Graphics_Gdi` спулер не компилируется (проверено крейтом-пробником: `unresolved imports … OpenPrinterW, … PRINTER_INFO_2W`), без `Win32_System_Threading` — запрос питания (`unresolved imports … PowerCreateRequest, … Threading`). Исполнитель манифест сам не правит.

- [ ] **Step 1: Владелец правит манифест и CI**

Правка `apps/standalone/src-tauri/Cargo.toml`:

Фрагмент 1:

<!-- prettier-ignore -->
```toml

[dependencies]
markiro-proto = { path = "../proto" }
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
```

заменить на:

<!-- prettier-ignore -->
```toml

[dependencies]
base64 = "=0.22.1"
markiro-proto = { path = "../proto" }
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
```

Фрагмент 2:

<!-- prettier-ignore -->
```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite", "migrate", "macros"] }
tauri = { version = "2.11", features = [] }
```

заменить на:

<!-- prettier-ignore -->
```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serialport = "=4.9.0"
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite", "migrate", "macros"] }
tauri = { version = "2.11", features = [] }
```

Фрагмент 3:

<!-- prettier-ignore -->
```toml

[target.'cfg(windows)'.dependencies]
base64 = "=0.22.1"
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }

[dev-dependencies]
```

заменить на:

<!-- prettier-ignore -->
```toml

[target.'cfg(windows)'.dependencies]
# Win32_Graphics_Gdi and Win32_UI_WindowsAndMessaging: kiosk mode (lockdown.rs).
# Win32_Graphics_Printing with Win32_Graphics_Gdi and Win32_Security: the
# spooler (printer/spooler.rs; PRINTER_INFO_2W needs all three, and
# Win32_Security_Cryptography would bring Win32_Security in anyway).
# Win32_System_Power with Win32_System_Threading: set_system_awake
# (power/windows.rs; PowerCreateRequest takes a REASON_CONTEXT).
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_Graphics_Printing",
  "Win32_Security",
  "Win32_Security_Cryptography",
  "Win32_System_Power",
  "Win32_System_Threading",
  "Win32_UI_WindowsAndMessaging",
] }

[dev-dependencies]
```

Правка `.github/workflows/ci.yml`:

Фрагмент 1:

<!-- prettier-ignore -->
```yaml
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - name: Install Linux webkit deps
        env:
          DEBIAN_FRONTEND: noninteractive
        run: |
          sudo apt-get -o Acquire::Retries=3 update
          sudo apt-get -o Acquire::Retries=3 install --no-install-recommends -y \
```

заменить на:

<!-- prettier-ignore -->
```yaml
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - name: Install Linux webkit and serial deps
        # libudev is required by the `serialport` crate on Linux only (the
        # shell's COM scanners and printers, plan 2a4), as in station-rust.
        env:
          DEBIAN_FRONTEND: noninteractive
        run: |
          sudo apt-get -o Acquire::Retries=3 update
          sudo apt-get -o Acquire::Retries=3 install --no-install-recommends -y \
```

Фрагмент 2:

<!-- prettier-ignore -->
```yaml
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
        with:
```

заменить на:

<!-- prettier-ignore -->
```yaml
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev \
            libudev-dev
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
        with:
```

- [ ] **Step 2: Владелец обновляет `Cargo.lock` (нужна сеть к crates.io)**

Run: `cargo metadata --manifest-path apps/standalone/Cargo.toml --format-version 1 > /dev/null`
Expected: без ошибок; Cargo дописывает в `Cargo.lock` недостающие пакеты и не трогает остальные (не `cargo update` и не `cargo generate-lockfile`: те поднимут версии других крейтов).

Run: `git diff --stat apps/standalone/Cargo.lock`
Expected: `1 file changed, 79 insertions(+)` — ровно этот дифф (получен на копии репозитория с доступом к `crates.io`, `index.crates.io`, `static.crates.io`):

<!-- prettier-ignore -->
```diff
diff --git a/apps/standalone/Cargo.lock b/apps/standalone/Cargo.lock
index 773cdd222..fc1b454f5 100644
--- a/apps/standalone/Cargo.lock
+++ b/apps/standalone/Cargo.lock
@@ -2125,6 +2125,16 @@ dependencies = [
  "cfb",
 ]

+[[package]]
+name = "io-kit-sys"
+version = "0.4.1"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "617ee6cf8e3f66f3b4ea67a4058564628cde41901316e19f559e14c7c72c5e7b"
+dependencies = [
+ "core-foundation-sys",
+ "mach2",
+]
+
 [[package]]
 name = "ipnet"
 version = "2.12.2"
@@ -2429,6 +2439,26 @@ dependencies = [
  "vcpkg",
 ]

+[[package]]
+name = "libudev"
+version = "0.3.0"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "78b324152da65df7bb95acfcaab55e3097ceaab02fb19b228a9eb74d55f135e0"
+dependencies = [
+ "libc",
+ "libudev-sys",
+]
+
+[[package]]
+name = "libudev-sys"
+version = "0.1.4"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "3c8469b4a23b962c1396b9b451dda50ef5b283e8dd309d69033475fa9b334324"
+dependencies = [
+ "libc",
+ "pkg-config",
+]
+
 [[package]]
 name = "linux-raw-sys"
 version = "0.12.1"
@@ -2462,6 +2492,15 @@ version = "0.1.3"
 source = "registry+https://github.com/rust-lang/crates.io-index"
 checksum = "4050469837a6ff301cd14c1f8f24f88549e6d548f24f64e2148eb0f72cebc51f"

+[[package]]
+name = "mach2"
+version = "0.4.3"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "d640282b302c0bb0a2a8e0233ead9035e3bed871f0b7e81fe4a1ec829765db44"
+dependencies = [
+ "libc",
+]
+
 [[package]]
 name = "markiro-host"
 version = "0.1.0"
@@ -2512,6 +2551,7 @@ dependencies = [
  "rustls",
  "serde",
  "serde_json",
+ "serialport",
  "sqlx",
  "tauri",
  "tauri-build",
@@ -2658,6 +2698,17 @@ version = "1.0.6"
 source = "registry+https://github.com/rust-lang/crates.io-index"
 checksum = "650eef8c711430f1a879fdd01d4745a7deea475becfb90269c06775983bbf086"

+[[package]]
+name = "nix"
+version = "0.26.4"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "598beaf3cc6fdd9a5dfb1630c2800c7acd31df7aaf0f565796fba2b53ca1af1b"
+dependencies = [
+ "bitflags 1.3.2",
+ "cfg-if",
+ "libc",
+]
+
 [[package]]
 name = "nom"
 version = "7.1.3"
@@ -4062,6 +4113,25 @@ dependencies = [
  "syn 2.0.119",
 ]

+[[package]]
+name = "serialport"
+version = "4.9.0"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "a4d91116f97173694f1642263b2ff837f80d933aa837e2314969f6728f661df3"
+dependencies = [
+ "bitflags 2.13.2",
+ "cfg-if",
+ "core-foundation",
+ "core-foundation-sys",
+ "io-kit-sys",
+ "libudev",
+ "mach2",
+ "nix",
+ "scopeguard",
+ "unescaper",
+ "windows-sys 0.52.0",
+]
+
 [[package]]
 name = "servo_arc"
 version = "0.4.3"
@@ -5331,6 +5401,15 @@ dependencies = [
  "windows-sys 0.61.2",
 ]

+[[package]]
+name = "unescaper"
+version = "0.1.10"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "7285e83a80ce76f5e7bce79fa41f68d78ba62d1003cf27bf748ab24413808cf4"
+dependencies = [
+ "thiserror 2.0.21",
+]
+
 [[package]]
 name = "unic-char-property"
 version = "0.9.0"
```

У пустых строк контекста в блоке нет ведущего пробела (иначе `git diff --check` отверг бы сам план); `git apply` принимает дифф и в таком виде и даёт тот же `Cargo.lock` — так его можно сверить на чистой копии. `base64 0.22.1` и `windows-sys 0.52.0` (зависимость `serialport` для Windows) в файле уже есть, поэтому новых пакетов семь: `io-kit-sys 0.4.1`, `libudev 0.3.0`, `libudev-sys 0.1.4`, `mach2 0.4.3`, `nix 0.26.4`, `serialport 4.9.0`, `unescaper 0.1.10`. Другие строки, особенно смена версий уже записанных пакетов, значат, что Cargo разрешал зависимости без сети (`--offline` выбирает то, что лежит в кэше) — откатить `Cargo.lock` и повторить с сетью.

- [ ] **Step 3: Проверить сборку и политику CI**

Run: `cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: `Finished`; `--locked` не жалуется на устаревший `Cargo.lock`.

Run (вне песочницы: тесты политики CI запускают `git`): `pnpm test:ci-policy`
Expected: `pass 47`, `fail 0`.

На macOS код под `cfg(windows)` не компилируется, поэтому эта сборка признаков не проверяет; их проверяет задание `standalone-windows-build`, а до него — крейты-пробники задач 6 и 7.

- [ ] **Step 4: Commit**

```bash
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/Cargo.lock .github/workflows/ci.yml
git commit -m "build(standalone): serialport, base64 and windows-sys features for printing, scanners and power (owner step)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Тайм-аут запроса к хосту — `timeoutMs` и код `timeout`

**Files:**

- Create: `apps/standalone/src-tauri/tests/host_request_timeout.rs`
- Modify: `apps/standalone/src-tauri/src/host_client.rs`, `src/device.rs`, `src/lib.rs`, `tests/ipc.rs`; `apps/standalone/src/host/client.ts`, `src/i18n/ru.json`, `test/client.test.ts`

**Interfaces:**

- Consumes: ничего из других задач.
- Produces: `RequestError::Timeout` (код `"timeout"`); `PinnedClient::send_within(&self, method: &str, path: &str, body: Option<&Value>, credentials: Credentials<'_>, limit: Option<Duration>) -> Result<HostResponse, RequestError>`; `device::{MIN_TIMEOUT_MS, MAX_TIMEOUT_MS}: u64` (100 и 10 000); `device::request_limit(Option<u64>) -> Result<Option<Duration>, DeviceError>`; `DeviceState::request_within(&self, method, path, body, office_token, timeout_ms: Option<u64>)`; команда `host_request` с аргументом `timeoutMs`. Вебвью: `HostRequestOptions.timeoutMs?: number`, `"timeout"` в `TRANSPORT_CODES`, текст `errors.transport.timeout`.

`send` и `request` остаются и вызывают новые методы без предела, поэтому прежние вызовы и тесты не меняются. Молчащий хост в тестах — `TcpListener` на loopback, который принимает соединение и не отвечает даже на рукопожатие TLS; поток держит соединения до конца тестового бинарника.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/src-tauri/tests/host_request_timeout.rs`:

<!-- prettier-ignore -->
```rust
//! `host_request`'s `timeoutMs` (stage 2a spec §5.2) against hosts that
//! never answer: a request past its own limit fails with `timeout`, one
//! without a limit still ends at the client's own limits as `unreachable`,
//! and a limit outside 100–10 000 ms is refused before any I/O. Every
//! listener here is on 127.0.0.1, so the suite runs outside the agents'
//! sandbox.

use std::path::Path;
use std::time::{Duration, Instant};

use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config;
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::secret_store;
use serde_json::json;

/// A local address that accepts connections and then never says a word, not
/// even its half of the TLS handshake: a host that hangs. The thread holds
/// every connection it accepts until the test binary exits.
fn silent_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let _held: Vec<_> = listener.incoming().collect();
    });
    format!("https://127.0.0.1:{port}")
}

/// A local address where nothing listens.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// A pairing on disk with the host at `address`, written as JSON so the
/// test does not depend on every field of `DeviceConfig`; no host issued
/// its key, and none needs to: the requests here never get an answer.
fn paired_with(dir: &Path, address: &str) -> DeviceState {
    let config = json!({
        "hostAddress": address,
        "fingerprint": "ab".repeat(32),
        "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "kind": "station",
        "lineId": null,
        "deviceKey": secret_store::protect("device-key-value").unwrap(),
    });
    std::fs::write(
        device_config::path(dir),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf())
}

#[tokio::test]
async fn a_request_past_its_own_limit_fails_with_timeout() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &silent_address());

    let started = Instant::now();
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        station.request_within("GET", "/v1/device/shifts", None, None, Some(300)),
    )
    .await
    .expect("the request ends at its own limit, long before the test's");
    let elapsed = started.elapsed();

    assert_eq!(answer, Err(DeviceError::Request(RequestError::Timeout)));
    // Well before the client's own 2 s to connect (the silent host never
    // finishes the TLS handshake), so it was this request's limit that ended it.
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_millis(1500),
        "{elapsed:?}"
    );
}

/// Without `timeoutMs` nothing changes: the client's own limits still end a
/// hung request (here its 2 s to connect, which covers the TLS handshake the
/// silent host never finishes), and it still reads as `unreachable`, as
/// every screen of stage 1 expects.
#[tokio::test]
async fn a_request_without_a_limit_still_ends_as_unreachable() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &silent_address());

    let answer = tokio::time::timeout(
        Duration::from_secs(20),
        station.request_within("GET", "/v1/device", None, None, None),
    )
    .await
    .expect("the client's own limits end the request");

    assert_eq!(answer, Err(DeviceError::Request(RequestError::Unreachable)));
}

#[tokio::test]
async fn a_limit_outside_its_bounds_is_refused_before_any_io() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &closed_address());

    for ms in [0, 99, 10_001] {
        assert_eq!(
            station
                .request_within("GET", "/v1/device", None, None, Some(ms))
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{ms}"
        );
    }
    // Inside the bounds the request does go out, and finds the port closed:
    // the refusals above came before any connection.
    assert_eq!(
        station
            .request_within("GET", "/v1/device", None, None, Some(100))
            .await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
/// A pairing on disk that the app can read, for tests that need no host.
fn save_pairing(dir: &std::path::Path) {
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
```

заменить на:

<!-- prettier-ignore -->
```rust
/// A pairing on disk that the app can read, for tests that need no host.
fn save_pairing(dir: &std::path::Path) {
    save_pairing_at(dir, "https://127.0.0.1:45710");
}

/// A pairing on disk with the host at `address`; no host issued its key.
fn save_pairing_at(dir: &std::path::Path, address: &str) {
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: address.into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    )
    .unwrap();
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    )
    .unwrap();
}

/// A local address that accepts connections and never answers, not even the
/// TLS handshake; the thread holds them until the test binary exits.
fn silent_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let _held: Vec<_> = listener.incoming().collect();
    });
    format!("https://127.0.0.1:{port}")
}

/// `timeoutMs` reaches the shell as milliseconds (`src/host/client.ts`): a
/// host that never answers ends the call with `timeout` once the limit
/// passes, and a limit outside 100–10 000 is `invalid_request` before any
/// connection. Without the limit the same call would wait the client's 10 s.
#[test]
fn host_request_takes_a_limit_in_milliseconds() {
    let app_dir = tempfile::tempdir().unwrap();
    save_pairing_at(app_dir.path(), &silent_address());
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));
    let within = |ms: Value| {
        json!({
            "method": "GET",
            "path": "/v1/device/shifts",
            "body": null,
            "officeToken": null,
            "timeoutMs": ms
        })
    };

    assert_eq!(
        invoke(&webview, "host_request", within(json!(300))),
        Err(json!("timeout"))
    );
    assert_eq!(
        invoke(&webview, "host_request", within(json!(50))),
        Err(json!("invalid_request"))
    );
}

```

Правка `apps/standalone/test/client.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
      officeToken: null,
    });
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
      officeToken: null,
    });
  });

  it("passes a time limit in milliseconds only when one is asked for", async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: { value: 1 } });
    await createTauriHostClient(call).request("GET", "/v1/device/codes/ab", {
      timeoutMs: 300,
      schema: valueSchema,
    });
    expect(call).toHaveBeenCalledWith("host_request", {
      method: "GET",
      path: "/v1/device/codes/ab",
      body: null,
      officeToken: null,
      timeoutMs: 300,
    });

    call.mockClear();
    await createTauriHostClient(call).request("GET", "/v1/device", { schema: valueSchema });
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
  });

```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_request_timeout --test ipc --no-run`
Expected: FAIL компиляции `host_request_timeout`; среди ошибок — `error[E0599]: no method named 'request_within' found for struct 'DeviceState'` (4 раза) и `error[E0599]: no variant or associated item named 'Timeout' found for enum 'RequestError'`. `ipc` компилируется (его новый тест шлёт только JSON) и упал бы при запуске: без предела ответ — `unreachable`, а не `timeout`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/client.test.ts`
Expected: FAIL — 1 тест: «passes a time limit in milliseconds only when one is asked for».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/host_client.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    /// address is not HTTPS.
    InvalidRequest,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    /// address is not HTTPS.
    InvalidRequest,
    /// The host did not answer within the limit the caller set
    /// ([`PinnedClient::send_within`]); without one, a request that runs
    /// past the client's 10 s stays [`RequestError::Unreachable`].
    Timeout,
}

```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
            RequestError::InvalidResponse => "invalid_response",
            RequestError::InvalidRequest => "invalid_request",
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
            RequestError::InvalidResponse => "invalid_response",
            RequestError::InvalidRequest => "invalid_request",
            RequestError::Timeout => "timeout",
        }
    }
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        credentials: Credentials<'_>,
    ) -> Result<HostResponse, RequestError> {
        let method = allowed_method(method)?;
        validate_path(path)?;
```

заменить на:

<!-- prettier-ignore -->
```rust
        credentials: Credentials<'_>,
    ) -> Result<HostResponse, RequestError> {
        self.send_within(method, path, body, credentials, None)
            .await
    }

    /// [`Self::send`], limited to `limit` from connecting to the end of the
    /// body instead of the client's 10 s. A request that runs past `limit`
    /// is [`RequestError::Timeout`], so a caller that asked for a short
    /// answer (the station's 300 ms code check) can tell "too slow" from
    /// "unreachable".
    pub async fn send_within(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        credentials: Credentials<'_>,
        limit: Option<Duration>,
    ) -> Result<HostResponse, RequestError> {
        let method = allowed_method(method)?;
        validate_path(path)?;
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            .request(method, format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key.expose());
```

заменить на:

<!-- prettier-ignore -->
```rust
            .request(method, format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(limit) = limit {
            request = request.timeout(limit);
        }
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key.expose());
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(response) => response,
```

заменить на:

<!-- prettier-ignore -->
```rust
            request = request.json(body);
        }
        let lost = |error: reqwest::Error| {
            if limit.is_some() && error.is_timeout() {
                RequestError::Timeout
            } else {
                RequestError::Unreachable
            }
        };
        let response = match request.send().await {
            Ok(response) => response,
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        let body = if bytes.is_empty() {
            None
```

заменить на:

<!-- prettier-ignore -->
```rust
                return Err(RequestError::CertificateMismatch)
            }
            Err(error) => return Err(lost(error)),
        };
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(lost)?;
        let body = if bytes.is_empty() {
            None
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use markiro_proto::{
```

заменить на:

<!-- prettier-ignore -->
```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::{
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
/// reads for the line the office assigned.
const DEVICE_ROUTE: &str = "/v1/device";

/// What the webview may know about the pairing.
```

заменить на:

<!-- prettier-ignore -->
```rust
/// reads for the line the office assigned.
const DEVICE_ROUTE: &str = "/v1/device";

/// The bounds of `host_request`'s `timeoutMs` (stage 2a spec §5.2). A caller
/// may ask for a shorter answer than the client's 10 s (the scan pipeline's
/// 300 ms code check), never for a longer one.
pub const MIN_TIMEOUT_MS: u64 = 100;
pub const MAX_TIMEOUT_MS: u64 = 10_000;

/// The limit a `timeoutMs` asks for: none without one, the duration inside
/// the bounds, [`RequestError::InvalidRequest`] outside them.
pub fn request_limit(timeout_ms: Option<u64>) -> Result<Option<Duration>, DeviceError> {
    match timeout_ms {
        None => Ok(None),
        Some(ms) if (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&ms) => {
            Ok(Some(Duration::from_millis(ms)))
        }
        Some(_) => Err(DeviceError::Request(RequestError::InvalidRequest)),
    }
}

/// What the webview may know about the pairing.
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        office_token: Option<&str>,
    ) -> Result<HostResponse, DeviceError> {
        if !webview_may_reach(path) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        let device = self.paired()?;
        device
            .client
            .send(
                method,
                path,
```

заменить на:

<!-- prettier-ignore -->
```rust
        office_token: Option<&str>,
    ) -> Result<HostResponse, DeviceError> {
        self.request_within(method, path, body, office_token, None)
            .await
    }

    /// [`Self::request`] with `host_request`'s `timeoutMs`: a limit outside
    /// [`MIN_TIMEOUT_MS`]..=[`MAX_TIMEOUT_MS`] is refused before any I/O,
    /// like a route the webview may not reach, and a request that runs past
    /// the limit fails with [`RequestError::Timeout`].
    pub async fn request_within(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        office_token: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> Result<HostResponse, DeviceError> {
        if !webview_may_reach(path) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        let limit = request_limit(timeout_ms)?;
        let device = self.paired()?;
        device
            .client
            .send_within(
                method,
                path,
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
                    office_token,
                },
            )
            .await
```

заменить на:

<!-- prettier-ignore -->
```rust
                    office_token,
                },
                limit,
            )
            .await
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust

    #[test]
    fn line_and_key_error_codes_are_stable() {
        assert_eq!(DeviceError::LineRejected.code(), "line_rejected");
```

заменить на:

<!-- prettier-ignore -->
```rust

    #[test]
    fn a_timeout_must_lie_between_100_ms_and_10_s() {
        assert_eq!(request_limit(None), Ok(None));
        for ms in [MIN_TIMEOUT_MS, 300, MAX_TIMEOUT_MS] {
            assert_eq!(
                request_limit(Some(ms)),
                Ok(Some(Duration::from_millis(ms))),
                "{ms}"
            );
        }
        for ms in [0, MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, u64::MAX] {
            assert_eq!(
                request_limit(Some(ms)),
                Err(DeviceError::Request(RequestError::InvalidRequest)),
                "{ms}"
            );
        }
        assert_eq!(
            DeviceError::Request(RequestError::Timeout).code(),
            "timeout"
        );
    }

    #[test]
    fn line_and_key_error_codes_are_stable() {
        assert_eq!(DeviceError::LineRejected.code(), "line_rejected");
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
}

#[tauri::command]
async fn host_request(
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// `timeoutMs` (100–10 000) limits this one request instead of the client's
/// 10 s; running past it answers `timeout` (stage 2a spec §5.2).
#[tauri::command]
async fn host_request(
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    body: Option<Value>,
    office_token: Option<String>,
) -> Result<HostResponse, String> {
    state
        .request(&method, &path, body.as_ref(), office_token.as_deref())
        .await
        .map_err(|error| error.code().to_owned())
```

заменить на:

<!-- prettier-ignore -->
```rust
    body: Option<Value>,
    office_token: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HostResponse, String> {
    state
        .request_within(
            &method,
            &path,
            body.as_ref(),
            office_token.as_deref(),
            timeout_ms,
        )
        .await
        .map_err(|error| error.code().to_owned())
```

Правка `apps/standalone/src/host/client.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  "not_paired",
  "config_unreadable",
] as const;
export type TransportCode = (typeof TRANSPORT_CODES)[number];
```

заменить на:

<!-- prettier-ignore -->
```ts
  "not_paired",
  "config_unreadable",
  "timeout",
] as const;
export type TransportCode = (typeof TRANSPORT_CODES)[number];
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  body?: unknown;
  officeToken?: string;
  /** Parses a 2xx body; a 204 answer parses as `null`. */
  schema: z.ZodType<T>;
```

заменить на:

<!-- prettier-ignore -->
```ts
  body?: unknown;
  officeToken?: string;
  /**
   * Limits this request to 100–10 000 ms instead of the shell's 10 s; past
   * it the call fails with the transport code `timeout` (the scan pipeline's
   * 300 ms code check).
   */
  timeoutMs?: number;
  /** Parses a 2xx body; a 204 answer parses as `null`. */
  schema: z.ZodType<T>;
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
export function createTauriHostClient(call: Invoke = invoke): HostClient {
  return {
    async request(method, path, { body, officeToken, schema }) {
      let raw: unknown;
      try {
```

заменить на:

<!-- prettier-ignore -->
```ts
export function createTauriHostClient(call: Invoke = invoke): HostClient {
  return {
    async request(method, path, { body, officeToken, timeoutMs, schema }) {
      let raw: unknown;
      try {
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
          body: body ?? null,
          officeToken: officeToken ?? null,
        });
      } catch (error) {
```

заменить на:

<!-- prettier-ignore -->
```ts
          body: body ?? null,
          officeToken: officeToken ?? null,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      } catch (error) {
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "invalid_request": "Приложение сформировало недопустимый запрос.",
      "not_paired": "Это устройство ещё не подключено к хосту.",
      "config_unreadable": "Настройки подключения к хосту повреждены."
    },
    "unauthorized": {
```

заменить на:

<!-- prettier-ignore -->
```json
      "invalid_request": "Приложение сформировало недопустимый запрос.",
      "not_paired": "Это устройство ещё не подключено к хосту.",
      "config_unreadable": "Настройки подключения к хосту повреждены.",
      "timeout": "Хост не ответил вовремя."
    },
    "unauthorized": {
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: PASS — 48 тестов.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_request_timeout --test ipc`
Expected: PASS — `host_request_timeout` 3 теста (около 2 с: тест без предела ждёт 2 с соединения клиента), `ipc` 13.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/client.test.ts test/errors.test.ts`
Expected: PASS — 2 файла, 20 тестов; нет `stderr |`.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src-tauri/src/host_client.rs`: `if limit.is_some() && error.is_timeout() {` → `if error.is_timeout() {`. Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_request_timeout`. Expected: FAIL — `a_request_without_a_limit_still_ends_as_unreachable`.
2. Там же удалить три строки `if let Some(limit) = limit {` / `request = request.timeout(limit);` / `}`. Та же команда. Expected: FAIL — `a_request_past_its_own_limit_fails_with_timeout` (запрос кончается через 2 с соединения, а не через 300 мс).
3. `apps/standalone/src/host/client.ts`: `...(timeoutMs === undefined ? {} : { timeoutMs }),` → `timeoutMs: timeoutMs ?? null,`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/client.test.ts`. Expected: FAIL — 3 теста (оба прежних теста точных аргументов и «passes a time limit…»).

Каждую — с восстановлением и проверкой хеша (см. «Заметки»).

- [ ] **Step 6: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/src/host/client.ts apps/standalone/test/client.test.ts apps/standalone/src/i18n/ru.json`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/src/host_client.rs apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/host_request_timeout.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/host/client.ts apps/standalone/src/i18n/ru.json apps/standalone/test/client.test.ts
git commit -m "feat(standalone): host_request takes a time limit, and running past it is timeout" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Имя устройства в `DeviceStatus` и `device.json`

**Files:**

- Modify: `apps/standalone/src-tauri/src/device_config.rs`, `src/device.rs`, `src/lib.rs`, `tests/line.rs`, `tests/ipc.rs`; `apps/standalone/src/host/protocol.ts`, `test/support/fixtures.ts`, `test/device.test.ts`

**Interfaces:**

- Consumes: `tests/ipc.rs` после задачи 2 (`save_pairing_at`).
- Produces: `DeviceConfig.device_name: Option<String>` (`deviceName` в JSON; ключа нет в файле плана 1f2 — `None`); `DeviceStatus.device_name: Option<String>` (`deviceName`); `DeviceState::keep_record` вместо `keep_line` (линия и имя из `DeviceInfo`). Вебвью: `deviceStatusSchema.deviceName: string (min 1) | null`, `DEVICE_STATUS.deviceName = "Станция на линии 1"` в фикстурах тестов.

`#[serde(default)]` не нужен: serde читает отсутствующее поле `Option` как `None` и при `deny_unknown_fields` (мутант с ним выжил — проверено). Тест `a_refresh_that_finds_the_same_line_writes_nothing` переименовывается и больше не переименовывает устройство: теперь переименование — изменение, которое записывается; его проверяет новый тест `a_station_takes_the_name_the_office_gives_it`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/line.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
        kind: DeviceKind::Station,
        line_id: None,
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
```

заменить на:

<!-- prettier-ignore -->
```rust
        kind: DeviceKind::Station,
        line_id: None,
        device_name: None,
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn a_refresh_that_finds_the_same_line_writes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// A rename in the office reaches the station with its next refresh (plan
/// 2a4): the floor's status bar names the station, and the name survives a
/// restart without the host.
#[tokio::test]
async fn a_station_takes_the_name_the_office_gives_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    // A rename in the office is no line change for the station.
    let device_id = chosen.device_id.clone();
    let renamed = station
```

заменить на:

<!-- prettier-ignore -->
```rust
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    assert_eq!(chosen.device_name.as_deref(), Some("Рабочее место хоста"));
    let device_id = chosen.device_id.clone();
    let renamed = station
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "name": "Станция упаковки" })),
            Some(&token),
        )
```

заменить на:

<!-- prettier-ignore -->
```rust
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "name": "  Станция упаковки " })),
            Some(&token),
        )
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);
    let config = device_config::path(station_dir.path());
    let before = std::fs::read(&config).unwrap();
```

заменить на:

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);

    let refreshed = station.refresh().await.unwrap();
    assert_eq!(refreshed.device_name.as_deref(), Some("Станция упаковки"));
    assert_eq!(refreshed.line_id, chosen.line_id);
    assert_eq!(station.status(), Ok(Some(refreshed.clone())));
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(refreshed)));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_refresh_that_finds_the_same_line_and_name_writes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, _token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    let config = device_config::path(station_dir.path());
    let before = std::fs::read(&config).unwrap();
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
        kind: DeviceKind::Station,
        line_id: Some(UNKNOWN_LINE.into()),
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
```

заменить на:

<!-- prettier-ignore -->
```rust
        kind: DeviceKind::Station,
        line_id: Some(UNKNOWN_LINE.into()),
        device_name: None,
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
        [
            "deviceId",
            "fingerprint",
            "hostAddress",
```

заменить на:

<!-- prettier-ignore -->
```rust
        [
            "deviceId",
            "deviceName",
            "fingerprint",
            "hostAddress",
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    );
    assert_eq!(device["deviceId"], status.device_id);
    assert_eq!(device["hostAddress"], host.address());

```

заменить на:

<!-- prettier-ignore -->
```rust
    );
    assert_eq!(device["deviceId"], status.device_id);
    assert_eq!(device["deviceName"], NAME);
    assert_eq!(device["hostAddress"], host.address());

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
```

заменить на:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some("Станция на линии 1".into()),
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    assert_eq!(status["kind"], "station");
    assert_eq!(status["lineId"], Value::Null);
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(status));

```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(status["kind"], "station");
    assert_eq!(status["lineId"], Value::Null);
    assert_eq!(status["deviceName"], "Станция на линии 2");
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(status));

```

Правка `apps/standalone/test/support/fixtures.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  kind: "station",
  lineId: LINE_ID,
};

```

заменить на:

<!-- prettier-ignore -->
```ts
  kind: "station",
  lineId: LINE_ID,
  deviceName: "Станция на линии 1",
};

```

Правка `apps/standalone/test/device.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual(DEVICE_STATUS);
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual(DEVICE_STATUS);
  });

  it("accepts a pairing whose device name is not known yet", async () => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, deviceName: null });
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual({
      ...DEVICE_STATUS,
      deviceName: null,
    });
  });

  it.each([
    ["without the device name", { deviceName: undefined }],
    ["with an empty device name", { deviceName: "" }],
  ])("rejects a pairing %s", async (_case, change) => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, ...change });
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("invalid_response");
  });

```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --no-run`
Expected: FAIL компиляции: `error[E0560]: struct 'DeviceConfig' has no field named 'device_name'` (3 раза) и `error[E0609]: no field 'device_name' on type 'DeviceStatus'` (2 раза).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts`
Expected: FAIL — 6 тестов (строгая схема отвергает `deviceName` фикстуры). `typecheck` здесь же даёт `TS2353` в `test/support/fixtures.ts`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/device_config.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    pub kind: DeviceKind,
    pub line_id: Option<String>,
    pub device_key: ProtectedSecret,
}
```

заменить на:

<!-- prettier-ignore -->
```rust
    pub kind: DeviceKind,
    pub line_id: Option<String>,
    /// The name the host keeps for this device (`GET /v1/device`), for the
    /// floor's status bar; `None` in a file written before plan 2a4, which
    /// has no such key (serde reads a missing `Option` as `None`, even under
    /// `deny_unknown_fields`).
    pub device_name: Option<String>,
    pub device_key: ProtectedSecret,
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
```

заменить на:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some("Станция на линии 1".into()),
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    }

    #[test]
    fn a_corrupt_file_is_reported_and_kept() {
```

заменить на:

<!-- prettier-ignore -->
```rust
    }

    /// `device.json` as plan 1f2 wrote it, without `deviceName`: it still
    /// loads, with no name until the next refresh brings the host's.
    #[test]
    fn a_file_from_before_the_device_name_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(sample()).unwrap();
        old.as_object_mut().unwrap().remove("deviceName").unwrap();
        fs::write(path(dir.path()), serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.device_name, None);
        assert_eq!(
            loaded,
            DeviceConfig {
                device_name: None,
                ..sample()
            }
        );
    }

    #[test]
    fn a_corrupt_file_is_reported_and_kept() {
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust

/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned.
const DEVICE_ROUTE: &str = "/v1/device";

```

заменить на:

<!-- prettier-ignore -->
```rust

/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned and the name it gave the device.
const DEVICE_ROUTE: &str = "/v1/device";

```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    pub kind: DeviceKind,
    pub line_id: Option<String>,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    pub kind: DeviceKind,
    pub line_id: Option<String>,
    /// The name the host keeps for this device; `None` until a refresh brings
    /// it to a `device.json` written before plan 2a4.
    pub device_name: Option<String>,
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            kind: self.config.kind,
            line_id: self.config.line_id.clone(),
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
            kind: self.config.kind,
            line_id: self.config.line_id.clone(),
            device_name: self.config.device_name.clone(),
        }
    }
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            return Err(DeviceError::PairRejected);
        }
        self.remember(address, observation, client, response.body)
    }

```

заменить на:

<!-- prettier-ignore -->
```rust
            return Err(DeviceError::PairRejected);
        }
        self.remember(address, observation, client, name, response.body)
    }

```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, response.body)
    }

```

заменить на:

<!-- prettier-ignore -->
```rust
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, name, response.body)
    }

```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_line(&device, response.body)
    }

    /// Read this device's record again (`GET /v1/device`) and keep the line
    /// the host has for it, so a line an administrator set or cleared in the
    /// office reaches the station (plan 1d3). `device.json` is written only
    /// when the line differs. Serialised with pairing, forgetting and
    /// [`Self::select_line`] through the same lock, so an answer never
    /// writes over a pairing or a line choice that changed meanwhile. A host
```

заменить на:

<!-- prettier-ignore -->
```rust
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_record(&device, response.body)
    }

    /// Read this device's record again (`GET /v1/device`) and keep the line
    /// and the name the host has for it, so a line an administrator set or
    /// cleared in the office reaches the station (plan 1d3), and a rename
    /// reaches its status bar (plan 2a4). `device.json` is written only when
    /// the line or the name differs. Serialised with pairing, forgetting and
    /// [`Self::select_line`] through the same lock, so an answer never
    /// writes over a pairing or a line choice that changed meanwhile. A host
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_line(&device, response.body)
    }

    /// Make the line in the host's answer (`DeviceInfo`) this device's line:
    /// `device.json` first, then the pairing in memory, and neither when the
    /// line is already the one kept. Called with the pairing lock held.
    fn keep_line(
        &self,
        device: &PairedDevice,
```

заменить на:

<!-- prettier-ignore -->
```rust
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_record(&device, response.body)
    }

    /// Make the line and the name in the host's answer (`DeviceInfo`) this
    /// device's: `device.json` first, then the pairing in memory, and neither
    /// when both are already the ones kept. Called with the pairing lock held.
    fn keep_record(
        &self,
        device: &PairedDevice,
```

Фрагмент 8:

<!-- prettier-ignore -->
```rust
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        if info.line_id == device.config.line_id {
            return Ok(device.status());
        }
```

заменить на:

<!-- prettier-ignore -->
```rust
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        let name = Some(info.name);
        if info.line_id == device.config.line_id && name == device.config.device_name {
            return Ok(device.status());
        }
```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
        let config = DeviceConfig {
            line_id: info.line_id,
            ..device.config.clone()
        };
```

заменить на:

<!-- prettier-ignore -->
```rust
        let config = DeviceConfig {
            line_id: info.line_id,
            device_name: name,
            ..device.config.clone()
        };
```

Фрагмент 10:

<!-- prettier-ignore -->
```rust

    /// Save a pairing the host just granted and make it current. The host
    /// that answered must be the one `hello` described.
    fn remember(
        &self,
```

заменить на:

<!-- prettier-ignore -->
```rust

    /// Save a pairing the host just granted and make it current. The host
    /// that answered must be the one `hello` described. The device's name is
    /// the one it paired under, trimmed as the host keeps it; a refresh
    /// replaces it with whatever the office renames it to.
    fn remember(
        &self,
```

Фрагмент 11:

<!-- prettier-ignore -->
```rust
        observation: HelloObservation,
        client: PinnedClient,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
```

заменить на:

<!-- prettier-ignore -->
```rust
        observation: HelloObservation,
        client: PinnedClient,
        name: &str,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
```

Фрагмент 12:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_key: secret_store::protect(pair.device_key.expose())
                .map_err(|_| DeviceError::Storage)?,
```

заменить на:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some(name.trim().to_owned()),
            device_key: secret_store::protect(pair.device_key.expose())
                .map_err(|_| DeviceError::Storage)?,
```

Фрагмент 13:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
        };
        let value = serde_json::to_value(&status).expect("DeviceStatus serializes");
```

заменить на:

<!-- prettier-ignore -->
```rust
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some("Станция на линии 1".into()),
        };
        let value = serde_json::to_value(&status).expect("DeviceStatus serializes");
```

Фрагмент 14:

<!-- prettier-ignore -->
```rust
            "kind",
            "lineId",
        ];
        expected.sort_unstable();
```

заменить на:

<!-- prettier-ignore -->
```rust
            "kind",
            "lineId",
            "deviceName",
        ];
        expected.sort_unstable();
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент:

<!-- prettier-ignore -->
```rust

/// Read this device's record from the host again and keep the line the
/// office assigned; the webview calls it at the same moments as the
/// reference sync (once the link's `watch` has subscribed or failed, and
/// after every revision event), and again after a failed read.
#[tauri::command]
async fn device_refresh(state: tauri::State<'_, DeviceState>) -> Result<DeviceStatus, String> {
```

заменить на:

<!-- prettier-ignore -->
```rust

/// Read this device's record from the host again and keep the line the
/// office assigned and the name it gave the device; the webview calls it at
/// the same moments as the reference sync (once the link's `watch` has
/// subscribed or failed, and after every revision event), and again after a
/// failed read.
#[tauri::command]
async fn device_refresh(state: tauri::State<'_, DeviceState>) -> Result<DeviceStatus, String> {
```

Правка `apps/standalone/src/host/protocol.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
    kind: deviceKindSchema,
    lineId: z.uuid().nullable(),
  })
  .strict();
```

заменить на:

<!-- prettier-ignore -->
```ts
    kind: deviceKindSchema,
    lineId: z.uuid().nullable(),
    /** The name the host keeps for this device; `null` until a refresh fills an old `device.json`. */
    deviceName: z.string().min(1).nullable(),
  })
  .strict();
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: PASS — 49 тестов.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --test device --test claim`
Expected: PASS — `line` 15, `ipc` 13, `device` 13, `claim` 4.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 67 файлов, 1749 тестов (`DEVICE_STATUS` с именем проходит через все экраны).

- [ ] **Step 5: Мутации**

1. `apps/standalone/src-tauri/src/device.rs`: `if info.line_id == device.config.line_id && name == device.config.device_name {` → `if info.line_id == device.config.line_id {`. Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line`. Expected: FAIL — `a_station_takes_the_name_the_office_gives_it`.
2. `apps/standalone/src/host/protocol.ts`: `deviceName: z.string().min(1).nullable(),` → `deviceName: z.string().min(1).nullable().optional(),`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts`. Expected: FAIL — «rejects a pairing without the device name».

- [ ] **Step 6: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/test/support/fixtures.ts apps/standalone/test/device.test.ts`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/src/device_config.rs apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/line.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/host/protocol.ts apps/standalone/test/support/fixtures.ts apps/standalone/test/device.test.ts
git commit -m "feat(standalone): the station keeps the name the host has for it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Классы таблиц для «забывания»

**Files:**

- Modify: `apps/standalone/src-tauri/src/local_db.rs`, `tests/local_db.rs`, `tests/ipc.rs`

**Interfaces:**

- Consumes: ничего из других задач.
- Produces: `pub enum TableClass { Disposable, DeviceData, Workstation }`, `pub const TABLE_CLASSES: &[(&str, TableClass)]` (сейчас 11 одноразовых таблиц, в порядке очистки, `sync_state` последней), `pub fn table_class(table: &str) -> Option<TableClass>`; `LocalDb::clear_copies` удаляет строки только одноразовых таблиц.

Тест `every_table_has_a_forget_class` сверяет `pragma_table_list` свежей базы со списком в обе стороны: таблица без класса и имя без таблицы — оба падение. Тест очистки берёт две таблицы, которые могла бы добавить поздняя миграция (`kept_device_records`, `kept_workstation_settings` — имена, которых не будет у настоящих таблиц), и проверяет, что их строки остаются. Тест IPC про откат целиком ставит отказывающий триггер на `sync_state` — последнюю очищаемую таблицу — и сначала проверяет, что она последняя.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{LocalDb, LocalDbError, LocalStatement, FILE_NAME};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
```

заменить на:

<!-- prettier-ignore -->
```rust
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalStatement, TableClass, FILE_NAME, TABLE_CLASSES,
};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
}

/// Pins today's user tables. `clear_copies` treats every one of them as
/// disposable (see its doc comment): the copies of the host's data, and
/// `floor_sign_in_failures` (plan 1f), this device's own failed sign-ins,
/// which a forget clears on purpose. A new migration that adds a table makes
/// this assertion fail, on purpose, so whoever adds it must decide whether
/// it is disposable too (extend the list here) or data this device must keep
/// — the scan journal, boxes, the outbox (the station design's §6.2,
/// "Логическая модель") — which `clear_copies` and `device_forget` then need
/// to treat deliberately, not silently wipe.
#[tokio::test]
async fn opening_creates_the_reference_tables_in_wal_mode_and_keeps_data() {
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// Pins today's user tables. What a forget does with each is
/// `TABLE_CLASSES`'s business (`every_table_has_a_forget_class` below); this
/// list changes with every migration that adds a table.
#[tokio::test]
async fn opening_creates_the_reference_tables_in_wal_mode_and_keeps_data() {
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
}

/// Forgetting the device (`device_forget`) clears every table but sqlx's
/// migration journal: tables a later migration adds too, since the list
/// comes from `pragma_table_list`, and in any order despite foreign keys.
#[tokio::test]
async fn clearing_the_copies_empties_every_table_but_the_migration_journal() {
    let (dir, db) = open().await;
    db.transaction(vec![
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// Every table the migrations create has exactly one forget class
/// (stage 2a spec §5.2, decision 30), and the class list names nothing else:
/// a plan that adds a table must say whether a forget empties it, keeps it as
/// this device's own record, or keeps it as the workstation's setting.
#[tokio::test]
async fn every_table_has_a_forget_class() {
    let (_dir, db) = open().await;
    let rows = db
        .query(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' \
             AND type IN ('table', 'virtual') AND name <> '_sqlx_migrations' \
             AND name NOT GLOB 'sqlite_*' ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    let tables: Vec<&str> = rows
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    let unclassified: Vec<&str> = tables
        .iter()
        .copied()
        .filter(|table| table_class(table).is_none())
        .collect();
    assert!(
        unclassified.is_empty(),
        "tables without a forget class: {unclassified:?}; add each to TABLE_CLASSES in local_db.rs"
    );
    let mut listed: Vec<&str> = TABLE_CLASSES.iter().map(|(table, _)| *table).collect();
    listed.sort_unstable();
    assert_eq!(
        listed, tables,
        "TABLE_CLASSES names each table of the migrations once, and nothing else"
    );
    // Until plan 2a5 brings the first records of the device's own, every
    // table is a copy or this pairing's bookkeeping.
    assert!(TABLE_CLASSES
        .iter()
        .all(|(_, class)| *class == TableClass::Disposable));
}

/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: a table outside that class (here two a later migration might
/// add, one of this device's records and one of the workstation's settings)
/// keeps its rows, and so does sqlx's migration journal.
#[tokio::test]
async fn clearing_the_copies_empties_the_disposable_tables_and_nothing_else() {
    let (dir, db) = open().await;
    db.transaction(vec![
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            json!([]),
        ),
        // This device's own failed sign-ins (plan 1f): cleared with the copies.
        statement(
```

заменить на:

<!-- prettier-ignore -->
```rust
            json!([]),
        ),
        statement(
            "INSERT INTO ref_operators (id, login, name, pin_phc, rev) \
             VALUES ('operator-1', '0001', 'Анна', 'pbkdf2$pin', 8)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) \
             VALUES ('badge-1', 'operator-1', 'pbkdf2$badge', NULL, 9)",
            json!([]),
        ),
        // This device's own failed sign-ins (plan 1f): cleared with the copies.
        statement(
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    // Tables as a later migration might add them, the second referring to
    // the first; the webview may not create tables, so a raw connection
    // does. `extra_holder` sorts first, so its delete runs while
    // `extra_item` still refers to it.
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
```

заменить на:

<!-- prettier-ignore -->
```rust
    .await
    .unwrap();
    // Tables as a later migration might add them; the webview may not create
    // tables, so a raw connection does.
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
        .unwrap();
    for sql in [
        "CREATE TABLE extra_holder (id TEXT PRIMARY KEY)",
        "CREATE TABLE extra_item (id TEXT PRIMARY KEY, \
         holder_id TEXT NOT NULL REFERENCES extra_holder (id))",
        "INSERT INTO extra_holder (id) VALUES ('h')",
        "INSERT INTO extra_item (id, holder_id) VALUES ('i', 'h')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
```

заменить на:

<!-- prettier-ignore -->
```rust
        .unwrap();
    for sql in [
        "CREATE TABLE kept_device_records (id TEXT PRIMARY KEY)",
        "CREATE TABLE kept_workstation_settings (key TEXT PRIMARY KEY)",
        "INSERT INTO kept_device_records (id) VALUES ('scan-1')",
        "INSERT INTO kept_workstation_settings (key) VALUES ('printers')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies().await, Ok(()));

    let left = db
        .query(
            "SELECT (SELECT count(*) FROM ref_org) + (SELECT count(*) FROM ref_site) \
             + (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
             + (SELECT count(*) FROM sync_quarantine) + (SELECT count(*) FROM ref_products) \
             + (SELECT count(*) FROM ref_templates) + (SELECT count(*) FROM ref_template_defaults) \
             + (SELECT count(*) FROM floor_sign_in_failures) \
             + (SELECT count(*) FROM extra_holder) + (SELECT count(*) FROM extra_item) AS n",
            vec![],
        )
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(db.clear_copies().await, Ok(()));

    for (table, _) in TABLE_CLASSES {
        let left = db
            .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
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

Фрагмент 8:

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(Value::Object(left[0].clone()), json!({ "n": 0 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
```

заменить на:

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 2 }));
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
    }
}

/// An FTS5 virtual table's shadow tables (`search_data`, `search_idx`, …)
/// hold its index; `sqlite_master` lists them as ordinary tables, but
/// deleting their rows directly — instead of through the virtual table —
/// corrupts the index. `clear_copies` must clear through the virtual table
/// and leave it fully usable afterwards.
#[tokio::test]
async fn clearing_the_copies_leaves_a_virtual_table_usable() {
    let (dir, db) = open().await;
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE VIRTUAL TABLE search USING fts5(body)")
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO search (rowid, body) VALUES (1, 'первая строка')")
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();

    assert_eq!(db.clear_copies().await, Ok(()));

    let empty = db
        .query("SELECT count(*) AS n FROM search", vec![])
        .await
        .unwrap();
    assert_eq!(Value::Object(empty[0].clone()), json!({ "n": 0 }));
    db.transaction(vec![statement(
        "INSERT INTO search (rowid, body) VALUES (1, ?)",
        json!(["вторая строка"]),
    )])
    .await
    .unwrap();
    let found = db
        .query(
            "SELECT body FROM search WHERE search MATCH 'вторая' ORDER BY rowid",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(found[0].clone()),
        json!({ "body": "вторая строка" })
    );
}
```

заменить на:

<!-- prettier-ignore -->
```rust
    }
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{LocalDbState, FILE_NAME};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

заменить на:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{LocalDbState, TableClass, FILE_NAME, TABLE_CLASSES};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
}

/// `device_forget` clears the local copies before it removes `device.json`:
/// when clearing fails, the command answers `storage` and the pairing stays,
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// A trigger that refuses every delete from `sync_state`.
const STUCK_SYNC_STATE: &str = "CREATE TRIGGER sync_state_stays BEFORE DELETE ON sync_state \
    BEGIN SELECT RAISE(ABORT, 'kept'); END";

/// `device_forget` clears the local copies before it removes `device.json`:
/// when clearing fails, the command answers `storage` and the pairing stays,
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    )
    .unwrap();
    // A table whose rows refuse to go. Named to sort last (after ref_lines,
    // ref_org, ref_site, sync_quarantine and sync_state), so every other
    // table's delete has already run by the time this one aborts: an
    // implementation that committed each delete on its own, instead of one
    // transaction, would still show `n = 3` if the refusing table sorted
    // first, since nothing else would have been touched yet either way.
    run_raw(
        app_dir.path(),
        &[
            "CREATE TABLE zz_kept (id TEXT PRIMARY KEY)",
            "CREATE TRIGGER zz_kept_stays BEFORE DELETE ON zz_kept \
             BEGIN SELECT RAISE(ABORT, 'kept'); END",
            "INSERT INTO zz_kept (id) VALUES ('k')",
        ],
    );
    let copies = || {
        invoke(
```

заменить на:

<!-- prettier-ignore -->
```rust
    )
    .unwrap();
    // Rows of `sync_state` refuse to go. It is the last disposable table
    // `clear_copies` empties, so every other table's delete has already run
    // by the time this one aborts: an implementation that committed each
    // delete on its own, instead of one transaction, would leave
    // `ref_lines` empty here.
    assert_eq!(
        TABLE_CLASSES.last(),
        Some(&("sync_state", TableClass::Disposable))
    );
    run_raw(app_dir.path(), &[STUCK_SYNC_STATE]);
    let copies = || {
        invoke(
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) \
                        + (SELECT count(*) FROM zz_kept) AS n",
                "params": []
            }),
```

заменить на:

<!-- prettier-ignore -->
```rust
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) AS n",
                "params": []
            }),
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
    assert_eq!(
        copies(),
        json!([{ "n": 3 }]),
        "the clearing rolled back whole"
    );

    run_raw(app_dir.path(), &["DROP TRIGGER zz_kept_stays"]);
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert_eq!(
        copies(),
        json!([{ "n": 2 }]),
        "the clearing rolled back whole"
    );

    run_raw(app_dir.path(), &["DROP TRIGGER sync_state_stays"]);
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --test ipc --no-run`
Expected: FAIL компиляции: `error[E0432]: unresolved imports 'markiro_standalone_lib::local_db::table_class', 'markiro_standalone_lib::local_db::TableClass', 'markiro_standalone_lib::local_db::TABLE_CLASSES'` в `local_db` и такой же без `table_class` в `ipc`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// `src-tauri/migrations`, embedded at compile time. Applied migrations are
```

заменить на:

<!-- prettier-ignore -->
```rust

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// What a forget (`device_forget`, [`LocalDb::clear_copies`]) does with a
/// table (stage 2a spec §5.2, decision 30).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableClass {
    /// Copies of the host's data and this pairing's own bookkeeping: the
    /// forget empties them, PIN and badge hashes included.
    Disposable,
    /// What this device recorded itself — shifts, boxes, scans, the outbox
    /// (plans 2a5–2a8): the forget keeps them, each row tagged with the
    /// pairing that wrote it.
    DeviceData,
    /// This computer's workstation settings — printers, scanners, sound
    /// (plan 2a7): they belong to the PC, not to a pairing, and outlive it.
    Workstation,
}

/// Every table `src-tauri/migrations` creates, with its class, in the order
/// [`LocalDb::clear_copies`] empties the disposable ones. A migration that
/// adds a table adds it here in the same change: `tests/local_db.rs` fails on
/// a table without a class, and on a name here that no migration creates. No
/// table has a foreign key; one between tables of different classes would
/// make a forget fail at its commit, so add none.
pub const TABLE_CLASSES: &[(&str, TableClass)] = &[
    ("floor_sign_in_failures", TableClass::Disposable),
    ("ref_lines", TableClass::Disposable),
    ("ref_operator_badges", TableClass::Disposable),
    ("ref_operators", TableClass::Disposable),
    ("ref_org", TableClass::Disposable),
    ("ref_products", TableClass::Disposable),
    ("ref_site", TableClass::Disposable),
    ("ref_template_defaults", TableClass::Disposable),
    ("ref_templates", TableClass::Disposable),
    ("sync_quarantine", TableClass::Disposable),
    ("sync_state", TableClass::Disposable),
];

/// The class of `table`, `None` for a table [`TABLE_CLASSES`] does not name.
pub fn table_class(table: &str) -> Option<TableClass> {
    TABLE_CLASSES
        .iter()
        .find(|(name, _)| *name == table)
        .map(|(_, class)| *class)
}

/// `src-tauri/migrations`, embedded at compile time. Applied migrations are
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    }

    /// Delete every row of every table but sqlx's migration journal, in one
    /// writer transaction: forgetting the device must not leave another
    /// pairing's copies behind, PIN and badge hashes included. The writer
    /// zeroes deleted rows (`secure_delete`), and a checkpoint that truncates
    /// the WAL follows the commit: it moves the zeroed pages into the file
    /// and empties the WAL, which still held the frames written before the
    /// delete. A reader holding an older snapshot keeps it from finishing
    /// within the busy timeout, and the call then fails; the delete stays
    /// committed and a retry repeats only the checkpoint. `VACUUM` is not
    /// needed for the rows deleted here: it would only shrink the file. It
    /// would do more for bytes a writer freed before it ran with
    /// `secure_delete`, which nothing here scrubs (see "Local database" in
    /// `apps/standalone/AGENTS.md`).
    /// Every table here is disposable: the copies of the host's data, and
    /// `floor_sign_in_failures` (plan 1f), this device's own failed
    /// sign-ins, which a forget clears with the rest (the sync's wipe for
    /// another pairing keeps them on purpose, see the migration). The first
    /// plan that adds data this device must keep — the scan journal, boxes, the
    /// outbox (the station design's §6.2, "Логическая модель") — must
    /// exclude those tables from this list and block or confirm a forget
    /// while unsynced records exist, not extend this silently.
    /// The tables come from `pragma_table_list`, so one a later migration
    /// adds is covered without a change here; `type IN ('table', 'virtual')`
    /// excludes a virtual table's own shadow tables (FTS5, RTree), which
    /// `sqlite_master` lists as ordinary tables but a bare `DELETE` would
    /// corrupt instead of clearing through the virtual table itself. Foreign
    /// keys are checked at the commit, when every table is empty, so the
    /// order of the deletes does not matter.
    pub async fn clear_copies(&self) -> Result<(), LocalDbError> {
        let mut tx = self
```

заменить на:

<!-- prettier-ignore -->
```rust
    }

    /// Delete every row of the disposable tables ([`TableClass::Disposable`]
    /// in [`TABLE_CLASSES`]), in one writer transaction: forgetting the device
    /// must not leave another pairing's copies behind, PIN and badge hashes
    /// included. The tables of this device's own records and of the
    /// workstation's settings keep their rows (stage 2a spec §5.2, decision
    /// 30); `device_forget` decides first whether unsent records allow a
    /// forget at all. The writer zeroes deleted rows (`secure_delete`), and a
    /// checkpoint that truncates the WAL follows the commit: it moves the
    /// zeroed pages into the file and empties the WAL, which still held the
    /// frames written before the delete. A reader holding an older snapshot
    /// keeps it from finishing within the busy timeout, and the call then
    /// fails; the delete stays committed and a retry repeats only the
    /// checkpoint. `VACUUM` is not needed for the rows deleted here: it would
    /// only shrink the file. It would do more for bytes a writer freed before
    /// it ran with `secure_delete`, which nothing here scrubs (see "Local
    /// database" in `apps/standalone/AGENTS.md`). The list is named, not read
    /// from `pragma_table_list`: a table a later migration adds is emptied
    /// only once that migration's plan classes it disposable.
    pub async fn clear_copies(&self) -> Result<(), LocalDbError> {
        let mut tx = self
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *tx)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' \
             AND type IN ('table', 'virtual') AND name <> '_sqlx_migrations' \
             AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| LocalDbError::StatementFailed)?;
        for table in tables {
            let delete = format!("DELETE FROM \"{}\"", table.replace('"', "\"\""));
            sqlx::query(&delete)
                .execute(&mut *tx)
                .await
```

заменить на:

<!-- prettier-ignore -->
```rust
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let disposable = TABLE_CLASSES
            .iter()
            .filter(|(_, class)| *class == TableClass::Disposable);
        for (table, _) in disposable {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut *tx)
                .await
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db`
Expected: PASS — библиотека 49, `local_db` 12.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: PASS — 13 тестов.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src-tauri/src/local_db.rs`: `    ("sync_state", TableClass::Disposable),` → `    ("sync_state", TableClass::DeviceData),`. Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`. Expected: FAIL — `every_table_has_a_forget_class` и `clearing_the_copies_empties_the_disposable_tables_and_nothing_else`.
2. Временная миграция с таблицей без класса: `printf 'CREATE TABLE unclassified_probe (id TEXT PRIMARY KEY);\n' > apps/standalone/src-tauri/migrations/0006_unclassified_probe.sql`; Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db every_table`. Expected: FAIL с сообщением `tables without a forget class: ["unclassified_probe"]; add each to TABLE_CLASSES in local_db.rs`. Затем `rm apps/standalone/src-tauri/migrations/0006_unclassified_probe.sql`; `git status --short` — пусто (`build.rs` пересоберёт встроенные миграции при следующей сборке).

- [ ] **Step 6: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs
git commit -m "feat(standalone): every local table has a forget class, and a forget empties only the disposable ones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: «Забывание» ждёт неотправленного; нечитаемая база — в сторону

**Files:**

- Modify: `apps/standalone/src-tauri/src/local_db.rs`, `src/lib.rs`, `tests/local_db.rs`, `tests/ipc.rs`; `apps/standalone/src/host/device.ts`, `src/i18n/ru.json`, `test/device.test.ts`

**Interfaces:**

- Consumes: `TABLE_CLASSES`, `TableClass` (задача 4); `DeviceStatus.host_id`, `device_id`.
- Produces: `pub enum UnsentGuard<'a> { Pairing(&'a str, &'a str), AnyPairing, Ignore }`; `LocalDb::clear_copies(&self, guard: UnsentGuard<'_>) -> Result<(), LocalDbError>`; `LocalDbError::UnsentRecords { count: u64 }` (код `"unsent_facts"`); `LocalDbState::set_aside_unopened(&self) -> std::io::Result<Option<PathBuf>>` и `set_aside_unopened_at(&self, stamp: u128)` (для тестов) вместо `remove_unopened`; команда `device_forget` с аргументом `keepUnsent`. Вебвью: `DeviceApi.forget(options?: { keepUnsent?: boolean })`, `"unsent_facts"` в `DEVICE_ERROR_CODES`, текст `errors.device.unsent_facts`.

Временная `outbox` в тестах — константа `OUTBOX` (только `id`, `host_id`, `device_id`, `acked_at`), создаётся сырым соединением, как поздняя миграция; план 2a5 заменит её своей таблицей. Тест отказа переноса через IPC — только Unix (каталог без права записи; под пользователем, которого права не останавливают, тест пропускается с сообщением); тот же отказ на любой ОС проверяет `a_file_that_cannot_be_set_aside_puts_the_others_back` в `tests/local_db.rs` (непустой каталог на месте нового имени WAL).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust

use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalStatement, TableClass, FILE_NAME, TABLE_CLASSES,
};
use serde_json::{json, Value};
```

заменить на:

<!-- prettier-ignore -->
```rust

use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalDbState, LocalStatement, TableClass, UnsentGuard,
    FILE_NAME, TABLE_CLASSES,
};
use serde_json::{json, Value};
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    let migrations = db.query(journal, vec![]).await.unwrap();

    assert_eq!(db.clear_copies().await, Ok(()));

    for (table, _) in TABLE_CLASSES {
```

заменить на:

<!-- prettier-ignore -->
```rust
    let migrations = db.query(journal, vec![]).await.unwrap();

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for (table, _) in TABLE_CLASSES {
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        .await,
        Ok(vec![1])
    );
}

/// Whether the file at `path` holds `marker` anywhere; a missing file holds nothing.
```

заменить на:

<!-- prettier-ignore -->
```rust
        .await,
        Ok(vec![1])
    );
}

const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_DEVICE: &str = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

/// Runs `statements` on a raw connection, as a later migration would: the
/// webview may not create tables. `outbox` here stands for plan 2a5's table
/// with only the columns a forget reads; plan 2a5 replaces it with its own.
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

const OUTBOX: &str = "CREATE TABLE outbox (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, \
    device_id TEXT NOT NULL, acked_at TEXT)";

async fn count(db: &LocalDb, table: &str) -> Value {
    let rows = db
        .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
        .await
        .unwrap();
    rows[0]["n"].clone()
}

/// A forget refuses while records without a receipt remain (stage 2a spec
/// §5.2, question В7): this pairing's with `Pairing`, anyone's with
/// `AnyPairing`; it clears nothing then. `Ignore` — the person confirmed —
/// clears the copies and keeps every outbox record.
#[tokio::test]
async fn a_forget_refuses_while_unsent_records_remain() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    let mine = format!("INSERT INTO outbox VALUES ('a', '{HOST}', '{DEVICE}', NULL)");
    let others = format!("INSERT INTO outbox VALUES ('b', '{HOST}', '{OTHER_DEVICE}', NULL)");
    run_raw(dir.path(), &[OUTBOX, &mine, &others]).await;

    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Err(LocalDbError::UnsentRecords { count: 1 })
    );
    assert_eq!(
        db.clear_copies(UnsentGuard::AnyPairing).await,
        Err(LocalDbError::UnsentRecords { count: 2 })
    );
    assert_eq!(
        count(&db, "ref_lines").await,
        json!(1),
        "nothing was cleared"
    );

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));
    assert_eq!(count(&db, "ref_lines").await, json!(0));
    assert_eq!(count(&db, "outbox").await, json!(2), "the records stay");
}

/// Records with a receipt, and another pairing's, do not stop this
/// pairing's forget; nor does a database without an outbox yet (before plan
/// 2a5's migration).
#[tokio::test]
async fn sent_records_and_other_pairings_do_not_stop_a_forget() {
    let (dir, db) = open().await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Ok(())
    );
    assert_eq!(db.clear_copies(UnsentGuard::AnyPairing).await, Ok(()));

    let acked = format!(
        "INSERT INTO outbox VALUES ('a', '{HOST}', '{DEVICE}', '2026-10-09T08:00:00.000Z')"
    );
    let others = format!("INSERT INTO outbox VALUES ('b', '{HOST}', '{OTHER_DEVICE}', NULL)");
    run_raw(dir.path(), &[OUTBOX, &acked, &others]).await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Ok(())
    );
    assert_eq!(count(&db, "outbox").await, json!(2));
}

/// The files of a database that did not open: a file of garbage where the
/// database belongs, and the given side files written after the failed open
/// (see `unopened_database` in `tests/ipc.rs` for why after).
async fn unopened(dir: &std::path::Path, beside: &[&str]) -> LocalDbState {
    std::fs::write(dir.join(FILE_NAME), "not a database").unwrap();
    let local = LocalDbState::open(dir).await;
    assert!(local.get().is_err(), "a file of garbage does not open");
    for suffix in beside {
        std::fs::write(dir.join(format!("{FILE_NAME}{suffix}")), "not a database").unwrap();
    }
    local
}

/// A database that did not open is moved aside with its side files, nothing
/// deleted, and a new one opens in its place (stage 2a spec §5.2, question
/// В7).
#[tokio::test]
async fn an_unopened_database_is_set_aside_and_a_new_one_opens() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &["-wal", "-shm"]).await;

    let aside = local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .unwrap();

    let aside_name = format!("{FILE_NAME}.unreadable-1790000000000");
    assert_eq!(aside, Some(dir.path().join(&aside_name)));
    for suffix in ["", "-wal", "-shm"] {
        let kept = dir.path().join(format!("{aside_name}{suffix}"));
        assert_eq!(std::fs::read_to_string(&kept).unwrap(), "not a database");
    }
    assert!(!dir.path().join(format!("{aside_name}-journal")).exists());
    let db = local.get().expect("a new database opened in its place");
    assert_eq!(count(db, "ref_lines").await, json!(0));
    // Once open, there is nothing more to move aside.
    assert_eq!(
        local
            .set_aside_unopened_at(1_790_000_000_001)
            .await
            .unwrap(),
        None
    );
}

/// A file that cannot be moved aside puts back the ones already moved: the
/// database never loses its WAL to a half-done move, and no new database
/// opens over it. A non-empty directory already standing at the WAL's new
/// name stops that one move.
#[tokio::test]
async fn a_file_that_cannot_be_set_aside_puts_the_others_back() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &["-wal"]).await;
    let blocked = dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000000-wal"));
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(blocked.join("kept"), "kept").unwrap();

    assert!(local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .is_err());

    for suffix in ["", "-wal"] {
        let file = dir.path().join(format!("{FILE_NAME}{suffix}"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a database");
    }
    assert!(!dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000000"))
        .exists());
    assert!(local.get().is_err(), "no new database over the old files");
}

/// Whether the file at `path` holds `marker` anywhere; a missing file holds nothing.
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    assert!(file_holds(&wal, IN_WAL), "the second marker is in the WAL");

    assert_eq!(db.clear_copies().await, Ok(()));

    for marker in [IN_FILE, IN_WAL] {
```

заменить на:

<!-- prettier-ignore -->
```rust
    assert!(file_holds(&wal, IN_WAL), "the second marker is in the WAL");

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for marker in [IN_FILE, IN_WAL] {
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
}

/// The database file and the files SQLite keeps beside it.
fn database_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    ["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| dir.join(format!("{FILE_NAME}{suffix}")))
        .collect()
}

/// A local database that did not open: a file of garbage where the database
/// belongs. The open fails with that file alone in the directory, and only
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// A local database that did not open: a file of garbage where the database
/// belongs. The open fails with that file alone in the directory, and only
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
}

/// A local database that did not open (here, files of garbage) may still
/// hold PIN and badge hashes: `device_forget` removes it with its `-wal`,
/// `-shm` and `-journal` files before it removes `device.json`. Like the
/// test above, this one needs no host and runs in the sandbox.
#[test]
fn forgetting_the_device_removes_a_local_database_that_did_not_open() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// The files whose name says `device_forget` moved them aside.
fn set_aside(dir: &std::path::Path) -> Vec<String> {
    let prefix = format!("{FILE_NAME}.unreadable-");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with(&prefix))
        .collect();
    names.sort_unstable();
    names
}

/// A local database that did not open (here, files of garbage) may hold
/// this device's unsent records: `device_forget` moves it aside with its
/// `-wal`, `-shm` and `-journal` files instead of deleting it, opens a new
/// one, and only then removes `device.json` (stage 2a spec §5.2, question
/// В7). Like the test above, this one needs no host and runs in the sandbox.
#[test]
fn forgetting_the_device_sets_aside_a_local_database_that_did_not_open() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    save_pairing(app_dir.path());
    let local = unopened_database(app_dir.path(), &["-wal", "-shm", "-journal"]);
    let files = database_files(app_dir.path());
    for file in &files {
        assert!(file.exists(), "{} is not there to remove", file.display());
    }
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
```

заменить на:

<!-- prettier-ignore -->
```rust
    save_pairing(app_dir.path());
    let local = unopened_database(app_dir.path(), &["-wal", "-shm", "-journal"]);
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT 1", "params": [] })
        ),
        Err(json!("local_db_unavailable"))
    );

    assert_eq!(
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    );
    assert!(!config.exists());
    for file in &files {
        assert!(!file.exists(), "{} is still there", file.display());
    }
}

/// A database file that cannot be removed fails the forget with `storage`,
/// and `device.json` stays for another try, as when clearing an open
/// database fails. A directory in place of the WAL stands for a file that is
/// locked or not the app's to remove. The removal does not stop there: the
/// `-shm` and `-journal` files that come after the WAL in its order go too.
#[test]
fn forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let file = app_dir.path().join(FILE_NAME);
    let local = unopened_database(app_dir.path(), &["-shm", "-journal"]);
    let stuck = app_dir.path().join(format!("{FILE_NAME}-wal"));
    std::fs::create_dir(&stuck).unwrap();
    std::fs::write(stuck.join("kept"), "kept").unwrap();
    let after_the_wal = [
        app_dir.path().join(format!("{FILE_NAME}-shm")),
        app_dir.path().join(format!("{FILE_NAME}-journal")),
    ];
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let paired = invoke(&webview, "device_status", json!({}));
```

заменить на:

<!-- prettier-ignore -->
```rust
    );
    assert!(!config.exists());
    let aside = set_aside(app_dir.path());
    assert_eq!(aside.len(), 4, "{aside:?}");
    for name in &aside {
        assert_eq!(
            std::fs::read_to_string(app_dir.path().join(name)).unwrap(),
            "not a database",
            "{name} is kept as it was"
        );
    }
    // A new database stands in its place and answers at once.
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT count(*) AS n FROM ref_lines", "params": [] })
        ),
        Ok(json!([{ "n": 0 }]))
    );
}

/// A database file that cannot be moved aside fails the forget with
/// `storage`, and `device.json` stays for another try, as when clearing an
/// open database fails. A directory the app may not write stands for a file
/// that is locked or not the app's to move; the same refusal on every system
/// is `a_file_that_cannot_be_set_aside_puts_the_others_back` in
/// `tests/local_db.rs`. A user the permissions do not stop (root) skips it.
#[cfg(unix)]
#[test]
fn forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays() {
    use std::os::unix::fs::PermissionsExt;
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let local = unopened_database(app_dir.path(), &["-wal"]);
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let paired = invoke(&webview, "device_status", json!({}));
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
        "the app starts paired"
    );

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("storage"))
    );
    assert!(config.exists(), "the pairing stays for another try");
    assert_eq!(
```

заменить на:

<!-- prettier-ignore -->
```rust
        "the app starts paired"
    );
    let mode = |bits| std::fs::Permissions::from_mode(bits);
    std::fs::set_permissions(app_dir.path(), mode(0o500)).unwrap();
    let probe = app_dir.path().join("probe");
    if std::fs::write(&probe, "").is_ok() {
        std::fs::remove_file(&probe).unwrap();
        std::fs::set_permissions(app_dir.path(), mode(0o700)).unwrap();
        eprintln!("skipped: the permissions do not stop this user");
        return;
    }

    let refused = invoke(&webview, "device_forget", json!({}));
    // Writable again before any assertion, so the directory can be removed.
    std::fs::set_permissions(app_dir.path(), mode(0o700)).unwrap();

    assert_eq!(refused, Err(json!("storage")));
    assert!(config.exists(), "the pairing stays for another try");
    assert_eq!(
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
        "the pairing stays"
    );
    assert!(stuck.exists(), "the file that cannot go stays");
    assert!(!file.exists(), "what could go is gone");
    for file in &after_the_wal {
        assert!(!file.exists(), "{} is still there", file.display());
    }

    std::fs::remove_dir_all(&stuck).unwrap();
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
```

заменить на:

<!-- prettier-ignore -->
```rust
        "the pairing stays"
    );
    assert!(set_aside(app_dir.path()).is_empty(), "nothing was moved");
    for suffix in ["", "-wal"] {
        let file = app_dir.path().join(format!("{FILE_NAME}{suffix}"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a database");
    }

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert_eq!(set_aside(app_dir.path()).len(), 2);
}

/// `outbox` as plan 2a5's migration will create it, with only the columns a
/// forget reads; plan 2a5 replaces it with its own table here.
const OUTBOX: &str = "CREATE TABLE outbox (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, \
    device_id TEXT NOT NULL, acked_at TEXT)";
const PAIRED_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PAIRED_DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/// `device_forget` takes `keepUnsent` (`src/host/device.ts`): without it, a
/// record of this pairing without a receipt answers `unsent_facts` and
/// nothing changes; with `true` the forget goes ahead, clears the copies and
/// keeps the record on disk.
#[test]
fn forgetting_the_device_waits_for_this_pairings_unsent_records() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
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
        ],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let left = || {
        invoke(
            &webview,
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM sync_state) AS copies, \
                        (SELECT count(*) FROM outbox) AS records",
                "params": []
            }),
        )
        .unwrap()
    };

    for args in [json!({}), json!({ "keepUnsent": false })] {
        assert_eq!(
            invoke(&webview, "device_forget", args),
            Err(json!("unsent_facts"))
        );
    }
    assert!(config.exists(), "the pairing stays");
    assert_eq!(left(), json!([{ "copies": 1, "records": 1 }]));

    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert_eq!(left(), json!([{ "copies": 0, "records": 1 }]));
}

/// With `device.json` unreadable the current pairing is unknown, so a record
/// without a receipt of any pairing stops the forget, until the person
/// confirms.
#[test]
fn with_an_unreadable_pairing_any_unsent_record_stops_a_forget() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    std::fs::write(&config, "{").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    run_raw(
        app_dir.path(),
        &[
            OUTBOX,
            "INSERT INTO outbox VALUES ('r1', 'another-host', 'another-device', NULL)",
        ],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("unsent_facts"))
    );
    assert!(config.exists());
    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
```

Правка `apps/standalone/test/device.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  });

  it("pairs by code with the host's address, the confirmed fingerprint and a name", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("forgets despite unsent records only when asked to keep them", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTauriDeviceApi(call).forget({ keepUnsent: true });
    expect(call).toHaveBeenLastCalledWith("device_forget", { keepUnsent: true });
    await createTauriDeviceApi(call).forget({ keepUnsent: false });
    expect(call).toHaveBeenLastCalledWith("device_forget", {});
  });

  it("keeps the shell's refusal while unsent records remain", async () => {
    const call = vi.fn().mockRejectedValue("unsent_facts");
    expect((await failure(createTauriDeviceApi(call).forget())).code).toBe("unsent_facts");
  });

  it("pairs by code with the host's address, the confirmed fingerprint and a name", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --no-run`
Expected: FAIL компиляции; среди ошибок — `error[E0432]: unresolved import 'markiro_standalone_lib::local_db::UnsentGuard'`, `error[E0061]: this method takes 0 arguments but 1 argument was supplied` (8 раз, `clear_copies`), `error[E0599]: no method named 'set_aside_unopened_at' found for struct 'LocalDbState'` (3 раза), `error[E0599]: no variant named 'UnsentRecords' found for enum 'LocalDbError'` (2 раза).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts`
Expected: FAIL — 2 теста: «forgets despite unsent records only when asked to keep them», «keeps the shell's refusal while unsent records remain».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
```

заменить на:

<!-- prettier-ignore -->
```rust

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    /// the batch rolled back whole.
    ChangesMismatch,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    /// the batch rolled back whole.
    ChangesMismatch,
    /// [`LocalDb::clear_copies`] found `count` outbox records without a
    /// receipt that its [`UnsentGuard`] protects, and cleared nothing.
    UnsentRecords { count: u64 },
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            LocalDbError::StatementFailed => "statement_failed",
            LocalDbError::ChangesMismatch => "changes_mismatch",
        }
    }
}

```

заменить на:

<!-- prettier-ignore -->
```rust
            LocalDbError::StatementFailed => "statement_failed",
            LocalDbError::ChangesMismatch => "changes_mismatch",
            LocalDbError::UnsentRecords { .. } => "unsent_facts",
        }
    }
}

/// Which outbox records without a receipt stop a forget (stage 2a spec §5.2,
/// question В7): a forget never waits for them, it refuses, so the station
/// sends them first or a person confirms the loss of the link to them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsentGuard<'a> {
    /// This pairing's (host id, device id): records of an earlier pairing
    /// that was forgotten with a confirmation do not count.
    Pairing(&'a str, &'a str),
    /// Any pairing's: `device.json` is unreadable, so the current pairing is
    /// unknown.
    AnyPairing,
    /// None: a person confirmed the forget knowing the count, or there is no
    /// pairing to forget. The records stay on disk either way.
    Ignore,
}

```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    /// from `pragma_table_list`: a table a later migration adds is emptied
    /// only once that migration's plan classes it disposable.
    pub async fn clear_copies(&self) -> Result<(), LocalDbError> {
        let mut tx = self
            .writer
```

заменить на:

<!-- prettier-ignore -->
```rust
    /// from `pragma_table_list`: a table a later migration adds is emptied
    /// only once that migration's plan classes it disposable.
    pub async fn clear_copies(&self, guard: UnsentGuard<'_>) -> Result<(), LocalDbError> {
        let mut tx = self
            .writer
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let disposable = TABLE_CLASSES
            .iter()
```

заменить на:

<!-- prettier-ignore -->
```rust
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let count = unsent_records(&mut *tx, guard).await?;
        if count > 0 {
            return Err(LocalDbError::UnsentRecords { count });
        }
        let disposable = TABLE_CLASSES
            .iter()
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
}

/// Tauri state: the local database, or none when it could not be opened.
/// The app still starts — the office works without it — and the local
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// How many outbox records without a receipt (`acked_at IS NULL`) `guard`
/// protects, counted inside the forget's own transaction, so no record can
/// arrive between the count and the clear. 0 while no migration has created
/// `outbox` (plan 2a5 does, with the columns `host_id`, `device_id` and
/// `acked_at`).
async fn unsent_records(
    tx: &mut sqlx::SqliteConnection,
    guard: UnsentGuard<'_>,
) -> Result<u64, LocalDbError> {
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
    let count: i64 = match guard {
        UnsentGuard::Pairing(host_id, device_id) => sqlx::query_scalar(
            "SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",
        )
        .bind(host_id)
        .bind(device_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?,
        UnsentGuard::AnyPairing => {
            sqlx::query_scalar("SELECT count(*) FROM outbox WHERE acked_at IS NULL")
                .fetch_one(&mut *tx)
                .await
                .map_err(failed)?
        }
        UnsentGuard::Ignore => 0,
    };
    Ok(u64::try_from(count).unwrap_or(0))
}

/// Tauri state: the local database, or none when it could not be opened.
/// The app still starts — the office works without it — and the local
```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
/// commands answer `local_db_unavailable`.
pub struct LocalDbState {
    db: Option<LocalDb>,
    /// Where `open` looked for the database; `None` for a shell with no
    /// local database at all (`unavailable`).
    dir: Option<PathBuf>,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
/// commands answer `local_db_unavailable`.
pub struct LocalDbState {
    /// Set when the database opened at start, or later by
    /// [`Self::set_aside_unopened`], which opens a new one in its place.
    db: OnceLock<LocalDb>,
    /// Where `open` looked for the database; `None` for a shell with no
    /// local database at all (`unavailable`).
    dir: Option<PathBuf>,
    /// Serialises [`Self::set_aside_unopened`]: two forgets must not move
    /// the same files aside twice or open two databases.
    setting_aside: tokio::sync::Mutex<()>,
}

```

Фрагмент 8:

<!-- prettier-ignore -->
```rust
impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        Self {
            db: LocalDb::open(dir).await.ok(),
            dir: Some(dir.to_path_buf()),
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        let db = OnceLock::new();
        if let Ok(opened) = LocalDb::open(dir).await {
            let _ = db.set(opened);
        }
        Self {
            db,
            dir: Some(dir.to_path_buf()),
            setting_aside: tokio::sync::Mutex::new(()),
        }
    }
```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
    pub fn unavailable() -> Self {
        Self {
            db: None,
            dir: None,
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
    pub fn unavailable() -> Self {
        Self {
            db: OnceLock::new(),
            dir: None,
            setting_aside: tokio::sync::Mutex::new(()),
        }
    }
```

Фрагмент 10:

<!-- prettier-ignore -->
```rust

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.db.as_ref().ok_or(LocalDbError::Unavailable)
    }

    /// Remove the database `open` could not open, with its `-wal`, `-shm`
    /// and `-journal` files: it may still hold PIN and badge hashes, and
    /// forgetting the device must not leave them behind. Each file goes on a
    /// best-effort basis, then all four are checked again, and one still
    /// there fails the call. Does nothing for an open database, which
    /// [`LocalDb::clear_copies`] empties instead, or without a directory.
    /// Everything in these files is treated as a disposable copy, as in
    /// `clear_copies`: the first plan that adds data this device owns instead
    /// of a copy (the scan journal, boxes, the outbox) must keep this removal
    /// from deleting it, and block or confirm a forget while unsynced records
    /// exist (`AGENTS.md`, "Local database").
    pub fn remove_unopened(&self) -> std::io::Result<()> {
        let (None, Some(dir)) = (&self.db, &self.dir) else {
            return Ok(());
        };
        let files: Vec<PathBuf> = FILE_SUFFIXES
            .iter()
            .map(|suffix| dir.join(format!("{FILE_NAME}{suffix}")))
            .collect();
        for file in &files {
            // Best effort: a file that stays is found just below.
            let _ = std::fs::remove_file(file);
        }
        match files.iter().find(|file| file.symlink_metadata().is_ok()) {
            Some(file) => Err(std::io::Error::other(format!(
                "{} is still there",
                file.display()
            ))),
            None => Ok(()),
        }
    }
}
```

заменить на:

<!-- prettier-ignore -->
```rust

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.db.get().ok_or(LocalDbError::Unavailable)
    }

    /// Move the database `open` could not open out of the way, with its
    /// `-wal`, `-shm` and `-journal` files, and open a new one in its place
    /// (stage 2a spec §5.2, question В7). Nothing is deleted: the file may
    /// hold this device's unsent records, which support can still read (plan
    /// 5), and it may hold PIN and badge hashes — the accepted price of
    /// keeping those records. The files become
    /// `standalone-station.db.unreadable-<unix ms>` plus their suffix, so the
    /// set stays openable together. A file that cannot be moved puts back
    /// the ones already moved and fails the call. Answers where the database
    /// went, `None` when there was nothing to move, an open database or no
    /// directory; a new database that does not open either leaves the state
    /// without one, as at start.
    pub async fn set_aside_unopened(&self) -> std::io::Result<Option<PathBuf>> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);
        self.set_aside_unopened_at(stamp).await
    }

    /// [`Self::set_aside_unopened`] with the time stamp given, for tests.
    pub async fn set_aside_unopened_at(&self, stamp: u128) -> std::io::Result<Option<PathBuf>> {
        let Some(dir) = &self.dir else {
            return Ok(None);
        };
        let _setting_aside = self.setting_aside.lock().await;
        if self.db.get().is_some() {
            return Ok(None);
        }
        let aside = format!("{FILE_NAME}.unreadable-{stamp}");
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut database = None;
        for suffix in FILE_SUFFIXES {
            let from = dir.join(format!("{FILE_NAME}{suffix}"));
            if from.symlink_metadata().is_err() {
                continue;
            }
            let to = dir.join(format!("{aside}{suffix}"));
            if let Err(error) = std::fs::rename(&from, &to) {
                for (back, place) in moved.iter().rev() {
                    // Best effort: a file left aside is still kept, not lost.
                    let _ = std::fs::rename(place, back);
                }
                return Err(error);
            }
            if suffix.is_empty() {
                database = Some(to.clone());
            }
            moved.push((from, to));
        }
        if let Ok(opened) = LocalDb::open(dir).await {
            let _ = self.db.set(opened);
        }
        Ok(database)
    }
}
```

Фрагмент 11:

<!-- prettier-ignore -->
```rust
            LocalDbError::StatementFailed,
            LocalDbError::ChangesMismatch,
        ]
        .into_iter()
```

заменить на:

<!-- prettier-ignore -->
```rust
            LocalDbError::StatementFailed,
            LocalDbError::ChangesMismatch,
            LocalDbError::UnsentRecords { count: 3 },
        ]
        .into_iter()
```

Фрагмент 12:

<!-- prettier-ignore -->
```rust
                "unsupported_value",
                "statement_failed",
                "changes_mismatch"
            ]
        );
```

заменить на:

<!-- prettier-ignore -->
```rust
                "unsupported_value",
                "statement_failed",
                "changes_mismatch",
                "unsent_facts"
            ]
        );
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use device::{DeviceError, DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbState, LocalStatement};

/// The host service on this computer.
```

заменить на:

<!-- prettier-ignore -->
```rust
use device::{DeviceError, DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbError, LocalDbState, LocalStatement, UnsentGuard};

/// The host service on this computer.
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust

/// Forget the pairing: the local copies go first. An open local database is
/// cleared (`LocalDb::clear_copies`); one that did not open is removed with
/// its `-wal`, `-shm` and `-journal` files (`LocalDbState::remove_unopened`),
/// since it may still hold PIN and badge hashes. When either fails, the
/// command answers `storage` and `device.json` stays for another try.
#[tauri::command]
async fn device_forget(
```

заменить на:

<!-- prettier-ignore -->
```rust

/// Forget the pairing: the local copies go first. An open local database is
/// cleared (`LocalDb::clear_copies`) unless this pairing still has outbox
/// records without a receipt: then the command answers `unsent_facts`, clears
/// nothing and keeps `device.json`, until the records are sent or the person
/// confirms with `keepUnsent: true` (the records stay on disk). With
/// `device.json` unreadable, any pairing's unsent records count. A database
/// that did not open is moved aside with its `-wal`, `-shm` and `-journal`
/// files and a new one opens (`LocalDbState::set_aside_unopened`): nothing is
/// deleted, so no confirmation is needed. When clearing or moving fails, the
/// command answers `storage` and `device.json` stays for another try (stage
/// 2a spec §5.2, question В7).
#[tauri::command]
async fn device_forget(
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
) -> Result<(), String> {
    let cleared = match local.get() {
        Ok(db) => db.clear_copies().await.is_ok(),
        Err(_) => local.remove_unopened().is_ok(),
    };
    if !cleared {
```

заменить на:

<!-- prettier-ignore -->
```rust
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
    keep_unsent: Option<bool>,
) -> Result<(), String> {
    let cleared = match local.get() {
        Ok(db) => {
            let status = state.status();
            let guard = match (keep_unsent, &status) {
                (Some(true), _) | (_, Ok(None)) => UnsentGuard::Ignore,
                (_, Ok(Some(paired))) => UnsentGuard::Pairing(&paired.host_id, &paired.device_id),
                (_, Err(_)) => UnsentGuard::AnyPairing,
            };
            match db.clear_copies(guard).await {
                Ok(()) => true,
                Err(error @ LocalDbError::UnsentRecords { count }) => {
                    eprintln!("standalone: device_forget refused: {count} unsent outbox records");
                    return Err(error.code().to_owned());
                }
                Err(_) => false,
            }
        }
        Err(_) => local.set_aside_unopened().await.is_ok(),
    };
    if !cleared {
```

Правка `apps/standalone/src/host/device.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  "key_rejected",
  "request_failed",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
```

заменить на:

<!-- prettier-ignore -->
```ts
  "key_rejected",
  "request_failed",
  "unsent_facts",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  /** Choose this station's line; the shell keeps the host's answer in `device.json`. */
  selectLine(lineId: string): Promise<DeviceStatus>;
  /** Forget the pairing kept on this computer. */
  forget(): Promise<void>;
  /**
   * Read this device's record from the host again (`device_refresh`); the
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** Choose this station's line; the shell keeps the host's answer in `device.json`. */
  selectLine(lineId: string): Promise<DeviceStatus>;
  /**
   * Forget the pairing kept on this computer. While this pairing has shift
   * records the host has not acknowledged, the shell refuses with
   * `unsent_facts`; `keepUnsent: true` goes ahead anyway (a person confirmed
   * it), and the records stay on this PC's disk.
   */
  forget(options?: { keepUnsent?: boolean }): Promise<void>;
  /**
   * Read this device's record from the host again (`device_refresh`); the
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      return parseStatus(await run("device_select_line", { lineId }));
    },
    async forget() {
      await run("device_forget", {});
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
```

заменить на:

<!-- prettier-ignore -->
```ts
      return parseStatus(await run("device_select_line", { lineId }));
    },
    async forget(options) {
      await run("device_forget", options?.keepUnsent === true ? { keepUnsent: true } : {});
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "line_rejected": "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "request_failed": "Хост не выполнил запрос. Повторите попытку."
    }
  }
```

заменить на:

<!-- prettier-ignore -->
```json
      "line_rejected": "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "request_failed": "Хост не выполнил запрос. Повторите попытку.",
      "unsent_facts": "На этом устройстве есть данные смен, которые ещё не ушли на хост. Подождите, пока они отправятся, или подтвердите сброс: данные останутся на диске этого ПК."
    }
  }
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db`
Expected: PASS — библиотека 49, `local_db` 16.

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc -- --nocapture forgetting`
Expected: PASS — 4 теста `forgetting_*`; в выводе нет `skipped: the permissions do not stop this user` (иначе тест прав не проверен — назвать в отчёте). Затем без фильтра: `ipc` 15 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/device.test.ts test/errors.test.ts test/app.test.tsx`
Expected: PASS — 3 файла; в `device.test.ts` 35 тестов; нет `stderr |`.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src-tauri/src/local_db.rs`: удалить четыре строки отката (`for (back, place) in moved.iter().rev() {`, комментарий `// Best effort: a file left aside is still kept, not lost.`, `let _ = std::fs::rename(place, back);`, `}`). Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`. Expected: FAIL — `a_file_that_cannot_be_set_aside_puts_the_others_back`.
2. Там же: `"SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",` → `"SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? AND ? <> ''",`. Та же команда. Expected: FAIL — `a_forget_refuses_while_unsent_records_remain`, `sent_records_and_other_pairings_do_not_stop_a_forget`.
3. `apps/standalone/src-tauri/src/lib.rs`: `(_, Err(_)) => UnsentGuard::AnyPairing,` → `(_, Err(_)) => UnsentGuard::Ignore,`. Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`. Expected: FAIL — `with_an_unreadable_pairing_any_unsent_record_stops_a_forget`.

- [ ] **Step 6: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/src/host/device.ts apps/standalone/test/device.test.ts apps/standalone/src/i18n/ru.json`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/host/device.ts apps/standalone/src/i18n/ru.json apps/standalone/test/device.test.ts
git commit -m "feat(standalone): a forget waits for unsent records, and an unreadable database is set aside, not deleted" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `set_system_awake` — не засыпать во время смены

**Files:**

- Create: `apps/standalone/src-tauri/src/power.rs`, `apps/standalone/src-tauri/src/power/windows.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs`, `tests/ipc.rs`

**Interfaces:**

- Consumes: ничего из других задач; на macOS и Linux — ни одного нового крейта (шаг владельца не нужен), на Windows — признаки `Win32_System_Power`, `Win32_System_Threading` задачи 1.
- Produces: `power::SystemAwakeState` (`Default`), `power::PowerError::RequestFailed` (код `"power_request_failed"`), команда `set_system_awake { awake: bool }`; `run` держит `SystemAwakeState`.

Порт облачного `power.rs`: одна аренда, двойной `true` берёт её один раз; отличие — `false` отпускает аренду и после отравленного мьютекса (облако отвечало ошибкой и держало компьютер бодрствующим), а отказ Windows не оставляет аренды, и следующий `true` пробует снова. `power/windows.rs` — облачный файл с комментариями `SAFETY` и своей строкой причины (её видно в `powercfg /requests`); он зависит только от `std` и `windows-sys`.

- [ ] **Step 1: Написать падающий тест IPC**

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{LocalDbState, TableClass, FILE_NAME, TABLE_CLASSES};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

заменить на:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{LocalDbState, TableClass, FILE_NAME, TABLE_CLASSES};
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        .manage(local)
        .manage(ConnectionState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
```

заменить на:

<!-- prettier-ignore -->
```rust
        .manage(local)
        .manage(ConnectionState::default())
        .manage(SystemAwakeState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// `set_system_awake` takes `awake` (`src/hardware/hardware.ts`) and answers
/// `null`, asked twice or not; letting go never fails. Off Windows it holds
/// nothing. On Windows this test asks for a real power request, which a CI
/// runner's session may refuse: then the answer must be the bare
/// `power_request_failed`, and letting go must still succeed.
#[test]
fn keeping_the_computer_awake_answers_through_the_ipc_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    let awake = |awake: bool| invoke(&webview, "set_system_awake", json!({ "awake": awake }));
    for _ in 0..2 {
        let answer = awake(true);
        if cfg!(windows) && answer.is_err() {
            assert_eq!(answer, Err(json!("power_request_failed")));
        } else {
            assert_eq!(answer, Ok(Value::Null));
        }
    }
    assert_eq!(awake(false), Ok(Value::Null));
    assert_eq!(awake(false), Ok(Value::Null));
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --no-run`
Expected: FAIL компиляции: `error[E0432]: unresolved import 'markiro_standalone_lib::power'`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src-tauri/src/power.rs`:

<!-- prettier-ignore -->
```rust
//! Keeping the computer awake during a shift (stage 2a spec §5.2, decision
//! 34), ported from the cloud station (`apps/station/src-tauri/src/power.rs`).
//! `set_system_awake(true)` holds one Windows power request — display and
//! system required — until `set_system_awake(false)`; off Windows it holds
//! nothing. The webview asks while an operator is in a shift's work screen
//! (plan 2a7). Letting go never fails: not even a poisoned lock keeps a PC
//! awake after its shift, and a refusal is the bare `power_request_failed`.

use std::sync::{Mutex, PoisonError};

#[cfg(windows)]
mod windows;

/// Why `set_system_awake(true)` failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerError {
    /// Windows refused the power request; the computer may sleep.
    RequestFailed,
}

impl PowerError {
    pub fn code(self) -> &'static str {
        match self {
            PowerError::RequestFailed => "power_request_failed",
        }
    }
}

/// Where a lease comes from: Windows' power requests, or a test's fake.
trait PowerRequestBackend {
    /// Held while awake; dropping it lets the computer sleep again.
    type Lease: Send;

    fn acquire(&self) -> Result<Self::Lease, String>;
}

struct PowerRequestState<B: PowerRequestBackend> {
    backend: B,
    lease: Mutex<Option<B::Lease>>,
}

impl<B: PowerRequestBackend> PowerRequestState<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            lease: Mutex::new(None),
        }
    }

    /// Holds exactly one lease while `awake`: asking twice acquires once, and
    /// `false` drops it, a poisoned lock included. A failed acquire leaves
    /// none, so the next `true` tries again.
    fn set_awake(&self, awake: bool) -> Result<(), PowerError> {
        let mut lease = self.lease.lock().unwrap_or_else(PoisonError::into_inner);
        if !awake {
            *lease = None;
            return Ok(());
        }
        if lease.is_none() {
            match self.backend.acquire() {
                Ok(acquired) => *lease = Some(acquired),
                Err(detail) => {
                    eprintln!("standalone: set_system_awake power_request_failed: {detail}");
                    return Err(PowerError::RequestFailed);
                }
            }
        }
        Ok(())
    }
}

struct PlatformBackend;

#[cfg(not(windows))]
impl PowerRequestBackend for PlatformBackend {
    type Lease = ();

    fn acquire(&self) -> Result<Self::Lease, String> {
        Ok(())
    }
}

#[cfg(windows)]
impl PowerRequestBackend for PlatformBackend {
    type Lease = windows::WindowsPowerRequest;

    fn acquire(&self) -> Result<Self::Lease, String> {
        windows::acquire()
    }
}

/// Tauri state: the power request this app holds, if any.
pub struct SystemAwakeState(PowerRequestState<PlatformBackend>);

impl Default for SystemAwakeState {
    fn default() -> Self {
        Self(PowerRequestState::new(PlatformBackend))
    }
}

#[tauri::command]
pub fn set_system_awake(
    state: tauri::State<'_, SystemAwakeState>,
    awake: bool,
) -> Result<(), String> {
    state
        .0
        .set_awake(awake)
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Counts acquired and released leases; `fail` makes the next acquires
    /// fail. Clones share the counters, so a test keeps one to read them.
    #[derive(Clone, Default)]
    struct Fake {
        acquired: Arc<AtomicUsize>,
        released: Arc<AtomicUsize>,
        fail: Arc<std::sync::atomic::AtomicBool>,
    }

    struct FakeLease(Arc<AtomicUsize>);

    impl Drop for FakeLease {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl PowerRequestBackend for Fake {
        type Lease = FakeLease;

        fn acquire(&self) -> Result<Self::Lease, String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("refused".to_owned());
            }
            self.acquired.fetch_add(1, Ordering::SeqCst);
            Ok(FakeLease(Arc::clone(&self.released)))
        }
    }

    fn counts(fake: &Fake) -> (usize, usize) {
        (
            fake.acquired.load(Ordering::SeqCst),
            fake.released.load(Ordering::SeqCst),
        )
    }

    #[test]
    fn a_shift_holds_exactly_one_request_until_it_ends() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);

        state.set_awake(true).unwrap();
        state.set_awake(true).unwrap();
        assert_eq!(counts(&probe), (1, 0));
        state.set_awake(false).unwrap();
        state.set_awake(false).unwrap();
        assert_eq!(counts(&probe), (1, 1));
    }

    #[test]
    fn a_refused_request_holds_nothing_and_the_next_one_tries_again() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);
        probe.fail.store(true, Ordering::SeqCst);

        assert_eq!(state.set_awake(true), Err(PowerError::RequestFailed));
        assert_eq!(state.set_awake(false), Ok(()));
        probe.fail.store(false, Ordering::SeqCst);
        assert_eq!(state.set_awake(true), Ok(()));
        assert_eq!(counts(&probe), (1, 0));
        assert_eq!(PowerError::RequestFailed.code(), "power_request_failed");
    }

    /// A thread that panicked holding the lock must not keep the computer
    /// awake after the shift: `false` still drops the lease.
    #[test]
    fn letting_go_works_even_after_a_poisoned_lock() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = Arc::new(PowerRequestState::new(fake));
        state.set_awake(true).unwrap();
        let poisoner = Arc::clone(&state);
        let panicked = std::thread::spawn(move || {
            let _held = poisoner.lease.lock().unwrap();
            panic!("a thread dies holding the lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(state.lease.is_poisoned());

        assert_eq!(state.set_awake(false), Ok(()));
        assert_eq!(counts(&probe), (1, 1));
        assert_eq!(state.set_awake(true), Ok(()));
        assert_eq!(counts(&probe), (2, 1));
    }
}
```

Создать `apps/standalone/src-tauri/src/power/windows.rs`:

<!-- prettier-ignore -->
```rust
//! The Windows power request behind `set_system_awake`, ported from the
//! cloud station (`apps/station/src-tauri/src/power/windows.rs`). This file
//! uses `std` and `windows-sys` only, so a probe crate can type-check it for
//! Windows on any computer (plan 2a4, task 8).

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    System::{
        Power::{
            PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
            PowerRequestSystemRequired, PowerSetRequest,
        },
        Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
    },
};

/// A held power request: the display and the system stay on until it drops.
pub struct WindowsPowerRequest {
    handle: OwnedHandle,
}

impl Drop for WindowsPowerRequest {
    fn drop(&mut self) {
        let handle = self.handle.as_raw_handle();
        // SAFETY: `handle` is the live request `acquire` created. These calls
        // balance its two `PowerSetRequest` calls; closing the owned handle
        // right after is the final cleanup even if Windows reports a failure.
        unsafe {
            let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
            let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
        }
    }
}

/// Creates the request and asks for the display and the system; the reason
/// shows in `powercfg /requests`. Errors carry the system's words for the
/// process log.
pub fn acquire() -> Result<WindowsPowerRequest, String> {
    let mut reason: Vec<u16> = "Markiro standalone: a production shift is open"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let context = REASON_CONTEXT {
        Version: 0,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    // SAFETY: `context` points at `reason`, alive for the call.
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "PowerCreateRequest: {}",
            std::io::Error::last_os_error()
        ));
    }
    let request = WindowsPowerRequest {
        // SAFETY: `PowerCreateRequest` returned a valid handle this process
        // owns; `OwnedHandle` closes it exactly once.
        handle: unsafe { OwnedHandle::from_raw_handle(handle) },
    };
    // SAFETY: `handle` is the live request above.
    if unsafe { PowerSetRequest(handle, PowerRequestDisplayRequired) } == 0 {
        return Err(format!(
            "PowerSetRequest(display): {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: as above.
    if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
        return Err(format!(
            "PowerSetRequest(system): {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(request)
}
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod local_db;
pub mod lockdown;
pub mod secret_store;
pub mod tls;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod local_db;
pub mod lockdown;
pub mod power;
pub mod secret_store;
pub mod tls;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        connection_status,
        lockdown::enter_lockdown,
        lockdown::exit_lockdown
    ]
}
```

заменить на:

<!-- prettier-ignore -->
```rust
        connection_status,
        lockdown::enter_lockdown,
        lockdown::exit_lockdown,
        power::set_system_awake
    ]
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        })
        .manage(lockdown::LockdownState::default())
        .on_window_event(lockdown::refuse_close_while_locked)
        .invoke_handler(invoke_handler())
```

заменить на:

<!-- prettier-ignore -->
```rust
        })
        .manage(lockdown::LockdownState::default())
        .manage(power::SystemAwakeState::default())
        .on_window_event(lockdown::refuse_close_while_locked)
        .invoke_handler(invoke_handler())
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: PASS — 52 теста (3 новых `power::tests`; тест отравленного мьютекса печатает в stderr панику своего потока — так и задумано).

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: PASS — 16 тестов.

Run: `git diff --stat apps/standalone/Cargo.lock apps/standalone/src-tauri/Cargo.toml`
Expected: пусто, если задача 1 ещё не сделана (задача 6 её не требует).

- [ ] **Step 5: Windows — крейт-пробник (вне песочницы; только при установленной цели `x86_64-pc-windows-msvc`)**

Пробник включает настоящий файл `power/windows.rs` через `#[path]` и проверяет его с признаками задачи 1 и `#![deny(warnings)]`. Создать каталог вне репозитория и проверить:

<!-- prettier-ignore -->
```bash
REPO="$(git rev-parse --show-toplevel)"
mkdir -p /tmp/claude/p2a4-probe
cat > /tmp/claude/p2a4-probe/Cargo.toml <<'TOML'
[package]
name = "p2a4-probe"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "lib.rs"

[dependencies]
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_Graphics_Printing",
  "Win32_Security",
  "Win32_Security_Cryptography",
  "Win32_System_Power",
  "Win32_System_Threading",
  "Win32_UI_WindowsAndMessaging",
] }

[workspace]
TOML
cat > /tmp/claude/p2a4-probe/lib.rs <<RS
//! Type-checks the shell's Windows-only files for x86_64-pc-windows-msvc
//! with the owner step's windows-sys features.
#![deny(warnings)]

#[path = "${REPO}/apps/standalone/src-tauri/src/power/windows.rs"]
pub mod power_windows;
RS
cp apps/standalone/Cargo.lock /tmp/claude/p2a4-probe/Cargo.lock
```

Run: `CARGO_TARGET_DIR=/tmp/claude/p2a4-probe/target cargo check --offline --manifest-path /tmp/claude/p2a4-probe/Cargo.toml --target x86_64-pc-windows-msvc`
Expected: `Finished`, без предупреждений. Мутация пробника: убрать строку `"Win32_System_Threading",` из `/tmp/claude/p2a4-probe/Cargo.toml` — та же команда падает с `error[E0432]: unresolved imports 'windows_sys::Win32::System::Power::PowerCreateRequest', 'windows_sys::Win32::System::Threading'`; вернуть строку. Пробник не коммитится; задача 7 пересоздаёт его со спулером. Сама оболочка под Windows здесь не собирается (`aws-lc-sys` требует `windows.h`) — только в `standalone-windows-build`.

- [ ] **Step 6: Мутации**

1. `apps/standalone/src-tauri/src/power.rs`: `let mut lease = self.lease.lock().unwrap_or_else(PoisonError::into_inner);` → `let mut lease = self.lease.lock().map_err(|_: PoisonError<_>| PowerError::RequestFailed)?;`. Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib power`. Expected: FAIL — `letting_go_works_even_after_a_poisoned_lock`.
2. Там же `        if lease.is_none() {` (перед `match self.backend.acquire()`) → `        if true {`. Та же команда. Expected: FAIL — `a_shift_holds_exactly_one_request_until_it_ends`.

- [ ] **Step 7: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`
Expected: чисто.

- [ ] **Step 8: Commit**

```bash
git add apps/standalone/src-tauri/src/power.rs apps/standalone/src-tauri/src/power/windows.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs
git commit -m "feat(standalone): set_system_awake keeps the computer awake, and letting go never fails" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Печать — `print_bytes`, спулер и `list_usb_printers`

**Files:**

- Create: `apps/standalone/src-tauri/src/printer.rs`, `apps/standalone/src-tauri/src/printer/spooler.rs`, `apps/standalone/src-tauri/tests/printer.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs`, `tests/ipc.rs`

**Interfaces:**

- Consumes: задача 1 (`base64`, `serialport` на всех ОС; признаки печати на Windows).
- Produces: `printer::PrintTarget` (`Serial { port, baud }`, `Tcp { host, port }`, `Usb { printer }`), `printer::PrintError` (`code()`: `not_sent`, `outcome_unknown`, `invalid_target`, `invalid_payload`, `unsupported`, `spooler_unavailable`), `printer::PrintFailure { error, detail }`, `printer::Timeouts { connect, write }` (`Default` — 5 с и 5 с), `printer::parse_target(Value) -> Result<PrintTarget, PrintError>`, `printer::decode_payload(&str) -> Result<Vec<u8>, PrintError>`, `printer::print_to(&PrintTarget, &[u8], Timeouts) -> Result<(), PrintFailure>`, `printer::UsbPrinter { name, port }`, `printer::prioritize_installed_printers`; команды `print_bytes { target, payloadBase64 }` и `list_usb_printers`.

Отличия от облачного `printer.rs`: голые коды вместо текста ошибки, граница `not_sent`/`outcome_unknown` по первой записи (облако различий не делало), проверка цели (пустые имена, пробелы и управляющие символы в адресе, порт 0, скорость 0), пустая полезная нагрузка — `invalid_payload`, упавший поток отправки — `outcome_unknown`, сбои `EndPagePrinter`/`EndDocPrinter` учитываются, а отказ `EnumPrintersW` — `spooler_unavailable`, не пустой список. `printer/spooler.rs` зависит только от `std` и `windows-sys` и проверяется пробником. Заглушки TCP в `tests/printer.rs`: принтер, который принимает всё; порт, где никто не слушает; принтер, который читает 1 КиБ и закрывает соединение (его сторона сбрасывает соединение с непрочитанными данными); принтер, который перестаёт читать (запись упирается в тайм-аут 200 мс). Каждая отправка идёт на своём потоке и ждётся не дольше 10 с.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/src-tauri/tests/printer.rs`:

<!-- prettier-ignore -->
```rust
//! `print_to` against stub printers (stage 2a spec §5.2, §7): a TCP printer
//! on 127.0.0.1 that takes the whole label, one that is not there, one that
//! cuts the connection in the middle of a label and one that stops reading.
//! Each send runs on its own thread and is awaited with a deadline, so a send
//! that hangs fails its test instead of hanging the suite. The stubs listen
//! on loopback, so the suite runs outside the agents' sandbox. A COM printer
//! has no stub here: macOS refuses a serial port's settings on a
//! pseudo-terminal (`ENOTTY`), so the COM path is checked by hand with a real
//! printer or a com0com pair on Windows.

use std::io::Read;
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use markiro_standalone_lib::printer::{print_to, PrintError, PrintFailure, PrintTarget, Timeouts};

/// Longer than any send here should take, short enough to fail fast.
const DEADLINE: Duration = Duration::from_secs(10);

/// A label of `len` bytes that are not all ASCII: ZPL's text plus the bytes
/// above 0x7F and the GS1 group separator that a TSPL bitmap or a DataMatrix
/// carry.
fn label(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| match index % 4 {
            0 => b'^',
            1 => 0x1D,
            2 => 0xA4,
            _ => (index % 251) as u8,
        })
        .collect()
}

/// Runs `print_to` on its own thread and waits at most `DEADLINE` for it.
fn send(target: PrintTarget, bytes: Vec<u8>, timeouts: Timeouts) -> Result<(), PrintFailure> {
    let (done, outcome) = mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(print_to(&target, &bytes, timeouts));
    });
    outcome
        .recv_timeout(DEADLINE)
        .expect("the send ended within its deadline")
}

fn tcp(port: u16) -> PrintTarget {
    PrintTarget::Tcp {
        host: "127.0.0.1".into(),
        port,
    }
}

#[test]
fn a_network_printer_receives_the_exact_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        received.send(bytes).unwrap();
    });
    let bytes = label(64 * 1024);

    assert!(send(tcp(port), bytes.clone(), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), bytes);
}

#[test]
fn a_printer_that_is_not_listening_is_not_sent() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let failure = send(tcp(port), label(16), Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("connect"), "{}", failure.detail);
}

/// The printer reads the first kilobyte and closes the connection with the
/// rest still unread, which makes its side reset it: the label may be half
/// printed, so the send is `outcome_unknown`, never `not_sent`.
#[test]
fn a_connection_cut_in_the_middle_of_a_label_is_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut first = [0u8; 1024];
        stream.read_exact(&mut first).unwrap();
        drop(stream);
    });

    let failure = send(tcp(port), label(64 * 1024 * 1024), Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(failure.detail.starts_with("write"), "{}", failure.detail);
}

/// A printer that accepts the connection and stops reading (out of paper,
/// its buffer full): once the system's buffers fill up, the write times out,
/// and the label may or may not print later.
#[test]
fn a_printer_that_stops_reading_is_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, hold) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        // Hold the connection, unread, until the test ends.
        accepted.send(stream).unwrap();
    });
    let timeouts = Timeouts {
        connect: Duration::from_secs(5),
        write: Duration::from_millis(200),
    };

    let failure = send(tcp(port), label(64 * 1024 * 1024), timeouts).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(failure.detail.starts_with("write"), "{}", failure.detail);
    drop(hold.recv_timeout(DEADLINE).unwrap());
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент:

<!-- prettier-ignore -->
```rust
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// `print_bytes` takes `target` and `payloadBase64` (`src/hardware/hardware.ts`)
/// and answers `null` or a bare code; `list_usb_printers` takes nothing. A
/// stub printer on 127.0.0.1 takes the label.
#[test]
fn printing_answers_through_the_ipc_shapes() {
    use std::io::Read;
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        received.send(bytes).unwrap();
    });
    let tcp = |port: u16| json!({ "kind": "tcp", "host": "127.0.0.1", "port": port });
    let print = |target: Value, payload: &str| {
        invoke(
            &webview,
            "print_bytes",
            json!({ "target": target, "payloadBase64": payload }),
        )
    };

    assert_eq!(print(tcp(port), "XlhBpB0="), Ok(Value::Null));
    assert_eq!(
        printed
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap(),
        [0x5E, 0x58, 0x41, 0xA4, 0x1D]
    );
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    assert_eq!(print(tcp(closed_port), "XlhB"), Err(json!("not_sent")));
    assert_eq!(
        print(json!({ "kind": "lpt", "port": "LPT1" }), "XlhB"),
        Err(json!("invalid_target"))
    );
    assert_eq!(print(tcp(port), ""), Err(json!("invalid_payload")));
    #[cfg(not(windows))]
    {
        assert_eq!(
            print(json!({ "kind": "usb", "printer": "Zebra ZD421" }), "XlhB"),
            Err(json!("unsupported"))
        );
        assert_eq!(
            invoke(&webview, "list_usb_printers", json!({})),
            Ok(json!([]))
        );
    }
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test printer --no-run`
Expected: FAIL компиляции: `error[E0432]: unresolved import 'markiro_standalone_lib::printer'`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src-tauri/src/printer/spooler.rs`:

<!-- prettier-ignore -->
```rust
//! The Windows print spooler (stage 2a spec §5.2): the installed queues and
//! RAW printing, ported from the cloud station's `spooler` module
//! (`apps/station/src-tauri/src/printer.rs`). This file uses `std` and
//! `windows-sys` only, so a probe crate can type-check it for Windows on any
//! computer (plan 2a4, task 6). Everything unsafe stays here.

use windows_sys::Win32::Graphics::Printing::{
    ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
    StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_HANDLE, PRINTER_INFO_2W,
};

/// How far a RAW job got before it failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// No byte reached the spooler: `OpenPrinterW` or `StartDocPrinterW`
    /// refused.
    NotSent,
    /// The document had started: the label may be in the queue.
    OutcomeUnknown,
}

/// A failed spooler call: how far the job got, and the system's own words
/// for the process log (never for IPC).
#[derive(Debug)]
pub struct SpoolerError {
    pub stage: Stage,
    pub detail: String,
}

/// The error of the call that just failed; read before any other call.
fn last_error(stage: Stage, call: &str) -> SpoolerError {
    SpoolerError {
        stage,
        detail: format!("{call}: {}", std::io::Error::last_os_error()),
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// # Safety
///
/// `ptr` is null or points at a NUL-terminated UTF-16 string.
unsafe fn from_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// Installed local queues and the user's printer connections as (queue
/// name, port name). The first `EnumPrintersW` call measures the buffer; any
/// failure but "buffer too small" (the spooler service stopped) is an error,
/// never an empty list, so an operator restarts the service instead of
/// chasing a USB cable.
pub fn installed_printers() -> Result<Vec<(String, String)>, String> {
    const ERROR_INSUFFICIENT_BUFFER: i32 = 122;
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0u32;
    let mut returned = 0u32;
    // SAFETY: a null buffer of size 0 asks only for the size needed.
    let sized = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            2,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        )
    } != 0;
    if !sized && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER) {
        return Err(last_error(Stage::NotSent, "EnumPrintersW").detail);
    }
    if needed == 0 {
        return Ok(Vec::new());
    }
    // `u64` storage: `PRINTER_INFO_2W` holds pointers and needs 8-byte
    // alignment, which a `Vec<u8>` does not guarantee.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `needed` bytes.
    let listed = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            2,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
            &mut returned,
        )
    } != 0;
    if !listed {
        return Err(last_error(Stage::NotSent, "EnumPrintersW").detail);
    }
    // SAFETY: the spooler wrote `returned` PRINTER_INFO_2W records at the
    // start of `buffer`, whose strings point into `buffer` itself.
    let infos = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_2W>(), returned as usize)
    };
    Ok(infos
        .iter()
        // SAFETY: the record's strings are NUL-terminated or null.
        .map(|info| unsafe { (from_wide(info.pPrinterName), from_wide(info.pPortName)) })
        .collect())
}

/// Sends raw ZPL/TSPL bytes to the queue `printer` with datatype RAW, so the
/// driver renders nothing and the printer's firmware reads its own language.
/// The handle is closed on every path; `EndPagePrinter` and `EndDocPrinter`
/// failures count, since they may leave the job half-spooled.
pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), SpoolerError> {
    let Ok(len) = u32::try_from(bytes.len()) else {
        return Err(SpoolerError {
            stage: Stage::NotSent,
            detail: "the label is larger than 4 GiB".to_owned(),
        });
    };
    let printer_w = wide(printer);
    let doc_name = wide("Markiro label");
    let datatype = wide("RAW");
    let mut handle = PRINTER_HANDLE::default();
    // SAFETY: `printer_w` is NUL-terminated; `handle` receives the queue.
    if unsafe { OpenPrinterW(printer_w.as_ptr(), &mut handle, std::ptr::null_mut()) } == 0 {
        return Err(last_error(Stage::NotSent, "OpenPrinterW"));
    }
    let doc = DOC_INFO_1W {
        pDocName: doc_name.as_ptr() as *mut u16,
        pOutputFile: std::ptr::null_mut(),
        pDatatype: datatype.as_ptr() as *mut u16,
    };
    // SAFETY: `handle` is the open queue; `doc` points at live strings.
    let result = unsafe {
        if StartDocPrinterW(handle, 1, &doc) == 0 {
            Err(last_error(Stage::NotSent, "StartDocPrinterW"))
        } else {
            let page = print_page(handle, bytes, len);
            if EndDocPrinter(handle) == 0 && page.is_ok() {
                Err(last_error(Stage::OutcomeUnknown, "EndDocPrinter"))
            } else {
                page
            }
        }
    };
    // SAFETY: closes the handle `OpenPrinterW` opened, exactly once.
    unsafe { ClosePrinter(handle) };
    result
}

/// # Safety
///
/// `handle` is an open queue with a started document.
unsafe fn print_page(handle: PRINTER_HANDLE, bytes: &[u8], len: u32) -> Result<(), SpoolerError> {
    if StartPagePrinter(handle) == 0 {
        return Err(last_error(Stage::OutcomeUnknown, "StartPagePrinter"));
    }
    let mut written = 0u32;
    let write = if WritePrinter(handle, bytes.as_ptr().cast(), len, &mut written) == 0 {
        Err(last_error(Stage::OutcomeUnknown, "WritePrinter"))
    } else if written != len {
        Err(SpoolerError {
            stage: Stage::OutcomeUnknown,
            detail: format!("WritePrinter wrote {written} of {len} bytes"),
        })
    } else {
        Ok(())
    };
    if EndPagePrinter(handle) == 0 && write.is_ok() {
        return Err(last_error(Stage::OutcomeUnknown, "EndPagePrinter"));
    }
    write
}
```

Создать `apps/standalone/src-tauri/src/printer.rs`:

<!-- prettier-ignore -->
```rust
//! Label printing (stage 2a spec §5.2, decision 20), ported from the cloud
//! station's `print_bytes` and `list_usb_printers`
//! (`apps/station/src-tauri/src/printer.rs`). Raw ZPL/TSPL bytes go to a
//! network printer (TCP, port 9100 as a rule), a COM port, or — on Windows
//! only — a spooler queue with datatype RAW (`printer/spooler.rs`).
//!
//! Refusals are bare codes that tell the webview what it may do next:
//! `not_sent` — no byte left this computer (the address did not resolve, or
//! the connection, the port or the queue did not open), so printing again
//! cannot double a label; `outcome_unknown` — the failure came after the
//! first write began, so the label may or may not exist, and only the
//! operator decides (plan 2a7 never resends by itself); `invalid_target` and
//! `invalid_payload` — the webview sent something unusable; `unsupported` —
//! a USB queue off Windows. The system's own error text never crosses IPC: it
//! goes to the process's stderr after the command's name and the code.

use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(windows)]
mod spooler;

/// Where the label bytes go, as `src/hardware/hardware.ts` sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrintTarget {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
    Usb { printer: String },
}

/// Why `print_bytes` (or `list_usb_printers`) failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrintError {
    /// Nothing was sent; printing again cannot double the label.
    NotSent,
    /// The failure came after the first write began.
    OutcomeUnknown,
    /// The target is not one of the three kinds, or its fields are unusable.
    InvalidTarget,
    /// The payload is not base64, or it is empty.
    InvalidPayload,
    /// A USB queue off Windows.
    Unsupported,
    /// The Windows spooler did not list its queues (`list_usb_printers`).
    SpoolerUnavailable,
}

impl PrintError {
    /// Stable codes the webview reads (`src/hardware/hardware.ts`).
    pub fn code(self) -> &'static str {
        match self {
            PrintError::NotSent => "not_sent",
            PrintError::OutcomeUnknown => "outcome_unknown",
            PrintError::InvalidTarget => "invalid_target",
            PrintError::InvalidPayload => "invalid_payload",
            PrintError::Unsupported => "unsupported",
            PrintError::SpoolerUnavailable => "spooler_unavailable",
        }
    }
}

/// A failed send: the code, and the system's words for the process log.
#[derive(Debug)]
pub struct PrintFailure {
    pub error: PrintError,
    pub detail: String,
}

impl PrintFailure {
    fn new(error: PrintError, detail: impl std::fmt::Display) -> Self {
        Self {
            error,
            detail: detail.to_string(),
        }
    }
}

/// How long a send may wait: for the connection (TCP) and for each write
/// (TCP and COM). The cloud station's 5 s each; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub write: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(5),
            write: Duration::from_secs(5),
        }
    }
}

/// The target the webview sent, checked: a host without spaces or control
/// characters and a port other than 0; a port name and a baud rate other
/// than 0; a queue name. The webview's arguments arrive as JSON, so a shape
/// that is none of the three is `invalid_target` too, not Tauri's own text.
pub fn parse_target(value: Value) -> Result<PrintTarget, PrintError> {
    let target: PrintTarget =
        serde_json::from_value(value).map_err(|_| PrintError::InvalidTarget)?;
    let plain = |text: &str, max: usize| {
        !text.trim().is_empty()
            && text.chars().count() <= max
            && !text.chars().any(char::is_control)
    };
    let usable = match &target {
        PrintTarget::Serial { port, baud } => plain(port, 256) && *baud > 0,
        PrintTarget::Tcp { host, port } => {
            plain(host, 253) && !host.chars().any(char::is_whitespace) && *port > 0
        }
        PrintTarget::Usb { printer } => plain(printer, 256),
    };
    if usable {
        Ok(target)
    } else {
        Err(PrintError::InvalidTarget)
    }
}

/// Tauri's IPC is JSON, so the label's bytes arrive base64-encoded; an empty
/// label is refused, not sent as nothing.
pub fn decode_payload(payload_base64: &str) -> Result<Vec<u8>, PrintError> {
    match STANDARD.decode(payload_base64) {
        Ok(bytes) if !bytes.is_empty() => Ok(bytes),
        _ => Err(PrintError::InvalidPayload),
    }
}

/// `host:port` to one socket address; a name that resolves to nothing is
/// `not_sent` at once, instead of after the operating system's long wait.
fn resolve(host: &str, port: u16) -> Result<SocketAddr, PrintFailure> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| PrintFailure::new(PrintError::NotSent, format!("resolve: {error}")))?
        .next()
        .ok_or_else(|| PrintFailure::new(PrintError::NotSent, "resolve: no address"))
}

/// Sends `bytes` to `target`, blocking. Everything up to and including
/// opening the connection, the port or the queue is `not_sent`; from the
/// first write on, a failure is `outcome_unknown`.
pub fn print_to(
    target: &PrintTarget,
    bytes: &[u8],
    timeouts: Timeouts,
) -> Result<(), PrintFailure> {
    let unknown = |call: &str, error: std::io::Error| {
        PrintFailure::new(PrintError::OutcomeUnknown, format!("{call}: {error}"))
    };
    match target {
        PrintTarget::Tcp { host, port } => {
            let address = resolve(host, *port)?;
            let mut stream =
                TcpStream::connect_timeout(&address, timeouts.connect).map_err(|error| {
                    PrintFailure::new(PrintError::NotSent, format!("connect: {error}"))
                })?;
            stream
                .set_write_timeout(Some(timeouts.write))
                .map_err(|error| {
                    PrintFailure::new(PrintError::NotSent, format!("timeout: {error}"))
                })?;
            stream
                .write_all(bytes)
                .map_err(|error| unknown("write", error))?;
            stream.flush().map_err(|error| unknown("flush", error))
        }
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(port, *baud)
                .timeout(timeouts.write)
                .open()
                .map_err(|error| {
                    PrintFailure::new(PrintError::NotSent, format!("open: {error}"))
                })?;
            handle
                .write_all(bytes)
                .map_err(|error| unknown("write", error))?;
            handle.flush().map_err(|error| unknown("flush", error))
        }
        PrintTarget::Usb { printer } => print_usb(printer, bytes),
    }
}

#[cfg(windows)]
fn print_usb(printer: &str, bytes: &[u8]) -> Result<(), PrintFailure> {
    spooler::print_raw(printer, bytes).map_err(|failure| {
        let error = match failure.stage {
            spooler::Stage::NotSent => PrintError::NotSent,
            spooler::Stage::OutcomeUnknown => PrintError::OutcomeUnknown,
        };
        PrintFailure::new(error, failure.detail)
    })
}

#[cfg(not(windows))]
fn print_usb(_printer: &str, _bytes: &[u8]) -> Result<(), PrintFailure> {
    Err(PrintFailure::new(
        PrintError::Unsupported,
        "USB printing goes through the Windows spooler",
    ))
}

/// Sends the label's bytes (`payloadBase64`) to `target`. Blocking work —
/// name resolution, the connection, the COM port, the spooler — runs on a
/// thread for blocking work, never on the IPC thread, so a wrong printer
/// address cannot freeze the window while the system gives up. The webview
/// sends one label at a time per address (plan 2a7).
#[tauri::command]
pub async fn print_bytes(target: Value, payload_base64: String) -> Result<(), String> {
    let target = parse_target(target).map_err(|error| error.code().to_owned())?;
    let bytes = decode_payload(&payload_base64).map_err(|error| error.code().to_owned())?;
    let sent = tauri::async_runtime::spawn_blocking(move || {
        print_to(&target, &bytes, Timeouts::default())
    })
    .await;
    let failure = match sent {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(failure)) => failure,
        // The send thread died, perhaps mid-write: nobody knows what printed.
        Err(_) => PrintFailure::new(PrintError::OutcomeUnknown, "the send thread failed"),
    };
    eprintln!(
        "standalone: print_bytes {}: {}",
        failure.error.code(),
        failure.detail
    );
    Err(failure.error.code().to_owned())
}

/// One installed Windows printer queue: the spooler's queue name (stable
/// across replugging) and its port, shown for the operator's sake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinter {
    pub name: String,
    pub port: String,
}

/// Every installed queue, queues on `USB…` ports first: vendor drivers need
/// not name a USB connection that way, so none is dropped.
pub fn prioritize_installed_printers(printers: Vec<(String, String)>) -> Vec<UsbPrinter> {
    let mut printers = printers;
    printers.sort_by_key(|(_, port)| !port.to_ascii_uppercase().starts_with("USB"));
    printers
        .into_iter()
        .map(|(name, port)| UsbPrinter { name, port })
        .collect()
}

/// The installed queues; always empty off Windows. A spooler that does not
/// answer is `spooler_unavailable`, never an empty list.
#[tauri::command]
pub async fn list_usb_printers() -> Result<Vec<UsbPrinter>, String> {
    let listed = tauri::async_runtime::spawn_blocking(installed_printers)
        .await
        .map_err(|_| PrintError::SpoolerUnavailable.code().to_owned())?;
    listed.map(prioritize_installed_printers).map_err(|detail| {
        eprintln!("standalone: list_usb_printers spooler_unavailable: {detail}");
        PrintError::SpoolerUnavailable.code().to_owned()
    })
}

#[cfg(windows)]
fn installed_printers() -> Result<Vec<(String, String)>, String> {
    spooler::installed_printers()
}

#[cfg(not(windows))]
fn installed_printers() -> Result<Vec<(String, String)>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_three_kinds_of_target_parse_as_the_webview_sends_them() {
        assert_eq!(
            parse_target(json!({ "kind": "tcp", "host": "192.168.1.50", "port": 9100 })),
            Ok(PrintTarget::Tcp {
                host: "192.168.1.50".into(),
                port: 9100
            })
        );
        assert_eq!(
            parse_target(json!({ "kind": "serial", "port": "COM3", "baud": 9600 })),
            Ok(PrintTarget::Serial {
                port: "COM3".into(),
                baud: 9600
            })
        );
        assert_eq!(
            parse_target(json!({ "kind": "usb", "printer": "Zebra ZD421" })),
            Ok(PrintTarget::Usb {
                printer: "Zebra ZD421".into()
            })
        );
    }

    #[test]
    fn an_unusable_target_is_invalid() {
        for value in [
            json!(null),
            json!("tcp"),
            json!({ "kind": "lpt", "port": "LPT1" }),
            json!({ "kind": "tcp", "host": "printer" }),
            json!({ "kind": "tcp", "host": "", "port": 9100 }),
            json!({ "kind": "tcp", "host": "two words", "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer\n", "port": 9100 }),
            json!({ "kind": "tcp", "host": "a".repeat(254), "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer", "port": 0 }),
            json!({ "kind": "tcp", "host": "printer", "port": 65536 }),
            json!({ "kind": "serial", "port": " ", "baud": 9600 }),
            json!({ "kind": "serial", "port": "COM3", "baud": 0 }),
            json!({ "kind": "serial", "port": "COM\u{0}3", "baud": 9600 }),
            json!({ "kind": "usb", "printer": "" }),
            json!({ "kind": "usb", "printer": "Zebra\tZD421" }),
        ] {
            assert_eq!(
                parse_target(value.clone()),
                Err(PrintError::InvalidTarget),
                "{value}"
            );
        }
    }

    #[test]
    fn the_payload_decodes_to_the_exact_bytes() {
        // "^XA", a byte above 0x7F and the GS1 group separator survive.
        assert_eq!(
            decode_payload("XlhBpB0="),
            Ok(vec![0x5E, 0x58, 0x41, 0xA4, 0x1D])
        );
        for payload in ["", "not base64!!", "XlhB pA=="] {
            assert_eq!(
                decode_payload(payload),
                Err(PrintError::InvalidPayload),
                "{payload:?}"
            );
        }
    }

    #[test]
    fn refusals_are_bare_codes() {
        let codes: Vec<&str> = [
            PrintError::NotSent,
            PrintError::OutcomeUnknown,
            PrintError::InvalidTarget,
            PrintError::InvalidPayload,
            PrintError::Unsupported,
            PrintError::SpoolerUnavailable,
        ]
        .into_iter()
        .map(PrintError::code)
        .collect();
        assert_eq!(
            codes,
            [
                "not_sent",
                "outcome_unknown",
                "invalid_target",
                "invalid_payload",
                "unsupported",
                "spooler_unavailable"
            ]
        );
    }

    #[test]
    fn installed_queues_keep_every_queue_with_usb_ports_first() {
        let pairs: Vec<(String, String)> = prioritize_installed_printers(vec![
            ("Zebra ZD421".into(), "USB001".into()),
            ("Office Laser".into(), "192.168.0.20".into()),
            ("TSC TE200".into(), "usb002".into()),
            ("Microsoft Print to PDF".into(), "PORTPROMPT:".into()),
        ])
        .into_iter()
        .map(|printer| (printer.name, printer.port))
        .collect();
        assert_eq!(
            pairs,
            [
                ("Zebra ZD421".to_owned(), "USB001".to_owned()),
                ("TSC TE200".to_owned(), "usb002".to_owned()),
                ("Office Laser".to_owned(), "192.168.0.20".to_owned()),
                (
                    "Microsoft Print to PDF".to_owned(),
                    "PORTPROMPT:".to_owned()
                ),
            ]
        );
        assert!(prioritize_installed_printers(Vec::new()).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_usb_queue_is_unsupported_and_none_is_installed() {
        let target = PrintTarget::Usb {
            printer: "Zebra ZD421".into(),
        };
        let failure = print_to(&target, b"^XA^XZ", Timeouts::default()).unwrap_err();
        assert_eq!(failure.error, PrintError::Unsupported);
        assert_eq!(installed_printers(), Ok(Vec::new()));
    }

    #[test]
    fn a_name_that_resolves_to_nothing_is_not_sent() {
        // `.invalid` never resolves (RFC 2606): no network is needed.
        let target = PrintTarget::Tcp {
            host: "printer.invalid".into(),
            port: 9100,
        };
        let failure = print_to(&target, b"^XA^XZ", Timeouts::default()).unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("resolve"), "{}", failure.detail);
    }

    #[test]
    fn a_com_port_that_does_not_open_is_not_sent() {
        let target = PrintTarget::Serial {
            port: "/dev/markiro-no-such-port".into(),
            baud: 9600,
        };
        let failure = print_to(&target, b"^XA^XZ", Timeouts::default()).unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("open"), "{}", failure.detail);
    }
}
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod lockdown;
pub mod power;
pub mod secret_store;
pub mod tls;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod lockdown;
pub mod power;
pub mod printer;
pub mod secret_store;
pub mod tls;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        lockdown::enter_lockdown,
        lockdown::exit_lockdown,
        power::set_system_awake
    ]
}
```

заменить на:

<!-- prettier-ignore -->
```rust
        lockdown::enter_lockdown,
        lockdown::exit_lockdown,
        power::set_system_awake,
        printer::print_bytes,
        printer::list_usb_printers
    ]
}
```

- [ ] **Step 4: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: PASS — 60 тестов (8 новых `printer::tests`).

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test printer --test ipc`
Expected: PASS — `printer` 4 теста (около 1 с), `ipc` 17. Затем ещё четыре прогона `--test printer` подряд — все PASS (заглушки не флейкуют: на копии плана шесть прогонов подряд прошли за 1,0–1,2 с).

- [ ] **Step 5: Windows — пробник (вне песочницы; только при установленной цели)**

Пробник задачи 6 получает `serialport` и файл спулера (создаётся заново целиком, так что задача 6 для этого шага не нужна):

<!-- prettier-ignore -->
```bash
REPO="$(git rev-parse --show-toplevel)"
mkdir -p /tmp/claude/p2a4-probe
cat > /tmp/claude/p2a4-probe/Cargo.toml <<'TOML'
[package]
name = "p2a4-probe"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "lib.rs"

[dependencies]
serialport = "=4.9.0"
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_Graphics_Printing",
  "Win32_Security",
  "Win32_Security_Cryptography",
  "Win32_System_Power",
  "Win32_System_Threading",
  "Win32_UI_WindowsAndMessaging",
] }

[workspace]
TOML
cat > /tmp/claude/p2a4-probe/lib.rs <<RS
//! Type-checks the shell's Windows-only files for x86_64-pc-windows-msvc
//! with the owner step's windows-sys features, and serialport for Windows.
#![deny(warnings)]

#[path = "${REPO}/apps/standalone/src-tauri/src/power/windows.rs"]
pub mod power_windows;

#[path = "${REPO}/apps/standalone/src-tauri/src/printer/spooler.rs"]
pub mod spooler;

pub fn serial_opens(port: &str) -> bool {
    serialport::new(port, 9600).open().is_ok()
}
RS
cp apps/standalone/Cargo.lock /tmp/claude/p2a4-probe/Cargo.lock
```

Run: `CARGO_TARGET_DIR=/tmp/claude/p2a4-probe/target cargo check --offline --manifest-path /tmp/claude/p2a4-probe/Cargo.toml --target x86_64-pc-windows-msvc`
Expected: `Finished`, без предупреждений (собираются `windows-sys 0.52.0` и `serialport 4.9.0` для Windows). Мутация пробника: убрать `"Win32_Graphics_Gdi",` — FAIL `error[E0432]: unresolved imports 'windows_sys::Win32::Graphics::Printing::OpenPrinterW', 'windows_sys::Win32::Graphics::Printing::PRINTER_INFO_2W'`; вернуть строку.

- [ ] **Step 6: Мутации**

1. `apps/standalone/src-tauri/src/printer.rs`: в замыкании `unknown` — `PrintFailure::new(PrintError::OutcomeUnknown, format!("{call}: {error}"))` → `PrintFailure::new(PrintError::NotSent, format!("{call}: {error}"))`. Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test printer`. Expected: FAIL — `a_connection_cut_in_the_middle_of_a_label_is_outcome_unknown`, `a_printer_that_stops_reading_is_outcome_unknown`.
2. Там же удалить вызов `stream.set_write_timeout(...)` целиком (пять строк от `stream` до `})?;`). Та же команда. Expected: FAIL через 10 с — `a_printer_that_stops_reading_is_outcome_unknown` с `the send ended within its deadline: Timeout`: запись висит, а тест падает по сроку, не зависает.

- [ ] **Step 7: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`
Expected: чисто.

- [ ] **Step 8: Commit**

```bash
git add apps/standalone/src-tauri/src/printer.rs apps/standalone/src-tauri/src/printer/spooler.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/printer.rs apps/standalone/src-tauri/tests/ipc.rs
git commit -m "feat(standalone): print_bytes tells not_sent from outcome_unknown, with the Windows spooler for USB queues" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: COM-сканеры — среда, команды и события

**Files:**

- Create (копией облачных файлов с правками): `apps/standalone/src-tauri/src/scanner/runtime.rs`, `apps/standalone/src-tauri/src/scanner/runtime_tests.rs`
- Create: `apps/standalone/src-tauri/src/scanner.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs`, `tests/ipc.rs`

**Interfaces:**

- Consumes: задача 1 (`serialport`).
- Produces: `scanner::{ScannerManager, ScannerConfig, ScannerSnapshot, ScannerConnection, ConnectionStatus, ScannerEvent, EventSink, PortOpener}`, `scanner::ScannerError` (`code()`: `invalid_scanners`, `serial_unavailable`), `ScannerManager::configure(Vec<ScannerConfig>) -> Result<(), ScannerError>`, `scanner::{SCAN_EVENT, SCANNER_STATUS_EVENT, RETRY}`, `scanner::{serial_opener, tauri_sink, manager}`; команды `list_serial_ports`, `configure_scanners { scanners }`, `get_scanner_connections`, `close_scanners`; `run` держит `scanner::manager(app.handle().clone())`.

Среда — облачная почти без изменений (её тесты приняты на Windows): правки — заголовок модуля, `ScannerError` вместо строк, одна проверка на имя порта и скорость. Тест IPC строит менеджер с поддельным `COM3` (чтение ждёт не дольше 10 мс, как тайм-аут настоящего порта) и `tauri_sink` mock-приложения и слушает оба события через `Listener`; ждёт подключения опросом с пределом 3 с. Конструктор mock-приложения `setup` не вызывает, поэтому менеджер ставится после `build`. `list_serial_ports` в песочнице и без доступа к перечислению портов отвечает `serial_unavailable` — тест принимает массив или этот код.

- [ ] **Step 1: Написать падающий тест IPC**

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::local_db::{LocalDbState, TableClass, FILE_NAME, TABLE_CLASSES};
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

заменить на:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::local_db::{LocalDbState, TableClass, FILE_NAME, TABLE_CLASSES};
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::scanner::{self, PortOpener, ScannerManager};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// A fake COM port: the test pushes bytes, the shell's scanner thread reads
/// them. A read waits at most 10 ms, as a real port's timeout does, so a
/// closed configuration stops its thread at once.
struct FakePort(std::sync::mpsc::Receiver<Vec<u8>>);

impl std::io::Read for FakePort {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::sync::mpsc::RecvTimeoutError;
        match self.0.recv_timeout(std::time::Duration::from_millis(10)) {
            Ok(bytes) => {
                buf[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            }
            Err(RecvTimeoutError::Timeout) => Err(std::io::ErrorKind::TimedOut.into()),
            Err(RecvTimeoutError::Disconnected) => Err(std::io::ErrorKind::BrokenPipe.into()),
        }
    }
}

/// Polls `check` until it holds, for at most 3 s.
fn wait_for(what: &str, check: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// The scanner commands with the webview's arguments (`scanners` of
/// `{ port, baud }`), and the events `standalone://scan` and
/// `standalone://scanner-status` as the webview hears them, from a fake
/// `COM3` behind the shell's real scanner runtime.
#[test]
fn scanners_answer_through_the_ipc_shapes() {
    use std::sync::{mpsc, Arc, Mutex};
    use tauri::{Listener, Manager};

    let dir = tempfile::tempdir().unwrap();
    let (bytes, port) = mpsc::channel::<Vec<u8>>();
    let port = Arc::new(Mutex::new(Some(port)));
    let opener: PortOpener = Arc::new(move |config| {
        let taken = (config.port == "COM3")
            .then(|| port.lock().unwrap().take())
            .flatten();
        match taken {
            Some(port) => Ok(Box::new(FakePort(port)) as Box<dyn std::io::Read + Send>),
            None => Err(std::io::ErrorKind::NotFound.into()),
        }
    });
    let app = mock_builder()
        .manage(DeviceState::load(dir.path().to_path_buf()))
        .manage(LocalDbState::unavailable())
        .manage(ConnectionState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    // The mock builder does not run `setup`, so the manager, which needs the
    // app's handle for its events, is managed once the app exists.
    let sink = scanner::tauri_sink(app.handle().clone());
    app.manage(ScannerManager::new(
        opener,
        sink,
        std::time::Duration::from_millis(20),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // The names `src/hardware/hardware.ts` listens to.
    assert_eq!(scanner::SCAN_EVENT, "standalone://scan");
    assert_eq!(scanner::SCANNER_STATUS_EVENT, "standalone://scanner-status");
    let (scan_tx, scans) = mpsc::channel::<String>();
    app.listen(scanner::SCAN_EVENT, move |event| {
        let _ = scan_tx.send(event.payload().to_owned());
    });
    let (status_tx, statuses) = mpsc::channel::<String>();
    app.listen(scanner::SCANNER_STATUS_EVENT, move |event| {
        let _ = status_tx.send(event.payload().to_owned());
    });
    let connections = || invoke(&webview, "get_scanner_connections", json!({})).unwrap();

    assert_eq!(
        invoke(
            &webview,
            "configure_scanners",
            json!({ "scanners": [{ "port": "com3", "baud": 9600 }] })
        ),
        Ok(Value::Null)
    );
    wait_for("COM3 connects", || {
        connections()["scanners"][0]["status"] == "connected"
    });
    let snapshot = connections();
    assert!(snapshot["revision"].as_u64().unwrap() >= 2, "{snapshot}");
    assert_eq!(
        snapshot["scanners"],
        json!([{ "port": "COM3", "baud": 9600, "status": "connected" }])
    );
    let status: Value = serde_json::from_str(
        &statuses
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["revision"], 1);
    assert_eq!(status["scanners"][0]["port"], "COM3");

    bytes
        .send(b"]d2010460000000001521serial\x1d91key\x1d92crypto\r\n".to_vec())
        .unwrap();
    let scan: String = serde_json::from_str(
        &scans
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(scan, "]d2010460000000001521serial\u{1d}91key\u{1d}92crypto");

    for scanners in [
        json!([{ "port": "COM3", "baud": 0 }]),
        json!([{ "port": "COM3" }]),
        json!([{ "port": "COM3", "baud": 9600, "parity": "none" }]),
        json!([{ "port": "COM3", "baud": 9600 }, { "port": "com3", "baud": 9600 }]),
        json!("COM3"),
    ] {
        assert_eq!(
            invoke(
                &webview,
                "configure_scanners",
                json!({ "scanners": scanners })
            ),
            Err(json!("invalid_scanners")),
            "{scanners}"
        );
    }
    assert_eq!(connections()["scanners"][0]["status"], "connected");

    assert_eq!(
        invoke(&webview, "close_scanners", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(connections()["scanners"], json!([]));
    match invoke(&webview, "list_serial_ports", json!({})) {
        Ok(Value::Array(_)) => {}
        Err(code) => assert_eq!(code, json!("serial_unavailable")),
        other => panic!("{other:?}"),
    }
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --no-run`
Expected: FAIL компиляции: `error[E0432]: unresolved import 'markiro_standalone_lib::scanner'`.

- [ ] **Step 3: Скопировать облачную среду и поправить**

Run: `mkdir -p apps/standalone/src-tauri/src/scanner && cp apps/station/src-tauri/src/scanner/runtime.rs apps/standalone/src-tauri/src/scanner/runtime.rs && cp apps/station/src-tauri/src/scanner/runtime_tests.rs apps/standalone/src-tauri/src/scanner/runtime_tests.rs && shasum -a 256 apps/station/src-tauri/src/scanner/runtime.rs apps/station/src-tauri/src/scanner/runtime_tests.rs`
Expected: хеши из «Заметок для исполнения».

Правка `apps/standalone/src-tauri/src/scanner/runtime.rs` (копии облачного файла):

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
```

заменить на:

<!-- prettier-ignore -->
```rust
//! The COM scanners' runtime, ported from the cloud station
//! (`apps/station/src-tauri/src/scanner/runtime.rs`) with bare refusal codes:
//! one thread per configured port opens it, reads, frames scans at CR/LF and
//! reconnects after a pause when the port is missing or drops; a status
//! snapshot with a growing `revision` goes out on every change. Opening and
//! emitting are injected (`PortOpener`, `EventSink`), so the tests drive it
//! with fake ports.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    Scan(String),
    Status(ScannerSnapshot),
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    Scan(String),
    Status(ScannerSnapshot),
}

/// Why `configure_scanners` or `list_serial_ports` refused, as the bare code
/// the webview reads (`src/hardware/hardware.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerError {
    /// Not `[{ port, baud }]`, a port name empty or holding NUL, a baud rate
    /// of 0, or one port twice (`COM3` and `com3` are one port).
    InvalidScanners,
    /// The system did not list its serial ports.
    SerialUnavailable,
}

impl ScannerError {
    pub fn code(self) -> &'static str {
        match self {
            ScannerError::InvalidScanners => "invalid_scanners",
            ScannerError::SerialUnavailable => "serial_unavailable",
        }
    }
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
    /// Validates the entire request before mutation; no serial I/O or thread
    /// joining runs on the IPC thread. Missing and busy ports remain configured.
    pub fn configure(&self, scanners: Vec<ScannerConfig>) -> Result<(), String> {
        let mut requested = BTreeMap::new();
        for mut config in scanners {
            config.port = canonical_port(&config.port);
            if config.port.is_empty() || config.port.contains('\0') {
                return Err("Scanner port must be nonempty and contain no NUL".into());
            }
            if config.baud == 0 {
                return Err("Scanner baud rate must be positive".into());
            }
            if requested.insert(config.port.clone(), config).is_some() {
                return Err("Scanner ports must be unique".into());
            }
        }
```

заменить на:

<!-- prettier-ignore -->
```rust
    /// Validates the entire request before mutation; no serial I/O or thread
    /// joining runs on the IPC thread. Missing and busy ports remain configured.
    pub fn configure(&self, scanners: Vec<ScannerConfig>) -> Result<(), ScannerError> {
        let mut requested = BTreeMap::new();
        for mut config in scanners {
            config.port = canonical_port(&config.port);
            if config.port.is_empty() || config.port.contains('\0') || config.baud == 0 {
                return Err(ScannerError::InvalidScanners);
            }
            if requested.insert(config.port.clone(), config).is_some() {
                return Err(ScannerError::InvalidScanners);
            }
        }
```

Правка `apps/standalone/src-tauri/src/scanner/runtime_tests.rs` (копии облачного файла):

Фрагмент:

<!-- prettier-ignore -->
```rust
        vec![config("COM4", 9600), config("com4", 9600)],
        vec![config(" ", 9600)],
        vec![config("COM3", 0)],
    ] {
        assert!(rig.manager.configure(invalid).is_err());
        assert_eq!(rig.manager.snapshot(), before);
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
        vec![config("COM4", 9600), config("com4", 9600)],
        vec![config(" ", 9600)],
        vec![config("COM\0", 9600)],
        vec![config("COM3", 0)],
    ] {
        assert_eq!(
            rig.manager.configure(invalid),
            Err(ScannerError::InvalidScanners)
        );
        assert_eq!(rig.manager.snapshot(), before);
    }
```

- [ ] **Step 4: Модуль и команды**

Создать `apps/standalone/src-tauri/src/scanner.rs`:

<!-- prettier-ignore -->
```rust
//! COM scanners in the shell (stage 2a spec §5.2, decision 24), ported from
//! the cloud station (`apps/station/src-tauri/src/scanner.rs`). The webview
//! hands over the whole desired set of ports at once (`configure_scanners`);
//! each scan reaches it as the event `standalone://scan` with the raw text
//! (the GS1 group separator and any AIM prefix kept: `@markiro/domain` reads
//! them), and every connection change as `standalone://scanner-status`. A
//! keyboard-wedge scanner needs none of this: it types into the window.

mod runtime;

use std::io;
use std::sync::Arc;
use std::time::Duration;

pub use runtime::{
    ConnectionStatus, EventSink, PortOpener, ScannerConfig, ScannerConnection, ScannerError,
    ScannerEvent, ScannerManager, ScannerSnapshot,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};

/// A scan: the raw text between CR/LF, decoded as UTF-8 with replacement.
pub const SCAN_EVENT: &str = "standalone://scan";
/// The configured ports and their connection, `{ revision, scanners }`.
pub const SCANNER_STATUS_EVENT: &str = "standalone://scanner-status";

/// How long a port that is missing or dropped waits before opening again.
pub const RETRY: Duration = Duration::from_secs(2);

/// Opens a real serial port; a read waits at most 200 ms, so a removed
/// configuration stops its thread quickly.
pub fn serial_opener() -> PortOpener {
    Arc::new(|config| {
        serialport::new(&config.port, config.baud)
            .timeout(Duration::from_millis(200))
            .open()
            .map(|port| Box::new(port) as Box<dyn io::Read + Send>)
            .map_err(io::Error::other)
    })
}

/// Emits the runtime's scans and statuses as the webview's events. A closed
/// window hears nothing; the next status replaces the one it missed.
pub fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> EventSink {
    Arc::new(move |event| match event {
        ScannerEvent::Scan(scan) => {
            let _ = app.emit(SCAN_EVENT, scan);
        }
        ScannerEvent::Status(snapshot) => {
            let _ = app.emit(SCANNER_STATUS_EVENT, snapshot);
        }
    })
}

/// The app's scanner manager: real ports, Tauri events, a 2 s retry.
pub fn manager<R: Runtime>(app: AppHandle<R>) -> ScannerManager {
    ScannerManager::new(serial_opener(), tauri_sink(app), RETRY)
}

/// The names of the serial ports the system knows (`COM3`, `/dev/ttyUSB0`).
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|error| {
        eprintln!("standalone: list_serial_ports serial_unavailable: {error}");
        ScannerError::SerialUnavailable.code().to_owned()
    })?;
    Ok(ports.into_iter().map(|port| port.port_name).collect())
}

/// Replaces the whole set of scanners with `scanners` (`[{ port, baud }]`):
/// ports that stay keep their connection and any half-read scan, removed
/// ones close, new ones start opening. Checked whole before anything
/// changes; no serial I/O runs on the IPC thread.
#[tauri::command]
pub fn configure_scanners(state: State<'_, ScannerManager>, scanners: Value) -> Result<(), String> {
    let scanners: Vec<ScannerConfig> = serde_json::from_value(scanners)
        .map_err(|_| ScannerError::InvalidScanners.code().to_owned())?;
    state
        .configure(scanners)
        .map_err(|error| error.code().to_owned())
}

/// The latest snapshot: the webview subscribes to the status event first,
/// then asks, and keeps whichever `revision` is newer.
#[tauri::command]
pub fn get_scanner_connections(state: State<'_, ScannerManager>) -> ScannerSnapshot {
    state.snapshot()
}

/// Closes every scanner port.
#[tauri::command]
pub fn close_scanners(state: State<'_, ScannerManager>) -> Result<(), String> {
    state
        .configure(Vec::new())
        .map_err(|error| error.code().to_owned())
}
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod power;
pub mod printer;
pub mod secret_store;
pub mod tls;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod power;
pub mod printer;
pub mod scanner;
pub mod secret_store;
pub mod tls;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        power::set_system_awake,
        printer::print_bytes,
        printer::list_usb_printers
    ]
}
```

заменить на:

<!-- prettier-ignore -->
```rust
        power::set_system_awake,
        printer::print_bytes,
        printer::list_usb_printers,
        scanner::list_serial_ports,
        scanner::configure_scanners,
        scanner::get_scanner_connections,
        scanner::close_scanners
    ]
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            let status = ConnectionState::default();
            app.manage(status.clone());
            tauri::async_runtime::spawn(connection::supervise(
                link,
```

заменить на:

<!-- prettier-ignore -->
```rust
            let status = ConnectionState::default();
            app.manage(status.clone());
            app.manage(scanner::manager(app.handle().clone()));
            tauri::async_runtime::spawn(connection::supervise(
                link,
```

- [ ] **Step 5: Тесты проходят**

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: PASS — 76 тестов (16 `scanner::runtime::tests`). Затем ещё четыре прогона `--lib scanner` подряд — все PASS (на копии плана восемь прогонов подряд прошли).

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc`
Expected: PASS — 18 тестов; `scanners_answer_through_the_ipc_shapes` — пять прогонов подряд PASS.

- [ ] **Step 6: Мутации**

1. `apps/standalone/src-tauri/src/scanner/runtime.rs`: убрать `#[serde(deny_unknown_fields)]` над `pub struct ScannerConfig`. Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc scanners`. Expected: FAIL — `scanners_answer_through_the_ipc_shapes` на `[{"baud":9600,"parity":"none","port":"COM3"}]`.
2. Там же в `canonical_port`: `        port.to_ascii_uppercase()` → `        port.to_string()`. Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib scanner`. Expected: FAIL — 4 теста `scanner::runtime::tests` (`configuration_validation_is_atomic_and_com_only_is_case_insensitive` среди них).

- [ ] **Step 7: Чистота**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`
Expected: чисто.

- [ ] **Step 8: Commit**

```bash
git add apps/standalone/src-tauri/src/scanner.rs apps/standalone/src-tauri/src/scanner/runtime.rs apps/standalone/src-tauri/src/scanner/runtime_tests.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs
git commit -m "feat(standalone): COM scanners in the shell, with standalone://scan and standalone://scanner-status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Обёртки вебвью `src/hardware/hardware.ts` и документы

**Files:**

- Create: `apps/standalone/src/hardware/hardware.ts`, `apps/standalone/test/hardware.test.ts`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (новый §16)

**Interfaces:**

- Consumes: команды и события задач 6–8 (имена и коды — «Контракт для 2a5–2a7»).
- Produces: `createTauriHardware(call?, subscribe?): HardwareApi`; `HardwareApi` (свойства-функции `printBytes`, `listUsbPrinters`, `listSerialPorts`, `configureScanners`, `closeScanners`, `watchScanners`, `onScan`, `setSystemAwake`); типы `PrintTarget`, `PrintResult`, `PrintFailureCode`, `ScannerConfig`, `ScannerSnapshot`, `UsbPrinter`, `HardwareErrorCode`; `HardwareError`; `bytesToBase64`; константы `SCAN_EVENT`, `SCANNER_STATUS_EVENT`, `PRINT_FAILURE_CODES`, `HARDWARE_ERROR_CODES`; схемы `scannerConfigSchema`, `scannerSnapshotSchema`, `usbPrinterSchema`.

Порт облачного `apps/station/src/lib/hardware.ts` без COM-источника сканов (он — план 2a6, поверх `onScan`) и с голыми кодами: `printBytes` никогда не бросает, `watchScanners` подписывается раньше, чем спрашивает, и берёт только более новый `revision`. Обёрткой пока никто не пользуется — её подключают планы 2a5–2a7.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/standalone/test/hardware.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  bytesToBase64,
  createTauriHardware,
  HARDWARE_ERROR_CODES,
  HardwareError,
  PRINT_FAILURE_CODES,
  SCAN_EVENT,
  SCANNER_STATUS_EVENT,
  type ScannerSnapshot,
} from "../src/hardware/hardware.js";

type Handler = (event: { payload: unknown }) => void;

/** A fake `listen`: records handlers so the test can emit shell events. */
function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const listen = vi.fn(async (event: string, handler: Handler) => {
    order.push(`listen ${event}`);
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload });
  return { listen, emit, handlers, order };
}

async function failure(promise: Promise<unknown>): Promise<HardwareError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HardwareError);
  return error as HardwareError;
}

function snapshot(revision: number, status: "connected" | "disconnected"): ScannerSnapshot {
  return { revision, scanners: [{ port: "COM3", baud: 9600, status }] };
}

describe("the shell's hardware", () => {
  it("listens to the shell's own event names", () => {
    expect(SCAN_EVENT).toBe("standalone://scan");
    expect(SCANNER_STATUS_EVENT).toBe("standalone://scanner-status");
  });

  it("sends a label's exact bytes as base64 with its target", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const target = { kind: "tcp", host: "192.168.1.50", port: 9100 } as const;
    const bytes = new Uint8Array([0x5e, 0x58, 0x41, 0xa4, 0x1d]);
    await expect(createTauriHardware(call).printBytes(target, bytes)).resolves.toEqual({
      sent: true,
    });
    expect(call).toHaveBeenCalledWith("print_bytes", { target, payloadBase64: "XlhBpB0=" });
  });

  it("encodes every byte value losslessly", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it.each(PRINT_FAILURE_CODES)("answers the shell's %s refusal without throwing", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    await expect(
      createTauriHardware(call).printBytes({ kind: "usb", printer: "Zebra" }, new Uint8Array([1])),
    ).resolves.toEqual({ sent: false, code });
  });

  it.each([
    ["an unknown code", "from_a_newer_shell"],
    ["a failed IPC call", new Error("IPC channel closed")],
  ])("reads %s as an unknown outcome, never as nothing sent", async (_case, rejection) => {
    const call = vi.fn().mockRejectedValue(rejection);
    await expect(
      createTauriHardware(call).printBytes({ kind: "usb", printer: "Zebra" }, new Uint8Array([1])),
    ).resolves.toEqual({ sent: false, code: "outcome_unknown" });
  });

  it("lists installed queues and serial ports, and checks their shape", async () => {
    const queues = [{ name: "Zebra ZD421", port: "USB001" }];
    const call = vi.fn(async (command: string) =>
      command === "list_usb_printers" ? queues : ["COM3", "COM4"],
    );
    const hardware = createTauriHardware(call);
    await expect(hardware.listUsbPrinters()).resolves.toEqual(queues);
    await expect(hardware.listSerialPorts()).resolves.toEqual(["COM3", "COM4"]);
    expect(call).toHaveBeenCalledWith("list_usb_printers", {});
    expect(call).toHaveBeenCalledWith("list_serial_ports", {});

    const odd = createTauriHardware(vi.fn().mockResolvedValue([{ name: "Zebra" }]));
    expect((await failure(odd.listUsbPrinters())).code).toBe("invalid_response");
  });

  it("hands the whole set of scanners over and closes them", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const hardware = createTauriHardware(call);
    const scanners = [
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ];
    await hardware.configureScanners(scanners);
    expect(call).toHaveBeenCalledWith("configure_scanners", { scanners });
    await hardware.closeScanners();
    expect(call).toHaveBeenLastCalledWith("close_scanners", {});
  });

  it.each(HARDWARE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    expect((await failure(createTauriHardware(call).setSystemAwake(true))).code).toBe(code);
  });

  it("treats an unexpected shell error as unknown", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    expect((await failure(createTauriHardware(call).configureScanners([]))).code).toBe("unknown");
  });

  it("asks to keep the computer awake and to let it sleep", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const hardware = createTauriHardware(call);
    await hardware.setSystemAwake(true);
    expect(call).toHaveBeenLastCalledWith("set_system_awake", { awake: true });
    await hardware.setSystemAwake(false);
    expect(call).toHaveBeenLastCalledWith("set_system_awake", { awake: false });
  });

  it("subscribes to the scanners' status before asking for the current one", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      events.order.push(command);
      return snapshot(1, "disconnected");
    });
    const seen: ScannerSnapshot[] = [];
    await createTauriHardware(call, events.listen).watchScanners((next) => seen.push(next));
    expect(events.order).toEqual([`listen ${SCANNER_STATUS_EVENT}`, "get_scanner_connections"]);
    expect(seen).toEqual([snapshot(1, "disconnected")]);
  });

  it("keeps only newer snapshots and ignores malformed ones", async () => {
    const events = fakeEvents();
    // The shell published revision 3 while the snapshot (revision 2) was on its way.
    const call = vi.fn(async () => {
      events.emit(SCANNER_STATUS_EVENT, snapshot(3, "connected"));
      return snapshot(2, "disconnected");
    });
    const seen: ScannerSnapshot[] = [];
    const stop = await createTauriHardware(call, events.listen).watchScanners((next) =>
      seen.push(next),
    );
    events.emit(SCANNER_STATUS_EVENT, snapshot(3, "disconnected"));
    events.emit(SCANNER_STATUS_EVENT, { revision: 9, scanners: "COM3" });
    events.emit(SCANNER_STATUS_EVENT, snapshot(4, "disconnected"));
    expect(seen).toEqual([snapshot(3, "connected"), snapshot(4, "disconnected")]);

    stop();
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
  });

  it("stops listening when the current snapshot cannot be read", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockRejectedValue("unknown");
    const watching = createTauriHardware(call, events.listen).watchScanners(vi.fn());
    expect((await failure(watching)).code).toBe("unknown");
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
  });

  it("delivers each COM scan raw, the group separator kept", async () => {
    const events = fakeEvents();
    const scans: string[] = [];
    const stop = await createTauriHardware(vi.fn(), events.listen).onScan((raw) => scans.push(raw));
    events.emit(SCAN_EVENT, "]d2010460000000001521serial\u001d91key");
    events.emit(SCAN_EVENT, { not: "a scan" });
    expect(scans).toEqual(["]d2010460000000001521serial\u001d91key"]);

    stop();
    expect(events.handlers.has(SCAN_EVENT)).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/hardware.test.ts`
Expected: FAIL — `Failed to resolve import "../src/hardware/hardware.js" from "test/hardware.test.ts". Does the file exist?`

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/hardware/hardware.ts`:

<!-- prettier-ignore -->
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

/** A COM scan, the raw text (`src-tauri/src/scanner.rs`). */
export const SCAN_EVENT = "standalone://scan";
/** The configured COM ports and their connection. */
export const SCANNER_STATUS_EVENT = "standalone://scanner-status";

/** Where a label goes (`PrintTarget` in `src-tauri/src/printer.rs`). */
export type PrintTarget =
  | { kind: "serial"; port: string; baud: number }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "usb"; printer: string };

/** Codes `print_bytes` refuses with (`PrintError::code` in src-tauri). */
export const PRINT_FAILURE_CODES = [
  "not_sent",
  "outcome_unknown",
  "invalid_target",
  "invalid_payload",
  "unsupported",
] as const;
export type PrintFailureCode = (typeof PRINT_FAILURE_CODES)[number];

/**
 * One send. `sent`: every byte left this computer (the spooler took the
 * job, or the printer's connection took the bytes), which is not yet a
 * printed label. Otherwise the code: `not_sent` — nothing left, so printing
 * again cannot double a label; `outcome_unknown` — a label may exist, so
 * only the operator may print again (plan 2a7). An answer the shell never
 * gives — an unknown code, a failed IPC call — reads as `outcome_unknown`,
 * the reading that cannot double a label.
 */
export type PrintResult = { sent: true } | { sent: false; code: PrintFailureCode };

export const scannerConfigSchema = z
  .object({ port: z.string().min(1), baud: z.number().int().positive() })
  .strict();
/** One COM scanner as the shell configures it: `COM3` and `com3` are one port. */
export type ScannerConfig = z.infer<typeof scannerConfigSchema>;

export const scannerSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    scanners: z.array(
      z
        .object({
          port: z.string(),
          baud: z.number().int().positive(),
          status: z.enum(["connected", "disconnected"]),
        })
        .strict(),
    ),
  })
  .strict();
/** The configured ports and their connection; `revision` grows with every change. */
export type ScannerSnapshot = z.infer<typeof scannerSnapshotSchema>;

export const usbPrinterSchema = z.object({ name: z.string(), port: z.string() }).strict();
/** An installed Windows queue: the spooler's queue name and its port. */
export type UsbPrinter = z.infer<typeof usbPrinterSchema>;

/** Codes the other hardware commands refuse with, and two of the webview's own. */
export const HARDWARE_ERROR_CODES = [
  "invalid_scanners",
  "serial_unavailable",
  "spooler_unavailable",
  "power_request_failed",
  "invalid_response",
  "unknown",
] as const;
export type HardwareErrorCode = (typeof HARDWARE_ERROR_CODES)[number];

/** A refused hardware command; screens choose text by `code`, never by message. */
export class HardwareError extends Error {
  readonly code: HardwareErrorCode;

  constructor(code: HardwareErrorCode, message: string) {
    super(message);
    this.name = "HardwareError";
    this.code = code;
  }
}

/**
 * The shell's printers, COM scanners and power request. Function-typed
 * properties, so they may be passed around unbound
 * (`@typescript-eslint/unbound-method`).
 */
export interface HardwareApi {
  /** Sends a label's bytes; never throws. One send at a time per address (plan 2a7). */
  printBytes: (target: PrintTarget, bytes: Uint8Array) => Promise<PrintResult>;
  /** The installed Windows queues, `USB…` ports first; empty off Windows. */
  listUsbPrinters: () => Promise<UsbPrinter[]>;
  listSerialPorts: () => Promise<string[]>;
  /** Replaces the whole set of COM scanners; an empty set closes them all. */
  configureScanners: (scanners: readonly ScannerConfig[]) => Promise<void>;
  closeScanners: () => Promise<void>;
  /**
   * The current snapshot, then every newer one, until the returned function
   * is called. Subscribes first and asks second, so no change is lost.
   */
  watchScanners: (onSnapshot: (snapshot: ScannerSnapshot) => void) => Promise<() => void>;
  /** Every COM scan as the scanner sent it, until the returned function is called. */
  onScan: (listener: (raw: string) => void) => Promise<() => void>;
  /** Keeps the computer and its display awake (`true`) or lets them sleep. */
  setSystemAwake: (awake: boolean) => Promise<void>;
}

/** Tauri's IPC is JSON, so a label's bytes cross it base64-encoded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/** The hardware commands of `src-tauri/src/{printer,scanner,power}.rs`. */
export function createTauriHardware(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
): HardwareApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = HARDWARE_ERROR_CODES.find((candidate) => candidate === error) ?? "unknown";
      throw new HardwareError(code, `${command}: ${String(error)}`);
    }
  }

  function parse<T>(command: string, schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new HardwareError("invalid_response", `${command}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  return {
    printBytes: async (target, bytes) => {
      try {
        await call("print_bytes", { target, payloadBase64: bytesToBase64(bytes) });
        return { sent: true };
      } catch (error) {
        const code =
          PRINT_FAILURE_CODES.find((candidate) => candidate === error) ?? "outcome_unknown";
        return { sent: false, code };
      }
    },
    listUsbPrinters: async () =>
      parse("list_usb_printers", z.array(usbPrinterSchema), await run("list_usb_printers", {})),
    listSerialPorts: async () =>
      parse("list_serial_ports", z.array(z.string()), await run("list_serial_ports", {})),
    configureScanners: async (scanners) => {
      await run("configure_scanners", { scanners });
    },
    closeScanners: async () => {
      await run("close_scanners", {});
    },
    watchScanners: async (onSnapshot) => {
      let newest = -1;
      const accept = (snapshot: ScannerSnapshot) => {
        if (snapshot.revision <= newest) return;
        newest = snapshot.revision;
        onSnapshot(snapshot);
      };
      const stop = await subscribe(SCANNER_STATUS_EVENT, (event) => {
        const parsed = scannerSnapshotSchema.safeParse(event.payload);
        if (parsed.success) accept(parsed.data);
      });
      try {
        const raw = await run("get_scanner_connections", {});
        accept(parse("get_scanner_connections", scannerSnapshotSchema, raw));
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    },
    onScan: (listener) =>
      subscribe(SCAN_EVENT, (event) => {
        if (typeof event.payload === "string") listener(event.payload);
      }),
    setSystemAwake: async (awake) => {
      await run("set_system_awake", { awake });
    },
  };
}
```

- [ ] **Step 4: Тест проходит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/hardware.test.ts`
Expected: PASS — 24 теста; нет `stderr |`.

- [ ] **Step 5: Мутации**

1. `apps/standalone/src/hardware/hardware.ts`: `PRINT_FAILURE_CODES.find((candidate) => candidate === error) ?? "outcome_unknown";` → `PRINT_FAILURE_CODES.find((candidate) => candidate === error) ?? "not_sent";`. Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/hardware.test.ts`. Expected: FAIL — 2 теста «reads … as an unknown outcome, never as nothing sent».
2. Там же удалить строку `        if (snapshot.revision <= newest) return;`. Та же команда. Expected: FAIL — «keeps only newer snapshots and ignores malformed ones».

- [ ] **Step 6: Документы**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
```markdown
`statement_failed`, `changes_mismatch`.

A forget (`clear_copies`) empties every table, `floor_sign_in_failures`
included, so it resets every lockout counter of the station and of its
operators, and a station on the host's PC re-pairs itself. Whoever can reach
a «Подключить заново» or «Сбросить подключение» control (the
```

заменить на:

<!-- prettier-ignore -->
```markdown
`statement_failed`, `changes_mismatch`.

A forget (`clear_copies`) empties every disposable table (see below),
`floor_sign_in_failures` included, so it resets every lockout counter of the station and of its
operators, and a station on the host's PC re-pairs itself. Whoever can reach
a «Подключить заново» or «Сбросить подключение» control (the
```

Фрагмент 2:

<!-- prettier-ignore -->
```markdown
did; an applied migration is never edited.

`device_forget` clears the local copies before it removes `device.json`:
`LocalDb::clear_copies` deletes every row of every table but
`_sqlx_migrations`, in one writer transaction with foreign keys checked at
the commit. The tables come from `pragma_table_list` (`type IN ('table',
'virtual')`), so one a later migration adds is covered, PIN and badge hashes
included (`ref_operators`, `ref_operator_badges`). The writer runs with
`secure_delete`, so a deleted row is zeroed where it stood, and the clear
ends with `wal_checkpoint(TRUNCATE)`, which moves those pages into the file
and empties the WAL that still held the frames written before the delete:
no hash of the old pairing stays in either file (`VACUUM` would only shrink
the file). That is true of the two files only: the checkpoint, and the
removal of an unopened database, free blocks without overwriting them; the
file system's free space, SSD wear levelling and shadow copies or backups can
keep old bytes (a 4–6-digit PBKDF2 PIN is cheap to brute-force); and bytes a
writer freed before it ran with `secure_delete` (a development database from
before that setting) are not scrubbed, so for that database `VACUUM` would do
more than shrink the file, and nothing here runs it. A reader holding an
older snapshot keeps the checkpoint from finishing, and the call then fails;
the delete stays committed and a retry repeats only the checkpoint. A local
database that did not open is removed instead, with its `-wal`, `-shm` and
`-journal` files (`LocalDbState::remove_unopened`), since it may still hold
hashes. Every table here is disposable: the copies of the host's data, and
`floor_sign_in_failures` (`src-tauri/migrations/0005_floor_sign_in_failures.sql`,
plan 1f), this device's own failed sign-ins. A forget clears that table with
the copies on purpose (a new pairing brings a new roster), and
`tests/local_db.rs` pins it; the sync's wipe for another pairing leaves it
alone on purpose, because it is no copy of the host's data and a wipe is no
sign-in. That half holds by construction (`WIPE` in
`src/local/reference-sync.ts` names only the copies, the quarantine and
`sync_state`); no test pins it. The first plan that adds data this device
must keep — the scan journal, boxes, the outbox (the design's §6.2,
"Логическая модель") — must exclude those tables from `clear_copies`, keep
`remove_unopened` from deleting them, and block or confirm a forget while
unsynced records exist, not extend this list silently. If clearing or
removing fails, the command fails with `storage` and the pairing stays for
another try.

## Writes
```

заменить на:

<!-- prettier-ignore -->
```markdown
did; an applied migration is never edited.

`device_forget` clears the local copies before it removes `device.json`.
Every table of `src-tauri/migrations` has a class in `TABLE_CLASSES`
(`src-tauri/src/local_db.rs`; stage 2a spec §5.2, decision 30):
`Disposable` — the copies of the host's data, `sync_state`,
`sync_quarantine` and `floor_sign_in_failures`; `DeviceData` — what the
device recorded itself (plans 2a5–2a8: shifts, boxes, scans, the outbox),
each row tagged with the pairing that wrote it; `Workstation` — the PC's own
settings (plan 2a7), which outlive any pairing. `tests/local_db.rs` fails on
a table without a class and on a class that names no table, so a plan that
adds a table classes it in the same change. No table has a foreign key, and
none may get one across classes: a forget would then fail at its commit.
`LocalDb::clear_copies` deletes the rows of the disposable tables only, in
one writer transaction, and in that same transaction first counts the outbox
records without a receipt (`acked_at IS NULL`) of the current pairing
(`host_id`, `device_id`), or of any pairing while `device.json` is
unreadable. Any such record refuses the forget with `unsent_facts` and
changes nothing, until the records are sent or a person confirms with
`keepUnsent: true` (question В7); the records stay on disk either way. The
headers of the applied migrations `0001`–`0005` still say that
`clear_copies` takes every table; an applied migration is never edited. The
writer runs with `secure_delete`, so a deleted row is zeroed where it stood,
and the clear ends with `wal_checkpoint(TRUNCATE)`, which moves those pages
into the file and empties the WAL that still held the frames written before
the delete: no hash of the old pairing stays in either file (`VACUUM` would
only shrink the file). That is true of the two files only: the checkpoint
frees blocks without overwriting them; the file system's free space, SSD wear
levelling and shadow copies or backups can keep old bytes (a 4–6-digit PBKDF2
PIN is cheap to brute-force); and bytes a writer freed before it ran with
`secure_delete` (a development database from before that setting) are not
scrubbed, so for that database `VACUUM` would do more than shrink the file,
and nothing here runs it. A reader holding an older snapshot keeps the
checkpoint from finishing, and the call then fails; the delete stays
committed and a retry repeats only the checkpoint. A local database that did
not open is moved aside, not deleted (`LocalDbState::set_aside_unopened`):
it and its `-wal`, `-shm` and `-journal` files become
`standalone-station.db.unreadable-<unix ms>` plus their suffix, so the set
stays openable together for support (plan 5), and a new database opens in
its place without a restart. That file may still hold PIN and badge hashes:
the accepted price of keeping the device's records. A file that cannot be
moved puts back the ones already moved. The sync's wipe for another pairing
(`WIPE` in `src/local/reference-sync.ts`) names only the copies, the
quarantine and `sync_state`, and leaves `floor_sign_in_failures` alone on
purpose, because it is no copy of the host's data and a wipe is no sign-in;
no test pins that half. If clearing or moving fails, the command fails with
`storage` and the pairing stays for another try.

## Writes
```

Фрагмент 3:

<!-- prettier-ignore -->
```markdown
with the host away; `device_refresh` reads `GET /v1/device` again and keeps
a line the office changed the same way; the change stream belongs to the
connection task.
Pairing routes return a new device key, so they stay behind their own
commands (`host_local_pair`, `host_claim`) and the key never reaches the
```

заменить на:

<!-- prettier-ignore -->
```markdown
with the host away; `device_refresh` reads `GET /v1/device` again and keeps
a line the office changed the same way; the change stream belongs to the
connection task. `host_request` takes an optional `timeoutMs` of
100–10 000 ms (`DeviceState::request_within`, plan 2a4): outside that range
it answers `invalid_request` before any I/O, and a request that runs past it
answers `timeout`, a transport code of its own; without it a hung request
still ends at the client's own limits (2 s to connect, the TLS handshake
included, then 10 s per request) as `unreachable`.
Pairing routes return a new device key, so they stay behind their own
commands (`host_local_pair`, `host_claim`) and the key never reaches the
```

Фрагмент 4:

<!-- prettier-ignore -->
```markdown
pinned by `src-tauri/tests/ipc.rs` through Tauri's mock runtime. Change it
together with `src/host/client.ts`, `src/host/device.ts`, `src/host/probe.ts`,
`src/host/connection.ts` and `src/local/executor.ts`.

## Connection to the host
```

заменить на:

<!-- prettier-ignore -->
```markdown
pinned by `src-tauri/tests/ipc.rs` through Tauri's mock runtime. Change it
together with `src/host/client.ts`, `src/host/device.ts`, `src/host/probe.ts`,
`src/host/connection.ts`, `src/local/executor.ts` and
`src/hardware/hardware.ts`.

## Connection to the host
```

Фрагмент 5:

<!-- prettier-ignore -->
```markdown
current when that event was published. The webview syncs reference data on
each revision and never opens the stream itself.

## Device key and office session
```

заменить на:

<!-- prettier-ignore -->
```markdown
current when that event was published. The webview syncs reference data on
each revision and never opens the stream itself.

## Hardware

The shell's printers, COM scanners and power request (plan 2a4, ported from
the cloud station's `printer.rs`, `scanner.rs` and `power.rs`) are reached
only through `src/hardware/hardware.ts`; `src-tauri/tests/ipc.rs` pins their
names and arguments.

- `print_bytes { target, payloadBase64 }` sends a label's bytes to
  `{ kind: "tcp", host, port }`, `{ kind: "serial", port, baud }` or, on
  Windows only, `{ kind: "usb", printer }` (a spooler queue, RAW datatype,
  `src-tauri/src/printer/spooler.rs`). Blocking work runs on a thread for
  blocking work, with 5 s to connect and 5 s per write. It answers `null` or
  a bare code: `not_sent` (nothing left this computer: the name did not
  resolve, or the connection, the COM port or the queue did not open, or
  `StartDocPrinterW` refused), `outcome_unknown` (the failure came after the
  first write began: a write, a flush, `StartPagePrinter`, `WritePrinter`, a
  short write, `EndPagePrinter`, `EndDocPrinter`, or the send thread died),
  `invalid_target`, `invalid_payload` (not base64, or empty) and
  `unsupported` (USB off Windows). `printBytes` never throws, and an answer
  the shell never gives reads as `outcome_unknown`, the reading that cannot
  double a label. Neither the shell nor the wrapper ever sends again; `sent`
  means the bytes left, not that a label printed (a spooler may take a job
  for a printer that is off). `list_usb_printers` lists the installed queues,
  `USB…` ports first, empty off Windows, `spooler_unavailable` when the
  spooler does not answer.
- `configure_scanners { scanners: [{ port, baud }] }` replaces the whole set of
  COM scanners: a `COM<digits>` name is upper-cased, and an empty or NUL
  name, a baud rate of 0, one port twice or another shape is
  `invalid_scanners`, checked before anything changes. One thread per port
  opens it, frames scans at CR or LF (dropping 4096 bytes without one),
  decodes UTF-8 with replacement and opens the port again 2 s after a loss;
  ports that stay keep their connection and a half-read scan. Scans arrive as
  `standalone://scan` with the raw text (the GS byte and an AIM prefix kept:
  `@markiro/domain` reads them), and every change as
  `standalone://scanner-status` `{ revision, scanners: [{ port, baud, status }] }`;
  `get_scanner_connections` answers the latest snapshot, so the webview
  subscribes first, asks second and keeps the newer `revision`.
  `close_scanners` closes them all; `list_serial_ports` names the system's
  ports, or answers `serial_unavailable`.
- `set_system_awake { awake }` holds one Windows power request (display and
  system required) while `true`, and nothing off Windows; `false` always lets
  go, a poisoned lock included, and a refused request is
  `power_request_failed`.

## Device key and office session
```

Фрагмент 6:

<!-- prettier-ignore -->
```markdown
  repeat of the same line and a revocation take none. How a line change
  meets a running shift is plan 2a's decision; stage 1 has only the floor
  stub.
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
```

заменить на:

<!-- prettier-ignore -->
```markdown
  repeat of the same line and a revocation take none. How a line change
  meets a running shift is plan 2a's decision; stage 1 has only the floor
  stub. The station keeps the name the host has for it in `device.json`
  (`deviceName` in `DeviceStatus`, the name it paired under until then, and
  `null` in a file from before plan 2a4), so a rename reaches its status bar
  with the next revision or reconnection.
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
```

Фрагмент 7:

<!-- prettier-ignore -->
```markdown
close. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

заменить на:

<!-- prettier-ignore -->
```markdown
close. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.
The hardware commands (see "Hardware") log a failure to the shell's stderr by
the command's name, the code and the system's own words (a printer's address
or queue, never a label's bytes or a scan), and a refused forget logs its
count of unsent records; the release build has no console to show either.

## Verification
```

Фрагмент 8:

<!-- prettier-ignore -->
```markdown
  service at runtime and kiosk mode still need a manual check on Windows; a
  run on macOS proves none of it.
- The owner step of plan 1f2 (Task 1) is not done: the two `windows-sys`
  features below are not in `src-tauri/Cargo.toml`, and the shell has never been
  compiled for Windows. Until the owner adds them, `standalone-windows-build`
  fails to compile `lockdown.rs`; do not push before that.
- Kiosk mode in tests: `src-tauri/tests/lockdown.rs` drives the commands and
  the close guard on Tauri's mock runtime, which accepts every window property
```

заменить на:

<!-- prettier-ignore -->
```markdown
  service at runtime and kiosk mode still need a manual check on Windows; a
  run on macOS proves none of it.
- The `windows-sys` features of kiosk mode, the spooler and the power
  request, `serialport`, `base64` for every system and `libudev-dev` in
  `standalone-rust` came with plan 2a4's owner step (its Task 1, which also
  closed plan 1f2's). The shell's `cfg(windows)` code still compiles only in
  `standalone-windows-build`: plan 2a4 type-checked `printer/spooler.rs` and
  `power/windows.rs` with a probe crate for `x86_64-pc-windows-msvc`, never
  the shell itself, whose `aws-lc-sys` needs the Windows SDK.
- Kiosk mode in tests: `src-tauri/tests/lockdown.rs` drives the commands and
  the close guard on Tauri's mock runtime, which accepts every window property
```

Фрагмент 9:

<!-- prettier-ignore -->
```markdown
    controls, on the real screen and touch panel (and the Windows on-screen
    keyboard for typing a name).
```

заменить на:

<!-- prettier-ignore -->
```markdown
    controls, on the real screen and touch panel (and the Windows on-screen
    keyboard for typing a name).
- Hardware in tests: `tests/printer.rs` sends to stub TCP printers on
  loopback (the whole label; a port that does not listen is `not_sent`; a
  connection reset mid-label and a printer that stops reading are
  `outcome_unknown`), each send on its own thread with a 10 s deadline, so a
  send that hangs fails instead of hanging the suite; `scanner/runtime_tests.rs`
  drives the scanner runtime with fake ports; `tests/ipc.rs` drives every
  hardware command and both scanner events through the mock runtime with a
  fake COM port, and on Windows its `set_system_awake` test asks for a real
  power request (a CI runner's session may refuse it with
  `power_request_failed`; letting go must succeed either way). No COM
  printer is stubbed: macOS refuses a serial port's settings on a
  pseudo-terminal.
- Hardware by hand, on Windows 10 and 11 (stage 2a spec §7). None of it has
  been run; check at least:
  - ZPL to a Zebra and TSPL to a TSC at 203 and 300 dpi over TCP 9100, a COM
    port and a USB spooler queue: the label matches the office preview, with
    Cyrillic, and its DataMatrix and SSCC read back;
  - `not_sent` and `outcome_unknown` on real failures: the printer off before
    and during a job, the cable pulled, the spooler service stopped (and
    `list_usb_printers` then answering `spooler_unavailable`); whether the
    spooler takes a job for a printer that is off (then `sent` is not
    printed);
  - COM scanners: the port list, CR or LF framing, the GS byte, `]d2` and
    `]C1` prefixes, unplugging and plugging back, two ports at once, and a
    com0com pair for repeatable runs;
  - `set_system_awake`: `powercfg /requests` shows the request while awake
    and none after `false`, and the domain's screen-lock policy;
  - a device renamed in the office shows its new name after the next
    revision or reconnection.
```

Правка `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`:

Фрагмент:

<!-- prettier-ignore -->
```markdown
- `PROTOCOL_VERSION` → 2 уже в 2a1 — вместе с тестами пробы хоста в оболочке и зеркалом в
  `src/host/protocol.ts`, хотя маршрутами протокола 2 станция начнёт пользоваться в плане 2a5.
```

заменить на:

<!-- prettier-ignore -->
```markdown
- `PROTOCOL_VERSION` → 2 уже в 2a1 — вместе с тестами пробы хоста в оболочке и зеркалом в
  `src/host/protocol.ts`, хотя маршрутами протокола 2 станция начнёт пользоваться в плане 2a5.

## 16. Уточнения плана 2a4

План `docs/superpowers/plans/2026-10-09-standalone-2a4-shell.md` (оболочка) уточняет разделы 5.2,
5.3 и 13 так; пока владелец не ответил на вопросы раздела 11, действуют рекомендованные варианты
(В5, В7, В11), и план перечисляет эти допущения.

- Коды отказов оболочки, кроме названных в решении 20: `invalid_payload` у `print_bytes` (не base64
  или пусто), `spooler_unavailable` у `list_usb_printers` (служба печати не ответила — не пустой
  список), `invalid_scanners` у `configure_scanners` (форма, пустое имя порта, NUL, скорость 0,
  повтор порта) и `serial_unavailable` у `list_serial_ports`, `power_request_failed` у
  `set_system_awake`. `print_bytes` принимает `target` как JSON и сам отвечает `invalid_target` на
  любую иную форму, а не текстом Tauri.
- Команда закрытия сканеров — `close_scanners` (облако — `close_scanner`).
- `printBytes` вебвью (`src/hardware/hardware.ts`) не бросает: ответ `{ sent: true }` или
  `{ sent: false, code }`; неизвестный ответ и сбой IPC читаются как `outcome_unknown`.
- `timeout` у `host_request` — только при заданном `timeoutMs`; без него зависший запрос, как и
  раньше, кончается `unreachable` по собственным пределам клиента (2 с на соединение вместе с
  рукопожатием TLS, 10 с на запрос).
- Имя устройства: при подключении — имя, под которым устройство подключалось, без пробелов по
  краям (так его хранит хост); `device_refresh` и `device_select_line` берут имя из ответа хоста.
  Переименование в офисе ревизии не берёт и доходит до станции со следующей ревизией или
  переподключением.
- `device_forget` принимает `keepUnsent` (необязательно): без него отказ `unsent_facts`, если у
  записей `outbox` текущего подключения нет квитанции (`acked_at IS NULL`), а при нечитаемом
  `device.json` — у записей любого подключения; `keepUnsent: true` — подтверждение (выход Б вопроса
  В7), записи остаются на диске. Подсчёт идёт в той же транзакции, что и очистка.
- Классы таблиц — `TABLE_CLASSES` в `local_db.rs` (`Disposable`, `DeviceData`, `Workstation`); план,
  который добавляет таблицу, добавляет её класс в той же правке. Таблица `outbox` плана 2a5 несёт
  столбцы `host_id`, `device_id`, `acked_at`; внешних ключей между таблицами разных классов нет.
- Нечитаемая база переносится вместе с `-journal`, если он есть, а новая открывается сразу, без
  перезапуска; файл, который не удалось перенести, возвращает на место уже перенесённые.
- COM-принтер в автоматических тестах не проверяется (macOS не даёт настроек порта на
  псевдотерминале) — только вручную; код под `cfg(windows)` (спулер и запрос питания) проверен
  крейтом-пробником под `x86_64-pc-windows-msvc`, сама оболочка — только в
  `standalone-windows-build`.
```

- [ ] **Step 7: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src/hardware/hardware.ts apps/standalone/test/hardware.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: чисто; `lint` и `typecheck` без предупреждений.

- [ ] **Step 8: Commit**

```bash
git add apps/standalone/src/hardware/hardware.ts apps/standalone/test/hardware.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "feat(standalone): the webview's wrappers for printing, COM scanners and power; docs for the stage 2a shell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 68 файлов, 1776 тестов (до плана 67 и 1744). Под нагрузкой (параллельные сборки Cargo) на копии плана один раз упал по сроку 5 с чужой тест `test/template-editor.test.tsx` («marks «Шаблоны» in the menu…»), который этот план не трогает; отдельно и при повторе полного прогона он проходит. Такой сбой записать в отчёт, не поднимать сроки.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок и предупреждений; у `build` — только прежнее предупреждение Vite о чанке больше 500 kB (на копии плана главный чанк — 902,52 kB).

- [ ] **Step 2: Cargo**

Оболочка встраивает сборку вебвью из шага 1.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-run`
Expected: чисто; все наборы собираются без предупреждений.

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db --test lockdown`
Expected: PASS — 96 тестов в 3 наборах (библиотека 76, `local_db` 16, `lockdown` 4).

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace`
Expected: PASS — 45 наборов, 566 тестов (хост 359, `proto` 45, оболочка 162: библиотека 76, `claim` 4, `connection` 6, `device` 13, `host_probe` 2, `host_probe_proxy` 1, `host_request_timeout` 3, `ipc` 18, `line` 15, `local_db` 16, `lockdown` 4, `printer` 4).

Run (вне песочницы, при установленной цели): `CARGO_TARGET_DIR=/tmp/claude/p2a4-probe/target cargo check --offline --manifest-path /tmp/claude/p2a4-probe/Cargo.toml --target x86_64-pc-windows-msvc`
Expected: `Finished` без предупреждений (`power/windows.rs` и `printer/spooler.rs` с признаками задачи 1).

- [ ] **Step 3: Чистота и границы**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check 366e87f06`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat 366e87f06 -- apps/station packages apps/standalone/host apps/standalone/proto pnpm-lock.yaml apps/standalone/package.json`
Expected: пусто. `git diff --stat 366e87f06 -- apps/standalone/Cargo.lock .github/workflows/ci.yml apps/standalone/src-tauri/Cargo.toml` — только правки задачи 1 (`Cargo.lock` — 79 вставок).

- [ ] **Step 4: Что не проверить в песочнице и без Windows**

Записать в отчёт, что не проверено (а не «проверено»):

- сборка оболочки для Windows: код под `cfg(windows)` (`printer/spooler.rs`, `power/windows.rs`, `lockdown.rs`) и признаки задачи 1 компилируются только в `standalone-windows-build`; локально — крейт-пробник с теми же файлами, без Tauri и `aws-lc-sys`;
- поведение заглушек TCP на Windows (сброс соединения при закрытии с непрочитанными данными, тайм-аут записи `SO_SNDTIMEO`) — тесты `tests/printer.rs` на Windows идут только в CI;
- печать на настоящих Zebra (ZPL) и TSC (TSPL) 203/300 dpi по сети 9100, через COM и USB-спулер; классы `not_sent`/`outcome_unknown` на настоящих сбоях; принимает ли спулер задание при выключенном принтере; `spooler_unavailable` при остановленной службе;
- COM-принтер вообще (заглушки нет: macOS не настраивает порт на псевдотерминале);
- COM-сканеры: перечисление портов, CR/LF, байт GS, префиксы `]d2` и `]C1`, отключение и возврат, два порта; `list_serial_ports` в CI Linux (тест принимает и `serial_unavailable`);
- `set_system_awake` на Windows: `powercfg /requests` при `true` и после `false`; в CI тест IPC принимает и отказ `power_request_failed`;
- переименование устройства в офисе доходит до станции со следующей ревизией или переподключением — проверено тестами `line.rs` на настоящем хосте, но не на станции с экраном;
- `keepUnsent` и `unsent_facts` с настоящей `outbox` — до миграции плана 2a5 проверено на временной таблице из трёх столбцов.

---

## Перенесено

- Экран отказа устройства с подтверждением «забывания» и числом неотправленных записей (`keepUnsent: true`), отказ `unsent_facts` на экранах «Подключить заново» и «Сбросить подключение» — план 2a5 (вопрос В7).
- COM-источник сканов (`ScanSource` поверх `onScan`), касание таймера бездействия каждым COM-сканом и выбор источника — план 2a6; `set_system_awake` из рабочего экрана, маршрутизация принтеров, очередь отправок на один адрес, задания печати и восстановление — план 2a7.
- Строка состояния с именем устройства — план 2a5.
- Переименование устройства в офисе не берёт ревизии хоста: станция видит новое имя только со следующей ревизией или переподключением. Если нужно сразу — ревизия без записи ленты на переименование (правка хоста).
- Журнал процесса оболочки — `eprintln!` в stderr; в сборке Windows без консоли он невидим. Файловый журнал оболочки — этап 5 (пакет поддержки).
- Нечитаемая база, перенесённая в сторону, остаётся на диске с хешами PIN и бейджей (принятый риск В7); её разбор и экспорт неотправленного — этап 5.
- Заголовки применённых миграций `0001`–`0005` говорят, что `clear_copies` берёт каждую таблицу; применённая миграция не правится.
- Из перенесённого 1f2 здесь закрыты: шаг владельца с признаками киоск-режима, `set_system_awake` и `Win32_System_Power`, имя устройства в `DeviceStatus` и `device.json`. Остальное перенесённое 1f2 — без изменений.

## Отклонения при исполнении
