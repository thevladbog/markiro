# План ДЗГ-О: дезагрегация в офисе автонома — страницы документа и причин, «Акт дезагрегации» из `@markiro/domain`, XML «Расформирование упаковки» для ЧЗ — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** План ДЗГ даёт хосту документ дезагрегации: таблицы, проверку строк, проведение,
справочник причин и ленту `code_releases` для станций. Офисного интерфейса у него нет. После
этого плана:

- в разделе «Производство» есть страница «Дезагрегация»: список документов с фильтрами по
  статусу, причине, номеру и периоду;
- страница документа позволяет выбрать причину и комментарий, добавить SSCC вставкой или файлом
  `.txt`/`.csv`, видеть статусы строк, удалять строки, проводить документ (с подтверждением) и
  отменять его;
- есть страница «Причины дезагрегации»;
- «Акт дезагрегации» печатается в двух вариантах, как в облаке: только короба или короба с
  DataMatrix каждого кода. Рендерер облака переезжает в `packages/domain` побайтово;
- для проведённого документа офис формирует XML «Расформирование упаковки» (решение ПР-2). Генератор
  берётся из инвентаризации домена, файл сохраняется в «Документы\Markiro\Выгрузки», хост пишет
  строку аудита.

**Architecture:**

- **Домен (`packages/domain`):**
  - `apps/api/src/modules/disaggregation/report.ts` переезжает через `git mv` в
    `packages/domain/src/print-forms/disaggregation-report.ts`, как формы этапа 0. До переноса
    вывод фиксируется HTML-слепками, написанными тестом в API. API импортирует рендерер из
    `@markiro/domain`, тест рендера переезжает в домен;
  - два аддитивных изменения с умолчаниями, при которых вывод облака не меняется ни на байт:
    - параметр `timeZone = "UTC"`, как у `renderBoxReportHtml`;
    - необязательное поле `operationNote` (текст под «Результатом операции»);
  - из `generateInventoryDisaggregationXml` выделяется `renderGismtDisaggregationXml` в
    `src/gismt-disaggregation.ts`. Инвентаризация зовёт его, её эталон
    `docs/contracts/inventory-documents/v1/disaggregation.golden.xml` не меняется.
- **Протокол:** `DisaggregationReportRows` (данные акта), `DisaggregationReportVariant`,
  `DisaggregationExportRecord` с фикстурами, Zod и двумя методами `HostApi`. Версия протокола
  устройства **не растёт**: маршруты только офисные, станции их не видят.
- **Хост:** `routes/office_disaggregation_reports.rs`:
  - `GET /v1/office/disaggregation/{id}/report-data?variant=boxes|full` — только чтение, один
    снимок, каждый запрос по индексу. Коды берутся по тем же правилам, что у «Состава короба»
    (`office_reports.rs`);
  - `POST /v1/office/disaggregation/{id}/exports` — строка аудита `disaggregation.export`, как
    `shift.export`. Ревизия не меняется.
  - Миграции нет.
