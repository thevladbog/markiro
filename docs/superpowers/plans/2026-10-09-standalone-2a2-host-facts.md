# План 2a2: хост — факты (приём пачек с квитанциями, сканы и реестр кодов, `box_closed`, проверка этикетки и исключения, закрытие смены станцией и поздние данные), проверка кода, итоги смены — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автономного продукта принимает факты станции пачками по HTTP — сканы, закрытые короба, проверки этикеток, исключения и закрытие смены — и отвечает квитанцией на каждую запись: та же запись ещё раз получает ту же квитанцию, испорченная запись отклоняется, а не роняет пачку. Хост ведёт реестр кодов («самый ранний скан» в обе стороны), проверяет SSCC короба по блоку этого устройства, освобождает коды исключениями, закрывает смену по факту станции и отмечает поздние данные закрытой смены; станция спрашивает, занят ли код; офис видит итоги смены числами. Экраны офиса и цеха, отправка очереди и сквозной сценарий — планы 2a3–2a8; этот план готовит им API, данные и фикстуры.

**Architecture:**

- `host/migrations/0010_facts.sql` — `fact_receipts`, `scans`, `boxes`, `box_items`, `code_owners`, `code_conflicts`, `box_exceptions`, `shift_close_events`.
- `host/src/facts/` — `rules.rs` (правила с общими фикстурами: дайджест короба, момент устройства, причина закрытия, отпечаток записи), `mod.rs` (приём записи: квитанция, идемпотентность, общие проверки, закрытие смены и поздняя отметка с одной ревизией на пачку), `scan.rs`, `registry.rs`, `boxes.rs`, `box_closed.rs`, `box_label.rs`, `exception.rs`, `shift_closed.rs` — по обработчику на вид.
- `host/src/routes/facts.rs` — `POST /v1/device/facts`; `host/src/routes/codes.rs` — `GET /v1/device/codes/{codeHash}`; `host/src/routes/office_shifts.rs` — `totals` в каждом `OfficeShift`; `host/src/auth.rs` — `AuthDevice::require_live_in` (перечитывание устройства любого вида в транзакции пачки), на котором теперь строится `require_station_in` финальной волны 2a1.
- `proto` — конверт `FactRecord`, данные пяти видов, `FactReceipt`, `CodeCheck`, `CodeOwner`, `ShiftTotals`, константы `receipt_codes`, `exception_reasons`, `shift_close_reasons` и фикстуры; вебвью — только Vitest общих фикстур правил (`test/fact-rules.test.ts`).

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite 3.46: частичные индексы, `json_extract`, `json_group_array(… ORDER BY …)`), tokio 1.53.1, serde, serde_json (без `preserve_order`), time 0.3.55, aws-lc-rs 1.18.1 (SHA-256), uuid 1; TypeScript — Vitest 4 и zod 4 (только один новый тест).

**База:** ветка `claude/autonomous-desktop-station-9e6f13`, коммит `0a21a3f2c` (план 2a1 с его финальной волной: `AuthDevice::require_station_in`, отказ повтора `requestId` блока с другим префиксом, ужесточённые проверки `0009`, документы). Каждый фрагмент плана применён к этому коммиту.

**Спецификации:**

- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (черновик этапа 2a): §2 (решения 1, 11–18, 31, 36), §4.4–4.6, §4.8–4.11, §6, §7, строка 2a2 раздела 8, §11 (вопросы владельцу), §15 (уточнения 2a1).
- `docs/superpowers/specs/2026-09-26-standalone-station-design.md`: §6.4 (канал «устройство → хост»), §6.5 (дубли и «самый ранний скан»), §6.6 (блоки SSCC), §6.9 (закрытие офисом и поздние данные).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: протокол, ошибки, журнал действий.
- `apps/standalone/AGENTS.md` — обязательные правила («Writes», «Protocol», «Audit», «Logs», «Shifts», «Verification»); образец формы — план 2a1 (`docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md`).
- Облако, с которого сняты правила: `packages/domain/src/sync/box-reconciliation.ts` (`boxMembershipDigestV1`), `packages/domain/src/shift-close.ts` (`SHIFT_CLOSE_REASON_CODES`, `shiftCloseReasonRequired`), `apps/api/src/modules/station-scans/conflict-resolution.ts` (`collapseClaims`: самый ранний `scannedAt`, ничья — у владельца), `box_exceptions_kind_payload_check` (`packages/db`), `apps/api/src/modules/station-shift-close/station-shift-close.service.ts`.

## Допущения по вопросам владельцу

Владелец ответил «по порядку», не выбрав варианты раздела 11 спецификации 2a. План принимает рекомендованный вариант каждого вопроса, который касается хоста в 2a2; ниже — что принято и что поменять, если ответ будет другим.

- **В1 — граница 2a и 2b: вариант А.** Факты одной смены шлёт одно устройство (вход второго хост отказал в 2a1), но канал фактов уже идемпотентен и досылаем (задача 2), реестр кодов применяет «самый ранний скан» в обе стороны и пишет `code_conflicts`, а квитанция `conflict` называет победителя (задача 2). Уведомление вытесненного устройства и разбор конфликтов в офисе — 2b. При варианте Б (без хоста линия встаёт) канал фактов всё равно нужен; поменялась бы только станция.
- **В4 — закрытие активной смены из офиса уже в 2a: вариант А.** Факты смены, закрытой офисом, принимаются и один раз ставят `late_data_at`; закрытие станцией такой смены — `accepted` с `alreadyClosed` (задача 6). При варианте Б закрытия офисом нет, и поздних данных в 2a не бывает: задача 6 остаётся (закрытие станцией), её поздняя отметка просто не встречается.
- **В6 — значения по умолчанию: принять.** Проверка КМ на хосте отвечает без блокировки записи (задача 3), предел 300 мс — правило оболочки и станции (планы 2a4 и 2a6); срок хранения 30 дней — станция (2a8). Хост хранит квитанции бессрочно (§4.4).
- **В7 — недоставленные факты:** хоста не касается: квитанции бессрочны, повтор пачки после любого сбоя безопасен.
- **В8 — отказ устройства посреди смены: вариант Б.** Хост сам ничего не досылает: отозванное устройство получает 401 на пачку фактов (задача 2), как с финальной волны 2a1 и на создание, вход и блок SSCC. Решение «продолжить смену без связи» — станция (2a5).
- **В2, В3, В5, В9–В14** хоста в 2a2 не касаются (контрагенты, даты, оболочка, цех, офис).

## Global Constraints

**Решения спецификации, обязательные для 2a2**

1. Канал фактов (решение 11, §4.4): `POST /v1/device/facts` `{ records }`, 1–100 записей (иначе `validation_failed` на `records`); пачка — одна транзакция `BEGIN IMMEDIATE`; каждая запись разбирается из своего `serde_json::Value`, так что нечитаемая запись получает `rejected`/`invalid_record`, а не роняет пачку; квитанция на каждую запись в их порядке (`accepted`, `conflict`, `rejected`); идемпотентность по паре «устройство + `id` записи» с отпечатком SHA-256 канонического (компактного, ключи по порядку байтов) JSON записи: тот же отпечаток — сохранённая квитанция, другой — `rejected`/`payload_mismatch`. Ошибка базы — транспортная ошибка (`internal`, 500), ничего не зафиксировано. Квитанции хранятся бессрочно.
2. Виды фактов 2a (решение 12): `scan`, `box_closed`, `box_label`, `box_exception`, `shift_closed`. Новый вид — новый вариант `FactKind`; незнакомый вид — `invalid_record`.
3. Хост и правила маркировки (решение 13): хост не разбирает КМ и не считает контрольную цифру SSCC; `codeHash`, `gtin14`, `serial` и канонический код присылает устройство; хост проверяет их форму и совпадение GTIN со снимком смены. Правила, которые обязаны совпадать с доменом, держат общие фикстуры (`box-digest.json`, `device-instants.json`, `shift-close-reasons.json`), которые читают и `host/tests/fact_rules.rs`, и `test/fact-rules.test.ts`.
4. Реестр кодов (решение 14): текущий владелец кода — самый ранний принятый скан, в каком бы порядке ни пришли сканы; более ранний скан вытесняет владельца (позиция владельца получает `displaced_at`), более поздний и одновременный — `conflict` с `details.winner`; оба случая пишут строку `code_conflicts`.
5. Нераспознанный скан (решение 15): `invalid` не хранит сырого текста — только `rawKind` и `rawLength`.
6. Проверка КМ (решение 16, §4.6): `GET /v1/device/codes/{codeHash}` (64 hex) → `{ status: "free" }` или `{ status: "taken", owner: { shiftId, shiftNumber, deviceId, scannedAt, sameDevice } }`; чтение без транзакции записи; неверная форма — `validation_failed`.
7. Закрытие станцией (решение 17): правило причины `shiftCloseReasonRequired` (`invalid_record`); активная смена закрывается (`closed_by_kind = device`), уже закрытая — `accepted` с `alreadyClosed`; строка `shift_close_events` в любом случае.
8. Поздние данные (решение 18, §4.4): факт закрытой смены, кроме её собственного `shift_closed`, принимается и один раз ставит `late_data_at`.
9. Причины исключений (решение 36): коды перепечатки и расформирования, текст до 200 символов только при `other`.
10. Ошибки (§4.8): коды квитанций не являются кодами HTTP; их список — константы `proto::receipt_codes` и фикстура `fact-receipt-codes.json`. Новых кодов верхнего уровня нет.
11. Роли (§4.9): факты и проверка кода — устройство (любое: мимо `not_entered` проходит только участник смены, то есть станция в 2a); сессия офиса без ключа устройства этих маршрутов не открывает.
12. Журнал действий (§4.10): только `shift.close` от станции — `{ actualQty, plannedQty, closedBoxCount, reasonCode }`; сканы, короба и исключения — производственные данные, не строки журнала.
13. Журнал процесса (§4.11): ни кодов маркировки, ни их хвостов, ни хешей кодов, ни SSCC целиком — только идентификаторы записей и коды квитанций; `no_secrets_in_logs.rs` дополняется пачкой фактов с криптохвостом.
14. Протокол (§6): запросы — `deny_unknown_fields`, ответы терпят новые поля; у каждого нового типа есть фикстура, её разбирает `proto/tests/fixtures.rs`. `PROTOCOL_VERSION` остаётся 2 (поднят в 2a1).

**Модель данных** (миграция `0010_facts.sql`)

- `fact_receipts(device_id, record_id, kind, shift_id, digest, outcome, code, details, received_at, PRIMARY KEY(device_id, record_id))`, индекс `(shift_id, received_at)`; `shift_id` без внешнего ключа (квитанция не держит смену от удаления).
- `scans(id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at)`, индексы `(shift_id)` и частичный `(code_hash)`.
- `boxes(id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, item_count_reported, membership_digest, digest_matches, operator_id, print_verified_at, print_skipped_at, disassembled_at, received_at)`, частичный уникальный индекс `sscc`, индекс `(shift_id)`.
- `box_items(scan_id PRIMARY KEY, box_id, code_hash, added_at, removed_at, displaced_at)`, частичный уникальный индекс живых позиций `(box_id, code_hash)`.
- `code_owners(code_hash PRIMARY KEY, scan_id UNIQUE, shift_id, device_id, box_id, scanned_at)`; `code_conflicts(id, code_hash, winner_scan_id, loser_scan_id, detected_at, reviewed_at)`.
- `box_exceptions(id, record_id, kind, box_id, code_hash, target_scanned_at, reason_code, reason_text, shift_id, device_id, operator_id, occurred_at, received_at)` с проверкой полей вида, как облачная `box_exceptions_kind_payload_check`.
- `shift_close_events(id, record_id, shift_id, device_id, operator_id, planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, received_at)`.

**Журнал действий** (словарь `audit::actions` не меняется)

| Действие      | Исполнитель | `target_type` | `details`                                               |
| ------------- | ----------- | ------------- | ------------------------------------------------------- |
| `shift.close` | станция     | `shift`       | `{ actualQty, plannedQty, closedBoxCount, reasonCode }` |

**Решения планировщика** (уточнения спецификации; задача 8 записывает их в её §16)

- Конверт записи — `FactRecord { id, kind, shiftId, operatorId, data }`; `data` читается по `kind` своим типом с `deny_unknown_fields`. Квитанция — `FactReceipt { id, outcome, code?, details? }`: `invalid_record` с `details.field` (путь поля) у читаемой записи, `conflict` с `details.winner` (`CodeOwner`), `accepted` с `details.alreadyClosed: true`. Запись без читаемого `id` (канонический UUID) не хранится, её квитанция — `id: null`; `payload_mismatch` не хранится.
- Момент устройства — ровно то, что пишет `Date.toISOString` (`YYYY-MM-DDTHH:MM:SS.sssZ`, 24 символа), хранится как прислан; моменты хоста (`received_at`, `detected_at`, `displaced_at`, `late_data_at`) — в формате хоста; `shifts.closed_at` от станции — момент станции в формате хоста (целые секунды).
- Запись проверяется целиком до первой записи в базу: отказ оставляет только квитанцию.
- `box_items` — строка на принятый скан (`scan_id` — ключ), а не `(box_id, code_hash)`: код, снятый исключением и отсканированный снова в тот же короб, нарушил бы ключ спецификации. Свои строки хоста (`scans`, `box_exceptions`, `shift_close_events`) получают UUID хоста и хранят `record_id`.
- Принятый скан, в том числе проигравший код (`conflict`), открывает неизвестный короб этого устройства и этой смены (`opened_at` — время скана, `box_closed` заменяет его на `openedAt` станции); короб другого устройства или другой смены — `box_unknown`.
- `removed_at` — момент исключения на станции; `undo` кода, скан которого проиграл, принимается, ничего не снимает и хранится; проверка этикетки расформированного короба принимается (он закрыт).
- Причина закрытия нужна по плану, который видела станция (`plannedQtySnapshot`, 1–10 000 000 или `null`); причина без необходимости хранится, как в облаке.
- Поздняя отметка — от принятого или `conflict` факта, не от отклонённого. Факты ревизии не берут; пачка, которая закрыла смену или отметила её поздней, берёт одну ревизию на все такие изменения (штамп в `shifts.rev`) и будит потоки.
- `totals` (`ShiftTotals`) — в каждом `OfficeShift` (§5.6 показывает принятые единицы и короба в списке), читаются подзапросами и не хранятся: `acceptedUnits`, `closedBoxes` (без расформированных), `openBoxes` (открытые с живой позицией), `lastFactAt` (последняя квитанция записи, прошедшей проверку входа, отклонённые тоже), `deviceIds` (по первому входу).
- Устройство пачки перечитывается в транзакции новым `AuthDevice::require_live_in` (отозванное — 401, вид любой); на нём же теперь стоит `require_station_in` финальной волны 2a1 (создание, вход, блок SSCC). Пункт 19 очереди мелочей 2a1 (ограничение выдачи блоков на хосте) этот план не трогает: см. «Перенесено».

**Код и процесс**

- Новых крейтов и пакетов нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются; SHA-256 — `aws_lc_rs::digest`, который хост уже использует.
- Правила записи из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, коммит с ревизией через `commit_with_revision`, пул не трогать при открытой транзакции записи.
- Не меняются: `apps/station`, `packages/*`, применённые миграции `0001`–`0009`, оболочка (`src-tauri`), исходники вебвью (`src/`); в вебвью добавляется только тест `test/fact-rules.test.ts`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; на момент применения он встречается в файле один раз (план применён к копии репозитория по шагам, задача за задачей). Внутри шага правки одного файла идут сверху вниз и применяются по порядку. Шаг тестов применяется раньше шага реализации; в `proto/src/lib.rs` шаг тестов трогает только модуль `tests`.
- «Создать» — новый файл, ровно как в блоке. «Заменить целиком» — файл, созданный предыдущей задачей, получает содержимое блока.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier: расхождение при проверке значит опечатку.
- Блок `use support::app::{…}` в `host/tests/facts.rs` и блок `use markiro_proto::{…}` в `proto/tests/fixtures.rs` меняются целиком: `cargo fmt` переливает весь список при каждом новом имени.
- Русский текст — буквами, не `\uXXXX`: в фикстурах и коде единственная такая запись — разделитель групп GS1 (`\u001d` в JSON, `\u{1d}` в Rust).

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названными тестами; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые JSON, TS и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` (`--locked` заодно доказывает, что `Cargo.lock` не меняется). Если крейта нет в локальном кэше, та же команда без `--offline` — вне песочницы.
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind` (`Operation not permitted`): из затронутых планом это `no_secrets_in_logs`; поэтому он, `cargo test -p markiro-host` целиком и `--workspace` — вне песочницы, а `--test facts`, `--test codes`, `--test fact_rules`, `--test device_shifts`, `--test office_shifts`, `--test sscc_blocks` — и в ней.
- Оболочка встраивает сборку вебвью (`tauri::generate_context!` читает `apps/standalone/dist`): для `--workspace` в свежем worktree сначала `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем worktree — `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать; команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`; если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- На копии репозитория с пустым `CARGO_TARGET_DIR` первая сборка хоста идёт несколько минут; дальше наборы пересобираются за секунды.

**Счёт тестов**

- Наборы cargo считаются по строкам `Running` вывода (doc-тесты не считаются). База плана — `0a21a3f2c`. До плана: cargo — 43 набора, 525 тестов (хост 30 и 365, `proto` 2 и 45, оболочка 11 и 115); Vitest — 67 файлов, 1744 тестов. После: cargo — 46 наборов, 556 тестов (хост 33 и 393, `proto` 2 и 48, оболочка 11 и 115); Vitest — 68 файлов, 1779 тестов. Коммиты, которые лягут на ветку после `0a21a3f2c` до исполнения плана, сдвигают счёт хоста на свои тесты; числа наборов `facts`, `codes`, `fact_rules`, `office_shifts`, `no_secrets_in_logs` и `proto` от этого не зависят, если такие коммиты их не трогают. Каждое «Expected» ниже измерено на копии репозитория с кодом самого плана; расхождение значит, что шаг применён не так (тесты, добавленные исполнителем сверх плана, он называет в отчёте).

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/host/src/facts/rules.rs, host/tests/fact_rules.rs, host/src/lib.rs        задача 1
apps/standalone/proto/fixtures/{box-digest,device-instants,shift-close-reasons}.json      задача 1
apps/standalone/proto/fixtures/{fact-receipt-codes,exception-reasons}.json                задача 1
apps/standalone/test/fact-rules.test.ts                                                   задача 1
apps/standalone/host/src/facts/mod.rs                                                     задачи 1, 2, 4–6
apps/standalone/host/migrations/0010_facts.sql, host/src/auth.rs                          задача 2
apps/standalone/host/src/facts/{boxes,registry,scan}.rs                                   задачи 2, 5, 6
apps/standalone/host/src/routes/facts.rs                                                  задачи 2, 6
apps/standalone/host/src/routes/mod.rs, host/src/server.rs                                задачи 2, 3
apps/standalone/host/tests/facts.rs, host/tests/support/app.rs                            задачи 2, 4–7
apps/standalone/proto/fixtures/{facts-request,facts-response}.json                        задачи 2, 4–6
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                                 задачи 1–7
apps/standalone/host/src/routes/codes.rs, host/tests/codes.rs                             задачи 3, 6
apps/standalone/proto/fixtures/{code-check-free,code-check-taken}.json                    задача 3
apps/standalone/host/src/facts/box_closed.rs                                              задача 4
apps/standalone/host/src/facts/{box_label,exception}.rs, host/src/validate.rs             задача 5
apps/standalone/host/src/facts/shift_closed.rs                                            задача 6
apps/standalone/host/src/routes/office_shifts.rs, host/tests/office_shifts.rs             задача 7
apps/standalone/proto/fixtures/office-shift.json                                          задача 7
apps/standalone/host/tests/no_secrets_in_logs.rs                                          задача 8
apps/standalone/AGENTS.md                                                                 задачи 1–8
docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md                 задача 8
```

Правила с общими фикстурами (задача 1) — чистые функции без базы: их фикстуры проверяются раньше всего остального. Миграция одна и стоит в задаче 2 вместе с первым писателем — приёмом пачки и сканом: модель целиком, потому что задачи 4–6 только добавляют виды. Проверка кода (задача 3) читает реестр задачи 2. Виды фактов добавляются по одному на задачу (`box_closed` — 4, `box_label` и `box_exception` — 5, `shift_closed` и поздние данные — 6): каждый — вариант `FactKind`, тип `data`, запись фикстуры, обработчик и тесты, поэтому незнакомый ещё вид честно отвечает `invalid_record`. Итоги смены (задача 7) читают всё, что записали факты. Задача 8 проводит факты через журнал процесса и записывает решения в спецификацию.

## Контракт для 2a3 и 2a6

Типы — `proto/src/lib.rs`, формы на проводе — фикстуры `proto/fixtures`; планы 2a3 и 2a6 пишут Zod по этим фикстурам и проверяют их в `test/protocol.test.ts`.

**Для 2a3 (офис):**

- `OfficeShift` (ответ `GET /v1/office/shifts`, `GET …/{id}`, `POST`, `PUT …/{id}`, `POST …/{id}/close`) получает обязательное поле `totals: ShiftTotals` = `{ acceptedUnits: number, closedBoxes: number, openBoxes: number, lastFactAt: string | null, deviceIds: string[] }` (фикстура `office-shift.json`). Итоги есть и в списке, отдельный запрос на строку не нужен. У запланированной смены — `0, 0, 0, null, []`.
- `closeReasonCode` (один из шести `SHIFT_CLOSE_REASON_CODES`) заполняется закрытием станцией, `closeReasonText` — закрытием офисом; `lateDataAt` — время первого позднего факта по часам хоста (повод показать «пришли данные после закрытия»).
- Закрытие станцией меняет `rev` смены (ревизия хоста): форма офиса, открытая до него, получит `stale_revision`.

**Для 2a6 (цех: конвейер, короба, доставка):**

- `POST /v1/device/facts` `{ records: FactRecord[] }`, 1–100 записей; `FactRecord = { id: uuid (канонический, строчный), kind, shiftId: uuid, operatorId: uuid | null, data }`; ответ `{ receipts: FactReceipt[] }` в порядке записей, `FactReceipt = { id: string | null, outcome: "accepted" | "conflict" | "rejected", code?: string, details?: object }` (фикстуры `facts-request.json`, `facts-response.json`, коды — `fact-receipt-codes.json`). Транспортные сбои (не 200) — не квитанции: пачку повторить с паузой.
- `data` по видам: `scan` — `{ scannedAt, verdict: "ok"|"duplicate"|"wrong_gtin"|"invalid", duplicateSource: "local"|"host"|null, rawKind: "km"|"gtin"|"sscc"|"unknown", rawLength, code: { codeHash, gtin14, serial, canonical } | null, boxId: uuid | null }` (у `invalid` кода нет и `rawKind` не `km`; у остальных код есть и `rawKind` = `km`; `duplicateSource` — только у `duplicate`; `boxId` — только у `ok`); `box_closed` — `{ boxId, sscc, blockId, serial, openedAt, closedAt, itemCount ≥ 1, membershipDigest }`; `box_label` — `{ boxId, outcome: "verified"|"skipped", at }`; `box_exception` — `{ exception: "undo"|"clear"|"reprint"|"disassemble", boxId, codeHash, targetScannedAt, reasonCode, reasonText, occurredAt }` (поля по виду, причины — `exception-reasons.json`); `shift_closed` — `{ plannedQtySnapshot, actualQty, closedBoxCount, reasonCode, closedAt }`.
- Все моменты устройства — `new Date().toISOString()`; другое написание — `invalid_record` (`device-instants.json`).
- `conflict` у скана: `details.winner` = `CodeOwner` (`{ shiftId, shiftNumber, deviceId, scannedAt, sameDevice }`); станция ставит `floor_scans.conflict` и `needs_fix` короба. `invalid_record` у читаемой записи несёт `details.field`.
- `GET /v1/device/codes/{codeHash}` → `CodeCheck` (`code-check-free.json`, `code-check-taken.json`).
- Повтор `requestId` блока с тем же телом отдаёт тот же блок, а с другим префиксом — `validation_failed` на `requestId` (финальная волна 2a1): станция, у которой сменился префикс снимка, выбрасывает свой `floor_block_requests` и просит с новым `requestId`. Ограничения выдачи блоков на хосте нет (пункт 19 очереди мелочей 2a1): правило «половина» держит станция.

---

### Task 1: Правила фактов с общими фикстурами — дайджест короба, момент устройства, причина закрытия, отпечаток записи; коды квитанций и причин

То, что хост и вебвью обязаны отвечать одинаково, — чистые функции `host/src/facts/rules.rs`, и каждую держит фикстура, которую читают обе стороны: `box-digest.json` (облачный `boxMembershipDigestV1`, переписанный в Rust: станция пришлёт дайджест короба, хост сверит со своими позициями), `device-instants.json` (момент устройства — ровно то, что пишет `Date.toISOString`, поэтому сравнение хранимого текста упорядочивает моменты, а «самый ранний скан» находится сравнением строк), `shift-close-reasons.json` (шесть кодов и `shiftCloseReasonRequired`). Отпечаток записи — свой, хоста: SHA-256 компактного JSON, ключи которого serde_json без `preserve_order` пишет по порядку байтов. Коды квитанций и причин исключений — константы `proto` с фикстурами; Vitest проверяет домен по общим фикстурам и проходит сразу (домен уже следует правилам), а Rust-тесты падают, пока нет модуля.

**Files:**

- Create: `apps/standalone/host/src/facts/mod.rs`, `apps/standalone/host/src/facts/rules.rs`, `apps/standalone/proto/fixtures/{box-digest,device-instants,shift-close-reasons,fact-receipt-codes,exception-reasons}.json`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/proto/src/lib.rs` (модули `receipt_codes`, `exception_reasons`, `shift_close_reasons`)
- Test: `apps/standalone/host/tests/fact_rules.rs` (Create), `apps/standalone/test/fact-rules.test.ts` (Create), `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` (новый раздел «Facts»)

**Interfaces:**

- Consumes: `boxMembershipDigestV1`, `SHIFT_CLOSE_REASON_CODES`, `shiftCloseReasonRequired` — `@markiro/domain`; `aws_lc_rs::digest`.
- Produces:
  - `pub fn markiro_host::facts::rules::record_digest(record: &serde_json::Value) -> String` (64 hex);
  - `pub fn markiro_host::facts::rules::box_membership_digest(code_hashes: &[String]) -> String`;
  - `pub fn markiro_host::facts::rules::device_instant(text: &str) -> Option<time::OffsetDateTime>`;
  - `pub fn markiro_host::facts::rules::is_code_hash(text: &str) -> bool`;
  - `pub fn markiro_host::facts::rules::close_reason_required(planned_qty: Option<u32>, actual_qty: u32) -> bool`;
  - `markiro_proto::receipt_codes::{INVALID_RECORD, PAYLOAD_MISMATCH, UNKNOWN_SHIFT, NOT_ENTERED, GTIN_MISMATCH, BOX_UNKNOWN, BOX_CLOSED, BOX_ALREADY_CLOSED, BOX_STATE, SSCC_NOT_ISSUED, SSCC_TAKEN, ALL}`;
  - `markiro_proto::exception_reasons::{OTHER, MAX_TEXT_CHARS, REPRINT, DISASSEMBLE}`, `markiro_proto::shift_close_reasons::ALL`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. Создать `apps/standalone/host/tests/fact_rules.rs`:

<!-- prettier-ignore -->
```rust
use markiro_host::facts::rules::{
    box_membership_digest, close_reason_required, device_instant, is_code_hash, record_digest,
};
use serde_json::{json, Value};

