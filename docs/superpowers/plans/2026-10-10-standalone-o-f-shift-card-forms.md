# План О-Ф: карточка смены, печатные формы смены и паллеты в форме планирования — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Офис автономного продукта открывает карточку смены (короба и паллеты, какими их сейчас выводит хост, «Итоги», «Выгрузка», «Закрыть») и печатает все печатные формы смены облака — «Бланк смены», «Состав короба», «Состав паллеты», «Ярлык паллеты» A4/A5 и «Ярлыки паллет смены» — **теми же байтами HTML**, что облако для тех же фактов: хост отдаёт данные форм одним снимком, офис рисует формы кодом `@markiro/domain` и печатает их в окне печати WebView2 или в браузере по умолчанию; форма планирования получает паллеты.

**Architecture:**

- Хост (только чтение): `GET /v1/office/boxes/{id}/report-data` (`BoxReportRows`) — коды короба по правилу облачного `boxReportData`, включая снятые расформированием; `GET /v1/office/shifts/{id}/pallet-report-data` (`PalletReportRows`) — все паллеты смены со всеми коробами, стоявшими на них, номером, датой и товаром смены (`host/src/routes/office_reports.rs`). Типы — `proto`, фикстуры и Zod — как всегда.
- Паритет: `packages/domain/test/fixtures/print-forms-parity/{cases,golden}.json`; `apps/api/test/standalone-forms-parity.test.ts` прогоняет вход загрузчиков облака через **настоящие** контроллеры облака (`CodeSearchController`, `ShiftsController.taskForm`) и пишет или сверяет эталон HTML; `apps/standalone/test/forms-parity.test.ts` рисует те же байты из ответа хоста.
- Вебвью: `src/office/forms/form-data.ts` (вход форм облака из строк хоста), `render-form.ts` (`renderForm`, `formTimeZone`), `print-form.ts` (скрытый кадр и «Открыть в браузере»), `PrintFormDialog.tsx` и контекст печати; `src/office/shifts/ShiftCardPage.tsx` с `shift-card.ts` — карточка по маршруту `shifts/:id`; паллеты в `ShiftDialog` (`shift-form.ts`, `requests.ts`, `suggestPalletTemplate`).
- Оболочка: команда `open_office_file` в `src-tauri/src/office_files.rs` (только `.html` из папки офиса, `explorer.exe`) — без новых зависимостей и плагинов.

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite 3.46), serde, Tauri 2.11; TypeScript — React 19.2, react-router 8.3, react-hook-form 7.85, zod 4.4.3, Vitest 4 с jsdom, `@markiro/domain` (`renderBoxReportHtml`, `renderPalletReportHtml`, `renderPalletPlacardHtml`, `renderShiftPlacardsHtml`, `renderShiftTaskFormHtml`), `@markiro/ui` (`SidePanel` не нужен: карточка — страница); облачный тест — Vitest 4 в `apps/api` без базы данных.

**База:** ветка `claude/autonomous-desktop-station-9e6f13` после влития планов 2a2 (с финальной волной), 2a3 (с задачей 9), 2a4, ПЛ-Х и ЧЗ. Они на момент написания не влиты, поэтому каждый фрагмент плана применён к копии, собранной так (точно в этом порядке):

1. `f48399cf1` — копия планировщика ЧЗ (`pchz-clean`: 2a2 + 2a3 до задачи 8 + ПЛ-Х 1–7 + 2a4 + задачи 1–9 плана ЧЗ по его тексту);
2. перенос коммита задачи 9 плана 2a3 с `claude/integration` (`1095d4af4`: `shiftTotalsSchema`, колонка «Выпуск», `ShiftTotalsDialog`, `getShift`, `officeKeys.shift`) и поля `ShiftTotals.unitsInClosedBoxes` финальной волны 2a2 (`85608f3f3`: подзапрос, поле `proto`, фикстура `office-shift.json` 547/540); конфликты — объединение обеих сторон: в `shiftTotalsSchema` восемь полей (шесть плана 2a2 и `closedPallets`, `openPallets` плана ПЛ-Х), у строки смены кнопки «Итоги», затем записи, затем «Выгрузка»; ожидания `totals` в `host/tests/{facts,pallet_facts,office_shifts}.rs` получили `unitsInClosedBoxes`. Итог — коммит копии `76d963f3a`.

Файлы, которые трогает этот план, в влитой ветке должны совпасть с копией по смыслу: `proto/src/lib.rs` (после `ExportPallet`), `proto/tests/fixtures.rs` (список `use` и конец файла), `host/src/routes/mod.rs`, `host/src/server.rs` (маршруты после `…/exports`), `host/tests/no_secrets_in_logs.rs` (после записи выгрузки), `src/host/{protocol,api,requests}.ts`, `src/office/{Office.tsx,office-query.ts,routes.tsx}`, `src/office/shifts/{ShiftsPage.tsx,ShiftDialog.tsx,shift-form.ts,shift-list.ts}`, `src/office/exports/office-files.ts`, `src/lib/{box-template-choice,rules}.ts`, `src/i18n/ru.json`, `src/app/shell.css`, `src-tauri/src/{office_files,lib}.rs`, `src-tauri/tests/ipc.rs`, тесты `test/{protocol,api,shift-form,shift-list,box-template-choice,shift-dialog,shift-edit,office-files,export-dialog}.test.*` и `test/support/office.tsx`, `apps/standalone/AGENTS.md` и спецификация пилота (раздел ЧЗ «19» — последний). Если фрагмент «до» не найден, сверить по смыслу и записать в «Отклонения при исполнении». Заранее известно одно место, которое может разойтись: если при влиянии 2a3/ПЛ-Х в `shiftTotalsSchema` останется другой набор полей, фрагменты этого плана его не касаются (карточка читает только `unitsInClosedBoxes` и `closedBoxes`, как колонка «Выпуск»).

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (спецификация пилота): §2 (ответ владельца: «печать форм; печатные формы смены», «все текущие отчёты по сменам»), §4.1 строки 11–13, §4.2 (логотип и фото отложены), §5.1 (формы облака — синхронный HTML, печать браузером через `@page`), §5.5 (пять форм и их загрузчики), §5.7 (Д2, Д3, Д5, Д6), §6.2 «Офис» (паллеты в форме планирования), §7 «Печать форм» и «Карточка смены», §9.3 (отклонённые записи в карточке), §12.2 (строка О-Ф: 8 задач), §14 (П15, П17), §15 (печать из WebView2), §16.
- План ЧЗ (`docs/superpowers/plans/2026-10-10-standalone-chz-exports.md`), раздел «Контракт для О-Ф»: списки `GET …/boxes` и `…/pallets`, `ExportDialog({ shift, onClose })`, `useOfficeFiles().save(["Формы", …])`, «открытие файла браузером — шаг О-Ф»; правило «Состава короба» расформированного короба требует своего маршрута.
- План ПЛ-Х, «Для О-Ф»: Zod офиса уже принимает поля паллет, строители `shiftCreate`/`shiftUpdate` и форма — за О-Ф; отказы `palletTemplateId`, `palletBoxCapacity`, `pallet_template_not_fit`.
- План 2a3, задача 9: окно «Итоги» (`ShiftTotalsDialog`), «Полная карточка смены — этап 4».
- Облако (переносится, не импортируется): `apps/api/src/modules/code-search/code-search.service.ts` (`boxReportData` `:1174`, `palletReportData` `:1274`, `shiftPlacardsData`, `palletPlacardData`), `code-search.controller.ts` (маршруты `boxes/:id/report`, `pallets/:id/report`, `pallets/:id/placard`, `shifts/:id/placards`), `apps/api/src/modules/shifts/shifts.service.ts` (`taskFormData` `:592`), `shifts.controller.ts` (`:id/task-form`), `apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx` (панель смены облака: какие формы когда предлагаются), `apps/admin/src/pages/code-search/PlacardFormatModal.tsx` (выбор A4/A5, «липкий»), `packages/domain/src/print-forms/*`.
- `apps/standalone/AGENTS.md` — «Office pages», «Shifts», «Shift exports», «Logs», «Verification».

## Допущения по вопросам владельцу

Владелец подтвердил: клиент заменяет облачный сервер, пользуется текущими отчётами смены облака; автоном должен давать те же отчёты и печатные формы (A4/A5), печать — браузером или системной печатью ПК офиса, этикетки из офиса не печатаются. На остальное план принимает рекомендованные ответы:

- **П15 — логотип клиента на формах: отложить.** У `org_profile` автонома логотипа нет; формы домена подставляют логотип Маркиро (`brandLogo`), как облако без загруженного логотипа. Поле организации и его перенос — отдельный план (1–2 задачи).
- **П3 — какие формы клиент использует: все пять.** Каждая — один вызов домена; ручная приёмка — тех, что клиент печатает.
- **П17 (скан бланка на станции)** — вне плана: «Бланк смены» рисуется с тем же DataMatrix токена смены (`formatShiftTaskBarcode`), что в облаке; станция его читает или нет — план 2a5.

Вопросы, которые план добавляет, с принятыми ответами (меняются одной правкой, сказано где):

- **Ф1 — маршрут данных паллет — на смену, а не на паллету.** Спецификация (§7) называла `…/pallets/{id}/report-data`; принят `GET /v1/office/shifts/{id}/pallet-report-data`: карточка всегда в контексте смены, «Ярлыки паллет смены» рисуются из одного снимка (ярлыки согласованы между собой), один маршрут вместо двух. Паллет у смены десятки, ответ мал.
- **Ф2 — часовой пояс форм — пояс организации** (облачный кабинет шлёт пояс браузера, по умолчанию UTC). При неизвестном этому ПК поясе — пояс ПК (`formTimeZone`).
- **Ф3 — даты «Бланка смены».** У смены автонома одна дата (вопрос В3 спецификации 2a); она идёт и в «Дату смены» (`plannedDate`), и в «Дату производства». Иначе бланк печатал бы «Дата смены: Не назначена». Одна строка в `taskFormData` (`form-data.ts`).
- **Ф4 — печать: обе кнопки рядом.** «Печать» — скрытый кадр того же окна и `print()` (WebView2 показывает окно печати для документа кадра, бумага — по `@page` формы); «Открыть в браузере» — файл в `Документы\Markiro\Формы\<номер смены>\<дата_время>_<форма>` и браузер по умолчанию через новую команду оболочки `open_office_file` (`explorer.exe`; на Windows 10/11 браузер по умолчанию есть всегда). Обе работают без сети (штрихкоды — встроенный SVG, шрифт — системный Arial). Неоткрывшееся окно печати программа не видит, поэтому второй путь не прячется за ошибкой. Печать из WebView2 не проверена (§15) — путь через браузер гарантирует результат.
- **Ф5 — товар форм — текущий**, как облачные загрузчики соединяют живой `products` (так же решил план ЧЗ); не снимок смены (§5.7 Д6 говорил о снимке).
- **Ф6 — порядок кодов «Состава короба» — по GTIN и серии побайтно** (`ORDER BY` SQLite, `BINARY`). Облако сортирует в Postgres по сопоставлению базы; при сопоставлении `en_US` серии со смешанным регистром и знаками встанут иначе — строки те же, порядок другой. Проверить `SHOW lc_collate` на базе облака — шаг владельца.
- **Ф7 — исключения и отклонённые записи станции в карточке** (§7, §9.3) — **не в этом плане**: нужны маршруты по `box_exceptions`, `pallet_exceptions` и `fact_receipts`. Карточка показывает отметку поздних данных, расформирования и расхождения закрытия; список исключений и отклонений — отдельный план (2 задачи). Укладывает О-Ф в 9 задач.
- **Ф8 — «Бланк смены» только у запланированной и активной смены**, «Ярлыки паллет смены» — только когда есть закрытая нерасформированная паллета с SSCC, «Ярлык паллеты» — у закрытой паллеты с SSCC (расформированная — с водяным знаком), как предлагает панель облака.
- **Ф9 — паллеты в форме планирования:** переключатель «С паллетами» — у товара с вместимостью паллеты (у активного товара она есть всегда); вместимость из товара, шаблон — по решению 7 для назначения `pallet` (предпочтение товара → умолчание категории → умолчание организации), оба можно изменить; другой товар берёт свои значения, товар без вместимости паллеты выключает паллеты. Список смен предупреждает о шаблоне паллеты, с которым смена не откроется.

## Global Constraints

**Решения спецификации пилота, обязательные для плана** (§5.1, §5.5, §6.2, §7 с уточнениями задачи 9)

1. Формы — ровно генераторы `@markiro/domain/src/print-forms` (без копий и правок): HTML автонома для тех же входных данных — байт в байт облачный.
2. Данные — по правилам облачных загрузчиков: «Состав короба» — живые позиции, у расформированного короба — снятые его расформированием, без вытесненных, по GTIN и серии; «Состав паллеты» и ярлыки — все короба, стоявшие на паллете, по `closed_at`, затем `id`; расформированный короб — в списке, вне итогов; «Ярлыки паллет смены» — закрытые нерасформированные паллеты с SSCC по `closed_at`, затем `id`.
3. Отказы облака сохраняются: ярлык — только у закрытой паллеты с SSCC (`PALLET_NOT_CLOSED`), ярлыки смены — если есть что печатать (`SHIFT_HAS_NO_PALLETS`), бланк — только у запланированной и активной смены (`SHIFT_TASK_FORM_CLOSED`).
4. Печать — без PDF, без сети: окно печати WebView2 или браузер по умолчанию; файлы — в `Документы\Markiro\Формы\…`, каждая форма — в новую папку.
5. Логотип — Маркиро (П15), фото товара нет; товар — текущий (Ф5); пояс — организации (Ф2).
6. Паллеты в форме планирования — поля `palletsEnabled`, `palletBoxCapacity` (1–10 000), `palletTemplateId`, как их принимает хост с плана ПЛ-Х.

**Код и процесс**

- Новых крейтов и пакетов нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются. Миграций нет: запросы ищут по индексам `0010` и `0012` (`scans_shift`, `box_items_live`, `boxes_shift`, `pallets_shift`, ключи).
- Версия протокола не меняется: маршруты новые и только читают, у прежних ответов полей не добавляется.
- Не меняются: `apps/station`, `packages/*` **кроме тестовых фикстур** `packages/domain/test/fixtures/print-forms-parity/`, облачный код **кроме нового теста** `apps/api/test/standalone-forms-parity.test.ts`, применённые миграции.
- Правила записи `apps/standalone/AGENTS.md` («Writes») план не трогает: хост ничего не пишет. Чтение — одна отложенная транзакция с откатом (как `GET …/export-source`).
- Журнал процесса: ни кодов, ни SSCC, ни путей к файлам.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в этот момент он встречается в файле один раз. Внутри шага правки одного файла идут сверху вниз и применяются по порядку. Шаг тестов применяется раньше шага реализации. Фрагменты сняты с коммитов копии `pof-scratch` (по одному на задачу) и применяются к ней последовательно байт в байт.
- «Создать» — новый файл, ровно как в блоке, с переводом строки в конце.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier.
- Русский текст — буквами, не `\uXXXX`; в JSON-фикстурах группа GS — `\u001d`.
- `golden.json` (задача 3) в плане не приводится: его пишет облачный тест (`FORMS_PARITY_WRITE=1`), а план даёт его SHA-256 и сводку. Так эталон выводится из кода облака.
- `cases.json` (задача 3) приводится целиком; он сгенерирован сценарием и отформатирован prettier.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из списка; команда — ожидаемый FAIL названных тестов; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутанты облака (задача 3) меняют облачный файл только на время проверки.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` (`--locked` заодно доказывает, что `Cargo.lock` не меняется).
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind` (`Operation not permitted`): из затронутых — `no_secrets_in_logs`, `ipc` целиком, `cargo test -p markiro-host` целиком и `--workspace`; их запускать вне песочницы. `--test office_reports`, `--test fixtures`, `-p markiro-standalone --lib office_files` и `--test ipc -- opening_an_office_form saving_office_files the_app_manages_every_state` идут и в песочнице.
- Оболочка встраивает сборку вебвью (`tauri::generate_context!`): перед `-p markiro-standalone` или `--workspace` в свежем worktree выполнить `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`; перед тестом облака (задача 3): `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/api^...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать; команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`: если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- Машина под нагрузкой параллельных агентов: тяжёлые UI-наборы Vitest (`test/template-editor.test.tsx`, `test/templates-page.test.tsx`, `test/shifts-page.test.tsx`, `test/shift-edit.test.tsx`, `test/shift-dialog.test.tsx`, `test/shift-delete-close.test.tsx`, `test/devices-page.test.tsx`, а теперь и `test/shift-card.test.tsx`, `test/print-form-dialog.test.tsx`) при полном прогоне падают на пределе 5 с и до этого плана. Такой отказ повторить отдельным запуском файла; гейтом остаётся обычный предел.

**Счёт тестов**

- Наборы cargo считаются по строкам `Running` (doc-тесты не считаются). База — копия из «Базы»: cargo — 52 набора, 779 тестов (хост 36 и 462, `proto` 2 и 53, оболочка 14 и 264); Vitest — 86 файлов, 2522 теста. После плана: cargo — 53 набора, 789 тестов (хост 37 и 468, `proto` 2 и 55, оболочка 14 и 266); Vitest — 91 файл, 2581 тест; в `apps/api` — один новый файл с одним тестом.
- Если влитые планы добавили тесты сверх своих текстов, абсолютные числа сдвигаются; неизменны приращения: задача 1 — `proto` +1, хост новый набор `office_reports` с 3 тестами, Vitest +3 (`protocol` +2, `api` +1); задача 2 — `proto` +1, `office_reports` +3, Vitest +3; задача 3 — `apps/api` +1 файл, 1 тест; задача 4 — Vitest +2 файла, 19 тестов (`forms-parity` 11, `form-data` 8); задача 5 — оболочка `--lib` +1, `ipc` +1, Vitest +1 файл и 6 тестов (`print-form` 5, `office-files` +1); задача 6 — Vitest +1 файл, 9; задача 7 — Vitest +1 файл, 9; задача 8 — Vitest +10 (`protocol` +1, `shift-form` +2, `box-template-choice` +2, `shift-dialog` +4, `shift-edit` +1); задача 9 — тестов не добавляет. Каждое «Expected» ниже измерено на копии с кодом самого плана.

## Файлы

Задачи выполняются по порядку: задачи 1–2 (хост) делят `proto`, фикстуры и `test/protocol.test.ts`; задача 3 (облачный эталон) нужна задаче 4; задачи 6–7 строят карточку на 4–5; задача 8 независима от 1–7 по коду, но делит `ru.json`.

```
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                          задачи 1–2
apps/standalone/proto/fixtures/{box-report-rows,pallet-report-rows}.json           задачи 1–2
apps/standalone/host/src/routes/office_reports.rs, host/tests/office_reports.rs    задачи 1–2
apps/standalone/host/src/routes/mod.rs, host/src/server.rs                         задачи 1–2
apps/standalone/src/host/{protocol,api}.ts, test/{protocol,api}.test.ts            задачи 1–2
apps/standalone/test/support/office.tsx                                            задачи 1–2
packages/domain/test/fixtures/print-forms-parity/{cases,golden}.json               задача 3
apps/api/test/standalone-forms-parity.test.ts                                      задача 3
apps/standalone/src/office/forms/{form-data,render-form}.ts                        задача 4
apps/standalone/test/{forms-parity,form-data}.test.ts                              задача 4
apps/standalone/src-tauri/src/{office_files,lib}.rs, src-tauri/tests/ipc.rs        задача 5
apps/standalone/src/office/exports/office-files.ts, src/office/forms/print-form.ts задача 5
apps/standalone/test/{print-form,office-files,export-dialog}.test.*                задача 5
apps/standalone/test/support/office-files.ts                                       задача 5
apps/standalone/src/office/shifts/{ShiftCardPage.tsx,shift-card.ts}               задачи 6–7
apps/standalone/src/office/{routes.tsx,office-query.ts}, shifts/ShiftsPage.tsx     задачи 6–7
apps/standalone/src/app/shell.css, test/shift-card.test.tsx                        задачи 6–7
apps/standalone/src/office/forms/{PrintFormDialog,form-printer-context}.tsx        задача 7
apps/standalone/src/office/Office.tsx, test/print-form-dialog.test.tsx             задача 7
apps/standalone/src/host/requests.ts, src/lib/{box-template-choice,rules}.ts       задача 8
apps/standalone/src/office/shifts/{ShiftDialog.tsx,shift-form.ts,shift-list.ts}   задача 8
apps/standalone/test/{shift-form,box-template-choice,shift-list}.test.ts           задача 8
apps/standalone/test/{shift-dialog,shift-edit}.test.tsx                            задача 8
apps/standalone/src/i18n/ru.json                                                   задачи 6–8
apps/standalone/host/tests/no_secrets_in_logs.rs                                   задача 9
apps/standalone/AGENTS.md, docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md  задача 9
```

Хост идёт первым: «Состав короба» (задача 1) и паллеты смены (задача 2) — каждая со своим типом, фикстурой, Zod и методом `HostApi`. Задача 3 — эталон HTML из контроллеров облака, без которого вход форм нечем проверить; задача 4 строит вход и рисует, сразу сверяясь с эталоном. Задача 5 — как форма попадает на бумагу (кадр окна и браузер), задача 6 — карточка, задача 7 — формы в карточке, задача 8 — паллеты в форме планирования, задача 9 — журнал процесса, документы и полная проверка.

## Контракт для других планов

Типы — `proto/src/lib.rs`, формы на проводе — фикстуры `proto/fixtures`, Zod — `src/host/protocol.ts`.

- `HostApi.getBoxReportRows(token, boxId)` → `BoxReportRows` (`GET /v1/office/boxes/{id}/report-data`, `box-report-rows.json`): короб, название товара сейчас, организация, `items` — коды, которые печатает облачный «Состав короба» (живые и снятые расформированием), с GTIN, серией и каноническим текстом, по GTIN и серии побайтно. Полный КМ с криптохвостом — не секрет `AGENTS.md`, но в журнал процесса не пишется.
- `HostApi.getPalletReportRows(token, shiftId)` → `PalletReportRows` (`GET /v1/office/shifts/{id}/pallet-report-data`, `pallet-report-rows.json`): номер, дата и товар смены сейчас (название, GTIN, срок годности), организация, все паллеты смены по `openedAt`, у каждой все короба, когда-либо стоявшие на ней, по `closedAt`, затем `id`, с живыми единицами.
- `renderForm(request)` (`src/office/forms/render-form.ts`) рисует любую форму смены из этих строк и записей офиса; `PrintFormDialog` и `printForm` у `Office` — как форма печатается. **Для плана исключений и отклонённых записей (Ф7):** карточка (`ShiftCardPage.tsx`) — место для их разделов; маршрутов по `box_exceptions`, `pallet_exceptions`, `fact_receipts` этот план не даёт.
- `open_office_file { segments, name }` (оболочка) открывает только `.html` из папки офиса. Другим планам, которым нужно открыть свой файл другого вида, понадобится своя проверка, а не ослабление этой.
- **Для 2a5 (П17):** «Бланк смены» несёт DataMatrix `formatShiftTaskBarcode(shiftId)` облака.
- **Для облака:** `apps/api/test/standalone-forms-parity.test.ts` падает, если поменяется контроллер или генератор форм облака; это намеренно (§16 спецификации пилота). Правка облачной формы перегенерирует эталон (`FORMS_PARITY_WRITE=1`) и в той же правке проверяется тест автонома. Правка **загрузчика** облака (SQL) тест не ловит: её нужно перенести в задачи 1–2 вручную.

---

### Task 1: «Состав короба» на хосте: `GET /v1/office/boxes/{id}/report-data`

Облачный «Состав короба» печатает живые позиции короба, а у расформированного короба — позиции, снятые **именно его расформированием** (`removed_at = disassembly_received_at`, `code-search.service.ts:1160-1250`); вытесненные — никогда. Строки выгрузки ЧЗ таких позиций не несут (только живые), поэтому нужен свой маршрут. На хосте расформирование пишет `box_items.removed_at` и `boxes.disassembled_at` одним и тем же моментом факта (`facts/exception.rs`), так что правило облака здесь — `removed_at = disassembled_at`; снятые раньше (отмена, очистка) с ним не совпадают. У каждой позиции — GTIN, серия и канонический текст скана-владельца (`scans`), порядок — GTIN, затем серия, как `orderBy(codes.gtin14, codes.serial)` облака, побайтно (Ф6). Неживые позиции не ищутся частичным индексом `box_items_live`, поэтому запрос идёт через сканы смены короба (`scans_shift`) и ключ `box_items` — год позиций хоста не читается ради одного короба. Название товара — текущее (Ф5), организация — из профиля. Тест закрепляет отбор (отменённый, вытесненный и снятый расформированием коды), порядок по серии против порядка сканирования, короб коллеги, роли и `EXPLAIN QUERY PLAN`.

**Files:**

- Create: `apps/standalone/host/src/routes/office_reports.rs`, `apps/standalone/host/tests/office_reports.rs`, `apps/standalone/proto/fixtures/box-report-rows.json`
- Modify: `apps/standalone/proto/src/lib.rs` (после `ExportPallet`), `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: таблицы `boxes`, `box_items`, `scans`, `shifts`, `products`, `org_profile`; `markiro_host::routes::office_exports::ORGANIZATION_SQL` и `markiro_proto::ExportOrganization` (план ЧЗ); `OfficeContext`, `ApiPath`.
- Produces: `markiro_proto::{BoxReportRows, BoxReportItem}`; маршрут `GET /v1/office/boxes/{id}/report-data` (все роли, `not_found` для неизвестного короба); константы `markiro_host::routes::office_reports::{BOX_SQL, BOX_ITEMS_SQL}`; Zod `boxReportRowsSchema`, тип `BoxReportRows`; `HostApi.getBoxReportRows(token, id): Promise<BoxReportRows>`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/host/tests/office_reports.rs`:

<!-- prettier-ignore -->
```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, code, empty, fact, instant, issue_block, ok_scan,
    open_floor, pair_device, receipts, record_id, request, shift_setup, sscc, with_device, Admin,
    Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// `GET /v1/office/boxes/{id}/report-data` as the administrator.
async fn box_report(admin: &Admin, id: &str) -> (StatusCode, Value) {
    admin
        .call("GET", &format!("/v1/office/boxes/{id}/report-data"), None)
        .await
}

/// Code `n` as «Состав короба» prints it.
fn printed(n: u32) -> Value {
    let code = code(n);
    json!({
        "gtin14": code["gtin14"],
        "serial": code["serial"],
        "canonical": code["canonical"],
    })
}

/// A day of a shift: box 1 takes codes 3, 1, 2 and 4, gives back 4 and
/// closes; box 2 takes 5 and 6, closes and is taken apart; box 3 stays open
/// with code 7. A colleague's earlier scan then takes code 1 from box 1.
/// «Состав короба» prints of box 1 the codes still in it, by serial; of
/// box 2, taken apart, the codes its disassembly took out (as the cloud's
/// form prints a box taken apart); of the open box its live code; and of the
/// colleague's box the code it won.
#[tokio::test]
async fn the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let mut undo = box_exception("undo", &box_id(1), &instant(14, 0));
    undo["codeHash"] = json!(support::app::code_hash(4));
    undo["targetScannedAt"] = json!(instant(13, 0));
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(45, 0));
    disassemble["reasonCode"] = json!("wrong_quantity");
    accept(
        &admin,
        &floor,
        &[
            scan(1, 3, 1, 10),
            scan(2, 1, 1, 11),
            scan(3, 2, 1, 12),
            scan(4, 4, 1, 13),
            fact(&record_id(5), "box_exception", &shift, undo),
            fact(
                &record_id(6),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[3, 1, 2],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            scan(7, 5, 2, 30),
            scan(8, 6, 2, 31),
            fact(
                &record_id(9),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[5, 6],
                    &instant(30, 0),
                    &instant(40, 0),
                ),
            ),
            fact(&record_id(10), "box_exception", &shift, disassemble),
            scan(11, 7, 3, 50),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
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

    let organization = json!({ "name": "ООО «Атолл»", "inn": "7701234567" });
    let (status, first) = box_report(&admin, &box_id(1)).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        first,
        json!({
            "id": box_id(1), "shiftId": shift, "sscc": sscc(1500),
            "openedAt": instant(10, 0), "closedAt": instant(20, 0), "disassembledAt": null,
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(2), printed(3)],
        })
    );
    let (_, second) = box_report(&admin, &box_id(2)).await;
    assert_eq!(
        second,
        json!({
            "id": box_id(2), "shiftId": shift, "sscc": sscc(1501),
            "openedAt": instant(30, 0), "closedAt": instant(40, 0),
            "disassembledAt": instant(45, 0),
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(5), printed(6)],
        })
    );
    let (_, open) = box_report(&admin, &box_id(3)).await;
    assert_eq!(
        open,
        json!({
            "id": box_id(3), "shiftId": shift, "sscc": null,
            "openedAt": instant(50, 0), "closedAt": null, "disassembledAt": null,
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(7)],
        })
    );
    let (_, theirs) = box_report(&admin, &box_id(11)).await;
    assert_eq!(theirs["shiftId"], json!(colleague.shift));
    assert_eq!(theirs["items"], json!([printed(1)]));
}

/// Every office role reads a box's form; an unknown box is `not_found`;
/// the device key alone is no office session.
#[tokio::test]
async fn every_office_role_reads_a_box_form_and_an_unknown_box_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        )],
    )
    .await;
    let path = format!("/v1/office/boxes/{}/report-data", box_id(1));
    let technologist = admin.technologist().await;
    let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], json!([printed(1)]));
    let (status, body) = box_report(&admin, &box_id(9)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of a box's form searches by an index: none reads through
/// every box, scan or item of the host.
#[tokio::test]
async fn every_query_of_a_box_form_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("box", markiro_host::routes::office_reports::BOX_SQL),
        ("items", markiro_host::routes::office_reports::BOX_ITEMS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("b0000000-0000-4000-8000-000000000001")
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

2. Создать `apps/standalone/proto/fixtures/box-report-rows.json`:

<!-- prettier-ignore -->
```json
{
  "id": "b0000000-0000-4000-8000-000000000001",
  "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "sscc": "046006820000015000",
  "openedAt": "2026-10-08T06:05:12.031Z",
  "closedAt": "2026-10-08T06:06:01.118Z",
  "disassembledAt": null,
  "productName": "Молоко 3,2% 0,9 л",
  "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
  "items": [
    {
      "gtin14": "04600682000013",
      "serial": "Kq8vT2mXc5Rz",
      "canonical": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
    },
    {
      "gtin14": "04600682000013",
      "serial": "Pw3nY7hLd9Fs",
      "canonical": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
    }
  ]
}
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

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
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeBox,
    OfficeLine, OfficeLoginRequest, OfficeOperator, OfficePallet, OfficeProduct, OfficeRole,
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, BoxExceptionFact, BoxLabelFact, BoxReportRows,
    CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeCheck, CodeOwner, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate,
    ErrorBody, ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeBox,
    OfficeLine, OfficeLoginRequest, OfficeOperator, OfficePallet, OfficeProduct, OfficeRole,
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    value["folder"] = Value::String("C:\\Users".into());
    assert!(serde_json::from_value::<ShiftExportRecord>(value).is_err());
}
```

заменить на

<!-- prettier-ignore -->
```rust
    value["folder"] = Value::String("C:\\Users".into());
    assert!(serde_json::from_value::<ShiftExportRecord>(value).is_err());
}

/// «Состав короба»'s data (plan О-Ф) round-trips and agrees with the export
/// source of the same shift: a box not taken apart prints exactly its live
/// codes there, ordered by GTIN and then serial, and each code's GTIN and
/// serial are the ones its canonical text carries.
#[test]
fn box_report_rows_round_trip_and_agree_with_the_export_source() {
    let report: BoxReportRows = round_trip("box-report-rows.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(report.shift_id, rows.shift.id);
    assert_eq!(report.product_name, rows.shift.product_name);
    assert_eq!(report.organization, rows.organization);
    let source = rows.boxes.iter().find(|b| b.id == report.id).unwrap();
    assert_eq!(
        (
            &report.sscc,
            &report.opened_at,
            &report.closed_at,
            &report.disassembled_at
        ),
        (
            &source.sscc,
            &source.opened_at,
            &source.closed_at,
            &source.disassembled_at
        )
    );
    let mut live: Vec<&str> = rows
        .items
        .iter()
        .filter(|i| i.box_id == report.id)
        .map(|i| {
            rows.codes
                .iter()
                .find(|c| c.code_hash == i.code_hash)
                .unwrap()
                .canonical
                .as_str()
        })
        .collect();
    live.sort_unstable();
    let printed: Vec<&str> = report.items.iter().map(|i| i.canonical.as_str()).collect();
    assert_eq!(printed, live);
    let mut ordered = report.items.clone();
    ordered.sort_by(|a, b| (&a.gtin14, &a.serial).cmp(&(&b.gtin14, &b.serial)));
    assert_eq!(ordered, report.items);
    for item in &report.items {
        assert!(
            item.canonical
                .starts_with(&format!("01{}21{}\u{1d}", item.gtin14, item.serial)),
            "{item:?}"
        );
    }
}
```

5. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  fixture("template-defaults-update.json"),
);
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));
```

заменить на

<!-- prettier-ignore -->
```ts
  fixture("template-defaults-update.json"),
);
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const BOX_ID = "b0000000-0000-4000-8000-000000000001";
const SHIFT_CREATE = shiftCreateSchema.parse(fixture("shift-create.json"));
const SHIFT_UPDATE = shiftUpdateSchema.parse(fixture("shift-update.json"));
const SHIFT_CLOSE = shiftCloseSchema.parse(fixture("shift-close.json"));
```

6. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
  [
    "getBoxReportRows",
    fixture("box-report-rows.json"),
    (api) => api.getBoxReportRows(TOKEN, BOX_ID),
    { method: "GET", path: `/v1/office/boxes/${BOX_ID}/report-data`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

7. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  canonicalSaltSchema,
  categoryTemplateDefaultSchema,
  changesResponseSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  boxReportRowsSchema,
  canonicalSaltSchema,
  categoryTemplateDefaultSchema,
  changesResponseSchema,
```

8. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["error-template-is-default.json", errorBodySchema],
  ["office-shift.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["box-report-rows.json", boxReportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

9. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    listShiftBoxes: vi.fn<HostApi["listShiftBoxes"]>(() => unexpected("listShiftBoxes")),
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    getBoxReportRows: vi.fn<HostApi["getBoxReportRows"]>(() => unexpected("getBoxReportRows")),
    ...overrides,
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: FAIL: `error[E0432]: unresolved import `markiro_proto::BoxReportRows``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`

Expected: FAIL: `error[E0433]: failed to resolve: could not find `office_reports`in`routes``.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: FAIL: `Tests  3 failed | 282 passed (285)` — «response fixture box-report-rows.json» (обе проверки: схемы нет) и `getBoxReportRows` (`api.getBoxReportRows is not a function`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod office_auth;
pub mod office_boxes;
pub mod office_exports;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod office_auth;
pub mod office_boxes;
pub mod office_exports;
pub mod office_reports;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
```

2. Создать `apps/standalone/host/src/routes/office_reports.rs`:

<!-- prettier-ignore -->
```rust
//! The data of a shift's printed forms (plan О-Ф): `GET
//! /v1/office/boxes/{id}/report-data`, every office role. The host only
//! reads: the office maps these rows to the cloud's form inputs and renders
//! the forms with `@markiro/domain`. One read transaction gives every row
//! one snapshot, and each query searches by an index, never through every
//! fact of the host.

use axum::extract::State;
use axum::Json;
use markiro_proto::{BoxReportItem, BoxReportRows, ExportOrganization};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;

/// The box with its shift's product's name now.
pub const BOX_SQL: &str = "SELECT b.id, b.shift_id, b.sscc, b.opened_at, b.closed_at, \
     b.disassembled_at, p.name AS product_name FROM boxes b \
     JOIN shifts s ON s.id = b.shift_id JOIN products p ON p.id = s.product_id WHERE b.id = ?";

/// The codes the cloud's «Состав короба» prints: the box's items neither
/// displaced nor taken out, or taken out by the box's own disassembly. They
/// are found through the scans of the box's shift (`scans_shift`, then
/// `box_items` by its key): no index of `box_items` names a box's items
/// that are no longer live, and a year of items must not be read for one box.
pub const BOX_ITEMS_SQL: &str = "SELECT s.gtin14, s.serial, s.canonical FROM boxes b \
     JOIN scans s ON s.shift_id = b.shift_id \
     JOIN box_items i ON i.scan_id = s.id AND i.box_id = b.id \
     WHERE b.id = ? AND i.displaced_at IS NULL \
     AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at) \
     ORDER BY s.gtin14, s.serial";

#[derive(sqlx::FromRow)]
struct BoxRow {
    id: String,
    shift_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    product_name: String,
}

/// `GET /v1/office/boxes/{id}/report-data`: an unknown box is `not_found`.
pub async fn box_report(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<BoxReportRows>, ApiError> {
    // Nothing here writes: the reads share one WAL snapshot and roll back.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = read_box(&mut tx, &id).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such box"))
}

async fn read_box(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<BoxReportRows>, ApiError> {
    let found: Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(found) = found else {
        return Ok(None);
    };
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let items: Vec<(String, String, String)> = sqlx::query_as(BOX_ITEMS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Some(BoxReportRows {
        id: found.id,
        shift_id: found.shift_id,
        sscc: found.sscc,
        opened_at: found.opened_at,
        closed_at: found.closed_at,
        disassembled_at: found.disassembled_at,
        product_name: found.product_name,
        organization: ExportOrganization { name, inn },
        items: items
            .into_iter()
            .map(|(gtin14, serial, canonical)| BoxReportItem {
                gtin14,
                serial,
                canonical,
            })
            .collect(),
    }))
}
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/boxes/{id}/report-data",
            get(crate::routes::office_reports::box_report),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub disassembled_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub disassembled_at: Option<String>,
}

/// `GET /v1/office/boxes/{id}/report-data` (plan О-Ф): what «Состав
/// короба» prints of one box, read in one snapshot. `items` are the codes
/// the cloud's form prints (`CodeSearchService.boxReportData`): the box's
/// live items, and of a box taken apart the items its disassembly took out
/// (`removed_at` equal to the box's `disassembled_at`: the host writes both
/// from the one instant of the `disassemble` fact), never an item taken out
/// earlier or taken by an earlier scan elsewhere; each with its scan's GTIN,
/// serial and canonical text (crypto tail included), ordered by GTIN, then
/// serial, byte for byte. `productName` is the product's name now, as the
/// cloud's form joins it; the device's instants are as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxReportRows {
    pub id: String,
    pub shift_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub product_name: String,
    pub organization: ExportOrganization,
    pub items: Vec<BoxReportItem>,
}

/// A code «Состав короба» prints: the AI 01 and AI 21 of its label line and
/// the full canonical text its DataMatrix encodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxReportItem {
    pub gtin14: String,
    pub serial: String,
    pub canonical: String,
}

#[cfg(test)]
mod tests {
    use super::{
```

5. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  officeShiftSchema,
  shiftExportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  productGroupSchema,
  officeShiftSchema,
  shiftExportRowsSchema,
  boxReportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

6. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  type ShiftCreate,
  type ShiftExportRecord,
  type ShiftExportRows,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

заменить на

<!-- prettier-ignore -->
```ts
  type ShiftCreate,
  type ShiftExportRecord,
  type ShiftExportRows,
  type BoxReportRows,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
  /** `204`: the export's files are saved; the host writes its `shift.export` audit row (plan ЧЗ). */
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  listShiftPallets: (token: string, id: string) => Promise<OfficePallet[]>;
  /** `204`: the export's files are saved; the host writes its `shift.export` audit row (plan ЧЗ). */
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
  /** What «Состав короба» prints of the box, in one snapshot (plan О-Ф); every office role. */
  getBoxReportRows: (token: string, id: string) => Promise<BoxReportRows>;
}

/** A 204 answer parses as `null`. */
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        schema: NO_CONTENT,
      });
    },
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        schema: NO_CONTENT,
      });
    },
    getBoxReportRows: (token, id) =>
      client.request("GET", `/v1/office/boxes/${id}/report-data`, {
        officeToken: token,
        schema: boxReportRowsSchema,
      }),
  };
}
```

9. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
});
export type OfficePallet = z.infer<typeof officePalletSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type OfficePallet = z.infer<typeof officePalletSchema>;

/**
 * Mirrors `markiro_proto::BoxReportRows`: `GET /v1/office/boxes/{id}/report-data`
 * (plan О-Ф), what «Состав короба» prints of one box, in one snapshot of the
 * host: the codes the cloud's form prints (the live ones, and of a box taken
 * apart those its disassembly took out), ordered by GTIN and serial, each
 * with the canonical text its DataMatrix encodes. Codes and SSCCs are plain
 * text, as in the export source.
 */
export const boxReportRowsSchema = z.object({
  id: z.string(),
  shiftId: z.uuid(),
  sscc: z.string().nullable(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  disassembledAt: z.iso.datetime().nullable(),
  productName: z.string(),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  items: z.array(z.object({ gtin14: z.string(), serial: z.string(), canonical: z.string() })),
});
export type BoxReportRows = z.infer<typeof boxReportRowsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: PASS: `test result: ok. 49 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`

Expected: PASS: `test result: ok. 3 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: PASS: `Tests  285 passed (285)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **B1** (вытесненный код в составе короба): в `apps/standalone/host/src/routes/office_reports.rs` `WHERE b.id = ? AND i.displaced_at IS NULL \` → `WHERE b.id = ? \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents`.
- **B2** (снятые расформированием коды): в `apps/standalone/host/src/routes/office_reports.rs` `AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at) \` → `AND i.removed_at IS NULL \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents`.
- **B3** (порядок по GTIN и серии): в `apps/standalone/host/src/routes/office_reports.rs` `ORDER BY s.gtin14, s.serial";` → `";`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents`.
- **B4** (поиск через сканы смены): в `apps/standalone/host/src/routes/office_reports.rs` `JOIN scans s ON s.shift_id = b.shift_id \` → `JOIN scans s ON 1 \`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `every_query_of_a_box_form_searches_by_an_index`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/office_reports.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_reports.rs apps/standalone/proto/fixtures/box-report-rows.json apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the host reads a box's contents as the cloud's «Состав короба» prints them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Паллеты смены для форм: `GET /v1/office/shifts/{id}/pallet-report-data`

«Состав паллеты», «Ярлык паллеты» и «Ярлыки паллет смены» облака читают паллету, все короба, когда-либо стоявшие на ней (расформированные тоже: в списке, вне итогов), по `closed_at`, затем `id`, и товар паллеты — текущий (название, GTIN, срок годности); ярлык датирует каждый короб объявленной датой производства его смены. Маршрут отдаёт всё это для всех паллет смены одним снимком (Ф1): из него рисуются и одна паллета, и ярлыки всей смены, согласованные между собой. Счёт единиц короба — его живые позиции (`box_items_live`): у расформированного короба их ноль, а облако считало бы позиции на момент расформирования, но ни одна форма такой счёт не печатает и не суммирует (`pallet-report.ts`: «—»; `pallet-placard.ts`: короб пропускается), поэтому байты совпадают. Паллеты — по `opened_at`, затем `id` (как список карточки); порядок ярлыков смены (`closed_at`, `id`) выбирает офис (задача 4). Тест закрепляет порядок коробов по закрытию против порядка их номеров, расформированные короб и паллету, вытесненный код, открытую паллету, паллету коллеги, роли и `EXPLAIN QUERY PLAN`.

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/routes/office_reports.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`
- Create: `apps/standalone/proto/fixtures/pallet-report-rows.json`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/tests/office_reports.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes: таблицы `shifts`, `products`, `pallets`, `boxes` (`pallet_id`), `box_items`; `shifts::format_number`; `ORGANIZATION_SQL` (план ЧЗ).
- Produces: `markiro_proto::{PalletReportRows, ReportShift, ReportPallet, ReportPalletBox}`; маршрут `GET /v1/office/shifts/{id}/pallet-report-data` (все роли, `not_found` для неизвестной смены, `pallets: []` у смены без паллет); константы `office_reports::{PALLET_SHIFT_SQL, PALLETS_SQL, PALLET_BOXES_SQL}`; Zod `palletReportRowsSchema`, тип `PalletReportRows`; `HostApi.getPalletReportRows(token, shiftId): Promise<PalletReportRows>`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/host/tests/office_reports.rs` фрагмент

<!-- prettier-ignore -->
```rust
use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, code, empty, fact, instant, issue_block, ok_scan,
    open_floor, pair_device, receipts, record_id, request, shift_setup, sscc, with_device, Admin,
    Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
