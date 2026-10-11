# План ДРВ: печать через драйвер принтера Windows на станции автонома (перенос облачного #696) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Профиль принтера станции автонома получает способ печати: «На языке принтера (ZPL / TSPL)» — как сегодня (TCP, COM, очередь Windows в режиме RAW) — или «Через драйвер Windows», допустимый только для очереди Windows. В режиме драйвера этикетка рендерится в монохромный растр `mono-raster-v1` (`@markiro/domain` `renderMonoLabel` + `encodeMonoRaster`) при разрешении профиля и уходит графикой через спулер Windows (GDI, масштаб 1:1, проверка бумаги и DPI драйвера до `StartDocW`). Сохраняется вся дисциплина печати цеха: задание пишет `sending` до отправки, неизвестный исход никогда не отправляется повторно сам, предел ответа 20 с, отказ до старта (`before_start`) — безопасный `failed`, а «Проверить очередь Windows» показывает оператору, есть ли задание в очереди. Настройка рабочего места показывает выбор способа печати, подсказку драйвера и пробную печать в обоих режимах.

**Architecture:**

- Оболочка (задачи 1–2): `src-tauri/src/printer/raster.rs` — переносимый разбор страницы `mono-raster-v1` (копия облачного `printer_raster.rs`, общий фикстурный вектор `packages/domain/test/fixtures/mono-raster-v1.json`); `src-tauri/src/printer/driver.rs` — печать через драйвер (перенос `printer_windows.rs` из 1329be61c без проверки до отправки и без листа A4): порядок вызовов GDI и фаза сбоя — в `submit` над трейтом `WindowsPrintApi`, тестируемом на любой ОС, а всё небезопасное — `mod native` под `cfg(windows)`; `src-tauri/src/printer/driver_commands.rs` — три команды Tauri с пределом 30 с. Формы ответов закреплены в `tests/fixtures/hardware-shapes.json` (Rust и Zod читают один файл).
- Обёртка вебвью (задача 3): `src/hardware/hardware.ts` — схемы ответа драйвера, `windowsPrintResult` (ответ оболочки → `PrintResult`: `sent`, коды отказа до старта, `driver_unknown`), `createTauriWindowsPrinting`.
- Профиль и рендер (задача 4): `PrinterProfile.mode?: "raw" | "windows_driver"` в JSON ключа `printers` таблицы `workstation_settings` (миграции нет: профиль без `mode` — RAW, как все профили до этого плана), `printerMode`, `printerFormatText`, ветка драйвера в `renderLabel` со строгим `rasterizeDriverText`.
- Отправка (задача 5): `PrintRuntime.send(jobId, target, bytes, mode)` — тот же порядок «по одному на адрес» и тот же предел 20 с, в режиме драйвера — `printWindowsRaster` с именем документа `Markiro:<uuid>`; квитанция спулера последней отправки задания хранится в памяти рантайма (`checkWindowsJob`); коды `queue_unavailable`, `geometry_mismatch`, `driver_not_started` (failed) и `driver_unknown` (unknown); `printAgain` рендерит заново при смене способа печати.
- Экраны (задача 6): настройка рабочего места («Способ печати», подсказка, сводка «Драйвер Windows · 203 dpi»), панель этикетки («Проверить очередь Windows»), формат принтера словами во всех строках «Печать пойдёт на принтер…».
- Документы (задача 7): `apps/standalone/AGENTS.md`, §28 спецификации пилота, ручная проверка в `docs/runbooks/standalone-install.md`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui`, `@markiro/domain` (`renderMonoLabel`, `encodeMonoRaster`, `decodeMonoRaster`, `withPrinterDpi`), Vitest 4 + jsdom + `node:sqlite`; Rust — Tauri 2.11, tokio 1.53 (`time`), base64 0.22.1, serde, `windows-sys` 0.61.2 (новая функция `Win32_Storage_Xps` для `StartDocW`/`DOCINFOW`).

**Спецификации и источники:**

- Облако: PR #696 (коммит `1329be61c`): `apps/station/src-tauri/src/printer_raster.rs`, `printer_windows.rs`, `printer_windows_commands.rs`, `apps/station/src/lib/hardware.ts` (`WindowsPrinting`), `print-artifact.ts`, `print-deliveries.ts`, `printer-routing.ts` (`printerMode`), `rasterizer.ts` (`rasterizeDriverText`), `ui/WindowsDeliveryStatus.tsx`, `ui/setup/PrinterSetupPanel.tsx`, `docs/acceptance/station-windows-printing.md`, `docs/architecture.md` (абзац про `windows_driver`). Читать: `git -C <integ> show 1329be61c -- <путь>`.
- Автоном сегодня: `src-tauri/src/printer.rs`, `printer/spooler.rs`, `src/hardware/hardware.ts`, `src/floor/print/*` (`print-runtime.ts`, `print-jobs.ts`, `print-resolution.ts`, `label-render.ts`, `LabelPanel.tsx`), `src/floor/setup/*` (`workstation-settings.ts`, `printer-draft.ts`, `WorkstationSetup.tsx`).
- `apps/standalone/AGENTS.md` — «Hardware», «Floor printing», «Verification»; спецификация пилота `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (§24 — последний раздел до этого плана, этот план пишет §28).
- Распоряжение владельца 2026-10-11 (`.superpowers/sdd/OWNER-DECISIONS.md`, «DECISIONS 2026-10-11»): перенести в станцию автонома новую логику облачной станции, включая печать через драйверы принтера; максимальная скорость.

## Допущения

Решения планировщика (контроллер принимает рекомендованные варианты; поменять — правка названного места):

- **Д1 — миграции нет.** Способ печати — поле `mode` профиля в JSON ключа `printers` таблицы `workstation_settings` (`TableClass::Workstation`, хоста не пересекает: ни Zod/proto, ни фикстур протокола план не трогает). Профиль без `mode` — RAW; `profileOf` пишет `mode` только для драйвера, поэтому все сохранённые профили и снимки принтера в `floor_print_jobs.printer` читаются как раньше и 27 тестовых файлов с литералами профилей не меняются. Номер `0014`, отведённый ДРВ на случай столбца, не занят.
- **Д2 — квитанция спулера живёт в памяти рантайма печати, а не в базе.** Облако хранит квитанции в таблице `printer_deliveries`; здесь для этого нужен столбец `floor_print_jobs` (миграция, правка закреплённого текста `OPEN_JOB_READ` в `src-tauri/tests/local_db.rs` и проверки непрерывности версий журнала миграций, `1..=count`, которую разрыв `0010…0014` уронил бы). Квитанция — только подсказка оператору («Задание находится в очереди»), она никогда не подтверждает печать и ничего не разрешает; после перезапуска задание `sending` всё равно становится `interrupted` без квитанции и в облаке. Рантайм запоминает и квитанцию ответа, пришедшего после предела 20 с (облако — тоже, через `receipt_json IS NULL`), а новая отправка того же задания её стирает. Хранение в базе — «Перенесено».
- **Д3 — без отдельной проверки до отправки (`preflight_windows_raster`).** В облаке её смысл — записать `failed_before_send`, не помечая задание отправляемым. Здесь `print_windows_raster` сама открывает очередь, настраивает драйвер и проверяет геометрию до `StartDocW` и отвечает `before_start`, а задание из `sending` переходит в безопасный `failed` (как `not_sent` у RAW). Вторая команда удвоила бы вызовы драйвера на каждую этикетку. Команду (с параметрами листа) добавит план A4, если понадобится.
- **Д4 — имя документа `Markiro:<uuid>` новое на каждую отправку** (как в облаке), его генерирует рантайм (`newDocumentId`); оболочка отказывает другому имени (`invalid_artifact`) и сверяет имя в `GetJobW` (`identity_mismatch`). UUID проверяется вручную (36 знаков, дефисы на 8/13/18/23) — без новой зависимости `uuid` и без изменения `Cargo.lock`.
- **Д5 — коды.** Отказ драйвера до старта отображается в коды заданий: `unsupported_platform` → `unsupported`, `invalid_artifact` → `invalid_payload`, `queue_unavailable` → `queue_unavailable`, `geometry_mismatch` → `geometry_mismatch`, `driver_failure` → `driver_not_started` (все `failed`); `delivery_unknown`, сбой IPC и ответ не по схеме → `driver_unknown` (`unknown`). Квитанция, чья очередь или имя документа не совпали с отправленными, отбрасывается, а «успех» с такой квитанцией читается как `driver_unknown` (облако бросает `Print receipt identity changed`). Столбец `error_code` без `CHECK`, новые коды миграции не требуют.
- **Д6 — «Проверить очередь Windows» — на панели этикетки при `unknown` и при ждущей проверке сканом, только для принтера в режиме драйвера.** Без квитанции — «Номер задания Windows неизвестен: посмотрите очередь принтера в Windows». Сохранённого предпросмотра растра (`LabelRasterPreview`) и кнопки «Проверено оператором — закрыть уведомление» нет: решения «Этикетка напечаталась» / «Напечатать снова» / «Продолжить без этикетки» панели уже закрывают неизвестный исход.
- **Д7 — выбор способа печати показывается только для очереди Windows и только когда оболочка отвечает `supports_windows_printing = true`** (или профиль уже в режиме драйвера — чтобы его можно было вернуть в RAW на машине разработчика). Язык принтера в режиме драйвера скрыт, но хранится (как в облаке: последний язык RAW для перенастройки). Разрешение обязательно в обоих режимах: растр рисуется при DPI профиля, а драйвер обязан совпасть.
- **Д8 — `rasterizeDriverText` строже обычного:** без `document.fonts` или без загруженного шрифта IBM Plex рендер отказывает (`RasterUnavailableError` → `render_failed`), чтобы в байты задания не замёрз запасной шрифт (облако, `rasterizeDriverText`). Тесты передают свой растеризатор явно.
- **Д9 — Windows-код проверяется пробным крейтом и CI.** `mod native` компилируется только на Windows: локально — `cargo check`/`cargo clippy` пробного крейта вне репозитория для `x86_64-pc-windows-msvc` (крейт подключает `raster.rs` и `driver.rs` по абсолютным путям, как облачный `tools/station-printer-tests`, но в репозиторий не кладётся — так 2a4 проверял `spooler.rs`), окончательно — задание `standalone-windows-build` (`cargo test --workspace` на Windows). Поэтому команды Tauri — в отдельном файле `driver_commands.rs`: `driver.rs` зависит только от `base64`, `serde` и `windows-sys`.

## Global Constraints

**Распоряжение владельца и спецификация** (дословные требования)

- «доделываем все, что ты вынес … надо перенести новую логику в станцию из облачной, включая печать через драйвера принтера»; «Все делаем также максимально быстро».
- Облачный инвариант (`docs/architecture.md`, #696): «The default and every legacy profile remain RAW ZPL/TSPL. Driver mode freezes a validated `mono-raster-v1` page at 203 or 300 DPI and prints it through GDI at 1:1 scale … Queue acceptance or an absent spooler job never establishes physical verification.»
- Печать цеха автонома (AGENTS «Floor printing», «Hardware»): `sending` пишется до отправки; неизвестный исход никогда не отправляется повторно без решения оператора; одна отправка за раз на адрес; предел ответа `PRINT_SEND_LIMIT_MS` = 20 000 мс, после него — `timeout` (unknown), адрес занят до настоящего конца вызова оболочки; системный текст ошибок не пересекает IPC.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` (`as const` — не приведение); `import type` для типов; необязательные поля собираются условным `...(x ? { k: x } : {})`.
- Экраны цеха: только `@markiro/ui`, каждая кнопка и выбор — `size="floor"` (≥ 64 px); состояние словами; тексты — ключи `src/i18n/ru.json` (ключи уникальны, новые — внутри существующих объектов).
- Тесты React: `findBy…`/`waitFor` вместо времени; новые файлы прогнать 5 раз подряд (стенд с задержанным `setImmediate`, если он есть в дереве, — один раз).
- Rust: `cargo fmt` чистый, сборка без предупреждений на macOS/Linux; `Cargo.toml` оболочки меняется только функцией `Win32_Storage_Xps` у `windows-sys`; `Cargo.lock` не меняется (функции не записываются в lock — проверить `git diff --stat`).
- Применённые миграции (оболочка `0001`–`0009`, хост `0001`–`0012`) не меняются; новых миграций план не добавляет.
- Не меняются: `apps/station`, `packages/*`, хост и `proto` автонома, `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml` (Windows-задание уже гоняет `cargo test --workspace`), `tools/ci/affected.mjs` (`packages/domain` уже включает задания автонома).
- Коммиты — явные пути, сообщение из файла, последняя строка ровно одна: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены; без `git stash`.

## Контракт для плана A4 (следующий в потоке PRT)

- `printer/raster.rs` (`decode`, `check_geometry`, `dib_pixels`, `Caps`, `MAX_BYTES`) и `printer/driver.rs` (`Receipt`, `Failure`, `Outcome`, `Observation`, `submit`, `native::Device::open`) — точка расширения листа A4: облачный `printer_sheet.rs` добавляет `WindowsPageOptions` и отпечаток геометрии; A4 расширяет `print_windows_raster` необязательными параметрами и добавляет свою команду геометрии, не меняя ответов этого плана (фикстура `hardware-shapes.json`).
- Вебвью: `WindowsPrinting`, `windowsPrintResult`, `PrintRuntime.send(…, mode)`, `printerMode`, `printerFormatText`, `rasterizeDriverText`, ветка `windows_driver` в `renderLabel` (принимает только термоэтикетку; `renderMonoLabel` уже принимает `options.logo` для #703).
- Коды заданий `queue_unavailable`, `geometry_mismatch`, `driver_not_started`, `driver_unknown` и тексты `floor.print.codes.*`, `floor.print.queue.*`.

## Заметки для исполнения

- Рабочее дерево — ветка интеграции (`claude/integration` или её наследник потока PRT); все пути — от корня репозитория. Свежее дерево: `pnpm install --frozen-lockfile`, затем `pnpm turbo run build --filter='@markiro/standalone^...'` (собирает `@markiro/domain` с `renderMonoLabel`/`encodeMonoRaster` — без сборки тесты увидят старый `dist`).
- `tauri::generate_context!` требует `apps/standalone/dist`: перед `cargo test` оболочки — `pnpm --filter @markiro/standalone build` (или существующая заглушка `dist`, если её кладёт ваш сценарий).
- Узкие прогоны: `pnpm --filter @markiro/standalone exec vitest run test/<файл>`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib printer::`; `… -p markiro-standalone --test ipc driver_printing`; `… --test hardware_shapes`.
- Песочница: если `cargo` не может взять блокировку в `~/.cargo` или открыть порт (ipc-тесты печати слушают 127.0.0.1), перезапустить команду вне песочницы и записать это в отчёт.
- Якоря «найти/заменить» взяты из дерева интеграции на `2c726efba`; если файл сдвинулся, править по смыслу и записать отклонение. Prettier плана снял ведущие отступы у TS/TSX/JSON-фрагментов, которые разбираются как код: в Edit брать отступ из самого файла (фрагменты Rust и TOML — с отступами файла).
- `graphify update .` после правок, если в дереве есть `graphify-out/graph.json`.

## Файлы

Создаются:

- `apps/standalone/src-tauri/src/printer/raster.rs` — разбор `mono-raster-v1`, геометрия, строки DIB (задача 1).
- `apps/standalone/src-tauri/src/printer/driver.rs` — печать через драйвер: формы ответа, `print`, `observe`, `submit`, `native` (задача 1).
- `apps/standalone/src-tauri/src/printer/driver_commands.rs` — команды Tauri (задача 2).
- `apps/standalone/src/floor/print/printer-format.ts` — формат принтера словами (задача 4).
- Тесты: `apps/standalone/test/windows-printing.test.ts` (задача 3), `test/printer-driver-profile.test.ts` (задача 4), `test/floor-print-driver.test.ts` (задача 5), `test/floor-print-driver-ui.test.tsx` (задача 6).

Меняются:

- `apps/standalone/src-tauri/Cargo.toml` (функция `Win32_Storage_Xps`), `src-tauri/src/printer.rs` (объявления модулей), `src-tauri/src/lib.rs` (три команды), `src-tauri/tests/ipc.rs`, `src-tauri/tests/hardware_shapes.rs`, `src-tauri/tests/fixtures/hardware-shapes.json`.
- `apps/standalone/src/hardware/hardware.ts`, `src/labels/rasterizer.ts`, `src/floor/setup/workstation-settings.ts`, `src/floor/setup/printer-draft.ts`, `src/floor/setup/WorkstationSetup.tsx`, `src/floor/print/label-emitters.ts`, `src/floor/print/label-render.ts`, `src/floor/print/print-runtime.ts`, `src/floor/print/print-jobs.ts`, `src/floor/print/print-resolution.ts`, `src/floor/print/LabelPanel.tsx`, `src/floor/exceptions/ExceptionFlow.tsx`, `src/floor/work/WorkScreen.tsx`, `src/app/App.tsx`, `src/i18n/ru.json`.
- `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`, `docs/runbooks/standalone-install.md`.

---

### Task 1: Оболочка — разбор растра `mono-raster-v1` и ядро печати через драйвер

**Files:**

- Create: `apps/standalone/src-tauri/src/printer/raster.rs`
- Create: `apps/standalone/src-tauri/src/printer/driver.rs`
- Modify: `apps/standalone/src-tauri/src/printer.rs` (объявления модулей)
- Modify: `apps/standalone/src-tauri/Cargo.toml` (функция `windows-sys`)

**Interfaces:** `printer::raster::{decode, check_geometry, dib_pixels, Raster, Caps, MAX_BYTES}`; `printer::driver::{print, observe, Receipt, Failure, Outcome, Observation}` (+ приватные `WindowsPrintApi`, `submit`, `markiro_document`, `mod native` под `cfg(windows)`).

- [ ] **Step 1: Объявить модули.** В `apps/standalone/src-tauri/src/printer.rs` найти

```rust
pub mod spooler;
```

и заменить на

```rust
pub mod driver;
pub mod driver_commands;
pub mod raster;
pub mod spooler;
```

Модуль `driver_commands` создаётся в задаче 2; чтобы задача 1 собиралась отдельно, в этом шаге создать `apps/standalone/src-tauri/src/printer/driver_commands.rs` с одной строкой `//! Filled by plan ДРВ task 2.` (задача 2 заменит файл целиком). Также дописать в модульный комментарий `printer.rs` после абзаца про RAW (перед `use std::io::Write;`) строку:

```rust
//!
//! Printing through a Windows printer driver (a `mono-raster-v1` page drawn
//! with GDI, plan ДРВ) lives in `printer/driver.rs`; this module stays RAW.
```

- [ ] **Step 2: Функция `windows-sys`.** В `apps/standalone/src-tauri/Cargo.toml` найти

```toml
  "Win32_Security_Cryptography",
  "Win32_System_Power",
```

и заменить на

```toml
  "Win32_Security_Cryptography",
  "Win32_Storage_Xps",
  "Win32_System_Power",
```

а в комментарии над `windows-sys` после строки `# Win32_Security_Cryptography would bring Win32_Security in anyway).` добавить строку `# Win32_Storage_Xps: StartDocW and DOCINFOW of driver printing (printer/driver.rs).`

- [ ] **Step 3: Написать `raster.rs` (тесты внутри — сначала падают, пока нет `decode`; файл целиком).**

Create `apps/standalone/src-tauri/src/printer/raster.rs`:

```rust
//! The `mono-raster-v1` page of driver printing (plan ДРВ), ported from the
//! cloud station's `printer_raster.rs` (#696): the webview's
//! `encodeMonoRaster` (`@markiro/domain`) writes it, this module reads it.
//! No OS calls: untrusted IPC bytes are checked before anything is allocated
//! for them, and every check runs on every OS.
//!
//! Layout (little-endian): magic `MKRMNO1\0`; dpi (203 or 300), width and
//! height in dots, row stride in bytes (`ceil(width / 8)`); width and height
//! in millimetres (`f64`, 10–300, the dots being `round(mm × dpi / 25.4)`);
//! the pixel length, a zero word, and the required bounds `[left, top,
//! right, bottom]` in dots; then the rows, top-down, MSB first, 1 = black. A
//! black dot outside the bounds or past the width refuses the page.

/// The largest page this module reads (the domain's `MONO_RASTER_MAX_BYTES`).
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// A checked page; `pixels` borrows the caller's bytes.
#[derive(Debug)]
pub struct Raster<'a> {
    pub dpi: i32,
    pub width: i32,
    pub height: i32,
    pub width_mm: f64,
    pub height_mm: f64,
    pub stride: usize,
    pub bounds: [i32; 4],
    pub pixels: &'a [u8],
}

/// Reads a page, or refuses it whole.
#[allow(clippy::result_unit_err)]
pub fn decode(bytes: &[u8]) -> Result<Raster<'_>, ()> {
    if bytes.len() < 64 || bytes.len() > MAX_BYTES || &bytes[..8] != b"MKRMNO1\0" {
        return Err(());
    }
    let u = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let f = |i: usize| {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[i..i + 8]);
        f64::from_le_bytes(word)
    };
    let dpi = u(8);
    let (w, h, stride) = (u(12), u(16), u(20));
    let (wm, hm) = (f(24), f(32));
    if ![203, 300].contains(&dpi)
        || ![wm, hm]
            .iter()
            .all(|n| n.is_finite() && (10.0..=300.0).contains(n))
        || w != (wm * dpi as f64 / 25.4).round() as u32
        || h != (hm * dpi as f64 / 25.4).round() as u32
        || stride != w.div_ceil(8)
        || u(44) != 0
    {
        return Err(());
    }
    let length = (stride as usize).checked_mul(h as usize).ok_or(())?;
    if length.checked_add(64) != Some(bytes.len()) || u(40) as usize != length {
        return Err(());
    }
    let b = [u(48), u(52), u(56), u(60)];
    if b[0] > b[2] || b[1] > b[3] || b[2] > w || b[3] > h {
        return Err(());
    }
    let pixels = &bytes[64..];
    for y in 0..h {
        for x in 0..stride * 8 {
            if pixels[(y * stride + x / 8) as usize] & (0x80 >> (x % 8)) != 0
                && (x >= w || x < b[0] || x >= b[2] || y < b[1] || y >= b[3])
            {
                return Err(());
            }
        }
    }
    Ok(Raster {
        dpi: dpi as i32,
        width: w as i32,
        height: h as i32,
        width_mm: wm,
        height_mm: hm,
        stride: stride as usize,
        bounds: b.map(|n| n as i32),
        pixels,
    })
}

/// What the driver's device context reports (`GetDeviceCaps`), in dots.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub dpi_x: i32,
    pub dpi_y: i32,
    pub width: i32,
    pub height: i32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub printable_width: i32,
    pub printable_height: i32,
}

/// The driver prints the page 1:1: the same resolution on both axes, the
/// paper within one dot of the page, and the page's required bounds (its
/// barcodes' quiet zones) inside the printable area.
#[allow(clippy::result_unit_err)]
pub fn check_geometry(page: &Raster<'_>, c: Caps) -> Result<(), ()> {
    let [l, t, r, b] = page.bounds;
    if ![c.width, c.height, c.printable_width, c.printable_height]
        .iter()
        .all(|n| (1..=10000).contains(n))
        || ![c.offset_x, c.offset_y]
            .iter()
            .all(|n| (0..=10000).contains(n))
    {
        return Err(());
    }
    if c.dpi_x != page.dpi
        || c.dpi_y != page.dpi
        || (c.width - page.width).abs() > 1
        || (c.height - page.height).abs() > 1
        || c.offset_x
            .checked_add(c.printable_width)
            .filter(|n| *n <= c.width + 1)
            .is_none()
        || c.offset_y
            .checked_add(c.printable_height)
            .filter(|n| *n <= c.height + 1)
            .is_none()
        || (r > l
            && b > t
            && (l < c.offset_x
                || t < c.offset_y
                || r > c.offset_x + c.printable_width
                || b > c.offset_y + c.printable_height))
    {
        return Err(());
    }
    Ok(())
}

/// The page's rows as a DIB wants them: DWORD-aligned, palette 0 = white,
/// 1 = black.
pub fn dib_pixels(page: &Raster<'_>) -> Vec<u8> {
    let stride = (page.width as usize).div_ceil(32) * 4;
    let mut data = vec![0; stride * page.height as usize];
    for y in 0..page.height as usize {
        data[y * stride..y * stride + page.stride]
            .copy_from_slice(&page.pixels[y * page.stride..(y + 1) * page.stride]);
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared vector: a 10 mm square at 203 dpi with one black dot at (1, 1).
    fn vector() -> Vec<u8> {
        let mut b = vec![0; 864];
        b[..8].copy_from_slice(b"MKRMNO1\0");
        for (i, n) in [
            (8, 203u32),
            (12, 80),
            (16, 80),
            (20, 10),
            (40, 800),
            (48, 1),
            (52, 1),
            (56, 2),
            (60, 2),
        ] {
            b[i..i + 4].copy_from_slice(&n.to_le_bytes());
        }
        b[24..32].copy_from_slice(&10f64.to_le_bytes());
        b[32..40].copy_from_slice(&10f64.to_le_bytes());
        b[74] = 0x40;
        b
    }

    #[test]
    fn the_domain_writes_the_vector_this_module_reads() {
        use base64::Engine;
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/domain/test/fixtures/mono-raster-v1.json"
        ))
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(fixture["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, vector());
        assert_eq!(decode(&bytes).unwrap().pixels[10], 0x40);
    }

    #[test]
    fn a_page_becomes_dword_aligned_dib_rows() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        let dib = dib_pixels(&page);
        assert_eq!(dib.len(), 960);
        assert_eq!(dib[12], 0x40);
        assert_eq!(dib.iter().filter(|b| **b != 0).count(), 1);
    }

    #[test]
    fn a_malformed_page_is_refused_whole() {
        for len in [7, 63, 863, 865] {
            let mut b = vector();
            b.resize(len, 0);
            assert!(decode(&b).is_err(), "length {len}");
        }
        for offset in [8, 12, 20, 40, 44, 56] {
            let mut b = vector();
            b[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(decode(&b).is_err(), "word at {offset}");
        }
        // A black dot outside the required bounds.
        let mut b = vector();
        b[64] = 0x80;
        assert!(decode(&b).is_err());
    }

    #[test]
    fn the_driver_must_hold_the_page_one_to_one() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        let mut c = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 0,
            offset_y: 0,
            printable_width: 80,
            printable_height: 80,
        };
        assert!(check_geometry(&page, c).is_ok());
        // The printable area starts past the required bounds' left edge.
        c.offset_x = 2;
        c.printable_width = 78;
        assert!(check_geometry(&page, c).is_err());
        c.offset_x = 1;
        c.printable_width = 79;
        assert!(check_geometry(&page, c).is_ok());
        c.dpi_y = 300;
        assert!(check_geometry(&page, c).is_err());
    }
}
```

- [ ] **Step 4: Написать `driver.rs` (файл целиком).**

Create `apps/standalone/src-tauri/src/printer/driver.rs`:

```rust
//! Printing through the Windows printer driver (plan ДРВ), ported from the
//! cloud station's `printer_windows.rs` (#696, label pages only). The webview
//! renders the label as a `mono-raster-v1` page at the printer profile's
//! resolution; this module checks the page (`super::raster::decode`), sets
//! the driver's paper to the page's size and resolution at 1:1 scale,
//! refuses a driver whose resolution, paper or printable area does not hold
//! the page (`geometry_mismatch`) and draws it with GDI. A printer language
//! never goes through here: RAW ZPL/TSPL stays in `printer.rs` and
//! `printer/spooler.rs`.
//!
//! A refusal has a code and a phase. `before_start` — nothing reached the
//! spooler, so printing again cannot double a label. `delivery_unknown` —
//! `StartDocW` was called (an RPC answer can be lost after the spooler took
//! the job) or a call after it failed: a label may come out, and only the
//! operator decides; the receipt, when there is one, names the spooler job.
//! The order of the GDI calls and the phase a failure leaves live in
//! [`submit`], generic over [`WindowsPrintApi`], so they run and are tested on
//! every OS. Only `native` (everything unsafe) is `cfg(windows)`: it uses
//! `std` and `windows-sys` only and compiles in `standalone-windows-build`.

use super::raster::{decode, Raster, MAX_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// The spooler job a driver print started: its queue, its job id and the
/// document name the webview chose (`Markiro:<uuid>`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub queue: String,
    pub job_id: u32,
    pub document_name: String,
}

/// A failed driver print: `code` is `unsupported_platform`,
/// `invalid_artifact`, `queue_unavailable`, `geometry_mismatch` or
/// `driver_failure`; `phase` is `before_start` or `delivery_unknown`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}

impl Failure {
    fn before(code: &'static str) -> Self {
        Self {
            code,
            phase: "before_start",
            receipt: None,
        }
    }
}

/// `print_windows_raster`'s answer: `{ ok: true, receipt }` or
/// `{ ok: false, error }` (`src/hardware/hardware.ts`,
/// `windowsPrintOutcomeSchema`; pinned by `tests/fixtures/hardware-shapes.json`).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Success { ok: bool, receipt: Receipt },
    Failed { ok: bool, error: Failure },
}

/// What the spooler says of a receipt's job. Diagnostic only: an absent job
/// never means a printed label.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Observation {
    Present {
        #[serde(rename = "statusFlags")]
        status_flags: u32,
    },
    Absent,
    IdentityMismatch,
    Unavailable,
}

fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0')
}

/// `Markiro:` and a UUID in its 36-character hyphenated form: the webview's
/// own document name, never a name of anybody's choosing.
fn markiro_document(name: &str) -> bool {
    let Some(id) = name.strip_prefix("Markiro:") else {
        return false;
    };
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The page's bytes, bounded before base64 is decoded.
fn artifact(payload: &str) -> Result<Vec<u8>, Failure> {
    if payload.len() > 4 * MAX_BYTES.div_ceil(3) {
        return Err(Failure::before("invalid_artifact"));
    }
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| Failure::before("invalid_artifact"))?;
    decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
    Ok(bytes)
}

/// Prints one page to `queue`, blocking. Every refusal before `StartDocW` is
/// `before_start`; from `StartDocW` on, `delivery_unknown`. Never retries.
pub fn print(queue: String, payload_base64: String, document_name: String) -> Outcome {
    let result = (|| {
        let bytes = artifact(&payload_base64)?;
        let page = decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
        if !valid_name(&queue) {
            return Err(Failure::before("queue_unavailable"));
        }
        if !markiro_document(&document_name) {
            return Err(Failure::before("invalid_artifact"));
        }
        #[cfg(windows)]
        {
            let mut device = native::Device::open(&queue, &page)?;
            submit(&mut device, &page, &queue, &document_name)
        }
        #[cfg(not(windows))]
        {
            let _ = page;
            Err(Failure::before("unsupported_platform"))
        }
    })();
    match result {
        Ok(receipt) => Outcome::Success { ok: true, receipt },
        Err(error) => Outcome::Failed { ok: false, error },
    }
}

/// The spooler's word on a receipt's job; `unavailable` off Windows.
pub fn observe(receipt: Receipt) -> Observation {
    if !valid_name(&receipt.queue) || !valid_name(&receipt.document_name) || receipt.job_id == 0 {
        return Observation::Unavailable;
    }
    #[cfg(windows)]
    {
        native::observe(&receipt)
    }
    #[cfg(not(windows))]
    {
        Observation::Unavailable
    }
}

/// The GDI calls of one page, in the order [`submit`] makes them.
#[cfg_attr(not(windows), allow(dead_code))]
trait WindowsPrintApi {
    fn begin(&mut self, name: &str) -> Result<u32, ()>;
    fn page(&mut self) -> Result<(), ()>;
    fn draw(&mut self, page: &Raster<'_>) -> Result<(), ()>;
    fn end_page(&mut self) -> Result<(), ()>;
    fn end(&mut self) -> Result<(), ()>;
    fn abort(&mut self);
}

/// One document of one page. A failed `StartDocW` is `delivery_unknown` too:
/// its RPC answer can be lost after the spooler took the job. After it, the
/// first failure aborts the document and keeps the receipt.
#[cfg_attr(not(windows), allow(dead_code))]
fn submit(
    api: &mut impl WindowsPrintApi,
    page: &Raster<'_>,
    queue: &str,
    name: &str,
) -> Result<Receipt, Failure> {
    let job_id = api.begin(name).map_err(|_| Failure {
        code: "driver_failure",
        phase: "delivery_unknown",
        receipt: None,
    })?;
    let receipt = Receipt {
        queue: queue.into(),
        job_id,
        document_name: name.into(),
    };
    if api
        .page()
        .and_then(|_| api.draw(page))
        .and_then(|_| api.end_page())
        .and_then(|_| api.end())
        .is_err()
    {
        api.abort();
        return Err(Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: Some(receipt),
        });
    }
    Ok(receipt)
}

#[cfg(windows)]
mod native {
    use super::super::raster::{check_geometry, dib_pixels, Caps};
    use super::*;
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Graphics::{Gdi::*, Printing::*},
        Storage::Xps::*,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    struct Queue(PRINTER_HANDLE);

    impl Drop for Queue {
        fn drop(&mut self) {
            unsafe {
                ClosePrinter(self.0);
            }
        }
    }

    fn queue(name: &str) -> Result<Queue, Failure> {
        let mut h = PRINTER_HANDLE::default();
        if unsafe { OpenPrinterW(wide(name).as_ptr(), &mut h, null_mut()) } == 0 {
            return Err(Failure::before("queue_unavailable"));
        }
        Ok(Queue(h))
    }

    pub(super) struct Device {
        dc: HDC,
        caps: Caps,
    }

    impl Drop for Device {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.dc);
            }
        }
    }

    impl Device {
        /// The queue's device context with the driver set to the page:
        /// user paper of the page's millimetres, portrait, one copy, 100 %,
        /// the page's resolution. The driver-private tail of DEVMODE is kept
        /// (a separate output buffer), and the driver's answer is checked.
        pub fn open(name: &str, p: &Raster<'_>) -> Result<Self, Failure> {
            unsafe {
                let q = queue(name)?;
                let name = wide(name);
                let needed =
                    DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), null_mut(), null(), 0);
                if needed < size_of::<DEVMODEW>() as i32 || needed > 1024 * 1024 {
                    return Err(Failure::before("driver_failure"));
                }
                let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
                let dm = buffer.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), dm, null(), DM_OUT_BUFFER)
                    != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                if ((*dm).dmSize as usize) < size_of::<DEVMODEW>()
                    || (*dm).dmSize as usize + (*dm).dmDriverExtra as usize > needed as usize
                {
                    return Err(Failure::before("driver_failure"));
                }
                (*dm).dmFields = ((*dm).dmFields & !DM_FORMNAME)
                    | DM_ORIENTATION
                    | DM_PAPERSIZE
                    | DM_PAPERWIDTH
                    | DM_PAPERLENGTH
                    | DM_COPIES
                    | DM_PRINTQUALITY
                    | DM_YRESOLUTION
                    | DM_SCALE;
                let v = &mut (*dm).Anonymous1.Anonymous1;
                v.dmOrientation = DMORIENT_PORTRAIT as i16;
                v.dmPaperSize = DMPAPER_USER as i16;
                v.dmPaperWidth = (p.width_mm * 10.).round() as i16;
                v.dmPaperLength = (p.height_mm * 10.).round() as i16;
                v.dmCopies = 1;
                v.dmScale = 100;
                v.dmPrintQuality = p.dpi as i16;
                (*dm).dmYResolution = p.dpi as i16;
                let mut output = buffer.clone();
                let out = output.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(
                    null_mut(),
                    q.0,
                    name.as_ptr(),
                    out,
                    dm,
                    DM_IN_BUFFER | DM_OUT_BUFFER,
                ) != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                let v = (*out).Anonymous1.Anonymous1;
                if v.dmOrientation != DMORIENT_PORTRAIT as i16
                    || v.dmCopies != 1
                    || v.dmScale != 100
                {
                    return Err(Failure::before("geometry_mismatch"));
                }
                let dc = CreateDCW(wide("WINSPOOL").as_ptr(), name.as_ptr(), null(), out);
                if dc.is_null() {
                    return Err(Failure::before("driver_failure"));
                }
                let cap = |i| GetDeviceCaps(dc, i as i32);
                let caps = Caps {
                    dpi_x: cap(LOGPIXELSX),
                    dpi_y: cap(LOGPIXELSY),
                    width: cap(PHYSICALWIDTH),
                    height: cap(PHYSICALHEIGHT),
                    offset_x: cap(PHYSICALOFFSETX),
                    offset_y: cap(PHYSICALOFFSETY),
                    printable_width: cap(HORZRES),
                    printable_height: cap(VERTRES),
                };
                let device = Self { dc, caps };
                check_geometry(p, caps).map_err(|_| Failure::before("geometry_mismatch"))?;
                Ok(device)
            }
        }
    }

    impl WindowsPrintApi for Device {
        fn begin(&mut self, name: &str) -> Result<u32, ()> {
            let name = wide(name);
            let info = DOCINFOW {
                cbSize: size_of::<DOCINFOW>() as i32,
                lpszDocName: name.as_ptr(),
                lpszOutput: null(),
                lpszDatatype: null(),
                fwType: 0,
            };
            let id = unsafe { StartDocW(self.dc, &info) };
            if id > 0 {
                Ok(id as u32)
            } else {
                Err(())
            }
        }

        fn page(&mut self) -> Result<(), ()> {
            if unsafe { StartPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn draw(&mut self, p: &Raster<'_>) -> Result<(), ()> {
            #[repr(C)]
            struct Info {
                header: BITMAPINFOHEADER,
                colors: [RGBQUAD; 2],
            }
            let info = Info {
                header: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: p.width,
                    biHeight: -p.height,
                    biPlanes: 1,
                    biBitCount: 1,
                    biCompression: BI_RGB,
                    biClrUsed: 2,
                    ..Default::default()
                },
                colors: [
                    RGBQUAD {
                        rgbBlue: 255,
                        rgbGreen: 255,
                        rgbRed: 255,
                        rgbReserved: 0,
                    },
                    RGBQUAD::default(),
                ],
            };
            let data = dib_pixels(p);
            let c = self.caps;
            let w = (p.width - c.offset_x).min(c.printable_width);
            let h = (p.height - c.offset_y).min(c.printable_height);
            let drawn = unsafe {
                StretchDIBits(
                    self.dc,
                    0,
                    0,
                    w,
                    h,
                    c.offset_x,
                    c.offset_y,
                    w,
                    h,
                    data.as_ptr().cast(),
                    (&info as *const Info).cast(),
                    DIB_RGB_COLORS,
                    SRCCOPY,
                )
            };
            if drawn == h {
                Ok(())
            } else {
                Err(())
            }
        }

        fn end_page(&mut self) -> Result<(), ()> {
            if unsafe { EndPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn end(&mut self) -> Result<(), ()> {
            if unsafe { EndDoc(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn abort(&mut self) {
            unsafe {
                AbortDoc(self.dc);
            }
        }
    }

    /// `GetJobW` level 1: absent (`ERROR_INVALID_PARAMETER`, 87, or
    /// `ERROR_NO_MORE_ITEMS`, 259), present with its status flags, or a job id
    /// the spooler has given to another document.
    pub fn observe(r: &Receipt) -> Observation {
        unsafe {
            let Ok(q) = queue(&r.queue) else {
                return Observation::Unavailable;
            };
            let mut needed = 0;
            let first = GetJobW(q.0, r.job_id, 1, null_mut(), 0, &mut needed);
            if first == 0 {
                let code = std::io::Error::last_os_error().raw_os_error();
                if matches!(code, Some(87) | Some(259)) {
                    return Observation::Absent;
                }
                if code != Some(122) {
                    return Observation::Unavailable;
                }
            }
            if needed < size_of::<JOB_INFO_1W>() as u32 || needed > 1024 * 1024 {
                return Observation::Unavailable;
            }
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let length = needed;
            if GetJobW(
                q.0,
                r.job_id,
                1,
                buffer.as_mut_ptr().cast(),
                length,
                &mut needed,
            ) == 0
            {
                return Observation::Unavailable;
            }
            let job = &*buffer.as_ptr().cast::<JOB_INFO_1W>();
            let start = job.pDocument as usize;
            let low = buffer.as_ptr() as usize;
            let high = low + length as usize;
            if start < low || start >= high || start % 2 != 0 {
                return Observation::Unavailable;
            }
            let chars = std::slice::from_raw_parts(job.pDocument, (high - start) / 2);
            let Some(end) = chars.iter().position(|c| *c == 0) else {
                return Observation::Unavailable;
            };
            if String::from_utf16_lossy(&chars[..end]) != r.document_name {
                return Observation::IdentityMismatch;
            }
            Observation::Present {
                status_flags: job.Status,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";

    #[derive(Default)]
    struct Fake {
        calls: Vec<&'static str>,
        fail: Option<&'static str>,
    }

    impl Fake {
        fn call(&mut self, n: &'static str) -> Result<(), ()> {
            self.calls.push(n);
            if self.fail == Some(n) {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    impl WindowsPrintApi for Fake {
        fn begin(&mut self, _: &str) -> Result<u32, ()> {
            self.call("begin").map(|_| 42)
        }
        fn page(&mut self) -> Result<(), ()> {
            self.call("page")
        }
        fn draw(&mut self, _: &Raster<'_>) -> Result<(), ()> {
            self.call("draw")
        }
        fn end_page(&mut self) -> Result<(), ()> {
            self.call("end_page")
        }
        fn end(&mut self) -> Result<(), ()> {
            self.call("end")
        }
        fn abort(&mut self) {
            self.calls.push("abort");
        }
    }

    fn page() -> Raster<'static> {
        Raster {
            dpi: 203,
            width: 80,
            height: 80,
            width_mm: 10.,
            height_mm: 10.,
            stride: 10,
            bounds: [0; 4],
            pixels: &[],
        }
    }

    #[test]
    fn a_whole_page_answers_its_receipt() {
        let mut f = Fake::default();
        let receipt = submit(&mut f, &page(), "Godex G500", DOCUMENT).unwrap();
        assert_eq!(
            receipt,
            Receipt {
                queue: "Godex G500".into(),
                job_id: 42,
                document_name: DOCUMENT.into(),
            }
        );
        assert_eq!(f.calls, ["begin", "page", "draw", "end_page", "end"]);
    }

    #[test]
    fn a_failure_after_begin_keeps_the_receipt_aborts_and_never_retries() {
        for step in ["page", "draw", "end_page", "end"] {
            let mut f = Fake {
                fail: Some(step),
                ..Default::default()
            };
            let e = submit(&mut f, &page(), "Queue", DOCUMENT).unwrap_err();
            assert_eq!(e.phase, "delivery_unknown", "{step}");
            assert_eq!(e.receipt.unwrap().job_id, 42);
            assert_eq!(f.calls.last(), Some(&"abort"));
            assert_eq!(f.calls.iter().filter(|s| **s == "begin").count(), 1);
        }
    }

    #[test]
    fn a_failed_start_doc_is_unknown_without_a_receipt() {
        let mut f = Fake {
            fail: Some("begin"),
            ..Default::default()
        };
        let e = submit(&mut f, &page(), "Queue", DOCUMENT).unwrap_err();
        assert_eq!((e.code, e.phase), ("driver_failure", "delivery_unknown"));
        assert!(e.receipt.is_none());
        assert_eq!(f.calls, ["begin"]);
    }

    #[test]
    fn the_payload_is_bounded_before_base64_is_decoded() {
        assert!(artifact(&"A".repeat(4 * MAX_BYTES.div_ceil(3) + 1)).is_err());
        assert!(artifact("AAAA").is_err());
        assert!(!valid_name("a\0b"));
        assert!(!valid_name("  "));
    }

    #[test]
    fn only_the_webviews_own_document_name_prints() {
        assert!(markiro_document(DOCUMENT));
        assert!(!markiro_document("Markiro:7d1c2a8e3b4f4c5d9e6f0a1b2c3d4e5f"));
        assert!(!markiro_document("Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5g"));
        assert!(!markiro_document("Invoice:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"));
        assert!(!markiro_document("Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4eя"));
    }

    #[test]
    fn a_page_that_is_not_mono_raster_never_reaches_a_queue() {
        let refused = print("Godex G500".into(), "AAAA".into(), DOCUMENT.into());
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({
                "ok": false,
                "error": { "code": "invalid_artifact", "phase": "before_start" }
            })
        );
    }

    #[test]
    fn a_receipt_without_a_job_reads_unavailable() {
        let observation = observe(Receipt {
            queue: "Godex G500".into(),
            job_id: 0,
            document_name: DOCUMENT.into(),
        });
        assert_eq!(
            serde_json::to_value(&observation).unwrap(),
            serde_json::json!({ "state": "unavailable" })
        );
    }
}
```

- [ ] **Step 5: Прогнать тесты оболочки на хосте.**

Run: `pnpm --filter @markiro/standalone build && cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib printer::`
Expected: PASS — `printer::raster::tests::*` (4), `printer::driver::tests::*` (7) и прежние тесты `printer::*`; сборка без предупреждений (`cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-standalone 2>&1 | grep -c warning` → `0`).

- [ ] **Step 6: Проверить Windows-код пробным крейтом (вне репозитория).**

```bash
REPO="$(git rev-parse --show-toplevel)"
PROBE="$TMPDIR/drv-probe"
mkdir -p "$PROBE"
cat > "$PROBE/Cargo.toml" <<'EOF'
[package]
name = "drv-probe"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "lib.rs"

[dependencies]
base64 = "=0.22.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Graphics_Printing",
  "Win32_Security", "Win32_Storage_Xps",
] }
EOF
cat > "$PROBE/lib.rs" <<EOF
pub mod printer {
    #[path = "$REPO/apps/standalone/src-tauri/src/printer/raster.rs"]
    pub mod raster;
    #[path = "$REPO/apps/standalone/src-tauri/src/printer/driver.rs"]
    pub mod driver;
}
EOF
cargo check --offline --manifest-path "$PROBE/Cargo.toml" --target x86_64-pc-windows-msvc --tests
cargo clippy --offline --manifest-path "$PROBE/Cargo.toml" --target x86_64-pc-windows-msvc --tests -- -D warnings
```

Expected: оба без ошибок. Предупреждение clippy в новых файлах — исправить в `raster.rs`/`driver.rs` (не глушить на весь модуль), повторить; ошибку разрешения функций `windows-sys` — проверить имя функции в `~/.cargo/registry/src/*/windows-sys-0.61.2/Cargo.toml`. Если нет цели `x86_64-pc-windows-msvc` или реестра офлайн — записать «пробный крейт не запущен» в отклонения (проверит `standalone-windows-build`). Пробный крейт не коммитить.

- [ ] **Step 7: fmt и коммит.**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all
git diff --stat -- apps/standalone/Cargo.lock   # пусто
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/src-tauri/src/printer.rs \
  apps/standalone/src-tauri/src/printer/raster.rs apps/standalone/src-tauri/src/printer/driver.rs \
  apps/standalone/src-tauri/src/printer/driver_commands.rs
git commit -F "$TMPDIR/drv-1.msg"
```

