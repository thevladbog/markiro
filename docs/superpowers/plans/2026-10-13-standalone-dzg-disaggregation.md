# План ДЗГ: дезагрегация в автономе — документ дезагрегации на хосте, справочник причин, проведение под замком фактов, лента `code_releases` и освобождение кодов на станции — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сегодня офис автонома не может расформировать короб или паллету закрытой смены. Станция
расформировывает только свой закрытый короб своей текущей смены, а у офиса такого действия нет
вовсе. Для ЧЗ это прямой риск: XML агрегации описывает короб не так, как он собран физически
(§4 спецификации паритета, волна 1).

После плана:

- хост ведёт документы дезагрегации, как облако: черновик с номером `DSG-YY-NNNN`, причиной из
  справочника, комментарием и строками по SSCC;
- каждая строка проходит проверку облака (`not_found` → `not_closed` → `shift_open` →
  `already_disassembled` → `ok`, плюс `duplicate` внутри документа);
- проведение одной транзакцией под тем же замком записи, что приём фактов. Для короба оно делает
  то же, что станционное `disassemble`: освобождает коды и снимает единицы. Для паллеты — то же,
  что станционное расформирование паллеты;
- справочник причин заполнен причинами по умолчанию (ПР-3);
- станции узнают об освобождённых кодах из ленты изменений (сущность `code_releases`) и
  убирают их из своей проверки дублей. Код, освобождённый документом, принимается в новой смене
  на той же станции.

Офисные страницы, акт и XML «Расформирование упаковки» — план ДЗГ-О. Этот план отдаёт ему всё
нужное на проводе: список документов с фильтрами, карточку, создание, правку шапки, добавление
и удаление строк, проведение, отмену, справочник причин и методы `HostApi`.

**Architecture:**

- **Хост, миграция `0024_disaggregation.sql`.** Новые таблицы, фактовые таблицы не
  пересобираются (рекомендация §5.1 п. 1):
  - `disaggregation_reasons` — пять причин по умолчанию;
  - `disaggregation_doc_counters`;
  - `disaggregation_documents`;
  - `disaggregation_document_lines`;
  - `code_releases` — по строке на каждый короб, коды которого освободил документ; это источник
    ленты.

  Проведённая строка документа сама записывает действие офиса. Читатели истории короба (КНФ, КРТ,
  поиск кодов) объединяют `box_exceptions` станции и строки проведённых документов.

- **Хост, код.** `host/src/disaggregation.rs` — номер, проверка строки, механика проведения;
  маршруты `routes/disaggregation.rs` (документы) и `routes/disaggregation_reasons.rs`
  (справочник), пути — по §5.1 «Хост». Проведение идёт через `db::begin_write`
  (`BEGIN IMMEDIATE`), как пакет фактов (`routes/facts.rs:44`): скан станции и проведение не
  перемешиваются.

- **Лента.** `routes/changes.rs` получает сущность `code_releases`: ключ — id короба, данные —
  смена, документ, момент и число кодов. Ревизия одна на транзакцию проведения.
- **Протокол.** Типы — в новом модуле `proto/src/disaggregation.rs`, Zod — в новом
  `src/host/disaggregation.ts`, фикстуры `proto/fixtures/disaggregation-*.json` и
  `changes-code-releases.json`. Версия протокола устройства **не растёт**: нового вида факта
  и нового поля `data` нет. Новая сущность ленты — это ответ, и прежняя станция её пропускает
  (`reference-sync.ts`: «Entities this build does not keep are skipped»).
- **Станция.** `src/local/reference-sync.ts` применяет `code_releases` одним оператором в
  транзакции страницы. Он удаляет строки `floor_codes` этой пары «хост — устройство» только для
  названного короба и только когда этот короб у станции закрыт. `ENTITY_SET` меняет текст, и
  каждая станция один раз синхронизируется с нуля, чтобы получить освобождения, пропущенные
  прежней сборкой. Миграции оболочки нет: номер `0017` остаётся пропуском (Р7).
- **Восстановление хоста из копии** (`host/src/restore.rs`) поднимает счётчик номеров
  документов над обеими базами, как номера смен.

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde, time) — `host`, `proto`; TypeScript 6 strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4; Vitest 4 (`node:sqlite` за
`LocalExecutor`); SQLite 3.46 оболочки (`src-tauri/tests/local_db.rs`) для плана запроса станции.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`:
  - §5.1 — пп. 1–3, «Хост», «Станция», «Данные», «Эталонные проверки»;
  - строки П-19 и П-50;
  - решения ПР-1 и ПР-3. ПР-2 (XML) — план ДЗГ-О.
- Облако, образец:
  - `apps/api/src/modules/disaggregation/line-validation.ts` — порядок статусов,
    «сначала короба, потом паллеты», число кодов по живым единицам;
  - `disaggregation.service.ts`:
    - `applyDocument` — повторная проверка под замком, `invalid_lines` после фиксации свежих
      статусов, механика короба и паллеты;
    - `addLines` — дубли с `sscc = NULL`;
    - `cancelDocument`, `updateDocument` — только черновик;
  - `doc-number.ts` — `DSG-YY-NNNN`, сквозной счётчик;
  - `import-parser.ts` — `MAX_IMPORT_LINES = 10 000`;
  - `dto.ts` — пределы: `ssccs` 1–500 за запрос, вход до 64 символов, комментарий до 500;
  - `disaggregation-reasons/{dto.ts,disaggregation-reasons.service.ts}` — имя 1–120 символов,
    `sortOrder`, архив вместо удаления;
  - `packages/db/src/schema/disaggregation.ts` — форма таблиц.
  - Облачная станция: `apps/station/src/lib/sync.ts:387-433` (`/station/codes/releases`,
    `removeReleasedCodes`).
- `apps/standalone/AGENTS.md`: «Audit», «Writes», «Change feed», «Reference sync», «Local
  database», «Facts», «Floor exceptions and close», «Backups and restore», «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

- **Фактовые таблицы — только записи устройств.**
  - `host/migrations/0010_facts.sql:137-160` — `box_exceptions`: `record_id TEXT NOT NULL`
    (`:139`), `device_id TEXT NOT NULL REFERENCES devices` (`:147`), уникальный индекс
    `(device_id, record_id)`.
  - `0012_pallets.sql:50-65` — `pallet_exceptions`: `record_id` (`:52`) и `device_id` (`:58`)
    тоже `NOT NULL`.

  Офисной строке туда не встать.

- **Станционное расформирование.**
  - `host/src/facts/exception.rs:57-152`: живые единицы короба получают `removed_at` (момент
    станции), `registry::release(scan_id)` (`facts/registry.rs:192`), `boxes.disassembled_at`
    (`:120`).
  - `host/src/facts/boxes.rs:25-58` (`find`): чужой короб или другая смена дают `box_unknown`.
  - `host/src/facts/pallet_exception.rs:43-90`: паллета получает `disassembled_at`, её короба не
    трогаются.
- **Замок записи.**
  - `host/src/db.rs:51` — `begin_write` (`BEGIN IMMEDIATE`).
  - Пакет фактов берёт его в `routes/facts.rs:44` и пишет весь пакет одной транзакцией. Офисное
    закрытие смены — тоже через `begin_write` (`routes/office_shifts.rs:636`).
- **Поздние факты.** Факт закрытой смены принимается и помечает её `late_data_at`
  (`facts/mod.rs:355`, `mark_late` — `:483`). Позднее исключение уже расформированного короба получает
  `box_state` (`exception.rs:69-76`), паллеты — `pallet_state`.
- **SSCC.** У короба и паллеты SSCC есть только у закрытых (`CHECK ((closed_at IS NULL) = (sscc
IS NULL))`, `0010:82`, `0012:28`). У паллеты SSCC начинается с `1` (`0012:33`), у короба — с
  `0`: расширения не пересекаются.
- **Читатели расформирования.**
  - `routes/office_exports.rs:69-87`:
    - `CODES_SQL` читает коды через `code_owners`; освобождённого кода там нет;
    - `ITEMS_SQL` — только живые единицы;
    - `BOXES_SQL` отдаёт `disassembled_at`, а `src/office/exports/export-source.ts:201` отбрасывает
      расформированные короба.
  - «Состав короба» (`routes/office_reports.rs:39`) показывает единицы с
    `i.removed_at = b.disassembled_at`, то есть моменты должны совпадать текстом.
  - `office_boxes.rs`, `office_shifts.rs` и `warehouse.rs` фильтруют `disassembled_at IS NULL`.

  Выгрузки менять не нужно — это проверит тест (задача 5).

- **Лента.**
  - `routes/changes.rs:51` — `FEED_KEYS`, `:257` — `record`, `:377` — образец составного ключа
    (`category_template_defaults`);
  - `host/src/feed.rs` — надгробия;
  - `proto/src/lib.rs:528` — `entities`.
- **Станция.**
  - `src/local/retention.ts:11` — `floor_codes` закрытых смен живут 30 дней.
  - `src/floor/work/scan-pipeline.ts:75` — локальный дубль ищется по `(host_id, device_id,
code_hash)` без смены.
  - `:102` — проверка хоста пропускает код, если его владелец — эта же станция
    (`sameDevice`).

  Значит, код, освобождённый офисом, на той же станции 30 дней остаётся «дублем (локальным)».
  `src/floor/exceptions/box-exceptions.ts:210` — собственное расформирование станции удаляет
  строки `floor_codes` по `box_id`.

- **Синхронизация справочников.**
  - `src/local/reference-sync.ts:115` — `ENTITIES`, `:282` — `SYNC_SCHEMA_VERSION = 4`, `:293` —
    `ENTITY_SET`, `:507` — `pageStatements`.
  - Худшая страница — 30 операторов из 32 (`src-tauri/src/local_db.rs:35`,
    `test/reference-sync.test.ts:1712`).
- **Восстановление.** `host/src/restore.rs:616-733` — `Floors` и `read_floors` (счётчики SSCC,
  номера смен, аудит). `:2256-2295` поднимает номера смен на `SHIFT_NUMBER_MARGIN = 10`.
- **Роли.** `host/src/auth.rs:281-294` — `plans_shifts`, `edits_catalog` (без подстановочной
  ветки). Обе роли — `admin` и `technologist`.
- **Облако** причин по умолчанию не заводит: в `disaggregation-reasons.service.ts` только CRUD, в
  миграции `packages/db/migrations/0047_late_blue_blade.sql` нет `INSERT` в
  `disaggregation_reasons`.

## Решения владельца

- **ПР-1 (2026-10-13):** «Дезагрегация только по закрытым сменам, как в облаке? — да». Строка
  короба или паллеты незакрытой смены получает `shift_open`, проведение с ней отказывает.
- **ПР-3 (2026-10-13):** «справочник с причинами по умолчанию».
- **ПР-2** (XML «Расформирование упаковки») — план ДЗГ-О. Здесь только данные, которые ему нужны.

## Допущения

- **Р1 — отдельные таблицы документа, фактовые таблицы не пересобираются** (§5.1 п. 1). Проведение
  не пишет `box_exceptions` и `pallet_exceptions`: запись — сама строка проведённого документа.
  Для читателей `AGENTS.md` получает запрос объединения (задача 9). Пересборка с `actor_kind`
  задела бы журнал фактов, на котором стоит идемпотентность.
- **Р2 — статусы строк облака без `written_off`.**
  - `written_off` в облаке даёт только выбытие (заказы киоска), а выбытия в автономе нет (§6).
  - `not_closed` оставлен ради паритета провода и текстов, но сегодня недостижим: SSCC есть только
    у закрытого короба и закрытой паллеты. Проверка в коде есть.
  - Порядок облачный: SSCC ищется среди коробов, потом среди паллет; первое сработавшее правило
    побеждает.
- **Р3 — проведение под замком фактов.** Обработчик открывает `begin_write` до первого чтения, а
  внутри заново проверяет роль, черновик, ревизию и каждую строку. Пакет фактов станции ждёт
  проведения, и наоборот. Поздний факт, пришедший после проведения, видит итог: исключение —
  `box_state`, скан освобождённого кода — свободный код, позднее `box_closed` того же короба —
  `box_already_closed`.
- **Р4 — механика короба — станционная, момент один.**
  - Живые единицы — `removed_at`, `registry::release`; `boxes.disassembled_at` — тот же текст.
  - Момент — время хоста в форме устройства (`YYYY-MM-DDTHH:MM:SS.sssZ`, новая
    `facts::rules::device_text`): столбцы фактов однородны, и «Состав короба» (`office_reports.rs:39`)
    находит снятые единицы по равенству.
  - Облако пишет ещё `box_exceptions(disassemble)` со ссылкой на документ. У нас ссылкой служит
    строка документа (Р1).
- **Р5 — паллета.** Как в облаке: `pallets.disassembled_at`, короба остаются на месте
  (`boxes.pallet_id` не очищается), коды не освобождаются. Кто хочет открыть короба, добавляет их
  строками того же документа.
- **Р6 — единица ленты — короб, а не код.** Спецификация и бриф называют поля «`code_hash`,
  `released_at`, `document_id`». Документ из 10 000 коробов по 20 кодов дал бы 200 000 элементов
  в одной ревизии (около 44 МБ JSON и 200 000 запросов `record`). Лента не делит ревизию
  (`changes.rs`, «a revision larger than the budget still comes whole»), а клиент оболочки
  ждёт 10 с (`db.rs:76`), поэтому синхронизация станции встала бы навсегда.

  Поэтому сущность `code_releases` содержит строку на короб:

  ```text
  id = box_id; data = { shiftId, documentId, releasedAt, codeCount }
  ```

  Станция удаляет свои строки `floor_codes` этого короба, как при собственном расформировании
  (`box-exceptions.ts:210`). Правило «одна ревизия на транзакцию» («Writes») сохраняется.

- **Р7 — правило станции: только закрытый короб, без пометок о смене и без миграции оболочки.**
  - Хост освобождает коды только коробов смен, **закрытых на хосте** (ПР-1, проверено под замком
    записи). Строка `floor_codes` закрытой смены — единственное, что затрагивает освобождение.
  - Станция дополнительно требует, чтобы её короб `box_id` был закрыт (`floor_boxes.closed_at IS
NOT NULL`) и принадлежал названной смене. Открытый короб и его коды не трогаются никогда.
  - Копию смены (`floor_shifts.status`) станция не сверяет. Копия отстаёт от хоста, например
    когда офис закрыл смену, пока станция была без связи. Освобождение, пропущенное из-за
    отставшей копии, потерялось бы: курсор ленты ушёл бы дальше, и вернулась бы та самая
    ошибка, которую лента исправляет.
  - Хранить отложенные освобождения в таблице оболочки (`0017`) — альтернатива ценой миграции,
    `TABLE_CLASSES`, удержания и закреплённых планов запросов; это вопрос ДЗГ-2. По умолчанию
    `0017` не используется.
- **Р8 — протокол не растёт, `ENTITY_SET` меняется.** Версия протокола остаётся (см. Architecture).
  Список сущностей, которые станция применяет, но не копирует, — `ACTION_ENTITIES =
