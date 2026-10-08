# План 2a1: хост — смены (план, правка, удаление, закрытие офисом, список и создание на станции, вход со снимком), номер смены, блоки SSCC, `template_in_use`, табельные номера с ведущими нулями — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автономного продукта ведёт смены по HTTP: офис планирует, правит, удаляет запланированную и закрывает активную смену; станция читает смены своей линии, создаёт смену, пока хост на связи, и входит в неё — хост открывает смену, замораживает снимок товара, макета шаблона, префикса SSCC и контрагента и не пускает второе устройство; станция получает блоки номеров SSCC. Номер смены совпадает с облачным байт в байт (общая фикстура с TypeScript), шаблон, который назвала запланированная смена, не удаляется, протокол поднимается до версии 2. Приём фактов, итоги смены, экраны офиса и цеха — планы 2a2–2a8; этот план готовит им API, данные и фикстуры.

**Architecture:**

- `host/migrations/0009_shifts_sscc_blocks.sql` — `shift_number_counters`, `shifts` (со снимком и проверками статусов), `shift_participants`, `sscc_blocks`.
- `host/src/shifts.rs` — номер смены (`civil_date`, `month_key`, `format_number`), проверки ссылок новой смены, вставка с номером, отказы `shift_status`, `shift_busy`, `product_inactive`, `template_not_fit`, сборка снимка.
- `host/src/routes/office_shifts.rs` — `GET/POST /v1/office/shifts`, `GET/PUT/DELETE …/{id}`, `POST …/{id}/close`; `host/src/routes/device_shifts.rs` — `GET/POST /v1/device/shifts`, `POST …/{id}/enter`; `host/src/routes/sscc_blocks.rs` — `POST /v1/device/sscc/blocks`.
- `host/src/routes/templates.rs` — `template_in_use`; `host/src/routes/operators.rs` — табельный номер, который отличается от существующего только ведущими нулями, занят; `host/src/auth.rs` — `plans_shifts`, `require_shift_planning(_in)`; `host/src/audit.rs` — шесть новых действий; `host/src/validate.rs` — дата, план, причина закрытия, `requestId`.
- `proto` — типы смен, снимка, блоков, код `sscc_exhausted`, `PROTOCOL_VERSION = 2`, фикстуры; вебвью — только то, что держит общие фикстуры с хостом: Vitest номера смены, `API_ERROR_CODES` и текст `sscc_exhausted`, зеркало `PROTOCOL_VERSION`; оболочка — два теста пробы хоста под протокол 2.

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite 3.46: `RETURNING` у `ON CONFLICT DO UPDATE`, `json_extract`, частичный индекс), tokio 1.53.1, serde, serde_json (без `preserve_order`), time 0.3.55, uuid 1; TypeScript — Vitest 4 и zod 4 (только тесты и две строки исходников вебвью).

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (черновик этапа 2a): §2 (решения 1–9, 13, 35), §4.1–4.3, §4.7–4.10, §6, §7, строка 2a1 раздела 8, §11 (вопросы владельцу), §13.
- `docs/superpowers/specs/2026-09-26-standalone-station-design.md`: §6.3 (снимок при открытии), §6.6 (SSCC и блоки), §6.7 (смены), §6.9 (закрытие офисом и поздние данные).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: ревизии и лента, протокол v1, ошибки, роли, журнал действий.
- `apps/standalone/AGENTS.md` — обязательные правила («Writes», «Change feed», «Protocol», «Audit», «Logs», «Verification»); образцы — планы 1d2 и 1e1 (`docs/superpowers/plans/2026-09-27-standalone-1d2-host-people-devices.md`, `docs/superpowers/plans/2026-10-03-standalone-1e1-host-catalog-templates.md`).
- Облако, с которого сняты правила: `packages/domain/src/shift-number.ts` (номер), `apps/api/src/modules/shifts/{dto,shifts.service}.ts` (`civilDateSchema`, `createShift`, `closeShiftSchema`), `packages/db` (`shift_number_counters`).

## Допущения по вопросам владельцу

Владелец ответил «по порядку», не выбрав варианты раздела 11 спецификации 2a. План принимает рекомендованный вариант каждого вопроса, который касается хоста в 2a1; ниже — что именно принято и что стоит поправить, если ответ будет другим.

- **В1 — граница 2a и 2b: вариант А.** На смене одно устройство: вход второго — `conflict` с `constraint: shift_busy` (задача 5). Квитанции фактов и работа без хоста — план 2a2 и станция. При варианте Б в 2a1 ничего не меняется: `shift_busy` нужен в обоих вариантах.
- **В2 — контрактное производство: вариант А.** Контрагент — только имя в снимке (`counterpartyName`), SSCC — всегда под префиксом текущего GLN организации (`issuerPrefix` снимка, задача 5). Вариант Б: снимок взял бы префикс выбранного издателя, а блоки — счётчик этого префикса; схема `sscc_blocks` уже ключована префиксом, правка — в `shifts::snapshot` и в форме смены.
- **В3 — одна дата смены: вариант А.** Только обязательная «Дата производства»; номер месяца — из неё (задачи 1–2). Вариант Б — новый столбец плановой даты и поле запросов; до исполнения плана правится миграция `0009` этого плана, после — новой миграцией.
- **В4 — закрытие активной смены из офиса уже в 2a: вариант А.** Обе роли, текст причины 3–500 символов (задача 6). Вариант Б — задача 6 не исполняется: она ни от чего дальше не зависит.
- **В6 — значения по умолчанию раздела 15 родительской спецификации: принять.** Блок — `site.box_block_size` (2000 по умолчанию, правится в офисе), дозаказ «на половине» — правило станции (план 2a6); хост только выдаёт блок (задача 7). Другие числа меняют настройку `site`, не код.
- **В9 — смена линии при идущей смене: вариант А.** Хост не отказывает в переводе станции с активной сменой: `PUT /v1/office/devices/{id}` не меняется. Следствие для 2a1: войти в смену можно только со станции её линии, владелец смены тоже получает `shift_line` после перевода (задача 5).
- **В13 — табельные номера с ведущими нулями: вариант А.** Новый номер, который отличается от существующего только ведущими нулями (`042` рядом с `0042`), — `conflict` на `login` с `details.similarLogin` (задача 8). Вариант Б — задача 8 не исполняется.
- В5, В7, В8, В10, В11, В12 и В14 хоста в 2a1 не касаются (оболочка, цех, офис).

## Global Constraints

**Решения спецификации, обязательные для 2a1**

1. Правила маркировки — в `@markiro/domain` (решение 13): хост коды маркировки не разбирает и контрольную цифру SSCC не считает. Правило номера смены переписано в Rust (`host/src/shifts.rs`), а не перенесено в общий пакет: `proto/fixtures/shift-numbers.json` читают и `host/tests/shift_numbers.rs`, и `test/shift-numbers.test.ts` (функции домена `shiftMonthKey`, `formatShiftNumber`), поэтому разойтись правила не могут. Дата производства — гражданская дата `YYYY-MM-DD` годов 1–9999 (облачный `civilDateSchema`); год 0000 (который `shiftMonthKey` домена тоже читает) хост отвергает, и фикстура его не содержит.
2. Номер присваивает хост (решение 5): `MONYY-NNN`, `/S` у созданной на станции, счётчик по месяцу даты производства в той же транзакции, что и вставка; номер не меняется при правке даты и не выдаётся повторно после удаления.
3. Режимы (решение 6): `mode` (`aggregation`, `validation`) и `palletsEnabled` есть в форме, хост принимает только `aggregation` и `false` (`validation_failed` на `mode` и `palletsEnabled`).
4. Снимок (решение 3) пишет хост при открытии (`planned → active`) одной транзакцией: товар (`id`, `gtin14`, `name`, `printName`, `chzProductGroupCode`, `shelfLifeDays`), шаблон короба целиком (`id`, `name`, `rev`, `spec`), `issuerPrefix` текущего GLN, `counterpartyName`. Схему макета хост не проверяет. Снимок — не больше 327 680 байт (`CHECK` в `0009`).
5. Шаблон (решение 7): `templates::fits` при создании, при смене шаблона в правке и при открытии; при открытии неподходящий — `conflict` `template_not_fit`. Удаление шаблона, на который ссылается запланированная смена, — `conflict` `template_in_use` с `details.shiftIds` (по возрастанию id). Выключение и сужение не запрещаются.
6. Товар (решение 8): при создании и открытии — `active` и не в архиве, иначе `conflict` `product_inactive`.
7. Блоки SSCC (решение 9, §4.3): только станция, `extension` 0, префикс со счётчиком; повтор `requestId` тем же устройством — тот же блок; блок — `site.box_block_size` серий, у конца ёмкости префикса — короче, затем `sscc_exhausted`; счётчик сдвигается на блок и получает новую ревизию в той же транзакции.
8. Одно устройство на смене (решение 1): вход другой станции в открытую смену — `conflict` `shift_busy`.
9. Протокол (решение 35, §6): `PROTOCOL_VERSION` → 2, `MIN_PROTOCOL_VERSION` остаётся 1. Запросы — `deny_unknown_fields`, ответы терпят новые поля; у каждого нового типа есть фикстура, её разбирает `proto/tests/fixtures.rs`.
10. Ошибки (§4.8): новый код верхнего уровня — `sscc_exhausted` (HTTP 409); новые `details.constraint` у `conflict` — `shift_busy`, `shift_line`, `shift_status` (с `details.status`), `product_inactive`, `template_not_fit`, `template_in_use` (с `details.shiftIds`). `proto/fixtures/error-codes.json` и `API_ERROR_CODES` вебвью меняются вместе (их сверяют обе стороны).
11. Роли (§4.9): смены читают все роли офиса; план, правку, удаление и закрытие — администратор и технолог (`auth::plans_shifts` без подстановочной ветки, `require_shift_planning` рано и `require_shift_planning_in` в транзакции); маршруты устройства — только станция; ключ устройства без сессии офиса офисных маршрутов не открывает.
12. Журнал действий (§4.10) — таблица ниже; отказанная запись строки не пишет; тесты сверяют строку целиком (исполнитель, действие, цель, результат, разобранные `details`).
13. Смена — не запись ленты (решение 2): каждое изменение смены берёт ревизию хоста (`next_revision`, штамп в `shifts.rev`, коммит через `commit_with_revision`) без записи ленты, как смена линии устройства; повторный вход владельца и повторы запросов ревизии не берут.

**Модель данных** (миграция `0009_shifts_sscc_blocks.sql`)

- `shift_number_counters(month_key TEXT PRIMARY KEY, last_seq)`.
- `shifts(id, number_month_key, number_seq, created_from, created_by_kind, created_by, create_request_id, status, mode, pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, box_capacity, pallet_box_capacity, box_template_id, pallet_template_id, owner_device_id, snapshot, opened_at, closed_at, closed_by_kind, closed_by, close_reason_code, close_reason_text, late_data_at, created_at, rev)`; `UNIQUE(number_month_key, number_seq)`, `UNIQUE(created_by, create_request_id)`; проверки: запланированная — без снимка, открытия и владельца, закрытая — с `closed_at` и `closed_by_kind`; индексы `(line_id, status)`, `(status, production_date)` и частичный по `box_template_id` среди запланированных. `box_template_id` без внешнего ключа.
- `shift_participants(shift_id, device_id, first_entered_at, last_entered_at, PRIMARY KEY(shift_id, device_id))`, индекс по `device_id`.
- `sscc_blocks(id, issuer_prefix, extension, device_id, request_id, from_serial, to_serial, consumed_through, issued_at, revoked_at)`, `UNIQUE(device_id, request_id)`, внешний ключ на `sscc_counters(issuer_prefix, extension)`.

**Журнал действий** (словарь `audit::actions`)

| Действие           | Исполнитель                   | `target_type` | `details`                                                                                                    |
| ------------------ | ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `shift.create`     | офисный пользователь, станция | `shift`       | `{ number, productId, lineId, productionDate }`                                                              |
| `shift.update`     | офисный пользователь          | `shift`       | `update_details`: `lineId`, `productionDate`, `boxTemplateId`, `boxCapacity`, `plannedQty`, `counterpartyId` |
| `shift.delete`     | офисный пользователь          | `shift`       | `{ number }`                                                                                                 |
| `shift.open`       | станция                       | `shift`       | `{ number, templateId, templateRev }`                                                                        |
| `shift.close`      | офисный пользователь          | `shift`       | `{ reason }`                                                                                                 |
| `sscc.block.issue` | станция                       | `sscc_block`  | `{ issuerPrefix, extension, fromSerial, toSerial }`                                                          |

**Решения планировщика** (уточнения спецификации; задача 9 записывает их в её §15)

- Неизвестный товар при создании — `validation_failed` на `productId`; `product_inactive` — только черновик и архив.
- Правка запланированной смены проверяет только изменённые линию, шаблон и контрагента (смена шаблона требует товара в работе); неизменённые остаются, даже если их выключили или заархивировали, — шаблон проверит открытие. `PUT` — частичный: передаётся только то, что меняется; `plannedQty: null` и `counterpartyId: null` очищают; у активной смены поле, кроме `plannedQty`, присланное с другим значением, — `shift_status`, с тем же значением — не изменение.
- `OfficeShift` несёт идентификаторы без имён; `GET /v1/office/shifts/{id}` в 2a1 без итогов — `totals` добавит 2a2 (поле ответа, добавление совместимо).
- `DeviceShift` называет товар и контрагента по снимку открытой смены и по записям до открытия, несёт `ownerDeviceId`; снимок — только в ответе на вход.
- Маршруты смен и блоков устройства — только станция (иной вид — `forbidden`), `GET /v1/device/shifts` тоже; станция без линии видит только смены, в которые входила, а создать смену не может (`shift_line`).
- Порядок отказов входа: нет смены — `not_found`; закрытая — `shift_status`; другая линия (или станция без линии), в том числе у владельца после перевода, — `shift_line`; занята — `shift_busy`; потом проверки открытия.
- `requestId` — UUID в канонической записи (строчные буквы, дефисы); повтор того же `requestId` той же станцией отдаёт прежнюю смену или блок, что бы ни было в теле.
- `shift.enter` в 2a не пишется: первый вход станции и есть открытие (`shift.open`); запись появится со вторым устройством в 2b.
- Повторный `DELETE` смены после потерянного ответа — `not_found` (надгробий у смен нет).
- Список офиса без периода: все запланированные и активные и закрытые с датой производства не раньше, чем 31 день назад по дате UTC часов хоста; `?from=&to=` — по дате производства включительно, любую границу можно опустить; новые сначала (`production_date DESC, created_at DESC`, затем номер). Список станции — по дате производства по возрастанию.
- `sscc_exhausted` несёт `details.issuerPrefix` и `details.extension`.
- `PROTOCOL_VERSION` поднимается в 2a1 (задача 4) вместе с тестами пробы хоста в оболочке и зеркалом `src/host/protocol.ts`, которое Vitest теперь сверяет с `hello.json`; маршрутами v2 станция начнёт пользоваться в 2a5.

**Код и процесс**

- Новых крейтов и пакетов нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются.
- Правила записи из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, коммит через `commit_with_revision`, пул не трогать при открытой транзакции записи, без изменений — без записи, ревизии и строки журнала.
- Не меняются: `apps/station`, `packages/*`, применённые миграции `0001`–`0008`, оболочка, кроме модуля тестов `src-tauri/src/host_probe.rs`, вебвью, кроме `src/host/errors.ts`, `src/host/protocol.ts`, `src/i18n/ru.json` и тестов `test/shift-numbers.test.ts`, `test/protocol.test.ts`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на момент применения он встречается в файле один раз (план применён к копии репозитория по шагам, задача за задачей). Правки идут сверху вниз по файлу и применяются по порядку. Шаг 1 (тесты) применяется раньше шага 3 (реализация); в `proto/src/lib.rs`, `host/src/server.rs` и `src-tauri/src/host_probe.rs`, где есть и код, и модуль `tests`, шаг 1 трогает только модуль `tests`.
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier: расхождение при проверке значит опечатку.
- Блок `use markiro_proto::{…}` в `proto/tests/fixtures.rs` меняется целиком: `cargo fmt` переливает весь список при каждом новом имени.
- Русский текст — буквами, не `\uXXXX`: после правки `grep -n '\\u0' <файл>` ничего не находит (кроме `\u001d` и `\u{…}`, которых в этом плане нет).

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые JSON, TS и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` (`--locked` заодно доказывает, что `Cargo.lock` не меняется). Если крейта нет в локальном кэше, та же команда без `--offline` — вне песочницы.
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind` (`Operation not permitted`), их запускают вне песочницы: хост — `hello`, `platform`, `no_secrets_in_logs`, `changes_stream`; оболочка — `claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `ipc`, `line`. Поэтому `cargo test -p markiro-host` целиком и `--workspace` — вне песочницы, а отдельные `--test office_shifts`, `--test device_shifts` и т. п. — и в ней.
- Оболочка встраивает сборку вебвью (`tauri::generate_context!` читает `apps/standalone/dist`): для `-p markiro-standalone` и `--workspace` в свежем worktree сначала `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем worktree — `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать; команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; числа тестов не складывать через `| grep | awk`. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- На копии репозитория с пустым `CARGO_TARGET_DIR` первая сборка хоста и оболочки идёт несколько минут; дальше наборы пересобираются за секунды.

**Счёт тестов**

- До плана: cargo — 42 набора, 461 тест (хост 307, `proto` 39, оболочка 115); Vitest — 66 файлов, 1716 тестов. После: cargo — 46 наборов, 494 теста (хост 334, `proto` 45, оболочка 115); Vitest — 67 файлов, 1744 теста. Каждое «Expected» ниже измерено на копии репозитория с кодом самого плана; расхождение значит, что шаг применён не так (тесты, добавленные исполнителем сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/host/src/shifts.rs                                                    задачи 1–3, 5
apps/standalone/host/src/lib.rs, host/tests/shift_numbers.rs                          задача 1
apps/standalone/proto/fixtures/shift-numbers.json, test/shift-numbers.test.ts         задача 1
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                             задачи 1–7
apps/standalone/host/migrations/0009_shifts_sscc_blocks.sql                           задача 2
apps/standalone/host/src/routes/office_shifts.rs, host/tests/office_shifts.rs         задачи 2, 3, 6
apps/standalone/host/src/auth.rs, host/src/routes/devices.rs, host/tests/support/app.rs   задача 2
apps/standalone/host/src/audit.rs, host/src/server.rs                                 задачи 2–7
apps/standalone/host/src/routes/mod.rs                                                задачи 2, 4, 7
apps/standalone/host/src/validate.rs                                                  задачи 2, 6
apps/standalone/proto/fixtures/{office-shift,shift-create}.json                       задача 2
apps/standalone/host/src/routes/templates.rs, proto/fixtures/shift-update.json        задача 3
apps/standalone/host/src/routes/device_shifts.rs, host/tests/device_shifts.rs         задачи 4, 5
apps/standalone/host/tests/{claim,hello,platform}.rs, proto/fixtures/hello.json       задача 4
apps/standalone/proto/fixtures/{device-shifts,device-shift-create}.json               задача 4
apps/standalone/src-tauri/src/host_probe.rs, src/host/protocol.ts, test/protocol.test.ts   задача 4
apps/standalone/proto/fixtures/{device-shift-entered,error-shift-busy}.json           задача 5
apps/standalone/proto/fixtures/shift-close.json                                       задача 6
apps/standalone/host/src/routes/sscc_blocks.rs, host/src/routes/sscc.rs, host/tests/sscc_blocks.rs   задача 7
apps/standalone/proto/fixtures/{sscc-block-request,sscc-block,error-sscc-exhausted,error-codes}.json   задача 7
apps/standalone/src/host/errors.ts, src/i18n/ru.json                                  задача 7
apps/standalone/host/src/routes/operators.rs, host/tests/operators.rs                 задача 8
apps/standalone/host/tests/no_secrets_in_logs.rs                                      задача 9
apps/standalone/AGENTS.md                                                             задачи 1–9
docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md             задача 9
```

Номер смены (задача 1) — чистая функция без базы: её фикстура проверяется раньше всего остального. Миграция одна и стоит в задаче 2 вместе с первым писателем — планированием смены в офисе: модель целиком (участники и блоки тоже), потому что задачи 4–7 только добавляют маршруты. Правка и удаление (задача 3) опираются на чтение задачи 2, а `template_in_use` — на запланированные смены. Маршруты станции (задача 4) поднимают протокол: с ними у версии 2 появляется смысл. Вход (задача 5) пишет снимок и участника; закрытие офисом (задача 6) — после входа, потому что закрывается только активная смена. Блоки (задача 7) независимы от смен, но идут после них: снимок называет префикс, блоки которого просит станция. Ведущие нули (задача 8) — отдельная маленькая правка хоста. Задача 9 проводит смену со снимком через журнал процесса и сверяет спецификацию.

---

### Task 1: Номер смены — `host/src/shifts.rs`, общая фикстура с доменом, `ShiftOrigin`

Номер смены — идентификатор, его выдаёт хост, и он обязан читаться так же, как облачный (`packages/domain/src/shift-number.ts`). Правило переписано в Rust, а не вынесено в общий пакет: хост — Rust, домен — TypeScript. Чтобы две копии не разошлись, их держит одна фикстура `proto/fixtures/shift-numbers.json`: тест хоста проверяет по ней `month_key_of` и `format_number`, Vitest — `shiftMonthKey` и `formatShiftNumber` домена (там `createdFrom` офиса называется `admin`). Vitest проходит сразу: домен уже следует правилу, тест закрепляет фикстуру. `civil_date` — проверка даты производства для следующих задач (годы 1–9999, как облачный `civilDateSchema`).

**Files:**

- Create: `apps/standalone/host/src/shifts.rs`, `apps/standalone/proto/fixtures/shift-numbers.json`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/proto/src/lib.rs` (`ShiftOrigin`)
- Test: `apps/standalone/host/tests/shift_numbers.rs` (Create), `apps/standalone/test/shift-numbers.test.ts` (Create), модуль `tests` в `apps/standalone/proto/src/lib.rs`
- Modify: `apps/standalone/AGENTS.md` (новый раздел «Shifts»)

**Interfaces:**

- Consumes: `UnknownVariant`, `parse_variant` — `proto/src/lib.rs`; `shiftMonthKey`, `formatShiftNumber`, `DomainError` — `@markiro/domain`.
- Produces:
  - `pub enum markiro_proto::ShiftOrigin { Office, Station }` (`snake_case`), `as_str`, `FromStr` (`unknown shift origin "…"`);
  - `pub fn markiro_host::shifts::civil_date(text: &str) -> Option<time::Date>`;
  - `pub fn markiro_host::shifts::month_key(date: time::Date) -> String`;
  - `pub fn markiro_host::shifts::month_key_of(text: &str) -> Option<String>`;
  - `pub fn markiro_host::shifts::format_number(month_key: &str, seq: i64, origin: ShiftOrigin) -> String`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/shift_numbers.rs`:

<!-- prettier-ignore -->
```rust
use markiro_host::shifts::{civil_date, format_number, month_key_of};
use markiro_proto::ShiftOrigin;
use serde_json::Value;

/// `proto/fixtures/shift-numbers.json`: the cases the host's shift number and
/// the domain's (`shiftMonthKey`, `formatShiftNumber`) must answer alike; the
/// webview's `test/shift-numbers.test.ts` reads it too.
fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/shift-numbers.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn every_month_key_of_the_fixture_matches() {
    let fixture = fixture();
    let cases = fixture["monthKeys"].as_array().expect("monthKeys");
    assert_eq!(cases.len(), 22);
    for case in cases {
        let date = case["date"].as_str().expect("date");
        assert_eq!(
            month_key_of(date).as_deref(),
            case["monthKey"].as_str(),
            "{date:?}"
        );
    }
}

#[test]
fn every_number_of_the_fixture_matches() {
    let fixture = fixture();
    let cases = fixture["numbers"].as_array().expect("numbers");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let origin: ShiftOrigin = serde_json::from_value(case["createdFrom"].clone()).unwrap();
        assert_eq!(
            format_number(
                case["monthKey"].as_str().unwrap(),
                case["seq"].as_i64().unwrap(),
                origin
            ),
            case["number"].as_str().unwrap(),
            "{case}"
        );
    }
}

/// The cloud's civil dates run from the year 1; the domain's month key alone
/// would read `0000-01-15` as `JAN00`, so the fixture leaves that year out.
#[test]
fn the_year_zero_is_no_civil_date() {
    assert_eq!(civil_date("0000-01-15"), None);
    assert_eq!(month_key_of("0000-01-15"), None);
    assert_eq!(month_key_of("0001-01-15").as_deref(), Some("JAN01"));
    assert_eq!(month_key_of("9999-12-31").as_deref(), Some("DEC99"));
}
```

2. Создать `apps/standalone/proto/fixtures/shift-numbers.json`:

