# План А4: листы палет А4 и логотип организации в автономном продукте (логотип Маркиро в поставке, загрузка логотипа в офисе, логотип на стандартных термоэтикетках, три готовых листа А4, выбор листа для смены, предпросмотр, печать листа на станции через драйвер Windows) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести в автономный продукт облачные PR #702 (редактируемые листы палет А4, `PalletSheetSpecV2`, общий рендер `renderPalletSheet`), #704 (полный предпросмотр А4 и тестовая печать А4 в настройке рабочего места), #705 (выбор листа едет со сменой), #706/#707 (встроенный логотип Маркиро для А4, редактируемый подвал с ИНН организации, замороженным в снимке) и #703 (стандартные термоэтикетки с элементом `organization_logo` — сейчас автономная станция печатает на его месте пустоту). Итог для пользователя: администратор загружает логотип организации в офисе (или печать берёт встроенный логотип Маркиро); стандартные этикетки коробов и палет печатаются и показываются в предпросмотре с логотипом; в офисе есть раздел «Листы А4» с тремя готовыми листами, включением, основным листом, переименованием, JSON-выгрузкой и загрузкой, предпросмотром; смена с паллетами получает лист (выбранный в офисе или основной), хост замораживает его вместе с названием, ИНН и логотипом организации в снимке смены; станция, у которой принтер назначения «Паллета» — драйвер Windows с бумагой «Лист А4», печатает на закрытии паллеты лист А4 вместо термоэтикетки, с тем же журналом заданий, проверкой и повтором, что у этикетки.

**Architecture:**

- Webview (задача 1): встроенный `src/assets/markiro-print-logo.svg`, модуль `src/labels/logo.ts` (монохромный логотип на проводе ↔ `MonoBitmap`, декодирование картинки в браузере через `logoFromRgba` домена, кеш встроенного логотипа Маркиро), строгий режим растеризатора `overflow: "error"` и `rasterizeSheetText` (шрифт обязан загрузиться), `src/labels/sheet-render.ts` (лист по номинальной геометрии А4, образец данных, уменьшенная отрисовка `MonoRaster` на canvas).
- Хост (задачи 2–4): миграция `host/migrations/0016_pallet_sheets_logo.sql` (`org_logo`, `pallet_sheet_templates`, `org_profile.default_pallet_sheet_template_id`, `shifts.pallet_sheet_template_id` с триггерами «только со паллетами»); маршруты `GET/PUT/DELETE /v1/office/org/logo`; `GET/POST /v1/office/pallet-sheets`, `PUT/DELETE /v1/office/pallet-sheets/{id}`, `PUT /v1/office/pallet-sheet-default`; `palletSheetTemplateId` в `ShiftCreate`/`ShiftUpdate`/`DeviceShiftCreate`/`OfficeShift`; снимок смены получает `palletSheet` и `organization { name, inn, logo }`. Хост не проверяет макет листа (только объект `schemaVersion: 2`, `kind: "pallet_sheet"`, не больше 64 КиБ) — макет проверяет домен в UI и на станции, как у этикеток.
- Протокол: новых видов фактов и полей фактов нет — `PROTOCOL_VERSION` остаётся 3. Новые поля запросов необязательны и посылаются только когда заданы; фикстуры `proto/fixtures` и Zod сверяются `proto/tests/fixtures.rs` и `test/protocol.test.ts`.
- Офис (задача 5): карточка «Логотип для печати» на странице организации, страница «Листы А4» (`/pallet-sheets`), поле «Лист А4» в диалоге смены.
- Логотип на термоэтикетках (задача 6): `renderLabel` принимает логотип; станция берёт логотип из снимка смены, иначе встроенный Маркиро; предпросмотр, миниатюры и выгрузки ZPL/TSPL офиса берут логотип организации, иначе Маркиро; `drawLabel` рисует `organization_logo`.
- Оболочка (задача 7, **после ДРВ**): режим страницы А4 в пути печати через драйвер Windows плана ДРВ — `DMPAPER_A4`, ориентация из растра, 100 %, одна копия, simplex, целочисленное увеличение 300→300/600/1200 dpi, проверка, что обязательная область растра лежит в печатной области устройства с зазором 0,5 мм; чистые функции `src-tauri/src/printer/sheet.rs` проверяются на любом хосте.
- Станция (задача 8, **после ДРВ**): профиль принтера получает `paper: "a4"` (только драйвер Windows, 300 dpi, только назначение «Паллета»); рендер задания паллеты выбирает лист А4 из снимка, когда принтер — А4; задание, журнал (`floor_print_jobs`), проверка сканом, «Напечатать снова», «Другой принтер» и восстановление неизвестного исхода — прежние; тестовая печать А4 с предпросмотром в настройке рабочего места; документы (`apps/standalone/AGENTS.md`, §29 спецификации пилота).
- Миграции оболочки нет (лист и логотип едут в снимке смены, который станция уже хранит текстом в `floor_shifts.snapshot`; `floor_print_jobs` хранит байты растра в `bytes_base64`). Не меняются: `apps/station`, `apps/admin`, `apps/api`, `packages/*`, `package.json`, `pnpm-lock.yaml`, `Cargo.lock`.

**Tech Stack:** React 19.2, TypeScript 6 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next, `@markiro/ui`, `@markiro/domain` (`buildPalletSheetPresets`, `parsePalletSheetSpec`, `parseStoredLabelJson`, `serializeStoredLabelJson`, `renderPalletSheet`, `nominalSheetGeometry`, `encodeMonoRaster`, `logoFromRgba`, `sheetLogoFingerprint`, `validateMonoBitmap`, `renderLabelLogo`, `wrapTextToWidthStrict`, `parseScannedSscc`), Vitest 4 с jsdom; Rust — axum, sqlx 0.8.6 (миграция хоста), `base64 0.22.1`, `windows-sys` (GDI плана ДРВ).

**Спецификации и источники:**

