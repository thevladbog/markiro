# План 1f: станция — вход оператора офлайн, блокировки и заглушка цеха (1f1 полностью, 1f2 — схемой) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор входит на станции «Маркиро Автоном» по бейджу (клавиатурный сканер) или по табельному номеру и PIN — без хоста, только по локальным копиям операторов и бейджей этого подключения; после серии неудач вход станции или PIN оператора приостанавливается; после входа — заглушка цеха с именем оператора, выход по «Сменить оператора», по бездействию и когда офис выключил оператора. Перед этим синхронизация привязывает копии к подключению (идентификатор устройства рядом с хостом), чтобы страница прежнего подключения с тем же хостом не вернула выключенного оператора или отозванный бейдж. Это первая часть плана (1f1, задачи 1–7). Вторая (1f2: киоск-режим оболочки и выход из него, поиск оператора по имени, строка состояния цеха) дана в конце схемой.

**Architecture:**

- `src/local/reference-sync.ts` — `pairingGuard` вместо `hostGuard`: каждая порция требует, чтобы `sync_state` называл хост и идентификатор устройства этого прогона; другое подключение с тем же хостом стирает копии сразу; `copiesReady` говорит, что копии принадлежат этому подключению и полны. `useHostLink` и `App` передают `deviceId`.
- `src/floor/` — новый каталог цеха (спецификация §3): `sign-in.ts` (проверка PIN и бейджа по копиям через `@markiro/domain`), `lockout.ts` (счётчики неудач и блокировки в таблице `floor_sign_in_failures`, миграция `src-tauri/migrations/0005_floor_sign_in_failures.sql`), `scan-source.ts` (клавиатурный сканер), `OperatorSignIn.tsx` (экран входа), `idle-lock.ts` и `FloorOperatorScreen.tsx` (заглушка цеха после входа).
- `src/app/shell.ts` — сеанс оператора в памяти оболочки (`operator`, `floorNotice`, вид `floor_operator`), выход оператора при офисе, новом подключении, отказе устройства, смене линии; `App.tsx` показывает экран входа и заглушку.
- Хост, `proto` и `packages/*` не меняются; новых зависимостей нет. Rust меняется только комментариями `src-tauri/src/local_db.rs` и списком таблиц в `src-tauri/tests/local_db.rs` (новая миграция встраивается `sqlx::migrate!`).

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, i18next, `@markiro/ui` (`Card`, `Button`, `PinPad`, `Alert`, `Spinner`), `@markiro/domain` (`verifyPhc`, `parsePhc`, `PHC_ITERATIONS`), WebCrypto Node 24, Vitest 4 с jsdom и `node:sqlite` за `LocalExecutor`; Rust — sqlx 0.8 (миграции оболочки).

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1f-design.md`: границы плана, решения D1–D6, постоянные ограничения процесса.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §1 (сценарий), решение 9 («PIN и бейджи»), §4.3, §5.1 (оболочка), §5.2–§5.4 (оболочка, локальная база, синхронизация), §5.6 (цех), §8 (строка 1f).
- `apps/standalone/AGENTS.md`: «Change feed» (запись бейджа без оператора доступа не даёт), «Operators and badges» (правила входа плана 1f и предусловие о `hostGuard`), «Local database» (`clear_copies`, `secure_delete`), «Reference sync», «Logs».
- План 1d4 (`docs/superpowers/plans/2026-09-29-standalone-1d4-office-operators-badges.md`) — копии операторов и бейджей, строгие записи ленты, карантин.
- Облачная станция (переносится своими модулями, не импортом): `apps/station/src/lib/{auth,crypto,operator-idle-lock,scan-source,lockdown}.ts`, `apps/station/src/pages/OperatorLogin.tsx`, `apps/station/src-tauri/src/{commands,lib}.rs`.

## Global Constraints

**Решения контроллера** (обязательные; владелец может их пересмотреть; уточнения планировщика помечены «Уточнение»)

- D1. Новых зависимостей нет; хеширование — только функциями `@markiro/domain` (`verifyPhc` для PIN, `hashBadge` из `src/lib/credentials.ts` поверх `deriveDigestB64`/`formatPhc` для бейджа). Уточнение: Rust в 1f1 новых крейтов не получает; часть 1f2 добавляет к уже подключённому `windows-sys` два набора возможностей (`Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging`) — это не новый крейт, но правка `Cargo.toml`, и она названа в схеме.
- D2. Офлайн прежде всего: вход никогда не обращается к хосту, хост лишь поставляет копии прежней синхронизацией; карантин и чужие копии закрывают вход (fail-closed). Уточнение: неизвестный бейдж или PIN просит немедленную синхронизацию (`onSync`), как спецификация §5.6 заменяет облачное «обновить список перед отказом»; следующий вход читает то, что она принесла.
- D3. PIN, код бейджа и любые хеши — никогда в журналах, ошибках, тостах, состоянии маршрутизатора, тексте падения и снимках тестов; фикстуры — тестовые значения (`PIN 4821`, бейдж `MRK-000742` из `proto/fixtures`). Уточнение: модули входа ничего не пишут в консоль (тест это проверяет), ошибка локальной базы на экране — общим текстом, без её сообщения.
- D4. Офисный пользователь и оператор станции — разные личности: офис не наследует оператора (открытие офиса выводит оператора), сеанс офиса не открывает цех.
- D5. Объём: задачи 1–7 — 1f1 полностью; 1f2 — схема из пяти задач с точными шагами владельца.
- D6. Тесты: `node:sqlite` за `LocalExecutor` в Vitest, часы внедряются; Rust — `tests/local_db.rs` оболочки; поведение Windows (киоск-режим) — только схемой 1f2 и как непроверенное.

**Решения планировщика** (открытые места брифа; числа — предложение, ждут владельца)

- Блокировка станции: 10 неудач подряд (неверный PIN, неизвестный табельный номер, неизвестный бейдж) — любой вход на станции приостановлен на 1 минуту (`STATION_LOCKOUT = { limit: 10, durationMs: 60_000 }`). Блокировка оператора: 5 неверных PIN подряд — его вход по PIN приостановлен на 5 минут (`OPERATOR_LOCKOUT = { limit: 5, durationMs: 300_000 }`); бейдж того же оператора впускает. После блокировки отсчёт начинается заново; удачный вход забывает неудачи станции и оператора.
- Не считаются: неправильная форма номера или PIN (клавиатура их не пошлёт), код товара (разделитель групп GS1 `\u001d`), скан кириллицей, скан, который не может быть бейджем, неоднозначный номер или бейдж, копии, которые не готовы.
- Счётчики хранятся в локальной базе (`floor_sign_in_failures`), а не в памяти: перезапуск приложения (в киоск-режиме — выключение ПК) их не сбрасывает. Ключ — `station` или `operator:<id>`, никогда набранный номер. Таблица — первые данные самого устройства, но одноразовые: `clear_copies` очищает её вместе с копиями намеренно, и `tests/local_db.rs` фиксирует это решение (комментарий там же).
- Время — часы этого ПК в миллисекундах Unix (как `seen_at` карантина); монотонные часы оболочки и «идентичность загрузки» облачной станции (`grant_clock.rs`) в автономной станции не перенесены, и плану они не нужны: часы, отведённые назад за начало блокировки, начинают её заново от «сейчас», но не дольше её длительности; часы, переведённые вперёд, сокращают блокировку — оператор в киоск-режиме часы не меняет.
- Табельный номер — ровно как у хоста, 3–12 цифр, без дополнения нулями (облачное `padShortOperatorLogin` дополняло 1–2 цифры до трёх): «42» и «042» — разные номера. Номер, который есть у двух копий, отвергается как неоднозначный.
- Сеанс оператора — только в памяти оболочки (`ShellState.operator`), без хешей; бездействие — 10 минут (`OPERATOR_IDLE_TIMEOUT_MS`, как в облаке и спецификации §5.6). Выход оператора: «Сменить оператора», бездействие, синхронизация, после которой его нет в копиях, офис, новое подключение, сброс, отказ устройства, другой хост, смена линии офисом. Потеря связи с хостом никого не выводит.
- Экран входа и заглушка — карточки в стиле прежнего экрана цеха (`Card` «Цех», кнопки размера `floor`), не перенос `station.css`; поиск по имени и `StatusBar` — в 1f2.
- Устройство вида `office` (это приложение такого не создаёт: `host_local_pair` и `host_claim` подключают станцию) видит тот же экран входа.

**Тексты**

- Каждый видимый текст — ключ `src/i18n/ru.json`; тексты даны в шагах целиком и переносятся буква в букву; кавычки — «ёлочки». Новые группы: `floor.signIn` (задача 5), `floor.operator` (задача 6); ключ `floor.body` уходит вместе с прежним экраном цеха (задача 6).
- Число в тексте — именованная переменная (`minutes`), не `count`.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля и кнопки в `src/`); состояние словами, не одним цветом; сообщения входа — в живой области `aria-live="polite"`; кнопки цеха — `size="floor"` (64 px).
- `apps/station`, `packages/*`, `apps/standalone/host` и `apps/standalone/proto` не меняются. Rust: только `src-tauri/src/local_db.rs` (комментарий) и `src-tauri/tests/local_db.rs` (список таблиц); число наборов и тестов Cargo не меняется (41 набор, 453 теста).
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам). Правки внутри шага идут сверху вниз по файлу, одна за другой. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке; «Выполнить» — команда из корня репозитория, которая меняет файлы (задача 1: замена по всему тестовому файлу и форматирование).
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier: расхождение при проверке значит опечатку.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`. Разделитель групп GS1 в коде и тестах пишется `\u001d` — это не кириллица.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным сообщением; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Каталог `/tmp/claude` один внутри и вне песочницы (`$TMPDIR` у них разный).

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD (SQL и Rust prettier не читает; Rust проверяет `cargo fmt --check`); `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Тесты экранов: React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`; там, где нужно дождаться эффекта, тест делает `settle()` (два хода `setImmediate`) или ждёт текст. Два скана, которые должны прийти во время одной проверки, — в одном `act`.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`), поэтому опечатка в ключе роняет тест, а не показывает ключ.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Те же файлы экранов один раз запускаются под стендом с задержкой `setImmediate` на 3 мс: он делает флейк эффекта постоянным. Стенд — два временных файла внутри пакета (из `/tmp` Vite не грузит); запустить и сразу удалить, до `lint`:

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

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`, затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

- PBKDF2. Каждая проверка PIN или бейджа в тестах — настоящие 100 000 итераций (десятки миллисекунд); тесты блокировок делают их десятками. Если тест падает по таймауту 5 с только в полном прогоне под внешней нагрузкой, записать это в отчёт и повторить при обычной загрузке; таймауты не поднимать и утверждения не ослаблять (корневой `AGENTS.md`).
- Cargo (задача 3 и итоговая проверка). Оболочка встраивает сборку вебвью, поэтому перед её тестами: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Набор оболочки собирается один раз, дальше тесты идут частями (`--test <имя>`). Наборы, которые слушают сокет на loopback, в песочнице падают на `bind` (`cannot listen on 127.0.0.1:0: Operation not permitted`): хост — `changes_stream`, `hello`, `no_secrets_in_logs`, `platform`; оболочка — `claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `ipc`, `line` (47 тестов). Полный `cargo test --workspace` исполнитель запускает вне песочницы; `local_db`, тесты библиотек и `proto` песочницу проходят.

**Счёт тестов**

- До плана: Vitest — 59 файлов, 1418 тестов; cargo — 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107). Каждое «Expected» ниже измерено на копии репозитория с тестами самого плана; расхождение значит, что шаг применён не так (а тесты, которые исполнитель добавит сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку.

<!-- prettier-ignore -->
```text
apps/standalone/src/local/reference-sync.ts                       задача 1
apps/standalone/src/app/host-link.ts                              задача 1
apps/standalone/src/app/App.tsx                                   задачи 1, 6
apps/standalone/test/support/fixtures.ts                          задача 1
apps/standalone/test/reference-sync.test.ts                       задача 1
apps/standalone/test/app.test.tsx                                 задачи 1, 6
apps/standalone/src/floor/sign-in.ts                              задачи 2, 3, 6
apps/standalone/test/floor-sign-in.test.ts                        задачи 2, 3
apps/standalone/src-tauri/migrations/0005_floor_sign_in_failures.sql  задача 3
apps/standalone/src/floor/lockout.ts                              задача 3
apps/standalone/test/floor-lockout.test.ts                        задача 3
apps/standalone/test/local-executor.test.ts                       задача 3
apps/standalone/src-tauri/src/local_db.rs (комментарий)           задача 3
apps/standalone/src-tauri/tests/local_db.rs                       задача 3
apps/standalone/src/app/shell.ts                                  задача 4
apps/standalone/test/shell.test.ts                                задача 4
apps/standalone/src/floor/{scan-source.ts,OperatorSignIn.tsx}     задача 5
apps/standalone/src/i18n/ru.json                                  задачи 5, 6
apps/standalone/src/app/shell.css                                 задача 5
apps/standalone/test/operator-sign-in.test.tsx                    задача 5
apps/standalone/src/floor/{idle-lock.ts,FloorOperatorScreen.tsx}  задача 6
apps/standalone/src/app/screens.tsx                               задача 6
apps/standalone/test/floor-operator.test.tsx                      задача 6
apps/standalone/AGENTS.md, спецификация §5.3, §5.4, §5.6, §8       задача 7
```

Привязка копий к подключению (задача 1) — предусловие входа и идёт первой. Проверка учётных данных (задача 2) и блокировки (задача 3) — модули без экрана, каждый со своими тестами на настоящей базе. Сеанс оператора в оболочке (задача 4) — чистый редуктор. Экран входа (задача 5) проверяется сам по себе, а задача 6 ставит его и заглушку в `App`, убирает прежний экран цеха и добавляет бездействие и проверку оператора после синхронизации; на каждом коммите у каждой кнопки есть дело. Задача 7 — документы. Часть 1f2 — после «Итоговой проверки плана».

---

### Task 1: Копии, привязанные к подключению: `pairingGuard` и `copiesReady` (предусловие входа)

`syncReferences` до сих пор охраняет каждую порцию только хостом (`hostGuard`): страница, запрошенная до `device_forget`, после нового подключения к тому же хосту проходит охрану, возвращает запись, которую надгробие нового прогона удалило (выключенного оператора, отозванный бейдж), и откатывает `last_rev` (`apps/standalone/AGENTS.md`, «Operators and badges» и «Reference sync»). Хост выдаёт каждому подключению новый идентификатор устройства, поэтому `sync_state` получает строку `device_id` рядом с `host_id`, и охрана порции (`pairingGuard`) требует обе: `UPDATE … WHERE (key = 'host_id' AND value = ?) OR (key = 'device_id' AND value = ?)` с `expectedChanges: 2`. Сохранённое другое подключение (другой хост или другой `device_id` при том же хосте) стирает копии сразу, как прежде другой хост; состояние без полной метки (первая синхронизация или `host_id`, оставленный более старой сборкой) получает метку до первого запроса и теряет `last_rev`, чтобы копии, которые нельзя привязать к подключению, читались несинхронизированными. `copiesReady(local, { hostId, deviceId })` отвечает, принадлежат ли копии этому подключению и полны ли они: вход станции (задачи 2–6) читает копии только тогда. Порция по-прежнему не длиннее 30 операторов (охрана — одна). `useHostLink` получает `deviceId`, `App` передаёт его из подключения.

**Files:**

- Modify: `apps/standalone/src/local/reference-sync.ts`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`
- Test: `apps/standalone/test/support/fixtures.ts` (`DEVICE_ID`), `apps/standalone/test/reference-sync.test.ts`, `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: `syncReferences`, `ENTITY_SET`, `LocalExecutor` — прежние.
- Produces:
  - `reference-sync.ts`: `SyncOptions.deviceId: string` (обязательный); `export interface Pairing { hostId: string; deviceId: string }`; `export async function copiesReady(local: LocalExecutor, pairing: Pairing): Promise<boolean>`; строка `sync_state` `device_id`, которую пишут метка подключения и каждая порция;
  - `host-link.ts`: `HostLinkOptions.deviceId: string | null` (`null` ровно тогда, когда `hostId` — `null`);
  - `test/support/fixtures.ts`: `export const DEVICE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"` (идентификатор `DEVICE_STATUS`).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/support/fixtures.ts` фрагмент

<!-- prettier-ignore -->
```ts
export const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

заменить на

<!-- prettier-ignore -->
```ts
export const LINE_ID = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
/** The device id `DEVICE_STATUS`'s pairing got from the host. */
export const DEVICE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
```

2. В `apps/standalone/test/support/fixtures.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId: HOST_ID,
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId: HOST_ID,
  deviceId: DEVICE_ID,
  kind: "station",
```

3. Выполнить из корня репозитория — каждый вызов `syncReferences` в `reference-sync.test.ts` получает подключение (87 вызовов с `HOST_ID`, 5 с `OTHER_HOST`), затем форматирование:

<!-- prettier-ignore -->
```bash
perl -pi -e 's/hostId: HOST_ID(?=[,\s}])/hostId: HOST_ID, deviceId: DEVICE_ID/g; s/hostId: OTHER_HOST(?=[,\s}])/hostId: OTHER_HOST, deviceId: OTHER_DEVICE/g' apps/standalone/test/reference-sync.test.ts
node_modules/.bin/prettier --write apps/standalone/test/reference-sync.test.ts
grep -c "deviceId: DEVICE_ID" apps/standalone/test/reference-sync.test.ts
grep -c "deviceId: OTHER_DEVICE" apps/standalone/test/reference-sync.test.ts
```

Expected: `87` и `5`.

4. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
import {
  createSyncScheduler,
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  copiesReady,
  createSyncScheduler,
```

5. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
} from "../src/local/reference-sync.js";
import { HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
```

заменить на

<!-- prettier-ignore -->
```ts
} from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
```

6. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

заменить на

<!-- prettier-ignore -->
```ts
const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
/** The device id of another pairing: with `OTHER_HOST`, or a later one with `HOST_ID`. */
const OTHER_DEVICE = "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

7. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

function state(lastRev: number, hostId = HOST_ID) {
  return [
    { key: "entity_set", value: ENTITY_SET },
```

заменить на

<!-- prettier-ignore -->
```ts

function state(lastRev: number, hostId = HOST_ID, deviceId = DEVICE_ID) {
  return [
    { key: "device_id", value: deviceId },
    { key: "entity_set", value: ENTITY_SET },
```

8. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

/** Two synced lines at revisions 10 and 20, from `HOST_ID`. */
```

заменить на

<!-- prettier-ignore -->
```ts

/** The pairing stamp alone, as a wipe for another pairing leaves it: no `last_rev`. */
function stamp(hostId = HOST_ID, deviceId = DEVICE_ID) {
  return [
    { key: "device_id", value: deviceId },
    { key: "host_id", value: hostId },
  ];
}

/** Two synced lines at revisions 10 and 20, from `HOST_ID`. */
```

9. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

describe("reference sync", () => {
```

заменить на

<!-- prettier-ignore -->
```ts

describe("copiesReady", () => {
  it("answers yes only after this pairing's own run applied its last page", async () => {
    const { db, executor } = openLocalDb();
    const pairing = { hostId: HOST_ID, deviceId: DEVICE_ID };
    expect(await copiesReady(executor, pairing)).toBe(false);
    await syncedTwoLines(executor);
    expect(await copiesReady(executor, pairing)).toBe(true);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: OTHER_DEVICE })).toBe(false);
    expect(await copiesReady(executor, { hostId: OTHER_HOST, deviceId: DEVICE_ID })).toBe(false);

    // A build with another entity set has not applied its first page yet.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    expect(await copiesReady(executor, pairing)).toBe(false);
  });

  it("answers no after a wipe for another pairing, which leaves the stamp alone", async () => {
    const { executor } = openLocalDb();
    await syncedTwoLines(executor);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    const next = { hostId: HOST_ID, deviceId: OTHER_DEVICE };
    await expect(syncReferences({ changes: offline, local: executor, ...next })).rejects.toThrow(
      "host unreachable",
    );
    expect(await copiesReady(executor, next)).toBe(false);
  });
});

describe("reference sync", () => {
```

10. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(tables(db)).toEqual(before);
    // The guard passed (1: `host_id` still matched and was touched), the
    // three upserts found nothing newer and nothing was quarantined to lift;
    // only the sync state was written.
    expect(recorded.batches).toEqual([[1, 0, 0, 0, 0, 3]]);
  });
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(tables(db)).toEqual(before);
    // The guard passed (2: `host_id` and `device_id` still matched and were
    // touched), the three upserts found nothing newer and nothing was
    // quarantined to lift; only the sync state was written.
    expect(recorded.batches).toEqual([[2, 0, 0, 0, 0, 4]]);
  });
```

11. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      lines: [],
      state: [{ key: "host_id", value: HOST_ID }],
    });
```

заменить на

<!-- prettier-ignore -->
```ts
      lines: [],
      state: stamp(),
    });
```

12. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      lines: [],
      state: state(20, OTHER_HOST),
    });
```

заменить на

<!-- prettier-ignore -->
```ts
      lines: [],
      state: state(20, OTHER_HOST, OTHER_DEVICE),
    });
```

13. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      lines: [],
      state: [{ key: "host_id", value: OTHER_HOST }],
    });
```

заменить на

<!-- prettier-ignore -->
```ts
      lines: [],
      state: stamp(OTHER_HOST, OTHER_DEVICE),
    });
```

14. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      lines: [{ id: LINE_2, name: "Линия B", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
```

заменить на

<!-- prettier-ignore -->
```ts
      lines: [{ id: LINE_2, name: "Линия B", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST, OTHER_DEVICE),
    });
```

15. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      lines: [{ id: LINE_2, name: "Линия нового хоста", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
```

заменить на

<!-- prettier-ignore -->
```ts
      lines: [{ id: LINE_2, name: "Линия нового хоста", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST, OTHER_DEVICE),
    });
```

16. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
```

заменить на

<!-- prettier-ignore -->
```ts

  it("fails a page of the previous pairing with the same host that lands after a forget and a new pairing", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(10, [line(LINE_1, 10, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The old pairing's next sync is still in flight...
    let resolveOld: ((value: ChangesResponse) => void) | undefined;
    const oldChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const runOld = syncReferences({
      changes: oldChanges,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(oldChanges).toHaveBeenCalledWith(10));

    // ...when `device_forget` clears every table, and the device pairs with
    // the same host again under a new device id and syncs in full.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [line(LINE_2, 12, "Линия 2")]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: OTHER_DEVICE,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });

    // The old pairing's page lands last: the same host, so a guard on the
    // host alone would let it write a record and move `last_rev` back.
    resolveOld?.(page(11, [line(LINE_1, 11, "Линия 1 (прежнее подключение)")]));
    const error: unknown = await runOld.then(
      () => {
        throw new Error("expected the previous pairing's page to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия 2", archived: 0, rev: 12 }],
      state: state(12, HOST_ID, OTHER_DEVICE),
    });
  });

  it("wipes the copies of an earlier pairing with the same host before anything else", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({
        changes: offline,
        local: executor,
        hostId: HOST_ID,
        deviceId: OTHER_DEVICE,
      }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: stamp(HOST_ID, OTHER_DEVICE),
    });
  });

  it("stamps device_id beside a host_id an older build left alone, and starts from zero keeping the copies until a page lands", async () => {
    const { db, executor } = openLocalDb();
    db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Линия 1', 0, 10)").run(
      LINE_1,
    );
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('host_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, ENTITY_SET);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    // The copies stay until a page lands, but nothing ties them to this
    // pairing: without `last_rev` they read as unsynced.
    expect(tables(db).lines).toHaveLength(1);
    expect(tables(db).state).toEqual([
      { key: "device_id", value: DEVICE_ID },
      { key: "entity_set", value: ENTITY_SET },
      { key: "host_id", value: HOST_ID },
    ]);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: DEVICE_ID })).toBe(false);

    const changes = feed({ 0: page(12, [line(LINE_2, 12, "Линия 2")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 12 }]);
    expect(tables(db).state).toEqual(state(12));
  });

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
```

17. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 8 });
    // The `host_id` stamp, then the page: the guard, the wipe (8 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 8 + 6 = 30, within the shell's 32. A ninth entity would make it 33.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 30]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