```

заменить на

<!-- prettier-ignore -->
```rust
use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, code, empty, fact, instant, issue_block,
    issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device, pallet_closed,
    pallet_id, pallet_sscc, plan_shift, receipts, record_id, request, shift_body, shift_setup,
    sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
```

2. В `apps/standalone/host/tests/office_reports.rs` фрагмент

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

/// `GET /v1/office/shifts/{id}/pallet-report-data` as the administrator.
async fn pallet_report(admin: &Admin, shift: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/pallet-report-data"),
            None,
        )
        .await
}

/// The `data` of box `n` closed with `serial` over `members` on `pallet`.
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

/// A day of a shift with pallets: boxes 1 (codes 1 and 2), 3 (code 4) and
/// 2 (code 3) close in that order on pallet 1, which closes; box 3 is then
/// taken apart and a colleague's earlier scan takes code 2 from box 1. Box
/// 4 (code 5) stands on pallet 2, still open; box 5 (code 6) on pallet 3,
/// closed and then taken apart; box 6 (code 7) on no pallet. The forms read
/// every pallet of the shift opened first first, each with every box that
/// stood on it closed first first, the box taken apart too, and the live
/// units of each box now; the product's GTIN and shelf life and the shift's
/// number and date are the shift's own, never the colleague's.
#[tokio::test]
async fn the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let (p1, p2, p3) = (pallet_id(1), pallet_id(2), pallet_id(3));
    let mut take_box_apart = box_exception("disassemble", &box_id(3), &instant(45, 0));
    take_box_apart["reasonCode"] = json!("wrong_quantity");
    let take_pallet_apart = json!({
        "exception": "disassemble", "palletId": p3, "reasonCode": "wrong_quantity",
        "reasonText": null, "occurredAt": instant(80, 0)
    });
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
            scan(4, 4, 3, 25),
            fact(
                &record_id(5),
                "box_closed",
                &shift,
                closed_on(&block, 3, 1501, &[4], 25, 28, Some(&p1)),
            ),
            scan(6, 3, 2, 29),
            fact(
                &record_id(7),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1502, &[3], 29, 35, Some(&p1)),
            ),
            fact(
                &record_id(8),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 3, &instant(20, 0), &instant(40, 0)),
            ),
            fact(&record_id(9), "box_exception", &shift, take_box_apart),
            scan(10, 5, 4, 50),
            fact(
                &record_id(11),
                "box_closed",
                &shift,
                closed_on(&block, 4, 1503, &[5], 50, 60, Some(&p2)),
            ),
            scan(12, 6, 5, 61),
            fact(
                &record_id(13),
                "box_closed",
                &shift,
                closed_on(&block, 5, 1504, &[6], 61, 70, Some(&p3)),
            ),
            fact(
                &record_id(14),
                "pallet_closed",
                &shift,
                pallet_closed(&p3, &pallets, 41, 1, &instant(70, 0), &instant(75, 0)),
            ),
            fact(
                &record_id(15),
                "pallet_exception",
                &shift,
                take_pallet_apart,
            ),
            scan(16, 7, 6, 81),
            fact(
                &record_id(17),
                "box_closed",
                &shift,
                closed_on(&block, 6, 1505, &[7], 81, 85, None),
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

    let (status, report) = pallet_report(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let on = |n: u32, serial: u64, closed: u32, gone: Option<u32>, units: u32| {
        json!({
            "id": box_id(n), "sscc": sscc(serial), "closedAt": instant(closed, 0),
            "disassembledAt": gone.map(|second| instant(second, 0)), "units": units,
        })
    };
    assert_eq!(
        report,
        json!({
            "shift": {
                "id": shift, "number": floor.number, "productionDate": "2026-10-08",
                "productName": "Молоко 3,2% 0,9 л", "gtin14": "04600682000013",
                "shelfLifeDays": 10,
            },
            "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
            "pallets": [
                {
                    "id": p1, "sscc": pallet_sscc(40), "openedAt": instant(20, 0),
                    "closedAt": instant(40, 0), "disassembledAt": null,
                    "boxes": [
                        on(1, 1500, 20, None, 1),
                        on(3, 1501, 28, Some(45), 0),
                        on(2, 1502, 35, None, 1),
                    ],
                },
                {
                    "id": p2, "sscc": null, "openedAt": instant(60, 0), "closedAt": null,
                    "disassembledAt": null, "boxes": [on(4, 1503, 60, None, 1)],
                },
                {
                    "id": p3, "sscc": pallet_sscc(41), "openedAt": instant(70, 0),
                    "closedAt": instant(75, 0), "disassembledAt": instant(80, 0),
                    "boxes": [on(5, 1504, 70, None, 1)],
                },
            ],
        })
    );
    let (_, theirs) = pallet_report(&admin, &colleague.shift).await;
    assert_eq!(theirs["shift"]["number"], json!(colleague.number));
    assert_eq!(
        theirs["pallets"],
        json!([{
            "id": p11, "sscc": pallet_sscc(240), "openedAt": instant(6, 0),
            "closedAt": instant(7, 0), "disassembledAt": null,
            "boxes": [{
                "id": box_id(11), "sscc": support::app::sscc_under("460068200", 3500),
                "closedAt": instant(6, 0), "disassembledAt": null, "units": 1,
            }],
        }])
    );
}

/// Every office role reads a shift's pallet forms; a shift without pallets
/// has none; an unknown shift is `not_found`; the device key alone is no
/// office session.
#[tokio::test]
async fn every_office_role_reads_the_pallet_forms_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let path = format!("/v1/office/shifts/{id}/pallet-report-data");
    let technologist = admin.technologist().await;
    let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["shift"]["number"], planned["number"]);
    assert_eq!(body["pallets"], json!([]));
    let (status, body) = pallet_report(&admin, "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of the pallet forms searches by an index.
#[tokio::test]
async fn every_query_of_the_pallet_forms_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        (
            "shift",
            markiro_host::routes::office_reports::PALLET_SHIFT_SQL,
        ),
        ("pallets", markiro_host::routes::office_reports::PALLETS_SQL),
        (
            "boxes",
            markiro_host::routes::office_reports::PALLET_BOXES_SQL,
        ),
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

3. Создать `apps/standalone/proto/fixtures/pallet-report-rows.json`:

<!-- prettier-ignore -->
```json
{
  "shift": {
    "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
    "number": "OCT26-004",
    "productionDate": "2026-10-08",
    "productName": "Молоко 3,2% 0,9 л",
    "gtin14": "04600682000013",
    "shelfLifeDays": 10
  },
  "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
  "pallets": [
    {
      "id": "a0000000-0000-4000-8000-000000000001",
      "sscc": "146006820000000409",
      "openedAt": "2026-10-08T06:06:01.118Z",
      "closedAt": "2026-10-08T06:20:44.650Z",
      "disassembledAt": null,
      "boxes": [
        {
          "id": "b0000000-0000-4000-8000-000000000001",
          "sscc": "046006820000015000",
          "closedAt": "2026-10-08T06:06:01.118Z",
          "disassembledAt": null,
          "units": 2
        }
      ]
    }
  ]
}
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
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

заменить на

<!-- prettier-ignore -->
```rust
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact,
    PalletExceptionFact, PalletExceptionKind, PalletLabelFact, PalletReportRows, PasswordChange,
    PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate,
    ScanFact, ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate,
    ShiftExportRecord, ShiftExportRows, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate,
    SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "{item:?}"
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
            "{item:?}"
        );
    }
}

/// The pallets' forms data (plan О-Ф) round-trips and agrees with the
/// office's lists and the export source of the same shift: the same pallets
/// opened first first, each box the export source puts on the pallet, closed
/// first first, with the live units the box list counts, and a pallet's
/// boxes and units not taken apart are the list's.
#[test]
fn pallet_report_rows_round_trip_and_agree_with_the_lists() {
    let report: PalletReportRows = round_trip("pallet-report-rows.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    let boxes: Vec<OfficeBox> = serde_json::from_value(fixture("office-boxes.json")).unwrap();
    let pallets: Vec<OfficePallet> =
        serde_json::from_value(fixture("office-pallets.json")).unwrap();
    assert_eq!(report.shift.id, rows.shift.id);
    assert_eq!(report.shift.number, rows.shift.number);
    assert_eq!(report.shift.production_date, rows.shift.production_date);
    assert_eq!(report.shift.product_name, rows.shift.product_name);
    assert_eq!(report.organization, rows.organization);
    assert_eq!(
        report.pallets.iter().map(|p| &p.id).collect::<Vec<_>>(),
        pallets.iter().map(|p| &p.id).collect::<Vec<_>>()
    );
    for (pallet, listed) in report.pallets.iter().zip(&pallets) {
        assert_eq!(
            (&pallet.sscc, &pallet.closed_at, &pallet.disassembled_at),
            (&listed.sscc, &listed.closed_at, &listed.disassembled_at)
        );
        let mut on: Vec<&OfficeBox> = boxes
            .iter()
            .filter(|b| b.pallet_id.as_deref() == Some(&pallet.id))
            .collect();
        on.sort_by(|a, b| (&a.closed_at, &a.id).cmp(&(&b.closed_at, &b.id)));
        assert_eq!(
            pallet.boxes.iter().map(|b| &b.id).collect::<Vec<_>>(),
            on.iter().map(|b| &b.id).collect::<Vec<_>>()
        );
        for (printed, listed_box) in pallet.boxes.iter().zip(&on) {
            assert_eq!(printed.units, listed_box.units, "{printed:?}");
            assert_eq!(Some(&printed.closed_at), listed_box.closed_at.as_ref());
        }
        let standing: Vec<_> = pallet
            .boxes
            .iter()
            .filter(|b| b.disassembled_at.is_none())
            .collect();
        assert_eq!(usize::try_from(listed.boxes).unwrap(), standing.len());
        assert_eq!(
            listed.units,
            standing.iter().map(|b| u64::from(b.units)).sum::<u64>()
        );
    }
}
```

6. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/boxes/${BOX_ID}/report-data`, body: undefined },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

заменить на

<!-- prettier-ignore -->
```ts
    { method: "GET", path: `/v1/office/boxes/${BOX_ID}/report-data`, body: undefined },
  ],
  [
    "getPalletReportRows",
    fixture("pallet-report-rows.json"),
    (api) => api.getPalletReportRows(TOKEN, SHIFT_ID),
    {
      method: "GET",
      path: `/v1/office/shifts/${SHIFT_ID}/pallet-report-data`,
      body: undefined,
    },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
```

7. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  operatorBadgeRecordSchema,
  operatorCreateSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  palletReportRowsSchema,
  officeUserUpdateSchema,
  operatorBadgeRecordSchema,
  operatorCreateSchema,
```

8. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ["office-shift.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["box-report-rows.json", boxReportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  ["office-shift.json", officeShiftSchema],
  ["shift-export-rows.json", shiftExportRowsSchema],
  ["box-report-rows.json", boxReportRowsSchema],
  ["pallet-report-rows.json", palletReportRowsSchema],
  ["error-shift-busy.json", errorBodySchema],
  ["error-sscc-exhausted.json", errorBodySchema],
] as const;
```

9. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    getBoxReportRows: vi.fn<HostApi["getBoxReportRows"]>(() => unexpected("getBoxReportRows")),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    listShiftPallets: vi.fn<HostApi["listShiftPallets"]>(() => unexpected("listShiftPallets")),
    recordShiftExport: vi.fn<HostApi["recordShiftExport"]>(() => unexpected("recordShiftExport")),
    getBoxReportRows: vi.fn<HostApi["getBoxReportRows"]>(() => unexpected("getBoxReportRows")),
    getPalletReportRows: vi.fn<HostApi["getPalletReportRows"]>(() =>
      unexpected("getPalletReportRows"),
    ),
    ...overrides,
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: FAIL: `error[E0432]: unresolved import `markiro_proto::PalletReportRows``.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`

Expected: FAIL: `error[E0425]: cannot find value `PALLET_SHIFT_SQL`in module`markiro_host::routes::office_reports`` (и `PALLETS_SQL`, `PALLET_BOXES_SQL`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: FAIL: `Tests  3 failed | 285 passed (288)`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/routes/office_reports.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! The data of a shift's printed forms (plan О-Ф): `GET
//! /v1/office/boxes/{id}/report-data`, every office role. The host only
//! reads: the office maps these rows to the cloud's form inputs and renders
//! the forms with `@markiro/domain`. One read transaction gives every row
//! one snapshot, and each query searches by an index, never through every
```

заменить на

<!-- prettier-ignore -->
```rust
//! The data of a shift's printed forms (plan О-Ф): `GET
//! /v1/office/boxes/{id}/report-data` and `GET
//! /v1/office/shifts/{id}/pallet-report-data`, every office role. The host only
//! reads: the office maps these rows to the cloud's form inputs and renders
//! the forms with `@markiro/domain`. One read transaction gives every row
//! one snapshot, and each query searches by an index, never through every
```

2. В `apps/standalone/host/src/routes/office_reports.rs` фрагмент

<!-- prettier-ignore -->
```rust

use axum::extract::State;
use axum::Json;
use markiro_proto::{BoxReportItem, BoxReportRows, ExportOrganization};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;

/// The box with its shift's product's name now.
pub const BOX_SQL: &str = "SELECT b.id, b.shift_id, b.sscc, b.opened_at, b.closed_at, \
```

заменить на

<!-- prettier-ignore -->
```rust

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    BoxReportItem, BoxReportRows, ExportOrganization, PalletReportRows, ReportPallet,
    ReportPalletBox, ReportShift,
};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;
use crate::shifts;

/// The box with its shift's product's name now.
pub const BOX_SQL: &str = "SELECT b.id, b.shift_id, b.sscc, b.opened_at, b.closed_at, \
```

3. В `apps/standalone/host/src/routes/office_reports.rs` фрагмент

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

/// The shift with its product now.
pub const PALLET_SHIFT_SQL: &str = "SELECT s.id, s.number_month_key, s.number_seq, \
     s.created_from, s.production_date, p.name AS product_name, p.gtin14, p.shelf_life_days \
     FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?";

/// Every pallet of the shift, opened first first.
pub const PALLETS_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at \
     FROM pallets WHERE shift_id = ? ORDER BY opened_at, id";

/// Every box of the shift that stood on a pallet, closed first first on each
/// pallet (the cloud's `closed_at, id`), with its live items through
/// `box_items_live`.
pub const PALLET_BOXES_SQL: &str = "SELECT b.pallet_id, b.id, b.sscc, b.closed_at, \
     b.disassembled_at, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
     FROM boxes b WHERE b.shift_id = ? AND b.pallet_id IS NOT NULL \
     ORDER BY b.pallet_id, b.closed_at, b.id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    production_date: String,
    product_name: String,
    gtin14: String,
    shelf_life_days: Option<u32>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletBoxRow {
    pallet_id: String,
    id: String,
    sscc: Option<String>,
    closed_at: String,
    disassembled_at: Option<String>,
    units: i64,
}

/// `GET /v1/office/shifts/{id}/pallet-report-data`: an unknown shift is
/// `not_found`; a shift without pallets answers with none.
pub async fn pallet_report(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<PalletReportRows>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = read_pallets(&mut tx, &id).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

async fn read_pallets(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<PalletReportRows>, ApiError> {
    let shift: Option<ShiftRow> = sqlx::query_as(PALLET_SHIFT_SQL)
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
    let pallets: Vec<PalletRow> = sqlx::query_as(PALLETS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let boxes: Vec<PalletBoxRow> = sqlx::query_as(PALLET_BOXES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let mut on_pallets: std::collections::HashMap<String, Vec<ReportPalletBox>> =
        std::collections::HashMap::new();
    for row in boxes {
        on_pallets
            .entry(row.pallet_id)
            .or_default()
            .push(ReportPalletBox {
                id: row.id,
                sscc: row.sscc,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                units: u32::try_from(row.units).map_err(ApiError::internal)?,
            });
    }
    let created_from = shift.created_from.parse().map_err(ApiError::internal)?;
    Ok(Some(PalletReportRows {
        shift: ReportShift {
            number: shifts::format_number(&shift.number_month_key, shift.number_seq, created_from),
            id: shift.id,
            production_date: shift.production_date,
            product_name: shift.product_name,
            gtin14: shift.gtin14,
            shelf_life_days: shift.shelf_life_days,
        },
        organization: ExportOrganization { name, inn },
        pallets: pallets
            .into_iter()
            .map(|row| ReportPallet {
                boxes: on_pallets.remove(&row.id).unwrap_or_default(),
                id: row.id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
            })
            .collect(),
    }))
}
```

4. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/boxes/{id}/report-data",
            get(crate::routes::office_reports::box_report),
        )
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/shifts/{id}/pallet-report-data",
            get(crate::routes::office_reports::pallet_report),
        )
        .route(
            "/v1/office/boxes/{id}/report-data",
            get(crate::routes::office_reports::box_report),
        )
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub canonical: String,
}

#[cfg(test)]
mod tests {
    use super::{
```

заменить на

<!-- prettier-ignore -->
```rust
    pub canonical: String,
}

/// `GET /v1/office/shifts/{id}/pallet-report-data` (plan О-Ф): what
/// «Состав паллеты» and «Ярлык паллеты» print of the shift's pallets, read
/// in one snapshot, so the placards of the whole shift agree with each
/// other. `pallets` are every pallet of the shift, opened first first;
/// each pallet's `boxes` every box that ever stood on it, closed first first
/// (then by id), boxes taken apart included, as the cloud's forms list them;
/// a box's `units` are its live items now (a box taken apart has none: the
/// forms print it without a count and count it nowhere).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletReportRows {
    pub shift: ReportShift,
    pub organization: ExportOrganization,
    pub pallets: Vec<ReportPallet>,
}

/// The shift of [`PalletReportRows`]: its number, its production date and
/// its product now (name, GTIN, shelf life), as the cloud's forms join the
/// live product.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportShift {
    pub id: String,
    pub number: String,
    pub production_date: String,
    pub product_name: String,
    pub gtin14: String,
    pub shelf_life_days: Option<u32>,
}

/// A pallet of the shift with the boxes that stood on it; the device's
/// instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: Vec<ReportPalletBox>,
}

/// A box that stood on a pallet: it joined at its close, so it is closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPalletBox {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: String,
    pub disassembled_at: Option<String>,
    pub units: u32,
}

#[cfg(test)]
mod tests {
    use super::{
```

6. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  officeShiftSchema,
  shiftExportRowsSchema,
  boxReportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
  officeShiftSchema,
  shiftExportRowsSchema,
  boxReportRowsSchema,
  palletReportRowsSchema,
  ssccCounterSchema,
  ssccStateSchema,
  templateDefaultsSchema,
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  type ShiftExportRecord,
  type ShiftExportRows,
  type BoxReportRows,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

заменить на

<!-- prettier-ignore -->
```ts
  type ShiftExportRecord,
  type ShiftExportRows,
  type BoxReportRows,
  type PalletReportRows,
  type ShiftUpdate,
  type SsccCounter,
  type SsccCounterUpdate,
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
  /** What «Состав короба» prints of the box, in one snapshot (plan О-Ф); every office role. */
  getBoxReportRows: (token: string, id: string) => Promise<BoxReportRows>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
  recordShiftExport: (token: string, id: string, record: ShiftExportRecord) => Promise<void>;
  /** What «Состав короба» prints of the box, in one snapshot (plan О-Ф); every office role. */
  getBoxReportRows: (token: string, id: string) => Promise<BoxReportRows>;
  /**
   * What «Состав паллеты» and «Ярлык паллеты» print of the shift's pallets, in
   * one snapshot (plan О-Ф); every office role. A shift without pallets has none.
   */
  getPalletReportRows: (token: string, id: string) => Promise<PalletReportRows>;
}

/** A 204 answer parses as `null`. */
```

9. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: boxReportRowsSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: boxReportRowsSchema,
      }),
    getPalletReportRows: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/pallet-report-data`, {
        officeToken: token,
        schema: palletReportRowsSchema,
      }),
  };
}
```

10. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
});
export type BoxReportRows = z.infer<typeof boxReportRowsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
});
export type BoxReportRows = z.infer<typeof boxReportRowsSchema>;

/**
 * Mirrors `markiro_proto::PalletReportRows`: `GET
 * /v1/office/shifts/{id}/pallet-report-data` (plan О-Ф), what «Состав паллеты»
 * and «Ярлык паллеты» print of the shift's pallets, in one snapshot: the
 * shift's number, date and product now, and every pallet opened first first
 * with every box that stood on it closed first first, the boxes taken apart
 * too; a box's `units` are its live items now.
 */
