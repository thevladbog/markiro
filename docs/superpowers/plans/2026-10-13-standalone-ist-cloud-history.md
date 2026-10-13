# План ИСТ: история облачных смен в автономе — выгрузка истории по частям, исторические таблицы хоста, проверка владельца кода по облачной истории, перенос в офисе (инструмент выгрузки, протокол, хост, офис, поиск, конфликты, карточки, дезагрегация) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент облака уходит в автоном через ИМП, но смены не переносятся: хост не знает кодов,
собранных в облаке. Повторный скан такого кода в автономе проходит без отказа «дубль», и код
попадает в два отчёта об агрегации ЧЗ. Старый короб не находится поиском, не печатается и не
расформировывается. Решение владельца ПР-4 (вариант 2, 12 месяцев) и спецификация ИСТ задают
правила. После плана:

- инструмент `tools/standalone-export` по ключу `--history` делает файл истории:
  - закрытые облачные смены за 12 месяцев;
  - владельцы кодов (обоих режимов);
  - короба и паллеты с составом, полный код для кодов в коробах;
  - файл поделён на части по ~50 000 кодов, у каждой части свои контрольная сумма и `importId`;
- хост хранит историю в отдельных таблицах `legacy_*` (миграция `0026`):
  - принимает часть (только администратор, `dryRun`, повтор без вреда);
  - работает и после начала производства;
  - применяет правило самого раннего скана к пересечениям с кодами автонома;
- проверка владельца (`facts/registry.rs`, `GET /v1/device/codes/{hash}`) видит облачных
  владельцев:
  - при связи станция получает «дубль (хост)» с номером облачной смены;
  - без связи хост потом отвечает конфликтом с облачным победителем;
- офис на странице «Перенос из облака» переносит историю: пробный прогон с числом кодов и
  конфликтов, ход по частям, продолжение после обрыва, сводка перенесённого;
- после слияния соседних потоков: поиск кодов, «Конфликты», карточки короба и паллеты и
  дезагрегация видят перенесённые записи с пометкой «Из облака».

**Architecture:**

- **Инструмент (облако).** Второй SQL-документ `export-history.sql`: та же восстановленная копия,
  та же транзакция `REPEATABLE READ READ ONLY`, область арендатора. Он печатает поток строк JSON
  (`kind`: `header`, `shift`, `pallet`, `box`, `code`), коды — по сменам и коробам. `history.mjs`
  собирает части на лету и не держит коды в памяти. `cli.mjs --history` пишет файл NDJSON:
  первая строка — оглавление с контрольными суммами частей, дальше по строке на часть. Файл
  пишется целиком или никак (временный файл, fsync, жёсткая ссылка).
- **Протокол.** `proto/src/cloud_history.rs`: запрос части, сводка, состояние переноса,
  постоянная облачного устройства `CLOUD_OWNER_DEVICE_ID` (нулевой UUID). Форма ответов
  устройству (`CodeOwner`, `CodeCheck`, квитанция `conflict`) **не меняется**, поэтому
  `PROTOCOL_VERSION` не растёт (Р9).
- **Хост.**
  - Миграция `0026_cloud_history.sql`: `legacy_import_parts`, `legacy_shifts`, `legacy_pallets`,
    `legacy_boxes`, `legacy_codes`, `legacy_code_conflicts`, а также триггеры, которые держат
    код живым не больше чем в одном реестре.
  - `cloud_history.rs` — правила части без базы.
  - `routes/cloud_history.rs` — `POST|GET /v1/office/import/history`.
  - `facts/registry.rs` — владелец кода из двух реестров.
- **Офис.** `src/host/cloud-history.ts` (схемы, построчное чтение файла, контрольные суммы) и
  раздел `CloudHistorySection.tsx` на странице «Перенос из облака».
- **Зависимые задачи** (после слияния соседних потоков): объединение с `legacy_*` в поиске кодов
  (fb-codesearch), «Конфликтах» (КНФ), карточках (КРТ) и дезагрегации (ДЗГ).

**Tech Stack:** Rust (axum 0.8.9, sqlx 0.8.6 с SQLite 3.46 из `libsqlite3-sys` 0.30.1: `json_each`,
`->>`), serde, aws-lc-rs (SHA-256), uuid — `host`, `proto`. Node 24 (`node:test`, `node:crypto`,
`node:readline`, psql) — `tools/standalone-export`. React 19.2, TypeScript 6 strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, i18next, `@markiro/ui`
(`Card`, `Button`, `Alert`, `DefinitionGrid`, `FileDropZone`, `ConfirmDialog`), `@markiro/domain`
(`kmHash`, `canonicalizeKm`), Vitest 4.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-cloud-history-design.md` — правила для владельца
  (§3.1–3.7), проверки (§5), вопросы ИСТ-1…ИСТ-3. Спецификацию план не меняет.
- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` — §5.4, строка П-52,
  решение ПР-4, порядок волны 1 («ИСТ ждёт „Поиска кодов“ и ДЗГ»).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` §8 (ИМП), §8.7 (P7).
- `docs/runbooks/standalone-cloud-cutover.md` — памятка переключения (дополняется шагом истории).
- План ТОВ (`docs/superpowers/plans/2026-10-13-standalone-tov-product-egais.md`): формат файла
  ИМП 2. ИСТ идёт после него и не трогает файл ИМП; файл истории — отдельный формат.
- Облако, образец и эталон:
  - `packages/db/src/schema/platform.ts:181` (`shifts`), `:352` (`code_registry`: один владелец
    кода на арендатора, оба режима), `:906` (`boxes`: `pallet_id` — текущая паллета, `sscc` и
    `closed_at` при закрытии, `disassembled_at`), `:1054` (`box_items`: `displaced_at`,
    `removed_at`), `:1096` (`pallets`: `kind` production/warehouse);
  - `packages/db/src/schema/codes.ts` (`codes`: секционирована по `scanned_at`, ключ
    `(tenant_id, code_hash, scanned_at)`, `canonical_raw`);
  - `apps/api/src/modules/code-search/code-search.service.ts:1174` (`boxReportData`: коды
    короба — через `box_items.added_at = codes.scanned_at`), `:1423` (`palletPlacardData`);
  - `apps/api/src/modules/station-scans/dto.ts:81` — облако сверяет `kmHash(km)` с `codeHash`:
    хеш облака — та же функция `@markiro/domain`, что у автонома;
  - `apps/api/src/modules/shifts/shifts.service.ts:286` — дата производства смены
    `coalesce(production_date, planned_date)`.
- `apps/standalone/AGENTS.md`: «Cloud import», «Facts», «Office pages», «Backups and restore»,
  «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

- **Инструмент.**
  - `tools/standalone-export/export.sql:13` — одна транзакция
    `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, один `SELECT` с одним
    JSON-документом. `cli.mjs:182-201` (`runPsql`) читает весь stdout psql в память.
  - `test/export-sql-static.test.mjs:20-35` проверяет ровно три оператора и запрещённые слова;
    переменная арендатора — только `:'tenant_id'`.
  - `canonical.mjs` — канонический JSON и `fileChecksum` (`sha256:<hex>`). Тот же алгоритм
    повторяет офис (`src/host/cloud-import.ts:78-100`).
  - `cli.mjs:105-160` (`writeWhole`) — временный файл 0600, fsync, жёсткая ссылка или
    проверенное переименование.
  - `test/export-sql.test.mjs` — живой тест под `STANDALONE_EXPORT_TEST_DATABASE_URL`
    (CI `verify-api-tests`, `.github/workflows/ci.yml:170-172`), сиды `fixtures/seed-cloud.sql`
    и `fixtures/cleanup-cloud.sql`. Файлы `node --test` идут параллельно (`package.json:42`).
  - `.gitignore:80-81` — `markiro-cloud-export-*.json`, `.markiro-cloud-export-*.partial`.
- **Хост.**
  - `host/src/routes/cloud_import.rs:32` — `MAX_BODY_BYTES = 32 MiB`; `:380-398` — экстрактор
    `AdminImport` проверяет сессию и роль до чтения тела; `:59-79` — прежний импорт и его сводка
    из строки аудита `import.cloud` (`details.sourceTenantId`); `:406-472` — `begin_write`,
    повтор того же `importId`, откат `dryRun`.
  - `host/src/cloud_import.rs:115` — `is_month_key` (приватная), `:122` — `unique_id`.
  - `host/src/facts/registry.rs`: `Owner { scan_id, shift_id, shift_number, device_id,
scanned_at }` (`:20-26`), `owner` читает только `code_owners` (`:42-69`), `claim` (`:105-187`),
    `release` (`:192-199`).
  - `host/src/routes/codes.rs:30` отвечает по `registry::owner`.
  - `host/migrations/0010_facts.sql:120-140` — `code_owners` и `code_conflicts`
    (`winner_scan_id`/`loser_scan_id` ссылаются на `scans`).
  - `host/src/routes/facts.rs:43` — партия фактов берёт `begin_write`. `busy_timeout` пула 5 с
    (`host/src/db.rs:26`): запись части дольше 5 с уронила бы партию станции.
  - `host/src/facts/rules.rs:16` — приватный `sha256_hex`; `:67` — `is_code_hash`; `:50` —
    `device_instant` (24 символа). Хост хеш кода не пересчитывает: тестовый `code_hash(n)` —
    `format!("{n:064x}")` (`host/tests/support/app.rs:701`).
  - `host/src/backup/identity.rs:57` — `pub fn sha256_hex`.
  - `host/tests/no_secrets_in_logs.rs:2003` — модули импорта не пишут в журнал.
- **Станция (Zod).**
  - `src/host/protocol.ts:941-955`: `codeOwnerSchema` требует `shiftId: z.uuid()` и
    `deviceId: z.uuid()`. `z.uuid()` zod 4 принимает RFC-UUID версий 1–8 и нулевой
    `00000000-0000-0000-0000-000000000000`
    (`node_modules/zod/v4/core/regexes.js:22-26`).
  - Квитанция: `factReceiptSchema.details` — `z.record(z.string(), z.unknown())` (`:1005-1010`),
    победителя конфликта станция не разбирает.
  - `src/floor/work/scan-pipeline.ts:89-103,186-196` показывает `owner.shiftNumber` и
    `owner.scannedAt` («Дубль: код принят в смене {{number}} в {{time}}.», ключ
    `floor.work.last.duplicateHost`, `src/i18n/ru.json:205`).
- **Офис.** `src/office/import/CloudImportPage.tsx` хранит файл в `useRef`, шлёт через `call`, а не
  через `useOfficeMutation` (`:156-260`). `src/host/api.ts:221,583` — `importFromCloud`.
- **Соседние потоки** (кода в базе нет):
  - fb-codesearch: `office_codes.rs`, `proto/src/code_search.rs` (`OfficeCodeItem`,
    `OfficeCodeCard`), индексы `scans_ok_*`;
  - РЕЖ часть A: `0020` перестраивает `scans` и `code_owners`, `code_owners.box_id`
    становится NULL-допустимым, `registry::Claim.box_id: Option<&str>`;
  - КНФ: `0022`, `code_conflicts.kind`/`reviewed_by`, `GET /v1/office/conflicts`,
    `POST /v1/device/conflicts/status`, `GET /v1/device/displacements`;
  - КРТ и ДЗГ — планы в работе.

## Решения владельца

- **ПР-4 (2026-10-13):** «Вариант 2 за последние 12 месяцев». Переносятся закрытые облачные смены,
  закрытые не раньше чем за 12 месяцев до выгрузки, и по ним:
  - владельцы кодов — смен агрегации и смен проверки: реестр облака один на оба режима;
  - короба и паллеты с составом, включая полные коды для кодов в коробах.

  Повторных выгрузок старых смен для ЧЗ нет: вариант 3 не выбран.

- **Спецификация ИСТ §3** (правила для владельца) задаёт:
  - что видит офис;
  - отказ «дубль (хост)» при связи и конфликт без связи;
  - правило самого раннего скана при переносе после начала работы;
  - части по ~50 000 кодов и повтор без вреда;
  - отказ при изменении перенесённой смены;
  - нельзя удалить историю;
  - перенос делает администратор.

## Допущения

Планировщик принимает решения сам; вопросы владельцу — в конце.

- **Р1 — отдельные таблицы, одна строка на код.** `legacy_codes` объединяет «владельца» и
  «строку короба» брифа: облако переносит только живых владельцев, а у владельца не больше одного
  живого места в коробе. Ключ — `code_hash`, без rowid. Код живой, пока `left_at IS NULL`.
  - Вытеснение сканом автонома или расформирование офисом (ДЗГ) ставят
    `left_at`/`left_reason` и не удаляют строку.
  - Это вдвое меньше байт, чем две таблицы (владельцы + состав).
  - `legacy_box_items` и `legacy_code_owners` брифа слились в `legacy_codes`; остальные имена —
    как в брифе.
- **Р2 — облачный победитель на проводе.** Тот же `CodeOwner`:
  - `shiftId` — UUID облачной смены (облако делает v4, инструмент и хост проверяют RFC-вариант:
    станция читает его через `z.uuid()`);
  - `shiftNumber` — номер облачной смены по правилу `shifts::format_number`; облачный `admin`
    становится `office`;
  - `deviceId` — `CLOUD_OWNER_DEVICE_ID = "00000000-0000-0000-0000-000000000000"`: устройства с
    таким id нет, `z.uuid()` его принимает;
  - `sameDevice` — всегда `false`;
  - `scannedAt` — облачное время скана, приведённое к формату устройства (24 символа, мс).

  Старая станция разбирает такой ответ без изменений. Это закрепляет фикстура
  `code-check-taken-cloud.json`, её читают Rust и Vitest.

- **Р3 — правило самого раннего скана — одно на оба реестра.** Сравниваются тексты
  `scanned_at` в формате устройства. При равенстве код остаётся у текущего владельца, как
  сегодня.
  - **Скан станции позже облачного** — квитанция `conflict` с облачным победителем. Строка
    `legacy_code_conflicts`: `winner = 'legacy'`, `kind = 'late'`, `origin = 'fact'`.
  - **Скан станции раньше облачного** (часы станции или облако работало параллельно) — код
    переходит скану. Облачная строка получает `left_reason = 'displaced'`. Конфликт:
    `winner = 'scan'`, `kind = 'displaced'`.
  - **Перенос после смены автонома, облако раньше.** Строка `box_items` автонома получает
    `displaced_at`, строка `code_owners` удаляется. Облачная строка живая. Конфликт:
    `winner = 'legacy'`, `kind = 'displaced'`, `origin = 'import'`.
  - **Перенос после смены автонома, облако позже.** Облачная строка пишется ушедшей
    (`left_reason = 'displaced'`). Конфликт: `winner = 'scan'`, `kind = 'late'`.

  `kind` описывает проигравшего, как у КНФ: `late` — пришёл позже владельца, `displaced` — был
  владельцем и потерял код. Код живой не больше чем в одном реестре: это держат триггеры `0026`.

- **Р4 — части независимы.** Часть несёт целиком свои короба и все заголовки, на которые
  ссылается: смены, паллеты. Короб не делится между частями. Заголовок повторяется в каждой
  части, где он нужен.
  - **Порядок частей любой.** Повтор той же части (`importId`, тот же дайджест) отвечает
    сохранённой сводкой с `repeated: true`, без записи и аудита. Тот же `importId` с другим
    содержимым — `conflict` `part_mismatch`.
  - **Заголовок, уже перенесённый.** Строка в базе сравнивается по неизменным облачным полям:
    смена — номер, режим, GTIN, даты, `closed_at`; короб — смена, SSCC, время, паллета,
    расформирование облаком; код — смена, время, короб, GTIN, серийный номер, полный код.
    Совпало — «уже есть», иначе `conflict` `legacy_changed` с `entity` и `id` (спецификация
    §3.6).
  - **Описательные поля** (название товара, линии, срок годности) остаются первыми
    перенесёнными: облачный каталог мог измениться, а смена — нет.
  - **Признак `in_window`** только повышается с 0 до 1.
- **Р5 — что переносится.**
  - **Смены:** `status = 'closed'` и `closed_at >= windowFrom`.
  - **Короба:** закрытые (`sscc` из 18 цифр и `closed_at`) этих смен. Плюс короба складских
    паллет, закрытых в окне (спецификация §3.1); их смены за окном приходят заголовком с
    `in_window = false`, без прочих кодов.
  - **Паллеты:** закрытые производственные паллеты смен окна, складские паллеты окна и любая
    паллета, на которой стоит перенесённый короб. У короба `palletId` — его текущая паллета
    (`boxes.pallet_id`), если она перенесена, иначе `null`.
  - **Владельцы:** строки `code_registry` смен окна, плюс владельцы кодов коробов складских
    паллет окна.
  - **Короб владельца** — живая строка `box_items` с `added_at = registry.scanned_at` в
    закрытом коробе той же смены.
  - **Полный код** — `codes.canonical_raw` по ключу `(code_hash, scanned_at)`, как
    `boxReportData`; только у кода в коробе.
  - **Владелец в незакрытом облачном коробе** переносится без короба, с заметкой
    `owner_box_unclosed`.
  - **Владелец без строки `codes`** переносится только хешем (`gtin14`/`serial` = `null`), с
    заметкой `owner_text_missing`.
  - **Короб, расформированный в облаке**, переносится с `disassembledAt` и без кодов: его коды
    свободны (спецификация §3.2). Поэтому его «Состав короба» в автономе пуст, а облако печатает
    состав на момент расформирования. Это вопрос ИСТ-П2.
- **Р6 — окно.** `windowFrom` = момент выгрузки минус 12 календарных месяцев (UTC,
  `setUTCMonth`). Ключ `--history-since YYYY-MM-DD` задаёт другое начало (вопрос ИСТ-2).
  Незакрытые облачные смены не блокируют выгрузку: заметка `open_shifts` с номерами и строка в
  stderr. Новая выгрузка позже добавит их.
- **Р7 — привязка к площадке.** Часть принимается только после ИМП той же облачной организации:
  - есть строка аудита `import.cloud` с `details.sourceTenantId` = `source.tenantId` части,
    иначе `conflict` `base_import_missing` или `tenant_mismatch`;
  - `organizationGln` равен GLN площадки, иначе `conflict` `org_gln`.

  Площадка, заведённая без ИМП, историю не принимает (вопрос ИСТ-П4).

- **Р8 — короткая транзакция.** Все проверки без базы — до `begin_write`. В транзакции:
  - чтения заголовков и пересечений одним запросом каждое (`json_each` по массиву части с
    соединением на ключ);
  - вставки одним `INSERT … SELECT … FROM json_each(?)` на таблицу.

  Цель — часть из 50 000 кодов меньше чем за 2 с в release-сборке, с запасом до
  `busy_timeout` 5 с у партии фактов. Это измеряет тест объёма под `--ignored` (задача 8).
  Ревизия хоста не берётся: история не в ленте станций. Исключение — часть вытеснила коды
  автонома: тогда ревизия берётся, чтобы проснулись потоки, и после КНФ станция узнала о
  вытеснении.

- **Р9 — протокол.** Новых видов фактов нет, полей `data` фактов нет, `CodeOwner`/`CodeCheck`/
  `FactReceipt` не меняются. По правилу `proto/src/lib.rs:16-19` версия **не растёт**, резерв 9
  не используется. Новые маршруты — офисные.
- **Р10 — офис читает файл построчно.** `Blob.stream()` → `TextDecoderStream` → строки. Часть
  разбирается, сверяется (своя сумма, сумма в оглавлении, `exportId`, номер), отправляется и
  забывается. Файл истории (полные коды с криптохвостами) живёт только в переменных цикла: не
  в React-состоянии, не в кеше запросов, не в журнале. Сводки частей и состояние хоста кешируются
  как обычные данные.
- **Р11 — размер.** Оценка — около 400 байт на код в коробе с индексами и около 300 без короба:
  хеш как TEXT, PK без rowid, частичные индексы (смена — только без короба; короб — только в
  коробе). Это больше «200–250 байт» §3.7 спецификации. Офис показывает рост по постоянной
  `LEGACY_BYTES_PER_CODE = 400`; тест объёма меряет реальную величину и требует ±30 %. Вопрос
  ИСТ-П1.
- **Р12 — права и аудит.** Оба маршрута — только администратор (`require_admin` до чтения тела и
  `require_admin_in` в транзакции). Технолог получает `403`, устройство без сессии — `401`.
  - Строка аудита на каждую перенесённую часть: `import.cloud_history`, цель
    `cloud_history_part`/`importId`, `details = { importId, exportId, index, partCount,
checksum, summary }`. Ни хеша, ни кода в ней нет.
  - Повтор и `dryRun` аудита не пишут.
  - Модули истории не пишут в журнал (`no_secrets_in_logs.rs`).

## Global Constraints

**Правила продукта**

- Офлайн-первым: станция не меняется. Она спрашивает хост о коде, как сегодня, и получает
  квитанции, как сегодня. Без связи принятый станцией код позже становится конфликтом на хосте.
- Аудит точный: исполнитель, действие, цель, результат и детали проверяются в тестах дословно.
- Права: перенос и чтение состояния — только администратор; отказ технологу проверяется тестом.
- Целостность: часть переносится целиком или никак — одна транзакция. Повтор той же части даёт
  ту же сводку и тот же набор строк. Обрыв не портит данные.
- Перенесённая история не удаляется из офиса (спецификация §3.6), маршрута удаления нет.
- В ЧЗ ничего не уходит автоматически: XML паллеты для перенесённых паллет не предлагается
  (вариант 3 не выбран, ИСТ-3).

**Миграции и протокол (распределение 2026-10-13)**

- Host migrations already claimed by open branches: `0017` employees (fb-people), `0018` pallet-sheet defaults
  (fb-templates), `0019` code search (fb-codesearch), `0020`–`0021` shift modes (РЕЖ). Shell migrations: `0014`–`0015`
  (РЕЖ). Applied in the base: host `0001`–`0012`, `0015`, `0016`; shell `0001`–`0010`, `0012`, `0013`.