```

заменить на

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 8 });
    // The pairing stamp (and the drop of a `last_rev` there is none of),
    // then the page: the guard, the wipe (8 copy tables, the quarantine, the
    // sync state), per entity one delete and one upsert, the quarantine
    // upsert, the quarantine lift and the sync state: 3 × 8 + 6 = 30, within
    // the shell's 32. A ninth entity would make it 33.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([2, 30]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
```

18. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last. `hostGuard` lets it through:
    // the new pairing stamped the same `host_id`.
    resolve?.(page(30, [operator(ANNA, 25, "0042"), badge(PASS_7, 25, ANNA)]));
```

заменить на

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last. Here the new pairing kept the
    // same device id, so `pairingGuard` lets it through (a real re-pair gets
    // a new one, and the guard stops the page): the quarantine's own guard
    // is what keeps the older records out.
    resolve?.(page(30, [operator(ANNA, 25, "0042"), badge(PASS_7, 25, ANNA)]));
```

19. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    // nothing quarantined to lift; only the sync state is written.
    expect(recorded.batches).toEqual([[1, 0, 0, 0, 0, 0, 0, 0, 3]]);
  });
```

заменить на

<!-- prettier-ignore -->
```ts
    // nothing quarantined to lift; only the sync state is written.
    expect(recorded.batches).toEqual([[2, 0, 0, 0, 0, 0, 0, 0, 4]]);
  });
```

20. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 3 });
    // The forgotten pairing's page lands last. `hostGuard` lets it through:
    // the new pairing stamped the same `host_id`.
    resolve?.(page(30, [product(MILK, 25), template(BOX_58, 25), categoryDefault(8, "box", 25)]));
```

заменить на

<!-- prettier-ignore -->
```ts
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 3 });
    // The forgotten pairing's page lands last. Here the new pairing kept the
    // same device id, so `pairingGuard` lets it through (a real re-pair gets
    // a new one, and the guard stops the page): the quarantine's own guard
    // is what keeps the older records out.
    resolve?.(page(30, [product(MILK, 25), template(BOX_58, 25), categoryDefault(8, "box", 25)]));
```

21. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    // lift and the sync state: one batch, one JSON parameter per entity.
    expect(recorded.batches).toEqual([[1, 5000, 1, 0, 3]]);
    expect({ ...db.prepare("SELECT count(*) AS n FROM ref_products").get() }).toEqual({ n: 5000 });
```

заменить на

<!-- prettier-ignore -->
```ts
    // lift and the sync state: one batch, one JSON parameter per entity.
    expect(recorded.batches).toEqual([[2, 5000, 1, 0, 4]]);
    expect({ ...db.prepare("SELECT count(*) AS n FROM ref_products").get() }).toEqual({ n: 5000 });
```

22. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1"]));
    expect(host.getChanges).toHaveBeenCalledWith(0);
```

заменить на

<!-- prettier-ignore -->
```tsx
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1"]));
    expect(host.getChanges).toHaveBeenCalledWith(0);
    // The copies are bound to this pairing, not only to its host.
    expect({
      ...db.prepare("SELECT value FROM sync_state WHERE key = 'device_id'").get(),
    }).toEqual({ value: DEVICE_STATUS.deviceId });
```

23. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('host_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, ENTITY_SET);
    const host = fakeHost();
```

заменить на

<!-- prettier-ignore -->
```tsx
    db.prepare(
      "INSERT INTO sync_state (key, value) " +
        "VALUES ('last_rev', '10'), ('host_id', ?), ('device_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, DEVICE_STATUS.deviceId, ENTITY_SET);
    const host = fakeHost();
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/app.test.tsx`
Expected: FAIL — 2 файла, `Tests  25 failed | 103 passed (128)`. В `reference-sync.test.ts` 24: в `sync_state` нет строки `device_id` (`expected [ { key: 'entity_set', …(1) }, …(2) ] to deeply equal [ { key: 'device_id', …(1) }, …(3) ]` и такие же сравнения таблиц), `TypeError: copiesReady is not a function` (2), страница прежнего подключения проходит (`Error: expected the previous pairing's page to fail`), прежние копии не стёрты и прогон продолжает с их ревизии (`expected "vi.fn()" to be called with arguments: [ +0 ]`, 2), охрана трогает одну строку (`expected [ [ 1, +0, +0, +0, +0, 3 ] ] to deeply equal [ [ 2, +0, +0, +0, +0, 4 ] ]`, `expected [ 1, 30 ] to deeply equal [ 2, 30 ]`). В `app.test.tsx` 1: `expected {} to deeply equal { Object (value) }` — строки `device_id` нет.

- [ ] **Step 3: Охрана порции подключением**

1. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId: string;
  /** Unix milliseconds for `sync_quarantine.seen_at`; this computer's clock unless a test pins it. */
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId: string;
  /**
   * This pairing (`DeviceStatus.deviceId`): the host gives every pairing a new
   * device id, a re-pair with the same host included, so the copies, and every
   * page that may write them, are bound to it as well as to the host.
   */
  deviceId: string;
  /** Unix milliseconds for `sync_quarantine.seen_at`; this computer's clock unless a test pins it. */
```

2. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one, but a stale run can: a page fetched before
 * `device_forget` that lands only after a new pairing with the same host has
 * stamped `host_id` again, when `hostGuard` no longer stops it. Operators and
 * their badges carry it, since an older record would bring back access, and
```

заменить на

<!-- prettier-ignore -->
```ts
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one; a stale run's page could, before `pairingGuard`
 * bound every page to its pairing (plan 1f), and this stays as a second line
 * of defence for whatever else might write an older record. Operators and
 * their badges carry it, since an older record would bring back access, and
```

3. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
const WRITE_STATE =
  "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?), ('host_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";
```

заменить на

<!-- prettier-ignore -->
```ts
const WRITE_STATE =
  "INSERT INTO sync_state (key, value) " +
  "VALUES ('last_rev', ?), ('host_id', ?), ('device_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";
```

4. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
/**
 * Stamps only `host_id`, with no `last_rev`: the immediate wipe for a new
 * host (`syncReferences`) must leave the copies looking unsynced, so
 * `readState` still starts the next page from zero and a stale in-flight
 * run for the old host is still caught by `hostGuard` below.
 */
const WRITE_HOST_ID =
  "INSERT INTO sync_state (key, value) VALUES ('host_id', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Aborts the batch (`changes_mismatch`) unless `sync_state.host_id` is still
 * stamped to `hostId`. Two things can make it not be, since a run's request
 * can stay in flight for up to 10 s after either happens:
 * - a re-pair repoints `host_id` to another host (`SyncScheduler.stop` does
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * Stamps only the pairing — `host_id` and `device_id` — with no `last_rev`:
 * the immediate wipe for another pairing (`syncReferences`) must leave the
 * copies looking unsynced, so `readState` still starts the next page from
 * zero and a stale in-flight run for the old pairing is still caught by
 * `pairingGuard` below.
 */
const WRITE_PAIRING =
  "INSERT INTO sync_state (key, value) VALUES ('host_id', ?), ('device_id', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** Makes the copies read as unsynced: `readState` then starts from zero. */
const DROP_LAST_REV = "DELETE FROM sync_state WHERE key = 'last_rev'";

/**
 * Aborts the batch (`changes_mismatch`) unless `sync_state` is still stamped
 * to this run's pairing: `host_id` to `hostId` and `device_id` to `deviceId`,
 * both rows touched. Three things can make it not be, since a run's request
 * can stay in flight for up to 10 s after any of them happens:
 * - a re-pair repoints `host_id` to another host (`SyncScheduler.stop` does
```

5. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
 *   host's org and site data;
 * - `device_forget`'s `clear_copies` deletes the `host_id` row along with
 *   every other row, so a page fetched before the forget and committed
 *   after the clear would otherwise find nothing to conflict with and
 *   rewrite the old pairing's copies into a device that was told to forget
 *   them.
 *
 * Every run stamps `host_id` to its own `hostId` before its first fetch: two
 * of the three branches of `syncReferences` (below) write that stamp
 * themselves (a re-pair, or this device's very first sync); the third, the
 * continuing branch, writes nothing and instead requires the stamp a
 * previous run already left to still read `hostId`, so a well-behaved run
 * always satisfies this guard. Placed first in every batch: a `DELETE FROM
 * sync_state` later in the same batch would remove the `host_id` row this
 * statement reads.
 */
function hostGuard(hostId: string): LocalStatement {
  return {
    sql: "UPDATE sync_state SET value = value WHERE key = 'host_id' AND value = ?",
    values: [hostId],
    expectedChanges: 1,
  };
```

заменить на

<!-- prettier-ignore -->
```ts
 *   host's org and site data;
 * - `device_forget`'s `clear_copies` deletes the `host_id` and `device_id`
 *   rows along with every other row, so a page fetched before the forget and
 *   committed after the clear would otherwise find nothing to conflict with
 *   and rewrite the old pairing's copies into a device that was told to
 *   forget them;
 * - a forget followed by a new pairing with the same host stamps `host_id`
 *   to the same value again, but `device_id` to the new pairing's: the old
 *   pairing's late page would otherwise pass, bring back a record a
 *   tombstone of the new run deleted (a turned-off operator, a revoked
 *   badge) and move `last_rev` back. The station's sign-in reads these
 *   copies (plan 1f), so this guard is its precondition.
 *
 * Every run stamps its pairing before its first fetch: two of the three
 * branches of `syncReferences` (below) write that stamp themselves (another
 * pairing, or no complete stamp yet); the third, the continuing branch,
 * writes nothing and instead requires the stamp a previous run already left
 * to still read this pairing, so a well-behaved run always satisfies this
 * guard. Placed first in every batch: a `DELETE FROM sync_state` later in the
 * same batch would remove the rows this statement reads.
 */
function pairingGuard(hostId: string, deviceId: string): LocalStatement {
  return {
    sql:
      "UPDATE sync_state SET value = value " +
      "WHERE (key = 'host_id' AND value = ?) OR (key = 'device_id' AND value = ?)",
    values: [hostId, deviceId],
    expectedChanges: 2,
  };
```

6. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId: string | null;
  entitySet: string | null;
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId: string | null;
  deviceId: string | null;
  entitySet: string | null;
```

7. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
    hostId: value("host_id"),
    entitySet: value("entity_set"),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
    hostId: value("host_id"),
    deviceId: value("device_id"),
    entitySet: value("entity_set"),
  };
}

/** A pairing: the host and the device id it gave this device (`DeviceStatus`). */
export interface Pairing {
  hostId: string;
  deviceId: string;
}

/**
 * Whether the copies are this pairing's and complete: a run for this host
 * and this device id, with this build's entity set, applied its last page.
 * Not whether they are fresh — the host may have been away since — but the
 * station reads nothing else (offline first). Before the first sync of a
 * pairing, after a forget, after a wipe for another pairing and while a
 * build with another entity set has not yet applied its first page, the
 * answer is no.
 */
export async function copiesReady(local: LocalExecutor, pairing: Pairing): Promise<boolean> {
  const stored = await readState(local);
  return (
    stored.hostId === pairing.hostId &&
    stored.deviceId === pairing.deviceId &&
    stored.entitySet === ENTITY_SET &&
    stored.lastRev !== null
  );
}
```

8. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
```

заменить на

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `pairingGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
```

9. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

заменить на

<!-- prettier-ignore -->
```ts
 */
function pageStatements(page: ChangesResponse, pairing: Pairing, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

10. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  }
  statements.push({ sql: WRITE_STATE, values: [String(page.rev), hostId, ENTITY_SET] });
  return statements;
```

заменить на

<!-- prettier-ignore -->
```ts
  }
  statements.push({
    sql: WRITE_STATE,
    values: [String(page.rev), pairing.hostId, pairing.deviceId, ENTITY_SET],
  });
  return statements;
```

11. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId,
  now = () => Date.now(),
}: SyncOptions): Promise<SyncResult> {
  const stored = await readState(local);
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId,
  deviceId,
  now = () => Date.now(),
}: SyncOptions): Promise<SyncResult> {
  const pairing: Pairing = { hostId, deviceId };
  const stamp: LocalStatement = { sql: WRITE_PAIRING, values: [hostId, deviceId] };
  const stored = await readState(local);
```

12. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  let wipe = false;
  if (stored.hostId !== null && stored.hostId !== hostId) {
    // Copies from a pairing with another host must not stay usable while
    // this host is out of reach. No `last_rev` is written, so the copies
    // still read as unsynced afterwards (start from zero next time too),
    // and a stale in-flight run for the old host is still caught below by
    // `hostGuard`, bound to that old host's id, once it reaches its batch.
    await local.transaction([...WIPE, { sql: WRITE_HOST_ID, values: [hostId] }]);
  } else if (
    stored.hostId === hostId &&
    stored.entitySet === ENTITY_SET &&
```

заменить на

<!-- prettier-ignore -->
```ts
  let wipe = false;
  if (
    (stored.hostId !== null && stored.hostId !== hostId) ||
    (stored.deviceId !== null && stored.deviceId !== deviceId)
  ) {
    // Copies from another pairing — with another host, or an earlier one
    // with this host — must not stay usable while this host is out of
    // reach. No `last_rev` is written, so the copies still read as unsynced
    // afterwards (start from zero next time too), and a stale in-flight run
    // for the old pairing is still caught below by `pairingGuard`, bound to
    // that pairing, once it reaches its batch.
    await local.transaction([...WIPE, stamp]);
  } else if (
    stored.hostId === hostId &&
    stored.deviceId === deviceId &&
    stored.entitySet === ENTITY_SET &&
```

13. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
  } else {
    if (stored.hostId === null) {
      // No pairing recorded yet: there are never copies without a `host_id`,
      // so there is nothing to wipe, but the stamp itself cannot wait for
      // the first page. Without it, a concurrent first sync for a different
      // host that also reads no `host_id` takes this same branch, and
      // whichever of the two pages commits first passes `hostGuard` (it
      // finds no row to compare against) while the other — even though it
      // may be the pairing that is actually current — then fails its own
      // guard against the first one's stamp. Stamping up front means every
      // ordering has a `host_id` row in place before either page can land.
      await local.transaction([{ sql: WRITE_HOST_ID, values: [hostId] }]);
    }
```

заменить на

<!-- prettier-ignore -->
```ts
  } else {
    if (stored.hostId === null || stored.deviceId === null) {
      // No complete stamp yet — this device's very first sync, or a state
      // an older build left with `host_id` alone — and the stamp cannot
      // wait for the first page. Without it, a concurrent first sync for a
      // different pairing that also reads no stamp takes this same branch,
      // and whichever of the two pages commits first passes `pairingGuard`
      // (it finds no rows to compare against) while the other — even though
      // it may be the pairing that is actually current — then fails its own
      // guard against the first one's stamp. Stamping up front means every
      // ordering has both rows in place before either page can land. The
      // older build's `last_rev` goes with it: copies nobody can tie to this
      // pairing must read as unsynced (`copiesReady`) until the first page
      // replaces them, and the next run must not continue from them.
      await local.transaction([stamp, { sql: DROP_LAST_REV }]);
    }
```

14. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```ts
    }
    const statements = pageStatements(page, hostId, now());
    const batch = wipe
      ? [hostGuard(hostId), ...WIPE, ...statements]
      : [hostGuard(hostId), ...statements];
    await local.transaction(batch);
```

заменить на

<!-- prettier-ignore -->
```ts
    }
    const statements = pageStatements(page, pairing, now());
    const guard = pairingGuard(hostId, deviceId);
    const batch = wipe ? [guard, ...WIPE, ...statements] : [guard, ...statements];
    await local.transaction(batch);
```

15. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId: string | null;
  connection: ConnectionApi;
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId: string | null;
  /** The pairing's device id (`DeviceStatus.deviceId`); `null` exactly when `hostId` is. */
  deviceId: string | null;
  connection: ConnectionApi;
```

16. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostId,
  connection,
```

заменить на

<!-- prettier-ignore -->
```ts
  hostId,
  deviceId,
  connection,
```

17. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
  useEffect(() => {
    if (hostId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
```

заменить на

<!-- prettier-ignore -->
```ts
  useEffect(() => {
    if (hostId === null || deviceId === null) return;
    // Nothing reaches the shell state after the pairing changed or ended.
```

18. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
      try {
        const result = await syncReferences({ changes, local, hostId });
        if (!active) return;
```

заменить на

<!-- prettier-ignore -->
```ts
      try {
        const result = await syncReferences({ changes, local, hostId, deviceId });
        if (!active) return;
```

19. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```ts
    };
  }, [hostId, connection, local, changes, refresh, dispatch]);
  return useCallback(() => syncNow.current(), []);
```

заменить на

<!-- prettier-ignore -->
```ts
    };
  }, [hostId, deviceId, connection, local, changes, refresh, dispatch]);
  return useCallback(() => syncNow.current(), []);
```

20. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx

  const requestSync = useHostLink({
    hostId:
      pairedStatus !== null && state.rejection === null && state.sync.kind !== "other_host"
        ? pairedStatus.hostId
        : null,
    connection: connectionApi,
```

заменить на

<!-- prettier-ignore -->
```tsx

  const linked =
    pairedStatus !== null && state.rejection === null && state.sync.kind !== "other_host"
      ? pairedStatus
      : null;
  const requestSync = useHostLink({
    hostId: linked?.hostId ?? null,
    deviceId: linked?.deviceId ?? null,
    connection: connectionApi,
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/app.test.tsx`
Expected: PASS — 2 файла, 128 тестов (`reference-sync` 62, `app` 66).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/reference-sync.test.ts test/app.test.tsx`
Expected: PASS, 128; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 128; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/local/reference-sync.ts` охранять порцию одним хостом (второе условие никогда не совпадает, и охрана ждёт одну строку): фрагмент

<!-- prettier-ignore -->
```ts
    values: [hostId, deviceId],
    expectedChanges: 2,
```

заменить на

<!-- prettier-ignore -->
```ts
    values: [hostId, hostId],
    expectedChanges: 1,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "previous pairing with the same host"`
Expected: FAIL — `× fails a page of the previous pairing with the same host that lands after a forget and a new pairing`, `Error: expected the previous pairing's page to fail`.

Мутация 2. В `apps/standalone/src/local/reference-sync.ts` не стирать копии прежнего подключения с тем же хостом: фрагмент

<!-- prettier-ignore -->
```ts
    (stored.hostId !== null && stored.hostId !== hostId) ||
    (stored.deviceId !== null && stored.deviceId !== deviceId)
```

заменить на

<!-- prettier-ignore -->
```ts
    stored.hostId !== null &&
    stored.hostId !== hostId
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "earlier pairing with the same host"`
Expected: FAIL — `× wipes the copies of an earlier pairing with the same host before anything else`, `expected { org: [], site: [], …(2) } to deeply equal { org: [], site: [], lines: [], …(1) }`.

Мутация 3. В `apps/standalone/src/local/reference-sync.ts` ставить метку, не убирая `last_rev` более старой сборки: фрагмент

<!-- prettier-ignore -->
```ts
      await local.transaction([stamp, { sql: DROP_LAST_REV }]);
```

заменить на

<!-- prettier-ignore -->
```ts
      await local.transaction([stamp]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "older build left alone"`
Expected: FAIL — `× stamps device_id beside a host_id an older build left alone, and starts from zero keeping the copies until a page lands`, `expected [ { key: 'device_id', …(1) }, …(3) ] to deeply equal [ { key: 'device_id', …(1) }, …(2) ]` (`last_rev` остался).

Мутация 4. В `apps/standalone/src/local/reference-sync.ts` считать копии своими при любом идентификаторе устройства: удалить фрагмент

<!-- prettier-ignore -->
```ts
    stored.deviceId === pairing.deviceId &&
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "copiesReady"`
Expected: FAIL — `× answers yes only after this pairing's own run applied its last page`, `expected true to be false`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/local/reference-sync.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/support/fixtures.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/app.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 59 файлов, 1423 теста (1418 + 5: `reference-sync` +5).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/local/reference-sync.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/test/support/fixtures.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/app.test.tsx
git commit -m "fix(standalone): копии справочников привязаны к подключению, а не только к хосту" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Проверка PIN и бейджа по копиям станции (`src/floor/sign-in.ts`)

Модуль без экрана, который отвечает, кого впустить. Табельный номер (3–12 цифр, как хост) должен называть ровно одну копию оператора без записи в карантине; PIN (4–6 цифр) проверяется `verifyPhc` домена — сравнение за постоянное время, число итераций берётся из хеша (синхронизация приняла только 10 000–1 000 000 и только хеш, который `isPinPhc` признаёт). Каждая попытка с правильной формой стоит одного полного PBKDF2: неизвестный номер проверяется по фиктивному хешу `DUMMY_PIN_PHC` с `PHC_ITERATIONS` (как `DUMMY_PHC` облачной станции), и время ответа номера не выдаёт. После проверки копия оператора читается снова: смена PIN или выключение, пришедшие за эти миллисекунды, побеждают. Скан сначала разбирается (`readBadgeScan`): разделитель групп GS1 — код товара, кириллица — раскладка, не 1–256 печатных ASCII после обрезки — не бейдж; ничего из этого не хешируется. Бейдж хешируется один раз солью `ref_site` и ровно `BADGE_ITERATIONS` (`hashBadge`), строка сравнивается целиком, бейдж впускает только вместе с копией своего оператора, бейдж двух операторов отвергается как неоднозначный. Пока копии не принадлежат этому подключению (`copiesReady`) или у площадки нет соли, ответ — `not_ready`. `readFloorReadiness` даёт экрану (задача 5) число операторов, которые могут войти. Модуль ничего не пишет в консоль и не возвращает ни PIN, ни код, ни хеш. Блокировок в этой задаче нет — их добавляет задача 3.

**Files:**

- Create: `apps/standalone/src/floor/sign-in.ts`
- Test: `apps/standalone/test/floor-sign-in.test.ts` (Create)

**Interfaces:**

- Consumes: `verifyPhc` — `@markiro/domain`; `hashBadge`, `isPinPhc` — `src/lib/credentials.ts`; `hasCyrillic` — `src/host/pairing-code.ts`; `copiesReady`, `type Pairing` — `src/local/reference-sync.ts` (задача 1); `type LocalExecutor` — `src/local/executor.ts`.
- Produces (`src/floor/sign-in.ts`):
  - `interface FloorOperator { id: string; login: string; name: string; role: string | null }`;
  - `type SignInRefusal = "wrong" | "ambiguous" | "not_ready" | "product_code" | "layout" | "not_badge"`;
  - `type SignInResult = { kind: "signed_in"; operator: FloorOperator } | { kind: "refused"; reason: SignInRefusal }` (задача 3 добавит `locked`);
  - `interface SignInContext { local: LocalExecutor; pairing: Pairing }` (задача 3 добавит `now`);
  - `DUMMY_PIN_PHC: string`; `type FloorReadiness = { kind: "not_ready" } | { kind: "ready"; operators: number }`; `readFloorReadiness(context): Promise<FloorReadiness>`;
  - `signInWithPin(context, login: string, pin: string): Promise<SignInResult>`;
  - `type BadgeScan = { kind: "badge"; code: string } | { kind: "refused"; reason: "product_code" | "layout" | "not_badge" }`; `readBadgeScan(raw: string): BadgeScan`; `signInWithBadge(context, raw: string): Promise<SignInResult>`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/floor-sign-in.test.ts`:

<!-- prettier-ignore -->
```ts
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePhc, PHC_ITERATIONS } from "@markiro/domain";