Сообщение (`$TMPDIR/drv-1.msg`): `feat(standalone): the shell reads mono-raster-v1 pages and prints them through the Windows driver (plan ДРВ task 1)`, пустая строка, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 2: Оболочка — команды драйвера, контракт IPC и формы ответа

**Files:**

- Create (replace the stub): `apps/standalone/src-tauri/src/printer/driver_commands.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs` (`invoke_handler`)
- Modify: `apps/standalone/src-tauri/tests/ipc.rs` (новый тест в конце файла)
- Modify: `apps/standalone/src-tauri/tests/hardware_shapes.rs`, `apps/standalone/src-tauri/tests/fixtures/hardware-shapes.json`

**Interfaces:** команды `supports_windows_printing {}` → `bool`; `print_windows_raster { queue, payloadBase64, documentName }` → `Outcome` (всегда `Ok`); `get_windows_print_job { receipt: { queue, jobId, documentName } }` → `Observation`.

- [ ] **Step 1: Тест IPC (падает: команд нет).** Дописать в конец `apps/standalone/src-tauri/tests/ipc.rs`:

```rust
/// The driver printing commands of plan ДРВ: `supports_windows_printing` is
/// `true` exactly on Windows; a page that is not `mono-raster-v1` is refused
/// before any queue opens; a valid page goes no further than
/// `unsupported_platform` off Windows, or `queue_unavailable` on Windows for a
/// queue that does not exist; a receipt of such a queue reads `unavailable`.
/// Every answer is the object the webview parses, never Tauri's text.
#[test]
fn driver_printing_answers_through_the_ipc_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "supports_windows_printing", json!({})),
        Ok(json!(cfg!(windows)))
    );
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/domain/test/fixtures/mono-raster-v1.json"
    ))
    .unwrap();
    let document = "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";
    let print = |payload: &str| {
        invoke(
            &webview,
            "print_windows_raster",
            json!({
                "queue": "Markiro: no such queue",
                "payloadBase64": payload,
                "documentName": document,
            }),
        )
    };
    assert_eq!(
        print("AAAA"),
        Ok(json!({ "ok": false, "error": { "code": "invalid_artifact", "phase": "before_start" } }))
    );
    let expected = if cfg!(windows) {
        "queue_unavailable"
    } else {
        "unsupported_platform"
    };
    assert_eq!(
        print(fixture["base64"].as_str().unwrap()),
        Ok(json!({ "ok": false, "error": { "code": expected, "phase": "before_start" } }))
    );
    assert_eq!(
        invoke(
            &webview,
            "get_windows_print_job",
            json!({ "receipt": {
                "queue": "Markiro: no such queue",
                "jobId": 7,
                "documentName": document,
            } }),
        ),
        Ok(json!({ "state": "unavailable" }))
    );
}
```