<!-- prettier-ignore -->
```json
{
  "monthKeys": [
    { "date": "2026-10-08", "monthKey": "OCT26" },
    { "date": "2026-01-01", "monthKey": "JAN26" },
    { "date": "2029-12-31", "monthKey": "DEC29" },
    { "date": "2028-02-29", "monthKey": "FEB28" },
    { "date": "2000-02-29", "monthKey": "FEB00" },
    { "date": "2099-07-15", "monthKey": "JUL99" },
    { "date": "0024-02-29", "monthKey": "FEB24" },
    { "date": "2026-02-29", "monthKey": null },
    { "date": "1900-02-29", "monthKey": null },
    { "date": "2026-04-31", "monthKey": null },
    { "date": "2026-01-00", "monthKey": null },
    { "date": "2026-13-01", "monthKey": null },
    { "date": "2026-00-10", "monthKey": null },
    { "date": "2026-8-1", "monthKey": null },
    { "date": "20261008", "monthKey": null },
    { "date": " 2026-10-08", "monthKey": null },
    { "date": "2026-10-08 ", "monthKey": null },
    { "date": "2026-10-08\n", "monthKey": null },
    { "date": "2026-10-08T00:00:00Z", "monthKey": null },
    { "date": "２０２６-10-08", "monthKey": null },
    { "date": "garbage", "monthKey": null },
    { "date": "", "monthKey": null }
  ],
  "numbers": [
    { "monthKey": "AUG26", "seq": 3, "createdFrom": "office", "number": "AUG26-003" },
    { "monthKey": "JAN27", "seq": 42, "createdFrom": "office", "number": "JAN27-042" },
    { "monthKey": "OCT26", "seq": 4, "createdFrom": "station", "number": "OCT26-004/S" },
    { "monthKey": "AUG26", "seq": 1234, "createdFrom": "office", "number": "AUG26-1234" },
    { "monthKey": "DEC29", "seq": 1, "createdFrom": "station", "number": "DEC29-001/S" }
  ]
}
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

заменить на

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, ShiftOrigin, TemplatePurpose,
        UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        roles
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

заменить на

<!-- prettier-ignore -->
```rust
        roles
    }

    /// Every `ShiftOrigin`, listed the same way.
    fn shift_origins() -> Vec<ShiftOrigin> {
        let origins = vec![ShiftOrigin::Office, ShiftOrigin::Station];
        for origin in &origins {
            match origin {
                ShiftOrigin::Office | ShiftOrigin::Station => {}
            }
        }
        origins
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            assert_eq!(role.as_str().parse::<OfficeRole>(), Ok(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
    }

    /// Names are exact: another case, padding or an unknown name is refused,
```

заменить на

<!-- prettier-ignore -->
```rust
            assert_eq!(role.as_str().parse::<OfficeRole>(), Ok(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        for origin in shift_origins() {
            assert_eq!(origin.as_str().parse::<ShiftOrigin>(), Ok(origin));
            assert_eq!(serde_json::to_value(origin).unwrap(), origin.as_str());
        }
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
        );
    }

    /// Names are exact: another case, padding or an unknown name is refused,
```

6. Создать `apps/standalone/test/shift-numbers.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { DomainError, formatShiftNumber, shiftMonthKey } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/**
 * `proto/fixtures/shift-numbers.json`, read strictly: the cases the host's
 * shift number (`host/src/shifts.rs`) and the domain's answer alike.
 */
const NUMBERS = z
  .strictObject({
    monthKeys: z.array(z.strictObject({ date: z.string(), monthKey: z.string().nullable() })),
    numbers: z.array(
      z.strictObject({
        monthKey: z.string(),
        seq: z.number().int().positive(),
        createdFrom: z.enum(["office", "station"]),
        number: z.string(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-numbers.json", testModuleUrl), "utf8"),
    ),
  );

describe("shift numbers: the fixture the host's shift number answers too", () => {
  it("holds 22 dates and 5 numbers", () => {
    expect(NUMBERS.monthKeys).toHaveLength(22);
    expect(NUMBERS.numbers).toHaveLength(5);
  });

  it.each(NUMBERS.monthKeys.map((each) => [each.date, each.monthKey] as const))(
    "reads the month of %j as the host does",
    (date, monthKey) => {
      if (monthKey === null) {
        expect(() => shiftMonthKey(date)).toThrow(DomainError);
      } else {
        expect(shiftMonthKey(date)).toBe(monthKey);
      }
    },
  );

  it.each(NUMBERS.numbers.map((each) => [each.number, each] as const))(
    "writes %s as the host does",
    (number, each) => {
      // The host's `office` is the cloud's `admin`.
      const createdFrom = each.createdFrom === "office" ? "admin" : "station";
      expect(formatShiftNumber({ monthKey: each.monthKey, seq: each.seq, createdFrom })).toBe(
        number,
      );
    },
  );
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test shift_numbers --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_host::shifts` `` и ``unresolved import `markiro_proto::ShiftOrigin` ``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `super::ShiftOrigin` ``.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-numbers.test.ts`
Expected: PASS — 28 тестов (домен уже следует правилу).

- [ ] **Step 3: Номер смены и `ShiftOrigin`**

1. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod templates;
pub mod tls;
pub mod validate;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod shifts;
pub mod templates;
pub mod tls;
pub mod validate;
```

2. Создать `apps/standalone/host/src/shifts.rs`:

<!-- prettier-ignore -->
```rust
//! Shifts (stage 2a spec §4.2). The number is the host's: a counter per
//! month, `MONYY-NNN`, with `/S` for a shift created at a station — the
//! domain's `shiftMonthKey` and `formatShiftNumber`
//! (`packages/domain/src/shift-number.ts`) rewritten, so a number reads the
//! same as the cloud's. `proto/fixtures/shift-numbers.json` holds the cases
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::ShiftOrigin;

/// The month names of a shift number: a fixed English table, never a
/// locale's, because the number is an identifier.
const MONTH_KEYS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// A civil date as `YYYY-MM-DD`: four, two and two ASCII digits naming a
/// real calendar day of the years 1–9999, as the cloud's `civilDateSchema`.
/// The domain's `shiftMonthKey` also takes the year 0000 (its `Date.UTC`
/// reads the years 0–99 as 1900–1999); no shift date can be that year here.
pub fn civil_date(text: &str) -> Option<time::Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |part: &[u8]| -> Option<u16> {
        part.iter().try_fold(0u16, |value, byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + u16::from(byte - b'0'))
        })
    };
    let year = number(&bytes[0..4])?;
    let month = number(&bytes[5..7])?;
    let day = number(&bytes[8..10])?;
    if year == 0 {
        return None;
    }
    let month = time::Month::try_from(u8::try_from(month).ok()?).ok()?;
    time::Date::from_calendar_date(i32::from(year), month, u8::try_from(day).ok()?).ok()
}

/// The month a shift number is drawn from, as `MONYY` (`OCT26`).
pub fn month_key(date: time::Date) -> String {
    let month = MONTH_KEYS[usize::from(u8::from(date.month())) - 1];
    format!("{month}{:02}", date.year() % 100)
}

/// [`month_key`] of a civil date's text, `None` when it is no civil date.
pub fn month_key_of(text: &str) -> Option<String> {
    civil_date(text).map(month_key)
}

/// The shift number as people read it: `OCT26-004`, `OCT26-004/S` for a
/// station's, and never cut short past 999 (`OCT26-1234`).
pub fn format_number(month_key: &str, seq: i64, origin: ShiftOrigin) -> String {
    let station = match origin {
        ShiftOrigin::Office => "",
        ShiftOrigin::Station => "/S",
    };
    format!("{month_key}-{seq:03}{station}")
}
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

/// Where a shift was created (stage 2a spec §4.2): planned in the office, or
/// at a station while the host answered. A station's shift number ends in
/// `/S`. The cloud's name for the office is `admin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftOrigin {
    Office,
    Station,
}

impl ShiftOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftOrigin::Office => "office",
            ShiftOrigin::Station => "station",
        }
    }
}

impl std::str::FromStr for ShiftOrigin {
    type Err = UnknownVariant;

    /// The name [`ShiftOrigin::as_str`] gives, as `shifts.created_from`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift origin", text)
    }
}

#[cfg(test)]
mod tests {
    use super::{
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test shift_numbers --offline --locked`
Expected: PASS — 3 теста.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 34 теста фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
  its own, since a change of the organization's profile moves the document's
  revision too, and the reload drops the edits.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
  its own, since a change of the organization's profile moves the document's
  revision too, and the reload drops the edits.

## Shifts

Stage 2a (`docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`;
plan 2a1 built the host's side). The host numbers a shift: a counter per
month of its production date (`shift_number_counters`), `MONYY-NNN`
(`OCT26-004`), with `/S` for a shift a station created — the domain's
`shiftMonthKey` and `formatShiftNumber` rewritten in `host/src/shifts.rs`.
`proto/fixtures/shift-numbers.json` holds the cases both must answer alike;
`host/tests/shift_numbers.rs` and `test/shift-numbers.test.ts` read every
one, so changing either rule means changing the fixture. A production date is
a civil date `YYYY-MM-DD` of the years 1–9999, as the cloud's
`civilDateSchema`; the domain's month key alone also reads the year 0000 (its
`Date.UTC` takes the years 0–99 as 1900–1999), so the fixture leaves that
year out. A number is drawn once, when the shift is created: an edit of the
production date keeps it, and a deleted shift's number is not drawn again.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — номер без дополнения нулями. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    format!("{month_key}-{seq:03}{station}")
```

заменить на

<!-- prettier-ignore -->
```rust
    format!("{month_key}-{seq}{station}")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test shift_numbers --offline --locked`
Expected: FAIL `every_number_of_the_fixture_matches`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — год 0000 принимается. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    if year == 0 {
        return None;
    }
```

удалить.

Run: та же команда.
Expected: FAIL `the_year_zero_is_no_civil_date`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/shift-numbers.json apps/standalone/test/shift-numbers.test.ts apps/standalone/AGENTS.md`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec eslint test/shift-numbers.test.ts`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 310 тестов, `proto` 39.

```bash
git add apps/standalone/host/src/shifts.rs apps/standalone/host/src/lib.rs apps/standalone/host/tests/shift_numbers.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/fixtures/shift-numbers.json apps/standalone/test/shift-numbers.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): the host's shift number, shared with the domain through a fixture" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Смены в модели хоста и план офиса — миграция `0009`, `GET/POST /v1/office/shifts`, `GET …/{id}`, роль `planShifts`

Миграция создаёт всю модель плана: счётчики номеров, смены, участников и блоки SSCC (задачи 4–7 только добавляют маршруты). Первый писатель — план смены в офисе: товар в работе (`product_inactive` для черновика и архива, `validation_failed` на `productId` для неизвестного), активная линия, контрагент в работе или никакой, подходящий шаблон короба (`templates::fits`), дата производства, вместимость (по умолчанию — товара) и план. Номер — следующий в счётчике месяца даты производства, в той же транзакции. Смены читают все роли, пишут администратор и технолог (`auth::plans_shifts` без подстановочной ветки, как `edits_catalog`). Список без периода — открытые смены и закрытые за 31 день, с периодом — все смены периода. Закрытую смену тест пишет прямо в таблицу: маршруты открытия и закрытия придут в задачах 5 и 6.

**Files:**

- Create: `apps/standalone/host/migrations/0009_shifts_sscc_blocks.sql`, `apps/standalone/host/src/routes/office_shifts.rs`, `apps/standalone/proto/fixtures/office-shift.json`, `apps/standalone/proto/fixtures/shift-create.json`
- Modify: `apps/standalone/host/src/shifts.rs`, `apps/standalone/host/src/auth.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/validate.rs`, `apps/standalone/host/src/routes/devices.rs` (`require_active_line` становится `pub`), `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/office_shifts.rs` (Create), `apps/standalone/host/tests/support/app.rs` (`ShiftSetup`, `shift_setup`, `shift_body`, `plan_shift`), `apps/standalone/proto/tests/fixtures.rs`, модуль `tests` в `apps/standalone/proto/src/lib.rs`
- Modify: `apps/standalone/AGENTS.md` («Writes», «Shifts»)

**Interfaces:**

- Consumes: задача 1 — `shifts::{civil_date, month_key, format_number}`, `ShiftOrigin`; `templates::check_slot`, `routes::devices::require_active_line`, `OfficeContext::live_role_in` (через новые методы), `validate::{count, MAX_BOX_CAPACITY}`; `admin`, `Admin::{call, call_as, technologist_session, row}`, `audit_trail`, `audit_rows`, `host_revision` — `tests/support/app.rs`.
- Produces:
  - таблицы `shift_number_counters`, `shifts`, `shift_participants`, `sscc_blocks` и их индексы;
  - `markiro_proto::{ShiftStatus, ShiftMode, OfficeShift, ShiftCreate}` (`ShiftStatus`, `ShiftMode` с `as_str` и `FromStr`; `ShiftMode::default()` — `Aggregation`);
  - `pub fn markiro_host::auth::plans_shifts(role: OfficeRole) -> bool`; `OfficeContext::require_shift_planning(&self) -> Result<(), ApiError>`, `OfficeContext::require_shift_planning_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError>`;
  - `audit::actions::SHIFT_CREATE` (`"shift.create"`);
  - `validate::{MAX_PLANNED_QTY, civil_date(field, text) -> Result<time::Date, ApiError>, client_uuid(field, text) -> Result<(), ApiError>}`;
  - в `shifts.rs`: `ShiftProduct { group: u32, box_capacity: u32 }`, `product_inactive() -> ApiError`, `shift_product(conn, id) -> Result<ShiftProduct, ApiError>`, `check_counterparty(conn, id)`, `check_box_template(conn, id, group)`, `NewShift<'a> { origin, created_by, request_id, product_id, line_id, counterparty_id, production_date: time::Date, planned_qty, box_capacity: u32, box_template_id }`, `insert(conn, &NewShift, at, rev) -> Result<String, ApiError>`, `civil_text(date) -> String`;
  - в `routes/office_shifts.rs`: `list_shifts`, `get_shift`, `create_shift`, `pub fn check_mode(mode: ShiftMode, pallets_enabled: bool) -> Result<(), ApiError>`, `ShiftListQuery`;
  - в `tests/support/app.rs`: `pub struct ShiftSetup { product, template, line, other_line: String }`, `pub async fn shift_setup(&Admin) -> ShiftSetup` (шаблон — ревизия 2, товар — 3), `pub fn shift_body(&ShiftSetup) -> Value`, `pub async fn plan_shift(&Admin, Value) -> Value`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/office_shifts.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, plan_shift, request,
    shift_body, shift_setup, with_device, Admin, ShiftSetup,
};

/// The record of `shift_body(setup)` planned at `rev`: the product's box
/// capacity, no plan and no counterparty.
fn planned(id: &str, number: &str, setup: &ShiftSetup, rev: i64) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
        "palletsEnabled": false, "createdFrom": "office", "productId": setup.product,
        "lineId": setup.line, "counterpartyId": null, "productionDate": "2026-10-08",
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
        "rev": rev
    })
}

fn path(shift: &Value) -> String {
    format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap())
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

/// This station's own id, as the host has it.
async fn station_id(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Close a shift straight in its table, as if this station had opened and
/// closed it (the close comes with the routes of later tasks).
async fn close_directly(admin: &Admin, shift: &Value) {
    let device = station_id(admin).await;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', snapshot = '{}', opened_at = ?1, \
         owner_device_id = ?2, closed_at = ?1, closed_by_kind = 'device', closed_by = ?2 \
         WHERE id = ?3",
    )
    .bind(admin.app.state.timestamp())
    .bind(&device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_administrator_plans_a_shift_and_reads_it_back() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1, the template 2 and the product 3.
    assert_eq!(shift, planned(&id, "OCT26-001", &setup, 4));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )]
    );
    let (status, one) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, one), (StatusCode::OK, shift.clone()));
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([shift])));
    let (status, missing) = admin
        .call("GET", "/v1/office/shifts/no-such-shift", None)
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

#[tokio::test]
async fn numbers_count_per_month_of_the_production_date() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let mut body = shift_body(&setup);
    let first = plan_shift(&admin, body.clone()).await;
    let second = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-11-02");
    let november = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-10-31");
    let third = plan_shift(&admin, body).await;
    assert_eq!(
        [&first, &second, &november, &third].map(|shift| shift["number"].clone()),
        [
            json!("OCT26-001"),
            json!("OCT26-002"),
            json!("NOV26-001"),
            json!("OCT26-003")
        ]
    );
    let counters: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        counters,
        vec![("NOV26".to_owned(), 1), ("OCT26".to_owned(), 3)]
    );
}

#[tokio::test]
async fn a_plan_takes_every_field_it_names() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, counterparty) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{counterparty}");
    let mut body = shift_body(&setup);
    body["lineId"] = json!(setup.other_line);
    body["boxCapacity"] = json!(6);
    body["plannedQty"] = json!(1200);
    body["counterpartyId"] = counterparty["id"].clone();
    body["mode"] = json!("aggregation");
    body["palletsEnabled"] = json!(false);
    let shift = plan_shift(&admin, body).await;
    assert_eq!(
        [
            shift["lineId"].clone(),
            shift["boxCapacity"].clone(),
            shift["plannedQty"].clone(),
            shift["counterpartyId"].clone()
        ],
        [
            json!(setup.other_line),
            json!(6),
            json!(1200),
            counterparty["id"].clone()
        ]
    );
}

#[tokio::test]
async fn a_technologist_plans_shifts_too_and_a_device_alone_reads_none() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (token, technologist) = admin.technologist_session().await;
    let (status, shift) = admin
        .call_as(
            &token,
            "POST",
            "/v1/office/shifts",
            Some(shift_body(&setup)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let id = shift["id"].as_str().unwrap();
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![audit_row(
            &technologist,
            "shift.create",
            "shift",
            id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )]
    );
    let (status, list) = admin
        .call_as(&token, "GET", "/v1/office/shifts", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([shift])));
    // A device key opens no office route.
    for (method, path) in [
        ("GET", "/v1/office/shifts".to_owned()),
        ("GET", format!("/v1/office/shifts/{id}")),
        ("POST", "/v1/office/shifts".to_owned()),
    ] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request(method, &path), &admin.key)))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn a_plan_needs_an_active_product_an_active_line_and_a_fitting_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = |purpose: &str, enabled: bool, codes: Value| {
        json!({
            "name": "Другой", "purpose": purpose, "enabled": enabled,
            "chzProductGroupCodes": codes, "spec": { "widthMm": 58 }
        })
    };
    let mut ids = Vec::new();
    for body in [
        template("pallet", true, Value::Null),
        template("box", false, Value::Null),
        template("box", true, json!([15])),
    ] {
        let (status, created) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        ids.push(created["id"].clone());
    }
    let (status, draft) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    let (status, archived) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": "04600682000037", "name": "Ряженка", "chzProductGroupCode": 8,
                "boxCapacity": 12, "palletBoxCapacity": 40
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let mut archive = archived.clone();
    for computed in ["id", "status", "rev"] {
        archive.as_object_mut().unwrap().remove(computed);
    }
    archive["archived"] = json!(true);
    archive["expectedRev"] = archived["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", archived["id"].as_str().unwrap()),
            Some(archive),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.other_line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, counterparty) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{counterparty}");
    let (status, body) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                counterparty["id"].as_str().unwrap()
            ),
            Some(json!({
                "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [],
                "archived": true, "expectedRev": counterparty["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    let inactive = (
        json!("conflict"),
        json!({ "constraint": "product_inactive" }),
    );
    for (change, expected) in [
        (
            json!({ "productId": "no-such-product" }),
            field("productId"),
        ),
        (json!({ "productId": draft["id"] }), inactive.clone()),
        (json!({ "productId": archived["id"] }), inactive),
        (json!({ "lineId": "no-such-line" }), field("lineId")),
        (json!({ "lineId": setup.other_line }), field("lineId")),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "counterpartyId": counterparty["id"] }),
            field("counterpartyId"),
        ),
        (
            json!({ "boxTemplateId": "no-such-template" }),
            field("boxTemplateId"),
        ),
        (json!({ "boxTemplateId": ids[0] }), field("boxTemplateId")),
        (json!({ "boxTemplateId": ids[1] }), field("boxTemplateId")),
        (json!({ "boxTemplateId": ids[2] }), field("boxTemplateId")),
        (
            json!({ "productionDate": "2026-02-29" }),
            field("productionDate"),
        ),
        (
            json!({ "productionDate": " 2026-10-08" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "plannedQty": 10_000_001 }), field("plannedQty")),
        (json!({ "boxCapacity": 0 }), field("boxCapacity")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        let expected_status = if expected.0 == "conflict" {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        assert_eq!(
            (status, refusal(&refused)),
            (expected_status, expected),
            "{change}"
        );
    }
    // A field the request may not carry, and a mode no build knows.
    for change in [
        json!({ "status": "active" }),
        json!({ "number": "OCT26-001" }),
        json!({ "mode": "pallets" }),
        json!({ "plannedQty": -1 }),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{change}"
        );
        assert!(refused["error"]["details"].is_null(), "{change}: {refused}");
    }
    // Nothing was written: no row, no revision, no number drawn.
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list, json!([]));
    let counters: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_number_counters")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(counters, 0);
}

#[tokio::test]
async fn the_list_holds_open_shifts_and_recent_closed_ones_or_a_period() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // The host's clock reads 2026-09-21, so the last 31 days start on
    // 2026-08-21.
    let mut shifts = Vec::new();
    for date in ["2026-01-10", "2026-08-20", "2026-08-21", "2026-12-01"] {
        let mut body = shift_body(&setup);
        body["productionDate"] = json!(date);
        shifts.push(plan_shift(&admin, body).await);
    }
    close_directly(&admin, &shifts[1]).await;
    close_directly(&admin, &shifts[2]).await;
    let read = |shift: &Value| shift["id"].clone();
    let ids = |list: &Value| -> Vec<Value> { list.as_array().unwrap().iter().map(read).collect() };

    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    // Newest production date first; the planned shift of January stays.
    assert_eq!(
        ids(&list),
        vec![read(&shifts[3]), read(&shifts[2]), read(&shifts[0])]
    );
    let period = |query: &str| format!("/v1/office/shifts?{query}");
    for (query, expected) in [
        (
            "from=2026-01-01&to=2026-08-20",
            vec![read(&shifts[1]), read(&shifts[0])],
        ),
        ("from=2026-08-21", vec![read(&shifts[3]), read(&shifts[2])]),
        ("to=2026-01-10", vec![read(&shifts[0])]),
        ("from=2026-08-20&to=2026-08-20", vec![read(&shifts[1])]),
    ] {
        let (status, list) = admin.call("GET", &period(query), None).await;
        assert_eq!((status, ids(&list)), (StatusCode::OK, expected), "{query}");
    }
    for (query, field) in [
        ("from=2026-02-30", Some("from")),
        ("to=26-01-01", Some("to")),
        ("from=2026-09-02&to=2026-09-01", Some("to")),
        ("status=closed", None),
    ] {
        let (status, refused) = admin.call("GET", &period(query), None).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, field),
            "{query}"
        );
    }
}
```

2. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .collect()
}

```

заменить на

<!-- prettier-ignore -->
```rust
        .collect()
}

/// What a shift is planned from: an active product of the milk group (8)
/// that holds 12 units a box, a box template for every category, and the
/// wizard's two lines.
pub struct ShiftSetup {
    pub product: String,
    pub template: String,
    pub line: String,
    pub other_line: String,
}

/// Create the product and the template through the office API (revisions 2
/// and 3 after the wizard's 1) and find the wizard's lines.
pub async fn shift_setup(admin: &Admin) -> ShiftSetup {
    let (status, template) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(serde_json::json!({
                "name": "Короб 58×40",
                "purpose": "box",
                "enabled": true,
                "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, product) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(serde_json::json!({
                "gtin14": "04600682000013",
                "name": "Молоко 3,2% 0,9 л",
                "printName": "Молоко 3,2%",
                "chzProductGroupCode": 8,
                "boxCapacity": 12,
                "palletBoxCapacity": 40,
                "shelfLifeDays": 10
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{product}");
    let (status, lines) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK, "{lines}");
    let line = |name: &str| {
        lines
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["name"] == name)
            .and_then(|line| line["id"].as_str())
            .unwrap_or_else(|| panic!("the wizard made {name}"))
            .to_owned()
    };
    ShiftSetup {
        product: product["id"].as_str().unwrap().to_owned(),
        template: template["id"].as_str().unwrap().to_owned(),
        line: line("Линия 1"),
        other_line: line("Линия 2"),
    }
}

/// The smallest plan of a shift: the product, the first line, the template
/// and 8 October 2026.
pub fn shift_body(setup: &ShiftSetup) -> Value {
    serde_json::json!({
        "productId": setup.product,
        "lineId": setup.line,
        "productionDate": "2026-10-08",
        "boxTemplateId": setup.template
    })
}

/// Plan a shift of `body` as the administrator; returns the record.
pub async fn plan_shift(admin: &Admin, body: Value) -> Value {
    let (status, shift) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

```

3. Создать `apps/standalone/proto/fixtures/office-shift.json`:

<!-- prettier-ignore -->
```json
{
  "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "number": "OCT26-004",
  "status": "active",
  "mode": "aggregation",
  "palletsEnabled": false,
  "createdFrom": "office",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "counterpartyId": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  "productionDate": "2026-10-08",
  "plannedQty": 1200,
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
  "closedAt": null,
  "closeReasonCode": null,
  "closeReasonText": null,
  "lateDataAt": null,
  "createdAt": "2026-10-07T15:30:00Z",
  "rev": 71
}
```

4. Создать `apps/standalone/proto/fixtures/shift-create.json`:

<!-- prettier-ignore -->
```json
{
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "productionDate": "2026-10-08",
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "boxCapacity": 12,
  "plannedQty": 1200,
  "counterpartyId": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  "mode": "aggregation",
  "palletsEnabled": false
}
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, ShiftOrigin, TemplatePurpose,
        UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

заменить на

<!-- prettier-ignore -->
```rust
#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, ShiftMode, ShiftOrigin,
        ShiftStatus, TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        origins
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

заменить на

<!-- prettier-ignore -->
```rust
        origins
    }

    /// Every `ShiftStatus`, listed the same way.
    fn shift_statuses() -> Vec<ShiftStatus> {
        let statuses = vec![
            ShiftStatus::Planned,
            ShiftStatus::Active,
            ShiftStatus::Closed,
        ];
        for status in &statuses {
            match status {
                ShiftStatus::Planned | ShiftStatus::Active | ShiftStatus::Closed => {}
            }
        }
        statuses
    }

    /// Every `ShiftMode`, listed the same way.
    fn shift_modes() -> Vec<ShiftMode> {
        let modes = vec![ShiftMode::Aggregation, ShiftMode::Validation];
        for mode in &modes {
            match mode {
                ShiftMode::Aggregation | ShiftMode::Validation => {}
            }
        }
        modes
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

7. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            assert_eq!(origin.as_str().parse::<ShiftOrigin>(), Ok(origin));
            assert_eq!(serde_json::to_value(origin).unwrap(), origin.as_str());
        }
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
```