import {
  DUMMY_PIN_PHC,
  readBadgeScan,
  readFloorReadiness,
  signInWithBadge,
  signInWithPin,
  type SignInContext,
} from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import { hashPin, isPinPhc } from "../src/lib/credentials.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const PASS_8 = "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19";
/** The PIN 4821 and the badge «MRK-000742» under `SITE`'s salt, as the office hashed them (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const BADGE_CODE = "MRK-000742";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};

function operator(id: string, rev: number, login: string, data: object = {}): ChangeItem {
  return {
    entity: "operators",
    id,
    rev,
    deleted: false,
    data: { login, name: "Анна Кузнецова", role: "Упаковщик", pinPhc: PIN_PHC, ...data },
  };
}

function badge(id: string, rev: number, operatorId: string): ChangeItem {
  return {
    entity: "operator_badges",
    id,
    rev,
    deleted: false,
    data: { operatorId, badgePhc: BADGE_PHC, label: null },
  };
}

const ANNA_SIGNED_IN = {
  kind: "signed_in",
  operator: { id: ANNA, login: "0042", name: "Анна Кузнецова", role: "Упаковщик" },
};

/** This pairing's copies after one complete sync of `items`. */
async function synced(
  items: ChangeItem[],
  rev = 10,
): Promise<{
  db: DatabaseSync;
  executor: LocalExecutor;
  context: SignInContext;
}> {
  const { db, executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return { db, executor, context: { local: executor, pairing: PAIRING } };
}

describe("the station's PIN sign-in", () => {
  it("signs in the operator whose personnel number and PIN match their copy", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    expect(await signInWithPin(context, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses a wrong PIN and an unknown personnel number alike", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    expect(await signInWithPin(context, "0042", "1111")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithPin(context, "0043", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    // Leading zeros are part of the number: «42» is another number.
    expect(await signInWithPin(context, "042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a malformed personnel number or PIN before reading anything", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    for (const [login, pin] of [
      ["42", "4821"],
      ["0042", "482"],
      ["0042", "4821567"],
      ["0042", "48 1"],
      ["００４２", "4821"],
    ] as const) {
      expect(await signInWithPin(context, login, pin)).toEqual({
        kind: "refused",
        reason: "wrong",
      });
    }
  });

  it("verifies against the PIN copy the host sent last, not an earlier one", async () => {
    const { executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const newPin = await hashPin("7305");
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [operator(ANNA, 11, "0042", { pinPhc: newPin })],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithPin(context, "0042", "7305")).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses an operator the host turned off, once the tombstone reached the copies", async () => {
    const { executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 12,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA, rev: 12, deleted: true }],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("fails closed for an operator whose newer record waits in quarantine", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA);
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a personnel number two copies share instead of choosing one", async () => {
    const { context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0042", { name: "Борис Орлов" }),
    ]);
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("reads nothing until this pairing's own copies are complete", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    // Copies of another pairing with the same host are not this pairing's.
    expect(
      await signInWithPin(
        { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } },
        "0042",
        "4821",
      ),
    ).toEqual({ kind: "refused", reason: "not_ready" });
    // A forget clears every table, `sync_state` included.
    db.prepare("DELETE FROM sync_state").run();
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("refuses when the operator's copy changed while the PIN was being verified", async () => {
    const { db, executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    // A sync lands between the verification and the read that follows it.
    const racing: LocalExecutor = {
      query: (sql, params, row) => {
        if (sql.startsWith("SELECT o.rev ")) {
          db.prepare("UPDATE ref_operators SET rev = 13 WHERE id = ?").run(ANNA);
        }
        return executor.query(sql, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    };
    expect(await signInWithPin({ ...context, local: racing }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("verifies an unknown personnel number against a dummy hash of the domain's work factor", () => {
    expect(isPinPhc(DUMMY_PIN_PHC)).toBe(true);
    expect(parsePhc(DUMMY_PIN_PHC)?.iterations).toBe(PHC_ITERATIONS);
  });
});

describe("the station's badge sign-in", () => {
  it("signs in the badge's operator: the trimmed scan hashed with the site's salt", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
    expect(await signInWithBadge(context, `  ${BADGE_CODE}\t`)).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses an unknown badge and a badge whose operator has no copy", async () => {
    const { context } = await synced([SITE, badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithBadge(context, "MRK-000743")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a revoked badge once its tombstone reached the copies", async () => {
    const { executor, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      badge(PASS_7, 6, ANNA),
    ]);
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 12,
        hasMore: false,
        items: [{ entity: "operator_badges", id: PASS_7, rev: 12, deleted: true }],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a badge that matches two operators as ambiguous, never the first of them", async () => {
    const { context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
      badge(PASS_7, 7, ANNA),
      badge(PASS_8, 8, BORIS),
    ]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("fails closed for a badge whose newer record waits in quarantine", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operator_badges', ?, 9, 'badgePhc: custom', 1790000000000)",
    ).run(PASS_7);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("reads nothing without this pairing's complete copies or without the site's salt", async () => {
    const { context } = await synced([operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
    const other = { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } };
    expect(await signInWithBadge(other, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("tells a product's code, a Cyrillic scan and a non-badge apart before hashing", () => {
    expect(readBadgeScan(" MRK-000742 ")).toEqual({ kind: "badge", code: BADGE_CODE });
    expect(readBadgeScan("0104600682000013215Abc\u001d91EE11")).toEqual({
      kind: "refused",
      reason: "product_code",
    });
    expect(readBadgeScan("ЬКЛ-000742")).toEqual({ kind: "refused", reason: "layout" });
    for (const raw of ["", "   ", "x".repeat(257), "MRK-№742", "MRK\u0007742"]) {
      expect(readBadgeScan(raw)).toEqual({ kind: "refused", reason: "not_badge" });
    }
    expect(readBadgeScan("x".repeat(256))).toEqual({ kind: "badge", code: "x".repeat(256) });
  });

  it("refuses those scans without signing anybody in", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, `${BADGE_CODE}\u001d`)).toEqual({
      kind: "refused",
      reason: "product_code",
    });
    expect(await signInWithBadge(context, "ЬКЛ-000742")).toEqual({
      kind: "refused",
      reason: "layout",
    });
  });
});

describe("the sign-in's secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nothing, whether a sign-in succeeds or not", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    await signInWithPin(context, "0042", "4821");
    await signInWithPin(context, "0042", "1111");
    await signInWithBadge(context, BADGE_CODE);
    await signInWithBadge(context, "MRK-000743");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the sign-in screen's readiness", () => {
  it("offers nothing before this pairing's copies, then counts the operators who may sign in", async () => {
    const { executor } = openLocalDb();
    expect(await readFloorReadiness({ local: executor, pairing: PAIRING })).toEqual({
      kind: "not_ready",
    });
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099"),
    ]);
    expect(await readFloorReadiness(context)).toEqual({ kind: "ready", operators: 2 });
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(BORIS);
    expect(await readFloorReadiness(context)).toEqual({ kind: "ready", operators: 1 });
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts`
Expected: FAIL — 1 файл, `Tests  no tests`: `Failed to resolve import "../src/floor/sign-in.js" from "test/floor-sign-in.test.ts"`.

- [ ] **Step 3: Модуль входа**

1. Создать `apps/standalone/src/floor/sign-in.ts`:

<!-- prettier-ignore -->
```ts
import { verifyPhc } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
import { hashBadge, isPinPhc } from "../lib/credentials.js";
import type { LocalExecutor } from "../local/executor.js";
import { copiesReady, type Pairing } from "../local/reference-sync.js";

// The station's operator sign-in (stage 1 spec §5.6, plan 1f): offline, from
// the local copies of operators and badges only, never a call to the host.
// The PIN and the badge code stay in this module's arguments: nothing here
// logs, keeps or returns them, or a hash of either.

/** An operator signed in on this station: identity only, never a hash. */
export interface FloorOperator {
  id: string;
  /** The personnel number, leading zeros included. */
  login: string;
  name: string;
  role: string | null;
}

/** Why a sign-in did not go through. */
export type SignInRefusal =
  /** No operator matches: a wrong PIN, an unknown personnel number, an unknown badge. */
  | "wrong"
  /** The badge, or the personnel number, matches more than one operator. */
  | "ambiguous"
  /** The copies are not this pairing's complete copies, or have no badge salt. */
  | "not_ready"
  /** The scan holds a GS1 group separator: a product's code, not a badge. */
  | "product_code"
  /** The scan arrived in Cyrillic: the keyboard layout is Russian. */
  | "layout"
  /** The scan cannot be a badge code: empty, longer than 256 or not printable ASCII. */
  | "not_badge";

export type SignInResult =
  { kind: "signed_in"; operator: FloorOperator } | { kind: "refused"; reason: SignInRefusal };

export interface SignInContext {
  local: LocalExecutor;
  /** The pairing whose copies the station reads (`DeviceStatus`). */
  pairing: Pairing;
}

/** A personnel number as the host keeps it: 3–12 ASCII digits (`operatorLoginRule`). */
const LOGIN = /^[0-9]{3,12}$/;
/** A PIN as the office takes it: 4–6 ASCII digits (`pinRule`). */
const PIN = /^[0-9]{4,6}$/;
/** A badge code as the office takes it: 1–256 printable ASCII characters (`badgeCodeRule`). */
const BADGE_CODE = /^[ -~]{1,256}$/;
/** The GS1 group separator a product's DataMatrix carries between its fields. */
const GROUP_SEPARATOR = "\u001d";

/**
 * A verifier no PIN is known to match, with the domain's 100 000 iterations:
 * an unknown personnel number still costs one full PBKDF2, as a known one
 * with a wrong PIN does, so the time of the answer does not tell them apart
 * (the cloud station's `DUMMY_PIN_PHC`).
 */
export const DUMMY_PIN_PHC =
  "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=";

/** A copy's operator may sign in only while no newer record of it waits in quarantine. */
const NOT_QUARANTINED_OPERATOR =
  "NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
  "WHERE q.entity = 'operators' AND q.id = o.id)";

const OPERATOR_BY_LOGIN =
  "SELECT o.id, o.login, o.name, o.role, o.pin_phc AS pinPhc, o.rev " +
  `FROM ref_operators AS o WHERE o.login = ? AND ${NOT_QUARANTINED_OPERATOR}`;

const OPERATOR_REV = `SELECT o.rev FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * The operators a badge hash signs in: the badge's own record and its
 * operator's, neither waiting in quarantine. A badge never signs in on its
 * own: without its operator's copy it matches nobody.
 */
const BADGE_HOLDERS =
  "SELECT DISTINCT o.id, o.login, o.name, o.role " +
  "FROM ref_operator_badges AS b JOIN ref_operators AS o ON o.id = b.operator_id " +
  "WHERE b.badge_phc = ? AND NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
  `WHERE q.entity = 'operator_badges' AND q.id = b.id) AND ${NOT_QUARANTINED_OPERATOR}`;

const SITE_SALT = "SELECT badge_salt AS badgeSalt FROM ref_site";

const OPERATOR_COUNT = `SELECT count(*) AS n FROM ref_operators AS o WHERE ${NOT_QUARANTINED_OPERATOR}`;

const operatorRow = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string(),
  role: z.string().nullable(),
});
const credentialRow = operatorRow.extend({ pinPhc: z.string(), rev: z.number().int() });
const revRow = z.object({ rev: z.number().int() });
const saltRow = z.object({ badgeSalt: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

function refused(reason: SignInRefusal): SignInResult {
  return { kind: "refused", reason };
}

function signedIn({ id, login, name, role }: FloorOperator): SignInResult {
  return { kind: "signed_in", operator: { id, login, name, role } };
}

/**
 * What the sign-in screen can offer: nothing until this pairing's copies are
 * complete (`copiesReady`), then how many operators may sign in.
 */
export type FloorReadiness = { kind: "not_ready" } | { kind: "ready"; operators: number };

export async function readFloorReadiness(context: SignInContext): Promise<FloorReadiness> {
  if (!(await copiesReady(context.local, context.pairing))) return { kind: "not_ready" };
  const [count] = await context.local.query(OPERATOR_COUNT, [], countRow);
  return { kind: "ready", operators: count?.n ?? 0 };
}

/**
 * A personnel number and a PIN against the copies. Exactly one operator must
 * have the number, and the PIN must match the hash of that operator's copy
 * (`verifyPhc`, which compares in constant time, with the count the hash
 * carries, which the sync accepted only within 10 000–1 000 000). Every
 * attempt with a well-formed number and PIN runs one full PBKDF2, the dummy
 * one for an unknown number. The operator's copy is read again after the
 * verification: a PIN change or a deactivation that landed meanwhile wins.
 */
export async function signInWithPin(
  context: SignInContext,
  login: string,
  pin: string,
): Promise<SignInResult> {
  if (!LOGIN.test(login) || !PIN.test(pin)) return refused("wrong");
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const rows = await local.query(OPERATOR_BY_LOGIN, [login], credentialRow);
  const [only] = rows;
  const operator = rows.length === 1 && only !== undefined && isPinPhc(only.pinPhc) ? only : null;
  const matched = await verifyPhc(pin, operator?.pinPhc ?? DUMMY_PIN_PHC);
  if (rows.length > 1) return refused("ambiguous");
  if (!matched || operator === null) return refused("wrong");
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const [current] = await local.query(OPERATOR_REV, [operator.id], revRow);
  if (current?.rev !== operator.rev) return refused("wrong");
  return signedIn(operator);
}

/**
 * What a scan is, before anything is hashed: a badge code (trimmed, as
 * `badgeCodeRule` trims it), or why it cannot be one. A product's code (a
 * GS1 group separator in it), a scan in Cyrillic (the Russian layout; never
 * read by key position) and anything else no badge could be never reach the
 * hash.
 */
export type BadgeScan =
  | { kind: "badge"; code: string }
  | { kind: "refused"; reason: "product_code" | "layout" | "not_badge" };

export function readBadgeScan(raw: string): BadgeScan {
  if (raw.includes(GROUP_SEPARATOR)) return { kind: "refused", reason: "product_code" };
  const code = raw.trim();
  if (hasCyrillic(code)) return { kind: "refused", reason: "layout" };
  if (!BADGE_CODE.test(code)) return { kind: "refused", reason: "not_badge" };
  return { kind: "badge", code };
}

/**
 * A scanned badge against the copies: the trimmed code hashed once with the
 * site's salt and exactly `BADGE_ITERATIONS` (`hashBadge`), and that whole
 * string compared with the badges' hashes. The badge signs in only with its
 * operator's copy, and a badge that matches more than one operator is
 * refused as ambiguous, never resolved to the first.
 */
export async function signInWithBadge(context: SignInContext, raw: string): Promise<SignInResult> {
  const scan = readBadgeScan(raw);
  if (scan.kind === "refused") return refused(scan.reason);
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const salts = await local.query(SITE_SALT, [], saltRow);
  const [site] = salts;
  if (salts.length !== 1 || site === undefined) return refused("not_ready");
  const phc = await hashBadge(scan.code, site.badgeSalt);
  const holders = await local.query(BADGE_HOLDERS, [phc], operatorRow);
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  if (holders.length > 1) return refused("ambiguous");
  const [holder] = holders;
  if (holder === undefined) return refused("wrong");
  return signedIn(holder);
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts`
Expected: PASS — 1 файл, 20 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-sign-in.test.ts`
Expected: PASS, 20; stderr пуст.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/floor/sign-in.ts` впускать первого из операторов неоднозначного бейджа: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (holders.length > 1) return refused("ambiguous");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "matches two operators"`
Expected: FAIL — `× refuses a badge that matches two operators as ambiguous, never the first of them`, `expected { kind: 'signed_in', …(1) } to deeply equal { Object (kind, reason) }`.

Мутация 2. В `apps/standalone/src/floor/sign-in.ts` не узнавать код товара: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (raw.includes(GROUP_SEPARATOR)) return { kind: "refused", reason: "product_code" };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "apart before hashing"`
Expected: FAIL — `× tells a product's code, a Cyrillic scan and a non-badge apart before hashing`, `expected { Object (kind, reason) } to deeply equal { kind: 'refused', …(1) }` (код товара читается как «не бейдж»).

Мутация 3. В `apps/standalone/src/floor/sign-in.ts` не обрезать скан: фрагмент

<!-- prettier-ignore -->
```ts
  const code = raw.trim();
```

заменить на

<!-- prettier-ignore -->
```ts
  const code = raw;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "trimmed scan hashed"`
Expected: FAIL — `× signs in the badge's operator: the trimmed scan hashed with the site's salt`, `expected { Object (kind, reason) } to deeply equal { kind: 'signed_in', …(1) }`.

Мутация 4. В `apps/standalone/src/floor/sign-in.ts` не перечитывать копию оператора после проверки PIN: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (current?.rev !== operator.rev) return refused("wrong");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "changed while the PIN"`
Expected: FAIL — `× refuses when the operator's copy changed while the PIN was being verified`, `expected { kind: 'signed_in', …(1) } to deeply equal { kind: 'refused', reason: 'wrong' }`.

Мутация 5. В `apps/standalone/src/floor/sign-in.ts` впускать по бейджу, чья более новая запись ждёт в карантине: фрагмент

<!-- prettier-ignore -->
```ts
  "WHERE b.badge_phc = ? AND NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
  `WHERE q.entity = 'operator_badges' AND q.id = b.id) AND ${NOT_QUARANTINED_OPERATOR}`;
```

заменить на

<!-- prettier-ignore -->
```ts
  `WHERE b.badge_phc = ? AND ${NOT_QUARANTINED_OPERATOR}`;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "badge whose newer record"`
Expected: FAIL — `× fails closed for a badge whose newer record waits in quarantine`, `expected { kind: 'signed_in', …(1) } to deeply equal { kind: 'refused', reason: 'wrong' }`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/sign-in.ts apps/standalone/test/floor-sign-in.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 60 файлов, 1443 теста (1423 + 20).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/floor/sign-in.ts apps/standalone/test/floor-sign-in.test.ts
git commit -m "feat(standalone): проверка PIN и бейджа оператора по копиям станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Блокировки после неудачных попыток (`src/floor/lockout.ts`, миграция `0005`)

Неудачи и блокировки хранятся в локальной базе, чтобы перезапуск не сбрасывал их: миграция `src-tauri/migrations/0005_floor_sign_in_failures.sql` создаёт `floor_sign_in_failures(key, failures, locked_at)` — строку станции (`station`) и строку оператора по его идентификатору (`operator:<id>`). `recordFailure` считает неудачу одним оператором `INSERT … ON CONFLICT DO UPDATE` (SQLite вычисляет все выражения `SET` по прежней строке) и начинает блокировку на неудаче, которая достигла предела; после истёкшей блокировки отсчёт начинается с единицы. `lockRemainingMs` отвечает, сколько осталось; часы, отведённые назад за начало блокировки, начинают её заново от «сейчас» (запись), но не дольше длительности. `clearFailures` после удачного входа забывает неудачи станции и этого оператора. `signInWithPin` и `signInWithBadge` (задача 2) спрашивают блокировку станции до любого хеширования, PIN — ещё и блокировку оператора с этим номером; неверный PIN считается против станции и оператора, неизвестный номер и неизвестный бейдж — против станции; ответ — `locked` с оставшимся временем, если попытка начала блокировку (станция раньше оператора). Бейдж оператора с заблокированным PIN впускает. `SignInContext` получает часы `now`. Таблица — первые данные самого устройства, но одноразовые: `clear_copies` очищает каждую таблицу, и это решение фиксируют список таблиц в `src-tauri/tests/local_db.rs` и `test/local-executor.test.ts` и комментарий `LocalDb::clear_copies`.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0005_floor_sign_in_failures.sql`, `apps/standalone/src/floor/lockout.ts`
- Modify: `apps/standalone/src/floor/sign-in.ts`, `apps/standalone/src-tauri/src/local_db.rs` (комментарий `clear_copies`)
- Test: `apps/standalone/test/floor-lockout.test.ts` (Create), `apps/standalone/test/floor-sign-in.test.ts`, `apps/standalone/test/local-executor.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs` (Modify)

**Interfaces:**

- Consumes: задача 2 (`sign-in.ts`), `type LocalExecutor`.
- Produces:
  - `lockout.ts`: `interface LockoutPolicy { limit: number; durationMs: number }`, `STATION_LOCKOUT = { limit: 10, durationMs: 60_000 }`, `OPERATOR_LOCKOUT = { limit: 5, durationMs: 300_000 }`, ``type LockoutKey = "station" | `operator:${string}` ``, `operatorKey(operatorId): LockoutKey`, `lockRemainingMs(local, key, policy, now: number): Promise<number>`, `recordFailure(local, key, policy, now: number): Promise<number>`, `clearFailures(local, operatorId): Promise<void>`;
  - `sign-in.ts`: `SignInResult` получает `{ kind: "locked"; scope: "station" | "operator"; remainingMs: number }`; `SignInContext.now: () => number`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/floor-lockout.test.ts`:

<!-- prettier-ignore -->
```ts
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  clearFailures,
  lockRemainingMs,
  OPERATOR_LOCKOUT,
  operatorKey,
  recordFailure,
  STATION_LOCKOUT,
} from "../src/floor/lockout.js";
import { openLocalDb } from "./support/local-db.js";

const NOW = 1_790_000_000_000;
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const POLICY = { limit: 3, durationMs: 60_000 };

function rows(db: DatabaseSync) {
  const sql = "SELECT key, failures, locked_at FROM floor_sign_in_failures ORDER BY key";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

describe("sign-in lockouts", () => {
  it("names the policies: ten failures pause the station for a minute, five lock a PIN for five", () => {
    expect(STATION_LOCKOUT).toEqual({ limit: 10, durationMs: 60_000 });
    expect(OPERATOR_LOCKOUT).toEqual({ limit: 5, durationMs: 300_000 });
    expect(operatorKey(ANNA)).toBe(`operator:${ANNA}`);
  });

  it("counts failures and starts a lockout at the limit, for its whole duration", async () => {
    const { db, executor } = openLocalDb();
    expect(await recordFailure(executor, "station", POLICY, NOW)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, NOW + 1)).toBe(0);
    expect(rows(db)).toEqual([{ key: "station", failures: 2, locked_at: null }]);
    expect(await recordFailure(executor, "station", POLICY, NOW + 2)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 3, locked_at: NOW + 2 }]);

    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 2)).toBe(60_000);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 40_002)).toBe(20_000);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 60_001)).toBe(1);
    expect(await lockRemainingMs(executor, "station", POLICY, NOW + 60_002)).toBe(0);
  });

  it("allows the same number of tries again after a lockout ran out", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    const later = NOW + 60_000;
    expect(await lockRemainingMs(executor, "station", POLICY, later)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, later)).toBe(0);
    expect(rows(db)).toEqual([{ key: "station", failures: 1, locked_at: null }]);
    expect(await recordFailure(executor, "station", POLICY, later)).toBe(0);
    expect(await recordFailure(executor, "station", POLICY, later + 5)).toBe(60_000);
  });

  it("starts a lockout again from now when this computer's clock went back behind it", async () => {
    const { db, executor } = openLocalDb();
    for (let failure = 0; failure < 3; failure += 1) {
      await recordFailure(executor, "station", POLICY, NOW);
    }
    // The clock went back a day: still locked, for no more than the duration.
    const earlier = NOW - 86_400_000;
    expect(await lockRemainingMs(executor, "station", POLICY, earlier)).toBe(60_000);
    expect(rows(db)).toEqual([{ key: "station", failures: 3, locked_at: earlier }]);
    expect(await lockRemainingMs(executor, "station", POLICY, earlier + 60_000)).toBe(0);
  });

  it("keeps each operator's count apart from the station's and from the other operators'", async () => {
    const { db, executor } = openLocalDb();
    await recordFailure(executor, "station", POLICY, NOW);
    await recordFailure(executor, operatorKey(ANNA), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    await recordFailure(executor, operatorKey(BORIS), POLICY, NOW);
    expect(rows(db)).toEqual([
      { key: `operator:${BORIS}`, failures: 2, locked_at: null },
      { key: `operator:${ANNA}`, failures: 1, locked_at: null },
      { key: "station", failures: 1, locked_at: null },
    ]);

    // A sign-in forgets the station's failures and that operator's only.
    await clearFailures(executor, ANNA);
    expect(rows(db)).toEqual([{ key: `operator:${BORIS}`, failures: 2, locked_at: null }]);
  });
});
```

2. В `apps/standalone/test/floor-sign-in.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
```

заменить на

<!-- prettier-ignore -->
```ts
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
/** This computer's clock in the tests: the lockouts read it. */
const NOW = 1_790_000_000_000;
```

3. В `apps/standalone/test/floor-sign-in.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  });
  return { db, executor, context: { local: executor, pairing: PAIRING } };
}
```

заменить на

<!-- prettier-ignore -->
```ts
  });
  return { db, executor, context: { local: executor, pairing: PAIRING, now: () => NOW } };
}
```

4. В `apps/standalone/test/floor-sign-in.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

describe("the sign-in's secrets", () => {
```

заменить на

<!-- prettier-ignore -->
```ts

describe("the sign-in's lockouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failures(db: DatabaseSync) {
    const sql = "SELECT key, failures, locked_at FROM floor_sign_in_failures ORDER BY key";
    return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  }

  it("locks an operator's PIN after five wrong ones, answers the sixth without hashing, and keeps the badge working", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await signInWithPin(context, "0042", "1111")).toEqual({
        kind: "refused",
        reason: "wrong",
      });
    }
    expect(await signInWithPin(context, "0042", "1111")).toEqual({
      kind: "locked",
      scope: "operator",
      remainingMs: 300_000,
    });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "locked",
      scope: "operator",
      remainingMs: 300_000,
    });
    expect(derive).not.toHaveBeenCalled();
    // Another credential: the badge still signs Anna in, and forgets the count.
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
    expect(failures(db)).toEqual([]);
  });

  it("pauses the whole station after ten failures of any kind, before hashing anything", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    let clock = NOW;
    const ticking = { ...context, now: () => clock };
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 1;
      const result =
        attempt % 2 === 0
          ? await signInWithPin(ticking, `00${50 + attempt}`, "4821")
          : await signInWithBadge(ticking, `MRK-${attempt}`);
      expect(result).toEqual({ kind: "refused", reason: "wrong" });
    }
    clock += 1;
    expect(await signInWithBadge(ticking, "MRK-999")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 60_000,
    });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    clock += 30_000;
    expect(await signInWithPin(ticking, "0042", "4821")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 30_000,
    });
    expect(await signInWithBadge(ticking, BADGE_CODE)).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 30_000,
    });
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();

    clock += 30_000;
    expect(await signInWithPin(ticking, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
    expect(failures(db)).toEqual([]);
  });

  it("counts only guesses: not a malformed entry, a product's code, a Cyrillic scan or an ambiguous badge", async () => {
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
      badge(PASS_7, 7, ANNA),
      badge(PASS_8, 8, BORIS),
    ]);
    await signInWithPin(context, "42", "4821");
    await signInWithBadge(context, `${BADGE_CODE}`);
    await signInWithBadge(context, "ЬКЛ-000742");
    await signInWithBadge(context, "");
    await signInWithBadge(context, BADGE_CODE);
    expect(failures(db)).toEqual([]);
  });

  it("counts a wrong PIN against the station and the operator, an unknown number against the station only", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    await signInWithPin(context, "0042", "1111");
    await signInWithPin(context, "0043", "1111");
    expect(failures(db)).toEqual([
      { key: `operator:${ANNA}`, failures: 1, locked_at: null },
      { key: "station", failures: 2, locked_at: null },
    ]);
  });
});

describe("the sign-in's secrets", () => {
```

5. В `apps/standalone/test/floor-sign-in.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const { executor } = openLocalDb();
    expect(await readFloorReadiness({ local: executor, pairing: PAIRING })).toEqual({
      kind: "not_ready",
    });
    const { db, context } = await synced([
```

заменить на

<!-- prettier-ignore -->
```ts
    const { executor } = openLocalDb();
    expect(await readFloorReadiness({ local: executor, pairing: PAIRING, now: () => NOW })).toEqual(
      {
        kind: "not_ready",
      },
    );
    const { db, context } = await synced([
```

6. В `apps/standalone/test/local-executor.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(tables.map((table) => table.name)).toEqual([
      "ref_lines",
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(tables.map((table) => table.name)).toEqual([
      "floor_sign_in_failures",
      "ref_lines",
```

7. В `apps/standalone/src-tauri/tests/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust

/// Pins today's user tables. `clear_copies` treats every one of them as a
/// disposable copy of the host's data (see its doc comment); a new
/// migration that adds a table makes this assertion fail, on purpose, so
/// whoever adds it must decide whether it is another copy (extend the list
/// here) or the first data this device owns instead — the scan journal,
/// boxes, the outbox (the station design's §6.2, "Логическая модель") —
/// which `clear_copies` and `device_forget` then need to treat deliberately,
/// not silently wipe.
#[tokio::test]
```

заменить на

<!-- prettier-ignore -->
```rust

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
```

8. В `apps/standalone/src-tauri/tests/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust
        [
            "ref_lines",
```

заменить на

<!-- prettier-ignore -->
```rust
        [
            "floor_sign_in_failures",
            "ref_lines",
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-lockout.test.ts test/floor-sign-in.test.ts test/local-executor.test.ts`
Expected: FAIL — 3 файла, `Tests  5 failed | 73 passed (78)`: `floor-lockout.test.ts` не собирается (`Failed to resolve import "../src/floor/lockout.js" from "test/floor-lockout.test.ts"`); в `floor-sign-in.test.ts` 4 — `expected { kind: 'refused', reason: 'wrong' } to deeply equal { kind: 'locked', …(2) }` (2) и `Error: no such table: floor_sign_in_failures` (2); в `local-executor.test.ts` 1 — `expected [ 'ref_lines', …(9) ] to deeply equal [ 'floor_sign_in_failures', …(10) ]`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: сборка вебвью без ошибок (прежнее предупреждение о чанках больше 500 kB); FAIL — `test result: FAILED. 11 passed; 1 failed`: `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` падает на сравнении списка таблиц (`src-tauri/tests/local_db.rs:69`).

- [ ] **Step 3: Таблица неудач, блокировки и проверка их при входе**

1. Создать `apps/standalone/src-tauri/migrations/0005_floor_sign_in_failures.sql`:

<!-- prettier-ignore -->
```sql
-- Failed operator sign-ins on this station (plan 1f): one row for the whole
-- station (`station`) and one per operator who failed since their last
-- sign-in (`operator:<operator id>`), never a typed personnel number, PIN or
-- badge code. `failures` counts the failures since the last sign-in or the
-- end of the last lockout; `locked_at` is Unix milliseconds on this
-- computer's clock when the current lockout began, NULL when there is none.
-- The webview's sign-in writes the rows (`src/floor/lockout.ts`).
--
-- The first table of data this device owns rather than a copy of the
-- host's, and disposable on purpose: `device_forget` empties it with the
-- copies (`LocalDb::clear_copies` takes every table), since a new pairing
-- brings a new roster and the counts of the old one mean nothing there. A
-- later table this device must keep across a forget (the scan journal, the
-- outbox) still needs its own decision, as `clear_copies` says.
CREATE TABLE floor_sign_in_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures > 0),
  locked_at INTEGER
);
```

2. Создать `apps/standalone/src/floor/lockout.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";

// Failed sign-ins and the lockouts they start (plan 1f), kept in the local
// database so that restarting the app does not reset them. Time is this
// computer's clock in Unix milliseconds, injected by the caller.

/** How many failures in a row start a lockout, and how long it lasts. */
export interface LockoutPolicy {
  limit: number;
  durationMs: number;
}

/**
 * Every failure on this station, whoever it was for: ten in a row pause the
 * whole sign-in for a minute. It bounds guessing across personnel numbers
 * (one common PIN tried for many people) and badge codes typed by hand, and
 * stays short because it stops the whole line.
 */
export const STATION_LOCKOUT: LockoutPolicy = { limit: 10, durationMs: 60_000 };

/** A wrong PIN for one operator: five in a row lock that operator's PIN for five minutes. */
export const OPERATOR_LOCKOUT: LockoutPolicy = { limit: 5, durationMs: 5 * 60_000 };

/** The station's counter, or one operator's (by id, never by a typed number). */
export type LockoutKey = "station" | `operator:${string}`;

export function operatorKey(operatorId: string): LockoutKey {
  return `operator:${operatorId}`;
}

const lockRow = z.object({ lockedAt: z.number().int().nullable() });

/**
 * Counts one failure, in one statement. A lockout that has run out (the
 * caller records only while not locked) starts the count again from one, so
 * after every lockout the same number of tries is allowed before the next.
 * The failure that reaches the limit starts a lockout now. SQLite evaluates
 * every `SET` expression against the row as it was, so both read the old
 * `failures` and `locked_at`.
 */
const RECORD_FAILURE =
  "INSERT INTO floor_sign_in_failures (key, failures, locked_at) " +
  "VALUES (?, 1, CASE WHEN 1 >= ? THEN ? END) " +
  "ON CONFLICT (key) DO UPDATE SET " +
  "failures = CASE WHEN locked_at IS NULL THEN failures + 1 ELSE 1 END, " +
  "locked_at = CASE WHEN (CASE WHEN locked_at IS NULL THEN failures + 1 ELSE 1 END) >= ? " +
  "THEN ? END";

/**
 * How long `key` stays locked, in milliseconds; 0 when it is not. When this
 * computer's clock went back behind the lockout's start, the lockout starts
 * again from now: never longer than its duration, and never shorter because
 * of a clock moved back.
 */
export async function lockRemainingMs(
  local: LocalExecutor,
  key: LockoutKey,
  policy: LockoutPolicy,
  now: number,
): Promise<number> {
  const [row] = await local.query(
    "SELECT locked_at AS lockedAt FROM floor_sign_in_failures WHERE key = ?",
    [key],
    lockRow,
  );
  const lockedAt = row?.lockedAt ?? null;
  if (lockedAt === null) return 0;
  const elapsed = now - lockedAt;
  if (elapsed >= policy.durationMs) return 0;
  if (elapsed < 0) {
    await local.transaction([
      {
        sql: "UPDATE floor_sign_in_failures SET locked_at = ? WHERE key = ?",
        values: [now, key],
        expectedChanges: 1,
      },
    ]);
    return policy.durationMs;
  }
  return policy.durationMs - elapsed;
}

/**
 * Counts a failure for `key` (which the caller found unlocked) and answers
 * how long the lockout it started lasts: 0 when it started none.
 */
export async function recordFailure(
  local: LocalExecutor,
  key: LockoutKey,
  policy: LockoutPolicy,
  now: number,
): Promise<number> {
  await local.transaction([
    { sql: RECORD_FAILURE, values: [key, policy.limit, now, policy.limit, now] },
  ]);
  return lockRemainingMs(local, key, policy, now);
}

/** A successful sign-in forgets the station's failures and the operator's. */
export async function clearFailures(local: LocalExecutor, operatorId: string): Promise<void> {
  await local.transaction([
    {
      sql: "DELETE FROM floor_sign_in_failures WHERE key IN ('station', ?)",
      values: [operatorKey(operatorId)],
    },
  ]);
}
```

3. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { copiesReady, type Pairing } from "../local/reference-sync.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { copiesReady, type Pairing } from "../local/reference-sync.js";
import {
  clearFailures,
  lockRemainingMs,
  OPERATOR_LOCKOUT,
  operatorKey,
  recordFailure,
  STATION_LOCKOUT,
} from "./lockout.js";
```

4. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
export type SignInResult =
  { kind: "signed_in"; operator: FloorOperator } | { kind: "refused"; reason: SignInRefusal };
```

заменить на

<!-- prettier-ignore -->
```ts
export type SignInResult =
  | { kind: "signed_in"; operator: FloorOperator }
  | { kind: "refused"; reason: SignInRefusal }
  /**
   * Too many failures: the whole station's sign-in, or one operator's PIN,
   * is paused for `remainingMs` more (`src/floor/lockout.ts`).
   */
  | { kind: "locked"; scope: "station" | "operator"; remainingMs: number };
```

5. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  pairing: Pairing;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  pairing: Pairing;
  /** Unix milliseconds on this computer's clock, for the lockouts. */
  now: () => number;
}
```

6. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts

function signedIn({ id, login, name, role }: FloorOperator): SignInResult {
  return { kind: "signed_in", operator: { id, login, name, role } };
}
```

заменить на

<!-- prettier-ignore -->
```ts

function locked(scope: "station" | "operator", remainingMs: number): SignInResult {
  return { kind: "locked", scope, remainingMs };
}

/** A sign-in that went through forgets the station's failures and the operator's. */
async function signedIn(
  local: LocalExecutor,
  { id, login, name, role }: FloorOperator,
): Promise<SignInResult> {
  await clearFailures(local, id);
  return { kind: "signed_in", operator: { id, login, name, role } };
}

/**
 * Counts a wrong attempt: always against the station, and against the
 * operator whose PIN it was, when one was found. A lockout the attempt
 * started is the answer, the station's first; otherwise it is `wrong`.
 */
async function failed(context: SignInContext, operatorId: string | null): Promise<SignInResult> {
  const now = context.now();
  const station = await recordFailure(context.local, "station", STATION_LOCKOUT, now);
  const operator =
    operatorId === null
      ? 0
      : await recordFailure(context.local, operatorKey(operatorId), OPERATOR_LOCKOUT, now);
  if (station > 0) return locked("station", station);
  if (operator > 0) return locked("operator", operator);
  return refused("wrong");
}
```

7. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * verification: a PIN change or a deactivation that landed meanwhile wins.
 */
```

заменить на

<!-- prettier-ignore -->
```ts
 * verification: a PIN change or a deactivation that landed meanwhile wins.
 *
 * A locked station, or a locked PIN of the operator with this number, is
 * answered before any hashing. A wrong attempt counts against the station
 * and, when the number names one operator, against that operator; a
 * malformed number or PIN (the keypad does not send one), an ambiguous
 * number and copies that are not ready count against nobody.
 */
```

8. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const rows = await local.query(OPERATOR_BY_LOGIN, [login], credentialRow);
  const [only] = rows;
  const operator = rows.length === 1 && only !== undefined && isPinPhc(only.pinPhc) ? only : null;
  const matched = await verifyPhc(pin, operator?.pinPhc ?? DUMMY_PIN_PHC);
  if (rows.length > 1) return refused("ambiguous");
  if (!matched || operator === null) return refused("wrong");
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
```

заменить на

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const stationLock = await lockRemainingMs(local, "station", STATION_LOCKOUT, context.now());
  if (stationLock > 0) return locked("station", stationLock);
  const rows = await local.query(OPERATOR_BY_LOGIN, [login], credentialRow);
  const [only] = rows;
  const found = rows.length === 1 && only !== undefined ? only : null;
  if (found !== null) {
    const key = operatorKey(found.id);
    const operatorLock = await lockRemainingMs(local, key, OPERATOR_LOCKOUT, context.now());
    if (operatorLock > 0) return locked("operator", operatorLock);
  }
  const operator = found !== null && isPinPhc(found.pinPhc) ? found : null;
  const matched = await verifyPhc(pin, operator?.pinPhc ?? DUMMY_PIN_PHC);
  if (rows.length > 1) return refused("ambiguous");
  if (!matched || operator === null) return failed(context, found?.id ?? null);
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
```

9. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (current?.rev !== operator.rev) return refused("wrong");
  return signedIn(operator);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  if (current?.rev !== operator.rev) return refused("wrong");
  return signedIn(local, operator);
}
```

10. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * refused as ambiguous, never resolved to the first.
 */
```

заменить на

<!-- prettier-ignore -->
```ts
 * refused as ambiguous, never resolved to the first.
 *
 * A locked station is answered before any hashing; an unknown badge counts
 * against the station (a code typed by hand is a guess like a PIN). A
 * product's code, a Cyrillic scan, a non-badge and an ambiguous badge count
 * against nobody: none of them is a guess at a badge. An operator whose PIN
 * is locked still signs in with their badge, another credential.
 */
```

11. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const salts = await local.query(SITE_SALT, [], saltRow);
```

заменить на

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const stationLock = await lockRemainingMs(local, "station", STATION_LOCKOUT, context.now());
  if (stationLock > 0) return locked("station", stationLock);
  const salts = await local.query(SITE_SALT, [], saltRow);
```

12. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const [holder] = holders;
  if (holder === undefined) return refused("wrong");
  return signedIn(holder);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  const [holder] = holders;
  if (holder === undefined) return failed(context, null);
  return signedIn(local, holder);
}
```

13. В `apps/standalone/src-tauri/src/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// `apps/standalone/AGENTS.md`).
    /// Every table here is treated as a disposable copy of the host's data;
    /// the first plan that adds data this device owns instead of a copy —
    /// the scan journal, boxes, the outbox (the station design's §6.2,
    /// "Логическая модель") — must exclude those tables from this list and
    /// block or confirm a forget while unsynced records exist, not extend
    /// this silently.
    /// The tables come from `pragma_table_list`, so one a later migration
```

заменить на

<!-- prettier-ignore -->
```rust
    /// `apps/standalone/AGENTS.md`).
    /// Every table here is disposable: the copies of the host's data, and
    /// `floor_sign_in_failures` (plan 1f), this device's own failed
    /// sign-ins, which a new pairing must not inherit. The first plan that
    /// adds data this device must keep — the scan journal, boxes, the
    /// outbox (the station design's §6.2, "Логическая модель") — must
    /// exclude those tables from this list and block or confirm a forget
    /// while unsynced records exist, not extend this silently.
    /// The tables come from `pragma_table_list`, so one a later migration
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-lockout.test.ts test/floor-sign-in.test.ts test/local-executor.test.ts`
Expected: PASS — 3 файла, 83 теста (`floor-lockout` 5, `floor-sign-in` 24, `local-executor` 54).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-lockout.test.ts test/floor-sign-in.test.ts test/local-executor.test.ts`
Expected: PASS, 83; stderr пуст.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS — `test result: ok. 12 passed; 0 failed`.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/floor/sign-in.ts` не спрашивать блокировку оператора: удалить фрагмент

<!-- prettier-ignore -->
```ts
    if (operatorLock > 0) return locked("operator", operatorLock);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "locks an operator's PIN"`
Expected: FAIL — `× locks an operator's PIN after five wrong ones, answers the sixth without hashing, and keeps the badge working`, `expected { kind: 'signed_in', …(1) } to deeply equal { kind: 'locked', …(2) }`.

Мутация 2. В `apps/standalone/src/floor/lockout.ts` снимать блокировку, когда часы отведены назад: фрагмент

<!-- prettier-ignore -->
```ts
  if (elapsed >= policy.durationMs) return 0;
```

заменить на

<!-- prettier-ignore -->
```ts
  if (elapsed >= policy.durationMs || elapsed < 0) return 0;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-lockout.test.ts -t "clock went back"`
Expected: FAIL — `× starts a lockout again from now when this computer's clock went back behind it`, `expected +0 to be 60000`.

Мутация 3. В `apps/standalone/src/floor/lockout.ts` не начинать отсчёт заново после блокировки: фрагмент

<!-- prettier-ignore -->
```ts
  "failures = CASE WHEN locked_at IS NULL THEN failures + 1 ELSE 1 END, " +
```

заменить на

<!-- prettier-ignore -->
```ts
  "failures = failures + 1, " +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-lockout.test.ts -t "same number of tries again"`
Expected: FAIL — `× allows the same number of tries again after a lockout ran out`, `expected [ { key: 'station', …(2) } ] to deeply equal [ { key: 'station', …(2) } ]` (счёт продолжился: 4 вместо 1).

Мутация 4. В `apps/standalone/src/floor/sign-in.ts` не считать неизвестный бейдж: фрагмент

<!-- prettier-ignore -->
```ts
  if (holder === undefined) return failed(context, null);
```

заменить на

<!-- prettier-ignore -->
```ts
  if (holder === undefined) return refused("wrong");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-sign-in.test.ts -t "pauses the whole station"`
Expected: FAIL — `× pauses the whole station after ten failures of any kind, before hashing anything`, `expected { kind: 'refused', reason: 'wrong' } to deeply equal { kind: 'locked', …(2) }`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/lockout.ts apps/standalone/src/floor/sign-in.ts apps/standalone/test/floor-lockout.test.ts apps/standalone/test/floor-sign-in.test.ts apps/standalone/test/local-executor.test.ts`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 61 файл, 1452 теста (1443 + 9: `floor-lockout` 5, `floor-sign-in` 4).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src-tauri/migrations/0005_floor_sign_in_failures.sql apps/standalone/src/floor/lockout.ts apps/standalone/src/floor/sign-in.ts apps/standalone/src-tauri/src/local_db.rs apps/standalone/test/floor-lockout.test.ts apps/standalone/test/floor-sign-in.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/src-tauri/tests/local_db.rs
git commit -m "feat(standalone): блокировки входа станции и оператора после неудачных попыток" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Сеанс оператора в оболочке (`src/app/shell.ts`)

Оболочка держит вошедшего оператора только в памяти (`ShellState.operator`: идентификатор, табельный номер, имя, должность — никогда хеш) и причину последнего выхода (`floorNotice`: `idle`, `removed`, `line_changed`) до следующего входа. Цех без оператора остаётся видом `floor` (экран входа), с оператором — новый вид `floor_operator`; линия по-прежнему выбирается раньше. `operator_signed_in` несёт идентификатор устройства, копии которого читал вход, и применяется только к тому же подключению, без отказа устройства, без другого хоста, при закрытом офисе и у станции с линией: поздний ответ входа никого не впускает. `operator_signed_out` несёт идентификатор оператора и выводит только его: поздний выход (таймер бездействия, проверка копий) не выводит следующего. Оператора выводят и открытие офиса (D4), новое подключение, сброс, отказ устройства (и из ответа хоста, и из строки связи), другой хост, выбор линии и смена или снятие линии офисом (с причиной `line_changed`). Связь, ушедшая в офлайн, сбойная синхронизация и событие ревизии оператора не выводят. Экранов в задаче нет: `App` ничего не посылает до задачи 6.

**Files:**

- Modify: `apps/standalone/src/app/shell.ts`
- Test: `apps/standalone/test/shell.test.ts` (Modify)

**Interfaces:**

- Consumes: `type FloorOperator` — `src/floor/sign-in.ts` (задача 2).
- Produces (`src/app/shell.ts`): `type FloorNotice = "idle" | "removed" | "line_changed"`; `ShellState.operator: FloorOperator | null`, `ShellState.floorNotice: FloorNotice | null`; вид `{ kind: "floor_operator"; operator: FloorOperator }`; действия `{ type: "operator_signed_in"; deviceId: string; operator: FloorOperator }` и `{ type: "operator_signed_out"; operatorId: string; notice: FloorNotice | null }` (`null` — «Сменить оператора»).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/shell.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(shellActionFor(new Error("boom"), SESSION.token)).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(shellActionFor(new Error("boom"), SESSION.token)).toBeNull();
  });
});

describe("the operator on the floor", () => {
  const ANNA = {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "0042",
    name: "Анна",
    role: null,
  };
  const BORIS = {
    id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    login: "0099",
    name: "Борис",
    role: null,
  };
  const signIn: ShellAction = {
    type: "operator_signed_in",
    deviceId: DEVICE_STATUS.deviceId,
    operator: ANNA,
  };

  function signedIn(overrides: Partial<ShellState> = {}): ShellState {
    return shellReducer(paired(overrides), signIn);
  }

  it("shows the signed-in operator's floor, and the sign-in again once they leave", () => {
    const floor = signedIn();
    expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
    const left = shellReducer(floor, {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: null,
    });
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "floor" });
    expect(left.floorNotice).toBeNull();
  });

  it("says why the operator was signed out until the next one signs in", () => {
    const idle = shellReducer(signedIn(), {
      type: "operator_signed_out",
      operatorId: ANNA.id,
      notice: "idle",
    });
    expect(idle.floorNotice).toBe("idle");
    const next = shellReducer(idle, { ...signIn, operator: BORIS });
    expect(next.operator).toEqual(BORIS);
    expect(next.floorNotice).toBeNull();
  });

  it("ignores a late sign-out for an operator who already left", () => {
    const boris = shellReducer(signedIn(), { ...signIn, operator: BORIS });
    expect(
      shellReducer(boris, { type: "operator_signed_out", operatorId: ANNA.id, notice: "idle" }),
    ).toBe(boris);
    const nobody = paired();
    expect(
      shellReducer(nobody, { type: "operator_signed_out", operatorId: ANNA.id, notice: "removed" }),
    ).toBe(nobody);
  });

  it("signs nobody in from another pairing, a rejected device, an open office or a station without a line", () => {
    for (const state of [
      paired({ device: { kind: "ready", status: { ...DEVICE_STATUS, deviceId: BORIS.id } } }),
      unpaired(),
      paired({ rejection: "key_rejected" }),
      paired({ sync: { kind: "other_host", synced: 0, failure: null, quarantined: 0 } }),
      paired({ office: { kind: "signing_in", notice: null } }),
      paired({ device: { kind: "ready", status: NEW_STATION } }),
    ]) {
      expect(shellReducer(state, signIn)).toBe(state);
    }
  });

  it("signs the operator out for the office, a new pairing, a forget and a rejected device", () => {
    for (const action of [
      { type: "office_requested" },
      { type: "paired", status: DEVICE_STATUS },
      { type: "forgotten" },
      { type: "device_rejected", reason: "key_rejected" },
      { type: "link_status", status: linkStatus({ lastError: "key_rejected" }) },
      { type: "sync_finished", result: { kind: "other_host" } },
    ] satisfies ShellAction[]) {
      expect(shellReducer(signedIn(), action).operator).toBeNull();
    }
  });

  it("signs the operator out when the office moves the station to another line or clears it", () => {
    const moved = shellReducer(signedIn(), {
      type: "device_refreshed",
      status: { ...DEVICE_STATUS, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" },
    });
    expect(moved.operator).toBeNull();
    expect(moved.floorNotice).toBe("line_changed");
    const cleared = shellReducer(signedIn(), { type: "device_refreshed", status: NEW_STATION });
    expect(nextShellView(cleared, ADDRESS)).toEqual({ kind: "line_select" });
    expect(cleared.floorNotice).toBe("line_changed");
    // The same line again changes nothing.
    const same = signedIn();
    expect(shellReducer(same, { type: "device_refreshed", status: DEVICE_STATUS })).toBe(same);
  });

  it("keeps the operator through the link going down and failed syncs: the floor works offline", () => {
    let state = signedIn();
    for (const action of [
      { type: "link_status", status: linkStatus({ state: "offline", lastError: "unreachable" }) },
      { type: "sync_started" },
      { type: "sync_failed", failure: "host", quarantined: null },
      { type: "host_revision", rev: 7 },
    ] satisfies ShellAction[]) {
      state = shellReducer(state, action);
    }
    expect(nextShellView(state, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL — 1 файл, `Tests  7 failed | 38 passed (45)`: все семь тестов «the operator on the floor» — редуктор не знает новых действий и возвращает `undefined` (`TypeError: Cannot read properties of undefined (reading 'floorNotice')`, `expected undefined to be null` и подобные).

- [ ] **Step 3: Оператор в состоянии оболочки**

1. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { HostError } from "../host/client.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import type { FloorOperator } from "../floor/sign-in.js";
import { HostError } from "../host/client.js";
```

2. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts

export interface ShellState {
```

заменить на

<!-- prettier-ignore -->
```ts

/**
 * Why the floor's sign-in screen says the last operator is no longer signed
 * in: nobody touched the station for the idle timeout (`idle`), the host
 * turned the operator off and the copies lost them (`removed`), or the office
 * moved the station to another line or cleared it (`line_changed`).
 */
export type FloorNotice = "idle" | "removed" | "line_changed";

export interface ShellState {
```

3. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostRevision: number | null;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  hostRevision: number | null;
  /**
   * The operator signed in on the floor (plan 1f), kept only in memory: a
   * restart, a new pairing, a rejected device, the office and a change of
   * the line all sign the operator out. Never an office user (spec §4.8).
   */
  operator: FloorOperator | null;
  /** Why the last operator was signed out, until the next one signs in. */
  floorNotice: FloorNotice | null;
}
```

4. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
  | { kind: "line_select" }
  | { kind: "floor" }
  | { kind: "office_login"; notice: OfficeLoginNotice | null }
```

заменить на

<!-- prettier-ignore -->
```ts
  | { kind: "line_select" }
  /** The floor with nobody signed in: the operator sign-in and the way into the office. */
  | { kind: "floor" }
  /** The floor with an operator signed in (stage 1's stub until the shifts of plan 2a). */
  | { kind: "floor_operator"; operator: FloorOperator }
  | { kind: "office_login"; notice: OfficeLoginNotice | null }
```

5. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus };
```

заменить на

<!-- prettier-ignore -->
```ts
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus }
  // `deviceId`: the pairing the sign-in read the copies of.
  | { type: "operator_signed_in"; deviceId: string; operator: FloorOperator }
  // `notice: null` is the operator's own «Сменить оператора».
  | { type: "operator_signed_out"; operatorId: string; notice: FloorNotice | null };
```

6. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
  hostRevision: null,
};
```

заменить на

<!-- prettier-ignore -->
```ts
  hostRevision: null,
  operator: null,
  floorNotice: null,
};
```

7. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
      return { kind: "floor" };
```

заменить на

<!-- prettier-ignore -->
```ts
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
      if (state.operator !== null) return { kind: "floor_operator", operator: state.operator };
      return { kind: "floor" };
```

8. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
        rejection: null,
        link: null,
        sync: IDLE_SYNC,
        hostRevision: null,
      };
```

заменить на

<!-- prettier-ignore -->
```ts
        rejection: null,
        link: null,
        sync: IDLE_SYNC,
        hostRevision: null,
        operator: null,
        floorNotice: null,
      };
```

9. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
        hostRevision: null,
      };
```

заменить на

<!-- prettier-ignore -->
```ts
        hostRevision: null,
        operator: null,
        floorNotice: null,
      };
```

10. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
    case "office_requested":
      return { ...state, office: { kind: "signing_in", notice: action.notice ?? null } };
    case "office_opened":
```

заменить на

<!-- prettier-ignore -->
```ts
    case "office_requested":
      // The office and an operator never share the screen: the operator
      // is signed out, and the office signs in with its own credentials.
      return {
        ...state,
        office: { kind: "signing_in", notice: action.notice ?? null },
        operator: null,
        floorNotice: null,
      };
    case "office_opened":
```

11. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      }
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE };
    }
```

заменить на

<!-- prettier-ignore -->
```ts
      }
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE, operator: null };
    }
```

12. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      if (rejection === null) return { ...state, link: action.status };
      return { ...state, link: action.status, rejection, office: CLOSED_OFFICE };
    }
```

заменить на

<!-- prettier-ignore -->
```ts
      if (rejection === null) return { ...state, link: action.status };
      return { ...state, link: action.status, rejection, office: CLOSED_OFFICE, operator: null };
    }
```

13. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
        // Office requests would reach a host this device was never paired with.
        return { ...state, sync: { ...state.sync, kind: "other_host" }, office: CLOSED_OFFICE };
      }
```

заменить на

<!-- prettier-ignore -->
```ts
        // Office requests would reach a host this device was never paired with.
        return {
          ...state,
          sync: { ...state.sync, kind: "other_host" },
          office: CLOSED_OFFICE,
          operator: null,
        };
      }
```

14. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status } };
    case "device_refreshed": {
```

заменить на

<!-- prettier-ignore -->
```ts
    case "line_selected":
      return { ...state, device: { kind: "ready", status: action.status }, operator: null };
    case "device_refreshed": {
```

15. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      }
      return { ...state, device: { kind: "ready", status: action.status } };
    }
  }
```

заменить на

<!-- prettier-ignore -->
```ts
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
      // Only onto the floor the sign-in started from: a late answer must not
      // sign anybody in after the pairing changed or ended, the device was
      // rejected, the office opened or the station lost its line meanwhile.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const status = state.device.status;
      if (
        status.deviceId !== action.deviceId ||
        state.rejection !== null ||
        state.sync.kind === "other_host" ||
        state.office.kind !== "closed" ||
        (status.kind === "station" && status.lineId === null)
      ) {
        return state;
      }
      return { ...state, operator: action.operator, floorNotice: null };
    }
    case "operator_signed_out":
      // A late sign-out (an idle timer, a check of the copies) for an
      // operator who already left must not sign out the next one.
      if (state.operator?.id !== action.operatorId) return state;
      return { ...state, operator: null, floorNotice: action.notice };
  }
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: PASS — 1 файл, 45 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/shell.test.ts`
Expected: PASS, 45; stderr пуст.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/app/shell.ts` принимать вход, читавший копии другого подключения: удалить фрагмент

<!-- prettier-ignore -->
```ts
        status.deviceId !== action.deviceId ||
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts -t "signs nobody in from another pairing"`
Expected: FAIL — `× signs nobody in from another pairing, a rejected device, an open office or a station without a line`, `expected { …(10) } to be { …(10) }`.

Мутация 2. В `apps/standalone/src/app/shell.ts` выводить любого оператора поздним выходом: фрагмент

<!-- prettier-ignore -->
```ts
      if (state.operator?.id !== action.operatorId) return state;
```

заменить на

<!-- prettier-ignore -->
```ts
      if (state.operator === null) return state;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts -t "late sign-out"`
Expected: FAIL — `× ignores a late sign-out for an operator who already left`, `expected { …(10) } to be { …(10) }`.

Мутация 3. В `apps/standalone/src/app/shell.ts` оставлять оператора при смене линии офисом: фрагмент

<!-- prettier-ignore -->
```ts
        operator: null,
        floorNotice: state.operator === null ? state.floorNotice : "line_changed",
```

заменить на

<!-- prettier-ignore -->
```ts
        floorNotice: state.operator === null ? state.floorNotice : "line_changed",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts -t "another line or clears it"`
Expected: FAIL — `× signs the operator out when the office moves the station to another line or clears it`, `expected { …(4) } to be null`.

Мутация 4. В `apps/standalone/src/app/shell.ts` оставлять оператора, когда открывается офис: фрагмент

<!-- prettier-ignore -->
```ts
        office: { kind: "signing_in", notice: action.notice ?? null },
        operator: null,
```

заменить на

<!-- prettier-ignore -->
```ts
        office: { kind: "signing_in", notice: action.notice ?? null },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts -t "for the office, a new pairing"`
Expected: FAIL — `× signs the operator out for the office, a new pairing, a forget and a rejected device`, `expected { …(4) } to be null`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/app/shell.ts apps/standalone/test/shell.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 61 файл, 1459 тестов (1452 + 7).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/app/shell.ts apps/standalone/test/shell.test.ts
git commit -m "feat(standalone): сеанс оператора цеха в состоянии оболочки" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Экран входа оператора (`src/floor/OperatorSignIn.tsx`) и клавиатурный сканер

Экран цеха без оператора — по образцу облачного `OperatorLogin.tsx`, но карточкой «Цех», как прежний экран цеха: бейдж можно приложить в любой момент (сканер слушает окно, `createKeyboardWedgeSource` — перенос облачного источника: символы до Enter, Enter не нажимает кнопку в фокусе), «Войти по табельному номеру» открывает цифровую клавиатуру `PinPad` из `@markiro/ui` для номера («Далее» — от 3 до 12 цифр), затем для PIN («Войти» — от 4 до 6 цифр, набранный PIN показан точками). Одна проверка за раз: скан во время проверки и второе нажатие отбрасываются (страж `inFlight`). Ответ проверки — сообщение в живой области словами своей причины: неверный PIN, неизвестный бейдж, неоднозначный номер или бейдж, код товара, раскладка, не бейдж, копии не готовы, блокировка станции или PIN с числом минут (округление вверх), сбой локальной базы — общим текстом, без её сообщения. После неверного PIN поле PIN очищается. Неизвестный бейдж или PIN и неготовые копии просят немедленную синхронизацию (`onSync`). Пока копии этого подключения не готовы и пока в них нет операторов, экран говорит, почему войти нельзя, и оставляет «Офис»; копии читаются заново после каждой синхронизации (`sync.synced`), сбой чтения предлагает «Повторить». Причина последнего выхода (`notice`) видна до первой попытки. В `App` экран встанет в задаче 6.

**Files:**

- Create: `apps/standalone/src/floor/scan-source.ts`, `apps/standalone/src/floor/OperatorSignIn.tsx`
- Modify: `apps/standalone/src/i18n/ru.json` (`floor.signIn`), `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/operator-sign-in.test.tsx` (Create)

**Interfaces:**

- Consumes: `readFloorReadiness`, `signInWithPin`, `signInWithBadge`, `type FloorOperator`, `type FloorReadiness`, `type SignInContext`, `type SignInRefusal`, `type SignInResult` — задачи 2–3; `type FloorNotice`, `type SyncState` — `src/app/shell.ts` (задача 4); `HostStatusLine`; `type Pairing` — задача 1.
- Produces:
  - `scan-source.ts`: `type ScanListener = (raw: string) => void`; `interface ScanSource { start(listener): () => void; clearPendingInput(): void }`; `createKeyboardWedgeSource(target?: Pick<Window, "addEventListener" | "removeEventListener">): ScanSource`;
  - `OperatorSignIn.tsx`: `interface OperatorSignInProps { local; pairing: Pairing; link: HostStatus | null; sync: SyncState; notice: FloorNotice | null; source: ScanSource; now?: () => number; onSignedIn(operator: FloorOperator): void; onSync(): void; onOffice(): void }`, `OperatorSignIn(props)`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/operator-sign-in.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, SyncState } from "../src/app/shell.js";
import { OperatorSignIn } from "../src/floor/OperatorSignIn.js";
import { createKeyboardWedgeSource, type ScanSource } from "../src/floor/scan-source.js";
import type { FloorOperator } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
/** The PIN 4821 and the badge «MRK-000742» under `SITE`'s salt (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
/** One clock for every render: a new function would read the copies again on its own. */
const CLOCK = () => NOW;
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
};
const BADGE: ChangeItem = {
  entity: "operator_badges",
  id: PASS_7,
  rev: 6,
  deleted: false,
  data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
};
const ANNA_OPERATOR: FloorOperator = {
  id: ANNA,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
};

async function synced(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

interface Options {
  local: LocalExecutor;
  sync?: SyncState;
  notice?: FloorNotice | null;
  source?: ScanSource;
}

function renderSignIn({ local, sync = SYNCED, notice = null, source }: Options) {
  const onSignedIn = vi.fn<(operator: FloorOperator) => void>();
  const onSync = vi.fn<() => void>();
  const onOffice = vi.fn<() => void>();
  const view = render(
    <ThemeProvider>
      <OperatorSignIn
        local={local}
        pairing={PAIRING}
        link={null}
        sync={sync}
        notice={notice}
        source={source ?? createKeyboardWedgeSource(window)}
        now={CLOCK}
        onSignedIn={onSignedIn}
        onSync={onSync}
        onOffice={onOffice}
      />
    </ThemeProvider>,
  );
  return { ...view, onSignedIn, onSync, onOffice };
}

/** A keyboard-wedge scanner: every character a key, then Enter. */
function scan(text: string) {
  for (const key of text) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
}

function press(...keys: string[]) {
  for (const key of keys) fireEvent.click(screen.getByRole("button", { name: key }));
}

async function enterLogin(login: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Войти по табельному номеру" }));
  press(...login);
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

describe("the floor's sign-in screen", () => {
  it("signs an operator in with a personnel number and a PIN on the keypad", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await enterLogin("0042");
    expect(screen.getByText("Табельный номер 0042. Наберите PIN.")).toBeTruthy();
    press("4", "8", "2", "1");
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("••••");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("says a wrong PIN, empties it and stays on the PIN", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await enterLogin("0042");
    press("1", "1", "1", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("Неверный табельный номер или PIN.")).toBeTruthy();
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    expect(screen.getByText("Табельный номер 0042. Наберите PIN.")).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("offers «Далее» for 3–12 digits and «Войти» for 4–6", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    fireEvent.click(await screen.findByRole("button", { name: "Войти по табельному номеру" }));
    const next = () => screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
    press("4", "2");
    expect(next().disabled).toBe(true);
    press("0");
    expect(next().disabled).toBe(false);
    fireEvent.click(next());
    const submit = () => screen.getByRole("button", { name: "Войти" }) as HTMLButtonElement;
    press("4", "8", "2");
    expect(submit().disabled).toBe(true);
    press("1");
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Наберите табельный номер.")).toBeTruthy();
  });

  it("signs an operator in with a badge scan, once, whatever arrives during the check", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    act(() => {
      scan("MRK-000742");
      scan("MRK-000742");
    });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("explains a refused scan in words of its own, and asks for a sync only after an unknown badge", async () => {
    const { onSync } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    act(() => scan("MRK-000743"));
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    expect(onSync).toHaveBeenCalledTimes(1);
    act(() => scan("0104600682000013215Abc\u001d91EE11"));
    expect(await screen.findByText("Это код товара, а не бейдж. Приложите бейдж.")).toBeTruthy();
    act(() => scan("ЬКЛ-000742"));
    expect(await screen.findByText(/^Сканер набирает в русской раскладке\./)).toBeTruthy();
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("says how many minutes a locked station waits", async () => {
    const local = await synced([SITE, OPERATOR, BADGE]);
    await local.transaction([
      {
        sql: "INSERT INTO floor_sign_in_failures (key, failures, locked_at) VALUES ('station', 10, ?)",
        values: [NOW - 1_000],
      },
    ]);
    renderSignIn({ local });
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    act(() => scan("MRK-000742"));
    expect(
      await screen.findByText(
        "Слишком много неудачных попыток. Вход на этой станции приостановлен на 1 мин.",
      ),
    ).toBeTruthy();
  });

  it("says nobody can sign in until this pairing's copies arrive, and keeps the way into the office", async () => {
    const { executor } = openLocalDb();
    const { onOffice } = renderSignIn({ local: executor, sync: { ...SYNCED, synced: 0 } });
    expect(await screen.findByText(/^Справочники ещё не загружены с хоста\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Войти по табельному номеру" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(onOffice).toHaveBeenCalledTimes(1);
  });

  it("reads the copies again after every sync", async () => {
    const { executor } = openLocalDb();
    const source = createKeyboardWedgeSource(window);
    const { rerender } = renderSignIn({ local: executor, sync: { ...SYNCED, synced: 0 }, source });
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [SITE] }),
      local: executor,
      ...PAIRING,
    });
    rerender(
      <ThemeProvider>
        <OperatorSignIn
          local={executor}
          pairing={PAIRING}
          link={null}
          sync={SYNCED}
          notice={null}
          source={source}
          now={CLOCK}
          onSignedIn={() => undefined}
          onSync={() => undefined}
          onOffice={() => undefined}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText(/^В справочнике нет операторов\./)).toBeTruthy();
  });

  it("offers to read the copies again when the read fails", async () => {
    const real = await synced([SITE, OPERATOR]);
    let failing = true;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderSignIn({ local });
    expect(
      await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере."),
    ).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "Войти по табельному номеру" })).toBeTruthy();
  });

  it("says why the last operator was signed out until somebody tries to sign in", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]), notice: "idle" });
    expect(await screen.findByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
    act(() => scan("MRK-000743"));
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    expect(screen.queryByText("Оператор вышел по бездействию. Войдите снова.")).toBeNull();
  });

  it("stops listening to the scanner once it leaves the screen", async () => {
    const stop = vi.fn();
    const source: ScanSource = { start: vi.fn(() => stop), clearPendingInput: vi.fn() };
    const { unmount } = renderSignIn({ local: await synced([SITE]), source });
    await screen.findByText(/^В справочнике нет операторов\./);
    expect(source.start).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the keyboard-wedge scan source", () => {
  it("hands over the keys typed before Enter, without modifiers, and nothing for a bare Enter", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    fireEvent.keyDown(window, { key: "Shift" });
    scan("Ab-1");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "x" });
    source.clearPendingInput();
    scan("2");
    stop();
    scan("3");
    expect(scans).toEqual(["Ab-1", "2"]);
  });

  it("keeps the scan's Enter from also pressing the focused button", () => {
    const source = createKeyboardWedgeSource(window);
    const stop = source.start(() => undefined);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    stop();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx`
Expected: FAIL — 1 файл, `Tests  no tests`: `Failed to resolve import "../src/floor/OperatorSignIn.js" from "test/operator-sign-in.test.tsx"`.

- [ ] **Step 3: Источник сканов, экран, тексты и стили**

1. Создать `apps/standalone/src/floor/scan-source.ts`:

<!-- prettier-ignore -->
```ts
/** A raw scan, as the scanner typed it, before anything trims or reads it. */
export type ScanListener = (raw: string) => void;

/**
 * Where scans come from (stage 1 spec §5.6): a keyboard-wedge scanner today,
 * the COM scanners of plan 2a later. The sign-in screen does not care which.
 */
export interface ScanSource {
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
  /** Drops the keys typed since the last Enter. */
  clearPendingInput(): void;
}

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * A HID scanner is a keyboard: it types the code and presses Enter. This
 * source gathers single-character keys and hands them over on Enter,
 * skipping modifiers and navigation keys (their `key` is a name such as
 * «Shift» or «ArrowLeft»). Ported from the cloud station's
 * `createKeyboardWedgeSource` (`apps/station/src/lib/scan-source.ts`).
 */
export function createKeyboardWedgeSource(target: KeyTarget = window): ScanSource {
  const buffers = new Set<() => void>();
  return {
    start(listener) {
      let payload = "";
      const clear = () => {
        payload = "";
      };
      buffers.add(clear);
      const onKeyDown = (event: Event) => {
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          // The scan's closing Enter lands on whatever holds the focus, and a
          // focused button would also take it as a click. `preventDefault`
          // stops that; filtering by the event's target instead would drop
          // the scan itself, which is worse.
          event.preventDefault();
          if (payload.length > 0) listener(payload);
          payload = "";
          return;
        }
        if (key.length === 1) payload += key;
      };
      target.addEventListener("keydown", onKeyDown);
      return () => {
        clear();
        buffers.delete(clear);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
    clearPendingInput() {
      for (const clear of buffers) clear();
    },
  };
}
```

2. Создать `apps/standalone/src/floor/OperatorSignIn.tsx`:

<!-- prettier-ignore -->
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PinPad, Spinner } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import type { ScanSource } from "./scan-source.js";
import {
  readFloorReadiness,
  signInWithBadge,
  signInWithPin,
  type FloorOperator,
  type FloorReadiness,
  type SignInContext,
  type SignInRefusal,
  type SignInResult,
} from "./sign-in.js";

export interface OperatorSignInProps {
  local: LocalExecutor;
  /** The pairing whose copies the sign-in reads. */
  pairing: Pairing;
  link: HostStatus | null;
  sync: SyncState;
  /** Why the last operator was signed out, if they were not the one who left. */
  notice: FloorNotice | null;
  /** Where badge scans come from: the keyboard wedge in the app. */
  source: ScanSource;
  /** This computer's clock, for the lockouts; tests pin it. */
  now?: () => number;
  onSignedIn: (operator: FloorOperator) => void;
  /**
   * Asks for a reference sync now: after an unknown credential or copies
   * that are not ready, a record the office has just added may be on its
   * way (spec §5.6). The next attempt reads whatever the sync brought.
   */
  onSync: () => void;
  onOffice: () => void;
}

type Stage = "badge" | "login" | "pin";

/** What the message slot says: a refusal of the last attempt, or a notice. */
type Message =
  | { kind: "refused"; reason: SignInRefusal; via: "pin" | "badge" }
  | { kind: "locked"; scope: "station" | "operator"; minutes: number }
  | { kind: "failed" };

const LOGIN = /^[0-9]{3,12}$/;
const PIN = /^[0-9]{4,6}$/;
const MINUTE_MS = 60_000;

const REFUSAL_KEY = {
  wrong: "floor.signIn.errors.wrongPin",
  ambiguous: "floor.signIn.errors.ambiguousLogin",
  not_ready: "floor.signIn.errors.notReady",
  product_code: "floor.signIn.errors.productCode",
  layout: "floor.signIn.errors.layout",
  not_badge: "floor.signIn.errors.notBadge",
} as const satisfies Record<SignInRefusal, string>;

const BADGE_REFUSAL_KEY = {
  ...REFUSAL_KEY,
  wrong: "floor.signIn.errors.wrongBadge",
  ambiguous: "floor.signIn.errors.ambiguousBadge",
} as const satisfies Record<SignInRefusal, string>;

const NOTICE_KEY = {
  idle: "floor.signIn.notice.idle",
  removed: "floor.signIn.notice.removed",
  line_changed: "floor.signIn.notice.lineChanged",
} as const satisfies Record<FloorNotice, string>;

function messageOf(result: Exclude<SignInResult, { kind: "signed_in" }>, via: "pin" | "badge") {
  if (result.kind === "locked") {
    const minutes = Math.max(1, Math.ceil(result.remainingMs / MINUTE_MS));
    return { kind: "locked", scope: result.scope, minutes } satisfies Message;
  }
  return { kind: "refused", reason: result.reason, via } satisfies Message;
}

/**
 * The floor with nobody signed in (stage 1 spec §5.6, plan 1f): a badge scan
 * at any moment, or a personnel number and a PIN on the keypad, checked
 * offline against this pairing's copies (`src/floor/sign-in.ts`). Until the
 * copies are complete, and while they hold no operator, the screen says why
 * nobody can sign in and keeps the way into the office. One check runs at a
 * time: a scan during a check is dropped, and so is a second press. An
 * unknown credential asks for a sync, as the cloud station refreshes its
 * roster before refusing.
 */
export function OperatorSignIn({
  local,
  pairing,
  link,
  sync,
  notice,
  source,
  now = Date.now,
  onSignedIn,
  onSync,
  onOffice,
}: OperatorSignInProps) {
  const { t } = useTranslation();
  const [readiness, setReadiness] = useState<FloorReadiness | "failed" | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>("badge");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    let cancelled = false;
    readFloorReadiness({ local, pairing: { hostId, deviceId }, now }).then(
      (next) => {
        if (!cancelled) setReadiness(next);
      },
      () => {
        if (!cancelled) setReadiness("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, now, sync.synced, readAttempt]);

  /** One check at a time; the answer either signs in or says why not. */
  const attempt = useCallback(
    async (via: "pin" | "badge", check: (context: SignInContext) => Promise<SignInResult>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      let result: SignInResult | null;
      try {
        result = await check({ local, pairing: { hostId, deviceId }, now });
      } catch {
        // A failed read or write of the local database: its text may name
        // SQL and is never shown.
        result = null;
      }
      inFlight.current = false;
      setBusy(false);
      if (result === null) {
        setMessage({ kind: "failed" });
        return;
      }
      if (result.kind === "signed_in") {
        onSignedIn(result.operator);
        return;
      }
      setMessage(messageOf(result, via));
      setPin("");
      if (
        result.kind === "refused" &&
        (result.reason === "wrong" || result.reason === "not_ready")
      ) {
        onSync();
      }
    },
    [local, hostId, deviceId, now, onSignedIn, onSync],
  );

  const scan = useRef(attempt);
  useEffect(() => {
    scan.current = attempt;
  }, [attempt]);

  useEffect(
    () =>
      source.start((raw) => {
        void scan.current("badge", (context) => signInWithBadge(context, raw));
      }),
    [source],
  );

  const toStage = (next: Stage) => {
    source.clearPendingInput();
    setMessage(null);
    setPin("");
    if (next === "login") setLogin("");
    setStage(next);
  };

  const messageText = (shown: Message) => {
    if (shown.kind === "failed") return t("floor.signIn.errors.failed");
    if (shown.kind === "locked") {
      return t(
        shown.scope === "station"
          ? "floor.signIn.errors.lockedStation"
          : "floor.signIn.errors.lockedOperator",
        { minutes: shown.minutes },
      );
    }
    return t((shown.via === "badge" ? BADGE_REFUSAL_KEY : REFUSAL_KEY)[shown.reason]);
  };

  const body = () => {
    if (readiness === null) {
      return (
        <div className="standalone-probing" role="status">
          <Spinner size={32} />
          <p>{t("floor.signIn.loading")}</p>
        </div>
      );
    }
    if (readiness === "failed") {
      return (
        <Alert
          tone="error"
          action={
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                setReadiness(null);
                setReadAttempt((count) => count + 1);
              }}
            >
              {t("floor.signIn.retry")}
            </Button>
          }
        >
          {t("floor.signIn.readFailed")}
        </Alert>
      );
    }
    if (readiness.kind === "not_ready") return <p>{t("floor.signIn.notSynced")}</p>;
    if (readiness.operators === 0) return <p>{t("floor.signIn.noOperators")}</p>;
    if (stage === "badge") {
      return (
        <div className="floor-sign-in">
          <p className="floor-sign-in__prompt">{t("floor.signIn.badgePrompt")}</p>
          <div className="standalone-form__actions">
            <Button size="floor" disabled={busy} onClick={() => toStage("login")}>
              {t("floor.signIn.useLogin")}
            </Button>
          </div>
        </div>
      );
    }
    const entering = stage === "login" ? login : pin;
    return (
      <div className="floor-sign-in">
        <p className="floor-sign-in__prompt">
          {t(stage === "login" ? "floor.signIn.loginPrompt" : "floor.signIn.pinPrompt", { login })}
        </p>
        <output className="floor-sign-in__readout" aria-label={t(`floor.signIn.${stage}Readout`)}>
          {stage === "login" ? login : "•".repeat(pin.length)}
        </output>
        <PinPad
          value={entering}
          onChange={stage === "login" ? setLogin : setPin}
          maxLength={stage === "login" ? 12 : 6}
          size="floor"
          disabled={busy}
          ariaLabel={t(stage === "login" ? "floor.signIn.loginKeypad" : "floor.signIn.pinKeypad")}
          backspaceLabel={t("floor.signIn.backspace")}
          clearLabel={t("floor.signIn.clear")}
        />
        <div className="standalone-form__actions">
          <Button
            size="floor"
            variant="secondary"
            disabled={busy}
            onClick={() => toStage(stage === "pin" ? "login" : "badge")}
          >
            {t("floor.signIn.back")}
          </Button>
          {stage === "login" ? (
            <Button
              size="floor"
              disabled={busy || !LOGIN.test(login)}
              onClick={() => toStage("pin")}
            >
              {t("floor.signIn.next")}
            </Button>
          ) : (
            <Button
              size="floor"
              loading={busy}
              disabled={!PIN.test(pin)}
              onClick={() => void attempt("pin", (context) => signInWithPin(context, login, pin))}
            >
              {t("floor.signIn.submit")}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <div className="floor-sign-in__message" aria-live="polite">
          {message !== null ? (
            <Alert
              tone={message.kind === "refused" && message.reason === "not_ready" ? "warn" : "error"}
            >
              {messageText(message)}
            </Alert>
          ) : notice !== null ? (
            <Alert tone="info">{t(NOTICE_KEY[notice])}</Alert>
          ) : null}
          {busy && <p>{t("floor.signIn.checking")}</p>}
        </div>
        {body()}
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          <Button variant="secondary" disabled={busy} onClick={onOffice}>
            {t("floor.office")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

3. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
    "body": "Рабочий экран цеха появится в следующем обновлении. Отсюда можно перейти в офис.",
    "office": "Офис"
  },
```

заменить на

<!-- prettier-ignore -->
```json
    "body": "Рабочий экран цеха появится в следующем обновлении. Отсюда можно перейти в офис.",
    "office": "Офис",
    "signIn": {
      "loading": "Читаем справочник операторов…",
      "readFailed": "Не удалось прочитать справочник операторов на этом компьютере.",
      "retry": "Повторить",
      "notSynced": "Справочники ещё не загружены с хоста. Вход станет доступен после первой синхронизации — проверьте связь с хостом.",
      "noOperators": "В справочнике нет операторов. Администратор добавляет их в офисе, в разделе «Операторы».",
      "badgePrompt": "Приложите бейдж к сканеру или войдите по табельному номеру.",
      "useLogin": "Войти по табельному номеру",
      "loginPrompt": "Наберите табельный номер.",
      "pinPrompt": "Табельный номер {{login}}. Наберите PIN.",
      "loginReadout": "Набранный табельный номер",
      "pinReadout": "Набранный PIN",
      "loginKeypad": "Клавиатура табельного номера",
      "pinKeypad": "Клавиатура PIN",
      "backspace": "Стереть",
      "clear": "Очистить",
      "back": "Назад",
      "next": "Далее",
      "submit": "Войти",
      "checking": "Проверяем…",
      "errors": {
        "wrongPin": "Неверный табельный номер или PIN.",
        "wrongBadge": "Бейдж не найден. Если бейдж новый, дождитесь синхронизации или обратитесь к администратору.",
        "ambiguousLogin": "Этот табельный номер есть у нескольких операторов. Обратитесь к администратору.",
        "ambiguousBadge": "Этот бейдж выдан нескольким операторам. Обратитесь к администратору.",
        "notReady": "Справочники операторов ещё не загружены с хоста. Вход станет доступен после синхронизации.",
        "productCode": "Это код товара, а не бейдж. Приложите бейдж.",
        "layout": "Сканер набирает в русской раскладке. Переключите раскладку на английскую и приложите бейдж ещё раз.",
        "notBadge": "Это не похоже на бейдж. Приложите бейдж ещё раз.",
        "lockedStation": "Слишком много неудачных попыток. Вход на этой станции приостановлен на {{minutes}} мин.",
        "lockedOperator": "Слишком много неверных PIN. Вход по PIN для этого табельного номера приостановлен на {{minutes}} мин. Можно войти по бейджу.",
        "failed": "Не удалось проверить вход на этом компьютере. Попробуйте ещё раз."
      },
      "notice": {
        "idle": "Оператор вышел по бездействию. Войдите снова.",
        "removed": "Оператор больше не может входить на станции. Обратитесь к администратору.",
        "lineChanged": "Станция перешла на другую линию. Войдите снова."
      }
    }
  },
```

4. В `apps/standalone/src/app/shell.css` фрагмент

<!-- prettier-ignore -->
```css
  justify-items: center;
  gap: 16px;
}
```

заменить на

<!-- prettier-ignore -->
```css
  justify-items: center;
  gap: 16px;
}

.floor-sign-in {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}

.floor-sign-in__prompt {
  font-size: 18px;
}

.floor-sign-in__readout {
  min-height: 40px;
  font-size: 28px;
  letter-spacing: 0.2em;
}

.floor-sign-in__message {
  min-height: 64px;
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx`
Expected: PASS — 1 файл, 13 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/operator-sign-in.test.tsx`
Expected: PASS, 13; stderr пуст. Затем тот же файл под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 13; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/floor/OperatorSignIn.tsx` пускать вторую проверку, пока идёт первая: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      if (inFlight.current) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "once, whatever arrives"`
Expected: FAIL — `× signs an operator in with a badge scan, once, whatever arrives during the check`, `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 2. В `apps/standalone/src/floor/OperatorSignIn.tsx` просить синхронизацию после любого отказа: фрагмент

<!-- prettier-ignore -->
```tsx
      if (
        result.kind === "refused" &&
        (result.reason === "wrong" || result.reason === "not_ready")
      ) {
```

заменить на

<!-- prettier-ignore -->
```tsx
      if (result.kind === "refused") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "words of its own"`
Expected: FAIL — `× explains a refused scan in words of its own, and asks for a sync only after an unknown badge`, `expected "vi.fn()" to be called 1 times, but got 3 times`.

Мутация 3. В `apps/standalone/src/floor/scan-source.ts` отдавать Enter скана кнопке в фокусе: удалить фрагмент

<!-- prettier-ignore -->
```ts
          event.preventDefault();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "focused button"`
Expected: FAIL — `× keeps the scan's Enter from also pressing the focused button`, `expected false to be true`.

Мутация 4. В `apps/standalone/src/floor/OperatorSignIn.tsx` не перечитывать копии после синхронизации: фрагмент

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, now, sync.synced, readAttempt]);
```

заменить на

<!-- prettier-ignore -->
```tsx
  }, [local, hostId, deviceId, now, readAttempt]);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-sign-in.test.tsx -t "after every sync"`
Expected: FAIL — `× reads the copies again after every sync`, `Unable to find an element with the text: /^В справочнике нет операторов\./`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/scan-source.ts apps/standalone/src/floor/OperatorSignIn.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-sign-in.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 62 файла, 1472 теста (1459 + 13).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/floor/scan-source.ts apps/standalone/src/floor/OperatorSignIn.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-sign-in.test.tsx
git commit -m "feat(standalone): экран входа оператора — бейдж, табельный номер и PIN" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Цех в приложении: экран входа, заглушка после входа, бездействие и проверка оператора после синхронизации

`App` показывает на виде `floor` экран входа задачи 5 (копии и сканер этого окна, `onSync` — `requestSync`, причина выхода — `floorNotice`) и на виде `floor_operator` заглушку `FloorOperatorScreen`: «Вошёл: имя, табельный номер», должность, что смены появятся в следующем обновлении, строка связи и «Сменить оператора»; прежний `FloorScreen` и ключ `floor.body` уходят. Заглушка запускает таймер бездействия (`createOperatorIdleLock` — перенос облачного, 10 минут, `pointerdown`, `keydown` и `touchstart` начинают ожидание заново) и после каждой удачной синхронизации спрашивает копии (`operatorStillAllowed`): оператора, которого в полных копиях этого подключения больше нет (офис выключил, запись ждёт в карантине), она выводит с причиной `removed`; копии, которые не прочитались или ещё не готовы, не выводят никого (офлайн прежде всего). Обработчики входа и выхода в `App` стоят до раннего возврата офиса (правило хуков) и стабильны по идентификатору устройства и оператора, иначе таймер бездействия начинался бы заново при каждом событии связи. Свойства `scanSource` и `idleTimeoutMs` у `App` — для тестов, как прежние внедряемые службы. Четыре прежних ожидания в `app.test.tsx` на экране цеха (`settle` в «the line the office assigns» и три паузы «exactly once» в «App») уходят внутрь `act`: экран входа читает копии после каждой синхронизации, и обновление его состояния вне `act` давало предупреждение React (на машине проверки плана — в одном прогоне из двух).

**Files:**

- Create: `apps/standalone/src/floor/idle-lock.ts`, `apps/standalone/src/floor/FloorOperatorScreen.tsx`
- Modify: `apps/standalone/src/floor/sign-in.ts` (`operatorStillAllowed`), `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/screens.tsx` (без `FloorScreen`), `apps/standalone/src/i18n/ru.json` (`floor.operator`, без `floor.body`)
- Test: `apps/standalone/test/floor-operator.test.tsx` (Create), `apps/standalone/test/app.test.tsx` (Modify)

**Interfaces:**

- Consumes: задачи 1–5.
- Produces:
  - `idle-lock.ts`: `OPERATOR_IDLE_TIMEOUT_MS = 600_000`, `createOperatorIdleLock({ target, onIdle, timeoutMs? }): { start(): void; stop(): void }`;
  - `sign-in.ts`: `operatorStillAllowed(context: SignInContext, operatorId: string): Promise<boolean>`;
  - `FloorOperatorScreen.tsx`: `interface FloorOperatorScreenProps { operator; local; pairing; link; sync; idleTimeoutMs?: number; onSignOut(notice: FloorNotice | null): void }`;
  - `App.tsx`: `AppProps.scanSource?: ScanSource`, `AppProps.idleTimeoutMs?: number`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/floor-operator.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, SyncState } from "../src/app/shell.js";
import { FloorOperatorScreen } from "../src/floor/FloorOperatorScreen.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import type { ChangeItem } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
};
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA.id,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: ANNA.name, role: ANNA.role, pinPhc: PIN_PHC },
};

async function synced(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

function renderFloor(local: LocalExecutor, sync: SyncState = SYNCED) {
  const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
  render(
    <ThemeProvider>
      <FloorOperatorScreen
        operator={ANNA}
        local={local}
        pairing={PAIRING}
        link={null}
        sync={sync}
        onSignOut={onSignOut}
      />
    </ThemeProvider>,
  );
  return onSignOut;
}

/** Two turns of React's effect scheduler, so a read started in an effect has settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe("the floor with an operator signed in", () => {
  it("names the operator and their role, and signs out on «Сменить оператора»", async () => {
    const onSignOut = renderFloor(await synced([OPERATOR]));
    expect(screen.getByText("Вошёл: Анна Кузнецова, табельный номер 0042.")).toBeTruthy();
    expect(screen.getByText("Упаковщик")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    expect(onSignOut).toHaveBeenCalledWith(null);
  });

  it("signs the operator out once the copies no longer hold them", async () => {
    const onSignOut = renderFloor(await synced([]));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("keeps the operator when the copies cannot be read or are not this pairing's yet", async () => {
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    const kept = renderFloor(failing);
    const { executor } = openLocalDb();
    const unsynced = renderFloor(executor);
    await settle();
    expect(kept).not.toHaveBeenCalled();
    expect(unsynced).not.toHaveBeenCalled();
  });
});

describe("the operator idle lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Once idle, it waits for nothing more until started again.
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it("stops listening when stopped", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    lock.stop();
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
```

2. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  local?: LocalExecutor;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
  local?: LocalExecutor;
  idleTimeoutMs?: number;
}
```

3. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    // `setImmediate` tasks, which `waitFor`'s `setTimeout(0)` does not wait for.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
```

заменить на

<!-- prettier-ignore -->
```tsx
    // `setImmediate` tasks, which `waitFor`'s `setTimeout(0)` does not wait for.
    // Inside `act`: the floor's sign-in reads the local copies meanwhile.
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(host.getChanges).toHaveBeenCalledTimes(1);
```

4. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    // have started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.getChanges).not.toHaveBeenCalled();
```

заменить на

<!-- prettier-ignore -->
```tsx
    // have started.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.getChanges).not.toHaveBeenCalled();
```

5. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    // Exactly once: settle, then check again (see the test above).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
```

заменить на

<!-- prettier-ignore -->
```tsx
    // Exactly once: settle, then check again (see the test above).
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(host.getChanges).toHaveBeenCalledTimes(1);
```

6. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx

  /** Lets every pending effect and timer task settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
```

заменить на

<!-- prettier-ignore -->
```tsx

  /**
   * Lets every pending effect and timer task settle, inside `act`: the
   * floor's sign-in reads the local copies after every sync.
   */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
```

7. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
  });
});

describe("the operator on the floor", () => {
  const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
  /** The PIN 4821 and the badge «MRK-000742» under the site's salt (`proto/fixtures`). */
  const PIN_PHC =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
  const BADGE_PHC =
    "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
  const PEOPLE: ChangeItem[] = [
    {
      entity: "site",
      id: "1",
      rev: 40,
      deleted: false,
      data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
    },
    {
      entity: "operators",
      id: ANNA,
      rev: 41,
      deleted: false,
      data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
    },
    {
      entity: "operator_badges",
      id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      rev: 42,
      deleted: false,
      data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
    },
  ];
  const SIGNED_IN = "Вошёл: Анна Кузнецова, табельный номер 0042.";

  function scan(text: string) {
    act(() => {
      for (const key of text) fireEvent.keyDown(window, { key });
      fireEvent.keyDown(window, { key: "Enter" });
    });
  }

  /** The app on a station whose first sync brings the site, Anna and her badge. */
  async function onTheFloor(idleTimeoutMs?: number) {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    });
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    return { link, host };
  }

  it("signs an operator in with a badge without asking the host, shows the floor's stub and signs out on request", async () => {
    const { host } = await onTheFloor();
    scan("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    // The sign-in read the local copies only: the one feed request is the start's sync.
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Офис" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    expect(
      await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру."),
    ).toBeTruthy();
    expect(screen.queryByText(/^Оператор вышел/)).toBeNull();
  });

  it("keeps the operator signed in while the host is away", async () => {
    const { link } = await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "unreachable",
      seq: 2,
    });
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it("signs the operator out after the idle timeout and says so", async () => {
    await onTheFloor(50);
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    expect(await screen.findByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it("signs the operator out once a sync brings the host's tombstone for them", async () => {
    const { link, host } = await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [{ entity: "operators", id: ANNA, rev: 43, deleted: true }]),
    );
    await link.revision(43);
    expect(
      await screen.findByText(
        "Оператор больше не может входить на станции. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
  });

  it("comes back from the office to the sign-in, with nobody signed in", async () => {
    await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(
      await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру."),
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-operator.test.tsx test/app.test.tsx`
Expected: FAIL — 2 файла, `Tests  5 failed | 66 passed (71)`: `floor-operator.test.tsx` не собирается (`Failed to resolve import "../src/floor/FloorOperatorScreen.js"` или `"../src/floor/idle-lock.js"` `from "test/floor-operator.test.tsx"` — Vite называет тот, что не нашёл первым); в `app.test.tsx` падают пять новых тестов «the operator on the floor» — прежний экран цеха не предлагает входа (`Unable to find an element with the text: Приложите бейдж к сканеру или войдите по табельному номеру.`).

- [ ] **Step 3: Заглушка цеха и экраны в приложении**

1. Создать `apps/standalone/src/floor/idle-lock.ts`:

<!-- prettier-ignore -->
```ts
/** Stage 1 spec §5.6: the cloud station's operator idle lock, unchanged. */
export const OPERATOR_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

type ActivityTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

interface OperatorIdleLockOptions {
  target: ActivityTarget;
  onIdle: () => void;
  timeoutMs?: number;
}

export interface OperatorIdleLock {
  start(): void;
  stop(): void;
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Calls `onIdle` once nobody pressed, clicked or touched anything for
 * `timeoutMs`; every such event starts the wait again. Ported from the cloud
 * station's `createOperatorIdleLock` (`apps/station/src/lib/operator-idle-lock.ts`).
 */
export function createOperatorIdleLock({
  target,
  onIdle,
  timeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
}: OperatorIdleLockOptions): OperatorIdleLock {
  let active = false;
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const activity = () => {
    if (!active) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      active = false;
      onIdle();
    }, timeoutMs);
  };
  const onActivity: EventListener = () => activity();
  const stop = () => {
    active = false;
    clearTimer();
    if (listening) {
      for (const eventName of ACTIVITY_EVENTS) target.removeEventListener(eventName, onActivity);
      listening = false;
    }
  };

  return {
    start() {
      stop();
      active = true;
      for (const eventName of ACTIVITY_EVENTS) target.addEventListener(eventName, onActivity);
      listening = true;
      activity();
    },
    stop,
  };
}
```

2. Создать `apps/standalone/src/floor/FloorOperatorScreen.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import { operatorStillAllowed, type FloorOperator } from "./sign-in.js";

export interface FloorOperatorScreenProps {
  operator: FloorOperator;
  local: LocalExecutor;
  pairing: Pairing;
  link: HostStatus | null;
  sync: SyncState;
  /** Nobody touched the station this long: the operator is signed out. */
  idleTimeoutMs?: number;
  /** `null` is the operator's own «Сменить оператора». */
  onSignOut: (notice: FloorNotice | null) => void;
}

/**
 * The floor with an operator signed in: stage 1's stub until the shifts of
 * plan 2a (spec §5.6). It names the operator and offers «Сменить оператора»;
 * the operator is signed out after `idleTimeoutMs` without a touch, and
 * after a sync that took the operator out of this pairing's copies (the host
 * turned them off). A failed read of the copies signs nobody out: the floor
 * works offline.
 */
export function FloorOperatorScreen({
  operator,
  local,
  pairing,
  link,
  sync,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
  onSignOut,
}: FloorOperatorScreenProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    const lock = createOperatorIdleLock({
      target: window,
      timeoutMs: idleTimeoutMs,
      onIdle: () => onSignOut("idle"),
    });
    lock.start();
    return () => lock.stop();
  }, [idleTimeoutMs, onSignOut]);

  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    operatorStillAllowed({ local, pairing: { hostId, deviceId }, now: Date.now }, operator.id).then(
      (allowed) => {
        if (!cancelled && !allowed) onSignOut("removed");
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, operator.id, sync.synced, onSignOut]);

  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <p className="floor-sign-in__prompt">
          {t("floor.operator.signedIn", { name: operator.name, login: operator.login })}
        </p>
        {operator.role !== null && <p>{operator.role}</p>}
        <p>{t("floor.operator.stub")}</p>
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" onClick={() => onSignOut(null)}>
            {t("floor.operator.signOut")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

3. В `apps/standalone/src/floor/sign-in.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return signedIn(local, holder);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  return signedIn(local, holder);
}

const OPERATOR_PRESENT = `SELECT o.id FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * Whether the signed-in operator would still be let in, after a sync:
 * `false` only when this pairing's copies are complete and no longer hold
 * the operator (the host turned them off, or their record waits in
 * quarantine). Copies that are not complete say nothing either way.
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

4. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { FloorOperatorScreen } from "../floor/FloorOperatorScreen.js";
import { OperatorSignIn } from "../floor/OperatorSignIn.js";
import { createKeyboardWedgeSource, type ScanSource } from "../floor/scan-source.js";
import type { FloorOperator } from "../floor/sign-in.js";
```

5. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  DeviceRejectedScreen,
  FloorScreen,
  HostMissingScreen,
```

заменить на

<!-- prettier-ignore -->
```tsx
  DeviceRejectedScreen,
  HostMissingScreen,
```

6. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  shellReducer,
} from "./shell.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
  shellReducer,
  type FloorNotice,
} from "./shell.js";
```

7. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  address?: string;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
  address?: string;
  /** Where the floor's badge scans come from; the keyboard wedge on this window by default. */
  scanSource?: ScanSource;
  /** How long a signed-in operator may leave the station untouched; tests shorten it. */
  idleTimeoutMs?: number;
}
```

8. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  address = LOCAL_HOST_ADDRESS,
}: AppProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  address = LOCAL_HOST_ADDRESS,
  scanSource,
  idleTimeoutMs,
}: AppProps) {
```

9. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const localDb = useMemo(() => local ?? createTauriLocalExecutor(), [local]);
  const scanner = useMemo(() => scanSource ?? createKeyboardWedgeSource(), [scanSource]);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
```

10. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx

  const session = view.kind === "office" ? view.session : null;
```

заменить на

<!-- prettier-ignore -->
```tsx

  const pairedDeviceId = pairedStatus?.deviceId ?? null;
  const operatorSignedIn = useCallback(
    (operator: FloorOperator) => {
      if (pairedDeviceId !== null) {
        dispatch({ type: "operator_signed_in", deviceId: pairedDeviceId, operator });
      }
    },
    [pairedDeviceId],
  );
  const signedInId = state.operator?.id ?? null;
  const operatorSignedOut = useCallback(
    (notice: FloorNotice | null) => {
      if (signedInId !== null) {
        dispatch({ type: "operator_signed_out", operatorId: signedInId, notice });
      }
    },
    [signedInId],
  );

  const session = view.kind === "office" ? view.session : null;
```

11. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      )}
      {view.kind === "floor" && (
        <FloorScreen
          link={state.link}
          sync={state.sync}
          onOffice={() => dispatch({ type: "office_requested" })}
        />
```

заменить на

<!-- prettier-ignore -->
```tsx
      )}
      {view.kind === "floor" && pairedStatus !== null && (
        <OperatorSignIn
          local={localDb}
          pairing={pairedStatus}
          link={state.link}
          sync={state.sync}
          notice={state.floorNotice}
          source={scanner}
          onSignedIn={operatorSignedIn}
          onSync={requestSync}
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
```

12. В `apps/standalone/src/app/screens.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { HostProbeErrorCode } from "../host/probe.js";
import type { HostStatus } from "../host/protocol.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { RejectionReason, SyncState } from "./shell.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { HostProbeErrorCode } from "../host/probe.js";
import type { RejectionReason } from "./shell.js";
```

13. В `apps/standalone/src/app/screens.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
}

/**
 * The floor placeholder until plan 1f: the link to the host, the health of
 * the local copies and the way into the office.
 */
export function FloorScreen({
  link,
  sync,
  onOffice,
}: {
  link: HostStatus | null;
  sync: SyncState;
  onOffice: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("floor.body")}</p>
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          <Button onClick={onOffice}>{t("floor.office")}</Button>
        </div>
      </div>
    </Card>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
}
```

14. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
    "title": "Цех",
    "body": "Рабочий экран цеха появится в следующем обновлении. Отсюда можно перейти в офис.",
    "office": "Офис",
    "signIn": {
```

заменить на

<!-- prettier-ignore -->
```json
    "title": "Цех",
    "office": "Офис",
    "operator": {
      "signedIn": "Вошёл: {{name}}, табельный номер {{login}}.",
      "stub": "Смены и сканирование продукции появятся в следующем обновлении.",
      "signOut": "Сменить оператора"
    },
    "signIn": {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-operator.test.tsx test/app.test.tsx`
Expected: PASS — 2 файла, 76 тестов (`floor-operator` 5, `app` 71).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/floor-operator.test.tsx test/app.test.tsx`
Expected: PASS, 76; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS, 76; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/floor/FloorOperatorScreen.tsx` не запускать таймер бездействия: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    lock.start();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "idle timeout"`
Expected: FAIL — `× signs the operator out after the idle timeout and says so`, `Unable to find an element with the text: Оператор вышел по бездействию. Войдите снова.`

Мутация 2. В `apps/standalone/src/floor/FloorOperatorScreen.tsx` не выводить оператора, которого нет в копиях: фрагмент

<!-- prettier-ignore -->
```tsx
        if (!cancelled && !allowed) onSignOut("removed");
```

заменить на

<!-- prettier-ignore -->
```tsx
        if (!cancelled && !allowed) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-operator.test.tsx test/app.test.tsx -t "no longer hold them|tombstone for them"`
Expected: FAIL — 2 файла, 2 теста: `× signs the operator out once the copies no longer hold them` (`expected "vi.fn()" to be called with arguments: [ 'removed' ]`) и `× signs the operator out once a sync brings the host's tombstone for them` (`Unable to find an element with the text: Оператор больше не может входить на станции. Обратитесь к администратору.`).

Мутация 3. В `apps/standalone/src/floor/sign-in.ts` выводить оператора, пока копии не готовы: фрагмент

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(context.local, context.pairing))) return true;
```

заменить на

<!-- prettier-ignore -->
```ts
  if (!(await copiesReady(context.local, context.pairing))) return false;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-operator.test.tsx -t "cannot be read or are not"`
Expected: FAIL — `× keeps the operator when the copies cannot be read or are not this pairing's yet`, `expected "vi.fn()" to not be called at all, but actually been called 1 times`.

Мутация 4. В `apps/standalone/src/app/App.tsx` не показывать причину выхода: фрагмент

<!-- prettier-ignore -->
```tsx
          notice={state.floorNotice}
```

заменить на

<!-- prettier-ignore -->
```tsx
          notice={null}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "idle timeout"`
Expected: FAIL — `× signs the operator out after the idle timeout and says so`, `Unable to find an element with the text: Оператор вышел по бездействию. Войдите снова.`

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/floor/idle-lock.ts apps/standalone/src/floor/FloorOperatorScreen.tsx apps/standalone/src/floor/sign-in.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-operator.test.tsx apps/standalone/test/app.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `grep -rn '"floor.body"\|floor\.body\|FloorScreen\b' apps/standalone/src apps/standalone/test`
Expected: чисто; первый `grep` находит только `src/host/pairing-code.ts:66`, второй — ничего.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок и предупреждений.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 63 файла, 1482 теста (1472 + 10: `floor-operator` 5, `app` 5).

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/floor/idle-lock.ts apps/standalone/src/floor/FloorOperatorScreen.tsx apps/standalone/src/floor/sign-in.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-operator.test.tsx apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): цех — вход оператора, заглушка после входа, выход по бездействию" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Документы: вход оператора в `AGENTS.md` и спецификации

Задачи 1–6 меняли только код и тесты; эта задача приводит к ним документы. `AGENTS.md`: «Change feed» — запись бейджа требует запись своего оператора при входе станции (`src/floor/sign-in.ts`); «Operators and badges» — правила плана 1f из будущего времени становятся описанием сделанного (копии этого подключения, номер и PIN, скан и бейдж, блокировки и их числа, сеанс оператора и его выходы), а предусловие о `hostGuard` — выполненным; «Local database» — `floor_sign_in_failures` как одноразовые данные самого устройства; «Reference sync» — `pairingGuard`, метка подключения и `copiesReady` вместо `hostGuard` и `host_id`; «App shell» — виды `floor` и `floor_operator`; «Office pages» и «Logs» — без «плана 1f» в будущем времени. Спецификация: §5.3 (`sync_state` хранит подключение; новая таблица), §5.4 (другое подключение стирает копии), §5.6 (что сделано, числа блокировок, заглушка, что ушло в 1f2) и абзац под таблицей §8 о разбиении 1f на 1f1 и 1f2 (строка таблицы не меняется: её ширина переформатировала бы всю таблицу).

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

**Interfaces:**

- Consumes: задачи 1–6.
- Produces: документы; кода не меняет.

- [ ] **Step 1: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
hashes. Every
table here is treated as a disposable copy of the host's data: the first
plan that adds data this device owns instead of copies — the scan journal,
boxes, the outbox (the design's §6.2, "Логическая модель") — must exclude
those tables from `clear_copies`, keep `remove_unopened` from deleting
them, and block or confirm a forget while unsynced records exist, not
extend this list silently. If clearing or removing fails, the command fails
with `storage` and the pairing stays for another try.
```

заменить на

<!-- prettier-ignore -->
```text
hashes. Every
table here is disposable: the copies of the host's data, and
`floor_sign_in_failures` (`src-tauri/migrations/0005_floor_sign_in_failures.sql`,
plan 1f), this device's own failed sign-ins, which a forget clears on
purpose (a new pairing brings a new roster). The first plan that adds data
this device must keep — the scan journal, boxes, the outbox (the design's
§6.2, "Логическая модель") — must exclude those tables from `clear_copies`,
keep `remove_unopened` from deleting them, and block or confirm a forget
while unsynced records exist, not extend this list silently. If clearing or removing fails, the command fails
with `storage` and the pairing stays for another try.
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
replaces the hash and the old PIN stops working. A badge record never grants
access on its own: the station's operator login (plan 1f) requires the record
of its `operatorId`.
```

заменить на

<!-- prettier-ignore -->
```text
replaces the hash and the old PIN stops working. A badge record never grants
access on its own: the station's sign-in (`src/floor/sign-in.ts`) requires the
record of its `operatorId`.
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
badges unique, and a copy that refused a row would abort its whole page and
stop the sync for good. Rules for the station's sign-in (plan 1f): it reads
these copies only on the floor screen of a paired device that is not
rejected. The hashes already on disk stay when the host revokes the device
or its certificate changes, and only a forget clears them, so such a device
must keep showing no floor, as `nextShellView` does today: the
rejected-device screen comes first. A scan is trimmed as `badgeCodeRule`
trims a code, and a Cyrillic one is refused with the hint to switch the
layout, never read by key position. A badge is found by hashing the trimmed
scan with `ref_site.badge_salt` and comparing whole strings, and it signs in
only with the record of its `operatorId`; a badge that matches more than one
active operator is refused as ambiguous, never resolved to the first.
Precondition: the sign-in must not read the copies until the sync's
`hostGuard` is scoped to the pairing, not only to the host (the device id
stored in `sync_state` next to `host_id` and checked with it). Today a stale
page fetched before a `device_forget` passes the guard after a re-pair to the
same host, brings back a record a tombstone deleted (a turned-off operator, a
revoked badge) and rolls `last_rev` back until the next sync;
`notQuarantinedNewer` covers only the quarantine case.
```

заменить на

<!-- prettier-ignore -->
```text
badges unique, and a copy that refused a row would abort its whole page and
stop the sync for good.

The station's sign-in (plan 1f; `src/floor/sign-in.ts`, the screen
`src/floor/OperatorSignIn.tsx`) never calls the host. It reads these copies
only on the floor of a paired device that is not rejected, and only while
they are this pairing's complete copies (`copiesReady`: `sync_state`'s
`host_id` and `device_id` name this pairing, its `entity_set` is this
build's and a `last_rev` is there). The hashes already on disk stay when the
host revokes the device or its certificate changes, and only a forget clears
them, so such a device keeps showing no floor: `nextShellView` puts the
rejected-device screen first. A record waiting in `sync_quarantine` signs
nobody in, whatever its revision (fail-closed).

- A personnel number (3–12 digits, never padded) must name exactly one copy;
  a number two copies share is refused as ambiguous. The PIN (4–6 digits) is
  checked with the domain's `verifyPhc`, which compares in constant time, at
  the count the hash carries (the sync accepted 10 000–1 000 000). Every
  well-formed attempt costs one full PBKDF2: an unknown number is verified
  against `DUMMY_PIN_PHC` (the domain's 100 000 iterations), so the answer's
  time does not tell numbers apart. The operator's copy is read again after
  the verification, and a PIN change or a turn-off that landed meanwhile
  wins.
- A scan with a GS1 group separator (`\u001d`) is a product's code, not a
  badge; a Cyrillic one is refused with the hint to switch the layout, never
  read by key position; anything else that is not 1–256 printable ASCII
  characters after trimming (as `badgeCodeRule` trims a code) is no badge.
  None of these is hashed or counted. A badge is found by hashing the trimmed
  scan once with `ref_site.badge_salt` at exactly `BADGE_ITERATIONS` and
  comparing whole strings, and it signs in only with the record of its
  `operatorId`; a badge that matches more than one operator is refused as
  ambiguous, never resolved to the first.
- Lockouts live in `floor_sign_in_failures` (`src/floor/lockout.ts`), so a
  restart does not reset them: ten failures in a row on the station
  (`STATION_LOCKOUT`, wrong PINs, unknown numbers and unknown badges alike)
  pause every sign-in for one minute, and five wrong PINs for one operator
  (`OPERATOR_LOCKOUT`) lock that operator's PIN for five minutes; the
  operator's badge still signs them in. A lockout is answered before any
  hashing. After a lockout runs out the count starts again; a sign-in that
  goes through forgets the station's failures and the operator's. Time is
  this computer's clock: a clock moved back behind a lockout's start starts
  the lockout again from now, never longer than its duration. The counter is
  keyed by operator id, never by a typed number. An unknown credential asks
  for a reference sync at once (the cloud station refreshes its roster
  before refusing); the next attempt reads what it brought.
- The signed-in operator lives only in the shell's memory
  (`ShellState.operator`): identity, never a hash. The office never inherits
  one (opening it signs the operator out), and a new pairing, a forget, a
  rejected device, another host and a change of the station's line sign the
  operator out too, as do «Сменить оператора», ten minutes without a touch
  (`OPERATOR_IDLE_TIMEOUT_MS`, the cloud station's) and a successful sync
  after which the copies no longer hold the operator. The link going down
  signs nobody out: the floor works offline. A sign-in answer that lands
  after the pairing changed, the device was rejected or the office opened
  signs nobody in (`operator_signed_in` carries the device id). What an
  operator may do on the line is plan 2a's; stage 1 shows a stub.

The precondition plan 1d4 named holds: the sync's guard is scoped to the
pairing (`pairingGuard`, see «Reference sync»), so a page fetched before a
`device_forget` cannot land after a re-pair to the same host and bring back a
record a tombstone deleted.
```

4. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
(stage 1 spec §5.4). `syncReferences` reads `sync_state` (`last_rev`,
`host_id`, `entity_set`) and fetches `GET /v1/changes?since=<last_rev>`
(`HostApi.getChanges`, the device key only) until `hasMore` is false. Each
page is one `local_transaction`: a `hostGuard` statement first (below),
then per entity one conditional delete for its tombstones and quarantined
```

заменить на

<!-- prettier-ignore -->
```text
(stage 1 spec §5.4). `syncReferences` reads `sync_state` (`last_rev`,
`host_id`, `device_id`, `entity_set`) and fetches `GET /v1/changes?since=<last_rev>`
(`HostApi.getChanges`, the device key only) until `hasMore` is false. Each
page is one `local_transaction`: a `pairingGuard` statement first (below),
then per entity one conditional delete for its tombstones and quarantined
```

5. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`org_profile`, `site` and `lines` upserts have no such guard (plan 2a).
The feed never sends an older revision after a newer one, but a stale run
can: a page fetched before `device_forget` that lands only after a new
pairing with the same host has stamped `host_id` again. `hostGuard` (below)
stops such a page until that stamp, not after it. The same late page can
still put back a record the new run deleted by tombstone, and it moves
`last_rev` back to its own revision, so the next sync fetches that tombstone
again and deletes the record anew (for one late page; two late pages of one
station landing oldest first can keep the record for good, which only the
pairing-scoped guard of plan 1f closes).
The copies, and the quarantine with them, start from zero when `host_id`
names another host, when
`entity_set` is not this build's `ENTITY_SET`, or when the feed answers
```

заменить на

<!-- prettier-ignore -->
```text
`org_profile`, `site` and `lines` upserts have no such guard (plan 2a).
The feed never sends an older revision after a newer one; a stale run's
page could (one fetched before `device_forget` that lands after a new
pairing with the same host), and `pairingGuard` (below) stops it since plan
1f: `notQuarantinedNewer` stays as a second line of defence.
The copies, and the quarantine with them, start from zero when `sync_state`
names another pairing (another `host_id`, or another `device_id` with the
same host: the host gives every pairing a new device id), when
`entity_set` is not this build's `ENTITY_SET`, or when the feed answers
```

6. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
last two drop the old copies in the transaction of the first new page, so
a failed fetch keeps them. The first — a re-pair, or this device's very
first sync when no `host_id` is stored at all — stamps `sync_state.host_id`
to this run's host before the first fetch (a re-pair wipes in the same
transaction, since another host's records must not stay usable; a first
sync has nothing to wipe, since there are never copies without a
`host_id`), with no `last_rev`: the copies still read as unsynced. The
continuing branch (this run's `hostId` already stored, with a matching
`entity_set` and a `last_rev`) leaves that stamp alone, since a completed
run always wrote it together with `last_rev` and `entity_set`, and is taken
only when the stored `host_id` actually equals this run's — a state some
other build left with `entity_set` and `last_rev` but no matching `host_id`
falls through to the branch that stamps instead of failing forever.
`hostGuard` (`UPDATE sync_state SET value = value WHERE key = 'host_id' AND
value = ?` with `expectedChanges: 1`, first in every batch, before any
statement that could touch the `host_id` row it reads) requires that stamp
to still be there and still equal this run's `hostId`: it aborts a stale
in-flight sync for the wrong host with `changes_mismatch` once its page
finally arrives, in every ordering — including two first syncs racing each
other before either has stamped anything. `SyncScheduler.stop` cannot
cancel a request already sent, and without this guard a late page for the
old host would win `excluded.rev > rev` against the new host's rows under
the same ids (`ref_org`/`ref_site` are keyed `'1'` on every host). The same
guard also catches a page that outlives `device_forget`'s `clear_copies`,
until a new pairing with the same host stamps `host_id` again (as above):
`clear_copies` deletes the `host_id` row along with everything else, and
without the guard requiring the row to still match, a page fetched before
the forget and committed after the clear would find nothing to conflict with
and rewrite the old pairing's copies into a device that was told to forget
them. A feed from another host than the paired one stops the sync with
`other_host` and applies nothing. `createSyncScheduler` runs one sync at a time: triggers during a
```

заменить на

<!-- prettier-ignore -->
```text
last two drop the old copies in the transaction of the first new page, so
a failed fetch keeps them. Another pairing wipes at once, in the transaction
that stamps this run's pairing (`host_id` and `device_id`) before the first
fetch, since another pairing's records must not stay usable, with no
`last_rev`: the copies still read as unsynced. A state without a complete
stamp — this device's very first sync, or a state an older build left with
`host_id` alone — gets the stamp before the first fetch as well, and loses
its `last_rev` with it, so copies nobody can tie to this pairing read as
unsynced (`copiesReady`) until the first page replaces them. The
continuing branch (this run's `hostId` and `deviceId` already stored, with
a matching `entity_set` and a `last_rev`) leaves the stamp alone, since a
completed run always wrote it together with `last_rev` and `entity_set`.
`pairingGuard` (`UPDATE sync_state SET value = value WHERE (key = 'host_id'
AND value = ?) OR (key = 'device_id' AND value = ?)` with
`expectedChanges: 2`, first in every batch, before any statement that could
touch the rows it reads) requires that stamp to still be there and still
name this run's pairing: it aborts a stale in-flight sync for the wrong
pairing with `changes_mismatch` once its page finally arrives, in every
ordering — including two first syncs racing each other before either has
stamped anything. `SyncScheduler.stop` cannot cancel a request already
sent, and without this guard a late page for the old host would win
`excluded.rev > rev` against the new host's rows under the same ids
(`ref_org`/`ref_site` are keyed `'1'` on every host). The same guard
catches a page that outlives `device_forget`'s `clear_copies`
(`clear_copies` deletes the stamp along with everything else), and a page
of the old pairing that lands after a new pairing with the same host
stamped `host_id` to the same value again: its `device_id` no longer
matches, so it cannot bring back a record a tombstone of the new pairing
deleted (a turned-off operator, a revoked badge) nor move `last_rev` back.
The station's sign-in reads the copies, so this guard is its precondition.
A feed from another host than the paired one stops the sync with
`other_host` and applies nothing. `createSyncScheduler` runs one sync at a time: triggers during a
```

7. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
host, the local host's version and identity, then the office or the floor.
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
```

заменить на

<!-- prettier-ignore -->
```text
host, the local host's version and identity, then the office or the floor.
The floor is the operator sign-in (`floor`), or, with an operator signed in,
stage 1's stub (`floor_operator`, `src/floor/FloorOperatorScreen.tsx`); see
«Operators and badges» for both.
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
```

8. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
  detects it: the badge then matches no station, and the remedy is to revoke
  it and add it again (plan 1f's sign-in test is the first place it shows). It
  is accepted, since a scan of about 0.1 s has to straddle a boundary. The
```

заменить на

<!-- prettier-ignore -->
```text
  detects it: the badge then matches no station, and the remedy is to revoke
  it and add it again (the station's sign-in is the first place it shows). It
  is accepted, since a scan of about 0.1 s has to straddle a boundary. The
```

9. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one; plan 1f will handle them), any hash or the TLS private
key. A label template's layout is no secret, but at up to 256 KB it stays
```

заменить на

<!-- prettier-ignore -->
```text
Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one: the sign-in neither logs nor keeps it, and
`test/floor-sign-in.test.ts` checks the console stays silent), any hash or the TLS private
key. A label template's layout is no secret, but at up to 256 KB it stays
```

10. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
`ref_products`, `ref_templates`, `ref_template_defaults` — копии записей ленты с их
`rev`; `sync_state(key, value)` — последняя применённая ревизия и идентичность хоста;
`sync_quarantine(entity, id, rev, reason, seen_at)` — записи ленты, которые не прошли
```

заменить на

<!-- prettier-ignore -->
```text
`ref_products`, `ref_templates`, `ref_template_defaults` — копии записей ленты с их
`rev`; `sync_state(key, value)` — последняя применённая ревизия и подключение, которому
принадлежат копии (хост и идентификатор устройства, план 1f);
`sync_quarantine(entity, id, rev, reason, seen_at)` — записи ленты, которые не прошли
```

11. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text

### 5.4. Синхронизация справочников
```

заменить на

<!-- prettier-ignore -->
```text

План 1f добавляет `floor_sign_in_failures(key, failures, locked_at)` (миграция
`0005_floor_sign_in_failures.sql`) — неудачные входы операторов на этой
станции: строка станции и строка оператора по его идентификатору (никогда не
набранный табельный номер, PIN или код бейджа). Это первые данные самого
устройства, а не копия, но одноразовые: `device_forget` очищает их вместе с
копиями (новое подключение — новый справочник).

### 5.4. Синхронизация справочников
```

12. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text
  устройство один раз синхронизируется с нуля;
- копии и карантин начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
  сразу: записи чужого хоста не должны оставаться в работе), если сохранённый набор
  сущностей (`entity_set`) не совпадает с набором этой сборки или если лента ответила
```

заменить на

<!-- prettier-ignore -->
```text
  устройство один раз синхронизируется с нуля;
- копии и карантин начинаются с нуля, если `sync_state` называет другое подключение —
  другой хост или другой идентификатор устройства у того же хоста (очистка
  сразу: записи чужого подключения не должны оставаться в работе), если сохранённый набор
  сущностей (`entity_set`) не совпадает с набором этой сборки или если лента ответила
```

13. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text

- Экран входа переносится из `apps/station/src/pages/OperatorLogin.tsx`: бейдж,
  табельный номер и PIN, поиск по имени. Проверка — `apps/station/src/lib/auth.ts` и
  `crypto.ts` без изменений алгоритма, данные — из `ref_operators` и
  `ref_operator_badges` через исполнитель локальной базы. Бейдж хешируется солью из
  `ref_site`. Исключение из «без изменений алгоритма» — правила входа плана 1f в
  `apps/standalone/AGENTS.md` («Rules for the station's sign-in»): `auth.ts` станции
  не обрезает скан и возвращает первого оператора с совпавшим хешем, а здесь скан
  обрезается и хешируется один раз, строки сравниваются целиком, а бейдж,
  совпавший у нескольких действующих операторов, отвергается как неоднозначный.
  Онлайн-обновление списка перед отказом заменяется немедленной синхронизацией
  справочников.
- Источник сканов на этапе 1 — клавиатурный сканер (`createKeyboardWedgeSource`);
  COM-сканеры появятся с настройкой рабочего места на этапе 2a.
- Блокировка при бездействии — `operator-idle-lock.ts` без изменений (10 минут).
- Строка состояния — перенесённый `StatusBar`: станция, линия, оператор, связь с
  хостом.
- После входа — экран-заглушка с именем оператора и кнопкой «Сменить оператора».
```

заменить на

<!-- prettier-ignore -->
```text

- Экран входа (план 1f, `src/floor/OperatorSignIn.tsx`) — по образцу
  `apps/station/src/pages/OperatorLogin.tsx`: бейдж в любой момент, табельный
  номер и PIN на цифровой клавиатуре; поиск по имени — в плане 1f2. Проверка
  (`src/floor/sign-in.ts`) — алгоритм `apps/station/src/lib/auth.ts` и функции
  `@markiro/domain` (`verifyPhc` сравнивает за постоянное время; неизвестный
  табельный номер проверяется по фиктивному хешу той же стоимости), данные — только
  из `ref_operators` и `ref_operator_badges` через исполнитель локальной базы и
  только когда копии принадлежат этому подключению и полны; запись в карантине
  не впускает никого. Бейдж хешируется солью из `ref_site`. Исключения из
  алгоритма станции — правила входа в `apps/standalone/AGENTS.md` («Operators and
  badges»): скан обрезается и хешируется один раз, строки сравниваются целиком,
  бейдж, совпавший у нескольких операторов, и табельный номер, который есть у
  нескольких копий, отвергаются как неоднозначные; скан с разделителем групп GS1 —
  код товара, а не бейдж; короткий табельный номер не дополняется нулями.
  Онлайн-обновление списка перед отказом заменяется немедленной синхронизацией
  справочников.
- Блокировки после неудачных попыток (план 1f, `src/floor/lockout.ts`, таблица
  `floor_sign_in_failures`, переживают перезапуск): 10 неудач подряд на станции
  приостанавливают любой вход на 1 минуту, 5 неверных PIN одного оператора — его
  вход по PIN на 5 минут (бейдж при этом впускает); блокировка отвечает до
  хеширования. Время — часы этого ПК; часы, отведённые назад, начинают блокировку
  заново, не дольше её длительности. Числа — предложение плана, ждут решения
  владельца.
- Источник сканов на этапе 1 — клавиатурный сканер (`createKeyboardWedgeSource`);
  COM-сканеры появятся с настройкой рабочего места на этапе 2a.
- Блокировка при бездействии — `operator-idle-lock.ts` без изменений (10 минут,
  `src/floor/idle-lock.ts`).
- Строка состояния — перенесённый `StatusBar`: станция, линия, оператор, связь с
  хостом (план 1f2; в плане 1f1 — строка связи `HostStatusLine`).
- После входа — экран-заглушка с именем оператора и кнопкой «Сменить оператора».
  Оператор живёт только в памяти оболочки; офис его не наследует, а выход из
  офиса возвращает к экрану входа. Оператор выходит и при новом подключении,
  отказе устройства, смене линии офисом, бездействии и синхронизации, после
  которой его нет в копиях; потеря связи с хостом никого не выводит.
```

14. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` фрагмент

<!-- prettier-ignore -->
```text

## 9. `apps/standalone/AGENTS.md` (создаётся в плане 1a)
```

заменить на

<!-- prettier-ignore -->
```text

План 1f разбит на 1f1 (`docs/superpowers/plans/2026-10-07-standalone-1f-station-operator-signin.md`:
копии, привязанные к подключению, вход оператора по PIN и бейджу офлайн,
блокировки после неудачных попыток, сеанс оператора и заглушка цеха) и 1f2
(киоск-режим оболочки и выход из него, поиск оператора по имени, строка
состояния цеха — схемой в конце того же плана).

## 9. `apps/standalone/AGENTS.md` (создаётся в плане 1a)
```

- [ ] **Step 2: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -n 'hostGuard\|plan 1f will\|plan 1f.s sign-in test' apps/standalone/AGENTS.md`
Expected: чисто; `grep` ничего не находит.

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "docs(standalone): вход оператора на станции, блокировки и копии подключения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 63 файла, 1482 теста (до плана 59 и 1418; +4 файла, +64 теста).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/reference-sync.test.ts test/floor-sign-in.test.ts test/floor-lockout.test.ts test/local-executor.test.ts test/shell.test.ts test/operator-sign-in.test.tsx test/floor-operator.test.tsx test/app.test.tsx`
Expected: PASS — 8 файлов, 279 тестов; stderr пуст. Затем `test/operator-sign-in.test.tsx`, `test/floor-operator.test.tsx` и `test/app.test.tsx` под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB (главный чанк вырос примерно с 876 до 892 kB, на 16 kB: экран входа, заглушка, модули входа и блокировок).

- [ ] **Step 2: Cargo**

Оболочка встраивает сборку вебвью из шага 1 (`apps/standalone/dist`), поэтому Cargo идёт после неё. Новых тестов Rust план не добавляет: меняется список таблиц в `tests/local_db.rs`.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --no-run`
Expected: чисто; сборка всех наборов без предупреждений.

Run (в песочнице): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test local_db`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: PASS — оболочка (библиотека и `local_db`): 55 тестов в 2 наборах; `proto`: 39 тестов в 3 наборах.

Run (вне песочницы — наборы открывают сокеты на loopback): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
Expected: PASS — 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107), как до плана. В песочнице эта же команда падает на `bind` (`cannot listen on 127.0.0.1:0: Operation not permitted`) в 47 тестах 11 наборов: хост — `changes_stream`, `hello`, `no_secrets_in_logs`, `platform`; оболочка — `claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `ipc`, `line`.

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check dbd2867cc`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat dbd2867cc -- apps/station packages apps/standalone/host apps/standalone/proto pnpm-lock.yaml apps/standalone/package.json apps/standalone/src-tauri/Cargo.toml apps/standalone/Cargo.lock`
Expected: пусто (D1).

- [ ] **Step 4: Что не проверить в песочнице и без Windows**

Записать в отчёт, что не проверено (а не «проверено»):

- настоящий клавиатурный сканер: бейдж вводится событиями `keydown` в jsdom; не проверены скорость ввода сканера в WebView2 (отдельные `keydown` на символ и Enter в конце), раскладки RU/EN и Caps Lock на заводском ПК, и как конкретный сканер шлёт разделитель групп GS1 (символ `\u001d` в `key`, сочетание `Ctrl+]` или ничего) — от этого зависит, узнаётся ли код товара как код товара или как «не бейдж»;
- время PBKDF2 в WebView2 на заводском ПК: 100 000 итераций WebCrypto в Node на машине проверки плана — десятки миллисекунд; на слабом ПК вход по бейджу и PIN может занимать сотни миллисекунд, экран всё это время показывает «Проверяем…»;
- раскладка экрана входа и заглушки на настоящем экране и сенсоре, размер клавиш `PinPad` в перчатках, озвучивание живой области скринридером;
- бездействие считается событиями окна: сканы на заглушке тоже продлевают сеанс (это `keydown`), а касание вне окна (другое окно поверх) — нет; в киоск-режиме (1f2) другого окна нет;
- поведение на живом хосте и второй станции: выключение оператора в офисе доходит до станции за одну синхронизацию — проверено тестами с поддельной лентой, вживую нет;
- киоск-режим, выход из него и Windows вообще — часть 1f2.

---

## Часть 1f2 — схема (пишется отдельным планом после ревью 1f1)

Цель: станция работает как киоск — полноэкранное окно без рамки, поверх остальных, без кнопки на панели задач, закрыть его нельзя; выход в оконный режим — только для администратора из офиса; на экране входа есть поиск оператора по имени, в цехе — строка состояния. Задачи ниже — не исполняемый план, а точная схема: код для них пишется отдельным планом и проверяется тем же способом, что задачи 1–7.

### Task 8 (схема): киоск-режим в оболочке (Rust)

- `src-tauri/src/lockdown.rs` — перенос `apps/station/src-tauri/src/commands.rs`: `LockdownState(Mutex<bool>)`, команды `enter_lockdown` (без рамки, без панели задач, поверх, во весь экран; на Windows `cover_current_monitor` через `SetWindowPos(HWND_TOPMOST, …)` по `MonitorFromWindow`/`GetMonitorInfoW`; откат всех свойств при сбое) и `exit_lockdown` (восстанавливает всё, флаг снимается всегда, чтобы оператор не оказался заперт). `lib.rs` регистрирует их в `invoke_handler`, держит `LockdownState` и в `on_window_event` отменяет `CloseRequested`, пока флаг стоит.
- Шаг владельца (правка манифеста, не новый крейт, D1): в `apps/standalone/src-tauri/Cargo.toml` строка `windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }` становится `windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Security_Cryptography", "Win32_UI_WindowsAndMessaging"] }`. `Cargo.lock` при этом не меняется (возможности `windows-sys` не тянут новых пакетов); проверка — `git diff --stat apps/standalone/Cargo.lock` пусто и `cargo check --target x86_64-pc-windows-msvc` в задании `standalone-windows-build`.
- Тесты: `tests/ipc.rs` фиксирует имена команд и голую строку отказа без окна («No main window» становится кодом `no_window`, как прочие отказы оболочки); `LockdownState` по умолчанию снят. Окно Tauri в mock runtime не создаётся: свойства окна, отмена закрытия и `SetWindowPos` проверяются только вручную на Windows.