/// A fixture of `proto/fixtures`, which the webview's
/// `test/fact-rules.test.ts` reads too.
fn fixture(name: &str) -> Value {
    let path = format!("{}/../proto/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn every_box_digest_of_the_fixture_matches() {
    let fixture = fixture("box-digest.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let hashes: Vec<String> = serde_json::from_value(case["hashes"].clone()).unwrap();
        assert_eq!(
            box_membership_digest(&hashes),
            case["digest"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn a_device_instant_is_exactly_what_to_iso_string_writes() {
    let fixture = fixture("device-instants.json");
    let valid = fixture["valid"].as_array().expect("valid");
    let invalid = fixture["invalid"].as_array().expect("invalid");
    assert_eq!((valid.len(), invalid.len()), (5, 17));
    for text in valid {
        let text = text.as_str().unwrap();
        assert!(device_instant(text).is_some(), "{text:?}");
    }
    for text in invalid {
        let text = text.as_str().unwrap();
        assert_eq!(device_instant(text), None, "{text:?}");
    }
    // The instant itself, milliseconds included.
    let at = device_instant("2026-10-08T06:02:00.123Z").unwrap();
    assert_eq!(
        (at.unix_timestamp(), at.millisecond()),
        (1_791_439_320, 123)
    );
}

#[test]
fn every_close_reason_case_of_the_fixture_matches() {
    let fixture = fixture("shift-close-reasons.json");
    let cases = fixture["required"].as_array().expect("required");
    assert_eq!(cases.len(), 6);
    for case in cases {
        let planned: Option<u32> = serde_json::from_value(case["plannedQty"].clone()).unwrap();
        let actual: u32 = serde_json::from_value(case["actualQty"].clone()).unwrap();
        assert_eq!(
            close_reason_required(planned, actual),
            case["required"].as_bool().unwrap(),
            "{case}"
        );
    }
}

/// The digest of a record does not depend on the order of its keys: the
/// same record sent again by another serializer keeps its receipt.
#[test]
fn a_record_digest_ignores_the_order_of_keys_and_sees_every_value() {
    let record: Value = serde_json::from_str(
        r#"{"id":"0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d","kind":"scan","data":{"b":1,"a":[2,3]}}"#,
    )
    .unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"data":{"a":[2,3],"b":1},"kind":"scan","id":"0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d"}"#,
    )
    .unwrap();
    assert_eq!(record_digest(&record), record_digest(&reordered));
    assert_eq!(record_digest(&record).len(), 64);
    let mut changed = record.clone();
    changed["data"]["a"] = json!([3, 2]);
    assert_ne!(record_digest(&record), record_digest(&changed));
    // SHA-256 of the compact text with the keys in byte order.
    assert_eq!(
        record_digest(&json!({ "b": 1, "a": "x" })),
        "cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246"
    );
}

#[test]
fn a_code_hash_is_64_lower_case_hex_digits() {
    assert!(is_code_hash(&"0a".repeat(32)));
    assert!(is_code_hash(&"9f".repeat(32)));
    for text in [
        "0A".repeat(32),
        "0a".repeat(31),
        format!("{}0", "0a".repeat(32)),
        format!("{}g", "0".repeat(63)),
        format!("{}é", "0".repeat(62)),
        String::new(),
    ] {
        assert!(!is_code_hash(&text), "{text:?}");
    }
}
```

2. Создать `apps/standalone/proto/fixtures/box-digest.json`:

<!-- prettier-ignore -->
```json
{
  "cases": [
    {
      "hashes": [],
      "digest": "5a57cbf1b6092eaed17eecefca5c9aaf5c14614ac182f87ca1fbf240aa028494"
    },
    {
      "hashes": ["a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"],
      "digest": "e54732dfe1f3e9b6cfb06d638c2b0249e5e2e6c55f6665d5b8d7eb6b387d640c"
    },
    {
      "hashes": [
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
        "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e"
      ],
      "digest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e"
    },
    {
      "hashes": [
        "9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e",
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
      ],
      "digest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e"
    },
    {
      "hashes": [
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "0000000000000000000000000000000000000000000000000000000000000000"
      ],
      "digest": "5180cc7e2f4e30c5f67431d793b47f52f3bf0900b6eb663de83f31dc543e4864"
    }
  ]
}
```

3. Создать `apps/standalone/proto/fixtures/device-instants.json`:

<!-- prettier-ignore -->
```json
{
  "valid": [
    "2026-10-08T06:02:00.123Z",
    "2028-02-29T23:59:59.999Z",
    "2026-10-08T00:00:00.000Z",
    "0001-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z"
  ],
  "invalid": [
    "2026-10-08T06:02:00Z",
    "2026-10-08T06:02:00.12Z",
    "2026-10-08T06:02:00.1234Z",
    "2026-10-08T06:02:00.123+00:00",
    "2026-10-08T09:02:00.123+03:00",
    "2026-10-08 06:02:00.123Z",
    "2026-10-08t06:02:00.123z",
    "2026-02-30T00:00:00.000Z",
    "2026-10-08T24:00:00.000Z",
    "2026-10-08T06:60:00.000Z",
    "2026-12-31T23:59:60.000Z",
    "2026-13-01T00:00:00.000Z",
    "+012026-10-08T06:02:00.123Z",
    " 2026-10-08T06:02:00.123Z",
    "2026-10-08T06:02:00.123Z ",
    "2026-10-08",
    ""
  ]
}
```

4. Создать `apps/standalone/proto/fixtures/exception-reasons.json`:

<!-- prettier-ignore -->
```json
{
  "reprint": ["damaged_label", "unreadable_label", "printer_jam", "quality_request", "other"],
  "disassemble": [
    "wrong_product",
    "wrong_quantity",
    "damaged_package",
    "quality_rejected",
    "other"
  ],
  "other": "other",
  "maxTextChars": 200
}
```

5. Создать `apps/standalone/proto/fixtures/fact-receipt-codes.json`:

<!-- prettier-ignore -->
```json
{
  "codes": [
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
    "sscc_taken"
  ]
}
```

6. Создать `apps/standalone/proto/fixtures/shift-close-reasons.json`:

<!-- prettier-ignore -->
```json
{
  "codes": [
    "production_defect",
    "material_shortage",
    "equipment_stop",
    "production_order_changed",
    "planned_quantity_error",
    "other_production_deviation"
  ],
  "required": [
    {
      "plannedQty": null,
      "actualQty": 0,
      "required": false
    },
    {
      "plannedQty": null,
      "actualQty": 250,
      "required": false
    },
    {
      "plannedQty": 250,
      "actualQty": 250,
      "required": false
    },
    {
      "plannedQty": 250,
      "actualQty": 249,
      "required": true
    },
    {
      "plannedQty": 250,
      "actualQty": 251,
      "required": true
    },
    {
      "plannedQty": 1,
      "actualQty": 0,
      "required": true
    }
  ]
}
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let exhausted: ErrorBody = round_trip("error-sscc-exhausted.json");
    assert_eq!(exhausted.error.code, codes::SSCC_EXHAUSTED);
}
```

заменить на

<!-- prettier-ignore -->
```rust
    let exhausted: ErrorBody = round_trip("error-sscc-exhausted.json");
    assert_eq!(exhausted.error.code, codes::SSCC_EXHAUSTED);
}

/// The receipt codes and the reason codes, as the webview reads them from
/// the same fixtures: a code added on one side only fails here.
#[test]
fn the_fact_code_fixtures_list_every_receipt_and_reason_code() {
    let codes = fixture("fact-receipt-codes.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(codes["codes"].clone()).unwrap(),
        markiro_proto::receipt_codes::ALL
    );
    let reasons = fixture("exception-reasons.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(reasons["reprint"].clone()).unwrap(),
        markiro_proto::exception_reasons::REPRINT
    );
    assert_eq!(
        serde_json::from_value::<Vec<String>>(reasons["disassemble"].clone()).unwrap(),
        markiro_proto::exception_reasons::DISASSEMBLE
    );
    assert_eq!(reasons["other"], markiro_proto::exception_reasons::OTHER);
    assert_eq!(
        reasons["maxTextChars"],
        markiro_proto::exception_reasons::MAX_TEXT_CHARS
    );
    let close = fixture("shift-close-reasons.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(close["codes"].clone()).unwrap(),
        markiro_proto::shift_close_reasons::ALL
    );
}
```

8. Создать `apps/standalone/test/fact-rules.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import {
  boxMembershipDigestV1,
  SHIFT_CLOSE_REASON_CODES,
  shiftCloseReasonRequired,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/**
 * The rules of facts the host (`host/src/facts/rules.rs`) and the domain
 * must answer alike, each read strictly from the fixture both sides read.
 */
const BOX_DIGEST = z
  .strictObject({
    cases: z.array(z.strictObject({ hashes: z.array(z.string()), digest: z.string() })),
  })
  .parse(fixture("box-digest.json"));

const CLOSE_REASONS = z
  .strictObject({
    codes: z.array(z.string()),
    required: z.array(
      z.strictObject({
        plannedQty: z.number().int().nullable(),
        actualQty: z.number().int(),
        required: z.boolean(),
      }),
    ),
  })
  .parse(fixture("shift-close-reasons.json"));

const INSTANTS = z
  .strictObject({ valid: z.array(z.string()), invalid: z.array(z.string()) })
  .parse(fixture("device-instants.json"));

describe("fact rules: the fixtures the host's facts answer too", () => {
  it("holds 5 box digests, 6 close cases and 22 instants", () => {
    expect([
      BOX_DIGEST.cases.length,
      CLOSE_REASONS.required.length,
      INSTANTS.valid.length + INSTANTS.invalid.length,
    ]).toEqual([5, 6, 22]);
  });

  it.each(BOX_DIGEST.cases)("digests the members $hashes as the domain does", (entry) => {
    expect(boxMembershipDigestV1(entry.hashes)).toBe(entry.digest);
  });

  it("lists the domain's six close reasons in its order", () => {
    expect(CLOSE_REASONS.codes).toEqual([...SHIFT_CLOSE_REASON_CODES]);
  });

  it.each(CLOSE_REASONS.required)(
    "needs a reason for plan $plannedQty and fact $actualQty: $required",
    (entry) => {
      expect(shiftCloseReasonRequired(entry.plannedQty, entry.actualQty)).toBe(entry.required);
    },
  );

  // A station writes its instants with `Date.toISOString`: a valid one is
  // what that writes back, of 24 characters (the years 0000–9999; the host
  // takes no six-digit year), an invalid one is not.
  it.each(INSTANTS.valid)("writes %j back unchanged", (text) => {
    expect(new Date(text).toISOString()).toBe(text);
  });

  it.each(INSTANTS.invalid)("never writes %j", (text) => {
    const at = new Date(text);
    expect(Number.isNaN(at.getTime()) || at.toISOString() !== text || text.length !== 24).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Запустить тесты — Rust падает, Vitest проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL — компиляция: error[E0433]: failed to resolve: could not find `facts` in `markiro_host`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — компиляция `tests/fixtures.rs`: could not find `receipt_codes` in `markiro_proto` (и `exception_reasons`, `shift_close_reasons`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/fact-rules.test.ts`
Expected: PASS — 35 тестов (домен уже отвечает по фикстурам).

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/facts/mod.rs`:

<!-- prettier-ignore -->
```rust
//! Facts a device sends (stage 2a spec §4.4): scans, closed boxes, label
//! checks, box exceptions and a shift's close, in batches of
//! `POST /v1/device/facts`. The host reads each record on its own and
//! answers a receipt for each; the same record sent again gets the same
//! receipt. Marking rules stay in `@markiro/domain`: the device sends the
//! code's hash, GTIN, serial and canonical text, and the host checks their
//! shape and the shift's GTIN, never the code itself.

pub mod rules;
```

2. Создать `apps/standalone/host/src/facts/rules.rs`:

<!-- prettier-ignore -->
```rust
//! The rules of facts that the host and the webview must answer alike, each
//! pinned by a fixture both read: the digest of a box's members
//! (`box-digest.json`, the domain's `boxMembershipDigestV1`), the form of a
//! device's instant (`device-instants.json`, what `Date.toISOString` writes)
//! and when a station's close needs a reason (`shift-close-reasons.json`,
//! the domain's `shiftCloseReasonRequired`). The digest of a record is the
//! host's own: it keys idempotency.

use aws_lc_rs::digest::{digest, SHA256};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The digest of a record as received: SHA-256 of its compact JSON, whose
/// object keys serde_json writes in byte order (the crate is built without
/// `preserve_order`), so the same record with its keys in another order has
/// the same digest. A record sent again with the same id and digest gets its
/// stored receipt; with another digest, `payload_mismatch`.
pub fn record_digest(record: &Value) -> String {
    sha256_hex(record.to_string().as_bytes())
}

/// The domain's `boxMembershipDigestV1`: SHA-256 of
/// `markiro:box-members:v1\n` followed by the box's code hashes in byte
/// order, joined by line feeds. The host's hashes are checked and distinct
/// before they are stored, so it needs no check of its own here.
pub fn box_membership_digest(code_hashes: &[String]) -> String {
    let mut sorted: Vec<&str> = code_hashes.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sha256_hex(format!("markiro:box-members:v1\n{}", sorted.join("\n")).as_bytes())
}

/// A device's instant as `Date.toISOString` writes it:
/// `YYYY-MM-DDTHH:MM:SS.sssZ`, exactly 24 characters naming a real UTC
/// instant. Any other spelling of the same instant (no milliseconds, an
/// offset, a lower-case `t`) is refused, so the stored text orders the
/// instants and the earliest scan is found by comparing it.
pub fn device_instant(text: &str) -> Option<OffsetDateTime> {
    let at = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    let written = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    );
    // The text written back names its offset `Z`: another offset never
    // matches it.
    (written == text).then_some(at)
}

/// A code's hash as the domain's `kmHash` writes it: 64 lower-case hex
/// digits.
pub fn is_code_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The domain's `shiftCloseReasonRequired`: a station's close needs one of
/// the six reason codes when the shift had a plan and the fact differs.
pub fn close_reason_required(planned_qty: Option<u32>, actual_qty: u32) -> bool {
    planned_qty.is_some_and(|planned| planned != actual_qty)
}
```

3. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod config;
pub mod db;
pub mod error;
pub mod feed;
pub mod logging;
pub mod network;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod config;
pub mod db;
pub mod error;
pub mod facts;
pub mod feed;
pub mod logging;
pub mod network;
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const DEVICE: &str = "device";
    pub const SESSION: &str = "session";
    pub const PASSWORD: &str = "password";
}

pub mod pairing;
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const DEVICE: &str = "device";
    pub const SESSION: &str = "session";
    pub const PASSWORD: &str = "password";
}

/// Codes of a `rejected` fact receipt (stage 2a spec §4.8). They are no
/// error codes of an HTTP answer: a batch of facts is answered 200 with a
/// receipt per record, and a record the host refuses names one of these.
pub mod receipt_codes {
    /// The record could not be read, or one of its fields breaks its rule
    /// (`details.field` names it when the record itself was readable).
    pub const INVALID_RECORD: &str = "invalid_record";
    /// A record with this id was received before with other content.
    pub const PAYLOAD_MISMATCH: &str = "payload_mismatch";
    pub const UNKNOWN_SHIFT: &str = "unknown_shift";
    /// The device never entered the shift the record names.
    pub const NOT_ENTERED: &str = "not_entered";
    /// An accepted scan's GTIN is not the one the shift's snapshot froze.
    pub const GTIN_MISMATCH: &str = "gtin_mismatch";
    /// No box of this device and this shift has the id.
    pub const BOX_UNKNOWN: &str = "box_unknown";
    /// A scan names a box that is closed.
    pub const BOX_CLOSED: &str = "box_closed";
    /// A box closed with one SSCC is closed again with another.
    pub const BOX_ALREADY_CLOSED: &str = "box_already_closed";
    /// The box is not in the state the record needs (an exception or a
    /// label check of an open box, an undo in a closed one).
    pub const BOX_STATE: &str = "box_state";
    /// The SSCC is not of the shift's prefix, or its serial lies in no block
    /// issued to this device.
    pub const SSCC_NOT_ISSUED: &str = "sscc_not_issued";
    /// Another box carries the SSCC.
    pub const SSCC_TAKEN: &str = "sscc_taken";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
        INVALID_RECORD,
        PAYLOAD_MISMATCH,
        UNKNOWN_SHIFT,
        NOT_ENTERED,
        GTIN_MISMATCH,
        BOX_UNKNOWN,
        BOX_CLOSED,
        BOX_ALREADY_CLOSED,
        BOX_STATE,
        SSCC_NOT_ISSUED,
        SSCC_TAKEN,
    ];
}

/// Reason codes of a box exception (stage 2a spec, decision 36): a station
/// sends a code, never translated text; free text of at most
/// [`exception_reasons::MAX_TEXT_CHARS`] characters goes only with
/// [`exception_reasons::OTHER`].
pub mod exception_reasons {
    pub const OTHER: &str = "other";
    pub const MAX_TEXT_CHARS: usize = 200;
    /// Why a box's label is printed again.
    pub const REPRINT: &[&str] = &[
        "damaged_label",
        "unreadable_label",
        "printer_jam",
        "quality_request",
        OTHER,
    ];
    /// Why a closed box is taken apart.
    pub const DISASSEMBLE: &[&str] = &[
        "wrong_product",
        "wrong_quantity",
        "damaged_package",
        "quality_rejected",
        OTHER,
    ];
}

/// The domain's six `SHIFT_CLOSE_REASON_CODES`: the reason a station gives
/// when it closes a shift whose fact differs from its plan.
pub mod shift_close_reasons {
    pub const ALL: &[&str] = &[
        "production_defect",
        "material_shortage",
        "equipment_stop",
        "production_order_changed",
        "planned_quantity_error",
        "other_production_deviation",
    ];
}

pub mod pairing;
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: PASS — 5 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 41 тест.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b.

## Facts

Stage 2a, plan 2a2 (`host/src/facts`). A station sends what happened on the
line as facts, and the host keeps them. The rules the host and the webview
must answer alike live in `host/src/facts/rules.rs`, each pinned by a
fixture both read (`host/tests/fact_rules.rs`, `test/fact-rules.test.ts`):
the digest of a box's members (`box-digest.json`, the domain's
`boxMembershipDigestV1`), a device's instant (`device-instants.json`: exactly
what `Date.toISOString` writes, `YYYY-MM-DDTHH:MM:SS.sssZ`, 24 characters, so
comparing the stored text orders the instants) and when a station's close
needs a reason (`shift-close-reasons.json`, the domain's six
`SHIFT_CLOSE_REASON_CODES` and `shiftCloseReasonRequired`). The codes of a
rejected receipt (`proto::receipt_codes`, `fact-receipt-codes.json`) and the
reason codes of box exceptions (`proto::exception_reasons`,
`exception-reasons.json`) are fixtures too; the webview reads them with the
facts sender (plan 2a6) and the exception screens (plan 2a8).

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — дайджест короба без сортировки. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let mut sorted: Vec<&str> = code_hashes.iter().map(String::as_str).collect();
    sorted.sort_unstable();
```

заменить на

<!-- prettier-ignore -->
```rust
    let mut sorted: Vec<&str> = code_hashes.iter().map(String::as_str).collect();
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `every_box_digest_of_the_fixture_matches`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — момент устройства в любой записи. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
    (written == text).then_some(at)
```

заменить на

<!-- prettier-ignore -->
```rust
    Some(at)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `a_device_instant_is_exactly_what_to_iso_string_writes`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — хеш кода с заглавными буквами. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
```

заменить на

<!-- prettier-ignore -->
```rust
            .all(|byte| byte.is_ascii_hexdigit())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `a_code_hash_is_64_lower_case_hex_digits`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — причина нужна только при недовыпуске. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
    planned_qty.is_some_and(|planned| planned != actual_qty)
```

заменить на

<!-- prettier-ignore -->
```rust
    planned_qty.is_some_and(|planned| planned > actual_qty)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `every_close_reason_case_of_the_fixture_matches`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — отпечаток записи не по компактному JSON. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
    sha256_hex(record.to_string().as_bytes())
```

заменить на

<!-- prettier-ignore -->
```rust
    sha256_hex(serde_json::to_string_pretty(record).unwrap_or_default().as_bytes())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `a_record_digest_ignores_the_order_of_keys_and_sees_every_value`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/test/fact-rules.test.ts apps/standalone/proto/fixtures/box-digest.json apps/standalone/proto/fixtures/device-instants.json apps/standalone/proto/fixtures/shift-close-reasons.json apps/standalone/proto/fixtures/fact-receipt-codes.json apps/standalone/proto/fixtures/exception-reasons.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/rules.rs apps/standalone/host/src/lib.rs apps/standalone/host/tests/fact_rules.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/box-digest.json apps/standalone/proto/fixtures/device-instants.json apps/standalone/proto/fixtures/shift-close-reasons.json apps/standalone/proto/fixtures/fact-receipt-codes.json apps/standalone/proto/fixtures/exception-reasons.json apps/standalone/test/fact-rules.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): the rules of facts the host and the domain answer alike" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Приём фактов — миграция `0010`, `POST /v1/device/facts`, квитанции и идемпотентность, сканы и реестр кодов

Сердце плана. Пачка — одна транзакция `BEGIN IMMEDIATE`, в которой устройство перечитывается новым `AuthDevice::require_live_in` (отозванное — 401; вид любой, поэтому `require_station_in` финальной волны 2a1 теперь строится на нём), а каждая запись идёт через `facts::receive`: читаемый `id` (канонический UUID) — поиск сохранённой квитанции по паре «устройство + `id`» с отпечатком; иначе разбор конверта `FactRecord`, общие проверки (`id`, `shiftId`, `operatorId`, смена существует — `unknown_shift`, устройство в неё входило — `not_entered`) и обработчик вида. Обработчик проверяет запись целиком до первой записи в базу, поэтому отказ оставляет только квитанцию; ошибка базы — 500, и пачка не оставляет ничего. Эта задача вводит вид `scan`: журнал всех сканов, `ok` открывает свой короб (`boxes.rs`) и отдаёт код реестру (`registry.rs`): самый ранний скан владеет кодом, более ранний вытесняет владельца, более поздний и одновременный — `conflict` с победителем. Миграция — вся модель фактов: задачи 5–7 только добавляют виды. Тест гонки детерминирован: тест держит блокировку записи и пишет в ней ту же запись, обработчик ждёт; под отложенной транзакцией он прочёл бы старые квитанции и упал на записи.

**Files:**

- Create: `apps/standalone/host/migrations/0010_facts.sql`, `apps/standalone/host/src/facts/{boxes,registry,scan}.rs`, `apps/standalone/host/src/routes/facts.rs`, `apps/standalone/proto/fixtures/{facts-request,facts-response}.json`
- Modify: `apps/standalone/host/src/facts/mod.rs` (целиком), `apps/standalone/host/src/auth.rs` (`require_live_in`), `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs`
- Test: `apps/standalone/host/tests/facts.rs` (Create), `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`, модуль `tests` в `apps/standalone/proto/src/lib.rs`
- Modify: `apps/standalone/AGENTS.md` («Writes», «Facts»)

**Interfaces:**

- Consumes: `AuthDevice::require_station_in` (финальная волна 2a1); `rules::{record_digest, device_instant, is_code_hash}`, `receipt_codes` (задача 1); `validate::client_uuid`, `shifts::format_number`, `db::begin_write`.
- Produces:
  - `proto`: `FactKind { Scan }` (`as_str`, `FromStr`), `FactRecord { id, kind, shift_id, operator_id, data: Value }`, `FactBatch { records }`, `ScanVerdict`, `DuplicateSource`, `ScanRawKind` (все с `as_str`), `ScannedCode { code_hash, gtin14, serial, canonical }`, `ScanFact { scanned_at, verdict, duplicate_source, raw_kind, raw_length, code, box_id }`, `FactOutcome { Accepted, Conflict, Rejected }` (`as_str`, `FromStr`), `FactReceipt { id: Option<String>, outcome, code: Option<String>, details: Option<Map> }`, `FactReceipts { receipts }`, `CodeOwner { shift_id, shift_number, device_id, scanned_at, same_device }`;
  - `pub async fn markiro_host::auth::AuthDevice::require_live_in(&self, conn: &mut SqliteConnection) -> Result<DeviceKind, ApiError>` — 401 (`credential: device`) отозванному или неизвестному, иначе вид из таблицы; `require_station_in(conn, forbidden)` сохраняет подпись и поведение;
  - `pub async fn markiro_host::facts::receive(conn: &mut SqliteConnection, device_id: &str, value: &Value, received_at: &str) -> Result<FactReceipt, ApiError>` (задача 6 добавит параметр `revision`);
  - `markiro_host::facts::{Reject { code, details }, Reject::new, Reject::field, Failure { Reject, Internal }, Applied { outcome, details }, Applied::accepted, FactShift { id, number, status, gtin14, issuer_prefix }, Context { device_id, record_id, operator_id, shift, received_at }}`;
  - `markiro_host::facts::boxes::{OwnBox { closed_at, sscc, disassembled_at }, find(conn, &Context, id) -> Result<Option<OwnBox>, Failure>}` — `box_unknown` для чужого короба;
  - `markiro_host::facts::registry::{Owner, Owner::to_wire(&self, device_id) -> CodeOwner, owner(conn, code_hash) -> Result<Option<Owner>, ApiError>, Claim, claim(conn, &Context, &Claim) -> Result<Applied, ApiError>}`;
  - `markiro_host::routes::facts::{receive_facts, IncomingFacts, MAX_RECORDS = 100}`;
  - помощники тестов `support::app`: `Floor { shift, number, station, key }`, `open_floor`, `send_facts`, `receipts`, `record_id`, `box_id`, `instant`, `code_hash`, `code`, `fact`, `ok_scan`, `accepted`, `rejected`, `fact_rows`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. Создать `apps/standalone/host/tests/facts.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::db::begin_write;
use markiro_host::error::ApiJson;
use markiro_host::routes::facts::{receive_facts, IncomingFacts};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code, code_hash, fact, fact_rows, host_revision, instant,
    ok_scan, open_floor, pair_device, plan_shift, receipts, record_id, rejected, request,
    send_facts, shift_body, shift_setup, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
        "scannedAt": at, "verdict": verdict, "duplicateSource": source, "rawKind": raw_kind,
        "rawLength": 14, "code": code, "boxId": null
    })
}

/// The journal as the host keeps it, oldest scan first.
async fn scan_rows(admin: &Admin) -> Vec<Value> {
    type ScanRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<ScanRow> = sqlx::query_as(
        "SELECT record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, raw_length, \
         code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at \
         FROM scans ORDER BY scanned_at, record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| {
            json!([
                row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                row.11, row.12, row.13, row.14
            ])
        })
        .collect()
}

/// The registry: `(code hash, owner's record, shift, device, box, scanned at)`.
async fn owners(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT o.code_hash, s.record_id, o.shift_id, o.device_id, o.box_id, o.scanned_at \
         FROM code_owners o JOIN scans s ON s.id = o.scan_id ORDER BY o.code_hash",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5]))
        .collect()
}

/// A box's items: `(record of the scan, code hash, added, removed, displaced)`.
async fn items(admin: &Admin, box_id: &str) -> Vec<Value> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT s.record_id, i.code_hash, i.added_at, i.removed_at, i.displaced_at \
         FROM box_items i JOIN scans s ON s.id = i.scan_id WHERE i.box_id = ? \
         ORDER BY i.added_at, s.record_id",
    )
    .bind(box_id)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4]))
        .collect()
}

/// The conflicts: `(code hash, winner's record, loser's record, detected)`.
async fn conflicts(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT c.code_hash, w.record_id, l.record_id, c.detected_at FROM code_conflicts c \
         JOIN scans w ON w.id = c.winner_scan_id JOIN scans l ON l.id = c.loser_scan_id \
         ORDER BY w.record_id, l.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3]))
        .collect()
}

/// The kept receipts: `(device, record, kind, shift, outcome, code, details)`.
async fn kept_receipts(admin: &Admin) -> Vec<Value> {
    type ReceiptRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<ReceiptRow> = sqlx::query_as(
        "SELECT device_id, record_id, kind, shift_id, outcome, code, details FROM fact_receipts \
         ORDER BY record_id, device_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| {
            json!([
                row.0,
                row.1,
                row.2,
                row.3,
                row.4,
                row.5,
                row.6
                    .map(|details| serde_json::from_str::<Value>(&details).unwrap())
            ])
        })
        .collect()
}

/// An administrator's host with the station on the first line inside an
/// open shift.
async fn floor() -> (Admin, Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    (admin, floor)
}

#[tokio::test]
async fn a_batch_is_answered_record_by_record_and_kept_once() {
    let (admin, floor) = floor().await;
    let mut wrong = code(3);
    wrong["gtin14"] = json!("04600682000099");
    let mut first = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    first["operatorId"] = json!("c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d");
    let batch = vec![
        first,
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            ok_scan(2, &box_id(1), &instant(2, 0)),
        ),
        fact(
            &record_id(3),
            "scan",
            &floor.shift,
            other_scan("duplicate", "km", code(1), json!("local"), &instant(3, 0)),
        ),
        fact(
            &record_id(4),
            "scan",
            &floor.shift,
            other_scan("wrong_gtin", "km", wrong, Value::Null, &instant(4, 0)),
        ),
        fact(
            &record_id(5),
            "scan",
            &floor.shift,
            other_scan("invalid", "gtin", Value::Null, Value::Null, &instant(5, 0)),
        ),
    ];
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    let expected: Vec<Value> = (1..=5).map(|n| accepted(&record_id(n))).collect();
    assert_eq!(answered, expected);
    let at = admin.app.state.timestamp();
    let (s, d) = (&floor.shift, &floor.station);
    assert_eq!(
        scan_rows(&admin).await,
        vec![
            json!([
                record_id(1),
                d,
                s,
                "ok",
                null,
                "km",
                38,
                code_hash(1),
                "04600682000013",
                "S000001",
                "010460068200001321S000001\u{1d}93Tail1",
                box_id(1),
                "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
                instant(1, 0),
                at
            ]),
            json!([
                record_id(2),
                d,
                s,
                "ok",
                null,
                "km",
                38,
                code_hash(2),
                "04600682000013",
                "S000002",
                "010460068200001321S000002\u{1d}93Tail2",
                box_id(1),
                null,
                instant(2, 0),
                at
            ]),
            json!([
                record_id(3),
                d,
                s,
                "duplicate",
                "local",
                "km",
                14,
                code_hash(1),
                "04600682000013",
                "S000001",
                "010460068200001321S000001\u{1d}93Tail1",
                null,
                null,
                instant(3, 0),
                at
            ]),
            json!([
                record_id(4),
                d,
                s,
                "wrong_gtin",
                null,
                "km",
                14,
                code_hash(3),
                "04600682000099",
                "S000003",
                "010460068200001321S000003\u{1d}93Tail3",
                null,
                null,
                instant(4, 0),
                at
            ]),
            json!([
                record_id(5),
                d,
                s,
                "invalid",
                null,
                "gtin",
                14,
                null,
                null,
                null,
                null,
                null,
                null,
                instant(5, 0),
                at
            ]),
        ]
    );
    // The first accepted scan opened the box; both own their codes.
    let opened: (String, String, String, Option<String>) =
        sqlx::query_as("SELECT shift_id, device_id, opened_at, closed_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(opened, (s.clone(), d.clone(), instant(1, 0), None));
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([code_hash(1), record_id(1), s, d, box_id(1), instant(1, 0)]),
            json!([code_hash(2), record_id(2), s, d, box_id(1), instant(2, 0)]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(1), code_hash(1), instant(1, 0), null, null]),
            json!([record_id(2), code_hash(2), instant(2, 0), null, null]),
        ]
    );
    // Facts are production data: no revision, no stream wake, no audit row.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    assert_eq!(audit_rows(&admin.app).await, rows);
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        kept,
        json!({
            "fact_receipts": 5, "scans": 5, "boxes": 1, "box_items": 2, "code_owners": 2,
            "code_conflicts": 0, "box_exceptions": 0, "shift_close_events": 0
        })
    );

    // The same batch again, later: the same receipts, nothing new.
    admin.app.clock.advance(time::Duration::minutes(3));
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    assert_eq!(fact_rows(&admin.app).await, kept);
    // One record of it with its keys in another order is the same record.
    let text = format!(
        r#"{{"records":[{{"data":{},"shiftId":"{}","operatorId":null,"kind":"scan","id":"{}"}}]}}"#,
        batch[1]["data"],
        floor.shift,
        record_id(2)
    );
    let (status, body) = admin
        .app
        .send(
            with_device(request("POST", "/v1/device/facts"), &floor.key)
                .header("content-type", "application/json")
                .body(Body::from(text))
                .unwrap(),
        )
        .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "receipts": [accepted(&record_id(2))] })
        )
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}

#[tokio::test]
async fn a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let mut wrong = code(9);
    wrong["gtin14"] = json!("04600682000099");
    let mut refused_scan = ok_scan(9, &box_id(1), &instant(9, 0));
    refused_scan["code"] = wrong;
    let original = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    let refused = fact(&record_id(2), "scan", &floor.shift, refused_scan);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original.clone(), refused.clone()]).await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(2)), "gtin_mismatch", None)
        ]
    );
    let kept = fact_rows(&admin.app).await;
    let mut changed = original.clone();
    changed["data"]["scannedAt"] = json!(instant(1, 1));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[changed]).await,
        vec![rejected(Some(&record_id(1)), "payload_mismatch", None)]
    );
    // Nothing changed, the first receipt neither: the original again is
    // still accepted, and the refused record still refused, not applied.
    assert_eq!(fact_rows(&admin.app).await, kept);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original, refused]).await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(2)), "gtin_mismatch", None)
        ]
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
    // The same id from another device is another record.
    let theirs = fact(
        &record_id(1),
        "scan",
        &colleague.shift,
        ok_scan(5, &box_id(2), &instant(5, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &colleague.key, &[theirs]).await,
        vec![accepted(&record_id(1))]
    );
    let mut expected = vec![
        json!([
            colleague.station,
            record_id(1),
            "scan",
            colleague.shift,
            "accepted",
            null,
            null
        ]),
        json!([
            floor.station,
            record_id(1),
            "scan",
            floor.shift,
            "accepted",
            null,
            null
        ]),
        json!([
            floor.station,
            record_id(2),
            "scan",
            floor.shift,
            "rejected",
            "gtin_mismatch",
            null
        ]),
    ];
    expected.sort_by_key(|row| (row[1].to_string(), row[0].to_string()));
    assert_eq!(kept_receipts(&admin).await, expected);
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(1),
                record_id(1),
                floor.shift,
                floor.station,
                box_id(1),
                instant(1, 0)
            ]),
            json!([
                code_hash(5),
                record_id(1),
                colleague.shift,
                colleague.station,
                box_id(2),
                instant(5, 0)
            ]),
        ]
    );
}

#[tokio::test]
async fn a_record_the_host_cannot_read_is_refused_and_the_others_are_applied() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let good = |n: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(1), &instant(n, 0)),
        )
    };
    let mut no_length = good(4);
    no_length["data"]
        .as_object_mut()
        .unwrap()
        .remove("rawLength");
    let mut extra = good(5);
    extra["data"]["note"] = json!("a field no scan has");
    let mut teleport = good(6);
    teleport["kind"] = json!("teleport");
    let mut upper_id = good(7);
    upper_id["id"] = json!(record_id(7).replace("4000", "4ABC"));
    let mut no_shift = good(8);
    no_shift.as_object_mut().unwrap().remove("shiftId");
    let batch = vec![
        good(1),
        json!(42),
        json!("a scan"),
        json!({}),
        no_length,
        extra,
        teleport,
        upper_id,
        no_shift,
        good(2),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(1)),
            rejected(None, "invalid_record", None),
            rejected(None, "invalid_record", None),
            rejected(None, "invalid_record", None),
            rejected(Some(&record_id(4)), "invalid_record", Some("data")),
            rejected(Some(&record_id(5)), "invalid_record", Some("data")),
            rejected(Some(&record_id(6)), "invalid_record", None),
            rejected(None, "invalid_record", Some("id")),
            rejected(Some(&record_id(8)), "invalid_record", None),
            accepted(&record_id(2)),
        ]
    );
    // A record with a readable id keeps its receipt (its kind once readable,
    // its shift once the entry was found); one without keeps nothing.
    let s = &floor.shift;
    let d = &floor.station;
    assert_eq!(
        kept_receipts(&admin).await,
        vec![
            json!([d, record_id(1), "scan", s, "accepted", null, null]),
            json!([d, record_id(2), "scan", s, "accepted", null, null]),
            json!([d, record_id(4), "scan", s, "rejected", "invalid_record", { "field": "data" }]),
            json!([d, record_id(5), "scan", s, "rejected", "invalid_record", { "field": "data" }]),
            json!([
                d,
                record_id(6),
                null,
                null,
                "rejected",
                "invalid_record",
                null
            ]),
            json!([
                d,
                record_id(8),
                null,
                null,
                "rejected",
                "invalid_record",
                null
            ]),
        ]
    );
    assert_eq!(scan_rows(&admin).await.len(), 2);
    // Sent again, every record gets its answer again, the kept ones from
    // their receipts with their details.
    let again = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        again[4],
        rejected(Some(&record_id(4)), "invalid_record", Some("data"))
    );
    assert_eq!(again[7], rejected(None, "invalid_record", Some("id")));
    assert_eq!(scan_rows(&admin).await.len(), 2);
    assert_eq!(kept_receipts(&admin).await.len(), 6);
}

