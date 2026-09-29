# План 1d4: офис — операторы и бейджи, копии операторов и бейджей на станции — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор ведёт из офиса операторов — табельный номер, имя, должность, PIN — и их бейджи; PIN и код бейджа хешируются в вебвью и не покидают его. Станция хранит копии операторов и бейджей из ленты, отвергает записи, которыми не сможет воспользоваться, и не оставляет удалённых хешей на диске после сброса подключения. Офис узнаёт свой ПК в «Устройствах» и предупреждает, прежде чем тот отзовёт сам себя.

**Architecture:**

- `src/lib/credentials.ts` — `hashPin` (случайная соль) и `hashBadge` (соль площадки, ровно `BADGE_ITERATIONS`), позже — проверки PHC для копий (`isPinPhc`, `isBadgePhc`). `src/lib/rules.ts` — правила полей оператора и бейджа, своё сообщение об управляющем символе, одиночный суррогат в пароле.
- `src/host/{protocol,requests,api}.ts` — схемы ответов и тел плана 1d2, сборщики `operatorCreate`, `operatorUpdate`, `badgeCreate`, методы `HostApi`.
- `host/src/routes/operators.rs` — единственная правка хоста: конфликт `badge` называет владельца (`details.operatorId`).
- `src/office/operators/*` — страница «Операторы» (список, добавление, правка, смена PIN, выключение и включение) и диалоги бейджей (список, добавление со сканера, отзыв).
- `src-tauri/migrations/0003_operators_badges.sql`, `src/local/reference-sync.ts`, `src/host/protocol.ts` — копии `ref_operators` и `ref_operator_badges`, строгие записи ленты, `SYNC_SCHEMA_VERSION` 3, защита upsert от более новой записи карантина.
- `src-tauri/src/{local_db,lib}.rs` — `secure_delete` у писателя, `wal_checkpoint(TRUNCATE)` после очистки копий, удаление локальной базы, которая не открылась.
- `src/office/this-device.tsx`, `src/office/devices/*`, `src/app/{App,LineSelect}.tsx` — «Этот ПК» и строгое подтверждение его отзыва; предупреждение экрана выбора линии объявляется один раз за сбой.

**Tech Stack:** React 19.2, TypeScript 6 (strict), zod 4.4.3, react-hook-form 7.85, TanStack Query 5.101, i18next, `@markiro/ui` (`Modal`, `StatusChip`, `Badge`), `@markiro/domain` (`deriveDigestB64`, `formatPhc`, `parsePhc`, `PHC_ITERATIONS`), WebCrypto Node 24 в Vitest 4 с jsdom, `node:sqlite`; Rust — sqlx 0.8 (SQLite), axum (хост), Tauri 2 (mock runtime в тестах IPC).

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1d4-design.md`: границы плана и обязательные решения; всё, что брифом не названо, — в «Перенесено».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §4.3 (операторы и бейджи), §4.4 (лента), §4.5 (маршруты и фикстуры), §4.6 (ошибки), §4.8 (роли), §5.2 (`device_forget`), §5.3 (локальная база), §5.4 (синхронизация), §5.5 (офис).
- План 1d2 (`docs/superpowers/plans/2026-09-27-standalone-1d2-host-people-devices.md`) — маршруты хоста, лента и фикстуры людей. Планы 1d1 и 1d3 и их «Отклонения при исполнении» — карантин, `clear_copies`, основа записи офиса и перенесённые сюда пункты.

## Global Constraints

**Роли (спецификация §4.8)**

| Раздел                                          | Администратор   | Технолог                    |
| ----------------------------------------------- | --------------- | --------------------------- |
| «Операторы» (меню «Производство»), бейджи, соль | чтение и запись | нет доступа (`RequireRole`) |

- Права проверяет хост; офис только решает, что показать. Пункт «Операторы» — между «Линии» и «Устройства», `roles: ["admin"]`; маршрут `/operators` обёрнут в `RequireRole` с `["admin"]`.

**Правила полей (зеркало `host/src/validate.rs` и облака)**

| Поле                      | Правило                                                                                                                       | Текст ошибки                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Табельный номер (`login`) | после `trim` — `^[0-9]{3,12}$` (только ASCII-цифры); ведущие нули — часть номера; номер не меняется, поэтому в правке его нет | `rules.operatorLogin`                                          |
| Имя (`name`)              | `personNameRule`: после `trim` 1–100 символов (скалярные значения), без управляющих символов и одиночных суррогатов           | длина — `rules.name`, знак — `rules.controlCharacter`          |
| Должность (`role`)        | `operatorRoleRule`: после `trim` до 120 символов, пусто — нет должности (`null`), без управляющих символов                    | длина — `rules.role`, знак — `rules.controlCharacter`          |
| PIN                       | `pinRule`: после `trim` — `^[0-9]{4,6}$`; повтор должен совпасть                                                              | `rules.pin`, повтор — `rules.pinConfirm`                       |
| Подпись бейджа (`label`)  | `badgeLabelRule`: после `trim` до 100 символов, пусто — нет подписи (`null`), без управляющих символов                        | длина — `rules.badgeLabel`, знак — `rules.controlCharacter`    |
| Код бейджа                | `badgeCodeRule`: после `trim` 1–256 символов печатного ASCII (`^[ -~]{1,256}$`); кириллица — отказ с подсказкой раскладки     | `rules.badgeCode`, кириллица — `rules.badgeCodeLayout`         |
| Пароль                    | `passwordRule`: 8–128 символов и без одиночного суррогата                                                                     | длина — `rules.password`, суррогат — `rules.passwordCharacter` |

- `plainTextRule(max, message)` проверяет длину первой проверкой (`message`), а управляющий символ или одиночный суррогат — второй (`rules.controlCharacter`); прежние тексты длины не меняются. `optionalTextRule(max, message)` — то же для необязательного текста, пустое значение допустимо. `isPlainText` не меняется: мастер вызывает его для названий линий напрямую, и его тексты остаются прежними.
- `isTransferable(text)` — нет одиночного суррогата; им проверяются поля, которые не свободный текст: пароли, логин входа в офис и текущий пароль «Сменить пароль».
- В `rules.ts` уже есть `loginRule` — логин офиса; правило табельного номера называется `operatorLoginRule`.

**Ошибки хоста (спецификация §4.6)**

- `validation_failed` с `details.field`: у оператора `login`, `name`, `role` — под своими полями, `pinPhc` — под PIN; у бейджа `badgePhc` — под кодом, `label` — под подписью (текст `rules.rejected`).
- `conflict` с `details.constraint`: `login` — под табельным номером (`office.operators.errors.loginTaken`); `badge` — под кодом бейджа: если `details.operatorId` — UUID оператора из списка, `office.operators.badges.errors.takenBy` с его именем, иначе `office.operators.badges.errors.taken`.
- `stale_revision` (`details.currentRev` не используется) — «Загрузить заново» у правки, смены PIN и выключения/включения. У создания и бейджей ревизии нет.
- `not_found` при чтении соли — `office.operators.badges.errors.noSalt`; прочие сбои чтения соли — `LoadError` с «Повторить».

**Тела запросов**

Каждое тело собирает функция из `src/host/requests.ts`, поле за полем, из обрезанных значений, которые приняла форма (выход схемы Zod); `raw` у `zodResolver` не ставится. Идентификаторы — только в пути; ответы читают их как `z.uuid()`.

| Сборщик                                                        | Тело                                                                                                                                 | Фикстура               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `operatorCreate({ login, name, role, pinPhc })`                | все четыре поля, `role: null` — нет должности                                                                                        | `operator-create.json` |
| `operatorUpdate(operator, { name?, role?, active?, pinPhc? })` | только отличающиеся от загруженного `name`, `role` (`null` очищает), `active`; `pinPhc` — всегда, если передан; всегда `expectedRev` | `operator-update.json` |
| `badgeCreate({ badgePhc, label })`                             | оба поля, `label: null` — без подписи                                                                                                | `badge-create.json`    |

- Схемы ответов (`officeOperatorSchema`, `badgeInfoSchema`, `badgeSaltSchema`) — нестрогий `z.object`; схемы тел — `.strict()`. `revokeBadge` — `DELETE`, ответ 204 разбирает прежний `NO_CONTENT`.
- Ответ на добавление бейджа — `BadgeInfo`, не оператор: страница кладёт бейдж в кэшированного оператора. Отзыв (204) сразу помечает бейдж отозванным в кэше, затем список перечитывается.

**Запись в диалогах (уроки плана 1d3)**

- В `try` — только хеширование и ожидаемая запись; обратный вызов после записи (`onCreated`, `onSaved`, `onAdded`, `onRevoked`) — после `try/catch`, а каждый `catch` кончается `return`.
- PIN хешируется внутри `onSubmit` до построения тела: защита `FormDialog` от второй отправки покрывает и хеширование, а переменные мутации (TanStack Query хранит их в кэше) содержат только хеш.
- `withRecord` заменяет запись на месте; таблица сортирует при выводе: действующие операторы раньше выключенных, внутри — по табельному номеру как по тексту (`a.login < b.login`), не числовым коллатором.

**Хеши**

- PIN: `hashPin(pin)` — 16 случайных байт соли (`crypto.getRandomValues`), `PHC_ITERATIONS` (100 000), стандартный base64 с выравниванием, `pbkdf2$sha256$100000$<соль>$<хеш>` (`formatPhc`).
- Бейдж: `hashBadge(code, saltB64)` — соль площадки из `GET /v1/office/badge-salt` и ровно `BADGE_ITERATIONS`, как `hashBadgeWithSalt` облака: `formatPhc(N, salt, await deriveDigestB64(code, salt, N))`. Код хешируется как передан; обрезает его вызывающий (выход `badgeCodeRule`).
- `BADGE_ITERATIONS = 100_000` — именованная константа в `src/lib/credentials.ts` (зеркало `secrets::BADGE_ITERATIONS`); её берут и хеширование в офисе, и схема копии бейджа. Тест держит её равной 100 000 и `PHC_ITERATIONS` и воспроизводит `badge-create.json` («MRK-000742» с солью `badge-salt.json`) и `operator-create.json` (PIN 4821, соль — байты «markiro-pin-salt») байт в байт.
- PIN и код бейджа не покидают вебвью: их нет в теле запроса, URL, ошибке, журнале и кэше; они живут в форме, пока открыт диалог.

**Строгие записи ленты и копии на станции**

- `siteRecordSchema`, `operatorRecordSchema`, `operatorBadgeRecordSchema` — `z.strictObject`: незнакомый или недостающий ключ уводит запись в карантин (`data: unrecognized_keys`).
- `operatorRecordSchema`: `login` — `^[0-9]{3,12}$`; `pinPhc` — `isPinPhc`: `parsePhc` разбирает, число итераций 10 000–1 000 000 (`MIN_PHC_ITERATIONS`, `MAX_PHC_ITERATIONS`), строка совпадает с `formatPhc` своих частей (число записано так, как пишет хост: не `0100000`, не `1e5`).
- `operatorBadgeRecordSchema`: `operatorId` — `z.uuid()`; `badgePhc` — `isBadgePhc`: так же записан и ровно `BADGE_ITERATIONS`.
- `ENTITIES` — ещё `operators` → `ref_operators` и `operator_badges` → `ref_operator_badges`; `SYNC_SCHEMA_VERSION = 3`, `ENTITY_SET = "org_profile,site,lines,operators,operator_badges;v3"`.
- Бюджет порции — не больше 3E + 6 SQL-операторов: при E = 5 это 21 из 32 оболочки; план 1e с E = 8 дойдёт до 30.
- У таблиц копий нет внешнего ключа (бейдж выключенного оператора остаётся в ленте, бейдж может прийти раньше оператора) и нет уникальности, кроме ключа (отказ по уникальности остановил бы всю порцию и синхронизацию навсегда). Обычные индексы: `ref_operators (login)`, `ref_operator_badges (operator_id)`, `ref_operator_badges (badge_phc)`.
- Upsert операторов и бейджей не возвращает запись, более новая ревизия которой ждёт в `sync_quarantine` (`notQuarantinedNewer`).

**Тексты**

- Каждый видимый текст — ключ в `src/i18n/ru.json`, ровно как в шагах задач. Кавычки — «ёлочки»; подписи полей и кнопок без точки, сообщения полей без точки, предложения уведомлений — с точкой.
- Новые ключи: `rules.controlCharacter`, `rules.passwordCharacter`, `rules.operatorLogin`, `rules.pin`, `rules.pinConfirm`, `rules.role`, `rules.badgeLabel`, `rules.badgeCode`, `rules.badgeCodeLayout`, `office.nav.operators`, группа `office.operators.*` (с `office.operators.badges.*`), `office.devices.thisDevice`, `office.devices.revokeOwnTitle`, `office.devices.revokeOwnBody`.
- Прежние тексты не меняются. Меняются утверждения тестов, где управляющий символ получал текст длины: `rules.test.ts`, `lines-page`, `devices-page`, `counterparties-page` — теперь `rules.controlCharacter`.

**Решения планировщика** (открытые места брифа)

- Код бейджа с кириллицей отвергается с подсказкой раскладки, другой знак вне печатного ASCII — текстом правила: станция набирает тот же бейдж через свою раскладку, и кириллический код совпал бы только при той же ошибке раскладки; прецедент 1c3 — отказать, не переводить.
- «Включить» — лёгкое подтверждение (`FormDialog`, основной вариант кнопки): включение возвращает доступ PIN и бейджам на всех станциях, а общий диалог даёт защиту от второй отправки и «Загрузить заново».
- Соль в `badgePhc` копии со записью `site` не сверяется: хост берёт только соль площадки, она не меняется после мастера, а копия с чужой солью не совпадёт ни с одним сканом (станция хеширует скан солью `ref_site` и сравнивает строки) — сверка потребовала бы запись `site` внутри проверки каждой записи и ничего бы не дала.
- `VACUUM` после очистки не нужен: `secure_delete` обнуляет удалённое, а `wal_checkpoint(TRUNCATE)` переносит обнулённые страницы в файл и опустошает WAL; `VACUUM` только сжал бы файл.
- Защита `AND NOT EXISTS` (задание брифа «planner's job»): случай достижим и защита добавлена. Лента по своим правилам после новой ревизии записи старую не шлёт, но старая страница может прийти от прогона, запрошенного до `device_forget`, если устройство успело заново подключиться к тому же хосту: новое подключение ставит тот же `host_id`, и `hostGuard` страницу пропускает. Тест задачи 6 строит этот случай на настоящем коде и падает без защиты у каждого из двух upsert. Та же старая страница может вернуть и запись, удалённую надгробием, и откатывает `last_rev` — это чинит следующий прогон; закрыть щель целиком — в «Перенесено».
- `BADGE_ITERATIONS` — литерал `100_000`, как `secrets::BADGE_ITERATIONS` хоста, а не `= PHC_ITERATIONS`: смену в домене поймает тест, а не повторит молча константа.
- `autoComplete` в новых полях не задаётся: `Input` из `@markiro/ui` сам ставит `new-password` скрытым полям и `off` остальным, с атрибутами отказа менеджеров паролей; явный `off` на поле пароля Chrome не соблюдает (комментарий `Input`). PIN и код бейджа скрыты (`type="password"`).
- Проверки на одиночный суррогат получают ещё два поля того же рода: логин входа в офис (`rules.login`) и текущий пароль «Сменить пароль» (`rules.passwordCharacter`).
- Тест хоста — в `host/tests/badges.rs`: тесты бейджей живут там с плана 1d2 (бриф называет `operators.rs`).
- Бейджи — три диалога, которые переключает страница (список, добавление, отзыв), а не вложенные модальные окна; диалоги бейджей берут оператора из кэшированного списка по id и видят каждое изменение. Диалог добавления ставит фокус в поле кода (`setFocus`) — сканер печатает сразу.
- Соль читается один раз за сессию: `useOfficeQuery` получает `staleTime` (`Infinity` для соли, по умолчанию 0).
- Отозванный бейдж до перечитывания помечается временем этого ПК: `revokedAt` здесь только признак, время хоста придёт с перечитыванием.
- Пункт брифа 8 взят: повторное объявление было у предупреждения экрана выбора линии — повтор синхронизации менял его на индикатор и обратно, и живая область объявляла сбой каждые несколько секунд. Теперь предупреждение остаётся на весь сбой, а «Повторить» показывает идущий прогон.
- Шапка миграции `0001` («операторы, бейджи, товары и шаблоны — планы 1d и 1e») остаётся верной и не правится: применённую миграцию не редактируют.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!`. Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui` (ESLint запрещает нативные поля в `src/`); у полей подписи, у кнопок в строках — `aria-label` с именем записи, состояние — словом (`StatusChip`), не только цветом.
- Новых зависимостей нет — ни JS, ни Rust. `apps/station` не меняется. Хост меняется только в задаче 3 (`routes/operators.rs` и его тест); `proto/` не меняется.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в файле он встречается один раз. Правки внутри шага идут сверху вниз по файлу, одна за другой.
- «Заменить содержимое … целиком» — файл пишется заново, ровно как в блоке. «Create» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента.
- Русский текст в коде и в `ru.json` — буквами, не последовательностями `\uXXXX`. Каждая задача, меняющая `src` или `test` веб-оболочки (все, кроме задач 3 и 7), кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`. Намеренные экранирования управляющих знаков и суррогатов в тестах (`"\t"`, `"\u0000"`, `"\ud800"`) стоят в блоках именно так.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `shasum -a 256 <файл>`, правка из блока, команда из блока — ожидаемый FAIL с названным сообщением, затем обратная правка и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD: код в плане уже отформатирован, расхождение значит опечатку.
- В задачах с Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`.
- `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- WebCrypto в тестах есть без полифилла: окружение jsdom в Vitest отдаёт `crypto.subtle` и `crypto.getRandomValues` Node 24 (PBKDF2 на 100 000 итераций — около 15 мс), поэтому страницы с `hashPin` и `hashBadge` тестируются как есть, без новой зависимости.
- React 19.2 запускает пассивные эффекты задачей `setImmediate`, а `waitFor` после успеха ждёт `setTimeout(0)`: утверждение сразу после `findBy*`, которое зависит от эффекта, — скрытый флейк. Ждать эффект явно (`waitFor`), «ровно N раз» проверять так: `waitFor`, два хода `await new Promise((resolve) => setImmediate(resolve))`, снова та же проверка. Два щелчка, которые должны быть одновременными, — в одном `act` (`fireEvent` сам оборачивает каждый вызов в свой `act`).
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст (нет предупреждений `act(...)` и ошибок React).
- Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс (заметка «Vitest effect race harness»): он делает флейк эффекта постоянным. Стенд — два временных файла внутри пакета (из `$TMPDIR` Vite не грузит); запустить и сразу удалить, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

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

- Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.

**Cargo**

- Крейт оболочки встраивает `apps/standalone/dist`, поэтому перед cargo — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`.
- Тесты хоста (`-p markiro-host`), `--test local_db` и отфильтрованный `--test ipc forgetting_the_device` порт не слушают и идут в песочнице с `--offline`. Полный `cargo test --workspace` слушает 127.0.0.1 — только вне песочницы; журнал такого запуска писать по абсолютному пути в `/tmp/claude/` (вне песочницы `$TMPDIR` другой).
- Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src/lib/{credentials,rules}.ts                              задачи 1, 6
apps/standalone/src/office/{OfficeLogin,ChangePasswordDialog}.tsx            задача 1
apps/standalone/test/{credentials,rules}.test.ts                            задачи 1, 6
apps/standalone/test/{office,lines-page,counterparties-page}.test.tsx        задача 1
apps/standalone/src/host/{protocol,requests,api}.ts                         задачи 2, 6
apps/standalone/test/{protocol,api}.test.ts, test/support/office.tsx        задачи 2, 6
apps/standalone/host/src/routes/operators.rs, host/tests/badges.rs          задача 3
apps/standalone/src/office/operators/*                                      задачи 4, 5
apps/standalone/src/office/{nav.ts,routes.tsx,office-query.ts}              задачи 4, 5
apps/standalone/test/operators-page.test.tsx                                задача 4
apps/standalone/test/operator-badges.test.tsx, src/app/shell.css            задача 5
apps/standalone/src-tauri/migrations/0003_operators_badges.sql              задача 6
apps/standalone/src/local/reference-sync.ts, test/reference-sync.test.ts    задача 6
apps/standalone/test/local-executor.test.ts                                 задача 6
apps/standalone/src-tauri/tests/local_db.rs                                 задачи 6, 7
apps/standalone/src-tauri/src/{local_db,lib}.rs, src-tauri/tests/ipc.rs     задача 7
apps/standalone/src/office/{this-device.tsx,Office.tsx}                     задача 8
apps/standalone/src/office/devices/{DevicesPage,RevokeDeviceDialog}.tsx     задача 8
apps/standalone/src/app/{App,LineSelect}.tsx                                задача 8
apps/standalone/test/{app,line-select}.test.tsx                             задача 8
apps/standalone/test/devices-page.test.tsx                                  задачи 1, 8
apps/standalone/src/i18n/ru.json                                            задачи 1, 4, 5, 8
apps/standalone/AGENTS.md                                                   задачи 1, 3–8
спецификация: §4.6 — задача 3; §5.5 — задачи 4, 5, 8; §5.3, §5.4 — задача 6; §5.2 — задача 7
```

Правила и хеши (задача 1) стоят раньше провода (задача 2): страницы берут и то и другое, а проверки PHC для копий (`isPinPhc`, `isBadgePhc`) добавляет задача 6 в тот же `credentials.ts`, где их проверяет свой тест. Правка хоста — отдельной задачей 3 перед диалогом бейджей: задача 5 читает `details.operatorId`. Копии на станции (задача 6) идут до гигиены оболочки (задача 7): тест следов на диске пишет в `ref_operator_badges`.

---

### Task 1: Хеши и правила полей — `src/lib/credentials.ts`, `src/lib/rules.ts`

PIN и код бейджа офис хеширует сам: хост видит только строки PHC. `hashPin` берёт свежую случайную соль, `hashBadge` — соль площадки и ровно `BADGE_ITERATIONS`, как облако. Тест воспроизводит фикстуры хоста байт в байт: `badge-create.json` — хеш кода «MRK-000742» с солью `badge-salt.json`, `operator-create.json` — PIN 4821 с солью из байтов «markiro-pin-salt».

Правила полей оператора и бейджа повторяют хост (`validate::operator_login`, `operator_role`, `badge_label`) и облако (код бейджа — 1–256 символов). Два перенесённых пункта:

- управляющий символ в свободном тексте получает своё сообщение `rules.controlCharacter` (сейчас он получает текст длины, а табуляция из таблицы не видна): у `plainTextRule` вторая проверка; тексты длины и мастер (он вызывает `isPlainText` напрямую) не меняются, утверждения тестов с управляющими символами переписываются;
- одиночный суррогат в пароле: вставленный такой знак не проходит IPC (serde его отвергает), и форма говорила «Нет связи с хостом». Теперь `passwordRule`, пароль и логин входа в офис и текущий пароль «Сменить пароль» отвергают его своим текстом.

**Files:**

- Create: `apps/standalone/src/lib/credentials.ts`, `apps/standalone/test/credentials.test.ts`
- Modify: `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/office/OfficeLogin.tsx`, `apps/standalone/src/office/ChangePasswordDialog.tsx`, `apps/standalone/src/i18n/ru.json`
- Modify (тесты): `apps/standalone/test/rules.test.ts`, `apps/standalone/test/office.test.tsx`, `apps/standalone/test/lines-page.test.tsx`, `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/test/counterparties-page.test.tsx`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: `deriveDigestB64`, `formatPhc`, `PHC_ITERATIONS` — `@markiro/domain`; `hasCyrillic` — `src/host/pairing-code.ts`; `characters`, `CONTROL_OR_LONE_SURROGATE` — `src/lib/rules.ts`.
- Produces:
  - `BADGE_ITERATIONS = 100_000`, `hashPin(pin: string): Promise<string>`, `hashBadge(code: string, saltB64: string): Promise<string>` — `src/lib/credentials.ts`;
  - `isTransferable(text: string): boolean`, `optionalTextRule(max: number, message: string): z.ZodString`, `toOptionalText(text: string): string | null`, `operatorLoginRule`, `pinRule`, `operatorRoleRule`, `badgeLabelRule`, `badgeCodeRule` — `src/lib/rules.ts`;
  - ключи `rules.controlCharacter`, `rules.passwordCharacter`, `rules.operatorLogin`, `rules.pin`, `rules.role`, `rules.badgeLabel`, `rules.badgeCode`, `rules.badgeCodeLayout`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/credentials.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BADGE_ITERATIONS, hashBadge, hashPin } from "../src/lib/credentials.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/** A string field of a fixture object, asserted rather than cast. */
function field(name: string, key: string): string {
  const value: unknown = (fixture(name) as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${name} has no string ${key}`);
  return value;
}

/** `badge-salt.json`: the site's badge salt, as the office reads it. */
const SITE_SALT = field("badge-salt.json", "badgeSalt");
/** `badge-create.json`: the badge «MRK-000742» hashed with `SITE_SALT`. */
const BADGE_PHC = field("badge-create.json", "badgePhc");
/** `operator-create.json`: the PIN 4821 with the salt bytes of «markiro-pin-salt». */
const PIN_PHC = field("operator-create.json", "pinPhc");

describe("operator credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins the badge iteration count at the host's 100 000, the domain's PHC_ITERATIONS", () => {
    expect(BADGE_ITERATIONS).toBe(100_000);
    expect(BADGE_ITERATIONS).toBe(PHC_ITERATIONS);
    expect(parsePhc(BADGE_PHC)?.iterations).toBe(BADGE_ITERATIONS);
    expect(parsePhc(BADGE_PHC)?.saltB64).toBe(SITE_SALT);
  });

  it("hashes a badge code with the site's salt into the host's fixture, as the cloud does", async () => {
    await expect(hashBadge("MRK-000742", SITE_SALT)).resolves.toBe(BADGE_PHC);
    // The cloud's `hashBadgeWithSalt`, written out.
    const cloud = formatPhc(
      PHC_ITERATIONS,
      SITE_SALT,
      await deriveDigestB64("MRK-000742", SITE_SALT, PHC_ITERATIONS),
    );
    expect(cloud).toBe(BADGE_PHC);
  });

  it("hashes the code it is given as it is: no trimming, no case folding", async () => {
    const plain = await hashBadge("MRK-000742", SITE_SALT);
    await expect(hashBadge(" MRK-000742 ", SITE_SALT)).resolves.not.toBe(plain);
    await expect(hashBadge("mrk-000742", SITE_SALT)).resolves.not.toBe(plain);
  });

  it("hashes a PIN with 16 random salt bytes into the domain's format", async () => {
    const salt = new TextEncoder().encode("markiro-pin-salt");
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.set(salt);
        return array;
      },
    );
    await expect(hashPin("4821")).resolves.toBe(PIN_PHC);
  });

  it("gives every PIN hash a fresh salt, in standard base64 with padding", async () => {
    const first = await hashPin("4821");
    const second = await hashPin("4821");
    expect(first).not.toBe(second);
    for (const phc of [first, second]) {
      expect(phc).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
      await expect(verifyPhc("4821", phc)).resolves.toBe(true);
      await expect(verifyPhc("4822", phc)).resolves.toBe(false);
    }
  });
});
```

2. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  isPlainText,
  lineNameRule,
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  parsePrefixList,
  passwordRule,
  personNameRule,
  toOrgInput,
  type OrgFields,
} from "../src/lib/rules.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  badgeCodeRule,
  badgeLabelRule,
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  isPlainText,
  isTransferable,
  lineNameRule,
  loginRule,
  operatorLoginRule,
  operatorRoleRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  parsePrefixList,
  passwordRule,
  personNameRule,
  pinRule,
  toOptionalText,
  toOrgInput,
  type OrgFields,
} from "../src/lib/rules.js";
```

3. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(personNameRule.safeParse("😀".repeat(100)).success).toBe(true);
    expect(passwordRule.safeParse("x".repeat(129)).success).toBe(false);
  });
});

describe("free text", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(personNameRule.safeParse("😀".repeat(100)).success).toBe(true);
    expect(passwordRule.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("refuses an unpaired surrogate in a password with its own message, which cannot reach the host", () => {
    expect(passwordRule.safeParse("пароль12\ud800").error?.issues[0]?.message).toBe(
      "rules.passwordCharacter",
    );
    expect(passwordRule.safeParse("\udc00пароль12").error?.issues[0]?.message).toBe(
      "rules.passwordCharacter",
    );
    // A pair is one character and crosses the IPC as it is.
    expect(passwordRule.safeParse("пароль😀12").success).toBe(true);
    expect(isTransferable("пароль\ud800")).toBe(false);
    expect(isTransferable("пароль😀")).toBe(true);
  });
});

describe("free text", () => {
```

4. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    }
  });

  it("refuses an unpaired surrogate in every free-text field", () => {
    expect(personNameRule.safeParse("Павел\ud800").error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse("\udc00Станция").error?.issues[0]?.message).toBe("rules.name");
    expect(lineNameRule.safeParse("Ли\ud800ния").error?.issues[0]?.message).toBe("rules.lineName");
    expect(companyNameRule.safeParse("ООО\udc00").error?.issues[0]?.message).toBe("rules.orgName");
    expect(orgMessage({ orgName: "ООО «Ат\ud800олл»" })).toBe("rules.orgName");
    expect(deviceNameRule.safeParse("Станция 😀").success).toBe(true);
  });

  it("trims a tab at the edge of a value, but refuses one inside", () => {
    expect(lineNameRule.safeParse("\tЛиния 2\t").data).toBe("Линия 2");
    expect(lineNameRule.safeParse("Линия\t2").error?.issues[0]?.message).toBe("rules.lineName");
    // A NUL is trimmed by neither JavaScript nor Rust, at the edge or inside.
    expect(lineNameRule.safeParse("Линия 2\u0000").error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
    expect(lineNameRule.safeParse("Ли\u0000ния").error?.issues[0]?.message).toBe("rules.lineName");
  });

  it("trims before it counts, and a NUL at the edge is not trimmed away", () => {
    expect(lineNameRule.safeParse("  Линия 2  ").data).toBe("Линия 2");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("\u0000Линия").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("л".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("holds every free-text field the office and the wizard send", () => {
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse(" Станция 2 ").data).toBe("Станция 2");
    expect(deviceNameRule.safeParse("Станция\u00002").error?.issues[0]?.message).toBe("rules.name");
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    expect(orgMessage({ orgName: "ООО\t«Атолл»" })).toBe("rules.orgName");
  });

  it("takes a company name of exactly 200 characters and refuses 201: counterparties depend on it", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
    }
  });

  it("refuses an unpaired surrogate in every free-text field, as a control character", () => {
    for (const rule of [personNameRule, deviceNameRule, lineNameRule, companyNameRule]) {
      for (const text of ["Павел\ud800", "\udc00Станция", "Ли\ud800ния"]) {
        expect(rule.safeParse(text).error?.issues[0]?.message).toBe("rules.controlCharacter");
      }
    }
    expect(orgMessage({ orgName: "ООО «Ат\ud800олл»" })).toBe("rules.controlCharacter");
    expect(deviceNameRule.safeParse("Станция 😀").success).toBe(true);
  });

  it("names a control character in its own words and keeps each field's length message", () => {
    // A tab pasted from a spreadsheet is invisible: a length message would not explain it.
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(companyNameRule.safeParse("ООО\u0085«Юг»").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(personNameRule.safeParse("я".repeat(101)).error?.issues[0]?.message).toBe("rules.name");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    // Both wrong: the length comes first.
    expect(lineNameRule.safeParse("л".repeat(101) + "\t2").error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("trims a tab at the edge of a value, but refuses one inside", () => {
    expect(lineNameRule.safeParse("\tЛиния 2\t").data).toBe("Линия 2");
    expect(lineNameRule.safeParse("Линия\t2").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    // A NUL is trimmed by neither JavaScript nor Rust, at the edge or inside.
    expect(lineNameRule.safeParse("Линия 2\u0000").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(lineNameRule.safeParse("Ли\u0000ния").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("trims before it counts, and a NUL at the edge is not trimmed away", () => {
    expect(lineNameRule.safeParse("  Линия 2  ").data).toBe("Линия 2");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("\u0000Линия").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(lineNameRule.safeParse("л".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("holds every free-text field the office and the wizard send", () => {
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(deviceNameRule.safeParse(" Станция 2 ").data).toBe("Станция 2");
    expect(deviceNameRule.safeParse("Станция\u00002").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    expect(orgMessage({ orgName: "ООО\t«Атолл»" })).toBe("rules.controlCharacter");
  });

  it("takes a company name of exactly 200 characters and refuses 201: counterparties depend on it", () => {
```

5. В `apps/standalone/test/rules.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
```

заменить на

<!-- prettier-ignore -->
```ts
  });
});

describe("operator rules", () => {
  it("takes a personnel number of 3 to 12 ASCII digits, trimmed, leading zeros kept", () => {
    expect(operatorLoginRule.safeParse(" 0042 ").data).toBe("0042");
    expect(operatorLoginRule.safeParse("123").success).toBe(true);
    expect(operatorLoginRule.safeParse("123456789012").success).toBe(true);
    // Arabic-Indic and full-width digits are digits to Unicode, not to the host.
    for (const login of ["", "12", "1234567890123", "12a4", "0042 1", "١٢٣٤", "１２３"]) {
      expect(operatorLoginRule.safeParse(login).error?.issues[0]?.message).toBe(
        "rules.operatorLogin",
      );
    }
  });

  it("takes a PIN of 4 to 6 ASCII digits, trimmed", () => {
    expect(pinRule.safeParse(" 4821 ").data).toBe("4821");
    expect(pinRule.safeParse("123456").success).toBe(true);
    for (const pin of ["", "123", "1234567", "12a4", "12 34", "١٢٣٤"]) {
      expect(pinRule.safeParse(pin).error?.issues[0]?.message).toBe("rules.pin");
    }
  });

  it("takes an optional role of up to 120 characters and a label of up to 100, blank as none", () => {
    expect(operatorRoleRule.safeParse("   ").data).toBe("");
    expect(toOptionalText("   ")).toBeNull();
    expect(toOptionalText(" Упаковщик ")).toBe("Упаковщик");
    expect(operatorRoleRule.safeParse("я".repeat(120)).success).toBe(true);
    expect(operatorRoleRule.safeParse("я".repeat(121)).error?.issues[0]?.message).toBe(
      "rules.role",
    );
    expect(operatorRoleRule.safeParse("Упа\tковщик").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(badgeLabelRule.safeParse("").success).toBe(true);
    expect(badgeLabelRule.safeParse("п".repeat(100)).success).toBe(true);
    expect(badgeLabelRule.safeParse("п".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.badgeLabel",
    );
    expect(badgeLabelRule.safeParse("Пропуск\u0000").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("takes a badge code of 1 to 256 printable ASCII characters, trimmed", () => {
    expect(badgeCodeRule.safeParse(" MRK-000742 ").data).toBe("MRK-000742");
    expect(badgeCodeRule.safeParse("x".repeat(256)).success).toBe(true);
    expect(badgeCodeRule.safeParse("0001 2345").success).toBe(true);
    for (const code of ["", "   ", "x".repeat(257), "MRK\t742", "Café", "MRK\ud800"]) {
      expect(badgeCodeRule.safeParse(code).error?.issues[0]?.message).toBe("rules.badgeCode");
    }
  });

  it("refuses a badge code typed under the Russian layout with a hint to switch it", () => {
    // «MRK-000742» as a keyboard-wedge scanner types it with the Russian layout on.
    expect(badgeCodeRule.safeParse("ЬКЛ-000742").error?.issues[0]?.message).toBe(
      "rules.badgeCodeLayout",
    );
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
```

6. В `apps/standalone/test/office.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findAllByText("Заполните поле")).toHaveLength(2);
    expect(onLogin).not.toHaveBeenCalled();
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findAllByText("Заполните поле")).toHaveLength(2);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("refuses a broken character in the login or the password before calling the host", async () => {
    // An unpaired surrogate cannot cross the IPC: the call would fail as a
    // lost connection, so the form names the field instead.
    const onLogin = vi.fn();
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    type("Логин", "admin\ud800");
    type("Пароль", "correct horse battery\udc00");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(
      await screen.findByText("В пароле есть повреждённый символ — наберите пароль заново"),
    ).toBeTruthy();
    expect(
      screen.getByText("3–64 символа: латиница, цифры, точка, дефис, подчёркивание"),
    ).toBeTruthy();
    expect(onLogin).not.toHaveBeenCalled();
  });
```

7. В `apps/standalone/test/office.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("says when the current password is wrong", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockRejectedValueOnce(
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("refuses a broken character in the current password before calling the host", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    await openDialog();
    fill("correct horse battery\ud800", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(
      await screen.findByText("В пароле есть повреждённый символ — наберите пароль заново"),
    ).toBeTruthy();
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("says when the current password is wrong", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockRejectedValueOnce(
```

8. В `apps/standalone/test/lines-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "Линия\t3");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Укажите название линии, до 100 символов")).toBeTruthy();
    expect(session.api.createLine).not.toHaveBeenCalled();
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "Линия\t3");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(session.api.createLine).not.toHaveBeenCalled();
  });
```

9. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    );
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Станция\t1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите имя, до 100 символов")).toBeTruthy();
    expect(session.api.updateDevice).not.toHaveBeenCalled();
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    );
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Станция\t1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(session.api.updateDevice).not.toHaveBeenCalled();
  });
```

10. В `apps/standalone/test/counterparties-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    type("GLN контрагента", "4607091000000");
    type("Префиксы GS1", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Укажите название, до 200 символов")).toBeTruthy();
    expect(screen.getByText("ИНН — 10 или 12 цифр")).toBeTruthy();
    expect(screen.getByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(
```

заменить на

<!-- prettier-ignore -->
```tsx
    type("GLN контрагента", "4607091000000");
    type("Префиксы GS1", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(screen.getByText("ИНН — 10 или 12 цифр")).toBeTruthy();
    expect(screen.getByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/credentials.test.ts test/rules.test.ts test/office.test.tsx test/lines-page.test.tsx test/devices-page.test.tsx test/counterparties-page.test.tsx`
Expected: FAIL:

- `credentials.test.ts` не загружается: `Failed to resolve import "../src/lib/credentials.js"`;
- в остальных пяти файлах 16 тестов из 103: `rules.test.ts` — 11 (новые правила ещё не экспортированы: `TypeError`; переписанные утверждения: `expected 'rules.name' to be 'rules.controlCharacter'` и родственные), `office.test.tsx` — 2 (`Unable to find an element with the text: В пароле есть повреждённый символ — наберите пароль заново`), `lines-page.test.tsx`, `devices-page.test.tsx` и `counterparties-page.test.tsx` — по 1 (`Unable to find an element with the text: Уберите табуляцию, перенос строки или другой служебный символ`).

- [ ] **Step 3: Хеши, правила, формы входа и тексты**

1. Create `apps/standalone/src/lib/credentials.ts`:

```ts
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";

// Operator credentials as the office makes them (stage 1 spec §5.5): the PIN
// and the badge code are hashed here, in the webview, and only the PHC
// strings reach the host. Neither the PIN nor the code is ever sent, logged
// or kept: the forms pass them in and drop them with the dialog.

/**
 * Iterations of a badge verifier: exactly the host's `secrets::BADGE_ITERATIONS`
 * and the cloud's `hashBadgeWithSalt`, which uses the domain's
 * `PHC_ITERATIONS`. The host refuses another count, and a station finds a
 * scanned badge by comparing the whole string, so a copy with another count
 * would never match.
 */
export const BADGE_ITERATIONS = 100_000;

/** A PIN verifier's salt: 16 random bytes, as `@markiro/domain` expects. */
const SALT_BYTES = 16;

/** Standard base64 with padding, as the PHC strings of the domain carry it. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A PIN verifier: a fresh random salt and the domain's `PHC_ITERATIONS`, in
 * the domain's format (`pbkdf2$sha256$100000$<salt>$<digest>`). The caller
 * passes the PIN its form accepted (`pinRule`).
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  return formatPhc(PHC_ITERATIONS, salt, await deriveDigestB64(pin, salt, PHC_ITERATIONS));
}

/**
 * A badge verifier under the site's salt (`GET /v1/office/badge-salt`) and
 * exactly `BADGE_ITERATIONS`, as the cloud's `hashBadgeWithSalt`: one code
 * always gives one string, which the host keeps on one operator. The code is
 * hashed as given; the caller passes the trimmed code its form accepted
 * (`badgeCodeRule`).
 */
export async function hashBadge(code: string, saltB64: string): Promise<string> {
  return formatPhc(
    BADGE_ITERATIONS,
    saltB64,
    await deriveDigestB64(code, saltB64, BADGE_ITERATIONS),
  );
}
```

2. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { z } from "zod";

import type { OrgProfileInput } from "../host/protocol.js";

// Field rules shared by the first-run wizard and the office pages. They
```

заменить на

<!-- prettier-ignore -->
```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
import type { OrgProfileInput } from "../host/protocol.js";

// Field rules shared by the first-run wizard and the office pages. They
```

3. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 */
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/**
 * Free text as the host takes it (`validate::clean_text`, already trimmed
 * here): 1 to `max` characters, counted as the host counts them, with no
```

заменить на

<!-- prettier-ignore -->
```ts
 */
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/** An unpaired surrogate on its own (see `CONTROL_OR_LONE_SURROGATE`). */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Free text as the host takes it (`validate::clean_text`, already trimmed
 * here): 1 to `max` characters, counted as the host counts them, with no
```

4. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return count >= 1 && count <= max && !CONTROL_OR_LONE_SURROGATE.test(text);
}

/** A free-text field of 1 to `max` characters (`isPlainText`); the value is trimmed. */
export function plainTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => isPlainText(text, max), message);
}

export const THIRTEEN_DIGITS = /^\d{13}$/;
```

заменить на

<!-- prettier-ignore -->
```ts
  return count >= 1 && count <= max && !CONTROL_OR_LONE_SURROGATE.test(text);
}

/**
 * Whether `text` can reach the host at all: no unpaired surrogate, which no
 * Rust string holds (see `CONTROL_OR_LONE_SURROGATE`), so the IPC call would
 * fail before the host and the form would blame the connection. Fields that
 * are not free text check it on their own: passwords and the sign-in's login.
 */
export function isTransferable(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/**
 * A free-text field of 1 to `max` characters (`isPlainText`); the value is
 * trimmed. A wrong length says `message`; a control character or an unpaired
 * surrogate says `rules.controlCharacter`, since a tab pasted from a
 * spreadsheet is invisible and a length message would not explain it.
 */
export function plainTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) >= 1 && characters(text) <= max, message)
    .refine((text) => !CONTROL_OR_LONE_SURROGATE.test(text), "rules.controlCharacter");
}

/**
 * An optional free-text field (`validate::optional_text`): blank is none,
 * otherwise as `plainTextRule`, at most `max` characters. The value is
 * trimmed; `toOptionalText` turns a blank one into `null`.
 */
export function optionalTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) <= max, message)
    .refine((text) => !CONTROL_OR_LONE_SURROGATE.test(text), "rules.controlCharacter");
}

/** An optional text as the host takes it: trimmed, and `null` when blank. */
export function toOptionalText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export const THIRTEEN_DIGITS = /^\d{13}$/;
```

5. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** A production line's name (`validate::line_name`). */
export const lineNameRule = plainTextRule(100, "rules.lineName");

/** The organization's or a counterparty's name (`validate::company`). */
export const companyNameRule = plainTextRule(200, "rules.orgName");
```

заменить на

<!-- prettier-ignore -->
```ts
/** A production line's name (`validate::line_name`). */
export const lineNameRule = plainTextRule(100, "rules.lineName");

/**
 * An operator's personnel number (`validate::operator_login`): 3 to 12 ASCII
 * digits. Leading zeros are part of it, so it stays text and is never
 * compared as a number.
 */
export const operatorLoginRule = z
  .string()
  .trim()
  .regex(/^[0-9]{3,12}$/, "rules.operatorLogin");

/** An operator's PIN: 4 to 6 ASCII digits. Only its hash leaves the office (`hashPin`). */
export const pinRule = z
  .string()
  .trim()
  .regex(/^[0-9]{4,6}$/, "rules.pin");

/** An operator's role (`validate::operator_role`): at most 120 characters, or none. */
export const operatorRoleRule = optionalTextRule(120, "rules.role");

/** A badge's label (`validate::badge_label`): at most 100 characters, or none. */
export const badgeLabelRule = optionalTextRule(100, "rules.badgeLabel");

/**
 * A badge code as a scanner types it: 1 to 256 characters after trimming, as
 * the cloud takes one (`issueBadgeSchema`), and printable ASCII only. A
 * keyboard-wedge scanner presses keys, so under the Russian layout the code
 * arrives in Cyrillic, while a station types the same badge through its own
 * layout: a Cyrillic code is refused with a hint to switch the layout and is
 * never read by key position, as a typed pairing code is (plan 1c3). Only the
 * code's hash leaves the office (`hashBadge`).
 */
export const badgeCodeRule = z
  .string()
  .trim()
  .refine((code) => !hasCyrillic(code), "rules.badgeCodeLayout")
  .refine((code) => /^[ -~]{1,256}$/.test(code), "rules.badgeCode");

/** The organization's or a counterparty's name (`validate::company`). */
export const companyNameRule = plainTextRule(200, "rules.orgName");
```

6. В `apps/standalone/src/lib/rules.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** GS1 prefixes as one comma-separated string: at most 10 of 4-12 digits (`validate::company`). */
export const gs1PrefixesRule = z.string().refine(isValidPrefixList, "rules.gs1Prefixes");

/** A password (`validate::password`). */
export const passwordRule = z
  .string()
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password");

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```ts
/** GS1 prefixes as one comma-separated string: at most 10 of 4-12 digits (`validate::company`). */
export const gs1PrefixesRule = z.string().refine(isValidPrefixList, "rules.gs1Prefixes");

/** A password (`validate::password`), with no unpaired surrogate (`isTransferable`). */
export const passwordRule = z
  .string()
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password")
  .refine(isTransferable, "rules.passwordCharacter");

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
```

7. В `apps/standalone/src/office/OfficeLogin.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";

const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required"),
  password: z.string().min(1, "office.login.required"),
});

type LoginValues = z.infer<typeof loginSchema>;
```

заменить на

<!-- prettier-ignore -->
```tsx
import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";
import { isTransferable } from "../lib/rules.js";

// An unpaired surrogate (pasted half of an emoji) cannot reach the host: the
// IPC call would fail as a lost connection, so the form refuses it first.
const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required").refine(isTransferable, "rules.login"),
  password: z
    .string()
    .min(1, "office.login.required")
    .refine(isTransferable, "rules.passwordCharacter"),
});

type LoginValues = z.infer<typeof loginSchema>;
```

8. В `apps/standalone/src/office/ChangePasswordDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

import { HostError } from "../host/client.js";
import type { PasswordChange } from "../host/protocol.js";
import { passwordRule } from "../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { WriteFailureAlert } from "./page-state.js";

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "office.password.required"),
  newPassword: passwordRule,
  confirmPassword: z.string(),
});
```

заменить на

<!-- prettier-ignore -->
```tsx

import { HostError } from "../host/client.js";
import type { PasswordChange } from "../host/protocol.js";
import { isTransferable, passwordRule } from "../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { WriteFailureAlert } from "./page-state.js";

const passwordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, "office.password.required")
    .refine(isTransferable, "rules.passwordCharacter"),
  newPassword: passwordRule,
  confirmPassword: z.string(),
});
```

9. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "glnCheckDigit": "Неверная контрольная цифра GLN",
    "gs1Prefixes": "Каждый префикс — от 4 до 12 цифр, не больше 10 префиксов",
    "timeZone": "Выберите часовой пояс",
    "rejected": "Хост не принял это значение. Проверьте его."
  },
  "org": {
    "name": "Название организации",
```

заменить на

<!-- prettier-ignore -->
```json
    "glnCheckDigit": "Неверная контрольная цифра GLN",
    "gs1Prefixes": "Каждый префикс — от 4 до 12 цифр, не больше 10 префиксов",
    "timeZone": "Выберите часовой пояс",
    "rejected": "Хост не принял это значение. Проверьте его.",
    "controlCharacter": "Уберите табуляцию, перенос строки или другой служебный символ",
    "passwordCharacter": "В пароле есть повреждённый символ — наберите пароль заново",
    "operatorLogin": "Табельный номер — от 3 до 12 цифр",
    "pin": "PIN — от 4 до 6 цифр",
    "role": "Должность — до 120 символов",
    "badgeLabel": "Подпись — до 100 символов",
    "badgeCode": "Код бейджа — от 1 до 256 символов: латинские буквы, цифры и знаки",
    "badgeCodeLayout": "Код набран русскими буквами — переключите раскладку на английскую"
  },
  "org": {
    "name": "Название организации",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`; затем под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») для тех же шести файлов.
Expected: PASS — 108 тестов в 6 файлах (5 в `credentials`, 29 в `rules`, 25 в `office`, 11 в `lines-page`, 28 в `devices-page`, 10 в `counterparties-page`); stderr verbose-прогона пуст; под стендом те же числа.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/lib/rules.ts` вернуть одну проверку свободного текста: фрагмент

<!-- prettier-ignore -->
```ts
    .refine((text) => characters(text) >= 1 && characters(text) <= max, message)
    .refine((text) => !CONTROL_OR_LONE_SURROGATE.test(text), "rules.controlCharacter");
```

заменить на

<!-- prettier-ignore -->
```ts
    .refine((text) => isPlainText(text, max), message);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "names a control character"`
Expected: FAIL — `expected 'rules.name' to be 'rules.controlCharacter'`.

Мутация 2. В `apps/standalone/src/lib/rules.ts` убрать проверку суррогата из пароля: фрагмент

<!-- prettier-ignore -->
```ts
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password")
  .refine(isTransferable, "rules.passwordCharacter");
```

заменить на

<!-- prettier-ignore -->
```ts
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts -t "unpaired surrogate in a password"`
Expected: FAIL — `expected undefined to be 'rules.passwordCharacter'`.

Мутация 3. В `apps/standalone/src/lib/credentials.ts` другое число итераций бейджа: фрагмент

<!-- prettier-ignore -->
```ts
export const BADGE_ITERATIONS = 100_000;
```

заменить на

<!-- prettier-ignore -->
```ts
export const BADGE_ITERATIONS = 200_000;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/credentials.test.ts`
Expected: FAIL — 2 теста: `expected 200000 to be 100000` и хеш «MRK-000742» не совпал с `badge-create.json`.

Мутация 4. В `apps/standalone/src/office/OfficeLogin.tsx` убрать проверку суррогата из пароля входа: фрагмент

<!-- prettier-ignore -->
```tsx
    .min(1, "office.login.required")
    .refine(isTransferable, "rules.passwordCharacter"),
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    .min(1, "office.login.required"),
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx -t "broken character in the login"`
Expected: FAIL — `Unable to find an element with the text: В пароле есть повреждённый символ — наберите пароль заново`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  than the host only because it sends the trimmed value it validated. A lone
  surrogate is refused as well: no Rust string holds one, `JSON.stringify`
  writes it as an escape serde_json rejects, and the IPC call would fail
  before the host as a lost connection.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
```

заменить на

<!-- prettier-ignore -->
```text
  than the host only because it sends the trimmed value it validated. A lone
  surrogate is refused as well: no Rust string holds one, `JSON.stringify`
  writes it as an escape serde_json rejects, and the IPC call would fail
  before the host as a lost connection. `plainTextRule`, and
  `optionalTextRule` for a role or a label that may be blank, says a wrong
  length in the field's own words and a control character or a lone
  surrogate with `rules.controlCharacter`: a tab pasted from a spreadsheet is
  invisible, and a length message would not explain it. The wizard's line
  names call `isPlainText` directly and keep their one message. Fields that
  are not free text refuse a lone surrogate themselves (`isTransferable`):
  every password (`rules.passwordCharacter`), and the sign-in's login.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
Revoking a badge is `DELETE …/badges/{badgeId}`, and revoking it again
changes nothing. Operators, badges and the salt are for administrators only,
reads included.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
Revoking a badge is `DELETE …/badges/{badgeId}`, and revoking it again
changes nothing. Operators, badges and the salt are for administrators only,
reads included.

The office's side lives in `src/lib/credentials.ts`: `hashPin` takes 16
fresh random salt bytes and the domain's `PHC_ITERATIONS`, `hashBadge` the
site's salt and exactly `BADGE_ITERATIONS` (100 000, the host's
`secrets::BADGE_ITERATIONS`), both in the domain's format, standard base64
with padding; `test/credentials.test.ts` reproduces `operator-create.json`
and `badge-create.json` byte for byte. Their fields follow the host
(`src/lib/rules.ts`): a personnel number of 3–12 ASCII digits, kept as text
with its leading zeros, a PIN of 4–6 ASCII digits, a role of up to 120
characters and a label of up to 100, both blank for none. A badge code is
what a scanner types: trimmed, 1–256 printable ASCII characters, and hashed
exactly so. A keyboard-wedge scanner presses keys, and a station types the
same badge through its own layout, so a code in Cyrillic is refused with a
hint to switch the layout, never read by key position.

## Reference sync
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `node_modules/.bin/prettier --check apps/standalone/src/lib/credentials.ts apps/standalone/src/lib/rules.ts apps/standalone/src/office/OfficeLogin.tsx apps/standalone/src/office/ChangePasswordDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/credentials.test.ts apps/standalone/test/rules.test.ts apps/standalone/test/office.test.tsx apps/standalone/test/lines-page.test.tsx apps/standalone/test/devices-page.test.tsx apps/standalone/test/counterparties-page.test.tsx apps/standalone/AGENTS.md`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 34 файла, 664 теста; `grep` находит только `src/host/pairing-code.ts:66`.

```bash
git add apps/standalone/src/lib/credentials.ts apps/standalone/src/lib/rules.ts apps/standalone/src/office/OfficeLogin.tsx apps/standalone/src/office/ChangePasswordDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/credentials.test.ts apps/standalone/test/rules.test.ts apps/standalone/test/office.test.tsx apps/standalone/test/lines-page.test.tsx apps/standalone/test/devices-page.test.tsx apps/standalone/test/counterparties-page.test.tsx apps/standalone/AGENTS.md
git commit -m "feat(standalone): хеши PIN и бейджа в офисе, правила полей операторов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Схемы, сборщики тел и методы `HostApi` для операторов — `src/host/`

Провод плана 1d2 для людей, по правилу «Protocol» `AGENTS.md`, как в плане 1d3: схемы ответов — нестрогий `z.object`, схемы тел — `.strict()`, одно тело — один сборщик в `src/host/requests.ts`, который называет каждое поле; идентификаторы — только в пути. Каждая фикстура разбирается своей схемой и собирается своим сборщиком точно: `office-operator.json`, `badge-salt.json`, `operator-create.json`, `operator-update.json`, `badge-create.json`. Записи ленты людей (`changes-people.json`) — задача 6: их схемы строгие и проверяют хеши.

`operator-update.json` показывает правку, которая снимает должность (`role: null`), выключает оператора и меняет PIN: сборщик шлёт только отличающееся от загруженного оператора, новый `pinPhc` — всегда, и всегда `expectedRev`.

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`
- Modify (целиком): `apps/standalone/test/protocol.test.ts`
- Modify: `apps/standalone/test/api.test.ts`

**Interfaces:**

- Consumes: `HostClient.request`, `NO_CONTENT` — `src/host/client.ts`, `src/host/api.ts`.
- Produces:
  - `badgeInfoSchema`/`BadgeInfo { id; label: string | null; createdAt; revokedAt: string | null }`, `officeOperatorSchema`/`OfficeOperator { id; login; name; role: string | null; active; hasPin; badges: BadgeInfo[]; rev }`, `badgeSaltSchema`/`BadgeSalt { badgeSalt }`, `operatorCreateSchema`/`OperatorCreate`, `operatorUpdateSchema`/`OperatorUpdate`, `badgeCreateSchema`/`BadgeCreate` — `src/host/protocol.ts`;
  - `interface OperatorInput { login; name; role: string | null; pinPhc }`, `operatorCreate(operator: OperatorInput): OperatorCreate`, `interface OperatorChange { name?; role?: string | null; active?; pinPhc? }`, `operatorUpdate(operator: Pick<OfficeOperator, "name" | "role" | "active" | "rev">, next: OperatorChange): OperatorUpdate`, `interface BadgeInput { badgePhc; label: string | null }`, `badgeCreate(badge: BadgeInput): BadgeCreate` — `src/host/requests.ts`;
  - `HostApi.listOperators(token)`, `createOperator(token, create)`, `updateOperator(token, id, update)`, `createBadge(token, operatorId, create): Promise<BadgeInfo>`, `revokeBadge(token, operatorId, badgeId): Promise<void>`, `getBadgeSalt(token): Promise<BadgeSalt>`; `fakeHostApi` отвечает на них `unexpected()`.

- [ ] **Step 1: Тесты (падающие)**

1. Заменить содержимое `apps/standalone/test/protocol.test.ts` целиком:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyCreateSchema,
  counterpartyRecordSchema,
  counterpartyUpdateSchema,
  credentialSchema,
  deviceInfoSchema,
  deviceRecordSchema,
  deviceUpdateSchema,
  errorBodySchema,
  helloSchema,
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  orgRecordSchema,
  pairingCodeRequestSchema,
  pairingCodeSchema,
  passwordChangeSchema,
  passwordSetSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";
import {
  badgeCreate,
  counterpartyCreate,
  counterpartyUpdate,
  deviceUpdate,
  lineCreate,
  lineUpdate,
  operatorCreate,
  operatorUpdate,
  pairingCodeRequest,
} from "../src/host/requests.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
// for browser asset bundling (see `vite:asset-import-meta-url`); under the
// jsdom test environment that rewrite resolves against a fake browser
// location instead of this file's real path, breaking a plain fixture read.
// Binding the value first keeps this a normal runtime URL resolution.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("protocol schemas parse the shared Rust fixtures", () => {
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: 1,
      initialized: false,
    });
  });

  it("error bodies", () => {
    expect(errorBodySchema.parse(fixture("error-not-found.json")).error.code).toBe("not_found");
    expect(errorBodySchema.parse(fixture("error-with-details.json")).error.details).toEqual({
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 1,
    });
  });

  it("rejects unknown fields in payloads the Rust shell rebuilds from proto types", () => {
    const hello = { ...(fixture("hello.json") as Record<string, unknown>), extra: true };
    expect(helloSchema.safeParse(hello).success).toBe(false);
  });

  it("rejects non-object error details, like the Rust Map type", () => {
    const body = fixture("error-with-details.json") as { error: Record<string, unknown> };
    expect(
      errorBodySchema.safeParse({ error: { ...body.error, details: "not an object" } }).success,
    ).toBe(false);
  });

  it("pairing code", () => {
    expect(pairingCodeSchema.parse(fixture("pairing-code.json"))).toMatchObject({
      code: "7K3MQ9XV2D",
      expiresAt: "2026-09-26T09:25:00Z",
    });
  });

  it("device record", () => {
    expect(deviceRecordSchema.parse(fixture("device-record.json"))).toMatchObject({
      kind: "station",
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      revokedAt: null,
    });
  });

  it("change feed", () => {
    const rawChanges = fixture("changes-response.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    expect(changes.items).toHaveLength(4);
    expect(lineRecordSchema.parse(changes.items[0]?.data)).toEqual(rawChanges.items[0]?.data);
    expect(orgRecordSchema.parse(changes.items[1]?.data)).toEqual(rawChanges.items[1]?.data);
    expect(siteRecordSchema.parse(changes.items[2]?.data)).toEqual(rawChanges.items[2]?.data);
    expect(changes.items[3]).toMatchObject({ deleted: true });
    expect(changes.items[3]?.data).toBeUndefined();
  });
});

// Host responses pass through the shell unchanged: lenient, like the Rust
// response types. Requests are strict, like the host's deny_unknown_fields.
const RESPONSES = [
  ["device-info.json", deviceInfoSchema],
  ["device-record.json", deviceRecordSchema],
  ["office-user.json", officeUserSchema],
  ["office-session.json", officeSessionSchema],
  ["bootstrap-response.json", bootstrapResponseSchema],
  ["org-profile.json", orgProfileSchema],
  ["sscc-state.json", ssccStateSchema],
  ["office-user-record.json", officeUserRecordSchema],
  ["error-unauthorized.json", errorBodySchema],
  ["pairing-code.json", pairingCodeSchema],
  ["changes-response.json", changesResponseSchema],
  ["counterparty-record.json", counterpartyRecordSchema],
  ["office-line.json", officeLineSchema],
  ["office-operator.json", officeOperatorSchema],
  ["badge-salt.json", badgeSaltSchema],
] as const;

const REQUESTS = [
  ["office-login-request.json", officeLoginRequestSchema],
  ["bootstrap-request.json", bootstrapRequestSchema],
  ["org-profile-update.json", orgProfileUpdateSchema],
  ["sscc-counter-update.json", ssccCounterUpdateSchema],
  ["block-sizes-update.json", blockSizesUpdateSchema],
  ["office-user-create.json", officeUserCreateSchema],
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
  ["counterparty-create.json", counterpartyCreateSchema],
  ["counterparty-update.json", counterpartyUpdateSchema],
  ["line-create.json", lineCreateSchema],
  ["line-update.json", lineUpdateSchema],
  ["device-update.json", deviceUpdateSchema],
  ["pairing-code-request.json", pairingCodeRequestSchema],
  ["operator-create.json", operatorCreateSchema],
  ["operator-update.json", operatorUpdateSchema],
  ["badge-create.json", badgeCreateSchema],
] as const;

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(true);
  });
});

describe.each(REQUESTS)("request fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("rejects an unknown field, like the host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(false);
  });
});

// Every request body the office sends has one builder, which names each
// field (no spread from form values); each must produce its fixture exactly.
describe("request builders produce their fixtures exactly", () => {
  it("a counterparty to create and one to update", () => {
    expect(
      counterpartyCreate({
        name: "ООО «Северный берег»",
        inn: null,
        gln: "4601234000017",
        gs1Prefixes: ["4601234"],
      }),
    ).toStrictEqual(fixture("counterparty-create.json"));
    expect(
      counterpartyUpdate(
        {
          name: "ООО «Северный берег»",
          inn: "7812345678",
          gln: "4601234000017",
          gs1Prefixes: ["4601234", "4609876"],
        },
        true,
        12,
      ),
    ).toStrictEqual(fixture("counterparty-update.json"));
  });

  it("a line to create and one to archive", () => {
    const line = officeLineSchema.parse(fixture("office-line.json"));
    expect(lineCreate("Линия 3")).toStrictEqual(fixture("line-create.json"));
    expect(lineUpdate(line, { name: line.name, archived: true })).toStrictEqual(
      fixture("line-update.json"),
    );
  });

  it("a station renamed and taken off its line", () => {
    const device = deviceRecordSchema.parse(fixture("device-record.json"));
    expect(deviceUpdate(device, { name: "Станция упаковки", lineId: null })).toStrictEqual(
      fixture("device-update.json"),
    );
  });

  it("a new pairing code that replaces the one on screen", () => {
    const code = pairingCodeSchema.parse(fixture("pairing-code.json"));
    expect(pairingCodeRequest(code.id)).toStrictEqual(fixture("pairing-code-request.json"));
  });

  it("an operator to create, and one to update that clears the role, turns off and gets a new PIN", () => {
    const { pinPhc } = operatorCreateSchema.parse(fixture("operator-create.json"));
    expect(
      operatorCreate({ login: "0042", name: "Анна Кузнецова", role: "Упаковщик", pinPhc }),
    ).toStrictEqual(fixture("operator-create.json"));
    const operator = officeOperatorSchema.parse(fixture("office-operator.json"));
    expect(
      operatorUpdate({ ...operator, role: "Упаковщик" }, { role: null, active: false, pinPhc }),
    ).toStrictEqual(fixture("operator-update.json"));
  });

  it("a badge to add", () => {
    const { badgePhc } = badgeCreateSchema.parse(fixture("badge-create.json"));
    expect(badgeCreate({ badgePhc, label: "Пропуск №7" })).toStrictEqual(
      fixture("badge-create.json"),
    );
  });
});

describe("request builders send only what changes", () => {
  const LINE = { name: "Линия 2", archived: false, rev: 40 };
  const STATION = {
    kind: "station",
    name: "Станция на линии 2",
    lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  } as const;

  it("names only the line fields that differ from the loaded line", () => {
    expect(lineUpdate(LINE, { name: "Линия 2", archived: false })).toStrictEqual({
      expectedRev: 40,
    });
    expect(lineUpdate(LINE, { name: "Линия 2а", archived: false })).toStrictEqual({
      name: "Линия 2а",
      expectedRev: 40,
    });
    expect(
      lineUpdate({ ...LINE, archived: true }, { name: "Линия 5", archived: false }),
    ).toStrictEqual({ name: "Линия 5", archived: false, expectedRev: 40 });
  });

  it("names only the device fields that differ, and a line only for a station", () => {
    expect(
      deviceUpdate(STATION, { name: "Станция на линии 2", lineId: STATION.lineId }),
    ).toStrictEqual({});
    expect(deviceUpdate(STATION, { name: "Упаковка", lineId: STATION.lineId })).toStrictEqual({
      name: "Упаковка",
    });
    const other = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    expect(deviceUpdate(STATION, { name: STATION.name, lineId: other })).toStrictEqual({
      lineId: other,
    });
    expect(
      deviceUpdate({ kind: "office", name: "Офис", lineId: null }, { name: "Офис", lineId: other }),
    ).toStrictEqual({});
  });

  it("names only the operator fields that differ, clears a role with null and always sends a new PIN", () => {
    const anna = { name: "Анна Кузнецова", role: "Упаковщик", active: true, rev: 55 };
    const pinPhc = "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$new";
    expect(operatorUpdate(anna, { name: "Анна Кузнецова", role: "Упаковщик" })).toStrictEqual({
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { name: "Анна Петрова", role: "Упаковщик" })).toStrictEqual({
      name: "Анна Петрова",
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { name: "Анна Кузнецова", role: null })).toStrictEqual({
      role: null,
      expectedRev: 55,
    });
    expect(operatorUpdate({ ...anna, role: null }, { role: "Наладчик" })).toStrictEqual({
      role: "Наладчик",
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { active: false })).toStrictEqual({
      active: false,
      expectedRev: 55,
    });
    expect(operatorUpdate(anna, { active: true })).toStrictEqual({ expectedRev: 55 });
    expect(operatorUpdate(anna, { pinPhc })).toStrictEqual({ pinPhc, expectedRev: 55 });
  });

  it("copies the prefix list rather than handing over the caller's array", () => {
    const gs1Prefixes = ["4601234"];
    const body = counterpartyCreate({
      name: "ООО «Юг»",
      inn: null,
      gln: "4601234000017",
      gs1Prefixes,
    });
    gs1Prefixes.push("4609876");
    expect(body.gs1Prefixes).toEqual(["4601234"]);
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});
```

2. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  lineUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
} from "../src/host/protocol.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  badgeCreateSchema,
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  deviceUpdateSchema,
  lineUpdateSchema,
  officeOperatorSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileUpdateSchema,
  pairingCodeRequestSchema,
} from "../src/host/protocol.js";
```

3. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
const LINE_UPDATE = lineUpdateSchema.parse(fixture("line-update.json"));
const DEVICE_UPDATE = deviceUpdateSchema.parse(fixture("device-update.json"));
const PAIRING_CODE_REQUEST = pairingCodeRequestSchema.parse(fixture("pairing-code-request.json"));

type Case = [
  name: string,
```