export const palletReportRowsSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    number: z.string().min(1),
    productionDate: civilDateTextSchema,
    productName: z.string(),
    gtin14: z.string(),
    shelfLifeDays: z.number().int().positive().nullable(),
  }),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  pallets: z.array(
    z.object({
      id: z.string(),
      sscc: z.string().nullable(),
      openedAt: z.iso.datetime(),
      closedAt: z.iso.datetime().nullable(),
      disassembledAt: z.iso.datetime().nullable(),
      boxes: z.array(
        z.object({
          id: z.string(),
          sscc: z.string().nullable(),
          closedAt: z.iso.datetime(),
          disassembledAt: z.iso.datetime().nullable(),
          units: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type PalletReportRows = z.infer<typeof palletReportRowsSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test fixtures`

Expected: PASS: `test result: ok. 50 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`

Expected: PASS: `test result: ok. 6 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`

Expected: PASS: `Tests  288 passed (288)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **P1** (короба паллеты по закрытию): в `apps/standalone/host/src/routes/office_reports.rs` `ORDER BY b.pallet_id, b.closed_at, b.id";` → `ORDER BY b.pallet_id, b.id";`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it`.
- **P2** (живые единицы короба): в `apps/standalone/host/src/routes/office_reports.rs` фрагмент

<!-- prettier-ignore -->
```rust
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
     FROM boxes b WHERE b.shift_id = ? AND b.pallet_id IS NOT NULL
```

заменить на

<!-- prettier-ignore -->
```rust
      AND i.removed_at IS NULL) AS units \
     FROM boxes b WHERE b.shift_id = ? AND b.pallet_id IS NOT NULL
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `every_query_of_the_pallet_forms_searches_by_an_index`, `the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it`.

- **P3** (паллеты по открытию): в `apps/standalone/host/src/routes/office_reports.rs` `FROM pallets WHERE shift_id = ? ORDER BY opened_at, id";` → `FROM pallets WHERE shift_id = ? ORDER BY opened_at DESC, id";`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test office_reports`. Ожидается: FAIL — `the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/routes/office_reports.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/office_reports.rs apps/standalone/proto/fixtures/pallet-report-rows.json apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/api.ts apps/standalone/src/host/protocol.ts apps/standalone/test/api.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the host reads a shift's pallets with every box that stood on them for the pallet forms" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Эталон HTML из кода облака: общие случаи и облачный тест паритета форм

Формы рисует один и тот же код (`@markiro/domain`), поэтому байты расходятся только там, где расходятся входные данные. Эталон выводится из облака: облачный тест прогоняет вход, который вернул бы загрузчик облака для фактов случая (`cloud`), через **настоящие** контроллеры облака — `CodeSearchController.boxReport`, `palletReport`, `palletPlacard`, `shiftPlacards` и `ShiftsController.taskForm` (разбор запроса их же Zod-схемами: пояс по умолчанию `UTC`, бумага `a4`; заголовок `Content-Type`), — и пишет или сверяет HTML. Загрузчики облака — SQL по Postgres; они не запускаются (базы в тесте нет), их правила перенесены задачами 1–2 и закреплены тестами хоста, а случаи задают их вход с указанием строк облака. Тот же случай несёт те же факты в форме ответа хоста (`host`) — по ним рисует офис (задача 4).

Десять случаев: закрытый короб (Москва; серия с `&<>"'` — экранирование строки КМ), расформированный короб (Екатеринбург; снятые расформированием коды), открытый пустой короб организации без ИНН («ИНН не указан», «Короб пуст»), «Состав паллеты» закрытой (Владивосток; расформированный короб с «—», облако считает ему 12 кодов, хост 0) и открытой паллеты («Без SSCC»), ярлык A4 (срок годности 10 дней: годен до 17.10.2026) и A5 расформированной паллеты без срока годности (водяной знак), ярлыки смены A5 (из пяти паллет — три закрытые стоящие, по закрытию: …41, …40, …43; номер `OCT26-004/S`), бланк запланированной смены с паллетами и контрагентом и бланк активной смены без паллет, плана и названия для печати.

**Files:**

- Create: `packages/domain/test/fixtures/print-forms-parity/cases.json`, `packages/domain/test/fixtures/print-forms-parity/golden.json` (пишет тест), `apps/api/test/standalone-forms-parity.test.ts`

**Interfaces:**

- Consumes: облачные `CodeSearchController`, `ShiftsController`, `boxReportQuerySchema`, `palletPlacardQuerySchema`; типы `BoxReportData`, `PalletReportData`, `PalletPlacardData`, `ShiftTaskFormData` из `@markiro/domain`.
- Produces: `cases.json` — `{ cases: [...] }`, случай — `{ name, form: "box"|"pallet"|"placard"|"placards"|"task", timeZone? (box, pallet), format? (placard, placards), palletId? (pallet, placard), generatedAt? (task), cloud, host }`; `cloud` — вход формы, как его возвращает загрузчик облака (моменты — ISO-строки), `host` — `{ rows: BoxReportRows | PalletReportRows }` или для бланка `{ shift: OfficeShift, product: OfficeProduct, line: OfficeLine, counterparty: CounterpartyRecord | null, organization: OrgProfile }`; `golden.json` — `{ <name>: { bytes, sha256, html } }`. Задача 4 читает оба файла.

- [ ] **Step 1: Случаи и облачный тест**

1. Создать `apps/api/test/standalone-forms-parity.test.ts`:

<!-- prettier-ignore -->
```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BoxReportData,
  PalletPlacardData,
  PalletReportData,
  ShiftTaskFormData,
} from "@markiro/domain";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodeSearchController } from "../src/modules/code-search/code-search.controller";
import type { CodeSearchService } from "../src/modules/code-search/code-search.service";
import { boxReportQuerySchema, palletPlacardQuerySchema } from "../src/modules/code-search/dto";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import type { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

/**
 * The cloud's half of the printed forms' parity between the cloud and
 * «Markiro Автоном» (plan О-Ф of `apps/standalone`). Each case of
 * `packages/domain/test/fixtures/print-forms-parity/cases.json` holds a form's
 * input as the cloud's loader returns it for some facts (`cloud`) and the
 * same facts as the standalone host answers them (`host`). Here the cloud's
 * own controllers (`CodeSearchController`, `ShiftsController.taskForm`) serve
 * the `cloud` input through their query parsing and their renderer, and the
 * HTML they answer must equal `golden.json`; the standalone office maps the
 * `host` rows and must render the same bytes
 * (`apps/standalone/test/forms-parity.test.ts`). A legitimate change of a
 * cloud form regenerates the golden from this test alone:
 * `FORMS_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run
 * test/standalone-forms-parity.test.ts`; the standalone mapping must then
 * render the same bytes.
 */

const FIXTURES = join(__dirname, "../../../packages/domain/test/fixtures/print-forms-parity");
const TENANT = "tenant-1";
const ID = "a0000000-0000-4000-8000-000000000001";

const instant = z.iso.datetime();
const org = z.object({ name: z.string(), inn: z.string().nullable(), logo: z.null() }).strict();
const boxSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    org: org.nullable(),
    openedAt: instant,
    closedAt: instant.nullable(),
    disassembledAt: instant.nullable(),
    codes: z.array(
      z.object({ gtin14: z.string(), serial: z.string(), rawKm: z.string() }).strict(),
    ),
  })
  .strict();
const palletSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    org: org.nullable(),
    openedAt: instant,
    closedAt: instant.nullable(),
    disassembledAt: instant.nullable(),
    boxes: z.array(
      z
        .object({
          sscc: z.string().nullable(),
          codeCount: z.number().int(),
          disassembledAt: instant.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const placardSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    gtin14: z.string().nullable(),
    shelfLifeDays: z.number().int().nullable(),
    org: org.nullable(),
    boxes: z.array(
      z
        .object({
          productionDate: z.string().nullable(),
          codeCount: z.number().int(),
          disassembledAt: instant.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const taskSchema = z
  .object({
    shiftId: z.uuid(),
    shiftNumber: z.string(),
    status: z.enum(["planned", "active"]),
    mode: z.enum(["validation", "aggregation"]),
    organizationName: z.string(),
    productId: z.uuid(),
    productName: z.string(),
    productPrintName: z.string().nullable(),
    gtin14: z.string(),
    imageChecksum: z.string().nullable(),
    lineName: z.string().nullable(),
    plannedDate: z.string().nullable(),
    productionDate: z.string().nullable(),
    plannedQty: z.number().int().nullable(),
    boxCapacity: z.number().int().nullable(),
    palletsEnabled: z.boolean(),
    palletBoxCapacity: z.number().int().nullable(),
    counterpartyName: z.string().nullable(),
    ssccIssuerName: z.string().nullable(),
    validationPrintMode: z.enum(["none", "duplicate_dm"]),
    validationPrintVerification: z.enum(["none", "required"]),
    allowPreviouslyAcceptedCodes: z.boolean(),
    generatedAt: instant,
  })
  .strict();
const caseSchema = z.discriminatedUnion("form", [
  z.object({ name: z.string(), form: z.literal("box"), timeZone: z.string(), cloud: boxSchema }),
  z.object({
    name: z.string(),
    form: z.literal("pallet"),
    timeZone: z.string(),
    palletId: z.uuid(),
    cloud: palletSchema,
  }),
  z.object({
    name: z.string(),
    form: z.literal("placard"),
    format: z.enum(["a4", "a5"]),
    palletId: z.uuid(),
    cloud: placardSchema,
  }),
  z.object({
    name: z.string(),
    form: z.literal("placards"),
    format: z.enum(["a4", "a5"]),
    cloud: z
      .object({ shiftNumber: z.string().nullable(), pallets: z.array(placardSchema) })
      .strict(),
  }),
  z.object({
    name: z.string(),
    form: z.literal("task"),
    generatedAt: instant,
    cloud: taskSchema,
  }),
]);
type ParityCase = z.infer<typeof caseSchema>;
const goldenSchema = z.record(
  z.string(),
  z.object({ bytes: z.number().int(), sha256: z.string(), html: z.string() }).strict(),
);
type Golden = z.infer<typeof goldenSchema>;

const cases = z
  .object({ cases: z.array(caseSchema) })
  .parse(JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"))).cases;

/** `null` stays `null`; an ISO instant becomes the `Date` the loaders return. */
function at(value: string): Date;
function at(value: string | null): Date | null;
function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function boxData(data: z.infer<typeof boxSchema>): BoxReportData {
  return {
    ...data,
    openedAt: at(data.openedAt),
    closedAt: at(data.closedAt),
    disassembledAt: at(data.disassembledAt),
  };
}

function palletData(data: z.infer<typeof palletSchema>): PalletReportData {
  return {
    ...data,
    openedAt: at(data.openedAt),
    closedAt: at(data.closedAt),
    disassembledAt: at(data.disassembledAt),
    boxes: data.boxes.map((box) => ({ ...box, disassembledAt: at(box.disassembledAt) })),
  };
}

function placardData(data: z.infer<typeof placardSchema>): PalletPlacardData {
  return {
    ...data,
    boxes: data.boxes.map((box) => ({ ...box, disassembledAt: at(box.disassembledAt) })),
  };
}

function taskData(data: z.infer<typeof taskSchema>): ShiftTaskFormData {
  return { ...data, generatedAt: at(data.generatedAt) };
}

const request = { tenantId: TENANT } as RequestWithTenant;

/** The HTML the cloud's controller answers for the case, its headers checked. */
async function serve(parityCase: ParityCase): Promise<string> {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
  } as unknown as Response;
  let html: string;
  if (parityCase.form === "task") {
    const service = {
      taskFormData: vi.fn(async () => taskData(parityCase.cloud)),
    } as unknown as ShiftsService;
    html = await new ShiftsController(service).taskForm(request, ID, response);
  } else {
    const service = {
      boxReportData: vi.fn(async () =>
        parityCase.form === "box" ? boxData(parityCase.cloud) : undefined,
      ),
      palletReportData: vi.fn(async () =>
        parityCase.form === "pallet" ? palletData(parityCase.cloud) : undefined,
      ),
      palletPlacardData: vi.fn(async () =>
        parityCase.form === "placard" ? placardData(parityCase.cloud) : undefined,
      ),
      shiftPlacardsData: vi.fn(async () =>
        parityCase.form === "placards"
          ? {
              shiftNumber: parityCase.cloud.shiftNumber,
              pallets: parityCase.cloud.pallets.map(placardData),
            }
          : undefined,
      ),
    } as unknown as CodeSearchService;
    const controller = new CodeSearchController(service);
    switch (parityCase.form) {
      case "box":
        html = await controller.boxReport(
          request,
          ID,
          response,
          boxReportQuerySchema.parse({ timeZone: parityCase.timeZone }),
        );
        break;
      case "pallet":
        html = await controller.palletReport(
          request,
          parityCase.palletId,
          response,
          boxReportQuerySchema.parse({ timeZone: parityCase.timeZone }),
        );
        break;
      case "placard":
        html = await controller.palletPlacard(
          request,
          parityCase.palletId,
          response,
          palletPlacardQuerySchema.parse({ format: parityCase.format }),
        );
        break;
      case "placards":
        html = await controller.shiftPlacards(
          request,
          ID,
          response,
          palletPlacardQuerySchema.parse({ format: parityCase.format }),
        );
        break;
    }
  }
  expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  return html;
}

describe("printed forms parity with «Markiro Автоном» (plan О-Ф)", () => {
  it("the cloud's controllers answer the golden HTML for every shared case", async () => {
    const outcomes: Golden = {};
    for (const parityCase of cases) {
      const html = await serve(parityCase);
      outcomes[parityCase.name] = {
        bytes: Buffer.byteLength(html, "utf8"),
        sha256: createHash("sha256").update(html, "utf8").digest("hex"),
        html,
      };
    }
    const path = join(FIXTURES, "golden.json");
    if (process.env.FORMS_PARITY_WRITE === "1") {
      writeFileSync(path, `${JSON.stringify(outcomes, null, 2)}\n`);
    }
    const golden = goldenSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(Object.keys(golden)).toEqual(cases.map((parityCase) => parityCase.name));
    for (const parityCase of cases) {
      expect(outcomes[parityCase.name], parityCase.name).toEqual(golden[parityCase.name]);
    }
  });
});
```

2. Создать `packages/domain/test/fixtures/print-forms-parity/cases.json`:

<!-- prettier-ignore -->
```json
{
  "cases": [
    {
      "name": "box-closed",
      "form": "box",
      "timeZone": "Europe/Moscow",
      "host": {
        "rows": {
          "id": "b0000000-0000-4000-8000-000000000001",
          "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
          "sscc": "046006820000015000",
          "openedAt": "2026-10-08T06:05:12.031Z",
          "closedAt": "2026-10-08T06:06:01.118Z",
          "disassembledAt": null,
          "productName": "Молоко 3,2% 0,9 л",
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "items": [
            {
              "gtin14": "04600682000013",
              "serial": "Kq8vT2mXc5Rz",
              "canonical": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
            },
            {
              "gtin14": "04600682000013",
              "serial": "Pw3nY7hLd9Fs",
              "canonical": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
            },
            {
              "gtin14": "04600682000013",
              "serial": "a&b<c>\"d'e",
              "canonical": "010460068200001321a&b<c>\"d'e\u001d93Ef3X"
            }
          ]
        }
      },
      "cloud": {
        "sscc": "00046006820000015000",
        "status": "closed",
        "productName": "Молоко 3,2% 0,9 л",
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "openedAt": "2026-10-08T06:05:12.031Z",
        "closedAt": "2026-10-08T06:06:01.118Z",
        "disassembledAt": null,
        "codes": [
          {
            "gtin14": "04600682000013",
            "serial": "Kq8vT2mXc5Rz",
            "rawKm": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
          },
          {
            "gtin14": "04600682000013",
            "serial": "Pw3nY7hLd9Fs",
            "rawKm": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
          },
          {
            "gtin14": "04600682000013",
            "serial": "a&b<c>\"d'e",
            "rawKm": "010460068200001321a&b<c>\"d'e\u001d93Ef3X"
          }
        ]
      }
    },
    {
      "name": "box-disassembled",
      "form": "box",
      "timeZone": "Asia/Yekaterinburg",
      "host": {
        "rows": {
          "id": "b0000000-0000-4000-8000-000000000002",
          "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
          "sscc": "046006820000015017",
          "openedAt": "2026-10-08T06:06:40.507Z",
          "closedAt": "2026-10-08T06:07:15.902Z",
          "disassembledAt": "2026-10-08T21:30:00.000Z",
          "productName": "Молоко 3,2% 0,9 л",
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "items": [
            {
              "gtin14": "04600682000013",
              "serial": "Kq8vT2mXc5Rz",
              "canonical": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
            },
            {
              "gtin14": "04600682000013",
              "serial": "Pw3nY7hLd9Fs",
              "canonical": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
            }
          ]
        }
      },
      "cloud": {
        "sscc": "00046006820000015017",
        "status": "disassembled",
        "productName": "Молоко 3,2% 0,9 л",
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "openedAt": "2026-10-08T06:06:40.507Z",
        "closedAt": "2026-10-08T06:07:15.902Z",
        "disassembledAt": "2026-10-08T21:30:00.000Z",
        "codes": [
          {
            "gtin14": "04600682000013",
            "serial": "Kq8vT2mXc5Rz",
            "rawKm": "010460068200001321Kq8vT2mXc5Rz\u001d93Ab1Z"
          },
          {
            "gtin14": "04600682000013",
            "serial": "Pw3nY7hLd9Fs",
            "rawKm": "010460068200001321Pw3nY7hLd9Fs\u001d93Cd2Y"
          }
        ]
      }
    },
    {
      "name": "box-open-empty",
      "form": "box",
      "timeZone": "UTC",
      "host": {
        "rows": {
          "id": "b0000000-0000-4000-8000-000000000003",
          "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
          "sscc": null,
          "openedAt": "2026-10-08T06:08:02.244Z",
          "closedAt": null,
          "disassembledAt": null,
          "productName": "Молоко 3,2% 0,9 л",
          "organization": {
            "name": "ИП Петров",
            "inn": null
          },
          "items": []
        }
      },
      "cloud": {
        "sscc": null,
        "status": "open",
        "productName": "Молоко 3,2% 0,9 л",
        "org": {
          "name": "ИП Петров",
          "inn": null,
          "logo": null
        },
        "openedAt": "2026-10-08T06:08:02.244Z",
        "closedAt": null,
        "disassembledAt": null,
        "codes": []
      }
    },
    {
      "name": "pallet-report-closed",
      "form": "pallet",
      "timeZone": "Asia/Vladivostok",
      "palletId": "a0000000-0000-4000-8000-000000000001",
      "host": {
        "rows": {
          "shift": {
            "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
            "number": "OCT26-004/S",
            "productionDate": "2026-10-08",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10
          },
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "pallets": [
            {
              "id": "a0000000-0000-4000-8000-000000000001",
              "sscc": "146006820000000409",
              "openedAt": "2026-10-08T06:06:01.118Z",
              "closedAt": "2026-10-08T07:20:44.650Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000001",
                  "sscc": "046006820000015000",
                  "closedAt": "2026-10-08T06:06:01.118Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000003",
                  "sscc": "046006820000015024",
                  "closedAt": "2026-10-08T06:30:00.000Z",
                  "disassembledAt": "2026-10-08T07:40:00.000Z",
                  "units": 0
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000002",
                  "sscc": "046006820000015017",
                  "closedAt": "2026-10-08T06:45:10.000Z",
                  "disassembledAt": null,
                  "units": 11
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000002",
              "sscc": null,
              "openedAt": "2026-10-08T09:00:00.000Z",
              "closedAt": null,
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000009",
                  "sscc": "046006820000015086",
                  "closedAt": "2026-10-08T09:00:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000003",
              "sscc": "146006820000000416",
              "openedAt": "2026-10-08T05:00:00.000Z",
              "closedAt": "2026-10-08T05:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000004",
                  "sscc": "046006820000015031",
                  "closedAt": "2026-10-08T05:10:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000005",
                  "sscc": "046006820000015048",
                  "closedAt": "2026-10-08T05:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000004",
              "sscc": "146006820000000423",
              "openedAt": "2026-10-08T07:50:00.000Z",
              "closedAt": "2026-10-08T08:10:00.000Z",
              "disassembledAt": "2026-10-08T08:30:00.000Z",
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000006",
                  "sscc": "046006820000015055",
                  "closedAt": "2026-10-08T07:55:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000005",
              "sscc": "146006820000000430",
              "openedAt": "2026-10-08T08:15:00.000Z",
              "closedAt": "2026-10-08T08:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000007",
                  "sscc": "046006820000015062",
                  "closedAt": "2026-10-08T08:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000008",
                  "sscc": "046006820000015079",
                  "closedAt": "2026-10-08T08:40:00.000Z",
                  "disassembledAt": null,
                  "units": 10
                }
              ]
            }
          ]
        }
      },
      "cloud": {
        "sscc": "00146006820000000409",
        "status": "closed",
        "productName": "Молоко 3,2% 0,9 л",
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "openedAt": "2026-10-08T06:06:01.118Z",
        "closedAt": "2026-10-08T07:20:44.650Z",
        "disassembledAt": null,
        "boxes": [
          {
            "sscc": "00046006820000015000",
            "codeCount": 12,
            "disassembledAt": null
          },
          {
            "sscc": "00046006820000015024",
            "codeCount": 12,
            "disassembledAt": "2026-10-08T07:40:00.000Z"
          },
          {
            "sscc": "00046006820000015017",
            "codeCount": 11,
            "disassembledAt": null
          }
        ]
      }
    },
    {
      "name": "pallet-report-open",
      "form": "pallet",
      "timeZone": "Europe/Moscow",
      "palletId": "a0000000-0000-4000-8000-000000000002",
      "host": {
        "rows": {
          "shift": {
            "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
            "number": "OCT26-004/S",
            "productionDate": "2026-10-08",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10
          },
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "pallets": [
            {
              "id": "a0000000-0000-4000-8000-000000000001",
              "sscc": "146006820000000409",
              "openedAt": "2026-10-08T06:06:01.118Z",
              "closedAt": "2026-10-08T07:20:44.650Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000001",
                  "sscc": "046006820000015000",
                  "closedAt": "2026-10-08T06:06:01.118Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000003",
                  "sscc": "046006820000015024",
                  "closedAt": "2026-10-08T06:30:00.000Z",
                  "disassembledAt": "2026-10-08T07:40:00.000Z",
                  "units": 0
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000002",
                  "sscc": "046006820000015017",
                  "closedAt": "2026-10-08T06:45:10.000Z",
                  "disassembledAt": null,
                  "units": 11
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000002",
              "sscc": null,
              "openedAt": "2026-10-08T09:00:00.000Z",
              "closedAt": null,
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000009",
                  "sscc": "046006820000015086",
                  "closedAt": "2026-10-08T09:00:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000003",
              "sscc": "146006820000000416",
              "openedAt": "2026-10-08T05:00:00.000Z",
              "closedAt": "2026-10-08T05:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000004",
                  "sscc": "046006820000015031",
                  "closedAt": "2026-10-08T05:10:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000005",
                  "sscc": "046006820000015048",
                  "closedAt": "2026-10-08T05:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000004",
              "sscc": "146006820000000423",
              "openedAt": "2026-10-08T07:50:00.000Z",
              "closedAt": "2026-10-08T08:10:00.000Z",
              "disassembledAt": "2026-10-08T08:30:00.000Z",
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000006",
                  "sscc": "046006820000015055",
                  "closedAt": "2026-10-08T07:55:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000005",
              "sscc": "146006820000000430",
              "openedAt": "2026-10-08T08:15:00.000Z",
              "closedAt": "2026-10-08T08:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000007",
                  "sscc": "046006820000015062",
                  "closedAt": "2026-10-08T08:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000008",
                  "sscc": "046006820000015079",
                  "closedAt": "2026-10-08T08:40:00.000Z",
                  "disassembledAt": null,
                  "units": 10
                }
              ]
            }
          ]
        }
      },
      "cloud": {
        "sscc": null,
        "status": "open",
        "productName": "Молоко 3,2% 0,9 л",
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "openedAt": "2026-10-08T09:00:00.000Z",
        "closedAt": null,
        "disassembledAt": null,
        "boxes": [
          {
            "sscc": "00046006820000015086",
            "codeCount": 12,
            "disassembledAt": null
          }
        ]
      }
    },
    {
      "name": "placard-a4",
      "form": "placard",
      "format": "a4",
      "palletId": "a0000000-0000-4000-8000-000000000001",
      "host": {
        "rows": {
          "shift": {
            "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
            "number": "OCT26-004/S",
            "productionDate": "2026-10-08",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10
          },
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "pallets": [
            {
              "id": "a0000000-0000-4000-8000-000000000001",
              "sscc": "146006820000000409",
              "openedAt": "2026-10-08T06:06:01.118Z",
              "closedAt": "2026-10-08T07:20:44.650Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000001",
                  "sscc": "046006820000015000",
                  "closedAt": "2026-10-08T06:06:01.118Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000003",
                  "sscc": "046006820000015024",
                  "closedAt": "2026-10-08T06:30:00.000Z",
                  "disassembledAt": "2026-10-08T07:40:00.000Z",
                  "units": 0
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000002",
                  "sscc": "046006820000015017",
                  "closedAt": "2026-10-08T06:45:10.000Z",
                  "disassembledAt": null,
                  "units": 11
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000002",
              "sscc": null,
              "openedAt": "2026-10-08T09:00:00.000Z",
              "closedAt": null,
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000009",
                  "sscc": "046006820000015086",
                  "closedAt": "2026-10-08T09:00:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000003",
              "sscc": "146006820000000416",
              "openedAt": "2026-10-08T05:00:00.000Z",
              "closedAt": "2026-10-08T05:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000004",
                  "sscc": "046006820000015031",
                  "closedAt": "2026-10-08T05:10:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000005",
                  "sscc": "046006820000015048",
                  "closedAt": "2026-10-08T05:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000004",
              "sscc": "146006820000000423",
              "openedAt": "2026-10-08T07:50:00.000Z",
              "closedAt": "2026-10-08T08:10:00.000Z",
              "disassembledAt": "2026-10-08T08:30:00.000Z",
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000006",
                  "sscc": "046006820000015055",
                  "closedAt": "2026-10-08T07:55:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000005",
              "sscc": "146006820000000430",
              "openedAt": "2026-10-08T08:15:00.000Z",
              "closedAt": "2026-10-08T08:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000007",
                  "sscc": "046006820000015062",
                  "closedAt": "2026-10-08T08:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000008",
                  "sscc": "046006820000015079",
                  "closedAt": "2026-10-08T08:40:00.000Z",
                  "disassembledAt": null,
                  "units": 10
                }
              ]
            }
          ]
        }
      },
      "cloud": {
        "sscc": "00146006820000000409",
        "status": "closed",
        "productName": "Молоко 3,2% 0,9 л",
        "gtin14": "04600682000013",
        "shelfLifeDays": 10,
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "boxes": [
          {
            "productionDate": "2026-10-08",
            "codeCount": 12,
            "disassembledAt": null
          },
          {
            "productionDate": "2026-10-08",
            "codeCount": 12,
            "disassembledAt": "2026-10-08T07:40:00.000Z"
          },
          {
            "productionDate": "2026-10-08",
            "codeCount": 11,
            "disassembledAt": null
          }
        ]
      }
    },
    {
      "name": "placard-a5-disassembled",
      "form": "placard",
      "format": "a5",
      "palletId": "a0000000-0000-4000-8000-000000000004",
      "host": {
        "rows": {
          "shift": {
            "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
            "number": "OCT26-004/S",
            "productionDate": "2026-10-08",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": null
          },
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "pallets": [
            {
              "id": "a0000000-0000-4000-8000-000000000001",
              "sscc": "146006820000000409",
              "openedAt": "2026-10-08T06:06:01.118Z",
              "closedAt": "2026-10-08T07:20:44.650Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000001",
                  "sscc": "046006820000015000",
                  "closedAt": "2026-10-08T06:06:01.118Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000003",
                  "sscc": "046006820000015024",
                  "closedAt": "2026-10-08T06:30:00.000Z",
                  "disassembledAt": "2026-10-08T07:40:00.000Z",
                  "units": 0
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000002",
                  "sscc": "046006820000015017",
                  "closedAt": "2026-10-08T06:45:10.000Z",
                  "disassembledAt": null,
                  "units": 11
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000002",
              "sscc": null,
              "openedAt": "2026-10-08T09:00:00.000Z",
              "closedAt": null,
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000009",
                  "sscc": "046006820000015086",
                  "closedAt": "2026-10-08T09:00:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000003",
              "sscc": "146006820000000416",
              "openedAt": "2026-10-08T05:00:00.000Z",
              "closedAt": "2026-10-08T05:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000004",
                  "sscc": "046006820000015031",
                  "closedAt": "2026-10-08T05:10:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000005",
                  "sscc": "046006820000015048",
                  "closedAt": "2026-10-08T05:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000004",
              "sscc": "146006820000000423",
              "openedAt": "2026-10-08T07:50:00.000Z",
              "closedAt": "2026-10-08T08:10:00.000Z",
              "disassembledAt": "2026-10-08T08:30:00.000Z",
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000006",
                  "sscc": "046006820000015055",
                  "closedAt": "2026-10-08T07:55:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000005",
              "sscc": "146006820000000430",
              "openedAt": "2026-10-08T08:15:00.000Z",
              "closedAt": "2026-10-08T08:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000007",
                  "sscc": "046006820000015062",
                  "closedAt": "2026-10-08T08:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000008",
                  "sscc": "046006820000015079",
                  "closedAt": "2026-10-08T08:40:00.000Z",
                  "disassembledAt": null,
                  "units": 10
                }
              ]
            }
          ]
        }
      },
      "cloud": {
        "sscc": "00146006820000000423",
        "status": "disassembled",
        "productName": "Молоко 3,2% 0,9 л",
        "gtin14": "04600682000013",
        "shelfLifeDays": null,
        "org": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "logo": null
        },
        "boxes": [
          {
            "productionDate": "2026-10-08",
            "codeCount": 12,
            "disassembledAt": null
          }
        ]
      }
    },
    {
      "name": "shift-placards-a5",
      "form": "placards",
      "format": "a5",
      "host": {
        "rows": {
          "shift": {
            "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
            "number": "OCT26-004/S",
            "productionDate": "2026-10-08",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10
          },
          "organization": {
            "name": "ООО «Атолл»",
            "inn": "7701234567"
          },
          "pallets": [
            {
              "id": "a0000000-0000-4000-8000-000000000001",
              "sscc": "146006820000000409",
              "openedAt": "2026-10-08T06:06:01.118Z",
              "closedAt": "2026-10-08T07:20:44.650Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000001",
                  "sscc": "046006820000015000",
                  "closedAt": "2026-10-08T06:06:01.118Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000003",
                  "sscc": "046006820000015024",
                  "closedAt": "2026-10-08T06:30:00.000Z",
                  "disassembledAt": "2026-10-08T07:40:00.000Z",
                  "units": 0
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000002",
                  "sscc": "046006820000015017",
                  "closedAt": "2026-10-08T06:45:10.000Z",
                  "disassembledAt": null,
                  "units": 11
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000002",
              "sscc": null,
              "openedAt": "2026-10-08T09:00:00.000Z",
              "closedAt": null,
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000009",
                  "sscc": "046006820000015086",
                  "closedAt": "2026-10-08T09:00:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000003",
              "sscc": "146006820000000416",
              "openedAt": "2026-10-08T05:00:00.000Z",
              "closedAt": "2026-10-08T05:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000004",
                  "sscc": "046006820000015031",
                  "closedAt": "2026-10-08T05:10:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000005",
                  "sscc": "046006820000015048",
                  "closedAt": "2026-10-08T05:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000004",
              "sscc": "146006820000000423",
              "openedAt": "2026-10-08T07:50:00.000Z",
              "closedAt": "2026-10-08T08:10:00.000Z",
              "disassembledAt": "2026-10-08T08:30:00.000Z",
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000006",
                  "sscc": "046006820000015055",
                  "closedAt": "2026-10-08T07:55:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                }
              ]
            },
            {
              "id": "a0000000-0000-4000-8000-000000000005",
              "sscc": "146006820000000430",
              "openedAt": "2026-10-08T08:15:00.000Z",
              "closedAt": "2026-10-08T08:50:00.000Z",
              "disassembledAt": null,
              "boxes": [
                {
                  "id": "b0000000-0000-4000-8000-000000000007",
                  "sscc": "046006820000015062",
                  "closedAt": "2026-10-08T08:20:00.000Z",
                  "disassembledAt": null,
                  "units": 12
                },
                {
                  "id": "b0000000-0000-4000-8000-000000000008",
                  "sscc": "046006820000015079",
                  "closedAt": "2026-10-08T08:40:00.000Z",
                  "disassembledAt": null,
                  "units": 10
                }
              ]
            }
          ]
        }
      },
      "cloud": {
        "shiftNumber": "OCT26-004/S",
        "pallets": [
          {
            "sscc": "00146006820000000416",
            "status": "closed",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10,
            "org": {
              "name": "ООО «Атолл»",
              "inn": "7701234567",
              "logo": null
            },
            "boxes": [
              {
                "productionDate": "2026-10-08",
                "codeCount": 12,
                "disassembledAt": null
              },
              {
                "productionDate": "2026-10-08",
                "codeCount": 12,
                "disassembledAt": null
              }
            ]
          },
          {
            "sscc": "00146006820000000409",
            "status": "closed",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10,
            "org": {
              "name": "ООО «Атолл»",
              "inn": "7701234567",
              "logo": null
            },
            "boxes": [
              {
                "productionDate": "2026-10-08",
                "codeCount": 12,
                "disassembledAt": null
              },
              {
                "productionDate": "2026-10-08",
                "codeCount": 12,
                "disassembledAt": "2026-10-08T07:40:00.000Z"
              },
              {
                "productionDate": "2026-10-08",
                "codeCount": 11,
                "disassembledAt": null
              }
            ]
          },
          {
            "sscc": "00146006820000000430",
            "status": "closed",
            "productName": "Молоко 3,2% 0,9 л",
            "gtin14": "04600682000013",
            "shelfLifeDays": 10,
            "org": {
              "name": "ООО «Атолл»",
              "inn": "7701234567",
              "logo": null
            },
            "boxes": [
              {
                "productionDate": "2026-10-08",
                "codeCount": 12,
                "disassembledAt": null
              },
              {
                "productionDate": "2026-10-08",
                "codeCount": 10,
                "disassembledAt": null
              }
            ]
          }
        ]
      }
    },
    {
      "name": "task-form-planned",
      "form": "task",
      "generatedAt": "2026-10-08T05:45:00.000Z",
      "host": {
        "shift": {
          "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
          "number": "OCT26-004",
          "status": "planned",
          "mode": "aggregation",
          "palletsEnabled": true,
          "createdFrom": "office",
          "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
          "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
          "counterpartyId": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
          "productionDate": "2026-10-08",
          "plannedQty": 1200,
          "boxCapacity": 12,
          "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
          "palletBoxCapacity": 40,
          "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
          "ownerDeviceId": null,
          "openedAt": null,
          "closedAt": null,
          "closeReasonCode": null,
          "closeReasonText": null,
          "lateDataAt": null,
          "createdAt": "2026-10-07T15:30:00Z",
          "rev": 71,
          "totals": {
            "acceptedUnits": 0,
            "unitsInClosedBoxes": 0,
            "closedBoxes": 0,
            "openBoxes": 0,
            "lastFactAt": null,
            "deviceIds": [],
            "closedPallets": 0,
            "openPallets": 0
          }
        },
        "product": {
          "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
          "gtin14": "04600682000013",
          "name": "Молоко 3,2% 0,9 л",
          "printName": "Молоко 3,2%",
          "chzProductGroupCode": 8,
          "boxCapacity": 12,
          "palletBoxCapacity": 40,
          "shelfLifeDays": 10,
          "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
          "defaultPalletTemplateId": null,
          "archived": false,
          "status": "active",
          "rev": 65
        },
        "line": {
          "id": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
          "name": "Линия розлива №2",
          "archived": false,
          "rev": 40
        },
        "counterparty": {
          "id": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
          "name": "ООО «Северный берег»",
          "inn": "7812345678",
          "gln": "4601234000017",
          "gs1Prefixes": ["4601234"],
          "archived": false,
          "rev": 12
        },
        "organization": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "gln": "4600682000010",
          "gs1Prefixes": ["4600682"],
          "timeZone": "Europe/Moscow",
          "rev": 1
        }
      },
      "cloud": {
        "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "shiftNumber": "OCT26-004",
        "status": "planned",
        "mode": "aggregation",
        "organizationName": "ООО «Атолл»",
        "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
        "productName": "Молоко 3,2% 0,9 л",
        "productPrintName": "Молоко 3,2%",
        "gtin14": "04600682000013",
        "imageChecksum": null,
        "lineName": "Линия розлива №2",
        "plannedDate": "2026-10-08",
        "productionDate": "2026-10-08",
        "plannedQty": 1200,
        "boxCapacity": 12,
        "palletsEnabled": true,
        "palletBoxCapacity": 40,
        "counterpartyName": "ООО «Северный берег»",
        "ssccIssuerName": null,
        "validationPrintMode": "none",
        "validationPrintVerification": "none",
        "allowPreviouslyAcceptedCodes": false,
        "generatedAt": "2026-10-08T05:45:00.000Z"
      }
    },
    {
      "name": "task-form-active",
      "form": "task",
      "generatedAt": "2026-10-09T06:30:00.000Z",
      "host": {
        "shift": {
          "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
          "number": "OCT26-005/S",
          "status": "active",
          "mode": "aggregation",
          "palletsEnabled": false,
          "createdFrom": "station",
          "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
          "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
          "counterpartyId": null,
          "productionDate": "2026-10-09",
          "plannedQty": null,
          "boxCapacity": 12,
          "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
          "palletBoxCapacity": null,
          "palletTemplateId": null,
          "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          "openedAt": "2026-10-09T06:02:00Z",
          "closedAt": null,
          "closeReasonCode": null,
          "closeReasonText": null,
          "lateDataAt": null,
          "createdAt": "2026-10-07T15:30:00Z",
          "rev": 71,
          "totals": {
            "acceptedUnits": 0,
            "unitsInClosedBoxes": 0,
            "closedBoxes": 0,
            "openBoxes": 0,
            "lastFactAt": null,
            "deviceIds": [],
            "closedPallets": 0,
            "openPallets": 0
          }
        },
        "product": {
          "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
          "gtin14": "04600682000013",
          "name": "Молоко 3,2% 0,9 л",
          "printName": null,
          "chzProductGroupCode": 8,
          "boxCapacity": 12,
          "palletBoxCapacity": 40,
          "shelfLifeDays": 10,
          "defaultBoxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
          "defaultPalletTemplateId": null,
          "archived": false,
          "status": "active",
          "rev": 65
        },
        "line": {
          "id": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
          "name": "Линия розлива №2",
          "archived": false,
          "rev": 40
        },
        "counterparty": null,
        "organization": {
          "name": "ООО «Атолл»",
          "inn": "7701234567",
          "gln": "4600682000010",
          "gs1Prefixes": ["4600682"],
          "timeZone": "Europe/Moscow",
          "rev": 1
        }
      },
      "cloud": {
        "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        "shiftNumber": "OCT26-005/S",
        "status": "active",
        "mode": "aggregation",
        "organizationName": "ООО «Атолл»",
        "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
        "productName": "Молоко 3,2% 0,9 л",
        "productPrintName": null,
        "gtin14": "04600682000013",
        "imageChecksum": null,
        "lineName": "Линия розлива №2",
        "plannedDate": "2026-10-09",
        "productionDate": "2026-10-09",
        "plannedQty": null,
        "boxCapacity": 12,
        "palletsEnabled": false,
        "palletBoxCapacity": null,
        "counterpartyName": null,
        "ssccIssuerName": null,
        "validationPrintMode": "none",
        "validationPrintVerification": "none",
        "allowPreviouslyAcceptedCodes": false,
        "generatedAt": "2026-10-09T06:30:00.000Z"
      }
    }
  ]
}
```

- [ ] **Step 2: Тест падает — эталона ещё нет**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`

Expected: FAIL: `Error: ENOENT: no such file or directory, open '…/print-forms-parity/golden.json'`, `Tests  1 failed (1)` (эталона ещё нет).

- [ ] **Step 3: Записать эталон кодом облака**

Run: `FORMS_PARITY_WRITE=1 pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`

Expected: PASS: `Tests  1 passed (1)`; появился `packages/domain/test/fixtures/print-forms-parity/golden.json` (10 случаев).

Run: `shasum -a 256 packages/domain/test/fixtures/print-forms-parity/golden.json`

Expected: `8a7814ce39355a79c2dc694aa32a4a0e4089c8b993fda00d312648909b837b7c  packages/domain/test/fixtures/print-forms-parity/golden.json`. Другой хеш значит, что код форм облака, домен или случаи разошлись с копией: остановиться и записать в «Отклонения».

Run: `node_modules/.bin/prettier --check packages/domain/test/fixtures/print-forms-parity/golden.json` — чисто (тест пишет JSON с отступом 2 и переводом строки в конце).

Сводка эталона (для ревью; HTML — в файле):

| Случай                    | Байт  | SHA-256 (начало)   |
| ------------------------- | ----- | ------------------ |
| `box-closed`              | 18524 | `71867b5e83b8d1d4` |
| `box-disassembled`        | 15769 | `61e8795e801c8342` |
| `box-open-empty`          | 8585  | `b4d1d2c4ab67b00b` |
| `pallet-report-closed`    | 13321 | `1ce81877bb35ae32` |
| `pallet-report-open`      | 9531  | `a43391ebe3ee81fc` |
| `placard-a4`              | 6318  | `42f7aae8b11c3ad8` |
| `placard-a5-disassembled` | 6269  | `e913954dfcc64af0` |
| `shift-placards-a5`       | 11977 | `b1fdca6a9522cd50` |
| `task-form-planned`       | 16047 | `8dad8c3905db7131` |
| `task-form-active`        | 15627 | `635403ecc1b164be` |

- [ ] **Step 4: Тест проходит без записи**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`

Expected: PASS: `Tests  1 passed (1)`.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **C1** (пояс «Состава короба» в контроллере облака): в `apps/api/src/modules/code-search/code-search.controller.ts` `return renderBoxReportHtml(data, query.timeZone);` → `return renderBoxReportHtml(data);`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`. Ожидается: FAIL — `the cloud's controllers answer the golden HTML for every shared case`.
- **C2** (номер смены на ярлыках смены): в `apps/api/src/modules/code-search/code-search.controller.ts` `return renderShiftPlacardsHtml(data.pallets, query.format, data.shiftNumber);` → `return renderShiftPlacardsHtml(data.pallets, query.format, null);`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`. Ожидается: FAIL — `the cloud's controllers answer the golden HTML for every shared case`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/api/test/standalone-forms-parity.test.ts packages/domain/test/fixtures/print-forms-parity/cases.json packages/domain/test/fixtures/print-forms-parity/golden.json
git commit -m "test(api): the cloud's own form routes draw the parity cases of the standalone office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Вход форм облака из строк хоста и рисование доменом в офисе, сверенные с эталоном

`form-data.ts` — то, чем форма автонома становится облачной: каждая функция названа по загрузчику облака, за который стоит. SSCC — в машинной форме `00…` (хост хранит 18 цифр), состояние — как выводит облако (расформирован важнее закрыт), организация — без логотипа (П15), у бланка — без фото, без дубликатов и без выпуска SSCC под контрагентом, обе даты — дата смены (Ф3). Отказы облака — `null`: ярлык без закрытия или SSCC, ярлыки смены без единой закрытой стоящей паллеты с SSCC, бланк закрытой смены. `render-form.ts` — `renderForm(request)`: один вызов генератора домена на вид формы и имя файла формы; `formTimeZone` — пояс организации или этого ПК (Ф2). Тест паритета рисует каждый случай задачи 3 из `host` тем же `renderForm`, что и офис, и сравнивает с эталоном байт в байт; модульный тест закрепляет отказы, порядок ярлыков смены (закрытие, затем id — при равном моменте), даты бланка и имена файлов.

**Files:**

- Create: `apps/standalone/src/office/forms/form-data.ts`, `apps/standalone/src/office/forms/render-form.ts`, `apps/standalone/test/forms-parity.test.ts`, `apps/standalone/test/form-data.test.ts`

**Interfaces:**

- Consumes: `BoxReportRows` (задача 1), `PalletReportRows` (задача 2), `cases.json` и `golden.json` (задача 3); `OfficeShift`, `OfficeProduct`, `OfficeLine`, `CounterpartyRecord`, `OrgProfile`; `isKnownTimeZone` (`src/lib/civil-date.ts`); домен — пять `render*Html`, `PlacardFormat`.
- Produces: `form-data.ts` — `machineSscc(sscc): string | null`, `boxReportData(rows): BoxReportData`, `palletReportData(rows, palletId): PalletReportData | null`, `hasPlacard(pallet: {closedAt, sscc}): boolean`, `palletPlacardData(rows, palletId): PalletPlacardData | null`, `placardPallets(rows): Pallet[]`, `shiftPlacardsData(rows): { shiftNumber; pallets } | null`, `interface TaskFormInputs { shift; product; line; counterparty; organization }`, `taskFormData(inputs, generatedAt): ShiftTaskFormData | null`; `render-form.ts` — `type FormKind = "box" | "pallet" | "placard" | "placards" | "task"`, `type FormRequest`, `interface RenderedForm { kind; html; fileName }`, `formTimeZone(org?): string`, `renderForm(request): RenderedForm | null`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/form-data.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { palletReportRowsSchema, type PalletReportRows } from "../src/host/protocol.js";
import {
  hasPlacard,
  machineSscc,
  palletPlacardData,
  palletReportData,
  placardPallets,
  shiftPlacardsData,
  taskFormData,
} from "../src/office/forms/form-data.js";
import { formTimeZone, renderForm } from "../src/office/forms/render-form.js";
import { ORG_PROFILE } from "./support/office.js";
import { ACTIVE, CLOSED, LINE_2, MILK, NORTH, PLANNED } from "./support/shifts.js";

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
const ROWS = palletReportRowsSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/pallet-report-rows.json", testModuleUrl), "utf8"),
  ),
);
/** The fixture's one pallet, closed. */
const CLOSED_PALLET = ((pallet) => {
  if (pallet === undefined) throw new Error("the fixture has a pallet");
  return pallet;
})(ROWS.pallets[0]);

function pallet(
  n: number,
  fields: Partial<PalletReportRows["pallets"][number]>,
): PalletReportRows["pallets"][number] {
  return {
    ...CLOSED_PALLET,
    id: `a0000000-0000-4000-8000-00000000000${n}`,
    sscc: `14600682000000041${n}`,
    ...fields,
  };
}

/** Rows with pallets 1–6: closed at 07:00 (twice, 3 before 1 by id), open, without SSCC, taken apart. */
const MANY: PalletReportRows = {
  ...ROWS,
  pallets: [
    pallet(3, { closedAt: "2026-10-08T07:00:00.000Z" }),
    pallet(2, { closedAt: null, sscc: null }),
    pallet(1, { closedAt: "2026-10-08T07:00:00.000Z" }),
    pallet(4, { closedAt: "2026-10-08T06:00:00.000Z", disassembledAt: "2026-10-08T06:30:00.000Z" }),
    pallet(5, { closedAt: "2026-10-08T06:59:59.999Z" }),
    pallet(6, { closedAt: "2026-10-08T05:00:00.000Z", sscc: null }),
  ],
};

describe("the forms' inputs from the host's rows (plan О-Ф)", () => {
  it("writes an SSCC in the machine form the forms take, and none as none", () => {
    expect(machineSscc("046006820000015000")).toBe("00046006820000015000");
    expect(machineSscc(null)).toBeNull();
  });

  it("has a placard only for a pallet closed with an SSCC, one taken apart too", () => {
    expect(hasPlacard({ closedAt: "2026-10-08T07:00:00.000Z", sscc: "146006820000000409" })).toBe(
      true,
    );
    expect(hasPlacard({ closedAt: null, sscc: null })).toBe(false);
    expect(hasPlacard({ closedAt: "2026-10-08T07:00:00.000Z", sscc: null })).toBe(false);
    expect(palletPlacardData(MANY, MANY.pallets[1]?.id ?? "")).toBeNull();
    expect(palletPlacardData(MANY, MANY.pallets[5]?.id ?? "")).toBeNull();
    expect(palletPlacardData(MANY, MANY.pallets[3]?.id ?? "")?.status).toBe("disassembled");
    expect(palletPlacardData(MANY, MANY.pallets[0]?.id ?? "")?.status).toBe("closed");
  });

  it("knows no pallet the rows lack", () => {
    expect(palletReportData(ROWS, "a0000000-0000-4000-8000-000000000009")).toBeNull();
    expect(palletPlacardData(ROWS, "a0000000-0000-4000-8000-000000000009")).toBeNull();
  });

  it("prints the shift's placards of the pallets closed, standing and numbered, closed first first, then by id", () => {
    expect(placardPallets(MANY).map((each) => each.id.slice(-1))).toEqual(["5", "1", "3"]);
    expect(shiftPlacardsData(MANY)?.pallets.map((each) => each.sscc)).toEqual([
      "00146006820000000415",
      "00146006820000000411",
      "00146006820000000413",
    ]);
    expect(shiftPlacardsData(MANY)?.shiftNumber).toBe("OCT26-004");
    expect(
      shiftPlacardsData({ ...MANY, pallets: MANY.pallets.filter((each) => !hasPlacard(each)) }),
    ).toBeNull();
  });

  it("dates every box of a placard by the shift's production date", () => {
    expect(palletPlacardData(ROWS, CLOSED_PALLET.id)?.boxes).toEqual([
      { productionDate: "2026-10-08", codeCount: 2, disassembledAt: null },
    ]);
  });

  it("draws the blank of a planned or an active shift, with its one date as both dates, and none of a closed one", () => {
    const inputs = {
      shift: PLANNED,
      product: MILK,
      line: LINE_2,
      counterparty: NORTH,
      organization: ORG_PROFILE,
    };
    const at = new Date("2026-10-09T09:00:00Z");
    const blank = taskFormData(inputs, at);
    expect(blank).toMatchObject({
      status: "planned",
      plannedDate: PLANNED.productionDate,
      productionDate: PLANNED.productionDate,
      lineName: LINE_2.name,
      counterpartyName: NORTH.name,
      organizationName: ORG_PROFILE.name,
      imageChecksum: null,
      ssccIssuerName: null,
      generatedAt: at,
    });
    expect(taskFormData({ ...inputs, shift: ACTIVE, counterparty: null }, at)).toMatchObject({
      status: "active",
      counterpartyName: null,
    });
    expect(taskFormData({ ...inputs, shift: CLOSED }, at)).toBeNull();
    expect(
      renderForm({ kind: "task", inputs: { ...inputs, shift: CLOSED }, generatedAt: at }),
    ).toBe(null);
  });

  it("names each form's file, and refuses what the cloud refuses", () => {
    expect(
      renderForm({ kind: "placard", rows: MANY, palletId: MANY.pallets[0]?.id ?? "", format: "a5" })
        ?.fileName,
    ).toBe("Ярлык паллеты 146006820000000413 A5.html");
    expect(
      renderForm({
        kind: "placard",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        format: "a4",
      }),
    ).toBeNull();
    expect(renderForm({ kind: "placards", rows: MANY, format: "a4" })?.fileName).toBe(
      "Ярлыки паллет смены A4.html",
    );
    expect(
      renderForm({
        kind: "pallet",
        rows: MANY,
        palletId: MANY.pallets[1]?.id ?? "",
        timeZone: "UTC",
      })?.fileName,
    ).toBe("Состав паллеты без SSCC.html");
    expect(
      renderForm({ kind: "pallet", rows: MANY, palletId: "missing", timeZone: "UTC" }),
    ).toBeNull();
  });

  it("writes times in the organization's zone, or this PC's when it is not known", () => {
    const here = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" })).toBe("Asia/Vladivostok");
    expect(formTimeZone({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" })).toBe(here);
    expect(formTimeZone(undefined)).toBe(here);
  });
});
```

2. Создать `apps/standalone/test/forms-parity.test.ts`:

<!-- prettier-ignore -->
```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boxReportRowsSchema,
  counterpartyRecordSchema,
  officeLineSchema,
  officeProductSchema,
  officeShiftSchema,
  orgProfileSchema,
  palletReportRowsSchema,
} from "../src/host/protocol.js";
import { renderForm, type FormRequest } from "../src/office/forms/render-form.js";

/**
 * The standalone's half of the printed forms' parity with the cloud (plan
 * О-Ф). Each case of `packages/domain/test/fixtures/print-forms-parity/cases.json`
 * holds the host's rows (or the office's records) for some facts; the
 * office's own `renderForm` must draw exactly the HTML of `golden.json`,
 * which the cloud's controllers wrote from the cloud loaders' input for the
 * same facts (`apps/api/test/standalone-forms-parity.test.ts`).
 */

const testModuleUrl = import.meta.url;

function read(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/domain/test/fixtures/print-forms-parity/${name}`, testModuleUrl),
      "utf8",
    ),
  );
}

const format = z.enum(["a4", "a5"]);
const caseSchema = z.discriminatedUnion("form", [
  z.object({
    name: z.string(),
    form: z.literal("box"),
    timeZone: z.string(),
    host: z.object({ rows: boxReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("pallet"),
    timeZone: z.string(),
    palletId: z.string(),
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("placard"),
    format,
    palletId: z.string(),
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("placards"),
    format,
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("task"),
    generatedAt: z.iso.datetime(),
    host: z.object({
      shift: officeShiftSchema,
      product: officeProductSchema,
      line: officeLineSchema,
      counterparty: counterpartyRecordSchema.nullable(),
      organization: orgProfileSchema,
    }),
  }),
]);
type ParityCase = z.infer<typeof caseSchema>;

// The cases' `cloud` inputs are the cloud test's; the schemas here drop them.
const cases = z.object({ cases: z.array(caseSchema) }).parse(read("cases.json")).cases;
const golden = z
  .record(z.string(), z.object({ bytes: z.number(), sha256: z.string(), html: z.string() }))
  .parse(read("golden.json"));

/** The office's request for the case's form. */
function requestOf(parityCase: ParityCase): FormRequest {
  switch (parityCase.form) {
    case "box":
      return { kind: "box", rows: parityCase.host.rows, timeZone: parityCase.timeZone };
    case "pallet":
      return {
        kind: "pallet",
        rows: parityCase.host.rows,
        palletId: parityCase.palletId,
        timeZone: parityCase.timeZone,
      };
    case "placard":
      return {
        kind: "placard",
        rows: parityCase.host.rows,
        palletId: parityCase.palletId,
        format: parityCase.format,
      };
    case "placards":
      return { kind: "placards", rows: parityCase.host.rows, format: parityCase.format };
    case "task":
      return {
        kind: "task",
        inputs: parityCase.host,
        generatedAt: new Date(parityCase.generatedAt),
      };
  }
}

describe("printed forms parity with the cloud (plan О-Ф)", () => {
  it("covers every case the cloud's golden has", () => {
    expect(cases.map((parityCase) => parityCase.name)).toEqual(Object.keys(golden));
  });

  it.each(cases.map((parityCase) => [parityCase.name, parityCase] as const))(
    "%s: the office draws the cloud's bytes from the host's rows",
    (name, parityCase) => {
      const drawn = renderForm(requestOf(parityCase));
      const expected = golden[name];
      expect(drawn?.kind).toBe(parityCase.form);
      expect(drawn?.html).toBe(expected?.html);
      expect(
        createHash("sha256")
          .update(drawn?.html ?? "", "utf8")
          .digest("hex"),
      ).toBe(expected?.sha256);
    },
  );
});
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-data.test.ts test/forms-parity.test.ts`

Expected: FAIL: `Failed to resolve import "../src/office/forms/form-data.js"` и `"../src/office/forms/render-form.js"`, `Tests  no tests`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/src/office/forms/form-data.ts`:

<!-- prettier-ignore -->
```ts
import type {
  BoxReportData,
  PalletPlacardData,
  PalletReportData,
  ReportOrg,
  ShiftTaskFormData,
} from "@markiro/domain";

import type {
  BoxReportRows,
  CounterpartyRecord,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
  PalletReportRows,
} from "../../host/protocol.js";

/**
 * The cloud's form inputs from the host's rows (plan О-Ф). The forms are the
 * cloud's own (`@markiro/domain`'s `print-forms`), so what makes a standalone
 * form the cloud's for the same facts is this mapping: each function says
 * which loader of the cloud it stands for (`CodeSearchService.boxReportData`
 * and its neighbours, `ShiftsService.taskFormData`), and
 * `test/forms-parity.test.ts` holds it to the bytes the cloud's controllers
 * answer for the shared cases.
 */

type Pallet = PalletReportRows["pallets"][number];

/** The 20-character machine form `00…` the forms take; the host keeps the bare 18 digits. */
export function machineSscc(sscc: string | null): string | null {
  return sscc === null ? null : `00${sscc}`;
}

/** The organization as the forms name it: the standalone has no logo (pilot question П15). */
function reportOrg(organization: { name: string; inn: string | null }): ReportOrg {
  return { name: organization.name, inn: organization.inn, logo: null };
}

/** A box's or a pallet's state, as the cloud's loaders derive it. */
function lifecycle(
  closedAt: string | null,
  disassembledAt: string | null,
): "open" | "closed" | "disassembled" {
  return disassembledAt !== null ? "disassembled" : closedAt !== null ? "closed" : "open";
}

function at(value: string): Date;
function at(value: string | null): Date | null;
function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** «Состав короба» of one box (`CodeSearchService.boxReportData`). */
export function boxReportData(rows: BoxReportRows): BoxReportData {
  return {
    sscc: machineSscc(rows.sscc),
    status: lifecycle(rows.closedAt, rows.disassembledAt),
    productName: rows.productName,
    org: reportOrg(rows.organization),
    openedAt: at(rows.openedAt),
    closedAt: at(rows.closedAt),
    disassembledAt: at(rows.disassembledAt),
    codes: rows.items.map((item) => ({
      gtin14: item.gtin14,
      serial: item.serial,
      rawKm: item.canonical,
    })),
  };
}

/**
 * «Состав паллеты» of one pallet of the shift (`CodeSearchService.palletReportData`),
 * or `null` when the rows have no such pallet. A box taken apart keeps its
 * place and its time; the form neither prints nor counts its units.
 */
export function palletReportData(
  rows: PalletReportRows,
  palletId: string,
): PalletReportData | null {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  if (pallet === undefined) return null;
  return {
    sscc: machineSscc(pallet.sscc),
    status: lifecycle(pallet.closedAt, pallet.disassembledAt),
    productName: rows.shift.productName,
    org: reportOrg(rows.organization),
    openedAt: at(pallet.openedAt),
    closedAt: at(pallet.closedAt),
    disassembledAt: at(pallet.disassembledAt),
    boxes: pallet.boxes.map((box) => ({
      sscc: machineSscc(box.sscc),
      codeCount: box.units,
      disassembledAt: at(box.disassembledAt),
    })),
  };
}

/**
 * Whether a pallet has a placard: closed and with an SSCC, as the cloud's
 * `palletPlacardData` refuses any other (`PALLET_NOT_CLOSED`). A pallet taken
 * apart has one, printed with the cloud's watermark.
 */
export function hasPlacard(pallet: Pick<Pallet, "closedAt" | "sscc">): boolean {
  return pallet.closedAt !== null && pallet.sscc !== null;
}

function placard(rows: PalletReportRows, pallet: Pallet): PalletPlacardData {
  return {
    sscc: machineSscc(pallet.sscc),
    status: pallet.disassembledAt !== null ? "disassembled" : "closed",
    productName: rows.shift.productName,
    gtin14: rows.shift.gtin14,
    shelfLifeDays: rows.shift.shelfLifeDays,
    org: reportOrg(rows.organization),
    // Every box of a standalone pallet is of its own shift, so each carries
    // the shift's declared production date (the host's date is never empty).
    boxes: pallet.boxes.map((box) => ({
      productionDate: rows.shift.productionDate,
      codeCount: box.units,
      disassembledAt: at(box.disassembledAt),
    })),
  };
}

/** «Ярлык паллеты» of one pallet (`CodeSearchService.palletPlacardData`), or `null` without one. */
export function palletPlacardData(
  rows: PalletReportRows,
  palletId: string,
): PalletPlacardData | null {
  const pallet = rows.pallets.find((each) => each.id === palletId);
  return pallet === undefined || !hasPlacard(pallet) ? null : placard(rows, pallet);
}

/**
 * The pallets «Ярлыки паллет смены» prints (`CodeSearchService.shiftPlacardsData`):
 * closed, not taken apart, with an SSCC, closed first first (then by id).
 */
export function placardPallets(rows: PalletReportRows): Pallet[] {
  return rows.pallets
    .filter((pallet) => hasPlacard(pallet) && pallet.disassembledAt === null)
    .sort((a, b) => byText(a.closedAt ?? "", b.closedAt ?? "") || byText(a.id, b.id));
}

/** Code-unit order: a device's instants (`…T06:05:12.031Z`) and ids sort as text. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * «Ярлыки паллет смены»: the shift's number and a placard of each pallet
 * `placardPallets` names, or `null` when there is none (the cloud's
 * `SHIFT_HAS_NO_PALLETS`).
 */
export function shiftPlacardsData(
  rows: PalletReportRows,
): { shiftNumber: string; pallets: PalletPlacardData[] } | null {
  const pallets = placardPallets(rows);
  if (pallets.length === 0) return null;
  return { shiftNumber: rows.shift.number, pallets: pallets.map((each) => placard(rows, each)) };
}

/** What «Бланк смены» is drawn from: records the office reads already. */
export interface TaskFormInputs {
  shift: OfficeShift;
  product: OfficeProduct;
  line: OfficeLine;
  counterparty: CounterpartyRecord | null;
  organization: OrgProfile;
}

/**
 * «Бланк смены» (`ShiftsService.taskFormData`), or `null` for a closed shift
 * (the cloud's `SHIFT_TASK_FORM_CLOSED`). The standalone shift has one date
 * (stage 2a spec, question В3), so it is both the shift's date and its
 * production date; the product has no photo; the standalone neither prints
 * duplicates nor issues SSCCs under a counterparty's prefix yet.
 */
export function taskFormData(inputs: TaskFormInputs, generatedAt: Date): ShiftTaskFormData | null {
  const { shift, product, line, counterparty, organization } = inputs;
  if (shift.status === "closed") return null;
  return {
    shiftId: shift.id,
    shiftNumber: shift.number,
    status: shift.status,
    mode: shift.mode,
    organizationName: organization.name,
    productId: product.id,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    imageChecksum: null,
    lineName: line.name,
    plannedDate: shift.productionDate,
    productionDate: shift.productionDate,
    plannedQty: shift.plannedQty,
    boxCapacity: shift.boxCapacity,
    palletsEnabled: shift.palletsEnabled,
    palletBoxCapacity: shift.palletBoxCapacity,
    counterpartyName: counterparty?.name ?? null,
    ssccIssuerName: null,
    validationPrintMode: "none",
    validationPrintVerification: "none",
    allowPreviouslyAcceptedCodes: false,
    generatedAt,
  };
}
```

2. Создать `apps/standalone/src/office/forms/render-form.ts`:

<!-- prettier-ignore -->
```ts
import {
  renderBoxReportHtml,
  renderPalletPlacardHtml,
  renderPalletReportHtml,
  renderShiftPlacardsHtml,
  renderShiftTaskFormHtml,
  type PlacardFormat,
} from "@markiro/domain";

import type { BoxReportRows, OrgProfile, PalletReportRows } from "../../host/protocol.js";
import { isKnownTimeZone } from "../../lib/civil-date.js";
import {
  boxReportData,
  palletPlacardData,
  palletReportData,
  shiftPlacardsData,
  taskFormData,
  type TaskFormInputs,
} from "./form-data.js";

/** The printed forms of a shift (pilot spec §5.5), as the cloud's routes serve them. */
export type FormKind = "box" | "pallet" | "placard" | "placards" | "task";

/** A form to draw and the host's rows (or the office's records) it is drawn from. */
export type FormRequest =
  | { kind: "box"; rows: BoxReportRows; timeZone: string }
  | { kind: "pallet"; rows: PalletReportRows; palletId: string; timeZone: string }
  | { kind: "placard"; rows: PalletReportRows; palletId: string; format: PlacardFormat }
  | { kind: "placards"; rows: PalletReportRows; format: PlacardFormat }
  | { kind: "task"; inputs: TaskFormInputs; generatedAt: Date };

/** A drawn form: its HTML, exactly the cloud's for the same input, and its file's name. */
export interface RenderedForm {
  kind: FormKind;
  html: string;
  fileName: string;
}

/**
 * The time zone the forms write times in: the organization's, as the cloud
 * cabinet writes them in its viewer's; this PC's while the profile is not
 * read or names a zone this PC lacks.
 */
export function formTimeZone(organization: OrgProfile | undefined): string {
  return organization !== undefined && isKnownTimeZone(organization.timeZone)
    ? organization.timeZone
    : new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** «A4» or «A5» in a file's name. */
function paper(format: PlacardFormat): string {
  return format.toUpperCase();
}

/**
 * The form drawn by `@markiro/domain`, or `null` when the cloud would refuse
 * it: a pallet the rows lack, a placard of a pallet not closed or without
 * an SSCC (`PALLET_NOT_CLOSED`), a shift with no pallet to placard
 * (`SHIFT_HAS_NO_PALLETS`), the blank of a closed shift
 * (`SHIFT_TASK_FORM_CLOSED`).
 */
export function renderForm(request: FormRequest): RenderedForm | null {
  switch (request.kind) {
    case "box": {
      const data = boxReportData(request.rows);
      return {
        kind: "box",
        html: renderBoxReportHtml(data, request.timeZone),
        fileName: `Состав короба ${request.rows.sscc ?? "без SSCC"}.html`,
      };
    }
    case "pallet": {
      const data = palletReportData(request.rows, request.palletId);
      if (data === null) return null;
      const sscc = request.rows.pallets.find((each) => each.id === request.palletId)?.sscc;
      return {
        kind: "pallet",
        html: renderPalletReportHtml(data, request.timeZone),
        fileName: `Состав паллеты ${sscc ?? "без SSCC"}.html`,
      };
    }
    case "placard": {
      const data = palletPlacardData(request.rows, request.palletId);
      if (data === null) return null;
      const sscc = request.rows.pallets.find((each) => each.id === request.palletId)?.sscc;
      return {
        kind: "placard",
        html: renderPalletPlacardHtml(data, request.format),
        fileName: `Ярлык паллеты ${sscc ?? ""} ${paper(request.format)}.html`,
      };
    }
    case "placards": {
      const data = shiftPlacardsData(request.rows);
      if (data === null) return null;
      return {
        kind: "placards",
        html: renderShiftPlacardsHtml(data.pallets, request.format, data.shiftNumber),
        fileName: `Ярлыки паллет смены ${paper(request.format)}.html`,
      };
    }
    case "task": {
      const data = taskFormData(request.inputs, request.generatedAt);
      if (data === null) return null;
      return {
        kind: "task",
        html: renderShiftTaskFormHtml(data),
        fileName: "Бланк смены.html",
      };
    }
  }
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-data.test.ts test/forms-parity.test.ts`

Expected: PASS: `Tests  19 passed (19)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **M1** (SSCC в машинной форме): в `apps/standalone/src/office/forms/form-data.ts` ``return sscc === null ? null : `00${sscc}`;`` → `return sscc === null ? null : sscc;`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/forms-parity.test.ts test/form-data.test.ts`. Ожидается: FAIL — `box-closed: the office draws the cloud's bytes from the host's rows`, `box-disassembled: the office draws the cloud's bytes from the host's rows`, `pallet-report-closed: the office draws the cloud's bytes from the host's rows` и ещё 6.
- **M2** (водяной знак расформированной паллеты): в `apps/standalone/src/office/forms/form-data.ts` `status: pallet.disassembledAt !== null ? "disassembled" : "closed",` → `status: "closed",`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/forms-parity.test.ts test/form-data.test.ts`. Ожидается: FAIL — `has a placard only for a pallet closed with an SSCC, one taken apart too`, `placard-a5-disassembled: the office draws the cloud's bytes from the host's rows`.
- **M3** (ярлыки смены без расформированных паллет): в `apps/standalone/src/office/forms/form-data.ts` `.filter((pallet) => hasPlacard(pallet) && pallet.disassembledAt === null)` → `.filter((pallet) => hasPlacard(pallet))`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/forms-parity.test.ts test/form-data.test.ts`. Ожидается: FAIL — `prints the shift's placards of the pallets closed, standing and numbered, closed first first, then by id`, `shift-placards-a5: the office draws the cloud's bytes from the host's rows`.
- **M4** (равный момент закрытия — по id): в `apps/standalone/src/office/forms/form-data.ts` `.sort((a, b) => byText(a.closedAt ?? "", b.closedAt ?? "") || byText(a.id, b.id));` → `.sort((a, b) => byText(a.closedAt ?? "", b.closedAt ?? ""));`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/forms-parity.test.ts test/form-data.test.ts`. Ожидается: FAIL — `prints the shift's placards of the pallets closed, standing and numbered, closed first first, then by id`.
- **M5** (одна дата смены в обеих датах бланка): в `apps/standalone/src/office/forms/form-data.ts` `plannedDate: shift.productionDate,` → `plannedDate: null,`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/forms-parity.test.ts test/form-data.test.ts`. Ожидается: FAIL — `draws the blank of a planned or an active shift, with its one date as both dates, and none of a closed one`, `task-form-active: the office draws the cloud's bytes from the host's rows`, `task-form-planned: the office draws the cloud's bytes from the host's rows`.
- **M6** (неизвестный пояс организации): в `apps/standalone/src/office/forms/render-form.ts` `organization !== undefined && isKnownTimeZone(organization.timeZone)` → `organization !== undefined`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-data.test.ts`. Ожидается: FAIL — `writes times in the organization's zone, or this PC's when it is not known`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/office/forms/form-data.ts apps/standalone/src/office/forms/render-form.ts apps/standalone/test/form-data.test.ts apps/standalone/test/forms-parity.test.ts
git commit -m "feat(standalone): the office draws a shift's printed forms with the cloud's inputs and bytes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Печать формы: скрытый кадр окна и «Открыть в браузере» через `open_office_file`

Облачный кабинет открывает HTML формы в новой вкладке; у автонома вкладки нет. «Печать» пишет HTML в один скрытый кадр окна офиса (`about:blank` того же источника: CSP окна действует и на форму, а её встроенные стили и SVG он разрешает; сеть не нужна) и печатает этот кадр — WebView2 показывает окно печати для документа кадра с бумагой по `@page` формы. `document.write`, а не `srcdoc`: jsdom не загружает `srcdoc`, а тест должен видеть то, что печатается; Chromium принимает оба. Кадр живёт до следующей печати (диалог мог быть ещё открыт). «Открыть в браузере» сохраняет HTML (UTF-8, как говорит `<meta charset>`) в новую папку `Формы\<номер смены>\<дата_время>_<форма>` (сегменты — как у папки выгрузки ЧЗ) и открывает файл браузером по умолчанию новой командой оболочки `open_office_file`: только `.html`, только из папки, которую сделал `save_office_files` (иначе вебвью могла бы запустить записанную ею же программу), `explorer.exe` на Windows, `unsupported` вне её. Пути в журнал не пишутся.

**Files:**

- Modify: `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src/office/exports/office-files.ts`
- Create: `apps/standalone/src/office/forms/print-form.ts`, `apps/standalone/test/print-form.test.ts`, `apps/standalone/test/support/office-files.ts`
- Test: `apps/standalone/src-tauri/tests/ipc.rs`, `apps/standalone/test/office-files.test.ts`, `apps/standalone/test/export-dialog.test.tsx` (подставные файлы получают `openFile`)

**Interfaces:**

- Consumes: `save_files`, `existing_folder`, `is_plain_name`, `OfficeFilesState` (план ЧЗ); `exportFolder` (`export-checks.ts`, план ЧЗ); `RenderedForm`, `FormKind` (задача 4).
- Produces: оболочка — `office_files::existing_form(root, segments, name) -> Result<PathBuf, OfficeFilesError>`, команда `open_office_file { segments, name }`; `OfficeFilesApi.openFile(segments, name): Promise<void>`; `print-form.ts` — `PRINT_FRAME_ID`, `type PrintWindow`, `printInFrame(html, doc?, print?)`, `formFolder(shiftNumber, kind, formedAt, timeZone): string[]`, `openInBrowser(files, form, folder): Promise<SavedFolder>`; тестовая `fakeOfficeFiles()` (`test/support/office-files.ts`).

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/src-tauri/tests/ipc.rs` фрагмент

<!-- prettier-ignore -->
```rust
    );
}

/// `set_system_awake` takes `awake` (`src/hardware/hardware.ts`) and answers
/// `null`, asked twice or not; letting go never fails. Off Windows it holds
/// nothing. On Windows this test asks for a real power request, which a CI
```

заменить на

<!-- prettier-ignore -->
```rust
    );
}

/// `open_office_file` takes `segments` and `name`
/// (`src/office/exports/office-files.ts`, plan О-Ф) and opens only a form's
/// `.html` the office wrote; refusals are bare codes, and off Windows
/// opening is `unsupported`.
#[test]
fn opening_an_office_form_answers_through_the_ipc_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app_saving_into(OfficeFilesState::at(dir.path().to_path_buf()));
    let segments = json!(["Формы", "OCT26-004", "2026-10-08_18-30-00_task"]);
    invoke(
        &webview,
        "save_office_files",
        json!({
            "segments": segments,
            "files": [{ "name": "Бланк смены.html", "contentBase64": "PCFkb2N0eXBlIGh0bWw+" }]
        }),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &webview,
            "open_office_file",
            json!({ "segments": segments, "name": "Бланк смены.txt" }),
        ),
        Err(json!("invalid_request"))
    );
    assert_eq!(
        invoke(
            &webview,
            "open_office_file",
            json!({ "segments": segments, "name": "Другая форма.html" }),
        ),
        Err(json!("invalid_request"))
    );
    if !cfg!(windows) {
        assert_eq!(
            invoke(
                &webview,
                "open_office_file",
                json!({ "segments": segments, "name": "Бланк смены.html" }),
            ),
            Err(json!("unsupported"))
        );
    }
    let (_app, unavailable) = mock_app_saving_into(OfficeFilesState::unavailable());
    assert_eq!(
        invoke(
            &unavailable,
            "open_office_file",
            json!({ "segments": segments, "name": "Бланк смены.html" }),
        ),
        Err(json!("documents_unavailable"))
    );
}

/// `set_system_awake` takes `awake` (`src/hardware/hardware.ts`) and answers
/// `null`, asked twice or not; letting go never fails. Off Windows it holds
/// nothing. On Windows this test asks for a real power request, which a CI
```

2. В `apps/standalone/test/export-dialog.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
function fakeFiles(): OfficeFilesApi & {
  save: ReturnType<typeof vi.fn<OfficeFilesApi["save"]>>;
  open: ReturnType<typeof vi.fn<OfficeFilesApi["open"]>>;
} {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
```

заменить на

<!-- prettier-ignore -->
```tsx
function fakeFiles(): OfficeFilesApi & {
  save: ReturnType<typeof vi.fn<OfficeFilesApi["save"]>>;
  open: ReturnType<typeof vi.fn<OfficeFilesApi["open"]>>;
  openFile: ReturnType<typeof vi.fn<OfficeFilesApi["openFile"]>>;
} {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
```

3. В `apps/standalone/test/export-dialog.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
  };
}

```

заменить на

<!-- prettier-ignore -->
```tsx
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
    openFile: vi.fn<OfficeFilesApi["openFile"]>(async () => undefined),
  };
}