- Облачная спецификация `docs/superpowers/specs/2026-10-10-station-pallet-a4-printing-design.md` (дерево `/tmp/claude/wt/integ`): неизменные требования к готовым листам, модель V2, лимиты, брендинг, Windows-геометрия, надёжность повтора.
- Облачные коммиты (читать `git -C /tmp/claude/wt/integ show <sha>`): `81b596d7b` (#702), `e5ca750fd` (#704), `e86bba8e8` (#705), `bbcfc9c05` (#703), `b2fc1c84a` (#706), `a83850543` (#707), `1329be61c` (#696). Поведенческий образец, не архитектура: `apps/station/src/lib/pallet-sheet-printing.ts`, `a4-test-print.ts`, `organization-branding.ts` (`decodeBrowserLogo`, `loadBundledMarkiroLogo`), `src-tauri/src/printer_sheet.rs`, diff `printer_windows.rs` в `81b596d7b`.
- Домен (уже в дереве, не меняется): `packages/domain/src/labels/pallet-sheet-{model,render,defaults,snapshot,branding}.ts`, `stored-template.ts`, `mono-compose.ts`, `mono-raster.ts`, `label-logo.ts`.
- `.superpowers/sdd/main-drift-report.md` разделы C, D, E; `.superpowers/sdd/OWNER-DECISIONS.md` «DECISIONS 2026-10-11» (логотип = встроенный Маркиро, как #703, плюс загрузка логотипа организации; А4 переносится).
- Спецификация пилота `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — план дописывает **§29**.
- `apps/standalone/AGENTS.md` — разделы «Templates», «Shifts», «Floor printing», «Verification» (grep по заголовкам).

**Предпосылки:** поток PRT — план ДРВ (печать через драйвер Windows, #696) исполняется **до** этого плана и уже слит в рабочую ветку. Задачи 1–6 от ДРВ не зависят и могут идти первыми; задачи 7–8 опираются на его профиль принтера с режимом драйвера, его модуль печати через GDI и его мост `hardware`. Если на момент задач 7–8 ДРВ не слит — **запасной путь** (см. «Допущения», А4-10): задача 8 печатает лист через диалог печати WebView2 (растр листа в скрытом `iframe`, как формы плана О-Ф), без журнала отправки, а задача 7 переносится.

## Допущения

Решения планировщика; контроллер принимает их как рекомендованные, владелец может изменить.

- **А4-1. Хранение листов — своя таблица хоста `pallet_sheet_templates`, а не строки `label_templates`.** Облако хранит V2 в той же таблице с признаком `format`; в автономном продукте каждый потребитель `label_templates` (лента станции, копии `ref_templates`, выбор шаблонов смены, умолчания категорий, миниатюры) читает макет как V1 `labelTemplateSpecSchema`, и строка V2 сломала бы их все. `CHECK (purpose IN …)` таблицы не расширить без пересборки с внешними ключами. Своя таблица изолирует V1 полностью.
- **А4-2. Листы не едут в ленту станции.** Станция печатает лист только из снимка смены; выбор листа делает офис (и основной лист хоста для смен станции). Нет копий на станции — нет миграции оболочки.
- **А4-3. Выбор листа на станции — основной лист организации.** Смена, которую создаёт станция, получает основной лист хоста (если он есть и включён); выбор листа в форме новой смены станции и её предпросмотр А4 (облачный `NewShift` #704) — в «Перенесено». Офис выбирает лист явно в диалоге смены, пустой выбор = основной лист.
- **А4-4. Смена с паллетами всегда имеет термошаблон паллеты (V1), лист А4 — дополнительно.** Правило ПЛ-Х «паллеты ⇔ вместимость и шаблон паллеты» не меняется. Что печатать, решает принтер назначения «Паллета» на станции: «Лист А4» → лист из снимка, иначе термоэтикетка. Двойной печати нет: одно задание — один формат (как в облаке).
- **А4-5. Снимок смены несёт лист и организацию; поздние правки их не меняют.** `palletSheet { id, name, revision, spec }` и `organization { name, inn, logo }` замораживаются при открытии смены (как макеты этикеток). Логотип в снимке — уже монохромный (`width`, `height`, `pixelsBase64`), поэтому печать не декодирует картинок. Снимок ограничен 327 680 байтами (`MAX_SNAPSHOT_BYTES`); лист ≤ 64 КиБ, логотип ≤ 90 000 символов base64 — при больших макетах этикеток хост честно отвечает `snapshot_too_large`, как сейчас.
- **А4-6. Логотип хранится монохромным, его готовит офис.** Офис декодирует PNG/JPEG/WebP/SVG в браузере, уменьшает до 1024 × 512 с сохранением пропорций, переводит в 1 бит домена (`logoFromRgba`) и отправляет биты. Хост проверяет размер, длину, канонический base64 и нулевые биты добивки строки; картинок не разбирает. Один логотип на площадку, замена — полная, без ревизии (последняя запись побеждает), удаление — явное.
- **А4-7. Резерв — встроенный логотип Маркиро.** Нет логотипа организации → термоэтикетка и лист печатают логотип Маркиро (`fallback: "markiro"` домена, ресурс `markiro-print-logo.svg` из облачной станции). Не удалось декодировать встроенный логотип (webview без canvas) → термоэтикетка оставляет область пустой (как домен без `logo`), лист А4 не рендерится (`render_failed`, оператор решает на экране восстановления).
- **А4-8. Геометрия листа на станции — номинальная, проверка — в оболочке при отправке.** Облако измеряет геометрию драйвера до рендера и хранит её отпечаток. Здесь рендер идёт по `nominalSheetGeometry` (поля готовых листов 10 мм покрывают типичные непечатаемые поля лазерных принтеров 4–6,35 мм), а оболочка перед `StartDoc` сверяет обязательную область растра с реальной печатной областью устройства с зазором 0,5 мм и отказывает `geometry_mismatch` до отправки (`failed`, оператор может выбрать другой принтер). Измеренная геометрия и её отпечаток — «Перенесено».
- **А4-9. Задание листа — то же задание `floor_print_jobs`.** `template_id`/`template_rev` задания — термошаблона паллеты из снимка (правило `printAgain` «шаблон задания = шаблон снимка» не меняется), `fields` — поля `palletLabelFields`, `bytes_base64` — закодированный `mono-raster-v1` листа, `printer` — профиль с `paper: "a4"`. «Те же байты» при повторе: только если язык, dpi **и бумага** профиля совпадают, иначе рендер заново из снимка. Неизвестный исход не отправляется сам (правило 2a7).
- **А4-10. Запасной путь без ДРВ** (если поток PRT вынужден выпустить А4 раньше ДРВ): печать листа — PNG растра в скрытом `iframe` и `print()` WebView2 по образцу `office/forms/print-form.ts`; задание сразу `sent` с `verify = 1` (оператор подтверждает сканом SSCC листа). Это хуже (диалог печати, нет отказа до отправки), поэтому только запасной вариант; основной — задачи 7–8 после ДРВ.
- **А4-11. Редактор листа в офисе — JSON, не визуальный.** Минимум MVP: готовые листы, переименование, включение/выключение, основной лист, удаление (не основного и не названного запланированной сменой), «Скачать JSON» и «Загрузить JSON» (строгий разбор домена `parseStoredLabelJson`, всегда новая запись), предпросмотр. Визуальный редактор узлов, undo/redo, замена черновика из JSON — «Перенесено».
- **А4-12. Готовые листы добавляет офис, не мастер.** Кнопка «Добавить готовые листы» отправляет три пресета `buildPalletSheetPresets()` с их `presetKey`; повтор с тем же ключом возвращает существующую запись (идемпотентно, переименованный пресет не пересеивается). Мастер новой площадки не меняется (контракт `bootstrap` и его фикстуры не трогаем).
- **А4-13. Протокол не поднимается.** Новых видов фактов нет; новые поля запросов необязательны; станция той же поставки ставится вместе с хостом (правило AGENTS «station of protocol 3, installed together with the host's update»).
- **А4-14. Номер миграции хоста — `0016`** (распределение контроллера: I1 = 0013, ОЧ = 0014, WH = 0015, А4 = 0016). sqlx применяет недостающую миграцию с меньшим номером позже (`host/tests/backup_schema.rs` проверяет это для `0011`/`0012`), поэтому порядок слияния планов не важен. Миграции оболочки план не берёт (`0011` остаётся свободной).
- **А4-15. Права.** Логотип — администратор (как профиль организации). Листы и основной лист — администратор и технолог (`require_catalog`, как шаблоны). Чтение — все роли офиса.
- **А4-16. Импорт из облака (ИМП) листы не переносит.** Строки облака `label_templates.format = 'pallet_sheet_v2'`, `org_pallet_sheet_template_defaults`, `shifts.pallet_sheet_template_*` и логотип облака не импортируются (ИМП фильтрует `label_v1`); перенос — «Перенесено».

## Global Constraints

**Требования облачной спецификации к готовым листам (дословно, домен уже их держит)**

- «Контрагент не выводится. Шапка: настоящее название организации и её логотип; если логотип не установлен, встроенный логотип Маркиро.»
- «Прямоугольные логотипы сохраняют пропорции. Ограничена максимальная высота; ширина естественная, без квадратной рамки/обрезки.»
- «„Палета“ пишется с одной „л“. Внутренние `pallet` идентификаторы не переименовываются.» (Существующие ключи `ru.json` со словом «Паллета» план не переименовывает; новые тексты листов пишут «палета».)
- «SSCC, GTIN и ЕГАИС никогда не сокращаются. Длинный текст, который нельзя разместить, вызывает понятную ошибку до отправки вместо молчаливого обрезания.» (Отсюда `overflow: "error"` в растеризаторе.)
- «Нет исходной даты производства → нет подписи и даты; `closedAt` вместо неё не подставляется.»
- «Исходник `mono-raster-v1`, 300 dpi, ≤2 МиБ. Windows использует `DMPAPER_A4`, ориентацию из spec, 100%, simplex и одну копию.»
- «`Sending` фиксируется до транспорта. Сбой/таймаут/рестарт после начала отправки означает возможный `delivery_unknown`, без автоповтора.»
- «JSON export → import → export должен сохранять семантику spec.» Экспорт не несёт id записи, логотип, название организации.

**Распоряжение владельца 2026-10-11**

- «логотип = встроенный логотип Маркиро для печати (как #703) + загрузка логотипа организации»; «листы палет А4 (#702/#704/#705 + подвал/логотип) — перенести в автономную станцию»; максимальная скорость, задачи для исполнителя sonnet по одной, каждая проверяется отдельно.

**Правила автономного продукта (исполненное состояние)**

- Запись цеха — только через очередь работ и учёт (N9/N13); неизвестный исход печати **никогда** не отправляется повторно сам; повтор — только решение оператора.
- Новое SQL-выражение на растущей таблице станции закрепляет план запроса в `test/floor-schema.test.ts` (Node SQLite 3.53) **и** `src-tauri/tests/local_db.rs` (оболочка 3.46). План не добавляет таких выражений; если исполнитель добавит — закрепить в обоих.
- Паритет фикстур: каждая новая форма на проводе — фикстура `proto/fixtures/*.json`, круг в `proto/tests/fixtures.rs` и разбор Zod в `test/protocol.test.ts`.
- Ключи `src/i18n/ru.json` уникальны; переменные текстов именованные (не `count`); кириллица буквами.
- Экраны цеха: `@markiro/ui`, кнопки `size="floor"` (≥ 64 px), состояние словами; офис — обычные размеры `@markiro/ui`, доступные подписи (`aria-label` с именем записи), видимый фокус.
- React-тесты с гонками эффектов — стенд с задержкой `setImmediate` (`AGENTS.md`, «delayed-setImmediate stand»).
- Применённые миграции не меняются: оболочка `0001`–`0009` (+ `0010` плана ХП), хост `0001`–`0012`.
- TypeScript: без `any`, без приведений `as` (кроме `as const`) и `!`; `import type` для типов.
- Rust: `cargo fmt` чистый, без предупреждений; `Cargo.lock` не меняется; фича `windows-sys`, если её нет у ДРВ, добавляется в `src-tauri/Cargo.toml` (без изменения `Cargo.lock`) или отмечается как шаг владельца.
- Журнал процесса не видит SSCC, кодов, логотипа: в новых модулях нет `console.*`, хост не пишет `pixelsBase64` и `spec` в журнал (`host/tests/no_secrets_in_logs.rs` не трогается, но новые маршруты не логируют тела).
- Коммиты — явные пути, сообщение из файла, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены этим планом.

## Заметки для исполнения

- Рабочее дерево кода — ветка потока PRT (после ДРВ), не дерево планов. Пути ниже — от корня репозитория. Якоря взяты из `/tmp/claude/wt/integ` (HEAD `2c726efba`); ДРВ меняет `workstation-settings.ts`, `printer-draft.ts`, `WorkstationSetup.tsx`, `print-runtime.ts`, `hardware.ts` и `src-tauri/src/printer*.rs` — задачи 7–8 описывают правку по смыслу и называют, что взять у ДРВ; расхождение имён записать в «Отклонения при исполнении».
- Перед тестами потребителей в свежем дереве: `pnpm turbo run build --filter='@markiro/standalone^...'` (домен и `@markiro/ui` экспортируют `dist`).
- Команды проверки:
  - Vitest: `pnpm --filter @markiro/standalone exec vitest run test/<file>.test.ts`
  - Хост: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test <name>`
  - Протокол: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
  - Оболочка: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib printer::sheet` (имя пакета оболочки — из `apps/standalone/src-tauri/Cargo.toml`; при ошибке EPERM sysctl в песочнице — как в памяти проекта: запуск вне песочницы владельцем).
  - Гейты пакета в конце задачи: `pnpm --filter @markiro/standalone typecheck`, `pnpm --filter @markiro/standalone lint`, `node_modules/.bin/prettier --check <изменённые файлы>`; Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `cargo clippy` пакета, если уже используется в CI.
- Гейт `cargo test --workspace` автономного продукта выполнять частями по пакетам (память: «гейт cargo --workspace только частями»).
- Текст `ru.json` вставлять в существующие ветки ключей (`office.org`, `office.nav`, `office.shifts`, `floor.setup.printers`), не дублируя ветки; новая ветка `office.palletSheets`.
- Значок «Маркиро» копируется байт в байт: `cp apps/station/src/assets/markiro-print-logo.svg apps/standalone/src/assets/markiro-print-logo.svg`.

## Файлы

| Файл                                                                                                                                                                                                                                                                                                                          | Задача  | Что                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| `apps/standalone/src/assets/markiro-print-logo.svg`                                                                                                                                                                                                                                                                           | 1       | новый, копия облачного ресурса                               |
| `apps/standalone/src/labels/logo.ts`                                                                                                                                                                                                                                                                                          | 1       | новый: логотип на проводе, декодирование, встроенный Маркиро |
| `apps/standalone/src/labels/rasterizer.ts`                                                                                                                                                                                                                                                                                    | 1       | `overflow: "error"`, `rasterizeSheetText`                    |
| `apps/standalone/src/labels/sheet-render.ts`                                                                                                                                                                                                                                                                                  | 1       | новый: рендер листа, образец, уменьшенная отрисовка          |
| `apps/standalone/test/label-logo.test.ts`, `test/sheet-render.test.ts`, `test/label-raster.test.ts`                                                                                                                                                                                                                           | 1       | тесты                                                        |
| `apps/standalone/host/migrations/0016_pallet_sheets_logo.sql`                                                                                                                                                                                                                                                                 | 2       | новая миграция хоста                                         |
| `apps/standalone/host/src/validate.rs`                                                                                                                                                                                                                                                                                        | 2, 3    | `mono_logo`, `sheet_spec`, `preset_key`                      |
| `apps/standalone/host/src/audit.rs`                                                                                                                                                                                                                                                                                           | 2, 3    | действия `org.logo.*`, `pallet_sheet.*`                      |
| `apps/standalone/host/src/routes/org_logo.rs`                                                                                                                                                                                                                                                                                 | 2       | новый маршрут логотипа                                       |
| `apps/standalone/host/src/routes/pallet_sheets.rs`                                                                                                                                                                                                                                                                            | 3       | новый маршрут листов                                         |
| `apps/standalone/host/src/routes/mod.rs`, `host/src/server.rs`                                                                                                                                                                                                                                                                | 2, 3    | модули и маршруты                                            |
| `apps/standalone/host/src/shifts.rs`, `routes/office_shifts.rs`, `routes/device_shifts.rs`                                                                                                                                                                                                                                    | 4       | выбор листа, снимок                                          |
| `apps/standalone/proto/src/lib.rs`                                                                                                                                                                                                                                                                                            | 2–4     | `OrgLogo*`, `PalletSheet*`, поля смен и снимка               |
| `apps/standalone/proto/fixtures/*.json` (новые: `org-logo.json`, `org-logo-put.json`, `pallet-sheets.json`, `pallet-sheet.json`, `pallet-sheet-create.json`, `pallet-sheet-update.json`, `pallet-sheet-default-update.json`, `shift-create-pallet-sheet.json`, `device-shift-entered-sheet.json`; правка `office-shift.json`) | 2–4     | фикстуры                                                     |
| `apps/standalone/proto/tests/fixtures.rs`, `test/protocol.test.ts`                                                                                                                                                                                                                                                            | 2–4     | паритет                                                      |
| `apps/standalone/host/tests/org_logo.rs`, `host/tests/pallet_sheets.rs`, `host/tests/office_shifts.rs`, `host/tests/device_shifts.rs`                                                                                                                                                                                         | 2–4     | тесты хоста                                                  |
| `apps/standalone/src/host/protocol.ts`, `src/host/api.ts`, `src/host/requests.ts`                                                                                                                                                                                                                                             | 2–4     | Zod, клиент, построители                                     |
| `apps/standalone/src/floor/shifts/shift-snapshot.ts`, `test/support/shifts.ts`                                                                                                                                                                                                                                                | 4       | снимок станции                                               |
| `apps/standalone/src/office/org/OrgLogoCard.tsx`, `org/OrgProfilePage.tsx`                                                                                                                                                                                                                                                    | 5       | логотип в офисе                                              |
| `apps/standalone/src/office/sheets/PalletSheetsPage.tsx`, `sheets/SheetPreview.tsx`, `sheets/sheet-list.ts`                                                                                                                                                                                                                   | 5       | страница «Листы А4»                                          |
| `apps/standalone/src/office/routes.tsx`, `office/nav.ts`, `office/office-query.ts`                                                                                                                                                                                                                                            | 5       | маршрут, меню, ключи                                         |
| `apps/standalone/src/office/shifts/shift-form.ts`, `shifts/ShiftDialog.tsx`                                                                                                                                                                                                                                                   | 5       | поле «Лист А4»                                               |
| `apps/standalone/src/office/use-label-logo.ts`                                                                                                                                                                                                                                                                                | 6       | логотип для предпросмотра офиса                              |
| `apps/standalone/src/office/templates/label-renderer.ts`, `label-samples.ts`, `PreviewPane.tsx`, `TemplateThumb.tsx`, `TemplateEditor.tsx`                                                                                                                                                                                    | 6       | логотип в предпросмотре и выгрузках                          |
| `apps/standalone/src/floor/print/label-render.ts`, `src/floor/print/shift-render.ts` (новый), `src/floor/work/WorkScreen.tsx`                                                                                                                                                                                                 | 6, 8    | логотип и лист в рендере смены                               |
| `apps/standalone/src-tauri/src/printer/sheet.rs` (новый) и модуль печати через драйвер ДРВ                                                                                                                                                                                                                                    | 7       | режим страницы А4                                            |
| `apps/standalone/src/hardware/hardware.ts`                                                                                                                                                                                                                                                                                    | 7       | `paper` в вызове драйвера                                    |
| `apps/standalone/src/floor/setup/workstation-settings.ts`, `printer-draft.ts`, `WorkstationSetup.tsx`, `src/floor/setup/a4-test.ts` (новый)                                                                                                                                                                                   | 8       | бумага «Лист А4», тестовая печать                            |
| `apps/standalone/src/floor/print/print-resolution.ts`, `print-jobs.ts`                                                                                                                                                                                                                                                        | 8       | «те же байты» с бумагой, фильтр принтеров                    |
| `apps/standalone/src/i18n/ru.json`                                                                                                                                                                                                                                                                                            | 5, 6, 8 | тексты                                                       |
| `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`                                                                                                                                                                                                                               | 8       | документы, §29                                               |

### Task 1: Логотип и лист в webview — встроенный логотип Маркиро, логотип на проводе, строгий растеризатор, рендер и отрисовка листа

**Files:**

- Create: `apps/standalone/src/assets/markiro-print-logo.svg` (копия), `apps/standalone/src/labels/logo.ts`, `apps/standalone/src/labels/sheet-render.ts`, `apps/standalone/test/label-logo.test.ts`, `apps/standalone/test/sheet-render.test.ts`
- Modify: `apps/standalone/src/labels/rasterizer.ts`, `apps/standalone/test/label-raster.test.ts`

**Interfaces (для задач 2–8):**

- `WireLogo { width; height; pixelsBase64 }`; `logoToWire(bitmap): WireLogo`; `logoFromWire(logo): MonoBitmap | null`; `fitLogoSize(w, h): { width; height }`; `decodeLogoImage(src, scale?): Promise<MonoBitmap>`; `decodeLogoFile(file: Blob): Promise<MonoBitmap>`; `loadBundledMarkiroLogo(): Promise<MonoBitmap>`; `labelLogo(own: MonoBitmap | null, fallback?): Promise<MonoBitmap | null>`; `sheetLogoOf(bitmap, source): SheetLogo`.
- `rasterizeSheetText: RasterizeTextFn` (шрифт обязан загрузиться; `overflow` по умолчанию `"error"`).
- `renderSheetRaster(spec, context, rasterize?): Promise<MonoRaster>`; `renderSheetBytes(spec, context, rasterize?): Promise<Uint8Array>`; `sampleSheetContext(org, logo): PalletSheetContext`; `downsampleMonoRaster(raster, factor): { width; height; data: Uint8ClampedArray }`; `paintMonoRaster(canvas, raster, factor): void`.

- [ ] **Step 1: Скопировать ресурс**

```bash
mkdir -p apps/standalone/src/assets
cp apps/station/src/assets/markiro-print-logo.svg apps/standalone/src/assets/markiro-print-logo.svg
```

`vite/client` (уже в `tsconfig.json` `types`) объявляет модули `*.svg`, отдельный `.d.ts` не нужен.

- [ ] **Step 2: Написать падающие тесты логотипа**

`apps/standalone/test/label-logo.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { sheetLogoFingerprint, type MonoBitmap } from "@markiro/domain";

import {
  fitLogoSize,
  labelLogo,
  logoFromWire,
  logoToWire,
  MAX_LOGO_BASE64,
  sheetLogoOf,
} from "../src/labels/logo.js";

/** 10 × 2 dots: stride 2, the last 6 bits of each row are padding (zero). */
const BITMAP: MonoBitmap = {
  width: 10,
  height: 2,
  stride: 2,
  pixels: Uint8Array.from([0b1111_0000, 0b1100_0000, 0b0000_1111, 0b0100_0000]),
};

describe("logo on the wire", () => {
  it("round-trips a bitmap through its wire form", () => {
    const wire = logoToWire(BITMAP);
    expect(wire).toEqual({ width: 10, height: 2, pixelsBase64: "8MAPQA==" });
    expect(logoFromWire(wire)).toEqual(BITMAP);
  });

  it("reads nothing from a logo whose padding bits are set", () => {
    expect(logoFromWire({ width: 10, height: 2, pixelsBase64: "8MEPQA==" })).toBeNull();
  });

  it("reads nothing from a logo of the wrong length or size", () => {
    expect(logoFromWire({ width: 10, height: 3, pixelsBase64: "8MAPQA==" })).toBeNull();
    expect(logoFromWire({ width: 2000, height: 1, pixelsBase64: "AA==" })).toBeNull();
    expect(logoFromWire({ width: 8, height: 1, pixelsBase64: "not base64" })).toBeNull();
  });

  it("keeps the largest logo under the host's base64 bound", () => {
    // 1024 × 512 dots → 65 536 bytes → 87 384 base64 characters.
    expect(Math.ceil(((1024 / 8) * 512) / 3) * 4).toBeLessThanOrEqual(MAX_LOGO_BASE64);
  });
});

describe("fitLogoSize", () => {
  it("shrinks to 1024 × 512 keeping the aspect, never enlarges", () => {
    expect(fitLogoSize(2048, 512)).toEqual({ width: 1024, height: 256 });
    expect(fitLogoSize(600, 1200)).toEqual({ width: 256, height: 512 });
    expect(fitLogoSize(300, 100)).toEqual({ width: 300, height: 100 });
  });
});

describe("labelLogo", () => {
  it("prefers the organization's logo", async () => {
    const fallback = vi.fn(async () => BITMAP);
    await expect(labelLogo(BITMAP, fallback)).resolves.toBe(BITMAP);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to Markiro, and to nothing when Markiro does not load", async () => {
    await expect(labelLogo(null, async () => BITMAP)).resolves.toBe(BITMAP);
    await expect(
      labelLogo(null, async () => {
        throw new Error("no canvas");
      }),
    ).resolves.toBeNull();
  });
});

describe("sheetLogoOf", () => {
  it("names its source and the domain's fingerprint", () => {
    const logo = sheetLogoOf(BITMAP, "organization");
    expect(logo.source).toBe("organization");
    expect(logo.digest).toBe(sheetLogoFingerprint(BITMAP));
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/label-logo.test.ts` — Expected: FAIL (модуля нет).

- [ ] **Step 3: Реализовать `src/labels/logo.ts`**

```ts
import {
  logoFromRgba,
  sheetLogoFingerprint,
  validateMonoBitmap,
  type MonoBitmap,
  type SheetLogo,
} from "@markiro/domain";

// Vite gives this small SVG as a data URL (or a bundled file in a larger
// build): an <img> decodes either, since the webview's CSP allows `data:` and
// `'self'` images (`img-src 'self' data: blob:`); a `fetch` of a data URL would
// not pass `connect-src`, so the logo is never fetched.
import markiroLogoUrl from "../assets/markiro-print-logo.svg";

/**
 * A monochrome logo on the wire (`OrgLogo`, `ShiftSnapshotLogo` of
 * `markiro_proto`): its size in dots and its rows, MSB first, 1 = ink, each
 * row padded to whole bytes with zero bits, in standard base64.
 */
export interface WireLogo {
  width: number;
  height: number;
  pixelsBase64: string;
}

/** The host's bounds (`validate::mono_logo`): 1024 × 512 dots, 90 000 base64 characters. */
export const MAX_LOGO_WIDTH = 1024;
export const MAX_LOGO_HEIGHT = 512;
export const MAX_LOGO_BASE64 = 90_000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Only the canonical spelling: the host compares the text it stores.
  return toBase64(bytes) === text ? bytes : null;
}

/** A bitmap as the host takes it. */
export function logoToWire(bitmap: MonoBitmap): WireLogo {
  validateMonoBitmap(bitmap);
  return { width: bitmap.width, height: bitmap.height, pixelsBase64: toBase64(bitmap.pixels) };
}

/** The bitmap of a wire logo, or `null` for one this build cannot print. */
export function logoFromWire(logo: WireLogo): MonoBitmap | null {
  const { width, height, pixelsBase64 } = logo;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_LOGO_WIDTH ||
    height > MAX_LOGO_HEIGHT ||
    pixelsBase64.length > MAX_LOGO_BASE64
  ) {
    return null;
  }
  const pixels = fromBase64(pixelsBase64);
  if (pixels === null) return null;
  const bitmap: MonoBitmap = { width, height, stride: Math.ceil(width / 8), pixels };
  try {
    validateMonoBitmap(bitmap);
  } catch {
    return null;
  }
  return bitmap;
}

/** A logo's size within 1024 × 512 with its aspect kept; a smaller one stays as it is. */
export function fitLogoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_LOGO_WIDTH / width, MAX_LOGO_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes an image the webview can show into the domain's 1-bit logo, after
 * the cloud station's `decodeBrowserLogo`: drawn on white (a transparent
 * logo prints on paper), at `scale` times its natural size and never more
 * than 1024 × 512, then thresholded by `logoFromRgba`.
 */
export async function decodeLogoImage(src: string, scale = 1): Promise<MonoBitmap> {
  const image = new Image();
  image.src = src;
  await image.decode();
  if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error("empty logo image");
  const size = fitLogoSize(image.naturalWidth * scale, image.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("logo canvas unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  return logoFromRgba(
    size.width,
    size.height,
    context.getImageData(0, 0, size.width, size.height).data,
  );
}

/** A file the office picked (PNG, JPEG, WebP, SVG) as a logo. */
export async function decodeLogoFile(file: Blob): Promise<MonoBitmap> {
  const url = URL.createObjectURL(file);
  try {
    return await decodeLogoImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let bundled: Promise<MonoBitmap> | null = null;

/**
 * The Markiro print logo shipped with the app (#703, `loadBundledMarkiroLogo`
 * of the cloud station, at the same 3.5× scale), decoded once per session; a
 * failure is not kept, so the next label tries again.
 */
export function loadBundledMarkiroLogo(): Promise<MonoBitmap> {
  bundled ??= decodeLogoImage(markiroLogoUrl, 3.5).catch((error: unknown) => {
    bundled = null;
    throw error instanceof Error ? error : new Error(String(error));
  });
  return bundled;
}

/**
 * The logo a thermal label prints in its `organization_logo` box: the
 * organization's own, else the bundled Markiro logo (`fallback: "markiro"`),
 * else none — the box stays empty, as the domain's generators leave it
 * without a logo, and the label still prints.
 */
export async function labelLogo(
  own: MonoBitmap | null,
  fallback: () => Promise<MonoBitmap> = loadBundledMarkiroLogo,
): Promise<MonoBitmap | null> {
  if (own !== null) return own;
  try {
    return await fallback();
  } catch {
    return null;
  }
}

/** A bitmap as `renderPalletSheet` takes its logo. */
export function sheetLogoOf(bitmap: MonoBitmap, source: "organization" | "markiro"): SheetLogo {
  return { ...bitmap, digest: sheetLogoFingerprint(bitmap), source };
}
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/label-logo.test.ts` — Expected: PASS. (Ожидаемое `pixelsBase64` первого теста посчитать `btoa` по байтам `F0 C0 0F 40`; если значение в тесте не совпало — исправить ожидание теста, не код, и записать в «Отклонения».)

- [ ] **Step 4: Строгий режим растеризатора**

В `apps/standalone/src/labels/rasterizer.ts`:

1. Импорт домена дополнить `wrapTextToWidthStrict` (рядом с `wrapTextToWidth`).
2. В деструктуризации `rasterizeTextSync` (якорь `minFontSizePx,\n  }: RasterizeTextOptions,`) добавить `overflow,`.
3. Строку

```ts
const lines = bounded ? wrapTextToWidth(text, measure, maxWidthPx, maxLines ?? 1) : [text];
```

заменить на

```ts
// A sheet (V2) refuses a text it cannot place in full (`overflow: "error"`,
// the domain's strict wrap throws); a label keeps the «…» it always had.
const wrap = overflow === "error" ? wrapTextToWidthStrict : wrapTextToWidth;
const lines = bounded ? wrap(text, measure, maxWidthPx, maxLines ?? 1) : [text];
```

(сигнатура `wrapTextToWidthStrict` — как у `wrapTextToWidth`, проверить по `packages/domain/src/labels/wrap.ts`; если отличается — привести вызов, записать.)

4. В конец файла:

```ts
/**
 * The rasterizer of an A4 sheet (plan А4, the cloud station's
 * `rasterizeDriverText`): the bundled face must load and cover the text,
 * because a sheet is never printed in a fallback face whose metrics the
 * layout was not measured with, and a text that does not fit is an error
 * (`overflow: "error"` unless the caller says otherwise).
 */
export const rasterizeSheetText: RasterizeTextFn = async (text, options) => {
  const font = fontShorthand(options.fontFamily, options.fontSizePx, options.bold);
  const sample = text === "" ? "Аа" : text;
  if (!document.fonts) throw new RasterUnavailableError();
  const loaded = await document.fonts.load(font, sample);
  if (loaded.length === 0 || !document.fonts.check(font, sample)) {
    throw new RasterUnavailableError();
  }
  return rasterizeTextSync(text, { ...options, overflow: options.overflow ?? "error" });
};
```

(Конструктор `RasterUnavailableError` — как он объявлен в файле; если он требует сообщение — передать «Bundled label font is unavailable».)

- [ ] **Step 5: Тест строгого режима**

В `apps/standalone/test/label-raster.test.ts` добавить (стенд `fakeCanvases` файла уже есть):

```ts
describe("overflow: error (A4 sheets, plan А4)", () => {
  it("refuses a text that needs more lines than allowed instead of cutting it", async () => {
    fakeCanvases({ charWidth: 10 });
    await expect(
      rasterizeText("очень длинное название продукта", {
        fontFamily: "sans-serif",
        fontSizePx: 20,
        bold: false,
        maxWidthPx: 60,
        maxLines: 1,
        overflow: "error",
      }),
    ).rejects.toThrow();
  });

  it("keeps the ellipsis of a label by default", async () => {
    fakeCanvases({ charWidth: 10 });
    await expect(
      rasterizeText("очень длинное название продукта", {
        fontFamily: "sans-serif",
        fontSizePx: 20,
        bold: false,
        maxWidthPx: 60,
        maxLines: 1,
      }),
    ).resolves.toMatchObject({ height: 30 });
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/label-raster.test.ts` — Expected: PASS (новые и старые).

- [ ] **Step 6: Падающий тест рендера листа**

`apps/standalone/test/sheet-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { sheetLogoOf } from "../src/labels/logo.js";
import {
  downsampleMonoRaster,
  renderSheetBytes,
  renderSheetRaster,
  sampleSheetContext,
} from "../src/labels/sheet-render.js";

/** A text as a bar one dot per character wide and one line high: enough to lay out a sheet. */
const fakeRasterize: RasterizeTextFn = async (text, options) => {
  const width = Math.max(1, Math.min(text.length * 4, options.maxWidthPx ?? text.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };

describe("renderSheetRaster", () => {
  it.each(buildPalletSheetPresets().map((preset) => [preset.key, preset] as const))(
    "renders the stock sheet %s at A4 300 dpi",
    async (_key, preset) => {
      const context = sampleSheetContext(
        { name: "ООО «Пример»", inn: "7700000000" },
        sheetLogoOf(LOGO, "organization"),
      );
      const raster = await renderSheetRaster(preset.spec, context, fakeRasterize);
      const portrait = preset.spec.page.orientation === "portrait";
      expect(raster.dpi).toBe(300);
      expect([raster.widthMm, raster.heightMm]).toEqual(portrait ? [210, 297] : [297, 210]);
      const bytes = await renderSheetBytes(preset.spec, context, fakeRasterize);
      expect(decodeMonoRaster(bytes).widthDots).toBe(raster.widthDots);
    },
  );
});

describe("downsampleMonoRaster", () => {
  it("paints an output pixel black when any dot of its square is black", async () => {
    const [preset] = buildPalletSheetPresets();
    if (preset === undefined) throw new Error("no stock sheet");
    const raster = await renderSheetRaster(
      preset.spec,
      sampleSheetContext({ name: "ООО «Пример»", inn: null }, sheetLogoOf(LOGO, "markiro")),
      fakeRasterize,
    );
    const small = downsampleMonoRaster(raster, 4);
    expect(small.width).toBe(Math.ceil(raster.widthDots / 4));
    expect(small.data.length).toBe(small.width * small.height * 4);
    // The SSCC bars are ink somewhere on the sheet.
    expect(small.data.some((value, index) => index % 4 === 0 && value === 0)).toBe(true);
  });
});
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/sheet-render.test.ts` — Expected: FAIL (модуля нет).

- [ ] **Step 7: Реализовать `src/labels/sheet-render.ts`**

```ts
import {
  encodeMonoRaster,
  nominalSheetGeometry,
  renderPalletSheet,
  type MonoRaster,
  type PalletSheetContext,
  type PalletSheetSpecV2,
  type RasterizeTextFn,
  type SheetLogo,
} from "@markiro/domain";

import { rasterizeSheetText } from "./rasterizer.js";

/**
 * A sheet at A4's nominal geometry (plan А4, decision А4-8): the stock
 * sheets' 10 mm margins hold any usual laser printer's unprintable edge, and
 * the shell checks the real printable area before it sends. The domain's
 * renderer runs the sheet's own tree; preview and print call this one function,
 * so they cannot drift.
 */
export function renderSheetRaster(
  spec: PalletSheetSpecV2,
  context: PalletSheetContext,
  rasterize: RasterizeTextFn = rasterizeSheetText,
): Promise<MonoRaster> {
  return renderPalletSheet(spec, context, nominalSheetGeometry(spec), rasterize);
}

/** The sheet as the bytes a print job keeps and the shell prints (`mono-raster-v1`). */
export async function renderSheetBytes(
  spec: PalletSheetSpecV2,
  context: PalletSheetContext,
  rasterize: RasterizeTextFn = rasterizeSheetText,
): Promise<Uint8Array> {
  return encodeMonoRaster(await renderSheetRaster(spec, context, rasterize));
}

/**
 * The synthetic pallet a preview shows (the cloud admin's sheet preview
 * data): never a code of production — the SSCC's company prefix is 9999.
 */
export function sampleSheetContext(
  organization: { name: string; inn: string | null },
  logo: SheetLogo,
): PalletSheetContext {
  return {
    sscc: "199990000000000012",
    productPrintName: "Молоко питьевое ультрапастеризованное 3,2 %, 0,9 л",
    gtin14: "04600000000015",
    egaisCode: null,
    productionDate: "2026-10-11",
    shelfLifeDays: 10,
    boxCount: 48,
    itemCount: 576,
    shiftNumber: "OCT26-001",
    organizationName: organization.name,
    organizationInn: organization.inn,
    logo,
  };
}

/**
 * A sheet shrunk by a whole `factor` for the screen: an output pixel is black
 * when any dot of its `factor × factor` square is, so a thin bar never
 * vanishes from the preview. RGBA, ready for `ImageData`.
 */
export function downsampleMonoRaster(
  raster: MonoRaster,
  factor: number,
): { width: number; height: number; data: Uint8ClampedArray } {
  const width = Math.ceil(raster.widthDots / factor);
  const height = Math.ceil(raster.heightDots / factor);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < raster.heightDots; y++) {
    const row = y * raster.stride;
    for (let byteX = 0; byteX < raster.stride; byteX++) {
      const value = raster.pixels[row + byteX] ?? 0;
      if (value === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((value & (0x80 >> bit)) === 0) continue;
        const x = byteX * 8 + bit;
        if (x >= raster.widthDots) continue;
        const offset = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
  }
  return { width, height, data };
}

/** Draws a sheet shrunk by `factor` on `canvas`, resized to fit it. */
export function paintMonoRaster(canvas: HTMLCanvasElement, raster: MonoRaster, factor: number) {
  const small = downsampleMonoRaster(raster, factor);
  canvas.width = small.width;
  canvas.height = small.height;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.putImageData(new ImageData(small.data, small.width, small.height), 0, 0);
}
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/sheet-render.test.ts test/label-logo.test.ts test/label-raster.test.ts` — Expected: PASS. Если `renderPalletSheet` с подставным растеризатором отказывает (например, текст шире ячейки) — сузить ширину в `fakeRasterize`, не меняя модуль; записать.

- [ ] **Step 8: Гейты и коммит**

```bash
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
node_modules/.bin/prettier --check apps/standalone/src/labels apps/standalone/test/label-logo.test.ts apps/standalone/test/sheet-render.test.ts apps/standalone/test/label-raster.test.ts
git add apps/standalone/src/assets/markiro-print-logo.svg apps/standalone/src/labels/logo.ts apps/standalone/src/labels/sheet-render.ts apps/standalone/src/labels/rasterizer.ts apps/standalone/test/label-logo.test.ts apps/standalone/test/sheet-render.test.ts apps/standalone/test/label-raster.test.ts
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the Markiro print logo, the wire logo and the A4 sheet render in the webview (plan А4, task 1)` + пустая строка + трейлер.

### Task 2: Хост — миграция `0016`, логотип организации (`GET/PUT/DELETE /v1/office/org/logo`), протокол и клиент

**Files:**

- Create: `apps/standalone/host/migrations/0016_pallet_sheets_logo.sql`, `apps/standalone/host/src/routes/org_logo.rs`, `apps/standalone/host/tests/org_logo.rs`, `apps/standalone/proto/fixtures/org-logo.json`, `apps/standalone/proto/fixtures/org-logo-put.json`
- Modify: `apps/standalone/host/src/validate.rs`, `host/src/audit.rs`, `host/src/routes/mod.rs`, `host/src/server.rs`, `apps/standalone/proto/src/lib.rs`, `proto/tests/fixtures.rs`, `apps/standalone/src/host/protocol.ts`, `src/host/api.ts`, `src/office/office-query.ts`, `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- Провод: `GET /v1/office/org/logo` (все роли) → `OrgLogoState { logo: OrgLogo | null }`; `PUT` (администратор) тело `OrgLogoPut { width, height, pixelsBase64 }` → `OrgLogoState`; `DELETE` (администратор) → `OrgLogoState { logo: null }`. `OrgLogo { width, height, pixelsBase64, updatedAt }`.
- Хост: `routes::org_logo::read_logo(conn) -> Result<Option<OrgLogo>, ApiError>` (задача 4 берёт его для снимка); `validate::mono_logo(prefix, width, height, pixels_base64)`.
- Клиент: `HostApi.getOrgLogo(token)`, `putOrgLogo(token, put)`, `deleteOrgLogo(token)`; `officeKeys.orgLogo`.

- [ ] **Step 1: Миграция**

`apps/standalone/host/migrations/0016_pallet_sheets_logo.sql`:

```sql
-- A4 pallet sheets and the organization's print logo (plan А4, pilot spec
-- §29). Numbered 0016 by the plans' allocation; sqlx applies a missing lower
-- number later (see `tests/backup_schema.rs`), so the order the plans merge
-- in does not matter.

-- The organization's print logo, one row or none: already monochrome (the
-- office thresholds the picture), rows MSB first, 1 = ink, padded to whole
-- bytes with zero bits, standard base64. `validate::mono_logo` checks the
-- length and the padding; the CHECKs hold what no row may break.
CREATE TABLE org_logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
  pixels_base64 TEXT NOT NULL CHECK (length(pixels_base64) BETWEEN 4 AND 90000),
  updated_at TEXT NOT NULL
);

-- An A4 pallet sheet (the cloud's `PalletSheetSpecV2`, #702). The host keeps
-- `spec` an object of `schemaVersion` 2 and `kind` "pallet_sheet" of at most
-- 64 KiB; the domain checks the layout in the office and at the station. A
-- stock sheet carries its preset's key, so adding the stock sheets again
-- answers the ones already there. `revision` counts the sheet's own changes
-- (a shift freezes it with the sheet). Sheets are not in the station feed:
-- a station prints a sheet only from a shift's snapshot.
CREATE TABLE pallet_sheet_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  preset_key TEXT UNIQUE CHECK (preset_key IS NULL OR (length(preset_key) BETWEEN 1 AND 64
    AND preset_key NOT GLOB '*[^a-z0-9-]*')),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'
    AND length(CAST(spec AS BLOB)) <= 65536),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The organization's default sheet: an enabled sheet, or none.
ALTER TABLE org_profile ADD COLUMN default_pallet_sheet_template_id TEXT
  REFERENCES pallet_sheet_templates (id);

-- The sheet a shift with pallets prints on an A4 printer. No foreign key, as
-- `box_template_id`: once the shift is open the sheet lives in its snapshot,
-- and a sheet a planned shift names is never deleted (`template_in_use`).
ALTER TABLE shifts ADD COLUMN pallet_sheet_template_id TEXT;
CREATE INDEX shifts_planned_pallet_sheet ON shifts (pallet_sheet_template_id)
  WHERE status = 'planned';

-- Only a shift with pallets names a sheet (`0009` takes no new CHECK without
-- a rebuild, as in `0012`).
CREATE TRIGGER shifts_pallet_sheet_insert BEFORE INSERT ON shifts
WHEN NEW.pallet_sheet_template_id IS NOT NULL AND NEW.pallets_enabled = 0
BEGIN
  SELECT RAISE(ABORT, 'shift pallet sheet: only a shift with pallets');
END;
CREATE TRIGGER shifts_pallet_sheet_update
BEFORE UPDATE OF pallets_enabled, pallet_sheet_template_id ON shifts
WHEN NEW.pallet_sheet_template_id IS NOT NULL AND NEW.pallets_enabled = 0
BEGIN
  SELECT RAISE(ABORT, 'shift pallet sheet: only a shift with pallets');
END;
```

Проверка: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test foundation` — Expected: PASS (тест сравнивает число применённых миграций с `MIGRATOR`). Если есть тест, перечисляющий таблицы схемы или резервной копии (`grep -rn "sscc_counters" apps/standalone/host/tests | grep -i "table"`), дописать в его список `org_logo` и `pallet_sheet_templates`.

- [ ] **Step 2: Протокол — типы логотипа**

В `apps/standalone/proto/src/lib.rs` после `OrgProfileUpdate` (якорь `/// \`PUT /v1/office/org\`.` и следующая за ним структура) добавить:

```rust
/// The organization's print logo (plan А4): monochrome, `width` × `height`
/// dots, rows MSB first, 1 = ink, each row padded to whole bytes with zero
/// bits, in standard base64. Labels with an `organization_logo` element and
/// A4 sheets print it; without one they print the bundled Markiro logo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgLogo {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
    pub updated_at: String,
}

/// `GET`, `PUT` and `DELETE /v1/office/org/logo`: the logo, or `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgLogoState {
    pub logo: Option<OrgLogo>,
}

/// `PUT /v1/office/org/logo` (administrators): the whole logo, replacing any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgLogoPut {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
}
```

Фикстуры:

`apps/standalone/proto/fixtures/org-logo.json`:

```json
{
  "logo": {
    "width": 10,
    "height": 2,
    "pixelsBase64": "8MAPQA==",
    "updatedAt": "2026-10-11T09:00:00.000Z"
  }
}
```

`apps/standalone/proto/fixtures/org-logo-put.json`:

```json
{ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" }
```

В `proto/tests/fixtures.rs` импорт дополнить `OrgLogoPut, OrgLogoState` и добавить:

```rust
/// The organization's print logo (plan А4): the answer and the `PUT` body.
#[test]
fn org_logo_fixtures_round_trip() {
    let state: OrgLogoState = round_trip("org-logo.json");
    let logo = state.logo.expect("the fixture has a logo");
    assert_eq!((logo.width, logo.height), (10, 2));
    let put: OrgLogoPut = round_trip("org-logo-put.json");
    assert_eq!(put.pixels_base64, logo.pixels_base64);
    let none: OrgLogoState = serde_json::from_value(serde_json::json!({ "logo": null })).unwrap();
    assert_eq!(none.logo, None);
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto` — Expected: PASS.

- [ ] **Step 3: Проверка логотипа и действия аудита**

В `apps/standalone/host/src/validate.rs` после `template_spec` добавить:

```rust
/// The largest print logo the host keeps (plan А4): 1024 × 512 dots, at most
/// 90 000 characters of base64 (a whole 1024 × 512 logo is 87 384).
pub const MAX_LOGO_WIDTH: u32 = 1024;
pub const MAX_LOGO_HEIGHT: u32 = 512;
pub const MAX_LOGO_BASE64: usize = 90_000;

/// A monochrome logo: its size within bounds, its bits in canonical standard
/// base64, exactly `ceil(width / 8) × height` bytes, and every row's padding
/// bits zero (the domain's `validateMonoBitmap` refuses a logo otherwise, so
/// the host never keeps one a station could not print).
pub fn mono_logo(
    prefix: &str,
    width: u32,
    height: u32,
    pixels_base64: &str,
) -> Result<(), ApiError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let field = |name: &str| format!("{prefix}{name}");
    if !(1..=MAX_LOGO_WIDTH).contains(&width) {
        return Err(ApiError::validation(&field("width"), "1 to 1024 dots"));
    }
    if !(1..=MAX_LOGO_HEIGHT).contains(&height) {
        return Err(ApiError::validation(&field("height"), "1 to 512 dots"));
    }
    let pixels = field("pixelsBase64");
    if pixels_base64.len() > MAX_LOGO_BASE64 {
        return Err(ApiError::validation(&pixels, "at most 90000 characters"));
    }
    let bytes = STANDARD
        .decode(pixels_base64)
        .map_err(|_| ApiError::validation(&pixels, "standard base64"))?;
    if STANDARD.encode(&bytes) != pixels_base64 {
        return Err(ApiError::validation(&pixels, "canonical standard base64"));
    }
    let stride = width.div_ceil(8) as usize;
    if bytes.len() != stride * height as usize {
        return Err(ApiError::validation(&pixels, "ceil(width / 8) × height bytes"));
    }
    let unused = (8 - width % 8) % 8;
    if unused != 0 {
        let mask = (1u8 << unused) - 1;
        if bytes.chunks(stride).any(|row| row[stride - 1] & mask != 0) {
            return Err(ApiError::validation(&pixels, "the padding bits of a row are zero"));
        }
    }
    Ok(())
}
```

Модульные тесты в `#[cfg(test)] mod tests` того же файла (добавить в существующий модуль):

```rust
    #[test]
    fn a_mono_logo_is_checked_to_the_bit() {
        assert!(mono_logo("", 10, 2, "8MAPQA==").is_ok());
        // A padding bit set in the second row's last byte.
        assert!(mono_logo("", 10, 2, "8MAPQQ==").is_err());
        assert!(mono_logo("", 10, 3, "8MAPQA==").is_err());
        assert!(mono_logo("", 0, 2, "8MAPQA==").is_err());
        assert!(mono_logo("", 1025, 1, "AA==").is_err());
        assert!(mono_logo("", 8, 1, "AA").is_err());
    }
```

(`"8MAPQQ=="` = байты `F0 C0 0F 41`, младший бит добивки второй строки установлен.)

В `apps/standalone/host/src/audit.rs`, модуль `actions`, после `TEMPLATE_DEFAULTS_UPDATE` добавить:

```rust
    pub const ORG_LOGO_SET: &str = "org.logo.set";
    pub const ORG_LOGO_CLEAR: &str = "org.logo.clear";
    pub const PALLET_SHEET_CREATE: &str = "pallet_sheet.create";
    pub const PALLET_SHEET_UPDATE: &str = "pallet_sheet.update";
    pub const PALLET_SHEET_DELETE: &str = "pallet_sheet.delete";
    pub const PALLET_SHEET_DEFAULT: &str = "pallet_sheet.default";
```

(Если в `audit.rs` есть список всех действий для теста — дописать туда же.)

- [ ] **Step 4: Падающие тесты маршрута**

`apps/standalone/host/tests/org_logo.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_trail};

fn logo() -> Value {
    json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" })
}

#[tokio::test]
async fn a_fresh_host_has_no_logo() {
    let admin = admin().await;
    let (status, body) = admin.call("GET", "/v1/office/org/logo", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "logo": null }));
}

#[tokio::test]
async fn the_administrator_sets_replaces_and_clears_the_logo() {
    let admin = admin().await;
    let (status, set) = admin.call("PUT", "/v1/office/org/logo", Some(logo())).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(set["logo"]["pixelsBase64"], "8MAPQA==");
    let (_, read) = admin.call("GET", "/v1/office/org/logo", None).await;
    assert_eq!(read, set);

    let wider = json!({ "width": 16, "height": 1, "pixelsBase64": "/wA=" });
    let (status, replaced) = admin.call("PUT", "/v1/office/org/logo", Some(wider)).await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_eq!(replaced["logo"]["width"], 16);

    let (status, cleared) = admin.call("DELETE", "/v1/office/org/logo", None).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared, json!({ "logo": null }));

    let trail = audit_trail(&admin.app, "org.logo.set").await;
    assert_eq!(trail.len(), 2);
    assert_eq!(audit_trail(&admin.app, "org.logo.clear").await.len(), 1);
}

#[tokio::test]
async fn a_logo_with_a_set_padding_bit_is_refused() {
    let admin = admin().await;
    let body = json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQQ==" });
    let (status, error) = admin.call("PUT", "/v1/office/org/logo", Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["error"]["details"]["field"], "pixelsBase64");
}

#[tokio::test]
async fn a_technologist_reads_but_does_not_change_the_logo() {
    let admin = admin().await;
    let token = admin.technologist().await;
    let (status, _) = admin.call_as(&token, "GET", "/v1/office/org/logo", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .call_as(&token, "PUT", "/v1/office/org/logo", Some(logo()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
```

Код и форма ошибки проверки (`UNPROCESSABLE_ENTITY`, путь `error.details.field`) — взять из существующего теста `validation_failed` (например, `host/tests/templates.rs`, функция `error`) и привести ассерты к нему; поля аудита (`actor`, `target_type`, `details`) проверить так же, как `templates.rs` проверяет `template.create` (`admin.row(...)`), — точное равенство строки аудита, не только количество.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test org_logo` — Expected: FAIL (маршрута нет).

- [ ] **Step 5: Маршрут**

`apps/standalone/host/src/routes/org_logo.rs`:

```rust
//! The organization's print logo (plan А4): `GET /v1/office/org/logo` (every
//! role), `PUT` and `DELETE` (administrators). The office sends the logo
//! already monochrome; the host checks its bits (`validate::mono_logo`) and
//! keeps one row or none. A change takes no revision: the logo is not in the
//! station feed, a shift freezes it in its snapshot when a station opens it.
//! The logo's bits are never written to the audit trail or the log.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgLogo, OrgLogoPut, OrgLogoState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

/// The logo, or `None`; the shift snapshot (plan А4) reads it too.
pub async fn read_logo(conn: &mut SqliteConnection) -> Result<Option<OrgLogo>, ApiError> {
    let row: Option<(u32, u32, String, String)> = sqlx::query_as(
        "SELECT width, height, pixels_base64, updated_at FROM org_logo WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.map(|(width, height, pixels_base64, updated_at)| OrgLogo {
        width,
        height,
        pixels_base64,
        updated_at,
    }))
}

pub async fn get_logo(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OrgLogoState>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState {
        logo: read_logo(&mut conn).await?,
    }))
}

pub async fn put_logo(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(put): ApiJson<OrgLogoPut>,
) -> Result<Json<OrgLogoState>, ApiError> {
    context.require_admin()?;
    validate::mono_logo("", put.width, put.height, &put.pixels_base64)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query(
        "INSERT INTO org_logo (id, width, height, pixels_base64, updated_at) \
         VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET width = excluded.width, \
         height = excluded.height, pixels_base64 = excluded.pixels_base64, \
         updated_at = excluded.updated_at",
    )
    .bind(put.width)
    .bind(put.height)
    .bind(&put.pixels_base64)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::ORG_LOGO_SET,
            target_type: Some("org_profile"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "width": put.width, "height": put.height }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState {
        logo: Some(OrgLogo {
            width: put.width,
            height: put.height,
            pixels_base64: put.pixels_base64,
            updated_at: at,
        }),
    }))
}

/// Clears the logo; clearing none writes nothing and answers the same.
pub async fn delete_logo(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<OrgLogoState>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let removed = sqlx::query("DELETE FROM org_logo WHERE id = 1")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if removed > 0 {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::ORG_LOGO_CLEAR,
                target_type: Some("org_profile"),
                target_id: Some("1"),
                outcome: Outcome::Ok,
                details: json!({}),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState { logo: None }))
}
```

`host/src/routes/mod.rs`: `pub mod org_logo;` (по алфавиту после `pub mod org;`). `host/src/server.rs` в `protected_routes()` после маршрута `"/v1/office/org"`:

```rust
        .route(
            "/v1/office/org/logo",
            get(crate::routes::org_logo::get_logo)
                .put(crate::routes::org_logo::put_logo)
                .delete(crate::routes::org_logo::delete_logo),
        )
```

(`delete` импортировать из `axum::routing`, если его ещё нет в `use` файла.) Если хост ограничивает тело запроса меньше 128 КиБ (`grep -n "DefaultBodyLimit" host/src/server.rs`), этому маршруту нужен лимит не меньше 128 КиБ — записать.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test org_logo` и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate` — Expected: PASS.

- [ ] **Step 6: Zod, клиент, ключ запроса**

`apps/standalone/src/host/protocol.ts` после `orgProfileSchema`:

```ts
/** Mirrors `markiro_proto::OrgLogo`: the organization's monochrome print logo (plan А4). */
export const orgLogoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelsBase64: z.string(),
  updatedAt: z.iso.datetime(),
});
export type OrgLogo = z.infer<typeof orgLogoSchema>;

/** Mirrors `markiro_proto::OrgLogoState`: `GET`/`PUT`/`DELETE /v1/office/org/logo`. */
export const orgLogoStateSchema = z.object({ logo: orgLogoSchema.nullable() });
export type OrgLogoState = z.infer<typeof orgLogoStateSchema>;

/** Mirrors `markiro_proto::OrgLogoPut`: the whole logo, replacing any. */
export const orgLogoPutSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelsBase64: z.string(),
  })
  .strict();
export type OrgLogoPut = z.infer<typeof orgLogoPutSchema>;
```

`test/protocol.test.ts`: в список ответов добавить `["org-logo.json", orgLogoStateSchema],`, в `REQUESTS` — `["org-logo-put.json", orgLogoPutSchema],` (и импорты).

`apps/standalone/src/host/api.ts`: в интерфейс `HostApi` после `updateOrg`:

```ts
getOrgLogo: (token: string) => Promise<OrgLogoState>;
putOrgLogo: (token: string, put: OrgLogoPut) => Promise<OrgLogoState>;
deleteOrgLogo: (token: string) => Promise<OrgLogoState>;
```

в реализацию после `updateOrg: …`:

```ts
    getOrgLogo: (token) =>
      client.request("GET", "/v1/office/org/logo", {
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
    putOrgLogo: (token, put) =>
      client.request("PUT", "/v1/office/org/logo", {
        body: put,
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
    deleteOrgLogo: (token) =>
      client.request("DELETE", "/v1/office/org/logo", {
        officeToken: token,
        schema: orgLogoStateSchema,
      }),
```

Если в тестах есть подставной `HostApi` с полным набором членов (`grep -rln "updateOrg:" apps/standalone/test`), дописать в него три члена (`vi.fn()`), иначе typecheck упадёт.

`apps/standalone/src/office/office-query.ts`, `officeKeys`, после `org`: `orgLogo: ["office", "org-logo"],`.

- [ ] **Step 7: Проверки и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test org_logo --test foundation
pnpm --filter @markiro/standalone exec vitest run test/protocol.test.ts
pnpm --filter @markiro/standalone typecheck
git add apps/standalone/host/migrations/0016_pallet_sheets_logo.sql apps/standalone/host/src/routes/org_logo.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/org_logo.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/org-logo.json apps/standalone/proto/fixtures/org-logo-put.json apps/standalone/src/host/protocol.ts apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/test/protocol.test.ts
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the organization's print logo on the host and migration 0016 (plan А4, task 2)` + трейлер. (Плюс подставные `HostApi` тестов, если правились.)

### Task 3: Хост — листы А4: список, готовые листы, переименование, включение, удаление, основной лист

**Files:**

- Create: `apps/standalone/host/src/routes/pallet_sheets.rs`, `apps/standalone/host/tests/pallet_sheets.rs`, `apps/standalone/proto/fixtures/pallet-sheets.json`, `pallet-sheet.json`, `pallet-sheet-create.json`, `pallet-sheet-update.json`, `pallet-sheet-default-update.json`
- Modify: `apps/standalone/host/src/validate.rs`, `host/src/routes/mod.rs`, `host/src/server.rs`, `apps/standalone/proto/src/lib.rs`, `proto/tests/fixtures.rs`, `apps/standalone/src/host/protocol.ts`, `src/host/api.ts`, `src/office/office-query.ts`, `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- `GET /v1/office/pallet-sheets` (все роли) → `PalletSheets { sheets: PalletSheet[], defaultId: string | null }`, листы по имени.
- `POST /v1/office/pallet-sheets` (`require_catalog`) тело `PalletSheetCreate { name, presetKey?: string | null, enabled?: bool = true, spec }` → `PalletSheet`; повтор с уже существующим `presetKey` возвращает существующую запись без записи и аудита.
- `PUT /v1/office/pallet-sheets/{id}` (`require_catalog`) тело `PalletSheetUpdate { name?, enabled?, expectedRevision }` → `PalletSheet`; `revision + 1` только при изменении; выключить основной лист — `conflict template_is_default`; несовпадение ревизии — `stale_revision`.
- `DELETE /v1/office/pallet-sheets/{id}` (`require_catalog`) → 204; основной — `conflict template_is_default`; названный запланированной сменой — `conflict template_in_use`.
- `PUT /v1/office/pallet-sheet-default` (`require_catalog`) тело `PalletSheetDefaultUpdate { templateId: string | null }` → `PalletSheets`; только включённый лист, иначе `validation_failed` на `templateId`.
- `PalletSheet { id, name, enabled, presetKey: string | null, revision, spec }`.
- Хост: `routes::pallet_sheets::default_sheet(conn) -> Result<Option<String>, ApiError>` (основной и включённый) и `check_sheet(conn, field, id)` (существует и включён) — для задачи 4.

- [ ] **Step 1: Протокол**

В `apps/standalone/proto/src/lib.rs` после типов логотипа (задача 2):

```rust
/// An A4 pallet sheet (plan А4; the cloud's `PalletSheetSpecV2`, #702). The
/// host keeps `spec` an object of `schemaVersion` 2 and `kind`
/// "pallet_sheet" of at most 64 KiB; the domain checks the layout. A stock
/// sheet carries its preset's key (`buildPalletSheetPresets`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletSheet {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub preset_key: Option<String>,
    pub revision: i64,
    pub spec: serde_json::Value,
}

/// `GET /v1/office/pallet-sheets` and `PUT /v1/office/pallet-sheet-default`:
/// every sheet by name and the organization's default sheet, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletSheets {
    pub sheets: Vec<PalletSheet>,
    pub default_id: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

/// `POST /v1/office/pallet-sheets`: a new sheet, or a stock one by its preset
/// key (the same key again answers the sheet already there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetCreate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_key: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub spec: serde_json::Value,
}

/// `PUT /v1/office/pallet-sheets/{id}`: the name or the state, over the
/// sheet's revision. The layout never changes: a new layout is a new sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub expected_revision: i64,
}

/// `PUT /v1/office/pallet-sheet-default`: an enabled sheet, or `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetDefaultUpdate {
    pub template_id: Option<String>,
}
```

Если в крейте есть функция-дефолт `true` с другим именем — использовать её. `skip_serializing_if` у `preset_key` создания нужен для круга фикстуры без ключа.

Фикстуры (спек — короткий объект, хосту не важен макет; Zod тоже не разбирает его как V2):

`apps/standalone/proto/fixtures/pallet-sheet.json`:

```json
{
  "id": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
  "name": "Палета А4 · вертикальная",
  "enabled": true,
  "presetKey": "pallet-a4-portrait",
  "revision": 1,
  "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
}
```

`pallet-sheets.json`:

```json
{
  "sheets": [
    {
      "id": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
      "name": "Палета А4 · вертикальная",
      "enabled": true,
      "presetKey": "pallet-a4-portrait",
      "revision": 1,
      "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
    }
  ],
  "defaultId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b"
}
```

`pallet-sheet-create.json`:

```json
{
  "name": "Палета А4 · вертикальная",
  "presetKey": "pallet-a4-portrait",
  "enabled": true,
  "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
}
```

`pallet-sheet-update.json`: `{ "name": "Палета А4 · цех 2", "enabled": false, "expectedRevision": 1 }`

`pallet-sheet-default-update.json`: `{ "templateId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b" }`

`proto/tests/fixtures.rs` (импорт дополнить `PalletSheet, PalletSheetCreate, PalletSheetDefaultUpdate, PalletSheetUpdate, PalletSheets`):

```rust
/// The A4 pallet sheets (plan А4): the list, a sheet and the three requests.
#[test]
fn pallet_sheet_fixtures_round_trip() {
    let list: PalletSheets = round_trip("pallet-sheets.json");
    let sheet: PalletSheet = round_trip("pallet-sheet.json");
    assert_eq!(list.sheets, vec![sheet.clone()]);
    assert_eq!(list.default_id.as_deref(), Some(sheet.id.as_str()));
    let create: PalletSheetCreate = round_trip("pallet-sheet-create.json");
    assert_eq!(create.preset_key.as_deref(), Some("pallet-a4-portrait"));
    let bare: PalletSheetCreate = serde_json::from_value(serde_json::json!({
        "name": "Свой лист", "spec": {}
    }))
    .unwrap();
    assert!(bare.enabled && bare.preset_key.is_none());
    let update: PalletSheetUpdate = round_trip("pallet-sheet-update.json");
    assert_eq!(update.expected_revision, 1);
    let default: PalletSheetDefaultUpdate = round_trip("pallet-sheet-default-update.json");
    assert_eq!(default.template_id.as_deref(), Some(sheet.id.as_str()));
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto` — Expected: PASS.

- [ ] **Step 2: Проверки хоста**

В `apps/standalone/host/src/validate.rs` после `mono_logo`:

```rust
/// The largest A4 sheet the host keeps: 64 KiB of compact JSON (a stock
/// sheet is a few KiB), so a shift's snapshot keeps it beside its labels.
pub const MAX_SHEET_SPEC_BYTES: usize = 64 * 1024;

/// An A4 sheet's layout: a JSON object of `schemaVersion` 2 and `kind`
/// "pallet_sheet", at most [`MAX_SPEC_DEPTH`] levels and
/// [`MAX_SHEET_SPEC_BYTES`] bytes once compact. The rest is the domain's
/// check (`parsePalletSheetSpec`), in the office and at the station.
pub fn sheet_spec(field: &str, spec: &serde_json::Value) -> Result<String, ApiError> {
    let object = spec
        .as_object()
        .ok_or_else(|| ApiError::validation(field, "the spec must be a JSON object"))?;
    if object.get("schemaVersion") != Some(&serde_json::json!(2))
        || object.get("kind") != Some(&serde_json::json!("pallet_sheet"))
    {
        return Err(ApiError::validation(
            field,
            "the spec must be a pallet sheet of schemaVersion 2",
        ));
    }
    if nests_deeper_than(spec, MAX_SPEC_DEPTH) {
        return Err(ApiError::validation(
            field,
            format!("the spec must be at most {MAX_SPEC_DEPTH} levels deep"),
        ));
    }
    let text = serde_json::to_string(spec).map_err(ApiError::internal)?;
    if text.len() > MAX_SHEET_SPEC_BYTES {
        return Err(ApiError::validation(
            field,
            format!("the spec must be at most {MAX_SHEET_SPEC_BYTES} bytes"),
        ));
    }
    Ok(text)
}

/// A stock sheet's preset key: 1–64 of `a-z`, `0-9` and `-`.
pub fn preset_key(field: &str, key: &str) -> Result<(), ApiError> {
    let valid = (1..=64).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(ApiError::validation(field, "1-64 of a-z, 0-9 and -"))
    }
}
```

Тест в модуле тестов `validate.rs`:

```rust
    #[test]
    fn a_sheet_spec_is_a_v2_pallet_sheet_within_bounds() {
        let ok = serde_json::json!({ "schemaVersion": 2, "kind": "pallet_sheet" });
        assert!(sheet_spec("spec", &ok).is_ok());
        assert!(sheet_spec("spec", &serde_json::json!({ "schemaVersion": 1, "kind": "pallet_sheet" })).is_err());
        assert!(sheet_spec("spec", &serde_json::json!({ "widthMm": 58 })).is_err());
        let big = serde_json::json!({
            "schemaVersion": 2, "kind": "pallet_sheet", "pad": "x".repeat(MAX_SHEET_SPEC_BYTES)
        });
        assert!(sheet_spec("spec", &big).is_err());
        assert!(preset_key("presetKey", "pallet-a4-portrait").is_ok());
        assert!(preset_key("presetKey", "Pallet A4").is_err());
    }
```

- [ ] **Step 3: Падающие тесты маршрутов**

`apps/standalone/host/tests/pallet_sheets.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, Admin};