заменить на

<!-- prettier-ignore -->
```ts
const LINE_UPDATE = lineUpdateSchema.parse(fixture("line-update.json"));
const DEVICE_UPDATE = deviceUpdateSchema.parse(fixture("device-update.json"));
const PAIRING_CODE_REQUEST = pairingCodeRequestSchema.parse(fixture("pairing-code-request.json"));
const OPERATOR = officeOperatorSchema.parse(fixture("office-operator.json"));
const OPERATOR_CREATE = operatorCreateSchema.parse(fixture("operator-create.json"));
const OPERATOR_UPDATE = operatorUpdateSchema.parse(fixture("operator-update.json"));
const BADGE_CREATE = badgeCreateSchema.parse(fixture("badge-create.json"));
const BADGE_ID = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

type Case = [
  name: string,
```

4. В `apps/standalone/test/api.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    { method: "PUT", path: `/v1/office/lines/${LINE_ID}`, body: LINE_UPDATE },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "PUT", path: `/v1/office/lines/${LINE_ID}`, body: LINE_UPDATE },
  ],
  [
    "listOperators",
    [fixture("office-operator.json")],
    (api) => api.listOperators(TOKEN),
    { method: "GET", path: "/v1/office/operators", body: undefined },
  ],
  [
    "createOperator",
    fixture("office-operator.json"),
    (api) => api.createOperator(TOKEN, OPERATOR_CREATE),
    { method: "POST", path: "/v1/office/operators", body: OPERATOR_CREATE },
  ],
  [
    "updateOperator",
    fixture("office-operator.json"),
    (api) => api.updateOperator(TOKEN, OPERATOR.id, OPERATOR_UPDATE),
    { method: "PUT", path: `/v1/office/operators/${OPERATOR.id}`, body: OPERATOR_UPDATE },
  ],
  [
    "createBadge",
    OPERATOR.badges[1],
    (api) => api.createBadge(TOKEN, OPERATOR.id, BADGE_CREATE),
    { method: "POST", path: `/v1/office/operators/${OPERATOR.id}/badges`, body: BADGE_CREATE },
  ],
  [
    "revokeBadge",
    null,
    (api) => api.revokeBadge(TOKEN, OPERATOR.id, BADGE_ID),
    {
      method: "DELETE",
      path: `/v1/office/operators/${OPERATOR.id}/badges/${BADGE_ID}`,
      body: undefined,
    },
  ],
  [
    "getBadgeSalt",
    fixture("badge-salt.json"),
    (api) => api.getBadgeSalt(TOKEN),
    { method: "GET", path: "/v1/office/badge-salt", body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
Expected: FAIL:

- `api.test.ts` не загружается: `TypeError: Cannot read properties of undefined (reading 'parse')` (новых схем ещё нет);
- в `protocol.test.ts` 13 тестов из 84: фикстуры `office-operator.json`, `badge-salt.json`, `operator-create.json`, `operator-update.json`, `badge-create.json` (`TypeError: Cannot read properties of undefined (reading 'parse')` / `'safeParse'`), оба новых сборщика и «names only the operator fields that differ…» (`TypeError: operatorUpdate is not a function`).

- [ ] **Step 3: Схемы, сборщики, методы и подделка `HostApi`**

1. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});
export type OfficeLine = z.infer<typeof officeLineSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OfficeLine = z.infer<typeof officeLineSchema>;

/** A badge as the administrator sees it: never its hash; revoked badges stay listed with `revokedAt`. */
export const badgeInfoSchema = z.object({
  id: z.uuid(),
  label: z.string().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type BadgeInfo = z.infer<typeof badgeInfoSchema>;

/**
 * `GET /v1/office/operators`: an operator as the administrator sees it,
 * `hasPin` and the badges' details instead of any hash. `login` is the
 * personnel number, text with its leading zeros.
 */
export const officeOperatorSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  active: z.boolean(),
  hasPin: z.boolean(),
  badges: z.array(badgeInfoSchema),
  rev: z.number().int(),
});
export type OfficeOperator = z.infer<typeof officeOperatorSchema>;

/** `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard base64 with padding. */
export const badgeSaltSchema = z.object({ badgeSalt: z.base64().length(24) });
export type BadgeSalt = z.infer<typeof badgeSaltSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

2. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** The optional body of `POST /v1/office/pairing-codes`: the code «Новый код» replaces. */
export const pairingCodeRequestSchema = z.object({ replaces: z.uuid().optional() }).strict();
export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
/** The optional body of `POST /v1/office/pairing-codes`: the code «Новый код» replaces. */
export const pairingCodeRequestSchema = z.object({ replaces: z.uuid().optional() }).strict();
export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;

/**
 * `POST /v1/office/operators`: the PIN's hash, never the PIN; the office
 * always sends `role`, `null` for none.
 */
export const operatorCreateSchema = z
  .object({ login: z.string(), name: z.string(), role: z.string().nullable(), pinPhc: z.string() })
  .strict();
export type OperatorCreate = z.infer<typeof operatorCreateSchema>;

/** `PUT /v1/office/operators/{id}`: only the fields sent change; `role: null` clears the role. */
export const operatorUpdateSchema = z
  .object({
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    active: z.boolean().optional(),
    pinPhc: z.string().optional(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OperatorUpdate = z.infer<typeof operatorUpdateSchema>;

/**
 * `POST /v1/office/operators/{id}/badges`: the badge code's hash under the
 * site's salt, never the code; the office always sends `label`, `null` for none.
 */
export const badgeCreateSchema = z
  .object({ badgePhc: z.string(), label: z.string().nullable() })
  .strict();
export type BadgeCreate = z.infer<typeof badgeCreateSchema>;
```

3. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type {
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
```

заменить на

<!-- prettier-ignore -->
```ts
import type {
  BadgeCreate,
  CounterpartyCreate,
  CounterpartyUpdate,
  DeviceRecord,
```

4. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  LineCreate,
  LineUpdate,
  OfficeLine,
  PairingCodeRequest,
} from "./protocol.js";
```

заменить на

<!-- prettier-ignore -->
```ts
  LineCreate,
  LineUpdate,
  OfficeLine,
  OfficeOperator,
  OperatorCreate,
  OperatorUpdate,
  PairingCodeRequest,
} from "./protocol.js";
```

5. В `apps/standalone/src/host/requests.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export function pairingCodeRequest(replaces: string): PairingCodeRequest {
  return { replaces };
}
```

заменить на

<!-- prettier-ignore -->
```ts
export function pairingCodeRequest(replaces: string): PairingCodeRequest {
  return { replaces };
}

/**
 * A new operator: the trimmed values the form accepted, `role: null` for
 * none (`toOptionalText`), and the PIN's hash (`hashPin`), never the PIN.
 */
export interface OperatorInput {
  login: string;
  name: string;
  role: string | null;
  pinPhc: string;
}

/** `POST /v1/office/operators` (`operator-create.json`). */
export function operatorCreate(operator: OperatorInput): OperatorCreate {
  return {
    login: operator.login,
    name: operator.name,
    role: operator.role,
    pinPhc: operator.pinPhc,
  };
}

/**
 * What an operator is to become; a field left out stays as it is. `name` and
 * `role` are the trimmed values the form accepted (`role: null` for none);
 * `pinPhc` is a new PIN's hash.
 */
export interface OperatorChange {
  name?: string;
  role?: string | null;
  active?: boolean;
  pinPhc?: string;
}

/**
 * `PUT /v1/office/operators/{id}` (`operator-update.json`): only the fields
 * that differ from the loaded operator, with its revision; `role: null`
 * clears the role. A new PIN's hash always goes: its fresh salt makes every
 * hash differ, and the host keeps no PIN to compare with.
 */
export function operatorUpdate(
  operator: Pick<OfficeOperator, "name" | "role" | "active" | "rev">,
  next: OperatorChange,
): OperatorUpdate {
  const update: OperatorUpdate = { expectedRev: operator.rev };
  if (next.name !== undefined && next.name !== operator.name) update.name = next.name;
  if (next.role !== undefined && next.role !== operator.role) update.role = next.role;
  if (next.active !== undefined && next.active !== operator.active) update.active = next.active;
  if (next.pinPhc !== undefined) update.pinPhc = next.pinPhc;
  return update;
}

/**
 * A new badge: the code's hash under the site's salt (`hashBadge`), never the
 * code, and the trimmed label, `null` for none.
 */
export interface BadgeInput {
  badgePhc: string;
  label: string | null;
}

/** `POST /v1/office/operators/{id}/badges` (`badge-create.json`). */
export function badgeCreate(badge: BadgeInput): BadgeCreate {
  return { badgePhc: badge.badgePhc, label: badge.label };
}
```

6. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  officeLineSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
```

заменить на

<!-- prettier-ignore -->
```ts

import type { HostClient } from "./client.js";
import {
  badgeInfoSchema,
  badgeSaltSchema,
  bootstrapResponseSchema,
  changesResponseSchema,
  counterpartyRecordSchema,
  deviceRecordSchema,
  officeLineSchema,
  officeOperatorSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
```

7. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
```

заменить на

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BadgeCreate,
  type BadgeInfo,
  type BadgeSalt,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
```

8. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
```

заменить на

<!-- prettier-ignore -->
```ts
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OperatorCreate,
  type OperatorUpdate,
  type OrgProfile,
  type OrgProfileUpdate,
  type PairingCode,
```

9. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  listLines: (token: string) => Promise<OfficeLine[]>;
  createLine: (token: string, create: LineCreate) => Promise<OfficeLine>;
  updateLine: (token: string, id: string, update: LineUpdate) => Promise<OfficeLine>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  listLines: (token: string) => Promise<OfficeLine[]>;
  createLine: (token: string, create: LineCreate) => Promise<OfficeLine>;
  updateLine: (token: string, id: string, update: LineUpdate) => Promise<OfficeLine>;
  listOperators: (token: string) => Promise<OfficeOperator[]>;
  createOperator: (token: string, create: OperatorCreate) => Promise<OfficeOperator>;
  updateOperator: (token: string, id: string, update: OperatorUpdate) => Promise<OfficeOperator>;
  /** Answers the new badge, not its operator: a badge is a record of its own. */
  createBadge: (token: string, operatorId: string, create: BadgeCreate) => Promise<BadgeInfo>;
  /** `204`; revoking a badge that is already revoked changes nothing. */
  revokeBadge: (token: string, operatorId: string, badgeId: string) => Promise<void>;
  /** The site's badge salt; `not_found` before the wizard created it. */
  getBadgeSalt: (token: string) => Promise<BadgeSalt>;
}

/** A 204 answer parses as `null`. */
```

10. В `apps/standalone/src/host/api.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: officeLineSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: officeLineSchema,
      }),
    listOperators: (token) =>
      client.request("GET", "/v1/office/operators", {
        officeToken: token,
        schema: z.array(officeOperatorSchema),
      }),
    createOperator: (token, create) =>
      client.request("POST", "/v1/office/operators", {
        body: create,
        officeToken: token,
        schema: officeOperatorSchema,
      }),
    updateOperator: (token, id, update) =>
      client.request("PUT", `/v1/office/operators/${id}`, {
        body: update,
        officeToken: token,
        schema: officeOperatorSchema,
      }),
    createBadge: (token, operatorId, create) =>
      client.request("POST", `/v1/office/operators/${operatorId}/badges`, {
        body: create,
        officeToken: token,
        schema: badgeInfoSchema,
      }),
    revokeBadge: async (token, operatorId, badgeId) => {
      await client.request("DELETE", `/v1/office/operators/${operatorId}/badges/${badgeId}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getBadgeSalt: (token) =>
      client.request("GET", "/v1/office/badge-salt", {
        officeToken: token,
        schema: badgeSaltSchema,
      }),
  };
}
```

11. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    listLines: vi.fn<HostApi["listLines"]>(() => unexpected("listLines")),
    createLine: vi.fn<HostApi["createLine"]>(() => unexpected("createLine")),
    updateLine: vi.fn<HostApi["updateLine"]>(() => unexpected("updateLine")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    listLines: vi.fn<HostApi["listLines"]>(() => unexpected("listLines")),
    createLine: vi.fn<HostApi["createLine"]>(() => unexpected("createLine")),
    updateLine: vi.fn<HostApi["updateLine"]>(() => unexpected("updateLine")),
    listOperators: vi.fn<HostApi["listOperators"]>(() => unexpected("listOperators")),
    createOperator: vi.fn<HostApi["createOperator"]>(() => unexpected("createOperator")),
    updateOperator: vi.fn<HostApi["updateOperator"]>(() => unexpected("updateOperator")),
    createBadge: vi.fn<HostApi["createBadge"]>(() => unexpected("createBadge")),
    revokeBadge: vi.fn<HostApi["revokeBadge"]>(() => unexpected("revokeBadge")),
    getBadgeSalt: vi.fn<HostApi["getBadgeSalt"]>(() => unexpected("getBadgeSalt")),
    ...overrides,
  };
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`.
Expected: PASS — 114 тестов (84 в `protocol.test.ts`, 30 в `api.test.ts`); stderr пуст.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/host/requests.ts` слать должность всегда: фрагмент

<!-- prettier-ignore -->
```ts
  if (next.role !== undefined && next.role !== operator.role) update.role = next.role;
```

заменить на

<!-- prettier-ignore -->
```ts
  if (next.role !== undefined) update.role = next.role;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "names only the operator fields"`
Expected: FAIL — `expected { expectedRev: 55, role: 'Упаковщик' } to strictly equal { expectedRev: 55 }`.

Мутация 2. В `apps/standalone/src/host/protocol.ts` снять строгость с тела нового оператора: фрагмент

<!-- prettier-ignore -->
```ts
  .object({ login: z.string(), name: z.string(), role: z.string().nullable(), pinPhc: z.string() })
  .strict();
```

заменить на

<!-- prettier-ignore -->
```ts
  .object({ login: z.string(), name: z.string(), role: z.string().nullable(), pinPhc: z.string() });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts -t "operator-create.json"`
Expected: FAIL — «request fixture operator-create.json > rejects an unknown field, like the host»: `expected true to be false`.

- [ ] **Step 6: Документы**

Правило «Protocol» в `apps/standalone/AGENTS.md` уже описывает сборщики, строгие тела и фикстуры; спецификация §4.5 уже перечисляет фикстуры людей. Документы не меняются.

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 34 файла, 683 теста.

```bash
git add apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts
git commit -m "feat(standalone): провод офиса для операторов и бейджей" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Конфликт `badge` называет владельца бейджа — `host/src/routes/operators.rs`

Единственная правка хоста в этом плане (решение контроллера). Когда вставка бейджа натыкается на частичный уникальный индекс `operator_badges_active_phc`, та же транзакция записи читает, у какого оператора активный бейдж с тем же хешем, и конфликт несёт его id: `details = { constraint: "badge", operatorId }`. Маршрут только для администраторов, а они и так видят всех операторов, поэтому ничего не утекает. Диалог бейджа (задача 5) скажет «Этот бейдж уже у оператора «…»». Типы `proto/` не меняются: `details` — нетипизированный JSON.

Тест — в `host/tests/badges.rs`: там с плана 1d2 живут тесты бейджей, и прежний тест `one_badge_code_belongs_to_one_operator_at_a_time` сверяет теперь `details` целиком — и для другого оператора, и для самого владельца.

**Files:**

- Modify: `apps/standalone/host/src/routes/operators.rs`, `apps/standalone/host/tests/badges.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.6)

**Interfaces:**

- Consumes: `ApiError::conflict_on_unique_violation`, `ApiError::with_details`, `ApiError::code` — `host/src/error.rs`; `markiro_proto::codes::CONFLICT`.
- Produces: ответ `409 conflict` на `POST /v1/office/operators/{id}/badges` с `details: { constraint: "badge", operatorId: <id владельца> }` (задача 5 читает `operatorId`).

- [ ] **Step 1: Тест (падающий)**

1. В `apps/standalone/host/tests/badges.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    );
}

#[tokio::test]
async fn one_badge_code_belongs_to_one_operator_at_a_time() {
    let admin = admin().await;
```

заменить на

<!-- prettier-ignore -->
```rust
    );
}

/// A badge code belongs to one operator at a time; the conflict names that
/// operator (`details.operatorId`), whoever asks for the same code again.
#[tokio::test]
async fn one_badge_code_belongs_to_one_operator_at_a_time() {
    let admin = admin().await;
```

2. В `apps/standalone/host/tests/badges.rs`, фрагмент

<!-- prettier-ignore -->
```rust
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"]["constraint"].clone()),
            (StatusCode::CONFLICT, json!("badge"))
        );
    }
    // A revoked badge frees its code; the new badge gets a new id.
```

заменить на

<!-- prettier-ignore -->
```rust
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "badge", "operatorId": first })
            )
        );
    }
    // A revoked badge frees its code; the new badge gets a new id.
```

- [ ] **Step 2: Запустить тест — он падает**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline`
Expected: FAIL — 1 из 8, `one_badge_code_belongs_to_one_operator_at_a_time`:

```text
  left: (409, Object {"constraint": String("badge")})
 right: (409, Object {"constraint": String("badge"), "operatorId": String("…")})
```

- [ ] **Step 3: Владелец в конфликте**

1. В `apps/standalone/host/src/routes/operators.rs`, фрагмент

<!-- prettier-ignore -->
```rust
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{
    entities, BadgeCreate, BadgeInfo, BadgeSalt, OfficeOperator, OperatorCreate, OperatorUpdate,
    Secret,
};
use serde_json::json;
use sqlx::SqliteConnection;
```

заменить на

<!-- prettier-ignore -->
```rust
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{
    codes, entities, BadgeCreate, BadgeInfo, BadgeSalt, OfficeOperator, OperatorCreate,
    OperatorUpdate, Secret,
};
use serde_json::json;
use sqlx::SqliteConnection;
```

2. В `apps/standalone/host/src/routes/operators.rs`, фрагмент

<!-- prettier-ignore -->
```rust
}

/// A write that hit `operator_badges_active_phc`: the badge is already an
/// active badge of some operator.
fn badge_taken(error: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(
        error,
        "badge",
        "this badge already belongs to an operator",
    )
}

/// `GET /v1/office/badge-salt` (administrators): the salt the office hashes
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// A write that hit `operator_badges_active_phc`: the badge is already an
/// active badge of some operator, whom `details.operatorId` names, read in
/// the same transaction. Only administrators reach this route, and they see
/// every operator anyway. Any other failure is `internal`.
async fn badge_taken(conn: &mut SqliteConnection, error: sqlx::Error, badge_phc: &str) -> ApiError {
    let conflict = ApiError::conflict_on_unique_violation(
        error,
        "badge",
        "this badge already belongs to an operator",
    );
    if conflict.code() != codes::CONFLICT {
        return conflict;
    }
    let owner: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "SELECT operator_id FROM operator_badges WHERE badge_phc = ? AND revoked_at IS NULL",
    )
    .bind(badge_phc)
    .fetch_optional(&mut *conn)
    .await;
    match owner {
        Ok(Some(operator_id)) => {
            conflict.with_details(json!({ "constraint": "badge", "operatorId": operator_id }))
        }
        Ok(None) => conflict,
        Err(error) => ApiError::internal(error),
    }
}

/// `GET /v1/office/badge-salt` (administrators): the salt the office hashes
```

3. В `apps/standalone/host/src/routes/operators.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        return Err(ApiError::not_found("no such operator"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
```

заменить на

<!-- prettier-ignore -->
```rust
        return Err(ApiError::not_found("no such operator"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let inserted = sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
```

4. В `apps/standalone/host/src/routes/operators.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(badge_taken)?;
    audit::record(
        &mut tx,
        &at,
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        return Err(badge_taken(&mut tx, error, create.badge_phc.expose()).await);
    }
    audit::record(
        &mut tx,
        &at,
```

- [ ] **Step 4: Запустить тест — он проходит**

Run: та же команда, что в шаге 2.
Expected: PASS — 8 тестов.

- [ ] **Step 5: Мутация — тест ловит конфликт без владельца**

Мутация 1. В `apps/standalone/host/src/routes/operators.rs` вернуть конфликт без `operatorId`: фрагмент

<!-- prettier-ignore -->
```rust
        Ok(Some(operator_id)) => {
            conflict.with_details(json!({ "constraint": "badge", "operatorId": operator_id }))
        }
        Ok(None) => conflict,
```

заменить на

<!-- prettier-ignore -->
```rust
        Ok(Some(_)) | Ok(None) => conflict,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline one_badge_code`
Expected: FAIL — паника в `host/tests/badges.rs:199:9`, `assertion left == right failed`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
one string — `parse_phc` refuses a leading zero in the count, so `0100000`
is not a second spelling of `100000` — and the partial unique index
`operator_badges_active_phc` keeps it on one operator (`conflict` with
`constraint: badge`). The office never gets a hash back: operator reads carry
`hasPin` and each badge's `id`, `label`, `createdAt` and `revokedAt`.
Revoking a badge is `DELETE …/badges/{badgeId}`, and revoking it again
changes nothing. Operators, badges and the salt are for administrators only,
```

заменить на

<!-- prettier-ignore -->
```text
one string — `parse_phc` refuses a leading zero in the count, so `0100000`
is not a second spelling of `100000` — and the partial unique index
`operator_badges_active_phc` keeps it on one operator (`conflict` with
`constraint: badge` and `operatorId`, the operator who holds it, read in the
same transaction; only administrators reach the route, and they see every
operator anyway). The office never gets a hash back: operator reads carry
`hasPin` and each badge's `id`, `label`, `createdAt` and `revokedAt`.
Revoking a badge is `DELETE …/badges/{badgeId}`, and revoking it again
changes nothing. Operators, badges and the salt are for administrators only,
```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin`, `login`,
`badge`, `line_name`), `template_is_default`, `last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

заменить на

<!-- prettier-ignore -->
```text
`session` — войти в офис заново, `password` — показывает текст под неверный
логин или пароль), `forbidden`, `not_found`, `method_not_allowed`, `validation_failed` (с полями
в `details`), `stale_revision`, `conflict` (с `details.constraint`: `gtin`, `login`,
`badge`, `line_name`; у `badge` ещё `details.operatorId` — оператор, у которого этот
бейдж уже есть: маршрут только для администраторов, а они видят всех операторов),
`template_is_default`, `last_admin`, `sscc_below_floor`,
`pairing_code_invalid`, `pairing_code_expired`, `already_initialized`,
`loopback_only`, `protocol_unsupported`, `rate_limited`, `internal`.
```

- [ ] **Step 7: Проверки и коммит**

Run: вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline > /tmp/claude/1d4-host.log 2>&1`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: всё зелёное; тесты хоста — 22 набора, 210 тестов, без предупреждений компилятора.