- **Офис:** раздел `src/office/disaggregation/*`:
  - страницы и разбор вставки и файла в webview по правилам облака;
  - акт рисуется через `render-form.ts` (новый вид формы `act`) и печатается через `print-form.ts`;
  - XML собирается доменом и сохраняется через `save_office_files`, затем пишется аудит.

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde) — `host`, `proto`; React 19.2, TypeScript 6 strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, i18next, `@tanstack/react-query`,
`@markiro/ui` (`PageHeader`, `FilterBar`, `Select`, `Input`, `DatePicker`, `Table`, `StatusChip`,
`RowActions`, `Card`, `Textarea`, `FileDropZone`, `ConfirmDialog`, `Modal`, `RadioGroup`, `Alert`,
`Button`), `@markiro/domain` (`renderDisaggregationReportHtml`, `renderGismtDisaggregationXml`,
`formatSsccHri`, `sanitizeShiftExportFilenameSegment`), Vitest 4 (jsdom, `toMatchFileSnapshot`),
NestJS 11 (только импорт в `apps/api`).

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` — §5.1 (ДЗГ), строки
  П-19 и П-20, решения ПР-1, ПР-2, ПР-3, §8.1 (ДЗГ-О после ДЗГ).
- План ДЗГ: `docs/superpowers/plans/2026-10-13-standalone-dzg-disaggregation.md`. Когда писался
  этот план, файла ещё не было, поэтому его интерфейсы здесь — допущения (Р1). Задача 0 их
  сверяет.
- `docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md` — образец переноса
  формы в домен со слепками.
- Облако, образец:
  - `apps/api/src/modules/disaggregation/report.ts` — рендер акта, переносится;
  - `apps/api/src/modules/disaggregation/disaggregation.service.ts:473-662` (`reportData`) —
    правила данных акта: строки с SSCC, коды живые или снятые этим разбором, у паллеты — её
    неразобранные короба;
  - `apps/api/src/modules/disaggregation/import-parser.ts` — разбор файла (`\r\n;,`, до 10 000);
  - `apps/api/src/modules/disaggregation/disaggregation.controller.ts:273-306` — файл до 1 МиБ, пустой
    файл — `file_empty`;
  - `apps/api/test/disaggregation-report.test.ts`, `disaggregation-import.test.ts`;
  - `apps/admin/src/pages/disaggregation/{index.tsx,DocumentDetail.tsx,ReasonsPage.tsx}` и
    `pages.disaggregation.*` в `apps/admin/src/i18n/ru.json` — тексты и поведение страниц;
  - `packages/domain/src/inventory/document-generators.ts:163-197` — XML `action_id="31"`.
- Автоном, образец:
  - `host/src/routes/office_reports.rs` — данные форм, снимок, `after_query`;
  - `host/src/routes/office_exports.rs:252-349` — запись выгрузки в аудит;
  - `src/office/forms/*`, `src/office/exports/{run-export.ts,office-files.ts,export-checks.ts}`.
- `apps/standalone/AGENTS.md`: «Audit», «Office pages», «Shift exports», «Shift card and printed
  forms», «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

- **Облачный акт.**
  - `apps/api/src/modules/disaggregation/report.ts:408` — `renderDisaggregationReportHtml(data)`,
    чистая функция. Импортирует из домена `renderCode128Svg` и `renderDataMatrixSvg` (`:1`).
  - Время печатается в UTC (`formatDateLong`, `formatDateTime`, `:81-89`).
  - В «Результате операции» есть фраза «Изменения агрегации передаются в ГИС МТ автоматически»
    (`:278`).
  - Импортёры: `disaggregation.controller.ts:72`, `disaggregation.service.ts:26-30` (типы),
    `apps/api/test/disaggregation-report.test.ts:2-6`; в `apps/api/src/pickup/slip.ts:138` —
    только комментарий.
- **Формы этапа 0 уже в домене:** `packages/domain/src/print-forms/{box-report,contents-report,pallet-report,pallet-placard,shift-task-form,task-form-chrome}.ts`.
  - Слепки лежат в `packages/domain/test/fixtures/print-forms/*.html` и проверяются
    `packages/domain/test/print-forms-snapshot.test.ts`.
  - Каталог исключён из Prettier (`.prettierignore:61-64`) и из проверок пробелов git
    (`.gitattributes`: `packages/domain/test/fixtures/print-forms/*.html -whitespace -text`).
  - Экспорт из домена — `packages/domain/src/index.ts:395-416`.
- **Генератор XML.**
  - `packages/domain/src/inventory/document-generators.ts:163` — `generateInventoryDisaggregationXml`:
    проверка метаданных, `isParticipantInn` (9, 10 или 12 цифр, `:302`), набор SSCC через
    `Set`, сортировка `compareText`, `validateSscc` (ровно 18 цифр, `:311`). При пустом наборе —
    файл нулевой длины (`emptyPart`).
  - Эталон — `docs/contracts/inventory-documents/v1/disaggregation.golden.xml`, его сверяет
    `packages/domain/test/inventory-document-generators.test.ts:420-430`.
- **Хост.**
  - `host/src/routes/office_reports.rs`: `BOX_ITEMS_SQL` идёт через `scans_shift` и `box_items`
    с правилом `i.displaced_at IS NULL AND (i.removed_at IS NULL OR i.removed_at =
b.disassembled_at)`. Каждый ответ читается одной откатываемой транзакцией с крючком
    `after_query`.
  - `host/src/routes/office_exports.rs:258` — `record_export`: проверки, `begin_write`,
    `require_session_in`, `audit::record` с `actions::SHIFT_EXPORT`, `204`. Ревизии нет.
  - `ORGANIZATION_SQL` (`:66`) — `SELECT name, inn FROM org_profile WHERE id = 1`.
  - Индексы: `boxes_pallet` (`0012_pallets.sql:46`), `scans_shift` (`0010_facts.sql:59`).
  - `ApiQuery` — `host/src/error.rs:214`.
  - Роли: только `admin` и `technologist`. `OfficeContext::require_shift_planning` и
    `require_catalog` пускают обе (`host/src/auth.rs:234-290`).
- **Офис.**
  - `src/office/nav.ts` — раздел `office.nav.sections.production`: «Линии», «Смены»,
    «Операторы», «Устройства».
  - `src/office/routes.tsx` — маршруты; `src/office/access.ts`:
    - `planShifts` — admin и technologist;
    - `editReference` — только admin.
  - `src/office/forms/render-form.ts` — `FormKind`, `FormRequest`, `prepareForm`, `formTimeZone`.
  - `src/office/forms/print-form.ts` — `printInFrame`, `formFolder`, `formFileName`,
    `openInBrowser`.
  - `src/office/forms/PrintFormDialog.tsx:92` — внутренняя `paint()`. Диалог привязан к смене
    (`shift: OfficeShift`).
  - `src/office/forms/form-data.ts:32` — `machineSscc` (`00` + 18 цифр); `reportOrg` даёт
    `logo: null` (вопрос пилота П15).
  - `src/office/exports/export-checks.ts:255` — `exportFolder(number, formatId, formedAt,
timeZone)` → `["Выгрузки", <номер>, <дата_время>_<формат>]`.
  - `src/office/exports/office-files.ts` — `OfficeFilesApi.save/open/openFile`.
  - Шелл: `src-tauri/src/office_files.rs:33` — корни `Выгрузки` и `Формы`; до 8 сегментов;
    расширения `csv`, `txt`, `xml`, `html` (`:61`).
  - Тестовая поддержка — `test/support/office.tsx` (`fakeHostApi`, `fakeOfficeSession`,
    `renderOffice`, `TECHNOLOGIST`, `ORG_PROFILE`) и `test/support/office-files.ts`
    (`fakeOfficeFiles`).
- **Дезагрегации в автономе нет** (спецификация §5.1): ни таблиц, ни маршрутов, ни страниц. Всё,
  что ниже названо «из ДЗГ», появляется планом ДЗГ.

## Решения владельца

- **ПР-1 (2026-10-13):** дезагрегация только по закрытым сменам, как в облаке. Правило
  `shift_open` проверяет хост (план ДЗГ). Офис показывает статус строки и не даёт провести
  документ, пока не все строки готовы.
- **ПР-2 (2026-10-13):** «да, в ДЗГ-О» — по документу делается XML «Расформирование упаковки» для
  ЧЗ. Облако его не делает. Эталон — вывод доменного генератора, а приём файла в ЛК ЧЗ проверяет
  владелец.
- **ПР-3 (2026-10-13):** причины — справочник офиса с причинами по умолчанию. Причины по
  умолчанию засевает миграция ДЗГ, этот план даёт страницу справочника.

## Допущения

- **Р1 — интерфейсы ДЗГ (предположение, сверяет задача 0).** План пишется параллельно с ДЗГ, и
  ниже — то, что ДЗГ должен дать по спецификации §5.1. Все имена этого плана опираются на этот
  список. Если в ДЗГ имена другие, исполнитель заменяет их по всему плану и записывает замену в
  «Отклонения», а смысл задач не меняется.

  - **Миграция хоста:** `0024_disaggregation.sql`: `disaggregation_reasons(id, name, sort_order, archived, rev)`, `disaggregation_doc_counters`, `disaggregation_documents(id, doc_no, status, reason_id, comment, source, created_by, created_at, applied_by, applied_at, cancelled_by, cancelled_at, rev)`, `disaggregation_document_lines(id, document_id, position, sscc_input, sscc, box_id, pallet_id, status, product_id, code_count, validated_at)`; индекс строк по `document_id`
  - **Номер документа:** `DSG-YY-NNNN`, как `formatDocNo` облака
  - **SSCC строки:** `sscc` — голые 18 цифр или `NULL`, если ввод не разобран
  - **Статусы:** документ: `draft`, `applied`, `cancelled`; строка: `ok`, `not_found`, `not_closed`, `shift_open`, `already_disassembled`, `duplicate` (без облачного `written_off`: выбытия нет)
  - **Проведение:** одна транзакция под замком фактов. Для короба `boxes.disassembled_at` и `box_items.removed_at` получают **одно и то же** время (так делает факт станции, `AGENTS.md`, «Shift card and printed forms»); у паллеты `pallets.disassembled_at`
  - **Маршруты:** `GET/POST /v1/office/disaggregation`, `GET/PUT /v1/office/disaggregation/{id}`, `POST …/{id}/lines`, `DELETE …/{id}/lines/{lineId}`, `POST …/{id}/apply`, `POST …/{id}/cancel`, `GET/POST /v1/office/disaggregation-reasons`, `PUT …/{id}`
  - **Права:** документы — `require_shift_planning` (admin, technologist); причины — `require_admin` (справочник, как контрагенты и линии); чтение — все офисные роли
  - **Proto:** `DisaggregationStatus` (с `FromStr`, как `ShiftStatus`), `DisaggregationLineStatus`, `DisaggregationDocument` (`id, docNo, status, reasonId, reasonName, comment, source, lineCount, codeCount, createdByName, createdAt, appliedAt, cancelledAt, rev`), `DisaggregationDocumentDetail` (то же + `lines`), `DisaggregationLine` (`id, ssccInput, sscc, boxId, palletId, status, productName, codeCount`), `DisaggregationReason` (`id, name, sortOrder, archived, rev`), запросы `DisaggregationDocumentCreate {reasonId, comment}`, `DisaggregationDocumentUpdate {reasonId, comment, expectedRev}`, `DisaggregationLinesAdd {ssccs, source}` (до 10 000), `DisaggregationApply {expectedRev}`, `DisaggregationCancel {expectedRev}`, `DisaggregationReasonCreate/Update`
  - **Zod и `HostApi`:** схемы `disaggregation*Schema` в `src/host/protocol.ts`; методы `listDisaggregationDocuments`, `getDisaggregationDocument`, `createDisaggregationDocument`, `updateDisaggregationDocument`, `addDisaggregationLines`, `deleteDisaggregationLine`, `applyDisaggregationDocument`, `cancelDisaggregationDocument`, `listDisaggregationReasons`, `createDisaggregationReason`, `updateDisaggregationReason`
  - **Аудит:** действия `disaggregation.create`, `.update`, `.apply`, `.cancel`, `disaggregation_reason.*`; `target_type` — `"disaggregation"`
  - **Отказ проведения:** `conflict` с `details.constraint = "lines_not_ready"`, если строка перестала быть `ok`; `stale_revision` при чужой правке

- **Р2 — акт переезжает в домен без правок, слепки пишет API до переноса.** Как этап 0: сначала
  тест в `apps/api/test` пишет HTML облачного `report.ts` в
  `packages/domain/test/fixtures/print-forms/disaggregation-act-*.html`. Каталог уже исключён из
  Prettier и проверок пробелов git. Потом `git mv` и импорты. Код переносится как есть, вместе с
  `!` облака, как перенесены формы этапа 0. Правило «без `!`» относится к новому коду автонома, не
  к перенесённому коду облака.
- **Р3 — время акта в часовом поясе организации.** Облако печатает UTC, но для подписываемого акта
  офиса автонома 06:30 вместо 09:30 по Москве — ошибка. Поэтому `renderDisaggregationReportHtml(data,
timeZone = "UTC")`, как `renderBoxReportHtml`. Облако параметр не передаёт и печатает те же байты,
  что до переноса: это проверяют слепки. Офис передаёт `formTimeZone(org)`.
- **Р4 — фраза об автоматической передаче в ГИС МТ.** Автоном ничего в ГИС МТ не передаёт: файл
  загружает человек. Акт с подписями не должен утверждать обратное. Поэтому у
  `DisaggregationReportData` появляется необязательное поле `operationNote?: string`: без него
  печатается прежний текст облака, с ним — переданный текст (экранированный). Домен экспортирует
  константу `DISAGGREGATION_MANUAL_UPLOAD_NOTE`:
  «SSCC расформированной упаковки повторно не используется. Файл «Расформирование упаковки» для
  ГИС МТ формируется в офисе и загружается в личный кабинет Честного знака вручную.»
  Офис передаёт её всегда (вопрос ДЗГО-2).
- **Р5 — логотипа на акте нет.** Как у всех форм офиса (`form-data.ts`, `reportOrg`, вопрос П15),
  `org.logo = null`, и печатается знак Маркиро. Логотип организации — вопрос ДЗГО-3, вместе с
  остальными формами.
- **Р6 — данные акта — отдельный маршрут хоста с вариантом.**
  - `GET …/{id}/report-data?variant=boxes|full`; без параметра — `boxes`, как
    `reportQuerySchema` облака. Только при `full` хост читает коды коробов и короба паллет:
    документ на 10 000 коробов не должен тащить сотни тысяч кодов ради короткого варианта.
  - Правила облачного `reportData`:
    - строки только с разобранным SSCC, по порядку добавления;
    - название товара — текущее;
    - у короба — коды, не вытесненные и не снятые, или снятые его разбором
      (`removed_at = disassembled_at`);
    - у паллеты — её короба без `disassembled_at`, по `closed_at, id`, у каждого живые единицы;
    - `codeCount` строки — сохранённый в строке.
  - Коды читаются **по сменам документа**: один проход по `scans_shift` на смену, а не на
    короб. Поэтому 100 коробов одной смены — один проход по её сканам, а не сто.
  - Читать могут все офисные роли, как остальные данные форм.
- **Р7 — XML: все SSCC проведённого документа, правило ИНН — генератора.**
  - В файл идут SSCC всех строк проведённого документа: и короба, и паллеты. Расформирование
    паллеты в ЧЗ — тоже `<packing>` с её кодом упаковки (вопрос ДЗГО-4).
  - Порядок и дубли решает генератор: `Set` и `compareText`, как в инвентаризации.
  - ИНН:
    - пустой ИНН в профиле — офис отказывает до формирования, тем же текстом, что выгрузка
      (`ORG_INN_MISSING`);
    - форму проверяет сам генератор (`isParticipantInn`: 9, 10 или 12 цифр). Хост хранит 10 или
      12 цифр, так что ИП с 12 цифрами файл получит: схема `trade_participant_inn` это
      допускает.
  - Это мягче правила XML агрегации смены, где ИНН ровно 10 цифр (`export-checks.ts`). Отличие
    сознательное: эталон — вывод генератора (вопрос ДЗГО-1).
- **Р8 — XML: папка, имя, запись.**
  - Папка: `Документы\Markiro\Выгрузки\Дезагрегация\<номер документа>\<дата_время>_disaggregation_xml_gismt`.
  - Имя файла: `disaggregation-<номер>.xml`.
  - Порядок: сначала файл сохраняется, потом `POST /v1/office/disaggregation/{id}/exports`
    (`formatId: "disaggregation_xml_gismt"`, `formatVersion: 1`, `packingCount`), как в выгрузках
    смены. Если запись не прошла, офис говорит об этом, предлагает «Записать снова», а файл
    остаётся.
  - Хост проверяет, что документ проведён (`conflict` `document_status`) и что `packingCount`
    равен числу разных SSCC документа (`validation_failed`). Строки проведённого документа не
    меняются, поэтому расхождение — ошибка офиса, а не гонка.
  - Аудит: `disaggregation.export`, цель `disaggregation`, детали — три поля записи. Ревизии нет.
- **Р9 — разбор ввода в webview, правила облака.**
  - Вставка: правило страницы облака — разделители `/[\s;,]+/` (`DocumentDetail.tsx`,
    `splitSsccInput`).
  - Файл: правило API — `/[\r\n;,]+/`, обрезка, пустые выбрасываются, дубли остаются (их
    показывает статус `duplicate`).
  - Больше 10 000 токенов — отказ `too_many_lines`, ноль токенов — `file_empty`.
  - Файл больше 1 МиБ (предел multer облака) не читается: `file_too_large`.
  - Расширение — `.txt` или `.csv` (`accept` у `FileDropZone`).
  - Текст читается `File.text()` (UTF-8, BOM снимается). Облако BOM не снимает
    (`buffer.toString("utf8")`), и первый токен файла из Excel получает невидимый символ U+FEFF и статус
    `not_found`. Здесь это сознательно исправлено, и тест это фиксирует.
  - Токены уходят одним запросом `addDisaggregationLines` с `source: "import"`.
- **Р10 — права в офисе.**
  - Документы (создать, править, строки, провести, отменить), печать акта и XML —
    `planShifts` (admin и technologist), как в ДЗГ.
  - Справочник причин правит только администратор (`editReference`). Технолог видит его только
    для чтения с текстом `office.common.readOnly`.
  - Маршруты этого плана (`report-data`, `exports`) открыты всем офисным ролям, как данные форм и
    запись выгрузки смены: и печать, и XML доступны обеим ролям.
  - Отказ проверяется так: устройство без офисной сессии получает `401`, технолог на странице
    причин не видит кнопок записи. Если ДЗГ дал технологу правку причин, офис следует хосту:
    `editCatalog` вместо `editReference`, запись в «Отклонения».
- **Р11 — список фильтруется в webview.** Документов на площадке — десятки в месяц. Хост отдаёт
  весь список (`listDisaggregationDocuments`), страница фильтрует и делит на страницы по 50, как
  «Смены» (`findShifts`, `OfficePager`):
  - период — по гражданской дате создания в часовом поясе организации (`civilToday(zone, new
Date(createdAt))`);
  - номер — подстрока без учёта регистра.

  Если ДЗГ отдаёт список с фильтрами хоста, страница всё равно фильтрует у себя: параметры
  запроса не нужны.

- **Р12 — без миграции и без версии протокола.** Хосту нужны только чтение и строка аудита. Номер
  миграции за ДЗГ-О не закреплён (распределение: «ДЗГ-О — нет»).

## Global Constraints

**Правила продукта**

- Только закрытые смены (ПР-1) — правило хоста из ДЗГ. Офис не обходит его и не проводит
  документ, пока есть строка не `ok`.
- Акт и XML — документы для ЧЗ и подписи:
  - вывод облака у перенесённого рендерера не меняется ни на байт (слепки);
  - XML побайтово равен выводу доменного генератора на том же наборе SSCC;
  - приём файла в ЛК ЧЗ проверяет владелец.
- Аудит: точные исполнитель, действие, цель, результат и разобранные детали. Отказ хоста
  (`validation_failed`, `conflict`, `not_found`) строку не пишет (`AGENTS.md`, «Audit»).
- Права: Р10. Отказ проверяется тестами (технолог — только чтение причин, без сессии — `401`).
- Офлайн: ничего не ходит в сеть. Акт — встроенный SVG и системный Arial, XML пишется на диск
  через шелл.

**Миграции и протокол (распределение 2026-10-13)**

- Миграции хоста, уже занятые открытыми ветками: `0017` сотрудники (fb-people), `0018` умолчания
  листов A4 (fb-templates), `0019` поиск кодов (fb-codesearch), `0020`–`0021` режимы смены (РЕЖ).
  Миграции оболочки: `0014`–`0015` (РЕЖ). В базе применены: хост `0001`–`0012`, `0015`, `0016`;
  оболочка `0001`–`0010`, `0012`, `0013`.
- Распределение волны 1 паритета: КНФ — хост `0022`, оболочка `0016`; ТОВ — хост `0023`; ДЗГ —
  хост `0024`, оболочка `0017`; ДЗГ-О — нет; КРТ — хост `0025`; ИСТ — хост `0026`. Неиспользованный
  номер остаётся пропуском. Перед задачей миграции исполнитель заново смотрит
  `ls apps/standalone/{host,src-tauri}/migrations` в `claude/integration` и открытых ветках
  `claude/fb-*`; если номер занят — берёт следующий свободный и пишет это в «Отклонения».
- Индексы на `scans` / `code_owners` — только миграциями после `0020`: РЕЖ (часть A) перестраивает
  обе таблицы и пересоздаёт только свои индексы и индексы поиска кодов. Запросы работают при
  `code_owners.box_id` = NULL (смены проверки).
- Протокол устройства: в базе `PROTOCOL_VERSION = 3`, РЕЖ берёт 4 и 5. Резерв на случай подъёма по
  правилу `proto/src/lib.rs:16-19` (новый вид факта или новое поле `data` факта; ответы терпят
  неизвестные поля): КНФ 6, ТОВ 7, ДЗГ 8, ИСТ 9. Без нужды не поднимать; при слиянии константа
  берёт наибольший номер.
- **ДЗГ-О миграций не добавляет и версию протокола не поднимает** (Р12). Запросы плана к `scans`
  идут через индекс `scans_shift` и `code_owners` не читают. РЕЖ пересоздаёт `scans_shift`:
  проверка `EXPLAIN QUERY PLAN` в задаче 4 ловит его возможное переименование.
- **Порядок:** план исполняется после слияния ДЗГ в `claude/integration`. Без ДЗГ задача 0
  останавливает исполнение и сообщает контроллеру. Задачи 1 и 2 (только домен) от ДЗГ не зависят
  и могут идти раньше.

**Код и процесс**

- План меняет `packages/domain` и `apps/api`. Это разрешено: таков перенос рендерера, как на
  этапе 0. В `apps/api` меняются только импорты и место теста, поведение API не меняется.
  `apps/admin`, `apps/station`, `apps/kiosk` не меняются.
- TypeScript strict: без `any`, приведений и `!` в новом коде; именованные экспорты,
  `import type`. В `packages/domain` относительные импорты — с суффиксом `.js`, импорт
  `@markiro/domain` внутри домена запрещён.
- Офис:
  - только `@markiro/ui`; мышь и клавиатура; видимый фокус; подписи у полей;
  - строки — только в `src/i18n/ru.json` (английского файла в `apps/standalone` нет);
  - формы на проводе — фикстуры `proto/fixtures`, их читают и Rust (`proto/tests/fixtures.rs`), и
    Vitest (`test/protocol.test.ts`).
- Rust: `cargo fmt` чистый, без предупреждений. `Cargo.toml`, `Cargo.lock`, `package.json`,
  `pnpm-lock.yaml` не меняются; `pnpm install/add` не запускать.
- Новые миграции — только новыми файлами (здесь их нет). Никогда `git stash`. Коммиты с явными
  путями, трейлер одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push и
  PR — не в этом плане.

## Заметки для исполнения

- Worktree от `claude/integration` после слияния ДЗГ. Зависимости — клоны APFS из
  `/tmp/claude/wt/integ`: `cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`,
  `apps/api/node_modules`, `packages/*/node_modules`, `packages/*/dist`; для cargo — ещё
  `apps/standalone/target`.
- Команды (`<wt>` — абсолютный путь worktree):
  - домен: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run <файлы>`,
    затем `… --filter @markiro/domain build` перед тестами API и автонома (они читают `dist`);
  - API: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run <файлы>`,
    плюс `typecheck`, `lint`, `build`;
  - автоном: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <файлы>`;
    полный прогон — `… --filter @markiro/standalone test`, `typecheck`, `lint`;
  - Rust: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-host --test office_disaggregation_reports`
    и `-p markiro-proto`. Имена крейтов сверить в `apps/standalone/{host,proto}/Cargo.toml`.
    `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`;
  - Prettier: `<wt>/node_modules/.bin/prettier --check <файлы>`; `git -C <wt> diff --check`.
- Слепки HTML пишет первый прогон. Проверочный прогон — с `CI=true`: тогда Vitest не дописывает
  недостающий слепок, а падает.
- Интеграционные тесты хоста на `TestApp` сокет не открывают. Песочница нужна только тестам с
  loopback.
- React-тесты страниц и диалогов (задачи 5–7) прогоняются дважды:
  - один раз с `--reporter=verbose`, без `stderr |`;
  - второй раз под стендом с задержкой `setImmediate` на 3 мс: временные
    `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ. После прогона
    их удалить.
- Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.

## Файлы

- **Создать:**
  - домен: `packages/domain/src/gismt-disaggregation.ts`,
    `packages/domain/test/{disaggregation-report-snapshot,gismt-disaggregation}.test.ts`,
    слепки `packages/domain/test/fixtures/print-forms/disaggregation-act-{boxes,full,draft,full-moscow}.html`;
  - API (временно, задача 1): `apps/api/test/disaggregation-report-snapshot.test.ts` (переезжает
    в домен);
  - хост: `apps/standalone/host/src/routes/office_disaggregation_reports.rs`,
    `apps/standalone/host/tests/office_disaggregation_reports.rs`;
  - фикстуры: `apps/standalone/proto/fixtures/{disaggregation-report-rows-boxes,disaggregation-report-rows-full,disaggregation-export-record}.json`;
  - офис: `apps/standalone/src/office/disaggregation/{DisaggregationPage.tsx,DisaggregationDocumentPage.tsx,DisaggregationReasonsPage.tsx,DisaggregationActDialog.tsx,DisaggregationXmlDialog.tsx,document-list.ts,disaggregation-text.ts,sscc-input.ts,act-data.ts,disaggregation-xml.ts}`;
  - тесты автонома: `apps/standalone/test/{disaggregation-page,disaggregation-document,disaggregation-reasons,disaggregation-act-dialog,disaggregation-xml-dialog}.test.tsx`,
    `apps/standalone/test/{sscc-input,document-list,disaggregation-act,disaggregation-xml}.test.ts`.
- **Переместить (`git mv`):**
  - `apps/api/src/modules/disaggregation/report.ts` → `packages/domain/src/print-forms/disaggregation-report.ts`;
  - `apps/api/test/disaggregation-report.test.ts` → `packages/domain/test/disaggregation-report.test.ts`;
  - `apps/api/test/disaggregation-report-snapshot.test.ts` → `packages/domain/test/disaggregation-report-snapshot.test.ts`.
- **Изменить:**
  - `packages/domain/src/index.ts`, `packages/domain/src/inventory/document-generators.ts`,
    `packages/domain/src/inventory/index.ts`;
  - `apps/api/src/modules/disaggregation/{disaggregation.controller.ts,disaggregation.service.ts}`,
    `apps/api/src/pickup/slip.ts` (комментарий);
  - `apps/standalone/proto/src/lib.rs`, `proto/tests/fixtures.rs`;
  - `apps/standalone/host/src/{audit.rs,server.rs}`, `host/src/routes/mod.rs`;
  - `apps/standalone/src/host/{protocol.ts,api.ts}`;
  - `apps/standalone/src/office/{nav.ts,routes.tsx,office-query.ts}`;
  - `apps/standalone/src/office/forms/{render-form.ts,print-form.ts,PrintFormDialog.tsx}`;
  - `apps/standalone/src/i18n/ru.json`;
  - тесты `apps/standalone/test/{protocol,api,prepare-form,print-form,operators-page,shifts-page}.test.ts(x)`
    и `test/support/office.tsx`;
  - `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`
    (отметка в §5.1).

---

## Задача 0: сверка с планом ДЗГ (без кода)

**Files:** только чтение; итог пишется в раздел «Отклонения при исполнении» этого файла.

- [ ] **Шаг 1: ДЗГ влит.** `git -C <wt> log --oneline claude/integration -- apps/standalone/host/migrations`
      показывает миграцию дезагрегации, а
      `rtk proxy grep -n "disaggregation" <wt>/apps/standalone/host/src/server.rs` — её маршруты.
      Если их нет, остановиться и сообщить контроллеру. Задачи 1 и 2 можно исполнить и до ДЗГ.
- [ ] **Шаг 2: сверить имена с планом ДЗГ.** Пройти список Р1 пункт за пунктом по
      `docs/superpowers/plans/2026-10-13-standalone-dzg-disaggregation.md` и по коду:
  - `rtk proxy grep -n "CREATE TABLE\|CREATE INDEX\|CREATE UNIQUE" <wt>/apps/standalone/host/migrations/0024_*.sql` —
    таблицы, столбцы и индекс строк по документу;
  - `rtk proxy grep -n "pub struct Disaggregation\|pub enum Disaggregation" <wt>/apps/standalone/proto/src/lib.rs` —
    типы и поля, `FromStr` у статуса;
  - `rtk proxy grep -n "Disaggregation" <wt>/apps/standalone/src/host/api.ts <wt>/apps/standalone/src/host/protocol.ts` —
    методы и схемы;
  - `rtk proxy grep -n "DISAGGREGATION" <wt>/apps/standalone/host/src/audit.rs` — действия и
    `target_type`;
  - `require_*` в маршрутах документов и причин — права (Р10);
  - время проведения: в транзакции проведения ДЗГ `boxes.disassembled_at` и
    `box_items.removed_at` получают одно значение. Если нет, то правило кодов
    акта (`removed_at = disassembled_at`) не находит снятых документом кодов. Тогда это дефект
    ДЗГ: сообщить контроллеру, а не обходить его здесь;
  - есть ли у `DisaggregationLinesAdd` поле `source` и какой у него предел. Если предел меньше
    10 000, импорт шлёт файл частями по пределу, по порядку, и после частичного сбоя говорит,
    сколько строк добавлено (запись в «Отклонения»).
- [ ] **Шаг 3:** записать в «Отклонения» таблицу «ожидалось → в ДЗГ» для каждого расхождения и
      заменить имена по всему плану перед задачей 3. Коммита нет.

## Задача 1: «Акт дезагрегации» в `@markiro/domain` — слепки, перенос, часовой пояс и примечание

**Files:** Create `apps/api/test/disaggregation-report-snapshot.test.ts` (затем `git mv` в
`packages/domain/test/`), слепки `packages/domain/test/fixtures/print-forms/disaggregation-act-{boxes,full,draft,full-moscow}.html`;
Move `apps/api/src/modules/disaggregation/report.ts` →
`packages/domain/src/print-forms/disaggregation-report.ts`, `apps/api/test/disaggregation-report.test.ts` →
`packages/domain/test/disaggregation-report.test.ts`; Modify `packages/domain/src/index.ts`,
`apps/api/src/modules/disaggregation/{disaggregation.controller.ts,disaggregation.service.ts}`,
`apps/api/src/pickup/slip.ts`.

**Interfaces** (домен, после задачи): типы облака `DisaggregationReportCode`,
`DisaggregationReportBox`, `DisaggregationReportLine`, `DisaggregationReportData` — без
изменений, кроме нового необязательного поля:

```ts
export interface DisaggregationReportData {
  // … the cloud's fields, unchanged …
  /**
   * The second sentence block under «Результат операции» (plan ДЗГ-О). Left out,
   * the cloud's own text is printed, byte for byte.
   */
  operationNote?: string;
}
/** The standalone's note: nothing is sent to ГИС МТ by itself there. */
export const DISAGGREGATION_MANUAL_UPLOAD_NOTE: string;
export function renderDisaggregationReportHtml(
  data: DisaggregationReportData,
  timeZone?: string, // "UTC" by default: the cloud's bytes
): string;
```

- [ ] **Шаг 1: слепки текущего вывода облака (тест в API, до переноса).** Создать
      `apps/api/test/disaggregation-report-snapshot.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import {
    renderDisaggregationReportHtml,
    type DisaggregationReportData,
  } from "../src/modules/disaggregation/report";

  /**
   * Characterisation lock for moving «Акт дезагрегации» into @markiro/domain
   * (docs/superpowers/plans/2026-10-13-standalone-dzg-o-disaggregation-office.md).
   * The files are written into the domain's print-forms fixtures, which are
   * kept out of Prettier and of git's whitespace checks; the move must not
   * change a byte of them. `apps/standalone/test/disaggregation-act.test.ts`
   * draws the host's rows of the same facts to the same bytes.
   */

  const SNAPSHOTS = "../../../packages/domain/test/fixtures/print-forms";
  /** GS (ASCII 0x1D), the real KM separator byte. */
  const GS = String.fromCharCode(0x1d);
  /** Check-digit-valid GTIN; `renderDataMatrixSvg` enforces the AI-01 mod-10. */
  const GTIN = "04600682000013";

  const km = (n: number) => ({
    gtin14: GTIN,
    serial: `S00000${n}`,
    rawKm: `01${GTIN}21S00000${n}${GS}93Tail${n}`,
  });

  /** One box (two codes) and one pallet (two boxes of 12), applied. */
  export const ACT_FULL: DisaggregationReportData = {
    docNo: "DSG-26-0007",
    status: "applied",
    createdAt: new Date("2026-10-12T09:12:00.000Z"),
    // 21:30 UTC is already the next day in Moscow: the zone's snapshot shows it.
    appliedAt: new Date("2026-10-12T21:30:00.000Z"),
    org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
    createdByName: "Павел Орлов",
    appliedByName: "Ирина Смирнова",
    reasonName: "Повреждение упаковки",
    comment: "Короба намокли при разгрузке",
    includeContents: true,
    lines: [
      {
        n: 1,
        sscc: "00146007034967000017",
        productName: "Вода «Атолл» 0,5 л",
        codeCount: 2,
        codes: [km(1), km(2)],
        boxes: [],
      },
      {
        n: 2,
        sscc: "00146007034967100014",
        productName: "Вода «Атолл» 0,5 л",
        codeCount: 24,
        codes: [],
        boxes: [
          { sscc: "00146007034967000024", codeCount: 12 },
          { sscc: "00146007034967000031", codeCount: 12 },
        ],
      },
    ],
  };

  export const ACT_BOXES: DisaggregationReportData = {
    ...ACT_FULL,
    includeContents: false,
    lines: ACT_FULL.lines.map((line) => ({ ...line, codes: [], boxes: [] })),
  };

  /** A draft without an organization, a reason or a comment; a code that cannot be drawn. */
  const ACT_DRAFT: DisaggregationReportData = {
    ...ACT_FULL,
    status: "draft",
    appliedAt: null,
    appliedByName: null,
    org: null,
    reasonName: null,
    comment: null,
    lines: [
      {
        n: 1,
        sscc: "00146007034967000017",
        productName: null,
        codeCount: 1,
        codes: [{ gtin14: GTIN, serial: "BROKEN", rawKm: "not-a-valid-km" }],
        boxes: [],
      },
      {
        n: 2,
        sscc: "00146007034967000048",
        productName: "Вода «Атолл» 0,5 л",
        codeCount: 0,
        codes: [],
        boxes: [],
      },
    ],
  };

  describe("disaggregation act characterisation lock", () => {
    it("boxes only", async () => {
      await expect(renderDisaggregationReportHtml(ACT_BOXES)).toMatchFileSnapshot(
        `${SNAPSHOTS}/disaggregation-act-boxes.html`,
      );
    });

    it("boxes and contents: a box's codes and a pallet's boxes", async () => {
      await expect(renderDisaggregationReportHtml(ACT_FULL)).toMatchFileSnapshot(
        `${SNAPSHOTS}/disaggregation-act-full.html`,
      );
    });

    it("a draft without an organization, with a broken code and an empty box", async () => {
      await expect(renderDisaggregationReportHtml(ACT_DRAFT)).toMatchFileSnapshot(
        `${SNAPSHOTS}/disaggregation-act-draft.html`,
      );
    });
  });
  ```

  Прогон без `CI` пишет три файла:
  `pnpm … --filter @markiro/api exec vitest run test/disaggregation-report-snapshot.test.ts`.
  Затем с `CI=true` — зелёный. Просмотреть файлы глазами: в `full` разметка
  `<span class="dm-box">` встречается дважды, а `<tr class="rep-code-row">` — четыре раза (два
  кода короба и два короба паллеты); в `draft` есть «Код не отображается» и «Содержимое упаковки
  недоступно». Коммит слепков и теста:
  `test(api): characterisation lock of «Акт дезагрегации» before its move into the domain`.

- [ ] **Шаг 2: перенос.**
  - `git mv apps/api/src/modules/disaggregation/report.ts packages/domain/src/print-forms/disaggregation-report.ts`.
  - В файле: `import { renderCode128Svg, renderDataMatrixSvg } from "../barcodes/svg.js";`
    вместо `@markiro/domain`. Строка `DisaggregationService.reportData` в комментарии к
    `DisaggregationReportData` дополняется словами «in apps/api» — больше ничего не менять.
  - `git mv apps/api/test/disaggregation-report.test.ts packages/domain/test/disaggregation-report.test.ts`;
    импорт — `../src/print-forms/disaggregation-report.js`.
  - `git mv apps/api/test/disaggregation-report-snapshot.test.ts packages/domain/test/disaggregation-report-snapshot.test.ts`;
    импорт — `../src/print-forms/disaggregation-report.js`, `SNAPSHOTS = "fixtures/print-forms"`.
  - `packages/domain/src/index.ts` после экспорта `taskFormChrome`:

    ```ts
    export {
      DISAGGREGATION_MANUAL_UPLOAD_NOTE,
      renderDisaggregationReportHtml,
    } from "./print-forms/disaggregation-report.js";
    export type {
      DisaggregationReportBox,
      DisaggregationReportCode,
      DisaggregationReportData,
      DisaggregationReportLine,
    } from "./print-forms/disaggregation-report.js";
    ```

    (`DISAGGREGATION_MANUAL_UPLOAD_NOTE` добавляется шагом 3; до него экспорт — без неё.)

  - API: `disaggregation.controller.ts:72` →
    `import { renderDisaggregationReportHtml } from "@markiro/domain";` (в существующий импорт
    домена, если он есть в файле: `CABINET_CAPABILITY` уже импортируется из `@markiro/domain` на
    `:34`). `disaggregation.service.ts:26-30` → `import type { DisaggregationReportBox,
DisaggregationReportCode, DisaggregationReportData } from "@markiro/domain";`.
  - `apps/api/src/pickup/slip.ts:138` — путь в комментарии:
    `packages/domain/src/print-forms/disaggregation-report.ts`.
  - Прогон: `… --filter @markiro/domain exec vitest run test/disaggregation-report.test.ts test/disaggregation-report-snapshot.test.ts`
    с `CI=true` — зелёный, байты слепков те же. Затем `… --filter @markiro/domain build`,
    `typecheck` и `lint` домена; в API `typecheck`, `lint`, `build` и
    `exec vitest run test/disaggregation-import.test.ts`. E2e дезагрегации без `DATABASE_URL`
    пропускаются явно: это записать в отчёт задачи.
  - `git diff --check`. Коммит:
    `refactor(domain): move «Акт дезагрегации» from apps/api into @markiro/domain print-forms, byte for byte`.

- [ ] **Шаг 3: красные тесты часового пояса и примечания** (в
      `packages/domain/test/disaggregation-report-snapshot.test.ts`):

  ```ts
  import {
    DISAGGREGATION_MANUAL_UPLOAD_NOTE,
    renderDisaggregationReportHtml,
    type DisaggregationReportData,
  } from "../src/print-forms/disaggregation-report.js";

  it("in the organization's zone with the standalone's note (plan ДЗГ-О)", async () => {
    await expect(
      renderDisaggregationReportHtml(
        { ...ACT_FULL, operationNote: DISAGGREGATION_MANUAL_UPLOAD_NOTE },
        "Europe/Moscow",
      ),
    ).toMatchFileSnapshot(`${SNAPSHOTS}/disaggregation-act-full-moscow.html`);
  });
  ```

  В `packages/domain/test/disaggregation-report.test.ts`:

  ```ts
  describe("the act's zone and note (plan ДЗГ-О)", () => {
    const applied = fixture({
      createdAt: new Date("2026-10-12T09:12:00.000Z"),
      appliedAt: new Date("2026-10-12T21:30:00.000Z"),
    });

    it("prints UTC by default, as the cloud does", () => {
      const html = renderDisaggregationReportHtml(applied);
      expect(html).toContain("от 12 октября 2026 г.");
      expect(html).toContain("12.10.2026 21:30");
    });

    it("prints the organization's day and time when given its zone", () => {
      const html = renderDisaggregationReportHtml(applied, "Europe/Moscow");
      expect(html).toContain("от 13 октября 2026 г.");
      // h23: a minute past midnight is 00:30, never 24:30.
      expect(html).toContain("13.10.2026 00:30");
    });

    it("keeps the cloud's sentence without a note and escapes a given one", () => {
      expect(renderDisaggregationReportHtml(applied)).toContain(
        "Изменения агрегации передаются в ГИС МТ автоматически.",
      );
      const html = renderDisaggregationReportHtml({ ...applied, operationNote: "<b>вручную</b>" });
      expect(html).not.toContain("передаются в ГИС МТ автоматически");
      expect(html).toContain("&lt;b&gt;вручную&lt;/b&gt;");
    });
  });
  ```

  Прогон: `… --filter @markiro/domain exec vitest run test/disaggregation-report.test.ts test/disaggregation-report-snapshot.test.ts` —
  красный (нет экспорта, нет параметра).

- [ ] **Шаг 4: реализация.** В `disaggregation-report.ts`:

  ```ts
  /**
   * The standalone's second sentence under «Результат операции» (plan ДЗГ-О):
   * «Markiro Автоном» sends nothing to ГИС МТ itself; the office forms the
   * «Расформирование упаковки» file and a person uploads it.
   */
  export const DISAGGREGATION_MANUAL_UPLOAD_NOTE =
    "SSCC расформированной упаковки повторно не используется. Файл «Расформирование упаковки» для ГИС МТ формируется в офисе и загружается в личный кабинет Честного знака вручную.";

  /** The calendar fields of `d` in `timeZone`; "UTC" gives the getUTC* fields the cloud printed. */
  function zonedParts(d: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(d);
    const field = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    return {
      year: field("year"),
      month: field("month"),
      day: field("day"),
      hour: field("hour"),
      minute: field("minute"),
    };
  }

  /** "23 июля 2026 г." in `timeZone` (UTC by default: the cloud's bytes). */
  function formatDateLong(d: Date, timeZone: string): string {
    const p = zonedParts(d, timeZone);
    return `${p.day} ${MONTHS_RU[p.month - 1]} ${p.year} г.`;
  }

  /** "23.07.2026 14:05" in `timeZone` (see formatDateLong). */
  function formatDateTime(d: Date, timeZone: string): string {
    const p = zonedParts(d, timeZone);
    return `${pad2(p.day)}.${pad2(p.month)}.${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
  }
  ```

  - `metadataBlock(data, timeZone)` и `renderDisaggregationReportHtml(data, timeZone = "UTC")`
    передают зону в обе функции.
  - В `finalBlocks` строка `rep-operation-note`:

  ```ts
  const operationNote =
    data.operationNote === undefined
      ? "SSCC расформированной упаковки повторно не используется. Изменения агрегации передаются в ГИС МТ автоматически."
      : escapeHtml(data.operationNote);
  // …
  `<span class="rep-operation-note">${operationNote}</span>`;
  ```

  Текст по умолчанию копируется из текущей строки символ в символ. Слепки трёх файлов шага 1 это
  проверяют.

  Прогон с `CI=true` после первого прогона, который пишет `disaggregation-act-full-moscow.html`:
  все четыре слепка зелёные. Просмотреть новый слепок: в шапке «от 13 октября 2026 г.», в
  метаданных «13.10.2026 00:30», внизу текст константы. Затем домен `test`, `typecheck`, `lint`,
  `build`, API `typecheck` и `build`.

- [ ] **Шаг 5: коммит**
      `feat(domain): «Акт дезагрегации» in a given time zone and with an optional operation note (UTC and the cloud's text by default)`.

## Задача 2: домен — `renderGismtDisaggregationXml`, общий для инвентаризации и автонома

**Files:** Create `packages/domain/src/gismt-disaggregation.ts`,
`packages/domain/test/gismt-disaggregation.test.ts`; Modify
`packages/domain/src/inventory/document-generators.ts`, `packages/domain/src/inventory/index.ts`,
`packages/domain/src/index.ts`.

**Interfaces** (`src/gismt-disaggregation.ts`; тела — в шаге 2): `GismtDisaggregationError`
с кодом `INVALID_ORGANIZATION_INN | INVALID_SSCC | EMPTY_SOURCE`,
`GismtDisaggregationInput { organizationInn; ssccs: readonly string[] }` (голые 18 цифр, дубли
допустимы), `RenderedGismtDisaggregation { bytes; physicalLineCount; packingCount }`,
`renderGismtDisaggregationXml(input)`, перенесённый сюда `isParticipantInn` (инвентаризация
реэкспортирует его).

- [ ] **Шаг 1: красные тесты** (`packages/domain/test/gismt-disaggregation.test.ts`):

  ```ts
  import { readFileSync } from "node:fs";
  import { describe, expect, it } from "vitest";

  import {
    GismtDisaggregationError,
    renderGismtDisaggregationXml,
  } from "../src/gismt-disaggregation.js";

  const decoder = new TextDecoder();
  const golden = readFileSync(
    new URL(
      "../../../docs/contracts/inventory-documents/v1/disaggregation.golden.xml",
      import.meta.url,
    ),
    "utf8",
  );

  describe("ГИС МТ «Расформирование упаковки»", () => {
    it("is the inventory's golden for its one package", () => {
      const rendered = renderGismtDisaggregationXml({
        organizationInn: "9705119097",
        ssccs: ["046800899000256032"],
      });
      expect(decoder.decode(rendered.bytes)).toBe(golden);
      expect(rendered).toMatchObject({ physicalLineCount: 9, packingCount: 1 });
    });

    it("names each package once, sorted as the inventory sorts them", () => {
      const text = decoder.decode(
        renderGismtDisaggregationXml({
          organizationInn: "781234567890",
          ssccs: ["146007034967100014", "146007034967000017", "146007034967100014"],
        }).bytes,
      );
      expect(text.match(/<packing>/g)).toHaveLength(2);
      expect(text.indexOf("146007034967000017")).toBeLessThan(text.indexOf("146007034967100014"));
      expect(text).toContain("<trade_participant_inn>781234567890</trade_participant_inn>");
    });

    it.each([
      [
        { organizationInn: "0000000000", ssccs: ["146007034967000017"] },
        "INVALID_ORGANIZATION_INN",
      ],
      [{ organizationInn: "7701234567", ssccs: ["00146007034967000017"] }, "INVALID_SSCC"],
      [{ organizationInn: "7701234567", ssccs: [] }, "EMPTY_SOURCE"],
    ] as const)("refuses %j with %s", (input, code) => {
      expect(() => renderGismtDisaggregationXml(input)).toThrow(new GismtDisaggregationError(code));
    });
  });
  ```

  Прогон `… --filter @markiro/domain exec vitest run test/gismt-disaggregation.test.ts` — красный.

- [ ] **Шаг 2: реализация** `packages/domain/src/gismt-disaggregation.ts`:

  ```ts
  import { compareText } from "./document-text-encoding.js";

  /**
   * ГИС МТ «Расформирование упаковки» (`<disaggregation action_id="31" version="2">`):
   * the bytes the inventory's `inventory_xml_gismt_disaggregation` writes, now
   * shared with the standalone office's disaggregation document (plan ДЗГ-О).
   * One `<packing>` a package, its code the bare 18-digit SSCC in CDATA, each
   * once, sorted by `compareText`. No valid empty document exists for this
   * schema (`packing` is `minOccurs="1"`), so an empty set is refused; the
   * inventory writes its zero-byte part before it calls this.
   */

  export type GismtDisaggregationErrorCode =
    "INVALID_ORGANIZATION_INN" | "INVALID_SSCC" | "EMPTY_SOURCE";

  export class GismtDisaggregationError extends Error {
    constructor(readonly code: GismtDisaggregationErrorCode) {
      super(code);
      this.name = "GismtDisaggregationError";
    }
  }

  export interface GismtDisaggregationInput {
    organizationInn: string;
    ssccs: readonly string[];
  }

  export interface RenderedGismtDisaggregation {
    bytes: Uint8Array;
    physicalLineCount: number;
    packingCount: number;
  }

  const encoder = new TextEncoder();

  /**
   * Shared "is this shaped like a usable organization/participant INN" predicate.
   * (comment moved verbatim from inventory/document-generators.ts)
   */
  export function isParticipantInn(value: string): boolean {
    return /^\d{9}$/.test(value) || /^(?:\d[1-9]|[1-9]\d)(?:\d{8}|\d{10})$/.test(value);
  }

  export function renderGismtDisaggregationXml(
    input: GismtDisaggregationInput,
  ): RenderedGismtDisaggregation {
    if (!isParticipantInn(input.organizationInn)) {
      throw new GismtDisaggregationError("INVALID_ORGANIZATION_INN");
    }
    const packings = [...new Set(input.ssccs)].sort(compareText);
    if (packings.some((sscc) => !/^\d{18}$/.test(sscc))) {
      throw new GismtDisaggregationError("INVALID_SSCC");
    }
    if (packings.length === 0) throw new GismtDisaggregationError("EMPTY_SOURCE");
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<disaggregation action_id="31" version="2">',
      `    <trade_participant_inn>${input.organizationInn}</trade_participant_inn>`,
      "    <packings_list>",
      ...packings.flatMap((sscc) => [
        "        <packing>",
        `            <kitu><![CDATA[${sscc}]]></kitu>`,
        "        </packing>",
      ]),
      "    </packings_list>",
      "</disaggregation>",
    ];
    return {
      bytes: encoder.encode(`${lines.join("\n")}\n`),
      physicalLineCount: lines.length,
      packingCount: packings.length,
    };
  }
  ```

  `inventory/document-generators.ts`:
  - `isParticipantInn` удаляется, вместо него
    `export { isParticipantInn } from "../gismt-disaggregation.js";` и импорт для внутреннего
    вызова;
  - конец `generateInventoryDisaggregationXml` после `if (boxes.length === 0) return [emptyPart(filename)];`:

  ```ts
  const rendered = renderGismtDisaggregationXml({
    organizationInn: metadata.organizationInn,
    ssccs: boxes,
  });
  return [
    {
      partNumber: 1,
      filename,
      mimeType: XML_MIME_TYPE,
      bytes: rendered.bytes,
      rowCount: rendered.physicalLineCount,
      codeCount: 0,
      boxCount: rendered.packingCount,
    },
  ];
  ```

  Своя проверка ИНН и `validateSscc` в генераторе инвентаризации остаются перед вызовом. Поэтому
  ошибки инвентаризации прежние (`InventoryDocumentGenerationError`), а общий рендер на её данных
  не бросает. `inventory/index.ts` и корневой `index.ts` продолжают экспортировать
  `isParticipantInn` как раньше. Корневой `index.ts` дополнительно экспортирует
  `renderGismtDisaggregationXml`, `GismtDisaggregationError` и типы.

- [ ] **Шаг 3: зелёные тесты:** новый файл и без изменений
      `test/inventory-document-generators.test.ts`, `test/inventory-documents.test.ts`. Эталон
      `disaggregation.golden.xml` проверяется тем же тестом инвентаризации, что и до правки, это
      и есть побайтовая проверка пути инвентаризации. Затем домен `test`, `typecheck`, `lint`,
      `build`; потребитель `isParticipantInn` в API
      (`apps/api/src/modules/inventories/inventory-documents.service.ts:13`) — `typecheck` API.
- [ ] **Шаг 4: коммит**
      `refactor(domain): share the ГИС МТ disaggregation XML renderer between the inventory and the standalone`.

## Задача 3: протокол — данные акта, вариант, запись XML; Zod и `HostApi`

**Files:** Modify `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`,
`apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`,
`apps/standalone/test/protocol.test.ts`, `apps/standalone/test/api.test.ts`,
`apps/standalone/test/support/office.tsx`; Create фикстуры
`proto/fixtures/{disaggregation-report-rows-boxes,disaggregation-report-rows-full,disaggregation-export-record}.json`.

**Interfaces (Rust, `proto/src/lib.rs`, после типов ДЗГ):**

```rust
/// What `GET /v1/office/disaggregation/{id}/report-data` reads (plan ДЗГ-О):
/// `boxes` only the lines, `full` also each box's codes and each pallet's
/// boxes, as the cloud's `variant=boxes|full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationReportVariant {
    Boxes,
    Full,
}

/// `GET /v1/office/disaggregation/{id}/report-data` (plan ДЗГ-О): what
/// «Акт дезагрегации» prints of a document, in one snapshot of the host, by
/// the rules of the cloud's `DisaggregationService.reportData`: the lines
/// with an SSCC, in the order they were added; a line's `codeCount` as the
/// line keeps it; the product's name now; the names of the office users who
/// made and applied it. `items` and `boxes` are filled only for `full`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportRows {
    pub id: String,
    pub doc_no: String,
    pub status: DisaggregationStatus,
    pub created_at: String,
    pub applied_at: Option<String>,
    pub created_by_name: Option<String>,
    pub applied_by_name: Option<String>,
    pub reason_name: Option<String>,
    pub comment: Option<String>,
    pub organization: ExportOrganization,
    pub variant: DisaggregationReportVariant,
    pub lines: Vec<DisaggregationReportLine>,
}