#[tokio::test]
async fn every_field_of_a_scan_is_checked_before_anything_is_written() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.clone();
    let with = |n: u32, path: &[&str], value: Value| {
        let mut data = ok_scan(n, &box_id(1), &instant(n, 0));
        match path {
            [key] => data[*key] = value,
            [outer, key] => data[*outer][*key] = value,
            _ => unreachable!(),
        }
        data
    };
    let invalid = |n: u32, raw_kind: &str| {
        other_scan(
            "invalid",
            raw_kind,
            Value::Null,
            Value::Null,
            &instant(n, 0),
        )
    };
    let duplicate = |n: u32| other_scan("duplicate", "km", code(n), json!("host"), &instant(n, 0));
    let with_code = {
        let mut data = invalid(9, "unknown");
        data["code"] = code(9);
        data
    };
    let no_code = {
        let mut data = duplicate(10);
        data["code"] = Value::Null;
        data
    };
    let no_source = {
        let mut data = duplicate(11);
        data["duplicateSource"] = Value::Null;
        data
    };
    let boxed = {
        let mut data = duplicate(12);
        data["boxId"] = json!(box_id(1));
        data
    };
    let multibyte = format!("{}é", "0".repeat(1022));
    assert_eq!(multibyte.len(), 1024);
    // Each case breaks one rule (the field it names) or none.
    let cases: Vec<(Value, Option<&str>)> = vec![
        (
            with(1, &["scannedAt"], json!("2026-10-08T06:00:01Z")),
            Some("data.scannedAt"),
        ),
        (with(2, &["rawKind"], json!("gtin")), Some("data.rawKind")),
        (
            with(3, &["duplicateSource"], json!("local")),
            Some("data.duplicateSource"),
        ),
        (with(4, &["boxId"], Value::Null), Some("data.boxId")),
        (with(5, &["boxId"], json!("box-1")), Some("data.boxId")),
        (
            with(
                6,
                &["code", "codeHash"],
                json!(code_hash(6).replace('0', "A")),
            ),
            Some("data.code.codeHash"),
        ),
        (
            with(7, &["code", "gtin14"], json!("4600682000013")),
            Some("data.code.gtin14"),
        ),
        (
            with(8, &["code", "serial"], json!("")),
            Some("data.code.serial"),
        ),
        (with_code, Some("data.code")),
        (no_code, Some("data.code")),
        (no_source, Some("data.duplicateSource")),
        (boxed, Some("data.boxId")),
        (
            with(13, &["code", "serial"], json!("S".repeat(65))),
            Some("data.code.serial"),
        ),
        (
            with(14, &["code", "serial"], json!("S\n1")),
            Some("data.code.serial"),
        ),
        (
            with(
                15,
                &["code", "canonical"],
                json!("0104600682000013\u{0}21S"),
            ),
            Some("data.code.canonical"),
        ),
        (
            with(16, &["code", "canonical"], json!("0".repeat(1025))),
            Some("data.code.canonical"),
        ),
        (
            with(17, &["code", "canonical"], json!("")),
            Some("data.code.canonical"),
        ),
        (invalid(18, "km"), Some("data.rawKind")),
        (
            with(
                25,
                &["code", "canonical"],
                json!(format!("{}é", "0".repeat(1023))),
            ),
            Some("data.code.canonical"),
        ),
        (
            with(26, &["code", "serial"], json!("Ё".repeat(33))),
            Some("data.code.serial"),
        ),
        // The longest serial and canonical text pass; so does a duplicate the
        // host found and an `invalid` scan of each kind but a code.
        (with(19, &["code", "serial"], json!("S".repeat(64))), None),
        (with(20, &["code", "canonical"], json!(multibyte)), None),
        (duplicate(21), None),
        (invalid(22, "sscc"), None),
        (invalid(23, "gtin"), None),
        (invalid(24, "unknown"), None),
    ];
    let mut records = Vec::new();
    let mut expected = Vec::new();
    for (n, (data, field)) in (1..).zip(cases) {
        records.push(fact(&record_id(n), "scan", &shift, data));
        expected.push(match field {
            Some(field) => rejected(Some(&record_id(n)), "invalid_record", Some(field)),
            None => accepted(&record_id(n)),
        });
    }
    // The envelope's ids too.
    let mut operator = fact(
        &record_id(30),
        "scan",
        &shift,
        ok_scan(30, &box_id(1), &instant(30, 0)),
    );
    operator["operatorId"] = json!("anna");
    records.push(operator);
    records.push(fact(
        &record_id(31),
        "scan",
        "OCT26-001",
        ok_scan(31, &box_id(1), &instant(31, 0)),
    ));
    expected.push(rejected(
        Some(&record_id(30)),
        "invalid_record",
        Some("operatorId"),
    ));
    expected.push(rejected(
        Some(&record_id(31)),
        "invalid_record",
        Some("shiftId"),
    ));
    assert_eq!(receipts(&admin.app, &floor.key, &records).await, expected);
    // Only the scans that broke no rule wrote anything but their receipts.
    assert_eq!(
        fact_rows(&admin.app).await,
        json!({
            "fact_receipts": 28, "scans": 6, "boxes": 1, "box_items": 2, "code_owners": 2,
            "code_conflicts": 0, "box_exceptions": 0, "shift_close_events": 0
        })
    );
}

#[tokio::test]
async fn a_record_names_a_shift_the_device_entered_and_a_batch_holds_1_to_100() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let scan = |n: u32, shift: &str| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(n), &instant(n, 0)),
        )
    };
    // No such shift; a shift nobody entered; another station's shift.
    let batch = vec![
        scan(1, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"),
        scan(2, planned["id"].as_str().unwrap()),
        scan(3, &colleague.shift),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(1)), "unknown_shift", None),
            rejected(Some(&record_id(2)), "not_entered", None),
            rejected(Some(&record_id(3)), "not_entered", None),
        ]
    );
    // A device of another kind enters no shift at all.
    assert_eq!(
        receipts(&admin.app, &office_pc, &[scan(4, &floor.shift)]).await,
        vec![rejected(Some(&record_id(4)), "not_entered", None)]
    );
    assert_eq!(scan_rows(&admin).await, Vec::<Value>::new());

    // A batch holds 1 to 100 records; anything else is no batch.
    let hundred: Vec<Value> = (100..200).map(|n| scan(n, &floor.shift)).collect();
    let answered = receipts(&admin.app, &floor.key, &hundred).await;
    assert_eq!(answered.len(), 100);
    assert!(answered
        .iter()
        .all(|receipt| receipt["outcome"] == "accepted"));
    let kept = fact_rows(&admin.app).await;
    let too_many: Vec<Value> = (200..301).map(|n| scan(n, &floor.shift)).collect();
    for records in [Vec::new(), too_many] {
        let (status, refused) = send_facts(&admin.app, &floor.key, &records).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!({ "field": "records" })
            ),
            "{}",
            records.len()
        );
    }
    for body in [
        json!({}),
        json!({ "records": {} }),
        json!({ "records": [], "more": 1 }),
    ] {
        let (status, refused) = admin
            .app
            .send(support::app::json(
                with_device(request("POST", "/v1/device/facts"), &floor.key),
                body.clone(),
            ))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{body}"
        );
    }
    let (status, refused) = admin
        .app
        .send(support::app::json(
            request("POST", "/v1/device/facts"),
            json!({ "records": [scan(400, &floor.shift)] }),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}

/// A closed box straight in its table, with an SSCC of a block the station
/// got.
async fn close_box_directly(admin: &Admin, floor: &Floor, id: &str) {
    let (status, block) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", "/v1/device/sscc/blocks"), &floor.key),
            json!({
                "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
                "issuerPrefix": "460068200", "extension": 0
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    sqlx::query(
        "UPDATE boxes SET closed_at = ?, sscc = '046006820000015008', block_id = ?, \
         serial = 1500, digest_matches = 1 WHERE id = ?",
    )
    .bind(instant(30, 0))
    .bind(block["id"].as_str().unwrap())
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let opened = vec![
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &colleague.shift,
            ok_scan(2, &box_id(2), &instant(2, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &opened[..1]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        receipts(&admin.app, &colleague.key, &opened[1..]).await,
        vec![accepted(&record_id(2))]
    );
    close_box_directly(&admin, &floor, &box_id(1)).await;
    let kept = fact_rows(&admin.app).await;
    let mut other_product = ok_scan(3, &box_id(3), &instant(3, 0));
    other_product["code"]["gtin14"] = json!("04600682000099");
    let batch = vec![
        // Another product than the snapshot's.
        fact(&record_id(3), "scan", &floor.shift, other_product),
        // The colleague's box.
        fact(
            &record_id(4),
            "scan",
            &floor.shift,
            ok_scan(4, &box_id(2), &instant(4, 0)),
        ),
        // A closed box.
        fact(
            &record_id(5),
            "scan",
            &floor.shift,
            ok_scan(5, &box_id(1), &instant(5, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(3)), "gtin_mismatch", None),
            rejected(Some(&record_id(4)), "box_unknown", None),
            rejected(Some(&record_id(5)), "box_closed", None),
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 3);
    assert_eq!(fact_rows(&admin.app).await, grown);
    // A box of another device in this very shift is unknown too (a second
    // device on a shift comes with plan 2b, so the row is put in directly).
    sqlx::query(
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(box_id(9))
    .bind(&floor.shift)
    .bind(&colleague.station)
    .bind(instant(9, 0))
    .bind(admin.app.state.timestamp())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(7),
                "scan",
                &floor.shift,
                ok_scan(7, &box_id(9), &instant(7, 0))
            )]
        )
        .await,
        vec![rejected(Some(&record_id(7)), "box_unknown", None)]
    );
    // A box id of this station in another shift is unknown in this one too.
    let second = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(6),
                "scan",
                &second.shift,
                ok_scan(6, &box_id(1), &instant(6, 0))
            )]
        )
        .await,
        vec![rejected(Some(&record_id(6)), "box_unknown", None)]
    );
}

#[tokio::test]
async fn the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let b = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let send = |floor: &Floor, n: u32, box_n: u32, second: u32, milli: u32| {
        let record = fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(7, &box_id(box_n), &instant(second, milli)),
        );
        let app = &admin.app;
        let key = floor.key.clone();
        async move { receipts(app, &key, &[record]).await.remove(0) }
    };
    // A scans the code first; B's scan, which arrives later, was earlier.
    let first_seen = admin.app.state.timestamp();
    assert_eq!(send(&a, 1, 1, 100, 0).await, accepted(&record_id(1)));
    admin.app.clock.advance(time::Duration::minutes(1));
    let displaced_at = admin.app.state.timestamp();
    assert_ne!(displaced_at, first_seen);
    assert_eq!(send(&b, 2, 2, 50, 0).await, accepted(&record_id(2)));
    // B owns it now; A's item left its box when B's scan took the code.
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(2),
            b.shift,
            b.station,
            box_id(2),
            instant(50, 0)
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![json!([
            record_id(1),
            code_hash(7),
            instant(100, 0),
            null,
            displaced_at
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![json!([
            record_id(2),
            code_hash(7),
            instant(50, 0),
            null,
            null
        ])]
    );
    // Later scans lose to B's, A's own included; a scan at the same instant
    // too; the winner is named, and whether it is the sender's own.
    let winner = |same_device: bool| {
        json!({
            "shiftId": b.shift, "shiftNumber": b.number, "deviceId": b.station,
            "scannedAt": instant(50, 0), "sameDevice": same_device
        })
    };
    let conflict = |n: u32, same_device: bool| json!({ "id": record_id(n), "outcome": "conflict", "details": { "winner": winner(same_device) } });
    assert_eq!(send(&a, 3, 1, 200, 0).await, conflict(3, false));
    assert_eq!(send(&b, 4, 2, 300, 0).await, conflict(4, true));
    assert_eq!(send(&a, 5, 1, 50, 0).await, conflict(5, false));
    // One millisecond earlier than the owner takes the code back.
    assert_eq!(send(&a, 6, 1, 49, 999).await, accepted(&record_id(6)));
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(6),
            a.shift,
            a.station,
            box_id(1),
            instant(49, 999)
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![json!([
            record_id(2),
            code_hash(7),
            instant(50, 0),
            null,
            displaced_at
        ])]
    );
    // A conflict sent again keeps its receipt, the winner of that moment,
    // and writes nothing.
    assert_eq!(send(&a, 3, 1, 200, 0).await, conflict(3, false));
    // Every pair of scans of the code is a conflict row: winner, loser.
    let mut expected = vec![
        json!([code_hash(7), record_id(2), record_id(1), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(3), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(4), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(5), displaced_at]),
        json!([code_hash(7), record_id(6), record_id(2), displaced_at]),
    ];
    expected.sort_by_key(|row| (row[1].to_string(), row[2].to_string()));
    assert_eq!(conflicts(&admin).await, expected);
    // The scans that lost are in the journal, with no item.
    assert_eq!(scan_rows(&admin).await.len(), 6);
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM box_items WHERE removed_at IS NULL AND displaced_at IS NULL",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
}

/// A database error is no receipt: the whole batch fails, nothing of it
/// stays, and the device sends it again.
#[tokio::test]
async fn a_database_error_fails_the_whole_batch() {
    let (admin, floor) = floor().await;
    sqlx::query(
        "CREATE TRIGGER break_the_scan BEFORE INSERT ON scans WHEN NEW.raw_length = 999 \
         BEGIN SELECT RAISE(ABORT, 'broken'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let mut broken = ok_scan(2, &box_id(1), &instant(2, 0));
    broken["rawLength"] = json!(999);
    let batch = vec![
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(&record_id(2), "scan", &floor.shift, broken),
    ];
    let empty = fact_rows(&admin.app).await;
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(fact_rows(&admin.app).await, empty);
    sqlx::query("DROP TRIGGER break_the_scan")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
}

/// The handler called directly as device `id` with `records`, bypassing the
/// device authentication in front of it (which writes `last_seen_at`, and
/// has read the key before the handler's transaction starts).
async fn receive_as(admin: &Admin, id: &str, records: &[Value]) -> (StatusCode, Value) {
    let batch: IncomingFacts = serde_json::from_value(json!({ "records": records })).unwrap();
    let outcome = receive_facts(
        State(admin.app.state.clone()),
        AuthDevice {
            id: id.to_owned(),
            kind: DeviceKind::Station,
        },
        ApiJson(batch),
    )
    .await;
    let response = match outcome {
        Ok(receipts) => receipts.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// The batch reads the receipts only after it holds the write lock: a record
/// another batch is still writing when this one arrives is seen, and kept
/// once. With a deferred transaction the stale receipts would be read first
/// and the write would fail with a database error.
#[tokio::test]
async fn a_batch_waiting_for_the_write_lock_sees_the_record_that_held_it() {
    let (admin, floor) = floor().await;
    let record = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    // The same record, sent again while the first send is still being
    // written.
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &record,
        &admin.app.state.timestamp(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        accepted(&record_id(1))
    );
    let again = [record];
    let mut waiting = Box::pin(receive_as(&admin, &floor.station, &again));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the batch answered while another writer held the lock"
    );
    holder.commit().await.unwrap();
    let (status, body) = waiting.await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "receipts": [accepted(&record_id(1))] })
        )
    );
    assert_eq!(scan_rows(&admin).await.len(), 1);
    assert_eq!(kept_receipts(&admin).await.len(), 1);
}

/// The transaction reads the device again: a station revoked after the
/// device authentication read its key (the batch waited for the write lock)
/// keeps nothing, not even a record it sent before.
#[tokio::test]
async fn a_device_revoked_meanwhile_keeps_nothing() {
    let (admin, floor) = floor().await;
    let sent = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[sent.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let kept = fact_rows(&admin.app).await;
    let next = fact(
        &record_id(2),
        "scan",
        &floor.shift,
        ok_scan(2, &box_id(1), &instant(2, 0)),
    );
    for records in [vec![sent], vec![next]] {
        let (status, refused) = receive_as(&admin, &floor.station, &records).await;
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device"))
        );
    }
    assert_eq!(fact_rows(&admin.app).await, kept);
}
```

2. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

/// A station inside an open shift: what facts are sent from.
pub struct Floor {
    pub shift: String,
    /// The shift's number, as a `conflict` receipt names it.
    pub number: String,
    pub station: String,
    pub key: String,
}

/// Put the station of `key` on `line`, plan a shift of `setup`'s product on
/// that line and enter it from the station, so the shift is open and the
/// station its owner.
pub async fn open_floor(admin: &Admin, setup: &ShiftSetup, key: &str, line: &str) -> Floor {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    let (status, moved) = admin
        .app
        .send(json(
            with_device(request("PUT", "/v1/device/line"), key),
            serde_json::json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let mut body = shift_body(setup);
    body["lineId"] = Value::String(line.to_owned());
    let shift = plan_shift(admin, body).await;
    let (status, entered) = admin
        .app
        .send(empty(with_device(
            request(
                "POST",
                &format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap()),
            ),
            key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    Floor {
        shift: shift["id"].as_str().unwrap().to_owned(),
        number: shift["number"].as_str().unwrap().to_owned(),
        station: device["id"].as_str().unwrap().to_owned(),
        key: key.to_owned(),
    }
}

/// `POST /v1/device/facts` with `key`: the status and the body.
pub async fn send_facts(app: &TestApp, key: &str, records: &[Value]) -> (StatusCode, Value) {
    app.send(json(
        with_device(request("POST", "/v1/device/facts"), key),
        serde_json::json!({ "records": records }),
    ))
    .await
}

/// The receipts of a batch the host answered 200.
pub async fn receipts(app: &TestApp, key: &str, records: &[Value]) -> Vec<Value> {
    let (status, body) = send_facts(app, key, records).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

/// The id of record `n`, a canonical UUID.
pub fn record_id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// The id of box `n`, a canonical UUID.
pub fn box_id(n: u32) -> String {
    format!("b0000000-0000-4000-8000-{n:012}")
}

/// A device's instant `second` seconds and `milli` milliseconds after
/// 2026-10-08T06:00:00.000Z, as `Date.toISOString` writes it.
pub fn instant(second: u32, milli: u32) -> String {
    format!(
        "2026-10-08T{:02}:{:02}:{:02}.{milli:03}Z",
        6 + second / 3600,
        second / 60 % 60,
        second % 60
    )
}

/// The hash of code `n`: 64 lower-case hex digits (the host never checks
/// that it is the hash of the code).
pub fn code_hash(n: u32) -> String {
    format!("{n:064x}")
}

/// Code `n` of `shift_setup`'s product, as the domain reads it, with a
/// group separator and a crypto tail in its canonical text.
pub fn code(n: u32) -> Value {
    serde_json::json!({
        "codeHash": code_hash(n),
        "gtin14": "04600682000013",
        "serial": format!("S{n:06}"),
        "canonical": format!("010460068200001321S{n:06}\u{1d}93Tail{n}")
    })
}

/// A record of `kind` in `shift`, with no operator.
pub fn fact(id: &str, kind: &str, shift: &str, data: Value) -> Value {
    serde_json::json!({ "id": id, "kind": kind, "shiftId": shift, "operatorId": null, "data": data })
}

/// The `data` of an accepted scan of code `n` into `box_id` at `at`.
pub fn ok_scan(n: u32, box_id: &str, at: &str) -> Value {
    serde_json::json!({
        "scannedAt": at, "verdict": "ok", "duplicateSource": null, "rawKind": "km",
        "rawLength": 38, "code": code(n), "boxId": box_id
    })
}

/// An `accepted` receipt of record `id`.
pub fn accepted(id: &str) -> Value {
    serde_json::json!({ "id": id, "outcome": "accepted" })
}

/// A `rejected` receipt of record `id` with `code`, and `field` for an
/// `invalid_record` of one field.
pub fn rejected(id: Option<&str>, code: &str, field: Option<&str>) -> Value {
    let mut receipt = serde_json::json!({ "id": id, "outcome": "rejected", "code": code });
    if let Some(field) = field {
        receipt["details"] = serde_json::json!({ "field": field });
    }
    receipt
}

/// Row counts of every table the facts write, by table name.
pub async fn fact_rows(app: &TestApp) -> Value {
    let mut counts = serde_json::Map::new();
    for table in [
        "fact_receipts",
        "scans",
        "boxes",
        "box_items",
        "code_owners",
        "code_conflicts",
        "box_exceptions",
        "shift_close_events",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
        counts.insert(table.to_owned(), Value::from(count));
    }
    Value::Object(counts)
}
```

3. Создать `apps/standalone/proto/fixtures/facts-request.json`:

<!-- prettier-ignore -->
```json
{
  "records": [
    {
      "id": "5d2c8f0a-3b1e-4c7d-9a6f-0e2b4c6d8f10",
      "kind": "scan",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "scannedAt": "2026-10-08T06:15:02.418Z",
        "verdict": "ok",
        "duplicateSource": null,
        "rawKind": "km",
        "rawLength": 83,
        "code": {
          "codeHash": "3f6c0f1e2d8b4a5c9e7f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
          "gtin14": "04600682000013",
          "serial": "5Yq'Ct;",
          "canonical": "0104600682000013215Yq'Ct;\u001d93dGVz"
        },
        "boxId": "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
      }
    },
    {
      "id": "6e3d9a1b-4c2f-4d8e-8b7a-1f3c5d7e9a21",
      "kind": "scan",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "scannedAt": "2026-10-08T06:15:04.007Z",
        "verdict": "invalid",
        "duplicateSource": null,
        "rawKind": "unknown",
        "rawLength": 9,
        "code": null,
        "boxId": null
      }
    }
  ]
}
```

4. Создать `apps/standalone/proto/fixtures/facts-response.json`:

<!-- prettier-ignore -->
```json
{
  "receipts": [
    {
      "id": "5d2c8f0a-3b1e-4c7d-9a6f-0e2b4c6d8f10",
      "outcome": "accepted"
    },
    {
      "id": "9b6a2d4e-7f5c-4a1b-9e0d-4c6f8a0b2d54",
      "outcome": "conflict",
      "details": {
        "winner": {
          "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          "shiftNumber": "OCT26-003",
          "deviceId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
          "scannedAt": "2026-10-08T05:58:41.090Z",
          "sameDevice": false
        }
      }
    },
    {
      "id": "7f4e0b2c-5d3a-4e9f-9c8b-2a4d6e8f0b32",
      "outcome": "rejected",
      "code": "invalid_record",
      "details": {
        "field": "data.code.canonical"
      }
    },
    {
      "id": null,
      "outcome": "rejected",
      "code": "invalid_record"
    },
    {
      "id": "8a5f1c3d-6e4b-4fa0-8d9c-3b5e7f9a1c43",
      "outcome": "rejected",
      "code": "not_entered"
    }
  ]
}
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        modes
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

заменить на

<!-- prettier-ignore -->
```rust
        modes
    }

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![FactKind::Scan];
        for kind in &kinds {
            match kind {
                FactKind::Scan => {}
            }
        }
        kinds
    }

    /// Every `FactOutcome`, listed the same way.
    fn fact_outcomes() -> Vec<FactOutcome> {
        let outcomes = vec![
            FactOutcome::Accepted,
            FactOutcome::Conflict,
            FactOutcome::Rejected,
        ];
        for outcome in &outcomes {
            match outcome {
                FactOutcome::Accepted | FactOutcome::Conflict | FactOutcome::Rejected => {}
            }
        }
        outcomes
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            assert_eq!(serde_json::to_value(mode).unwrap(), mode.as_str());
        }
        assert_eq!(ShiftMode::default(), ShiftMode::Aggregation);
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
```

заменить на

<!-- prettier-ignore -->
```rust
            assert_eq!(serde_json::to_value(mode).unwrap(), mode.as_str());
        }
        assert_eq!(ShiftMode::default(), ShiftMode::Aggregation);
        for kind in fact_kinds() {
            assert_eq!(kind.as_str().parse::<FactKind>(), Ok(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for outcome in fact_outcomes() {
            assert_eq!(outcome.as_str().parse::<FactOutcome>(), Ok(outcome));
            assert_eq!(serde_json::to_value(outcome).unwrap(), outcome.as_str());
        }
        for verdict in [
            ScanVerdict::Ok,
            ScanVerdict::Duplicate,
            ScanVerdict::WrongGtin,
            ScanVerdict::Invalid,
        ] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), verdict.as_str());
        }
        for source in [DuplicateSource::Local, DuplicateSource::Host] {
            assert_eq!(serde_json::to_value(source).unwrap(), source.as_str());
        }
        for raw_kind in [
            ScanRawKind::Km,
            ScanRawKind::Gtin,
            ScanRawKind::Sscc,
            ScanRawKind::Unknown,
        ] {
            assert_eq!(serde_json::to_value(raw_kind).unwrap(), raw_kind.as_str());
        }
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
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
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeOwner,
    Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo,
    DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts,
    DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
        markiro_proto::shift_close_reasons::ALL
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
        markiro_proto::shift_close_reasons::ALL
    );
}

/// A batch of facts and its receipts. The records' `data` stays JSON in the
/// envelope (the host reads it by kind, record by record); each one reads
/// as its kind's type and writes back unchanged.
#[test]
fn fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(kinds, vec![FactKind::Scan, FactKind::Scan]);
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
        };
        assert_eq!(typed, record.data, "{}", record.id);
    }
    let accepted: ScanFact = typed(&batch.records[0].data);
    assert_eq!(
        (accepted.verdict, accepted.raw_kind),
        (ScanVerdict::Ok, ScanRawKind::Km)
    );
    assert!(accepted.code.unwrap().canonical.contains('\u{1d}'));
    let invalid: ScanFact = typed(&batch.records[1].data);
    assert_eq!(
        (invalid.verdict, invalid.code, invalid.box_id),
        (ScanVerdict::Invalid, None, None)
    );
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
        outcomes,
        vec![
            FactOutcome::Accepted,
            FactOutcome::Conflict,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Rejected
        ]
    );
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert!(!winner.same_device);
    for receipt in &receipts.receipts[2..] {
        assert!(markiro_proto::receipt_codes::ALL.contains(&receipt.code.as_deref().unwrap()));
    }
    // A record names no field the host does not read, and a receipt of a
    // record without a readable id has `id: null`.
    let mut value = fixture("facts-request.json");
    value["records"][0]["deviceId"] = Value::String("anything".into());
    assert!(serde_json::from_value::<FactBatch>(value).is_err());
    assert_eq!(receipts.receipts[3].id, None);
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL — компиляция: error[E0432]: unresolved import `markiro_host::routes::facts`; cannot find function `receive` in module `markiro_host::facts`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — компиляция: cannot find type `FactKind` in this scope (и `FactOutcome`, `ScanVerdict`, …).

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/migrations/0010_facts.sql`:

<!-- prettier-ignore -->
```sql
-- Facts (stage 2a spec §4.4–4.5): what a station sends from the line —
-- scans, closed boxes, label checks, box exceptions and a shift's close —
-- and the receipt the host answers for each record. Every value a device
-- sends is checked before it is written (`host/src/facts`), so no CHECK
-- here can refuse a record; they hold what no row may break. A device's
-- instants are kept as it wrote them (`YYYY-MM-DDTHH:MM:SS.sssZ`, so the
-- text orders them); the host's own (`received_at`, `detected_at`,
-- `displaced_at`) are in its usual format.

-- The receipt of every record that had a readable id, kept for good: a
-- record sent again with the same digest gets this receipt back, with
-- another digest `payload_mismatch`. `kind` is NULL for a record that could
-- not be read; `shift_id` names the shift once the device's entry in it was
-- found (no foreign key: a receipt never keeps a shift from being deleted).
CREATE TABLE fact_receipts (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  kind TEXT,
  shift_id TEXT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  code TEXT,
  details TEXT CHECK (details IS NULL OR (json_valid(details) AND json_type(details) = 'object')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((outcome = 'rejected') = (code IS NOT NULL))
);
CREATE INDEX fact_receipts_shift ON fact_receipts (shift_id, received_at);

-- The journal of every scan of the work screen. An `invalid` scan keeps no
-- code (it may have been a badge); an `ok` one names its box.
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')),
  duplicate_source TEXT CHECK (duplicate_source IS NULL OR duplicate_source IN ('local', 'host')),
  raw_kind TEXT NOT NULL CHECK (raw_kind IN ('km', 'gtin', 'sscc', 'unknown')),
  raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
  code_hash TEXT,
  gtin14 TEXT,
  serial TEXT,
  canonical TEXT,
  box_id TEXT,
  operator_id TEXT,
  scanned_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((verdict = 'invalid') = (code_hash IS NULL)),
  CHECK ((verdict = 'ok') = (box_id IS NOT NULL))
);
CREATE INDEX scans_shift ON scans (shift_id);
CREATE INDEX scans_code_hash ON scans (code_hash) WHERE code_hash IS NOT NULL;

-- Boxes as the facts tell them: opened by the first accepted scan, closed
-- with an SSCC of a block issued to the device. A closed box keeps its SSCC
-- when it is taken apart.
CREATE TABLE boxes (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  item_count_reported INTEGER,
  membership_digest TEXT,
  digest_matches INTEGER CHECK (digest_matches IS NULL OR digest_matches IN (0, 1)),
  operator_id TEXT,
  print_verified_at TEXT,
  print_skipped_at TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (digest_matches IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX boxes_sscc ON boxes (sscc) WHERE sscc IS NOT NULL;
CREATE INDEX boxes_shift ON boxes (shift_id);

-- A box's items: one row per accepted scan that owned its code. An item
-- leaves its box when an exception removes it (`removed_at`) or an earlier
-- scan of the code elsewhere takes the code (`displaced_at`); a live code
-- is in a box once.
CREATE TABLE box_items (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  code_hash TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  displaced_at TEXT
);
CREATE UNIQUE INDEX box_items_live ON box_items (box_id, code_hash)
  WHERE removed_at IS NULL AND displaced_at IS NULL;

-- The registry of codes: the scan that owns each code now, the earliest
-- accepted scan of it that no exception removed.
CREATE TABLE code_owners (
  code_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  scanned_at TEXT NOT NULL
);

-- Two accepted scans of one code: the earlier won it. Their review in the
-- office comes with plan 2b.
CREATE TABLE code_conflicts (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  winner_scan_id TEXT NOT NULL REFERENCES scans (id),
  loser_scan_id TEXT NOT NULL REFERENCES scans (id),
  detected_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (winner_scan_id <> loser_scan_id)
);
CREATE INDEX code_conflicts_code ON code_conflicts (code_hash);

-- Box exceptions, with the fields of each kind as the cloud's
-- `box_exceptions_kind_payload_check`, and reason codes instead of text.
CREATE TABLE box_exceptions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('undo', 'clear', 'reprint', 'disassemble')),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  code_hash TEXT,
  target_scanned_at TEXT,
  reason_code TEXT,
  reason_text TEXT,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((kind = 'undo' AND code_hash IS NOT NULL AND target_scanned_at IS NOT NULL
      AND reason_code IS NULL)
    OR (kind = 'clear' AND code_hash IS NULL AND target_scanned_at IS NULL
      AND reason_code IS NULL)
    OR (kind IN ('reprint', 'disassemble') AND code_hash IS NULL
      AND target_scanned_at IS NULL AND reason_code IS NOT NULL)),
  CHECK (reason_text IS NULL OR reason_code IS 'other')
);
CREATE INDEX box_exceptions_box ON box_exceptions (box_id);

-- Every close a station sent, also of a shift the office had closed first
-- (`already_closed`).
CREATE TABLE shift_close_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  planned_qty_snapshot INTEGER,
  actual_qty INTEGER NOT NULL CHECK (actual_qty >= 0),
  closed_box_count INTEGER NOT NULL CHECK (closed_box_count >= 0),
  reason_code TEXT,
  closed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'already_closed')),
  received_at TEXT NOT NULL
);
CREATE INDEX shift_close_events_shift ON shift_close_events (shift_id);
```

2. В `apps/standalone/host/src/auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

impl AuthDevice {
    /// The device is still a paired, unrevoked station, read inside the
    /// write transaction: a revocation committed after the extractor read the
    /// key (the request waited for the write lock) must stop the write, since
    /// a revoked station neither creates a shift, nor enters one, nor gets
    /// serials. `forbidden` is the text for a device of another kind.
    pub async fn require_station_in(
        &self,
        conn: &mut SqliteConnection,
        forbidden: &str,
    ) -> Result<(), ApiError> {
        let kind: Option<String> =
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
                .bind(&self.id)
                .fetch_optional(conn)
                .await
                .map_err(ApiError::internal)?;
        let kind: DeviceKind = kind
            .ok_or_else(|| {
                ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
            })?
            .parse()
            .map_err(ApiError::internal)?;
        if kind == DeviceKind::Station {
            Ok(())
        } else {
            Err(ApiError::forbidden(forbidden))
```

заменить на

<!-- prettier-ignore -->
```rust
}

impl AuthDevice {
    /// The device is still paired and not revoked, read inside the write
    /// transaction, and its kind as stored: a revocation committed after the
    /// extractor read the key (the request waited for the write lock) must
    /// stop the write. A batch of facts calls it, whatever the device's kind.
    pub async fn require_live_in(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<DeviceKind, ApiError> {
        let kind: Option<String> =
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
                .bind(&self.id)
                .fetch_optional(conn)
                .await
                .map_err(ApiError::internal)?;
        kind.ok_or_else(|| {
            ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
        })?
        .parse()
        .map_err(ApiError::internal)
    }

    /// The device is still a paired, unrevoked station, read inside the
    /// write transaction ([`Self::require_live_in`]): a revoked station
    /// neither creates a shift, nor enters one, nor gets serials. `forbidden`
    /// is the text for a device of another kind.
    pub async fn require_station_in(
        &self,
        conn: &mut SqliteConnection,
        forbidden: &str,
    ) -> Result<(), ApiError> {
        if self.require_live_in(conn).await? == DeviceKind::Station {
            Ok(())
        } else {
            Err(ApiError::forbidden(forbidden))
```

3. Создать `apps/standalone/host/src/facts/boxes.rs`:

<!-- prettier-ignore -->
```rust
//! Boxes as the facts tell them: a box belongs to one device in one shift,
//! and its id is the device's own. A record that names another device's or
//! another shift's box is answered as if no such box existed
//! (`box_unknown`), so a device learns nothing of the others.

use markiro_proto::receipt_codes;
use sqlx::SqliteConnection;

use super::{Context, Failure, Reject};
use crate::error::ApiError;

/// A box of this device and this shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnBox {
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
}

/// The box `id` when it is this device's in this shift, `None` when no box
/// has the id, and `box_unknown` when another device's or another shift's
/// box has it.
pub async fn find(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<Option<OwnBox>, Failure> {
    type BoxRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<BoxRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at FROM boxes WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match row {
        None => Ok(None),
        Some((shift_id, device_id, ..))
            if shift_id != context.shift.id || device_id != context.device_id =>
        {
            Err(Reject::new(receipt_codes::BOX_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at)) => Ok(Some(OwnBox {
            closed_at,
            sscc,
            disassembled_at,
        })),
    }
}
```

4. Заменить `apps/standalone/host/src/facts/mod.rs` целиком на:

<!-- prettier-ignore -->
```rust
//! Facts a device sends (stage 2a spec §4.4): scans, closed boxes, label
//! checks, box exceptions and a shift's close, in batches of
//! `POST /v1/device/facts`. The host reads each record on its own and
//! answers a receipt for each; the same record sent again gets the same
//! receipt. Marking rules stay in `@markiro/domain`: the device sends the
//! code's hash, GTIN, serial and canonical text, and the host checks their
//! shape and the shift's GTIN, never the code itself.
//!
//! A record is checked whole before its first write: a refusal (a receipt
//! `rejected`) leaves nothing of the record behind but its receipt. A
//! database error is no receipt: it fails the whole batch, and the device
//! sends it again.

pub mod boxes;
pub mod registry;
pub mod rules;
pub mod scan;

use markiro_proto::{
    receipt_codes, FactKind, FactOutcome, FactReceipt, FactRecord, ShiftOrigin, ShiftStatus,
};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::shifts;
use crate::validate;

/// Why a record was not applied: a code of `receipt_codes` and its
/// details.
#[derive(Debug, Clone, PartialEq)]
pub struct Reject {
    pub code: &'static str,
    pub details: Option<Value>,
}

impl Reject {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            details: None,
        }
    }

    /// `invalid_record` on one field of a readable record, named by its JSON
    /// path (`data.boxId`).
    pub fn field(field: &str) -> Self {
        Self {
            code: receipt_codes::INVALID_RECORD,
            details: Some(serde_json::json!({ "field": field })),
        }
    }
}

/// Why applying a record stopped: the record's own fault (a receipt), or a
/// database error that fails the batch.
#[derive(Debug)]
pub enum Failure {
    Reject(Reject),
    Internal(ApiError),
}

impl From<Reject> for Failure {
    fn from(reject: Reject) -> Self {
        Self::Reject(reject)
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Internal(error)
    }
}

/// What an applied record answers: `accepted`, or `conflict` with its
/// details.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub outcome: FactOutcome,
    pub details: Option<Value>,
}

impl Applied {
    pub fn accepted() -> Self {
        Self {
            outcome: FactOutcome::Accepted,
            details: None,
        }
    }
}

/// The shift a record names, as the device entered it.
#[derive(Debug, Clone)]
pub struct FactShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    /// The GTIN the shift's snapshot froze.
    pub gtin14: String,
    /// The SSCC issuer prefix the shift's snapshot froze.
    pub issuer_prefix: String,
}

/// What every kind's handler knows of its record.
pub struct Context<'a> {
    pub device_id: &'a str,
    pub record_id: &'a str,
    pub operator_id: Option<&'a str>,
    pub shift: &'a FactShift,
    /// The host's clock when the batch arrived.
    pub received_at: &'a str,
}

/// The receipt of a refused record.
fn rejected(id: Option<String>, reject: Reject) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(reject.code.to_owned()),
        details: object(reject.details),
    }
}

