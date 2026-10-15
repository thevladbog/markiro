# Отчёт исполнителя: план ДЗГ-О (дезагрегация в офисе автонома)

Ветка `claude/exec-dzgo` (worktree `/tmp/claude/wt/exec-dzgo`), от `claude/integration` 3235a7396; в конце влита `claude/integration` (7bdab2b0d, КРТ) — слияние `957ae3999`, единственный конфликт — импорты в `office-query.ts`. Последний коммит: `a6eaaaca6`. Push и слияние в интеграцию не делались.

## Что сделано (коммиты)

| Задача | Коммит                                                         | Что                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `76337a04c` слепки облака; `4b3915fd2` перенос акта            | `report.ts` → `packages/domain/src/print-forms/disaggregation-report.ts` (`git mv`), `timeZone="UTC"`, `operationNote?`, `DISAGGREGATION_MANUAL_UPLOAD_NOTE`; слепки `disaggregation-act-{boxes,full,draft,full-moscow}.html`; API только импорты |
| 2      | `7e9588f8e`                                                    | `renderGismtDisaggregationXml` в `packages/domain/src/gismt-disaggregation.ts`, инвентаризация зовёт его, `isParticipantInn` реэкспортируется                                                                                                     |
| 3      | `0749b1cc3`                                                    | провод: `DisaggregationReportRows`, вариант, `DisaggregationExportRecord`, Zod, `HostApi` ×2, фикстуры, ограничения `restore_hold`, `document_not_applied`                                                                                        |
| 4      | `65b1ccbfa`, `6ad9d4472`                                       | хост `routes/office_disaggregation_reports.rs`: `report-data` (один снимок, коды по сменам) и `exports` (аудит `disaggregation.export`); маршруты в `license/gate.rs::NEVER`                                                                      |
| доп. 2 | `d9fb2639b`                                                    | `409 conflict restore_hold` при `site.facts_held_since` в `apply` (под замком записи, после проверки роли)                                                                                                                                        |
| доп. 1 | `bce70c6ae`                                                    | «Исключения» смены и карточка кода показывают офисное расформирование (провод КНФ: `source`, `deviceId/deviceName` nullable, `documentId/documentNo/officeUserName`; `removed`-событие карточки кода получило документ)                           |
| 5–7    | `12aa9bb47` (акт, XML-логика), `62fa03f11` (страницы, диалоги) | «Дезагрегация», документ, «Причины», диалоги акта и XML, разбор вставки/файла, `render-form` вид `act`, `paint()` в `print-form.ts`                                                                                                               |
| 8      | `f9789de54` (хост/провод), `b9a79565d` (страница)              | `OfficeConflictScan.shiftClosed/boxDisassembled`, «Расформировать короб» на «Конфликтах»                                                                                                                                                          |
| 9      | `ef8e98b92`                                                    | `AGENTS.md` (Audit, новый раздел «Disaggregation in the office», Verification), спека §5.1                                                                                                                                                        |
| ревью  | `09c8a23f3`, `a6eaaaca6`                                       | двойной «Провести», причина частичного импорта, защита `documentFilter`, дребезг страницы, двойной клик «Расформировать», общий помощник КРТ                                                                                                      |

Решение владельца «оставить late_data_at» — не тронуто (`host/src/disaggregation.rs`). Миграций нет (проверено: хост `0024`, `0025` КРТ), `PROTOCOL_VERSION` не менялась.

## Проверки

- Домен: тесты 1446 (в одном прогоне раз упал `buildPalletSheetPresets`-тест под нагрузкой, повторно зелёный), typecheck, lint, build; слепки с `CI=true`; golden инвентаризации не менялся.
- API: typecheck, lint, build, `disaggregation-import.test.ts` (3); e2e дезагрегации/инвентаризации с БД НЕ запускались (нет `DATABASE_URL`/одноразового Postgres) — поведение API не менялось (только импорты, рендерер побайтово равен слепкам).
- Rust: `cargo test -p markiro-host -p markiro-proto --no-fail-fast` — зелёно (до и после слияния с КРТ), `cargo fmt --check` чисто. Крейт оболочки не трогался и не запускался.
- Vitest `@markiro/standalone` (после слияния): 6196 passed, 2 failed — оба `test/template-editor.test.tsx` по таймауту 30 с при нагрузке (тот же известный флейк, что в отчёте ДЗГ); файл отдельно зелёный. После этого правки ревью: затронутые файлы зелёные, typecheck, lint, prettier, `git diff --check` чисто. Страницы/диалоги прогнаны и под стендом задержки `setImmediate` 3 мс (временные файлы удалены).
- Мутанты: убиты — условие `removed_at = disassembled_at` в `SHIFT_ITEMS_SQL`; охрана `restore_hold`; охрана двойного «Провести».
- Субагенты-ревьюеры (sonnet): хост (Important: тест снимка не доказывал изоляцию — исправлен; мелочи — исправлены), UI (4 Important/мелочи — исправлены частично, см. ниже), итог по плану (Critical нет).

## Отклонения при исполнении