["code_releases"]` — входит в текст `ENTITY_SET`. Обновлённая станция один раз синхронизируется с
  нуля (существующий механизм) и получает освобождения, сделанные, пока она была старой сборки.
  `SYNC_SCHEMA_VERSION` не трогается: КНФ может поднять его сам, и при слиянии будет конфликт
  только текста.
- **Р9 — номер `DSG-YY-NNNN`.** Счётчик один на площадку и по годам не сбрасывается (облачный
  `nextDocNo`); `YY` — год создания документа по UTC; номер дополняется до четырёх цифр и не
  обрезается.

  Восстановление из копии поднимает счётчик над обеими базами на `SHIFT_NUMBER_MARGIN`. Без
  этого номер, уже напечатанный на акте после копии, выдался бы второй раз.

- **Р10 — права.** Документы и справочник ведут администратор и технолог:
  - спецификация пилота §10.1: технолог работает со сменами, выгрузками и конфликтами;
  - облако даёт и то, и другое по `OPERATIONS_WRITE`.

  Новый `auth::disaggregates` без подстановочной ветки и пара `require_disaggregation` /
  `require_disaggregation_in`, как у смен. Отказа роли в волне 1 нет. Тесты проверяют, что
  технолог проводит документ, а запрос без офисной сессии получает `401`.

- **Р11 — причины по умолчанию (предложение, вопрос ДЗГ-1).** Облако их не заводит, поэтому
  список предложен здесь. Это четыре причины станционного расформирования
  (`exception_reasons::DISASSEMBLE`, тексты из `src/i18n/ru.json:421-424`) и «Другое»:
  - «Не тот товар» (10);
  - «Неверное количество» (20);
  - «Повреждена упаковка» (30);
  - «Брак по качеству» (40);
  - «Другое» (90).

  Миграция заводит их с постоянными id `d15a0000-0000-4000-8000-00000000000N`. Их можно
  переименовать и убрать в архив, как любые другие.

- **Р12 — SSCC разбирает вебвью.** Правила маркировки живут в `@markiro/domain`, хост проверяет
  только форму (как у фактов, `facts/mod.rs:1-7`).
  - Строка на проводе — `{ input, sscc }`. `input` — что ввёл или импортировал пользователь,
    после обрезки 1–64 символа. `sscc` — 18 цифр, которые домен прочитал (`parseScannedSscc`),
    или `null`, если не прочитал.
  - Строка с `sscc: null` — `not_found` с `sscc = NULL`, как в облаке.
  - Повтор SSCC внутри документа — `duplicate` с `sscc = NULL`, как в облаке.
  - Хост контрольную цифру не проверяет (`box_closed.rs:1-7`).
- **Р13 — пределы облака.** Запрос строк 1–500, документ до 10 000 строк (облачный предел
  импорта), комментарий до 500 символов, имя причины до 120.
- **Р14 — ревизии.** У документа и причины есть `rev`, и каждое изменение берёт ревизию
  хоста («a change still takes a revision, like every record with a `rev`»,
  `routes/counterparties.rs:4`).
  - Правка шапки, проведение, отмена и правка причины требуют `expectedRev` (иначе
    `stale_revision`).
  - Добавление и удаление строк — только проверка «черновик» под замком, как в облаке
    (`addLines`, `removeLine`).
  - Изменения без изменений — без ревизии и без аудита.
- **Р15 — `invalid_lines`.** Если после повторной проверки не все строки `ok`, свежие статусы
  фиксируются, документ остаётся черновиком, ответ — `409 conflict` с `details:
{ constraint: "invalid_lines", invalidLines: N }`, плюс строка аудита `disaggregation.apply`
  с исходом `failed`. Офис перечитывает карточку. Облако отдаёт строки в теле ошибки; у нас
  карточка уже их содержит, а `details` остаётся маленьким.
- **Р16 — фильтр списка по моменту, не по дате.** `from` и `to` — моменты хоста
  (`YYYY-MM-DDTHH:MM:SSZ`) против `created_at`: часовых поясов хост не знает, дни в моменты
  переводит ДЗГ-О. Ещё `status`, `reasonId`, `q` (подстрока номера). Новые первыми, не больше
  1 000.
- **Р17 — восстановление.** Проведение, сделанное после копии, восстановление теряет вместе с
  документом. Станции к тому времени уже освободили коды этих коробов.

  Повторное применение всей ленты с нуля безопасно: удаление идёт по `box_id`, а в закрытый
  короб строк больше не добавляется. Офис проводит документ заново по акту (проверка владельца
  6). Возможные скан-конфликты после этого видны в КНФ.

## Global Constraints

**Правила продукта**

- Только закрытые смены (ПР-1). Офис не спорит с открытым коробом станции. Открытый короб на
  станции не трогается никогда (Р7).
- Офлайн-первым: станция узнаёт об освобождении из ленты. Во время скана она никого не
  спрашивает и без связи ничего не теряет. После обрыва связи освобождения приходят со следующей
  страницей.
- Проведение необратимо и атомарно: всё или ничего, одна ревизия.
- Аудит: точные исполнитель, действие, цель (`disaggregation_document` /
  `disaggregation_reason`), исход и детали. Тесты сверяют строки целиком через
  `support::app::audit_trail`.
- Права: администратор и технолог (Р10). Запрос без офисной сессии — `401`.
- Выгрузки ЧЗ, «Состав короба», списки коробов и паллет, складская перепечатка видят офисное
  расформирование так же, как станционное. Эталон — тест задачи 5.

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
- **ДЗГ:** хост `0024`. Оболочка `0017` **не используется** (Р7) и остаётся пропуском. Протокол
  **не поднимается** (Р8): номер 8 остаётся резервом.
- ДЗГ не создаёт индексов на `scans` и `code_owners` и не читает `code_owners.box_id`.
  Освобождение идёт по `code_owners.scan_id` (`registry::release`), поэтому оно работает и
  после перестройки РЕЖ. Смены проверки коробов не имеют, и строка с их SSCC не находится.

**Код и процесс**

- TDD: сначала красный тест, потом код. Фикстуры `proto/fixtures` читают Rust (`proto/tests`) и
  Vitest.
- Rust: `cargo fmt` чистый, без предупреждений. TypeScript strict: без `any`, приведений и `!`,
  `import type`.
- `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются; `pnpm install/add`
  не запускать.
- Новые миграции — только новыми файлами (LF, `.gitattributes`). Применённые не править.
- Строки интерфейса в этом плане не появляются: офис — ДЗГ-О. Если исполнитель всё же добавит
  текст, то только через `src/i18n/ru.json`.
- Никогда `git stash`. Коммиты с явными путями, трейлер одной строкой `Co-Authored-By: …`. Push
  и PR — не в этом плане.
- `apps/api`, `apps/admin`, `apps/station`, `packages/*` не меняются.

## Заметки для исполнения

- Worktree от `claude/integration`. Зависимости — клоны APFS из `/tmp/claude/wt/integ`:
  `cp -c -R -P` для `node_modules`, `apps/standalone/node_modules`, `packages/*/node_modules`,
  `packages/*/dist`; для cargo — ещё `apps/standalone/target`.
- Команды (`<wt>` — абсолютный путь worktree):
  - Vitest: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <файлы>`;
  - пакет: `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
    (и `typecheck`, `lint`);
  - Rust: `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test -p markiro-host --test <имя>`,
    `-p markiro-proto`. Крейт оболочки — `markiro-standalone`, тест `--test local_db`. Перед
    его сборкой нужен `pnpm … --filter @markiro/standalone build`: `tauri::generate_context!`
    читает `dist`;
  - `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`;
  - `prettier --check` по тронутым файлам, `git -C <wt> diff --check`.
- Интеграционные тесты хоста на `TestApp` сокета не открывают (`tower::oneshot`), песочница им
  не мешает. Тесту замка (задача 5) нужен только пул.
- Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.
- Ошибка валидации хоста — `400 validation_failed` с `details.field` (`host/src/error.rs:88`), а
  не 422. Конфликт — `409 conflict` с `details.constraint` (`error.rs:111`).

## Файлы

- **Создать:**
  - `apps/standalone/host/migrations/0024_disaggregation.sql`;
  - `apps/standalone/host/src/disaggregation.rs`;
  - `apps/standalone/host/src/routes/{disaggregation.rs,disaggregation_reasons.rs}`;
  - `apps/standalone/host/tests/{disaggregation_schema.rs,disaggregation_reasons.rs,disaggregation.rs,disaggregation_apply.rs}`;
  - `apps/standalone/proto/src/disaggregation.rs`, `apps/standalone/proto/tests/disaggregation.rs`;
  - `apps/standalone/proto/fixtures/`:
    - `disaggregation-reason.json`, `disaggregation-reason-create.json`,
      `disaggregation-reason-update.json`;
    - `disaggregation-document.json`, `disaggregation-detail.json`;
    - `disaggregation-create.json`, `disaggregation-update.json`;
    - `disaggregation-lines-add.json`, `disaggregation-transition.json`;
    - `error-disaggregation-invalid-lines.json`, `changes-code-releases.json`;
  - `apps/standalone/src/host/disaggregation.ts`;
  - `apps/standalone/test/{disaggregation-protocol.test.ts,code-releases.test.ts}`.
- **Изменить:**
  - `proto/src/lib.rs` (`pub mod disaggregation;`, `entities::CODE_RELEASES`);
  - `host/src/{lib.rs,audit.rs,auth.rs,server.rs,restore.rs}`, `host/src/facts/rules.rs`,
    `host/src/routes/{mod.rs,changes.rs}`, `host/tests/{changes.rs,restore.rs}`;
  - `src/host/api.ts`, `test/api.test.ts`, `test/support/office.tsx` (`fakeHostApi`);
  - `src/local/reference-sync.ts`, `test/reference-sync.test.ts`, `test/floor-schema.test.ts`,
    `src-tauri/tests/local_db.rs` (только закреплённые тексты и план запроса);
  - `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`
    (отметка в §5.1).

---

## Задача 1: провод — типы, фикстуры, Zod, методы `HostApi`

**Files:** Create `proto/src/disaggregation.rs`, `proto/tests/disaggregation.rs`, фикстуры
(список выше), `src/host/disaggregation.ts`, `test/disaggregation-protocol.test.ts`; Modify
`proto/src/lib.rs`, `src/host/api.ts`, `test/api.test.ts`, `test/support/office.tsx`.

**Interfaces (Rust, `proto/src/disaggregation.rs`):**

```rust
//! The wire of office disaggregation documents (plan ДЗГ, parity spec §5.1):
//! the documents, their lines, the reasons' dictionary, and the feed record
//! that tells stations whose codes a document freed. The cloud's
//! `apps/api/src/modules/disaggregation/dto.ts` and
//! `disaggregation-reasons/dto.ts` are the reference: the same statuses,
//! minus `written_off`, which only the cloud's pickup produces. Responses
//! tolerate unknown fields; requests refuse them.

use serde::{Deserialize, Serialize};

use super::{parse_variant, UnknownVariant};

/// Lines of one `POST …/lines` (the cloud's `addLinesSchema`).
pub const MAX_LINES_PER_REQUEST: usize = 500;
/// Lines of one document (the cloud's `MAX_IMPORT_LINES`).
pub const MAX_LINES_PER_DOCUMENT: usize = 10_000;
/// Characters of a line's typed or imported text, trimmed.
pub const MAX_INPUT_CHARS: usize = 64;
pub const MAX_COMMENT_CHARS: usize = 500;
pub const MAX_REASON_NAME_CHARS: usize = 120;

/// `details.constraint` of a document's `conflict`.
pub mod constraints {
    /// The document is applied or cancelled: it changes no more.
    pub const NOT_DRAFT: &str = "document_not_draft";
    /// An apply of a document without a reason.
    pub const REASON_REQUIRED: &str = "reason_required";
    /// An apply of a document without lines.
    pub const NO_LINES: &str = "no_lines";
    /// An apply found lines that are not `ok`; their fresh statuses are
    /// saved, `details.invalidLines` counts them.
    pub const INVALID_LINES: &str = "invalid_lines";
    pub const ALL: &[&str] = &[NOT_DRAFT, REASON_REQUIRED, NO_LINES, INVALID_LINES];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationStatus {
    Draft,
    Applied,
    Cancelled,
}

impl DisaggregationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Applied => "applied",
            Self::Cancelled => "cancelled",
        }
    }
}

impl std::str::FromStr for DisaggregationStatus {
    type Err = UnknownVariant;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("disaggregation status", text)
    }
}

// The same `as_str` / `FromStr` pair for the two below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationSource {
    Manual,
    Import,
}

/// A line's status, the first rule that holds winning (the cloud's
/// `line-validation.ts`): `not_found` → `not_closed` → `shift_open` →
/// `already_disassembled` → `ok`; `duplicate` is a repeat in the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationLineStatus {
    Ok,
    NotFound,
    NotClosed,
    ShiftOpen,
    AlreadyDisassembled,
    Duplicate,
}

/// A reason of the dictionary (`GET /v1/office/disaggregation-reasons`,
/// archived ones included).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReason {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub archived: bool,
    pub rev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationReasonCreate {
    pub name: String,
    #[serde(default)]
    pub sort_order: i64,
}

/// The whole reason over its `rev`; `archived: true` archives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationReasonUpdate {
    pub name: String,
    pub sort_order: i64,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A document as the list and the card show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationDocument {
    pub id: String,
    /// `DSG-YY-NNNN`.
    pub doc_no: String,
    pub status: DisaggregationStatus,
    pub reason_id: Option<String>,
    pub reason_name: Option<String>,
    pub comment: Option<String>,
    pub source: DisaggregationSource,
    pub line_count: u32,
    /// The sum of the lines' `codeCount`.
    pub code_count: u64,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: String,
    pub applied_at: Option<String>,
    pub applied_by: Option<String>,
    pub applied_by_name: Option<String>,
    pub cancelled_at: Option<String>,
    pub cancelled_by: Option<String>,
    pub rev: i64,
}

/// One line: what was typed, the SSCC the domain read (18 digits, `null`
/// when none, or for a repeat), what it names and its status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationLine {
    pub id: String,
    pub sscc_input: String,
    pub sscc: Option<String>,
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    /// The shift of the box or the pallet, for the office's link.
    pub shift_id: Option<String>,
    pub shift_number: Option<String>,
    pub status: DisaggregationLineStatus,
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    /// Live codes of the box, or of the pallet's boxes, when last checked.
    pub code_count: u64,
    pub validated_at: String,
}

/// `GET /v1/office/disaggregation/{id}` and the answer of every write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationDetail {
    pub document: DisaggregationDocument,
    pub lines: Vec<DisaggregationLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationCreate {
    #[serde(default)]
    pub reason_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// The whole header of a draft over its `rev`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationUpdate {
    pub reason_id: Option<String>,
    pub comment: Option<String>,
    pub expected_rev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationLineInput {
    pub input: String,
    pub sscc: Option<String>,
}

/// `POST …/{id}/lines`; `import: true` marks the document's source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationLinesAdd {
    pub lines: Vec<DisaggregationLineInput>,
    #[serde(default)]
    pub import: bool,
}

/// `POST …/{id}/apply` and `POST …/{id}/cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationTransition {
    pub expected_rev: i64,
}

/// `data` of a `code_releases` feed item, whose `id` is the box's: a
/// document took this box apart and freed every code it held (plan ДЗГ).
/// A station deletes its own codes of that box once the box is closed
/// there. Never deleted, never a tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReleaseRecord {
    pub shift_id: String,
    pub document_id: String,
    pub released_at: String,
    pub code_count: u32,
}
```

В `lib.rs`: `pub mod disaggregation;` рядом с `pub mod backup;` (`:191`), а в `entities`
(`:528`) — `pub const CODE_RELEASES: &str = "code_releases";`. `parse_variant` и
`UnknownVariant` (`lib.rs:385-410`) дочернему модулю видны и так. Если `parse_variant` окажется
не в корне крейта, сделать его `pub(crate)`.

**Interfaces (TS, `src/host/disaggregation.ts`):**

```ts
import { z } from "zod";