fn object(details: Option<Value>) -> Option<serde_json::Map<String, Value>> {
    match details {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Receive one record of a batch inside the batch's write transaction and
/// return its receipt. A record with a readable id whose receipt is kept
/// already gets that receipt back when its digest is the same, and
/// `payload_mismatch` (kept nowhere) when it is not; otherwise the record is
/// applied and its receipt kept. A record without a readable id is answered
/// `invalid_record` and nothing of it is kept.
pub async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<FactReceipt, ApiError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| validate::client_uuid("id", id).is_ok())
        .map(str::to_owned);
    let digest = rules::record_digest(value);
    if let Some(id) = &id {
        if let Some((stored_digest, receipt)) = stored(conn, device_id, id).await? {
            if stored_digest == digest {
                return Ok(receipt);
            }
            tracing::warn!(
                device = %device_id,
                record = %id,
                code = receipt_codes::PAYLOAD_MISMATCH,
                "a fact was rejected"
            );
            return Ok(rejected(
                Some(id.clone()),
                Reject::new(receipt_codes::PAYLOAD_MISMATCH),
            ));
        }
    }
    let applying = apply(conn, device_id, value, received_at).await?;
    let receipt = match applying.answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
            outcome: applied.outcome,
            code: None,
            details: object(applied.details),
        },
        Err(reject) => {
            tracing::warn!(
                device = %device_id,
                record = ?id,
                code = reject.code,
                "a fact was rejected"
            );
            rejected(id.clone(), reject)
        }
    };
    if let Some(id) = &id {
        sqlx::query(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             code, details, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(id)
        .bind(applying.kind.map(FactKind::as_str))
        .bind(&applying.shift_id)
        .bind(&digest)
        .bind(receipt.outcome.as_str())
        .bind(&receipt.code)
        .bind(
            receipt
                .details
                .as_ref()
                .map(|details| Value::Object(details.clone()).to_string()),
        )
        .bind(received_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(receipt)
}

/// The kept receipt of a record and the digest it was kept with.
async fn stored(
    conn: &mut SqliteConnection,
    device_id: &str,
    id: &str,
) -> Result<Option<(String, FactReceipt)>, ApiError> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT digest, outcome, code, details FROM fact_receipts \
         WHERE device_id = ? AND record_id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(|(digest, outcome, code, details)| {
        Ok((
            digest,
            FactReceipt {
                id: Some(id.to_owned()),
                outcome: outcome.parse().map_err(ApiError::internal)?,
                code,
                details: details
                    .map(|details| serde_json::from_str(&details))
                    .transpose()
                    .map_err(ApiError::internal)?,
            },
        ))
    })
    .transpose()
}

/// What applying a record learned: its kind once the record was readable,
/// its shift once the device's entry in it was found, and the answer.
struct Applying {
    kind: Option<FactKind>,
    shift_id: Option<String>,
    answer: Result<Applied, Reject>,
}

impl Applying {
    fn refused(kind: Option<FactKind>, reject: Reject) -> Self {
        Self {
            kind,
            shift_id: None,
            answer: Err(reject),
        }
    }
}

/// The checks every record passes, then its kind's handler.
async fn apply(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<Applying, ApiError> {
    let Ok(record) = serde_json::from_value::<FactRecord>(value.clone()) else {
        return Ok(Applying::refused(
            None,
            Reject::new(receipt_codes::INVALID_RECORD),
        ));
    };
    let kind = Some(record.kind);
    for (field, text) in [
        ("id", Some(record.id.as_str())),
        ("shiftId", Some(record.shift_id.as_str())),
        ("operatorId", record.operator_id.as_deref()),
    ] {
        if let Some(text) = text {
            if validate::client_uuid(field, text).is_err() {
                return Ok(Applying::refused(kind, Reject::field(field)));
            }
        }
    }
    let Some(shift) = entered_shift(conn, &record.shift_id, device_id).await? else {
        return Ok(Applying::refused(
            kind,
            Reject::new(receipt_codes::UNKNOWN_SHIFT),
        ));
    };
    let Some(shift) = shift else {
        return Ok(Applying::refused(
            kind,
            Reject::new(receipt_codes::NOT_ENTERED),
        ));
    };
    let context = Context {
        device_id,
        record_id: &record.id,
        operator_id: record.operator_id.as_deref(),
        shift: &shift,
        received_at,
    };
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
    Ok(Applying {
        kind,
        shift_id: Some(shift.id.clone()),
        answer,
    })
}

/// The shift `id` as the device entered it: `None` when there is no such
/// shift, `Some(None)` when the device never entered it.
async fn entered_shift(
    conn: &mut SqliteConnection,
    id: &str,
    device_id: &str,
) -> Result<Option<Option<FactShift>>, ApiError> {
    type ShiftRow = (
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         EXISTS (SELECT 1 FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((status, month_key, seq, created_from, gtin14, issuer_prefix, entered)) = row else {
        return Ok(None);
    };
    if !entered {
        return Ok(Some(None));
    }
    // An entered shift was opened, so it has its snapshot.
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    let snapshot = || ApiError::internal("an entered shift has no snapshot");
    Ok(Some(Some(FactShift {
        id: id.to_owned(),
        number: shifts::format_number(&month_key, seq, origin),
        status: status.parse().map_err(ApiError::internal)?,
        gtin14: gtin14.ok_or_else(snapshot)?,
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
    })))
}
```

5. Создать `apps/standalone/host/src/facts/registry.rs`:

<!-- prettier-ignore -->
```rust
//! The registry of codes (stage 2a spec, decision 14): each code is owned by
//! its earliest accepted scan, whatever order the scans arrive in. A scan
//! earlier than the owner takes the code (the owner's item leaves its box,
//! `displaced_at`); a later one is answered `conflict` with the owner. Both
//! write a `code_conflicts` row; telling the displaced device and the
//! office's review come with plan 2b. Exceptions release the codes their
//! items owned.

use markiro_proto::{CodeOwner, FactOutcome, ShiftOrigin};
use sqlx::SqliteConnection;

use super::{Applied, Context};
use crate::error::ApiError;
use crate::shifts;

/// The scan that owns a code now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub scan_id: String,
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub scanned_at: String,
}

impl Owner {
    /// The owner as `device_id` is told of it.
    pub fn to_wire(&self, device_id: &str) -> CodeOwner {
        CodeOwner {
            shift_id: self.shift_id.clone(),
            shift_number: self.shift_number.clone(),
            device_id: self.device_id.clone(),
            scanned_at: self.scanned_at.clone(),
            same_device: self.device_id == device_id,
        }
    }
}

/// The owner of `code_hash`, or `None` while the code is free.
pub async fn owner(
    conn: &mut SqliteConnection,
    code_hash: &str,
) -> Result<Option<Owner>, ApiError> {
    type OwnerRow = (String, String, String, i64, String, String, String);
    let row: Option<OwnerRow> = sqlx::query_as(
        "SELECT o.scan_id, o.shift_id, s.number_month_key, s.number_seq, s.created_from,          o.device_id, o.scanned_at FROM code_owners o JOIN shifts s ON s.id = o.shift_id          WHERE o.code_hash = ?",
    )
    .bind(code_hash)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(
        |(scan_id, shift_id, month_key, seq, created_from, device_id, scanned_at)| {
            let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
            Ok(Owner {
                scan_id,
                shift_id,
                shift_number: shifts::format_number(&month_key, seq, origin),
                device_id,
                scanned_at,
            })
        },
    )
    .transpose()
}

/// An accepted scan, already in the journal, that claims its code for its
/// box.
pub struct Claim<'a> {
    pub scan_id: &'a str,
    pub code_hash: &'a str,
    pub box_id: &'a str,
    pub scanned_at: &'a str,
}

async fn conflict_row(
    conn: &mut SqliteConnection,
    code_hash: &str,
    winner: &str,
    loser: &str,
    at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(code_hash)
    .bind(winner)
    .bind(loser)
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

/// Give the code to `claim` when it is free or owned by a later scan, and
/// put it in its box; otherwise keep the owner and answer `conflict` with
/// it. Two scans at the same instant: the owner keeps the code.
pub async fn claim(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    claim: &Claim<'_>,
) -> Result<Applied, ApiError> {
    match owner(&mut *conn, claim.code_hash).await? {
        Some(owner) if claim.scanned_at >= owner.scanned_at.as_str() => {
            conflict_row(
                &mut *conn,
                claim.code_hash,
                &owner.scan_id,
                claim.scan_id,
                context.received_at,
            )
            .await?;
            let winner = serde_json::to_value(owner.to_wire(context.device_id))
                .map_err(ApiError::internal)?;
            return Ok(Applied {
                outcome: FactOutcome::Conflict,
                details: Some(serde_json::json!({ "winner": winner })),
            });
        }
        Some(owner) => {
            // An earlier scan: the owner's item leaves its box first, so the
            // code is never live twice.
            sqlx::query(
                "UPDATE box_items SET displaced_at = ? \
                 WHERE scan_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
            )
            .bind(context.received_at)
            .bind(&owner.scan_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            conflict_row(
                &mut *conn,
                claim.code_hash,
                claim.scan_id,
                &owner.scan_id,
                context.received_at,
            )
            .await?;
            sqlx::query(
                "UPDATE code_owners SET scan_id = ?, shift_id = ?, device_id = ?, box_id = ?, \
                 scanned_at = ? WHERE code_hash = ?",
            )
            .bind(claim.scan_id)
            .bind(&context.shift.id)
            .bind(context.device_id)
            .bind(claim.box_id)
            .bind(claim.scanned_at)
            .bind(claim.code_hash)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        }
        None => {
            sqlx::query(
                "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, \
                 scanned_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(claim.code_hash)
            .bind(claim.scan_id)
            .bind(&context.shift.id)
            .bind(context.device_id)
            .bind(claim.box_id)
            .bind(claim.scanned_at)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        }
    }
    sqlx::query("INSERT INTO box_items (scan_id, box_id, code_hash, added_at) VALUES (?, ?, ?, ?)")
        .bind(claim.scan_id)
        .bind(claim.box_id)
        .bind(claim.code_hash)
        .bind(claim.scanned_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

6. Создать `apps/standalone/host/src/facts/scan.rs`:

<!-- prettier-ignore -->
```rust
//! `scan` facts: the journal of every scan of the work screen. An accepted
//! scan (`ok`) opens its box when the host does not know it yet, and claims
//! its code in the registry (`registry::claim`); the others are journal
//! rows only. An `invalid` scan keeps no text, only its length and what it
//! looked like.

use markiro_proto::{receipt_codes, ScanFact, ScanRawKind, ScanVerdict};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::registry::{self, Claim};
use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The longest serial the host keeps, in bytes of UTF-8; a serial of the
/// GS1 system has 20 characters of ASCII at most, so this only keeps a
/// broken device out.
pub const MAX_SERIAL_BYTES: usize = 64;
/// The longest canonical code the host keeps, in bytes of UTF-8.
pub const MAX_CANONICAL_BYTES: usize = 1024;

/// The fields of a scan agree with its verdict: an `invalid` scan has no
/// code and looked like no code, a `duplicate` names who found it, an `ok`
/// one names its box; and the code, when there is one, has the shape the
/// domain gives it.
fn check(scan: &ScanFact) -> Result<(), Reject> {
    let invalid = scan.verdict == ScanVerdict::Invalid;
    if rules::device_instant(&scan.scanned_at).is_none() {
        return Err(Reject::field("data.scannedAt"));
    }
    if invalid == (scan.raw_kind == ScanRawKind::Km) {
        return Err(Reject::field("data.rawKind"));
    }
    if invalid != scan.code.is_none() {
        return Err(Reject::field("data.code"));
    }
    if (scan.verdict == ScanVerdict::Duplicate) != scan.duplicate_source.is_some() {
        return Err(Reject::field("data.duplicateSource"));
    }
    match &scan.box_id {
        Some(box_id) if scan.verdict == ScanVerdict::Ok => {
            if validate::client_uuid("data.boxId", box_id).is_err() {
                return Err(Reject::field("data.boxId"));
            }
        }
        None if scan.verdict != ScanVerdict::Ok => {}
        _ => return Err(Reject::field("data.boxId")),
    }
    if let Some(code) = &scan.code {
        if !rules::is_code_hash(&code.code_hash) {
            return Err(Reject::field("data.code.codeHash"));
        }
        if code.gtin14.len() != 14 || !code.gtin14.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Reject::field("data.code.gtin14"));
        }
        if !(1..=MAX_SERIAL_BYTES).contains(&code.serial.len())
            || code.serial.chars().any(char::is_control)
        {
            return Err(Reject::field("data.code.serial"));
        }
        if !(1..=MAX_CANONICAL_BYTES).contains(&code.canonical.len())
            || code.canonical.contains('\0')
        {
            return Err(Reject::field("data.code.canonical"));
        }
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let scan: ScanFact = serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&scan)?;
    let accepted = match (&scan.code, &scan.box_id) {
        (Some(code), Some(box_id)) if scan.verdict == ScanVerdict::Ok => {
            if code.gtin14 != context.shift.gtin14 {
                return Err(Reject::new(receipt_codes::GTIN_MISMATCH).into());
            }
            match boxes::find(&mut *conn, context, box_id).await? {
                Some(found) if found.closed_at.is_some() => {
                    return Err(Reject::new(receipt_codes::BOX_CLOSED).into());
                }
                Some(_) => {}
                None => {
                    sqlx::query(
                        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(box_id)
                    .bind(&context.shift.id)
                    .bind(context.device_id)
                    .bind(&scan.scanned_at)
                    .bind(context.received_at)
                    .execute(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
                }
            }
            Some((code, box_id))
        }
        _ => None,
    };
    let scan_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
         raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
         scanned_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&scan_id)
    .bind(context.record_id)
    .bind(context.device_id)
    .bind(&context.shift.id)
    .bind(scan.verdict.as_str())
    .bind(scan.duplicate_source.map(|source| source.as_str()))
    .bind(scan.raw_kind.as_str())
    .bind(scan.raw_length)
    .bind(scan.code.as_ref().map(|code| &code.code_hash))
    .bind(scan.code.as_ref().map(|code| &code.gtin14))
    .bind(scan.code.as_ref().map(|code| &code.serial))
    .bind(scan.code.as_ref().map(|code| &code.canonical))
    .bind(&scan.box_id)
    .bind(context.operator_id)
    .bind(&scan.scanned_at)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match accepted {
        Some((code, box_id)) => Ok(registry::claim(
            conn,
            context,
            &Claim {
                scan_id: &scan_id,
                code_hash: &code.code_hash,
                box_id,
                scanned_at: &scan.scanned_at,
            },
        )
        .await?),
        None => Ok(Applied::accepted()),
    }
}
```

7. Создать `apps/standalone/host/src/routes/facts.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/device/facts` (stage 2a spec §4.4): a device's batch of 1–100
//! facts, applied in one write transaction, each record on its own
//! (`facts::receive`), answered with a receipt per record in their order.
//! A database error is no receipt: nothing of the batch stays, and the
//! device sends it again.

use axum::extract::State;
use axum::Json;
use markiro_proto::FactReceipts;
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::facts;
use crate::server::AppState;

/// The most records of one batch.
pub const MAX_RECORDS: usize = 100;

/// The body as the host reads it: each record a JSON value of its own, so a
/// record it cannot read is answered `rejected` and the others are applied.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingFacts {
    records: Vec<Value>,
}

pub async fn receive_facts(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingFacts>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation(
            "records",
            format!("1-{MAX_RECORDS} records"),
        ));
    }
    let received_at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
    let mut receipts = Vec::with_capacity(batch.records.len());
    for record in &batch.records {
        receipts.push(facts::receive(&mut tx, &device.id, record, &received_at).await?);
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
```

8. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
```

9. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route(
            "/v1/device/facts",
            post(crate::routes::facts::receive_facts),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

10. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub counterparty_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, OfficeRole, ProductStatus, ShiftMode, ShiftOrigin,
        ShiftStatus, TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub counterparty_id: Option<String>,
}

/// What a fact records (stage 2a spec §4.4): the kind tells the host how
/// to read the record's `data`. A kind added later is a new variant; a host
/// that does not know it answers the record `invalid_record`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Scan,
}

impl FactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FactKind::Scan => "scan",
        }
    }
}

impl std::str::FromStr for FactKind {
    type Err = UnknownVariant;

    /// The name [`FactKind::as_str`] gives, as `fact_receipts.kind` stores
    /// it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("fact kind", text)
    }
}

/// One record of a device's outbox (`POST /v1/device/facts`): `id` is a
/// lower-case hyphenated UUID the device made up, which keys the receipt;
/// `data` is read by `kind` (`ScanFact`, …). `operatorId` names the
/// operator signed in when it happened, or `null`; the host keeps it as
/// evidence without checking that the operator exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactRecord {
    pub id: String,
    pub kind: FactKind,
    pub shift_id: String,
    #[serde(default)]
    pub operator_id: Option<String>,
    pub data: serde_json::Value,
}

/// `POST /v1/device/facts`: 1–100 records, applied in their order. The host
/// reads each record on its own, so one it cannot read is answered
/// `rejected` and the others are still applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactBatch {
    pub records: Vec<FactRecord>,
}

/// What a station decided about a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanVerdict {
    /// Accepted into the box.
    Ok,
    /// A code already taken, by this station's own copy or by the host.
    Duplicate,
    /// A code of another product than the shift's.
    WrongGtin,
    /// No code of marking at all.
    Invalid,
}

impl ScanVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanVerdict::Ok => "ok",
            ScanVerdict::Duplicate => "duplicate",
            ScanVerdict::WrongGtin => "wrong_gtin",
            ScanVerdict::Invalid => "invalid",
        }
    }
}

/// Who found a duplicate: the station's own copy of the shift, or the host
/// asked with `GET /v1/device/codes/{codeHash}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateSource {
    Local,
    Host,
}

impl DuplicateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DuplicateSource::Local => "local",
            DuplicateSource::Host => "host",
        }
    }
}

/// What the domain's `classifyScan` read the scan as: a code of marking, or
/// (for an `invalid` scan) a GTIN, an SSCC or nothing it knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanRawKind {
    Km,
    Gtin,
    Sscc,
    Unknown,
}

impl ScanRawKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanRawKind::Km => "km",
            ScanRawKind::Gtin => "gtin",
            ScanRawKind::Sscc => "sscc",
            ScanRawKind::Unknown => "unknown",
        }
    }
}

/// A code of marking as the domain read it: `codeHash` is `kmHash` (64
/// lower-case hex digits), `canonical` the text `canonicalizeKm` kept (with
/// its group separators, at most 1024 bytes). The host checks their shape,
/// never the code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScannedCode {
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub canonical: String,
}

/// `data` of a `scan` fact: every scan of the work screen, accepted or not.
/// An `invalid` scan carries no text, only its length and what it looked
/// like (it may be a badge, whose code is a secret); an `ok` one names the
/// box it went into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanFact {
    pub scanned_at: String,
    pub verdict: ScanVerdict,
    pub duplicate_source: Option<DuplicateSource>,
    pub raw_kind: ScanRawKind,
    pub raw_length: u32,
    pub code: Option<ScannedCode>,
    pub box_id: Option<String>,
}

/// How the host answered a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactOutcome {
    /// Applied.
    Accepted,
    /// Kept, but the code belongs to an earlier scan (`details.winner`).
    Conflict,
    /// Not applied (`code`, one of [`receipt_codes`]).
    Rejected,
}

impl FactOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            FactOutcome::Accepted => "accepted",
            FactOutcome::Conflict => "conflict",
            FactOutcome::Rejected => "rejected",
        }
    }
}

impl std::str::FromStr for FactOutcome {
    type Err = UnknownVariant;

    /// The name [`FactOutcome::as_str`] gives, as `fact_receipts.outcome`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("fact outcome", text)
    }
}

/// The host's answer to one record. `id` is the record's, or `null` when the
/// record had no readable id (then nothing was kept, and the device matches
/// the receipt by its place in the batch). A `rejected` receipt names its
/// `code`; `details` carries the field of an `invalid_record` and the winner
/// of a `conflict`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactReceipt {
    pub id: Option<String>,
    pub outcome: FactOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

/// The answer of `POST /v1/device/facts`: a receipt for each record, in the
/// records' order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactReceipts {
    pub receipts: Vec<FactReceipt>,
}

/// The scan that owns a code (stage 2a spec §4.6): the earliest accepted
/// scan of it. `sameDevice` tells the asking device that the scan is its
/// own. It is a `conflict` receipt's `details.winner` too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOwner {
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub scanned_at: String,
    pub same_device: bool,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, DuplicateSource, FactKind, FactOutcome, OfficeRole,
        ProductStatus, ScanRawKind, ScanVerdict, ShiftMode, ShiftOrigin, ShiftStatus,
        TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: PASS — 10 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 42 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
  technologists make (stage 2a spec §4.9, `planShifts`) — check
  `require_shift_planning` and `require_shift_planning_in` the same way, and
  `auth::plans_shifts` names their roles, also with no wildcard arm.

## Change feed

```

заменить на

<!-- prettier-ignore -->
```text
  technologists make (stage 2a spec §4.9, `planShifts`) — check
  `require_shift_planning` and `require_shift_planning_in` the same way, and
  `auth::plans_shifts` names their roles, also with no wildcard arm.
- Device writes re-check the device the same way, right after
  `begin_write`, since the extractor read it before the request queued for
  the write lock: a station's shift create and entry and an SSCC block call
  `AuthDevice::require_station_in` (a revoked device is 401 with
  `credential: device`, one that is no station 403), and a batch of facts
  calls `AuthDevice::require_live_in` (401 for a revoked device; any kind may
  send), which `require_station_in` builds on.

## Change feed

```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`exception-reasons.json`) are fixtures too; the webview reads them with the
facts sender (plan 2a6) and the exception screens (plan 2a8).

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
`exception-reasons.json`) are fixtures too; the webview reads them with the
facts sender (plan 2a6) and the exception screens (plan 2a8).

A device sends facts in batches (`POST /v1/device/facts`, `{ records }`,
1–100 records, `validation_failed` on `records` otherwise; migration
`0010_facts.sql`). Any device kind may send, but only a device that entered
the shift — a station, in stage 2a — gets past `not_entered`. The batch is
one `BEGIN IMMEDIATE` transaction, and each record is read from its own JSON
value (`facts::receive`), so a record the host cannot read is answered
`rejected` with `invalid_record` and the others are applied. The answer is a
receipt per record, in their order: `accepted`, `conflict` (with
`details.winner`) or `rejected` with a code of `receipt_codes`
(`details.field` names the field an `invalid_record` broke). A record with a
readable id (a canonical UUID the device made up) keeps its receipt for good
in `fact_receipts`, keyed by the device and the id, with the SHA-256 of the
record's compact JSON (`rules::record_digest`): the same record sent again
gets the same receipt, and other content under the same id
`payload_mismatch`, which is kept nowhere. A record without a readable id
keeps nothing, and its receipt has `id: null`. Every record names a shift
that exists (`unknown_shift`) and that the device entered (`not_entered`),
and an operator by a UUID or `null`, kept as evidence without a foreign key.
A record is checked whole before its first write, so a refusal leaves
nothing but its receipt; a database error is no receipt, it fails the batch
(500, `internal`), and the device sends the batch again. Facts are
production data: they take no revision and write no audit row.

A `scan` (`facts/scan.rs`) is a journal row (`scans`) whatever its verdict;
an `invalid` one keeps no code, only what it looked like (`rawKind`) and its
length, since it may have been a badge. An `ok` one carries the GTIN the
snapshot froze (`gtin_mismatch` otherwise) and a box of this device in this
shift: an unknown box id opens the box, another device's or another shift's
is `box_unknown`, a closed one `box_closed`. Its code goes to the registry
(`code_owners`, `facts/registry.rs`): the earliest accepted scan owns a code
whatever order the scans arrive in, compared by their device instants. A
scan earlier than the owner takes the code, and the owner's item leaves its
box (`box_items.displaced_at`); a later one, or one at the same instant, is
`conflict` with `details.winner` (`CodeOwner`, `sameDevice` when the owner
is the sender's own scan). Both write a `code_conflicts` row; telling the
displaced device and the office's review come with plan 2b.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — квитанция ищется без устройства. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
         WHERE device_id = ? AND record_id = ?",
```

заменить на

<!-- prettier-ignore -->
```rust
         WHERE (device_id = ? OR 1) AND record_id = ?",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — отпечаток не сверяется. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if stored_digest == digest {
```

заменить на

<!-- prettier-ignore -->
```rust
            if stored_digest == digest || true {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — квитанция не хранится. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(id) = &id {
        sqlx::query(
```

заменить на

<!-- prettier-ignore -->
```rust
    if let Some(id) = id.as_ref().filter(|_| false) {
        sqlx::query(
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_is_answered_record_by_record_and_kept_once`, `a_batch_waiting_for_the_write_lock_sees_the_record_that_held_it`, `a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt`, `a_record_the_host_cannot_read_is_refused_and_the_others_are_applied`, `an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin`, `every_field_of_a_scan_is_checked_before_anything_is_written`, `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — хранится запись с нечитаемым id. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .and_then(Value::as_str)
        .filter(|id| validate::client_uuid("id", id).is_ok())
```

заменить на

