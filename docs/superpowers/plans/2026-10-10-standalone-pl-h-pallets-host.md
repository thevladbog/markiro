# План ПЛ-Х: хост — паллеты-лайт (паллеты в смене, снимок шаблона паллеты, блоки SSCC паллет, факты `pallet_closed`, `pallet_label`, `pallet_exception`, паллета закрытого короба, итоги с паллетами, протокол 3) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автономного продукта ведёт смены с паллетами так же, как облачная станция: офис и станция планируют смену с паллетами (вместимость и шаблон паллеты), снимок замораживает шаблон паллеты, станция получает блоки SSCC паллет (расширение 1), а факты станции — короб, закрытый на паллету, закрытие паллеты номером её блока, проверка этикетки паллеты, перепечатка и расформирование — принимаются с квитанцией на каждую запись, с теми же гарантиями «один номер — одна этикетка», что у коробов; офис видит паллеты в итогах смены. Цех (ПЛ-Ц), отчёты (О-Х), формы (О-Ф) и выгрузки (ЧЗ) — следующие планы; этот план готовит им данные, протокол и фикстуры.

**Architecture:**

- `host/migrations/0012_pallets.sql` — `pallets`, `pallet_exceptions`, столбец `boxes.pallet_id`, два триггера связи полей паллет смены, индекс шаблона паллеты запланированных смен.
- `host/src/shifts.rs` — правило полей паллет (`pallet_request`, `pallets`, `check_pallet_template`), вместимость паллеты товара, снимок с шаблоном паллеты (`pallet_template_not_fit`); `routes/office_shifts.rs`, `routes/device_shifts.rs`, `routes/templates.rs` — план, правка, создание на станции, вход, удаление шаблона; `routes/sscc_blocks.rs` — блоки расширения 1 размером `site.pallet_block_size`.
- `host/src/facts/` — `rules::names_serial` с расширением (общая фикстура `sscc-serials.json` с доменным `buildSscc`), `blocks.rs` (блок этого устройства и `consumed_through`, общие для коробов и паллет), `pallets.rs` (своя паллета, открытие), `pallet_closed.rs`, `pallet_label.rs`, `pallet_exception.rs`; `box_closed.rs` — `palletId`.
- `proto` — `PROTOCOL_VERSION = 3`, поля паллет смены, `ShiftSnapshot.pallet_template`, `FactKind::{PalletClosed, PalletLabel, PalletException}`, `PalletClosedFact`, `PalletLabelFact`, `PalletExceptionFact`, `BoxClosedFact.pallet_id`, четыре кода квитанций, `ShiftTotals.{closed_pallets, open_pallets}` и фикстуры; вебвью — зеркало версии протокола и Zod офиса (`officeShiftSchema`, `shiftCreateSchema`, `shiftUpdateSchema`).

**Tech Stack:** Rust — axum 0.8.9, sqlx 0.8.6 (встроенная SQLite: частичные уникальные индексы, триггеры `RAISE(ABORT)`, `ON CONFLICT … DO UPDATE`), tokio, serde, serde_json, uuid; TypeScript — Vitest 4, zod 4.

**База:** ветка `claude/autonomous-desktop-station-9e6f13` после влития планов 2a2 и 2a3. Планы 2a2 и 2a3 на момент написания не влиты, поэтому каждый фрагмент плана применён к копии, собранной так (точно в этом порядке):

1. голова ветки `claude/2a2-facts` — `407a3cae4` (задачи 1–4 плана 2a2 с правками ревью, в том числе уникальный индекс `boxes_block_serial` в `0010`);
2. задачи 5–8 плана 2a2 по тексту плана: коммиты повтора плана `42a2c015d`, `377fc4c54`, `7ab34c014`, `c875f9ded` (рабочее дерево `/tmp/claude/p2a6-scratch`), перенесённые поверх `407a3cae4` (`cherry-pick`); конфликты — только дописанные в конец тесты `host/tests/facts.rs` и абзацы `AGENTS.md`, решены сохранением обеих сторон;
3. слияние `claude/2a3-office` на `105ad8bca` (план 2a3 исполнен); конфликт `AGENTS.md` и двух разделов «16» спецификации 2a решён сохранением обеих сторон, раздел плана 2a3 переименован в «17»;
4. `totals` в `officeShiftSchema` и в `ACTIVE` из `test/support/shifts.ts` (без этого 2a3 после 2a2 не проходит typecheck; то же сделано в `/tmp/claude/p2a6-scratch`, коммит `b18952943`);
5. абзац «SSCC blocks» `AGENTS.md` после слияния: фраза 2a3 про «Номера закончились» дописана в конец абзаца 2a2, обрывок удалён.

К концу написания плана ветка `claude/2a2-facts` дошла до `1a2105a11` (исполнены задачи 5–6 плана 2a2, с правкой ревью в `facts/exception.rs`). Файлы, которые трогает ПЛ-Х (`facts/{mod,box_closed,boxes}.rs`, `tests/support/app.rs`, `0010_facts.sql`), совпадают там с копией. Если влитые 2a2 и 2a3 всё же разойдутся с ней (задачи 7–8 плана 2a2 ещё впереди), сверять фрагменты нужно по смыслу. Затронуты только итоги смены в `host/tests/facts.rs` и `host/tests/office_shifts.rs` (задача 6) и проход журнала в `host/tests/no_secrets_in_logs.rs` (задача 7). Отклонение записывается в «Отклонения при исполнении».

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (спецификация пилота): §4.1 строка 9, §6.1, §6.2 «Хост (план ПЛ-Х)», §9.1 (запас паллет без хоста), §12.2 (строка ПЛ-Х), §14 (вопросы П1–П17).
- `.superpowers/sdd/cloud-pallet-flow-notes.md` — как это сделано в облаке: паллета копится сама и закрывается при `boxCount + 1 >= palletBoxCapacity` или досрочно кнопкой, перепечатка и расформирование, число коробов выводится, SSCC с расширением 1, серии паллет с 0, блок 200, на станции нет «скана короба в паллету».
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (этап 2a): решения 6, 9, 11–13, 36; §4.1–4.5, §4.7–4.11; §15–17.
- Планы, на которых стоит этот: 2a1 (смены, снимок, блоки), 2a2 (`docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md`: факты, квитанции, реестр, `box_closed`), 2a3 (офис); 2a6 (`…-2a6-floor-scanning.md`: точка расширения `CloseStep` закрытия короба, к которой ПЛ-Ц присоединит паллету).
- Ревью, уроки которых план закрепляет мутациями: `.superpowers/sdd/2a1-final-review-report.md` (пробуждение потоков, точность журнала), `2a2-task-2-review.md` (квитанция `rejected` навсегда; новый вид или поле факта поднимают протокол), `2a2-task-4-review.md` (один номер — одна этикетка при любой контрольной цифре), `2a2-minors.md`.
- `apps/standalone/AGENTS.md` — обязательные правила («Writes», «Protocol», «Shifts», «Facts», «Logs», «Verification»).

## Допущения по вопросам владельцу

Владелец подтвердил: клиент работает с коробами **и** паллетами, хост стоит на ПК станции, контрактный выпуск SSCC — позже. На остальные вопросы раздела 14 спецификации пилота он не ответил; план принимает рекомендованные ответы:

- **П1 — хост на станции (вариант Б), подтверждено.** Хоста это не меняет: протокол один для одного и двух ПК.
- **П2 — паллеты как у облачной станции (вариант А).** Паллета копится сама, закрывается при заполнении или досрочно, есть перепечатка и расформирование, смена закрывается с открытой паллетой. Хосту нужны все три вида фактов. При варианте Б (урезать, раздел 13 п. 6) отпала бы ветка `disassemble` в задаче 5.
- **П4 — SSCC только под префиксом организации (вариант «нет»), подтверждено («контрактное производство позже»).** Блоки паллет — по счётчику `(префикс GLN, 1)`, как у коробов (2a, решение 33).
- **П7 — исторические коды: нет.** Проверка кода и приём `scan` план не меняет. Если владелец скажет «да», план ИМП добавит `legacy_code_owners`, а проверка кода — свою задачу.
- **П10 — рекомендации 2a (В1–В14) приняты**, как в планах 2a1–2a2.
- **Причины исключений паллеты** — те же коды, что у коробов (`exception_reasons::REPRINT`, `::DISASSEMBLE`). Облачная станция шлёт переведённый текст, а для выгрузок и i18n нужны коды (2a, решение 36). Свой список паллет — правка двух констант и фикстуры `exception-reasons.json`.
- **`MIN_PROTOCOL_VERSION` остаётся 1.** Хост 3 принимает станции этапов 1 и 2a (спецификация пилота: «хост понимает 2 и 3», правило родительской спецификации сохраняется).
- **Номер миграции — `0012`.** План 2a2 занимает `0010`, план РК — `0011`. Если к исполнению `0012` занят, миграция получает следующий свободный номер: тесты номер не называют, а `sqlx` применяет пропущенные номера по порядку.

## Global Constraints

**Решения спецификации пилота, обязательные для ПЛ-Х** (§6.2 «Хост», с уточнениями задачи 7)

1. Смена с паллетами: `palletsEnabled = true`, `palletBoxCapacity` 1–10 000 (`validate::MAX_PALLET_BOX_CAPACITY`, по умолчанию из товара), `palletTemplateId` — шаблон назначения `pallet`, который подходит товару (`templates::fits`); без шаблона — `validation_failed` (как 422 облака). Режим — только `aggregation`.
2. Снимок при открытии получает шаблон паллеты `{ id, name, rev, spec }`; вместимость паллеты — поле смены (как вместимость короба).
3. Блоки SSCC выдаются и с `extension = 1`, размером `site.pallet_block_size` (200 по умолчанию), по тем же правилам, что блоки коробов 2a1.
4. `box_closed` получает необязательный `palletId`; новые виды фактов — `pallet_closed { palletId, sscc, blockId, serial, openedAt, closedAt, boxCount }`, `pallet_label { palletId, outcome, at }`, `pallet_exception { exception, palletId, reasonCode, reasonText, occurredAt }`.
5. SSCC паллеты проверяется как SSCC короба (2a, решение 13, и ревью задачи 4 плана 2a2): 18 цифр; первые 17 — расширение `1`, префикс снимка и серия, контрольная цифра не проверяется; серия лежит в неотозванном блоке расширения 1 этого устройства; один номер блока — одна паллета при любой контрольной цифре; `consumed_through` только растёт.
6. Новые таблицы `pallets`, `pallet_exceptions`, столбец `boxes.pallet_id`; итоги смены — `closedPallets`, `openPallets`.
7. `PROTOCOL_VERSION = 3`, хост понимает и прежние версии (2 и 1). Новый вид факта и новое поле `data` поднимают версию: старый хост отвергает такую запись навсегда (ревью задачи 2 плана 2a2, Minor 3).

**Модель данных** (миграция `0012_pallets.sql`)

- `pallets(id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, box_count_reported, operator_id, print_verified_at, print_skipped_at, disassembled_at, received_at)`: закрытая паллета целиком (SSCC, блок, серия, число коробов), SSCC паллеты начинается с `1`, расформированная — закрытая; частичные уникальные индексы `pallets_sscc` и `pallets_block_serial`, индекс `(shift_id)`. Уникальности «одна открытая паллета на устройство» нет.
- `boxes.pallet_id REFERENCES pallets` с `CHECK (pallet_id IS NULL OR closed_at IS NOT NULL)`, частичный индекс.
- `pallet_exceptions(id, record_id, kind ∈ {reprint, disassemble}, pallet_id, reason_code, reason_text, shift_id, device_id, operator_id, occurred_at, received_at)`, `CHECK (reason_text IS NULL OR reason_code = 'other')`, уникальность `(device_id, record_id)`.
- Триггеры `shifts_pallets_insert` и `shifts_pallets_update`: `pallets_enabled = 1` ⇔ заданы `pallet_box_capacity` и `pallet_template_id`. `0009` не получает новый `CHECK` без пересборки таблицы.
- Индекс `shifts_planned_pallet_template` для `template_in_use`.

**Журнал действий** (словарь `audit::actions` не меняется)

| Действие       | Что меняется                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `shift.create` | ничего: детали те же `{ number, productId, lineId, productionDate }` с паллетами и без          |
| `shift.update` | в детали правки входят ещё `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`            |
| `shift.open`   | у смены с паллетами детали получают `palletTemplateId` и `palletTemplateRev`; у смены без — нет |

Факты паллет — производственные данные: ни ревизии, ни строки журнала (кроме поздней отметки закрытой смены, правило 2a2).

**Решения планировщика** (задача 7 записывает их в спецификацию пилота, раздел «Уточнения плана ПЛ-Х»)

- **Состав паллеты выводится, дайджеста нет.** Принадлежность задаёт `palletId` каждого `box_closed`; `pallet_closed` несёт только `boxCount`, который хранится как свидетельство (`box_count_reported`). Сверку с выведенным числом (закрытые короба паллеты без `disassembled_at`) делает О-Х. Дайджест не нужен: короб попадает на паллету только своим же фактом, поэтому расхождение «тот же счёт, другой состав» невозможно без ошибки станции. Облако тоже сверяет паллеты только по коробам. Общая фикстура с доменом в этом плане — `sscc-serials.json`: она закрепляет, как хост читает серию и расширение из SSCC, построенного доменным `buildSscc`. До неё тестовый `sscc_under` был независим от домена (ревью задачи 4 плана 2a2, Minor 1).
- **Порядок фактов и квитанции «навсегда».** В нормальной доставке (очередь в порядке `seq`) короба паллеты приходят раньше её закрытия: автозакрытие пишется той же транзакцией после короба, досрочное — позже. Хост не полагается на порядок. Паллету открывает первый закрытый короб, который её называет (`opened_at` — его `closedAt`), а если ни один короб не дошёл (их записи отвергнуты) — её собственный `pallet_closed`: напечатанный SSCC так или иначе занят. Состояние паллеты не отказывает коробу, поэтому короб, досланный под новым `id` после отказа (правило 2a6/ОЧ «отправить снова — под новыми id в порядке seq»), присоединяется и к закрытой паллете, и счёт сходится.
- **Чужая паллета — `pallet_unknown`**, как `box_unknown`: паллета другого устройства или другой смены. Паллета смены без паллет — `no_pallets` для `palletId` короба и для всех фактов паллет. Повтор закрытия короба с другой паллетой или без своей — `box_already_closed`. Повтор закрытия паллеты тем же SSCC — принят, ничего не пишется; другим — `pallet_already_closed`.
- **Одна открытая паллета на станцию и смену — правило станции, а не хоста.** Уникальный индекс превратил бы вторую открытую паллету устройства (её закрытие отвергнуто, следующая уже копится) в ошибку базы, а пачку — в бесконечную `500`.
- **Расформирование паллеты** ставит `disassembled_at`. Короба не трогаются и сохраняют `pallet_id`, как в облаке. Расформированная паллета не считается в итогах, проверка её этикетки принимается (она закрыта).
- **Поле вида исключения паллеты — `exception`**, как у `box_exception`, а не `kind` спецификации: `kind` уже есть у конверта записи. Код причины обязателен (`reason_code: String`).
- **Неподходящий шаблон паллеты при открытии** — `conflict` с отдельным `constraint: pallet_template_not_fit`: проверяется после шаблона короба, офис различает их по коду.
- **Ответы станции без паллет не меняются.** `DeviceShift` называет `palletBoxCapacity` и `palletTemplateId`, а снимок — `palletTemplate`, только у смены с паллетами (`skip_serializing_if`). Запросы получают необязательные поля. Паллетные формы — в отдельных фикстурах (`shift-create-pallets.json`, `device-shift-create-pallets.json`, `device-shift-entered-pallets.json`, `facts-request-pallets.json`), поэтому схемы станции планов 2a5 и 2a6 читают прежние фикстуры без изменений. `OfficeShift` (офис, план 2a3 уже в базе) называет оба поля всегда, `null` без паллет.
- **Правка запланированной смены.** Паллеты, которые остаются включёнными, сохраняют неприсланные поля, в том числе шаблон, выключенный с тех пор (как шаблон короба). Изменённый шаблон проверяется. Включение без шаблона — `validation_failed` на `palletTemplateId`; вместимость тогда берётся из товара. Выключение очищает оба поля, а присланное вместе с ним поле — `validation_failed`. Открытая смена паллет не меняет (`shift_status`).

**Код и процесс**