// Office disaggregation documents (plan ДЗГ): mirrors
// `markiro_proto::disaggregation`. Answers are lenient (`z.object`), bodies
// strict (`.strict()`), as the Rust types.

export const DISAGGREGATION_MAX_LINES_PER_REQUEST = 500;
export const DISAGGREGATION_MAX_LINES_PER_DOCUMENT = 10_000;
export const DISAGGREGATION_CONSTRAINTS = [
  "document_not_draft",
  "reason_required",
  "no_lines",
  "invalid_lines",
] as const;

export const disaggregationStatusSchema = z.enum(["draft", "applied", "cancelled"]);
export const disaggregationSourceSchema = z.enum(["manual", "import"]);
export const disaggregationLineStatusSchema = z.enum([
  "ok",
  "not_found",
  "not_closed",
  "shift_open",
  "already_disassembled",
  "duplicate",
]);
const ssccSchema = z.string().regex(/^\d{18}$/u);

export const disaggregationReasonSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
  rev: z.number().int(),
});
export const disaggregationReasonCreateSchema = z
  .object({ name: z.string(), sortOrder: z.number().int() })
  .strict();
export const disaggregationReasonUpdateSchema = z
  .object({
    name: z.string(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();

export const disaggregationDocumentSchema = z.object({
  id: z.uuid(),
  docNo: z.string().regex(/^DSG-\d{2}-\d{4,}$/u),
  status: disaggregationStatusSchema,
  reasonId: z.uuid().nullable(),
  reasonName: z.string().nullable(),
  comment: z.string().nullable(),
  source: disaggregationSourceSchema,
  lineCount: z.number().int().nonnegative(),
  codeCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  appliedBy: z.string().nullable(),
  appliedByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  rev: z.number().int(),
});
export const disaggregationLineSchema = z.object({
  id: z.uuid(),
  ssccInput: z.string(),
  sscc: ssccSchema.nullable(),
  boxId: z.uuid().nullable(),
  palletId: z.uuid().nullable(),
  shiftId: z.uuid().nullable(),
  shiftNumber: z.string().nullable(),
  status: disaggregationLineStatusSchema,
  productId: z.uuid().nullable(),
  productName: z.string().nullable(),
  codeCount: z.number().int().nonnegative(),
  validatedAt: z.string(),
});
export const disaggregationDetailSchema = z.object({
  document: disaggregationDocumentSchema,
  lines: z.array(disaggregationLineSchema),
});
export const disaggregationCreateSchema = z
  .object({ reasonId: z.uuid().nullable(), comment: z.string().nullable() })
  .strict();
export const disaggregationUpdateSchema = z
  .object({
    reasonId: z.uuid().nullable(),
    comment: z.string().nullable(),
    expectedRev: z.number().int(),
  })
  .strict();
export const disaggregationLineInputSchema = z
  .object({ input: z.string(), sscc: ssccSchema.nullable() })
  .strict();
export const disaggregationLinesAddSchema = z
  .object({
    lines: z.array(disaggregationLineInputSchema).min(1).max(DISAGGREGATION_MAX_LINES_PER_REQUEST),
    import: z.boolean(),
  })
  .strict();
export const disaggregationTransitionSchema = z.object({ expectedRev: z.number().int() }).strict();

/** `data` of a `code_releases` feed item; the item's `id` is the box's. */
export const codeReleaseRecordSchema = z.object({
  shiftId: z.uuid(),
  documentId: z.uuid(),
  releasedAt: z.string(),
  codeCount: z.number().int().nonnegative(),
});

/** The list's filters (Р16): instants of the host's format, not dates. */
export interface DisaggregationFilter {
  status?: z.infer<typeof disaggregationStatusSchema>;
  reasonId?: string;
  from?: string;
  to?: string;
  q?: string;
}

// plus `export type X = z.infer<typeof xSchema>` for every schema above.

/** The query string of `GET /v1/office/disaggregation`, keys in a fixed order. */
export function disaggregationQuery(filter: DisaggregationFilter = {}): string {
  const params = new URLSearchParams();
  for (const key of ["status", "reasonId", "from", "to", "q"] as const) {
    const value = filter[key];
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
```

`HostApi` (`src/host/api.ts`) получает методы по образцу `listCounterparties` /
`updateCounterparty` (`:453-469`) и `deleteShift` (`:613`):

```ts
listDisaggregationReasons: (token: string) => Promise<DisaggregationReason[]>;
createDisaggregationReason: (token: string, create: DisaggregationReasonCreate) =>
  Promise<DisaggregationReason>;
updateDisaggregationReason: (token: string, id: string, update: DisaggregationReasonUpdate) =>
  Promise<DisaggregationReason>;
listDisaggregations: (token: string, filter?: DisaggregationFilter) =>
  Promise<DisaggregationDocument[]>;
getDisaggregation: (token: string, id: string) => Promise<DisaggregationDetail>;
createDisaggregation: (token: string, create: DisaggregationCreate) =>
  Promise<DisaggregationDetail>;
updateDisaggregation: (token: string, id: string, update: DisaggregationUpdate) =>
  Promise<DisaggregationDetail>;
addDisaggregationLines: (token: string, id: string, add: DisaggregationLinesAdd) =>
  Promise<DisaggregationDetail>;
/** `DELETE …/lines/{lineId}`: the card without the line. */
deleteDisaggregationLine: (token: string, id: string, lineId: string) =>
  Promise<DisaggregationDetail>;
/** `409 conflict` `invalid_lines`: the fresh statuses are saved, read the card again. */
applyDisaggregation: (token: string, id: string, transition: DisaggregationTransition) =>
  Promise<DisaggregationDetail>;
cancelDisaggregation: (token: string, id: string, transition: DisaggregationTransition) =>
  Promise<DisaggregationDetail>;
```

Пути:

- `/v1/office/disaggregation-reasons[/{id}]`;
- `/v1/office/disaggregation${disaggregationQuery(filter)}`;
- `/v1/office/disaggregation/{id}`, `…/lines`, `…/lines/{lineId}`, `…/apply`, `…/cancel`.

`fakeHostApi` (`test/support/office.tsx:32`) получает по моку на каждый метод
(`unexpected(...)`).

- [ ] **Шаг 1: фикстуры.** Общие id:
  - документ — `6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c`;
  - причина — `d15a0000-0000-4000-8000-000000000003`;
  - администратор — `2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e`;
  - смена — `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`;
  - товар — `6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f`;
  - короб — `b0000000-0000-4000-8000-000000000001`;
  - паллета — `a0000000-0000-4000-8000-000000000001`.

  SSCC с контрольной цифрой: короб `046006820000015000`, второй короб `046006820000015017`,
  паллета `146006820000000409`.

  `disaggregation-detail.json` — черновик, по строке каждого достижимого статуса:

  ```text
  {
    "document": {
      "id": "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c",
      "docNo": "DSG-26-0001",
      "status": "draft",
      "reasonId": "d15a0000-0000-4000-8000-000000000003",
      "reasonName": "Повреждена упаковка",
      "comment": "Короб помят при погрузке",
      "source": "manual",
      "lineCount": 5,
      "codeCount": 12,
      "createdBy": "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
      "createdByName": "Ирина Смирнова",
      "createdAt": "2026-10-13T09:00:00Z",
      "appliedAt": null,
      "appliedBy": null,
      "appliedByName": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "rev": 41
    },
    "lines": [
      {
        "id": "c0000000-0000-4000-8000-000000000001",
        "ssccInput": "(00)046006820000015000",
        "sscc": "046006820000015000",
        "boxId": "b0000000-0000-4000-8000-000000000001",
        "palletId": null,
        "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        "shiftNumber": "OCT26-003",
        "status": "ok",
        "productId": "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
        "productName": "Молоко 3,2% 0,9 л",
        "codeCount": 12,
        "validatedAt": "2026-10-13T09:01:00Z"
      },
      … ещё четыре строки, см. таблицу ниже
    ]
  }
  ```

  Остальные четыре строки (`validatedAt` у всех тот же; у последних двух `sscc`, `boxId`,
  `palletId`, `shiftId`, `shiftNumber`, `productId`, `productName` — `null`, `codeCount: 0`).
  Многоточие в блоке выше — место этих строк, в файле его нет:

  | `id` (хвост) | `ssccInput`          | `sscc`               | цель                 | `status`               | `codeCount` |
  | ------------ | -------------------- | -------------------- | -------------------- | ---------------------- | ----------- |
  | `…0002`      | `146006820000000409` | `146006820000000409` | `palletId` — паллета | `shift_open`           | 0           |
  | `…0003`      | `046006820000015017` | `046006820000015017` | `boxId` — `b…0002`   | `already_disassembled` | 0           |
  | `…0004`      | `046006820000015000` | `null`               | —                    | `duplicate`            | 0           |
  | `…0005`      | `MRK-000742`         | `null`               | —                    | `not_found`            | 0           |

  У строк с целью `shiftId`, `shiftNumber`, `productId`, `productName` — как у первой.

  Остальные фикстуры:

  - `disaggregation-document.json` — тот же документ, проведённый: `status: "applied"`,
    `appliedAt: "2026-10-13T09:05:00Z"`, `appliedBy` — администратор, `appliedByName: "Ирина
Смирнова"`, `lineCount: 1`, `codeCount: 12`, `rev: 44`.
  - `disaggregation-reason.json`:
    `{ "id": "d15a0000-0000-4000-8000-000000000003", "name": "Повреждена упаковка",
"sortOrder": 30, "archived": false, "rev": 0 }`.
  - `disaggregation-reason-create.json`: `{ "name": "Перепаковка по заказу", "sortOrder": 50 }`.
  - `disaggregation-reason-update.json`:
    `{ "name": "Повреждена упаковка", "sortOrder": 35, "archived": true, "expectedRev": 0 }`.
  - `disaggregation-create.json`:
    `{ "reasonId": "d15a0000-0000-4000-8000-000000000003", "comment": null }`.
  - `disaggregation-update.json` — `reasonId`, `comment: "Короб помят при погрузке"`,
    `expectedRev: 40`.
  - `disaggregation-lines-add.json`:
    `{ "lines": [ { "input": "(00)046006820000015000", "sscc": "046006820000015000" },
{ "input": "MRK-000742", "sscc": null } ], "import": false }`.
  - `disaggregation-transition.json`: `{ "expectedRev": 41 }`.
  - `error-disaggregation-invalid-lines.json`:

    ```json
    {
      "error": {
        "code": "conflict",
        "message": "some lines of the document are not ok",
        "details": { "constraint": "invalid_lines", "invalidLines": 4 }
      }
    }
    ```

  - `changes-code-releases.json` — `hostId` из `changes-people.json`, `rev: 44`,
    `hasMore: false`, один элемент:

    ```json
    {
      "entity": "code_releases",
      "id": "b0000000-0000-4000-8000-000000000001",
      "rev": 44,
      "deleted": false,
      "data": {
        "shiftId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        "documentId": "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c",
        "releasedAt": "2026-10-13T09:05:00Z",
        "codeCount": 12
      }
    }
    ```

- [ ] **Шаг 2: красные тесты.**

  Rust, `proto/tests/disaggregation.rs` (помощники `fixture`, `round_trip` — копия из
  `proto/tests/warehouse.rs`):

  ```rust
  use markiro_proto::disaggregation::{
      constraints, CodeReleaseRecord, DisaggregationCreate, DisaggregationDetail,
      DisaggregationDocument, DisaggregationLineStatus, DisaggregationLinesAdd,
      DisaggregationReason, DisaggregationReasonCreate, DisaggregationReasonUpdate,
      DisaggregationStatus, DisaggregationTransition, DisaggregationUpdate,
  };
  use markiro_proto::{entities, ChangesResponse, ErrorBody};

  #[test]
  fn every_disaggregation_fixture_round_trips() {
      let detail: DisaggregationDetail = round_trip("disaggregation-detail.json");
      assert_eq!(
          detail.lines.iter().map(|line| line.status).collect::<Vec<_>>(),
          [
              DisaggregationLineStatus::Ok,
              DisaggregationLineStatus::ShiftOpen,
              DisaggregationLineStatus::AlreadyDisassembled,
              DisaggregationLineStatus::Duplicate,
              DisaggregationLineStatus::NotFound,
          ]
      );
      let applied: DisaggregationDocument = round_trip("disaggregation-document.json");
      assert_eq!(applied.status, DisaggregationStatus::Applied);
      round_trip::<DisaggregationReason>("disaggregation-reason.json");
      round_trip::<DisaggregationReasonCreate>("disaggregation-reason-create.json");
      round_trip::<DisaggregationReasonUpdate>("disaggregation-reason-update.json");
      round_trip::<DisaggregationCreate>("disaggregation-create.json");
      round_trip::<DisaggregationUpdate>("disaggregation-update.json");
      round_trip::<DisaggregationLinesAdd>("disaggregation-lines-add.json");
      round_trip::<DisaggregationTransition>("disaggregation-transition.json");
      let error: ErrorBody = round_trip("error-disaggregation-invalid-lines.json");
      assert_eq!(
          error.error.details.unwrap()["constraint"],
          constraints::INVALID_LINES
      );
  }

  ```

  Ещё два теста файла:

  - **`a_code_release_rides_the_feed_keyed_by_its_box`** — элемент `changes-code-releases.json`
    имеет `entity == entities::CODE_RELEASES`, `id` короба, а `data` читается как
    `CodeReleaseRecord` с `code_count == 12`.
  - **`the_requests_refuse_an_unknown_field_and_the_statuses_read_their_names`** — лишнее поле
    `boxId` в строке `disaggregation-lines-add.json` отказывает; `as_str` и `FromStr` трёх
    статусов документа сходятся; `"written_off".parse::<DisaggregationLineStatus>()` — ошибка.

  Vitest, `test/disaggregation-protocol.test.ts` (помощник `fixture` — как в
  `test/warehouse-protocol.test.ts:18`):
  - каждая фикстура читается своей схемой и совпадает с собой (`toEqual(fixture(name))`);
  - `changes-code-releases.json` проходит `changesResponseSchema`, а `data` элемента —
    `codeReleaseRecordSchema`;
  - `disaggregationLinesAddSchema` отказывает 501 строке и лишнему полю;
  - `disaggregationLineStatusSchema.safeParse("written_off").success === false`;
  - `DISAGGREGATION_CONSTRAINTS` совпадает с `constraint` фикстуры ошибки;
  - `disaggregationQuery({ q: "0001", status: "draft" })` равно `"?status=draft&q=0001"`,
    `disaggregationQuery()` равно `""`.

  `test/api.test.ts` — по строке таблицы (`[имя, ответ, вызов, { method, path, body }]`, как
  `updateCounterparty` на `:311`) на каждый из 11 методов. Например:

  ```ts
  [
    "applyDisaggregation",
    fixture("disaggregation-detail.json"),
    (api) => api.applyDisaggregation(TOKEN, DOCUMENT_ID, { expectedRev: 41 }),
    {
      method: "POST",
      path: `/v1/office/disaggregation/${DOCUMENT_ID}/apply`,
      body: { expectedRev: 41 },
    },
  ],
  [
    "listDisaggregations with filters",
    [fixture("disaggregation-document.json")],
    (api) => api.listDisaggregations(TOKEN, { status: "applied", q: "DSG-26" }),
    { method: "GET", path: "/v1/office/disaggregation?status=applied&q=DSG-26", body: undefined },
  ],
  ```

  Прогон (должен упасть):
  - `cargo … test -p markiro-proto --test disaggregation`;
  - `pnpm … exec vitest run test/disaggregation-protocol.test.ts test/api.test.ts`.

- [ ] **Шаг 3: реализация** по интерфейсам выше. `client.request` для `DELETE` с телом-ответом —
      та же форма, что `GET` (`schema: disaggregationDetailSchema`).
- [ ] **Шаг 4: зелёные тесты, `cargo fmt --check`, typecheck, lint, prettier, коммит**
      `feat(standalone): disaggregation documents, reasons and code releases on the wire`.

## Задача 2: хост — миграция `0024`

**Files:** Create `host/migrations/0024_disaggregation.sql`, `host/tests/disaggregation_schema.rs`.

- [ ] **Шаг 0:** `ls apps/standalone/host/migrations` в `claude/integration` и
      `git -C <wt> ls-tree --name-only origin/claude/fb-* -- apps/standalone/host/migrations` (или
      `ls /tmp/claude/wt/fb-*/apps/standalone/host/migrations`). Если `0024` занят — следующий
      свободный номер, запись в «Отклонения».
- [ ] **Шаг 1: красный тест схемы** (`host/tests/disaggregation_schema.rs`):

  ```rust
  mod support;

  use support::app::TestApp;

  #[tokio::test]
  async fn the_migration_seeds_five_reasons_and_a_zero_counter() {
      let app = TestApp::new().await;
      let reasons: Vec<(String, String, i64, bool)> = sqlx::query_as(
          "SELECT id, name, sort_order, archived FROM disaggregation_reasons ORDER BY sort_order",
      )
      .fetch_all(&app.state.pool)
      .await
      .unwrap();
      assert_eq!(
          reasons.iter().map(|(_, name, order, _)| (name.as_str(), *order)).collect::<Vec<_>>(),
          [
              ("Не тот товар", 10),
              ("Неверное количество", 20),
              ("Повреждена упаковка", 30),
              ("Брак по качеству", 40),
              ("Другое", 90),
          ]
      );
      assert!(reasons.iter().all(|(id, _, _, archived)| id.starts_with("d15a0000-") && !archived));
      let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM disaggregation_doc_counters")
          .fetch_one(&app.state.pool)
          .await
          .unwrap();
      assert_eq!(seq, 0);
  }

  ```

  Ещё два теста файла:

  - **`the_tables_refuse_what_no_row_may_hold`** — каждый `INSERT` отказывает по `CHECK` (или
    `FOREIGN KEY`): вторая строка счётчика (`id = 2`), причина из пробелов, строка `duplicate` с
    `box_id`, проведённый документ без причины, строка с `box_id` и `pallet_id` сразу.
  - **`the_lookups_use_their_indexes`** — `EXPLAIN QUERY PLAN` называет индекс:
    - строки по коробу — `disaggregation_lines_box`;
    - строки документа по порядку — автоиндекс `UNIQUE (document_id, position)`;
    - `code_releases` по `rev` — `code_releases_rev`.

  Имя автоиндекса `UNIQUE (document_id, position)` проверить по `sqlite_master`; если SQLite
  назовёт его иначе, тест берёт настоящее имя. Прогон
  `cargo … test -p markiro-host --test disaggregation_schema` — красный.

- [ ] **Шаг 2: миграция** (полный текст):

  ```sql
  -- Office disaggregation documents (plan ДЗГ, parity spec §5.1; the cloud's
  -- `packages/db/src/schema/disaggregation.ts`). A document takes closed
  -- boxes and pallets of closed shifts apart from the office: its lines name
  -- them by SSCC, and its apply does to each box what a station's
  -- `disassemble` exception does (`host/src/facts/exception.rs`) and to each
  -- pallet what a station's pallet `disassemble` does. The fact tables keep a
  -- device's records only (`box_exceptions.device_id` and `record_id` are
  -- NOT NULL), so the applied document's line is itself the record of the
  -- office's action, and a reader of a box's history joins both. As in
  -- `0010`, every value is checked before it is written
  -- (`host/src/disaggregation.rs`, `routes/disaggregation*.rs`); the CHECKs
  -- hold what no row may break.

  -- The site's reasons (the cloud's per tenant). Archived instead of deleted:
  -- a document keeps naming its reason. Five defaults (owner decision ПР-3)
  -- with fixed ids, so every host has the same ones; the office renames or
  -- archives them like any other.
  CREATE TABLE disaggregation_reasons (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL,
    rev INTEGER NOT NULL
  );
  INSERT INTO disaggregation_reasons (id, name, sort_order, archived, created_at, rev) VALUES
    ('d15a0000-0000-4000-8000-000000000001', 'Не тот товар', 10, 0,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
    ('d15a0000-0000-4000-8000-000000000002', 'Неверное количество', 20, 0,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
    ('d15a0000-0000-4000-8000-000000000003', 'Повреждена упаковка', 30, 0,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
    ('d15a0000-0000-4000-8000-000000000004', 'Брак по качеству', 40, 0,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
    ('d15a0000-0000-4000-8000-000000000005', 'Другое', 90, 0,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0);

  -- The one counter of `DSG-YY-NNNN`, as the cloud's per tenant: never reset
  -- by year. A restore lifts it above both databases (`restore.rs`).
  CREATE TABLE disaggregation_doc_counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seq INTEGER NOT NULL CHECK (last_seq >= 0)
  );
  INSERT INTO disaggregation_doc_counters (id, last_seq) VALUES (1, 0);

  -- A document: a draft until it is applied (for good) or cancelled. `seq`
  -- is the counter's number, `doc_no` its text with the year of creation.
  CREATE TABLE disaggregation_documents (
    id TEXT NOT NULL PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE CHECK (seq > 0),
    doc_no TEXT NOT NULL UNIQUE CHECK (doc_no GLOB 'DSG-[0-9][0-9]-[0-9][0-9][0-9][0-9]*'),
    status TEXT NOT NULL CHECK (status IN ('draft', 'applied', 'cancelled')),
    reason_id TEXT REFERENCES disaggregation_reasons (id),
    comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 500),
    source TEXT NOT NULL CHECK (source IN ('manual', 'import')),
    created_by TEXT NOT NULL REFERENCES office_users (id),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    applied_by TEXT REFERENCES office_users (id),
    cancelled_at TEXT,
    cancelled_by TEXT REFERENCES office_users (id),
    updated_at TEXT NOT NULL,
    rev INTEGER NOT NULL,
    CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
    CHECK ((applied_at IS NULL) = (applied_by IS NULL)),
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
    CHECK (status <> 'applied' OR reason_id IS NOT NULL)
  );
  CREATE INDEX disaggregation_documents_created ON disaggregation_documents (created_at);
  CREATE INDEX disaggregation_documents_status ON disaggregation_documents (status, created_at);

  -- One line per input: the text as typed or imported, the SSCC the domain
  -- read from it (NULL when none, and for a repeat of an SSCC already in the
  -- document), and what it named when last checked. An apply checks every
  -- line again from the live tables; `product_id` and `code_count` are what
  -- the office shows. A line names a box or a pallet, never both (box and
  -- pallet SSCCs differ in their extension digit).
  CREATE TABLE disaggregation_document_lines (
    id TEXT NOT NULL PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
    position INTEGER NOT NULL CHECK (position > 0),
    sscc_input TEXT NOT NULL CHECK (length(sscc_input) BETWEEN 1 AND 64),
    sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
    box_id TEXT REFERENCES boxes (id),
    pallet_id TEXT REFERENCES pallets (id),
    status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'not_closed', 'shift_open',
      'already_disassembled', 'duplicate')),
    product_id TEXT REFERENCES products (id),
    code_count INTEGER NOT NULL DEFAULT 0 CHECK (code_count >= 0),
    validated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (document_id, position),
    CHECK (box_id IS NULL OR pallet_id IS NULL),
    CHECK ((status IN ('not_found', 'duplicate')) = (box_id IS NULL AND pallet_id IS NULL)),
    CHECK (sscc IS NOT NULL OR status IN ('not_found', 'duplicate'))
  );
  CREATE UNIQUE INDEX disaggregation_lines_document_sscc
    ON disaggregation_document_lines (document_id, sscc) WHERE sscc IS NOT NULL;
  CREATE INDEX disaggregation_lines_sscc
    ON disaggregation_document_lines (sscc) WHERE sscc IS NOT NULL;
  CREATE INDEX disaggregation_lines_box
    ON disaggregation_document_lines (box_id) WHERE box_id IS NOT NULL;
  CREATE INDEX disaggregation_lines_pallet
    ON disaggregation_document_lines (pallet_id) WHERE pallet_id IS NOT NULL;

  -- The station feed's `code_releases` (plan ДЗГ): one row per box whose
  -- codes an applied document freed. The unit is the box, not the code: a
  -- station deletes its codes of that box, as its own disassembly does, and
  -- one apply of thousands of boxes stays a feed revision of thousands of
  -- small items. A box is taken apart once, so the box is the key; a row is
  -- never deleted and has no tombstone.
  CREATE TABLE code_releases (
    box_id TEXT NOT NULL PRIMARY KEY REFERENCES boxes (id),
    shift_id TEXT NOT NULL REFERENCES shifts (id),
    document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
    code_count INTEGER NOT NULL CHECK (code_count >= 0),
    released_at TEXT NOT NULL,
    rev INTEGER NOT NULL
  );
  CREATE INDEX code_releases_rev ON code_releases (rev);
  CREATE INDEX code_releases_document ON code_releases (document_id);
  ```

  Строку с `status = 'not_found'` и непустым `sscc` (SSCC прочитан, но ни короба, ни паллеты нет)
  CHECK пропускает: при проведении она может стать `ok`, если позднее придёт `box_closed`.

- [ ] **Шаг 3:** тест, что миграция применяется к базе с данными смен. Старый путь — как в
      `tests/facts.rs:7200-7260` (база на предыдущей миграции, затем `MIGRATOR`): короба и
      смены на месте, `PRAGMA foreign_key_check` пуст.
- [ ] **Шаг 4: зелёные тесты, полный `cargo … test -p markiro-host`** (номер последней миграции
      читают `support/backup.rs:25` и тесты копий), `cargo fmt --check`, коммит
      `feat(standalone): host — disaggregation tables, default reasons and code releases (migration 0024)`.

## Задача 3: хост — справочник причин

**Files:** Create `host/src/routes/disaggregation_reasons.rs`, `host/tests/disaggregation_reasons.rs`;
Modify `host/src/{auth.rs,audit.rs,server.rs}`, `host/src/routes/mod.rs`.

**Interfaces:**

```rust
// auth.rs, beside `plans_shifts`
/// Whether a role keeps disaggregation documents and their reasons (plan
/// ДЗГ: administrators and technologists, as shifts and exports). No
/// wildcard arm: a new role does not compile until it is placed here.
pub fn disaggregates(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
    }
}
impl OfficeContext {
    pub fn require_disaggregation(&self) -> Result<(), ApiError>;
    pub async fn require_disaggregation_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError>;
}

// audit.rs actions
pub const DISAGGREGATION_REASON_CREATE: &str = "disaggregation_reason.create";
pub const DISAGGREGATION_REASON_UPDATE: &str = "disaggregation_reason.update";

// routes/disaggregation_reasons.rs
pub async fn list_reasons(State<AppState>, OfficeContext) -> Result<Json<Vec<DisaggregationReason>>, ApiError>;
pub async fn create_reason(State<AppState>, OfficeContext, ApiJson<DisaggregationReasonCreate>) -> Result<Json<DisaggregationReason>, ApiError>;
pub async fn update_reason(State<AppState>, OfficeContext, ApiPath<String>, ApiJson<DisaggregationReasonUpdate>) -> Result<Json<DisaggregationReason>, ApiError>;
```

Отказ — тексты как у соседей: `ApiError::forbidden("a disaggregation role is required")`.

- [ ] **Шаг 1: красные тесты** (`host/tests/disaggregation_reasons.rs`; помощники `admin()`,
      `technologist_session`, `audit_trail`, `audit_row`, `audit_rows` из `support/app.rs`):
  - **`the_list_holds_the_defaults_in_their_order`** — `GET` отдаёт пять имён в порядке Р11.
  - **`a_technologist_adds_and_archives_a_reason_and_each_change_is_audited`**:
    - технолог создаёт `{ "name": "  Перепаковка по заказу ", "sortOrder": 50 }`, получает
      имя без пробелов;
    - затем `PUT` с `archived: true` и `expectedRev`;
    - тот же `PUT` с новой ревизией — `200` без новой строки аудита (`audit_rows` не растёт);
    - `audit_trail(…, "disaggregation_reason.create")` равен
      `[audit_row(&tech_id, "disaggregation_reason.create", "disaggregation_reason", id,
json!({ "name": "Перепаковка по заказу", "sortOrder": 50 }))]`;
    - для `.update` детали —
      `{ "changed": ["archived"], "archived": { "from": false, "to": true } }`.
  - **`a_bad_name_a_stale_rev_an_unknown_reason_and_no_session_are_refused`**:
    - имя `""`, имя из 121 символа и имя с `"\u{7}"` — `400` на `name`;
    - старая `expectedRev` — `409 stale_revision` с `currentRev`;
    - неизвестный id — `404`;
    - `GET` с ключом устройства без сессии — `401`, `details.credential == "session"`.

  Форма `details` правки — как у `audit::update_details` (`audit.rs:100`). Прогон
  `cargo … test -p markiro-host --test disaggregation_reasons` — красный.

- [ ] **Шаг 2: реализация** — модуль по образцу `routes/counterparties.rs` целиком
      (`SELECT`/`record`/`read`, `begin_write`, `require_*_in`, `next_revision`, аудит,
      `commit_with_revision`). Отличия:
  - права — `require_disaggregation` / `require_disaggregation_in`;
  - имя — `validate::clean_text("name", &name, MAX_REASON_NAME_CHARS, "the name")`;
  - `sortOrder` в пределах `-1_000_000..=1_000_000`, иначе `validation("sortOrder", …)`;
  - список `ORDER BY archived, sort_order, name, id`;
  - детали создания `{ "name", "sortOrder" }`; правка — `update_details` по `name`,
    `sortOrder`, `archived`, без изменений — ответ как есть.

  Маршруты в `server.rs` рядом с контрагентами:

  ```rust
  .route(
      "/v1/office/disaggregation-reasons",
      get(crate::routes::disaggregation_reasons::list_reasons)
          .post(crate::routes::disaggregation_reasons::create_reason),
  )
  .route(
      "/v1/office/disaggregation-reasons/{id}",
      put(crate::routes::disaggregation_reasons::update_reason),
  )
  ```

- [ ] **Шаг 3: зелёные тесты, `cargo fmt --check`, коммит**
      `feat(standalone): host — the disaggregation reasons' dictionary`.

## Задача 4: хост — документы: создание, список, карточка, шапка, строки, отмена

**Files:** Create `host/src/disaggregation.rs`, `host/src/routes/disaggregation.rs`,
`host/tests/disaggregation.rs`; Modify `host/src/{lib.rs,audit.rs,server.rs}`,
`host/src/routes/mod.rs`.

**Interfaces (`host/src/disaggregation.rs`):**

```rust
//! Office disaggregation documents (plan ДЗГ, parity spec §5.1): the
//! number, the line rules and the apply, which `routes::disaggregation`
//! runs inside its write transaction. The cloud's
//! `apps/api/src/modules/disaggregation/{doc-number.ts,line-validation.ts,
//! disaggregation.service.ts}` is the reference. Only a closed box or
//! pallet of a closed shift is taken apart (owner decision ПР-1), so the
//! office never argues with a box a station still fills.

use markiro_proto::disaggregation::DisaggregationLineStatus as LineStatus;
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// `DSG-YY-NNNN` (the cloud's `formatDocNo`): the year of creation in UTC,
/// the number padded to four digits and never cut.
pub fn format_doc_no(seq: i64, year: i32) -> String {
    format!("DSG-{:02}-{seq:04}", year.rem_euclid(100))
}

/// The site's next document number, inside the caller's write transaction.
pub async fn next_seq(conn: &mut SqliteConnection) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "UPDATE disaggregation_doc_counters SET last_seq = last_seq + 1 WHERE id = 1 \
         RETURNING last_seq",
    )
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)
}

/// What an SSCC names now and the line's status for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    pub status: LineStatus,
    pub product_id: String,
    pub code_count: i64,
}

/// The first rule that holds (the cloud's order): an open box or pallet,
/// then an open shift (ПР-1), then one taken apart already.
pub fn classify(closed: bool, shift_closed: bool, disassembled: bool) -> LineStatus {
    if !closed {
        LineStatus::NotClosed
    } else if !shift_closed {
        LineStatus::ShiftOpen
    } else if disassembled {
        LineStatus::AlreadyDisassembled
    } else {
        LineStatus::Ok
    }
}

/// A box by its SSCC (`boxes_sscc`) with its live codes.
const BOX_SQL: &str = "SELECT b.id, b.closed_at IS NOT NULL, s.status = 'closed', \
     b.disassembled_at IS NOT NULL, s.product_id, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
     FROM boxes b JOIN shifts s ON s.id = b.shift_id WHERE b.sscc = ?";

/// A pallet by its SSCC (`pallets_sscc`) with the live codes of its boxes:
/// a box taken apart has none, as in the cloud.
const PALLET_SQL: &str = "SELECT p.id, p.closed_at IS NOT NULL, s.status = 'closed', \
     p.disassembled_at IS NOT NULL, s.product_id, \
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      WHERE b.pallet_id = p.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
     FROM pallets p JOIN shifts s ON s.id = p.shift_id WHERE p.sscc = ?";

/// What `sscc` (18 digits) names: a box first, then a pallet (the cloud's
/// `resolveLineTargets`); `None` when neither — the line is `not_found`.
pub async fn resolve(conn: &mut SqliteConnection, sscc: &str) -> Result<Option<Target>, ApiError> {
    type Row = (String, bool, bool, bool, String, i64);
    let found: Option<Row> = sqlx::query_as(BOX_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((id, closed, shift_closed, disassembled, product_id, code_count)) = found {
        return Ok(Some(Target {
            box_id: Some(id),
            pallet_id: None,
            status: classify(closed, shift_closed, disassembled),
            product_id,
            code_count,
        }));
    }
    let found: Option<Row> = sqlx::query_as(PALLET_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(found.map(|(id, closed, shift_closed, disassembled, product_id, code_count)| Target {
        box_id: None,
        pallet_id: Some(id),
        status: classify(closed, shift_closed, disassembled),
        product_id,
        code_count,
    }))
}
```

Проведение (`apply_targets`) — задача 5.

**Interfaces (`routes/disaggregation.rs`):**

```rust
pub async fn list_documents(State<AppState>, OfficeContext, ApiQuery<ListQuery>) -> Result<Json<Vec<DisaggregationDocument>>, ApiError>;
pub async fn create_document(State<AppState>, OfficeContext, ApiJson<DisaggregationCreate>) -> Result<Json<DisaggregationDetail>, ApiError>;
pub async fn get_document(State<AppState>, OfficeContext, ApiPath<String>) -> Result<Json<DisaggregationDetail>, ApiError>;
pub async fn update_document(State<AppState>, OfficeContext, ApiPath<String>, ApiJson<DisaggregationUpdate>) -> Result<Json<DisaggregationDetail>, ApiError>;
pub async fn add_lines(State<AppState>, OfficeContext, ApiPath<String>, ApiJson<DisaggregationLinesAdd>) -> Result<Json<DisaggregationDetail>, ApiError>;
pub async fn delete_line(State<AppState>, OfficeContext, ApiPath<(String, String)>) -> Result<Json<DisaggregationDetail>, ApiError>;
pub async fn cancel_document(State<AppState>, OfficeContext, ApiPath<String>, ApiJson<DisaggregationTransition>) -> Result<Json<DisaggregationDetail>, ApiError>;
// задача 5
pub async fn apply_document(State<AppState>, OfficeContext, ApiPath<String>, ApiJson<DisaggregationTransition>) -> Result<Json<DisaggregationDetail>, ApiError>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ListQuery { status: Option<String>, reason_id: Option<String>, from: Option<String>, to: Option<String>, q: Option<String> }

/// The card as the office reads it, through `conn` (the caller's
/// transaction, so a write answers with what it wrote).
async fn detail(conn: &mut SqliteConnection, id: &str) -> Result<Option<DisaggregationDetail>, ApiError>;
/// A draft for a write: 404 without it, `conflict` `document_not_draft`
/// after it is applied or cancelled.
async fn draft(conn: &mut SqliteConnection, id: &str) -> Result<DraftRow, ApiError>;
```

`audit.rs`:

```rust
pub const DISAGGREGATION_CREATE: &str = "disaggregation.create";
pub const DISAGGREGATION_UPDATE: &str = "disaggregation.update";
pub const DISAGGREGATION_LINES_ADD: &str = "disaggregation.lines.add";
pub const DISAGGREGATION_LINE_DELETE: &str = "disaggregation.lines.delete";
/// `ok` with what the apply took apart, `failed` when a line was not `ok`.
pub const DISAGGREGATION_APPLY: &str = "disaggregation.apply";
pub const DISAGGREGATION_CANCEL: &str = "disaggregation.cancel";
```

Цель всех — `target_type: Some("disaggregation_document")`, `target_id: Some(&id)`.

- [ ] **Шаг 1: красные тесты** (`host/tests/disaggregation.rs`). Подготовка — существующие помощники
      `support/app.rs`. Полная подготовка (общая для задач 4 и 5, вынести в начало файла):

  ```rust
  mod support;

  use axum::http::StatusCode;
  use serde_json::{json, Value};
  use support::app::{
      admin, audit_row, audit_trail, box_closed, box_id, close_from_office, fact, instant,
      issue_block, ok_scan, open_floor, pair_device, receipts, record_id, shift_setup, sscc,
      Admin, Floor,
  };

  const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

  /// A station's shift with box 1 (codes 1-3) and box 2 (code 4) closed,
  /// box 3 open with code 5; `close` closes the shift from the office.
  async fn day(admin: &Admin, close: bool) -> Floor {
      let setup = shift_setup(admin).await;
      let (_, key) = pair_device(&admin.app, "station").await;
      let floor = open_floor(admin, &setup, &key, &setup.line).await;
      let block = issue_block(&admin.app, &key, BLOCK_REQUEST).await;
      let mut records = Vec::new();
      for (n, code, b) in [(1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 4, 2), (5, 5, 3)] {
          records.push(fact(&record_id(n), "scan", &floor.shift, ok_scan(code, &box_id(b), &instant(n, 0))));
      }
      records.push(fact(&record_id(6), "box_closed", &floor.shift,
          box_closed(&box_id(1), &block, 1500, &[1, 2, 3], &instant(1, 0), &instant(10, 0))));
      records.push(fact(&record_id(7), "box_closed", &floor.shift,
          box_closed(&box_id(2), &block, 1501, &[4], &instant(4, 0), &instant(11, 0))));
      let answered = receipts(&admin.app, &key, &records).await;
      assert!(answered.iter().all(|r| r["outcome"] == "accepted"), "{answered:?}");
      if close {
          close_from_office(admin, &floor.shift, "Конец смены").await;
      }
      floor
  }

  async fn create(admin: &Admin, body: Value) -> Value {
      let (status, detail) = admin.call("POST", "/v1/office/disaggregation", Some(body)).await;
      assert_eq!(status, StatusCode::OK, "{detail}");
      detail
  }

  async fn add(admin: &Admin, id: &str, lines: Value) -> (StatusCode, Value) {
      admin
          .call("POST", &format!("/v1/office/disaggregation/{id}/lines"),
              Some(json!({ "lines": lines, "import": false })))
          .await
  }

  fn line(input: &str, sscc: Option<&str>) -> Value {
      json!({ "input": input, "sscc": sscc })
  }

  const REASON: &str = "d15a0000-0000-4000-8000-000000000003";
  ```

  Тесты:

  - **`documents_are_numbered_by_one_counter_with_the_year`**:
    - два документа — `DSG-26-0001` и `DSG-26-0002` (часы `TestApp` — 2026, `support/app.rs:21`);
    - первый — `draft`, `reasonName: "Повреждена упаковка"`, `createdByName` — имя из
      `GET /v1/office/me`, `lines: []`;
    - `audit_trail(…, "disaggregation.create")[0]` равен `audit_row(&admin.id,
"disaggregation.create", "disaggregation_document", id, json!({ "docNo": "DSG-26-0001",
"reasonId": REASON, "comment": null }))`.
  - **`each_line_gets_the_clouds_status`**:

  ```rust
  #[tokio::test]
  async fn each_line_gets_the_clouds_status() {
      let admin = admin().await;
      let floor = day(&admin, false).await;
      let doc = create(&admin, json!({ "reasonId": REASON })).await;
      let id = doc["document"]["id"].as_str().unwrap();
      // The shift is still open: its closed box is `shift_open`.
      let (status, detail) = add(&admin, id, json!([
          line("(00)046006820000015000", Some(&sscc(1500))),
          line("046006820000015000", Some(&sscc(1500))),          // a repeat
          line("MRK-000742", None),                                // not an SSCC
          line(&sscc(1999), Some(&sscc(1999))),                    // nobody's
      ])).await;
      assert_eq!(status, StatusCode::OK, "{detail}");
      let statuses: Vec<&str> = detail["lines"].as_array().unwrap().iter()
          .map(|l| l["status"].as_str().unwrap()).collect();
      assert_eq!(statuses, ["shift_open", "duplicate", "not_found", "not_found"]);
      assert_eq!(detail["lines"][0]["boxId"], box_id(1));
      assert_eq!(detail["lines"][0]["codeCount"], 3);
      assert_eq!(detail["lines"][0]["shiftNumber"], json!(floor.number));
      assert_eq!(detail["lines"][1]["sscc"], Value::Null);
      assert_eq!(detail["document"]["lineCount"], 4);
      assert_eq!(detail["document"]["codeCount"], 3);
  }
  ```

  Продолжение того же теста: станция шлёт исключение `disassemble` короба 2
  (`box_exception("disassemble", &box_id(2), &instant(12, 0))` с `reasonCode: "damaged_package"`),
  офис закрывает смену. Во втором документе `sscc(1500)` — `ok`, `sscc(1501)` —
  `already_disassembled`.

  Ещё тесты файла:

  - **`a_pallet_line_names_the_pallet_and_counts_its_boxes_codes`** — смена с паллетами
    (`open_pallet_floor`, `issue_pallet_block`, `pallet_closed`, как в `tests/office_boxes.rs`):
    `palletId` задан, `boxId` пуст, `codeCount` — живые коды её коробов.
  - **`a_header_is_changed_only_on_a_draft_over_its_rev`**:
    - `PUT` с другой причиной и `expectedRev` — `200`, аудит `disaggregation.update` с
      `{"changed":["reasonId"],"reasonId":{"from":…,"to":…}}`;
    - тот же `PUT` повторно — без строки аудита;
    - старая ревизия — `409 stale_revision`;
    - архивная причина — `400` на `reasonId`;
    - неизвестная причина — `400` на `reasonId`;
    - комментарий из 501 символа — `400` на `comment`;
    - пустой комментарий — сохраняется как `null`.
  - **`lines_are_added_and_deleted_on_a_draft_only`**:
    - удаление строки — карточка без неё, аудит `disaggregation.lines.delete` с
      `{"docNo","lineId","ssccInput"}`;
    - неизвестная строка — `404`;
    - после отмены (`POST …/cancel`) и добавление, и удаление строк, и `PUT` получают
      `409 conflict` с `constraint: "document_not_draft"`;
    - аудит `disaggregation.cancel` с `{"docNo"}`; повторная отмена — тот же `409`.
  - **`the_limits_of_a_request_and_a_document`**:
    - 501 строка — `400` на `lines`;
    - 0 строк — `400` на `lines`;
    - вход из 65 символов — `400` на `lines.0.input`;
    - `sscc` из 17 цифр — `400` на `lines.0.sscc`;
    - документ с 10 000 строками отказывает 10 001-й — `400` на `lines`. Строки вставлять
      через API пачками по 500 SSCC вида `sscc(20000 + n)`: все `not_found`, это быстро.
  - **`import_marks_the_source`** — `"import": true` даёт `source: "import"` и аудит
    `{"docNo","added":2,"import":true}`.
  - **`the_list_filters_by_status_reason_period_and_number`**:
    - три документа: черновик, отменённый, второй черновик с другой причиной;
    - `?status=cancelled` → 1;
    - `?reasonId=…` → нужные;
    - `?q=0002` → один;
    - `?from=` позже всех → пусто (часы `TestApp` двигать `admin.app.clock.advance`);
    - `?status=bogus` → `400` на `status`;
    - `?from=2026-10-13` (дата, не момент) → `400` на `from`;
    - порядок — новые первыми.
  - **`every_office_role_reads_and_writes_and_a_device_alone_does_not`**:
    - технолог (`admin.technologist()`) создаёт документ и добавляет строки — `200`;
    - запрос только с ключом устройства (`with_device`, без сессии) — `401`,
      `details.credential == "session"`.

  `admin_name` — маленький помощник файла: `GET /v1/office/me` → `name`. Прогон
  `cargo … test -p markiro-host --test disaggregation` — красный.

- [ ] **Шаг 2: реализация.** `add_lines` (`routes/disaggregation.rs`) по шагам; запись — по
      образцу `apply_document` задачи 5:
  1. `require_disaggregation()`; число строк `1..=MAX_LINES_PER_REQUEST`, иначе `400` на `lines`.
  2. **До замка** вся строка проверяется целиком: `input` — `validate::clean_text(
&format!("lines.{n}.input"), …, MAX_INPUT_CHARS, "the input")`, `sscc` — `None` или ровно
     18 ASCII-цифр (иначе `400` на `lines.{n}.sscc`). Отказ ничего не пишет.
  3. `begin_write`, `require_disaggregation_in`, `draft(&mut tx, &id)`.
  4. `SELECT COUNT(*), COALESCE(MAX(position), 0)` строк документа: сумма с новыми больше
     `MAX_LINES_PER_DOCUMENT` — `400` на `lines`.
  5. `present: HashSet<String>` — непустые `sscc` документа. Для каждой строки по порядку:
     - `sscc: None` — `not_found`, без цели;
     - `sscc` уже в `present` — `duplicate`, `sscc = NULL` (маркер облака, вход сохраняется);
     - иначе `disaggregation::resolve`: `None` — `not_found` с `sscc`, иначе статус и цель из
       `Target`; `sscc` добавляется в `present`.

     `insert_line` с позицией `last + 1 + offset`.

  6. `next_revision`; `UPDATE disaggregation_documents SET source = CASE WHEN ? THEN 'import'
ELSE source END, updated_at = ?, rev = ?`.
  7. Аудит `disaggregation.lines.add` с `{ "docNo", "added", "import" }`; карточка `detail`
     через ту же транзакцию; `commit_with_revision`; ответ — карточка.

  `insert_line` пишет строку (`id` — `Uuid::new_v4`, `validated_at = created_at = at`, поля
  цели из `Target`).

  `draft`:
  - `SELECT doc_no, status, reason_id, comment, rev FROM disaggregation_documents WHERE id = ?`;
  - нет строки — `ApiError::not_found("no such document")`;
  - не `draft` — `ApiError::conflict(constraints::NOT_DRAFT, "the document is not a draft")`.

  Карточка (`detail`) — два запроса:

  ```sql
  SELECT d.id, d.doc_no, d.status, d.reason_id, r.name, d.comment, d.source,
    (SELECT COUNT(*) FROM disaggregation_document_lines l WHERE l.document_id = d.id),
    (SELECT COALESCE(SUM(l.code_count), 0) FROM disaggregation_document_lines l
      WHERE l.document_id = d.id),
    d.created_by, cu.name, d.created_at, d.applied_at, d.applied_by, au.name,
    d.cancelled_at, d.cancelled_by, d.rev
  FROM disaggregation_documents d
  LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id
  JOIN office_users cu ON cu.id = d.created_by
  LEFT JOIN office_users au ON au.id = d.applied_by
  WHERE d.id = ?
  ```

  ```sql
  SELECT l.id, l.sscc_input, l.sscc, l.box_id, l.pallet_id, l.status, l.product_id, p.name,
    l.code_count, l.validated_at, s.id, s.number_month_key, s.number_seq, s.created_from
  FROM disaggregation_document_lines l
  LEFT JOIN products p ON p.id = l.product_id
  LEFT JOIN boxes b ON b.id = l.box_id
  LEFT JOIN pallets pl ON pl.id = l.pallet_id
  LEFT JOIN shifts s ON s.id = COALESCE(b.shift_id, pl.shift_id)
  WHERE l.document_id = ? ORDER BY l.position
  ```

  Номер смены — `shifts::format_number(month_key, seq, origin)` (`shifts.rs:64`). Список —
  первый запрос без `WHERE d.id`, с фильтрами и `ORDER BY d.created_at DESC, d.seq DESC
LIMIT 1000`:
  - `status` разбирается через `DisaggregationStatus::from_str` (иначе `400` на `status`);
  - `reasonId` — `validate::client_uuid`;
  - `from` / `to` — `clock::parse_timestamp` и `format_timestamp` обратно (одно написание);
  - `q` — `clean_text` до 40 символов, `doc_no LIKE '%' || ? || '%'` с экранированием `%` и
    `_` (`ESCAPE '\'`).

  Создание:
  - причина (если задана) — `validate::client_uuid("reasonId")` и
    `SELECT archived FROM disaggregation_reasons WHERE id = ?`: нет или архивная — `400` на
    `reasonId`;
  - комментарий — `clean_text("comment", …, MAX_COMMENT_CHARS)`; пустая строка после обрезки —
    `None`;
  - `seq = next_seq`, `doc_no = format_doc_no(seq, state.now().year())`, `source = 'manual'`,
    `rev = next_revision`.

  Правка шапки — те же правила, `update_details(&[("reasonId", …), ("comment", …)])`: без
  изменений — ответ как есть, до `next_revision`.

  Отмена — `draft` под замком, сверка `expectedRev`, затем
  `status = 'cancelled', cancelled_at, cancelled_by`.

  Маршруты в `server.rs` рядом со сменами, по образцу соседних `.route(...)`:
  `/v1/office/disaggregation` (`get` `list_documents`, `post` `create_document`),
  `/{id}` (`get` `get_document`, `put` `update_document`), `/{id}/lines` (`post` `add_lines`),
  `/{id}/lines/{line_id}` (`delete` `delete_line`), `/{id}/apply` (`post` `apply_document`),
  `/{id}/cancel` (`post` `cancel_document`).

  Предел тела: 500 строк по 64 символа укладываются в JSON-предел роутера по умолчанию, отдельный
  слой не нужен. До задачи 5 `apply_document` отвечает
  `ApiError::method_not_allowed("plan ДЗГ task 5")`, чтобы роутер собирался. Шаг 2 задачи 5
  заменяет заглушку.

- [ ] **Шаг 3: зелёные тесты, `cargo fmt --check`, коммит**
      `feat(standalone): host — disaggregation documents: numbering, line checks, header, lines, cancel`.

## Задача 5: хост — проведение под замком фактов

**Files:** Modify `host/src/disaggregation.rs`, `host/src/routes/disaggregation.rs`,
`host/src/facts/rules.rs`; Create `host/tests/disaggregation_apply.rs`.

**Interfaces:**

```rust
// facts/rules.rs
/// An instant written as a device writes its own (`device_instant`'s form,
/// 24 characters with milliseconds): what the office's disaggregation
/// stamps on the fact tables, so their columns hold one kind of text.
pub fn device_text(at: OffsetDateTime) -> String;

// disaggregation.rs
/// What an apply took apart.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Applied {
    pub boxes: usize,
    pub pallets: usize,
    pub codes: usize,
}

/// Take apart the `ok` lines' boxes and pallets of document `document_id`
/// at `instant` (a device-form instant), inside the caller's write
/// transaction, and write each box's `code_releases` row with `rev`.
pub async fn apply_targets(
    conn: &mut SqliteConnection,
    document_id: &str,
    targets: &[Target],
    instant: &str,
    rev: i64,
) -> Result<Applied, ApiError>;
```

- [ ] **Шаг 1: красные тесты** (`host/tests/disaggregation_apply.rs`; `day`, `create`, `add`,
      `line` — копия помощников задачи 4 или общий модуль `tests/support/disaggregation.rs`,
      если исполнитель предпочтёт; `mod support;` подключает его):

  ```rust
  async fn apply(admin: &Admin, detail: &Value) -> (StatusCode, Value) {
      let id = detail["document"]["id"].as_str().unwrap();
      admin
          .call("POST", &format!("/v1/office/disaggregation/{id}/apply"),
              Some(json!({ "expectedRev": detail["document"]["rev"] })))
          .await
  }

  async fn code_check(admin: &Admin, key: &str, n: u32) -> Value {
      let (status, body) = admin.app
          .send(empty(with_device(request("GET", &format!("/v1/device/codes/{}", code_hash(n))), key)))
          .await;
      assert_eq!(status, StatusCode::OK, "{body}");
      body
  }

  #[tokio::test]
  async fn an_applied_box_frees_its_codes_and_keeps_its_contents_for_the_report() {
      let admin = admin().await;
      let floor = day(&admin, true).await;
      let doc = create(&admin, json!({ "reasonId": REASON })).await;
      let id = doc["document"]["id"].as_str().unwrap().to_owned();
      let (_, detail) = add(&admin, &id, json!([line(&sscc(1500), Some(&sscc(1500)))])).await;
      let rev_before = host_revision(&admin.app).await;

      let (status, applied) = apply(&admin, &detail).await;

      assert_eq!(status, StatusCode::OK, "{applied}");
      assert_eq!(applied["document"]["status"], "applied");
      assert_eq!(applied["document"]["appliedBy"], json!(admin.id));
      // Codes 1-3 are free; code 4 (box 2) still belongs to its scan.
      for n in [1, 2, 3] {
          assert_eq!(code_check(&admin, &floor.key, n).await["status"], "free");
      }
      assert_eq!(code_check(&admin, &floor.key, 4).await["status"], "taken");
      // The box's three items left it at the instant the box was taken apart.
      let (disassembled, removed): (String, Vec<String>) = {
          let pool = &admin.app.state.pool;
          let at: String = sqlx::query_scalar("SELECT disassembled_at FROM boxes WHERE id = ?")
              .bind(box_id(1)).fetch_one(pool).await.unwrap();
          let removed = sqlx::query_scalar("SELECT removed_at FROM box_items WHERE box_id = ?")
              .bind(box_id(1)).fetch_all(pool).await.unwrap();
          (at, removed)
      };
      assert_eq!(disassembled.len(), 24, "a device-form instant");
      assert_eq!(removed, vec![disassembled.clone(); 3]);
      // «Состав короба» still lists the three codes (office_reports.rs:39).
      let (status, report) = admin.call("GET", &format!("/v1/office/boxes/{}/report-data", box_id(1)), None).await;
      assert_eq!(status, StatusCode::OK, "{report}");
      assert_eq!(report["items"].as_array().map(Vec::len), Some(3), "{report}");
      // One revision for the whole apply, on the document and the release.
      let rev = host_revision(&admin.app).await;
      assert_eq!(rev, rev_before + 1);
      assert_eq!(applied["document"]["rev"], json!(rev));
      let release: (String, String, i64, i64) = sqlx::query_as(
          "SELECT shift_id, document_id, code_count, rev FROM code_releases WHERE box_id = ?",
      ).bind(box_id(1)).fetch_one(&admin.app.state.pool).await.unwrap();
      assert_eq!(release, (floor.shift.clone(), id.clone(), 3, rev));
      assert_eq!(
          audit_trail(&admin.app, "disaggregation.apply").await,
          [audit_row(&admin.id, "disaggregation.apply", "disaggregation_document", &id,
              json!({ "docNo": "DSG-26-0001", "boxes": 1, "pallets": 0, "codes": 3 }))]
      );
  }
  ```

  Список кодов «Состава короба» — поле `items` (`proto/fixtures/box-report-rows.json`).

  Ещё тесты файла:

  - **`an_office_disassembly_reads_in_the_exports_as_a_station_one`** — эталон паритета:
    - две базы `admin()`, в обеих `day(&admin, …)`;
    - в первой станция до закрытия шлёт исключение `disassemble` короба 1
      (`box_exception("disassemble", &box_id(1), &instant(20, 0))` с
      `reasonCode: "damaged_package"`), затем офис закрывает смену;
    - во второй офис закрывает смену и проводит документ по коробу 1;
    - `GET /v1/office/shifts/{id}/export-source` обеих совпадает в `codes`, `items` и в
      `boxes[].disassembledAt.is_some()`;
    - моменты, номера смен и id смен — разные, их нормализовать: заменить на `"<at>"` и сравнить
      по позициям.

    Так проверяется облачное правило `shift-export-source.service.ts`: выгрузка исключает
    расформированные короба.

  - **`a_pallet_line_takes_the_pallet_apart_and_leaves_its_boxes`**:
    - паллета из двух коробов;
    - после проведения у паллеты есть `disassembled_at`, у коробов — `disassembled_at IS NULL` и
      `pallet_id` на месте, коды заняты, `code_releases` пуст;
    - `GET /v1/office/shifts/{id}/pallets` — паллета расформирована;
    - `GET /v1/office/shifts/{id}/boxes` — короба живы.
  - **`a_box_and_its_pallet_in_one_document`** — оба ушли, `code_releases` — одна строка
    (короб).
  - **`an_apply_checks_every_line_again_and_keeps_the_fresh_statuses`**:
    - строки добавлены, пока смена открыта (`shift_open`);
    - смену закрывают, документ проводят — `200`: статусы пересчитаны, всё `ok`.

    Обратный случай:
    - строка `ok` добавлена; затем станция поздним исключением расформировывает тот же короб;
      закрытую смену это не останавливает: `mark_late`;
    - проведение — `409 conflict` с `details == {"constraint":"invalid_lines","invalidLines":1}`;
    - карточка показывает `already_disassembled`, документ — черновик с новой ревизией;
    - `code_releases` пуст, коды не тронуты;
    - аудит `disaggregation.apply` с исходом `failed` и деталями
      `{"docNo":…,"invalidLines":1}` (сравнить кортеж целиком; `audit_row` даёт `ok`, поэтому
      здесь кортеж собирается руками с `"failed"`).

  - **`what_an_apply_refuses_before_it_touches_anything`**:
    - без причины — `409` `reason_required`;
    - без строк — `409` `no_lines`;
    - со строкой `duplicate` или `not_found` — `409` `invalid_lines`;
    - старая `expectedRev` — `409 stale_revision`;
    - проведённый документ — `409` `document_not_draft`;
    - отменённый — `409` `document_not_draft`;
    - после каждого отказа `fact_rows` (`support/app.rs`) не меняются.
  - **`late_facts_after_an_apply_see_its_result`**:
    - после проведения станция шлёт исключение `reprint` короба 1 — `rejected` с `box_state`;
    - позднее `box_closed` короба 1 с тем же SSCC — `accepted` (повтор того же закрытия,
      `box_closed.rs:69-75`), короб остаётся расформированным;
    - скан кода 1 другой станцией в её открытой смене — `accepted` (код свободен) без записи в
      `code_conflicts`.
  - **`an_apply_waits_for_a_fact_batchs_write_lock`** — проведение и пакет фактов не
    перемешиваются:

    ```rust
    let held = markiro_host::db::begin_write(&admin.app.state.pool).await.unwrap();
    let applying = apply(&admin, &detail);
    tokio::pin!(applying);
    // The apply queues behind the held write transaction (BEGIN IMMEDIATE)…
    assert!(tokio::time::timeout(std::time::Duration::from_millis(300), &mut applying)
        .await
        .is_err());
    held.rollback().await.unwrap();
    // …and goes through once it is released.
    let (status, applied) = applying.await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    ```

    300 мс меньше `busy_timeout` (5 с, `db.rs:26`), поэтому проведение не падает, а ждёт. Если
    `admin.call` не `Unpin`, `tokio::pin!` это решает. Если среде теста недостаточно трёх
    свободных соединений пула, писать это в «Отклонения», а не ослаблять тест.

  - **`a_technologist_applies`** — `200`, `appliedBy` — технолог.

  Прогон `cargo … test -p markiro-host --test disaggregation_apply` — красный.

- [ ] **Шаг 2: реализация.**

  `facts/rules.rs`:

  ```rust
  pub fn device_text(at: OffsetDateTime) -> String {
      let at = at.to_offset(time::UtcOffset::UTC);
      format!(
          "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
          at.year(),
          u8::from(at.month()),
          at.day(),
          at.hour(),
          at.minute(),
          at.second(),
          at.millisecond()
      )
  }
  ```

  Юнит-тест рядом: `device_instant(&device_text(t)) == Some(t с точностью до мс)`.

  `disaggregation.rs`:

  ```rust
  pub async fn apply_targets(
      conn: &mut SqliteConnection,
      document_id: &str,
      targets: &[Target],
      instant: &str,
      rev: i64,
  ) -> Result<Applied, ApiError> {
      let mut applied = Applied::default();
      for target in targets {
          if let Some(box_id) = &target.box_id {
              // As a station's `disassemble` (facts/exception.rs): every live
              // item leaves at the one instant the box is taken apart, and the
              // code its scan owns is free (`registry::release`).
              let live: Vec<String> = sqlx::query_scalar(
                  "SELECT scan_id FROM box_items WHERE box_id = ? \
                   AND removed_at IS NULL AND displaced_at IS NULL",
              )
              .bind(box_id)
              .fetch_all(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
              for scan_id in &live {
                  sqlx::query("UPDATE box_items SET removed_at = ? WHERE scan_id = ?")
                      .bind(instant)
                      .bind(scan_id)
                      .execute(&mut *conn)
                      .await
                      .map_err(ApiError::internal)?;
                  crate::facts::registry::release(&mut *conn, scan_id).await?;
              }
              let shift_id: String = sqlx::query_scalar(
                  "UPDATE boxes SET disassembled_at = ? WHERE id = ? AND disassembled_at IS NULL \
                   RETURNING shift_id",
              )
              .bind(instant)
              .bind(box_id)
              .fetch_one(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
              sqlx::query(
                  "INSERT INTO code_releases (box_id, shift_id, document_id, code_count, \
                   released_at, rev) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .bind(box_id)
              .bind(&shift_id)
              .bind(document_id)
              .bind(i64::try_from(live.len()).map_err(ApiError::internal)?)
              .bind(instant)
              .bind(rev)
              .execute(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
              applied.boxes += 1;
              applied.codes += live.len();
          } else if let Some(pallet_id) = &target.pallet_id {
              // As a station's pallet `disassemble`: its boxes stay as they are.
              sqlx::query(
                  "UPDATE pallets SET disassembled_at = ? WHERE id = ? AND disassembled_at IS NULL",
              )
              .bind(instant)
              .bind(pallet_id)
              .execute(&mut *conn)
              .await
              .map_err(ApiError::internal)?;
              applied.pallets += 1;
          }
      }
      Ok(applied)
  }
  ```

  `fetch_one` после `UPDATE … AND disassembled_at IS NULL` падает, если короб уже расформирован.
  Под замком после повторной проверки так быть не может; если всё же случилось — это ошибка
  `internal`, и транзакция откатывается целиком.

  Обработчик:

  ```rust
  pub async fn apply_document(
      State(state): State<AppState>,
      context: OfficeContext,
      ApiPath(id): ApiPath<String>,
      ApiJson(transition): ApiJson<DisaggregationTransition>,
  ) -> Result<Json<DisaggregationDetail>, ApiError> {
      context.require_disaggregation()?;
      // The facts' lock (`routes/facts.rs`): no station batch runs between
      // the checks below and the writes.
      let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
      context.require_disaggregation_in(&mut tx).await?;
      let now = state.now();
      let at = format_timestamp(now);
      let doc = draft(&mut tx, &id).await?;
      if doc.rev != transition.expected_rev {
          return Err(ApiError::stale_revision(doc.rev));
      }
      if doc.reason_id.is_none() {
          return Err(ApiError::conflict(constraints::REASON_REQUIRED, "the document has no reason"));
      }
      let lines: Vec<(String, Option<String>)> = sqlx::query_as(
          "SELECT id, sscc FROM disaggregation_document_lines WHERE document_id = ? ORDER BY position",
      )
      .bind(&id)
      .fetch_all(&mut *tx)
      .await
      .map_err(ApiError::internal)?;
      if lines.is_empty() {
          return Err(ApiError::conflict(constraints::NO_LINES, "the document has no lines"));
      }
      // Every line again, from the live tables; a line without an SSCC (not
      // read, or a repeat) keeps its status and is never `ok`.
      let mut targets = Vec::with_capacity(lines.len());
      let mut invalid = 0usize;
      for (line_id, sscc) in &lines {
          let Some(sscc) = sscc else {
              invalid += 1;
              continue;
          };
          let target = disaggregation::resolve(&mut tx, sscc).await?;
          revalidate_line(&mut tx, line_id, target.as_ref(), &at).await?;
          match target {
              Some(target) if target.status == LineStatus::Ok => targets.push(target),
              _ => invalid += 1,
          }
      }
      let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
      if invalid > 0 {
          // The fresh statuses stay; the document stays a draft (the cloud
          // commits them before answering `invalid_lines`).
          touch(&mut tx, &id, &at, rev).await?;
          audit::record(&mut tx, &at, Entry {
              actor: context.actor(),
              action: actions::DISAGGREGATION_APPLY,
              target_type: Some("disaggregation_document"),
              target_id: Some(&id),
              outcome: Outcome::Failed,
              details: json!({ "docNo": doc.doc_no, "invalidLines": invalid }),
          })
          .await
          .map_err(ApiError::internal)?;
          commit_with_revision(tx, &state.revisions, rev).await.map_err(ApiError::internal)?;
          return Err(ApiError::conflict(constraints::INVALID_LINES, "some lines of the document are not ok")
              .with_details(json!({ "constraint": constraints::INVALID_LINES, "invalidLines": invalid })));
      }
      let instant = rules::device_text(now);
      let applied = disaggregation::apply_targets(&mut tx, &id, &targets, &instant, rev).await?;
      sqlx::query(
          "UPDATE disaggregation_documents SET status = 'applied', applied_at = ?, applied_by = ?, \
           updated_at = ?, rev = ? WHERE id = ?",
      )
      .bind(&at)
      .bind(&context.user.id)
      .bind(&at)
      .bind(rev)
      .bind(&id)
      .execute(&mut *tx)
      .await
      .map_err(ApiError::internal)?;
      audit::record(&mut tx, &at, Entry {
          actor: context.actor(),
          action: actions::DISAGGREGATION_APPLY,
          target_type: Some("disaggregation_document"),
          target_id: Some(&id),
          outcome: Outcome::Ok,
          details: json!({ "docNo": doc.doc_no, "boxes": applied.boxes,
              "pallets": applied.pallets, "codes": applied.codes }),
      })
      .await
      .map_err(ApiError::internal)?;
      let detail = detail(&mut tx, &id).await?.ok_or_else(|| ApiError::internal("document vanished"))?;
      commit_with_revision(tx, &state.revisions, rev).await.map_err(ApiError::internal)?;
      Ok(Json(detail))
  }
  ```

  `with_details` заменяет детали целиком (`error.rs:29`), поэтому `constraint` повторяется в
  объекте. `revalidate_line` пишет `status`, `box_id`, `pallet_id`, `product_id`, `code_count`,
  `validated_at` (для `None` — `not_found`, без цели, `code_count = 0`). `touch` — `updated_at`
  и `rev` документа.

  `AGENTS.md` «Writes» требует писать до коммита и не ждать между коммитом и уведомлением — это
  соблюдено.

- [ ] **Шаг 3: стык с КНФ.** Если в `claude/integration` уже есть
      `GET /v1/office/shifts/{id}/exceptions` (КНФ; проверить
      `rtk proxy grep -n "exceptions" apps/standalone/host/src/server.rs`), добавить в его ответ
      строки проведённых документов. Вид — `disassemble`, источник — офис; номер документа,
      причина и исполнитель — через запрос объединения из задачи 9. Тест — в файле КНФ. Если
      КНФ ещё нет — ничего не делать, записать в «Отклонения»: объединение делает КНФ.
- [ ] **Шаг 4: зелёные тесты, полный `cargo … test -p markiro-host`, `cargo fmt --check`, коммит**
      `feat(standalone): host — applying a disaggregation document under the facts' lock`.

## Задача 6: хост — сущность ленты `code_releases`

**Files:** Modify `host/src/routes/changes.rs`, `host/tests/changes.rs`.

- [ ] **Шаг 1: красные тесты** (`host/tests/changes.rs`, помощники файла `changes`, `keys`; подготовка — как
      `day` задачи 4, вынесенный в `support`, или проведение прямо в тесте):
  - после проведения документа по двум коробам лента с `since` = ревизия до проведения отдаёт
    ровно два элемента `code_releases` с ревизией проведения. `id` — id короба, `data` —
    `{ shiftId, documentId, releasedAt, codeCount }` (`CodeReleaseRecord` через
    `serde_json::from_value`);
  - лента с нуля после второго проведения отдаёт оба освобождения, каждое со своей ревизией;
  - создание документа, добавление строк и проведение паллеты элементов `code_releases` не
    дают; ревизия при этом растёт, и это видно по `rev` ответа;
  - **большой документ**: 600 коробов одним проведением (вставить короба и единицы напрямую SQL
    в закрытую смену — быстрее, чем фактами; закрыть офисом). Страница с `limit=500` отдаёт все
    600 элементов: одна ревизия идёт целиком (`changes.rs:213-237`), размер ответа меньше
    `MAX_PAGE_BYTES`.

  Прогон `cargo … test -p markiro-host --test changes` — красный.

- [ ] **Шаг 2: реализация.** В `FEED_KEYS` перед надгробиями:

  ```rust
  UNION ALL SELECT 'code_releases', box_id, rev, 0 FROM code_releases WHERE rev > ?1 \
  ```

  В `record`:

  ```rust
  entities::CODE_RELEASES => {
      let (shift_id, document_id, released_at, code_count): (String, String, String, u32) =
          sqlx::query_as(
              "SELECT shift_id, document_id, released_at, code_count FROM code_releases \
               WHERE box_id = ?",
          )
          .bind(&key.id)
          .fetch_one(&mut *conn)
          .await
          .map_err(ApiError::internal)?;
      serde_json::to_value(markiro_proto::disaggregation::CodeReleaseRecord {
          shift_id,
          document_id,
          released_at,
          code_count,
      })
  }
  ```

  Обновить комментарий над `FEED_KEYS`: освобождение не удаляется и надгробия не имеет.
  `feed_machine.rs` не трогается: его «живые ключи» — только справочники, и документов он не
  создаёт.

- [ ] **Шаг 3: зелёные тесты, `cargo fmt --check`, коммит**
      `feat(standalone): host — the change feed carries code releases`.

## Задача 7: хост — восстановление из копии поднимает номера документов

**Files:** Modify `host/src/restore.rs`, `host/tests/restore.rs`.

- [ ] **Шаг 1: красный тест** (`host/tests/restore.rs`, помощники файла `copy`, `stop`, `reopen`,
      `restore(&paths, &copy_path, false, at(NOW))`):

  ```rust
  #[tokio::test]
  async fn a_restore_lifts_the_disaggregation_numbers_above_both_databases() {
      let admin = admin().await;
      for _ in 0..2 {
          let (status, body) = admin.call("POST", "/v1/office/disaggregation", Some(json!({}))).await;
          assert_eq!(status, StatusCode::OK, "{body}");
      }
      let (copy_path, _) = copy(&admin.app).await;
      // After the copy: three documents the copy never saw (one printed on an act, say).
      for _ in 0..3 {
          admin.call("POST", "/v1/office/disaggregation", Some(json!({}))).await;
      }
      let paths = stop(&admin.app).await;
      restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
      let pool = reopen(&paths).await;
      let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM disaggregation_doc_counters")
          .fetch_one(&pool)
          .await
          .unwrap();
      // The current database reached 5; ten above it.
      assert_eq!(seq, 5 + SHIFT_NUMBER_MARGIN);
  }
  ```

  Второй тест: текущая база не читается (как
  `an_unreadable_current_database_leaves_the_margins_over_the_copy`), счётчик равен
  `2 + SHIFT_NUMBER_MARGIN`. Третий: в обеих базах документов нет — счётчик остаётся `0`.
  Копия базы до `0024` (`old_copy`, `:707`) мигрирует вперёд, и таблицы счётчика в ней до
  миграций нет — `read_floors` это терпит (`tables.contains`).

- [ ] **Шаг 2: реализация.**
  - `Floors` получает `disaggregation_seq: Option<i64>`, `merge` берёт максимум.
  - `read_floors`: если есть таблица `disaggregation_doc_counters` — `last_seq`; если есть
    `disaggregation_documents` — `max(seq)`; берётся наибольшее.
  - `raise_in`, рядом с номерами смен (`:2256`):

    ```rust
    if let Some(floor) = copy_floors
        .disaggregation_seq
        .max(known.disaggregation_seq)
        .filter(|seq| *seq > 0)
    {
        sqlx::query("UPDATE disaggregation_doc_counters SET last_seq = ?1 WHERE id = 1")
            .bind(floor + SHIFT_NUMBER_MARGIN)
            .execute(&mut *tx)
            .await?;
    }
    ```

  Отчёт `RestoreReport` и строка аудита `host.restore` не меняются. Это решение плана: номер
  документа нигде не печатается так же массово, как номер смены. Если владелец захочет его в
  отчёте, это вопрос ДЗГ-4.

- [ ] **Шаг 3: зелёные тесты, полный `cargo … test -p markiro-host --test restore`,
      `cargo fmt --check`, коммит**
      `feat(standalone): a host restore lifts the disaggregation document numbers`.

## Задача 8: станция — применение `code_releases`

**Files:** Modify `src/local/reference-sync.ts`, `test/reference-sync.test.ts`,
`test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`; Create `test/code-releases.test.ts`.

**Interfaces (`src/local/reference-sync.ts`):**

```ts
/**
 * The feed entities this build acts on but keeps no copy of (plan ДЗГ):
 * `code_releases`, a box a document took apart, whose codes this station
 * stops counting as its own. Part of `ENTITY_SET`: a build that starts
 * acting on one syncs from zero once and meets every release it skipped.
 */
const ACTION_ENTITIES = ["code_releases"] as const;

export const ENTITY_SET = `${[...ENTITIES.keys(), ...ACTION_ENTITIES].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
 * Deletes this pairing's codes of the boxes a page's releases name, only
 * where this station's box of that id is closed and of the named shift
 * (plan ДЗГ, Р7): the host frees codes of closed shifts only (owner
 * decision ПР-1), and an open box here is never touched. The same delete
 * as the station's own disassembly (`box-exceptions.ts`), by box. The host
 * names a box once, and a closed box takes no codes, so a page applied
 * again, or the whole feed from zero after a restore, deletes nothing new.
 * Parameters: host id, device id, the releases (`[{ id, shiftId }]`), host
 * id, device id.
 */
export const APPLY_CODE_RELEASES_SQL =
  "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id IN " +
  "(SELECT b.id FROM json_each(?) AS r JOIN floor_boxes AS b ON b.id = r.value ->> 'id' " +
  "WHERE +b.host_id = ? AND +b.device_id = ? AND +b.shift_id = r.value ->> 'shiftId' " +
  "AND b.closed_at IS NOT NULL)";
```

В `pageStatements` после цикла по `ENTITIES`, до `QUARANTINE`:

```ts
const releaseKey = z.object({ id: z.uuid() });
// …
const releases: Array<{ id: string; shiftId: string }> = [];
for (const item of page.items) {
  if (item.entity !== "code_releases") continue;
  const key = { id: item.id, rev: item.rev };
  // The host never deletes a release; a tombstone would only settle.
  if (item.deleted) {
    settled.push({ entity: item.entity, ...key });
    continue;
  }
  const record = codeReleaseRecordSchema.safeParse(item.data);
  const id = releaseKey.safeParse({ id: item.id });
  if (!record.success) {
    quarantined.push({ entity: item.entity, ...key, reason: quarantineReason(record.error) });
    continue;
  }
  if (!id.success) {
    quarantined.push({ entity: item.entity, ...key, reason: "id: invalid_format" });
    continue;
  }
  releases.push({ id: item.id, shiftId: record.data.shiftId });
  settled.push({ entity: item.entity, ...key });
}
if (releases.length > 0) {
  statements.push({
    sql: APPLY_CODE_RELEASES_SQL,
    values: [
      pairing.hostId,
      pairing.deviceId,
      JSON.stringify(releases),
      pairing.hostId,
      pairing.deviceId,
    ],
  });
}
```

Освобождение с неверными данными уходит в карантин. Это fail-closed: код остаётся локальным дублем,
как сегодня, а счётчик карантина виден в строке состояния. Комментарий к `pageStatements`
обновить. В худшем случае пакет занимает 3E + 7 = 31 оператор из 32 (страж, отложенная очистка,
по два на справочник, освобождения, карантин, снятие карантина, состояние).

- [ ] **Шаг 1: красные тесты.** `test/code-releases.test.ts`:

  ```ts
  import type { DatabaseSync } from "node:sqlite";

  import { canonicalizeKm, kmHash } from "@markiro/domain";
  import { describe, expect, it, vi } from "vitest";

  import { processScan } from "../src/floor/work/scan-pipeline.js";
  import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
  import type { LocalExecutor } from "../src/local/executor.js";
  import { syncReferences } from "../src/local/reference-sync.js";
  import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
  import {
    ENTERED,
    enteredShift,
    km,
    PAIRING,
    rows,
    scanContext,
    SECOND,
    SHIFT_ID,
  } from "./support/floor-work.js";
  import { openLocalDb } from "./support/local-db.js";

  const DOCUMENT_ID = "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c";

  function release(boxId: string, shiftId: string, rev = 44): ChangeItem {
    return {
      entity: "code_releases",
      id: boxId,
      rev,
      deleted: false,
      data: { shiftId, documentId: DOCUMENT_ID, releasedAt: "2026-10-13T09:05:00Z", codeCount: 1 },
    };
  }

  function page(rev: number, items: ChangeItem[]): ChangesResponse {
    return { hostId: HOST_ID, rev, hasMore: false, items };
  }

  async function sync(local: LocalExecutor, items: ChangeItem[], since = 0, rev = 44) {
    return syncReferences({
      changes: vi.fn(async (asked: number) => {
        if (asked !== since) throw new Error(`unexpected since=${asked}`);
        return page(rev, items);
      }),
      local,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      now: () => 1_790_000_000_000,
    });
  }

  /** Close the station's open box of the shift as a box close would, and the shift as the host did. */
  function closeBoxAndShift(db: DatabaseSync, boxId: string, serial: number) {
    db.prepare(
      "UPDATE floor_boxes SET closed_at = '2026-10-08T06:20:00.000Z', sscc = ?, block_id = ?, serial = ? WHERE id = ?",
    ).run(
      `0460068200000${serial}0`.slice(0, 18),
      "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
      serial,
      boxId,
    );
    db.prepare(
      "UPDATE floor_shifts SET status = 'closed', closed_at = '2026-10-08T07:00:00Z' WHERE id = ?",
    ).run(SHIFT_ID);
  }

  describe("code releases on the station (plan ДЗГ)", () => {
    it("a code freed by a document is accepted in a new shift on the same station", async () => {
      const { db, executor } = openLocalDb();
      const first = await enteredShift(executor, ENTERED);
      const raw = km("5Yq'Ct;");
      const accepted = await processScan(scanContext(executor, first), raw);
      if (accepted.kind !== "accepted") throw new Error(accepted.kind);
      closeBoxAndShift(db, accepted.boxId, 1500);

      const second = await enteredShift(executor, SECOND);
      // Before the release the station holds the code: a local duplicate.
      await expect(processScan(scanContext(executor, second), raw)).resolves.toMatchObject({
        kind: "duplicate",
        source: "local",
      });

      await expect(sync(executor, [release(accepted.boxId, SHIFT_ID)])).resolves.toMatchObject({
        kind: "synced",
        rev: 44,
        quarantined: 0,
      });
      expect(rows(db, "SELECT code_hash FROM floor_codes WHERE shift_id = ?", SHIFT_ID)).toEqual(
        [],
      );

      await expect(processScan(scanContext(executor, second), raw)).resolves.toMatchObject({
        kind: "accepted",
      });
      expect(
        rows(
          db,
          "SELECT shift_id FROM floor_codes WHERE code_hash = ?",
          kmHash(canonicalizeKm(raw)),
        ),
      ).toEqual([{ shift_id: SECOND.id }]);
    });
  });
  ```

  Вид SSCC в помощнике — любой из 18 цифр, уникальный в таблице (`floor_boxes_sscc`). Блок —
  любой текст: внешних ключей у оболочки нет. Хеш кода — как `codeHashOf` в
  `test/floor-scan-pipeline.test.ts`: `kmHash(canonicalizeKm(raw))`, префикс AIM снимает домен.

  Ещё случаи того же файла:

  - **открытый короб не трогается**: освобождение называет короб, который у станции ещё открыт →
    строки `floor_codes` на месте;
  - **короб другой смены**: освобождение с чужим `shiftId` → строки на месте;
  - **короб, которого у станции нет** → ничего не удалено, `quarantined: 0`;
  - **другая пара «хост — устройство»**: строки `floor_codes` той же коробки под `OTHER_HOST`,
    записанные напрямую, остаются;
  - **повтор страницы** (страница с той же ревизией ещё раз, `since = 44`, `rev = 44`) и **лента
    с нуля** (`FROM_ZERO_SQL`, затем страница с `since = 0`) ничего нового не удаляют и не
    падают;
  - **неверные данные** (`codeCount: -1`, `shiftId: "x"`, `id` не UUID) → `quarantined: 1`,
    строки на месте; следующая страница с исправленной записью той же `id` снимает карантин и
    удаляет строки;
  - **копия смены у станции всё ещё `active`** (офис закрыл смену без связи со станцией), а
    короб закрыт → строки удалены (Р7).

  `test/reference-sync.test.ts`:
  - `ENTITY_SET` (`:356-364`) — ожидаемый текст:
    `"org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults,code_releases;v4"`;
  - худшая страница (`:1712`): добавить элемент `code_releases` с закрытым коробом и запись с
    неверными данными. Ожидание `[2, 31]`, `quarantined: 9`; комментарий пересчитать
    («3 × 8 + 7 = 31, within the shell's 32»).

  `test/floor-schema.test.ts`, в список текстов, закреплённых в `tests/local_db.rs`: добавить
  `APPLY_CODE_RELEASES_SQL` и увеличить ожидаемый размер набора на один. План запроса проверить
  на `node:sqlite`:
  - `SEARCH floor_codes USING INDEX floor_codes_box (host_id=? AND device_id=? AND box_id=?)`;
  - поиск `floor_boxes` по первичному ключу;
  - без `SCAN floor_codes`.

  `src-tauri/tests/local_db.rs`, `the_floors_repeating_reads_search_an_index` (`:1956`): массив
  `reads` растёт со 100 до 101 элемента — побайтно тот же текст и индекс `floor_codes_box`. Если
  SQLite 3.46 выберет другой план, добавить подсказку `+` в обе копии текста и записать это в
  «Отклонения».

  Прогон (должен упасть):
  - `pnpm … exec vitest run test/code-releases.test.ts test/reference-sync.test.ts test/floor-schema.test.ts`;
  - `pnpm … --filter @markiro/standalone build`, затем
    `cargo … test -p markiro-standalone --test local_db`.

- [ ] **Шаг 2: реализация** по интерфейсам выше. Импорт
      `import { codeReleaseRecordSchema } from "../host/disaggregation.js";`. Обновить
      doc-комментарий `ENTITY_SET` (`:284-292`, «eight entities and `v4` today»).
- [ ] **Шаг 3: зелёные тесты, typecheck, lint, prettier, `cargo fmt --check`, коммит**
      `feat(standalone): station — code releases from the feed free a document's codes`.

## Задача 9: документы и итоговый гейт

**Files:** Modify `apps/standalone/AGENTS.md`,
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`.

- [ ] **Шаг 1: `AGENTS.md`.**
  - «Audit» — новые действия и их детали.
  - «Writes» — права `disaggregates`; проведение под `begin_write` вместе с фактами.
  - «Change feed»:
    - сущность `code_releases`, ключ — id короба, без надгробий, единица — короб (Р6);
    - освобождение — действие станции, а не копия: `ACTION_ENTITIES`, один оператор на
      страницу, худшая страница 31 из 32. Следующей сущности ленты нужен меньший пакет, иначе
      она не влезет.
  - «Facts» — офисное расформирование, момент в форме устройства, ответы поздних фактов (Р3).
  - Новый подраздел «Disaggregation documents»: статусы, пределы, номер, `invalid_lines`, роли и
    причины по умолчанию. Плюс запрос объединения для читателей истории короба:

    ```sql
    SELECT 'station' AS source, e.kind, e.box_id, e.occurred_at AS at, e.reason_code,
      e.reason_text, e.device_id, e.operator_id, NULL AS document_id, NULL AS office_user_id
    FROM box_exceptions e WHERE e.box_id = ?1
    UNION ALL
    SELECT 'office', 'disassemble', l.box_id, b.disassembled_at, NULL, r.name, NULL, NULL,
      d.id, d.applied_by
    FROM disaggregation_document_lines l
    JOIN disaggregation_documents d ON d.id = l.document_id AND d.status = 'applied'
    JOIN boxes b ON b.id = l.box_id
    LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id
    WHERE l.box_id = ?1 AND l.status = 'ok'
    ORDER BY at
    ```

    То же для паллет — через `pallet_exceptions` и `l.pallet_id`.

  - «Backups and restore» — подъём счётчика номеров, потеря проведённого после копии
    документа (Р17).
  - «Verification» — ручные проверки ДЗГ (ниже).
- [ ] **Шаг 2: спецификация.** В §5.1 отметка «Хост, протокол и станция — план ДЗГ (коммит
      …); единица ленты — короб (Р6 плана)».
- [ ] **Шаг 3: полный гейт** (раздел «Итоговая проверка плана»), `git diff --check`, коммит
      `docs(standalone): plan ДЗГ — disaggregation documents, code releases on stations`.

## Итоговая проверка плана

- `cargo fmt --manifest-path <wt>/apps/standalone/Cargo.toml --all -- --check`.
- `cargo --offline --locked --manifest-path <wt>/apps/standalone/Cargo.toml test --workspace` —
  частями, если целиком не укладывается: `-p markiro-proto`, `-p markiro-host`, затем
  `-p markiro-standalone` после `pnpm … --filter @markiro/standalone build`.
- `pnpm --dir <wt> --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`,
  `typecheck`, `lint`, `build`.
- `prettier --check` по всем изменённым файлам, `git diff --check`.
- Обзор полного диффа против `claude/integration`. Не тронуты: `apps/api`, `apps/admin`,
  `apps/station`, `packages/*`, применённые миграции, `Cargo.lock`, `pnpm-lock.yaml`.
- Отчёт отдельно перечисляет автоматические проверки и то, что не проверено вживую (раздел «Не
  проверено»).

## Проверки владельца

Офисных страниц в этом плане нет. Документ создаётся вызовами API из офисной сессии или — после
ДЗГ-О — со страницы. Проверки 1–5 удобнее делать после ДЗГ-О.

1. **Перепаковка на той же станции (Windows, реальный сканер).**
   - Станция собирает и закрывает короб, смена закрывается.
   - Офис проводит документ по этому коробу.
   - В новой смене на той же станции те же бутылки сканируются без «Дубль (локальный)». На хосте
     они не попадают в конфликты.
2. **Станция без связи.**
   - Отключить станцию от сети, провести документ, подключить снова.
   - Освобождение доходит со следующей синхронизацией, и перепаковка проходит.
   - Если, пока станция была без связи, офис закрыл её смену (копия смены у станции «в работе»),
     освобождение срабатывает всё равно.
3. **Выгрузка ЧЗ после проведения.** XML агрегации смены не содержит расформированного короба,
   его коды не числятся. Сверить с выгрузкой той же смены, где короб расформировала станция.
4. **Паллета.** Документ по паллете: паллета в карточке смены расформирована, короба живы, ярлык
   паллеты не предлагается, складская перепечатка паллеты отказывает.
5. **Большой документ.** Импорт около 2 000 SSCC (после ДЗГ-О) и проведение:
   - сколько длится проведение;
   - станции в это время шлют факты без ошибок (ждут замка до 5 с);
   - синхронизация станций после проведения укладывается в несколько секунд.
6. **Восстановление.**
   - Сделать копию, провести документ, восстановить копию.
   - Документа нет, и следующий номер больше последнего напечатанного.
   - Провести документ по акту заново: станции не ломаются, повторное освобождение ничего не
     портит.

## Открытые вопросы

- **ДЗГ-1 — причины по умолчанию.** Облако их не заводит. По умолчанию — «Не тот товар»,
  «Неверное количество», «Повреждена упаковка», «Брак по качеству» (как у станции) и «Другое».
  Владелец может заменить список до слияния: меняется только `INSERT` миграции `0024` и тест.
- **ДЗГ-2 — отставшая копия смены на станции.** По умолчанию станция освобождает коды
  закрытого короба, не глядя на свою копию смены (Р7). Если владелец хочет буквально «только
  когда смена закрыта и на станции», нужна таблица отложенных освобождений (оболочка `0017`,
  удержание, закреплённые планы) — это отдельная задача.
- **ДЗГ-3 — проведение в несколько ревизий.** По умолчанию одна ревизия: элементов ленты
  столько, сколько коробов, до 10 000 (около 2 МБ). Если проверка владельца 5 покажет, что
  синхронизация станции не укладывается в 10 с, придётся делить освобождения по ревизиям
  (отступление от «одна ревизия на транзакцию»).
- **ДЗГ-4 — номер документа в отчёте восстановления.** По умолчанию счётчик поднимается молча, в
  отчёт `markiro-host restore` он не выводится.

## Риски

- **Длинная транзакция проведения.** Документ на 10 000 коробов держит замок записи, пока
  обновляются сотни тысяч строк, а пакет фактов ждёт до 5 с (`busy_timeout`) и потом получает
  ошибку. Станция повторяет его позже, и потерь нет: исходящая очередь станции переживает
  повтор. Мера — проверка владельца 5; при необходимости — предел документа ниже облачного
  (по умолчанию не меняется).
- **Поздние факты расформированного короба.** Исключения и проверки этикетки получают
  `box_state`, станция видит их на экране очереди (план ОЧ). Позднее `box_closed`, называющее
  уже расформированную офисом паллету, принимается: состояние паллеты короб не отказывает
  (`box_closed.rs:1-9`), как и после станционного расформирования. Это поведение этапа 2a,
  оно не меняется.
- **Восстановление после проведения** — Р17, проверка владельца 6.
- **Стыки с другими планами** — общие файлы `proto/src/lib.rs` (`entities`), `server.rs`,
  `routes/mod.rs`, `lib.rs`, `audit.rs`, `auth.rs`, `routes/changes.rs`, `reference-sync.ts`,
  `test/support/office.tsx`, `test/api.test.ts`, `AGENTS.md`. Конфликты при слиянии здесь текстовые.

  Логический стык один: бюджет пакета страницы. Если КНФ добавит на станцию сущность «разобранные
  конфликты» как копию (+3 оператора), страница выйдет за 32. КНФ должен встать на тот же путь
  `ACTION_ENTITIES` (+1) или сначала уменьшить пакет.

- **Восстановление (`restore.rs`)** правят и другие планы (И1, ОБН-1): правка ДЗГ — одно поле в
  `Floors` и один `UPDATE`, конфликт текстовый.

## Не проверено

- Сканер и станция на Windows, перепаковка вживую, большой документ на реальном объёме, приём
  XML в ЛК ЧЗ (ДЗГ-О).
- План запроса освобождения на SQLite 3.46 оболочки проверяется только тестом крейта оболочки,
  который требует собранного `dist`.
- Поведение офиса — после ДЗГ-О.

## Отклонения при исполнении

_(заполняет исполнитель)_