- Wave-1 parity allocation: КНФ host `0022`, shell `0016`; ТОВ host `0023`; ДЗГ host `0024`, shell `0017`;
  ДЗГ-О none; КРТ host `0025`; ИСТ host `0026`. A number a plan does not use stays a gap. Before the migration task
  the executor re-checks `ls apps/standalone/{host,src-tauri}/migrations` in `claude/integration` and the open
  `claude/fb-*` branches; if taken — next free number, written into «Отклонения».
- Indexes on `scans` / `code_owners` only in migrations after `0020` (РЕЖ part A rebuilds both tables and recreates
  only its own and code search's indexes). Queries must work with `code_owners.box_id` NULL (validation shifts).
- Device protocol: base `PROTOCOL_VERSION = 3`; РЕЖ takes 4 and 5. Reserved if a plan needs a bump (per the rule in
  `proto/src/lib.rs:16-19`: a new fact kind or a new field in a fact's `data`; answers tolerate unknown fields):
  КНФ 6, ТОВ 7, ДЗГ 8, ИСТ 9. Do not bump unless the rule requires it; at merge the constant takes the highest number.
- **ИСТ:** хост `0026`, оболочка — нет. Версию протокола ИСТ не поднимает (Р9). Триггеры `0026` на
  `code_owners` создаются после перестройки РЕЖ (`0020`). Будущая перестройка `code_owners` или
  `scans` обязана пересоздать их: это записывается в `AGENTS.md`.
- **Порядок.** ИСТ начинается после слияния в `claude/integration`:
  - РЕЖ часть A: `registry.rs` с `Claim.box_id: Option<&str>` и `code_owners.box_id` NULL;
  - ТОВ: формат ИМП 2 и правки `tools/standalone-export`.

  Задачи 10–13 идут каждая после слияния своего потока (fb-codesearch, КНФ, КРТ, ДЗГ). Если
  поток ещё не влит, задача откладывается и записывается в «Отклонения»; задачи 1–9 и 14 от них
  не зависят.

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!`; `import type`.
- Офис — только `@markiro/ui`, клавиатура и видимый фокус, строки — только
  `apps/standalone/src/i18n/ru.json`.
- Формы на проводе — фикстуры `proto/fixtures`, их читают Rust (`proto/tests`) и Vitest.
- Rust: `cargo fmt` чистый, без предупреждений. Не меняются: `Cargo.toml`, `Cargo.lock`,
  `package.json`, `pnpm-lock.yaml`. `pnpm install/add` — никогда.
- Новые миграции — только новыми файлами. Никогда `git stash`.
- Коммиты — с явными путями, трейлер одной строкой
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push и PR — не в этом плане.
- TDD: сначала падающий тест, затем код.

## Заметки для исполнения

- Worktree от `claude/integration` после слияния РЕЖ (часть A) и ТОВ. Зависимости — клоны APFS из
  `/tmp/claude/wt/integ`:
  - `cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`, `packages/*/node_modules`,
    `packages/*/dist`;
  - для cargo — ещё `apps/standalone/target`.
- Команды (`<wt>` — абсолютный путь worktree):
  - Vitest: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <файлы>`;
  - пакет целиком: `… --filter @markiro/standalone test`, `typecheck`, `lint`;
  - инструмент: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false test:standalone-export`;
    живой тест SQL — с `STANDALONE_EXPORT_TEST_DATABASE_URL` на одноразовый Postgres 17 с
    миграциями облака (`pnpm --filter @markiro/db db:migrate` против него), никогда на общий;
  - Rust: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-host --test cloud_history`
    (крейты: `markiro-host`, `markiro-proto`, оболочка `markiro-standalone`);
    `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`;
  - объём: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --release -p markiro-host --test cloud_history_volume -- --ignored --nocapture`.
- Интеграционные тесты хоста на `TestApp` сокета не открывают. Песочница отключается только для
  `cloud_import_logs.rs` (loopback).
- Перед `cargo test -p markiro-standalone` собрать webview (`tauri::generate_context!` читает `dist`).
- React-тесты раздела (задача 9) прогоняются дважды:
  - один раз с `--reporter=verbose`, в выводе не должно быть `stderr |`;
  - второй раз под стендом с задержкой `setImmediate` на 3 мс: временные
    `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ; после прогона
    удалить.
- Если `rtk` урезал вывод — `rtk proxy <команда>`.

## Файлы

- **Создать:**
  - инструмент: `tools/standalone-export/{export-history.sql,history.mjs}`,
    `tools/standalone-export/test/{export-history-static,history,cli-history}.test.mjs`,
    `tools/standalone-export/test/fixtures/{seed-history.sql,raw-history.ndjson}`;
  - протокол: `apps/standalone/proto/src/cloud_history.rs`,
    `apps/standalone/proto/tests/cloud_history.rs`;
  - фикстуры: `apps/standalone/proto/fixtures/{km-hash-cases.json,cloud-history-file.ndjson,cloud-history-summary.json,cloud-history-state.json,code-check-taken-cloud.json}`;
  - хост: `apps/standalone/host/migrations/0026_cloud_history.sql`,
    `apps/standalone/host/src/{cloud_history.rs,legacy.rs}`,
    `apps/standalone/host/src/routes/cloud_history.rs`;
  - тесты хоста: `apps/standalone/host/tests/{cloud_history,cloud_history_schema,cloud_history_volume}.rs`;
  - офис: `apps/standalone/src/host/cloud-history.ts`,
    `apps/standalone/src/office/import/{CloudHistorySection.tsx,history-run.ts}`;
  - тесты офиса: `apps/standalone/test/{km-hash-parity,cloud-history,cloud-history-section}.test.ts(x)`.
- **Изменить:**
  - `tools/standalone-export/cli.mjs`, `tools/standalone-export/test/export-sql.test.mjs`,
    `tools/standalone-export/test/fixtures/cleanup-cloud.sql`, `.gitignore`;
  - `apps/standalone/proto/src/lib.rs` (`pub mod cloud_history;`);
  - `host/src/{lib.rs,audit.rs,server.rs}`, `host/src/facts/{registry.rs,rules.rs}`,
    `host/src/routes/mod.rs`, `host/src/cloud_import.rs` (`is_month_key` → `pub(crate)`);
  - тесты хоста: `host/tests/{facts,codes,no_secrets_in_logs}.rs`, `host/tests/support/app.rs`;
  - офис: `src/host/{api.ts,protocol.ts}`, `src/office/import/CloudImportPage.tsx`,
    `src/office/office-query.ts`, `src/i18n/ru.json`;
  - тесты офиса: `test/{protocol,api,cloud-import-page}.test.ts(x)`;
  - документы: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-cloud-cutover.md`,
    `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` (отметка в §5.4).
- **Зависимые задачи:**
  - задача 10: `host/src/routes/office_codes.rs`, `proto/src/code_search.rs`, офис поиска;
  - задача 11: маршруты КНФ и офис «Конфликты»;
  - задача 12: маршруты и офис КРТ;
  - задача 13: проверка и проведение ДЗГ.

---

## Задача 1: один хеш кода — фикстура паритета облака и автонома

**Files:** Create `apps/standalone/proto/fixtures/km-hash-cases.json`,
`apps/standalone/test/km-hash-parity.test.ts`; Modify `apps/standalone/host/src/facts/rules.rs`,
`apps/standalone/host/tests/codes.rs` (или новый модуль теста в `rules.rs`).

**Interfaces:**

```rust
// facts/rules.rs
/// The domain's `kmHash` (`packages/domain/src/gs1/km.ts:119`): SHA-256 of
/// `01{gtin14}21{serial}` in lower-case hex — the cloud's `code_hash` too
/// (`apps/api/src/modules/station-scans/dto.ts:81`). The history import
/// checks every cloud code with it (plan ИСТ).
pub fn km_hash(gtin14: &str, serial: &str) -> String;
pub(crate) fn sha256_hex(bytes: &[u8]) -> String; // was private
```

- [ ] **Шаг 1: фикстура.** Значения посчитаны командой
      `printf '010460068200001321HIST000000N' | shasum -a 256`. Сверить их той же командой перед
      записью.

  ```json
  {
    "note": "kmHash = SHA-256 of 01{gtin14}21{serial}; the cloud's code_hash, the standalone's codeHash",
    "cases": [
      {
        "raw": "]d2010460068200001321HIST0000001\u001d91EE07\u001d92TAIL0001",
        "canonical": "010460068200001321HIST0000001\u001d91EE07\u001d92TAIL0001",
        "gtin14": "04600682000013",
        "serial": "HIST0000001",
        "codeHash": "42651e540039f5e2dd28f4be0eb532ca58defb40f0c2b0ad743fe193b1430565"
      },
      {
        "raw": "010460068200001321HIST0000004",
        "canonical": "010460068200001321HIST0000004",
        "gtin14": "04600682000013",
        "serial": "HIST0000004",
        "codeHash": "7dabfc29986607c1c8f888c422322c758cdf49fd32d88c54fea1846a1334df26"
      },
      {
        "raw": "  010460068200001321HIST0000005\u001d91EE07\u001d92TAIL0005\t",
        "canonical": "010460068200001321HIST0000005\u001d91EE07\u001d92TAIL0005",
        "gtin14": "04600682000013",
        "serial": "HIST0000005",
        "codeHash": "54935ef398b62a9b3463a1941f88a1a567ecaa38e8acdb66e11b90a91b9f960a"
      }
    ]
  }
  ```

- [ ] **Шаг 2: красные тесты.**

  Vitest (`test/km-hash-parity.test.ts`):

  ```ts
  import { readFileSync } from "node:fs";
  import { canonicalizeKm, kmHash } from "@markiro/domain";
  import { describe, expect, it } from "vitest";
  import { z } from "zod";

  const casesSchema = z.object({
    cases: z.array(
      z.object({
        raw: z.string(),
        canonical: z.string(),
        gtin14: z.string(),
        serial: z.string(),
        codeHash: z.string(),
      }),
    ),
  });
  const { cases } = casesSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/km-hash-cases.json", import.meta.url), "utf8"),
    ),
  );

  describe("the cloud's code_hash and the standalone's codeHash are one function (plan ИСТ)", () => {
    it.each(cases)("$serial", (each) => {
      const km = canonicalizeKm(each.raw);
      expect(km.raw).toBe(each.canonical);
      expect(km.gtin14).toBe(each.gtin14);
      expect(km.serial).toBe(each.serial);
      expect(kmHash(km)).toBe(each.codeHash);
    });
  });
  ```

  Rust (в `host/tests/codes.rs`):

  ```rust
  #[test]
  fn the_hosts_km_hash_is_the_domains_and_the_clouds() {
      let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/fixtures/km-hash-cases.json");
      let fixture: serde_json::Value =
          serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
      for case in fixture["cases"].as_array().unwrap() {
          assert_eq!(
              markiro_host::facts::rules::km_hash(
                  case["gtin14"].as_str().unwrap(),
                  case["serial"].as_str().unwrap()
              ),
              case["codeHash"].as_str().unwrap()
          );
      }
  }
  ```

  Третья сторона — инструмент — проверяет ту же фикстуру в задаче 4 (`kmHashOf`).

  Прогон (должен упасть: `km_hash` нет):
  - `cargo … test -p markiro-host --test codes`;
  - `pnpm … exec vitest run test/km-hash-parity.test.ts` — зелёный уже сейчас, это эталон.

- [ ] **Шаг 3: реализация.**

  ```rust
  pub fn km_hash(gtin14: &str, serial: &str) -> String {
      sha256_hex(format!("01{gtin14}21{serial}").as_bytes())
  }
  ```

- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, prettier по фикстуре и тесту, коммит**
      `test(standalone): one code hash for the cloud and the standalone — kmHash parity fixture read by the domain, the host and the export tool`.

## Задача 2: протокол истории — типы, фикстуры, Zod, `HostApi`

**Files:** Create `apps/standalone/proto/src/cloud_history.rs`,
`apps/standalone/proto/tests/cloud_history.rs`, фикстуры `cloud-history-summary.json`,
`cloud-history-state.json`, `code-check-taken-cloud.json`, `apps/standalone/src/host/cloud-history.ts`,
`apps/standalone/test/cloud-history.test.ts`; Modify `apps/standalone/proto/src/lib.rs`,
`apps/standalone/src/host/api.ts`, `apps/standalone/test/{protocol,api}.test.ts`.

Golden-файл `cloud-history-file.ndjson` делает инструмент в задаче 4. Тесты этой задачи, которые
читают его, помечаются `#[ignore = "golden from task 4"]` / `it.skip`, а задача 4 снимает пометку.
Порядок можно и поменять: задача 4 до задачи 2, если исполнителю удобнее.

**Interfaces (Rust, `proto/src/cloud_history.rs`):**

```rust
//! The cloud's shift history moved into a site (plan ИСТ, spec
//! 2026-10-13-standalone-cloud-history-design.md). The export tool writes a
//! file of NDJSON lines: a header (`kind: "header"`) with the parts'
//! checksums, then one line per part (`kind: "part"`). The office sends each
//! part as [`CloudHistoryRequest`]: the part's fields without `kind` and
//! `format`, with `dryRun` and the header's `partCount`. A part holds full
//! codes of marking with their crypto tails: never log one.

use serde::{Deserialize, Serialize};

use crate::cloud_import::CloudImportSource;
use crate::{ShiftMode, ShiftOrigin};

pub const CLOUD_HISTORY_FORMAT: &str = "markiro-cloud-history";
pub const CLOUD_HISTORY_FORMAT_VERSION: u32 = 1;
/// The most codes the tool puts in one part; a box is never split.
pub const CLOUD_HISTORY_PART_CODES: u32 = 50_000;
/// The device a cloud owner is named by in a `CodeOwner`: no device of a
/// site has it, and a station's `z.uuid()` reads it.
pub const CLOUD_OWNER_DEVICE_ID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryRequest {
    /// The part's own id (a UUID the tool made): the same part sent again
    /// after a lost answer gets its stored summary back.
    pub import_id: String,
    pub dry_run: bool,
    pub format_version: u32,
    pub export_id: String,
    pub exported_at: String,
    /// 1-based.
    pub index: u32,
    pub part_count: u32,
    /// The tool's `sha256:<hex>` of the part line (the office checked it).
    pub checksum: String,
    pub source: CloudImportSource,
    pub organization_gln: String,
    pub payload: CloudHistoryPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPayload {
    pub shifts: Vec<CloudHistoryShift>,
    pub pallets: Vec<CloudHistoryPallet>,
    pub boxes: Vec<CloudHistoryBox>,
    pub codes: Vec<CloudHistoryCode>,
}

/// A closed cloud shift. `inWindow: false` — a shift older than the window
/// whose box stands on a warehouse pallet closed in it (spec §3.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryShift {
    pub id: String,
    pub month_key: String,
    pub seq: u32,
    pub origin: ShiftOrigin,
    pub mode: ShiftMode,
    pub gtin14: String,
    pub product_name: String,
    pub shelf_life_days: Option<u32>,
    pub line_name: Option<String>,
    /// The declared production day (`YYYY-MM-DD`), else `null`.
    pub production_date: Option<String>,
    pub planned_date: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: String,
    pub in_window: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudPalletKind {
    Production,
    Warehouse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPallet {
    pub id: String,
    pub kind: CloudPalletKind,
    /// The production pallet's shift; `null` for a warehouse pallet.
    pub shift_id: Option<String>,
    pub gtin14: String,
    pub product_name: String,
    pub shelf_life_days: Option<u32>,
    pub sscc: String,
    pub opened_at: String,
    pub closed_at: String,
    pub disassembled_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryBox {
    pub id: String,
    pub shift_id: String,
    pub sscc: String,
    pub opened_at: String,
    pub closed_at: String,
    pub pallet_id: Option<String>,
    pub disassembled_at: Option<String>,
    /// How many of the part's codes name this box: the box is whole.
    pub units: u32,
}

/// A code the cloud's registry held at the export: `canonical` (the full
/// code with its crypto tail) only for a code in a box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryCode {
    pub code_hash: String,
    pub shift_id: String,
    pub scanned_at: String,
    pub gtin14: Option<String>,
    pub serial: Option<String>,
    pub box_id: Option<String>,
    pub canonical: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHistorySummary {
    pub dry_run: bool,
    pub repeated: bool,
    pub index: u32,
    pub part_count: u32,
    pub shifts_added: u32,
    pub shifts_present: u32,
    pub pallets_added: u32,
    pub pallets_present: u32,
    pub boxes_added: u32,
    pub boxes_present: u32,
    pub codes_added: u32,
    pub codes_present: u32,
    pub full_codes_added: u32,
    /// Codes of this site's scans the history took (the cloud scanned them earlier).
    pub site_displaced: u32,
    /// Codes of the history this site's earlier scans keep.
    pub history_late: u32,
}

/// `GET /v1/office/import/history`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHistoryState {
    pub base_import: Option<CloudHistoryBase>,
    pub parts: Vec<CloudHistoryPartRecord>,
    pub totals: CloudHistoryTotals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHistoryBase {
    pub source_tenant_id: String,
    pub imported_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHistoryPartRecord {
    pub import_id: String,
    pub export_id: String,
    pub index: u32,
    pub part_count: u32,
    pub checksum: String,
    pub imported_at: String,
    pub summary: CloudHistorySummary,
}

/// Sums of the parts' summaries (no count over millions of rows) and the
/// window of the shifts moved in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHistoryTotals {
    pub shifts: u32,
    pub pallets: u32,
    pub boxes: u32,
    pub codes: u32,
    pub full_codes: u32,
    pub conflicts: u32,
    pub closed_from: Option<String>,
    pub closed_to: Option<String>,
}
```

`proto/src/lib.rs`: `pub mod cloud_history;` рядом с `pub mod cloud_import;` (`:192`).

**Interfaces (TS, `src/host/cloud-history.ts`):**

```ts
export const CLOUD_HISTORY_FORMAT = "markiro-cloud-history";
/** Mirrors `markiro_proto::cloud_history::CLOUD_HISTORY_FORMAT_VERSION`. */
export const CLOUD_HISTORY_FORMAT_VERSION = 1;
/** Mirrors `CLOUD_OWNER_DEVICE_ID`. */
export const CLOUD_OWNER_DEVICE_ID = "00000000-0000-0000-0000-000000000000";
/** Bytes a moved code takes in the host's database with its indexes (plan ИСТ, Р11). */
export const LEGACY_BYTES_PER_CODE = 400;

export const historyPayloadSchema: z.ZodType<…>; // strict at every level, the Rust types exactly
export const historyHeaderSchema = z.strictObject({
  kind: z.literal("header"),
  format: z.literal(CLOUD_HISTORY_FORMAT),
  formatVersion: z.number().int(),
  tool: z.string(),
  exportId: z.uuid(),
  exportedAt: z.iso.datetime(),
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  source: z.strictObject({ tenantId: z.string(), tenantName: z.string() }),
  organization: z.strictObject({ gln: z.string(), inn: z.string().nullable() }),
  totals: z.strictObject({
    shifts: count, pallets: count, boxes: count, codes: count, fullCodes: count,
  }),
  parts: z.array(z.strictObject({
    index: z.number().int().positive(), importId: z.uuid(),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u), codes: count,
  })),
  notes: z.array(exportNoteSchema),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
export const historyPartSchema = z.strictObject({
  kind: z.literal("part"), format: z.literal(CLOUD_HISTORY_FORMAT),
  formatVersion: z.number().int(), exportId: z.uuid(), exportedAt: z.iso.datetime(),
  index: z.number().int().positive(), importId: z.uuid(),
  source: z.strictObject({ tenantId: z.string(), tenantName: z.string() }),
  organizationGln: z.string(), payload: historyPayloadSchema,
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
export const cloudHistorySummarySchema = z.object({ … }); // the Rust fields, camelCase
export const cloudHistoryStateSchema = z.object({ … });
export type HistoryHeader = z.infer<typeof historyHeaderSchema>;
export type HistoryPart = z.infer<typeof historyPartSchema>;
export interface CloudHistoryRequest { importId: string; dryRun: boolean; formatVersion: number;
  exportId: string; exportedAt: string; index: number; partCount: number; checksum: string;
  source: HistoryPart["source"]; organizationGln: string; payload: HistoryPart["payload"]; }
export function historyRequest(header: HistoryHeader, part: HistoryPart, dryRun: boolean): CloudHistoryRequest;
```

`exportNoteSchema` и `fileChecksum` переиспользуются из `src/host/cloud-import.ts` (экспортированы,
`:17`, `:91`). `HostApi` получает:

```ts
importCloudHistoryPart: (token: string, request: CloudHistoryRequest) =>
  Promise<CloudHistorySummary>;
cloudHistoryState: (token: string) => Promise<CloudHistoryState>;
```

пути `POST|GET /v1/office/import/history`, по образцу `importFromCloud` (`src/host/api.ts:583`).

- [ ] **Шаг 1: фикстуры.**
  - `code-check-taken-cloud.json` — ответ `GET /v1/device/codes/{hash}` с облачным владельцем:
    ```json
    {
      "status": "taken",
      "owner": {
        "shiftId": "05050000-0000-4000-8000-000000000001",
        "shiftNumber": "OCT26-006",
        "deviceId": "00000000-0000-0000-0000-000000000000",
        "scannedAt": "2026-10-09T09:03:00.000Z",
        "sameDevice": false
      }
    }
    ```
  - `cloud-history-summary.json` — сводка части 2 golden-файла на чистой после ИМП площадке:
    `{ "dryRun": false, "repeated": false, "index": 2, "partCount": 3, "shiftsAdded": 1,
"shiftsPresent": 0, "palletsAdded": 1, "palletsPresent": 0, "boxesAdded": 2,
"boxesPresent": 0, "codesAdded": 3, "codesPresent": 0, "fullCodesAdded": 3,
"siteDisplaced": 0, "historyLate": 0 }`.
  - `cloud-history-state.json` — состояние после трёх частей golden-файла: `baseImport`
    (`sourceTenantId: "imp-test-atoll"`, время — `START` тестовых часов в формате хоста), три
    записи `parts`, а также `totals`:
    `{ "shifts": 4, "pallets": 2, "boxes": 4, "codes": 6, "fullCodes": 5, "conflicts": 0,
"closedFrom": "2026-09-30T17:00:00.000Z", "closedTo": "2026-10-10T12:00:00.000Z" }`.
    `closedFrom`/`closedTo` берутся только по сменам `in_window`, поэтому смена SEP25-012 в окно
    не входит. Время частей тест хоста подставляет из часов `TestApp`. Точные значения
    `importedAt` записать после первого зелёного прогона задачи 6: тест сравнивает с фикстурой
    все поля.