- Новых крейтов и пакетов нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются.
- Правила записи `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, `commit_with_revision`; факты ревизии не берут.
- Не меняются: `apps/station`, `packages/*`, применённые миграции `0001`–`0010` (и `0011` плана РК, если он влит), исходники вебвью вне `src/host/protocol.ts`. Тесты вебвью: `test/protocol.test.ts`, `test/fact-rules.test.ts`, `test/support/shifts.ts`. Строители запросов офиса (`src/host/requests.ts`: `shiftCreate`, `shiftUpdate`) паллет пока не шлют: их расширяет план О-Ф вместе с формой.
- Журнал процесса: ни SSCC паллеты, ни кодов. Отказ логируется только устройством, `id` записи и кодом квитанции; новые модули фактов `tracing` не вызывают.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в этот момент он встречается в файле один раз. План применён к копии репозитория шаг за шагом (см. «База»), а каждая правка проверена сценарием: фрагмент единственный, и последовательное применение даёт итоговый файл байт в байт. Внутри шага правки одного файла идут сверху вниз и применяются по порядку. Шаг тестов применяется раньше шага реализации.
- «Создать» — новый файл, ровно как в блоке.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier: расхождение при проверке значит опечатку.
- Русский текст — буквами, не `\uXXXX`.
- Проверка якорей перед шагом: `.superpowers/sdd/tools/check_fragments.py <бриф задачи>` (каждый фрагмент «до» встречается ровно один раз).

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие правила. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названными тестами; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Мутации миграции `0012` тоже меняют только файл: тестовая база создаётся заново в каждом тесте.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` на изменённые JSON, TS и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked`: `--locked` заодно доказывает, что `Cargo.lock` не меняется.
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind` (`Operation not permitted`). Из затронутых планом это `hello` и `no_secrets_in_logs`; их, `cargo test -p markiro-host` целиком, оболочку целиком и `--workspace` запускать вне песочницы. `--test facts`, `--test pallet_facts`, `--test office_shifts`, `--test device_shifts`, `--test sscc_blocks`, `--test fact_rules`, `--test claim`, `--test platform`, `--lib`, `-p markiro-proto` и `-p markiro-standalone --lib host_probe` идут и в песочнице.
- Оболочка встраивает сборку вебвью (`tauri::generate_context!` читает `apps/standalone/dist`): перед `-p markiro-standalone` или `--workspace` в свежем worktree выполнить `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать; команды — из корня репозитория, без `cd`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать локальная обёртка `rtk`: если он выглядит урезанным, запускайте `rtk proxy <команда>`.
- Машина под нагрузкой параллельных агентов: тяжёлые UI-наборы Vitest (`test/template-editor.test.tsx`, `test/shifts-page.test.tsx`, `test/shift-edit.test.tsx`, `test/shift-dialog.test.tsx`, `test/devices-page.test.tsx`, `test/templates-page.test.tsx`) при полном прогоне падают на пределе 5 с и до этого плана. Такой отказ повторить отдельным запуском файла; план эти файлы не трогает.

**Счёт тестов**

- Наборы cargo считаются по строкам `Running` вывода (doc-тесты не считаются). База плана — копия из «Базы». До плана: cargo — 46 наборов, 584 теста (хост 33 и 421, `proto` 2 и 48, оболочка 11 и 115); Vitest — 78 файлов, 2112 тестов. После: cargo — 47 наборов, 616 тестов (хост 34 и 451, `proto` 2 и 50, оболочка 11 и 115); Vitest — 78 файлов, 2123 теста.
- Если влитые 2a2 и 2a3 добавили тесты сверх своих планов, абсолютные числа сдвигаются. Неизменны приращения: хост — задача 1 +1 (`fact_rules`), задача 2 +7 (`office_shifts`), задача 3 +3 (`device_shifts`) и +3 (`sscc_blocks`), задача 4 — новый набор `pallet_facts` с 11 тестами, задача 5 +4, задача 6 +1 (`pallet_facts`); `proto` — задачи 3 и 4 по +1 (`fixtures`); Vitest — задача 1 +7 (`test/fact-rules.test.ts`), задача 2 +3 и задача 6 +1 (`test/protocol.test.ts`). Каждое «Expected» ниже измерено на копии с кодом самого плана.

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                                    задачи 1–6
apps/standalone/proto/fixtures/{sscc-serials,hello,hello-future,error-with-details}.json     задача 1
apps/standalone/proto/fixtures/fact-receipt-codes.json                                       задача 1
apps/standalone/host/src/facts/{rules,box_closed}.rs, host/tests/fact_rules.rs               задачи 1, 4
apps/standalone/host/src/server.rs, host/tests/{claim,hello,platform}.rs                     задача 1
apps/standalone/src-tauri/src/host_probe.rs                                                  задача 1
apps/standalone/src/host/protocol.ts, test/protocol.test.ts                                  задачи 1, 2, 6
apps/standalone/test/fact-rules.test.ts                                                      задача 1
apps/standalone/host/migrations/0012_pallets.sql                                             задача 2
apps/standalone/host/src/shifts.rs, host/src/routes/{office_shifts,templates}.rs             задачи 2, 3, 6
apps/standalone/host/src/routes/{device_shifts,sscc_blocks}.rs                               задачи 2, 3
apps/standalone/host/tests/{office_shifts,device_shifts,sscc_blocks}.rs                      задачи 2, 3, 6
apps/standalone/host/tests/support/app.rs                                                    задачи 2, 4
apps/standalone/proto/fixtures/{office-shift,shift-create-pallets}.json                      задачи 2, 6
apps/standalone/proto/fixtures/{device-shift-create-pallets,device-shift-entered-pallets}.json задача 3
apps/standalone/test/support/shifts.ts                                                       задачи 2, 6
apps/standalone/host/src/facts/{blocks,pallets,pallet_closed,boxes,mod}.rs                   задачи 4, 5
apps/standalone/host/src/facts/{pallet_label,pallet_exception}.rs                            задача 5
apps/standalone/host/tests/pallet_facts.rs                                                   задачи 4–6
apps/standalone/proto/fixtures/facts-request-pallets.json                                    задачи 4, 5
apps/standalone/host/tests/facts.rs                                                          задача 6
apps/standalone/host/tests/no_secrets_in_logs.rs                                             задача 7
apps/standalone/AGENTS.md                                                                    задачи 1–7
docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md                             задача 7
```

Протокол поднимается первым (задача 1), вместе с правилом SSCC по расширению: это правило держит общая с доменом фикстура, и на нём стоят короба и паллеты. Миграция одна и стоит в задаче 2 вместе с первым писателем — полями паллет смены; схема целиком, потому что задачи 4–5 только добавляют писателей. Задача 3 — то, что станции нужно для начала смены с паллетами: создание, вход со снимком шаблона паллеты, блоки паллет. Факты идут по виду на задачу: короб на паллете и закрытие паллеты (4), этикетка и исключения (5). Итоги (6) читают всё, что записали факты. Задача 7 проводит паллеты через журнал процесса, записывает уточнения в спецификацию пилота и делает полную проверку.

## Контракт для ПЛ-Ц, О-Х и ЧЗ

Типы — `proto/src/lib.rs`, формы на проводе — фикстуры `proto/fixtures`. Планы пишут Zod по этим фикстурам и проверяют их в `test/protocol.test.ts`.

**Для ПЛ-Ц (цех: паллеты на станции):**

- Протокол 3 (`PROTOCOL_VERSION`, зеркало `src/host/protocol.ts`): станция протокола 3 видит хост протокола 2 как `host_too_old`.
- `DeviceShift` (`GET /v1/device/shifts`, ответ создания и входа) у смены с паллетами несёт `palletsEnabled: true`, `palletBoxCapacity: number` (1–10 000) и `palletTemplateId: uuid`; у смены без паллет обоих полей **нет**, а не `null` (`device-shifts.json` не меняется). В Zod — `.optional()`. Вход в смену с паллетами отдаёт `snapshot.palletTemplate = { id, name, rev, spec }` (`device-shift-entered-pallets.json`); у смены без паллет поля нет. Макет паллеты станция проверяет `labelTemplateSpecSchema`, как макет короба.
- `POST /v1/device/shifts` принимает `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId` (`device-shift-create-pallets.json`); правила те же, что у офиса: шаблон обязателен, вместимость по умолчанию из товара, без паллет — ни одного поля. Неподходящий шаблон паллеты при входе — 409 `conflict` с `details.constraint = "pallet_template_not_fit"`.
- `POST /v1/device/sscc/blocks` `{ requestId, issuerPrefix, extension: 1 }` → `SsccBlock` с `extension: 1`, размер `site.pallet_block_size` (200), серии паллет счётчика `(префикс, 1)` (у мастера `palletNextSerial`, может быть 0). Повтор `requestId` с другим `extension` — 400 `validation_failed` на `requestId`; исчерпание — `sscc_exhausted` с `details.extension = 1`. Правило «половина» и запас без хоста — на станции.
- Факты (`facts-request-pallets.json`): `box_closed.data.palletId` (uuid) — паллета, к которой короб присоединился при закрытии, в той же записи; `pallet_closed { palletId, sscc, blockId, serial, openedAt, closedAt, boxCount ≥ 1 }` — SSCC доменным `buildSscc(1, issuerPrefix, serial)`, `openedAt` — момент, когда закрылся первый короб, `boxCount` — счёт станции (нерасформированные короба); `pallet_label { palletId, outcome: "verified" | "skipped", at }`; `pallet_exception { exception: "reprint" | "disassemble", palletId, reasonCode, reasonText, occurredAt }` — `reasonCode` обязателен, из `exception-reasons.json` для вида, `reasonText` (1–200 символов после обрезки) только при `other`. Все моменты — `Date.toISOString`.
- Порядок в очереди: короба паллеты раньше её `pallet_closed` (автозакрытие — той же транзакцией после короба). Хост принимает и обратный порядок.
- Коды квитанций (`fact-receipt-codes.json`): `no_pallets` (смена без паллет), `pallet_unknown` (паллета другой смены или устройства; у этикетки и исключения — и паллета, которой у хоста нет), `pallet_already_closed`, `pallet_state` (этикетка или исключение открытой паллеты, исключение расформированной), `sscc_not_issued`, `sscc_taken`, `box_already_closed` (повтор закрытия короба с другой паллетой). Отказ хранится навсегда: «отправить снова» — под новыми `id` (правило 2a6/ОЧ); короб, досланный так, присоединяется и к закрытой паллете.
- Хост не следит за «одной открытой паллетой»: это правило станции.

**Для О-Х (данные отчётов на хосте):**

- `pallets` — паллета смены и устройства: `opened_at`, `closed_at`, `sscc`, `block_id`, `serial`, `box_count_reported`, `operator_id`, `print_verified_at`, `print_skipped_at`, `disassembled_at`, `received_at`. Моменты станции — в формате `Date.toISOString`, `received_at` — в формате хоста.
- Состав паллеты выводится: `SELECT … FROM boxes WHERE pallet_id = ? AND disassembled_at IS NULL` (короб с `pallet_id` всегда закрыт). Его не хранят. Рядом — `box_count_reported` станции: расхождение показывается, а не исправляется (паллета, закрытая до прихода своих коробов, вначале показывает 0).
- Короба расформированной паллеты сохраняют `pallet_id`. Для выгрузок и форм они — короба без паллеты, как и короба открытой паллеты (облако: `openPalletSuppressedBoxCount`). Сортировка паллет — по `closed_at`.
- `pallet_exceptions` — `kind`, `reason_code`, `reason_text`, `occurred_at`, оператор.
- `OfficeShift.totals.closedPallets` и `openPallets` (`office-shift.json`); `OfficeShift.palletBoxCapacity` и `palletTemplateId` — всегда, `null` без паллет.

**Для О-Ф (офис: формы и планирование):** Zod офиса уже принимает поля паллет (`shiftCreateSchema`, `shiftUpdateSchema` — `palletBoxCapacity`, `palletTemplateId` необязательны; `officeShiftSchema` их требует). Строители `shiftCreate` и `shiftUpdate` (`src/host/requests.ts`) и форма — за О-Ф. Отказы: `validation_failed` на `palletTemplateId` или `palletBoxCapacity`, `conflict` на `template_in_use` (теперь и у шаблона паллеты), `shift_status` при правке паллет открытой смены.

**Для ЧЗ (выгрузки):** SSCC паллеты — `pallets.sscc` (18 цифр, расширение 1); паллетные форматы используют только закрытые и нерасформированные паллеты с их нерасформированными коробами (выведенный состав выше); дата документа одной паллеты — `pallets.closed_at` (момент станции).

---

### Task 1: Протокол 3, правило SSCC по расширению с общей фикстурой, коды квитанций паллет

Протокол поднимается до 3: новые виды фактов и поле `palletId` старый хост отверг бы навсегда (ревью задачи 2 плана 2a2), поэтому станция протокола 3 должна видеть хост протокола 2 как `host_too_old`. `MIN_PROTOCOL_VERSION` остаётся 1. Правило «первые 17 цифр SSCC — расширение, префикс и серия» переезжает из `box_closed.rs` в `rules.rs` с параметром расширения (короб 0, паллета 1) и становится безопасным для короткого текста. Его держит новая общая фикстура `sscc-serials.json`: SSCC в ней построены доменным `buildSscc`, Vitest сверяет их с доменом, Rust-тест — с правилом хоста. Коды квитанций паллет добавляются в `proto` и в фикстуру сразу, хотя пишут их задачи 4–5 (как 2a2 добавила все коды в задаче 1).

**Files:**

- Create: `apps/standalone/proto/fixtures/sscc-serials.json`
- Modify: `apps/standalone/proto/src/lib.rs` (`PROTOCOL_VERSION`, `receipt_codes`), `apps/standalone/host/src/facts/rules.rs` (`names_serial`), `apps/standalone/host/src/facts/box_closed.rs`, `apps/standalone/src/host/protocol.ts`
- Modify (фикстуры): `apps/standalone/proto/fixtures/{fact-receipt-codes,hello,hello-future,error-with-details}.json`
- Test: `apps/standalone/host/tests/fact_rules.rs`, `apps/standalone/host/src/server.rs` (модуль `tests`), `apps/standalone/host/tests/{claim,hello,platform}.rs`, `apps/standalone/src-tauri/src/host_probe.rs` (модуль `tests`), `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/fact-rules.test.ts`, `apps/standalone/test/protocol.test.ts`
- Modify: `apps/standalone/AGENTS.md` («Protocol», «Facts»)

**Interfaces:**

- Consumes: `validate::serial_capacity` (1a); доменный `buildSscc` (Vitest).
- Produces: `markiro_proto::PROTOCOL_VERSION = 3`; `receipt_codes::{NO_PALLETS, PALLET_UNKNOWN, PALLET_ALREADY_CLOSED, PALLET_STATE}` (`"no_pallets"`, `"pallet_unknown"`, `"pallet_already_closed"`, `"pallet_state"`); `markiro_host::facts::rules::names_serial(sscc: &str, extension: u8, issuer_prefix: &str, serial: u64) -> bool`; фикстура `sscc-serials.json` `{ cases: [{ extension, issuerPrefix, serial, sscc }] }` (7 случаев).

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. Создать `apps/standalone/proto/fixtures/sscc-serials.json`:

<!-- prettier-ignore -->
```json
{
  "cases": [
    { "extension": 0, "issuerPrefix": "460068200", "serial": 1500, "sscc": "046006820000015000" },
    {
      "extension": 0,
      "issuerPrefix": "460068200",
      "serial": 9999999,
      "sscc": "046006820099999991"
    },
    { "extension": 1, "issuerPrefix": "460068200", "serial": 0, "sscc": "146006820000000003" },
    { "extension": 1, "issuerPrefix": "460068200", "serial": 40, "sscc": "146006820000000409" },
    {
      "extension": 1,
      "issuerPrefix": "460068200",
      "serial": 9999999,
      "sscc": "146006820099999998"
    },
    {
      "extension": 0,
      "issuerPrefix": "4600682",
      "serial": 123456789,
      "sscc": "046006821234567891"
    },
    { "extension": 1, "issuerPrefix": "460068200000", "serial": 9999, "sscc": "146006820000099991" }
  ]
}
```

2. В `apps/standalone/proto/fixtures/fact-receipt-codes.json` фрагмент

<!-- prettier-ignore -->
```json
    "box_state",
    "sscc_not_issued",
    "sscc_taken"
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
    "box_state",
    "sscc_not_issued",
    "sscc_taken",
    "no_pallets",
    "pallet_unknown",
    "pallet_already_closed",
    "pallet_state"
  ]
}
```

3. В `apps/standalone/proto/fixtures/hello.json` фрагмент

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 2,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
```

заменить на

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 3,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
```

4. В `apps/standalone/proto/fixtures/hello-future.json` фрагмент

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 3,
  "minProtocol": 2,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "3.0.0",
  "time": "2027-01-10T08:00:00Z",
  "initialized": true,
```

заменить на

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 4,
  "minProtocol": 3,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "4.0.0",
  "time": "2027-01-10T08:00:00Z",
  "initialized": true,
```

5. В `apps/standalone/proto/fixtures/error-with-details.json` фрагмент

<!-- prettier-ignore -->
```json
  "error": {
    "code": "protocol_unsupported",
    "message": "protocol 7 is outside 1..=2",
    "details": { "protocol": 7, "minProtocol": 1, "maxProtocol": 2 }
  }
}
```

заменить на

<!-- prettier-ignore -->
```json
  "error": {
    "code": "protocol_unsupported",
    "message": "protocol 7 is outside 1..=3",
    "details": { "protocol": 7, "minProtocol": 1, "maxProtocol": 3 }
  }
}
```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
fn hello_ignores_fields_added_by_newer_hosts() {
    let hello: Hello = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(hello.protocol, 3);
    assert!(hello.initialized);
}
```

заменить на

<!-- prettier-ignore -->
```rust
fn hello_ignores_fields_added_by_newer_hosts() {
    let hello: Hello = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(hello.protocol, 4);
    assert!(hello.initialized);
}
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
fn envelope_decides_compatibility_before_the_rest() {
    let future: HelloEnvelope = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(compatibility_for(1, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(2, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(4, &future), Compatibility::HostTooOld);
    let current: HelloEnvelope = serde_json::from_value(fixture("hello.json")).unwrap();
    assert_eq!(compatibility(&current), Compatibility::Compatible);
```

заменить на

<!-- prettier-ignore -->
```rust
fn envelope_decides_compatibility_before_the_rest() {
    let future: HelloEnvelope = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(compatibility_for(2, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(3, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(5, &future), Compatibility::HostTooOld);
    let current: HelloEnvelope = serde_json::from_value(fixture("hello.json")).unwrap();
    assert_eq!(compatibility(&current), Compatibility::Compatible);
```

8. В `apps/standalone/host/tests/fact_rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_host::facts::rules::{
    box_membership_digest, close_reason_required, device_instant, is_code_hash, record_digest,
};
use serde_json::{json, Value};
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_host::facts::rules::{
    box_membership_digest, close_reason_required, device_instant, is_code_hash, names_serial,
    record_digest,
};
use serde_json::{json, Value};
```

9. В `apps/standalone/host/tests/fact_rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
            case["required"].as_bool().unwrap(),
            "{case}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            case["required"].as_bool().unwrap(),
            "{case}"
        );
    }
}

/// The first 17 digits of an SSCC are its extension, the issuer prefix and
/// the serial padded to the prefix's width, as the domain's `buildSscc`
/// writes them (`sscc-serials.json`, built by the domain, which
/// `test/fact-rules.test.ts` checks); the 18th, the check digit, is the
/// domain's and is never read here.
#[test]
fn an_sscc_names_its_extension_prefix_and_serial_as_the_domain_builds_it() {
    let fixture = fixture("sscc-serials.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 7);
    for case in cases {
        let sscc = case["sscc"].as_str().unwrap();
        let extension = u8::try_from(case["extension"].as_u64().unwrap()).unwrap();
        let prefix = case["issuerPrefix"].as_str().unwrap();
        let serial = case["serial"].as_u64().unwrap();
        assert!(names_serial(sscc, extension, prefix, serial), "{case}");
        assert!(!names_serial(sscc, 1 - extension, prefix, serial), "{case}");
        assert!(!names_serial(sscc, extension, prefix, serial + 1), "{case}");
        assert!(!names_serial(sscc, extension, prefix, serial ^ 1), "{case}");
        let digit = (sscc.as_bytes()[17] - b'0' + 1) % 10;
        let other_check_digit = format!("{}{digit}", &sscc[..17]);
        assert!(
            names_serial(&other_check_digit, extension, prefix, serial),
            "{case}"
        );
    }
    // Another prefix of the same length names another SSCC.
    assert!(!names_serial("146006820000000409", 1, "460068201", 40));
    // Text that is no SSCC names no serial, and never panics.
    for text in ["", "1460068200000004", "146006820000000é"] {
        assert!(!names_serial(text, 1, "460068200", 40), "{text:?}");
    }
}

```

10. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[tokio::test]
    async fn a_supported_version_passes() {
        // Protocol 2 (stage 2a) is this build's; 1 (stage 1) is still taken.
        assert_eq!(call(Some("2")).await.0, StatusCode::OK);
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
```

заменить на

<!-- prettier-ignore -->
```rust
    #[tokio::test]
    async fn a_supported_version_passes() {
        // Protocol 3 (pallets, plan ПЛ-Х) is this build's; 2 (stage 2a) and
        // 1 (stage 1) are still taken.
        assert_eq!(call(Some("3")).await.0, StatusCode::OK);
        assert_eq!(call(Some("2")).await.0, StatusCode::OK);
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
```

11. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 2);
    }

```

заменить на

<!-- prettier-ignore -->
```rust
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 3);
    }

```

12. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("3")).await.0, StatusCode::BAD_REQUEST);
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("4")).await.0, StatusCode::BAD_REQUEST);
    }
}
```

13. В `apps/standalone/host/tests/claim.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 2, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 3, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
```

14. В `apps/standalone/host/tests/hello.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    // Protocol 2 since plan 2a1; a station of stage 1 (protocol 1) is still
    // taken.
    assert_eq!(hello.protocol, 2);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
```

заменить на

<!-- prettier-ignore -->
```rust
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    // Protocol 3 since plan ПЛ-Х (2 since plan 2a1); a station of stage 1
    // (protocol 1) is still taken.
    assert_eq!(hello.protocol, 3);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
```

15. В `apps/standalone/host/tests/platform.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 2);
    assert_eq!(body["minProtocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
```

заменить на

<!-- prettier-ignore -->
```rust
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 3);
    assert_eq!(body["minProtocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
```

16. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Err(ProbeError::HostTooOld)
        );
        // A host of stage 1 speaks protocol 1 only: a stage 2a station asks
        // for an update of the host (stage 2a spec, decision 35).
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
```

заменить на

<!-- prettier-ignore -->
```rust
            Err(ProbeError::HostTooOld)
        );
        // A host of stage 1 speaks protocol 1 only, a host of stage 2a up to
        // 2: a station that knows pallets (protocol 3, plan ПЛ-Х) asks for
        // an update of the host.
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 2, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
```

17. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 2, "minProtocol": 1})),
            Err(ProbeError::InvalidResponse)
        );
```

заменить на

<!-- prettier-ignore -->
```rust
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 3, "minProtocol": 1})),
            Err(ProbeError::InvalidResponse)
        );
```

18. В `apps/standalone/src-tauri/src/host_probe.rs` фрагмент

<!-- prettier-ignore -->
```rust
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": 2,
            "minProtocol": 1,
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
```

заменить на

<!-- prettier-ignore -->
```rust
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": 3,
            "minProtocol": 1,
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
```

19. В `apps/standalone/test/fact-rules.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
import {
  boxMembershipDigestV1,
  SHIFT_CLOSE_REASON_CODES,
  shiftCloseReasonRequired,
```

заменить на

<!-- prettier-ignore -->
```ts
import {
  boxMembershipDigestV1,
  buildSscc,
  SHIFT_CLOSE_REASON_CODES,
  shiftCloseReasonRequired,
```

20. В `apps/standalone/test/fact-rules.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
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
```

заменить на

<!-- prettier-ignore -->
```ts
  .parse(fixture("device-instants.json"));

const SSCC_SERIALS = z
  .strictObject({
    cases: z.array(
      z.strictObject({
        extension: z.number().int(),
        issuerPrefix: z.string(),
        serial: z.number().int(),
        sscc: z.string(),
      }),
    ),
  })
  .parse(fixture("sscc-serials.json"));

describe("fact rules: the fixtures the host's facts answer too", () => {
  it("holds 5 box digests, 6 close cases, 22 instants and 7 SSCCs", () => {
    expect([
      BOX_DIGEST.cases.length,
      CLOSE_REASONS.required.length,
      INSTANTS.valid.length + INSTANTS.invalid.length,
      SSCC_SERIALS.cases.length,
    ]).toEqual([5, 6, 22, 7]);
  });

  // The host reads the first 17 digits of a box's or a pallet's SSCC as
  // these three fields (`rules::names_serial`).
  it.each(SSCC_SERIALS.cases)(
    "builds the SSCC of extension $extension, prefix $issuerPrefix and serial $serial",
    (entry) => {
      expect(buildSscc(entry.extension, entry.issuerPrefix, entry.serial)).toBe(entry.sscc);
    },
  );

  it.each(BOX_DIGEST.cases)("digests the members $hashes as the domain does", (entry) => {
```

21. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 2,
    });
  });
```

заменить на

<!-- prettier-ignore -->
```ts
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 3,
    });
  });
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL — ошибка сборки `unresolved import markiro_host::facts::rules::names_serial`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — `5 passed` и `41 passed; 2 failed`: `hello_fixture_round_trips` (фикстура говорит 3, сборка 2) и `the_fact_code_fixtures_list_every_receipt_and_reason_code`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --test claim --test platform --offline --locked --no-fail-fast`
Expected: FAIL — `server::tests::a_supported_version_passes` и `server::tests::a_missing_header_is_refused_with_details` (`55 passed; 2 failed`), `a_device_in_the_network_pairs_with_a_code_typed_in_any_case` (`claim`: устройство пишет протокол запроса, 2), `hello_needs_no_protocol_header` (`platform`).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test hello --offline --locked`
Expected: FAIL `hello_answers_over_tls_with_the_pinned_certificate`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib host_probe --offline --locked`
Expected: FAIL `host_probe::tests::a_host_older_than_this_app_is_rejected` (`5 passed; 1 failed`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/fact-rules.test.ts test/protocol.test.ts`
Expected: FAIL — `Tests  1 failed | 299 passed (300)`: `protocol schemas parse the shared Rust fixtures > hello`. `test/fact-rules.test.ts` проходит сразу: домен уже строит SSCC фикстуры.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 2;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
```

заменить на

<!-- prettier-ignore -->
```rust
use sha2::{Digest, Sha256};

/// Protocol version this build speaks: 3 since plan ПЛ-Х (pallets: the
/// shift's pallet fields, pallet blocks, the pallet facts and a box's
/// `palletId`). A new fact kind or a new field of a fact's `data` raises it,
/// because an older host refuses such a record for good.
pub const PROTOCOL_VERSION: u32 = 3;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// label check of an open box, an undo in a closed one).
    pub const BOX_STATE: &str = "box_state";
    /// The SSCC is not of the shift's prefix, or its serial lies in no block
    /// issued to this device.
    pub const SSCC_NOT_ISSUED: &str = "sscc_not_issued";
    /// Another box carries the SSCC.
    pub const SSCC_TAKEN: &str = "sscc_taken";

    /// Every code above, for the parity fixture the webview also reads.
```

заменить на

<!-- prettier-ignore -->
```rust
    /// label check of an open box, an undo in a closed one).
    pub const BOX_STATE: &str = "box_state";
    /// The SSCC is not of the record's extension (a box 0, a pallet 1) and
    /// the shift's prefix, or its serial lies in no live block of that
    /// extension issued to this device.
    pub const SSCC_NOT_ISSUED: &str = "sscc_not_issued";
    /// Another box (or pallet) carries the SSCC, or is closed on its serial
    /// of its block.
    pub const SSCC_TAKEN: &str = "sscc_taken";
    /// The shift works without pallets, and the record names a pallet.
    pub const NO_PALLETS: &str = "no_pallets";
    /// No pallet of this device and this shift has the id: another device's
    /// or another shift's has it, or (for a label check or an exception) no
    /// pallet at all.
    pub const PALLET_UNKNOWN: &str = "pallet_unknown";
    /// A pallet closed with one SSCC is closed again with another.
    pub const PALLET_ALREADY_CLOSED: &str = "pallet_already_closed";
    /// The pallet is not in the state the record needs (a label check or an
    /// exception of an open pallet, an exception of one taken apart).
    pub const PALLET_STATE: &str = "pallet_state";

    /// Every code above, for the parity fixture the webview also reads.
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        SSCC_NOT_ISSUED,
        SSCC_TAKEN,
    ];
}
```

заменить на

<!-- prettier-ignore -->
```rust
        SSCC_NOT_ISSUED,
        SSCC_TAKEN,
        NO_PALLETS,
        PALLET_UNKNOWN,
        PALLET_ALREADY_CLOSED,
        PALLET_STATE,
    ];
}
```

4. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! device's instant (`device-instants.json`, what `Date.toISOString` writes)
//! and when a station's close needs a reason (`shift-close-reasons.json`,
//! the domain's `shiftCloseReasonRequired`). The digest of a record is the
//! host's own: it keys idempotency.

use aws_lc_rs::digest::{digest, SHA256};
```

заменить на

<!-- prettier-ignore -->
```rust
//! device's instant (`device-instants.json`, what `Date.toISOString` writes)
//! and when a station's close needs a reason (`shift-close-reasons.json`,
//! the domain's `shiftCloseReasonRequired`), and how the first 17 digits of
//! a box's or a pallet's SSCC name its serial (`sscc-serials.json`, built by
//! the domain's `buildSscc`). The digest of a record is the host's own: it
//! keys idempotency.

use aws_lc_rs::digest::{digest, SHA256};
```

5. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// The domain's `shiftCloseReasonRequired`: a station's close needs one of
/// the six reason codes when the shift had a plan and the fact differs.
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// Whether `sscc` is the SSCC of `serial` under `issuer_prefix` and the
/// extension digit `extension` (a box 0, a pallet 1), whatever its check
/// digit: its first 17 digits are the extension, the prefix and the serial
/// padded to the prefix's width, as the domain's `buildSscc` writes them. The
/// check digit is a marking rule, the domain's (stage 2a spec, decision 13).
/// Text shorter than that names no serial.
pub fn names_serial(sscc: &str, extension: u8, issuer_prefix: &str, serial: u64) -> bool {
    let width = 16 - issuer_prefix.len();
    serial < crate::validate::serial_capacity(issuer_prefix)
        && sscc
            .get(..17)
            .is_some_and(|body| body == format!("{extension}{issuer_prefix}{serial:0width$}"))
}

/// The domain's `shiftCloseReasonRequired`: a station's close needs one of
/// the six reason codes when the shift had a plan and the fact differs.
```

6. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
}

pub async fn apply(
    conn: &mut SqliteConnection,
```

7. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        };
    }
    if !names_serial(&closed.sscc, &context.shift.issuer_prefix, closed.serial) {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
```

заменить на

<!-- prettier-ignore -->
```rust
        };
    }
    if !rules::names_serial(&closed.sscc, 0, &context.shift.issuer_prefix, closed.serial) {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
```

8. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 2;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
```

заменить на

<!-- prettier-ignore -->
```ts

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 3;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --test facts --test claim --test platform --lib --offline --locked`
Expected: PASS — `--lib` 57, `claim` 9, `fact_rules` 13, `facts` 36 (короба закрываются тем же правилом), `platform` 7.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test hello --offline --locked`
Expected: PASS — 5.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib host_probe --offline --locked`
Expected: PASS — 6.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/fact-rules.test.ts test/protocol.test.ts`
Expected: PASS — `Tests  300 passed (300)` (`test/fact-rules.test.ts` 92, `test/protocol.test.ts` 208).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. It is 2 since plan 2a1,
with `MIN_PROTOCOL_VERSION` still 1: the host takes the stations of stage 1,
and a station of stage 2a finds a host of stage 1 too old (`host_too_old` at
the probe). `src/host/protocol.ts` mirrors it, and `test/protocol.test.ts`
ties the mirror to `hello.json`. Response types, which
devices of different versions read, tolerate unknown fields; request types,
```

заменить на

<!-- prettier-ignore -->
```text
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. It is 3 since plan
ПЛ-Х (pallets; 2 since plan 2a1), with `MIN_PROTOCOL_VERSION` still 1: the
host takes the stations of stage 1 and of stage 2a, and a station that knows
pallets finds a host of stage 1 or 2a too old (`host_too_old` at the probe).
A new fact kind or a new field of a fact's `data` raises it too: an older
host answers such a record `invalid_record` and keeps that receipt for good.
`src/host/protocol.ts` mirrors it, and `test/protocol.test.ts`
ties the mirror to `hello.json`. Response types, which
devices of different versions read, tolerate unknown fields; request types,
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
comparing the stored text orders the instants) and when a station's close
needs a reason (`shift-close-reasons.json`, the domain's six
`SHIFT_CLOSE_REASON_CODES` and `shiftCloseReasonRequired`). The codes of a
rejected receipt (`proto::receipt_codes`, `fact-receipt-codes.json`) and the
reason codes of box exceptions (`proto::exception_reasons`,
```

заменить на

<!-- prettier-ignore -->
```text
comparing the stored text orders the instants) and when a station's close
needs a reason (`shift-close-reasons.json`, the domain's six
`SHIFT_CLOSE_REASON_CODES` and `shiftCloseReasonRequired`) and how the first
17 digits of an SSCC name its extension, prefix and serial
(`sscc-serials.json`, `rules::names_serial`, built by the domain's
`buildSscc`; the check digit is never read). The codes of a
rejected receipt (`proto::receipt_codes`, `fact-receipt-codes.json`) and the
reason codes of box exceptions (`proto::exception_reasons`,
```

- [ ] **Step 6: Мутации**

М1 — расширение не сверяется. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
body == format!("{extension}{issuer_prefix}{serial:0width$}")
```

заменить на

<!-- prettier-ignore -->
```rust
body[1..] == format!("{issuer_prefix}{serial:0width$}")
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `an_sscc_names_its_extension_prefix_and_serial_as_the_domain_builds_it`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — контрольная цифра читается. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
.get(..17)
```

заменить на

<!-- prettier-ignore -->
```rust
.get(..18)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `an_sscc_names_its_extension_prefix_and_serial_as_the_domain_builds_it`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — ширина серии не по префиксу. В `apps/standalone/host/src/facts/rules.rs` фрагмент

<!-- prettier-ignore -->
```rust
let width = 16 - issuer_prefix.len();
```

заменить на

<!-- prettier-ignore -->
```rust
let width = 7;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test fact_rules --offline --locked`
Expected: FAIL `an_sscc_names_its_extension_prefix_and_serial_as_the_domain_builds_it`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — короб закрывается расширением паллеты. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
rules::names_serial(&closed.sscc, 0,
```

заменить на

<!-- prettier-ignore -->
```rust
rules::names_serial(&closed.sscc, 1,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts --offline --locked`
Expected: FAIL `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`, `the_host_never_counts_the_check_digit_of_an_sscc` и ещё 10 тестов набора `facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — код квитанции не в списке. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        PALLET_ALREADY_CLOSED,
        PALLET_STATE,
    ];
```

заменить на

<!-- prettier-ignore -->
```rust
        PALLET_ALREADY_CLOSED,
    ];
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline --locked`
Expected: FAIL `the_fact_code_fixtures_list_every_receipt_and_reason_code`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/sscc-serials.json apps/standalone/proto/fixtures/fact-receipt-codes.json apps/standalone/proto/fixtures/hello.json apps/standalone/proto/fixtures/hello-future.json apps/standalone/proto/fixtures/error-with-details.json apps/standalone/test/fact-rules.test.ts apps/standalone/test/protocol.test.ts apps/standalone/src/host/protocol.ts`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/sscc-serials.json apps/standalone/proto/fixtures/fact-receipt-codes.json apps/standalone/proto/fixtures/hello.json apps/standalone/proto/fixtures/hello-future.json apps/standalone/proto/fixtures/error-with-details.json apps/standalone/host/src/facts/rules.rs apps/standalone/host/src/facts/box_closed.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/fact_rules.rs apps/standalone/host/tests/claim.rs apps/standalone/host/tests/hello.rs apps/standalone/host/tests/platform.rs apps/standalone/src-tauri/src/host_probe.rs apps/standalone/src/host/protocol.ts apps/standalone/test/fact-rules.test.ts apps/standalone/test/protocol.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): protocol 3, an SSCC's serial read by its extension as the domain builds it, the pallet receipt codes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Миграция `0012` и смена с паллетами в офисе — план, правка, удаление шаблона, Zod офиса

Модель целиком ложится одной миграцией (`pallets`, `pallet_exceptions`, `boxes.pallet_id`, триггеры полей паллет смены, индекс шаблона паллеты запланированных смен), а первым её писателем становится офис. Смена с паллетами называет шаблон паллеты, который подходит товару, и вместимость (по умолчанию из товара); смена без паллет не присылает ни одного поля паллет. Правка запланированной смены включает, меняет и выключает паллеты, открытая их не меняет. Шаблон паллеты, который называет запланированная смена, не удаляется. Zod офиса получает поля паллет; строители запросов и форма — план О-Ф.

**Files:**

- Create: `apps/standalone/host/migrations/0012_pallets.sql`, `apps/standalone/proto/fixtures/shift-create-pallets.json`
- Modify: `apps/standalone/host/src/shifts.rs` (`ShiftProduct.pallet_box_capacity`, `check_pallet_template`, `Pallets`, `PalletRequest`, `pallet_request`, `pallets`, `NewShift.pallets`, `insert`), `apps/standalone/host/src/routes/office_shifts.rs`, `apps/standalone/host/src/routes/device_shifts.rs` (`pallets: None`), `apps/standalone/host/src/routes/templates.rs`, `apps/standalone/proto/src/lib.rs` (`OfficeShift`, `ShiftCreate`, `ShiftUpdate`), `apps/standalone/src/host/protocol.ts`, `apps/standalone/proto/fixtures/office-shift.json`
- Test: `apps/standalone/host/tests/office_shifts.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/support/shifts.ts`
- Modify: `apps/standalone/AGENTS.md` («Shifts»)

**Interfaces:**

- Consumes: `templates::check_slot`, `validate::{count, MAX_PALLET_BOX_CAPACITY}`, `products.pallet_box_capacity` (1e1).
- Produces: `shifts::{check_pallet_template(conn, id, group), Pallets { box_capacity: u32, template_id: String }, PalletRequest::{Off, On { box_capacity: Option<u32>, template_id: &str }}, pallet_request(enabled, box_capacity, template_id) -> Result<PalletRequest, ApiError>, pallets(conn, request, &ShiftProduct) -> Result<Option<Pallets>, ApiError>}`; `NewShift.pallets: Option<Pallets>`; `office_shifts::check_mode(mode)` (без второго параметра); `OfficeShift.{pallet_box_capacity, pallet_template_id}: Option<…>`; `ShiftCreate`/`ShiftUpdate.{pallet_box_capacity: Option<u32>, pallet_template_id: Option<String>}`; таблицы `pallets`, `pallet_exceptions`, столбец `boxes.pallet_id`; помощники тестов `support::app::{office_template(admin, purpose, enabled, codes) -> String, pallet_template(admin) -> String, pallet_shift_body(setup, template) -> Value}`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// Plan a shift of `body` as the administrator; returns the record.
pub async fn plan_shift(admin: &Admin, body: Value) -> Value {
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// A label template of `purpose` made through the office API, enabled or
/// not, for the product groups `codes` (`Value::Null`: every group);
/// returns its id.
pub async fn office_template(admin: &Admin, purpose: &str, enabled: bool, codes: Value) -> String {
    let (status, template) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(serde_json::json!({
                "name": "Паллета 100×150", "purpose": purpose, "enabled": enabled,
                "chzProductGroupCodes": codes,
                "spec": {
                    "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl",
                    "elements": []
                }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    template["id"].as_str().unwrap().to_owned()
}

/// An enabled pallet template for every product group; returns its id.
pub async fn pallet_template(admin: &Admin) -> String {
    office_template(admin, "pallet", true, Value::Null).await
}

/// `shift_body(setup)` with pallets of `template`, their capacity left to
/// the product's 40.
pub fn pallet_shift_body(setup: &ShiftSetup, template: &str) -> Value {
    let mut body = shift_body(setup);
    body["palletsEnabled"] = Value::Bool(true);
    body["palletTemplateId"] = Value::String(template.to_owned());
    body
}

/// Plan a shift of `body` as the administrator; returns the record.
pub async fn plan_shift(admin: &Admin, body: Value) -> Value {
```

2. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, plan_shift, request,
    seed_office_user, shift_body, shift_setup, turn_the_user_off_at_the_next_activity, with_device,
    Admin, ShiftSetup,
};

```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, office_template,
    pallet_shift_body, pallet_template, plan_shift, request, seed_office_user, shift_body,
    shift_setup, turn_the_user_off_at_the_next_activity, with_device, Admin, ShiftSetup,
};

```

3. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "lineId": setup.line, "counterpartyId": null, "productionDate": "2026-10-08",
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
```

заменить на

<!-- prettier-ignore -->
```rust
        "lineId": setup.line, "counterpartyId": null, "productionDate": "2026-10-08",
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "palletBoxCapacity": null, "palletTemplateId": null,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
```

4. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
    ] {
        let mut body = shift_body(&setup);
```

заменить на

<!-- prettier-ignore -->
```rust
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
    ] {
        let mut body = shift_body(&setup);
```

5. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
    ] {
        let mut body = change.clone();
```

заменить на

<!-- prettier-ignore -->
```rust
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
    ] {
        let mut body = change.clone();
```

6. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(planned["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(planned["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

fn field(name: &str) -> (Value, Value) {
    (json!("validation_failed"), json!({ "field": name }))
}

/// A shift with pallets names its pallet template and takes the product's
/// pallet capacity unless it names its own; a shift without pallets names
/// neither. The plan's audit row is the same with pallets or without.
#[tokio::test]
async fn a_shift_with_pallets_takes_its_template_and_the_products_capacity() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut expected = planned(&id, "OCT26-001", &setup, shift["rev"].as_i64().unwrap());
    expected["palletsEnabled"] = json!(true);
    expected["palletBoxCapacity"] = json!(40);
    expected["palletTemplateId"] = json!(pallet);
    assert_eq!(shift, expected);
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, expected));
    let mut body = pallet_shift_body(&setup, &pallet);
    body["palletBoxCapacity"] = json!(10_000);
    let named = plan_shift(&admin, body).await;
    assert_eq!(
        (
            named["palletsEnabled"].clone(),
            named["palletBoxCapacity"].clone(),
            named["palletTemplateId"].clone()
        ),
        (json!(true), json!(10_000), json!(pallet))
    );
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(
        (
            plain["palletsEnabled"].clone(),
            plain["palletBoxCapacity"].clone(),
            plain["palletTemplateId"].clone()
        ),
        (json!(false), Value::Null, Value::Null)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await[0],
        admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )
    );
}

/// A plan with pallets needs a pallet template that fits the product: an
/// enabled one of the pallet purpose covering its group. A plan without
/// pallets sends no pallet field. A refusal writes nothing.
#[tokio::test]
async fn a_plan_with_pallets_needs_a_fitting_pallet_template_and_one_without_sends_neither() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let other_group = office_template(&admin, "pallet", true, json!([15])).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    for (change, expected) in [
        (
            json!({ "palletsEnabled": false, "palletBoxCapacity": 40 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
        (
            json!({ "palletsEnabled": true, "palletBoxCapacity": 40 }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 0 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({
                "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 10_001
            }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": other_group }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": "no-such-template" }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list, json!([]));
}

/// A planned shift turns pallets on (with a template; the capacity is the
/// product's), changes their capacity or template, and turns them off,
/// which clears both; each change is audited field by field.
#[tokio::test]
async fn a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let other = pallet_template(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut rev = shift["rev"].clone();
    let mut expected_trail = Vec::new();
    for (change, after, details) in [
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet }),
            (json!(true), json!(40), json!(pallet)),
            json!({
                "changed": ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"],
                "palletsEnabled": { "from": false, "to": true },
                "palletBoxCapacity": { "from": null, "to": 40 },
                "palletTemplateId": { "from": null, "to": pallet },
            }),
        ),
        (
            json!({ "palletBoxCapacity": 30 }),
            (json!(true), json!(30), json!(pallet)),
            json!({
                "changed": ["palletBoxCapacity"],
                "palletBoxCapacity": { "from": 40, "to": 30 },
            }),
        ),
        (
            json!({ "palletTemplateId": other }),
            (json!(true), json!(30), json!(other)),
            json!({
                "changed": ["palletTemplateId"],
                "palletTemplateId": { "from": pallet, "to": other },
            }),
        ),
        (
            json!({ "palletsEnabled": false }),
            (json!(false), Value::Null, Value::Null),
            json!({
                "changed": ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"],
                "palletsEnabled": { "from": true, "to": false },
                "palletBoxCapacity": { "from": 30, "to": null },
                "palletTemplateId": { "from": other, "to": null },
            }),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = rev.clone();
        let (status, updated) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{change}: {updated}");
        assert_eq!(
            (
                updated["palletsEnabled"].clone(),
                updated["palletBoxCapacity"].clone(),
                updated["palletTemplateId"].clone()
            ),
            after,
            "{change}"
        );
        let (_, read_back) = admin.call("GET", &path(&shift), None).await;
        assert_eq!(read_back, updated, "{change}");
        rev = updated["rev"].clone();
        expected_trail.push(admin.row("shift.update", "shift", &id, details));
    }
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        expected_trail
    );
}

/// An edit keeps the pallet fields it does not send, even a template
/// disabled since, and checks a template it changes; pallets turned on need
/// a template, and a shift without pallets takes no pallet field.
#[tokio::test]
async fn an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let with_pallets = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    // The shift's template is disabled after it was planned.
    let (status, template) = admin
        .call("GET", &format!("/v1/office/templates/{pallet}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, turned_off) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{pallet}"),
            Some(json!({ "enabled": false, "expectedRev": template["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{turned_off}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    for (shift, change, expected) in [
        (
            &with_pallets,
            json!({ "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletsEnabled": false, "palletBoxCapacity": 20 }),
            field("palletBoxCapacity"),
        ),
        (
            &with_pallets,
            json!({ "palletsEnabled": false, "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletBoxCapacity": 10_001 }),
            field("palletBoxCapacity"),
        ),
        (
            &plain,
            json!({ "palletsEnabled": true }),
            field("palletTemplateId"),
        ),
        (
            &plain,
            json!({ "palletBoxCapacity": 20 }),
            field("palletBoxCapacity"),
        ),
        (
            &plain,
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = shift["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // A bad capacity is refused before the shift is looked up.
    let (status, refused) = admin
        .call(
            "PUT",
            "/v1/office/shifts/no-such-shift",
            Some(json!({ "palletBoxCapacity": 0, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("palletBoxCapacity"))
    );
    // The disabled template stays while the edit does not change it.
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&with_pallets),
            Some(json!({ "palletBoxCapacity": 25, "expectedRev": with_pallets["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["palletBoxCapacity"].clone(),
            updated["palletTemplateId"].clone()
        ),
        (json!(25), json!(pallet))
    );
    // The same value again changes nothing: no revision, no audit row.
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&with_pallets),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 25,
                "expectedRev": updated["rev"]
            })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// An open shift keeps its pallets: an edit that sends them unchanged
/// passes with its plan, one that changes them is `shift_status`.
#[tokio::test]
async fn an_active_shift_keeps_its_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let other = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &shift).await;
    open_directly(&admin, &plain).await;
    let (_, current) = admin.call("GET", &path(&shift), None).await;
    let (_, current_plain) = admin.call("GET", &path(&plain), None).await;
    let active = || {
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "active" }),
            ),
        )
    };
    for (shift, change) in [
        (&current, json!({ "palletsEnabled": false })),
        (&current, json!({ "palletBoxCapacity": 30 })),
        (&current, json!({ "palletTemplateId": other })),
        (
            &current_plain,
            json!({ "palletsEnabled": true, "palletTemplateId": pallet }),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = shift["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(shift), Some(body)).await;
        assert_eq!((status, refusal(&refused)), active(), "{change}");
    }
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&current),
            Some(json!({
                "palletsEnabled": true, "palletBoxCapacity": 40, "palletTemplateId": pallet,
                "plannedQty": 800, "expectedRev": current["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["plannedQty"].clone(),
            updated["palletBoxCapacity"].clone(),
            updated["palletTemplateId"].clone()
        ),
        (json!(800), json!(40), json!(pallet))
    );
}

/// A pallet template a planned shift names is not deleted either; once the
/// shift is open its layout lives in the snapshot.
#[tokio::test]
async fn a_pallet_template_a_planned_shift_names_is_not_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let template = format!("/v1/office/templates/{pallet}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = admin.call("DELETE", &template, None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "template_in_use", "shiftIds": [shift["id"]] })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    open_directly(&admin, &shift).await;
    let (status, body) = admin.call("DELETE", &template, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

/// The pallet columns of `shifts` go together: a shift with pallets names
/// their capacity and template, a shift without names neither (two
/// triggers of `0012`, since `0009` takes no new CHECK).
#[tokio::test]
async fn the_schema_keeps_a_shifts_pallet_fields_together() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let with_pallets = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    for (shift, set) in [
        (&plain, "pallets_enabled = 1".to_owned()),
        (
            &plain,
            "pallets_enabled = 1, pallet_box_capacity = 40".to_owned(),
        ),
        (
            &plain,
            format!("pallets_enabled = 1, pallet_template_id = '{pallet}'"),
        ),
        (&plain, "pallet_box_capacity = 40".to_owned()),
        (&plain, format!("pallet_template_id = '{pallet}'")),
        (&with_pallets, "pallets_enabled = 0".to_owned()),
        (&with_pallets, "pallet_box_capacity = NULL".to_owned()),
        (&with_pallets, "pallet_template_id = NULL".to_owned()),
    ] {
        let message = schema_refuses(&admin, shift, &set).await;
        assert!(
            message.contains("shift pallets: capacity and template exactly when enabled"),
            "{set}: {message}"
        );
    }
    // A new row is held the same way.
    let copy = |enabled: i64, capacity: &str, template: &str| {
        format!(
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, \
             created_by_kind, created_by, status, mode, pallets_enabled, product_id, line_id, \
             production_date, box_capacity, box_template_id, pallet_box_capacity, \
             pallet_template_id, created_at, rev) \
             SELECT 'copy', number_month_key, number_seq + 100, created_from, created_by_kind, \
             created_by, status, mode, {enabled}, product_id, line_id, production_date, \
             box_capacity, box_template_id, {capacity}, {template}, created_at, rev \
             FROM shifts WHERE id = ?"
        )
    };
    let quoted = format!("'{pallet}'");
    for (enabled, capacity, template) in [
        (1, "NULL", quoted.as_str()),
        (1, "40", "NULL"),
        (0, "40", "NULL"),
        (0, "NULL", quoted.as_str()),
    ] {
        let outcome = sqlx::query(&copy(enabled, capacity, template))
            .bind(plain["id"].as_str().unwrap())
            .execute(&admin.app.state.pool)
            .await;
        let message = outcome
            .err()
            .unwrap_or_else(|| panic!("the schema took {enabled} {capacity} {template}"))
            .to_string();
        assert!(
            message.contains("shift pallets: capacity and template exactly when enabled"),
            "{message}"
        );
    }
    // Together, either way, the rows are taken.
    sqlx::query(&copy(1, "40", &quoted))
        .bind(plain["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query(&format!(
        "UPDATE shifts SET pallets_enabled = 1, pallet_box_capacity = 40, \
         pallet_template_id = '{pallet}' WHERE id = ?"
    ))
    .bind(plain["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE shifts SET pallets_enabled = 0, pallet_box_capacity = NULL, \
         pallet_template_id = NULL WHERE id = ?",
    )
    .bind(with_pallets["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

```

7. Создать `apps/standalone/proto/fixtures/shift-create-pallets.json`:

<!-- prettier-ignore -->
```json
{
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "productionDate": "2026-10-08",
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "boxCapacity": 12,
  "plannedQty": 1200,
  "counterpartyId": null,
  "mode": "aggregation",
  "palletsEnabled": true,
  "palletBoxCapacity": 40,
  "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f"
}
```

8. В `apps/standalone/proto/fixtures/office-shift.json` фрагмент

<!-- prettier-ignore -->
```json
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
```

заменить на

<!-- prettier-ignore -->
```json
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "palletBoxCapacity": null,
  "palletTemplateId": null,
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
```

9. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn a_shift_update_carries_only_what_changes_and_never_the_product() {
```

заменить на

<!-- prettier-ignore -->
```rust
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
    // Without pallets the pallet fields are left out, and stay out.
    assert_eq!(
        (shift.pallet_box_capacity, shift.pallet_template_id.clone()),
        (None, None)
    );
    assert_eq!(
        (bare.pallet_box_capacity, bare.pallet_template_id.clone()),
        (None, None)
    );
    let pallets: ShiftCreate = round_trip("shift-create-pallets.json");
    assert_eq!(
        (
            pallets.pallets_enabled,
            pallets.pallet_box_capacity,
            pallets.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some("c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f"))
    );
}

#[test]
fn a_shift_update_carries_only_what_changes_and_never_the_product() {
```

10. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    value["productId"] = Value::String("f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b".into());
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
}

```

заменить на

<!-- prettier-ignore -->
```rust
    value["productId"] = Value::String("f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b".into());
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
    // Pallet fields go out only when sent.
    let pallets = serde_json::json!({
        "palletsEnabled": true, "palletBoxCapacity": 30,
        "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f", "expectedRev": 71
    });
    let typed: ShiftUpdate = serde_json::from_value(pallets.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), pallets);
}

```

11. В `apps/standalone/test/support/shifts.ts` фрагмент

<!-- prettier-ignore -->
```ts
  boxCapacity: 12,
  boxTemplateId: MILK_BOX.id,
  ownerDeviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  openedAt: "2026-10-08T06:02:00Z",
```

заменить на

<!-- prettier-ignore -->
```ts
  boxCapacity: 12,
  boxTemplateId: MILK_BOX.id,
  palletBoxCapacity: null,
  palletTemplateId: null,
  ownerDeviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  openedAt: "2026-10-08T06:02:00Z",
```

12. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
  ["shift-create.json", shiftCreateSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
```

заменить на

<!-- prettier-ignore -->
```ts
  ["bootstrap-request-templates.json", bootstrapRequestSchema],
  ["shift-create.json", shiftCreateSchema],
  ["shift-create-pallets.json", shiftCreateSchema],
  ["shift-update.json", shiftUpdateSchema],
  ["shift-close.json", shiftCloseSchema],
```

13. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      plannedQty: [0, 1.5, -1, "1200"],
      boxCapacity: [0, 1.5, null],
      productionDate: ["08.10.2026", "2026-10-8", 20261008, null],
      openedAt: ["yesterday"],
```

заменить на

<!-- prettier-ignore -->
```ts
      plannedQty: [0, 1.5, -1, "1200"],
      boxCapacity: [0, 1.5, null],
      palletBoxCapacity: [0, 1.5, -1, "40"],
      palletTemplateId: ["42"],
      productionDate: ["08.10.2026", "2026-10-8", 20261008, null],
      openedAt: ["yesterday"],
```

14. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
        true,
      );
    }
  });

  it("read a mode and a close reason code this build does not know, and a plan of one unit", () => {
```

заменить на

<!-- prettier-ignore -->
```ts
        true,
      );
    }
  });

  it("read a shift with pallets: their capacity and their template", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const pallets = {
      ...shift,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    };
    expect(officeShiftSchema.parse(pallets)).toEqual(pallets);
  });

  it("read a mode and a close reason code this build does not know, and a plan of one unit", () => {
```

15. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      mode: ["boxes", null],
      palletsEnabled: ["no", null],
    };
    for (const [field, values] of Object.entries(refusedCreate)) {
```

заменить на

<!-- prettier-ignore -->
```ts
      mode: ["boxes", null],
      palletsEnabled: ["no", null],
      palletBoxCapacity: [0, -1, 1.5, "40", null],
      palletTemplateId: ["42", null],
    };
    for (const [field, values] of Object.entries(refusedCreate)) {
```

16. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
      mode: ["boxes"],
      palletsEnabled: ["no"],
      expectedRev: [1.5, "71", null],
    };
```

заменить на

<!-- prettier-ignore -->
```ts
      mode: ["boxes"],
      palletsEnabled: ["no"],
      palletBoxCapacity: [0, -1, 1.5, "40", null],
      palletTemplateId: ["42", null],
      expectedRev: [1.5, "71", null],
    };
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL — `18 passed; 12 failed`: семь новых тестов и пять прежних, которые сверяют запись смены целиком (`an_administrator_plans_a_shift_and_reads_it_back`, `a_planned_shift_changes_what_is_sent_and_keeps_its_number`, `a_planned_shifts_template_change_is_stored_read_back_and_audited`) или ждут отказа на `palletTemplateId` (`a_plan_needs_an_active_product_an_active_line_and_a_fitting_template`, `an_edit_checks_a_changed_line_template_or_counterparty_and_keeps_unchanged_ones`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — ошибки сборки `no field pallet_box_capacity on type OfficeShift` и `… on type ShiftCreate`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — `Tests  4 failed | 207 passed (211)`: `response fixture office-shift.json > parses without losing a field`, `request fixture shift-create-pallets.json > parses without losing a field`, `shift shapes > read a shift with pallets: their capacity and their template` и `shift shapes > refuse an unknown status, …`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/migrations/0012_pallets.sql`:

<!-- prettier-ignore -->
```sql
-- Pallets (plan ПЛ-Х, pilot spec §6): a station's pallet fills itself with
-- the boxes it closes and closes with an SSCC of a pallet block (extension
-- 1). The host learns a pallet from the facts: the first closed box that
-- names it opens it, its `pallet_closed` closes it (or opens it closed, when
-- none of its boxes reached the host). Which boxes a pallet holds is derived
-- (`boxes.pallet_id`), never stored; the count the station reported is kept
-- beside it as evidence. As in `0010`, every value is checked before it is
-- written; the CHECKs hold what no row may break.

-- A pallet of one device in one shift. One open pallet per station and
-- shift is the station's rule, not a constraint here: a host that refused a
-- second one would fail a batch the station can never get past.
CREATE TABLE pallets (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  box_count_reported INTEGER CHECK (box_count_reported IS NULL OR box_count_reported > 0),
  operator_id TEXT,
  print_verified_at TEXT,
  print_skipped_at TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (box_count_reported IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL),
  CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc GLOB '1*'))
);
CREATE UNIQUE INDEX pallets_sscc ON pallets (sscc) WHERE sscc IS NOT NULL;
-- One serial of a pallet block is one label, whatever the check digit says.
CREATE UNIQUE INDEX pallets_block_serial ON pallets (block_id, serial)
  WHERE block_id IS NOT NULL AND serial IS NOT NULL;
CREATE INDEX pallets_shift ON pallets (shift_id);

-- A box joins a pallet when it closes. The link stays when the box or the
-- pallet is taken apart, as in the cloud; a pallet's boxes leave out those
-- taken apart.
ALTER TABLE boxes ADD COLUMN pallet_id TEXT REFERENCES pallets (id)
  CHECK (pallet_id IS NULL OR closed_at IS NOT NULL);
CREATE INDEX boxes_pallet ON boxes (pallet_id) WHERE pallet_id IS NOT NULL;

-- Pallet exceptions: its label printed again, or the pallet taken apart,
-- with a reason code of the box exceptions' lists.
CREATE TABLE pallet_exceptions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reprint', 'disassemble')),
  pallet_id TEXT NOT NULL REFERENCES pallets (id),
  reason_code TEXT NOT NULL,
  reason_text TEXT,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK (reason_text IS NULL OR reason_code = 'other')
);
CREATE UNIQUE INDEX pallet_exceptions_record ON pallet_exceptions (device_id, record_id);
CREATE INDEX pallet_exceptions_pallet ON pallet_exceptions (pallet_id);

-- A shift with pallets names their box capacity and their label template,
-- a shift without names neither. `0009` cannot take a new CHECK without
-- rebuilding its table, so two triggers hold the rule.
CREATE TRIGGER shifts_pallets_insert BEFORE INSERT ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
  OR (NEW.pallets_enabled = 1) <> (NEW.pallet_template_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'shift pallets: capacity and template exactly when enabled');
END;
CREATE TRIGGER shifts_pallets_update
BEFORE UPDATE OF pallets_enabled, pallet_box_capacity, pallet_template_id ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
  OR (NEW.pallets_enabled = 1) <> (NEW.pallet_template_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'shift pallets: capacity and template exactly when enabled');
END;
-- A planned shift prints its pallets with this template once a station
-- opens it, so the template is not deleted meanwhile (`template_in_use`).
CREATE INDEX shifts_planned_pallet_template ON shifts (pallet_template_id)
  WHERE status = 'planned';
```

2. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// What a new shift's product gives it: the product group its box template
/// must cover, and the box capacity a shift takes when it names none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftProduct {
    pub group: u32,
    pub box_capacity: u32,
}

```

заменить на

<!-- prettier-ignore -->
```rust
}

/// What a new shift's product gives it: the product group its templates
/// must cover, and the capacities a shift takes when it names none (an
/// active product has both).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftProduct {
    pub group: u32,
    pub box_capacity: u32,
    pub pallet_box_capacity: u32,
}

```

3. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    id: &str,
) -> Result<ShiftProduct, ApiError> {
    let row: Option<(String, bool, Option<u32>, Option<u32>)> = sqlx::query_as(
        "SELECT status, archived, chz_group_code, box_capacity FROM products WHERE id = ?",
    )
    .bind(id)
```

заменить на

<!-- prettier-ignore -->
```rust
    id: &str,
) -> Result<ShiftProduct, ApiError> {
    type ProductRow = (String, bool, Option<u32>, Option<u32>, Option<u32>);
    let row: Option<ProductRow> = sqlx::query_as(
        "SELECT status, archived, chz_group_code, box_capacity, pallet_box_capacity \
         FROM products WHERE id = ?",
    )
    .bind(id)
```

4. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .await
    .map_err(ApiError::internal)?;
    let (status, archived, group, box_capacity) =
        row.ok_or_else(|| ApiError::validation("productId", "no such product"))?;
    match (
```

заменить на

<!-- prettier-ignore -->
```rust
    .await
    .map_err(ApiError::internal)?;
    let (status, archived, group, box_capacity, pallet_box_capacity) =
        row.ok_or_else(|| ApiError::validation("productId", "no such product"))?;
    match (
```

5. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        group,
        box_capacity,
    ) {
        (Ok(ProductStatus::Active), false, Some(group), Some(box_capacity)) => Ok(ShiftProduct {
            group,
            box_capacity,
        }),
        _ => Err(product_inactive()),
```

заменить на

<!-- prettier-ignore -->
```rust
        group,
        box_capacity,
        pallet_box_capacity,
    ) {
        (
            Ok(ProductStatus::Active),
            false,
            Some(group),
            Some(box_capacity),
            Some(pallet_box_capacity),
        ) => Ok(ShiftProduct {
            group,
            box_capacity,
            pallet_box_capacity,
        }),
        _ => Err(product_inactive()),
```

6. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// A new shift after the request's own checks and the references' checks.
pub struct NewShift<'a> {
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// `validation_failed` on `palletTemplateId` unless `id` names a pallet
/// template that fits a product of `group` (`templates::fits`: enabled, of
/// the pallet purpose, covering the group).
pub async fn check_pallet_template(
    conn: &mut SqliteConnection,
    id: &str,
    group: u32,
) -> Result<(), ApiError> {
    templates::check_slot(
        conn,
        "palletTemplateId",
        id,
        TemplatePurpose::Pallet,
        Some(group),
    )
    .await
}

/// A shift's pallets: how many boxes a pallet holds and the pallet label
/// template. A shift without pallets has none of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pallets {
    pub box_capacity: u32,
    pub template_id: String,
}

/// What a request to plan or create a shift asks of pallets, after its own
/// checks: nothing, or pallets with a template and perhaps a capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PalletRequest<'a> {
    Off,
    On {
        box_capacity: Option<u32>,
        template_id: &'a str,
    },
}

/// The pallet fields of a new shift on their own: a shift without pallets
/// sends neither (`validation_failed` on the one it sends), a shift with
/// pallets needs its template (`validation_failed` on `palletTemplateId`),
/// and a capacity is 1 to `MAX_PALLET_BOX_CAPACITY`.
pub fn pallet_request<'a>(
    enabled: bool,
    box_capacity: Option<u32>,
    template_id: Option<&'a str>,
) -> Result<PalletRequest<'a>, ApiError> {
    crate::validate::count(
        "palletBoxCapacity",
        box_capacity,
        crate::validate::MAX_PALLET_BOX_CAPACITY,
    )?;
    match (enabled, box_capacity, template_id) {
        (false, Some(_), _) => Err(ApiError::validation(
            "palletBoxCapacity",
            "only a shift with pallets has a pallet capacity",
        )),
        (false, None, Some(_)) => Err(ApiError::validation(
            "palletTemplateId",
            "only a shift with pallets has a pallet template",
        )),
        (false, None, None) => Ok(PalletRequest::Off),
        (true, _, None) => Err(ApiError::validation(
            "palletTemplateId",
            "a shift with pallets needs a pallet template",
        )),
        (true, box_capacity, Some(template_id)) => Ok(PalletRequest::On {
            box_capacity,
            template_id,
        }),
    }
}

/// The pallets a new shift of `product` gets: its pallet template fits the
/// product's group, and its capacity is the product's when the request names
/// none.
pub async fn pallets(
    conn: &mut SqliteConnection,
    request: PalletRequest<'_>,
    product: &ShiftProduct,
) -> Result<Option<Pallets>, ApiError> {
    match request {
        PalletRequest::Off => Ok(None),
        PalletRequest::On {
            box_capacity,
            template_id,
        } => {
            check_pallet_template(conn, template_id, product.group).await?;
            Ok(Some(Pallets {
                box_capacity: box_capacity.unwrap_or(product.pallet_box_capacity),
                template_id: template_id.to_owned(),
            }))
        }
    }
}

/// A new shift after the request's own checks and the references' checks.
pub struct NewShift<'a> {
```

7. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: &'a str,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: &'a str,
    pub pallets: Option<Pallets>,
}

```

8. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
         created_by, create_request_id, status, mode, pallets_enabled, product_id, line_id, \
         counterparty_id, production_date, planned_qty, box_capacity, box_template_id, \
         created_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
```

заменить на

<!-- prettier-ignore -->
```rust
         created_by, create_request_id, status, mode, pallets_enabled, product_id, line_id, \
         counterparty_id, production_date, planned_qty, box_capacity, box_template_id, \
         pallet_box_capacity, pallet_template_id, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
```

9. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(ShiftStatus::Planned.as_str())
    .bind(ShiftMode::Aggregation.as_str())
    .bind(shift.product_id)
    .bind(shift.line_id)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(ShiftStatus::Planned.as_str())
    .bind(ShiftMode::Aggregation.as_str())
    .bind(shift.pallets.is_some())
    .bind(shift.product_id)
    .bind(shift.line_id)
```

10. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(shift.box_capacity)
    .bind(shift.box_template_id)
    .bind(at)
    .bind(rev)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(shift.box_capacity)
    .bind(shift.box_template_id)
    .bind(shift.pallets.as_ref().map(|pallets| pallets.box_capacity))
    .bind(
        shift
            .pallets
            .as_ref()
            .map(|pallets| pallets.template_id.as_str()),
    )
    .bind(at)
    .bind(rev)
```

11. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, owner_device_id, opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev, \
     (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
```

заменить на

<!-- prettier-ignore -->
```rust
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, pallet_box_capacity, pallet_template_id, owner_device_id, \
     opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev, \
     (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
```

12. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
```

заменить на

<!-- prettier-ignore -->
```rust
    box_capacity: u32,
    box_template_id: String,
    pallet_box_capacity: Option<u32>,
    pallet_template_id: Option<String>,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
```

13. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
```

заменить на

<!-- prettier-ignore -->
```rust
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        pallet_box_capacity: row.pallet_box_capacity,
        pallet_template_id: row.pallet_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
```

14. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// Stage 2a takes only aggregation without pallets (spec decision 6): the
/// fields are there so stages 2b and 3 need no new shape.
pub fn check_mode(mode: ShiftMode, pallets_enabled: bool) -> Result<(), ApiError> {
    if mode != ShiftMode::Aggregation {
        return Err(ApiError::validation(
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// Only aggregation is taken (spec decision 6), with or without pallets
/// (plan ПЛ-Х): validation (stage 3) needs no new shape.
pub fn check_mode(mode: ShiftMode) -> Result<(), ApiError> {
    if mode != ShiftMode::Aggregation {
        return Err(ApiError::validation(
```

15. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
        ));
    }
    Ok(())
}

/// `POST /v1/office/shifts`: a planned shift of an active product on an
/// active line, with a box template that fits the product, and with pallets
/// a pallet template that fits it too (`shifts::pallet_request`).
pub async fn create_shift(
    State(state): State<AppState>,
```

16. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(create.mode, create.pallets_enabled)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
```

заменить на

<!-- prettier-ignore -->
```rust
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(create.mode)?;
    let pallet_request = shifts::pallet_request(
        create.pallets_enabled,
        create.pallet_box_capacity,
        create.pallet_template_id.as_deref(),
    )?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
```

17. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let pallets = shifts::pallets(&mut tx, pallet_request, &product).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
```

18. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
        },
        &at,
```

заменить на

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets,
        },
        &at,
```

19. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// template or a counterparty that changes is checked as at planning; one that
/// stays is kept even if it was archived, disabled or narrowed since (the
/// station's open then refuses the template: `template_not_fit`).
pub async fn update_shift(
    State(state): State<AppState>,
```

заменить на

<!-- prettier-ignore -->
```rust
/// template or a counterparty that changes is checked as at planning; one that
/// stays is kept even if it was archived, disabled or narrowed since (the
/// station's open then refuses the template: `template_not_fit`). Pallets
/// turned on need a pallet template and take the product's capacity unless
/// the edit names one; turned off, the shift keeps neither.
pub async fn update_shift(
    State(state): State<AppState>,
```

20. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(
        update.mode.unwrap_or_default(),
        update.pallets_enabled.unwrap_or(false),
    )?;
    let production_date = update
```

заменить на

<!-- prettier-ignore -->
```rust
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(update.mode.unwrap_or_default())?;
    validate::count(
        "palletBoxCapacity",
        update.pallet_box_capacity,
        validate::MAX_PALLET_BOX_CAPACITY,
    )?;
    let production_date = update
```

21. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
        .clone()
        .unwrap_or_else(|| current.counterparty_id.clone());
    // Pallets that stay on keep what the edit does not send; turned off, the
    // edit sends neither field.
    let pallets_enabled = update.pallets_enabled.unwrap_or(current.pallets_enabled);
    let pallet_request = if pallets_enabled {
        shifts::pallet_request(
            true,
            update.pallet_box_capacity.or(current.pallet_box_capacity),
            update
                .pallet_template_id
                .as_deref()
                .or(current.pallet_template_id.as_deref()),
        )?
    } else {
        shifts::pallet_request(
            false,
            update.pallet_box_capacity,
            update.pallet_template_id.as_deref(),
        )?
    };
    let (mut pallet_box_capacity, pallet_template_id) = match pallet_request {
        shifts::PalletRequest::Off => (None, None),
        shifts::PalletRequest::On {
            box_capacity,
            template_id,
        } => (box_capacity, Some(template_id.to_owned())),
    };
    let fixed_changed = line_id != current.line_id
        || production_date != current.production_date
        || box_template_id != current.box_template_id
        || box_capacity != current.box_capacity
        || counterparty_id != current.counterparty_id
        || pallets_enabled != current.pallets_enabled
        || pallet_box_capacity != current.pallet_box_capacity
        || pallet_template_id != current.pallet_template_id;
    match current.status {
        ShiftStatus::Planned => {
            // A changed pallet template is checked; pallets just turned on
            // (the only way to have a template and no capacity yet) take the
            // product's capacity.
            if let Some(template_id) = &pallet_template_id {
                if pallet_template_id != current.pallet_template_id {
                    let product = shifts::shift_product(&mut tx, &current.product_id).await?;
                    shifts::check_pallet_template(&mut tx, template_id, product.group).await?;
                    pallet_box_capacity.get_or_insert(product.pallet_box_capacity);
                }
            }
            if line_id != current.line_id {
                require_active_line(&mut tx, &line_id).await?;
```

22. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            json!(counterparty_id),
        ),
    ]) else {
        // Nothing actually changed: report the shift as-is without bumping
```

заменить на

<!-- prettier-ignore -->
```rust
            json!(counterparty_id),
        ),
        (
            "palletsEnabled",
            json!(current.pallets_enabled),
            json!(pallets_enabled),
        ),
        (
            "palletBoxCapacity",
            json!(current.pallet_box_capacity),
            json!(pallet_box_capacity),
        ),
        (
            "palletTemplateId",
            json!(current.pallet_template_id),
            json!(pallet_template_id),
        ),
    ]) else {
        // Nothing actually changed: report the shift as-is without bumping
```

23. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    sqlx::query(
        "UPDATE shifts SET line_id = ?, production_date = ?, box_template_id = ?, \
         box_capacity = ?, planned_qty = ?, counterparty_id = ?, rev = ? WHERE id = ?",
    )
    .bind(&line_id)
```

заменить на

<!-- prettier-ignore -->
```rust
    sqlx::query(
        "UPDATE shifts SET line_id = ?, production_date = ?, box_template_id = ?, \
         box_capacity = ?, planned_qty = ?, counterparty_id = ?, pallets_enabled = ?, \
         pallet_box_capacity = ?, pallet_template_id = ?, rev = ? WHERE id = ?",
    )
    .bind(&line_id)
```

24. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(planned_qty)
    .bind(&counterparty_id)
    .bind(rev)
    .bind(&id)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(planned_qty)
    .bind(&counterparty_id)
    .bind(pallets_enabled)
    .bind(pallet_box_capacity)
    .bind(&pallet_template_id)
    .bind(rev)
    .bind(&id)
```

25. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
        },
        &at,
```

заменить на

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets: None,
        },
        &at,
```

26. В `apps/standalone/host/src/routes/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    // A planned shift prints with this template once a station opens it;
    // an open or closed shift has the layout in its snapshot.
    let planned: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM shifts WHERE box_template_id = ? AND status = 'planned' ORDER BY id",
    )
    .bind(&id)
```

заменить на

<!-- prettier-ignore -->
```rust
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    // A planned shift prints its boxes or its pallets with this template once
    // a station opens it; an open or closed shift has the layout in its
    // snapshot.
    let planned: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM shifts WHERE (box_template_id = ?1 OR pallet_template_id = ?1) \
         AND status = 'planned' ORDER BY id",
    )
    .bind(&id)
```

27. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: String,
    /// The station that opened the shift; `null` while it is planned.
    pub owner_device_id: Option<String>,
```

заменить на

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: String,
    /// How many boxes a pallet holds and the pallet label template: both set
    /// exactly when `palletsEnabled` (plan ПЛ-Х), `null` otherwise.
    pub pallet_box_capacity: Option<u32>,
    pub pallet_template_id: Option<String>,
    /// The station that opened the shift; `null` while it is planned.
    pub owner_device_id: Option<String>,
```

28. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
/// product's; `mode` left out is aggregation and `palletsEnabled` false,
/// the only values stage 2a takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

заменить на

<!-- prettier-ignore -->
```rust

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
/// product's; `mode` left out is aggregation (the only mode taken) and
/// `palletsEnabled` false. A shift with pallets names its pallet template
/// and may name its pallet capacity (the product's when left out); one
/// without sends neither.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

29. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub pallets_enabled: bool,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub pallets_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
}

```

30. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// with another value is `conflict` on `shift_status`); a closed one
/// nothing. `plannedQty: null` and `counterpartyId: null` clear them; `null`
/// in another field reads as «not sent» (see [`LineUpdate`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

заменить на

<!-- prettier-ignore -->
```rust
/// with another value is `conflict` on `shift_status`); a closed one
/// nothing. `plannedQty: null` and `counterpartyId: null` clear them; `null`
/// in another field reads as «not sent» (see [`LineUpdate`]). Pallets turned
/// off clear the pallet capacity and template (sending either then is
/// `validation_failed`); turned on, they need a template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

31. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallets_enabled: Option<bool>,
    pub expected_rev: i64,
}
```

заменить на

<!-- prettier-ignore -->
```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallets_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    pub expected_rev: i64,
}
```

32. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * from its own lists. `closeReasonCode` is one of the domain's six codes of a
 * station's close (plan 2a2), read as text so a code a newer host adds does
 * not fail the list; `closeReasonText` is the office's words.
 */