заменить на

<!-- prettier-ignore -->
```rust
            assert_eq!(origin.as_str().parse::<ShiftOrigin>(), Ok(origin));
            assert_eq!(serde_json::to_value(origin).unwrap(), origin.as_str());
        }
        for status in shift_statuses() {
            assert_eq!(status.as_str().parse::<ShiftStatus>(), Ok(status));
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
        for mode in shift_modes() {
            assert_eq!(mode.as_str().parse::<ShiftMode>(), Ok(mode));
            assert_eq!(serde_json::to_value(mode).unwrap(), mode.as_str());
        }
        assert_eq!(ShiftMode::default(), ShiftMode::Aggregation);
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeUser, OfficeUserCreate,
    OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate, OperatorRecord,
    OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode,
    PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup, ProductRecord,
    ProductStatus, ProductUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate,
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus,
    SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate,
    TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

9. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "{input:?}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            "{input:?}"
        );
    }
}

#[test]
fn office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status() {
    let shift: OfficeShift = round_trip("office-shift.json");
    assert_eq!(
        (shift.status, shift.mode, shift.created_from),
        (
            ShiftStatus::Active,
            ShiftMode::Aggregation,
            ShiftOrigin::Office
        )
    );
    let create: ShiftCreate = round_trip("shift-create.json");
    assert_eq!(
        (&create.product_id, &create.line_id, &create.box_template_id),
        (&shift.product_id, &shift.line_id, &shift.box_template_id)
    );
    // Left out, the mode is aggregation, pallets are off and the optional
    // fields are none.
    let bare: ShiftCreate = serde_json::from_value(serde_json::json!({
        "productId": create.product_id, "lineId": create.line_id,
        "productionDate": "2026-10-08", "boxTemplateId": create.box_template_id
    }))
    .unwrap();
    assert_eq!(
        (
            bare.mode,
            bare.pallets_enabled,
            bare.box_capacity,
            bare.planned_qty,
            bare.counterparty_id
        ),
        (ShiftMode::Aggregation, false, None, None, None)
    );
    // The host draws the number and owns the status.
    for field in ["number", "status"] {
        let mut value = fixture("shift-create.json");
        value[field] = Value::String("planned".into());
        assert!(
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
}

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL — 6 тестов из 6: маршрутов нет, и запросы получают `404` там, где ждут `200` (`plan_shift`) или `400` на `productId` (`a_plan_needs_an_active_product_an_active_line_and_a_fitting_template` получает `(404, not_found)`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `super::ShiftMode`, `super::ShiftStatus` ``.

- [ ] **Step 3: Миграция, роль, проверки и маршруты плана**

1. Создать `apps/standalone/host/migrations/0009_shifts_sscc_blocks.sql`:

<!-- prettier-ignore -->
```sql
-- Shifts and SSCC blocks (stage 2a spec §4.1). A shift is planned in the
-- office or created at a station while the host answers; a station opens it,
-- and the host freezes its snapshot then (the product, the box template's
-- layout, the SSCC issuer prefix and the counterparty's name), so a change of
-- the catalog never changes a shift that runs. Stage 2a puts one device on a
-- shift. Caps that only keep a typing slip out (a box's capacity, a plan)
-- live in `validate.rs`; the CHECKs here hold what no row may break.

-- The number of a shift is drawn from a counter per month (`MONYY`), as the
-- cloud's `shift_number_counters`, without a tenant.
CREATE TABLE shift_number_counters (
  month_key TEXT PRIMARY KEY CHECK (length(month_key) = 5),
  last_seq INTEGER NOT NULL CHECK (last_seq > 0)
);

-- `box_template_id` has no foreign key: once the shift is open its layout
-- lives in `snapshot`, and a template a planned shift names is never deleted
-- (`template_in_use`, `routes/templates.rs`). `create_request_id` is a
-- station's (a repeated create answers the same shift); an office's is NULL,
-- and NULLs never collide in the unique key. `mode` and `pallets_enabled`
-- are the cloud's shape; stage 2a takes only aggregation without pallets.
CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  number_month_key TEXT NOT NULL,
  number_seq INTEGER NOT NULL CHECK (number_seq > 0),
  created_from TEXT NOT NULL CHECK (created_from IN ('office', 'station')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('office_user', 'device')),
  created_by TEXT NOT NULL,
  create_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  mode TEXT NOT NULL CHECK (mode IN ('aggregation', 'validation')),
  pallets_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pallets_enabled IN (0, 1)),
  product_id TEXT NOT NULL REFERENCES products (id),
  line_id TEXT NOT NULL REFERENCES lines (id),
  counterparty_id TEXT REFERENCES counterparties (id),
  production_date TEXT NOT NULL
    CHECK (production_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  planned_qty INTEGER CHECK (planned_qty IS NULL OR planned_qty > 0),
  box_capacity INTEGER NOT NULL CHECK (box_capacity > 0),
  pallet_box_capacity INTEGER CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0),
  box_template_id TEXT NOT NULL,
  pallet_template_id TEXT,
  owner_device_id TEXT REFERENCES devices (id),
  snapshot TEXT CHECK (snapshot IS NULL OR (json_valid(snapshot)
    AND json_type(snapshot) = 'object' AND length(CAST(snapshot AS BLOB)) <= 327680)),
  opened_at TEXT,
  closed_at TEXT,
  closed_by_kind TEXT CHECK (closed_by_kind IS NULL OR closed_by_kind IN ('office_user', 'device')),
  closed_by TEXT,
  close_reason_code TEXT,
  close_reason_text TEXT,
  late_data_at TEXT,
  created_at TEXT NOT NULL,
  rev INTEGER NOT NULL,
  UNIQUE (number_month_key, number_seq),
  UNIQUE (created_by, create_request_id),
  CHECK ((status = 'planned')
    = (snapshot IS NULL AND opened_at IS NULL AND owner_device_id IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by_kind IS NOT NULL))
);
CREATE INDEX shifts_line_status ON shifts (line_id, status);
CREATE INDEX shifts_status_production_date ON shifts (status, production_date);
CREATE INDEX shifts_planned_box_template ON shifts (box_template_id) WHERE status = 'planned';

-- The devices that entered a shift: at most one row per shift in stage 2a.
CREATE TABLE shift_participants (
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  first_entered_at TEXT NOT NULL,
  last_entered_at TEXT NOT NULL,
  PRIMARY KEY (shift_id, device_id)
);
CREATE INDEX shift_participants_device ON shift_participants (device_id);

-- A block of SSCC serials issued to one device. Issuing moves its counter
-- past the block in the same transaction, so a block always lies below the
-- counter, and the counter's forward-only rule (`sscc_below_floor`) keeps
-- every issued serial from being issued again. A repeated request of the
-- same device answers the same block.
CREATE TABLE sscc_blocks (
  id TEXT PRIMARY KEY,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  device_id TEXT NOT NULL REFERENCES devices (id),
  request_id TEXT NOT NULL,
  from_serial INTEGER NOT NULL CHECK (from_serial >= 0),
  to_serial INTEGER NOT NULL,
  consumed_through INTEGER,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (device_id, request_id),
  CHECK (to_serial >= from_serial),
  FOREIGN KEY (issuer_prefix, extension) REFERENCES sscc_counters (issuer_prefix, extension)
);
CREATE INDEX sscc_blocks_prefix_device ON sscc_blocks (issuer_prefix, extension, device_id);
```

2. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
    /// A shift planned in the office or created at a station.
    pub const SHIFT_CREATE: &str = "shift.create";
}

/// `details.reason` of a denied row: every denial names one.
```

3. В `apps/standalone/host/src/auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }
}

/// Whether a role changes the catalog, label templates and their defaults
```

заменить на

<!-- prettier-ignore -->
```rust
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }

    /// The early check of a shift write: planning, editing, deleting and
    /// closing a shift (stage 2a spec §4.9, `planShifts`).
    pub fn require_shift_planning(&self) -> Result<(), ApiError> {
        if plans_shifts(self.user.role) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a shift planning role is required"))
        }
    }

    /// Re-check shift planning rights inside the caller's write
    /// transaction, as [`Self::require_catalog_in`] does for the catalog.
    pub async fn require_shift_planning_in(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<(), ApiError> {
        if plans_shifts(self.live_role_in(conn).await?) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a shift planning role is required"))
        }
    }
}

/// Whether a role plans, edits, deletes and closes shifts (stage 2a spec
/// §4.9: administrators and technologists). No wildcard arm: a new role does
/// not compile until it is placed here.
pub fn plans_shifts(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
    }
}

/// Whether a role changes the catalog, label templates and their defaults
```

4. В `apps/standalone/host/src/routes/devices.rs` фрагмент

<!-- prettier-ignore -->
```rust
    read_info(&mut conn, &device).await.map(Json)
}

/// `line_id` names an existing, active line.
async fn require_active_line(conn: &mut SqliteConnection, line_id: &str) -> Result<(), ApiError> {
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(line_id)
        .fetch_optional(conn)
```

заменить на

<!-- prettier-ignore -->
```rust
    read_info(&mut conn, &device).await.map(Json)
}

/// `line_id` names an existing, active line: `validation_failed` on
/// `lineId` otherwise.
pub async fn require_active_line(
    conn: &mut SqliteConnection,
    line_id: &str,
) -> Result<(), ApiError> {
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(line_id)
        .fetch_optional(conn)
```

5. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
pub mod org;
```

6. Создать `apps/standalone/host/src/routes/office_shifts.rs`:

<!-- prettier-ignore -->
```rust
//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST` (administrators and technologists,
//! `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftCreate, ShiftMode};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
use crate::validate;

const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, owner_device_id, opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev FROM shifts";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    mode: String,
    pallets_enabled: bool,
    product_id: String,
    line_id: String,
    counterparty_id: Option<String>,
    production_date: String,
    planned_qty: Option<u32>,
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
    close_reason_code: Option<String>,
    close_reason_text: Option<String>,
    late_data_at: Option<String>,
    created_at: String,
    rev: i64,
}

fn record(row: ShiftRow) -> Result<OfficeShift, ApiError> {
    let created_from = row.created_from.parse().map_err(ApiError::internal)?;
    Ok(OfficeShift {
        number: shifts::format_number(&row.number_month_key, row.number_seq, created_from),
        id: row.id,
        status: row.status.parse().map_err(ApiError::internal)?,
        mode: row.mode.parse().map_err(ApiError::internal)?,
        pallets_enabled: row.pallets_enabled,
        created_from,
        product_id: row.product_id,
        line_id: row.line_id,
        counterparty_id: row.counterparty_id,
        production_date: row.production_date,
        planned_qty: row.planned_qty,
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        close_reason_code: row.close_reason_code,
        close_reason_text: row.close_reason_text,
        late_data_at: row.late_data_at,
        created_at: row.created_at,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeShift>, ApiError> {
    let row: Option<ShiftRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// How far back the list without a period reaches for closed shifts, by
/// their production date on the host's clock (UTC).
const RECENT_DAYS: i64 = 31;

/// `GET /v1/office/shifts?from=&to=`: a period of production dates, both
/// ends included; either may be left out.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShiftListQuery {
    from: Option<String>,
    to: Option<String>,
}

/// `GET /v1/office/shifts`: without a period every planned and active shift
/// and the closed ones produced in the last 31 days; with one, every shift
/// produced in it. Newest production date first.
pub async fn list_shifts(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ShiftListQuery>,
) -> Result<Json<Vec<OfficeShift>>, ApiError> {
    let order = "ORDER BY production_date DESC, created_at DESC, number_month_key DESC, \
                 number_seq DESC, id";
    let rows: Vec<ShiftRow> = if query.from.is_none() && query.to.is_none() {
        let cutoff = state.now().date() - time::Duration::days(RECENT_DAYS);
        sqlx::query_as(&format!(
            "{SELECT} WHERE status <> 'closed' OR production_date >= ? {order}"
        ))
        .bind(shifts::civil_text(cutoff))
        .fetch_all(&state.pool)
        .await
    } else {
        let from = query
            .from
            .as_deref()
            .map(|from| validate::civil_date("from", from))
            .transpose()?;
        let to = query
            .to
            .as_deref()
            .map(|to| validate::civil_date("to", to))
            .transpose()?;
        if let (Some(from), Some(to)) = (from, to) {
            if from > to {
                return Err(ApiError::validation(
                    "to",
                    "the period ends before it starts",
                ));
            }
        }
        sqlx::query_as(&format!(
            "{SELECT} WHERE production_date >= ? AND production_date <= ? {order}"
        ))
        .bind(from.map_or_else(|| "0001-01-01".to_owned(), shifts::civil_text))
        .bind(to.map_or_else(|| "9999-12-31".to_owned(), shifts::civil_text))
        .fetch_all(&state.pool)
        .await
    }
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn get_shift(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShift>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read(&mut conn, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// Stage 2a takes only aggregation without pallets (spec decision 6): the
/// fields are there so stages 2b and 3 need no new shape.
pub fn check_mode(mode: ShiftMode, pallets_enabled: bool) -> Result<(), ApiError> {
    if mode != ShiftMode::Aggregation {
        return Err(ApiError::validation(
            "mode",
            "only aggregation shifts are taken for now",
        ));
    }
    if pallets_enabled {
        return Err(ApiError::validation(
            "palletsEnabled",
            "shifts with pallets are not taken for now",
        ));
    }
    Ok(())
}

/// `POST /v1/office/shifts`: a planned shift of an active product on an
/// active line, with a box template that fits the product.
pub async fn create_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<ShiftCreate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(create.mode, create.pallets_enabled)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
    validate::count(
        "boxCapacity",
        create.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    require_active_line(&mut tx, &create.line_id).await?;
    if let Some(counterparty_id) = &create.counterparty_id {
        shifts::check_counterparty(&mut tx, counterparty_id).await?;
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
        &mut tx,
        &NewShift {
            origin: markiro_proto::ShiftOrigin::Office,
            created_by: &context.user.id,
            request_id: None,
            product_id: &create.product_id,
            line_id: &create.line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
        },
        &at,
        rev,
    )
    .await?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_CREATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": created.number,
                "productId": created.product_id,
                "lineId": created.line_id,
                "productionDate": created.production_date,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}
```

7. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
                .put(crate::routes::template_defaults::put_template_defaults),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
                .put(crate::routes::template_defaults::put_template_defaults),
        )
        .route(
            "/v1/office/shifts",
            get(crate::routes::office_shifts::list_shifts)
                .post(crate::routes::office_shifts::create_shift),
        )
        .route(
            "/v1/office/shifts/{id}",
            get(crate::routes::office_shifts::get_shift),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

8. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::ShiftOrigin;

/// The month names of a shift number: a fixed English table, never a
/// locale's, because the number is an identifier.
```

заменить на

<!-- prettier-ignore -->
```rust
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{ProductStatus, ShiftMode, ShiftOrigin, ShiftStatus, TemplatePurpose};
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::templates;

/// The month names of a shift number: a fixed English table, never a
/// locale's, because the number is an identifier.
```

9. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    format!("{month_key}-{seq:03}{station}")
}

```

заменить на

<!-- prettier-ignore -->
```rust
    format!("{month_key}-{seq:03}{station}")
}

/// What a new shift's product gives it: the product group its box template
/// must cover, and the box capacity a shift takes when it names none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftProduct {
    pub group: u32,
    pub box_capacity: u32,
}

/// `conflict` on `product_inactive`: the product is a draft or archived.
pub fn product_inactive() -> ApiError {
    ApiError::conflict(
        "product_inactive",
        "the product is a draft or archived: a shift needs a product in use",
    )
}

/// The product a new shift is made of: an active product (a group and both
/// capacities) that is not archived. No such product is `validation_failed`
/// on `productId`; a draft or an archived one is `product_inactive`.
pub async fn shift_product(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<ShiftProduct, ApiError> {
    let row: Option<(String, bool, Option<u32>, Option<u32>)> = sqlx::query_as(
        "SELECT status, archived, chz_group_code, box_capacity FROM products WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let (status, archived, group, box_capacity) =
        row.ok_or_else(|| ApiError::validation("productId", "no such product"))?;
    match (
        status.parse::<ProductStatus>(),
        archived,
        group,
        box_capacity,
    ) {
        (Ok(ProductStatus::Active), false, Some(group), Some(box_capacity)) => Ok(ShiftProduct {
            group,
            box_capacity,
        }),
        _ => Err(product_inactive()),
    }
}

/// `validation_failed` on `counterpartyId` unless `id` names a counterparty
/// that is not archived.
pub async fn check_counterparty(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let archived: Option<bool> =
        sqlx::query_scalar("SELECT archived FROM counterparties WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    if archived == Some(false) {
        Ok(())
    } else {
        Err(ApiError::validation(
            "counterpartyId",
            "no such counterparty in use",
        ))
    }
}

/// `validation_failed` on `boxTemplateId` unless `id` names a box template
/// that fits a product of `group` (`templates::fits`: enabled, of the box
/// purpose, covering the group).
pub async fn check_box_template(
    conn: &mut SqliteConnection,
    id: &str,
    group: u32,
) -> Result<(), ApiError> {
    templates::check_slot(conn, "boxTemplateId", id, TemplatePurpose::Box, Some(group)).await
}

/// A new shift after the request's own checks and the references' checks.
pub struct NewShift<'a> {
    pub origin: ShiftOrigin,
    /// The office user's id or the station's.
    pub created_by: &'a str,
    /// A station's request id; the office sends none.
    pub request_id: Option<&'a str>,
    pub product_id: &'a str,
    pub line_id: &'a str,
    pub counterparty_id: Option<&'a str>,
    pub production_date: time::Date,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: &'a str,
}

/// Insert a planned shift at `rev` and return its id. The number is the
/// next of its month's counter, drawn in the same transaction.
pub async fn insert(
    conn: &mut SqliteConnection,
    shift: &NewShift<'_>,
    at: &str,
    rev: i64,
) -> Result<String, ApiError> {
    let key = month_key(shift.production_date);
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?, 1) \
         ON CONFLICT (month_key) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq",
    )
    .bind(&key)
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_by_kind = match shift.origin {
        ShiftOrigin::Office => "office_user",
        ShiftOrigin::Station => "device",
    };
    sqlx::query(
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, create_request_id, status, mode, pallets_enabled, product_id, line_id, \
         counterparty_id, production_date, planned_qty, box_capacity, box_template_id, \
         created_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&key)
    .bind(seq)
    .bind(shift.origin.as_str())
    .bind(created_by_kind)
    .bind(shift.created_by)
    .bind(shift.request_id)
    .bind(ShiftStatus::Planned.as_str())
    .bind(ShiftMode::Aggregation.as_str())
    .bind(shift.product_id)
    .bind(shift.line_id)
    .bind(shift.counterparty_id)
    .bind(civil_text(shift.production_date))
    .bind(shift.planned_qty)
    .bind(shift.box_capacity)
    .bind(shift.box_template_id)
    .bind(at)
    .bind(rev)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(id)
}

/// A civil date as `YYYY-MM-DD`, the way the host stores it.
pub fn civil_text(date: time::Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

```

10. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}

/// The largest plan of a shift. The cloud bounds none (`min(1)`); this cap
/// only keeps a typing slip out of production.
pub const MAX_PLANNED_QTY: u32 = 10_000_000;

/// A civil date `YYYY-MM-DD` of the years 1-9999 (`shifts::civil_date`),
/// not trimmed: a date is no free text, and the office sends what its date
/// field holds.
pub fn civil_date(field: &str, text: &str) -> Result<time::Date, ApiError> {
    crate::shifts::civil_date(text)
        .ok_or_else(|| ApiError::validation(field, "a real calendar date YYYY-MM-DD is required"))
}

/// An identifier the client makes up (a station's request id): a UUID in
/// its canonical form, lower-case and hyphenated, as `crypto.randomUUID()`
/// writes it, so one id never has two spellings.
pub fn client_uuid(field: &str, text: &str) -> Result<(), ApiError> {
    match uuid::Uuid::try_parse(text) {
        Ok(parsed) if parsed.hyphenated().to_string() == text => Ok(()),
        _ => Err(ApiError::validation(
            field,
            "a lower-case hyphenated UUID is required",
        )),
    }
}

```

11. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    }
}

/// A shift's status: planned in the office, active once a station opened it
/// (and froze its snapshot), closed for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftStatus {
    Planned,
    Active,
    Closed,
}

impl ShiftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftStatus::Planned => "planned",
            ShiftStatus::Active => "active",
            ShiftStatus::Closed => "closed",
        }
    }
}

impl std::str::FromStr for ShiftStatus {
    type Err = UnknownVariant;

    /// The name [`ShiftStatus::as_str`] gives, as `shifts.status` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift status", text)
    }
}

/// What a shift does, as the cloud's: aggregation into boxes, or validation
/// of single codes. The host takes only aggregation in stage 2a; validation
/// (stage 3) needs no new shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftMode {
    #[default]
    Aggregation,
    Validation,
}

impl ShiftMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftMode::Aggregation => "aggregation",
            ShiftMode::Validation => "validation",
        }
    }
}

impl std::str::FromStr for ShiftMode {
    type Err = UnknownVariant;

    /// The name [`ShiftMode::as_str`] gives, as `shifts.mode` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift mode", text)
    }
}

/// A shift as the office sees it (`GET /v1/office/shifts`, `GET …/{id}` and
/// the answer of every office write). `number` is the host's
/// (`OCT26-004`, `/S` for a station's). Names come from the office's own
/// lists of products, lines and counterparties.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub mode: ShiftMode,
    pub pallets_enabled: bool,
    pub created_from: ShiftOrigin,
    pub product_id: String,
    pub line_id: String,
    pub counterparty_id: Option<String>,
    /// The shift's civil date, `YYYY-MM-DD`; the number's month comes from it.
    pub production_date: String,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: String,
    /// The station that opened the shift; `null` while it is planned.
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    /// One of the domain's six `SHIFT_CLOSE_REASON_CODES`, from a station's
    /// close (plan 2a2).
    pub close_reason_code: Option<String>,
    /// The office's words when it closed the shift.
    pub close_reason_text: Option<String>,
    /// When facts first arrived after the shift was closed (plan 2a2).
    pub late_data_at: Option<String>,
    pub created_at: String,
    pub rev: i64,
}

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
/// product's; `mode` left out is aggregation and `palletsEnabled` false,
/// the only values stage 2a takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftCreate {
    pub product_id: String,
    pub line_id: String,
    pub production_date: String,
    pub box_template_id: String,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub planned_qty: Option<u32>,
    #[serde(default)]
    pub counterparty_id: Option<String>,
    #[serde(default)]
    pub mode: ShiftMode,
    #[serde(default)]
    pub pallets_enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::{
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: PASS — 6 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 35 тестов фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
  defaults, which administrators and technologists make (spec §4.8,
  `editCatalog`) — check `require_catalog` early and `require_catalog_in`
  inside the transaction; `auth::edits_catalog` names the roles, with no
  wildcard arm, so a new role does not compile until it is placed.

## Change feed

```

заменить на

<!-- prettier-ignore -->
```text
  defaults, which administrators and technologists make (spec §4.8,
  `editCatalog`) — check `require_catalog` early and `require_catalog_in`
  inside the transaction; `auth::edits_catalog` names the roles, with no
  wildcard arm, so a new role does not compile until it is placed. Shift
  writes — planning, editing, deleting and closing, which administrators and
  technologists make (stage 2a spec §4.9, `planShifts`) — check
  `require_shift_planning` and `require_shift_planning_in` the same way, and
  `auth::plans_shifts` names their roles, also with no wildcard arm.

## Change feed

```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
year out. A number is drawn once, when the shift is created: an edit of the
production date keeps it, and a deleted shift's number is not drawn again.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
year out. A number is drawn once, when the shift is created: an edit of the
production date keeps it, and a deleted shift's number is not drawn again.

The office plans a shift (`POST /v1/office/shifts`; migration
`0009_shifts_sscc_blocks.sql`): an active product that is not archived (a
draft or an archived one is `conflict` on `product_inactive`, an unknown one
`validation_failed` on `productId`), an active line, a counterparty in use or
none, a box template that fits the product (`templates::fits`: enabled, of
the box purpose, covering the product's group), the production date, a box
capacity (the product's when left out; at most `MAX_BOX_CAPACITY`) and a plan
or none (at most `MAX_PLANNED_QTY`, 10 000 000). `mode` and `palletsEnabled`
are the cloud's shape; stage 2a takes only `aggregation` and `false`
(`validation_failed` on either otherwise), so stages 2b and 3 need no new
shape. Every office role reads shifts (`GET /v1/office/shifts`, `GET …/{id}`);
administrators and technologists write them (`planShifts`, «Writes»). The
list without a period holds every planned and active shift and the closed
ones produced in the last 31 days of the host's clock (UTC); `?from=&to=`
(either may be left out) every shift produced in the period, both ends
included; newest production date first. A shift is no feed record, but every
change of one takes a host revision, stamped on its `rev`, with no feed item,
so open streams wake and stations read their shifts again. `OfficeShift`
carries ids, not names: the office names products, lines and counterparties
from its own lists.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — шаблон не проверяется. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev
```

заменить на

<!-- prettier-ignore -->
```rust
    let rev
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_plan_needs_an_active_product_an_active_line_and_a_fitting_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — список без периода теряет старые запланированные. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
WHERE status <> 'closed' OR production_date >= ?
```

заменить на

<!-- prettier-ignore -->
```rust
WHERE production_date >= ?
```

Run: та же команда.
Expected: FAIL `the_list_holds_open_shifts_and_recent_closed_ones_or_a_period`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — счётчик месяца не растёт. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
DO UPDATE SET last_seq = last_seq + 1
```

заменить на

<!-- prettier-ignore -->
```rust
DO UPDATE SET last_seq = last_seq
```

Run: та же команда.
Expected: FAIL `numbers_count_per_month_of_the_production_date` и `the_list_holds_open_shifts_and_recent_closed_ones_or_a_period` (второй номер месяца нарушает `UNIQUE`, хост отвечает `500`). Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-shift.json apps/standalone/proto/fixtures/shift-create.json apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 316 тестов, `proto` 40.

```bash
git add apps/standalone/host/migrations/0009_shifts_sscc_blocks.sql apps/standalone/host/src/shifts.rs apps/standalone/host/src/auth.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/routes/devices.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-shift.json apps/standalone/proto/fixtures/shift-create.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): shifts in the host's model and the office's plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Правка и удаление смены из офиса, `template_in_use`