```

4. В `apps/standalone/test/office-files.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(calls).toEqual([["open_office_folder", { segments: SEGMENTS }]]);
  });

  it.each(["invalid_request", "documents_unavailable", "storage", "unsupported"] as const)(
    "turns the shell's %s into an error of that code",
    async (code: OfficeFilesCode) => {
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(calls).toEqual([["open_office_folder", { segments: SEGMENTS }]]);
  });

  it("opens a form's file by its folder and its name (plan О-Ф)", async () => {
    const { files, calls } = shell(null);
    const form = ["Формы", "OCT26-004", "2026-10-08_18-30-00_task"];
    await files.openFile(form, "Бланк смены.html");
    expect(calls).toEqual([["open_office_file", { segments: form, name: "Бланк смены.html" }]]);
    await expect(shell("unsupported", true).files.openFile(form, "a.html")).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it.each(["invalid_request", "documents_unavailable", "storage", "unsupported"] as const)(
    "turns the shell's %s into an error of that code",
    async (code: OfficeFilesCode) => {
```

5. Создать `apps/standalone/test/print-form.test.ts`:

<!-- prettier-ignore -->
```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { OfficeFilesError } from "../src/office/exports/office-files.js";
import {
  formFolder,
  openInBrowser,
  PRINT_FRAME_ID,
  printInFrame,
} from "../src/office/forms/print-form.js";
import type { RenderedForm } from "../src/office/forms/render-form.js";
import { fakeOfficeFiles } from "./support/office-files.js";

const FORM: RenderedForm = {
  kind: "placard",
  html: '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>@page { size: A5; margin: 0 }</style></head><body><p>Ярлык паллеты</p></body></html>',
  fileName: "Ярлык паллеты 146006820000000409 A5.html",
};

afterEach(() => {
  document.getElementById(PRINT_FRAME_ID)?.remove();
});

describe("printing a form (plan О-Ф)", () => {
  it("writes the form into one hidden frame and prints that frame, not the office", () => {
    const printed: string[] = [];
    printInFrame(FORM.html, document, (view) => {
      printed.push(view.document.documentElement.outerHTML);
    });
    const frame = document.getElementById(PRINT_FRAME_ID);
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
    expect(frame?.tabIndex).toBe(-1);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("@page { size: A5; margin: 0 }");
    expect(printed[0]).toContain("Ярлык паллеты");
    expect(document.body.textContent).not.toContain("Ярлык паллеты");
  });

  it("replaces the frame of the form before, so there is only ever one", () => {
    const print = vi.fn<(view: Window) => void>();
    printInFrame("<p>first</p>", document, print);
    printInFrame("<p>second</p>", document, print);
    expect(document.querySelectorAll(`#${PRINT_FRAME_ID}`)).toHaveLength(1);
    const frame = document.getElementById(PRINT_FRAME_ID);
    expect(frame instanceof HTMLIFrameElement && frame.contentDocument?.body.textContent).toBe(
      "second",
    );
    expect(print).toHaveBeenCalledTimes(2);
  });

  it("puts a form's file in its own folder under «Формы», named by the shift and the moment", () => {
    expect(
      formFolder("OCT26-004/S", "placards", "2026-10-08T15:30:00.000Z", "Europe/Moscow"),
    ).toEqual(["Формы", "OCT26-004_S", "2026-10-08_18-30-00_placards"]);
  });

  it("saves the form's HTML as UTF-8 and opens the file it saved, « (2)» included", async () => {
    const files = fakeOfficeFiles();
    files.save.mockImplementation(async (segments, saved) => ({
      segments: [...segments.slice(0, -1), `${segments.at(-1) ?? ""} (2)`],
      path: "C:\\Users\\Оператор\\Documents\\Markiro\\Формы",
      files: saved.map((file) => file.name),
    }));
    const folder = ["Формы", "OCT26-004", "2026-10-08_18-30-00_placard"];
    const saved = await openInBrowser(files, FORM, folder);
    expect(files.save).toHaveBeenCalledWith(folder, [
      { name: FORM.fileName, bytes: new TextEncoder().encode(FORM.html) },
    ]);
    expect(files.openFile).toHaveBeenCalledWith(
      ["Формы", "OCT26-004", "2026-10-08_18-30-00_placard (2)"],
      FORM.fileName,
    );
    expect(saved.segments.at(-1)).toBe("2026-10-08_18-30-00_placard (2)");
  });

  it("opens nothing when the file was not saved, and says why", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no folder"));
    await expect(openInBrowser(files, FORM, ["Формы", "OCT26-004", "x"])).rejects.toMatchObject({
      code: "documents_unavailable",
    });
    expect(files.openFile).not.toHaveBeenCalled();
  });
});
```

6. Создать `apps/standalone/test/support/office-files.ts`:

<!-- prettier-ignore -->
```ts
import { vi, type Mock } from "vitest";

import type { OfficeFilesApi, SavedFolder } from "../../src/office/exports/office-files.js";

/** The office's files as a test sees them: every command a mock. */
export type FakeOfficeFiles = { [K in keyof OfficeFilesApi]: Mock<OfficeFilesApi[K]> };

/** A shell that saves into `C:\Users\Оператор\Documents\Markiro\<segments>`, shows and opens. */
export function fakeOfficeFiles(): FakeOfficeFiles {
  return {
    save: vi.fn<OfficeFilesApi["save"]>(async (segments, files): Promise<SavedFolder> => ({
      segments: [...segments],
      path: `C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}`,
      files: files.map((file) => file.name),
    })),
    open: vi.fn<OfficeFilesApi["open"]>(async () => undefined),
    openFile: vi.fn<OfficeFilesApi["openFile"]>(async () => undefined),
  };
}
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test ipc -- opening_an_office_form saving_office_files the_app_manages_every_state`

Expected: FAIL: `test result: FAILED. 2 passed; 1 failed` — `opening_an_office_form_answers_through_the_ipc_shapes`: `left: Err(String("Command open_office_file not found"))`. Новый тест модуля `office_files::tests` пишется вместе с кодом в шаге 3 (он внутри файла реализации).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form.test.ts test/office-files.test.ts test/export-dialog.test.tsx`

Expected: FAIL: `Failed to resolve import "../src/office/forms/print-form.js"`; в `office-files` — «opens a form's file by its folder and its name (plan О-Ф)» (`files.openFile is not a function`); `Tests  1 failed | 15 passed (16)`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src-tauri/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        scanner::get_scanner_connections,
        scanner::close_scanners,
        office_files::save_office_files,
        office_files::open_office_folder
    ]
}

```

заменить на

<!-- prettier-ignore -->
```rust
        scanner::get_scanner_connections,
        scanner::close_scanners,
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file
    ]
}

```

2. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Files the office saves on this computer (plan ЧЗ): the parts of an export
//! today, a form's HTML for plan О-Ф next. Everything goes under
//! `Документы\Markiro` (the system's documents folder, `document_dir`), in a
//! first folder of [`ROOTS`] and the segments the webview names: no file
//! dialog, so no plugin and no new dependency (pilot spec, question П16).
```

заменить на

<!-- prettier-ignore -->
```rust
//! Files the office saves on this computer (plan ЧЗ): the parts of an export
//! and a printed form's HTML (plan О-Ф). Everything goes under
//! `Документы\Markiro` (the system's documents folder, `document_dir`), in a
//! first folder of [`ROOTS`] and the segments the webview names: no file
//! dialog, so no plugin and no new dependency (pilot spec, question П16).
```

3. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! and an export never lands beside an older one's parts. Every name is
//! checked before anything is written, and a call that fails takes back
//! the folder it made. `open_office_folder` shows such a folder in Windows
//! Explorer. A failure is logged by its code and the I/O error's kind,
//! never by a path, which names the Windows user.

use std::fs::{self, File};
use std::io::Write;
```

заменить на

<!-- prettier-ignore -->
```rust
//! and an export never lands beside an older one's parts. Every name is
//! checked before anything is written, and a call that fails takes back
//! the folder it made. `open_office_folder` shows such a folder in Windows
//! Explorer, and `open_office_file` opens a form's `.html` there with the
//! program Windows has for it, the default browser (plan О-Ф). A failure is
//! logged by its code and the I/O error's kind, never by a path, which
//! names the Windows user.

use std::fs::{self, File};
use std::io::Write;
```

4. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
    DocumentsUnavailable,
    /// Writing failed (a full disk, no access); what this call made is gone.
    Storage,
    /// Showing a folder needs Windows Explorer.
    Unsupported,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    DocumentsUnavailable,
    /// Writing failed (a full disk, no access); what this call made is gone.
    Storage,
    /// Showing a folder or opening a file needs Windows Explorer.
    Unsupported,
}

```

5. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
}

#[cfg(windows)]
fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    // Explorer answers 1 even when it opened the folder: only a failure to
```

заменить на

<!-- prettier-ignore -->
```rust
    }
}

/// The form `root/segments…/name` to open: a `.html` file `save_files`
/// wrote, in a folder of [`ROOTS`]. Nothing else is opened, so no file the
/// webview names can be started as a program.
pub fn existing_form(
    root: &Path,
    segments: &[String],
    name: &str,
) -> Result<PathBuf, OfficeFilesError> {
    let folder = existing_folder(root, segments)?;
    if !is_plain_name(name) || !name.to_lowercase().ends_with(".html") {
        return Err(OfficeFilesError::InvalidRequest);
    }
    let file = folder.join(name);
    if file.is_file() {
        Ok(file)
    } else {
        Err(OfficeFilesError::InvalidRequest)
    }
}

#[cfg(windows)]
fn open_in_default_program(file: &Path) -> Result<(), OfficeFilesError> {
    // Explorer opens a file with the program registered for its type (a
    // `.html` in the default browser) and, like a folder, answers 1 even
    // when it did: only a failure to start it counts.
    std::process::Command::new("explorer.exe")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            eprintln!("standalone: open_office_file storage: {:?}", error.kind());
            OfficeFilesError::Storage
        })
}

#[cfg(not(windows))]
fn open_in_default_program(_file: &Path) -> Result<(), OfficeFilesError> {
    Err(OfficeFilesError::Unsupported)
}

#[cfg(windows)]
fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    // Explorer answers 1 even when it opened the folder: only a failure to
```

6. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_folder(&root, &segments)
        .and_then(|folder| show_in_explorer(&folder))
        .map_err(|error| error.code().to_owned())
}

```

заменить на

<!-- prettier-ignore -->
```rust
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_folder(&root, &segments)
        .and_then(|folder| show_in_explorer(&folder))
        .map_err(|error| error.code().to_owned())
}

/// Opens a form's `.html` that `save_office_files` wrote in the default
/// browser, where the office prints it (plan О-Ф).
#[tauri::command]
pub async fn open_office_file(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
    name: String,
) -> Result<(), String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_form(&root, &segments, &name)
        .and_then(|file| open_in_default_program(&file))
        .map_err(|error| error.code().to_owned())
}

```

7. В `apps/standalone/src-tauri/src/office_files.rs` фрагмент