export const officeShiftSchema = z.object({
```

заменить на

<!-- prettier-ignore -->
```ts
 * from its own lists. `closeReasonCode` is one of the domain's six codes of a
 * station's close (plan 2a2), read as text so a code a newer host adds does
 * not fail the list; `closeReasonText` is the office's words. The pallet
 * capacity and template are set exactly when `palletsEnabled` (plan ПЛ-Х).
 */
export const officeShiftSchema = z.object({
```

33. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
```

заменить на

<!-- prettier-ignore -->
```ts
  boxCapacity: z.number().int().positive(),
  boxTemplateId: z.uuid(),
  palletBoxCapacity: z.number().int().positive().nullable(),
  palletTemplateId: z.uuid().nullable(),
  ownerDeviceId: z.uuid().nullable(),
  openedAt: z.iso.datetime().nullable(),
```

34. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * `POST /v1/office/shifts`: a planned shift. The office always sends the box
 * capacity, `null` for no plan or no counterparty, and `mode` and
 * `palletsEnabled` as the only values stage 2a takes.
 */
export const shiftCreateSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
 * `POST /v1/office/shifts`: a planned shift. The office always sends the box
 * capacity, `null` for no plan or no counterparty, and `mode` and
 * `palletsEnabled`. A shift with pallets names its pallet template and may
 * name its pallet capacity (the product's when left out); one without sends
 * neither (plan ПЛ-Х).
 */
export const shiftCreateSchema = z
```

35. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
  })
  .strict();
```

заменить на

<!-- prettier-ignore -->
```ts
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
  })
  .strict();
```

36. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
 * revision. `plannedQty: null` and `counterpartyId: null` clear them; every
 * other field is left out or a value, never `null`, which the host would read
 * as «keep». The product never changes, so it is no field.
 */
export const shiftUpdateSchema = z
```

заменить на

<!-- prettier-ignore -->
```ts
 * revision. `plannedQty: null` and `counterpartyId: null` clear them; every
 * other field is left out or a value, never `null`, which the host would read
 * as «keep». The product never changes, so it is no field. Pallets turned
 * off clear their capacity and template, which the edit then does not send.
 */
export const shiftUpdateSchema = z
```

37. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    expectedRev: z.number().int(),
  })
```

заменить на

<!-- prettier-ignore -->
```ts
    mode: shiftModeSchema.optional(),
    palletsEnabled: z.boolean().optional(),
    palletBoxCapacity: z.number().int().positive().optional(),
    palletTemplateId: z.uuid().optional(),
    expectedRev: z.number().int(),
  })
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --test device_shifts --test templates --test facts --test sscc_blocks --offline --locked`
Expected: PASS — `device_shifts` 17, `facts` 36, `office_shifts` 30, `sscc_blocks` 13, `templates` 27.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 43.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS — `Tests  211 passed (211)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: без ошибок (`OfficeShift` из `test/support/shifts.ts` называет оба новых поля).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
the box purpose, covering the product's group), the production date, a box
capacity (the product's when left out; at most `MAX_BOX_CAPACITY`) and a plan
or none (at most `MAX_PLANNED_QTY`, 10 000 000). `mode` and `palletsEnabled`
are the cloud's shape; stage 2a takes only `aggregation` and `false`
(`validation_failed` on either otherwise), so stages 2b and 3 need no new
shape. Every office role reads shifts (`GET /v1/office/shifts`, `GET …/{id}`);
administrators and technologists write them (`planShifts`, «Writes»). The
list without a period holds every planned and active shift and the closed
```

заменить на

<!-- prettier-ignore -->
```text
the box purpose, covering the product's group), the production date, a box
capacity (the product's when left out; at most `MAX_BOX_CAPACITY`) and a plan
or none (at most `MAX_PLANNED_QTY`, 10 000 000). `mode` is the cloud's shape;
only `aggregation` is taken (`validation_failed` on `mode` otherwise), so
stage 3 needs no new shape. A shift with pallets (`palletsEnabled`, plan
ПЛ-Х, migration `0012_pallets.sql`) names a pallet template that fits the
product (`templates::fits` for the pallet purpose; `validation_failed` on
`palletTemplateId` otherwise, a missing one included) and a pallet capacity of
1–`MAX_PALLET_BOX_CAPACITY` (10 000; the product's when left out); a shift
without pallets sends neither field (`validation_failed` on the one it
sends). `OfficeShift` names `palletBoxCapacity` and `palletTemplateId`
exactly when `palletsEnabled`, which two triggers of `0012` hold in the
table. Every office role reads shifts (`GET /v1/office/shifts`, `GET …/{id}`);
administrators and technologists write them (`planShifts`, «Writes»). The
list without a period holds every planned and active shift and the closed
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
disabled or narrowed since, and the station's opening refuses it then
(`template_not_fit`). `plannedQty: null` and `counterpartyId: null` clear
them. Only a planned shift is deleted (`DELETE …/{id}`, 204; an open or a
closed one is `shift_status`); the delete takes a revision with no row left to
stamp, and a delete repeated after a lost answer is `not_found`. A template a
planned shift names is not deleted (`conflict` on `template_in_use`, with
`details.shiftIds`), since the shift prints with it once a station opens it;
an open or closed shift has the layout in its snapshot. Disabling or narrowing
such a template is not refused: the shift then does not open, and the office
```

заменить на

<!-- prettier-ignore -->
```text
disabled or narrowed since, and the station's opening refuses it then
(`template_not_fit`). `plannedQty: null` and `counterpartyId: null` clear
them. A planned shift turns pallets on (with a pallet template; the
product's capacity unless the edit names one) or off, which clears the
capacity and the template (sending either then is `validation_failed`);
pallets that stay on keep what the edit does not send, a pallet template
disabled since included, and a changed template is checked. An open shift
keeps its pallets (`shift_status`). Only a planned shift is deleted
(`DELETE …/{id}`, 204; an open or a closed one is `shift_status`); the delete
takes a revision with no row left to
stamp, and a delete repeated after a lost answer is `not_found`. A template a
planned shift names, for its boxes or its pallets, is not deleted (`conflict`
on `template_in_use`, with `details.shiftIds`), since the shift prints with it
once a station opens it;
an open or closed shift has the layout in its snapshot. Disabling or narrowing
such a template is not refused: the shift then does not open, and the office
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
or a station as the device; target `shift`, details `{ number, productId,
lineId, productionDate }`), `shift.update` (an office user; the update details
of `lineId`, `productionDate`, `boxTemplateId`, `boxCapacity`, `plannedQty`
and `counterpartyId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`), `shift.close` (an office user; `{ reason }`) and
```

заменить на

<!-- prettier-ignore -->
```text
or a station as the device; target `shift`, details `{ number, productId,
lineId, productionDate }`), `shift.update` (an office user; the update details
of `lineId`, `productionDate`, `boxTemplateId`, `boxCapacity`, `plannedQty`,
`counterpartyId`, `palletsEnabled`, `palletBoxCapacity` and
`palletTemplateId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`), `shift.close` (an office user; `{ reason }`) and
```

- [ ] **Step 6: Мутации**

М1 — правка без шаблона забывает хранимый. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
                .as_deref()
                .or(current.pallet_template_id.as_deref()),
```

заменить на

<!-- prettier-ignore -->
```rust
                .as_deref(),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off`, `an_active_shift_keeps_its_pallets`, `an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — неизменённый шаблон проверяется снова. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
                if pallet_template_id != current.pallet_template_id {
                    let product
```

заменить на

<!-- prettier-ignore -->
```rust
                if true {
                    let product
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — включённые паллеты без вместимости товара. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
                    pallet_box_capacity.get_or_insert(product.pallet_box_capacity);
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — шаблон паллеты открытой смены меняется. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        || pallet_template_id != current.pallet_template_id;
```

заменить на

<!-- prettier-ignore -->
```rust
;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `an_active_shift_keeps_its_pallets`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — вместимость без паллет принимается. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (false, Some(_), _) => Err(ApiError::validation(
            "palletBoxCapacity",
            "only a shift with pallets has a pallet capacity",
        )),
```

заменить на

<!-- prettier-ignore -->
```rust
        (false, Some(_), _) => Ok(PalletRequest::Off),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_plan_with_pallets_needs_a_fitting_pallet_template_and_one_without_sends_neither`, `an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — названная вместимость не хранится. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
box_capacity: box_capacity.unwrap_or(product.pallet_box_capacity),
```

заменить на

<!-- prettier-ignore -->
```rust
box_capacity: product.pallet_box_capacity,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_shift_with_pallets_takes_its_template_and_the_products_capacity`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — шаблон паллеты проверяется как шаблон короба. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        TemplatePurpose::Pallet,
        Some(group),
```

заменить на

<!-- prettier-ignore -->
```rust
        TemplatePurpose::Box,
        Some(group),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_pallet_template_a_planned_shift_names_is_not_deleted`, `a_plan_with_pallets_needs_a_fitting_pallet_template_and_one_without_sends_neither`, `a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off` и ещё четыре теста набора. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — удаление шаблона паллеты не видит запланированной смены. В `apps/standalone/host/src/routes/templates.rs` фрагмент

<!-- prettier-ignore -->
```rust
(box_template_id = ?1 OR pallet_template_id = ?1)
```

заменить на

<!-- prettier-ignore -->
```rust
(box_template_id = ?1)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_pallet_template_a_planned_shift_names_is_not_deleted`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — признак паллет не пишется. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(shift.pallets.is_some())
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(false)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_pallet_template_a_planned_shift_names_is_not_deleted`, `a_shift_with_pallets_takes_its_template_and_the_products_capacity`, `an_active_shift_keeps_its_pallets` и ещё два теста набора. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — триггер правки не держит шаблон. В `apps/standalone/host/migrations/0012_pallets.sql` фрагмент

<!-- prettier-ignore -->
```sql
BEFORE UPDATE OF pallets_enabled, pallet_box_capacity, pallet_template_id ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
  OR (NEW.pallets_enabled = 1) <> (NEW.pallet_template_id IS NOT NULL)
```

заменить на

<!-- prettier-ignore -->
```sql
BEFORE UPDATE OF pallets_enabled, pallet_box_capacity, pallet_template_id ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `the_schema_keeps_a_shifts_pallet_fields_together`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — шаблон паллеты не в журнале правки. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        (
            "palletTemplateId",
            json!(current.pallet_template_id),
            json!(pallet_template_id),
        ),
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off`. Восстановить файл, `cmp` молчит, хеш прежний.

М12 — вместимость проверяется после поиска смены. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    check_mode(update.mode.unwrap_or_default())?;
    validate::count(
        "palletBoxCapacity",
        update.pallet_box_capacity,
        validate::MAX_PALLET_BOX_CAPACITY,
    )?;
```

заменить на

<!-- prettier-ignore -->
```rust
    check_mode(update.mode.unwrap_or_default())?;
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --offline --locked`
Expected: FAIL `an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes`. Восстановить файл, `cmp` молчит, хеш прежний.

М13 (Zod) — вместимость паллеты в ответе любая. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
  palletBoxCapacity: z.number().int().positive().nullable(),
```

заменить на

<!-- prettier-ignore -->
```ts
  palletBoxCapacity: z.number().nullable(),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL `shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive whole number and a date of another form`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/office-shift.json apps/standalone/proto/fixtures/shift-create-pallets.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/shifts.ts`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/migrations/0012_pallets.sql apps/standalone/host/src/shifts.rs apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/templates.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-shift.json apps/standalone/proto/fixtures/shift-create-pallets.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/shifts.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): a shift with pallets names its pallet template and capacity, planned and edited in the office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Станция и смена с паллетами — создание, вход со снимком шаблона паллеты, блоки SSCC паллет

Станция получает то, что нужно для начала смены с паллетами. Создание на станции следует тем же правилам полей паллет, что офис. Вход замораживает шаблон паллеты в снимке (`palletTemplate`); если шаблон к этому времени выключен или сужен, смена остаётся запланированной (`pallet_template_not_fit`). `DeviceShift` называет вместимость и шаблон паллеты только у смены с паллетами, поэтому ответы для смены без паллет не меняются. Блок SSCC паллет — расширение 1 размером `site.pallet_block_size`; повтор `requestId` с другим расширением отвергается, как с другим префиксом.

**Files:**

- Create: `apps/standalone/proto/fixtures/device-shift-create-pallets.json`, `apps/standalone/proto/fixtures/device-shift-entered-pallets.json`
- Modify: `apps/standalone/host/src/shifts.rs` (`pallet_template_not_fit`, `frozen_template`, `snapshot`), `apps/standalone/host/src/routes/device_shifts.rs`, `apps/standalone/host/src/routes/sscc_blocks.rs`, `apps/standalone/proto/src/lib.rs` (`DeviceShift`, `ShiftSnapshot.pallet_template`, `DeviceShiftCreate`)
- Test: `apps/standalone/host/tests/device_shifts.rs`, `apps/standalone/host/tests/sscc_blocks.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Shifts»)

**Interfaces:**

- Consumes: `shifts::{pallet_request, pallets}` (задача 2), `office_template`, `pallet_template`, `pallet_shift_body` (задача 2).
- Produces: `shifts::snapshot(conn, product_id, template_id, pallet_template_id: Option<&str>, counterparty_id)`, `shifts::pallet_template_not_fit()`; `DeviceShift.{pallet_box_capacity, pallet_template_id}: Option<…>` (в JSON только у смены с паллетами); `ShiftSnapshot.pallet_template: Option<ShiftSnapshotTemplate>` (`palletTemplate`, только у смены с паллетами); `DeviceShiftCreate.{pallets_enabled: bool, pallet_box_capacity: Option<u32>, pallet_template_id: Option<String>}`; блоки `extension: 1`.

- [ ] **Step 1: Тесты (падающие) и фикстуры**

1. В `apps/standalone/host/tests/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    plan_shift, request, shift_body, shift_setup, with_device, Admin, AuditRow, ShiftSetup, LAN,
};

```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, office_template,
    pair_device, pallet_shift_body, pallet_template, plan_shift, request, shift_body, shift_setup,
    with_device, Admin, AuditRow, ShiftSetup, LAN,
};

```

2. В `apps/standalone/host/tests/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "{body}"
        );
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust
            "{body}"
        );
    }
}

/// A station creates a shift with pallets under the office's rules and
/// enters it: the snapshot freezes the pallet template with its layout,
/// the opening's audit row names it, and the station's list names the
/// pallet capacity and template only for a shift with pallets.
#[tokio::test]
async fn a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let mut create = device_create(&setup, REQUEST);
    create["palletsEnabled"] = json!(true);
    create["palletTemplateId"] = json!(pallet);
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(create),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut expected = device_shift(&id, "OCT26-001/S", &setup);
    expected["createdFrom"] = json!("station");
    expected["productionDate"] = json!("2026-10-09");
    expected["palletsEnabled"] = json!(true);
    expected["palletBoxCapacity"] = json!(40);
    expected["palletTemplateId"] = json!(pallet);
    assert_eq!(created, expected);
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let opened_at = admin.app.state.timestamp();
    let (status, entered) = enter(&admin, &admin.key, &created).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // The wizard, the box template and the product took revisions 1 to 3,
    // the pallet template 4.
    let pallet_snapshot = json!({
        "id": pallet, "name": "Паллета 100×150", "rev": 4,
        "spec": { "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": [] }
    });
    assert_eq!(entered["snapshot"]["palletTemplate"], pallet_snapshot);
    assert_eq!(entered["palletBoxCapacity"], json!(40));
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            &id,
            json!({
                "number": "OCT26-001/S", "templateId": setup.template, "templateRev": 2,
                "palletTemplateId": pallet, "palletTemplateRev": 4
            })
        )]
    );
    assert_eq!(entered["openedAt"], json!(opened_at));
    // The list names the pallet fields of the shift with pallets only.
    let (status, list) = device_call(&admin, &admin.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let shifts = list["shifts"].as_array().unwrap();
    let listed = |id: &Value| {
        shifts
            .iter()
            .find(|shift| shift["id"] == *id)
            .cloned()
            .unwrap()
    };
    let mut with_pallets = entered.clone();
    with_pallets.as_object_mut().unwrap().remove("snapshot");
    assert_eq!(listed(&created["id"]), with_pallets);
    let plain_listed = listed(&plain["id"]);
    for key in ["palletBoxCapacity", "palletTemplateId"] {
        assert!(
            !plain_listed.as_object().unwrap().contains_key(key),
            "{key}"
        );
    }
    // The pallet template changes; the shift keeps the layout it froze.
    let (status, changed) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{pallet}"),
            Some(json!({ "spec": { "widthMm": 120 }, "expectedRev": 4 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let (status, again) = enter(&admin, &admin.key, &created).await;
    assert_eq!(
        (status, again["snapshot"]["palletTemplate"].clone()),
        (StatusCode::OK, pallet_snapshot)
    );
    // A shift without pallets freezes no pallet template.
    let (status, plain_entered) = enter(&admin, &admin.key, &plain).await;
    assert_eq!(status, StatusCode::OK, "{plain_entered}");
    assert!(!plain_entered["snapshot"]
        .as_object()
        .unwrap()
        .contains_key("palletTemplate"));
}

/// A station's create follows the office's pallet rules: a template that
/// fits, and no pallet field without pallets. A refusal writes nothing.
#[tokio::test]
async fn a_station_create_follows_the_pallet_rules() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    for (change, expected) in [
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 0 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletBoxCapacity": 40 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = device_create(&setup, REQUEST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        assert_eq!(
            (
                status,
                (
                    refused["error"]["code"].clone(),
                    refused["error"]["details"].clone()
                )
            ),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// A pallet template disabled or narrowed after the plan keeps the shift
/// from opening (`pallet_template_not_fit`): nothing is frozen or written,
/// and once it fits again the shift opens.
#[tokio::test]
async fn a_pallet_template_that_no_longer_fits_keeps_the_shift_planned() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let template = format!("/v1/office/templates/{pallet}");
    for change in [
        json!({ "enabled": false }),
        json!({ "chzProductGroupCodes": [15] }),
    ] {
        let (_, current) = admin.call("GET", &template, None).await;
        let mut body = change.clone();
        body["expectedRev"] = current["rev"].clone();
        let (status, narrowed) = admin.call("PUT", &template, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{narrowed}");
        let rows = audit_rows(&admin.app).await;
        let revision = host_revision(&admin.app).await;
        let (status, refused) = enter(&admin, &admin.key, &shift).await;
        assert_eq!(
            (status, refused["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "pallet_template_not_fit" })
            ),
            "{change}"
        );
        assert_eq!(audit_rows(&admin.app).await, rows);
        assert_eq!(host_revision(&admin.app).await, revision);
        let (_, office) = admin
            .call(
                "GET",
                &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(office["status"], json!("planned"), "{change}");
        // Fit again for the next case.
        let (_, current) = admin.call("GET", &template, None).await;
        let (status, back) = admin
            .call(
                "PUT",
                &template,
                Some(json!({
                    "enabled": true, "chzProductGroupCodes": null,
                    "expectedRev": current["rev"]
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{back}");
    }
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, entered["snapshot"]["palletTemplate"]["id"].clone()),
        (StatusCode::OK, json!(pallet))
    );
}

```

3. В `apps/standalone/host/tests/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
        ),
        (json!({ "issuerPrefix": "4600682" }), field("issuerPrefix")),
        (json!({ "extension": 1 }), field("extension")),
        (json!({ "requestId": "first" }), field("requestId")),
        (
```

заменить на

<!-- prettier-ignore -->
```rust
        ),
        (json!({ "issuerPrefix": "4600682" }), field("issuerPrefix")),
        (json!({ "extension": 2 }), field("extension")),
        (json!({ "requestId": "first" }), field("requestId")),
        (
```

4. В `apps/standalone/host/tests/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(status, StatusCode::OK);
    let mut bad = block_request(SECOND);
    bad["extension"] = json!(1);
    let (status, _) = ask(&admin, &admin.key, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(status, StatusCode::OK);
    let mut bad = block_request(SECOND);
    bad["extension"] = json!(2);
    let (status, _) = ask(&admin, &admin.key, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
```

5. В `apps/standalone/host/tests/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(audit_trail(&admin.app, "sscc.block.issue").await.len(), 3);
}

```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(audit_trail(&admin.app, "sscc.block.issue").await.len(), 3);
}

/// The pallet counter of `PREFIX` as the office reads it.
async fn pallet_counter(admin: &Admin) -> Value {
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    state["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["issuerPrefix"] == PREFIX && counter["extension"] == 1)
        .cloned()
        .expect("the wizard made the pallet counter")
}

fn pallet_request(request_id: &str) -> Value {
    json!({ "requestId": request_id, "issuerPrefix": PREFIX, "extension": 1 })
}

/// A pallet block (extension 1) is the pallet counter's next
/// `site.pallet_block_size` serials (200 by default), with its own revision,
/// audit row and wake; the box counter and the box block size are not
/// touched, nor the other way round.
#[tokio::test]
async fn a_pallet_block_takes_the_pallet_counter_and_the_pallet_block_size() {
    let admin = admin().await;
    let station = device_id(&admin, &admin.key).await;
    let boxes = box_counter(&admin).await;
    let mut wake = admin.app.state.revisions.subscribe();
    // The wizard started the pallet counter at 40.
    let (status, block) = ask(&admin, &admin.key, pallet_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{block}");
    assert_eq!(
        block,
        json!({
            "id": block["id"], "issuerPrefix": PREFIX, "extension": 1,
            "fromSerial": 40, "toSerial": 239
        })
    );
    let counter = pallet_counter(&admin).await;
    assert_eq!(
        (counter["nextSerial"].clone(), counter["rev"].clone()),
        (json!(240), json!(2))
    );
    assert_eq!(box_counter(&admin).await, boxes);
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), 2);
    let mut row = issued(&station, &block);
    row.6["extension"] = json!(1);
    assert_eq!(audit_trail(&admin.app, "sscc.block.issue").await, vec![row]);
    // The sizes change: a pallet block takes the pallet size, a box block
    // the box size.
    let (status, sizes) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 7, "palletBlockSize": 3, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sizes}");
    let (status, pallets) = ask(&admin, &admin.key, pallet_request(SECOND)).await;
    assert_eq!(
        (
            status,
            pallets["fromSerial"].clone(),
            pallets["toSerial"].clone()
        ),
        (StatusCode::OK, json!(240), json!(242))
    );
    let (status, boxes) = ask(&admin, &admin.key, block_request(THIRD)).await;
    assert_eq!(
        (
            status,
            boxes["fromSerial"].clone(),
            boxes["toSerial"].clone()
        ),
        (StatusCode::OK, json!(1500), json!(1506))
    );
    assert_eq!(pallet_counter(&admin).await["nextSerial"], json!(243));
}

/// A request id names one block of one extension: the same id for the
/// other extension is `validation_failed` on `requestId` and writes
/// nothing, whichever way round; the same body answers its own block.
#[tokio::test]
async fn a_repeated_request_id_with_another_extension_is_refused() {
    let admin = admin().await;
    let (status, pallets) = ask(&admin, &admin.key, pallet_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{pallets}");
    let (status, boxes) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(status, StatusCode::OK, "{boxes}");
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let blocks = block_rows(&admin).await;
    for body in [block_request(FIRST), pallet_request(SECOND)] {
        let (status, refused) = ask(&admin, &admin.key, body.clone()).await;
        assert_eq!(
            (status, refused["error"]["details"].clone()),
            (StatusCode::BAD_REQUEST, json!({ "field": "requestId" })),
            "{body}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, blocks);
    let (status, again) = ask(&admin, &admin.key, pallet_request(FIRST)).await;
    assert_eq!((status, again), (StatusCode::OK, pallets));
    let (status, again) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!((status, again), (StatusCode::OK, boxes));
}

/// The pallet counter ends like the box counter: the last serial is a
/// block of one, then `sscc_exhausted` names the pallet extension.
#[tokio::test]
async fn the_last_pallet_serial_is_a_block_of_one_and_then_none_is_left() {
    let admin = admin().await;
    let path = format!("/v1/office/sscc/counters/{PREFIX}/1");
    let counter = pallet_counter(&admin).await;
    let (status, moved) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 9_999_999, "expectedRev": counter["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, last) = ask(&admin, &admin.key, pallet_request(FIRST)).await;
    assert_eq!(
        (status, last["fromSerial"].clone(), last["toSerial"].clone()),
        (StatusCode::OK, json!(9_999_999), json!(9_999_999))
    );
    let (status, refused) = ask(&admin, &admin.key, pallet_request(SECOND)).await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("sscc_exhausted"),
            json!({ "issuerPrefix": PREFIX, "extension": 1 })
        )
    );
    // The box counter still issues.
    let (status, boxes) = ask(&admin, &admin.key, block_request(THIRD)).await;
    assert_eq!(
        (status, boxes["fromSerial"].clone()),
        (StatusCode::OK, json!(1500))
    );
}

```

6. Создать `apps/standalone/proto/fixtures/device-shift-create-pallets.json`:

<!-- prettier-ignore -->
```json
{
  "requestId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "productionDate": "2026-10-09",
  "boxCapacity": 12,
  "plannedQty": null,
  "counterpartyId": null,
  "palletsEnabled": true,
  "palletBoxCapacity": 40,
  "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f"
}
```

7. Создать `apps/standalone/proto/fixtures/device-shift-entered-pallets.json`:

<!-- prettier-ignore -->
```json
{
  "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "number": "OCT26-004",
  "status": "active",
  "mode": "aggregation",
  "palletsEnabled": true,
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
  "palletBoxCapacity": 40,
  "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
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
    "counterpartyName": "ООО «Северный берег»",
    "palletTemplate": {
      "id": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
      "name": "Паллета 100×150",
      "rev": 63,
      "spec": {
        "widthMm": 100,
        "heightMm": 150,
        "dpi": 203,
        "language": "zpl",
        "elements": [
          {
            "kind": "field",
            "id": "boxes",
            "xMm": 5,
            "yMm": 5,
            "field": "qty.boxes",
            "fontSizePt": 24
          }
        ]
      }
    }
  }
}
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

#[test]
fn a_shift_close_carries_the_reason_and_the_revision() {
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// A station's shift with pallets names their capacity and template, and its
/// entry freezes the pallet template; a shift without pallets names none of
/// them, and a station of stage 2a sends no pallet field.
#[test]
fn a_shift_with_pallets_names_them_and_its_entry_freezes_the_pallet_template() {
    let entered: DeviceShift = round_trip("device-shift-entered-pallets.json");
    let snapshot = entered
        .snapshot
        .clone()
        .expect("an entry carries the snapshot");
    let pallet = snapshot
        .pallet_template
        .expect("a shift with pallets freezes its pallet template");
    assert_eq!(
        (
            entered.pallets_enabled,
            entered.pallet_box_capacity,
            entered.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some(pallet.id.as_str()))
    );
    let plain: DeviceShift = serde_json::from_value(fixture("device-shift-entered.json")).unwrap();
    assert_eq!(
        (
            plain.pallet_box_capacity,
            plain.pallet_template_id,
            plain.snapshot.expect("snapshot").pallet_template
        ),
        (None, None, None)
    );
    let create: DeviceShiftCreate = round_trip("device-shift-create-pallets.json");
    assert_eq!(
        (
            create.pallets_enabled,
            create.pallet_box_capacity,
            create.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some(pallet.id.as_str()))
    );
    let bare: DeviceShiftCreate = round_trip("device-shift-create.json");
    assert_eq!(
        (
            bare.pallets_enabled,
            bare.pallet_box_capacity,
            bare.pallet_template_id
        ),
        (false, None, None)
    );
}

#[test]
fn a_shift_close_carries_the_reason_and_the_revision() {
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL — `17 passed; 3 failed`: `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`, `a_station_create_follows_the_pallet_rules`, `a_pallet_template_that_no_longer_fits_keeps_the_shift_planned` (поля паллет в `DeviceShiftCreate` хосту ещё незнакомы).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --offline --locked`
Expected: FAIL — `13 passed; 3 failed`: `a_pallet_block_takes_the_pallet_counter_and_the_pallet_block_size`, `a_repeated_request_id_with_another_extension_is_refused`, `the_last_pallet_serial_is_a_block_of_one_and_then_none_is_left` (расширение 1 — `validation_failed`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — ошибки сборки `no field pallet_box_capacity on type DeviceShift`, `no field pallet_template on type ShiftSnapshot`, `no field pallets_enabled on type DeviceShiftCreate`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: String,
    /// The station that opened the shift: another one's id means the shift
    /// is busy (stage 2a puts one device on a shift).
```

заменить на

<!-- prettier-ignore -->
```rust
    pub box_capacity: u32,
    pub box_template_id: String,
    /// How many boxes a pallet holds and the pallet label template, only for
    /// a shift with pallets (plan ПЛ-Х); left out otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    /// The station that opened the shift: another one's id means the shift
    /// is busy (stage 2a puts one device on a shift).
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub box_template: ShiftSnapshotTemplate,
    /// The SSCC issuer prefix of the organization's GLN when the shift
    /// opened: the station asks for blocks of it.
    pub issuer_prefix: String,
    pub counterparty_name: Option<String>,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub box_template: ShiftSnapshotTemplate,
    /// The SSCC issuer prefix of the organization's GLN when the shift
    /// opened: the station asks for blocks of it, of boxes and of pallets.
    pub issuer_prefix: String,
    pub counterparty_name: Option<String>,
    /// The pallet label template as the shift froze it, its layout whole:
    /// only for a shift with pallets (plan ПЛ-Х); left out otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template: Option<ShiftSnapshotTemplate>,
}

```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// The box template as a shift froze it, its layout whole. The host never
/// checks a layout; the station checks it with `labelTemplateSpecSchema`
/// when it enters the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// A label template as a shift froze it (its box template, and its pallet
/// template when it has pallets), its layout whole. The host never checks a
/// layout; the station checks it with `labelTemplateSpecSchema` when it
/// enters the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// the host answers. `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

заменить на

<!-- prettier-ignore -->
```rust
/// the host answers. `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same shift. Pallets follow the office's rules
/// ([`ShiftCreate`]); a station of stage 2a sends none of their fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub counterparty_id: Option<String>,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    #[serde(default)]
    pub counterparty_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pallets_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
}

```

6. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// `conflict` on `pallet_template_not_fit`: the planned shift's pallet
/// template is disabled now, or no longer covers the product's group.
pub fn pallet_template_not_fit() -> ApiError {
    ApiError::conflict(
        "pallet_template_not_fit",
        "the shift's pallet template no longer fits its product",
    )
}

/// A template as a shift freezes it: its name, revision and whole layout.
async fn frozen_template(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<ShiftSnapshotTemplate, ApiError> {
    let (name, spec, rev): (String, String, i64) =
        sqlx::query_as("SELECT name, spec, rev FROM label_templates WHERE id = ?")
            .bind(id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(ShiftSnapshotTemplate {
        id: id.to_owned(),
        name,
        rev,
        spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
    })
}

/// The snapshot a planned shift freezes when a station opens it: its product
/// (still active and not archived, or `product_inactive`), its box template
/// (still enabled and covering the product's group, or `template_not_fit`)
/// with the whole layout, with pallets its pallet template the same way
/// (`pallet_template_not_fit`), the issuer prefix of the organization's
/// current GLN, and the counterparty's name.
pub async fn snapshot(
    conn: &mut SqliteConnection,
    product_id: &str,
    template_id: &str,
    pallet_template_id: Option<&str>,
    counterparty_id: Option<&str>,
) -> Result<ShiftSnapshot, ApiError> {
```

7. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
        _ => return Err(template_not_fit()),
    }
    if let Some(pallet_template_id) = pallet_template_id {
        match templates::scope(conn, pallet_template_id).await? {
            Some(scope) if templates::fits(&scope, TemplatePurpose::Pallet, Some(group)) => {}
            _ => return Err(pallet_template_not_fit()),
        }
    }
    let box_template = frozen_template(&mut *conn, template_id).await?;
    let pallet_template = match pallet_template_id {
        Some(id) => Some(frozen_template(&mut *conn, id).await?),
        None => None,
    };
    let gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *conn)
```

8. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
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

заменить на

<!-- prettier-ignore -->
```rust
            shelf_life_days,
        },
        box_template,
        issuer_prefix: crate::validate::issuer_prefix(&gln).to_owned(),
        counterparty_name,
        pallet_template,
    })
}
```

9. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
     CASE WHEN s.snapshot IS NULL THEN c.name \
         ELSE json_extract(s.snapshot, '$.counterpartyName') END AS counterparty_name, \
     s.production_date, s.planned_qty, s.box_capacity, s.box_template_id, s.owner_device_id, \
     s.opened_at, s.closed_at \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     LEFT JOIN counterparties c ON c.id = s.counterparty_id";
```

заменить на

<!-- prettier-ignore -->
```rust
     CASE WHEN s.snapshot IS NULL THEN c.name \
         ELSE json_extract(s.snapshot, '$.counterpartyName') END AS counterparty_name, \
     s.production_date, s.planned_qty, s.box_capacity, s.box_template_id, \
     s.pallet_box_capacity, s.pallet_template_id, s.owner_device_id, s.opened_at, s.closed_at \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     LEFT JOIN counterparties c ON c.id = s.counterparty_id";
```

10. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
```

заменить на

<!-- prettier-ignore -->
```rust
    box_capacity: u32,
    box_template_id: String,
    pallet_box_capacity: Option<u32>,
    pallet_template_id: Option<String>,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
```

11. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
```

заменить на

<!-- prettier-ignore -->
```rust
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        pallet_box_capacity: row.pallet_box_capacity,
        pallet_template_id: row.pallet_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
```

12. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust

/// `POST /v1/device/shifts`: a station creates a planned shift on its own
/// line, under the rules of the office's plan; its number ends in `/S`. The
/// same `requestId` again answers the shift it created, whatever the body
/// says now, so a create retried after a lost answer makes no second shift.
```

заменить на

<!-- prettier-ignore -->
```rust

/// `POST /v1/device/shifts`: a station creates a planned shift on its own
/// line, under the rules of the office's plan, pallets included; its number
/// ends in `/S`. The
/// same `requestId` again answers the shift it created, whatever the body
/// says now, so a create retried after a lost answer makes no second shift.
```

13. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    require_station(&device)?;
    validate::client_uuid("requestId", &create.request_id)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    require_station(&device)?;
    validate::client_uuid("requestId", &create.request_id)?;
    let pallet_request = shifts::pallet_request(
        create.pallets_enabled,
        create.pallet_box_capacity,
        create.pallet_template_id.as_deref(),
    )?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
```

14. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let pallets = shifts::pallets(&mut tx, pallet_request, &product).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
```

15. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets: None,
        },
        &at,
```

заменить на

<!-- prettier-ignore -->
```rust
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets,
        },
        &at,
```

16. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    product_id: String,
    box_template_id: String,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
```

заменить на

<!-- prettier-ignore -->
```rust
    product_id: String,
    box_template_id: String,
    pallet_template_id: Option<String>,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
```

17. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    device.require_station_in(&mut tx, STATION_ONLY).await?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT status, line_id, owner_device_id, product_id, box_template_id, counterparty_id, \
         snapshot, number_month_key, number_seq, created_from FROM shifts WHERE id = ?",
    )
    .bind(&id)
```

заменить на

<!-- prettier-ignore -->
```rust
    device.require_station_in(&mut tx, STATION_ONLY).await?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT status, line_id, owner_device_id, product_id, box_template_id, \
         pallet_template_id, counterparty_id, snapshot, number_month_key, number_seq, \
         created_from FROM shifts WHERE id = ?",
    )
    .bind(&id)
```

18. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
                &shift.product_id,
                &shift.box_template_id,
                shift.counterparty_id.as_deref(),
            )
```

заменить на

<!-- prettier-ignore -->
```rust
                &shift.product_id,
                &shift.box_template_id,
                shift.pallet_template_id.as_deref(),
                shift.counterparty_id.as_deref(),
            )