<!-- prettier-ignore -->
```rust
        .and_then(Value::as_str)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_the_host_cannot_read_is_refused_and_the_others_are_applied`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — нет проверки входа в смену. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !entered {
        return Ok(Some(None));
```

заменить на

<!-- prettier-ignore -->
```rust
    if !entered && false {
        return Ok(Some(None));
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_names_a_shift_the_device_entered_and_a_batch_holds_1_to_100`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — operatorId не проверяется. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ("shiftId", Some(record.shift_id.as_str())),
        ("operatorId", record.operator_id.as_deref()),
```

заменить на

<!-- prettier-ignore -->
```rust
        ("shiftId", Some(record.shift_id.as_str())),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `every_field_of_a_scan_is_checked_before_anything_is_written`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — вид записи не хранится в квитанции. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .bind(applying.kind.map(FactKind::as_str))
```

заменить на

<!-- prettier-ignore -->
```rust
        .bind(None::<&str>)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt`, `a_record_the_host_cannot_read_is_refused_and_the_others_are_applied`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — сохранённая квитанция теряет details. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
                details: details
                    .map(|details| serde_json::from_str(&details))
                    .transpose()
                    .map_err(ApiError::internal)?,
```

заменить на

<!-- prettier-ignore -->
```rust
                details: details.and(None),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_the_host_cannot_read_is_refused_and_the_others_are_applied`, `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — rawKind принятого скана не проверяется. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if invalid == (scan.raw_kind == ScanRawKind::Km) {
```

заменить на

<!-- prettier-ignore -->
```rust
    if invalid && scan.raw_kind == ScanRawKind::Km {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `every_field_of_a_scan_is_checked_before_anything_is_written`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — GTIN снимка не сверяется. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if code.gtin14 != context.shift.gtin14 {
```

заменить на

<!-- prettier-ignore -->
```rust
            if code.gtin14 != context.shift.gtin14 && false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt`, `an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — скан в закрытый короб. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
                Some(found) if found.closed_at.is_some() => {
```

заменить на

<!-- prettier-ignore -->
```rust
                Some(found) if found.closed_at.is_some() && false => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin`. Восстановить файл, `cmp` молчит, хеш прежний.

М12 — серия из 64 байт отвергается. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if !(1..=MAX_SERIAL_BYTES).contains(&code.serial.len())
```

заменить на

<!-- prettier-ignore -->
```rust
        if !(1..MAX_SERIAL_BYTES).contains(&code.serial.len())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `every_field_of_a_scan_is_checked_before_anything_is_written`. Восстановить файл, `cmp` молчит, хеш прежний.

М13 — канонический код считается в символах. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if !(1..=MAX_CANONICAL_BYTES).contains(&code.canonical.len())
```

заменить на

<!-- prettier-ignore -->
```rust
        if !(1..=MAX_CANONICAL_BYTES).contains(&code.canonical.chars().count())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `every_field_of_a_scan_is_checked_before_anything_is_written`. Восстановить файл, `cmp` молчит, хеш прежний.

М14 — короб открыт временем хоста. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
                    .bind(&scan.scanned_at)
                    .bind(context.received_at)
                    .execute(&mut *conn)
```

заменить на

<!-- prettier-ignore -->
```rust
                    .bind(context.received_at)
                    .bind(context.received_at)
                    .execute(&mut *conn)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_is_answered_record_by_record_and_kept_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М15 — оператор скана теряется. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(context.operator_id)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(None::<&str>)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_is_answered_record_by_record_and_kept_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М16 — короб другого устройства в той же смене. В `apps/standalone/host/src/facts/boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if shift_id != context.shift.id || device_id != context.device_id =>
```

заменить на

<!-- prettier-ignore -->
```rust
            if shift_id != context.shift.id =>
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin`. Восстановить файл, `cmp` молчит, хеш прежний.

М17 — скан в тот же момент вытесняет владельца. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(owner) if claim.scanned_at >= owner.scanned_at.as_str() => {
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(owner) if claim.scanned_at > owner.scanned_at.as_str() => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М18 — вытесненная позиция остаётся в коробе. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .bind(context.received_at)
            .bind(&owner.scan_id)
```

заменить на

<!-- prettier-ignore -->
```rust
            .bind(None::<&str>)
            .bind(&owner.scan_id)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М19 — победитель и проигравший переставлены. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
                &owner.scan_id,
                claim.scan_id,
                context.received_at,
```

заменить на

<!-- prettier-ignore -->
```rust
                claim.scan_id,
                &owner.scan_id,
                context.received_at,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М20 — sameDevice наоборот. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
            same_device: self.device_id == device_id,
```

заменить на

<!-- prettier-ignore -->
```rust
            same_device: self.device_id != device_id,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`. Восстановить файл, `cmp` молчит, хеш прежний.

М21 — отложенная транзакция. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_waiting_for_the_write_lock_sees_the_record_that_held_it`. Восстановить файл, `cmp` молчит, хеш прежний.

М22 — устройство не перечитывается. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
    // A device revoked while the batch waited for the lock sends nothing.
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_device_revoked_meanwhile_keeps_nothing`. Восстановить файл, `cmp` молчит, хеш прежний.

М23 — перечитывание не видит отзыва. В `apps/standalone/host/src/auth.rs` фрагмент

<!-- prettier-ignore -->
```rust
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
```

заменить на

<!-- prettier-ignore -->
```rust
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ?")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_device_revoked_meanwhile_keeps_nothing`. Восстановить файл, `cmp` молчит, хеш прежний.

М24 — пачка из 100 записей отвергается. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
```

заменить на

<!-- prettier-ignore -->
```rust
    if !(1..MAX_RECORDS).contains(&batch.records.len()) {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_record_names_a_shift_the_device_entered_and_a_batch_holds_1_to_100`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request.json apps/standalone/proto/fixtures/facts-response.json`; `git diff --check`
Expected: чисто.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --locked`
Expected: PASS — 32 набора, 380 тестов, без предупреждений компилятора (прежние наборы не задеты: помощники `support::app` только добавлены).

```bash
git add apps/standalone/host/migrations/0010_facts.sql apps/standalone/host/src/auth.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/boxes.rs apps/standalone/host/src/facts/registry.rs apps/standalone/host/src/facts/scan.rs apps/standalone/host/src/routes/facts.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request.json apps/standalone/proto/fixtures/facts-response.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): facts in batches with a receipt per record, scans and the registry of codes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Проверка кода — `GET /v1/device/codes/{codeHash}`

Станция перед приёмом скана, пока связь `online`, спрашивает хост с пределом 300 мс (планы 2a4 и 2a6). Хост читает реестр задачи 2 на соединении пула вне транзакции записи — WAL не заставляет чтение ждать писателя, поэтому проверка не стоит за пачкой фактов, которая пишется в этот момент, и отвечает тем, что было зафиксировано до неё. Тест этого детерминирован: тест держит блокировку записи с незафиксированным сканом, обработчик, вызванный напрямую, должен ответить за секунду «свободен»; под мутантом с `begin_write` он ждал бы `busy_timeout` (5 с). `sameDevice` говорит станции, что код её собственный.

**Files:**

- Create: `apps/standalone/host/src/routes/codes.rs`, `apps/standalone/proto/fixtures/{code-check-free,code-check-taken}.json`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/proto/src/lib.rs` (`CodeCheck`)
- Test: `apps/standalone/host/tests/codes.rs` (Create), `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `registry::{owner, Owner::to_wire}`, `rules::is_code_hash`, `CodeOwner` (задачи 1–2).
- Produces: `pub enum markiro_proto::CodeCheck { Free, Taken { owner: CodeOwner } }` (`#[serde(tag = "status")]`); `pub async fn markiro_host::routes::codes::check_code(State<AppState>, AuthDevice, ApiPath<String>) -> Result<Json<CodeCheck>, ApiError>`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. Создать `apps/standalone/host/tests/codes.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::error::ApiPath;
use markiro_host::routes::codes::check_code;
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code_hash, empty, fact, fact_rows, host_revision, instant,
    ok_scan, open_floor, pair_device, receipts, record_id, request, shift_setup, with_device,
    Admin,
};

/// `GET /v1/device/codes/{hash}` with `key`.
async fn check(admin: &Admin, key: &str, hash: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{hash}")),
            key,
        )))
        .await
}

#[tokio::test]
async fn a_code_is_free_until_a_scan_owns_it_and_then_names_its_owner() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(10, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let owner = |same_device: bool| {
        json!({
            "status": "taken",
            "owner": {
                "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
                "scannedAt": instant(10, 0), "sameDevice": same_device
            }
        })
    };
    // The owner itself, another station and a device of another kind ask.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (StatusCode::OK, owner(true))
    );
    assert_eq!(
        check(&admin, &colleague.key, &code_hash(1)).await,
        (StatusCode::OK, owner(false))
    );
    assert_eq!(
        check(&admin, &office_pc, &code_hash(1)).await,
        (StatusCode::OK, owner(false))
    );
    assert_eq!(
        check(&admin, &floor.key, &code_hash(2)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    // Asking writes nothing.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(fact_rows(&admin.app).await, kept);
    // An earlier scan of the colleague takes the code: it names the
    // colleague now.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[fact(
                &record_id(2),
                "scan",
                &colleague.shift,
                ok_scan(1, &box_id(2), &instant(5, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (
            StatusCode::OK,
            json!({
                "status": "taken",
                "owner": {
                    "shiftId": colleague.shift, "shiftNumber": colleague.number,
                    "deviceId": colleague.station, "scannedAt": instant(5, 0),
                    "sameDevice": false
                }
            })
        )
    );
}

#[tokio::test]
async fn only_a_code_hash_is_asked_for_and_only_by_a_device() {
    let admin = admin().await;
    for hash in [
        code_hash(1).to_uppercase().replace('0', "A"),
        "0".repeat(63),
        "0".repeat(65),
        format!("{}g", "0".repeat(63)),
        "OCT26-001".to_owned(),
    ] {
        let (status, refused) = check(&admin, &admin.key, &hash).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!({ "field": "codeHash" })
            ),
            "{hash}"
        );
    }
    let (status, refused) = admin
        .app
        .send(empty(request(
            "GET",
            &format!("/v1/device/codes/{}", code_hash(1)),
        )))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

/// The check takes no write lock: it answers at once while a batch of facts
/// is being written, with what was committed before it.
#[tokio::test]
async fn a_check_never_waits_for_a_batch_being_written() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let station = floor.station.clone();
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let applied = markiro_host::facts::receive(
        &mut holder,
        &station,
        &fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        &admin.app.state.timestamp(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(applied).unwrap(),
        accepted(&record_id(1))
    );
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        check_code(
            State(admin.app.state.clone()),
            AuthDevice {
                id: station.clone(),
                kind: DeviceKind::Station,
            },
            ApiPath(code_hash(1)),
        ),
    )
    .await
    .expect("the check waited for the writer")
    .unwrap()
    .into_response();
    let body: Value =
        serde_json::from_slice(&answer.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body, json!({ "status": "free" }));
    holder.commit().await.unwrap();
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await.1["status"],
        "taken"
    );
}
```

2. Создать `apps/standalone/proto/fixtures/code-check-free.json`:

<!-- prettier-ignore -->
```json
{
  "status": "free"
}
```

3. Создать `apps/standalone/proto/fixtures/code-check-taken.json`:

<!-- prettier-ignore -->
```json
{
  "status": "taken",
  "owner": {
    "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "shiftNumber": "OCT26-003",
    "deviceId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    "scannedAt": "2026-10-08T05:58:41.090Z",
    "sameDevice": false
  }
}
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeOwner,
    Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo,
    DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts,
    DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeCheck,
    CodeOwner, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate,
    DeviceShifts, DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome, FactReceipts, Hello,
    HelloEnvelope, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<FactBatch>(value).is_err());
    assert_eq!(receipts.receipts[3].id, None);
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(serde_json::from_value::<FactBatch>(value).is_err());
    assert_eq!(receipts.receipts[3].id, None);
}

/// A code is free, or taken by its owner; the owner a `conflict` receipt
/// names has the same shape.
#[test]
fn code_check_fixtures_round_trip_and_name_the_owner_as_a_conflict_does() {
    let free: CodeCheck = round_trip("code-check-free.json");
    assert_eq!(free, CodeCheck::Free);
    let taken: CodeCheck = round_trip("code-check-taken.json");
    let receipts: FactReceipts = serde_json::from_value(fixture("facts-response.json")).unwrap();
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert_eq!(taken, CodeCheck::Taken { owner: winner });
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test codes --offline --locked`
Expected: FAIL — компиляция: error[E0432]: unresolved import `markiro_host::routes::codes`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/routes/codes.rs`:

<!-- prettier-ignore -->
```rust
//! `GET /v1/device/codes/{codeHash}` (stage 2a spec §4.6): whether an
//! accepted scan owns a code, and which. Any device may ask. It reads the
//! registry outside any write transaction, so it never waits for a batch of
//! facts being written: a station asks within 300 ms.

use axum::extract::State;
use axum::Json;
use markiro_proto::CodeCheck;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiPath};
use crate::facts::{registry, rules};
use crate::server::AppState;

pub async fn check_code(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(code_hash): ApiPath<String>,
) -> Result<Json<CodeCheck>, ApiError> {
    if !rules::is_code_hash(&code_hash) {
        return Err(ApiError::validation(
            "codeHash",
            "64 lower-case hex digits are required",
        ));
    }
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    Ok(Json(match registry::owner(&mut conn, &code_hash).await? {
        Some(owner) => CodeCheck::Taken {
            owner: owner.to_wire(&device.id),
        },
        None => CodeCheck::Free,
    }))
}
```

2. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust

pub mod bootstrap;
pub mod changes;
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
```

заменить на

<!-- prettier-ignore -->
```rust

pub mod bootstrap;
pub mod changes;
pub mod codes;
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/facts",
            post(crate::routes::facts::receive_facts),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/facts",
            post(crate::routes::facts::receive_facts),
        )
        .route(
            "/v1/device/codes/{code_hash}",
            get(crate::routes::codes::check_code),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub same_device: bool,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub same_device: bool,
}

/// `GET /v1/device/codes/{codeHash}` (stage 2a spec §4.6): whether an
/// accepted scan owns the code. A station asks while the link is `online`,
/// within 300 ms; without an answer it accepts the scan on its own copy, and
/// a duplicate shows later as a `conflict` receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodeCheck {
    Free,
    Taken { owner: CodeOwner },
}

#[cfg(test)]
mod tests {
    use super::{
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test codes --offline --locked`
Expected: PASS — 3 теста.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
is the sender's own scan). Both write a `code_conflicts` row; telling the
displaced device and the office's review come with plan 2b.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
is the sender's own scan). Both write a `code_conflicts` row; telling the
displaced device and the office's review come with plan 2b.

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
`routes/codes.rs`; 64 lower-case hex digits, `validation_failed` on
`codeHash` otherwise): `{ status: "free" }` or `{ status: "taken", owner }`
with the same `CodeOwner` a `conflict` names. It reads the registry on a
pooled connection outside any write transaction, so it never waits for a
batch being written — a station asks within 300 ms (plan 2a6) — and it
writes nothing.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — путь не проверяется. В `apps/standalone/host/src/routes/codes.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !rules::is_code_hash(&code_hash) {
```

заменить на

<!-- prettier-ignore -->
```rust
    if code_hash.is_empty() {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test codes --offline --locked`
Expected: FAIL `only_a_code_hash_is_asked_for_and_only_by_a_device`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — проверка берёт блокировку записи. В `apps/standalone/host/src/routes/codes.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let mut conn = crate::db::begin_write(&state.pool).await.map_err(ApiError::internal)?;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test codes --offline --locked`
Expected: FAIL `a_check_never_waits_for_a_batch_being_written`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — спрашивающий не учитывается. В `apps/standalone/host/src/routes/codes.rs` фрагмент

<!-- prettier-ignore -->
```rust
            owner: owner.to_wire(&device.id),
```

заменить на

<!-- prettier-ignore -->
```rust
            owner: owner.to_wire(""),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test codes --offline --locked`
Expected: FAIL `a_code_is_free_until_a_scan_owns_it_and_then_names_its_owner`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/code-check-free.json apps/standalone/proto/fixtures/code-check-taken.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/routes/codes.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/codes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/code-check-free.json apps/standalone/proto/fixtures/code-check-taken.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a device asks the host whether a code is taken" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `box_closed` — SSCC по блоку этого устройства, `consumed_through`, сверка дайджеста

Короб закрывает станция номером из блока, который хост выдал именно ей (2a1). Хост проверяет форму SSCC (18 цифр), первые 17 цифр — расширение `0`, префикс снимка и серия (контрольную цифру не считает: правило домена), серию — в неотозванном блоке этого устройства для этого префикса (`sscc_not_issued`), и что SSCC не носит другой короб (`sscc_taken`, за ним — уникальный индекс). Тот же SSCC у уже закрытого короба — повтор того же закрытия под другим `id` (принято, ничего не пишется), другой — `box_already_closed`. Закрытие поднимает `consumed_through` блока до наибольшей закрытой серии (короба закрываются не по порядку) и сверяет дайджест станции с дайджестом живых позиций хоста: расхождение ничего не отвергает, а запоминается для карточки этапа 4.

**Files:**

- Create: `apps/standalone/host/src/facts/box_closed.rs`
- Modify: `apps/standalone/host/src/facts/mod.rs`, `apps/standalone/proto/src/lib.rs` (`FactKind::BoxClosed`, `BoxClosedFact`), `apps/standalone/proto/fixtures/facts-request.json`
- Test: `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `boxes::find`, `rules::{device_instant, is_code_hash, box_membership_digest}`, `validate::serial_capacity`, блоки `sscc_blocks` (2a1).
- Produces: `FactKind::BoxClosed` (`"box_closed"`); `markiro_proto::BoxClosedFact { box_id, sscc, block_id, serial: u64, opened_at, closed_at, item_count: u32, membership_digest }`; помощники тестов `support::app::{issue_block(app, key, request_id) -> Value, sscc(serial) -> String, members_digest(&[u32]) -> String, box_closed(box_id, block, serial, members, opened_at, closed_at) -> Value}`.

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code, code_hash, fact, fact_rows, host_revision, instant,
    ok_scan, open_floor, pair_device, plan_shift, receipts, record_id, rejected, request,
    send_facts, shift_body, shift_setup, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, code, code_hash, fact, fact_rows,
    host_revision, instant, issue_block, members_digest, ok_scan, open_floor, pair_device,
    plan_shift, receipts, record_id, rejected, request, send_facts, shift_body, shift_setup, sscc,
    with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
```

2. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
    assert_eq!(fact_rows(&admin.app).await, kept);
}
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    assert_eq!(fact_rows(&admin.app).await, kept);
}

/// A box as the host keeps it: `(opened, closed, SSCC, block, serial, count
/// reported, digest reported, digest matches, operator)`.
async fn box_row(admin: &Admin, id: &str) -> Value {
    type BoxRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<bool>,
        Option<String>,
    );
    let row: BoxRow = sqlx::query_as(
        "SELECT opened_at, closed_at, sscc, block_id, serial, item_count_reported, \
         membership_digest, digest_matches, operator_id FROM boxes WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8])
}

/// How far the station used its block, as the host knows it.
async fn consumed_through(admin: &Admin, block: &Value) -> Option<i64> {
    sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
        .bind(block["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

#[tokio::test]
async fn a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    // Box 1 holds codes 1 and 2, box 2 code 3, box 3 codes 5 and 6.
    let scans: Vec<Value> = [(1, 1), (2, 1), (3, 2), (5, 3), (6, 3)]
        .into_iter()
        .map(|(n, box_n)| {
            fact(
                &record_id(n),
                "scan",
                shift,
                ok_scan(n, &box_id(box_n), &instant(n, 0)),
            )
        })
        .collect();
    receipts(&admin.app, &floor.key, &scans).await;
    // The colleague scanned code 6 earlier: it leaves box 3.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[fact(
                &record_id(9),
                "scan",
                &colleague.shift,
                ok_scan(6, &box_id(9), &instant(0, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(9))]
    );
    let mut first = fact(
        &record_id(11),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2],
            &instant(0, 500),
            &instant(20, 0),
        ),
    );
    first["operatorId"] = json!(OPERATOR);
    let batch = vec![
        first,
        // Closed later, but with the next serial but one.
        fact(
            &record_id(12),
            "box_closed",
            shift,
            box_closed(
                &box_id(2),
                &block,
                1502,
                &[3],
                &instant(3, 0),
                &instant(21, 0),
            ),
        ),
        // The station still counts code 6 in box 3: the digests differ.
        fact(
            &record_id(13),
            "box_closed",
            shift,
            box_closed(
                &box_id(3),
                &block,
                1501,
                &[5, 6],
                &instant(5, 0),
                &instant(22, 0),
            ),
        ),
    ];
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(11)),
            accepted(&record_id(12)),
            accepted(&record_id(13))
        ]
    );
    let block_id = block["id"].clone();
    assert_eq!(
        box_row(&admin, &box_id(1)).await,
        json!([
            instant(0, 500),
            instant(20, 0),
            sscc(1500),
            block_id,
            1500,
            2,
            members_digest(&[1, 2]),
            true,
            OPERATOR
        ])
    );
    assert_eq!(
        box_row(&admin, &box_id(2)).await,
        json!([
            instant(3, 0),
            instant(21, 0),
            sscc(1502),
            block_id,
            1502,
            1,
            members_digest(&[3]),
            true,
            null
        ])
    );
    assert_eq!(
        box_row(&admin, &box_id(3)).await,
        json!([
            instant(5, 0),
            instant(22, 0),
            sscc(1501),
            block_id,
            1501,
            2,
            members_digest(&[5, 6]),
            false,
            null
        ])
    );
    // The block is used as far as its highest closed serial, whatever order
    // the boxes closed in.
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
    // A close takes no revision and writes no audit row.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // The same close under another id changes nothing; another SSCC for a
    // closed box is refused.
    let kept = fact_rows(&admin.app).await;
    let again = fact(
        &record_id(14),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2],
            &instant(0, 500),
            &instant(20, 0),
        ),
    );
    let other = fact(
        &record_id(15),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1503,
            &[1, 2],
            &instant(0, 500),
            &instant(23, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[again, other]).await,
        vec![
            accepted(&record_id(14)),
            rejected(Some(&record_id(15)), "box_already_closed", None)
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, grown);
    assert_eq!(box_row(&admin, &box_id(1)).await[1], json!(instant(20, 0)));
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
}

#[tokio::test]
async fn a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let theirs = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    let revoked = issue_block(
        &admin.app,
        &floor.key,
        "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    )
    .await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(revoked["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(1, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(2, &box_id(2), &instant(2, 0)),
            ),
        ],
    )
    .await;
    let close = |n: u32, data: Value| fact(&record_id(n), "box_closed", shift, data);
    let data = |serial: u64| {
        box_closed(
            &box_id(1),
            &block,
            serial,
            &[1],
            &instant(1, 0),
            &instant(30, 0),
        )
    };
    let with = |field: &str, value: Value| {
        let mut data = data(1500);
        data[field] = value;
        data
    };
    let mut other_prefix = data(1500);
    other_prefix["sscc"] = json!("046012340000015004");
    let mut pallet = data(1500);
    pallet["sscc"] = json!("146006820000015007");
    let mut wrong_serial = data(1500);
    wrong_serial["serial"] = json!(1501);
    // A serial of the colleague's block (3500–5499) and of the revoked one
    // (5500–7499).
    let mut colleagues_block = data(3500);
    colleagues_block["blockId"] = theirs["id"].clone();
    let mut unknown_block = data(1500);
    unknown_block["blockId"] = json!("6f5e4d3c-2b1a-4098-8765-43210fedcba9");
    let mut revoked_block = data(5500);
    revoked_block["blockId"] = revoked["id"].clone();
    let batch = vec![
        close(
            10,
            box_closed(
                &box_id(7),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(30, 0),
            ),
        ),
        close(11, with("sscc", json!("04600682000001500"))),
        close(12, with("sscc", json!("04600682000001500A"))),
        close(13, with("blockId", json!("block"))),
        close(14, with("openedAt", json!("2026-10-08T06:00:01Z"))),
        close(15, with("closedAt", json!("today"))),
        close(16, with("itemCount", json!(0))),
        close(17, with("membershipDigest", json!("digest"))),
        close(18, with("serial", json!(-1))),
        close(19, other_prefix),
        close(20, pallet),
        close(21, wrong_serial),
        close(22, data(1499)),
        close(23, data(3500)),
        close(24, colleagues_block),
        close(25, unknown_block),
        close(26, revoked_block),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(10)), "box_unknown", None),
            rejected(Some(&record_id(11)), "invalid_record", Some("data.sscc")),
            rejected(Some(&record_id(12)), "invalid_record", Some("data.sscc")),
            rejected(Some(&record_id(13)), "invalid_record", Some("data.blockId")),
            rejected(
                Some(&record_id(14)),
                "invalid_record",
                Some("data.openedAt")
            ),
            rejected(
                Some(&record_id(15)),
                "invalid_record",
                Some("data.closedAt")
            ),
            rejected(
                Some(&record_id(16)),
                "invalid_record",
                Some("data.itemCount")
            ),
            rejected(
                Some(&record_id(17)),
                "invalid_record",
                Some("data.membershipDigest")
            ),
            rejected(Some(&record_id(18)), "invalid_record", Some("data")),
            rejected(Some(&record_id(19)), "sscc_not_issued", None),
            rejected(Some(&record_id(20)), "sscc_not_issued", None),
            rejected(Some(&record_id(21)), "sscc_not_issued", None),
            rejected(Some(&record_id(22)), "sscc_not_issued", None),
            rejected(Some(&record_id(23)), "sscc_not_issued", None),
            rejected(Some(&record_id(24)), "sscc_not_issued", None),
            rejected(Some(&record_id(25)), "sscc_not_issued", None),
            rejected(Some(&record_id(26)), "sscc_not_issued", None),
        ]
    );
    // Nothing was closed and no block moved.
    assert_eq!(box_row(&admin, &box_id(1)).await[1], Value::Null);
    assert_eq!(consumed_through(&admin, &block).await, None);
    assert_eq!(consumed_through(&admin, &revoked).await, None);
    // The block's first and last serials close boxes; a serial another box
    // carries is taken.
    let last = box_closed(
        &box_id(2),
        &block,
        3499,
        &[2],
        &instant(2, 0),
        &instant(31, 0),
    );
    let mut taken = last.clone();
    taken["boxId"] = json!(box_id(1));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close(30, data(1500)), close(31, last), close(32, taken)]
        )
        .await,
        vec![
            accepted(&record_id(30)),
            accepted(&record_id(31)),
            rejected(Some(&record_id(32)), "box_already_closed", None),
        ]
    );
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(3),
            "scan",
            shift,
            ok_scan(3, &box_id(3), &instant(3, 0)),
        )],
    )
    .await;
    let mut taken = box_closed(
        &box_id(3),
        &block,
        3499,
        &[3],
        &instant(3, 0),
        &instant(32, 0),
    );
    taken["sscc"] = json!(sscc(3499));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close(33, taken)]).await,
        vec![rejected(Some(&record_id(33)), "sscc_taken", None)]
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(3499));
    assert_eq!(box_row(&admin, &box_id(3)).await[1], Value::Null);
}
```

3. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
    Value::Object(counts)
}
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    Value::Object(counts)
}

/// A block of SSCC serials the station of `key` gets for request
/// `request_id` (a canonical UUID); the wizard's box counter starts at 1500
/// and a block is 2000 serials, so the first block is 1500–3499.
pub async fn issue_block(app: &TestApp, key: &str, request_id: &str) -> Value {
    let (status, block) = app
        .send(json(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            serde_json::json!({
                "requestId": request_id, "issuerPrefix": "460068200", "extension": 0
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

/// The SSCC of box serial `serial` under the wizard's prefix, with its GS1
/// check digit (the host never checks it; the domain's `buildSscc` writes
/// it).
pub fn sscc(serial: u64) -> String {
    let body = format!("0460068200{serial:07}");
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(place, digit)| u32::from(digit - b'0') * if place % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

/// The domain's digest of the codes `members` (`code_hash(n)` each).
pub fn members_digest(members: &[u32]) -> String {
    let hashes: Vec<String> = members.iter().map(|n| code_hash(*n)).collect();
    markiro_host::facts::rules::box_membership_digest(&hashes)
}

/// The `data` of a box closed at `closed_at` with serial `serial` of
/// `block`, holding the codes `members` as the station saw them.
pub fn box_closed(
    box_id: &str,
    block: &Value,
    serial: u64,
    members: &[u32],
    opened_at: &str,
    closed_at: &str,
) -> Value {
    serde_json::json!({
        "boxId": box_id, "sscc": sscc(serial), "blockId": block["id"], "serial": serial,
        "openedAt": opened_at, "closedAt": closed_at, "itemCount": members.len(),
        "membershipDigest": members_digest(members)
    })
}
```

4. В `apps/standalone/proto/fixtures/facts-request.json` фрагмент

<!-- prettier-ignore -->
```json
        "code": null,
        "boxId": null
      }
    }
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
        "code": null,
        "boxId": null
      }
    },
    {
      "id": "7a4f0c2d-5e3b-4f9a-8c6d-2e4f6a8b0c32",
      "kind": "box_closed",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "boxId": "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "sscc": "046006820000015000",
        "blockId": "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        "serial": 1500,
        "openedAt": "2026-10-08T06:15:02.418Z",
        "closedAt": "2026-10-08T06:21:47.302Z",
        "itemCount": 12,
        "membershipDigest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e"
      }
    }
  ]
}
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![FactKind::Scan];
        for kind in &kinds {
            match kind {
                FactKind::Scan => {}
            }
        }
        kinds
```

заменить на

<!-- prettier-ignore -->
```rust

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![FactKind::Scan, FactKind::BoxClosed];
        for kind in &kinds {
            match kind {
                FactKind::Scan | FactKind::BoxClosed => {}
            }
        }
        kinds
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeCheck,
    CodeOwner, Compatibility, CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate,
    DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate,
    DeviceShifts, DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome, FactReceipts, Hello,
    HelloEnvelope, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, CategoryTemplateDefault, ChangesResponse, ClaimRequest,
    CodeCheck, CodeOwner, Compatibility, CounterpartyCreate, CounterpartyRecord,
    CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift,
    DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome,
    FactReceipts, Hello, HelloEnvelope, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord,
    LabelTemplateSummary, LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate,
    LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole,
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ScanFact, ScanRawKind, ScanVerdict, ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin,
    ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
fn fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(kinds, vec![FactKind::Scan, FactKind::Scan]);
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
        };
        assert_eq!(typed, record.data, "{}", record.id);
    }
    let accepted: ScanFact = typed(&batch.records[0].data);
    assert_eq!(
        (accepted.verdict, accepted.raw_kind),
        (ScanVerdict::Ok, ScanRawKind::Km)
```

заменить на

<!-- prettier-ignore -->
```rust
fn fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![FactKind::Scan, FactKind::Scan, FactKind::BoxClosed]
    );
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
            FactKind::BoxClosed => {
                serde_json::to_value(typed::<BoxClosedFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
    }
    let accepted: ScanFact = typed(&batch.records[0].data);
    let accepted_box = accepted.box_id.clone().unwrap();
    assert_eq!(
        (accepted.verdict, accepted.raw_kind),
        (ScanVerdict::Ok, ScanRawKind::Km)
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (invalid.verdict, invalid.code, invalid.box_id),
        (ScanVerdict::Invalid, None, None)
    );
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

заменить на

<!-- prettier-ignore -->
```rust
        (invalid.verdict, invalid.code, invalid.box_id),
        (ScanVerdict::Invalid, None, None)
    );
    // The box the accepted scan went into, closed with the SSCC of the
    // first serial of `sscc-block.json`'s block.
    let closed: BoxClosedFact = typed(&batch.records[2].data);
    let block: SsccBlock = serde_json::from_value(fixture("sscc-block.json")).unwrap();
    assert_eq!(
        (&closed.box_id, &closed.block_id, closed.serial),
        (&accepted_box, &block.id, block.from_serial)
    );
    assert!(closed
        .sscc
        .starts_with(&format!("0{}", block.issuer_prefix)));
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL — 10 тестов проходят, падают `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared` и `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`: вид `box_closed` хосту ещё незнаком, и каждая такая запись получает `invalid_record` без поля.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/facts/box_closed.rs`:

<!-- prettier-ignore -->
```rust
//! `box_closed` facts: a station closed a box with an SSCC of a block the
//! host issued to it. The host checks the SSCC by its form and its block,
//! never its check digit (a marking rule, the domain's); it raises the
//! block's `consumed_through` and compares the station's digest of the box's
//! members with its own items, keeping the result for the shift's card
//! (stage 4).

use markiro_proto::{receipt_codes, BoxClosedFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a closed box have the shape the station gives them.
fn check(closed: &BoxClosedFact) -> Result<(), Reject> {
    for (field, id) in [
        ("data.boxId", &closed.box_id),
        ("data.blockId", &closed.block_id),
    ] {
        if validate::client_uuid(field, id).is_err() {
            return Err(Reject::field(field));
        }
    }
    for (field, at) in [
        ("data.openedAt", &closed.opened_at),
        ("data.closedAt", &closed.closed_at),
    ] {
        if rules::device_instant(at).is_none() {
            return Err(Reject::field(field));
        }
    }
    if closed.sscc.len() != 18 || !closed.sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.sscc"));
    }
    if closed.item_count == 0 {
        return Err(Reject::field("data.itemCount"));
    }
    if !rules::is_code_hash(&closed.membership_digest) {
        return Err(Reject::field("data.membershipDigest"));
    }
    Ok(())
}