<!-- prettier-ignore -->
```rust
            );
        }
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
            );
        }
    }

    /// Only a form's `.html` the office wrote is opened: not another file of
    /// its folder, not a name that is no plain name, not a missing file, not
    /// a folder outside the roots; opening it needs Windows.
    #[test]
    fn only_a_form_of_the_office_is_opened() {
        let root = tempfile::tempdir().unwrap();
        let saved = save_files(
            root.path(),
            &segments(&["Формы", "OCT26-004", "2026-10-08_18-30-00_box"]),
            &[
                file("Состав короба 046006820000015000.html", b"<!doctype html>"),
                file("run.exe", b"MZ"),
            ],
        )
        .unwrap();
        let form = existing_form(
            root.path(),
            &saved.segments,
            "Состав короба 046006820000015000.html",
        )
        .unwrap();
        assert_eq!(fs::read(&form).unwrap(), b"<!doctype html>");
        for name in ["run.exe", "..", "a/b.html", "missing.html", ""] {
            assert_eq!(
                existing_form(root.path(), &saved.segments, name),
                Err(OfficeFilesError::InvalidRequest),
                "{name:?}"
            );
        }
        assert_eq!(
            existing_form(
                root.path(),
                &segments(&["Документы", "OCT26-004"]),
                "Состав короба 046006820000015000.html"
            ),
            Err(OfficeFilesError::InvalidRequest)
        );
        if !cfg!(windows) {
            assert_eq!(
                open_in_default_program(&form),
                Err(OfficeFilesError::Unsupported)
            );
        }
    }
}
```

8. В `apps/standalone/src/office/exports/office-files.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { bytesToBase64 } from "../../hardware/hardware.js";

/**
 * The shell's `save_office_files` and `open_office_folder`
 * (`src-tauri/src/office_files.rs`, plan ЧЗ): the office's files go into a
 * new folder under `Документы\Markiro\<segments…>`, the first segment one of
 * the shell's roots (`Выгрузки`, `Формы`); no file dialog.
 */

/** The codes the shell refuses with (`OfficeFilesError::code`). */
```

заменить на

<!-- prettier-ignore -->
```ts
import { bytesToBase64 } from "../../hardware/hardware.js";

/**
 * The shell's `save_office_files`, `open_office_folder` and `open_office_file`
 * (`src-tauri/src/office_files.rs`, plans ЧЗ and О-Ф): the office's files go
 * into a new folder under `Документы\Markiro\<segments…>`, the first segment
 * one of the shell's roots (`Выгрузки`, `Формы`); no file dialog.
 */

/** The codes the shell refuses with (`OfficeFilesError::code`). */
```

9. В `apps/standalone/src/office/exports/office-files.ts` фрагмент

<!-- prettier-ignore -->
```ts
  save: (segments: readonly string[], files: readonly OfficeFile[]) => Promise<SavedFolder>;
  /** Shows a folder `save` made in Windows Explorer. */
  open: (segments: readonly string[]) => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
```

заменить на

<!-- prettier-ignore -->
```ts
  save: (segments: readonly string[], files: readonly OfficeFile[]) => Promise<SavedFolder>;
  /** Shows a folder `save` made in Windows Explorer. */
  open: (segments: readonly string[]) => Promise<void>;
  /** Opens a form's `.html` that `save` wrote in the default browser (plan О-Ф). */
  openFile: (segments: readonly string[], name: string) => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
```

10. В `apps/standalone/src/office/exports/office-files.ts` фрагмент

<!-- prettier-ignore -->
```ts
    open: async (segments) => {
      await run("open_office_folder", { segments: [...segments] });
    },
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
    open: async (segments) => {
      await run("open_office_folder", { segments: [...segments] });
    },
    openFile: async (segments, name) => {
      await run("open_office_file", { segments: [...segments], name });
    },
  };
}
```

11. Создать `apps/standalone/src/office/forms/print-form.ts`:

<!-- prettier-ignore -->
```ts
import { exportFolder } from "../exports/export-checks.js";
import type { OfficeFilesApi, SavedFolder } from "../exports/office-files.js";
import type { FormKind, RenderedForm } from "./render-form.js";

/**
 * How the office prints a form (plan О-Ф): the cloud cabinet opens the
 * form's HTML in a new tab and the browser prints it through its `@page`
 * size; the standalone has no tab. Two ways, both offline and without a new
 * dependency, both offered next to each other (no failure of the first can
 * be seen to offer the second):
 *
 * - «Печать»: the HTML is written into a hidden frame of the office's own
 *   window and that frame prints, so WebView2 shows its print dialog for the
 *   form alone, A4 or A5 by the form's `@page`;
 * - «Открыть в браузере»: the HTML is saved as a file under
 *   `Документы\Markiro\Формы` and the shell opens it in the default browser,
 *   where it prints as the cloud's tab does.
 */

/** The id of the one frame the office prints through; each print replaces it. */
export const PRINT_FRAME_ID = "office-print-frame";

/** Prints the window of a frame; tests pass their own. */
export type PrintWindow = (view: Window) => void;

/**
 * Writes `html` into a new hidden frame of `doc` (the frame before it, kept
 * until now in case its dialog was still open, goes) and prints that frame.
 * The frame is same-origin `about:blank`, so the window's CSP holds for the
 * form too: its inline styles and inline SVG are allowed, and it loads
 * nothing from the network.
 */
export function printInFrame(
  html: string,
  doc: Document = document,
  print: PrintWindow = (view) => view.print(),
): void {
  doc.getElementById(PRINT_FRAME_ID)?.remove();
  const frame = doc.createElement("iframe");
  frame.id = PRINT_FRAME_ID;
  frame.title = "print";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  doc.body.append(frame);
  const view = frame.contentWindow;
  const written = frame.contentDocument;
  if (view === null || written === null) {
    frame.remove();
    throw new Error("the print frame has no document");
  }
  written.open();
  written.write(html);
  written.close();
  view.focus();
  print(view);
}

/**
 * Where a form's file goes for «Открыть в браузере», as the shell's segments
 * under `Документы\Markiro`: `Формы\<номер смены>\<дата_время>_<форма>`, the
 * number and the moment written as an export's folder writes them (plan ЧЗ),
 * one new folder a form.
 */
export function formFolder(
  shiftNumber: string,
  kind: FormKind,
  formedAt: string,
  timeZone: string,
): string[] {
  return ["Формы", ...exportFolder(shiftNumber, kind, formedAt, timeZone).slice(1)];
}

/**
 * Saves the form's HTML, UTF-8 as its `<meta charset>` says, into `folder`
 * and opens it in the default browser; answers where it went, so the dialog
 * can name it and show the folder.
 */
export async function openInBrowser(
  files: OfficeFilesApi,
  form: RenderedForm,
  folder: readonly string[],
): Promise<SavedFolder> {
  const saved = await files.save(folder, [
    { name: form.fileName, bytes: new TextEncoder().encode(form.html) },
  ]);
  await files.openFile(saved.segments, form.fileName);
  return saved;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`

Expected: PASS: `test result: ok. 7 passed`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test ipc -- opening_an_office_form saving_office_files the_app_manages_every_state`

Expected: PASS: `test result: ok. 3 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form.test.ts test/office-files.test.ts test/export-dialog.test.tsx`

Expected: PASS: `Tests  21 passed (21)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **S1** (открывается только `.html`): в `apps/standalone/src-tauri/src/office_files.rs` `if !is_plain_name(name) || !name.to_lowercase().ends_with(".html") {` → `if !is_plain_name(name) {`
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib office_files`. Ожидается: FAIL — `office_files::tests::only_a_form_of_the_office_is_opened`.
- **S2** (открывается сохранённая папка (« (2)»)): в `apps/standalone/src/office/forms/print-form.ts` `await files.openFile(saved.segments, form.fileName);` → `await files.openFile(folder, form.fileName);`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form.test.ts`. Ожидается: FAIL — `saves the form's HTML as UTF-8 and opens the file it saved, « (2)» included`.
- **S3** (один кадр печати): в `apps/standalone/src/office/forms/print-form.ts` `doc.getElementById(PRINT_FRAME_ID)?.remove();` → (удалить строку)
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form.test.ts`. Ожидается: FAIL — `replaces the frame of the form before, so there is only ever one`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/src/office_files.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src/office/exports/office-files.ts apps/standalone/src/office/forms/print-form.ts apps/standalone/test/export-dialog.test.tsx apps/standalone/test/office-files.test.ts apps/standalone/test/print-form.test.ts apps/standalone/test/support/office-files.ts
git commit -m "feat(standalone): a form prints in a hidden frame of the office or opens in the default browser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Карточка смены: страница `shifts/:id`, короба, паллеты, «Итоги», «Выгрузка», «Закрыть»

Карточка — страница по маршруту `shifts/:id` (как `templates/:id`), а не боковая панель облака: над ней открываются три существующих диалога, и страница читает смену заново (`getShift`, `officeKeys.shift`). Номер смены в «Сменах» становится ссылкой («Карточка смены …») — кнопок строки это не меняет. Карточка показывает поля смены (товар, дата, линия, контрагент, режим, план, вместимости, выпуск, открыта/закрыта по поясу организации), статус и отметки, как колонка «Статус» списка; короба (`GET …/boxes`, по 50 на страницу, фильтр по последним цифрам SSCC — только цифры), их состояние (расформированный — с моментом), паллету, последнюю проверку этикетки (более поздняя из двух меток станции) и несошедшийся дайджест закрытия; паллеты (`GET …/pallets`) с отметкой расхождения счёта станции. Действия — те же диалоги, что у строки списка: «Итоги» (`ShiftTotalsDialog`), «Выгрузка» (`ExportDialog` из ЧЗ как есть), «Закрыть» (`CloseShiftDialog`, `planShifts`); закрытие перечитывает карточку и все списки смен. Формы — задача 7.

**Files:**

- Create: `apps/standalone/src/office/shifts/ShiftCardPage.tsx`, `apps/standalone/src/office/shifts/shift-card.ts`, `apps/standalone/test/shift-card.test.tsx`
- Modify: `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`

**Interfaces:**

- Consumes: `HostApi.getShift`, `listShiftBoxes`, `listShiftPallets`, `listProducts`, `listLines`, `listCounterparties`, `getOrg`; `ShiftTotalsDialog` (2a3), `ExportDialog` (ЧЗ), `CloseShiftDialog` (2a3); `recordLabel`, `civilDateLabel` (`shift-list.ts`); `formTimeZone` (задача 4); `OfficePager`.
- Produces: маршрут `shifts/:id` → `ShiftCardPage`; `officeKeys.shiftBoxes(id)`, `officeKeys.shiftPallets(id)`; `shift-card.ts` — `BOX_PAGE_SIZE = 50`, `type PackState`, `packState(pack)`, `type LabelState`, `labelState(pack)`, `ssccTail(typed)`, `endsWithTail(sscc, tail)`, `ssccText(sscc)`; тексты `office.shiftCard.*`, `office.shifts.cardNamed`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/shift-card.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeBox, OfficePallet, OfficeShift } from "../src/host/protocol.js";
import { endsWithTail, labelState, packState, ssccTail } from "../src/office/shifts/shift-card.js";
import { type FakeOfficeSession } from "./support/office.js";
import { ACTIVE, CLOSED, openShifts, PALLET, PLANNED, shiftsSession } from "./support/shifts.js";

const STATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** The active shift with pallets of 40 boxes. */
const WITH_PALLETS: OfficeShift = {
  ...ACTIVE,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
};

function box(n: number, fields: Partial<OfficeBox> = {}): OfficeBox {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    deviceId: STATION,
    sscc: `0460068200000${String(15000 + n).padStart(5, "0")}`,
    openedAt: "2026-10-08T06:05:12.031Z",
    closedAt: "2026-10-08T06:06:01.118Z",
    disassembledAt: null,
    palletId: null,
    units: 12,
    itemCountReported: 12,
    digestMatches: true,
    printVerifiedAt: null,
    printSkippedAt: null,
    ...fields,
  };
}

const PALLET_1: OfficePallet = {
  id: "a0000000-0000-4000-8000-000000000001",
  deviceId: STATION,
  sscc: "146006820000000409",
  openedAt: "2026-10-08T06:06:01.118Z",
  closedAt: "2026-10-08T06:20:44.650Z",
  disassembledAt: null,
  boxes: 1,
  units: 12,
  boxCountReported: 2,
  printVerifiedAt: "2026-10-08T06:20:51.300Z",
  printSkippedAt: null,
};
const PALLET_2: OfficePallet = {
  ...PALLET_1,
  id: "a0000000-0000-4000-8000-000000000002",
  sscc: null,
  closedAt: null,
  boxCountReported: null,
  printVerifiedAt: null,
};

/** Box 1 on pallet 1, box 2 taken apart from it, box 3 open on no pallet, box 4 whose digest failed. */
const BOXES: OfficeBox[] = [
  box(1, { palletId: PALLET_1.id, printVerifiedAt: "2026-10-08T06:06:09.540Z" }),
  box(2, {
    palletId: PALLET_1.id,
    units: 0,
    disassembledAt: "2026-10-08T07:00:00.000Z",
    printSkippedAt: "2026-10-08T06:07:20.001Z",
  }),
  box(3, { sscc: null, closedAt: null, units: 5, itemCountReported: null, digestMatches: null }),
  box(4, { digestMatches: false, palletId: PALLET_2.id }),
];

/** «Смены» with the shift listed, its card's reads stubbed. */
function cardSession(
  shift: OfficeShift,
  boxes: OfficeBox[] = BOXES,
  pallets: OfficePallet[] = [PALLET_1, PALLET_2],
): FakeOfficeSession {
  const session = shiftsSession([shift, PLANNED, CLOSED]);
  session.api.getShift.mockResolvedValue(shift);
  session.api.listShiftBoxes.mockResolvedValue(boxes);
  session.api.listShiftPallets.mockResolvedValue(pallets);
  return session;
}

/** Opens the shift's card from its number in the list. */
async function openCard(session: FakeOfficeSession, number: string): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The rows of a section's table, cell texts each. */
function rowsOf(name: string): string[][] {
  return within(section(name))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

describe("the card of a shift (plan О-Ф)", () => {
  it("opens from the shift's number and shows the shift, its boxes and its pallets as the host has them now", async () => {
    const session = cardSession(WITH_PALLETS);
    await openCard(session, "OCT26-004");
    expect(session.api.getShift).toHaveBeenCalledWith("office-session-token", ACTIVE.id);
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    expect(screen.getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(screen.getByText("По 40 кор.")).toBeTruthy();
    expect(rowsOf("Короба")).toEqual([
      [
        "(00)046006820000015001",
        "12",
        "08.10.2026, 09:06",
        "(00)146006820000000409",
        "✓Закрыт",
        "Проверена",
      ],
      [
        "(00)046006820000015002",
        "0",
        "08.10.2026, 09:06",
        "(00)146006820000000409",
        "⊘Расформирован08.10.2026, 10:00",
        "Пропущена",
      ],
      ["Без SSCC", "5", "—", "—", "▸Открыт", "—"],
      [
        "(00)046006820000015004",
        "12",
        "08.10.2026, 09:06",
        "Открытая",
        "✓Закрыт!Состав при закрытии не сошёлся",
        "Не проверялась",
      ],
    ]);
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(3));
    expect(rowsOf("Паллеты")).toEqual([
      [
        "(00)146006820000000409",
        "1",
        "12",
        "08.10.2026, 09:20",
        "✓Закрыта!Счёт коробов станции другой",
      ],
      ["Без SSCC", "1", "12", "—", "▸Открыта"],
    ]);
  });

  it("keeps the boxes whose SSCC ends with the digits typed, drops anything else typed, and says so when none does", async () => {
    await openCard(cardSession(ACTIVE), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(5));
    const tail = within(section("Короба")).getByLabelText("Последние цифры SSCC");
    fireEvent.change(tail, { target: { value: "5 00-2" } });
    expect(tail instanceof HTMLInputElement && tail.value).toBe("5002");
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015002"]);
    expect(screen.getByText("Показано 1 из 4")).toBeTruthy();
    fireEvent.change(tail, { target: { value: "999" } });
    expect(screen.getByText("Нет коробов с таким окончанием SSCC")).toBeTruthy();
    // A shift without pallets has no pallet column and no pallets.
    expect(screen.queryByRole("region", { name: "Паллеты" })).toBeNull();
    expect(within(section("Короба")).queryByRole("columnheader", { name: "Паллета" })).toBeNull();
  });

  it("shows the boxes fifty to a page", async () => {
    const many = Array.from({ length: 51 }, (_, index) => box(index + 1));
    await openCard(cardSession(ACTIVE, many), "OCT26-004");
    await waitFor(() => expect(within(section("Короба")).getAllByRole("row")).toHaveLength(51));
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(rowsOf("Короба").map((row) => row[0])).toEqual(["(00)046006820000015051"]);
  });

  it("has neither boxes nor figures nor exports for a planned shift", async () => {
    const session = cardSession(PLANNED);
    session.api.listShifts.mockResolvedValue([PLANNED]);
    await openCard(session, PLANNED.number);
    expect(screen.queryByRole("region", { name: "Короба" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Итоги" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Выгрузка" })).toBeNull();
    expect(session.api.listShiftBoxes).not.toHaveBeenCalled();
  });

  it("closes an active shift from the card and reads it again", async () => {
    const session = cardSession(ACTIVE);
    const closed: OfficeShift = { ...ACTIVE, status: "closed", closeReasonText: "Сбой линии" };
    session.api.closeShift.mockResolvedValue(closed);
    await openCard(session, "OCT26-004");
    session.api.getShift.mockResolvedValue(closed);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Сбой линии" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену" }));
    await screen.findByText("Смена OCT26-004 закрыта.");
    await screen.findByText("Закрыта в офисе: Сбой линии");
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
    expect(screen.getByRole("button", { name: "Выгрузка" })).toBeTruthy();
  });

  it("says when the shift did not load, and loads it again", async () => {
    const session = cardSession(ACTIVE);
    session.api.getShift.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openShifts(session);
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("link", { name: "← Смены" }));
    await screen.findByRole("heading", { name: "Смены" });
  });
});

describe("what the card says of a box or a pallet", () => {
  it("takes apart over closed, and closed over open", () => {
    expect(packState({ closedAt: null, disassembledAt: null })).toBe("open");
    expect(packState({ closedAt: "2026-10-08T06:00:00.000Z", disassembledAt: null })).toBe(
      "closed",
    );
    expect(
      packState({
        closedAt: "2026-10-08T06:00:00.000Z",
        disassembledAt: "2026-10-08T07:00:00.000Z",
      }),
    ).toBe("disassembled");
  });

  it("reads the later label check of the two", () => {
    const early = "2026-10-08T06:00:00.000Z";
    const late = "2026-10-08T06:00:00.001Z";
    expect(labelState({ printVerifiedAt: null, printSkippedAt: null })).toBe("none");
    expect(labelState({ printVerifiedAt: early, printSkippedAt: null })).toBe("verified");
    expect(labelState({ printVerifiedAt: null, printSkippedAt: early })).toBe("skipped");
    expect(labelState({ printVerifiedAt: late, printSkippedAt: early })).toBe("verified");
    expect(labelState({ printVerifiedAt: early, printSkippedAt: late })).toBe("skipped");
  });

  it("filters by the digits an SSCC ends with", () => {
    expect(ssccTail(" 12-3a4")).toBe("1234");
    expect(endsWithTail("046006820000015002", "5002")).toBe(true);
    expect(endsWithTail("046006820000015002", "5003")).toBe(false);
    // The digits must end the SSCC, not stand anywhere in it.
    expect(endsWithTail("046006820000015002", "1500")).toBe(false);
    expect(endsWithTail("046006820000015002", "")).toBe(true);
    expect(endsWithTail(null, "")).toBe(true);
    expect(endsWithTail(null, "2")).toBe(false);
  });
});
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-card.test.tsx`

Expected: FAIL: `Failed to resolve import "../src/office/shifts/shift-card.js"`, `Tests  no tests`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/app/shell.css` фрагмент

<!-- prettier-ignore -->
```
  color: var(--err-fg);
}

.office-pager {
  display: flex;
  justify-content: flex-end;
```

заменить на

<!-- prettier-ignore -->
```
  color: var(--err-fg);
}

/* The card of a shift (plan О-Ф): its parts one under another. */
.shift-card {
  display: grid;
  gap: 16px;
}

.shift-card__back {
  justify-self: start;
}

.shift-card__section {
  display: grid;
  gap: 8px;
}

.shift-card__section > h2 {
  margin: 0;
  font: var(--text-h3);
}

.office-pager {
  display: flex;
  justify-content: flex-end;
```

2. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "exportNamed": "Выгрузка смены {{number}}",
      "totalsAction": "Итоги",
      "totalsNamed": "Итоги смены {{number}}",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
```

заменить на

<!-- prettier-ignore -->
```json
      "exportNamed": "Выгрузка смены {{number}}",
      "totalsAction": "Итоги",
      "totalsNamed": "Итоги смены {{number}}",
      "cardNamed": "Карточка смены {{number}}",
      "createTitle": "Новая смена",
      "create": "Запланировать",
      "created": "Смена {{number}} запланирована.",
```

3. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
        "nowClosed": "Смена уже закрыта. Список смен обновлён.",
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
      }
    },
    "exports": {
```

заменить на

<!-- prettier-ignore -->
```json
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
        "nowClosed": "Смена уже закрыта. Список смен обновлён.",
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
      }
    },
    "shiftCard": {
      "back": "← Смены",
      "title": "Смена {{number}}",
      "counterparty": "Контрагент",
      "boxCapacity": "Вместимость короба, шт",
      "pallets": {
        "title": "Паллеты",
        "table": "Список паллет",
        "empty": "Паллет ещё нет",
        "sscc": "SSCC",
        "boxes": "Коробов",
        "units": "Кодов",
        "closedAt": "Закрыта",
        "state": "Состояние"
      },
      "noPallets": "Не собираются",
      "palletCapacity": "По {{boxes}} кор.",
      "openedAt": "Открыта",
      "closedAt": "Закрыта",
      "noSscc": "Без SSCC",
      "unknownPallet": "Паллета не найдена",
      "openPallet": "Открытая",
      "disassembledAt": "{{at}}",
      "boxMismatch": "Состав при закрытии не сошёлся",
      "palletMismatch": "Счёт коробов станции другой",
      "boxState": {
        "open": "Открыт",
        "closed": "Закрыт",
        "disassembled": "Расформирован"
      },
      "palletState": {
        "open": "Открыта",
        "closed": "Закрыта",
        "disassembled": "Расформирована"
      },
      "label": {
        "verified": "Проверена",
        "skipped": "Пропущена",
        "none": "Не проверялась"
      },
      "boxes": {
        "title": "Короба",
        "table": "Список коробов",
        "tail": "Последние цифры SSCC",
        "tailHint": "Только цифры: короба, чей SSCC ими кончается",
        "found": "Показано {{shown}} из {{total}}",
        "empty": "Коробов ещё нет",
        "none": "Нет коробов с таким окончанием SSCC",
        "pager": "Страницы коробов",
        "sscc": "SSCC",
        "units": "Кодов",
        "closedAt": "Закрыт",
        "pallet": "Паллета",
        "state": "Состояние",
        "label": "Этикетка"
      }
    },
    "exports": {
```

4. В `apps/standalone/src/office/office-query.ts` фрагмент

<!-- prettier-ignore -->
```ts
  shiftExportSource: (id: string) => ["office", "shift-export-source", id],
  /** One shift with its figures (`GET /v1/office/shifts/{id}`), read afresh at every opening. */
  shift: (id: string) => ["office", "shift", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

заменить на

<!-- prettier-ignore -->
```ts
  shiftExportSource: (id: string) => ["office", "shift-export-source", id],
  /** One shift with its figures (`GET /v1/office/shifts/{id}`), read afresh at every opening. */
  shift: (id: string) => ["office", "shift", id],
  /** A shift's boxes and pallets for its card (`GET …/{id}/boxes`, `…/pallets`, plan О-Ф). */
  shiftBoxes: (id: string) => ["office", "shift-boxes", id],
  shiftPallets: (id: string) => ["office", "shift-pallets", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

5. В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { ShiftsPage } from "./shifts/ShiftsPage.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { OrgProfilePage } from "./org/OrgProfilePage.js";
import { ProductsPage } from "./products/ProductsPage.js";
import { RequireRole } from "./RequireRole.js";
import { ShiftCardPage } from "./shifts/ShiftCardPage.js";
import { ShiftsPage } from "./shifts/ShiftsPage.js";
import { SsccPage } from "./sscc/SsccPage.js";
import { TemplateDefaultsPage } from "./templates/TemplateDefaultsPage.js";
```

6. В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      { path: "shifts", element: <ShiftsPage /> },
      {
        path: "operators",
        element: (
```

заменить на

<!-- prettier-ignore -->
```tsx
      { path: "counterparties", element: <CounterpartiesPage /> },
      { path: "lines", element: <LinesPage /> },
      { path: "shifts", element: <ShiftsPage /> },
      { path: "shifts/:id", element: <ShiftCardPage /> },
      {
        path: "operators",
        element: (
```

7. Создать `apps/standalone/src/office/shifts/ShiftCardPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  DefinitionGrid,
  Input,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeBox, OfficePallet, OfficeShift, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { ExportDialog } from "../exports/ExportDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { CloseShiftDialog } from "./CloseShiftDialog.js";
import {
  BOX_PAGE_SIZE,
  endsWithTail,
  labelState,
  packState,
  ssccTail,
  ssccText,
  type PackState,
} from "./shift-card.js";
import { civilDateLabel, recordLabel } from "./shift-list.js";
import { ShiftTotalsDialog } from "./ShiftTotalsDialog.js";

/** A status in its phase, as the list shows it. */
const STATUS_PHASE = {
  planned: "planned",
  active: "active",
  closed: "done",
} as const satisfies Record<ShiftStatus, TagPhase>;

/** A box's or a pallet's state in its phase: the cloud tags one taken apart `dismantled`. */
const PACK_PHASE = {
  open: "active",
  closed: "done",
  disassembled: "dismantled",
} as const satisfies Record<PackState, TagPhase>;

/** Counts with the thousands apart by a no-break space: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

type CardDialog = "totals" | "export" | "close";

/**
 * The card of a shift (plan О-Ф, pilot spec §7), opened from «Смены» by the
 * shift's number: what the shift is, its boxes and its pallets as the host
 * derives them now, and what the office does with it — the figures
 * («Итоги»), the exports («Выгрузка», plan ЧЗ) and the close. Every role
 * reads it; closing stays with `planShifts`. Times are written in the
 * organization's zone, as the forms write them.
 */
export function ShiftCardPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const shift = useOfficeQuery(officeKeys.shift(id), (api, token) => api.getShift(token, id));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  /** After a close: the card and every list of shifts are read again. */
  const readAgain = () => {
    void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shift(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftBoxes(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.shiftPallets(id) });
  };

  const back = (
    <Link className="shift-card__back" to="/shifts">
      {t("office.shiftCard.back")}
    </Link>
  );
  if (shift.isPending) {
    return (
      <>
        {back}
        <PageLoading />
      </>
    );
  }
  if (shift.isError) {
    return (
      <>
        {back}
        <LoadError error={shift.error} onRetry={() => void shift.refetch()} />
      </>
    );
  }

  const current = shift.data;
  const zone = formTimeZone(org.data);
  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: zone,
  });
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : time.format(new Date(instant));

  return (
    <div className="shift-card">
      {back}
      <PageHeader
        title={t("office.shiftCard.title", { number: current.number })}
        actions={
          <RowActions>
            {current.status !== "planned" && (
              <Button variant="secondary" onClick={() => setDialog("totals")}>
                {t("office.shifts.totalsAction")}
              </Button>
            )}
            {current.status !== "planned" && (
              <Button variant="secondary" onClick={() => setDialog("export")}>
                {t("office.shifts.export")}
              </Button>
            )}
            {canPlan && current.status === "active" && (
              <Button variant="secondary" onClick={() => setDialog("close")}>
                {t("office.shifts.close")}
              </Button>
            )}
          </RowActions>
        }
      />
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      <ShiftStatusLine shift={current} />
      <DefinitionGrid
        items={[
          {
            id: "product",
            term: t("office.shifts.table.product"),
            description: recordLabel("product", products.data, current.productId, t),
          },
          {
            id: "productionDate",
            term: t("office.shifts.table.productionDate"),
            description: civilDateLabel(current.productionDate),
            mono: true,
          },
          {
            id: "line",
            term: t("office.shifts.table.line"),
            description: recordLabel("line", lines.data, current.lineId, t),
          },
          {
            id: "counterparty",
            term: t("office.shiftCard.counterparty"),
            description:
              current.counterpartyId === null
                ? t("office.common.none")
                : recordLabel("counterparty", counterparties.data, current.counterpartyId, t),
          },
          {
            id: "mode",
            term: t("office.shifts.table.mode"),
            description: t(`office.shifts.modes.${current.mode}`),
          },
          {
            id: "plannedQty",
            term: t("office.shifts.table.plannedQty"),
            description:
              current.plannedQty === null
                ? t("office.common.none")
                : UNITS.format(current.plannedQty),
            mono: true,
          },
          {
            id: "boxCapacity",
            term: t("office.shiftCard.boxCapacity"),
            description: UNITS.format(current.boxCapacity),
            mono: true,
          },
          {
            id: "pallets",
            term: t("office.shiftCard.pallets"),
            description:
              current.palletBoxCapacity === null
                ? t("office.shiftCard.noPallets")
                : t("office.shiftCard.palletCapacity", {
                    boxes: UNITS.format(current.palletBoxCapacity),
                  }),
          },
          {
            id: "output",
            term: t("office.shifts.table.output"),
            description:
              current.status === "planned"
                ? t("office.common.none")
                : t("office.shifts.output", {
                    units: UNITS.format(current.totals.unitsInClosedBoxes),
                    boxes: UNITS.format(current.totals.closedBoxes),
                  }),
            mono: true,
          },
          {
            id: "openedAt",
            term: t("office.shiftCard.openedAt"),
            description: at(current.openedAt),
          },
          {
            id: "closedAt",
            term: t("office.shiftCard.closedAt"),
            description: at(current.closedAt),
          },
        ]}
      />
      {current.status !== "planned" && <ShiftBoxes shift={current} at={at} />}
      {current.status !== "planned" && current.palletsEnabled && (
        <ShiftPallets shift={current} at={at} />
      )}
      {dialog === "totals" && <ShiftTotalsDialog shift={current} onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDialog shift={current} onClose={() => setDialog(null)} />}
      {canPlan && dialog === "close" && (
        <CloseShiftDialog
          shift={current}
          onClose={() => setDialog(null)}
          onClosed={(closed) => {
            setDialog(null);
            setNotice(t("office.shifts.closed", { number: closed.number }));
            readAgain();
          }}
          onReload={() => {
            setDialog(null);
            readAgain();
          }}
          onOutdated={readAgain}
        />
      )}
    </div>
  );
}

/** The shift's status and its marks, as the list's status cell shows them. */
function ShiftStatusLine({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  return (
    <div className="shift-cell">
      <StatusChip
        phase={STATUS_PHASE[shift.status]}
        label={t(`office.shifts.statuses.${shift.status}`)}
      />
      {shift.lateDataAt !== null && (
        <StatusChip phase="attention" label={t("office.shifts.lateData")} />
      )}
      {shift.closeReasonText !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closedByOffice", { reason: shift.closeReasonText })}
        </span>
      )}
      {shift.closeReasonCode !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closeReason", {
            reason: isShiftCloseReasonCode(shift.closeReasonCode)
              ? t(`office.shifts.closeReasons.${shift.closeReasonCode}`)
              : shift.closeReasonCode,
          })}
        </span>
      )}
    </div>
  );
}

interface SectionProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
}

/** The shift's boxes, opened first first, a page at a time, filtered by the SSCC's last digits. */
function ShiftBoxes({ shift, at }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [tail, setTail] = useState("");
  const [page, setPage] = useState(1);
  const boxes = useOfficeQuery(officeKeys.shiftBoxes(shift.id), (api, token) =>
    api.listShiftBoxes(token, shift.id),
  );
  const pallets = useOfficeQuery(
    officeKeys.shiftPallets(shift.id),
    (api, token) => api.listShiftPallets(token, shift.id),
    { enabled: shift.palletsEnabled },
  );

  const palletLabel = (box: OfficeBox) => {
    if (box.palletId === null) return t("office.common.none");
    const pallet = pallets.data?.find((each) => each.id === box.palletId);
    if (pallet === undefined) return t("office.shiftCard.unknownPallet");
    return pallet.sscc === null ? t("office.shiftCard.openPallet") : ssccText(pallet.sscc);
  };

  const columns: TableColumn<OfficeBox>[] = [
    {
      key: "sscc",
      title: t("office.shiftCard.boxes.sscc"),
      mono: true,
      render: (box) => (box.sscc === null ? t("office.shiftCard.noSscc") : ssccText(box.sscc)),
    },
    {
      key: "units",
      title: t("office.shiftCard.boxes.units"),
      mono: true,
      align: "right",
      render: (box) => UNITS.format(box.units),
    },
    {
      key: "closedAt",
      title: t("office.shiftCard.boxes.closedAt"),
      wrap: true,
      render: (box) => at(box.closedAt),
    },
    ...(shift.palletsEnabled
      ? [
          {
            key: "pallet",
            title: t("office.shiftCard.boxes.pallet"),
            mono: true,
            render: palletLabel,
          },
        ]
      : []),
    {
      key: "state",
      title: t("office.shiftCard.boxes.state"),
      wrap: true,
      render: (box) => <PackStateCell pack={box} kind="box" at={at} />,
    },
    {
      key: "label",
      title: t("office.shiftCard.boxes.label"),
      render: (box) =>
        box.closedAt === null
          ? t("office.common.none")
          : t(`office.shiftCard.label.${labelState(box)}`),
    },
  ];

  const content = () => {
    if (boxes.isPending) return <PageLoading />;
    if (boxes.isError)
      return <LoadError error={boxes.error} onRetry={() => void boxes.refetch()} />;
    const kept = boxes.data.filter((box) => endsWithTail(box.sscc, tail));
    const pageCount = Math.max(1, Math.ceil(kept.length / BOX_PAGE_SIZE));
    const shown = Math.min(page, pageCount);
    return (
      <>
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.boxes.found", { shown: kept.length, total: boxes.data.length })}
        </p>
        <Table
          columns={columns}
          rows={kept.slice((shown - 1) * BOX_PAGE_SIZE, shown * BOX_PAGE_SIZE)}
          getRowKey={(box) => box.id}
          empty={t(
            boxes.data.length === 0
              ? "office.shiftCard.boxes.empty"
              : "office.shiftCard.boxes.none",
          )}
          scrollLabel={t("office.shiftCard.boxes.table")}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.shiftCard.boxes.pager")}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </>
    );
  };

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.boxes.title")}</h2>
      <Card>
        <Input
          label={t("office.shiftCard.boxes.tail")}
          hint={t("office.shiftCard.boxes.tailHint")}
          inputMode="numeric"
          value={tail}
          onChange={(event) => {
            setTail(ssccTail(event.target.value));
            setPage(1);
          }}
        />
        {content()}
      </Card>
    </section>
  );
}

/** The shift's pallets, opened first first, with what stands on each now. */
function ShiftPallets({ shift, at }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const pallets = useOfficeQuery(officeKeys.shiftPallets(shift.id), (api, token) =>
    api.listShiftPallets(token, shift.id),
  );

  const columns: TableColumn<OfficePallet>[] = [
    {
      key: "sscc",
      title: t("office.shiftCard.pallets.sscc"),
      mono: true,
      render: (pallet) =>
        pallet.sscc === null ? t("office.shiftCard.noSscc") : ssccText(pallet.sscc),
    },
    {
      key: "boxes",
      title: t("office.shiftCard.pallets.boxes"),
      mono: true,
      align: "right",
      render: (pallet) => UNITS.format(pallet.boxes),
    },
    {
      key: "units",
      title: t("office.shiftCard.pallets.units"),
      mono: true,
      align: "right",
      render: (pallet) => UNITS.format(pallet.units),
    },
    {
      key: "closedAt",
      title: t("office.shiftCard.pallets.closedAt"),
      wrap: true,
      render: (pallet) => at(pallet.closedAt),
    },
    {
      key: "state",
      title: t("office.shiftCard.pallets.state"),
      wrap: true,
      render: (pallet) => <PackStateCell pack={pallet} kind="pallet" at={at} />,
    },
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.pallets.title")}</h2>
      <Card>
        {pallets.isPending ? (
          <PageLoading />
        ) : pallets.isError ? (
          <LoadError error={pallets.error} onRetry={() => void pallets.refetch()} />
        ) : (
          <Table
            columns={columns}
            rows={pallets.data}
            getRowKey={(pallet) => pallet.id}
            empty={t("office.shiftCard.pallets.empty")}
            scrollLabel={t("office.shiftCard.pallets.table")}
          />
        )}
      </Card>
    </section>
  );
}

/**
 * A box's or a pallet's state, and what the station's close said against
 * what stands there now: a closed box whose digest did not match, a pallet
 * whose count differs from its boxes not taken apart. Shown, never fixed.
 */
function PackStateCell({
  pack,
  kind,
  at,
}: {
  pack: OfficeBox | OfficePallet;
  kind: "box" | "pallet";
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  const state = packState(pack);
  const mismatch =
    state === "closed" &&
    ("digestMatches" in pack
      ? pack.digestMatches === false
      : pack.boxCountReported !== null && pack.boxCountReported !== pack.boxes);
  return (
    <span className="shift-cell">
      <StatusChip phase={PACK_PHASE[state]} label={t(`office.shiftCard.${kind}State.${state}`)} />
      {state === "disassembled" && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.disassembledAt", { at: at(pack.disassembledAt) })}
        </span>
      )}
      {mismatch && (
        <StatusChip phase="attention" wrap label={t(`office.shiftCard.${kind}Mismatch`)} />
      )}
    </span>
  );
}
```

8. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
```

9. В `apps/standalone/src/office/shifts/ShiftsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      key: "number",
      title: t("office.shifts.table.number"),
      mono: true,
      render: (shift) => shift.number,
    },
    {
      key: "productionDate",
```

заменить на

