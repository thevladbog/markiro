# План 1f2: станция — киоск-режим, выход для администратора, поиск оператора по имени и строка состояния цеха — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Окно «Маркиро Автоном» работает как киоск — без рамки и кнопки на панели задач, поверх остальных окон, во весь монитор, закрыть его нельзя; выйти в оконный режим может только администратор офиса, а выход из офиса снова запирает окно. На экране входа оператор находит себя по имени и вводит PIN, а над экраном входа и заглушкой цеха стоит строка состояния: организация, линия, оператор и связь с хостом. План заменяет схему 1f2 в конце `docs/superpowers/plans/2026-10-07-standalone-1f-station-operator-signin.md`: та остаётся историей.

**Architecture:**

- `src-tauri/src/lockdown.rs` — перенос облачных `enter_lockdown`/`exit_lockdown` (`apps/station/src-tauri/src/commands.rs`): `LockdownState`, `lock`/`unlock`, команды и `refuse_close_while_locked` (страж закрытия окна); `lib.rs` регистрирует команды, состояние и стража. На Windows окно ложится на весь монитор через `SetWindowPos(HWND_TOPMOST)`; для этого шагом владельца в `src-tauri/Cargo.toml` добавляются два набора возможностей `windows-sys` (задача 1).
- `src/app/lockdown.ts` — перенос облачного `createLockdownLifecycle`: команды по одной, без повторов, без команд в режиме разработки. `App` запирает окно всякий раз, когда сессия офиса не открыта; `src/office/WindowModeButton.tsx` — «Оконный режим» в шапке офиса только для администратора, через `src/office/window-mode.tsx` (контекст, который `App` даёт `Office`).
- `src/floor/operator-search.ts` (перенос `searchOperatorsByName`) и `readOperatorRoster` в `src/floor/sign-in.ts`; шаг «Найти себя по имени» на экране входа; источник сканов получает `setManualTextEntryActive`, чтобы набранное имя не стало сканом.
- `src/floor/floor-status.ts` и `src/floor/FloorStatusBar.tsx` — строка состояния над экранами цеха в `App`; `HostStatusLine` уходит из самих экранов в неё.
- Хост, `proto`, `apps/station` и `packages/*` не меняются; новых зависимостей и крейтов нет. Манифест меняется одной строкой `src-tauri/Cargo.toml` (шаг владельца), `Cargo.lock` — нет.

**Tech Stack:** Rust — Tauri 2.11 (`tauri::test` с mock runtime в тестах), `windows-sys` 0.61.2 под `cfg(windows)`; вебвью — React 19.2, TypeScript 6 (strict), zod 4.4.3, i18next, `@markiro/ui` (`Button`, `Input`, `Card`, `PinPad`, `Alert`), `@tanstack/react-query` (через `useOfficeMutation`), Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`.

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1f2-design.md`: границы плана, решения D1–D8, постоянные ограничения процесса.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §5.1 (оболочка, киоск-режим), §5.2 (перенесённые команды), §5.6 (цех: поиск по имени, строка состояния), §8.
- `apps/standalone/AGENTS.md`: «Three identities», «Operators and badges» (правила входа 1f1, `copiesReady`, `pairingGuard`), «App shell», «Logs», «Verification».
- План 1f (`docs/superpowers/plans/2026-10-07-standalone-1f-station-operator-signin.md`): схема 1f2 (задачи 8–12), «Отклонения при исполнении», «Перенесено».
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src-tauri/src/{commands,lib}.rs`, `apps/station/src/lib/{lockdown,operator-search,scan-source}.ts`, `apps/station/src/ui/{OperatorNameSearch,StatusBar}.tsx`, их тесты.

## Global Constraints

**Решения контроллера** (обязательные; уточнения планировщика помечены «Уточнение»)

- D1. Два набора возможностей `windows-sys` (`Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging`) в `apps/standalone/src-tauri/Cargo.toml` — шаг владельца, задача 1, с точной строкой; `Cargo.lock` не меняется. Остальные задачи от этой правки не зависят и проверяются без неё; код под `cfg(windows)` компилируется только в задании `standalone-windows-build`. Новых крейтов нет. `set_system_awake` и `Win32_System_Power` — не в этом плане (решение владельца), в «Перенесено». Уточнение: `cargo check --target x86_64-pc-windows-msvc` для оболочки на машине проверки плана не собирается (C-код `aws-lc-sys` требует `windows.h`); вызовы `windows-sys` из `lockdown.rs` проверены отдельным крейтом-пробником с одной `windows-sys` под эту цель — сборка оболочки для Windows остаётся непроверенной до CI.
- D2. Выход из киоск-режима — учётная запись администратора офиса, без местного кода обслуживания (ещё один секрет на ПК). Без связи с хостом в офис не войти, и средствами приложения киоск-режим не покинуть; остаётся `Ctrl+Alt+Del` Windows. Вопрос владельцу и альтернатива («местный код») — в «Перенесено». Уточнение: перед тем как открыть окно, «Оконный режим» читает пользователя с хоста заново (`GET /v1/office/me`) и открывает окно, только если хост по-прежнему называет его администратором (корневой `AGENTS.md`: права перечитываются на защищённой границе).
- D3. Числа блокировок (10 неудач — станция на 1 минуту, 5 неверных PIN — PIN оператора на 5 минут), бездействие (10 минут) и табельные номера с ведущими нулями — без изменений с 1f1.
- D4. «Подключить заново» и «Сбросить подключение» (экраны отказа устройства, другого хоста и нечитаемой конфигурации) остаются доступны и в киоск-режиме: без них станцию не вернуть в строй. «Забывание» стирает копии и счётчики блокировок; эти экраны появляются, только когда хост отказал устройству или конфигурация не читается, — из цеха этого не вызвать, а станция на другом ПК подключается заново только по коду администратора. Станция на ПК хоста подключается заново сама (доверие loopback), и счётчики там начинаются с нуля — записано в документах и в «Перенесено»; политика счётчиков не меняется.
- D5. Офлайн прежде всего; PIN, бейдж и хеши — никогда в журналах, ошибках, строках IPC и снимках тестов; офис и оператор станции — разные личности. Правила 1f1 о `lineId` и подключении в проверке входа не меняются. Уточнение: поиск по имени читает только `id`, `login`, `name` (никогда `pin_phc`) и только копии этого подключения (`copiesReady`); киоск-режим пишет в журнал только имя команды.
- D6. Каждый интерактивный элемент цеха — 64 px (`size="floor"` у `Button`, `Input`, `PinPad`). Кнопка «Оконный режим» живёт в шапке офиса и следует её размеру (офис — не станционный экран).
- D7. Тесты: Vitest для вебвью с поддельным `invoke`; Rust — имена команд, голые отказы кодами (`no_window`, `window_failed`), `LockdownState` по умолчанию снят. Свойства окна, отказ закрыть окно в настоящем Windows и `SetWindowPos` — только ручная проверка в Windows, проверенными они не называются. Уточнение: новый набор `src-tauri/tests/lockdown.rs` гоняет команды и стража закрытия через цикл событий mock runtime (без сокетов, проходит в песочнице); то, что `run` ставит стража, и поведение настоящего окна — вручную.
- D8. Из перенесённого 1f1 берётся то, что лежит на этих экранах: кнопки «Офис» и «Повторить» экрана входа становятся 64 px. Подвисший IPC (около 35 с) и долгий IPC жизненного цикла остаются перенесёнными (причина — в «Перенесено»).

**Решения планировщика**

- Модуль жизненного цикла — `src/app/lockdown.ts`, а не `src/floor/`: киоск-режим — свойство окна оболочки, им пользуется и офис.
- Киоск-режим включается всякий раз, когда сессия офиса не открыта: при запуске, при «Выйти в цех», при истечении сессии (экран входа в офис), при отказе устройства. Оконный режим живёт ровно столько, сколько сессия администратора, которая его включила; повторно запереть окно изнутри офиса нечем и незачем — выход из офиса запирает.
- `exit_lockdown` снимает флаг первым и всегда; `enter_lockdown` ставит флаг только когда все свойства окна приняты, иначе откатывает их. Отказы — `no_window` (нет главного окна) и `window_failed` (окно не приняло свойство); текст оконной системы через IPC не идёт.
- Неудачный вход в киоск-режим пишется в журнал именем команды и повторяется при следующем закрытии офиса или перезапуске; экран об этом не говорит (в «Перенесено»).
- Строка состояния называет организацию (`ref_org`), а не станцию: имени устройства нет ни в `DeviceStatus`, ни в `device.json`, а его добавление — правка оболочки и формата `device.json` вне этого плана (в «Перенесено»). Линия называется и в архиве: станция работает на ней, пока офис её не переведёт. Строка — `section` с подписью (внутри `main` приложения `header` не был бы ориентиром).
- Результат поиска — «Имя — табельный номер»: облако показывает только имя, но двух операторов с одним именем так не различить; табельный номер — не секрет (AGENTS «Operators and badges»).
- Поиск по имени читает копии, когда шаг открывается и после каждой синхронизации; учитываются буквы любого алфавита, слова запроса ищутся по порядку как начало или середина слов имени, без свёртки «ё»/«е» (как в облаке).
- В `shell.css` у `.floor-sign-in` стоял `gap: var(--space-4)`, а такого токена нет: шаги шли без зазора. Задача 5 ставит `16px` (визуально не проверено).

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`, тексты даны в шагах целиком; кавычки — «ёлочки». Новые группы: `office.windowMode` (задача 4), ключи поиска в `floor.signIn` (задача 5), `floor.status` (задача 6).

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках. Именованные экспорты, `import type`. Члены интерфейсов, которые передаются несвязанными, — свойства-функции (`@typescript-eslint/unbound-method`).
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля и кнопки в `src/`); состояние словами; результаты поиска — в живой области `aria-live="polite"`.
- `apps/station`, `packages/*`, `apps/standalone/host`, `apps/standalone/proto`, `package.json` и `pnpm-lock.yaml` не меняются; `Cargo.lock` не меняется.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам, задача за задачей). Фрагменты одной правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше реализации.
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier и `cargo fmt`: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 пишется `\u001d` — это не кириллица.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным сообщением; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Тесты экранов: React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`; там, где нужно дождаться эффекта, тест ждёт текст или вызов. i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`).
- В Vitest `import.meta.env.DEV` — `true`: `App` без пропа `lockdown` команд не шлёт, и прежние тесты приложения окна не трогают. Тесты киоск-режима передают `createLockdownLifecycle({ dev: false, invoke })` с записывающим `invoke`.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: в выводе нет `stderr |` (предупреждений `act(...)` и ошибок React).
- Те же файлы экранов один раз запускаются под стендом с задержкой `setImmediate` на 3 мс (делает флейк эффекта постоянным). Стенд — два временных файла внутри пакета; запустить и сразу удалить, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  <!-- prettier-ignore -->
  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`.
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

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`, затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

- Cargo. Оболочка встраивает сборку вебвью (`tauri::generate_context!` читает `apps/standalone/dist`), поэтому перед её сборкой в свежем worktree: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Команды Cargo — с `--offline --locked` (`--locked` заодно доказывает, что `Cargo.lock` не меняется); если какого-то крейта нет в локальном кэше, та же команда без `--offline` — вне песочницы. Наборы, которые слушают сокет на loopback, в песочнице падают на `bind` (`cannot listen on 127.0.0.1:0: Operation not permitted`): хост — `changes_stream`, `hello`, `no_secrets_in_logs`, `platform`; оболочка — `claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `ipc`, `line`. Новый набор `lockdown` сокетов не открывает и песочницу проходит (около секунды: цикл событий mock runtime). Полный `cargo test --workspace` исполнитель запускает вне песочницы.

**Счёт тестов**

- До плана: Vitest — 63 файла, 1662 теста; cargo — 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107). После: Vitest — 66 файлов, 1703 теста; cargo — 42 набора, 461 тест (оболочка 115: библиотека 47, новый `lockdown` 4). Каждое «Expected» ниже измерено на копии репозитория с кодом самого плана; расхождение значит, что шаг применён не так (а тесты, которые исполнитель добавит сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку; задача 1 — шаг владельца (если владелец ещё не сделал его, исполнитель выполняет задачи 2–7 и оставляет задачу 1 открытой в отчёте: без неё сборка для Windows не компилируется).

<!-- prettier-ignore -->
```text
apps/standalone/src-tauri/Cargo.toml (одна строка, владелец)      задача 1
apps/standalone/src-tauri/src/lockdown.rs                         задача 2
apps/standalone/src-tauri/src/lib.rs                              задача 2
apps/standalone/src-tauri/tests/lockdown.rs                       задача 2
apps/standalone/src/app/lockdown.ts                               задача 3
apps/standalone/test/lockdown.test.ts                             задача 3
apps/standalone/src/app/App.tsx                                   задачи 3, 4, 6
apps/standalone/test/app.test.tsx                                 задачи 3, 4, 5, 6
apps/standalone/src/office/{window-mode.tsx,WindowModeButton.tsx} задача 4
apps/standalone/src/office/{Office.tsx,OfficeShell.tsx}           задача 4
apps/standalone/test/office.test.tsx                              задача 4
apps/standalone/src/i18n/ru.json                                  задачи 4, 5, 6
apps/standalone/src/floor/operator-search.ts                      задача 5
apps/standalone/src/floor/{scan-source.ts,sign-in.ts}             задача 5
apps/standalone/src/floor/OperatorSignIn.tsx                      задачи 5, 6
apps/standalone/src/app/shell.css                                 задачи 5, 6
apps/standalone/test/operator-search.test.ts                      задача 5
apps/standalone/test/operator-sign-in.test.tsx                    задачи 5, 6
apps/standalone/src/floor/{floor-status.ts,FloorStatusBar.tsx}    задача 6
apps/standalone/src/floor/FloorOperatorScreen.tsx                 задача 6
apps/standalone/test/floor-status-bar.test.tsx                    задача 6
apps/standalone/test/floor-operator.test.tsx                      задача 6
apps/standalone/AGENTS.md, спецификация §5.1, §5.2, §5.6, §8       задача 7
```

Rust-часть (задача 2) не зависит от вебвью. Жизненный цикл и запирание окна в `App` (задача 3) проверяются до кнопки выхода; задача 4 добавляет выход для администратора. Поиск по имени (задача 5) и строка состояния (задача 6) — независимые экраны цеха; строка состояния забирает `HostStatusLine` из экранов, поэтому идёт после поиска. Задача 7 — документы и ручной список для Windows.

---

### Task 1: Шаг владельца — два набора возможностей `windows-sys`

**Files:**

- Modify (владелец): `apps/standalone/src-tauri/Cargo.toml:30`

**Interfaces:**

- Produces: `windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST}` и `windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW}` для `cfg(windows)`-кода задачи 2.

Это правка манифеста, не новый крейт (D1): `windows-sys` уже подключён для Windows с той же точной версией `=0.61.2`. Наборы возможностей не тянут новых пакетов, поэтому `Cargo.lock` не меняется. Исполнитель манифест сам не правит.

- [ ] **Step 1: Владелец меняет строку**

Правка `apps/standalone/src-tauri/Cargo.toml`:

Фрагмент:

<!-- prettier-ignore -->
```toml
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }
```

заменить на:

<!-- prettier-ignore -->
```toml
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Security_Cryptography", "Win32_UI_WindowsAndMessaging"] }
```

- [ ] **Step 2: Проверить правку**

Run: `git diff apps/standalone/src-tauri/Cargo.toml`
Expected: ровно одна строка `-`/`+`, как в шаге 1.

Run: `cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib`
Expected: `Finished`; `--locked` не жалуется на устаревший `Cargo.lock`.

Run: `git diff --stat apps/standalone/Cargo.lock`
Expected: пусто.

На macOS и Linux код под `cfg(windows)` не компилируется, поэтому эта сборка не проверяет сами возможности; их проверяет задание CI `standalone-windows-build` (`cargo test --workspace` и `tauri build --debug --no-bundle` на Windows). Локальный `cargo check --target x86_64-pc-windows-msvc` для оболочки на машине без Windows SDK падает в C-коде `aws-lc-sys` (`'windows.h' file not found`) — это не ошибка плана.

- [ ] **Step 3: Commit**

```bash
git add apps/standalone/src-tauri/Cargo.toml
git commit -m "build(standalone): windows-sys features for kiosk mode (owner step)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Киоск-режим в оболочке (Rust): команды и страж закрытия