- [ ] **Шаг 2: красные тесты.**
  - `proto/tests/cloud_history.rs`:
    - круговой разбор `CodeCheck` из `code-check-taken-cloud.json`, `CloudHistorySummary`,
      `CloudHistoryState`;
    - каждая строка-часть golden-файла (`ignore` до задачи 4) без `kind`/`format`, с `dryRun` и
      `partCount`, разбирается в `CloudHistoryRequest`;
    - лишнее поле в коде (`"raw": "…"`) — ошибка (`deny_unknown_fields`);
    - `CLOUD_OWNER_DEVICE_ID` разбирается `uuid::Uuid::parse_str` и равен `Uuid::nil()`:
      `uuid` в dev-зависимостях proto проверить по `proto/Cargo.toml`; если его нет — сравнить со
      строкой из 36 символов.
  - `test/protocol.test.ts`: `codeCheckSchema.parse(fixture("code-check-taken-cloud.json"))`
    проходит — это и есть «старая станция принимает облачного владельца».
  - `test/cloud-history.test.ts`:
    - `historyHeaderSchema` и `historyPartSchema` разбирают golden-строки (`skip` до задачи 4);
    - `historyRequest(header, part, true)` даёт тело с `partCount` из оглавления и без
      `kind`/`format`;
    - строгие схемы отказывают лишнему полю на каждом уровне.
  - `test/api.test.ts`: `importCloudHistoryPart` шлёт `POST /v1/office/import/history`,
    `cloudHistoryState` — `GET`; ответы читаются схемами.

  Прогон: `cargo … test -p markiro-proto --test cloud_history`,
  `pnpm … exec vitest run test/protocol.test.ts test/cloud-history.test.ts test/api.test.ts` —
  красные.

- [ ] **Шаг 3: реализация** по интерфейсам.
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, lint, prettier, коммит**
      `feat(standalone): cloud history on the wire — the part request, summary and state; a cloud owner in CodeOwner (no protocol bump)`.

## Задача 3: инструмент — SQL истории, статический и живой тест

**Files:** Create `tools/standalone-export/export-history.sql`,
`tools/standalone-export/test/export-history-static.test.mjs`,
`tools/standalone-export/test/fixtures/{seed-history.sql,raw-history.ndjson}`; Modify
`tools/standalone-export/test/export-sql.test.mjs`,
`tools/standalone-export/test/fixtures/cleanup-cloud.sql`.

Живой тест истории живёт **в `export-sql.test.mjs`**, а не в своём файле: оба сеют арендатора
`imp-test-atoll`, а `node --test` запускает файлы параллельно. Внутри одного файла тесты верхнего
уровня идут по очереди.

- [ ] **Шаг 1: статический тест (красный, файла нет).**

  ```js
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { test } from "node:test";

  /** What export-history.sql may be, without a database (plan ИСТ). */
  const sql = readFileSync(new URL("../export-history.sql", import.meta.url), "utf8");
  const bare = sql.replace(/--[^\n]*/gu, "").replace(/'(?:[^']|'')*'/gu, "''");
  const statements = bare
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter((statement) => statement !== "");

  test("one read-only repeatable-read transaction around a header and four data SELECTs", () => {
    assert.equal(statements.length, 7, statements.map((each) => each.slice(0, 40)).join(" | "));
    assert.equal(statements[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.match(statements[1], /^SELECT json_build_object\( '', ''/u);
    for (const statement of statements.slice(2, 6)) assert.match(statement, /^WITH win AS \(/u);
    assert.equal(statements[6], "COMMIT");
  });

  test("the four data SELECTs read the same scope, byte for byte", () => {
    const scope = (statement) => statement.slice(0, statement.indexOf(" rows AS ("));
    const first = scope(statements[2]);
    assert.ok(first.length > 200, "the scope was not found");
    for (const statement of statements.slice(3, 6)) assert.equal(scope(statement), first);
  });

  test("export-history.sql holds nothing that writes, and binds its two variables quoted", () => {
    const forbidden =
      /\b(?:insert|update|delete|drop|create|alter|truncate|grant|revoke|copy|vacuum|analyze|lock|call|do|merge|refresh|reindex|cluster|comment|set|reset|notify|listen|prepare|execute|into|nextval|setval|lastval|set_config|pg_[a-z_]+|lo_[a-z_]+|dblink[a-z_]*)\b/iu;
    const found = forbidden.exec(bare);
    assert.equal(found, null, `export-history.sql uses ${found?.[0]}`);
    assert.doesNotMatch(bare, /^\s*\\/mu);
    assert.doesNotMatch(bare, /:tenant_id\b|:window_from\b/u);
    assert.ok(bare.includes(":''"), "the variables are quoted");
  });
  ```

  Прогон `pnpm … test:standalone-export` — красный.

- [ ] **Шаг 2: `export-history.sql`.**

  Формат времени повторяется: `to_char(x AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` —
  это формат устройства, 24 символа, мс (хост сравнивает облачное время с временем станции как
  текст).

  ```sql
  -- The cloud's closed shifts of the last 12 months with their code owners,
  -- boxes and pallets, for the standalone's history import (plan ИСТ, spec
  -- 2026-10-13-standalone-cloud-history-design.md). Run by `cli.mjs --history`
  -- through psql against a RESTORED COPY of the cloud database:
  -- `psql -X -q -A -t -v ON_ERROR_STOP=1 -v tenant_id=<id> -v window_from=<RFC 3339> -f export-history.sql`.
  -- One read-only REPEATABLE READ transaction: the five SELECTs read one
  -- snapshot, so a box, its codes and its pallet agree. Every query is scoped
  -- to :'tenant_id'. Each row is one line of JSON with its `kind` (psql -A -t
  -- prints a row per line, and JSON text holds no raw line break), in this
  -- order: the header, the shifts, the pallets, the boxes, the codes — codes by
  -- shift and box, so cli.mjs builds the parts as it reads and never holds the
  -- codes in memory. The four data SELECTs open with the same scope (`win` …
  -- `pallet_set`), byte for byte (export-history-static.test.mjs). The output
  -- holds full codes with their crypto tails: cli.mjs never prints one.
  BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

  SELECT json_build_object(
    'kind', 'header',
    'formatVersion', 1,
    'tenant', (SELECT json_build_object('id', o.id, 'name', o.name)
      FROM organization o WHERE o.id = :'tenant_id'),
    'organization', (SELECT json_build_object('gln', p.gln, 'inn', p.inn)
      FROM org_profiles p WHERE p.tenant_id = :'tenant_id'),
    'windowFrom', :'window_from'::text,
    'openShifts', coalesce((SELECT json_agg(json_build_object(
        'monthKey', s.number_month_key, 'seq', s.number_seq, 'createdFrom', s.created_from)
        ORDER BY s.number_month_key, s.number_seq, s.id)
      FROM shifts s WHERE s.tenant_id = :'tenant_id' AND s.status = 'active'), '[]'::json)
  );

  WITH win AS (
    SELECT s.id FROM shifts s
    WHERE s.tenant_id = :'tenant_id' AND s.status = 'closed'
      AND s.closed_at >= :'window_from'::timestamptz
  ),
  wpal AS (
    SELECT p.id FROM pallets p
    WHERE p.tenant_id = :'tenant_id' AND p.kind = 'warehouse' AND p.sscc ~ '^[0-9]{18}$'
      AND p.closed_at >= :'window_from'::timestamptz
  ),
  box_set AS (
    SELECT b.id, b.shift_id, b.pallet_id FROM boxes b
    JOIN shifts s ON s.tenant_id = b.tenant_id AND s.id = b.shift_id AND s.status = 'closed'
    WHERE b.tenant_id = :'tenant_id' AND b.sscc ~ '^[0-9]{18}$' AND b.closed_at IS NOT NULL
      AND (b.shift_id IN (SELECT id FROM win) OR b.pallet_id IN (SELECT id FROM wpal))
  ),
  shift_set AS (
    SELECT id, true AS in_window FROM win
    UNION ALL
    SELECT DISTINCT shift_id, false FROM box_set WHERE shift_id NOT IN (SELECT id FROM win)
  ),
  pallet_set AS (
    SELECT p.id FROM pallets p
    WHERE p.tenant_id = :'tenant_id' AND p.sscc ~ '^[0-9]{18}$' AND p.closed_at IS NOT NULL
      AND (p.shift_id IN (SELECT id FROM win) OR p.id IN (SELECT id FROM wpal)
        OR p.id IN (SELECT pallet_id FROM box_set))
  ),
  rows AS (
    SELECT s.id, s.number_month_key, s.number_seq, s.created_from, s.mode, s.production_date,
      s.planned_date, s.opened_at, s.closed_at, ss.in_window, pr.gtin14, pr.name AS product_name,
      pr.shelf_life_days, l.name AS line_name
    FROM shift_set ss
    JOIN shifts s ON s.tenant_id = :'tenant_id' AND s.id = ss.id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    LEFT JOIN lines l ON l.tenant_id = s.tenant_id AND l.id = s.line_id
  )
  SELECT json_build_object('kind', 'shift', 'id', r.id, 'monthKey', r.number_month_key,
    'seq', r.number_seq, 'createdFrom', r.created_from, 'mode', r.mode,
    'gtin14', r.gtin14::text, 'productName', r.product_name, 'shelfLifeDays', r.shelf_life_days,
    'lineName', r.line_name, 'productionDate', r.production_date::text,
    'plannedDate', r.planned_date::text,
    'openedAt', to_char(r.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closedAt', to_char(r.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'inWindow', r.in_window)
  FROM rows r ORDER BY r.closed_at, r.id;
  ```

  Три оставшихся `SELECT` начинаются **тем же** блоком `WITH win AS (…) … pallet_set AS (…),`
  (скопировать дословно) и отличаются только `rows` и выборкой:

  ```sql
  -- pallets
  rows AS (
    SELECT p.id, p.kind, p.shift_id, p.sscc, p.opened_at, p.closed_at, p.disassembled_at,
      pr.gtin14, pr.name AS product_name, pr.shelf_life_days
    FROM pallet_set ps
    JOIN pallets p ON p.tenant_id = :'tenant_id' AND p.id = ps.id
    LEFT JOIN shifts s ON s.tenant_id = p.tenant_id AND s.id = p.shift_id
    JOIN products pr ON pr.tenant_id = p.tenant_id
      AND pr.id = coalesce(p.product_id, s.product_id)
  )
  SELECT json_build_object('kind', 'pallet', 'id', r.id, 'palletKind', r.kind,
    'shiftId', r.shift_id, 'gtin14', r.gtin14::text, 'productName', r.product_name,
    'shelfLifeDays', r.shelf_life_days, 'sscc', r.sscc::text,
    'openedAt', to_char(r.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closedAt', to_char(r.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'disassembledAt', to_char(r.disassembled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM rows r ORDER BY r.closed_at, r.id;
  ```

  Ключ вида паллеты в строке — `palletKind`: `kind` занят видом строки. Сборщик (задача 4)
  переименовывает его в `kind` части (`CloudHistoryPallet.kind`). `to_char` от `NULL` даёт
  `NULL`, поэтому необязательные моменты приходят как `null`.

  ```sql
  -- boxes: units = the box's live items its shift's registry owns
  rows AS (
    SELECT b.id, b.shift_id, b.sscc, b.opened_at, b.closed_at, b.disassembled_at,
      CASE WHEN b.pallet_id IN (SELECT id FROM pallet_set) THEN b.pallet_id END AS pallet_id,
      (SELECT count(*) FROM box_items bi
        JOIN code_registry r ON r.tenant_id = bi.tenant_id AND r.code_hash = bi.code_hash
          AND r.shift_id = b.shift_id AND r.scanned_at = bi.added_at
        WHERE bi.tenant_id = b.tenant_id AND bi.box_id = b.id
          AND bi.displaced_at IS NULL AND bi.removed_at IS NULL) AS units
    FROM box_set bs JOIN boxes b ON b.tenant_id = :'tenant_id' AND b.id = bs.id
  )
  SELECT json_build_object('kind', 'box', 'id', r.id, 'shiftId', r.shift_id, 'sscc', r.sscc::text,
    'openedAt', …, 'closedAt', …, 'palletId', r.pallet_id, 'disassembledAt', …, 'units', r.units)
  FROM rows r JOIN shifts s ON s.tenant_id = :'tenant_id' AND s.id = r.shift_id
  ORDER BY s.closed_at, s.id, r.closed_at, r.id;
  ```

  ```sql
  -- codes: owners of the window's shifts, plus owners of the boxes of the
  -- window's warehouse pallets from older shifts; each with its box (a live
  -- item of a closed box of its shift, added at the owner's scan) and, only
  -- in a box, its full code
  rows AS (
    SELECT o.code_hash, o.shift_id, o.scanned_at, item.box_id, item.box_closed_at
    FROM (
      SELECT r.code_hash, r.shift_id, r.scanned_at FROM code_registry r
      WHERE r.tenant_id = :'tenant_id' AND r.shift_id IN (SELECT id FROM win)
      UNION
      SELECT r.code_hash, r.shift_id, r.scanned_at FROM box_set bs
      JOIN box_items bi ON bi.tenant_id = :'tenant_id' AND bi.box_id = bs.id
        AND bi.displaced_at IS NULL AND bi.removed_at IS NULL
      JOIN code_registry r ON r.tenant_id = bi.tenant_id AND r.code_hash = bi.code_hash
        AND r.shift_id = bs.shift_id AND r.scanned_at = bi.added_at
      WHERE bs.shift_id NOT IN (SELECT id FROM win)
    ) o
    LEFT JOIN LATERAL (
      SELECT b.id AS box_id, b.closed_at AS box_closed_at FROM box_items bi
      JOIN boxes b ON b.tenant_id = bi.tenant_id AND b.id = bi.box_id AND b.shift_id = o.shift_id
        AND b.sscc ~ '^[0-9]{18}$' AND b.closed_at IS NOT NULL
      WHERE bi.tenant_id = :'tenant_id' AND bi.code_hash = o.code_hash
        AND bi.added_at = o.scanned_at AND bi.displaced_at IS NULL AND bi.removed_at IS NULL
      LIMIT 1
    ) item ON true
  )
  SELECT json_build_object('kind', 'code', 'codeHash', r.code_hash, 'shiftId', r.shift_id,
    'scannedAt', to_char(r.scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'gtin14', c.gtin14::text, 'serial', c.serial, 'boxId', r.box_id,
    'canonical', CASE WHEN r.box_id IS NOT NULL THEN c.canonical_raw END)
  FROM rows r
  JOIN shifts s ON s.tenant_id = :'tenant_id' AND s.id = r.shift_id
  LEFT JOIN codes c ON c.tenant_id = :'tenant_id' AND c.code_hash = r.code_hash
    AND c.scanned_at = r.scanned_at
  ORDER BY s.closed_at, s.id, r.box_closed_at NULLS LAST, r.box_id NULLS LAST, r.scanned_at,
    r.code_hash;

  COMMIT;
  ```

  Индексы облака, на которые опирается запрос:
  - `code_registry_tenant_shift_terminal_idx` — владельцы смены;
  - `box_items_tenant_code_idx` — короб владельца;
  - PK `codes (tenant_id, code_hash, scanned_at)` — полный код;
  - PK `box_items` — `units`.

  Тест шага 4 печатает `EXPLAIN` для данных сида и проверяет, что `codes` читается `Index Scan`
  по ключу. Это закрепляет план на маленьких данных; объём проверяет владелец, проверка 1.

- [ ] **Шаг 3: сид и сырой эталон.**

  `fixtures/seed-history.sql` идёт поверх `seed-cloud.sql` (тот же арендатор, товар
  `0e0e…0001` «Молоко 3,2% 0,9 л», GTIN `04600682000013`, линии «Линия 1» `0a0a…0001` и
  «Упаковка» `0a0a…0002`, станция `0a0d…0001`). Секции `codes` создаются через
  `CREATE TABLE IF NOT EXISTS … PARTITION OF codes`, только в сиде. Хеши — из задачи 1, полный
  код — `010460068200001321HIST000000N` + `E'\x1d91EE07\x1d92TAIL000N'`.

  - Смены (новые) — `…0010` SEP25-12 `station`, закрыта 2025-09-01 15:00 (вне окна); `…0011` OCT26-8 `validation`, открыта 2026-10-10 06:00, закрыта 12:00, дата 2026-10-10, «Упаковка»; `…0012` AUG25-3, закрыта 2025-08-01 15:00
  - Паллеты — P1 `0b0d…0010` производственная смены `…0001`, SSCC `146006820000300009`, 2026-10-09 08:00–11:00; W1 `0b0d…0011` складская, товар `0e0e…0001`, станция `0a0d…0001`, SSCC `146006820000300016`, 2026-10-01 08:00–09:00
  - Короба — BX1 `0b0c…0011` смена `…0001`, SSCC `046006820000300017`, 09:00–10:00, на P1; BX2 `…0012` смена `…0001`, `046006820000300024`, 10:30–12:00, расформирован 2026-10-10 08:00 (получено 08:00:05); BX3 `…0013` смена `…0010`, `046006820000300031`, 2025-09-01 09:00–10:00, на W1; BX4 `…0014` смена `…0004`, `046006820000300048`, 2026-09-30 08:55–10:00; BX5 `…0015` смена `…0012`, `046006820000300055`, 2025-08-01
  - `box_items` — BX1: HIST1 09:01, HIST2 09:02, HIST3 09:03, HIST6 09:05 (`displaced_at` 09:30); BX2: HIST7 10:31 (`removed_at` = 2026-10-10 08:00:05); BX3: HIST5 2025-09-01 09:30; BX4: HIST6 2026-09-30 09:00; BX5: HIST8 2025-08-01 09:30
  - `codes` — по строке на каждый скан выше, включая обе строки HIST6
  - `code_registry` — HIST1–3 → `…0001` (их время), HIST4 → `…0011` 2026-10-10 10:00 (без короба), HIST5 → `…0010`, HIST6 → `…0004` 2026-09-30 09:00, HIST8 → `…0012`. HIST7 свободен

  `cleanup-cloud.sql`: в начало добавить `DELETE FROM code_registry …`, `DELETE FROM box_items …`,
  `DELETE FROM codes …` для обоих арендаторов (до `boxes` и `shifts`).

  `fixtures/raw-history.ndjson` — ровно то, что печатает SQL при `window_from =
2025-10-13T09:00:00.000Z`. Строки 1–7 (заголовок, смены, паллеты), полностью:

  ```text
  {"kind":"header","formatVersion":1,"tenant":{"id":"imp-test-atoll","name":"ООО «Атолл»"},"organization":{"gln":"4600682000010","inn":"7701234567"},"windowFrom":"2025-10-13T09:00:00.000Z","openShifts":[]}
  {"kind":"shift","id":"05050000-0000-4000-8000-000000000010","monthKey":"SEP25","seq":12,"createdFrom":"station","mode":"aggregation","gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"lineName":"Линия 1","productionDate":"2025-09-01","plannedDate":null,"openedAt":"2025-09-01T06:00:00.000Z","closedAt":"2025-09-01T15:00:00.000Z","inWindow":false}
  {"kind":"shift","id":"05050000-0000-4000-8000-000000000004","monthKey":"SEP26","seq":41,"createdFrom":"admin","mode":"aggregation","gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"lineName":"Линия 1","productionDate":null,"plannedDate":null,"openedAt":null,"closedAt":"2026-09-30T17:00:00.000Z","inWindow":true}
  {"kind":"shift","id":"05050000-0000-4000-8000-000000000001","monthKey":"OCT26","seq":6,"createdFrom":"admin","mode":"aggregation","gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"lineName":"Линия 1","productionDate":null,"plannedDate":null,"openedAt":null,"closedAt":"2026-10-09T17:00:00.000Z","inWindow":true}
  {"kind":"shift","id":"05050000-0000-4000-8000-000000000011","monthKey":"OCT26","seq":8,"createdFrom":"admin","mode":"validation","gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"lineName":"Упаковка","productionDate":"2026-10-10","plannedDate":null,"openedAt":"2026-10-10T06:00:00.000Z","closedAt":"2026-10-10T12:00:00.000Z","inWindow":true}
  {"kind":"pallet","id":"0b0d0000-0000-4000-8000-000000000011","palletKind":"warehouse","shiftId":null,"gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"sscc":"146006820000300016","openedAt":"2026-10-01T08:00:00.000Z","closedAt":"2026-10-01T09:00:00.000Z","disassembledAt":null}
  {"kind":"pallet","id":"0b0d0000-0000-4000-8000-000000000010","palletKind":"production","shiftId":"05050000-0000-4000-8000-000000000001","gtin14":"04600682000013","productName":"Молоко 3,2% 0,9 л","shelfLifeDays":10,"sscc":"146006820000300009","openedAt":"2026-10-09T08:00:00.000Z","closedAt":"2026-10-09T11:00:00.000Z","disassembledAt":null}
  ```

  Дальше короба в порядке BX3, BX4, BX1, BX2:
  - `units` — 1, 1, 3, 0;
  - BX2 с `disassembledAt` `2026-10-10T08:00:00.000Z` и `palletId: null`.

  Потом коды в порядке HIST5, HIST6, HIST1, HIST2, HIST3, HIST4:
  - у кода в коробе — `canonical`;
  - у HIST4 — `"boxId":null,"canonical":null`.

  HIST7 (снят расформированием), HIST8 (смена вне окна), смена `…0012`, BX5 и вытесненная строка
  HIST6 в BX1 в эталон **не входят**. Это и есть эталон §5 спецификации: состав совпадает с
  облачными `code_registry`, `boxes`, `box_items`, `pallets`.