`PUT /v1/office/shifts/{id}` — частичный: меняется только присланное, с `expectedRev`. Запланированная смена меняет всё, кроме товара (его нет среди полей запроса, `deny_unknown_fields`); активная — только план; закрытая — ничего (`shift_status` с `details.status`). Изменённые линия, шаблон и контрагент проверяются как при планировании, неизменённые остаются — их проверит открытие (`template_not_fit`, задача 5). Удаляется только запланированная смена; удаление берёт ревизию, чтобы станции убрали её из списка. Шаблон, который назвала запланированная смена, не удаляется (`template_in_use`): макет попадёт в снимок только при открытии. Открытую смену тест задаёт прямо в таблице (вход — задача 5).

**Files:**

- Create: `apps/standalone/proto/fixtures/shift-update.json`
- Modify: `apps/standalone/host/src/routes/office_shifts.rs` (`update_shift`, `delete_shift`), `apps/standalone/host/src/shifts.rs` (`status_conflict`), `apps/standalone/host/src/routes/templates.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs` (`ShiftUpdate`)
- Test: `apps/standalone/host/tests/office_shifts.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Shifts»)

**Interfaces:**

- Consumes: задача 2 — `read`, `check_mode`, `shifts::{shift_product, check_box_template, check_counterparty, civil_text}`, `require_active_line`, `require_shift_planning(_in)`; `markiro_proto::nullable`.
- Produces:
  - `markiro_proto::ShiftUpdate { line_id, production_date, box_template_id, box_capacity, planned_qty: Option<Option<u32>>, counterparty_id: Option<Option<String>>, mode, pallets_enabled, expected_rev }`;
  - `pub fn markiro_host::shifts::status_conflict(status: ShiftStatus) -> ApiError` (`conflict`, `details: { constraint: "shift_status", status }`);
  - `audit::actions::{SHIFT_UPDATE, SHIFT_DELETE}`;
  - `routes::office_shifts::{update_shift, delete_shift}`; у `DELETE /v1/office/templates/{id}` — отказ `template_in_use` с `shiftIds`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Close a shift straight in its table, as if this station had opened and
```

заменить на

<!-- prettier-ignore -->
```rust
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Open a shift straight in its table, as if this station had entered it
/// (the station's entry comes with the device routes).
async fn open_directly(admin: &Admin, shift: &Value) {
    let device = station_id(admin).await;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = '{}', opened_at = ?, \
         owner_device_id = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(&device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// Close a shift straight in its table, as if this station had opened and
```

2. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "{query}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            "{query}"
        );
    }
}

/// A counterparty in use; returns its id.
async fn counterparty(admin: &Admin, name: &str) -> Value {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": name, "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

#[tokio::test]
async fn a_planned_shift_changes_what_is_sent_and_keeps_its_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let berth = counterparty(&admin, "ООО «Северный берег»").await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "lineId": setup.other_line, "productionDate": "2026-11-03", "boxCapacity": 6,
                "plannedQty": 1200, "counterpartyId": berth["id"], "expectedRev": 5
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let mut expected = planned(&id, "OCT26-001", &setup, 6);
    for (key, value) in [
        ("lineId", json!(setup.other_line)),
        ("productionDate", json!("2026-11-03")),
        ("boxCapacity", json!(6)),
        ("plannedQty", json!(1200)),
        ("counterpartyId", berth["id"].clone()),
    ] {
        expected[key] = value;
    }
    assert_eq!(updated, expected);
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["lineId", "productionDate", "boxCapacity", "plannedQty", "counterpartyId"],
                "lineId": { "from": setup.line, "to": setup.other_line },
                "productionDate": { "from": "2026-10-08", "to": "2026-11-03" },
                "boxCapacity": { "from": 12, "to": 6 },
                "plannedQty": { "from": null, "to": 1200 },
                "counterpartyId": { "from": null, "to": berth["id"] },
            })
        )]
    );
    // `null` clears the plan and the counterparty; a field left out stays.
    let (status, cleared) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": null, "counterpartyId": null, "expectedRev": 6 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        [
            cleared["plannedQty"].clone(),
            cleared["counterpartyId"].clone(),
            cleared["lineId"].clone(),
            cleared["rev"].clone()
        ],
        [Value::Null, Value::Null, json!(setup.other_line), json!(7)]
    );
    // The same values again change nothing: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "lineId": setup.other_line, "boxCapacity": 6, "expectedRev": 7 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, cleared.clone()));
    assert_eq!(host_revision(&admin.app).await, 7);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // An older revision and one ahead of the record are both stale.
    for expected_rev in [6, 8] {
        let (status, refused) = admin
            .call(
                "PUT",
                &path(&shift),
                Some(json!({ "plannedQty": 5, "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("stale_revision"), json!({ "currentRev": 7 }))
            )
        );
    }
    // A technologist edits too.
    let token = admin.technologist().await;
    let (status, edited) = admin
        .call_as(
            &token,
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 5, "expectedRev": 7 })),
        )
        .await;
    assert_eq!(
        (status, edited["plannedQty"].clone()),
        (StatusCode::OK, json!(5))
    );
}

#[tokio::test]
async fn an_edit_checks_a_changed_line_template_or_counterparty_and_keeps_unchanged_ones() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let berth = counterparty(&admin, "ООО «Берег»").await;
    let (status, other) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({ "name": "Пиво", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [15], "spec": { "widthMm": 58 } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    let mut body = shift_body(&setup);
    body["counterpartyId"] = berth["id"].clone();
    let shift = plan_shift(&admin, body).await;
    // The line, the template and the counterparty go out of use afterwards.
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, template) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", setup.template),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, archived) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                berth["id"].as_str().unwrap()
            ),
            Some(
                json!({ "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [],
                "archived": true, "expectedRev": berth["rev"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    // An edit that keeps them all still goes through.
    let rev = shift["rev"].as_i64().unwrap();
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "lineId": setup.line, "boxTemplateId": setup.template,
                "counterpartyId": berth["id"], "plannedQty": 100, "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    let rev = kept["rev"].as_i64().unwrap();
    let rows = audit_rows(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    let (status, line_two) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.other_line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line_two}");
    let rows = rows + 1;
    for (change, expected) in [
        (json!({ "lineId": setup.other_line }), field("lineId")),
        (json!({ "lineId": "no-such-line" }), field("lineId")),
        (
            json!({ "boxTemplateId": other["id"] }),
            field("boxTemplateId"),
        ),
        (
            json!({ "boxTemplateId": "no-such-template" }),
            field("boxTemplateId"),
        ),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "productionDate": "2026-13-01" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = json!(rev);
        let (status, refused) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    // The product never changes: it is no field of an edit.
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "productId": setup.product, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(refused["error"]["details"].is_null(), "{refused}");
    let (status, missing) = admin
        .call(
            "PUT",
            "/v1/office/shifts/no-such-shift",
            Some(json!({ "plannedQty": 1, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_active_shift_takes_only_its_plan_and_a_closed_one_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    let (status, planned_more) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 900, "lineId": setup.line, "expectedRev": 4 })),
        )
        .await;
    assert_eq!(
        (status, planned_more["plannedQty"].clone()),
        (StatusCode::OK, json!(900))
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({ "changed": ["plannedQty"], "plannedQty": { "from": null, "to": 900 } })
        )]
    );
    let status_conflict = |status: &str| json!({ "constraint": "shift_status", "status": status });
    for change in [
        json!({ "boxCapacity": 6 }),
        json!({ "lineId": setup.other_line }),
        json!({ "productionDate": "2026-10-09" }),
        json!({ "counterpartyId": null, "plannedQty": 800, "boxTemplateId": "other" }),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = json!(5);
        let (status, refused) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("conflict"), status_conflict("active"))
            ),
            "{change}"
        );
    }
    close_directly(&admin, &shift).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 1, "expectedRev": 5 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), status_conflict("closed"))
        )
    );
}

#[tokio::test]
async fn only_a_planned_shift_is_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, body) = admin.call("DELETE", &path(&shift), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    assert_eq!(host_revision(&admin.app).await, 5);
    assert_eq!(
        audit_trail(&admin.app, "shift.delete").await,
        vec![admin.row(
            "shift.delete",
            "shift",
            &id,
            json!({ "number": "OCT26-001" })
        )]
    );
    for method in ["GET", "DELETE"] {
        let (status, missing) = admin.call(method, &path(&shift), None).await;
        assert_eq!(
            (status, missing["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{method}"
        );
    }
    // The number is not drawn again.
    let next = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(next["number"], "OCT26-002");
    // An open shift and a closed one stay.
    open_directly(&admin, &next).await;
    let token = admin.technologist().await;
    let (status, refused) = admin.call_as(&token, "DELETE", &path(&next), None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "active" })
            )
        )
    );
    close_directly(&admin, &next).await;
    let (status, refused) = admin.call("DELETE", &path(&next), None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        )
    );
    // A technologist deletes a planned one.
    let third = plan_shift(&admin, shift_body(&setup)).await;
    let (status, _) = admin.call_as(&token, "DELETE", &path(&third), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn a_template_that_a_planned_shift_names_is_not_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let first = plan_shift(&admin, shift_body(&setup)).await;
    let second = plan_shift(&admin, shift_body(&setup)).await;
    let template = format!("/v1/office/templates/{}", setup.template);
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let mut planned_ids = vec![first["id"].clone(), second["id"].clone()];
    planned_ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let (status, refused) = admin.call("DELETE", &template, None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "template_in_use", "shiftIds": planned_ids })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (status, _) = admin.call("GET", &template, None).await;
    assert_eq!(status, StatusCode::OK);
    // An open shift keeps its layout in its snapshot; a deleted plan names
    // nothing.
    open_directly(&admin, &first).await;
    let (status, _) = admin.call("DELETE", &path(&second), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = admin.call("DELETE", &template, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

```

3. Создать `apps/standalone/proto/fixtures/shift-update.json`:

<!-- prettier-ignore -->
```json
{
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "productionDate": "2026-10-09",
  "plannedQty": null,
  "expectedRev": 71
}
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus,
    SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate,
    TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus,
    ShiftUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn a_shift_update_carries_only_what_changes_and_never_the_product() {
    let update: ShiftUpdate = round_trip("shift-update.json");
    // `plannedQty: null` clears the plan; an absent counterparty stays.
    assert_eq!(
        (update.planned_qty, update.counterparty_id.clone()),
        (Some(None), None)
    );
    let bare: ShiftUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 71 })).unwrap();
    assert_eq!(
        serde_json::to_value(&bare).unwrap(),
        serde_json::json!({ "expectedRev": 71 })
    );
    let mut value = fixture("shift-update.json");
    value["productId"] = Value::String("f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b".into());
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
}

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL — 5 тестов из 11 (6 прежних проходят): `PUT` и `DELETE` смены получают `405 method_not_allowed`, а удаление шаблона в `a_template_that_a_planned_shift_names_is_not_deleted` — `204` вместо `409`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_proto::ShiftUpdate` ``.

- [ ] **Step 3: Правка, удаление и `template_in_use`**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
    /// A shift planned in the office or created at a station.
    pub const SHIFT_CREATE: &str = "shift.create";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
    /// A shift planned in the office or created at a station.
    pub const SHIFT_CREATE: &str = "shift.create";
    pub const SHIFT_UPDATE: &str = "shift.update";
    pub const SHIFT_DELETE: &str = "shift.delete";
}

/// `details.reason` of a denied row: every denial names one.
```

2. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST` (administrators and technologists,
//! `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftCreate, ShiftMode};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

заменить на

<!-- prettier-ignore -->
```rust
//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST`, `PUT …/{id}` (with
//! `expectedRev`) and `DELETE …/{id}` (administrators and technologists,
//! `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftCreate, ShiftMode, ShiftStatus, ShiftUpdate};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

3. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Ok(Json(created))
}

```

заменить на

<!-- prettier-ignore -->
```rust
    Ok(Json(created))
}

/// `PUT /v1/office/shifts/{id}`: a planned shift changes every field it
/// sends (its product never changes); an active one only its plan, which
/// neither its label nor its snapshot shows; a closed one nothing. A line or
/// a template that changes is checked as at planning; one that stays is
/// kept even if it was archived, disabled or narrowed since (the station's
/// open then refuses the template: `template_not_fit`).
pub async fn update_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<ShiftUpdate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(
        update.mode.unwrap_or_default(),
        update.pallets_enabled.unwrap_or(false),
    )?;
    let production_date = update
        .production_date
        .as_deref()
        .map(|date| validate::civil_date("productionDate", date))
        .transpose()?;
    if let Some(planned_qty) = update.planned_qty {
        validate::count("plannedQty", planned_qty, validate::MAX_PLANNED_QTY)?;
    }
    validate::count(
        "boxCapacity",
        update.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let line_id = update
        .line_id
        .clone()
        .unwrap_or_else(|| current.line_id.clone());
    let production_date =
        production_date.map_or_else(|| current.production_date.clone(), shifts::civil_text);
    let box_template_id = update
        .box_template_id
        .clone()
        .unwrap_or_else(|| current.box_template_id.clone());
    let box_capacity = update.box_capacity.unwrap_or(current.box_capacity);
    let planned_qty = update.planned_qty.unwrap_or(current.planned_qty);
    let counterparty_id = update
        .counterparty_id
        .clone()
        .unwrap_or_else(|| current.counterparty_id.clone());
    let fixed_changed = line_id != current.line_id
        || production_date != current.production_date
        || box_template_id != current.box_template_id
        || box_capacity != current.box_capacity
        || counterparty_id != current.counterparty_id;
    match current.status {
        ShiftStatus::Planned => {
            if line_id != current.line_id {
                require_active_line(&mut tx, &line_id).await?;
            }
            if box_template_id != current.box_template_id {
                let product = shifts::shift_product(&mut tx, &current.product_id).await?;
                shifts::check_box_template(&mut tx, &box_template_id, product.group).await?;
            }
            if let Some(counterparty_id) = &counterparty_id {
                if current.counterparty_id.as_ref() != Some(counterparty_id) {
                    shifts::check_counterparty(&mut tx, counterparty_id).await?;
                }
            }
        }
        ShiftStatus::Active if !fixed_changed => {}
        status => return Err(shifts::status_conflict(status)),
    }
    let Some(details) = audit::update_details(&[
        ("lineId", json!(current.line_id), json!(line_id)),
        (
            "productionDate",
            json!(current.production_date),
            json!(production_date),
        ),
        (
            "boxTemplateId",
            json!(current.box_template_id),
            json!(box_template_id),
        ),
        (
            "boxCapacity",
            json!(current.box_capacity),
            json!(box_capacity),
        ),
        ("plannedQty", json!(current.planned_qty), json!(planned_qty)),
        (
            "counterpartyId",
            json!(current.counterparty_id),
            json!(counterparty_id),
        ),
    ]) else {
        // Nothing actually changed: report the shift as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET line_id = ?, production_date = ?, box_template_id = ?, \
         box_capacity = ?, planned_qty = ?, counterparty_id = ?, rev = ? WHERE id = ?",
    )
    .bind(&line_id)
    .bind(&production_date)
    .bind(&box_template_id)
    .bind(box_capacity)
    .bind(planned_qty)
    .bind(&counterparty_id)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_UPDATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// `DELETE /v1/office/shifts/{id}` → 204: only a planned shift, which no
/// station has entered (entering opens it). It takes a revision with no row
/// left to stamp, so stations drop it from their lists; its number is not
/// drawn again. A delete repeated after a lost answer is `not_found`.
pub async fn delete_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_shift_planning()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.status != ShiftStatus::Planned {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM shifts WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_DELETE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "number": current.number }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

```

4. В `apps/standalone/host/src/routes/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! and layout and is never deleted
//! (`stock_template`): it may be disabled or narrowed, and copied by a
//! `POST`. A template is never disabled, narrowed out of a category it is
//! the default of, or deleted while it is a default (`template_is_default`).
//! Deleting a template clears the products' preferences that name it, each
//! product at the delete's revision, and leaves a tombstone.

```

заменить на

<!-- prettier-ignore -->
```rust
//! and layout and is never deleted
//! (`stock_template`): it may be disabled or narrowed, and copied by a
//! `POST`. A template is never disabled, narrowed out of a category it is
//! the default of, or deleted while it is a default (`template_is_default`),
//! nor deleted while a planned shift names it (`template_in_use`).
//! Deleting a template clears the products' preferences that name it, each
//! product at the delete's revision, and leaves a tombstone.

```

5. В `apps/standalone/host/src/routes/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if usage.organization || !usage.categories.is_empty() {
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    // The products' preferences go first and take the revision, so a
    // station's copy of each product changes too (`ON DELETE SET NULL`
```

заменить на

<!-- prettier-ignore -->
```rust
    if usage.organization || !usage.categories.is_empty() {
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    // A planned shift prints with this template once a station opens it;
    // an open or closed shift has the layout in its snapshot.
    let planned: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM shifts WHERE box_template_id = ? AND status = 'planned' ORDER BY id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if !planned.is_empty() {
        return Err(ApiError::conflict(
            "template_in_use",
            "a planned shift prints with this template",
        )
        .with_details(json!({ "constraint": "template_in_use", "shiftIds": planned })));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    // The products' preferences go first and take the revision, so a
    // station's copy of each product changes too (`ON DELETE SET NULL`
```

6. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/shifts/{id}",
            get(crate::routes::office_shifts::get_shift),
        )
        .route(
            "/v1/office/users",
```

заменить на

<!-- prettier-ignore -->
```rust
        )
        .route(
            "/v1/office/shifts/{id}",
            get(crate::routes::office_shifts::get_shift)
                .put(crate::routes::office_shifts::update_shift)
                .delete(crate::routes::office_shifts::delete_shift),
        )
        .route(
            "/v1/office/users",
```

7. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{ProductStatus, ShiftMode, ShiftOrigin, ShiftStatus, TemplatePurpose};
use sqlx::SqliteConnection;

use crate::error::ApiError;
```

заменить на

<!-- prettier-ignore -->
```rust
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{ProductStatus, ShiftMode, ShiftOrigin, ShiftStatus, TemplatePurpose};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::error::ApiError;
```

8. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "product_inactive",
        "the product is a draft or archived: a shift needs a product in use",
    )
}

/// The product a new shift is made of: an active product (a group and both
```

заменить на

<!-- prettier-ignore -->
```rust
        "product_inactive",
        "the product is a draft or archived: a shift needs a product in use",
    )
}

/// `conflict` on `shift_status`, with the shift's status in `details`: the
/// request does not suit a shift in that status (an edit of a closed one, a
/// delete of an open one).
pub fn status_conflict(status: ShiftStatus) -> ApiError {
    ApiError::conflict("shift_status", "the shift's status does not allow this")
        .with_details(json!({ "constraint": "shift_status", "status": status.as_str() }))
}

/// The product a new shift is made of: an active product (a group and both
```

9. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub pallets_enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub pallets_enabled: bool,
}

/// `PUT /v1/office/shifts/{id}`: only the fields sent change, over
/// `expectedRev`. A planned shift takes every field but its product, which
/// is no field here; an active one only `plannedQty` (another field sent
/// with another value is `conflict` on `shift_status`); a closed one
/// nothing. `plannedQty: null` and `counterpartyId: null` clear them; `null`
/// in another field reads as «not sent» (see [`LineUpdate`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub planned_qty: Option<Option<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub counterparty_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ShiftMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallets_enabled: Option<bool>,
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --test templates --offline --locked`
Expected: PASS — 11 и 27 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 36 тестов фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
Deleting a template clears every product preference that names it at the
delete's revision, so those products ride the feed again, and leaves a
tombstone; a delete repeated after a lost answer finds the tombstone and
answers 204 again, and an id that never existed is `not_found`.

The defaults are one document (`GET/PUT /v1/office/template-defaults`): the
organization's default of each purpose (`defaultBoxTemplateId`,
```

заменить на

<!-- prettier-ignore -->
```text
Deleting a template clears every product preference that names it at the
delete's revision, so those products ride the feed again, and leaves a
tombstone; a delete repeated after a lost answer finds the tombstone and
answers 204 again, and an id that never existed is `not_found`. A template a
planned shift names is not deleted (`template_in_use`, see «Shifts»).

The defaults are one document (`GET/PUT /v1/office/template-defaults`): the
organization's default of each purpose (`defaultBoxTemplateId`,
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
carries ids, not names: the office names products, lines and counterparties
from its own lists.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
carries ids, not names: the office names products, lines and counterparties
from its own lists.

An edit (`PUT …/{id}`, with `expectedRev`) changes only what it sends: a
planned shift every field but its product, which is no field of the request;
an active one only its plan, which neither its label nor its snapshot shows
(another field sent with another value is `conflict` on `shift_status`, with
`details.status`); a closed one nothing. A line, a template or a counterparty
that changes is checked as at planning (a changed template also needs the
product still in use); one that stays is kept even if it was archived,
disabled or narrowed since, and the station's opening refuses it then
(`template_not_fit`). `plannedQty: null` and `counterpartyId: null` clear
them. Only a planned shift is deleted (`DELETE …/{id}`, 204; an open or a
closed one is `shift_status`); the delete takes a revision with no row left to
stamp, and a delete repeated after a lost answer is `not_found`. A template a
planned shift names is not deleted (`conflict` on `template_in_use`, with
`details.shiftIds`), since the shift prints with it once a station opens it;
an open or closed shift has the layout in its snapshot. Disabling or narrowing
such a template is not refused: the shift then does not open, and the office
sees why.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — у активной смены меняется всё. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ShiftStatus::Active if !fixed_changed => {}
```

заменить на

<!-- prettier-ignore -->
```rust
        ShiftStatus::Active => {}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `an_active_shift_takes_only_its_plan_and_a_closed_one_nothing`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — удаление открытой смены. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    if current.status != ShiftStatus::Planned {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("DELETE
```

заменить на

<!-- prettier-ignore -->
```rust
    if current.status == ShiftStatus::Closed {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("DELETE
```

Run: та же команда.
Expected: FAIL `only_a_planned_shift_is_deleted`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — `template_in_use` снят. В `apps/standalone/host/src/routes/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !planned.is_empty() {
```

заменить на

<!-- prettier-ignore -->
```rust
    if planned.is_empty() && !planned.is_empty() {
```

Run: та же команда.
Expected: FAIL `a_template_that_a_planned_shift_names_is_not_deleted`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/shift-update.json apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 321 тест, `proto` 41.

```bash
git add apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/shifts.rs apps/standalone/host/src/routes/templates.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/shift-update.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): the office edits and deletes shifts; a template a planned shift names stays" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Смены станции — `GET/POST /v1/device/shifts`; протокол 2

Станция читает смены ключом устройства: запланированные и активные смены своей линии и смены, в которые входила, — активные и закрытые за 30 дней. Имя и GTIN товара и имя контрагента — из снимка открытой смены и из записей до открытия (копии контрагентов на станции нет). Станция создаёт смену на своей линии по правилам плана офиса; `requestId` делает создание повторяемым — тот же запрос той же станции отдаёт ту же смену без ревизии и строки журнала. Маршруты смен — только для станции. С первыми маршрутами протокола 2 поднимается `PROTOCOL_VERSION` (`MIN_PROTOCOL_VERSION` остаётся 1): хост принимает станции этапа 1, а станция этапа 2a находит хост этапа 1 слишком старым (`host_too_old` пробы). Вместе с константой меняются ожидания тестов, которые её называют: фикстура `hello.json`, `server.rs`, `claim.rs`, `hello.rs`, `platform.rs`, тесты пробы в оболочке и зеркало `src/host/protocol.ts`, которое Vitest теперь сверяет с `hello.json`. Открытую и закрытую смены тест задаёт прямо в таблице (вход — задача 5).

**Files:**

- Create: `apps/standalone/host/src/routes/device_shifts.rs`, `apps/standalone/proto/fixtures/device-shifts.json`, `apps/standalone/proto/fixtures/device-shift-create.json`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs` (маршруты), `apps/standalone/proto/src/lib.rs` (`DeviceShift`, `DeviceShifts`, `DeviceShiftCreate`, `PROTOCOL_VERSION`), `apps/standalone/proto/fixtures/hello.json`, `apps/standalone/src/host/protocol.ts`
- Test: `apps/standalone/host/tests/device_shifts.rs` (Create), модули `tests` в `apps/standalone/host/src/server.rs` и `apps/standalone/src-tauri/src/host_probe.rs`, `apps/standalone/host/tests/{claim,hello,platform}.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`
- Modify: `apps/standalone/AGENTS.md` («Protocol», «Shifts»)

**Interfaces:**

- Consumes: задачи 2–3 — `shifts::{shift_product, check_counterparty, check_box_template, insert, NewShift, format_number}`, `require_active_line`, `validate::{client_uuid, civil_date, count, MAX_PLANNED_QTY, MAX_BOX_CAPACITY}`, `AuthDevice`; `shift_setup`, `shift_body`, `plan_shift`, `pair_device`, `json`, `with_device` — `tests/support/app.rs`.
- Produces:
  - `markiro_proto::{DeviceShift, DeviceShifts, DeviceShiftCreate}`; `PROTOCOL_VERSION = 2`;
  - `routes::device_shifts::{list_device_shifts, create_device_shift}`, `pub fn line_conflict() -> ApiError` (`conflict` `shift_line`), `read(conn, id) -> Result<Option<DeviceShift>, ApiError>`, `require_station(&AuthDevice) -> Result<(), ApiError>` (задача 5 добавляет вход в тот же модуль);
  - в `tests/device_shifts.rs`: `device_id`, `select_line`, `device_call`, `listed`, `open_directly`, `close_directly`, `snapshot`, `device_shift`, `device_create`, `REQUEST`, `device_row` (задача 5 ими пользуется).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust

    #[tokio::test]
    async fn a_supported_version_passes() {
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
    }

```

заменить на

<!-- prettier-ignore -->
```rust

    #[tokio::test]
    async fn a_supported_version_passes() {
        // Protocol 2 (stage 2a) is this build's; 1 (stage 1) is still taken.
        assert_eq!(call(Some("2")).await.0, StatusCode::OK);
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
    }

```

2. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["code"], "protocol_unsupported");
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 1);
    }

    #[tokio::test]
```

заменить на

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["code"], "protocol_unsupported");
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 2);
    }

    #[tokio::test]
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["details"]["protocol"], 7);
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["details"]["protocol"], 7);
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("3")).await.0, StatusCode::BAD_REQUEST);
    }
}