**Files:**

- Create: `apps/standalone/src-tauri/src/lockdown.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs` (модуль, список команд, `run`)
- Test: `apps/standalone/src-tauri/tests/lockdown.rs` (новый набор), модульные тесты в `lockdown.rs`

**Interfaces:**

- Consumes: возможности `windows-sys` задачи 1 (только под `cfg(windows)`).
- Produces (для задачи 3 — по IPC): команды `enter_lockdown` и `exit_lockdown` без аргументов; успех — `null`; отказ — голая строка `"no_window"` (нет окна `main`) или `"window_failed"` (окно не приняло свойство). Rust: `pub const MAIN_WINDOW: &str = "main"`, `pub struct LockdownState` (`Default` — снят, `is_locked(&self) -> bool`), `pub fn lock<R: Runtime>(app: &AppHandle<R>, state: &LockdownState) -> Result<(), LockdownError>`, `pub fn unlock<R: Runtime>(…) -> Result<(), LockdownError>`, `pub fn refuse_close_while_locked<R: Runtime>(window: &Window<R>, event: &WindowEvent)`, `pub enum LockdownError { NoWindow, WindowFailed }` с `code()`.

Отличия от облачного `commands.rs` (там тестов окна нет вовсе): команды обобщены по `Runtime` (их гоняет mock runtime), отказы — коды, а не текст оконной системы; `unlock` снимает флаг до всего остального (облако — после восстановления свойств), а флаг читает и пишет без паники на «отравленном» мьютексе (отравленный читается как «снят»: окно, которое не закрывается из-за упавшего потока, хуже).

- [ ] **Step 1: Написать падающий тест — новый набор `tests/lockdown.rs`**

Создать `apps/standalone/src-tauri/tests/lockdown.rs`:

<!-- prettier-ignore -->
```rust
//! Kiosk mode through Tauri's mock runtime (plan 1f2): the command names the
//! webview invokes (`src/app/lockdown.ts`), their bare refusals and the flag
//! the close guard reads. The mock window accepts every property; on Windows
//! covering the monitor needs a real window handle, which the mock's is not,
//! so there the tests that need a locked window do not run. What Windows
//! really does with the window is checked by hand, never here.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use markiro_standalone_lib::connection::ConnectionState;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::local_db::LocalDbState;
use markiro_standalone_lib::lockdown::{self, LockdownState, MAIN_WINDOW};
use serde_json::{json, Value};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, RunEvent, WebviewWindow, WindowEvent};

/// The app's command list on the mock runtime, with one
/// window labelled `label`. The `App` must outlive the window.
fn mock_app(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(DeviceState::load(dir.path().to_path_buf()))
        .manage(LocalDbState::unavailable())
        .manage(ConnectionState::default())
        .manage(LockdownState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// Invokes `command` as the webview's `invoke` does; a rejection comes back
/// as the JSON value the command rejected with.
fn invoke(webview: &WebviewWindow<MockRuntime>, command: &str) -> Result<Value, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: json!({}).into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn locked(app: &App<MockRuntime>) -> bool {
    app.state::<LockdownState>().is_locked()
}

#[cfg(not(windows))]
#[test]
fn the_kiosk_commands_turn_the_flag_on_and_off() {
    let (app, webview) = mock_app(MAIN_WINDOW);
    assert!(!locked(&app));

    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert!(locked(&app));
    // Again: nothing changes, nothing fails.
    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert!(locked(&app));

    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
}

/// `SetWindowPos` refuses the mock window's handle (or Windows finds no
/// monitor for it): the enter is refused and rolled back, the flag stays off.
/// Should a Windows version accept it, the flag must be on instead.
#[cfg(windows)]
#[test]
fn on_windows_a_refused_enter_leaves_the_flag_off() {
    let (app, webview) = mock_app(MAIN_WINDOW);
    match invoke(&webview, "enter_lockdown") {
        Ok(Value::Null) => assert!(locked(&app)),
        refused => {
            assert_eq!(refused, Err(json!("window_failed")));
            assert!(!locked(&app));
        }
    }
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
}

#[test]
fn without_a_main_window_both_commands_refuse_with_a_bare_code() {
    let (app, webview) = mock_app("other");

    assert_eq!(invoke(&webview, "enter_lockdown"), Err(json!("no_window")));
    assert!(!locked(&app));
    assert_eq!(invoke(&webview, "exit_lockdown"), Err(json!("no_window")));
}

/// Runs the mock event loop, asks the main window to close once it runs (a
/// close asked for before that drops the window without an event), and
/// counts the close requests the loop sees. The mock runtime never calls a
/// builder's window-event handler, so the loop's callback hands each request
/// to the guard itself; that `run` installs the guard is checked on Windows.
/// The guard's answer to the first request decides: refused, the test
/// unlocks and asks again, so the window closes on the second request; let
/// through, the window closes on the first and the loop ends there.
fn close_requests(lock_first: bool) -> usize {
    let (app, webview) = mock_app(MAIN_WINDOW);
    if lock_first {
        assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    }
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&seen);
    app.run_return(move |handle, event| match event {
        RunEvent::Ready => webview.close().unwrap(),
        RunEvent::WindowEvent { label, event, .. } => {
            if !matches!(event, WindowEvent::CloseRequested { .. }) {
                return;
            }
            let window = handle.get_webview_window(&label).unwrap();
            lockdown::refuse_close_while_locked(&window.as_ref().window(), &event);
            let count = counter.fetch_add(1, Ordering::SeqCst) + 1;
            if count == 1 {
                lockdown::unlock(handle, &handle.state::<LockdownState>()).unwrap();
                window.close().unwrap();
            } else if count > 3 {
                // A guard that never lets go would spin this loop forever.
                window.destroy().unwrap();
            }
        }
        _ => {}
    });
    seen.load(Ordering::SeqCst)
}

#[cfg(not(windows))]
#[test]
fn a_close_request_is_refused_while_kiosk_mode_is_on() {
    assert_eq!(close_requests(true), 2);
}

#[test]
fn a_close_request_goes_through_while_kiosk_mode_is_off() {
    assert_eq!(close_requests(false), 1);
}
```

- [ ] **Step 2: Убедиться, что он падает**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown`
Expected: FAIL при сборке — «error[E0432]: unresolved imports `markiro_standalone_lib::lockdown`».

- [ ] **Step 3: Модуль `lockdown.rs` (с модульными тестами)**

Создать `apps/standalone/src-tauri/src/lockdown.rs`:

<!-- prettier-ignore -->
```rust
//! Kiosk mode of the station window (stage 1 spec §5.1, plan 1f2), ported
//! from the cloud station's `enter_lockdown` and `exit_lockdown`
//! (`apps/station/src-tauri/src/commands.rs`). While it is on, the main
//! window has no frame and no taskbar button, stays above every other
//! window, fills its monitor and refuses to close (`refuse_close_while_locked`).
//! The webview decides when (`src/app/lockdown.ts`); only the office
//! administrator turns it off. Refusals are bare codes, as everywhere in the
//! shell: `no_window` when there is no main window, `window_failed` when the
//! window refused a property; the window system's own text is never sent.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow, Window, WindowEvent};

/// The label of the app's only window (`tauri.conf.json` names none, so it is `main`).
pub const MAIN_WINDOW: &str = "main";

/// Whether the main window is in kiosk mode; off when the app starts.
#[derive(Debug, Default)]
pub struct LockdownState(Mutex<bool>);

impl LockdownState {
    /// Whether kiosk mode is on. A poisoned lock reads as off: the flag must
    /// never keep a window from closing because a thread panicked holding it.
    pub fn is_locked(&self) -> bool {
        self.0.lock().map(|locked| *locked).unwrap_or(false)
    }

    fn set(&self, locked: bool) {
        match self.0.lock() {
            Ok(mut flag) => *flag = locked,
            Err(poisoned) => *poisoned.into_inner() = locked,
        }
    }
}

/// Why a kiosk command failed, as the bare code the webview reads.
#[derive(Debug, PartialEq, Eq)]
pub enum LockdownError {
    /// There is no main window to lock or unlock.
    NoWindow,
    /// The window refused a property (or, on Windows, covering its monitor).
    WindowFailed,
}

impl LockdownError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoWindow => "no_window",
            Self::WindowFailed => "window_failed",
        }
    }
}

/// Places the window over its whole monitor, above the taskbar. Fullscreen
/// alone leaves the taskbar on top on some Windows setups; `SetWindowPos`
/// with `HWND_TOPMOST` over `rcMonitor` does not.
#[cfg(windows)]
fn cover_current_monitor<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), LockdownError> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW},
    };

    let native = window.hwnd().map_err(|_| LockdownError::WindowFailed)?;
    let hwnd = native.0 as HWND;
    // SAFETY: `hwnd` is this process's live main window, as Tauri reports it.
    let monitor_handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor_handle.is_null() {
        return Err(LockdownError::WindowFailed);
    }
    let mut monitor = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `monitor` is a properly sized MONITORINFO the call fills in.
    if unsafe { GetMonitorInfoW(monitor_handle, &mut monitor) } == 0 {
        return Err(LockdownError::WindowFailed);
    }
    let bounds = monitor.rcMonitor;
    // SAFETY: plain values; `hwnd` as above.
    let placed = unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
    };
    if placed == 0 {
        return Err(LockdownError::WindowFailed);
    }
    window.set_focus().map_err(|_| LockdownError::WindowFailed)
}

/// Elsewhere fullscreen is enough; kiosk mode is a Windows product feature.
#[cfg(not(windows))]
fn cover_current_monitor<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), LockdownError> {
    Ok(())
}

/// Every property back to an ordinary window, each tried whatever the others
/// did (a `?` chain would leave the window half-locked); `true` when all held.
fn restore_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let results = [
        window.set_fullscreen(false),
        window.set_always_on_top(false),
        window.set_skip_taskbar(false),
        window.set_decorations(true),
    ];
    results.iter().all(Result::is_ok)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, LockdownError> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or(LockdownError::NoWindow)
}

/// Turns kiosk mode on: no frame, no taskbar button, above every window,
/// fullscreen over its monitor. The flag is set only once every property
/// held; a failure rolls every property back and leaves the flag off, so a
/// window that is not fully locked can still be closed.
pub fn lock<R: Runtime>(app: &AppHandle<R>, state: &LockdownState) -> Result<(), LockdownError> {
    let window = main_window(app)?;
    let applied = window
        .set_decorations(false)
        .and_then(|()| window.set_skip_taskbar(true))
        .and_then(|()| window.set_always_on_top(true))
        .and_then(|()| window.set_fullscreen(true))
        .map_err(|_| LockdownError::WindowFailed)
        .and_then(|()| cover_current_monitor(&window));
    if let Err(error) = applied {
        restore_window(&window);
        state.set(false);
        return Err(error);
    }
    state.set(true);
    Ok(())
}

/// Turns kiosk mode off. The flag goes off first and always, so the window
/// can be closed even when a property did not come back: an operator is
/// never trapped in a window that refuses to close.
pub fn unlock<R: Runtime>(app: &AppHandle<R>, state: &LockdownState) -> Result<(), LockdownError> {
    state.set(false);
    let window = main_window(app)?;
    if restore_window(&window) {
        Ok(())
    } else {
        Err(LockdownError::WindowFailed)
    }
}

#[tauri::command]
pub fn enter_lockdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LockdownState>,
) -> Result<(), String> {
    lock(&app, &state).map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn exit_lockdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LockdownState>,
) -> Result<(), String> {
    unlock(&app, &state).map_err(|error| error.code().to_owned())
}

/// The window-event guard `run` installs: a close request (the frame's
/// button, Alt+F4, the taskbar) is refused while kiosk mode is on. Checked
/// at the event, not through `set_closable`, which Linux does not honour.
pub fn refuse_close_while_locked<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<LockdownState>().is_locked() {
            api.prevent_close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiosk_mode_is_off_when_the_app_starts() {
        assert!(!LockdownState::default().is_locked());
    }

    #[test]
    fn the_flag_follows_set() {
        let state = LockdownState::default();
        state.set(true);
        assert!(state.is_locked());
        state.set(false);
        assert!(!state.is_locked());
    }

    #[test]
    fn leaving_kiosk_mode_clears_the_flag_even_without_a_window() {
        let app = tauri::test::mock_app();
        let state = LockdownState::default();
        state.set(true);
        assert_eq!(unlock(app.handle(), &state), Err(LockdownError::NoWindow));
        assert!(!state.is_locked());
    }

    #[test]
    fn refusals_are_bare_codes() {
        assert_eq!(LockdownError::NoWindow.code(), "no_window");
        assert_eq!(LockdownError::WindowFailed.code(), "window_failed");
    }
}
```

- [ ] **Step 4: Подключить модуль, команды и стража в `lib.rs`**

Правка `apps/standalone/src-tauri/src/lib.rs` (3 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod local_db;
pub mod secret_store;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod local_db;
pub mod lockdown;
pub mod secret_store;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        local_transaction,
        connection_status
    ]
```

заменить на:

<!-- prettier-ignore -->
```rust
        local_transaction,
        connection_status,
        lockdown::enter_lockdown,
        lockdown::exit_lockdown
    ]
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
```