- [ ] **Шаг 4: живой тест (красный без SQL), в `export-sql.test.mjs`:**

  ```js
  const exportHistorySql = fileURLToPath(new URL("../export-history.sql", import.meta.url));

  test(
    "export-history.sql prints the window's shifts, owners, boxes and pallets exactly as the raw fixture",
    { skip: databaseUrl ? false : `set ${URL_VARIABLE} to a disposable cloud database` },
    async () => {
      const env = pgEnv(databaseUrl);
      psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
      psqlRun(env, ["-f", fixture("seed-cloud.sql")]);
      psqlRun(env, ["-f", fixture("seed-history.sql")]);
      try {
        const lines = [];
        await runPsqlLines({
          psql,
          tenantId: "imp-test-atoll",
          windowFrom: "2025-10-13T09:00:00.000Z",
          env,
          onLine: (line) => lines.push(JSON.parse(line)),
        });
        const expected = readFileSync(fixture("raw-history.ndjson"), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line));
        assert.deepEqual(lines, expected);
      } finally {
        psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
      }
    },
  );
  ```

  Второй тест — «транзакция истории отказывает записи». Он по образцу соседнего теста
  `export.sql` в этом файле, тем же приёмом (запись внутри транзакции скрипта до `COMMIT`) и с
  тем же ожиданием текста ошибки Postgres. Найти образец:
  `rtk proxy grep -n "READ ONLY\|read-only\|cannot execute" tools/standalone-export/test/export-sql.test.mjs`.
  `runPsqlLines` экспортируется из `cli.mjs` (задача 4). До задачи 4 тест читает вывод через
  `psqlScript` и разбивает stdout по строкам.

  Ещё один тест того же файла: окно `2026-10-01T00:00:00.000Z`. Тогда смены `…0010` и `…0004` в
  окно не входят, но `…0010` приходит с `inWindow: false` через W1 (закрыта 2026-10-01 09:00);
  `…0004` и BX4/HIST6 не приходят. Это проверка правила складской паллеты.

- [ ] **Шаг 5: зелёные тесты** на одноразовом Postgres 17 с миграциями облака, затем без
      переменной: живые тесты пропущены, статические зелёные. Коммит
      `feat(standalone-export): the history SQL — the window's closed shifts, their code owners, boxes and pallets, one read-only snapshot`.

## Задача 4: инструмент — части, оглавление, `cli.mjs --history`, golden-файл

**Files:** Create `tools/standalone-export/history.mjs`,
`tools/standalone-export/test/{history,cli-history}.test.mjs`,
`apps/standalone/proto/fixtures/cloud-history-file.ndjson`; Modify `tools/standalone-export/cli.mjs`,
`.gitignore`.

**Interfaces:**

```js
// history.mjs
export const HISTORY_FORMAT = "markiro-cloud-history";
export const HISTORY_FORMAT_VERSION = 1;
export const PART_CODES = 50_000;
/** The host reads at most 32 MiB a request; a part stays below 30 MiB. */
export const MAX_PART_BYTES = 30 * 1024 * 1024;
/** The domain's kmHash: SHA-256 of 01{gtin14}21{serial} (km-hash-cases.json). */
export function kmHashOf(gtin14, serial);
/** `exportedAt` minus 12 calendar months, UTC (Р6). */
export function windowStart(exportedAt);
/** The shift's number as the standalone writes it: MONYY-NNN, `/S` for a station's. */
export function shiftNumber(monthKey, seq, createdFrom);
/**
 * Builds the parts from the rows in export-history.sql's order: `push(row)`
 * for each, `finish()` once; each finished part goes to `onPart(line)` (its
 * NDJSON line, no trailing newline). Throws `ExportError`.
 */
export function createHistoryBuilder({ exportedAt, exportId, partCodes, randomUuid, onPart, tool });
// returns { push(row): void, finish(): HistoryHeader }
```

`ExportError` и `plainText` — из `transform.mjs`, `fileChecksum` — из `canonical.mjs`. Коды
отказа:

- `history_output_invalid` — строка не того вида или не в том порядке;
- `history_empty` — нет ни одной смены;
- `history_part_too_large` — часть больше `MAX_PART_BYTES`;
- `history_hash_mismatch` — `kmHashOf(gtin14, serial) !== codeHash`.

Сообщение отказа называет вид строки и id, но никогда не полный код.

- [ ] **Шаг 1: красные тесты** (`test/history.test.mjs`):

  ```js
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { test } from "node:test";

  import { fileChecksum } from "../canonical.mjs";
  import { createHistoryBuilder, kmHashOf, shiftNumber, windowStart } from "../history.mjs";
  import { ExportError } from "../transform.mjs";

  const rows = () =>
    readFileSync(new URL("./fixtures/raw-history.ndjson", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  const golden = () =>
    readFileSync(
      new URL("../../../apps/standalone/proto/fixtures/cloud-history-file.ndjson", import.meta.url),
      "utf8",
    );
  const uuids = () => {
    let n = 0;
    return () => `4a1e0000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
  };

  // cli.mjs draws the export id first, then a part's import id per part:
  // the golden file holds export id …0001 and parts …0002 to …0004.
  function build(input, partCodes = 3) {
    const parts = [];
    const next = uuids();
    const builder = createHistoryBuilder({
      exportedAt: "2026-10-13T09:00:00.000Z",
      exportId: next(),
      partCodes,
      randomUuid: next,
      tool: "standalone-export/1",
      onPart: (line) => parts.push(JSON.parse(line)),
    });
    for (const row of input) builder.push(row);
    return { header: builder.finish(), parts };
  }

  test("the raw fixture becomes the golden history file the office and the host read", () => {
    const { header, parts } = build(rows());
    const text = [header, ...parts].map((each) => JSON.stringify(each)).join("\n") + "\n";
    assert.equal(text, golden());
  });

  test("a box is never split, and every part carries the headers it names", () => {
    const { header, parts } = build(rows());
    assert.deepEqual(
      parts.map((part) => part.payload.codes.map((code) => code.serial)),
      [
        ["HIST0000005", "HIST0000006"],
        ["HIST0000001", "HIST0000002", "HIST0000003"],
        ["HIST0000004"],
      ],
    );
    for (const part of parts) {
      const shifts = new Set(part.payload.shifts.map((shift) => shift.id));
      const pallets = new Set(part.payload.pallets.map((pallet) => pallet.id));
      const boxes = new Map(part.payload.boxes.map((box) => [box.id, box]));
      for (const box of boxes.values()) {
        assert.ok(shifts.has(box.shiftId));
        if (box.palletId !== null) assert.ok(pallets.has(box.palletId));
        assert.equal(part.payload.codes.filter((code) => code.boxId === box.id).length, box.units);
      }
      for (const code of part.payload.codes) assert.ok(shifts.has(code.shiftId));
      assert.equal(part.checksum, fileChecksum(part));
    }
    assert.deepEqual(header.totals, { shifts: 4, pallets: 2, boxes: 4, codes: 6, fullCodes: 5 });
    assert.deepEqual(
      header.parts.map((each) => [each.index, each.codes, each.checksum]),
      parts.map((part) => [part.index, part.payload.codes.length, part.checksum]),
    );
    assert.equal(header.checksum, fileChecksum(header));
  });

  test("the empty box of a disassembled cloud box goes with its shift, without codes", () => {
    const { parts } = build(rows());
    const second = parts[1].payload;
    assert.deepEqual(
      second.boxes.map((box) => [box.sscc, box.units, box.disassembledAt]),
      [
        ["046006820000300017", 3, null],
        ["046006820000300024", 0, "2026-10-10T08:00:00.000Z"],
      ],
    );
  });

  test("the hashes are kmHash, and a code whose hash is not is refused", () => {
    const cases = JSON.parse(
      readFileSync(
        new URL("../../../apps/standalone/proto/fixtures/km-hash-cases.json", import.meta.url),
        "utf8",
      ),
    ).cases;
    for (const each of cases) assert.equal(kmHashOf(each.gtin14, each.serial), each.codeHash);
    const broken = rows().map((row) =>
      row.kind === "code" && row.serial === "HIST0000001" ? { ...row, serial: "HIST0000009" } : row,
    );
    assert.throws(
      () => build(broken),
      (error) =>
        error instanceof ExportError &&
        error.code === "history_hash_mismatch" &&
        !error.message.includes("TAIL"),
    );
  });

  test("notes: open shifts, owners in unclosed boxes and owners without text", () => {
    /* header.openShifts [{monthKey:"OCT26",seq:7,createdFrom:"admin"}] → note
       { code: "open_shifts", numbers: ["OCT26-007"] }; an aggregation code with boxId null →
       { code: "owner_box_unclosed", count: 1 }; gtin14/serial null → { code: "owner_text_missing", count: 1 } */
  });

  test("windowStart takes 12 calendar months; shiftNumber writes /S for a station's", () => {
    assert.equal(windowStart("2026-10-13T09:00:00.000Z"), "2025-10-13T09:00:00.000Z");
    assert.equal(shiftNumber("SEP25", 12, "station"), "SEP25-012/S");
    assert.equal(shiftNumber("OCT26", 6, "admin"), "OCT26-006");
  });

  test("rows out of order, a non-RFC shift id and an empty history are refused", () => {
    /* a code before the boxes → history_output_invalid; shift id "05050000-0000-0000-0000-000000000001"
       (version 0) → history_output_invalid; only a header → history_empty */
  });
  ```

  `test/cli-history.test.mjs`:
  - `main(["--tenant","imp-test-atoll","--out-dir",dir,"--history"], deps)` с поддельным
    `runLines`, который отдаёт строки `raw-history.ndjson`. В `deps` также
    `now: () => new Date("2026-10-13T09:00:00.000Z")`, `randomUuid: uuids()`,
    `historyPartCodes: 3`.
  - Код выхода 0, файл `markiro-cloud-history-7701234567-2026-10-13.ndjson` побайтно равен
    golden.
  - Права 0600 (кроме Windows); в каталоге нет файлов `.partial`.
  - stdout — сводка: файл, окно, «Смен 4, коробов 4, паллет 2, кодов 6 (с полным кодом 5)»,
    «Частей: 3», контрольная сумма. В stdout и stderr нет ни `TAIL`, ни хеша кода.
  - stderr — предупреждение о полных кодах.
  - Без `--history` поведение прежнее (тесты `cli.test.mjs` не меняются).
  - `--history-since 2026-10-01` передаёт `window_from=2026-10-01T00:00:00.000Z`;
    `--history-since 2026-13-01` → 64; `--history-since` позже выгрузки → 64.
  - Сбой записи (`FS.linkSync` бросает) — нет ни итогового, ни временных файлов.
  - Отказ сборки (`history_hash_mismatch`) → код 2, текст «Выгрузка невозможна: …», файла нет.

  Прогон `pnpm … test:standalone-export` — красный.

- [ ] **Шаг 2: `history.mjs`.** Ядро сборщика:

  ```js
  export function createHistoryBuilder({
    exportedAt,
    exportId,
    partCodes = PART_CODES,
    randomUuid = randomUUID,
    onPart,
    tool,
  }) {
    let header = null;
    let stage = 0; // 0 header, 1 shifts, 2 pallets, 3 boxes, 4 codes
    const shifts = new Map(),
      pallets = new Map(),
      boxes = new Map(),
      boxesOfShift = new Map();
    const placed = { shifts: new Set(), pallets: new Set(), boxes: new Set() };
    const counts = { ownerBoxUnclosed: 0, ownerTextMissing: 0, fullCodes: 0, codes: 0 };
    const index = [];
    let part = fresh();
    let shiftNow = null,
      boxNow = null,
      boxSeen = 0;

    function fresh() {
      return { shifts: new Map(), pallets: new Map(), boxes: new Map(), codes: [] };
    }
    const STAGES = { header: 0, shift: 1, pallet: 2, box: 3, code: 4 };

    function addShift(id) {
      const shift = shifts.get(id);
      if (shift === undefined) throw invalid("code", id, "names a shift the export did not print");
      part.shifts.set(id, shift);
      placed.shifts.add(id);
    }
    function addPallet(id) {
      const pallet = pallets.get(id);
      if (pallet === undefined) throw invalid("box", id, "names a pallet the export did not print");
      if (pallet.shiftId !== null) addShift(pallet.shiftId);
      part.pallets.set(id, pallet);
      placed.pallets.add(id);
    }
    function addBox(box) {
      addShift(box.shiftId);
      if (box.palletId !== null) addPallet(box.palletId);
      part.boxes.set(box.id, box);
      placed.boxes.add(box.id);
    }
    function endBox() {
      if (boxNow !== null && boxSeen !== boxes.get(boxNow).units)
        throw invalid("box", boxNow, "its units are not its codes");
      boxNow = null;
      boxSeen = 0;
    }
    function endShift() {
      endBox();
      if (shiftNow === null) return;
      for (const id of boxesOfShift.get(shiftNow) ?? []) {
        const box = boxes.get(id);
        if (!placed.boxes.has(id) && box.units === 0) addBox(box);
      }
      shiftNow = null;
    }
    function flush() {
      if (part.shifts.size === 0) return;
      const line = {
        kind: "part",
        format: HISTORY_FORMAT,
        formatVersion: HISTORY_FORMAT_VERSION,
        exportId,
        exportedAt,
        index: index.length + 1,
        importId: randomUuid(),
        source: { tenantId: header.tenant.id, tenantName: plainText(header.tenant.name, 200) },
        organizationGln: header.organization.gln,
        payload: {
          shifts: [...part.shifts.values()],
          pallets: [...part.pallets.values()],
          boxes: [...part.boxes.values()],
          codes: part.codes,
        },
        checksum: "",
      };
      line.checksum = fileChecksum(line);
      const text = JSON.stringify(line);
      if (Buffer.byteLength(text, "utf8") > MAX_PART_BYTES)
        throw new ExportError("history_part_too_large", `part ${line.index} is over 30 MiB`);
      index.push({
        index: line.index,
        importId: line.importId,
        checksum: line.checksum,
        codes: part.codes.length,
      });
      onPart(text);
      part = fresh();
    }
    function code(row) {
      if (row.shiftId !== shiftNow) {
        endShift();
        shiftNow = row.shiftId;
      }
      const shift = shifts.get(row.shiftId);
      if (row.boxId !== boxNow) {
        endBox();
        if (row.boxId !== null) {
          const box = boxes.get(row.boxId);
          if (box === undefined || box.shiftId !== row.shiftId)
            throw invalid("code", row.codeHash, "names a box of another shift");
          if (part.codes.length > 0 && part.codes.length + box.units > partCodes) flush();
          addBox(box);
          boxNow = row.boxId;
        }
      }
      if (row.boxId === null && part.codes.length >= partCodes) flush();
      addShift(row.shiftId);
      if (row.gtin14 !== null && kmHashOf(row.gtin14, row.serial) !== row.codeHash)
        throw new ExportError(
          "history_hash_mismatch",
          `the code ${row.codeHash} of shift ${row.shiftId} is not kmHash of its text`,
        );
      if (row.gtin14 === null) counts.ownerTextMissing += 1;
      if (row.boxId === null && shift?.mode === "aggregation") counts.ownerBoxUnclosed += 1;
      if (row.boxId !== null) {
        boxSeen += 1;
        counts.fullCodes += 1;
      }
      counts.codes += 1;
      part.codes.push({
        codeHash: row.codeHash,
        shiftId: row.shiftId,
        scannedAt: row.scannedAt,
        gtin14: row.gtin14,
        serial: row.serial,
        boxId: row.boxId,
        canonical: row.canonical,
      });
    }
    // push(row): checks `STAGES[row.kind] >= stage` (order), the shape of each kind (ids RFC UUID
    // by the regex of zod's z.uuid(), 24-character instants, 18-digit SSCC, `createdFrom`
    // admin→office, names through plainText(…, 200) and lines plainText(…, 100), pallet
    // `palletKind` → `kind`), fills the maps, and calls code() for codes.
    // finish(): endShift(); every shift, pallet and box not placed yet goes to the last part
    // (a shift without codes, a pallet without moved boxes); flush(); index.length === 0 and no
    // shift → history_empty; returns the header with its checksum.
  }
  ```

  Оглавление:

  ```js
  const header = {
    kind: "header",
    format: HISTORY_FORMAT,
    formatVersion: HISTORY_FORMAT_VERSION,
    tool,
    exportId,
    exportedAt,
    window: { from: raw.windowFrom, to: exportedAt },
    source: { tenantId, tenantName },
    organization: { gln, inn },
    totals: { shifts, pallets, boxes, codes, fullCodes },
    parts: index,
    notes,
    checksum: "",
  };
  header.checksum = fileChecksum(header);
  ```

  Порядок ключей в объектах — как в коде выше: golden побайтный, а `JSON.stringify` сохраняет
  порядок вставки.

- [ ] **Шаг 3: `cli.mjs`.**
  - `parseArgs`:
    - `--history` (флаг);
    - `--history-since <YYYY-MM-DD>` — настоящая дата, иначе ошибка → 64;
    - `--history-since` без `--history` → 64.
  - `runPsqlLines({ psql, tenantId, windowFrom, env, onLine })`: `spawn` с теми же ключами, что
    `runPsql`, плюс `-v window_from=<…>`, `-f export-history.sql`.
    `readline.createInterface({ input: child.stdout })` — на каждую непустую строку `onLine`;
    `close` с кодом 0 — успех. Текст строки в ошибку не попадает: `parseRaw`-подобная обёртка
    «psql printed a line that is not JSON».
  - `historyFileName(header)` → `markiro-cloud-history-<INN или tenant>-<YYYY-MM-DD>.ndjson`.
  - `writeHistory(path, header, partsPath, fs = FS)`:
    - части во время чтения пишутся во временный файл того же каталога
      (`.markiro-cloud-history-…<pid>-<hex>.parts.partial`, `wx`, 0600);
    - в конце — второй временный файл: строка оглавления, затем копия частей блоками по 1 МиБ,
      `fsync`, `linkSync` (или проверенное переименование на FAT, как `writeWhole`);
    - оба временных файла удаляются при любом исходе.
  - `historySummary(header, path)` — строки сводки по-русски без кода и хеша;
    `HISTORY_WARNING`:
    ```js
    export const HISTORY_WARNING = [
      "ВНИМАНИЕ: файл истории содержит полные коды маркировки с криптохвостами.",
      "Храните его только у себя (флешка владельца), не пересылайте и УДАЛИТЕ сразу после переноса.",
    ];
    ```
  - `USAGE` дополняется строками `--history` и `--history-since`; заметка `open_shifts`
    печатается в stderr: «смена OCT26-007 не закрыта: её коды не перенесены».
  - `main`: при `options.history` — ветка истории с `deps.runLines`, `deps.randomUuid`,
    `deps.historyPartCodes` (по умолчанию `runPsqlLines`, `randomUUID`, `PART_CODES`). Первый
    вызов `randomUuid()` — `exportId`, следующие — `importId` частей: на этом стоит golden.

  `.gitignore`: добавить `markiro-cloud-history-*.ndjson` и `.markiro-cloud-history-*.partial`.

- [ ] **Шаг 4: golden.** Сгенерировать один раз сборщиком (не руками):

  ```bash
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { createHistoryBuilder } from "./tools/standalone-export/history.mjs";
    let n = 0; const parts = [];
    const next = () => `4a1e0000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
    const b = createHistoryBuilder({ exportedAt: "2026-10-13T09:00:00.000Z",
      exportId: next(), partCodes: 3, tool: "standalone-export/1",
      randomUuid: next, onPart: (line) => parts.push(line) });
    for (const line of readFileSync("tools/standalone-export/test/fixtures/raw-history.ndjson", "utf8").split("\n"))
      if (line !== "") b.push(JSON.parse(line));
    const header = JSON.stringify(b.finish());
    writeFileSync("apps/standalone/proto/fixtures/cloud-history-file.ndjson", [header, ...parts].join("\n") + "\n");'
  ```

  Значение `tool` взять из `TOOL` в `transform.mjs` (после ТОВ). Прочитать файл глазами:
  - три части;
  - HIST7 и HIST8 отсутствуют;
  - у HIST4 нет `canonical`.

  Снять `ignore`/`skip` с тестов задачи 2.

- [ ] **Шаг 5: зелёные тесты** (`test:standalone-export`, `cargo … test -p markiro-proto --test cloud_history`,
      `vitest run test/cloud-history.test.ts`), prettier по `.mjs`, коммит
      `feat(standalone-export): the history file — parts of ~50 000 codes with their checksums and import ids, written whole by cli.mjs --history`.

## Задача 5: хост — миграция `0026_cloud_history.sql`

**Files:** Create `apps/standalone/host/migrations/0026_cloud_history.sql`,
`apps/standalone/host/tests/cloud_history_schema.rs`.

- [ ] **Шаг 0: номер.** `ls <wt>/apps/standalone/host/migrations` и тот же список в открытых
      ветках (`git -C /tmp/claude/wt/<поток> ls-tree --name-only HEAD apps/standalone/host/migrations/`).
      Должно быть: `0020` (РЕЖ) в базе, `0026` свободен. Если `0020` нет — остановиться и сообщить
      контроллеру. Если `0026` занят — следующий свободный, запись в «Отклонения».