```

4. В `apps/standalone/host/tests/claim.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 1, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
    let used_at: Option<String> =
```

заменить на

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 2, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
    let used_at: Option<String> =
```

5. Создать `apps/standalone/host/tests/device_shifts.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    plan_shift, request, shift_body, shift_setup, with_device, Admin, AuditRow, ShiftSetup,
};

/// This station's own id, as the host has it.
async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Put the station of `key` on `line`.
async fn select_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A device request with `key`; returns the status and the body.
async fn device_call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

/// The ids of a `GET /v1/device/shifts` answer, in order.
async fn listed(admin: &Admin, key: &str) -> Vec<Value> {
    let (status, body) = device_call(admin, key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|shift| shift["id"].clone())
        .collect()
}

/// Open a shift straight in its table for `device`, with a snapshot that
/// names the product and the counterparty, and record the device's entry
/// (the entry route comes with the next task).
async fn open_directly(admin: &Admin, shift: &Value, device: &str, snapshot: Value) {
    let at = admin.app.state.timestamp();
    let id = shift["id"].as_str().unwrap();
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ? \
         WHERE id = ?",
    )
    .bind(snapshot.to_string())
    .bind(&at)
    .bind(device)
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(device)
    .bind(&at)
    .bind(&at)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// Close an open shift straight in its table.
async fn close_directly(admin: &Admin, shift: &Value, device: &str) {
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

fn snapshot(product_name: &str, counterparty_name: Value) -> Value {
    json!({
        "product": { "name": product_name, "gtin14": "04600682000013" },
        "counterpartyName": counterparty_name
    })
}

/// A station's view of `shift_body(setup)` planned on the first line.
fn device_shift(id: &str, number: &str, setup: &ShiftSetup) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
        "palletsEnabled": false, "createdFrom": "office", "lineId": setup.line,
        "productId": setup.product, "productName": "Молоко 3,2% 0,9 л",
        "productGtin14": "04600682000013", "counterpartyName": null,
        "productionDate": "2026-10-08", "plannedQty": null, "boxCapacity": 12,
        "boxTemplateId": setup.template, "ownerDeviceId": null, "openedAt": null,
        "closedAt": null
    })
}

#[tokio::test]
async fn a_station_sees_the_open_shifts_of_its_line_and_those_it_entered() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    let (other, other_key) = pair_device(&admin.app, "station").await;
    select_line(&admin, &admin.key, &setup.line).await;
    select_line(&admin, &other_key, &setup.line).await;
    let mut body = shift_body(&setup);
    let planned = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-10-07");
    let busy = plan_shift(&admin, body.clone()).await;
    let closed = plan_shift(&admin, body.clone()).await;
    body["lineId"] = json!(setup.other_line);
    let elsewhere = plan_shift(&admin, body.clone()).await;
    let entered_elsewhere = plan_shift(&admin, body).await;
    open_directly(
        &admin,
        &busy,
        &other,
        snapshot("Молоко (снимок)", json!("ООО «Берег»")),
    )
    .await;
    open_directly(&admin, &closed, &station, snapshot("Молоко", Value::Null)).await;
    close_directly(&admin, &closed, &station).await;
    open_directly(
        &admin,
        &entered_elsewhere,
        &station,
        snapshot("Молоко", Value::Null),
    )
    .await;

    // By production date: the busy shift of 7 October, the closed one this
    // station entered, the one it entered on another line, then the plan.
    assert_eq!(
        listed(&admin, &admin.key).await,
        vec![
            busy["id"].clone(),
            closed["id"].clone(),
            entered_elsewhere["id"].clone(),
            planned["id"].clone()
        ]
    );
    // The other station sees its own shift and the plan, not this
    // station's closed shift or the other line.
    assert_eq!(
        listed(&admin, &other_key).await,
        vec![busy["id"].clone(), planned["id"].clone()]
    );
    assert!(!listed(&admin, &admin.key)
        .await
        .contains(&elsewhere["id"].clone()));

    // A plan reads the product as it is; an open shift reads its snapshot.
    let (status, list) = device_call(&admin, &admin.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list["shifts"][3],
        device_shift(
            planned["id"].as_str().unwrap(),
            planned["number"].as_str().unwrap(),
            &setup
        )
    );
    let busy_view = &list["shifts"][0];
    assert_eq!(
        [
            busy_view["status"].clone(),
            busy_view["productName"].clone(),
            busy_view["counterpartyName"].clone(),
            busy_view["ownerDeviceId"].clone()
        ],
        [
            json!("active"),
            json!("Молоко (снимок)"),
            json!("ООО «Берег»"),
            json!(other)
        ]
    );

    // A closed shift this station entered leaves its list after 30 days.
    admin.app.clock.advance(time::Duration::days(30));
    assert!(listed(&admin, &admin.key)
        .await
        .contains(&closed["id"].clone()));
    admin.app.clock.advance(time::Duration::seconds(1));
    assert!(!listed(&admin, &admin.key)
        .await
        .contains(&closed["id"].clone()));
}

#[tokio::test]
async fn only_a_station_reads_and_creates_shifts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    plan_shift(&admin, shift_body(&setup)).await;
    // A station without a line sees no line's shifts.
    assert_eq!(listed(&admin, &unassigned).await, Vec::<Value>::new());
    // A device of another kind (the office kind pairs from loopback too).
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    for (method, body) in [
        ("GET", None),
        ("POST", Some(device_create(&setup, REQUEST))),
    ] {
        let (status, refused) = device_call(
            &admin,
            &office_pc,
            method,
            "/v1/device/shifts",
            body.clone(),
        )
        .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method}"
        );
        let builder = request(method, "/v1/device/shifts");
        let (status, refused) = match body {
            Some(body) => admin.app.send(json_request(builder, body)).await,
            None => admin.app.send(empty(builder)).await,
        };
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{method}"
        );
    }
}

/// A station's create of `setup`'s product with `request_id`.
fn device_create(setup: &ShiftSetup, request_id: &str) -> Value {
    json!({
        "requestId": request_id,
        "productId": setup.product,
        "boxTemplateId": setup.template,
        "productionDate": "2026-10-09"
    })
}

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/// The `ok` audit row a station writes.
fn device_row(device: &str, action: &str, target_id: &str, details: Value) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        action.to_owned(),
        Some("shift".to_owned()),
        Some(target_id.to_owned()),
        "ok".to_owned(),
        details,
    )
}

#[tokio::test]
async fn a_station_creates_a_shift_on_its_line_once_per_request() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut expected = device_shift(&id, "OCT26-001/S", &setup);
    expected["createdFrom"] = json!("station");
    expected["productionDate"] = json!("2026-10-09");
    assert_eq!(created, expected);
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![device_row(
            &station,
            "shift.create",
            &id,
            json!({
                "number": "OCT26-001/S", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-09"
            })
        )]
    );
    // The office sees it as a station's.
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["createdFrom"].clone(),
            office["number"].clone()
        ),
        (StatusCode::OK, json!("station"), json!("OCT26-001/S"))
    );
    // The same request again is the same shift, whatever it says now: no
    // second shift, no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let mut again = device_create(&setup, REQUEST);
    again["plannedQty"] = json!(600);
    let (status, repeated) =
        device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(again)).await;
    assert_eq!((status, repeated), (StatusCode::OK, created.clone()));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Another station's request with the same id is its own.
    let (_, other_key) = pair_device(&admin.app, "station").await;
    select_line(&admin, &other_key, &setup.line).await;
    let (status, other) = device_call(
        &admin,
        &other_key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(
        (status, other["number"].clone()),
        (StatusCode::OK, json!("OCT26-002/S"))
    );
}

#[tokio::test]
async fn a_station_create_follows_the_plan_rules_on_its_own_line() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, draft) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    let (status, beer) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({ "name": "Пиво", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [15], "spec": { "widthMm": 58 } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{beer}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let create = |change: Value| {
        let mut body = device_create(&setup, REQUEST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };
    let refused = |status: StatusCode, code: &str, details: Value| (status, (json!(code), details));
    let field = |name: &str| {
        refused(
            StatusCode::BAD_REQUEST,
            "validation_failed",
            json!({ "field": name }),
        )
    };
    let send = |body: Value| async {
        let (status, answer) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        (
            status,
            (
                answer["error"]["code"].clone(),
                answer["error"]["details"].clone(),
            ),
        )
    };
    // Without a line there is nowhere to put the shift.
    assert_eq!(
        send(create(json!({}))).await,
        refused(
            StatusCode::CONFLICT,
            "conflict",
            json!({ "constraint": "shift_line" })
        )
    );
    select_line(&admin, &admin.key, &setup.line).await;
    for (change, expected) in [
        (json!({ "requestId": "not-a-uuid" }), field("requestId")),
        (
            json!({ "requestId": REQUEST.to_uppercase() }),
            field("requestId"),
        ),
        (
            json!({ "productId": draft["id"] }),
            refused(
                StatusCode::CONFLICT,
                "conflict",
                json!({ "constraint": "product_inactive" }),
            ),
        ),
        (
            json!({ "boxTemplateId": beer["id"] }),
            field("boxTemplateId"),
        ),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "productionDate": "2026-02-29" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
    ] {
        assert_eq!(send(create(change.clone())).await, expected, "{change}");
    }
    // A station creates on its own line only: a line is no field.
    let (status, (code, details)) = send(create(json!({ "lineId": setup.other_line }))).await;
    assert_eq!(
        (status, code, details),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            Value::Null
        )
    );
    // A station left on an archived line creates nothing there.
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    assert_eq!(send(create(json!({}))).await, field("lineId"));
    // The line's archiving is the only write.
    assert_eq!(audit_rows(&admin.app).await, rows + 2);
    assert_eq!(host_revision(&admin.app).await, revision + 1);
}
```

6. В `apps/standalone/host/tests/hello.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(response.status(), 200);
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    assert_eq!(hello.protocol, 1);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
    assert_eq!(hello.version, env!("CARGO_PKG_VERSION"));
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(response.status(), 200);
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    // Protocol 2 since plan 2a1; a station of stage 1 (protocol 1) is still
    // taken.
    assert_eq!(hello.protocol, 2);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
    assert_eq!(hello.version, env!("CARGO_PKG_VERSION"));
```

7. В `apps/standalone/host/tests/platform.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
}

```

заменить на

<!-- prettier-ignore -->
```rust
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 2);
    assert_eq!(body["minProtocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
}

```

8. Создать `apps/standalone/proto/fixtures/device-shift-create.json`:

<!-- prettier-ignore -->
```json
{
  "requestId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "productionDate": "2026-10-09",
  "boxCapacity": 12,
  "plannedQty": null,
  "counterpartyId": null
}
```

9. Создать `apps/standalone/proto/fixtures/device-shifts.json`:

<!-- prettier-ignore -->
```json
{
  "shifts": [
    {
      "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "number": "OCT26-004",
      "status": "active",
      "mode": "aggregation",
      "palletsEnabled": false,
      "createdFrom": "office",
      "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      "productName": "Молоко 3,2% 0,9 л",
      "productGtin14": "04600682000013",
      "counterpartyName": "ООО «Северный берег»",
      "productionDate": "2026-10-08",
      "plannedQty": 1200,
      "boxCapacity": 12,
      "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "openedAt": "2026-10-08T06:02:00Z",
      "closedAt": null
    },
    {
      "id": "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a",
      "number": "OCT26-005/S",
      "status": "planned",
      "mode": "aggregation",
      "palletsEnabled": false,
      "createdFrom": "station",
      "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      "productName": "Молоко 3,2% 0,9 л",
      "productGtin14": "04600682000013",
      "counterpartyName": null,
      "productionDate": "2026-10-09",
      "plannedQty": null,
      "boxCapacity": 12,
      "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      "ownerDeviceId": null,
      "openedAt": null,
      "closedAt": null
    }
  ]
}
```

10. В `apps/standalone/proto/fixtures/hello.json` фрагмент

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 1,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "0.1.0",
```

заменить на

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 2,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "0.1.0",
```

11. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LabelTemplate,
    LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary, LabelTemplateUpdate,
    LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
    OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift, OfficeUser,
    OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord, OperatorCreate,
    OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
    PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus,
    ShiftUpdate, SiteRecord, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate,
    ErrorBody, Hello, HelloEnvelope, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord,
    LabelTemplateSummary, LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate,
    LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole,
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

12. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
}

#[test]
fn device_shift_fixtures_round_trip_and_a_station_names_no_line() {
    let list: DeviceShifts = round_trip("device-shifts.json");
    let office: OfficeShift = serde_json::from_value(fixture("office-shift.json")).unwrap();
    // The station's view of the office's shift: the same number and owner.
    let open: &DeviceShift = &list.shifts[0];
    assert_eq!(
        (&open.id, &open.number, &open.owner_device_id),
        (&office.id, &office.number, &office.owner_device_id)
    );
    let planned = &list.shifts[1];
    assert_eq!(
        (
            planned.status,
            planned.created_from,
            planned.number.ends_with("/S")
        ),
        (ShiftStatus::Planned, ShiftOrigin::Station, true)
    );
    let create: DeviceShiftCreate = round_trip("device-shift-create.json");
    assert_eq!(create.production_date, planned.production_date);
    // A station creates on its own line and never says which.
    let mut value = fixture("device-shift-create.json");
    value["lineId"] = Value::String(office.line_id);
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
    let mut value = fixture("device-shift-create.json");
    value.as_object_mut().unwrap().remove("requestId");
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
}

```

13. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 0, "minProtocol": 0})),
            Err(ProbeError::HostTooOld)
        );
    }

    #[test]
```

заменить на

<!-- prettier-ignore -->
```rust
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 0, "minProtocol": 0})),
            Err(ProbeError::HostTooOld)
        );
        // A host of stage 1 speaks protocol 1 only: a stage 2a station asks
        // for an update of the host (stage 2a spec, decision 35).
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
    }

    #[test]
```

14. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::InvalidResponse)
        );
    }
```

заменить на

<!-- prettier-ignore -->
```rust
    #[test]
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 2, "minProtocol": 1})),
            Err(ProbeError::InvalidResponse)
        );
    }
```

15. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
    fn a_compatible_hello_is_read() {
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": 1,
            "minProtocol": 1,
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "version": "0.1.0",
```

заменить на

<!-- prettier-ignore -->
```rust
    fn a_compatible_hello_is_read() {
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": 2,
            "minProtocol": 1,
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "version": "0.1.0",
```

16. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  badgeCreateSchema,
  badgeSaltSchema,
  blockSizesUpdateSchema,
```

17. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: 1,
      initialized: false,
    });
  });
```

заменить на