(Если `json!`, `tempfile`, `DeviceState`, `mock_app`, `invoke` в файле импортированы иначе — использовать те же имена, что тест `printing_answers_through_the_ipc_shapes`.)

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc driver_printing`
Expected: FAIL — команда `supports_windows_printing` не найдена.

- [ ] **Step 2: Команды (файл целиком).**

Create (заменить заглушку) `apps/standalone/src-tauri/src/printer/driver_commands.rs`:

```rust
//! The driver printing commands (plan ДРВ) over [`super::driver`], ported
//! from the cloud station's `printer_windows_commands.rs` (#696). Each runs
//! on a thread for blocking work, never on the IPC thread, and answers within
//! `DRIVER_WAIT`: a driver that does not return is `delivery_unknown` for a
//! print (the call may still print) and `unavailable` for a question. The
//! webview's own limit (`PRINT_SEND_LIMIT_MS`, 20 s) is shorter, so the work
//! screen reads `timeout` first; the print runtime keeps the queue busy until
//! this command really answers.

use super::driver::{self, Failure, Observation, Outcome, Receipt};
use std::time::Duration;

const DRIVER_WAIT: Duration = Duration::from_secs(30);

async fn await_driver<T: Send + 'static>(
    mut task: tauri::async_runtime::JoinHandle<T>,
    limit: Duration,
) -> Result<T, ()> {
    match tokio::time::timeout(limit, &mut task).await {
        Ok(result) => result.map_err(|_| ()),
        Err(_) => {
            // Cancels a queued worker only: a running Win32 call can still print.
            task.abort();
            Err(())
        }
    }
}