<!-- prettier-ignore -->
```tsx
      key: "number",
      title: t("office.shifts.table.number"),
      mono: true,
      // The number opens the shift's card (plan О-Ф).
      render: (shift) => (
        <Link
          to={`/shifts/${shift.id}`}
          aria-label={t("office.shifts.cardNamed", { number: shift.number })}
        >
          {shift.number}
        </Link>
      ),
    },
    {
      key: "productionDate",
```

10. Создать `apps/standalone/src/office/shifts/shift-card.ts`:

<!-- prettier-ignore -->
```ts
import type { OfficeBox, OfficePallet } from "../../host/protocol.js";

/**
 * What the card of a shift (plan О-Ф) says of its boxes and pallets, from
 * the host's lists (`GET /v1/office/shifts/{id}/boxes`, `…/pallets`).
 */

/** Boxes on one page of the card. */
export const BOX_PAGE_SIZE = 50;

/** A box's or a pallet's state: taken apart wins over closed. */
export type PackState = "open" | "closed" | "disassembled";

export function packState(
  pack: Pick<OfficeBox | OfficePallet, "closedAt" | "disassembledAt">,
): PackState {
  return pack.disassembledAt !== null ? "disassembled" : pack.closedAt !== null ? "closed" : "open";
}

/**
 * The label check the station sent last: a later check overwrites an earlier
 * one on the host, so of a verified and a skipped instant the later counts.
 */
export type LabelState = "verified" | "skipped" | "none";

export function labelState(
  pack: Pick<OfficeBox | OfficePallet, "printVerifiedAt" | "printSkippedAt">,
): LabelState {
  const { printVerifiedAt: verified, printSkippedAt: skipped } = pack;
  if (verified === null && skipped === null) return "none";
  if (skipped === null) return "verified";
  if (verified === null) return "skipped";
  return verified > skipped ? "verified" : "skipped";
}

/** The digits a filter by the SSCC's last digits keeps: anything else typed is dropped. */
export function ssccTail(typed: string): string {
  return typed.replace(/\D/g, "");
}

/**
 * Whether a box's SSCC ends with `tail` (digits only, as `ssccTail` gives
 * them): an empty tail keeps every box, a box without an SSCC only then.
 */
export function endsWithTail(sscc: string | null, tail: string): boolean {
  return tail === "" || (sscc !== null && sscc.endsWith(tail));
}

/** An SSCC as people read it, `(00)` before the 18 digits. */
export function ssccText(sscc: string): string {
  return `(00)${sscc}`;
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-card.test.tsx`

Expected: PASS: `Tests  9 passed (9)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **K1** (SSCC кончается цифрами): в `apps/standalone/src/office/shifts/shift-card.ts` `return tail === "" || (sscc !== null && sscc.endsWith(tail));` → `return tail === "" || (sscc !== null && sscc.includes(tail));`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-card.test.tsx`. Ожидается: FAIL — `filters by the digits an SSCC ends with`.
- **K2** (более поздняя проверка этикетки): в `apps/standalone/src/office/shifts/shift-card.ts` `return verified > skipped ? "verified" : "skipped";` → `return "verified";`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-card.test.tsx`. Ожидается: FAIL — `reads the later label check of the two`.
- **K3** (несошедшийся дайджест закрытия): в `apps/standalone/src/office/shifts/ShiftCardPage.tsx` `? pack.digestMatches === false` → `? false`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-card.test.tsx`. Ожидается: FAIL — `opens from the shift's number and shows the shift, its boxes and its pallets as the host has them now`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/src/office/office-query.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/shifts/ShiftCardPage.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/office/shifts/shift-card.ts apps/standalone/test/shift-card.test.tsx
git commit -m "feat(standalone): the card of a shift — its boxes and pallets as the host has them, its figures, export and close" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Формы в карточке: «Бланк смены», «Состав короба», «Состав паллеты», «Ярлык паллеты», «Ярлыки паллет смены»

Кнопки — там, где их предлагает панель облака (Ф8): «Бланк смены» — у запланированной и активной смены, «Ярлыки паллет смены» — когда в списке есть закрытая нерасформированная паллета с SSCC, «Состав» — у каждого короба и каждой паллеты, «Ярлык» — у закрытой паллеты с SSCC. `PrintFormDialog` читает строки хоста при открытии (`staleTime` 0: короб или паллета могли измениться после чтения карточки), предлагает бумагу A4/A5 для ярлыков (выбор «липкий» в карточке, как `PlacardFormatModal` облака), и каждое нажатие рисует форму заново (у бланка — момент печати в «Сформировано»). Если облако отказало бы (строки прочитаны, а печатать нечего), диалог говорит почему и обе кнопки выключены. «Печать» печатает через контекст печати (`printForm` у `Office`, по умолчанию скрытый кадр задачи 5 — тест передаёт свой), «Открыть в браузере» — путь задачи 5 с «Показать папку»; отказ оболочки назван словами. «Бланк смены» собирается из записей, которые карточка уже читает (товар, линия, контрагент, профиль), — без нового маршрута.

**Files:**

- Create: `apps/standalone/src/office/forms/PrintFormDialog.tsx`, `apps/standalone/src/office/forms/form-printer-context.tsx`, `apps/standalone/test/print-form-dialog.test.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftCardPage.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shift-card.test.tsx` (колонка «Формы»)

**Interfaces:**

- Consumes: `HostApi.getBoxReportRows` (задача 1), `getPalletReportRows` (задача 2); `renderForm`, `formTimeZone`, `TaskFormInputs`, `hasPlacard` (задача 4); `printInFrame`, `formFolder`, `openInBrowser` (задача 5); `useOfficeFiles`.
- Produces: `PrintFormDialog({ shift, target, taskInputs, timeZone, format, onFormat, onClose })`, `type FormTarget`; `form-printer-context.tsx` — `type PrintForm = (html: string) => void`, `FRAME_PRINT_FORM`, `FormPrinterProvider`, `usePrintForm()`; `OfficeProps.printForm?`; `officeKeys.boxReport(id)`, `officeKeys.shiftPalletReport(id)`; тексты `office.forms.*`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/print-form-dialog.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boxReportRowsSchema,
  officeBoxSchema,
  officePalletSchema,
  palletReportRowsSchema,
  type OfficePallet,
  type OfficeShift,
  type PalletReportRows,
} from "../src/host/protocol.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import type { PrintForm } from "../src/office/forms/form-printer-context.js";
import { renderForm } from "../src/office/forms/render-form.js";
import { ORG_PROFILE, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import { ACTIVE, LINE_10, PALLET, PLANNED, shiftsSession, WATER } from "./support/shifts.js";

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const BOXES = officeBoxSchema.array().parse(fixture("office-boxes.json"));
const PALLETS = officePalletSchema.array().parse(fixture("office-pallets.json"));
const BOX_ROWS = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
const PALLET_ROWS = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));
const PALLET_ID = PALLET_ROWS.pallets[0]?.id ?? "";

/** The fixtures' shift: active, with pallets. */
const SHIFT: OfficeShift = {
  ...ACTIVE,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET.id,
};

/** A second pallet, still open and so without an SSCC. */
const OPEN_PALLET: OfficePallet = {
  id: "a0000000-0000-4000-8000-000000000002",
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  sscc: null,
  openedAt: "2026-10-08T07:00:00.000Z",
  closedAt: null,
  disassembledAt: null,
  boxes: 1,
  units: 1,
  boxCountReported: null,
  printVerifiedAt: null,
  printSkippedAt: null,
};

afterEach(() => {
  vi.useRealTimers();
});

/** The office with `shift` listed and every read of its card and forms stubbed. */
function formSession(
  shift: OfficeShift,
  pallets: PalletReportRows = PALLET_ROWS,
): FakeOfficeSession {
  const session = shiftsSession([shift]);
  session.api.getShift.mockResolvedValue(shift);
  session.api.listShiftBoxes.mockResolvedValue(BOXES);
  session.api.listShiftPallets.mockResolvedValue(PALLETS);
  session.api.getBoxReportRows.mockResolvedValue(BOX_ROWS);
  session.api.getPalletReportRows.mockResolvedValue(pallets);
  return session;
}

/** Opens the card of `shift`, printing through `print` and saving through `files`. */
async function openCard(
  session: FakeOfficeSession,
  shift: OfficeShift,
  print: PrintForm,
  files: FakeOfficeFiles,
): Promise<void> {
  renderOffice(session, { printForm: print, files });
  fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
  fireEvent.click(await screen.findByRole("link", { name: `Карточка смены ${shift.number}` }));
  await screen.findByRole("heading", { name: `Смена ${shift.number}` });
}

/** The dialog named `name`, once its form is drawable (its rows are read). */
async function readyDialog(name: string): Promise<HTMLElement> {
  const dialog = screen.getByRole("dialog", { name });
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  return dialog;
}

/** Freezes the clock at 2026-10-08 18:30:00 in Moscow, the organization's zone. */
function freezeClock(): Date {
  const now = new Date("2026-10-08T15:30:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return now;
}

const BOX_FORM = "Состав короба (00)046006820000015000";

/** Closes a dialog by its footer's «Закрыть» (the × of its title is named so too). */
function closeDialog(dialog: HTMLElement): void {
  const [footer] = within(dialog).getAllByRole("button", { name: "Закрыть" }).reverse();
  if (footer === undefined) throw new Error("the dialog has no «Закрыть»");
  fireEvent.click(footer);
}

describe("the printed forms of a shift's card (plan О-Ф)", () => {
  it("prints «Состав короба» of a box from its report rows, exactly as the cloud draws it", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: BOX_FORM }));
    const dialog = await readyDialog(BOX_FORM);
    expect(session.api.getBoxReportRows).toHaveBeenCalledWith("office-session-token", BOX_ROWS.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith(
      renderForm({ kind: "box", rows: BOX_ROWS, timeZone: ORG_PROFILE.timeZone })?.html,
    );
  });

  it("opens a form in the browser: saved as UTF-8 under «Формы» in a folder of its own, then the folder on request", async () => {
    freezeClock();
    const files = fakeOfficeFiles();
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await screen.findByRole("button", { name: BOX_FORM }));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    const folder = ["Формы", "OCT26-004", "2026-10-08_18-30-00_box"];
    const name = "Состав короба 046006820000015000.html";
    await within(dialog).findByText(
      "Форма открыта в браузере. Файл сохранён в папке: C:\\Users\\Оператор\\Documents\\Markiro\\Формы\\OCT26-004\\2026-10-08_18-30-00_box",
    );
    const html = renderForm({ kind: "box", rows: BOX_ROWS, timeZone: ORG_PROFILE.timeZone })?.html;
    expect(files.save).toHaveBeenCalledWith(folder, [
      { name, bytes: new TextEncoder().encode(html) },
    ]);
    expect(files.openFile).toHaveBeenCalledWith(folder, name);
    fireEvent.click(within(dialog).getByRole("button", { name: "Показать папку" }));
    await waitFor(() => expect(files.open).toHaveBeenCalledWith(folder));
  });

  it("says why a form was not opened in the browser, and opens nothing", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no folder"));
    await openCard(formSession(SHIFT), SHIFT, vi.fn<PrintForm>(), files);
    fireEvent.click(await screen.findByRole("button", { name: BOX_FORM }));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(
      "На этом компьютере не найдена папка «Документы». Форма не сохранена.",
    );
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it("offers a pallet's placard only when it is closed with an SSCC, on the paper chosen, and keeps the choice", async () => {
    const session = formSession(SHIFT);
    session.api.listShiftPallets.mockResolvedValue([...PALLETS, OPEN_PALLET]);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    await screen.findByRole("button", { name: "Состав паллеты Без SSCC" });
    expect(screen.queryByRole("button", { name: "Ярлык паллеты Без SSCC" })).toBeNull();
    const placard = "Ярлык паллеты (00)146006820000000409";
    fireEvent.click(screen.getByRole("button", { name: placard }));
    let dialog = await readyDialog(placard);
    fireEvent.click(within(dialog).getByRole("radio", { name: "A5" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenLastCalledWith(
      renderForm({ kind: "placard", rows: PALLET_ROWS, palletId: PALLET_ID, format: "a5" })?.html,
    );
    closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: placard }));
    dialog = await readyDialog(placard);
    expect(within(dialog).getByRole("radio", { name: "A5" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("prints «Состав паллеты» and the shift's placards from the shift's pallet rows", async () => {
    const session = formSession(SHIFT);
    const print = vi.fn<PrintForm>();
    await openCard(session, SHIFT, print, fakeOfficeFiles());
    const contents = "Состав паллеты (00)146006820000000409";
    fireEvent.click(await screen.findByRole("button", { name: contents }));
    let dialog = await readyDialog(contents);
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenLastCalledWith(
      renderForm({
        kind: "pallet",
        rows: PALLET_ROWS,
        palletId: PALLET_ID,
        timeZone: ORG_PROFILE.timeZone,
      })?.html,
    );
    closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Ярлыки паллет смены" }));
    dialog = await readyDialog("Ярлыки паллет смены OCT26-004");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenLastCalledWith(
      renderForm({ kind: "placards", rows: PALLET_ROWS, format: "a4" })?.html,
    );
    expect(session.api.getPalletReportRows).toHaveBeenCalledWith("office-session-token", SHIFT.id);
  });

  it("refuses the shift's placards when the rows read have no pallet to placard", async () => {
    const session = formSession(SHIFT, {
      ...PALLET_ROWS,
      pallets: PALLET_ROWS.pallets.map((pallet) => ({
        ...pallet,
        disassembledAt: "2026-10-08T07:00:00.000Z",
      })),
    });
    await openCard(session, SHIFT, vi.fn<PrintForm>(), fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Ярлыки паллет смены" }));
    const dialog = screen.getByRole("dialog", { name: "Ярлыки паллет смены OCT26-004" });
    await within(dialog).findByText("В смене нет закрытых паллет с SSCC: печатать нечего.");
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("prints «Бланк смены» of a planned shift from the office's records, stamped with the moment of printing", async () => {
    const now = freezeClock();
    const print = vi.fn<PrintForm>();
    await openCard(formSession(PLANNED), PLANNED, print, fakeOfficeFiles());
    fireEvent.click(screen.getByRole("button", { name: "Бланк смены" }));
    const dialog = await readyDialog("Бланк смены OCT26-005");
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenCalledWith(
      renderForm({
        kind: "task",
        inputs: {
          shift: PLANNED,
          product: WATER,
          line: LINE_10,
          counterparty: null,
          organization: ORG_PROFILE,
        },
        generatedAt: now,
      })?.html,
    );
    // A planned shift has no placards to print.
    expect(screen.queryByRole("button", { name: "Ярлыки паллет смены" })).toBeNull();
  });

  it("has no blank for a closed shift", async () => {
    const closed: OfficeShift = { ...SHIFT, status: "closed", closedAt: "2026-10-08T14:00:07Z" };
    await openCard(formSession(closed), closed, vi.fn<PrintForm>(), fakeOfficeFiles());
    await screen.findByRole("button", { name: "Ярлыки паллет смены" });
    expect(screen.queryByRole("button", { name: "Бланк смены" })).toBeNull();
  });

  it("says the window of printing did not open when printing fails", async () => {
    const print = vi.fn<PrintForm>(() => {
      throw new Error("no frame");
    });
    await openCard(formSession(SHIFT), SHIFT, print, fakeOfficeFiles());
    fireEvent.click(await screen.findByRole("button", { name: BOX_FORM }));
    const dialog = await readyDialog(BOX_FORM);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(
      within(dialog).getByText(
        "Окно печати не открылось. Откройте форму в браузере и напечатайте оттуда.",
      ),
    ).toBeTruthy();
  });
});
```

2. В `apps/standalone/test/shift-card.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        "(00)146006820000000409",
        "✓Закрыт",
        "Проверена",
      ],
      [
        "(00)046006820000015002",
```

заменить на

<!-- prettier-ignore -->
```tsx
        "(00)146006820000000409",
        "✓Закрыт",
        "Проверена",
        "Состав",
      ],
      [
        "(00)046006820000015002",
```

3. В `apps/standalone/test/shift-card.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        "(00)146006820000000409",
        "⊘Расформирован08.10.2026, 10:00",
        "Пропущена",
      ],
      ["Без SSCC", "5", "—", "—", "▸Открыт", "—"],
      [
        "(00)046006820000015004",
        "12",
```

заменить на

<!-- prettier-ignore -->
```tsx
        "(00)146006820000000409",
        "⊘Расформирован08.10.2026, 10:00",
        "Пропущена",
        "Состав",
      ],
      ["Без SSCC", "5", "—", "—", "▸Открыт", "—", "Состав"],
      [
        "(00)046006820000015004",
        "12",
```

4. В `apps/standalone/test/shift-card.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        "Открытая",
        "✓Закрыт!Состав при закрытии не сошёлся",
        "Не проверялась",
      ],
    ]);
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(3));
```

заменить на

<!-- prettier-ignore -->
```tsx
        "Открытая",
        "✓Закрыт!Состав при закрытии не сошёлся",
        "Не проверялась",
        "Состав",
      ],
    ]);
    await waitFor(() => expect(within(section("Паллеты")).getAllByRole("row")).toHaveLength(3));
```

5. В `apps/standalone/test/shift-card.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        "12",
        "08.10.2026, 09:20",
        "✓Закрыта!Счёт коробов станции другой",
      ],
      ["Без SSCC", "1", "12", "—", "▸Открыта"],
    ]);
  });

```

заменить на

<!-- prettier-ignore -->
```tsx
        "12",
        "08.10.2026, 09:20",
        "✓Закрыта!Счёт коробов станции другой",
        "СоставЯрлык",
      ],
      ["Без SSCC", "1", "12", "—", "▸Открыта", "Состав"],
    ]);
  });

```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form-dialog.test.tsx test/shift-card.test.tsx`

Expected: FAIL: `Tests  10 failed | 8 passed (18)` — все девять тестов `print-form-dialog` (`Unable to find role="button" and name "Состав короба (00)046006820000015000"` и т. п.: кнопок форм ещё нет; импорт `PrintForm` — только тип) и в `shift-card` строки таблиц без колонки «Формы» (`AssertionError: expected [ …(4) ] to deeply equal [ …(4) ]`).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "pallet": "Паллета",
        "state": "Состояние",
        "label": "Этикетка"
      }
    },
    "exports": {
```

заменить на

<!-- prettier-ignore -->
```json
        "pallet": "Паллета",
        "state": "Состояние",
        "label": "Этикетка"
      },
      "taskForm": "Бланк смены",
      "placards": "Ярлыки паллет смены",
      "forms": "Формы",
      "contents": "Состав",
      "placard": "Ярлык",
      "boxContentsNamed": "Состав короба {{label}}",
      "palletContentsNamed": "Состав паллеты {{label}}",
      "placardNamed": "Ярлык паллеты {{label}}"
    },
    "forms": {
      "titles": {
        "box": "Состав короба {{label}}",
        "pallet": "Состав паллеты {{label}}",
        "placard": "Ярлык паллеты {{label}}",
        "placards": "Ярлыки паллет смены {{number}}",
        "task": "Бланк смены {{number}}"
      },
      "paper": "Формат листа",
      "papers": {
        "a4": "A4",
        "a5": "A5"
      },
      "hint": "«Печать» открывает окно печати этого компьютера. «Открыть в браузере» сохраняет форму в папку «Документы\\Markiro\\Формы» и открывает её в браузере: печатайте оттуда, если окно печати здесь не открылось.",
      "print": "Печать",
      "openInBrowser": "Открыть в браузере",
      "opened": "Форма открыта в браузере. Файл сохранён в папке: {{path}}",
      "showFolder": "Показать папку",
      "printFailed": "Окно печати не открылось. Откройте форму в браузере и напечатайте оттуда.",
      "taskUnavailable": "Не загрузились товар, линия, контрагент или профиль организации: бланк не из чего собрать. Закройте окно и откройте карточку снова.",
      "refused": {
        "box": "Короб не найден.",
        "pallet": "Паллета не найдена.",
        "placard": "Ярлык печатается только у закрытой паллеты с SSCC.",
        "placards": "В смене нет закрытых паллет с SSCC: печатать нечего.",
        "task": "Бланк печатается только у запланированной или активной смены."
      },
      "files": {
        "invalid_request": "Приложение сформировало недопустимое имя файла. Форма не сохранена.",
        "documents_unavailable": "На этом компьютере не найдена папка «Документы». Форма не сохранена.",
        "storage": "Не удалось записать или открыть форму: проверьте место на диске и доступ к папке «Документы».",
        "unsupported": "Открыть форму в браузере можно только в Windows."
      }
    },
    "exports": {
```

2. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { HostStatus } from "../host/protocol.js";
import { OfficeFilesProvider, TAURI_OFFICE_FILES } from "./exports/office-files-context.js";
import type { OfficeFilesApi } from "./exports/office-files.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { HostStatus } from "../host/protocol.js";
import { OfficeFilesProvider, TAURI_OFFICE_FILES } from "./exports/office-files-context.js";
import type { OfficeFilesApi } from "./exports/office-files.js";
import {
  FRAME_PRINT_FORM,
  FormPrinterProvider,
  type PrintForm,
} from "./forms/form-printer-context.js";
import { OfficeLinkProvider } from "./office-link.js";
import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
```

3. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
   */
  files?: OfficeFilesApi;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
```

заменить на

<!-- prettier-ignore -->
```tsx
   */
  files?: OfficeFilesApi;
  /**
   * How the office prints a form (plan О-Ф): a hidden frame of its own
   * window by default; a test passes its own.
   */
  printForm?: PrintForm;
  /**
   * Kiosk mode, for the administrator's «Оконный режим» in the header;
   * `null` (the default) shows no such control.
   */
```

4. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
  files = TAURI_OFFICE_FILES,
  windowMode = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
```

заменить на

<!-- prettier-ignore -->
```tsx
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
  files = TAURI_OFFICE_FILES,
  printForm = FRAME_PRINT_FORM,
  windowMode = null,
}: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
```

5. В `apps/standalone/src/office/Office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <OfficeFilesProvider value={files}>
                <WindowModeProvider value={windowMode}>
                  <RouterProvider router={router} />
                </WindowModeProvider>
              </OfficeFilesProvider>
            </LabelRenderingProvider>
          </ThisDeviceProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <OfficeFilesProvider value={files}>
                <FormPrinterProvider value={printForm}>
                  <WindowModeProvider value={windowMode}>
                    <RouterProvider router={router} />
                  </WindowModeProvider>
                </FormPrinterProvider>
              </OfficeFilesProvider>
            </LabelRenderingProvider>
          </ThisDeviceProvider>
```

6. Создать `apps/standalone/src/office/forms/PrintFormDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import type { PlacardFormat } from "@markiro/domain";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal, RadioGroup } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { OfficeFilesError, type SavedFolder } from "../exports/office-files.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import type { TaskFormInputs } from "./form-data.js";
import { usePrintForm } from "./form-printer-context.js";
import { formFolder, openInBrowser } from "./print-form.js";
import { renderForm, type FormRequest, type RenderedForm } from "./render-form.js";

/** The form a card's button asks for; `label` names its box or pallet in the title. */
export type FormTarget =
  | { kind: "box"; boxId: string; label: string }
  | { kind: "pallet"; palletId: string; label: string }
  | { kind: "placard"; palletId: string; label: string }
  | { kind: "placards" }
  | { kind: "task" };

export interface PrintFormDialogProps {
  shift: OfficeShift;
  target: FormTarget;
  /** What «Бланк смены» is drawn from, `null` while one of its records is not loaded. */
  taskInputs: TaskFormInputs | null;
  /** The zone the forms write times in (`formTimeZone`). */
  timeZone: string;
  /** The placards' paper, kept by the card across openings, as the cloud's choice is. */
  format: PlacardFormat;
  onFormat: (format: PlacardFormat) => void;
  onClose: () => void;
}

type Outcome = { kind: "opened"; saved: SavedFolder } | { kind: "failed"; message: string };

/**
 * One printed form of a shift (plan О-Ф): the dialog reads the host's rows
 * when it opens (`staleTime` 0: a box or a pallet may have changed since the
 * card was read), and each press draws the form again with
 * `@markiro/domain`, exactly as the cloud's route draws it, then prints it
 * in the office's window («Печать») or saves it under
 * `Документы\Markiro\Формы` and opens it in the default browser («Открыть в
 * браузере»). A form the cloud would refuse says why and offers neither.
 */
export function PrintFormDialog({
  shift,
  target,
  taskInputs,
  timeZone,
  format,
  onFormat,
  onClose,
}: PrintFormDialogProps) {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const print = usePrintForm();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const boxId = target.kind === "box" ? target.boxId : "";
  const box = useOfficeQuery(
    officeKeys.boxReport(boxId),
    (api, token) => api.getBoxReportRows(token, boxId),
    { enabled: target.kind === "box" },
  );
  const ofPallets =
    target.kind === "pallet" || target.kind === "placard" || target.kind === "placards";
  const pallets = useOfficeQuery(
    officeKeys.shiftPalletReport(shift.id),
    (api, token) => api.getPalletReportRows(token, shift.id),
    { enabled: ofPallets },
  );
  const read = target.kind === "box" ? box : ofPallets ? pallets : null;

  /** The office's request for the form, from the rows as read; `null` while they are not. */
  const request = (): FormRequest | null => {
    switch (target.kind) {
      case "box":
        return box.data === undefined ? null : { kind: "box", rows: box.data, timeZone };
      case "pallet":
        return pallets.data === undefined
          ? null
          : { kind: "pallet", rows: pallets.data, palletId: target.palletId, timeZone };
      case "placard":
        return pallets.data === undefined
          ? null
          : { kind: "placard", rows: pallets.data, palletId: target.palletId, format };
      case "placards":
        return pallets.data === undefined ? null : { kind: "placards", rows: pallets.data, format };
      case "task":
        return taskInputs === null
          ? null
          : { kind: "task", inputs: taskInputs, generatedAt: new Date() };
    }
  };
  const draw = (): RenderedForm | null => {
    const asked = request();
    return asked === null ? null : renderForm(asked);
  };
  // Drawn once here only to know whether the cloud would refuse it; each press draws again.
  const drawable = draw() !== null;

  const printHere = () => {
    const form = draw();
    if (form === null) return;
    setOutcome(null);
    try {
      print(form.html);
    } catch {
      setOutcome({ kind: "failed", message: t("office.forms.printFailed") });
    }
  };

  async function openOutside(): Promise<void> {
    const form = draw();
    if (form === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const folder = formFolder(shift.number, form.kind, new Date().toISOString(), timeZone);
      setOutcome({ kind: "opened", saved: await openInBrowser(files, form, folder) });
    } catch (error) {
      const code = error instanceof OfficeFilesError ? error.code : "storage";
      setOutcome({ kind: "failed", message: t(`office.forms.files.${code}`) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function showFolder(saved: SavedFolder): Promise<void> {
    try {
      await files.open(saved.segments);
    } catch (error) {
      const code = error instanceof OfficeFilesError ? error.code : "storage";
      setOutcome({ kind: "failed", message: t(`office.forms.files.${code}`) });
    }
  }

  const title =
    target.kind === "box" || target.kind === "pallet" || target.kind === "placard"
      ? t(`office.forms.titles.${target.kind}`, { label: target.label })
      : t(`office.forms.titles.${target.kind}`, { number: shift.number });

  const content = () => {
    if (read !== null && read.isPending) return <PageLoading />;
    if (read !== null && read.isError) {
      return <LoadError error={read.error} onRetry={() => void read.refetch()} />;
    }
    if (target.kind === "task" && taskInputs === null) {
      return <Alert tone="warn">{t("office.forms.taskUnavailable")}</Alert>;
    }
    return (
      <>
        {!drawable && <Alert tone="warn">{t(`office.forms.refused.${target.kind}`)}</Alert>}
        {(target.kind === "placard" || target.kind === "placards") && (
          <RadioGroup
            label={t("office.forms.paper")}
            name="form-paper"
            value={format}
            disabled={busy}
            onValueChange={(value) => onFormat(value === "a5" ? "a5" : "a4")}
            options={[
              { value: "a4", label: t("office.forms.papers.a4") },
              { value: "a5", label: t("office.forms.papers.a5") },
            ]}
          />
        )}
        <p className="office-note">{t("office.forms.hint")}</p>
        {outcome?.kind === "opened" && (
          <Alert
            tone="ok"
            role="status"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void showFolder(outcome.saved)}
              >
                {t("office.forms.showFolder")}
              </Button>
            }
          >
            {t("office.forms.opened", { path: outcome.saved.path })}
          </Alert>
        )}
        {outcome?.kind === "failed" && <Alert tone="error">{outcome.message}</Alert>}
      </>
    );
  };

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button
            variant="secondary"
            disabled={!drawable || busy}
            onClick={() => void openOutside()}
          >
            {t("office.forms.openInBrowser")}
          </Button>
          <Button disabled={!drawable || busy} onClick={printHere}>
            {t("office.forms.print")}
          </Button>
        </>
      }
    >
      {content()}
    </Modal>
  );
}
```

7. Создать `apps/standalone/src/office/forms/form-printer-context.tsx`:

<!-- prettier-ignore -->
```tsx
import { createContext, useContext, type ReactNode } from "react";

import { printInFrame } from "./print-form.js";

/** Prints a form's HTML; the office's own window by default, a test's mock otherwise. */
export type PrintForm = (html: string) => void;

/** The webview's hidden frame (`printInFrame`). */
export const FRAME_PRINT_FORM: PrintForm = (html) => printInFrame(html);

const FormPrinterContext = createContext<PrintForm>(FRAME_PRINT_FORM);

/** Gives the office below another way to print its forms (tests). */
export function FormPrinterProvider({
  value,
  children,
}: {
  value: PrintForm;
  children: ReactNode;
}) {
  return <FormPrinterContext value={value}>{children}</FormPrinterContext>;
}

/** How the office prints a form. */
export function usePrintForm(): PrintForm {
  return useContext(FormPrinterContext);
}
```

8. В `apps/standalone/src/office/office-query.ts` фрагмент

<!-- prettier-ignore -->
```ts
  /** A shift's boxes and pallets for its card (`GET …/{id}/boxes`, `…/pallets`, plan О-Ф). */
  shiftBoxes: (id: string) => ["office", "shift-boxes", id],
  shiftPallets: (id: string) => ["office", "shift-pallets", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

заменить на

<!-- prettier-ignore -->
```ts
  /** A shift's boxes and pallets for its card (`GET …/{id}/boxes`, `…/pallets`, plan О-Ф). */
  shiftBoxes: (id: string) => ["office", "shift-boxes", id],
  shiftPallets: (id: string) => ["office", "shift-pallets", id],
  /** What a box's and a shift's pallets' forms print (`…/report-data`, plan О-Ф). */
  boxReport: (id: string) => ["office", "box-report", id],
  shiftPalletReport: (id: string) => ["office", "shift-pallet-report", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

9. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { isShiftCloseReasonCode, type PlacardFormat } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
```

10. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { OfficeBox, OfficePallet, OfficeShift, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { ExportDialog } from "../exports/ExportDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { OfficeBox, OfficePallet, OfficeShift, ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { ExportDialog } from "../exports/ExportDialog.js";
import { hasPlacard, type TaskFormInputs } from "../forms/form-data.js";
import { PrintFormDialog, type FormTarget } from "../forms/PrintFormDialog.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
```

11. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
 * The card of a shift (plan О-Ф, pilot spec §7), opened from «Смены» by the
 * shift's number: what the shift is, its boxes and its pallets as the host
 * derives them now, and what the office does with it — the figures
 * («Итоги»), the exports («Выгрузка», plan ЧЗ) and the close. Every role
 * reads it; closing stays with `planShifts`. Times are written in the
 * organization's zone, as the forms write them.
 */
export function ShiftCardPage() {
  const { t } = useTranslation();
```

заменить на

<!-- prettier-ignore -->
```tsx
 * The card of a shift (plan О-Ф, pilot spec §7), opened from «Смены» by the
 * shift's number: what the shift is, its boxes and its pallets as the host
 * derives them now, and what the office does with it — the figures
 * («Итоги»), the exports («Выгрузка», plan ЧЗ), the close and the printed
 * forms: «Бланк смены» until the shift closes, «Состав короба» of a box,
 * «Состав паллеты» and «Ярлык паллеты» of a pallet, «Ярлыки паллет смены»
 * (pilot spec §5.5). Every role reads it and prints; closing stays with
 * `planShifts`. Times are written in the organization's zone, as the forms
 * write them.
 */
export function ShiftCardPage() {
  const { t } = useTranslation();
```

12. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const shift = useOfficeQuery(officeKeys.shift(id), (api, token) => api.getShift(token, id));
```

заменить на

<!-- prettier-ignore -->
```tsx
  const canPlan = useCan("planShifts");
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<CardDialog | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [paper, setPaper] = useState<PlacardFormat>("a4");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();
  const shift = useOfficeQuery(officeKeys.shift(id), (api, token) => api.getShift(token, id));
```

13. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    api.listCounterparties(token),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
```

заменить на

<!-- prettier-ignore -->
```tsx
    api.listCounterparties(token),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const palletList = useOfficeQuery(
    officeKeys.shiftPallets(id),
    (api, token) => api.listShiftPallets(token, id),
    { enabled: shift.data !== undefined && shift.data.palletsEnabled },
  );

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
```

14. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  });
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : time.format(new Date(instant));

  return (
    <div className="shift-card">
```

заменить на

<!-- prettier-ignore -->
```tsx
  });
  const at = (instant: string | null) =>
    instant === null ? t("office.common.none") : time.format(new Date(instant));
  const product = products.data?.find((each) => each.id === current.productId);
  const line = lines.data?.find((each) => each.id === current.lineId);
  const counterparty =
    current.counterpartyId === null
      ? null
      : counterparties.data?.find((each) => each.id === current.counterpartyId);
  // «Бланк смены» waits for every record it names, as the cloud reads them in one query.
  const taskInputs: TaskFormInputs | null =
    product === undefined || line === undefined || counterparty === undefined || !org.isSuccess
      ? null
      : { shift: current, product, line, counterparty, organization: org.data };
  // The cloud offers the shift's placards only when a pallet has one to print.
  const placards =
    palletList.data?.some((pallet) => hasPlacard(pallet) && pallet.disassembledAt === null) ===
    true;

  return (
    <div className="shift-card">
```

15. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            {canPlan && current.status === "active" && (
              <Button variant="secondary" onClick={() => setDialog("close")}>
                {t("office.shifts.close")}
              </Button>
            )}
          </RowActions>
```

заменить на

<!-- prettier-ignore -->
```tsx
            {canPlan && current.status === "active" && (
              <Button variant="secondary" onClick={() => setDialog("close")}>
                {t("office.shifts.close")}
              </Button>
            )}
            {current.status !== "closed" && (
              <Button variant="secondary" onClick={() => setForm({ kind: "task" })}>
                {t("office.shiftCard.taskForm")}
              </Button>
            )}
            {current.status !== "planned" && placards && (
              <Button variant="secondary" onClick={() => setForm({ kind: "placards" })}>
                {t("office.shiftCard.placards")}
              </Button>
            )}
          </RowActions>
```

16. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          },
        ]}
      />
      {current.status !== "planned" && <ShiftBoxes shift={current} at={at} />}
      {current.status !== "planned" && current.palletsEnabled && (
        <ShiftPallets shift={current} at={at} />
      )}
      {dialog === "totals" && <ShiftTotalsDialog shift={current} onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDialog shift={current} onClose={() => setDialog(null)} />}
```

заменить на

<!-- prettier-ignore -->
```tsx
          },
        ]}
      />
      {current.status !== "planned" && <ShiftBoxes shift={current} at={at} onForm={setForm} />}
      {current.status !== "planned" && current.palletsEnabled && (
        <ShiftPallets shift={current} at={at} onForm={setForm} />
      )}
      {form !== null && (
        <PrintFormDialog
          shift={current}
          target={form}
          taskInputs={taskInputs}
          timeZone={zone}
          format={paper}
          onFormat={setPaper}
          onClose={() => setForm(null)}
        />
      )}
      {dialog === "totals" && <ShiftTotalsDialog shift={current} onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDialog shift={current} onClose={() => setDialog(null)} />}
```

17. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
}

/** The shift's boxes, opened first first, a page at a time, filtered by the SSCC's last digits. */
function ShiftBoxes({ shift, at }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [tail, setTail] = useState("");
```

заменить на

<!-- prettier-ignore -->
```tsx
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
  /** Opens a form of a box or a pallet. */
  onForm: (target: FormTarget) => void;
}

/** The shift's boxes, opened first first, a page at a time, filtered by the SSCC's last digits. */
function ShiftBoxes({ shift, at, onForm }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [tail, setTail] = useState("");
```

18. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          ? t("office.common.none")
          : t(`office.shiftCard.label.${labelState(box)}`),
    },
  ];

  const content = () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
          ? t("office.common.none")
          : t(`office.shiftCard.label.${labelState(box)}`),
    },
    {
      key: "forms",
      title: t("office.shiftCard.forms"),
      render: (box) => {
        const label = box.sscc === null ? t("office.shiftCard.noSscc") : ssccText(box.sscc);
        return (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.shiftCard.boxContentsNamed", { label })}
            onClick={() => onForm({ kind: "box", boxId: box.id, label })}
          >
            {t("office.shiftCard.contents")}
          </Button>
        );
      },
    },
  ];

  const content = () => {
```

19. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
}

/** The shift's pallets, opened first first, with what stands on each now. */
function ShiftPallets({ shift, at }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const pallets = useOfficeQuery(officeKeys.shiftPallets(shift.id), (api, token) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
}

/** The shift's pallets, opened first first, with what stands on each now. */
function ShiftPallets({ shift, at, onForm }: SectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const pallets = useOfficeQuery(officeKeys.shiftPallets(shift.id), (api, token) =>
```

20. В `apps/standalone/src/office/shifts/ShiftCardPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      title: t("office.shiftCard.pallets.state"),
      wrap: true,
      render: (pallet) => <PackStateCell pack={pallet} kind="pallet" at={at} />,
    },
  ];

```

заменить на

<!-- prettier-ignore -->
```tsx
      title: t("office.shiftCard.pallets.state"),
      wrap: true,
      render: (pallet) => <PackStateCell pack={pallet} kind="pallet" at={at} />,
    },
    {
      key: "forms",
      title: t("office.shiftCard.forms"),
      render: (pallet) => {
        const label = pallet.sscc === null ? t("office.shiftCard.noSscc") : ssccText(pallet.sscc);
        return (
          <RowActions>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.shiftCard.palletContentsNamed", { label })}
              onClick={() => onForm({ kind: "pallet", palletId: pallet.id, label })}
            >
              {t("office.shiftCard.contents")}
            </Button>
            {hasPlacard(pallet) && (
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.shiftCard.placardNamed", { label })}
                onClick={() => onForm({ kind: "placard", palletId: pallet.id, label })}
              >
                {t("office.shiftCard.placard")}
              </Button>
            )}
          </RowActions>
        );
      },
    },
  ];

```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form-dialog.test.tsx test/shift-card.test.tsx`

Expected: PASS: `Tests  18 passed (18)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **D1** (бумага ярлыка): в `apps/standalone/src/office/forms/PrintFormDialog.tsx` `: { kind: "placard", rows: pallets.data, palletId: target.palletId, format };` → `: { kind: "placard", rows: pallets.data, palletId: target.palletId, format: "a4" };`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form-dialog.test.tsx`. Ожидается: FAIL — `offers a pallet's placard only when it is closed with an SSCC, on the paper chosen, and keeps the choice`.
- **D2** («Ярлык» только у закрытой паллеты с SSCC): в `apps/standalone/src/office/shifts/ShiftCardPage.tsx` `{hasPlacard(pallet) && (` → `{true && (`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/print-form-dialog.test.tsx`. Ожидается: FAIL — `offers a pallet's placard only when it is closed with an SSCC, on the paper chosen, and keeps the choice`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/i18n/ru.json apps/standalone/src/office/Office.tsx apps/standalone/src/office/forms/PrintFormDialog.tsx apps/standalone/src/office/forms/form-printer-context.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/office/shifts/ShiftCardPage.tsx apps/standalone/test/print-form-dialog.test.tsx apps/standalone/test/shift-card.test.tsx
git commit -m "feat(standalone): the shift card prints the cloud's forms of a shift, in the office or in the browser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Паллеты в форме планирования: «С паллетами», вместимость, шаблон паллеты

План ПЛ-Х научил хост и Zod офиса полям паллет, но строители запросов и форма остались за О-Ф (§6.2 «Офис»). `ShiftInput` и `ShiftChange` получают `pallets: { boxCapacity, templateId } | null`: создание шлёт `palletsEnabled` и при паллетах — вместимость и шаблон (`shift-create-pallets.json`); правка включает паллеты с обоими полями, меняет одно из них или выключает одним `palletsEnabled: false` (хост сам очищает поля, а прислать их тогда — `validation_failed`). Форма: переключатель «С паллетами» доступен у товара с вместимостью паллеты (Ф9), включённый берёт вместимость товара и шаблон по решению 7 для назначения `pallet` (`suggestPalletTemplate`, общий с коробом `firstFitting`), оба обязательны (`superRefine`, `shiftPalletBoxCapacityRule` 1–10 000), выключенный не проверяет и не шлёт их; другой товар пересчитывает их или выключает паллеты. Отказ хоста на `palletTemplateId` — под шаблоном паллеты с перечитыванием шаблонов. Список смен предупреждает «Не откроется: шаблон паллеты…» (`pallet_template_not_fit` при входе станции).

**Files:**

- Modify: `apps/standalone/src/host/requests.ts`, `apps/standalone/src/lib/box-template-choice.ts`, `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/office/shifts/shift-form.ts`, `apps/standalone/src/office/shifts/shift-list.ts`, `apps/standalone/src/office/shifts/ShiftDialog.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/shift-form.test.ts`, `apps/standalone/test/box-template-choice.test.ts`, `apps/standalone/test/shift-list.test.ts`, `apps/standalone/test/shift-dialog.test.tsx`, `apps/standalone/test/shift-edit.test.tsx`

**Interfaces:**

- Consumes: `shiftCreateSchema`/`shiftUpdateSchema` с полями паллет (ПЛ-Х); `templateFitsSlot`, `templateOptions`; `MAX_PALLET_BOX_CAPACITY`, `requiredCountRule`.
- Produces: `interface ShiftPallets { boxCapacity; templateId }`, `ShiftInput.pallets: ShiftPallets | null`, `ShiftChange.pallets?: ShiftPallets | null`, `shiftUpdate` читает `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId` смены; `suggestPalletTemplate(product, templates, defaults)`, `PalletTemplateProduct`, `PalletTemplateDefaults`; `shiftPalletBoxCapacityRule`; поля формы `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`; `OpenBlocker` + `"pallet_template_unfit"`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/test/box-template-choice.test.ts` фрагмент

<!-- prettier-ignore -->
```ts

import {
  suggestBoxTemplate,
  type BoxTemplateCandidate,
  type BoxTemplateDefaults,
} from "../src/lib/box-template-choice.js";
```

заменить на

<!-- prettier-ignore -->
```ts

import {
  suggestBoxTemplate,
  suggestPalletTemplate,
  type BoxTemplateCandidate,
  type BoxTemplateDefaults,
} from "../src/lib/box-template-choice.js";
```

2. В `apps/standalone/test/box-template-choice.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, null)).toBeNull();
  });
});
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, null)).toBeNull();
  });
});