<!-- prettier-ignore -->
```ts
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: PROTOCOL_VERSION,
      minProtocol: 1,
      initialized: false,
    });
  });
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL — 4 теста из 4: маршрутов нет (`404` там, где ждут `200` или `409` на `shift_line`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib server --offline --locked`
Expected: FAIL — 2 теста из 3: `a_supported_version_passes` (`400` вместо `200` на версии 2) и `a_missing_header_is_refused_with_details` (`maxProtocol` 1 вместо 2).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test claim --offline --locked`
Expected: FAIL — `a_device_in_the_network_pairs_with_a_code_typed_in_any_case`: устройство записано с протоколом 1, а не 2.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test hello --test platform --offline --locked --no-fail-fast`
Expected: FAIL — `hello_answers_over_tls_with_the_pinned_certificate` и `hello_needs_no_protocol_header`: `hello` отвечает `protocol` 1.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::DeviceShift`, `markiro_proto::DeviceShiftCreate`, `markiro_proto::DeviceShifts` ``.

Run (`apps/standalone/dist` собран): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib host_probe --offline --locked`
Expected: FAIL — `host_probe::tests::a_host_older_than_this_app_is_rejected`: хост протокола 1 читается как совместимый (`InvalidResponse` вместо `HostTooOld`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — 1 тест (`hello`): `PROTOCOL_VERSION` вебвью — 1, в `hello.json` — 2.

- [ ] **Step 3: Маршруты станции и протокол 2**

1. Создать `apps/standalone/host/src/routes/device_shifts.rs`:

<!-- prettier-ignore -->
```rust
//! Shifts at a station (stage 2a spec §4.2, §4.7), with the device key, for
//! stations only: `GET /v1/device/shifts` and `POST /v1/device/shifts`. A
//! station reads its shifts at the moments it reads its device record
//! (after it subscribes to the link and after every revision event), since a
//! shift is no feed record: shifts are per line, and an open one carries a
//! layout of up to 256 KB.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceKind, DeviceShift, DeviceShiftCreate, DeviceShifts, ShiftOrigin};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
use crate::validate;

/// The columns of a station's shift. The product and the counterparty are
/// the snapshot's once the shift is open, the records' before.
const SELECT: &str = "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, s.status, \
     s.mode, s.pallets_enabled, s.line_id, s.product_id, \
     COALESCE(json_extract(s.snapshot, '$.product.name'), p.name) AS product_name, \
     COALESCE(json_extract(s.snapshot, '$.product.gtin14'), p.gtin14) AS product_gtin14, \
     CASE WHEN s.snapshot IS NULL THEN c.name \
         ELSE json_extract(s.snapshot, '$.counterpartyName') END AS counterparty_name, \
     s.production_date, s.planned_qty, s.box_capacity, s.box_template_id, s.owner_device_id, \
     s.opened_at, s.closed_at \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     LEFT JOIN counterparties c ON c.id = s.counterparty_id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    mode: String,
    pallets_enabled: bool,
    line_id: String,
    product_id: String,
    product_name: String,
    product_gtin14: String,
    counterparty_name: Option<String>,
    production_date: String,
    planned_qty: Option<u32>,
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
}

fn record(row: ShiftRow) -> Result<DeviceShift, ApiError> {
    let created_from = row.created_from.parse().map_err(ApiError::internal)?;
    Ok(DeviceShift {
        number: shifts::format_number(&row.number_month_key, row.number_seq, created_from),
        id: row.id,
        status: row.status.parse().map_err(ApiError::internal)?,
        mode: row.mode.parse().map_err(ApiError::internal)?,
        pallets_enabled: row.pallets_enabled,
        created_from,
        line_id: row.line_id,
        product_id: row.product_id,
        product_name: row.product_name,
        product_gtin14: row.product_gtin14,
        counterparty_name: row.counterparty_name,
        production_date: row.production_date,
        planned_qty: row.planned_qty,
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<DeviceShift>, ApiError> {
    let row: Option<ShiftRow> = sqlx::query_as(&format!("{SELECT} WHERE s.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// Shifts are a station's: another kind of device works on none.
fn require_station(device: &AuthDevice) -> Result<(), ApiError> {
    if device.kind == DeviceKind::Station {
        Ok(())
    } else {
        Err(ApiError::forbidden("only a station works on shifts"))
    }
}

/// How long a station keeps seeing a closed shift it entered.
const CLOSED_DAYS: i64 = 30;

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
/// line, and the shifts it entered, active or closed within 30 days, by
/// production date. A station without a line sees only the latter.
pub async fn list_device_shifts(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceShifts>, ApiError> {
    require_station(&device)?;
    let cutoff = format_timestamp(state.now() - time::Duration::days(CLOSED_DAYS));
    // One read transaction: the station's line and its shifts come from one
    // WAL snapshot.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let rows: Vec<ShiftRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE (s.line_id = ?1 AND s.status IN ('planned', 'active')) \
         OR (EXISTS (SELECT 1 FROM shift_participants sp \
                     WHERE sp.shift_id = s.id AND sp.device_id = ?2) \
             AND (s.status = 'active' OR s.closed_at >= ?3)) \
         ORDER BY s.production_date, s.created_at, s.number_month_key, s.number_seq, s.id"
    ))
    .bind(&line_id)
    .bind(&device.id)
    .bind(&cutoff)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(DeviceShifts {
        shifts: rows.into_iter().map(record).collect::<Result<_, _>>()?,
    }))
}

/// `conflict` on `shift_line`: the shift is not on the station's line, or
/// the station works on no line.
pub fn line_conflict() -> ApiError {
    ApiError::conflict("shift_line", "the shift is not on this station's line")
}

/// `POST /v1/device/shifts`: a station creates a planned shift on its own
/// line, under the rules of the office's plan; its number ends in `/S`. The
/// same `requestId` again answers the shift it created, whatever the body
/// says now, so a create retried after a lost answer makes no second shift.
pub async fn create_device_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(create): ApiJson<DeviceShiftCreate>,
) -> Result<Json<DeviceShift>, ApiError> {
    require_station(&device)?;
    validate::client_uuid("requestId", &create.request_id)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
    validate::count(
        "boxCapacity",
        create.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let repeated: Option<String> =
        sqlx::query_scalar("SELECT id FROM shifts WHERE created_by = ? AND create_request_id = ?")
            .bind(&device.id)
            .bind(&create.request_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if let Some(id) = repeated {
        // Nothing to write: the transaction rolls back when dropped.
        return read(&mut tx, &id)
            .await?
            .map(Json)
            .ok_or_else(|| ApiError::internal("shift vanished"));
    }
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let line_id = line_id.ok_or_else(line_conflict)?;
    require_active_line(&mut tx, &line_id).await?;
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    if let Some(counterparty_id) = &create.counterparty_id {
        shifts::check_counterparty(&mut tx, counterparty_id).await?;
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
        &mut tx,
        &NewShift {
            origin: ShiftOrigin::Station,
            created_by: &device.id,
            request_id: Some(&create.request_id),
            product_id: &create.product_id,
            line_id: &line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
        },
        &at,
        rev,
    )
    .await?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_CREATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": created.number,
                "productId": created.product_id,
                "lineId": created.line_id,
                "productionDate": created.production_date,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}
```

2. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod bootstrap;
pub mod changes;
pub mod counterparties;
pub mod devices;
pub mod lines;
pub mod office_auth;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod bootstrap;
pub mod changes;
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod lines;
pub mod office_auth;
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route("/v1/local-pair", post(crate::routes::pairing::local_pair))
        .route("/v1/device", get(crate::routes::devices::device_info))
        .route("/v1/device/line", put(crate::routes::devices::select_line))
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
        .route(
```

заменить на

<!-- prettier-ignore -->
```rust
        .route("/v1/local-pair", post(crate::routes::pairing::local_pair))
        .route("/v1/device", get(crate::routes::devices::device_info))
        .route("/v1/device/line", put(crate::routes::devices::select_line))
        .route(
            "/v1/device/shifts",
            get(crate::routes::device_shifts::list_device_shifts)
                .post(crate::routes::device_shifts::create_device_shift),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
        .route(
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
```

заменить на

<!-- prettier-ignore -->
```rust
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 2;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

/// A shift as a station sees it (`GET /v1/device/shifts` and the answer of
/// `POST /v1/device/shifts`). The product's name and GTIN and the
/// counterparty's name are the snapshot's once the shift is open, so a
/// change of the catalog does not show on a shift that runs; before that
/// they are the records' own (the station keeps no copy of counterparties).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub mode: ShiftMode,
    pub pallets_enabled: bool,
    pub created_from: ShiftOrigin,
    pub line_id: String,
    pub product_id: String,
    pub product_name: String,
    pub product_gtin14: String,
    pub counterparty_name: Option<String>,
    pub production_date: String,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: String,
    /// The station that opened the shift: another one's id means the shift
    /// is busy (stage 2a puts one device on a shift).
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
}

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
/// line, and the shifts it entered that are active or closed within 30 days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShifts {
    pub shifts: Vec<DeviceShift>,
}

/// `POST /v1/device/shifts`: a station creates a shift on its own line while
/// the host answers. `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceShiftCreate {
    pub request_id: String,
    pub product_id: String,
    pub box_template_id: String,
    pub production_date: String,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub planned_qty: Option<u32>,
    #[serde(default)]
    pub counterparty_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
```

6. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 1;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
```

заменить на

<!-- prettier-ignore -->
```ts
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./pairing-code.js";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 2;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --test claim --offline --locked`
Expected: PASS — 4 и 9 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib server --offline --locked`
Expected: PASS — 3 теста.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test hello --test platform --offline --locked`
Expected: PASS — 5 и 7 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 37 тестов фикстур.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib host_probe --offline --locked`
Expected: PASS — 6 тестов.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS — 186 тестов.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`templates`, built by `stockTemplates` since plan 1e3, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. Response types, which
devices of different versions read, tolerate unknown fields; request types,
which the host parses, reject them with `deny_unknown_fields`. The feed records
that grant access or carry the salt (`site`, `operators`, `operator_badges`) are
```

заменить на

<!-- prettier-ignore -->
```text
`templates`, built by `stockTemplates` since plan 1e3, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. It is 2 since plan 2a1,
with `MIN_PROTOCOL_VERSION` still 1: the host takes the stations of stage 1,
and a station of stage 2a finds a host of stage 1 too old (`host_too_old` at
the probe). `src/host/protocol.ts` mirrors it, and `test/protocol.test.ts`
ties the mirror to `hello.json`. Response types, which
devices of different versions read, tolerate unknown fields; request types,
which the host parses, reject them with `deny_unknown_fields`. The feed records
that grant access or carry the salt (`site`, `operators`, `operator_badges`) are
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
such a template is not refused: the shift then does not open, and the office
sees why.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
such a template is not refused: the shift then does not open, and the office
sees why.

A station reads its shifts with the device key (`GET /v1/device/shifts`;
the shift routes of a device are a station's, and another kind of device is
`forbidden`): the planned and active shifts of its line, and the shifts it
entered that are active or closed within 30 days, by production date; a
station without a line sees only the latter. It reads them when it reads its
device record (after it subscribes to the link and after every revision
event), not through the feed: shifts are per line, and an open one carries a
layout of up to 256 KB. A shift's product name and GTIN and its
counterparty's name are the snapshot's once it is open and the records' before
(the station keeps no copy of counterparties); `ownerDeviceId` names the
station that opened it, and another station's id means the shift is busy. A
station creates a shift on its own line while the host answers
(`POST /v1/device/shifts`), under the office's rules; a station without a line
is `conflict` on `shift_line`, and a line is no field of the request.
`requestId`, a lower-case hyphenated UUID the station made up
(`validate::client_uuid`), makes the create repeatable: the same request of
the same station answers the shift it created, whatever its body says now,
with no revision and no audit row. Every device route of stage 2a lives under
`/v1/device/…`, which `host_request` already lets through, and none returns a
secret.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — станция видит закрытые смены линии. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
(s.line_id = ?1 AND s.status IN ('planned', 'active'))
```

заменить на

<!-- prettier-ignore -->
```rust
(s.line_id = ?1)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_station_sees_the_open_shifts_of_its_line_and_those_it_entered`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — повтор `requestId` создаёт вторую смену. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(id) = repeated {
```

заменить на

<!-- prettier-ignore -->
```rust
    if let Some(id) = repeated.filter(|_| false) {
```

Run: та же команда.
Expected: FAIL `a_station_creates_a_shift_on_its_line_once_per_request`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/device-shifts.json apps/standalone/proto/fixtures/device-shift-create.json apps/standalone/proto/fixtures/hello.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/AGENTS.md`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec eslint src/host/protocol.ts test/protocol.test.ts`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 325 тестов, `proto` 42.

```bash
git add apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/device_shifts.rs apps/standalone/host/tests/claim.rs apps/standalone/host/tests/hello.rs apps/standalone/host/tests/platform.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/device-shifts.json apps/standalone/proto/fixtures/device-shift-create.json apps/standalone/proto/fixtures/hello.json apps/standalone/src-tauri/src/host_probe.rs apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): a station's shifts and its own new shift; protocol 2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Вход станции в смену — `POST /v1/device/shifts/{id}/enter`, снимок, `shift_busy`

Станция линии смены входит в неё. Запланированная смена открывается: хост снова проверяет товар (`product_inactive`) и шаблон (`template_not_fit`), замораживает снимок (`ShiftSnapshot`), делает станцию владельцем, добавляет её в `shift_participants` и берёт ревизию, чтобы остальные станции линии увидели смену занятой. Владелец входит снова без ревизии и получает тот же снимок — станция, потерявшая базу, получает его заново; правка каталога, шаблона или GLN снимок не меняет. Закрытая смена — `shift_status` для всех, чужая линия или станция без линии — `shift_line`, смена, открытая другой станцией, — `shift_busy`. Отказы проверяются в этом порядке и ничего не пишут.

**Files:**

- Create: `apps/standalone/proto/fixtures/device-shift-entered.json`, `apps/standalone/proto/fixtures/error-shift-busy.json`
- Modify: `apps/standalone/host/src/routes/device_shifts.rs` (`enter_shift`, `snapshot: None` в `record`), `apps/standalone/host/src/shifts.rs` (`busy`, `template_not_fit`, `snapshot`), `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs` (`DeviceShift.snapshot`, `ShiftSnapshot`, `ShiftSnapshotProduct`, `ShiftSnapshotTemplate`)
- Test: `apps/standalone/host/tests/device_shifts.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Shifts»)

**Interfaces:**

- Consumes: задачи 2–4 — `shifts::{status_conflict, product_inactive, format_number}`, `templates::{scope, fits}`, `validate::issuer_prefix`, `routes::device_shifts::{read, require_station, line_conflict}`, хелперы `tests/device_shifts.rs`.
- Produces:
  - `markiro_proto::{ShiftSnapshot { product, box_template, issuer_prefix, counterparty_name }, ShiftSnapshotProduct { id, gtin14, name, print_name, chz_product_group_code: u32, shelf_life_days }, ShiftSnapshotTemplate { id, name, rev: i64, spec: Value }}`; `DeviceShift.snapshot: Option<ShiftSnapshot>` (только в ответе на вход);
  - `pub fn markiro_host::shifts::{busy, template_not_fit}() -> ApiError`; `pub async fn shifts::snapshot(conn, product_id, template_id, counterparty_id: Option<&str>) -> Result<ShiftSnapshot, ApiError>`;
  - `audit::actions::SHIFT_OPEN` (`"shift.open"`); `routes::device_shifts::enter_shift`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/tests/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(host_revision(&admin.app).await, revision + 1);
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(host_revision(&admin.app).await, revision + 1);
}

/// `POST /v1/device/shifts/{id}/enter` with `key`.
async fn enter(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(admin, key, "POST", &path, None).await
}

/// The participants of a shift, as `(device, first entry, last entry)`.
async fn participants(admin: &Admin, shift: &Value) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT device_id, first_entered_at, last_entered_at FROM shift_participants \
         WHERE shift_id = ? ORDER BY device_id",
    )
    .bind(shift["id"].as_str().unwrap())
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn entering_a_planned_shift_opens_it_and_freezes_its_snapshot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, berth) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{berth}");
    let mut body = shift_body(&setup);
    body["counterpartyId"] = berth["id"].clone();
    let shift = plan_shift(&admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let opened_at = admin.app.state.timestamp();
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let snapshot = json!({
        "product": {
            "id": setup.product, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
            "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10
        },
        "boxTemplate": {
            "id": setup.template, "name": "Короб 58×40", "rev": 2,
            "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
        },
        "issuerPrefix": "460068200",
        "counterpartyName": "ООО «Северный берег»"
    });
    let mut expected = device_shift(&id, "OCT26-001", &setup);
    for (key, value) in [
        ("status", json!("active")),
        ("counterpartyName", json!("ООО «Северный берег»")),
        ("ownerDeviceId", json!(station)),
        ("openedAt", json!(opened_at)),
        ("snapshot", snapshot.clone()),
    ] {
        expected[key] = value;
    }
    assert_eq!(entered, expected);
    // The wizard, the template, the product, the counterparty, the plan and
    // the opening each took a revision.
    assert_eq!(host_revision(&admin.app).await, 6);
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            &id,
            json!({ "number": "OCT26-001", "templateId": setup.template, "templateRev": 2 })
        )]
    );
    assert_eq!(
        participants(&admin, &shift).await,
        vec![(station.clone(), opened_at.clone(), opened_at.clone())]
    );
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["status"].clone(),
            office["ownerDeviceId"].clone(),
            office["openedAt"].clone(),
            office["rev"].clone()
        ),
        (
            StatusCode::OK,
            json!("active"),
            json!(station),
            json!(opened_at),
            json!(6)
        )
    );

    // The catalog, the template, the counterparty and the GLN change; the
    // shift keeps what it froze.
    let (status, product) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко 2,5%", "chzProductGroupCode": 8,
                "boxCapacity": 12, "palletBoxCapacity": 40, "archived": false, "expectedRev": 3
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{product}");
    let (status, template) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", setup.template),
            Some(json!({ "spec": { "widthMm": 100 }, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let (status, moved) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": org["name"], "inn": org["inn"], "gln": "4601234000017",
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"],
                "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    admin.app.clock.advance(time::Duration::minutes(5));
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, again["snapshot"].clone()),
        (StatusCode::OK, snapshot)
    );
    assert_eq!(again["productName"], "Молоко 3,2% 0,9 л");
    // Entering again takes no revision and writes no row; it marks the
    // entry.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        participants(&admin, &shift).await,
        vec![(station, opened_at, admin.app.state.timestamp())]
    );
}

#[tokio::test]
async fn a_shift_takes_one_station_of_its_line_and_never_opens_once_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let (_, elsewhere) = pair_device(&admin.app, "station").await;
    select_line(&admin, &elsewhere, &setup.other_line).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let conflict = |constraint: &str| {
        (
            StatusCode::CONFLICT,
            json!({ "code": "conflict", "constraint": constraint }),
        )
    };
    let try_enter = |key: String| {
        let admin = &admin;
        let shift = &shift;
        async move {
            let (status, body) = enter(admin, &key, shift).await;
            (
                status,
                json!({
                    "code": body["error"]["code"],
                    "constraint": body["error"]["details"]["constraint"]
                }),
            )
        }
    };
    // Another line, or none, never opens it.
    assert_eq!(try_enter(elsewhere.clone()).await, conflict("shift_line"));
    assert_eq!(try_enter(unassigned).await, conflict("shift_line"));
    let (status, refused) = enter(&admin, &office_pc, &shift).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // Once one station opened it, another of the line is refused.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(try_enter(colleague.clone()).await, conflict("shift_busy"));
    assert_eq!(
        participants(&admin, &shift)
            .await
            .into_iter()
            .map(|(device, _, _)| device)
            .collect::<Vec<_>>(),
        vec![station.clone()]
    );
    // A closed shift opens for nobody, its own station included.
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(&station)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    for key in [admin.key.clone(), colleague] {
        let (status, body) = enter(&admin, &key, &shift).await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        );
    }
    let (status, missing) = enter(&admin, &admin.key, &json!({ "id": "no-such-shift" })).await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_plan_that_no_longer_fits_its_product_or_template_does_not_open() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let product_path = format!("/v1/office/products/{}", setup.product);
    let product = |archived: bool, pallet: Value, rev: i64| {
        json!({
            "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": pallet, "archived": archived,
            "expectedRev": rev
        })
    };
    let template_path = format!("/v1/office/templates/{}", setup.template);
    let refused = |constraint: &str| json!({ "constraint": constraint });
    let attempt = || async {
        let (status, body) = enter(&admin, &admin.key, &shift).await;
        (status, body["error"]["details"].clone())
    };
    // The product archived, then a draft (no pallet capacity).
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(true, json!(40), 3)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("product_inactive"))
    );
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(false, Value::Null, 5)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("product_inactive"))
    );
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(false, json!(40), 6)))
        .await;
    assert_eq!(status, StatusCode::OK);
    // The template disabled, then narrowed to beer.
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("template_not_fit"))
    );
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "enabled": true, "chzProductGroupCodes": [15], "expectedRev": 8 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let revision = host_revision(&admin.app).await;
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("template_not_fit"))
    );
    // Nothing opened: the plan waits, and no revision was taken.
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(
        (office["status"].clone(), office["ownerDeviceId"].clone()),
        (json!("planned"), Value::Null)
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(participants(&admin, &shift).await.is_empty());
    // Widened again, it opens.
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "chzProductGroupCodes": null, "expectedRev": 9 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, entered["status"].clone()),
        (StatusCode::OK, json!("active"))
    );
}

```

2. Создать `apps/standalone/proto/fixtures/device-shift-entered.json`:

<!-- prettier-ignore -->
```json
{
  "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "number": "OCT26-004",
  "status": "active",
  "mode": "aggregation",
  "palletsEnabled": false,
  "createdFrom": "office",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "productName": "Молоко 3,2% 0,9 л",
  "productGtin14": "04600682000013",
  "counterpartyName": "ООО «Северный берег»",
  "productionDate": "2026-10-08",
  "plannedQty": 1200,
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
  "closedAt": null,
  "snapshot": {
    "product": {
      "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      "gtin14": "04600682000013",
      "name": "Молоко 3,2% 0,9 л",
      "printName": "Молоко 3,2%",
      "chzProductGroupCode": 8,
      "shelfLifeDays": 10
    },
    "boxTemplate": {
      "id": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      "name": "Молоко 58×40",
      "rev": 62,
      "spec": {
        "widthMm": 58,
        "heightMm": 40,
        "dpi": 203,
        "language": "tspl",
        "elements": [
          {
            "kind": "field",
            "id": "name",
            "xMm": 2,
            "yMm": 2,
            "field": "product.printName",
            "fontSizePt": 10
          }
        ]
      }
    },
    "issuerPrefix": "460068200",
    "counterpartyName": "ООО «Северный берег»"
  }
}
```

3. Создать `apps/standalone/proto/fixtures/error-shift-busy.json`:

<!-- prettier-ignore -->
```json
{
  "error": {
    "code": "conflict",
    "message": "another station works on this shift",
    "details": { "constraint": "shift_busy" }
  }
}
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
}

#[test]
fn an_entered_shift_carries_its_snapshot_and_the_list_never_does() {
    let entered: DeviceShift = round_trip("device-shift-entered.json");
    let snapshot = entered
        .snapshot
        .clone()
        .expect("an entry carries the snapshot");
    // The snapshot is the product and the template as the office had them.
    let product: OfficeProduct = serde_json::from_value(fixture("office-product.json")).unwrap();
    let template: LabelTemplate = serde_json::from_value(fixture("label-template.json")).unwrap();
    assert_eq!(
        (
            &snapshot.product.id,
            &snapshot.product.gtin14,
            &snapshot.product.print_name
        ),
        (&product.id, &product.gtin14, &product.print_name)
    );
    assert_eq!(
        (
            &snapshot.box_template.id,
            snapshot.box_template.rev,
            &snapshot.box_template.spec
        ),
        (&template.id, template.rev, &template.spec)
    );
    let state: SsccState = serde_json::from_value(fixture("sscc-state.json")).unwrap();
    assert_eq!(snapshot.issuer_prefix, state.current_issuer_prefix);
    // The same shift in the list, without the snapshot.
    let list: DeviceShifts = serde_json::from_value(fixture("device-shifts.json")).unwrap();
    assert_eq!(
        DeviceShift {
            snapshot: None,
            ..entered
        },
        list.shifts[0]
    );
    assert!(list.shifts.iter().all(|shift| shift.snapshot.is_none()));
    let busy: ErrorBody = round_trip("error-shift-busy.json");
    assert_eq!(
        (
            busy.error.code.as_str(),
            busy.error.details.expect("details")["constraint"].as_str()
        ),
        (codes::CONFLICT, Some("shift_busy"))
    );
}

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL — 3 теста из 7 (4 прежних проходят): входа нет, `POST …/enter` получает `404` (там, где ждут `200`, `409` на `shift_line` или на `product_inactive`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0609]: no field `snapshot` on type `DeviceShift` `` и ``error[E0560]: struct `DeviceShift` has no field named `snapshot` ``.

- [ ] **Step 3: Снимок и вход**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CREATE: &str = "shift.create";
    pub const SHIFT_UPDATE: &str = "shift.update";
    pub const SHIFT_DELETE: &str = "shift.delete";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CREATE: &str = "shift.create";
    pub const SHIFT_UPDATE: &str = "shift.update";
    pub const SHIFT_DELETE: &str = "shift.delete";
    /// A station opened a planned shift: its snapshot is frozen.
    pub const SHIFT_OPEN: &str = "shift.open";
}

/// `details.reason` of a denied row: every denial names one.
```

2. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Shifts at a station (stage 2a spec §4.2, §4.7), with the device key, for
//! stations only: `GET /v1/device/shifts` and `POST /v1/device/shifts`. A
//! station reads its shifts at the moments it reads its device record
//! (after it subscribes to the link and after every revision event), since a
//! shift is no feed record: shifts are per line, and an open one carries a
```

заменить на

<!-- prettier-ignore -->
```rust
//! Shifts at a station (stage 2a spec §4.2, §4.7), with the device key, for
//! stations only: `GET /v1/device/shifts`, `POST /v1/device/shifts` and
//! `POST /v1/device/shifts/{id}/enter`. A
//! station reads its shifts at the moments it reads its device record
//! (after it subscribes to the link and after every revision event), since a
//! shift is no feed record: shifts are per line, and an open one carries a
```

3. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceKind, DeviceShift, DeviceShiftCreate, DeviceShifts, ShiftOrigin};
use serde_json::json;
use sqlx::SqliteConnection;

```

заменить на

<!-- prettier-ignore -->
```rust

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    DeviceKind, DeviceShift, DeviceShiftCreate, DeviceShifts, ShiftOrigin, ShiftSnapshot,
    ShiftStatus,
};
use serde_json::json;
use sqlx::SqliteConnection;

```

4. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use crate::auth::AuthDevice;
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::auth::AuthDevice;
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
```

5. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
    })
}

```

заменить на

<!-- prettier-ignore -->
```rust
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        snapshot: None,
    })
}

```

6. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Ok(Json(created))
}

```

заменить на

<!-- prettier-ignore -->
```rust
    Ok(Json(created))
}

/// A shift as an entry reads it.
#[derive(sqlx::FromRow)]
struct EntryRow {
    status: String,
    line_id: String,
    owner_device_id: Option<String>,
    product_id: String,
    box_template_id: String,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
}

/// `POST /v1/device/shifts/{id}/enter`: a station on the shift's line opens
/// a planned shift (the host freezes its snapshot and makes the station its
/// owner) or enters again the active shift it opened; the answer carries the
/// snapshot, so a station that lost its database gets it back. A closed
/// shift is `shift_status`, another line `shift_line`, a shift another
/// station opened `shift_busy`. Opening takes a revision, so the other
/// stations of the line see the shift busy; entering again takes none.
pub async fn enter_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DeviceShift>, ApiError> {
    require_station(&device)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT status, line_id, owner_device_id, product_id, box_template_id, counterparty_id, \
         snapshot, number_month_key, number_seq, created_from FROM shifts WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let shift = shift.ok_or_else(|| ApiError::not_found("no such shift"))?;
    let status: ShiftStatus = shift.status.parse().map_err(ApiError::internal)?;
    if status == ShiftStatus::Closed {
        return Err(shifts::status_conflict(status));
    }
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if line_id.as_deref() != Some(shift.line_id.as_str()) {
        return Err(line_conflict());
    }
    if shift
        .owner_device_id
        .as_deref()
        .is_some_and(|owner| owner != device.id)
    {
        return Err(shifts::busy());
    }
    let snapshot = match shift.snapshot {
        // The station that opened the shift enters it again.
        Some(text) => {
            sqlx::query(
                "UPDATE shift_participants SET last_entered_at = ? \
                 WHERE shift_id = ? AND device_id = ?",
            )
            .bind(&at)
            .bind(&id)
            .bind(&device.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            let snapshot: ShiftSnapshot =
                serde_json::from_str(&text).map_err(ApiError::internal)?;
            let mut entered = read(&mut tx, &id)
                .await?
                .ok_or_else(|| ApiError::internal("shift vanished"))?;
            tx.commit().await.map_err(ApiError::internal)?;
            entered.snapshot = Some(snapshot);
            return Ok(Json(entered));
        }
        None => {
            shifts::snapshot(
                &mut tx,
                &shift.product_id,
                &shift.box_template_id,
                shift.counterparty_id.as_deref(),
            )
            .await?
        }
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(serde_json::to_string(&snapshot).map_err(ApiError::internal)?)
    .bind(&at)
    .bind(&device.id)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&device.id)
    .bind(&at)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_OPEN,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": shifts::format_number(&shift.number_month_key, shift.number_seq, origin),
                "templateId": snapshot.box_template.id,
                "templateRev": snapshot.box_template.rev,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let mut opened = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    opened.snapshot = Some(snapshot);
    Ok(Json(opened))
}

```

7. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "/v1/device/shifts",
            get(crate::routes::device_shifts::list_device_shifts)
                .post(crate::routes::device_shifts::create_device_shift),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

заменить на

<!-- prettier-ignore -->
```rust
            "/v1/device/shifts",
            get(crate::routes::device_shifts::list_device_shifts)
                .post(crate::routes::device_shifts::create_device_shift),
        )
        .route(
            "/v1/device/shifts/{id}/enter",
            post(crate::routes::device_shifts::enter_shift),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

8. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{ProductStatus, ShiftMode, ShiftOrigin, ShiftStatus, TemplatePurpose};
use serde_json::json;
use sqlx::SqliteConnection;

```

заменить на

<!-- prettier-ignore -->
```rust
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{
    ProductStatus, ShiftMode, ShiftOrigin, ShiftSnapshot, ShiftSnapshotProduct,
    ShiftSnapshotTemplate, ShiftStatus, TemplatePurpose,
};
use serde_json::json;
use sqlx::SqliteConnection;

```

9. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        date.day()
    )
}

```

заменить на

<!-- prettier-ignore -->
```rust
        date.day()
    )
}

/// `conflict` on `shift_busy`: another station entered the shift (stage 2a
/// puts one device on a shift).
pub fn busy() -> ApiError {
    ApiError::conflict("shift_busy", "another station works on this shift")
}

/// `conflict` on `template_not_fit`: the planned shift's box template is
/// disabled now, or no longer covers the product's group.
pub fn template_not_fit() -> ApiError {
    ApiError::conflict(
        "template_not_fit",
        "the shift's box template no longer fits its product",
    )
}

/// The snapshot a planned shift freezes when a station opens it: its product
/// (still active and not archived, or `product_inactive`), its box template
/// (still enabled and covering the product's group, or `template_not_fit`)
/// with the whole layout, the issuer prefix of the organization's current
/// GLN, and the counterparty's name.
pub async fn snapshot(
    conn: &mut SqliteConnection,
    product_id: &str,
    template_id: &str,
    counterparty_id: Option<&str>,
) -> Result<ShiftSnapshot, ApiError> {
    type ProductRow = (
        String,
        String,
        Option<String>,
        Option<u32>,
        Option<u32>,
        String,
        bool,
    );
    let product: Option<ProductRow> = sqlx::query_as(
        "SELECT gtin14, name, print_name, chz_group_code, shelf_life_days, status, archived \
         FROM products WHERE id = ?",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let (gtin14, name, print_name, group, shelf_life_days, status, archived) =
        product.ok_or_else(|| ApiError::internal("the shift's product vanished"))?;
    let group = match (status.parse::<ProductStatus>(), archived, group) {
        (Ok(ProductStatus::Active), false, Some(group)) => group,
        _ => return Err(product_inactive()),
    };
    match templates::scope(conn, template_id).await? {
        Some(scope) if templates::fits(&scope, TemplatePurpose::Box, Some(group)) => {}
        _ => return Err(template_not_fit()),
    }
    let (template_name, spec, template_rev): (String, String, i64) =
        sqlx::query_as("SELECT name, spec, rev FROM label_templates WHERE id = ?")
            .bind(template_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let gln = gln.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let counterparty_name = match counterparty_id {
        Some(id) => Some(
            sqlx::query_scalar("SELECT name FROM counterparties WHERE id = ?")
                .bind(id)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?,
        ),
        None => None,
    };
    Ok(ShiftSnapshot {
        product: ShiftSnapshotProduct {
            id: product_id.to_owned(),
            gtin14,
            name,
            print_name,
            chz_product_group_code: group,
            shelf_life_days,
        },
        box_template: ShiftSnapshotTemplate {
            id: template_id.to_owned(),
            name: template_name,
            rev: template_rev,
            spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
        },
        issuer_prefix: crate::validate::issuer_prefix(&gln).to_owned(),
        counterparty_name,
    })
}

```

10. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
}

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
```

заменить на

<!-- prettier-ignore -->
```rust
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    /// What the shift froze when it opened: only in the answer of
    /// `POST /v1/device/shifts/{id}/enter`, never in the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ShiftSnapshot>,
}

/// What a shift freezes when a station opens it (stage 2a spec §4.2): the
/// station prints and reprints from this alone, so a change of the catalog,
/// the template or the organization's GLN never changes a shift that runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshot {
    pub product: ShiftSnapshotProduct,
    pub box_template: ShiftSnapshotTemplate,
    /// The SSCC issuer prefix of the organization's GLN when the shift
    /// opened: the station asks for blocks of it.
    pub issuer_prefix: String,
    pub counterparty_name: Option<String>,
}

/// The product as a shift froze it; only an active product opens a shift,
/// so it has a group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotProduct {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: u32,
    pub shelf_life_days: Option<u32>,
}

/// The box template as a shift froze it, its layout whole. The host never
/// checks a layout; the station checks it with `labelTemplateSpecSchema`
/// when it enters the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotTemplate {
    pub id: String,
    pub name: String,
    pub rev: i64,
    pub spec: serde_json::Value,
}

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: PASS — 7 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 38 тестов фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`/v1/device/…`, which `host_request` already lets through, and none returns a
secret.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
`/v1/device/…`, which `host_request` already lets through, and none returns a
secret.

A station on the shift's line enters it (`POST /v1/device/shifts/{id}/enter`).
A planned shift opens: the host checks its product (`product_inactive`) and
its template (`template_not_fit`) again, freezes the snapshot
(`ShiftSnapshot`: the product's id, GTIN, names, group and shelf life; the box
template's id, name, revision and whole layout; the issuer prefix of the
organization's GLN; the counterparty's name), makes the station the shift's
owner, adds it to `shift_participants` and takes a revision, so the line's
other stations see the shift busy. The owner enters again with no revision and
gets the same snapshot back, so a station that lost its database recovers it;
a change of the catalog, the template or the GLN never changes it. A closed
shift is `shift_status` for every station, a shift of another line (or a
station without one) `shift_line`, a shift another station opened
`shift_busy`: stage 2a puts one device on a shift. The snapshot is at most
320 KB (a `CHECK` of `0009`), and the host never checks its layout: the station
does, with `labelTemplateSpecSchema`, when it enters. The opening writes
`shift.open`; a second device's first entry (`shift.enter`) comes with plan
2b, since in stage 2a a station's first entry is the opening.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — вторая станция входит. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .is_some_and(|owner| owner != device.id)
```

заменить на

<!-- prettier-ignore -->
```rust
        .is_some_and(|owner| owner != device.id && false)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_shift_takes_one_station_of_its_line_and_never_opens_once_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — линия не проверяется. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    if line_id.as_deref() != Some(shift.line_id.as_str()) {
        return Err(line_conflict());
    }
    if shift