/// A line of [`DisaggregationReportRows`]: `sscc` the bare 18 digits; a box's
/// line names its box, a pallet's its pallet, a line of no box or pallet
/// (`not_found`) neither. For `full`, a box's `items` are its codes not
/// displaced and not taken out, or taken out by its own disassembly (the
/// rule of «Состав короба»), by GTIN and serial; a pallet's `boxes` the boxes
/// standing on it not taken apart, closed first, with their live units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportLine {
    pub id: String,
    pub sscc: String,
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    pub product_name: Option<String>,
    pub code_count: u32,
    pub items: Vec<BoxReportItem>,
    pub boxes: Vec<DisaggregationReportBox>,
}

/// A box standing on a pallet of the act: its bare SSCC and live units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportBox {
    pub sscc: Option<String>,
    pub units: u32,
}

/// The one ЧЗ file a disaggregation document has (plan ДЗГ-О, owner decision
/// ПР-2): ГИС МТ «Расформирование упаковки», `@markiro/domain`'s
/// `renderGismtDisaggregationXml`.
pub const DISAGGREGATION_XML_FORMAT_ID: &str = "disaggregation_xml_gismt";
pub const DISAGGREGATION_XML_FORMAT_VERSION: u32 = 1;

/// `POST /v1/office/disaggregation/{id}/exports` (plan ДЗГ-О): the office
/// saved the document's ЧЗ file and records it, as `ShiftExportRecord` does
/// for a shift; `packingCount` the packages the file names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationExportRecord {
    pub format_id: String,
    pub format_version: u32,
    pub packing_count: u32,
}
```

Имя `DisaggregationReportLine` может столкнуться с типом ДЗГ. Если у ДЗГ уже есть такое имя
(задача 0), здесь берётся `DisaggregationReportLineRows`.

**Interfaces (TS, `src/host/protocol.ts`):**

```ts
const bareSsccSchema = z.string().regex(/^\d{18}$/u);