```bash
git add apps/standalone/host/src/routes/operators.rs apps/standalone/host/tests/badges.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): конфликт бейджа называет его владельца" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Страница «Операторы» — `src/office/operators/`

Раздел «Производство» получает «Операторы» между «Линии» и «Устройства», только для администраторов: пункт меню с `roles: ["admin"]`, маршрут в `RequireRole`. Хост — власть, скрытие в интерфейсе — удобство.

- **Список** — все операторы, выключенные тоже: табельный номер, имя, должность, PIN («PIN задан» / «PIN не задан» по `hasPin`), бейджи (число действующих и их подписи; отозванные не считаются) и доступ словами (`StatusChip`: «Может входить» / «Выключен»). Сортировка: действующие раньше выключенных, внутри — по табельному номеру как по тексту, как у хоста: «0042» раньше «042», «100» раньше «99».
- **Новый оператор** — табельный номер, имя, должность (необязательно), PIN и его повтор (скрыты). Диалог хеширует PIN (`hashPin`) внутри `onSubmit` и шлёт `operatorCreate` с обрезанными значениями формы; повтор табельного номера (`conflict` на `login`) — под полем.
- **Правка** — имя и должность; табельный номер показан и не меняется, доступа в этой форме нет. Шлётся только изменённое (`operatorUpdate`) с ревизией открытой записи; стёртая должность уходит как `role: null`, нетронутая не уходит; устаревшая ревизия — «Загрузить заново».
- **Сменить PIN** — отдельный маленький диалог: PIN и повтор, `{ pinPhc, expectedRev }`. Прежний PIN не показать, только заменить.
- **Выключить / Включить** — `{ active, expectedRev }`. «Выключить» (вариант `destructive`) говорит, что оператор не сможет входить на станциях, как только они получат изменение; о смене в работе — ничего (это решение плана 2a). «Включить» спрашивает коротко.
- После каждой записи оператор, которого вернул хост, заменяет строку в кэше на месте (`useStoreRecord`); таблица сортирует при выводе, поэтому правка строку не двигает. Удаления нет, и страница его не предлагает. Кнопка «Бейджи» — задача 5.

**Files:**

- Create: `apps/standalone/src/office/operators/{operator-forms.ts,operator-records.ts,CreateOperatorDialog.tsx,EditOperatorDialog.tsx,OperatorPinDialog.tsx,OperatorAccessDialog.tsx,OperatorsPage.tsx}`, `apps/standalone/test/operators-page.test.tsx`
- Modify: `apps/standalone/src/office/{office-query.ts,nav.ts,routes.tsx}`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes:
  - `FormDialog`, `writeFailure`, `alertFailure`, `useFieldError`, `WriteFailureAlert`, `useStoreRecord`, `useOfficeQuery`, `useOfficeMutation`, `RequireRole` — основа офиса плана 1d3;
  - `hashPin`, `operatorLoginRule`, `personNameRule`, `operatorRoleRule`, `pinRule`, `toOptionalText` — задача 1;
  - `OfficeOperator`, `OperatorCreate`, `OperatorUpdate`, `operatorCreate`, `operatorUpdate`, `HostApi.listOperators/createOperator/updateOperator` — задача 2.
- Produces:
  - `officeKeys.operators = ["office", "operators"]`;
  - `newOperatorSchema`, `operatorEditSchema`, `pinFormSchema` — `operator-forms.ts`; `activeFirstByLogin(operators)` — `operator-records.ts`;
  - `CreateOperatorDialog({ onClose, onCreated })`, `EditOperatorDialog({ operator, onClose, onSaved, onReload })`, `OperatorPinDialog({ operator, onClose, onSaved, onReload })`, `OperatorAccessDialog({ operator, onClose, onSaved, onReload })`, `OperatorsPage()`; маршрут `/operators`, пункт меню «Операторы»;
  - ключи `rules.pinConfirm`, `office.nav.operators`, `office.operators.*` (кроме бейджей, их добавит задача 5; `office.operators.badges.unnamed` нужен уже списку).

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/operators-page.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { verifyPhc } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type { OfficeOperator, OperatorCreate } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

/** `office-operator.json`, with a role: one badge revoked, one in use. */
const ANNA: OfficeOperator = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  active: true,
  hasPin: true,
  badges: [
    {
      id: "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
      label: null,
      createdAt: "2026-09-20T08:00:00Z",
      revokedAt: "2026-09-27T08:00:00Z",
    },
    {
      id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      label: "Пропуск №7",
      createdAt: "2026-09-27T08:00:00Z",
      revokedAt: null,
    },
  ],
  rev: 55,
};
const BORIS: OfficeOperator = {
  id: "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21",
  login: "100",
  name: "Борис Орлов",
  role: null,
  active: true,
  hasPin: true,
  badges: [],
  rev: 40,
};
const VERA: OfficeOperator = {
  id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  login: "99",
  name: "Вера Лебедева",
  role: "Наладчик",
  active: true,
  hasPin: true,
  badges: [
    {
      id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
      label: null,
      createdAt: "2026-09-21T08:00:00Z",
      revokedAt: null,
    },
    {
      id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
      label: "Смена Б",
      createdAt: "2026-09-22T08:00:00Z",
      revokedAt: null,
    },
  ],
  rev: 41,
};
const GLEB: OfficeOperator = {
  id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  login: "042",
  name: "Глеб Сидоров",
  role: null,
  active: false,
  hasPin: true,
  badges: [],
  rev: 30,
};

/** What the host answers a create with: the operator it stored. */
function created(body: OperatorCreate): OfficeOperator {
  return {
    id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
    login: body.login,
    name: body.name,
    role: body.role,
    active: true,
    hasPin: true,
    badges: [],
    rev: 60,
  };
}

function refusal(code: string, details: Record<string, unknown>): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order: by personnel number as text, inactive ones included.
  session.api.listOperators.mockResolvedValue([ANNA, GLEB, BORIS, VERA]);
  return session;
}

async function openOperators(session: FakeOfficeSession) {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Операторы" }));
  await screen.findByText("Анна Кузнецова");
  return view;
}

/** The personnel numbers, top to bottom. */
function logins(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/**
 * Clicks the dialog's submit button again once the earlier submit has
 * settled: a refused form enables the button in a render of its own, and a
 * click on the disabled button would do nothing.
 */
async function submitAgain(name: string): Promise<void> {
  const submit = within(dialog()).getByRole("button", { name });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);
}

function fillNewOperator(): void {
  type("Табельный номер", " 0043 ");
  type("Имя", " Иван Петров ");
  type("Должность", " Наладчик ");
  type("PIN", "4821");
  type("Повторите PIN", "4821");
}

describe("office operators", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for administrators only, between «Линии» and «Устройства»", async () => {
    renderOffice(adminSession());
    await screen.findByRole("link", { name: "Операторы" });
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.slice(links.indexOf("Линии"), links.indexOf("Устройства") + 1)).toEqual([
      "Линии",
      "Операторы",
      "Устройства",
    ]);
  });

  it("is not in a technologist's menu", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Линии" });
    expect(screen.queryByRole("link", { name: "Операторы" })).toBeNull();
  });

  it("closes the page when the user's role changes to technologist", async () => {
    const session = adminSession();
    const view = await openOperators(session);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={{ ...session, user: { ...session.user, role: "technologist" } }} />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByText("Анна Кузнецова")).toBeNull();
  });

  it("lists active operators first, each group by personnel number as text", async () => {
    await openOperators(adminSession());
    expect(logins()).toEqual(["0042", "100", "99", "042"]);
    const anna = rowOf("Анна Кузнецова");
    expect(within(anna).getByText("Упаковщик")).toBeTruthy();
    expect(within(anna).getByText("PIN задан")).toBeTruthy();
    // The revoked badge is not counted.
    expect(within(anna).getByText("1 — Пропуск №7")).toBeTruthy();
    expect(within(anna).getByText("Может входить")).toBeTruthy();
    expect(within(rowOf("Борис Орлов")).getByText("Нет")).toBeTruthy();
    expect(within(rowOf("Борис Орлов")).getByText("—")).toBeTruthy();
    expect(within(rowOf("Вера Лебедева")).getByText("2 — Без подписи, Смена Б")).toBeTruthy();
    const gleb = rowOf("Глеб Сидоров");
    expect(within(gleb).getByText("Выключен")).toBeTruthy();
    expect(
      within(gleb).getByRole("button", { name: "Включить оператора «Глеб Сидоров»" }),
    ).toBeTruthy();
    expect(
      within(anna).getByRole("button", { name: "Выключить оператора «Анна Кузнецова»" }),
    ).toBeTruthy();
  });

  it("adds an operator with the trimmed values and only a hash of the PIN", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(session.api.createOperator).toHaveBeenCalledTimes(1));
    expect(session.api.createOperator.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          login: "0043",
          name: "Иван Петров",
          role: "Наладчик",
          pinPhc: expect.stringMatching(/^pbkdf2\$sha256\$100000\$/),
        },
      ],
    ]);
    const pinPhc = session.api.createOperator.mock.calls[0]?.[1].pinPhc ?? "";
    await expect(verifyPhc("4821", pinPhc)).resolves.toBe(true);
    expect(await screen.findByText("Оператор «Иван Петров» добавлен.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(logins()).toEqual(["0042", "0043", "100", "99", "042"]);
  });

  it("sends a blank role as none", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Должность", "   ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText("Оператор «Иван Петров» добавлен.");
    expect(session.api.createOperator.mock.calls[0]?.[1].role).toBeNull();
  });

  it("checks the personnel number, the PIN and its repeat before sending", async () => {
    const session = adminSession();
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    type("Табельный номер", "42");
    type("Имя", "Иван Петров");
    type("PIN", "123");
    type("Повторите PIN", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Табельный номер — от 3 до 12 цифр")).toBeTruthy();
    expect(screen.getByText("PIN — от 4 до 6 цифр")).toBeTruthy();
    type("Табельный номер", "042");
    type("PIN", "4821");
    type("Повторите PIN", "4812");
    await submitAgain("Добавить");
    expect(await screen.findByText("PIN-коды не совпадают")).toBeTruthy();
    expect(session.api.createOperator).not.toHaveBeenCalled();
  });

  it("says under the personnel number when it is taken", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(refusal("conflict", { constraint: "login" }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Этот табельный номер уже занят");
    expect(screen.getByLabelText("Табельный номер").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("hashes and sends one operator for a double click", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    // One `act` renders nothing between the clicks: only the dialog's own
    // flag, set at the first submit, can turn the second one away.
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await screen.findByText("Оператор «Иван Петров» добавлен.");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.createOperator).toHaveBeenCalledTimes(1);
  });

  it("changes the name and clears the role with the loaded revision, in place", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({
      ...VERA,
      name: "Вера Орлова",
      role: null,
      rev: 62,
    });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Вера Лебедева»" }));
    expect(within(dialog()).getByText("Табельный номер 99. Его нельзя изменить.")).toBeTruthy();
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Имя", " Вера Орлова ");
    type("Должность", "");
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", VERA.id, { name: "Вера Орлова", role: null, expectedRev: 41 }],
    ]);
    expect(logins()).toEqual(["0042", "100", "99", "042"]);
    expect(within(rowOf("Вера Орлова")).getByText("—")).toBeTruthy();
  });

  it("sends no role when only the name changed", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, name: "Анна Петрова", rev: 63 });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Анна Кузнецова»" }));
    type("Имя", "Анна Петрова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { name: "Анна Петрова", expectedRev: 55 }],
    ]);
  });

  it("offers to load the operators again after a stale change", async () => {
    const session = adminSession();
    session.api.updateOperator.mockRejectedValueOnce(refusal("stale_revision", { currentRev: 70 }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Анна Кузнецова»" }));
    type("Имя", "Анна Петрова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
  });

  it("replaces the PIN with a new hash and the loaded revision", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, rev: 64 });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Сменить PIN оператора «Анна Кузнецова»" }));
    expect(
      within(dialog()).getByText(
        "Прежний PIN перестанет работать на станциях, как только они получат изменение.",
      ),
    ).toBeTruthy();
    type("PIN", "1357");
    type("Повторите PIN", "1375");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сменить PIN" }));
    expect(await screen.findByText("PIN-коды не совпадают")).toBeTruthy();
    type("Повторите PIN", "1357");
    await submitAgain("Сменить PIN");
    expect(await screen.findByText("PIN оператора «Анна Кузнецова» изменён.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      [
        "office-session-token",
        ANNA.id,
        { pinPhc: expect.stringMatching(/^pbkdf2\$sha256\$100000\$/), expectedRev: 55 },
      ],
    ]);
    const pinPhc = session.api.updateOperator.mock.calls[0]?.[2].pinPhc ?? "";
    await expect(verifyPhc("1357", pinPhc)).resolves.toBe(true);
  });

  it("turns an operator off after saying they can no longer sign in on the stations", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, active: false, rev: 65 });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Выключить оператора «Анна Кузнецова»" }));
    expect(
      within(dialog()).getByText(
        "Оператор «Анна Кузнецова» больше не сможет входить на станциях, как только они получат изменение. Включить его снова можно здесь же.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(await screen.findByText("Оператор «Анна Кузнецова» выключен.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { active: false, expectedRev: 55 }],
    ]);
    expect(logins()).toEqual(["100", "99", "0042", "042"]);
    expect(within(rowOf("Анна Кузнецова")).getByText("Выключен")).toBeTruthy();
  });

  it("turns an operator back on after a light confirmation", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...GLEB, active: true, rev: 66 });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Включить оператора «Глеб Сидоров»" }));
    expect(
      within(dialog()).getByText(
        "Оператор «Глеб Сидоров» снова сможет входить на станциях по своему PIN и бейджам, как только они получат изменение.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Включить" }));
    expect(await screen.findByText("Оператор «Глеб Сидоров» включён.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", GLEB.id, { active: true, expectedRev: 30 }],
    ]);
    expect(logins()).toEqual(["0042", "042", "100", "99"]);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx`
Expected: FAIL — 14 тестов из 15: `Unable to find role="link" and name "Операторы"`. Проходит «is not in a technologist's menu» — он охраняет роль, и мутация 1 шага 5 показывает, что он не пустой.

- [ ] **Step 3: Формы, диалоги, страница, меню, маршрут и тексты**

1. Create `apps/standalone/src/office/operators/operator-forms.ts`:

```ts
import { z } from "zod";

import { operatorLoginRule, operatorRoleRule, personNameRule, pinRule } from "../../lib/rules.js";

const pinRepeated = { message: "rules.pinConfirm", path: ["pinConfirm"] };

/** A new operator; `pinConfirm` repeats the PIN. */
export const newOperatorSchema = z
  .object({
    login: operatorLoginRule,
    name: personNameRule,
    role: operatorRoleRule,
    pin: pinRule,
    pinConfirm: z.string().trim(),
  })
  .refine((values) => values.pin === values.pinConfirm, pinRepeated);
export type NewOperatorValues = z.input<typeof newOperatorSchema>;

/** An operator's name and role; the personnel number never changes. */
export const operatorEditSchema = z.object({ name: personNameRule, role: operatorRoleRule });
export type OperatorEditValues = z.input<typeof operatorEditSchema>;

/** A new PIN and its repeat. */
export const pinFormSchema = z
  .object({ pin: pinRule, pinConfirm: z.string().trim() })
  .refine((values) => values.pin === values.pinConfirm, pinRepeated);
export type PinFormValues = z.input<typeof pinFormSchema>;
```

2. Create `apps/standalone/src/office/operators/operator-records.ts`:

```ts
import type { OfficeOperator } from "../../host/protocol.js";

/**
 * Active operators before the ones turned off, each group by personnel
 * number as text, which is the host's order too: leading zeros are part of
 * the number, so «0042» comes before «042», and «100» before «99».
 */
export function activeFirstByLogin(operators: readonly OfficeOperator[]): OfficeOperator[] {
  return [...operators].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
  );
}
```

3. Create `apps/standalone/src/office/operators/CreateOperatorDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorCreate } from "../../host/protocol.js";
import { operatorCreate } from "../../host/requests.js";
import { hashPin } from "../../lib/credentials.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { newOperatorSchema, type NewOperatorValues } from "./operator-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", pinPhc: "pin" } as const;
/** Personnel numbers are unique on the host (`operators.login UNIQUE`). */
const CREATE_CONFLICTS = {
  login: { field: "login", message: "office.operators.errors.loginTaken" },
} as const;

export interface CreateOperatorDialogProps {
  onClose: () => void;
  onCreated: (operator: OfficeOperator) => void;
}

/**
 * A new operator with a PIN. The PIN is hashed here (`hashPin`) before the
 * request is built, so neither the request nor the mutation's variables
 * ever hold it; it lives in the form until the dialog closes.
 */
export function CreateOperatorDialog({ onClose, onCreated }: CreateOperatorDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const create = useOfficeMutation((api, token, body: OperatorCreate) =>
    api.createOperator(token, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<NewOperatorValues>({
    resolver: zodResolver(newOperatorSchema),
    defaultValues: { login: "", name: "", role: "", pin: "", pinConfirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let created: OfficeOperator;
    try {
      const pinPhc = await hashPin(values.pin);
      created = await create.mutateAsync(
        operatorCreate({
          login: values.login,
          name: values.name,
          role: toOptionalText(values.role),
          pinPhc,
        }),
      );
    } catch (error) {
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onCreated(created);
  });

  return (
    <FormDialog
      title={t("office.operators.createTitle")}
      submitLabel={t("office.operators.create")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.operators.fields.login")}
        hint={t("office.operators.fields.loginHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.login?.message)}
        {...register("login")}
      />
      <Input
        label={t("office.operators.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.operators.fields.role")}
        hint={t("office.operators.fields.roleHint")}
        {...fieldError(errors.role?.message)}
        {...register("role")}
      />
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pin")}
        hint={t("office.operators.fields.pinHint")}
        {...fieldError(errors.pin?.message)}
        {...register("pin")}
      />
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pinConfirm")}
        {...fieldError(errors.pinConfirm?.message)}
        {...register("pinConfirm")}
      />
    </FormDialog>
  );
}
```

4. Create `apps/standalone/src/office/operators/EditOperatorDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { operatorEditSchema, type OperatorEditValues } from "./operator-forms.js";

const EDIT_FIELDS = { name: "name", role: "role" } as const;

export interface EditOperatorDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * An operator's name and role, with the loaded revision. The personnel
 * number is shown and never changes; turning the operator off or on is its
 * own action on the page.
 */
export function EditOperatorDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: EditOperatorDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, body: OperatorUpdate) =>
    api.updateOperator(token, operator.id, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<OperatorEditValues>({
    resolver: zodResolver(operatorEditSchema),
    defaultValues: { name: operator.name, role: operator.role ?? "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      saved = await update.mutateAsync(
        operatorUpdate(operator, { name: values.name, role: toOptionalText(values.role) }),
      );
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.operators.editTitle", { name: operator.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.operators.loginFixed", { login: operator.login })}</p>
      <Input
        label={t("office.operators.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.operators.fields.role")}
        hint={t("office.operators.fields.roleHint")}
        {...fieldError(errors.role?.message)}
        {...register("role")}
      />
    </FormDialog>
  );
}
```

5. Create `apps/standalone/src/office/operators/OperatorPinDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { hashPin } from "../../lib/credentials.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { pinFormSchema, type PinFormValues } from "./operator-forms.js";

const PIN_FIELDS = { pinPhc: "pin" } as const;

export interface OperatorPinDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * A new PIN for an operator. The old one cannot be shown, only replaced: the
 * new PIN is hashed here (`hashPin`) and only its hash goes, with the loaded
 * revision.
 */
export function OperatorPinDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: OperatorPinDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, body: OperatorUpdate) =>
    api.updateOperator(token, operator.id, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<PinFormValues>({
    resolver: zodResolver(pinFormSchema),
    defaultValues: { pin: "", pinConfirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      const pinPhc = await hashPin(values.pin);
      saved = await update.mutateAsync(operatorUpdate(operator, { pinPhc }));
    } catch (error) {
      const outcome = writeFailure(error, PIN_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.operators.pinTitle", { name: operator.name })}
      submitLabel={t("office.operators.pinSubmit")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.operators.pinNote")}</p>
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pin")}
        hint={t("office.operators.fields.pinHint")}
        {...fieldError(errors.pin?.message)}
        {...register("pin")}
      />
      <Input
        type="password"
        inputMode="numeric"
        label={t("office.operators.fields.pinConfirm")}
        {...fieldError(errors.pinConfirm?.message)}
        {...register("pinConfirm")}
      />
    </FormDialog>
  );
}
```

6. Create `apps/standalone/src/office/operators/OperatorAccessDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface OperatorAccessDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * Turns an active operator off, or one that is off back on, after saying
 * what it means on the stations. Turning off takes the operator out of use
 * (the `destructive` variant); turning on is a light confirmation, since it
 * gives the PIN and the badges their access back.
 */
export function OperatorAccessDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: OperatorAccessDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const change = useOfficeMutation((api, token, body: OperatorUpdate) =>
    api.updateOperator(token, operator.id, body),
  );
  const turningOff = operator.active;

  const submit = async () => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      saved = await change.mutateAsync(operatorUpdate(operator, { active: !turningOff }));
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t(turningOff ? "office.operators.deactivateTitle" : "office.operators.activateTitle")}
      submitLabel={t(
        turningOff ? "office.operators.deactivateSubmit" : "office.operators.activateSubmit",
      )}
      submitVariant={turningOff ? "destructive" : "primary"}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>
        {t(turningOff ? "office.operators.deactivateBody" : "office.operators.activateBody", {
          name: operator.name,
        })}
      </p>
    </FormDialog>
  );
}
```

7. Create `apps/standalone/src/office/operators/OperatorsPage.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeOperator } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { CreateOperatorDialog } from "./CreateOperatorDialog.js";
import { EditOperatorDialog } from "./EditOperatorDialog.js";
import { OperatorAccessDialog } from "./OperatorAccessDialog.js";
import { OperatorPinDialog } from "./OperatorPinDialog.js";
import { activeFirstByLogin } from "./operator-records.js";

type OperatorsDialog =
  | { kind: "create" }
  | { kind: "edit"; operator: OfficeOperator }
  | { kind: "pin"; operator: OfficeOperator }
  | { kind: "access"; operator: OfficeOperator };

/**
 * Operators (spec §4.3, §5.5, administrators only; the route is wrapped in
 * `RequireRole`): who signs in on the stations with a personnel number and a
 * PIN, or with a badge. The office sends only hashes. There is no delete:
 * an operator is turned off instead, and the host keeps the record.
 */
export function OperatorsPage() {
  const { t } = useTranslation();
  const operators = useOfficeQuery(officeKeys.operators, (api, token) => api.listOperators(token));
  const store = useStoreRecord<OfficeOperator>(officeKeys.operators);
  const [dialog, setDialog] = useState<OperatorsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: OperatorsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (operator: OfficeOperator, message: string) => {
    store(operator);
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void operators.refetch();
  };
  const badgeSummary = (operator: OfficeOperator) => {
    const active = operator.badges.filter((badge) => badge.revokedAt === null);
    if (active.length === 0) return t("office.operators.noBadges");
    const labels = active.map((badge) => badge.label ?? t("office.operators.badges.unnamed"));
    return t("office.operators.badgeSummary", { n: active.length, labels: labels.join(", ") });
  };

  const columns: TableColumn<OfficeOperator>[] = [
    {
      key: "login",
      title: t("office.operators.table.login"),
      mono: true,
      render: (operator) => operator.login,
    },
    { key: "name", title: t("office.operators.table.name"), render: (operator) => operator.name },
    {
      key: "role",
      title: t("office.operators.table.role"),
      render: (operator) => operator.role ?? t("office.common.none"),
    },
    {
      key: "pin",
      title: t("office.operators.table.pin"),
      render: (operator) =>
        t(operator.hasPin ? "office.operators.pinSet" : "office.operators.pinUnset"),
    },
    {
      key: "badges",
      title: t("office.operators.table.badges"),
      wrap: true,
      render: badgeSummary,
    },
    {
      key: "status",
      title: t("office.operators.table.status"),
      render: (operator) => (
        <StatusChip
          phase={operator.active ? "active" : "retired"}
          label={t(
            operator.active ? "office.operators.status.active" : "office.operators.status.inactive",
          )}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.operators.table.actions"),
      render: (operator) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.editNamed", { name: operator.name })}
            onClick={() => open({ kind: "edit", operator })}
          >
            {t("office.operators.edit")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.pinNamed", { name: operator.name })}
            onClick={() => open({ kind: "pin", operator })}
          >
            {t("office.operators.pin")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t(
              operator.active
                ? "office.operators.deactivateNamed"
                : "office.operators.activateNamed",
              { name: operator.name },
            )}
            onClick={() => open({ kind: "access", operator })}
          >
            {t(operator.active ? "office.operators.deactivate" : "office.operators.activate")}
          </Button>
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (operators.isPending) return <PageLoading />;
    if (operators.isError)
      return <LoadError error={operators.error} onRetry={() => void operators.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByLogin(operators.data)}
          getRowKey={(operator) => operator.id}
          empty={t("office.operators.empty")}
          scrollLabel={t("office.operators.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.operators.title")}
        actions={
          <Button onClick={() => open({ kind: "create" })}>{t("office.operators.add")}</Button>
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {dialog?.kind === "create" && (
        <CreateOperatorDialog
          onClose={() => setDialog(null)}
          onCreated={(operator) =>
            saved(operator, t("office.operators.created", { name: operator.name }))
          }
        />
      )}
      {dialog?.kind === "edit" && (
        <EditOperatorDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) => saved(operator, t("office.common.saved"))}
          onReload={reload}
        />
      )}
      {dialog?.kind === "pin" && (
        <OperatorPinDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(operator, t("office.operators.pinChanged", { name: operator.name }))
          }
          onReload={reload}
        />
      )}
      {dialog?.kind === "access" && (
        <OperatorAccessDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(
              operator,
              t(operator.active ? "office.operators.activated" : "office.operators.deactivated", {
                name: operator.name,
              }),
            )
          }
          onReload={reload}
        />
      )}
    </>
  );
}
```

8. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  operators: ["office", "operators"],
} as const;

/**
```

9. В `apps/standalone/src/office/nav.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

заменить на

<!-- prettier-ignore -->
```ts
    roles: ["admin", "technologist"],
  },
  {
    to: "/operators",
    labelKey: "office.nav.operators",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
```

10. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { LinesPage } from "./lines/LinesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { LinesPage } from "./lines/LinesPage.js";
import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OperatorsPage } from "./operators/OperatorsPage.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { RequireRole } from "./RequireRole.js";
import { SsccPage } from "./sscc/SsccPage.js";
```

11. В `apps/standalone/src/office/routes.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      {
        path: "devices",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "sscc", element: <SsccPage /> },
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      {
        path: "operators",
        element: (
          <RequireRole roles={["admin"]}>
            <OperatorsPage />
          </RequireRole>
        ),
      },
      {
        path: "devices",
        element: (
```

12. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
    "passwordCharacter": "В пароле есть повреждённый символ — наберите пароль заново",
    "operatorLogin": "Табельный номер — от 3 до 12 цифр",
    "pin": "PIN — от 4 до 6 цифр",
    "role": "Должность — до 120 символов",
    "badgeLabel": "Подпись — до 100 символов",
    "badgeCode": "Код бейджа — от 1 до 256 символов: латинские буквы, цифры и знаки",
```

заменить на

<!-- prettier-ignore -->
```json
    "passwordCharacter": "В пароле есть повреждённый символ — наберите пароль заново",
    "operatorLogin": "Табельный номер — от 3 до 12 цифр",
    "pin": "PIN — от 4 до 6 цифр",
    "pinConfirm": "PIN-коды не совпадают",
    "role": "Должность — до 120 символов",
    "badgeLabel": "Подпись — до 100 символов",
    "badgeCode": "Код бейджа — от 1 до 256 символов: латинские буквы, цифры и знаки",
```

13. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "sscc": "SSCC",
      "counterparties": "Контрагенты",
      "lines": "Линии",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

заменить на

<!-- prettier-ignore -->
```json
      "sscc": "SSCC",
      "counterparties": "Контрагенты",
      "lines": "Линии",
      "operators": "Операторы",
      "devices": "Устройства",
      "users": "Пользователи"
    },
```

14. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "restored": "Линия «{{name}}» возвращена из архива.",
      "errors": {
        "nameTaken": "Активная линия с таким названием уже есть"
      }
    },
    "users": {
```

заменить на

<!-- prettier-ignore -->
```json
      "restored": "Линия «{{name}}» возвращена из архива.",
      "errors": {
        "nameTaken": "Активная линия с таким названием уже есть"
      }
    },
    "operators": {
      "title": "Операторы",
      "add": "Добавить оператора",
      "empty": "Операторов пока нет.",
      "table": {
        "login": "Табельный номер",
        "name": "Имя",
        "role": "Должность",
        "pin": "PIN",
        "badges": "Бейджи",
        "status": "Доступ",
        "actions": "Действия"
      },
      "pinSet": "PIN задан",
      "pinUnset": "PIN не задан",
      "noBadges": "Нет",
      "badgeSummary": "{{n}} — {{labels}}",
      "status": {
        "active": "Может входить",
        "inactive": "Выключен"
      },
      "edit": "Изменить",
      "editNamed": "Изменить оператора «{{name}}»",
      "pin": "Сменить PIN",
      "pinNamed": "Сменить PIN оператора «{{name}}»",
      "deactivate": "Выключить",
      "deactivateNamed": "Выключить оператора «{{name}}»",
      "activate": "Включить",
      "activateNamed": "Включить оператора «{{name}}»",
      "createTitle": "Новый оператор",
      "create": "Добавить",
      "editTitle": "Оператор «{{name}}»",
      "loginFixed": "Табельный номер {{login}}. Его нельзя изменить.",
      "pinTitle": "PIN оператора «{{name}}»",
      "pinNote": "Прежний PIN перестанет работать на станциях, как только они получат изменение.",
      "pinSubmit": "Сменить PIN",
      "deactivateTitle": "Выключить оператора?",
      "deactivateBody": "Оператор «{{name}}» больше не сможет входить на станциях, как только они получат изменение. Включить его снова можно здесь же.",
      "deactivateSubmit": "Выключить",
      "activateTitle": "Включить оператора?",
      "activateBody": "Оператор «{{name}}» снова сможет входить на станциях по своему PIN и бейджам, как только они получат изменение.",
      "activateSubmit": "Включить",
      "fields": {
        "login": "Табельный номер",
        "loginHint": "От 3 до 12 цифр; ведущие нули — часть номера. Номер потом не меняется",
        "name": "Имя",
        "role": "Должность",
        "roleHint": "Необязательно",
        "pin": "PIN",
        "pinHint": "От 4 до 6 цифр",
        "pinConfirm": "Повторите PIN"
      },
      "created": "Оператор «{{name}}» добавлен.",
      "pinChanged": "PIN оператора «{{name}}» изменён.",
      "deactivated": "Оператор «{{name}}» выключен.",
      "activated": "Оператор «{{name}}» включён.",
      "badges": {
        "unnamed": "Без подписи"
      },
      "errors": {
        "loginTaken": "Этот табельный номер уже занят"
      }
    },
    "users": {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`; затем под стендом с задержкой `setImmediate`.
Expected: PASS — 15 тестов; stderr verbose-прогона пуст; под стендом — 15.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/office/nav.ts` открыть пункт технологу: фрагмент

<!-- prettier-ignore -->
```ts
    to: "/operators",
    labelKey: "office.nav.operators",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
```

заменить на

<!-- prettier-ignore -->
```ts
    to: "/operators",
    labelKey: "office.nav.operators",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx -t "technologist's menu"`
Expected: FAIL — `expected <a class="mk-sidebar__link" …(2)>…(1)</a> to be null`.

Мутация 2. В `apps/standalone/src/office/FormDialog.tsx` снять защиту от второй отправки: фрагмент

<!-- prettier-ignore -->
```tsx
    if (inFlight.current) return;
    inFlight.current = true;
```

заменить на

<!-- prettier-ignore -->
```tsx
    inFlight.current = true;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx -t "double click"`
Expected: FAIL — `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 3. В `apps/standalone/src/office/operators/operator-records.ts` сортировать табельные номера как числа: фрагмент

<!-- prettier-ignore -->
```ts
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
```

заменить на

<!-- prettier-ignore -->
```ts
      Number(b.active) - Number(a.active) || Number(a.login) - Number(b.login),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx -t "lists active operators first"`
Expected: FAIL — `expected [ '0042', '99', '100', '042' ] to deeply equal [ '0042', '100', '99', '042' ]`.

Мутация 4. В `apps/standalone/src/office/operators/CreateOperatorDialog.tsx` слать сырые значения формы: фрагмент

<!-- prettier-ignore -->
```tsx
    resolver: zodResolver(newOperatorSchema),
```

заменить на

<!-- prettier-ignore -->
```tsx
    resolver: zodResolver(newOperatorSchema, undefined, { raw: true }),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx -t "trimmed values"`
Expected: FAIL — тело `createOperator` не равно ожидаемому (`login: " 0043 "` вместо `"0043"`).

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`WriteFailureAlert`). A `FormDialog`'s `onSubmit` must never reject: it
  sorts every failure itself, and a rejection would only surface as an
  unhandled one, so a caller's bug is not hidden. Only the awaited write sits
  in the `try`; the callback after a saved write (`onSaved`, `onRevoked`, …)
  and whatever else follows a success run after the `try/catch`, whose `catch`
  ends with `return`, so a throw there is never shown as a failed write (a
  retry would add a second counterparty: the host keeps no uniqueness). The
  archive and revoke confirmations use the `destructive` submit variant
  although archiving can be undone: here it means an action that takes a
  record out of use. Whether a page shows a form or a read-only view comes
  from `useCan` (`src/office/access.ts`), the table of spec §4.8.
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
```

заменить на

<!-- prettier-ignore -->
```text
  (`WriteFailureAlert`). A `FormDialog`'s `onSubmit` must never reject: it
  sorts every failure itself, and a rejection would only surface as an
  unhandled one, so a caller's bug is not hidden. Only the awaited write sits
  in the `try`, with the hashing that builds its body where there is one (an
  operator's PIN); the callback after a saved write (`onSaved`, `onRevoked`, …)
  and whatever else follows a success run after the `try/catch`, whose `catch`
  ends with `return`, so a throw there is never shown as a failed write (a
  retry would add a second counterparty: the host keeps no uniqueness). The
  archive, revoke and turn-off confirmations use the `destructive` submit
  variant although archiving and turning off can be undone: here it means an
  action that takes a record out of use. Whether a page shows a form or a
  read-only view comes from `useCan` (`src/office/access.ts`), the table of
  spec §4.8.
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  line back is a dialog with its name, so it can take another one. Archiving
  asks first and says that stations already on the line stay there: the host
  does not touch devices when a line is archived.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

заменить на

<!-- prettier-ignore -->
```text
  line back is a dialog with its name, so it can take another one. Archiving
  asks first and says that stations already on the line stay there: the host
  does not touch devices when a line is archived.
- «Операторы» is for administrators only: `RequireRole`, and `OFFICE_NAV`
  shows it to them alone, between «Линии» and «Устройства». It lists every
  operator, those turned off included: active ones first, each group by
  personnel number as text, as the host orders them (leading zeros are part
  of the number, so no numeric collator), with the role, whether a PIN is
  set, the badges in use and the access in words. A new operator takes a
  personnel number, a name, an optional role and a PIN typed twice. An edit
  changes the name and the role and shows the number, which never changes:
  a cleared role goes as `role: null`, an untouched one not at all.
  «Сменить PIN» replaces the PIN, which is never shown. «Выключить» asks
  first and says that the operator can no longer sign in on the stations
  once they sync; «Включить» asks too, lightly. Every change sends only what
  differs (`operatorUpdate`) with the loaded revision, and the record the
  host returns replaces the row in place. A dialog hashes the PIN
  (`hashPin`) inside its `onSubmit` and then builds the body: the
  `FormDialog` guard covers the hashing too, and the mutation's variables,
  which the query cache keeps, hold only the hash. There is no delete, and
  the page offers none.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`conflict` с `constraint: line_name`); возврат — диалог с названием, чтобы
  линии можно было дать другое. Архивирование спрашивает подтверждение и
  говорит, что станции на линии остаются на ней: хост устройства не трогает.
- Операторы: интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль
  площадки из `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет
  только хеши.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
```

заменить на

<!-- prettier-ignore -->
```text
  (`conflict` с `constraint: line_name`); возврат — диалог с названием, чтобы
  линии можно было дать другое. Архивирование спрашивает подтверждение и
  говорит, что станции на линии остаются на ней: хост устройства не трогает.
- Операторы (план 1d4): видит и меняет только администратор. Список со всеми
  операторами, выключенные тоже: сначала действующие, внутри — по табельному
  номеру как по тексту (ведущие нули — часть номера). Новый оператор —
  табельный номер, имя, необязательная должность и PIN дважды; правка меняет
  имя и должность, номер не меняется; «Сменить PIN» заменяет PIN, прежний не
  показывается; «Выключить» спрашивает подтверждение и говорит, что оператор
  не сможет входить на станциях, как только они получат изменение, «Включить»
  спрашивает коротко. На хост уходят только изменённые поля с `expectedRev`.
  Интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль площадки из
  `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет только
  хеши.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `node_modules/.bin/prettier --check apps/standalone/src/office/operators apps/standalone/src/office/office-query.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/operators-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 35 файлов, 698 тестов.

```bash
git add apps/standalone/src/office/operators apps/standalone/src/office/office-query.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/operators-page.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): страница «Операторы» в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Бейджи оператора — список, добавление со сканера, отзыв

Кнопка «Бейджи» в строке оператора открывает список его бейджей: подпись или «Без подписи», дата добавления, состояние словами — «Действует» или «Отозван». Отозванные остаются в списке и приглушены: это след того, что выдавали. Из списка — «Добавить бейдж» и «Отозвать» у действующего. Страница переключает три диалога (список, добавление, отзыв), а не вкладывает окна друг в друга; диалоги берут оператора из кэшированного списка по id и видят каждое изменение.

- **Добавление.** Соль площадки читается через `GET /v1/office/badge-salt` один раз за сессию (`staleTime: Infinity`; `useOfficeQuery` получает этот параметр); `not_found` — хост ещё до мастера, о чём и сказано. Поле кода скрыто и получает фокус: клавиатурный сканер печатает код и Enter, который отправляет форму. Диалог хеширует обрезанный код (`hashBadge`) и шлёт `badgeCreate({ badgePhc, label })`. Ответ — `BadgeInfo`, а не оператор: бейдж сразу ложится в кэшированного оператора, и число бейджей в строке меняется без перечитывания. Конфликт `badge` — под кодом: владелец по имени, если `details.operatorId` — UUID оператора из списка, иначе общий текст.
- **Отзыв.** Подтверждение (`destructive`): бейдж перестанет открывать вход на станциях, как только они получат изменение, и не вернётся — новая карта будет новым бейджем. После 204 бейдж сразу отмечен отозванным в кэше, затем список перечитывается.

**Files:**

- Create: `apps/standalone/src/office/operators/{badge-forms.ts,BadgesDialog.tsx,AddBadgeDialog.tsx,RevokeBadgeDialog.tsx}`, `apps/standalone/test/operator-badges.test.tsx`
- Modify (целиком): `apps/standalone/src/office/operators/OperatorsPage.tsx`
- Modify: `apps/standalone/src/office/operators/operator-records.ts`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes:
  - `hashBadge`, `badgeCodeRule`, `badgeLabelRule`, `toOptionalText` — задача 1;
  - `BadgeInfo`, `BadgeCreate`, `badgeCreate`, `HostApi.createBadge/revokeBadge/getBadgeSalt` — задача 2;
  - `details.operatorId` конфликта `badge` — задача 3;
  - `OperatorsPage`, `activeFirstByLogin`, `officeKeys.operators` — задача 4.
- Produces:
  - `officeKeys.badgeSalt = ["office", "badge-salt"]`, `OfficeQueryOptions.staleTime?: number`;
  - `withBadge(operators, operatorId, badge)`, `withBadgeRevoked(operators, operatorId, badgeId, revokedAt)`, `badgeHolder(error, operators): OfficeOperator | null` — `operator-records.ts`; `badgeFormSchema` — `badge-forms.ts`;
  - `BadgesDialog({ operator, notice, onAdd, onRevoke, onClose })`, `AddBadgeDialog({ operator, operators, onClose, onAdded })`, `RevokeBadgeDialog({ operator, badge, onClose, onRevoked })`;
  - ключи `office.operators.badgesOpen`, `office.operators.badgesNamed`, `office.operators.badges.*`; классы `.badge-list*`.

- [ ] **Step 1: Тесты (падающие)**

1. Create `apps/standalone/test/operator-badges.test.tsx`:

```tsx
import { readFileSync } from "node:fs";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { BadgeInfo, OfficeOperator } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
}

/** `badge-salt.json` and `badge-create.json`: «MRK-000742» hashed with the site's salt. */
const SITE_SALT = String(fixture("badge-salt.json").badgeSalt);
const BADGE_PHC = String(fixture("badge-create.json").badgePhc);