- [ ] **Шаг 1: красные тесты схемы** (`cloud_history_schema.rs`, `TestApp::new()` + прямой SQL):
  - `legacy_codes` с живым кодом, который есть в `code_owners`, — `ABORT`
    («code owned by a scan of this site»);
  - `code_owners` с кодом, живым в `legacy_codes`, — `ABORT`;
  - после `UPDATE legacy_codes SET left_at = …, left_reason = 'displaced'` вставка в
    `code_owners` проходит;
  - возврат `left_at` в `NULL` — `ABORT`;
  - CHECK-и:
    - `canonical` без `box_id` и `gtin14` без `serial` — ошибка;
    - `left_at` без `left_reason` — ошибка;
    - `legacy_pallets` складская с `shift_id` — ошибка;
    - `legacy_code_conflicts` с `origin = 'import'` без `part_id` — ошибка;
    - `reviewed_at` без `reviewed_by` — ошибка;
  - `PRAGMA foreign_key_check` пуст, `PRAGMA integrity_check` = `ok`;
  - план запросов: `EXPLAIN QUERY PLAN SELECT … FROM json_each(?) j JOIN legacy_codes c ON
c.code_hash = j.value` содержит `SEARCH c USING PRIMARY KEY`;
    `… JOIN code_owners o ON o.code_hash = j.value` — `SEARCH o USING …`.

  Прогон `cargo … test -p markiro-host --test cloud_history_schema` — красный.

- [ ] **Шаг 2: миграция.**

  ```sql
  -- The cloud's shift history (plan ИСТ, spec
  -- 2026-10-13-standalone-cloud-history-design.md): closed cloud shifts of
  -- 12 months, the codes their registry held, their boxes and pallets. Tables
  -- of their own, not `shifts`, `boxes` and `code_owners`: those name this
  -- site's devices, templates, snapshots and operators, and they feed this
  -- site's exports and totals. Every value is checked before it is written
  -- (`cloud_history.rs`); the CHECKs hold what no row may break. Instants of
  -- the cloud are a device's format (24 characters, ms), so the registry
  -- compares them with a station's `scanned_at` as text; `left_at` and
  -- `detected_at` are the host's own.

  -- One row per part moved: its id (`importId`) makes a repeat answer the
  -- stored summary; (export, index) is the part's place in its file.
  CREATE TABLE legacy_import_parts (
    id INTEGER PRIMARY KEY,
    import_id TEXT NOT NULL UNIQUE,
    export_id TEXT NOT NULL,
    part_index INTEGER NOT NULL CHECK (part_index >= 1),
    part_count INTEGER NOT NULL CHECK (part_count >= part_index),
    checksum TEXT NOT NULL CHECK (length(checksum) = 71 AND checksum GLOB 'sha256:*'),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    source_tenant_id TEXT NOT NULL,
    exported_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL REFERENCES office_users (id),
    summary TEXT NOT NULL CHECK (json_valid(summary) AND json_type(summary) = 'object'),
    UNIQUE (export_id, part_index)
  );

  -- A closed cloud shift. `id` is the cloud's UUID (an RFC 9562 one: a
  -- station reads it as `CodeOwner.shiftId`). The number keeps its parts, as
  -- `shifts` does. The product and the line are names, not references: a
  -- cloud product the import left out still names its shift. `in_window = 0`
  -- for a shift older than the window that came with a warehouse pallet.
  CREATE TABLE legacy_shifts (
    id TEXT PRIMARY KEY,
    number_month_key TEXT NOT NULL CHECK (length(number_month_key) = 5),
    number_seq INTEGER NOT NULL CHECK (number_seq > 0),
    created_from TEXT NOT NULL CHECK (created_from IN ('office', 'station')),
    mode TEXT NOT NULL CHECK (mode IN ('aggregation', 'validation')),
    gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
    product_name TEXT NOT NULL,
    shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
    line_name TEXT,
    production_date TEXT CHECK (production_date IS NULL
      OR production_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    planned_date TEXT CHECK (planned_date IS NULL
      OR planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    opened_at TEXT CHECK (opened_at IS NULL OR length(opened_at) = 24),
    closed_at TEXT NOT NULL CHECK (length(closed_at) = 24),
    in_window INTEGER NOT NULL CHECK (in_window IN (0, 1)),
    part_id INTEGER NOT NULL REFERENCES legacy_import_parts (id)
  );
  CREATE INDEX legacy_shifts_closed ON legacy_shifts (closed_at) WHERE in_window = 1;
  CREATE INDEX legacy_shifts_number ON legacy_shifts (number_month_key, number_seq);
  CREATE INDEX legacy_shifts_gtin ON legacy_shifts (gtin14);

  -- A closed cloud pallet. A warehouse pallet belongs to no shift and names
  -- its product; a production one is its shift's. `disassembly_source`: the
  -- cloud took it apart before the export, or this site's office did (plan
  -- ДЗГ, with its document).
  CREATE TABLE legacy_pallets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('production', 'warehouse')),
    shift_id TEXT REFERENCES legacy_shifts (id),
    gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
    product_name TEXT NOT NULL,
    shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
    sscc TEXT NOT NULL CHECK (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'),
    opened_at TEXT NOT NULL CHECK (length(opened_at) = 24),
    closed_at TEXT NOT NULL CHECK (length(closed_at) = 24),
    disassembled_at TEXT,
    disassembly_source TEXT CHECK (disassembly_source IS NULL
      OR disassembly_source IN ('cloud', 'office')),
    disassembly_document_id TEXT,
    part_id INTEGER NOT NULL REFERENCES legacy_import_parts (id),
    CHECK ((kind = 'production') = (shift_id IS NOT NULL)),
    CHECK ((disassembled_at IS NULL) = (disassembly_source IS NULL)),
    CHECK (disassembly_document_id IS NULL OR disassembly_source = 'office')
  );
  CREATE UNIQUE INDEX legacy_pallets_sscc ON legacy_pallets (sscc);
  CREATE INDEX legacy_pallets_shift ON legacy_pallets (shift_id) WHERE shift_id IS NOT NULL;

  -- A closed cloud box: SSCC, times, its pallet now (the cloud's
  -- `boxes.pallet_id`), taken apart by the cloud or by this site's office.
  CREATE TABLE legacy_boxes (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES legacy_shifts (id),
    sscc TEXT NOT NULL CHECK (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'),
    opened_at TEXT NOT NULL CHECK (length(opened_at) = 24),
    closed_at TEXT NOT NULL CHECK (length(closed_at) = 24),
    pallet_id TEXT REFERENCES legacy_pallets (id),
    disassembled_at TEXT,
    disassembly_source TEXT CHECK (disassembly_source IS NULL
      OR disassembly_source IN ('cloud', 'office')),
    disassembly_document_id TEXT,
    part_id INTEGER NOT NULL REFERENCES legacy_import_parts (id),
    CHECK ((disassembled_at IS NULL) = (disassembly_source IS NULL)),
    CHECK (disassembly_document_id IS NULL OR disassembly_source = 'office')
  );
  CREATE UNIQUE INDEX legacy_boxes_sscc ON legacy_boxes (sscc);
  CREATE INDEX legacy_boxes_shift ON legacy_boxes (shift_id);
  CREATE INDEX legacy_boxes_pallet ON legacy_boxes (pallet_id) WHERE pallet_id IS NOT NULL;

  -- A code the cloud's registry held at the export: one row a code. It owns
  -- the code while `left_at` is NULL; this site's earlier scan (`displaced`)
  -- or the office's disaggregation (`removed`, plan ДЗГ) takes it out, and the
  -- row stays as evidence. The full code (with its crypto tail) only for a
  -- code in a box: «Состав короба» prints it.
  CREATE TABLE legacy_codes (
    code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
    shift_id TEXT NOT NULL REFERENCES legacy_shifts (id),
    scanned_at TEXT NOT NULL CHECK (length(scanned_at) = 24),
    gtin14 TEXT CHECK (gtin14 IS NULL OR (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*')),
    serial TEXT CHECK (serial IS NULL OR length(serial) BETWEEN 1 AND 100),
    box_id TEXT REFERENCES legacy_boxes (id),
    canonical TEXT CHECK (canonical IS NULL OR length(CAST(canonical AS BLOB)) BETWEEN 1 AND 1024),
    left_at TEXT,
    left_reason TEXT CHECK (left_reason IS NULL OR left_reason IN ('displaced', 'removed')),
    part_id INTEGER NOT NULL REFERENCES legacy_import_parts (id),
    CHECK ((gtin14 IS NULL) = (serial IS NULL)),
    CHECK (canonical IS NULL OR (box_id IS NOT NULL AND gtin14 IS NOT NULL)),
    CHECK ((left_at IS NULL) = (left_reason IS NULL))
  ) WITHOUT ROWID;
  -- A box's codes (its card, its form, ДЗГ) and a validation shift's codes
  -- (no box); an aggregation shift's codes are found through its boxes.
  CREATE INDEX legacy_codes_box ON legacy_codes (box_id) WHERE box_id IS NOT NULL;
  CREATE INDEX legacy_codes_unboxed ON legacy_codes (shift_id) WHERE box_id IS NULL;

  -- A code live in at most one registry: this site's (`code_owners`) or the
  -- history's. `registry::claim` and the import keep it so; these triggers
  -- make a bug fail loudly. A rebuild of `code_owners` must recreate them.
  CREATE TRIGGER code_owners_not_held_by_history BEFORE INSERT ON code_owners
  WHEN EXISTS (SELECT 1 FROM legacy_codes WHERE code_hash = NEW.code_hash AND left_at IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'code owned by the cloud history');
  END;
  CREATE TRIGGER legacy_codes_not_owned_by_site BEFORE INSERT ON legacy_codes
  WHEN NEW.left_at IS NULL AND EXISTS (SELECT 1 FROM code_owners WHERE code_hash = NEW.code_hash)
  BEGIN
    SELECT RAISE(ABORT, 'code owned by a scan of this site');
  END;
  CREATE TRIGGER legacy_codes_never_back BEFORE UPDATE OF left_at ON legacy_codes
  WHEN OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'a code that left the history never returns to it');
  END;

  -- One row per losing side when a code of the history and a scan of this
  -- site meet (plan ИСТ, Р3): `winner` names who keeps the code, `kind` how
  -- the loser lost it (`late`: after the owner; `displaced`: it was the owner).
  -- `origin`: found by a station's fact, or by a part's import. Reviewed in
  -- the office with plan КНФ, as `code_conflicts`.
  CREATE TABLE legacy_code_conflicts (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
    legacy_shift_id TEXT NOT NULL REFERENCES legacy_shifts (id),
    legacy_scanned_at TEXT NOT NULL CHECK (length(legacy_scanned_at) = 24),
    legacy_box_id TEXT REFERENCES legacy_boxes (id),
    scan_id TEXT NOT NULL REFERENCES scans (id),
    winner TEXT NOT NULL CHECK (winner IN ('legacy', 'scan')),
    kind TEXT NOT NULL CHECK (kind IN ('late', 'displaced')),
    origin TEXT NOT NULL CHECK (origin IN ('fact', 'import')),
    part_id INTEGER REFERENCES legacy_import_parts (id),
    detected_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT REFERENCES office_users (id),
    CHECK ((origin = 'import') = (part_id IS NOT NULL)),
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
  );
  CREATE INDEX legacy_code_conflicts_code ON legacy_code_conflicts (code_hash);
  CREATE INDEX legacy_code_conflicts_scan ON legacy_code_conflicts (scan_id);
  CREATE INDEX legacy_code_conflicts_detected ON legacy_code_conflicts (detected_at, id);
  ```

  Сверить имя таблицы офисных пользователей и столбца
  (`rtk proxy grep -n "CREATE TABLE office_users" apps/standalone/host/migrations/*.sql`) и имя
  столбца `scans.id` после РЕЖ.

- [ ] **Шаг 3: зелёный тест схемы, полный `cargo … test -p markiro-host`** (миграция не ломает
      старые тесты), `cargo fmt --check`, коммит
      `feat(standalone): host migration 0026 — the cloud history tables, one live registry per code`.

## Задача 6: хост — правила части и `POST|GET /v1/office/import/history`

**Files:** Create `apps/standalone/host/src/{cloud_history.rs,legacy.rs}`,
`apps/standalone/host/src/routes/cloud_history.rs`, `apps/standalone/host/tests/cloud_history.rs`;
Modify `host/src/{lib.rs,audit.rs,server.rs,cloud_import.rs}`, `host/src/routes/mod.rs`,
`host/tests/support/app.rs`, `host/tests/no_secrets_in_logs.rs`.

**Interfaces:**

```rust
// audit.rs (actions)
pub const IMPORT_CLOUD_HISTORY: &str = "import.cloud_history";

// cloud_history.rs — no database
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shift { pub id: String, pub month_key: String, pub seq: u32, pub origin: &'static str,
    pub mode: &'static str, pub gtin14: String, pub product_name: String,
    pub shelf_life_days: Option<u32>, pub line_name: Option<String>,
    pub production_date: Option<String>, pub planned_date: Option<String>,
    pub opened_at: Option<String>, pub closed_at: String, pub in_window: bool }
#[derive(…)] pub struct Pallet { pub id, pub kind: &'static str, pub shift_id: Option<String>, pub gtin14,
    pub product_name, pub shelf_life_days: Option<u32>, pub sscc, pub opened_at, pub closed_at,
    pub disassembled_at: Option<String> }
#[derive(…)] pub struct Box { pub id, pub shift_id, pub sscc, pub opened_at, pub closed_at,
    pub pallet_id: Option<String>, pub disassembled_at: Option<String> }
#[derive(…)] pub struct Code { pub code_hash, pub shift_id, pub scanned_at, pub gtin14: Option<String>,
    pub serial: Option<String>, pub box_id: Option<String>, pub canonical: Option<String> }
pub struct ValidPart {
    pub import_id: String, pub export_id: String, pub index: u32, pub part_count: u32,
    pub checksum: String, pub digest: String, pub source_tenant_id: String,
    pub organization_gln: String, pub exported_at: String,
    pub shifts: Vec<Shift>, pub pallets: Vec<Pallet>, pub boxes: Vec<Box>, pub codes: Vec<Code>,
}
pub fn check(request: &CloudHistoryRequest) -> Result<ValidPart, ApiError>;

// legacy.rs — the history's rows shared by the import and the registry
pub enum Winner { Legacy, Scan }
pub enum ConflictKind { Late, Displaced }
pub struct LegacyConflict<'a> { pub code_hash: &'a str, pub legacy_shift_id: &'a str,
    pub legacy_scanned_at: &'a str, pub legacy_box_id: Option<&'a str>, pub scan_id: &'a str,
    pub winner: Winner, pub kind: ConflictKind, pub part_id: Option<i64>, pub detected_at: &'a str }
pub async fn conflict_row(conn: &mut SqliteConnection, conflict: &LegacyConflict<'_>) -> Result<(), ApiError>;

// routes/cloud_history.rs
pub struct AdminHistoryImport { context: OfficeContext, request: CloudHistoryRequest }
pub async fn import_part(State(state): State<AppState>, AdminHistoryImport { … }: AdminHistoryImport)
    -> Result<Json<CloudHistorySummary>, ApiError>;
pub async fn history_state(State(state): State<AppState>, context: OfficeContext)
    -> Result<Json<CloudHistoryState>, ApiError>;
```

Имя `Box` затеняет `std::boxed::Box`, поэтому в коде модуля — `LegacyBox`; то же для остальных:
`LegacyShift`, `LegacyPallet`, `LegacyCode`.

- [ ] **Шаг 1: помощники тестов** (`support/app.rs`):

  ```rust
  /// The parts of the export tool's golden history file (plan ИСТ):
  /// `cloud-history-file.ndjson`, the header first.
  pub fn history_lines() -> (Value, Vec<Value>) {
      let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../proto/fixtures/cloud-history-file.ndjson");
      let mut lines = std::fs::read_to_string(path).unwrap().lines()
          .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
      let header = lines.remove(0);
      (header, lines)
  }

  /// The request the office sends for part `index` (1-based) of the golden file.
  pub fn history_request(index: usize, dry_run: bool) -> Value {
      let (header, parts) = history_lines();
      let mut part = parts[index - 1].clone();
      let object = part.as_object_mut().unwrap();
      object.remove("kind");
      object.remove("format");
      object.insert("dryRun".into(), Value::Bool(dry_run));
      object.insert("partCount".into(), header["parts"].as_array().unwrap().len().into());
      part
  }

  /// The domain's reading of a code of the history fixture's product.
  pub fn km(serial: &str) -> Value {
      serde_json::json!({
          "codeHash": markiro_host::facts::rules::km_hash("04600682000013", serial),
          "gtin14": "04600682000013", "serial": serial,
          "canonical": format!("010460068200001321{serial}\u{1d}93Site")
      })
  }

  /// A site after the base import of the golden file: the administrator,
  /// and a shift of the imported milk product open on «Линия 1» at the
  /// station that ran the wizard.
  pub async fn imported_with_floor() -> (Admin, Floor) { /* POST /v1/office/import
      (cloud_import_request(IMPORT_ID, false)); office_template(&admin, "box", true, json!([8]));
      ShiftSetup { product: "0e0e0000-0000-4000-8000-000000000001", template, line: «Линия 1»,
      other_line: «Линия 2» }; open_floor(&admin, &setup, &key, &setup.line) */ }
  ```

  У файла импорта два товара с GTIN `04600682000013`: `…0001` активный, `…0003` в архиве. Смена
  берёт активный. Если `plan_shift` требует ёмкостей, которых у товара нет, — взять их из тела
  `shift_body`.

- [ ] **Шаг 2: красные тесты маршрута** (`host/tests/cloud_history.rs`, стиль
      `cloud_import.rs`):

  ```rust
  const HISTORY: &str = "/v1/office/import/history";

  async fn imported() -> Admin {
      let admin = admin().await;
      let (status, body) = admin.call("POST", "/v1/office/import",
          Some(cloud_import_request(IMPORT_ID, false))).await;
      assert_eq!(status, StatusCode::OK, "{body}");
      admin
  }

  #[tokio::test]
  async fn a_part_moves_its_rows_and_writes_one_audit_row() {
      let admin = imported().await;
      let before = host_revision(&admin.app).await;
      let (status, summary) = admin.call("POST", HISTORY, Some(history_request(2, false))).await;
      assert_eq!(status, StatusCode::OK, "{summary}");
      assert_eq!(summary, fixture("cloud-history-summary.json"));
      assert_eq!(host_revision(&admin.app).await, before, "history is not in the feed");
      let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
          "SELECT serial, box_id, left_at FROM legacy_codes ORDER BY serial")
          .fetch_all(&admin.app.state.pool).await.unwrap();
      assert_eq!(rows, [
          ("HIST0000001".into(), Some("0b0c0000-0000-4000-8000-000000000011".into()), None),
          ("HIST0000002".into(), Some("0b0c0000-0000-4000-8000-000000000011".into()), None),
          ("HIST0000003".into(), Some("0b0c0000-0000-4000-8000-000000000011".into()), None),
      ]);
      let request = history_request(2, false);
      assert_eq!(audit_trail(&admin.app, "import.cloud_history").await, [admin.row(
          "import.cloud_history", "cloud_history_part", request["importId"].as_str().unwrap(),
          json!({
              "importId": request["importId"], "exportId": request["exportId"],
              "index": 2, "partCount": 3, "checksum": request["checksum"],
              "summary": fixture("cloud-history-summary.json"),
          }),
      )]);
      let trail = serde_json::to_string(&audit_trail(&admin.app, "import.cloud_history").await).unwrap();
      assert!(!trail.contains("TAIL") && !trail.contains("42651e54"), "no code in the audit");
  }

  #[tokio::test]
  async fn the_same_part_twice_answers_the_same_summary_and_writes_nothing() {
      // second POST: summary == first with repeated: true; COUNT(*) of every legacy_* table and
      // of audit_log unchanged; a dryRun of an imported part answers it too (repeated: true)
  }

  #[tokio::test]
  async fn the_parts_go_in_any_order_and_every_header_is_written_once() {
      // parts 3, 1, 2: then legacy_shifts = 4 (SEP25-012 in_window 0), legacy_pallets 2,
      // legacy_boxes 4, legacy_codes 6; GET /v1/office/import/history == cloud-history-state.json
      // (importedAt from the test clock)
  }

  #[tokio::test]
  async fn a_dry_run_counts_and_rolls_back() { /* summary dryRun: true, codesAdded 3; no row, no audit */ }

  #[tokio::test]
  async fn a_changed_header_or_code_of_an_imported_part_is_refused() {
      // import part 2; then a request of part 2 under a new importId with box 0011's
      // closedAt changed → 409, details { constraint: "legacy_changed", entity: "box",
      // id: "0b0c0000-0000-4000-8000-000000000011" }; with HIST1's shift changed → entity "code";
      // with the shift's product name changed only → 200, shiftsPresent 1 (Р4)
  }

  #[tokio::test]
  async fn the_same_import_id_with_other_content_is_part_mismatch() { /* 409 part_mismatch */ }

  #[tokio::test]
  async fn the_base_import_binds_the_history() {
      // no base import → 409 base_import_missing; source.tenantId "other" → 409 tenant_mismatch;
      // organizationGln "4600000000000" → 409 org_gln
  }

  #[tokio::test]
  async fn only_an_administrator_moves_or_reads_the_history() {
      // technologist: POST and GET → 403, no row; no session (device key only) → 401;
      // the technologist's POST of a 40 MiB body → 403 without reading it (the extractor)
  }

  #[tokio::test]
  async fn every_row_is_checked_with_its_json_path() {
      // codeHash of HIST1 changed to another hex → 400 field "payload.codes.0.codeHash";
      // canonical not starting with 01{gtin}21{serial} → "payload.codes.0.canonical";
      // a code naming a box outside the part → "payload.codes.N.boxId";
      // box units 2 for 3 codes → "payload.boxes.0.units";
      // a validation shift's code with a box → "payload.codes.N.boxId";
      // shift id of version 0 → "payload.shifts.0.id"; instant "2026-10-09T09:01:00Z" →
      // "payload.codes.0.scannedAt"; sscc of 17 digits → "payload.boxes.0.sscc";
      // formatVersion 2 → "formatVersion"; index 4 of partCount 3 → "index"
  }

  #[tokio::test]
  async fn an_sscc_of_this_site_refuses_the_part() {
      // a site box closed with SSCC 046006820000300017 (via facts) → 409 sscc_taken,
      // details { entity: "box", sscc }
  }
  ```

  Прогон `cargo … test -p markiro-host --test cloud_history` — красный.