заменить на:

<!-- prettier-ignore -->
```rust
        .manage(lockdown::LockdownState::default())
        .on_window_event(lockdown::refuse_close_while_locked)
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
```

- [ ] **Step 5: Тесты проходят**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
Expected: чисто (`rustfmt` форматирует и `cfg(windows)`-блок).

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test lockdown`
Expected: PASS — библиотека 47 тестов (было 43; +4 в `lockdown::tests`), `lockdown` 4 теста (около секунды). На Windows этот набор — 3 теста: запереть окно mock runtime там нельзя (`SetWindowPos` не примет его поддельный дескриптор), поэтому тесты, которым нужно запертое окно, стоят под `cfg(not(windows))`, а под `cfg(windows)` идёт `on_windows_a_refused_enter_leaves_the_flag_off`; его исполняет только задание `standalone-windows-build`, и до него он не проверен.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-run`
Expected: собирается без предупреждений.

- [ ] **Step 6: Мутации (по «Заметкам для исполнения»)**

М1 — страж не отказывает. В `apps/standalone/src-tauri/src/lockdown.rs` строку

<!-- prettier-ignore -->
```rust
            api.prevent_close();
```

заменить на

<!-- prettier-ignore -->
```rust
            let _ = api;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown`
Expected: FAIL `a_close_request_is_refused_while_kiosk_mode_is_on` — «assertion `left == right` failed», `left: 1`, `right: 2`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — флаг снимается только при окне. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    state.set(false);
    let window = main_window(app)?;
    if restore_window
```

заменить на

<!-- prettier-ignore -->
```rust
    let window = main_window(app)?;
    state.set(false);
    if restore_window
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib lockdown`
Expected: FAIL `lockdown::tests::leaving_kiosk_mode_clears_the_flag_even_without_a_window`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/src-tauri/src/lockdown.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/lockdown.rs
git commit -m "feat(standalone): kiosk-mode commands and the close guard in the shell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Жизненный цикл киоск-режима в вебвью; `App` запирает окно, пока офис закрыт

**Files:**

- Create: `apps/standalone/src/app/lockdown.ts`
- Modify: `apps/standalone/src/app/App.tsx` (импорт, проп `lockdown`, `kiosk`, эффект запирания)
- Test: `apps/standalone/test/lockdown.test.ts` (новый), `apps/standalone/test/app.test.tsx` (импорт, `Services`, `recordingLockdown`, `describe("kiosk mode")`)

**Interfaces:**

- Consumes: команды задачи 2 — `invoke("enter_lockdown")`, `invoke("exit_lockdown")`.
- Produces: `export type LockdownCommand = "enter_lockdown" | "exit_lockdown"`; `export interface LockdownSnapshot { mode: "locked" | "windowed"; pending: boolean; error: "enter" | "exit" | null }`; `export interface LockdownLifecycle { enabled: boolean; enter: () => Promise<void>; exit: () => Promise<void>; subscribe: (listener: () => void) => () => void; getSnapshot: () => LockdownSnapshot; clearError: () => void }`; `export function createLockdownLifecycle(options: { dev: boolean; invoke?: (command: LockdownCommand) => Promise<unknown>; logError?: (message: string) => void }): LockdownLifecycle`. `AppProps.lockdown?: LockdownLifecycle` (по умолчанию `createLockdownLifecycle({ dev: import.meta.env.DEV })`); в `App` — `const kiosk` (задача 4 читает его снимок и зовёт `kiosk.exit()`), `const officeOpen = session !== null`. В `test/app.test.tsx` — `recordingLockdown(): { lockdown, commands: LockdownCommand[], failing: Set<LockdownCommand> }` (задача 4 им пользуется).

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/lockdown.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import { createLockdownLifecycle, type LockdownCommand } from "../src/app/lockdown.js";

/** An `invoke` whose every call waits until the test resolves it. */
function heldInvoke() {
  const pending: Array<() => void> = [];
  const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    invoke,
    release: () => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no command is waiting");
      next();
    },
  };
}

describe("the kiosk-mode lifecycle", () => {
  it("publishes the pending and the confirmed mode around each command", async () => {
    const held = heldInvoke();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: held.invoke });
    const snapshots = [lifecycle.getSnapshot()];
    lifecycle.subscribe(() => snapshots.push(lifecycle.getSnapshot()));

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledWith("enter_lockdown"));
    expect(snapshots).toEqual([
      { mode: "windowed", pending: false, error: null },
      { mode: "windowed", pending: true, error: null },
    ]);

    held.release();
    await entering;
    expect(snapshots.at(-1)).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends one command for a mode asked for twice, as StrictMode's second effect does", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => undefined);
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });

    await Promise.all([lifecycle.enter(), lifecycle.enter()]);
    await lifecycle.exit();
    await lifecycle.exit();
    await lifecycle.enter();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
      "enter_lockdown",
    ]);
  });

  it("runs an exit asked for during an enter after it, never alongside", async () => {
    const held = heldInvoke();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: held.invoke });

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledTimes(1));
    const exiting = lifecycle.exit();
    await Promise.resolve();
    expect(held.invoke).toHaveBeenCalledTimes(1);

    held.release();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledTimes(2));
    held.release();
    await Promise.all([entering, exiting]);
    expect(held.invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
    ]);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("keeps the confirmed mode after a failure and names only its direction", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async (command) => {
      if (command === "exit_lockdown") throw "window_failed: secret-detail";
    });
    const logError = vi.fn<(message: string) => void>();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError });

    await lifecycle.enter();
    await lifecycle.exit();

    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: "exit" });
    expect(logError.mock.calls).toEqual([["standalone: exit_lockdown failed"]]);
    lifecycle.clearError();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends the same command again after it failed, and the other one after a half-done enter", async () => {
    let failEnter = true;
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async (command) => {
      if (command === "enter_lockdown" && failEnter) throw "window_failed";
    });
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError: vi.fn() });

    await lifecycle.enter();
    // The failed enter may have changed some properties: exit is sent.
    await lifecycle.exit();
    await lifecycle.enter();
    failEnter = false;
    await lifecycle.enter();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
      "enter_lockdown",
      "enter_lockdown",
    ]);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends nothing in development", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => undefined);
    const lifecycle = createLockdownLifecycle({ dev: true, invoke });

    await lifecycle.enter();
    await lifecycle.exit();

    expect(lifecycle.enabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("stops telling a listener once it unsubscribed", async () => {
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: async () => undefined });
    const listener = vi.fn();
    const unsubscribe = lifecycle.subscribe(listener);
    unsubscribe();
    await lifecycle.enter();
    expect(listener).not.toHaveBeenCalled();
  });
});
```

Правка `apps/standalone/test/app.test.tsx` (3 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useHostLink } from "../src/app/host-link.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useHostLink } from "../src/app/host-link.js";
import {
  createLockdownLifecycle,
  type LockdownCommand,
  type LockdownLifecycle,
} from "../src/app/lockdown.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  idleTimeoutMs?: number;
  scanSource?: ScanSource;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  idleTimeoutMs?: number;
  scanSource?: ScanSource;
  lockdown?: LockdownLifecycle;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
describe("useHostLink", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
/**
 * Kiosk mode as a built app has it (`dev: false`), with the shell's commands
 * recorded instead of sent; a command in `failing` refuses.
 */
function recordingLockdown() {
  const commands: LockdownCommand[] = [];
  const failing = new Set<LockdownCommand>();
  const lockdown = createLockdownLifecycle({
    dev: false,
    invoke: async (command) => {
      commands.push(command);
      if (failing.has(command)) throw "window_failed";
    },
    logError: () => undefined,
  });
  return { lockdown, commands, failing };
}

describe("kiosk mode", () => {
  it("locks the window once at start, under StrictMode too, and keeps it locked through the office", async () => {
    const kiosk = recordingLockdown();
    render(
      <StrictMode>
        <ThemeProvider defaultTheme="dark">
          <App
            probe={probeAnswering(true)}
            device={fakeDevice(DEVICE_STATUS)}
            host={fakeHost()}
            connection={fakeConnection().connection}
            local={openLocalDb().executor}
            address={ADDRESS}
            lockdown={kiosk.lockdown}
          />
        </ThemeProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    // Already locked: neither the office nor the way back sends anything.
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
  });

  it("tries a lock that failed again when the office closes", async () => {
    const kiosk = recordingLockdown();
    kiosk.failing.add("enter_lockdown");
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: kiosk.lockdown,
    });
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
    kiosk.failing.clear();

    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "enter_lockdown"]));
  });

  it("sends no kiosk command in development, where the window stays ordinary", async () => {
    const invoke = vi.fn(async () => undefined);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: createLockdownLifecycle({ dev: true, invoke }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("useHostLink", () => {
```

- [ ] **Step 2: Убедиться, что они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lockdown.test.ts test/app.test.tsx -t "kiosk|lifecycle"`
Expected: FAIL — оба файла: `Failed to resolve import "../src/app/lockdown.js"`.

- [ ] **Step 3: Модуль жизненного цикла**

Создать `apps/standalone/src/app/lockdown.ts`:

<!-- prettier-ignore -->
```ts
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** The shell's kiosk-mode commands (`src-tauri/src/lockdown.rs`). */
export type LockdownCommand = "enter_lockdown" | "exit_lockdown";

/**
 * The window as the lifecycle last confirmed it: `locked` (kiosk mode) or
 * `windowed`; `pending` while a command runs; `error` names the direction of
 * the last command that failed, never its text.
 */
export interface LockdownSnapshot {
  mode: "locked" | "windowed";
  pending: boolean;
  error: "enter" | "exit" | null;
}

/**
 * Kiosk mode as the webview drives it. Every member is a function-typed
 * property, so it may be passed around unbound
 * (`@typescript-eslint/unbound-method`), as `useSyncExternalStore` takes them.
 */
export interface LockdownLifecycle {
  /** `false` in development (`import.meta.env.DEV`): no command is ever sent. */
  enabled: boolean;
  /** Turns kiosk mode on; resolves once every command asked for so far has settled. */
  enter: () => Promise<void>;
  /** Turns kiosk mode off (the office administrator's «Оконный режим»). */
  exit: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LockdownSnapshot;
  /** Forgets the last failure without changing the confirmed mode. */
  clearError: () => void;
}

export interface LockdownOptions {
  dev: boolean;
  invoke?: (command: LockdownCommand) => Promise<unknown>;
  /** Where a failure is reported: the command's name only, never what it threw. */
  logError?: (message: string) => void;
}

/**
 * Ported from the cloud station's `createLockdownLifecycle`
 * (`apps/station/src/lib/lockdown.ts`). Commands run one after another, and
 * a request for the mode already asked for adds nothing, so a re-render or
 * React StrictMode's second effect sends no second command. After a failed
 * command the window may hold only some of its properties, so the next
 * request is sent whatever the confirmed mode says. A command whose IPC never
 * answers holds the later ones: the commands are synchronous in the shell, so
 * the window itself is hung then, and a timeout that let the next command
 * overlap it could leave the window locked while the snapshot says windowed.
 */
export function createLockdownLifecycle({
  dev,
  invoke = tauriInvoke,
  logError = (message) => console.error(message),
}: LockdownOptions): LockdownLifecycle {
  const enabled = !dev;
  // `null`: a failed command may have changed only some window properties.
  let applied: boolean | null = false;
  let requested: boolean | null = null;
  let settled: Promise<void> = Promise.resolve();
  let snapshot: LockdownSnapshot = { mode: "windowed", pending: false, error: null };
  const listeners = new Set<() => void>();

  const publish = (next: LockdownSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const request = (next: boolean): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (requested === next) return settled;
    requested = next;
    const command: LockdownCommand = next ? "enter_lockdown" : "exit_lockdown";
    settled = settled.then(async () => {
      if (applied === next) return;
      publish({ mode: snapshot.mode, pending: true, error: null });
      try {
        await invoke(command);
        applied = next;
        publish({ mode: next ? "locked" : "windowed", pending: false, error: null });
      } catch {
        applied = null;
        // A later request supersedes this one; only the matching one is
        // forgotten, so the same command can be asked for again.
        if (requested === next) requested = null;
        publish({ mode: snapshot.mode, pending: false, error: next ? "enter" : "exit" });
        logError(`standalone: ${command} failed`);
      }
    });
    return settled;
  };

  return {
    enabled,
    enter: () => request(true),
    exit: () => request(false),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    clearError: () => {
      if (snapshot.error === null) return;
      publish({ mode: snapshot.mode, pending: snapshot.pending, error: null });
    },
  };
}
```

Run: та же команда, что в шаге 2.
Expected: FAIL — 2 теста из `kiosk mode` (`locks the window once at start, under StrictMode too, and keeps it locked through the office`, `tries a lock that failed again when the office closes`): `AssertionError: expected [] to deeply equal [ 'enter_lockdown' ]`; 8 проходят (7 жизненного цикла и тест режима разработки), 82 пропущены.

- [ ] **Step 4: `App` запирает окно, пока сессия офиса не открыта**

Правка `apps/standalone/src/app/App.tsx` (5 фрагментов):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { LineSelect } from "./LineSelect.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { LineSelect } from "./LineSelect.js";
import { createLockdownLifecycle, type LockdownLifecycle } from "./lockdown.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  /** The shortest wait between two syncs the sign-in asks for; tests lengthen it. */
  signInSyncGapMs?: number;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /** The shortest wait between two syncs the sign-in asks for; tests lengthen it. */
  signInSyncGapMs?: number;
  /** Kiosk mode of the window: the shell's commands outside development by default. */
  lockdown?: LockdownLifecycle;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  signInSyncGapMs = SIGN_IN_SYNC_GAP_MS,
}: AppProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  signInSyncGapMs = SIGN_IN_SYNC_GAP_MS,
  lockdown,
}: AppProps) {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  const scanner = useMemo(() => scanSource ?? createKeyboardWedgeSource(), [scanSource]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const scanner = useMemo(() => scanSource ?? createKeyboardWedgeSource(), [scanSource]);
  const kiosk = useMemo(
    () => lockdown ?? createLockdownLifecycle({ dev: import.meta.env.DEV }),
    [lockdown],
  );
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  const session = view.kind === "office" ? view.session : null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const session = view.kind === "office" ? view.session : null;

  // Kiosk mode whenever no office session is open: at start, when the office
  // closes and when its session ends. Only an open session's administrator
  // turns it off («Оконный режим»), and only until that session ends.
  const officeOpen = session !== null;
  useEffect(() => {
    if (!officeOpen) void kiosk.enter();
  }, [kiosk, officeOpen]);
```

- [ ] **Step 5: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lockdown.test.ts test/app.test.tsx -t "kiosk|lifecycle"`
Expected: PASS — 10 тестов (82 пропущены).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 64 файла, 1672 теста.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/lockdown.test.ts test/app.test.tsx`
Expected: PASS, в выводе нет `stderr |`. Затем `test/app.test.tsx` под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 6: Мутации**

М1 — запирание только при запуске. В `apps/standalone/src/app/App.tsx` строку

<!-- prettier-ignore -->
```tsx
  }, [kiosk, officeOpen]);
```

заменить на

<!-- prettier-ignore -->
```tsx
  }, [kiosk]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "kiosk"`
Expected: FAIL `tries a lock that failed again when the office closes` — `AssertionError: expected [ 'enter_lockdown' ] to deeply equal [ 'enter_lockdown', 'enter_lockdown' ]`. Восстановить, `cmp` молчит, хеш прежний.

М2 — неудачная команда не повторяется. В `apps/standalone/src/app/lockdown.ts` удалить строку

<!-- prettier-ignore -->
```ts
        if (requested === next) requested = null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lockdown.test.ts`
Expected: FAIL `sends the same command again after it failed, and the other one after a half-done enter` — `AssertionError: expected [ 'enter_lockdown', …(2) ] to deeply equal [ 'enter_lockdown', …(3) ]`. Восстановить, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Commit**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/lockdown.ts apps/standalone/src/app/App.tsx apps/standalone/test/lockdown.test.ts apps/standalone/test/app.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

```bash
git add apps/standalone/src/app/lockdown.ts apps/standalone/src/app/App.tsx apps/standalone/test/lockdown.test.ts apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): the webview locks the window whenever the office is closed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: «Оконный режим» для администратора офиса