describe("the pallet template a shift with pallets starts with (plan О-Ф)", () => {
  /** An enabled pallet template for every category. */
  const pallet = (id: string, scope: Partial<BoxTemplateCandidate> = {}): BoxTemplateCandidate => ({
    id,
    purpose: "pallet",
    enabled: true,
    chzProductGroupCodes: null,
    ...scope,
  });
  const templates = [
    pallet(PREFERRED),
    pallet(CATEGORY, { chzProductGroupCodes: [8] }),
    pallet(ORGANIZATION),
    box(OTHER),
  ];
  const defaults = {
    defaultPalletTemplateId: ORGANIZATION,
    categories: [
      { chzProductGroupCode: 8, purpose: "box", templateId: OTHER },
      { chzProductGroupCode: 8, purpose: "pallet", templateId: CATEGORY },
    ],
  };

  it("takes the product's pallet preference, then its category's pallet default, then the organization's", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: PREFERRED };
    expect(suggestPalletTemplate(milk, templates, defaults)).toBe(PREFERRED);
    expect(
      suggestPalletTemplate({ ...milk, defaultPalletTemplateId: null }, templates, defaults),
    ).toBe(CATEGORY);
    expect(
      suggestPalletTemplate(
        { chzProductGroupCode: 13, defaultPalletTemplateId: null },
        templates,
        defaults,
      ),
    ).toBe(ORGANIZATION);
  });

  it("never takes a box template, nor one that is off, and leaves the choice when none fits", () => {
    const water = { chzProductGroupCode: 13, defaultPalletTemplateId: OTHER };
    expect(suggestPalletTemplate(water, templates, defaults)).toBe(ORGANIZATION);
    expect(
      suggestPalletTemplate(
        water,
        [pallet(ORGANIZATION, { enabled: false }), box(OTHER)],
        defaults,
      ),
    ).toBeNull();
    expect(suggestPalletTemplate(water, templates, null)).toBeNull();
  });
});
```

3. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      boxCapacity: shift.boxCapacity,
      plannedQty: 1200,
      counterpartyId: shift.counterpartyId,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(shiftCreate(typed)).toStrictEqual(fixture("shift-create.json"));
    // Loaded on another line, moved back to the fixture's line.
    const elsewhere = { ...shift, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" };
    expect(
```

заменить на

<!-- prettier-ignore -->
```ts
      boxCapacity: shift.boxCapacity,
      plannedQty: 1200,
      counterpartyId: shift.counterpartyId,
      pallets: null,
      productName: "Молоко 3,2% 0,9 л",
    };
    expect(shiftCreate(typed)).toStrictEqual(fixture("shift-create.json"));
    // With pallets: their capacity and template, and nothing else changes (plan О-Ф).
    expect(
      shiftCreate({
        ...typed,
        counterpartyId: null,
        pallets: { boxCapacity: 40, templateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f" },
      }),
    ).toStrictEqual(fixture("shift-create-pallets.json"));
    // Loaded on another line, moved back to the fixture's line.
    const elsewhere = { ...shift, lineId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" };
    expect(
```

4. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      boxCapacity: shift.boxCapacity,
      plannedQty: null,
      counterpartyId: null,
    });
    expect(body).toStrictEqual({
      productId: shift.productId,
```

заменить на

<!-- prettier-ignore -->
```ts
      boxCapacity: shift.boxCapacity,
      plannedQty: null,
      counterpartyId: null,
      pallets: null,
    });
    expect(body).toStrictEqual({
      productId: shift.productId,
```

5. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
      rev: 71,
    };
    const same = {
```

заменить на

<!-- prettier-ignore -->
```ts
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
      palletsEnabled: false,
      palletBoxCapacity: null,
      palletTemplateId: null,
      rev: 71,
    };
    const same = {
```

6. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
        ),
        { expectedRev: 71 },
      ],
    ] as const;
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
```

заменить на

<!-- prettier-ignore -->
```ts
        ),
        { expectedRev: 71 },
      ],
    ] as const;
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
      expect(shiftUpdateSchema.parse(body)).toStrictEqual(body);
    }
  });

  it("turns a shift's pallets on with their capacity and template, changes either alone, and turns them off by the switch alone (plan О-Ф)", () => {
    const template = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
    const other = "0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e";
    const without = officeShiftSchema.parse(fixture("office-shift.json"));
    const withPallets = {
      ...without,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: template,
    };
    const bodies = [
      [
        shiftUpdate(without, { pallets: { boxCapacity: 40, templateId: template } }),
        {
          palletsEnabled: true,
          palletBoxCapacity: 40,
          palletTemplateId: template,
          expectedRev: 71,
        },
      ],
      [shiftUpdate(without, { pallets: null }), { expectedRev: 71 }],
      [shiftUpdate(withPallets, { pallets: null }), { palletsEnabled: false, expectedRev: 71 }],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 40, templateId: template } }),
        { expectedRev: 71 },
      ],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 32, templateId: template } }),
        { palletBoxCapacity: 32, expectedRev: 71 },
      ],
      [
        shiftUpdate(withPallets, { pallets: { boxCapacity: 40, templateId: other } }),
        { palletTemplateId: other, expectedRev: 71 },
      ],
      [shiftUpdate(withPallets, {}), { expectedRev: 71 }],
    ] as const;
    for (const [body, expected] of bodies) {
      expect(body).toStrictEqual(expected);
```

7. В `apps/standalone/test/shift-dialog.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  NO_TOTALS,
  NORTH,
  openShifts,
  pickDate,
  shiftsSession,
  WATER,
```

заменить на

<!-- prettier-ignore -->
```tsx
  NO_TOTALS,
  NORTH,
  openShifts,
  PALLET,
  pickDate,
  shiftsSession,
  WATER,
```

8. В `apps/standalone/test/shift-dialog.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      mode: "aggregation",
      palletsEnabled: false,
    });
  });

  it("refuses an empty product, line, template, capacity and date before sending, and a bad plan", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
      mode: "aggregation",
      palletsEnabled: false,
    });
  });

  it("plans a shift with pallets: their capacity from the product and their template by the rule, both changeable (plan О-Ф)", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    expect(within(dialog()).queryByLabelText("Коробов на паллете")).toBeNull();
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Коробов на паллете")).toBe("40");
    // Milk has no pallet preference and its group no pallet default: the organization's.
    expect(valueOf("Шаблон этикетки паллеты")).toBe(PALLET.id);
    expect(options("Шаблон этикетки паллеты")).toEqual(["Выберите шаблон", "Паллета 100×150"]);
    set("Коробов на паллете", " 32 ");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: MILK.id,
      lineId: LINE_2.id,
      productionDate: "2026-10-09",
      boxTemplateId: MILK_BOX.id,
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: NORTH.id,
      mode: "aggregation",
      palletsEnabled: true,
      palletBoxCapacity: 32,
      palletTemplateId: PALLET.id,
    });
  });

  it("refuses pallets without a capacity or a template before sending, and sends none once they are off", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultPalletTemplateId: null,
    });
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Шаблон этикетки паллеты")).toBe("");
    set("Коробов на паллете", "");
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки паллеты")).toBe("Выберите шаблон этикетки паллеты"),
    );
    expect(messageOf("Коробов на паллете")).toBe("Укажите целое число от 1 до 10 000");
    await waitFor(() => expect(document.activeElement).toBe(field("Коробов на паллете")));
    expect(session.api.createShift).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ palletsEnabled: false }),
    );
    expect(session.api.createShift.mock.calls[0]?.[1]).not.toHaveProperty("palletTemplateId");
  });

  it("offers no pallets for a product without a pallet capacity, and turns them off when such a product is chosen", async () => {
    const session = shiftsSession();
    session.api.listProducts.mockResolvedValue([MILK, { ...WATER, palletBoxCapacity: null }]);
    await openCreate(session);
    set("Товар", MILK.id);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Коробов на паллете")).toBe("40");
    set("Товар", WATER.id);
    const pallets = within(dialog()).getByRole("checkbox", { name: "С паллетами" });
    expect(pallets.getAttribute("aria-checked")).toBe("false");
    expect(pallets).toHaveProperty("disabled", true);
    expect(
      within(dialog()).getByText("У товара не задана вместимость паллеты: смена без паллет"),
    ).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Коробов на паллете")).toBeNull();
  });

  it("puts a pallet template the host refused under its select and reads the templates again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(
      api("validation_failed", { field: "palletTemplateId" }),
    );
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    session.api.listTemplates.mockResolvedValue([BOX_58, MILK_BOX, { ...PALLET, enabled: false }]);
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки паллеты")).toBe(
        "Шаблон паллеты выключен или больше не подходит товару. Выберите другой.",
      ),
    );
    await waitFor(() =>
      expect(options("Шаблон этикетки паллеты")).toEqual([
        "Выберите шаблон",
        "Паллета 100×150 — не подходит",
      ]),
    );
  });

  it("refuses an empty product, line, template, capacity and date before sending, and a bad plan", async () => {
```

9. В `apps/standalone/test/shift-edit.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  OLD_BOX,
  OLD_LINE,
  openShifts,
  pickDate,
  PLANNED,
  shiftRow,
```

заменить на

<!-- prettier-ignore -->
```tsx
  OLD_BOX,
  OLD_LINE,
  openShifts,
  PALLET,
  pickDate,
  PLANNED,
  shiftRow,
```

10. В `apps/standalone/test/shift-edit.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      counterpartyId: NORTH.id,
      expectedRev: 72,
    });
  });

  it("switches «Сохранить» off again when an edit is undone", async () => {
```

заменить на

<!-- prettier-ignore -->
```tsx
      counterpartyId: NORTH.id,
      expectedRev: 72,
    });
  });

  it("turns a planned shift's pallets on with the product's capacity and the rule's template, and off by the switch alone (plan О-Ф)", async () => {
    const session = shiftsSession();
    const withPallets: OfficeShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    session.api.updateShift.mockResolvedValue(withPallets);
    let name = await openEdit(session, PLANNED);
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf(name, "Коробов на паллете")).toBe("40");
    expect(valueOf(name, "Шаблон этикетки паллеты")).toBe(PALLET.id);
    // The list read again after the save has the shift with its pallets.
    session.api.listShifts.mockResolvedValue([withPallets, ACTIVE, CLOSED]);
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
      expectedRev: 72,
    });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    fireEvent.click(
      await screen.findByRole("button", { name: `Изменить смену ${PLANNED.number}` }),
    );
    name = `Смена ${PLANNED.number}`;
    await screen.findByRole("dialog", { name });
    await waitFor(() => expect(valueOf(name, "Коробов на паллете")).toBe("40"));
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    expect(within(dialog(name)).queryByLabelText("Коробов на паллете")).toBeNull();
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
        palletsEnabled: false,
        expectedRev: 72,
      }),
    );
  });

  it("switches «Сохранить» off again when an edit is undone", async () => {
```

11. В `apps/standalone/test/shift-form.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  SHIFT_CONFLICTS,
  SHIFT_FIELDS,
  shiftFields,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import { ACTIVE, PLANNED } from "./support/shifts.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
```

заменить на

<!-- prettier-ignore -->
```ts
  SHIFT_CONFLICTS,
  SHIFT_FIELDS,
  shiftFields,
  shiftFieldsSchema,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
} from "../src/office/shifts/shift-form.js";
import { ACTIVE, PALLET, PLANNED } from "./support/shifts.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
```

12. В `apps/standalone/test/shift-form.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      plannedQty: "1200",
      boxCapacity: "12",
      boxTemplateId: ACTIVE.boxTemplateId,
      counterpartyId: ACTIVE.counterpartyId,
    });
    for (const shift of [ACTIVE, PLANNED]) {
      expect(shiftUpdate(shift, toShiftChange(shiftFields(shift)))).toStrictEqual({
        expectedRev: shift.rev,
      });
```

заменить на

<!-- prettier-ignore -->
```ts
      plannedQty: "1200",
      boxCapacity: "12",
      boxTemplateId: ACTIVE.boxTemplateId,
      palletsEnabled: false,
      palletBoxCapacity: "",
      palletTemplateId: "",
      counterpartyId: ACTIVE.counterpartyId,
    });
    const withPallets = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    expect(shiftFields(withPallets)).toMatchObject({
      palletsEnabled: true,
      palletBoxCapacity: "40",
      palletTemplateId: PALLET.id,
    });
    for (const shift of [ACTIVE, PLANNED, withPallets]) {
      expect(shiftUpdate(shift, toShiftChange(shiftFields(shift)))).toStrictEqual({
        expectedRev: shift.rev,
      });
```

13. В `apps/standalone/test/shift-form.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: null,
    });
    // The change of a planned shift never names its product.
    expect(Object.keys(toShiftChange(shiftFields(PLANNED)))).not.toContain("productId");
  });

  it("calls a shift deleted meanwhile, or opened or closed meanwhile, outdated in words of its own", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: null,
      pallets: null,
    });
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        palletsEnabled: true,
        palletBoxCapacity: " 32 ",
        palletTemplateId: PALLET.id,
      }).pallets,
    ).toEqual({ boxCapacity: 32, templateId: PALLET.id });
    // Pallets turned off send none, whatever their fields still hold.
    expect(
      toShiftInput({
        ...shiftFields(PLANNED),
        palletsEnabled: false,
        palletBoxCapacity: "32",
        palletTemplateId: PALLET.id,
      }).pallets,
    ).toBeNull();
    // The change of a planned shift never names its product.
    expect(Object.keys(toShiftChange(shiftFields(PLANNED)))).not.toContain("productId");
  });

  it("requires the pallets' capacity and template only when the shift has pallets (plan О-Ф)", () => {
    const fields = { ...shiftFields(PLANNED), palletBoxCapacity: "", palletTemplateId: "" };
    expect(shiftFieldsSchema.safeParse(fields).success).toBe(true);
    const refused = shiftFieldsSchema.safeParse({ ...fields, palletsEnabled: true });
    expect(refused.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["palletBoxCapacity", "rules.shiftPalletBoxCapacity"],
      ["palletTemplateId", "office.shifts.errors.palletTemplateRequired"],
    ]);
    for (const capacity of ["0", "10001", "1.5", "сорок"]) {
      expect(
        shiftFieldsSchema.safeParse({
          ...fields,
          palletsEnabled: true,
          palletBoxCapacity: capacity,
          palletTemplateId: PALLET.id,
        }).success,
      ).toBe(false);
    }
    for (const capacity of ["1", " 10000 "]) {
      expect(
        shiftFieldsSchema.safeParse({
          ...fields,
          palletsEnabled: true,
          palletBoxCapacity: capacity,
          palletTemplateId: PALLET.id,
        }).success,
      ).toBe(true);
    }
  });

  it("puts a refused pallet template under its select and a refused pallet capacity under its field", () => {
    expect(sort(api("validation_failed", { field: "palletTemplateId" }))).toEqual({
      failure: {
        kind: "field",
        field: "palletTemplateId",
        message: "office.shifts.errors.palletTemplateRejected",
      },
      outdated: false,
    });
    expect(sort(api("validation_failed", { field: "palletBoxCapacity" }))).toEqual({
      failure: { kind: "field", field: "palletBoxCapacity", message: "rules.rejected" },
      outdated: false,
    });
  });

  it("calls a shift deleted meanwhile, or opened or closed meanwhile, outdated in words of its own", () => {
```

14. В `apps/standalone/test/shift-list.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(openBlocker(unfit, [MILK], templates)).toBeNull();
    expect(openBlocker(unfit, products, undefined)).toBeNull();
    expect(openBlocker(unfit, products, [BOX_58])).toBeNull();
    // A draft is named before the template is looked at.
    expect(openBlocker({ ...unfit, productId: KEFIR_DRAFT.id }, products, undefined)).toBe(
      "product_draft",
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(openBlocker(unfit, [MILK], templates)).toBeNull();
    expect(openBlocker(unfit, products, undefined)).toBeNull();
    expect(openBlocker(unfit, products, [BOX_58])).toBeNull();
    // A pallet template switched off, or not of the pallet purpose, keeps the shift closed too.
    const palletUnfit = { ...PLANNED, palletTemplateId: OLD_BOX.id };
    expect(openBlocker(palletUnfit, products, [...templates, PALLET])).toBe(
      "pallet_template_unfit",
    );
    expect(
      openBlocker({ ...PLANNED, palletTemplateId: PALLET.id }, products, [...templates, PALLET]),
    ).toBeNull();
    // A draft is named before the template is looked at.
    expect(openBlocker({ ...unfit, productId: KEFIR_DRAFT.id }, products, undefined)).toBe(
      "product_draft",
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/shift-form.test.ts test/box-template-choice.test.ts test/shift-list.test.ts test/shift-dialog.test.tsx test/shift-edit.test.tsx`

Expected: FAIL: `Tests  14 failed | 331 passed (345)` — `suggestPalletTemplate is not a function` (2), строители без паллет (`protocol` 2), нет переключателя «С паллетами» (`shift-dialog` 4, `shift-edit` 1), поля формы без паллет (`shift-form` 4), нет `pallet_template_unfit` (`shift-list` 1).

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  };
}

/**
 * A planned shift's fields: ids the form chose, the production date
 * `YYYY-MM-DD`, the counts the form accepted, `null` for no plan or no
 * counterparty.
 */
export interface ShiftInput {
  productId: string;
```

заменить на

<!-- prettier-ignore -->
```ts
  };
}

/** A shift's pallets as the office plans them (plan О-Ф): boxes on a pallet and the label template. */
export interface ShiftPallets {
  boxCapacity: number;
  templateId: string;
}

/**
 * A planned shift's fields: ids the form chose, the production date
 * `YYYY-MM-DD`, the counts the form accepted, `null` for no plan, no
 * counterparty or no pallets.
 */
export interface ShiftInput {
  productId: string;
```

2. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  boxCapacity: number;
  plannedQty: number | null;
  counterpartyId: string | null;
}

/**
 * `POST /v1/office/shifts` (`shift-create.json`): every field, `null` for
 * none, and the mode and pallets stage 2a takes, so the host's defaults never
 * decide what was planned.
 */
export function shiftCreate(shift: ShiftInput): ShiftCreate {
  return {
```

заменить на

<!-- prettier-ignore -->
```ts
  boxCapacity: number;
  plannedQty: number | null;
  counterpartyId: string | null;
  pallets: ShiftPallets | null;
}

/**
 * `POST /v1/office/shifts` (`shift-create.json`, `shift-create-pallets.json`):
 * every field, `null` for none, the mode and whether pallets are collected,
 * so the host's defaults never decide what was planned; a shift with pallets
 * names their capacity and template, one without names neither.
 */
export function shiftCreate(shift: ShiftInput): ShiftCreate {
  return {
```

3. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
    plannedQty: shift.plannedQty,
    counterpartyId: shift.counterpartyId,
    mode: "aggregation",
    palletsEnabled: false,
  };
}

/**
 * What a shift is to become; a field left out stays as it is. `plannedQty`
 * and `counterpartyId` take `null` for none.
 */
export interface ShiftChange {
  lineId?: string;
```

заменить на

<!-- prettier-ignore -->
```ts
    plannedQty: shift.plannedQty,
    counterpartyId: shift.counterpartyId,
    mode: "aggregation",
    ...(shift.pallets === null
      ? { palletsEnabled: false }
      : {
          palletsEnabled: true,
          palletBoxCapacity: shift.pallets.boxCapacity,
          palletTemplateId: shift.pallets.templateId,
        }),
  };
}

/**
 * What a shift is to become; a field left out stays as it is. `plannedQty`,
 * `counterpartyId` and `pallets` take `null` for none.
 */
export interface ShiftChange {
  lineId?: string;
```

4. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  boxCapacity?: number;
  plannedQty?: number | null;
  counterpartyId?: string | null;
}

/**
```

заменить на

<!-- prettier-ignore -->
```ts
  boxCapacity?: number;
  plannedQty?: number | null;
  counterpartyId?: string | null;
  pallets?: ShiftPallets | null;
}

/**
```

5. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
    | "boxCapacity"
    | "plannedQty"
    | "counterpartyId"
    | "rev"
  >,
  next: ShiftChange,
```

заменить на

<!-- prettier-ignore -->
```ts
    | "boxCapacity"
    | "plannedQty"
    | "counterpartyId"
    | "palletsEnabled"
    | "palletBoxCapacity"
    | "palletTemplateId"
    | "rev"
  >,
  next: ShiftChange,
```

6. В `apps/standalone/src/host/requests.ts` фрагмент

<!-- prettier-ignore -->
```ts
  }
  if (next.counterpartyId !== undefined && next.counterpartyId !== shift.counterpartyId) {
    update.counterpartyId = next.counterpartyId;
  }
  return update;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  }
  if (next.counterpartyId !== undefined && next.counterpartyId !== shift.counterpartyId) {
    update.counterpartyId = next.counterpartyId;
  }
  // Pallets turned off are only that: the host clears their capacity and template itself.
  if (next.pallets === null && shift.palletsEnabled) update.palletsEnabled = false;
  if (next.pallets !== undefined && next.pallets !== null) {
    if (!shift.palletsEnabled) update.palletsEnabled = true;
    if (next.pallets.boxCapacity !== shift.palletBoxCapacity) {
      update.palletBoxCapacity = next.pallets.boxCapacity;
    }
    if (next.pallets.templateId !== shift.palletTemplateId) {
      update.palletTemplateId = next.pallets.templateId;
    }
  }
  return update;
}
```

7. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
    "productGroup": "Выберите группу из списка",
    "plannedQty": "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    "shiftBoxCapacity": "Укажите целое число от 1 до 100 000",
    "productionDate": "Укажите дату производства",
    "closeReason": "Опишите причину: от 3 до 500 символов"
  },
```

заменить на

<!-- prettier-ignore -->
```json
    "productGroup": "Выберите группу из списка",
    "plannedQty": "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    "shiftBoxCapacity": "Укажите целое число от 1 до 100 000",
    "shiftPalletBoxCapacity": "Укажите целое число от 1 до 10 000",
    "productionDate": "Укажите дату производства",
    "closeReason": "Опишите причину: от 3 до 500 символов"
  },
```

8. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "blockers": {
        "product_archived": "Не откроется: товар в архиве",
        "product_draft": "Не откроется: товар — черновик",
        "template_unfit": "Не откроется: шаблон выключен или не подходит товару"
      },
      "lateData": "Данные после закрытия",
      "closedByOffice": "Закрыта в офисе: {{reason}}",
```

заменить на

<!-- prettier-ignore -->
```json
      "blockers": {
        "product_archived": "Не откроется: товар в архиве",
        "product_draft": "Не откроется: товар — черновик",
        "template_unfit": "Не откроется: шаблон выключен или не подходит товару",
        "pallet_template_unfit": "Не откроется: шаблон паллеты выключен или не подходит товару"
      },
      "lateData": "Данные после закрытия",
      "closedByOffice": "Закрыта в офисе: {{reason}}",
```

9. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "templateAfterProduct": "Сначала выберите товар",
        "templatesUnavailable": "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
        "defaultsUnavailable": "Умолчания шаблонов не загрузились: шаблон берётся только из товара — проверьте выбор.",
        "counterparty": "Контрагент",
        "noCounterparty": "Не выбран",
        "counterpartyHint": "Необязательно: его название будет на этикетке короба",
```

заменить на

<!-- prettier-ignore -->
```json
        "templateAfterProduct": "Сначала выберите товар",
        "templatesUnavailable": "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
        "defaultsUnavailable": "Умолчания шаблонов не загрузились: шаблон берётся только из товара — проверьте выбор.",
        "pallets": "С паллетами",
        "palletsHint": "Станция собирает короба на паллету и закрывает её по вместимости",
        "palletsUnavailable": "У товара не задана вместимость паллеты: смена без паллет",
        "palletBoxCapacity": "Коробов на паллете",
        "palletBoxCapacityHint": "Берётся из товара; можно изменить",
        "palletTemplate": "Шаблон этикетки паллеты",
        "counterparty": "Контрагент",
        "noCounterparty": "Не выбран",
        "counterpartyHint": "Необязательно: его название будет на этикетке короба",
```

10. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "productInactive": "Товар больше не в работе: он в архиве или стал черновиком",
        "lineRejected": "Линия в архиве. Выберите другую.",
        "templateRejected": "Шаблон выключен или больше не подходит товару. Выберите другой.",
        "counterpartyRejected": "Контрагент в архиве. Выберите другого.",
        "gone": "Этой смены больше нет: её удалили. Список смен обновлён.",
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
```

заменить на

<!-- prettier-ignore -->
```json
        "productInactive": "Товар больше не в работе: он в архиве или стал черновиком",
        "lineRejected": "Линия в архиве. Выберите другую.",
        "templateRejected": "Шаблон выключен или больше не подходит товару. Выберите другой.",
        "palletTemplateRequired": "Выберите шаблон этикетки паллеты",
        "palletTemplateRejected": "Шаблон паллеты выключен или больше не подходит товару. Выберите другой.",
        "counterpartyRejected": "Контрагент в архиве. Выберите другого.",
        "gone": "Этой смены больше нет: её удалили. Список смен обновлён.",
        "nowActive": "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
```

11. В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
export interface BoxTemplateProduct {
  chzProductGroupCode: number | null;
  defaultBoxTemplateId: string | null;
}

/** A template the choice may pick: its id and what decides whether it fits. */
```

заменить на

<!-- prettier-ignore -->
```ts
export interface BoxTemplateProduct {
  chzProductGroupCode: number | null;
  defaultBoxTemplateId: string | null;
}

/** What the pallet choice reads of a product: its group and its pallet template preference. */
export interface PalletTemplateProduct {
  chzProductGroupCode: number | null;
  defaultPalletTemplateId: string | null;
}

/** A template the choice may pick: its id and what decides whether it fits. */
```

12. В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
export interface BoxTemplateDefaults {
  defaultBoxTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/**
```

заменить на

<!-- prettier-ignore -->
```ts
export interface BoxTemplateDefaults {
  defaultBoxTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/** The defaults the pallet choice falls back on: the organization's pallet default and the categories'. */
export interface PalletTemplateDefaults {
  defaultPalletTemplateId: string | null;
  categories: readonly { chzProductGroupCode: number; purpose: string; templateId: string }[];
}

/**
 * The first of `ids` that names a template of `templates` fitting `purpose`
 * and the product's `group` (`templateFitsSlot`), or `null`.
 */
function firstFitting(
  ids: readonly (string | null)[],
  templates: readonly BoxTemplateCandidate[],
  purpose: "box" | "pallet",
  group: number | null,
): string | null {
  for (const id of ids) {
    if (id === null) continue;
    const template = templates.find((each) => each.id === id);
    if (
      template !== undefined &&
      templateFitsSlot(template, { purpose, chzProductGroupCode: group })
    ) {
      return id;
    }
  }
  return null;
}

/** The category's default template of `purpose` for `group`, if the defaults name one. */
function categoryDefault(
  categories: BoxTemplateDefaults["categories"] | undefined,
  purpose: "box" | "pallet",
  group: number | null,
): string | null {
  if (group === null) return null;
  return (
    categories?.find((entry) => entry.purpose === purpose && entry.chzProductGroupCode === group)
      ?.templateId ?? null
  );
}

/**
```

13. В `apps/standalone/src/lib/box-template-choice.ts` фрагмент

<!-- prettier-ignore -->
```ts
  defaults: BoxTemplateDefaults | null,
): string | null {
  const group = product.chzProductGroupCode;
  const categoryDefault =
    group === null
      ? undefined
      : defaults?.categories.find(
          (entry) => entry.purpose === "box" && entry.chzProductGroupCode === group,
        )?.templateId;
  const candidates = [
    product.defaultBoxTemplateId,
    categoryDefault ?? null,
    defaults?.defaultBoxTemplateId ?? null,
  ];
  for (const id of candidates) {
    if (id === null) continue;
    const template = templates.find((each) => each.id === id);
    if (
      template !== undefined &&
      templateFitsSlot(template, { purpose: "box", chzProductGroupCode: group })
    ) {
      return id;
    }
  }
  return null;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  defaults: BoxTemplateDefaults | null,
): string | null {
  const group = product.chzProductGroupCode;
  return firstFitting(
    [
      product.defaultBoxTemplateId,
      categoryDefault(defaults?.categories, "box", group),
      defaults?.defaultBoxTemplateId ?? null,
    ],
    templates,
    "box",
    group,
  );
}

/**
 * The pallet template a shift with pallets starts with (stage 2a spec,
 * decision 7, for the purpose `pallet`; plan О-Ф): the product's pallet
 * preference, then its category's pallet default, then the organization's,
 * the first that fits the product's group. `null` when none does: the person
 * chooses.
 */
export function suggestPalletTemplate(
  product: PalletTemplateProduct,
  templates: readonly BoxTemplateCandidate[],
  defaults: PalletTemplateDefaults | null,
): string | null {
  const group = product.chzProductGroupCode;
  return firstFitting(
    [
      product.defaultPalletTemplateId,
      categoryDefault(defaults?.categories, "pallet", group),
      defaults?.defaultPalletTemplateId ?? null,
    ],
    templates,
    "pallet",
    group,
  );
}
```

14. В `apps/standalone/src/lib/rules.ts` фрагмент

<!-- prettier-ignore -->
```ts
/** A shift's box capacity: 1 to `MAX_BOX_CAPACITY` units, always sent. */
export const shiftBoxCapacityRule = requiredCountRule(MAX_BOX_CAPACITY, "rules.shiftBoxCapacity");

/** A production date: a civil date the host takes (`validate::civil_date`). */
export const productionDateRule = z.string().refine(isCivilDate, "rules.productionDate");

```

заменить на

<!-- prettier-ignore -->
```ts
/** A shift's box capacity: 1 to `MAX_BOX_CAPACITY` units, always sent. */
export const shiftBoxCapacityRule = requiredCountRule(MAX_BOX_CAPACITY, "rules.shiftBoxCapacity");

/** The boxes on a pallet of a shift with pallets: 1 to `MAX_PALLET_BOX_CAPACITY`, always sent. */
export const shiftPalletBoxCapacityRule = requiredCountRule(
  MAX_PALLET_BOX_CAPACITY,
  "rules.shiftPalletBoxCapacity",
);

/** A production date: a civil date the host takes (`validate::civil_date`). */
export const productionDateRule = z.string().refine(isCivilDate, "rules.productionDate");

```

15. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { DatePicker, Input, Select } from "@markiro/ui";

import type { OfficeShift, ShiftCreate, ShiftUpdate } from "../../host/protocol.js";
import { shiftCreate, shiftUpdate } from "../../host/requests.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, DatePicker, Input, Select } from "@markiro/ui";

import type { OfficeShift, ShiftCreate, ShiftUpdate } from "../../host/protocol.js";
import { shiftCreate, shiftUpdate } from "../../host/requests.js";
import { suggestBoxTemplate, suggestPalletTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
```

16. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
}

/**
 * Plans a shift, or changes a planned one (stage 2a spec §5.6). A new shift's
 * production date starts as today in the organization's time zone, so the
 * dialog waits for the organization's profile; when the profile does not
 * load, or names a zone this PC does not know, it starts as this PC's date
```

заменить на

<!-- prettier-ignore -->
```tsx
}

/**
 * Plans a shift, or changes a planned one (stage 2a spec §5.6), with pallets
 * or without (plan О-Ф: their capacity from the product, their template by
 * decision 7 for the purpose `pallet`, both changeable). A new shift's
 * production date starts as today in the organization's time zone, so the
 * dialog waits for the organization's profile; when the profile does not
 * load, or names a zone this PC does not know, it starts as this PC's date
```

17. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  const productId = watch("productId");
  const lineId = watch("lineId");
  const counterpartyId = watch("counterpartyId");
  const product = products.data?.find((each) => each.id === productId);
  // A changed shift of an archived or draft product will not open, whatever is changed.
  const productBlocker = shift === null ? null : openBlocker(shift, products.data, undefined);

```

заменить на

<!-- prettier-ignore -->
```tsx
  const productId = watch("productId");
  const lineId = watch("lineId");
  const counterpartyId = watch("counterpartyId");
  const palletsEnabled = watch("palletsEnabled");
  const product = products.data?.find((each) => each.id === productId);
  // Pallets need the product's pallet capacity, as the cloud's switch does.
  const palletsPossible = product !== undefined && product.palletBoxCapacity !== null;
  // A changed shift of an archived or draft product will not open, whatever is changed.
  const productBlocker = shift === null ? null : openBlocker(shift, products.data, undefined);

```

18. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          },
        ];

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
    onChange(id);
    const chosen = products.data?.find((each) => each.id === id);
```

заменить на

<!-- prettier-ignore -->
```tsx
          },
        ];

  /** The pallets' capacity and template from `chosen`, as a new choice of pallets takes them. */
  const palletsFrom = (chosen: NonNullable<typeof product>) => {
    setValue(
      "palletBoxCapacity",
      chosen.palletBoxCapacity === null ? "" : String(chosen.palletBoxCapacity),
      { shouldDirty: true },
    );
    const suggested = suggestPalletTemplate(chosen, templates.data ?? [], defaults.data ?? null);
    setValue("palletTemplateId", suggested ?? "", { shouldDirty: true });
    clearErrors(["palletBoxCapacity", "palletTemplateId"]);
  };

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
    onChange(id);
    const chosen = products.data?.find((each) => each.id === id);
```

19. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    setValue("boxTemplateId", suggested ?? "", { shouldDirty: true });
    // A refusal of the earlier values does not outlive them.
    clearErrors(["boxCapacity", "boxTemplateId"]);
  };

  const submit = handleSubmit(
```

заменить на

<!-- prettier-ignore -->
```tsx
    setValue("boxTemplateId", suggested ?? "", { shouldDirty: true });
    // A refusal of the earlier values does not outlive them.
    clearErrors(["boxCapacity", "boxTemplateId"]);
    // So do the pallets', when they are on; a product without a pallet capacity turns them off.
    if (palletsEnabled && chosen.palletBoxCapacity === null) {
      setValue("palletsEnabled", false, { shouldDirty: true });
    } else if (palletsEnabled) {
      palletsFrom(chosen);
    }
  };

  const choosePallets = (on: boolean, onChange: (on: boolean) => void) => {
    onChange(on);
    if (on && product !== undefined) palletsFrom(product);
    if (!on) clearErrors(["palletBoxCapacity", "palletTemplateId"]);
  };

  const submit = handleSubmit(
```

20. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          // no longer offered, or shows as marked, once its list is read again.
          if (outcome.field === "productId") void products.refetch();
          if (outcome.field === "lineId") void lines.refetch();
          if (outcome.field === "boxTemplateId") void templates.refetch();
          if (outcome.field === "counterpartyId") void counterparties.refetch();
        } else if (outdated && outcome.kind === "alert") {
          setOutdatedMessage(outcome.message);
```

заменить на

<!-- prettier-ignore -->
```tsx
          // no longer offered, or shows as marked, once its list is read again.
          if (outcome.field === "productId") void products.refetch();
          if (outcome.field === "lineId") void lines.refetch();
          if (outcome.field === "boxTemplateId" || outcome.field === "palletTemplateId") {
            void templates.refetch();
          }
          if (outcome.field === "counterpartyId") void counterparties.refetch();
        } else if (outdated && outcome.kind === "alert") {
          setOutdatedMessage(outcome.message);
```

21. В `apps/standalone/src/office/shifts/ShiftDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      />
      <Controller
        control={control}
        name="counterpartyId"
        render={({ field }) => (
          <Select
```

заменить на

<!-- prettier-ignore -->
```tsx
      />
      <Controller
        control={control}
        name="palletsEnabled"
        render={({ field }) => (
          <Checkbox
            label={t("office.shifts.fields.pallets")}
            hint={t(
              product !== undefined && !palletsPossible
                ? "office.shifts.fields.palletsUnavailable"
                : "office.shifts.fields.palletsHint",
            )}
            checked={field.value}
            onCheckedChange={(on) => choosePallets(on, field.onChange)}
            id={fieldId("palletsEnabled")}
            // A changed shift's own pallets can always be turned off.
            disabled={locked || ((!palletsPossible || !templates.isSuccess) && !field.value)}
          />
        )}
      />
      {palletsEnabled && (
        <>
          <Input
            label={t("office.shifts.fields.palletBoxCapacity")}
            hint={t("office.shifts.fields.palletBoxCapacityHint")}
            inputMode="numeric"
            mono
            id={fieldId("palletBoxCapacity")}
            disabled={locked}
            {...fieldError(errors.palletBoxCapacity?.message)}
            {...register("palletBoxCapacity")}
          />
          <Controller
            control={control}
            name="palletTemplateId"
            render={({ field }) => (
              <Select
                native
                label={t("office.shifts.fields.palletTemplate")}
                placeholder={t("office.shifts.fields.templatePlaceholder")}
                options={templateOptions(
                  templates.data,
                  "pallet",
                  product?.chzProductGroupCode ?? null,
                  [shift?.palletTemplateId ?? "", field.value],
                  t,
                ).filter((option) => option.value !== "")}
                value={field.value}
                onValueChange={field.onChange}
                id={fieldId("palletTemplateId")}
                disabled={locked || !templates.isSuccess}
                {...(templates.isError
                  ? { hint: t("office.shifts.fields.templatesUnavailable") }
                  : {})}
                {...fieldError(errors.palletTemplateId?.message)}
              />
            )}
          />
        </>
      )}
      <Controller
        control={control}
        name="counterpartyId"
        render={({ field }) => (
          <Select
```

22. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
  plannedQtyRule,
  productionDateRule,
  shiftBoxCapacityRule,
  toCount,
} from "../../lib/rules.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";

/**
 * A shift as the form holds it: the ids its selects hold (`""` for none), the
 * production date `YYYY-MM-DD` and the counts as typed.
 */
export const shiftFieldsSchema = z.object({
  productId: z.string().min(1, "office.shifts.errors.productRequired"),
  lineId: z.string().min(1, "office.shifts.errors.lineRequired"),
  productionDate: productionDateRule,
  plannedQty: plannedQtyRule,
  boxCapacity: shiftBoxCapacityRule,
  boxTemplateId: z.string().min(1, "office.shifts.errors.templateRequired"),
  counterpartyId: z.string(),
});
export type ShiftFields = z.input<typeof shiftFieldsSchema>;

/** The fields in the order the form shows them: the first one refused takes the focus. */
```

заменить на

<!-- prettier-ignore -->
```ts
  plannedQtyRule,
  productionDateRule,
  shiftBoxCapacityRule,
  shiftPalletBoxCapacityRule,
  toCount,
} from "../../lib/rules.js";
import { writeFailure, type FieldMessage, type WriteFailure } from "../form-errors.js";

/**
 * A shift as the form holds it: the ids its selects hold (`""` for none), the
 * production date `YYYY-MM-DD` and the counts as typed. With pallets (plan
 * О-Ф) their capacity and template are required; without, whatever the two
 * fields still hold is neither checked nor sent.
 */
export const shiftFieldsSchema = z
  .object({
    productId: z.string().min(1, "office.shifts.errors.productRequired"),
    lineId: z.string().min(1, "office.shifts.errors.lineRequired"),
    productionDate: productionDateRule,
    plannedQty: plannedQtyRule,
    boxCapacity: shiftBoxCapacityRule,
    boxTemplateId: z.string().min(1, "office.shifts.errors.templateRequired"),
    palletsEnabled: z.boolean(),
    palletBoxCapacity: z.string(),
    palletTemplateId: z.string(),
    counterpartyId: z.string(),
  })
  .superRefine((values, context) => {
    if (!values.palletsEnabled) return;
    const capacity = shiftPalletBoxCapacityRule.safeParse(values.palletBoxCapacity);
    if (!capacity.success) {
      context.addIssue({
        code: "custom",
        path: ["palletBoxCapacity"],
        message: "rules.shiftPalletBoxCapacity",
      });
    }
    if (values.palletTemplateId === "") {
      context.addIssue({
        code: "custom",
        path: ["palletTemplateId"],
        message: "office.shifts.errors.palletTemplateRequired",
      });
    }
  });
export type ShiftFields = z.input<typeof shiftFieldsSchema>;

/** The fields in the order the form shows them: the first one refused takes the focus. */
```

23. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "plannedQty",
  "boxCapacity",
  "boxTemplateId",
  "counterpartyId",
] as const satisfies readonly (keyof ShiftFields)[];

```

заменить на

<!-- prettier-ignore -->
```ts
  "plannedQty",
  "boxCapacity",
  "boxTemplateId",
  "palletsEnabled",
  "palletBoxCapacity",
  "palletTemplateId",
  "counterpartyId",
] as const satisfies readonly (keyof ShiftFields)[];

```

24. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
    plannedQty: "",
    boxCapacity: "",
    boxTemplateId: "",
    counterpartyId: "",
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
    plannedQty: "",
    boxCapacity: "",
    boxTemplateId: "",
    palletsEnabled: false,
    palletBoxCapacity: "",
    palletTemplateId: "",
    counterpartyId: "",
  };
}
```

25. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
    plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
    boxCapacity: String(shift.boxCapacity),
    boxTemplateId: shift.boxTemplateId,
    counterpartyId: shift.counterpartyId ?? "",
  };
}

/**
 * The host's fields for values the form accepted: the counts as numbers,
 * `null` for no plan or no counterparty.
 */
export function toShiftInput(values: ShiftFields): ShiftInput {
  return {
```

заменить на

<!-- prettier-ignore -->
```ts
    plannedQty: shift.plannedQty === null ? "" : String(shift.plannedQty),
    boxCapacity: String(shift.boxCapacity),
    boxTemplateId: shift.boxTemplateId,
    palletsEnabled: shift.palletsEnabled,
    palletBoxCapacity: shift.palletBoxCapacity === null ? "" : String(shift.palletBoxCapacity),
    palletTemplateId: shift.palletTemplateId ?? "",
    counterpartyId: shift.counterpartyId ?? "",
  };
}

/**
 * The host's fields for values the form accepted: the counts as numbers,
 * `null` for no plan, no counterparty or no pallets.
 */
export function toShiftInput(values: ShiftFields): ShiftInput {
  return {
```

26. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
    boxCapacity: Number(values.boxCapacity.trim()),
    plannedQty: toCount(values.plannedQty),
    counterpartyId: values.counterpartyId === "" ? null : values.counterpartyId,
  };
}