export const disaggregationReportVariantSchema = z.enum(["boxes", "full"]);
export type DisaggregationReportVariant = z.infer<typeof disaggregationReportVariantSchema>;

/** Mirrors `markiro_proto::DisaggregationReportRows` (plan ДЗГ-О). */
export const disaggregationReportRowsSchema = z.object({
  id: z.uuid(),
  docNo: z.string().min(1),
  status: disaggregationStatusSchema, // plan ДЗГ
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
  createdByName: z.string().nullable(),
  appliedByName: z.string().nullable(),
  reasonName: z.string().nullable(),
  comment: z.string().nullable(),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  variant: disaggregationReportVariantSchema,
  lines: z.array(
    z.object({
      id: z.uuid(),
      sscc: bareSsccSchema,
      boxId: z.string().nullable(),
      palletId: z.string().nullable(),
      productName: z.string().nullable(),
      codeCount: z.number().int().min(0),
      items: z.array(z.object({ gtin14: z.string(), serial: z.string(), canonical: z.string() })),
      boxes: z.array(z.object({ sscc: bareSsccSchema.nullable(), units: z.number().int().min(0) })),
    }),
  ),
});
export type DisaggregationReportRows = z.infer<typeof disaggregationReportRowsSchema>;

export const DISAGGREGATION_XML_FORMAT_ID = "disaggregation_xml_gismt";
export const DISAGGREGATION_XML_FORMAT_VERSION = 1;

export const disaggregationExportRecordSchema = z
  .object({
    formatId: z.literal(DISAGGREGATION_XML_FORMAT_ID),
    formatVersion: z.literal(DISAGGREGATION_XML_FORMAT_VERSION),
    packingCount: z.number().int().min(1),
  })
  .strict();
export type DisaggregationExportRecord = z.infer<typeof disaggregationExportRecordSchema>;
```

`HostApi`:

```ts
/** What «Акт дезагрегации» prints of the document, in one snapshot (plan ДЗГ-О); every office role. */
getDisaggregationReportRows: (token: string, id: string, variant: DisaggregationReportVariant) =>
  Promise<DisaggregationReportRows>;
/** `204`: the document's ЧЗ file is saved; the host writes its `disaggregation.export` row. */
recordDisaggregationExport: (token: string, id: string, record: DisaggregationExportRecord) =>
  Promise<void>;
```

Реализация — по образцу `getBoxReportRows` и `recordShiftExport` (`src/host/api.ts:677-693`).
Путь — `/v1/office/disaggregation/${id}/report-data?variant=${variant}`; `variant` — значение
перечисления, кодировать не нужно. `test/support/office.tsx` (`fakeHostApi`) получает оба метода
со стандартным `unexpected(...)`.

- [ ] **Шаг 1: фикстуры.**

  `disaggregation-report-rows-full.json` — те же факты, что `ACT_FULL` задачи 1. SSCC без `00`,
  время хоста — целые секунды без миллисекунд (`clock::format_timestamp`):

  ```json
  {
    "id": "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
    "docNo": "DSG-26-0007",
    "status": "applied",
    "createdAt": "2026-10-12T09:12:00Z",
    "appliedAt": "2026-10-12T21:30:00Z",
    "createdByName": "Павел Орлов",
    "appliedByName": "Ирина Смирнова",
    "reasonName": "Повреждение упаковки",
    "comment": "Короба намокли при разгрузке",
    "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
    "variant": "full",
    "lines": [
      {
        "id": "7d1e2f3a-4b5c-4d6e-8f70-0000000000a1",
        "sscc": "146007034967000017",
        "boxId": "b0000000-0000-4000-8000-000000000001",
        "palletId": null,
        "productName": "Вода «Атолл» 0,5 л",
        "codeCount": 2,
        "items": [
          {
            "gtin14": "04600682000013",
            "serial": "S000001",
            "canonical": "010460068200001321S000001\u001d93Tail1"
          },
          {
            "gtin14": "04600682000013",
            "serial": "S000002",
            "canonical": "010460068200001321S000002\u001d93Tail2"
          }
        ],
        "boxes": []
      },
      {
        "id": "7d1e2f3a-4b5c-4d6e-8f70-0000000000a2",
        "sscc": "146007034967100014",
        "boxId": null,
        "palletId": "a0000000-0000-4000-8000-000000000001",
        "productName": "Вода «Атолл» 0,5 л",
        "codeCount": 24,
        "items": [],
        "boxes": [
          { "sscc": "146007034967000024", "units": 12 },
          { "sscc": "146007034967000031", "units": 12 }
        ]
      }
    ]
  }
  ```

  `disaggregation-report-rows-boxes.json` — то же, `"variant": "boxes"`, у обеих строк
  `"items": []` и `"boxes": []`. `disaggregation-export-record.json` —
  `{ "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": 2 }`.

- [ ] **Шаг 2: красные тесты.**

  Rust (`proto/tests/fixtures.rs`):

  ```rust
  #[test]
  fn disaggregation_report_fixtures_round_trip() {
      let full: DisaggregationReportRows = round_trip("disaggregation-report-rows-full.json");
      assert_eq!(full.variant, DisaggregationReportVariant::Full);
      assert_eq!(full.lines[0].items.len(), 2);
      assert_eq!(full.lines[1].boxes.len(), 2);
      let boxes: DisaggregationReportRows = round_trip("disaggregation-report-rows-boxes.json");
      assert!(boxes.lines.iter().all(|line| line.items.is_empty() && line.boxes.is_empty()));
      let record: DisaggregationExportRecord = round_trip("disaggregation-export-record.json");
      assert_eq!(record.format_id, DISAGGREGATION_XML_FORMAT_ID);
      assert_eq!(record.format_version, DISAGGREGATION_XML_FORMAT_VERSION);
  }

  #[test]
  fn a_disaggregation_export_record_refuses_an_unknown_field() {
      let mut record = fixture("disaggregation-export-record.json");
      record["fileName"] = serde_json::json!("disaggregation-DSG-26-0007.xml");
      assert!(serde_json::from_value::<DisaggregationExportRecord>(record).is_err());
  }

  #[test]
  fn the_report_variant_reads_as_the_cloud_writes_it() {
      for (text, variant) in [
          ("\"boxes\"", DisaggregationReportVariant::Boxes),
          ("\"full\"", DisaggregationReportVariant::Full),
      ] {
          assert_eq!(serde_json::from_str::<DisaggregationReportVariant>(text).unwrap(), variant);
      }
  }
  ```

  Vitest (`test/protocol.test.ts`):

  ```ts
  describe("disaggregation act and file (plan ДЗГ-О)", () => {
    it("parses the host's rows of both variants", () => {
      const full = disaggregationReportRowsSchema.parse(
        fixture("disaggregation-report-rows-full.json"),
      );
      expect(full.lines.map((line) => line.items.length)).toEqual([2, 0]);
      expect(full.lines[1]?.boxes).toEqual([
        { sscc: "146007034967000024", units: 12 },
        { sscc: "146007034967000031", units: 12 },
      ]);
      expect(
        disaggregationReportRowsSchema.parse(fixture("disaggregation-report-rows-boxes.json"))
          .variant,
      ).toBe("boxes");
    });

    it("refuses an SSCC with its AI and a record of another format or an extra field", () => {
      const rows = disaggregationReportRowsSchema.parse(
        fixture("disaggregation-report-rows-boxes.json"),
      );
      const [first] = rows.lines;
      expect(first).toBeDefined();
      if (first === undefined) return;
      const changed = disaggregationReportRowsSchema.safeParse({
        ...rows,
        lines: [{ ...first, sscc: `00${first.sscc}` }],
      });
      expect(changed.success).toBe(false);
      const record = disaggregationExportRecordSchema.parse(
        fixture("disaggregation-export-record.json"),
      );
      expect(
        disaggregationExportRecordSchema.safeParse({
          ...record,
          formatId: "shift_xml_gismt_aggregation",
        }).success,
      ).toBe(false);
      expect(
        disaggregationExportRecordSchema.safeParse({ ...record, fileName: "x.xml" }).success,
      ).toBe(false);
    });
  });
  ```

  `test/api.test.ts` — по образцу тестов `getBoxReportRows` и `recordShiftExport`:
  - `getDisaggregationReportRows(token, id, "full")` шлёт `GET