```

заменить на

<!-- prettier-ignore -->
```rust
    if shift
```

Run: та же команда.
Expected: FAIL `a_shift_takes_one_station_of_its_line_and_never_opens_once_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — открытие не проверяет шаблон. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(scope) if templates::fits(&scope, TemplatePurpose::Box, Some(group)) => {}
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(_) => {}
```

Run: та же команда.
Expected: FAIL `a_plan_that_no_longer_fits_its_product_or_template_does_not_open`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/device-shift-entered.json apps/standalone/proto/fixtures/error-shift-busy.json apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 328 тестов, `proto` 43.

```bash
git add apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/shifts.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/device_shifts.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/device-shift-entered.json apps/standalone/proto/fixtures/error-shift-busy.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a station enters a shift; the host opens it and freezes its snapshot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Закрытие активной смены из офиса — `POST /v1/office/shifts/{id}/close`

Офис закрывает активную смену — умершей станции или той, что никто не доделает — с текстом причины 3–500 символов без управляющих (облачный `closeShiftSchema` требует не меньше трёх), с `expectedRev`. Запланированная и закрытая смены — `shift_status`. Закрытие станцией — факт плана 2a2 с одним из шести кодов домена; факты смены, которую закрыл офис, хост примет и отметит поздними (тоже 2a2).

**Files:**

- Create: `apps/standalone/proto/fixtures/shift-close.json`
- Modify: `apps/standalone/host/src/routes/office_shifts.rs` (`close_shift`), `apps/standalone/host/src/validate.rs` (`close_reason`), `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs` (`ShiftClose`)
- Test: `apps/standalone/host/tests/office_shifts.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Shifts»)

**Interfaces:**

- Consumes: задачи 2–3 — `read`, `shifts::status_conflict`, `require_shift_planning(_in)`, `open_directly` и `refusal` в `tests/office_shifts.rs`.
- Produces: `markiro_proto::ShiftClose { reason: String, expected_rev: i64 }`; `pub fn markiro_host::validate::close_reason(field, text) -> Result<String, ApiError>`; `audit::actions::SHIFT_CLOSE` (`"shift.close"`); `routes::office_shifts::close_shift`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

#[tokio::test]
async fn the_office_closes_an_active_shift_with_its_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    admin.app.clock.advance(time::Duration::minutes(20));
    let close = format!("{}/close", path(&shift));
    let (status, closed) = admin
        .call(
            "POST",
            &close,
            Some(json!({ "reason": "  Станция линии 1 вышла из строя  ", "expectedRev": 4 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(
        [
            closed["status"].clone(),
            closed["closedAt"].clone(),
            closed["closeReasonText"].clone(),
            closed["closeReasonCode"].clone(),
            closed["rev"].clone()
        ],
        [
            json!("closed"),
            json!(admin.app.state.timestamp()),
            json!("Станция линии 1 вышла из строя"),
            Value::Null,
            json!(5)
        ]
    );
    assert_eq!(host_revision(&admin.app).await, 5);
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![admin.row(
            "shift.close",
            "shift",
            &id,
            json!({ "reason": "Станция линии 1 вышла из строя" })
        )]
    );
    let (by, kind): (String, String) =
        sqlx::query_as("SELECT closed_by, closed_by_kind FROM shifts WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((by, kind), (admin.id.clone(), "office_user".to_owned()));
    // Closed is closed: closing again is refused.
    let (status, refused) = admin
        .call(
            "POST",
            &close,
            Some(json!({ "reason": "Ещё раз", "expectedRev": 5 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        )
    );
}

#[tokio::test]
async fn only_an_active_shift_closes_and_only_with_a_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let active = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &active).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let close = |shift: &Value| format!("{}/close", path(shift));
    let (status, refused) = admin
        .call(
            "POST",
            &close(&planned),
            Some(json!({ "reason": "Не нужна", "expectedRev": 4 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "planned" })
            )
        )
    );
    for reason in ["аб", "  аб  ", &"я".repeat(501), "Сбой\tстанции"] {
        let (status, refused) = admin
            .call(
                "POST",
                &close(&active),
                Some(json!({ "reason": reason, "expectedRev": 5 })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::BAD_REQUEST,
                (json!("validation_failed"), json!({ "field": "reason" }))
            ),
            "{reason:?}"
        );
    }
    for expected_rev in [4, 6] {
        let (status, refused) = admin
            .call(
                "POST",
                &close(&active),
                Some(json!({ "reason": "Сбой", "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("stale_revision"), json!({ "currentRev": 5 }))
            )
        );
    }
    let (status, refused) = admin
        .call("POST", &close(&active), Some(json!({ "expectedRev": 5 })))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let (status, missing) = admin
        .call(
            "POST",
            "/v1/office/shifts/no-such-shift/close",
            Some(json!({ "reason": "Сбой", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Exactly 500 characters, by a technologist.
    let token = admin.technologist().await;
    let (status, closed) = admin
        .call_as(
            &token,
            "POST",
            &close(&active),
            Some(json!({ "reason": "я".repeat(500), "expectedRev": 5 })),
        )
        .await;
    assert_eq!(
        (status, closed["status"].clone()),
        (StatusCode::OK, json!("closed"))
    );
}

```

2. Создать `apps/standalone/proto/fixtures/shift-close.json`:

<!-- prettier-ignore -->
```json
{ "reason": "Станция линии 2 вышла из строя", "expectedRev": 71 }
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (codes::CONFLICT, Some("shift_busy"))
    );
}

```

заменить на

<!-- prettier-ignore -->
```rust
        (codes::CONFLICT, Some("shift_busy"))
    );
}

#[test]
fn a_shift_close_carries_the_reason_and_the_revision() {
    let close: ShiftClose = round_trip("shift-close.json");
    let office: OfficeShift = serde_json::from_value(fixture("office-shift.json")).unwrap();
    assert_eq!(close.expected_rev, office.rev);
    // The office's close names no reason code: the six codes are a
    // station's.
    let mut value = fixture("shift-close.json");
    value["reasonCode"] = Value::String("equipment_failure".into());
    assert!(serde_json::from_value::<ShiftClose>(value).is_err());
}

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL — 2 теста из 13 (11 прежних проходят): маршрута закрытия нет, `404` там, где ждут `200` или `409` на `shift_status`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved import `markiro_proto::ShiftClose` ``.

- [ ] **Step 3: Закрытие офисом**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const SHIFT_DELETE: &str = "shift.delete";
    /// A station opened a planned shift: its snapshot is frozen.
    pub const SHIFT_OPEN: &str = "shift.open";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const SHIFT_DELETE: &str = "shift.delete";
    /// A station opened a planned shift: its snapshot is frozen.
    pub const SHIFT_OPEN: &str = "shift.open";
    /// The office closed an active shift (a station's close is a fact, plan
    /// 2a2).
    pub const SHIFT_CLOSE: &str = "shift.close";
}

/// `details.reason` of a denied row: every denial names one.
```

2. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST`, `PUT …/{id}` (with
//! `expectedRev`) and `DELETE …/{id}` (administrators and technologists,
//! `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftCreate, ShiftMode, ShiftStatus, ShiftUpdate};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

заменить на

<!-- prettier-ignore -->
```rust
//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST`, `PUT …/{id}` (with
//! `expectedRev`), `DELETE …/{id}` and `POST …/{id}/close` (administrators
//! and technologists, `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftClose, ShiftCreate, ShiftMode, ShiftStatus, ShiftUpdate};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

3. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Ok(StatusCode::NO_CONTENT)
}

```

заменить на

<!-- prettier-ignore -->
```rust
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/office/shifts/{id}/close`: the office closes an active shift
/// with its reason in words, over `expectedRev`; a planned or a closed one
/// is `shift_status`. Facts a station sends for the shift afterwards are
/// taken and marked late (plan 2a2).
pub async fn close_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(close): ApiJson<ShiftClose>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    let reason = validate::close_reason("reason", &close.reason)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != close.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    if current.status != ShiftStatus::Active {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'office_user', \
         closed_by = ?, close_reason_text = ?, rev = ? WHERE id = ?",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&reason)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_CLOSE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "reason": reason }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let closed = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(closed))
}

```

4. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
                .delete(crate::routes::office_shifts::delete_shift),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
                .delete(crate::routes::office_shifts::delete_shift),
        )
        .route(
            "/v1/office/shifts/{id}/close",
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

5. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub fn civil_date(field: &str, text: &str) -> Result<time::Date, ApiError> {
    crate::shifts::civil_date(text)
        .ok_or_else(|| ApiError::validation(field, "a real calendar date YYYY-MM-DD is required"))
}

/// An identifier the client makes up (a station's request id): a UUID in
```

заменить на

<!-- prettier-ignore -->
```rust
pub fn civil_date(field: &str, text: &str) -> Result<time::Date, ApiError> {
    crate::shifts::civil_date(text)
        .ok_or_else(|| ApiError::validation(field, "a real calendar date YYYY-MM-DD is required"))
}

/// The office's reason for closing a shift: trimmed, 3-500 characters
/// without control characters (the cloud's `closeShiftSchema` takes three
/// at least).
pub fn close_reason(field: &str, text: &str) -> Result<String, ApiError> {
    let reason = text.trim();
    if is_plain(reason, 500) && reason.chars().take(3).count() == 3 {
        Ok(reason.to_owned())
    } else {
        Err(ApiError::validation(
            field,
            "the reason must be 3-500 characters without control characters",
        ))
    }
}

/// An identifier the client makes up (a station's request id): a UUID in
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

/// A shift as a station sees it (`GET /v1/device/shifts` and the answer of
/// `POST /v1/device/shifts`). The product's name and GTIN and the
/// counterparty's name are the snapshot's once the shift is open, so a
```

заменить на

<!-- prettier-ignore -->
```rust
    pub expected_rev: i64,
}

/// `POST /v1/office/shifts/{id}/close`: the office closes an active shift
/// (a station that died, a shift nobody will finish) with its reason in
/// words, 3–500 characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftClose {
    pub reason: String,
    pub expected_rev: i64,
}

/// A shift as a station sees it (`GET /v1/device/shifts` and the answer of
/// `POST /v1/device/shifts`). The product's name and GTIN and the
/// counterparty's name are the snapshot's once the shift is open, so a
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: PASS — 13 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 39 тестов фикстур.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`shift.open`; a second device's first entry (`shift.enter`) comes with plan
2b, since in stage 2a a station's first entry is the opening.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
`shift.open`; a second device's first entry (`shift.enter`) comes with plan
2b, since in stage 2a a station's first entry is the opening.

The office closes an active shift (`POST …/{id}/close`, `{ reason,
expectedRev }`, administrators and technologists), for a station that died or
a shift nobody will finish: the reason is words, 3–500 characters without
control characters (`validate::close_reason`), kept in `close_reason_text`; a
planned or a closed shift is `shift_status`. A station's close is a fact (plan
2a2) with one of the domain's six reason codes in `close_reason_code`, and the
facts of a shift the office closed are taken and marked late.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — закрывается запланированная. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if current.status != ShiftStatus::Active {
```

заменить на

<!-- prettier-ignore -->
```rust
    if current.status == ShiftStatus::Closed {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `only_an_active_shift_closes_and_only_with_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — причина из одного символа. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
reason.chars().take(3).count() == 3
```

заменить на

<!-- prettier-ignore -->
```rust
reason.chars().take(3).count() >= 1
```

Run: та же команда.
Expected: FAIL `only_an_active_shift_closes_and_only_with_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/shift-close.json apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 330 тестов, `proto` 44.

```bash
git add apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/shift-close.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): the office closes an active shift with its reason" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Блоки SSCC — `POST /v1/device/sscc/blocks`, код `sscc_exhausted`

Станция просит блок номеров SSCC префикса своей смены. Хост выдаёт следующие `site.box_block_size` серий счётчика (у конца ёмкости префикса — меньше, затем `sscc_exhausted`) и сдвигает счётчик за блок с новой ревизией в той же транзакции: выданная серия всегда ниже счётчика, правило «счётчик только вперёд» (`sscc_below_floor`) защищает её от повторной выдачи, а офисная форма счётчика, открытая до выдачи, получает `stale_revision`. Повтор `requestId` той же станцией отдаёт тот же блок. В 2a — только блоки коробов (`extension` 0). Новый код ошибки меняет общую фикстуру `error-codes.json`, которую сверяет и вебвью, поэтому `API_ERROR_CODES` и текст `errors.api.sscc_exhausted` меняются здесь же. Модульный комментарий `routes/sscc.rs` («the checks … join with the blocks in plan 2a») заменяется объяснением (§4.1 спецификации).

**Files:**

- Create: `apps/standalone/host/src/routes/sscc_blocks.rs`, `apps/standalone/proto/fixtures/sscc-block-request.json`, `apps/standalone/proto/fixtures/sscc-block.json`, `apps/standalone/proto/fixtures/error-sscc-exhausted.json`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/routes/sscc.rs` (комментарий модуля), `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs` (`codes::SSCC_EXHAUSTED`, `SsccBlockRequest`, `SsccBlock`), `apps/standalone/src/host/errors.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/host/tests/sscc_blocks.rs` (Create), `apps/standalone/proto/fixtures/error-codes.json`, `apps/standalone/proto/tests/fixtures.rs`; `apps/standalone/test/errors.test.ts` не меняется, но падает до правки `errors.ts`
- Modify: `apps/standalone/AGENTS.md` («Shifts»)

**Interfaces:**

- Consumes: `AuthDevice`, `validate::{client_uuid, serial_capacity}`, `sscc_counters`, `site.box_block_size`, `sscc_blocks` (задача 2); `admin`, `pair_device`, `json`, `with_device`, `audit_trail`, `audit_rows`, `host_revision` — `tests/support/app.rs`.
- Produces: `markiro_proto::{SsccBlockRequest { request_id, issuer_prefix, extension: u8 }, SsccBlock { id, issuer_prefix, extension: u8, from_serial: u64, to_serial: u64 }}`; `codes::SSCC_EXHAUSTED` (`"sscc_exhausted"`, в `codes::ALL`); `audit::actions::SSCC_BLOCK_ISSUE` (`"sscc.block.issue"`); `routes::sscc_blocks::issue_block`; `API_ERROR_CODES` с `"sscc_exhausted"`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/sscc_blocks.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    request, with_device, Admin, AuditRow,
};

const PREFIX: &str = "460068200";
const FIRST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const SECOND: &str = "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d";

fn block_request(request_id: &str) -> Value {
    json!({ "requestId": request_id, "issuerPrefix": PREFIX, "extension": 0 })
}

/// `POST /v1/device/sscc/blocks` with `key`.
async fn ask(admin: &Admin, key: &str, body: Value) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            body,
        ))
        .await
}

/// The box counter of `PREFIX` as the office reads it.
async fn box_counter(admin: &Admin) -> Value {
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    state["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["issuerPrefix"] == PREFIX && counter["extension"] == 0)
        .cloned()
        .expect("the wizard made the box counter")
}

async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

fn issued(device: &str, block: &Value) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        "sscc.block.issue".to_owned(),
        Some("sscc_block".to_owned()),
        Some(block["id"].as_str().unwrap().to_owned()),
        "ok".to_owned(),
        json!({
            "issuerPrefix": PREFIX, "extension": 0,
            "fromSerial": block["fromSerial"], "toSerial": block["toSerial"]
        }),
    )
}

#[tokio::test]
async fn a_station_gets_a_block_and_the_counter_moves_past_it() {
    let admin = admin().await;
    let station = device_id(&admin, &admin.key).await;
    // The wizard started the box counter at 1500 (revision 1); a block is
    // 2000 serials by default.
    let before = box_counter(&admin).await;
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{block}");
    assert_eq!(
        block,
        json!({
            "id": block["id"], "issuerPrefix": PREFIX, "extension": 0,
            "fromSerial": 1500, "toSerial": 3499
        })
    );
    assert!(uuid::Uuid::try_parse(block["id"].as_str().unwrap()).is_ok());
    let counter = box_counter(&admin).await;
    assert_eq!(
        (counter["nextSerial"].clone(), counter["rev"].clone()),
        (json!(3500), json!(2))
    );
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(
        audit_trail(&admin.app, "sscc.block.issue").await,
        vec![issued(&station, &block)]
    );
    // The same request again is the same block: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, repeated) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!((status, repeated), (StatusCode::OK, block.clone()));
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // The next request gets the next serials.
    let (status, next) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (status, next["fromSerial"].clone(), next["toSerial"].clone()),
        (StatusCode::OK, json!(3500), json!(5499))
    );
    // A counter form opened before the blocks is stale now, and the counter
    // never goes back under an issued serial.
    let path = format!("/v1/office/sscc/counters/{PREFIX}/0");
    let (status, refused) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 2000, "expectedRev": before["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );
    let (status, refused) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 5499, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("sscc_below_floor"),
            json!({ "minSerial": 5500 })
        )
    );
}

#[tokio::test]
async fn a_block_is_cut_short_at_the_end_of_the_prefix_and_then_exhausted() {
    let admin = admin().await;
    // A nine-digit prefix leaves seven digits of serials: 9 999 999 at most.
    let path = format!("/v1/office/sscc/counters/{PREFIX}/0");
    let (status, moved) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 9_999_000, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(9_999_000), json!(9_999_999))
    );
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(10_000_000));
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("sscc_exhausted"),
            json!({ "issuerPrefix": PREFIX, "extension": 0 })
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn a_block_takes_the_sites_block_size() {
    let admin = admin().await;
    let (status, sizes) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 1, "palletBlockSize": 200, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sizes}");
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(1500), json!(1500))
    );
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(1501));
}

#[tokio::test]
async fn only_a_station_gets_blocks_and_only_of_a_known_box_counter() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| {
        (
            StatusCode::BAD_REQUEST,
            json!({ "code": "validation_failed", "field": name }),
        )
    };
    for (change, expected) in [
        (
            json!({ "issuerPrefix": "460123400" }),
            field("issuerPrefix"),
        ),
        (json!({ "issuerPrefix": "4600682" }), field("issuerPrefix")),
        (json!({ "extension": 1 }), field("extension")),
        (json!({ "requestId": "first" }), field("requestId")),
        (
            json!({ "requestId": FIRST.to_uppercase() }),
            field("requestId"),
        ),
    ] {
        let mut body = block_request(FIRST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = ask(&admin, &admin.key, body).await;
        assert_eq!(
            (
                status,
                json!({
                    "code": refused["error"]["code"],
                    "field": refused["error"]["details"]["field"]
                })
            ),
            expected,
            "{change}"
        );
    }
    let mut body = block_request(FIRST);
    body["size"] = json!(10);
    let (status, refused) = ask(&admin, &admin.key, body).await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (StatusCode::BAD_REQUEST, Value::Null)
    );
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let (status, refused) = ask(&admin, &office_pc, block_request(FIRST)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let (status, refused) = admin
        .app
        .send(json_request(
            request("POST", "/v1/device/sscc/blocks"),
            block_request(FIRST),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    // Pairing the office PC wrote its row; nothing else changed.
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Another station's request with the same id is its own block.
    let (status, mine) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    let (_, other) = pair_device(&admin.app, "station").await;
    let (status, theirs) = ask(&admin, &other, block_request(FIRST)).await;
    assert_eq!(
        (status, theirs["fromSerial"].clone()),
        (StatusCode::OK, json!(3500))
    );
}
```

2. В `apps/standalone/proto/fixtures/error-codes.json` фрагмент

<!-- prettier-ignore -->
```json
    "rate_limited",
    "internal",
    "pairing_code_invalid",
    "pairing_code_expired"
  ]
}

```

заменить на

<!-- prettier-ignore -->
```json
    "rate_limited",
    "internal",
    "pairing_code_invalid",
    "pairing_code_expired",
    "sscc_exhausted"
  ]
}

```

3. Создать `apps/standalone/proto/fixtures/error-sscc-exhausted.json`:

<!-- prettier-ignore -->
```json
{
  "error": {
    "code": "sscc_exhausted",
    "message": "no serial of this prefix is left",
    "details": { "issuerPrefix": "460068200", "extension": 0 }
  }
}
```

4. Создать `apps/standalone/proto/fixtures/sscc-block-request.json`:

<!-- prettier-ignore -->
```json
{ "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a", "issuerPrefix": "460068200", "extension": 0 }
```

5. Создать `apps/standalone/proto/fixtures/sscc-block.json`:

<!-- prettier-ignore -->
```json
{
  "id": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
  "issuerPrefix": "460068200",
  "extension": 0,
  "fromSerial": 1500,
  "toSerial": 3499
}
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<ShiftClose>(value).is_err());
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<ShiftClose>(value).is_err());
}

#[test]
fn sscc_block_fixtures_round_trip_and_a_station_never_names_the_size() {
    let request: SsccBlockRequest = round_trip("sscc-block-request.json");
    let block: SsccBlock = round_trip("sscc-block.json");
    let state: SsccState = serde_json::from_value(fixture("sscc-state.json")).unwrap();
    // The first block starts where the box counter stood.
    let counter = &state.counters[0];
    assert_eq!(
        (&request.issuer_prefix, request.extension, block.from_serial),
        (
            &counter.issuer_prefix,
            counter.extension,
            counter.next_serial
        )
    );
    assert_eq!(
        block.to_serial - block.from_serial + 1,
        u64::from(state.box_block_size)
    );
    let mut value = fixture("sscc-block-request.json");
    value["size"] = Value::from(10);
    assert!(serde_json::from_value::<SsccBlockRequest>(value).is_err());
    let exhausted: ErrorBody = round_trip("error-sscc-exhausted.json");
    assert_eq!(exhausted.error.code, codes::SSCC_EXHAUSTED);
}

```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --offline --locked`
Expected: FAIL — 4 теста из 4: маршрута нет (`404` там, где ждут `200` или `400` на `issuerPrefix`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — не компилируется: ``error[E0432]: unresolved imports `markiro_proto::SsccBlock`, `markiro_proto::SsccBlockRequest` `` и ``error[E0425]: cannot find value `SSCC_EXHAUSTED` in module `codes` ``.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/errors.test.ts`
Expected: FAIL — `list exactly the host's error codes (proto/fixtures/error-codes.json)`: в фикстуре есть `sscc_exhausted`, в `API_ERROR_CODES` нет.

- [ ] **Step 3: Выдача блоков и код `sscc_exhausted`**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// The office closed an active shift (a station's close is a fact, plan
    /// 2a2).
    pub const SHIFT_CLOSE: &str = "shift.close";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The office closed an active shift (a station's close is a fact, plan
    /// 2a2).
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
}

/// `details.reason` of a denied row: every denial names one.
```

2. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod template_defaults;
pub mod templates;

```

заменить на

<!-- prettier-ignore -->
```rust
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod sscc_blocks;
pub mod template_defaults;
pub mod templates;

```

3. В `apps/standalone/host/src/routes/sscc.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! SSCC counters and block sizes: `GET /v1/office/sscc` (every role);
//! `PUT …/counters/{prefix}/{extension}` and `PUT …/block-sizes`
//! (administrators). Counters only move forward (spec §4.3); the checks for
//! active shifts and issued blocks join with the blocks in plan 2a.

use axum::extract::State;
use axum::http::StatusCode;
```

заменить на

<!-- prettier-ignore -->
```rust
//! SSCC counters and block sizes: `GET /v1/office/sscc` (every role);
//! `PUT …/counters/{prefix}/{extension}` and `PUT …/block-sizes`
//! (administrators). Counters only move forward (spec §4.3). Issuing a block
//! to a station (`routes/sscc_blocks.rs`) moves its counter past the block
//! in the same transaction, with a new revision, so every issued serial lies
//! below its counter and `sscc_below_floor` keeps it from being issued
//! again, and a counter form opened before an issue meets `stale_revision`.

use axum::extract::State;
use axum::http::StatusCode;
```

4. Создать `apps/standalone/host/src/routes/sscc_blocks.rs`:

<!-- prettier-ignore -->
```rust
//! SSCC blocks (stage 2a spec §4.3): `POST /v1/device/sscc/blocks`, for
//! stations only. A station asks for a block when it has none for its
//! shift's prefix or its newest is half used; the host gives the next
//! `site.box_block_size` serials of the counter (fewer at the end of the
//! prefix's serials, then `sscc_exhausted`) and moves the counter past them
//! with a new revision in the same transaction. A repeated `requestId` of
//! the same station answers the same block, even after others were issued.
//! Revoking blocks and a screen of them per device are plan 2b's.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{codes, DeviceKind, SsccBlock, SsccBlockRequest};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

async fn read(
    conn: &mut SqliteConnection,
    device_id: &str,
    request_id: &str,
) -> Result<Option<SsccBlock>, ApiError> {
    let row: Option<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, issuer_prefix, extension, from_serial, to_serial FROM sscc_blocks \
         WHERE device_id = ? AND request_id = ?",
    )
    .bind(device_id)
    .bind(request_id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(|(id, issuer_prefix, extension, from_serial, to_serial)| {
        Ok(SsccBlock {
            id,
            issuer_prefix,
            extension: u8::try_from(extension).map_err(ApiError::internal)?,
            from_serial: u64::try_from(from_serial).map_err(ApiError::internal)?,
            to_serial: u64::try_from(to_serial).map_err(ApiError::internal)?,
        })
    })
    .transpose()
}

pub async fn issue_block(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<SsccBlockRequest>,
) -> Result<Json<SsccBlock>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden("only a station gets SSCC blocks"));
    }
    validate::client_uuid("requestId", &request.request_id)?;
    // Pallets (extension 1) come with plan 2b.
    if request.extension != 0 {
        return Err(ApiError::validation(
            "extension",
            "only box blocks (extension 0) are issued for now",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await? {
        // Nothing to write: the transaction rolls back when dropped.
        return Ok(Json(block));
    }
    let next: Option<i64> = sqlx::query_scalar(
        "SELECT next_serial FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let next = next.ok_or_else(|| ApiError::validation("issuerPrefix", "no such SSCC counter"))?;
    let next = u64::try_from(next).map_err(ApiError::internal)?;
    let size: i64 = sqlx::query_scalar("SELECT box_block_size FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let size = u64::try_from(size).map_err(ApiError::internal)?;
    let capacity = validate::serial_capacity(&request.issuer_prefix);
    if next >= capacity {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::SSCC_EXHAUSTED,
            "no serial of this prefix is left",
        )
        .with_details(json!({
            "issuerPrefix": request.issuer_prefix,
            "extension": request.extension,
        })));
    }
    let to = (next + size - 1).min(capacity - 1);
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_counters SET next_serial = ?, rev = ? WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(i64::try_from(to + 1).map_err(ApiError::internal)?)
    .bind(rev)
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .bind(&device.id)
    .bind(&request.request_id)
    .bind(i64::try_from(next).map_err(ApiError::internal)?)
    .bind(i64::try_from(to).map_err(ApiError::internal)?)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SSCC_BLOCK_ISSUE,
            target_type: Some("sscc_block"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "issuerPrefix": request.issuer_prefix,
                "extension": request.extension,
                "fromSerial": next,
                "toSerial": to,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(SsccBlock {
        id,
        issuer_prefix: request.issuer_prefix,
        extension: request.extension,
        from_serial: next,
        to_serial: to,
    }))
}
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/shifts/{id}/enter",
            post(crate::routes::device_shifts::enter_shift),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/shifts/{id}/enter",
            post(crate::routes::device_shifts::enter_shift),
        )
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const INTERNAL: &str = "internal";
    pub const PAIRING_CODE_INVALID: &str = "pairing_code_invalid";
    pub const PAIRING_CODE_EXPIRED: &str = "pairing_code_expired";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const INTERNAL: &str = "internal";
    pub const PAIRING_CODE_INVALID: &str = "pairing_code_invalid";
    pub const PAIRING_CODE_EXPIRED: &str = "pairing_code_expired";
    /// The SSCC counter of a prefix reached the end of its serials: no block
    /// of it can be issued any more.
    pub const SSCC_EXHAUSTED: &str = "sscc_exhausted";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
```

7. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        INTERNAL,
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
    ];
}