1. Задача 1: слепки облака писал тест, положенный сначала в `apps/api/test` — но `apps/api` без `node_modules` в клонированных зависимостях; клонирован `node_modules` из основного репо (только чтение), тест отработал штатно. Перенос и добавление параметров — одним коммитом `4b3915fd2` (коммит «перенос побайтово» и «зона/примечание» не разделены).
2. Имена ДЗГ сверены с кодом, расхождений нет; `to` списка включается (`<=`), проведение пишет `removed_at` и `disassembled_at` одним текстом.
3. Пункт меню «Дезагрегация» стоит ПОСЛЕ «Конфликтов» (не после «Смены»): тест КНФ требует, чтобы «Конфликты» шли сразу за «Сменами». Тест порядка в `operators-page.test.tsx` обновлён.
4. Тестовые SSCC из плана с неверной контрольной цифрой заменены валидными (`parseScannedSscc` иначе даёт `null`). Комментарий документа — однострочное поле (хост отвергает управляющие символы).
5. Существующие утверждения изменены по решению: `office_codes.rs` (событие `removed` + три поля null), `office_shift_review.rs` (строки + `source`, три поля, план без сканов таблиц), `office_conflicts.rs` (`side()` + `shiftClosed/boxDisassembled`), `shift-review.test.tsx`, `code-search-page.test.tsx` (7 событий), `proto/tests/{review,code_search}.rs`, `test/conflict-list.test.ts`.
6. Помощник «создать черновик с SSCC»: использован готовый `src/office/codes/pack-disassembly.ts` КРТ (`startPackDisassembly`), собственный `disassemble.ts` удалён. Тексты `office.conflicts.disassemble*` свои (кнопка в строке таблицы).
7. Частичный импорт показывает причину сбоя рядом с «добавлено N из M»; `restoreHold` — отдельный текст; ограничение хоста `lines.N.input` отдельно от «документ полон».
8. Правка шапки: поля блокируются на время сохранения (`disabled`), фокус после выбора причины клавиатурой уходит в body — осознанно оставлено (рецензент: Minor).
9. Запись `disaggregation.export` не идемпотентна по файлу: повтор записи после потерянного ответа даёт вторую строку аудита (как `shift.export`).
10. Раздел «Отклонения» в самом плане не правился (каталог планов у контроллера) — этот список для переноса.

## Общие файлы с параллельными исполнителями (конфликты слияния)

`apps/standalone/src/i18n/ru.json`, `src/office/{nav.ts,routes.tsx,office-query.ts}`, `src/host/{api.ts,review.ts,code-search.ts,disaggregation.ts}`, `test/support/office.tsx`, `host/src/{server.rs,audit.rs,license/gate.rs}`, `host/src/routes/{mod.rs,office_conflicts.rs,office_codes.rs,office_shift_review.rs,disaggregation.rs}`, `proto/src/{review.rs,code_search.rs,disaggregation.rs}`, фикстуры `office-conflict-page.json`, `office-shift-exceptions.json`, `office-code-card.json`, `AGENTS.md`, спека паритета, `packages/domain/src/index.ts`. С РЕЖ: пересборка `scans`/`code_conflicts` — запросы ДЗГ-О зависят от индексов `scans_shift`, `scans_code_hash` и столбцов `shift_id, gtin14, serial, canonical, code_hash`; `EXPLAIN`-тесты (`office_disaggregation_reports`, `office_shift_review`, `office_codes::QUERIES`) покажут потерю индекса. Если РЕЖ меняет `disaggregation::resolve` для смен проверки, ДЗГ-О унаследует.

## Открытое / наблюдения

- Карточки коробов/паллет КРТ уже показывают применённые документы (`BOX_DOCUMENTS_SQL`); списки коробов/паллет и таблица размещений карточки кода помечают «расформирован» без указания источника и ссылки на документ (не в этом плане).
- Перекос версий: новые обязательные поля Zod (`source`, `shiftClosed`, `boxDisassembled`, поля карточки кода) ломают страницы, если новое приложение говорит со старым хостом; протокол не поднят (не требуется правилом), приложение и хост ставятся вместе.
- `SHIFT_ITEMS_SQL` читает все сканы смены ради кодов нескольких коробов (узкое место на больших сменах; проверка владельца 3/5).
- Полный вариант акта рисуется синхронно (заморозка окна на большом документе).

## Не проверено (проверки владельца на Windows)

Визуально ничего не смотрелось (только jsdom; браузерного прогона нет). Печать акта на A4 и WebView2 («Печать»/«Открыть в браузере»); чтение DataMatrix полного акта сканером; акт на 200 коробов×20 кодов (время); приём XML в ЛК Честного знака (короб и паллета, ИНН 12 цифр, SSCC без поданной агрегации); `.csv` из Excel с BOM и `.txt` из 1С, файл на 2 000 SSCC; клавиатурный проход страниц и диалогов; технолог; «Расформировать короб» на «Конфликтах»; отказ проведения при удержании восстановления и работа после «Возобновить приём данных станций»; e2e облака с `DATABASE_URL`. Полный список — в `AGENTS.md`, «Verification».