**Files:**

- Create: `apps/standalone/src/office/window-mode.tsx`, `apps/standalone/src/office/WindowModeButton.tsx`
- Modify: `apps/standalone/src/office/Office.tsx` (проп `windowMode`, провайдер), `apps/standalone/src/office/OfficeShell.tsx` (кнопка в шапке), `apps/standalone/src/app/App.tsx` (снимок, `leaveKiosk`, `windowMode`), `apps/standalone/src/i18n/ru.json` (`office.windowMode`)
- Test: `apps/standalone/test/office.test.tsx`, `apps/standalone/test/app.test.tsx`

**Interfaces:**

- Consumes: `kiosk` (`LockdownLifecycle`), `officeOpen`, `recordingLockdown` — задача 3; `useOfficeMutation`, `useOfficeSession`, `FormDialog`, `WriteFailureAlert`, `alertFailure` — существующие.
- Produces: `export interface WindowMode { mode: "locked" | "windowed"; leave: () => Promise<boolean> }`, `WindowModeProvider`, `useWindowMode(): WindowMode | null`; `OfficeProps.windowMode?: WindowMode | null` (по умолчанию `null`); `WindowModeButton` (без пропсов). `App` даёт `Office` объект `WindowMode` только сессии администратора в сборке, которая запирает окно (`kiosk.enabled`), иначе `null`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/office.test.tsx` (2 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { OfficeLogin } from "../src/office/OfficeLogin.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { OfficeLogin } from "../src/office/OfficeLogin.js";
import type { WindowMode } from "../src/office/window-mode.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
describe("ChangePasswordDialog", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
describe("«Оконный режим» in the office header", () => {
  /** Kiosk mode as `App` gives an administrator; `leave` says the window left it. */
  function windowMode(mode: WindowMode["mode"]) {
    return { mode, leave: vi.fn<WindowMode["leave"]>(async () => true) };
  }

  it("is offered to an administrator only while the window is locked", async () => {
    const { unmount } = renderOffice(fakeOfficeSession(), { windowMode: windowMode("locked") });
    expect(await screen.findByRole("button", { name: "Оконный режим" })).toBeTruthy();
    unmount();

    for (const [user, mode] of [
      [SESSION.user, windowMode("windowed")],
      [TECHNOLOGIST, windowMode("locked")],
      [SESSION.user, null],
    ] as const) {
      const view = renderOffice(fakeOfficeSession({ user }), { windowMode: mode });
      expect(await screen.findByRole("button", { name: "Выйти в цех" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
      view.unmount();
    }
  });

  it("asks first, reads the user from the host, then leaves kiosk mode", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockResolvedValue(SESSION.user);
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    expect(
      screen.getByText(
        "Окно станции получит рамку и кнопку на панели задач, его можно будет свернуть и закрыть. Киоск-режим вернётся, когда вы выйдете из офиса.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(mode.leave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    await waitFor(() => expect(mode.leave).toHaveBeenCalledTimes(1));
    expect(session.api.officeMe).toHaveBeenCalledWith(SESSION.token);
    await waitFor(() => expect(screen.queryByText("Перейти в оконный режим?")).toBeNull());
  });

  it("keeps the window locked when the host says the user is no longer an administrator", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockResolvedValue({ ...SESSION.user, role: "technologist" });
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    expect(await screen.findByText("Оконный режим доступен только администратору.")).toBeTruthy();
    expect(mode.leave).not.toHaveBeenCalled();
    expect(session.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("keeps the window locked when the host cannot be asked", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(mode.leave).not.toHaveBeenCalled();
  });
});

describe("ChangePasswordDialog", () => {
```

Правка `apps/standalone/test/app.test.tsx` (2 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
describe("kiosk mode", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
/** «Оконный режим» from the office header, confirmed in its dialog. */
async function leaveKioskMode(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
  expect(await screen.findByText("Перейти в оконный режим?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
}

describe("kiosk mode", () => {
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("useHostLink", () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets the administrator out in the office and locks the window again on leaving", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown"]));
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });

  it("locks the window again when the office session ends while it is windowed", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    host.officeChangePassword.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "office session ended",
        details: { credential: "session" },
      }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown"]));

    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    fireEvent.change(await screen.findByLabelText("Текущий пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.change(screen.getByLabelText("Повторите новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Сессия офиса закончилась. Войдите снова.")).toBeTruthy();
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });

  it("offers no way out to a technologist", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeLogin.mockResolvedValue({
      ...SESSION,
      user: { ...SESSION.user, login: "tech", name: "Павел Орлов", role: "technologist" },
    });
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Павел Орлов.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
  });

  it("keeps the dialog open and says so when the window does not leave kiosk mode", async () => {
    const kiosk = recordingLockdown();
    kiosk.failing.add("exit_lockdown");
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    expect(
      await screen.findByText("Окно не вышло из киоск-режима. Попробуйте ещё раз."),
    ).toBeTruthy();
    expect(screen.getByText("Перейти в оконный режим?")).toBeTruthy();
    // The failed exit may have changed some properties: «Выйти в цех» locks again.
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });
});

describe("useHostLink", () => {
```

- [ ] **Step 2: Убедиться, что они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx test/app.test.tsx -t "Оконный|kiosk"`
Expected: FAIL — 7 тестов: `TestingLibraryElementError: Unable to find role="button" and name "Оконный режим"`; 4 проходят (3 теста задачи 3 и «offers no way out to a technologist»), 107 пропущены.

- [ ] **Step 3: Контекст и кнопка**

Создать `apps/standalone/src/office/window-mode.tsx`:

<!-- prettier-ignore -->
```tsx
import { createContext, useContext, type ReactNode } from "react";

/**
 * Kiosk mode as the office sees it (plan 1f2): given only to an open
 * session of an administrator in a build that locks its window; `null`
 * otherwise, and nothing is shown.
 */
export interface WindowMode {
  /** The window as the shell last confirmed it. */
  mode: "locked" | "windowed";
  /** Turns kiosk mode off; `true` once the window is an ordinary one again. */
  leave: () => Promise<boolean>;
}

const WindowModeContext = createContext<WindowMode | null>(null);

export function WindowModeProvider({
  value,
  children,
}: {
  value: WindowMode | null;
  children: ReactNode;
}) {
  return <WindowModeContext.Provider value={value}>{children}</WindowModeContext.Provider>;
}

export function useWindowMode(): WindowMode | null {
  return useContext(WindowModeContext);
}
```

Создать `apps/standalone/src/office/WindowModeButton.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { alertFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { useOfficeSession } from "./office-session.js";
import { WriteFailureAlert } from "./page-state.js";
import { useWindowMode } from "./window-mode.js";

/**
 * «Оконный режим» in the office header (plan 1f2): the administrator's way
 * out of kiosk mode, so the station's PC can be serviced. Shown only to an
 * administrator while the window is locked; the technologist and the floor
 * never see it. Before the window changes, the user is read again from the
 * host (`GET /v1/office/me`): a role taken away meanwhile does not open the
 * window. Leaving the office brings kiosk mode back (`App`).
 */
export function WindowModeButton() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const windowMode = useWindowMode();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const whoAmI = useOfficeMutation((api, token, _variables: void) => api.officeMe(token));

  if (windowMode === null || session.user.role !== "admin" || windowMode.mode !== "locked") {
    return null;
  }

  const submit = async () => {
    setFailure(null);
    let role: string;
    try {
      role = (await whoAmI.mutateAsync()).role;
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    if (role !== "admin") {
      setFailure({ kind: "alert", message: "office.windowMode.notAdmin" });
      // The menu and the header follow the role the host has now.
      void session.refreshUser().catch(() => undefined);
      return;
    }
    if (await windowMode.leave()) {
      setOpen(false);
      return;
    }
    setFailure({ kind: "alert", message: "office.windowMode.failed" });
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        {t("office.windowMode.open")}
      </Button>
      {open && (
        <FormDialog
          title={t("office.windowMode.title")}
          submitLabel={t("office.windowMode.submit")}
          onSubmit={submit}
          onClose={() => setOpen(false)}
          alert={<WriteFailureAlert failure={failure} />}
        >
          <p>{t("office.windowMode.body")}</p>
        </FormDialog>
      )}
    </>
  );
}
```

- [ ] **Step 4: Тексты, офис и `App`**

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "lightTheme": "Включить светлую тему"
    },
```

заменить на:

<!-- prettier-ignore -->
```json
      "lightTheme": "Включить светлую тему"
    },
    "windowMode": {
      "open": "Оконный режим",
      "title": "Перейти в оконный режим?",
      "body": "Окно станции получит рамку и кнопку на панели задач, его можно будет свернуть и закрыть. Киоск-режим вернётся, когда вы выйдете из офиса.",
      "submit": "Перейти в оконный режим",
      "notAdmin": "Оконный режим доступен только администратору.",
      "failed": "Окно не вышло из киоск-режима. Попробуйте ещё раз."
    },
```

Правка `apps/standalone/src/office/Office.tsx` (4 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { ThisDeviceProvider } from "./this-device.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { ThisDeviceProvider } from "./this-device.js";
import { WindowModeProvider, type WindowMode } from "./window-mode.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  labels?: LabelRendering;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
  labels?: LabelRendering;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
  windowMode?: WindowMode | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  labels = BROWSER_LABEL_RENDERING,
}: OfficeProps) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  labels = BROWSER_LABEL_RENDERING,
  windowMode = null,
}: OfficeProps) {
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
            <LabelRenderingProvider value={labels}>
              <RouterProvider router={router} />
            </LabelRenderingProvider>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            <LabelRenderingProvider value={labels}>
              <WindowModeProvider value={windowMode}>
                <RouterProvider router={router} />
              </WindowModeProvider>
            </LabelRenderingProvider>
```