/// The SSCC is the box extension's, of the snapshot's prefix and of
/// `serial`, whatever its check digit: the first 17 digits are
/// `0`, the prefix and the serial padded to the prefix's serial width.
fn names_serial(sscc: &str, issuer_prefix: &str, serial: u64) -> bool {
    let width = 16 - issuer_prefix.len();
    serial < validate::serial_capacity(issuer_prefix)
        && sscc[..17] == format!("0{issuer_prefix}{serial:0width$}")
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: BoxClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&closed)?;
    let serial = i64::try_from(closed.serial).map_err(|_| Reject::field("data.serial"))?;
    let found = boxes::find(&mut *conn, context, &closed.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if let Some(sscc) = &found.sscc {
        // The same close sent again under another id changes nothing.
        return if *sscc == closed.sscc {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::BOX_ALREADY_CLOSED).into())
        };
    }
    if !names_serial(&closed.sscc, &context.shift.issuer_prefix, closed.serial) {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    let issued: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
         AND extension = 0 AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
    )
    .bind(&closed.block_id)
    .bind(context.device_id)
    .bind(&context.shift.issuer_prefix)
    .bind(serial)
    .bind(serial)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if issued.is_none() {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM boxes WHERE sscc = ?")
        .bind(&closed.sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT code_hash FROM box_items \
         WHERE box_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
    )
    .bind(&closed.box_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let matches = rules::box_membership_digest(&members) == closed.membership_digest;
    sqlx::query(
        "UPDATE boxes SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
         item_count_reported = ?, membership_digest = ?, digest_matches = ?, operator_id = ? \
         WHERE id = ?",
    )
    .bind(&closed.opened_at)
    .bind(&closed.closed_at)
    .bind(&closed.sscc)
    .bind(&closed.block_id)
    .bind(serial)
    .bind(closed.item_count)
    .bind(&closed.membership_digest)
    .bind(matches)
    .bind(context.operator_id)
    .bind(&closed.box_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_blocks SET consumed_through = max(coalesce(consumed_through, ?1), ?1) \
         WHERE id = ?2",
    )
    .bind(serial)
    .bind(&closed.block_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

2. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! database error is no receipt: it fails the whole batch, and the device
//! sends it again.

pub mod boxes;
pub mod registry;
pub mod rules;
```

заменить на

<!-- prettier-ignore -->
```rust
//! database error is no receipt: it fails the whole batch, and the device
//! sends it again.

pub mod box_closed;
pub mod boxes;
pub mod registry;
pub mod rules;
```

3. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    };
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
```

заменить на

<!-- prettier-ignore -->
```rust
    };
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Scan,
}

impl FactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FactKind::Scan => "scan",
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Scan,
    BoxClosed,
}

impl FactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FactKind::Scan => "scan",
            FactKind::BoxClosed => "box_closed",
        }
    }
}
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub raw_length: u32,
    pub code: Option<ScannedCode>,
    pub box_id: Option<String>,
}

/// How the host answered a record.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub raw_length: u32,
    pub code: Option<ScannedCode>,
    pub box_id: Option<String>,
}

/// `data` of a `box_closed` fact: a box closed with the SSCC of serial
/// `serial` from block `blockId`, which the host issued to this station.
/// `itemCount` and `membershipDigest` (the domain's `boxMembershipDigestV1`
/// of the box's code hashes) are what the station saw; the host compares the
/// digest with its own items and keeps the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxClosedFact {
    pub box_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub item_count: u32,
    pub membership_digest: String,
}

/// How the host answered a record.
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: PASS — 12 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
batch being written — a station asks within 300 ms (plan 2a6) — and it
writes nothing.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
batch being written — a station asks within 300 ms (plan 2a6) — and it
writes nothing.

A `box_closed` (`facts/box_closed.rs`) closes a box of this device in this
shift (`box_unknown` otherwise) with an SSCC of 18 digits whose first 17 are
the box extension `0`, the snapshot's issuer prefix and `serial` (the check
digit is the domain's, never checked here), where `serial` lies in the block
`blockId` that the host issued to this device for that prefix and did not
revoke (`sscc_not_issued`), and no other box carries the SSCC
(`sscc_taken`, backed by the unique index). A box already closed with the
same SSCC is the same close sent again (accepted, nothing written); with
another, `box_already_closed`. The close keeps the station's `openedAt`,
`closedAt`, count, digest and operator, raises the block's
`consumed_through` to the highest serial closed (boxes may close out of
order), and compares the station's `membershipDigest` with the digest of
the box's live items (neither removed nor displaced), keeping the result in
`digest_matches` for the shift's card (stage 4): a mismatch refuses
nothing.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — блок любого устройства. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
```

заменить на

<!-- prettier-ignore -->
```rust
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND (device_id = ? OR 1) AND issuer_prefix = ? \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — отозванный блок. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
```

заменить на

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial <= ? AND to_serial >= ?",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — первая серия блока не в блоке. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
```

заменить на

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial < ? AND to_serial >= ? AND revoked_at IS NULL",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — последняя серия блока не в блоке. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
```

заменить на

<!-- prettier-ignore -->
```rust
         AND extension = 0 AND from_serial <= ? AND to_serial > ? AND revoked_at IS NULL",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — префикс и расширение SSCC не сверяются. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        && sscc[..17] == format!("0{issuer_prefix}{serial:0width$}")
```

заменить на

<!-- prettier-ignore -->
```rust
        && sscc[10..17] == format!("{serial:0width$}")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — занятый SSCC. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if taken.is_some() {
```

заменить на

<!-- prettier-ignore -->
```rust
    if taken.is_some() && false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — consumed_through не максимум. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "UPDATE sscc_blocks SET consumed_through = max(coalesce(consumed_through, ?1), ?1) \
```

заменить на

<!-- prettier-ignore -->
```rust
        "UPDATE sscc_blocks SET consumed_through = ?1 \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — дайджест хоста с вытесненными. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
         WHERE box_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
```

заменить на

<!-- prettier-ignore -->
```rust
         WHERE box_id = ? AND removed_at IS NULL",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — повтор закрытия отвергается. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        return if *sscc == closed.sscc {
```

заменить на

<!-- prettier-ignore -->
```rust
        return if *sscc == closed.sscc && false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — openedAt станции не хранится. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(&closed.opened_at)
    .bind(&closed.closed_at)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(&closed.closed_at)
    .bind(&closed.closed_at)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — пустой короб. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if closed.item_count == 0 {
```

заменить на

<!-- prettier-ignore -->
```rust
    if closed.item_count == u32::MAX {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/box_closed.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a box closes with an SSCC of its device's block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `box_label` и `box_exception` — проверка этикетки, снятие кода, очистка, перепечатка, расформирование

Проверка этикетки (`verified`, `skipped`) пишет момент станции в закрытый короб. Исключения — четыре вида облака с полями вида, как облачная `box_exceptions_kind_payload_check`, но с кодами причин (решение 36): слова — только при `other`, обрезанные, 1–200 символов (`validate::exception_reason_text`: правило свободного текста живёт в `validate.rs`). `undo` и `clear` — открытый короб, `reprint` и `disassemble` — закрытый и не расформированный (`box_state`). Снятые позиции получают `removed_at` (момент станции), а их коды уходят из реестра (`registry::release`) и свободны для нового скана; расформирование ставит `disassembled_at`, SSCC остаётся занятым. `undo` кода, чей скан проиграл, ничего не снимает и хранится — иначе станция получила бы отказ, который ей нечем исправить.

**Files:**

- Create: `apps/standalone/host/src/facts/box_label.rs`, `apps/standalone/host/src/facts/exception.rs`
- Modify: `apps/standalone/host/src/facts/mod.rs`, `apps/standalone/host/src/facts/registry.rs` (`release`), `apps/standalone/host/src/validate.rs` (`exception_reason_text`), `apps/standalone/proto/src/lib.rs` (`FactKind::{BoxLabel, BoxException}`, `LabelOutcome`, `BoxLabelFact`, `ExceptionKind`, `BoxExceptionFact`), `apps/standalone/proto/fixtures/facts-request.json`
- Test: `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `boxes::find`, `rules::{device_instant, is_code_hash}`, `exception_reasons` (задача 1), `validate::client_uuid`.
- Produces: `FactKind::BoxLabel` (`"box_label"`), `FactKind::BoxException` (`"box_exception"`); `markiro_proto::{LabelOutcome { Verified, Skipped }, BoxLabelFact { box_id, outcome, at }, ExceptionKind { Undo, Clear, Reprint, Disassemble } (as_str), BoxExceptionFact { exception, box_id, code_hash, target_scanned_at, reason_code, reason_text, occurred_at }}`; `pub async fn markiro_host::facts::registry::release(conn, scan_id: &str) -> Result<(), ApiError>`; `pub fn markiro_host::validate::exception_reason_text(field, text) -> Result<String, ApiError>`; помощник тестов `support::app::box_exception(kind, box_id, at) -> Value`.

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, code, code_hash, fact, fact_rows,
    host_revision, instant, issue_block, members_digest, ok_scan, open_floor, pair_device,
    plan_shift, receipts, record_id, rejected, request, send_facts, shift_body, shift_setup, sscc,
    with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_exception, box_id, code, code_hash, fact,
    fact_rows, host_revision, instant, issue_block, members_digest, ok_scan, open_floor,
    pair_device, plan_shift, receipts, record_id, rejected, request, send_facts, shift_body,
    shift_setup, sscc, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
```

2. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(consumed_through(&admin, &block).await, Some(3499));
    assert_eq!(box_row(&admin, &box_id(3)).await[1], Value::Null);
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(consumed_through(&admin, &block).await, Some(3499));
    assert_eq!(box_row(&admin, &box_id(3)).await[1], Value::Null);
}

/// A box's label checks: `(verified at, skipped at)`.
async fn label_checks(admin: &Admin, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT print_verified_at, print_skipped_at FROM boxes WHERE id = ?")
        .bind(id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_label_check_marks_a_closed_box_of_its_own() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(1, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(2, &box_id(2), &instant(2, 0)),
            ),
            fact(
                &record_id(3),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1],
                    &instant(1, 0),
                    &instant(10, 0),
                ),
            ),
        ],
    )
    .await;
    let label = |n: u32, box_n: u32, outcome: &str, at: &str| {
        fact(
            &record_id(n),
            "box_label",
            shift,
            json!({ "boxId": box_id(box_n), "outcome": outcome, "at": at }),
        )
    };
    let kept = fact_rows(&admin.app).await;
    let refused = vec![
        label(10, 2, "verified", &instant(11, 0)),
        label(11, 9, "verified", &instant(11, 0)),
        label(12, 1, "printed", &instant(11, 0)),
        label(13, 1, "verified", "2026-10-08T06:00:11Z"),
        fact(
            &record_id(14),
            "box_label",
            shift,
            json!({ "boxId": "box", "outcome": "verified", "at": instant(11, 0) }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(Some(&record_id(10)), "box_state", None),
            rejected(Some(&record_id(11)), "box_unknown", None),
            rejected(Some(&record_id(12)), "invalid_record", Some("data")),
            rejected(Some(&record_id(13)), "invalid_record", Some("data.at")),
            rejected(Some(&record_id(14)), "invalid_record", Some("data.boxId")),
        ]
    );
    assert_eq!(label_checks(&admin, &box_id(1)).await, (None, None));
    assert_eq!(label_checks(&admin, &box_id(2)).await, (None, None));
    // A skip, then (after a reprint) a check that matched.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                label(20, 1, "skipped", &instant(12, 0)),
                label(21, 1, "verified", &instant(13, 0))
            ]
        )
        .await,
        vec![accepted(&record_id(20)), accepted(&record_id(21))]
    );
    assert_eq!(
        label_checks(&admin, &box_id(1)).await,
        (Some(instant(13, 0)), Some(instant(12, 0)))
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 7);
    assert_eq!(fact_rows(&admin.app).await, grown);
}

/// The exceptions as the host keeps them: `(record, kind, box, code, scan
/// instant, reason, words, operator, occurred)`.
async fn exception_rows(admin: &Admin) -> Vec<Value> {
    type ExceptionRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let rows: Vec<ExceptionRow> = sqlx::query_as(
        "SELECT record_id, kind, box_id, code_hash, target_scanned_at, reason_code, \
         reason_text, operator_id, occurred_at FROM box_exceptions ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8]))
        .collect()
}

#[tokio::test]
async fn an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    // Codes 1–3 in box 1; code 4 there too, but the colleague scanned it
    // earlier.
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(90),
            "scan",
            &colleague.shift,
            ok_scan(4, &box_id(9), &instant(0, 0)),
        )],
    )
    .await;
    receipts(
        &admin.app,
        &floor.key,
        &[
            scan(1, 1, 1, 1),
            scan(2, 2, 1, 2),
            scan(3, 3, 1, 3),
            scan(4, 4, 1, 4),
        ],
    )
    .await;
    let undo = |n: u32, code: u32, second: u32| {
        let mut data = box_exception("undo", &box_id(1), &instant(second, 0));
        data["codeHash"] = json!(code_hash(code));
        data["targetScannedAt"] = json!(instant(code, 0));
        fact(&record_id(n), "box_exception", shift, data)
    };
    let mut undo_three = undo(10, 3, 20);
    undo_three["operatorId"] = json!(OPERATOR);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[undo_three, undo(11, 4, 21)]).await,
        vec![accepted(&record_id(10)), accepted(&record_id(11))]
    );
    // Code 3 left the box and is free; the undo of code 4, whose scan lost
    // the code, took nothing out, but is kept.
    let check = |hash: String| {
        let app = &admin.app;
        let key = floor.key.clone();
        async move {
            app.send(support::app::empty(with_device(
                request("GET", &format!("/v1/device/codes/{hash}")),
                &key,
            )))
            .await
            .1["status"]
                .clone()
        }
    };
    assert_eq!(check(code_hash(3)).await, json!("free"));
    assert_eq!(check(code_hash(4)).await, json!("taken"));
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(1), code_hash(1), instant(1, 0), null, null]),
            json!([record_id(2), code_hash(2), instant(2, 0), null, null]),
            json!([
                record_id(3),
                code_hash(3),
                instant(3, 0),
                instant(20, 0),
                null
            ]),
        ]
    );
    // Code 3 scanned again goes back in; the box closes with its live codes.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(12, 3, 1, 22)]).await,
        vec![accepted(&record_id(12))]
    );
    assert_eq!(check(code_hash(3)).await, json!("taken"));
    // A clear takes every live code out of box 2 and frees them.
    receipts(
        &admin.app,
        &floor.key,
        &[scan(13, 5, 2, 23), scan(14, 6, 2, 24)],
    )
    .await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(15),
                "box_exception",
                shift,
                box_exception("clear", &box_id(2), &instant(25, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(15))]
    );
    assert_eq!(check(code_hash(5)).await, json!("free"));
    assert_eq!(check(code_hash(6)).await, json!("free"));
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![
            json!([
                record_id(13),
                code_hash(5),
                instant(23, 0),
                instant(25, 0),
                null
            ]),
            json!([
                record_id(14),
                code_hash(6),
                instant(24, 0),
                instant(25, 0),
                null
            ]),
        ]
    );
    // The cleared box stays open for the next code.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(16, 7, 2, 26)]).await,
        vec![accepted(&record_id(16))]
    );
    assert_eq!(
        exception_rows(&admin).await,
        vec![
            json!([
                record_id(10),
                "undo",
                box_id(1),
                code_hash(3),
                instant(3, 0),
                null,
                null,
                OPERATOR,
                instant(20, 0)
            ]),
            json!([
                record_id(11),
                "undo",
                box_id(1),
                code_hash(4),
                instant(4, 0),
                null,
                null,
                null,
                instant(21, 0)
            ]),
            json!([
                record_id(15),
                "clear",
                box_id(2),
                null,
                null,
                null,
                null,
                null,
                instant(25, 0)
            ]),
        ]
    );
    // Box 1 closes with the codes it holds now: the digest of 1, 2 and 3.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(17),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2, 3],
                    &instant(1, 0),
                    &instant(30, 0)
                )
            )]
        )
        .await,
        vec![accepted(&record_id(17))]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await[7], json!(true));
    // A closed box takes neither.
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                undo(18, 1, 31),
                fact(
                    &record_id(19),
                    "box_exception",
                    shift,
                    box_exception("clear", &box_id(1), &instant(32, 0))
                )
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(18)), "box_state", None),
            rejected(Some(&record_id(19)), "box_state", None)
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, grown);
}

#[tokio::test]
async fn a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(1, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(2, &box_id(1), &instant(2, 0)),
            ),
            fact(
                &record_id(3),
                "scan",
                shift,
                ok_scan(3, &box_id(2), &instant(3, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2],
                    &instant(1, 0),
                    &instant(10, 0),
                ),
            ),
        ],
    )
    .await;
    let exception = |n: u32, kind: &str, box_n: u32, fields: Value| {
        let mut data = box_exception(kind, &box_id(box_n), &instant(20 + n, 0));
        for (key, value) in fields.as_object().unwrap() {
            data[key] = value.clone();
        }
        fact(&record_id(n), "box_exception", shift, data)
    };
    let kept = fact_rows(&admin.app).await;
    let refused = vec![
        // The fields of each kind.
        exception(10, "undo", 2, json!({ "targetScannedAt": instant(3, 0) })),
        exception(11, "undo", 2, json!({ "codeHash": code_hash(3) })),
        exception(
            12,
            "undo",
            2,
            json!({
                "codeHash": code_hash(3), "targetScannedAt": instant(3, 0),
                "reasonCode": "other"
            }),
        ),
        exception(13, "clear", 2, json!({ "codeHash": code_hash(3) })),
        exception(14, "clear", 2, json!({ "targetScannedAt": instant(3, 0) })),
        exception(15, "clear", 2, json!({ "reasonText": "Неверный короб" })),
        exception(16, "reprint", 1, json!({})),
        exception(17, "reprint", 1, json!({ "reasonCode": "wrong_product" })),
        exception(18, "disassemble", 1, json!({ "reasonCode": "printer_jam" })),
        exception(
            19,
            "reprint",
            1,
            json!({ "reasonCode": "damaged_label", "reasonText": "Смята" }),
        ),
        exception(
            20,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "   " }),
        ),
        exception(
            21,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "Я".repeat(201) }),
        ),
        exception(
            22,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "Смята\tнаполовину" }),
        ),
        exception(
            23,
            "reprint",
            1,
            json!({ "reasonCode": "other", "codeHash": code_hash(1) }),
        ),
        exception(24, "teleport", 1, json!({})),
        exception(
            25,
            "reprint",
            1,
            json!({ "reasonCode": "damaged_label", "occurredAt": "now" }),
        ),
        exception(
            26,
            "undo",
            2,
            json!({ "codeHash": "C0DE", "targetScannedAt": instant(3, 0) }),
        ),
        // An open box is reprinted or taken apart by no one.
        exception(27, "reprint", 2, json!({ "reasonCode": "damaged_label" })),
        exception(
            28,
            "disassemble",
            2,
            json!({ "reasonCode": "wrong_quantity" }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(10)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(11)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(12)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(13)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(14)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(15)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(16)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(17)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(18)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(19)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(20)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(21)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(22)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(23)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(Some(&record_id(24)), "invalid_record", Some("data")),
            rejected(
                Some(&record_id(25)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(
                Some(&record_id(26)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(Some(&record_id(27)), "box_state", None),
            rejected(Some(&record_id(28)), "box_state", None),
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 19);
    assert_eq!(fact_rows(&admin.app).await, grown);

    // A reprint with words for `other` (trimmed, 200 characters at most),
    // then the box taken apart: its codes are free, its SSCC stays.
    let words = format!("  {}  ", "Я".repeat(200));
    let accepted_ones = vec![
        exception(30, "reprint", 1, json!({ "reasonCode": "damaged_label" })),
        exception(
            31,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": words }),
        ),
        exception(
            32,
            "disassemble",
            1,
            json!({ "reasonCode": "wrong_quantity" }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &accepted_ones).await,
        vec![
            accepted(&record_id(30)),
            accepted(&record_id(31)),
            accepted(&record_id(32))
        ]
    );
    let taken_apart: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT disassembled_at, sscc FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(taken_apart, (Some(instant(52, 0)), Some(sscc(1500))));
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(52, 0),
                null
            ]),
            json!([
                record_id(2),
                code_hash(2),
                instant(2, 0),
                instant(52, 0),
                null
            ]),
        ]
    );
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(3),
            record_id(3),
            floor.shift,
            floor.station,
            box_id(2),
            instant(3, 0)
        ])]
    );
    let rows = exception_rows(&admin).await;
    assert_eq!(
        rows[1],
        json!([
            record_id(31),
            "reprint",
            box_id(1),
            null,
            null,
            "other",
            "Я".repeat(200),
            null,
            instant(51, 0)
        ])
    );
    assert_eq!(rows.len(), 3);
    // A box taken apart is reprinted and taken apart no more; its codes go
    // into another box; its SSCC closes no other box.
    let mut reuse = box_closed(
        &box_id(2),
        &block,
        1500,
        &[3],
        &instant(3, 0),
        &instant(60, 0),
    );
    reuse["sscc"] = json!(sscc(1500));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                exception(40, "reprint", 1, json!({ "reasonCode": "damaged_label" })),
                exception(
                    41,
                    "disassemble",
                    1,
                    json!({ "reasonCode": "wrong_quantity" })
                ),
                fact(
                    &record_id(42),
                    "scan",
                    shift,
                    ok_scan(1, &box_id(2), &instant(42, 0))
                ),
                fact(&record_id(43), "box_closed", shift, reuse),
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(40)), "box_state", None),
            rejected(Some(&record_id(41)), "box_state", None),
            accepted(&record_id(42)),
            rejected(Some(&record_id(43)), "sscc_taken", None),
        ]
    );
}
```

3. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "membershipDigest": members_digest(members)
    })
}
```

заменить на

<!-- prettier-ignore -->
```rust
        "membershipDigest": members_digest(members)
    })
}

/// The `data` of a box exception of `kind` in `box_id` at `at`, with no
/// code, scan instant or reason; a test sets the fields its kind needs.
pub fn box_exception(kind: &str, box_id: &str, at: &str) -> Value {
    serde_json::json!({
        "exception": kind, "boxId": box_id, "codeHash": null, "targetScannedAt": null,
        "reasonCode": null, "reasonText": null, "occurredAt": at
    })
}
```

4. В `apps/standalone/proto/fixtures/facts-request.json` фрагмент

<!-- prettier-ignore -->
```json
        "itemCount": 12,
        "membershipDigest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e"
      }
    }
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
        "itemCount": 12,
        "membershipDigest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e"
      }
    },
    {
      "id": "8b5a1d3e-6f4c-4a0b-9d7e-3f5a7b9c1d43",
      "kind": "box_label",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "boxId": "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "outcome": "verified",
        "at": "2026-10-08T06:21:55.016Z"
      }
    },
    {
      "id": "9c6b2e4f-7a5d-4b1c-8e8f-4a6b8c0d2e54",
      "kind": "box_exception",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "exception": "reprint",
        "boxId": "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "codeHash": null,
        "targetScannedAt": null,
        "reasonCode": "other",
        "reasonText": "Этикетка смята на аппликаторе",
        "occurredAt": "2026-10-08T06:24:10.881Z"
      }
    }
  ]
}
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![FactKind::Scan, FactKind::BoxClosed];
        for kind in &kinds {
            match kind {
                FactKind::Scan | FactKind::BoxClosed => {}
            }
        }
        kinds
```

заменить на

<!-- prettier-ignore -->
```rust

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
        ];
        for kind in &kinds {
            match kind {
                FactKind::Scan
                | FactKind::BoxClosed
                | FactKind::BoxLabel
                | FactKind::BoxException => {}
            }
        }
        kinds
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, CategoryTemplateDefault, ChangesResponse, ClaimRequest,
    CodeCheck, CodeOwner, Compatibility, CounterpartyCreate, CounterpartyRecord,
    CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceShift,
    DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody, FactBatch, FactKind, FactOutcome,
    FactReceipts, Hello, HelloEnvelope, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord,
    LabelTemplateSummary, LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate,
    LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole,
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ScanFact, ScanRawKind, ScanVerdict, ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin,
    ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, BoxExceptionFact, BoxLabelFact, CategoryTemplateDefault,
    ChangesResponse, ClaimRequest, CodeCheck, CodeOwner, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody,
    ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
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
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![FactKind::Scan, FactKind::Scan, FactKind::BoxClosed]
    );
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
            FactKind::BoxClosed => {
                serde_json::to_value(typed::<BoxClosedFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
```

заменить на

<!-- prettier-ignore -->
```rust
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FactKind::Scan,
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException
        ]
    );
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
            FactKind::BoxClosed => {
                serde_json::to_value(typed::<BoxClosedFact>(&record.data)).unwrap()
            }
            FactKind::BoxLabel => {
                serde_json::to_value(typed::<BoxLabelFact>(&record.data)).unwrap()
            }
            FactKind::BoxException => {
                serde_json::to_value(typed::<BoxExceptionFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(closed
        .sscc
        .starts_with(&format!("0{}", block.issuer_prefix)));
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(closed
        .sscc
        .starts_with(&format!("0{}", block.issuer_prefix)));
    // Its label checked, then printed again for a reason in words.
    let label: BoxLabelFact = typed(&batch.records[3].data);
    assert_eq!(
        (&label.box_id, label.outcome),
        (&accepted_box, LabelOutcome::Verified)
    );
    let reprint: BoxExceptionFact = typed(&batch.records[4].data);
    assert_eq!(
        (
            reprint.exception,
            &reprint.box_id,
            reprint.reason_code.as_deref()
        ),
        (
            ExceptionKind::Reprint,
            &accepted_box,
            Some(markiro_proto::exception_reasons::OTHER)
        )
    );
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL — 12 тестов проходят, падают `a_label_check_marks_a_closed_box_of_its_own`, `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them` и `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code` (виды `box_label` и `box_exception` ещё незнакомы).

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/facts/box_label.rs`:

<!-- prettier-ignore -->
```rust
//! `box_label` facts: the operator checked a closed box's printed label
//! (scanned its SSCC) or skipped the check. The host keeps when.

use markiro_proto::{receipt_codes, BoxLabelFact, LabelOutcome};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let label: BoxLabelFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    if validate::client_uuid("data.boxId", &label.box_id).is_err() {
        return Err(Reject::field("data.boxId").into());
    }
    if rules::device_instant(&label.at).is_none() {
        return Err(Reject::field("data.at").into());
    }
    let found = boxes::find(&mut *conn, context, &label.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if found.closed_at.is_none() {
        return Err(Reject::new(receipt_codes::BOX_STATE).into());
    }
    let column = match label.outcome {
        LabelOutcome::Verified => "print_verified_at",
        LabelOutcome::Skipped => "print_skipped_at",
    };
    sqlx::query(&format!("UPDATE boxes SET {column} = ? WHERE id = ?"))
        .bind(&label.at)
        .bind(&label.box_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

2. Создать `apps/standalone/host/src/facts/exception.rs`:

<!-- prettier-ignore -->
```rust
//! `box_exception` facts (stage 2a spec, decision 36): take the last code
//! out of an open box (`undo`) or every code (`clear`), print a closed box's
//! label again (`reprint`), take a closed box apart (`disassemble`). An
//! item taken out leaves its box (`removed_at`, the station's instant) and
//! its code is free again; a box taken apart keeps its SSCC. Reasons are
//! codes, with words only for `other`.

use markiro_proto::{exception_reasons, receipt_codes, BoxExceptionFact, ExceptionKind};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, registry, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of an exception agree with its kind; returns the reason's
/// words trimmed.
fn check(exception: &BoxExceptionFact) -> Result<Option<String>, Reject> {
    if validate::client_uuid("data.boxId", &exception.box_id).is_err() {
        return Err(Reject::field("data.boxId"));
    }
    if rules::device_instant(&exception.occurred_at).is_none() {
        return Err(Reject::field("data.occurredAt"));
    }
    let undo = exception.exception == ExceptionKind::Undo;
    match &exception.code_hash {
        Some(code_hash) if undo && rules::is_code_hash(code_hash) => {}
        None if !undo => {}
        _ => return Err(Reject::field("data.codeHash")),
    }
    match &exception.target_scanned_at {
        Some(at) if undo && rules::device_instant(at).is_some() => {}
        None if !undo => {}
        _ => return Err(Reject::field("data.targetScannedAt")),
    }
    let reasons = match exception.exception {
        ExceptionKind::Undo | ExceptionKind::Clear => None,
        ExceptionKind::Reprint => Some(exception_reasons::REPRINT),
        ExceptionKind::Disassemble => Some(exception_reasons::DISASSEMBLE),
    };
    match (reasons, exception.reason_code.as_deref()) {
        (None, None) => {}
        (Some(reasons), Some(code)) if reasons.contains(&code) => {}
        _ => return Err(Reject::field("data.reasonCode")),
    }
    match (exception.reason_code.as_deref(), &exception.reason_text) {
        (_, None) => Ok(None),
        (Some(exception_reasons::OTHER), Some(text)) => {
            validate::exception_reason_text("data.reasonText", text)
                .map(Some)
                .map_err(|_| Reject::field("data.reasonText"))
        }
        _ => Err(Reject::field("data.reasonText")),
    }
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let exception: BoxExceptionFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let reason_text = check(&exception)?;
    let found = boxes::find(&mut *conn, context, &exception.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    let open = found.closed_at.is_none();
    let fits = match exception.exception {
        ExceptionKind::Undo | ExceptionKind::Clear => open,
        ExceptionKind::Reprint | ExceptionKind::Disassemble => {
            !open && found.disassembled_at.is_none()
        }
    };
    if !fits {
        return Err(Reject::new(receipt_codes::BOX_STATE).into());
    }
    // The live items the exception takes out: the code an undo names (none
    // when its scan lost the code), every item of a clear or a disassembly.
    let taken_out: Vec<String> = match exception.exception {
        ExceptionKind::Reprint => Vec::new(),
        _ => sqlx::query_scalar(
            "SELECT scan_id FROM box_items WHERE box_id = ? \
             AND removed_at IS NULL AND displaced_at IS NULL AND (? IS NULL OR code_hash = ?)",
        )
        .bind(&exception.box_id)
        .bind(&exception.code_hash)
        .bind(&exception.code_hash)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?,
    };
    for scan_id in &taken_out {
        sqlx::query("UPDATE box_items SET removed_at = ? WHERE scan_id = ?")
            .bind(&exception.occurred_at)
            .bind(scan_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        registry::release(&mut *conn, scan_id).await?;
    }
    if exception.exception == ExceptionKind::Disassemble {
        sqlx::query("UPDATE boxes SET disassembled_at = ? WHERE id = ?")
            .bind(&exception.occurred_at)
            .bind(&exception.box_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query(
        "INSERT INTO box_exceptions (id, record_id, kind, box_id, code_hash, target_scanned_at, \
         reason_code, reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(exception.exception.as_str())
    .bind(&exception.box_id)
    .bind(&exception.code_hash)
    .bind(&exception.target_scanned_at)
    .bind(&exception.reason_code)
    .bind(&reason_text)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(&exception.occurred_at)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

3. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! sends it again.

pub mod box_closed;
pub mod boxes;
pub mod registry;
pub mod rules;
pub mod scan;
```

заменить на

<!-- prettier-ignore -->
```rust
//! sends it again.

pub mod box_closed;
pub mod box_label;
pub mod boxes;
pub mod exception;
pub mod registry;
pub mod rules;
pub mod scan;
```

4. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
```

заменить на

<!-- prettier-ignore -->
```rust
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
        FactKind::BoxLabel => box_label::apply(conn, &context, &record.data).await,
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
```

5. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

заменить на

<!-- prettier-ignore -->
```rust
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

/// Free the code the scan `scan_id` owns, if it owns one: its item was
/// taken out of its box.
pub async fn release(conn: &mut SqliteConnection, scan_id: &str) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM code_owners WHERE scan_id = ?")
        .bind(scan_id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}
```

6. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "the reason must be 3-500 characters without control characters",
        ))
    }
}

/// An identifier the client makes up (a station's request id): a UUID in
```

заменить на

<!-- prettier-ignore -->
```rust
            "the reason must be 3-500 characters without control characters",
        ))
    }
}

/// The words of a box exception's reason `other`: trimmed, 1-200 characters
/// without control characters (the station sends none when the operator
/// typed nothing).
pub fn exception_reason_text(field: &str, text: &str) -> Result<String, ApiError> {
    clean_text(
        field,
        text,
        markiro_proto::exception_reasons::MAX_TEXT_CHARS,
        "the reason",
    )
    .map(str::to_owned)
}

/// An identifier the client makes up (a station's request id): a UUID in
```

7. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub enum FactKind {
    Scan,
    BoxClosed,
}

impl FactKind {
```

заменить на

<!-- prettier-ignore -->
```rust
pub enum FactKind {
    Scan,
    BoxClosed,
    BoxLabel,
    BoxException,
}

impl FactKind {
```

8. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        match self {
            FactKind::Scan => "scan",
            FactKind::BoxClosed => "box_closed",
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        match self {
            FactKind::Scan => "scan",
            FactKind::BoxClosed => "box_closed",
            FactKind::BoxLabel => "box_label",
            FactKind::BoxException => "box_exception",
        }
    }
}
```

9. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub closed_at: String,
    pub item_count: u32,
    pub membership_digest: String,
}

/// How the host answered a record.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub closed_at: String,
    pub item_count: u32,
    pub membership_digest: String,
}

/// How a box's printed label was checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelOutcome {
    /// The operator scanned the label's SSCC and it matched.
    Verified,
    /// The operator skipped the check.
    Skipped,
}

/// `data` of a `box_label` fact: the check of a closed box's label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxLabelFact {
    pub box_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a box exception does (the cloud's four kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionKind {
    /// Take the last code out of an open box.
    Undo,
    /// Take every code out of an open box.
    Clear,
    /// Print a closed box's label again.
    Reprint,
    /// Take a closed box apart; its SSCC stays used.
    Disassemble,
}

impl ExceptionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ExceptionKind::Undo => "undo",
            ExceptionKind::Clear => "clear",
            ExceptionKind::Reprint => "reprint",
            ExceptionKind::Disassemble => "disassemble",
        }
    }
}

/// `data` of a `box_exception` fact, with the fields of each kind as the
/// cloud's: `undo` names the code and its scan's instant and no reason;
/// `clear` nothing; `reprint` and `disassemble` a reason code of
/// [`exception_reasons`], and words only with `other`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxExceptionFact {
    pub exception: ExceptionKind,
    pub box_id: String,
    pub code_hash: Option<String>,
    pub target_scanned_at: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

/// How the host answered a record.
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: PASS — 15 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`digest_matches` for the shift's card (stage 4): a mismatch refuses
nothing.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
`digest_matches` for the shift's card (stage 4): a mismatch refuses
nothing.

A `box_label` (`facts/box_label.rs`) records the check of a closed box's
label (`box_state` for an open one): `verified` sets `print_verified_at`,
`skipped` `print_skipped_at`, each to the station's instant (a reprint and a
second check set them again). A `box_exception` (`facts/exception.rs`) has
the fields of its kind as the cloud's (`box_exceptions_kind_payload_check`):
`undo` names the code and its scan's instant, `clear` nothing, `reprint` and
`disassemble` a reason code of `exception_reasons` for their kind, with
words (`validate::exception_reason_text`, trimmed, 1–200 characters) only
for `other`. `undo` and `clear` take an open box, `reprint` and
`disassemble` a closed box not taken apart (`box_state` otherwise). The
items an undo (the live item of its code; none when that scan lost the
code, and the exception is still kept), a clear or a disassembly takes out
get `removed_at` (the station's instant), and their codes leave the
registry (`registry::release`), free for another scan; a disassembly sets
`disassembled_at` and the box keeps its SSCC, which no other box takes.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — undo снимает все коды. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
             AND removed_at IS NULL AND displaced_at IS NULL AND (? IS NULL OR code_hash = ?)",
```

заменить на

<!-- prettier-ignore -->
```rust
             AND removed_at IS NULL AND displaced_at IS NULL AND (? IS NULL OR code_hash = ? OR 1)",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — коды не освобождаются. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .map_err(ApiError::internal)?;
        registry::release(&mut *conn, scan_id).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
            .map_err(ApiError::internal)?;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`, `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — disassembled_at не ставится. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if exception.exception == ExceptionKind::Disassemble {
```

заменить на

<!-- prettier-ignore -->
```rust
    if exception.exception == ExceptionKind::Disassemble && false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — перепечатка снимает позиции. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let taken_out: Vec<String> = match exception.exception {
        ExceptionKind::Reprint => Vec::new(),
```

заменить на

<!-- prettier-ignore -->
```rust
    let taken_out: Vec<String> = match exception.exception {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — расформированный короб перепечатывается. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
            !open && found.disassembled_at.is_none()
```

заменить на

<!-- prettier-ignore -->
```rust
            !open
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — undo в закрытом коробе. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ExceptionKind::Undo | ExceptionKind::Clear => open,
```

заменить на

<!-- prettier-ignore -->
```rust
        ExceptionKind::Undo | ExceptionKind::Clear => true,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — причины видов перепутаны. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ExceptionKind::Disassemble => Some(exception_reasons::DISASSEMBLE),
```

заменить на

<!-- prettier-ignore -->
```rust
        ExceptionKind::Disassemble => Some(exception_reasons::REPRINT),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — слова при любой причине. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (Some(exception_reasons::OTHER), Some(text)) => {
```

заменить на

<!-- prettier-ignore -->
```rust
        (Some(_), Some(text)) => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — слова не обрезаются. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(&reason_text)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(&exception.reason_text)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — предел слов 199. В `apps/standalone/host/src/validate.rs` фрагмент

<!-- prettier-ignore -->
```rust
        markiro_proto::exception_reasons::MAX_TEXT_CHARS,
```

заменить на

<!-- prettier-ignore -->
```rust
        markiro_proto::exception_reasons::MAX_TEXT_CHARS - 1,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — removed_at — часы хоста. В `apps/standalone/host/src/facts/exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
        sqlx::query("UPDATE box_items SET removed_at = ? WHERE scan_id = ?")
            .bind(&exception.occurred_at)
```

заменить на

<!-- prettier-ignore -->
```rust
        sqlx::query("UPDATE box_items SET removed_at = ? WHERE scan_id = ?")
            .bind(context.received_at)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code`, `an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them`. Восстановить файл, `cmp` молчит, хеш прежний.

М12 — столбцы проверки этикетки перепутаны. В `apps/standalone/host/src/facts/box_label.rs` фрагмент

<!-- prettier-ignore -->
```rust
        LabelOutcome::Verified => "print_verified_at",
        LabelOutcome::Skipped => "print_skipped_at",
```

заменить на

<!-- prettier-ignore -->
```rust
        LabelOutcome::Verified => "print_skipped_at",
        LabelOutcome::Skipped => "print_verified_at",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_label_check_marks_a_closed_box_of_its_own`. Восстановить файл, `cmp` молчит, хеш прежний.

М13 — проверка этикетки открытого короба. В `apps/standalone/host/src/facts/box_label.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if found.closed_at.is_none() {
```

заменить на

<!-- prettier-ignore -->
```rust
    if found.closed_at.is_none() && false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_label_check_marks_a_closed_box_of_its_own`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/box_label.rs apps/standalone/host/src/facts/exception.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/registry.rs apps/standalone/host/src/validate.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): label checks and box exceptions as facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `shift_closed` и поздние данные — закрытие станцией, `alreadyClosed`, одна ревизия на пачку

Локальное закрытие на станции — точка фиксации, поэтому хост принимает его, когда бы оно ни пришло: активная смена закрывается (`closed_by_kind = device`, момент станции в формате хоста, код причины, строка журнала `shift.close` от станции), закрытая офисом — `accepted` с `alreadyClosed`; каждое закрытие хранится в `shift_close_events`. Причина нужна по плану, который видела станция. Любой другой принятый факт закрытой смены один раз ставит `late_data_at`. Закрытие и поздняя отметка меняют строку смены: пачка берёт одну ревизию хоста на все такие изменения (при первой нужде), штампует её в `shifts.rev` и коммитит через `commit_with_revision`, чтобы потоки проснулись; пачка, не тронувшая смен, ревизии не берёт. Строку смены меняет приём записи после обработчика вида (`close_shift`, `mark_late`), сами обработчики смен не трогают. `facts::receive` получает параметр `revision`; тесты гонки задач 2 и 3 передают в него `&mut None`.

**Files:**