```

19. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .map_err(ApiError::internal)?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
```

заменить на

<!-- prettier-ignore -->
```rust
    .map_err(ApiError::internal)?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    let mut details = json!({
        "number": shifts::format_number(&shift.number_month_key, shift.number_seq, origin),
        "templateId": snapshot.box_template.id,
        "templateRev": snapshot.box_template.rev,
    });
    if let Some(pallet_template) = &snapshot.pallet_template {
        details["palletTemplateId"] = json!(pallet_template.id);
        details["palletTemplateRev"] = json!(pallet_template.rev);
    }
    audit::record(
        &mut tx,
```

20. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": shifts::format_number(&shift.number_month_key, shift.number_seq, origin),
                "templateId": snapshot.box_template.id,
                "templateRev": snapshot.box_template.rev,
            }),
        },
    )
```

заменить на

<!-- prettier-ignore -->
```rust
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
```

21. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! SSCC blocks (stage 2a spec §4.3): `POST /v1/device/sscc/blocks`, for
//! stations only. A station asks for a block when it has none for its
//! shift's prefix or its newest is half used; the host gives the next
//! `site.box_block_size` serials of the counter (fewer at the end of the
//! prefix's serials, then `sscc_exhausted`) and moves the counter past them
//! with a new revision in the same transaction. A repeated `requestId` of
//! the same station answers the same block, even after others were issued;
//! with another issuer prefix in the body it is `validation_failed` on
//! `requestId`, since the station would file the old block's serials under
//! a prefix they were not reserved for.
//! Revoking blocks and a screen of them per device are plan 2b's.

```

заменить на

<!-- prettier-ignore -->
```rust
//! SSCC blocks (stage 2a spec §4.3): `POST /v1/device/sscc/blocks`, for
//! stations only. A station asks for a block of boxes (extension 0) or of
//! pallets (extension 1, plan ПЛ-Х) when it has none for its shift's prefix
//! or its newest is half used; the host gives the next `site.box_block_size`
//! or `site.pallet_block_size` serials of the counter of that prefix and
//! extension (fewer at the end of the prefix's serials, then
//! `sscc_exhausted`) and moves the counter past them with a new revision in
//! the same transaction. A repeated `requestId` of the same station answers
//! the same block, even after others were issued; with another issuer prefix
//! or extension in the body it is `validation_failed` on `requestId`, since
//! the station would file the old block's serials under a prefix or for
//! labels they were not reserved for.
//! Revoking blocks and a screen of them per device are plan 2b's.

```

22. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
    }
    validate::client_uuid("requestId", &request.request_id)?;
    // Boxes take extension 0, pallets 1, each with its own counter and size.
    let size_column = match request.extension {
        0 => "box_block_size",
        1 => "pallet_block_size",
        _ => {
            return Err(ApiError::validation(
                "extension",
                "a block is of boxes (0) or of pallets (1)",
            ))
        }
    };
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
```

23. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await?;
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await? {
        // A request id names one block of one prefix (the station keeps the
        // prefix it asked for beside the id and repeats the same body). The
        // same id for another prefix is a station's mistake, and answering
        // the old block would hand it serials it files under the wrong
        // prefix. Extension is 0 on both sides until plan 2b.
        if block.issuer_prefix != request.issuer_prefix {
            return Err(ApiError::validation(
                "requestId",
                "this request id was used for another prefix",
            ));
        }
```

заменить на

<!-- prettier-ignore -->
```rust
        .await?;
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await? {
        // A request id names one block of one prefix and extension (the
        // station keeps what it asked for beside the id and repeats the same
        // body). The same id for another prefix or extension is a station's
        // mistake, and answering the old block would hand it serials it
        // files under the wrong prefix, or prints on pallets that were
        // reserved for boxes.
        if block.issuer_prefix != request.issuer_prefix || block.extension != request.extension {
            return Err(ApiError::validation(
                "requestId",
                "this request id was used for another prefix or extension",
            ));
        }
```

24. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let next = next.ok_or_else(|| ApiError::validation("issuerPrefix", "no such SSCC counter"))?;
    let next = u64::try_from(next).map_err(ApiError::internal)?;
    let size: i64 = sqlx::query_scalar("SELECT box_block_size FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
```

заменить на

<!-- prettier-ignore -->
```rust
    let next = next.ok_or_else(|| ApiError::validation("issuerPrefix", "no such SSCC counter"))?;
    let next = u64::try_from(next).map_err(ApiError::internal)?;
    let size: i64 = sqlx::query_scalar(&format!("SELECT {size_column} FROM site WHERE id = 1"))
        .fetch_one(&mut *tx)
        .await
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --test sscc_blocks --test office_shifts --test facts --offline --locked`
Expected: PASS — `device_shifts` 20, `facts` 36, `office_shifts` 30, `sscc_blocks` 16.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 44.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`forbidden`): the planned and active shifts of its line, and the shifts it
entered that are active or closed within 30 days, by production date; a
station without a line sees only the latter. It reads them when it reads its
device record (after it subscribes to the link and after every revision
event), not through the feed: shifts are per line, and an open one carries a
layout of up to 256 KB. A shift's product name and GTIN and its
counterparty's name are the snapshot's once it is open and the records' before
```

заменить на

<!-- prettier-ignore -->
```text
`forbidden`): the planned and active shifts of its line, and the shifts it
entered that are active or closed within 30 days, by production date; a
station without a line sees only the latter. A shift with pallets also
names `palletBoxCapacity` and `palletTemplateId`; a shift without leaves
both out, so a station of stage 2a reads its list as before. It reads them
when it reads its device record (after it subscribes to the link and after
every revision event), not through the feed: shifts are per line, and an
open one carries a
layout of up to 256 KB. A shift's product name and GTIN and its
counterparty's name are the snapshot's once it is open and the records' before
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
station that opened it, and another station's id means the shift is busy. A
station creates a shift on its own line while the host answers
(`POST /v1/device/shifts`), under the office's rules; a station without a line
is `conflict` on `shift_line`, and a line is no field of the request.
`requestId`, a lower-case hyphenated UUID the station made up
```

заменить на

<!-- prettier-ignore -->
```text
station that opened it, and another station's id means the shift is busy. A
station creates a shift on its own line while the host answers
(`POST /v1/device/shifts`), under the office's rules, pallets included
(`palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`, all optional and
left out by a station of stage 2a); a station without a line
is `conflict` on `shift_line`, and a line is no field of the request.
`requestId`, a lower-case hyphenated UUID the station made up
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
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
```

заменить на

<!-- prettier-ignore -->
```text
(`ShiftSnapshot`: the product's id, GTIN, names, group and shelf life; the box
template's id, name, revision and whole layout; the issuer prefix of the
organization's GLN; the counterparty's name; with pallets the pallet
template's id, name, revision and layout as `palletTemplate`, which a shift
without pallets leaves out), makes the station the shift's
owner, adds it to `shift_participants` and takes a revision, so the line's
other stations see the shift busy. The owner enters again with no revision and
gets the same snapshot back, so a station that lost its database recovers it;
a change of the catalog, the template or the GLN never changes it. A pallet
template disabled or narrowed since the plan keeps the shift planned
(`conflict` on `pallet_template_not_fit`, checked after the box template). A
closed shift is `shift_status` for every station, a shift of another line (or a
station without one) `shift_line`, a shift another station opened
`shift_busy`: stage 2a puts one device on a shift. The snapshot is at most
```

4. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
`palletTemplateId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`), `shift.close` (an office user; `{ reason }`) and
`sscc.block.issue` (a station; target `sscc_block`; `{ issuerPrefix,
extension, fromSerial, toSerial }`). A refusal writes none.
```

заменить на

<!-- prettier-ignore -->
```text
`palletTemplateId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`, plus `palletTemplateId` and `palletTemplateRev` for a shift
with pallets), `shift.close` (an office user; `{ reason }`) and
`sscc.block.issue` (a station; target `sscc_block`; `{ issuerPrefix,
extension, fromSerial, toSerial }`). A refusal writes none.
```

5. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
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
same block, even after others were issued, but only for the same prefix: the
id with another `issuerPrefix` is `validation_failed` on `requestId` and
writes nothing. A correct station keeps the prefix beside the id and repeats
its request whole, so a mismatch is its mistake, and the old block's serials
must not be filed under a prefix they were not reserved for (a shift create
is lenient the other way, since a station reads that shift from the answer;
the extension is 0 on both sides until plan 2b). The device is read again
inside the write transaction (a station revoked while the request waited
gets 401). A block's use (`consumed_through`) comes with the facts of plan
```

заменить на

<!-- prettier-ignore -->
```text
(`POST /v1/device/sscc/blocks`, `{ requestId, issuerPrefix, extension }`,
stations only) when it has none for its shift's prefix or its newest is half
used (plan 2a6). A block is of boxes (`extension` 0) or of pallets (1, plan
ПЛ-Х; `validation_failed` on `extension` otherwise), of a prefix that has a
counter for that extension (`validation_failed` on `issuerPrefix`
otherwise). A block is the counter's next `site.box_block_size` serials (2000
by default) or `site.pallet_block_size` (200; «SSCC → Размеры блоков»), fewer
at the end of the prefix's serials, and then `sscc_exhausted` (409, with the
prefix and the extension). The counter moves past the block with a new
revision in the same
transaction, so every issued serial lies below its counter, `sscc_below_floor`
keeps it from being issued again, and a counter form opened before the issue
meets `stale_revision`. The same `requestId` of the same station answers the
same block, even after others were issued, but only for the same prefix and
extension: the id with another `issuerPrefix` or `extension` is
`validation_failed` on `requestId` and writes nothing. A correct station keeps
the request beside the id and repeats it whole, so a mismatch is its mistake,
and the old block's serials must not be filed under a prefix, or printed on
labels, they were not reserved for (a shift create is lenient the other way,
since a station reads that shift from the answer). The device is read again
inside the write transaction (a station revoked while the request waited
gets 401). A block's use (`consumed_through`) comes with the facts of plan
```

- [ ] **Step 6: Мутации**

М1 — шаблон паллеты при входе проверяется как шаблон короба. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Some(scope) if templates::fits(&scope, TemplatePurpose::Pallet, Some(group)) => {}
```

заменить на

<!-- prettier-ignore -->
```rust
            Some(scope) if templates::fits(&scope, TemplatePurpose::Box, Some(group)) => {}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_pallet_template_that_no_longer_fits_keeps_the_shift_planned`, `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — снимок без шаблона паллеты. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(id) => Some(frozen_template(&mut *conn, id).await?),
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(_) => None,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_pallet_template_that_no_longer_fits_keeps_the_shift_planned`, `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — ревизия шаблона паллеты не в журнале открытия. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        details["palletTemplateRev"] = json!(pallet_template.rev);
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — станция создаёт смену без паллет. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            box_template_id: &create.box_template_id,
            pallets,
```

заменить на

<!-- prettier-ignore -->
```rust
            box_template_id: &create.box_template_id,
            pallets: pallets.and(None),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — блок паллет размером блока коробов. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
        1 => "pallet_block_size",
```

заменить на

<!-- prettier-ignore -->
```rust
        1 => "box_block_size",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --offline --locked`
Expected: FAIL `a_pallet_block_takes_the_pallet_counter_and_the_pallet_block_size`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — повтор с другим расширением отдаёт старый блок. В `apps/standalone/host/src/routes/sscc_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
if block.issuer_prefix != request.issuer_prefix || block.extension != request.extension {
```

заменить на

<!-- prettier-ignore -->
```rust
if block.issuer_prefix != request.issuer_prefix {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test sscc_blocks --offline --locked`
Expected: FAIL `a_repeated_request_id_with_another_extension_is_refused`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — список станции не называет вместимость паллеты. В `apps/standalone/host/src/routes/device_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        pallet_box_capacity: row.pallet_box_capacity,
```

заменить на

<!-- prettier-ignore -->
```rust
        pallet_box_capacity: row.pallet_box_capacity.and(None),
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — неподходящий шаблон паллеты открывает смену. В `apps/standalone/host/src/shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            _ => return Err(pallet_template_not_fit()),
```

заменить на

<!-- prettier-ignore -->
```rust
            _ => {}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_shifts --offline --locked`
Expected: FAIL `a_pallet_template_that_no_longer_fits_keeps_the_shift_planned`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/device-shift-create-pallets.json apps/standalone/proto/fixtures/device-shift-entered-pallets.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/shifts.rs apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/sscc_blocks.rs apps/standalone/host/tests/device_shifts.rs apps/standalone/host/tests/sscc_blocks.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/device-shift-create-pallets.json apps/standalone/proto/fixtures/device-shift-entered-pallets.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a station creates and enters a shift with pallets, which freezes its pallet template, and gets pallet SSCC blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Короб на паллете и `pallet_closed` — паллета открывается первым коробом, закрывается номером своего блока

В смене с паллетами `box_closed` называет паллету станции (`palletId`). Первый закрытый короб, который её называет, открывает паллету на хосте; паллета другого устройства или смены — `pallet_unknown`; смена без паллет — `no_pallets`. Состояние паллеты коробу не отказывает: короб, досланный под новым `id` после отказа, присоединяется и к закрытой паллете. `pallet_closed` закрывает паллету SSCC её блока. Правила те же, что у коробов: расширение `1`, префикс снимка и серия по первым 17 цифрам; серия в неотозванном блоке расширения 1 этого устройства; один номер блока — одна паллета при любой контрольной цифре; `consumed_through` только растёт. Паллета, ни один короб которой не дошёл, открывается сразу закрытой. Повтор тем же SSCC принимается, другим — `pallet_already_closed`. Общие для коробов и паллет проверки блока и `consumed_through` выносятся в `facts/blocks.rs`: короба закрываются тем же кодом, и прежние тесты `facts` это держат.

**Files:**

- Create: `apps/standalone/host/src/facts/blocks.rs`, `apps/standalone/host/src/facts/pallets.rs`, `apps/standalone/host/src/facts/pallet_closed.rs`, `apps/standalone/host/tests/pallet_facts.rs`, `apps/standalone/proto/fixtures/facts-request-pallets.json`
- Modify: `apps/standalone/host/src/facts/{mod,box_closed,boxes}.rs`, `apps/standalone/proto/src/lib.rs` (`FactKind::PalletClosed`, `BoxClosedFact.pallet_id`, `PalletClosedFact`)
- Test: `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `rules::names_serial` (задача 1), `boxes::find`, таблицы `pallets` и `boxes.pallet_id` (задача 2), блоки расширения 1 (задача 3).
- Produces: `FactKind::PalletClosed` (`"pallet_closed"`); `markiro_proto::PalletClosedFact { pallet_id, sscc, block_id, serial: u64, opened_at, closed_at, box_count: u32 }`; `BoxClosedFact.pallet_id: Option<String>` (в JSON только когда задан); `FactShift.pallets_enabled: bool`; `OwnBox.pallet_id`; `facts::blocks::{issued(conn, context, block_id, extension, serial) -> Result<bool, ApiError>, consume(conn, block_id, serial)}`; `facts::pallets::{OwnPallet { closed_at, sscc, disassembled_at }, require(context) -> Result<(), Reject>, find(conn, context, id) -> Result<Option<OwnPallet>, Failure>, open(conn, context, id, opened_at)}`; помощники тестов `support::app::{open_pallet_floor(admin, setup, key, line) -> Floor, issue_pallet_block(app, key, request_id) -> Value, pallet_id(n) -> String, pallet_sscc(serial) -> String, sscc_of(extension, prefix, serial) -> String, pallet_closed(pallet_id, block, serial, boxes, opened_at, closed_at) -> Value}`.

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// station its owner.
pub async fn open_floor(admin: &Admin, setup: &ShiftSetup, key: &str, line: &str) -> Floor {
    let (status, device) = admin
        .app
```

заменить на

<!-- prettier-ignore -->
```rust
/// station its owner.
pub async fn open_floor(admin: &Admin, setup: &ShiftSetup, key: &str, line: &str) -> Floor {
    open_floor_of(admin, key, line, shift_body(setup)).await
}

/// `open_floor` for a shift with pallets of a new pallet template, 40
/// boxes a pallet (the product's).
pub async fn open_pallet_floor(admin: &Admin, setup: &ShiftSetup, key: &str, line: &str) -> Floor {
    let template = pallet_template(admin).await;
    open_floor_of(admin, key, line, pallet_shift_body(setup, &template)).await
}

/// `open_floor` for a shift planned from `body`.
async fn open_floor_of(admin: &Admin, key: &str, line: &str, mut body: Value) -> Floor {
    let (status, device) = admin
        .app
```

2. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let mut body = shift_body(setup);
    body["lineId"] = Value::String(line.to_owned());
    let shift = plan_shift(admin, body).await;
```

заменить на

<!-- prettier-ignore -->
```rust
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    body["lineId"] = Value::String(line.to_owned());
    let shift = plan_shift(admin, body).await;
```

3. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// digit.
pub fn sscc_under(prefix: &str, serial: u64) -> String {
    let body = format!("0{prefix}{serial:07}");
    let sum: u32 = body
        .bytes()
```

заменить на

<!-- prettier-ignore -->
```rust
/// digit.
pub fn sscc_under(prefix: &str, serial: u64) -> String {
    sscc_of(0, prefix, serial)
}

/// The SSCC of pallet serial `serial` under the wizard's prefix, with its
/// check digit (extension 1).
pub fn pallet_sscc(serial: u64) -> String {
    sscc_of(1, "460068200", serial)
}

/// The SSCC of `extension`, `prefix` (9 digits) and `serial`, with its GS1
/// check digit, as the domain's `buildSscc` writes it.
pub fn sscc_of(extension: u8, prefix: &str, serial: u64) -> String {
    let body = format!("{extension}{prefix}{serial:07}");
    let sum: u32 = body
        .bytes()
```

4. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

```

заменить на

<!-- prettier-ignore -->
```rust
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

/// A block of pallet serials (extension 1) the station of `key` gets for
/// request `request_id`; the wizard's pallet counter starts at 40 and a
/// pallet block is 200 serials, so the first block is 40–239.
pub async fn issue_pallet_block(app: &TestApp, key: &str, request_id: &str) -> Value {
    let (status, block) = app
        .send(json(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            serde_json::json!({
                "requestId": request_id, "issuerPrefix": "460068200", "extension": 1
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

/// The id of pallet `n`, a canonical UUID.
pub fn pallet_id(n: u32) -> String {
    format!("a0000000-0000-4000-8000-{n:012}")
}

/// The `data` of a pallet closed at `closed_at` with serial `serial` of
/// `block`, opened at `opened_at`, holding `boxes` boxes as the station
/// counted them.
pub fn pallet_closed(
    pallet_id: &str,
    block: &Value,
    serial: u64,
    boxes: u32,
    opened_at: &str,
    closed_at: &str,
) -> Value {
    serde_json::json!({
        "palletId": pallet_id, "sscc": pallet_sscc(serial), "blockId": block["id"],
        "serial": serial, "openedAt": opened_at, "closedAt": closed_at, "boxCount": boxes
    })
}

```

5. Создать `apps/standalone/host/tests/pallet_facts.rs`:

<!-- prettier-ignore -->
```rust
mod support;

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
    accepted, admin, audit_rows, box_closed, box_id, fact, host_revision, instant, issue_block,
    issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device, pallet_closed,
    pallet_id, pallet_sscc, receipts, record_id, rejected, send_facts, shift_setup, sscc_of, Admin,
    Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const OTHER_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// A host whose station is inside an open shift with pallets, with a box
/// block (1500–3499) and a pallet block (40–239).
async fn pallet_floor() -> (Admin, Floor, Value, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    (admin, floor, block, pallets)
}

/// The record `n` of `kind` in the floor's shift, by the operator.
fn record(floor: &Floor, n: u32, kind: &str, data: Value) -> Value {
    let mut record = fact(&record_id(n), kind, &floor.shift, data);
    record["operatorId"] = json!(OPERATOR);
    record
}

/// Box `box_n` holding code `box_n`, scanned at second `box_n` and closed
/// at second `100 + box_n` with box serial `1499 + box_n`, on `pallet` (or
/// on none): the scan is record `box_n`, the close record `100 + box_n`.
fn boxed(floor: &Floor, block: &Value, box_n: u32, pallet: Option<&str>) -> [Value; 2] {
    let mut closed = box_closed(
        &box_id(box_n),
        block,
        1499 + u64::from(box_n),
        &[box_n],
        &instant(box_n, 0),
        &instant(100 + box_n, 0),
    );
    if let Some(pallet) = pallet {
        closed["palletId"] = json!(pallet);
    }
    [
        record(
            floor,
            box_n,
            "scan",
            ok_scan(box_n, &box_id(box_n), &instant(box_n, 0)),
        ),
        record(floor, 100 + box_n, "box_closed", closed),
    ]
}

/// A pallet row: `(shift, device, opened at, closed at, sscc, block, serial,
/// count reported, operator, received at)`.
async fn pallet_row(admin: &Admin, id: &str) -> Option<Value> {
    type PalletRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        String,
    );
    let row: Option<PalletRow> = sqlx::query_as(
        "SELECT shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         box_count_reported, operator_id, received_at FROM pallets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&admin.app.state.pool)
    .await
    .unwrap();
    row.map(|row| json!(row))
}

/// The pallet each closed box of the shift joined, by box id.
async fn box_pallets(admin: &Admin) -> Vec<(String, Option<String>)> {
    sqlx::query_as("SELECT id, pallet_id FROM boxes WHERE closed_at IS NOT NULL ORDER BY id")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn consumed_through(admin: &Admin, block: &Value) -> Option<i64> {
    sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
        .bind(block["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn pallet_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// Boxes that close on a pallet open it and join it; the pallet's close
/// takes a serial of the station's pallet block, raises its use and keeps
/// what the station reported, with the station's opening instant. Facts
/// take no revision and write no audit row.
#[tokio::test]
async fn boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let pallet = pallet_id(1);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet)));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet)));
    let at = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    // The first box opened the pallet at its own close.
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(101, 0),
            null,
            null,
            null,
            null,
            null,
            null,
            at
        ]))
    );
    assert_eq!(
        box_pallets(&admin).await,
        vec![
            (box_id(1), Some(pallet.clone())),
            (box_id(2), Some(pallet.clone()))
        ]
    );
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet,
            &pallets,
            40,
            2,
            &instant(100, 500),
            &instant(150, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(201))]
    );
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(100, 500),
            instant(150, 0),
            pallet_sscc(40),
            pallets["id"],
            40,
            2,
            OPERATOR,
            at
        ]))
    );
    assert_eq!(consumed_through(&admin, &pallets).await, Some(40));
    assert_eq!(consumed_through(&admin, &block).await, Some(1501));
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A pallet's SSCC is of the pallet extension (1) and the shift's prefix,
/// its serial lies in a live pallet block of this device, both ends
/// included, and one serial is one label whatever the check digit says.
/// A refused close leaves its pallet open.
#[tokio::test]
async fn a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let other = issue_pallet_block(&admin.app, &colleague_key, PALLET_REQUEST).await;
    // Blocks: this station's 40–239, the colleague's 240–439, this
    // station's revoked one 440–639.
    let revoked = issue_pallet_block(&admin.app, &floor.key, OTHER_REQUEST).await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = '2026-10-08T06:00:00Z' WHERE id = ?")
        .bind(revoked["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    // Ten pallets, one box each.
    let mut batch = Vec::new();
    for n in 1..=10 {
        batch.extend(boxed(&floor, &block, n, Some(&pallet_id(n))));
    }
    receipts(&admin.app, &floor.key, &batch).await;
    let close = |n: u32, data: Value| record(&floor, 200 + n, "pallet_closed", data);
    let closing = |n: u32, block: &Value, serial: u64| {
        pallet_closed(
            &pallet_id(n),
            block,
            serial,
            1,
            &instant(100, 0),
            &instant(150, 0),
        )
    };
    let mut box_extension = closing(1, &pallets, 50);
    box_extension["sscc"] = json!(sscc_of(0, "460068200", 50));
    let mut box_block = closing(2, &block, 1500);
    box_block["sscc"] = json!(pallet_sscc(1500));
    let mut other_digit = closing(9, &pallets, 41);
    let sscc = pallet_sscc(41);
    let digit = (sscc.as_bytes()[17] - b'0' + 1) % 10;
    other_digit["sscc"] = json!(format!("{}{digit}", &sscc[..17]));
    let batch = vec![
        close(1, box_extension),
        close(2, box_block),
        close(3, closing(3, &pallets, 39)),
        close(4, closing(4, &pallets, 240)),
        close(5, closing(5, &other, 260)),
        close(6, closing(6, &revoked, 440)),
        close(7, closing(7, &pallets, 40)),
        close(8, closing(8, &pallets, 239)),
        close(9, other_digit),
        close(10, closing(10, &pallets, 239)),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(201)), "sscc_not_issued", None),
            rejected(Some(&record_id(202)), "sscc_not_issued", None),
            rejected(Some(&record_id(203)), "sscc_not_issued", None),
            rejected(Some(&record_id(204)), "sscc_not_issued", None),
            rejected(Some(&record_id(205)), "sscc_not_issued", None),
            rejected(Some(&record_id(206)), "sscc_not_issued", None),
            accepted(&record_id(207)),
            accepted(&record_id(208)),
            accepted(&record_id(209)),
            rejected(Some(&record_id(210)), "sscc_taken", None),
        ]
    );
    // The refused closes left their pallets open; the accepted ones raised
    // the block's use to its last serial.
    for n in [1, 2, 3, 4, 5, 6, 10] {
        assert_eq!(
            pallet_row(&admin, &pallet_id(n)).await.unwrap()[3],
            Value::Null,
            "{n}"
        );
    }
    assert_eq!(consumed_through(&admin, &pallets).await, Some(239));
    assert_eq!(consumed_through(&admin, &other).await, None);
    assert_eq!(consumed_through(&admin, &revoked).await, None);
    // Pallet 9 closed on serial 41 under another check digit: no other
    // pallet takes serial 41 under the right one.
    let again = record(&floor, 211, "pallet_closed", closing(10, &pallets, 41));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[again]).await,
        vec![rejected(Some(&record_id(211)), "sscc_taken", None)]
    );
}

/// The same close sent again under another id changes nothing, another SSCC
/// for a closed pallet is `pallet_already_closed`, and the block's use
/// never goes down when pallets close out of order.
#[tokio::test]
async fn a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let closing = |n: u32, serial: u64| {
        pallet_closed(
            &pallet_id(n),
            &pallets,
            serial,
            1,
            &instant(100, 0),
            &instant(150, 0),
        )
    };
    let first = record(&floor, 201, "pallet_closed", closing(1, 100));
    receipts(&admin.app, &floor.key, &[first]).await;
    let row = pallet_row(&admin, &pallet_id(1)).await;
    let mut other_sscc = closing(1, 101);
    other_sscc["blockId"] = pallets["id"].clone();
    let batch = vec![
        record(&floor, 202, "pallet_closed", closing(1, 100)),
        record(&floor, 203, "pallet_closed", other_sscc),
        record(&floor, 204, "pallet_closed", closing(2, 50)),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(202)),
            rejected(Some(&record_id(203)), "pallet_already_closed", None),
            accepted(&record_id(204)),
        ]
    );
    assert_eq!(pallet_row(&admin, &pallet_id(1)).await, row);
    assert_eq!(consumed_through(&admin, &pallets).await, Some(100));
}

/// A pallet whose close reached the host before any of its boxes (their
/// records were refused and sent again under new ids, say) opens closed,
/// so its printed SSCC is held; the boxes that name it later join it.
#[tokio::test]
async fn a_pallet_closed_before_its_boxes_opens_closed_and_its_boxes_join_it_later() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let pallet = pallet_id(1);
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(&pallet, &pallets, 40, 1, &instant(100, 0), &instant(150, 0)),
    );
    let at = admin.app.state.timestamp();
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(201))]
    );
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(100, 0),
            instant(150, 0),
            pallet_sscc(40),
            pallets["id"],
            40,
            1,
            OPERATOR,
            at
        ]))
    );
    let late = boxed(&floor, &block, 1, Some(&pallet));
    let answered = receipts(&admin.app, &floor.key, &late).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(
        box_pallets(&admin).await,
        vec![(box_id(1), Some(pallet.clone()))]
    );
    // The pallet is as its close left it.
    assert_eq!(
        pallet_row(&admin, &pallet).await.unwrap()[3],
        json!(instant(150, 0))
    );
}

/// A pallet of another device or of another shift is `pallet_unknown`, to a
/// closed box and to a pallet's close alike; nothing of the record is
/// written.
#[tokio::test]
async fn a_pallet_of_another_device_or_shift_is_unknown() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    // The colleague's box 2001 (serial 3500, its block's first) opens pallet
    // 50 on the colleague's shift; this station's box 1 opens pallet 1.
    let theirs = boxed(&colleague, &colleague_block, 2001, Some(&pallet_id(50)));
    let answered = receipts(&admin.app, &colleague.key, &theirs).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let mine = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    receipts(&admin.app, &floor.key, &mine).await;
    // A pallet of the colleague in this very shift (no route makes one in
    // stage 2a, where a shift takes one station; the host still keeps a
    // device to its own pallets).
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:00Z')",
    )
    .bind(pallet_id(60))
    .bind(&floor.shift)
    .bind(&colleague.station)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    // A second shift of this station's line, which it enters too.
    let second = open_pallet_floor(&admin, &setup, &floor.key, &setup.line).await;
    let closing = |floor: &Floor, n: u32, pallet: u32| {
        record(
            floor,
            n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(pallet),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        )
    };
    let in_second = boxed(&second, &block, 2, Some(&pallet_id(1)));
    let batch = vec![
        boxed(&floor, &block, 3, Some(&pallet_id(50)))[0].clone(),
        boxed(&floor, &block, 3, Some(&pallet_id(50)))[1].clone(),
        closing(&floor, 201, 50),
        in_second[0].clone(),
        in_second[1].clone(),
        closing(&second, 202, 1),
        boxed(&floor, &block, 4, Some(&pallet_id(60)))[0].clone(),
        boxed(&floor, &block, 4, Some(&pallet_id(60)))[1].clone(),
        closing(&floor, 203, 60),
    ];
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        [1, 2, 4, 5, 7, 8].map(|n| answered[n].clone()),
        [
            rejected(Some(&record_id(103)), "pallet_unknown", None),
            rejected(Some(&record_id(201)), "pallet_unknown", None),
            rejected(Some(&record_id(102)), "pallet_unknown", None),
            rejected(Some(&record_id(202)), "pallet_unknown", None),
            rejected(Some(&record_id(104)), "pallet_unknown", None),
            rejected(Some(&record_id(203)), "pallet_unknown", None),
        ]
    );
    // Boxes 2, 3 and 4 stay open, the pallets as they were, the pallet
    // block unused.
    assert_eq!(
        box_pallets(&admin).await,
        vec![
            (box_id(1), Some(pallet_id(1))),
            (box_id(2001), Some(pallet_id(50)))
        ]
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(50)).await.unwrap()[1],
        json!(colleague.station)
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[3],
        Value::Null
    );
    assert_eq!(consumed_through(&admin, &pallets).await, None);
}

/// A shift without pallets takes no pallet: a closed box that names one and
/// a pallet's close are `no_pallets`, and nothing is written.
#[tokio::test]
async fn a_shift_without_pallets_takes_no_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let named = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[named[0].clone(), named[1].clone(), close],
    )
    .await;
    assert_eq!(
        answered[1..].to_vec(),
        vec![
            rejected(Some(&record_id(101)), "no_pallets", None),
            rejected(Some(&record_id(201)), "no_pallets", None),
        ]
    );
    assert_eq!(box_pallets(&admin).await, vec![]);
    assert_eq!(pallet_count(&admin).await, 0);
    // The same box closes without a pallet.
    let plain = boxed(&floor, &block, 1, None);
    let mut closing = plain[1].clone();
    closing["id"] = json!(record_id(102));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[closing]).await,
        vec![accepted(&record_id(102))]
    );
}

/// A box's close sent again names the same pallet, or none when it named
/// none: on another pallet, or without its pallet, it is another close.
#[tokio::test]
async fn a_box_closed_again_on_another_pallet_is_refused() {
    let (admin, floor, block, _) = pallet_floor().await;
    let first = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    receipts(&admin.app, &floor.key, &first).await;
    let again = |n: u32, pallet: Option<&str>| {
        let mut closing = boxed(&floor, &block, 1, pallet)[1].clone();
        closing["id"] = json!(record_id(n));
        closing
    };
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                again(111, Some(&pallet_id(1))),
                again(112, Some(&pallet_id(2))),
                again(113, None),
            ]
        )
        .await,
        vec![
            accepted(&record_id(111)),
            rejected(Some(&record_id(112)), "box_already_closed", None),
            rejected(Some(&record_id(113)), "box_already_closed", None),
        ]
    );
    // Pallet 2 was never opened.
    assert_eq!(pallet_row(&admin, &pallet_id(2)).await, None);
    // A box closed without a pallet, sent again with one, is another close.
    let plain = boxed(&floor, &block, 2, None);
    receipts(&admin.app, &floor.key, &plain).await;
    let mut named = boxed(&floor, &block, 2, Some(&pallet_id(1)))[1].clone();
    named["id"] = json!(record_id(122));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[named]).await,
        vec![rejected(Some(&record_id(122)), "box_already_closed", None)]
    );
}

/// The fields of a pallet's close and a box's pallet have the form the
/// station gives them; a record that breaks one is `invalid_record` on it.
#[tokio::test]
async fn a_pallet_close_and_a_boxs_pallet_have_their_form() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let good = pallet_closed(
        &pallet_id(1),
        &pallets,
        40,
        1,
        &instant(100, 0),
        &instant(150, 0),
    );
    let changed = |key: &str, value: Value| {
        let mut data = good.clone();
        data[key] = value;
        data
    };
    let mut extra = good.clone();
    extra["boxes"] = json!([]);
    let cases = [
        (
            changed("palletId", json!("pallet-1")),
            Some("data.palletId"),
        ),
        (changed("blockId", json!("block")), Some("data.blockId")),
        (
            changed("openedAt", json!("2026-10-08T06:01:40Z")),
            Some("data.openedAt"),
        ),
        (
            changed("closedAt", json!("yesterday")),
            Some("data.closedAt"),
        ),
        (
            changed("sscc", json!("14600682000000040")),
            Some("data.sscc"),
        ),
        (
            changed("sscc", json!("1460068200000004a9")),
            Some("data.sscc"),
        ),
        (changed("boxCount", json!(0)), Some("data.boxCount")),
        (
            changed("serial", json!(9_223_372_036_854_775_808u64)),
            Some("data.serial"),
        ),
        (extra, Some("data")),
    ];
    let batch: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (data, _))| record(&floor, 300 + n as u32, "pallet_closed", data.clone()))
        .collect();
    let expected: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (_, field))| rejected(Some(&record_id(300 + n as u32)), "invalid_record", *field))
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    let [scan, mut closing] = boxed(&floor, &block, 1, Some("pallet-1"));
    closing["id"] = json!(record_id(101));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan, closing]).await[1],
        rejected(
            Some(&record_id(101)),
            "invalid_record",
            Some("data.palletId")
        )
    );
    assert_eq!(pallet_count(&admin).await, 0);
}

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