fn spec() -> Value {
    json!({ "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300, "page": {} })
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/pallet-sheets", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn stock(key: &str, name: &str) -> Value {
    json!({ "name": name, "presetKey": key, "spec": spec() })
}

#[tokio::test]
async fn a_stock_sheet_added_twice_is_one_sheet() {
    let admin = admin().await;
    let first = create(&admin, stock("pallet-a4-portrait", "Палета А4 · вертикальная")).await;
    assert_eq!((first["revision"].clone(), first["enabled"].clone()), (json!(1), json!(true)));
    let again = create(&admin, stock("pallet-a4-portrait", "Другое имя")).await;
    assert_eq!(again, first);
    let (_, list) = admin.call("GET", "/v1/office/pallet-sheets", None).await;
    assert_eq!(list["sheets"].as_array().unwrap().len(), 1);
    assert_eq!(list["defaultId"], Value::Null);
    assert_eq!(audit_trail(&admin.app, "pallet_sheet.create").await.len(), 1);
}

#[tokio::test]
async fn a_rename_and_a_switch_raise_the_revision_over_the_expected_one() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-landscape", "Горизонтальная")).await;
    let path = format!("/v1/office/pallet-sheets/{}", sheet["id"].as_str().unwrap());
    let (status, renamed) = admin
        .call("PUT", &path, Some(json!({ "name": "Цех 2", "expectedRevision": 1 })))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!((renamed["name"].clone(), renamed["revision"].clone()), (json!("Цех 2"), json!(2)));
    let (status, stale) = admin
        .call("PUT", &path, Some(json!({ "enabled": false, "expectedRevision": 1 })))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
}

#[tokio::test]
async fn the_default_sheet_is_neither_switched_off_nor_deleted() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let id = sheet["id"].as_str().unwrap();
    let (status, list) = admin
        .call("PUT", "/v1/office/pallet-sheet-default", Some(json!({ "templateId": id })))
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["defaultId"], id);
    let path = format!("/v1/office/pallet-sheets/{id}");
    let (status, refused) = admin
        .call("PUT", &path, Some(json!({ "enabled": false, "expectedRevision": 1 })))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refused["error"]["details"]["constraint"], "template_is_default");
    let (status, refused) = admin.call("DELETE", &path, None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refused["error"]["details"]["constraint"], "template_is_default");
    let (status, _) = admin
        .call("PUT", "/v1/office/pallet-sheet-default", Some(json!({ "templateId": null })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin.call("DELETE", &path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn a_disabled_sheet_is_not_the_default_and_a_v1_spec_is_refused() {
    let admin = admin().await;
    let mut body = stock("pallet-a4-two-a5", "Две А5");
    body["enabled"] = json!(false);
    let sheet = create(&admin, body).await;
    let (status, refused) = admin
        .call(
            "PUT",
            "/v1/office/pallet-sheet-default",
            Some(json!({ "templateId": sheet["id"] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    let label = json!({ "name": "Этикетка", "spec": { "widthMm": 58, "heightMm": 40 } });
    let (status, _) = admin.call("POST", "/v1/office/pallet-sheets", Some(label)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
```

Коды статусов `CONFLICT`/`UNPROCESSABLE_ENTITY` и путь `error.details.constraint` — сверить с `host/tests/templates.rs` (`template_is_default`) и привести; аудит `pallet_sheet.update`/`pallet_sheet.default`/`pallet_sheet.delete` проверить точной строкой (`admin.row(...)`) хотя бы в одном тесте каждый. Тест «лист, названный запланированной сменой, не удаляется» (`template_in_use`) — в задаче 4 (нужна смена с листом).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_sheets` — Expected: FAIL.

- [ ] **Step 4: Маршруты**

`apps/standalone/host/src/routes/pallet_sheets.rs`:

```rust
//! A4 pallet sheets (plan А4, pilot spec §29): `GET /v1/office/pallet-sheets`
//! (every role), `POST`, `PUT …/{id}`, `DELETE …/{id}` and
//! `PUT /v1/office/pallet-sheet-default` (administrators and technologists).
//! The host keeps a sheet's layout as an object of `schemaVersion` 2 of at
//! most 64 KiB (`validate::sheet_spec`); the office and the station read it
//! with the domain. A stock sheet is added by its preset key, once: the same
//! key again answers the sheet already there, renamed or not. The layout of a
//! sheet never changes (a new layout is a new sheet). A sheet is not switched
//! off or deleted while it is the default (`template_is_default`), nor deleted
//! while a planned shift names it (`template_in_use`). Sheets take no feed
//! revision: no station copies them, a shift freezes its sheet when it opens.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    PalletSheet, PalletSheetCreate, PalletSheetDefaultUpdate, PalletSheetUpdate, PalletSheets,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

const SELECT: &str =
    "SELECT id, name, enabled, preset_key, revision, spec FROM pallet_sheet_templates";

type SheetRow = (String, String, bool, Option<String>, i64, String);

fn sheet((id, name, enabled, preset_key, revision, spec): SheetRow) -> Result<PalletSheet, ApiError> {
    Ok(PalletSheet {
        id,
        name,
        enabled,
        preset_key,
        revision,
        spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<PalletSheet>, ApiError> {
    let row: Option<SheetRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(sheet).transpose()
}

async fn default_id(conn: &mut SqliteConnection) -> Result<Option<String>, ApiError> {
    let id: Option<Option<String>> =
        sqlx::query_scalar("SELECT default_pallet_sheet_template_id FROM org_profile WHERE id = 1")
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(id.flatten())
}

async fn list(conn: &mut SqliteConnection) -> Result<PalletSheets, ApiError> {
    let rows: Vec<SheetRow> = sqlx::query_as(&format!("{SELECT} ORDER BY name, id"))
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(PalletSheets {
        sheets: rows.into_iter().map(sheet).collect::<Result<_, _>>()?,
        default_id: default_id(conn).await?,
    })
}

/// The organization's default sheet while it is enabled: what a shift with
/// pallets gets when its request names no sheet (plan А4, decision А4-3).
pub async fn default_sheet(conn: &mut SqliteConnection) -> Result<Option<String>, ApiError> {
    let id: Option<String> = sqlx::query_scalar(
        "SELECT s.id FROM org_profile o JOIN pallet_sheet_templates s \
         ON s.id = o.default_pallet_sheet_template_id WHERE o.id = 1 AND s.enabled = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(id)
}

/// `validation_failed` on `field` unless `id` names an enabled sheet.
pub async fn check_sheet(conn: &mut SqliteConnection, field: &str, id: &str) -> Result<(), ApiError> {
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM pallet_sheet_templates WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    match enabled {
        Some(true) => Ok(()),
        _ => Err(ApiError::validation(field, "no such enabled sheet")),
    }
}

fn is_default() -> ApiError {
    ApiError::conflict("template_is_default", "the sheet is the organization's default")
}

pub async fn list_sheets(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<PalletSheets>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    list(&mut conn).await.map(Json)
}

pub async fn create_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<PalletSheetCreate>,
) -> Result<Json<PalletSheet>, ApiError> {
    context.require_catalog()?;
    let name = validate::template_name("name", &create.name)?;
    if let Some(key) = &create.preset_key {
        validate::preset_key("presetKey", key)?;
    }
    let spec = validate::sheet_spec("spec", &create.spec)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(key) = &create.preset_key {
        let existing: Option<SheetRow> =
            sqlx::query_as(&format!("{SELECT} WHERE preset_key = ?"))
                .bind(key)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        if let Some(row) = existing {
            tx.commit().await.map_err(ApiError::internal)?;
            return sheet(row).map(Json);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pallet_sheet_templates \
         (id, name, enabled, preset_key, spec, revision, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(create.enabled)
    .bind(&create.preset_key)
    .bind(&spec)
    .bind(&at)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_CREATE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name, "presetKey": create.preset_key }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("sheet vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<PalletSheetUpdate>,
) -> Result<Json<PalletSheet>, ApiError> {
    context.require_catalog()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::template_name("name", name))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such sheet"))?;
    if current.revision != update.expected_revision {
        return Err(ApiError::stale_revision(current.revision));
    }
    let next_name = name.unwrap_or_else(|| current.name.clone());
    let next_enabled = update.enabled.unwrap_or(current.enabled);
    if !next_enabled && default_id(&mut tx).await?.as_deref() == Some(id.as_str()) {
        return Err(is_default());
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(next_name)),
        ("enabled", json!(current.enabled), json!(next_enabled)),
    ]) else {
        tx.commit().await.map_err(ApiError::internal)?;
        return Ok(Json(current));
    };
    sqlx::query(
        "UPDATE pallet_sheet_templates SET name = ?, enabled = ?, revision = revision + 1, \
         updated_at = ? WHERE id = ?",
    )
    .bind(&next_name)
    .bind(next_enabled)
    .bind(&at)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_UPDATE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("sheet vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

pub async fn delete_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such sheet"))?;
    if default_id(&mut tx).await?.as_deref() == Some(id.as_str()) {
        return Err(is_default());
    }
    let planned: Option<String> = sqlx::query_scalar(
        "SELECT id FROM shifts WHERE pallet_sheet_template_id = ? AND status = 'planned' LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if planned.is_some() {
        return Err(ApiError::conflict(
            "template_in_use",
            "a planned shift prints its pallets on this sheet",
        ));
    }
    sqlx::query("DELETE FROM pallet_sheet_templates WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_DELETE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": current.name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn put_default(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<PalletSheetDefaultUpdate>,
) -> Result<Json<PalletSheets>, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(id) = &update.template_id {
        check_sheet(&mut tx, "templateId", id).await?;
    }
    let current = default_id(&mut tx).await?;
    if current != update.template_id {
        sqlx::query("UPDATE org_profile SET default_pallet_sheet_template_id = ? WHERE id = 1")
            .bind(&update.template_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::PALLET_SHEET_DEFAULT,
                target_type: Some("org_profile"),
                target_id: Some("1"),
                outcome: Outcome::Ok,
                details: json!({ "templateId": { "from": current, "to": update.template_id } }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let answer = list(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}
```

Сверить по месту: сигнатуру `audit::update_details` (из `routes/org.rs` — принимает срез `(&str, Value, Value)` и возвращает `Option<Value>`); формат `details` «from/to» — взять тот, что даёт `update_details`, и для основного листа использовать его же (`audit::update_details(&[("templateId", json!(current), json!(update.template_id))])`), чтобы аудит был единообразным. `UPDATE org_profile` не меняет `rev` профиля: основной лист не едет в ленту станции.

`host/src/routes/mod.rs`: `pub mod pallet_sheets;`. `host/src/server.rs` после маршрутов `"/v1/office/template-defaults"`:

```rust
        .route(
            "/v1/office/pallet-sheets",
            get(crate::routes::pallet_sheets::list_sheets)
                .post(crate::routes::pallet_sheets::create_sheet),
        )
        .route(
            "/v1/office/pallet-sheets/{id}",
            put(crate::routes::pallet_sheets::update_sheet)
                .delete(crate::routes::pallet_sheets::delete_sheet),
        )
        .route(
            "/v1/office/pallet-sheet-default",
            put(crate::routes::pallet_sheets::put_default),
        )
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_sheets` и `-p markiro-host --lib validate` — Expected: PASS.

- [ ] **Step 5: Zod и клиент**

`apps/standalone/src/host/protocol.ts` после схем логотипа:

```ts
/**
 * Mirrors `markiro_proto::PalletSheet` (plan А4): an A4 pallet sheet. `spec`
 * stays unknown here — the office and the station read it with the domain's
 * `parsePalletSheetSpec`, and a sheet a newer office made does not fail the list.
 */
export const palletSheetSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  enabled: z.boolean(),
  presetKey: z.string().nullable(),
  revision: z.number().int().positive(),
  spec: z.unknown(),
});
export type PalletSheet = z.infer<typeof palletSheetSchema>;

/** Mirrors `markiro_proto::PalletSheets`: every sheet by name and the default. */
export const palletSheetsSchema = z.object({
  sheets: z.array(palletSheetSchema),
  defaultId: z.uuid().nullable(),
});
export type PalletSheets = z.infer<typeof palletSheetsSchema>;

/** Mirrors `markiro_proto::PalletSheetCreate`. */
export const palletSheetCreateSchema = z
  .object({
    name: z.string(),
    presetKey: z.string().optional(),
    enabled: z.boolean().optional(),
    spec: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PalletSheetCreate = z.infer<typeof palletSheetCreateSchema>;

/** Mirrors `markiro_proto::PalletSheetUpdate`: the name or the state, over the revision. */
export const palletSheetUpdateSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    expectedRevision: z.number().int(),
  })
  .strict();
export type PalletSheetUpdate = z.infer<typeof palletSheetUpdateSchema>;

/** Mirrors `markiro_proto::PalletSheetDefaultUpdate`. */
export const palletSheetDefaultUpdateSchema = z
  .object({ templateId: z.uuid().nullable() })
  .strict();
export type PalletSheetDefaultUpdate = z.infer<typeof palletSheetDefaultUpdateSchema>;
```

`test/protocol.test.ts`: ответы `["pallet-sheets.json", palletSheetsSchema]`, `["pallet-sheet.json", palletSheetSchema]`; запросы `["pallet-sheet-create.json", palletSheetCreateSchema]`, `["pallet-sheet-update.json", palletSheetUpdateSchema]`, `["pallet-sheet-default-update.json", palletSheetDefaultUpdateSchema]`.

`src/host/api.ts` — в `HostApi` и реализацию (по образцу шаблонов; `NO_CONTENT` для удаления, как `deleteTemplate`):

```ts
listPalletSheets: (token: string) => Promise<PalletSheets>;
createPalletSheet: (token: string, create: PalletSheetCreate) => Promise<PalletSheet>;
updatePalletSheet: (token: string, id: string, update: PalletSheetUpdate) => Promise<PalletSheet>;
deletePalletSheet: (token: string, id: string) => Promise<void>;
setDefaultPalletSheet: (token: string, update: PalletSheetDefaultUpdate) => Promise<PalletSheets>;
```

```ts
    listPalletSheets: (token) =>
      client.request("GET", "/v1/office/pallet-sheets", {
        officeToken: token,
        schema: palletSheetsSchema,
      }),
    createPalletSheet: (token, create) =>
      client.request("POST", "/v1/office/pallet-sheets", {
        body: create,
        officeToken: token,
        schema: palletSheetSchema,
      }),
    updatePalletSheet: (token, id, update) =>
      client.request("PUT", `/v1/office/pallet-sheets/${id}`, {
        body: update,
        officeToken: token,
        schema: palletSheetSchema,
      }),
    deletePalletSheet: async (token, id) => {
      await client.request("DELETE", `/v1/office/pallet-sheets/${id}`, {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    setDefaultPalletSheet: (token, update) =>
      client.request("PUT", "/v1/office/pallet-sheet-default", {
        body: update,
        officeToken: token,
        schema: palletSheetsSchema,
      }),
```

`officeKeys`: `palletSheets: ["office", "pallet-sheets"],`. Подставные `HostApi` тестов — дописать члены.

- [ ] **Step 6: Проверки и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pallet_sheets --lib
pnpm --filter @markiro/standalone exec vitest run test/protocol.test.ts
pnpm --filter @markiro/standalone typecheck
git add <все файлы задачи явными путями>
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): A4 pallet sheets on the host — the list, stock sheets, rename, state, delete and the default (plan А4, task 3)` + трейлер.

### Task 4: Лист смены и снимок — `palletSheetTemplateId` в сменах, основной лист для смен станции, `palletSheet` и `organization` в снимке, чтение снимка станцией

**Files:**

- Create: `apps/standalone/proto/fixtures/shift-create-pallet-sheet.json`, `apps/standalone/proto/fixtures/device-shift-entered-sheet.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/office-shift.json` (и каждая фикстура формы `OfficeShift`), `apps/standalone/host/src/shifts.rs`, `host/src/routes/office_shifts.rs`, `host/src/routes/device_shifts.rs`, `host/tests/office_shifts.rs`, `host/tests/device_shifts.rs`, `host/tests/pallet_sheets.rs`, `apps/standalone/src/host/protocol.ts`, `src/host/requests.ts`, `src/floor/shifts/shift-snapshot.ts`, `apps/standalone/test/support/shifts.ts`, `test/protocol.test.ts`, `test/shift-copies.test.ts` (или файл тестов `checkShiftSnapshot`)

**Interfaces:**

- Провод: `ShiftCreate`, `ShiftUpdate`, `DeviceShiftCreate` — необязательный `palletSheetTemplateId` (только со паллетами, иначе `validation_failed`); без него смена со паллетами получает основной лист (если включён), иначе листа нет. `OfficeShift.palletSheetTemplateId: string | null`. `DeviceShift` не меняется.
- Снимок: `ShiftSnapshot.palletSheet?: { id, name, revision, spec }` (смена с листом), `ShiftSnapshot.organization?: { name, inn: string | null, logo: { width, height, pixelsBase64 } | null }` (всегда у смен, открытых этой версией хоста).
- Станция: `CheckedSnapshot.palletSheet: SnapshotSheet | null` (`spec: PalletSheetSpecV2`), `CheckedSnapshot.organization: SnapshotOrganization | null` (`logo: MonoBitmap | null`). Лист, который домен не читает, и логотип, который не читается, дают `null` и **не** закрывают смену оператору (печатается термоэтикетка; лист А4 тогда не рендерится — `render_failed`).

- [ ] **Step 1: Протокол — поля смен и снимка**

В `apps/standalone/proto/src/lib.rs`:

1. `OfficeShift` после `pub pallet_template_id: Option<String>,`:

```rust
    /// The A4 sheet a shift with pallets prints on an A4 printer (plan А4):
    /// `null` for none, and always `null` without pallets.
    #[serde(default)]
    pub pallet_sheet_template_id: Option<String>,
```

2. `ShiftCreate`, `ShiftUpdate` (перед `expected_rev`) и `DeviceShiftCreate` после их `pallet_template_id`:

```rust
    /// The shift's A4 sheet (plan А4), only with pallets; left out, a shift
    /// with pallets takes the organization's default sheet when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet_template_id: Option<String>,
```

3. `ShiftSnapshot` после `pallet_template`:

```rust
    /// The A4 sheet the shift froze (plan А4): only for a shift with a sheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet: Option<ShiftSnapshotSheet>,
    /// The organization as the shift froze it (plan А4): its name, INN and
    /// print logo, for the sheet's header and footer and the labels' logo
    /// box. Left out by a host before plan А4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<ShiftSnapshotOrganization>,
```

4. После `ShiftSnapshotTemplate`:

```rust
/// An A4 sheet as a shift froze it: its name, revision and whole layout. The
/// host never checks the layout; the station reads it with the domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotSheet {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub spec: serde_json::Value,
}

/// The organization as a shift froze it (plan А4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotOrganization {
    pub name: String,
    pub inn: Option<String>,
    /// The organization's print logo, `null` for none (the bundled Markiro
    /// logo prints then).
    pub logo: Option<ShiftSnapshotLogo>,
}

/// A print logo as a shift froze it: the bits of `OrgLogo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotLogo {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
}
```

Каждый литерал `ShiftSnapshot { … }` в хосте и тестах (`grep -rn "ShiftSnapshot {" apps/standalone/host apps/standalone/proto`) получает `pallet_sheet: None, organization: None`, кроме места, которое строит снимок (шаг 3).

5. Фикстуры. Каждая фикстура формы `OfficeShift` (`grep -ln '"ownerDeviceId"' apps/standalone/proto/fixtures/*.json` и среди них те, что содержат `"closeReasonCode"`) получает `"palletSheetTemplateId": null` сразу после `"palletTemplateId"`. `shift-create-pallet-sheet.json` — копия `shift-create-pallets.json` с последней строкой `"palletSheetTemplateId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b"` после `palletTemplateId`. `device-shift-entered-sheet.json` — копия `device-shift-entered-pallets.json`, у которой в `snapshot` после `palletTemplate` добавлены:

```json
    "palletSheet": {
      "id": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
      "name": "Палета А4 · вертикальная",
      "revision": 1,
      "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
    },
    "organization": {
      "name": "ООО «Молочный завод»",
      "inn": "7701234567",
      "logo": { "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" }
    }
```

`proto/tests/fixtures.rs`:

```rust
/// A shift with an A4 sheet (plan А4): the office's request names it, and the
/// entry freezes the sheet with the organization.
#[test]
fn a_shift_with_a_sheet_freezes_it_with_the_organization() {
    let create: ShiftCreate = round_trip("shift-create-pallet-sheet.json");
    assert!(create.pallets_enabled && create.pallet_sheet_template_id.is_some());
    let entered: DeviceShift = round_trip("device-shift-entered-sheet.json");
    let snapshot = entered.snapshot.expect("an entry carries the snapshot");
    let sheet = snapshot.pallet_sheet.expect("the shift froze its sheet");
    assert_eq!(Some(sheet.id), create.pallet_sheet_template_id);
    let organization = snapshot.organization.expect("the shift froze the organization");
    assert_eq!(organization.logo.map(|logo| logo.width), Some(10));
    let plain: DeviceShift =
        serde_json::from_value(fixture("device-shift-entered-pallets.json")).unwrap();
    let plain = plain.snapshot.expect("snapshot");
    assert_eq!((plain.pallet_sheet, plain.organization), (None, None));
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto` — Expected: PASS.

- [ ] **Step 2: Падающие тесты хоста**

В `apps/standalone/host/tests/office_shifts.rs` (помощники `shift_setup`, `pallet_template`, `pallet_shift_body`, `plan_shift` из `support::app`):

```rust
async fn stock_sheet(admin: &Admin, key: &str) -> String {
    let body = json!({
        "name": key, "presetKey": key,
        "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
    });
    let (status, sheet) = admin.call("POST", "/v1/office/pallet-sheets", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    sheet["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_shift_with_pallets_takes_the_named_sheet_or_the_default() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    // No default sheet: no sheet.
    let plain = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(plain["palletSheetTemplateId"], Value::Null);
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let (status, _) = admin
        .call("PUT", "/v1/office/pallet-sheet-default", Some(json!({ "templateId": portrait })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let defaulted = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(defaulted["palletSheetTemplateId"], json!(portrait));
    let mut named = pallet_shift_body(&setup, &template);
    named["palletSheetTemplateId"] = json!(landscape);
    let named = plan_shift(&admin, named).await;
    assert_eq!(named["palletSheetTemplateId"], json!(landscape));
}

#[tokio::test]
async fn a_shift_without_pallets_names_no_sheet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let mut body = shift_body(&setup);
    body["palletSheetTemplateId"] = json!(sheet);
    let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert_eq!(refused["error"]["details"]["field"], "palletSheetTemplateId");
}

#[tokio::test]
async fn an_edit_changes_the_sheet_and_turning_pallets_off_clears_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(portrait);
    let shift = plan_shift(&admin, body).await;
    let path = format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap());
    let (status, changed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "palletSheetTemplateId": landscape, "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["palletSheetTemplateId"], json!(landscape));
    let (status, off) = admin
        .call("PUT", &path, Some(json!({ "palletsEnabled": false, "expectedRev": changed["rev"] })))
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(off["palletSheetTemplateId"], Value::Null);
}
```

В `host/tests/pallet_sheets.rs` — тест «лист запланированной смены не удаляется» (`template_in_use`), с теми же помощниками.

В `apps/standalone/host/tests/device_shifts.rs`:

```rust
#[tokio::test]
async fn the_entry_freezes_the_sheet_and_the_organization_with_its_logo() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, _) = admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let body = json!({
        "name": "Вертикальная", "presetKey": "pallet-a4-portrait",
        "spec": { "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300 }
    });
    let (_, sheet) = admin.call("POST", "/v1/office/pallet-sheets", Some(body)).await;
    let (_, _) = admin
        .call("PUT", "/v1/office/pallet-sheet-default", Some(json!({ "templateId": sheet["id"] })))
        .await;
    // `open_pallet_floor` plans a shift with pallets on the wizard's station and enters it.
    let floor = open_pallet_floor(&admin, &setup, &admin.key, &setup.line).await;
    // Read the entry again: the owner's re-entry answers the frozen snapshot.
    let (status, entered) = admin
        .app
        .send(empty(with_device(
            request("POST", &format!("/v1/device/shifts/{}/enter", floor.shift)),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let snapshot = &entered["snapshot"];
    assert_eq!(snapshot["palletSheet"]["id"], sheet["id"]);
    assert_eq!(snapshot["palletSheet"]["revision"], 1);
    assert_eq!(snapshot["organization"]["logo"]["pixelsBase64"], "8MAPQA==");
    // A later change of the logo does not reach the open shift.
    let (_, _) = admin.call("DELETE", "/v1/office/org/logo", None).await;
    let (_, again) = admin
        .app
        .send(empty(with_device(
            request("POST", &format!("/v1/device/shifts/{}/enter", floor.shift)),
            &admin.key,
        )))
        .await;
    assert_eq!(again["snapshot"], entered["snapshot"]);
}
```

И станционное создание: `POST /v1/device/shifts` со паллетами без `palletSheetTemplateId` при основном листе даёт смену, чей `GET /v1/office/shifts/{id}` несёт основной лист (по образцу существующего теста создания станцией со паллетами в этом файле).

Существующие тесты, сравнивающие снимок целиком (`grep -n '"snapshot"' apps/standalone/host/tests/*.rs`), теперь видят `organization` — дописать ожидаемое `organization` (имя и ИНН мастера из `bootstrap_body()`, `logo: null`), не ослабляя сравнение.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --test device_shifts --test pallet_sheets` — Expected: FAIL (новые).

- [ ] **Step 3: Хост — выбор листа и снимок**

`apps/standalone/host/src/shifts.rs`:

1. Структура `Pallets` получает поле:

```rust
    /// The A4 sheet (plan А4): the request's, else the default, else none.
    pub sheet_id: Option<String>,
```

2. `pallets(conn, request, product)` → `pallets(conn, request, product, sheet_id: Option<&str>)`:

```rust
pub async fn pallets(
    conn: &mut SqliteConnection,
    request: PalletRequest<'_>,
    product: &ShiftProduct,
    sheet_id: Option<&str>,
) -> Result<Option<Pallets>, ApiError> {
    match request {
        PalletRequest::Off => match sheet_id {
            Some(_) => Err(ApiError::validation(
                "palletSheetTemplateId",
                "only a shift with pallets has an A4 sheet",
            )),
            None => Ok(None),
        },
        PalletRequest::On {
            box_capacity,
            template_id,
        } => {
            check_pallet_template(conn, template_id, product.group).await?;
            let sheet_id = match sheet_id {
                Some(id) => {
                    crate::routes::pallet_sheets::check_sheet(conn, "palletSheetTemplateId", id)
                        .await?;
                    Some(id.to_owned())
                }
                None => crate::routes::pallet_sheets::default_sheet(conn).await?,
            };
            Ok(Some(Pallets {
                box_capacity: box_capacity.unwrap_or(product.pallet_box_capacity),
                template_id: template_id.to_owned(),
                sheet_id,
            }))
        }
    }
}
```

(Если зависимость `shifts` → `routes` противоречит слоям крейта, перенести `check_sheet`/`default_sheet` в новый `host/src/pallet_sheets.rs` рядом с `templates.rs` и вызывать оттуда из маршрута и отсюда — записать.)

3. `insert`: в список столбцов после `pallet_template_id, ` добавить `pallet_sheet_template_id, `, ещё один `?` в `VALUES` и после бинда шаблона паллеты:

```rust
    .bind(
        shift
            .pallets
            .as_ref()
            .and_then(|pallets| pallets.sheet_id.as_deref()),
    )
```

4. `snapshot(conn, product_id, template_id, pallet_template_id, counterparty_id)` получает пятый параметр `pallet_sheet_id: Option<&str>`. Перед `Ok(ShiftSnapshot {`:

```rust
    let pallet_sheet = match pallet_sheet_id {
        Some(id) => {
            let row: Option<(String, String, i64)> = sqlx::query_as(
                "SELECT name, spec, revision FROM pallet_sheet_templates WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            // A sheet a planned shift names is never deleted (`template_in_use`);
            // a missing one is frozen as none rather than refusing the entry, so
            // the shift still prints thermal pallet labels.
            match row {
                Some((name, spec, revision)) => Some(ShiftSnapshotSheet {
                    id: id.to_owned(),
                    name,
                    revision,
                    spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
                }),
                None => None,
            }
        }
        None => None,
    };
    let (org_name, org_inn): (String, Option<String>) =
        sqlx::query_as("SELECT name, inn FROM org_profile WHERE id = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let logo = crate::routes::org_logo::read_logo(&mut *conn)
        .await?
        .map(|logo| ShiftSnapshotLogo {
            width: logo.width,
            height: logo.height,
            pixels_base64: logo.pixels_base64,
        });
```

и в литерал `ShiftSnapshot` — `pallet_sheet, organization: Some(ShiftSnapshotOrganization { name: org_name, inn: org_inn, logo }),`. Выключенный лист замораживается как есть (выключение влияет только на выбор для новых смен). Импорты `ShiftSnapshotSheet, ShiftSnapshotOrganization, ShiftSnapshotLogo` из `markiro_proto`. Тест `snapshot_text` в модуле тестов `shifts.rs` получает `pallet_sheet: None, organization: None`.

`apps/standalone/host/src/routes/office_shifts.rs`:

- SELECT (якорь на строке 33 `box_capacity, box_template_id, pallet_box_capacity, pallet_template_id, owner_device_id,`) — добавить `pallet_sheet_template_id` после `pallet_template_id`; в структуру строки после `pallet_template_id: Option<String>,` — `pallet_sheet_template_id: Option<String>,`; в отображение `OfficeShift` после `pallet_template_id: row.pallet_template_id,` — `pallet_sheet_template_id: row.pallet_sheet_template_id,`.
- `create_shift`: `shifts::pallets(&mut tx, pallet_request, &product).await?` → `shifts::pallets(&mut tx, pallet_request, &product, create.pallet_sheet_template_id.as_deref()).await?`; в `details` аудита создания добавить `"palletSheetTemplateId": created.pallet_sheet_template_id`.
- `update_shift`: после `let (mut pallet_box_capacity, pallet_template_id) = match pallet_request { … };` добавить

```rust
    // The A4 sheet (plan А4): kept while pallets stay on, the request's when it
    // names one, the default when pallets just turned on, none without pallets.
    let pallet_sheet_template_id = if pallets_enabled {
        match &update.pallet_sheet_template_id {
            Some(id) => Some(id.clone()),
            None if current.pallets_enabled => current.pallet_sheet_template_id.clone(),
            None => crate::routes::pallet_sheets::default_sheet(&mut tx).await?,
        }
    } else {
        if update.pallet_sheet_template_id.is_some() {
            return Err(ApiError::validation(
                "palletSheetTemplateId",
                "only a shift with pallets has an A4 sheet",
            ));
        }
        None
    };
```

в `fixed_changed` — `|| pallet_sheet_template_id != current.pallet_sheet_template_id`; в ветке `ShiftStatus::Planned` —

```rust
            if let Some(sheet_id) = &update.pallet_sheet_template_id {
                if current.pallet_sheet_template_id.as_ref() != Some(sheet_id) {
                    crate::routes::pallet_sheets::check_sheet(
                        &mut tx,
                        "palletSheetTemplateId",
                        sheet_id,
                    )
                    .await?;
                }
            }
```

в `audit::update_details` — `("palletSheetTemplateId", json!(current.pallet_sheet_template_id), json!(pallet_sheet_template_id)),`; в `UPDATE shifts SET …` — `pallet_sheet_template_id = ?, ` перед `rev = ?` и `.bind(&pallet_sheet_template_id)` перед `.bind(rev)`.

`apps/standalone/host/src/routes/device_shifts.rs`:

- `create_device_shift`: `shifts::pallets(&mut tx, pallet_request, &product).await?` → с четвёртым аргументом `create.pallet_sheet_template_id.as_deref()`.
- `enter_shift`: в SELECT (`… pallet_template_id, counterparty_id, snapshot, …`) добавить `pallet_sheet_template_id` после `pallet_template_id`; в `EntryRow` после `pallet_template_id: Option<String>,` — `pallet_sheet_template_id: Option<String>,`; вызов `shifts::snapshot(…, shift.pallet_template_id.as_deref(), shift.counterparty_id.as_deref())` → с `shift.pallet_sheet_template_id.as_deref()` пятым аргументом (порядок — как объявлен в шаге 3); в `details` аудита открытия после блока `palletTemplateId`:

```rust
    if let Some(sheet) = &snapshot.pallet_sheet {
        details["palletSheetTemplateId"] = json!(sheet.id);
        details["palletSheetRevision"] = json!(sheet.revision);
    }
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host` (частями: `--lib`, затем `--test office_shifts --test device_shifts --test pallet_sheets --test facts`) — Expected: PASS.

- [ ] **Step 4: Zod, построители, снимок станции**

`apps/standalone/src/host/protocol.ts`:

- `officeShiftSchema` после `palletTemplateId: z.uuid().nullable(),` — `palletSheetTemplateId: z.uuid().nullable(),`.
- `shiftCreateSchema`, `shiftUpdateSchema`, `deviceShiftCreateSchema` после `palletTemplateId: z.uuid().optional(),` — `palletSheetTemplateId: z.uuid().optional(),`.
- Перед `shiftSnapshotSchema`:

```ts
/** Mirrors `markiro_proto::ShiftSnapshotSheet`: the A4 sheet a shift froze (plan А4). */
export const shiftSnapshotSheetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.number().int().positive(),
  spec: z.unknown(),
});

/** Mirrors `markiro_proto::ShiftSnapshotOrganization`: the organization a shift froze. */
export const shiftSnapshotOrganizationSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  logo: z
    .object({ width: z.number().int(), height: z.number().int(), pixelsBase64: z.string() })
    .nullable(),
});
```

- `shiftSnapshotSchema` после `palletTemplate: …optional(),` — `palletSheet: shiftSnapshotSheetSchema.optional(),` и `organization: shiftSnapshotOrganizationSchema.optional(),`.
- `test/protocol.test.ts`: `["device-shift-entered-sheet.json", enteredShiftSchema]` в ответы, `["shift-create-pallet-sheet.json", shiftCreateSchema]` в запросы.

`apps/standalone/src/host/requests.ts`:

- `ShiftPallets` получает `/** The A4 sheet (plan А4); left out — the organization's default. */ sheetId?: string;`.
- `shiftCreate`: в ветке со паллетами после `palletTemplateId: shift.pallets.templateId,` — `...(shift.pallets.sheetId === undefined ? {} : { palletSheetTemplateId: shift.pallets.sheetId }),`.
- `shiftUpdate`: в `Pick<OfficeShift, …>` добавить `"palletSheetTemplateId"`; в блоке `if (next.pallets !== undefined && next.pallets !== null) {` после проверки шаблона:

```ts
if (next.pallets.sheetId !== undefined && next.pallets.sheetId !== shift.palletSheetTemplateId) {
  update.palletSheetTemplateId = next.pallets.sheetId;
}
```

- `DeviceShiftInput.pallets` и `deviceShiftCreate` не меняются (станция берёт основной лист, А4-3).

Тест в `test/protocol.test.ts` рядом с `shift-create-pallets.json`:

```ts
const withSheet = shiftCreate({
  ...input,
  counterpartyId: null,
  pallets: {
    boxCapacity: 40,
    templateId: template,
    sheetId: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
  },
});
expect(JSON.stringify(withSheet)).toBe(fixtureText("shift-create-pallet-sheet.json"));
```

`apps/standalone/src/floor/shifts/shift-snapshot.ts`:

```ts
// imports: добавить parsePalletSheetSpec, type MonoBitmap, type PalletSheetSpecV2 из "@markiro/domain"
// и logoFromWire из "../../labels/logo.js"

/** The A4 sheet the shift froze, with the layout the domain read (plan А4). */
export interface SnapshotSheet {
  id: string;
  name: string;
  revision: number;
  spec: PalletSheetSpecV2;
}

/** The organization the shift froze (plan А4): its logo as a bitmap, or `null`. */
export interface SnapshotOrganization {
  name: string;
  inn: string | null;
  logo: MonoBitmap | null;
}
```

`CheckedSnapshot` получает:

```ts
/** The A4 sheet (plan А4); `null` — none, or one this build does not read. */
palletSheet: SnapshotSheet | null;
/** The organization (plan А4); `null` — a snapshot of a host before it. */
organization: SnapshotOrganization | null;
```

В `checkShiftSnapshot` перед `return { ok: true, …`:

```ts
// A sheet or a logo this build cannot read keeps nobody out of the shift:
// its thermal labels still print, and only an A4 print of it fails to render.
const sheetRaw = parsed.data.palletSheet;
let palletSheet: SnapshotSheet | null = null;
if (palletsEnabled && sheetRaw !== undefined) {
  try {
    palletSheet = { ...sheetRaw, spec: parsePalletSheetSpec(sheetRaw.spec) };
  } catch {
    palletSheet = null;
  }
}
const org = parsed.data.organization;
const organization: SnapshotOrganization | null =
  org === undefined
    ? null
    : { name: org.name, inn: org.inn, logo: org.logo === null ? null : logoFromWire(org.logo) };
```

и в объект `snapshot` — `palletSheet, organization,`.

`apps/standalone/test/support/shifts.ts` (и иные построители `CheckedSnapshot` в тестах, `grep -rln "issuerPrefix:" apps/standalone/test`) — `palletSheet: null, organization: null`.

Тест (в файле тестов `checkShiftSnapshot`, например `test/shift-copies.test.ts`):

```ts
describe("checkShiftSnapshot — the A4 sheet and the organization (plan А4)", () => {
  const entered = enteredShiftSchema.parse(fixture("device-shift-entered-sheet.json"));
  it("reads the organization's logo, and a sheet the domain does not read as none", () => {
    const checked = checkShiftSnapshot(entered.snapshot, true);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // The fixture's spec is a stub, not a whole V2 layout: no sheet, the shift still works.
    expect(checked.snapshot.palletSheet).toBeNull();
    expect(checked.snapshot.organization?.logo?.width).toBe(10);
  });

  it("reads a stock sheet", () => {
    const [preset] = buildPalletSheetPresets();
    if (preset === undefined) throw new Error("no stock sheet");
    const raw = structuredClone(entered.snapshot);
    if (raw?.palletSheet === undefined) throw new Error("fixture without a sheet");
    raw.palletSheet.spec = preset.spec;
    const checked = checkShiftSnapshot(raw, true);
    expect(checked.ok && checked.snapshot.palletSheet?.spec.page.orientation).toBe("portrait");
  });
});
```

(Помощник `fixture` — как в `test/protocol.test.ts`; если его нет в выбранном файле — прочитать фикстуру так же.)

Run: `pnpm --filter @markiro/standalone exec vitest run test/protocol.test.ts test/shift-copies.test.ts` и весь пакет `pnpm --filter @markiro/standalone test` — Expected: PASS.

- [ ] **Step 5: Проверки и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_shifts --test device_shifts --test pallet_sheets --test facts
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone test
git add <все файлы задачи явными путями>
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): a shift's A4 sheet and the organization frozen in its snapshot (plan А4, task 4)` + трейлер.

### Task 5: Офис — «Логотип для печати», страница «Листы А4», поле «Лист А4» в диалоге смены

**Files:**

- Create: `apps/standalone/src/office/org/OrgLogoCard.tsx`, `apps/standalone/src/office/sheets/sheet-list.ts`, `sheets/SheetPreview.tsx`, `sheets/PalletSheetsPage.tsx`, `apps/standalone/test/sheet-list.test.ts`, `apps/standalone/test/pallet-sheets-page.test.tsx`, `apps/standalone/test/org-logo-card.test.tsx`
- Modify: `apps/standalone/src/office/org/OrgProfilePage.tsx`, `src/office/routes.tsx`, `src/office/nav.ts`, `src/office/shifts/shift-form.ts`, `src/office/shifts/ShiftDialog.tsx`, `src/i18n/ru.json`, `apps/standalone/test/support/office.tsx` (члены `fakeHostApi`, если задачи 2–3 их не дописали), `test/shift-dialog.test.tsx`

**Interfaces:**

- `sheet-list.ts`: `readSheetSpec(spec: unknown): PalletSheetSpecV2 | null`; `sheetLayoutKey(spec): "portrait" | "landscape" | "twoA5" | null`; `missingPresets(sheets): PalletSheetPreset[]`; `sheetExport(sheet): string` (JSON `serializeStoredLabelJson`); `sheetImport(text): { name; spec }` (бросает при неверном JSON/версии/назначении); `sheetFailureKey(error): string` (ключ `ru.json`).
- `SheetPreview({ spec, label })` — canvas с листом на образце данных, названием/ИНН организации и логотипом (организации или Маркиро).

- [ ] **Step 1: Падающие тесты чистых помощников**

`apps/standalone/test/sheet-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { PalletSheet } from "../src/host/protocol.js";
import {
  missingPresets,
  sheetExport,
  sheetFailureKey,
  sheetImport,
  sheetLayoutKey,
} from "../src/office/sheets/sheet-list.js";

const PRESETS = buildPalletSheetPresets();

function sheet(index: number): PalletSheet {
  const preset = PRESETS[index];
  if (preset === undefined) throw new Error("no such preset");
  return {
    id: `6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5${index}`,
    name: preset.name,
    enabled: true,
    presetKey: preset.key,
    revision: 1,
    spec: preset.spec,
  };
}

describe("sheet-list", () => {
  it("names the layout of each stock sheet", () => {
    expect(PRESETS.map((preset) => sheetLayoutKey(preset.spec))).toEqual([
      "portrait",
      "landscape",
      "twoA5",
    ]);
    expect(sheetLayoutKey({ widthMm: 58 })).toBeNull();
  });

  it("offers only the stock sheets not added yet", () => {
    expect(missingPresets([sheet(0)]).map((preset) => preset.key)).toEqual([
      "pallet-a4-landscape",
      "pallet-a4-two-a5",
    ]);
    expect(missingPresets([sheet(0), sheet(1), sheet(2)])).toEqual([]);
  });

  it("round-trips a sheet through its JSON without its id or revision", () => {
    const text = sheetExport(sheet(1));
    expect(text).not.toContain(sheet(1).id);
    const back = sheetImport(text);
    expect(back.name).toBe(sheet(1).name);
    expect(back.spec).toEqual(sheet(1).spec);
  });

  it("refuses a label template and a broken file", () => {
    expect(() =>
      sheetImport(JSON.stringify({ name: "x", purpose: "box", spec: { widthMm: 58 } })),
    ).toThrow();
    expect(() => sheetImport("{")).toThrow();
  });

  it("says why the host refused a write", () => {
    const conflict = (constraint: string) =>
      new HostError({ kind: "api", code: "conflict", message: "", details: { constraint } });
    expect(sheetFailureKey(conflict("template_is_default"))).toBe(
      "office.palletSheets.errors.isDefault",
    );
    expect(sheetFailureKey(conflict("template_in_use"))).toBe("office.palletSheets.errors.inUse");
    expect(sheetFailureKey(new Error("x"))).toBe("office.palletSheets.errors.failed");
  });
});
```

(Поля `HostErrorInit` — по `src/host/client.ts`; если `status` обязателен — передать `409`. Ключ причины конфликта — `details.constraint`, как у `ApiError::conflict`; код ответа на устаревшую ревизию — как его называет `writeFailure` в `form-errors.ts` (`stale`), сопоставить с `office.palletSheets.errors.stale`.)

Run: `pnpm --filter @markiro/standalone exec vitest run test/sheet-list.test.ts` — Expected: FAIL.

- [ ] **Step 2: `src/office/sheets/sheet-list.ts`**

```ts
import {
  buildPalletSheetPresets,
  parsePalletSheetSpec,
  parseStoredLabelJson,
  serializeStoredLabelJson,
  isPalletSheetSpec,
  type PalletSheetPreset,
  type PalletSheetSpecV2,
} from "@markiro/domain";

import { HostError } from "../../host/client.js";
import type { PalletSheet } from "../../host/protocol.js";

/** A sheet's layout as the domain reads it, or `null` for one this build cannot read. */
export function readSheetSpec(spec: unknown): PalletSheetSpecV2 | null {
  try {
    return parsePalletSheetSpec(spec);
  } catch {
    return null;
  }
}

/** The words of a sheet's page: portrait, landscape, or two A5 copies on landscape A4. */
export function sheetLayoutKey(spec: unknown): "portrait" | "landscape" | "twoA5" | null {
  const read = readSheetSpec(spec);
  if (read === null) return null;
  if (read.page.copies === 2) return "twoA5";
  return read.page.orientation;
}

/** The stock sheets (`buildPalletSheetPresets`) whose key no sheet carries yet. */
export function missingPresets(sheets: readonly PalletSheet[]): PalletSheetPreset[] {
  const keys = new Set(sheets.map((sheet) => sheet.presetKey));
  return buildPalletSheetPresets().filter((preset) => !keys.has(preset.key));
}

/**
 * A sheet as a portable JSON file (#702's export): `{ name, purpose, spec }`,
 * no id, revision or organization — the domain's own serializer.
 */
export function sheetExport(sheet: PalletSheet): string {
  const spec = readSheetSpec(sheet.spec);
  if (spec === null) throw new Error("the sheet's layout is not readable");
  return serializeStoredLabelJson({ name: sheet.name, purpose: "pallet", spec });
}

/**
 * A sheet from a JSON file: the domain's strict reading (`parseStoredLabelJson`
 * never strips an unknown field of a V2 sheet); a label template, an unknown
 * version or a broken file throws.
 */
export function sheetImport(text: string): { name: string; spec: PalletSheetSpecV2 } {
  const parsed = parseStoredLabelJson(text);
  if (!isPalletSheetSpec(parsed.spec)) throw new Error("not an A4 sheet");
  return { name: parsed.name, spec: parsed.spec };
}

/** The `ru.json` key of why a write of a sheet failed. */
export function sheetFailureKey(error: unknown): string {
  if (error instanceof HostError) {
    if (error.code === "conflict") {
      const constraint = error.details["constraint"];
      if (constraint === "template_is_default") return "office.palletSheets.errors.isDefault";
      if (constraint === "template_in_use") return "office.palletSheets.errors.inUse";
    }
    if (error.code === "stale_revision" || error.code === "stale") {
      return "office.palletSheets.errors.stale";
    }
    if (error.code === "validation_failed") return "office.palletSheets.errors.invalid";
    if (error.code === "not_found") return "office.palletSheets.errors.missing";
  }
  return "office.palletSheets.errors.failed";
}
```

(Код устаревшей ревизии — взять из `ApiError::stale_revision` хоста и оставить одну ветку.)

Run: `pnpm --filter @markiro/standalone exec vitest run test/sheet-list.test.ts` — Expected: PASS.

- [ ] **Step 3: Предпросмотр листа**

`apps/standalone/src/office/sheets/SheetPreview.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PalletSheetSpecV2 } from "@markiro/domain";
import { Alert } from "@markiro/ui";

import { loadBundledMarkiroLogo, logoFromWire, sheetLogoOf } from "../../labels/logo.js";
import {
  paintMonoRaster,
  renderSheetRaster,
  sampleSheetContext,
} from "../../labels/sheet-render.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

/** Dots per preview pixel: an A4 portrait sheet (2480 dots) is 620 px wide. */
const FACTOR = 4;

export interface SheetPreviewProps {
  spec: PalletSheetSpecV2;
  /** The canvas's accessible name: the sheet's name. */
  label: string;
}

/**
 * The sheet as it prints, after the cloud admin's `ShiftPalletSheetPreview`:
 * the domain's renderer on synthetic data, with the organization's real name
 * and INN and its logo — or the bundled Markiro logo — at the nominal A4
 * geometry the station prints at. A sheet that does not render (a text that
 * does not fit, no font) says so instead of a blank canvas.
 */
export function SheetPreview({ spec, label }: SheetPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const logo = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (org.data === undefined || logo.data === undefined) return undefined;
    let cancelled = false;
    const organization = { name: org.data.name, inn: org.data.inn };
    const own = logo.data.logo === null ? null : logoFromWire(logo.data.logo);
    const draw = async () => {
      const bitmap = own ?? (await loadBundledMarkiroLogo());
      const raster = await renderSheetRaster(
        spec,
        sampleSheetContext(
          organization,
          sheetLogoOf(bitmap, own === null ? "markiro" : "organization"),
        ),
      );
      if (!cancelled && canvasRef.current !== null)
        paintMonoRaster(canvasRef.current, raster, FACTOR);
    };
    setFailed(false);
    draw().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [spec, org.data, logo.data]);

  return (
    <>
      {failed && <Alert tone="error">{t("office.palletSheets.previewFailed")}</Alert>}
      <canvas ref={canvasRef} className="sheet-preview" role="img" aria-label={label} />
    </>
  );
}
```

Стиль `.sheet-preview` (`max-width: 100%; height: auto; border: 1px solid var(--…border…)`) — в CSS офиса, где лежат стили страниц шаблонов (`grep -rn "template-name" apps/standalone/src --include=*.css`), токенами `@markiro/ui`.

- [ ] **Step 4: Страница «Листы А4»**

`apps/standalone/src/office/sheets/PalletSheetsPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { PalletSheet, PalletSheets } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { downloadFile } from "../templates/download.js";
import { SheetPreview } from "./SheetPreview.js";
import {
  missingPresets,
  readSheetSpec,
  sheetExport,
  sheetFailureKey,
  sheetImport,
  sheetLayoutKey,
} from "./sheet-list.js";

type Dialog =
  | { kind: "preview"; sheet: PalletSheet }
  | { kind: "rename"; sheet: PalletSheet }
  | { kind: "delete"; sheet: PalletSheet };

/**
 * A4 pallet sheets (plan А4, pilot spec §29): the stock sheets, a sheet from a
 * JSON file, rename, on and off, the default, a JSON copy and a preview. The
 * layout itself is edited as JSON outside (decision А4-11): «Скачать JSON»,
 * change, «Загрузить JSON» — always a new sheet. Both office roles change
 * sheets (`editCatalog`); every write's answer replaces the cached list.
 */
export function PalletSheetsPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const queryClient = useQueryClient();
  const sheets = useOfficeQuery(officeKeys.palletSheets, (api, token) =>
    api.listPalletSheets(token),
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const create = useOfficeMutation(
    (api, token, body: { name: string; presetKey?: string; spec: Record<string, unknown> }) =>
      api.createPalletSheet(token, body),
  );
  const update = useOfficeMutation(
    (api, token, v: { sheet: PalletSheet; name?: string; enabled?: boolean }) =>
      api.updatePalletSheet(token, v.sheet.id, {
        ...(v.name === undefined ? {} : { name: v.name }),
        ...(v.enabled === undefined ? {} : { enabled: v.enabled }),
        expectedRevision: v.sheet.revision,
      }),
  );
  const remove = useOfficeMutation((api, token, id: string) => api.deletePalletSheet(token, id));
  const setDefault = useOfficeMutation((api, token, templateId: string | null) =>
    api.setDefaultPalletSheet(token, { templateId }),
  );

  const refresh = () => void queryClient.invalidateQueries({ queryKey: officeKeys.palletSheets });
  const keep = (list: PalletSheets) => queryClient.setQueryData(officeKeys.palletSheets, list);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setFailure(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (error) {
      setFailure(t(sheetFailureKey(error)));
    } finally {
      refresh();
    }
  };

  const addStock = (list: readonly PalletSheet[]) =>
    run(async () => {
      for (const preset of missingPresets(list)) {
        await create.mutateAsync({ name: preset.name, presetKey: preset.key, spec: preset.spec });
      }
    }, t("office.palletSheets.stockAdded"));

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    let parsed: ReturnType<typeof sheetImport>;
    try {
      parsed = sheetImport(await file.text());
    } catch {
      setNotice(null);
      setFailure(t("office.palletSheets.errors.importInvalid"));
      return;
    }
    await run(
      () => create.mutateAsync({ name: parsed.name, spec: parsed.spec }),
      t("office.palletSheets.imported", { name: parsed.name }),
    );
  };

  if (sheets.isPending) return <PageLoading />;
  if (sheets.isError) {
    return <LoadError error={sheets.error} onRetry={() => void sheets.refetch()} />;
  }
  const list = sheets.data;

  const columns: TableColumn<PalletSheet>[] = [
    {
      key: "name",
      title: t("office.palletSheets.table.name"),
      wrap: true,
      render: (sheet) => (
        <>
          {sheet.name}{" "}
          {list.defaultId === sheet.id && (
            <Badge tone="teal">{t("office.palletSheets.default")}</Badge>
          )}{" "}
          {sheet.presetKey !== null && <Badge tone="steel">{t("office.palletSheets.stock")}</Badge>}
        </>
      ),
    },
    {
      key: "layout",
      title: t("office.palletSheets.table.layout"),
      render: (sheet) => {
        const layout = sheetLayoutKey(sheet.spec);
        return layout === null
          ? t("office.palletSheets.layouts.unreadable")
          : t(`office.palletSheets.layouts.${layout}`);
      },
    },
    {
      key: "state",
      title: t("office.palletSheets.table.state"),
      render: (sheet) => (
        <StatusChip
          phase={sheet.enabled ? "active" : "retired"}
          label={t(sheet.enabled ? "office.palletSheets.enabled" : "office.palletSheets.disabled")}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.palletSheets.table.actions"),
      render: (sheet) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.palletSheets.previewNamed", { name: sheet.name })}
            disabled={readSheetSpec(sheet.spec) === null}
            onClick={() => setDialog({ kind: "preview", sheet })}
          >
            {t("office.palletSheets.preview")}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.palletSheets.exportNamed", { name: sheet.name })}
            disabled={readSheetSpec(sheet.spec) === null}
            onClick={() =>
              downloadFile(
                new Blob([sheetExport(sheet)], { type: "application/json" }),
                `${sheet.name}.json`,
              )
            }
          >
            {t("office.palletSheets.export")}
          </Button>
          {canEdit && (
            <>
              {list.defaultId !== sheet.id && sheet.enabled && (
                <Button
                  variant="secondary"
                  size="compact"
                  aria-label={t("office.palletSheets.makeDefaultNamed", { name: sheet.name })}
                  onClick={() =>
                    void run(
                      async () => keep(await setDefault.mutateAsync(sheet.id)),
                      t("office.palletSheets.defaultSet", { name: sheet.name }),
                    )
                  }
                >
                  {t("office.palletSheets.makeDefault")}
                </Button>
              )}
              <Button
                variant="secondary"
                size="compact"
                aria-label={t(
                  sheet.enabled
                    ? "office.palletSheets.disableNamed"
                    : "office.palletSheets.enableNamed",
                  { name: sheet.name },
                )}
                onClick={() =>
                  void run(
                    () => update.mutateAsync({ sheet, enabled: !sheet.enabled }),
                    t("office.common.saved"),
                  )
                }
              >
                {t(sheet.enabled ? "office.palletSheets.disable" : "office.palletSheets.enable")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.palletSheets.renameNamed", { name: sheet.name })}
                onClick={() => setDialog({ kind: "rename", sheet })}
              >
                {t("office.palletSheets.rename")}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                aria-label={t("office.palletSheets.deleteNamed", { name: sheet.name })}
                onClick={() => setDialog({ kind: "delete", sheet })}
              >
                {t("office.palletSheets.delete")}
              </Button>
            </>
          )}
        </RowActions>
      ),
    },
  ];

  const stockMissing = missingPresets(list.sheets).length > 0;
  return (
    <>
      <PageHeader
        title={t("office.palletSheets.title")}
        {...(canEdit
          ? {
              actions: (
                <>
                  {stockMissing && (
                    <Button onClick={() => void addStock(list.sheets)}>
                      {t("office.palletSheets.addStock")}
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                    {t("office.palletSheets.import")}
                  </Button>
                </>
              ),
            }
          : {})}
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label={t("office.palletSheets.import")}
        onChange={(event) => void importFile(event)}
      />
      <Card>
        <p>{t("office.palletSheets.intro")}</p>
        {notice !== null && <Alert tone="ok">{notice}</Alert>}
        {failure !== null && <Alert tone="error">{failure}</Alert>}
        {list.sheets.length === 0 ? (
          <p>{t("office.palletSheets.empty")}</p>
        ) : (
          <Table columns={columns} rows={list.sheets} rowKey={(sheet) => sheet.id} />
        )}
      </Card>
      {dialog?.kind === "preview" && (
        <Modal
          open
          title={dialog.sheet.name}
          onClose={() => setDialog(null)}
          closeLabel={t("office.common.close")}
          width={720}
        >
          {(() => {
            const spec = readSheetSpec(dialog.sheet.spec);
            return spec === null ? null : <SheetPreview spec={spec} label={dialog.sheet.name} />;
          })()}
        </Modal>
      )}
      {dialog?.kind === "rename" && (
        <RenameSheetDialog
          sheet={dialog.sheet}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await run(
              () => update.mutateAsync({ sheet: dialog.sheet, name }),
              t("office.common.saved"),
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <FormDialog
          title={t("office.palletSheets.deleteTitle", { name: dialog.sheet.name })}
          submitLabel={t("office.palletSheets.delete")}
          submitVariant="destructive"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await run(
              () => remove.mutateAsync(dialog.sheet.id),
              t("office.palletSheets.deleted", { name: dialog.sheet.name }),
            );
            setDialog(null);
          }}
        >
          <p>{t("office.palletSheets.deleteText")}</p>
        </FormDialog>
      )}
    </>
  );
}

function RenameSheetDialog({
  sheet,
  onClose,
  onSubmit,
}: {
  sheet: PalletSheet;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(sheet.name);
  const trimmed = name.trim();
  return (
    <FormDialog
      title={t("office.palletSheets.renameTitle")}
      submitLabel={t("office.common.save")}
      submitDisabled={trimmed === "" || trimmed.length > 200 || trimmed === sheet.name}
      onClose={onClose}
      onSubmit={() => onSubmit(trimmed)}
    >
      <Input
        label={t("office.palletSheets.table.name")}
        value={name}
        maxLength={200}
        onChange={(event) => setName(event.target.value)}
      />
    </FormDialog>
  );
}
```

Сверить по месту API компонентов `@markiro/ui` (`PageHeader` — свойство действий, `Table` — `rows`/`rowKey`, `Badge` — тоны, `Modal`) с тем, как их зовут `TemplatesPage.tsx` и `FormDialog.tsx`, и привести вызовы; поведение не менять. `useOfficeMutation` со `spec: Record<string, unknown>` — тип `PalletSheetCreate.spec`; `PalletSheetSpecV2` и `preset.spec` присваиваются ему без приведения (иначе — `JSON.parse(JSON.stringify(spec))` через схему `palletSheetCreateSchema.parse`).

`routes.tsx`: импорт и `{ path: "pallet-sheets", element: <PalletSheetsPage /> },` после `template-defaults`. `nav.ts` после элемента `/template-defaults`:

```ts
  {
    to: "/pallet-sheets",
    labelKey: "office.nav.palletSheets",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
```

- [ ] **Step 5: Логотип в профиле организации**

`apps/standalone/src/office/org/OrgLogoCard.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import type { MonoBitmap } from "@markiro/domain";
import { Alert, Button, Card } from "@markiro/ui";

import type { OrgLogoState } from "../../host/protocol.js";
import { decodeLogoFile, logoFromWire, logoToWire } from "../../labels/logo.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function paintBitmap(canvas: HTMLCanvasElement, bitmap: MonoBitmap) {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) return;
  const data = new Uint8ClampedArray(bitmap.width * bitmap.height * 4).fill(255);
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      const byte = bitmap.pixels[y * bitmap.stride + (x >> 3)] ?? 0;
      if ((byte & (0x80 >> (x & 7))) === 0) continue;
      const offset = (y * bitmap.width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    }
  }
  context.putImageData(new ImageData(data, bitmap.width, bitmap.height), 0, 0);
}

/**
 * The organization's print logo (plan А4): what labels with a logo box and A4
 * sheets print, shown as it prints — black and white. The picture is turned
 * into 1-bit dots here (`decodeLogoFile`) and only the dots go to the host.
 * Without a logo the bundled Markiro logo prints. Administrators change it.
 */
export function OrgLogoCard() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const queryClient = useQueryClient();
  const state = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token));
  const put = useOfficeMutation((api, token, bitmap: MonoBitmap) =>
    api.putOrgLogo(token, logoToWire(bitmap)),
  );
  const clear = useOfficeMutation((api, token, _: null) => api.deleteOrgLogo(token));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const logo = state.data?.logo ?? null;

  useEffect(() => {
    const bitmap = logo === null ? null : logoFromWire(logo);
    if (bitmap !== null && canvasRef.current !== null) paintBitmap(canvasRef.current, bitmap);
  }, [logo]);

  const saved = (next: OrgLogoState, text: string) => {
    queryClient.setQueryData(officeKeys.orgLogo, next);
    setMessage({ tone: "ok", text });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setMessage(null);
    if (file.size > MAX_FILE_BYTES) {
      setMessage({ tone: "error", text: t("office.org.logo.tooLarge") });
      return;
    }
    let bitmap: MonoBitmap;
    try {
      bitmap = await decodeLogoFile(file);
    } catch {
      setMessage({ tone: "error", text: t("office.org.logo.unreadable") });
      return;
    }
    try {
      saved(await put.mutateAsync(bitmap), t("office.org.logo.saved"));
    } catch {
      setMessage({ tone: "error", text: t("office.org.logo.failed") });
    }
  };

  const remove = async () => {
    setMessage(null);
    try {
      saved(await clear.mutateAsync(null), t("office.org.logo.removed"));
    } catch {
      setMessage({ tone: "error", text: t("office.org.logo.failed") });
    }
  };

  if (state.isPending) return <PageLoading />;
  if (state.isError) return <LoadError error={state.error} onRetry={() => void state.refetch()} />;
  return (
    <Card>
      <h2>{t("office.org.logo.title")}</h2>
      <p>{t("office.org.logo.intro")}</p>
      {message !== null && <Alert tone={message.tone}>{message.text}</Alert>}
      {logo === null ? (
        <p>{t("office.org.logo.none")}</p>
      ) : (
        <canvas
          ref={canvasRef}
          className="org-logo-preview"
          role="img"
          aria-label={t("office.org.logo.preview")}
        />
      )}
      {canEdit && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            hidden
            aria-label={t("office.org.logo.upload")}
            onChange={(event) => void upload(event)}
          />
          <Button loading={put.isPending} onClick={() => fileRef.current?.click()}>
            {t(logo === null ? "office.org.logo.upload" : "office.org.logo.replace")}
          </Button>{" "}
          {logo !== null && (
            <Button variant="secondary" loading={clear.isPending} onClick={() => void remove()}>
              {t("office.org.logo.remove")}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
```

`OrgProfilePage.tsx`: в `OrgProfilePage` после `<OrgProfileContent />` — `<OrgLogoCard />` (импорт). Стиль `.org-logo-preview` — `max-height: 96px; max-width: 100%; image-rendering: pixelated;` в CSS офиса.

- [ ] **Step 6: «Лист А4» в диалоге смены**

`apps/standalone/src/office/shifts/shift-form.ts`:

- `shiftFieldsSchema`: после `palletTemplateId: z.string(),` — `palletSheetTemplateId: z.string(),` (пустая строка — основной лист организации, без проверки).
- `SHIFT_FIELD_ORDER`: после `"palletTemplateId",` — `"palletSheetTemplateId",`.
- `newShiftFields`: `palletSheetTemplateId: "",`; `shiftFields`: `palletSheetTemplateId: shift.palletSheetTemplateId ?? "",`.
- `toShiftInput`: в объект `pallets` — `...(values.palletSheetTemplateId === "" ? {} : { sheetId: values.palletSheetTemplateId }),`.
- `SHIFT_FIELDS`: `palletSheetTemplateId: { field: "palletSheetTemplateId", message: "office.shifts.errors.palletSheetRejected" },`.

`ShiftDialog.tsx`: запрос листов `useOfficeQuery(officeKeys.palletSheets, (api, token) => api.listPalletSheets(token))`; под полем `palletTemplateId` (якорь — `Controller` с `name="palletTemplateId"`, строка ~511), только при включённых паллетах, такое же поле-список `palletSheetTemplateId`:

- подпись `t("office.shifts.fields.palletSheet")`, подсказка `t("office.shifts.fields.palletSheetHint")`;
- первый вариант `{ value: "", label: t("office.shifts.palletSheetDefault", { name }) }`, где `name` — имя основного листа или `t("office.shifts.palletSheetNoDefault")`;
- далее включённые листы по имени, плюс текущий выбранный, даже выключенный (как поле шаблона паллеты держит текущий);
- ошибка поля — как у `palletTemplateId` (`fieldError(errors.palletSheetTemplateId?.message)`); в обработчике отказа (`outcome.field === "boxTemplateId" || outcome.field === "palletTemplateId"`) добавить `|| outcome.field === "palletSheetTemplateId"`;
- при выключении паллет `clearErrors([... , "palletSheetTemplateId"])` рядом с существующими.

Список не загрузился — поле показывает только «Основной лист организации» и подсказку `t("office.shifts.palletSheetsUnavailable")`; смена всё равно сохраняется (хост сам возьмёт основной).

- [ ] **Step 7: Тексты**

`src/i18n/ru.json`, ветка `office`:

- `office.nav.palletSheets`: «Листы А4».
- `office.org.logo`: `title` «Логотип для печати», `intro` «Логотип печатается на этикетках со стандартной разметкой и на листах палет А4. Он хранится чёрно-белым: так, как его напечатает принтер.», `none` «Логотип не загружен — печатается логотип Маркиро.», `preview` «Логотип для печати», `upload` «Загрузить логотип», `replace` «Заменить логотип», `remove` «Убрать логотип», `saved` «Логотип сохранён. Новые смены напечатают его; открытые смены печатают прежний.», `removed` «Логотип убран: новые смены напечатают логотип Маркиро.», `tooLarge` «Файл больше 2 МБ: выберите файл поменьше.», `unreadable` «Картинку не удалось прочитать: подойдут PNG, JPEG, WebP или SVG.», `failed` «Логотип не сохранён: хост не принял запрос. Повторите.».
- `office.palletSheets`: `title` «Листы палет А4», `intro` «Лист А4 печатается на закрытии палеты, если на станции принтеру назначения «Паллета» выбрана бумага «Лист А4» (драйвер Windows). Смена получает выбранный лист или основной.», `empty` «Листов пока нет. Добавьте готовые листы или загрузите свой файл JSON.», `addStock` «Добавить готовые листы», `stockAdded` «Готовые листы добавлены.», `import` «Загрузить JSON», `imported` «Лист «{{name}}» загружен.», `default` «Основной», `stock` «Готовый», `enabled` «Включён», `disabled` «Выключен», `enable` «Включить», `disable` «Выключить», `enableNamed` «Включить «{{name}}»», `disableNamed` «Выключить «{{name}}»», `makeDefault` «Сделать основным», `makeDefaultNamed` «Сделать «{{name}}» основным», `defaultSet` «Основной лист — «{{name}}».», `preview` «Просмотр», `previewNamed` «Просмотр «{{name}}»», `previewFailed` «Лист не отрисовался: текст не помещается или шрифт не загрузился.», `export` «Скачать JSON», `exportNamed` «Скачать JSON «{{name}}»», `rename` «Переименовать», `renameNamed` «Переименовать «{{name}}»», `renameTitle` «Название листа», `delete` «Удалить», `deleteNamed` «Удалить «{{name}}»», `deleteTitle` «Удалить «{{name}}»?», `deleteText` «Лист пропадёт из списка. Смены, которые уже открыты, печатают его из своего снимка.», `deleted` «Лист «{{name}}» удалён.», `table` { `name` «Название», `layout` «Лист», `state` «Состояние», `actions` «Действия» }, `layouts` { `portrait` «А4 вертикальный», `landscape` «А4 горизонтальный», `twoA5` «А4 горизонтальный · две А5», `unreadable` «Не читается этой версией» }, `errors` { `isDefault` «Это основной лист: сначала сделайте основным другой.», `inUse` «Лист выбран в запланированной смене: сначала смените лист в смене.», `stale` «Лист изменили в другом окне: список обновлён, повторите.», `invalid` «Хост не принял лист.», `missing` «Листа уже нет: список обновлён.», `importInvalid` «Файл — не лист палеты А4 или повреждён.», `failed` «Запрос не выполнен: хост не ответил. Повторите.» }.
- `office.shifts.fields.palletSheet` «Лист А4», `office.shifts.fields.palletSheetHint` «Печатается вместо термоэтикетки палеты на станции с принтером А4.», `office.shifts.palletSheetDefault` «Основной лист организации ({{name}})», `office.shifts.palletSheetNoDefault` «не выбран», `office.shifts.palletSheetsUnavailable` «Список листов не загрузился: смена получит основной лист.», `office.shifts.errors.palletSheetRejected` «Лист выключен или удалён: выберите другой.».

Проверить уникальность ключей (`node -e` с `JSON.parse` проходит, но дубли тихо затирают друг друга — `grep -c '"palletSheets"' ru.json` ровно 1 и так далее для каждой новой ветки).

- [ ] **Step 8: Тесты экранов**

`apps/standalone/test/pallet-sheets-page.test.tsx` (по образцу `templates-page.test.tsx`: `fakeOfficeSession`, `renderOffice`, переход по ссылке меню «Листы А4»):

1. Пустой список → текст «Листов пока нет…»; «Добавить готовые листы» вызывает `createPalletSheet` трижды с `presetKey` `pallet-a4-portrait`, `pallet-a4-landscape`, `pallet-a4-two-a5`, затем список читается заново.
2. Список с основным листом → у него «Основной», у основного нет кнопки «Сделать … основным»; «Сделать «X» основным» на другом зовёт `setDefaultPalletSheet` с его id.
3. «Выключить «X»» отправляет `{ enabled: false, expectedRevision }`; отказ `conflict`/`template_is_default` показывает «Это основной лист…».
4. Технолог видит действия, роль без `editCatalog` (если такая есть в тестах) — нет.
5. «Загрузить JSON» с файлом другого назначения — «Файл — не лист палеты А4 или повреждён.», `createPalletSheet` не вызван.

`apps/standalone/test/org-logo-card.test.tsx`: без логотипа — «Логотип не загружен — печатается логотип Маркиро.»; «Убрать логотип» при логотипе вызывает `deleteOrgLogo` и показывает «Логотип убран…»; технолог не видит кнопок. (Декодирование картинки в jsdom недоступно: загрузку проверить подменой `decodeLogoFile` через `vi.mock("../src/labels/logo.js", …)` с частичным `importActual`.)

`test/shift-dialog.test.tsx`: смена со паллетами без выбора листа отправляет запрос без `palletSheetTemplateId`; выбранный лист — с ним; при выключенных паллетах поля нет.

Run: `pnpm --filter @markiro/standalone exec vitest run test/sheet-list.test.ts test/pallet-sheets-page.test.tsx test/org-logo-card.test.tsx test/shift-dialog.test.tsx test/templates-page.test.tsx` — Expected: PASS. Затем весь пакет `pnpm --filter @markiro/standalone test`.

- [ ] **Step 9: Гейты и коммит**

```bash
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
node_modules/.bin/prettier --check apps/standalone/src/office apps/standalone/src/i18n/ru.json apps/standalone/test
git add <все файлы задачи явными путями>
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the office's print logo, the A4 sheets page and a shift's sheet (plan А4, task 5)` + трейлер.

### Task 6: Логотип на стандартных термоэтикетках (#703) — печать станции, предпросмотр, миниатюры и выгрузки офиса

**Files:**

- Create: `apps/standalone/src/floor/print/shift-render.ts`, `apps/standalone/src/office/use-label-logo.ts`, `apps/standalone/test/shift-render.test.ts`
- Modify: `apps/standalone/src/floor/print/label-render.ts`, `src/floor/work/WorkScreen.tsx`, `src/office/templates/label-samples.ts`, `src/office/templates/label-renderer.ts`, `src/office/templates/PreviewPane.tsx`, `src/office/templates/TemplateThumb.tsx`, `src/office/templates/TemplateEditor.tsx`, `apps/standalone/test/label-renderer.test.ts`, `test/support/office.tsx`

**Interfaces:**

- `renderLabel(spec, fields, printer, rasterize?, logo?: MonoBitmap | null)` — логотип уходит генераторам ZPL/TSPL; `null` — область пустая (как сейчас).
- `shiftLabelRender(shift: WorkShift, deps?: { rasterize?; loadLogo? }): RenderLabel` — рендер этикеток смены: логотип из снимка (`organization.logo`), иначе встроенный Маркиро (`labelLogo`); задача 8 добавляет сюда ветку листа А4.
- `useLabelLogo(): MonoBitmap | null` — логотип организации из `GET /v1/office/org/logo`, иначе Маркиро, `null` пока грузится или недоступен.
- `LabelRenderOptions.logo?: MonoBitmap | null`; `drawLabel` рисует `organization_logo`.

- [ ] **Step 1: Падающий тест рендера смены**

`apps/standalone/test/shift-render.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  buildDefaultLabelTemplates,
  sampleLabelData,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { shiftLabelRender } from "../src/floor/print/shift-render.js";
import { workShift } from "./support/shifts.js";

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };

const blankText: RasterizeTextFn = async (_text, options) => {
  const width = Math.max(1, Math.min(8, options.maxWidthPx ?? 8));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  return { width, height, bytesPerRow: 1, totalBytes: height, hex: "00".repeat(height) };
};

/** A stock box layout that reserves an `organization_logo` box (#703). */
function logoLayout() {
  const template = buildDefaultLabelTemplates().find((each) =>
    each.spec.elements.some((element) => element.kind === "organization_logo"),
  );
  if (template === undefined) throw new Error("no stock layout with a logo box");
  return template.spec;
}

describe("shiftLabelRender", () => {
  it("prints the logo the shift froze", async () => {
    const shift = workShift({ organization: { name: "ООО «Пример»", inn: null, logo: LOGO } });
    const loadLogo = vi.fn(async (own: MonoBitmap | null) => own);
    const render = shiftLabelRender(shift, { rasterize: blankText, loadLogo });
    const bytes = await render(logoLayout(), sampleLabelData(), { language: "zpl", dpi: 203 });
    expect(loadLogo).toHaveBeenCalledWith(LOGO);
    expect(new TextDecoder("latin1").decode(bytes)).toContain("^GFA");
  });

  it("asks for the fallback when the shift froze none, and none for a layout without a logo box", async () => {
    const shift = workShift({ organization: null });
    const loadLogo = vi.fn(async () => null);
    const render = shiftLabelRender(shift, { rasterize: blankText, loadLogo });
    await render(logoLayout(), sampleLabelData(), { language: "tspl", dpi: 203 });
    expect(loadLogo).toHaveBeenCalledWith(null);
    loadLogo.mockClear();
    const [plain] = buildDefaultLabelTemplates().filter(
      (each) => !each.spec.elements.some((element) => element.kind === "organization_logo"),
    );
    if (plain !== undefined) {
      await render(plain.spec, sampleLabelData(), { language: "zpl", dpi: 203 });
      expect(loadLogo).not.toHaveBeenCalled();
    }
  });
});
```

Построитель `workShift` в `test/support/shifts.ts` (или как он там называется — найти построитель `WorkShift`/`CheckedSnapshot`) получает необязательный `organization` для `snapshot.organization`. Если построителя `WorkShift` нет — собрать `WorkShift` в тесте из существующих помощников и записать. Признак логотипа в ZPL (`^GFA` графики) — сверить с тем, как `zpl.ts` выводит растр логотипа, и привести ожидание.

Run: `pnpm --filter @markiro/standalone exec vitest run test/shift-render.test.ts` — Expected: FAIL.

- [ ] **Step 2: Логотип в рендере станции**

`apps/standalone/src/floor/print/label-render.ts`:

- импорт домена дополнить `type MonoBitmap`;
- `renderLabel(spec, fields, printer, rasterize = rasterizeText)` → `renderLabel(spec, fields, printer, rasterize = rasterizeText, logo: MonoBitmap | null = null)`;
- вызовы генераторов: `{ rasterizeText: rasterize }` → `{ rasterizeText: rasterize, logo }` (оба).

Комментарий функции дополнить: «`logo` — what an `organization_logo` box prints (#703): the shift's organization logo or the bundled Markiro logo (`shiftLabelRender`); `null` leaves the box empty, as the domain does».

`apps/standalone/src/floor/print/shift-render.ts`:

```ts
import type { MonoBitmap, RasterizeTextFn } from "@markiro/domain";

import { labelLogo } from "../../labels/logo.js";
import { rasterizeText } from "../../labels/rasterizer.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { renderLabel } from "./label-render.js";
import type { RenderLabel } from "./print-jobs.js";

/** What a shift's render may be given instead of the app's own; tests give their own. */
export interface ShiftRenderDeps {
  rasterize?: RasterizeTextFn;
  /** The logo of a label: the shift's own, else a fallback; the app's is `labelLogo`. */
  loadLogo?: (own: MonoBitmap | null) => Promise<MonoBitmap | null>;
}

/**
 * How the labels of `shift` are rendered (plan А4, #703): from the shift's
 * snapshot alone, as every label of the shift. A layout with an
 * `organization_logo` box prints the organization logo the shift froze, else
 * the bundled Markiro logo, else leaves the box empty; a layout without one
 * loads no logo.
 */
export function shiftLabelRender(shift: WorkShift, deps: ShiftRenderDeps = {}): RenderLabel {
  const rasterize = deps.rasterize ?? rasterizeText;
  const loadLogo = deps.loadLogo ?? ((own: MonoBitmap | null) => labelLogo(own));
  return async (spec, fields, printer) => {
    const logo = spec.elements.some((element) => element.kind === "organization_logo")
      ? await loadLogo(shift.snapshot.organization?.logo ?? null)
      : null;
    return renderLabel(spec, fields, printer, rasterize, logo);
  };
}
```

`apps/standalone/src/floor/work/WorkScreen.tsx`, объект `latest`: `render: props.render,` → `render: props.render ?? shiftLabelRender(shift),` (импорт). Все потребители (`palletContextOf`, `boxLabelStep`, `printAgain(…, now.render)`, перепечатки исключений) уже читают `now.render`. Настройка рабочего места (`WorkstationSetup`, тестовая этикетка) не меняется — она печатает свою ASCII-этикетку без логотипа.

Run: `pnpm --filter @markiro/standalone exec vitest run test/shift-render.test.ts test/floor-label-render.test.ts` — Expected: PASS.

- [ ] **Step 3: Логотип в предпросмотре офиса**

`apps/standalone/src/office/use-label-logo.ts`:

```ts
import { useEffect, useMemo, useState } from "react";

import type { MonoBitmap } from "@markiro/domain";

import { loadBundledMarkiroLogo, logoFromWire } from "../labels/logo.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";

/**
 * The logo a label's `organization_logo` box shows in the office (#703): the
 * organization's print logo, else the bundled Markiro logo — what a new
 * shift will print. `null` while either loads, or when neither is there (the
 * box stays white, as a print without a logo leaves it).
 */
export function useLabelLogo(): MonoBitmap | null {
  const state = useOfficeQuery(officeKeys.orgLogo, (api, token) => api.getOrgLogo(token), {
    staleTime: 60_000,
  });
  const own = useMemo(() => {
    const logo = state.data?.logo ?? null;
    return logo === null ? null : logoFromWire(logo);
  }, [state.data]);
  const [markiro, setMarkiro] = useState<MonoBitmap | null>(null);
  const needsMarkiro = state.data !== undefined && own === null;
  useEffect(() => {
    if (!needsMarkiro) return undefined;
    let cancelled = false;
    loadBundledMarkiroLogo().then(
      (bitmap) => {
        if (!cancelled) setMarkiro(bitmap);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [needsMarkiro]);
  return own ?? (needsMarkiro ? markiro : null);
}
```

`label-samples.ts`: в `LabelRenderOptions` добавить

```ts
  /** What an `organization_logo` box draws (#703); none — it stays white. */
  logo?: MonoBitmap | null;
```

(импорт `type MonoBitmap`).

`label-renderer.ts`: импорт домена дополнить `renderLabelLogo`, `type MonoBitmap`, `type PrinterDpi`; тип элемента логотипа домен из `index.ts` не экспортирует, поэтому в файле объявить `type LabelOrganizationLogoElement = Extract<LabelTemplateSpec["elements"][number], { kind: "organization_logo" }>;`. Перед `drawLabel` добавить:

```ts
/**
 * Draws an `organization_logo` box as the print does (#703): the domain's
 * `renderLabelLogo` scales the logo into the box at the layout's resolution,
 * its natural aspect kept and centred vertically, and its dots are painted
 * here, each `scale × 25.4 / dpi` pixels wide.
 */
function drawLogo(
  canvas: LabelCanvas,
  element: LabelOrganizationLogoElement,
  scale: number,
  dpi: PrinterDpi,
  logo: MonoBitmap,
): void {
  const { xDots, yDots, raster } = renderLabelLogo(element, dpi, logo);
  const dotPx = (scale * 25.4) / dpi;
  paintRaster(canvas, raster, xDots * dotPx, yDots * dotPx, dotPx);
}
```

и ветку

```ts
      case "organization_logo":
        // The area stays white: this app has no organization logo to draw (pilot
        // question П15), and a print without a logo leaves it empty too.
        break;
```

заменить на

```ts
      case "organization_logo":
        // The organization's logo or the bundled Markiro one (plan А4); none —
        // the area stays white, as a print without a logo leaves it.
        if (options.logo) drawLogo(canvas, element, scale, spec.dpi, options.logo);
        break;
```

`PreviewPane.tsx`: `const logo = useLabelLogo();` и `const options = useMemo(() => ({ ...labelRenderOptions(purpose), logo }), [purpose, logo]);` вместо `const options = labelRenderOptions(purpose);` (импорт `useMemo`). `TemplateThumb.tsx`: внутри эффекта `const options = { ...labelRenderOptions(template.purpose), logo };`, `logo` из `useLabelLogo()` на уровне компонента и в зависимостях эффекта. `TemplateEditor.tsx`, `downloadCode`: `const deps = { rasterizeText, ...labelRenderOptions(draft.purpose), logo };` (`logo` из `useLabelLogo()` компонента).

`test/support/office.tsx`, `fakeHostApi`: `getOrgLogo` по умолчанию отвечает `{ logo: null }` (`vi.fn<HostApi["getOrgLogo"]>(async () => ({ logo: null }))`), как `officeLogout`: иначе каждый тест шаблонов, не знающий о логотипе, получит «неожиданный вызов».

Тест в `apps/standalone/test/label-renderer.test.ts`:

```ts
it("draws the organization logo inside its box at the layout's resolution", () => {
  const spec: LabelTemplateSpec = {
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    elements: [
      {
        id: "logo",
        kind: "organization_logo",
        source: "organization",
        fallback: "markiro",
        xMm: 2,
        yMm: 2,
        widthMm: 20,
        heightMm: 10,
      },
    ],
  };
  const canvas = recordingCanvas(); // the file's own recording canvas helper
  drawLabel(spec, canvas, 3, sampleLabelData(), {
    logo: { width: 8, height: 4, stride: 1, pixels: new Uint8Array(4).fill(0xff) },
  });
  const ink = canvas.rects.filter((rect) => rect.fillStyle === "#000000");
  expect(ink.length).toBeGreaterThan(0);
  for (const { rect } of ink) {
    const [x = 0, y = 0, width = 0, height = 0] = rect;
    expect(x).toBeGreaterThanOrEqual(2 * 3 - 0.01);
    expect(x + width).toBeLessThanOrEqual(22 * 3 + 0.01);
    expect(y).toBeGreaterThanOrEqual(2 * 3 - 0.01);
    expect(y + height).toBeLessThanOrEqual(12 * 3 + 0.01);
  }
});
```

Поля элемента `organization_logo` (`source`, `fallback`, размеры) — по схеме домена `model.ts`; помощник записывающего canvas — тот, что уже есть в файле (назвать как есть).

Run: `pnpm --filter @markiro/standalone exec vitest run test/label-renderer.test.ts test/templates-page.test.tsx test/stock-templates-render.test.ts` — Expected: PASS.

- [ ] **Step 4: Гейты и коммит**

```bash
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
pnpm --filter @markiro/standalone test
node_modules/.bin/prettier --check <изменённые файлы>
git add <все файлы задачи явными путями>
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the standard thermal labels print and preview the organization or Markiro logo (plan А4, task 6)` + трейлер.

### Task 7: Оболочка — режим страницы А4 в печати через драйвер Windows (после ДРВ)

**Предпосылка:** план ДРВ слит: в оболочке есть путь печати `mono-raster-v1` через драйвер Windows (порт облачных `printer_raster.rs`/`printer_windows.rs`/`printer_windows_commands.rs` #696 — у ДРВ имена могут отличаться), команда Tauri печати растра через очередь Windows с журналом отправки (`sending` до транспорта, неизвестный исход без повтора) и мост в `src/hardware/hardware.ts`. Прочитать слитый код ДРВ (`git log --oneline --grep 'ДРВ\|DRV\|#696'` в рабочей ветке) и привязать шаги ниже к его именам; расхождения — в «Отклонения».

**Files:**

- Create: `apps/standalone/src-tauri/src/printer/sheet.rs`
- Modify: `apps/standalone/src-tauri/src/printer.rs` (`pub mod sheet;`), модуль печати через драйвер ДРВ (открытие устройства, рисование, команда Tauri), `apps/standalone/src/hardware/hardware.ts`, тест моста `apps/standalone/test/hardware.test.ts` (или файл тестов моста ДРВ), при необходимости `apps/standalone/src-tauri/Cargo.toml` (фича `windows-sys`)

**Interfaces:**

- Rust: `printer::sheet::{SheetRaster, DeviceCaps, DrawPlan, Orientation, SheetError, sheet_orientation, sheet_draw_plan}`; команда печати драйвера ДРВ получает необязательный аргумент `paper: Option<String>` (`"a4"` — режим листа; иное значение — отказ `invalid_artifact` до отправки; нет — прежний путь этикетки). То же для команды предварительной проверки ДРВ, если она есть.
- TS: метод моста печати драйвера ДРВ получает необязательный `paper?: "a4"` и передаёт его в `invoke` только когда задан.

- [ ] **Step 1: Падающие тесты чистых проверок**

`apps/standalone/src-tauri/src/printer/sheet.rs` (тесты в конце файла; сначала только тесты и заглушки, чтобы увидеть FAIL):

```rust
//! A4 sheets through the Windows driver (plan А4, after the cloud station's
//! `printer_sheet.rs`, #702): the checks the driver path makes before it
//! draws, pure so that they run on any host. A sheet is a `mono-raster-v1`
//! page at 300 dpi of exactly A4 in either orientation; the device page must
//! be A4 in the same orientation at 300, 600 or 1200 dpi, the same on both
//! axes; the sheet is drawn 1:1, 2:1 or 4:1, never fitted, and its required
//! area (the content and the SSCC's quiet zones) must lie inside the
//! device's printable area with a 0.5 mm guard. Anything else is refused
//! before the job starts (`geometry_mismatch`): nothing reached the printer.

/// The orientation of an A4 page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
}

/// What the checks read of a sheet's `mono-raster-v1` header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetRaster {
    pub dpi: i32,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Width and height in dots.
    pub width: i32,
    pub height: i32,
    /// The required area in dots: left, top, right, bottom (right and bottom exclusive).
    pub bounds: [i32; 4],
}

/// A printer device's page as GDI reports it (`GetDeviceCaps`: `LOGPIXELSX`,
/// `LOGPIXELSY`, `PHYSICALWIDTH`, `PHYSICALHEIGHT`, `PHYSICALOFFSETX`,
/// `PHYSICALOFFSETY`, `HORZRES`, `VERTRES`), in device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceCaps {
    pub dpi_x: i32,
    pub dpi_y: i32,
    pub width: i32,
    pub height: i32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub printable_width: i32,
    pub printable_height: i32,
}

/// Where and how large the sheet is drawn on the device's printable area.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawPlan {
    /// Device dots per sheet dot: 1, 2 or 4.
    pub scale: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Why a sheet is not printed; both mean nothing was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetError {
    /// Not a 300 dpi A4 sheet.
    NotA4,
    /// The device page or its printable area does not hold the sheet.
    GeometryMismatch,
}

impl SheetError {
    /// The failure code the driver path reports (the codes of plan ДРВ).
    pub fn code(self) -> &'static str {
        match self {
            SheetError::NotA4 => "invalid_artifact",
            SheetError::GeometryMismatch => "geometry_mismatch",
        }
    }
}

fn sheet_dots(mm: f64) -> i32 {
    (mm * 300.0 / 25.4).round() as i32
}

/// The orientation of a 300 dpi A4 sheet, or [`SheetError::NotA4`].
pub fn sheet_orientation(raster: &SheetRaster) -> Result<Orientation, SheetError> {
    let near = |a: f64, b: f64| (a - b).abs() <= 0.01;
    if raster.dpi != 300 {
        return Err(SheetError::NotA4);
    }
    let orientation = if near(raster.width_mm, 210.0) && near(raster.height_mm, 297.0) {
        Orientation::Portrait
    } else if near(raster.width_mm, 297.0) && near(raster.height_mm, 210.0) {
        Orientation::Landscape
    } else {
        return Err(SheetError::NotA4);
    };
    if raster.width != sheet_dots(raster.width_mm) || raster.height != sheet_dots(raster.height_mm)
    {
        return Err(SheetError::NotA4);
    }
    Ok(orientation)
}

/// How the sheet is drawn on a device page, or why it is not.
pub fn sheet_draw_plan(raster: &SheetRaster, caps: DeviceCaps) -> Result<DrawPlan, SheetError> {
    let orientation = sheet_orientation(raster)?;
    let c = caps;
    if !matches!(c.dpi_x, 300 | 600 | 1200)
        || c.dpi_y != c.dpi_x
        || c.width <= 0
        || c.height <= 0
        || c.offset_x < 0
        || c.offset_y < 0
        || c.printable_width <= 0
        || c.printable_height <= 0
        || i64::from(c.offset_x) + i64::from(c.printable_width) > i64::from(c.width)
        || i64::from(c.offset_y) + i64::from(c.printable_height) > i64::from(c.height)
    {
        return Err(SheetError::GeometryMismatch);
    }
    let mm = |px: i32| f64::from(px) * 25.4 / f64::from(c.dpi_x);
    let (width_mm, height_mm) = match orientation {
        Orientation::Portrait => (210.0, 297.0),
        Orientation::Landscape => (297.0, 210.0),
    };
    if (mm(c.width) - width_mm).abs() > 0.5 || (mm(c.height) - height_mm).abs() > 0.5 {
        return Err(SheetError::GeometryMismatch);
    }
    let scale = c.dpi_x / 300;
    let guard = (0.5 * f64::from(c.dpi_x) / 25.4).ceil() as i64;
    let [left, top, right, bottom] = raster.bounds.map(|px| i64::from(px) * i64::from(scale));
    if right <= left
        || bottom <= top
        || left < i64::from(c.offset_x) + guard
        || top < i64::from(c.offset_y) + guard
        || right > i64::from(c.offset_x) + i64::from(c.printable_width) - guard
        || bottom > i64::from(c.offset_y) + i64::from(c.printable_height) - guard
    {
        return Err(SheetError::GeometryMismatch);
    }
    Ok(DrawPlan {
        scale,
        x: -c.offset_x,
        y: -c.offset_y,
        width: raster.width * scale,
        height: raster.height * scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A portrait sheet whose required area keeps 10 mm margins (118 dots).
    fn portrait() -> SheetRaster {
        SheetRaster {
            dpi: 300,
            width_mm: 210.0,
            height_mm: 297.0,
            width: 2480,
            height: 3508,
            bounds: [118, 118, 2480 - 118, 3508 - 118],
        }
    }

    /// A 600 dpi A4 page in `orientation` with 100 px (4.2 mm) unprintable edges.
    fn laser(orientation: Orientation) -> DeviceCaps {
        let (width, height) = match orientation {
            Orientation::Portrait => (4960, 7016),
            Orientation::Landscape => (7016, 4960),
        };
        DeviceCaps {
            dpi_x: 600,
            dpi_y: 600,
            width,
            height,
            offset_x: 100,
            offset_y: 100,
            printable_width: width - 200,
            printable_height: height - 200,
        }
    }

    #[test]
    fn a_portrait_sheet_is_drawn_two_to_one_on_a_600_dpi_laser() {
        assert_eq!(sheet_orientation(&portrait()), Ok(Orientation::Portrait));
        assert_eq!(
            sheet_draw_plan(&portrait(), laser(Orientation::Portrait)),
            Ok(DrawPlan { scale: 2, x: -100, y: -100, width: 4960, height: 7016 })
        );
    }

    #[test]
    fn a_landscape_sheet_needs_a_landscape_page() {
        let landscape = SheetRaster {
            width_mm: 297.0,
            height_mm: 210.0,
            width: 3508,
            height: 2480,
            bounds: [118, 118, 3508 - 118, 2480 - 118],
            ..portrait()
        };
        assert_eq!(sheet_orientation(&landscape), Ok(Orientation::Landscape));
        assert!(sheet_draw_plan(&landscape, laser(Orientation::Landscape)).is_ok());
        assert_eq!(
            sheet_draw_plan(&landscape, laser(Orientation::Portrait)),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn content_in_the_unprintable_edge_is_refused_before_sending() {
        // 2 mm margins: 24 sheet dots, 48 device dots, inside the 100 px edge.
        let tight = SheetRaster { bounds: [24, 24, 2480 - 24, 3508 - 24], ..portrait() };
        assert_eq!(
            sheet_draw_plan(&tight, laser(Orientation::Portrait)),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn letter_paper_unequal_axes_and_odd_resolutions_are_refused() {
        let letter = DeviceCaps { width: 5100, height: 6600, ..laser(Orientation::Portrait) };
        assert_eq!(sheet_draw_plan(&portrait(), letter), Err(SheetError::GeometryMismatch));
        let unequal = DeviceCaps { dpi_y: 300, ..laser(Orientation::Portrait) };
        assert_eq!(sheet_draw_plan(&portrait(), unequal), Err(SheetError::GeometryMismatch));
        let odd = DeviceCaps { dpi_x: 203, dpi_y: 203, ..laser(Orientation::Portrait) };
        assert_eq!(sheet_draw_plan(&portrait(), odd), Err(SheetError::GeometryMismatch));
    }

    #[test]
    fn a_label_raster_is_not_a_sheet() {
        let label = SheetRaster {
            dpi: 203,
            width_mm: 58.0,
            height_mm: 40.0,
            width: 463,
            height: 320,
            bounds: [0, 0, 463, 320],
        };
        assert_eq!(sheet_orientation(&label), Err(SheetError::NotA4));
        assert_eq!(SheetError::NotA4.code(), "invalid_artifact");
    }
}
```

В `apps/standalone/src-tauri/src/printer.rs` рядом с `pub mod spooler;` — `pub mod sheet;`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib printer::sheet` — Expected: PASS (функции уже полные; если сначала оставить `todo!()` — FAIL, потом PASS). Проверить ширину 600 dpi: `round(210 × 600 / 25.4) = 4961` — значение `4960` в тесте лежит в допуске 0,5 мм; если ДРВ округляет иначе, допуск тот же.

- [ ] **Step 2: Режим А4 в устройстве драйвера**

В модуле печати через драйвер ДРВ (облачный образец — `git -C /tmp/claude/wt/integ show 81b596d7b -- apps/station/src-tauri/src/printer_windows.rs`, ветка `options.is_some()` в `open_page` и ветка `sheet_plan` в рисовании):

1. Открытие устройства получает режим «лист А4 в ориентации `o`». В этом режиме `DEVMODEW` заполняется так (поля этикетки `DM_PAPERWIDTH`/`DM_PAPERLENGTH`/`DM_FORMNAME` снимаются):

```rust
(*dm).dmFields = ((*dm).dmFields & !(DM_FORMNAME | DM_PAPERWIDTH | DM_PAPERLENGTH))
    | DM_ORIENTATION
    | DM_PAPERSIZE
    | DM_COPIES
    | DM_SCALE
    | DM_DUPLEX;
let v = &mut (*dm).Anonymous1.Anonymous1;
v.dmOrientation = match o {
    Orientation::Portrait => DMORIENT_PORTRAIT,
    Orientation::Landscape => DMORIENT_LANDSCAPE,
} as i16;
v.dmPaperSize = DMPAPER_A4 as i16;
v.dmCopies = 1;
v.dmScale = 100;
(*dm).dmDuplex = DMDUP_SIMPLEX as i16;
```

После `DocumentPropertiesW(…, DM_IN_BUFFER | DM_OUT_BUFFER)` проверяется, что драйвер оставил ориентацию, `dmCopies == 1`, `dmScale == 100`, `dmPaperSize == DMPAPER_A4` и (если `DM_DUPLEX` выставлен) simplex — иначе `geometry_mismatch` до `StartDoc`, как в облаке.

2. Возможности устройства (`GetDeviceCaps`) переводятся в `printer::sheet::DeviceCaps`, заголовок растра (декодер ДРВ) — в `SheetRaster` (`bounds` — `requiredBounds` заголовка), и `sheet_draw_plan` даёт план; ошибка — отказ с `SheetError::code()` до `StartDoc`.

3. Рисование листа: `SetStretchBltMode(dc, COLORONCOLOR)` (целые точки, без сглаживания) и `StretchDIBits(dc, plan.x, plan.y, plan.width, plan.height, 0, 0, raster.width, raster.height, bits, &info, DIB_RGB_COLORS, SRCCOPY)` с тем же 1-битным `BITMAPINFO`, что строит ДРВ для этикетки; результат `<= 0` — сбой рисования, который ДРВ уже относит к фазе после начала задания (`delivery_unknown`, без повтора).

4. Этикеточный путь ДРВ не меняется. Если в `windows-sys` ДРВ нет нужных имён (`DMPAPER_A4`, `DMORIENT_LANDSCAPE`, `DMDUP_SIMPLEX`, `DM_DUPLEX`, `SetStretchBltMode`, `COLORONCOLOR`, `StretchDIBits`) — добавить фичу (`Win32_Graphics_Gdi`) в `src-tauri/Cargo.toml` без изменения `Cargo.lock`; если сборка требует сети/обновления lock — остановиться и записать шаг владельца.

5. Команда Tauri печати растра ДРВ (и предварительной проверки, если есть) получает `paper: Option<String>`: `None` — прежний путь; `Some("a4")` — режим листа (ориентация из `sheet_orientation` заголовка); иное — отказ `invalid_artifact` до отправки. Команда регистрируется как была (`invoke_handler` не меняется, меняются только аргументы).

Проверка на хосте: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib` (Windows-ветки за `#[cfg(windows)]` компилируются только на Windows; на macOS проверяются чистые функции и сигнатуры команды) и `cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-standalone` без предупреждений. Сборка под Windows — job CI автономного продукта (`.github/workflows/ci.yml`, Windows-шаг ДРВ); если его нет — «Не проверено».

- [ ] **Step 3: Мост webview**

В `apps/standalone/src/hardware/hardware.ts` метод печати через драйвер ДРВ (например `printDriverRaster(queue, bytes)`) получает последний необязательный параметр `paper?: "a4"` и передаёт `invoke(…, { …, ...(paper === undefined ? {} : { paper }) })`. Тест моста (файл тестов `createTauriHardware`, по образцу существующих проверок аргументов `invoke`):

```ts
it("asks the driver for an A4 page only when told", async () => {
  const call = vi.fn(async () => ({ sent: true }));
  const hardware = createTauriHardware(call);
  await hardware.printDriverRaster("HP LaserJet", new Uint8Array([1]), "a4");
  expect(call).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ paper: "a4" }),
  );
  await hardware.printDriverRaster("HP LaserJet", new Uint8Array([1]));
  expect(call.mock.lastCall?.[1]).not.toHaveProperty("paper");
});
```

(Имя метода, форма ответа и имя команды — ДРВ; привести.)

Run: `pnpm --filter @markiro/standalone exec vitest run test/hardware.test.ts` — Expected: PASS.

- [ ] **Step 4: Проверки и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
pnpm --filter @markiro/standalone typecheck
git add apps/standalone/src-tauri/src/printer/sheet.rs apps/standalone/src-tauri/src/printer.rs <файлы драйвера ДРВ> apps/standalone/src/hardware/hardware.ts <тест моста> [apps/standalone/src-tauri/Cargo.toml]
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): A4 pages on the Windows driver path — DMPAPER_A4, whole-number scale, the printable area checked before sending (plan А4, task 7)` + трейлер.

### Task 8: Станция — бумага «Лист А4», лист на закрытии паллеты, повтор и другой принтер, тестовая печать А4 с предпросмотром; документы (после ДРВ)

**Предпосылка:** задачи 1–7 и план ДРВ (профиль принтера с режимом драйвера Windows, рендер `mono-raster-v1` для драйвера, отправка через мост). Имена режима профиля ДРВ ниже — `mode: "windows_driver"` (как облако #696); если у ДРВ иначе — взять его.

**Files:**

- Create: `apps/standalone/src/floor/setup/a4-test.ts`, `apps/standalone/test/a4-test.test.ts`, `apps/standalone/test/shift-sheet-render.test.ts`
- Modify: `apps/standalone/src/floor/setup/workstation-settings.ts`, `src/floor/setup/printer-draft.ts`, `src/floor/setup/WorkstationSetup.tsx`, `src/floor/print/label-render.ts` (`LabelPrinter.paper`), `src/floor/print/shift-render.ts`, `src/floor/print/print-resolution.ts`, место отправки ДРВ (`print-runtime.ts` или очередь принтера ДРВ), выбор «Другой принтер» на экране восстановления (`LabelPanel.tsx` или где строится список), `src/i18n/ru.json`, `apps/standalone/test/workstation-settings.test.ts`, `test/workstation-setup.test.tsx`, `test/print-resolution.test.ts` (имена файлов — существующие тесты этих модулей), `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

**Interfaces:**

- `PrinterProfile.paper?: "a4"` — только `mode: "windows_driver"`, `dpi: 300`; иное сочетание — профиль не читается (`parsePrinterProfile` → `null`, как облачный `parsePrinterProfile`). Назначения `box` и `duplicate` с профилем А4 читаются как «не назначено».
- `renderShiftSheet(shift, fields, deps?): Promise<Uint8Array>` — байты `mono-raster-v1` листа из снимка; нет листа или организации в снимке — ошибка (задание `failed`/`render_failed`).
- `shiftLabelRender` — принтер с `paper: "a4"` → `renderShiftSheet`, иначе прежняя ветка (и ветка драйвера ДРВ).
- `makeA4TestSscc(random?)`, `a4TestSheet(orientation, sscc, text, deps?)`.

- [ ] **Step 1: Падающие тесты профиля и рендера листа**

`apps/standalone/test/workstation-settings.test.ts` — добавить:

```ts
describe("paper «Лист А4» (plan А4)", () => {
  const driver = {
    id: "p-a4",
    name: "HP LaserJet",
    target: { kind: "usb", printer: "HP LaserJet" },
    language: "zpl",
    dpi: 300,
    mode: "windows_driver",
  };

  it("reads A4 paper only on a Windows driver profile at 300 dpi", () => {
    expect(parsePrinterProfile({ ...driver, paper: "a4" })).toMatchObject({ paper: "a4" });
    expect(parsePrinterProfile({ ...driver, paper: "a4", dpi: 203 })).toBeNull();
    expect(parsePrinterProfile({ ...driver, paper: "a4", mode: "raw" })).toBeNull();
    expect(parsePrinterProfile({ ...driver, paper: "letter" })).toBeNull();
    expect(parsePrinterProfile(driver)).not.toHaveProperty("paper");
  });

  it("keeps an A4 printer off the box and duplicate purposes", () => {
    const parsed = parsePrinters({
      printers: [{ ...driver, paper: "a4" }],
      assignments: { box: "p-a4", pallet: "p-a4", duplicate: "p-a4" },
    });
    expect(parsed.assignments).toEqual({ box: null, pallet: "p-a4", duplicate: null });
  });
});
```

`apps/standalone/test/shift-sheet-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildPalletSheetPresets,
  decodeMonoRaster,
  palletLabelFields,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { renderShiftSheet, shiftLabelRender } from "../src/floor/print/shift-render.js";
import { workShift } from "./support/shifts.js";

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };
const text: RasterizeTextFn = async (value, options) => {
  const width = Math.max(1, Math.min(value.length * 4, options.maxWidthPx ?? value.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

function fields() {
  return palletLabelFields({
    sscc: "146006820000000014",
    boxCount: 40,
    itemCount: 480,
    productName: "Молоко 3,2% 0,9 л",
    productPrintName: "Молоко 3,2%",
    gtin14: "04600682000013",
    egaisCode: null,
    shelfLifeDays: 10,
    operatorName: "Иванова",
    counterpartyName: null,
    closedAt: "2026-10-11T09:00:00.000Z",
    productionDate: "2026-10-11",
    shiftNumber: "OCT26-001",
  });
}

describe("renderShiftSheet", () => {
  const [preset] = buildPalletSheetPresets();
  if (preset === undefined) throw new Error("no stock sheet");
  const sheet = {
    id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
    name: preset.name,
    revision: 1,
    spec: preset.spec,
  };

  it("renders the frozen sheet with the frozen organization", async () => {
    const shift = workShift({
      palletSheet: sheet,
      organization: { name: "ООО «Молочный завод»", inn: "7701234567", logo: LOGO },
    });
    const bytes = await renderShiftSheet(shift, fields(), { sheetRasterize: text });
    expect(decodeMonoRaster(bytes)).toMatchObject({ widthMm: 210, heightMm: 297, dpi: 300 });
  });

  it("does not render without a frozen sheet", async () => {
    const shift = workShift({
      palletSheet: null,
      organization: { name: "ООО", inn: null, logo: LOGO },
    });
    await expect(renderShiftSheet(shift, fields(), { sheetRasterize: text })).rejects.toThrow();
  });

  it("is what an A4 printer gets from the shift's render", async () => {
    const shift = workShift({
      palletSheet: sheet,
      organization: { name: "ООО «Молочный завод»", inn: null, logo: LOGO },
    });
    const render = shiftLabelRender(shift, { sheetRasterize: text });
    const bytes = await render(shift.snapshot.boxTemplate.spec, fields(), {
      language: "zpl",
      dpi: 300,
      paper: "a4",
    });
    expect(decodeMonoRaster(bytes).widthMm).toBe(210);
  });
});
```

(SSCC фикстуры — существующее валидное SSCC паллеты из `test/support/pallets.ts`; `workShift` — построитель задачи 6 с полями `palletSheet`/`organization`; поля `palletLabelFields` — по сигнатуре домена.)

Run: `pnpm --filter @markiro/standalone exec vitest run test/workstation-settings.test.ts test/shift-sheet-render.test.ts` — Expected: FAIL.

- [ ] **Step 2: Профиль «Лист А4»**

`apps/standalone/src/floor/setup/workstation-settings.ts`:

- `PrinterProfile` (после полей ДРВ):

```ts
  /**
   * «Лист А4» (plan А4): the printer takes A4 sheets through its Windows
   * driver at 300 dpi; only the purpose «Паллета» may print on it, and it
   * prints the shift's A4 sheet instead of the thermal pallet label. Left out
   * for a label printer.
   */
  paper?: "a4";
```

- `parsePrinterProfile`: перед `return` —

```ts
const paper = row["paper"];
if (paper !== undefined && (paper !== "a4" || mode !== "windows_driver" || dpi !== 300)) {
  return null;
}
```

и в возвращаемый объект `...(paper === "a4" ? { paper: "a4" as const } : {})` (`mode` — переменная режима, которую читает ДРВ; если её нет под этим именем — взять его).

- `parsePrinters`: после цикла назначений —

```ts
// An A4 sheet printer prints pallets only (plan А4): box and duplicate labels never go to it.
for (const purpose of ["box", "duplicate"] as const) {
  const id = assignments[purpose];
  if (id !== null && printers.some((printer) => printer.id === id && printer.paper === "a4")) {
    assignments[purpose] = null;
  }
}
```

`apps/standalone/src/floor/setup/printer-draft.ts`: `PrinterDraft.paper: "label" | "a4"`, `NEW_PRINTER.paper = "label"`, `draftOf` — `paper: profile.paper ?? "label"`; `DraftError` + `"paper"`; в `profileOf` перед `parsePrinterProfile`:

```ts
if (draft.paper === "a4" && (draft.mode !== "windows_driver" || draft.dpi !== "300")) {
  return { error: "paper" };
}
```

и в объект профиля `...(draft.paper === "a4" ? { paper: "a4" } : {})` (поле режима черновика — ДРВ).

`apps/standalone/src/floor/print/label-render.ts`: `LabelPrinter` получает `/** «Лист А4» (plan А4). */ paper?: "a4";`.

- [ ] **Step 3: Лист в рендере смены**

`apps/standalone/src/floor/print/shift-render.ts` — добавить:

```ts
// imports: добавить type LabelFields из "./label-render.js",
// loadBundledMarkiroLogo, sheetLogoOf из "../../labels/logo.js",
// rasterizeSheetText из "../../labels/rasterizer.js",
// renderSheetBytes из "../../labels/sheet-render.js"
```

`ShiftRenderDeps` получает `sheetRasterize?: RasterizeTextFn;` и `loadMarkiro?: () => Promise<MonoBitmap>;`.

```ts
function count(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw new Error("a pallet label's count is not a number");
  return Number(text);
}

/**
 * A pallet's A4 sheet (plan А4) from the shift's snapshot alone: the sheet,
 * the organization's name, INN and logo the shift froze — the bundled Markiro
 * logo when it froze none — and the pallet's own facts from its label fields
 * (`palletLabelFields`: the SSCC, the boxes and their units). The production
 * date is the shift's; the expiry is the domain's. A shift that froze no sheet
 * or no organization (opened by a host before plan А4) does not render: the
 * job stays `failed`, and the operator prints elsewhere from the recovery.
 */
export async function renderShiftSheet(
  shift: WorkShift,
  fields: LabelFields,
  deps: ShiftRenderDeps = {},
): Promise<Uint8Array> {
  const { palletSheet, organization, product } = shift.snapshot;
  if (palletSheet === null || organization === null) {
    throw new Error("the shift froze no A4 sheet");
  }
  const own = organization.logo;
  const bitmap = own ?? (await (deps.loadMarkiro ?? loadBundledMarkiroLogo)());
  return renderSheetBytes(
    palletSheet.spec,
    {
      sscc: fields.sscc,
      productPrintName: fields["product.printName"],
      gtin14: product.gtin14,
      egaisCode: null,
      productionDate: shift.copy.productionDate,
      shelfLifeDays: product.shelfLifeDays,
      boxCount: count(fields["qty.boxes"]),
      itemCount: count(fields.qty),
      shiftNumber: fields["shift.no"] === "" ? null : fields["shift.no"],
      organizationName: organization.name,
      organizationInn: organization.inn,
      logo: sheetLogoOf(bitmap, own === null ? "markiro" : "organization"),
    },
    deps.sheetRasterize ?? rasterizeSheetText,
  );
}
```

В возвращаемой функции `shiftLabelRender` первой строкой:

```ts
if (printer.paper === "a4") return renderShiftSheet(shift, fields, deps);
```

Run: `pnpm --filter @markiro/standalone exec vitest run test/workstation-settings.test.ts test/shift-sheet-render.test.ts test/shift-render.test.ts` — Expected: PASS.

- [ ] **Step 4: Повтор, другой принтер, отправка**

`apps/standalone/src/floor/print/print-resolution.ts`, `printAgain`: условие тех же байтов

```ts
const sameRender =
  job.printer !== null &&
  job.printer.language === printer.language &&
  job.printer.dpi === printer.dpi;
```

дополнить `&& job.printer.paper === printer.paper` (и полем режима ДРВ, если ДРВ не добавил его сам). `printerForAgain`: выбранный (`chosen`) профиль А4 для задания не паллеты — `null` (`NoPrinterError`, ничего не отправлено):

```ts
if (chosen !== null) return chosen.paper === "a4" && job.purpose !== "pallet" ? null : chosen;
```

Список «Другой принтер» экрана восстановления (найти, где он строится из `settings.printers`, — `LabelPanel.tsx` или рабочий экран) не показывает профили А4 для этикетки короба. Тест `test/print-resolution.test.ts`: задание паллеты, напечатанное на термопринтере, повторённое на А4, рендерится заново (`render` вызван с профилем А4); задание короба с выбранным А4 — `NoPrinterError`, `sendLabelJob` не вызван.

Отправка: в точке, где ДРВ выбирает путь драйвера для профиля (`mode === "windows_driver"`, очередь `target.printer`), передать `profile.paper` в метод моста задачи 7. Журнал (`sending` до моста, `unknown` после сбоя на середине, без автоповтора) — ДРВ, не меняется. Тест очереди/рантайма ДРВ: профиль А4 → мост вызван с `"a4"`, термопрофиль драйвера → без него.

- [ ] **Step 5: Тестовая печать А4 в настройке рабочего места (#704)**

`apps/standalone/src/floor/setup/a4-test.ts`:

```ts
import {
  buildPalletSheetPresets,
  gs1CheckDigit,
  type MonoRaster,
  type RasterizeTextFn,
} from "@markiro/domain";

import { loadBundledMarkiroLogo, sheetLogoOf } from "../../labels/logo.js";
import { rasterizeSheetText } from "../../labels/rasterizer.js";
import { renderSheetRaster } from "../../labels/sheet-render.js";
import { encodeMonoRaster } from "@markiro/domain";

/**
 * A synthetic SSCC for one A4 test print (the cloud station's
 * `makeA4TestSscc`): company prefix 9999, never one of production's, random,
 * so a sheet left over from an earlier test never passes this one.
 */
export function makeA4TestSscc(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(13);
  random(bytes);
  const body = `9999${Array.from(bytes, (byte) => String(byte % 10)).join("")}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/**
 * The A4 test sheet (#704): the stock single sheet of `orientation` with the
 * bundled Markiro logo, the words of `text` and the synthetic `sscc`; the
 * raster for the on-screen preview and its bytes for the driver.
 */
export async function a4TestSheet(
  orientation: "portrait" | "landscape",
  sscc: string,
  text: { title: string; product: string },
  deps: {
    rasterize?: RasterizeTextFn;
    logo?: () => Promise<import("@markiro/domain").MonoBitmap>;
  } = {},
): Promise<{ raster: MonoRaster; bytes: Uint8Array }> {
  const preset = buildPalletSheetPresets().find(
    (each) => each.spec.page.orientation === orientation && each.spec.page.copies === 1,
  );
  if (preset === undefined) throw new Error("no stock A4 sheet");
  const logo = await (deps.logo ?? loadBundledMarkiroLogo)();
  const raster = await renderSheetRaster(
    preset.spec,
    {
      sscc,
      productPrintName: text.product,
      gtin14: "04600000000015",
      egaisCode: null,
      productionDate: null,
      shelfLifeDays: null,
      boxCount: 48,
      itemCount: 576,
      shiftNumber: null,
      organizationName: text.title,
      organizationInn: null,
      logo: sheetLogoOf(logo, "markiro"),
    },
    deps.rasterize ?? rasterizeSheetText,
  );
  return { raster, bytes: encodeMonoRaster(raster) };
}
```

(Импорты свести в один `import` из `@markiro/domain`, тип `MonoBitmap` — `import type`; инлайн-`import()` выше только для краткости плана — исполнитель заменяет его обычным импортом.)

`apps/standalone/test/a4-test.test.ts`: `makeA4TestSscc(() => {})` (нули) → `"999900000000000008"` (`isValidSscc` домена истинно); `a4TestSheet("landscape", …)` с подставными `rasterize` и `logo` даёт растр 297 × 210 мм.

`WorkstationSetup.tsx`, `testPrint`: для `printer.paper === "a4"` — вместо `testLabelSpec`:

```ts
if (printer.paper === "a4") {
  const sscc = makeA4TestSscc();
  let sheet: Awaited<ReturnType<typeof a4TestSheet>>;
  try {
    sheet = await a4TestSheet("portrait", sscc, {
      title: t("floor.setup.printers.a4Test.title"),
      product: t("floor.setup.printers.a4Test.product"),
    });
  } catch {
    setTest({ kind: "render_failed" });
    return;
  }
  setA4Preview(sheet.raster);
  // … the same send and settle as a label, through the A4 driver path (plan ДРВ + task 7) …
  // the scan check compares parseScannedSscc(raw) with `sscc`.
}
```

- предпросмотр: состояние `a4Preview: MonoRaster | null` и `<canvas>` рядом с результатом теста, отрисованный `paintMonoRaster(canvas, raster, 6)` в эффекте; `role="img"`, `aria-label={t("floor.setup.printers.a4Test.preview")}`; при смене профиля/бумаги предпросмотр и результат теста сбрасываются (как облачный #704 «print checks reset when the paper changes»);
- проверка скана: в `source.start` (якорь `scannedTestCode(raw) === now.code`) — `(now.paper === "a4" ? parseScannedSscc(raw) : scannedTestCode(raw)) === now.code`, где состояние `sent` получает `paper`;
- редактор принтера: поле «Бумага» (`Select` «Термоэтикетка» / «Лист А4») только в режиме драйвера Windows; при «Лист А4» разрешение ставится 300 и поле разрешения недоступно; ошибка черновика `paper` — `floor.setup.printers.errors.paper`;
- назначение «Коробка» и «Дубликат» не предлагают профили А4; сводка профиля (`summary`) для А4 — `t("floor.setup.printers.summary.a4", { printer })` вместо языка и dpi.

Все кнопки экрана — `size="floor"` (≥ 64 px), как остальные кнопки настройки.

Тесты `test/workstation-setup.test.tsx` (стенд с задержкой `setImmediate` для эффектов): поле «Бумага» видно только у профиля драйвера; профиль А4 не появляется в выборе для «Коробка»; тестовая печать А4 отправляет байты `mono-raster-v1` (заголовок `decodeMonoRaster` — 210 × 297 мм) через мост с `paper: "a4"` и принимает скан `]C100<sscc>`; смена бумаги сбрасывает результат проверки.

- [ ] **Step 6: Тексты станции**

`src/i18n/ru.json`, ветка `floor.setup.printers`: `editor.paper` «Бумага», `editor.paperLabel` «Термоэтикетка», `editor.paperA4` «Лист А4 (драйвер Windows)», `editor.paperHint` «Лист А4 печатает палету на обычном принтере: только назначение «Паллета», 300 dpi.», `errors.paper` «Лист А4 печатается только через драйвер Windows при 300 dpi.», `summary.a4` «Лист А4 · {{printer}}», `a4Test.title` «Проверка принтера А4», `a4Test.product` «Тестовый лист — не для палеты», `a4Test.preview` «Предпросмотр тестового листа А4», `a4Test.scan` «Отсканируйте SSCC внизу листа.». Ключи — в существующие ветки, без дублей.

- [ ] **Step 7: Документы**

`apps/standalone/AGENTS.md`:

- в «Catalog and label templates» — абзац «Organization logo and A4 sheets (plan А4)»: монохромный логотип `org_logo` (1024 × 512, 90 000 символов base64, готовит офис через `logoFromRgba`), встроенный `src/assets/markiro-print-logo.svg` как резерв, `pallet_sheet_templates` (V2, ≤ 64 КиБ, хост проверяет только `schemaVersion`/`kind`, макет — домен), готовые листы по `presetKey`, основной лист, листы не в ленте станции;
- в «Shifts» — `palletSheetTemplateId` (только со паллетами, без него — основной лист), снимок `palletSheet` и `organization` (замораживаются при открытии; логотип и лист не меняются в открытой смене);
- в «Floor printing» — бумага «Лист А4» (драйвер, 300 dpi, только «Паллета»), выбор формата принтером, задание листа в `floor_print_jobs` (байты `mono-raster-v1`, шаблон задания — термошаблон снимка), «те же байты» с учётом бумаги, проверка печатной области оболочкой до отправки, тестовая печать А4;
- в «Verification» — что не проверяется без Windows и принтера (см. «Не проверено» плана).

`docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — дописать в конец:

```markdown
## 29. Листы палет А4 и логотип (план А4)

- Логотип организации загружает администратор в «Профиль → Логотип для печати»; офис переводит картинку в 1 бит, хост хранит биты (`org_logo`). Без логотипа печатается встроенный логотип Маркиро. Логотип печатают этикетки со стандартной разметкой (`organization_logo`, #703) и листы А4.
- Листы А4 — отдельная библиотека хоста `pallet_sheet_templates` (`PalletSheetSpecV2` облака, #702): три готовых листа (вертикальный, горизонтальный, две А5), переименование, включение, основной лист, JSON-выгрузка и загрузка, предпросмотр. Визуального редактора нет: свой лист — правкой JSON.
- Смена с паллетами получает лист, выбранный в офисе, иначе основной; смена станции — основной. При открытии смены хост замораживает лист, название, ИНН и логотип организации в снимке; поздние правки не меняют открытую смену.
- Станция печатает лист вместо термоэтикетки палеты, если принтеру назначения «Паллета» выбрана бумага «Лист А4» (драйвер Windows, 300 dpi). Задание, проверка сканом, «Напечатать снова», «Другой принтер» и неизвестный исход — как у этикетки. Лист рисуется по номинальной геометрии А4; оболочка до отправки сверяет его обязательную область с печатной областью принтера (зазор 0,5 мм) и отказывает `geometry_mismatch`.
- Не входят: выбор листа в форме новой смены станции, измеренная геометрия принтера, визуальный редактор, импорт листов и логотипа из облака, печать А4 с ТСД.
```

- [ ] **Step 8: Итоговые проверки и коммит**

```bash
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
pnpm --filter @markiro/standalone test
pnpm --filter @markiro/standalone build
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test org_logo --test pallet_sheets --test office_shifts --test device_shifts --test foundation --test backup_schema
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
node_modules/.bin/prettier --check <изменённые файлы> docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md apps/standalone/AGENTS.md
git diff --check
git add <все файлы задачи явными путями>
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the station prints a pallet's A4 sheet on an A4 driver printer, with the A4 test print; docs (plan А4, task 8)` + трейлер. После слияния, если в дереве есть локальный граф: `graphify update .`.

## Итоговая проверка плана

- Логотип: офис загружает → хост проверяет биты → снимок новой смены несёт логотип → термоэтикетка стандартной разметки и лист печатают его; без логотипа — Маркиро; открытая смена логотип не меняет (задачи 2, 4, 6).
- Листы: три готовых листа добавляются один раз; основной не выключается и не удаляется; лист запланированной смены не удаляется; JSON туда и обратно сохраняет спек (задачи 3, 5).
- Смена: офис выбирает лист или основной, станция — основной; без паллет листа нет; снимок замораживает лист (задача 4).
- Печать: принтер «Лист А4» на «Паллете» печатает лист вместо термоэтикетки, задание и журнал прежние, повтор на другом формате рендерит заново, короб на А4 не уходит; оболочка отказывает до отправки, если лист не помещается в печатную область (задачи 7, 8).
- Паритет: каждая новая форма — фикстура, Rust-круг, Zod-разбор; `PROTOCOL_VERSION` 3.

## Перенесено

- **Выбор листа в форме новой смены станции** и предпросмотр А4 в ней (облачный `NewShift` #704): станция берёт основной лист (А4-3). Нужны маршрут устройства со списком листов и поле в `NewShift.tsx`.
- **Визуальный редактор листа** (облачные `SheetEditor`, `SheetCanvas`, `SheetNodeInspector`, undo/redo, подвал #707 в редакторе): в MVP — JSON (А4-11). Подвал с ИНН (#707) печатается, если он есть в спеке листа (готовые листы домена уже содержат `footer` с `showInn`).
- **Категорийные основные листы** (`org_pallet_sheet_template_defaults` облака): один основной лист на площадку.
- **Измеренная геометрия драйвера до рендера и её отпечаток в задании**, повторная подготовка с новой геометрией после `failed_before_send`, хранение снимка рендера и ресурсов брендинга по digest (`printer_deliveries.render_snapshot_json`, `pallet_sheet_branding_resources` облака): здесь — номинальная геометрия и проверка в оболочке (А4-8); задание хранит байты.
- **Перенос листов и логотипа из облака** (ИМП): строки V2, умолчания листов, `shifts.pallet_sheet_template_*`, логотип облака (А4-16).
- **Логотип в печатных HTML-формах плана О-Ф** (ярлык и состав паллеты): формы печатают как прежде.
- **Печать А4 с ТСД** — вне продукта (как в облаке).
- **Исправление TSPL-импорта `EAN128`** (`packages/domain/src/labels/tspl-import.ts`, отчёт дрейфа, раздел B) — домен, вне этого плана.

## Не проверено

- Печать листа на реальном лазерном и струйном принтере под Windows: `DMPAPER_A4`, ориентация, simplex, отказ драйвера, конец бумаги, недоступная очередь, перезапуск посреди задания; размеры линейкой; SSCC сканером на обеих половинах «двух А5» после разреза. Хост-тесты Cargo и Vitest этого не доказывают.
- Декодирование картинок логотипа (PNG/JPEG/WebP/SVG) и встроенного SVG Маркиро в WebView2 (jsdom не декодирует картинок; тесты подменяют декодер).
- Загрузка шрифтов IBM Plex для `rasterizeSheetText` в WebView2 офлайн и совпадение предпросмотра офиса с печатью станции на одном ПК.
- Сборка Windows-веток оболочки (`#[cfg(windows)]`) — только в Windows-job CI; если его нет, сборка под Windows не проверена.
- Читаемость логотипа после порога 1 бит на реальной термоэтикетке 203/300 dpi.

## Отклонения при исполнении

- **Задача 1.**
  - Сверх брифа: `decodeLogoFile` до чтения проверяет белый список MIME (png/jpeg/webp/svg+xml) и предел файла 4 МиБ; отказы — `LogoDecodeError` с кодами `too_large`, `unsupported_type`, `decode_failed`, `empty`, `canvas_unavailable`.
  - `rasterizeSheetText` выражен через общий с `rasterizeDriverText` закрытый помощник `rasterizeWithBundledFace`; поведение драйверного не изменилось.
  - `downsampleMonoRaster` отказывает множителю, который не целое число ≥ 1.
  - `dist` домена был устаревшим (нет `organizationInn` у `PalletSheetContext`) и пересобран.
  - Тесты: `readFileSync(new URL(…))` вместо `fileURLToPath` (jsdom); тест строгого переноса переписан на `rasterizeText(…, {overflow})`.
  - Три падения `forms-parity` лежали в основе ветки (исправление эталона `26572c386` пришло слиянием `a2be24573`); задача их не трогала.
- **Задача 2.**
  - Логотип не поднимает ревизию хоста и не идёт в ленту — по брифу и А4-6, вопреки тексту поручения; тест закрепляет неизменный `host_revision`. Станция видит новый логотип в снимке следующей смены.
  - ETag и sha256 нет; хост картинок не разбирает и принимает только пороговые биты (проверка картинки — в webview, задачи 1 и 5).
  - Отдельного предела тела нет: действует 2 МиБ axum по умолчанию; тестами закреплены самый большой логотип, 90 001 символ и тело 3 МиБ.
  - Отказ проверки в этом дереве — `400 validation_failed` с `details.field`, а не 422 брифа (так же в задачах 3 и 4).
  - Сверх плана: тесты поздней миграции — база с `0016` без `0013–0015` принимает пропущенную позже; база без `0016` принимает её и начинает без логотипа.
- **Задача 3.**
  - `PalletSheetDefaultUpdate.templateId` обязателен (nullable, `deserialize_with = "present"`): иначе `{}` молча сбрасывал основной лист.
  - Отказ `template_in_use` несёт отсортированные `shiftIds`; аудит основного листа — `update_details` (`{from,to}`).
  - Тест `template_in_use`, отложенный брифом в задачу 4, сделан здесь через SQL: запланированная смена блокирует удаление, активная и закрытая — нет, строка смены не переписывается.
  - Удаление неизвестного листа — `404` «no such sheet», надгробий нет.
  - Уникальности названий нет, как в брифе и миграции; предупреждение о повторе — в офисе (задача 5).
- **Задача 4.**
  - Нечитаемый макет листа или логотип на станции дают `null`, и смена открывается (бриф, А4-7), а не отказ, как в поручении; неверная форма (id не UUID, ревизия < 1 и т. п.) отвергается Zod как `shape`.
  - Лист, выключенный после планирования, замораживается как есть; отсутствующий в таблице — как «нет листа», без подмены основным.
  - Аудит `shift.create` называет лист только у смены с листом (бриф — всегда), чтобы строки остальных смен сохранили форму.
  - `test/forms-parity.test.ts` вне списка брифа: облачный фикстур без `palletSheetTemplateId` получил в схеме теста умолчание `null`; общий фикстур не тронут.
  - Сверх плана: тест предела снимка 327 680 байт с листом и самым большим логотипом (`snapshot_too_large`, смена не открывается).
  - `DELETE` логотипа отвечает `200 {logo: null}`. Миграций станции и оболочки не понадобилось: снимок хранится текстом в `floor_shifts.snapshot`.
- **Задача 5.**
  - Нативный `<input type=file>` и предел 2 МиБ брифа заменены `FileDropZone` (правило линтера) и защитами задачи 1 (4 МиБ); немедленный `put` при выборе — на выбор → предпросмотр пороговых битов → «Сохранить логотип». Полностью белый результат отвергается (`blank`).
  - Диалоги удаления и переименования закрываются только при успехе и показывают отказ внутри; отказ удаления называет смены ссылками (не больше десяти).
  - Повтор названий: `StatusChip` «Название повторяется», общий `Alert`, начало id в выборе смены.
  - «Основной лист организации» не предлагался смене, у которой уже есть лист (`ShiftUpdate` не умел `null`); снято исправлением `e40a9a141`.
  - Листы читаются только при включённых паллетах; `Table` принимает `getRowKey`; текст `failed` — «Запрос не выполнен…» вместо «хост не ответил».
  - Новые тексты писались через «палета»; сведены к «паллет» исправлением `8db996c1f`.
- **Задача 6.**
  - Сверх брифа: логотип идёт и в путь драйвера (`renderMonoLabel`, паритет с облаком).
  - `PreviewPane` получает логотип пропсом, а не хуком (15 тестов рендерят его без сессии); `labelLogo` получил необязательный `onFailure`; `useMemo` в `WorkScreen` убран.
  - Строка `LOGO_UNAVAILABLE_LINE` пишется в консоль webview, а не в журнал процесса.
  - `workShift` из брифа не существовал — добавлен в `test/support/floor-work.ts`.
  - Внесённая регрессия: `shiftLabelRender` всегда передавал `rasterizeText`, и страницы драйвера потеряли `rasterizeDriverText`. Исправление `0bde8ef5d`.
- **Задача 7.**
  - Бриф называл `test/hardware.test.ts` и `printDriverRaster`: тесты моста — в `test/windows-printing.test.ts`, метод — `printWindowsRaster`. Облачных `open_page`/`preflight_page` здесь нет: `Device::open` получил `Request`, `print` — `paper`.
  - Успех масштабированного вывода — `StretchDIBits > 0` (у этикетки `== h`); `SetStretchBltMode` — после `StartPage`, как в облаке.
  - Проверка размера DEVMODE вынесена в `devmode_fits`; размер объединённого DEVMODE проверяется только для листа; константы DEVMODE сверяются с `windows-sys` во время компиляции.
  - `Device` строится до проверки плана, чтобы `DeleteDC` выполнялся и при отказе.
  - Ветка Windows проверена только на типы пробным крейтом (`clippy` и `check` под `x86_64-pc-windows-msvc`).
- **Задача 8.**
  - Новые тестовые файлы вместо названных брифом (`floor-setup-a4`, `floor-pallet-sheet`, `floor-work-pallet-sheet`); помощник `sheetedShift`.
  - SSCC брифа с неверной контрольной цифрой заменён на `FIRST_SSCC`. Дата производства смены не бывает `null`; тест закрепляет, что день `closedAt` не рисуется.
  - Изготовитель пробного листа внедряемый (`a4Sheet`); пробная печать А4 — только вертикальный лист.
  - Вместо перечня cargo-сьютов шага 8 — один полный `cargo test --workspace`. §29 спецификации добавлен в конец (старшим на ветке был §28).
  - Инцидент процесса: при RED-прогоне исходники откатаны до копирования и восстановлены тем же скриптом правок; всё перепрогнано, `cmp` с зелёными копиями совпал.
- **Слияние с интеграцией (`8c3011c9c`).**
  - Конфликты в четырёх файлах разрешены объединением: `renderLabel(spec, fields, printer, rasterize?, logo = null, options = {})`, импорты `test/app.test.tsx`, `AGENTS.md`, разделы спецификации по порядку 24–31.
  - Тест поздней миграции обновлён под `0015` (СКЛ); добавлен тест: хост берёт `0015` и `0016` за один старт, поздние `0013`/`0014` ложатся поверх.
  - Стык I3 закрыт в коммите слияния. Складская перепечатка печатает логотип по правилу смены через вынесенный `renderLogoLabel`; источник — логотип из новейшего снимка смены этого подключения (`KNOWN_ORGANIZATION_SQL`), иначе Маркиро.
  - В `send` передаются режим и бумага принтера; смена режима ведёт к новому рендеру; страница драйвера рисуется `rasterizeDriverText`.
  - Принтер паллет с `paper === "a4"` даёт новый код `printer_a4` без рендера и отправки; текст «Принтер паллет настроен на листы А4…» и кнопка «Рабочее место».
  - 17 тестов в `warehouse-print-a4-logo.test.ts` и экранный тест; 16 мутантов, все пойманы.
  - Открыто: логотип перепечатки берётся из новейшего снимка подключения, а не смены этикетки; станция без смены после А4 печатает Маркиро; логотип, загруженный после открытия новейшей смены, не виден до следующей. Код `printer_a4` хост принимает, но фикстур его не закрепляет. Печать листа из снимка смены этикетки не сделана.
- **Счёт тестов.** Vitest: 154 файла, 4762 теста (задача 1; 4 падения вне задачи) → 4804 (задача 4) → 160/4930 (задача 5) → 163/4975 (задача 7) → 168/5041 (задача 8) → 169/5054 после волны исправлений; после слияния с интеграцией — 187/5555. `cargo test --workspace`: 1173 (задача 2), 1209 (задача 4), 1253 (задачи 7–8), 1257 после волны, 1447 после слияния.
- **Итоговое ревью.**
  - Критических нет, важных три (I1 — шрифт страниц драйвера, I2 — `null` у листа смены, I3 — складская перепечатка), мелких 14.
  - Волна из пяти коммитов:
    - `0bde8ef5d`: `shiftLabelRender` передаёт `deps.rasterize` без подмены, страницы драйвера снова рисуются `rasterizeDriverText` (I1);
    - `e40a9a141`: `ShiftUpdate.palletSheetTemplateId` — `Option<Option<String>>`, `null` = основной лист на момент правки; «Основной лист организации» предлагается всегда (I2);
    - `8db996c1f`: масштаб листа — `match` по 300/600/1200 dpi вместо деления; сверх правки комментария — предел исходной картинки 8192 × 4096 до `decode()` (код `too_many_pixels`); «палет» → «паллет» (названия готовых листов домена не тронуты); подсказка об основном листе (M1, M3, M4, M8);
    - `66d042c67`: ранбук и §29 — проверки логотипа на термоэтикетках, основной лист при сохранении, принтер А4 и смена без листа = `render_failed`, логотип в каждом снимке и `snapshot_too_large` (M2, M8, M9, M11);
    - `f82ba4b0f`: ожидание `load` только у картинки с пределом — первая версия `8db996c1f` вешала `floor-work-print` в полном прогоне.
  - I3 закрыт коммитом слияния `8c3011c9c`.
  - Перенесены владельцу или в поздние планы: `SetStretchBltMode` до `StartDocW` (M5); `StretchDIBits > 0` (M6); предел 20 с и освобождение очереди на 30 с при спуле ~1 МБ (M7); предупреждение «принтер А4 и смена без листа» (M9); выгрузки офиса во время загрузки логотипа (M10); объём байтов А4 в задании (M12); логотип в снимке только при надобности (M2); разбор заголовков картинки вместо опоры на ленивое декодирование WebView2; название листа на карточке смены; диагностика логотипа в журнале процесса; 64 px поля «Бумага»; смена с паллетами без своего листа при выборе «Основной лист» по-прежнему листа не получает.