- Create: `apps/standalone/host/src/facts/shift_closed.rs`
- Modify: `apps/standalone/host/src/facts/mod.rs`, `apps/standalone/host/src/facts/registry.rs`, `apps/standalone/host/src/routes/facts.rs`, `apps/standalone/proto/src/lib.rs` (`FactKind::ShiftClosed`, `ShiftClosedFact`), `apps/standalone/proto/fixtures/{facts-request,facts-response}.json`
- Test: `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/codes.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `rules::{device_instant, close_reason_required}`, `shift_close_reasons` (задача 1), `validate::MAX_PLANNED_QTY`, `clock::format_timestamp`, `db::{next_revision, commit_with_revision}`, `audit::{record, actions::SHIFT_CLOSE}`.
- Produces:
  - `FactKind::ShiftClosed` (`"shift_closed"`); `markiro_proto::ShiftClosedFact { planned_qty_snapshot: Option<u32>, actual_qty: u32, closed_box_count: u32, reason_code: Option<String>, closed_at }`;
  - `markiro_host::facts::{Applied { outcome, details, close: Option<CloseShift> }, CloseShift { closed_at, reason_code, audit }}`;
  - `pub async fn markiro_host::facts::receive(conn, device_id, value, received_at, revision: &mut Option<i64>) -> Result<FactReceipt, ApiError>`;
  - помощники тестов `support::app::{shift_closed(planned, actual, boxes, reason, closed_at) -> Value, close_from_office(admin, shift, reason) -> Value}`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. В `apps/standalone/host/tests/codes.rs` фрагмент

<!-- prettier-ignore -->
```rust
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        &admin.app.state.timestamp(),
    )
    .await
    .unwrap();
```

заменить на

<!-- prettier-ignore -->
```rust
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        &admin.app.state.timestamp(),
        &mut None,
    )
    .await
    .unwrap();
```

2. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_host::error::ApiJson;
use markiro_host::routes::facts::{receive_facts, IncomingFacts};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_exception, box_id, code, code_hash, fact,
    fact_rows, host_revision, instant, issue_block, members_digest, ok_scan, open_floor,
    pair_device, plan_shift, receipts, record_id, rejected, request, send_facts, shift_body,
    shift_setup, sscc, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_host::error::ApiJson;
use markiro_host::routes::facts::{receive_facts, IncomingFacts};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, audit_trail, box_closed, box_exception, box_id, close_from_office,
    code, code_hash, fact, fact_rows, host_revision, instant, issue_block, members_digest, ok_scan,
    open_floor, pair_device, plan_shift, receipts, record_id, rejected, request, send_facts,
    shift_body, shift_closed, shift_setup, sscc, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
```

3. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &record,
        &admin.app.state.timestamp(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
```

заменить на

<!-- prettier-ignore -->
```rust
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &record,
        &admin.app.state.timestamp(),
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
```

4. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            accepted(&record_id(42)),
            rejected(Some(&record_id(43)), "sscc_taken", None),
        ]
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
            accepted(&record_id(42)),
            rejected(Some(&record_id(43)), "sscc_taken", None),
        ]
    );
}

/// A shift's close as the host keeps it: `(status, closed at, closed by
/// kind, closed by, reason code, late data at, rev)`.
async fn shift_state(admin: &Admin, shift: &str) -> Value {
    type ShiftRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    );
    let row: ShiftRow = sqlx::query_as(
        "SELECT status, closed_at, closed_by_kind, closed_by, close_reason_code, late_data_at, \
         rev FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6])
}

/// The station closes kept: `(record, device, operator, plan, fact, boxes,
/// reason, closed at, outcome, received at)`.
async fn close_events(admin: &Admin) -> Vec<Value> {
    type CloseRow = (
        String,
        String,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        Option<String>,
        String,
        String,
        String,
    );
    let rows: Vec<CloseRow> = sqlx::query_as(
        "SELECT record_id, device_id, operator_id, planned_qty_snapshot, actual_qty, \
         closed_box_count, reason_code, closed_at, outcome, received_at \
         FROM shift_close_events ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9]))
        .collect()
}

#[tokio::test]
async fn a_station_closes_its_shift_once_and_the_office_sees_it_closed() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    admin.app.clock.advance(time::Duration::minutes(10));
    let received = admin.app.state.timestamp();
    let revision = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let mut close = fact(
        &record_id(2),
        "shift_closed",
        shift,
        shift_closed(None, 1, 0, None, &instant(1800, 250)),
    );
    close["operatorId"] = json!(OPERATOR);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(2))]
    );
    // The shift closed at the station's instant, in whole seconds, with the
    // batch's revision; the streams woke with it.
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), revision + 1);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:30:00Z",
            "device",
            floor.station,
            null,
            null,
            revision + 1
        ])
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![(
            "device".to_owned(),
            Some(floor.station.clone()),
            "shift.close".to_owned(),
            Some("shift".to_owned()),
            Some(floor.shift.clone()),
            "ok".to_owned(),
            json!({ "actualQty": 1, "plannedQty": null, "closedBoxCount": 0, "reasonCode": null })
        )]
    );
    assert_eq!(
        close_events(&admin).await,
        vec![json!([
            record_id(2),
            floor.station,
            OPERATOR,
            null,
            1,
            0,
            null,
            instant(1800, 250),
            "accepted",
            received
        ])]
    );
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["status"].clone(),
            office["closedAt"].clone(),
            office["rev"].clone()
        ),
        (
            StatusCode::OK,
            json!("closed"),
            json!("2026-10-08T06:30:00Z"),
            json!(revision + 1)
        )
    );
    // A second close (another record) finds the shift closed: accepted with
    // `alreadyClosed`, kept, and nothing else changes; the station's own
    // close is no late data.
    admin.app.clock.advance(time::Duration::minutes(1));
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(3),
                "shift_closed",
                shift,
                shift_closed(None, 1, 0, None, &instant(1900, 0))
            )]
        )
        .await,
        vec![
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:30:00Z",
            "device",
            floor.station,
            null,
            null,
            revision + 1
        ])
    );
    assert_eq!(close_events(&admin).await[1][8], json!("already_closed"));
    // The station's list shows it closed; it opens no more.
    let (status, listed) = admin
        .app
        .send(support::app::empty(with_device(
            request("GET", "/v1/device/shifts"),
            &floor.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["shifts"][0]["status"], json!("closed"));
}

#[tokio::test]
async fn a_close_names_a_reason_when_the_fact_differs_from_the_plan() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let other = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let shift = floor.shift.as_str();
    let close = |n: u32, data: Value| fact(&record_id(n), "shift_closed", shift, data);
    let at = instant(3600, 0);
    let kept = fact_rows(&admin.app).await;
    let before = shift_state(&admin, shift).await;
    let refused = vec![
        close(1, shift_closed(Some(250), 249, 20, None, &at)),
        close(2, shift_closed(Some(250), 251, 21, Some("broken"), &at)),
        close(3, shift_closed(Some(0), 0, 0, None, &at)),
        close(
            4,
            shift_closed(Some(10_000_001), 1, 0, Some("equipment_stop"), &at),
        ),
        close(
            5,
            shift_closed(
                Some(250),
                249,
                20,
                Some("equipment_stop"),
                "2026-10-08T07:00:00Z",
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(1)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(2)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(3)),
                "invalid_record",
                Some("data.plannedQtySnapshot")
            ),
            rejected(
                Some(&record_id(4)),
                "invalid_record",
                Some("data.plannedQtySnapshot")
            ),
            rejected(Some(&record_id(5)), "invalid_record", Some("data.closedAt")),
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, before);
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 5);
    assert_eq!(fact_rows(&admin.app).await, grown);
    // A fact that matches the plan needs no reason, and the largest plan is
    // a plan; a fact that differs takes one of the six codes.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close(
                6,
                shift_closed(Some(10_000_000), 10_000_000, 1, None, &at)
            )]
        )
        .await,
        vec![accepted(&record_id(6))]
    );
    // A reason the plan did not call for is kept, as in the cloud.
    assert_eq!(
        receipts(
            &admin.app,
            &other.key,
            &[fact(
                &record_id(7),
                "shift_closed",
                &other.shift,
                shift_closed(None, 5, 1, Some("material_shortage"), &at)
            )]
        )
        .await,
        vec![accepted(&record_id(7))]
    );
    assert_eq!(
        shift_state(&admin, &other.shift).await[4],
        json!("material_shortage")
    );
    let third = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(8),
                "shift_closed",
                &third.shift,
                shift_closed(Some(250), 249, 20, Some("equipment_stop"), &at)
            )]
        )
        .await,
        vec![accepted(&record_id(8))]
    );
    assert_eq!(
        shift_state(&admin, &third.shift).await[4],
        json!("equipment_stop")
    );
}

#[tokio::test]
async fn facts_of_a_closed_shift_are_taken_and_mark_it_late_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    // The office closes the shift while the station is still away.
    let closed = close_from_office(&admin, shift, "Станция не отвечает").await;
    admin.app.clock.advance(time::Duration::minutes(30));
    let late_at = admin.app.state.timestamp();
    let revision = host_revision(&admin.app).await;
    // A refused record of the closed shift marks nothing.
    let mut wrong = ok_scan(9, &box_id(1), &instant(9, 0));
    wrong["code"]["gtin14"] = json!("04600682000099");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(2), "scan", shift, wrong)]
        )
        .await,
        vec![rejected(Some(&record_id(2)), "gtin_mismatch", None)]
    );
    assert_eq!(shift_state(&admin, shift).await[5], Value::Null);
    assert_eq!(host_revision(&admin.app).await, revision);
    // The station sends what it did meanwhile: it is taken, and marks the
    // shift late once, with one revision for the batch.
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let late = vec![
        fact(
            &record_id(3),
            "scan",
            shift,
            ok_scan(2, &box_id(1), &instant(2, 0)),
        ),
        fact(
            &record_id(4),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2],
                &instant(1, 0),
                &instant(20, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &late).await,
        vec![accepted(&record_id(3)), accepted(&record_id(4))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(*wake.borrow_and_update(), revision + 1);
    let after = shift_state(&admin, shift).await;
    assert_eq!(
        after,
        json!([
            "closed",
            closed["closedAt"],
            "office_user",
            admin.id,
            null,
            late_at,
            revision + 1
        ])
    );
    // Later facts and the station's own close mark nothing more.
    admin.app.clock.advance(time::Duration::minutes(5));
    let more = vec![
        fact(
            &record_id(5),
            "box_label",
            shift,
            json!({ "boxId": box_id(1), "outcome": "skipped", "at": instant(21, 0) }),
        ),
        fact(
            &record_id(6),
            "shift_closed",
            shift,
            shift_closed(None, 2, 1, None, &instant(30, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &more).await,
        vec![
            accepted(&record_id(5)),
            json!({ "id": record_id(6), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, after);
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert!(audit_trail(&admin.app, "shift.close")
        .await
        .iter()
        .all(|row| row.0 == "office_user"));
}

/// A station's close and a fact after it in one batch: the fact is late, and
/// the batch takes one revision for both changes of the shift.
#[tokio::test]
async fn a_batch_that_closes_its_shift_takes_one_revision() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let revision = host_revision(&admin.app).await;
    let batch = vec![
        fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        ),
        fact(
            &record_id(3),
            "scan",
            shift,
            other_scan(
                "invalid",
                "unknown",
                Value::Null,
                Value::Null,
                &instant(61, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:01:00Z",
            "device",
            floor.station,
            null,
            admin.app.state.timestamp(),
            revision + 1
        ])
    );
}
```

5. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "reasonCode": null, "reasonText": null, "occurredAt": at
    })
}
```

заменить на

<!-- prettier-ignore -->
```rust
        "reasonCode": null, "reasonText": null, "occurredAt": at
    })
}

/// The `data` of a station's close of its shift at `closed_at`.
pub fn shift_closed(
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: &str,
) -> Value {
    serde_json::json!({
        "plannedQtySnapshot": planned, "actualQty": actual, "closedBoxCount": boxes,
        "reasonCode": reason, "closedAt": closed_at
    })
}

/// Close the open shift `shift` from the office, as the administrator, with
/// `reason`.
pub async fn close_from_office(admin: &Admin, shift: &str, reason: &str) -> Value {
    let path = format!("/v1/office/shifts/{shift}");
    let (status, current) = admin.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{current}");
    let (status, closed) = admin
        .call(
            "POST",
            &format!("{path}/close"),
            Some(serde_json::json!({ "reason": reason, "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    closed
}
```

6. В `apps/standalone/proto/fixtures/facts-request.json` фрагмент

<!-- prettier-ignore -->
```json
        "reasonText": "Этикетка смята на аппликаторе",
        "occurredAt": "2026-10-08T06:24:10.881Z"
      }
    }
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
        "reasonText": "Этикетка смята на аппликаторе",
        "occurredAt": "2026-10-08T06:24:10.881Z"
      }
    },
    {
      "id": "ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65",
      "kind": "shift_closed",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "plannedQtySnapshot": 1200,
        "actualQty": 1188,
        "closedBoxCount": 99,
        "reasonCode": "material_shortage",
        "closedAt": "2026-10-08T14:02:31.775Z"
      }
    }
  ]
}
```

7. В `apps/standalone/proto/fixtures/facts-response.json` фрагмент

<!-- prettier-ignore -->
```json
      "id": "8a5f1c3d-6e4b-4fa0-8d9c-3b5e7f9a1c43",
      "outcome": "rejected",
      "code": "not_entered"
    }
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
      "id": "8a5f1c3d-6e4b-4fa0-8d9c-3b5e7f9a1c43",
      "outcome": "rejected",
      "code": "not_entered"
    },
    {
      "id": "ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65",
      "outcome": "accepted",
      "details": {
        "alreadyClosed": true
      }
    }
  ]
}
```

8. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
        ];
        for kind in &kinds {
            match kind {
                FactKind::Scan
                | FactKind::BoxClosed
                | FactKind::BoxLabel
                | FactKind::BoxException => {}
            }
        }
        kinds
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
            FactKind::ShiftClosed,
        ];
        for kind in &kinds {
            match kind {
                FactKind::Scan
                | FactKind::BoxClosed
                | FactKind::BoxLabel
                | FactKind::BoxException
                | FactKind::ShiftClosed => {}
            }
        }
        kinds
```

9. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

заменить на

<!-- prettier-ignore -->
```rust
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate,
    SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

10. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException
        ]
    );
    for record in &batch.records {
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
            FactKind::ShiftClosed
        ]
    );
    for record in &batch.records {
```

11. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            }
            FactKind::BoxException => {
                serde_json::to_value(typed::<BoxExceptionFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
```

заменить на

<!-- prettier-ignore -->
```rust
            }
            FactKind::BoxException => {
                serde_json::to_value(typed::<BoxExceptionFact>(&record.data)).unwrap()
            }
            FactKind::ShiftClosed => {
                serde_json::to_value(typed::<ShiftClosedFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
```

12. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Some(markiro_proto::exception_reasons::OTHER)
        )
    );
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

заменить на

<!-- prettier-ignore -->
```rust
            Some(markiro_proto::exception_reasons::OTHER)
        )
    );
    // The shift closed with fewer units than planned, and a reason.
    let closed: ShiftClosedFact = typed(&batch.records[5].data);
    assert_eq!(
        (
            closed.planned_qty_snapshot,
            closed.actual_qty,
            closed.reason_code.as_deref()
        ),
        (Some(1200), 1188, Some("material_shortage"))
    );
    assert!(markiro_proto::shift_close_reasons::ALL.contains(&"material_shortage"));
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
```

13. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactOutcome::Conflict,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Rejected
        ]
    );
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert!(!winner.same_device);
    for receipt in &receipts.receipts[2..] {
        assert!(markiro_proto::receipt_codes::ALL.contains(&receipt.code.as_deref().unwrap()));
    }
    // A record names no field the host does not read, and a receipt of a
```

заменить на

<!-- prettier-ignore -->
```rust
            FactOutcome::Conflict,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Accepted
        ]
    );
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert!(!winner.same_device);
    // The close of a shift the office closed first.
    assert_eq!(
        receipts.receipts[5].details.clone().map(Value::Object),
        Some(serde_json::json!({ "alreadyClosed": true }))
    );
    for receipt in &receipts.receipts[2..5] {
        assert!(markiro_proto::receipt_codes::ALL.contains(&receipt.code.as_deref().unwrap()));
    }
    // A record names no field the host does not read, and a receipt of a
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --test codes --offline --locked`
Expected: FAIL — компиляция обоих наборов: error[E0061]: this function takes 4 arguments but 5 arguments were supplied (`facts::receive` ещё без `revision`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod registry;
pub mod rules;
pub mod scan;

use markiro_proto::{
    receipt_codes, FactKind, FactOutcome, FactReceipt, FactRecord, ShiftOrigin, ShiftStatus,
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod registry;
pub mod rules;
pub mod scan;
pub mod shift_closed;

use markiro_proto::{
    receipt_codes, FactKind, FactOutcome, FactReceipt, FactRecord, ShiftOrigin, ShiftStatus,
```

2. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::shifts;
use crate::validate;
```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::db::next_revision;
use crate::error::ApiError;
use crate::shifts;
use crate::validate;
```

3. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// What an applied record answers: `accepted`, or `conflict` with its
/// details.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub outcome: FactOutcome,
    pub details: Option<Value>,
}

impl Applied {
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// What an applied record answers: `accepted`, or `conflict` with its
/// details; and the close of its shift, when the record is a station's
/// close of an active shift (the batch writes it, with the batch's
/// revision).
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub outcome: FactOutcome,
    pub details: Option<Value>,
    pub close: Option<CloseShift>,
}

impl Applied {
```

4. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Self {
            outcome: FactOutcome::Accepted,
            details: None,
        }
    }
}

/// The shift a record names, as the device entered it.
```

заменить на

<!-- prettier-ignore -->
```rust
        Self {
            outcome: FactOutcome::Accepted,
            details: None,
            close: None,
        }
    }
}

/// A station's close of an active shift.
#[derive(Debug, Clone, PartialEq)]
pub struct CloseShift {
    /// The station's instant in the host's format (whole seconds).
    pub closed_at: String,
    pub reason_code: Option<String>,
    /// The details of the `shift.close` audit row.
    pub audit: Value,
}

/// The shift a record names, as the device entered it.
```

5. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// `payload_mismatch` (kept nowhere) when it is not; otherwise the record is
/// applied and its receipt kept. A record without a readable id is answered
/// `invalid_record` and nothing of it is kept.
pub async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<FactReceipt, ApiError> {
    let id = value
        .get("id")
```

заменить на

<!-- prettier-ignore -->
```rust
/// `payload_mismatch` (kept nowhere) when it is not; otherwise the record is
/// applied and its receipt kept. A record without a readable id is answered
/// `invalid_record` and nothing of it is kept.
///
/// A record that closes its shift, or the first fact accepted for a closed
/// shift (which marks it `late_data_at`), changes the shift's row: the batch
/// takes one host revision for all of them (`revision`, taken on first need)
/// and stamps it on the row, so the caller commits with it.
pub async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<FactReceipt, ApiError> {
    let id = value
        .get("id")
```

6. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
            ));
        }
    }
    let applying = apply(conn, device_id, value, received_at).await?;
    let receipt = match applying.answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
```

заменить на

<!-- prettier-ignore -->
```rust
            ));
        }
    }
    let applying = apply(conn, device_id, value, received_at, revision).await?;
    let receipt = match applying.answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
```

7. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<Applying, ApiError> {
    let Ok(record) = serde_json::from_value::<FactRecord>(value.clone()) else {
        return Ok(Applying::refused(
```

заменить на

<!-- prettier-ignore -->
```rust
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<Applying, ApiError> {
    let Ok(record) = serde_json::from_value::<FactRecord>(value.clone()) else {
        return Ok(Applying::refused(
```

8. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
        FactKind::BoxLabel => box_label::apply(conn, &context, &record.data).await,
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
```

заменить на

<!-- prettier-ignore -->
```rust
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
        FactKind::BoxLabel => box_label::apply(conn, &context, &record.data).await,
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => {
            match &applied.close {
                Some(close) => close_shift(conn, &context, close, revision).await?,
                None if shift.status == ShiftStatus::Closed
                    && record.kind != FactKind::ShiftClosed =>
                {
                    mark_late(conn, &context, revision).await?
                }
                None => {}
            }
            Ok(applied)
        }
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
```

9. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
    })))
}
```

заменить на

<!-- prettier-ignore -->
```rust
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
    })))
}

/// The batch's revision, taken on first need: one revision for every shift
/// row the batch changes.
async fn batch_revision(
    conn: &mut SqliteConnection,
    revision: &mut Option<i64>,
) -> Result<i64, ApiError> {
    match revision {
        Some(rev) => Ok(*rev),
        None => {
            let rev = next_revision(conn).await.map_err(ApiError::internal)?;
            *revision = Some(rev);
            Ok(rev)
        }
    }
}

/// A station's close of its active shift: the shift closes with the
/// station's instant and reason code, and the audit row names the station.
async fn close_shift(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    close: &CloseShift,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    let rev = batch_revision(&mut *conn, revision).await?;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ?, close_reason_code = ?, rev = ? WHERE id = ?",
    )
    .bind(&close.closed_at)
    .bind(context.device_id)
    .bind(&close.reason_code)
    .bind(rev)
    .bind(&context.shift.id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        conn,
        context.received_at,
        Entry {
            actor: Actor::Device(context.device_id),
            action: actions::SHIFT_CLOSE,
            target_type: Some("shift"),
            target_id: Some(&context.shift.id),
            outcome: Outcome::Ok,
            details: close.audit.clone(),
        },
    )
    .await
    .map_err(ApiError::internal)
}

/// The first fact accepted for a closed shift marks it late, once.
async fn mark_late(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    let unmarked: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ? AND late_data_at IS NULL")
            .bind(&context.shift.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if unmarked.is_none() {
        return Ok(());
    }
    let rev = batch_revision(&mut *conn, revision).await?;
    sqlx::query("UPDATE shifts SET late_data_at = ?, rev = ? WHERE id = ?")
        .bind(context.received_at)
        .bind(rev)
        .bind(&context.shift.id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}
```

10. В `apps/standalone/host/src/facts/registry.rs` фрагмент

<!-- prettier-ignore -->
```rust
            return Ok(Applied {
                outcome: FactOutcome::Conflict,
                details: Some(serde_json::json!({ "winner": winner })),
            });
        }
        Some(owner) => {
```

заменить на

<!-- prettier-ignore -->
```rust
            return Ok(Applied {
                outcome: FactOutcome::Conflict,
                details: Some(serde_json::json!({ "winner": winner })),
                close: None,
            });
        }
        Some(owner) => {
```

11. Создать `apps/standalone/host/src/facts/shift_closed.rs`:

<!-- prettier-ignore -->
```rust
//! `shift_closed` facts (stage 2a spec, decision 17): a station closed its
//! shift; its local close is the point of no return, so the host takes it
//! whenever it arrives. An active shift closes (the batch writes the close,
//! `facts::receive`); a shift the office closed first answers `accepted`
//! with `alreadyClosed`. Every close is kept in `shift_close_events`.

use markiro_proto::{shift_close_reasons, ShiftClosedFact, ShiftStatus};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use super::{rules, Applied, CloseShift, Context, Failure, Reject};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: ShiftClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let closed_at =
        rules::device_instant(&closed.closed_at).ok_or_else(|| Reject::field("data.closedAt"))?;
    if closed
        .planned_qty_snapshot
        .is_some_and(|planned| !(1..=validate::MAX_PLANNED_QTY).contains(&planned))
    {
        return Err(Reject::field("data.plannedQtySnapshot").into());
    }
    match closed.reason_code.as_deref() {
        Some(code) if !shift_close_reasons::ALL.contains(&code) => {
            return Err(Reject::field("data.reasonCode").into());
        }
        None if rules::close_reason_required(closed.planned_qty_snapshot, closed.actual_qty) => {
            return Err(Reject::field("data.reasonCode").into());
        }
        _ => {}
    }
    let closes = context.shift.status == ShiftStatus::Active;
    sqlx::query(
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(closed.planned_qty_snapshot)
    .bind(closed.actual_qty)
    .bind(closed.closed_box_count)
    .bind(&closed.reason_code)
    .bind(&closed.closed_at)
    .bind(if closes { "accepted" } else { "already_closed" })
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if !closes {
        return Ok(Applied {
            details: Some(json!({ "alreadyClosed": true })),
            ..Applied::accepted()
        });
    }
    // The shift's column keeps the host's format: whole seconds, UTC.
    Ok(Applied {
        close: Some(CloseShift {
            closed_at: format_timestamp(closed_at),
            reason_code: closed.reason_code.clone(),
            audit: json!({
                "actualQty": closed.actual_qty,
                "plannedQty": closed.planned_qty_snapshot,
                "closedBoxCount": closed.closed_box_count,
                "reasonCode": closed.reason_code,
            }),
        }),
        ..Applied::accepted()
    })
}
```

12. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! facts, applied in one write transaction, each record on its own
//! (`facts::receive`), answered with a receipt per record in their order.
//! A database error is no receipt: nothing of the batch stays, and the
//! device sends it again.

use axum::extract::State;
use axum::Json;
```

заменить на

<!-- prettier-ignore -->
```rust
//! facts, applied in one write transaction, each record on its own
//! (`facts::receive`), answered with a receipt per record in their order.
//! A database error is no receipt: nothing of the batch stays, and the
//! device sends it again. Facts take no revision, but a station's close of
//! its shift and a closed shift's first late fact change the shift's row:
//! the batch then takes one revision for all of them.

use axum::extract::State;
use axum::Json;
```

13. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::facts;
use crate::server::AppState;
```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision};
use crate::error::{ApiError, ApiJson};
use crate::facts;
use crate::server::AppState;
```

14. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
    let mut receipts = Vec::with_capacity(batch.records.len());
    for record in &batch.records {
        receipts.push(facts::receive(&mut tx, &device.id, record, &received_at).await?);
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
```

заменить на

<!-- prettier-ignore -->
```rust
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
    let mut receipts = Vec::with_capacity(batch.records.len());
    let mut revision = None;
    for record in &batch.records {
        receipts
            .push(facts::receive(&mut tx, &device.id, record, &received_at, &mut revision).await?);
    }
    // A batch that closed a shift or marked one late took a revision, so
    // the streams wake and stations read their shifts again.
    match revision {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
        None => tx.commit().await,
    }
    .map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
```

15. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    BoxClosed,
    BoxLabel,
    BoxException,
}

impl FactKind {
```

заменить на

<!-- prettier-ignore -->
```rust
    BoxClosed,
    BoxLabel,
    BoxException,
    ShiftClosed,
}

impl FactKind {
```

16. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::BoxClosed => "box_closed",
            FactKind::BoxLabel => "box_label",
            FactKind::BoxException => "box_exception",
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::BoxClosed => "box_closed",
            FactKind::BoxLabel => "box_label",
            FactKind::BoxException => "box_exception",
            FactKind::ShiftClosed => "shift_closed",
        }
    }
}
```

17. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

/// How the host answered a record.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

/// `data` of a `shift_closed` fact: a station closed its shift. The numbers
/// are the station's summary; a reason of [`shift_close_reasons`] is needed
/// when the plan the station saw (`plannedQtySnapshot`) was set and differs
/// from `actualQty` (the domain's `shiftCloseReasonRequired`). The answer to
/// the close of a shift the office closed first is `accepted` with
/// `details.alreadyClosed: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftClosedFact {
    pub planned_qty_snapshot: Option<u32>,
    pub actual_qty: u32,
    pub closed_box_count: u32,
    pub reason_code: Option<String>,
    pub closed_at: String,
}

/// How the host answered a record.
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --test codes --offline --locked`
Expected: PASS — `codes` 3 теста, `facts` 19 тестов.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
A record is checked whole before its first write, so a refusal leaves
nothing but its receipt; a database error is no receipt, it fails the batch
(500, `internal`), and the device sends the batch again. Facts are
production data: they take no revision and write no audit row.

A `scan` (`facts/scan.rs`) is a journal row (`scans`) whatever its verdict;
an `invalid` one keeps no code, only what it looked like (`rawKind`) and its
```

заменить на

<!-- prettier-ignore -->
```text
A record is checked whole before its first write, so a refusal leaves
nothing but its receipt; a database error is no receipt, it fails the batch
(500, `internal`), and the device sends the batch again. Facts are
production data: they take no revision and write no audit row, but for a
station's close of its shift (below).

A `scan` (`facts/scan.rs`) is a journal row (`scans`) whatever its verdict;
an `invalid` one keeps no code, only what it looked like (`rawKind`) and its
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
get `removed_at` (the station's instant), and their codes leave the
registry (`registry::release`), free for another scan; a disassembly sets
`disassembled_at` and the box keeps its SSCC, which no other box takes.

## Marking rules

```

заменить на

<!-- prettier-ignore -->
```text
get `removed_at` (the station's instant), and their codes leave the
registry (`registry::release`), free for another scan; a disassembly sets
`disassembled_at` and the box keeps its SSCC, which no other box takes.

A `shift_closed` (`facts/shift_closed.rs`) is a station's close of its
shift, the summary it showed (`plannedQtySnapshot`, `actualQty`,
`closedBoxCount`) and a reason code of `shift_close_reasons`, required when
the plan it saw was set and differs from the fact
(`rules::close_reason_required`; `invalid_record` on `data.reasonCode`); a
reason the plan did not call for is kept, as in the cloud. An active shift
closes: `status = closed`, `closed_at` the station's instant in the host's
format (whole seconds), `closed_by_kind = device`, `closed_by` the station,
`close_reason_code`, and the audit row `shift.close` with the station as
actor and `{ actualQty, plannedQty, closedBoxCount, reasonCode }`. A shift
the office closed first answers `accepted` with `details.alreadyClosed:
true`. Every close is kept in `shift_close_events` (`accepted` or
`already_closed`). Any other fact accepted (or `conflict`) for a closed
shift is taken and marks it late once (`late_data_at`, the host's clock); a
refused one marks nothing. Closing a shift and marking it late change the
shift's row, so the batch takes one host revision for all such changes
(taken on first need, stamped on each changed row) and commits through
`commit_with_revision`, which wakes the streams; a batch that changes no
shift takes none.

## Marking rules

```

- [ ] **Step 6: Мутации**

М1 — закрытие не пишется. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
                Some(close) => close_shift(conn, &context, close, revision).await?,
```

заменить на

<!-- prettier-ignore -->
```rust
                Some(_) => {}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_that_closes_its_shift_takes_one_revision`, `a_close_names_a_reason_when_the_fact_differs_from_the_plan`, `a_station_closes_its_shift_once_and_the_office_sees_it_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — closed_at смены в формате устройства. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
            closed_at: format_timestamp(closed_at),
```

заменить на

<!-- prettier-ignore -->
```rust
            closed_at: { let _ = format_timestamp(closed_at); closed.closed_at.clone() },
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_that_closes_its_shift_takes_one_revision`, `a_station_closes_its_shift_once_and_the_office_sees_it_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — журнал без плана. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
                "actualQty": closed.actual_qty,
                "plannedQty": closed.planned_qty_snapshot,
```

заменить на

<!-- prettier-ignore -->
```rust
                "actualQty": closed.actual_qty,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — ревизия на каждое изменение. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(rev) => Ok(*rev),
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(_) => next_revision(conn).await.map_err(ApiError::internal),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_that_closes_its_shift_takes_one_revision`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — поздняя отметка каждый раз. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ? AND late_data_at IS NULL")
```

заменить на

<!-- prettier-ignore -->
```rust
        sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ?")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `facts_of_a_closed_shift_are_taken_and_mark_it_late_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — собственное закрытие — поздние данные. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
                None if shift.status == ShiftStatus::Closed
                    && record.kind != FactKind::ShiftClosed =>
```

заменить на

<!-- prettier-ignore -->
```rust
                None if shift.status == ShiftStatus::Closed =>
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — поздняя отметка у активной смены. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
                None if shift.status == ShiftStatus::Closed
                    && record.kind != FactKind::ShiftClosed =>
```

заменить на

<!-- prettier-ignore -->
```rust
                None if record.kind != FactKind::ShiftClosed =>
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_batch_is_answered_record_by_record_and_kept_once`, `a_station_closes_its_shift_once_and_the_office_sees_it_closed`, `facts_of_a_closed_shift_are_taken_and_mark_it_late_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — потоки не просыпаются. В `apps/standalone/host/src/routes/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(_) => tx.commit().await,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`, `facts_of_a_closed_shift_are_taken_and_mark_it_late_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — причина не требуется. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        None if rules::close_reason_required(closed.planned_qty_snapshot, closed.actual_qty) => {
```

заменить на