/// The shell prints through Windows drivers: `true` exactly on Windows.
#[tauri::command]
pub fn supports_windows_printing() -> bool {
    cfg!(windows)
}

/// Prints one `mono-raster-v1` page to the Windows queue `queue` as the
/// document `documentName` (`Markiro:<uuid>`). Always answers an [`Outcome`].
#[tauri::command]
pub async fn print_windows_raster(
    queue: String,
    payload_base64: String,
    document_name: String,
) -> Result<Outcome, String> {
    Ok(await_driver(
        tauri::async_runtime::spawn_blocking(move || {
            driver::print(queue, payload_base64, document_name)
        }),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Outcome::Failed {
        ok: false,
        error: Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: None,
        },
    }))
}

/// The spooler's word on a receipt's job.
#[tauri::command]
pub async fn get_windows_print_job(receipt: Receipt) -> Observation {
    await_driver(
        tauri::async_runtime::spawn_blocking(move || driver::observe(receipt)),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Observation::Unavailable)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    #[test]
    fn a_stalled_driver_releases_the_caller_without_claiming_the_worker_stopped() {
        tauri::async_runtime::block_on(async {
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let (done, finished) = std::sync::mpsc::channel::<()>();
            let (entered, started) = tokio::sync::oneshot::channel::<()>();
            let task = tauri::async_runtime::spawn_blocking(move || {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                done.send(()).unwrap();
            });
            started.await.unwrap();
            assert!(super::await_driver(task, Duration::from_millis(5))
                .await
                .is_err());
            release.send(()).unwrap();
            finished.recv_timeout(Duration::from_secs(1)).unwrap();
        });
    }
}
```

- [ ] **Step 3: Зарегистрировать команды.** В `apps/standalone/src-tauri/src/lib.rs` найти

```rust
        printer::print_bytes,
        printer::list_usb_printers,
```

и заменить на

```rust
        printer::print_bytes,
        printer::list_usb_printers,
        printer::driver_commands::supports_windows_printing,
        printer::driver_commands::print_windows_raster,
        printer::driver_commands::get_windows_print_job,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc driver_printing` и `… --lib printer::driver_commands`
Expected: PASS.

- [ ] **Step 4: Формы ответа в общей фикстуре (тест сначала).** В `apps/standalone/src-tauri/tests/fixtures/hardware-shapes.json` найти

```json
  "usbPrinter": { "name": "Zebra ZD421", "port": "USB001" }
}
```

и заменить на

```json
  "usbPrinter": { "name": "Zebra ZD421", "port": "USB001" },
  "windowsPrintSent": {
    "ok": true,
    "receipt": {
      "queue": "Godex G500",
      "jobId": 42,
      "documentName": "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"
    }
  },
  "windowsPrintUnknown": {
    "ok": false,
    "error": {
      "code": "driver_failure",
      "phase": "delivery_unknown",
      "receipt": {
        "queue": "Godex G500",
        "jobId": 42,
        "documentName": "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f"
      }
    }
  },
  "windowsPrintRefused": {
    "ok": false,
    "error": { "code": "geometry_mismatch", "phase": "before_start" }
  },
  "windowsJobPresent": { "state": "present", "statusFlags": 8 },
  "windowsJobAbsent": { "state": "absent" }
}
```

В `apps/standalone/src-tauri/tests/hardware_shapes.rs`: в модульный комментарий после первой фразы дописать `, and the driver printing answers (plan ДРВ: `windowsPrintOutcomeSchema`, `windowsJobObservationSchema`)`; импорт —

```rust
use markiro_standalone_lib::printer::driver::{Failure, Observation, Outcome, Receipt};
```

и заменить хвост теста

```rust
    // Nothing else is pinned by the file: a new shape needs a new key here.
    assert_eq!(fixture.as_object().unwrap().len(), 2);
```

на

```rust
    let receipt = || Receipt {
        queue: "Godex G500".into(),
        job_id: 42,
        document_name: "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f".into(),
    };
    let shapes = [
        (
            "windowsPrintSent",
            serde_json::to_value(Outcome::Success {
                ok: true,
                receipt: receipt(),
            }),
        ),
        (
            "windowsPrintUnknown",
            serde_json::to_value(Outcome::Failed {
                ok: false,
                error: Failure {
                    code: "driver_failure",
                    phase: "delivery_unknown",
                    receipt: Some(receipt()),
                },
            }),
        ),
        (
            "windowsPrintRefused",
            serde_json::to_value(Outcome::Failed {
                ok: false,
                error: Failure {
                    code: "geometry_mismatch",
                    phase: "before_start",
                    receipt: None,
                },
            }),
        ),
        (
            "windowsJobPresent",
            serde_json::to_value(Observation::Present { status_flags: 8 }),
        ),
        ("windowsJobAbsent", serde_json::to_value(Observation::Absent)),
    ];
    for (key, value) in shapes {
        assert_eq!(value.unwrap(), fixture[key], "{key}");
    }
    // Nothing else is pinned by the file: a new shape needs a new key here.
    assert_eq!(fixture.as_object().unwrap().len(), 7);
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test hardware_shapes`
Expected: PASS. (`test/hardware.test.ts` фикстуру не считает по ключам — его не трогать.)

- [ ] **Step 5: fmt, весь крейт оболочки, коммит.**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone
git add apps/standalone/src-tauri/src/printer/driver_commands.rs apps/standalone/src-tauri/src/lib.rs \
  apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src-tauri/tests/hardware_shapes.rs \
  apps/standalone/src-tauri/tests/fixtures/hardware-shapes.json
git commit -F "$TMPDIR/drv-2.msg"
```

Expected: все тесты `markiro-standalone` зелёные. Сообщение: `feat(standalone): driver printing commands and their IPC shapes (plan ДРВ task 2)` + пустая строка + трейлер.

---

### Task 3: Обёртка вебвью — ответы драйвера в `PrintResult`

**Files:**

- Modify: `apps/standalone/src/hardware/hardware.ts`
- Modify: `apps/standalone/src/floor/print/print-jobs.ts` (коды заданий драйвера и `settleOutcome`)
- Test: `apps/standalone/test/windows-printing.test.ts` (new)

**Interfaces:**

```ts
export type PrintResultCode = PrintFailureCode | DriverFailedCode | "driver_unknown";
export type PrintResult =
  | { sent: true; receipt?: WindowsPrintReceipt }
  | { sent: false; code: PrintResultCode; receipt?: WindowsPrintReceipt };
export const DRIVER_FAILED_CODES = [
  "queue_unavailable",
  "geometry_mismatch",
  "driver_not_started",
] as const;
export interface WindowsPrinting {
  supportsWindowsPrinting: () => Promise<boolean>;
  printWindowsRaster: (
    queue: string,
    bytes: Uint8Array,
    documentName: string,
  ) => Promise<PrintResult>;
  getWindowsPrintJob: (receipt: WindowsPrintReceipt) => Promise<WindowsJobObservation>;
}
export function windowsPrintResult(raw: unknown, queue: string, documentName: string): PrintResult;
export function createTauriWindowsPrinting(call?: Invoke): WindowsPrinting;
```

- [ ] **Step 1: Тест (падает: экспортов нет).**

Create `apps/standalone/test/windows-printing.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createTauriWindowsPrinting,
  windowsJobObservationSchema,
  windowsPrintOutcomeSchema,
  windowsPrintResult,
} from "../src/hardware/hardware.js";

// Bind the module URL before use (see test/hardware.test.ts).
const moduleUrl = import.meta.url;
const SHAPES_URL = new URL("../src-tauri/tests/fixtures/hardware-shapes.json", moduleUrl);

const QUEUE = "Godex G500";
const DOCUMENT = "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";
const RECEIPT = { queue: QUEUE, jobId: 42, documentName: DOCUMENT };

describe("the driver printing answers the shell sends", () => {
  it("are the shapes the shell's fixture pins, parsed strictly", () => {
    const shapes: Record<string, unknown> = JSON.parse(readFileSync(SHAPES_URL, "utf8"));
    for (const key of ["windowsPrintSent", "windowsPrintUnknown", "windowsPrintRefused"]) {
      expect(windowsPrintOutcomeSchema.parse(shapes[key]), key).toEqual(shapes[key]);
    }
    for (const key of ["windowsJobPresent", "windowsJobAbsent"]) {
      expect(windowsJobObservationSchema.parse(shapes[key]), key).toEqual(shapes[key]);
    }
    expect(
      windowsPrintOutcomeSchema.safeParse({ ok: true, receipt: RECEIPT, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("windowsPrintResult", () => {
  const before = (code: string) => ({ ok: false, error: { code, phase: "before_start" } });

  it("is sent with its receipt only when the receipt names this queue and document", () => {
    expect(windowsPrintResult({ ok: true, receipt: RECEIPT }, QUEUE, DOCUMENT)).toEqual({
      sent: true,
      receipt: RECEIPT,
    });
    expect(
      windowsPrintResult({ ok: true, receipt: { ...RECEIPT, queue: "Other" } }, QUEUE, DOCUMENT),
    ).toEqual({ sent: false, code: "driver_unknown" });
  });

  it("reads a refusal before the start as a code that cannot double a label", () => {
    expect(windowsPrintResult(before("unsupported_platform"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "unsupported",
    });
    expect(windowsPrintResult(before("invalid_artifact"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "invalid_payload",
    });
    expect(windowsPrintResult(before("queue_unavailable"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "queue_unavailable",
    });
    expect(windowsPrintResult(before("geometry_mismatch"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "geometry_mismatch",
    });
    expect(windowsPrintResult(before("driver_failure"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_not_started",
    });
  });

  it("reads a delivery in doubt, an answer of no known shape, as driver_unknown", () => {
    const unknown = {
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown", receipt: RECEIPT },
    };
    expect(windowsPrintResult(unknown, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
      receipt: RECEIPT,
    });
    expect(
      windowsPrintResult(
        { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } },
        QUEUE,
        DOCUMENT,
      ),
    ).toEqual({ sent: false, code: "driver_unknown" });
    expect(windowsPrintResult(null, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
    expect(windowsPrintResult({ ok: true }, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
  });
});

describe("createTauriWindowsPrinting", () => {
  it("asks the shell's driver commands by name with the page as base64", async () => {
    const call = vi.fn(async (command: string) =>
      command === "print_windows_raster" ? { ok: true, receipt: RECEIPT } : true,
    );
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.supportsWindowsPrinting()).resolves.toBe(true);
    await expect(
      windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT),
    ).resolves.toEqual({ sent: true, receipt: RECEIPT });
    expect(call).toHaveBeenCalledWith("supports_windows_printing", {});
    expect(call).toHaveBeenCalledWith("print_windows_raster", {
      queue: QUEUE,
      payloadBase64: "QQ==",
      documentName: DOCUMENT,
    });
  });

  it("never throws: a failed call is unknown for a print, false and unavailable for questions", async () => {
    const call = vi.fn(async () => {
      throw new Error("ipc");
    });
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.supportsWindowsPrinting()).resolves.toBe(false);
    await expect(windows.printWindowsRaster(QUEUE, new Uint8Array([1]), DOCUMENT)).resolves.toEqual(
      {
        sent: false,
        code: "driver_unknown",
      },
    );
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
  });

  it("reads the spooler's observation strictly, anything else as unavailable", async () => {
    const answers: unknown[] = [{ state: "present", statusFlags: 8 }, { state: "gone" }];
    const call = vi.fn(async () => answers.shift());
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({
      state: "present",
      statusFlags: 8,
    });
    expect(call).toHaveBeenCalledWith("get_windows_print_job", { receipt: RECEIPT });
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/windows-printing.test.ts`
Expected: FAIL — `createTauriWindowsPrinting` не экспортирован.

- [ ] **Step 2: Расширить `PrintResult`.** В `apps/standalone/src/hardware/hardware.ts` найти

```ts
export type PrintResult = { sent: true } | { sent: false; code: PrintFailureCode };
```

и заменить на

```ts
export type PrintResult =
  | { sent: true; receipt?: WindowsPrintReceipt }
  | { sent: false; code: PrintResultCode; receipt?: WindowsPrintReceipt };
```

и дописать в doc-комментарий над ним абзац: `A driver print (plan ДРВ, \`createTauriWindowsPrinting\`) answers the same shape: \`sent\` — the spooler took the whole document (a receipt names it), never that a label printed; \`queue_unavailable\`, \`geometry_mismatch\` and \`driver_not_started\` — nothing reached the spooler; \`driver_unknown\` — a label may come out (the receipt, when known, names the spooler job).`

- [ ] **Step 3: Код драйвера в конце файла.** Дописать в конец `apps/standalone/src/hardware/hardware.ts`:

```ts
/** A spooler job of a driver print (`Receipt` of `src-tauri/src/printer/driver.rs`). */
export const windowsPrintReceiptSchema = z
  .object({
    queue: z.string().min(1),
    jobId: z.number().int().positive(),
    documentName: z.string().min(1),
  })
  .strict();
export type WindowsPrintReceipt = z.infer<typeof windowsPrintReceiptSchema>;

/** The codes of `Failure` in `src-tauri/src/printer/driver.rs`. */
export const WINDOWS_DRIVER_CODES = [
  "unsupported_platform",
  "invalid_artifact",
  "queue_unavailable",
  "geometry_mismatch",
  "driver_failure",
] as const;

const windowsFailureSchema = z
  .object({
    code: z.enum(WINDOWS_DRIVER_CODES),
    phase: z.enum(["before_start", "delivery_unknown"]),
    receipt: windowsPrintReceiptSchema.optional(),
  })
  .strict();

/** `print_windows_raster`'s answer (`Outcome`); pinned by `tests/fixtures/hardware-shapes.json`. */
export const windowsPrintOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), receipt: windowsPrintReceiptSchema }).strict(),
  z.object({ ok: z.literal(false), error: windowsFailureSchema }).strict(),
]);

/** `get_windows_print_job`'s answer (`Observation`): diagnostic, never a printed label. */
export const windowsJobObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("present"), statusFlags: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("identity_mismatch") }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);
export type WindowsJobObservation = z.infer<typeof windowsJobObservationSchema>;

/** A driver print that left nothing in the spooler: printing again cannot double a label. */
export const DRIVER_FAILED_CODES = [
  "queue_unavailable",
  "geometry_mismatch",
  "driver_not_started",
] as const;
export type DriverFailedCode = (typeof DRIVER_FAILED_CODES)[number];

/** Every code a send can end with: the RAW codes, the driver's, and its unknown outcome. */
export type PrintResultCode = PrintFailureCode | DriverFailedCode | "driver_unknown";

/** The shell's driver printing (plan ДРВ); kept apart from `HardwareApi`, whose fakes stay as they are. */
export interface WindowsPrinting {
  /** `true` exactly on Windows; `false` when the shell cannot be asked. */
  supportsWindowsPrinting: () => Promise<boolean>;
  /** One `mono-raster-v1` page to the queue, as the document `documentName`; never throws. */
  printWindowsRaster: (
    queue: string,
    bytes: Uint8Array,
    documentName: string,
  ) => Promise<PrintResult>;
  /** The spooler's word on the job; never throws (`unavailable`). */
  getWindowsPrintJob: (receipt: WindowsPrintReceipt) => Promise<WindowsJobObservation>;
}

function sameJob(
  receipt: WindowsPrintReceipt | undefined,
  queue: string,
  documentName: string,
): receipt is WindowsPrintReceipt {
  return receipt !== undefined && receipt.queue === queue && receipt.documentName === documentName;
}

/**
 * The shell's answer to one driver print, as a send's result. Only
 * `before_start` is a code that makes printing again safe; a delivery in
 * doubt, an answer of no known shape and a receipt naming another queue or
 * document (dropped) read as `driver_unknown` — never as a send that left
 * nothing.
 */
export function windowsPrintResult(raw: unknown, queue: string, documentName: string): PrintResult {
  const parsed = windowsPrintOutcomeSchema.safeParse(raw);
  if (!parsed.success) return { sent: false, code: "driver_unknown" };
  const outcome = parsed.data;
  if (outcome.ok) {
    return sameJob(outcome.receipt, queue, documentName)
      ? { sent: true, receipt: outcome.receipt }
      : { sent: false, code: "driver_unknown" };
  }
  const { error } = outcome;
  if (error.phase === "delivery_unknown") {
    return sameJob(error.receipt, queue, documentName)
      ? { sent: false, code: "driver_unknown", receipt: error.receipt }
      : { sent: false, code: "driver_unknown" };
  }
  switch (error.code) {
    case "unsupported_platform":
      return { sent: false, code: "unsupported" };
    case "invalid_artifact":
      return { sent: false, code: "invalid_payload" };
    case "queue_unavailable":
      return { sent: false, code: "queue_unavailable" };
    case "geometry_mismatch":
      return { sent: false, code: "geometry_mismatch" };
    case "driver_failure":
      return { sent: false, code: "driver_not_started" };
  }
}

/** The driver commands of `src-tauri/src/printer/driver_commands.rs`. */
export function createTauriWindowsPrinting(call: Invoke = invoke): WindowsPrinting {
  return {
    supportsWindowsPrinting: async () => {
      try {
        return (await call("supports_windows_printing", {})) === true;
      } catch {
        return false;
      }
    },
    printWindowsRaster: async (queue, bytes, documentName) => {
      let payloadBase64: string;
      try {
        payloadBase64 = bytesToBase64(bytes);
      } catch {
        // Nothing was asked of the shell, so nothing was sent.
        return { sent: false, code: "invalid_payload" };
      }
      try {
        const raw = await call("print_windows_raster", { queue, payloadBase64, documentName });
        return windowsPrintResult(raw, queue, documentName);
      } catch {
        // The call may have reached the shell: a label may come out.
        return { sent: false, code: "driver_unknown" };
      }
    },
    getWindowsPrintJob: async (receipt) => {
      try {
        const parsed = windowsJobObservationSchema.safeParse(
          await call("get_windows_print_job", { receipt }),
        );
        return parsed.success ? parsed.data : { state: "unavailable" };
      } catch {
        return { state: "unavailable" };
      }
    },
  };
}
```

- [ ] **Step 4: Коды заданий и `settleOutcome` — чтобы шире ставший `PrintResult` типизировался.** В `apps/standalone/src/floor/print/print-jobs.ts` найти

```ts
  "unsupported",
  "printer_busy",
] as const;
```

заменить на

```ts
  "unsupported",
  "printer_busy",
  // Plan ДРВ: the Windows driver refused before the spooler took anything.
  "queue_unavailable",
  "geometry_mismatch",
  "driver_not_started",
] as const;
```

найти

```ts
export const UNKNOWN_CODES = ["outcome_unknown", "timeout", "interrupted"] as const;
```

заменить на

```ts
export const UNKNOWN_CODES = [
  "outcome_unknown",
  "timeout",
  "interrupted",
  // Plan ДРВ: the driver's document started and did not finish, or its answer was lost.
  "driver_unknown",
] as const;
```

(дописать в doc-комментарии обеих констант по фразе о кодах драйвера; столбец `error_code` без `CHECK` — миграции не нужно), и в `settleOutcome` найти

```ts
if (result.sent) return { state: "sent" };
if (result.code === "outcome_unknown") return { state: "unknown", code: "outcome_unknown" };
return { state: "failed", code: result.code };
```

заменить на

```ts
if (result.sent) return { state: "sent" };
if (result.code === "outcome_unknown" || result.code === "driver_unknown") {
  return { state: "unknown", code: result.code };
}
return { state: "failed", code: result.code };
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/windows-printing.test.ts test/hardware.test.ts test/hardware-tauri.test.ts test/floor-print-jobs.test.ts && pnpm --filter @markiro/standalone typecheck`
Expected: PASS, typecheck без ошибок.

- [ ] **Step 5: Коммит.**

```bash
git add apps/standalone/src/hardware/hardware.ts apps/standalone/src/floor/print/print-jobs.ts \
  apps/standalone/test/windows-printing.test.ts
git commit -F "$TMPDIR/drv-3.msg"
```

Сообщение: `feat(standalone): the webview reads the shell's driver printing answers (plan ДРВ task 3)` + пустая строка + трейлер.

---

### Task 4: Профиль принтера со способом печати, рендер страницы драйвера

**Files:**

- Modify: `apps/standalone/src/floor/setup/workstation-settings.ts`
- Modify (replace whole file): `apps/standalone/src/floor/setup/printer-draft.ts`
- Modify: `apps/standalone/src/labels/rasterizer.ts`
- Modify: `apps/standalone/src/floor/print/label-emitters.ts`, `apps/standalone/src/floor/print/label-render.ts`
- Create: `apps/standalone/src/floor/print/printer-format.ts`
- Modify: `apps/standalone/src/i18n/ru.json` (один ключ `floor.setup.printers.formats.windowsDriver`)
- Test: `apps/standalone/test/printer-driver-profile.test.ts` (new)

**Interfaces:** `PRINTER_MODES`, `type PrinterMode = "raw" | "windows_driver"`, `PrinterProfile.mode?: PrinterMode`, `printerMode(profile): PrinterMode`, `PrinterDraft.mode`, `LabelPrinter.mode?`, `renderLabel(spec, fields, printer, rasterize?)`, `rasterizeDriverText: RasterizeTextFn`, `printerFormatText(t, printer): string`.

- [ ] **Step 1: Тест (падает).**

Create `apps/standalone/test/printer-driver-profile.test.ts`:

```ts
import { buildDatedBoxLabelTemplates, decodeMonoRaster } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";

import { boxLabelData, renderLabel } from "../src/floor/print/label-render.js";
import { printerFormatText } from "../src/floor/print/printer-format.js";
import { draftOf, NEW_PRINTER, profileOf } from "../src/floor/setup/printer-draft.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  parsePrinterProfile,
  printerMode,
  readWorkstationSettings,
  saveWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import { rasterizeDriverText, RasterUnavailableError } from "../src/labels/rasterizer.js";
import { enteredShift } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster, ZEBRA } from "./support/printing.js";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};

describe("a printer profile's way of printing", () => {
  it("is RAW for every profile stored before it existed, and is not invented on reading", () => {
    const legacy = { ...ZEBRA };
    expect(parsePrinterProfile(legacy)).toEqual(ZEBRA);
    expect(printerMode(ZEBRA)).toBe("raw");
    expect(parsePrinterProfile({ ...ZEBRA, mode: "raw" })).toEqual({ ...ZEBRA, mode: "raw" });
  });

  it("is the Windows driver only for a Windows queue, and nothing this build does not know", () => {
    expect(parsePrinterProfile(GODEX)).toEqual(GODEX);
    expect(printerMode(GODEX)).toBe("windows_driver");
    expect(parsePrinterProfile({ ...ZEBRA, mode: "windows_driver" })).toBeNull();
    expect(parsePrinterProfile({ ...GODEX, mode: "postscript" })).toBeNull();
    expect(parsePrinterProfile({ ...GODEX, mode: null })).toBeNull();
  });

  it("is stored and read back with the workstation's printers", async () => {
    const { executor } = openLocalDb();
    const settings = {
      ...DEFAULT_WORKSTATION_SETTINGS,
      printers: [ZEBRA, GODEX],
      assignments: { box: "godex", pallet: "zebra", duplicate: null },
    };
    await saveWorkstationSettings(executor, settings);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(settings);
  });
});

describe("the printer form's way of printing", () => {
  const newId = () => "new-1";

  it("writes the driver only for a Windows queue, and RAW as no field at all", () => {
    const usb = { ...NEW_PRINTER, name: "Godex", kind: "usb" as const, usbPrinter: "Godex G500" };
    expect(profileOf({ ...usb, mode: "windows_driver" }, newId)).toEqual({
      profile: { ...GODEX, id: "new-1", name: "Godex" },
    });
    expect(profileOf({ ...usb, mode: "raw" }, newId)).toEqual({
      profile: {
        id: "new-1",
        name: "Godex",
        target: { kind: "usb", printer: "Godex G500" },
        language: "zpl",
        dpi: 203,
      },
    });
    // A printer moved to the network keeps no driver mode.
    expect(
      profileOf({ ...usb, kind: "tcp", host: "10.0.0.7", mode: "windows_driver" }, newId),
    ).toEqual({
      profile: {
        id: "new-1",
        name: "Godex",
        target: { kind: "tcp", host: "10.0.0.7", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
    });
  });

  it("opens a stored profile with its way of printing", () => {
    expect(draftOf(GODEX).mode).toBe("windows_driver");
    expect(draftOf(ZEBRA).mode).toBe("raw");
    expect(NEW_PRINTER.mode).toBe("raw");
  });
});

describe("a label for the Windows driver", () => {
  it("is a mono-raster-v1 page of the template at the printer's resolution", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(
      shift,
      { sscc: "046006820000035007", itemCount: 12, closedAt: "2026-10-08T06:20:00.000Z" },
      "Анна",
    );
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    const rasterize = vi.fn(fakeRaster);
    for (const dpi of [203, 300] as const) {
      const bytes = await renderLabel(stock, fields, { ...GODEX, dpi }, rasterize);
      expect([...bytes.slice(0, 8)]).toEqual([...new TextEncoder().encode("MKRMNO1\0")]);
      const page = decodeMonoRaster(bytes);
      expect({ dpi: page.dpi, widthMm: page.widthMm, heightMm: page.heightMm }).toEqual({
        dpi,
        widthMm: stock.widthMm,
        heightMm: stock.heightMm,
      });
    }
    expect(rasterize).toHaveBeenCalledWith("Молоко 3,2% 0,9 л", expect.anything());
  });

  it("never draws text with a face it could not load", async () => {
    // jsdom has no `document.fonts`: the driver's rasterizer refuses rather than guess.
    await expect(
      rasterizeDriverText("Молоко", {
        fontFamily: "sans-serif",
        fontSizePx: 20,
        bold: false,
      }),
    ).rejects.toBeInstanceOf(RasterUnavailableError);
  });
});

describe("a printer's format in words", () => {
  const t = i18n.t.bind(i18n);

  it("is the language for RAW and the driver for the Windows driver", () => {
    expect(printerFormatText(t, ZEBRA)).toBe("ZPL");
    expect(printerFormatText(t, { ...ZEBRA, language: "tspl" })).toBe("TSPL");
    expect(printerFormatText(t, GODEX)).toBe("Драйвер Windows");
  });
});
```

Примечание: `test/setup.ts` уже инициализирует `src/i18n` (отсутствующий ключ в тестах бросает); если `i18n.t.bind(i18n)` не сводится к `TFunction` без приведения, взять `t` из `useTranslation` в крошечном компоненте или передать `i18n.t` — без `as`. Вызов `rasterizeDriverText` поправить под точный тип `RasterizeTextOptions` домена (обязательные поля — по типу).

Run: `pnpm --filter @markiro/standalone exec vitest run test/printer-driver-profile.test.ts`
Expected: FAIL — нет `printerMode`, `printer-format.js`, `rasterizeDriverText`.

- [ ] **Step 2: Способ печати в настройках.** В `apps/standalone/src/floor/setup/workstation-settings.ts`:

найти

```ts
/** The printer's resolution in dots per inch. */
export const PRINTER_DPIS = [203, 300] as const;
export type PrinterDpi = (typeof PRINTER_DPIS)[number];
```

и дописать после:

```ts
/**
 * How the label reaches the printer (plan ДРВ): `raw` — in the printer's own
 * language (ZPL/TSPL) over TCP, COM or a Windows queue with datatype RAW;
 * `windows_driver` — a `mono-raster-v1` page drawn by the queue's Windows
 * driver, allowed only for a Windows queue.
 */
export const PRINTER_MODES = ["raw", "windows_driver"] as const;
export type PrinterMode = (typeof PRINTER_MODES)[number];
```

в `interface PrinterProfile` после `dpi: PrinterDpi;` добавить:

```ts
  /**
   * Absent — `raw`: every profile stored before plan ДРВ, and every RAW
   * profile since (the form writes the field only for the driver), so a job's
   * stored printer snapshot reads as it did. `language` stays for a profile
   * in driver mode: the last RAW language, for switching back.
   */
  mode?: PrinterMode;
```

после функции `parsePrintTarget`… (в любом месте до `parsePrinterProfile`) добавить:

```ts
/** A profile's way of printing: `raw` unless it says `windows_driver`. */
export function printerMode(profile: Pick<PrinterProfile, "mode">): PrinterMode {
  return profile.mode ?? "raw";
}
```

и в `parsePrinterProfile` найти

```ts
const dpi = PRINTER_DPIS.find((candidate) => candidate === row["dpi"]);
if (id === null || name === null || target === null || !language || !dpi) return null;
return { id, name, target, language, dpi };
```

заменить на

```ts
const dpi = PRINTER_DPIS.find((candidate) => candidate === row["dpi"]);
const mode = PRINTER_MODES.find((candidate) => candidate === row["mode"]);
if (id === null || name === null || target === null || !language || !dpi) return null;
// A way of printing this build does not know is no profile; the driver prints to a Windows queue only.
if (row["mode"] !== undefined && mode === undefined) return null;
if (mode === "windows_driver" && target.kind !== "usb") return null;
return { id, name, target, language, dpi, ...(mode === undefined ? {} : { mode }) };
```

- [ ] **Step 3: Форма принтера (файл целиком).** Replace `apps/standalone/src/floor/setup/printer-draft.ts`:

```ts
/**
 * The printer form of the workstation setup: what the operator types, and
 * the profile it describes once checked.
 */
import type { PrintTarget } from "../../hardware/hardware.js";
import {
  parsePrinterProfile,
  printerMode,
  type PrinterDpi,
  type PrinterLanguage,
  type PrinterMode,
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
  /** Read only for a Windows queue (plan ДРВ): another kind always prints RAW. */
  mode: PrinterMode;
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
  mode: "raw",
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
    mode: printerMode(profile),
  };
}

/** The keys of `floor.setup.printers.errors`. */
export type DraftError = "name" | "host" | "port" | "serialPort" | "baud" | "usbPrinter";

function wholeNumber(text: string): number | null {
  return /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * The profile a draft describes, or the first thing wrong with it. The
 * driver's mode is written only for a Windows queue; RAW is no field at all,
 * as every profile before plan ДРВ.
 */
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
  const driver = draft.kind === "usb" && draft.mode === "windows_driver";
  const profile = parsePrinterProfile({
    id: draft.id ?? newId(),
    name: draft.name,
    target,
    language: draft.language,
    dpi: Number(draft.dpi),
    ...(driver ? { mode: "windows_driver" } : {}),
  });
  return profile === null ? { error: "name" } : { profile };
}
```

- [ ] **Step 4: Строгий растеризатор драйвера.** Дописать в конец `apps/standalone/src/labels/rasterizer.ts`:

```ts
/**
 * The rasterizer of a driver page (plan ДРВ, the cloud station's
 * `rasterizeDriverText`): the page's pixels are frozen into the job's bytes
 * and replayed by a reprint, so a text is drawn only with the bundled IBM Plex
 * face loaded for its own script — a webview without `document.fonts`, or a
 * face that did not load, refuses (`RasterUnavailableError`, the job's
 * `render_failed`) instead of freezing a fallback face.
 */
export const rasterizeDriverText: RasterizeTextFn = async (text, options) => {
  const font = fontShorthand(options.fontFamily, options.fontSizePx, options.bold);
  const sample = text === "" ? "Аа" : text;
  const fonts: FontFaceSet | undefined = document.fonts;
  if (fonts === undefined) throw new RasterUnavailableError("Font loading is unavailable");
  const loaded = await fonts.load(font, sample);
  if (loaded.length === 0 || !fonts.check(font, sample)) {
    throw new RasterUnavailableError("The bundled label font is unavailable");
  }
  return rasterizeTextSync(text, options);
};
```