const REVOKED: BadgeInfo = {
  id: "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
  label: null,
  createdAt: "2026-09-20T08:00:00Z",
  revokedAt: "2026-09-27T08:00:00Z",
};
const PASS_7: BadgeInfo = {
  id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
  label: "Пропуск №7",
  createdAt: "2026-09-27T08:00:00Z",
  revokedAt: null,
};
const ANNA: OfficeOperator = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  active: true,
  hasPin: true,
  badges: [REVOKED, PASS_7],
  rev: 55,
};
const VERA: OfficeOperator = {
  id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  login: "99",
  name: "Вера Лебедева",
  role: null,
  active: true,
  hasPin: true,
  badges: [],
  rev: 41,
};
const PASS_8: BadgeInfo = {
  id: "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b",
  label: "Пропуск №8",
  createdAt: "2026-09-28T08:00:00Z",
  revokedAt: null,
};

const DATE = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" });

function day(at: string): string {
  return DATE.format(new Date(at));
}

function badgeTaken(operatorId: unknown): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "this badge already belongs to an operator",
    details: { constraint: "badge", operatorId },
  });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listOperators.mockResolvedValue([ANNA, VERA]);
  session.api.getBadgeSalt.mockResolvedValue({ badgeSalt: SITE_SALT });
  return session;
}

/** The operators page with Анна's badges open. */
async function openBadges(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Операторы" }));
  fireEvent.click(await screen.findByRole("button", { name: "Бейджи оператора «Анна Кузнецова»" }));
  await screen.findByRole("dialog", { name: "Бейджи оператора «Анна Кузнецова»" });
}

/** The add dialog over Анна's badges, once the salt is read. */
async function openAdd(session: FakeOfficeSession): Promise<void> {
  await openBadges(session);
  fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
  await screen.findByRole("dialog", { name: "Новый бейдж: Анна Кузнецова" });
  await waitFor(() =>
    expect(within(dialog()).getByRole("button", { name: "Добавить" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function itemOf(label: string): HTMLElement {
  const item = within(dialog()).getByText(label).closest("li");
  if (!item) throw new Error(`no badge ${label}`);
  return item;
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** What a keyboard-wedge scanner does: type the code, then Enter submits the form. */
function scan(code: string): void {
  const field = screen.getByLabelText("Код бейджа");
  fireEvent.change(field, { target: { value: code } });
  const form = field.closest("form");
  if (!form) throw new Error("the code field is not in a form");
  fireEvent.submit(form);
}

describe("operator badges", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lists an operator's badges, revoked ones too, dimmed and in words", async () => {
    await openBadges(adminSession());
    const revoked = itemOf("Без подписи");
    expect(within(revoked).getByText("Отозван")).toBeTruthy();
    expect(within(revoked).getByText(`Добавлен ${day(REVOKED.createdAt)}`)).toBeTruthy();
    expect(revoked.className).toContain("badge-list__item--revoked");
    expect(within(revoked).queryByRole("button")).toBeNull();
    const pass = itemOf("Пропуск №7");
    expect(within(pass).getByText("Действует")).toBeTruthy();
    expect(pass.className).not.toContain("badge-list__item--revoked");
    expect(
      within(pass).getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    ).toBeTruthy();
  });

  it("adds a scanned badge: the trimmed code hashed with the site's salt, never the code", async () => {
    const session = adminSession();
    session.api.createBadge.mockResolvedValue(PASS_8);
    await openAdd(session);
    // The code field takes the focus, ready for the scanner.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Код бейджа")));
    type("Подпись", " Пропуск №8 ");
    scan(" MRK-000742 ");
    await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(1));
    expect(session.api.createBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { badgePhc: BADGE_PHC, label: "Пропуск №8" }],
    ]);
    // Back to the list, with the new badge in it and on the page's row at once.
    expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
    expect(within(itemOf("Пропуск №8")).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Анна Кузнецова")).getByText("2 — Пропуск №7, Пропуск №8")).toBeTruthy();
    expect(session.api.listOperators).toHaveBeenCalledTimes(1);
  });

  it("reads the site's salt once per session", async () => {
    const session = adminSession();
    await openAdd(session);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(await screen.findByRole("button", { name: "Добавить бейдж" }));
    await screen.findByText("Новый бейдж: Анна Кузнецова");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.getBadgeSalt).toHaveBeenCalledTimes(1);
  });

  it("refuses a code typed under the Russian layout before hashing or sending", async () => {
    const session = adminSession();
    await openAdd(session);
    scan("ЬКЛ-000742");
    expect(
      await screen.findByText("Код набран русскими буквами — переключите раскладку на английскую"),
    ).toBeTruthy();
    expect(session.api.createBadge).not.toHaveBeenCalled();
  });

  it("names the operator who already holds the badge, under the code", async () => {
    const session = adminSession();
    session.api.createBadge.mockRejectedValueOnce(badgeTaken(VERA.id));
    await openAdd(session);
    scan("MRK-000742");
    const message = await screen.findByText("Этот бейдж уже у оператора «Вера Лебедева»");
    expect(screen.getByLabelText("Код бейджа").getAttribute("aria-describedby")).toBe(message.id);
    expect(screen.getByText("Новый бейдж: Анна Кузнецова")).toBeTruthy();
  });

  it.each([
    ["an id that is not a UUID", "8a3c1f0e"],
    ["an operator the list does not know", "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f"],
    ["no id at all", undefined],
  ])("says the badge is taken when the conflict names %s", async (_case, operatorId) => {
    const session = adminSession();
    session.api.createBadge.mockRejectedValueOnce(badgeTaken(operatorId));
    await openAdd(session);
    scan("MRK-000742");
    expect(await screen.findByText("Этот бейдж уже выдан оператору")).toBeTruthy();
  });

  it("explains a host that has no badge salt yet and keeps the form from sending", async () => {
    const session = adminSession();
    session.api.getBadgeSalt.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "not_found",
        status: 404,
        message: "the host is not initialized",
      }),
    );
    await openBadges(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
    expect(
      await screen.findByText(
        "Хост ещё не настроен: бейджи можно добавлять после первого запуска.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Добавить" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("revokes a badge after a confirmation, shows it revoked at once, then reads the list again", async () => {
    const session = adminSession();
    session.api.revokeBadge.mockResolvedValue(undefined);
    await openBadges(session);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    );
    expect(
      within(dialog()).getByText(
        "Бейдж «Пропуск №7» оператора «Анна Кузнецова» перестанет открывать вход на станциях, как только они получат изменение. Отозванный бейдж не вернуть: для этой карты понадобится новый бейдж.",
      ),
    ).toBeTruthy();
    // The read that follows the revoke stays pending until the badge has been
    // checked: the revoke itself must already show.
    let answerRead: (operators: OfficeOperator[]) => void = () => undefined;
    session.api.listOperators.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRead = resolve;
        }),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Бейдж «Пропуск №7» отозван.")).toBeTruthy();
    expect(session.api.revokeBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, PASS_7.id],
    ]);
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
    expect(within(itemOf("Пропуск №7")).getByText("Отозван")).toBeTruthy();
    expect(within(rowOf("Анна Кузнецова")).getByText("Нет")).toBeTruthy();
    await act(async () => {
      answerRead([
        { ...ANNA, badges: [REVOKED, { ...PASS_7, revokedAt: "2026-09-28T09:00:00Z" }] },
        VERA,
      ]);
    });
    expect(within(itemOf("Пропуск №7")).getByText("Отозван")).toBeTruthy();
  });

  it("explains a revocation the host refused, in the dialog", async () => {
    const session = adminSession();
    session.api.revokeBadge.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such badge" }),
    );
    await openBadges(session);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await within(dialog()).findByText("Запись не найдена.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx`
Expected: FAIL — 11 тестов из 11: `Unable to find role="button" and name "Бейджи оператора «Анна Кузнецова»"`.

- [ ] **Step 3: Диалоги бейджей, страница, соль, тексты и стили**

1. Create `apps/standalone/src/office/operators/badge-forms.ts`:

```ts
import { z } from "zod";

import { badgeCodeRule, badgeLabelRule } from "../../lib/rules.js";

/** A badge to add: the code a scanner typed, and an optional label. */
export const badgeFormSchema = z.object({ code: badgeCodeRule, label: badgeLabelRule });
export type BadgeFormValues = z.input<typeof badgeFormSchema>;
```

2. В `apps/standalone/src/office/operators/operator-records.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { OfficeOperator } from "../../host/protocol.js";

/**
 * Active operators before the ones turned off, each group by personnel
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";

/**
 * Active operators before the ones turned off, each group by personnel
```

3. В `apps/standalone/src/office/operators/operator-records.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
  );
}
```

заменить на

<!-- prettier-ignore -->
```ts
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
  );
}

/** `operators` with `badge` added to the badges of `operatorId`: the newest badge goes last. */
export function withBadge(
  operators: readonly OfficeOperator[],
  operatorId: string,
  badge: BadgeInfo,
): OfficeOperator[] {
  return operators.map((operator) =>
    operator.id === operatorId ? { ...operator, badges: [...operator.badges, badge] } : operator,
  );
}

/**
 * `operators` with the badge `badgeId` of `operatorId` marked revoked at
 * `revokedAt`, until the list read again brings the host's own time.
 */
export function withBadgeRevoked(
  operators: readonly OfficeOperator[],
  operatorId: string,
  badgeId: string,
  revokedAt: string,
): OfficeOperator[] {
  return operators.map((operator) =>
    operator.id === operatorId
      ? {
          ...operator,
          badges: operator.badges.map((badge) =>
            badge.id === badgeId && badge.revokedAt === null ? { ...badge, revokedAt } : badge,
          ),
        }
      : operator,
  );
}

/**
 * The operator who already holds a badge, as a `badge` conflict names them in
 * `details.operatorId`: a UUID of an operator in `operators`. `null` for any
 * other failure and for an id that is missing, malformed or not in the list.
 */
export function badgeHolder(
  error: unknown,
  operators: readonly OfficeOperator[],
): OfficeOperator | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "badge") return null;
  const id = z.uuid().safeParse(error.details.operatorId);
  if (!id.success) return null;
  return operators.find((operator) => operator.id === id.data) ?? null;
}
```

4. Create `apps/standalone/src/office/operators/BadgesDialog.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Alert, Button, cn, Modal, StatusChip } from "@markiro/ui";

import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";

const DATE = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" });

export interface BadgesDialogProps {
  operator: OfficeOperator;
  /** A badge just added or revoked, said above the list. */
  notice: string | null;
  onAdd: () => void;
  onRevoke: (badge: BadgeInfo) => void;
  onClose: () => void;
}

/**
 * An operator's badges, revoked ones too: they stay listed, dimmed and
 * marked «Отозван», as the record of what was issued. A badge in use can be
 * revoked; a new card is always a new badge.
 */
export function BadgesDialog({ operator, notice, onAdd, onRevoke, onClose }: BadgesDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open
      title={t("office.operators.badges.title", { name: operator.name })}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button onClick={onAdd}>{t("office.operators.badges.add")}</Button>
        </>
      }
    >
      <div className="standalone-form">
        {notice && <Alert tone="ok">{notice}</Alert>}
        {operator.badges.length === 0 ? (
          <p>{t("office.operators.badges.empty")}</p>
        ) : (
          <ul className="badge-list">
            {operator.badges.map((badge) => {
              const label = badge.label ?? t("office.operators.badges.unnamed");
              const date = DATE.format(new Date(badge.createdAt));
              const revoked = badge.revokedAt !== null;
              return (
                <li
                  key={badge.id}
                  className={cn("badge-list__item", revoked && "badge-list__item--revoked")}
                >
                  <span className="badge-list__name">
                    <span>{label}</span>
                    <span className="badge-list__date">
                      {t("office.operators.badges.addedAt", { date })}
                    </span>
                  </span>
                  <StatusChip
                    phase={revoked ? "retired" : "active"}
                    label={t(
                      revoked
                        ? "office.operators.badges.status.revoked"
                        : "office.operators.badges.status.active",
                    )}
                  />
                  {!revoked && (
                    <Button
                      variant="secondary"
                      size="compact"
                      aria-label={t("office.operators.badges.revokeNamed", { label, date })}
                      onClick={() => onRevoke(badge)}
                    >
                      {t("office.operators.badges.revoke")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
```

5. Create `apps/standalone/src/office/operators/AddBadgeDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Input } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { BadgeCreate, BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { badgeCreate } from "../../host/requests.js";
import { hashBadge } from "../../lib/credentials.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, WriteFailureAlert } from "../page-state.js";
import { badgeFormSchema, type BadgeFormValues } from "./badge-forms.js";
import { badgeHolder } from "./operator-records.js";

const BADGE_FIELDS = { badgePhc: "code", label: "label" } as const;
/** An active badge with this hash already exists, and the list does not know whose. */
const BADGE_CONFLICTS = {
  badge: { field: "code", message: "office.operators.badges.errors.taken" },
} as const;
const TAKEN_BY = "office.operators.badges.errors.takenBy";

export interface AddBadgeDialogProps {
  operator: OfficeOperator;
  /** Every operator, to name the one who already holds a badge. */
  operators: readonly OfficeOperator[];
  onClose: () => void;
  onAdded: (badge: BadgeInfo) => void;
}

/**
 * A new badge for an operator. A keyboard-wedge scanner types the code and
 * Enter, which submits the form, so the code field takes the focus. The code
 * is hashed here with the site's salt, read once per session, and only the
 * hash goes; a badge another operator holds is named under the code.
 */
export function AddBadgeDialog({ operator, operators, onClose, onAdded }: AddBadgeDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The name `TAKEN_BY` interpolates: the operator the host named.
  const [holder, setHolder] = useState<string | null>(null);
  const salt = useOfficeQuery(officeKeys.badgeSalt, (api, token) => api.getBadgeSalt(token), {
    staleTime: Infinity,
  });
  const add = useOfficeMutation((api, token, body: BadgeCreate) =>
    api.createBadge(token, operator.id, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<BadgeFormValues>({
    resolver: zodResolver(badgeFormSchema),
    defaultValues: { code: "", label: "" },
  });
  useEffect(() => {
    setFocus("code");
  }, [setFocus]);

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    // The submit button stays off until the salt is read.
    if (salt.data === undefined) return;
    let added: BadgeInfo;
    try {
      const badgePhc = await hashBadge(values.code, salt.data.badgeSalt);
      added = await add.mutateAsync(badgeCreate({ badgePhc, label: toOptionalText(values.label) }));
    } catch (error) {
      const taken = badgeHolder(error, operators);
      if (taken !== null) {
        setHolder(taken.name);
        setError("code", { type: "server", message: TAKEN_BY });
        return;
      }
      const outcome = writeFailure(error, BADGE_FIELDS, BADGE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onAdded(added);
  });

  const saltFailure = () => {
    if (!salt.isError) return null;
    if (salt.error instanceof HostError && salt.error.code === "not_found") {
      return <Alert tone="error">{t("office.operators.badges.errors.noSalt")}</Alert>;
    }
    return <LoadError error={salt.error} onRetry={() => void salt.refetch()} />;
  };
  const codeMessage = errors.code?.message;

  return (
    <FormDialog
      title={t("office.operators.badges.addTitle", { name: operator.name })}
      submitLabel={t("office.operators.badges.addSubmit")}
      submitDisabled={salt.data === undefined}
      onSubmit={submit}
      onClose={onClose}
      alert={
        <>
          {saltFailure()}
          <WriteFailureAlert failure={failure} />
        </>
      }
    >
      <Input
        type="password"
        label={t("office.operators.badges.fields.code")}
        hint={t("office.operators.badges.fields.codeHint")}
        mono
        {...fieldError(codeMessage, codeMessage === TAKEN_BY ? { name: holder } : undefined)}
        {...register("code")}
      />
      <Input
        label={t("office.operators.badges.fields.label")}
        hint={t("office.operators.badges.fields.labelHint")}
        {...fieldError(errors.label?.message)}
        {...register("label")}
      />
    </FormDialog>
  );
}
```

6. Create `apps/standalone/src/office/operators/RevokeBadgeDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface RevokeBadgeDialogProps {
  operator: OfficeOperator;
  badge: BadgeInfo;
  onClose: () => void;
  onRevoked: () => void;
}

/**
 * Asks before a badge is revoked: it stops opening the stations once they
 * sync, and it never comes back (a new card is a new badge). The host
 * answers 204, and revoking it again changes nothing.
 */
export function RevokeBadgeDialog({ operator, badge, onClose, onRevoked }: RevokeBadgeDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
    api.revokeBadge(token, operator.id, badge.id),
  );
  const label = badge.label ?? t("office.operators.badges.unnamed");

  const submit = async () => {
    setFailure(null);
    try {
      await revoke.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onRevoked();
  };

  return (
    <FormDialog
      title={t("office.operators.badges.revokeTitle")}
      submitLabel={t("office.operators.badges.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.operators.badges.revokeBody", { label, name: operator.name })}</p>
    </FormDialog>
  );
}
```

7. Заменить содержимое `apps/standalone/src/office/operators/OperatorsPage.tsx` целиком:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { AddBadgeDialog } from "./AddBadgeDialog.js";
import { BadgesDialog } from "./BadgesDialog.js";
import { CreateOperatorDialog } from "./CreateOperatorDialog.js";
import { EditOperatorDialog } from "./EditOperatorDialog.js";
import { OperatorAccessDialog } from "./OperatorAccessDialog.js";
import { OperatorPinDialog } from "./OperatorPinDialog.js";
import { activeFirstByLogin, withBadge, withBadgeRevoked } from "./operator-records.js";
import { RevokeBadgeDialog } from "./RevokeBadgeDialog.js";

// The badge dialogs name their operator by id and read it from the cached
// list, so the badges they show follow every change stored there.
type OperatorsDialog =
  | { kind: "create" }
  | { kind: "edit"; operator: OfficeOperator }
  | { kind: "pin"; operator: OfficeOperator }
  | { kind: "access"; operator: OfficeOperator }
  | { kind: "badges"; operatorId: string; notice: string | null }
  | { kind: "addBadge"; operatorId: string }
  | { kind: "revokeBadge"; operatorId: string; badge: BadgeInfo };

/**
 * Operators (spec §4.3, §5.5, administrators only; the route is wrapped in
 * `RequireRole`): who signs in on the stations with a personnel number and a
 * PIN, or with a badge. The office sends only hashes. There is no delete:
 * an operator is turned off instead, and the host keeps the record.
 */
export function OperatorsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const operators = useOfficeQuery(officeKeys.operators, (api, token) => api.listOperators(token));
  const store = useStoreRecord<OfficeOperator>(officeKeys.operators);
  const [dialog, setDialog] = useState<OperatorsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: OperatorsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (operator: OfficeOperator, message: string) => {
    store(operator);
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void operators.refetch();
  };
  // A badge write answers with the badge, or nothing: the change goes into
  // the cached list at once, and with no list loaded the list is read again.
  const changeList = (change: (list: readonly OfficeOperator[]) => OfficeOperator[]) => {
    const list = queryClient.getQueryData<OfficeOperator[]>(officeKeys.operators);
    if (list) {
      queryClient.setQueryData(officeKeys.operators, change(list));
    } else {
      void queryClient.invalidateQueries({ queryKey: officeKeys.operators });
    }
  };
  const badgeLabel = (badge: BadgeInfo) => badge.label ?? t("office.operators.badges.unnamed");
  const operatorOf = (id: string) => operators.data?.find((operator) => operator.id === id);
  const badgesOf = (operatorId: string, notice: string | null) =>
    setDialog({ kind: "badges", operatorId, notice });
  const badgeSummary = (operator: OfficeOperator) => {
    const active = operator.badges.filter((badge) => badge.revokedAt === null);
    if (active.length === 0) return t("office.operators.noBadges");
    const labels = active.map((badge) => badge.label ?? t("office.operators.badges.unnamed"));
    return t("office.operators.badgeSummary", { n: active.length, labels: labels.join(", ") });
  };

  const columns: TableColumn<OfficeOperator>[] = [
    {
      key: "login",
      title: t("office.operators.table.login"),
      mono: true,
      render: (operator) => operator.login,
    },
    { key: "name", title: t("office.operators.table.name"), render: (operator) => operator.name },
    {
      key: "role",
      title: t("office.operators.table.role"),
      render: (operator) => operator.role ?? t("office.common.none"),
    },
    {
      key: "pin",
      title: t("office.operators.table.pin"),
      render: (operator) =>
        t(operator.hasPin ? "office.operators.pinSet" : "office.operators.pinUnset"),
    },
    {
      key: "badges",
      title: t("office.operators.table.badges"),
      wrap: true,
      render: badgeSummary,
    },
    {
      key: "status",
      title: t("office.operators.table.status"),
      render: (operator) => (
        <StatusChip
          phase={operator.active ? "active" : "retired"}
          label={t(
            operator.active ? "office.operators.status.active" : "office.operators.status.inactive",
          )}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.operators.table.actions"),
      render: (operator) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.editNamed", { name: operator.name })}
            onClick={() => open({ kind: "edit", operator })}
          >
            {t("office.operators.edit")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.pinNamed", { name: operator.name })}
            onClick={() => open({ kind: "pin", operator })}
          >
            {t("office.operators.pin")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.operators.badgesNamed", { name: operator.name })}
            onClick={() => open({ kind: "badges", operatorId: operator.id, notice: null })}
          >
            {t("office.operators.badgesOpen")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t(
              operator.active
                ? "office.operators.deactivateNamed"
                : "office.operators.activateNamed",
              { name: operator.name },
            )}
            onClick={() => open({ kind: "access", operator })}
          >
            {t(operator.active ? "office.operators.deactivate" : "office.operators.activate")}
          </Button>
        </RowActions>
      ),
    },
  ];

  const badgeDialog = () => {
    if (dialog === null) return null;
    if (dialog.kind !== "badges" && dialog.kind !== "addBadge" && dialog.kind !== "revokeBadge") {
      return null;
    }
    const operator = operatorOf(dialog.operatorId);
    if (operator === undefined) return null;
    switch (dialog.kind) {
      case "badges":
        return (
          <BadgesDialog
            operator={operator}
            notice={dialog.notice}
            onAdd={() => setDialog({ kind: "addBadge", operatorId: operator.id })}
            onRevoke={(badge) => setDialog({ kind: "revokeBadge", operatorId: operator.id, badge })}
            onClose={() => setDialog(null)}
          />
        );
      case "addBadge":
        return (
          <AddBadgeDialog
            operator={operator}
            operators={operators.data ?? []}
            onClose={() => badgesOf(operator.id, null)}
            onAdded={(badge) => {
              changeList((list) => withBadge(list, operator.id, badge));
              badgesOf(
                operator.id,
                t("office.operators.badges.added", { label: badgeLabel(badge) }),
              );
            }}
          />
        );
      case "revokeBadge":
        return (
          <RevokeBadgeDialog
            operator={operator}
            badge={dialog.badge}
            onClose={() => badgesOf(operator.id, null)}
            onRevoked={() => {
              // Revoked now, not when the list has been read again; the host's
              // own time replaces this PC's when it has.
              changeList((list) =>
                withBadgeRevoked(list, operator.id, dialog.badge.id, new Date().toISOString()),
              );
              badgesOf(
                operator.id,
                t("office.operators.badges.revoked", { label: badgeLabel(dialog.badge) }),
              );
              void operators.refetch();
            }}
          />
        );
    }
  };

  const content = () => {
    if (operators.isPending) return <PageLoading />;
    if (operators.isError)
      return <LoadError error={operators.error} onRetry={() => void operators.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByLogin(operators.data)}
          getRowKey={(operator) => operator.id}
          empty={t("office.operators.empty")}
          scrollLabel={t("office.operators.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.operators.title")}
        actions={
          <Button onClick={() => open({ kind: "create" })}>{t("office.operators.add")}</Button>
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {dialog?.kind === "create" && (
        <CreateOperatorDialog
          onClose={() => setDialog(null)}
          onCreated={(operator) =>
            saved(operator, t("office.operators.created", { name: operator.name }))
          }
        />
      )}
      {dialog?.kind === "edit" && (
        <EditOperatorDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) => saved(operator, t("office.common.saved"))}
          onReload={reload}
        />
      )}
      {dialog?.kind === "pin" && (
        <OperatorPinDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(operator, t("office.operators.pinChanged", { name: operator.name }))
          }
          onReload={reload}
        />
      )}
      {dialog?.kind === "access" && (
        <OperatorAccessDialog
          operator={dialog.operator}
          onClose={() => setDialog(null)}
          onSaved={(operator) =>
            saved(
              operator,
              t(operator.active ? "office.operators.activated" : "office.operators.deactivated", {
                name: operator.name,
              }),
            )
          }
          onReload={reload}
        />
      )}
      {badgeDialog()}
    </>
  );
}
```

8. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  operators: ["office", "operators"],
} as const;

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  operators: ["office", "operators"],
  badgeSalt: ["office", "badge-salt"],
} as const;

/**
```

9. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export interface OfficeQueryOptions {
  /** Read again every this many milliseconds while mounted; never by default. */
  refetchInterval?: number;
}

/** Reads office data through `session.call`. */
```

заменить на

<!-- prettier-ignore -->
```ts
export interface OfficeQueryOptions {
  /** Read again every this many milliseconds while mounted; never by default. */
  refetchInterval?: number;
  /**
   * How long an answer stays fresh: 0 by default, so a page reads again
   * whenever it opens; `Infinity` for data that never changes in a session.
   */
  staleTime?: number;
}

/** Reads office data through `session.call`. */
```

10. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    queryKey: key,
    queryFn: () => call((token) => read(api, token)),
    refetchInterval: options.refetchInterval ?? false,
  });
}
```

заменить на

<!-- prettier-ignore -->
```ts
    queryKey: key,
    queryFn: () => call((token) => read(api, token)),
    refetchInterval: options.refetchInterval ?? false,
    staleTime: options.staleTime ?? 0,
  });
}
```

11. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "editNamed": "Изменить оператора «{{name}}»",
      "pin": "Сменить PIN",
      "pinNamed": "Сменить PIN оператора «{{name}}»",
      "deactivate": "Выключить",
      "deactivateNamed": "Выключить оператора «{{name}}»",
      "activate": "Включить",
```

заменить на

<!-- prettier-ignore -->
```json
      "editNamed": "Изменить оператора «{{name}}»",
      "pin": "Сменить PIN",
      "pinNamed": "Сменить PIN оператора «{{name}}»",
      "badgesOpen": "Бейджи",
      "badgesNamed": "Бейджи оператора «{{name}}»",
      "deactivate": "Выключить",
      "deactivateNamed": "Выключить оператора «{{name}}»",
      "activate": "Включить",
```

12. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "deactivated": "Оператор «{{name}}» выключен.",
      "activated": "Оператор «{{name}}» включён.",
      "badges": {
        "unnamed": "Без подписи"
      },
      "errors": {
        "loginTaken": "Этот табельный номер уже занят"
```

заменить на

<!-- prettier-ignore -->
```json
      "deactivated": "Оператор «{{name}}» выключен.",
      "activated": "Оператор «{{name}}» включён.",
      "badges": {
        "title": "Бейджи оператора «{{name}}»",
        "empty": "Бейджей пока нет.",
        "unnamed": "Без подписи",
        "addedAt": "Добавлен {{date}}",
        "status": {
          "active": "Действует",
          "revoked": "Отозван"
        },
        "add": "Добавить бейдж",
        "revoke": "Отозвать",
        "revokeNamed": "Отозвать бейдж «{{label}}», добавленный {{date}}",
        "addTitle": "Новый бейдж: {{name}}",
        "addSubmit": "Добавить",
        "fields": {
          "code": "Код бейджа",
          "codeHint": "Отсканируйте бейдж или наберите его код",
          "label": "Подпись",
          "labelHint": "Необязательно, например «Пропуск №7»"
        },
        "revokeTitle": "Отозвать бейдж?",
        "revokeBody": "Бейдж «{{label}}» оператора «{{name}}» перестанет открывать вход на станциях, как только они получат изменение. Отозванный бейдж не вернуть: для этой карты понадобится новый бейдж.",
        "revokeSubmit": "Отозвать",
        "added": "Бейдж «{{label}}» добавлен.",
        "revoked": "Бейдж «{{label}}» отозван.",
        "errors": {
          "taken": "Этот бейдж уже выдан оператору",
          "takenBy": "Этот бейдж уже у оператора «{{name}}»",
          "noSalt": "Хост ещё не настроен: бейджи можно добавлять после первого запуска."
        }
      },
      "errors": {
        "loginTaken": "Этот табельный номер уже занят"
```

13. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
  color: var(--fg-2);
}