<!-- prettier-ignore -->
```rust
        None if false => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_close_names_a_reason_when_the_fact_differs_from_the_plan`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — любой код причины. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(code) if !shift_close_reasons::ALL.contains(&code) => {
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(code) if code.is_empty() => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_close_names_a_reason_when_the_fact_differs_from_the_plan`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — наибольший план отвергается. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .is_some_and(|planned| !(1..=validate::MAX_PLANNED_QTY).contains(&planned))
```

заменить на

<!-- prettier-ignore -->
```rust
        .is_some_and(|planned| !(1..validate::MAX_PLANNED_QTY).contains(&planned))
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_close_names_a_reason_when_the_fact_differs_from_the_plan`. Восстановить файл, `cmp` молчит, хеш прежний.

М12 — исход события закрытия. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(if closes { "accepted" } else { "already_closed" })
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind("accepted")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`. Восстановить файл, `cmp` молчит, хеш прежний.

М13 — alreadyClosed не сообщается. В `apps/standalone/host/src/facts/shift_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
            details: Some(json!({ "alreadyClosed": true })),
```

заменить на

<!-- prettier-ignore -->
```rust
            details: None,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`, `facts_of_a_closed_shift_are_taken_and_mark_it_late_once`. Восстановить файл, `cmp` молчит, хеш прежний.

М14 — поздняя отметка без ревизии строки. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE shifts SET late_data_at = ?, rev = ? WHERE id = ?")
```

заменить на

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE shifts SET late_data_at = ?, rev = rev + 0 * ? WHERE id = ?")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `facts_of_a_closed_shift_are_taken_and_mark_it_late_once`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request.json apps/standalone/proto/fixtures/facts-response.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/shift_closed.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/registry.rs apps/standalone/host/src/routes/facts.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/codes.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request.json apps/standalone/proto/fixtures/facts-response.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a station's close of its shift and the late facts of a closed shift" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Итоги смены — `totals` в каждом `OfficeShift`

Офис видит смену числами (§4.5, §5.6): принято единиц, коробов закрыто и открыто, время последнего факта, устройства смены. Итоги читаются подзапросами того же `SELECT`, которым офис читает смену, поэтому они есть в списке, в `GET …/{id}` и в ответе каждой записи офиса, и ничего не хранится (нечему расходиться). Подзапросы обслуживают индексы `0010` (`boxes_shift`, частичный `box_items_live`, `fact_receipts_shift`). Вспомогательная `planned(...)` в `office_shifts.rs` получает нулевые итоги: смена без фактов. Устройства идут по первому входу; тест порядка ставит второго участника напрямую (второе устройство на смене — 2b) так, чтобы «по первому входу» не совпадало ни с порядком id, ни с порядком строк.

**Files:**

- Modify: `apps/standalone/host/src/routes/office_shifts.rs`, `apps/standalone/proto/src/lib.rs` (`ShiftTotals`, `OfficeShift::totals`), `apps/standalone/proto/fixtures/office-shift.json`
- Test: `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/office_shifts.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: таблицы `0010`; `OfficeShift` (2a1).
- Produces: `markiro_proto::ShiftTotals { accepted_units: u64, closed_boxes: u32, open_boxes: u32, last_fact_at: Option<String>, device_ids: Vec<String> }`; поле `OfficeShift::totals: ShiftTotals` (обязательное, в каждом ответе).

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ])
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
        ])
    );
}

/// The office's totals of `shift`: by `GET …/{id}`, and the same in the list.
async fn totals(admin: &Admin, shift: &str) -> Value {
    let (status, read) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|listed| listed["id"] == json!(shift))
        .expect("the list holds the shift");
    assert_eq!(listed["totals"], read["totals"]);
    read["totals"].clone()
}

#[tokio::test]
async fn the_office_reads_a_shifts_totals_from_its_facts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let none = json!({
        "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
        "deviceIds": []
    });
    assert_eq!(totals(&admin, planned["id"].as_str().unwrap()).await, none);
    let mut entered = none.clone();
    entered["deviceIds"] = json!([floor.station]);
    assert_eq!(totals(&admin, &floor.shift).await, entered);
    let shift = floor.shift.as_str();
    let scan = |n: u32, box_n: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(box_n), &instant(n, 0)),
        )
    };
    let undo = |n: u32, code: u32, box_n: u32| {
        let mut data = box_exception("undo", &box_id(box_n), &instant(100 + n, 0));
        data["codeHash"] = json!(code_hash(code));
        data["targetScannedAt"] = json!(instant(code, 0));
        fact(&record_id(n), "box_exception", shift, data)
    };
    // Box 1 holds 1–3 and closes; box 2 holds 4 and 5, and 5 is undone; box
    // 3 holds 6, undone, so it is open but empty; box 4 holds 7, closes and
    // is taken apart; a scan that is no code counts nothing.
    let batch = vec![
        scan(1, 1),
        scan(2, 1),
        scan(3, 1),
        fact(
            &record_id(20),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2, 3],
                &instant(1, 0),
                &instant(10, 0),
            ),
        ),
        scan(4, 2),
        scan(5, 2),
        undo(21, 5, 2),
        scan(6, 3),
        undo(22, 6, 3),
        scan(7, 4),
        fact(
            &record_id(23),
            "box_closed",
            shift,
            box_closed(
                &box_id(4),
                &block,
                1501,
                &[7],
                &instant(7, 0),
                &instant(11, 0),
            ),
        ),
        fact(&record_id(24), "box_exception", shift, {
            let mut data = box_exception("disassemble", &box_id(4), &instant(12, 0));
            data["reasonCode"] = json!("wrong_quantity");
            data
        }),
        fact(
            &record_id(25),
            "scan",
            shift,
            other_scan(
                "invalid",
                "unknown",
                Value::Null,
                Value::Null,
                &instant(13, 0),
            ),
        ),
    ];
    admin.app.clock.advance(time::Duration::minutes(5));
    let first_batch = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(
        totals(&admin, shift).await,
        json!({
            "acceptedUnits": 4, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": first_batch,
            "deviceIds": [floor.station]
        })
    );
    // The colleague's earlier scan of code 2 takes it out of box 1; a record
    // the host refuses still tells when the station last sent one.
    admin.app.clock.advance(time::Duration::minutes(5));
    let second_batch = admin.app.state.timestamp();
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(30),
            "scan",
            &colleague.shift,
            ok_scan(2, &box_id(9), &instant(0, 0)),
        )],
    )
    .await;
    let mut wrong = ok_scan(8, &box_id(2), &instant(8, 0));
    wrong["code"]["gtin14"] = json!("04600682000099");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(31), "scan", shift, wrong)]
        )
        .await,
        vec![rejected(Some(&record_id(31)), "gtin_mismatch", None)]
    );
    assert_eq!(
        totals(&admin, shift).await,
        json!({
            "acceptedUnits": 3, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [floor.station]
        })
    );
    assert_eq!(
        totals(&admin, &colleague.shift).await,
        json!({
            "acceptedUnits": 1, "closedBoxes": 0, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [colleague.station]
        })
    );
    // The devices come first entry first. A second device on a shift comes
    // with plan 2b, so its entry is put in directly: a device whose id sorts
    // after the station's, entered before it, so that first entry first is
    // neither the order of the ids nor the order of the rows.
    let mut other = colleague.station.clone();
    for _ in 0..64 {
        if other > floor.station {
            break;
        }
        other = pair_device(&admin.app, "station").await.0;
    }
    assert!(other > floor.station);
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, '2026-09-21T14:00:00Z', '2026-09-21T14:00:00Z')",
    )
    .bind(shift)
    .bind(&other)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        totals(&admin, shift).await["deviceIds"],
        json!([other, floor.station])
    );
    // A record without a readable shift belongs to no shift's totals.
    admin.app.clock.advance(time::Duration::minutes(5));
    let mut unknown = scan(40, 2);
    unknown["shiftId"] = json!("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
    receipts(&admin.app, &floor.key, &[unknown]).await;
    assert_eq!(
        totals(&admin, shift).await["lastFactAt"],
        json!(second_batch)
    );
}
```

2. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
};

/// The record of `shift_body(setup)` planned at `rev`: the product's box
/// capacity, no plan and no counterparty.
fn planned(id: &str, number: &str, setup: &ShiftSetup, rev: i64) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
```

заменить на

<!-- prettier-ignore -->
```rust
};

/// The record of `shift_body(setup)` planned at `rev`: the product's box
/// capacity, no plan and no counterparty, and no facts yet.
fn planned(id: &str, number: &str, setup: &ShiftSetup, rev: i64) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
```

3. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
        "rev": rev
    })
}

```

заменить на

<!-- prettier-ignore -->
```rust
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
        "rev": rev,
        "totals": {
            "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
            "deviceIds": []
        }
    })
}

```

4. В `apps/standalone/proto/fixtures/office-shift.json` фрагмент

<!-- prettier-ignore -->
```json
  "closeReasonText": null,
  "lateDataAt": null,
  "createdAt": "2026-10-07T15:30:00Z",
  "rev": 71
}
```

заменить на

<!-- prettier-ignore -->
```json
  "closeReasonText": null,
  "lateDataAt": null,
  "createdAt": "2026-10-07T15:30:00Z",
  "rev": 71,
  "totals": {
    "acceptedUnits": 540,
    "closedBoxes": 45,
    "openBoxes": 1,
    "lastFactAt": "2026-10-08T09:41:07Z",
    "deviceIds": ["7c9e6679-7425-40de-944b-e07fc1f90ae7"]
  }
}
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            ShiftOrigin::Office
        )
    );
    let create: ShiftCreate = round_trip("shift-create.json");
    assert_eq!(
        (&create.product_id, &create.line_id, &create.box_template_id),
```

заменить на

<!-- prettier-ignore -->
```rust
            ShiftOrigin::Office
        )
    );
    // The owner entered it, so it is among the shift's devices.
    assert_eq!(
        shift.totals.device_ids,
        vec![shift.owner_device_id.clone().unwrap()]
    );
    let create: ShiftCreate = round_trip("shift-create.json");
    assert_eq!(
        (&create.product_id, &create.line_id, &create.box_template_id),
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --test office_shifts --no-fail-fast --offline --locked`
Expected: FAIL — `facts`: 19 проходят, падает `the_office_reads_a_shifts_totals_from_its_facts`; `office_shifts`: 20 проходят, падают `an_administrator_plans_a_shift_and_reads_it_back`, `a_planned_shift_changes_what_is_sent_and_keeps_its_number` и `a_planned_shifts_template_change_is_stored_read_back_and_audited` (у ответа ещё нет `totals`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! `expectedRev`), `DELETE …/{id}` and `POST …/{id}/close` (administrators
//! and technologists, `planShifts`). A shift is no feed record: every change
//! still takes a host revision, so open streams wake and stations read their
//! shifts again (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftClose, ShiftCreate, ShiftMode, ShiftStatus, ShiftUpdate};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

заменить на

<!-- prettier-ignore -->
```rust
//! `expectedRev`), `DELETE …/{id}` and `POST …/{id}/close` (administrators
//! and technologists, `planShifts`). A shift is no feed record: every change
//! still takes a host revision, so open streams wake and stations read their
//! shifts again (`GET /v1/device/shifts`). Every answer carries the shift's
//! totals, which its facts give (plan 2a2): they are read, never stored.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    OfficeShift, ShiftClose, ShiftCreate, ShiftMode, ShiftStatus, ShiftTotals, ShiftUpdate,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;
```

2. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use crate::shifts::{self, NewShift};
use crate::validate;

const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, owner_device_id, opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev FROM shifts";

#[derive(sqlx::FromRow)]
struct ShiftRow {
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::shifts::{self, NewShift};
use crate::validate;

/// The columns of an office shift, its totals (plan 2a2) included: each a
/// subquery over the shift's facts, served by the indexes of `0010`.
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, owner_device_id, opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev, \
     (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
      WHERE b.shift_id = shifts.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      AS accepted_units, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = shifts.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed_boxes, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = shifts.id AND b.closed_at IS NULL \
      AND EXISTS (SELECT 1 FROM box_items i WHERE i.box_id = b.id \
                  AND i.removed_at IS NULL AND i.displaced_at IS NULL)) AS open_boxes, \
     (SELECT MAX(r.received_at) FROM fact_receipts r WHERE r.shift_id = shifts.id) \
      AS last_fact_at, \
     (SELECT json_group_array(p.device_id ORDER BY p.first_entered_at, p.device_id) \
      FROM shift_participants p WHERE p.shift_id = shifts.id) AS device_ids \
     FROM shifts";

#[derive(sqlx::FromRow)]
struct ShiftRow {
```

3. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    late_data_at: Option<String>,
    created_at: String,
    rev: i64,
}

fn record(row: ShiftRow) -> Result<OfficeShift, ApiError> {
```

заменить на

<!-- prettier-ignore -->
```rust
    late_data_at: Option<String>,
    created_at: String,
    rev: i64,
    accepted_units: i64,
    closed_boxes: i64,
    open_boxes: i64,
    last_fact_at: Option<String>,
    /// A JSON array of ids.
    device_ids: String,
}

fn record(row: ShiftRow) -> Result<OfficeShift, ApiError> {
```

4. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        late_data_at: row.late_data_at,
        created_at: row.created_at,
        rev: row.rev,
    })
}

```

заменить на

<!-- prettier-ignore -->
```rust
        late_data_at: row.late_data_at,
        created_at: row.created_at,
        rev: row.rev,
        totals: ShiftTotals {
            accepted_units: u64::try_from(row.accepted_units).map_err(ApiError::internal)?,
            closed_boxes: u32::try_from(row.closed_boxes).map_err(ApiError::internal)?,
            open_boxes: u32::try_from(row.open_boxes).map_err(ApiError::internal)?,
            last_fact_at: row.last_fact_at,
            device_ids: serde_json::from_str(&row.device_ids).map_err(ApiError::internal)?,
        },
    })
}

```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// A shift as the office sees it (`GET /v1/office/shifts`, `GET …/{id}` and
/// the answer of every office write). `number` is the host's
/// (`OCT26-004`, `/S` for a station's). Names come from the office's own
/// lists of products, lines and counterparties.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShift {
```

заменить на

<!-- prettier-ignore -->
```rust
/// A shift as the office sees it (`GET /v1/office/shifts`, `GET …/{id}` and
/// the answer of every office write). `number` is the host's
/// (`OCT26-004`, `/S` for a station's). Names come from the office's own
/// lists of products, lines and counterparties; `totals` from the facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShift {
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub late_data_at: Option<String>,
    pub created_at: String,
    pub rev: i64,
}

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
```

заменить на

<!-- prettier-ignore -->
```rust
    pub late_data_at: Option<String>,
    pub created_at: String,
    pub rev: i64,
    /// What the facts of the shift add up to (plan 2a2), in every answer.
    pub totals: ShiftTotals,
}

/// A shift's numbers as its facts give them (stage 2a spec §4.5): units
/// accepted (items in a box, neither taken out by an exception nor taken by
/// an earlier scan elsewhere), boxes closed and not taken apart, open boxes
/// that hold a unit, when the host last received a record of the shift, and
/// the devices that entered it, first entry first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftTotals {
    pub accepted_units: u64,
    pub closed_boxes: u32,
    pub open_boxes: u32,
    pub last_fact_at: Option<String>,
    pub device_ids: Vec<String>,
}

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --test office_shifts --offline --locked`
Expected: PASS — `facts` 20, `office_shifts` 23 теста.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43 теста.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`commit_with_revision`, which wakes the streams; a batch that changes no
shift takes none.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```text
`commit_with_revision`, which wakes the streams; a batch that changes no
shift takes none.

Every `OfficeShift` — the list, `GET …/{id}` and the answer of every office
write — carries `totals` (`ShiftTotals`), read from the facts by subqueries
of `routes/office_shifts.rs` and never stored: `acceptedUnits` (box items
neither removed nor displaced), `closedBoxes` (closed and not taken apart),
`openBoxes` (open boxes that hold a live item: a box emptied by undos is not
counted), `lastFactAt` (the host's clock at the last receipt of a record that
named the shift and got past the entry check, refused ones included) and
`deviceIds` (the shift's participants, first entry first). A planned shift's
totals are zeros, `null` and `[]`.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

- [ ] **Step 6: Мутации**

М1 — снятые позиции считаются. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      WHERE b.shift_id = shifts.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
```

заменить на

<!-- prettier-ignore -->
```rust
      WHERE b.shift_id = shifts.id AND i.displaced_at IS NULL) \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — вытесненные позиции считаются. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      WHERE b.shift_id = shifts.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
```

заменить на

<!-- prettier-ignore -->
```rust
      WHERE b.shift_id = shifts.id AND i.removed_at IS NULL) \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — расформированный короб считается. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed_boxes, \
```

заменить на

<!-- prettier-ignore -->
```rust
      AND b.closed_at IS NOT NULL) AS closed_boxes, \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — пустой открытый короб считается. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      AND EXISTS (SELECT 1 FROM box_items i WHERE i.box_id = b.id \
```

заменить на

<!-- prettier-ignore -->
```rust
      AND 1 OR EXISTS (SELECT 1 FROM box_items i WHERE i.box_id = b.id \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — lastFactAt без отклонённых. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT MAX(r.received_at) FROM fact_receipts r WHERE r.shift_id = shifts.id) \
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT MAX(r.received_at) FROM fact_receipts r WHERE r.shift_id = shifts.id AND r.outcome <> 'rejected') \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — устройства без порядка входа. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT json_group_array(p.device_id ORDER BY p.first_entered_at, p.device_id) \
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT json_group_array(p.device_id) \
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_totals_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/office-shift.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-shift.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): the office reads a shift's totals from its facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Журнал процесса с фактами; уточнения в спецификации; полная проверка

Код маркировки не секрет, но правило журналов (§4.11) не пускает в журнал процесса ни кодов, ни их криптохвостов, ни хешей, ни SSCC. `no_secrets_in_logs.rs` проводит через настоящий сервер пачку фактов: скан с кодом, у которого есть криптохвост, закрытие его короба с SSCC, скан чужого товара (отказ пишется в журнал), запись с прежним `id` и другим содержимым (`payload_mismatch`, тоже в журнале) и проверку кода — и сверяет, что хост код и SSCC сохранил, а журнал их не содержит, но коды квитанций содержит (иначе отсутствие ничего бы не доказывало). Код хоста не меняется: тест проходит сразу и служит ограждением, а мутации М1 и М2 показывают, что он ловит код в журнале. Решения планировщика записываются в спецификацию 2a (§16).

**Files:**

- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`
- Modify: `apps/standalone/AGENTS.md` («Logs»), `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (новый §16)

**Interfaces:**

- Consumes: маршруты задач 2–4; `markiro_host::facts::rules::box_membership_digest`.
- Produces: —

- [ ] **Step 1: Тест**

1. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Its own binary, because it installs the global tracing
//! subscriber.

mod support;

```

заменить на

<!-- prettier-ignore -->
```rust
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash or a box's SSCC (stage 2a spec §4.11): a rejected record is logged
//! by its id and its receipt code alone. Its own binary, because it
//! installs the global tracing subscriber.

mod support;

```

2. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(block.status(), 200);
    let opened: serde_json::Value = client
        .get(format!("{base}/v1/office/shifts/{shift_id}"))
        .header(protocol.0, &protocol.1)
```

заменить на

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(block.status(), 200);
    let block: serde_json::Value = block.json().await.unwrap();

    // Facts (plan 2a2): a scan with a code whose canonical text carries a
    // crypto tail, the close of its box with an SSCC, a scan of another
    // product the host refuses, a record sent again with other content, and
    // the code asked for. None of the codes, tails, hashes or the SSCC
    // reaches the log.
    let canonical = "0104600682000020215Kp9sQx\u{1d}91EE11\u{1d}92crypto-tail-marker-1";
    let refused_canonical = "0104600682000099215Rf2wLz\u{1d}92crypto-tail-marker-2";
    let code_hash = "f00dcafe".repeat(8);
    let box_id = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
    let sscc = "046006820000000013";
    let scan = json!({
        "id": "5d2c8f0a-3b1e-4c7d-9a6f-0e2b4c6d8f10", "kind": "scan", "shiftId": shift_id,
        "operatorId": null,
        "data": {
            "scannedAt": "2026-10-08T06:15:02.418Z", "verdict": "ok", "duplicateSource": null,
            "rawKind": "km", "rawLength": 57, "boxId": box_id,
            "code": {
                "codeHash": code_hash, "gtin14": "04600682000020", "serial": "5Kp9sQx",
                "canonical": canonical
            }
        }
    });
    let mut refused = scan.clone();
    refused["id"] = json!("6e3d9a1b-4c2f-4d8e-8b7a-1f3c5d7e9a21");
    refused["data"]["code"] = json!({
        "codeHash": "beefc0de".repeat(8), "gtin14": "04600682000099", "serial": "5Rf2wLz",
        "canonical": refused_canonical
    });
    let mut changed = scan.clone();
    changed["data"]["rawLength"] = json!(58);
    let closed_box = json!({
        "id": "7a4f0c2d-5e3b-4f9a-8c6d-2e4f6a8b0c32", "kind": "box_closed", "shiftId": shift_id,
        "operatorId": null,
        "data": {
            "boxId": box_id, "sscc": sscc, "blockId": block["id"], "serial": 1,
            "openedAt": "2026-10-08T06:15:02.418Z", "closedAt": "2026-10-08T06:21:47.302Z",
            "itemCount": 1, "membershipDigest": markiro_host::facts::rules::box_membership_digest(&[code_hash.clone()])
        }
    });
    for records in [vec![scan, refused, closed_box], vec![changed]] {
        let sent = client
            .post(format!("{base}/v1/device/facts"))
            .header(protocol.0, &protocol.1)
            .bearer_auth(&key)
            .json(&json!({ "records": records }))
            .send()
            .await
            .unwrap();
        assert_eq!(sent.status(), 200);
    }
    let checked = client
        .get(format!("{base}/v1/device/codes/{code_hash}"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(checked.status(), 200);

    let opened: serde_json::Value = client
        .get(format!("{base}/v1/office/shifts/{shift_id}"))
        .header(protocol.0, &protocol.1)
```

3. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .unwrap();
    let snapshots: Vec<String> =
        sqlx::query_scalar("SELECT snapshot FROM shifts WHERE snapshot IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
```

заменить на

<!-- prettier-ignore -->
```rust
        .unwrap();
    let snapshots: Vec<String> =
        sqlx::query_scalar("SELECT snapshot FROM shifts WHERE snapshot IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let kept_codes: Vec<String> = sqlx::query_scalar("SELECT canonical FROM scans")
        .fetch_all(&pool)
        .await
        .unwrap();
    let kept_ssccs: Vec<String> =
        sqlx::query_scalar("SELECT sscc FROM boxes WHERE sscc IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
```

4. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .any(|snapshot| snapshot.contains("layout-marker-office-2")),
        "the shift never froze the layout"
    );
}
```

заменить на

<!-- prettier-ignore -->
```rust
            .any(|snapshot| snapshot.contains("layout-marker-office-2")),
        "the shift never froze the layout"
    );
    // The host kept the accepted code and the SSCC, and logged the refusals
    // by their receipt codes: their absence from the log proves something.
    assert_eq!(kept_codes, vec![canonical.to_owned()]);
    assert_eq!(kept_ssccs, vec![sscc.to_owned()]);
    assert!(log.contains("gtin_mismatch") && log.contains("payload_mismatch"));
    for marking in [
        canonical,
        refused_canonical,
        "crypto-tail-marker",
        "5Kp9sQx",
        "5Rf2wLz",
        &code_hash,
        &"beefc0de".repeat(8),
        sscc,
    ] {
        assert!(
            !log.contains(marking),
            "the process log contains {marking:?}"
        );
    }
}
```

- [ ] **Step 2: Запустить тест — он проходит**

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: PASS — 1 тест (код уже не пишет кодов в журнал; доказательство — мутации М1 и М2).

- [ ] **Step 3: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
walks a stock and an office layout through the template routes, the
defaults and the feed, and a shift's snapshot that carries a layout through
the plan, the station's entry and list, an SSCC block and the office's
close. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

заменить на

<!-- prettier-ignore -->
```text
walks a stock and an office layout through the template routes, the
defaults and the feed, and a shift's snapshot that carries a layout through
the plan, the station's entry and list, an SSCC block and the office's
close. Nor do facts reach it (stage 2a spec §4.11): no code of marking, crypto
tail, code hash or SSCC — a refused record is logged by the device, its id
and its receipt code alone; `no_secrets_in_logs.rs` sends a code with a
crypto tail, a box's SSCC, a refused scan and a mismatched resend, and asks
for the code. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

2. В `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` фрагмент

<!-- prettier-ignore -->
```text
  `login` с `details.similarLogin` (вопрос В13, рекомендованный вариант).
- `PROTOCOL_VERSION` → 2 уже в 2a1 — вместе с тестами пробы хоста в оболочке и зеркалом в
  `src/host/protocol.ts`, хотя маршрутами протокола 2 станция начнёт пользоваться в плане 2a5.
```

заменить на

<!-- prettier-ignore -->
```text
  `login` с `details.similarLogin` (вопрос В13, рекомендованный вариант).
- `PROTOCOL_VERSION` → 2 уже в 2a1 — вместе с тестами пробы хоста в оболочке и зеркалом в
  `src/host/protocol.ts`, хотя маршрутами протокола 2 станция начнёт пользоваться в плане 2a5.

## 16. Уточнения плана 2a2

План `docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md` (хост: факты) уточняет
разделы 4.4–4.6 и 6 так; допущения по вопросам раздела 11 — рекомендованные варианты.

- Запись — конверт `FactRecord { id, kind, shiftId, operatorId, data }`; `data` хост читает по
  `kind` (`ScanFact`, `BoxClosedFact`, `BoxLabelFact`, `BoxExceptionFact`, `ShiftClosedFact`).
  Незнакомый вид — `invalid_record`, поэтому новые виды не меняют формы конверта.
- Квитанция — `FactReceipt { id, outcome, code?, details? }`: `invalid_record` с
  `details.field` (путь поля, `data.code.canonical`), когда запись читается; `conflict` с
  `details.winner` (`CodeOwner`, как в ответе проверки кода); `accepted` с
  `details.alreadyClosed: true` на закрытие уже закрытой смены. Запись без читаемого `id`
  (канонический UUID) не хранится, её квитанция — `id: null`; `payload_mismatch` не хранится.
- Время устройства — ровно то, что пишет `Date.toISOString` (`YYYY-MM-DDTHH:MM:SS.sssZ`),
  хранится как прислано (сравнение текста упорядочивает моменты); `shifts.closed_at` от станции —
  в формате хоста, с точностью до секунды (момент целиком — в `shift_close_events`).
- `box_items` — по строке на скан (`scan_id` — ключ), а не `(box_id, code_hash)`: снятый
  исключением код, отсканированный снова в тот же короб, иначе нарушил бы ключ; живой код в
  коробе один (частичный уникальный индекс). Строки хоста (`scans`, `box_exceptions`,
  `shift_close_events`) получают свои UUID и хранят `record_id`.
- Принятый скан открывает неизвестный короб (`opened_at` — время скана, закрытие заменяет его
  на `openedAt` станции), и скан, проигравший код (`conflict`), тоже: иначе закрытие короба
  получило бы `box_unknown`. Короб другого устройства или другой смены — `box_unknown`.
- `removed_at` — момент исключения на станции, `displaced_at` — часы хоста. `undo` кода, скан
  которого проиграл, принимается, ничего не снимает и хранится. Проверка этикетки
  расформированного короба принимается (он закрыт).
- Слова причины `other` — `validate::exception_reason_text` (обрезка, 1–200 символов, без
  управляющих).
- Закрытие станцией: причина нужна по плану, который видела станция (`plannedQtySnapshot`, 1–
  10 000 000 или `null`), а не по текущему плану хоста; причина без необходимости хранится, как
  в облаке.
- Поздние данные: `late_data_at` ставит первый принятый (или `conflict`) факт закрытой смены,
  кроме её `shift_closed`; отклонённая запись не ставит. Факты ревизии не берут, кроме пачки,
  которая закрыла смену или отметила её поздней: одна ревизия на пачку, штамп в `shifts.rev`,
  потоки просыпаются.
- `totals` (`ShiftTotals`) — в каждом `OfficeShift`, и в списке тоже (§5.6 показывает в списке
  принятые единицы и короба), читаются подзапросами, не хранятся: `acceptedUnits`,
  `closedBoxes` (без расформированных), `openBoxes` (открытые с живой позицией: опустевший
  после отмен короб не считается), `lastFactAt` (последняя квитанция записи, прошедшей проверку
  входа, отклонённые тоже), `deviceIds` (по первому входу).
- `POST /v1/device/facts` — любое устройство (§4.9), но мимо `not_entered` проходит только
  участник смены; устройство перечитывается в транзакции (`AuthDevice::require_live_in`,
  отозванное — 401; на нём же стоит `require_station_in` создания, входа и блоков). Пачка — 1–100
  записей, иначе `validation_failed` на `records`.
- `GET /v1/device/codes/{codeHash}` — любое устройство, читает вне транзакции записи.
- Ограничения выдачи блоков на хосте нет (пункт 19 очереди мелочей 2a1): курсор станции опережает
  `consumed_through` хоста, поэтому правило выдачи согласуется с правилом станции «половина» в 2b.
```

- [ ] **Step 4: Мутации**

М1 — скан пишет код в журнал. В `apps/standalone/host/src/facts/scan.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if code.gtin14 != context.shift.gtin14 {
```

заменить на

<!-- prettier-ignore -->
```rust
            tracing::info!(canonical = %code.canonical, "scan");
            if code.gtin14 != context.shift.gtin14 {
```

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: FAIL `secrets_never_reach_the_process_log`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — отказ пишет запись в журнал. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
                record = ?id,
                code = reject.code,
```

заменить на

<!-- prettier-ignore -->
```rust
                record = %value,
                code = reject.code,
```

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: FAIL `secrets_never_reach_the_process_log`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 5: Полная проверка и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`; `git diff --check`
Expected: чисто.

Run (`apps/standalone/dist` собран, вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --locked`
Expected: PASS — 46 наборов, 556 тестов (хост 393, `proto` 48, оболочка 115), без предупреждений компилятора.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, затем `typecheck` и `lint` того же пакета
Expected: PASS — 68 файлов, 1779 тестов; `typecheck` и `lint` без ошибок.

```bash
git add apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md
git commit -m "test(standalone): the process log holds no code of marking; the stage 2a spec takes plan 2a2's refinements" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] Вне песочницы: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --locked` — 46 наборов, 556 тестов (было 43 и 525; хост 393 вместо 365, `proto` 48 вместо 45, оболочка 115), без предупреждений компилятора.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 68 файлов, 1779 тестов (было 67 и 1744); `typecheck` и `lint` — без ошибок.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым JSON, TS и MD — чисто; `git diff --check <начало плана>..HEAD` — чисто.
- [ ] `git diff <начало плана>..HEAD --stat` — только файлы из раздела «Файлы»; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*`, `apps/standalone/src`, `apps/standalone/src-tauri`, миграции `0001`–`0009` не менялись; в вебвью — один новый тест.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - факты пока никто не шлёт: отправку очереди, конвейер сканов, короба и исключения на станции строят планы 2a6–2a8; пачки в тестах собраны вручную по фикстурам, построители вебвью и их сверка с `facts-request.json` — план 2a6;
  - предел 300 мс проверки кода на заводской сети и пропускная способность пачек на заводском ПК — ручная проверка (спецификация 2a, §7); тест доказывает только, что проверка не ждёт писателя;
  - производительность подзапросов итогов на объёме реальной смены (сотни тысяч позиций) не измерялась: индексы есть, замер — со сквозным сценарием 2a8;
  - задания CI `standalone-rust` и `standalone-windows-build` — для них нужен push; `standalone-windows-build` по-прежнему ждёт шага владельца плана 1f2, этот план Windows-кода не добавляет;
  - служба хоста на Windows — вне этого плана.

---

## Перенесено

- План 2a3 (офис): Zod `ShiftTotals` и обязательного `totals` в схеме `OfficeShift` по `office-shift.json`; итоги в строке списка (отдельного запроса не нужно); подпись `closeReasonCode` (шесть кодов домена) и отметка `lateDataAt`; `stale_revision` после закрытия станцией.
- План 2a6 (цех): Zod и построители `FactRecord` всех пяти видов, сверка с `facts-request.json` и `facts-response.json`; Vitest `fact-receipt-codes.json`; квитанции через `json_each`; `CodeCheck` и проверка с `timeoutMs: 300`; моменты — `toISOString`; новый `requestId` блока при смене префикса снимка (повтор со старым id и другим префиксом хост отвергает).
- План 2a8 (цех): построители `box_exception` и `shift_closed`, коды причин из `exception-reasons.json` (Vitest по той же фикстуре), правило причины закрытия по `shift-close-reasons.json`.
- План 2b: уведомление устройства, чью позицию вытеснил более ранний скан, и разбор `code_conflicts` в офисе (`reviewed_at`); ограничение выдачи блоков на хосте (пункт 19 очереди 2a1: курсор станции опережает `consumed_through` хоста, поэтому правило нужно согласовать с правилом станции «половина»); отзыв блоков и `box_closed` с серией отозванного блока, досланный после отзыва (сейчас `sscc_not_issued`); несколько устройств на смене (порядок `deviceIds` уже по первому входу).
- Этап 4: карточка смены — короба с `digest_matches = false`, исключения, конфликты, поздние данные и отклонённые записи (квитанции хранят код и поле, но не тело записи; если карточке нужно тело, его придётся хранить — решение этапа 4).
- Решения владельца ждут: вопросы раздела 11 спецификации 2a (допущения — в начале плана).
- Наблюдение при проверке плана: план применялся к чистой копии репозитория целиком (все шаги, все мутации, итоговые прогоны) дважды к прежней базе `366e87f06` (там была ещё задача перечитывания устройства, которую финальная волна 2a1 сделала сама). На `0a21a3f2c` целиком проверены задачи 1–4 (все шаги и все 43 мутации) и шаги 1–4 задачи 5; дальше сборки на машине проверяющего остановило непринятое лицензионное соглашение Xcode (компоновщик `cc` и `/usr/bin/git` отвечают кодом 69). Задачи 5–8 на `0a21a3f2c` применены генератором с проверкой, что каждый фрагмент встречается ровно один раз и итог совпадает с проверенным кодом, а сам итоговый код на этой базе прошёл `cargo test -p markiro-host -p markiro-proto` (35 наборов, 441 тест); их мутации и итоговые `--workspace` и Vitest на этой базе не перезапускались. В первом проходе итоговый `cargo test --workspace` один раз уронил `the_office_reads_a_shifts_totals_from_its_facts`; это не повторилось ни в следующих полных проходах, ни в трёх отдельных прогонах `--workspace`, ни в сорока прогонах наборов `facts`, `codes`, `office_shifts` и `device_shifts`, а вывод того падения не сохранился — при повторе его стоит сохранить целиком. Полный Vitest на базе финальной волны 2a1 (`dce191af9`), ещё без изменений плана, один раз уронил `test/template-editor.test.tsx` по таймауту 5 с (тест экранов, которые план не трогает); такое же одиночное падение было и в первом проходе.

---

## Отклонения при исполнении