### Task 9 (схема): жизненный цикл киоск-режима в вебвью и выход для администратора

- `src/floor/lockdown.ts` — перенос облачного `createLockdownLifecycle` (последовательные команды, повтор после сбоя, ошибка без текста IPC в журнале), `App` входит в киоск-режим при старте вне режима разработки (`import.meta.env.DEV`) и снова — при выходе из офиса.
- Выход: в шапке офиса администратор (не технолог) видит «Оконный режим» с подтверждением; технолог и цех — нет. Решение планировщика: учётная запись администратора офиса, а не отдельный местный код (ещё один секрет на ПК, который пришлось бы хранить, менять и не терять). Ограничение: вход в офис требует хоста; станция без связи с хостом из киоск-режима средствами приложения не выходит — остаётся `Ctrl+Alt+Del` Windows (киоск-режим Tauri системные клавиши не перехватывает). Вопрос владельцу — ниже, в «Перенесено».
- Тесты: жизненный цикл с поддельным `invoke`, кнопка только у администратора, вход в киоск-режим после выхода из офиса.

### Task 10 (схема): поиск оператора по имени

- Перенос облачных `searchOperatorsByName` и `OperatorNameSearch` (поле `Input` из `@markiro/ui`, не больше пяти результатов, не меньше двух букв, только копии этого подключения без хешей) и `setManualTextEntryActive` у источника сканов: набор имени с клавиатуры не превращается в скан бейджа. Выбор имени ведёт к вводу PIN с известным номером; проверка — прежняя `signInWithPin`.