(Если eslint считает проверку `fonts === undefined` лишней по типу `lib.dom`, оставить её с тем же комментарием, что у `document.fonts?.load` выше в файле, — jsdom её не даёт.)

- [ ] **Step 5: Рендер страницы драйвера.** В `apps/standalone/src/floor/print/label-emitters.ts` найти

```ts
export { generateTspl, generateZpl } from "@markiro/domain";
```

и заменить на

```ts
export { encodeMonoRaster, generateTspl, generateZpl, renderMonoLabel } from "@markiro/domain";
```

(и дописать в комментарий: `The driver's page renderer (plan ДРВ) comes in the same chunk.`).

В `apps/standalone/src/floor/print/label-render.ts`: импорт

```ts
import { rasterizeText } from "../../labels/rasterizer.js";
import type { PrinterDpi, PrinterLanguage } from "../setup/workstation-settings.js";
```

заменить на

```ts
import { rasterizeDriverText, rasterizeText } from "../../labels/rasterizer.js";
import type { PrinterDpi, PrinterLanguage, PrinterMode } from "../setup/workstation-settings.js";
```

интерфейс

```ts
export interface LabelPrinter {
  language: PrinterLanguage;
  dpi: PrinterDpi;
}
```

заменить на

```ts
export interface LabelPrinter {
  language: PrinterLanguage;
  dpi: PrinterDpi;
  /** `windows_driver` — a `mono-raster-v1` page for the Windows driver (plan ДРВ); absent — the language. */
  mode?: PrinterMode;
}
```

и функцию `renderLabel` целиком (от `export async function renderLabel(` до конца файла) заменить на

```ts
export async function renderLabel(
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  rasterize?: RasterizeTextFn,
): Promise<Uint8Array> {
  const emitters = await import("./label-emitters.js");
  const printSpec = withPrinterDpi(spec, printer.dpi);
  if (printer.mode === "windows_driver") {
    // The template drawn to the dot at the printer's resolution; the driver
    // prints it 1:1 (plan ДРВ). Text only from the bundled face.
    const page = await emitters.renderMonoLabel(
      printSpec,
      fields,
      rasterize ?? rasterizeDriverText,
    );
    return emitters.encodeMonoRaster(page);
  }
  const options = { rasterizeText: rasterize ?? rasterizeText };
  const text =
    printer.language === "tspl"
      ? await emitters.generateTspl(printSpec, fields, options)
      : await emitters.generateZpl(printSpec, fields, options);
  return latin1ToBytes(text);
}
```

Дописать в doc-комментарий `renderLabel`: `For a printer in driver mode the bytes are a \`mono-raster-v1\` page (\`renderMonoLabel\` + \`encodeMonoRaster\`), with \`rasterizeDriverText\` unless a rasterizer is given; the same template, fields and resolution as the RAW path.`

- [ ] **Step 6: Формат принтера словами.** Create `apps/standalone/src/floor/print/printer-format.ts`:

```ts
import type { TFunction } from "i18next";

import { printerMode, type PrinterProfile } from "../setup/workstation-settings.js";

/**
 * How a printer's labels are made, for the screens' `{{language}}`: «ZPL»,
 * «TSPL», or «Драйвер Windows» for a profile in driver mode (plan ДРВ).
 */
export function printerFormatText(
  t: TFunction,
  printer: Pick<PrinterProfile, "language" | "mode">,
): string {
  return printerMode(printer) === "windows_driver"
    ? t("floor.setup.printers.formats.windowsDriver")
    : printer.language.toUpperCase();
}
```

В `apps/standalone/src/i18n/ru.json` в объект `floor.setup.printers` после `"format": "{{language}} · {{dpi}} dpi",` добавить `"formats": { "windowsDriver": "Драйвер Windows" },`.

- [ ] **Step 7: Прогон и коммит.**

Run: `pnpm --filter @markiro/standalone exec vitest run test/printer-driver-profile.test.ts test/floor-label-render.test.ts test/floor-setup.test.tsx test/floor-print-jobs.test.ts && pnpm --filter @markiro/standalone typecheck`
Expected: PASS (прежние тесты профилей и рендера не меняются: RAW-профили без `mode`).

```bash
git add apps/standalone/src/floor/setup/workstation-settings.ts apps/standalone/src/floor/setup/printer-draft.ts \
  apps/standalone/src/labels/rasterizer.ts apps/standalone/src/floor/print/label-emitters.ts \
  apps/standalone/src/floor/print/label-render.ts apps/standalone/src/floor/print/printer-format.ts \
  apps/standalone/src/i18n/ru.json apps/standalone/test/printer-driver-profile.test.ts
git commit -F "$TMPDIR/drv-4.msg"
```

Сообщение: `feat(standalone): a printer profile prints RAW or through the Windows driver, which gets a mono-raster page (plan ДРВ task 4)` + пустая строка + трейлер.

---

### Task 5: Отправка через драйвер — рантайм, задания, печать снова

**Files:**

- Modify (replace whole file): `apps/standalone/src/floor/print/print-runtime.ts`
- Modify: `apps/standalone/src/floor/print/print-jobs.ts`, `apps/standalone/src/floor/print/print-resolution.ts`, `apps/standalone/src/app/App.tsx`
- Test: `apps/standalone/test/floor-print-driver.test.ts` (new)

**Interfaces:**

```ts
export type WindowsQueueCheck = WindowsJobObservation | { state: "no_receipt" };
export interface PrintRuntime {
  send: (
    jobId: string | null,
    target: PrintTarget,
    bytes: Uint8Array,
    mode?: PrinterMode,
  ) => Promise<SendOutcome>;
  isInFlight: (jobId: string) => boolean;
  inFlight: () => string[];
  checkWindowsJob: (jobId: string) => Promise<WindowsQueueCheck>;
  supportsWindowsDriver: () => Promise<boolean>;
}
export function createPrintRuntime(
  printBytes: HardwareApi["printBytes"],
  options?: PrintRuntimeOptions,
): PrintRuntime;
// print-jobs.ts (since task 3): FAILED_CODES += queue_unavailable, geometry_mismatch, driver_not_started; UNKNOWN_CODES += driver_unknown
```

- [ ] **Step 1: Тест (падает).**

Create `apps/standalone/test/floor-print-driver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { sendLabelJob, settleOutcome } from "../src/floor/print/print-jobs.js";
import { printAgain } from "../src/floor/print/print-resolution.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { PrinterProfile } from "../src/floor/setup/workstation-settings.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  fakeRender,
  manualTimers,
  printStation,
  resolveContext,
  spyRender,
  ZEBRA,
} from "./support/printing.js";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};
const DOC_ID = "7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";

/** The shell's driver printing: every print recorded and answered by `answer`. */
function fakeWindows(answer?: (queue: string, documentName: string) => Promise<PrintResult>) {
  const prints: { queue: string; documentName: string; bytes: number }[] = [];
  const windows: WindowsPrinting = {
    supportsWindowsPrinting: vi.fn(async () => true),
    printWindowsRaster: vi.fn(async (queue: string, bytes: Uint8Array, documentName: string) => {
      prints.push({ queue, documentName, bytes: bytes.length });
      return answer !== undefined
        ? answer(queue, documentName)
        : { sent: true, receipt: { queue, jobId: 42, documentName } };
    }),
    getWindowsPrintJob: vi.fn(async () => ({ state: "present" as const, statusFlags: 0 })),
  };
  return { windows, prints };
}

describe("the print runtime's driver route", () => {
  it("sends a driver page to the Windows queue as Markiro:<uuid>, never through RAW", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      newDocumentId: () => DOC_ID,
    });
    await expect(
      runtime.send("job-1", GODEX.target, new Uint8Array([1, 2]), "windows_driver"),
    ).resolves.toEqual({
      kind: "answered",
      result: {
        sent: true,
        receipt: { queue: "Godex G500", jobId: 42, documentName: `Markiro:${DOC_ID}` },
      },
    });
    expect(prints).toEqual([{ queue: "Godex G500", documentName: `Markiro:${DOC_ID}`, bytes: 2 }]);
    expect(shell.sends).toEqual([]);
    // RAW stays RAW, the default.
    await runtime.send("job-2", ZEBRA.target, new Uint8Array([65]));
    expect(shell.sends).toHaveLength(1);
    expect(prints).toHaveLength(1);
  });

  it("refuses a driver send to anything but a Windows queue, or without the shell's driver, sending nothing", async () => {
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    await expect(
      runtime.send("job-1", ZEBRA.target, new Uint8Array([1]), "windows_driver"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "invalid_target" } });
    const bare = createPrintRuntime(shell.hardware.printBytes);
    await expect(
      bare.send("job-2", GODEX.target, new Uint8Array([1]), "windows_driver"),
    ).resolves.toEqual({ kind: "answered", result: { sent: false, code: "unsupported" } });
    expect(prints).toEqual([]);
    expect(shell.sends).toEqual([]);
    await expect(bare.supportsWindowsDriver()).resolves.toBe(false);
    await expect(runtime.supportsWindowsDriver()).resolves.toBe(true);
  });

  it("asks the spooler about the job's newest driver send, a late answer's receipt included", async () => {
    const shell = fakeHardware();
    let release: (result: PrintResult) => void = () => undefined;
    const { windows } = fakeWindows(
      () =>
        new Promise<PrintResult>((resolve) => {
          release = resolve;
        }),
    );
    const timers = manualTimers();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: timers.startTimer,
      newDocumentId: () => DOC_ID,
    });
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({ state: "no_receipt" });
    const sending = runtime.send("job-1", GODEX.target, new Uint8Array([1]), "windows_driver");
    await vi.waitFor(() => expect(windows.printWindowsRaster).toHaveBeenCalledTimes(1));
    timers.expire();
    await expect(sending).resolves.toEqual({ kind: "timeout" });
    const receipt = { queue: "Godex G500", jobId: 7, documentName: `Markiro:${DOC_ID}` };
    release({ sent: false, code: "driver_unknown", receipt });
    await vi.waitFor(() => expect(runtime.isInFlight("job-1")).toBe(false));
    await expect(runtime.checkWindowsJob("job-1")).resolves.toEqual({
      state: "present",
      statusFlags: 0,
    });
    expect(windows.getWindowsPrintJob).toHaveBeenCalledWith(receipt);
  });
});

describe("a driver send's outcome", () => {
  it("is failed for a refusal before the start and unknown for a delivery in doubt", () => {
    const answered = (result: PrintResult) => settleOutcome({ kind: "answered", result });
    expect(answered({ sent: false, code: "queue_unavailable" })).toEqual({
      state: "failed",
      code: "queue_unavailable",
    });
    expect(answered({ sent: false, code: "geometry_mismatch" })).toEqual({
      state: "failed",
      code: "geometry_mismatch",
    });
    expect(answered({ sent: false, code: "driver_not_started" })).toEqual({
      state: "failed",
      code: "driver_not_started",
    });
    expect(answered({ sent: false, code: "driver_unknown" })).toEqual({
      state: "unknown",
      code: "driver_unknown",
    });
  });
});

describe("a box label on a printer in driver mode", () => {
  const driverSettings = {
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  };

  it("goes to the Windows queue once and, in doubt, waits for the operator", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    expect(job.printer).toEqual(GODEX);
    const shell = fakeHardware();
    const { windows, prints } = fakeWindows(async (queue, documentName) => ({
      sent: false,
      code: "driver_unknown",
      receipt: { queue, jobId: 9, documentName },
    }));
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    const after = await sendLabelJob(resolveContext(at.local, runtime), job);
    expect(after).toMatchObject({ state: "unknown", errorCode: "driver_unknown", attempts: 1 });
    expect(prints).toHaveLength(1);
    expect(shell.sends).toEqual([]);
  });

  it("is a safe failure when the driver refuses before the start", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const { windows } = fakeWindows(async () => ({ sent: false, code: "geometry_mismatch" }));
    const runtime = createPrintRuntime(fakeHardware().hardware.printBytes, { windows });
    await expect(sendLabelJob(resolveContext(at.local, runtime), job)).resolves.toMatchObject({
      state: "failed",
      errorCode: "geometry_mismatch",
    });
  });

  it("is rendered again when printed again on a printer of the other way, even of the same language and resolution", async () => {
    const at = await printStation(driverSettings);
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware();
    const { windows } = fakeWindows(async () => ({ sent: false, code: "geometry_mismatch" }));
    const runtime = createPrintRuntime(shell.hardware.printBytes, { windows });
    const context = resolveContext(at.local, runtime);
    const failed = await sendLabelJob(context, job);
    const render = spyRender(fakeRender);
    const { boxTemplate } = at.shift.snapshot;
    await printAgain(
      context,
      failed,
      { reason: null, printer: ZEBRA },
      at.settings,
      { id: boxTemplate.id, rev: boxTemplate.rev, spec: boxTemplate.spec },
      render,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[2]).toEqual(ZEBRA);
    expect(shell.sends).toHaveLength(1);
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-print-driver.test.ts`
Expected: FAIL — `createPrintRuntime` не принимает `windows`, `settleOutcome` не знает новых кодов.

- [ ] **Step 2: Отправка задания со способом печати.** (Коды и `settleOutcome` сделаны в задаче 3.) В `apps/standalone/src/floor/print/print-jobs.ts`:

импорт

```ts
import {
  parsePrinterProfile,
  readWorkstationSettings,
```

заменить на

```ts
import {
  parsePrinterProfile,
  printerMode,
  readWorkstationSettings,
```

и в `sendLabelJob` найти

```ts
const outcome = await runtime.send(job.id, printer.target, base64ToBytes(bytesBase64));
```

заменить на

```ts
const outcome = await runtime.send(
  job.id,
  printer.target,
  base64ToBytes(bytesBase64),
  printerMode(printer),
);
```

- [ ] **Step 3: Печать снова при смене способа.** В `apps/standalone/src/floor/print/print-resolution.ts` импорт

```ts
import {
  resolvePrinter,
  type PrinterProfile,
```

заменить на

```ts
import {
  printerMode,
  resolvePrinter,
  type PrinterProfile,
```

и найти

```ts
const sameRender =
  job.printer !== null &&
  job.printer.language === printer.language &&
  job.printer.dpi === printer.dpi;
```

заменить на

```ts
// A driver page and a RAW document are other bytes even at one language and resolution (plan ДРВ).
const sameRender =
  job.printer !== null &&
  printerMode(job.printer) === printerMode(printer) &&
  job.printer.language === printer.language &&
  job.printer.dpi === printer.dpi;
```

Дописать в doc-комментарий `printAgain`: `…rendered again from the shift's snapshot otherwise — another language, resolution or way of printing (plan ДРВ)`.

- [ ] **Step 4: Рантайм (файл целиком).** Replace `apps/standalone/src/floor/print/print-runtime.ts`:

```ts
import type {
  HardwareApi,
  PrintResult,
  PrintTarget,
  WindowsJobObservation,
  WindowsPrinting,
  WindowsPrintReceipt,
} from "../../hardware/hardware.js";
import { printerTargetKey, type PrinterMode } from "../setup/workstation-settings.js";

/**
 * How long the webview waits for one send's answer, from the moment it asks
 * (queue included). The shell bounds each connection and write by 5 s, but a
 * COM port's flush or a spooler call can block past its own limit, and the
 * call then never answers (plan 2a4's notes): the work screen must not wait
 * for it forever. A driver print (plan ДРВ) has the shell's own 30 s limit;
 * this one is shorter, so the work screen reads `timeout` first.
 *
 * The limit counts from the moment of asking, queue wait included: a label
 * queued behind a slow but healthy send gets only what is left of it and can
 * end as `timeout` or `busy`. Rare while an open job stops the next box; it
 * grows once pallet labels share the box printer (plan ПЛ-Ц).
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
 * What «Проверить очередь Windows» learns of a job (plan ДРВ): the spooler's
 * word on its newest driver send, or `no_receipt` — no driver send of this
 * app run named a spooler job for it. Never a printed label.
 */
export type WindowsQueueCheck = WindowsJobObservation | { state: "no_receipt" };

/**
 * The printers of this app: one send at a time per address (the cloud
 * station's `serializePrinterOutput`), each answered within
 * `PRINT_SEND_LIMIT_MS`, and the jobs whose bytes the shell holds right now.
 * A send in driver mode (plan ДРВ) goes to the queue's Windows driver as the
 * document `Markiro:<uuid>`, through the same queue of its address.
 *
 * A shell call that never returns holds its address until the app restarts:
 * every later send to that printer ends `busy` (`failed` `printer_busy`, the
 * bytes never given over — safe) and the stuck call's job stays in flight, so
 * the recovery never frees it. The way out is another printer or a restart;
 * the screens' `printer_busy` text must say so.
 */
export interface PrintRuntime {
  /**
   * Sends `bytes` to `target` after the sends already queued for its address:
   * in the printer's language (`raw`, the default) or as a page for the
   * Windows driver (`windows_driver`, a Windows queue only). Never rejects: a
   * failed IPC call is `outcome_unknown` (`printBytes`) or `driver_unknown`.
   * `jobId` (a print job's, `null` for a test label) is in flight from now
   * until the shell's call really settles — past the limit too.
   */
  send: (
    jobId: string | null,
    target: PrintTarget,
    bytes: Uint8Array,
    mode?: PrinterMode,
  ) => Promise<SendOutcome>;
  /** The job's bytes are with the shell, or wait for their turn. */
  isInFlight: (jobId: string) => boolean;
  /** Every job in flight (the recovery of interrupted jobs skips them). */
  inFlight: () => string[];
  /**
   * The spooler's word on the job's newest driver send. The receipt is kept
   * in memory only — one that came after the limit too — and a new send of
   * the job forgets it; after a restart it is `no_receipt`. Never rejects.
   */
  checkWindowsJob: (jobId: string) => Promise<WindowsQueueCheck>;
  /** The shell prints through Windows drivers (Windows only); `false` when it cannot say. */
  supportsWindowsDriver: () => Promise<boolean>;
}

export interface PrintRuntimeOptions {
  limitMs?: number;
  startTimer?: StartTimer;
  /** The shell's driver printing; without it a driver send is `unsupported`, nothing sent. */
  windows?: WindowsPrinting;
  /** The UUID of a driver send's document name; a fresh one for every send. */
  newDocumentId?: () => string;
}

export function createPrintRuntime(
  printBytes: HardwareApi["printBytes"],
  options: PrintRuntimeOptions = {},
): PrintRuntime {
  const {
    limitMs = PRINT_SEND_LIMIT_MS,
    startTimer = realTimer,
    windows,
    newDocumentId = () => crypto.randomUUID(),
  } = options;
  const tails = new Map<string, Promise<void>>();
  const flying = new Map<string, number>();
  // The spooler receipt of each job's newest driver send, and which send that is.
  const receipts = new Map<string, WindowsPrintReceipt>();
  const newest = new Map<string, number>();
  let sequence = 0;

  function hold(jobId: string | null): () => void {
    if (jobId === null) return () => undefined;
    flying.set(jobId, (flying.get(jobId) ?? 0) + 1);
    return () => {
      const left = (flying.get(jobId) ?? 1) - 1;
      if (left <= 0) flying.delete(jobId);
      else flying.set(jobId, left);
    };
  }

  async function deliver(
    jobId: string | null,
    send: number,
    target: PrintTarget,
    bytes: Uint8Array,
    mode: PrinterMode,
  ): Promise<PrintResult> {
    if (mode !== "windows_driver") return printBytes(target, bytes);
    // A driver profile is a Windows queue (`parsePrinterProfile`): anything else never goes.
    if (target.kind !== "usb") return { sent: false, code: "invalid_target" };
    if (windows === undefined) return { sent: false, code: "unsupported" };
    const result = await windows.printWindowsRaster(
      target.printer,
      bytes,
      `Markiro:${newDocumentId()}`,
    );
    if (jobId !== null && result.receipt !== undefined && newest.get(jobId) === send) {
      receipts.set(jobId, result.receipt);
    }
    return result;
  }

  return {
    send: (jobId, target, bytes, mode = "raw") => {
      const key = printerTargetKey(target);
      const release = hold(jobId);
      sequence += 1;
      const send = sequence;
      if (jobId !== null) {
        newest.set(jobId, send);
        receipts.delete(jobId);
      }
      let started = false;
      let expired = false;
      const previous = tails.get(key) ?? Promise.resolve();
      // The call starts after every earlier send to this address has really
      // settled, never merely timed out: two writes to one printer at once
      // could interleave two labels.
      const call = previous.then(async (): Promise<PrintResult | null> => {
        if (expired) return null;
        started = true;
        return deliver(jobId, send, target, bytes, mode);
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
        (): SendOutcome => ({
          kind: "answered",
          result: {
            sent: false,
            code: mode === "windows_driver" ? "driver_unknown" : "outcome_unknown",
          },
        }),
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
    checkWindowsJob: async (jobId) => {
      const receipt = receipts.get(jobId);
      if (receipt === undefined || windows === undefined) return { state: "no_receipt" };
      try {
        return await windows.getWindowsPrintJob(receipt);
      } catch {
        return { state: "unavailable" };
      }
    },
    supportsWindowsDriver: async () => {
      if (windows === undefined) return false;
      try {
        return await windows.supportsWindowsPrinting();
      } catch {
        return false;
      }
    },
  };
}
```

- [ ] **Step 5: Подключить драйвер в приложении.** В `apps/standalone/src/app/App.tsx`:

импорт

```ts
import { createTauriHardware, type HardwareApi } from "../hardware/hardware.js";
```

заменить на

```ts
import {
  createTauriHardware,
  createTauriWindowsPrinting,
  type HardwareApi,
  type WindowsPrinting,
} from "../hardware/hardware.js";
```

в `AppProps` после `hardware?: HardwareApi;` добавить

```ts
  /** The shell's printing through Windows drivers (plan ДРВ); tests give their own. */
  windowsPrinting?: WindowsPrinting;
```

в деструктуризации `App({` после `hardware,` добавить `windowsPrinting,`, и найти

```ts
const printing = useMemo(() => createPrintRuntime(hardwareApi.printBytes), [hardwareApi]);
```

заменить на

```ts
const windowsApi = useMemo(
  () => windowsPrinting ?? createTauriWindowsPrinting(),
  [windowsPrinting],
);
const printing = useMemo(
  () => createPrintRuntime(hardwareApi.printBytes, { windows: windowsApi }),
  [hardwareApi, windowsApi],
);
```

- [ ] **Step 6: Прогон и коммит.**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-print-driver.test.ts test/floor-print-runtime.test.ts test/floor-print-jobs.test.ts test/floor-print-resolution.test.ts test/app.test.tsx && pnpm --filter @markiro/standalone typecheck`
Expected: PASS.

```bash
git add apps/standalone/src/floor/print/print-runtime.ts apps/standalone/src/floor/print/print-jobs.ts \
  apps/standalone/src/floor/print/print-resolution.ts apps/standalone/src/app/App.tsx \
  apps/standalone/test/floor-print-driver.test.ts
git commit -F "$TMPDIR/drv-5.msg"
```

Сообщение: `feat(standalone): the floor sends a driver page through the print runtime, never twice by itself (plan ДРВ task 5)` + пустая строка + трейлер.

---

### Task 6: Экраны — способ печати в настройке, «Проверить очередь Windows», формат словами

**Files:**

- Modify: `apps/standalone/src/floor/setup/WorkstationSetup.tsx`
- Modify: `apps/standalone/src/floor/print/LabelPanel.tsx`
- Modify: `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`
- Modify: `apps/standalone/src/floor/work/WorkScreen.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-print-driver-ui.test.tsx` (new)

**Interfaces:** `LabelPanelProps.checkQueue?: () => Promise<WindowsQueueCheck>`; в настройке — выбор «Способ печати» (`size="floor"`).

- [ ] **Step 1: Тексты.** В `apps/standalone/src/i18n/ru.json`:

в `floor.print.codes` после `"interrupted": …` добавить

```json
"queue_unavailable": "Очередь принтера Windows недоступна: этикетка не напечатана. Проверьте, что принтер установлен и включён.",
"geometry_mismatch": "Размер бумаги или разрешение в драйвере Windows не совпадают с этикеткой: этикетка не напечатана. Проверьте настройки драйвера.",
"driver_not_started": "Драйвер Windows не начал печать: этикетка не напечатана.",
"driver_unknown": "Windows не подтвердил задание до конца. Оно ещё может выйти из очереди — проверьте принтер и очередь Windows, прежде чем печатать снова."
```

в `floor.print` (новый объект, ключа `queue` там нет) —

```json
"queue": {
  "check": "Проверить очередь Windows",
  "checking": "Спрашиваем очередь Windows…",
  "present": "Задание находится в очереди Windows: этикетка ещё может напечататься.",
  "absent": "Задания нет в очереди Windows. Это не подтверждает, что этикетка напечаталась.",
  "identity_mismatch": "Номер задания уже принадлежит другому заданию Windows.",
  "unavailable": "Очередь Windows недоступна.",
  "no_receipt": "Номер задания Windows неизвестен: посмотрите очередь принтера в Windows."
}
```

в `floor.setup.printers.editor` после `"dpi": "Разрешение",` —

```json
"mode": "Способ печати",
"modes": {
  "raw": "На языке принтера (ZPL / TSPL)",
  "windows_driver": "Через драйвер Windows"
},
"driverHint": "Установите драйвер принтера в Windows. Размер бумаги и разрешение в драйвере должны совпадать с этикеткой. Отправка в очередь не подтверждает печать — проверяйте этикетку сканером.",
```

- [ ] **Step 2: Тест экранов (падает).**

Create `apps/standalone/test/floor-print-driver-ui.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleLabelData } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { LabelPanel } from "../src/floor/print/LabelPanel.js";
import type { PrintJob } from "../src/floor/print/print-jobs.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  readWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, ZEBRA } from "./support/printing.js";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};
const AT = "2026-10-08T06:20:00.000Z";

function windows(supported: boolean): WindowsPrinting {
  return {
    supportsWindowsPrinting: vi.fn(async () => supported),
    printWindowsRaster: vi.fn(
      async (queue: string, _bytes: Uint8Array, documentName: string): Promise<PrintResult> => ({
        sent: true,
        receipt: { queue, jobId: 3, documentName },
      }),
    ),
    getWindowsPrintJob: vi.fn(async () => ({ state: "absent" as const })),
  };
}