Правка `apps/standalone/src/office/OfficeShell.tsx` (2 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useOfficeSession } from "./office-session.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useOfficeSession } from "./office-session.js";
import { WindowModeButton } from "./WindowModeButton.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
            />
            <Button
              variant="secondary"
              onClick={() => {
                setPasswordChangedAt(null);
```

заменить на:

<!-- prettier-ignore -->
```tsx
            />
            <WindowModeButton />
            <Button
              variant="secondary"
              onClick={() => {
                setPasswordChangedAt(null);
```

Правка `apps/standalone/src/app/App.tsx` (5 фрагментов):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  useRef,
  useState,
} from "react";
```

заменить на:

<!-- prettier-ignore -->
```tsx
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import type { OfficeSessionValue } from "../office/office-session.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { OfficeSessionValue } from "../office/office-session.js";
import type { WindowMode } from "../office/window-mode.js";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    [lockdown],
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
    [lockdown],
  );
  const kioskSnapshot = useSyncExternalStore(kiosk.subscribe, kiosk.getSnapshot);
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  }, [kiosk, officeOpen]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [kiosk, officeOpen]);
  const leaveKiosk = useCallback(async (): Promise<boolean> => {
    await kiosk.exit();
    const { mode, error } = kiosk.getSnapshot();
    if (error !== null) kiosk.clearError();
    return mode === "windowed";
  }, [kiosk]);
  const officeAdmin = session?.user.role === "admin";
  const windowMode = useMemo<WindowMode | null>(
    () => (kiosk.enabled && officeAdmin ? { mode: kioskSnapshot.mode, leave: leaveKiosk } : null),
    [kiosk.enabled, officeAdmin, kioskSnapshot.mode, leaveKiosk],
  );
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
        deviceId={pairedStatus?.deviceId ?? null}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        deviceId={pairedStatus?.deviceId ?? null}
        windowMode={windowMode}
      />
```

- [ ] **Step 5: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx test/app.test.tsx -t "Оконный|kiosk"`
Expected: PASS — 11 тестов (107 пропущены).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 64 файла, 1680 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/office.test.tsx test/app.test.tsx`
Expected: PASS, в выводе нет `stderr |`. Затем оба файла под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 6: Мутации**

М1 — роль с хоста не проверяется. В `apps/standalone/src/office/WindowModeButton.tsx` строку

<!-- prettier-ignore -->
```tsx
    if (role !== "admin") {
```

заменить на

<!-- prettier-ignore -->
```tsx
    if (role === "none") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx -t "Оконный"`
Expected: FAIL `keeps the window locked when the host says the user is no longer an administrator` — `Unable to find an element with the text: Оконный режим доступен только администратору.`. Восстановить, `cmp` молчит, хеш прежний.

М2 — кнопка видна любой роли. В том же файле строку

<!-- prettier-ignore -->
```tsx
  if (windowMode === null || session.user.role !== "admin" || windowMode.mode !== "locked") {
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (windowMode === null || windowMode.mode !== "locked") {
```

Run: та же команда.
Expected: FAIL `is offered to an administrator only while the window is locked` — `AssertionError: expected <button type="button" …(2)></button> to be null`. Восстановить, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Commit**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/office.test.tsx apps/standalone/test/app.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

```bash
git add apps/standalone/src/office/window-mode.tsx apps/standalone/src/office/WindowModeButton.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/office.test.tsx apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): the office administrator's way out of kiosk mode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Поиск оператора по имени на экране входа

**Files:**

- Create: `apps/standalone/src/floor/operator-search.ts`
- Modify: `apps/standalone/src/floor/scan-source.ts` (`setManualTextEntryActive`), `apps/standalone/src/floor/sign-in.ts` (`readOperatorRoster`), `apps/standalone/src/floor/OperatorSignIn.tsx` (шаг `search`, 64 px у «Офис» и «Повторить»), `apps/standalone/src/i18n/ru.json` (ключи поиска), `apps/standalone/src/app/shell.css` (`.floor-sign-in`, `.floor-sign-in__results`)
- Test: `apps/standalone/test/operator-search.test.ts` (новый), `apps/standalone/test/operator-sign-in.test.tsx`, `apps/standalone/test/app.test.tsx` (поддельный источник сканов)

**Interfaces:**

- Consumes: `copiesReady`, `SignInContext`, `signInWithPin` (1f1, без изменений).
- Produces: `export interface RosterEntry { id: string; login: string; name: string }`; `NAME_SEARCH_LIMIT = 5`, `NAME_SEARCH_MIN_LETTERS = 2`, `NAME_QUERY_MAX_LENGTH = 100`; `normalizeOperatorName(value: string): string`, `nameQueryLetters(query: string): number`, `searchOperatorsByName(roster: readonly RosterEntry[], query: string): RosterEntry[]`; в `sign-in.ts` — `readOperatorRoster(context: SignInContext): Promise<RosterEntry[] | null>` (`null` — копии не готовы); `ScanSource.setManualTextEntryActive(active: boolean): void` (обязательный член — все поддельные источники в тестах его получают).

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/operator-search.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  nameQueryLetters,
  normalizeOperatorName,
  searchOperatorsByName,
  type RosterEntry,
} from "../src/floor/operator-search.js";
import { readOperatorRoster } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
/** The PIN 4821 under a fixed salt (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

function entry(id: string, name: string, login: string): RosterEntry {
  return { id, name, login };
}

function operatorItem(id: string, login: string, name: string): ChangeItem {
  return {
    entity: "operators",
    id,
    rev: 5,
    deleted: false,
    data: { login, name, role: null, pinPhc: PIN_PHC },
  };
}

describe("the operator name search", () => {
  it("folds case and runs of spaces, and waits for two letters", () => {
    const roster = [entry("op-1", "Анна   Смирнова", "101")];
    expect(normalizeOperatorName("  АННА   см ")).toBe("анна см");
    expect(nameQueryLetters(" а1 2")).toBe(1);
    expect(searchOperatorsByName(roster, "а")).toEqual([]);
    expect(searchOperatorsByName(roster, "а 1")).toEqual([]);
    expect(searchOperatorsByName(roster, "  АН ")).toEqual([
      { id: "op-1", name: "Анна   Смирнова", login: "101" },
    ]);
  });

  it("offers at most five names, by name and then id", () => {
    const roster = [
      entry("op-6", "Alex Z", "106"),
      entry("op-3", "Alex C", "103"),
      entry("op-2b", "Alex B", "112"),
      entry("op-2a", "Alex B", "102"),
      entry("op-1", "Alex A", "101"),
      entry("op-4", "Alex D", "104"),
    ];
    expect(searchOperatorsByName(roster, "al").map((found) => found.id)).toEqual([
      "op-1",
      "op-2a",
      "op-2b",
      "op-3",
      "op-4",
    ]);
  });

  it("matches the words in order and skips a number the keypad could not type", () => {
    const roster = [
      entry("op-1", "Смирнов Алексей", "123"),
      entry("op-2", "Смирнова Алёна", "000123"),
      entry("op-3", "Алексей Смирнов", "124"),
      entry("op-4", "Смирнов Алексей", "12"),
    ];
    expect(searchOperatorsByName(roster, "см ал")).toEqual([
      { id: "op-1", name: "Смирнов Алексей", login: "123" },
      { id: "op-2", name: "Смирнова Алёна", login: "000123" },
    ]);
    // The middle of a word counts: «ирн» is in «Смирнов».
    expect(searchOperatorsByName(roster, "ирн").map((found) => found.id)).toEqual([
      "op-3",
      "op-1",
      "op-2",
    ]);
  });

  it("returns identity only, whatever else the entries carry", () => {
    const withHash = { ...entry("op-1", "Анна Кузнецова", "0042"), pinPhc: PIN_PHC };
    const roster: RosterEntry[] = [withHash];
    const [found] = searchOperatorsByName(roster, "ан");
    expect(found).toEqual({ id: "op-1", login: "0042", name: "Анна Кузнецова" });
    expect(Object.keys(found ?? {}).sort()).toEqual(["id", "login", "name"]);
  });
});

describe("the roster the name search reads", () => {
  async function synced(items: ChangeItem[]) {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
      local: executor,
      ...PAIRING,
    });
    return { db, context: { local: executor, pairing: PAIRING, now: () => 0 } };
  }

  it("lists this pairing's operators without their hashes, and none waiting in quarantine", async () => {
    const { db, context } = await synced([
      operatorItem(ANNA, "0042", "Анна Кузнецова"),
      operatorItem(BORIS, "0077", "Борис Петров"),
    ]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(BORIS);
    const roster = await readOperatorRoster(context);
    expect(roster).toEqual([{ id: ANNA, login: "0042", name: "Анна Кузнецова" }]);
    expect(JSON.stringify(roster)).not.toContain("pbkdf2");
  });

  it("reads nothing from copies that are not this pairing's", async () => {
    const { db, context } = await synced([operatorItem(ANNA, "0042", "Анна Кузнецова")]);
    expect(
      await readOperatorRoster({ ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } }),
    ).toBeNull();
    db.prepare("DELETE FROM sync_state").run();
    expect(await readOperatorRoster(context)).toBeNull();
  });
});
```

Правка `apps/standalone/test/operator-sign-in.test.tsx` (3 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
    const source: ScanSource = { start: vi.fn(() => stop), clearPendingInput: vi.fn() };
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const source: ScanSource = {
      start: vi.fn(() => stop),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    const first: ScanSource = { start: vi.fn(() => stopFirst), clearPendingInput: vi.fn() };
    const second: ScanSource = { start: vi.fn(() => stopSecond), clearPendingInput: vi.fn() };
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const first: ScanSource = {
      start: vi.fn(() => stopFirst),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    const second: ScanSource = {
      start: vi.fn(() => stopSecond),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    expect(reads).toBeGreaterThan(before);
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
    expect(reads).toBeGreaterThan(before);
  });
});

describe("text typed into a field, not scanned", () => {
  it("hands nothing over while a text field takes the keys, and drops what came before", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    fireEvent.keyDown(window, { key: "x" });
    source.setManualTextEntryActive(true);
    scan("Анна");
    source.setManualTextEntryActive(false);
    scan("MRK-1");
    stop();
    expect(scans).toEqual(["MRK-1"]);
  });

  it("leaves the field's own Enter alone", () => {
    const source = createKeyboardWedgeSource(window);
    const stop = source.start(() => undefined);
    source.setManualTextEntryActive(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(enter);
    stop();
    expect(enter.defaultPrevented).toBe(false);
  });
});

describe("finding oneself by name", () => {
  const BORIS_ITEM = operatorItem(BORIS, 6, "0077", "Борис Петров");

  async function openSearch() {
    fireEvent.click(await screen.findByRole("button", { name: "Найти себя по имени" }));
    return screen.getByLabelText("Имя оператора") as HTMLInputElement;
  }

  function typeName(field: HTMLInputElement, value: string) {
    fireEvent.change(field, { target: { value } });
  }

  it("finds an operator by name and signs them in with their PIN", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    const field = await openSearch();
    expect(screen.getByText("Наберите первые буквы имени или фамилии.")).toBeTruthy();
    typeName(field, "кузн");
    fireEvent.click(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" }));
    expect(screen.getByText("Анна Кузнецова, табельный номер 0042. Наберите PIN.")).toBeTruthy();
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("waits for two letters and says when nobody matches", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    const field = await openSearch();
    expect(await screen.findByText("Наберите хотя бы две буквы.")).toBeTruthy();
    typeName(field, "а");
    expect(screen.getByText("Наберите хотя бы две буквы.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /— 0042$/ })).toBeNull();
    typeName(field, "яя");
    expect(
      screen.getByText("Никого не нашли. Проверьте имя или войдите по табельному номеру."),
    ).toBeTruthy();
  });

  it("goes back from the PIN to the search as it was, and from the search to the badge", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    typeName(await openSearch(), "бор");
    fireEvent.click(await screen.findByRole("button", { name: "Борис Петров — 0077" }));
    press("1");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect((screen.getByLabelText("Имя оператора") as HTMLInputElement).value).toBe("бор");
    expect(await screen.findByRole("button", { name: "Борис Петров — 0077" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText(BADGE_PROMPT)).toBeTruthy();
    // The keypad's way afterwards names nobody.
    await enterLogin("0077");
    expect(screen.getByText("Табельный номер 0077. Наберите PIN.")).toBeTruthy();
  });

  it("does not take a name typed into the field for a badge scan", async () => {
    const { onSignedIn, onSync } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    const field = await openSearch();
    act(() => field.focus());
    for (const key of "MRK-000743") fireEvent.keyDown(field, { key });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText(/^Бейдж не найден\./)).toBeNull();
    expect(onSync).not.toHaveBeenCalled();
    // Out of the field, the scanner signs in again.
    act(() => field.blur());
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("gives the scanner back when the screen goes while the field has the keys", async () => {
    const source = createKeyboardWedgeSource(window);
    const { unmount } = renderSignIn({ local: await synced([SITE, OPERATOR]), source });
    const field = await openSearch();
    act(() => field.focus());
    unmount();
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    scan("MRK-000742");
    stop();
    expect(scans).toEqual(["MRK-000742"]);
  });

  it("offers no name while the copies cannot be read", async () => {
    const real = await synced([SITE, OPERATOR]);
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    failing = true;
    typeName(await openSearch(), "ан");
    expect(
      await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Анна Кузнецова — 0042" })).toBeNull();
  });
});

describe("the size of the screen's controls", () => {
  /** Every button now on screen is a floor one (64 px, `size="floor"`). */
  function allFloorSized() {
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
  }

  it("keeps every button at the floor's 64 px on every step", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await screen.findByText(BADGE_PROMPT);
    allFloorSized();
    fireEvent.click(screen.getByRole("button", { name: "Найти себя по имени" }));
    fireEvent.change(screen.getByLabelText("Имя оператора"), { target: { value: "ан" } });
    await screen.findByRole("button", { name: "Анна Кузнецова — 0042" });
    allFloorSized();
    fireEvent.click(screen.getByRole("button", { name: "Анна Кузнецова — 0042" }));
    allFloorSized();
  });

  it("keeps «Повторить» at the floor's size too", async () => {
    const local: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    renderSignIn({ local });
    await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере.");
    allFloorSized();
  });
});
```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
      clearPendingInput: () => undefined,
    };
```

заменить на:

<!-- prettier-ignore -->
```tsx
      clearPendingInput: () => undefined,
      setManualTextEntryActive: () => undefined,
    };
```

- [ ] **Step 2: Убедиться, что они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-search.test.ts test/operator-sign-in.test.tsx`
Expected: FAIL — `test/operator-search.test.ts`: `Failed to resolve import "../src/floor/operator-search.js"`; в `test/operator-sign-in.test.tsx` 10 падают, 53 проходят: шесть — `Unable to find role="button" and name "Найти себя по имени"`, два теста источника — `TypeError: source.setManualTextEntryActive is not a function`, два теста размеров — `expected 'mk-btn mk-btn--secondary mk-btn--md' to contain 'mk-btn--floor'` («Офис») и `… mk-btn--compact …` («Повторить»).

- [ ] **Step 3: Поиск, список копий и источник сканов**

Создать `apps/standalone/src/floor/operator-search.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The name search on the sign-in screen (plan 1f2), ported from the cloud
 * station's `searchOperatorsByName` (`apps/station/src/lib/operator-search.ts`):
 * at least two letters, at most five names, identity only. Choosing a name
 * only fills in the personnel number; the PIN is still checked by
 * `signInWithPin`.
 */

/** An operator the search may offer: never a hash. */
export interface RosterEntry {
  id: string;
  /** The personnel number, leading zeros included. */
  login: string;
  name: string;
}

/** The most names the search shows at once. */
export const NAME_SEARCH_LIMIT = 5;

/** Letters (not digits or spaces) the search waits for before it offers names. */
export const NAME_SEARCH_MIN_LETTERS = 2;

/** The longest query: a person's name is at most 100 characters (`personNameRule`). */
export const NAME_QUERY_MAX_LENGTH = 100;

/** A personnel number the keypad could have typed (`operatorLoginRule`). */
const LOGIN = /^[0-9]{3,12}$/;

/** Trims, folds runs of spaces into one and lower-cases; names only, never a number. */
export function normalizeOperatorName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** How many letters a query holds, in any alphabet. */
export function nameQueryLetters(query: string): number {
  return Array.from(normalizeOperatorName(query)).filter((character) => /\p{L}/u.test(character))
    .length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The operators whose name holds every word of the query, in order (each
 * word may be the start or the middle of a word of the name), sorted by
 * name and then id, at most `NAME_SEARCH_LIMIT`; nothing until the query
 * has `NAME_SEARCH_MIN_LETTERS` letters. An operator whose personnel number
 * the keypad could not type is never offered.
 */
export function searchOperatorsByName(
  roster: readonly RosterEntry[],
  query: string,
): RosterEntry[] {
  if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) return [];
  const words = normalizeOperatorName(query).split(" ");
  return roster
    .filter((entry) => {
      if (!LOGIN.test(entry.login)) return false;
      const name = normalizeOperatorName(entry.name);
      let from = 0;
      return words.every((word) => {
        const at = name.indexOf(word, from);
        if (at < 0) return false;
        from = at + word.length;
        return true;
      });
    })
    .sort(
      (left, right) =>
        compareText(normalizeOperatorName(left.name), normalizeOperatorName(right.name)) ||
        compareText(left.id, right.id),
    )
    .slice(0, NAME_SEARCH_LIMIT)
    .map(({ id, login, name }) => ({ id, login, name }));
}
```

Правка `apps/standalone/src/floor/sign-in.ts` (3 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```ts
} from "./lockout.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
} from "./lockout.js";
import type { RosterEntry } from "./operator-search.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
const operatorRow = z.object({
```

заменить на:

<!-- prettier-ignore -->
```ts
const ROSTER = `SELECT o.id, o.login, o.name FROM ref_operators AS o WHERE ${NOT_QUARANTINED_OPERATOR}`;

const rosterRow = z.object({ id: z.string(), login: z.string(), name: z.string() });

const operatorRow = z.object({
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
/**
 * A personnel number and a PIN against the copies.
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * The operators the name search may offer (`src/floor/operator-search.ts`):
 * this pairing's copies once a sync has begun to fill them (`copiesReady`),
 * none waiting in quarantine, identity only (never a hash); `null` while the
 * copies are not ready.
 */
export async function readOperatorRoster(context: SignInContext): Promise<RosterEntry[] | null> {
  if (!(await copiesReady(context.local, context.pairing))) return null;
  return context.local.query(ROSTER, [], rosterRow);
}

/**
 * A personnel number and a PIN against the copies.
```

Правка `apps/standalone/src/floor/scan-source.ts` (4 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  /** Drops the keys typed since the last Enter. */
  clearPendingInput(): void;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** Drops the keys typed since the last Enter. */
  clearPendingInput(): void;
  /**
   * `true` while a text field takes typing (the name search): the keys are
   * the field's, not a scan, and Enter hands nothing over. Either way the
   * keys typed so far are dropped.
   */
  setManualTextEntryActive(active: boolean): void;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  const buffers = new Set<() => void>();
  return {
```

заменить на:

<!-- prettier-ignore -->
```ts
  const buffers = new Set<() => void>();
  let manualTextEntry = false;
  return {
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      const onKeyDown = (event: Event) => {
        const { key, ctrlKey, altKey, metaKey } = event as KeyboardEvent;
```

заменить на:

<!-- prettier-ignore -->
```ts
      const onKeyDown = (event: Event) => {
        // Typing into a text field: no scan, and its Enter stays the field's.
        if (manualTextEntry) return;
        const { key, ctrlKey, altKey, metaKey } = event as KeyboardEvent;
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
    clearPendingInput() {
      for (const clear of buffers) clear();
    },
  };
```

заменить на:

<!-- prettier-ignore -->
```ts
    clearPendingInput() {
      for (const clear of buffers) clear();
    },
    setManualTextEntryActive(active) {
      for (const clear of buffers) clear();
      manualTextEntry = active;
    },
  };
```

- [ ] **Step 4: Шаг поиска на экране входа, тексты и стили**

Правка `apps/standalone/src/floor/OperatorSignIn.tsx` (14 фрагментов):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, PinPad, Spinner } from "@markiro/ui";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Input, PinPad, Spinner } from "@markiro/ui";
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "./scan-source.js";
import {
  readFloorReadiness,
```

заменить на:

<!-- prettier-ignore -->
```tsx
import {
  NAME_QUERY_MAX_LENGTH,
  NAME_SEARCH_MIN_LETTERS,
  nameQueryLetters,
  searchOperatorsByName,
  type RosterEntry,
} from "./operator-search.js";
import type { ScanSource } from "./scan-source.js";
import {
  readFloorReadiness,
  readOperatorRoster,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
type Stage = "badge" | "login" | "pin";
```

заменить на:

<!-- prettier-ignore -->
```tsx
type Stage = "badge" | "login" | "search" | "pin";
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
 * The floor with nobody signed in (stage 1 spec §5.6, plan 1f): a badge scan
 * at any moment, or a personnel number and a PIN on the keypad, checked
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * The floor with nobody signed in (stage 1 spec §5.6, plans 1f and 1f2): a
 * badge scan at any moment, or a personnel number (typed on the keypad or
 * found by name) and a PIN on the keypad, checked
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  // The name search: what is typed, the copies it searches (`null` while
  // they are read), and where «Назад» on the PIN goes with whose name.
  const [query, setQuery] = useState("");
  const [roster, setRoster] = useState<RosterEntry[] | "not_ready" | "failed" | null>(null);
  const [pinFrom, setPinFrom] = useState<"login" | "search">("login");
  const [chosenName, setChosenName] = useState<string | null>(null);
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, now, sync.synced, readAttempt]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, now, sync.synced, readAttempt]);

  // The copies the name search offers, read when it opens and after every sync.
  const searching = stage === "search";
  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    readOperatorRoster({ local, pairing: { hostId, deviceId }, now }).then(
      (next) => {
        if (!cancelled) setRoster(next ?? "not_ready");
      },
      () => {
        if (!cancelled) setRoster("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [searching, local, hostId, deviceId, now, sync.synced]);

  // A field that held the keys when the screen went (no blur comes then)
  // must not keep the scanner deaf on the next screen.
  useEffect(() => () => source.setManualTextEntryActive(false), [source]);
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
  const toStage = (next: Stage) => {
    source.clearPendingInput();
    setMessage(null);
    setPin("");
    if (next === "login") setLogin("");
    setStage(next);
  };
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const toStage = (next: Stage) => {
    // Also drops the keys typed so far, as `clearPendingInput` does.
    source.setManualTextEntryActive(false);
    setMessage(null);
    setPin("");
    if (next === "login") setLogin("");
    if (next === "search") setRoster(null);
    setStage(next);
  };

  /** A name from the search: the PIN for that operator's number comes next. */
  const choose = (entry: RosterEntry) => {
    setLogin(entry.login);
    setChosenName(entry.name);
    setPinFrom("search");
    toStage("pin");
  };
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
              variant="secondary"
              size="compact"
              onClick={() => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
              variant="secondary"
              size="floor"
              onClick={() => {
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
              {t("floor.signIn.useLogin")}
            </Button>
          </div>
        </div>
      );
    }
```

заменить на:

<!-- prettier-ignore -->
```tsx
              {t("floor.signIn.useLogin")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setQuery("");
                toStage("search");
              }}
            >
              {t("floor.signIn.useName")}
            </Button>
          </div>
        </div>
      );
    }
    if (stage === "search") {
      const matches = Array.isArray(roster) ? searchOperatorsByName(roster, query) : [];
      let results: ReactNode;
      if (roster === null) results = <p>{t("floor.signIn.loading")}</p>;
      else if (roster === "failed") results = <p>{t("floor.signIn.readFailed")}</p>;
      else if (roster === "not_ready") results = <p>{t("floor.signIn.errors.notReady")}</p>;
      else if (nameQueryLetters(query) < NAME_SEARCH_MIN_LETTERS) {
        results = <p>{t("floor.signIn.nameHint")}</p>;
      } else if (matches.length === 0) results = <p>{t("floor.signIn.nameEmpty")}</p>;
      else {
        results = matches.map((entry) => (
          <Button
            key={entry.id}
            size="floor"
            variant="secondary"
            fullWidth
            disabled={busy}
            onClick={() => choose(entry)}
          >
            {t("floor.signIn.nameResult", { name: entry.name, login: entry.login })}
          </Button>
        ));
      }
      return (
        <div className="floor-sign-in">
          <p className="floor-sign-in__prompt">{t("floor.signIn.namePrompt")}</p>
          <Input
            size="floor"
            label={t("floor.signIn.nameLabel")}
            value={query}
            maxLength={NAME_QUERY_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            onFocus={() => source.setManualTextEntryActive(true)}
            onBlur={() => source.setManualTextEntryActive(false)}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="floor-sign-in__results" aria-live="polite">
            {results}
          </div>
          <div className="standalone-form__actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => toStage("badge")}
            >
              {t("floor.signIn.back")}
            </Button>
          </div>
        </div>
      );
    }
```

Фрагмент 11:

<!-- prettier-ignore -->
```tsx
          {t(stage === "login" ? "floor.signIn.loginPrompt" : "floor.signIn.pinPrompt", { login })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          {stage === "login"
            ? t("floor.signIn.loginPrompt")
            : chosenName !== null
              ? t("floor.signIn.pinPromptNamed", { name: chosenName, login })
              : t("floor.signIn.pinPrompt", { login })}
```

Фрагмент 12:

<!-- prettier-ignore -->
```tsx
            onClick={() => toStage(stage === "pin" ? "login" : "badge")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            onClick={() => toStage(stage === "pin" ? pinFrom : "badge")}
```

Фрагмент 13:

<!-- prettier-ignore -->
```tsx
              disabled={busy || !LOGIN.test(login)}
              onClick={() => toStage("pin")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              disabled={busy || !LOGIN.test(login)}
              onClick={() => {
                setPinFrom("login");
                setChosenName(null);
                toStage("pin");
              }}
```

Фрагмент 14:

<!-- prettier-ignore -->
```tsx
          <Button variant="secondary" onClick={onOffice}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
          <Button variant="secondary" size="floor" onClick={onOffice}>
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
      "useLogin": "Войти по табельному номеру",
      "loginPrompt": "Наберите табельный номер.",
      "pinPrompt": "Табельный номер {{login}}. Наберите PIN.",
```

заменить на:

<!-- prettier-ignore -->
```json
      "useLogin": "Войти по табельному номеру",
      "useName": "Найти себя по имени",
      "loginPrompt": "Наберите табельный номер.",
      "pinPrompt": "Табельный номер {{login}}. Наберите PIN.",
      "pinPromptNamed": "{{name}}, табельный номер {{login}}. Наберите PIN.",
      "namePrompt": "Наберите первые буквы имени или фамилии.",
      "nameLabel": "Имя оператора",
      "nameHint": "Наберите хотя бы две буквы.",
      "nameEmpty": "Никого не нашли. Проверьте имя или войдите по табельному номеру.",
      "nameResult": "{{name}} — {{login}}",
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент:

<!-- prettier-ignore -->
```css
  align-items: flex-start;
  gap: var(--space-4);
}
```

заменить на:

<!-- prettier-ignore -->
```css
  align-items: flex-start;
  gap: 16px;
}

.floor-sign-in__results {
  display: grid;
  gap: 8px;
  width: 100%;
}
```

- [ ] **Step 5: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-search.test.ts test/operator-sign-in.test.tsx test/app.test.tsx test/floor-sign-in.test.ts`
Expected: PASS — 4 файла, 215 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 65 файлов, 1696 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/operator-search.test.ts test/operator-sign-in.test.tsx test/app.test.tsx`
Expected: PASS, в выводе нет `stderr |`. Затем `test/operator-sign-in.test.tsx` и `test/app.test.tsx` под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 6: Мутации**

М1 — набор в поле принимается за скан. В `apps/standalone/src/floor/scan-source.ts` удалить строку

<!-- prettier-ignore -->
```ts
        if (manualTextEntry) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "typed into a field|does not take a name"`
Expected: FAIL — 3 теста: `hands nothing over while a text field takes the keys, and drops what came before`, `leaves the field's own Enter alone`, `does not take a name typed into the field for a badge scan`. Восстановить, `cmp` молчит, хеш прежний.

М2 — уход с экрана оставляет сканер глухим. В `apps/standalone/src/floor/OperatorSignIn.tsx` удалить строку

<!-- prettier-ignore -->
```tsx
  useEffect(() => () => source.setManualTextEntryActive(false), [source]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "gives the scanner back"`
Expected: FAIL — `AssertionError: expected [] to deeply equal [ 'MRK-000742' ]`. Восстановить, `cmp` молчит, хеш прежний.

М3 — поиск видит запись в карантине. В `apps/standalone/src/floor/sign-in.ts` строку

<!-- prettier-ignore -->
```ts
const ROSTER = `SELECT o.id, o.login, o.name FROM ref_operators AS o WHERE ${NOT_QUARANTINED_OPERATOR}`;
```

заменить на

<!-- prettier-ignore -->
```ts
const ROSTER = "SELECT o.id, o.login, o.name FROM ref_operators AS o";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-search.test.ts`
Expected: FAIL `lists this pairing's operators without their hashes, and none waiting in quarantine` — `AssertionError: expected [ { …(3) }, { …(3) } ] to deeply equal [ { …(3) } ]`. Восстановить, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Commit**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-search.test.ts apps/standalone/test/operator-sign-in.test.tsx apps/standalone/test/app.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

```bash
git add apps/standalone/src/floor/operator-search.ts apps/standalone/src/floor/scan-source.ts apps/standalone/src/floor/sign-in.ts apps/standalone/src/floor/OperatorSignIn.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-search.test.ts apps/standalone/test/operator-sign-in.test.tsx apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): find an operator by name on the sign-in screen" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Строка состояния цеха

**Files:**

- Create: `apps/standalone/src/floor/floor-status.ts`, `apps/standalone/src/floor/FloorStatusBar.tsx`
- Modify: `apps/standalone/src/app/App.tsx` (рамка цеха со строкой состояния), `apps/standalone/src/floor/OperatorSignIn.tsx` и `apps/standalone/src/floor/FloorOperatorScreen.tsx` (без `link` и `HostStatusLine`), `apps/standalone/src/i18n/ru.json` (`floor.status`), `apps/standalone/src/app/shell.css` (`.floor-frame`, `.floor-status*`)
- Test: `apps/standalone/test/floor-status-bar.test.tsx` (новый; сюда переезжает тест строки связи экрана входа), `apps/standalone/test/app.test.tsx`, `apps/standalone/test/operator-sign-in.test.tsx` и `apps/standalone/test/floor-operator.test.tsx` (без пропа `link`)

**Interfaces:**

- Consumes: `copiesReady`, `Pairing`, `FloorOperator`, `HostStatusLine`, `SyncState`, `HostStatus`.
- Produces: `export interface FloorPlace { organization: string | null; line: string | null }`, `readFloorPlace(local: LocalExecutor, pairing: Pairing, lineId: string | null): Promise<FloorPlace>`; `FloorStatusBar` с пропсами `{ local; pairing; lineId; operator: FloorOperator | null; link: HostStatus | null; sync: SyncState }` — `section` с подписью «Строка состояния цеха». `OperatorSignInProps` и `FloorOperatorScreenProps` теряют `link`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-status-bar.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import type { ChangeItem, HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const ORG: ChangeItem = {
  entity: "org_profile",
  id: "1",
  rev: 2,
  deleted: false,
  data: {
    name: "ООО «Атолл»",
    inn: null,
    gln: "4600682000013",
    gs1Prefixes: ["4600682"],
    timeZone: "Europe/Moscow",
  },
};

function line(name: string, archived = false): ChangeItem {
  return { entity: "lines", id: LINE_ID, rev: 3, deleted: false, data: { name, archived } };
}

async function synced(items: ChangeItem[], rev = 10): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

function bar(props: Partial<FloorStatusBarProps> & { local: LocalExecutor }) {
  return (
    <ThemeProvider>
      <FloorStatusBar
        pairing={PAIRING}
        lineId={LINE_ID}
        operator={null}
        link={null}
        sync={SYNCED}
        {...props}
      />
    </ThemeProvider>
  );
}

describe("where the floor's status bar says the station works", () => {
  it("names the organization and the line from this pairing's copies, an archived line too", async () => {
    const local = await synced([ORG, line("Линия розлива 2", true)]);
    expect(await readFloorPlace(local, PAIRING, LINE_ID)).toEqual({
      organization: "ООО «Атолл»",
      line: "Линия розлива 2",
    });
    expect(await readFloorPlace(local, PAIRING, null)).toEqual({
      organization: "ООО «Атолл»",
      line: null,
    });
  });

  it("names nothing from copies that are not this pairing's", async () => {
    const local = await synced([ORG, line("Линия розлива 2")]);
    expect(
      await readFloorPlace(local, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, LINE_ID),
    ).toEqual({ organization: null, line: null });
  });
});

describe("the floor's status bar", () => {
  it("shows the organization, the line and that nobody is signed in, with nothing to press", async () => {
    render(bar({ local: await synced([ORG, line("Линия розлива 2")]) }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.getByText("Линия розлива 2")).toBeTruthy();
    expect(screen.getByText("Никто не вошёл")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Строка состояния цеха" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("names the operator signed in", async () => {
    render(
      bar({
        local: await synced([ORG]),
        operator: { id: "op-1", login: "0042", name: "Анна Кузнецова", role: null },
      }),
    );
    expect(await screen.findByText("Анна Кузнецова, табельный номер 0042")).toBeTruthy();
  });

  it("shows the link to the host", async () => {
    const offline: HostStatus = {
      state: "offline",
      lastContactAt: null,
      lastError: "unreachable",
      seq: 1,
    };
    render(bar({ local: await synced([ORG]), link: offline }));
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("reads the names again after every sync", async () => {
    const { executor } = openLocalDb();
    const { rerender } = render(bar({ local: executor, sync: { ...SYNCED, synced: 0 } }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    expect(screen.queryByText("Организация")).toBeNull();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [ORG] }),
      local: executor,
      ...PAIRING,
    });
    rerender(bar({ local: executor, sync: SYNCED }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
  });

  it("leaves the names out when the copies cannot be read", async () => {
    const real = await synced([ORG, line("Линия розлива 2")]);
    let reads = 0;
    const local: LocalExecutor = {
      query: () => {
        reads += 1;
        return Promise.reject(new Error("disk"));
      },
      transaction: (statements) => real.transaction(statements),
    };
    render(bar({ local }));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(screen.getByText("Никто не вошёл")).toBeTruthy();
    expect(screen.queryByText("ООО «Атолл»")).toBeNull();
    expect(screen.queryByText("Организация")).toBeNull();
  });
});
```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
  it("signs an operator in with a badge without asking the host, shows the floor's stub and signs out on request", async () => {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  it("shows the status bar above the sign-in and the stub, with the line and the operator", async () => {
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [...PEOPLE, lineItem(43, "Линия розлива 2")]),
    );
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    const bar = await screen.findByRole("region", { name: "Строка состояния цеха" });
    expect(await within(bar).findByText("Линия розлива 2")).toBeTruthy();
    expect(within(bar).getByText("Никто не вошёл")).toBeTruthy();
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    scan("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Строка состояния цеха" })).getByText(
        "Анна Кузнецова, табельный номер 0042",
      ),
    ).toBeTruthy();
  });

  it("signs an operator in with a badge without asking the host, shows the floor's stub and signs out on request", async () => {
```

- [ ] **Step 2: Убедиться, что они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx test/app.test.tsx -t "status bar"`
Expected: FAIL — `test/floor-status-bar.test.tsx`: `Failed to resolve import "../src/floor/floor-status.js"`; `shows the status bar above the sign-in and the stub, with the line and the operator` — `Unable to find role="region" and name "Строка состояния цеха"`.

- [ ] **Step 3: Чтение копий и строка состояния**

Создать `apps/standalone/src/floor/floor-status.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";
import { copiesReady, type Pairing } from "../local/reference-sync.js";

/** Where the station works, as the floor's status bar names it; `null` for what the copies do not say. */
export interface FloorPlace {
  organization: string | null;
  line: string | null;
}

const NOWHERE: FloorPlace = { organization: null, line: null };

const ORG_NAME = "SELECT name FROM ref_org";
const LINE_NAME = "SELECT name FROM ref_lines WHERE id = ?";
const nameRow = z.object({ name: z.string() });

/**
 * The organization and the station's line by name, from this pairing's
 * copies once a sync has begun to fill them (`copiesReady`); nothing from a
 * previous pairing's. The line is named even when the office has archived
 * it since: the station still works on it until the office moves it.
 */
export async function readFloorPlace(
  local: LocalExecutor,
  pairing: Pairing,
  lineId: string | null,
): Promise<FloorPlace> {
  if (!(await copiesReady(local, pairing))) return NOWHERE;
  const orgs = await local.query(ORG_NAME, [], nameRow);
  const [org] = orgs;
  const lines = lineId === null ? [] : await local.query(LINE_NAME, [lineId], nameRow);
  const [line] = lines;
  return {
    organization: orgs.length === 1 && org !== undefined ? org.name : null,
    line: line?.name ?? null,
  };
}
```

Создать `apps/standalone/src/floor/FloorStatusBar.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import type { FloorOperator } from "./sign-in.js";

export interface FloorStatusBarProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The station's line (`DeviceStatus.lineId`). */
  lineId: string | null;
  /** The operator signed in, or `null` on the sign-in screen. */
  operator: FloorOperator | null;
  link: HostStatus | null;
  sync: SyncState;
}

/**
 * The floor's status bar (stage 1 spec §5.6, plan 1f2), after the cloud
 * station's `StatusBar` (`apps/station/src/ui/StatusBar.tsx`): the
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
  local,
  pairing,
  lineId,
  operator,
  link,
  sync,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const [place, setPlace] = useState<FloorPlace>({ organization: null, line: null });
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    let cancelled = false;
    readFloorPlace(local, { hostId, deviceId }, lineId).then(
      (next) => {
        if (!cancelled) setPlace(next);
      },
      () => {
        if (!cancelled) setPlace({ organization: null, line: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, sync.synced]);

  return (
    <section className="floor-status" aria-label={t("floor.status.label")}>
      <dl className="floor-status__identity">
        {place.organization !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.organization")}</dt>
            <dd>{place.organization}</dd>
          </div>
        )}
        {place.line !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.line")}</dt>
            <dd>{place.line}</dd>
          </div>
        )}
        <div className="floor-status__item">
          <dt>{t("floor.status.operator")}</dt>
          <dd>
            {operator === null
              ? t("floor.status.nobody")
              : t("floor.status.operatorValue", { name: operator.name, login: operator.login })}
          </dd>
        </div>
      </dl>
      <HostStatusLine status={link} sync={sync} />
    </section>
  );
}
```

- [ ] **Step 4: Тексты, стили, рамка цеха в `App`; экраны отдают строку связи**

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
  "floor": {
    "title": "Цех",
    "office": "Офис",
```

заменить на:

<!-- prettier-ignore -->
```json
  "floor": {
    "title": "Цех",
    "office": "Офис",
    "status": {
      "label": "Строка состояния цеха",
      "organization": "Организация",
      "line": "Линия",
      "operator": "Оператор",
      "nobody": "Никто не вошёл",
      "operatorValue": "{{name}}, табельный номер {{login}}"
    },
```

Правка `apps/standalone/src/app/shell.css`:

Фрагмент:

<!-- prettier-ignore -->
```css
.floor-sign-in {
  display: flex;
```

заменить на:

<!-- prettier-ignore -->
```css
/* The floor: the status bar across the top, the screen centred below it. */
.floor-frame {
  align-self: stretch;
  justify-self: stretch;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 16px;
}

.floor-frame > .standalone-card {
  place-self: center;
}

.floor-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.floor-status__identity {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin: 0;
}

.floor-status__item dt {
  color: var(--fg-2);
}

.floor-status__item dd {
  margin: 0;
  font: var(--floor-body-strong);
}

.floor-sign-in {
  display: flex;
```

Правка `apps/standalone/src/app/App.tsx` (2 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { FloorOperatorScreen } from "../floor/FloorOperatorScreen.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { FloorOperatorScreen } from "../floor/FloorOperatorScreen.js";
import { FloorStatusBar } from "../floor/FloorStatusBar.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      {view.kind === "floor" && pairedStatus !== null && (
        <OperatorSignIn
          // A number or PIN typed under another pairing or line is not kept.
          key={`${pairedStatus.hostId}:${pairedStatus.deviceId}:${pairedStatus.lineId ?? ""}`}
          local={localDb}
          pairing={pairedStatus}
          lineId={pairedStatus.lineId}
          link={state.link}
          sync={state.sync}
          notice={state.floorNotice}
          source={scanner}
          onSignedIn={operatorSignedIn}
          onSync={signInSync.request}
          onOffice={() => dispatch({ type: "office_requested" })}
        />
      )}
      {view.kind === "floor_operator" && pairedStatus !== null && (
        <FloorOperatorScreen
          operator={view.operator}
          local={localDb}
          pairing={pairedStatus}
          link={state.link}
          sync={state.sync}
          {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
          onSignOut={operatorSignedOut}
        />
      )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {(view.kind === "floor" || view.kind === "floor_operator") && pairedStatus !== null && (
        <div className="floor-frame">
          <FloorStatusBar
            local={localDb}
            pairing={pairedStatus}
            lineId={pairedStatus.lineId}
            operator={view.kind === "floor_operator" ? view.operator : null}
            link={state.link}
            sync={state.sync}
          />
          {view.kind === "floor" ? (
            <OperatorSignIn
              // A number or PIN typed under another pairing or line is not kept.
              key={`${pairedStatus.hostId}:${pairedStatus.deviceId}:${pairedStatus.lineId ?? ""}`}
              local={localDb}
              pairing={pairedStatus}
              lineId={pairedStatus.lineId}
              sync={state.sync}
              notice={state.floorNotice}
              source={scanner}
              onSignedIn={operatorSignedIn}
              onSync={signInSync.request}
              onOffice={() => dispatch({ type: "office_requested" })}
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
          )}
        </div>
      )}
```

Правка `apps/standalone/src/floor/OperatorSignIn.tsx` (4 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { FloorNotice, SyncState } from "../app/shell.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  lineId: string | null;
  link: HostStatus | null;
  sync: SyncState;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineId: string | null;
  sync: SyncState;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  lineId,
  link,
  sync,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineId,
  sync,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        {body()}
        <HostStatusLine status={link} sync={sync} />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {body()}
```

Правка `apps/standalone/src/floor/FloorOperatorScreen.tsx` (4 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { FloorNotice, SyncState } from "../app/shell.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  pairing: Pairing;
  link: HostStatus | null;
  sync: SyncState;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  pairing: Pairing;
  sync: SyncState;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  pairing,
  link,
  sync,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  pairing,
  sync,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        <p>{t("floor.operator.stub")}</p>
        <HostStatusLine status={link} sync={sync} />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        <p>{t("floor.operator.stub")}</p>
```

Тесты экранов теряют проп `link` (TypeScript не пропустит лишний проп), а тест строки связи экрана входа уже переехал в `test/floor-status-bar.test.tsx` («shows the link to the host»):

Правка `apps/standalone/test/operator-sign-in.test.tsx` (4 фрагмента):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
        lineId={null}
        link={null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        lineId={null}
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
          lineId={null}
          link={null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          lineId={null}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    lineId: null,
    link: null,
```

заменить на:

<!-- prettier-ignore -->
```tsx
    lineId: null,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
  it("shows the link to the host", async () => {
    render(
      screenOf(
        propsOf(await synced([SITE, OPERATOR]), {
          link: { state: "offline", lastContactAt: null, lastError: "unreachable", seq: 1 },
        }),
      ),
    );
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

```

удалить целиком (вместе с пустой строкой после него).

Правка `apps/standalone/test/floor-operator.test.tsx`:

Фрагмент:

<!-- prettier-ignore -->
```tsx
        pairing={PAIRING}
        link={null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        pairing={PAIRING}
```

- [ ] **Step 5: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 66 файлов, 1703 теста.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-status-bar.test.tsx test/app.test.tsx test/operator-sign-in.test.tsx test/floor-operator.test.tsx`
Expected: PASS, в выводе нет `stderr |`. Затем эти четыре файла под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 6: Мутация**

Строка состояния читает чужие копии. В `apps/standalone/src/floor/floor-status.ts` удалить строку

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(local, pairing))) return NOWHERE;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-status-bar.test.tsx`
Expected: FAIL `names nothing from copies that are not this pairing's` — `AssertionError: expected { organization: 'ООО «Атолл»', …(1) } to deeply equal { organization: null, line: null }`. Восстановить, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Commit**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

```bash
git add apps/standalone/src/floor/floor-status.ts apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/floor/OperatorSignIn.tsx apps/standalone/src/floor/FloorOperatorScreen.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/floor-status-bar.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/operator-sign-in.test.tsx apps/standalone/test/floor-operator.test.tsx
git commit -m "feat(standalone): the floor's status bar above the sign-in screen and the stub" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Документы и ручной список проверок в Windows

**Files:**

- Modify: `apps/standalone/AGENTS.md` («Operators and badges», «App shell», «Logs», «Verification»)
- Modify: `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.1, §5.2, §5.6, §8)

**Interfaces:**

- Consumes: поведение задач 1–6 как оно в коде (имена файлов, функций, кодов отказа и кнопок).

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

Правка `apps/standalone/AGENTS.md` (5 фрагментов):

Фрагмент 1:

<!-- prettier-ignore -->
```md
  end), so a burst of stray scans does not hammer the host.
```

заменить на:

<!-- prettier-ignore -->
```md
  end), so a burst of stray scans does not hammer the host.
- The name search (plan 1f2; «Найти себя по имени», `src/floor/operator-search.ts`)
  only fills in a personnel number: the PIN is then checked by
  `signInWithPin` like a typed one, under the same lockouts. It reads
  `readOperatorRoster` (`src/floor/sign-in.ts`: this pairing's copies once
  `copiesReady`, none waiting in quarantine, identity only, never a hash)
  when it opens and after every sync, offers nothing until the query has two
  letters, and at most five names, by name and then id, each with its
  personnel number, so two operators with one name are told apart. An
  operator whose number the keypad could not type (3–12 digits) is never
  offered. While the name field has the focus, the keyboard-wedge source takes
  no scan (`setManualTextEntryActive`): typed letters and their Enter stay the
  field's, and a badge scanned into the field signs nobody in. Leaving the
  field, the step or the screen gives the scanner back.
```

Фрагмент 2:

<!-- prettier-ignore -->
```md
plan's proposal too. «Офис» and «Повторить» are below the station's 64 px
convention. Part 1f2 is next: kiosk mode, the protected way out of it, the
name search, the floor status bar, the two extra `windows-sys` features as an
owner step, and the Windows checks.
```

заменить на:

<!-- prettier-ignore -->
```md
plan's proposal too. Every button of the sign-in screen, «Офис» and
«Повторить» included, is the floor's 64 px (`size="floor"`), and
`test/operator-sign-in.test.tsx` checks every step. Kiosk mode and the
floor's status bar are under "App shell".
```

Фрагмент 3:

<!-- prettier-ignore -->
```md
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.
```

заменить на:

<!-- prettier-ignore -->
```md
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.

The floor's status bar (`src/floor/FloorStatusBar.tsx`, plan 1f2) sits above
the sign-in screen and the stub as a labelled region: the organization and
the station's line by name from this pairing's copies (`readFloorPlace` in
`src/floor/floor-status.ts`, nothing before `copiesReady`; an archived line is
still named), the operator signed in or «Никто не вошёл», and
`HostStatusLine`, which the floor screens no longer show themselves. It holds
nothing to press. The device's own name is not in it: `DeviceStatus` has none.

Kiosk mode (plan 1f2). `src-tauri/src/lockdown.rs` ports the cloud station's
`enter_lockdown` and `exit_lockdown`: no frame, no taskbar button, above every
window, fullscreen, and on Windows `SetWindowPos(HWND_TOPMOST)` over the
monitor's `rcMonitor`. Entering sets the flag only once every property held
and rolls every property back on a failure; leaving clears the flag first and
always, then restores what it can, so an operator is never trapped in a window
that will not close. While the flag is set, `refuse_close_while_locked`
refuses every close request (the frame's button, Alt+F4, the taskbar).
Refusals are bare codes, `no_window` and `window_failed`; the window system's
text never crosses IPC. The webview's `src/app/lockdown.ts` (the cloud's
`createLockdownLifecycle`) runs the commands one after another, sends nothing
for a mode already asked for, and nothing at all in development
(`import.meta.env.DEV`: `tauri dev` and the tests). `App` enters kiosk mode
whenever no office session is open: at start, when the office closes and when
its session ends. The way out is «Оконный режим» in the office header,
shown only to an administrator while the window is locked: it asks first,
reads the user from the host again (`GET /v1/office/me`) and opens the window
only if the host still says administrator; leaving the office locks it again.
There is no local maintenance code (one more secret on the PC; an owner
question). Without the host nobody signs in to the office, so the app cannot
leave kiosk mode then: Windows' own Ctrl+Alt+Del stays, and Tauri catches
neither it nor Alt+Tab or the Windows key (the window stays on top). A failed
enter is logged by the command's name and tried again at the next office
close or restart; nothing on screen says so. The device-rejected, other-host
and config-error screens show in kiosk mode too, with «Подключить заново» and
«Сбросить подключение»: that forget empties the copies and the lockout
counters with them (`clear_copies`). Those screens come only when the host
refused the device or its config is unreadable, which nobody produces from the
floor, and a station on another PC pairs again only with an administrator's
code; a station on the host's PC pairs again on its own (loopback trust), so
there the counters start from zero after such a forget (an owner question).
```

Фрагмент 4:

<!-- prettier-ignore -->
```md
walks a stock and an office layout through the template routes, the
defaults and the feed.
```

заменить на:

<!-- prettier-ignore -->
```md
walks a stock and an office layout through the template routes, the
defaults and the feed. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.
```

Фрагмент 5:

<!-- prettier-ignore -->
```md
  tests round-trip a key through DPAPI. A real Windows user profile, the
  service at runtime and (later) kiosk mode still need a manual check on
  Windows; a run on macOS proves none of it.
```

заменить на:

<!-- prettier-ignore -->
```md
  tests round-trip a key through DPAPI. A real Windows user profile, the
  service at runtime and kiosk mode still need a manual check on Windows; a
  run on macOS proves none of it.
- Kiosk mode in tests: `src-tauri/tests/lockdown.rs` drives the commands and
  the close guard on Tauri's mock runtime, which accepts every window property
  and never calls a builder's window-event handler, so the test hands each
  close request to the guard itself; it runs in the sandbox. The
  `cfg(windows)` code needs the `windows-sys` features `Win32_Graphics_Gdi`
  and `Win32_UI_WindowsAndMessaging` and compiles only in
  `standalone-windows-build`.
- Kiosk mode by hand, on Windows 10 and 11 with a build from that job: the
  window locks at start, again after «Выйти в цех» and after the office
  session ends; Alt+F4 and closing from the taskbar keep it open; it stays
  above every window and covers its whole monitor, the taskbar included, on a
  second monitor too; «Оконный режим» is offered to an administrator and not
  to a technologist, and brings back the frame and the taskbar button; a
  restart locks again; a real keyboard-wedge scanner signs in under the EN and
  RU layouts and with Caps Lock, and a name typed into the search is not
  scanned; a product's code scanned on the sign-in screen; sign-in time by
  badge and PIN on a factory PC; the status bar and the 64 px controls on the
  real screen and touch panel.
```

- [ ] **Step 2: Спецификация этапа 1**

Правка `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (6 фрагментов):

Фрагмент 1:

<!-- prettier-ignore -->
```md
Киоск-режим (`lockdown.ts` и Rust-команды станции) включается вне режима разработки.
```

заменить на:

<!-- prettier-ignore -->
```md
Киоск-режим (план 1f2: `src/app/lockdown.ts` и команды `enter_lockdown`/`exit_lockdown`
в `src-tauri/src/lockdown.rs`, перенесённые со станции) включается вне режима разработки
всякий раз, когда сессия офиса не открыта: при запуске, при выходе из офиса и когда его
сессия кончилась. Окно без рамки и кнопки на панели задач, поверх остальных, во весь
экран (в Windows — на весь монитор поверх панели задач); пока киоск-режим включён, окно
не закрывается. Выход — «Оконный режим» в шапке офиса, только для администратора
(технолог и цех его не видят): с подтверждением и после повторного чтения пользователя
с хоста; выход из офиса снова включает киоск-режим. Без хоста в офис не войти, и
средствами приложения киоск-режим не покинуть; остаётся `Ctrl+Alt+Del` Windows. Местного
кода обслуживания нет (ещё один секрет на ПК) — вопрос владельцу.
```

Фрагмент 2:

<!-- prettier-ignore -->
```md
- **Перенесённые команды станции:** киоск-режим (`enter_lockdown`/`exit_lockdown`),
  не засыпать (`set_system_awake`) — без изменений логики.
```

заменить на:

<!-- prettier-ignore -->
```md
- **Перенесённые команды станции:** киоск-режим (`enter_lockdown`/`exit_lockdown`,
  план 1f2): флаг ставится, только когда окно приняло все свойства (иначе они
  откатываются), и снимается выходом всегда, даже если свойство не вернулось; отказы —
  голые коды `no_window` и `window_failed`. Не засыпать (`set_system_awake`) — по
  решению владельца, пока не перенесено.
```

Фрагмент 3:

<!-- prettier-ignore -->
```md
  номер и PIN на цифровой клавиатуре; поиск по имени — в плане 1f2. Проверка
```

заменить на:

<!-- prettier-ignore -->
```md
  номер и PIN на цифровой клавиатуре; поиск по имени (план 1f2: от двух букв, не
  больше пяти имён с табельными номерами, только копии этого подключения, без хешей;
  выбор имени лишь подставляет табельный номер перед PIN, а пока поле поиска в
  фокусе, клавиатурный сканер не принимает сканов). Проверка
```

Фрагмент 4:

<!-- prettier-ignore -->
```md
- Строка состояния — перенесённый `StatusBar`: станция, линия, оператор, связь с
  хостом (план 1f2; в плане 1f1 — строка связи `HostStatusLine`).
```

заменить на:

<!-- prettier-ignore -->
```md
- Строка состояния (план 1f2, `src/floor/FloorStatusBar.tsx`) — по образцу
  `StatusBar` станции: организация и линия из копий этого подключения, оператор,
  связь с хостом и здоровье справочников (`HostStatusLine`); имени устройства в ней
  нет — `DeviceStatus` его не хранит.
```

Фрагмент 5:

<!-- prettier-ignore -->
```md
  блокировки не обновляется до следующей попытки; кнопки «Офис» и «Повторить» ниже
  принятых для станции 64 px.
```

заменить на:

<!-- prettier-ignore -->
```md
  блокировки не обновляется до следующей попытки. Все кнопки экрана входа — 64 px.
  Киоск-режим, его выход и отказ закрыть окно проверяются только вручную в Windows
  (список — в `apps/standalone/AGENTS.md`, «Verification»).
```

Фрагмент 6:

<!-- prettier-ignore -->
```md
1f2, следующую часть (киоск-режим оболочки и защищённый выход из него, поиск
оператора по имени, строка состояния цеха, два набора возможностей `windows-sys`
шагом владельца и ручные проверки в Windows — схемой в конце того же плана).
```

заменить на:

<!-- prettier-ignore -->
```md
1f2 (`docs/superpowers/plans/2026-10-07-standalone-1f2-kiosk-mode.md`: киоск-режим
оболочки и выход из него для администратора офиса, поиск оператора по имени, строка
состояния цеха, два набора возможностей `windows-sys` шагом владельца; ручные проверки
в Windows — за владельцем).
```

- [ ] **Step 3: Проверка и commit**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: чисто.

Каждое имя в новых абзацах сверить с кодом: `grep -rnE "no_window|window_failed|refuse_close_while_locked|readOperatorRoster|readFloorPlace|setManualTextEntryActive|Оконный режим|Найти себя по имени|Никто не вошёл" apps/standalone/src apps/standalone/src-tauri/src` — каждое находится.

```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "docs(standalone): kiosk mode, the name search and the floor's status bar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 66 файлов, 1703 теста (до плана 63 и 1662; +3 файла, +41 тест).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/lockdown.test.ts test/app.test.tsx test/office.test.tsx test/operator-search.test.ts test/operator-sign-in.test.tsx test/floor-operator.test.tsx test/floor-status-bar.test.tsx`
Expected: PASS — 7 файлов, 219 тестов; в выводе нет `stderr |`. Затем `test/app.test.tsx`, `test/office.test.tsx`, `test/operator-sign-in.test.tsx`, `test/floor-operator.test.tsx` и `test/floor-status-bar.test.tsx` под стендом с задержкой `setImmediate` — PASS, 5 файлов, 206 тестов; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB (главный чанк — с 893,91 до 901,74 kB).

- [ ] **Step 2: Cargo**

Оболочка встраивает сборку вебвью из шага 1 (`apps/standalone/dist`), поэтому Cargo идёт после неё.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-run`
Expected: чисто; сборка всех наборов без предупреждений.

Run (в песочнице): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db --test lockdown`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: PASS — оболочка: 63 теста в 3 наборах (библиотека 47, `local_db` 12, `lockdown` 4); `proto`: 39 тестов в 3 наборах.

Run (вне песочницы — наборы открывают сокеты на loopback): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace`
Expected: PASS — 42 набора, 461 тест (хост 307, `proto` 39, оболочка 115). В песочнице эта же команда падает на `bind` в 47 тестах 11 наборов (список — в «Заметках для исполнения»).

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check b4f635f13`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat b4f635f13 -- apps/station packages apps/standalone/host apps/standalone/proto pnpm-lock.yaml apps/standalone/package.json apps/standalone/Cargo.lock`
Expected: пусто. `git diff b4f635f13 -- apps/standalone/src-tauri/Cargo.toml` — ровно строка задачи 1.

- [ ] **Step 4: Что не проверить в песочнице и без Windows**

Записать в отчёт, что не проверено (а не «проверено»):

- киоск-режим в настоящем окне: рамка, кнопка на панели задач, «поверх всех», полный экран, `SetWindowPos(HWND_TOPMOST)` по монитору (и на втором мониторе), отказ закрыть окно на `Alt+F4` и с панели задач, возврат рамки «Оконным режимом» — mock runtime принимает любое свойство и не вызывает обработчик окна из `Builder::on_window_event`; что `run` ставит стража, проверяется только вручную;
- сборка оболочки для Windows (`cfg(windows)`-код и возможности задачи 1) и тест `on_windows_a_refused_enter_leaves_the_flag_off` — только задание `standalone-windows-build`; локально проверен лишь крейт-пробник с теми же вызовами `windows-sys`;
- `Ctrl+Alt+Del`, `Alt+Tab` и клавиша Windows: Tauri их не перехватывает, окно остаётся поверх — поведение на заводском ПК;
- настоящий клавиатурный сканер в поле поиска по имени (раскладки EN/RU, Caps Lock) и экранная клавиатура Windows для набора имени на сенсорной панели;
- раскладка строки состояния и шага поиска на настоящем экране и сенсоре (стили не смотрели в браузере), в том числе исправленный зазор `.floor-sign-in`;
- поведение на живом хосте: «Оконный режим» с настоящим `GET /v1/office/me`, истечение сессии в оконном режиме — проверено тестами с поддельным хостом.

---

## Перенесено

- Вопросы владельцу (из 1f1, без изменений): числа блокировок, время бездействия, дополнять ли короткий табельный номер нулями, эскалация блокировок.
- Способ выхода из киоск-режима: сейчас — администратор офиса (с повторной проверкой роли на хосте), без хоста — только `Ctrl+Alt+Del` Windows. Альтернатива — местный код обслуживания (ещё один секрет на ПК: где хранить, как менять и не потерять) — по решению владельца.
- «Забывание» на экранах отказа устройства, другого хоста и нечитаемой конфигурации стирает счётчики блокировок вместе с копиями; станция на ПК хоста после этого подключается заново сама (доверие loopback), и счётчики начинаются с нуля. Защищать ли эти кнопки в киоск-режиме (например, только из офиса) — вопрос владельцу.
- `set_system_awake` (не засыпать, пока вошёл оператор) и набор возможностей `windows-sys` `Win32_System_Power` — по решению владельца.
- Имя устройства в строке состояния: его нет в `DeviceStatus` и `device.json`; добавить — правка оболочки (`device.rs`, формат `device.json` с обратной совместимостью) и `GET /v1/device` при обновлении.
- Неудачный вход в киоск-режим только пишется в журнал и повторяется при следующем закрытии офиса или перезапуске; сообщения на экране или в офисе нет.
- Подвисший IPC (около 35 с) и долгий IPC жизненного цикла: команды киоск-режима в оболочке синхронные, и если вызов не отвечает, висит само окно; тайм-аут, который пустил бы следующую команду, мог бы оставить окно запертым при снимке «оконный» — оставлено как в облаке.
- Кнопки экранов оболочки вне цеха (отказ устройства, другой хост, нечитаемая конфигурация, хост не найден) — обычного размера, хотя в киоск-режиме их видят на станции; 64 px для них — вместе с решением о защите «забывания».
- Перенесённое из 1f1 и не затронутое здесь: уведомление о разделителе групп GS1 и разбор кодов с префиксом AIM (план 2a), монотонные часы для блокировок, пункты 20 и 22 очереди 1f1 (план 2a), пустые табельные номера с ведущими нулями на стороне хоста, сообщение о блокировке в журнале хоста, мелочи повторного ревью 1f1 (`Ctrl+]` в русской раскладке, «уведомление не возвращается» при перемонтировании, приведения `as HTMLButtonElement` в тестах, длинные строки в документах).
- План 2a (смена на станции) и план 5 (политика версий протокола) — без изменений.

## Отклонения при исполнении