- [ ] **Шаг 3: `cloud_history.rs` (правила без базы).** Ключевые места:

  ```rust
  /// The cloud's shift id: what a station reads as `CodeOwner.shiftId`
  /// through `z.uuid()` — an RFC 9562 UUID of versions 1 to 8.
  fn cloud_uuid(field: &str, text: &str) -> Result<(), ApiError> {
      validate::client_uuid(field, text)?;
      let parsed = uuid::Uuid::parse_str(text)
          .map_err(|_| ApiError::validation(field, "a UUID is required"))?;
      match (parsed.get_variant(), parsed.get_version_num()) {
          (uuid::Variant::RFC4122, 1..=8) => Ok(()),
          _ => Err(ApiError::validation(field, "an RFC 9562 UUID of versions 1-8 is required")),
      }
  }

  fn instant(field: &str, text: &str) -> Result<String, ApiError> {
      rules::device_instant(text)
          .map(|_| text.to_owned())
          .ok_or_else(|| ApiError::validation(field, "an instant YYYY-MM-DDTHH:MM:SS.sssZ is required"))
  }

  fn sscc(field: &str, text: &str) -> Result<String, ApiError> {
      if text.len() == 18 && text.bytes().all(|byte| byte.is_ascii_digit()) {
          Ok(text.to_owned())
      } else {
          Err(ApiError::validation(field, "an SSCC is 18 digits"))
      }
  }

  /// A code's full text as the domain's `canonicalizeKm` kept it: its key
  /// `01{gtin14}21{serial}`, then the end or a group separator.
  fn canonical_of(field: &str, canonical: &str, gtin14: &str, serial: &str) -> Result<(), ApiError> {
      let key = format!("01{gtin14}21{serial}");
      let rest = canonical.strip_prefix(&key);
      if canonical.len() <= 1024 && matches!(rest, Some(rest) if rest.is_empty() || rest.starts_with('\u{1d}')) {
          Ok(())
      } else {
          Err(ApiError::validation(field, "the full code is not the code's"))
      }
  }
  ```

  `check(request)` по порядку:
  - **Конверт:**
    - `importId`, `exportId` — `client_uuid`;
    - `formatVersion == CLOUD_HISTORY_FORMAT_VERSION`;
    - `exportedAt` — RFC 3339;
    - `1 <= index <= partCount`;
    - `checksum` — `sha256:` и 64 hex;
    - `source.tenantId`/`tenantName` — `clean_text`, как в `cloud_import::check`;
    - `organizationGln` — 13 цифр.
  - **Смены:**
    - `cloud_uuid` и уникальность id в части (`unique_id`);
    - `is_month_key` (сделать `pub(crate)` в `cloud_import.rs`), `seq > 0`;
    - `gtin14` — `validate::gtin14`; `product_name` — `validate::product_name`; `line_name` —
      `validate::line_name`, если есть;
    - даты — `validate::civil_date`; моменты — `instant`; `shelf_life_days` —
      `validate::count(…, MAX_SHELF_LIFE_DAYS)`.
  - **Паллеты:**
    - id уникален; `sscc`;
    - производственная — `shift_id` есть и смена в части; складская — `shift_id` нет;
    - моменты; `disassembled_at` — `instant`.
  - **Короба:**
    - id, `sscc`; смена в части;
    - `pallet_id` в части;
    - `units` равен числу кодов части с этим `box_id`.
  - **Коды:**
    - `is_code_hash`, уникальность; смена в части;
    - `box_id` — в части, той же смены, и смена не `validation`;
    - `gtin14`/`serial` — оба или ни одного; если есть —
      `rules::km_hash(gtin14, serial) == code_hash`, иначе
      `validation(…codeHash, "the hash is not kmHash of the code")`;
    - `canonical` есть ⇔ есть `box_id` и текст; проверка `canonical_of`.
  - **Дайджест:**
    `crate::backup::identity::sha256_hex(&serde_json::to_vec(&(request.export_id.as_str(), request.index, &request.payload)).map_err(ApiError::internal)?)`.
  - `origin`/`mode`/`kind` превращаются в `as_str()` (`ShiftOrigin::as_str`, `ShiftMode::as_str` —
    в proto; для `CloudPalletKind` добавить `as_str`).

  Модуль не пишет в журнал и не вставляет значения в тексты ошибок: только путь поля.

- [ ] **Шаг 4: `routes/cloud_history.rs`.** Экстрактор — копия `AdminImport`
      (`routes/cloud_import.rs:380-398`) с `Json::<CloudHistoryRequest>` и тем же текстом
      `unreadable`. Маршрут:

  ```rust
  pub async fn import_part(
      State(state): State<AppState>,
      AdminHistoryImport { context, request }: AdminHistoryImport,
  ) -> Result<Json<CloudHistorySummary>, ApiError> {
      let valid = cloud_history::check(&request)?;
      let at = state.timestamp();
      let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
      context.require_admin_in(&mut tx).await?;
      if let Some(summary) = earlier_part(&mut tx, &valid).await? {
          return Ok(Json(CloudHistorySummary { repeated: true, dry_run: request.dry_run, ..summary }));
      }
      require_binding(&mut tx, &valid).await?; // base_import_missing, tenant_mismatch, org_gln
      let part_id: i64 = sqlx::query_scalar(
          "INSERT INTO legacy_import_parts (import_id, export_id, part_index, part_count, checksum, \
           digest, source_tenant_id, exported_at, imported_at, imported_by, summary) \
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}') RETURNING id")
          .bind(&valid.import_id).bind(&valid.export_id).bind(valid.index).bind(valid.part_count)
          .bind(&valid.checksum).bind(&valid.digest).bind(&valid.source_tenant_id)
          .bind(&valid.exported_at).bind(&at).bind(&context.user.id)
          .fetch_one(&mut *tx).await.map_err(ApiError::internal)?;
      let summary = write(&mut tx, &valid, part_id, &at).await?;
      if request.dry_run {
          tx.rollback().await.map_err(ApiError::internal)?;
          return Ok(Json(CloudHistorySummary { dry_run: true, ..summary }));
      }
      sqlx::query("UPDATE legacy_import_parts SET summary = ? WHERE id = ?")
          .bind(serde_json::to_string(&summary).map_err(ApiError::internal)?)
          .bind(part_id).execute(&mut *tx).await.map_err(ApiError::internal)?;
      audit::record(&mut tx, &at, Entry {
          actor: context.actor(),
          action: actions::IMPORT_CLOUD_HISTORY,
          target_type: Some("cloud_history_part"),
          target_id: Some(&valid.import_id),
          outcome: Outcome::Ok,
          details: json!({
              "importId": valid.import_id, "exportId": valid.export_id, "index": valid.index,
              "partCount": valid.part_count, "checksum": valid.checksum, "summary": summary,
          }),
      }).await.map_err(ApiError::internal)?;
      // Codes of this site's scans left their boxes: one revision wakes the
      // streams (a station learns of the displacement through plan КНФ).
      if summary.site_displaced > 0 {
          let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
          commit_with_revision(tx, &state.revisions, rev).await
      } else {
          tx.commit().await
      }
      .map_err(ApiError::internal)?;
      Ok(Json(summary))
  }
  ```

  `earlier_part`:
  - `SELECT digest, summary FROM legacy_import_parts WHERE import_id = ?`;
  - тот же дайджест → сводка;
  - другой → `conflict("part_mismatch", …)` с `details { constraint, importId }`;
  - та же пара `(export_id, part_index)` под другим `importId` →
    `conflict("part_mismatch", …)`.

  `require_binding`:
  - `cloud_import::earlier_import` сделать `pub(crate)` и вызвать отсюда;
  - его нет → `conflict("base_import_missing")`;
  - строка аудита `import.cloud` → `details.sourceTenantId` ≠ `valid.source_tenant_id` →
    `conflict("tenant_mismatch")`; функцию, которая читает и `sourceTenantId`, вынести рядом;
  - GLN площадки (`SELECT gln FROM org_profile WHERE id = 1`) ≠ → `conflict("org_gln")` с
    `siteGln`/`fileGln`, как в ИМП.

  `write` — главное место плана. Каждое чтение — одно соединение с `json_each` по массиву части;
  каждая вставка — один `INSERT … SELECT`:

  ```rust
  async fn write(conn: &mut SqliteConnection, valid: &ValidPart, part_id: i64, at: &str)
      -> Result<CloudHistorySummary, ApiError> {
      let mut summary = CloudHistorySummary { dry_run: false, repeated: false, index: valid.index,
          part_count: valid.part_count, ..zero() };

      // 1. shifts: a row there must match on the cloud's fixed fields (Р4)
      let shifts = to_json(&valid.shifts)?;
      let present: Vec<ShiftRow> = sqlx::query_as(
          "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, s.mode, s.gtin14, \
           s.production_date, s.planned_date, s.opened_at, s.closed_at, s.in_window \
           FROM json_each(?) j JOIN legacy_shifts s ON s.id = j.value->>'id'")
          .bind(&shifts).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
      for row in &present {
          let incoming = valid.shifts.iter().find(|shift| shift.id == row.id)
              .ok_or_else(|| ApiError::internal("a present shift not in the part"))?;
          if !row.same(incoming) { return Err(changed("shift", &row.id)); }
      }
      sqlx::query(
          "UPDATE legacy_shifts SET in_window = 1 WHERE in_window = 0 AND id IN \
           (SELECT j.value->>'id' FROM json_each(?) j WHERE j.value->>'inWindow' = 1)")
          .bind(&shifts).execute(&mut *conn).await.map_err(ApiError::internal)?;
      let added = sqlx::query(
          "INSERT INTO legacy_shifts (id, number_month_key, number_seq, created_from, mode, gtin14, \
           product_name, shelf_life_days, line_name, production_date, planned_date, opened_at, \
           closed_at, in_window, part_id) \
           SELECT j.value->>'id', j.value->>'monthKey', j.value->>'seq', j.value->>'origin', \
           j.value->>'mode', j.value->>'gtin14', j.value->>'productName', j.value->>'shelfLifeDays', \
           j.value->>'lineName', j.value->>'productionDate', j.value->>'plannedDate', \
           j.value->>'openedAt', j.value->>'closedAt', j.value->>'inWindow', ? \
           FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM legacy_shifts s WHERE s.id = j.value->>'id')")
          .bind(part_id).bind(&shifts).execute(&mut *conn).await.map_err(ApiError::internal)?
          .rows_affected();
      summary.shifts_added = count(added)?;
      summary.shifts_present = count(present.len() as u64)?;

      // 2. pallets and 3. boxes: the same; first, an SSCC of this site refuses the part
      require_free_sscc(conn, "pallet", "SELECT j.value->>'sscc' FROM json_each(?) j \
           JOIN pallets p ON p.sscc = j.value->>'sscc'", &to_json(&valid.pallets)?).await?;
      // … the same for boxes against `boxes.sscc`; then present/changed/insert like shifts;
      // `disassembled_at` of a row the office took apart (`disassembly_source = 'office'`) is not
      // compared (Р4); a new cloud-disassembled row gets disassembly_source 'cloud'

      // 4. codes
      let hashes = to_json(&valid.codes.iter().map(|code| code.code_hash.as_str()).collect::<Vec<_>>())?;
      let present: HashMap<String, CodeRow> = sqlx::query_as::<_, CodeRow>(
          "SELECT c.code_hash, c.shift_id, c.scanned_at, c.gtin14, c.serial, c.box_id, c.canonical \
           FROM json_each(?) j JOIN legacy_codes c ON c.code_hash = j.value")
          .bind(&hashes).fetch_all(&mut *conn).await.map_err(ApiError::internal)?
          .into_iter().map(|row| (row.code_hash.clone(), row)).collect();
      let site: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>(
          "SELECT o.code_hash, o.scan_id, o.scanned_at FROM json_each(?) j \
           JOIN code_owners o ON o.code_hash = j.value")
          .bind(&hashes).fetch_all(&mut *conn).await.map_err(ApiError::internal)?
          .into_iter().map(|(hash, scan, at)| (hash, (scan, at))).collect();

      let mut rows = Vec::new();       // RowOut { code, left: bool }
      let mut taken_scans = Vec::new(); // site scans the history takes the code from
      let mut taken_hashes = Vec::new();
      let mut conflicts = Vec::new();   // ConflictOut
      for code in &valid.codes {
          if let Some(row) = present.get(&code.code_hash) {
              if row.same(code) { summary.codes_present += 1; continue; }
              return Err(changed("code", &code.code_hash));
          }
          match site.get(&code.code_hash) {
              // The cloud scanned it earlier: the history takes it (spec §3.5).
              Some((scan_id, scanned_at)) if code.scanned_at.as_str() < scanned_at.as_str() => {
                  taken_scans.push(scan_id.as_str());
                  taken_hashes.push(code.code_hash.as_str());
                  conflicts.push(ConflictOut::new(code, scan_id, "legacy", "displaced"));
                  rows.push(RowOut::live(code));
                  summary.site_displaced += 1;
              }
              // This site's scan was earlier, or at the same instant: it keeps the code.
              Some((scan_id, _)) => {
                  conflicts.push(ConflictOut::new(code, scan_id, "scan", "late"));
                  rows.push(RowOut::left(code, at));
                  summary.history_late += 1;
              }
              None => rows.push(RowOut::live(code)),
          }
          summary.codes_added += 1;
          if code.canonical.is_some() { summary.full_codes_added += 1; }
      }
      sqlx::query(
          "UPDATE box_items SET displaced_at = ? WHERE scan_id IN (SELECT value FROM json_each(?)) \
           AND removed_at IS NULL AND displaced_at IS NULL")
          .bind(at).bind(to_json(&taken_scans)?).execute(&mut *conn).await.map_err(ApiError::internal)?;
      sqlx::query("DELETE FROM code_owners WHERE code_hash IN (SELECT value FROM json_each(?))")
          .bind(to_json(&taken_hashes)?).execute(&mut *conn).await.map_err(ApiError::internal)?;
      sqlx::query(
          "INSERT INTO legacy_codes (code_hash, shift_id, scanned_at, gtin14, serial, box_id, \
           canonical, left_at, left_reason, part_id) \
           SELECT j.value->>'codeHash', j.value->>'shiftId', j.value->>'scannedAt', \
           j.value->>'gtin14', j.value->>'serial', j.value->>'boxId', j.value->>'canonical', \
           j.value->>'leftAt', j.value->>'leftReason', ? FROM json_each(?) j")
          .bind(part_id).bind(to_json(&rows)?).execute(&mut *conn).await.map_err(ApiError::internal)?;
      sqlx::query(
          "INSERT INTO legacy_code_conflicts (id, code_hash, legacy_shift_id, legacy_scanned_at, \
           legacy_box_id, scan_id, winner, kind, origin, part_id, detected_at) \
           SELECT j.value->>'id', j.value->>'codeHash', j.value->>'shiftId', j.value->>'scannedAt', \
           j.value->>'boxId', j.value->>'scanId', j.value->>'winner', j.value->>'kind', 'import', ?, ? \
           FROM json_each(?) j")
          .bind(part_id).bind(at).bind(to_json(&conflicts)?).execute(&mut *conn).await
          .map_err(ApiError::internal)?;
      Ok(summary)
  }
  ```

  `RowOut` и `ConflictOut` — `#[derive(Serialize)] #[serde(rename_all = "camelCase")]`, `id`
  конфликта — `uuid::Uuid::new_v4()`. `changed(entity, id)` =
  `ApiError::conflict("legacy_changed", "…").with_details(json!({ "constraint": "legacy_changed", "entity": entity, "id": id }))`.
  Ключ — хеш кода, он не секрет; полного кода в ответе нет.

  Порядок важен для триггеров: `DELETE FROM code_owners` идёт до вставки живых облачных строк.

  `history_state` — чтение без записи (`pool.begin()` + откат, как `read_box_rows`):
  - `require_admin`;
  - `baseImport` — из `earlier_import`;
  - `parts` — `SELECT … FROM legacy_import_parts ORDER BY export_id, part_index`;
  - `totals` — суммы `summary` в Rust (`shiftsAdded`, …, `conflicts` =
    `siteDisplaced + historyLate` плюс `COUNT(*) FROM legacy_code_conflicts WHERE origin = 'fact'`);
  - окно — `SELECT min(closed_at), max(closed_at) FROM legacy_shifts WHERE in_window = 1`.

- [ ] **Шаг 5: маршрут в `server.rs`** рядом с `/v1/office/import`:

  ```rust
  .route(
      "/v1/office/import/history",
      get(crate::routes::cloud_history::history_state)
          .post(crate::routes::cloud_history::import_part)
          .layer(axum::extract::DefaultBodyLimit::max(crate::routes::cloud_import::MAX_BODY_BYTES)),
  )
  ```

  `no_secrets_in_logs.rs:2003`: `import_path` дополняется `"cloud_history.rs"`,
  `"routes/cloud_history.rs"`, `"legacy.rs"`. Проверка счётчика файлов рядом обновляется.

- [ ] **Шаг 6: зелёные тесты**:
  - `cargo … test -p markiro-host --test cloud_history --test cloud_history_schema --test cloud_import --test no_secrets_in_logs`;
  - затем полный `-p markiro-host`;
  - `cargo fmt --check`.

  Коммит
  `feat(standalone): host — import a cloud history part (admin, dry run, idempotent per import id, the earliest scan wins over this site's)`.

## Задача 7: хост — владелец кода из двух реестров (`registry`, `codes.rs`)

**Files:** Modify `host/src/facts/registry.rs`, `host/tests/facts.rs` (или новый
`host/tests/history_registry.rs` — предпочтительно, чтобы не расти `facts.rs` на 244 КБ).

**Interfaces:**

```rust
/// Who holds a code now: an accepted scan of this site, or a cloud shift's
/// scan moved over by plan ИСТ (no scan of this site, no device).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    Scan { scan_id: String },
    Cloud { box_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub holder: Holder,
    pub shift_id: String,
    pub shift_number: String,
    /// `CLOUD_OWNER_DEVICE_ID` for a cloud owner.
    pub device_id: String,
    pub scanned_at: String,
}
```

`to_wire` не меняется: `same_device` для облачного владельца ложно, потому что нулевого
устройства нет. Все места, где читали `owner.scan_id`, переходят на `Holder::Scan { scan_id }`;
найти их: `rtk proxy grep -rn "scan_id" apps/standalone/host/src/facts/registry.rs apps/standalone/host/src/routes`.

- [ ] **Шаг 1: красные тесты** (через `imported_with_floor()` и импорт части 2 golden-файла:
      HIST1–3 облачной смены OCT26-006, отсканированы 2026-10-09T09:01–09:03):

  ```rust
  /// The station's scan of a code the cloud moved over, later than the cloud's.
  fn scan_of(n: u32, serial: &str, box_n: u32, at: &str, shift: &str) -> Value {
      fact(&record_id(n), "scan", shift, json!({
          "scannedAt": at, "verdict": "ok", "duplicateSource": null, "rawKind": "km",
          "rawLength": 40, "code": km(serial), "boxId": box_id(box_n)
      }))
  }

  #[tokio::test]
  async fn a_station_online_hears_the_cloud_owner_as_a_host_duplicate() {
      let (admin, floor) = imported_with_floor().await;
      let (status, _) = admin.call("POST", HISTORY, Some(history_request(2, false))).await;
      assert_eq!(status, StatusCode::OK);
      let hash = markiro_host::facts::rules::km_hash("04600682000013", "HIST0000003");
      let (status, check) = admin.app.send(empty(with_device(
          request("GET", &format!("/v1/device/codes/{hash}")), &floor.key))).await;
      assert_eq!(status, StatusCode::OK, "{check}");
      assert_eq!(check, fixture("code-check-taken-cloud.json"));
  }

  #[tokio::test]
  async fn a_station_offline_gets_a_conflict_with_the_cloud_winner() {
      let (admin, floor) = imported_with_floor().await;
      admin.call("POST", HISTORY, Some(history_request(2, false))).await;
      let receipt = receipts(&admin.app, &floor.key,
          &[scan_of(1, "HIST0000003", 1, "2026-10-12T08:00:00.000Z", &floor.shift)]).await.remove(0);
      assert_eq!(receipt, json!({
          "id": record_id(1), "outcome": "conflict",
          "details": { "winner": fixture("code-check-taken-cloud.json")["owner"] }
      }));
      // the code is not in the station's box on the host; the history keeps it; one conflict row
      let live: i64 = scalar(&admin, "SELECT COUNT(*) FROM box_items WHERE displaced_at IS NULL \
          AND removed_at IS NULL").await;
      assert_eq!(live, 0);
      let rows: Vec<(String, String, String, String)> = sqlx::query_as(
          "SELECT legacy_shift_id, winner, kind, origin FROM legacy_code_conflicts")
          .fetch_all(&admin.app.state.pool).await.unwrap();
      assert_eq!(rows, [("05050000-0000-4000-8000-000000000001".into(), "legacy".into(),
          "late".into(), "fact".into())]);
  }

  #[tokio::test]
  async fn a_station_scan_earlier_than_the_cloud_takes_the_code() {
      // scan HIST0000001 at 2026-10-08T06:00:00.000Z (instant(0, 0)): accepted; code_owners row;
      // legacy_codes HIST1 left_reason 'displaced', left_at = host time; conflict winner 'scan',
      // kind 'displaced', origin 'fact'; GET /v1/device/codes → the station's own owner
  }

  #[tokio::test]
  async fn an_import_after_production_displaces_the_later_station_code() {
      // spec §5 «Перекрытие»: the station scans HIST1 at 2026-10-12 (accepted, owner) and HIST2
      // at 2026-10-08 (earlier than the cloud); then part 2 is imported:
      // summary siteDisplaced 1, historyLate 1; box_items of HIST1 displaced_at = host time;
      // code_owners has HIST2 only; legacy_codes HIST1 live, HIST2 left ('displaced');
      // conflicts: (HIST1, winner legacy, displaced, import), (HIST2, winner scan, late, import);
      // the host revision moved by one (the streams wake)
  }

  #[tokio::test]
  async fn the_two_registries_never_hold_one_code_live() {
      // after each scenario above: SELECT COUNT(*) FROM code_owners o JOIN legacy_codes c
      // ON c.code_hash = o.code_hash AND c.left_at IS NULL == 0
  }
  ```

  Прогон — красный (хост не знает облачного владельца).