```

заменить на

<!-- prettier-ignore -->
```ts
    boxCapacity: Number(values.boxCapacity.trim()),
    plannedQty: toCount(values.plannedQty),
    counterpartyId: values.counterpartyId === "" ? null : values.counterpartyId,
    pallets: values.palletsEnabled
      ? {
          boxCapacity: Number(values.palletBoxCapacity.trim()),
          templateId: values.palletTemplateId,
        }
      : null,
  };
}

```

27. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
  lineId: { field: "lineId", message: "office.shifts.errors.lineRejected" },
  boxTemplateId: { field: "boxTemplateId", message: "office.shifts.errors.templateRejected" },
  counterpartyId: { field: "counterpartyId", message: "office.shifts.errors.counterpartyRejected" },
  productionDate: "productionDate",
  plannedQty: "plannedQty",
  boxCapacity: "boxCapacity",
} as const;

/** A draft or archived product (`product_inactive`) goes under the product. */
```

заменить на

<!-- prettier-ignore -->
```ts
  lineId: { field: "lineId", message: "office.shifts.errors.lineRejected" },
  boxTemplateId: { field: "boxTemplateId", message: "office.shifts.errors.templateRejected" },
  counterpartyId: { field: "counterpartyId", message: "office.shifts.errors.counterpartyRejected" },
  palletTemplateId: {
    field: "palletTemplateId",
    message: "office.shifts.errors.palletTemplateRejected",
  },
  productionDate: "productionDate",
  plannedQty: "plannedQty",
  boxCapacity: "boxCapacity",
  palletBoxCapacity: "palletBoxCapacity",
} as const;

/** A draft or archived product (`product_inactive`) goes under the product. */
```

28. В `apps/standalone/src/office/shifts/shift-form.ts` фрагмент

<!-- prettier-ignore -->
```ts
    boxCapacity: input.boxCapacity,
    plannedQty: input.plannedQty,
    counterpartyId: input.counterpartyId,
  };
}

```

заменить на

<!-- prettier-ignore -->
```ts
    boxCapacity: input.boxCapacity,
    plannedQty: input.plannedQty,
    counterpartyId: input.counterpartyId,
    pallets: input.pallets,
  };
}

```

29. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
}

/** Why a planned shift will not open on a station (`shift.open` refuses it). */
export type OpenBlocker = "product_archived" | "product_draft" | "template_unfit";

/**
 * Why a planned shift would be refused when a station opens it, by the lists
 * the office read: its product archived or a draft (`product_inactive`), its
 * box template switched off, narrowed or no longer of the product's group
 * (`template_not_fit`). `null` when it opens, or while a list it needs is not
 * loaded or lacks the record: then nothing is claimed.
 */
export function openBlocker(
  shift: Pick<OfficeShift, "status" | "productId" | "boxTemplateId">,
  products: readonly OfficeProduct[] | undefined,
  templates: readonly LabelTemplateSummary[] | undefined,
): OpenBlocker | null {
```

заменить на

<!-- prettier-ignore -->
```ts
}

/** Why a planned shift will not open on a station (`shift.open` refuses it). */
export type OpenBlocker =
  "product_archived" | "product_draft" | "template_unfit" | "pallet_template_unfit";

/**
 * Why a planned shift would be refused when a station opens it, by the lists
 * the office read: its product archived or a draft (`product_inactive`), its
 * box template switched off, narrowed or no longer of the product's group
 * (`template_not_fit`), its pallet template so too (`pallet_template_not_fit`,
 * plan О-Ф). `null` when it opens, or while a list it needs is not loaded or
 * lacks the record: then nothing is claimed.
 */
export function openBlocker(
  shift: Pick<OfficeShift, "status" | "productId" | "boxTemplateId" | "palletTemplateId">,
  products: readonly OfficeProduct[] | undefined,
  templates: readonly LabelTemplateSummary[] | undefined,
): OpenBlocker | null {
```

30. В `apps/standalone/src/office/shifts/shift-list.ts` фрагмент

<!-- prettier-ignore -->
```ts
    purpose: "box",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  return fits ? null : "template_unfit";
}

/** What the filters of the list hold. */
```

заменить на

<!-- prettier-ignore -->
```ts
    purpose: "box",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  if (!fits) return "template_unfit";
  const pallet = templates?.find((each) => each.id === shift.palletTemplateId);
  if (pallet === undefined) return null;
  const palletFits = templateFitsSlot(pallet, {
    purpose: "pallet",
    chzProductGroupCode: product.chzProductGroupCode,
  });
  return palletFits ? null : "pallet_template_unfit";
}

/** What the filters of the list hold. */
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/shift-form.test.ts test/box-template-choice.test.ts test/shift-list.test.ts test/shift-dialog.test.tsx test/shift-edit.test.tsx`

Expected: PASS: `Tests  345 passed (345)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint` — без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **F1** (выключение паллет только у смены с паллетами): в `apps/standalone/src/host/requests.ts` `if (next.pallets === null && shift.palletsEnabled) update.palletsEnabled = false;` → `if (next.pallets === null) update.palletsEnabled = false;`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`. Ожидается: FAIL — `turns a shift's pallets on with their capacity and template, changes either alone, and turns them off by the switch alone (plan О-Ф)`.
- **F2** (шаблон паллеты обязателен): в `apps/standalone/src/office/shifts/shift-form.ts` `if (values.palletTemplateId === "") {` → `if (values.palletTemplateId === "-") {`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-form.test.ts test/shift-dialog.test.tsx`. Ожидается: FAIL — `refuses pallets without a capacity or a template before sending, and sends none once they are off`, `requires the pallets' capacity and template only when the shift has pallets (plan О-Ф)`.
- **F3** (товар без вместимости паллеты выключает паллеты): в `apps/standalone/src/office/shifts/ShiftDialog.tsx` `if (palletsEnabled && chosen.palletBoxCapacity === null) {` → `if (false) {`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-dialog.test.tsx`. Ожидается: FAIL — `offers no pallets for a product without a pallet capacity, and turns them off when such a product is chosen`.
- **F4** (умолчание категории для назначения `pallet`): в `apps/standalone/src/lib/box-template-choice.ts` `categoryDefault(defaults?.categories, "pallet", group),` → `categoryDefault(defaults?.categories, "box", group),`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/box-template-choice.test.ts`. Ожидается: FAIL — `takes the product's pallet preference, then its category's pallet default, then the organization's`.
- **F5** (предупреждение о шаблоне паллеты в списке): в `apps/standalone/src/office/shifts/shift-list.ts` `return palletFits ? null : "pallet_template_unfit";` → `return null;`
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-list.test.ts`. Ожидается: FAIL — `claims nothing for a shift that is not planned, or whose product or template the lists lack`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/host/requests.ts apps/standalone/src/i18n/ru.json apps/standalone/src/lib/box-template-choice.ts apps/standalone/src/lib/rules.ts apps/standalone/src/office/shifts/ShiftDialog.tsx apps/standalone/src/office/shifts/shift-form.ts apps/standalone/src/office/shifts/shift-list.ts apps/standalone/test/box-template-choice.test.ts apps/standalone/test/protocol.test.ts apps/standalone/test/shift-dialog.test.tsx apps/standalone/test/shift-edit.test.tsx apps/standalone/test/shift-form.test.ts apps/standalone/test/shift-list.test.ts
git commit -m "feat(standalone): the office plans and changes a shift with pallets — capacity from the product, template by decision 7" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Журнал процесса, документы и полная проверка

Маршруты данных форм отвечают кодами и SSCC и не пишут их в журнал процесса; `no_secrets_in_logs.rs` читает «Состав короба» короба с кодом-маркером и данные паллет смены, а прежние проверки журнала (нет канонического кода, хвоста, SSCC) теперь доказывают это и для новых маршрутов. `AGENTS.md` получает раздел «Shift card and printed forms» и правки «Office pages» (ссылка номера, паллеты в планировании), «Logs», «Verification»; спецификация пилота — раздел «21. Уточнения плана О-Ф» (21 — первый номер, не занятый ни одним планом: 19 у ЧЗ, ПЛ-Ц и 2a7, 20 у 2a8; в копии последний раздел файла — 19 ЧЗ). Затем — полная проверка.

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`
- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`

**Interfaces:**

- Consumes: маршруты задач 1–2.
- Produces: документы; тестов не добавляет.

- [ ] **Step 1: Маршруты форм в проходе журнала**

1. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash or a box's SSCC (stage 2a spec §4.11): a rejected record is logged
//! by its id and its receipt code alone; nor do the routes of a shift's
//! exports, which answer with codes and SSCCs (plan ЧЗ). Its own binary,
//! because it installs the global tracing subscriber.

mod support;

```

заменить на

<!-- prettier-ignore -->
```rust
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash or a box's SSCC (stage 2a spec §4.11): a rejected record is logged
//! by its id and its receipt code alone; nor do the routes of a shift's
//! exports (plan ЧЗ) and of its printed forms (plan О-Ф), which answer with
//! codes and SSCCs. Its own binary, because it installs the global tracing
//! subscriber.

mod support;

```

2. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(recorded.status(), 204);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
```

заменить на

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    assert_eq!(recorded.status(), 204);
    // The data of the shift's printed forms carries the codes and the SSCCs
    // too (plan О-Ф): «Состав короба» of the box and the pallets' forms.
    let box_form = office_get(format!("/v1/office/boxes/{box_id}/report-data"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        box_form.contains("crypto-tail-marker-1") && box_form.contains(sscc),
        "{box_form}"
    );
    let pallet_forms = office_get(format!("/v1/office/shifts/{shift_id}/pallet-report-data"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(pallet_forms.contains(pallet_sscc), "{pallet_forms}");

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
```

- [ ] **Step 2: Страж проходит**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test no_secrets_in_logs`

Expected: PASS сразу (вне песочницы): `test result: ok. 1 passed` — это страж: маршруты задач 1–2 уже ничего не пишут в журнал; что страж кусается, показывает мутация L1 ниже.

- [ ] **Step 3: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
  first show) and the shift's devices, named from `listDevices` for an
  administrator (a revoked one marked «(отозвано)») and by the first eight
  characters of the id for a technologist, for an id the list lacks or while
  the list does not load, with a note saying why. The full card of a shift is
  stage 4. A shift carries ids,
  so the page names them from `listProducts`,
  `listLines` and `listCounterparties`, an archived record marked «(в архиве)»,
  and one a list lacks or that did not load by the first eight characters of
```

заменить на

<!-- prettier-ignore -->
```markdown
  first show) and the shift's devices, named from `listDevices` for an
  administrator (a revoked one marked «(отозвано)») and by the first eight
  characters of the id for a technologist, for an id the list lacks or while
  the list does not load, with a note saying why. The number opens the
  shift's card (plan О-Ф, see "Shift card and printed forms"). A shift carries ids,
  so the page names them from `listProducts`,
  `listLines` and `listCounterparties`, an archived record marked «(в архиве)»,
  and one a list lacks or that did not load by the first eight characters of
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
  the organization's, the first that fits; none, and the person chooses); it
  also clears an earlier refusal of those two fields. The template offers what
  fits the product's group and has no «Не выбран»; the line offers active
  lines; the counterparty is optional. When the template defaults do not load,
  a note under the template says it comes from the product alone. While a write is on its way every
  control of the dialog is off. A refused field takes the focus, the first in
  the form's order (`SHIFT_FIELD_ORDER`), the selects and the date included.
```

заменить на

<!-- prettier-ignore -->
```markdown
  the organization's, the first that fits; none, and the person chooses); it
  also clears an earlier refusal of those two fields. The template offers what
  fits the product's group and has no «Не выбран»; the line offers active
  lines; the counterparty is optional. «С паллетами» (plan О-Ф) is offered for
  a product with a pallet capacity: turned on, it takes that capacity and the
  pallet template by the same rule for the purpose `pallet`
  (`suggestPalletTemplate`), both changeable and both required; another
  product chosen takes its own, and one without a pallet capacity turns the
  pallets off. A shift without pallets sends neither field, and a change that
  turns them off sends `palletsEnabled: false` alone (the host clears the
  two). When the template defaults do not load,
  a note under the template says it comes from the product alone. While a write is on its way every
  control of the dialog is off. A refused field takes the focus, the first in
  the form's order (`SHIFT_FIELD_ORDER`), the selects and the date included.
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
  Explorer. No file dialog and no new dependency (pilot question П16).
  `Формы` is the second root, for plan О-Ф.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```markdown
  Explorer. No file dialog and no new dependency (pilot question П16).
  `Формы` is the second root, for plan О-Ф.

## Shift card and printed forms

Plan О-Ф gives the office the card of a shift and the cloud's printed forms
of a shift (pilot spec §5.5): «Бланк смены», «Состав короба», «Состав
паллеты», «Ярлык паллеты» (A4 or A5) and «Ярлыки паллет смены». The forms
are `@markiro/domain`'s `print-forms`, the cloud's own renderers, so what
makes a standalone form the cloud's for the same facts is the data and its
mapping; the bytes are the acceptance rule.

- The card (`src/office/shifts/ShiftCardPage.tsx`, route `shifts/:id`,
  opened by the number in «Смены») reads the shift afresh (`getShift`) and
  shows its fields, its status and marks as the list does, its boxes
  (`GET …/boxes`, fifty a page, filtered by the SSCC's last digits; the state,
  the pallet, the label check the station sent last, a close whose digest did
  not match) and its pallets (`GET …/pallets`; a station's count that differs
  from the boxes standing is marked, never fixed). «Итоги» opens
  `ShiftTotalsDialog`, «Выгрузка» `ExportDialog` (plan ЧЗ) and «Закрыть»
  `CloseShiftDialog` (`planShifts`), all as the list opens them; a close
  reads the card and every list again. Every role prints.
- The host only reads, one snapshot a route, each query by an index
  (`EXPLAIN QUERY PLAN` in `host/tests/office_reports.rs`):
  `GET /v1/office/boxes/{id}/report-data` (`BoxReportRows`) gives a box's
  codes as the cloud's `boxReportData` prints them — the live items, and of a
  box taken apart the items its disassembly took out (`removed_at` equal to
  the box's `disassembled_at`: the host writes both from the fact's one
  instant), through the scans of the box's shift, since no index names a
  box's items that are no longer live — each with its scan's GTIN, serial and
  canonical text, by GTIN and serial byte for byte; `GET
/v1/office/shifts/{id}/pallet-report-data` (`PalletReportRows`) gives the
  shift's number, date and product now and every pallet with every box that
  stood on it (closed first, then by id), a box's units its live items (a box
  taken apart has none; no form prints or counts them). Both name the
  organization. The product is the one now, as the cloud joins it.
- The office maps these rows to the cloud's inputs
  (`src/office/forms/form-data.ts`) and draws with `renderForm`
  (`render-form.ts`): SSCCs with `00`, the state as the cloud derives it, no
  logo (pilot question П15) and no photo; times in the organization's zone
  (`formTimeZone`, this PC's when it is not known). The cloud's refusals stay:
  a placard needs a closed pallet with an SSCC (one taken apart prints with
  the watermark), «Ярлыки паллет смены» print the closed standing pallets
  closed first and need one, «Бланк смены» is for a planned or an active
  shift and takes the shift's one date as both its dates (stage 2a spec,
  question В3).
- Parity: `packages/domain/test/fixtures/print-forms-parity/cases.json` holds
  each case's input as the cloud's loader returns it (`cloud`) and the same
  facts as the host answers them (`host`); `golden.json` the HTML the cloud's
  controllers answer for `cloud`
  (`apps/api/test/standalone-forms-parity.test.ts`, which writes it with
  `FORMS_PARITY_WRITE=1`), and `test/forms-parity.test.ts` draws `host`
  through `renderForm` to the same bytes. The cloud's loaders themselves are
  not run (they are SQL against Postgres): their rules are ported and held by
  the host's tests.
- Printing (`print-form.ts`, `PrintFormDialog.tsx`): each press draws the
  form again from the rows the dialog read when it opened. «Печать» writes the
  HTML into one hidden same-origin frame of the office's window and prints
  that frame (WebView2's print dialog, the paper by the form's `@page`);
  «Открыть в браузере» saves it, UTF-8, into a new folder
  `Документы\Markiro\Формы\<номер смены>\<дата_время>_<форма>` and the shell's
  `open_office_file` opens it in the default browser (`explorer.exe`, a
  `.html` of the office's folder only, so no file the webview names starts as
  a program). Both are offered side by side: a print dialog that did not open
  cannot be seen. The forms load nothing from the network (inline SVG
  barcodes, system Arial).

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

4. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown

## Logs

The routes of a shift's exports answer with codes and SSCCs and log none of
them; `no_secrets_in_logs.rs` reads the export source, both lists and
records an export. The shell's file commands log a failure by its code and
the I/O error's kind, never a path (it names the Windows user).

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
```

заменить на

<!-- prettier-ignore -->
```markdown

## Logs

The routes of a shift's exports and of its forms' data answer with codes and
SSCCs and log none of them; `no_secrets_in_logs.rs` reads the export source,
both lists, a box's and the pallets' form data and records an export. The shell's file commands log a failure by its code and
the I/O error's kind, never a path (it names the Windows user).

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
```

5. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
  a period of 366 days. The «Итоги» window and the «Выпуск» column have run
  only against fixture totals: never against a host's subqueries over real
  facts, nor with the time of the last fact written by WebView2's `Intl`.
```

заменить на

<!-- prettier-ignore -->
```markdown
  a period of 366 days. The «Итоги» window and the «Выпуск» column have run
  only against fixture totals: never against a host's subqueries over real
  facts, nor with the time of the last fact written by WebView2's `Intl`.
- The shift's card and its printed forms (plan О-Ф) have run only under jsdom,
  printing into a mock: never WebView2's print dialog for the hidden frame,
  A4 and A5 paper by `@page` on a real printer, the default browser that
  `explorer.exe` opens for a form's `.html`, Cyrillic and DataMatrix on paper,
  nor a card of thousands of boxes; «Бланк смены»'s DataMatrix scanned by a
  station is plan 2a5's.
```

6. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```markdown
  активной и закрытой смены.
- **Предупреждение о поздних данных** не видит код, который после закрытия смены забрал более
  ранний скан другой смены: вытеснение не отмечает смену поздней, как и в облаке.
```

заменить на

<!-- prettier-ignore -->
```markdown
  активной и закрытой смены.
- **Предупреждение о поздних данных** не видит код, который после закрытия смены забрал более
  ранний скан другой смены: вытеснение не отмечает смену поздней, как и в облаке.

## 21. Уточнения плана О-Ф

План `docs/superpowers/plans/2026-10-10-standalone-o-f-shift-card-forms.md` (карточка смены,
печатные формы смены, паллеты в форме планирования) уточняет разделы 6.2 и 7 так; на вопросы
раздела 14 действуют рекомендованные ответы.

- **Маршруты хоста.** `GET /v1/office/boxes/{id}/report-data` — состав короба по правилу облака:
  живые позиции, а у расформированного короба — снятые его расформированием (`removed_at` равен
  `disassembled_at`); `GET /v1/office/shifts/{id}/pallet-report-data` вместо
  `…/pallets/{id}/report-data` — все паллеты смены одним снимком со всеми коробами, стоявшими на
  них, номером и датой смены и товаром: из него рисуются «Состав паллеты», «Ярлык паллеты» и
  «Ярлыки паллет смены», и ярлыки всей смены согласованы между собой. Маршрут `task-form-data` не
  нужен. Версия протокола не меняется: маршруты новые, полей у прежних нет.
- **Паритет.** Формы рисует `@markiro/domain`, тот же код, что в облаке; эталон HTML пишет
  облачный тест через собственные контроллеры облака из входа, который вернул бы загрузчик
  облака, тест автонома рисует те же байты из ответа хоста. Загрузчики облака (SQL) не
  запускаются: их правила перенесены и закреплены тестами хоста.
- **Печать.** «Печать» — скрытый кадр окна офиса и окно печати WebView2; «Открыть в браузере» —
  файл в `Документы\Markiro\Формы\<номер смены>\<дата_время>_<форма>` и браузер по умолчанию
  (новая команда оболочки `open_office_file`, только `.html` из папки офиса). Обе кнопки рядом:
  неоткрывшееся окно печати не видно программе.
- **Часовой пояс форм** — пояс организации (облако берёт пояс браузера), при неизвестном поясе —
  пояс этого ПК.
- **«Бланк смены»** — только у запланированной и активной смены, как в облаке; единственная дата
  смены автонома идёт и в «дату смены», и в «дату производства» (вопрос В3 спецификации 2a).
- **Паллеты в форме планирования.** «С паллетами» — у товара с вместимостью паллеты: вместимость
  из товара, шаблон паллеты по решению 7 для назначения `pallet`, оба можно изменить. Список смен
  предупреждает о шаблоне паллеты, с которым смена не откроется (`pallet_template_not_fit`).
- **Карточка смены** не показывает исключения и отклонённые записи станции (раздел 9.3): нужны
  маршруты по `box_exceptions`, `pallet_exceptions` и `fact_receipts`, это перенесено в
  отдельный план; отметка поздних данных в карточке есть.
```

- [ ] **Step 4: Полная проверка**

Run (вне песочницы; перед ним `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`): `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked --workspace`

Expected: PASS: 53 набора по строкам `Running`, 789 тестов (хост 37 и 468, `proto` 2 и 55, оболочка 14 и 266), ни одного `FAILED`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`

Expected: `Test Files  91 passed (91)`, `Tests  2581 passed (2581)`; отказ на пределе 5 с в тяжёлых UI-наборах («Заметки») повторить отдельным запуском файла — зелёный.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `… run lint`, `… run build` — без ошибок (у `build` — только предупреждение о размере чанка).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts test/standalone-export-parity.test.ts` — `Tests  2 passed (2)`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck` — без ошибок; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec eslint test/standalone-forms-parity.test.ts` — без ошибок.

Run: `printf 'packages/domain/test/fixtures/print-forms-parity/golden.json\n' | node tools/ci/affected.mjs`

Expected: в ответе `"verify_api_tests":true`, `"verify_app_tests":true` — изменение случаев запускает оба теста паритета.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, `git diff --check`, `node_modules/.bin/prettier --check` на все файлы плана — чисто.

Если локальный граф есть: `graphify update .`.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок» (копия, хеш, правка, команда, возврат, `cmp`, тот же хеш).

- **L1** (данные формы в журнале процесса): в `apps/standalone/host/src/routes/office_reports.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let rows = read_box(&mut tx, &id).await;
```

заменить на

<!-- prettier-ignore -->
```rust
    let rows = read_box(&mut tx, &id).await;
    tracing::info!("box report {rows:?}");
```

Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test no_secrets_in_logs`. Ожидается: FAIL — `secrets_never_reach_the_process_log`.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `node_modules/.bin/prettier --check` на изменённые JSON, TS, TSX, CSS и MD — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/AGENTS.md apps/standalone/host/tests/no_secrets_in_logs.rs docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -m "docs(standalone): the shift card and printed forms in AGENTS and the pilot spec, the forms' routes in the log walk" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- **Покрытие спецификации.** §5.5 (пять форм, их условия и данные) — задачи 1–4 (данные и рисование), 7 (кнопки и отказы); §5.1 (HTML и печать браузером через `@page`) — задача 5; §5.7 Д2/Д3/Д5/Д6 — задачи 1, 2, 4; §6.2 «Офис» (паллеты, вместимость, шаблон паллеты по решению 7) — задача 8; §7 «Новые маршруты хоста» — задачи 1–2 (`task-form-data` не нужен, `…/pallets/{id}/report-data` заменён маршрутом смены — Ф1), «Печать форм» — задачи 5, 7 (основной путь — кадр, запасной — браузер, оба рядом — Ф4), «Карточка смены» — задачи 6–7 (исключения и отклонённые записи — Ф7, перенесено); §9.3 (поздние данные в карточке) — задача 6; §14 П15 — «Допущения»; §15 — «Не проверено» ниже.
- **Байты.** Офис рисует десять случаев эталона байт в байт (задача 4); облачный тест сверяет контроллеры облака с тем же эталоном и падает при изменении контроллера или генератора форм (мутанты C1–C2). Вход форм держат модульные тесты и мутанты M1–M6, данные хоста — тесты хоста и мутанты B1–B4, P1–P3.
- **Мутанты.** Каждое правило отбора, порядка, отказа и границы держит хотя бы один тест; выживших нет.
- **Производительность.** Каждый запрос маршрутов форм ищет по индексу (`EXPLAIN QUERY PLAN` без `SCAN` у пяти запросов); «Состав короба» читает сканы одной смены (`scans_shift`), а не позиции хоста за год. Карточка показывает короба страницами по 50; ответ `GET …/boxes` для смены в тысячи коробов не измерен (см. ниже).
- **Типы и имена между задачами** сверены: `BoxReportRows` (1), `PalletReportRows` (2) → `renderForm` (4) → `PrintFormDialog` (7); `RenderedForm`/`FormKind` (4) → `openInBrowser`/`formFolder` (5) → диалог (7); `OfficeFilesApi.openFile` (5) → диалог (7); `ShiftPallets` (8) → `shiftCreate`/`shiftUpdate`/форма (8).
- **Проверки на копии.** Каждая задача: тесты до реализации падают ровно так, как написано, после — проходят; `typecheck` и `lint` вебвью — без ошибок на коммите каждой задачи; `cargo fmt --check`, `prettier --check`, `git diff --check` — чисто. Полный прогон после задачи 9: cargo `--workspace` — 53 набора, 789 тестов, всё зелёное (вне песочницы); Vitest — 91 файл, 2581 тест, из них 2579 зелёных и 2 отказа под нагрузкой (средняя 132): `test/template-editor.test.tsx` на пределе 5 с (файл плана не касается) и один тест `shift-dialog` с фокусом, который после этого ждёт фокус через `waitFor` (так он и записан в задаче 8; отдельный запуск файла — зелёный); `apps/api`: `typecheck`, `lint` нового файла и тест паритета форм — зелёные.

## Перенесено

- **Исключения и отклонённые записи станции в карточке** (Ф7, §7, §9.3) — отдельный план: маршруты по `box_exceptions`, `pallet_exceptions` (с причинами словами) и `fact_receipts` (`rejected`, `conflict` с кодом квитанции, без КМ целиком), разделы карточки.
- **Логотип клиента на формах** (П15) — поле организации, перенос из облака (ИМП), `ReportOrg.logo`.
- **Загрузчики облака под тестом паритета.** Облачный тест прогоняет контроллеры и генераторы облака, а не SQL загрузчиков: правка `boxReportData`, `palletReportData`, `palletPlacardData`, `shiftPlacardsData` или `taskFormData` в облаке эталон не сломает. Закрепить их можно тестом с Postgres (`DATABASE_URL`) по тем же фактам — после пилота, вместе с выносом правил в `packages/domain` (§16).
- **Порядок «Состава короба» и сопоставление базы облака** (Ф6) — если `lc_collate` облака не `C`, порядок строк кодов со смешанным регистром серий разойдётся с облаком.
- **Размер списка коробов.** `GET …/boxes` отдаёт все короба смены разом (план ЧЗ); для 2000 коробов это сотни КБ через IPC — не измерено; страничный маршрут — если упрётся.
- **Печать нескольких форм подряд** (например, «Состав короба» всех коробов смены одним документом) — у облака такой формы нет; не делалась.

## Что должен предоставить владелец

1. **Проверку печати на Windows**: окно печати WebView2 для каждой формы на A4-принтере клиента, «Ярлык паллеты» и «Ярлыки паллет смены» на A5, путь «Открыть в браузере» (браузер по умолчанию, кириллица в пути и имени файла, перенаправленная OneDrive папка «Документы») — §15.
2. **Сравнение с облаком на бумаге**: одна и та же смена клиента, напечатанная из облака и из автонома (после пробного импорта), — формы должны совпасть; DataMatrix и Code 128 читаются сканером.
3. **`SHOW lc_collate` на базе облака** (Ф6).
4. **Решение по Ф7** (исключения и отклонения в карточке — нужен ли отдельный план до переключения) и **по Ф3** (даты бланка).

## Не проверено (без Windows, железа и данных клиента)

- Окно печати WebView2 для скрытого кадра, бумага A4/A5 по `@page`, поля и масштаб принтера клиента; `explorer.exe` на `.html` и браузер по умолчанию; `cfg(windows)`-ветка `open_in_default_program` компилируется только в `standalone-windows-build`.
- Шрифты форм на Windows (системный Arial с кириллицей; моноширинный — системный), DataMatrix и Code 128 на реальном принтере.
- Карточка и диалог форм — только jsdom с подставной печатью; WebView2 и окно киоска их не показывали.
- Облачные загрузчики не запускались (SQL); облачные тесты, кроме паритета форм и выгрузок, не запускались.
- Смена клиента в тысячи коробов: время ответа `GET …/boxes` и `…/pallet-report-data`, страницы карточки.

## Отклонения при исполнении