/// A batch waiting for the write lock checks the pallet's serial inside
/// its own transaction: a close another batch is still writing on the same
/// serial is seen, and the second close is `sscc_taken`.
#[tokio::test]
async fn a_pallet_close_waiting_for_the_write_lock_sees_the_serial_taken_meanwhile() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let closing = |n: u32| {
        record(
            &floor,
            200 + n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(n),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        )
    };
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &closing(1),
        &admin.app.state.timestamp(),
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        accepted(&record_id(201))
    );
    let second = [closing(2)];
    let mut waiting = Box::pin(receive_as(&admin, &floor.station, &second));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the batch answered while another writer held the lock"
    );
    holder.commit().await.unwrap();
    assert_eq!(
        waiting.await,
        (
            StatusCode::OK,
            json!({ "receipts": [rejected(Some(&record_id(202)), "sscc_taken", None)] })
        )
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(2)).await.unwrap()[3],
        Value::Null
    );
}

/// A batch is written whole or not at all: a pallet close that fails in the
/// database after its pallet row was written leaves nothing of the batch,
/// its boxes included, and the same batch goes through afterwards.
#[tokio::test]
async fn a_pallet_close_is_written_with_its_batch_or_not_at_all() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.push(record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    ));
    // The pallet block refuses its update after the pallet row was written.
    sqlx::query(
        "CREATE TRIGGER break_the_pallet_block BEFORE UPDATE ON sscc_blocks \
         WHEN NEW.consumed_through = 40 BEGIN SELECT RAISE(ABORT, 'broken'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(pallet_count(&admin).await, 0);
    assert_eq!(box_pallets(&admin).await, vec![]);
    assert_eq!(consumed_through(&admin, &block).await, None);
    sqlx::query("DROP TRIGGER break_the_pallet_block")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(consumed_through(&admin, &pallets).await, Some(40));
}

/// The schema holds what no pallet row may break: a closed pallet is whole
/// (its SSCC, block, serial and count together), its SSCC is a pallet's,
/// one SSCC and one serial of a block are one pallet, a pallet taken apart
/// was closed, and only a closed box is on a pallet.
#[tokio::test]
async fn the_schema_refuses_the_pallet_rows_no_fact_may_leave() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    batch.push(record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    ));
    batch.push(record(
        &floor,
        3,
        "scan",
        ok_scan(3, &box_id(3), &instant(3, 0)),
    ));
    receipts(&admin.app, &floor.key, &batch).await;
    let closed = pallet_id(1);
    let open = pallet_id(2);
    let refuses = |sql: String| {
        let pool = admin.app.state.pool.clone();
        async move {
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .err()
                .unwrap_or_else(|| panic!("the schema took {sql:?}"))
                .to_string()
        }
    };
    for (sql, constraint) in [
        (
            format!("UPDATE pallets SET sscc = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET block_id = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET serial = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET box_count_reported = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET box_count_reported = 0 WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!(
                "UPDATE pallets SET sscc = '{}' WHERE id = '{closed}'",
                sscc_of(0, "460068200", 40)
            ),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET disassembled_at = 'x' WHERE id = '{open}'"),
            "CHECK",
        ),
        (
            format!(
                "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 41, \
                 box_count_reported = 1 WHERE id = '{open}'",
                pallet_sscc(40),
                pallets["id"].as_str().unwrap()
            ),
            "UNIQUE",
        ),
        (
            format!(
                "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 40, \
                 box_count_reported = 1 WHERE id = '{open}'",
                pallet_sscc(41),
                pallets["id"].as_str().unwrap()
            ),
            "UNIQUE",
        ),
        (
            format!(
                "UPDATE boxes SET pallet_id = '{open}' WHERE id = '{}'",
                box_id(3)
            ),
            "CHECK",
        ),
    ] {
        let message = refuses(sql.clone()).await;
        assert!(message.contains(constraint), "{sql}: {message}");
    }
    // The rows the facts wrote are what the schema takes.
    sqlx::query(&format!(
        "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 41, \
         box_count_reported = 1 WHERE id = '{open}'",
        pallet_sscc(41),
        pallets["id"].as_str().unwrap()
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}
```

6. Создать `apps/standalone/proto/fixtures/facts-request-pallets.json`:

<!-- prettier-ignore -->
```json
{
  "records": [
    {
      "id": "9c6b2e4f-7a5d-4b1c-8e0f-4a6b8c0d2e54",
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
        "membershipDigest": "39e3dbefdfff2c243c8fad25abe0b1e435fcab76ff4d6041b8caa9b2afb8402e",
        "palletId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
      }
    },
    {
      "id": "ad7c3f5a-8b6e-4c2d-9f1a-5b7c9d1e3f65",
      "kind": "pallet_closed",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "sscc": "146006820000000409",
        "blockId": "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
        "serial": 40,
        "openedAt": "2026-10-08T06:21:47.302Z",
        "closedAt": "2026-10-08T09:02:11.540Z",
        "boxCount": 40
      }
    }
  ]
}
```

7. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate,
    SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

заменить на

<!-- prettier-ignore -->
```rust
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PasswordChange, PasswordSet,
    ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact,
    ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin,
    ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

8. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

/// A batch of facts and its receipts. The records' `data` stays JSON in the
/// envelope (the host reads it by kind, record by record); each one reads
```

заменить на

<!-- prettier-ignore -->
```rust
}

/// The pallet facts of a shift with pallets (plan ПЛ-Х), in their own
/// fixture so a station of stage 2a reads `facts-request.json` as before: a
/// box closed on the station's pallet, then the pallet's close with the SSCC
/// of the first serial of a pallet block.
#[test]
fn pallet_fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request-pallets.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(kinds, vec![FactKind::BoxClosed, FactKind::PalletClosed]);
    let boxed: BoxClosedFact = typed(&batch.records[0].data);
    assert_eq!(serde_json::to_value(&boxed).unwrap(), batch.records[0].data);
    let closed: PalletClosedFact = typed(&batch.records[1].data);
    assert_eq!(
        serde_json::to_value(&closed).unwrap(),
        batch.records[1].data
    );
    assert_eq!(boxed.pallet_id.as_deref(), Some(closed.pallet_id.as_str()));
    assert_eq!(closed.opened_at, boxed.closed_at);
    assert!(closed.sscc.starts_with("1460068200"));
    // A box of a shift without pallets names none, and writes none back.
    let plain: FactBatch = serde_json::from_value(fixture("facts-request.json")).unwrap();
    let plain_box: BoxClosedFact = typed(&plain.records[2].data);
    assert_eq!(plain_box.pallet_id, None);
    assert!(serde_json::to_value(&plain_box)
        .unwrap()
        .get("palletId")
        .is_none());
    // The pallet's close is read strictly, as every request.
    let mut extra = batch.records[1].data.clone();
    extra["boxes"] = serde_json::json!([]);
    assert!(serde_json::from_value::<PalletClosedFact>(extra).is_err());
}

/// A batch of facts and its receipts. The records' `data` stays JSON in the
/// envelope (the host reads it by kind, record by record); each one reads
```

9. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed => {
                serde_json::to_value(typed::<ShiftClosedFact>(&record.data)).unwrap()
            }
        };
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed => {
                serde_json::to_value(typed::<ShiftClosedFact>(&record.data)).unwrap()
            }
            FactKind::PalletClosed => {
                serde_json::to_value(typed::<PalletClosedFact>(&record.data)).unwrap()
            }
        };
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL — `0 passed; 11 failed`: вид `pallet_closed` хосту незнаком (`invalid_record`), а `box_closed` с `palletId` отвергается (`invalid_record` на `data`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — ошибка сборки: нет `PalletClosedFact` и `FactKind::PalletClosed`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// A scan names a box that is closed.
    pub const BOX_CLOSED: &str = "box_closed";
    /// A box closed with one SSCC is closed again with another.
    pub const BOX_ALREADY_CLOSED: &str = "box_already_closed";
    /// The box is not in the state the record needs (an exception or a
```

заменить на

<!-- prettier-ignore -->
```rust
    /// A scan names a box that is closed.
    pub const BOX_CLOSED: &str = "box_closed";
    /// A box closed with one SSCC (or on one pallet) is closed again with
    /// another.
    pub const BOX_ALREADY_CLOSED: &str = "box_already_closed";
    /// The box is not in the state the record needs (an exception or a
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// What a fact records (stage 2a spec §4.4): the kind tells the host how
/// to read the record's `data`. A kind added later is a new variant; a host
/// that does not know it answers the record `invalid_record`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
```

заменить на

<!-- prettier-ignore -->
```rust
/// What a fact records (stage 2a spec §4.4): the kind tells the host how
/// to read the record's `data`. A kind added later is a new variant; a host
/// that does not know it answers the record `invalid_record` and keeps that
/// receipt, so a new kind raises [`PROTOCOL_VERSION`] (the pallet kinds
/// came with protocol 3, plan ПЛ-Х).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    BoxException,
    ShiftClosed,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    BoxException,
    ShiftClosed,
    PalletClosed,
}

```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::BoxException => "box_exception",
            FactKind::ShiftClosed => "shift_closed",
        }
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::BoxException => "box_exception",
            FactKind::ShiftClosed => "shift_closed",
            FactKind::PalletClosed => "pallet_closed",
        }
    }
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// `itemCount` and `membershipDigest` (the domain's `boxMembershipDigestV1`
/// of the box's code hashes) are what the station saw; the host compares the
/// digest with its own items and keeps the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

заменить на

<!-- prettier-ignore -->
```rust
/// `itemCount` and `membershipDigest` (the domain's `boxMembershipDigestV1`
/// of the box's code hashes) are what the station saw; the host compares the
/// digest with its own items and keeps the result. In a shift with pallets
/// `palletId` names the station's pallet the box joined as it closed (plan
/// ПЛ-Х); a shift without pallets sends none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub item_count: u32,
    pub membership_digest: String,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub item_count: u32,
    pub membership_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_id: Option<String>,
}

/// `data` of a `pallet_closed` fact (plan ПЛ-Х): the station closed its
/// pallet, when it filled or early, with the SSCC of serial `serial` from
/// the pallet block (extension 1) `blockId` the host issued to it.
/// `openedAt` is when its first box closed, `boxCount` how many boxes the
/// station counted on it; the pallet's boxes are the boxes whose
/// `box_closed` named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletClosedFact {
    pub pallet_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub box_count: u32,
}

```

7. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::BoxException,
            FactKind::ShiftClosed,
        ];
        for kind in &kinds {
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::BoxException,
            FactKind::ShiftClosed,
            FactKind::PalletClosed,
        ];
        for kind in &kinds {
```

8. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
                | FactKind::BoxLabel
                | FactKind::BoxException
                | FactKind::ShiftClosed => {}
            }
        }
```

заменить на

<!-- prettier-ignore -->
```rust
                | FactKind::BoxLabel
                | FactKind::BoxException
                | FactKind::ShiftClosed
                | FactKind::PalletClosed => {}
            }
        }
```

9. Создать `apps/standalone/host/src/facts/blocks.rs`:

<!-- prettier-ignore -->
```rust
//! The SSCC blocks a closed box's or pallet's serial comes from (stage 2a
//! spec §4.3, plan ПЛ-Х): the serial lies in a live block of the record's
//! extension (a box 0, a pallet 1) and of the shift's issuer prefix, issued
//! to this device; a close raises the block's `consumed_through` to the
//! highest serial closed, in whatever order the closes arrive.

use sqlx::SqliteConnection;

use super::Context;
use crate::error::ApiError;

/// Whether `serial` lies in the block `block_id` that the host issued to
/// this device, of `extension` and the shift's issuer prefix, and did not
/// revoke.
pub async fn issued(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    block_id: &str,
    extension: u8,
    serial: i64,
) -> Result<bool, ApiError> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
         AND extension = ? AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
    )
    .bind(block_id)
    .bind(context.device_id)
    .bind(&context.shift.issuer_prefix)
    .bind(i64::from(extension))
    .bind(serial)
    .bind(serial)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(found.is_some())
}

/// Raise the block's `consumed_through` to `serial`, never lower it
/// (SQLite's `max(NULL, x)` is NULL, hence the `coalesce`).
pub async fn consume(
    conn: &mut SqliteConnection,
    block_id: &str,
    serial: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE sscc_blocks SET consumed_through = max(coalesce(consumed_through, ?1), ?1) \
         WHERE id = ?2",
    )
    .bind(serial)
    .bind(block_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
```

10. Создать `apps/standalone/host/src/facts/pallets.rs`:

<!-- prettier-ignore -->
```rust
//! Pallets as the facts tell them (plan ПЛ-Х): a pallet belongs to one
//! device in one shift, and its id is the device's own. A record that names
//! another device's or another shift's pallet is answered as if no such
//! pallet existed (`pallet_unknown`). The first closed box that names a
//! pallet opens it on the host; its `pallet_closed` closes it.

use markiro_proto::receipt_codes;
use sqlx::SqliteConnection;

use super::{Context, Failure, Reject};
use crate::error::ApiError;

/// A pallet of this device and this shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnPallet {
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
}

/// `no_pallets` unless the record's shift works with pallets.
pub fn require(context: &Context<'_>) -> Result<(), Reject> {
    if context.shift.pallets_enabled {
        Ok(())
    } else {
        Err(Reject::new(receipt_codes::NO_PALLETS))
    }
}

/// The pallet `id` when it is this device's in this shift, `None` when no
/// pallet has the id, and `pallet_unknown` when another device's or another
/// shift's pallet has it.
pub async fn find(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<Option<OwnPallet>, Failure> {
    type PalletRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<PalletRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at FROM pallets WHERE id = ?",
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
            Err(Reject::new(receipt_codes::PALLET_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at)) => Ok(Some(OwnPallet {
            closed_at,
            sscc,
            disassembled_at,
        })),
    }
}

/// Open the pallet `id` of this device and this shift, as its first closed
/// box tells it: `opened_at` is that box's close, which `pallet_closed`
/// replaces with the station's own.
pub async fn open(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
    opened_at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(opened_at)
    .bind(context.received_at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
```

11. Создать `apps/standalone/host/src/facts/pallet_closed.rs`:

<!-- prettier-ignore -->
```rust
//! `pallet_closed` facts (plan ПЛ-Х): a station closed its pallet, when it
//! filled or early, with an SSCC of a pallet block (extension 1) the host
//! issued to it. The SSCC is checked as a box's (`box_closed.rs`): by its
//! form and its block, never its check digit; one serial of a block is one
//! label. A pallet none of whose boxes reached the host opens closed, so its
//! printed SSCC is never issued twice; boxes that name it later join it.

use markiro_proto::{receipt_codes, PalletClosedFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{blocks, pallets, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a closed pallet have the shape the station gives them.
fn check(closed: &PalletClosedFact) -> Result<(), Reject> {
    for (field, id) in [
        ("data.palletId", &closed.pallet_id),
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
    if closed.box_count == 0 {
        return Err(Reject::field("data.boxCount"));
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: PalletClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&closed)?;
    let serial = i64::try_from(closed.serial).map_err(|_| Reject::field("data.serial"))?;
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &closed.pallet_id).await?;
    if let Some(sscc) = found.as_ref().and_then(|pallet| pallet.sscc.as_ref()) {
        // The same close sent again under another id changes nothing.
        return if *sscc == closed.sscc {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::PALLET_ALREADY_CLOSED).into())
        };
    }
    if !rules::names_serial(&closed.sscc, 1, &context.shift.issuer_prefix, closed.serial)
        || !blocks::issued(&mut *conn, context, &closed.block_id, 1, serial).await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    // One serial of a pallet block is one label: another pallet with this
    // SSCC, or on this serial of this block under any check digit, holds it.
    // A box's SSCC starts with 0 and comes from a box block, so no box can.
    let taken: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM pallets WHERE sscc = ? OR (block_id = ? AND serial = ?)")
            .bind(&closed.sscc)
            .bind(&closed.block_id)
            .bind(serial)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
         serial, box_count_reported, operator_id, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (id) DO UPDATE SET opened_at = excluded.opened_at, \
         closed_at = excluded.closed_at, sscc = excluded.sscc, block_id = excluded.block_id, \
         serial = excluded.serial, box_count_reported = excluded.box_count_reported, \
         operator_id = excluded.operator_id",
    )
    .bind(&closed.pallet_id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(&closed.opened_at)
    .bind(&closed.closed_at)
    .bind(&closed.sscc)
    .bind(&closed.block_id)
    .bind(serial)
    .bind(closed.box_count)
    .bind(context.operator_id)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
    Ok(Applied::accepted())
}
```

12. В `apps/standalone/host/src/facts/boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
    /// The pallet the box joined as it closed (plan ПЛ-Х).
    pub pallet_id: Option<String>,
}

```

13. В `apps/standalone/host/src/facts/boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Option<String>,
        Option<String>,
    );
    let row: Option<BoxRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at FROM boxes WHERE id = ?",
    )
    .bind(id)
```

заменить на

<!-- prettier-ignore -->
```rust
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<BoxRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at, pallet_id FROM boxes \
         WHERE id = ?",
    )
    .bind(id)
```

14. В `apps/standalone/host/src/facts/boxes.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Err(Reject::new(receipt_codes::BOX_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at)) => Ok(Some(OwnBox {
            closed_at,
            sscc,
            disassembled_at,
        })),
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            Err(Reject::new(receipt_codes::BOX_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at, pallet_id)) => Ok(Some(OwnBox {
            closed_at,
            sscc,
            disassembled_at,
            pallet_id,
        })),
    }
```

15. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! block's `consumed_through` and compares the station's digest of the box's
//! members with its own items, keeping the result for the shift's card
//! (stage 4).

use markiro_proto::{receipt_codes, BoxClosedFact};
```

заменить на

<!-- prettier-ignore -->
```rust
//! block's `consumed_through` and compares the station's digest of the box's
//! members with its own items, keeping the result for the shift's card
//! (stage 4). In a shift with pallets the box joins the pallet it names
//! (plan ПЛ-Х), which its first box opens on the host; the pallet's state
//! never refuses a box, since the station put the box on it.

use markiro_proto::{receipt_codes, BoxClosedFact};
```

16. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
use sqlx::SqliteConnection;

use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;
```

заменить на

<!-- prettier-ignore -->
```rust
use sqlx::SqliteConnection;

use super::{blocks, boxes, pallets, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;
```

17. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        return Err(Reject::field("data.membershipDigest"));
    }
    Ok(())
}
```

заменить на

<!-- prettier-ignore -->
```rust
        return Err(Reject::field("data.membershipDigest"));
    }
    if let Some(pallet_id) = &closed.pallet_id {
        if validate::client_uuid("data.palletId", pallet_id).is_err() {
            return Err(Reject::field("data.palletId"));
        }
    }
    Ok(())
}
```

18. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
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
```

заменить на

<!-- prettier-ignore -->
```rust
    check(&closed)?;
    let serial = i64::try_from(closed.serial).map_err(|_| Reject::field("data.serial"))?;
    if closed.pallet_id.is_some() {
        pallets::require(context)?;
    }
    let found = boxes::find(&mut *conn, context, &closed.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if let Some(sscc) = &found.sscc {
        // The same close sent again under another id changes nothing; on
        // another pallet it is another close.
        return if *sscc == closed.sscc && found.pallet_id == closed.pallet_id {
            Ok(Applied::accepted())
        } else {
```

19. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        };
    }
    if !rules::names_serial(&closed.sscc, 0, &context.shift.issuer_prefix, closed.serial) {
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
```

заменить на

<!-- prettier-ignore -->
```rust
        };
    }
    if !rules::names_serial(&closed.sscc, 0, &context.shift.issuer_prefix, closed.serial)
        || !blocks::issued(&mut *conn, context, &closed.block_id, 0, serial).await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
```

20. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT code_hash FROM box_items \
```

заменить на

<!-- prettier-ignore -->
```rust
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    // The pallet is this device's in this shift (`pallet_unknown`
    // otherwise), or new.
    let new_pallet = match &closed.pallet_id {
        Some(pallet_id) => pallets::find(&mut *conn, context, pallet_id)
            .await?
            .is_none()
            .then_some(pallet_id),
        None => None,
    };
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT code_hash FROM box_items \
```

21. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .map_err(ApiError::internal)?;
    let matches = rules::box_membership_digest(&members) == closed.membership_digest;
    sqlx::query(
        "UPDATE boxes SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
         item_count_reported = ?, membership_digest = ?, digest_matches = ?, operator_id = ? \
         WHERE id = ?",
    )
    .bind(&closed.opened_at)
```

заменить на

<!-- prettier-ignore -->
```rust
    .map_err(ApiError::internal)?;
    let matches = rules::box_membership_digest(&members) == closed.membership_digest;
    if let Some(pallet_id) = new_pallet {
        pallets::open(&mut *conn, context, pallet_id, &closed.closed_at).await?;
    }
    sqlx::query(
        "UPDATE boxes SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
         item_count_reported = ?, membership_digest = ?, digest_matches = ?, operator_id = ?, \
         pallet_id = ? WHERE id = ?",
    )
    .bind(&closed.opened_at)
```

22. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
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

заменить на

<!-- prettier-ignore -->
```rust
    .bind(matches)
    .bind(context.operator_id)
    .bind(&closed.pallet_id)
    .bind(&closed.box_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
    Ok(Applied::accepted())
}
```

23. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! sends it again.

pub mod box_closed;
pub mod box_label;
pub mod boxes;
pub mod exception;
pub mod registry;
pub mod rules;
```

заменить на

<!-- prettier-ignore -->
```rust
//! sends it again.

pub mod blocks;
pub mod box_closed;
pub mod box_label;
pub mod boxes;
pub mod exception;
pub mod pallet_closed;
pub mod pallets;
pub mod registry;
pub mod rules;
```

24. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// The SSCC issuer prefix the shift's snapshot froze.
    pub issuer_prefix: String,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    /// The SSCC issuer prefix the shift's snapshot froze.
    pub issuer_prefix: String,
    /// Whether the shift works with pallets (plan ПЛ-Х); fixed once open.
    pub pallets_enabled: bool,
}

```

25. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
```

заменить на

<!-- prettier-ignore -->
```rust
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletClosed => pallet_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
```

26. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Option<String>,
        bool,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         EXISTS (SELECT 1 FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
```

заменить на

<!-- prettier-ignore -->
```rust
        Option<String>,
        bool,
        bool,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         s.pallets_enabled, \
         EXISTS (SELECT 1 FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
```

27. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .await
    .map_err(ApiError::internal)?;
    let Some((status, month_key, seq, created_from, gtin14, issuer_prefix, entered)) = row else {
        return Ok(None);
    };
```

заменить на

<!-- prettier-ignore -->
```rust
    .await
    .map_err(ApiError::internal)?;
    let Some((
        status,
        month_key,
        seq,
        created_from,
        gtin14,
        issuer_prefix,
        pallets_enabled,
        entered,
    )) = row
    else {
        return Ok(None);
    };
```

28. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        gtin14: gtin14.ok_or_else(snapshot)?,
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
    })))
}
```

заменить на

<!-- prettier-ignore -->
```rust
        gtin14: gtin14.ok_or_else(snapshot)?,
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
        pallets_enabled,
    })))
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --test fact_rules --test codes --test office_shifts --test device_shifts --offline --locked`
Expected: PASS — `codes` 8, `device_shifts` 20, `fact_rules` 13, `facts` 36, `office_shifts` 30, `pallet_facts` 11.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 45.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
nothing.

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
`routes/codes.rs`; 64 lower-case hex digits, `validation_failed` on
```

заменить на

<!-- prettier-ignore -->
```text
nothing.

Pallets (plan ПЛ-Х; `facts/pallets.rs`, `facts/pallet_closed.rs`,
`facts/blocks.rs`; migration `0012_pallets.sql`). In a shift with pallets a
`box_closed` names the station's pallet the box joined as it closed
(`palletId`); a shift without pallets answers it, and every pallet fact,
`no_pallets`. The first closed box that names a pallet opens it on the host
(`opened_at` is that box's `closedAt`); a pallet of another device or
another shift is `pallet_unknown`. The pallet's state never refuses a box:
the station put the box there, and a box whose close comes again under a
new id after a refusal joins the pallet it named, closed or not. A box
closed on one pallet and sent again on another, or without its pallet, is
`box_already_closed`. A `pallet_closed` closes the pallet with an SSCC of 18
digits whose first 17 are the pallet extension `1`, the snapshot's prefix
and `serial`, where `serial` lies in a live pallet block (extension 1) that
the host issued to this device (`sscc_not_issued`), and no other pallet
carries the SSCC or is closed on that serial of that block (`sscc_taken`;
the unique indexes `pallets_sscc` and `pallets_block_serial` back it, and a
box's SSCC starts with `0` from a box block, so boxes and pallets never meet
on one). It keeps the station's `openedAt`, `closedAt`, `boxCount`
(`box_count_reported`) and operator and raises the pallet block's
`consumed_through` (`blocks::consume`, shared with `box_closed`). A pallet
none of whose boxes reached the host opens closed, so its printed SSCC is
held. The same close again is accepted with nothing written; another SSCC
is `pallet_already_closed`. Which boxes a pallet holds is derived — the
closed boxes whose `pallet_id` names it, not taken apart — and never
stored; `box_count_reported` is evidence beside it, which the reports of
plan О-Х compare. One open pallet per station and shift is the station's
rule, not the host's: a second open pallet of a device is kept, since a
refusal would fail a batch the station can never get past.

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
`routes/codes.rs`; 64 lower-case hex digits, `validation_failed` on
```

- [ ] **Step 6: Мутации**