- [ ] **Шаг 2: реализация** (после РЕЖ: `Claim.box_id: Option<&str>`; после КНФ:
      `conflict_row(…, kind, …)` — передать вид так, как задаёт КНФ).

  ```rust
  /// The owner of `code_hash`: this site's scan, else the cloud history's
  /// live row (plan ИСТ), else `None` while the code is free.
  pub async fn owner(conn: &mut SqliteConnection, code_hash: &str) -> Result<Option<Owner>, ApiError> {
      if let Some(owner) = site_owner(&mut *conn, code_hash).await? {
          return Ok(Some(owner));
      }
      type CloudRow = (String, String, i64, String, String, Option<String>);
      let row: Option<CloudRow> = sqlx::query_as(
          "SELECT c.shift_id, s.number_month_key, s.number_seq, s.created_from, c.scanned_at, \
           c.box_id FROM legacy_codes c JOIN legacy_shifts s ON s.id = c.shift_id \
           WHERE c.code_hash = ? AND c.left_at IS NULL",
      )
      .bind(code_hash)
      .fetch_optional(conn)
      .await
      .map_err(ApiError::internal)?;
      row.map(|(shift_id, month_key, seq, created_from, scanned_at, box_id)| {
          let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
          Ok(Owner {
              holder: Holder::Cloud { box_id },
              shift_id,
              shift_number: shifts::format_number(&month_key, seq, origin),
              device_id: CLOUD_OWNER_DEVICE_ID.to_owned(),
              scanned_at,
          })
      })
      .transpose()
  }
  ```

  `site_owner` — сегодняшний запрос `owner` с `Holder::Scan`. `claim`:

  ```rust
  match owner(&mut *conn, claim.code_hash).await? {
      Some(owner) if claim.scanned_at >= owner.scanned_at.as_str() => {
          match &owner.holder {
              Holder::Scan { scan_id } => {
                  conflict_row(&mut *conn, claim.code_hash, scan_id, claim.scan_id, context.received_at).await?
              }
              Holder::Cloud { box_id } => {
                  legacy::conflict_row(&mut *conn, &LegacyConflict {
                      code_hash: claim.code_hash, legacy_shift_id: &owner.shift_id,
                      legacy_scanned_at: &owner.scanned_at, legacy_box_id: box_id.as_deref(),
                      scan_id: claim.scan_id, winner: Winner::Legacy, kind: ConflictKind::Late,
                      part_id: None, detected_at: context.received_at,
                  }).await?
              }
          }
          let winner = serde_json::to_value(owner.to_wire(context.device_id)).map_err(ApiError::internal)?;
          return Ok(Applied { outcome: FactOutcome::Conflict,
              details: Some(serde_json::json!({ "winner": winner })), close: None });
      }
      Some(owner) => match &owner.holder {
          Holder::Scan { scan_id } => { /* today's displacement, unchanged */ }
          Holder::Cloud { box_id } => {
              // Earlier than the cloud's scan (a station clock behind, or the cloud
              // and the site worked side by side): the earliest wins here too.
              sqlx::query("UPDATE legacy_codes SET left_at = ?, left_reason = 'displaced' \
                           WHERE code_hash = ? AND left_at IS NULL")
                  .bind(context.received_at).bind(claim.code_hash)
                  .execute(&mut *conn).await.map_err(ApiError::internal)?;
              legacy::conflict_row(&mut *conn, &LegacyConflict { /* … */ winner: Winner::Scan,
                  kind: ConflictKind::Displaced, part_id: None, detected_at: context.received_at,
                  /* … */ }).await?;
              insert_owner(&mut *conn, context, claim).await?;
          }
      },
      None => insert_owner(&mut *conn, context, claim).await?,
  }
  ```

  `insert_owner` — вынесенный сегодняшний `INSERT INTO code_owners …`. `routes/codes.rs` не
  меняется: он зовёт `registry::owner`. Комментарий модуля (`registry.rs:1-9`) дополнить абзацем
  об облачной истории.

- [ ] **Шаг 3: зелёные тесты**:
  - новый файл;
  - `--test facts --test codes --test office_shifts --test warehouse`: ни один прежний тест не
    меняет ожиданий;
  - полный `-p markiro-host`, `cargo fmt --check`.

  Коммит
  `feat(standalone): the registry asks the cloud history too — a host duplicate online, a conflict with the cloud winner offline, the earliest scan wins`.

## Задача 8: хост — тест объёма и параллельной работы линии (`--ignored`)

**Files:** Create `apps/standalone/host/tests/cloud_history_volume.rs`.

- [ ] **Шаг 1: тест** (под `#[ignore = "volume: run with --release -- --ignored"]`):

  ```rust
  /// A part of 50 000 codes in 2 500 boxes of 20, as the tool makes it.
  fn big_part(import_id: &str) -> Value { /* one shift (RFC v4 id), 2 500 boxes (SSCC
      "0460068200{n:08}"), codes with serial format!("V{n:010}"), real km_hash, canonical
      "010460068200001321{serial}\u{1d}91EE07\u{1d}92TAILTAILTAILTAILTAILTAILTAILTAILTAILTAIL44"
      (≈ 90 bytes, a real crypto tail's length); exportId, index 1, partCount 1, checksum
      "sha256:" + 64 zeros (the host does not recompute it), source and GLN of the golden file */ }

  #[tokio::test]
  #[ignore = "volume: run with --release -- --ignored --nocapture"]
  async fn a_part_of_50_000_codes_fits_well_inside_a_station_batchs_wait() {
      let admin = imported().await;
      let size = |pool| async move { /* PRAGMA page_count * page_size */ };
      let before = size(&admin.app.state.pool).await;
      let started = std::time::Instant::now();
      let (status, summary) = admin.call("POST", HISTORY, Some(big_part(ID))).await;
      let elapsed = started.elapsed();
      assert_eq!(status, StatusCode::OK, "{summary}");
      assert_eq!(summary["codesAdded"], 50_000);
      let bytes_per_code = (size(&admin.app.state.pool).await - before) / 50_000;
      eprintln!("part of 50 000 codes: {elapsed:?}, {bytes_per_code} bytes a code");
      assert!(elapsed < std::time::Duration::from_secs(2), "{elapsed:?}");
      assert!((280..=520).contains(&bytes_per_code), "{bytes_per_code}"); // 400 ± 30 % (Р11)
  }

  #[tokio::test]
  #[ignore = "volume"]
  async fn a_station_batch_waits_for_a_part_and_goes_through() {
      // spawn the part import; 50 ms later send a facts batch from an open floor (another code);
      // both 200; the batch's elapsed < 5 s
  }

  #[tokio::test]
  #[ignore = "volume"]
  async fn the_owner_check_stays_fast_with_a_million_history_codes() {
      // 20 parts of 50 000 (distinct exportId/index, 1 000 000 codes); then 1 000
      // GET /v1/device/codes/{hash} of random moved codes: p99 < 20 ms (the station's budget is 300 ms)
  }
  ```

  `eprintln!` в тестах разрешён: `no_secrets_in_logs.rs` проверяет только `src`. Проверить, что
  проверка не обходит `tests/`.

- [ ] **Шаг 2: прогон**
      `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --release -p markiro-host --test cloud_history_volume -- --ignored --nocapture`.
  - Записать время, байты на код и p99 в «Отклонения».
  - Если байты на код вне ±30 % от 400 — поправить `LEGACY_BYTES_PER_CODE` (Rust-теста и
    `src/host/cloud-history.ts`) по измерению и записать это.
  - Если часть дольше 2 с — сначала профилировать (`EXPLAIN QUERY PLAN` каждого запроса
    `write`), не уменьшать размер части молча. Уменьшение `PART_CODES` — решение с записью в
    «Отклонения», инструмент и офис меняются вместе.
- [ ] **Шаг 3: коммит**
      `test(standalone): host — volume of a history part (50 000 codes, bytes a code, a station batch waits), run with --ignored`.

## Задача 9: офис — раздел «История смен из облака»

**Files:** Create `src/office/import/{CloudHistorySection.tsx,history-run.ts}`,
`test/cloud-history-section.test.tsx`; Modify `src/host/cloud-history.ts` (чтение файла),
`src/office/import/CloudImportPage.tsx`, `src/office/office-query.ts`, `src/i18n/ru.json`,
`test/cloud-history.test.ts`, `test/cloud-import-page.test.tsx`.

**Interfaces:**

```ts
// src/host/cloud-history.ts
export type HistoryProblem =
  | { kind: "json"; line: number }
  | { kind: "format" }
  | { kind: "version" }
  | { kind: "checksum" }
  | { kind: "part"; index: number }
  | { kind: "unreadable" };
/** The file's lines, read as a stream: the file is never held whole (it may be 1 GB). */
export type LineSource = (blob: Blob) => AsyncIterable<string>;
export const blobLines: LineSource; // blob.stream().pipeThrough(new TextDecoderStream()), split on "\n"
/** The header (the first line): shape, format, version and its checksum. */
export async function readHistoryHeader(
  blob: Blob,
  lines?: LineSource,
): Promise<
  { kind: "header"; header: HistoryHeader } | { kind: "problem"; problem: HistoryProblem }
>;
/**
 * The parts in file order, each checked against itself and the header (its
 * own checksum, the header's checksum of its index, the export id); a part
 * whose index is in `skip` is not parsed beyond its index.
 */
export function readHistoryParts(
  blob: Blob,
  header: HistoryHeader,
  skip: ReadonlySet<number>,
  lines?: LineSource,
): AsyncIterable<
  { kind: "part"; part: HistoryPart } | { kind: "problem"; problem: HistoryProblem }
>;

// src/office/import/history-run.ts — pure, no React
export interface RunTotals {
  parts: number;
  codesAdded: number;
  codesPresent: number;
  siteDisplaced: number;
  historyLate: number;
}
export function addSummary(totals: RunTotals, summary: CloudHistorySummary): RunTotals;
/** Indexes of the header's parts the host already holds (same export id and checksum). */
export function doneParts(header: HistoryHeader, state: CloudHistoryState): ReadonlySet<number>;
/** «≈ 240 МБ» from codes × LEGACY_BYTES_PER_CODE. */
export function growthBytes(codes: number): number;

// CloudHistorySection.tsx
export interface CloudHistorySectionProps {
  lines?: LineSource;
} // tests pass a fake
export function CloudHistorySection(props: CloudHistorySectionProps): JSX.Element;
```

`officeKeys.cloudHistory = ["office", "cloud-history"]`: состояние хоста без секретов, его можно
кешировать.

**Поведение раздела** (структура по образцу `CloudImportContent`):

- **Состояние хоста** — `useOfficeQuery(officeKeys.cloudHistory, (host, token) => host.cloudHistoryState(token))`.
  - Пока `baseImport === null` — `Alert tone="info"` `needsBase`, выбора файла нет.
  - Карточка «Перенесено на площадку» (`DefinitionGrid`): totals и окно, или `siteEmpty`.
- **Выбор файла** — `FileDropZone` (`accept=".ndjson"`).
  - `readHistoryHeader` → проблема словами, или карточка файла (`DefinitionGrid`): организация,
    окно, totals, число частей и сколько из них уже перенесено (`doneParts`), рост базы, заметки.
  - Оглавление (без кодов) лежит в `useRef`; в состоянии — только представление.
  - `Blob` (ссылка на файл) — тоже в `useRef`; сбрасывается при уходе, замене и «Убрать файл».
- **«Проверить»** — цикл по `readHistoryParts(blob, header, done)`. Каждая часть уходит
  `call((token) => api.importCloudHistoryPart(token, historyRequest(header, part, true)))`, затем
  `addSummary`.
  - Строка хода с `role="status"`: «Проверка части {{index}} из {{count}}…».
  - Ошибка останавливает цикл и показывает текст (`failureText` + `index`).
  - Итог — карточка `trialTitle` с числами.
- **«Перенести»** — только после проверки этого чтения файла. `ConfirmDialog` с текстом
  `confirm`, затем тот же цикл с `dryRun: false`.
  - После каждой части — `queryClient.invalidateQueries({ queryKey: officeKeys.cloudHistory })`.
  - Обрыв (ошибка сети, `HostError`) — `Alert tone="error"` `stopped` и кнопка «Продолжить
    перенос»: тот же цикл, части хоста пропускаются по `doneParts` из свежего состояния.
- **Конец** — карточка `doneTitle`, фокус на ней (как у `done` ИМП).
  - Файл и оглавление забываются.
  - `queryClient.resetQueries({ queryKey: ["office"] })` не нужен: история не меняет других
    данных офиса. Только `cloudHistory` и, после КНФ, ключ конфликтов.
- **Отказы хоста словами:**
  - `legacy_changed` — `errors.legacyChanged` с сущностью (`entities.*`) и id;
  - `sscc_taken`, `base_import_missing`, `tenant_mismatch`, `org_gln`, `part_mismatch` — свои
    ключи;
  - прочие — `errorMessageKey` (`src/host/errors.ts`).
- **Генерация:** как `generation` в `CloudImportContent`, ответ после смены файла или ухода
  отбрасывается. Полный код не попадает ни в состояние, ни в `console`.
- `CloudImportPage` монтирует `<CloudHistorySection />` под ИМП, отдельной карточкой с заголовком
  `h2`. Раздел виден, только если роль — администратор: страница уже только для администратора,
  проверить это в `routes`.

**Тексты** (`src/i18n/ru.json`, ключи `office.cloudHistory.*`):

- `title` — «История смен из облака»
- `intro` — «Файл истории делает выгрузка из облака с ключом --history: закрытые смены за 12 месяцев, их коды, короба и паллеты. Историю можно перенести и после начала работы автонома. Файл содержит полные коды маркировки: он читается только в этом окне и нигде не сохраняется. После переноса удалите его.»
- `needsBase` — «Сначала перенесите справочники из облака: история привязана к той же организации.»
- `choose` — «Выберите файл истории»
- `chooseHint` — «markiro-cloud-history-….ndjson с флешки»
- `problems.json` — «Это не файл истории: строка {{line}} не читается или файл обрезан.»
- `problems.format` — «Это не файл истории этой версии автонома.»
- `problems.version` — «Файл истории сделан другой версией выгрузки: эта версия автонома его не читает.»
- `problems.checksum` — «Контрольная сумма не сходится: файл изменён или повреждён после выгрузки. Сделайте выгрузку заново.»
- `problems.part` — «Часть {{index}} не совпадает с оглавлением файла: файл изменён или повреждён.»
- `problems.unreadable` — «Файл не удалось прочитать: проверьте флешку и права на файл и выберите его снова.»
- `fileTitle` — «Файл истории»
- `window` — «Смены, закрытые с {{from}} по {{to}}»
- `totals` — «Смен {{shifts}}, коробов {{boxes}}, паллет {{pallets}}, кодов {{codes}}»
- `growth` — «База вырастет примерно на {{size}}, и каждая резервная копия — тоже.»
- `parts` — «Частей в файле: {{count}}; уже перенесено: {{done}}.»
- `check` — «Проверить»
- `import` — «Перенести»
- `resume` — «Продолжить перенос»
- `checking` — «Проверка части {{index}} из {{count}}…»
- `importing` — «Перенос части {{index}} из {{count}}…»
- `trialTitle` — «Проверка прошла»
- `trial` — «Будет добавлено кодов: {{added}}; уже есть на площадке: {{present}}. Конфликтов с кодами автонома: {{conflicts}}, из них кодов, которые уйдут из коробов автонома: {{displaced}}.»
- `conflictsHint` — «Код, который есть и в облачной истории, и в смене автонома, — настоящий дубль. Побеждает более ранний скан. Каждая такая запись появится на странице «Конфликты» для разбора.»
- `confirmTitle` — «Перенести историю?»
- `confirm` — «Частей к переносу: {{count}}. Линия во время переноса работает: часть пишется за секунды. Перенос можно прервать и продолжить, перенесённые части не повторяются.»
- `stopped` — «Перенос остановлен на части {{index}}: {{reason}} Перенесено частей: {{done}} из {{count}}. Нажмите «Продолжить перенос»: перенесённые части не повторятся.»
- `doneTitle` — «История перенесена»
- `siteTitle` — «Перенесено на площадку»
- `siteTotals` — «Смен {{shifts}}, коробов {{boxes}}, паллет {{pallets}}, кодов {{codes}}, из них с полным кодом {{fullCodes}}»
- `siteEmpty` — «История из облака ещё не переносилась.»
- `clear` — «Убрать файл»
- `notes.open_shifts` — «Не перенесены незакрытые смены облака: {{numbers}}. Закройте их в облаке и сделайте выгрузку заново.»
- `notes.owner_box_unclosed` — «Кодов в незакрытых коробах облака: {{count}}. Они перенесены без короба.»
- `notes.owner_text_missing` — «Кодов без текста в облаке: {{count}}. Они перенесены только хешем, без GTIN и серийного номера.»
- `errors.legacyChanged` — «Часть {{index}}: {{entity}} {{id}} уже перенесена с другими данными: облако изменило её после прошлой выгрузки. Эту часть перенести нельзя, обратитесь в поддержку.»
- `errors.ssccTaken` — «Часть {{index}}: SSCC {{sscc}} уже занят коробом или паллетой автонома.»
- `errors.baseMissing` — «Сначала перенесите справочники из облака.»
- `errors.tenantMismatch` — «Файл истории выгружен из другой организации облака, чем перенесённые справочники.»
- `errors.orgGln` — «GLN площадки ({{site}}) не совпадает с файлом истории ({{file}}).»
- `errors.partMismatch` — «Часть {{index}} уже переносилась с другим содержимым: файл изменён. Сделайте выгрузку заново.»
- `entities.shift` — «смена»
- `entities.box` — «короб»
- `entities.pallet` — «паллета»
- `entities.code` — «код»

- [ ] **Шаг 1: красные тесты.**
  - **`test/cloud-history.test.ts`:**
    - `readHistoryHeader` на golden-файле (`new Blob([text])` и поддельный `LineSource` по
      строкам) даёт оглавление;
    - битая строка 1 → `json` с `line: 1`;
    - чужой `format` → `format`; `formatVersion: 2` → `version`;
    - изменённое поле оглавления → `checksum`;
    - `readHistoryParts` отдаёт три части;
    - часть с изменённым кодом → `part` с её номером;
    - часть с чужим `exportId` → `part`;
    - `skip = {2}` не разбирает часть 2: поддельный `JSON.parse` не вызывается на ней — проверить
      через счётчик в `LineSource`, который отдаёт неразбираемый текст на месте части 2.
  - **`test/cloud-history.test.ts` (`history-run.ts`):** `addSummary`, `doneParts` (только той
    же выгрузки и с той же суммой), `growthBytes(1_000_000) === 400_000_000`.
  - **`test/cloud-history-section.test.tsx`** (поддельный `HostApi` и `LineSource`, по образцу
    `test/cloud-import-page.test.tsx`):
    - без ИМП — `needsBase`, выбора файла нет;
    - после выбора — организация, окно «с 13.10.2025 по 13.10.2026» (формат дат — как у
      соседних страниц, `formatDate` проверить), totals, «Частей в файле: 3; уже перенесено: 0.»,
      рост;
    - «Проверить» шлёт три запроса с `dryRun: true`, строка хода меняется, итог показывает
      числа; «Перенести» до проверки недоступна;
    - «Перенести» → диалог → три запроса `dryRun: false`, `invalidateQueries` после каждого,
      карточка конца с фокусом;
    - обрыв на части 2 (запрос отклонён `TypeError`) → `stopped` с «Перенесено частей: 1 из 3»;
      «Продолжить перенос» после свежего состояния (часть 1 сделана) шлёт части 2 и 3, не 1;
    - отказ `legacy_changed` → текст с «короб 0b0c…» и номером части;
    - клавиатура: Tab до выбора файла, кнопок и диалога, у всех подписи; фокус после конца — на
      карточке;
    - **приватность:** после конца в `queryClient.getQueryCache().getAll()` нет ни одного
      значения, где встречается `TAIL` или хеш кода; `console.error`/`console.log` не
      вызывались.
  - **`test/cloud-import-page.test.tsx`:** страница рендерит раздел истории под ИМП; прежние
    тесты не меняются.

  Прогон `pnpm … exec vitest run test/cloud-history.test.ts test/cloud-history-section.test.tsx test/cloud-import-page.test.tsx` —
  красный.

- [ ] **Шаг 2: реализация** по интерфейсам и поведению выше. `blobLines`:

  ```ts
  export const blobLines: LineSource = async function* (blob) {
    const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += value;
      let cut = rest.indexOf("\n");
      while (cut >= 0) {
        yield rest.slice(0, cut);
        rest = rest.slice(cut + 1);
        cut = rest.indexOf("\n");
      }
    }
    if (rest !== "") yield rest;
  };
  ```

  Строка части ~12 МБ: `rest += value` копит одну строку, не файл. jsdom `Blob.stream` и
  `TextDecoderStream` может не иметь, поэтому тесты передают свой `LineSource`, а `blobLines`
  проверяется вручную (проверка владельца 4).

- [ ] **Шаг 3: зелёные тесты (дважды, см. «Заметки»), typecheck, lint, prettier, коммит**
      `feat(standalone): office — move the cloud history part by part: a check with conflict counts, progress, resume, the site's totals`.

## Задача 10 (после слияния fb-codesearch): поиск кодов видит историю