const source: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("the workstation setup's way of printing", () => {
  it("offers the Windows driver for a Windows queue, hides the language and stores the driver", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue([
      { name: "Godex G500", port: "USB001" },
    ]);
    const printing = createPrintRuntime(shell.hardware.printBytes, { windows: windows(true) });
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={executor}
          hardware={shell.hardware}
          printing={printing}
          source={source}
          render={fakeRender}
          onSaved={() => undefined}
          onBack={() => undefined}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    type("Название", "Godex");
    // Not offered for the network.
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    type("Подключение", "usb");
    await screen.findByRole("option", { name: "Godex G500" });
    type("Принтер Windows", "Godex G500");
    const mode = await screen.findByLabelText("Способ печати");
    expect(screen.getByLabelText("Язык принтера")).toBeTruthy();
    fireEvent.change(mode, { target: { value: "windows_driver" } });
    expect(screen.queryByLabelText("Язык принтера")).toBeNull();
    expect(screen.getByText(/Размер бумаги и разрешение в драйвере/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(
      screen.getByText("Принтер Windows: Godex G500 · Драйвер Windows · 203 dpi"),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    const stored = await readWorkstationSettings(executor);
    expect(stored.printers[0]).toMatchObject({ target: GODEX.target, mode: "windows_driver" });
  });

  it("does not offer the driver where the shell does not print through Windows", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue([
      { name: "Godex G500", port: "USB001" },
    ]);
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={executor}
          hardware={shell.hardware}
          printing={createPrintRuntime(shell.hardware.printBytes, { windows: windows(false) })}
          source={source}
          render={fakeRender}
          onSaved={() => undefined}
          onBack={() => undefined}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    type("Подключение", "usb");
    await screen.findByRole("option", { name: "Godex G500" });
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
  });
});

describe("the label panel of a driver label in doubt", () => {
  const job: PrintJob = {
    id: "job-1",
    shiftId: "shift-1",
    purpose: "box",
    subjectId: "box-1",
    sscc: "046006820000035007",
    state: "unknown",
    verify: false,
    templateId: "template-1",
    templateRev: 1,
    fields: sampleLabelData(),
    printer: GODEX,
    bytesBase64: "TUtSTU5PMQA=",
    errorCode: "driver_unknown",
    attempts: 1,
    operatorId: "operator-1",
    createdAt: AT,
    updatedAt: AT,
  };
  const settings = async () => ({
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  });

  function panel(props: { job: PrintJob; checkQueue?: () => Promise<{ state: "absent" }> }) {
    render(
      <ThemeProvider>
        <LabelPanel
          job={props.job}
          busy={false}
          note={null}
          loadSettings={settings}
          onPrintAgain={() => undefined}
          onPrinted={() => undefined}
          onSkip={() => undefined}
          {...(props.checkQueue === undefined ? {} : { checkQueue: props.checkQueue })}
        />
      </ThemeProvider>,
    );
  }

  it("says the driver's doubt, where a reprint goes in words, and asks the Windows queue", async () => {
    const checkQueue = vi.fn(async () => ({ state: "absent" as const }));
    panel({ job, checkQueue });
    expect(screen.getByText(/Windows не подтвердил задание до конца/)).toBeTruthy();
    expect(
      await screen.findByText(
        "Печать пойдёт на принтер: Godex через драйвер · Драйвер Windows · 203 dpi.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить очередь Windows" }));
    expect(
      await screen.findByText(
        "Задания нет в очереди Windows. Это не подтверждает, что этикетка напечаталась.",
      ),
    ).toBeTruthy();
    expect(checkQueue).toHaveBeenCalledTimes(1);
  });

  it("asks no queue for a RAW printer's label", () => {
    panel({
      job: { ...job, printer: ZEBRA, errorCode: "outcome_unknown" },
      checkQueue: vi.fn(async () => ({ state: "absent" as const })),
    });
    expect(screen.queryByRole("button", { name: "Проверить очередь Windows" })).toBeNull();
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-print-driver-ui.test.tsx`
Expected: FAIL — нет «Способ печати», нет кнопки очереди, формат «ZPL».

- [ ] **Step 3: Настройка рабочего места.** В `apps/standalone/src/floor/setup/WorkstationSetup.tsx`:

1. Импорты: после `import { renderLabel } from "../print/label-render.js";` добавить `import { printerFormatText } from "../print/printer-format.js";`; в списке импорта из `./workstation-settings.js` после `PRINT_PURPOSES,` добавить `printerMode,`.
2. Состояние: найти `const [usbAsking, setUsbAsking] = useState(false);` и дописать после:

```tsx
// The shell prints through Windows drivers: the choice of the way of printing is offered only then.
const [windowsDriver, setWindowsDriver] = useState(false);
useEffect(() => {
  let cancelled = false;
  void printing.supportsWindowsDriver().then((supported) => {
    if (!cancelled) setWindowsDriver(supported);
  });
  return () => {
    cancelled = true;
  };
}, [printing]);
```

(если `useState`-объявления идут дальше и правило хуков требует порядка — поставить эффект после последнего `useState` блока, перед `// Only the newest ask is heard: an older answer that comes late is dropped.`).

3. Пробная печать: найти

```tsx
const settled = settleOutcome(await printing.send(null, printer.target, bytes));
```

заменить на

```tsx
const settled = settleOutcome(
  await printing.send(null, printer.target, bytes, printerMode(printer)),
);
```

4. Сводка: в `summary` найти

```tsx
    return `${where} · ${t("floor.setup.printers.format", {
      language: printer.language.toUpperCase(),
```

заменить на

```tsx
    return `${where} · ${t("floor.setup.printers.format", {
      language: printerFormatText(t, printer),
```

5. Форма: найти блок выбора языка

```tsx
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
```

и заменить на

```tsx
{
  form.kind === "usb" && (windowsDriver || form.mode === "windows_driver") && (
    <Select
      native
      size="floor"
      label={t("floor.setup.printers.editor.mode")}
      value={form.mode}
      options={(["raw", "windows_driver"] as const).map((mode) => ({
        value: mode,
        label: t(`floor.setup.printers.editor.modes.${mode}`),
      }))}
      onValueChange={(mode) => set({ mode })}
    />
  );
}
{
  form.kind === "usb" && form.mode === "windows_driver" ? (
    <p>{t("floor.setup.printers.editor.driverHint")}</p>
  ) : (
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
  );
}
```

Дописать в doc-комментарий компонента: `— for a Windows queue, whether it prints in the printer's language or through the Windows driver (plan ДРВ, offered where the shell prints through Windows) —`.

- [ ] **Step 4: Панель этикетки.** В `apps/standalone/src/floor/print/LabelPanel.tsx`:

1. Импорты: `import type { PrinterProfile, WorkstationSettings } from "../setup/workstation-settings.js";` заменить на

```tsx
import {
  printerMode,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
```

и после `import type { PrintJob } from "./print-jobs.js";` добавить

```tsx
import type { WindowsQueueCheck } from "./print-runtime.js";
import { printerFormatText } from "./printer-format.js";
```

2. Формат словами: заменить оба вхождения `language: printer.language.toUpperCase(),` на `language: printerFormatText(t, printer),` (Edit с `replace_all`).
3. Пропс: в `LabelPanelProps` после `onRecover?: () => void;` (с его комментарием) добавить

```tsx
  /**
   * «Проверить очередь Windows» (plan ДРВ): the spooler's word on the job's
   * newest driver send. Offered only for a printer in driver mode, while the
   * label may exist (unknown, or a check waits); diagnostic only — it decides
   * nothing and never confirms a printed label.
   */
  checkQueue?: () => Promise<WindowsQueueCheck>;
```

и в деструктуризации после `onRecover,` добавить `checkQueue,`. 4. Состояние и элементы: после строки `const pallet = job.purpose === "pallet";` добавить

```tsx
const [queue, setQueue] = useState<WindowsQueueCheck | "asking" | null>(null);
const askQueue =
  checkQueue !== undefined && job.printer !== null && printerMode(job.printer) === "windows_driver"
    ? checkQueue
    : null;
```

и перед `let body: ReactNode;` добавить

```tsx
const queueText =
  askQueue !== null && queue !== null ? (
    <p>
      {queue === "asking" ? t("floor.print.queue.checking") : t(`floor.print.queue.${queue.state}`)}
    </p>
  ) : null;
const queueButton =
  askQueue !== null ? (
    <Button
      size="floor"
      variant="secondary"
      {...press(() => {
        if (queue === "asking") return;
        setQueue("asking");
        void askQueue().then(setQueue, () => setQueue({ state: "unavailable" }));
      })}
    >
      {t("floor.print.queue.check")}
    </Button>
  ) : null;
```

5. Вид проверки сканом (`} else if (checking) {`): после `{note !== null && <p>{noteText(note, t, pallet)}</p>}` добавить `{queueText}`, а в его `standalone-form__actions` перед кнопкой `floor.print.check.skip` — `{queueButton}`.
6. Последний вид (failed/unknown): после `{note !== null && <p>{noteText(note, t, pallet)}</p>}` добавить `{job.state === "unknown" && queueText}`, а в `standalone-form__actions` после кнопки `floor.print.printed` (блок `job.state === "unknown" && (…)`) добавить `{job.state === "unknown" && queueButton}`.

- [ ] **Step 5: Рабочий экран и исключения.** В `apps/standalone/src/floor/work/WorkScreen.tsx` найти

```tsx
              onSkip={() => decide((job) => skipLabel(printContextOf(live), job), false)}
```

и дописать после:

```tsx
              checkQueue={() => props.printing.checkWindowsJob(stop.job.id)}
```

(Если TypeScript не сохраняет сужение `stop` внутри стрелки, написать `checkQueue={props.printing.checkWindowsJob.bind(null, stop.job.id)}` — `checkWindowsJob` — свойство-функция, `unbound-method` его не трогает.)

В `apps/standalone/src/floor/exceptions/ExceptionFlow.tsx`: после `import { VIEW_GUARD_MS, type PanelSettings } from "../print/LabelPanel.js";` добавить `import { printerFormatText } from "../print/printer-format.js";`, и заменить `language: printer.language.toUpperCase(),` на `language: printerFormatText(t, printer),`.

- [ ] **Step 6: Прогон (5 раз новый файл) и коммит.**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-print-driver-ui.test.tsx` (5 раз подряд), затем `pnpm --filter @markiro/standalone exec vitest run test/floor-setup.test.tsx test/floor-work-print.test.tsx test/floor-work-exceptions.test.tsx test/floor-work-pallet-exceptions.test.tsx test/floor-work-screen.test.tsx && pnpm --filter @markiro/standalone typecheck && pnpm --filter @markiro/standalone lint`
Expected: PASS; тексты RAW-принтеров («· ZPL · 203 dpi») не изменились.

```bash
git add apps/standalone/src/floor/setup/WorkstationSetup.tsx apps/standalone/src/floor/print/LabelPanel.tsx \
  apps/standalone/src/floor/exceptions/ExceptionFlow.tsx apps/standalone/src/floor/work/WorkScreen.tsx \
  apps/standalone/src/i18n/ru.json apps/standalone/test/floor-print-driver-ui.test.tsx
git commit -F "$TMPDIR/drv-6.msg"
```

Сообщение: `feat(standalone): the setup offers printing through the Windows driver, the label panel asks the Windows queue (plan ДРВ task 6)` + пустая строка + трейлер.

---

### Task 7: Документы и итоговые гейты

**Files:**

- Modify: `apps/standalone/AGENTS.md` («Hardware», «Floor printing»)
- Modify: `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (новый раздел §28 в конце, после разделов других планов волны, если они уже есть)
- Modify: `docs/runbooks/standalone-install.md` («Ручная проверка на Windows»)

- [ ] **Step 1: AGENTS «Hardware».** В `apps/standalone/AGENTS.md`, раздел «## Hardware», после пункта про `printBytes never throws…` (перед `- \`configure_scanners\``) вставить пункт:

```markdown
- Driver printing (plan ДРВ, `src-tauri/src/printer/{raster,driver,driver_commands}.rs`,
  ported from the cloud station's #696): `supports_windows_printing` answers
  `true` exactly on Windows; `print_windows_raster { queue, payloadBase64, documentName }`
  prints one `mono-raster-v1` page (`@markiro/domain` `encodeMonoRaster`; magic
  `MKRMNO1\0`, 203 or 300 dpi, 10–300 mm, at most 2 MiB, black dots only inside the
  required bounds) to a Windows queue as the document `Markiro:<uuid>`: the driver's
  DEVMODE is set to user paper of the page's millimetres, portrait, one copy, 100 %,
  the page's resolution, and the device context must report that resolution on both
  axes, the paper within one dot and the required bounds inside the printable area
  (`geometry_mismatch` otherwise), then GDI draws it 1:1 (`StretchDIBits`). It always
  answers `{ ok: true, receipt: { queue, jobId, documentName } }` or
  `{ ok: false, error: { code, phase, receipt? } }`: `before_start` (nothing reached the
  spooler: `unsupported_platform`, `invalid_artifact`, `queue_unavailable`,
  `geometry_mismatch`, `driver_failure`) or `delivery_unknown` (`StartDocW` was called —
  its answer can be lost after the spooler took the job — or a later call failed and the
  document was aborted; a label may come out). `get_windows_print_job { receipt }` answers
  `present` with `statusFlags`, `absent`, `identity_mismatch` or `unavailable` — never a
  printed label. Each runs on a blocking thread with a 30 s limit (`delivery_unknown` /
  `unavailable` past it; the Win32 call is not cancelled). The order of the GDI calls lives
  in `submit` over `WindowsPrintApi` and is tested on every OS; `mod native` is
  `cfg(windows)` (feature `Win32_Storage_Xps` for `StartDocW`) and compiles only in
  `standalone-windows-build` — plan ДРВ type-checked it with a probe crate outside the
  repository. `tests/fixtures/hardware-shapes.json` pins the answers for both sides
  (`windowsPrintOutcomeSchema`, `windowsJobObservationSchema`). The wrapper
  (`createTauriWindowsPrinting`, `windowsPrintResult`) never throws: `before_start` maps to
  `unsupported`, `invalid_payload`, `queue_unavailable`, `geometry_mismatch` and
  `driver_not_started`; a delivery in doubt, a failed IPC call, an answer of no known shape
  and a receipt naming another queue or document (dropped) are `driver_unknown`.
```

- [ ] **Step 2: AGENTS «Floor printing».** В разделе «## Floor printing» после первого абзаца (заканчивается «…a box keeps the SSCC and date it was closed with.») вставить абзац:

```markdown
A printer profile prints RAW (the printer's language) or through the Windows driver (plan
ДРВ): `mode: "windows_driver"` in the profile's JSON of the `printers` setting, allowed only
for a Windows queue; a profile without `mode` — every profile before the plan and every RAW
one since, the form writes the field only for the driver — is RAW, so stored profiles and
the printer snapshots of jobs read as before (no migration). A driver profile keeps its
last RAW language for switching back, and its resolution is required: the job's bytes are a
`mono-raster-v1` page of the snapshot's template at that resolution (`renderMonoLabel` +
`encodeMonoRaster` in the emitters' chunk) drawn with `rasterizeDriverText`, which refuses
(`render_failed`) rather than freeze a fallback face. The print runtime sends it through
the same per-address queue and 20 s limit as RAW, as `print_windows_raster` with a fresh
`Markiro:<uuid>`; the job walks the same states: `failed` for the driver's `before_start`
codes (`queue_unavailable`, `geometry_mismatch`, `driver_not_started`, `unsupported`,
`invalid_payload`), `unknown` `driver_unknown` for a delivery in doubt, and nothing is
ever sent again without the operator. The spooler receipt of a job's newest driver send is
kept in memory by the runtime (one that answered after the limit too; a new send forgets
it, a restart loses it) for «Проверить очередь Windows» on the label panel (unknown, or a
check waiting; driver printers only), whose answer is diagnostic and decides nothing.
`printAgain` renders again when the way of printing changes, even at one language and
resolution. The setup offers «Способ печати» for a Windows queue only where
`supports_windows_printing` is `true` (or the profile is already in driver mode), hides the
language in driver mode, says the driver's paper and resolution must match, and prints its
test label either way; the screens name a driver profile's format «Драйвер Windows»
(`printerFormatText`). Not done (plan ДРВ «Перенесено»): receipts in the database, the
saved raster's preview, a separate preflight, A4 sheets (plan A4).
```

- [ ] **Step 3: §28 спецификации пилота.** Дописать в конец `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (номер раздела — 28 независимо от того, какие из §25–27 уже есть):

```markdown
## 28. Уточнения плана ДРВ

План `docs/superpowers/plans/2026-10-11-standalone-drv-windows-driver-printing.md` переносит
печать через драйвер Windows облачной станции (#696).

- **Способ печати — свойство профиля принтера рабочего места.** «На языке принтера (ZPL /
  TSPL)» (по умолчанию и у всех прежних профилей) или «Через драйвер Windows» — только для
  очереди Windows. Хранится в JSON ключа `printers` таблицы `workstation_settings`; миграции
  нет, хоста и протокола не касается.
- **В режиме драйвера этикетка — монохромный растр `mono-raster-v1`** шаблона снимка смены
  при разрешении профиля; оболочка задаёт драйверу бумагу и разрешение растра, печатает 1:1 и
  отказывает до старта, если драйвер их не держит (`geometry_mismatch`).
- **Дисциплина печати цеха не меняется:** `sending` до отправки, одна отправка за раз на
  принтер, предел 20 с, отказ до старта — `failed` (печатать снова безопасно), сомнение —
  `unknown` `driver_unknown`, повтор — только решением оператора, с причиной, если этикетка
  может уже быть.
- **«Проверить очередь Windows»** на панели этикетки показывает, есть ли задание в очереди;
  отсутствие задания печать не подтверждает. Квитанция живёт в памяти приложения до
  перезапуска.
- **Перенесено:** квитанции в базе, предпросмотр сохранённого растра, отдельная проверка до
  отправки, листы A4 (план A4).
- **Не проверено без Windows и принтера:** вызовы спулера и GDI, поведение реальных драйверов
  (Godex, TSC, Zebra, Xprinter) с бумагой «пользовательского» размера, совпадение DPI драйвера,
  `GetJobW` после печати, кириллица шрифта IBM Plex в WebView2.
```

- [ ] **Step 4: Ручная проверка.** В `docs/runbooks/standalone-install.md`, раздел «## Ручная проверка на Windows», дописать подраздел:

```markdown
### Печать через драйвер Windows (план ДРВ)

1. Установить драйвер термопринтера (Godex, TSC, Zebra или Xprinter), в настройках драйвера —
   бумага размера этикетки, разрешение принтера (203 или 300 dpi).
2. «Настройка рабочего места» → «Добавить принтер» → «Принтер Windows (USB)» → очередь →
   «Способ печати: Через драйвер Windows», разрешение как у драйвера → «Готово» → «Сохранить».
3. «Пробная печать»: этикетка выходит без масштабирования, штрихкод читается сканером, код
   совпадает.
4. Неверное разрешение в профиле (300 при драйвере 203) — пробная печать отвечает «Размер
   бумаги или разрешение в драйвере Windows не совпадают…», ничего не печатается.
5. Смена с принтером в режиме драйвера: короб закрывается, этикетка печатается; кириллица —
   шрифтом IBM Plex.
6. Принтер выключен или очередь приостановлена: этикетка — «Принтер не ответил вовремя» или
   «Windows не подтвердил задание…»; «Проверить очередь Windows» показывает задание в очереди;
   «Напечатать снова» спрашивает причину; само ничего не перепечатывается.
7. Перезапуск программы с этикеткой в очереди: задание читается «Печать прервалась»,
   «Проверить очередь Windows» — «Номер задания Windows неизвестен».
```

- [ ] **Step 5: Итоговые гейты.**

```bash
pnpm --filter @markiro/standalone test
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
pnpm --filter @markiro/standalone build
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host
node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/runbooks/standalone-install.md \
  docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md apps/standalone/src-tauri/tests/fixtures/hardware-shapes.json
git diff --check
git diff --stat -- apps/standalone/Cargo.lock pnpm-lock.yaml   # пусто
```

Expected: всё зелёное (хост и `proto` не менялись — их прогоны подтверждают, что общий `Cargo.toml` воркспейса цел; если `--workspace` целиком упирается в песочницу/время — по пакетам, как здесь). Пропуски Vitest из-за отсутствия окружения — записать.

- [ ] **Step 6: Коммит.**

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md \
  docs/runbooks/standalone-install.md
git commit -F "$TMPDIR/drv-7.msg"
```

Сообщение: `docs(standalone): printing through the Windows driver — AGENTS, pilot spec §28, manual check (plan ДРВ task 7)` + пустая строка + трейлер.

---

## Перенесено

- **Квитанции спулера в базе** (облачная `printer_deliveries`): столбец `floor_print_jobs.driver_receipt` (миграция оболочки `0014`, отведённая ДРВ), правка закреплённого `OPEN_JOB_READ` в `src-tauri/tests/local_db.rs` и проверки непрерывности журнала миграций. Нужна, если «Проверить очередь Windows» должна работать после перезапуска.
- **Предпросмотр сохранённого растра** (облачные `LabelRasterPreview`, «Сохранённая этикетка») и «Проверено оператором — закрыть уведомление».
- **Отдельная проверка до отправки** (`preflight_windows_raster`) — см. Д3; при надобности её добавит план A4 вместе с геометрией листа.
- **Листы A4 паллет через драйвер** (`printer_sheet.rs`, `get_windows_page_geometry`, `supports_windows_a4_printing`) — план A4 (следующий в потоке PRT).
- **Логотип на термоэтикетке (#703)** — `renderMonoLabel` уже принимает `options.logo`; передачу логотипа в рендер станции делает план, переносящий #703.
- **Выгрузка растра в офисе** (кнопка «Скачать» для драйвера в редакторе шаблонов) — офис не печатает, ZPL/TSPL-выгрузок достаточно.
- **Пробный крейт в репозитории** (как облачный `tools/station-printer-tests`) — не добавляется: Windows-задание автонома уже компилирует и гоняет тесты оболочки на Windows.

## Не проверено

- Вызовы спулера и GDI (`OpenPrinterW`, `DocumentPropertiesW`, `CreateDCW`, `StartDocW`…`EndDoc`, `StretchDIBits`, `GetJobW`) — компилируются только в `standalone-windows-build` и пробным крейтом; на настоящей очереди не запускались.
- Реальные драйверы термопринтеров с бумагой `DMPAPER_USER`, их отчёт `GetDeviceCaps` (DPI, поля печати) и совпадение 1:1; облачная приёмка `docs/acceptance/station-windows-printing.md` — образец для ручной проверки.
- Шрифты IBM Plex через `document.fonts` в WebView2 (строгий `rasterizeDriverText` откажет, если шрифт не загрузится) — jsdom `document.fonts` не даёт, тест проверяет только отказ.
- Поведение очереди после «Приостановить»/выключенного принтера и значение `statusFlags`.
- Поведение предела 30 с оболочки при зависшем драйвере (тест проверяет только `await_driver` на заблокированной задаче).

## Отклонения при исполнении
