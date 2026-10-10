# План ЧЗ: выгрузки смены и XML для Честного знака, данные отчётов на хосте (О-Х) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Офис автономного продукта выгружает закрытую смену во всех десяти форматах облака и документ Честного знака на одну паллету, с теми же проверками полноты, теми же именами файлов и **теми же байтами**, что облако для тех же фактов: хост отдаёт строки смены одним снимком, офис переносит правила источника облака и строит файлы кодом `@markiro/domain`, оболочка кладёт части в новую папку под «Документы\Markiro\Выгрузки», а хост пишет строку журнала `shift.export`. Совпадение байтов доказывает общий набор случаев, по которому идут и тест облака (его собственные источник и исполнитель), и тест автонома.

**Architecture:**

- Хост (часть О-Х): `GET /v1/office/shifts/{id}/export-source` (`host/src/routes/office_exports.rs`) — смена, организация, коды смены с каноническим текстом сканов-владельцев, все короба, только живые позиции, все паллеты, одной транзакцией чтения и только поиском по индексам; `GET …/boxes` и `…/pallets` (`routes/office_boxes.rs`) — списки для карточки О-Ф; `POST …/exports` — строка журнала после сохранения файлов. Типы — `proto` (`ShiftExportRows`, `OfficeBox`, `OfficePallet`, `ShiftExportRecord`), фикстуры и Zod — как всегда.
- Паритет: `packages/domain/test/fixtures/shift-export-parity/{cases,golden}.json`; `apps/api/test/standalone-export-parity.test.ts` прогоняет по случаям облачные `ShiftExportSourceService` и `ShiftExportRunnerService` и пишет или сверяет эталон; `apps/standalone/test/export-parity.test.ts` прогоняет порт автонома по тем же фактам в форме ответа хоста.
- Вебвью: `src/office/exports/export-source.ts` (порт источника облака), `run-export.ts` (рендер доменом и сопоставление отказов, как у исполнителя облака), `export-checks.ts` (что диалог показывает до формирования), `office-files.ts` с контекстом (команды оболочки), `ExportDialog.tsx` с кнопкой «Выгрузка» в «Сменах».
- Оболочка: `src-tauri/src/office_files.rs` — `save_office_files` и `open_office_folder` без новых зависимостей и плагинов.

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite 3.46), serde, base64 0.22.1 (уже зависимость оболочки), Tauri 2.11; TypeScript — React 19.2, zod 4.4.3, Vitest 4 с jsdom, `@markiro/domain` (`renderShiftExport`, `renderPalletAggregationExport`, `SHIFT_EXPORT_FORMATS`, `sanitizeShiftExportFilenameSegment`); облачный тест — Vitest 4 в `apps/api` без базы данных.

**База:** ветка `claude/autonomous-desktop-station-9e6f13` после влития планов 2a2, 2a3, 2a4 и ПЛ-Х. Они на момент написания не влиты, поэтому каждый фрагмент плана применён к копии, собранной так (точно в этом порядке):

1. `a6dcae1e5` — рабочее дерево планировщика ПЛ-Х (`/tmp/claude/ppl-scratch`): голова `claude/2a2-facts` `407a3cae4`, повтор задач 5–8 плана 2a2 по тексту плана (`cdd715e9c`…`9797e67d6`), слияние `claude/2a3-office` на `105ad8bca`, `totals` в `officeShiftSchema` и задачи 1–7 плана ПЛ-Х по его тексту;
2. слияние `claude/2a4-shell` на `ce6511b3b` (так же, как `claude/integration`); конфликты — в `apps/standalone/AGENTS.md` (абзац «Logs» с повтором строки о киоск-режиме: повтор удалён, оба дополнения сохранены; второй конфликт — сохранены обе стороны) и в спецификации 2a (оба раздела «17»: раздел плана 2a4 переименован в «18»). Итог — коммит копии `7a7a34a47`.

Файлы, которые трогает этот план, в влитой ветке должны совпасть с копией по смыслу: `host/src/{audit,server}.rs`, `host/src/routes/mod.rs`, `proto/src/lib.rs` (после `CodeCheck`), `src/host/{api,protocol,requests}.ts`, `src-tauri/src/lib.rs`, `src/office/{Office.tsx,office-query.ts}`, `src/office/shifts/ShiftsPage.tsx`, тесты `test/{protocol,api,shift-edit,shift-delete-close}.test.*` и `test/support/office.tsx`. Если фрагмент «до» не найден, сверить по смыслу и записать в «Отклонения при исполнении». Уже известно, что финальная волна плана 2a2 (`85608f3f3`…`1c2f009c1` на `claude/2a2-facts`, после копии) добавила `ShiftTotals.unitsInClosedBoxes`, переписала `host/tests/no_secrets_in_logs.rs` (+1003 строки) и поменяла `proto/tests/fixtures.rs` и `host/tests/support/app.rs` (`sscc_under` для любой длины префикса; выход для девятизначного префикса тот же). Поэтому два места сверяются по смыслу заранее: списки `use markiro_proto::{…}` в `proto/tests/fixtures.rs` (фрагменты задач 1–3 добавляют в список `ShiftExportRows`, `OfficeBox`, `OfficePallet`, `ShiftExportRecord`; если список другой — добавить эти имена и выполнить `cargo fmt`) и вставка задачи 9 в `no_secrets_in_logs.rs` (обход маршрутов выгрузки ставится после закрытия смены, у которой уже есть принятый код, SSCC короба и SSCC паллеты, и до открытия пула для проверок; переменные — те, что в файле называют базовый адрес, ключ устройства, токен сессии, смену, SSCC короба и паллеты).

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (спецификация пилота): §2 (ответ владельца: «все текущие отчёты по сменам… выгрузка для Честного знака»), §4.1 строки 11 и 13, §5.2–5.4 (форматы, проверки полноты, XML), §5.7 (данные Д1–Д4), §7 (отчёты и выгрузки в офисе), §12.2 (строки О-Х и ЧЗ), §14 (П3, П16), §15 (что нельзя проверить без Windows и данных клиента), §16 (риск двух источников правил).
- План ПЛ-Х (`docs/superpowers/plans/2026-10-10-standalone-pl-h-pallets-host.md`), раздел «Контракт для ПЛ-Ц, О-Х и ЧЗ»: таблица `pallets`, `boxes.pallet_id`, выведенный состав паллеты.
- План 2a2 (`…-2a2-host-facts.md`): реестр `code_owners`, живые позиции (`box_items.removed_at`, `displaced_at`), `shift_close_events`, `late_data_at`.
- Облако (переносится, не импортируется): `apps/api/src/modules/shift-exports/shift-export-source.service.ts` (источник и проверки), `shift-export-runner.service.ts` (метаданные документа и сопоставление отказов), `shift-exports.service.ts` (права, `stale`), `apps/admin/src/pages/shifts/ShiftExportsDialog.tsx` (какие форматы предлагаются, `maxLines` по умолчанию 2000), `apps/admin/src/i18n/ru.json` (`pages.shifts.exports.errors`), `packages/domain/src/{shift-exports,gismt-aggregation,pallet-exports,document-text-encoding}.ts`.
- Ревью, уроки которых план закрепляет: `.superpowers/sdd/2a1-final-review-report.md`, `2a2-task-*-review.md` (мутанты на границах и отборах, точность миллисекунд, отказы без следа), `2a2-task-7-review.md` (Minor 1: «принято» против «в закрытых коробах»; Minor 2: вытеснение после закрытия не отмечает смену; Minor 5: стоимость списков и `ANALYZE`), `2a3-final-review-report.md`.
- `apps/standalone/AGENTS.md` — «Audit», «Writes», «Protocol», «Office pages», «Logs», «Verification».

## Допущения по вопросам владельцу

Владелец подтвердил: клиент работает с коробами **и** паллетами, хост стоит на ПК станции, контрактное производство (SSCC под префиксом контрагента) — позже; как клиент пользуется каждым форматом, неизвестно. На остальные вопросы раздела 14 спецификации пилота он не ответил; план принимает рекомендованные ответы:

- **П3 — все 10 форматов смены и XML одной паллеты.** Все они — один вызов домена; ручная приёмка — только тех, что клиент загружает. Форматы перенесены из облачных генераторов и проверены облачным же кодом (задача 4), а не придуманы. Что клиент реально загружал в Честный знак, план не знает: образцы — шаг владельца (ниже).
- **П16 — фиксированная папка** «Документы\Markiro\Выгрузки» с кнопкой «Открыть папку»; без диалога выбора и без `tauri-plugin-dialog`.
- **П1 (хост на станции), П2 (паллеты как у облачной станции), П4 (без префикса контрагента), П10 (рекомендации 2a)** — как в планах 2a2 и ПЛ-Х; выгрузкам они безразличны, кроме П4: SSCC контрагента не появятся, пока нет плана для них.
- **П15 (логотип) и формы** — вне этого плана: формы — план О-Ф.

Вопросы, которые план добавляет, с принятыми ответами (меняются одной правкой, сказано где):

- **Ч1 — расформированная паллета в сменных паллетных форматах.** Облако пишет её как паллету со всеми её коробами: его запрос паллет `disassembled_at` не читает (`shift-export-source.service.ts:513-540`), а короба расформированной паллеты сохраняют `pallet_id` (`pallet-ingest.ts:489-507`). Принято: **как облако**, байты совпадают; диалог предупреждает «Расформированных паллет в документе: N». Контракт ПЛ-Х «для выгрузок короба расформированной паллеты — короба без паллеты» для выгрузок не действует (задача 9 записывает это в спецификацию). Если владелец решит иначе, это одна строка в `palletsSource` (`export-source.ts`: `pallet.disassembledAt !== null` к условию «паллета не закрыта») и расхождение с облаком в одном случае эталона — мутант P6 задачи 5 показывает, какой.
- **Ч2 — `operation_date_time` смены.** Облако пишет `shifts.closed_at`, а при закрытии станцией это момент станции с миллисекундами. Хост хранит закрытие в целых секундах, поэтому принято: **момент принятого закрытия станцией** (`shift_close_events.closed_at`, `stationClosedAt`), а при закрытии из офиса — момент хоста. Документ одной паллеты — `pallets.closed_at` станции, как в облаке.
- **Ч3 — одна папка на выгрузку:** `Выгрузки\<номер смены>\<дата_время>_<формат>`. Иначе выгрузка с меньшим числом частей оставила бы рядом части прежней, и их загрузили бы вместе. Существующая папка получает « (2)».
- **Ч4 — кто выгружает:** все роли офиса (облачное `OPERATIONS_READ`); «Выгрузка» есть у активной смены (документ закрытой паллеты, как в облаке) и у закрытой.
- **Ч5 — порядок записи в журнал:** после сохранения файлов. Журнал не утверждает выгрузку, которой нет; если хост не принял запись, файлы остаются, а диалог предлагает «Записать снова» с той же записью.

Указания координатора (из ревью задачи 7 плана 2a2), которые план учитывает:

- `ShiftTotals.acceptedUnits` считает живые позиции во всех коробах, а облачный офис — только в закрытых. Выгрузке нужно второе: диалог показывает «Кодов в смене: N, из них в закрытых коробах: K» по строкам выгрузки (`exportCounts`), а `BOX_COVERAGE_INCOMPLETE` отказывает, когда K < N. Поле `unitsInClosedBoxes`, которое добавляет финальная волна 2a2, по определению равно K; план от него не зависит и `ShiftTotals` не трогает.
- Закрытая смена меняется без отметки, если более ранний скан другой смены вытесняет её код (паритет с облаком). Предупреждение о поздних данных (`late_data`) этого не видит; это записано в AGENTS и в спецификацию, а повторная выгрузка строит уже новые байты.

## Global Constraints

**Решения спецификации пилота, обязательные для плана** (§5.2–5.4, §7 с уточнениями задачи 9)

1. Форматы — ровно `SHIFT_EXPORT_FORMATS` домена (10, версии `shift_txt_boxes@2`, `shift_csv_boxes@2`, остальные `@1`) и `PALLET_EXPORT_FORMATS` (`pallet_xml_gismt_aggregation@1`); паллетные форматы предлагаются только смене с паллетами (`shiftExportFormatRequiresPallets`).
2. Проверки и порядок — облачные: `SHIFT_NOT_CLOSED` → (XML) `ORG_INN_MISSING` → `ORG_NAME_MISSING` → `SHIFT_HAS_NO_CODES` → `BOX_COVERAGE_INCOMPLETE` → `SHIFT_HAS_NO_PALLETS`; одной паллеты — `PALLET_NOT_CLOSED`, `PALLET_DISASSEMBLED`; домен — `INVALID_ORG_INN` (ИНН ровно из 10 цифр), `INVALID_CIS`, `INVALID_BOX_SSCC`, `INVALID_LINE_LIMIT`, `BOX_EXCEEDS_LINE_LIMIT`, `PALLET_EXCEEDS_LINE_LIMIT`; прочее (`EMPTY_SOURCE`, метаданные) — `GENERATION_FAILED`, как у исполнителя облака. `SHIFT_DATE_MISSING` недостижим (у смены хоста дата всегда есть).
3. Порядок — облачный: коды по времени скана, затем по хешу; короба по SSCC; паллеты по `closed_at`, затем по SSCC; короба одной паллеты — по `closed_at`, затем по `id`.
4. `document_id` — новый UUID на каждую выгрузку; `file_date_time` — момент формирования; `document_number` — номер смены (`OCT26-004`, станционной — `OCT26-004/S`), у паллеты — её SSCC с `00`; части XML — суффикс `-k`.
5. `maxLines` — 2–1 000 000 или без ограничения, по умолчанию в диалоге 2000 (как в кабинете облака).
6. Файлы — в `Документы\Markiro\Выгрузки\<номер смены>\<дата_время>_<формат>`, без диалога выбора папки (П16); каждая выгрузка — в новую папку.
7. Строка журнала `shift.export` — после сохранения файлов, у любой роли офиса, без ревизии хоста.

**Код и процесс**

- Новых крейтов и пакетов нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются (`base64` оболочки уже есть). Миграций нет: запросы ищут по индексам `0010` и `0012`.
- Не меняются: `apps/station`, `packages/*` **кроме тестовых фикстур** `packages/domain/test/fixtures/shift-export-parity/`, облачный код **кроме нового теста** `apps/api/test/standalone-export-parity.test.ts` (ни одного файла `apps/api/src`, выкладка облака не нужна), применённые миграции.
- Правила записи `apps/standalone/AGENTS.md` («Writes»): запись журнала — `begin_write`, `require_session_in` внутри транзакции, без `next_revision` (данные не меняются, как у входа в офис). Чтение — одна отложенная транзакция с откатом (как `GET /v1/office/sscc`).
- Журнал процесса: ни кодов, ни SSCC, ни путей к файлам (путь называет пользователя Windows).
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в этот момент он встречается в файле один раз. Внутри шага правки одного файла идут сверху вниз и применяются по порядку. Шаг тестов применяется раньше шага реализации. План применён к копии шаг за шагом сценарием (каждый фрагмент единственный, последовательное применение даёт итоговый файл байт в байт, итог каждой задачи совпал с её коммитом в копии).
- «Создать» — новый файл, ровно как в блоке, с переводом строки в конце.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier.
- Русский текст — буквами, не `\uXXXX`; в JSON-фикстурах группа GS — `\u001d`, как в остальных фикстурах.
- Проверка якорей перед шагом: `.superpowers/sdd/tools/check_fragments.py <бриф задачи>`.
- `golden.json` (задача 4) в плане не приводится: его пишет облачный тест (`EXPORT_PARITY_WRITE=1`), а план даёт его SHA-256 и сводку. Так эталон выводится из кода облака, и его байты закреплены.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из списка; команда — ожидаемый FAIL названных тестов; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутанты облака (задача 4) меняют облачный файл только на время проверки.
- «Эквивалентный» мутант назван с причиной: тест его не ловит, потому что по данным хоста он ничего не меняет.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` (`--locked` заодно доказывает, что `Cargo.lock` не меняется).
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind` (`Operation not permitted`): из затронутых — `no_secrets_in_logs`, `ipc` целиком, `cargo test -p markiro-host` целиком и `--workspace`; их запускать вне песочницы. `--test office_exports`, `--test office_boxes`, `--test fixtures`, `-p markiro-standalone --lib office_files` и `--test ipc -- saving_office_files the_app_manages_every_state` идут и в песочнице.
- Оболочка встраивает сборку вебвью (`tauri::generate_context!`): перед `-p markiro-standalone` или `--workspace` в свежем worktree выполнить `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`; перед тестом облака (задача 4): `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/api^...'` (установка — с `--filter '@markiro/api...'`).
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать сверх рецепта установки; команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk` (`cargo test: 8 passed (1 suite, …)` вместо строки `test result`): если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- Машина под нагрузкой параллельных агентов: тяжёлые UI-наборы Vitest (`test/template-editor.test.tsx`, `test/templates-page.test.tsx`, `test/shifts-page.test.tsx`, `test/shift-edit.test.tsx`, `test/shift-dialog.test.tsx`, `test/shift-delete-close.test.tsx`, `test/devices-page.test.tsx`) при полном прогоне падают на пределе 5 с и до этого плана (на базе копии при средней нагрузке выше 90 полный прогон дал 258 таких отказов). Такой отказ повторить отдельным запуском файла; чтобы убедиться, что это нагрузка, а не поломка, можно один раз запустить файл с `--testTimeout=20000` (на копии `test/template-editor.test.tsx` при нагрузке 161 так прошёл целиком, 97 из 97) — но гейтом остаётся обычный предел.

**Счёт тестов**

- Наборы cargo считаются по строкам `Running` (doc-тесты не считаются). База — копия из «Базы»: cargo — 50 наборов, 758 тестов (хост 34 и 451, `proto` 2 и 50, оболочка 14 и 257); Vitest — 80 файлов, 2262 теста. После плана: cargo — 52 набора, 779 тестов (хост 36 и 462, `proto` 2 и 53, оболочка 14 и 264); Vitest — 85 файлов, 2504 теста; в `apps/api` — один новый файл с одним тестом.
- Если влитые планы добавили тесты сверх своих текстов, абсолютные числа сдвигаются; неизменны приращения: задача 1 — `proto` +1, хост новый набор `office_exports` с 4 тестами, Vitest +3 (`protocol` +2, `api` +1); задача 2 — `proto` +1, хост новый набор `office_boxes` с 3 тестами, Vitest +6; задача 3 — `proto` +1, `office_exports` +4, Vitest +5; задача 4 — `apps/api` +1 файл, 1 тест; задача 5 — Vitest +2 файла, 206 тестов (`export-parity` 198, `export-source` 8); задача 6 — +1 файл, 7; задача 7 — оболочка `--lib` +6, `ipc` +1, Vitest +1 файл, 7; задача 8 — Vitest +1 файл, 8; задача 9 — тестов не добавляет. Каждое «Expected» ниже измерено на копии с кодом самого плана.

## Файлы

Задачи выполняются по порядку; задачи 1–4 (хост и облачный эталон) можно было бы делать параллельно, но фикстуры `proto` и `test/protocol.test.ts` общие, поэтому порядок строгий.

```
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                          задачи 1–3
apps/standalone/proto/fixtures/shift-export-rows.json                              задача 1
apps/standalone/proto/fixtures/{office-boxes,office-pallets}.json                  задача 2
apps/standalone/proto/fixtures/{shift-export-record,export-formats}.json           задача 3
apps/standalone/host/src/routes/office_exports.rs, host/tests/office_exports.rs    задачи 1, 3
apps/standalone/host/src/routes/office_boxes.rs, host/tests/office_boxes.rs        задача 2
apps/standalone/host/src/routes/mod.rs, host/src/server.rs                         задачи 1–3
apps/standalone/host/src/audit.rs                                                  задача 3
apps/standalone/src/host/{protocol,api}.ts, test/{protocol,api}.test.ts            задачи 1–3
apps/standalone/test/support/office.tsx                                            задачи 1–3
apps/standalone/src/host/requests.ts                                               задача 3
packages/domain/test/fixtures/shift-export-parity/{cases,golden}.json              задача 4
apps/api/test/standalone-export-parity.test.ts                                     задача 4
apps/standalone/src/office/exports/{export-source,run-export}.ts                   задача 5
apps/standalone/test/{export-parity,export-source}.test.ts                         задача 5
apps/standalone/src/office/exports/export-checks.ts, test/export-checks.test.ts    задача 6
apps/standalone/src-tauri/src/{office_files,lib}.rs, src-tauri/tests/ipc.rs        задача 7
apps/standalone/src/office/exports/{office-files.ts,office-files-context.tsx}      задача 7
apps/standalone/src/office/Office.tsx, test/office-files.test.ts                   задача 7
apps/standalone/src/office/exports/ExportDialog.tsx, test/export-dialog.test.tsx   задача 8
apps/standalone/src/office/{office-query.ts,shifts/ShiftsPage.tsx}                 задача 8
apps/standalone/src/i18n/ru.json, test/{shift-edit,shift-delete-close}.test.tsx    задача 8
apps/standalone/host/tests/no_secrets_in_logs.rs                                   задача 9
apps/standalone/AGENTS.md, docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md  задача 9
```

Хост идёт первым: маршрут строк выгрузки (задача 1) вместе с его типом, фикстурой, Zod и методом `HostApi`; списки для О-Ф (задача 2); запись журнала с общей фикстурой форматов (задача 3). Задача 4 — эталон из кода облака, без которого порт нечем проверять. Порт и рендер (задача 5) сразу сверяются с эталоном. Задача 6 — что диалог знает до формирования, задача 7 — сохранение файлов в оболочке, задача 8 — диалог и кнопка, задача 9 — журнал процесса, документы и полная проверка.

## Контракт для О-Ф и других планов

Типы — `proto/src/lib.rs`, формы на проводе — фикстуры `proto/fixtures`, Zod — `src/host/protocol.ts`.

**Для О-Ф (карточка смены и печатные формы):**

- `HostApi.listShiftBoxes(token, shiftId)` → `OfficeBox[]` (`GET /v1/office/shifts/{id}/boxes`, `office-boxes.json`): каждый короб смены, по `openedAt`, затем `id`; `units` — живые позиции сейчас (ни `removed_at`, ни `displaced_at`); `itemCountReported` и `digestMatches` — что сказала станция при закрытии и как это сошлось тогда (у расформированного короба устарело: показывать `disassembledAt`, а не совпадение); `printVerifiedAt` и `printSkippedAt` — моменты станции, более поздняя проверка перезаписывает (ревью задачи 5 плана 2a2, Minor 4). Неизвестная смена — `not_found`; все роли офиса.
- `HostApi.listShiftPallets(token, shiftId)` → `OfficePallet[]` (`…/pallets`, `office-pallets.json`): по `openedAt`, затем `id`; `boxes` — закрытые нерасформированные короба паллеты, `units` — их живые позиции (как карточка паллеты облака, `pallets.service.ts:189-193`); `boxCountReported` — счёт станции; расхождение показывать, не исправлять. Расформированная паллета — `disassembledAt`.
- `HostApi.getShiftExportSource` (`ShiftExportRows`) — все коды смены с каноническим текстом (полный КМ с криптохвостом): из него можно строить «Состав короба» закрытой смены, но правило облака для **расформированного** короба другое (печатаются позиции, снятые именно расформированием: `code-search.service.ts:1160-1250`, `removed_at = disassembly_received_at`); у хоста таких позиций в строках выгрузки нет (только живые). Поэтому маршруты данных форм (`report-data` короба и паллеты из §7 спецификации) остаются за О-Ф: ему нужен маршрут, который отдаёт позиции расформированного короба по правилу облака, — это правка `proto`, по договорённости потоков (§12.4) в потоке Б.
- «Бланк смены» (`ShiftTaskFormData`) маршрута не требует: все поля — в `OfficeShift`, списках товаров, линий, контрагентов и профиле организации, которые офис уже читает (фото и логотипа у автонома нет).
- Сохранение HTML форм для пути «Открыть в браузере»: `useOfficeFiles().save(["Формы", …], files)` — второй корень оболочки `Формы` уже разрешён (`office_files::ROOTS`); открыть папку — `open(segments)`. Открытие самого файла браузером оболочка не умеет (нужна новая команда или плагин — шаг О-Ф).
- Кнопка «Выгрузка» и `ExportDialog` переносятся в карточку смены как есть: диалог берёт только `OfficeShift` и закрывается `onClose`.

**Для ОЧ, РК и ИМП:** выгрузки ничего не пишут на хосте, кроме строки журнала `shift.export`; восстановление из копии и импорт их не касаются. Если РК восстановит базу без фактов, повторная выгрузка честно построит меньше кодов — эталон этого не ловит.

**Для облака:** `apps/api/test/standalone-export-parity.test.ts` падает, если поменяется источник, исполнитель или домен выгрузок; это намеренно (§16 спецификации пилота: два источника правил). Правка облачного экспорта перегенерирует эталон (`EXPORT_PARITY_WRITE=1`) и в той же правке приводит порт автонома к тем же байтам.

---

### Task 1: Строки выгрузки смены на хосте: `GET /v1/office/shifts/{id}/export-source`

Хост отдаёт всё, из чего облако строит выгрузку, одним снимком и ничего не решает сам: проверки полноты, порядок и группировка — порт задачи 5. Коды смены — `code_owners` через `scans` этой смены (индекс `scans_shift`, без полного прохода по реестру за год) с каноническим текстом скана-владельца, как облако соединяет `code_registry` с `codes`. Позиции — только живые (`box_items_live`): облако отбрасывает остальные первым же фильтром, и иначе запрос не мог бы искать по частичному индексу. Короба и паллеты — все, открытые и расформированные тоже: порту нужно знать, что паллета открыта (подавленные короба) и что короб расформирован. `closedAt` — целые секунды хоста, `stationClosedAt` — момент принятого закрытия станцией (Ч2). Название товара — текущее, как облачный `leftJoin(products)`. Тест закрепляет и отбор по смене каждого запроса (смена коллеги с кодом, коробом и паллетой рядом), и выпадение снятых и вытесненных позиций, и то, что каждый запрос ищет по индексу (`EXPLAIN QUERY PLAN`).

**Files:**

- Create: `apps/standalone/host/src/routes/office_exports.rs`, `apps/standalone/host/tests/office_exports.rs`, `apps/standalone/proto/fixtures/shift-export-rows.json`
- Modify: `apps/standalone/proto/src/lib.rs` (после `CodeCheck`), `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: таблицы `shifts`, `products`, `org_profile`, `scans`, `code_owners`, `boxes`, `box_items`, `shift_close_events` (2a2), `pallets` и `boxes.pallet_id` (ПЛ-Х); `shifts::format_number`; `OfficeContext`.
- Produces: `markiro_proto::{ShiftExportRows, ExportShift, ExportOrganization, ExportCode, ExportBox, ExportItem, ExportPallet}`; маршрут `GET /v1/office/shifts/{id}/export-source` (все роли, `not_found` для неизвестной смены); константы SQL `markiro_host::routes::office_exports::{SHIFT_SQL, CODES_SQL, BOXES_SQL, ITEMS_SQL, PALLETS_SQL}`; Zod `shiftExportRowsSchema`, тип `ShiftExportRows`; `HostApi.getShiftExportSource(token, id): Promise<ShiftExportRows>`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/host/tests/office_exports.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, close_from_office, code, code_hash, empty, fact,
    instant, issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_closed, shift_setup,
    sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// `GET /v1/office/shifts/{shift}/export-source` as the administrator.
async fn export_source(admin: &Admin, shift: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/export-source"),
            None,
        )
        .await
}

/// Code `n` as the export source lists it.
fn owned(n: u32, scanned_at: &str) -> Value {
    json!({
        "codeHash": code_hash(n),
        "scannedAt": scanned_at,
        "canonical": code(n)["canonical"],
    })
}

/// A shift with pallets after a day's facts: boxes 1 (codes 1 and 2, on
/// pallet 1) and 2 (code 3, on no pallet) closed, box 3 open with code 4,
/// code 5 scanned into box 1 and taken out again, pallet 1 closed, and the
/// station's close. A colleague's shift with pallets on the other line has
/// a code, a box and a pallet of its own. The export source names exactly
/// the shift's own rows: the codes it owns with their owning scans'
/// canonical text, every box, the live items only and every pallet, with
/// the host's close in whole seconds beside the station's own instant.
#[tokio::test]
async fn the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut undo = box_exception("undo", &box_id(1), &instant(12, 0));
    undo["codeHash"] = json!(code_hash(5));
    undo["targetScannedAt"] = json!(instant(11, 0));
    let mut first_box = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 500),
        &instant(20, 0),
    );
    first_box["palletId"] = json!(pallet_id(1));
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(2, &box_id(1), &instant(10, 500)),
            ),
            fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 500)),
            ),
            fact(
                &record_id(3),
                "scan",
                &shift,
                ok_scan(5, &box_id(1), &instant(11, 0)),
            ),
            fact(&record_id(4), "box_exception", &shift, undo),
            fact(&record_id(5), "box_closed", &shift, first_box),
            fact(
                &record_id(6),
                "scan",
                &shift,
                ok_scan(3, &box_id(2), &instant(30, 0)),
            ),
            fact(
                &record_id(7),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[3],
                    &instant(30, 0),
                    &instant(40, 0),
                ),
            ),
            fact(
                &record_id(8),
                "scan",
                &shift,
                ok_scan(4, &box_id(3), &instant(50, 0)),
            ),
            fact(
                &record_id(9),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(20, 0),
                    &instant(60, 250),
                ),
            ),
        ],
    )
    .await;
    // The colleague's shift: its code, box and pallet are its own.
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    let mut their_box = box_closed(
        &box_id(11),
        &colleague_block,
        3500,
        &[7],
        &instant(5, 0),
        &instant(6, 0),
    );
    their_box["palletId"] = json!(pallet_id(11));
    accept(
        &admin,
        &colleague,
        &[
            fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                ok_scan(7, &box_id(11), &instant(5, 0)),
            ),
            fact(&record_id(2), "box_closed", &colleague.shift, their_box),
            fact(
                &record_id(3),
                "pallet_closed",
                &colleague.shift,
                pallet_closed(
                    &pallet_id(11),
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(7, 0),
                ),
            ),
        ],
    )
    .await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(10),
            "shift_closed",
            &shift,
            shift_closed(None, 4, 2, None, &instant(70, 412)),
        )],
    )
    .await;

    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(
        source,
        json!({
            "shift": {
                "id": shift,
                "number": floor.number,
                "status": "closed",
                "productionDate": "2026-10-08",
                "productName": "Молоко 3,2% 0,9 л",
                "palletsEnabled": true,
                "closedAt": "2026-10-08T06:01:10Z",
                "stationClosedAt": instant(70, 412),
                "lateDataAt": null,
            },
            "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
            // One instant for codes 1 and 2: the hash orders them.
            "codes": [
                owned(1, &instant(10, 500)),
                owned(2, &instant(10, 500)),
                owned(3, &instant(30, 0)),
                owned(4, &instant(50, 0)),
            ],
            "boxes": [
                {
                    "id": box_id(1), "sscc": sscc(1500), "openedAt": instant(10, 500),
                    "closedAt": instant(20, 0), "disassembledAt": null, "palletId": pallet_id(1),
                },
                {
                    "id": box_id(2), "sscc": sscc(1501), "openedAt": instant(30, 0),
                    "closedAt": instant(40, 0), "disassembledAt": null, "palletId": null,
                },
                {
                    "id": box_id(3), "sscc": null, "openedAt": instant(50, 0),
                    "closedAt": null, "disassembledAt": null, "palletId": null,
                },
            ],
            "items": [
                { "boxId": box_id(1), "codeHash": code_hash(1) },
                { "boxId": box_id(1), "codeHash": code_hash(2) },
                { "boxId": box_id(2), "codeHash": code_hash(3) },
                { "boxId": box_id(3), "codeHash": code_hash(4) },
            ],
            "pallets": [{
                "id": pallet_id(1), "sscc": pallet_sscc(40), "openedAt": instant(20, 0),
                "closedAt": instant(60, 250), "disassembledAt": null,
            }],
        })
    );
    // The colleague's source names only the colleague's rows.
    let (status, theirs) = export_source(&admin, &colleague.shift).await;
    assert_eq!(status, StatusCode::OK, "{theirs}");
    assert_eq!(theirs["codes"], json!([owned(7, &instant(5, 0))]));
    assert_eq!(
        theirs["items"],
        json!([{ "boxId": box_id(11), "codeHash": code_hash(7) }])
    );
    assert_eq!(theirs["boxes"].as_array().map(Vec::len), Some(1));
    assert_eq!(theirs["pallets"][0]["id"], json!(pallet_id(11)));
    assert_eq!(theirs["pallets"].as_array().map(Vec::len), Some(1));
    assert_eq!(theirs["shift"]["status"], "active");
    assert_eq!(theirs["shift"]["closedAt"], Value::Null);
    assert_eq!(theirs["shift"]["stationClosedAt"], Value::Null);
}

/// A code an earlier scan on another line took leaves the shift's codes and
/// its box's live items, though the box stays closed; a box taken apart
/// stays listed, its items gone. A shift the office closed has no station
/// close: `stationClosedAt` is `null` and `closedAt` is the office's.
#[tokio::test]
async fn displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant(
) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.clone();
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(40, 0));
    disassemble["reasonCode"] = json!("other");
    disassemble["reasonText"] = json!("Помятый короб");
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            fact(
                &record_id(3),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(25, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[2],
                    &instant(25, 0),
                    &instant(30, 0),
                ),
            ),
            fact(&record_id(5), "box_exception", &shift, disassemble),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    // An earlier scan of code 1 on the colleague's line takes it.
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(1, &box_id(11), &instant(5, 0)),
        )],
    )
    .await;
    let closed = close_from_office(&admin, &shift, "Станция не отвечает").await;
    // The station's own close after the office's is `already_closed`, never
    // the shift's close; its label check arrives late and marks the shift.
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(6),
                "shift_closed",
                &shift,
                shift_closed(None, 1, 1, None, &instant(90, 0)),
            ),
            fact(
                &record_id(7),
                "box_label",
                &shift,
                json!({ "boxId": box_id(1), "outcome": "verified", "at": instant(91, 0) }),
            ),
        ],
    )
    .await;
    // The product renamed after the close: the source names it as it is now,
    // as the cloud's export joins the product.
    let (status, product) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{product}");
    let mut renamed = product[0].clone();
    for field in ["id", "status", "rev"] {
        renamed.as_object_mut().unwrap().remove(field);
    }
    renamed["name"] = json!("Молоко 2,5% 0,9 л");
    renamed["expectedRev"] = product[0]["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(renamed),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{office}");
    assert!(office["lateDataAt"].is_string(), "{office}");

    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["codes"], json!([]));
    assert_eq!(source["items"], json!([]));
    assert_eq!(
        source["boxes"],
        json!([
            {
                "id": box_id(1), "sscc": sscc(1500), "openedAt": instant(10, 0),
                "closedAt": instant(20, 0), "disassembledAt": null, "palletId": null,
            },
            {
                "id": box_id(2), "sscc": sscc(1501), "openedAt": instant(25, 0),
                "closedAt": instant(30, 0), "disassembledAt": instant(40, 0), "palletId": null,
            },
        ])
    );
    assert_eq!(source["shift"]["status"], "closed");
    assert_eq!(source["shift"]["closedAt"], closed["closedAt"]);
    assert_eq!(source["shift"]["stationClosedAt"], Value::Null);
    assert_eq!(source["shift"]["lateDataAt"], office["lateDataAt"]);
    assert_eq!(source["shift"]["productName"], "Молоко 2,5% 0,9 л");
    assert_eq!(source["shift"]["palletsEnabled"], false);
    assert_eq!(source["pallets"], json!([]));
    // The code now belongs to the colleague's shift, with its own scan.
    let (_, theirs) = export_source(&admin, &colleague.shift).await;
    assert_eq!(theirs["codes"], json!([owned(1, &instant(5, 0))]));
}

/// Every office role reads the source; an unknown shift is `not_found`; a
/// planned shift answers with empty lists; the device key alone is no
/// office session.
#[tokio::test]
async fn every_office_role_reads_the_source_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = support::app::plan_shift(&admin, support::app::shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let path = format!("/v1/office/shifts/{id}/export-source");
    let technologist = admin.technologist().await;
    let (status, source) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["shift"]["status"], "planned");
    assert_eq!(source["shift"]["number"], planned["number"]);
    for list in ["codes", "boxes", "items", "pallets"] {
        assert_eq!(source[list], json!([]), "{list}");
    }
    let (status, body) = export_source(&admin, "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of the source searches by an index: none reads through every
/// scan, owner, box, item, pallet or close of the host, so a year of facts
/// costs the export of one shift nothing (the 366-day lesson of plan 2a3).
#[tokio::test]
async fn every_query_of_the_source_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("shift", markiro_host::routes::office_exports::SHIFT_SQL),
        ("codes", markiro_host::routes::office_exports::CODES_SQL),
        ("boxes", markiro_host::routes::office_exports::BOXES_SQL),
        ("items", markiro_host::routes::office_exports::ITEMS_SQL),
        ("pallets", markiro_host::routes::office_exports::PALLETS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.starts_with("SEARCH")),
            "{name}: {steps:?}"
        );
    }
}
```

2. Создать `apps/standalone/proto/fixtures/shift-export-rows.json`:

<!-- prettier-ignore -->
```json
{
  "shift": {
    "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
    "number": "OCT26-004",
    "status": "closed",
    "productionDate": "2026-10-08",
    "productName": "Молоко 3,2% 0,9 л",
    "palletsEnabled": true,
    "closedAt": "2026-10-08T14:00:07Z",
    "stationClosedAt": "2026-10-08T14:00:07.412Z",
    "lateDataAt": null
  },
  "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
  "codes": [
    {
      "codeHash": "3f1d6a0c9b8e7f2a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3",
      "scannedAt": "2026-10-08T06:05:12.031Z",
      "canonical": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
    },
    {
      "codeHash": "8c2e4a6b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a0c1b3d5f7e9a1c3b5d7f9e0a",
      "scannedAt": "2026-10-08T06:05:12.031Z",
      "canonical": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
    },
    {
      "codeHash": "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8",
      "scannedAt": "2026-10-08T06:06:40.507Z",
      "canonical": "010460068200001321Gt5kR1wQe8Uv\u001d93Ef3X"
    }
  ],
  "boxes": [
    {
      "id": "b0000000-0000-4000-8000-000000000001",
      "sscc": "046006820000015000",
      "openedAt": "2026-10-08T06:05:12.031Z",
      "closedAt": "2026-10-08T06:06:01.118Z",
      "disassembledAt": null,
      "palletId": "a0000000-0000-4000-8000-000000000001"
    },
    {
      "id": "b0000000-0000-4000-8000-000000000002",
      "sscc": "046006820000015017",
      "openedAt": "2026-10-08T06:06:40.507Z",
      "closedAt": "2026-10-08T06:07:15.902Z",
      "disassembledAt": null,
      "palletId": null
    },
    {
      "id": "b0000000-0000-4000-8000-000000000003",
      "sscc": null,
      "openedAt": "2026-10-08T06:08:02.244Z",
      "closedAt": null,
      "disassembledAt": null,
      "palletId": null
    }
  ],
  "items": [
    {
      "boxId": "b0000000-0000-4000-8000-000000000001",
      "codeHash": "3f1d6a0c9b8e7f2a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3"
    },
    {
      "boxId": "b0000000-0000-4000-8000-000000000001",
      "codeHash": "8c2e4a6b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a0c1b3d5f7e9a1c3b5d7f9e0a"
    },
    {
      "boxId": "b0000000-0000-4000-8000-000000000002",
      "codeHash": "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8"
    }
  ],
  "pallets": [
    {
      "id": "a0000000-0000-4000-8000-000000000001",
      "sscc": "146006820000000409",
      "openedAt": "2026-10-08T06:06:01.118Z",
      "closedAt": "2026-10-08T06:20:44.650Z",
      "disassembledAt": null
    }
  ]
}
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PalletExceptionFact,
    PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict, ShiftClose,
    ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PalletExceptionFact,
    PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict, ShiftClose,
    ShiftClosedFact, ShiftCreate, ShiftExportRows, ShiftMode, ShiftOrigin, ShiftStatus,
    ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState,
    TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert_eq!(taken, CodeCheck::Taken { owner: winner });
}
```

заменить на

<!-- prettier-ignore -->
```rust
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert_eq!(taken, CodeCheck::Taken { owner: winner });
}

/// The export source of a shift (plan ЧЗ) round-trips, and its rows hang
/// together as the host writes them: every live item names a box and a code
/// of the source, a box names a pallet of the source, a closed box has its
/// SSCC and an open one none, the station's close keeps its milliseconds
/// beside the host's whole seconds, and a canonical code keeps its group
/// separator and crypto tail.
#[test]
fn shift_export_rows_round_trip_and_hang_together() {
    let rows: ShiftExportRows = round_trip("shift-export-rows.json");
    assert_eq!(rows.shift.status, ShiftStatus::Closed);
    for item in &rows.items {
        assert!(rows.boxes.iter().any(|b| b.id == item.box_id), "{item:?}");
        assert!(
            rows.codes.iter().any(|c| c.code_hash == item.code_hash),
            "{item:?}"
        );
    }
    for b in &rows.boxes {
        if let Some(pallet) = &b.pallet_id {
            assert!(rows.pallets.iter().any(|p| &p.id == pallet), "{b:?}");
        }
        assert_eq!(b.closed_at.is_some(), b.sscc.is_some(), "{b:?}");
    }
    assert_eq!(
        rows.shift.closed_at.as_deref(),
        Some("2026-10-08T14:00:07Z")
    );
    assert_eq!(
        rows.shift.station_closed_at.as_deref(),
        Some("2026-10-08T14:00:07.412Z")
    );
    assert!(rows.codes.iter().all(|c| c.canonical.contains('\u{1d}')));
}
```

5. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/close`, body: SHIFT_CLOSE },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/close`, body: SHIFT_CLOSE },
  ],
  [
    "getShiftExportSource",
    fixture("shift-export-rows.json"),
    (api) => api.getShiftExportSource(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/export-source`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

6. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftUpdateSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftExportRowsSchema,
  shiftUpdateSchema,
  siteRecordSchema,
  ssccCounterUpdateSchema,
```

7. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ["template-defaults.json", templateDefaultsSchema],
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["template-defaults.json", templateDefaultsSchema],
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

8. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    updateShift: vi.fn<HostApi["updateShift"]>(() => unexpected("updateShift")),
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    updateShift: vi.fn<HostApi["updateShift"]>(() => unexpected("updateShift")),
    deleteShift: vi.fn<HostApi["deleteShift"]>(() => unexpected("deleteShift")),
    closeShift: vi.fn<HostApi["closeShift"]>(() => unexpected("closeShift")),
    getShiftExportSource: vi.fn<HostApi["getShiftExportSource"]>(() =>
      unexpected("getShiftExportSource"),
    ),
    ...overrides,
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: FAIL при сборке: «error[E0432]: unresolved import `markiro_proto::ShiftExportRows`».

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`

Expected: FAIL при сборке: «error[E0433]: failed to resolve: could not find `office_exports` in `routes`» (5 раз).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: FAIL: `Tests  3 failed | 264 passed (267)` — «getShiftExportSource sends the office token to the right route» (`api.getShiftExportSource is not a function`) и оба теста «response fixture shift-export-rows.json» (`Cannot read properties of undefined (reading 'parse')`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_exports;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
```

2. Создать `apps/standalone/host/src/routes/office_exports.rs`:

<!-- prettier-ignore -->
```rust
//! The data of a shift's exports (plan ЧЗ): `GET
//! /v1/office/shifts/{id}/export-source`, every office role. The host only
//! reads: the office ports the cloud's source rules and its completeness
//! checks over these rows and renders the files with `@markiro/domain`. One
//! read transaction gives every row one snapshot, as the cloud's export reads
//! in one repeatable-read transaction; each query searches by an index of
//! `0010` or `0012`, never through every fact of the host.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRows,
};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;
use crate::shifts;

/// The shift, its product's name now and the instant of the station's
/// close the host accepted (one at most: the first close of an active
/// shift is the one accepted, any later one `already_closed`).
pub const SHIFT_SQL: &str = "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, \
     s.status, s.production_date, p.name AS product_name, s.pallets_enabled, s.closed_at, \
     (SELECT e.closed_at FROM shift_close_events e WHERE e.shift_id = s.id \
      AND e.outcome = 'accepted' ORDER BY e.received_at, e.id LIMIT 1) AS station_closed_at, \
     s.late_data_at \
     FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?";

/// The organization the ЧЗ document names.
pub const ORGANIZATION_SQL: &str = "SELECT name, inn FROM org_profile WHERE id = 1";

/// The codes the shift owns, through its scans (`scans_shift`), each with
/// the canonical text of its owning scan.
pub const CODES_SQL: &str = "SELECT o.code_hash, o.scanned_at, s.canonical FROM scans s \
     JOIN code_owners o ON o.scan_id = s.id WHERE s.shift_id = ? \
     ORDER BY o.scanned_at, o.code_hash";

/// Every box of the shift.
pub const BOXES_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at, pallet_id \
     FROM boxes WHERE shift_id = ? ORDER BY opened_at, id";

/// The live items of the shift's boxes, through `box_items_live`: an item
/// taken out or taken by an earlier scan elsewhere is no row here, as the
/// cloud's rules drop it before reading anything else of it.
pub const ITEMS_SQL: &str = "SELECT i.box_id, i.code_hash FROM boxes b \
     JOIN box_items i ON i.box_id = b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL \
     WHERE b.shift_id = ? ORDER BY i.box_id, i.code_hash";

/// Every pallet of the shift.
pub const PALLETS_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at \
     FROM pallets WHERE shift_id = ? ORDER BY opened_at, id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    production_date: String,
    product_name: String,
    pallets_enabled: bool,
    closed_at: Option<String>,
    station_closed_at: Option<String>,
    late_data_at: Option<String>,
}

/// `GET /v1/office/shifts/{id}/export-source`: an unknown shift is
/// `not_found`; a planned one answers with empty lists.
pub async fn export_source(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ShiftExportRows>, ApiError> {
    // A plain deferred transaction: nothing here writes, so it is rolled
    // back, and the six reads share one WAL snapshot.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = read(&mut tx, &id).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<ShiftExportRows>, ApiError> {
    let shift: Option<ShiftRow> = sqlx::query_as(SHIFT_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(shift) = shift else {
        return Ok(None);
    };
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let codes: Vec<(String, String, String)> = sqlx::query_as(CODES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    type BoxRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let boxes: Vec<BoxRow> = sqlx::query_as(BOXES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let items: Vec<(String, String)> = sqlx::query_as(ITEMS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    type PalletRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let pallets: Vec<PalletRow> = sqlx::query_as(PALLETS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let created_from = shift.created_from.parse().map_err(ApiError::internal)?;
    Ok(Some(ShiftExportRows {
        shift: ExportShift {
            number: shifts::format_number(&shift.number_month_key, shift.number_seq, created_from),
            id: shift.id,
            status: shift.status.parse().map_err(ApiError::internal)?,
            production_date: shift.production_date,
            product_name: shift.product_name,
            pallets_enabled: shift.pallets_enabled,
            closed_at: shift.closed_at,
            station_closed_at: shift.station_closed_at,
            late_data_at: shift.late_data_at,
        },
        organization: ExportOrganization { name, inn },
        codes: codes
            .into_iter()
            .map(|(code_hash, scanned_at, canonical)| ExportCode {
                code_hash,
                scanned_at,
                canonical,
            })
            .collect(),
        boxes: boxes
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at, pallet_id)| ExportBox {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                    pallet_id,
                },
            )
            .collect(),
        items: items
            .into_iter()
            .map(|(box_id, code_hash)| ExportItem { box_id, code_hash })
            .collect(),
        pallets: pallets
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at)| ExportPallet {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                },
            )
            .collect(),
    }))
}
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/shifts/{id}/export-source",
            get(crate::routes::office_exports::export_source),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

/// `GET /v1/office/shifts/{id}/export-source` (plan ЧЗ): what a shift's
/// exports are built from, read in one snapshot. The office ports the
/// cloud's source rules (`shift-export-source.service.ts`) over these rows
/// and renders the files with `@markiro/domain`; the host checks nothing of
/// an export itself. `codes` are the codes the shift owns, each with the
/// canonical text of its owning scan (crypto tail included); `boxes` every
/// box of the shift, open and taken apart ones too; `items` the live items
/// of those boxes only (neither taken out by an exception nor taken by an
/// earlier scan elsewhere), the only ones the cloud's rules ever read;
/// `pallets` every pallet of the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftExportRows {
    pub shift: ExportShift,
    pub organization: ExportOrganization,
    pub codes: Vec<ExportCode>,
    pub boxes: Vec<ExportBox>,
    pub items: Vec<ExportItem>,
    pub pallets: Vec<ExportPallet>,
}

/// The shift of [`ShiftExportRows`]. `closedAt` is the host's (whole
/// seconds); `stationClosedAt` is the instant of the station's close the
/// host accepted (the device's, with milliseconds), `null` when the office
/// closed the shift or it is not closed. `productName` is the product's
/// name now, as the cloud's export joins it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub production_date: String,
    pub product_name: String,
    pub pallets_enabled: bool,
    pub closed_at: Option<String>,
    pub station_closed_at: Option<String>,
    pub late_data_at: Option<String>,
}

/// The organization as the ЧЗ document names it: `org_name` and `LP_TIN`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOrganization {
    pub name: String,
    pub inn: Option<String>,
}

/// A code the shift owns: its hash, the instant of its owning scan and that
/// scan's canonical text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCode {
    pub code_hash: String,
    pub scanned_at: String,
    pub canonical: String,
}

/// A box of the shift; the device's instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBox {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub pallet_id: Option<String>,
}

/// A live item: the code `codeHash` lies in box `boxId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub box_id: String,
    pub code_hash: String,
}

/// A pallet of the shift; the device's instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
```

5. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  productGroupSchema,
  officeShiftSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  pairingCodeSchema,
  productGroupSchema,
  officeShiftSchema,
  shiftExportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

6. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

заменить на

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftExportRows,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  /** `204`, only a planned shift; a delete repeated after a lost answer is `not_found`. */
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  /** `204`, only a planned shift; a delete repeated after a lost answer is `not_found`. */
  deleteShift: (token: string, id: string) => Promise<void>;
  closeShift: (token: string, id: string, close: ShiftClose) => Promise<OfficeShift>;
  /**
   * What the shift's exports are built from, in one snapshot of the host
   * (plan ЧЗ); every office role. A planned shift answers with empty lists.
   */
  getShiftExportSource: (token: string, id: string) => Promise<ShiftExportRows>;
}

/** A 204 answer parses as `null`. */
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: officeShiftSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: officeShiftSchema,
      }),
    getShiftExportSource: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/export-source`, {
        officeToken: token,
        schema: shiftExportRowsSchema,
      }),
  };
}
```

9. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OfficeShift = z.infer<typeof officeShiftSchema>;

/**
 * Mirrors `markiro_proto::ShiftExportRows`: `GET /v1/office/shifts/{id}/export-source`
 * (plan ЧЗ), what a shift's exports are built from, in one snapshot of the
 * host. `codes` are the codes the shift owns with their owning scans'
 * canonical text; `boxes` every box of the shift; `items` the live items of
 * those boxes only; `pallets` every pallet of the shift. A device's ids,
 * SSCCs and codes are read as plain text: the ported source rules and the
 * domain's renderer say what is wrong with one (`INVALID_BOX_SSCC`,
 * `INVALID_CIS`), as the cloud's export does, instead of the whole answer
 * failing as an invalid response.
 */
export const shiftExportRowsSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    number: z.string().min(1),
    status: shiftStatusSchema,
    productionDate: civilDateTextSchema,
    productName: z.string(),
    palletsEnabled: z.boolean(),
    closedAt: z.iso.datetime().nullable(),
    stationClosedAt: z.iso.datetime().nullable(),
    lateDataAt: z.iso.datetime().nullable(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(
    z.object({ codeHash: z.string(), scannedAt: z.iso.datetime(), canonical: z.string() }),
  ),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(z.object({ boxId: z.string(), codeHash: z.string() })),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type ShiftExportRows = z.infer<typeof shiftExportRowsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: PASS: `test result: ok. 46 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`

Expected: PASS: `test result: ok. 4 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: PASS: `Tests  267 passed (267)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **M1** (коды без отбора по смене): в `apps/standalone/host/src/routes/office_exports.rs` `JOIN code_owners o ON o.scan_id = s.id WHERE s.shift_id = ? \` → `JOIN code_owners o ON o.scan_id = s.id WHERE s.shift_id <> '' OR ? \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`, `every_query_of_the_source_searches_by_an_index`, `the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets`.
- **M2** (снятые позиции остаются в выгрузке): в `apps/standalone/host/src/routes/office_exports.rs` `JOIN box_items i ON i.box_id = b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL` → `JOIN box_items i ON i.box_id = b.id AND i.displaced_at IS NULL`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`, `every_query_of_the_source_searches_by_an_index`, `the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets`.
- **M3** (вытесненные позиции остаются в выгрузке): в `apps/standalone/host/src/routes/office_exports.rs` `JOIN box_items i ON i.box_id = b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL` → `JOIN box_items i ON i.box_id = b.id AND i.removed_at IS NULL`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`, `every_query_of_the_source_searches_by_an_index`.
- **M4** (паллеты без отбора по смене): в `apps/standalone/host/src/routes/office_exports.rs` `FROM pallets WHERE shift_id = ? ORDER BY` → `FROM pallets WHERE shift_id <> '' OR ? ORDER BY`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `every_query_of_the_source_searches_by_an_index`, `the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets`.
- **M5** (короба без отбора по смене): в `apps/standalone/host/src/routes/office_exports.rs` `FROM boxes WHERE shift_id = ? ORDER BY opened_at, id` → `FROM boxes WHERE shift_id <> '' OR ? ORDER BY opened_at, id`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`, `every_query_of_the_source_searches_by_an_index`, `the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets`.
- **M6** (закрытие станцией, пришедшее после закрытия из офиса (`already_closed`), считается закрытием смены): в `apps/standalone/host/src/routes/office_exports.rs` `AND e.outcome = 'accepted' ORDER BY` → `ORDER BY`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`.
- **M7** (позиции без отбора по смене): в `apps/standalone/host/src/routes/office_exports.rs` `WHERE b.shift_id = ? ORDER BY i.box_id, i.code_hash` → `WHERE b.shift_id <> '' OR ? ORDER BY i.box_id, i.code_hash`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`, `every_query_of_the_source_searches_by_an_index`, `the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets`.
- **M8** (коды через `code_owners.shift_id`, без индекса): в `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub const CODES_SQL: &str = "SELECT o.code_hash, o.scanned_at, s.canonical FROM scans s \
     JOIN code_owners o ON o.scan_id = s.id WHERE s.shift_id = ? \
```

заменить на

<!-- prettier-ignore -->
```rust
pub const CODES_SQL: &str = "SELECT o.code_hash, o.scanned_at, s.canonical FROM code_owners o \
     JOIN scans s ON o.scan_id = s.id WHERE o.shift_id = ? \
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `every_query_of_the_source_searches_by_an_index`.

- **M9** (поздние данные теряются): в `apps/standalone/host/src/routes/office_exports.rs` `late_data_at: shift.late_data_at,` → `late_data_at: None,`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`.
- **M10** (название товара из снимка, а не текущее): в `apps/standalone/host/src/routes/office_exports.rs` `s.status, s.production_date, p.name AS product_name,` → `s.status, s.production_date, COALESCE(json_extract(s.snapshot, '$.product.name'), p.name) AS product_name,`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/office_exports.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_exports.rs apps/standalone/proto/fixtures/shift-export-rows.json apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the host answers a shift's export rows in one snapshot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Короба и паллеты смены для карточки О-Ф: `GET …/boxes` и `GET …/pallets`

Часть О-Х, которую выгрузке видеть не нужно, а карточке смены плана О-Ф — нужно: короб с живыми позициями сейчас, тем, что станция сообщила при закрытии, и проверкой этикетки; паллета с тем, что на ней стоит (закрытые нерасформированные короба и их живые позиции, как карточка паллеты облака) рядом со счётом станции. Счёт выводится при чтении, не хранится. Тест строит смену, где короб на паллете расформирован, код вытеснен коллегой, этикетка короба пропущена, этикетка паллеты проверена, вторая паллета открыта, и смену коллеги с коробом и паллетой.

**Files:**

- Create: `apps/standalone/host/src/routes/office_boxes.rs`, `apps/standalone/host/tests/office_boxes.rs`, `apps/standalone/proto/fixtures/office-boxes.json`, `apps/standalone/proto/fixtures/office-pallets.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: `boxes`, `box_items`, `pallets` (2a2, ПЛ-Х); фикстура `shift-export-rows.json` задачи 1 (тест фикстур сверяет списки с ней).
- Produces: `markiro_proto::{OfficeBox, OfficePallet}`; маршруты `GET /v1/office/shifts/{id}/boxes` и `…/pallets`; `markiro_host::routes::office_boxes::{BOXES_SQL, PALLETS_SQL}`; Zod `officeBoxSchema`, `officePalletSchema`; `HostApi.listShiftBoxes(token, id): Promise<OfficeBox[]>`, `HostApi.listShiftPallets(token, id): Promise<OfficePallet[]>`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/host/tests/office_boxes.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, empty, fact, instant, issue_block,
    issue_pallet_block, ok_scan, open_pallet_floor, pair_device, pallet_closed, pallet_id,
    pallet_sscc, plan_shift, receipts, record_id, request, shift_body, shift_setup, sscc,
    with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// The `data` of box `n` closed with `serial` over `members`, on `pallet`.
fn closed_on(
    block: &Value,
    n: u32,
    serial: u64,
    members: &[u32],
    opened: u32,
    closed: u32,
    pallet: Option<&str>,
) -> Value {
    let mut data = box_closed(
        &box_id(n),
        block,
        serial,
        members,
        &instant(opened, 0),
        &instant(closed, 0),
    );
    if let Some(pallet) = pallet {
        data["palletId"] = json!(pallet);
    }
    data
}

/// A day of a shift with pallets: box 1 (codes 1 and 2) and box 2 (code
/// 3) closed on pallet 1, box 2 then taken apart; box 3 open with code 4;
/// box 4 (code 5) closed on no pallet, its label skipped; box 5 (code 6)
/// closed on pallet 2, which stays open; pallet 1 closed (the station
/// counted 2 boxes) and its label checked. A colleague's code then takes
/// code 2 from box 1. The colleague's shift has a box and a pallet of its
/// own. The lists name exactly the shift's boxes and pallets, opened first
/// first, with what is live on them now.
#[tokio::test]
async fn the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(45, 0));
    disassemble["reasonCode"] = json!("other");
    disassemble["reasonText"] = json!("Помятый короб");
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let p1 = pallet_id(1);
    let p2 = pallet_id(2);
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            scan(2, 2, 1, 11),
            fact(
                &record_id(3),
                "box_closed",
                &shift,
                closed_on(&block, 1, 1500, &[1, 2], 10, 20, Some(&p1)),
            ),
            scan(4, 3, 2, 30),
            fact(
                &record_id(5),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1501, &[3], 30, 40, Some(&p1)),
            ),
            fact(
                &record_id(6),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 2, &instant(20, 0), &instant(41, 500)),
            ),
            fact(
                &record_id(7),
                "pallet_label",
                &shift,
                json!({ "palletId": p1, "outcome": "verified", "at": instant(42, 0) }),
            ),
            fact(&record_id(8), "box_exception", &shift, disassemble),
            scan(9, 4, 3, 50),
            scan(10, 5, 4, 60),
            fact(
                &record_id(11),
                "box_closed",
                &shift,
                closed_on(&block, 4, 1502, &[5], 60, 65, None),
            ),
            fact(
                &record_id(12),
                "box_label",
                &shift,
                json!({ "boxId": box_id(4), "outcome": "skipped", "at": instant(66, 0) }),
            ),
            scan(13, 6, 5, 70),
            fact(
                &record_id(14),
                "box_closed",
                &shift,
                closed_on(&block, 5, 1503, &[6], 70, 75, Some(&p2)),
            ),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    let p11 = pallet_id(11);
    accept(
        &admin,
        &colleague,
        &[
            // An earlier scan of code 2 takes it from box 1.
            fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                ok_scan(2, &box_id(11), &instant(5, 0)),
            ),
            fact(
                &record_id(2),
                "box_closed",
                &colleague.shift,
                closed_on(&colleague_block, 11, 3500, &[2], 5, 6, Some(&p11)),
            ),
            fact(
                &record_id(3),
                "pallet_closed",
                &colleague.shift,
                pallet_closed(
                    &p11,
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(7, 0),
                ),
            ),
        ],
    )
    .await;

    let station = floor.station.clone();
    let (status, boxes) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/boxes"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{boxes}");
    assert_eq!(
        boxes,
        json!([
            {
                "id": box_id(1), "deviceId": station, "sscc": sscc(1500),
                "openedAt": instant(10, 0), "closedAt": instant(20, 0), "disassembledAt": null,
                "palletId": p1, "units": 1, "itemCountReported": 2,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(2), "deviceId": station, "sscc": sscc(1501),
                "openedAt": instant(30, 0), "closedAt": instant(40, 0),
                "disassembledAt": instant(45, 0), "palletId": p1, "units": 0,
                "itemCountReported": 1, "digestMatches": true,
                "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(3), "deviceId": station, "sscc": null,
                "openedAt": instant(50, 0), "closedAt": null, "disassembledAt": null,
                "palletId": null, "units": 1, "itemCountReported": null,
                "digestMatches": null, "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(4), "deviceId": station, "sscc": sscc(1502),
                "openedAt": instant(60, 0), "closedAt": instant(65, 0), "disassembledAt": null,
                "palletId": null, "units": 1, "itemCountReported": 1,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": instant(66, 0),
            },
            {
                "id": box_id(5), "deviceId": station, "sscc": sscc(1503),
                "openedAt": instant(70, 0), "closedAt": instant(75, 0), "disassembledAt": null,
                "palletId": p2, "units": 1, "itemCountReported": 1,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": null,
            },
        ])
    );
    let (status, listed) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/pallets"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(
        listed,
        json!([
            {
                // Box 2 was taken apart and code 2 taken from box 1: one
                // box and one unit stand on the pallet, though the station
                // counted two boxes at its close.
                "id": p1, "deviceId": station, "sscc": pallet_sscc(40),
                "openedAt": instant(20, 0), "closedAt": instant(41, 500), "disassembledAt": null,
                "boxes": 1, "units": 1, "boxCountReported": 2,
                "printVerifiedAt": instant(42, 0), "printSkippedAt": null,
            },
            {
                "id": p2, "deviceId": station, "sscc": null,
                "openedAt": instant(75, 0), "closedAt": null, "disassembledAt": null,
                "boxes": 1, "units": 1, "boxCountReported": null,
                "printVerifiedAt": null, "printSkippedAt": null,
            },
        ])
    );
    let (_, theirs) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/pallets", colleague.shift),
            None,
        )
        .await;
    assert_eq!(theirs.as_array().map(Vec::len), Some(1), "{theirs}");
    assert_eq!(theirs[0]["units"], 1);
    let (_, their_boxes) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/boxes", colleague.shift),
            None,
        )
        .await;
    assert_eq!(
        their_boxes.as_array().map(Vec::len),
        Some(1),
        "{their_boxes}"
    );
}

/// Every office role reads both lists; an unknown shift is `not_found`, a
/// planned one has none; the device key alone is no office session.
#[tokio::test]
async fn every_office_role_reads_the_lists_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let technologist = admin.technologist().await;
    for list in ["boxes", "pallets"] {
        let path = format!("/v1/office/shifts/{id}/{list}");
        let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
        assert_eq!((status, body), (StatusCode::OK, json!([])), "{list}");
        let unknown = format!("/v1/office/shifts/0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b/{list}");
        let (status, body) = admin.call("GET", &unknown, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "not_found");
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", &path), &admin.key)))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
}

/// Both lists search by an index, the per-row counts too.
#[tokio::test]
async fn both_lists_search_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("boxes", markiro_host::routes::office_boxes::BOXES_SQL),
        ("pallets", markiro_host::routes::office_boxes::PALLETS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
    }
}
```

2. Создать `apps/standalone/proto/fixtures/office-boxes.json`:

<!-- prettier-ignore -->
```json
[
  {
    "id": "b0000000-0000-4000-8000-000000000001",
    "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "sscc": "046006820000015000",
    "openedAt": "2026-10-08T06:05:12.031Z",
    "closedAt": "2026-10-08T06:06:01.118Z",
    "disassembledAt": null,
    "palletId": "a0000000-0000-4000-8000-000000000001",
    "units": 2,
    "itemCountReported": 2,
    "digestMatches": true,
    "printVerifiedAt": "2026-10-08T06:06:09.540Z",
    "printSkippedAt": null
  },
  {
    "id": "b0000000-0000-4000-8000-000000000002",
    "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "sscc": "046006820000015017",
    "openedAt": "2026-10-08T06:06:40.507Z",
    "closedAt": "2026-10-08T06:07:15.902Z",
    "disassembledAt": null,
    "palletId": null,
    "units": 1,
    "itemCountReported": 1,
    "digestMatches": true,
    "printVerifiedAt": null,
    "printSkippedAt": "2026-10-08T06:07:20.001Z"
  },
  {
    "id": "b0000000-0000-4000-8000-000000000003",
    "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "sscc": null,
    "openedAt": "2026-10-08T06:08:02.244Z",
    "closedAt": null,
    "disassembledAt": null,
    "palletId": null,
    "units": 0,
    "itemCountReported": null,
    "digestMatches": null,
    "printVerifiedAt": null,
    "printSkippedAt": null
  }
]
```

3. Создать `apps/standalone/proto/fixtures/office-pallets.json`:

<!-- prettier-ignore -->
```json
[
  {
    "id": "a0000000-0000-4000-8000-000000000001",
    "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "sscc": "146006820000000409",
    "openedAt": "2026-10-08T06:06:01.118Z",
    "closedAt": "2026-10-08T06:20:44.650Z",
    "disassembledAt": null,
    "boxes": 1,
    "units": 2,
    "boxCountReported": 1,
    "printVerifiedAt": "2026-10-08T06:20:51.300Z",
    "printSkippedAt": null
  }
]
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody,
    ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PalletExceptionFact,
    PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict, ShiftClose,
    ShiftClosedFact, ShiftCreate, ShiftExportRows, ShiftMode, ShiftOrigin, ShiftStatus,
    ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState,
    TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody,
    ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeBox,
    OfficeLine, OfficeLoginRequest, OfficeOperator, OfficePallet, OfficeProduct, OfficeRole,
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact,
    PalletExceptionFact, PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet,
    ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact,
    ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate, ShiftExportRows, ShiftMode,
    ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest,
    SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    );
    assert!(rows.codes.iter().all(|c| c.canonical.contains('\u{1d}')));
}
```

заменить на

<!-- prettier-ignore -->
```rust
    );
    assert!(rows.codes.iter().all(|c| c.canonical.contains('\u{1d}')));
}

/// The office's lists of a shift's boxes and pallets (plan ЧЗ) round-trip
/// and agree with the export source of the same shift: the same boxes and
/// pallets, a box's live units are its live items there, and a pallet's
/// boxes and units are those of its closed boxes not taken apart.
#[test]
fn office_box_and_pallet_lists_round_trip_and_agree_with_the_export_source() {
    let boxes: Vec<OfficeBox> = round_trip("office-boxes.json");
    let pallets: Vec<OfficePallet> = round_trip("office-pallets.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(
        boxes.iter().map(|b| &b.id).collect::<Vec<_>>(),
        rows.boxes.iter().map(|b| &b.id).collect::<Vec<_>>()
    );
    for b in &boxes {
        let live = rows.items.iter().filter(|i| i.box_id == b.id).count();
        assert_eq!(usize::try_from(b.units).unwrap(), live, "{b:?}");
    }
    for p in &pallets {
        let on: Vec<&OfficeBox> = boxes
            .iter()
            .filter(|b| b.pallet_id.as_deref() == Some(&p.id) && b.disassembled_at.is_none())
            .collect();
        assert_eq!(usize::try_from(p.boxes).unwrap(), on.len(), "{p:?}");
        assert_eq!(
            p.units,
            on.iter().map(|b| u64::from(b.units)).sum::<u64>(),
            "{p:?}"
        );
    }
}
```

6. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/export-source`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/export-source`, body: undefined },
  ],
  [
    "listShiftBoxes",
    fixture("office-boxes.json"),
    (api) => api.listShiftBoxes(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/boxes`, body: undefined },
  ],
  [
    "listShiftPallets",
    fixture("office-pallets.json"),
    (api) => api.listShiftPallets(TOKEN, SHIFT_ID),
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/pallets`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

7. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officeProductSchema,
  officeSessionSchema,
  officeShiftSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  lineCreateSchema,
  lineRecordSchema,
  lineUpdateSchema,
  officeBoxSchema,
  officeLineSchema,
  officeLoginRequestSchema,
  officeOperatorSchema,
  officePalletSchema,
  officeProductSchema,
  officeSessionSchema,
  officeShiftSchema,
```

8. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each([
  ["office-boxes.json", officeBoxSchema],
  ["office-pallets.json", officePalletSchema],
] as const)("list fixture %s (plan ЧЗ)", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.array().parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    const rows = fixture(name) as Record<string, unknown>[];
    expect(
      schema.array().safeParse(rows.map((row) => ({ ...row, addedLater: true }))).success,
    ).toBe(true);
  });
});

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
```

9. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    getShiftExportSource: vi.fn<HostApi["getShiftExportSource"]>(() =>
      unexpected("getShiftExportSource"),
    ),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    getShiftExportSource: vi.fn<HostApi["getShiftExportSource"]>(() =>
      unexpected("getShiftExportSource"),
    ),
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    ...overrides,
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: FAIL при сборке: «unresolved imports `markiro_proto::OfficeBox`, `markiro_proto::OfficePallet`».

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`

Expected: FAIL при сборке: «could not find `office_boxes` in `routes`» (2 раза).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: FAIL: `Tests  6 failed | 267 passed (273)` — «listShiftBoxes/listShiftPallets sends the office token…» (`… is not a function`) и четыре теста «list fixture office-boxes.json / office-pallets.json (plan ЧЗ)» (`reading 'array'`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_exports;
pub mod office_shifts;
pub mod office_users;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_boxes;
pub mod office_exports;
pub mod office_shifts;
pub mod office_users;
```

2. Создать `apps/standalone/host/src/routes/office_boxes.rs`:

<!-- prettier-ignore -->
```rust
//! A shift's boxes and pallets as the office lists them (plan ЧЗ, for the
//! shift's card of plan О-Ф): `GET /v1/office/shifts/{id}/boxes` and
//! `…/pallets`, every office role. Counts are derived from the facts at the
//! moment of reading, as the cloud's pallet card derives them, and never
//! stored; each list reads in one snapshot through the indexes of `0010` and
//! `0012`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeBox, OfficePallet};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

/// Every box of the shift, opened first first, with its live items.
pub const BOXES_SQL: &str = "SELECT b.id, b.device_id, b.sscc, b.opened_at, b.closed_at, \
     b.disassembled_at, b.pallet_id, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
     b.item_count_reported, b.digest_matches, b.print_verified_at, b.print_skipped_at \
     FROM boxes b WHERE b.shift_id = ? ORDER BY b.opened_at, b.id";

/// Every pallet of the shift, opened first first, with what stands on it:
/// its closed boxes not taken apart and their live items.
pub const PALLETS_SQL: &str = "SELECT p.id, p.device_id, p.sscc, p.opened_at, p.closed_at, \
     p.disassembled_at, \
     (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL \
      WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) \
      AS units, \
     p.box_count_reported, p.print_verified_at, p.print_skipped_at \
     FROM pallets p WHERE p.shift_id = ? ORDER BY p.opened_at, p.id";

#[derive(sqlx::FromRow)]
struct BoxRow {
    id: String,
    device_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    pallet_id: Option<String>,
    units: i64,
    item_count_reported: Option<u32>,
    digest_matches: Option<bool>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    device_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    boxes: i64,
    units: i64,
    box_count_reported: Option<u32>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
}

async fn require_shift(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// `GET /v1/office/shifts/{id}/boxes`: an unknown shift is `not_found`.
pub async fn list_boxes(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<OfficeBox>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = async {
        require_shift(&mut tx, &id).await?;
        sqlx::query_as::<_, BoxRow>(BOXES_SQL)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .into_iter()
        .map(|row| {
            Ok(OfficeBox {
                id: row.id,
                device_id: row.device_id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                pallet_id: row.pallet_id,
                units: u32::try_from(row.units).map_err(ApiError::internal)?,
                item_count_reported: row.item_count_reported,
                digest_matches: row.digest_matches,
                print_verified_at: row.print_verified_at,
                print_skipped_at: row.print_skipped_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}

/// `GET /v1/office/shifts/{id}/pallets`: an unknown shift is `not_found`.
pub async fn list_pallets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<OfficePallet>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = async {
        require_shift(&mut tx, &id).await?;
        sqlx::query_as::<_, PalletRow>(PALLETS_SQL)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .into_iter()
        .map(|row| {
            Ok(OfficePallet {
                id: row.id,
                device_id: row.device_id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                boxes: u32::try_from(row.boxes).map_err(ApiError::internal)?,
                units: u64::try_from(row.units).map_err(ApiError::internal)?,
                box_count_reported: row.box_count_reported,
                print_verified_at: row.print_verified_at,
                print_skipped_at: row.print_skipped_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/shifts/{id}/export-source",
            get(crate::routes::office_exports::export_source),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/shifts/{id}/boxes",
            get(crate::routes::office_boxes::list_boxes),
        )
        .route(
            "/v1/office/shifts/{id}/pallets",
            get(crate::routes::office_boxes::list_pallets),
        )
        .route(
            "/v1/office/shifts/{id}/export-source",
            get(crate::routes::office_exports::export_source),
        )
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

/// `GET /v1/office/shifts/{id}/export-source` (plan ЧЗ): what a shift's
/// exports are built from, read in one snapshot. The office ports the
/// cloud's source rules (`shift-export-source.service.ts`) over these rows
```

заменить на

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

/// A box of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/boxes`, plan ЧЗ for the card of plan О-Ф): the
/// device's instants as it sent them; `units` the box's live items now;
/// `itemCountReported` and `digestMatches` what the station's close said
/// and how it compared at that moment (stale once the box is taken apart);
/// the label check's instants as the station sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBox {
    pub id: String,
    pub device_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub pallet_id: Option<String>,
    pub units: u32,
    pub item_count_reported: Option<u32>,
    pub digest_matches: Option<bool>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
}

/// A pallet of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/pallets`, plan ЧЗ for plan О-Ф): `boxes` its closed
/// boxes not taken apart and `units` their live items, both derived as the
/// cloud's pallet card derives them; `boxCountReported` what the station's
/// close counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePallet {
    pub id: String,
    pub device_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
}

/// `GET /v1/office/shifts/{id}/export-source` (plan ЧЗ): what a shift's
/// exports are built from, read in one snapshot. The office ports the
/// cloud's source rules (`shift-export-source.service.ts`) over these rows
```

5. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  deviceRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  officeLineSchema,
  officeOperatorSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserRecordSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  deviceRecordSchema,
  labelTemplateSchema,
  labelTemplateSummarySchema,
  officeBoxSchema,
  officeLineSchema,
  officeOperatorSchema,
  officePalletSchema,
  officeProductSchema,
  officeSessionSchema,
  officeUserRecordSchema,
```

6. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  type LabelTemplateSummary,
  type LineCreate,
  type LineUpdate,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficeProduct,
  type OfficeSession,
  type OfficeShift,
```

заменить на

<!-- prettier-ignore -->
```ts
  type LabelTemplateSummary,
  type LineCreate,
  type LineUpdate,
  type OfficeBox,
  type OfficeLine,
  type OfficeLoginRequest,
  type OfficeOperator,
  type OfficePallet,
  type OfficeProduct,
  type OfficeSession,
  type OfficeShift,
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
   * (plan ЧЗ); every office role. A planned shift answers with empty lists.
   */
  getShiftExportSource: (token: string, id: string) => Promise<ShiftExportRows>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
   * (plan ЧЗ); every office role. A planned shift answers with empty lists.
   */
  getShiftExportSource: (token: string, id: string) => Promise<ShiftExportRows>;
  /** Every box of the shift, opened first first, with its live units (plan ЧЗ, for plan О-Ф). */
  listShiftBoxes: (token: string, id: string) => Promise<OfficeBox[]>;
  /** Every pallet of the shift, opened first first, with what stands on it (plan ЧЗ). */
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
}

/** A 204 answer parses as `null`. */
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: shiftExportRowsSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: shiftExportRowsSchema,
      }),
    listShiftBoxes: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/boxes`, {
        officeToken: token,
        schema: z.array(officeBoxSchema),
      }),
    listShiftPallets: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/pallets`, {
        officeToken: token,
        schema: z.array(officePalletSchema),
      }),
  };
}
```

9. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
});
export type ShiftExportRows = z.infer<typeof shiftExportRowsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type ShiftExportRows = z.infer<typeof shiftExportRowsSchema>;

/**
 * Mirrors `markiro_proto::OfficeBox`: a box of `GET /v1/office/shifts/{id}/boxes`
 * (plan ЧЗ, for the shift's card of plan О-Ф). `units` are its live items
 * now; `itemCountReported` and `digestMatches` are what the station's close
 * said and how it compared then, stale once the box is taken apart.
 */
export const officeBoxSchema = z.object({
  id: z.string(),
  deviceId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  palletId: z.string().nullable(),
  units: z.number().int().nonnegative(),
  itemCountReported: z.number().int().nonnegative().nullable(),
  digestMatches: z.boolean().nullable(),
  printVerifiedAt: z.iso.datetime().nullable(),
  printSkippedAt: z.iso.datetime().nullable(),
});
export type OfficeBox = z.infer<typeof officeBoxSchema>;

/**
 * Mirrors `markiro_proto::OfficePallet`: a pallet of `GET
 * /v1/office/shifts/{id}/pallets` (plan ЧЗ, for plan О-Ф). `boxes` are its
 * closed boxes not taken apart and `units` their live items, derived when
 * read; `boxCountReported` is what the station's close counted.
 */
export const officePalletSchema = z.object({
  id: z.string(),
  deviceId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  boxes: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  boxCountReported: z.number().int().positive().nullable(),
  printVerifiedAt: z.iso.datetime().nullable(),
  printSkippedAt: z.iso.datetime().nullable(),
});
export type OfficePallet = z.infer<typeof officePalletSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: PASS: `test result: ok. 47 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`

Expected: PASS: `test result: ok. 3 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: PASS: `Tests  273 passed (273)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **B1** (единицы короба с вытесненными позициями): в `apps/standalone/host/src/routes/office_boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL) AS units, \
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `both_lists_search_by_an_index`, `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.

- **B2** (единицы короба со снятыми позициями): в `apps/standalone/host/src/routes/office_boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.displaced_at IS NULL) AS units, \
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `both_lists_search_by_an_index`, `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.

- **B3** (короба без отбора по смене): в `apps/standalone/host/src/routes/office_boxes.rs` `FROM boxes b WHERE b.shift_id = ? ORDER BY b.opened_at, b.id";` → `FROM boxes b WHERE b.shift_id <> '' OR ? ORDER BY b.opened_at, b.id";`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `both_lists_search_by_an_index`, `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.
- **B4** (расформированный короб стоит на паллете): в `apps/standalone/host/src/routes/office_boxes.rs` `AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \` → `AND b.closed_at IS NOT NULL) AS boxes, \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.
- **B5** (единицы паллеты с вытесненными позициями): в `apps/standalone/host/src/routes/office_boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL \
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      AND i.removed_at IS NULL \
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.

- **B6** (паллеты без отбора по смене): в `apps/standalone/host/src/routes/office_boxes.rs` `FROM pallets p WHERE p.shift_id = ? ORDER BY p.opened_at, p.id";` → `FROM pallets p WHERE p.shift_id <> '' OR ? ORDER BY p.opened_at, p.id";`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `both_lists_search_by_an_index`, `the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them`.
- **B7** (единицы паллеты всех её коробов): в `apps/standalone/host/src/routes/office_boxes.rs` `WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) \` → `WHERE b.pallet_id = p.id) \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: PASS — эквивалентный мутант: у хоста позиции расформированного короба сняты (план 2a2, задача 5), а короб с `pallet_id` всегда закрыт: обе части условия ничего не отсекают.
- **B8** (неизвестная смена отвечает пустым списком): в `apps/standalone/host/src/routes/office_boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("no such shift"))
```

заменить на

<!-- prettier-ignore -->
```rust
    let _ = found;
    Ok(())
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_boxes`. Ожидается: FAIL — `every_office_role_reads_the_lists_and_an_unknown_shift_is_not_found`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/office_boxes.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_boxes.rs apps/standalone/proto/fixtures/office-boxes.json apps/standalone/proto/fixtures/office-pallets.json apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the office lists a shift's boxes and pallets with what is live on them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Запись выгрузки в журнал: `POST /v1/office/shifts/{id}/exports` и общая фикстура форматов

Выгрузка ничего не меняет на хосте, но спецификация требует строку журнала `shift.export` с форматом, версией, частями и счётчиками. Хост проверяет то, что может проверить сам: формат — один из рекламируемых доменом (`export-formats.json` держат Rust и Vitest против `SHIFT_EXPORT_FORMATS`/`PALLET_EXPORT_FORMATS`, так что новый формат домена не запишется, пока хост его не знает), паллета названа ровно у паллетного формата и принадлежит смене, `maxLines` в 2–1 000 000 и не у паллеты, `documentId` — UUID, частей не меньше одной, у паллеты ровно одна, смена закрыта для сменного формата (как облачный `create` отказывает 409). Состояние паллеты не проверяется снова: файлы уже записаны. Ревизия не берётся, сессия перечитывается внутри транзакции (`require_session_in`), отказ строк не пишет. Строитель `shiftExportRecord` суммирует части, как облако считает итоги выгрузки.

**Files:**

- Create: `apps/standalone/proto/fixtures/shift-export-record.json`, `apps/standalone/proto/fixtures/export-formats.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/routes/office_exports.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/tests/office_exports.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: `office_exports.rs` задачи 1; `audit::record`, `OfficeContext::require_session_in`, `shifts::status_conflict`, `validate::client_uuid`.
- Produces: `markiro_proto::ShiftExportRecord` (строгий запрос); `audit::actions::SHIFT_EXPORT = "shift.export"`; `markiro_host::routes::office_exports::{SHIFT_FORMATS, PALLET_FORMATS, record_export}`; Zod `shiftExportRecordSchema`, тип `ShiftExportRecord`; `ExportWritten` и `shiftExportRecord(written): ShiftExportRecord` в `src/host/requests.ts`; `HostApi.recordShiftExport(token, id, record): Promise<void>`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/host/tests/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
    admin, box_closed, box_exception, box_id, close_from_office, code, code_hash, empty, fact,
    instant, issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_closed, shift_setup,
    sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
```

заменить на

<!-- prettier-ignore -->
```rust
    admin, box_closed, box_exception, box_id, close_from_office, code, code_hash, empty, fact,
    instant, issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_closed, shift_setup,
    sscc, with_device, Admin, Floor, ShiftSetup,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
```

2. В `apps/standalone/host/tests/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        );
    }
}

const DOCUMENT: &str = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

/// A record of `format` with no pallet, one part and the counts 3, 2, 1.
fn record_of(format: &str, version: u32) -> Value {
    json!({
        "formatId": format, "formatVersion": version, "maxLines": null, "palletId": null,
        "documentId": DOCUMENT, "partCount": 1, "codeCount": 3, "boxCount": 2,
        "palletCount": 1, "openPalletSuppressedBoxCount": 0,
    })
}

/// A shift with pallets after one box (code 1) on pallet 1, which closed;
/// pallet 2 holds box 2 and stays open. The shift stays active.
async fn pallet_shift(admin: &Admin) -> (ShiftSetup, Floor) {
    let setup = shift_setup(admin).await;
    let floor = open_pallet_floor(admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut first = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(10, 0),
        &instant(11, 0),
    );
    first["palletId"] = json!(pallet_id(1));
    let mut second = box_closed(
        &box_id(2),
        &block,
        1501,
        &[2],
        &instant(20, 0),
        &instant(21, 0),
    );
    second["palletId"] = json!(pallet_id(2));
    accept(
        admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(&record_id(2), "box_closed", &shift, first),
            fact(
                &record_id(3),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(11, 0),
                    &instant(12, 0),
                ),
            ),
            fact(
                &record_id(4),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(20, 0)),
            ),
            fact(&record_id(5), "box_closed", &shift, second),
        ],
    )
    .await;
    (setup, floor)
}

/// The station's close of `floor`'s shift.
async fn close_by_station(admin: &Admin, floor: &Floor) {
    accept(
        admin,
        floor,
        &[fact(
            &record_id(6),
            "shift_closed",
            &floor.shift,
            shift_closed(None, 2, 2, None, &instant(30, 0)),
        )],
    )
    .await;
}

async fn record_export(
    admin: &Admin,
    token: &str,
    shift: &str,
    record: Value,
) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "POST",
            &format!("/v1/office/shifts/{shift}/exports"),
            Some(record),
        )
        .await
}

/// An export of a closed shift writes one `shift.export` row, by whichever
/// office user saved it, with exactly what the record says; a pallet's
/// export of a pallet of an active shift writes one too. Neither takes a
/// revision: nothing a station or a list reads changed.
#[tokio::test]
async fn an_export_writes_one_audit_row_with_what_it_wrote() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    let shift = floor.shift.clone();
    // A pallet's export while the shift is still active.
    let revision = support::app::host_revision(&admin.app).await;
    let mut of_pallet = record_of("pallet_xml_gismt_aggregation", 1);
    of_pallet["palletId"] = json!(pallet_id(1));
    of_pallet["codeCount"] = json!(0);
    of_pallet["boxCount"] = json!(1);
    let (status, body) = record_export(&admin, &admin.token, &shift, of_pallet).await;
    assert_eq!((status, &body), (StatusCode::NO_CONTENT, &Value::Null));
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
    close_by_station(&admin, &floor).await;
    let technologist = admin.technologist_session().await;
    let revision_after_close = support::app::host_revision(&admin.app).await;
    let mut of_shift = record_of("shift_xml_gismt_aggregation_pallets", 1);
    of_shift["maxLines"] = json!(2);
    of_shift["partCount"] = json!(3);
    of_shift["openPalletSuppressedBoxCount"] = json!(1);
    let (status, _) = record_export(&admin, &technologist.0, &shift, of_shift).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        support::app::host_revision(&admin.app).await,
        revision_after_close
    );
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![
            admin.row(
                "shift.export",
                "shift",
                &shift,
                json!({
                    "formatId": "pallet_xml_gismt_aggregation", "formatVersion": 1,
                    "maxLines": null, "palletId": pallet_id(1), "documentId": DOCUMENT,
                    "partCount": 1, "codeCount": 0, "boxCount": 1, "palletCount": 1,
                    "openPalletSuppressedBoxCount": 0,
                })
            ),
            support::app::audit_row(
                &technologist.1,
                "shift.export",
                "shift",
                &shift,
                json!({
                    "formatId": "shift_xml_gismt_aggregation_pallets", "formatVersion": 1,
                    "maxLines": 2, "palletId": null, "documentId": DOCUMENT,
                    "partCount": 3, "codeCount": 3, "boxCount": 2, "palletCount": 1,
                    "openPalletSuppressedBoxCount": 1,
                })
            ),
        ]
    );
}

/// What the host refuses changes nothing and writes no row: a format the
/// domain does not advertise (a retired version too), a pallet named or
/// missing against the format, `maxLines` outside 2–1 000 000 or on a
/// pallet, a `documentId` that is no UUID, no part or a pallet in two
/// parts, an unknown shift, a shift's export of a shift not closed, a pallet
/// of another shift. Both ends of `maxLines` are taken.
#[tokio::test]
async fn a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken() {
    let admin = admin().await;
    let (setup, floor) = pallet_shift(&admin).await;
    let shift = floor.shift.clone();
    let token = admin.token.clone();
    let field = |body: &Value| body["error"]["details"]["field"].clone();
    // The shift is still active: a shift's export is refused.
    let (status, body) =
        record_export(&admin, &token, &shift, record_of("shift_txt_pallets", 1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["status"], "active");
    close_by_station(&admin, &floor).await;
    // The station's next shift has a pallet of its own: pallet 3.
    let next = open_pallet_floor(&admin, &setup, &floor.key, &setup.line).await;
    let block = issue_block(&admin.app, &next.key, BLOCK_REQUEST).await;
    let mut on_three = box_closed(
        &box_id(3),
        &block,
        1502,
        &[3],
        &instant(40, 0),
        &instant(41, 0),
    );
    on_three["palletId"] = json!(pallet_id(3));
    accept(
        &admin,
        &next,
        &[
            fact(
                &record_id(7),
                "scan",
                &next.shift,
                ok_scan(3, &box_id(3), &instant(40, 0)),
            ),
            fact(&record_id(8), "box_closed", &next.shift, on_three),
        ],
    )
    .await;
    let mut cases: Vec<(Value, &str)> = Vec::new();
    cases.push((record_of("shift_pdf_flat", 1), "formatId"));
    cases.push((record_of("shift_txt_boxes", 1), "formatId"));
    cases.push((record_of("pallet_xml_gismt_aggregation", 1), "palletId"));
    let mut named = record_of("shift_txt_flat", 1);
    named["palletId"] = json!(pallet_id(1));
    cases.push((named, "palletId"));
    for lines in [1, 1_000_001] {
        let mut wrong = record_of("shift_txt_flat", 1);
        wrong["maxLines"] = json!(lines);
        cases.push((wrong, "maxLines"));
    }
    let mut pallet_lines = record_of("pallet_xml_gismt_aggregation", 1);
    pallet_lines["palletId"] = json!(pallet_id(1));
    pallet_lines["maxLines"] = json!(2000);
    cases.push((pallet_lines, "maxLines"));
    let mut document = record_of("shift_txt_flat", 1);
    document["documentId"] = json!("SEP26-003");
    cases.push((document, "documentId"));
    let mut no_part = record_of("shift_txt_flat", 1);
    no_part["partCount"] = json!(0);
    cases.push((no_part, "partCount"));
    let mut two_parts = record_of("pallet_xml_gismt_aggregation", 1);
    two_parts["palletId"] = json!(pallet_id(1));
    two_parts["partCount"] = json!(2);
    cases.push((two_parts, "partCount"));
    let mut unknown = record_of("pallet_xml_gismt_aggregation", 1);
    unknown["palletId"] = json!(pallet_id(99));
    cases.push((unknown, "palletId"));
    let mut foreign = record_of("pallet_xml_gismt_aggregation", 1);
    foreign["palletId"] = json!(pallet_id(3));
    cases.push((foreign, "palletId"));
    for (record, expected) in cases {
        let (status, body) = record_export(&admin, &token, &shift, record.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{record} {body}");
        assert_eq!(body["error"]["code"], "validation_failed", "{record}");
        assert_eq!(field(&body), json!(expected), "{record}");
    }
    let (status, body) = record_export(
        &admin,
        &token,
        "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        record_of("shift_txt_flat", 1),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
    for lines in [2, 1_000_000] {
        let mut taken = record_of("shift_txt_flat", 1);
        taken["maxLines"] = json!(lines);
        let (status, body) = record_export(&admin, &token, &shift, taken).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{lines} {body}");
    }
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export")
            .await
            .len(),
        2
    );
}

/// The host's lists of formats are the fixture's, which the webview checks
/// against `@markiro/domain` (`test/protocol.test.ts`).
#[test]
fn the_formats_the_host_takes_are_the_fixtures() {
    let path = format!(
        "{}/../proto/fixtures/export-formats.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let listed = |kind: &str| -> Vec<(String, u32)> {
        fixture[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["id"].as_str().unwrap().to_owned(),
                    u32::try_from(f["version"].as_u64().unwrap()).unwrap(),
                )
            })
            .collect()
    };
    let own = |formats: &[(&str, u32)]| -> Vec<(String, u32)> {
        formats
            .iter()
            .map(|(id, version)| ((*id).to_owned(), *version))
            .collect()
    };
    assert_eq!(
        own(&markiro_host::routes::office_exports::SHIFT_FORMATS),
        listed("shift")
    );
    assert_eq!(
        own(&markiro_host::routes::office_exports::PALLET_FORMATS),
        listed("pallet")
    );
}

/// An office user turned off while the request waited records nothing: the
/// session is read again inside the write.
#[tokio::test]
async fn a_user_turned_off_before_the_write_records_nothing() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let (token, tech_id) = admin.technologist_session().await;
    support::app::turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, body) =
        record_export(&admin, &token, &floor.shift, record_of("shift_txt_flat", 1)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
}
```

3. Создать `apps/standalone/proto/fixtures/export-formats.json`:

<!-- prettier-ignore -->
```json
{
  "shift": [
    { "id": "shift_txt_flat", "version": 1 },
    { "id": "shift_txt_boxes", "version": 2 },
    { "id": "shift_csv_flat", "version": 1 },
    { "id": "shift_csv_boxes", "version": 2 },
    { "id": "shift_xml_gismt_aggregation", "version": 1 },
    { "id": "shift_txt_pallets", "version": 1 },
    { "id": "shift_csv_pallets", "version": 1 },
    { "id": "shift_xml_gismt_aggregation_pallets", "version": 1 },
    { "id": "shift_txt_pallet_boxes", "version": 1 },
    { "id": "shift_xml_gismt_pallet_boxes", "version": 1 }
  ],
  "pallet": [{ "id": "pallet_xml_gismt_aggregation", "version": 1 }]
}
```

4. Создать `apps/standalone/proto/fixtures/shift-export-record.json`:

<!-- prettier-ignore -->
```json
{
  "formatId": "shift_xml_gismt_aggregation_pallets",
  "formatVersion": 1,
  "maxLines": null,
  "palletId": null,
  "documentId": "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
  "partCount": 1,
  "codeCount": 3,
  "boxCount": 2,
  "palletCount": 1,
  "openPalletSuppressedBoxCount": 0
}
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact,
    PalletExceptionFact, PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet,
    ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact,
    ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate, ShiftExportRows, ShiftMode,
    ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest,
    SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose,
    HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

заменить на

<!-- prettier-ignore -->
```rust
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact,
    PalletExceptionFact, PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet,
    ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact,
    ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate, ShiftExportRecord,
    ShiftExportRows, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock,
    SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults, TemplateDefaultsUpdate,
    TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "{p:?}"
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
            "{p:?}"
        );
    }
}

/// The record of an export (plan ЧЗ) round-trips and names a format of
/// `export-formats.json` with the counts of the rows of the same shift: the
/// pallets format over `shift-export-rows.json` writes its three codes, its
/// two closed boxes and its one pallet. A field the host does not read is
/// refused.
#[test]
fn shift_export_record_round_trips_and_counts_the_rows_of_its_shift() {
    let record: ShiftExportRecord = round_trip("shift-export-record.json");
    let formats = fixture("export-formats.json");
    assert!(formats["shift"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["id"] == record.format_id.as_str() && f["version"] == record.format_version));
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(record.code_count, u64::try_from(rows.items.len()).unwrap());
    assert_eq!(
        record.box_count,
        u32::try_from(rows.boxes.iter().filter(|b| b.sscc.is_some()).count()).unwrap()
    );
    assert_eq!(
        record.pallet_count,
        u32::try_from(rows.pallets.len()).unwrap()
    );
    let mut value = fixture("shift-export-record.json");
    value["folder"] = Value::String("C:\\Users".into());
    assert!(serde_json::from_value::<ShiftExportRecord>(value).is_err());
}
```

7. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftUpdateSchema,
  templateCreateSchema,
  templateDefaultsUpdateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftExportRecordSchema,
  shiftUpdateSchema,
  templateCreateSchema,
  templateDefaultsUpdateSchema,
```

8. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));

type Case = [
  name: string,
```

заменить на

<!-- prettier-ignore -->
```ts
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));
const EXPORT_RECORD = shiftExportRecordSchema.parse(fixture("shift-export-record.json"));

type Case = [
  name: string,
```

9. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/pallets`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/shifts/${SHIFT_ID}/pallets`, body: undefined },
  ],
  [
    "recordShiftExport",
    null,
    (api) => api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

10. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
```

заменить на

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PALLET_EXPORT_FORMATS, SHIFT_EXPORT_FORMATS } from "@markiro/domain";

import {
  PROTOCOL_VERSION,
```

11. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftExportRowsSchema,
  shiftUpdateSchema,
  siteRecordSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdateSchema,
  shiftCloseSchema,
  shiftCreateSchema,
  shiftExportRecordSchema,
  shiftExportRowsSchema,
  shiftUpdateSchema,
  siteRecordSchema,
```

12. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  productUpdate,
  shiftClose,
  shiftCreate,
  shiftUpdate,
  templateCreate,
  templateDefaultsUpdate,
```

заменить на

<!-- prettier-ignore -->
```ts
  productUpdate,
  shiftClose,
  shiftCreate,
  shiftExportRecord,
  shiftUpdate,
  templateCreate,
  templateDefaultsUpdate,
```

13. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ["shift-create-pallets.json", shiftCreateSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

заменить на

<!-- prettier-ignore -->
```ts
  ["shift-create-pallets.json", shiftCreateSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
  ["shift-export-record.json", shiftExportRecordSchema],
] as const;

function extended(name: string): Record<string, unknown> {
```

14. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    );
  });

  it("a shift planned with no plan and no counterparty names both as null and still names the mode and pallets", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const body = shiftCreate({
```

заменить на

<!-- prettier-ignore -->
```ts
    );
  });

  it("the record of an export names every field and sums its parts' counts (plan ЧЗ)", () => {
    const written = {
      formatId: "shift_xml_gismt_aggregation_pallets",
      formatVersion: 1,
      maxLines: null,
      palletId: null,
      documentId: "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
      parts: [{ codeCount: 3, boxCount: 2, palletCount: 1 }],
      openPalletSuppressedBoxCount: 0,
    };
    expect(shiftExportRecord(written)).toStrictEqual(fixture("shift-export-record.json"));
    expect(
      shiftExportRecord({
        ...written,
        maxLines: 7,
        parts: [
          { codeCount: 2, boxCount: 1, palletCount: 1 },
          { codeCount: 1, boxCount: 1, palletCount: 0 },
        ],
        openPalletSuppressedBoxCount: 1,
      }),
    ).toStrictEqual({
      ...(fixture("shift-export-record.json") as object),
      maxLines: 7,
      partCount: 2,
      openPalletSuppressedBoxCount: 1,
    });
  });

  it("a shift planned with no plan and no counterparty names both as null and still names the mode and pallets", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const body = shiftCreate({
```

15. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      defaultDuplicateTemplateId: null,
      categories: [],
      expectedRev: 9,
    });
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
      defaultDuplicateTemplateId: null,
      categories: [],
      expectedRev: 9,
    });
  });
});

describe("the formats of exports (plan ЧЗ)", () => {
  it("the host takes exactly the formats the domain advertises (export-formats.json)", () => {
    expect(fixture("export-formats.json")).toEqual({
      shift: SHIFT_EXPORT_FORMATS.map(({ id, version }) => ({ id, version })),
      pallet: PALLET_EXPORT_FORMATS.map(({ id, version }) => ({ id, version })),
    });
  });
});
```

16. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    ),
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    ),
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    ...overrides,
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: FAIL при сборке: «unresolved import `markiro_proto::ShiftExportRecord`».

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`

Expected: FAIL при сборке: «cannot find value `SHIFT_FORMATS` in module `markiro_host::routes::office_exports`» и то же для `PALLET_FORMATS`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: FAIL: `test/api.test.ts` не загружается (`reading 'parse'` у `shiftExportRecordSchema`), в `test/protocol.test.ts` — `Tests  3 failed | 219 passed (222)`: оба теста «request fixture shift-export-record.json» и «the record of an export names every field and sums its parts' counts (plan ЧЗ)» (`shiftExportRecord is not a function`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// The office saved the files of a shift's or a pallet's export (plan
    /// ЧЗ); nothing else changed.
    pub const SHIFT_EXPORT: &str = "shift.export";
}

/// `details.reason` of a denied row: every denial names one.
```

2. В `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! The data of a shift's exports (plan ЧЗ): `GET
//! /v1/office/shifts/{id}/export-source`, every office role. The host only
//! reads: the office ports the cloud's source rules and its completeness
//! checks over these rows and renders the files with `@markiro/domain`. One
//! read transaction gives every row one snapshot, as the cloud's export reads
//! in one repeatable-read transaction; each query searches by an index of
//! `0010` or `0012`, never through every fact of the host.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRows,
};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;
use crate::shifts;

/// The shift, its product's name now and the instant of the station's
/// close the host accepted (one at most: the first close of an active
```

заменить на

<!-- prettier-ignore -->
```rust
//! A shift's exports (plan ЧЗ): `GET /v1/office/shifts/{id}/export-source`
//! and `POST …/exports`, every office role. The host only reads and records:
//! the office ports the cloud's source rules and its completeness checks
//! over these rows, renders the files with `@markiro/domain`, saves them and
//! then records the export in the audit trail. One read transaction gives
//! every row one snapshot, as the cloud's export reads in one
//! repeatable-read transaction; each query searches by an index of `0010` or
//! `0012`, never through every fact of the host.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRecord, ShiftExportRows, ShiftStatus,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// The shift formats `@markiro/domain` advertises (`SHIFT_EXPORT_FORMATS`),
/// with their versions; `proto/fixtures/export-formats.json` holds the same
/// list, and both suites check it against the fixture.
pub const SHIFT_FORMATS: [(&str, u32); 10] = [
    ("shift_txt_flat", 1),
    ("shift_txt_boxes", 2),
    ("shift_csv_flat", 1),
    ("shift_csv_boxes", 2),
    ("shift_xml_gismt_aggregation", 1),
    ("shift_txt_pallets", 1),
    ("shift_csv_pallets", 1),
    ("shift_xml_gismt_aggregation_pallets", 1),
    ("shift_txt_pallet_boxes", 1),
    ("shift_xml_gismt_pallet_boxes", 1),
];

/// The pallet formats (`PALLET_EXPORT_FORMATS`).
pub const PALLET_FORMATS: [(&str, u32); 1] = [("pallet_xml_gismt_aggregation", 1)];

/// The bounds of `maxLines`, as the domain's `INVALID_LINE_LIMIT`.
const MIN_LINES: u32 = 2;
const MAX_LINES: u32 = 1_000_000;

/// The shift, its product's name now and the instant of the station's
/// close the host accepted (one at most: the first close of an active
```

3. В `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .collect(),
    }))
}
```

заменить на

<!-- prettier-ignore -->
```rust
            .collect(),
    }))
}

/// `POST /v1/office/shifts/{id}/exports`: one `shift.export` row with what
/// the export wrote, `204`. A shift's export needs a closed shift (`conflict`
/// on `shift_status`, as the cloud refuses one); a pallet's needs a pallet of
/// this shift, and its state is not checked again: the files are written
/// already, and the row records that they were.
pub async fn record_export(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(record): ApiJson<ShiftExportRecord>,
) -> Result<StatusCode, ApiError> {
    let format = (record.format_id.as_str(), record.format_version);
    let of_pallet = PALLET_FORMATS.contains(&format);
    if !of_pallet && !SHIFT_FORMATS.contains(&format) {
        return Err(ApiError::validation(
            "formatId",
            "not a format the office exports",
        ));
    }
    match (&record.pallet_id, of_pallet) {
        (Some(pallet), true) => validate::client_uuid("palletId", pallet)?,
        (None, false) => {}
        _ => {
            return Err(ApiError::validation(
                "palletId",
                "a pallet's export names its pallet, a shift's none",
            ))
        }
    }
    if let Some(lines) = record.max_lines {
        if of_pallet || !(MIN_LINES..=MAX_LINES).contains(&lines) {
            return Err(ApiError::validation(
                "maxLines",
                "2-1 000 000 lines a part, none for a pallet",
            ));
        }
    }
    validate::client_uuid("documentId", &record.document_id)?;
    if record.part_count == 0 || (of_pallet && record.part_count != 1) {
        return Err(ApiError::validation(
            "partCount",
            "at least one part, exactly one for a pallet",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let status: ShiftStatus = status
        .ok_or_else(|| ApiError::not_found("no such shift"))?
        .parse()
        .map_err(ApiError::internal)?;
    if !of_pallet && status != ShiftStatus::Closed {
        return Err(shifts::status_conflict(status));
    }
    if let Some(pallet) = &record.pallet_id {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM pallets WHERE id = ? AND shift_id = ?")
                .bind(pallet)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        if found.is_none() {
            return Err(ApiError::validation(
                "palletId",
                "no such pallet in the shift",
            ));
        }
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_EXPORT,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "formatId": record.format_id,
                "formatVersion": record.format_version,
                "maxLines": record.max_lines,
                "palletId": record.pallet_id,
                "documentId": record.document_id,
                "partCount": record.part_count,
                "codeCount": record.code_count,
                "boxCount": record.box_count,
                "palletCount": record.pallet_count,
                "openPalletSuppressedBoxCount": record.open_pallet_suppressed_box_count,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
```

4. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            get(crate::routes::office_exports::export_source),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
            get(crate::routes::office_exports::export_source),
        )
        .route(
            "/v1/office/shifts/{id}/exports",
            post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

/// A box of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/boxes`, plan ЧЗ for the card of plan О-Ф): the
/// device's instants as it sent them; `units` the box's live items now;
```

заменить на

<!-- prettier-ignore -->
```rust
    Taken { owner: CodeOwner },
}

/// `POST /v1/office/shifts/{id}/exports` (plan ЧЗ): the office saved the
/// files of an export and records it in the audit trail; nothing else
/// changes. `formatId` and `formatVersion` are a format `@markiro/domain`
/// advertises (`proto/fixtures/export-formats.json`); a pallet's export names
/// its pallet and has one part and no `maxLines`, a shift's names no pallet.
/// `documentId` is the base `document_id` the files carry; the counts are
/// the parts' sums, as the cloud's export totals them, and
/// `openPalletSuppressedBoxCount` the boxes written on no pallet because
/// their pallet had not closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftExportRecord {
    pub format_id: String,
    pub format_version: u32,
    pub max_lines: Option<u32>,
    pub pallet_id: Option<String>,
    pub document_id: String,
    pub part_count: u32,
    pub code_count: u64,
    pub box_count: u32,
    pub pallet_count: u32,
    pub open_pallet_suppressed_box_count: u32,
}

/// A box of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/boxes`, plan ЧЗ for the card of plan О-Ф): the
/// device's instants as it sent them; `units` the box's live items now;
```

6. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftExportRows,
  type ShiftUpdate,
  type SsccCounter,
```

заменить на

<!-- prettier-ignore -->
```ts
  type ProductUpdate,
  type ShiftClose,
  type ShiftCreate,
  type ShiftExportRecord,
  type ShiftExportRows,
  type ShiftUpdate,
  type SsccCounter,
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  listShiftBoxes: (token: string, id: string) => Promise<OfficeBox[]>;
  /** Every pallet of the shift, opened first first, with what stands on it (plan ЧЗ). */
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  listShiftBoxes: (token: string, id: string) => Promise<OfficeBox[]>;
  /** Every pallet of the shift, opened first first, with what stands on it (plan ЧЗ). */
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
  /** `204`: the export's files are saved; the host writes its `shift.export` audit row (plan ЧЗ). */
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
}

/** A 204 answer parses as `null`. */
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: z.array(officePalletSchema),
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: z.array(officePalletSchema),
      }),
    recordShiftExport: async (token, id, record) => {
      await client.request("POST", `/v1/office/shifts/${id}/exports`, {
        body: record,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
  };
}
```

9. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  .object({ reason: z.string(), expectedRev: z.number().int() })
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
  .object({ reason: z.string(), expectedRev: z.number().int() })
  .strict();
export type ShiftClose = z.infer<typeof shiftCloseSchema>;

/**
 * Mirrors `markiro_proto::ShiftExportRecord`: `POST /v1/office/shifts/{id}/exports`
 * (plan ЧЗ), the record of an export the office saved. Built only by
 * `shiftExportRecord` (`src/host/requests.ts`).
 */
export const shiftExportRecordSchema = z
  .object({
    formatId: z.string(),
    formatVersion: z.number().int(),
    maxLines: z.number().int().nullable(),
    palletId: z.string().nullable(),
    documentId: z.uuid(),
    partCount: z.number().int(),
    codeCount: z.number().int(),
    boxCount: z.number().int(),
    palletCount: z.number().int(),
    openPalletSuppressedBoxCount: z.number().int(),
  })
  .strict();
export type ShiftExportRecord = z.infer<typeof shiftExportRecordSchema>;
```

10. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ProductUpdate,
  ShiftClose,
  ShiftCreate,
  ShiftUpdate,
  TemplateCreate,
  TemplateDefaultsUpdate,
```

заменить на

<!-- prettier-ignore -->
```ts
  ProductUpdate,
  ShiftClose,
  ShiftCreate,
  ShiftExportRecord,
  ShiftUpdate,
  TemplateCreate,
  TemplateDefaultsUpdate,
```

11. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
export function shiftClose(reason: string, expectedRev: number): ShiftClose {
  return { reason, expectedRev };
}
```

заменить на

<!-- prettier-ignore -->
```ts
export function shiftClose(reason: string, expectedRev: number): ShiftClose {
  return { reason, expectedRev };
}

/**
 * What an export wrote (plan ЧЗ): its format, its line limit, its pallet
 * (`null` for a shift's export), the base `document_id` of its files, each
 * part's counts and the boxes written on no pallet because their pallet had
 * not closed.
 */
export interface ExportWritten {
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  palletId: string | null;
  documentId: string;
  parts: readonly { codeCount: number; boxCount: number; palletCount: number }[];
  openPalletSuppressedBoxCount: number;
}

/**
 * `POST /v1/office/shifts/{id}/exports` (`shift-export-record.json`): every
 * field named, the counts summed over the parts as the cloud's export
 * totals them.
 */
export function shiftExportRecord(written: ExportWritten): ShiftExportRecord {
  const total = (count: (part: ExportWritten["parts"][number]) => number) =>
    written.parts.reduce((sum, part) => sum + count(part), 0);
  return {
    formatId: written.formatId,
    formatVersion: written.formatVersion,
    maxLines: written.maxLines,
    palletId: written.palletId,
    documentId: written.documentId,
    partCount: written.parts.length,
    codeCount: total((part) => part.codeCount),
    boxCount: total((part) => part.boxCount),
    palletCount: total((part) => part.palletCount),
    openPalletSuppressedBoxCount: written.openPalletSuppressedBoxCount,
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: PASS: `test result: ok. 48 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`

Expected: PASS: `test result: ok. 8 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: PASS: `Tests  278 passed (278)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **R1** (сменная выгрузка активной смены записывается): в `apps/standalone/host/src/routes/office_exports.rs` `if !of_pallet && status != ShiftStatus::Closed {` → `if !of_pallet && status == ShiftStatus::Planned {`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R2** (паллетный формат без паллеты): в `apps/standalone/host/src/routes/office_exports.rs` `(None, false) => {}` → `(None, _) => {}`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R3** (нижняя граница `maxLines` 3): в `apps/standalone/host/src/routes/office_exports.rs` `const MIN_LINES: u32 = 2;` → `const MIN_LINES: u32 = 3;`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`, `an_export_writes_one_audit_row_with_what_it_wrote`.
- **R3b** (верхняя граница `maxLines` 999 999): в `apps/standalone/host/src/routes/office_exports.rs` `const MAX_LINES: u32 = 1_000_000;` → `const MAX_LINES: u32 = 999_999;`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R3c** (нижняя граница `maxLines` 1): в `apps/standalone/host/src/routes/office_exports.rs` `const MIN_LINES: u32 = 2;` → `const MIN_LINES: u32 = 1;`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R4** (сессия не перечитывается в транзакции): в `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
    context.require_session_in(&mut tx).await?;
    let status: Option<String>
```

заменить на

<!-- prettier-ignore -->
```rust
    let status: Option<String>
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_user_turned_off_before_the_write_records_nothing`.

- **R5** (запись теряет поле): в `apps/standalone/host/src/routes/office_exports.rs` `"openPalletSuppressedBoxCount": record.open_pallet_suppressed_box_count,` → (удалить строку)
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `an_export_writes_one_audit_row_with_what_it_wrote`.
- **R6** (паллета любой смены): в `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
SELECT 1 FROM pallets WHERE id = ? AND shift_id = ?")
                .bind(pallet)
                .bind(&id)
```

заменить на

<!-- prettier-ignore -->
```rust
SELECT 1 FROM pallets WHERE id = ? AND ? <> ''")
                .bind(pallet)
                .bind(&id)
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.

- **R7** (паллета в двух частях): в `apps/standalone/host/src/routes/office_exports.rs` `if record.part_count == 0 || (of_pallet && record.part_count != 1) {` → `if record.part_count == 0 {`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R8** (любой `documentId`): в `apps/standalone/host/src/routes/office_exports.rs` `validate::client_uuid("documentId", &record.document_id)?;` → (удалить строку)
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R9** (`maxLines` у паллеты): в `apps/standalone/host/src/routes/office_exports.rs` `if of_pallet || !(MIN_LINES..=MAX_LINES).contains(&lines) {` → `if !(MIN_LINES..=MAX_LINES).contains(&lines) {`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`.
- **R10** (устаревшая версия формата): в `apps/standalone/host/src/routes/office_exports.rs` `("shift_txt_boxes", 2),` → `("shift_txt_boxes", 1),`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_exports`. Ожидается: FAIL — `a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken`, `the_formats_the_host_takes_are_the_fixtures`.
- **R11** (одна часть всегда): в `apps/standalone/src/host/requests.ts` `partCount: written.parts.length,` → `partCount: 1,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`. Ожидается: FAIL — `the record of an export names every field and sums its parts' counts (plan ЧЗ)`.
- **R12** (коды только первой части): в `apps/standalone/src/host/requests.ts` `codeCount: total((part) => part.codeCount),` → `codeCount: written.parts[0]?.codeCount ?? 0,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`. Ожидается: FAIL — `the record of an export names every field and sums its parts' counts (plan ЧЗ)`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/office_exports.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_exports.rs apps/standalone/proto/fixtures/export-formats.json apps/standalone/proto/fixtures/shift-export-record.json apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/test/api.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): an export the office saved writes one shift.export audit row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Эталон байтов из кода облака: общие случаи и облачный тест паритета

Выгрузка — документ для государственной системы, поэтому критерий приёмки — байты облака для тех же фактов, а не «похоже». Эталон выводится из облачного кода, а не из порта: тест в `apps/api` строит из каждого случая строки, которые читает облачный `ShiftExportSourceService` (подставной `db` отдаёт строки по таблицам; фильтр и порядок коробов одной паллеты — SQL облака, `shift-export-source.service.ts:191-202`, — подставной `db` повторяет как написано), и прогоняет **настоящий** `ShiftExportRunnerService` (захват, снимок, рендер доменом, «загрузка», итоги) с подставным хранилищем. Записанные байты (текст, длина, SHA-256), имена, счётчики, `openPalletSuppressedBoxCount` из журнала облака или код отказа строки выгрузки и есть эталон. Часы облака заморожены на моменте случаев: загрузчик паллеты берёт `new Date()` (`:207`), загрузчик смены — `transaction_timestamp()`.

Случаи (`cases.json`) — факты в форме, которую читают оба продукта: смена (статус, дата, `monthKey`/`seq`/источник номера, момент закрытия и кто закрыл, товар, паллеты), организация, коды (хеш, время, канонический текст с GS и криптохвостом), короба, позиции (со снятыми и вытесненными), паллеты, наборы `maxLines` и паллеты для документа одной паллеты. Двенадцать случаев покрывают: порядок кодов по времени и хешу при одинаковом времени и обратном порядке во входе, короба по SSCC, экранирование XML (`&<"'>` в серии, `"` и `&` в названии организации) и CSV (`;` и `"`), деление на части и границы `maxLines` (2, 3, 5, 8, 16, 20, 30), паллеты с одинаковым моментом закрытия, открытую паллету (подавленный короб), расформированную паллету (Ч1), закрытую паллету без коробов (`GENERATION_FAILED`), расформированный короб, закрытый короб без живых позиций, код в двух коробах, неполное покрытие при закрытии из офиса, станционный номер `/S`, ИНН из 12 цифр, ИНН нет (и порядок проверок при отсутствии кодов), активную смену с документом закрытой паллеты (закрытой после полуночи UTC), «плохой» КМ и закрытую смену без момента закрытия.

**Files:**

- Create: `packages/domain/test/fixtures/shift-export-parity/cases.json`, `packages/domain/test/fixtures/shift-export-parity/golden.json` (пишет тест), `apps/api/test/standalone-export-parity.test.ts`

**Interfaces:**

- Consumes: облачные `ShiftExportSourceService`, `ShiftExportRunnerService`, `ObjectStorageService` (тип), `schema` из `@markiro/db`, `SHIFT_EXPORT_FORMATS`/`PALLET_EXPORT_FORMATS` домена.
- Produces: `cases.json` (схема — `caseSchema` теста: `name`, `shift {id, status, productionDate, monthKey, seq, createdFrom: office|station, closedAt, closedBy: office|station|null, productName, palletsEnabled}`, `organization {name, inn}`, `codes[] {codeHash, scannedAt, canonical}`, `boxes[] {id, sscc, openedAt, closedAt, disassembledAt, palletId}`, `items[] {boxId, codeHash, removed, displaced}`, `pallets[] {id, sscc, openedAt, closedAt, disassembledAt}`, `maxLines[]`, `palletRuns[]`; корень — `documentId`, `fileDateTime`, `cases`); `golden.json` — объект «ключ прогона → исход», ключ `<случай>/<формат>@<версия>/<maxLines или ->` и `<случай>/pallet_xml_gismt_aggregation@1/<palletId>`, исход — `{ error }` или `{ openPalletSuppressedBoxCount, parts: [{ filename, codeCount, boxCount, palletCount, physicalLineCount, bytes, sha256, text }] }` (`text` — UTF-8 с BOM, `\r\n` и `\u001d` как есть). Задача 5 читает оба файла.

- [ ] **Step 1: Случаи и облачный тест**

1. Создать `apps/api/test/standalone-export-parity.test.ts`:

<!-- prettier-ignore -->
```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { PALLET_EXPORT_FORMATS, SHIFT_EXPORT_FORMATS } from "@markiro/domain";
import { z } from "zod";
import { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import { ShiftExportSourceService } from "../src/modules/shift-exports/shift-export-source.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

/**
 * The cloud's half of the export parity between the cloud and «Markiro
 * Автоном» (plan ЧЗ of `apps/standalone`). Every case of
 * `packages/domain/test/fixtures/shift-export-parity/cases.json` is a
 * shift's facts in a shape both products read. Here they become the rows
 * the cloud's own `ShiftExportSourceService` reads, and the cloud's own
 * `ShiftExportRunnerService` renders and "uploads" every format; the bytes
 * it uploads, its file names and counts, or the error code it records, must
 * equal `golden.json`. The standalone office's port reads the same cases as
 * its host's rows and must produce the same golden
 * (`apps/standalone/test/export-parity.test.ts`). A legitimate change of
 * the cloud's export regenerates the golden from this test alone:
 * `EXPORT_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run
 * test/standalone-export-parity.test.ts`; the standalone port must then be
 * brought to the same bytes.
 */

const FIXTURES = join(__dirname, "../../../packages/domain/test/fixtures/shift-export-parity");
const TENANT = "tenant-1";
const USER = "user-1";

const instant = z.iso.datetime();
const caseSchema = z.object({
  name: z.string(),
  shift: z.object({
    id: z.string(),
    status: z.enum(["planned", "active", "closed"]),
    productionDate: z.string(),
    monthKey: z.string(),
    seq: z.number().int(),
    createdFrom: z.enum(["office", "station"]),
    closedAt: instant.nullable(),
    closedBy: z.enum(["office", "station"]).nullable(),
    productName: z.string(),
    palletsEnabled: z.boolean(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(z.object({ codeHash: z.string(), scannedAt: instant, canonical: z.string() })),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      boxId: z.string(),
      codeHash: z.string(),
      removed: z.boolean(),
      displaced: z.boolean(),
    }),
  ),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
    }),
  ),
  maxLines: z.array(z.number().int().nullable()),
  palletRuns: z.array(z.string()),
});
type ParityCase = z.infer<typeof caseSchema>;
const casesSchema = z.object({
  documentId: z.uuid(),
  fileDateTime: instant,
  cases: z.array(caseSchema),
});
const outcomeSchema = z.union([
  z.object({ error: z.string() }).strict(),
  z
    .object({
      openPalletSuppressedBoxCount: z.number().int(),
      parts: z.array(
        z
          .object({
            filename: z.string(),
            codeCount: z.number().int(),
            boxCount: z.number().int(),
            palletCount: z.number().int(),
            physicalLineCount: z.number().int(),
            bytes: z.number().int(),
            sha256: z.string(),
            text: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
type Outcome = z.infer<typeof outcomeSchema>;

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const parity = casesSchema.parse(read("cases.json"));

/** The run keys and their target: every advertised shift format at every line limit, then each pallet. */
function runsOf(parityCase: ParityCase) {
  const shiftRuns = parityCase.maxLines.flatMap((maxLines) =>
    SHIFT_EXPORT_FORMATS.map((format) => ({
      key: `${parityCase.name}/${format.id}@${format.version}/${maxLines ?? "-"}`,
      formatId: format.id as string,
      formatVersion: format.version as number,
      maxLines,
      palletId: null as string | null,
    })),
  );
  const palletRuns = parityCase.palletRuns.flatMap((palletId) =>
    PALLET_EXPORT_FORMATS.map((format) => ({
      key: `${parityCase.name}/${format.id}@${format.version}/${palletId}`,
      formatId: format.id as string,
      formatVersion: format.version as number,
      maxLines: null,
      palletId: palletId as string | null,
    })),
  );
  return [...shiftRuns, ...palletRuns];
}

const date = (value: string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The rows the cloud's source reads for `parityCase`, keyed by table: the
 * shift joined with its product, the organization, the registry joined with
 * the codes' history, the box items joined with their boxes, the pallets.
 * The per-pallet loader's own SQL filters and orders the boxes of the pallet
 * (`shift-export-source.service.ts:191-202`): the fake applies that filter
 * and that order as the SQL writes them.
 */
function sourceDb(parityCase: ParityCase, palletId: string | null): Db {
  const { shift } = parityCase;
  const boxById = new Map(parityCase.boxes.map((box) => [box.id, box]));
  const rowsFor = (table: unknown, fields: Record<string, unknown> | undefined): unknown[] => {
    if (table === schema.shifts) {
      return [
        {
          tenantId: TENANT,
          shiftId: shift.id,
          status: shift.status,
          productionDate: shift.productionDate,
          plannedDate: null,
          numberMonthKey: shift.monthKey,
          numberSeq: shift.seq,
          createdFrom: shift.createdFrom === "office" ? "admin" : "station",
          closedAt: date(shift.closedAt),
          productName: shift.productName,
        },
      ];
    }
    if (table === schema.organization) {
      return [{ name: parityCase.organization.name, inn: parityCase.organization.inn }];
    }
    if (table === schema.codeRegistry) {
      return parityCase.codes.map((code) => ({
        tenantId: TENANT,
        shiftId: shift.id,
        codeHash: code.codeHash,
        scannedAt: new Date(code.scannedAt),
        canonicalRaw: code.canonical,
      }));
    }
    if (table === schema.validationCodeReprocessings) return [];
    if (table === schema.boxItems) {
      return parityCase.items.flatMap((item) => {
        const box = boxById.get(item.boxId);
        if (box === undefined) throw new Error(`${parityCase.name}: no box ${item.boxId}`);
        return [
          {
            tenantId: TENANT,
            shiftId: shift.id,
            boxId: box.id,
            sscc: box.sscc,
            closedAt: date(box.closedAt),
            disassembledAt: date(box.disassembledAt),
            palletId: box.palletId,
            codeHash: item.codeHash,
            displacedAt: item.displaced
              ? new Date(parityCase.shift.closedAt ?? box.openedAt)
              : null,
            removedAt: item.removed ? new Date(parityCase.shift.closedAt ?? box.openedAt) : null,
          },
        ];
      });
    }
    if (table === schema.pallets && fields !== undefined && "productName" in fields) {
      const pallet = parityCase.pallets.find((each) => each.id === palletId);
      return pallet === undefined
        ? []
        : [
            {
              sscc: pallet.sscc,
              closedAt: date(pallet.closedAt),
              disassembledAt: date(pallet.disassembledAt),
              productName: shift.productName,
            },
          ];
    }
    if (table === schema.pallets) {
      return parityCase.pallets.map((pallet) => ({
        tenantId: TENANT,
        shiftId: shift.id,
        id: pallet.id,
        sscc: pallet.sscc,
        closedAt: date(pallet.closedAt),
      }));
    }
    if (table === schema.boxes) {
      return parityCase.boxes
        .filter(
          (box) =>
            box.palletId === palletId && box.closedAt !== null && box.disassembledAt === null,
        )
        .sort((left, right) =>
          left.closedAt === right.closedAt
            ? left.id < right.id
              ? -1
              : 1
            : (left.closedAt ?? "") < (right.closedAt ?? "")
              ? -1
              : 1,
        )
        .map((box) => ({ sscc: box.sscc }));
    }
    throw new Error(`${parityCase.name}: the source read an unexpected table`);
  };
  const select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const rows = Promise.resolve(rowsFor(table, fields));
      const node = {
        innerJoin: () => node,
        leftJoin: () => node,
        where: () => node,
        orderBy: () => node,
        limit: () => node,
        then: rows.then.bind(rows),
      };
      return node;
    },
  });
  const tx = {
    select,
    execute: async () => ({
      rows: [{ sourceSnapshotStartedAt: new Date(parity.fileDateTime) }],
    }),
  };
  return {
    transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as Db;
}

interface ExportRow {
  id: string;
  tenantId: string;
  shiftId: string | null;
  palletId: string | null;
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  status: string;
  errorCode: string | null;
  attemptCount: number;
  createdByUserId: string;
  updatedAt: Date;
}

/** The export's row as the runner's claim, snapshot, lease and publication change it. */
function runnerDb(row: ExportRow) {
  const artifacts: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const boundary = {
    select: () => ({
      from: () => {
        const rows = Promise.resolve([row]);
        const node = { where: () => node, limit: () => node, then: rows.then.bind(rows) };
        return node;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const apply = () => {
          const { attemptCount, ...rest } = values;
          Object.assign(row, rest);
          if (attemptCount !== undefined) row.attemptCount += 1;
          return [row];
        };
        const node = {
          where: () => node,
          returning: async () => apply(),
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(apply()).then(resolve, reject),
        };
        return node;
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === schema.shiftExportArtifacts) artifacts.push(...rows);
        else if (table === schema.tenantAuditEvents) audits.push(...rows);
      },
    }),
  };
  const db = {
    ...boundary,
    transaction: async (run: (tx: typeof boundary) => Promise<unknown>) => run(boundary),
  } as unknown as Db;
  return { db, artifacts, audits };
}

/** What the runner uploaded, by object key. */
function storage() {
  const objects = new Map<string, Buffer>();
  const store = {
    putVerified: async (key: string, body: Buffer, _mime: string, sha256: string) => {
      objects.set(key, body);
      return { byteSize: body.byteLength, sha256 };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageService;
  return { store, objects };
}

async function cloudOutcome(
  parityCase: ParityCase,
  run: ReturnType<typeof runsOf>[number],
): Promise<Outcome> {
  const row: ExportRow = {
    id: parity.documentId,
    tenantId: TENANT,
    shiftId: run.palletId === null ? parityCase.shift.id : null,
    palletId: run.palletId,
    formatId: run.formatId,
    formatVersion: run.formatVersion,
    maxLines: run.maxLines,
    status: "queued",
    errorCode: null,
    attemptCount: 0,
    createdByUserId: USER,
    updatedAt: new Date(parity.fileDateTime),
  };
  const runner = runnerDb(row);
  const uploaded = storage();
  await new ShiftExportRunnerService(
    runner.db,
    new ShiftExportSourceService(sourceDb(parityCase, run.palletId)),
    uploaded.store,
  ).run(row.id, { retryCount: 0, retryLimit: 0 });
  if (row.status !== "ready") return { error: row.errorCode ?? row.status };
  const completed = runner.audits.find((audit) =>
    String(audit.action).endsWith("export.completed"),
  );
  const metadata = z
    .object({ openPalletSuppressedBoxCount: z.number().int() })
    .parse((completed as { after?: unknown } | undefined)?.after);
  const parts = z
    .array(
      z.object({
        partNumber: z.number().int(),
        objectKey: z.string(),
        filename: z.string(),
        codeCount: z.number().int(),
        boxCount: z.number().int(),
        palletCount: z.number().int(),
        physicalLineCount: z.number().int(),
      }),
    )
    .parse(runner.artifacts)
    .sort((left, right) => left.partNumber - right.partNumber);
  return {
    openPalletSuppressedBoxCount: metadata.openPalletSuppressedBoxCount,
    parts: parts.map((part) => {
      const body = uploaded.objects.get(part.objectKey);
      if (body === undefined) throw new Error(`${part.objectKey} was not uploaded`);
      return {
        filename: part.filename,
        codeCount: part.codeCount,
        boxCount: part.boxCount,
        palletCount: part.palletCount,
        physicalLineCount: part.physicalLineCount,
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      };
    }),
  };
}

describe("the cloud's exports over the parity cases (plan ЧЗ of apps/standalone)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("render exactly the golden bytes, names, counts and refusals", async () => {
    // The pallet loader reads the clock for `file_date_time` (`new Date()`,
    // `shift-export-source.service.ts:207`), the shift loader the database's
    // `transaction_timestamp()`: both are the cases' one instant here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(parity.fileDateTime));
    const outcomes: Record<string, Outcome> = {};
    for (const parityCase of parity.cases) {
      for (const run of runsOf(parityCase)) {
        outcomes[run.key] = await cloudOutcome(parityCase, run);
      }
    }
    if (process.env.EXPORT_PARITY_WRITE === "1") {
      writeFileSync(join(FIXTURES, "golden.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
    }
    const golden = z.record(z.string(), outcomeSchema).parse(read("golden.json"));
    expect(Object.keys(outcomes)).toEqual(Object.keys(golden));
    for (const [key, outcome] of Object.entries(outcomes)) {
      expect(outcome, key).toEqual(golden[key]);
    }
  });
});
```

2. Создать `packages/domain/test/fixtures/shift-export-parity/cases.json`:

<!-- prettier-ignore -->
```json
{
  "documentId": "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
  "fileDateTime": "2026-10-08T15:30:00.123Z",
  "cases": [
    {
      "name": "boxes",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:10.500Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.500Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "scannedAt": "2026-10-08T06:00:11.000Z",
          "canonical": "010460068200001321Ab&<9\"'x>Zq1M\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0404040404040404040404040404040404040404040404040404040404040404",
          "scannedAt": "2026-10-08T06:00:30.000Z",
          "canonical": "010460068200001321Gt5kR1wQe8Uv4\u001d93Ab1Z"
        },
        {
          "codeHash": "0505050505050505050505050505050505050505050505050505050505050505",
          "scannedAt": "2026-10-08T06:00:31.000Z",
          "canonical": "010460068200001321Hs;q\"7Lp0Nm2X\u001d93Ab1Z"
        },
        {
          "codeHash": "0000000000000000000000000000000000000000000000000000000000000000",
          "scannedAt": "2026-10-08T06:00:50.000Z",
          "canonical": "010460068200001321Jr2pW5zKa6Bt6\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015024",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:20.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:30.000Z",
          "closedAt": "2026-10-08T06:00:40.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000003",
          "sscc": "046006820000015017",
          "openedAt": "2026-10-08T06:00:50.000Z",
          "closedAt": "2026-10-08T06:01:00.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000004",
          "sscc": "046006820000015031",
          "openedAt": "2026-10-08T06:01:10.000Z",
          "closedAt": "2026-10-08T06:01:20.000Z",
          "disassembledAt": "2026-10-08T06:01:30.000Z",
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000005",
          "sscc": null,
          "openedAt": "2026-10-08T06:01:40.000Z",
          "closedAt": null,
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0505050505050505050505050505050505050505050505050505050505050505",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0404040404040404040404040404040404040404040404040404040404040404",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000003",
          "codeHash": "0000000000000000000000000000000000000000000000000000000000000000",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000004",
          "codeHash": "0707070707070707070707070707070707070707070707070707070707070707",
          "removed": true,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000005",
          "codeHash": "0808080808080808080808080808080808080808080808080808080808080808",
          "removed": true,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000003",
          "codeHash": "0909090909090909090909090909090909090909090909090909090909090909",
          "removed": false,
          "displaced": true
        }
      ],
      "pallets": [],
      "maxLines": [null, 2, 5, 16, 20],
      "palletRuns": []
    },
    {
      "name": "pallets",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": true
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:11.000Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "scannedAt": "2026-10-08T06:00:20.000Z",
          "canonical": "010460068200001321Ab9xZq1MnB3c4\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0404040404040404040404040404040404040404040404040404040404040404",
          "scannedAt": "2026-10-08T06:00:30.000Z",
          "canonical": "010460068200001321Gt5kR1wQe8Uv4\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0505050505050505050505050505050505050505050505050505050505050505",
          "scannedAt": "2026-10-08T06:00:40.000Z",
          "canonical": "010460068200001321Hs7Lp0Nm2Xc5Q\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0606060606060606060606060606060606060606060606060606060606060606",
          "scannedAt": "2026-10-08T06:00:50.000Z",
          "canonical": "010460068200001321Jr2pW5zKa6Bt6\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0000000000000000000000000000000000000000000000000000000000000000",
          "scannedAt": "2026-10-08T06:00:51.000Z",
          "canonical": "010460068200001321Lm4nQ8rTy2Ux7\u001d93Ab1Z"
        },
        {
          "codeHash": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          "scannedAt": "2026-10-08T06:00:31.000Z",
          "canonical": "010460068200001321Nv6bS3dFg7Hj9\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015055",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:26.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000001"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:20.000Z",
          "closedAt": "2026-10-08T06:00:25.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000001"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000009",
          "sscc": "046006820000015086",
          "openedAt": "2026-10-08T06:00:31.000Z",
          "closedAt": "2026-10-08T06:00:35.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000002"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000003",
          "sscc": "046006820000015017",
          "openedAt": "2026-10-08T06:00:30.000Z",
          "closedAt": "2026-10-08T06:00:35.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000002"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000004",
          "sscc": "046006820000015031",
          "openedAt": "2026-10-08T06:00:40.000Z",
          "closedAt": "2026-10-08T06:00:45.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000003"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000005",
          "sscc": "046006820000015024",
          "openedAt": "2026-10-08T06:00:50.000Z",
          "closedAt": "2026-10-08T06:00:55.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000004"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000006",
          "sscc": "046006820000015048",
          "openedAt": "2026-10-08T06:00:51.000Z",
          "closedAt": "2026-10-08T06:00:56.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000007",
          "sscc": "046006820000015062",
          "openedAt": "2026-10-08T06:01:00.000Z",
          "closedAt": "2026-10-08T06:01:05.000Z",
          "disassembledAt": "2026-10-08T06:01:06.000Z",
          "palletId": "a0000000-0000-4000-8000-000000000001"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000008",
          "sscc": "046006820000015079",
          "openedAt": "2026-10-08T06:01:10.000Z",
          "closedAt": "2026-10-08T06:01:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000003",
          "codeHash": "0404040404040404040404040404040404040404040404040404040404040404",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000004",
          "codeHash": "0505050505050505050505050505050505050505050505050505050505050505",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000005",
          "codeHash": "0606060606060606060606060606060606060606060606060606060606060606",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000006",
          "codeHash": "0000000000000000000000000000000000000000000000000000000000000000",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000007",
          "codeHash": "0808080808080808080808080808080808080808080808080808080808080808",
          "removed": true,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000009",
          "codeHash": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [
        {
          "id": "a0000000-0000-4000-8000-000000000001",
          "sscc": "146006820000000416",
          "openedAt": "2026-10-08T06:00:15.000Z",
          "closedAt": "2026-10-08T06:00:57.250Z",
          "disassembledAt": null
        },
        {
          "id": "a0000000-0000-4000-8000-000000000002",
          "sscc": "146006820000000409",
          "openedAt": "2026-10-08T06:00:35.000Z",
          "closedAt": "2026-10-08T06:00:57.250Z",
          "disassembledAt": null
        },
        {
          "id": "a0000000-0000-4000-8000-000000000003",
          "sscc": null,
          "openedAt": "2026-10-08T06:00:45.000Z",
          "closedAt": null,
          "disassembledAt": null
        },
        {
          "id": "a0000000-0000-4000-8000-000000000004",
          "sscc": "146006820000000423",
          "openedAt": "2026-10-08T06:00:55.000Z",
          "closedAt": "2026-10-08T06:00:58.000Z",
          "disassembledAt": "2026-10-08T06:00:59.000Z"
        },
        {
          "id": "a0000000-0000-4000-8000-000000000005",
          "sscc": "146006820000000430",
          "openedAt": "2026-10-08T06:01:10.000Z",
          "closedAt": "2026-10-08T06:01:20.000Z",
          "disassembledAt": null
        }
      ],
      "maxLines": [null, 3, 8, 30],
      "palletRuns": [
        "a0000000-0000-4000-8000-000000000001",
        "a0000000-0000-4000-8000-000000000002",
        "a0000000-0000-4000-8000-000000000003",
        "a0000000-0000-4000-8000-000000000004",
        "a0000000-0000-4000-8000-000000000005",
        "a0000000-0000-4000-8000-000000000009"
      ]
    },
    {
      "name": "coverage",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:07.000Z",
        "closedBy": "office",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:11.000Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "scannedAt": "2026-10-08T06:00:20.000Z",
          "canonical": "010460068200001321Ab9xZq1MnB3c4\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": null,
          "openedAt": "2026-10-08T06:00:20.000Z",
          "closedAt": null,
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0303030303030303030303030303030303030303030303030303030303030303",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "station-number",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 5,
        "createdFrom": "station",
        "closedAt": "2026-10-08T16:00:07.000Z",
        "closedBy": "office",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО \"Атолл\" & Ко",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "inn-12",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ИП Кузнецова А. В.",
        "inn": "770123456789"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "no-inn",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": null
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "not-closed",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "active",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": null,
        "closedBy": null,
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": true
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:20.000Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": "a0000000-0000-4000-8000-000000000001"
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": null,
          "openedAt": "2026-10-08T06:00:20.000Z",
          "closedAt": null,
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [
        {
          "id": "a0000000-0000-4000-8000-000000000001",
          "sscc": "146006820000000409",
          "openedAt": "2026-10-08T06:00:15.000Z",
          "closedAt": "2026-10-09T00:30:00.000Z",
          "disassembledAt": null
        }
      ],
      "maxLines": [null],
      "palletRuns": ["a0000000-0000-4000-8000-000000000001"]
    },
    {
      "name": "no-codes",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": null
      },
      "codes": [],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": null,
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": null,
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "bad-cis",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Вода «Родник» / 0,5 л, ПЭТ",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:11.000Z",
          "canonical": "0104600682000013"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "double-membership",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:11.000Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": "046006820000015017",
          "openedAt": "2026-10-08T06:00:16.000Z",
          "closedAt": "2026-10-08T06:00:20.000Z",
          "disassembledAt": null,
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000003",
          "sscc": null,
          "openedAt": "2026-10-08T06:00:21.000Z",
          "closedAt": null,
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000003",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "disassembled-live",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": "2026-10-08T16:00:00.412Z",
        "closedBy": "station",
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        },
        {
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "scannedAt": "2026-10-08T06:00:20.000Z",
          "canonical": "010460068200001321Pw3nY7hLd9Fs2\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": "2026-10-08T06:00:16.000Z",
          "palletId": null
        },
        {
          "id": "b0000000-0000-4000-8000-000000000002",
          "sscc": "046006820000015017",
          "openedAt": "2026-10-08T06:00:20.000Z",
          "closedAt": "2026-10-08T06:00:25.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        },
        {
          "boxId": "b0000000-0000-4000-8000-000000000002",
          "codeHash": "0202020202020202020202020202020202020202020202020202020202020202",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    },
    {
      "name": "no-close-instant",
      "shift": {
        "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "status": "closed",
        "productionDate": "2026-10-08",
        "monthKey": "OCT26",
        "seq": 4,
        "createdFrom": "office",
        "closedAt": null,
        "closedBy": null,
        "productName": "Молоко 3,2% 0,9 л",
        "palletsEnabled": false
      },
      "organization": {
        "name": "ООО «Атолл»",
        "inn": "7701234567"
      },
      "codes": [
        {
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "scannedAt": "2026-10-08T06:00:10.000Z",
          "canonical": "010460068200001321Kq8vT2mXc5Rz1\u001d91EE10\u001d92ZkF5dGhpcyBpcyBhIGNyeXB0byB0YWlsIDQ0IGNoYXJz"
        }
      ],
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:00:10.000Z",
          "closedAt": "2026-10-08T06:00:15.000Z",
          "disassembledAt": null,
          "palletId": null
        }
      ],
      "items": [
        {
          "boxId": "b0000000-0000-4000-8000-000000000001",
          "codeHash": "0101010101010101010101010101010101010101010101010101010101010101",
          "removed": false,
          "displaced": false
        }
      ],
      "pallets": [],
      "maxLines": [null],
      "palletRuns": []
    }
  ]
}
```

- [ ] **Step 2: Тест падает — эталона ещё нет**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`

Expected: FAIL: `Error: ENOENT: no such file or directory, open '…/shift-export-parity/golden.json'`, `Tests  1 failed (1)` (эталона ещё нет).

- [ ] **Step 3: Записать эталон кодом облака**

Run: `EXPORT_PARITY_WRITE=1 pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`

Expected: PASS: `Tests  1 passed (1)`; появился `packages/domain/test/fixtures/shift-export-parity/golden.json` (197 прогонов).

Run: `shasum -a 256 packages/domain/test/fixtures/shift-export-parity/golden.json`

Expected: `95bede8a0af46ff7d026693ee13c0cb9e120e156b0d3843f2654a078d3a87220  packages/domain/test/fixtures/shift-export-parity/golden.json`. Другой хеш значит, что облачный код, домен или случаи разошлись с копией: остановиться и записать в «Отклонения».

Run: `node_modules/.bin/prettier --check packages/domain/test/fixtures/shift-export-parity/golden.json` — чисто (тест пишет JSON с отступом 2 и переводом строки в конце).

Сводка эталона (для ревью; байты — в файле):

| Прогон                                                                           | Исход                                                                                                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `boxes/shift_txt_flat@1/-`                                                       | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.txt`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_txt_boxes@2/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.txt`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_csv_flat@1/-`                                                       | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.csv`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_csv_boxes@2/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.csv`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_xml_gismt_aggregation@1/-`                                          | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.xml`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_txt_pallets@1/-`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_csv_pallets@1/-`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_aggregation_pallets@1/-`                                  | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_pallet_boxes@1/-`                                               | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_pallet_boxes@1/-`                                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_flat@1/2`                                                       | 3 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08_часть_1.txt` …; кодов 6, коробов 0, паллет 0                           |
| `boxes/shift_txt_boxes@2/2`                                                      | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `boxes/shift_csv_flat@1/2`                                                       | 6 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08_часть_1.csv` …; кодов 6, коробов 0, паллет 0                           |
| `boxes/shift_csv_boxes@2/2`                                                      | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `boxes/shift_xml_gismt_aggregation@1/2`                                          | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `boxes/shift_txt_pallets@1/2`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_csv_pallets@1/2`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_aggregation_pallets@1/2`                                  | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_pallet_boxes@1/2`                                               | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_pallet_boxes@1/2`                                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_flat@1/5`                                                       | 2 ч.; `Молоко_3_2_0_9_л_5pcs_2026-10-08_часть_1.txt` …; кодов 6, коробов 0, паллет 0                           |
| `boxes/shift_txt_boxes@2/5`                                                      | 3 ч.; `Молоко_3_2_0_9_л_2pcs_1box_2026-10-08_часть_1.txt` …; кодов 6, коробов 3, паллет 0                      |
| `boxes/shift_csv_flat@1/5`                                                       | 2 ч.; `Молоко_3_2_0_9_л_4pcs_2026-10-08_часть_1.csv` …; кодов 6, коробов 0, паллет 0                           |
| `boxes/shift_csv_boxes@2/5`                                                      | 2 ч.; `Молоко_3_2_0_9_л_3pcs_2box_2026-10-08_часть_1.csv` …; кодов 6, коробов 3, паллет 0                      |
| `boxes/shift_xml_gismt_aggregation@1/5`                                          | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `boxes/shift_txt_pallets@1/5`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_csv_pallets@1/5`                                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_aggregation_pallets@1/5`                                  | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_pallet_boxes@1/5`                                               | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_pallet_boxes@1/5`                                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_flat@1/16`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.txt`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_txt_boxes@2/16`                                                     | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.txt`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_csv_flat@1/16`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.csv`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_csv_boxes@2/16`                                                     | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.csv`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_xml_gismt_aggregation@1/16`                                         | 3 ч.; `Молоко_3_2_0_9_л_2pcs_1box_2026-10-08_часть_1.xml` …; кодов 6, коробов 3, паллет 0                      |
| `boxes/shift_txt_pallets@1/16`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_csv_pallets@1/16`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_aggregation_pallets@1/16`                                 | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_pallet_boxes@1/16`                                              | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_pallet_boxes@1/16`                                        | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_flat@1/20`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.txt`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_txt_boxes@2/20`                                                     | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.txt`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_csv_flat@1/20`                                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_2026-10-08.csv`; кодов 6, коробов 0, паллет 0                                     |
| `boxes/shift_csv_boxes@2/20`                                                     | 1 ч.; `Молоко_3_2_0_9_л_6pcs_3box_2026-10-08.csv`; кодов 6, коробов 3, паллет 0                                |
| `boxes/shift_xml_gismt_aggregation@1/20`                                         | 2 ч.; `Молоко_3_2_0_9_л_3pcs_2box_2026-10-08_часть_1.xml` …; кодов 6, коробов 3, паллет 0                      |
| `boxes/shift_txt_pallets@1/20`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_csv_pallets@1/20`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_aggregation_pallets@1/20`                                 | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_txt_pallet_boxes@1/20`                                              | SHIFT_HAS_NO_PALLETS                                                                                           |
| `boxes/shift_xml_gismt_pallet_boxes@1/20`                                        | SHIFT_HAS_NO_PALLETS                                                                                           |
| `pallets/shift_txt_flat@1/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_8pcs_2026-10-08.txt`; кодов 8, коробов 0, паллет 0                                     |
| `pallets/shift_txt_boxes@2/-`                                                    | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_2026-10-08.txt`; кодов 8, коробов 7, паллет 0                                |
| `pallets/shift_csv_flat@1/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_8pcs_2026-10-08.csv`; кодов 8, коробов 0, паллет 0                                     |
| `pallets/shift_csv_boxes@2/-`                                                    | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_2026-10-08.csv`; кодов 8, коробов 7, паллет 0                                |
| `pallets/shift_xml_gismt_aggregation@1/-`                                        | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_2026-10-08.xml`; кодов 8, коробов 7, паллет 0                                |
| `pallets/shift_txt_pallets@1/-`                                                  | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.txt`; кодов 8, коробов 7, паллет 3; подавлено 1           |
| `pallets/shift_csv_pallets@1/-`                                                  | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.csv`; кодов 8, коробов 7, паллет 3; подавлено 1           |
| `pallets/shift_xml_gismt_aggregation_pallets@1/-`                                | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.xml`; кодов 8, коробов 7, паллет 3; подавлено 1           |
| `pallets/shift_txt_pallet_boxes@1/-`                                             | 1 ч.; `Молоко_3_2_0_9_л_6pcs_5box_3pallet_2026-10-08.txt`; кодов 6, коробов 5, паллет 3; подавлено 1           |
| `pallets/shift_xml_gismt_pallet_boxes@1/-`                                       | 1 ч.; `Молоко_3_2_0_9_л_6pcs_5box_3pallet_2026-10-08.xml`; кодов 6, коробов 5, паллет 3; подавлено 1           |
| `pallets/shift_txt_flat@1/3`                                                     | 3 ч.; `Молоко_3_2_0_9_л_3pcs_2026-10-08_часть_1.txt` …; кодов 8, коробов 0, паллет 0                           |
| `pallets/shift_txt_boxes@2/3`                                                    | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `pallets/shift_csv_flat@1/3`                                                     | 4 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08_часть_1.csv` …; кодов 8, коробов 0, паллет 0                           |
| `pallets/shift_csv_boxes@2/3`                                                    | 5 ч.; `Молоко_3_2_0_9_л_2pcs_2box_2026-10-08_часть_1.csv` …; кодов 8, коробов 7, паллет 0                      |
| `pallets/shift_xml_gismt_aggregation@1/3`                                        | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `pallets/shift_txt_pallets@1/3`                                                  | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_csv_pallets@1/3`                                                  | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_xml_gismt_aggregation_pallets@1/3`                                | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_txt_pallet_boxes@1/3`                                             | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_xml_gismt_pallet_boxes@1/3`                                       | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_txt_flat@1/8`                                                     | 1 ч.; `Молоко_3_2_0_9_л_8pcs_2026-10-08.txt`; кодов 8, коробов 0, паллет 0                                     |
| `pallets/shift_txt_boxes@2/8`                                                    | 4 ч.; `Молоко_3_2_0_9_л_2pcs_2box_2026-10-08_часть_1.txt` …; кодов 8, коробов 7, паллет 0                      |
| `pallets/shift_csv_flat@1/8`                                                     | 2 ч.; `Молоко_3_2_0_9_л_7pcs_2026-10-08_часть_1.csv` …; кодов 8, коробов 0, паллет 0                           |
| `pallets/shift_csv_boxes@2/8`                                                    | 2 ч.; `Молоко_3_2_0_9_л_7pcs_6box_2026-10-08_часть_1.csv` …; кодов 8, коробов 7, паллет 0                      |
| `pallets/shift_xml_gismt_aggregation@1/8`                                        | BOX_EXCEEDS_LINE_LIMIT                                                                                         |
| `pallets/shift_txt_pallets@1/8`                                                  | 4 ч.; `Молоко_3_2_0_9_л_2pcs_2box_1pallet_2026-10-08_часть_1.txt` …; кодов 8, коробов 7, паллет 3; подавлено 1 |
| `pallets/shift_csv_pallets@1/8`                                                  | 2 ч.; `Молоко_3_2_0_9_л_7pcs_6box_3pallet_2026-10-08_часть_1.csv` …; кодов 8, коробов 7, паллет 3; подавлено 1 |
| `pallets/shift_xml_gismt_aggregation_pallets@1/8`                                | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_txt_pallet_boxes@1/8`                                             | 2 ч.; `Молоко_3_2_0_9_л_5pcs_4box_2pallet_2026-10-08_часть_1.txt` …; кодов 6, коробов 5, паллет 3; подавлено 1 |
| `pallets/shift_xml_gismt_pallet_boxes@1/8`                                       | PALLET_EXCEEDS_LINE_LIMIT                                                                                      |
| `pallets/shift_txt_flat@1/30`                                                    | 1 ч.; `Молоко_3_2_0_9_л_8pcs_2026-10-08.txt`; кодов 8, коробов 0, паллет 0                                     |
| `pallets/shift_txt_boxes@2/30`                                                   | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_2026-10-08.txt`; кодов 8, коробов 7, паллет 0                                |
| `pallets/shift_csv_flat@1/30`                                                    | 1 ч.; `Молоко_3_2_0_9_л_8pcs_2026-10-08.csv`; кодов 8, коробов 0, паллет 0                                     |
| `pallets/shift_csv_boxes@2/30`                                                   | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_2026-10-08.csv`; кодов 8, коробов 7, паллет 0                                |
| `pallets/shift_xml_gismt_aggregation@1/30`                                       | 2 ч.; `Молоко_3_2_0_9_л_5pcs_5box_2026-10-08_часть_1.xml` …; кодов 8, коробов 7, паллет 0                      |
| `pallets/shift_txt_pallets@1/30`                                                 | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.txt`; кодов 8, коробов 7, паллет 3; подавлено 1           |
| `pallets/shift_csv_pallets@1/30`                                                 | 1 ч.; `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.csv`; кодов 8, коробов 7, паллет 3; подавлено 1           |
| `pallets/shift_xml_gismt_aggregation_pallets@1/30`                               | 3 ч.; `Молоко_3_2_0_9_л_2pcs_2box_1pallet_2026-10-08_часть_1.xml` …; кодов 8, коробов 7, паллет 3; подавлено 1 |
| `pallets/shift_txt_pallet_boxes@1/30`                                            | 1 ч.; `Молоко_3_2_0_9_л_6pcs_5box_3pallet_2026-10-08.txt`; кодов 6, коробов 5, паллет 3; подавлено 1           |
| `pallets/shift_xml_gismt_pallet_boxes@1/30`                                      | 1 ч.; `Молоко_3_2_0_9_л_6pcs_5box_3pallet_2026-10-08.xml`; кодов 6, коробов 5, паллет 3; подавлено 1           |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000001`    | 1 ч.; `Молоко_3_2_0_9_л_2026-10-08_паллета_00146006820000000416_2_коробов.xml`; кодов 0, коробов 2, паллет 1   |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000002`    | 1 ч.; `Молоко_3_2_0_9_л_2026-10-08_паллета_00146006820000000409_2_коробов.xml`; кодов 0, коробов 2, паллет 1   |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000003`    | PALLET_NOT_CLOSED                                                                                              |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000004`    | PALLET_DISASSEMBLED                                                                                            |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000005`    | GENERATION_FAILED                                                                                              |
| `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000009`    | PALLET_NOT_CLOSED                                                                                              |
| `coverage/shift_txt_flat@1/-`                                                    | 1 ч.; `Молоко_3_2_0_9_л_3pcs_2026-10-08.txt`; кодов 3, коробов 0, паллет 0                                     |
| `coverage/shift_txt_boxes@2/-`                                                   | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_csv_flat@1/-`                                                    | 1 ч.; `Молоко_3_2_0_9_л_3pcs_2026-10-08.csv`; кодов 3, коробов 0, паллет 0                                     |
| `coverage/shift_csv_boxes@2/-`                                                   | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_xml_gismt_aggregation@1/-`                                       | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_txt_pallets@1/-`                                                 | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_csv_pallets@1/-`                                                 | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_xml_gismt_aggregation_pallets@1/-`                               | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_txt_pallet_boxes@1/-`                                            | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `coverage/shift_xml_gismt_pallet_boxes@1/-`                                      | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `station-number/shift_txt_flat@1/-`                                              | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.txt`; кодов 1, коробов 0, паллет 0                                     |
| `station-number/shift_txt_boxes@2/-`                                             | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.txt`; кодов 1, коробов 1, паллет 0                                |
| `station-number/shift_csv_flat@1/-`                                              | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.csv`; кодов 1, коробов 0, паллет 0                                     |
| `station-number/shift_csv_boxes@2/-`                                             | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.csv`; кодов 1, коробов 1, паллет 0                                |
| `station-number/shift_xml_gismt_aggregation@1/-`                                 | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.xml`; кодов 1, коробов 1, паллет 0                                |
| `station-number/shift_txt_pallets@1/-`                                           | SHIFT_HAS_NO_PALLETS                                                                                           |
| `station-number/shift_csv_pallets@1/-`                                           | SHIFT_HAS_NO_PALLETS                                                                                           |
| `station-number/shift_xml_gismt_aggregation_pallets@1/-`                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `station-number/shift_txt_pallet_boxes@1/-`                                      | SHIFT_HAS_NO_PALLETS                                                                                           |
| `station-number/shift_xml_gismt_pallet_boxes@1/-`                                | SHIFT_HAS_NO_PALLETS                                                                                           |
| `inn-12/shift_txt_flat@1/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.txt`; кодов 1, коробов 0, паллет 0                                     |
| `inn-12/shift_txt_boxes@2/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.txt`; кодов 1, коробов 1, паллет 0                                |
| `inn-12/shift_csv_flat@1/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.csv`; кодов 1, коробов 0, паллет 0                                     |
| `inn-12/shift_csv_boxes@2/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.csv`; кодов 1, коробов 1, паллет 0                                |
| `inn-12/shift_xml_gismt_aggregation@1/-`                                         | INVALID_ORG_INN                                                                                                |
| `inn-12/shift_txt_pallets@1/-`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `inn-12/shift_csv_pallets@1/-`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `inn-12/shift_xml_gismt_aggregation_pallets@1/-`                                 | SHIFT_HAS_NO_PALLETS                                                                                           |
| `inn-12/shift_txt_pallet_boxes@1/-`                                              | SHIFT_HAS_NO_PALLETS                                                                                           |
| `inn-12/shift_xml_gismt_pallet_boxes@1/-`                                        | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-inn/shift_txt_flat@1/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.txt`; кодов 1, коробов 0, паллет 0                                     |
| `no-inn/shift_txt_boxes@2/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.txt`; кодов 1, коробов 1, паллет 0                                |
| `no-inn/shift_csv_flat@1/-`                                                      | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.csv`; кодов 1, коробов 0, паллет 0                                     |
| `no-inn/shift_csv_boxes@2/-`                                                     | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.csv`; кодов 1, коробов 1, паллет 0                                |
| `no-inn/shift_xml_gismt_aggregation@1/-`                                         | ORG_INN_MISSING                                                                                                |
| `no-inn/shift_txt_pallets@1/-`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-inn/shift_csv_pallets@1/-`                                                   | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-inn/shift_xml_gismt_aggregation_pallets@1/-`                                 | ORG_INN_MISSING                                                                                                |
| `no-inn/shift_txt_pallet_boxes@1/-`                                              | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-inn/shift_xml_gismt_pallet_boxes@1/-`                                        | ORG_INN_MISSING                                                                                                |
| `not-closed/shift_txt_flat@1/-`                                                  | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_txt_boxes@2/-`                                                 | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_csv_flat@1/-`                                                  | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_csv_boxes@2/-`                                                 | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_xml_gismt_aggregation@1/-`                                     | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_txt_pallets@1/-`                                               | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_csv_pallets@1/-`                                               | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_xml_gismt_aggregation_pallets@1/-`                             | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_txt_pallet_boxes@1/-`                                          | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/shift_xml_gismt_pallet_boxes@1/-`                                    | SHIFT_NOT_CLOSED                                                                                               |
| `not-closed/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000001` | 1 ч.; `Молоко_3_2_0_9_л_2026-10-09_паллета_00146006820000000409_1_коробов.xml`; кодов 0, коробов 1, паллет 1   |
| `no-codes/shift_txt_flat@1/-`                                                    | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_txt_boxes@2/-`                                                   | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_csv_flat@1/-`                                                    | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_csv_boxes@2/-`                                                   | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_xml_gismt_aggregation@1/-`                                       | ORG_INN_MISSING                                                                                                |
| `no-codes/shift_txt_pallets@1/-`                                                 | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_csv_pallets@1/-`                                                 | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_xml_gismt_aggregation_pallets@1/-`                               | ORG_INN_MISSING                                                                                                |
| `no-codes/shift_txt_pallet_boxes@1/-`                                            | SHIFT_HAS_NO_CODES                                                                                             |
| `no-codes/shift_xml_gismt_pallet_boxes@1/-`                                      | ORG_INN_MISSING                                                                                                |
| `bad-cis/shift_txt_flat@1/-`                                                     | 1 ч.; `Вода_Родник_0_5_л_ПЭТ_2pcs_2026-10-08.txt`; кодов 2, коробов 0, паллет 0                                |
| `bad-cis/shift_txt_boxes@2/-`                                                    | 1 ч.; `Вода_Родник_0_5_л_ПЭТ_2pcs_1box_2026-10-08.txt`; кодов 2, коробов 1, паллет 0                           |
| `bad-cis/shift_csv_flat@1/-`                                                     | 1 ч.; `Вода_Родник_0_5_л_ПЭТ_2pcs_2026-10-08.csv`; кодов 2, коробов 0, паллет 0                                |
| `bad-cis/shift_csv_boxes@2/-`                                                    | 1 ч.; `Вода_Родник_0_5_л_ПЭТ_2pcs_1box_2026-10-08.csv`; кодов 2, коробов 1, паллет 0                           |
| `bad-cis/shift_xml_gismt_aggregation@1/-`                                        | INVALID_CIS                                                                                                    |
| `bad-cis/shift_txt_pallets@1/-`                                                  | SHIFT_HAS_NO_PALLETS                                                                                           |
| `bad-cis/shift_csv_pallets@1/-`                                                  | SHIFT_HAS_NO_PALLETS                                                                                           |
| `bad-cis/shift_xml_gismt_aggregation_pallets@1/-`                                | SHIFT_HAS_NO_PALLETS                                                                                           |
| `bad-cis/shift_txt_pallet_boxes@1/-`                                             | SHIFT_HAS_NO_PALLETS                                                                                           |
| `bad-cis/shift_xml_gismt_pallet_boxes@1/-`                                       | SHIFT_HAS_NO_PALLETS                                                                                           |
| `double-membership/shift_txt_flat@1/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08.txt`; кодов 2, коробов 0, паллет 0                                     |
| `double-membership/shift_txt_boxes@2/-`                                          | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_csv_flat@1/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08.csv`; кодов 2, коробов 0, паллет 0                                     |
| `double-membership/shift_csv_boxes@2/-`                                          | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_xml_gismt_aggregation@1/-`                              | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_txt_pallets@1/-`                                        | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_csv_pallets@1/-`                                        | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_xml_gismt_aggregation_pallets@1/-`                      | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_txt_pallet_boxes@1/-`                                   | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `double-membership/shift_xml_gismt_pallet_boxes@1/-`                             | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_txt_flat@1/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08.txt`; кодов 2, коробов 0, паллет 0                                     |
| `disassembled-live/shift_txt_boxes@2/-`                                          | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_csv_flat@1/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_2pcs_2026-10-08.csv`; кодов 2, коробов 0, паллет 0                                     |
| `disassembled-live/shift_csv_boxes@2/-`                                          | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_xml_gismt_aggregation@1/-`                              | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_txt_pallets@1/-`                                        | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_csv_pallets@1/-`                                        | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_xml_gismt_aggregation_pallets@1/-`                      | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_txt_pallet_boxes@1/-`                                   | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `disassembled-live/shift_xml_gismt_pallet_boxes@1/-`                             | BOX_COVERAGE_INCOMPLETE                                                                                        |
| `no-close-instant/shift_txt_flat@1/-`                                            | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.txt`; кодов 1, коробов 0, паллет 0                                     |
| `no-close-instant/shift_txt_boxes@2/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.txt`; кодов 1, коробов 1, паллет 0                                |
| `no-close-instant/shift_csv_flat@1/-`                                            | 1 ч.; `Молоко_3_2_0_9_л_1pcs_2026-10-08.csv`; кодов 1, коробов 0, паллет 0                                     |
| `no-close-instant/shift_csv_boxes@2/-`                                           | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.csv`; кодов 1, коробов 1, паллет 0                                |
| `no-close-instant/shift_xml_gismt_aggregation@1/-`                               | 1 ч.; `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.xml`; кодов 1, коробов 1, паллет 0                                |
| `no-close-instant/shift_txt_pallets@1/-`                                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-close-instant/shift_csv_pallets@1/-`                                         | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-close-instant/shift_xml_gismt_aggregation_pallets@1/-`                       | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-close-instant/shift_txt_pallet_boxes@1/-`                                    | SHIFT_HAS_NO_PALLETS                                                                                           |
| `no-close-instant/shift_xml_gismt_pallet_boxes@1/-`                              | SHIFT_HAS_NO_PALLETS                                                                                           |

Три документа эталона целиком (текст из `golden.json`; станционный номер `/S` и экранирование названия организации, паллетная агрегация с расформированной паллетой `…0423` и подавленным коробом `…5031` без паллеты, документ одной паллеты):

`station-number/shift_xml_gismt_aggregation@1/-` — `Молоко_3_2_0_9_л_1pcs_1box_2026-10-08.xml`, 657 байт:

<!-- prettier-ignore -->
```xml
<?xml version="1.0" encoding="UTF-8"?>
<unit_pack document_id="5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f" VerForm="1.03" file_date_time="2026-10-08T15:30:00.123Z" action_id="30" version="1">
    <Document operation_date_time="2026-10-08T16:00:07.000Z" document_number="OCT26-005/S">
        <organisation>
            <id_info>
                <LP_info org_name="ООО &quot;Атолл&quot; &amp; Ко" LP_TIN="7701234567" />
            </id_info>
        </organisation>
        <pack_content>
            <pack_code>00046006820000015000</pack_code>
            <cis>010460068200001321Kq8vT2mXc5Rz1</cis>
        </pack_content>
    </Document>
</unit_pack>
```

`pallets/shift_xml_gismt_aggregation_pallets@1/-` — `Молоко_3_2_0_9_л_8pcs_7box_3pallet_2026-10-08.xml`, 2168 байт:

<!-- prettier-ignore -->
```xml
<?xml version="1.0" encoding="UTF-8"?>
<unit_pack document_id="5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f" VerForm="1.03" file_date_time="2026-10-08T15:30:00.123Z" action_id="30" version="1">
    <Document operation_date_time="2026-10-08T16:00:00.412Z" document_number="OCT26-004">
        <organisation>
            <id_info>
                <LP_info org_name="ООО «Атолл»" LP_TIN="7701234567" />
            </id_info>
        </organisation>
        <pack_content>
            <pack_code>00046006820000015017</pack_code>
            <cis>010460068200001321Gt5kR1wQe8Uv4</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015086</pack_code>
            <cis>010460068200001321Nv6bS3dFg7Hj9</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015000</pack_code>
            <cis>010460068200001321Ab9xZq1MnB3c4</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015055</pack_code>
            <cis>010460068200001321Kq8vT2mXc5Rz1</cis>
            <cis>010460068200001321Pw3nY7hLd9Fs2</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015024</pack_code>
            <cis>010460068200001321Jr2pW5zKa6Bt6</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015031</pack_code>
            <cis>010460068200001321Hs7Lp0Nm2Xc5Q</cis>
        </pack_content>
        <pack_content>
            <pack_code>00046006820000015048</pack_code>
            <cis>010460068200001321Lm4nQ8rTy2Ux7</cis>
        </pack_content>
        <pack_content>
            <pack_code>00146006820000000409</pack_code>
            <cis>00046006820000015017</cis>
            <cis>00046006820000015086</cis>
        </pack_content>
        <pack_content>
            <pack_code>00146006820000000416</pack_code>
            <cis>00046006820000015000</cis>
            <cis>00046006820000015055</cis>
        </pack_content>
        <pack_content>
            <pack_code>00146006820000000423</pack_code>
            <cis>00046006820000015024</cis>
        </pack_content>
    </Document>
</unit_pack>
```

`pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000001` — `Молоко_3_2_0_9_л_2026-10-08_паллета_00146006820000000416_2_коробов.xml`, 680 байт:

<!-- prettier-ignore -->
```xml
<?xml version="1.0" encoding="UTF-8"?>
<unit_pack document_id="5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f" VerForm="1.03" file_date_time="2026-10-08T15:30:00.123Z" action_id="30" version="1">
    <Document operation_date_time="2026-10-08T06:00:57.250Z" document_number="00146006820000000416">
        <organisation>
            <id_info>
                <LP_info org_name="ООО «Атолл»" LP_TIN="7701234567" />
            </id_info>
        </organisation>
        <pack_content>
            <pack_code>00146006820000000416</pack_code>
            <cis>00046006820000015000</cis>
            <cis>00046006820000015055</cis>
        </pack_content>
    </Document>
</unit_pack>
```

- [ ] **Step 4: Тест проходит без записи**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`

Expected: PASS: `Tests  1 passed (1)`.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **C1** (облако: паллеты с одним моментом без порядка по SSCC): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` фрагмент

<!-- prettier-ignore -->
```ts
          compareNullableDates(left.closedAt, right.closedAt) ||
          compareCodeUnits(left.sscc, right.sscc),
```

заменить на

<!-- prettier-ignore -->
```ts
          compareNullableDates(left.closedAt, right.closedAt),
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.

- **C2** (облако: коды только по хешу): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` фрагмент

<!-- prettier-ignore -->
```ts
    left.scannedAt.getTime() - right.scannedAt.getTime() ||
    compareCodeUnits(left.codeHash, right.codeHash)
```

заменить на

<!-- prettier-ignore -->
```ts
    compareCodeUnits(left.codeHash, right.codeHash)
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.

- **C3** (облако: подавленные короба не считаются): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` `openPalletSuppressedBoxCount += 1;` → `openPalletSuppressedBoxCount += 0;`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.
- **C4** (облако: короба без порядка по SSCC): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` фрагмент

<!-- prettier-ignore -->
```ts
    const boxes = [...eligibleBoxes]
      .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
```

заменить на

<!-- prettier-ignore -->
```ts
    const boxes = [...eligibleBoxes]
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.

- **C5** (облако: коды только по времени): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` фрагмент

<!-- prettier-ignore -->
```ts
    left.scannedAt.getTime() - right.scannedAt.getTime() ||
    compareCodeUnits(left.codeHash, right.codeHash)
```

заменить на

<!-- prettier-ignore -->
```ts
    left.scannedAt.getTime() - right.scannedAt.getTime()
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.

- **C6** (облако: расформированная паллета выпадает из групп (контракт ПЛ-Х)): в `apps/api/src/modules/shift-exports/shift-export-source.service.ts` `.filter((row): row is PalletRow & { sscc: string } => row.sscc !== null)` → `.filter((row): row is PalletRow & { sscc: string } => row.sscc !== null && row.id !== "a0000000-0000-4000-8000-000000000004")`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`. Ожидается: FAIL — `render exactly the golden bytes, names, counts and refusals`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/api/test/standalone-export-parity.test.ts packages/domain/test/fixtures/shift-export-parity/cases.json packages/domain/test/fixtures/shift-export-parity/golden.json
git commit -m "test(api): the cloud's own export renders the parity cases of the standalone office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Порт источника облака и рендер доменом в офисе, сверенные с эталоном

Порт — построчный перенос облачных `loadFromTransaction`, `loadEligibleBoxes`, `toBoxesSource`, `toPalletsSource` и `loadPallet` над строками хоста; рендер — те же вызовы домена, что у облачного исполнителя (`renderForShift`, `renderForPallet`), и то же сопоставление отказов (`safeDomainErrorCode`): отказ домена из «безопасного» списка остаётся, прочее — `GENERATION_FAILED`. Своё у автонома — только момент операции (Ч2) и счёт расформированных паллет для предупреждения (Ч1); байтов они не меняют. Тест паритета превращает каждый случай в ответ хоста (целые секунды в `closedAt`, момент станции в `stationClosedAt`, только живые позиции — то, что делает SQL задачи 1) и сверяет каждый прогон с эталоном: 197 прогонов и проверка, что их ровно столько же, сколько ключей эталона. Мутации показывают, что каждое правило порядка, группировки и проверки держит хотя бы один случай; три условия точного покрытия облака избыточны друг относительно друга и названы эквивалентными.

**Files:**

- Create: `apps/standalone/src/office/exports/export-source.ts`, `apps/standalone/src/office/exports/run-export.ts`, `apps/standalone/test/export-parity.test.ts`, `apps/standalone/test/export-source.test.ts`

**Interfaces:**

- Consumes: `ShiftExportRows` (задача 1); `cases.json` и `golden.json` (задача 4); домен — `renderShiftExport`, `renderPalletAggregationExport`, `getShiftExportFormat`, `getPalletExportFormat`, `ShiftExportDomainError`, `formatShiftNumber` (тест).
- Produces: `export-source.ts` — `type ExportSourceRefusal`, `type SourceResult<T>`, `interface ShiftExportSnapshot`, `interface PalletExportSnapshot`, `shiftOperationDateTime(shift, formedAt): string`, `shiftExportSnapshot(rows, format: {boxMode, extension}, formedAt): SourceResult<ShiftExportSnapshot>`, `palletExportSnapshot(rows, palletId): SourceResult<PalletExportSnapshot>`; `run-export.ts` — `type ExportFailure`, `interface ExportRun { formatId, formatVersion, maxLines, palletId, documentId, formedAt }`, `type ExportResult = { ok: true; parts: ShiftExportPart[]; openPalletSuppressedBoxCount; disassembledPalletCount } | { ok: false; failure }`, `runExport(rows, run): ExportResult`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/export-parity.test.ts`:

<!-- prettier-ignore -->
```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatShiftNumber, PALLET_EXPORT_FORMATS, SHIFT_EXPORT_FORMATS } from "@markiro/domain";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import { runExport } from "../src/office/exports/run-export.js";

/**
 * The standalone's half of the export parity with the cloud (plan ЧЗ). The
 * cases of `packages/domain/test/fixtures/shift-export-parity/cases.json`
 * become the rows the host's `GET /v1/office/shifts/{id}/export-source`
 * answers — the host's whole seconds in `closedAt`, the station's instant in
 * `stationClosedAt`, live items only — and every run of the office's port
 * must give exactly `golden.json`, which the cloud's own source and runner
 * wrote (`apps/api/test/standalone-export-parity.test.ts`).
 */

const testModuleUrl = import.meta.url;

function read(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/domain/test/fixtures/shift-export-parity/${name}`, testModuleUrl),
      "utf8",
    ),
  );
}

const instant = z.iso.datetime();
const caseSchema = z.object({
  name: z.string(),
  shift: z.object({
    id: z.string(),
    status: z.enum(["planned", "active", "closed"]),
    productionDate: z.string(),
    monthKey: z.string(),
    seq: z.number().int(),
    createdFrom: z.enum(["office", "station"]),
    closedAt: instant.nullable(),
    closedBy: z.enum(["office", "station"]).nullable(),
    productName: z.string(),
    palletsEnabled: z.boolean(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  codes: z.array(z.object({ codeHash: z.string(), scannedAt: instant, canonical: z.string() })),
  boxes: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
      palletId: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      boxId: z.string(),
      codeHash: z.string(),
      removed: z.boolean(),
      displaced: z.boolean(),
    }),
  ),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: instant,
      closedAt: instant.nullable(),
      disassembledAt: instant.nullable(),
    }),
  ),
  maxLines: z.array(z.number().int().nullable()),
  palletRuns: z.array(z.string()),
});
type ParityCase = z.infer<typeof caseSchema>;
const parity = z
  .object({ documentId: z.uuid(), fileDateTime: instant, cases: z.array(caseSchema) })
  .parse(read("cases.json"));

const outcomeSchema = z.union([
  z.object({ error: z.string() }).strict(),
  z
    .object({
      openPalletSuppressedBoxCount: z.number().int(),
      parts: z.array(
        z
          .object({
            filename: z.string(),
            codeCount: z.number().int(),
            boxCount: z.number().int(),
            palletCount: z.number().int(),
            physicalLineCount: z.number().int(),
            bytes: z.number().int(),
            sha256: z.string(),
            text: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
type Outcome = z.infer<typeof outcomeSchema>;
const golden = z.record(z.string(), outcomeSchema).parse(read("golden.json"));

/** The host's answer for a case: what `export-source` would send for those facts. */
function hostRows(parityCase: ParityCase): ShiftExportRows {
  const { shift } = parityCase;
  return shiftExportRowsSchema.parse({
    shift: {
      id: shift.id,
      number: formatShiftNumber({
        monthKey: shift.monthKey,
        seq: shift.seq,
        createdFrom: shift.createdFrom === "office" ? "admin" : "station",
      }),
      status: shift.status,
      productionDate: shift.productionDate,
      productName: shift.productName,
      palletsEnabled: shift.palletsEnabled,
      // `format_timestamp`: the host's own instant in whole seconds.
      closedAt: shift.closedAt === null ? null : `${shift.closedAt.slice(0, 19)}Z`,
      stationClosedAt: shift.closedBy === "station" ? shift.closedAt : null,
      lateDataAt: null,
    },
    organization: parityCase.organization,
    codes: parityCase.codes,
    boxes: parityCase.boxes,
    items: parityCase.items
      .filter((item) => !item.removed && !item.displaced)
      .map((item) => ({ boxId: item.boxId, codeHash: item.codeHash })),
    pallets: parityCase.pallets,
  });
}

function runsOf(parityCase: ParityCase) {
  return [
    ...parityCase.maxLines.flatMap((maxLines) =>
      SHIFT_EXPORT_FORMATS.map((format) => ({
        key: `${parityCase.name}/${format.id}@${format.version}/${maxLines ?? "-"}`,
        formatId: format.id as string,
        formatVersion: format.version as number,
        maxLines,
        palletId: null as string | null,
      })),
    ),
    ...parityCase.palletRuns.flatMap((palletId) =>
      PALLET_EXPORT_FORMATS.map((format) => ({
        key: `${parityCase.name}/${format.id}@${format.version}/${palletId}`,
        formatId: format.id as string,
        formatVersion: format.version as number,
        maxLines: null,
        palletId: palletId as string | null,
      })),
    ),
  ];
}

function outcomeOf(parityCase: ParityCase, run: ReturnType<typeof runsOf>[number]): Outcome {
  const result = runExport(hostRows(parityCase), {
    formatId: run.formatId,
    formatVersion: run.formatVersion,
    maxLines: run.maxLines,
    palletId: run.palletId,
    documentId: parity.documentId,
    formedAt: parity.fileDateTime,
  });
  if (!result.ok) return { error: result.failure };
  return {
    openPalletSuppressedBoxCount: result.openPalletSuppressedBoxCount,
    parts: result.parts.map((part) => ({
      filename: part.filename,
      codeCount: part.codeCount,
      boxCount: part.boxCount,
      palletCount: part.palletCount,
      physicalLineCount: part.physicalLineCount,
      bytes: part.bytes.byteLength,
      sha256: createHash("sha256").update(part.bytes).digest("hex"),
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part.bytes),
    })),
  };
}

describe("the office's exports over the parity cases give the cloud's golden (plan ЧЗ)", () => {
  const runs = parity.cases.flatMap((parityCase) =>
    runsOf(parityCase).map((run) => [run.key, parityCase, run] as const),
  );

  it("runs exactly the golden's exports", () => {
    expect(runs.map(([key]) => key)).toEqual(Object.keys(golden));
  });

  it.each(runs)("%s", (key, parityCase, run) => {
    expect(outcomeOf(parityCase, run)).toEqual(golden[key]);
  });
});
```

2. Создать `apps/standalone/test/export-source.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  shiftExportSnapshot,
  shiftOperationDateTime,
} from "../src/office/exports/export-source.js";
import { runExport } from "../src/office/exports/run-export.js";

const testModuleUrl = import.meta.url;

/** `shift-export-rows.json`: a closed shift with pallet 1 (box 1), box 2 on no pallet, box 3 open and empty. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

const FORMED_AT = "2026-10-08T15:30:00.123Z";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const PALLETS_TXT = { boxMode: "pallets", extension: "txt" } as const;

describe("the operation instant of a shift's document (plan ЧЗ)", () => {
  it("is the station's own instant when a station closed the shift", () => {
    expect(shiftOperationDateTime(rows().shift, FORMED_AT)).toBe("2026-10-08T14:00:07.412Z");
  });

  it("is the host's instant, in canonical ISO, when the office closed it", () => {
    const shift = { ...rows().shift, stationClosedAt: null };
    expect(shiftOperationDateTime(shift, FORMED_AT)).toBe("2026-10-08T14:00:07.000Z");
  });

  it("is the moment of forming for a closed shift without either, as the cloud's snapshot", () => {
    const shift = { ...rows().shift, closedAt: null, stationClosedAt: null };
    expect(shiftOperationDateTime(shift, FORMED_AT)).toBe(FORMED_AT);
  });
});

describe("pallets taken apart in a shift's export (plan ЧЗ)", () => {
  it("stay pallets, as in the cloud, and are counted for the office's warning", () => {
    const taken = rows();
    const [pallet] = taken.pallets;
    if (pallet === undefined) throw new Error("the fixture has a pallet");
    pallet.disassembledAt = "2026-10-08T07:00:00.000Z";
    const snapshot = shiftExportSnapshot(taken, PALLETS_TXT, FORMED_AT);
    if (!snapshot.ok) throw new Error(snapshot.refusal);
    expect(snapshot.value.disassembledPalletCount).toBe(1);
    expect(snapshot.value.source).toMatchObject({
      mode: "pallets",
      pallets: [{ sscc: "146006820000000409" }],
    });
    const whole = shiftExportSnapshot(rows(), PALLETS_TXT, FORMED_AT);
    if (!whole.ok) throw new Error(whole.refusal);
    expect(whole.value.disassembledPalletCount).toBe(0);
  });

  it("are no reason to refuse a box format", () => {
    const snapshot = shiftExportSnapshot(rows(), { boxMode: "boxes", extension: "xml" }, FORMED_AT);
    expect(snapshot.ok && snapshot.value.disassembledPalletCount).toBe(0);
  });
});

describe("an export run (plan ЧЗ)", () => {
  const run = {
    maxLines: null,
    documentId: DOCUMENT,
    formedAt: FORMED_AT,
  };

  it("names a pallet's export by its pallet and a shift's by none, as the cloud's runner", () => {
    expect(
      runExport(rows(), {
        ...run,
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        palletId: null,
      }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
    expect(
      runExport(rows(), {
        ...run,
        formatId: "shift_txt_flat",
        formatVersion: 1,
        palletId: "a0000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
  });

  it("exports a closed pallet of a shift that is still active", () => {
    const active = { ...rows(), shift: { ...rows().shift, status: "active" as const } };
    const result = runExport(active, {
      ...run,
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      palletId: "a0000000-0000-4000-8000-000000000001",
    });
    if (!result.ok) throw new Error(result.failure);
    expect(result.parts.map((part) => [part.filename, part.boxCount, part.palletCount])).toEqual([
      ["Молоко_3_2_0_9_л_2026-10-08_паллета_00146006820000000409_1_коробов.xml", 1, 1],
    ]);
    expect(
      runExport(active, { ...run, formatId: "shift_txt_flat", formatVersion: 1, palletId: null }),
    ).toEqual({ ok: false, failure: "SHIFT_NOT_CLOSED" });
  });

  it("refuses a format version the domain does not know", () => {
    expect(
      runExport(rows(), { ...run, formatId: "shift_txt_boxes", formatVersion: 3, palletId: null }),
    ).toEqual({ ok: false, failure: "FORMAT_NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts test/export-source.test.ts`

Expected: FAIL: `Failed to resolve import "../src/office/exports/run-export.js"` и `"../src/office/exports/export-source.js"`, `Tests  no tests`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/src/office/exports/export-source.ts`:

<!-- prettier-ignore -->
```ts
import type {
  ShiftExportFormatDescriptor,
  ShiftExportPalletGroup,
  ShiftExportSource,
} from "@markiro/domain";

import type { ShiftExportRows } from "../../host/protocol.js";

/**
 * The cloud's export source (`apps/api/src/modules/shift-exports/shift-export-source.service.ts`,
 * `loadFromTransaction` and `loadPallet`) ported over the host's rows (plan
 * ЧЗ): the same checks in the same order, the same order of codes, boxes and
 * pallets, the same grouping. Nothing here is the standalone's own rule but
 * the operation instant (`shiftOperationDateTime`) and the count of pallets
 * taken apart, which only warns. `packages/domain/test/fixtures/shift-export-parity`
 * holds the cases both products must render to the same bytes; the cloud's
 * test and `test/export-parity.test.ts` read them. A change of the cloud's
 * rules is a change here, in the same commit as a regenerated golden.
 *
 * Left out, with the reason: `SHIFT_DATE_MISSING` (a host shift always has
 * its production date) and the validation reprocessings the flat formats add
 * in the cloud (validation is stage 3).
 */

/** The cloud's refusals of an export's source (`ShiftExportSourceErrorCode`), less `SHIFT_DATE_MISSING`. */
export type ExportSourceRefusal =
  | "SHIFT_NOT_CLOSED"
  | "SHIFT_HAS_NO_CODES"
  | "BOX_COVERAGE_INCOMPLETE"
  | "SHIFT_HAS_NO_PALLETS"
  | "PALLET_NOT_CLOSED"
  | "PALLET_DISASSEMBLED"
  | "ORG_INN_MISSING"
  | "ORG_NAME_MISSING";

export type SourceResult<T> = { ok: true; value: T } | { ok: false; refusal: ExportSourceRefusal };

/** What a shift's export renders from: the cloud's `ShiftExportSnapshot` with its instants as ISO text. */
export interface ShiftExportSnapshot {
  productName: string;
  shiftDate: string;
  shiftNumber: string;
  /** `operation_date_time` of the ЧЗ document. */
  operationDateTime: string;
  organizationInn: string | null;
  organizationName: string | null;
  /** Boxes written on no pallet only because their pallet has not closed (the cloud keeps it in its audit). */
  openPalletSuppressedBoxCount: number;
  /**
   * Pallets taken apart that a pallets format still writes as pallets, with
   * their boxes: the cloud's export does not leave them out (its pallet query
   * reads no `disassembled_at`), so neither does the port. The office warns.
   */
  disassembledPalletCount: number;
  source: ShiftExportSource;
}

/** What one pallet's export renders from: the cloud's `PalletExportSnapshot`. */
export interface PalletExportSnapshot {
  productName: string;
  /** The pallet's close as a UTC civil date, as the cloud names the file. */
  closedDate: string;
  operationDateTime: string;
  organizationInn: string | null;
  organizationName: string | null;
  pallet: { sscc: string; boxSsccs: readonly string[] };
}

type ShiftFormat = Pick<ShiftExportFormatDescriptor, "boxMode" | "extension">;

interface Authoritative {
  codeHash: string;
  time: number;
  canonical: string;
}

interface EligibleBox {
  sscc: string;
  palletId: string | null;
  codes: string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAuthoritative(left: Authoritative, right: Authoritative): number {
  return left.time - right.time || compareCodeUnits(left.codeHash, right.codeHash);
}

/** Ascending by an instant; a null (never once a group exists) first. */
function compareNullableInstants(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return Date.parse(left) - Date.parse(right);
}

/** The cloud's `loadOrganization`: trimmed, and `null` when blank. */
function organization(rows: ShiftExportRows): { inn: string | null; name: string | null } {
  return {
    inn: rows.organization.inn?.trim() || null,
    name: rows.organization.name.trim() || null,
  };
}

/**
 * `operation_date_time` of a shift's document. The cloud writes the shift's
 * `closed_at`, which for a station's close is the station's own instant; the
 * host keeps whole seconds in `closedAt` and the station's instant as
 * `stationClosedAt`, so that one comes first. The office's close is the
 * host's instant. `formedAt` stands in only for a closed shift without
 * either, as the cloud's snapshot instant does.
 */
export function shiftOperationDateTime(shift: ShiftExportRows["shift"], formedAt: string): string {
  return new Date(shift.stationClosedAt ?? shift.closedAt ?? formedAt).toISOString();
}

/** The cloud's `loadFromTransaction` over the host's rows. */
export function shiftExportSnapshot(
  rows: ShiftExportRows,
  format: ShiftFormat,
  formedAt: string,
): SourceResult<ShiftExportSnapshot> {
  const { shift } = rows;
  if (shift.status !== "closed") return { ok: false, refusal: "SHIFT_NOT_CLOSED" };
  let organizationInn: string | null = null;
  let organizationName: string | null = null;
  if (format.extension === "xml") {
    const org = organization(rows);
    organizationInn = org.inn;
    organizationName = org.name;
    if (organizationInn === null) return { ok: false, refusal: "ORG_INN_MISSING" };
    if (organizationName === null) return { ok: false, refusal: "ORG_NAME_MISSING" };
  }
  const authoritative = rows.codes
    .map((code) => ({
      codeHash: code.codeHash,
      time: Date.parse(code.scannedAt),
      canonical: code.canonical,
    }))
    .sort(compareAuthoritative);
  if (authoritative.length === 0) return { ok: false, refusal: "SHIFT_HAS_NO_CODES" };

  let source: ShiftExportSource;
  let openPalletSuppressedBoxCount = 0;
  let disassembledPalletCount = 0;
  if (format.boxMode === "flat") {
    source = { mode: "flat", codes: authoritative.map((code) => code.canonical) };
  } else {
    const eligible = eligibleBoxes(rows, authoritative);
    if (eligible === null) return { ok: false, refusal: "BOX_COVERAGE_INCOMPLETE" };
    if (format.boxMode === "boxes") {
      source = {
        mode: "boxes",
        boxes: [...eligible]
          .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
          .map((box) => ({ sscc: box.sscc, codes: box.codes })),
      };
    } else {
      const pallets = palletsSource(rows, eligible);
      if (pallets === null) return { ok: false, refusal: "SHIFT_HAS_NO_PALLETS" };
      source = pallets.source;
      openPalletSuppressedBoxCount = pallets.openPalletSuppressedBoxCount;
      disassembledPalletCount = pallets.disassembledPalletCount;
    }
  }
  return {
    ok: true,
    value: {
      productName: shift.productName,
      shiftDate: shift.productionDate,
      shiftNumber: shift.number,
      operationDateTime: shiftOperationDateTime(shift, formedAt),
      organizationInn,
      organizationName,
      openPalletSuppressedBoxCount,
      disassembledPalletCount,
      source,
    },
  };
}

/**
 * The cloud's `loadEligibleBoxes`: every closed box with an SSCC, not taken
 * apart, whose live items cover the shift's codes exactly — each code in
 * exactly one such box, no item of a code the shift does not own, one SSCC
 * a box. `null` is `BOX_COVERAGE_INCOMPLETE`. The host sends live items only,
 * the cloud's first filter.
 */
function eligibleBoxes(
  rows: ShiftExportRows,
  authoritative: readonly Authoritative[],
): EligibleBox[] | null {
  const boxById = new Map(rows.boxes.map((box) => [box.id, box]));
  const eligible = rows.items.flatMap((item) => {
    const box = boxById.get(item.boxId);
    return box !== undefined &&
      box.closedAt !== null &&
      box.sscc !== null &&
      box.disassembledAt === null
      ? [{ boxId: box.id, sscc: box.sscc, palletId: box.palletId, codeHash: item.codeHash }]
      : [];
  });
  const authoritativeByHash = new Map(authoritative.map((code) => [code.codeHash, code]));
  const membershipCounts = new Map<string, number>();
  for (const row of eligible) {
    membershipCounts.set(row.codeHash, (membershipCounts.get(row.codeHash) ?? 0) + 1);
  }
  const coverageIsExact =
    eligible.length === authoritative.length &&
    eligible.every((row) => authoritativeByHash.has(row.codeHash)) &&
    authoritative.every((code) => membershipCounts.get(code.codeHash) === 1);
  if (!coverageIsExact) return null;

  const rowsByBox = new Map<
    string,
    { sscc: string; palletId: string | null; codes: Authoritative[] }
  >();
  for (const row of eligible) {
    const code = authoritativeByHash.get(row.codeHash);
    if (code === undefined) return null;
    const existing = rowsByBox.get(row.boxId);
    if (existing) {
      if (existing.sscc !== row.sscc) return null;
      existing.codes.push(code);
    } else {
      rowsByBox.set(row.boxId, { sscc: row.sscc, palletId: row.palletId, codes: [code] });
    }
  }
  return [...rowsByBox.values()].map((box) => ({
    sscc: box.sscc,
    palletId: box.palletId,
    codes: [...box.codes].sort(compareAuthoritative).map((code) => code.canonical),
  }));
}

/**
 * The cloud's `toPalletsSource`: a box on a closed pallet (one with an
 * SSCC) joins that pallet's group; pallets by their close, then their SSCC;
 * their boxes by SSCC; a box on no pallet, or on a pallet still open, is
 * loose, after every pallet, and one on an open pallet counts as suppressed.
 * `null` when no group exists (`SHIFT_HAS_NO_PALLETS`).
 */
function palletsSource(
  rows: ShiftExportRows,
  eligible: readonly EligibleBox[],
): {
  source: ShiftExportSource;
  openPalletSuppressedBoxCount: number;
  disassembledPalletCount: number;
} | null {
  const palletById = new Map(rows.pallets.map((pallet) => [pallet.id, pallet]));
  const groups = new Map<
    string,
    {
      sscc: string;
      closedAt: string | null;
      disassembled: boolean;
      boxes: { sscc: string; codes: string[] }[];
    }
  >();
  const looseBoxes: { sscc: string; codes: string[] }[] = [];
  let openPalletSuppressedBoxCount = 0;
  for (const box of eligible) {
    if (box.palletId === null) {
      looseBoxes.push({ sscc: box.sscc, codes: box.codes });
      continue;
    }
    const pallet = palletById.get(box.palletId);
    if (pallet === undefined || pallet.sscc === null) {
      if (pallet !== undefined) openPalletSuppressedBoxCount += 1;
      looseBoxes.push({ sscc: box.sscc, codes: box.codes });
      continue;
    }
    const existing = groups.get(box.palletId);
    if (existing) {
      existing.boxes.push({ sscc: box.sscc, codes: box.codes });
    } else {
      groups.set(box.palletId, {
        sscc: pallet.sscc,
        closedAt: pallet.closedAt,
        disassembled: pallet.disassembledAt !== null,
        boxes: [{ sscc: box.sscc, codes: box.codes }],
      });
    }
  }
  if (groups.size === 0) return null;
  const ordered = [...groups.values()].sort(
    (left, right) =>
      compareNullableInstants(left.closedAt, right.closedAt) ||
      compareCodeUnits(left.sscc, right.sscc),
  );
  const pallets: ShiftExportPalletGroup[] = ordered.map((group) => ({
    sscc: group.sscc,
    boxes: [...group.boxes].sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
  }));
  return {
    source: {
      mode: "pallets",
      pallets,
      looseBoxes: looseBoxes.sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
    },
    openPalletSuppressedBoxCount,
    disassembledPalletCount: ordered.filter((group) => group.disassembled).length,
  };
}

/**
 * The cloud's `loadPallet` over the host's rows: a pallet that is unknown,
 * not closed or without an SSCC is `PALLET_NOT_CLOSED`, one taken apart
 * `PALLET_DISASSEMBLED`; its boxes are its closed boxes not taken apart, by
 * their close, then their id, as the cloud's SQL orders them. The shift
 * need not be closed (the cloud exports a closed pallet of an active shift).
 */
export function palletExportSnapshot(
  rows: ShiftExportRows,
  palletId: string,
): SourceResult<PalletExportSnapshot> {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  if (pallet === undefined || pallet.sscc === null || pallet.closedAt === null) {
    return { ok: false, refusal: "PALLET_NOT_CLOSED" };
  }
  if (pallet.disassembledAt !== null) return { ok: false, refusal: "PALLET_DISASSEMBLED" };
  const boxes = rows.boxes
    .flatMap((box) =>
      box.palletId === palletId && box.closedAt !== null && box.disassembledAt === null
        ? [{ id: box.id, sscc: box.sscc, closedAt: box.closedAt }]
        : [],
    )
    .sort(
      (left, right) =>
        Date.parse(left.closedAt) - Date.parse(right.closedAt) ||
        compareCodeUnits(left.id, right.id),
    );
  const org = organization(rows);
  const closedAt = new Date(pallet.closedAt).toISOString();
  return {
    ok: true,
    value: {
      productName: rows.shift.productName,
      closedDate: closedAt.slice(0, 10),
      operationDateTime: closedAt,
      organizationInn: org.inn,
      organizationName: org.name,
      pallet: {
        sscc: pallet.sscc,
        boxSsccs: boxes.flatMap((box) => (box.sscc === null ? [] : [box.sscc])),
      },
    },
  };
}
```

2. Создать `apps/standalone/src/office/exports/run-export.ts`:

<!-- prettier-ignore -->
```ts
import {
  getPalletExportFormat,
  getShiftExportFormat,
  renderPalletAggregationExport,
  renderShiftExport,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "@markiro/domain";

import type { ShiftExportRows } from "../../host/protocol.js";
import {
  palletExportSnapshot,
  shiftExportSnapshot,
  type ExportSourceRefusal,
} from "./export-source.js";

/**
 * What an export in the office can end with: the cloud's
 * `SHIFT_EXPORT_SAFE_ERROR_CODES` (`shift-export-runner.service.ts`) less
 * the queue's, the storage's and `SHIFT_DATE_MISSING`.
 */
export type ExportFailure =
  | ExportSourceRefusal
  | "FORMAT_NOT_FOUND"
  | "INVALID_ORG_INN"
  | "INVALID_LINE_LIMIT"
  | "BOX_EXCEEDS_LINE_LIMIT"
  | "PALLET_EXCEEDS_LINE_LIMIT"
  | "INVALID_BOX_SSCC"
  | "INVALID_CIS"
  | "GENERATION_FAILED";

/**
 * One export: the format, the line limit (`null`: one part), the pallet of a
 * pallet's export (`null`: the shift's), the base `document_id` its files
 * carry (a new UUID each time, as the cloud's export row id) and the instant
 * it is formed (`file_date_time`, canonical ISO).
 */
export interface ExportRun {
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  palletId: string | null;
  documentId: string;
  formedAt: string;
}

export type ExportResult =
  | {
      ok: true;
      parts: ShiftExportPart[];
      openPalletSuppressedBoxCount: number;
      disassembledPalletCount: number;
    }
  | { ok: false; failure: ExportFailure };

/** The domain's codes the cloud's runner records as they are (`safeDomainErrorCode`). */
const SAFE_DOMAIN_CODES = new Set<string>([
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "PALLET_EXCEEDS_LINE_LIMIT",
  "INVALID_BOX_SSCC",
  "INVALID_CIS",
  "ORG_INN_MISSING",
  "ORG_NAME_MISSING",
  "INVALID_ORG_INN",
]);

function isFailure(code: string): code is ExportFailure {
  return SAFE_DOMAIN_CODES.has(code);
}

/**
 * The cloud runner's `renderForShift` and `renderForPallet` over the host's
 * rows: the format is looked up first, then the source, then the domain
 * renders. A domain refusal the runner records as it is stays as it is; any
 * other failure — `EMPTY_SOURCE`, bad metadata, a malformed date — is
 * `GENERATION_FAILED`, where the cloud ends after its retries.
 */
export function runExport(rows: ShiftExportRows, run: ExportRun): ExportResult {
  try {
    return run.palletId === null
      ? renderForShift(rows, run)
      : renderForPallet(rows, run, run.palletId);
  } catch (error) {
    if (error instanceof ShiftExportDomainError && isFailure(error.code)) {
      return { ok: false, failure: error.code };
    }
    return { ok: false, failure: "GENERATION_FAILED" };
  }
}

function renderForShift(rows: ShiftExportRows, run: ExportRun): ExportResult {
  const format = getShiftExportFormat(run.formatId, run.formatVersion);
  const snapshot = shiftExportSnapshot(rows, format, run.formedAt);
  if (!snapshot.ok) return { ok: false, failure: snapshot.refusal };
  const parts = renderShiftExport({
    formatId: format.id,
    formatVersion: format.version,
    productName: snapshot.value.productName,
    shiftDate: snapshot.value.shiftDate,
    maxLines: run.maxLines,
    source: snapshot.value.source,
    organizationInn: snapshot.value.organizationInn,
    organizationName: snapshot.value.organizationName,
    document: {
      documentId: run.documentId,
      documentNumber: snapshot.value.shiftNumber,
      fileDateTime: run.formedAt,
      operationDateTime: snapshot.value.operationDateTime,
    },
  });
  return {
    ok: true,
    parts,
    openPalletSuppressedBoxCount: snapshot.value.openPalletSuppressedBoxCount,
    disassembledPalletCount: snapshot.value.disassembledPalletCount,
  };
}

function renderForPallet(rows: ShiftExportRows, run: ExportRun, palletId: string): ExportResult {
  const format = getPalletExportFormat(run.formatId, run.formatVersion);
  const snapshot = palletExportSnapshot(rows, palletId);
  if (!snapshot.ok) return { ok: false, failure: snapshot.refusal };
  const part = renderPalletAggregationExport({
    formatId: format.id,
    formatVersion: format.version,
    organizationInn: snapshot.value.organizationInn,
    organizationName: snapshot.value.organizationName,
    productName: snapshot.value.productName,
    closedDate: snapshot.value.closedDate,
    documentId: run.documentId,
    fileDateTime: run.formedAt,
    operationDateTime: snapshot.value.operationDateTime,
    pallet: snapshot.value.pallet,
  });
  return { ok: true, parts: [part], openPalletSuppressedBoxCount: 0, disassembledPalletCount: 0 };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts test/export-source.test.ts`

Expected: PASS: `Tests  206 passed (206)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **P1** (коды только по хешу): в `apps/standalone/src/office/exports/export-source.ts` `return left.time - right.time || compareCodeUnits(left.codeHash, right.codeHash);` → `return compareCodeUnits(left.codeHash, right.codeHash);`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `boxes/shift_csv_flat@1/-`, `boxes/shift_csv_flat@1/16`, `boxes/shift_csv_flat@1/2` и ещё 15.
- **P2** (коды только по времени): в `apps/standalone/src/office/exports/export-source.ts` `return left.time - right.time || compareCodeUnits(left.codeHash, right.codeHash);` → `return left.time - right.time;`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `boxes/shift_csv_boxes@2/-`, `boxes/shift_csv_boxes@2/16`, `boxes/shift_csv_boxes@2/20` и ещё 18.
- **P3** (короба без порядка по SSCC): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
        boxes: [...eligible]
          .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
          .map(
```

заменить на

<!-- prettier-ignore -->
```ts
        boxes: [...eligible]
          .map(
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `boxes/shift_csv_boxes@2/-`, `boxes/shift_csv_boxes@2/16`, `boxes/shift_csv_boxes@2/20` и ещё 17.

- **P4** (паллеты с одним моментом без порядка по SSCC): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
      compareNullableInstants(left.closedAt, right.closedAt) ||
      compareCodeUnits(left.sscc, right.sscc),
```

заменить на

<!-- prettier-ignore -->
```ts
      compareNullableInstants(left.closedAt, right.closedAt),
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/shift_csv_pallets@1/-`, `pallets/shift_csv_pallets@1/30`, `pallets/shift_csv_pallets@1/8` и ещё 10.

- **P5** (подавленные короба не считаются): в `apps/standalone/src/office/exports/export-source.ts` `if (pallet !== undefined) openPalletSuppressedBoxCount += 1;` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/shift_csv_pallets@1/-`, `pallets/shift_csv_pallets@1/30`, `pallets/shift_csv_pallets@1/8` и ещё 10.
- **P6** (расформированная паллета — короба без паллеты (Ч1 наоборот)): в `apps/standalone/src/office/exports/export-source.ts` `if (pallet === undefined || pallet.sscc === null) {` → `if (pallet === undefined || pallet.sscc === null || pallet.disassembledAt !== null) {`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/shift_csv_pallets@1/-`, `pallets/shift_csv_pallets@1/30`, `pallets/shift_csv_pallets@1/8` и ещё 10.
- **P7a** (без условия «столько же позиций, сколько кодов»): в `apps/standalone/src/office/exports/export-source.ts` `eligible.length === authoritative.length &&` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: PASS — эквивалентный мутант: логически следует из двух других условий облака: каждый код ровно в одном коробе и каждая позиция — код смены.
- **P7b** (без условия «каждая позиция — код смены»): в `apps/standalone/src/office/exports/export-source.ts` `eligible.every((row) => authoritativeByHash.has(row.codeHash)) &&` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: PASS — эквивалентный мутант: так же следует из двух других условий; облако держит все три, порт — как облако.
- **P7c** (без условия «каждый код ровно в одном коробе»): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
    eligible.length === authoritative.length &&
    eligible.every((row) => authoritativeByHash.has(row.codeHash)) &&
    authoritative.every((code) => membershipCounts.get(code.codeHash) === 1);
```

заменить на

<!-- prettier-ignore -->
```ts
    eligible.length === authoritative.length &&
    eligible.every((row) => authoritativeByHash.has(row.codeHash));
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `double-membership/shift_csv_boxes@2/-`, `double-membership/shift_csv_pallets@1/-`, `double-membership/shift_txt_boxes@2/-` и ещё 5.

- **P7d** (открытый короб годен): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
    return box !== undefined &&
      box.closedAt !== null &&
```

заменить на

<!-- prettier-ignore -->
```ts
    return box !== undefined &&
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: PASS — эквивалентный мутант: открытый короб не имеет SSCC ни у хоста, ни в облаке, а условие о SSCC остаётся.

- **P7e** (расформированный короб годен): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
      box.sscc !== null &&
      box.disassembledAt === null
```

заменить на

<!-- prettier-ignore -->
```ts
      box.sscc !== null
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `disassembled-live/shift_csv_boxes@2/-`, `disassembled-live/shift_csv_pallets@1/-`, `disassembled-live/shift_txt_boxes@2/-` и ещё 5.

- **P8** (короба паллеты только по `id`): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
        Date.parse(left.closedAt) - Date.parse(right.closedAt) ||
        compareCodeUnits(left.id, right.id),
```

заменить на

<!-- prettier-ignore -->
```ts
        compareCodeUnits(left.id, right.id),
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000001`.

- **P9** (момент операции — целые секунды хоста прежде момента станции): в `apps/standalone/src/office/exports/export-source.ts` `return new Date(shift.stationClosedAt ?? shift.closedAt ?? formedAt).toISOString();` → `return new Date(shift.closedAt ?? shift.stationClosedAt ?? formedAt).toISOString();`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `boxes/shift_xml_gismt_aggregation@1/-`, `boxes/shift_xml_gismt_aggregation@1/16`, `boxes/shift_xml_gismt_aggregation@1/20` и ещё 6.
- **P10** (расформированная паллета получает документ): в `apps/standalone/src/office/exports/export-source.ts` `if (pallet.disassembledAt !== null) return { ok: false, refusal: "PALLET_DISASSEMBLED" };` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000004`.
- **P11** (`EMPTY_SOURCE` остаётся своим кодом): в `apps/standalone/src/office/exports/run-export.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
```

заменить на

<!-- prettier-ignore -->
```ts
  "FORMAT_NOT_FOUND",
  "EMPTY_SOURCE",
  "INVALID_LINE_LIMIT",
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `pallets/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000005`.

- **P12** (проверка ИНН после проверки кодов): в `apps/standalone/src/office/exports/export-source.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (format.extension === "xml") {
    const org = organization(rows);
```

заменить на

<!-- prettier-ignore -->
```ts
  if (format.extension === "xml" && rows.codes.length > 0) {
    const org = organization(rows);
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `no-codes/shift_xml_gismt_aggregation@1/-`, `no-codes/shift_xml_gismt_aggregation_pallets@1/-`, `no-codes/shift_xml_gismt_pallet_boxes@1/-`.

- **P13** (активная смена выгружается): в `apps/standalone/src/office/exports/export-source.ts` `if (shift.status !== "closed") return { ok: false, refusal: "SHIFT_NOT_CLOSED" };` → `if (shift.status === "planned") return { ok: false, refusal: "SHIFT_NOT_CLOSED" };`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `not-closed/shift_csv_boxes@2/-`, `not-closed/shift_csv_flat@1/-`, `not-closed/shift_csv_pallets@1/-` и ещё 7.
- **P14** (дата файла паллеты — дата производства, а не дата закрытия по UTC): в `apps/standalone/src/office/exports/export-source.ts` `closedDate: closedAt.slice(0, 10),` → `closedDate: rows.shift.productionDate,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-parity.test.ts`. Ожидается: FAIL — `not-closed/pallet_xml_gismt_aggregation@1/a0000000-0000-4000-8000-000000000001`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/office/exports/export-source.ts apps/standalone/src/office/exports/run-export.ts apps/standalone/test/export-parity.test.ts apps/standalone/test/export-source.test.ts
git commit -m "feat(standalone): the office renders a shift's exports with the cloud's source rules and bytes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Что диалог знает до формирования: форматы с отказами, паллеты, счётчики, предупреждения, папка

Диалог показывает каждый формат, который облако предложило бы этой смене (паллетные — только смене с паллетами), с отказом его источника сейчас; паллеты — закрытые по моменту и SSCC, открытые в конце, у каждой отказ документа одной паллеты; счётчики «кодов в смене / в закрытых коробах / закрытых коробов / закрытых паллет» (указание координатора); предупреждения, которые не меняют байтов: поздние данные (аналог облачного `stale`), короба на незакрытых паллетах (у облака — только в журнале), расформированные паллеты в документе (Ч1). Папка выгрузки — сегменты для оболочки: `Выгрузки`, номер смены как сегмент имени файла домена (`OCT26-004/S` → `OCT26-004_S`), `<дата_время>_<формат>` в часовом поясе организации (`hourCycle: "h23"`, полночь — `00`). Отказы домена при рендере (`INVALID_CIS`, ИНН, лимит строк) диалог узнаёт только при формировании.

**Files:**

- Create: `apps/standalone/src/office/exports/export-checks.ts`, `apps/standalone/test/export-checks.test.ts`

**Interfaces:**

- Consumes: `shiftExportSnapshot`, `palletExportSnapshot`, `ExportSourceRefusal` (задача 5); домен — `SHIFT_EXPORT_FORMATS`, `shiftExportFormatRequiresPallets`, `sanitizeShiftExportFilenameSegment`.
- Produces: `interface FormatOffer { format; refusal }`, `formatOffers(rows, formedAt): FormatOffer[]`; `interface PalletOffer { palletId; sscc; closedAt; boxes; refusal }`, `palletOffers(rows): PalletOffer[]`; `interface ExportCounts { codes; codesInClosedBoxes; closedBoxes; closedPallets }`, `exportCounts(rows)`; `type ExportWarning = late_data | open_pallets | disassembled_pallets`, `exportWarnings(rows, format, formedAt)`; `exportFolder(shiftNumber, formatId, formedAt, timeZone): string[]`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/export-checks.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getShiftExportFormat } from "@markiro/domain";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  exportCounts,
  exportFolder,
  exportWarnings,
  formatOffers,
  palletOffers,
} from "../src/office/exports/export-checks.js";

const testModuleUrl = import.meta.url;
const FORMED_AT = "2026-10-08T15:30:00.123Z";
const HASH_C = "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";

/** `shift-export-rows.json`: pallet 1 (box 1, codes A and B) closed, box 2 (code C) on no pallet, box 3 open and empty. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

/** The fixture with code C moved from box 2 into the open box 3: no box format can cover it. */
function uncovered(): ShiftExportRows {
  const moved = rows();
  moved.items = moved.items.map((item) =>
    item.codeHash === HASH_C ? { ...item, boxId: "b0000000-0000-4000-8000-000000000003" } : item,
  );
  return moved;
}

describe("the formats the dialog offers (plan ЧЗ)", () => {
  it("are every format for a shift with pallets, the five without pallets for one without", () => {
    expect(formatOffers(rows(), FORMED_AT).map((offer) => offer.format.id)).toEqual([
      "shift_txt_flat",
      "shift_txt_boxes",
      "shift_csv_flat",
      "shift_csv_boxes",
      "shift_xml_gismt_aggregation",
      "shift_txt_pallets",
      "shift_csv_pallets",
      "shift_xml_gismt_aggregation_pallets",
      "shift_txt_pallet_boxes",
      "shift_xml_gismt_pallet_boxes",
    ]);
    const without = { ...rows(), shift: { ...rows().shift, palletsEnabled: false } };
    expect(formatOffers(without, FORMED_AT).map((offer) => offer.format.id)).toEqual([
      "shift_txt_flat",
      "shift_txt_boxes",
      "shift_csv_flat",
      "shift_csv_boxes",
      "shift_xml_gismt_aggregation",
    ]);
  });

  it("carry each format's refusal now: a code outside a closed box blocks every box format", () => {
    expect(formatOffers(rows(), FORMED_AT).every((offer) => offer.refusal === null)).toBe(true);
    expect(
      formatOffers(uncovered(), FORMED_AT).map((offer) => [offer.format.id, offer.refusal]),
    ).toEqual([
      ["shift_txt_flat", null],
      ["shift_txt_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_csv_flat", null],
      ["shift_csv_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_aggregation", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_txt_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_csv_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_aggregation_pallets", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_txt_pallet_boxes", "BOX_COVERAGE_INCOMPLETE"],
      ["shift_xml_gismt_pallet_boxes", "BOX_COVERAGE_INCOMPLETE"],
    ]);
  });

  it("refuse the ЧЗ documents without an INN, and everything for a shift not closed", () => {
    const noInn = { ...rows(), organization: { name: "ООО «Атолл»", inn: null } };
    expect(
      formatOffers(noInn, FORMED_AT)
        .filter((offer) => offer.refusal !== null)
        .map((offer) => [offer.format.id, offer.refusal]),
    ).toEqual([
      ["shift_xml_gismt_aggregation", "ORG_INN_MISSING"],
      ["shift_xml_gismt_aggregation_pallets", "ORG_INN_MISSING"],
      ["shift_xml_gismt_pallet_boxes", "ORG_INN_MISSING"],
    ]);
    const active = { ...rows(), shift: { ...rows().shift, status: "active" as const } };
    expect(new Set(formatOffers(active, FORMED_AT).map((offer) => offer.refusal))).toEqual(
      new Set(["SHIFT_NOT_CLOSED"]),
    );
  });
});

describe("the pallets the dialog offers (plan ЧЗ)", () => {
  it("are closed ones by their close and SSCC, open ones last, each with its boxes and refusal", () => {
    const shift = rows();
    shift.pallets.push(
      {
        id: "a0000000-0000-4000-8000-000000000002",
        sscc: null,
        openedAt: "2026-10-08T06:21:00.000Z",
        closedAt: null,
        disassembledAt: null,
      },
      {
        id: "a0000000-0000-4000-8000-000000000003",
        sscc: "146006820000000416",
        openedAt: "2026-10-08T06:00:00.000Z",
        closedAt: "2026-10-08T06:20:44.650Z",
        disassembledAt: "2026-10-08T06:30:00.000Z",
      },
    );
    shift.boxes.push({
      id: "b0000000-0000-4000-8000-000000000004",
      sscc: "046006820000015024",
      openedAt: "2026-10-08T06:21:00.000Z",
      closedAt: "2026-10-08T06:22:00.000Z",
      disassembledAt: null,
      palletId: "a0000000-0000-4000-8000-000000000002",
    });
    expect(palletOffers(shift)).toEqual([
      {
        palletId: "a0000000-0000-4000-8000-000000000001",
        sscc: "146006820000000409",
        closedAt: "2026-10-08T06:20:44.650Z",
        boxes: 1,
        refusal: null,
      },
      {
        palletId: "a0000000-0000-4000-8000-000000000003",
        sscc: "146006820000000416",
        closedAt: "2026-10-08T06:20:44.650Z",
        boxes: 0,
        refusal: "PALLET_DISASSEMBLED",
      },
      {
        palletId: "a0000000-0000-4000-8000-000000000002",
        sscc: null,
        closedAt: null,
        boxes: 1,
        refusal: "PALLET_NOT_CLOSED",
      },
    ]);
  });
});

describe("the shift's counts and warnings in the dialog (plan ЧЗ)", () => {
  it("count the codes, those in closed boxes, the closed boxes and the closed pallets", () => {
    expect(exportCounts(rows())).toEqual({
      codes: 3,
      codesInClosedBoxes: 3,
      closedBoxes: 2,
      closedPallets: 1,
    });
    expect(exportCounts(uncovered())).toMatchObject({ codes: 3, codesInClosedBoxes: 2 });
    const taken = rows();
    taken.pallets.push({
      id: "a0000000-0000-4000-8000-000000000003",
      sscc: "146006820000000416",
      openedAt: "2026-10-08T06:00:00.000Z",
      closedAt: "2026-10-08T06:20:44.650Z",
      disassembledAt: "2026-10-08T06:30:00.000Z",
    });
    expect(exportCounts(taken).closedPallets).toBe(1);
  });

  it("warn of late data for every format, and of open and taken-apart pallets for the pallets formats", () => {
    const shift = rows();
    shift.shift.lateDataAt = "2026-10-08T16:00:00Z";
    const [pallet] = shift.pallets;
    if (pallet === undefined) throw new Error("the fixture has a pallet");
    pallet.disassembledAt = "2026-10-08T07:00:00.000Z";
    shift.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: null,
      openedAt: "2026-10-08T06:07:15.902Z",
      closedAt: null,
      disassembledAt: null,
    });
    const box2 = shift.boxes[1];
    if (box2 === undefined) throw new Error("the fixture has box 2");
    box2.palletId = "a0000000-0000-4000-8000-000000000002";
    expect(exportWarnings(shift, getShiftExportFormat("shift_txt_boxes", 2), FORMED_AT)).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
    ]);
    expect(
      exportWarnings(
        shift,
        getShiftExportFormat("shift_xml_gismt_aggregation_pallets", 1),
        FORMED_AT,
      ),
    ).toEqual([
      { kind: "late_data", at: "2026-10-08T16:00:00Z" },
      { kind: "open_pallets", boxes: 1 },
      { kind: "disassembled_pallets", pallets: 1 },
    ]);
    expect(exportWarnings(rows(), getShiftExportFormat("shift_txt_pallets", 1), FORMED_AT)).toEqual(
      [],
    );
  });
});

describe("the folder of an export (plan ЧЗ)", () => {
  it("is the shift's number as a file name's segment and the moment in the organization's zone", () => {
    expect(
      exportFolder("OCT26-004", "shift_xml_gismt_aggregation", FORMED_AT, "Europe/Moscow"),
    ).toEqual(["Выгрузки", "OCT26-004", "2026-10-08_18-30-00_shift_xml_gismt_aggregation"]);
    expect(
      exportFolder("OCT26-005/S", "shift_txt_flat", "2026-10-08T21:00:05.000Z", "Europe/Moscow"),
    ).toEqual(["Выгрузки", "OCT26-005_S", "2026-10-09_00-00-05_shift_txt_flat"]);
  });
});
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`

Expected: FAIL: `Failed to resolve import "../src/office/exports/export-checks.js"`, `Tests  no tests`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/src/office/exports/export-checks.ts`:

<!-- prettier-ignore -->
```ts
import {
  sanitizeShiftExportFilenameSegment,
  SHIFT_EXPORT_FORMATS,
  shiftExportFormatRequiresPallets,
  type ShiftExportFormatDescriptor,
} from "@markiro/domain";

import type { ShiftExportRows } from "../../host/protocol.js";
import {
  palletExportSnapshot,
  shiftExportSnapshot,
  type ExportSourceRefusal,
} from "./export-source.js";

/**
 * What the export dialog shows before anything is formed (plan ЧЗ): each
 * format the cloud would offer this shift with the refusal its source would
 * give now, each pallet with whether its own document can be formed, the
 * shift's counts and the warnings that change no byte of a file. A refusal
 * the domain gives only while rendering (`INVALID_CIS`, a line limit, the
 * INN's form) comes from `runExport` when the user forms the file.
 */

export interface FormatOffer {
  format: ShiftExportFormatDescriptor;
  /** `null`: the source allows it now. */
  refusal: ExportSourceRefusal | null;
}

export interface PalletOffer {
  palletId: string;
  sscc: string | null;
  closedAt: string | null;
  /** Its closed boxes not taken apart: what its document names. */
  boxes: number;
  /** `PALLET_NOT_CLOSED` or `PALLET_DISASSEMBLED`; `null`: its document can be formed. */
  refusal: ExportSourceRefusal | null;
}

export interface ExportCounts {
  /** Codes the shift owns. */
  codes: number;
  /** Of them, codes in a closed box not taken apart: what a box format can write. */
  codesInClosedBoxes: number;
  /** Closed boxes not taken apart. */
  closedBoxes: number;
  /** Closed pallets not taken apart. */
  closedPallets: number;
}

export type ExportWarning =
  /** Facts arrived after the close (the cloud's `stale`): an earlier export is out of date. */
  | { kind: "late_data"; at: string }
  /** Pallets formats: boxes written on no pallet because their pallet has not closed. */
  | { kind: "open_pallets"; boxes: number }
  /** Pallets formats: pallets taken apart that the document still names, as the cloud's does. */
  | { kind: "disassembled_pallets"; pallets: number };

/**
 * The formats the cloud's dialog offers this shift (`ShiftExportsDialog`:
 * the pallets formats only for a shift with pallets), each with its
 * source's refusal now.
 */
export function formatOffers(rows: ShiftExportRows, formedAt: string): FormatOffer[] {
  return SHIFT_EXPORT_FORMATS.filter(
    (format) => rows.shift.palletsEnabled || !shiftExportFormatRequiresPallets(format),
  ).map((format) => {
    const snapshot = shiftExportSnapshot(rows, format, formedAt);
    return { format, refusal: snapshot.ok ? null : snapshot.refusal };
  });
}

/** Every pallet of the shift, closed ones first by their close, then by SSCC; open ones last. */
export function palletOffers(rows: ShiftExportRows): PalletOffer[] {
  return [...rows.pallets]
    .sort((left, right) => {
      if (left.closedAt === null || right.closedAt === null) {
        return Number(left.closedAt === null) - Number(right.closedAt === null);
      }
      const leftSscc = left.sscc ?? "";
      const rightSscc = right.sscc ?? "";
      return (
        Date.parse(left.closedAt) - Date.parse(right.closedAt) ||
        (leftSscc < rightSscc ? -1 : leftSscc > rightSscc ? 1 : 0)
      );
    })
    .map((pallet) => {
      const snapshot = palletExportSnapshot(rows, pallet.id);
      return {
        palletId: pallet.id,
        sscc: pallet.sscc,
        closedAt: pallet.closedAt,
        boxes: snapshot.ok
          ? snapshot.value.pallet.boxSsccs.length
          : rows.boxes.filter((box) => box.palletId === pallet.id && box.disassembledAt === null)
              .length,
        refusal: snapshot.ok ? null : snapshot.refusal,
      };
    });
}

/** The shift's counts as the export sees them, the coordinator's «in closed boxes» among them. */
export function exportCounts(rows: ShiftExportRows): ExportCounts {
  const closedBox = new Set(
    rows.boxes
      .filter((box) => box.closedAt !== null && box.sscc !== null && box.disassembledAt === null)
      .map((box) => box.id),
  );
  const owned = new Set(rows.codes.map((code) => code.codeHash));
  return {
    codes: rows.codes.length,
    codesInClosedBoxes: new Set(
      rows.items
        .filter((item) => closedBox.has(item.boxId) && owned.has(item.codeHash))
        .map((item) => item.codeHash),
    ).size,
    closedBoxes: closedBox.size,
    closedPallets: rows.pallets.filter(
      (pallet) => pallet.closedAt !== null && pallet.disassembledAt === null,
    ).length,
  };
}

/**
 * The warnings of `format` now: late data for every format; for a pallets
 * format, the boxes its document writes on no pallet and the pallets taken
 * apart it still names (both 0 when the source refuses).
 */
export function exportWarnings(
  rows: ShiftExportRows,
  format: ShiftExportFormatDescriptor,
  formedAt: string,
): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  if (rows.shift.lateDataAt !== null) {
    warnings.push({ kind: "late_data", at: rows.shift.lateDataAt });
  }
  if (!shiftExportFormatRequiresPallets(format)) return warnings;
  const snapshot = shiftExportSnapshot(rows, format, formedAt);
  if (!snapshot.ok) return warnings;
  if (snapshot.value.openPalletSuppressedBoxCount > 0) {
    warnings.push({ kind: "open_pallets", boxes: snapshot.value.openPalletSuppressedBoxCount });
  }
  if (snapshot.value.disassembledPalletCount > 0) {
    warnings.push({
      kind: "disassembled_pallets",
      pallets: snapshot.value.disassembledPalletCount,
    });
  }
  return warnings;
}

/**
 * Where an export's files go, as the shell's segments under
 * `Документы\Markiro`: `Выгрузки\<номер смены>\<дата_время>_<формат>`, the
 * number as the domain writes a file name's segment (`OCT26-004/S` is
 * `OCT26-004_S`), the moment in the organization's time zone. One folder an
 * export, so a later export with fewer parts never leaves an older part
 * beside it; the shell adds « (2)» to a folder that exists.
 */
export function exportFolder(
  shiftNumber: string,
  formatId: string,
  formedAt: string,
  timeZone: string,
): string[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(formedAt));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((each) => each.type === type)?.value ?? "00";
  const stamp = `${part("year")}-${part("month")}-${part("day")}_${part("hour")}-${part("minute")}-${part("second")}`;
  return ["Выгрузки", sanitizeShiftExportFilenameSegment(shiftNumber), `${stamp}_${formatId}`];
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`

Expected: PASS: `Tests  7 passed (7)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **K1** (паллетные форматы предлагаются всегда): в `apps/standalone/src/office/exports/export-checks.ts` `(format) => rows.shift.palletsEnabled || !shiftExportFormatRequiresPallets(format),` → `(format) => format !== undefined,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `are every format for a shift with pallets, the five without pallets for one without`.
- **K2** (открытые паллеты первыми): в `apps/standalone/src/office/exports/export-checks.ts` `return Number(left.closedAt === null) - Number(right.closedAt === null);` → `return Number(right.closedAt === null) - Number(left.closedAt === null);`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `are closed ones by their close and SSCC, open ones last, each with its boxes and refusal`.
- **K3** (открытый короб считается закрытым): в `apps/standalone/src/office/exports/export-checks.ts` `.filter((box) => box.closedAt !== null && box.sscc !== null && box.disassembledAt === null)` → `.filter((box) => box.disassembledAt === null)`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `count the codes, those in closed boxes, the closed boxes and the closed pallets`.
- **K4** (поздние данные не предупреждают): в `apps/standalone/src/office/exports/export-checks.ts` фрагмент

<!-- prettier-ignore -->
```ts
  if (rows.shift.lateDataAt !== null) {
    warnings.push({ kind: "late_data", at: rows.shift.lateDataAt });
  }
```

заменить на

(удалить)

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `warn of late data for every format, and of open and taken-apart pallets for the pallets formats`.

- **K5** (предупреждения о паллетах у любого формата): в `apps/standalone/src/office/exports/export-checks.ts` `if (!shiftExportFormatRequiresPallets(format)) return warnings;` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: PASS — эквивалентный мутант: снимок непаллетного формата не считает ни подавленных коробов, ни расформированных паллет; проверка формата — только экономия.
- **K6** (папка по UTC): в `apps/standalone/src/office/exports/export-checks.ts` фрагмент

<!-- prettier-ignore -->
```ts
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
```

заменить на

<!-- prettier-ignore -->
```ts
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone === "" ? timeZone : "UTC",
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `is the shift's number as a file name's segment and the moment in the organization's zone`.

- **K7** (номер смены без очистки): в `apps/standalone/src/office/exports/export-checks.ts` ``return ["Выгрузки", sanitizeShiftExportFilenameSegment(shiftNumber), `${stamp}_${formatId}`];`` → ``return ["Выгрузки", shiftNumber, `${stamp}_${formatId}`];``
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `is the shift's number as a file name's segment and the moment in the organization's zone`.
- **K8** (расформированная паллета — закрытая): в `apps/standalone/src/office/exports/export-checks.ts` `(pallet) => pallet.closedAt !== null && pallet.disassembledAt === null,` → `(pallet) => pallet.closedAt !== null,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `count the codes, those in closed boxes, the closed boxes and the closed pallets`.
- **K9** (12-часовой формат): в `apps/standalone/src/office/exports/export-checks.ts` `hourCycle: "h23",` → `hourCycle: "h12",`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-checks.test.ts`. Ожидается: FAIL — `is the shift's number as a file name's segment and the moment in the organization's zone`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/office/exports/export-checks.ts apps/standalone/test/export-checks.test.ts
git commit -m "feat(standalone): what the export dialog knows before it forms a file" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Файлы офиса в оболочке: `save_office_files` и `open_office_folder` без новых зависимостей

Выбор папки диалогом требует `tauri-plugin-dialog` — новой зависимости и шага владельца (П16), а `<a download>` в WebView2 не проверен (1e4b). Поэтому файлы пишет оболочка в фиксированное место: `document_dir()` из путей Tauri (`Документы`, с перенаправлением OneDrive), папка `Markiro`, первый сегмент из `ROOTS` (`Выгрузки` — этот план, `Формы` — план О-Ф). Байты идут base64, как этикетки в `print_bytes` (CSV начинается с BOM, его нельзя терять через `TextDecoder`). Все имена проверяются до записи (имя Windows: без `<>:"/\|?*`, управляющих символов, точки или пробела в конце, имён устройств; не длиннее 150 символов; имена файлов различны без учёта регистра); последний сегмент — новая папка (существующая получает « (2)»…« (99)»); файл создаётся `create_new`; сбой записи убирает созданную папку. Показ папки — `explorer.exe` (только Windows; Explorer отвечает 1 и при успехе, поэтому учитывается только запуск). В журнал процесса — код и вид ошибки ввода-вывода, без путей. Состояние `OfficeFilesState` управляет корнем: `run` даёт его из путей приложения через `manage_state`, тесты — временный каталог.

**Files:**

- Create: `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src/office/exports/office-files.ts`, `apps/standalone/src/office/exports/office-files-context.tsx`, `apps/standalone/test/office-files.test.ts`
- Modify: `apps/standalone/src-tauri/src/lib.rs` (модуль, две команды в `invoke_handler`, состояние в `manage_state`), `apps/standalone/src/office/Office.tsx` (свойство `files` и провайдер)
- Test: `apps/standalone/src-tauri/tests/ipc.rs`

**Interfaces:**

- Consumes: `bytesToBase64` (`src/hardware/hardware.ts`, план 2a4); `base64` оболочки; `tauri::Manager::path().document_dir()`.
- Produces: Rust — `markiro_standalone_lib::office_files::{ROOTS, APP_FOLDER, MAX_FILES, MAX_TOTAL_BYTES, MAX_NAME_CHARS, OfficeFilesError, OfficeFile, SavedFolder, OfficeFilesState, is_plain_name, write_into, save_files, existing_folder, save_office_files, open_office_folder}`; IPC — `save_office_files { segments: string[], files: [{ name, contentBase64 }] } → { segments, path, files }`, `open_office_folder { segments } → null`, отказы — голые коды `invalid_request`, `documents_unavailable`, `storage`, `unsupported`; вебвью — `OFFICE_FILES_CODES`, `OfficeFilesError`, `savedFolderSchema`, `type SavedFolder`, `interface OfficeFile { name; bytes }`, `interface OfficeFilesApi { save; open }`, `createTauriOfficeFiles(call?)`, `TAURI_OFFICE_FILES`, `OfficeFilesProvider`, `useOfficeFiles()`; `OfficeProps.files?: OfficeFilesApi`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/src-tauri/tests/ipc.rs` фрагмент

<!-- prettier-ignore -->
```rust
    LocalDbState, TableClass, FILE_NAME, MIGRATOR, TABLE_CLASSES,
};
use markiro_standalone_lib::lockdown::LockdownState;
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::scanner::{self, PortOpener, ScannerManager};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
```

заменить на

<!-- prettier-ignore -->
```rust
    LocalDbState, TableClass, FILE_NAME, MIGRATOR, TABLE_CLASSES,
};
use markiro_standalone_lib::lockdown::LockdownState;
use markiro_standalone_lib::office_files::OfficeFilesState;
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::scanner::{self, PortOpener, ScannerManager};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
```

2. В `apps/standalone/src-tauri/tests/ipc.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert!(app.try_state::<ScannerManager>().is_some());
    assert!(app.try_state::<LockdownState>().is_some());
    assert!(app.try_state::<SystemAwakeState>().is_some());
    // An unpaired app has no link yet; the receiver is the device's own.
    assert!(link.borrow().is_none());
    // Commands that read the managed states answer, instead of Tauri's refusal.
```

заменить на

<!-- prettier-ignore -->
```rust
    assert!(app.try_state::<ScannerManager>().is_some());
    assert!(app.try_state::<LockdownState>().is_some());
    assert!(app.try_state::<SystemAwakeState>().is_some());
    assert!(app.try_state::<OfficeFilesState>().is_some());
    // An unpaired app has no link yet; the receiver is the device's own.
    assert!(link.borrow().is_none());
    // Commands that read the managed states answer, instead of Tauri's refusal.
```

3. В `apps/standalone/src-tauri/tests/ipc.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(
        invoke(&webview, "set_system_awake", json!({ "awake": false })),
        Ok(Value::Null)
    );
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(
        invoke(&webview, "set_system_awake", json!({ "awake": false })),
        Ok(Value::Null)
    );
}

/// The shell with the office's folder at `files` (plan ЧЗ).
fn mock_app_saving_into(files: OfficeFilesState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(files)
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// `save_office_files` takes `segments` and `files` of `{ name,
/// contentBase64 }` (`src/office/exports/office-files.ts`) and answers the
/// folder as written; `open_office_folder` takes `segments`. Refusals are
/// bare codes; without a documents folder every call is
/// `documents_unavailable`.
#[test]
fn saving_office_files_answers_through_the_ipc_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app_saving_into(OfficeFilesState::at(dir.path().to_path_buf()));
    let segments = json!([
        "Выгрузки",
        "OCT26-004",
        "2026-10-08_18-30-00_shift_txt_flat"
    ]);
    let saved = invoke(
        &webview,
        "save_office_files",
        json!({
            "segments": segments,
            "files": [{ "name": "Молоко_1pcs_2026-10-08.txt", "contentBase64": "0JzQvtC70L7QutC+Cg==" }]
        }),
    )
    .unwrap();
    let folder = dir
        .path()
        .join("Выгрузки")
        .join("OCT26-004")
        .join("2026-10-08_18-30-00_shift_txt_flat");
    assert_eq!(
        saved,
        json!({
            "segments": segments,
            "path": folder.display().to_string(),
            "files": ["Молоко_1pcs_2026-10-08.txt"]
        })
    );
    assert_eq!(
        std::fs::read(folder.join("Молоко_1pcs_2026-10-08.txt")).unwrap(),
        "Молоко\n".as_bytes()
    );
    assert_eq!(
        invoke(
            &webview,
            "save_office_files",
            json!({ "segments": ["Выгрузки", "a/b"], "files": [{ "name": "a.txt", "contentBase64": "" }] }),
        ),
        Err(json!("invalid_request"))
    );
    assert_eq!(
        invoke(
            &webview,
            "open_office_folder",
            json!({ "segments": ["Выгрузки", "OCT26-004", "other"] }),
        ),
        Err(json!("invalid_request"))
    );
    if !cfg!(windows) {
        assert_eq!(
            invoke(
                &webview,
                "open_office_folder",
                json!({ "segments": segments })
            ),
            Err(json!("unsupported"))
        );
    }
    let (_app, unavailable) = mock_app_saving_into(OfficeFilesState::unavailable());
    assert_eq!(
        invoke(
            &unavailable,
            "save_office_files",
            json!({ "segments": segments, "files": [{ "name": "a.txt", "contentBase64": "" }] }),
        ),
        Err(json!("documents_unavailable"))
    );
    assert_eq!(
        invoke(
            &unavailable,
            "open_office_folder",
            json!({ "segments": segments })
        ),
        Err(json!("documents_unavailable"))
    );
}

```

4. Создать `apps/standalone/test/office-files.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import {
  createTauriOfficeFiles,
  OfficeFilesError,
  type OfficeFilesCode,
} from "../src/office/exports/office-files.js";

/** A shell that records each call and answers `answer`, or refuses with it. */
function shell(answer: unknown, refuse = false) {
  const calls: [string, Record<string, unknown>][] = [];
  const files = createTauriOfficeFiles(async (command, args) => {
    calls.push([command, args]);
    if (refuse) throw answer;
    return answer;
  });
  return { files, calls };
}

const SEGMENTS = ["Выгрузки", "OCT26-004", "2026-10-08_18-30-00_shift_csv_flat"];
const SAVED = {
  segments: SEGMENTS,
  path: "C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки\\OCT26-004\\2026-10-08_18-30-00_shift_csv_flat",
  files: ["Молоко_1pcs_2026-10-08.csv"],
};

describe("the office's files over the shell (plan ЧЗ)", () => {
  it("sends each file's bytes base64-encoded, the CSV's BOM and CRLF included, and reads the folder", async () => {
    const { files, calls } = shell(SAVED);
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x63, 0x0d, 0x0a, 0x1d);
    await expect(
      files.save(SEGMENTS, [{ name: "Молоко_1pcs_2026-10-08.csv", bytes }]),
    ).resolves.toEqual(SAVED);
    expect(calls).toEqual([
      [
        "save_office_files",
        {
          segments: SEGMENTS,
          files: [{ name: "Молоко_1pcs_2026-10-08.csv", contentBase64: "77u/Yw0KHQ==" }],
        },
      ],
    ]);
  });

  it("shows a folder by its segments", async () => {
    const { files, calls } = shell(null);
    await files.open(SEGMENTS);
    expect(calls).toEqual([["open_office_folder", { segments: SEGMENTS }]]);
  });

  it.each(["invalid_request", "documents_unavailable", "storage", "unsupported"] as const)(
    "turns the shell's %s into an error of that code",
    async (code: OfficeFilesCode) => {
      const save = shell(code, true).files.save(SEGMENTS, []);
      await expect(save).rejects.toBeInstanceOf(OfficeFilesError);
      await expect(save).rejects.toMatchObject({ code });
      await expect(shell(code, true).files.open(SEGMENTS)).rejects.toMatchObject({ code });
    },
  );

  it("reads anything else the shell refuses with, and an answer of another shape, as storage", async () => {
    await expect(
      shell("state not managed for field `state`", true).files.save(SEGMENTS, []),
    ).rejects.toMatchObject({ code: "storage" });
    await expect(shell({ ...SAVED, extra: 1 }).files.save(SEGMENTS, [])).rejects.toMatchObject({
      code: "storage",
    });
  });
});
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test ipc -- saving_office_files the_app_manages_every_state`

Expected: FAIL при сборке: «error[E0432]: unresolved import `markiro_standalone_lib::office_files`».

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office-files.test.ts`

Expected: FAIL: `Failed to resolve import "../src/office/exports/office-files.js"`, `Tests  no tests`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src-tauri/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod host_probe;
pub mod local_db;
pub mod lockdown;
pub mod power;
pub mod printer;
pub mod scanner;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod host_probe;
pub mod local_db;
pub mod lockdown;
pub mod office_files;
pub mod power;
pub mod printer;
pub mod scanner;
```

2. В `apps/standalone/src-tauri/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        scanner::list_serial_ports,
        scanner::configure_scanners,
        scanner::get_scanner_connections,
        scanner::close_scanners
    ]
}

/// Manages every state the commands read: the device, the local database
/// (opened here, before the window shows; when it cannot open, the app still
/// starts and the local commands say so), the connection status, the scanner
/// manager (it needs the app's handle for its events), kiosk mode and the
/// awake lease. Returns the device's link, which the connection task watches.
/// `run`'s `setup` calls it, and `tests/ipc.rs` calls it on a mock app (the
/// mock builder does not run `setup`), so a state a command reads cannot go
/// missing here with only a compile to notice.
```

заменить на

<!-- prettier-ignore -->
```rust
        scanner::list_serial_ports,
        scanner::configure_scanners,
        scanner::get_scanner_connections,
        scanner::close_scanners,
        office_files::save_office_files,
        office_files::open_office_folder
    ]
}

/// Manages every state the commands read: the device, the local database
/// (opened here, before the window shows; when it cannot open, the app still
/// starts and the local commands say so), the connection status, the scanner
/// manager (it needs the app's handle for its events), kiosk mode, the
/// awake lease and the office's folder under the documents folder (plan ЧЗ).
/// Returns the device's link, which the connection task watches.
/// `run`'s `setup` calls it, and `tests/ipc.rs` calls it on a mock app (the
/// mock builder does not run `setup`), so a state a command reads cannot go
/// missing here with only a compile to notice.
```

3. В `apps/standalone/src-tauri/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    app.manage(scanner::manager(app.clone()));
    app.manage(lockdown::LockdownState::default());
    app.manage(power::SystemAwakeState::default());
    link
}

```

заменить на

<!-- prettier-ignore -->
```rust
    app.manage(scanner::manager(app.clone()));
    app.manage(lockdown::LockdownState::default());
    app.manage(power::SystemAwakeState::default());
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    link
}

```

4. Создать `apps/standalone/src-tauri/src/office_files.rs`:

<!-- prettier-ignore -->
```rust
//! Files the office saves on this computer (plan ЧЗ): the parts of an export
//! today, a form's HTML for plan О-Ф next. Everything goes under
//! `Документы\Markiro` (the system's documents folder, `document_dir`), in a
//! first folder of [`ROOTS`] and the segments the webview names: no file
//! dialog, so no plugin and no new dependency (pilot spec, question П16).
//! The last segment is a folder of its own for each call: one that exists
//! already gets « (2)», « (3)» and so on, so files are never written over
//! and an export never lands beside an older one's parts. Every name is
//! checked before anything is written, and a call that fails takes back
//! the folder it made. `open_office_folder` shows such a folder in Windows
//! Explorer. A failure is logged by its code and the I/O error's kind,
//! never by a path, which names the Windows user.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// The first folders under `Документы\Markiro` the office writes into:
/// exports (plan ЧЗ) and forms (plan О-Ф).
pub const ROOTS: [&str; 2] = ["Выгрузки", "Формы"];

/// The folder under the documents folder.
pub const APP_FOLDER: &str = "Markiro";

/// The most files one call writes, and their most bytes in all.
pub const MAX_FILES: usize = 100_000;
pub const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;

/// The longest name of a folder or a file, in characters.
pub const MAX_NAME_CHARS: usize = 150;

/// Why a call failed; the webview reads the bare code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeFilesError {
    /// A segment or a name that is no plain name, a root not in [`ROOTS`],
    /// two files of one name, no file, too many or too large, a payload that
    /// is no base64, or a folder to open that does not exist. Nothing was
    /// written.
    InvalidRequest,
    /// The system has no documents folder for this user.
    DocumentsUnavailable,
    /// Writing failed (a full disk, no access); what this call made is gone.
    Storage,
    /// Showing a folder needs Windows Explorer.
    Unsupported,
}

impl OfficeFilesError {
    pub fn code(self) -> &'static str {
        match self {
            OfficeFilesError::InvalidRequest => "invalid_request",
            OfficeFilesError::DocumentsUnavailable => "documents_unavailable",
            OfficeFilesError::Storage => "storage",
            OfficeFilesError::Unsupported => "unsupported",
        }
    }
}

/// One file: its name and its bytes, base64-encoded (Tauri's IPC is JSON).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeFile {
    pub name: String,
    pub content_base64: String,
}

/// Where the files went: the segments as written (the last one perhaps with
/// « (2)»), the folder's full path to show, and the names in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFolder {
    pub segments: Vec<String>,
    pub path: String,
    pub files: Vec<String>,
}

/// The office's folder on this computer: `Документы\Markiro`, or none when
/// the system has no documents folder. `run` manages it from the app's path
/// resolver; tests manage one of a temporary directory.
#[derive(Debug, Clone)]
pub struct OfficeFilesState {
    root: Option<PathBuf>,
}

impl OfficeFilesState {
    /// The office's folder inside `documents`.
    pub fn from_documents(documents: Option<PathBuf>) -> Self {
        Self {
            root: documents.map(|documents| documents.join(APP_FOLDER)),
        }
    }

    /// Exactly `root` (tests).
    pub fn at(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }

    /// No documents folder: every call is `documents_unavailable`.
    pub fn unavailable() -> Self {
        Self { root: None }
    }

    fn root(&self) -> Result<PathBuf, OfficeFilesError> {
        self.root
            .clone()
            .ok_or(OfficeFilesError::DocumentsUnavailable)
    }
}

/// A Windows name of one folder or file: not empty, at most
/// [`MAX_NAME_CHARS`] characters, no control character, none of `<>:"/\|?*`,
/// not `.` or `..`, not ending in a dot or a space, and no device name
/// (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with an
/// extension or without).
pub fn is_plain_name(name: &str) -> bool {
    let reserved = |stem: &str| {
        let upper = stem.to_ascii_uppercase();
        ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit()
                && upper.as_bytes()[3] != b'0')
    };
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !reserved(name.split('.').next().unwrap_or(name))
}

fn check_segments(segments: &[String]) -> Result<(), OfficeFilesError> {
    let first = segments.first().ok_or(OfficeFilesError::InvalidRequest)?;
    if segments.len() < 2
        || !ROOTS.contains(&first.as_str())
        || !segments.iter().all(|segment| is_plain_name(segment))
    {
        return Err(OfficeFilesError::InvalidRequest);
    }
    Ok(())
}

/// Every file decoded, checked before the disk is touched.
fn decode(files: &[OfficeFile]) -> Result<Vec<(String, Vec<u8>)>, OfficeFilesError> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(OfficeFilesError::InvalidRequest);
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        // Windows names differ only by case at most once in one folder.
        if !is_plain_name(&file.name) || !seen.insert(file.name.to_lowercase()) {
            return Err(OfficeFilesError::InvalidRequest);
        }
        let bytes = STANDARD
            .decode(&file.content_base64)
            .map_err(|_| OfficeFilesError::InvalidRequest)?;
        total = total.saturating_add(bytes.len());
        if total > MAX_TOTAL_BYTES {
            return Err(OfficeFilesError::InvalidRequest);
        }
        decoded.push((file.name.clone(), bytes));
    }
    Ok(decoded)
}

/// The folder of this call, made new: `last`, or `last (2)` … `last (99)`.
fn new_folder(parent: &Path, last: &str) -> Result<(String, PathBuf), OfficeFilesError> {
    for n in 1..=99u32 {
        let name = if n == 1 {
            last.to_owned()
        } else {
            format!("{last} ({n})")
        };
        let path = parent.join(&name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok((name, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                eprintln!("standalone: save_office_files storage: {:?}", error.kind());
                return Err(OfficeFilesError::Storage);
            }
        }
    }
    eprintln!("standalone: save_office_files storage: 99 folders of one name");
    Err(OfficeFilesError::Storage)
}

/// Writes every file into `folder`, which this call made; on a failure the
/// folder goes, with whatever was written into it.
pub fn write_into(folder: &Path, files: &[(String, Vec<u8>)]) -> Result<(), OfficeFilesError> {
    let written = files.iter().try_for_each(|(name, bytes)| {
        let mut file = File::create_new(folder.join(name))?;
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written {
        eprintln!("standalone: save_office_files storage: {:?}", error.kind());
        let _ = fs::remove_dir_all(folder);
        return Err(OfficeFilesError::Storage);
    }
    Ok(())
}

/// Saves `files` into a new folder `root/segments…` (see the module).
pub fn save_files(
    root: &Path,
    segments: &[String],
    files: &[OfficeFile],
) -> Result<SavedFolder, OfficeFilesError> {
    check_segments(segments)?;
    let decoded = decode(files)?;
    let (last, parents) = segments
        .split_last()
        .ok_or(OfficeFilesError::InvalidRequest)?;
    let parent = parents
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    fs::create_dir_all(&parent).map_err(|error| {
        eprintln!("standalone: save_office_files storage: {:?}", error.kind());
        OfficeFilesError::Storage
    })?;
    let (name, folder) = new_folder(&parent, last)?;
    write_into(&folder, &decoded)?;
    let mut saved = parents.to_vec();
    saved.push(name);
    Ok(SavedFolder {
        segments: saved,
        path: folder.display().to_string(),
        files: decoded.into_iter().map(|(name, _)| name).collect(),
    })
}

/// The folder `root/segments…`, which must exist.
pub fn existing_folder(root: &Path, segments: &[String]) -> Result<PathBuf, OfficeFilesError> {
    check_segments(segments)?;
    let folder = segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    if folder.is_dir() {
        Ok(folder)
    } else {
        Err(OfficeFilesError::InvalidRequest)
    }
}

#[cfg(windows)]
fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    // Explorer answers 1 even when it opened the folder: only a failure to
    // start it counts.
    std::process::Command::new("explorer.exe")
        .arg(folder)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            eprintln!("standalone: open_office_folder storage: {:?}", error.kind());
            OfficeFilesError::Storage
        })
}

#[cfg(not(windows))]
fn show_in_explorer(_folder: &Path) -> Result<(), OfficeFilesError> {
    Err(OfficeFilesError::Unsupported)
}

/// Saves the office's files (see the module); off the IPC thread.
#[tauri::command]
pub async fn save_office_files(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
    files: Vec<OfficeFile>,
) -> Result<SavedFolder, String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    tauri::async_runtime::spawn_blocking(move || save_files(&root, &segments, &files))
        .await
        .map_err(|_| OfficeFilesError::Storage.code().to_owned())?
        .map_err(|error| error.code().to_owned())
}

/// Shows a folder `save_office_files` made in Windows Explorer.
#[tauri::command]
pub async fn open_office_folder(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
) -> Result<(), String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_folder(&root, &segments)
        .and_then(|folder| show_in_explorer(&folder))
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, bytes: &[u8]) -> OfficeFile {
        OfficeFile {
            name: name.to_owned(),
            content_base64: STANDARD.encode(bytes),
        }
    }

    fn segments(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// The CSV's BOM and CRLF, the TXT's LF and a Cyrillic name arrive byte
    /// for byte, in a new folder under the given segments.
    #[test]
    fn files_arrive_byte_for_byte_in_a_new_folder() {
        let root = tempfile::tempdir().unwrap();
        let csv = b"\xef\xbb\xbfcode\r\n0104600682000013215Ab\x1d93Zz\r\n";
        let txt = "Молоко\n".as_bytes();
        let saved = save_files(
            root.path(),
            &segments(&[
                "Выгрузки",
                "OCT26-004",
                "2026-10-08_18-30-00_shift_csv_flat",
            ]),
            &[
                file("Молоко_1pcs_2026-10-08.csv", csv),
                file("Молоко_1pcs_2026-10-08.txt", txt),
            ],
        )
        .unwrap();
        let folder = root
            .path()
            .join("Выгрузки")
            .join("OCT26-004")
            .join("2026-10-08_18-30-00_shift_csv_flat");
        assert_eq!(
            saved,
            SavedFolder {
                segments: segments(&[
                    "Выгрузки",
                    "OCT26-004",
                    "2026-10-08_18-30-00_shift_csv_flat"
                ]),
                path: folder.display().to_string(),
                files: vec![
                    "Молоко_1pcs_2026-10-08.csv".to_owned(),
                    "Молоко_1pcs_2026-10-08.txt".to_owned()
                ],
            }
        );
        assert_eq!(
            fs::read(folder.join("Молоко_1pcs_2026-10-08.csv")).unwrap(),
            csv
        );
        assert_eq!(
            fs::read(folder.join("Молоко_1pcs_2026-10-08.txt")).unwrap(),
            txt
        );
    }

    /// A folder that exists already is never written into: the next call
    /// gets « (2)», then « (3)», and the first folder keeps its file.
    #[test]
    fn an_existing_folder_is_never_written_into() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        let first = save_files(root.path(), &path, &[file("a.xml", b"first")]).unwrap();
        let second = save_files(root.path(), &path, &[file("a.xml", b"second")]).unwrap();
        let third = save_files(root.path(), &path, &[file("a.xml", b"third")]).unwrap();
        assert_eq!(first.segments[2], "run");
        assert_eq!(second.segments[2], "run (2)");
        assert_eq!(third.segments[2], "run (3)");
        let read = |folder: &str| {
            fs::read(
                root.path()
                    .join("Выгрузки")
                    .join("OCT26-004")
                    .join(folder)
                    .join("a.xml"),
            )
            .unwrap()
        };
        assert_eq!(read("run"), b"first");
        assert_eq!(read("run (2)"), b"second");
    }

    /// What is refused writes nothing at all: a root outside the list, a
    /// segment or a name that is no plain Windows name, two names that differ
    /// only by case, no file, a payload that is no base64.
    #[test]
    fn a_refused_call_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let ok = segments(&["Выгрузки", "OCT26-004", "run"]);
        let cases: Vec<(Vec<String>, Vec<OfficeFile>)> = vec![
            (segments(&["Документы", "run"]), vec![file("a.txt", b"x")]),
            (segments(&["Выгрузки"]), vec![file("a.txt", b"x")]),
            (
                segments(&["Выгрузки", "OCT26-004/S", "run"]),
                vec![file("a.txt", b"x")],
            ),
            (
                segments(&["Выгрузки", "..", "run"]),
                vec![file("a.txt", b"x")],
            ),
            (ok.clone(), vec![file("a.txt", b"x"), file("A.TXT", b"y")]),
            (ok.clone(), vec![file("con.txt", b"x")]),
            (ok.clone(), vec![file("a.txt ", b"x")]),
            (ok.clone(), vec![file("a\u{1d}.txt", b"x")]),
            (ok.clone(), vec![]),
            (
                ok.clone(),
                vec![OfficeFile {
                    name: "a.txt".to_owned(),
                    content_base64: "not base64!".to_owned(),
                }],
            ),
        ];
        for (path, files) in cases {
            assert_eq!(
                save_files(root.path(), &path, &files),
                Err(OfficeFilesError::InvalidRequest),
                "{path:?} {files:?}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn plain_names_are_what_windows_takes() {
        for name in [
            "OCT26-004",
            "Молоко_3_2_0_9_л_6pcs_2026-10-08.xml",
            "run (2)",
            "COM0",
            "CONSOLE.txt",
            "LPT10",
        ] {
            assert!(is_plain_name(name), "{name}");
        }
        for name in [
            "", ".", "..", "a.", "a ", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b",
            "a|b", "CON", "nul.xml", "com1", "LPT9.txt", "a\tb",
        ] {
            assert!(!is_plain_name(name), "{name:?}");
        }
        assert!(is_plain_name(&"я".repeat(MAX_NAME_CHARS)));
        assert!(!is_plain_name(&"я".repeat(MAX_NAME_CHARS + 1)));
    }

    /// A write that fails takes back the folder the call made, with the
    /// files written into it before the failure.
    #[test]
    fn a_failed_write_takes_back_its_folder() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("run");
        fs::create_dir(&folder).unwrap();
        // A directory where the second file must go: its create fails for
        // any user, root as well.
        fs::create_dir(folder.join("b.txt")).unwrap();
        assert_eq!(
            write_into(
                &folder,
                &[
                    ("a.txt".to_owned(), b"x".to_vec()),
                    ("b.txt".to_owned(), b"y".to_vec())
                ]
            ),
            Err(OfficeFilesError::Storage)
        );
        assert!(!folder.exists());
    }

    /// A folder to show must be one the office made; showing it needs Windows.
    #[test]
    fn only_an_existing_folder_of_the_office_is_shown() {
        let root = tempfile::tempdir().unwrap();
        let saved = save_files(
            root.path(),
            &segments(&["Выгрузки", "OCT26-004", "run"]),
            &[file("a.xml", b"x")],
        )
        .unwrap();
        assert!(existing_folder(root.path(), &saved.segments).is_ok());
        assert_eq!(
            existing_folder(root.path(), &segments(&["Выгрузки", "OCT26-004", "other"])),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(
            existing_folder(root.path(), &segments(&["Выгрузки", "..", "run"])),
            Err(OfficeFilesError::InvalidRequest)
        );
        if !cfg!(windows) {
            assert_eq!(
                show_in_explorer(root.path()),
                Err(OfficeFilesError::Unsupported)
            );
        }
    }
}
```

5. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
```

заменить на

<!-- prettier-ignore -->
```tsx

import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import { OfficeFilesProvider, TAURI_OFFICE_FILES } from "./exports/office-files-context.js";
import type { OfficeFilesApi } from "./exports/office-files.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
```

6. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
   */
  labels?: LabelRendering;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
```

заменить на

<!-- prettier-ignore -->
```tsx
   */
  labels?: LabelRendering;
  /**
   * Where the office saves its files (exports, plan ЧЗ): the shell's
   * commands by default; a test passes its own.
   */
  files?: OfficeFilesApi;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
```

7. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  hostRevision = null,
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
  windowMode = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
```

заменить на

<!-- prettier-ignore -->
```tsx
  hostRevision = null,
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
  files = TAURI_OFFICE_FILES,
  windowMode = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
```

8. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={officeLink}>
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <WindowModeProvider value={windowMode}>
                <RouterProvider router={router} />
              </WindowModeProvider>
            </LabelRenderingProvider>
          </ThisDeviceProvider>
        </OfficeLinkProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
        <OfficeLinkProvider value={officeLink}>
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <OfficeFilesProvider value={files}>
                <WindowModeProvider value={windowMode}>
                  <RouterProvider router={router} />
                </WindowModeProvider>
              </OfficeFilesProvider>
            </LabelRenderingProvider>
          </ThisDeviceProvider>
        </OfficeLinkProvider>
```

9. Создать `apps/standalone/src/office/exports/office-files-context.tsx`:

<!-- prettier-ignore -->
```tsx
import { createContext, useContext, type ReactNode } from "react";

import { createTauriOfficeFiles, type OfficeFilesApi } from "./office-files.js";

/** The shell's commands; a test passes its own through `Office`'s `files`. */
export const TAURI_OFFICE_FILES: OfficeFilesApi = createTauriOfficeFiles();

const OfficeFilesContext = createContext<OfficeFilesApi>(TAURI_OFFICE_FILES);

/** Gives the office below another way to save its files (tests). */
export function OfficeFilesProvider({
  value,
  children,
}: {
  value: OfficeFilesApi;
  children: ReactNode;
}) {
  return <OfficeFilesContext value={value}>{children}</OfficeFilesContext>;
}

/** Where the office saves its files. */
export function useOfficeFiles(): OfficeFilesApi {
  return useContext(OfficeFilesContext);
}
```

10. Создать `apps/standalone/src/office/exports/office-files.ts`:

<!-- prettier-ignore -->
```ts
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { bytesToBase64 } from "../../hardware/hardware.js";

/**
 * The shell's `save_office_files` and `open_office_folder`
 * (`src-tauri/src/office_files.rs`, plan ЧЗ): the office's files go into a
 * new folder under `Документы\Markiro\<segments…>`, the first segment one of
 * the shell's roots (`Выгрузки`, `Формы`); no file dialog.
 */

/** The codes the shell refuses with (`OfficeFilesError::code`). */
export const OFFICE_FILES_CODES = [
  "invalid_request",
  "documents_unavailable",
  "storage",
  "unsupported",
] as const;
export type OfficeFilesCode = (typeof OFFICE_FILES_CODES)[number];

export class OfficeFilesError extends Error {
  readonly code: OfficeFilesCode;

  constructor(code: OfficeFilesCode, message: string) {
    super(message);
    this.name = "OfficeFilesError";
    this.code = code;
  }
}

/** Where the files went: the segments as written (the last perhaps with « (2)»), the full path, the names. */
export const savedFolderSchema = z
  .object({ segments: z.array(z.string()), path: z.string(), files: z.array(z.string()) })
  .strict();
export type SavedFolder = z.infer<typeof savedFolderSchema>;

export interface OfficeFile {
  name: string;
  bytes: Uint8Array;
}

export interface OfficeFilesApi {
  /** Saves `files`, byte for byte, into a new folder `Документы\Markiro\<segments…>`. */
  save: (segments: readonly string[], files: readonly OfficeFile[]) => Promise<SavedFolder>;
  /** Shows a folder `save` made in Windows Explorer. */
  open: (segments: readonly string[]) => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Over Tauri's `invoke`. A refusal is an `OfficeFilesError` of the shell's
 * code; anything else the shell or Tauri answers is `storage`, its words
 * kept in the message for the console, never on screen.
 */
export function createTauriOfficeFiles(call: Invoke = invoke): OfficeFilesApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = OFFICE_FILES_CODES.find((candidate) => candidate === error);
      throw new OfficeFilesError(code ?? "storage", `${command}: ${String(error)}`);
    }
  }
  return {
    save: async (segments, files) => {
      const answer = await run("save_office_files", {
        segments: [...segments],
        files: files.map((file) => ({
          name: file.name,
          contentBase64: bytesToBase64(file.bytes),
        })),
      });
      const parsed = savedFolderSchema.safeParse(answer);
      if (!parsed.success) {
        throw new OfficeFilesError("storage", "save_office_files: an answer of another shape");
      }
      return parsed.data;
    },
    open: async (segments) => {
      await run("open_office_folder", { segments: [...segments] });
    },
  };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`

Expected: PASS: `test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 134 filtered out`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test ipc -- saving_office_files the_app_manages_every_state`

Expected: PASS: `test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 25 filtered out`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office-files.test.ts test/office.test.tsx`

Expected: PASS: `Tests  37 passed (37)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **S1** (существующая папка переиспользуется): в `apps/standalone/src-tauri/src/office_files.rs` `Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,` → `Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok((name, path)),`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::an_existing_folder_is_never_written_into`.
- **S2** (сбой записи оставляет папку): в `apps/standalone/src-tauri/src/office_files.rs` `let _ = fs::remove_dir_all(folder);` → (удалить строку)
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::a_failed_write_takes_back_its_folder`.
- **S3** (любой корень): в `apps/standalone/src-tauri/src/office_files.rs` `|| !ROOTS.contains(&first.as_str())` → (удалить строку)
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::a_refused_call_writes_nothing`.
- **S4** (имя устройства с расширением разрешено): в `apps/standalone/src-tauri/src/office_files.rs` `&& !reserved(name.split('.').next().unwrap_or(name))` → `&& !reserved(name)`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::a_refused_call_writes_nothing`, `office_files::tests::plain_names_are_what_windows_takes`.
- **S5** (имена файлов с учётом регистра): в `apps/standalone/src-tauri/src/office_files.rs` `!seen.insert(file.name.to_lowercase())` → `!seen.insert(file.name.clone())`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::a_refused_call_writes_nothing`.
- **S6** (имя на символ длиннее): в `apps/standalone/src-tauri/src/office_files.rs` `&& name.chars().count() <= MAX_NAME_CHARS` → `&& name.chars().count() <= MAX_NAME_CHARS + 1`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::plain_names_are_what_windows_takes`.
- **S7** (`File::create` вместо `create_new`): в `apps/standalone/src-tauri/src/office_files.rs` `let mut file = File::create_new(folder.join(name))?;` → `let mut file = File::create(folder.join(name))?;`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: PASS — эквивалентный мутант: папка создана этим же вызовом, имена проверены различными: перезаписывать нечего; `create_new` — защита на будущее.
- **S8** (пробел в конце имени): в `apps/standalone/src-tauri/src/office_files.rs` `&& !name.ends_with(' ')` → (удалить строку)
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::a_refused_call_writes_nothing`, `office_files::tests::plain_names_are_what_windows_takes`.
- **W1** (байты как текст): в `apps/standalone/src/office/exports/office-files.ts` `contentBase64: bytesToBase64(file.bytes),` → `contentBase64: btoa(new TextDecoder().decode(file.bytes)),`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office-files.test.ts`. Ожидается: FAIL — `sends each file's bytes base64-encoded, the CSV's BOM and CRLF included, and reads the folder`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/src/office_files.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/office/Office.tsx apps/standalone/src/office/exports/office-files-context.tsx apps/standalone/src/office/exports/office-files.ts apps/standalone/test/office-files.test.ts
git commit -m "feat(standalone): the shell saves the office's files into a new folder under Documents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: «Выгрузка» в «Сменах»: диалог, формирование, сохранение и запись в журнал

Кнопка «Выгрузка» есть у активной и закрытой смены у всех ролей (Ч4); столбец действий теперь у всех ролей, кнопки планирования — по-прежнему по `planShifts`. Диалог читает строки выгрузки и профиль организации (часовой пояс папки), показывает итоги, предупреждения, форматы с причинами отказа (отказавший формат выбрать нельзя), «Разделить на части» с лимитом строк, паллеты смены с «XML паллеты». «Сформировать и сохранить» **заново читает строки** (облако читает источник в момент задания), строит файлы `runExport`, сохраняет их через `useOfficeFiles().save` и только после этого пишет запись `shift.export` (Ч5). Отказ домена — его словами, ничего не сохранено и не записано; сбой сохранения — словами оболочки, ничего не записано; хост не принял запись — предупреждение с «Записать снова» той же записью, файлы остаются. Пока выгрузка идёт, диалог не закрывается и вторую не начинает. Три теста плана 2a3 говорили «у закрытой смены нет действий» — они меняются на «у закрытой только выгрузка».

**Files:**

- Create: `apps/standalone/src/office/exports/ExportDialog.tsx`, `apps/standalone/test/export-dialog.test.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/office/office-query.ts` (`officeKeys.shiftExportSource`), `apps/standalone/src/i18n/ru.json` (`office.shifts.export`, `exportNamed`, раздел `office.exports`)
- Test: `apps/standalone/test/shift-edit.test.tsx`, `apps/standalone/test/shift-delete-close.test.tsx`

**Interfaces:**

- Consumes: всё из задач 1, 3, 5, 6, 7: `HostApi.getShiftExportSource`, `HostApi.recordShiftExport`, `shiftExportRecord`, `runExport`, `formatOffers`, `palletOffers`, `exportCounts`, `exportWarnings`, `exportFolder`, `useOfficeFiles`, `OfficeFilesError`; `useOfficeQuery`, `useOfficeMutation`, `errorMessageKey`, `civilDateLabel`.
- Produces: `ExportDialog({ shift, onClose })` (О-Ф переносит его в карточку); `officeKeys.shiftExportSource(id)`; ключи i18n `office.exports.*` (тексты отказов — облачные `pages.shifts.exports.errors`, где «профиль» — страница «Профиль организации»).

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/export-dialog.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  shiftExportRowsSchema,
  type OfficeShift,
  type ShiftExportRows,
} from "../src/host/protocol.js";
import {
  OfficeFilesError,
  type OfficeFilesApi,
  type SavedFolder,
} from "../src/office/exports/office-files.js";
import { runExport } from "../src/office/exports/run-export.js";
import { renderOffice, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import { ACTIVE, freezeToday, PALLET, shiftsSession } from "./support/shifts.js";

const testModuleUrl = import.meta.url;
const TOKEN = "office-session-token";
const DOCUMENT = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
/** `freezeToday`'s instant: the moment every export of these tests is formed. */
const FORMED_AT = "2026-10-09T09:00:00.000Z";
const PALLET_ID = "a0000000-0000-4000-8000-000000000001";
const HASH_C = "a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";

/** `shift-export-rows.json`: OCT26-004 closed, pallet 1 (box 1, two codes) closed, box 2 (one code) on no pallet. */
function rows(): ShiftExportRows {
  return shiftExportRowsSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-export-rows.json", testModuleUrl), "utf8"),
    ),
  );
}

/** The list's record of the same shift, closed and with pallets. */
const CLOSED_PALLETS: OfficeShift = {
  ...ACTIVE,
  status: "closed",
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
  closedAt: "2026-10-08T14:00:07Z",
};

/** A shell that saves into `C:\Users\Оператор\Documents\Markiro\<segments>` and opens it. */
function fakeFiles(): OfficeFilesApi & {
  save: ReturnType<typeof vi.fn<OfficeFilesApi["save"]>>;
  open: ReturnType<typeof vi.fn<OfficeFilesApi["open"]>>;
} {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
      segments: [...segments],
      path: `C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}`,
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
  };
}

/** The office on «Смены» with `shift` listed and `source` as its export source. */
async function openExport(
  shift: OfficeShift,
  source: ShiftExportRows,
  files: OfficeFilesApi,
  user?: typeof TECHNOLOGIST,
): Promise<FakeOfficeSession> {
  const session = shiftsSession([shift], user);
  session.api.getShiftExportSource.mockResolvedValue(source);
  session.api.recordShiftExport.mockResolvedValue(undefined);
  renderOffice(session, { files });
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  fireEvent.click(await screen.findByRole("button", { name: `Выгрузка смены ${shift.number}` }));
  await screen.findByRole("dialog", { name: `Выгрузка смены ${shift.number}` });
  await screen.findByRole("radiogroup");
  return session;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function form(): void {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Сформировать и сохранить" }));
}

/** What the domain renders for this run: the files the dialog must save, byte for byte. */
function expectedParts(
  source: ShiftExportRows,
  run: {
    formatId: string;
    formatVersion: number;
    maxLines: number | null;
    palletId: string | null;
  },
) {
  const result = runExport(source, { ...run, documentId: DOCUMENT, formedAt: FORMED_AT });
  if (!result.ok) throw new Error(result.failure);
  return result.parts.map((part) => ({ name: part.filename, bytes: part.bytes }));
}

describe("office shifts: an export (plan ЧЗ)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DOCUMENT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forms the chosen format of fresh rows, saves the domain's bytes into the export's own folder, then records it, for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const files = fakeFiles();
      const session = await openExport(CLOSED_PALLETS, rows(), files, user);
      expect(
        within(dialog()).getByText("Молоко 3,2% 0,9 л, дата производства 08.10.2026."),
      ).toBeTruthy();
      expect(
        within(dialog()).getByText(
          "Кодов в смене: 3, из них в закрытых коробах: 3. Закрытых коробов: 2, закрытых паллет: 1.",
        ),
      ).toBeTruthy();
      fireEvent.click(
        within(dialog()).getByRole("radio", { name: "[XML][ГИСМТ] Паллетная агрегация" }),
      );
      form();
      await within(dialog()).findByText(
        "Сохранено файлов: 1. Папка: C:\\Users\\Оператор\\Documents\\Markiro\\Выгрузки\\OCT26-004\\2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets",
      );
      expect(files.save.mock.calls).toEqual([
        [
          ["Выгрузки", "OCT26-004", "2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets"],
          expectedParts(rows(), {
            formatId: "shift_xml_gismt_aggregation_pallets",
            formatVersion: 1,
            maxLines: null,
            palletId: null,
          }),
        ],
      ]);
      // The rows are read again when the user forms the file, before saving.
      expect(session.api.getShiftExportSource).toHaveBeenCalledTimes(2);
      expect(session.api.getShiftExportSource).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id);
      const [readAgain] = session.api.getShiftExportSource.mock.invocationCallOrder.slice(-1);
      const [saved] = files.save.mock.invocationCallOrder;
      const [recorded] = session.api.recordShiftExport.mock.invocationCallOrder;
      expect(readAgain !== undefined && saved !== undefined && readAgain < saved).toBe(true);
      expect(saved !== undefined && recorded !== undefined && saved < recorded).toBe(true);
      expect(session.api.recordShiftExport.mock.calls).toEqual([
        [
          TOKEN,
          ACTIVE.id,
          {
            formatId: "shift_xml_gismt_aggregation_pallets",
            formatVersion: 1,
            maxLines: null,
            palletId: null,
            documentId: DOCUMENT,
            partCount: 1,
            codeCount: 3,
            boxCount: 2,
            palletCount: 1,
            openPalletSuppressedBoxCount: 0,
          },
        ],
      ]);
      fireEvent.click(within(dialog()).getByRole("button", { name: "Открыть папку" }));
      await waitFor(() =>
        expect(files.open).toHaveBeenCalledWith([
          "Выгрузки",
          "OCT26-004",
          "2026-10-09_12-00-00_shift_xml_gismt_aggregation_pallets",
        ]),
      );
      fireEvent.click(
        within(dialog()).getAllByRole("button", { name: "Закрыть" })[1] as HTMLElement,
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      document.body.innerHTML = "";
    }
  });

  it("offers each format with its refusal and splits a format the source allows into parts", async () => {
    const source = rows();
    // Code C in the open box 3: no box format can cover it.
    source.items = source.items.map((item) =>
      item.codeHash === HASH_C ? { ...item, boxId: "b0000000-0000-4000-8000-000000000003" } : item,
    );
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, source, files);
    // Each radio is named by its label: the format, then a refused one's reason.
    expect(
      within(dialog())
        .getAllByRole("radio")
        .map((radio) => ({
          label: document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent,
          disabled: radio.hasAttribute("disabled"),
        })),
    ).toEqual([
      { label: "[TXT][Без коробов] Отчет смены", disabled: false },
      {
        label: "[TXT][С коробами] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      { label: "[CSV][Без коробов] Отчет смены", disabled: false },
      {
        label: "[CSV][С коробами] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[XML][ГИСМТ] Отчет об агрегацииНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[TXT][Паллеты] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label: "[CSV][Паллеты] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[XML][ГИСМТ] Паллетная агрегацияНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[TXT][Паллеты → короба] Отчет сменыНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
      {
        label:
          "[XML][ГИСМТ] Агрегация паллет без кодовНе все коды смены распределены по закрытым коробам.",
        disabled: true,
      },
    ]);
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "[TXT][Без коробов] Отчет смены" }),
    );
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Разделить на части" }));
    const limit = within(dialog()).getByLabelText("Строк в части, не больше");
    fireEvent.change(limit, { target: { value: "1" } });
    expect(within(dialog()).getByText("Введите целое число от 2 до 1 000 000")).toBeTruthy();
    expect(
      within(dialog())
        .getByRole("button", { name: "Сформировать и сохранить" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(limit, { target: { value: "2" } });
    form();
    await within(dialog()).findByText(/^Сохранено файлов: 2\./);
    expect(files.save.mock.calls[0]?.[1]).toEqual(
      expectedParts(source, {
        formatId: "shift_txt_flat",
        formatVersion: 1,
        maxLines: 2,
        palletId: null,
      }),
    );
    expect(session.api.recordShiftExport.mock.calls[0]?.[2]).toMatchObject({
      formatId: "shift_txt_flat",
      maxLines: 2,
      partCount: 2,
      codeCount: 3,
      boxCount: 0,
    });
  });

  it("says the domain's refusal while forming, and saves and records nothing", async () => {
    const source = rows();
    source.organization.inn = "770123456789";
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, source, files);
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "[XML][ГИСМТ] Отчет об агрегации" }),
    );
    form();
    await within(dialog()).findByText(
      "ИНН организации должен состоять из 10 цифр — Честный знак принимает такой отчет только от юридического лица.",
    );
    expect(files.save).not.toHaveBeenCalled();
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says why the files were not saved, and records nothing", async () => {
    const files = fakeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no documents"));
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await within(dialog()).findByText(
      "На этом компьютере не найдена папка «Документы». Файлы не сохранены.",
    );
    expect(session.api.recordShiftExport).not.toHaveBeenCalled();
  });

  it("says a record the host did not take, keeps the saved files and writes the same record again", async () => {
    const files = fakeFiles();
    const session = await openExport(CLOSED_PALLETS, rows(), files);
    session.api.recordShiftExport
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce(undefined);
    form();
    await within(dialog()).findByText(
      "Файлы сохранены, но запись в журнал действий не удалась. Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(within(dialog()).getByText(/^Сохранено файлов: 1\./)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Записать снова" }));
    await waitFor(() =>
      expect(within(dialog()).queryByText(/запись в журнал действий не удалась/)).toBeNull(),
    );
    const [first, second] = session.api.recordShiftExport.mock.calls;
    expect(second).toEqual(first);
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("forms one pallet's ЧЗ document of a shift still active; its shift formats wait for the close", async () => {
    const source = rows();
    source.shift.status = "active";
    const files = fakeFiles();
    const session = await openExport(
      { ...CLOSED_PALLETS, status: "active", closedAt: null },
      source,
      files,
    );
    expect(
      within(dialog())
        .getAllByRole("radio")
        .every((radio) => radio.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      within(dialog())
        .getByRole("button", { name: "Сформировать и сохранить" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "XML паллеты 146006820000000409" }),
    );
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
    expect(files.save.mock.calls).toEqual([
      [
        ["Выгрузки", "OCT26-004", "2026-10-09_12-00-00_pallet_xml_gismt_aggregation"],
        expectedParts(source, {
          formatId: "pallet_xml_gismt_aggregation",
          formatVersion: 1,
          maxLines: null,
          palletId: PALLET_ID,
        }),
      ],
    ]);
    expect(session.api.recordShiftExport.mock.calls[0]?.[2]).toEqual({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      maxLines: null,
      palletId: PALLET_ID,
      documentId: DOCUMENT,
      partCount: 1,
      codeCount: 0,
      boxCount: 1,
      palletCount: 1,
      openPalletSuppressedBoxCount: 0,
    });
  });

  it("warns of late data and of boxes on a pallet still open, and a pallet still open has no document", async () => {
    const source = rows();
    source.shift.lateDataAt = "2026-10-08T16:00:00Z";
    source.pallets.push({
      id: "a0000000-0000-4000-8000-000000000002",
      sscc: null,
      openedAt: "2026-10-08T06:07:15.902Z",
      closedAt: null,
      disassembledAt: null,
    });
    const box2 = source.boxes[1];
    if (box2 === undefined) throw new Error("the fixture has box 2");
    box2.palletId = "a0000000-0000-4000-8000-000000000002";
    await openExport(CLOSED_PALLETS, source, fakeFiles());
    fireEvent.click(within(dialog()).getByRole("radio", { name: "[TXT][Паллеты] Отчет смены" }));
    expect(
      within(dialog()).getByText(
        "После закрытия смены пришли данные (08.10.2026, 19:00:00): выгрузка их содержит, а выгрузка, сделанная до этого, устарела.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Коробов на незакрытых паллетах: 1. Они выгружены без паллеты; когда паллета закроется, выгрузите смену снова.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByText("Паллета не закрыта, коробов: 1")).toBeTruthy();
    expect(
      within(dialog()).getByRole("button", { name: "XML паллеты —" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("closes on nothing and starts nothing else while an export runs", async () => {
    const files = fakeFiles();
    let finish: (saved: SavedFolder) => void = () => undefined;
    files.save.mockImplementation(
      () =>
        new Promise<SavedFolder>((resolve) => {
          finish = resolve;
        }),
    );
    await openExport(CLOSED_PALLETS, rows(), files);
    form();
    await waitFor(() => expect(files.save).toHaveBeenCalledTimes(1));
    const [cancel] = within(dialog()).getAllByRole("button", { name: "Закрыть" }).slice(1);
    expect(cancel?.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    form();
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "XML паллеты 146006820000000409" }),
    );
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish({ segments: ["Выгрузки", "OCT26-004", "x"], path: "C:\\x", files: ["a.txt"] });
    await within(dialog()).findByText(/^Сохранено файлов: 1\./);
  });
});
```

2. В `apps/standalone/test/shift-delete-close.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Удалить смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-004")).queryByRole("button", { name: /Удалить/ })).toBeNull();
      expect(within(shiftRow("OCT26-001/S")).queryAllByRole("button")).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-005" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "Удалить смену OCT26-005?" })).getByRole(
```

заменить на

<!-- prettier-ignore -->
```tsx
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Удалить смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-004")).queryByRole("button", { name: /Удалить/ })).toBeNull();
      // A closed shift only exports (plan ЧЗ).
      expect(
        within(shiftRow("OCT26-001/S"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Выгрузка смены OCT26-001/S"]);
      fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-005" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "Удалить смену OCT26-005?" })).getByRole(
```

3. В `apps/standalone/test/shift-delete-close.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Закрыть смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-005")).queryByRole("button", { name: /Закрыть/ })).toBeNull();
      expect(within(shiftRow("OCT26-001/S")).queryAllByRole("button")).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
      await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
      giveReason("Станция сломалась");
```

заменить на

<!-- prettier-ignore -->
```tsx
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Закрыть смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-005")).queryByRole("button", { name: /Закрыть/ })).toBeNull();
      // A closed shift only exports (plan ЧЗ).
      expect(
        within(shiftRow("OCT26-001/S"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Выгрузка смены OCT26-001/S"]);
      fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
      await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
      giveReason("Станция сломалась");
```

4. В `apps/standalone/test/shift-edit.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Изменить план смены OCT26-004", "Закрыть смену OCT26-004"]);
      expect(within(shiftRow(CLOSED.number)).queryAllByRole("button")).toEqual([]);
      view.unmount();
    }
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual([
        "Изменить план смены OCT26-004",
        "Закрыть смену OCT26-004",
        "Выгрузка смены OCT26-004",
      ]);
      // A closed shift only exports (plan ЧЗ).
      expect(
        within(shiftRow(CLOSED.number))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Выгрузка смены OCT26-001/S"]);
      view.unmount();
    }
  });
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx test/shift-edit.test.tsx test/shift-delete-close.test.tsx`

Expected: FAIL: `Tests  11 failed | 83 passed (94)` — все 8 тестов диалога (`Unable to find role="button" and name "Выгрузка смены OCT26-004"`) и три теста плана 2a3 о действиях закрытой смены.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "deleteNamed": "Удалить смену {{number}}",
      "close": "Закрыть",
      "closeNamed": "Закрыть смену {{number}}",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
```

заменить на

<!-- prettier-ignore -->
```json
      "deleteNamed": "Удалить смену {{number}}",
      "close": "Закрыть",
      "closeNamed": "Закрыть смену {{number}}",
      "export": "Выгрузка",
      "exportNamed": "Выгрузка смены {{number}}",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
```

2. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
        "nowClosed": "Смена уже закрыта. Список смен обновлён.",
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
      }
    },
    "operators": {
```

заменить на

<!-- prettier-ignore -->
```json
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
        "nowClosed": "Смена уже закрыта. Список смен обновлён.",
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
      }
    },
    "exports": {
      "title": "Выгрузка смены {{number}}",
      "summary": "{{product}}, дата производства {{date}}.",
      "counts": "Кодов в смене: {{codes}}, из них в закрытых коробах: {{inClosedBoxes}}. Закрытых коробов: {{boxes}}, закрытых паллет: {{pallets}}.",
      "formats": "Формат",
      "split": "Разделить на части",
      "lineLimit": "Строк в части, не больше",
      "lineLimitError": "Введите целое число от 2 до 1 000 000",
      "folderHint": "Файлы сохраняются в папку «Документы\\Markiro\\Выгрузки» этого компьютера, в новую папку для каждой выгрузки.",
      "submit": "Сформировать и сохранить",
      "pallets": "Паллеты смены: документ для Честного знака на одну паллету",
      "palletRow": "Паллета {{sscc}}, коробов: {{boxes}}",
      "palletOpen": "Паллета не закрыта, коробов: {{boxes}}",
      "palletExport": "XML паллеты",
      "palletExportNamed": "XML паллеты {{sscc}}",
      "saved": "Сохранено файлов: {{count}}. Папка: {{path}}",
      "openFolder": "Открыть папку",
      "recordFailed": "Файлы сохранены, но запись в журнал действий не удалась. {{reason}}",
      "recordAgain": "Записать снова",
      "warnings": {
        "late_data": "После закрытия смены пришли данные ({{at}}): выгрузка их содержит, а выгрузка, сделанная до этого, устарела.",
        "open_pallets": "Коробов на незакрытых паллетах: {{count}}. Они выгружены без паллеты; когда паллета закроется, выгрузите смену снова.",
        "disassembled_pallets": "Расформированных паллет в документе: {{count}}. Облачная выгрузка их тоже пишет; проверьте, нужно ли загружать такой документ в Честный знак."
      },
      "failures": {
        "SHIFT_NOT_CLOSED": "Смена должна быть закрыта перед формированием отчета.",
        "SHIFT_HAS_NO_CODES": "В смене нет кодов для отчета.",
        "BOX_COVERAGE_INCOMPLETE": "Не все коды смены распределены по закрытым коробам.",
        "SHIFT_HAS_NO_PALLETS": "В смене нет закрытых паллет: коробы не ставились на паллеты либо ни одна паллета ещё не закрыта.",
        "PALLET_NOT_CLOSED": "Паллета ещё не закрыта — отчёт формируется только по закрытой паллете.",
        "PALLET_DISASSEMBLED": "Паллета разобрана — отчёт по ней больше не формируется.",
        "ORG_INN_MISSING": "Укажите ИНН организации на странице «Профиль организации»: без него документ для Честного знака не формируется.",
        "ORG_NAME_MISSING": "Укажите название организации на странице «Профиль организации»: Честный знак требует его в документе.",
        "INVALID_ORG_INN": "ИНН организации должен состоять из 10 цифр — Честный знак принимает такой отчет только от юридического лица.",
        "FORMAT_NOT_FOUND": "Выбранный формат отчета недоступен.",
        "INVALID_LINE_LIMIT": "Недопустимое ограничение строк в части.",
        "BOX_EXCEEDS_LINE_LIMIT": "Короб не помещается в установленное ограничение строк.",
        "PALLET_EXCEEDS_LINE_LIMIT": "Паллета вместе со своими коробами не помещается в установленное ограничение строк.",
        "INVALID_BOX_SSCC": "У одного из коробов некорректный SSCC — отчет сформировать нельзя.",
        "INVALID_CIS": "В смене есть код маркировки, который не удалось разобрать для отчета.",
        "GENERATION_FAILED": "Не удалось сформировать отчет. Повторите попытку."
      },
      "files": {
        "invalid_request": "Приложение сформировало недопустимые имена файлов. Файлы не сохранены.",
        "documents_unavailable": "На этом компьютере не найдена папка «Документы». Файлы не сохранены.",
        "storage": "Не удалось записать файлы: проверьте место на диске и доступ к папке «Документы». Файлы не сохранены.",
        "unsupported": "Открыть папку можно только в Windows."
      }
    },
    "operators": {
```

3. Создать `apps/standalone/src/office/exports/ExportDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Modal, RadioGroup } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { OfficeShift, ShiftExportRecord } from "../../host/protocol.js";
import { shiftExportRecord } from "../../host/requests.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import {
  exportCounts,
  exportFolder,
  exportWarnings,
  formatOffers,
  palletOffers,
  type ExportWarning,
} from "./export-checks.js";
import { OfficeFilesError, type SavedFolder } from "./office-files.js";
import { useOfficeFiles } from "./office-files-context.js";
import { runExport } from "./run-export.js";

const MIN_LINES = 2;
const MAX_LINES = 1_000_000;
/** The cloud's default lines a part (`ShiftExportsDialog`). */
const DEFAULT_LINES = "2000";

/** A whole number of lines in 2–1 000 000, as the domain takes it; `null` otherwise. */
function parseLineLimit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= MIN_LINES && parsed <= MAX_LINES ? parsed : null;
}

const formatKey = (format: { id: string; version: number }) => `${format.id}@${format.version}`;

type Outcome =
  | { kind: "failed"; message: string }
  | {
      kind: "saved";
      saved: SavedFolder;
      /** The record the host has not taken, with why; `null` once it is written. */
      unrecorded: { record: ShiftExportRecord; message: string } | null;
    };

export interface ExportDialogProps {
  /** An active or closed shift. */
  shift: OfficeShift;
  onClose: () => void;
}

/**
 * «Выгрузка» of a shift (plan ЧЗ): the cloud's formats with what the source
 * would refuse now, the line limit, the warnings, and the pallets of the
 * shift for a ЧЗ document each. Forming reads the host's rows again, renders
 * with `@markiro/domain` exactly as the cloud does (`runExport`), saves the
 * parts into a new folder under «Документы\Markiro\Выгрузки» and only then
 * records the export in the host's audit trail; a record the host did not
 * take is said, with «Записать снова», and the saved files stay. While an
 * export runs nothing closes the dialog and nothing starts another.
 */
export function ExportDialog({ shift, onClose }: ExportDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const files = useOfficeFiles();
  const source = useOfficeQuery(officeKeys.shiftExportSource(shift.id), (api, token) =>
    api.getShiftExportSource(token, shift.id),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const reread = useOfficeMutation((api, token, id: string) => api.getShiftExportSource(token, id));
  const record = useOfficeMutation((api, token, body: ShiftExportRecord) =>
    api.recordShiftExport(token, shift.id, body),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [lineLimit, setLineLimit] = useState(DEFAULT_LINES);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  // What the dialog shows is of the rows on screen; a file is formed of fresh ones. Each is
  // derived once per answer (the warnings once per chosen format too), never per keystroke:
  // the offers alone take a snapshot of every format, which a shift of 50 000 codes feels.
  const rows = source.data;
  const offers = useMemo(
    () => (rows === undefined ? [] : formatOffers(rows, new Date().toISOString())),
    [rows],
  );
  const counts = useMemo(() => (rows === undefined ? null : exportCounts(rows)), [rows]);
  const pallets = useMemo(
    () => (rows === undefined || !rows.shift.palletsEnabled ? [] : palletOffers(rows)),
    [rows],
  );
  const firstAllowed = offers.find((offer) => offer.refusal === null);
  const selected =
    offers.find((offer) => formatKey(offer.format) === chosen && offer.refusal === null) ??
    firstAllowed;
  const warnings: ExportWarning[] = useMemo(
    () =>
      rows === undefined || selected === undefined
        ? []
        : exportWarnings(rows, selected.format, new Date().toISOString()),
    [rows, selected],
  );
  const maxLines = split ? parseLineLimit(lineLimit) : null;
  const lineLimitError =
    split && maxLines === null ? t("office.exports.lineLimitError") : undefined;

  const close = () => {
    if (!inFlight.current) onClose();
  };

  async function exportNow(
    format: { id: string; version: number },
    lines: number | null,
    palletId: string | null,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    setOpenFailure(null);
    try {
      // Formed of the host's rows of this moment, as the cloud reads its source when it runs.
      let fresh;
      try {
        fresh = await reread.mutateAsync(shift.id);
      } catch (error) {
        setOutcome({ kind: "failed", message: t(errorMessageKey(error)) });
        return;
      }
      const formedAt = new Date().toISOString();
      const documentId = crypto.randomUUID();
      const result = runExport(fresh, {
        formatId: format.id,
        formatVersion: format.version,
        maxLines: lines,
        palletId,
        documentId,
        formedAt,
      });
      if (!result.ok) {
        setOutcome({ kind: "failed", message: t(`office.exports.failures.${result.failure}`) });
        return;
      }
      const timeZone = org.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      let saved: SavedFolder;
      try {
        saved = await files.save(
          exportFolder(fresh.shift.number, format.id, formedAt, timeZone),
          result.parts.map((part) => ({ name: part.filename, bytes: part.bytes })),
        );
      } catch (error) {
        const code = error instanceof OfficeFilesError ? error.code : "storage";
        setOutcome({ kind: "failed", message: t(`office.exports.files.${code}`) });
        return;
      }
      const body = shiftExportRecord({
        formatId: format.id,
        formatVersion: format.version,
        maxLines: lines,
        palletId,
        documentId,
        parts: result.parts,
        openPalletSuppressedBoxCount: result.openPalletSuppressedBoxCount,
      });
      try {
        await record.mutateAsync(body);
        setOutcome({ kind: "saved", saved, unrecorded: null });
      } catch (error) {
        setOutcome({
          kind: "saved",
          saved,
          unrecorded: { record: body, message: t(errorMessageKey(error)) },
        });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function recordAgain(saved: SavedFolder, body: ShiftExportRecord): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await record.mutateAsync(body);
      setOutcome({ kind: "saved", saved, unrecorded: null });
    } catch (error) {
      setOutcome({
        kind: "saved",
        saved,
        unrecorded: { record: body, message: t(errorMessageKey(error)) },
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function openFolder(saved: SavedFolder): Promise<void> {
    setOpenFailure(null);
    try {
      await files.open(saved.segments);
    } catch (error) {
      const code = error instanceof OfficeFilesError ? error.code : "storage";
      setOpenFailure(t(`office.exports.files.${code}`));
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === undefined || lineLimitError !== undefined) return;
    void exportNow(selected.format, maxLines, null);
  };

  const warningText = (warning: ExportWarning): string => {
    switch (warning.kind) {
      case "late_data":
        return t("office.exports.warnings.late_data", {
          at: new Date(warning.at).toLocaleString("ru", {
            ...(org.data === undefined ? {} : { timeZone: org.data.timeZone }),
          }),
        });
      case "open_pallets":
        return t("office.exports.warnings.open_pallets", { count: warning.boxes });
      case "disassembled_pallets":
        return t("office.exports.warnings.disassembled_pallets", { count: warning.pallets });
    }
  };

  const content = () => {
    if (source.isPending) return <PageLoading />;
    if (source.isError || rows === undefined || counts === null) {
      return <LoadError error={source.error} onRetry={() => void source.refetch()} />;
    }
    return (
      <>
        <p>
          {t("office.exports.summary", {
            product: rows.shift.productName,
            date: civilDateLabel(rows.shift.productionDate),
          })}
        </p>
        <p className="office-note">
          {t("office.exports.counts", {
            codes: counts.codes,
            inClosedBoxes: counts.codesInClosedBoxes,
            boxes: counts.closedBoxes,
            pallets: counts.closedPallets,
          })}
        </p>
        {outcome?.kind === "failed" && <Alert tone="error">{outcome.message}</Alert>}
        {outcome?.kind === "saved" && (
          <Alert
            tone="ok"
            role="status"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void openFolder(outcome.saved)}
              >
                {t("office.exports.openFolder")}
              </Button>
            }
          >
            {t("office.exports.saved", {
              count: outcome.saved.files.length,
              path: outcome.saved.path,
            })}
          </Alert>
        )}
        {outcome?.kind === "saved" && outcome.unrecorded !== null && (
          <Alert
            tone="warn"
            action={
              <Button
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={() => {
                  if (outcome.unrecorded !== null) {
                    void recordAgain(outcome.saved, outcome.unrecorded.record);
                  }
                }}
              >
                {t("office.exports.recordAgain")}
              </Button>
            }
          >
            {t("office.exports.recordFailed", { reason: outcome.unrecorded.message })}
          </Alert>
        )}
        {openFailure !== null && <Alert tone="error">{openFailure}</Alert>}
        {warnings.map((warning) => (
          <Alert key={warning.kind} tone="warn">
            {warningText(warning)}
          </Alert>
        ))}
        <RadioGroup
          label={t("office.exports.formats")}
          name="shift-export-format"
          disabled={busy}
          value={selected === undefined ? "" : formatKey(selected.format)}
          onValueChange={setChosen}
          options={offers.map((offer) => ({
            value: formatKey(offer.format),
            disabled: offer.refusal !== null,
            label:
              offer.refusal === null ? (
                offer.format.label
              ) : (
                <span className="shift-cell">
                  <span>{offer.format.label}</span>
                  <span className="shift-cell__quiet">
                    {t(`office.exports.failures.${offer.refusal}`)}
                  </span>
                </span>
              ),
          }))}
        />
        <Checkbox
          label={t("office.exports.split")}
          checked={split}
          disabled={busy}
          onCheckedChange={setSplit}
        />
        {split && (
          <Input
            label={t("office.exports.lineLimit")}
            inputMode="numeric"
            value={lineLimit}
            disabled={busy}
            {...(lineLimitError === undefined ? {} : { error: lineLimitError })}
            onChange={(event) => setLineLimit(event.target.value)}
          />
        )}
        <p className="office-note">{t("office.exports.folderHint")}</p>
        {pallets.length > 0 && (
          <section aria-label={t("office.exports.pallets")}>
            <p>{t("office.exports.pallets")}</p>
            {pallets.map((pallet) => (
              <div key={pallet.palletId} className="shift-cell">
                <span>
                  {pallet.sscc === null
                    ? t("office.exports.palletOpen", { boxes: pallet.boxes })
                    : t("office.exports.palletRow", { sscc: pallet.sscc, boxes: pallet.boxes })}
                </span>
                {pallet.refusal !== null && (
                  <span className="shift-cell__quiet">
                    {t(`office.exports.failures.${pallet.refusal}`)}
                  </span>
                )}
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={busy || pallet.refusal !== null}
                  aria-label={t("office.exports.palletExportNamed", {
                    sscc: pallet.sscc ?? "—",
                  })}
                  onClick={() =>
                    void exportNow(
                      { id: "pallet_xml_gismt_aggregation", version: 1 },
                      null,
                      pallet.palletId,
                    )
                  }
                >
                  {t("office.exports.palletExport")}
                </Button>
              </div>
            ))}
          </section>
        )}
      </>
    );
  };

  return (
    <Modal
      open
      title={t("office.exports.title", { number: shift.number })}
      onClose={close}
      closeLabel={t("office.common.close")}
      width="min(760px, calc(100vw - 32px))"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {t("office.common.close")}
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={busy}
            disabled={selected === undefined || lineLimitError !== undefined || source.isPending}
          >
            {t("office.exports.submit")}
          </Button>
        </>
      }
    >
      <form id={formId} className="standalone-form" onSubmit={submit} noValidate>
        {content()}
      </form>
    </Modal>
  );
}
```

4. В `apps/standalone/src/office/office-query.ts` фрагмент

<!-- prettier-ignore -->
```ts
    period?.from ?? null,
    period?.to ?? null,
  ],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

заменить на

<!-- prettier-ignore -->
```ts
    period?.from ?? null,
    period?.to ?? null,
  ],
  /** What a shift's exports are built from (`GET /v1/office/shifts/{id}/export-source`, plan ЧЗ). */
  shiftExportSource: (id: string) => ["office", "shift-export-source", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

5. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { useCan } from "../access.js";
import { useTemplates } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useCan } from "../access.js";
import { useTemplates } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { ExportDialog } from "../exports/ExportDialog.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
```

6. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  | { kind: "edit"; shift: OfficeShift }
  | { kind: "plan"; shift: OfficeShift }
  | { kind: "delete"; shift: OfficeShift }
  | { kind: "close"; shift: OfficeShift };

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
```

заменить на

<!-- prettier-ignore -->
```tsx
  | { kind: "edit"; shift: OfficeShift }
  | { kind: "plan"; shift: OfficeShift }
  | { kind: "delete"; shift: OfficeShift }
  | { kind: "close"; shift: OfficeShift }
  | { kind: "export"; shift: OfficeShift };

/**
 * Shifts (stage 2a spec §5.6), in the section «Производство». The host sends
```

7. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    },
  ];

  if (canPlan) {
    columns.push({
      key: "actions",
      title: t("office.shifts.table.actions"),
      render: (shift) => (
        <RowActions>
          {shift.status === "planned" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.editNamed", { number: shift.number })}
                onClick={() => open({ kind: "edit", shift })}
              >
                {t("office.shifts.edit")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
                onClick={() => open({ kind: "delete", shift })}
              >
                {t("office.shifts.delete")}
              </Button>
            </>
          )}
          {shift.status === "active" && (
            <>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.planNamed", { number: shift.number })}
                onClick={() => open({ kind: "plan", shift })}
              >
                {t("office.shifts.plan")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shifts.closeNamed", { number: shift.number })}
                onClick={() => open({ kind: "close", shift })}
              >
                {t("office.shifts.close")}
              </Button>
            </>
          )}
        </RowActions>
      ),
    });
  }

  const content = () => {
    if (shifts.isPending) return <PageLoading />;
```

заменить на

<!-- prettier-ignore -->
```tsx
    },
  ];

  // Every role exports (the cloud's `OPERATIONS_READ`, plan ЧЗ); planning stays with `planShifts`.
  columns.push({
    key: "actions",
    title: t("office.shifts.table.actions"),
    render: (shift) => (
      <RowActions>
        {canPlan && shift.status === "planned" && (
          <>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.editNamed", { number: shift.number })}
              onClick={() => open({ kind: "edit", shift })}
            >
              {t("office.shifts.edit")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.deleteNamed", { number: shift.number })}
              onClick={() => open({ kind: "delete", shift })}
            >
              {t("office.shifts.delete")}
            </Button>
          </>
        )}
        {canPlan && shift.status === "active" && (
          <>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.planNamed", { number: shift.number })}
              onClick={() => open({ kind: "plan", shift })}
            >
              {t("office.shifts.plan")}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shifts.closeNamed", { number: shift.number })}
              onClick={() => open({ kind: "close", shift })}
            >
              {t("office.shifts.close")}
            </Button>
          </>
        )}
        {shift.status !== "planned" && (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.shifts.exportNamed", { number: shift.number })}
            onClick={() => open({ kind: "export", shift })}
          >
            {t("office.shifts.export")}
          </Button>
        )}
      </RowActions>
    ),
  });

  const content = () => {
    if (shifts.isPending) return <PageLoading />;
```

8. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          onOutdated={readAgain}
        />
      )}
      {canPlan && dialog?.kind === "plan" && (
        <ShiftPlanDialog
          shift={dialog.shift}
```

заменить на

<!-- prettier-ignore -->
```tsx
          onOutdated={readAgain}
        />
      )}
      {dialog?.kind === "export" && (
        <ExportDialog shift={dialog.shift} onClose={() => setDialog(null)} />
      )}
      {canPlan && dialog?.kind === "plan" && (
        <ShiftPlanDialog
          shift={dialog.shift}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`

Expected: PASS: `Tests  8 passed (8)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-edit.test.tsx`

Expected: PASS: `Tests  41 passed (41)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-delete-close.test.tsx`

Expected: PASS: `Tests  45 passed (45)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shifts-page.test.tsx`

Expected: PASS: `Tests  33 passed (33)` (эти три файла — тяжёлые наборы «Заметок»: под нагрузкой отказ на пределе 5 с повторить отдельным запуском).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **D2** (строки из кеша, без нового чтения): в `apps/standalone/src/office/exports/ExportDialog.tsx` `fresh = await reread.mutateAsync(shift.id);` → `fresh = source.data ?? (await reread.mutateAsync(shift.id));`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `forms the chosen format of fresh rows, saves the domain's bytes into the export's own folder, then records it, for both roles`.
- **D3** (сбой сохранения всё равно записывается): в `apps/standalone/src/office/exports/ExportDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        const code = error instanceof OfficeFilesError ? error.code : "storage";
        setOutcome({ kind: "failed", message: t(`office.exports.files.${code}`) });
        return;
      }
      const body
```

заменить на

<!-- prettier-ignore -->
```tsx
        const code = error instanceof OfficeFilesError ? error.code : "storage";
        setOutcome({ kind: "failed", message: t(`office.exports.files.${code}`) });
        await record.mutateAsync(shiftExportRecord({ formatId: format.id, formatVersion: format.version, maxLines: lines, palletId, documentId, parts: result.parts, openPalletSuppressedBoxCount: 0 })).catch(() => undefined);
        return;
      }
      const body
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `says why the files were not saved, and records nothing`.

- **D6** (диалог закрывается во время выгрузки): в `apps/standalone/src/office/exports/ExportDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const close = () => {
    if (!inFlight.current) onClose();
  };
```

заменить на

<!-- prettier-ignore -->
```tsx
  const close = () => {
    onClose();
  };
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `closes on nothing and starts nothing else while an export runs`.

- **D8** (запись паллеты без паллеты): в `apps/standalone/src/office/exports/ExportDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        maxLines: lines,
        palletId,
        documentId,
        parts: result.parts,
```

заменить на

<!-- prettier-ignore -->
```tsx
        maxLines: lines,
        palletId: null,
        documentId,
        parts: result.parts,
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `forms one pallet's ЧЗ document of a shift still active; its shift formats wait for the close`.

- **D9** (папка по UTC): в `apps/standalone/src/office/exports/ExportDialog.tsx` `const timeZone = org.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;` → `const timeZone = "UTC";`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `forms one pallet's ЧЗ document of a shift still active; its shift formats wait for the close`, `forms the chosen format of fresh rows, saves the domain's bytes into the export's own folder, then records it, for both roles`.
- **D10** («Выгрузка» только у закрытой смены): в `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        {shift.status !== "planned" && (
          <Button
```

заменить на

<!-- prettier-ignore -->
```tsx
        {shift.status === "closed" && (
          <Button
```

Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `forms one pallet's ЧЗ document of a shift still active; its shift formats wait for the close`.

- **D11** («Записать снова» с другим `documentId`): в `apps/standalone/src/office/exports/ExportDialog.tsx` `void recordAgain(outcome.saved, outcome.unrecorded.record);` → `void recordAgain(outcome.saved, { ...outcome.unrecorded.record, documentId: crypto.randomUUID() + "x" });`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `says a record the host did not take, keeps the saved files and writes the same record again`.
- **D12** (предупреждения первого формата, а не выбранного): в `apps/standalone/src/office/exports/ExportDialog.tsx` `: exportWarnings(rows, selected.format, new Date().toISOString()),` → `: exportWarnings(rows, offers[0]?.format ?? selected.format, new Date().toISOString()),`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx`. Ожидается: FAIL — `warns of late data and of boxes on a pallet still open, and a pallet still open has no document`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/i18n/ru.json apps/standalone/src/office/exports/ExportDialog.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/test/export-dialog.test.tsx apps/standalone/test/shift-delete-close.test.tsx apps/standalone/test/shift-edit.test.tsx
git commit -m "feat(standalone): «Выгрузка» forms a shift's export, saves it and records it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Журнал процесса, документы и полная проверка

Маршруты выгрузки отвечают кодами и SSCC и не пишут их в журнал процесса; `no_secrets_in_logs.rs` читает строки выгрузки, оба списка и записывает выгрузку, а прежние проверки журнала (нет канонического кода, хеша, SSCC коробов и паллет) теперь доказывают это и для новых маршрутов. `AGENTS.md` получает раздел «Shift exports» и правки «Audit», «Office pages», «Logs»; спецификация пилота — раздел «Уточнения плана ЧЗ» (следующий свободный номер в конце файла; в копии — 19, после «18. Уточнения плана ПЛ-Х»). Затем — полная проверка.

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`
- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`

**Interfaces:**

- Consumes: маршруты задач 1–3.
- Produces: документы; тестов не добавляет.

- [ ] **Step 1: Маршруты выгрузки в проходе журнала**

1. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash or a box's SSCC (stage 2a spec §4.11): a rejected record is logged
//! by its id and its receipt code alone. Its own binary, because it
//! installs the global tracing subscriber.

mod support;

```

заменить на

<!-- prettier-ignore -->
```rust
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash or a box's SSCC (stage 2a spec §4.11): a rejected record is logged
//! by its id and its receipt code alone; nor do the routes of a shift's
//! exports, which answer with codes and SSCCs (plan ЧЗ). Its own binary,
//! because it installs the global tracing subscriber.

mod support;

```

2. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(closed.status(), 200);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
```

заменить на

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(closed.status(), 200);
    // The office reads the shift's export source and its lists, which carry
    // the codes and the SSCCs, and records an export (plan ЧЗ): none of them
    // reaches the log either.
    let office_get = |path: String| {
        client
            .get(format!("{base}{path}"))
            .header(protocol.0, &protocol.1)
            .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
            .bearer_auth(&key)
            .send()
    };
    let source = office_get(format!("/v1/office/shifts/{shift_id}/export-source"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        source.contains(pallet_sscc) && source.contains(sscc),
        "{source}"
    );
    for list in ["boxes", "pallets"] {
        let listed = office_get(format!("/v1/office/shifts/{shift_id}/{list}"))
            .await
            .unwrap();
        assert_eq!(listed.status(), 200);
    }
    let recorded = client
        .post(format!("{base}/v1/office/shifts/{shift_id}/exports"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "formatId": "shift_txt_boxes", "formatVersion": 2, "maxLines": null,
            "palletId": null, "documentId": "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f",
            "partCount": 1, "codeCount": 1, "boxCount": 1, "palletCount": 0,
            "openPalletSuppressedBoxCount": 0
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(recorded.status(), 204);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
```

- [ ] **Step 2: Страж проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test no_secrets_in_logs`

Expected: PASS сразу (вне песочницы): `test result: ok. 1 passed` — это страж: маршруты задач 1–3 уже ничего не пишут в журнал; что страж кусается, показывает мутация L1 ниже.

- [ ] **Step 3: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
target_id`). Tests assert the exact actor, action, target, result and parsed
details.

## Databases

```

заменить на

<!-- prettier-ignore -->
```markdown
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
target_id`). `shift.export` (plan ЧЗ) is the one row that records no change:
the office saved an export's files and then wrote it (`POST
/v1/office/shifts/{id}/exports`), every office role, no revision, the
shift as its target and the record's fields as its details. Tests assert the
exact actor, action, target, result and parsed details.

## Databases

```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
  host counts them (`closeReasonRule`), sent trimmed with the loaded revision;
  a line break is a control character, so Enter writes none (the hint says
  «одной строкой»; an Enter that confirms an input method's word is left alone)
  and a pasted one is refused with `rules.controlCharacter`, nothing sent. A
  closed shift has no action.
- Every change and close sends the opened row's revision; a delete sends none
  (the host takes no `expectedRev` on `DELETE`, only the status), so it removes
  a planned shift whatever was changed in it meanwhile, and a create has no
```

заменить на

<!-- prettier-ignore -->
```markdown
  host counts them (`closeReasonRule`), sent trimmed with the loaded revision;
  a line break is a control character, so Enter writes none (the hint says
  «одной строкой»; an Enter that confirms an input method's word is left alone)
  and a pasted one is refused with `rules.controlCharacter`, nothing sent. An
  active or closed shift also has «Выгрузка», for every role (plan ЧЗ, see
  "Shift exports"); a closed shift has nothing else.
- Every change and close sends the opened row's revision; a delete sends none
  (the host takes no `expectedRev` on `DELETE`, only the status), so it removes
  a planned shift whatever was changed in it meanwhile, and a create has no
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
pallets that hold a box not taken apart; a pallet whose boxes were all taken
apart is not counted). A planned shift's totals are zeros, `null` and `[]`.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one: the sign-in neither logs nor keeps it, and
```

заменить на

<!-- prettier-ignore -->
```markdown
pallets that hold a box not taken apart; a pallet whose boxes were all taken
apart is not counted). A planned shift's totals are zeros, `null` and `[]`.

## Shift exports

Plan ЧЗ ports the cloud's shift exports into the office; the bytes of every
file are the cloud's for the same facts, and that is the acceptance rule.

- The host only reads and records. `GET /v1/office/shifts/{id}/export-source`
  (`routes/office_exports.rs`, every office role) answers `ShiftExportRows`
  in one read transaction: the shift with its number, status, production
  date, the product's name now (the cloud's export joins the live product),
  `closedAt` (the host's whole seconds) and `stationClosedAt` (the accepted
  `shift_close_events.closed_at`, the device's instant), the organization's
  name and INN, the codes the shift owns with their owning scans' canonical
  text, every box, the live items of those boxes only and every pallet. Each
  query searches by an index (`every_query_of_the_source_searches_by_an_index`
  runs `EXPLAIN QUERY PLAN` on them), so a year of facts costs one shift's
  export nothing. `GET …/boxes` and `…/pallets` (`routes/office_boxes.rs`)
  list a shift's boxes and pallets with their live units and boxes, derived
  as the cloud's pallet card derives them, for the card of plan О-Ф.
- The office ports the cloud's source (`src/office/exports/export-source.ts`,
  the cloud's `shift-export-source.service.ts`) and its runner's mapping of
  failures (`run-export.ts`), and renders through `@markiro/domain`
  (`renderShiftExport`, `renderPalletAggregationExport`). Two rules are the
  standalone's own and change no cloud byte: `operation_date_time` is the
  station's close instant when a station closed the shift (the cloud's
  `shifts.closed_at` is that instant; the host keeps whole seconds), and the
  pallets taken apart that a pallets format still writes are counted for a
  warning. The cloud writes such a pallet as a pallet (its pallet query reads
  no `disassembled_at`), so the port does too, contrary to plan ПЛ-Х's
  contract; a single pallet's document refuses it (`PALLET_DISASSEMBLED`).
- Parity is a test on both sides over the same cases:
  `packages/domain/test/fixtures/shift-export-parity/cases.json` holds the
  facts, `golden.json` the cloud's bytes (text, length, SHA-256), file names,
  counts and refusals. `apps/api/test/standalone-export-parity.test.ts` runs
  the cloud's own source and runner over them, and
  `test/export-parity.test.ts` runs the office's port over the same facts as
  the host would answer them. A legitimate change of the cloud's export
  regenerates the golden from the cloud's test alone
  (`EXPORT_PARITY_WRITE=1`), and the port follows in the same change. The
  location under `packages/domain` makes `tools/ci/affected.mjs` run both
  suites on any change of the cases.
- The dialog (`ExportDialog.tsx`, from «Смены») offers the cloud's formats
  (the pallets formats only for a shift with pallets), each with what its
  source would refuse now, the line limit (2–1 000 000, 2000 by default), the
  warnings (late data, boxes on a pallet still open, pallets taken apart in
  the document) and a ЧЗ document for each closed pallet, also of an active
  shift. Forming reads the rows again, saves the parts and only then records
  the export; a record the host did not take is said, with «Записать снова»,
  and the files stay. `document_id` is a new UUID each time and
  `file_date_time` the moment of forming, so two exports of one shift are two
  documents. The late-data warning cannot see a code that an earlier scan of
  another shift took after the close (displacement marks no shift late, as in
  the cloud).
- Files go through the shell (`src-tauri/src/office_files.rs`):
  `save_office_files` writes them, byte for byte, into a new folder
  `Документы\Markiro\Выгрузки\<номер смены>\<дата_время>_<формат>` (the
  number as a file name's segment, the moment in the organization's zone; a
  folder that exists gets « (2)»), checks every name before writing and
  takes the folder back on a failure; `open_office_folder` shows it in
  Explorer. No file dialog and no new dependency (pilot question П16).
  `Формы` is the second root, for plan О-Ф.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

The routes of a shift's exports answer with codes and SSCCs and log none of
them; `no_secrets_in_logs.rs` reads the export source, both lists and
records an export. The shell's file commands log a failure by its code and
the I/O error's kind, never a path (it names the Windows user).

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one: the sign-in neither logs nor keeps it, and
```

4. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```markdown
  (`shift-create-pallets.json`, `device-shift-create-pallets.json`,
  `device-shift-entered-pallets.json`, `facts-request-pallets.json`), поэтому схемы станции этапа
  2a читают прежние фикстуры без изменений.
```

заменить на

<!-- prettier-ignore -->
```markdown
  (`shift-create-pallets.json`, `device-shift-create-pallets.json`,
  `device-shift-entered-pallets.json`, `facts-request-pallets.json`), поэтому схемы станции этапа
  2a читают прежние фикстуры без изменений.

## 19. Уточнения плана ЧЗ

План `docs/superpowers/plans/2026-10-10-standalone-chz-exports.md` (выгрузки смены и XML для
Честного знака вместе с данными отчётов на хосте) уточняет раздел 7 так; на вопросы раздела 14
действуют рекомендованные ответы.

- **Маршруты хоста.** `GET /v1/office/shifts/{id}/export-source` отдаёт строки выгрузки одним
  снимком: смену (номер, статус, дата, название товара сейчас, `closedAt` хоста и
  `stationClosedAt` — момент принятого закрытия станцией), реквизиты организации, коды смены с
  каноническим текстом сканов-владельцев, все короба, только живые позиции и все паллеты.
  `GET …/boxes` и `…/pallets` — списки для карточки О-Ф. `POST …/exports` пишет строку журнала
  `shift.export` после сохранения файлов. Маршруты `report-data` коробов и паллет переходят в
  план О-Ф; маршрут `task-form-data` не нужен: все поля «Бланка смены» уже есть в чтениях офиса.
- **Паритет байтов.** Источник облака перенесён в вебвью, файлы строит `@markiro/domain`. Общие
  случаи и эталон лежат в `packages/domain/test/fixtures/shift-export-parity`: облачный тест
  гоняет по ним собственные источник и исполнитель облака, тест автонома — порт по тем же фактам
  в форме ответа хоста.
- **Расформированная паллета** в сменных паллетных форматах остаётся паллетой, как в облаке (его
  запрос паллет не читает `disassembled_at`); диалог предупреждает с числом. Документ одной
  паллеты её отвергает (`PALLET_DISASSEMBLED`). Контракт ПЛ-Х «короба расформированной паллеты —
  короба без паллеты» для выгрузок не действует.
- **`operation_date_time`** смены — момент закрытия станцией с миллисекундами (облако пишет
  именно его), при закрытии из офиса — момент хоста.
- **Выгрузка одной паллеты** доступна и у активной смены, как в облаке; дата в имени файла — дата
  закрытия паллеты по UTC, как в облаке.
- **Папка.** Каждая выгрузка — своя папка
  `Документы\Markiro\Выгрузки\<номер смены>\<дата_время>_<формат>`: более короткая выгрузка не
  оставляет рядом частей прежней. Существующая папка получает « (2)».
- **Права.** Выгружают все роли офиса (облачное `OPERATIONS_READ`); кнопка «Выгрузка» есть у
  активной и закрытой смены.
- **Предупреждение о поздних данных** не видит код, который после закрытия смены забрал более
  ранний скан другой смены: вытеснение не отмечает смену поздней, как и в облаке.
```

- [ ] **Step 4: Полная проверка**

Run (вне песочницы; перед ним `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`): `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked --workspace`

Expected: PASS: 52 набора по строкам `Running`, 779 тестов (хост 36 и 462, `proto` 2 и 53, оболочка 14 и 264), ни одного `FAILED`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`

Expected: `Test Files  85 passed (85)`, `Tests  2504 passed (2504)`; отказ на пределе 5 с в тяжёлых UI-наборах («Заметки») повторить отдельным запуском файла — зелёный.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `… run lint`, `… run build` — без ошибок (у `build` — только предупреждение о размере чанка).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts test/shift-export-source.test.ts test/shift-export-runner.test.ts` — `Tests  52 passed (52)`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck` — без ошибок; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec eslint test/standalone-export-parity.test.ts` — без ошибок.

Run: `printf 'packages/domain/test/fixtures/shift-export-parity/golden.json\n' | node tools/ci/affected.mjs`

Expected: в ответе `"verify_api_tests":true`, `"verify_app_tests":true`, `"standalone_rust":true` — изменение случаев запускает оба теста паритета.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, `git diff --check`, `node_modules/.bin/prettier --check` на все файлы плана — чисто.

Если локальный граф есть: `graphify update .`.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **L1** (строки выгрузки в журнале процесса): в `apps/standalone/host/src/routes/office_exports.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let rows = read(&mut tx, &id).await;
```

заменить на

<!-- prettier-ignore -->
```rust
    let rows = read(&mut tx, &id).await;
    tracing::info!("export source {rows:?}");
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test no_secrets_in_logs`. Ожидается: FAIL — `secrets_never_reach_the_process_log`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/AGENTS.md apps/standalone/host/tests/no_secrets_in_logs.rs docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -m "docs(standalone): shift exports in AGENTS and the pilot spec, the export routes in the log walk" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- **Покрытие спецификации.** §5.2 (10 форматов и XML паллеты, имена, кодировки, части) — задачи 4–5 (байты облака) и 8 (диалог). §5.3 (проверки полноты) — задача 5 (порт с эталоном), задача 6 (отказы до формирования), задача 8 (тексты). §5.4 (XML: `action_id=30`, `<cis>` для коробов паллеты, срезанный криптохвост, `document_id`/`document_number`/`operation_date_time`, части `-k`) — эталон задачи 4; три документа приведены в задаче 4 целиком. §5.7 Д1–Д4 — задача 1 (Д2/Д3 и для О-Ф — задача 2). §7 «Новые маршруты хоста» — задачи 1–3 (данные форм — за О-Ф, см. «Контракт»), «Источник выгрузки и проверки полноты» — задача 5, «Выгрузка» (форматы, `maxLines`, новый `document_id`, `fileDateTime`, предупреждение о поздних данных, строка журнала) — задачи 3, 6, 8, «Сохранение файлов» — задача 7, «Карточка смены» — за О-Ф (диалог переносится как есть). §14 П3/П16 — «Допущения». §15 — «Не проверено» ниже.
- **Байты.** Порт сверен с облаком по 197 прогонам 12 случаев (задача 5); облачный тест сверяет облако с тем же эталоном и падает, когда изменение источника, исполнителя или домена облака меняет байты, имена, счётчики или отказы этих случаев (мутанты C1–C6 задачи 4). Диалог сохраняет ровно то, что вернул `runExport` (задача 8 сравнивает байты), а оболочка пишет байты без перекодировки (задача 7, BOM и `\r\n` побайтно).
- **Мутанты.** Каждое правило отбора, порядка, проверки, границы и права держит хотя бы один тест; выжившие названы эквивалентными с причиной (B7, P7a, P7b, P7d, K5, S7). Охранник `inFlight` диалога не мутировался: jsdom перерисовывает кнопки между событиями, и выключенная кнопка сама держит повторное нажатие; ref защищает только один кадр до перерисовки, как в `FormDialog`.
- **Производительность.** Чтение одной смены ищет по индексам (`EXPLAIN QUERY PLAN` без `SCAN` у пяти запросов задачи 1 и двух задачи 2) — год фактов хоста не входит в выгрузку одной смены. Без `ANALYZE` (хост его не делает) план держится; если кто-то добавит `PRAGMA optimize`, тест плана это покажет. Объём ответа большой смены по IPC WebView2 (50 000 кодов — порядка 15 МБ JSON) не измерен (см. ниже).
- **Типы и имена между задачами** сверены: `ShiftExportRows` (1) → `shiftExportSnapshot`/`runExport` (5) → `formatOffers`/`exportWarnings` (6) → `ExportDialog` (8); `shiftExportRecord`/`ExportWritten` (3) ← `runExport` (5) в диалоге (8); `OfficeFilesApi` (7) → диалог (8).
- **Проверки на копии.** Каждая задача: тесты до реализации падают ровно так, как написано, после — проходят; `typecheck` и `lint` вебвью — без ошибок на коммите каждой задачи; `cargo fmt --check`, `prettier --check`, `git diff --check` — чисто. Полный прогон после задачи 9: cargo `--workspace` — 52 набора, 779 тестов, всё зелёное (вне песочницы); Vitest — 85 файлов, 2504 теста, из них 2501 зелёный и 3 отказа на пределе 5 с в `test/template-editor.test.tsx` (файл плана не касается; при средней нагрузке 161 он прошёл отдельно с `--testTimeout=20000`, 97 из 97; на базе копии такие отказы были у 258 тестов); `apps/api`: `typecheck`, `lint` нового файла и тесты выгрузок (`shift-export-source`, `shift-export-runner`, новый) — зелёные.

## Перенесено

- **Маршруты данных форм** (`report-data` короба и паллеты, §7) — план О-Ф: облачное правило «Состава короба» расформированного короба (позиции, снятые именно расформированием, `removed_at = disassembly_received_at`) требует маршрута, которого строки выгрузки не заменяют. Правка `proto` — в потоке Б (§12.4).
- **Решение владельца по Ч1** (расформированная паллета в сменных форматах): облако пишет её паллетой, и это похоже на недосмотр облака (документ одной паллеты её отвергает). Если владелец решит «короба без паллеты», менять нужно и облако, и порт вместе, иначе эталон разойдётся; одна строка в каждом (`toPalletsSource`, `palletsSource`).
- **Ч2 и момент закрытия из офиса.** Облако при закрытии из кабинета пишет `new Date()` с миллисекундами, хост — целые секунды; для одних фактов байты `operation_date_time` у такой смены могут отличаться в миллисекундах от облачной выгрузки той же смены. Это не «те же факты» (момент разный), но пометить.
- **Объём IPC.** Ответ строк выгрузки для 50 000 кодов (≈15 МБ) и base64 частей того же объёма через `invoke` WebView2 не измерены; на хосте нет предела ответа. Если большая смена клиента упрётся в 10 с запроса оболочки, нужен потоковый или постраничный маршрут (план после пилота).
- **«Открыть в браузере»** для форм О-Ф — новая команда оболочки (открыть файл) или плагин; этот план даёт только сохранение в `Формы` и показ папки.
- **Поиск по выгрузкам и история выгрузок** (облачная «История» с повторным скачиванием) — нет: файлы не хранятся на хосте (§7), повтор строит новый документ с новым `document_id`.
- **Вынос источника в `packages/domain`** (§16) — после пилота, с выкладкой облака; тогда облачный и автономный тесты паритета превращаются в один доменный.
- **Метка поздних данных при вытеснении** (ревью задачи 7 плана 2a2, Minor 2) — если финальная волна 2a2 начнёт отмечать вытеснение в закрытой смене, предупреждение диалога увидит и этот случай без правок плана.

## Что должен предоставить владелец

1. **Образцы файлов, которые клиент загружал в Честный знак** за последние смены (XML коробов и паллет, TXT/CSV, если загружались), и список форматов и форм, которыми клиент пользуется (П3). С ними — прогон этих же смен в облаке и в автономе и побайтное сравнение; без них эталон доказывает совпадение с кодом облака, а не с тем, что клиент реально отправлял.
2. **Приёмку XML порталом ЧЗ**: загрузка документа автонома (короба, паллетная агрегация, одна паллета) в личный кабинет клиента с компьютера с интернетом и статус обработки (§8.9 шаг 5, §15).
3. **Решение по Ч1** (расформированная паллета) — и по облаку тоже.
4. **Проверку на Windows**: сохранение с кириллицей в пути и имени, перенаправленная OneDrive папка «Документы», `explorer.exe`, самая большая смена клиента (§15).

## Не проверено (без Windows, железа и данных клиента)

- Сохранение файлов и открытие папки на Windows: `document_dir()` с OneDrive, кириллица в пути, `explorer.exe`; тесты команд — на временном каталоге macOS; `cfg(windows)`-ветка `show_in_explorer` компилируется только в `standalone-windows-build`.
- Приём XML порталом ЧЗ — совпадение с облаком доказано, приём порталом — нет (внешняя проверка).
- Реальные данные клиента: коды с необычными символами серии, очень большая смена, объём IPC WebView2.
- Отображение диалога в WebView2 и в окне киоска (только jsdom).
- Облачные тесты, кроме выгрузок (`shift-export-source`, `shift-export-runner` и новый), не запускались; база данных облака не нужна новому тесту.

## Отклонения при исполнении