.pairing-code {
  display: grid;
  justify-items: center;
```

заменить на

<!-- prettier-ignore -->
```css
  color: var(--fg-2);
}

/* An operator's badges: revoked ones stay listed, dimmed, as the record of what was issued. */
.badge-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.badge-list__item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 8px;
}

.badge-list__item--revoked {
  color: var(--fg-2);
}

.badge-list__name {
  display: grid;
}

.badge-list__date {
  color: var(--fg-2);
}

.pairing-code {
  display: grid;
  justify-items: center;
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2, и `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx`; затем обе с `--reporter=verbose`; затем оба файла под стендом с задержкой `setImmediate`.
Expected: PASS — 11 тестов в `operator-badges.test.tsx`, 15 в `operators-page.test.tsx`; stderr verbose-прогонов пуст; под стендом — 26.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/office/operators/AddBadgeDialog.tsx` читать соль при каждом открытии: фрагмент

<!-- prettier-ignore -->
```tsx
  const salt = useOfficeQuery(officeKeys.badgeSalt, (api, token) => api.getBadgeSalt(token), {
    staleTime: Infinity,
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
  const salt = useOfficeQuery(officeKeys.badgeSalt, (api, token) => api.getBadgeSalt(token));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx -t "once per session"`
Expected: FAIL — `expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 2. В `apps/standalone/src/office/operators/AddBadgeDialog.tsx` не называть владельца: фрагмент

<!-- prettier-ignore -->
```tsx
      const taken = badgeHolder(error, operators);
      if (taken !== null) {
        setHolder(taken.name);
        setError("code", { type: "server", message: TAKEN_BY });
        return;
      }
```

заменить на

<!-- prettier-ignore -->
```tsx
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx -t "names the operator"`
Expected: FAIL — `Unable to find an element with the text: Этот бейдж уже у оператора «Вера Лебедева»`.

Мутация 3. В `apps/standalone/src/office/operators/OperatorsPage.tsx` не отмечать отзыв до перечитывания: фрагмент

<!-- prettier-ignore -->
```tsx
              changeList((list) =>
                withBadgeRevoked(list, operator.id, dialog.badge.id, new Date().toISOString()),
              );
```

заменить на

<!-- prettier-ignore -->
```tsx
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx -t "revokes a badge"`
Expected: FAIL — `Unable to find an element with the text: Отозван` (бейдж ещё «Действует», перечитывание не пришло).

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  until its promise settles it cannot be closed and a second submit is
  dropped, so a double click sends nothing twice. `writeFailure` (`src/office/form-errors.ts`)
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`) goes under that field,
  `stale_revision` offers to reload, anything else is an alert
  (`WriteFailureAlert`). A `FormDialog`'s `onSubmit` must never reject: it
  sorts every failure itself, and a rejection would only surface as an
  unhandled one, so a caller's bug is not hidden. Only the awaited write sits
  in the `try`, with the hashing that builds its body where there is one (an
  operator's PIN); the callback after a saved write (`onSaved`, `onRevoked`, …)
  and whatever else follows a success run after the `try/catch`, whose `catch`
  ends with `return`, so a throw there is never shown as a failed write (a
  retry would add a second counterparty: the host keeps no uniqueness). The
```

заменить на

<!-- prettier-ignore -->
```text
  until its promise settles it cannot be closed and a second submit is
  dropped, so a double click sends nothing twice. `writeFailure` (`src/office/form-errors.ts`)
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`, `badge`) goes under that field,
  `stale_revision` offers to reload, anything else is an alert
  (`WriteFailureAlert`). A `FormDialog`'s `onSubmit` must never reject: it
  sorts every failure itself, and a rejection would only surface as an
  unhandled one, so a caller's bug is not hidden. Only the awaited write sits
  in the `try`, with the hashing that builds its body where there is one (a
  PIN, a badge code); the callback after a saved write (`onSaved`, `onRevoked`, …)
  and whatever else follows a success run after the `try/catch`, whose `catch`
  ends with `return`, so a throw there is never shown as a failed write (a
  retry would add a second counterparty: the host keeps no uniqueness). The
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  `FormDialog` guard covers the hashing too, and the mutation's variables,
  which the query cache keeps, hold only the hash. There is no delete, and
  the page offers none.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

заменить на

<!-- prettier-ignore -->
```text
  `FormDialog` guard covers the hashing too, and the mutation's variables,
  which the query cache keeps, hold only the hash. There is no delete, and
  the page offers none.
- «Бейджи» on an operator's row lists that operator's badges, revoked ones
  too, dimmed and marked «Отозван»: they are the record of what was issued.
  «Добавить бейдж» reads the site's salt once per session
  (`GET /v1/office/badge-salt` with `staleTime: Infinity`; `not_found` means
  a host before its wizard) and focuses the code, which a keyboard-wedge
  scanner types and submits with Enter. The dialog hashes the code with the
  salt (`hashBadge`) and sends only the hash. The answer is the new badge,
  not its operator, so the badge goes into the cached operator at once. A
  `badge` conflict names the holder under the code when `details.operatorId`
  is a UUID of an operator in the list, and otherwise says only that the
  badge is taken. «Отозвать» asks first and says that the badge stops
  opening the stations once they sync and never comes back; after the host's
  204 the badge shows as revoked at once, and the list is read again.
- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  показывается; «Выключить» спрашивает подтверждение и говорит, что оператор
  не сможет входить на станциях, как только они получат изменение, «Включить»
  спрашивает коротко. На хост уходят только изменённые поля с `expectedRev`.
  Интерфейс считает `pinPhc` (случайная соль) и `badgePhc` (соль площадки из
  `GET /v1/office/badge-salt`) функциями `@markiro/domain` и отправляет только
  хеши.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
```

заменить на

<!-- prettier-ignore -->
```text
  показывается; «Выключить» спрашивает подтверждение и говорит, что оператор
  не сможет входить на станциях, как только они получат изменение, «Включить»
  спрашивает коротко. На хост уходят только изменённые поля с `expectedRev`.
  «Бейджи» — список бейджей оператора, отозванные тоже (приглушены, с пометкой
  «Отозван»); «Добавить бейдж» — код со сканера (Enter отправляет форму) и
  необязательная подпись; бейдж, который уже есть у другого оператора, назван
  по имени этого оператора; «Отозвать» спрашивает подтверждение. Интерфейс
  считает `pinPhc` (случайная соль) и `badgePhc` (соль площадки из
  `GET /v1/office/badge-salt`, её офис читает один раз за сессию) функциями
  `@markiro/domain` и отправляет только хеши.
- Шаблоны: импорт ZPL/TSPL/JSON, форма размеров и предпросмотр переносятся из
  `apps/admin/src/pages/labels` и `apps/admin/src/labels` вместе с растеризатором и
  проверкой покрытия шрифтов.
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `node_modules/.bin/prettier --check apps/standalone/src/office/operators apps/standalone/src/office/office-query.ts apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-badges.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 36 файлов, 709 тестов.

```bash
git add apps/standalone/src/office/operators apps/standalone/src/office/office-query.ts apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/operator-badges.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): бейджи операторов в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Копии операторов и бейджей на станции — `ref_operators`, `ref_operator_badges`

Станция начинает хранить записи ленты `operators` и `operator_badges` (спецификация §5.3); вход по ним — план 1f.

- **Миграция `0003_operators_badges.sql`**: `ref_operators(id, login, name, role, pin_phc, rev)` и `ref_operator_badges(id, operator_id, badge_phc, label, rev)`. Внешнего ключа от бейджа к оператору нет (лента законно шлёт бейдж выключенного оператора, и бейдж может прийти раньше своего оператора). Уникальности, кроме ключа, нет: отказ по ней сорвал бы всю порцию и навсегда остановил синхронизацию. Индексы по `login`, `operator_id` и `badge_phc` — обычные. `clear_copies` очищает новые таблицы сам (`pragma_table_list`); тесты, которые перечисляют таблицы, получают две новые. Шапка `0001` («операторы, бейджи, товары и шаблоны — планы 1d и 1e») остаётся верной.
- **Строгие записи.** `site`, `operators`, `operator_badges` читаются `z.strictObject`: запись, дающая доступ, с незнакомым ключом не теряет его молча, а уходит в карантин. Проверки формата, чтобы бесполезная копия ушла в карантин, а не осталась: `login` — 3–12 цифр; `pinPhc` — `isPinPhc` (10 000–1 000 000 итераций); `badgePhc` — `isBadgePhc` (ровно `BADGE_ITERATIONS`); оба — строка, записанная так, как пишет хост. Соль бейджа с записью `site` не сверяется (Global Constraints).
- **`ENTITIES`** — `operators` и `operator_badges`; `SYNC_SCHEMA_VERSION` = 3, поэтому каждое устройство один раз синхронизируется с нуля. Бюджет порции — 3E + 6 = 21 SQL-оператор при E = 5 (из 32 оболочки). Надгробия и карантин работают прежним общим кодом; тесты — на настоящей фикстуре `changes-people.json`.
- **`AND NOT EXISTS`** (задание брифа): upsert оператора и бейджа не возвращает ключ, более новая ревизия которого ждёт в карантине. По правилам ленты такое не приходит, но приходит от старого прогона, запрос которого был отправлен до `device_forget`, если устройство успело подключиться заново к тому же хосту: новое подключение ставит тот же `host_id`, и `hostGuard` пропускает старую страницу. Тест строит это на настоящем коде; без защиты у любого из двух upsert он падает.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0003_operators_badges.sql`
- Modify: `apps/standalone/src/lib/credentials.ts`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/local/reference-sync.ts`
- Modify (тесты): `apps/standalone/test/reference-sync.test.ts`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/credentials.test.ts`, `apps/standalone/test/local-executor.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.3, §5.4)

**Interfaces:**

- Consumes: `parsePhc`, `formatPhc`, `ParsedPhc` — `@markiro/domain`; `BADGE_ITERATIONS` — задача 1; `checked`, `deleteOlder`, `QUARANTINE`, `LIFT_QUARANTINE`, `WIPE`, `hostGuard` — `src/local/reference-sync.ts`.
- Produces:
  - `MIN_PHC_ITERATIONS = 10_000`, `MAX_PHC_ITERATIONS = 1_000_000`, `isPinPhc(phc): boolean`, `isBadgePhc(phc): boolean` — `src/lib/credentials.ts`;
  - `operatorRecordSchema`/`OperatorRecord`, `operatorBadgeRecordSchema`/`OperatorBadgeRecord`; `siteRecordSchema` — `z.strictObject` — `src/host/protocol.ts`;
  - `ENTITY_SET = "org_profile,site,lines,operators,operator_badges;v3"`; таблицы `ref_operators`, `ref_operator_badges` (план 1f их читает, задача 7 пишет в них в тесте следов).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  createSyncScheduler,
```

заменить на

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  changesResponseSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  createSyncScheduler,
```

2. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  return { entity: "lines", id, rev, deleted: false, data: { name: "Линия 1", archived: "да" } };
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}

/** A change feed answering each `since` with its page; any other `since` fails the sync. */
function feed(pages: Record<number, ChangesResponse>) {
```

заменить на

<!-- prettier-ignore -->
```ts
  return { entity: "lines", id, rev, deleted: false, data: { name: "Линия 1", archived: "да" } };
}

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** `changes-people.json`: an operator, a badge, a badge's and an operator's tombstones. */
const PEOPLE = changesResponseSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/changes-people.json", testModuleUrl), "utf8")),
);
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
/** The badge and the operator `PEOPLE` deletes. */
const OLD_PASS = "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19";
const TURNED_OFF = "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21";
const VERA = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
/** The PIN 4821 and the badge «MRK-000742», as the office hashed them (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";

function operator(id: string, rev: number, login: string, data: object = {}): ChangeItem {
  return {
    entity: "operators",
    id,
    rev,
    deleted: false,
    data: { login, name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC, ...data },
  };
}

function badge(id: string, rev: number, operatorId: string, data: object = {}): ChangeItem {
  return {
    entity: "operator_badges",
    id,
    rev,
    deleted: false,
    data: { operatorId, badgePhc: BADGE_PHC, label: null, ...data },
  };
}

/** The operator and badge copies as plain rows. */
function people(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    operators: rows("SELECT id, login, name, role, pin_phc, rev FROM ref_operators ORDER BY id"),
    badges: rows(
      "SELECT id, operator_id, badge_phc, label, rev FROM ref_operator_badges ORDER BY id",
    ),
  };
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}

/** Every table `clear_copies` empties. */
const COPY_TABLES = [
  "ref_org",
  "ref_site",
  "ref_lines",
  "ref_operators",
  "ref_operator_badges",
  "sync_quarantine",
  "sync_state",
];

/** A change feed answering each `since` with its page; any other `since` fails the sync. */
function feed(pages: Record<number, ChangesResponse>) {
```

3. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines;v2");
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines,operators,operator_badges;v3");
  });
});
```

4. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts

    // `clear_copies` (`device_forget`) deletes every row of every table,
    // `sync_state` included, in one transaction of its own.
    for (const table of ["ref_org", "ref_site", "ref_lines", "sync_quarantine", "sync_state"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    resolve?.(page(11, [line(LINE_1, 11, "Линия 1 (после сброса)")]));
    const error: unknown = await run.then(
```

заменить на

<!-- prettier-ignore -->
```ts

    // `clear_copies` (`device_forget`) deletes every row of every table,
    // `sync_state` included, in one transaction of its own.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();

    resolve?.(page(11, [line(LINE_1, 11, "Линия 1 (после сброса)")]));
    const error: unknown = await run.then(
```

5. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    const operator: ChangeItem = {
      entity: "operators",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { login: "1001" },
    };
    const changes = feed({ 0: page(42, [operator, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
```

заменить на

<!-- prettier-ignore -->
```ts

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    // Products come with plan 1e.
    const product: ChangeItem = {
      entity: "products",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { gtin14: "04600682000013" },
    };
    const changes = feed({ 0: page(42, [product, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
```

6. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
      tombstone(LINE_2, 40),
      line(LINE_1, 42, "Линия 1"),
      brokenLine("9b2e4a6c-0000-4000-8000-000000000000", 42),
    ];
    await expect(
      syncReferences({
```

заменить на

<!-- prettier-ignore -->
```ts
      tombstone(LINE_2, 40),
      line(LINE_1, 42, "Линия 1"),
      brokenLine("9b2e4a6c-0000-4000-8000-000000000000", 42),
      { entity: "operators", id: TURNED_OFF, rev: 40, deleted: true },
      operator(ANNA, 42, "0042"),
      operator(VERA, 42, "0099", { pinPhc: "4821" }),
      { entity: "operator_badges", id: OLD_PASS, rev: 40, deleted: true },
      badge(PASS_7, 42, ANNA),
      badge("9b2e4a6c-0000-4000-8000-000000000001", 42, ANNA, {
        badgePhc: PIN_PHC.replace("100000", "200000"),
      }),
    ];
    await expect(
      syncReferences({
```

7. В `apps/standalone/test/reference-sync.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 3 });
    // The `host_id` stamp, then the page: the guard, the wipe (3 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 3 + 6 = 15. Each new entity adds 3 (a wipe, a delete, an upsert),
    // so plan 1d4's operators and badges make it 21, within the shell's 32.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 15]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 5 });
    // The `host_id` stamp, then the page: the guard, the wipe (5 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 5 + 6 = 21. Each new entity adds 3 (a wipe, a delete, an upsert):
    // plan 1e's products, templates and their defaults would make it 30, the
    // most the shell's 32 takes.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 21]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});

describe("operator and badge copies", () => {
  it("keeps the people fixture's operator and badge and applies its tombstones", async () => {
    const { db, executor } = openLocalDb();
    // Synced before the fixture's page: the operator it deletes, the badge it
    // revokes.
    await syncReferences({
      changes: feed({ 0: page(54, [operator(TURNED_OFF, 50, "0043"), badge(OLD_PASS, 52, ANNA)]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(people(db).operators).toHaveLength(1);
    expect(people(db).badges).toHaveLength(1);
    await expect(
      syncReferences({ changes: feed({ 54: PEOPLE }), local: executor, hostId: HOST_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 57, quarantined: 0 });
    expect(people(db)).toEqual({
      operators: [
        {
          id: ANNA,
          login: "0042",
          name: "Анна Кузнецова",
          role: "Упаковщик",
          pin_phc: PIN_PHC,
          rev: 55,
        },
      ],
      badges: [{ id: PASS_7, operator_id: ANNA, badge_phc: BADGE_PHC, label: null, rev: 56 }],
    });
    expect(tables(db).state).toEqual(state(57));
  });

  it("quarantines an operator or a badge this build cannot use, deletes its older copy and applies the rest", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [
          operator(ANNA, 10, "0042"),
          operator(VERA, 11, "0099"),
          badge(PASS_7, 12, ANNA),
          badge(OLD_PASS, 13, VERA),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
    });
    const changes = feed({
      20: page(30, [
        // A key a newer host added: the record fails closed, not trimmed.
        operator(ANNA, 21, "0042", { shiftId: "7" }),
        // More work than a station may spend on a PIN.
        operator(VERA, 22, "0099", { pinPhc: PIN_PHC.replace("100000", "1000001") }),
        // A count the host never takes for a badge: no scan would match it.
        badge(PASS_7, 23, ANNA, { badgePhc: BADGE_PHC.replace("100000", "0100000") }),
        badge(OLD_PASS, 24, VERA, { label: "Пропуск №9" }),
      ]),
    });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 3 });
    expect(people(db)).toEqual({
      operators: [],
      badges: [
        { id: OLD_PASS, operator_id: VERA, badge_phc: BADGE_PHC, label: "Пропуск №9", rev: 24 },
      ],
    });
    expect(quarantine(db)).toEqual([
      {
        entity: "operator_badges",
        id: PASS_7,
        rev: 23,
        reason: "badgePhc: custom",
        seen_at: SEEN_AT,
      },
      { entity: "operators", id: VERA, rev: 22, reason: "pinPhc: custom", seen_at: SEEN_AT },
      {
        entity: "operators",
        id: ANNA,
        rev: 21,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("keeps a badge whose operator is not among the copies: no foreign key", async () => {
    // The feed keeps the badge of an operator who was turned off, and a badge
    // can come in a page before its operator.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [badge(PASS_7, 12, ANNA)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(people(db).operators).toEqual([]);
    expect(people(db).badges).toHaveLength(1);
  });

  it("keeps two badges with one hash: the copies hold no uniqueness of their own", async () => {
    // The host keeps an active badge on one operator. A copy that refused a
    // second row would fail its whole page, and the sync would never move on.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [badge(PASS_7, 11, ANNA), badge(OLD_PASS, 12, VERA)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(people(db).badges).toHaveLength(2);
  });

  it("keeps an older record out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [operator(ANNA, 20, "0042"), badge(PASS_7, 20, ANNA)]) }),
      local: executor,
      hostId: HOST_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({ changes: held, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions: fields
    // this build does not read.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            operator(ANNA, 35, "0042", { shiftId: "7" }),
            badge(PASS_7, 36, ANNA, { zone: "B" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last. `hostGuard` lets it through:
    // the new pairing stamped the same `host_id`.
    resolve?.(page(30, [operator(ANNA, 25, "0042"), badge(PASS_7, 25, ANNA)]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    expect(people(db)).toEqual({ operators: [], badges: [] });
    expect(quarantine(db)).toEqual([
      {
        entity: "operator_badges",
        id: PASS_7,
        rev: 36,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
      {
        entity: "operators",
        id: ANNA,
        rev: 35,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
    ]);
  });
});
```

8. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorCreateSchema,
  operatorUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorBadgeRecordSchema,
  operatorCreateSchema,
  operatorRecordSchema,
  operatorUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
```

9. В `apps/standalone/test/protocol.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    expect(siteRecordSchema.parse(changes.items[2]?.data)).toEqual(rawChanges.items[2]?.data);
    expect(changes.items[3]).toMatchObject({ deleted: true });
    expect(changes.items[3]?.data).toBeUndefined();
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(siteRecordSchema.parse(changes.items[2]?.data)).toEqual(rawChanges.items[2]?.data);
    expect(changes.items[3]).toMatchObject({ deleted: true });
    expect(changes.items[3]?.data).toBeUndefined();
  });

  it("change feed of people", () => {
    const rawChanges = fixture("changes-people.json") as { items: Array<{ data?: unknown }> };
    const changes = changesResponseSchema.parse(rawChanges);
    expect(changes.items).toHaveLength(4);
    expect(operatorRecordSchema.parse(changes.items[0]?.data)).toEqual(rawChanges.items[0]?.data);
    expect(operatorBadgeRecordSchema.parse(changes.items[1]?.data)).toEqual(
      rawChanges.items[1]?.data,
    );
    expect(changes.items.slice(2).map((item) => [item.entity, item.deleted, item.data])).toEqual([
      ["operator_badges", true, undefined],
      ["operators", true, undefined],
    ]);
  });
});

/** `data` of item `index` of a feed fixture, as an object. */
function feedRecord(name: string, index: number): Record<string, unknown> {
  const changes = changesResponseSchema.parse(fixture(name));
  const data = changes.items[index]?.data;
  if (typeof data !== "object" || data === null) throw new Error(`${name} has no record ${index}`);
  return { ...data };
}

describe("feed records that grant access", () => {
  const OPERATOR = feedRecord("changes-people.json", 0);
  const BADGE = feedRecord("changes-people.json", 1);
  const SITE = feedRecord("changes-response.json", 2);

  it("have exactly their keys: an unknown key or a missing one fails closed", () => {
    for (const [schema, record] of [
      [operatorRecordSchema, OPERATOR],
      [operatorBadgeRecordSchema, BADGE],
      [siteRecordSchema, SITE],
    ] as const) {
      expect(schema.safeParse(record).success).toBe(true);
      expect(schema.safeParse({ ...record, addedLater: true }).success).toBe(false);
    }
    const withoutRole = Object.fromEntries(
      Object.entries(OPERATOR).filter(([key]) => key !== "role"),
    );
    expect(operatorRecordSchema.safeParse(withoutRole).success).toBe(false);
  });

  it("take a personnel number of 3 to 12 digits and a badge's operator by UUID", () => {
    for (const login of ["042", "123456789012"]) {
      expect(operatorRecordSchema.safeParse({ ...OPERATOR, login }).success).toBe(true);
    }
    for (const login of ["42", "1234567890123", "0042a", " 0042"]) {
      expect(operatorRecordSchema.safeParse({ ...OPERATOR, login }).success).toBe(false);
    }
    expect(operatorBadgeRecordSchema.safeParse({ ...BADGE, operatorId: "0042" }).success).toBe(
      false,
    );
  });
});
```

10. В `apps/standalone/test/credentials.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BADGE_ITERATIONS, hashBadge, hashPin } from "../src/lib/credentials.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
```

заменить на

<!-- prettier-ignore -->
```ts
import { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BADGE_ITERATIONS,
  hashBadge,
  hashPin,
  isBadgePhc,
  isPinPhc,
  MAX_PHC_ITERATIONS,
  MIN_PHC_ITERATIONS,
} from "../src/lib/credentials.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
```

11. В `apps/standalone/test/credentials.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    }
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    }
  });
});

describe("hashes a station can use", () => {
  /** `PIN_PHC` with its count written as `count`. */
  function pinWith(count: string): string {
    return PIN_PHC.replace("$100000$", `$${count}$`);
  }

  it("takes a PIN hash of 10 000 to 1 000 000 iterations, written as the host writes it", () => {
    expect([MIN_PHC_ITERATIONS, MAX_PHC_ITERATIONS]).toEqual([10_000, 1_000_000]);
    for (const count of ["10000", "100000", "1000000"]) {
      expect(isPinPhc(pinWith(count))).toBe(true);
    }
    // `parsePhc` reads the last four as 100 000; the host never writes them.
    for (const count of ["9999", "1000001", "0100000", "1e5", " 100000", "100000.0"]) {
      expect(isPinPhc(pinWith(count))).toBe(false);
    }
    expect(isPinPhc("4821")).toBe(false);
  });

  it("takes a badge hash with exactly BADGE_ITERATIONS, written as the host writes it", () => {
    expect(isBadgePhc(BADGE_PHC)).toBe(true);
    for (const count of ["10000", "200000", "0100000", "1e5"]) {
      expect(isBadgePhc(BADGE_PHC.replace("$100000$", `$${count}$`))).toBe(false);
    }
    expect(isBadgePhc(BADGE_PHC.replace("AAECAwQFBgcICQoLDA0ODw==", "AAECAwQFBgc="))).toBe(false);
  });
});
```

12. В `apps/standalone/test/local-executor.test.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    );
    expect(tables.map((table) => table.name)).toEqual([
      "ref_lines",
      "ref_org",
      "ref_site",
      "sync_quarantine",
```

заменить на

<!-- prettier-ignore -->
```ts
    );
    expect(tables.map((table) => table.name)).toEqual([
      "ref_lines",
      "ref_operator_badges",
      "ref_operators",
      "ref_org",
      "ref_site",
      "sync_quarantine",
```

13. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        names,
        [
            "ref_lines",
            "ref_org",
            "ref_site",
            "sync_quarantine",
```

заменить на

<!-- prettier-ignore -->
```rust
        names,
        [
            "ref_lines",
            "ref_operator_badges",
            "ref_operators",
            "ref_org",
            "ref_site",
            "sync_quarantine",
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts test/protocol.test.ts test/credentials.test.ts test/local-executor.test.ts`; затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`
Expected: FAIL:

- Vitest — 14 тестов из 187: `reference-sync.test.ts` — 8 (`ENTITY_SET` — `expected 'org_profile,site,lines;v2' …`; бюджет порции — прогон с другим числом записей в карантине; пять новых и имитация `clear_copies` — `no such table: ref_operators`), `protocol.test.ts` — 3 (новых схем записей нет: `TypeError`), `credentials.test.ts` — 2 (`isBadgePhc is not a function`), `local-executor.test.ts` — 1 (список таблиц без двух новых);
- cargo: 1 из 10, `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` — `left: ["ref_lines", "ref_org", "ref_site", "sync_quarantine", "sync_state"]`.

- [ ] **Step 3: Миграция, проверки хешей, строгие записи и сущности**

1. Create `apps/standalone/src-tauri/migrations/0003_operators_badges.sql`:

```sql
-- The station's copies of operators and their badges (stage 1 spec §5.3,
-- plan 1d4). The change feed sends an operator only while active and a badge
-- only while not revoked; each leaves as a tombstone, and the webview's
-- reference sync deletes its copy. The station's sign-in (plan 1f) reads
-- them; `device_forget` empties both tables (`LocalDb::clear_copies`).
--
-- No foreign key from a badge to its operator: the feed keeps sending the
-- badge of an operator who was turned off, and a badge can come in a page
-- before its operator. No uniqueness besides the key either: the host keeps
-- personnel numbers and active badges unique, and a copy that refused a row
-- would abort its whole page and stop the sync for good. `pin_phc` and
-- `badge_phc` are PBKDF2 PHC strings, never a PIN or a badge code.
CREATE TABLE ref_operators (
  id TEXT PRIMARY KEY,
  -- The personnel number: 3-12 digits, leading zeros included.
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  pin_phc TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE INDEX ref_operators_login ON ref_operators (login);

CREATE TABLE ref_operator_badges (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  badge_phc TEXT NOT NULL,
  label TEXT,
  rev INTEGER NOT NULL
);

CREATE INDEX ref_operator_badges_operator ON ref_operator_badges (operator_id);

CREATE INDEX ref_operator_badges_phc ON ref_operator_badges (badge_phc);
```

2. В `apps/standalone/src/lib/credentials.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";

// Operator credentials as the office makes them (stage 1 spec §5.5): the PIN
// and the badge code are hashed here, in the webview, and only the PHC
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  deriveDigestB64,
  formatPhc,
  parsePhc,
  PHC_ITERATIONS,
  type ParsedPhc,
} from "@markiro/domain";

// Operator credentials as the office makes them (stage 1 spec §5.5): the PIN
// and the badge code are hashed here, in the webview, and only the PHC
```

3. В `apps/standalone/src/lib/credentials.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    await deriveDigestB64(code, saltB64, BADGE_ITERATIONS),
  );
}
```

заменить на

<!-- prettier-ignore -->
```ts
    await deriveDigestB64(code, saltB64, BADGE_ITERATIONS),
  );
}

/** The fewest iterations the host takes in a verifier (`secrets::MIN_ITERATIONS`). */
export const MIN_PHC_ITERATIONS = 10_000;
/** The most (`secrets::MAX_ITERATIONS`): a station verifies with the count a hash carries. */
export const MAX_PHC_ITERATIONS = 1_000_000;

/**
 * `phc` parsed, when it is written exactly as the host writes a verifier:
 * the domain's format (`parsePhc`) with a count in plain digits, so writing
 * it out again gives the same string. The host's `parse_phc` refuses
 * `0100000` or `1e5`, which `parsePhc` reads as 100 000.
 */
function asHostWrites(phc: string): ParsedPhc | null {
  const parsed = parsePhc(phc);
  if (parsed === null) return null;
  return formatPhc(parsed.iterations, parsed.saltB64, parsed.digestB64) === phc ? parsed : null;
}

/** A PIN verifier a station can use: as the host writes it, with 10 000–1 000 000 iterations. */
export function isPinPhc(phc: string): boolean {
  const parsed = asHostWrites(phc);
  return (
    parsed !== null &&
    parsed.iterations >= MIN_PHC_ITERATIONS &&
    parsed.iterations <= MAX_PHC_ITERATIONS
  );
}

/**
 * A badge verifier a station can match: as the host writes it, with exactly
 * `BADGE_ITERATIONS`. The salt is not checked against the `site` record: the
 * host takes only the site's, the salt never changes after the wizard, and a
 * copy with another salt matches no scan anyway, since a station hashes a
 * scan with the site's salt and compares whole strings.
 */
export function isBadgePhc(phc: string): boolean {
  return asHostWrites(phc)?.iterations === BADGE_ITERATIONS;
}
```

4. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { isBadgePhc, isPinPhc } from "../lib/credentials.js";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
```

5. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/** `data` of a `site` item: the badge salt is 16 bytes, standard base64 with padding. */
export const siteRecordSchema = z.object({
  badgeSalt: z.base64().length(24),
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/**
 * `data` of a `site` item: the badge salt is 16 bytes, standard base64 with
 * padding. Exactly these keys (`z.strictObject`), like the people records:
 * the salt decides which badges a station matches.
 */
export const siteRecordSchema = z.strictObject({
  badgeSalt: z.base64().length(24),
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
```

6. В `apps/standalone/src/host/protocol.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/** `data` of a `lines` item. */
export const lineRecordSchema = z.object({ name: z.string(), archived: z.boolean() });
export type LineRecord = z.infer<typeof lineRecordSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```ts
/** `data` of a `lines` item. */
export const lineRecordSchema = z.object({ name: z.string(), archived: z.boolean() });
export type LineRecord = z.infer<typeof lineRecordSchema>;

/**
 * `data` of an `operators` item. It grants sign-in, so it has exactly these
 * keys (`z.strictObject`): an unknown one, which a newer host could use to
 * say something this build would miss, quarantines the record instead of
 * being dropped. A personnel number of 3–12 digits, and a PIN hash a station
 * can verify (`isPinPhc`).
 */
export const operatorRecordSchema = z.strictObject({
  login: z.string().regex(/^[0-9]{3,12}$/),
  name: z.string(),
  role: z.string().nullable(),
  pinPhc: z.string().refine(isPinPhc),
});
export type OperatorRecord = z.infer<typeof operatorRecordSchema>;

/**
 * `data` of an `operator_badges` item: exactly these keys, as for an
 * operator, and a badge hash a station can match (`isBadgePhc`).
 */
export const operatorBadgeRecordSchema = z.strictObject({
  operatorId: z.uuid(),
  badgePhc: z.string().refine(isBadgePhc),
  label: z.string().nullable(),
});
export type OperatorBadgeRecord = z.infer<typeof operatorBadgeRecordSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
```

7. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts

import {
  lineRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
```

заменить на

<!-- prettier-ignore -->
```ts

import {
  lineRecordSchema,
  operatorBadgeRecordSchema,
  operatorRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
```

8. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/**
 * Why a record fails its schema, from Zod issue paths and codes only
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records will carry PIN and badge hashes (plan 1d4).
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * Why a record fails its schema, from Zod issue paths and codes only
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records carry PIN and badge hashes. That holds only while
 * every record schema has fixed keys: a `z.record` would put keys taken from
 * the data into the paths.
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
```

9. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) return { reason: quarantineReason(parsed.error) };
  return { row: { ...parsed.data, id: item.id, rev: item.rev } };
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
```

заменить на

<!-- prettier-ignore -->
```ts
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) return { reason: quarantineReason(parsed.error) };
  return { row: { ...parsed.data, id: item.id, rev: item.rev } };
}

/**
 * The `WHERE` of an upsert that keeps an older revision of a record out while
 * a newer one waits in quarantine: the insert would otherwise bring back what
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one, but a stale run can: a page fetched before
 * `device_forget` that lands only after a new pairing with the same host has
 * stamped `host_id` again, when `hostGuard` no longer stops it. Only for the
 * records that grant access, operators and their badges.
 */
function notQuarantinedNewer(entity: string): string {
  return (
    "WHERE NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
    `WHERE q.entity = '${entity}' AND q.id = r.value ->> 'id' AND q.rev > r.value ->> 'rev')`
  );
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
```

10. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
        "WHERE excluded.rev > ref_lines.rev",
    },
  ],
]);

/**
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE excluded.rev > ref_lines.rev",
    },
  ],
  [
    "operators",
    {
      table: "ref_operators",
      check: (item) => checked(operatorRecordSchema, item),
      upsert:
        "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'login', r.value ->> 'name', r.value ->> 'role', " +
        "r.value ->> 'pinPhc', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("operators") +
        " ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, " +
        "role = excluded.role, pin_phc = excluded.pin_phc, rev = excluded.rev " +
        "WHERE excluded.rev > ref_operators.rev",
    },
  ],
  [
    "operator_badges",
    {
      table: "ref_operator_badges",
      check: (item) => checked(operatorBadgeRecordSchema, item),
      upsert:
        "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'operatorId', r.value ->> 'badgePhc', " +
        "r.value ->> 'label', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("operator_badges") +
        " ON CONFLICT (id) DO UPDATE SET operator_id = excluded.operator_id, " +
        "badge_phc = excluded.badge_phc, label = excluded.label, rev = excluded.rev " +
        "WHERE excluded.rev > ref_operator_badges.rev",
    },
  ],
]);

/**
```

11. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 2;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`. Today:
 * `"org_profile,site,lines;v2"`. A build that keeps other entities, or reads
 * them differently, finds another value there and syncs from zero: records
 * the old build skipped or quarantined would never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;
```

заменить на

<!-- prettier-ignore -->
```ts
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 3;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`. Today:
 * `"org_profile,site,lines,operators,operator_badges;v3"`. A build that
 * keeps other entities, or reads them differently, finds another value there
 * and syncs from zero: records the old build skipped or quarantined would
 * never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;
```

12. В `apps/standalone/src/local/reference-sync.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 15 today, 21 with plan 1d4's two entities, and E = 8 at most
 * within the shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

заменить на

<!-- prettier-ignore -->
```ts
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 21 for the five kept today, and E = 8 (30) at most within the
 * shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: те же команды, что в шаге 2; затем четыре файла Vitest с `--reporter=verbose` и под стендом с задержкой `setImmediate`.
Expected: PASS — 187 тестов (39 в `reference-sync`, 87 в `protocol`, 7 в `credentials`, 54 в `local-executor`); cargo `--test local_db` — 10 тестов; stderr verbose-прогона пуст; под стендом — те же числа.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/local/reference-sync.ts` снять защиту с upsert операторов: фрагмент

<!-- prettier-ignore -->
```ts
        notQuarantinedNewer("operators") +
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE true" +
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "stale run of a forgotten pairing"`
Expected: FAIL — `expected { operators: [ { …(6) } ], badges: [] } to deeply equal { operators: [], badges: [] }`.

Мутация 2. В `apps/standalone/src/local/reference-sync.ts` снять ту же защиту с upsert бейджей: фрагмент

<!-- prettier-ignore -->
```ts
        notQuarantinedNewer("operator_badges") +
```

заменить на

<!-- prettier-ignore -->
```ts
        "WHERE true" +
```

Run: та же команда, что у мутации 1.
Expected: FAIL — `expected { operators: [], badges: [ { …(5) } ] } to deeply equal { operators: [], badges: [] }`.

Мутация 3. В `apps/standalone/src-tauri/migrations/0003_operators_badges.sql` добавить внешний ключ: фрагмент

<!-- prettier-ignore -->
```sql
  operator_id TEXT NOT NULL,
```

заменить на

<!-- prettier-ignore -->
```sql
  operator_id TEXT NOT NULL REFERENCES ref_operators (id),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "no foreign key"`
Expected: FAIL — `promise rejected "LocalDbError: Error: FOREIGN KEY constrai…"` (`node:sqlite` проверяет внешние ключи, как оболочка).

Мутация 4. В `apps/standalone/src-tauri/migrations/0003_operators_badges.sql` сделать индекс хеша уникальным: фрагмент

<!-- prettier-ignore -->
```sql
CREATE INDEX ref_operator_badges_phc ON ref_operator_badges (badge_phc);
```

заменить на

<!-- prettier-ignore -->
```sql
CREATE UNIQUE INDEX ref_operator_badges_phc ON ref_operator_badges (badge_phc);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "no uniqueness"`
Expected: FAIL — `promise rejected "LocalDbError: Error: UNIQUE constraint fa…"`.

Мутация 5. В `apps/standalone/src/host/protocol.ts` читать оператора нестрого: фрагмент

<!-- prettier-ignore -->
```ts
export const operatorRecordSchema = z.strictObject({
```

заменить на

<!-- prettier-ignore -->
```ts
export const operatorRecordSchema = z.object({
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/reference-sync.test.ts -t "cannot use"`
Expected: FAIL — прогон сообщает 2 записи в карантине вместо 3: запись с незнакомым ключом принята.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`feed::remove` and `feed::restore` for both.

A change that removes access rides the feed as a tombstone, never as a
flag: the webview reads records with `z.object`, which drops unknown keys,
so a newer host expressing a revocation as a new field would leave an older
station with the access. An operator is in the feed only while active: a
deactivation writes a tombstone for its id, and a reactivation drops the
tombstone and sends the record again with a new `rev`. A badge is in the
feed only while not revoked: a revocation writes a tombstone, and a revoked
```

заменить на

<!-- prettier-ignore -->
```text
`feed::remove` and `feed::restore` for both.

A change that removes access rides the feed as a tombstone, never as a
flag. The records that grant access — `site`, `operators` and
`operator_badges` — are read with `z.strictObject` and format checks (a
personnel number of 3–12 digits; `isPinPhc` and `isBadgePhc` in
`src/lib/credentials.ts`): a record with an unknown key, or with a hash no
station could use, fails closed into the quarantine rather than being kept,
so a field a newer host adds never just drops away on an older station.
`org_profile` and `lines` are read with `z.object`, which drops unknown
keys. An operator is in the feed only while active: a
deactivation writes a tombstone for its id, and a reactivation drops the
tombstone and sends the record again with a new `rev`. A badge is in the
feed only while not revoked: a revocation writes a tombstone, and a revoked
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
same badge through its own layout, so a code in Cyrillic is refused with a
hint to switch the layout, never read by key position.

## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
```

заменить на

<!-- prettier-ignore -->
```text
same badge through its own layout, so a code in Cyrillic is refused with a
hint to switch the layout, never read by key position.

A station keeps its copies in `ref_operators` and `ref_operator_badges`
(`src-tauri/migrations/0003_operators_badges.sql`), with no foreign key from
a badge to its operator — the feed keeps the badge of an operator who was
turned off, and a badge can come in a page before its operator — and no
uniqueness besides the key: the host keeps personnel numbers and active
badges unique, and a copy that refused a row would abort its whole page and
stop the sync for good. Rules for the station's sign-in (plan 1f): it reads
these copies only on the floor screen of a paired device that is not
rejected. The hashes already on disk stay when the host revokes the device
or its certificate changes, and only a forget clears them, so such a device
must keep showing no floor, as `nextShellView` does today: the
rejected-device screen comes first. A badge is found by hashing the trimmed scan with
`ref_site.badge_salt` and comparing whole strings, and it signs in only
with the record of its `operatorId`; a badge that matches more than one
active operator is refused as ambiguous, never resolved to the first.

## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
the quarantine; so does a build that reads the record, since it syncs
from zero. `reason` holds Zod issue paths and codes only
(`archived: invalid_type`, at most 200 characters), never a value:
operator records will carry PIN and badge hashes. `seen_at` is a
parameter from the webview's clock, never SQL time. Entities this build
does not keep are skipped, not quarantined, and applying a page again
changes nothing. A successful run reports the quarantine's size
```

заменить на

<!-- prettier-ignore -->
```text
the quarantine; so does a build that reads the record, since it syncs
from zero. `reason` holds Zod issue paths and codes only
(`archived: invalid_type`, at most 200 characters), never a value:
operator records carry PIN and badge hashes. That is safe only because
every record schema has fixed keys: a schema with a dynamic-key `z.record`
would put keys taken from the data into the paths. `seen_at` is a
parameter from the webview's clock, never SQL time. Entities this build
does not keep are skipped, not quarantined, and applying a page again
changes nothing. A successful run reports the quarantine's size
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 15 today and 21 with plan 1d4's operators and badges, within the
shell's 32 (E = 8 at most); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines;v2"`): raise the version whenever a record
schema or the meaning of a copy table changes, so every device syncs
from zero once and gets back what an older build quarantined or kept
differently.
The copies, and the quarantine with them, start from zero when `host_id`
names another host, when
`entity_set` is not this build's `ENTITY_SET`, or when the feed answers
```

заменить на

<!-- prettier-ignore -->
```text
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 21 for the five entities kept today, within the shell's 32 (E = 8 at
most, 30 statements); a test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines,operators,operator_badges;v3"`): raise the
version whenever a record schema or the meaning of a copy table changes,
so every device syncs from zero once and gets back what an older build
quarantined or kept differently.
The upserts of operators and badges also skip a record whose newer
revision waits in the quarantine (`notQuarantinedNewer`): the insert would
otherwise bring back what the quarantine's fail-closed delete took away.
The feed never sends an older revision after a newer one, but a stale run
can: a page fetched before `device_forget` that lands only after a new
pairing with the same host has stamped `host_id` again. `hostGuard` (below)
stops such a page until that stamp, not after it. The same late page can
still put back a record the new run deleted by tombstone, and it moves
`last_rev` back to its own revision, so the next sync fetches that tombstone
again and deletes the record anew.
The copies, and the quarantine with them, start from zero when `host_id`
names another host, when
`entity_set` is not this build's `ENTITY_SET`, or when the feed answers
```

5. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
свою схему (§5.4).

План 1c создаёт `ref_org`, `ref_site`, `ref_lines` и `sync_state`, план 1d1 —
`sync_quarantine`; таблицы операторов, бейджей, товаров и шаблонов добавляют
планы 1d и 1e вместе со своими сущностями ленты.

### 5.4. Синхронизация справочников
```

заменить на

<!-- prettier-ignore -->
```text
свою схему (§5.4).

План 1c создаёт `ref_org`, `ref_site`, `ref_lines` и `sync_state`, план 1d1 —
`sync_quarantine`, план 1d4 — `ref_operators` и `ref_operator_badges`: без
внешнего ключа от бейджа к оператору (лента присылает бейдж выключенного
оператора, а бейдж может прийти раньше своего оператора) и без уникальности,
кроме ключа. Таблицы товаров и шаблонов добавит план 1e вместе со своими
сущностями ленты.

### 5.4. Синхронизация справочников
```

6. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  схемы, без значений. Запись выходит из карантина, когда хост меняет её снова
  (читаемая запись или удаление с ревизией не меньше) или когда сборка, которая её
  понимает, синхронизируется с нуля;
- сохранённый набор сущностей (`entity_set`) несёт и версию схемы записей
  (`org_profile,site,lines;v2`): смена схемы записи или смысла таблицы копий
  поднимает версию, и каждое устройство один раз синхронизируется с нуля;
- копии и карантин начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
  сразу: записи чужого хоста не должны оставаться в работе), если сохранённый набор
  сущностей (`entity_set`) не совпадает с набором этой сборки или если лента ответила
```

заменить на

<!-- prettier-ignore -->
```text
  схемы, без значений. Запись выходит из карантина, когда хост меняет её снова
  (читаемая запись или удаление с ревизией не меньше) или когда сборка, которая её
  понимает, синхронизируется с нуля;
- записи, которые дают доступ (`site`, `operators`, `operator_badges`),
  читаются строго: незнакомое поле, табельный номер не из 3–12 цифр или хеш,
  которым станция не сможет воспользоваться (у PIN 10 000–1 000 000 итераций,
  у бейджа ровно 100 000, число записано так, как пишет хост), уводят запись в
  карантин. Upsert операторов и бейджей не возвращает старую ревизию записи,
  более новая ревизия которой ждёт в карантине;
- сохранённый набор сущностей (`entity_set`) несёт и версию схемы записей
  (`org_profile,site,lines,operators,operator_badges;v3`): смена схемы записи
  или смысла таблицы копий поднимает версию, и каждое устройство один раз
  синхронизируется с нуля;
- копии и карантин начинаются с нуля, если `sync_state.host_id` называет другой хост (очистка
  сразу: записи чужого хоста не должны оставаться в работе), если сохранённый набор
  сущностей (`entity_set`) не совпадает с набором этой сборки или если лента ответила
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`; вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline > /tmp/claude/1d4-cargo.log 2>&1`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/src/lib/credentials.ts apps/standalone/src/host/protocol.ts apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/credentials.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 36 файлов, 719 тестов; cargo — 36 наборов, 346 тестов, без предупреждений компилятора.

```bash
git add apps/standalone/src-tauri/migrations/0003_operators_badges.sql apps/standalone/src/lib/credentials.ts apps/standalone/src/host/protocol.ts apps/standalone/src/local/reference-sync.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/credentials.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/src-tauri/tests/local_db.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): копии операторов и бейджей на станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Следы хешей на диске и сброс без открытой базы — `src-tauri`

Хеши PIN и бейджей теперь лежат в локальной базе, поэтому сброс подключения (`device_forget`) не должен оставлять их на диске.

- **Писатель с `secure_delete`**: удалённая строка обнуляется на своём месте, а не просто отвязывается (`SqliteConnectOptions::pragma("secure_delete", "ON")`).
- **`wal_checkpoint(TRUNCATE)` после `clear_copies`**: переносит обнулённые страницы в файл и опустошает WAL, где остались кадры, записанные до удаления. Если читатель держит старый снимок и контрольная точка не завершается за время ожидания (`busy` = 1), очистка целиком не удалась — `device_forget` отвечает `storage`, подключение остаётся для новой попытки. `VACUUM` не нужен (Global Constraints).
- **Сброс, когда база не открылась.** Сейчас `device_forget` в этом случае ничего не чистит и сбрасывает подключение, хотя файл может хранить хеши. Теперь `LocalDbState` помнит свой каталог, и `remove_unopened` удаляет `standalone-station.db` с файлами `-wal`, `-shm` и `-journal`: каждый — по возможности, затем проверка всех четырёх; оставшийся файл — ошибка, `device_forget` отвечает `storage`, `device.json` остаётся (как при неудачной очистке открытой базы). `LocalDbState::unavailable()` — оболочка без базы и без каталога — остаётся для тестов IPC, которым база не нужна.

Тест следов пишет две метки в `ref_operator_badges`: одну переносит контрольной точкой в файл до очистки, другая остаётся только в WAL. После `clear_copies` ни одной нет ни в файле, ни в WAL; без `secure_delete` или без контрольной точки тест падает.

Прежний тест `ipc.rs` `forgetting_the_device_without_a_local_database_still_forgets`, чей комментарий откладывал это решение до плана 1d4, заменяется двумя: неоткрывшаяся база уходит со всеми четырьмя файлами, а файл, который не удалить, оставляет подключение для новой попытки. Тест очистки открытой базы получает проверку, что её файл остался: открытая база очищается, а не удаляется.

**Files:**

- Modify: `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Modify (тесты): `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2)

**Interfaces:**

- Consumes: `LocalDb::clear_copies`, `LocalDbState::open/get`, `FILE_NAME` — `src-tauri/src/local_db.rs`; таблица `ref_operator_badges` — задача 6.
- Produces: `LocalDbState { db: Option<LocalDb>, dir: Option<PathBuf> }`, `LocalDbState::remove_unopened(&self) -> std::io::Result<()>`; `LocalDb::clear_copies` завершает `wal_checkpoint(TRUNCATE)`; команда `device_forget` удаляет неоткрывшуюся базу.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/src-tauri/tests/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    );
}

/// An FTS5 virtual table's shadow tables (`search_data`, `search_idx`, …)
/// hold its index; `sqlite_master` lists them as ordinary tables, but
/// deleting their rows directly — instead of through the virtual table —
```

заменить на

<!-- prettier-ignore -->
```rust
    );
}

/// Whether the file at `path` holds `marker` anywhere; a missing file holds nothing.
fn file_holds(path: &std::path::Path, marker: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| {
        bytes
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    })
}

/// Forgetting a device leaves none of its PIN and badge hashes on disk:
/// `secure_delete` zeroes a deleted row where it stood, and the checkpoint
/// after `clear_copies` moves those pages into the file and empties the WAL,
/// which still held the frames written before the delete. One marker is
/// checkpointed into the file before the clear, the other is only in the WAL.
#[tokio::test]
async fn clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal() {
    const IN_FILE: &str = "pbkdf2$sha256$100000$marker-in-the-database-file";
    const IN_WAL: &str = "pbkdf2$sha256$100000$marker-only-in-the-wal";
    const BADGE: &str = "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) \
        VALUES (?, 'operator-1', ?, NULL, 1)";
    let (dir, db) = open().await;
    let file = dir.path().join(FILE_NAME);
    let wal = dir.path().join(format!("{FILE_NAME}-wal"));
    db.transaction(vec![statement(BADGE, json!(["badge-1", IN_FILE]))])
        .await
        .unwrap();
    let mut raw = SqliteConnectOptions::new()
        .filename(&file)
        .connect()
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
    db.transaction(vec![statement(BADGE, json!(["badge-2", IN_WAL]))])
        .await
        .unwrap();
    assert!(
        file_holds(&file, IN_FILE),
        "the first marker is in the file"
    );
    assert!(file_holds(&wal, IN_WAL), "the second marker is in the WAL");

    assert_eq!(db.clear_copies().await, Ok(()));

    for marker in [IN_FILE, IN_WAL] {
        assert!(!file_holds(&file, marker), "{marker} stayed in the file");
        assert!(!file_holds(&wal, marker), "{marker} stayed in the WAL");
    }
}

/// An FTS5 virtual table's shadow tables (`search_data`, `search_idx`, …)
/// hold its index; `sqlite_master` lists them as ordinary tables, but
/// deleting their rows directly — instead of through the virtual table —
```

2. В `apps/standalone/src-tauri/tests/ipc.rs`, фрагмент

<!-- prettier-ignore -->
```rust
    );
    assert!(!config.exists());
    assert_eq!(copies(), json!([{ "n": 0 }]));
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
}

/// Without a local database (it never opened) there is nothing this app can
/// clear: `device_forget` still removes `device.json` on its own. This test
/// needs no host, so it runs in the sandbox — so does the test above, which
/// also uses an unreadable config and no host, but opens a working local
/// database with copies to clear instead of leaving it unopened. Plan 1d4
/// revisits this decision before PIN and badge hashes live in the local
/// database.
#[test]
fn forgetting_the_device_without_a_local_database_still_forgets() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    device_config::save(
        app_dir.path(),
        &DeviceConfig {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
```

заменить на

<!-- prettier-ignore -->
```rust
    );
    assert!(!config.exists());
    assert_eq!(copies(), json!([{ "n": 0 }]));
    assert!(
        app_dir.path().join(FILE_NAME).exists(),
        "an open database is cleared, not removed"
    );
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
}

/// A pairing on disk that the app can read, for tests that need no host.
fn save_pairing(dir: &std::path::Path) {
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
```

3. В `apps/standalone/src-tauri/tests/ipc.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        },
    )
    .unwrap();
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
```

заменить на

<!-- prettier-ignore -->
```rust
        },
    )
    .unwrap();
}

/// The database file and the files SQLite keeps beside it.
fn database_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    ["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| dir.join(format!("{FILE_NAME}{suffix}")))
        .collect()
}

/// A local database that did not open (here, files of garbage) may still
/// hold PIN and badge hashes: `device_forget` removes it with its `-wal`,
/// `-shm` and `-journal` files before it removes `device.json`. Like the
/// test above, this one needs no host and runs in the sandbox.
#[test]
fn forgetting_the_device_removes_a_local_database_that_did_not_open() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let files = database_files(app_dir.path());
    for file in &files {
        std::fs::write(file, "not a database").unwrap();
    }
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err(), "a file of garbage does not open");
    // SQLite deletes a stray `-shm` and `-journal` while it fails to open the
    // file; they come back here as files a crash could leave, so the forget
    // has all four to remove.
    for file in &files {
        std::fs::write(file, "not a database").unwrap();
    }
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    for file in &files {
        assert!(!file.exists(), "{} is still there", file.display());
    }
}

/// A database file that cannot be removed fails the forget with `storage`,
/// and `device.json` stays for another try, as when clearing an open
/// database fails. A directory in place of the WAL stands for a file that is
/// locked or not the app's to remove.
#[test]
fn forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let file = app_dir.path().join(FILE_NAME);
    std::fs::write(&file, "not a database").unwrap();
    let stuck = app_dir.path().join(format!("{FILE_NAME}-wal"));
    std::fs::create_dir(&stuck).unwrap();
    std::fs::write(stuck.join("kept"), "kept").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err(), "a file of garbage does not open");
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("storage"))
    );
    assert!(config.exists(), "the pairing stays for another try");
    assert!(!file.exists(), "what could go is gone");

    std::fs::remove_dir_all(&stuck).unwrap();
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device`
Expected: FAIL:

- `local_db`: 1 из 3 — `clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal`: `pbkdf2$sha256$100000$marker-in-the-database-file stayed in the file`;
- `ipc`: 2 из 3 — `forgetting_the_device_removes_a_local_database_that_did_not_open`: `…/standalone-station.db is still there`; `forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays`: `left: Ok(Null)`, `right: Err(String("storage"))`.

- [ ] **Step 3: `secure_delete`, контрольная точка и удаление неоткрывшейся базы**

1. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
//! A large reference page goes in as one JSON parameter per entity
//! (`json_each`), so the limits bound SQL, not rows.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
```

заменить на

<!-- prettier-ignore -->
```rust
//! A large reference page goes in as one JSON parameter per entity
//! (`json_each`), so the limits bound SQL, not rows.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
```

2. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
use sqlx::{Column, Row, Sqlite, TypeInfo, ValueRef};

pub const FILE_NAME: &str = "standalone-station.db";
/// `MAX_STATEMENTS`, `MAX_SQL_BYTES` and `MAX_VALUES` here, and
/// `FORBIDDEN_WORDS` below, are mirrored for tests in
/// `apps/standalone/test/support/local-db.ts`. A rule change here updates
```

заменить на

<!-- prettier-ignore -->
```rust
use sqlx::{Column, Row, Sqlite, TypeInfo, ValueRef};

pub const FILE_NAME: &str = "standalone-station.db";
/// The files SQLite keeps beside [`FILE_NAME`]: the database itself, its WAL,
/// the WAL's shared-memory index and a rollback journal.
const FILE_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];
/// `MAX_STATEMENTS`, `MAX_SQL_BYTES` and `MAX_VALUES` here, and
/// `FORBIDDEN_WORDS` below, are mirrored for tests in
/// `apps/standalone/test/support/local-db.ts`. A rule change here updates
```

3. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
                    .journal_mode(SqliteJournalMode::Wal)
                    .synchronous(SqliteSynchronous::Full)
                    .foreign_keys(true)
                    .busy_timeout(BUSY_TIMEOUT),
            )
            .await?;
        MIGRATOR.run(&writer).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
                    .journal_mode(SqliteJournalMode::Wal)
                    .synchronous(SqliteSynchronous::Full)
                    .foreign_keys(true)
                    .busy_timeout(BUSY_TIMEOUT)
                    // A deleted row is zeroed where it stood, not merely
                    // unlinked: the copies hold PIN and badge hashes.
                    .pragma("secure_delete", "ON"),
            )
            .await?;
        MIGRATOR.run(&writer).await?;
```

4. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust

    /// Delete every row of every table but sqlx's migration journal, in one
    /// writer transaction: forgetting the device must not leave another
    /// pairing's copies behind (from plan 1d4 on, PIN and badge hashes).
    /// Every table here is treated as a disposable copy of the host's data;
    /// the first plan that adds data this device owns instead of a copy —
    /// the scan journal, boxes, the outbox (the station design's §6.2,
```

заменить на

<!-- prettier-ignore -->
```rust

    /// Delete every row of every table but sqlx's migration journal, in one
    /// writer transaction: forgetting the device must not leave another
    /// pairing's copies behind, PIN and badge hashes included. The writer
    /// zeroes deleted rows (`secure_delete`), and a checkpoint that truncates
    /// the WAL follows the commit: it moves the zeroed pages into the file
    /// and empties the WAL, which still held the frames written before the
    /// delete. A reader holding an older snapshot keeps it from finishing
    /// within the busy timeout, and then this fails as a whole. `VACUUM` is
    /// not needed: it would only shrink the file.
    /// Every table here is treated as a disposable copy of the host's data;
    /// the first plan that adds data this device owns instead of a copy —
    /// the scan journal, boxes, the outbox (the station design's §6.2,
```

5. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

<!-- prettier-ignore -->
```rust
                .await
                .map_err(|_| LocalDbError::StatementFailed)?;
        }
        tx.commit().await.map_err(|_| LocalDbError::StatementFailed)
    }
}

/// Tauri state: the local database, or `None` when it could not be opened.
/// The app still starts — the office works without it — and the local
/// commands answer `local_db_unavailable`.
pub struct LocalDbState(Option<LocalDb>);

impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        Self(LocalDb::open(dir).await.ok())
    }

    pub fn unavailable() -> Self {
        Self(None)
    }

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.0.as_ref().ok_or(LocalDbError::Unavailable)
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
                .await
                .map_err(|_| LocalDbError::StatementFailed)?;
        }
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&self.writer)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        if busy == 0 {
            Ok(())
        } else {
            Err(LocalDbError::StatementFailed)
        }
    }
}

/// Tauri state: the local database, or none when it could not be opened.
/// The app still starts — the office works without it — and the local
/// commands answer `local_db_unavailable`.
pub struct LocalDbState {
    db: Option<LocalDb>,
    /// Where `open` looked for the database; `None` for a shell with no
    /// local database at all (`unavailable`).
    dir: Option<PathBuf>,
}

impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        Self {
            db: LocalDb::open(dir).await.ok(),
            dir: Some(dir.to_path_buf()),
        }
    }

    /// A shell with no local database and no directory for one, as the IPC
    /// tests that need neither use.
    pub fn unavailable() -> Self {
        Self {
            db: None,
            dir: None,
        }
    }

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.db.as_ref().ok_or(LocalDbError::Unavailable)
    }

    /// Remove the database `open` could not open, with its `-wal`, `-shm`
    /// and `-journal` files: it may still hold PIN and badge hashes, and
    /// forgetting the device must not leave them behind. Each file goes on a
    /// best-effort basis, then all four are checked again, and one still
    /// there fails the call. Does nothing for an open database, which
    /// [`LocalDb::clear_copies`] empties instead, or without a directory.
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

6. В `apps/standalone/src-tauri/src/lib.rs`, фрагмент

<!-- prettier-ignore -->
```rust
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first, so when clearing them
/// fails the command answers `storage` and `device.json` stays for another
/// try. Without a local database (it did not open) there is nothing this
/// app can clear, and forgetting goes on: the reset must stay possible.
#[tauri::command]
async fn device_forget(
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
) -> Result<(), String> {
    if let Ok(db) = local.get() {
        db.clear_copies()
            .await
            .map_err(|_| DeviceError::Storage.code().to_owned())?;
    }
    state
        .forget()
```

заменить на

<!-- prettier-ignore -->
```rust
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first. An open local database is
/// cleared (`LocalDb::clear_copies`); one that did not open is removed with
/// its `-wal`, `-shm` and `-journal` files (`LocalDbState::remove_unopened`),
/// since it may still hold PIN and badge hashes. When either fails, the
/// command answers `storage` and `device.json` stays for another try.
#[tauri::command]
async fn device_forget(
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
) -> Result<(), String> {
    let cleared = match local.get() {
        Ok(db) => db.clear_copies().await.is_ok(),
        Err(_) => local.remove_unopened().is_ok(),
    };
    if !cleared {
        return Err(DeviceError::Storage.code().to_owned());
    }
    state
        .forget()
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: те же команды cargo, что в шаге 2.
Expected: PASS — 3 и 3 теста.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src-tauri/src/local_db.rs` убрать `secure_delete`: фрагмент

<!-- prettier-ignore -->
```rust
                    .busy_timeout(BUSY_TIMEOUT)
                    // A deleted row is zeroed where it stood, not merely
                    // unlinked: the copies hold PIN and badge hashes.
                    .pragma("secure_delete", "ON"),
```

заменить на

<!-- prettier-ignore -->
```rust
                    .busy_timeout(BUSY_TIMEOUT),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies_leaves_no_deleted_hash`
Expected: FAIL — `pbkdf2$sha256$100000$marker-in-the-database-file stayed in the file`.

Мутация 2. В `apps/standalone/src-tauri/src/local_db.rs` убрать контрольную точку: фрагмент

<!-- prettier-ignore -->
```rust
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&self.writer)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        if busy == 0 {
            Ok(())
        } else {
            Err(LocalDbError::StatementFailed)
        }
```

заменить на

<!-- prettier-ignore -->
```rust
        tx.commit().await.map_err(|_| LocalDbError::StatementFailed)
```

Run: та же команда, что у мутации 1.
Expected: FAIL — то же сообщение: метка, перенесённая в файл до очистки, осталась в файле.

Мутация 3. В `apps/standalone/src-tauri/src/local_db.rs` не проверять, что файлы ушли: фрагмент

<!-- prettier-ignore -->
```rust
        match files.iter().find(|file| file.symlink_metadata().is_ok()) {
            Some(file) => Err(std::io::Error::other(format!(
                "{} is still there",
                file.display()
            ))),
            None => Ok(()),
        }
```

заменить на

<!-- prettier-ignore -->
```rust
        Ok(())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device_keeps`
Expected: FAIL — `left: Ok(Null)`, `right: Err(String("storage"))`.

Мутация 4. В `apps/standalone/src-tauri/src/lib.rs` вернуть прежний сброс без удаления: фрагмент

<!-- prettier-ignore -->
```rust
        Err(_) => local.remove_unopened().is_ok(),
```

заменить на

<!-- prettier-ignore -->
```rust
        Err(_) => true,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device_removes`
Expected: FAIL — `…/standalone-station.db is still there`.

- [ ] **Step 6: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
`_sqlx_migrations`, in one writer transaction with foreign keys checked at
the commit. The tables come from `pragma_table_list` (`type IN ('table',
'virtual')`), so one a later migration adds is covered, PIN and badge hashes
included. Every table here is treated as a disposable copy of the host's
data: the first plan that adds data this device owns instead of copies —
the scan journal, boxes, the outbox (the design's §6.2, "Логическая модель")
— must exclude those tables from `clear_copies` and block or confirm a forget while unsynced
records exist, not extend this list silently. If clearing fails, the
command fails with `storage` and the pairing stays for another try; without
a local database (it did not open) there is nothing this app can clear, and
forgetting goes on; plan 1d4 revisits this before PIN and badge hashes land.

## Writes
```

заменить на

<!-- prettier-ignore -->
```text
`_sqlx_migrations`, in one writer transaction with foreign keys checked at
the commit. The tables come from `pragma_table_list` (`type IN ('table',
'virtual')`), so one a later migration adds is covered, PIN and badge hashes
included (`ref_operators`, `ref_operator_badges`). The writer runs with
`secure_delete`, so a deleted row is zeroed where it stood, and the clear
ends with `wal_checkpoint(TRUNCATE)`, which moves those pages into the file
and empties the WAL that still held the frames written before the delete:
no hash of the old pairing stays in either file (`VACUUM` would only shrink
the file). A reader holding an older snapshot keeps the checkpoint from
finishing, and the clear then fails as a whole. A local database that did
not open is removed instead, with its `-wal`, `-shm` and `-journal` files
(`LocalDbState::remove_unopened`), since it may still hold hashes. Every
table here is treated as a disposable copy of the host's data: the first
plan that adds data this device owns instead of copies — the scan journal,
boxes, the outbox (the design's §6.2, "Логическая модель") — must exclude
those tables from `clear_copies`, keep `remove_unopened` from deleting
them, and block or confirm a forget while unsynced records exist, not
extend this list silently. If clearing or removing fails, the command fails
with `storage` and the pairing stays for another try.

## Writes
```

2. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  `device.json`), `device_refresh()` (перечитывает `GET /v1/device` и сохраняет
  линию, назначенную или снятую в офисе, §5.1; без связи ничего не меняет),
  `device_forget()` (сначала очищает локальную базу — все таблицы,
  кроме журнала миграций; если очистка не удалась, подключение остаётся; если
  локальная база не открылась, для этого приложения очищать нечего — план 1d4
  пересмотрит это до того, как хеши PIN и бейджей лягут в локальную базу). Таймауты:
  соединение 2 с,
  запрос 10 с. `host_request` пропускает только маршруты `/v1/device[/…]` (кроме
  `/v1/device/line`), `/v1/bootstrap`, `/v1/changes` (без `/stream`) и