М1 — паллета закрывается расширением короба. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
rules::names_serial(&closed.sscc, 1,
```

заменить на

<!-- prettier-ignore -->
```rust
rules::names_serial(&closed.sscc, 0,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`, `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down` и ещё четыре теста набора. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — серия паллеты ищется в блоке коробов. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
blocks::issued(&mut *conn, context, &closed.block_id, 1, serial)
```

заменить на

<!-- prettier-ignore -->
```rust
blocks::issued(&mut *conn, context, &closed.block_id, 0, serial)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`, `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down` и ещё четыре теста набора. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — номер блока занят только тем же SSCC. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
"SELECT 1 FROM pallets WHERE sscc = ? OR (block_id = ? AND serial = ?)"
```

заменить на

<!-- prettier-ignore -->
```rust
"SELECT 1 FROM pallets WHERE sscc = ? OR (block_id = ? AND serial = ? AND 0)"
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — паллета другого устройства своя. В `apps/standalone/host/src/facts/pallets.rs` фрагмент

<!-- prettier-ignore -->
```rust
if shift_id != context.shift.id || device_id != context.device_id =>
```

заменить на

<!-- prettier-ignore -->
```rust
if shift_id != context.shift.id =>
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_of_another_device_or_shift_is_unknown`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — паллета другой смены своя. В `apps/standalone/host/src/facts/pallets.rs` фрагмент

<!-- prettier-ignore -->
```rust
if shift_id != context.shift.id || device_id != context.device_id =>
```

заменить на

<!-- prettier-ignore -->
```rust
if device_id != context.device_id =>
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_of_another_device_or_shift_is_unknown`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — повтор закрытия короба не сверяет паллету. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
if *sscc == closed.sscc && found.pallet_id == closed.pallet_id {
```

заменить на

<!-- prettier-ignore -->
```rust
if *sscc == closed.sscc {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_box_closed_again_on_another_pallet_is_refused`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — смена без паллет принимает паллету короба. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if closed.pallet_id.is_some() {
        pallets::require(context)?;
    }
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_shift_without_pallets_takes_no_pallet`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — повтор закрытия паллеты любым SSCC. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
        return if *sscc == closed.sscc {
```

заменить на

<!-- prettier-ignore -->
```rust
        return if true {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — `consumed_through` опускается. В `apps/standalone/host/src/facts/blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
SET consumed_through = max(coalesce(consumed_through, ?1), ?1)
```

заменить на

<!-- prettier-ignore -->
```rust
SET consumed_through = min(coalesce(consumed_through, ?1), ?1)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down`, `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — открытие паллеты станции не хранится. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
ON CONFLICT (id) DO UPDATE SET opened_at = excluded.opened_at, \
         closed_at
```

заменить на

<!-- prettier-ignore -->
```rust
ON CONFLICT (id) DO UPDATE SET \
         closed_at
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`. Восстановить файл, `cmp` молчит, хеш прежний.

М11 — короб не присоединяется к паллете. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(&closed.pallet_id)
    .bind(&closed.box_id)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(None::<String>)
    .bind(&closed.box_id)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_box_closed_again_on_another_pallet_is_refused`, `a_pallet_closed_before_its_boxes_opens_closed_and_its_boxes_join_it_later`, `a_pallet_of_another_device_or_shift_is_unknown`, `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`. Восстановить файл, `cmp` молчит, хеш прежний.

М12 — отозванный блок. В `apps/standalone/host/src/facts/blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
AND extension = ? AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL
```

заменить на

<!-- prettier-ignore -->
```rust
AND extension = ? AND from_serial <= ? AND to_serial >= ?
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`. Восстановить файл, `cmp` молчит, хеш прежний.

М13 — счёт коробов станции не хранится. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(closed.box_count)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(1)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`. Восстановить файл, `cmp` молчит, хеш прежний.

М14 — первая серия блока не в блоке. В `apps/standalone/host/src/facts/blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
AND extension = ? AND from_serial <= ? AND
```

заменить на

<!-- prettier-ignore -->
```rust
AND extension = ? AND from_serial < ? AND
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --no-fail-fast --offline --locked`
Expected: FAIL `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift` и ещё 19 тестов обоих наборов. Восстановить файл, `cmp` молчит, хеш прежний.

М15 — последняя серия блока не в блоке. В `apps/standalone/host/src/facts/blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
AND to_serial >= ? AND revoked_at
```

заменить на

<!-- prettier-ignore -->
```rust
AND to_serial > ? AND revoked_at
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --no-fail-fast --offline --locked`
Expected: FAIL `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift`, `a_serial_must_lie_in_the_block_the_record_names_and_in_a_box_block_of_the_shifts_prefix`. Восстановить файл, `cmp` молчит, хеш прежний.

М16 — признак паллет смены не проверяется. В `apps/standalone/host/src/facts/pallets.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if context.shift.pallets_enabled {
```

заменить на

<!-- prettier-ignore -->
```rust
    if true {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_shift_without_pallets_takes_no_pallet`. Восстановить файл, `cmp` молчит, хеш прежний.

М17 — первый короб не открывает паллету. В `apps/standalone/host/src/facts/box_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(pallet_id) = new_pallet {
        pallets::open(&mut *conn, context, pallet_id, &closed.closed_at).await?;
    }
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial`, `a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label`, `a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down` и ещё пять тестов набора (ошибка внешнего ключа — `500`). Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request-pallets.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/blocks.rs apps/standalone/host/src/facts/pallets.rs apps/standalone/host/src/facts/pallet_closed.rs apps/standalone/host/src/facts/boxes.rs apps/standalone/host/src/facts/box_closed.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/tests/pallet_facts.rs apps/standalone/host/tests/support/app.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request-pallets.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a box closes onto its station's pallet, and a pallet closes with an SSCC of its device's pallet block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `pallet_label` и `pallet_exception` — проверка этикетки паллеты, перепечатка и расформирование

Проверка этикетки паллеты повторяет проверку этикетки короба: закрытая паллета этого устройства и смены, `verified` или `skipped` с моментом станции; открытая — `pallet_state`, незнакомая — `pallet_unknown`. Исключение паллеты — `reprint` или `disassemble` закрытой нерасформированной паллеты (`pallet_state` иначе). Причина — код из списка исключений коробов для своего вида, слова только при `other`. Каждое исключение пишет одну строку в `pallet_exceptions`. Расформирование ставит `disassembled_at`; короба остаются закрытыми и сохраняют `pallet_id`.

**Files:**

- Create: `apps/standalone/host/src/facts/pallet_label.rs`, `apps/standalone/host/src/facts/pallet_exception.rs`
- Modify: `apps/standalone/host/src/facts/mod.rs`, `apps/standalone/proto/src/lib.rs` (`FactKind::{PalletLabel, PalletException}`, `PalletLabelFact`, `PalletExceptionKind`, `PalletExceptionFact`), `apps/standalone/proto/fixtures/facts-request-pallets.json`
- Test: `apps/standalone/host/tests/pallet_facts.rs`, `apps/standalone/proto/tests/fixtures.rs`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: `pallets::{require, find}` (задача 4), `validate::exception_reason_text`, `exception_reasons` (2a2).
- Produces: `FactKind::PalletLabel` (`"pallet_label"`), `FactKind::PalletException` (`"pallet_exception"`); `markiro_proto::PalletLabelFact { pallet_id, outcome: LabelOutcome, at }`, `PalletExceptionKind::{Reprint, Disassemble}` (`as_str`), `PalletExceptionFact { exception, pallet_id, reason_code: String, reason_text: Option<String>, occurred_at }`.

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/pallet_facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .unwrap();
}

```

заменить на

<!-- prettier-ignore -->
```rust
    .unwrap();
}

/// Two closed pallets (1 with box 1, 2 with box 2), an open one (3 with
/// box 3), as the floor's first facts.
async fn three_pallets(admin: &Admin, floor: &Floor, block: &Value, pallets: &Value) {
    let mut batch = Vec::new();
    for n in 1..=3 {
        batch.extend(boxed(floor, block, n, Some(&pallet_id(n))));
    }
    for n in 1..=2 {
        batch.push(record(
            floor,
            200 + n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(n),
                pallets,
                39 + u64::from(n),
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        ));
    }
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// A pallet's label checks and when it was taken apart: `(verified at,
/// skipped at, disassembled at)`.
async fn pallet_marks(admin: &Admin, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT print_verified_at, print_skipped_at, disassembled_at FROM pallets WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

fn label(pallet: &str, outcome: &str, at: &str) -> Value {
    json!({ "palletId": pallet, "outcome": outcome, "at": at })
}

fn pallet_exception(kind: &str, pallet: &str, reason: &str, text: Value, at: &str) -> Value {
    json!({
        "exception": kind, "palletId": pallet, "reasonCode": reason, "reasonText": text,
        "occurredAt": at
    })
}

/// A label check marks a closed pallet of this device and shift with the
/// station's instant, `verified` or `skipped`, a later check again; an open
/// pallet is `pallet_state`, an unknown one `pallet_unknown`.
#[tokio::test]
async fn a_pallet_label_check_marks_a_closed_pallet_of_its_own() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let batch = vec![
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(160, 0)),
        ),
        record(
            &floor,
            302,
            "pallet_label",
            label(&pallet_id(2), "skipped", &instant(161, 0)),
        ),
        record(
            &floor,
            303,
            "pallet_label",
            label(&pallet_id(3), "verified", &instant(162, 0)),
        ),
        record(
            &floor,
            304,
            "pallet_label",
            label(&pallet_id(9), "verified", &instant(163, 0)),
        ),
        record(
            &floor,
            305,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(170, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(301)),
            accepted(&record_id(302)),
            rejected(Some(&record_id(303)), "pallet_state", None),
            rejected(Some(&record_id(304)), "pallet_unknown", None),
            accepted(&record_id(305)),
        ]
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(1)).await,
        (Some(instant(170, 0)), None, None)
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(2)).await,
        (None, Some(instant(161, 0)), None)
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(3)).await,
        (None, None, None)
    );
    // Its form: the pallet's id and the instant.
    let bad = vec![
        record(
            &floor,
            306,
            "pallet_label",
            label("pallet-1", "verified", &instant(171, 0)),
        ),
        record(
            &floor,
            307,
            "pallet_label",
            label(&pallet_id(1), "verified", "2026-10-08T06:02:51Z"),
        ),
        record(
            &floor,
            308,
            "pallet_label",
            label(&pallet_id(1), "seen", &instant(171, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &bad).await,
        vec![
            rejected(
                Some(&record_id(306)),
                "invalid_record",
                Some("data.palletId")
            ),
            rejected(Some(&record_id(307)), "invalid_record", Some("data.at")),
            rejected(Some(&record_id(308)), "invalid_record", Some("data")),
        ]
    );
}

/// A reprint or a disassembly takes a closed pallet not taken apart and a
/// reason code of its kind, with words only for `other`; a disassembly
/// marks the pallet and leaves its boxes as they are; each is kept, field
/// by field.
#[tokio::test]
async fn a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let exception = |n: u32, data: Value| record(&floor, n, "pallet_exception", data);
    let batch = vec![
        exception(
            401,
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "damaged_label",
                Value::Null,
                &instant(160, 0),
            ),
        ),
        exception(
            402,
            pallet_exception(
                "disassemble",
                &pallet_id(1),
                "other",
                json!("  Перепутали товар  "),
                &instant(161, 0),
            ),
        ),
        exception(
            403,
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "damaged_label",
                Value::Null,
                &instant(162, 0),
            ),
        ),
        exception(
            404,
            pallet_exception(
                "disassemble",
                &pallet_id(1),
                "wrong_product",
                Value::Null,
                &instant(163, 0),
            ),
        ),
        exception(
            405,
            pallet_exception(
                "reprint",
                &pallet_id(3),
                "printer_jam",
                Value::Null,
                &instant(164, 0),
            ),
        ),
        exception(
            406,
            pallet_exception(
                "reprint",
                &pallet_id(9),
                "printer_jam",
                Value::Null,
                &instant(165, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(401)),
            accepted(&record_id(402)),
            rejected(Some(&record_id(403)), "pallet_state", None),
            rejected(Some(&record_id(404)), "pallet_state", None),
            rejected(Some(&record_id(405)), "pallet_state", None),
            rejected(Some(&record_id(406)), "pallet_unknown", None),
        ]
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(1)).await,
        (None, None, Some(instant(161, 0)))
    );
    // The pallet's box stays on it, closed and not taken apart; the SSCC
    // stays the pallet's.
    let (pallet, disassembled): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT pallet_id, disassembled_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((pallet, disassembled), (Some(pallet_id(1)), None));
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[4],
        json!(pallet_sscc(40))
    );
    type ExceptionRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<ExceptionRow> = sqlx::query_as(
        "SELECT record_id, kind, reason_code, reason_text, shift_id, device_id, operator_id, \
         occurred_at, received_at FROM pallet_exceptions ORDER BY occurred_at",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let at = admin.app.state.timestamp();
    assert_eq!(
        rows,
        vec![
            (
                record_id(401),
                "reprint".to_owned(),
                "damaged_label".to_owned(),
                None,
                floor.shift.clone(),
                floor.station.clone(),
                Some(OPERATOR.to_owned()),
                instant(160, 0),
                at.clone()
            ),
            (
                record_id(402),
                "disassemble".to_owned(),
                "other".to_owned(),
                Some("Перепутали товар".to_owned()),
                floor.shift.clone(),
                floor.station.clone(),
                Some(OPERATOR.to_owned()),
                instant(161, 0),
                at
            ),
        ]
    );
    // The reason fits the kind; words go only with `other`.
    let refused = vec![
        exception(
            411,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "wrong_product",
                Value::Null,
                &instant(170, 0),
            ),
        ),
        exception(
            412,
            pallet_exception(
                "disassemble",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                &instant(171, 0),
            ),
        ),
        exception(
            413,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "printer_jam",
                json!("Застрял"),
                &instant(172, 0),
            ),
        ),
        exception(
            414,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "other",
                json!("   "),
                &instant(173, 0),
            ),
        ),
        exception(
            415,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "other",
                json!("я".repeat(201)),
                &instant(174, 0),
            ),
        ),
        exception(
            416,
            pallet_exception(
                "reprint",
                "pallet-2",
                "printer_jam",
                Value::Null,
                &instant(175, 0),
            ),
        ),
        exception(
            417,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                "today",
            ),
        ),
        exception(
            418,
            pallet_exception(
                "undo",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                &instant(176, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(411)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(412)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(413)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(414)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(415)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(416)),
                "invalid_record",
                Some("data.palletId")
            ),
            rejected(
                Some(&record_id(417)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(Some(&record_id(418)), "invalid_record", Some("data")),
        ]
    );
    // 200 characters of `other` are taken.
    let longest = exception(
        419,
        pallet_exception(
            "reprint",
            &pallet_id(2),
            "other",
            json!("я".repeat(200)),
            &instant(177, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[longest]).await,
        vec![accepted(&record_id(419))]
    );
    // A label check of the pallet taken apart is still taken (it is closed).
    let check = record(
        &floor,
        420,
        "pallet_label",
        label(&pallet_id(1), "verified", &instant(180, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[check]).await,
        vec![accepted(&record_id(420))]
    );
}

/// A shift without pallets answers a label check and an exception of a
/// pallet `no_pallets`.
#[tokio::test]
async fn a_shift_without_pallets_answers_pallet_checks_and_exceptions_no_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let batch = vec![
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(160, 0)),
        ),
        record(
            &floor,
            401,
            "pallet_exception",
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "printer_jam",
                Value::Null,
                &instant(161, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(301)), "no_pallets", None),
            rejected(Some(&record_id(401)), "no_pallets", None),
        ]
    );
}

/// The schema keeps a pallet exception whole: one row per record, a known
/// kind, a reason code, and words only with `other`.
#[tokio::test]
async fn the_schema_refuses_the_pallet_exception_rows_no_fact_may_leave() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let reprint = record(
        &floor,
        401,
        "pallet_exception",
        pallet_exception(
            "reprint",
            &pallet_id(1),
            "printer_jam",
            Value::Null,
            &instant(160, 0),
        ),
    );
    receipts(&admin.app, &floor.key, &[reprint]).await;
    let insert = |record: &str, kind: &str, reason: &str, text: &str| {
        format!(
            "INSERT INTO pallet_exceptions (id, record_id, kind, pallet_id, reason_code, \
             reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
             SELECT '{record}-row', '{record}', '{kind}', pallet_id, '{reason}', {text}, \
             shift_id, device_id, operator_id, occurred_at, received_at FROM pallet_exceptions"
        )
    };
    for (sql, constraint) in [
        (
            insert(&record_id(401), "reprint", "printer_jam", "NULL"),
            "UNIQUE",
        ),
        (
            insert(&record_id(402), "undo", "printer_jam", "NULL"),
            "CHECK",
        ),
        (
            insert(&record_id(403), "reprint", "printer_jam", "'Застрял'"),
            "CHECK",
        ),
    ] {
        let message = sqlx::query(&sql)
            .execute(&admin.app.state.pool)
            .await
            .err()
            .unwrap_or_else(|| panic!("the schema took {sql:?}"))
            .to_string();
        assert!(message.contains(constraint), "{sql}: {message}");
    }
    sqlx::query(&insert(
        &record_id(404),
        "disassemble",
        "other",
        "'Перепутали'",
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

```

2. В `apps/standalone/proto/fixtures/facts-request-pallets.json` фрагмент

<!-- prettier-ignore -->
```json
        "boxCount": 40
      }
    }
  ]
```

заменить на

<!-- prettier-ignore -->
```json
        "boxCount": 40
      }
    },
    {
      "id": "be8d4a6b-9c7f-4d3e-8a2b-6c8d0e2f4a76",
      "kind": "pallet_label",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "outcome": "verified",
        "at": "2026-10-08T09:02:30.004Z"
      }
    },
    {
      "id": "cf9e5b7c-0d8a-4e4f-9b3c-7d9e1f3a5b87",
      "kind": "pallet_exception",
      "shiftId": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "exception": "disassemble",
        "palletId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "reasonCode": "other",
        "reasonText": "Паллета собрана не на тот заказ",
        "occurredAt": "2026-10-08T09:40:00.000Z"
      }
    }
  ]
```

3. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PasswordChange, PasswordSet,
    ProductCreate, ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact,
    ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin,
    ShiftStatus, ShiftUpdate, SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate,
    SsccState, TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

заменить на

<!-- prettier-ignore -->
```rust
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PalletClosedFact, PalletExceptionFact,
    PalletExceptionKind, PalletLabelFact, PasswordChange, PasswordSet, ProductCreate, ProductGroup,
    ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict, ShiftClose,
    ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate, SiteRecord,
    SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
```

4. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// The pallet facts of a shift with pallets (plan ПЛ-Х), in their own
/// fixture so a station of stage 2a reads `facts-request.json` as before: a
/// box closed on the station's pallet, then the pallet's close with the SSCC
/// of the first serial of a pallet block.
#[test]
fn pallet_fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request-pallets.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(kinds, vec![FactKind::BoxClosed, FactKind::PalletClosed]);
    let boxed: BoxClosedFact = typed(&batch.records[0].data);
    assert_eq!(serde_json::to_value(&boxed).unwrap(), batch.records[0].data);
```

заменить на

<!-- prettier-ignore -->
```rust
/// The pallet facts of a shift with pallets (plan ПЛ-Х), in their own
/// fixture so a station of stage 2a reads `facts-request.json` as before: a
/// box closed on the station's pallet, the pallet's close with the SSCC of
/// the first serial of a pallet block, its label checked, then the pallet
/// taken apart for a reason in words.
#[test]
fn pallet_fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request-pallets.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FactKind::BoxClosed,
            FactKind::PalletClosed,
            FactKind::PalletLabel,
            FactKind::PalletException
        ]
    );
    let boxed: BoxClosedFact = typed(&batch.records[0].data);
    assert_eq!(serde_json::to_value(&boxed).unwrap(), batch.records[0].data);
```

5. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
    extra["boxes"] = serde_json::json!([]);
    assert!(serde_json::from_value::<PalletClosedFact>(extra).is_err());
}

```

заменить на

<!-- prettier-ignore -->
```rust
    extra["boxes"] = serde_json::json!([]);
    assert!(serde_json::from_value::<PalletClosedFact>(extra).is_err());
    let checked: PalletLabelFact = typed(&batch.records[2].data);
    assert_eq!(
        (&checked.pallet_id, checked.outcome),
        (&closed.pallet_id, LabelOutcome::Verified)
    );
    let apart: PalletExceptionFact = typed(&batch.records[3].data);
    assert_eq!(
        (
            apart.exception,
            &apart.pallet_id,
            apart.reason_code.as_str(),
            apart.exception.as_str()
        ),
        (
            PalletExceptionKind::Disassemble,
            &closed.pallet_id,
            markiro_proto::exception_reasons::OTHER,
            "disassemble"
        )
    );
    // A pallet exception always names a reason; `undo` and `clear` are a
    // box's.
    let mut without = batch.records[3].data.clone();
    without.as_object_mut().unwrap().remove("reasonCode");
    assert!(serde_json::from_value::<PalletExceptionFact>(without).is_err());
    let mut undo = batch.records[3].data.clone();
    undo["exception"] = serde_json::json!("undo");
    assert!(serde_json::from_value::<PalletExceptionFact>(undo).is_err());
}

```

6. В `apps/standalone/proto/tests/fixtures.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::PalletClosed => {
                serde_json::to_value(typed::<PalletClosedFact>(&record.data)).unwrap()
            }
        };
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::PalletClosed => {
                serde_json::to_value(typed::<PalletClosedFact>(&record.data)).unwrap()
            }
            FactKind::PalletLabel => {
                serde_json::to_value(typed::<PalletLabelFact>(&record.data)).unwrap()
            }
            FactKind::PalletException => {
                serde_json::to_value(typed::<PalletExceptionFact>(&record.data)).unwrap()
            }
        };
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL — `11 passed; 4 failed`: `a_pallet_label_check_marks_a_closed_pallet_of_its_own`, `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`, `a_shift_without_pallets_answers_pallet_checks_and_exceptions_no_pallets`, `the_schema_refuses_the_pallet_exception_rows_no_fact_may_leave` (виды хосту ещё незнакомы).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — ошибка сборки: нет `FactKind::PalletLabel`, `PalletLabelFact`, `PalletExceptionFact`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    ShiftClosed,
    PalletClosed,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    ShiftClosed,
    PalletClosed,
    PalletLabel,
    PalletException,
}

```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed => "shift_closed",
            FactKind::PalletClosed => "pallet_closed",
        }
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed => "shift_closed",
            FactKind::PalletClosed => "pallet_closed",
            FactKind::PalletLabel => "pallet_label",
            FactKind::PalletException => "pallet_exception",
        }
    }
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub closed_at: String,
    pub box_count: u32,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub closed_at: String,
    pub box_count: u32,
}

/// `data` of a `pallet_label` fact (plan ПЛ-Х): the check of a closed
/// pallet's label, as a box's ([`BoxLabelFact`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletLabelFact {
    pub pallet_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a pallet exception does (the cloud station's two).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PalletExceptionKind {
    /// Print a closed pallet's label again.
    Reprint,
    /// Take a closed pallet apart; its SSCC stays used and its boxes stay
    /// as they are.
    Disassemble,
}

impl PalletExceptionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PalletExceptionKind::Reprint => "reprint",
            PalletExceptionKind::Disassemble => "disassemble",
        }
    }
}

/// `data` of a `pallet_exception` fact (plan ПЛ-Х): a reason code of
/// [`exception_reasons`] for the kind (the box exceptions' lists), and
/// words only with `other`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletExceptionFact {
    pub exception: PalletExceptionKind,
    pub pallet_id: String,
    pub reason_code: String,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed,
            FactKind::PalletClosed,
        ];
        for kind in &kinds {
```

заменить на

<!-- prettier-ignore -->
```rust
            FactKind::ShiftClosed,
            FactKind::PalletClosed,
            FactKind::PalletLabel,
            FactKind::PalletException,
        ];
        for kind in &kinds {
```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
                | FactKind::BoxException
                | FactKind::ShiftClosed
                | FactKind::PalletClosed => {}
            }
        }
```

заменить на

<!-- prettier-ignore -->
```rust
                | FactKind::BoxException
                | FactKind::ShiftClosed
                | FactKind::PalletClosed
                | FactKind::PalletLabel
                | FactKind::PalletException => {}
            }
        }
```

6. Создать `apps/standalone/host/src/facts/pallet_label.rs`:

<!-- prettier-ignore -->
```rust
//! `pallet_label` facts (plan ПЛ-Х): the operator checked a closed pallet's
//! printed label (scanned its SSCC) or skipped the check, as a box's
//! (`box_label.rs`). The host keeps when.

use markiro_proto::{receipt_codes, LabelOutcome, PalletLabelFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{pallets, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let label: PalletLabelFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    if validate::client_uuid("data.palletId", &label.pallet_id).is_err() {
        return Err(Reject::field("data.palletId").into());
    }
    if rules::device_instant(&label.at).is_none() {
        return Err(Reject::field("data.at").into());
    }
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &label.pallet_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN))?;
    if found.closed_at.is_none() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    let column = match label.outcome {
        LabelOutcome::Verified => "print_verified_at",
        LabelOutcome::Skipped => "print_skipped_at",
    };
    sqlx::query(&format!("UPDATE pallets SET {column} = ? WHERE id = ?"))
        .bind(&label.at)
        .bind(&label.pallet_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
```

7. Создать `apps/standalone/host/src/facts/pallet_exception.rs`:

<!-- prettier-ignore -->
```rust
//! `pallet_exception` facts (plan ПЛ-Х): print a closed pallet's label
//! again (`reprint`) or take a closed pallet apart (`disassemble`), as the
//! cloud station does. A pallet taken apart keeps its SSCC, which no other
//! pallet takes; its boxes stay as they are (each keeps its `pallet_id`),
//! and the pallet no longer counts. Reasons are the box exceptions' codes,
//! with words only for `other`.

use markiro_proto::{exception_reasons, receipt_codes, PalletExceptionFact, PalletExceptionKind};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{pallets, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a pallet exception agree with its kind; returns the
/// reason's words trimmed.
fn check(exception: &PalletExceptionFact) -> Result<Option<String>, Reject> {
    if validate::client_uuid("data.palletId", &exception.pallet_id).is_err() {
        return Err(Reject::field("data.palletId"));
    }
    if rules::device_instant(&exception.occurred_at).is_none() {
        return Err(Reject::field("data.occurredAt"));
    }
    let reasons = match exception.exception {
        PalletExceptionKind::Reprint => exception_reasons::REPRINT,
        PalletExceptionKind::Disassemble => exception_reasons::DISASSEMBLE,
    };
    if !reasons.contains(&exception.reason_code.as_str()) {
        return Err(Reject::field("data.reasonCode"));
    }
    match (exception.reason_code.as_str(), &exception.reason_text) {
        (_, None) => Ok(None),
        (exception_reasons::OTHER, Some(text)) => {
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
    let exception: PalletExceptionFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let reason_text = check(&exception)?;
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &exception.pallet_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN))?;
    if found.closed_at.is_none() || found.disassembled_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    if exception.exception == PalletExceptionKind::Disassemble {
        sqlx::query("UPDATE pallets SET disassembled_at = ? WHERE id = ?")
            .bind(&exception.occurred_at)
            .bind(&exception.pallet_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query(
        "INSERT INTO pallet_exceptions (id, record_id, kind, pallet_id, reason_code, \
         reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(exception.exception.as_str())
    .bind(&exception.pallet_id)
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

8. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod exception;
pub mod pallet_closed;
pub mod pallets;
pub mod registry;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod exception;
pub mod pallet_closed;
pub mod pallet_exception;
pub mod pallet_label;
pub mod pallets;
pub mod registry;
```

9. В `apps/standalone/host/src/facts/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletClosed => pallet_closed::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
```

заменить на

<!-- prettier-ignore -->
```rust
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletClosed => pallet_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletLabel => pallet_label::apply(conn, &context, &record.data).await,
        FactKind::PalletException => pallet_exception::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --offline --locked`
Expected: PASS — `facts` 36, `pallet_facts` 15.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 45.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
plan О-Х compare. One open pallet per station and shift is the station's
rule, not the host's: a second open pallet of a device is kept, since a
refusal would fail a batch the station can never get past.

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
```

заменить на

<!-- prettier-ignore -->
```text
plan О-Х compare. One open pallet per station and shift is the station's
rule, not the host's: a second open pallet of a device is kept, since a
refusal would fail a batch the station can never get past. A `pallet_label`
(`facts/pallet_label.rs`) records the check of a closed pallet's label as a
box's (`pallet_state` for an open one, `pallet_unknown` for a pallet the host
does not have), a pallet taken apart included. A `pallet_exception`
(`facts/pallet_exception.rs`) is a `reprint` or a `disassemble` of a closed
pallet not taken apart (`pallet_state` otherwise), always with a reason code
of the box exceptions' list for its kind (`exception_reasons`) and words only
for `other`; one row per record in `pallet_exceptions`. A disassembly sets
`disassembled_at`; the pallet keeps its SSCC, its boxes keep their
`pallet_id` and stay closed, and the pallet no longer counts.

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
```

- [ ] **Step 6: Мутации**

М1 — этикетка открытой паллеты. В `apps/standalone/host/src/facts/pallet_label.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if found.closed_at.is_none() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_label_check_marks_a_closed_pallet_of_its_own`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — проверенная этикетка пишется как пропущенная. В `apps/standalone/host/src/facts/pallet_label.rs` фрагмент

<!-- prettier-ignore -->
```rust
LabelOutcome::Verified => "print_verified_at",
```

заменить на

<!-- prettier-ignore -->
```rust
LabelOutcome::Verified => "print_skipped_at",
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_label_check_marks_a_closed_pallet_of_its_own`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — расформированная паллета расформировывается снова. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
if found.closed_at.is_none() || found.disassembled_at.is_some() {
```

заменить на

<!-- prettier-ignore -->
```rust
if found.closed_at.is_none() {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — исключение открытой паллеты. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
if found.closed_at.is_none() || found.disassembled_at.is_some() {
```

заменить на

<!-- prettier-ignore -->
```rust
if found.disassembled_at.is_some() {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М5 — причины перепечатки из списка расформирования. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
PalletExceptionKind::Reprint => exception_reasons::REPRINT,
```

заменить на

<!-- prettier-ignore -->
```rust
PalletExceptionKind::Reprint => exception_reasons::DISASSEMBLE,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`, `a_shift_without_pallets_answers_pallet_checks_and_exceptions_no_pallets`, `the_schema_refuses_the_pallet_exception_rows_no_fact_may_leave`. Восстановить файл, `cmp` молчит, хеш прежний.

М6 — слова причины без `other`. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
(exception_reasons::OTHER, Some(text)) => {
```

заменить на

<!-- prettier-ignore -->
```rust
(_, Some(text)) => {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М7 — расформирование не отмечает паллету. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if exception.exception == PalletExceptionKind::Disassemble {
```

заменить на

<!-- prettier-ignore -->
```rust
    if false {
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М8 — оператор исключения не хранится. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
    .bind(context.operator_id)
```

заменить на

<!-- prettier-ignore -->
```rust
    .bind(None::<String>)
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

М9 — смена без паллет у этикетки. В `apps/standalone/host/src/facts/pallet_label.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pallets::require(context)?;
```

удалить.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_shift_without_pallets_answers_pallet_checks_and_exceptions_no_pallets`. Восстановить файл, `cmp` молчит, хеш прежний.

М10 — слова причины не обрезаются. В `apps/standalone/host/src/facts/pallet_exception.rs` фрагмент

<!-- prettier-ignore -->
```rust
                .map(Some)
```

заменить на

<!-- prettier-ignore -->
```rust
                .map(|_| Some(text.clone()))
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/facts-request-pallets.json`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/host/src/facts/pallet_label.rs apps/standalone/host/src/facts/pallet_exception.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/tests/pallet_facts.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/facts-request-pallets.json apps/standalone/AGENTS.md
git commit -m "feat(standalone): a pallet's label check, reprint and disassembly as facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Итоги смены с паллетами — `closedPallets` и `openPallets` в каждом `OfficeShift`

Карточке и списку смен (план О-Ф) нужно видеть паллеты числами, как короба: закрытые нерасформированные паллеты и открытые паллеты, в которых есть нерасформированный короб. Паллета, все короба которой расформированы, не считается — как открытый короб без живой позиции. Оба числа читаются подзапросами и не хранятся, как остальные итоги 2a2; у смены без паллет они нулевые. Подробный список паллет со счётом станции и выведенным счётом — план О-Х.

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs` (`ShiftTotals`), `apps/standalone/host/src/routes/office_shifts.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/proto/fixtures/office-shift.json`
- Test: `apps/standalone/host/tests/pallet_facts.rs`, `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/office_shifts.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/support/shifts.ts`
- Modify: `apps/standalone/AGENTS.md` («Facts»)

**Interfaces:**

- Consumes: таблица `pallets`, `boxes.pallet_id` (задачи 2, 4), `disassembled_at` паллет и коробов (задача 5, 2a2).
- Produces: `ShiftTotals.{closed_pallets: u32, open_pallets: u32}` (`closedPallets`, `openPallets`).

- [ ] **Step 1: Тесты (падающие) и фикстура**

1. В `apps/standalone/host/tests/pallet_facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, fact, host_revision, instant, issue_block,
    issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device, pallet_closed,
    pallet_id, pallet_sscc, receipts, record_id, rejected, send_facts, shift_setup, sscc_of, Admin,
    Floor,
};

```

заменить на

<!-- prettier-ignore -->
```rust
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_exception, box_id, fact, host_revision, instant,
    issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, rejected, send_facts, shift_setup,
    sscc_of, Admin, Floor,
};

```

2. В `apps/standalone/host/tests/pallet_facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "'Перепутали'",
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

```

заменить на

<!-- prettier-ignore -->
```rust
        "'Перепутали'",
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// The office's totals of a shift with pallets count its closed pallets
/// that were not taken apart and its open pallets that hold a box not taken
/// apart; the list and the shift's own answer agree.
#[tokio::test]
async fn the_office_reads_a_shifts_pallets_from_its_facts() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    // Pallet 1 closes with boxes 1 and 2, pallet 2 closes with box 3 and is
    // taken apart, pallet 3 stays open with box 4, pallet 4 stays open and
    // its only box 5 is taken apart, pallet 5 closes with box 6.
    let mut batch = Vec::new();
    for (box_n, pallet) in [(1, 1), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5)] {
        batch.extend(boxed(&floor, &block, box_n, Some(&pallet_id(pallet))));
    }
    for (n, pallet, serial) in [(201, 1, 40), (202, 2, 41), (203, 5, 42)] {
        batch.push(record(
            &floor,
            n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(pallet),
                &pallets,
                serial,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        ));
    }
    batch.push(record(
        &floor,
        301,
        "pallet_exception",
        pallet_exception(
            "disassemble",
            &pallet_id(2),
            "wrong_product",
            Value::Null,
            &instant(160, 0),
        ),
    ));
    let mut apart = box_exception("disassemble", &box_id(5), &instant(161, 0));
    apart["reasonCode"] = json!("damaged_package");
    batch.push(record(&floor, 302, "box_exception", apart));
    admin.app.clock.advance(time::Duration::minutes(5));
    let at = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{}", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    assert_eq!(
        shift["totals"],
        json!({
            "acceptedUnits": 5, "closedBoxes": 5, "openBoxes": 0, "lastFactAt": at,
            "deviceIds": [floor.station], "closedPallets": 2, "openPallets": 1
        })
    );
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list[0]["totals"], shift["totals"]);
}

```

3. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let none = json!({
        "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
        "deviceIds": []
    });
    assert_eq!(totals(&admin, planned["id"].as_str().unwrap()).await, none);
```

заменить на

<!-- prettier-ignore -->
```rust
    let none = json!({
        "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
        "deviceIds": [], "closedPallets": 0, "openPallets": 0
    });
    assert_eq!(totals(&admin, planned["id"].as_str().unwrap()).await, none);
```

4. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 4, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": first_batch,
            "deviceIds": [floor.station]
        })
    );
```

заменить на

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 4, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": first_batch,
            "deviceIds": [floor.station], "closedPallets": 0, "openPallets": 0
        })
    );
```

5. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 3, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [floor.station]
        })
    );
```

заменить на

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 3, "closedBoxes": 1, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [floor.station], "closedPallets": 0, "openPallets": 0
        })
    );
```

6. В `apps/standalone/host/tests/facts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 1, "closedBoxes": 0, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [colleague.station]
        })
    );
```

заменить на

<!-- prettier-ignore -->
```rust
        json!({
            "acceptedUnits": 1, "closedBoxes": 0, "openBoxes": 1, "lastFactAt": second_batch,
            "deviceIds": [colleague.station], "closedPallets": 0, "openPallets": 0
        })
    );
```

7. В `apps/standalone/host/tests/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "totals": {
            "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
            "deviceIds": []
        }
    })
```

заменить на

<!-- prettier-ignore -->
```rust
        "totals": {
            "acceptedUnits": 0, "closedBoxes": 0, "openBoxes": 0, "lastFactAt": null,
            "deviceIds": [], "closedPallets": 0, "openPallets": 0
        }
    })
```

8. В `apps/standalone/proto/fixtures/office-shift.json` фрагмент

<!-- prettier-ignore -->
```json
    "openBoxes": 1,
    "lastFactAt": "2026-10-08T09:41:07Z",
    "deviceIds": ["7c9e6679-7425-40de-944b-e07fc1f90ae7"]
  }
}
```

заменить на

<!-- prettier-ignore -->
```json
    "openBoxes": 1,
    "lastFactAt": "2026-10-08T09:41:07Z",
    "deviceIds": ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    "closedPallets": 0,
    "openPallets": 0
  }
}
```

9. В `apps/standalone/test/support/shifts.ts` фрагмент

<!-- prettier-ignore -->
```ts
    lastFactAt: "2026-10-08T09:41:07Z",
    deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
  },
};
```

заменить на

<!-- prettier-ignore -->
```ts
    lastFactAt: "2026-10-08T09:41:07Z",
    deviceIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    closedPallets: 0,
    openPallets: 0,
  },
};
```

10. В `apps/standalone/test/protocol.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
  });

  it("read a mode and a close reason code this build does not know, and a plan of one unit", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
```

заменить на

<!-- prettier-ignore -->
```ts
  });

  it("read a shift's pallets in its totals and refuse a count of pallets that is no whole number", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
    const counted = { ...shift, totals: { ...shift.totals, closedPallets: 12, openPallets: 1 } };
    expect(officeShiftSchema.parse(counted)).toEqual(counted);
    for (const field of ["closedPallets", "openPallets"]) {
      for (const value of [1.5, "1", null]) {
        const totals = { ...shift.totals, [field]: value };
        expect(officeShiftSchema.safeParse({ ...shift, totals }).success, field).toBe(false);
      }
      const totals = Object.fromEntries(
        Object.entries(shift.totals).filter(([key]) => key !== field),
      );
      expect(officeShiftSchema.safeParse({ ...shift, totals }).success, field).toBe(false);
    }
  });

  it("read a mode and a close reason code this build does not know, and a plan of one unit", () => {
    const shift = officeShiftSchema.parse(fixture("office-shift.json"));
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --test office_shifts --no-fail-fast --offline --locked`
Expected: FAIL — `facts` `35 passed; 1 failed` (`the_office_reads_a_shifts_totals_from_its_facts`), `office_shifts` `26 passed; 4 failed` (`an_administrator_plans_a_shift_and_reads_it_back`, `a_planned_shift_changes_what_is_sent_and_keeps_its_number`, `a_planned_shifts_template_change_is_stored_read_back_and_audited`, `a_shift_with_pallets_takes_its_template_and_the_products_capacity`), `pallet_facts` `15 passed; 1 failed` (`the_office_reads_a_shifts_pallets_from_its_facts`).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: FAIL — `5 passed` и `44 passed; 1 failed`: `office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status` (`ShiftTotals` без новых полей теряет их при обратной записи).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL — `Tests  2 failed | 210 passed (212)`: `response fixture office-shift.json > parses without losing a field` и `shift shapes > read a shift's pallets in its totals and refuse a count of pallets that is no whole number`.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// accepted (items in a box, neither taken out by an exception nor taken by
/// an earlier scan elsewhere), boxes closed and not taken apart, open boxes
/// that hold a unit, when the host last received a record of the shift, and
/// the devices that entered it, first entry first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
```

заменить на

<!-- prettier-ignore -->
```rust
/// accepted (items in a box, neither taken out by an exception nor taken by
/// an earlier scan elsewhere), boxes closed and not taken apart, open boxes
/// that hold a unit, when the host last received a record of the shift, the
/// devices that entered it, first entry first, and (plan ПЛ-Х) pallets
/// closed and not taken apart and open pallets that hold a box not taken
/// apart; a shift without pallets has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
```

2. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub last_fact_at: Option<String>,
    pub device_ids: Vec<String>,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    pub last_fact_at: Option<String>,
    pub device_ids: Vec<String>,
    pub closed_pallets: u32,
    pub open_pallets: u32,
}

```

3. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
use crate::validate;

/// The columns of an office shift, its totals (plan 2a2) included: each a
/// subquery over the shift's facts, served by the indexes of `0010`.
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
```

заменить на

<!-- prettier-ignore -->
```rust
use crate::validate;

/// The columns of an office shift, its totals (plan 2a2, pallets plan ПЛ-Х)
/// included: each a subquery over the shift's facts, served by the indexes
/// of `0010` and `0012`.
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
```

4. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      AS last_fact_at, \
     (SELECT json_group_array(p.device_id ORDER BY p.first_entered_at, p.device_id) \
      FROM shift_participants p WHERE p.shift_id = shifts.id) AS device_ids \
     FROM shifts";

```

заменить на

<!-- prettier-ignore -->
```rust
      AS last_fact_at, \
     (SELECT json_group_array(p.device_id ORDER BY p.first_entered_at, p.device_id) \
      FROM shift_participants p WHERE p.shift_id = shifts.id) AS device_ids, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id \
      AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL) AS closed_pallets, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id AND p.closed_at IS NULL \
      AND EXISTS (SELECT 1 FROM boxes b WHERE b.pallet_id = p.id \
                  AND b.disassembled_at IS NULL)) AS open_pallets \
     FROM shifts";

```

5. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// A JSON array of ids.
    device_ids: String,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    /// A JSON array of ids.
    device_ids: String,
    closed_pallets: i64,
    open_pallets: i64,
}

```

6. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            last_fact_at: row.last_fact_at,
            device_ids: serde_json::from_str(&row.device_ids).map_err(ApiError::internal)?,
        },
    })
```

заменить на

<!-- prettier-ignore -->
```rust
            last_fact_at: row.last_fact_at,
            device_ids: serde_json::from_str(&row.device_ids).map_err(ApiError::internal)?,
            closed_pallets: u32::try_from(row.closed_pallets).map_err(ApiError::internal)?,
            open_pallets: u32::try_from(row.open_pallets).map_err(ApiError::internal)?,
        },
    })
```

7. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    lastFactAt: z.iso.datetime().nullable(),
    deviceIds: z.array(z.uuid()),
  }),
});
```

заменить на

<!-- prettier-ignore -->
```ts
    lastFactAt: z.iso.datetime().nullable(),
    deviceIds: z.array(z.uuid()),
    closedPallets: z.number().int(),
    openPallets: z.number().int(),
  }),
});
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --test facts --test office_shifts --offline --locked`
Expected: PASS — `facts` 36, `office_shifts` 30, `pallet_facts` 16.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --locked`
Expected: PASS — 5 и 45.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS — `Tests  212 passed (212)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
counted), `lastFactAt` (the host's clock at the last receipt of a record that
named the shift and got past the entry check, refused ones included) and
`deviceIds` (the shift's participants, first entry first). A planned shift's
totals are zeros, `null` and `[]`.

## Marking rules
```

заменить на

<!-- prettier-ignore -->
```text
counted), `lastFactAt` (the host's clock at the last receipt of a record that
named the shift and got past the entry check, refused ones included) and
`deviceIds` (the shift's participants, first entry first), and with plan
ПЛ-Х `closedPallets` (closed and not taken apart) and `openPallets` (open
pallets that hold a box not taken apart; a pallet whose boxes were all taken
apart is not counted). A planned shift's totals are zeros, `null` and `[]`.

## Marking rules
```

- [ ] **Step 6: Мутации**

М1 — расформированная паллета считается закрытой. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
      AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL) AS closed_pallets
```

заменить на

<!-- prettier-ignore -->
```rust
      AND p.closed_at IS NOT NULL) AS closed_pallets
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_pallets_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М2 — открытая паллета без коробов считается. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id AND p.closed_at IS NULL \
      AND EXISTS (SELECT 1 FROM boxes b WHERE b.pallet_id = p.id \
                  AND b.disassembled_at IS NULL)) AS open_pallets
```

заменить на

<!-- prettier-ignore -->
```rust
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id AND p.closed_at IS NULL) \
      AS open_pallets
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_pallets_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М3 — расформированный короб держит паллету открытой. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
                  AND b.disassembled_at IS NULL)) AS open_pallets
```

заменить на

<!-- prettier-ignore -->
```rust
                  )) AS open_pallets
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_pallets_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

М4 — числа перепутаны. В `apps/standalone/host/src/routes/office_shifts.rs` фрагмент

<!-- prettier-ignore -->
```rust
            closed_pallets: u32::try_from(row.closed_pallets).map_err(ApiError::internal)?,
            open_pallets: u32::try_from(row.open_pallets).map_err(ApiError::internal)?,
```

заменить на

<!-- prettier-ignore -->
```rust
            closed_pallets: u32::try_from(row.open_pallets).map_err(ApiError::internal)?,
            open_pallets: u32::try_from(row.closed_pallets).map_err(ApiError::internal)?,
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_facts --offline --locked`
Expected: FAIL `the_office_reads_a_shifts_pallets_from_its_facts`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/proto/fixtures/office-shift.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/test/support/shifts.ts`; `git diff --check`
Expected: чисто.

```bash
git add apps/standalone/proto/src/lib.rs apps/standalone/host/src/routes/office_shifts.rs apps/standalone/src/host/protocol.ts apps/standalone/proto/fixtures/office-shift.json apps/standalone/host/tests/pallet_facts.rs apps/standalone/host/tests/facts.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/test/protocol.test.ts apps/standalone/test/support/shifts.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): a shift's totals count its closed and open pallets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Журнал процесса с паллетами, уточнения в спецификации пилота, полная проверка

Проход журнала процесса (`no_secrets_in_logs.rs`) получает смену с паллетами. Её снимок несёт макет шаблона паллеты с маркером; в прошлом проходе есть блок паллет, короб на паллете, закрытие паллеты с её SSCC, проверка этикетки и закрытие той же паллеты другим SSCC, которое хост отвергает. Ни макет, ни оба SSCC не попадают в журнал, а код отказа `pallet_already_closed` попадает. Тест проходит сразу: модули фактов паллет `tracing` не вызывают, а отказ логирует `facts::receive`. Мутация М1 показывает, что тест ловит запись SSCC. Решения планировщика записываются в спецификацию пилота.

**Files:**

- Test: `apps/standalone/host/tests/no_secrets_in_logs.rs`
- Modify: `apps/standalone/AGENTS.md` («Logs»), `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (новый раздел в конце)

**Interfaces:**

- Consumes: всё, что дали задачи 1–6.
- Produces: раздел спецификации пилота «Уточнения плана ПЛ-Х».

- [ ] **Step 1: Проход журнала**

1. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    let shift: serde_json::Value = client
        .post(format!("{base}/v1/office/shifts"))
```

заменить на

<!-- prettier-ignore -->
```rust
        .await
        .unwrap();
    // The shift has pallets (plan ПЛ-Х): its pallet template's layout is
    // frozen in the snapshot too.
    let pallet_template: serde_json::Value = client
        .post(format!("{base}/v1/office/templates"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "name": "Паллета 100×150", "purpose": "pallet", "enabled": true,
            "spec": layout("layout-marker-pallet")
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift: serde_json::Value = client
        .post(format!("{base}/v1/office/shifts"))
```

2. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .json(&json!({
            "productId": milk["id"], "lineId": line_id, "productionDate": "2026-10-08",
            "boxTemplateId": template_id
        }))
        .send()
```

заменить на

<!-- prettier-ignore -->
```rust
        .json(&json!({
            "productId": milk["id"], "lineId": line_id, "productionDate": "2026-10-08",
            "boxTemplateId": template_id, "palletsEnabled": true,
            "palletTemplateId": pallet_template["id"]
        }))
        .send()
```

3. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(block.status(), 200);
    let block: serde_json::Value = block.json().await.unwrap();

    // Facts (plan 2a2): a scan with a code whose canonical text carries a
    // crypto tail, the close of its box with an SSCC, a scan of another
    // product the host refuses, a record sent again with other content, and
    // the code asked for. None of the codes, tails, hashes or the SSCC
    // reaches the log.
    let canonical = "0104600682000020215Kp9sQx\u{1d}91EE11\u{1d}92crypto-tail-marker-1";
    let refused_canonical = "0104600682000099215Rf2wLz\u{1d}92crypto-tail-marker-2";
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(block.status(), 200);
    let block: serde_json::Value = block.json().await.unwrap();
    let pallet_block: serde_json::Value = client
        .post(format!("{base}/v1/device/sscc/blocks"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "requestId": "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c",
            "issuerPrefix": "460068200", "extension": 1
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Facts (plan 2a2): a scan with a code whose canonical text carries a
    // crypto tail, the close of its box with an SSCC, a scan of another
    // product the host refuses, a record sent again with other content, and
    // the code asked for; and (plan ПЛ-Х) the box on a pallet, the pallet's
    // close with its SSCC, its label check and a refused close with another
    // SSCC. None of the codes, tails, hashes or SSCCs reaches the log.
    let canonical = "0104600682000020215Kp9sQx\u{1d}91EE11\u{1d}92crypto-tail-marker-1";
    let refused_canonical = "0104600682000099215Rf2wLz\u{1d}92crypto-tail-marker-2";
```

4. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let box_id = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
    let sscc = "046006820000000013";
    let scan = json!({
        "id": "5d2c8f0a-3b1e-4c7d-9a6f-0e2b4c6d8f10", "kind": "scan", "shiftId": shift_id,
```

заменить на

<!-- prettier-ignore -->
```rust
    let box_id = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
    let sscc = "046006820000000013";
    let pallet_id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    let pallet_sscc = "146006820000000409";
    let other_pallet_sscc = "146006820000000416";
    let scan = json!({
        "id": "5d2c8f0a-3b1e-4c7d-9a6f-0e2b4c6d8f10", "kind": "scan", "shiftId": shift_id,
```

5. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "boxId": box_id, "sscc": sscc, "blockId": block["id"], "serial": 1,
            "openedAt": "2026-10-08T06:15:02.418Z", "closedAt": "2026-10-08T06:21:47.302Z",
            "itemCount": 1, "membershipDigest": markiro_host::facts::rules::box_membership_digest(&[code_hash.clone()])
        }
    });
    for records in [vec![scan, refused, closed_box], vec![changed]] {
        let sent = client
            .post(format!("{base}/v1/device/facts"))
```

заменить на

<!-- prettier-ignore -->
```rust
            "boxId": box_id, "sscc": sscc, "blockId": block["id"], "serial": 1,
            "openedAt": "2026-10-08T06:15:02.418Z", "closedAt": "2026-10-08T06:21:47.302Z",
            "itemCount": 1, "membershipDigest": markiro_host::facts::rules::box_membership_digest(&[code_hash.clone()]),
            "palletId": pallet_id
        }
    });
    let closed_pallet = json!({
        "id": "ad7c3f5a-8b6e-4c2d-9f1a-5b7c9d1e3f65", "kind": "pallet_closed",
        "shiftId": shift_id, "operatorId": null,
        "data": {
            "palletId": pallet_id, "sscc": pallet_sscc, "blockId": pallet_block["id"],
            "serial": 40, "openedAt": "2026-10-08T06:21:47.302Z",
            "closedAt": "2026-10-08T09:02:11.540Z", "boxCount": 1
        }
    });
    let checked_pallet = json!({
        "id": "be8d4a6b-9c7f-4d3e-8a2b-6c8d0e2f4a76", "kind": "pallet_label",
        "shiftId": shift_id, "operatorId": null,
        "data": { "palletId": pallet_id, "outcome": "verified", "at": "2026-10-08T09:02:30.004Z" }
    });
    let mut reclosed_pallet = closed_pallet.clone();
    reclosed_pallet["id"] = json!("cf9e5b7c-0d8a-4e4f-9b3c-7d9e1f3a5b87");
    reclosed_pallet["data"]["sscc"] = json!(other_pallet_sscc);
    reclosed_pallet["data"]["serial"] = json!(41);
    for records in [
        vec![
            scan,
            refused,
            closed_box,
            closed_pallet,
            checked_pallet,
            reclosed_pallet,
        ],
        vec![changed],
    ] {
        let sent = client
            .post(format!("{base}/v1/device/facts"))
```

6. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .await
            .unwrap();
    let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();
    pool.close().await;
```

заменить на

<!-- prettier-ignore -->
```rust
            .await
            .unwrap();
    let kept_pallet_ssccs: Vec<String> =
        sqlx::query_scalar("SELECT sscc FROM pallets WHERE sscc IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();
    pool.close().await;
```

7. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "layout-marker-office-1",
        "layout-marker-office-2",
    ] {
        assert!(!log.contains(layout), "the process log contains {layout}");
```

заменить на

<!-- prettier-ignore -->
```rust
        "layout-marker-office-1",
        "layout-marker-office-2",
        "layout-marker-pallet",
    ] {
        assert!(!log.contains(layout), "the process log contains {layout}");
```

8. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        "the shift never froze the layout"
    );
    // The host kept the accepted code and the SSCC, and logged the refusals
    // by their receipt codes: their absence from the log proves something.
    assert_eq!(kept_codes, vec![canonical.to_owned()]);
    assert_eq!(kept_ssccs, vec![sscc.to_owned()]);
    assert!(log.contains("gtin_mismatch") && log.contains("payload_mismatch"));
    for marking in [
        canonical,
```

заменить на

<!-- prettier-ignore -->
```rust
        "the shift never froze the layout"
    );
    assert!(
        snapshots
            .iter()
            .any(|snapshot| snapshot.contains("layout-marker-pallet")),
        "the shift never froze the pallet layout"
    );
    // The host kept the accepted code and the SSCC, and logged the refusals
    // by their receipt codes: their absence from the log proves something.
    assert_eq!(kept_codes, vec![canonical.to_owned()]);
    assert_eq!(kept_ssccs, vec![sscc.to_owned()]);
    assert_eq!(kept_pallet_ssccs, vec![pallet_sscc.to_owned()]);
    assert!(log.contains("gtin_mismatch") && log.contains("payload_mismatch"));
    assert!(log.contains("pallet_already_closed"));
    for marking in [
        canonical,
```

9. В `apps/standalone/host/tests/no_secrets_in_logs.rs` фрагмент

<!-- prettier-ignore -->
```rust
        &"beefc0de".repeat(8),
        sscc,
    ] {
        assert!(
```

заменить на

<!-- prettier-ignore -->
```rust
        &"beefc0de".repeat(8),
        sscc,
        pallet_sscc,
        other_pallet_sscc,
    ] {
        assert!(
```

- [ ] **Step 2: Запустить проход — он проходит**

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: PASS — 1.

- [ ] **Step 3: Мутация**

М1 — SSCC паллеты в журнале. В `apps/standalone/host/src/facts/pallet_closed.rs` фрагмент

<!-- prettier-ignore -->
```rust
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
```

заменить на

<!-- prettier-ignore -->
```rust
    tracing::info!(sscc = %closed.sscc, "pallet closed");
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
```

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline --locked`
Expected: FAIL `secrets_never_reach_the_process_log`. Восстановить файл, `cmp` молчит, хеш прежний.

- [ ] **Step 4: Документы**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```text
and its receipt code alone; `no_secrets_in_logs.rs` sends a code with a
crypto tail, a box's SSCC, a refused scan and a mismatched resend, and asks
for the code. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification
```

заменить на

<!-- prettier-ignore -->
```text
and its receipt code alone; `no_secrets_in_logs.rs` sends a code with a
crypto tail, a box's SSCC, a refused scan and a mismatched resend, and asks
for the code; in a shift with pallets (plan ПЛ-Х) it also sends a pallet's
SSCC, its label check and a refused close under another SSCC, and the shift's
snapshot carries the pallet template's layout. Kiosk mode's failures are
logged by the command's name alone (`standalone: enter_lockdown failed`),
never by what the shell answered.

## Verification
```

2. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` дописать в конец файла (после пустой строки) раздел ниже. Номер раздела — следующий свободный: 18, если к исполнению никто не дописал свой (план РК пишет туда «Уточнения плана РК»).

<!-- prettier-ignore -->
```text
## 18. Уточнения плана ПЛ-Х

План `docs/superpowers/plans/2026-10-10-standalone-pl-h-pallets-host.md` (паллеты-лайт, хост)
уточняет раздел 6.2 так; на вопросы раздела 14 действуют рекомендованные ответы.

- **Поля смены.** На проводе — `palletsEnabled`, `palletBoxCapacity` и `palletTemplateId`
  (столбец `pallet_template_id`). Смена с паллетами называет шаблон паллеты обязательно (без него
  `validation_failed` на `palletTemplateId`), вместимость — по желанию, по умолчанию из товара.
  Смена без паллет не присылает ни одного из двух полей. Связь «оба поля заданы тогда и только
  тогда, когда паллеты включены» держат два триггера миграции `0012_pallets.sql`.
- **Правка.** Запланированная смена включает паллеты (с шаблоном), меняет их и выключает; при
  выключении оба поля очищаются. Открытая смена паллеты не меняет (`shift_status`).
- **Снимок.** Вместимость паллеты — поле смены, как вместимость короба, а не поле снимка. Снимок
  получает `palletTemplate { id, name, rev, spec }` только у смены с паллетами; у смены без паллет
  поля нет. Неподходящий при открытии шаблон паллеты — `conflict` с отдельным
  `constraint: pallet_template_not_fit`.
- **Станция.** `DeviceShift` называет `palletBoxCapacity` и `palletTemplateId` только у смены с
  паллетами; `DeviceShiftCreate` принимает те же поля паллет, что и офис.
- **Блоки.** Блок паллет — расширение 1 размером `site.pallet_block_size`. Повтор `requestId` с
  другим префиксом или другим расширением — `validation_failed` на `requestId`.
- **Дайджест состава паллеты не вводится.** Состав паллеты задают `palletId` в каждом
  `box_closed`; `pallet_closed` несёт только `boxCount`, который хранится как свидетельство
  (`box_count_reported`). Сверку с выведенным числом коробов делает план О-Х. Облако тоже сверяет
  паллеты только по коробам.
- **Порядок фактов.** Паллету открывает первый закрытый короб, который её называет, а если ни один
  её короб не дошёл — её собственный `pallet_closed`: напечатанный SSCC так или иначе занят на
  хосте. Состояние паллеты не отказывает коробу: короб, досланный под новым `id` после отказа,
  присоединяется и к закрытой паллете.
- **Исключения паллеты.** Поле вида — `exception` (как у `box_exception`), а не `kind`: `kind` уже
  есть у конверта записи. Код причины обязателен; списки — те же, что у исключений коробов.
  Расформирование ставит `disassembled_at` и не трогает короба.
- **Коды квитанций:** `no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`.
- **Итоги смены:** `closedPallets` — закрытые и не расформированные; `openPallets` — открытые, в
  которых есть нерасформированный короб.
- **Протокол 3.** `MIN_PROTOCOL_VERSION` остаётся 1. Паллетные формы лежат в отдельных фикстурах
  (`shift-create-pallets.json`, `device-shift-create-pallets.json`,
  `device-shift-entered-pallets.json`, `facts-request-pallets.json`), поэтому схемы станции этапа
  2a читают прежние фикстуры без изменений.
```

- [ ] **Step 5: Полная проверка**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (сборка вебвью для оболочки), затем вне песочницы `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --locked --no-fail-fast`
Expected: PASS — 47 наборов, 616 тестов: хост 34 и 451 (`pallet_facts` 16, `office_shifts` 30, `device_shifts` 20, `sscc_blocks` 16, `fact_rules` 13, `facts` 36), `proto` 2 и 50, оболочка 11 и 115.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`
Expected: 78 файлов, 2123 теста. Тяжёлые UI-наборы могут упасть на пределе 5 с (см. «Заметки»): каждый такой файл повторить отдельно — проходит (`test/template-editor.test.tsx` падал так же до плана; план его не трогает).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`
Expected: без ошибок.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`; `git diff --check`
Expected: чисто.

Сверка: `git diff --stat <база плана>..HEAD -- apps/standalone/host/migrations` — только `0012_pallets.sql`; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*` не тронуты; каждый коммит плана — с одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

- [ ] **Step 6: Коммит**

```bash
git add apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -m "test(standalone): the process log holds no pallet SSCC or pallet layout; the pilot spec takes plan ПЛ-Х's refinements" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Итоговая проверка плана

1. Покрытие §6.2 спецификации пилота («Хост»):
   - поля паллет смены, обязательный шаблон и `validation_failed` без него — задача 2;
   - шаблон паллеты в снимке — задача 3, вместимость паллеты — поле смены;
   - блоки расширения 1 размером `site.pallet_block_size` — задача 3;
   - `palletId` у `box_closed` и `pallet_closed` с проверками SSCC — задача 4;
   - `pallet_label` и `pallet_exception` — задача 5;
   - таблицы `pallets`, `pallet_exceptions`, `boxes.pallet_id` — задача 2;
   - `closedPallets` и `openPallets` — задача 6;
   - протокол 3, хост понимает 2 и 1 — задача 1.
     Офисная форма — план О-Ф, Zod офиса — задачи 2 и 6.
2. Уроки ревью, закреплённые мутациями:
   - один номер — одна этикетка при любой контрольной цифре (задача 4, М3 и тест серии 41 с другой цифрой);
   - границы блока (задача 4, М14 и М15);
   - чужое устройство и чужая смена порознь (задача 4, М4 и М5);
   - `consumed_through` только растёт (задача 4, М9);
   - повтор под другим `id` (задача 4, М6 и М8);
   - проверка внутри транзакции записи, детерминированно, с удержанием блокировки (`a_pallet_close_waiting_for_the_write_lock_sees_the_serial_taken_meanwhile`);
   - пачка целиком или ничего (`a_pallet_close_is_written_with_its_batch_or_not_at_all`);
   - точность журнала действий (задача 2, М11; задача 3, М3);
   - пробуждение потоков блоком паллет (`a_pallet_block_takes_the_pallet_counter_and_the_pallet_block_size`);
   - ни одного проглоченного отказа: каждая квитанция сверяется целиком.
3. Имена в контракте и в коде совпадают: `names_serial`, `pallet_request`, `pallets`, `check_pallet_template`, `pallet_template_not_fit`, `blocks::{issued, consume}`, `pallets::{require, find, open}`, `PalletClosedFact`, `PalletLabelFact`, `PalletExceptionKind`, `PalletExceptionFact`, `ShiftTotals.{closed_pallets, open_pallets}`, коды `no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`.
4. Числа тестов — «Заметки», «Счёт тестов»; полная проверка — задача 7, шаг 5.
5. Каждый фрагмент плана проверен сценарием: на копии из «Базы» он встречается ровно один раз, и последовательное применение даёт итоговый файл байт в байт. Каждая мутация прогнана на состоянии конца своей задачи: тесты падают, файл восстановлен (`sha256` совпадает).

## Перенесено

- **ПЛ-Ц (цех):**
  - присоединение короба к открытой паллете станции через `CloseStep` плана 2a6;
  - автозакрытие при `boxCount + 1 >= palletBoxCapacity` и досрочное закрытие;
  - задание печати паллеты и её проверка;
  - перепечатка и расформирование;
  - закрытие смены с открытой паллетой («На паллете N из M коробов — закрыть?»);
  - блоки паллет по правилу «половина»;
  - Zod станции для полей паллет, снимка, фактов и кодов квитанций (`deviceShiftSchema`, `shiftSnapshotSchema`, `factRecordSchema` планов 2a5 и 2a6, тест 2a6 «`pallet_closed` — не вид записи» меняется);
  - переключатель «С паллетами» новой смены на станции.
- **Временное окно, о котором надо знать.** Пока ПЛ-Ц не установлен, станция (её оболочка уже говорит протоколом 3) войдёт в смену с паллетами и будет закрывать короба без паллет. Смены с паллетами не планировать, пока цех не обновлён (сквозная проверка — план 2a8 и испытания).
- **О-Х:** список паллет смены, выведенный состав, расхождение `box_count_reported` с выведенным счётом, источник выгрузки (короба открытой и расформированной паллеты — без паллеты), данные «Состава паллеты» и «Ярлыка паллеты».
- **О-Ф:** паллеты в форме планирования и правки (строители `shiftCreate` и `shiftUpdate`, выбор шаблона по решению 7 для назначения `pallet`), тексты отказов `palletTemplateId`, `palletBoxCapacity`, `pallet_template_not_fit`.
- **ЧЗ:** паллетные форматы и XML одной паллеты по `pallets.sscc` и выведенному составу.
- **РК:** повторная регистрация блоков после восстановления (`POST /v1/device/sscc/blocks/known`) должна принимать и блоки расширения 1 (паллет). Подъём счётчиков — по обоим расширениям; план РК это уже называет.
- **ИМП:** перенос `pallet_box_capacity` товаров и умолчаний шаблонов паллет есть с 1e1; смены не переносятся.
- **2b:** отзыв блоков паллет по тем же правилам, что коробов (ревью задачи 4 плана 2a2, Minor 4: серии, уже использованные без связи, должны оставаться приемлемыми). Несколько станций на одной смене с паллетами.
- **Вопрос владельцу (без ответа, план принял рекомендацию):** свой список причин исключений паллет или общий с коробами.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-10 и итогового ревью части. Ветка `claude/plh-pallets` отрезана от `claude/integration` на `1095d4af4` (2a2 и 2a3 влиты с финальными волнами); задачи 1–7 — 8 коммитов `e93cc55c6…b8cef1e25`, итоговая волна — 4 коммита (`f1f666a6a`, `0354a74b1`, `b8ad2e761`, `2a7ebfae3`). На 2026-10-11 ветка влита в `claude/integration`. Итоговое ревью: Critical 0, Important 0, Minor 8.

**Поправки плана по ходу исполнения**

- Итоги — восемь полей, а не семь. На основе `ShiftTotals` уже несёт `unitsInClosedBoxes` (финальная волна 2a2), поэтому литералы итогов в тестах шестипольные плюс два поля паллет. `closedPallets` и `openPallets` получили в Zod `.nonnegative()` сверх `.int()` брифа: это зеркало `u32` и соседних счётчиков, закреплено тестами с `-1`.
- `facts_files` = 17 поднят в задаче 5, а не в задаче 7 (дополнение к брифу задачи 5, пункт 7 очереди: два новых модуля `pallet_label.rs` и `pallet_exception.rs`). Задаче 7 осталось подтвердить число.
- Проверка формы SSCC паллеты (18 цифр) стоит до `names_serial` (пункт 1 очереди): `names_serial` читает только первые 17 символов. Тест и мутант «убрать проверку формы» проверены ревью задачи 4.
- Проход журнала (задача 7) применён по смыслу: фрагменты брифа на дереве не нашлись (проход — 2a2-шный). SSCC паллет берутся из настоящего `fromSerial` блока (`pallet_sscc`). Добавлена запись `pallet_exception` (reprint со словами), чтобы проход действительно посылал каждый вид. Неизвестный вид `pallet_closed` переименован в `pallet_dispatched`: `pallet_closed` теперь настоящий вид.
- Спецификация §18 исправлена против текста брифа. Фраза «прежние фикстуры не менялись» уточнена: изменены `hello`, `hello-future`, `error-with-details`, `fact-receipt-codes`, `office-shift`, добавлена `sscc-serials`. Фраза «облако тоже сверяет паллеты только по коробам» не включена: её не проверили по `apps/api`. Добавлены «что хранится как сказано», «поздний короб закрытой паллеты», «повтор закрытия и отозванный блок» и правило установки протокола 3 (решение контролёра: все станции пилота ставятся вместе, отказа хоста нет).

**Итоговая волна правок**

- Пункт 5 очереди (`0354a74b1`, `b8ad2e761`). Два макета (короба и паллеты) по 170 КБ каждый укладываются в `MAX_SPEC_BYTES` (256 КБ на шаблон), но вместе превышают `CHECK` миграции `0009` на снимок (327 680 байт): вход отвечал `500 internal` каждый раз, смена оставалась запланированной. Теперь `shifts::snapshot_text` меряет байты сериализованного снимка при входе (после проверок шаблонов, до новой ревизии) и отвечает `409 conflict` с `details.constraint = "snapshot_too_large"`; границу 327 680 / 327 681 и связь с `CHECK` закрепляют три модульных теста, два теста хоста проверяют отказ, неизменность записей и что смена открывается после замены паллетного шаблона. Новая фикстура `error-snapshot-too-large.json`; `error-codes.json` не менялся, потому что это `details.constraint`, а не верхнеуровневый код.
- Пункт 3 очереди (`f1f666a6a`). Тест обратной совместимости миграций открывал базу с выключенными внешними ключами, хост — с включёнными; добавлен `PRAGMA foreign_keys = ON` перед `MIGRATOR.run`.
- Документы (`2a7ebfae3`): снимок до 320 КБ и «до двух макетов» в AGENTS.md и §18; приближённое `opened_at` открытой паллеты (время первого пришедшего короба — только порядок показа); две длинные строки AGENTS.md и абзацы `device_shifts.rs` перенесены (заявление задачи 7 о переносе не было верным).

**Перенесено**

- План ПЛ-Ц: `snapshot_too_large` добавить в `EntryRefusal` со своими словами в `ru.json` рядом с `pallet_template_not_fit`; четыре кода паллет дописать в `FACT_RECEIPT_CODES` после слияния 2a6; помощники тестов `open_pallet_floor` и `issue_pallet_block` уже есть, первый блок паллет — 40–239; на момент ревью §19 спецификации пилота был свободен (позже его заняла ветка РК; ЧЗ и О-Ф взяли §20 и §21).
- Планы ЧЗ и О-Ф: поздний короб на закрытой паллете (его `closedAt` позже `closedAt` паллеты) отмечать (пункт 8 очереди) — в обоих сделано (предупреждение выгрузки `late_boxes`, отметка в карточке смены). ЧЗ записывает Ч1 (расформированная паллета в выгрузке остаётся паллетой), которое противоречит договору плана ПЛ-Х, хотя ни одна фраза дерева обратного не утверждает.
- План О-Х: состав паллеты выводить из `boxes.pallet_id` (закрытые, не расформированные), сверять с `box_count_reported`; индекс `pallet_exceptions(shift_id)` — в своей миграции, если чтение идёт по смене.
- План РК: `known_blocks` должен получать блоки паллет (расширение 1) и от станций; станционная сторона — ОЧ / ПЛ-Ц.
- План УСТ: ручная проверка «каждая станция и офисный ПК площадки на одной версии установщика (протокол 3) после обновления хоста».
- Текст спецификации этапа 2a (`2026-10-08-standalone-2a-shift-and-boxes-design.md`, строки 57 и 154) всё ещё говорит «снимок до 256 КБ» и «не больше 320 КБ» — формулировка эпохи одного макета; правка в одно слово («до двух макетов, 320 КБ») отложена.

**Не проверено**

- CI; Windows; живая станция и принтер; любая отрисовка в веб-части; поведение настоящей станции с протоколом 2 против паллетной смены (в пилоте исключено правилом установки).
- Итоговое ревью не перезапускало полный Vitest и полный прогон рабочего пространства (нагрузка): список из 807 тестов собран и перечислен, под мутантами гонялись четыре бинарника; не гонялся вне песочницы `no_secrets_in_logs` (опора на отчёт задачи 7). Производительность итогов на реальном объёме проверена только тестом EXPLAIN.

**Счёт.** План: cargo 47 наборов и 616 тестов, Vitest 78 файлов и 2123 теста. Измерено ревью на `b8cef1e25` (основа — `claude/integration` `1095d4af4`): cargo 807 тестов (`--list`), 53 строки результата (из них 3 пустых doc-набора); Vitest 81 файл и 2280 тестов. По наборам: `pallet_facts` 29, `office_shifts` 34, `device_shifts` 23, `sscc_blocks` 19, `fact_rules` 13, `facts` 57, фикстуры `proto` 47. Приращения больше плановых: исполнители добавили тесты сверх брифов. После итоговой волны: один прогон `cargo test --workspace --offline --locked` вне песочницы — 53 строки результата, 812 пройдено, 0 отказов (+5: два теста хоста и три модульных); `device_shifts` 25, `shifts` (библиотека) 4, фикстуры `proto` 47, `test/protocol.test.ts` 216; `typecheck`, `lint` и `build` — чисто. Полный Vitest после волны не гонялся.