**Files:** Modify `host/src/routes/office_codes.rs`, `proto/src/code_search.rs`, фикстуры
`office-code-*.json` (новая `office-code-card-cloud.json`), `src/host/protocol.ts`, офис поиска
(компоненты найти по `rtk proxy grep -rln "OfficeCodeItem\|officeCodeItemSchema" apps/standalone/src`),
`src/i18n/ru.json`, тесты `host/tests/office_codes.rs`, Vitest поиска.

- [ ] **Шаг 0:** `office_codes.rs` есть в `claude/integration`. Если нет — задачу отложить, запись в
      «Отклонения».
- [ ] **Шаг 1: протокол.**
  - `OfficeCodeItem` получает `#[serde(default)] pub origin: CodeOrigin` (`site` | `cloud`,
    по умолчанию `site`).
  - Для облачной строки:
    - `scanId` = `cloud:{codeHash}`;
    - `deviceId` = `CLOUD_OWNER_DEVICE_ID`, `deviceName` = `""`, `operatorName` = `null`;
    - `shiftStatus` = `closed`; `productionDate` = `coalesce(production_date, planned_date,
substr(closed_at, 1, 10))`;
    - `lineName` = название линии или `""`;
    - `state` = `packed`, если код живой, `displaced`/`removed` по `left_reason`;
    - `leftAt` = `left_at`.
  - `OfficeCodeCard`: `ownerScanId` для облачного владельца — `null`; новое
    `#[serde(default)] pub cloud_owner: Option<CloudCodeOwner>` (`shiftId`, `shiftNumber`,
    `scannedAt`, `boxSscc`). Событие `OfficeCodeEvent::Cloud { at, shift_id, shift_number,
box_id }` — «принят в облаке».
  - Ответы офисные: версия протокола не растёт.
- [ ] **Шаг 2: красные тесты хоста** (после импорта golden):
  - поиск по хешу HIST1 даёт облачную строку (`origin: cloud`, SSCC BX1, паллета P1, смена
    OCT26-006);
  - по SSCC BX1 — 3 строки; по SSCC W1 — HIST5;
  - по номеру `SEP25-012/S` — HIST5;
  - по GTIN — строки автонома и облака, сортировка по `scanned_at` убыв.;
  - по периоду 2026-10-09 — HIST1–3;
  - `total` и `capped` считают обе половины;
  - карточка HIST4 (смена проверки) — `cloudOwner` без короба, `placements` пусты.
- [ ] **Шаг 3: реализация.** Каждый драйвер поиска получает вторую половину `UNION ALL` по
      `legacy_codes` через индексы `0026`:
  - код — PK;
  - короб — `legacy_codes_box`;
  - паллета — `legacy_boxes_pallet`, затем `legacy_codes_box`;
  - смена — короба смены (`legacy_boxes_shift`), затем `legacy_codes_box`; плюс
    `legacy_codes_unboxed`;
  - GTIN — `legacy_shifts_gtin`, затем смены;
  - период — смены, чей `[opened_at|closed_at]` пересекает период, затем их коды с фильтром
    `scanned_at`.

  Только размещения в коробах (`box_id IS NOT NULL`), как у автонома. Сортировка и
  `LIMIT/OFFSET` — по объединению (обёртка `SELECT * FROM (… UNION ALL …) ORDER BY scanned_at
DESC, scan_id DESC`). `EXPLAIN QUERY PLAN` каждой облачной половины закрепить тестом:
  `SEARCH`, не `SCAN legacy_codes`.

- [ ] **Шаг 4: офис.** Строка с `origin: cloud` показывает `Badge` «Из облака» (текст, не цвет) и
      «смена {{number}}» вместо станции. Карточка кода — «Из облака, смена {{number}}».
  - `office.codeSearch.cloud` — «Из облака»;
  - `office.codeSearch.cloudShift` — «Из облака, смена {{number}}».

  Проверить существующий префикс ключей поиска и встроиться в него.

- [ ] **Шаг 5: зелёные тесты, коммит**
      `feat(standalone): code search finds the cloud history — codes, boxes, pallets and shifts marked «Из облака»`.

## Задача 11 (после слияния КНФ): «Конфликты» и станции видят облачные конфликты

**Files:** маршруты КНФ (`GET /v1/office/conflicts`, `POST …/{id}/review`,
`POST /v1/device/conflicts/status`, `GET /v1/device/displacements` — модули найти по
`rtk proxy grep -rln "conflicts/status\|displacements" apps/standalone/host/src`), протокол КНФ
(`OfficeConflictScan`, `OfficeConflict`), офис «Конфликты», тесты.

- [ ] **Шаг 0:** КНФ влит. Иначе — отложить.
- [ ] **Шаг 1: протокол.** `OfficeConflictScan` получает `#[serde(default)] origin: CodeOrigin`.
  - Облачная сторона:
    - `shiftId` облачной смены, `shiftNumber` облачный;
    - `deviceId` = `CLOUD_OWNER_DEVICE_ID`, `deviceName` = `""`;
    - `boxId`/`boxSscc` — облачный короб.
  - `OfficeConflict.kind` — как в строке `legacy_code_conflicts`: проигравший — сторона, у
    которой нет кода.
- [ ] **Шаг 2: красные тесты.**
  - Список офиса после сценария «перенос после производства» (задача 7) содержит две облачные
    записи с правильными победителем и проигравшим.
  - Фильтр «смена» по смене автонома находит запись, где проигравший — скан этой смены.
  - Фильтр «разобран» работает.
  - `review` облачной записи пишет `reviewed_at`/`reviewed_by` в `legacy_code_conflicts`.
  - Аудит `conflict.review` с целью `legacy_code_conflict`/`{id}` и
    `details = { kind, loserShiftId, loserDeviceId, winnerShiftId }`; повтор без аудита.
  - Станция: `conflicts/status` по номеру записи облачного позднего скана отвечает разобранным
    после review.
  - `displacements` отдаёт вытеснение импортом (`winner = 'legacy'`, `kind = 'displaced'`) по
    скану станции.
  - Технолог может разбирать, как в КНФ.
- [ ] **Шаг 3: реализация.** Читатели КНФ объединяют `code_conflicts` и
      `legacy_code_conflicts` (`UNION ALL` в общем запросе с одинаковым набором столбцов).
      Разбор ищет id в обеих таблицах. Курсор вытеснений `(detected_at, id)` общий: id — UUID, а
      время одного формата хоста.
- [ ] **Шаг 4: офис.** Сторона «Из облака» — `Badge` «Из облака» и «смена {{number}}». Переход к
      коробу облачной стороны — карточка КРТ (после задачи 12) или поиск по SSCC.
- [ ] **Шаг 5: зелёные тесты, коммит**
      `feat(standalone): conflicts with the cloud history in the office and on stations`.

## Задача 12 (после слияния КРТ): карточки короба и паллеты, печать для облачных

**Files:** маршруты КРТ (`GET /v1/office/boxes/{id}`, `GET /v1/office/pallets`,
`GET /v1/office/pallets/{id}` — имена сверить с влитым планом КРТ), `host/src/routes/office_reports.rs`,
протокол КРТ, офис карточек и печати (`src/office/forms/form-data.ts`), тесты.

- [ ] **Шаг 0:** КРТ влит. Иначе — отложить.
- [ ] **Шаг 1: красные тесты.**
  - Карточка BX1 (облачный id) — `origin: cloud`, смена OCT26-006, паллета P1, три кода с
    историей «принят в облаке».
  - Карточка W1 — складская, короб BX3 смены SEP25-012/S.
  - Реестр паллет показывает P1 и W1 с «Из облака», фильтры «товар» (GTIN) и «период» работают.
  - Действия «XML паллеты» нет у облачной паллеты (ИСТ-3).
  - **Печать «Состав короба» BX1:** `boxReportData` из ответа облачного короба совпадает
    с облачным `CodeSearchService.boxReportData` для того же короба:
    - статус `closed`, `openedAt`/`closedAt`;
    - коды по `gtin14, serial` с `rawKm` = полному коду;
    - HTML рендера домена побайтно равен рендеру той же структуры облачных полей;
    - пометка «Из облака» на печать не идёт (ИСТ-1).

    Эталон — фикстура, собранная из полей сида задачи 3 (как облако их отдало бы).

  - «Ярлык паллеты» W1 — у каждого короба своя дата производства (объявленная дата смены,
    `production_date`; у SEP25-012 — 2025-09-01), срок годности и GTIN товара паллеты, как
    `palletPlacardData`.
  - BX2 (расформирован в облаке) — статус `disassembled`, кодов нет (Р5, ИСТ-П2).
- [ ] **Шаг 2: реализация.**
  - Маршруты КРТ ищут id в `boxes`/`pallets`, затем в `legacy_boxes`/`legacy_pallets`.
  - `BoxReportRows` облачного короба собирается из `legacy_codes` по `legacy_codes_box`
    (только живые; у снятых офисом ДЗГ — те, что сняты его расформированием, как облачное
    правило `removed_at = disassembly_received_at`: `left_reason = 'removed'` и
    `left_at = disassembled_at`).
  - Даты и названия — из `legacy_*`.
- [ ] **Шаг 3: офис.** «Из облака» на карточках. Печать — те же кнопки, кроме XML.
- [ ] **Шаг 4: зелёные тесты, коммит**
      `feat(standalone): box and pallet cards and their forms for the cloud history`.

## Задача 13 (после слияния ДЗГ): дезагрегация облачных коробов и паллет

**Files:** проверка строки и проведение ДЗГ (модули найти по
`rtk proxy grep -rln "already_disassembled\|shift_open" apps/standalone/host/src`), протокол ДЗГ,
тесты; акт и XML ДЗГ-О — если влит.

- [ ] **Шаг 0:** ДЗГ влит. Иначе — отложить.
  - Если таблица строк документа ДЗГ не может назвать облачный короб без новой колонки (например,
    `box_id REFERENCES boxes`), нужна миграция: взять следующий свободный номер и записать в
    «Отклонения».
  - Предпочтительно — строка хранит SSCC и вид, а облачный предмет находится по SSCC при
    проведении.
- [ ] **Шаг 1: красные тесты.**
  - **Проверка строки** с SSCC BX1:
    - `ok` (облачная смена всегда закрыта: `shift_open` не бывает);
    - SSCC BX2 → `already_disassembled`;
    - неизвестный → `not_found`;
    - паллета W1 → `ok`.
  - **Проведение BX1:**
    - коды HIST1–3: `left_reason = 'removed'`, `left_at` = момент проведения;
    - `legacy_boxes.disassembled_at` = тот же момент, `disassembly_source = 'office'`,
      `disassembly_document_id`;
    - после этого скан HIST1 на станции принимается (код свободен);
    - `GET /v1/device/codes/{h1}` — `free`;
    - аудит ДЗГ — как у короба автонома.
  - **Проведение W1:** `disassembled_at` паллеты, короба не открыты.
  - Ленту освобождений станций (`code_releases` ДЗГ) облачные коды не пишут: на станциях их не
    было. Тест это закрепляет: строк нет.
- [ ] **Шаг 2: реализация** в функциях проверки и проведения ДЗГ: ветка «облачный предмет» по
      `legacy_*`, в той же транзакции и под тем же замком.
- [ ] **Шаг 3:** если ДЗГ-О влит — акт и XML «Расформирование упаковки» для облачного короба
      берут полные коды из `legacy_codes`; тест эталона акта — тот же, что у ДЗГ-О, на облачном
      коробе.
- [ ] **Шаг 4: зелёные тесты, коммит**
      `feat(standalone): disaggregation takes the cloud history's boxes and pallets`.

## Задача 14: документы и итоговые проверки

**Files:** Modify `apps/standalone/AGENTS.md` («Cloud import» — новый абзац «Cloud history»;
«Facts» — реестр из двух частей; «Office pages»; «Backups and restore»; «Verification»),
`docs/runbooks/standalone-cloud-cutover.md`,
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` (§5.4: «реализовано планом
ИСТ, коммит …»).

- [ ] **Шаг 1: `AGENTS.md`** — записать:
  - **Файл истории:** `cli.mjs --history` и `--history-since`; формат NDJSON (оглавление, части);
    части по ~50 000 кодов, короб не делится, заголовки повторяются; контрольные суммы;
    0600/целиком.
  - **SQL:** одна транзакция, одинаковая область у четырёх `SELECT`, живой тест в
    `export-sql.test.mjs` (почему там).
  - **Хост:** таблицы `legacy_*`, одна строка на код, живой — `left_at IS NULL`, триггеры двух
    реестров (их пересоздаёт любая перестройка `code_owners`), привязка к ИМП.
  - **Повтор и изменения:** повтор по `importId`, `part_mismatch`, `legacy_changed` (какие поля
    неизменны).
  - **Правило самого раннего скана:** четыре случая Р3; облачный победитель на проводе (Р2);
    версия протокола не растёт.
  - **Транзакция и объём:** короткая транзакция и бюджет 2 с; ревизия только при вытеснении;
    байты на код (измерение задачи 8).
  - **Офис:** построчное чтение, файл не хранится, продолжение по состоянию хоста.
  - **Копии:** резервная копия несёт историю (файл базы). Восстановление копии до переноса
    теряет историю: офис показывает части как не перенесённые, и их можно перенести снова.
  - **Список ручных проверок** ИСТ в «Verification».
- [ ] **Шаг 2: памятка переключения** — шаг после ИМП:
  - выгрузка истории;
  - перенос;
  - удаление файла;
  - повторная выгрузка, если облако работало после переключения.
- [ ] **Шаг 3: полный гейт** (раздел ниже), `git diff --check`, коммит
      `docs(standalone): plan ИСТ — the cloud history import`.

## Итоговая проверка плана

- `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`.
- `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --workspace` —
  частями, если целиком не укладывается:
  - `-p markiro-proto`;
  - `-p markiro-host`;
  - крейт оболочки после `pnpm … --filter @markiro/standalone build`.
- Тест объёма: `… test --release -p markiro-host --test cloud_history_volume -- --ignored --nocapture`
  (числа — в «Отклонения»).
- `cloud_import_logs.rs` вне песочницы: импорт истории не печатает в журнал ни хеша, ни полного
  кода. Дописать в него сценарий части: отказ, проба, перенос, повтор — по образцу ИМП.
- `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`,
  `typecheck`, `lint`, `build`.
- `pnpm … test:standalone-export` — без переменной (живые пропущены) и с одноразовым Postgres 17
  с миграциями облака (живые зелёные).
- `pnpm … --filter @markiro/domain exec vitest run` — домен не менялся, проверка паритета хеша
  проходит.
- `prettier --check` по всем изменённым файлам, `git diff --check`.
- Отчёт отдельно перечисляет автоматические проверки и то, что не проверено вживую.

## Проверки владельца

1. **Выгрузка на копии облачной базы клиента.**
   - `node tools/standalone-export/cli.mjs --tenant <id> --out-dir <личная папка> --history`;
   - время выгрузки, размер файла, число частей, память процесса (`/usr/bin/time -l` или
     диспетчер задач);
   - сводка совпадает с числами облака: закрытые смены за 12 месяцев, коды в реестре этих смен.
2. **Перенос на Windows 10/11 (WebView2).**
   - Файл с флешки выбирается, оглавление видно, рост базы показан.
   - Проверка проходит все части; во время проверки и переноса станция на линии сканирует без
     задержек больше секунды.
   - Время переноса года истории; размер `master.db` до и после; размер резервной копии.
3. **Обрыв и продолжение.**
   - Остановить службу хоста посреди переноса и запустить снова.
   - Офис показывает «Перенесено частей: N из M»; «Продолжить перенос» доводит до конца.
   - Повторный выбор того же файла показывает все части перенесёнными.
4. **Повторный скан старого кода на станции:**
   - при связи — «Дубль: код принят в смене {номер облачной смены} в {время}», код в короб не
     попадает;
   - без связи (сеть отключена) — код принят; после восстановления связи — конфликт в очереди
     станции и (после КНФ) на странице «Конфликты» с победителем «Из облака, смена …».
5. **Перенос после начала работы автонома.** Смена автонома с кодом, который есть в облачной
   истории (взять код из облачного короба):
   - проверка показывает 1 конфликт;
   - после переноса короб автонома — «нужна проверка», конфликт на странице «Конфликты» (после
     КНФ).
6. **После слияния соседних потоков:**
   - поиск по коду и SSCC облачного короба;
   - карточка и печать «Состав короба» на A4 — сравнить с облачной печатью того же короба
     листом к листу;
   - «Ярлык паллеты» складской паллеты;
   - расформирование облачного короба документом и повторный скан его кода на станции.
7. **Новая выгрузка через неделю** (облако работало):
   - новые смены добавляются, уже перенесённые — «уже есть»;
   - короб, изменённый в облаке после первой выгрузки, даёт понятный отказ своей части.

## Открытые вопросы

- **ИСТ-1 — пометка «Из облака» на «Составе короба».** По умолчанию — нет, печатная форма как в
  облаке, пометка только на экране (задача 12).
- **ИСТ-2 — откуда считать 12 месяцев.** По умолчанию — от момента выгрузки; ключ
  `--history-since YYYY-MM-DD` задаёт другое начало (Р6).
- **ИСТ-3 — пересечение с уже выгруженными в ЧЗ коробами автонома.** По умолчанию — конфликт и
  ручной разбор, выгрузки не меняются автоматически (Р3, задача 11).
- **ИСТ-П1 — размер.** Спецификация (§3.7) называет 200–250 байт на код; план оценивает около
  400 с индексами (Р11), тест объёма даёт точное число.
  - По умолчанию офис показывает измеренную оценку.
  - Сжать можно хешем в BLOB (−20 %) ценой несовместимости с текстовым `code_owners`.
  - Нужно ли править §3.7 спецификации — решает владелец.
- **ИСТ-П2 — состав коробов, расформированных в облаке.** Облако печатает «Состав» такого
  короба с кодами на момент расформирования. Перенос по ПР-4 (только владельцы) этих кодов не
  несёт: в автономе форма пуста. По умолчанию так и остаётся. Если нужно — отдельная таблица
  печатного состава без владельцев, +~200 байт на такой код.
- **ИСТ-П3 — складская перепечатка на станции.** Станция ищет короб по SSCC/коду только среди
  записей автонома (`routes/warehouse.rs`). По умолчанию облачные короба перепечатываются только
  из офиса (КРТ): у облачной смены нет снимка шаблона.
- **ИСТ-П4 — площадка без ИМП.** По умолчанию история принимается только после ИМП той же
  облачной организации (Р7). Это защищает от чужой истории; площадке, заведённой вручную, нужен
  сначала ИМП.
- **ИСТ-П5 — изменение облаком уже перенесённого.** Спецификация §3.6 велит отказ. Облако
  меняет закрытые смены через дезагрегацию и складские паллеты, поэтому вторая выгрузка после
  такой операции упрётся в `legacy_changed` у своей части. По умолчанию — отказ части с понятным
  текстом. Альтернатива — принимать облачное расформирование как изменение признака.
- **ИСТ-П6 — незакрытые облачные смены.** По умолчанию выгрузка не останавливается: они
  называются в заметке и в stderr (Р6). ИМП же останавливается на открытой смене — согласовать?

## Риски

- **Общие файлы с соседними потоками:**
  - `facts/registry.rs` — РЕЖ (`Claim.box_id`), КНФ (`conflict_row(…, kind)`), ДЗГ (`release`);
  - `server.rs`, `audit.rs`, `routes/mod.rs`, `lib.rs` — почти все потоки;
  - `no_secrets_in_logs.rs`;
  - `CloudImportPage.tsx`, `src/i18n/ru.json`, `src/host/api.ts` — ТОВ и прочие;
  - `tools/standalone-export/cli.mjs`, `test/export-sql.test.mjs`, `fixtures/cleanup-cloud.sql` —
    ТОВ;
  - `office_codes.rs` — fb-codesearch; маршруты КНФ, КРТ, ДЗГ.

  Меры: порядок исполнения (Global Constraints), задачи 10–13 только после слияния своих
  потоков, шаг 0 каждой задачи.

- **Объём.** Миллионы строк. Меры:
  - короткая транзакция на запросах `json_each`;
  - тест объёма с порогом 2 с;
  - бюджет `busy_timeout` 5 с у партии фактов;
  - p99 проверки владельца на миллионе кодов.

  На слабом ПК клиента цифры хуже: проверка владельца 2.

- **Память инструмента.** Карты смен, паллет и коробов держатся в памяти, коды — нет. 500 000
  коробов — ~150 МБ. Проверка владельца 1.
- **Размер базы и копий.** +~400 МБ на миллион кодов в каждой копии. Удержание копий
  (`backup_retention`) это не учитывает. Проверка владельца 2, вопрос ИСТ-П1.
- **План SQL облака** на настоящих объёмах (боковое соединение на каждого владельца) проверен
  только на сиде. Проверка владельца 1. При медленной выгрузке — переписать `rows` кодов на
  соединение с `box_set` без `LATERAL`.
- **Будущая перестройка `code_owners`/`scans`** без пересоздания триггеров `0026` молча снимет
  защиту двух реестров. Мера: запись в `AGENTS.md`, тест схемы задачи 5 ловит пропажу триггера.
- **Номера смен.** Облако, работавшее после переключения, могло выдать номер, который выдал и
  автоном. Ссылки идут по id, но в поиске видны два «OCT26-008»: облачный помечен «Из облака».

## Не проверено

- Настоящая облачная копия клиента и её объём: время выгрузки, план SQL, память `cli.mjs`.
- Перенос на Windows (WebView2, `Blob.stream`/`TextDecoderStream` на файле 0,5–1 ГБ), время года
  истории на ПК клиента, влияние на линию в живой работе.
- Поведение реальной станции при облачном победителе (текст «Дубль», очередь конфликтов): тесты
  проверяют разбор схемой и хост.
- Печать облачных форм на реальном принтере (после КРТ).
- psql на раннере CI — как и для ИМП, живой тест SQL гоняется на одноразовом Postgres 17.

## Отклонения при исполнении

_(заполняет исполнитель)_