/v1/office/disaggregation/<id>/report-data?variant=full` с офисным токеном;
  - `recordDisaggregationExport` шлёт `POST …/exports` с телом и принимает `204`.

  Прогон (должен упасть):
  - `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-proto`;
  - `pnpm … --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`.

- [ ] **Шаг 3: реализация** по интерфейсам выше; типы импортируются в `fixtures.rs` в общий
      `use markiro_proto::{…}`.
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, prettier, коммит**
      `feat(standalone): the wire of the disaggregation act's data and of its ЧЗ file's record`.

## Задача 4: хост — данные акта и запись XML

**Files:** Create `apps/standalone/host/src/routes/office_disaggregation_reports.rs`,
`apps/standalone/host/tests/office_disaggregation_reports.rs`; Modify
`apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`,
`apps/standalone/host/src/audit.rs`.

**Interfaces:** `audit::actions::DISAGGREGATION_EXPORT = "disaggregation.export"`; в
`routes/office_disaggregation_reports.rs` — константы запросов `DOCUMENT_SQL`, `LINES_SQL`,
`LINE_SHIFTS_SQL`, `SHIFT_ITEMS_SQL`, `PALLET_BOXES_SQL`, `PACKINGS_SQL` (публичные — их читает
тест `EXPLAIN QUERY PLAN`), `ReportQuery`, обработчики `report_data` и `record_export`,
`read_report_rows(pool, id, variant, after_query)`. Сигнатуры и тела — в шаге 2.

- [ ] **Шаг 1: красные тесты** (`host/tests/office_disaggregation_reports.rs`). Подготовка
      смены — как в `host/tests/office_reports.rs` (`admin`, `shift_setup`, `open_floor`,
      `open_pallet_floor`, `issue_block`, `issue_pallet_block`, `fact`, `ok_scan`, `box_closed`,
      `pallet_closed`, `shift_closed`, `receipts`). Документ создаётся маршрутами ДЗГ (тела —
      по задаче 0). Если ДЗГ добавил помощники в `support/app.rs` (например,
      `disaggregation_document`), взять их.

  ```rust
  mod support;

  use axum::http::StatusCode;
  use serde_json::{json, Value};
  use support::app::{
      admin, box_closed, box_id, code, fact, instant, issue_block, ok_scan, open_floor,
      receipts, record_id, shift_closed, shift_setup, sscc, Admin, Floor,
  };

  const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

  /// A closed shift: box 1 holds codes 3, 1 and 2, box 2 holds code 4; the
  /// station closed the shift. Returns the floor.
  async fn closed_shift(admin: &Admin) -> Floor {
      let setup = shift_setup(admin).await;
      let floor = open_floor(admin, &setup, &admin.key.clone(), &setup.line).await;
      let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
      let shift = floor.shift.clone();
      let scan = |record: u32, n: u32, b: u32, second: u32| {
          fact(&record_id(record), "scan", &shift, ok_scan(n, &box_id(b), &instant(second, 0)))
      };
      let answered = receipts(
          &admin.app,
          &floor.key,
          &[
              scan(1, 3, 1, 10),
              scan(2, 1, 1, 11),
              scan(3, 2, 1, 12),
              fact(&record_id(4), "box_closed", &shift,
                  box_closed(&box_id(1), &block, 1500, &[3, 1, 2], &instant(10, 0), &instant(20, 0))),
              scan(5, 4, 2, 30),
              fact(&record_id(6), "box_closed", &shift,
                  box_closed(&box_id(2), &block, 1501, &[4], &instant(30, 0), &instant(40, 0))),
              fact(&record_id(7), "shift_closed", &shift,
                  shift_closed(None, 4, 2, None, &instant(50, 0))),
          ],
      )
      .await;
      assert!(answered.iter().all(|r| r["outcome"] == "accepted"), "{answered:?}");
      floor
  }

  /// A document with `ssccs` (as typed) and the first reason of the
  /// dictionary; applied when `apply`. Returns its id.
  async fn document(admin: &Admin, ssccs: &[String], apply: bool) -> String {
      let (_, reasons) = admin.call("GET", "/v1/office/disaggregation-reasons", None).await;
      let reason = reasons[0]["id"].clone();
      let (status, created) = admin
          .call("POST", "/v1/office/disaggregation",
              Some(json!({ "reasonId": reason, "comment": "Короба намокли" })))
          .await;
      assert_eq!(status, StatusCode::CREATED, "{created}"); // or OK — as ДЗГ answers (task 0)
      let id = created["id"].as_str().unwrap().to_owned();
      let path = format!("/v1/office/disaggregation/{id}");
      let (status, body) = admin
          .call("POST", &format!("{path}/lines"), Some(json!({ "ssccs": ssccs, "source": "manual" })))
          .await;
      assert!(status.is_success(), "{body}");
      if apply {
          let (_, current) = admin.call("GET", &path, None).await;
          let (status, body) = admin
              .call("POST", &format!("{path}/apply"), Some(json!({ "expectedRev": current["rev"] })))
              .await;
          assert_eq!(status, StatusCode::OK, "{body}");
      }
      id
  }

  async fn report(admin: &Admin, id: &str, query: &str) -> (StatusCode, Value) {
      admin
          .call("GET", &format!("/v1/office/disaggregation/{id}/report-data{query}"), None)
          .await
  }

  /// Code `n` as the act prints it.
  fn printed(n: u32) -> Value {
      let code = code(n);
      json!({ "gtin14": code["gtin14"], "serial": code["serial"], "canonical": code["canonical"] })
  }

  #[tokio::test]
  async fn the_boxes_act_names_the_document_and_its_lines_without_contents() {
      let admin = admin().await;
      closed_shift(&admin).await;
      let id = document(&admin, &[sscc(1500), sscc(1501), "мусор".to_owned()], true).await;
      let (status, rows) = report(&admin, &id, "").await;
      assert_eq!(status, StatusCode::OK, "{rows}");
      assert_eq!(rows["variant"], "boxes");
      assert_eq!(rows["status"], "applied");
      assert!(rows["docNo"].as_str().unwrap().starts_with("DSG-"));
      assert_eq!(rows["organization"]["inn"], admin_org_inn(&admin).await);
      assert_eq!(rows["reasonName"], first_reason_name(&admin).await);
      assert_eq!(rows["comment"], "Короба намокли");
      // A line whose input is not an SSCC is not on the act.
      let lines = rows["lines"].as_array().unwrap();
      assert_eq!(
          lines.iter().map(|l| l["sscc"].clone()).collect::<Vec<_>>(),
          vec![json!(sscc(1500)), json!(sscc(1501))]
      );
      assert_eq!(lines[0]["codeCount"], 3);
      assert!(lines.iter().all(|l| l["items"] == json!([]) && l["boxes"] == json!([])));
      assert_eq!(rows["createdByName"], rows["appliedByName"]);
  }
  ```

  Если ДЗГ не принимает документ с неразобранной строкой к проведению, тест создаёт для строки
  «мусор» отдельный черновик, а проведённый документ строит без неё. Имена `admin_org_inn` и
  `first_reason_name` — маленькие помощники в файле: читают `GET /v1/office/org` и
  `GET /v1/office/disaggregation-reasons`.

  Остальные тесты файла (тело каждого — по тому же образцу):
  - `the_full_act_prints_the_codes_the_document_took_out_by_gtin_and_serial` — после проведения
    `?variant=full`. У короба 1500 `items == [printed(1), printed(2), printed(3)]`: коды сняты
    документом, а правило `removed_at = disassembled_at` их находит. У короба 1501 —
    `[printed(4)]`.
  - `a_draft_full_act_prints_the_live_codes` — тот же короб в черновике: те же коды (живые).
  - `a_pallet_line_lists_its_boxes_not_taken_apart_closed_first` — смена с паллетами
    (`open_pallet_floor`, `issue_pallet_block`, `pallet_closed` по образцу
    `host/tests/pallet_facts.rs`). На паллете три короба, один разобран станцией до документа.
    Строка паллеты в `full` даёт два короба по `closed_at` с живыми `units`, `items` пуст,
    `boxId` = `null`, `palletId` — паллета.
  - `two_shifts_of_one_document_are_both_read` — короба двух закрытых смен в одном документе:
    коды обоих на месте. Это проверка обхода по сменам.
  - `an_unknown_document_is_not_found_and_a_bad_variant_is_a_validation_error`:
    - `404` у неизвестного id;
    - `?variant=all` и `?variant=full&x=1` — `422 validation_failed`.

    Статус ошибки сверить с соседним тестом `ApiQuery` (`office_shifts`).

  - `every_office_role_reads_and_a_device_without_a_session_does_not` — технолог (`admin.technologist()`)
    получает `200`. Запрос с ключом устройства без сессии — `401` с
    `error.details.credential == "session"`, как в `office_reports.rs:186-196`.
  - `every_query_of_the_act_searches_by_an_index` — `EXPLAIN QUERY PLAN` для `DOCUMENT_SQL`,
    `LINES_SQL`, `LINE_SHIFTS_SQL`, `SHIFT_ITEMS_SQL` (с двумя параметрами), `PALLET_BOXES_SQL`:
    ни одного шага `SCAN`, хотя бы один `SEARCH`. `SHIFT_ITEMS_SQL` ищет по `scans_shift`. Имена
    индексов строк документа — из ДЗГ (задача 0); если индекса строк по документу нет, это
    дефект ДЗГ (сообщить), а не повод для миграции здесь.
  - `the_act_reads_one_snapshot` — по образцу теста снимка в `office_reports.rs` (найти
    `rtk proxy grep -n "after_query\|read_box_rows" apps/standalone/host/tests/office_reports.rs`).
    Внутри `after_query("lines")` второе соединение меняет комментарий документа через
    `UPDATE disaggregation_documents SET comment = 'другой'` в обход маршрута. Ответ содержит
    прежний комментарий.

  Тесты записи XML:

  ```rust
  async fn record(admin: &Admin, token: &str, id: &str, body: Value) -> (StatusCode, Value) {
      admin
          .call_as(token, "POST", &format!("/v1/office/disaggregation/{id}/exports"), Some(body))
          .await
  }

  fn record_of(packings: u32) -> Value {
      json!({ "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": packings })
  }

  #[tokio::test]
  async fn the_file_of_an_applied_document_writes_one_audit_row_and_no_revision() {
      let admin = admin().await;
      closed_shift(&admin).await;
      let id = document(&admin, &[sscc(1500), sscc(1501)], true).await;
      let revision = support::app::host_revision(&admin.app).await;
      let (status, body) = record(&admin, &admin.token, &id, record_of(2)).await;
      assert_eq!((status, &body), (StatusCode::NO_CONTENT, &Value::Null));
      let (technologist, technologist_id) = admin.technologist_session().await;
      let (status, _) = record(&admin, &technologist, &id, record_of(2)).await;
      assert_eq!(status, StatusCode::NO_CONTENT);
      assert_eq!(support::app::host_revision(&admin.app).await, revision);
      let details = json!({
          "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": 2
      });
      assert_eq!(
          support::app::audit_trail(&admin.app, "disaggregation.export").await,
          vec![
              admin.row("disaggregation.export", "disaggregation", &id, details.clone()),
              support::app::audit_row(&technologist_id, "disaggregation.export", "disaggregation", &id, details),
          ]
      );
  }

  #[tokio::test]
  async fn what_the_host_refuses_writes_no_row() {
      let admin = admin().await;
      closed_shift(&admin).await;
      let draft = document(&admin, &[sscc(1500)], false).await;
      let applied = document(&admin, &[sscc(1501)], true).await;
      for (id, body, status) in [
          (draft.as_str(), record_of(1), StatusCode::CONFLICT),
          (applied.as_str(), record_of(2), StatusCode::UNPROCESSABLE_ENTITY),
          (applied.as_str(), json!({ "formatId": "shift_xml_gismt_aggregation", "formatVersion": 1, "packingCount": 1 }), StatusCode::UNPROCESSABLE_ENTITY),
          (applied.as_str(), json!({ "formatId": "disaggregation_xml_gismt", "formatVersion": 2, "packingCount": 1 }), StatusCode::UNPROCESSABLE_ENTITY),
          ("7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6", record_of(1), StatusCode::NOT_FOUND),
      ] {
          let (answered, body) = record(&admin, &admin.token, id, body).await;
          assert_eq!(answered, status, "{body}");
      }
      assert!(support::app::audit_trail(&admin.app, "disaggregation.export").await.is_empty());
  }
  ```

  Плюс `a_file_record_needs_a_session` (`401`, как выше) и `a_cancelled_document_has_no_file`
  (`409`, `error.details.constraint == "document_status"`). Отменённый черновик делается
  маршрутом отмены ДЗГ. Числовые статусы `validation_failed` и `conflict` сверить с
  `host/tests/office_exports.rs`.

  Прогон `cargo … test -p markiro-host --test office_disaggregation_reports` — красный.

- [ ] **Шаг 2: реализация** `routes/office_disaggregation_reports.rs`:

  ```rust
  //! A disaggregation document's act and ЧЗ file in the office (plan ДЗГ-О):
  //! `GET /v1/office/disaggregation/{id}/report-data?variant=boxes|full` and
  //! `POST …/exports`, every office role. The host only reads and records:
  //! the office maps the rows to the cloud's act input and draws it with
  //! `@markiro/domain`, and forms the ГИС МТ «Расформирование упаковки» file
  //! there too. One read transaction gives every row one snapshot; each query
  //! searches by an index, and the codes of `full` are read one pass over a
  //! shift's scans per shift of the document, never per box.

  use std::collections::HashMap;
  use std::future::Future;

  use axum::extract::State;
  use axum::http::StatusCode;
  use axum::Json;
  use markiro_proto::{
      BoxReportItem, DisaggregationExportRecord, DisaggregationReportBox,
      DisaggregationReportLine, DisaggregationReportRows, DisaggregationReportVariant,
      DisaggregationStatus, ExportOrganization, DISAGGREGATION_XML_FORMAT_ID,
      DISAGGREGATION_XML_FORMAT_VERSION,
  };
  use serde::Deserialize;
  use serde_json::json;
  use sqlx::{SqliteConnection, SqlitePool};

  use crate::audit::{self, actions, Entry, Outcome};
  use crate::auth::OfficeContext;
  use crate::db::begin_write;
  use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
  use crate::routes::office_exports::ORGANIZATION_SQL;
  use crate::server::AppState;

  /// The document with the names of its reason and of the users who made and
  /// applied it.
  pub const DOCUMENT_SQL: &str = "SELECT d.id, d.doc_no, d.status, d.created_at, d.applied_at, \
       d.comment, cu.name AS created_by_name, au.name AS applied_by_name, r.name AS reason_name \
       FROM disaggregation_documents d \
       LEFT JOIN office_users cu ON cu.id = d.created_by \
       LEFT JOIN office_users au ON au.id = d.applied_by \
       LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
       WHERE d.id = ?";

  /// The lines with an SSCC, in the order they were added, each with its
  /// product's name now (the cloud's `listLines` joins the live product).
  pub const LINES_SQL: &str = "SELECT l.id, l.sscc, l.box_id, l.pallet_id, \
       p.name AS product_name, l.code_count FROM disaggregation_document_lines l \
       LEFT JOIN products p ON p.id = l.product_id \
       WHERE l.document_id = ? AND l.sscc IS NOT NULL ORDER BY l.position, l.id";

  /// The shifts of the document's boxes, each read once by `SHIFT_ITEMS_SQL`.
  pub const LINE_SHIFTS_SQL: &str = "SELECT DISTINCT b.shift_id \
       FROM disaggregation_document_lines l JOIN boxes b ON b.id = l.box_id \
       WHERE l.document_id = ? AND l.sscc IS NOT NULL ORDER BY b.shift_id";

  /// The codes the act prints of the document's boxes of one shift: «Состав
  /// короба»'s rule (`office_reports::BOX_ITEMS_SQL`) — not displaced, and
  /// live or taken out by the box's own disassembly — through `scans_shift`,
  /// since no index names a box's items that are no longer live.
  pub const SHIFT_ITEMS_SQL: &str = "SELECT i.box_id, s.gtin14, s.serial, s.canonical \
       FROM scans s JOIN box_items i ON i.scan_id = s.id JOIN boxes b ON b.id = i.box_id \
       WHERE s.shift_id = ?1 AND i.box_id IN (SELECT l.box_id FROM disaggregation_document_lines l \
         WHERE l.document_id = ?2 AND l.box_id IS NOT NULL AND l.sscc IS NOT NULL) \
       AND i.displaced_at IS NULL \
       AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at) \
       ORDER BY s.gtin14, s.serial";

  /// The boxes standing on the document's pallets: not taken apart (the
  /// cloud's `isNull(boxes.disassembledAt)`; a box taken off before keeps
  /// its `pallet_id`), closed first, with their live units.
  pub const PALLET_BOXES_SQL: &str = "SELECT b.pallet_id, b.sscc, \
       (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
        AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
       FROM boxes b WHERE b.pallet_id IN (SELECT l.pallet_id FROM disaggregation_document_lines l \
         WHERE l.document_id = ? AND l.pallet_id IS NOT NULL AND l.sscc IS NOT NULL) \
       AND b.disassembled_at IS NULL ORDER BY b.pallet_id, b.closed_at, b.id";

  /// The packages the document's ЧЗ file names: its distinct SSCCs.
  pub const PACKINGS_SQL: &str = "SELECT COUNT(DISTINCT sscc) FROM disaggregation_document_lines \
       WHERE document_id = ? AND sscc IS NOT NULL";

  #[derive(Debug, Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ReportQuery {
      #[serde(default)]
      variant: Option<DisaggregationReportVariant>,
  }

  #[derive(sqlx::FromRow)]
  struct DocumentRow {
      id: String,
      doc_no: String,
      status: String,
      created_at: String,
      applied_at: Option<String>,
      comment: Option<String>,
      created_by_name: Option<String>,
      applied_by_name: Option<String>,
      reason_name: Option<String>,
  }

  #[derive(sqlx::FromRow)]
  struct LineRow {
      id: String,
      sscc: String,
      box_id: Option<String>,
      pallet_id: Option<String>,
      product_name: Option<String>,
      code_count: i64,
  }

  pub async fn report_data(
      State(state): State<AppState>,
      _context: OfficeContext,
      ApiPath(id): ApiPath<String>,
      ApiQuery(query): ApiQuery<ReportQuery>,
  ) -> Result<Json<DisaggregationReportRows>, ApiError> {
      let variant = query.variant.unwrap_or(DisaggregationReportVariant::Boxes);
      read_report_rows(&state.pool, &id, variant, |_| async {})
          .await?
          .map(Json)
          .ok_or_else(|| ApiError::not_found("no such disaggregation document"))
  }

  /// The reads of an act in one plain deferred transaction, rolled back, as
  /// `office_reports::read_box_rows`. `after_query` is called with each
  /// query's name (`document`, `organization`, `lines`, `items`, `boxes`).
  pub async fn read_report_rows<F, Fut>(
      pool: &SqlitePool,
      id: &str,
      variant: DisaggregationReportVariant,
      after_query: F,
  ) -> Result<Option<DisaggregationReportRows>, ApiError>
  where
      F: FnMut(&'static str) -> Fut,
      Fut: Future<Output = ()>,
  {
      let mut tx = pool.begin().await.map_err(ApiError::internal)?;
      let rows = read(&mut tx, id, variant, after_query).await;
      tx.rollback().await.map_err(ApiError::internal)?;
      rows
  }

  async fn read<F, Fut>(
      conn: &mut SqliteConnection,
      id: &str,
      variant: DisaggregationReportVariant,
      mut after_query: F,
  ) -> Result<Option<DisaggregationReportRows>, ApiError>
  where
      F: FnMut(&'static str) -> Fut,
      Fut: Future<Output = ()>,
  {
      let found: Option<DocumentRow> = sqlx::query_as(DOCUMENT_SQL)
          .bind(id)
          .fetch_optional(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      after_query("document").await;
      let Some(document) = found else {
          return Ok(None);
      };
      let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
          .fetch_one(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      after_query("organization").await;
      let lines: Vec<LineRow> = sqlx::query_as(LINES_SQL)
          .bind(id)
          .fetch_all(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      after_query("lines").await;
      let mut items: HashMap<String, Vec<BoxReportItem>> = HashMap::new();
      let mut boxes: HashMap<String, Vec<DisaggregationReportBox>> = HashMap::new();
      if variant == DisaggregationReportVariant::Full {
          let shifts: Vec<String> = sqlx::query_scalar(LINE_SHIFTS_SQL)
              .bind(id)
              .fetch_all(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
          for shift in shifts {
              let rows: Vec<(String, String, String, String)> = sqlx::query_as(SHIFT_ITEMS_SQL)
                  .bind(&shift)
                  .bind(id)
                  .fetch_all(&mut *conn)
                  .await
                  .map_err(ApiError::internal)?;
              for (box_id, gtin14, serial, canonical) in rows {
                  items.entry(box_id).or_default().push(BoxReportItem { gtin14, serial, canonical });
              }
          }
          after_query("items").await;
          let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(PALLET_BOXES_SQL)
              .bind(id)
              .fetch_all(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
          for (pallet_id, sscc, units) in rows {
              boxes.entry(pallet_id).or_default().push(DisaggregationReportBox {
                  sscc,
                  units: u32::try_from(units).map_err(ApiError::internal)?,
              });
          }
          after_query("boxes").await;
      }
      let status: DisaggregationStatus = document.status.parse().map_err(ApiError::internal)?;
      let lines = lines
          .into_iter()
          .map(|line| {
              Ok(DisaggregationReportLine {
                  // `get().cloned()`, not `remove`: a draft's duplicate line names the
                  // same box twice, and the cloud prints its codes under both lines.
                  items: line.box_id.as_ref().and_then(|b| items.get(b).cloned()).unwrap_or_default(),
                  boxes: line.pallet_id.as_ref().and_then(|p| boxes.get(p).cloned()).unwrap_or_default(),
                  code_count: u32::try_from(line.code_count).map_err(ApiError::internal)?,
                  id: line.id,
                  sscc: line.sscc,
                  box_id: line.box_id,
                  pallet_id: line.pallet_id,
                  product_name: line.product_name,
              })
          })
          .collect::<Result<Vec<_>, ApiError>>()?;
      Ok(Some(DisaggregationReportRows {
          id: document.id,
          doc_no: document.doc_no,
          status,
          created_at: document.created_at,
          applied_at: document.applied_at,
          created_by_name: document.created_by_name,
          applied_by_name: document.applied_by_name,
          reason_name: document.reason_name,
          comment: document.comment,
          organization: ExportOrganization { name, inn },
          variant,
          lines,
      }))
  }
  ```

  В проведённом документе короб встречается один раз: дубль ДЗГ к проведению не пускает. Но в
  черновике строка `duplicate` может назвать тот же короб второй раз, и облако печатает его коды у
  обеих строк (`codesByBoxId.get`). Отсюда `get().cloned()` и тест
  `a_duplicate_line_of_a_draft_prints_the_box_twice` (если ДЗГ даёт строке `duplicate` `boxId`).

  Запись:

  ```rust
  /// `POST /v1/office/disaggregation/{id}/exports`: one `disaggregation.export`
  /// row with what the file named, `204`. Only an applied document has a file
  /// (`conflict` on `document_status`); `packingCount` must be its distinct
  /// SSCCs — an applied document's lines never change, so another count is
  /// the office's mistake, not a race.
  pub async fn record_export(
      State(state): State<AppState>,
      context: OfficeContext,
      ApiPath(id): ApiPath<String>,
      ApiJson(record): ApiJson<DisaggregationExportRecord>,
  ) -> Result<StatusCode, ApiError> {
      if record.format_id != DISAGGREGATION_XML_FORMAT_ID
          || record.format_version != DISAGGREGATION_XML_FORMAT_VERSION
      {
          return Err(ApiError::validation(
              "formatId",
              "not a file the office forms for a disaggregation document",
          ));
      }
      let at = state.timestamp();
      let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
      context.require_session_in(&mut tx).await?;
      let status: Option<String> =
          sqlx::query_scalar("SELECT status FROM disaggregation_documents WHERE id = ?")
              .bind(&id)
              .fetch_optional(&mut *tx)
              .await
              .map_err(ApiError::internal)?;
      let status: DisaggregationStatus = status
          .ok_or_else(|| ApiError::not_found("no such disaggregation document"))?
          .parse()
          .map_err(ApiError::internal)?;
      if status != DisaggregationStatus::Applied {
          return Err(ApiError::conflict(
              "document_status",
              "only an applied document has a ЧЗ file",
          ));
      }
      let packings: i64 = sqlx::query_scalar(PACKINGS_SQL)
          .bind(&id)
          .fetch_one(&mut *tx)
          .await
          .map_err(ApiError::internal)?;
      if i64::from(record.packing_count) != packings {
          return Err(ApiError::validation(
              "packingCount",
              "the file names each SSCC of the document once",
          ));
      }
      audit::record(
          &mut tx,
          &at,
          Entry {
              actor: context.actor(),
              action: actions::DISAGGREGATION_EXPORT,
              target_type: Some("disaggregation"),
              target_id: Some(&id),
              outcome: Outcome::Ok,
              details: json!({
                  "formatId": record.format_id,
                  "formatVersion": record.format_version,
                  "packingCount": record.packing_count,
              }),
          },
      )
      .await
      .map_err(ApiError::internal)?;
      tx.commit().await.map_err(ApiError::internal)?;
      Ok(StatusCode::NO_CONTENT)
  }
  ```

  `server.rs` — рядом с маршрутами ДЗГ:

  ```rust
  .route(
      "/v1/office/disaggregation/{id}/report-data",
      get(crate::routes::office_disaggregation_reports::report_data),
  )
  .route(
      "/v1/office/disaggregation/{id}/exports",
      post(crate::routes::office_disaggregation_reports::record_export),
  )
  ```

  Маршрут `…/{id}/report-data` не должен спорить с маршрутами ДЗГ вида `…/{id}/lines/{lineId}`:
  axum различает пути по статическим сегментам. Тест `404`/`200` выше это покрывает. `mod.rs` —
  `pub mod office_disaggregation_reports;`. `target_type` и спряжение действия — как у ДЗГ
  (задача 0).

- [ ] **Шаг 3: зелёные тесты; полный `cargo … test -p markiro-host`; `cargo fmt --check`; без
      предупреждений; коммит**
      `feat(standalone): host — the disaggregation act's data and the record of its ЧЗ file`.

## Задача 5: офис — страницы «Дезагрегация», документ, «Причины»

**Files:** Create `src/office/disaggregation/{DisaggregationPage.tsx,DisaggregationDocumentPage.tsx,DisaggregationReasonsPage.tsx,document-list.ts,disaggregation-text.ts,sscc-input.ts}`,
`test/{sscc-input,document-list}.test.ts`,
`test/{disaggregation-page,disaggregation-document,disaggregation-reasons}.test.tsx`; Modify
`src/office/nav.ts`, `src/office/routes.tsx`, `src/office/office-query.ts`, `src/i18n/ru.json`,
`test/operators-page.test.tsx`, `test/shifts-page.test.tsx` (порядок пунктов меню).

**Interfaces:**

```ts
// sscc-input.ts
/** The cloud API's ceiling of one file (`import-parser.ts`, `MAX_IMPORT_LINES`). */
export const MAX_IMPORT_LINES = 10_000;
/** The cloud's multer limit of an imported file: 1 MiB. */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/** SSCCs pasted or scanned into the text field: the cloud page's `splitSsccInput`. */
export function parsePastedSsccs(raw: string): string[];
export type ImportRefusal = "file_too_large" | "file_empty" | "too_many_lines";
export type ImportParse = { ok: true; tokens: string[] } | { ok: false; refusal: ImportRefusal };
/** A file's text: the cloud API's `parseSsccImport` (`\r\n;,`, trimmed, empties dropped, duplicates kept). */
export function parseSsccImport(text: string): ImportParse;
/** Reads a picked file (UTF-8, the BOM dropped) and parses it; a file over 1 MiB is not read. */
export function readSsccImport(file: Pick<File, "size" | "text">): Promise<ImportParse>;

// document-list.ts
export type DocumentStatusFilter = "all" | DisaggregationStatus;
export interface DocumentFilter {
  status: DocumentStatusFilter;
  reasonId: string; // "" = every reason
  docNo: string;
  from: string; // civil date or ""
  to: string;
}
export const DOCUMENT_PAGE_SIZE = 50;
export function findDocuments(
  documents: readonly DisaggregationDocument[],
  filter: DocumentFilter,
  timeZone: string,
): DisaggregationDocument[];

// disaggregation-text.ts
export const DOCUMENT_STATUS_PHASE: Record<DisaggregationStatus, TagPhase>;
export const LINE_STATUS_PHASE: Record<DisaggregationLineStatus, TagPhase>;
/** A line's SSCC as people read it: `(00)…`, or what was typed when it is no SSCC. */
export function lineSsccLabel(line: Pick<DisaggregationLine, "sscc" | "ssccInput">): string;
```

`officeKeys` (в `office-query.ts`):

```ts
/** Every list of disaggregation documents (plan ДЗГ-О): a write reads it again. */
disaggregation: ["office", "disaggregation"],
/** One document with its lines, read afresh at every opening. */
disaggregationDocument: (id: string) => ["office", "disaggregation-document", id],
disaggregationReasons: ["office", "disaggregation-reasons"],
/** What the act or the ЧЗ file of a document is drawn from. */
disaggregationReport: (id: string, variant: "boxes" | "full") => [
  "office",
  "disaggregation-report",
  id,
  variant,
],
```

- [ ] **Шаг 1: красные тесты разбора и фильтров.**

  `test/sscc-input.test.ts` — те же случаи, что `apps/api/test/disaggregation-import.test.ts`,
  плюс отличия Р9:

  ```ts
  import { describe, expect, it } from "vitest";

  import {
    MAX_IMPORT_BYTES,
    parsePastedSsccs,
    parseSsccImport,
    readSsccImport,
  } from "../src/office/disaggregation/sscc-input.js";

  describe("a file's SSCCs (the cloud API's parseSsccImport)", () => {
    it("splits on newlines, semicolons and commas; trims; drops empties", () => {
      expect(parseSsccImport("123;456\n789,abc\r\n\n  042  \n")).toEqual({
        ok: true,
        tokens: ["123", "456", "789", "abc", "042"],
      });
    });

    it("keeps duplicates: the document shows them as duplicate lines", () => {
      expect(parseSsccImport("1\n1")).toEqual({ ok: true, tokens: ["1", "1"] });
    });

    it("refuses over 10 000 tokens and an empty file", () => {
      expect(parseSsccImport(Array(10_001).fill("1").join("\n"))).toEqual({
        ok: false,
        refusal: "too_many_lines",
      });
      expect(parseSsccImport(Array(10_000).fill("1").join("\n")).ok).toBe(true);
      expect(parseSsccImport(" ;\n,")).toEqual({ ok: false, refusal: "file_empty" });
    });

    it("keeps a space inside a token, as the cloud does (it is then not found)", () => {
      expect(parseSsccImport("1460 0703")).toEqual({ ok: true, tokens: ["1460 0703"] });
    });
  });

  describe("pasted SSCCs (the cloud page's splitSsccInput)", () => {
    it("splits on any whitespace, semicolons and commas", () => {
      expect(parsePastedSsccs(" (00)146007034967000017 \t146007034967000024;\n,x ")).toEqual([
        "(00)146007034967000017",
        "146007034967000024",
        "x",
      ]);
    });
  });

  describe("reading a picked file", () => {
    it("drops the BOM Excel writes, unlike the cloud", async () => {
      const file = { size: 22, text: async () => "\uFEFF146007034967000017;\n" };
      expect(await readSsccImport(file)).toEqual({ ok: true, tokens: ["146007034967000017"] });
      const real = new File(["\uFEFF146007034967000017\n"], "list.csv");
      expect(await readSsccImport(real)).toEqual({ ok: true, tokens: ["146007034967000017"] });
    });

    it("does not read a file over 1 MiB", async () => {
      const text = async () => {
        throw new Error("must not be read");
      };
      expect(await readSsccImport({ size: MAX_IMPORT_BYTES + 1, text })).toEqual({
        ok: false,
        refusal: "file_too_large",
      });
    });
  });
  ```

  `File.text()` по стандарту снимает BOM при разборе UTF-8, но поведение jsdom и WebView2 этим
  тестом не доказывается. Поэтому хелпер снимает его и сам (`text.replace(/^\uFEFF/u, "")`), а
  тест проверяет оба пути: поддельный файл с BOM в тексте и настоящий `File`.

  `test/document-list.test.ts`:
  - фильтр по статусу и по причине;
  - номер — подстрока без учёта регистра (`"dsg-26-00"` находит `DSG-26-0007`);
  - период: документ, созданный в `2026-10-12T21:30:00Z`, при зоне `Europe/Moscow` попадает в
    `from = to = "2026-10-13"`, а при зоне `UTC` — в `"2026-10-12"`;
  - пустые `from`/`to` не фильтруют;
  - порядок хоста сохраняется.

  Прогон `pnpm … exec vitest run test/sscc-input.test.ts test/document-list.test.ts` — красный.

- [ ] **Шаг 2: реализация разбора и фильтров.**

  ```ts
  // sscc-input.ts
  export function parsePastedSsccs(raw: string): string[] {
    return raw
      .split(/[\s;,]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  export function parseSsccImport(text: string): ImportParse {
    const tokens = text
      .split(/[\r\n;,]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length > MAX_IMPORT_LINES) return { ok: false, refusal: "too_many_lines" };
    if (tokens.length === 0) return { ok: false, refusal: "file_empty" };
    return { ok: true, tokens };
  }

  export async function readSsccImport(file: Pick<File, "size" | "text">): Promise<ImportParse> {
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, refusal: "file_too_large" };
    const text = await file.text();
    return parseSsccImport(text.replace(/^\uFEFF/u, ""));
  }
  ```

  `document-list.ts`: `findDocuments` фильтрует по `status`, `reasonId`,
  `docNo.trim().toLocaleLowerCase("ru")` и периоду. Гражданская дата создания —
  `civilToday(timeZone, new Date(document.createdAt))` из `src/lib/civil-date.ts`. Сравнение
  строк `YYYY-MM-DD` лексикографическое.

  `disaggregation-text.ts` — фазы облака (`DocumentDetail.tsx`, `DOCUMENT_STATUS_TO_PHASE`,
  `LINE_STATUS_TO_PHASE`):

  ```ts
  export const DOCUMENT_STATUS_PHASE = {
    draft: "draft",
    applied: "done",
    cancelled: "retired",
  } as const satisfies Record<DisaggregationStatus, TagPhase>;

  export const LINE_STATUS_PHASE = {
    ok: "done",
    not_found: "failed",
    not_closed: "attention",
    shift_open: "attention",
    already_disassembled: "dismantled",
    duplicate: "duplicate",
  } as const satisfies Record<DisaggregationLineStatus, TagPhase>;

  export function lineSsccLabel(line: Pick<DisaggregationLine, "sscc" | "ssccInput">): string {
    return line.sscc === null ? line.ssccInput : formatSsccHri(line.sscc);
  }
  ```

  `satisfies Record<…>` ловит при компиляции статус, который ДЗГ добавит или уберёт.

  Прогон — зелёный.

- [ ] **Шаг 3: тексты** в `src/i18n/ru.json`:
  - `office.nav.disaggregation` — «Дезагрегация»;
  - раздел `office.disaggregation` — тексты облака (`pages.disaggregation.*` в
    `apps/admin/src/i18n/ru.json`) с правками ниже:

  ```json
  {
    "title": "Дезагрегация",
    "create": "Создать документ",
    "reasonsLink": "Причины дезагрегации",
    "empty": "Документов дезагрегации пока нет.",
    "nothingFound": "По фильтрам ничего не найдено.",
    "pager": "Страницы документов",
    "openNamed": "Открыть документ {{docNo}}",
    "filters": {
      "status": "Статус",
      "statusAll": "Все статусы",
      "reason": "Причина",
      "reasonAll": "Все причины",
      "docNo": "Номер документа",
      "docNoPlaceholder": "Поиск по номеру документа",
      "from": "С",
      "to": "По",
      "reset": "Сбросить фильтры",
      "reversed": "Дата «С» позже даты «По»."
    },
    "statuses": { "draft": "Черновик", "applied": "Проведён", "cancelled": "Отменён" },
    "table": {
      "docNo": "№ документа",
      "createdAt": "Создан",
      "status": "Статус",
      "reason": "Причина",
      "lineCount": "Строк",
      "codeCount": "Кодов",
      "author": "Автор"
    },
    "lineStatuses": {
      "ok": "Готов к проведению",
      "not_found": "Короб или паллета не найдены",
      "not_closed": "Не закрыт",
      "shift_open": "Смена ещё открыта — доступно после закрытия смены",
      "already_disassembled": "Уже расформирован",
      "duplicate": "Дубль в документе"
    },
    "detail": {
      "back": "← Дезагрегация",
      "title": "Документ {{docNo}}",
      "reason": "Причина",
      "reasonNone": "Не выбрана",
      "comment": "Комментарий",
      "createdAt": "Создан",
      "createdBy": "Автор",
      "appliedAt": "Проведён",
      "cancelledAt": "Отменён",
      "addTitle": "Добавить строки",
      "addLabel": "SSCC коробов или паллет",
      "addPlaceholder": "Вставьте или отсканируйте SSCC — по одному на строку",
      "addAction": "Добавить строки",
      "importLabel": "Импорт из файла .txt или .csv",
      "importHint": "SSCC через перевод строки, «;» или «,», не больше 10 000 и не больше 1 МБ.",
      "importAction": "Импорт из файла",
      "importAdded": "Из файла добавлено строк: {{count}}.",
      "importRefused": {
        "file_too_large": "Файл больше 1 МБ: разделите его на части.",
        "file_empty": "В файле нет ни одного SSCC.",
        "too_many_lines": "В файле больше 10 000 SSCC: разделите его на части.",
        "extension": "Можно загрузить только файл .txt или .csv.",
        "unreadable": "Файл не удалось прочитать."
      },
      "linesTitle": "Строки",
      "linesEmpty": "Строки не добавлены.",
      "linesCaption": "Строки документа",
      "table": {
        "sscc": "SSCC",
        "level": "Уровень",
        "product": "Товар",
        "codeCount": "Кодов",
        "status": "Статус",
        "actions": "Действия"
      },
      "levels": { "box": "Короб", "pallet": "Паллета", "unknown": "—" },
      "deleteLine": "Удалить",
      "deleteLineNamed": "Удалить строку {{sscc}}",
      "apply": "Провести",
      "applyHint": "Провести можно, когда выбрана причина и все строки готовы к проведению.",
      "applyConfirmTitle": "Провести документ?",
      "applyConfirm": "Будет расформировано строк: {{lines}}, кодов: {{codes}}. Коды коробов станут свободными, станции получат это при следующей связи с сервером.",
      "applyConfirmAction": "Провести",
      "applyBlocked": "Часть строк изменила статус и не готова к проведению. Проверьте таблицу ниже.",
      "applied": "Документ проведён.",
      "cancel": "Отменить документ",
      "cancelConfirmTitle": "Отменить документ?",
      "cancelConfirm": "Документ будет отменён. Это действие нельзя отменить.",
      "cancelConfirmAction": "Отменить документ",
      "cancelled": "Документ отменён.",
      "dismiss": "Отмена",
      "printAct": "Акт дезагрегации",
      "xml": "Файл для Честного знака"
    },
    "reasons": {
      "title": "Причины дезагрегации",
      "back": "← Дезагрегация",
      "empty": "Причины не добавлены.",
      "add": "Добавить причину",
      "addTitle": "Новая причина",
      "editTitle": "Причина «{{name}}»",
      "edit": "Изменить",
      "editNamed": "Изменить причину {{name}}",
      "name": "Название",
      "sortOrder": "Порядок",
      "archived": "В архиве",
      "archivedHint": "Причина в архиве не предлагается в новых документах; в старых она остаётся.",
      "table": {
        "name": "Название",
        "sortOrder": "Порядок",
        "state": "Состояние",
        "actions": "Действия"
      },
      "errors": {
        "nameRequired": "Укажите название.",
        "nameTooLong": "Не больше 120 символов.",
        "sortOrderInvalid": "Введите целое число."
      }
    }
  }
  ```

  Тексты акта, его диалога и XML добавляют задачи 6 и 7. Если ДЗГ удаляет причину вместо
  архива, флажок «В архиве» заменяется действием «Удалить» с `ConfirmDialog`, тексты облака
  (`archiveConfirmTitle`, `archiveConfirmBody`).

- [ ] **Шаг 4: красные тесты страниц** (`test/disaggregation-*.test.tsx`; сессия —
      `fakeOfficeSession`, хост — моки `fakeHostApi`, данные — фабрики в начале файла по типам
      ДЗГ). Случаи:

  `disaggregation-page.test.tsx`:
  - пункт меню «Дезагрегация» стоит после «Смены» у обеих ролей. Ожидаемый порядок в
    `operators-page.test.tsx:177-184`: «Линии», «Смены», «Дезагрегация», «Операторы»,
    «Устройства». В `shifts-page.test.tsx:66` «Смены» по-прежнему сразу после «Линии»;
  - список показывает номер (ссылка с именем `Открыть документ DSG-26-0007`), дату создания в
    часовом поясе организации (`ORG_PROFILE.timeZone`), статус-чип, причину, число строк и кодов,
    автора;
  - фильтры статуса, причины, номера и периода сужают список. «Сбросить фильтры» возвращает
    его. Обратный период показывает текст `filters.reversed` и список не меняет;
  - 51 документ — две страницы (`OfficePager`);
  - «Создать документ» вызывает `createDisaggregationDocument(token, { reasonId: null, comment:
null })` и открывает `/disaggregation/<id>`;
  - технологу кнопка тоже доступна (Р10);
  - сбой списка — `LoadError` с «Повторить».

  `disaggregation-document.test.tsx`:
  - черновик: выбор причины вызывает `updateDisaggregationDocument` с `expectedRev`.
    Комментарий сохраняется при уходе фокуса и только если изменён. Ответ `stale_revision`
    показывает `StaleAlert`, «Загрузить заново» перечитывает документ;
  - вставка «(00)146007034967000017 146007034967000024» → `addDisaggregationLines(token, id, {
ssccs: ["(00)146007034967000017", "146007034967000024"], source: "manual" })`, поле
    очищается;
  - импорт: `FileDropZone` получает `new File(["146007034967000017;146007034967000024\n"],
"list.csv")` → `addDisaggregationLines(…, { ssccs: […2], source: "import" })` и текст
    `importAdded` с числом 2;
  - файл на 10 001 SSCC — текст `too_many_lines`, хост не вызывается;
  - `.xlsx` — `onRejected` → `extension`;
  - строки — таблица с подписью `linesCaption`: SSCC как `(00)…`, уровень, товар, коды, чип
    статуса. «Удалить строку (00)146007034967000017» вызывает `deleteDisaggregationLine`;
  - «Провести» недоступна (`disabled`) без причины или со строкой не `ok`, рядом подсказка
    `applyHint`. С готовыми строками — `ConfirmDialog` с числом строк и кодов. Подтверждение
    вызывает `applyDisaggregationDocument(token, id, { expectedRev })`, страница перечитывает
    документ и показывает `applied`. Esc закрывает диалог без вызова;
  - ответ `conflict` (`lines_not_ready`) показывает `applyBlocked` и перечитывает документ;
  - «Отменить документ» → `ConfirmDialog` (`tone="destructive"`) →
    `cancelDisaggregationDocument`;
  - проведённый и отменённый документы — только чтение: нет полей, панели добавления, удаления
    строк, «Провести» и «Отменить». Есть «Акт дезагрегации»; «Файл для Честного знака» — только
    у проведённого. Кнопки диалогов проверяют задачи 6 и 7;
  - неизвестный документ (`not_found`) — `LoadError` и ссылка «← Дезагрегация».

  `disaggregation-reasons.test.tsx`:
  - администратор добавляет причину (название 1–120 символов после обрезки, порядок — целое
    число), правит её и переводит в архив. Каждое действие вызывает метод ДЗГ с `expectedRev`
    (кроме создания);
  - пустое название — ошибка поля `nameRequired`; «1.5» в порядке — `sortOrderInvalid`, хост не
    вызывается;
  - технолог видит таблицу и текст `office.common.readOnly`, кнопок «Добавить причину» и
    «Изменить» нет (Р10);
  - причины в архиве — в конце списка с `ArchiveStatus` (`src/office/records.tsx`);
  - ссылка «← Дезагрегация» и ссылка «Причины дезагрегации» со страницы списка ведут друг к
    другу.

  Прогон (красный):
  `pnpm … exec vitest run test/disaggregation-page.test.tsx test/disaggregation-document.test.tsx test/disaggregation-reasons.test.tsx test/operators-page.test.tsx test/shifts-page.test.tsx`.

- [ ] **Шаг 5: реализация страниц.**

  `nav.ts` — после «Смены»:

  ```ts
  {
    to: "/disaggregation",
    labelKey: "office.nav.disaggregation",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  ```

  `routes.tsx` — в детях `OfficeShell`, после `shifts/:id`:

  ```tsx
  { path: "disaggregation", element: <DisaggregationPage /> },
  { path: "disaggregation/reasons", element: <DisaggregationReasonsPage /> },
  { path: "disaggregation/:id", element: <DisaggregationDocumentPage /> },
  ```

  React Router ставит статический сегмент `reasons` выше `:id`. Тест «ссылка на причины»
  проверяет, что открывается страница причин, а не документ с id `reasons`.

  `DisaggregationPage.tsx` — по образцу `ShiftsPage.tsx`:
  - `PageHeader` с действиями: `Link` «Причины дезагрегации» и `Button` «Создать документ»
    (`useCan("planShifts")`, `useOfficeMutation`; после успеха — `invalidateQueries(officeKeys.disaggregation)`
    и `navigate`);
  - `FilterBar`: два `Select`, `Input`, два `DatePicker` с `datePickerTexts(t)` из
    `shifts/shift-text.ts`, «Сбросить фильтры»;
  - `Table` в `Card`, `getRowKey={(d) => d.id}`, `scrollLabel={t("office.disaggregation.title")}`,
    `OfficePager`.

  Данные:
  - `useOfficeQuery(officeKeys.disaggregation, (api, token) => api.listDisaggregationDocuments(token))`;
  - причины — `officeKeys.disaggregationReasons`;
  - организация — `officeKeys.org`, зона — `formTimeZone(org.data)` из `forms/render-form.ts`.

  Время в таблице — `Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short",
timeZone })`, как `ShiftCardPage.tsx:147`.

  `DisaggregationDocumentPage.tsx` — структура (части — функции в том же файле, как в облачном
  `DocumentDetail.tsx`):

  ```tsx
  export function DisaggregationDocumentPage() {
    const { t } = useTranslation();
    const { id = "" } = useParams();
    const canWrite = useCan("planShifts");
    const queryClient = useQueryClient();
    const [notice, setNotice] = useState<string | null>(null);
    const [dialog, setDialog] = useState<"act" | "xml" | "apply" | "cancel" | null>(null);
    const doc = useOfficeQuery(officeKeys.disaggregationDocument(id), (api, token) =>
      api.getDisaggregationDocument(token, id),
    );
    const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
    /** After a write: the document and every list are read again. */
    const readAgain = () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.disaggregationDocument(id) });
      void queryClient.invalidateQueries({ queryKey: officeKeys.disaggregation });
    };
    // back link, PageLoading / LoadError, then:
    // <PageHeader title={t("office.disaggregation.detail.title", { docNo })}
    //   actions={<RowActions> «Акт дезагрегации» (every role), «Файл для Честного знака»
    //   (applied only), <StatusChip phase={DOCUMENT_STATUS_PHASE[status]} …/></RowActions>} />
    // draft && canWrite ? <DocumentHeaderForm …/> : <DocumentHeaderView …/>  (DefinitionGrid)
    // draft && canWrite ? <AddLinesCard …/> : null
    // <Card title=linesTitle><Table columns rows=doc.lines empty=linesEmpty scrollLabel=linesCaption/></Card>
    // draft && canWrite ? <DraftActions …/> : null  (ConfirmDialog ×2)
    // dialog === "act" ? <DisaggregationActDialog …/> (task 6); dialog === "xml" ? <DisaggregationXmlDialog …/> (task 7)
  }
  ```

  Правила:
  - **`canApply`**: `lines.length > 0 && lines.every((l) => l.status === "ok") && reasonId !== null`.
    Кнопка `disabled`, рядом подсказка с `aria-describedby`.
  - **Импорт**:
    - `FileDropZone accept=".txt,.csv" compact label=importLabel hint=importHint
busy={importing} onFile onRejected`;
    - `onFile` → `readSsccImport(file)` → при `ok` вызов `addDisaggregationLines(…, { source:
"import" })`;
    - отказ → `Alert tone="warn"` с текстом `importRefused.<code>`; сбой чтения → `unreadable`.
  - **Ошибки записи**:
    - `writeFailure`/`alertFailure` из `form-errors.ts` и `WriteFailureAlert` с
      `onReload={readAgain}`;
    - `conflict` с `details.constraint === "lines_not_ready"` (`HostError`) → `applyBlocked` и
      `readAgain`.
  - **Фокус**: после записи фокус переходит на уведомление (`notice` с `tabIndex={-1}`, как
    `ShiftsPage.tsx`), чтобы клавиатура не терялась, когда кнопка исчезает (провели, отменили).
  - **Уровень строки**: `boxId` — «Короб», `palletId` — «Паллета», иначе «—».

  `DisaggregationReasonsPage.tsx` — по образцу `LinesPage.tsx` (таблица, `FormDialog` с `Input`
  «Название», `Input type="number"` «Порядок», `Checkbox` «В архиве» в правке,
  `activeFirstByName`-подобная сортировка: не в архиве первыми, по `sortOrder`, затем по имени).
  Права — `useCan("editReference")` (Р10).

- [ ] **Шаг 6: зелёные тесты** (два прогона: обычный и под стендом задержки `setImmediate`, см.
      «Заметки»), typecheck, lint, prettier. Коммит
      `feat(standalone): office «Дезагрегация» — documents, lines by paste or file, apply and cancel, reasons`.

## Задача 6: офис — «Акт дезагрегации»: данные, рендер через `render-form.ts`, печать

**Files:** Create `src/office/disaggregation/{act-data.ts,DisaggregationActDialog.tsx}`,
`test/disaggregation-act.test.ts`, `test/disaggregation-act-dialog.test.tsx`; Modify
`src/office/forms/{render-form.ts,print-form.ts,PrintFormDialog.tsx}`, `test/prepare-form.test.ts`,
`test/print-form.test.ts`, `src/office/disaggregation/DisaggregationDocumentPage.tsx`,
`src/i18n/ru.json`.

**Interfaces:**

```ts
// act-data.ts
/** The cloud's act input from the host's rows (`DisaggregationService.reportData`). */
export function actData(rows: DisaggregationReportRows): DisaggregationReportData;

// render-form.ts
export type FormKind = "box" | "pallet" | "placard" | "placards" | "task" | "act";
export type FormRequest =
  | /* … the five of today … */
  | { kind: "act"; rows: DisaggregationReportRows; timeZone: string };

// print-form.ts
/** Lets the window paint a press's words before the heavy draw (moved from PrintFormDialog). */
export function paint(): Promise<void>;
/** `Формы\Дезагрегация\<номер>\<дата_время>_act_<вариант>`. */
export function actFolder(
  docNo: string,
  variant: "boxes" | "full",
  formedAt: string,
  timeZone: string,
): string[];

// DisaggregationActDialog.tsx
export interface DisaggregationActDialogProps {
  documentId: string;
  docNo: string;
  /** `formTimeZone(org)`. */
  timeZone: string;
  onClose: () => void;
}
```

- [ ] **Шаг 1: красные тесты паритета** (`test/disaggregation-act.test.ts`):

  ```ts
  import { readFileSync } from "node:fs";

  import { renderDisaggregationReportHtml } from "@markiro/domain";
  import { describe, expect, it } from "vitest";

  import { disaggregationReportRowsSchema } from "../src/host/protocol.js";
  import { actData } from "../src/office/disaggregation/act-data.js";
  import { renderForm } from "../src/office/forms/render-form.js";

  const testModuleUrl = import.meta.url;
  const rows = (name: string) =>
    disaggregationReportRowsSchema.parse(
      JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8")),
    );
  const cloudBytes = (name: string) =>
    readFileSync(
      new URL(`../../../packages/domain/test/fixtures/print-forms/${name}`, testModuleUrl),
      "utf8",
    );

  /**
   * The host's rows of the facts of the domain's act snapshots, mapped by the
   * office, draw the cloud's own bytes: the snapshots were written by the
   * cloud's `report.ts` before it moved (plan ДЗГ-О, task 1).
   */
  describe("«Акт дезагрегации» from the host's rows", () => {
    it("boxes only: the cloud's bytes", () => {
      expect(
        renderDisaggregationReportHtml(actData(rows("disaggregation-report-rows-boxes.json"))),
      ).toBe(cloudBytes("disaggregation-act-boxes.html"));
    });

    it("boxes and contents: the cloud's bytes", () => {
      expect(
        renderDisaggregationReportHtml(actData(rows("disaggregation-report-rows-full.json"))),
      ).toBe(cloudBytes("disaggregation-act-full.html"));
    });

    it("the office's form: the organization's zone and the manual-upload note", () => {
      const form = renderForm({
        kind: "act",
        rows: rows("disaggregation-report-rows-full.json"),
        timeZone: "Europe/Moscow",
      });
      expect(form?.html).toBe(cloudBytes("disaggregation-act-full-moscow.html"));
      expect(form?.fileName).toBe("Акт дезагрегации DSG-26-0007.html");
    });
  });
  ```

  Плюс в `test/prepare-form.test.ts`: `prepareForm({ kind: "act", … })` не рисует до `draw()`
  (шпион на `renderDisaggregationReportHtml` через `vi.mock("@markiro/domain", …)` — по образцу
  соседних случаев файла).

  Прогон — красный.

- [ ] **Шаг 2: реализация данных и вида формы.**

  ```ts
  // act-data.ts
  import type { DisaggregationReportData } from "@markiro/domain";

  import type { DisaggregationReportRows } from "../../host/protocol.js";
  import { machineSscc } from "../forms/form-data.js";

  /**
   * «Акт дезагрегации»'s input from the host's rows, as the cloud's
   * `DisaggregationService.reportData` builds it: SSCCs with `00`, a line's
   * number by its place, the box's codes and the pallet's boxes as read
   * (empty for «только короба»), no logo (pilot question П15, as every
   * office form). `test/disaggregation-act.test.ts` holds it to the cloud's
   * bytes.
   */
  export function actData(rows: DisaggregationReportRows): DisaggregationReportData {
    return {
      docNo: rows.docNo,
      status: rows.status,
      createdAt: new Date(rows.createdAt),
      appliedAt: rows.appliedAt === null ? null : new Date(rows.appliedAt),
      org: { name: rows.organization.name, inn: rows.organization.inn, logo: null },
      createdByName: rows.createdByName,
      appliedByName: rows.appliedByName,
      reasonName: rows.reasonName,
      comment: rows.comment,
      includeContents: rows.variant === "full",
      lines: rows.lines.map((line, index) => ({
        n: index + 1,
        sscc: `00${line.sscc}`,
        productName: line.productName,
        codeCount: line.codeCount,
        codes: line.items.map((item) => ({
          gtin14: item.gtin14,
          serial: item.serial,
          rawKm: item.canonical,
        })),
        boxes: line.boxes.map((box) => ({ sscc: machineSscc(box.sscc), codeCount: box.units })),
      })),
    };
  }
  ```

  `render-form.ts`, в `prepareForm`:

  ```ts
  case "act": {
    const data = actData(request.rows);
    return {
      kind: "act",
      draw: () =>
        renderDisaggregationReportHtml(
          { ...data, operationNote: DISAGGREGATION_MANUAL_UPLOAD_NOTE },
          request.timeZone,
        ),
      fileName: `Акт дезагрегации ${request.rows.docNo}.html`,
    };
  }
  ```

  Отказа у акта нет: облако печатает акт любого статуса, и офис тоже.

  `print-form.ts`:
  - `paint()` переносится сюда из `PrintFormDialog.tsx` без изменений (экспорт); диалог её
    импортирует;
  - `actFolder`:

  ```ts
  export function actFolder(
    docNo: string,
    variant: "boxes" | "full",
    formedAt: string,
    timeZone: string,
  ): string[] {
    return [
      "Формы",
      "Дезагрегация",
      ...exportFolder(docNo, `act_${variant}`, formedAt, timeZone).slice(1),
    ];
  }
  ```

  Четыре сегмента — в пределах восьми (`office_files.rs`, `MAX_SEGMENTS`). «Дезагрегация» —
  простое имя по правилу шелла (буквы). Тест в `test/print-form.test.ts`: `actFolder("DSG-26-0007",
"full", "2026-10-12T21:30:00.000Z", "Europe/Moscow")` → `["Формы", "Дезагрегация",
"DSG-26-0007", "2026-10-13_00-30-00_act_full"]`.

  Прогон паритета — зелёный.

- [ ] **Шаг 3: красные тесты диалога** (`test/disaggregation-act-dialog.test.tsx`,
      `renderOffice(session, { files: fakeOfficeFiles(), printForm: vi.fn() })`; документ
      открывается через страницу):
  - «Акт дезагрегации» открывает диалог «Акт дезагрегации DSG-26-0007» с выбором варианта
    («Только коды упаковок», «Коды упаковок и содержимого»; по умолчанию первый) и подсказкой;
  - «Печать» перечитывает данные (`getDisaggregationReportRows(token, id, "boxes")` второй раз —
    первый при открытии) и передаёт `printForm` HTML, равный
    `renderDisaggregationReportHtml({...actData(rows), operationNote}, "Europe/Moscow")`;
  - смена варианта на полный читает `"full"`;
  - «Открыть в браузере» вызывает `files.save(["Формы", "Дезагрегация", "DSG-26-0007",
<stamp>_act_full], [{ name: "Акт дезагрегации DSG-26-0007.html", bytes }])` и `openFile`,
    затем показывает «Показать папку»;
  - сбой чтения — `LoadError`; сбой `printForm` — `office.forms.printFailed`; закрытие во время
    рисования отменяет нажатие (ни печати, ни сохранения), как в `print-form-dialog.test.tsx`;
  - технолог печатает так же (Р10).

  Прогон — красный.

- [ ] **Шаг 4: реализация диалога.** `DisaggregationActDialog.tsx` — уменьшенная копия потока
      `PrintFormDialog.tsx` без смены:
  - `useOfficeQuery(officeKeys.disaggregationReport(documentId, variant), (api, token) =>
api.getDisaggregationReportRows(token, documentId, variant))`;
  - `RadioGroup` варианта;
  - кнопки «Закрыть», «Открыть в браузере», «Печать» с `aria-disabled` во время работы;
  - живая область `aria-live="polite"` для `office.forms.{reading,drawing,saving}`;
  - нажатие: `refetch` → `paint()` → `prepareForm({ kind: "act", rows, timeZone })` → `draw()` →
    `usePrintForm()(html)` или `openInBrowser(files, form, actFolder(…))`;
  - флаги `inFlight` и `alive`, как в `PrintFormDialog`.

  Тексты:

  ```json
  "act": {
    "title": "Акт дезагрегации {{docNo}}",
    "variant": "Вариант акта",
    "variants": {
      "boxes": "Только коды упаковок",
      "full": "Коды упаковок и содержимого (DataMatrix каждого кода)"
    },
    "hint": "«Печать» открывает окно печати этого компьютера. «Открыть в браузере» сохраняет акт в папку «Документы\\Markiro\\Формы\\Дезагрегация» и открывает его в браузере. Акт рисуется по данным, прочитанным в момент нажатия; полный вариант документа на тысячи коробов рисуется долго."
  }
  ```

  Они лежат в `office.disaggregation.act`. Остальное (кнопки, этапы, ошибки файлов) берётся из
  `office.forms.*`.

  На странице документа кнопка «Акт дезагрегации» открывает диалог с
  `timeZone={formTimeZone(org.data)}`.

- [ ] **Шаг 5: зелёные тесты** (`disaggregation-act`, `disaggregation-act-dialog`,
      `prepare-form`, `print-form`, `print-form-dialog` и `forms-parity` — последние два без
      изменений, после переноса `paint`). Два прогона диалога, typecheck, lint, prettier. Коммит
      `feat(standalone): office «Акт дезагрегации» — the cloud's bytes from the host's rows, printed or opened in the browser`.

## Задача 7: офис — XML «Расформирование упаковки» для проведённого документа

**Files:** Create `src/office/disaggregation/{disaggregation-xml.ts,DisaggregationXmlDialog.tsx}`,
`test/disaggregation-xml.test.ts`, `test/disaggregation-xml-dialog.test.tsx`; Modify
`src/office/disaggregation/DisaggregationDocumentPage.tsx`, `src/i18n/ru.json`.

**Interfaces** (`disaggregation-xml.ts`; тела — в шаге 2): `DisaggregationXmlRefusal`
(`DOCUMENT_NOT_APPLIED | ORG_INN_MISSING | INVALID_ORG_INN | INVALID_SSCC | NO_PACKINGS`),
`DisaggregationXmlFile { name; bytes: Uint8Array; packingCount }`, `DisaggregationXmlResult`,
`formDisaggregationXml(rows: DisaggregationReportRows): DisaggregationXmlResult`,
`disaggregationXmlFileName(docNo): string`, `disaggregationXmlFolder(docNo, formedAt, timeZone): string[]`
(`Выгрузки\Дезагрегация\<номер>\<дата_время>_disaggregation_xml_gismt`).

- [ ] **Шаг 1: красные тесты** (`test/disaggregation-xml.test.ts`):

  ```ts
  import { readFileSync } from "node:fs";

  import { renderGismtDisaggregationXml } from "@markiro/domain";
  import { describe, expect, it } from "vitest";

  import { disaggregationReportRowsSchema } from "../src/host/protocol.js";
  import {
    disaggregationXmlFileName,
    disaggregationXmlFolder,
    formDisaggregationXml,
  } from "../src/office/disaggregation/disaggregation-xml.js";

  const testModuleUrl = import.meta.url;
  const applied = disaggregationReportRowsSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../proto/fixtures/disaggregation-report-rows-boxes.json", testModuleUrl),
        "utf8",
      ),
    ),
  );
  const decoder = new TextDecoder();

  describe("ГИС МТ «Расформирование упаковки» of a document (plan ДЗГ-О)", () => {
    it("is the domain generator's output for the document's SSCCs, boxes and pallets", () => {
      const result = formDisaggregationXml(applied);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expected = renderGismtDisaggregationXml({
        organizationInn: "7701234567",
        ssccs: ["146007034967000017", "146007034967100014"],
      });
      expect(result.file.bytes).toEqual(expected.bytes);
      expect(result.file.packingCount).toBe(2);
      expect(result.file.name).toBe("disaggregation-DSG-26-0007.xml");
      expect(decoder.decode(result.file.bytes)).toContain(
        "<kitu><![CDATA[146007034967100014]]></kitu>",
      );
    });

    it("names a twice-typed SSCC once", () => {
      const twice = { ...applied, lines: [...applied.lines, ...applied.lines] };
      const result = formDisaggregationXml(twice);
      expect(result.ok && result.file.packingCount).toBe(2);
    });

    it.each([
      [{ ...applied, status: "draft" as const }, "DOCUMENT_NOT_APPLIED"],
      [{ ...applied, organization: { name: "ООО «Атолл»", inn: null } }, "ORG_INN_MISSING"],
      [{ ...applied, organization: { name: "ООО «Атолл»", inn: "  " } }, "ORG_INN_MISSING"],
      [{ ...applied, organization: { name: "ООО «Атолл»", inn: "0000000000" } }, "INVALID_ORG_INN"],
      [{ ...applied, lines: [] }, "NO_PACKINGS"],
    ] as const)("refuses %#: %s", (rows, refusal) => {
      expect(formDisaggregationXml(rows)).toEqual({ ok: false, refusal });
    });

    it("takes a 12-digit INN of an individual entrepreneur (the generator's rule)", () => {
      const result = formDisaggregationXml({
        ...applied,
        organization: { name: "ИП Иванов", inn: "781234567890" },
      });
      expect(result.ok).toBe(true);
    });

    it("saves under Выгрузки\\Дезагрегация in the organization's time", () => {
      expect(
        disaggregationXmlFolder("DSG-26-0007", "2026-10-12T21:30:00.000Z", "Europe/Moscow"),
      ).toEqual([
        "Выгрузки",
        "Дезагрегация",
        "DSG-26-0007",
        "2026-10-13_00-30-00_disaggregation_xml_gismt",
      ]);
      expect(disaggregationXmlFileName("DSG-26-0007")).toBe("disaggregation-DSG-26-0007.xml");
      // A number is written as an export's file name writes a segment.
      expect(disaggregationXmlFileName("DSG/26 0007")).toBe("disaggregation-DSG_26_0007.xml");
    });
  });
  ```

  Прогон — красный.

- [ ] **Шаг 2: реализация.**

  ```ts
  import {
    GismtDisaggregationError,
    renderGismtDisaggregationXml,
    sanitizeShiftExportFilenameSegment,
  } from "@markiro/domain";

  import {
    DISAGGREGATION_XML_FORMAT_ID,
    type DisaggregationReportRows,
  } from "../../host/protocol.js";
  import { exportFolder } from "../exports/export-checks.js";

  /**
   * The ЧЗ file of an applied disaggregation document (plan ДЗГ-О, owner
   * decision ПР-2): ГИС МТ «Расформирование упаковки», drawn by
   * `@markiro/domain`'s `renderGismtDisaggregationXml` — the inventory's own
   * generator — from every SSCC of the document, boxes and pallets. An empty
   * INN is refused here, as an export refuses it; the INN's form is the
   * generator's rule (9, 10 or 12 digits), not the shift XML's 10.
   */
  export function formDisaggregationXml(rows: DisaggregationReportRows): DisaggregationXmlResult {
    if (rows.status !== "applied") return { ok: false, refusal: "DOCUMENT_NOT_APPLIED" };
    const inn = rows.organization.inn?.trim() ?? "";
    if (inn === "") return { ok: false, refusal: "ORG_INN_MISSING" };
    if (rows.lines.length === 0) return { ok: false, refusal: "NO_PACKINGS" };
    try {
      const rendered = renderGismtDisaggregationXml({
        organizationInn: inn,
        ssccs: rows.lines.map((line) => line.sscc),
      });
      return {
        ok: true,
        file: {
          name: disaggregationXmlFileName(rows.docNo),
          bytes: rendered.bytes,
          packingCount: rendered.packingCount,
        },
      };
    } catch (error) {
      if (!(error instanceof GismtDisaggregationError)) throw error;
      switch (error.code) {
        case "INVALID_ORGANIZATION_INN":
          return { ok: false, refusal: "INVALID_ORG_INN" };
        case "INVALID_SSCC":
          return { ok: false, refusal: "INVALID_SSCC" };
        case "EMPTY_SOURCE":
          return { ok: false, refusal: "NO_PACKINGS" };
      }
    }
  }

  export function disaggregationXmlFileName(docNo: string): string {
    return `disaggregation-${sanitizeShiftExportFilenameSegment(docNo)}.xml`;
  }

  export function disaggregationXmlFolder(
    docNo: string,
    formedAt: string,
    timeZone: string,
  ): string[] {
    return [
      "Выгрузки",
      "Дезагрегация",
      ...exportFolder(docNo, DISAGGREGATION_XML_FORMAT_ID, formedAt, timeZone).slice(1),
    ];
  }
  ```

  Если TypeScript не видит исчерпанности `switch` внутри `catch` (функция без `return` в конце),
  добавить после `switch` строку `throw error;` — без приведений.

- [ ] **Шаг 3: красные тесты диалога** (`test/disaggregation-xml-dialog.test.tsx`):
  - кнопка «Файл для Честного знака» есть только у проведённого документа;
  - открытый диалог читает `getDisaggregationReportRows(token, id, "boxes")` и показывает:
    - число упаковок, ИНН организации, папку;
    - текст «Файл загружается в личный кабинет Честного знака вручную: раздел «Расформирование
      упаковки»»;
  - профиль без ИНН — предупреждение `ORG_INN_MISSING` (текст выгрузок
    `office.exports.failures.ORG_INN_MISSING`), кнопки «Сформировать» нет;
  - «Сформировать файл» перечитывает данные и вызывает `files.save(disaggregationXmlFolder(…),
[{ name: "disaggregation-DSG-26-0007.xml", bytes }])`. `bytes` побайтово равны
    `renderGismtDisaggregationXml(...)`. Затем `recordDisaggregationExport(token, id, {
formatId: "disaggregation_xml_gismt", formatVersion: 1, packingCount: 2 })`, текст «Файл
    сохранён в папке …» и «Показать папку» (`files.open(segments)`);
  - ошибка `save` (`OfficeFilesError("invalid_request")`) — текст
    `office.exports.files.invalid_request`, запись не вызывается;
  - ошибка записи — «Файл сохранён, но запись в журнал не прошла» с «Записать снова»; повтор
    шлёт ту же запись и файл не пересохраняет (как `recordAgain` в `ExportDialog.tsx`);
  - технолог формирует так же (Р10).

  Прогон — красный.

- [ ] **Шаг 4: реализация диалога.** `DisaggregationXmlDialog.tsx`:
  - `Modal` с телом из `DefinitionGrid` (упаковок, ИНН, папка) и подсказкой;
  - кнопки «Закрыть» и «Сформировать файл»;
  - этапы `reading → forming → saving → recording` в живой области;
  - исходы `saved` / `recordFailed` / `failed`, как поток `ExportDialog.tsx`:
    `readRows → formDisaggregationXml → files.save → api.recordDisaggregationExport`;
  - `formedAt = new Date().toISOString()`, зона — пропс `timeZone`.

  Тексты `office.disaggregation.xml`:

  ```json
  "xml": {
    "title": "Файл для Честного знака: {{docNo}}",
    "summary": "Документ «Расформирование упаковки» (ГИС МТ) по проведённому документу.",
    "packings": "Упаковок в файле",
    "inn": "ИНН участника оборота",
    "folder": "Папка",
    "manual": "Файл загружается в личный кабинет Честного знака вручную: раздел «Расформирование упаковки».",
    "submit": "Сформировать файл",
    "reading": "Читаем документ…",
    "forming": "Формируем файл…",
    "saving": "Сохраняем файл…",
    "recording": "Записываем в журнал…",
    "saved": "Файл сохранён в папке: {{path}}",
    "showFolder": "Показать папку",
    "recordFailed": "Файл сохранён, но запись в журнал не прошла.",
    "recordAgain": "Записать снова",
    "refusals": {
      "DOCUMENT_NOT_APPLIED": "Файл формируется только по проведённому документу.",
      "ORG_INN_MISSING": "Укажите ИНН организации на странице «Профиль организации»: без него документ для Честного знака не формируется.",
      "INVALID_ORG_INN": "ИНН организации не подходит для Честного знака. Проверьте ИНН на странице «Профиль организации».",
      "INVALID_SSCC": "У одной из строк некорректный SSCC — файл сформировать нельзя.",
      "NO_PACKINGS": "В документе нет ни одной упаковки."
    }
  }
  ```

- [ ] **Шаг 5: зелёные тесты** (два прогона диалога), typecheck, lint, prettier. Коммит
      `feat(standalone): office ЧЗ file «Расформирование упаковки» for an applied disaggregation document`.

## Задача 8: документация и итоговый гейт

**Files:** Modify `apps/standalone/AGENTS.md`,
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`.

- [ ] **Шаг 1: `AGENTS.md`.**
  - «Audit» — строка `disaggregation.export`: вторая, кроме `shift.export`, запись без изменения
    данных. Офис сохранил файл и записал его, все роли, без ревизии, цель — документ. Хост сверяет
    `packingCount` с SSCC документа, а сам файл не видит.
  - Новый раздел «Disaggregation in the office» (после «Shift card and printed forms»):
    - страницы и маршруты;
    - права (Р10);
    - разбор вставки и файла и отличие от облака по BOM (Р9);
    - данные акта (Р6) и обход по сменам;
    - зона и примечание акта (Р3, Р4) с эталонной цепочкой: слепки облака → фикстуры хоста →
      `test/disaggregation-act.test.ts`;
    - XML (Р7, Р8): генератор домена, правило ИНН, папка, запись;
    - что не проверено (WebView2, печать, приём файла в ЛК ЧЗ).
  - «Shift card and printed forms» — абзац о том, что `render-form.ts` рисует и акт, и где лежит
    `paint`.
  - «Verification» — ручные проверки ДЗГ-О (раздел «Проверки владельца» ниже).
- [ ] **Шаг 2: спецификация.** В §5.1 после «Эталонных проверок» — строка «Офис, акт и XML —
      реализовано планом ДЗГ-О (коммиты …)». Отличия от спецификации, если они появились при
      исполнении, перечисляются там же.
- [ ] **Шаг 3: полный гейт** (раздел «Итоговая проверка плана»), `git diff --check`, коммит
      `docs(standalone): plan ДЗГ-О — disaggregation office, act in the domain, ЧЗ file`.

## Итоговая проверка плана

- Домен: `pnpm … --filter @markiro/domain test`, `typecheck`, `lint`, `build`. Слепки — с
  `CI=true`.
- API (потребитель рендерера и `isParticipantInn`): `pnpm … --filter @markiro/api typecheck`,
  `lint`, `build`, `exec vitest run test/disaggregation-import.test.ts` и e2e дезагрегации и
  инвентаризации с `DATABASE_URL`, если он есть в окружении. Без него e2e пропускаются явно, и
  отчёт это называет.
- Автоном: `pnpm … --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- Rust: `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`;
  `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --workspace`.
  Если целиком не укладывается — частями: `-p markiro-proto`, `-p markiro-host`, затем крейт
  оболочки после `pnpm … --filter @markiro/standalone build`.
- `prettier --check` по всем изменённым файлам (слепки HTML исключены), `git diff --check`.
- `node <wt>/tools/ci/affected.mjs` (или как его зовёт CI — сверить в `.github/workflows/ci.yml`)
  на диффе ветки: задеты задачи домена, API и автонома. Перенос теста из `apps/api` в
  `packages/domain` не должен оставить проверку рендерера без задачи CI.
- Отчёт отдельно перечисляет автоматические проверки и то, что не проверено вживую («Не
  проверено»).

## Проверки владельца

1. **Акт на принтере A4 (Windows 10/11, WebView2):**
   - документ из двух коробов и одной паллеты, оба варианта, «Печать» и «Открыть в браузере»;
   - на листе:
     - номер `DSG-…`, дата и время проведения по местному времени, статус «Проведён»;
     - причина, комментарий, автор и проводивший;
     - внизу текст о ручной загрузке в ЛК ЧЗ, а не «передаются автоматически».
2. **DataMatrix полного варианта** читается сканером станции или ТСД: код совпадает с кодом на
   бутылке (с разделителем GS). Code128 SSCC читается.
3. **Длинный акт:** документ на 200 коробов по 20 кодов, полный вариант. Страницы нумеруются,
   строка короба не остаётся одна внизу страницы, окно не висит дольше нескольких секунд.
   Записать время.
4. **XML в ЛК Честного знака:**
   - загрузить файл проведённого документа в «Расформирование упаковки» под ИНН организации;
   - документ принят, короба (и паллета) в ЛК расформированы.

   Отдельно: что ЛК отвечает на SSCC, агрегация которого в ЧЗ не подавалась, — для текста
   подсказки.

5. **ИНН ИП (12 цифр):** если есть такой клиент, файл с 12-значным ИНН принят ЛК (вопрос
   ДЗГО-1).
6. **Импорт файла:** `.csv` из Excel (UTF-8 с BOM, разделитель `;`) и `.txt` из 1С. Все SSCC
   добавлены, первый не получил статус «не найден».
7. **Клавиатура:** список, документ, причины, оба диалога проходятся Tab, Enter и Esc, фокус
   видим, после проведения фокус на сообщении.
8. **Технолог:** создаёт и проводит документ, печатает акт, формирует XML; причины видит только
   для чтения.

## Открытые вопросы

- **ДЗГО-1 — ИНН в XML.** По умолчанию — правило генератора: 9, 10 или 12 цифр, то есть ИП с 12
  цифрами файл получает. XML агрегации смены принимает только 10 цифр. Если владелец хочет
  одинаковое правило, офис отказывает в формировании при ИНН не из 10 цифр — одна строка в
  `formDisaggregationXml` и текст `INVALID_ORG_INN` выгрузок.
- **ДЗГО-2 — текст под «Результатом операции».** По умолчанию —
  `DISAGGREGATION_MANUAL_UPLOAD_NOTE` (Р4). Вариант — печатать облачную фразу как есть: тогда
  офис не передаёт `operationNote`, а поле в домене остаётся неиспользованным.
- **ДЗГО-3 — логотип организации на акте.** По умолчанию нет, как на всех формах офиса (П15).
  Логотип в автономе уже есть (`org_logo.rs`), и его можно включить для всех форм одним
  изменением `reportOrg`. Это отдельная задача.
- **ДЗГО-4 — паллеты в XML.** По умолчанию SSCC паллеты идёт в файл вместе с коробами. Если ЧЗ
  ждёт паллеты отдельным документом или не принимает их в «Расформировании упаковки»,
  `formDisaggregationXml` фильтрует строки с `palletId`. Это проверка владельца 4.

## Риски

- **Интерфейсы ДЗГ отличаются от Р1.** Мера — задача 0 до кода, замена имён и запись в
  «Отклонения». Смысл задач не зависит от имён.
- **Время снятия кодов.** Если ДЗГ ставит `box_items.removed_at` не равным
  `boxes.disassembled_at`, полный акт проведённого документа печатает короба без кодов. Мера —
  тест задачи 4 (`the_full_act_prints_the_codes_the_document_took_out…`) и проверка в задаче 0.
- **Правки облака.** Перенос и аддитивные поля касаются `apps/api`. Мера — слепки до переноса,
  проверка с `CI=true`, `typecheck`/`build` API.
- **Пересборка `scans` в РЕЖ.** Запрос кодов идёт по `scans_shift`. Мера — `EXPLAIN QUERY PLAN`
  в задаче 4: если РЕЖ переименует индекс, тест покажет `SCAN`.
- **Общие файлы с другими потоками:** `ru.json`, `office/nav.ts`, `office/routes.tsx`,
  `office-query.ts`, `server.rs`, `audit.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`,
  `src/host/{protocol,api}.ts`, `test/support/office.tsx`, `test/protocol.test.ts` — с ДЗГ, КНФ,
  ТОВ, КРТ, ИСТ; `packages/domain/src/index.ts` — с ТОВ (`shift-task-form.ts` рядом). Это
  конфликты текста, а не логики. Слияние — после ДЗГ, перед КРТ (её кнопка «Расформировать»
  открывает страницу документа этого плана).
- **Большой полный акт.** Домен рисует синхронно, документ на тысячи коробов с DataMatrix
  замораживает окно на секунды, как «Состав короба». Мера — этапы в живой области и проверка
  владельца 3. Настоящее решение — рендер в worker, отдельной задачей.

## Не проверено

- Печать на реальном принтере, WebView2 и «Открыть в браузере» в Windows. Сохранение в
  «Документы» — только на временных папках macOS (как у выгрузок).
- Чтение DataMatrix акта сканером.
- Приём XML в ЛК ЧЗ — внешняя проверка владельца.
- E2e облака без `DATABASE_URL`.
- Интерфейсы ДЗГ на момент написания плана (Р1) — сверяются задачей 0.

## Отклонения при исполнении

_(заполняет исполнитель)_