### Task 11 (схема): строка состояния цеха

- Перенос облачного `StatusBar` (станция, линия по `ref_lines`, оператор, связь с хостом) на экраны входа и заглушки; `set_system_awake` (не засыпать, пока вошёл оператор) — только по решению владельца, это ещё одна команда оболочки и, на Windows, ещё один набор возможностей `windows-sys` (`Win32_System_Power`).

### Task 12 (схема): документы и ручная проверка на Windows

- `AGENTS.md` («App shell», «Verification»), спецификация §5.1, §5.6.
- Ручной список (владелец, Windows 10 и 11, сборка из `standalone-windows-build`): киоск-режим включается при старте и после офиса; `Alt+F4` и закрытие с панели задач не закрывают окно; окно поверх всех и на весь монитор, в том числе на втором мониторе; «Оконный режим» администратора возвращает рамку; выход из оконного режима и перезапуск снова дают киоск; вход реальным клавиатурным сканером в раскладках EN и RU и с Caps Lock; скан кода товара на экране входа; время входа по бейджу и PIN на заводском ПК.

---

## Перенесено

- Часть 1f2 (схема выше): киоск-режим оболочки и вебвью, выход из него, поиск по имени, строка состояния, ручная проверка на Windows.
- Вопросы владельцу: числа блокировок (10 неудач — 1 минута на станцию, 5 неверных PIN — 5 минут на PIN оператора), время бездействия (10 минут, как в облаке), способ выхода из киоск-режима (администратор офиса и `Ctrl+Alt+Del` без хоста, или ещё местный код обслуживания), дополнять ли короткий табельный номер нулями, как облако.
- Устройство вида `office` видит тот же экран входа, что станция; отдельный «офисный» вид без цеха — решение владельца, когда такие устройства появятся (приложение их пока не создаёт).
- Уведомление о разделителе групп GS1: если реальный сканер не шлёт `\u001d` клавишей, код товара на экране входа читается как «не бейдж» или как неизвестный бейдж (тогда он считается неудачей станции). Разбор сканов с префиксом AIM (`]d2`) и полный разбор кодов маркировки — план 2a вместе с COM-сканерами.
- Монотонные часы для блокировок (облачный `grant_clock.rs`): блокировка по часам ПК сокращается, если перевести часы вперёд; в киоск-режиме оператор часов не меняет. Перенос часов загрузки — если владелец сочтёт это нужным.
- План 2a (смена на станции): что оператор может делать на линии, как смена линии встречает идущую смену; план 5 — политика версий протокола (без изменений с плана 1e4).
- Из повторного ревью волны 1f1 (мелочи): раскладка клавиатуры — `Ctrl+]` даёт `ъ` в русской раскладке, и такой ввод теперь отбрасывается (раньше отказывался как проблема раскладки), нужна проверка на реальном сканере; «уведомление не возвращается» не держится, если смена линии без вошедшего оператора перемонтирует экран; в тестах четыре новых приведения `as HTMLButtonElement`; несколько длинных строк в документах.
- Из очереди 1f1: «забывание» сбрасывает счётчики блокировок (схема 1f2 должна это учесть); пункты 20 и 22 очереди — в план 2a; пустые табельные номера с ведущими нулями на стороне хоста; кнопки 64 px на станционных экранах; подвисший IPC около 35 с; эскалация блокировок; сообщение о блокировке в журнале хоста.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-07 (часть 1f1, задачи 1–7 и итоговая волна). Там, где задачи выше расходятся с кодом в ветке, верен этот раздел. Часть 1f2 не исполнялась.