```

заменить на

<!-- prettier-ignore -->
```rust
        INTERNAL,
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
        SSCC_EXHAUSTED,
    ];
}

```

8. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    pub expected_rev: i64,
}

/// An office user as the administrator sees it.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    pub expected_rev: i64,
}

/// `POST /v1/device/sscc/blocks`: a station asks for a block of serials of
/// an issuer prefix (its shift's snapshot names it) and an extension (0, a
/// box, in stage 2a). `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccBlockRequest {
    pub request_id: String,
    pub issuer_prefix: String,
    pub extension: u8,
}

/// A block of SSCC serials issued to one station, both ends included; the
/// station builds the SSCC with the domain's `buildSscc`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccBlock {
    pub id: String,
    pub issuer_prefix: String,
    pub extension: u8,
    pub from_serial: u64,
    pub to_serial: u64,
}

/// An office user as the administrator sees it.
```

9. В `apps/standalone/src/host/errors.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "internal",
  "pairing_code_invalid",
  "pairing_code_expired",
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);
```

заменить на

<!-- prettier-ignore -->
```ts
  "internal",
  "pairing_code_invalid",
  "pairing_code_expired",
  "sscc_exhausted",
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);
```

10. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "rate_limited": "Слишком много попыток. Подождите минуту и попробуйте снова.",
      "internal": "На хосте произошла ошибка. Повторите попытку.",
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе."
    },
    "device": {
      "config_unreadable": "Настройки подключения к хосту повреждены.",
```

заменить на

<!-- prettier-ignore -->
```json
      "rate_limited": "Слишком много попыток. Подождите минуту и попробуйте снова.",
      "internal": "На хосте произошла ошибка. Повторите попытку.",
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе.",
      "sscc_exhausted": "Номера SSCC этого префикса закончились. Нужен новый GLN организации."
    },
    "device": {
      "config_unreadable": "Настройки подключения к хосту повреждены.",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --test office_admin --offline --locked`
Expected: PASS — 4 и 11 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 модульных тестов и 40 тестов фикстур.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/errors.test.ts`
Expected: PASS — 4 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
2a2) with one of the domain's six reason codes in `close_reason_code`, and the
facts of a shift the office closed are taken and marked late.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
2a2) with one of the domain's six reason codes in `close_reason_code`, and the
facts of a shift the office closed are taken and marked late.

SSCC blocks: a station asks for a block of serials
(`POST /v1/device/sscc/blocks`, `{ requestId, issuerPrefix, extension }`,
stations only) when it has none for its shift's prefix or its newest is half
used (plan 2a6). Stage 2a issues box blocks only (`validation_failed` on
`extension` otherwise), of a prefix that has a counter (`validation_failed` on
`issuerPrefix` otherwise). A block is the counter's next `site.box_block_size`
serials (2000 by default, «SSCC → Размеры блоков»), fewer at the end of the
prefix's serials, and then `sscc_exhausted` (409, with the prefix and the
extension). The counter moves past the block with a new revision in the same
transaction, so every issued serial lies below its counter, `sscc_below_floor`
keeps it from being issued again, and a counter form opened before the issue
meets `stale_revision`. The same `requestId` of the same station answers the
same block, even after others were issued. A block's use (`consumed_through`)
comes with the facts of plan 2a2; revoking blocks and showing them per device
with plan 2b.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — блок не обрезается у конца ёмкости. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let to = (next + size - 1).min(capacity - 1);
```

заменить на

<!-- prettier-ignore -->
```rust
    let to = next + size - 1;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --offline --locked`
Expected: FAIL `a_block_is_cut_short_at_the_end_of_the_prefix_and_then_exhausted`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — повтор `requestId` выдаёт новый блок. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await? {
```

заменить на

<!-- prettier-ignore -->
```rust
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await?.filter(|_| false) {
```

Run: та же команда.
Expected: FAIL `a_station_gets_a_block_and_the_counter_moves_past_it`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — выдача не меняет ревизию счётчика. В том же файле фрагмент

<!-- prettier-ignore -->
```rust
"UPDATE sscc_counters SET next_serial = ?, rev = ? WHERE issuer_prefix = ? AND extension = ?"
```

заменить на

<!-- prettier-ignore -->
```rust
"UPDATE sscc_counters SET next_serial = ?, rev = rev + 0 * ? WHERE issuer_prefix = ? AND extension = ?"
```

Run: та же команда.
Expected: FAIL `a_station_gets_a_block_and_the_counter_moves_past_it` (старая форма счётчика получает `sscc_below_floor`, а не `stale_revision`). Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/sscc-block-request.json apps/standalone/proto/fixtures/sscc-block.json apps/standalone/proto/fixtures/error-sscc-exhausted.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json apps/standalone/AGENTS.md`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec eslint src/host/errors.ts`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 334 теста, `proto` 45.

```bash
git add apps/standalone/host/src/routes/sscc_blocks.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/sscc.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/sscc_blocks.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/sscc-block-request.json apps/standalone/proto/fixtures/sscc-block.json apps/standalone/proto/fixtures/error-sscc-exhausted.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): SSCC blocks for stations and the sscc_exhausted code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Табельные номера, которые отличаются только ведущими нулями (вопрос В13)

Табельный номер — текст с ведущими нулями, и станция сравнивает его точно. Но на клавиатуре `042` и `0042` — одна опечатка, поэтому (вариант А вопроса В13) хост отвергает новый номер, который отличается от существующего только ведущими нулями: `conflict` на `login` с `details.similarLogin` — номер, который стоит на пути. Форма оператора в офисе уже показывает `conflict` на `login` под полем («Этот табельный номер уже занят»), правка вебвью не нужна. Номер оператора никогда не меняется, поэтому проверка — только при создании. Уже существующие пары таких номеров остаются как есть.

**Files:**

- Modify: `apps/standalone/host/src/routes/operators.rs` (`create_operator`)
- Test: `apps/standalone/host/tests/operators.rs` (тест `personnel_numbers_are_unique_with_their_leading_zeros` заменяется: прежде он закреплял, что `042` — другой оператор)
- Modify: `apps/standalone/AGENTS.md` («Operators and badges»)

**Interfaces:**

- Consumes: `create_operator`, `OfficeContext::require_admin_in`, `ApiError::conflict`.
- Produces: отказ `conflict` `{ constraint: "login", similarLogin }` у `POST /v1/office/operators`.

- [ ] **Step 1: Тест (падающий)**

1. В `apps/standalone/host/tests/operators.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn personnel_numbers_are_unique_with_their_leading_zeros() {
    let admin = admin().await;
    create(&admin).await;
    let (status, body) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0042")))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("login"))
    );
    assert_eq!(host_revision(&admin.app).await, 2);
    // Leading zeros are part of the number: 042 is another operator.
    let (status, other) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("042")))
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 2);
}

#[tokio::test]
```

заменить на

<!-- prettier-ignore -->
```rust
}

#[tokio::test]
async fn personnel_numbers_are_unique_and_never_differ_by_leading_zeros_alone() {
    let admin = admin().await;
    create(&admin).await;
    // The same number, and one that differs only by leading zeros, which a
    // keypad would mix up with it (owner question В13), are both taken; the
    // answer names the number that stands in the way.
    for login in ["0042", "042", "000042"] {
        let (status, body) = admin
            .call("POST", "/v1/office/operators", Some(new_operator(login)))
            .await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "login", "similarLogin": "0042" })
            ),
            "{login}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 1);
    // Leading zeros stay part of the number: 0420 and 0043 are others.
    for login in ["0420", "0043"] {
        let (status, other) = admin
            .call("POST", "/v1/office/operators", Some(new_operator(login)))
            .await;
        assert_eq!(status, StatusCode::OK, "{other}");
        assert_eq!(other["login"], login);
    }
    // Numbers of zeros alone are the same number too.
    let (status, zeros) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("000")))
        .await;
    assert_eq!(status, StatusCode::OK, "{zeros}");
    let (status, body) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0000")))
        .await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "login", "similarLogin": "000" })
        )
    );
}

#[tokio::test]
```

- [ ] **Step 2: Запустить тест — он падает**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline --locked`
Expected: FAIL — `personnel_numbers_are_unique_and_never_differ_by_leading_zeros_alone`: отказ на `0042` — `{ "constraint": "login" }` без `similarLogin` (уникальный индекс), а `042` принят.

- [ ] **Step 3: Проверка ведущих нулей**

1. В `apps/standalone/host/src/routes/operators.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
```

заменить на

<!-- prettier-ignore -->
```rust
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // A number that differs from another only by leading zeros (`042` next
    // to `0042`) is taken too (owner question В13): on a keypad the two are
    // one slip apart. The unique index stays the guard of the exact number.
    let similar: Option<String> =
        sqlx::query_scalar("SELECT login FROM operators WHERE ltrim(login, '0') = ltrim(?, '0')")
            .bind(&login)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if let Some(similar) = similar {
        return Err(
            ApiError::conflict("login", "this personnel number is already taken")
                .with_details(json!({ "constraint": "login", "similarLogin": similar })),
        );
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
```

- [ ] **Step 4: Запустить тест — он проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --test badges --offline --locked`
Expected: PASS — 11 и 8 тестов.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
and `badge-create.json` byte for byte. The forms' rules (`src/lib/rules.ts`)
follow the host's for a personnel number of 3–12 ASCII digits, kept as text
with its leading zeros, a role of up to 120 characters and a label of up to
100, both blank for none. The PIN rule, 4–6 ASCII digits, mirrors the
cloud's (`apps/api/src/modules/operators/dto.ts`): the host never sees a
PIN. A badge code is what a scanner types: trimmed, 1–256 printable ASCII
characters, and hashed exactly so. A keyboard-wedge scanner presses keys,
```

заменить на

<!-- prettier-ignore -->
```text
and `badge-create.json` byte for byte. The forms' rules (`src/lib/rules.ts`)
follow the host's for a personnel number of 3–12 ASCII digits, kept as text
with its leading zeros, a role of up to 120 characters and a label of up to
100, both blank for none. Since plan 2a1 the host also refuses a new number
that differs from an existing one only by leading zeros (`042` next to
`0042`, which a keypad mixes up; owner question В13): `conflict` on `login`
with `similarLogin`, the number in the way, which the office's form shows as
a taken number. The PIN rule, 4–6 ASCII digits, mirrors the
cloud's (`apps/api/src/modules/operators/dto.ts`): the host never sees a
PIN. A badge code is what a scanner types: trimmed, 1–256 printable ASCII
characters, and hashed exactly so. A keyboard-wedge scanner presses keys,
```

- [ ] **Step 6: Мутации**

М1 — проверка ведущих нулей снята. В `apps/standalone/host/src/routes/operators.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(similar) = similar {
```

заменить на

<!-- prettier-ignore -->
```rust
    if let Some(similar) = similar.filter(|_| false) {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline --locked`
Expected: FAIL `personnel_numbers_are_unique_and_never_differ_by_leading_zeros_alone`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline --locked`
Expected: PASS — хост 334 теста, `proto` 45.

```bash
git add apps/standalone/host/src/routes/operators.rs apps/standalone/host/tests/operators.rs apps/standalone/AGENTS.md
git commit -m "feat(standalone): a personnel number never differs from another by leading zeros alone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Журнал процесса со снимком смены; уточнения в спецификации; полная проверка

Снимок открытой смены несёт макет шаблона до 256 КБ; макет — не секрет, но в журнал процесса не пишется (правило «Logs»). `no_secrets_in_logs.rs` проводит смену через весь путь плана — план офиса, вход станции со снимком, список станции, блок SSCC, закрытие офисом — и проверяет, что метка макета есть в снимке, который хранит хост, но нет в журнале. Код хоста не меняется: тест проходит сразу и служит ограждением, а мутация М1 показывает, что он ловит снимок в журнале. Решения планировщика записываются в спецификацию 2a (§15).

**Files:**

- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`
- Modify: `apps/standalone/AGENTS.md` («Logs»), `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (новый §15)

**Interfaces:**

- Consumes: маршруты задач 2, 4–7; `layout`, `support::pinned_client` — `no_secrets_in_logs.rs`.
- Produces: —

- [ ] **Step 1: Тест**

1. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too. Its own binary, because it
//! installs the global tracing subscriber.

mod support;

```

заменить на

<!-- prettier-ignore -->
```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Its own binary, because it installs the global tracing
//! subscriber.

mod support;

```

2. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(catalog_feed.status(), 200);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
    let wrong_device = client
```

заменить на

<!-- prettier-ignore -->
```rust
        .unwrap();
    assert_eq!(catalog_feed.status(), 200);

    // A shift (plan 2a1): planned with the office's template, opened by the
    // station, which gets the snapshot with the whole layout, read back in
    // its list, given an SSCC block, and closed by the office. The layout
    // is in the snapshot the host keeps, never in the log.
    let lines: serde_json::Value = client
        .get(format!("{base}/v1/office/lines"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let line_id = lines[0]["id"].as_str().unwrap().to_owned();
    let on_line = client
        .put(format!("{base}/v1/device/line"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "lineId": line_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(on_line.status(), 200);
    let milk: serde_json::Value = client
        .post(format!("{base}/v1/office/products"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "gtin14": "04600682000020", "name": "Кефир", "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": 40
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift: serde_json::Value = client
        .post(format!("{base}/v1/office/shifts"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "productId": milk["id"], "lineId": line_id, "productionDate": "2026-10-08",
            "boxTemplateId": template_id
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift_id = shift["id"].as_str().unwrap().to_owned();
    let entered = client
        .post(format!("{base}/v1/device/shifts/{shift_id}/enter"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(entered.status(), 200);
    let entered = entered.text().await.unwrap();
    assert!(
        entered.contains("layout-marker-office-2"),
        "the entry carries the snapshot with the layout"
    );
    let device_shifts = client
        .get(format!("{base}/v1/device/shifts"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(device_shifts.status(), 200);
    let block = client
        .post(format!("{base}/v1/device/sscc/blocks"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
            "issuerPrefix": "460068200", "extension": 0
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(block.status(), 200);
    let opened: serde_json::Value = client
        .get(format!("{base}/v1/office/shifts/{shift_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let closed = client
        .post(format!("{base}/v1/office/shifts/{shift_id}/close"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "reason": "Проверка журнала", "expectedRev": opened["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 200);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
    let wrong_device = client
```

3. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .fetch_all(&pool)
        .await
        .unwrap();
    let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();
    pool.close().await;

```

заменить на

<!-- prettier-ignore -->
```rust
        .fetch_all(&pool)
        .await
        .unwrap();
    let snapshots: Vec<String> =
        sqlx::query_scalar("SELECT snapshot FROM shifts WHERE snapshot IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();
    pool.close().await;

```

4. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "the host never kept {kept}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            "the host never kept {kept}"
        );
    }
    assert!(
        snapshots
            .iter()
            .any(|snapshot| snapshot.contains("layout-marker-office-2")),
        "the shift never froze the layout"
    );
}

```

- [ ] **Step 2: Запустить тест — он проходит**

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: PASS — 1 тест (код уже не пишет снимок в журнал; доказательство — мутация М1).

- [ ] **Step 3: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
layout is no secret, but at up to 256 KB it stays
out of the log as it stays out of audit details; `no_secrets_in_logs.rs`
walks a stock and an office layout through the template routes, the
defaults and the feed. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

заменить на

<!-- prettier-ignore -->
```text
layout is no secret, but at up to 256 KB it stays
out of the log as it stays out of audit details; `no_secrets_in_logs.rs`
walks a stock and an office layout through the template routes, the
defaults and the feed, and a shift's snapshot that carries a layout through
the plan, the station's entry and list, an SSCC block and the office's
close. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

2. В `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` фрагмент

<!-- prettier-ignore -->
```text
  `apps/standalone/src-tauri` без смены `Cargo.lock` других крейтов.
- Размеры планов — оценка по объёму облачных модулей, не по прототипу.

```

заменить на

<!-- prettier-ignore -->
```text
  `apps/standalone/src-tauri` без смены `Cargo.lock` других крейтов.
- Размеры планов — оценка по объёму облачных модулей, не по прототипу.

## 15. Уточнения плана 2a1

План `docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md` (хост) уточняет разделы
4 и 6 так; пока владелец не ответил на вопросы раздела 11, действуют рекомендованные варианты, и
план перечисляет эти допущения.

- Неизвестный товар при создании смены — `validation_failed` на `productId`; `conflict`
  `product_inactive` — только черновик и архив (решение 8 называло оба случая одним отказом).
- Правка запланированной смены проверяет только изменённые линию, шаблон и контрагента; оставшиеся
  прежними не проверяются (шаблон проверит открытие — `template_not_fit`); смена шаблона требует,
  чтобы товар был в работе.
- `OfficeShift` несёт идентификаторы, а не имена: офис называет записи по своим спискам. Итоги
  (`totals`) в `GET /v1/office/shifts/{id}` добавляет план 2a2.
- `DeviceShift` называет товар и контрагента по снимку, когда смена открыта, и по записям — до
  того; несёт `ownerDeviceId`; снимок — только в ответе на вход. Типы снимка — `ShiftSnapshot`,
  `ShiftSnapshotProduct`, `ShiftSnapshotTemplate`.
- Маршруты смен и блоков SSCC устройства — только для станции (иной вид — `forbidden`), чтение
  списка смен тоже.
- Вход владельца в смену после перевода станции на другую линию — тоже `shift_line`.
- `requestId` создания смены и запроса блока — UUID в канонической записи (строчные буквы,
  дефисы).
- `shift.enter` в 2a не пишется: первый вход станции — открытие (`shift.open`); запись появится со
  вторым устройством (2b).
- Повторный `DELETE` смены после потерянного ответа — `not_found`: надгробий у смен нет.
- Окно «31 день» списка офиса без периода считается по дате UTC часов хоста.
- `sscc_exhausted` — HTTP 409 с `details.issuerPrefix` и `details.extension`.
- Табельный номер, который отличается от существующего только ведущими нулями, — `conflict` на
  `login` с `details.similarLogin` (вопрос В13, рекомендованный вариант).
- `PROTOCOL_VERSION` → 2 уже в 2a1 — вместе с тестами пробы хоста в оболочке и зеркалом в
  `src/host/protocol.ts`, хотя маршрутами протокола 2 станция начнёт пользоваться в плане 2a5.

```

- [ ] **Step 4: Мутации**

М1 — открытие пишет снимок в журнал. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active'
```

заменить на

<!-- prettier-ignore -->
```rust
    tracing::info!(snapshot = %serde_json::to_string(&snapshot).unwrap_or_default(), "shift opened");
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active'
```

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: FAIL `secrets_never_reach_the_process_log` — «the process log contains layout-marker-office-2». Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 5: Полная проверка и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

Run (`apps/standalone/dist` собран, вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --locked`
Expected: PASS — 46 наборов, 494 теста (хост 334, `proto` 45, оболочка 115), без предупреждений компилятора.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `typecheck` и `lint` того же пакета
Expected: PASS — 67 файлов, 1744 теста; `typecheck` и `lint` без ошибок.

```bash
git add apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "test(standalone): the process log holds no shift snapshot; the stage 2a spec takes plan 2a1's refinements" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] Вне песочницы: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --locked` — 46 наборов, 494 теста (было 42 и 461; хост 334 вместо 307, `proto` 45 вместо 39, оболочка 115), без предупреждений компилятора.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 67 файлов, 1744 теста (было 66 и 1716); `typecheck` и `lint` — без ошибок.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым JSON, TS и MD — чисто; `git diff --check <начало плана>..HEAD` — чисто; `grep -rn '\\u0' apps/standalone/host/src apps/standalone/host/tests apps/standalone/proto` находит только прежние совпадения.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*`, миграции `0001`–`0008` не менялись; в оболочке — только модуль тестов `src-tauri/src/host_probe.rs`; в вебвью — `src/host/errors.ts`, `src/host/protocol.ts`, `src/i18n/ru.json` и два теста.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - новыми маршрутами пока никто не пользуется: экраны офиса (2a3) и цеха (2a5–2a8) их не зовут; снимок с настоящим макетом домена через станцию не проводился (тесты шлют маленькие макеты), проверка снимка `labelTemplateSpecSchema` — план 2a5;
  - протокол 2 на живой паре «хост этапа 1 — станция 2a» и «хост 2a — станция этапа 1» вручную не проверялся: доказательство — тесты пробы и `protocol_guard`;
  - задания CI `standalone-rust` и `standalone-windows-build` — для них нужен push; `standalone-windows-build` по-прежнему ждёт шага владельца плана 1f2 (`apps/standalone/AGENTS.md`, «Verification»), этот план Windows-кода не добавляет;
  - смены на Windows (служба хоста, WebView2) — вне этого плана.

---

## Перенесено

- План 2a2 (хост: факты): миграция `0010`, приём фактов с квитанциями, `consumed_through` блоков, `late_data_at`, закрытие станцией (`shift_closed`, `close_reason_code`, `closed_by_kind = device`), проверка кода, итоги смены — поле `totals` в `GET /v1/office/shifts/{id}` (добавление в ответ совместимо); фикстуры `facts-request.json`, `facts-response.json`, `fact-receipt-codes.json`, `box-digest.json`, `exception-reasons.json`, `code-check-*.json`; дополнение `no_secrets_in_logs.rs` пачкой фактов с криптохвостом.
- План 2a3 (офис): схемы Zod и проверки Vitest для фикстур этого плана — `office-shift.json`, `shift-create.json`, `shift-update.json`, `shift-close.json`, `error-shift-busy.json`, `error-sscc-exhausted.json`; построители `shiftCreate` (с явными `mode: "aggregation"` и `palletsEnabled: false`), `shiftUpdate` (только изменённое; `null` очищает план и контрагента, `null` в других полях хост читает как «не прислано»), `shiftClose`; методы `HostApi`; `useCan("planShifts")`; пометка запланированной смены, которую нельзя открыть (шаблон выключен или не подходит, товар в архиве или черновик), — по спискам товаров и шаблонов, которые офис читает сам; подпись `similarLogin` в форме оператора, если владелец захочет точнее, чем «номер занят»; повторный `DELETE` смены отвечает `not_found` — страница принимает его как «уже удалена».
- План 2a5 (цех): схемы Zod для `device-shifts.json`, `device-shift-create.json`, `device-shift-entered.json` (`deviceShiftSchema` — `z.object`; макет снимка — непрозрачный объект, проверяемый `labelTemplateSpecSchema` при входе); `getDeviceShifts`, `createDeviceShift`, `enterShift`; чтение смен после подписки на связь и каждого события ревизии; `ownerDeviceId` чужой станции — смена занята; экран «хост старше приложения» на `protocol_unsupported` любого вызова устройства.
- План 2a6 (цех): `requestSsccBlock` и схемы `sscc-block-request.json`, `sscc-block.json`; правило «половина»; `floor_block_requests`.
- План 2b: второе устройство на смене и строка `shift.enter`; отзыв блоков (`revoked_at`) и экран блоков по устройствам; вход владельца после перевода станции на другую линию (сейчас `shift_line`) — вместе с правилами многоустройственной смены.
- Решения владельца ждут: вопросы раздела 11 спецификации 2a (допущения — в начале плана); окно «31 день» списка офиса считается по UTC-дате хоста, а не по часовому поясу организации (у хоста нет базы часовых поясов) — разница в один день на границе окна.
- Наблюдение при проверке плана: из четырёх полных прогонов Vitest на копии с кодом плана один упал, три прошли (67 файлов, 1744 теста); падавший файл не записан. Задачи плана не трогают экраны; при повторе падения стоит сохранить вывод и проверить известный флейк эффектов React в полном прогоне.

---

## Отклонения при исполнении