```

заменить на

<!-- prettier-ignore -->
```text
  `device.json`), `device_refresh()` (перечитывает `GET /v1/device` и сохраняет
  линию, назначенную или снятую в офисе, §5.1; без связи ничего не меняет),
  `device_forget()` (сначала очищает локальную базу — все таблицы,
  кроме журнала миграций; писатель работает с `secure_delete`, а после очистки
  идёт `wal_checkpoint(TRUNCATE)`, и удалённые хеши PIN и бейджей не остаются
  ни в файле, ни в WAL; локальную базу, которая не открылась, удаляет вместе с
  файлами `-wal`, `-shm` и `-journal`; если очистка или удаление не удались,
  подключение остаётся). Таймауты:
  соединение 2 с,
  запрос 10 с. `host_request` пропускает только маршруты `/v1/device[/…]` (кроме
  `/v1/device/line`), `/v1/bootstrap`, `/v1/changes` (без `/stream`) и
```

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`; вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline > /tmp/claude/1d4-cargo.log 2>&1`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`
Expected: всё зелёное; cargo — 36 наборов, 348 тестов, без предупреждений компилятора.

```bash
git add apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "fix(standalone): сброс подключения не оставляет хешей на диске" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: «Этот ПК» в «Устройствах», одно объявление сбоя на экране выбора линии, сверка документов

- **Свой ПК.** `Office` не знает id устройства, на котором он открыт. `App` берёт его из статуса подключения (`DeviceStatus.deviceId`) и передаёт в `Office`, а тот — страницам через `ThisDeviceProvider` (`src/office/this-device.tsx`). В «Устройствах» строка этого ПК помечена словами «Этот ПК», а его отзыв спрашивает строже: приложение на этом ПК отключится от хоста, и его нужно будет подключить заново. Запрета нет: хост отвергнет ключ, и оболочка покажет прежний экран отказа.
- **Одно объявление сбоя.** Предупреждение экрана выбора линии — `Alert` с `role="alert"`. Автоповтор синхронизации менял его на индикатор загрузки и обратно, и экранный диктор заново объявлял тот же сбой через 2, 4, 8… секунд. Теперь сбой синхронизации держит предупреждение на экране, пока синхронизация не удастся, а идущий прогон показывает кнопка «Повторить» (`loading`). Строка связи в шапке офиса и в цехе и так держит сбой через повтор (`sync_started` его не сбрасывает).
- **Сверка документов.** Разделы `AGENTS.md`, которые правил план, и §4.6, §5.2–§5.5 спецификации перечитываются целиком: каждое изменённое предложение говорит, что делает код.

**Files:**

- Create: `apps/standalone/src/office/this-device.tsx`
- Modify: `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`, `apps/standalone/src/app/LineSelect.tsx`, `apps/standalone/src/i18n/ru.json`
- Modify (тесты): `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/test/line-select.test.tsx`, `apps/standalone/test/app.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes: `DeviceStatus.deviceId` — `src/host/protocol.ts`; `SyncState.failure` (держится через повтор) — `src/app/shell.ts`.
- Produces: `OfficeProps.deviceId?: string | null`, `ThisDeviceProvider({ deviceId, children })`, `useThisDeviceId(): string | null`, `RevokeDeviceDialogProps.own: boolean`; ключи `office.devices.thisDevice`, `office.devices.revokeOwnTitle`, `office.devices.revokeOwnBody`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/devices-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    );
    expect(within(rowOf("Станция упаковки")).queryByRole("button")).toBeNull();
    expect(session.api.listDevices.mock.calls.length).toBe(reads + 1);
  });

  it("explains a revocation the host refused, in the dialog", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
    );
    expect(within(rowOf("Станция упаковки")).queryByRole("button")).toBeNull();
    expect(session.api.listDevices.mock.calls.length).toBe(reads + 1);
  });

  it("marks this PC's row in words and asks more before this PC revokes itself", async () => {
    const session = adminSession();
    session.api.revokeDevice.mockResolvedValue({ ...HOST_PC, revokedAt: "2026-09-28T10:00:00Z" });
    renderOffice(session, { deviceId: HOST_PC.id });
    fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
    await screen.findByText("Рабочее место хоста");
    expect(within(rowOf("Рабочее место хоста")).getByText("Этот ПК")).toBeTruthy();
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
    // Another device: the usual confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Отозвать устройство «Станция упаковки»" }));
    expect(within(dialog()).getByText("Отозвать устройство?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    // This PC: the app here disconnects and has to be paired again. Nothing stops it.
    fireEvent.click(
      screen.getByRole("button", { name: "Отозвать устройство «Рабочее место хоста»" }),
    );
    expect(within(dialog()).getByText("Отозвать этот ПК?")).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "«Рабочее место хоста» — этот ПК, на нём открыт офис. После отзыва приложение здесь отключится от хоста, а чтобы снова работать на этом ПК, его нужно подключить заново. Отменить отзыв нельзя.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Устройство «Рабочее место хоста» отозвано.")).toBeTruthy();
    expect(session.api.revokeDevice.mock.calls).toStrictEqual([
      ["office-session-token", HOST_PC.id],
    ]);
  });

  it("explains a revocation the host refused, in the dialog", async () => {
```

2. В `apps/standalone/test/line-select.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import type { DatabaseSync } from "node:sqlite";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LineSelect, type LineSelectProps } from "../src/app/LineSelect.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { DatabaseSync } from "node:sqlite";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LineSelect, type LineSelectProps } from "../src/app/LineSelect.js";
```

3. В `apps/standalone/test/line-select.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("shows no failure line while a retry runs with no lines listed yet", () => {
    renderLineSelect(
      { kind: "running", synced: 0, failure: "host", quarantined: 0 },
      { link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 } },
    );
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("shows the failure line once lines are already listed, since nothing else reports it", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("keeps the failure's own alert, and no second failure line, while a retry runs with no lines listed yet", () => {
    renderLineSelect(
      { kind: "running", synced: 0, failure: "host", quarantined: 0 },
      { link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 } },
    );
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    expect(screen.queryByText("Получаем справочники с хоста…")).toBeNull();
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("announces a failed sync once: its alert stays mounted through the automatic retries", () => {
    const failed: SyncState = { kind: "failed", synced: 0, failure: "host", quarantined: 0 };
    const { props, view } = renderLineSelect(failed);
    const alert = screen.getByRole("alert");
    // The retry's run shows on the button instead of a spinner in the alert's place.
    view.rerender(<LineSelect {...props} sync={{ ...failed, kind: "running" }} />);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(within(alert).getByRole("button", { name: "Повторить" })).toHaveProperty(
      "disabled",
      true,
    );
    view.rerender(<LineSelect {...props} sync={failed} />);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(within(alert).getByRole("button", { name: "Повторить" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("shows the failure line once lines are already listed, since nothing else reports it", async () => {
```

4. В `apps/standalone/test/app.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
```

5. В `apps/standalone/test/app.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(device.refresh).toHaveBeenCalledTimes(1);
  });
});
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(device.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the office on this device", () => {
  it("tells the office which device it runs on, so «Устройства» marks this PC", async () => {
    const host = fakeHost();
    host.listDevices.mockResolvedValue([
      {
        id: DEVICE_STATUS.deviceId,
        kind: "station",
        name: "Рабочее место хоста",
        lineId: LINE_ID,
        appVersion: "0.1.0",
        pairedAt: "2026-09-26T09:15:00Z",
        lastSeenAt: null,
        revokedAt: null,
      },
      {
        id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
        kind: "station",
        name: "Станция упаковки",
        lineId: null,
        appVersion: "0.1.0",
        pairedAt: "2026-09-26T09:30:00Z",
        lastSeenAt: null,
        revokedAt: null,
      },
    ]);
    host.listLines.mockResolvedValue([]);
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
    const row = (await screen.findByText("Рабочее место хоста")).closest("tr");
    if (!row) throw new Error("no row for this PC");
    expect(within(row).getByText("Этот ПК")).toBeTruthy();
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/line-select.test.tsx test/app.test.tsx`
Expected: FAIL — 4 теста из 116:

- `devices-page.test.tsx` «marks this PC's row in words and asks more before this PC revokes itself» и `app.test.tsx` «tells the office which device it runs on…»: `Unable to find an element with the text: Этот ПК`;
- `line-select.test.tsx` «keeps the failure's own alert…»: `Unable to find an element with the text: Не удалось получить справочники с хоста.`; «announces a failed sync once…»: `Unable to find an accessible element with the role "alert"`.

- [ ] **Step 3: Id этого ПК в офисе, подтверждение, предупреждение и тексты**

1. Create `apps/standalone/src/office/this-device.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

/** The id of the device the office runs on (`DeviceStatus.deviceId`); `null` when unknown. */
const ThisDeviceContext = createContext<string | null>(null);

export function ThisDeviceProvider({
  deviceId,
  children,
}: {
  deviceId: string | null;
  children: ReactNode;
}) {
  return <ThisDeviceContext.Provider value={deviceId}>{children}</ThisDeviceContext.Provider>;
}

/** This PC's device id, so «Устройства» can mark its row and warn before it revokes itself. */
export function useThisDeviceId(): string | null {
  return useContext(ThisDeviceContext);
}
```

2. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
```

заменить на

<!-- prettier-ignore -->
```tsx
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";
import { ThisDeviceProvider } from "./this-device.js";

export interface OfficeProps {
  session: OfficeSessionValue;
```

3. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
   * shows without a new sign-in. Open pages are not reloaded under the user.
   */
  hostRevision?: number | null;
}

/**
```

заменить на

<!-- prettier-ignore -->
```tsx
   * shows without a new sign-in. Open pages are not reloaded under the user.
   */
  hostRevision?: number | null;
  /**
   * The device this office runs on (`DeviceStatus.deviceId`): «Устройства»
   * marks its row and asks more before it revokes itself. `null` outside
   * the app.
   */
  deviceId?: string | null;
}

/**
```

4. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({ session, link = null, sync = null, hostRevision = null }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
```

заменить на

<!-- prettier-ignore -->
```tsx
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({
  session,
  link = null,
  sync = null,
  hostRevision = null,
  deviceId = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  const shownRevision = useRef(hostRevision);
```

5. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <OfficeLinkProvider value={officeLink}>
          <RouterProvider router={router} />
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <OfficeLinkProvider value={officeLink}>
          <ThisDeviceProvider deviceId={deviceId}>
            <RouterProvider router={router} />
          </ThisDeviceProvider>
        </OfficeLinkProvider>
      </OfficeSessionProvider>
    </QueryClientProvider>
```

6. В `apps/standalone/src/app/App.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        link={state.link}
        sync={state.sync}
        hostRevision={state.hostRevision}
      />
    );
  }
```

заменить на

<!-- prettier-ignore -->
```tsx
        link={state.link}
        sync={state.sync}
        hostRevision={state.hostRevision}
        deviceId={pairedStatus?.deviceId ?? null}
      />
    );
  }
```

7. В `apps/standalone/src/office/devices/DevicesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

import {
  Alert,
  Button,
  Card,
  PageHeader,
```

заменить на

<!-- prettier-ignore -->
```tsx

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
```

8. В `apps/standalone/src/office/devices/DevicesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { DeviceDialog } from "./DeviceDialog.js";
import { lineLabel } from "./line-label.js";
import { codeLifetimeMs, PairingCodeDialog } from "./PairingCodeDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { useStoreRecord } from "../records.js";
import { useThisDeviceId } from "../this-device.js";
import { DeviceDialog } from "./DeviceDialog.js";
import { lineLabel } from "./line-label.js";
import { codeLifetimeMs, PairingCodeDialog } from "./PairingCodeDialog.js";
```

9. В `apps/standalone/src/office/devices/DevicesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 */
export function DevicesPage() {
  const { t } = useTranslation();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const storeDevice = useStoreRecord<DeviceRecord>(officeKeys.devices);
```

заменить на

<!-- prettier-ignore -->
```tsx
 */
export function DevicesPage() {
  const { t } = useTranslation();
  const thisDevice = useThisDeviceId();
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const storeDevice = useStoreRecord<DeviceRecord>(officeKeys.devices);
```

10. В `apps/standalone/src/office/devices/DevicesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  };

  const columns: TableColumn<DeviceRecord>[] = [
    { key: "name", title: t("office.devices.table.name"), render: (device) => device.name },
    {
      key: "kind",
      title: t("office.devices.table.kind"),
```

заменить на

<!-- prettier-ignore -->
```tsx
  };

  const columns: TableColumn<DeviceRecord>[] = [
    {
      key: "name",
      title: t("office.devices.table.name"),
      render: (device) => (
        <>
          {device.name}
          {device.id === thisDevice && (
            <>
              {" "}
              <Badge tone="info">{t("office.devices.thisDevice")}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: "kind",
      title: t("office.devices.table.kind"),
```

11. В `apps/standalone/src/office/devices/DevicesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      {dialog?.kind === "revoke" && (
        <RevokeDeviceDialog
          device={dialog.device}
          onClose={() => setDialog(null)}
          onRevoked={(device) => {
            // The record the revoke returned goes in first: the row is dead
```

заменить на

<!-- prettier-ignore -->
```tsx
      {dialog?.kind === "revoke" && (
        <RevokeDeviceDialog
          device={dialog.device}
          own={dialog.device.id === thisDevice}
          onClose={() => setDialog(null)}
          onRevoked={(device) => {
            // The record the revoke returned goes in first: the row is dead
```

12. В `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

export interface RevokeDeviceDialogProps {
  device: DeviceRecord;
  onClose: () => void;
  onRevoked: (device: DeviceRecord) => void;
}
```

заменить на

<!-- prettier-ignore -->
```tsx

export interface RevokeDeviceDialogProps {
  device: DeviceRecord;
  /**
   * The device this office runs on: revoking it disconnects the app here,
   * which then has to be paired again. Nothing stops it; the dialog says so.
   */
  own: boolean;
  onClose: () => void;
  onRevoked: (device: DeviceRecord) => void;
}
```

13. В `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * office sessions end. There is no way back; the device pairs again as a
 * new one.
 */
export function RevokeDeviceDialog({ device, onClose, onRevoked }: RevokeDeviceDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
 * office sessions end. There is no way back; the device pairs again as a
 * new one.
 */
export function RevokeDeviceDialog({ device, own, onClose, onRevoked }: RevokeDeviceDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
```

14. В `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx

  return (
    <FormDialog
      title={t("office.devices.revokeTitle")}
      submitLabel={t("office.devices.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.devices.revokeBody", { name: device.name })}</p>
    </FormDialog>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx

  return (
    <FormDialog
      title={t(own ? "office.devices.revokeOwnTitle" : "office.devices.revokeTitle")}
      submitLabel={t("office.devices.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>
        {t(own ? "office.devices.revokeOwnBody" : "office.devices.revokeBody", {
          name: device.name,
        })}
      </p>
    </FormDialog>
  );
}
```

15. В `apps/standalone/src/app/LineSelect.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const content = () => {
    if (lines === null) {
      // The latest failure: a sync failed after the last read, or the read
      // failed after the last sync. A sync in progress, the retry's too,
      // shows progress instead of an older failure. The read failure is
      // pinned to the `sync.synced` it happened at, so a later successful
      // sync stops showing it the moment that sync finishes, not only once
      // its own (still pending) read resolves.
      const readFailed = readFailedAt === sync.synced;
      if (sync.kind === "failed" || (readFailed && sync.kind !== "running")) {
        return (
          <Alert
            tone="error"
            action={
              <Button variant="secondary" size="compact" onClick={onSync}>
                {t("shell.lineSelect.retry")}
              </Button>
            }
          >
            {t(
              sync.kind === "failed"
                ? SYNC_FAILED_KEY[sync.failure ?? "host"]
                : "shell.lineSelect.readFailed",
            )}
          </Alert>
        );
```

заменить на

<!-- prettier-ignore -->
```tsx
  const content = () => {
    if (lines === null) {
      // The latest failure: a sync failed after the last read, or the read
      // failed after the last sync. A failed sync stays on screen through
      // its automatic retries — the button shows the run in progress — until
      // a sync succeeds: the alert is a live region, and mounting it again
      // for every retry would announce the same failure every few seconds.
      // A sync in progress after a read failure shows progress instead. The
      // read failure is pinned to the `sync.synced` it happened at, so a
      // later successful sync stops showing it the moment that sync
      // finishes, not only once its own (still pending) read resolves.
      const readFailed = readFailedAt === sync.synced;
      const syncFailed = sync.kind === "failed" || sync.failure !== null;
      if (syncFailed || (readFailed && sync.kind !== "running")) {
        return (
          <Alert
            tone="error"
            action={
              <Button
                variant="secondary"
                size="compact"
                loading={sync.kind === "running"}
                onClick={onSync}
              >
                {t("shell.lineSelect.retry")}
              </Button>
            }
          >
            {t(
              syncFailed ? SYNC_FAILED_KEY[sync.failure ?? "host"] : "shell.lineSelect.readFailed",
            )}
          </Alert>
        );
```

16. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "revokeTitle": "Отозвать устройство?",
      "revokeBody": "Устройство «{{name}}» больше не сможет обращаться к хосту, его сессии офиса закроются. Отменить отзыв нельзя: чтобы снова работать на этом устройстве, подключите его заново.",
      "revokeSubmit": "Отозвать",
      "revoked": "Устройство «{{name}}» отозвано.",
      "errors": {
        "lineRejected": "Хост не принял эту линию: её могли убрать в архив. Выберите другую."
```

заменить на

<!-- prettier-ignore -->
```json
      "revokeTitle": "Отозвать устройство?",
      "revokeBody": "Устройство «{{name}}» больше не сможет обращаться к хосту, его сессии офиса закроются. Отменить отзыв нельзя: чтобы снова работать на этом устройстве, подключите его заново.",
      "revokeSubmit": "Отозвать",
      "thisDevice": "Этот ПК",
      "revokeOwnTitle": "Отозвать этот ПК?",
      "revokeOwnBody": "«{{name}}» — этот ПК, на нём открыт офис. После отзыва приложение здесь отключится от хоста, а чтобы снова работать на этом ПК, его нужно подключить заново. Отменить отзыв нельзя.",
      "revoked": "Устройство «{{name}}» отозвано.",
      "errors": {
        "lineRejected": "Хост не принял эту линию: её могли убрать в архив. Выберите другую."
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: та же команда, что в шаге 2; затем она же с `--reporter=verbose`; затем три файла под стендом с задержкой `setImmediate`.
Expected: PASS — 116 тестов (29 в `devices-page`, 21 в `line-select`, 66 в `app`); stderr verbose-прогона пуст; под стендом — 116.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Мутация 1. В `apps/standalone/src/app/App.tsx` не передавать id: фрагмент

<!-- prettier-ignore -->
```tsx
        deviceId={pairedStatus?.deviceId ?? null}
```

заменить на

<!-- prettier-ignore -->
```tsx
        deviceId={null}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "which device it runs on"`
Expected: FAIL — `Unable to find an element with the text: Этот ПК`.

Мутация 2. В `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx` один заголовок для всех: фрагмент

<!-- prettier-ignore -->
```tsx
      title={t(own ? "office.devices.revokeOwnTitle" : "office.devices.revokeTitle")}
```

заменить на

<!-- prettier-ignore -->
```tsx
      title={t("office.devices.revokeTitle")}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx -t "this PC revokes itself"`
Expected: FAIL — `Unable to find an element with the text: Отозвать этот ПК?`.

Мутация 3. В `apps/standalone/src/app/LineSelect.tsx` снова прятать сбой на время повтора: фрагмент

<!-- prettier-ignore -->
```tsx
      const syncFailed = sync.kind === "failed" || sync.failure !== null;
```

заменить на

<!-- prettier-ignore -->
```tsx
      const syncFailed = sync.kind === "failed";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/line-select.test.tsx -t "announces a failed sync once"`
Expected: FAIL — `Unable to find an accessible element with the role "alert"`.

- [ ] **Step 6: Документы и сверка**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
office header reads the sync state next to the link (`OfficeLinkProvider`).
The line screen's alert names a failed sync by its class in the same words
(its own host wording for `host`, `errors.sync.local` and `errors.sync.feed`
otherwise) and a copy it cannot read as this computer's failure. There is no
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.
```

заменить на

<!-- prettier-ignore -->
```text
office header reads the sync state next to the link (`OfficeLinkProvider`).
The line screen's alert names a failed sync by its class in the same words
(its own host wording for `host`, `errors.sync.local` and `errors.sync.feed`
otherwise) and a copy it cannot read as this computer's failure. A failed
sync's alert stays through the automatic retries, with «Повторить» showing
the run in progress, until a sync succeeds: the alert is a live region, so
a screen reader hears one failure once, not again at every retry. There is no
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`deviceUpdate`): only an active line can be chosen, and a station's
  current line stays on the list even when archived. A revoked device is a
  dead record and offers no controls; revoking asks first, names the device
  and says it cannot be undone, then the list is read again. A claim raises
  no revision, so the pairing-code dialog reads the list every 3 s
  (`DEVICE_POLL_MS`) and closes once a device paired after the code was
  created appears. «Новый код» sends the code on screen as `{ replaces }`
```

заменить на

<!-- prettier-ignore -->
```text
  (`deviceUpdate`): only an active line can be chosen, and a station's
  current line stays on the list even when archived. A revoked device is a
  dead record and offers no controls; revoking asks first, names the device
  and says it cannot be undone, then the list is read again. The row of this
  PC — the device the office runs on, whose `deviceId` `App` passes into
  `Office` (`useThisDeviceId`) — is marked «Этот ПК», and revoking it asks
  more: the app on this PC disconnects and has to be paired again. Nothing
  stops it; the host then refuses the key, and the shell shows the
  rejected-device screen. A claim raises
  no revision, so the pairing-code dialog reads the list every 3 s
  (`DEVICE_POLL_MS`) and closes once a device paired after the code was
  created appears. «Новый код» sends the code on screen as `{ replaces }`
```

3. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
    названия линий в таблице и в диалоге — из `GET /v1/office/lines` хоста;
  - отзыв спрашивает подтверждение, называет устройство и говорит, что его нельзя
    отменить; у отозванного устройства кнопок нет;
  - «Новый код» шлёт `{ replaces }` с кодом на экране (без кода на экране — без
    тела), а повторный щелчок, пока запрос идёт, ничего не отправляет; таймер
    берёт срок жизни кода у хоста (`expiresAt − createdAt`) и отсчитывает его по
```

заменить на

<!-- prettier-ignore -->
```text
    названия линий в таблице и в диалоге — из `GET /v1/office/lines` хоста;
  - отзыв спрашивает подтверждение, называет устройство и говорит, что его нельзя
    отменить; у отозванного устройства кнопок нет;
  - строка этого ПК (устройства, на котором открыт офис, план 1d4) помечена
    «Этот ПК», а отзыв этого ПК предупреждает строже: приложение здесь
    отключится от хоста, и его придётся подключить заново; запрета нет;
  - «Новый код» шлёт `{ replaces }` с кодом на экране (без кода на экране — без
    тела), а повторный щелчок, пока запрос идёт, ничего не отправляет; таймер
    берёт срок жизни кода у хоста (`expiresAt − createdAt`) и отсчитывает его по
```

Затем перечитать целиком разделы `apps/standalone/AGENTS.md` «Local database», «Writes», «Change feed», «Operators and badges», «Reference sync», «App shell», «Office pages» и §4.6, §5.2, §5.3, §5.4, §5.5 спецификации. Каждое изменённое планом предложение должно говорить, что делает код в этом коммите; противоречие между абзацами, дописанными разными задачами, исправить в том же коммите. Проверить отдельно:

- «Office pages»: `writeFailure` называет `line_name`, `login`, `badge`; в `try` — запись и хеширование её тела; `destructive` — у архива, отзыва и выключения;
- «Reference sync»: бюджет — 21 при E = 5, `ENTITY_SET` с `;v3`, абзац о защите от карантина и о том, чего `hostGuard` не ловит, не спорит с описанием `hostGuard` ниже;
- «Local database»: ни одна фраза не говорит, что при неоткрывшейся базе сброс ничего не чистит.

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`; `node_modules/.bin/prettier --check apps/standalone/src/office/this-device.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/app/App.tsx apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/RevokeDeviceDialog.tsx apps/standalone/src/app/LineSelect.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/devices-page.test.tsx apps/standalone/test/line-select.test.tsx apps/standalone/test/app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `git diff --check`
Expected: всё зелёное; Vitest — 36 файлов, 722 теста.

```bash
git add apps/standalone/src/office/this-device.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/app/App.tsx apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/RevokeDeviceDialog.tsx apps/standalone/src/app/LineSelect.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/devices-page.test.tsx apps/standalone/test/line-select.test.tsx apps/standalone/test/app.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Этот ПК» в «Устройствах», одно объявление сбоя справочников" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build` — зелёные; Vitest — 36 файлов, 722 теста (было 33 и 650); один прогон с `--reporter=verbose` — stderr пуст, предупреждений `act(...)` нет.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (крейт оболочки встраивает `apps/standalone/dist`), затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — 36 наборов, 348 тестов (было 346), без предупреждений компилятора; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` — без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам — чисто; `git diff --check <начало плана>..HEAD` — чисто; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `apps/station`, `apps/standalone/proto` и `tools/ci/affected.mjs` не менялись, в `apps/standalone/host` — только `src/routes/operators.rs` и `tests/badges.rs`.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - окно `tauri dev` на WebView2: «Операторы» и диалоги бейджей при ширине 1024–1280, приглушённые отозванные бейджи в светлой и тёмной темах, фокус при открытии и закрытии диалогов и после переключения «Бейджи» → «Добавить бейдж» → список;
  - настоящий клавиатурный сканер: код и Enter в поле кода (тест шлёт событие `submit` формы напрямую), сканер при русской раскладке — подсказка вместо хеша;
  - хеширование PIN и бейджа в WebView2 (в тестах — WebCrypto Node 24);
  - экранный диктор (NVDA): одно объявление сбоя справочников на экране выбора линии за весь сбой;
  - два ПК в сети: выключенный оператор и отозванный бейдж доходят до копий второй станции; отзыв администратором собственного ПК — экран отказа устройства;
  - Windows: `remove_unopened`, когда файл базы держит другой процесс (антивирус), — ответ `storage`; `secure_delete` и контрольная точка на NTFS;
  - задание CI `standalone-windows-build` — для него нужен push.

---

## Перенесено

- План 1f (из брифа): вход оператора на станции по PIN и бейджу офлайн, блокировки, киоск-режим, заглушка цеха → настоящий цех. Правила для него записаны в `AGENTS.md` («Operators and badges»): копии читаются только на экране цеха подключённого и не отвергнутого устройства; хеши на диске не стираются при отзыве устройства, поэтому отозванное или отвергнутое устройство и дальше не показывает цех (`nextShellView`); бейдж ищется хешем обрезанного скана с солью `ref_site` и сравнением строк целиком, а бейдж, совпавший у нескольких действующих операторов, отвергается как неоднозначный. Плюс от этого плана: станция хеширует скан так же, как офис, — обрезанным, а кириллический скан отвергает с подсказкой раскладки.
- План 1f, до чтения копий для входа (рекомендация планировщика; решает контроллер): щель `hostGuard` после нового подключения к тому же хосту. Старая страница прогона, запрошенного до `device_forget`, проходит проверку, если новое подключение успело поставить тот же `host_id`: `AND NOT EXISTS` этого плана не пускает старую ревизию записи из карантина, но та же страница возвращает запись, удалённую надгробием (выключенный оператор, отозванный бейдж), и откатывает `last_rev` — до следующего прогона. Закрыть — привязать проверку к подключению, а не к хосту (например, `device_id` в `sync_state` рядом с `host_id`).
- План 1e: каталог и шаблоны (`useCan("editCatalog")`), бюджет порции E = 8 → 30 из 32 SQL-операторов.
- План 2a: как назначенная в офисе линия, выключенный оператор и отозванный бейдж ведут себя при смене в работе; станция показывает расхождение линии и отказ записи `device.json`.
- План 5: `MIN_PROTOCOL_VERSION` и политика версий протокола после выпуска; коды подключения переживают права создателя; откат системных часов; закрепление контрольных сумм миграций; `protocol_unsupported` повторяется бесконечно с общим текстом.
- Не отдавать хеши операторов и бейджей устройствам вида `office` («при желании» плана 1d2): не сейчас. Лента устроена по сущностям, а не по видам устройств, и такой фильтр — отдельная логика хоста в выдаче ленты. Пока это приемлемо: офисный ПК — ПК администратора в сети площадки, его копии лежат в той же локальной базе в каталоге данных приложения и очищаются при сбросе, а сам офис их не читает.
- Удаление неоткрывшейся базы (`remove_unopened`) удалит и базу, которая не прошла миграции (например, после отката сборки), вместе с копиями. Пока все таблицы — одноразовые копии хоста, это верно; первый план с собственными данными станции обязан это пересмотреть (записано в `AGENTS.md`).
- Обход интерфейса (как в плане 1d3): после закрытия диалога фокус возвращается на кнопку строки, которую сохранение заменило, и падает на `<body>`.
- Решения владельца ждут: уникальность контрагента по ИНН или GLN; знаки формата (пробел нулевой ширины, знак порядка байтов внутри текста) проходят и форму, и хост; политика версий протокола; защита от отката системных часов; контрольный символ в коде подключения.