**Поправки плана по ходу исполнения**

- Счёт тестов. План рассчитывал на Vitest 62 файла и 1482 теста; сборка заканчивается на 63 файлах и 1662 тестах (из 59 файлов и 1418). Лишние тесты — от исполнителей (в задачах 2–6 по 10–49 сверх брифа) и итоговой волны (+21). Cargo: 41 набор и 453 теста без изменений (в Rust только миграция `0005`, комментарий и тест `local_db`).
- `oneAtATime` (задача 3, принято): проверки PIN одной станции идут строго по одной. Без сериализации серия из 12 одновременных догадок проходила мимо счётчика (ревьюер прогнал мутант).
- Счётчик станции затухает, `last_failure_at` в миграции `0005` (задача 3, правка `509cf9b2a`): если прошлая неудача старше `STATION_QUIET_MS` (10 минут), счёт начинается с единицы; успех счётчик станции не сбрасывает. Миграция `0005` ещё не выпускалась, поэтому поле добавлено в неё же. Потолок при затяжном подборе — около 10 догадок за 70 секунд без эскалации (записан в документах и в «Перенесено»).
- `operator_signed_in` несёт `lineId` и `address` (задача 6, правка `04baef8ad`); редьюсер отказывает (состояние не меняется), если линия отличается от текущей линии станции, вид по адресу не цеховой или оператор уже вошёл. `host_probed` и `office_opened` выводят оператора из смены (задача 4, правка `c03e4c19a`; пропуск был в брифе).
- `OperatorSignIn` получает обязательный `lineId`, экран ключуется `hostId:deviceId:lineId`, поздние ответы отбрасываются по значениям, с которыми проверка началась (задача 5, правки задач 5–6).
- Ворота синхронизации после входа: `SIGN_IN_SYNC_GAP_MS` = 2000 мс, первый запрос сразу, запросы внутри ожидания складываются в одну синхронизацию; проп `signInSyncGapMs` — шов для тестов. Проверка оператора после синхронизации при сбое чтения не выводит из смены (fail open) — решение плана, подтверждено ревью.
- Источник сканов-клавиатуры (итоговая волна, `39269d835`): `Ctrl+]` читается как разделитель групп `\u001d`; клавиши с `ctrl`/`meta` без `alt` (AltGr — это Ctrl+Alt на Windows) отбрасываются, а не вводятся как символ.
- Итоговая волна, экран входа (`3f0d07720`): «Офис» остаётся доступным, пока идёт проверка; уведомление о неудаче после первой попытки не возвращается (`noticeDismissed`). Редьюсер кладёт в сессию свежий объект с ровно четырьмя полями `{id, login, name, role}` (`020076c60`); выход по бездействию и проверка после синхронизации привязаны к этому хранимому объекту, поэтому поздний таймер прошлой сессии того же оператора не закрывает следующую.
- Тесты итоговой волны: случаи `isPinPhc` с 2 000 000 итераций и `0100000`, таблица соответствия правил ввода и `src/lib/rules.ts`, тест очистки PIN при смене подключения и линии, поля времени простоя 1 500 мс (`ce5ab051e`, `3f0d07720`, `787a4a4c5`). Документы: формулировки `copiesReady`, `DUMMY_PIN_PHC`, потолок блокировок, «забывание сбрасывает счётчики» (`78710b742`, `d7c21b6df` — названия кнопок и слова о сессионном объекте по повторному ревью).
- Процесс: правки задач 3, 4 и 6 не проходили отдельного повторного ревью, их смотрело итоговое ревью; волну после него проверил повторный ревьюер (одобрено, Critical 0, Important 0, Minor 6: два документных исправлены, остальные ниже).
- Итоговый гейт: Vitest 63 файла / 1662, typecheck, lint, build, prettier, `git diff --check`, поиск `\u04` (только `pairing-code.ts:66`), cargo fmt, `local_db` и `cargo check --workspace` зелёные; изменений в `apps/station`, `packages`, `host`, `proto`, манифестах и локфайле нет. Полный `cargo test --workspace` с сетевыми наборами после правок 1f не перезапускался (нужен прогон вне песочницы).
