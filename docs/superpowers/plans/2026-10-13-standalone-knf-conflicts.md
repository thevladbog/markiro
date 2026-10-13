# План КНФ: конфликты и разбор смены в автономе — страница «Конфликты» с «Отметить разобранным», в карточке смены разделы «Исключения», «Отклонённые записи станции», «Конфликты», предупреждение в выгрузке, станция узнаёт о разборе и о вытеснении (хост, протокол, офис, станция) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост с этапа 2a пишет таблицу `code_conflicts` в обе стороны: поздний скан и вытеснение
(`host/src/facts/registry.rs`). Её никто не читает, и `reviewed_at` никто не ставит. Исключения
коробов и паллет и отказы станции (`fact_receipts.outcome = 'rejected'`) в офисе тоже не видны,
хотя §7 спецификации пилота их обещал. Офис не может увидеть, что код ушёл в два короба. Для ЧЗ это
прямой риск: XML агрегации описывает короб не так, как он собран физически. После плана:

- в разделе «Производство» есть страница «Конфликты»:
  - фильтры «Смена» и «Состояние»;
  - код показан как GTIN и серийный номер, полный код с криптохвостом не показывается;
  - у победителя и проигравшего видны смена, станция, оператор, время скана и короб;
  - есть переход к коробу проигравшего и действие «Отметить разобранным» с аудитом;
- в карточке смены три новых раздела: «Исключения», «Отклонённые записи станции» и «Конфликты»;
- диалог выгрузки предупреждает о неразобранных конфликтах смены, но выгрузку не запрещает (ПР-12);
- станция узнаёт, что офис разобрал её конфликт, и экран очереди перестаёт его считать;
- станция, чей ранний скан вытеснили, узнаёт об этом и видит вытеснение на экране очереди.

Последние две станционные задачи (7 и 8) **могут быть отрезаны** без ущерба для задач 1–6.

**Architecture:**

- **Хост:**
  - миграция `0022_conflict_review.sql` только добавляет столбцы и индексы, таблицы не
    перестраивает:
    - `code_conflicts.kind` (`late` | `displaced`); старые строки получают вид по квитанции
      проигравшего;
    - `code_conflicts.reviewed_by` (ссылка на `office_users`);
    - индексы `code_conflicts_loser`, `code_conflicts_detected`, частичный
      `fact_receipts_rejected`, `box_exceptions_shift`, `pallet_exceptions_shift`;
  - `registry::claim` пишет вид конфликта;
  - маршруты `GET /v1/office/conflicts` и `POST /v1/office/conflicts/{id}/review` в
    `routes/office_conflicts.rs`;
  - маршруты `GET /v1/office/shifts/{id}/exceptions` и `…/rejections` в
    `routes/office_shift_review.rs`;
  - разбор берёт ревизию хоста (так просыпаются потоки станций) и пишет строку аудита
    `conflict.review`;
  - станционная часть: маршруты `POST /v1/device/conflicts/status` (облачный
    `/station/conflicts/status`) и `GET /v1/device/displacements`.
- **Протокол:**
  - модуль `proto/src/review.rs` и его Zod-зеркало `src/host/review.ts`;
  - фикстуры `proto/fixtures/office-conflict-page.json`, `office-shift-exceptions.json`,
    `office-shift-rejections.json`, `conflict-status-request.json`,
    `conflict-status-response.json`, `device-displacements.json`;
  - `PROTOCOL_VERSION` не растёт (Р9).
- **Офис:**
  - `src/office/conflicts/ConflictsPage.tsx` и `conflict-list.ts`;
  - `src/office/shifts/ShiftReview.tsx` — три раздела карточки смены;
  - предупреждение `unreviewed_conflicts` в `export-checks.ts`;
  - пункт меню, маршрут и возможность `reviewConflicts`.
- **Станция (может быть отрезано):**
  - миграция оболочки `0016_conflict_notices.sql` добавляет `outbox.office_reviewed_at` и таблицу
    `floor_displacements` (`DeviceData`, без срока хранения);
  - модуль `src/local/conflict-notices.ts`;
  - отдельный планировщик в `src/app/host-link.ts`, запускается вместе с прочими чтениями;
  - раздел «Вытесненные коды» на экране очереди;
  - счёт вытеснений в строке состояния.

**Tech Stack:** Rust (axum, sqlx 0.8.6, serde) — `host`, `proto`, `src-tauri`; React 19.2,
TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, i18next,
`@tanstack/react-query`, `react-router` 8.3, `@markiro/ui` (`PageHeader`, `FilterBar`, `Select
native`, `Table`, `StatusChip`, `Button`, `Card`, `Alert`), Vitest 4 с jsdom и `node:sqlite` за
`LocalExecutor`.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md` — §3.1 строки П-07 и П-21,
  §3.5 строка П-51, §5.2 «КНФ», §7 ПР-12, §8.1 (номера миграций).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §7 «Карточка смены»
  (разбор смены обещан).
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — решение 14
  (самый ранний скан владеет кодом).
- Облако, образец:
  - `apps/api/src/modules/conflicts/{conflicts.controller.ts,conflicts.service.ts,dto.ts}`;
  - `apps/admin/src/pages/conflicts/index.tsx`;
  - `apps/admin/src/i18n/ru.json` → `pages.conflicts.*`;
  - `apps/api/src/modules/station-scans/station-scans.controller.ts` (`conflicts/status`)
    и `station-scans.service.ts:255` (`reviewedConflictHashes`);
  - `apps/station/src/lib/sync.ts:435` (`reconcileReviewedConflicts`).
- `apps/standalone/AGENTS.md`: «Audit», «Databases», «Local database», «Facts», «Outbox recovery»,
  «Shift exports», «Shift card and printed forms», «Office pages», «Verification».

## Что есть сегодня (проверено по коду ветки `claude/integration`, `578906ef2`)

**Таблицы хоста (`host/migrations/0010_facts.sql`):**

- `code_conflicts` (`:124-133`): `id`, `code_hash`, `winner_scan_id`, `loser_scan_id`,
  `detected_at`, `reviewed_at`; есть только индекс `code_conflicts_code (code_hash)`.
- `fact_receipts` (`:15-28`): у `shift_id` нет внешнего ключа, `outcome IN ('accepted',
'conflict', 'rejected')`, индекс `fact_receipts_shift (shift_id, received_at)`.
- `box_exceptions` (`:137-160`): индексы только по записи и по `box_id`.
- `pallet_exceptions` (`0012_pallets.sql:50-65`): индексы только по записи и по `pallet_id`.

**Запись конфликтов (`host/src/facts/registry.rs`):**

- `:110-127` — поздний скан: в `conflict_row` победитель — владелец, проигравший — пришедший
  скан, квитанция `conflict` с `details.winner`.
- `:128-161` — вытеснение: у строки `box_items` владельца ставится `displaced_at`, в
  `conflict_row` победитель — пришедший ранний скан, проигравший — прежний владелец (его квитанция
  была `accepted`).
- `conflict_row` (`:80-100`) вида конфликта не пишет. Тест — `host/tests/facts.rs:996`
  (`the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`).
- Проигравший скан агрегации всегда лежит в `scans` с `verdict = 'ok'` и своим `box_id`
  (`facts/scan.rs:108-131`). После РЕЖ у скана смены проверки `box_id = NULL`.

**Квитанции (`host/src/facts/mod.rs`):**

- `:207-233` — `fact_receipts.shift_id` заполняется, только если смена найдена и станция в неё
  входила.
- Отказы `unknown_shift`, `not_entered` и нечитаемые записи хранятся без смены
  (`Applying::refused`, `:274-282`).

**Офисные маршруты:**

- Стиль чтения — `host/src/routes/office_boxes.rs`: `OfficeContext`, одна читающая транзакция,
  `require_shift` → `not_found`.
- Стиль записи — `host/src/routes/office_shifts.rs:239-320`:
  - `context.require_shift_planning()` → `begin_write` → `…_in(&mut tx)` → `next_revision`;
  - затем `audit::record` и `commit_with_revision(tx, &state.revisions, rev)`.
- Постраничный поиск — `office_codes.rs` в `claude/fb-codesearch`: `page` текстом,
  `CODE_PAGE_SIZE = 50`.
- Роли (`host/src/auth.rs:170-296`): `OfficeRole` — только `Admin` и `Technologist`.
  `plans_shifts`/`edits_catalog` написаны без подстановочного плеча.
- Аудит (`host/src/audit.rs`): `actions::*`, `Entry { actor, action, target_type, target_id,
outcome, details }`. В `details` никогда нет хешей.

**Лента изменений:**

- `host/src/routes/changes.rs:51-61` — справочники для всех устройств, без адресата (`FEED_KEYS`)
  и надгробия (`host/src/feed.rs`).
- Записи одной станции в ленту не входят.
- Офисная запись без записи ленты всё равно берёт ревизию, чтобы потоки проснулись (комментарий
  `office_shifts.rs:1-7`).

**Станция:**

- Очередь: конфликт — строка `outbox` с `outcome = 'conflict'`.
  - Разбор на станции (`dismissRecord`, `src/floor/queue/outbox-recovery.ts:342-364`) пишет
    `resolution = 'dismissed'`, `resolved_at`, `resolved_by`.
  - Схема — `src-tauri/migrations/0013_outbox_recovery.sql`; «no check ties them»,
    `AGENTS.md` «Local database».
  - Счёт в строке состояния — `CONFLICT_COUNT_SQL` (`src/floor/outbox-status.ts:35-37`).
- Чтения хоста в `src/app/host-link.ts:275-520`: отдельные планировщики `createSyncScheduler`
  (`refresher`, `shiftReader`, `factSender`, `reconciler`) со своими счётчиками неудач. Все
  запускает `everything()` (`:522-528`) при подключении и при каждой ревизии.
- О вытеснении станция не знает ничего: её квитанция была `accepted`.

**Офис:**

- Разделы карточки смены — `src/office/shifts/ShiftCardPage.tsx:288-291` («Короба» с фильтром по
  окончанию SSCC, «Паллеты»).
- Предупреждения выгрузки — `src/office/exports/export-checks.ts:53-67` (`ExportWarning`) и
  `ExportDialog.tsx:126-134`.
- Меню — `src/office/nav.ts`, маршруты — `src/office/routes.tsx`, возможности —
  `src/office/access.ts`.
- Тексты отказа станции — `floor.queue.code.*`, видов записи — `floor.queue.kind.*`, причин
  исключений — `floor.exceptions.reasons.{reprint,disassemble}.*` (`src/i18n/ru.json`).

## Решения владельца

- **ПР-12 (2026-10-13):** «Неразобранный конфликт смены запрещает выгрузку или только
  предупреждает?» — **только предупреждение**.
- **Спецификация §5.2:** перенос — «Отмечено разобранным» с аудитом, `reviewed_by`, разделы
  карточки смены, страница в «Производстве», станционная часть последними задачами («остаток
  этапа 2b, размер S»).
- **Задача контроллера:** полный код с криптохвостом не показывается, только хеш и
  GTIN/серийный. Ссылка к коробу проигравшего до слияния КРТ ведёт в раздел коробов карточки
  смены. Станционные задачи помечены как отрезаемые.

## Допущения

Планировщик принимает решения сам; вопросы владельцу — в конце.

- **Р1 — фильтр «Смена» — смена проигравшего скана, как в облаке.**
  - Облако сопоставляет только проигравшую смену (`conflicts.service.ts:26-34`), и подсказка
    фильтра говорит об этом прямо.
  - Победившей смене разбирать нечего: её короб на хосте совпадает с физическим.
  - Раздел «Конфликты» карточки смены, предупреждение выгрузки и ссылка «Все конфликты смены»
    используют тот же фильтр.
- **Р2 — вид конфликта хранится столбцом.**
  - `code_conflicts.kind TEXT NOT NULL DEFAULT 'late' CHECK (kind IN ('late','displaced'))`,
    `registry::claim` пишет его в обеих ветках.
  - Старые строки получают вид в миграции по квитанции проигравшего: `accepted` значит
    вытеснение, `conflict` — поздний скан. Квитанции хранятся навсегда.
  - Почему не вычислять при чтении: проверить «вытеснен ли» по `box_items.displaced_at`
    нельзя — у скана смены проверки (РЕЖ) строки `box_items` нет. Связывать смысл конфликта с
    исходом квитанции в каждом запросе хрупко.
  - Офис показывает вид словами («Вытеснение» / «Поздний скан»), станционный список вытеснений
    фильтрует по нему.
- **Р3 — «Отметить разобранным».**
  - Разрешено обеим ролям: новая `auth::reviews_conflicts(role)` без подстановочного плеча, как
    `plans_shifts`. Отдельная функция нужна, чтобы будущие роли просмотра (РОЛ, ПР-10) не
    получили разбор молча.
  - Отказать по роли сегодня некому, поэтому тест проверяет, что технолог может, а запрос без
    сессии и запрос только с ключом устройства — `401`.
  - Действие идемпотентно: повтор по разобранному конфликту отвечает той же строкой, без новой
    ревизии и аудита. Первый отметивший остаётся `reviewed_by`. Облако перезаписывает
    `reviewedAt` — это сознательное отличие: аудит не должен множиться.
  - Разбор берёт ревизию хоста: потоки станций просыпаются и спрашивают статус (Р9).
  - Аудит `conflict.review`, цель `code_conflict`/`{id}`, `details = { kind, loserShiftId,
loserDeviceId, winnerShiftId }` — без хеша кода (правило «Audit»).
  - Подтверждения нет, как в облаке: одно нажатие, после него фокус на объявлении.
- **Р4 — полный код не уходит с хоста в эти ответы.**
  - Строка конфликта несёт `codeHash` (ключ), `gtin14` и `serial` проигравшего скана.
  - Облако показывает `rawKm` с криптохвостом: здесь это сознательное отличие по правилу
    автонома и задаче.
  - Тест хоста проверяет, что в ответе нет текста криптохвоста фикстуры (`93Tail`).
- **Р5 — исключения и отказы смены.**
  - Каждый ответ — до `SHIFT_REVIEW_LIMIT = 500` строк, новые первыми, плюс `total`. Офис
    листает их по 50 и пишет «Показаны последние 500 из N».
  - Отказы без смены (`unknown_shift`, `not_entered`, нечитаемые записи) хост к смене не
    привязал: в карточку они не попадают, это сказано в подсказке раздела.
  - Отказ, который станция потом отправила заново под новым номером, остаётся в списке: хост не
    связывает старый номер с новым. Это тоже сказано в подсказке.
  - Серийный номер у исключения «Отмена последнего скана» берётся из журнала сканов (`scans` по
    коробу, хешу и `target_scanned_at`). У остальных видов кода нет.
- **Р6 — индексы `0022`.** Все на таблицах, которые РЕЖ не перестраивает: на `scans` и
  `code_owners` новых индексов нет.
  - `code_conflicts_loser (loser_scan_id)` — запрос станции по своим записям и фильтр офиса по
    смене проигравшего, оба через скан проигравшего.
  - `code_conflicts_detected (detected_at, id)` — список офиса (новые первыми) и курсор
    вытеснений станции. Конфликтов немного, но страница не должна сортировать всю таблицу.
  - `fact_receipts_rejected (shift_id, received_at) WHERE outcome = 'rejected'`. На смену
    приходится по квитанции на каждый скан (100 000+), а отказов единицы, после восстановления
    — тысячи. Существующий `fact_receipts_shift` прошёл бы все квитанции смены.
  - `box_exceptions_shift (shift_id, occurred_at)` и `pallet_exceptions_shift (shift_id,
occurred_at)`. «Отмена последнего скана» частая, таблица растёт годами, а карточку смены
    открывают постоянно.
- **Р7 — переход к коробу проигравшего до слияния КРТ.**
  - Ссылка ведёт на `/shifts/{shiftId}?box={sscc}`. Раздел «Короба» карточки смены читает
    параметр `box` и подставляет его в фильтр «Последние цифры SSCC».
  - У открытого короба без SSCC и у скана без короба (смена проверки, РЕЖ) — просто карточка
    смены.
  - После слияния КРТ ссылка меняется на карточку короба (`/boxes/{id}` — путь назовёт КРТ). Это
    одна строка в `conflict-list.ts::loserBoxLink`, она записана в «Риски».
  - «Создать документ дезагрегации из конфликта» (спецификация §5.2) в КНФ не входит: это ДЗГ-О,
    он идёт после ДЗГ.
- **Р8 — предупреждение выгрузки.**
  - Диалог читает `listConflicts({ shiftId, reviewed: false, page: 1 })` и берёт `total`.
    Предупреждение `unreviewed_conflicts` показывается у любого формата смены.
  - Не загрузилось — предупреждения нет, как у `palletList` (`ExportDialog.tsx:85-92`: справка,
    а не условие).
  - Кнопка формирования остаётся доступной (ПР-12), это закреплено тестом.
  - У документа одной паллеты предупреждения нет: конфликт относится к смене, а список паллет
    показывает только свои предупреждения.
- **Р9 — механизм станции: запрос по требованию, не лента.**
  - Лента — общие справочники для всех устройств, у неё нет адресата. Конфликт — данные одной
    станции, и надгробия ему не нужны.
  - Повторяем облако: станция спрашивает `POST /v1/device/conflicts/status { recordIds }` — по
    номерам своих записей, у которых конфликт или вытеснение не разобраны. Хост отвечает
    разобранными (`reviewedAt`).
  - Вытеснение станция узнаёт из `GET /v1/device/displacements?afterAt=&afterId=` — список
    вытеснений своих сканов по курсору `(detected_at, id)`.
  - Оба чтения идут в новом планировщике `noticeReader` и запускаются в `everything()`: при
    подключении и при каждой ревизии.
  - Разбор в офисе берёт ревизию, поэтому станция на связи узнаёт о нём за секунды.
  - Вытеснение ревизии не берёт: приём фактов (`facts/mod.rs`) план не трогает. Станция узнаёт о
    нём при следующем событии ревизии (любая офисная правка, открытие или закрытие смены) или
    при восстановлении связи. Задержка записана в «Открытых вопросах».
  - Протокол: новый маршрут — не новый вид факта и не новое поле `data`, так что
    `PROTOCOL_VERSION` не растёт (правило `proto/src/lib.rs:16-19`). Резерв 6 не используется.
  - Новая станция на старом хосте получает `404 not_found`. Это значит «хост ещё не умеет»: без
    счёта неудач и без повтора до следующего события.
- **Р10 — что станция делает с узнанным.**
  - Офис разобрал конфликт → строка `outbox` получает `resolution = 'dismissed'`, `resolved_at
= now`, `resolved_by = NULL` и `office_reviewed_at` (время разбора на хосте). Её больше не
    считают строка состояния, экран очереди и срок хранения.
  - `resolved_by = NULL` означает «не оператор этой станции»; три идентичности не смешиваются.
  - Вытеснение → строка `floor_displacements`. Экран очереди показывает её в разделе
    «Вытесненные коды» с «Разобрано», строка состояния её считает.
  - Вытеснение, уже разобранное офисом к моменту чтения, записывается сразу разобранным.
  - `floor_codes`, `floor_scans.conflict` и `floor_boxes.needs_fix` не меняются. Станция и
    сегодня при своём «Разобрано» их не трогает; исправление открытого короба — открытый вопрос.
  - «Разобрано» на станции до офиса не доходит, как в облаке.
- **Р11 — тексты.**
  - Слова станции «Разобрано» / «Конфликт отмечен разобранным.» переносятся в офис («Отметить
    разобранным», «Разобран»). В облаке — «Отметить рассмотренным» / «Рассмотрено». Одно слово
    на станции и в офисе важнее дословного облака; это открытый вопрос.
  - Подсказка фильтра смены — по смыслу облачной `pages.conflicts.filters.shiftHint`.
- **Р12 — номера (распределение 2026-10-13):** хост `0022`, оболочка `0016`. Перед задачами 2 и 8
  исполнитель заново смотрит `ls apps/standalone/{host,src-tauri}/migrations` в
  `claude/integration` и в ветках `claude/fb-*`. Если номер занят — берёт следующий свободный и
  пишет это в «Отклонения».

## Global Constraints

**Правила продукта**

- Офлайн-первым: станция работает без хоста. Чтения задачи 8 не блокируют ни скан, ни экран;
  неудача чтения — повтор по `nextSyncRetryMs` при связи.
- Полный код маркировки (с `\u001d` и криптохвостом) не попадает в новые ответы, журналы
  (`tracing`, `console.*`), URL и строки аудита. Для показа — GTIN и серийный, для ключа —
  `codeHash`.
- Три идентичности не смешиваются: разбирает офисный пользователь (`reviewed_by`), на станции —
  оператор (`resolved_by`), записи делает устройство.
- Каждое изменение данных офиса пишет аудит с точными исполнителем, действием, целью,
  результатом и `details`. Повтор без изменения строку не пишет.
- Выгрузку не запрещает ничто из этого плана (ПР-12).
- Применённые миграции не меняются.

**Распределение миграций и протокола (дословно из брифа)**

- Host migrations already claimed by open branches: `0017` employees (fb-people), `0018`
  pallet-sheet defaults (fb-templates), `0019` code search (fb-codesearch), `0020`–`0021` shift
  modes (РЕЖ). Shell migrations: `0014`–`0015` (РЕЖ). Applied in the base: host `0001`–`0012`,
  `0015`, `0016`; shell `0001`–`0010`, `0012`, `0013`.
- Wave-1 parity allocation: КНФ host `0022`, shell `0016`; ТОВ host `0023`; ДЗГ host `0024`, shell
  `0017`; ДЗГ-О none; КРТ host `0025`; ИСТ host `0026`. A number a plan does not use stays a gap.
  Before the migration task the executor re-checks `ls apps/standalone/{host,src-tauri}/migrations`
  in `claude/integration` and the open `claude/fb-*` branches; if taken — next free number, written
  into «Отклонения».
- Indexes on `scans` / `code_owners` only in migrations after `0020` (РЕЖ part A rebuilds both tables
  and recreates only its own and code search's indexes). Queries must work with
  `code_owners.box_id` NULL (validation shifts).
- Device protocol: base `PROTOCOL_VERSION = 3`; РЕЖ takes 4 and 5. Reserved if a plan needs a bump
  (per the rule in `proto/src/lib.rs:16-19`: a new fact kind or a new field in a fact's `data`;
  answers tolerate unknown fields): КНФ 6, ТОВ 7, ДЗГ 8, ИСТ 9. Do not bump unless the rule requires
  it; at merge the constant takes the highest number.

КНФ берёт хост `0022` и оболочку `0016` (только задача 8). Протокол не растёт (Р9).

**Код и процесс**

- TypeScript strict: без `any`, приведений типов и `!`; именованные экспорты, `import type`.
- Офис — только компоненты `@markiro/ui`, с мышью и клавиатурой, видимым фокусом и состоянием
  словами, а не только цветом. Цех — кнопки `size="floor"` (64 px).
- Тексты — только `src/i18n/ru.json`, ключи уникальны. Переменные текстов именованные; `count`
  — только там, где соседние ключи уже так пишут (`office.exports.warnings.*`).
- Формы на проводе — фикстуры `proto/fixtures`. Их читает Rust (`proto/tests/review.rs`) и Vitest
  (`test/review-protocol.test.ts`).
- Каждый новый SQL станции на растущей таблице (`outbox`, `floor_displacements`) закреплён планом
  запроса в `test/floor-schema.test.ts` **и** `src-tauri/tests/local_db.rs`; тексты совпадают
  побайтово.
- Rust: `cargo fmt` чистый, без предупреждений.
- Без изменений остаются: `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`,
  `apps/station`, `apps/api`, `apps/admin`, `packages/*`. Облако — только образец.
- TDD: сначала красный тест, потом код.
- `git stash` не использовать. Коммиты — явными путями, трейлер одной строкой
  `Co-Authored-By: …`. Push и PR — не в этом плане.

## Заметки для исполнения

- Worktree от `claude/integration` (`578906ef2` или новее): `WT=/tmp/claude/wt/knf`.
- Зависимости — клоны APFS из `/tmp/claude/wt/integ`:

  ```bash
  for p in node_modules apps/standalone/node_modules; do cp -c -R -P /tmp/claude/wt/integ/$p $WT/$p; done
  for d in /tmp/claude/wt/integ/packages/*/; do n=$(basename $d); for p in node_modules dist; do [ -e $d$p ] && cp -c -R -P $d$p $WT/packages/$n/$p; done; done
  cp -c -R -P /tmp/claude/wt/integ/apps/standalone/target $WT/apps/standalone/target
  ```

- Vitest: `pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec
vitest run <files>`.
- Полные проверки: `… --filter @markiro/standalone test`, `… typecheck`, `… lint`.
- Cargo: `cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p
markiro-host --test <name>`. Крейты: `markiro-proto`, `markiro-host`, `markiro-standalone`.
- Перед `cargo test -p markiro-standalone` соберите вебвью: `pnpm --dir $WT
--config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (`tauri::generate_context!`
  читает `dist`).
- Тесты хоста на `TestApp` сокета не открывают. Интеграционные тесты с loopback требуют
  отключённой песочницы.
- `pnpm install` и `pnpm add` не запускать.
- Если обёртка `rtk` урезала вывод — `rtk proxy <команда>`.
- React-тесты экранов (задачи 5, 6, 8):
  - один раз с `--reporter=verbose`, без `stderr |`;
  - один раз под стендом с задержкой `setImmediate` на 3 мс (временные
    `test/delayed-immediate.setup.ts` и `vitest.delay.config.ts`, как в плане СКЛ). Удалить
    после прогона.
- Prettier: `$WT/node_modules/.bin/prettier --check <файлы>`; в конце — `git -C $WT diff --check`.

## Файлы

- **Создать:**
  - хост: `apps/standalone/host/migrations/0022_conflict_review.sql`,
    `host/src/routes/office_conflicts.rs`, `host/src/routes/office_shift_review.rs`,
    `host/tests/office_conflicts.rs`, `host/tests/office_shift_review.rs`;
  - протокол: `proto/src/review.rs`, `proto/tests/review.rs`, фикстуры
    `proto/fixtures/{office-conflict-page,office-shift-exceptions,office-shift-rejections}.json`;
  - офис: `src/host/review.ts`, `src/office/conflicts/{ConflictsPage.tsx,conflict-list.ts}`,
    `src/office/shifts/ShiftReview.tsx`;
  - тесты: `test/{review-protocol,conflict-list,conflicts-page,shift-review}.test.ts(x)`.
- **Изменить:**
  - хост: `host/src/facts/registry.rs`, `host/src/routes/mod.rs`, `host/src/server.rs`,
    `host/src/auth.rs`, `host/src/audit.rs`, `host/tests/facts.rs` (одна проверка вида);
  - протокол: `proto/src/lib.rs` (`pub mod review;`);
  - офис: `src/host/api.ts`, `src/office/{nav.ts,routes.tsx,access.ts,office-query.ts}`,
    `src/office/shifts/ShiftCardPage.tsx`,
    `src/office/exports/{export-checks.ts,ExportDialog.tsx}`, `src/i18n/ru.json`;
  - тесты: `test/support/office.tsx` (`fakeHostApi`),
    `test/{shift-card,export-checks-warnings,export-dialog}.test.ts(x)`;
  - документы: `apps/standalone/AGENTS.md`, примечание в спецификации паритета.
- **Задачи 7–8 (могут быть отрезаны):**
  - создать: `proto/fixtures/{conflict-status-request,conflict-status-response,device-displacements}.json`,
    `host/src/routes/device_conflicts.rs`, `host/tests/device_conflicts.rs`,
    `src-tauri/migrations/0016_conflict_notices.sql`, `src/local/conflict-notices.ts`,
    `test/{conflict-notices,host-link-notices,floor-conflict-notices-migration}.test.ts`;
  - изменить: `src-tauri/src/local_db.rs` (`TABLE_CLASSES`), `src-tauri/tests/local_db.rs`,
    `src/app/{host-link.ts,App.tsx}`, `src/floor/queue/{outbox-recovery.ts,QueueScreen.tsx}`,
    `src/floor/{outbox-status.ts,FloorStatusBar.tsx}`,
    `test/{floor-schema,floor-queue-screen,outbox-recovery,floor-outbox-status}.test.ts(x)`.

---

## Задача 1: протокол разбора — типы, фикстуры, Zod, `HostApi`

**Files:**

- Create: `apps/standalone/proto/src/review.rs`, `apps/standalone/proto/tests/review.rs`,
  `apps/standalone/proto/fixtures/office-conflict-page.json`, `office-shift-exceptions.json`,
  `office-shift-rejections.json`, `apps/standalone/src/host/review.ts`,
  `apps/standalone/test/review-protocol.test.ts`
- Modify: `apps/standalone/proto/src/lib.rs` (одна строка `pub mod review;` рядом с
  `pub mod pairing;`), `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Rust (`markiro_proto::review`):
  - `CONFLICT_PAGE_SIZE: u32 = 50`, `CONFLICT_MAX_PAGE: u32 = 200`, `SHIFT_REVIEW_LIMIT: u32 = 500`;
  - перечисления `ConflictKind { Late, Displaced }` и `ExceptionSubject { Box, Pallet }`;
  - структуры `OfficeConflictScan`, `OfficeConflict`, `OfficeConflictPage`,
    `OfficeShiftException`, `OfficeShiftExceptions`, `OfficeShiftRejection`,
    `OfficeShiftRejections`.
- TS (`src/host/review.ts`):
  - схемы `officeConflictPageSchema`, `officeConflictSchema`, `officeShiftExceptionsSchema`,
    `officeShiftRejectionsSchema`;
  - `type ConflictQuery = { shiftId?: string; reviewed?: boolean; page?: number }`,
    `conflictsPath(query: ConflictQuery): string`.
- `HostApi`:
  - `listConflicts(token: string, query: ConflictQuery): Promise<OfficeConflictPage>`;
  - `reviewConflict(token: string, id: string): Promise<OfficeConflict>`;
  - `listShiftExceptions(token: string, id: string): Promise<OfficeShiftExceptions>`;
  - `listShiftRejections(token: string, id: string): Promise<OfficeShiftRejections>`.

- [ ] **Шаг 1: фикстуры** (сначала: красные тесты читают их).

`apps/standalone/proto/fixtures/office-conflict-page.json`:

```json
{
  "items": [
    {
      "id": "c0000000-0000-4000-8000-000000000001",
      "kind": "displaced",
      "codeHash": "0000000000000000000000000000000000000000000000000000000000000007",
      "gtin14": "04600682000013",
      "serial": "S000007",
      "loser": {
        "shiftId": "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
        "shiftNumber": "OCT26-004",
        "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "deviceName": "Станция А",
        "operatorName": "Анна Кузнецова",
        "scannedAt": "2026-10-08T06:01:40.000Z",
        "boxId": "b0000000-0000-4000-8000-000000000001",
        "boxSscc": "046006820000015001"
      },
      "winner": {
        "shiftId": "6b1d0f2f-4e5a-4c9b-8d3e-2f1a0b9c8d7e",
        "shiftNumber": "OCT26-005/S",
        "deviceId": "8d0f7780-8536-41ef-a55c-f18a2c3d4e5f",
        "deviceName": "Станция Б",
        "operatorName": null,
        "scannedAt": "2026-10-08T06:00:50.000Z",
        "boxId": "b0000000-0000-4000-8000-000000000002",
        "boxSscc": null
      },
      "detectedAt": "2026-10-08T07:12:03Z",
      "reviewedAt": "2026-10-08T09:00:00Z",
      "reviewedByName": "Ирина Смирнова"
    },
    {
      "id": "c0000000-0000-4000-8000-000000000002",
      "kind": "late",
      "codeHash": "0000000000000000000000000000000000000000000000000000000000000008",
      "gtin14": "04600682000013",
      "serial": "S000008",
      "loser": {
        "shiftId": "6b1d0f2f-4e5a-4c9b-8d3e-2f1a0b9c8d7e",
        "shiftNumber": "OCT26-005/S",
        "deviceId": "8d0f7780-8536-41ef-a55c-f18a2c3d4e5f",
        "deviceName": "Станция Б",
        "operatorName": null,
        "scannedAt": "2026-10-08T06:03:20.000Z",
        "boxId": null,
        "boxSscc": null
      },
      "winner": {
        "shiftId": "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
        "shiftNumber": "OCT26-004",
        "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "deviceName": "Станция А",
        "operatorName": "Анна Кузнецова",
        "scannedAt": "2026-10-08T06:00:10.000Z",
        "boxId": "b0000000-0000-4000-8000-000000000001",
        "boxSscc": "046006820000015001"
      },
      "detectedAt": "2026-10-08T07:12:03Z",
      "reviewedAt": null,
      "reviewedByName": null
    }
  ],
  "page": 1,
  "pageCount": 1,
  "total": 2
}
```

`office-shift-exceptions.json`:

```json
{
  "items": [
    {
      "id": "e0000000-0000-4000-8000-000000000003",
      "subject": "pallet",
      "kind": "disassemble",
      "subjectId": "a0000000-0000-4000-8000-000000000001",
      "sscc": "146006820000000409",
      "serial": null,
      "reasonCode": "other",
      "reasonText": "Паллета упала",
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "deviceName": "Станция А",
      "operatorName": "Анна Кузнецова",
      "occurredAt": "2026-10-08T06:30:00.000Z",
      "receivedAt": "2026-10-08T06:30:02Z"
    },
    {
      "id": "e0000000-0000-4000-8000-000000000002",
      "subject": "box",
      "kind": "undo",
      "subjectId": "b0000000-0000-4000-8000-000000000003",
      "sscc": null,
      "serial": "S000004",
      "reasonCode": null,
      "reasonText": null,
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "deviceName": "Станция А",
      "operatorName": null,
      "occurredAt": "2026-10-08T06:20:00.000Z",
      "receivedAt": "2026-10-08T06:20:01Z"
    }
  ],
  "total": 2
}
```

`office-shift-rejections.json`:

```json
{
  "items": [
    {
      "recordId": "00000000-0000-4000-8000-000000000022",
      "kind": "box_closed",
      "code": "box_unknown",
      "details": null,
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "deviceName": "Станция А",
      "receivedAt": "2026-10-08T06:41:00Z"
    },
    {
      "recordId": "00000000-0000-4000-8000-000000000021",
      "kind": "scan",
      "code": "invalid_record",
      "details": { "field": "data.boxId" },
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "deviceName": "Станция А",
      "receivedAt": "2026-10-08T06:40:00Z"
    }
  ],
  "total": 2
}
```

- [ ] **Шаг 2: красные тесты.**

`apps/standalone/proto/tests/review.rs`:

```rust
use markiro_proto::review::{
    ConflictKind, ExceptionSubject, OfficeConflictPage, OfficeShiftExceptions,
    OfficeShiftRejections, CONFLICT_MAX_PAGE, CONFLICT_PAGE_SIZE, SHIFT_REVIEW_LIMIT,
};
use markiro_proto::{ExceptionKind, FactKind};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(serde_json::to_value(&typed).unwrap(), original, "{name} changed on round trip");
    typed
}

#[test]
fn a_page_of_conflicts_round_trips_with_both_kinds() {
    let page: OfficeConflictPage = round_trip("office-conflict-page.json");
    assert_eq!(
        page.items.iter().map(|c| c.kind).collect::<Vec<_>>(),
        vec![ConflictKind::Displaced, ConflictKind::Late]
    );
    assert_eq!(ConflictKind::Displaced.as_str(), "displaced");
    assert_eq!(ConflictKind::Late.as_str(), "late");
    // The code travels as its hash, GTIN and serial: never its canonical text.
    let text = fixture("office-conflict-page.json").to_string();
    assert!(!text.contains('\u{1d}') && !text.contains("canonical"));
    assert_eq!((CONFLICT_PAGE_SIZE, CONFLICT_MAX_PAGE), (50, 200));
}

#[test]
fn a_shifts_exceptions_and_refusals_round_trip() {
    let exceptions: OfficeShiftExceptions = round_trip("office-shift-exceptions.json");
    assert_eq!(exceptions.items[0].subject, ExceptionSubject::Pallet);
    assert_eq!(exceptions.items[1].kind, ExceptionKind::Undo);
    let refusals: OfficeShiftRejections = round_trip("office-shift-rejections.json");
    assert_eq!(refusals.items[1].kind, Some(FactKind::Scan));
    assert_eq!(SHIFT_REVIEW_LIMIT, 500);
}

#[test]
fn a_newer_hosts_extra_field_is_tolerated_in_an_answer() {
    let mut page = fixture("office-conflict-page.json");
    page["items"][0]["newField"] = serde_json::json!(1);
    assert!(serde_json::from_value::<OfficeConflictPage>(page).is_ok());
}
```

`apps/standalone/test/review-protocol.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  conflictsPath,
  officeConflictPageSchema,
  officeShiftExceptionsSchema,
  officeShiftRejectionsSchema,
} from "../src/host/review.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe.each([
  ["office-conflict-page.json", officeConflictPageSchema],
  ["office-shift-exceptions.json", officeShiftExceptionsSchema],
  ["office-shift-rejections.json", officeShiftRejectionsSchema],
] as const)("review fixture %s (plan КНФ)", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });
});

describe("conflictsPath", () => {
  it("writes only what is asked, the first page without a number", () => {
    expect(conflictsPath({})).toBe("/v1/office/conflicts");
    expect(conflictsPath({ page: 1 })).toBe("/v1/office/conflicts");
    expect(conflictsPath({ shiftId: "s-1", reviewed: false, page: 3 })).toBe(
      "/v1/office/conflicts?shift=s-1&reviewed=false&page=3",
    );
    expect(conflictsPath({ reviewed: true })).toBe("/v1/office/conflicts?reviewed=true");
  });
});
```

Прогон (оба должны упасть — модулей нет):

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-proto --test review
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/review-protocol.test.ts
```

- [ ] **Шаг 3: `proto/src/review.rs`.**

```rust
//! The office's review of production (plan КНФ, parity spec §5.2): the code
//! conflicts the facts have written since stage 2a (`GET /v1/office/conflicts`,
//! `POST …/{id}/review`), a shift's exceptions and its refused records
//! (`GET /v1/office/shifts/{id}/exceptions`, `…/rejections`). The full code
//! never travels this way: a conflict names its code by hash, GTIN and serial.
//! Answers are lenient (a field a newer host adds is tolerated);
//! `proto/fixtures/office-{conflict-page,shift-exceptions,shift-rejections}.json`
//! hold the shapes both sides read.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{ExceptionKind, FactKind};

/// The rows of one page of conflicts.
pub const CONFLICT_PAGE_SIZE: u32 = 50;
/// The last page the list reaches (10 000 conflicts).
pub const CONFLICT_MAX_PAGE: u32 = 200;
/// The most exceptions, and the most refused records, one answer lists for a
/// shift, newest first; `total` counts them all.
pub const SHIFT_REVIEW_LIMIT: u32 = 500;

/// How the loser lost its code: `late` — it arrived after the owner's scan
/// and was scanned later (its receipt said `conflict`); `displaced` — it
/// owned the code, and an earlier scan that arrived later took it (its
/// receipt had said `accepted`, its item left its box).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    Late,
    Displaced,
}

impl ConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictKind::Late => "late",
            ConflictKind::Displaced => "displaced",
        }
    }
}

impl std::str::FromStr for ConflictKind {
    type Err = String;
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "late" => Ok(ConflictKind::Late),
            "displaced" => Ok(ConflictKind::Displaced),
            other => Err(format!("unknown conflict kind {other}")),
        }
    }
}

/// One side of a conflict: the scan, its shift with its number, the device
/// with its name, the operator (when the scan named one), the device's
/// instant, and the box with its SSCC (`null` while the box is open; no box
/// at all for a scan of a validation shift).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflictScan {
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub scanned_at: String,
    pub box_id: Option<String>,
    pub box_sscc: Option<String>,
}

/// One conflict: two accepted scans of one code; the earlier won it.
/// `detectedAt` and `reviewedAt` are the host's instants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflict {
    pub id: String,
    pub kind: ConflictKind,
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub loser: OfficeConflictScan,
    pub winner: OfficeConflictScan,
    pub detected_at: String,
    pub reviewed_at: Option<String>,
    pub reviewed_by_name: Option<String>,
}

/// One page of conflicts, newest detection first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflictPage {
    pub items: Vec<OfficeConflict>,
    pub page: u32,
    pub page_count: u32,
    pub total: u32,
}

/// What an exception was made on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionSubject {
    Box,
    Pallet,
}

/// One exception of a shift's boxes or pallets as the station sent it: the
/// box's or pallet's SSCC (`null` for an open box), the serial of the code an
/// undo took out, the reason code (words only with `other`), the station
/// and its operator, the device's instant and the host's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftException {
    pub id: String,
    pub subject: ExceptionSubject,
    pub kind: ExceptionKind,
    pub subject_id: String,
    pub sscc: Option<String>,
    pub serial: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftExceptions {
    pub items: Vec<OfficeShiftException>,
    pub total: u32,
}

/// One record of the shift the host refused, as its receipt keeps it: the
/// record's kind, the receipt's code and details (the field of an
/// `invalid_record`), the device and the host's instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftRejection {
    pub record_id: String,
    pub kind: Option<FactKind>,
    pub code: String,
    pub details: Option<Map<String, Value>>,
    pub device_id: String,
    pub device_name: String,
    pub received_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftRejections {
    pub items: Vec<OfficeShiftRejection>,
    pub total: u32,
}
```

Проверить, что `FactKind` и `ExceptionKind` выводят `Deserialize` и `Serialize` в
`snake_case` (`proto/src/lib.rs:1878-1889`, `:2138-2149`). Это так; `FactKind` также `Copy`,
`PartialEq`.

- [ ] **Шаг 4: `src/host/review.ts`.**

```ts
import { z } from "zod";

// The office's review of production (plan КНФ): mirrors `markiro_proto::review`.
// Answers are lenient like the Rust response types (a field a newer host adds is
// tolerated); `proto/fixtures/office-*.json` hold the shapes both sides read.

/** The rows of one page (`CONFLICT_PAGE_SIZE`), the last page (`CONFLICT_MAX_PAGE`). */
export const CONFLICT_PAGE_SIZE = 50;
export const CONFLICT_MAX_PAGE = 200;
/** The most rows a shift's exceptions or refusals list (`SHIFT_REVIEW_LIMIT`). */
export const SHIFT_REVIEW_LIMIT = 500;

export const CONFLICT_KINDS = ["late", "displaced"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

const instant = z.iso.datetime();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);

export const officeConflictScanSchema = z.object({
  shiftId: z.string(),
  shiftNumber: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
  scannedAt: instant,
  boxId: z.string().nullable(),
  boxSscc: z.string().nullable(),
});
export type OfficeConflictScan = z.infer<typeof officeConflictScanSchema>;

export const officeConflictSchema = z.object({
  id: z.string(),
  kind: z.enum(CONFLICT_KINDS),
  codeHash,
  gtin14: z.string(),
  serial: z.string(),
  loser: officeConflictScanSchema,
  winner: officeConflictScanSchema,
  detectedAt: instant,
  reviewedAt: instant.nullable(),
  reviewedByName: z.string().nullable(),
});
export type OfficeConflict = z.infer<typeof officeConflictSchema>;

export const officeConflictPageSchema = z.object({
  items: z.array(officeConflictSchema),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type OfficeConflictPage = z.infer<typeof officeConflictPageSchema>;

export const officeShiftExceptionSchema = z.object({
  id: z.string(),
  subject: z.enum(["box", "pallet"]),
  kind: z.enum(["undo", "clear", "reprint", "disassemble"]),
  subjectId: z.string(),
  sscc: z.string().nullable(),
  serial: z.string().nullable(),
  reasonCode: z.string().nullable(),
  reasonText: z.string().nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  operatorName: z.string().nullable(),
  occurredAt: instant,
  receivedAt: instant,
});
export type OfficeShiftException = z.infer<typeof officeShiftExceptionSchema>;

export const officeShiftExceptionsSchema = z.object({
  items: z.array(officeShiftExceptionSchema),
  total: z.number().int().nonnegative(),
});
export type OfficeShiftExceptions = z.infer<typeof officeShiftExceptionsSchema>;

/** A refused record: its kind as text, so a kind a newer host adds does not fail the list. */
export const officeShiftRejectionSchema = z.object({
  recordId: z.string(),
  kind: z.string().nullable(),
  code: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
  deviceId: z.string(),
  deviceName: z.string(),
  receivedAt: instant,
});
export type OfficeShiftRejection = z.infer<typeof officeShiftRejectionSchema>;

export const officeShiftRejectionsSchema = z.object({
  items: z.array(officeShiftRejectionSchema),
  total: z.number().int().nonnegative(),
});
export type OfficeShiftRejections = z.infer<typeof officeShiftRejectionsSchema>;

/** What `GET /v1/office/conflicts` narrows to; the first page when `page` is left out. */
export interface ConflictQuery {
  /** The losing shift's id. */
  shiftId?: string;
  reviewed?: boolean;
  page?: number;
}

export function conflictsPath(query: ConflictQuery): string {
  const params = new URLSearchParams();
  if (query.shiftId !== undefined) params.set("shift", query.shiftId);
  if (query.reviewed !== undefined) params.set("reviewed", String(query.reviewed));
  if (query.page !== undefined && query.page !== 1) params.set("page", String(query.page));
  const text = params.toString();
  return text === "" ? "/v1/office/conflicts" : `/v1/office/conflicts?${text}`;
}
```

- [ ] **Шаг 5: `HostApi`.** Добавить в интерфейс в `src/host/api.ts` (после
      `getPalletReportRows`) четыре метода с документацией: «every office role» для чтений;
      «administrators and technologists; a conflict reviewed already answers as it is» для разбора.
      В `createHostApi`:

```ts
    listConflicts: (token, query) =>
      client.request("GET", conflictsPath(query), {
        officeToken: token,
        schema: officeConflictPageSchema,
      }),
    reviewConflict: (token, id) =>
      client.request("POST", `/v1/office/conflicts/${id}/review`, {
        officeToken: token,
        schema: officeConflictSchema,
      }),
    listShiftExceptions: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/exceptions`, {
        officeToken: token,
        schema: officeShiftExceptionsSchema,
      }),
    listShiftRejections: (token, id) =>
      client.request("GET", `/v1/office/shifts/${id}/rejections`, {
        officeToken: token,
        schema: officeShiftRejectionsSchema,
      }),
```

Предположение: `client.request("POST", …)` без `body` шлёт пустое тело. Так работает
`officeLogout` (`api.ts:323-327`) — проверить. Хост в `review_conflict` тела не читает.

- [ ] **Шаг 6: `fakeHostApi`** (`test/support/office.tsx`). Методы, которые тест не подменил,
      сейчас падают. Добавить:
  - `reviewConflict: vi.fn<HostApi["reviewConflict"]>(() => unexpected("reviewConflict"))`;
  - три чтения со значениями по умолчанию, потому что карточка смены и диалог выгрузки читают их
    попутно (как `getOrgLogo`):

    ```ts
    listConflicts: vi.fn<HostApi["listConflicts"]>(async () => ({ items: [], page: 1, pageCount: 1, total: 0 })),
    listShiftExceptions: vi.fn<HostApi["listShiftExceptions"]>(async () => ({ items: [], total: 0 })),
    listShiftRejections: vi.fn<HostApi["listShiftRejections"]>(async () => ({ items: [], total: 0 })),
    ```

  Дописать это в комментарий над `fakeHostApi`.

- [ ] **Шаг 7: зелёные тесты, `cargo fmt --check`, typecheck, prettier.**

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-proto --test review
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/review-protocol.test.ts
cargo fmt --manifest-path $WT/apps/standalone/Cargo.toml --all -- --check
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
```

Коммит: `feat(standalone): protocol of the office's review — conflicts, a shift's exceptions and
refusals`.

---

## Задача 2: хост — миграция `0022`, вид конфликта

**Files:**

- Create: `apps/standalone/host/migrations/0022_conflict_review.sql`
- Modify: `apps/standalone/host/src/facts/registry.rs`, `apps/standalone/host/tests/facts.rs`
- Create: `apps/standalone/host/tests/office_conflicts.rs` (здесь — только тест миграции; задача 3
  дописывает маршруты)

**Interfaces:** `registry::conflict_row(conn, code_hash, winner, loser, kind: ConflictKind, at)`.
Публичный API `registry` не меняется.

- [ ] **Шаг 0: номер.** `ls $WT/apps/standalone/host/migrations` и тот же список в открытых
      ветках `claude/fb-*` (`git -C /tmp/claude/wt/<поток> ls-tree --name-only HEAD
apps/standalone/host/migrations/`). Если `0022` занят — следующий свободный, запись в
      «Отклонения».

- [ ] **Шаг 1: красные тесты.**

  В `host/tests/facts.rs`, в конце теста
  `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in` (после последней проверки),
  дописать проверку вида:

```rust
    // Plan КНФ: each row says how its loser lost — taken from its box by an
    // earlier scan, or later than the owner.
    let kinds: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT l.record_id, w.record_id, c.kind FROM code_conflicts c \
         JOIN scans l ON l.id = c.loser_scan_id JOIN scans w ON w.id = c.winner_scan_id \
         ORDER BY l.record_id, w.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert!(kinds.contains(&(record_id(1), record_id(2), "displaced".into())), "{kinds:?}");
    assert!(kinds.contains(&(record_id(3), record_id(2), "late".into())), "{kinds:?}");
    assert!(kinds.contains(&(record_id(2), record_id(6), "displaced".into())), "{kinds:?}");
```

Исполнитель сверяет тройки с последовательностью теста (`facts.rs:996-1080`):

- запись 1 вытеснена записью 2;
- записи 3, 4, 5 проиграли записи 2 поздно;
- запись 2 вытеснена записью 6.

`apps/standalone/host/tests/office_conflicts.rs` — тест миграции на базе без `0022`:

```rust
mod support;

use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};

/// Every migration before `0022`: a host of the integration branch before plan КНФ.
fn before_0022() -> Migrator {
    Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 22)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// Migration `0022` over a host that kept two conflicts of 2a: the loser of
/// one had been accepted (its item was displaced), the other's receipt said
/// `conflict`. Each takes its kind from the loser's receipt; nobody reviewed
/// either, and the new columns and indexes are there.
#[tokio::test]
async fn migration_0022_gives_old_conflicts_their_kind_and_adds_the_review() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before_0022().run(&mut db).await.unwrap();
    // The rows a conflict joins, without the rest of a host: the foreign keys
    // of `scans` are not what this test is about.
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut db).await.unwrap();
    for (scan, record) in [("s-winner", "r-w"), ("s-displaced", "r-d"), ("s-late", "r-l")] {
        sqlx::query(
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
             raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
             VALUES (?, ?, 'device-1', 'shift-1', 'ok', 'km', 38, ?, '04600682000013', 'S1', \
             'c', 'box-1', '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:01Z')",
        )
        .bind(scan)
        .bind(record)
        .bind(format!("{:064x}", 7))
        .execute(&mut db)
        .await
        .unwrap();
    }
    for (record, outcome) in [("r-w", "accepted"), ("r-d", "accepted"), ("r-l", "conflict")] {
        sqlx::query(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             received_at) VALUES ('device-1', ?, 'scan', 'shift-1', ?, ?, '2026-10-08T06:00:01Z')",
        )
        .bind(record)
        .bind("0".repeat(64))
        .bind(outcome)
        .execute(&mut db)
        .await
        .unwrap();
    }
    for (id, loser) in [("c-displaced", "s-displaced"), ("c-late", "s-late")] {
        sqlx::query(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
             detected_at) VALUES (?, ?, 's-winner', ?, '2026-10-08T06:00:01Z')",
        )
        .bind(id)
        .bind(format!("{:064x}", 7))
        .bind(loser)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query("PRAGMA foreign_keys = ON").execute(&mut db).await.unwrap();

    markiro_host::db::MIGRATOR.run(&mut db).await.unwrap();

    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, kind, reviewed_at, reviewed_by FROM code_conflicts ORDER BY id",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("c-displaced".into(), "displaced".into(), None, None),
            ("c-late".into(), "late".into(), None, None),
        ]
    );
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
         ('code_conflicts_loser', 'code_conflicts_detected', 'fact_receipts_rejected', \
          'box_exceptions_shift', 'pallet_exceptions_shift') ORDER BY name",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 5, "{indexes:?}");
    // A review names its reviewer, and a reviewer names a review.
    let half = sqlx::query(
        "UPDATE code_conflicts SET reviewed_at = '2026-10-08T07:00:00Z' WHERE id = 'c-late'",
    )
    .execute(&mut db)
    .await;
    assert!(half.is_err(), "reviewed_at without reviewed_by must fail");
    let kind = sqlx::query("UPDATE code_conflicts SET kind = 'twice' WHERE id = 'c-late'")
        .execute(&mut db)
        .await;
    assert!(kind.is_err());
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}
```

Прогон — оба красные:

- `cargo test … -p markiro-host --test office_conflicts` падает на `MIGRATOR.run` без `0022`
  (нет столбца `kind`);
- `--test facts the_earliest_scan` падает: у строк нет `kind`.

Предположение: `migration.version < 22` верно для любой ветки слияния. Если номер сдвинулся
(шаг 0) — поправить число.

- [ ] **Шаг 2: миграция** `apps/standalone/host/migrations/0022_conflict_review.sql`:

<!-- prettier-ignore -->
```sql
-- Conflicts and the review of a shift (plan КНФ, parity spec §5.2): the
-- office reads `code_conflicts`, which the facts have written since stage 2a
-- (`facts/registry.rs`), and marks a conflict reviewed. Columns and indexes
-- are added; no table is rebuilt, and none of `scans` or `code_owners` (plan
-- РЕЖ rebuilds those) gets an index here.

-- How the loser lost its code: `late` — its scan arrived after the owner's
-- and was scanned later, and its receipt said `conflict`; `displaced` — it
-- owned the code and an earlier scan that arrived later took it, and its
-- receipt had said `accepted`. A row written before this migration takes its
-- kind from the loser's receipt, which the host keeps for good.
ALTER TABLE code_conflicts ADD COLUMN kind TEXT NOT NULL DEFAULT 'late'
  CHECK (kind IN ('late', 'displaced'));
UPDATE code_conflicts SET kind = 'displaced'
WHERE EXISTS (
  SELECT 1 FROM scans s
  JOIN fact_receipts r ON r.device_id = s.device_id AND r.record_id = s.record_id
  WHERE s.id = code_conflicts.loser_scan_id AND r.outcome = 'accepted'
);

-- Who marked the conflict reviewed (`reviewed_at` exists since 0010, nothing
-- set it before this plan): both or neither. An office user is never
-- deleted, only turned off.
ALTER TABLE code_conflicts ADD COLUMN reviewed_by TEXT REFERENCES office_users (id)
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL));

-- A device asks after its own scans' conflicts, and the office filters by
-- the losing shift: both go through the loser's scan.
CREATE INDEX code_conflicts_loser ON code_conflicts (loser_scan_id);
-- The office's list reads newest detection first, a device's displacements
-- oldest first after a cursor.
CREATE INDEX code_conflicts_detected ON code_conflicts (detected_at, id);

-- A shift's refused records: a shift holds one receipt per scan, its
-- refusals are a handful (thousands after a restore); this reads only those.
CREATE INDEX fact_receipts_rejected ON fact_receipts (shift_id, received_at)
  WHERE outcome = 'rejected';

-- A shift's exceptions, newest first (0010 and 0012 index them by box,
-- pallet and record only).
CREATE INDEX box_exceptions_shift ON box_exceptions (shift_id, occurred_at);
CREATE INDEX pallet_exceptions_shift ON pallet_exceptions (shift_id, occurred_at);
```

Шаг 2а — проверить на копии:

- SQLite принимает `ADD COLUMN` с `REFERENCES` (умолчание `NULL`) и с `CHECK`, который
  ссылается на другой столбец (прецедент — `0012_pallets.sql:44-45`);
- `CHECK` проверяется на существующих строках: у всех `reviewed_at IS NULL`.

Если `backup_schema.rs` или `restore.rs` перечисляют столбцы или индексы — дописать в них новые и
записать в «Отклонения».

- [ ] **Шаг 3: `registry.rs`.** Импорт `use markiro_proto::review::ConflictKind;`. У
      `conflict_row` новый параметр `kind: ConflictKind`, вставка:

```rust
async fn conflict_row(
    conn: &mut SqliteConnection,
    code_hash: &str,
    winner: &str,
    loser: &str,
    kind: ConflictKind,
    at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, kind, \
         detected_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(code_hash)
    .bind(winner)
    .bind(loser)
    .bind(kind.as_str())
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
```

Вызовы:

- в ветке позднего скана (`:112`) — `ConflictKind::Late`;
- в ветке вытеснения (`:140`) — `ConflictKind::Displaced`.

Комментарий модуля (`:1-9`): фразу «telling the displaced device and the office's review come
with plan 2b» заменить на «each row says how its loser lost (`kind`); the office reviews it and
the device learns of it (plan КНФ)». Тот же абзац в `0010_facts.sql:122-123` не трогать:
применённые миграции не меняются.

- [ ] **Шаг 4: зелёные тесты.**

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test office_conflicts
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test facts
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test backup_schema
cargo fmt --manifest-path $WT/apps/standalone/Cargo.toml --all -- --check
```

Коммит: `feat(standalone): host migration 0022 — a conflict's kind, its reviewer and the indexes of
the review`.

---

## Задача 3: хост — `GET /v1/office/conflicts` и `POST /v1/office/conflicts/{id}/review`

**Files:**

- Create: `apps/standalone/host/src/routes/office_conflicts.rs`
- Modify: `apps/standalone/host/src/routes/mod.rs` (`pub mod office_conflicts;`),
  `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/auth.rs`,
  `apps/standalone/host/src/audit.rs`, `apps/standalone/host/tests/office_conflicts.rs`

**Interfaces:**

- `pub async fn list_conflicts(State<AppState>, OfficeContext, ApiQuery<ConflictListQuery>) ->
Result<Json<OfficeConflictPage>, ApiError>`.
- `pub async fn review_conflict(State<AppState>, OfficeContext, ApiPath<String>) ->
Result<Json<OfficeConflict>, ApiError>`.
- `pub(crate) async fn read_conflict(conn, id) -> Result<Option<OfficeConflict>, ApiError>`.
- В `auth.rs`:
  - `pub fn reviews_conflicts(role: OfficeRole) -> bool`;
  - `OfficeContext::require_conflict_review(&self)`;
  - `OfficeContext::require_conflict_review_in(&self, conn)`.
- `audit::actions::CONFLICT_REVIEW = "conflict.review"`.
- Маршруты в `protected_routes()`, рядом с `/v1/office/shifts/{id}/boxes`:

  ```rust
  .route("/v1/office/conflicts", get(crate::routes::office_conflicts::list_conflicts))
  .route("/v1/office/conflicts/{id}/review", post(crate::routes::office_conflicts::review_conflict))
  ```

- [ ] **Шаг 1: красные тесты** — дописать в `host/tests/office_conflicts.rs`.

```rust
use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, add_operator, admin, audit_row, audit_rows, audit_trail, box_closed, box_id,
    empty, fact, host_revision, instant, issue_block, ok_scan, open_floor, pair_device,
    receipts, record_id, request, shift_setup, sscc, with_device, Admin, Floor,
};

const BLOCK_A: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

/// Two stations, each in its own shift on its own line. Station A scans code 8
/// at 10 s and code 7 at 100 s into box 1 and closes it with SSCC 1500. Then,
/// a minute later on the host's clock, station B sends what it scanned
/// offline: code 7 at 50 s takes the code from A's box (`displaced`, loser A),
/// code 8 at 200 s by its operator loses to A (`late`, loser B, box 2 open).
struct Scene {
    admin: Admin,
    a: Floor,
    b: Floor,
    detected_at: String,
}

async fn scene() -> Scene {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    let b = open_floor(&admin, &setup, &colleague, &setup.other_line).await;
    for (id, name) in [(&a.station, "Станция А"), (&b.station, "Станция Б")] {
        sqlx::query("UPDATE devices SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
    }
    let (operator, _) = add_operator(&admin, "1001").await;
    let block = issue_block(&admin.app, &a.key, BLOCK_A).await;
    let from_a = [
        fact(&record_id(1), "scan", &a.shift, ok_scan(8, &box_id(1), &instant(10, 0))),
        fact(&record_id(2), "scan", &a.shift, ok_scan(7, &box_id(1), &instant(100, 0))),
        fact(
            &record_id(3),
            "box_closed",
            &a.shift,
            box_closed(&box_id(1), &block, 1500, &[8, 7], &instant(10, 0), &instant(110, 0)),
        ),
    ];
    let answered = receipts(&admin.app, &a.key, &from_a).await;
    assert!(answered.iter().all(|r| r["outcome"] == "accepted"), "{answered:?}");
    admin.app.clock.advance(time::Duration::minutes(1));
    let detected_at = admin.app.state.timestamp();
    let mut late = fact(&record_id(12), "scan", &b.shift, ok_scan(8, &box_id(2), &instant(200, 0)));
    late["operatorId"] = json!(operator);
    let from_b = [
        fact(&record_id(11), "scan", &b.shift, ok_scan(7, &box_id(2), &instant(50, 0))),
        late,
    ];
    let answered = receipts(&admin.app, &b.key, &from_b).await;
    assert_eq!(answered[0], accepted(&record_id(11)));
    assert_eq!(answered[1]["outcome"], "conflict", "{answered:?}");
    Scene { admin, a, b, detected_at }
}

async fn conflict_id(admin: &Admin, loser_record: &str) -> String {
    sqlx::query_scalar(
        "SELECT c.id FROM code_conflicts c JOIN scans l ON l.id = c.loser_scan_id \
         WHERE l.record_id = ?",
    )
    .bind(loser_record)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

fn side(floor: &Floor, name: &str, operator: Value, at: String, n: u32, sscc: Value) -> Value {
    json!({
        "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
        "deviceName": name, "operatorName": operator, "scannedAt": at,
        "boxId": box_id(n), "boxSscc": sscc
    })
}

#[tokio::test]
async fn the_list_names_both_sides_of_each_conflict_newest_first_without_the_full_code() {
    let s = scene().await;
    let (status, page) = s.admin.call("GET", "/v1/office/conflicts", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let late = conflict_id(&s.admin, &record_id(12)).await;
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    // One batch detected both: the later losing scan comes first.
    assert_eq!(
        page,
        json!({
            "items": [
                {
                    "id": late, "kind": "late", "codeHash": format!("{:064x}", 8),
                    "gtin14": "04600682000013", "serial": "S000008",
                    "loser": side(&s.b, "Станция Б", json!("Анна Кузнецова"), instant(200, 0), 2, Value::Null),
                    "winner": side(&s.a, "Станция А", Value::Null, instant(10, 0), 1, json!(sscc(1500))),
                    "detectedAt": s.detected_at, "reviewedAt": null, "reviewedByName": null
                },
                {
                    "id": displaced, "kind": "displaced", "codeHash": format!("{:064x}", 7),
                    "gtin14": "04600682000013", "serial": "S000007",
                    "loser": side(&s.a, "Станция А", Value::Null, instant(100, 0), 1, json!(sscc(1500))),
                    "winner": side(&s.b, "Станция Б", Value::Null, instant(50, 0), 2, Value::Null),
                    "detectedAt": s.detected_at, "reviewedAt": null, "reviewedByName": null
                }
            ],
            "page": 1, "pageCount": 1, "total": 2
        })
    );
    // The canonical text of the test codes ends with a crypto tail «93Tail<n>».
    assert!(!page.to_string().contains("93Tail"));
}

#[tokio::test]
async fn the_list_narrows_by_the_losing_shift_and_by_review_and_checks_its_parameters() {
    let s = scene().await;
    let ids = |page: &Value| -> Vec<String> {
        page["items"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap().to_owned()).collect()
    };
    let (_, of_b) = s.admin.call("GET", &format!("/v1/office/conflicts?shift={}", s.b.shift), None).await;
    assert_eq!(ids(&of_b), vec!["late"]);
    let (_, of_a) = s.admin.call("GET", &format!("/v1/office/conflicts?shift={}", s.a.shift), None).await;
    assert_eq!(ids(&of_a), vec!["displaced"]);
    let (_, open) = s.admin.call("GET", "/v1/office/conflicts?reviewed=false", None).await;
    assert_eq!(open["total"], 2);
    let (_, done) = s.admin.call("GET", "/v1/office/conflicts?reviewed=true", None).await;
    assert_eq!((done["total"].clone(), done["items"].clone()), (json!(0), json!([])));
    let (_, beyond) = s.admin.call("GET", "/v1/office/conflicts?page=2", None).await;
    assert_eq!((beyond["page"].clone(), beyond["items"].clone()), (json!(2), json!([])));
    for (query, field) in [
        ("shift=nonsense", "shift"),
        ("reviewed=maybe", "reviewed"),
        ("page=0", "page"),
        ("page=201", "page"),
        ("page=+1", "page"),
    ] {
        let (status, body) = s.admin.call("GET", &format!("/v1/office/conflicts?{query}"), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{query}");
    }
    let (status, _) = s.admin.call("GET", "/v1/office/conflicts?other=1", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_review_is_kept_once_with_its_reviewer_audit_row_and_revision() {
    let s = scene().await;
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    let path = format!("/v1/office/conflicts/{displaced}/review");
    let rev = host_revision(&s.admin.app).await;
    let reviewed_at = s.admin.app.state.timestamp();
    let admin_name: String = sqlx::query_scalar("SELECT name FROM office_users WHERE id = ?")
        .bind(&s.admin.id)
        .fetch_one(&s.admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = s.admin.call("POST", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((body["reviewedAt"].clone(), body["reviewedByName"].clone()), (json!(reviewed_at), json!(admin_name)));
    assert_eq!(host_revision(&s.admin.app).await, rev + 1);
    let row = s.admin.row(
        "conflict.review",
        "code_conflict",
        &displaced,
        json!({ "kind": "displaced", "loserShiftId": s.a.shift, "loserDeviceId": s.a.station, "winnerShiftId": s.b.shift }),
    );
    assert_eq!(audit_trail(&s.admin.app, "conflict.review").await, vec![row.clone()]);
    // The same review again, by a technologist: the conflict as it is, nothing written.
    let (tech, tech_id) = s.admin.technologist_session().await;
    let audit_before = audit_rows(&s.admin.app).await;
    let (status, again) = s.admin.call_as(&tech, "POST", &path, None).await;
    assert_eq!((status, again.clone()), (StatusCode::OK, body));
    assert_eq!(host_revision(&s.admin.app).await, rev + 1);
    assert_eq!(audit_rows(&s.admin.app).await, audit_before);
    // A technologist reviews the other one: their own row.
    let late = conflict_id(&s.admin, &record_id(12)).await;
    let (status, _) = s.admin.call_as(&tech, "POST", &format!("/v1/office/conflicts/{late}/review"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        audit_trail(&s.admin.app, "conflict.review").await,
        vec![
            row,
            audit_row(
                &tech_id,
                "conflict.review",
                "code_conflict",
                &late,
                json!({ "kind": "late", "loserShiftId": s.b.shift, "loserDeviceId": s.b.station, "winnerShiftId": s.a.shift }),
            ),
        ]
    );
    let (_, done) = s.admin.call("GET", "/v1/office/conflicts?reviewed=true", None).await;
    assert_eq!(done["total"], 2);
}

#[tokio::test]
async fn an_unknown_conflict_and_a_request_without_a_session_change_nothing() {
    let s = scene().await;
    let audit_before = audit_rows(&s.admin.app).await;
    let rev = host_revision(&s.admin.app).await;
    let (status, body) = s
        .admin
        .call("POST", "/v1/office/conflicts/c0000000-0000-4000-8000-000000000099/review", None)
        .await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    // A device key alone is no office session.
    let (status, _) = s
        .admin
        .app
        .send(empty(with_device(request("POST", &format!("/v1/office/conflicts/{displaced}/review")), &s.b.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .admin
        .app
        .send(empty(with_device(request("GET", "/v1/office/conflicts"), &s.b.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(audit_rows(&s.admin.app).await, audit_before);
    assert_eq!(host_revision(&s.admin.app).await, rev);
}

/// Both office roles review (spec §5.2): no role is refused today; a role
/// added later does not compile until `reviews_conflicts` names it.
#[test]
fn both_office_roles_review_conflicts() {
    use markiro_host::auth::reviews_conflicts;
    use markiro_proto::OfficeRole;
    assert!(reviews_conflicts(OfficeRole::Admin));
    assert!(reviews_conflicts(OfficeRole::Technologist));
}
```

Предположения, которые исполнитель проверяет в ходе теста:

- `box_closed(…, &[8, 7], …)` принимает номера кодов в любом порядке (дайджест считает
  помощник);
- SSCC закрытого короба — `sscc(1500)`, а `instant(110, 0)` позже обоих сканов;
- запрос только с ключом устройства без `x-office-session` отвечает `401` (поведение
  `OfficeContext` в `auth.rs:298`);
- если `admin.row` или `audit_row` строят ряд иначе — следовать `support/app.rs:279-305`.

Прогон: `cargo test … -p markiro-host --test office_conflicts` — новые тесты падают (`404 no
  route`).

- [ ] **Шаг 2: `auth.rs`.** После `require_shift_planning_in`:

```rust
    /// The early check of a conflict's review (plan КНФ): administrators and
    /// technologists, as the shift's own actions.
    pub fn require_conflict_review(&self) -> Result<(), ApiError> {
        if reviews_conflicts(self.user.role) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a role that reviews conflicts is required"))
        }
    }

    /// Re-check the review right inside the caller's write transaction.
    pub async fn require_conflict_review_in(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<(), ApiError> {
        if reviews_conflicts(self.live_role_in(conn).await?) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a role that reviews conflicts is required"))
        }
    }
```

и после `edits_catalog`:

```rust
/// Whether a role marks a code conflict reviewed (plan КНФ: administrators and
/// technologists). No wildcard arm: a new role — a viewer of plan РОЛ — does
/// not compile until it is placed here.
pub fn reviews_conflicts(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
    }
}
```

- [ ] **Шаг 3: `audit.rs`** — в `actions` после `SHIFT_EXPORT`:

```rust
    /// The office marked a code conflict reviewed (plan КНФ); the details name
    /// its kind, the losing shift and device and the winning shift, never the
    /// code or its hash. A conflict reviewed already writes no row.
    pub const CONFLICT_REVIEW: &str = "conflict.review";
```

- [ ] **Шаг 4: `routes/office_conflicts.rs`.**

```rust
//! Code conflicts in the office (plan КНФ, the cloud's `/conflicts`):
//! `GET /v1/office/conflicts` lists them newest detection first, a page at a
//! time, narrowed by the LOSING shift (`?shift=`, the side whose box differs
//! from what was packed — the cloud's filter too) and by review
//! (`?reviewed=true|false`); every office role reads it. `POST
//! /v1/office/conflicts/{id}/review` marks one reviewed (administrators and
//! technologists): once, with its reviewer, an audit row and a host revision
//! so the stations' streams wake and ask after their conflicts (plan КНФ,
//! task 7); a conflict reviewed already answers as it is and writes nothing.
//! The code goes by its hash, GTIN and serial: its canonical text, with the
//! crypto tail, never leaves this module.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ConflictKind, OfficeConflict, OfficeConflictPage, OfficeConflictScan, CONFLICT_MAX_PAGE,
    CONFLICT_PAGE_SIZE,
};
use markiro_proto::ShiftOrigin;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiPath, ApiQuery};
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// Both sides of a conflict: the loser's (`l`) and the winner's (`w`) scan,
/// shift, device, operator and box, and who reviewed it. Bound: ?1 the losing
/// shift or NULL, ?2 reviewed (0/1) or NULL.
const FROM: &str = "FROM code_conflicts c \
     JOIN scans l ON l.id = c.loser_scan_id JOIN shifts ls ON ls.id = l.shift_id \
     JOIN devices ld ON ld.id = l.device_id LEFT JOIN operators lo ON lo.id = l.operator_id \
     LEFT JOIN boxes lb ON lb.id = l.box_id \
     JOIN scans w ON w.id = c.winner_scan_id JOIN shifts ws ON ws.id = w.shift_id \
     JOIN devices wd ON wd.id = w.device_id LEFT JOIN operators wo ON wo.id = w.operator_id \
     LEFT JOIN boxes wb ON wb.id = w.box_id \
     LEFT JOIN office_users ru ON ru.id = c.reviewed_by";

const COLUMNS: &str = "SELECT c.id, c.kind, c.code_hash, l.gtin14, l.serial, c.detected_at, \
     c.reviewed_at, ru.name AS reviewed_by_name, \
     l.shift_id AS l_shift_id, ls.number_month_key AS l_month_key, ls.number_seq AS l_seq, \
     ls.created_from AS l_origin, l.device_id AS l_device_id, ld.name AS l_device_name, \
     lo.name AS l_operator_name, l.scanned_at AS l_scanned_at, l.box_id AS l_box_id, \
     lb.sscc AS l_box_sscc, \
     w.shift_id AS w_shift_id, ws.number_month_key AS w_month_key, ws.number_seq AS w_seq, \
     ws.created_from AS w_origin, w.device_id AS w_device_id, wd.name AS w_device_name, \
     wo.name AS w_operator_name, w.scanned_at AS w_scanned_at, w.box_id AS w_box_id, \
     wb.sscc AS w_box_sscc ";

const FILTER: &str = " WHERE (?1 IS NULL OR l.shift_id = ?1) \
     AND (?2 IS NULL OR (c.reviewed_at IS NOT NULL) = ?2)";

/// The list's order: newest detection first; one batch detects several at one
/// instant, so the later losing scan, then the id, keep the order fixed.
const ORDER: &str = " ORDER BY c.detected_at DESC, l.scanned_at DESC, c.id DESC LIMIT ?3 OFFSET ?4";

const COUNT: &str = "SELECT COUNT(*) FROM code_conflicts c \
     JOIN scans l ON l.id = c.loser_scan_id \
     WHERE (?1 IS NULL OR l.shift_id = ?1) AND (?2 IS NULL OR (c.reviewed_at IS NOT NULL) = ?2)";

#[derive(sqlx::FromRow)]
struct ConflictRow {
    id: String,
    kind: String,
    code_hash: String,
    gtin14: String,
    serial: String,
    detected_at: String,
    reviewed_at: Option<String>,
    reviewed_by_name: Option<String>,
    l_shift_id: String,
    l_month_key: String,
    l_seq: i64,
    l_origin: String,
    l_device_id: String,
    l_device_name: String,
    l_operator_name: Option<String>,
    l_scanned_at: String,
    l_box_id: Option<String>,
    l_box_sscc: Option<String>,
    w_shift_id: String,
    w_month_key: String,
    w_seq: i64,
    w_origin: String,
    w_device_id: String,
    w_device_name: String,
    w_operator_name: Option<String>,
    w_scanned_at: String,
    w_box_id: Option<String>,
    w_box_sscc: Option<String>,
}

fn number(month_key: &str, seq: i64, origin: &str) -> Result<String, ApiError> {
    let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
    Ok(shifts::format_number(month_key, seq, origin))
}

fn conflict(row: ConflictRow) -> Result<OfficeConflict, ApiError> {
    Ok(OfficeConflict {
        kind: row.kind.parse::<ConflictKind>().map_err(ApiError::internal)?,
        loser: OfficeConflictScan {
            shift_number: number(&row.l_month_key, row.l_seq, &row.l_origin)?,
            shift_id: row.l_shift_id,
            device_id: row.l_device_id,
            device_name: row.l_device_name,
            operator_name: row.l_operator_name,
            scanned_at: row.l_scanned_at,
            box_id: row.l_box_id,
            box_sscc: row.l_box_sscc,
        },
        winner: OfficeConflictScan {
            shift_number: number(&row.w_month_key, row.w_seq, &row.w_origin)?,
            shift_id: row.w_shift_id,
            device_id: row.w_device_id,
            device_name: row.w_device_name,
            operator_name: row.w_operator_name,
            scanned_at: row.w_scanned_at,
            box_id: row.w_box_id,
            box_sscc: row.w_box_sscc,
        },
        id: row.id,
        code_hash: row.code_hash,
        gtin14: row.gtin14,
        serial: row.serial,
        detected_at: row.detected_at,
        reviewed_at: row.reviewed_at,
        reviewed_by_name: row.reviewed_by_name,
    })
}

/// One conflict by id, both sides read now.
pub(crate) async fn read_conflict(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeConflict>, ApiError> {
    let row: Option<ConflictRow> = sqlx::query_as(&format!("{COLUMNS}{FROM} WHERE c.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(conflict).transpose()
}

/// `GET /v1/office/conflicts?…`: every parameter is text, so a malformed one
/// is `validation_failed` naming it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConflictListQuery {
    shift: Option<String>,
    reviewed: Option<String>,
    page: Option<String>,
}

fn page_of(text: Option<&str>) -> Result<u32, ApiError> {
    match text {
        None => Ok(1),
        Some(text) => text
            .parse::<u32>()
            .ok()
            .filter(|_| text.bytes().all(|byte| byte.is_ascii_digit()))
            .filter(|page| (1..=CONFLICT_MAX_PAGE).contains(page))
            .ok_or_else(|| ApiError::validation("page", format!("1-{CONFLICT_MAX_PAGE}"))),
    }
}

pub async fn list_conflicts(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ConflictListQuery>,
) -> Result<Json<OfficeConflictPage>, ApiError> {
    if let Some(shift) = &query.shift {
        validate::client_uuid("shift", shift)?;
    }
    let reviewed = match query.reviewed.as_deref() {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(ApiError::validation("reviewed", "true or false")),
    };
    let page = page_of(query.page.as_deref())?;
    let size = i64::from(CONFLICT_PAGE_SIZE);
    let offset = i64::from(page - 1) * size;
    // One snapshot: the count and the rows agree.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        let total: i64 = sqlx::query_scalar(COUNT)
            .bind(&query.shift)
            .bind(reviewed)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<ConflictRow> = sqlx::query_as(&format!("{COLUMNS}{FROM}{FILTER}{ORDER}"))
            .bind(&query.shift)
            .bind(reviewed)
            .bind(size)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let total = u32::try_from(total).map_err(ApiError::internal)?;
    Ok(Json(OfficeConflictPage {
        items: rows.into_iter().map(conflict).collect::<Result<_, _>>()?,
        page,
        page_count: total.div_ceil(CONFLICT_PAGE_SIZE).max(1),
        total,
    }))
}

pub async fn review_conflict(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeConflict>, ApiError> {
    context.require_conflict_review()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_conflict_review_in(&mut tx).await?;
    let current = read_conflict(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such conflict"))?;
    if current.reviewed_at.is_some() {
        // Reviewed already: the first reviewer stays, nothing is written.
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE code_conflicts SET reviewed_at = ?, reviewed_by = ? \
         WHERE id = ? AND reviewed_at IS NULL",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::CONFLICT_REVIEW,
            target_type: Some("code_conflict"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "kind": current.kind.as_str(),
                "loserShiftId": current.loser.shift_id,
                "loserDeviceId": current.loser.device_id,
                "winnerShiftId": current.winner.shift_id,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let reviewed = read_conflict(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("conflict vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(reviewed))
}
```

Шаг 4а — проверка плана запроса (тест в том же файле): `EXPLAIN QUERY PLAN` для
`{COUNT}` с `?1` = id смены использует `code_conflicts` целиком (таблица мала) или
`code_conflicts_loser`. Закреплять конкретный путь не нужно, достаточно проверить, что `scans`
ищется по первичному ключу (`SEARCH l USING INDEX sqlite_autoindex_scans_1` или `USING
  PRIMARY KEY`). Для этого `FROM`/`COUNT` сделать `pub const`.

- [ ] **Шаг 5: зелёные тесты.**

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test office_conflicts
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs
cargo fmt --manifest-path $WT/apps/standalone/Cargo.toml --all -- --check
```

`no_secrets_in_logs.rs` проверяет, что журналы не содержат кодов. Если он перечисляет
маршруты — добавить новые.

Коммит: `feat(standalone): host lists code conflicts for the office and keeps their review`.

---

## Задача 4: хост — исключения и отклонённые записи смены

**Files:**

- Create: `apps/standalone/host/src/routes/office_shift_review.rs`,
  `apps/standalone/host/tests/office_shift_review.rs`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`

**Interfaces:**

- `pub async fn list_exceptions(State<AppState>, OfficeContext, ApiPath<String>) ->
Result<Json<OfficeShiftExceptions>, ApiError>`.
- `pub async fn list_rejections(State<AppState>, OfficeContext, ApiPath<String>) ->
Result<Json<OfficeShiftRejections>, ApiError>`.
- `pub const EXCEPTIONS_SQL`, `REJECTIONS_SQL`.
- Маршруты `/v1/office/shifts/{id}/exceptions` и `/v1/office/shifts/{id}/rejections`, оба `get`.

- [ ] **Шаг 1: красные тесты** — `host/tests/office_shift_review.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, box_closed, box_exception, box_id, code_hash, fact, instant,
    issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pallet_closed,
    pallet_id, pallet_sscc, receipts, record_id, shift_setup,
};

const BLOCK: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLETS: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/// A shift with pallets: box 1 (codes 1, 2) closed on pallet 1; box 3 open
/// with codes 3 and 4, then the last scan undone by the operator; pallet 1
/// closed, then taken apart («другая причина: Паллета упала»). The
/// exceptions come newest first with what they were made on.
#[tokio::test]
async fn a_shifts_exceptions_name_their_box_or_pallet_reason_station_and_operator() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    sqlx::query("UPDATE devices SET name = 'Станция А' WHERE id = ?")
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (operator, _) = add_operator(&admin, "1001").await;
    let block = issue_block(&admin.app, &floor.key, BLOCK).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLETS).await;
    let shift = floor.shift.clone();
    let mut closed = box_closed(&box_id(1), &block, 1500, &[1, 2], &instant(10, 0), &instant(20, 0));
    closed["palletId"] = json!(pallet_id(1));
    let mut undo = box_exception("undo", &box_id(3), &instant(55, 0));
    undo["codeHash"] = json!(code_hash(4));
    undo["targetScannedAt"] = json!(instant(50, 0));
    let mut undo_record = fact(&record_id(6), "box_exception", &shift, undo);
    undo_record["operatorId"] = json!(operator);
    let mut pallet_apart = fact(
        &record_id(8),
        "pallet_exception",
        &shift,
        json!({ "exception": "disassemble", "palletId": pallet_id(1), "reasonCode": "other",
                "reasonText": "Паллета упала", "occurredAt": instant(70, 0) }),
    );
    pallet_apart["operatorId"] = json!(operator);
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[
            fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(10, 0))),
            fact(&record_id(2), "scan", &shift, ok_scan(2, &box_id(1), &instant(11, 0))),
            fact(&record_id(3), "box_closed", &shift, closed),
            fact(&record_id(4), "scan", &shift, ok_scan(3, &box_id(3), &instant(40, 0))),
            fact(&record_id(5), "scan", &shift, ok_scan(4, &box_id(3), &instant(50, 0))),
            undo_record,
            fact(
                &record_id(7),
                "pallet_closed",
                &shift,
                pallet_closed(&pallet_id(1), &pallets, 40, 1, &instant(10, 0), &instant(60, 0)),
            ),
            pallet_apart,
        ],
    )
    .await;
    assert!(answered.iter().all(|r| r["outcome"] == "accepted"), "{answered:?}");
    let received = admin.app.state.timestamp();
    let (status, body) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/exceptions"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["items"].as_array().unwrap();
    assert_eq!(body["total"], 2);
    // Each row is its exception's own: the pallet's first, then the box's.
    let pallet_exception: String = sqlx::query_scalar("SELECT id FROM pallet_exceptions")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let box_exception: String = sqlx::query_scalar("SELECT id FROM box_exceptions")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (items[0]["id"].clone(), items[1]["id"].clone()),
        (json!(pallet_exception), json!(box_exception))
    );
    let strip_id = |item: &Value| {
        let mut item = item.clone();
        item.as_object_mut().unwrap().remove("id");
        item
    };
    assert_eq!(
        items.iter().map(strip_id).collect::<Vec<_>>(),
        vec![
            json!({
                "subject": "pallet", "kind": "disassemble", "subjectId": pallet_id(1),
                "sscc": pallet_sscc(40), "serial": null, "reasonCode": "other",
                "reasonText": "Паллета упала", "deviceId": floor.station, "deviceName": "Станция А",
                "operatorName": "Анна Кузнецова", "occurredAt": instant(70, 0), "receivedAt": received
            }),
            json!({
                "subject": "box", "kind": "undo", "subjectId": box_id(3), "sscc": null,
                "serial": "S000004", "reasonCode": null, "reasonText": null,
                "deviceId": floor.station, "deviceName": "Станция А",
                "operatorName": "Анна Кузнецова", "occurredAt": instant(55, 0), "receivedAt": received
            }),
        ]
    );
}

/// The shift's refused records newest first: an unreadable field of a scan
/// and a box the host does not know; a refusal of another shift and one that
/// names a shift the host does not know are not this shift's.
#[tokio::test]
async fn a_shifts_refusals_are_its_rejected_receipts_newest_first() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let other = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let first = admin.app.state.timestamp();
    let mut broken = ok_scan(1, &box_id(1), &instant(10, 0));
    broken["boxId"] = json!("not-a-uuid");
    receipts(&admin.app, &floor.key, &[fact(&record_id(21), "scan", &floor.shift, broken)]).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let second = admin.app.state.timestamp();
    let block = issue_block(&admin.app, &floor.key, BLOCK).await;
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(22),
                "box_closed",
                &floor.shift,
                box_closed(&box_id(9), &block, 1500, &[1], &instant(10, 0), &instant(20, 0)),
            ),
            fact(&record_id(23), "scan", &other.shift, json!({ "verdict": "nonsense" })),
            fact(
                &record_id(24),
                "scan",
                "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
                ok_scan(2, &box_id(2), &instant(12, 0)),
            ),
            fact(&record_id(25), "scan", &floor.shift, ok_scan(3, &box_id(3), &instant(13, 0))),
        ],
    )
    .await;
    let (status, body) = admin
        .call("GET", &format!("/v1/office/shifts/{}/rejections", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let device: String = sqlx::query_scalar("SELECT name FROM devices WHERE id = ?")
        .bind(&floor.station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        body,
        json!({
            "items": [
                { "recordId": record_id(22), "kind": "box_closed", "code": "box_unknown",
                  "details": null, "deviceId": floor.station, "deviceName": device,
                  "receivedAt": second },
                { "recordId": record_id(21), "kind": "scan", "code": "invalid_record",
                  "details": { "field": "data.boxId" }, "deviceId": floor.station,
                  "deviceName": device, "receivedAt": first }
            ],
            "total": 2
        })
    );
}

#[tokio::test]
async fn an_unknown_shift_is_not_found_and_the_refusals_read_their_own_index() {
    let admin = admin().await;
    for tail in ["exceptions", "rejections"] {
        let (status, body) = admin
            .call("GET", &format!("/v1/office/shifts/5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d/{tail}"), None)
            .await;
        assert_eq!((status, body["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    }
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
        "EXPLAIN QUERY PLAN {}",
        markiro_host::routes::office_shift_review::REJECTIONS_SQL
    ))
    .bind("shift-1")
    .bind(500_i64)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let text = plan.iter().map(|row| row.3.clone()).collect::<Vec<_>>().join("\n");
    assert!(text.contains("fact_receipts_rejected"), "{text}");
}
```

Исполнитель сверяет:

- в подходящем случае `box_unknown` — коды отказа (`facts/box_closed.rs`);
- `sscc`/`pallet_sscc` — помощники для SSCC;
- что `pallet_closed(…, 40, 1, …)` закрывает паллету серийным номером 40 при одном коробе;
- что запись `23` с нечитаемыми `data` смены `other` получает `invalid_record` с
  `shift_id = other` — в список `floor.shift` она не попадает.

Прогон: `cargo test … -p markiro-host --test office_shift_review` — падает (`404 no route`).

- [ ] **Шаг 2: `routes/office_shift_review.rs`.**

```rust
//! A shift's review in the office (plan КНФ, pilot spec §7): `GET
//! /v1/office/shifts/{id}/exceptions` — its box and pallet exceptions as the
//! stations sent them — and `…/rejections` — the records of the shift the host
//! refused, as their receipts keep them. Every office role reads them; each
//! answer lists at most `SHIFT_REVIEW_LIMIT` rows, newest first, with the
//! count of all, in one snapshot. A refusal the host could not tie to a shift
//! (`unknown_shift`, `not_entered`, an unreadable record) is in neither: its
//! receipt has no shift. A refused record the station sent again under a new
//! id stays here: the host does not link the two.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ExceptionSubject, OfficeShiftException, OfficeShiftExceptions, OfficeShiftRejection,
    OfficeShiftRejections, SHIFT_REVIEW_LIMIT,
};
use markiro_proto::{ExceptionKind, FactKind};
use serde::de::DeserializeOwned;
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

/// The shift's exceptions, newest first; ?1 the shift, ?2 the limit. An
/// undo's serial is its target scan's (a scan of the box, the code and the
/// instant the undo names; `scans_code_hash` finds it).
pub const EXCEPTIONS_SQL: &str = "SELECT * FROM ( \
     SELECT e.id, 'box' AS subject, e.kind, e.box_id AS subject_id, b.sscc, \
       (SELECT s.serial FROM scans s WHERE s.code_hash = e.code_hash AND s.box_id = e.box_id \
        AND s.scanned_at = e.target_scanned_at AND s.verdict = 'ok' LIMIT 1) AS serial, \
       e.reason_code, e.reason_text, e.device_id, d.name AS device_name, \
       o.name AS operator_name, e.occurred_at, e.received_at \
     FROM box_exceptions e JOIN boxes b ON b.id = e.box_id JOIN devices d ON d.id = e.device_id \
     LEFT JOIN operators o ON o.id = e.operator_id WHERE e.shift_id = ?1 \
     UNION ALL \
     SELECT e.id, 'pallet', e.kind, e.pallet_id, p.sscc, NULL, e.reason_code, e.reason_text, \
       e.device_id, d.name, o.name, e.occurred_at, e.received_at \
     FROM pallet_exceptions e JOIN pallets p ON p.id = e.pallet_id \
     JOIN devices d ON d.id = e.device_id LEFT JOIN operators o ON o.id = e.operator_id \
     WHERE e.shift_id = ?1) \
     ORDER BY occurred_at DESC, id DESC LIMIT ?2";

pub const EXCEPTIONS_COUNT_SQL: &str = "SELECT \
     (SELECT COUNT(*) FROM box_exceptions WHERE shift_id = ?1) + \
     (SELECT COUNT(*) FROM pallet_exceptions WHERE shift_id = ?1)";

/// The shift's refused records, newest first; ?1 the shift, ?2 the limit.
pub const REJECTIONS_SQL: &str = "SELECT r.record_id, r.kind, r.code, r.details, r.device_id, \
     d.name AS device_name, r.received_at FROM fact_receipts r \
     JOIN devices d ON d.id = r.device_id \
     WHERE r.shift_id = ?1 AND r.outcome = 'rejected' \
     ORDER BY r.received_at DESC, r.record_id DESC LIMIT ?2";

pub const REJECTIONS_COUNT_SQL: &str =
    "SELECT COUNT(*) FROM fact_receipts WHERE shift_id = ?1 AND outcome = 'rejected'";

#[derive(sqlx::FromRow)]
struct ExceptionRow {
    id: String,
    subject: String,
    kind: String,
    subject_id: String,
    sscc: Option<String>,
    serial: Option<String>,
    reason_code: Option<String>,
    reason_text: Option<String>,
    device_id: String,
    device_name: String,
    operator_name: Option<String>,
    occurred_at: String,
    received_at: String,
}

#[derive(sqlx::FromRow)]
struct RejectionRow {
    record_id: String,
    kind: Option<String>,
    code: Option<String>,
    details: Option<String>,
    device_id: String,
    device_name: String,
    received_at: String,
}

/// A stored enum's text as its proto type.
fn stored<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_value(Value::String(text.to_owned())).map_err(ApiError::internal)
}

async fn require_shift(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    found.map(|_| ()).ok_or_else(|| ApiError::not_found("no such shift"))
}

pub async fn list_exceptions(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShiftExceptions>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        let total: i64 = sqlx::query_scalar(EXCEPTIONS_COUNT_SQL)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<ExceptionRow> = sqlx::query_as(EXCEPTIONS_SQL)
            .bind(&id)
            .bind(i64::from(SHIFT_REVIEW_LIMIT))
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(OfficeShiftException {
                subject: stored::<ExceptionSubject>(&row.subject)?,
                kind: stored::<ExceptionKind>(&row.kind)?,
                id: row.id,
                subject_id: row.subject_id,
                sscc: row.sscc,
                serial: row.serial,
                reason_code: row.reason_code,
                reason_text: row.reason_text,
                device_id: row.device_id,
                device_name: row.device_name,
                operator_name: row.operator_name,
                occurred_at: row.occurred_at,
                received_at: row.received_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeShiftExceptions {
        items,
        total: u32::try_from(total).map_err(ApiError::internal)?,
    }))
}

pub async fn list_rejections(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShiftRejections>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        let total: i64 = sqlx::query_scalar(REJECTIONS_COUNT_SQL)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<RejectionRow> = sqlx::query_as(REJECTIONS_SQL)
            .bind(&id)
            .bind(i64::from(SHIFT_REVIEW_LIMIT))
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(OfficeShiftRejection {
                kind: row.kind.as_deref().map(stored::<FactKind>).transpose()?,
                // `CHECK ((outcome = 'rejected') = (code IS NOT NULL))` (0010).
                code: row.code.ok_or_else(|| ApiError::internal("a refusal without a code"))?,
                details: row
                    .details
                    .map(|text| serde_json::from_str(&text))
                    .transpose()
                    .map_err(ApiError::internal)?,
                record_id: row.record_id,
                device_id: row.device_id,
                device_name: row.device_name,
                received_at: row.received_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeShiftRejections {
        items,
        total: u32::try_from(total).map_err(ApiError::internal)?,
    }))
}
```

`require_shift` повторяет функцию из `office_boxes.rs:69-78`. Лучше сделать ту
`pub(crate)` и вызвать отсюда, чем копировать. Записать, что выбрано.

- [ ] **Шаг 3: зелёные тесты, `cargo fmt --check`.**

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test office_shift_review
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host
```

Коммит: `feat(standalone): host lists a shift's exceptions and refused records for the office`.

---

## Задача 5: офис — страница «Конфликты»

**Files:**

- Create: `apps/standalone/src/office/conflicts/ConflictsPage.tsx`,
  `apps/standalone/src/office/conflicts/conflict-list.ts`,
  `apps/standalone/test/conflict-list.test.ts`, `apps/standalone/test/conflicts-page.test.tsx`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`,
  `apps/standalone/src/office/access.ts`, `apps/standalone/src/office/office-query.ts`,
  `apps/standalone/src/i18n/ru.json`

**Interfaces:**

- `officeKeys`:
  - `conflicts: ["office", "conflicts"]`;
  - `conflictList: (query: ConflictQuery) => ["office", "conflicts", query.shiftId ?? null,
query.reviewed ?? null, query.page ?? 1]`.
- `access.ts`: возможность `reviewConflicts: ["admin", "technologist"]`.
- `conflict-list.ts`:
  - `REVIEWED_FILTERS`, `type ReviewedFilter = "unreviewed" | "reviewed" | "all"`;
  - `readReviewed(text: string | null): ReviewedFilter`;
  - `conflictQuery(shiftId: string, reviewed: ReviewedFilter, page: number): ConflictQuery`;
  - `loserBoxLink(scan: OfficeConflictScan): string`;
  - `readPage(text: string | null): number`.
- Меню — пункт после `/shifts`:

  ```ts
  { to: "/conflicts", labelKey: "office.nav.conflicts", sectionKey: "office.nav.sections.production", roles: ["admin", "technologist"] }
  ```

- Маршрут — `{ path: "conflicts", element: <ConflictsPage /> }`.

- [ ] **Шаг 1: тексты** (`src/i18n/ru.json`). Сначала ключи — красные тесты ищут их на экране.

| Ключ                                                  | Текст                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `office.nav.conflicts`                                | «Конфликты»                                                                                                                                                                              |
| `office.conflicts.title`                              | «Конфликты»                                                                                                                                                                              |
| `office.conflicts.intro`                              | «Код принят двумя сканами. Код остаётся за самым ранним сканом, второй проиграл: короб проигравшего на хосте не совпадает с собранным. Проверьте короб и отметьте конфликт разобранным.» |
| `office.conflicts.filters.label`                      | «Отбор конфликтов»                                                                                                                                                                       |
| `office.conflicts.filters.shift`                      | «Смена»                                                                                                                                                                                  |
| `office.conflicts.filters.shiftAll`                   | «Все смены»                                                                                                                                                                              |
| `office.conflicts.filters.shiftLinked`                | «Смена из ссылки»                                                                                                                                                                        |
| `office.conflicts.filters.shiftHint`                  | «Смена, чей скан проиграл. Конфликты, где эта смена выиграла код, сюда не попадают.»                                                                                                     |
| `office.conflicts.filters.reviewed`                   | «Состояние»                                                                                                                                                                              |
| `office.conflicts.filters.reviewedOptions.unreviewed` | «Не разобранные»                                                                                                                                                                         |
| `office.conflicts.filters.reviewedOptions.reviewed`   | «Разобранные»                                                                                                                                                                            |
| `office.conflicts.filters.reviewedOptions.all`        | «Все»                                                                                                                                                                                    |
| `office.conflicts.filters.reset`                      | «Сбросить»                                                                                                                                                                               |
| `office.conflicts.found`                              | «Найдено: {{total}}»                                                                                                                                                                     |
| `office.conflicts.table.label`                        | «Список конфликтов»                                                                                                                                                                      |
| `office.conflicts.table.code`                         | «Код»                                                                                                                                                                                    |
| `office.conflicts.table.kind`                         | «Что произошло»                                                                                                                                                                          |
| `office.conflicts.table.loser`                        | «Проигравший скан»                                                                                                                                                                       |
| `office.conflicts.table.winner`                       | «Победивший скан»                                                                                                                                                                        |
| `office.conflicts.table.detected`                     | «Обнаружен»                                                                                                                                                                              |
| `office.conflicts.table.state`                        | «Состояние»                                                                                                                                                                              |
| `office.conflicts.code`                               | «GTIN {{gtin}} · серийный {{serial}}»                                                                                                                                                    |
| `office.conflicts.kinds.late`                         | «Поздний скан: код уже принят раньше в другом месте»                                                                                                                                     |
| `office.conflicts.kinds.displaced`                    | «Вытеснение: код раньше отсканирован в другом месте, из короба он ушёл»                                                                                                                  |
| `office.conflicts.scan.shift`                         | «Смена {{number}}»                                                                                                                                                                       |
| `office.conflicts.scan.operator`                      | «Оператор: {{name}}»                                                                                                                                                                     |
| `office.conflicts.scan.noOperator`                    | «Оператор не указан»                                                                                                                                                                     |
| `office.conflicts.scan.box`                           | «Короб {{sscc}}»                                                                                                                                                                         |
| `office.conflicts.scan.openBox`                       | «Короб ещё открыт»                                                                                                                                                                       |
| `office.conflicts.scan.noBox`                         | «Без короба»                                                                                                                                                                             |
| `office.conflicts.loserBox`                           | «Короб проигравшего»                                                                                                                                                                     |
| `office.conflicts.loserBoxNamed`                      | «Короб проигравшего в карточке смены {{number}}»                                                                                                                                         |
| `office.conflicts.review`                             | «Отметить разобранным»                                                                                                                                                                   |
| `office.conflicts.reviewNamed`                        | «Отметить разобранным конфликт кода {{serial}}»                                                                                                                                          |
| `office.conflicts.reviewed`                           | «Разобран»                                                                                                                                                                               |
| `office.conflicts.reviewedBy`                         | «{{name}}, {{at}}»                                                                                                                                                                       |
| `office.conflicts.unreviewed`                         | «Не разобран»                                                                                                                                                                            |
| `office.conflicts.reviewedNotice`                     | «Конфликт кода {{serial}} отмечен разобранным.»                                                                                                                                          |
| `office.conflicts.empty`                              | «Конфликтов нет»                                                                                                                                                                         |
| `office.conflicts.emptyFiltered`                      | «Нет конфликтов с таким отбором»                                                                                                                                                         |
| `office.conflicts.pager`                              | «Страницы конфликтов»                                                                                                                                                                    |

- [ ] **Шаг 2: красные тесты.**

`test/conflict-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  conflictQuery,
  loserBoxLink,
  readPage,
  readReviewed,
} from "../src/office/conflicts/conflict-list.js";
import type { OfficeConflictScan } from "../src/host/review.js";

const SCAN: OfficeConflictScan = {
  shiftId: "shift-1",
  shiftNumber: "OCT26-004",
  deviceId: "d-1",
  deviceName: "Станция А",
  operatorName: null,
  scannedAt: "2026-10-08T06:01:40.000Z",
  boxId: "box-1",
  boxSscc: "046006820000015001",
};

describe("the conflicts' filters and links (plan КНФ)", () => {
  it("asks the unreviewed ones by default and leaves out what is not narrowed", () => {
    expect(readReviewed(null)).toBe("unreviewed");
    expect(readReviewed("all")).toBe("all");
    expect(readReviewed("nonsense")).toBe("unreviewed");
    expect(conflictQuery("", "unreviewed", 1)).toEqual({ reviewed: false, page: 1 });
    expect(conflictQuery("s-1", "all", 2)).toEqual({ shiftId: "s-1", page: 2 });
    expect(conflictQuery("", "reviewed", 1)).toEqual({ reviewed: true, page: 1 });
  });

  it("reads a page as a positive whole number, the first otherwise", () => {
    expect([readPage(null), readPage("3"), readPage("0"), readPage("x"), readPage("2.5")]).toEqual([
      1, 3, 1, 1, 1,
    ]);
  });

  it("opens the loser's box in its shift's card until plan КРТ gives a box a card of its own", () => {
    expect(loserBoxLink(SCAN)).toBe("/shifts/shift-1?box=046006820000015001");
    expect(loserBoxLink({ ...SCAN, boxSscc: null })).toBe("/shifts/shift-1");
    expect(loserBoxLink({ ...SCAN, boxId: null, boxSscc: null })).toBe("/shifts/shift-1");
  });
});
```

`test/conflicts-page.test.tsx` — по образцу `test/shift-card.test.tsx` (`shiftsSession`,
`renderOffice`, `expectFocusedNotice`). Страница в `fakeHostApi` по умолчанию пуста, поэтому
каждый тест подменяет `listConflicts`. Случаи:

1. Меню «Производство» содержит ссылку «Конфликты». Переход по ней показывает заголовок
   «Конфликты» и вызывает `listConflicts(token, { reviewed: false, page: 1 })`.
2. Строки фикстуры `office-conflict-page.json` (прочитать файлом и разобрать
   `officeConflictPageSchema`):
   - ячейка «Код» — «GTIN 04600682000013 · серийный S000007»;
   - «Что произошло» — «Вытеснение: …»;
   - «Проигравший скан» — «Смена OCT26-004», «Станция А», «Оператор: Анна Кузнецова», время с
     секундами в зоне организации, «Короб (00)046006820000015001»;
   - «Победивший скан» той же строки — «Короб ещё открыт»;
   - во второй строке у проигравшего «Без короба» (поля `boxId` и `boxSscc` — `null`);
   - нигде нет текста `codeHash`.
3. Ссылка «Короб проигравшего в карточке смены OCT26-004» ведёт на
   `/shifts/5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d?box=046006820000015001`. На карточке поле
   «Последние цифры SSCC» содержит `046006820000015001` — проверка вместе с задачей 6, шаг 4.
4. Разобранная строка: «Разобран», «Ирина Смирнова, <время>», кнопки нет. Неразобранная: «Не
   разобран» и кнопка «Отметить разобранным конфликт кода S000008».
5. Нажатие кнопки:
   - `reviewConflict(token, "c0000000-…-000000000002")` вызван один раз;
   - объявление «Конфликт кода S000008 отмечен разобранным.» получает фокус
     (`expectFocusedNotice`);
   - список прочитан снова (`listConflicts` вызван второй раз).
6. Ошибка разбора (`HostError` `api`/`not_found`) — `Alert` с текстом `errors.api.not_found`
   над таблицей, список не перечитан. Кнопка снова доступна.
7. Фильтры:
   - «Состояние» → «Все» вызывает `listConflicts(…, { page: 1 })`;
   - «Смена» → смена `ACTIVE` из `shiftsSession` вызывает `{ shiftId: ACTIVE.id, reviewed:
false, page: 1 }`;
   - «Сбросить» возвращает умолчание;
   - адрес `/conflicts?shift=<id не из списка>` показывает пункт «Смена из ссылки».
8. Страницы: при `pageCount: 3` есть навигация «Страницы конфликтов»; «Вперёд» вызывает `page: 2`.
9. Пустой ответ без отбора — «Конфликтов нет»; с отбором — «Нет конфликтов с таким отбором».
10. Ошибка чтения — `LoadError` с «Повторить», нажатие перечитывает.
11. Клавиатура: `Tab` из фильтров доходит до кнопки разбора. Кнопка — `<button>` с доступным
    именем.

Прогон (должны упасть — модулей и ключей нет):

```bash
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/conflict-list.test.ts test/conflicts-page.test.tsx
```

- [ ] **Шаг 3: `conflict-list.ts`.**

```ts
import type { ConflictQuery, OfficeConflictScan } from "../../host/review.js";

/** The «Состояние» filter of «Конфликты», unreviewed first (the cloud's default). */
export const REVIEWED_FILTERS = ["unreviewed", "reviewed", "all"] as const;
export type ReviewedFilter = (typeof REVIEWED_FILTERS)[number];

/** The filter a link or the address names; the unreviewed ones otherwise. */
export function readReviewed(text: string | null): ReviewedFilter {
  return text === "reviewed" || text === "all" ? text : "unreviewed";
}

/** A page the address names: a positive whole number, the first otherwise. */
export function readPage(text: string | null): number {
  if (text === null || !/^\d+$/.test(text)) return 1;
  const page = Number(text);
  return page >= 1 ? page : 1;
}

/** What the host is asked: only what is narrowed. */
export function conflictQuery(
  shiftId: string,
  reviewed: ReviewedFilter,
  page: number,
): ConflictQuery {
  return {
    ...(shiftId === "" ? {} : { shiftId }),
    ...(reviewed === "all" ? {} : { reviewed: reviewed === "reviewed" }),
    page,
  };
}

/**
 * Where the loser's box is shown. Until plan КРТ gives a box its card, the
 * box's shift's card, its boxes filtered by the SSCC (`?box=`); a box still
 * open or no box at all (a validation shift) opens the shift's card only.
 */
export function loserBoxLink(scan: OfficeConflictScan): string {
  return scan.boxSscc === null
    ? `/shifts/${scan.shiftId}`
    : `/shifts/${scan.shiftId}?box=${scan.boxSscc}`;
}
```

- [ ] **Шаг 4: `ConflictsPage.tsx`** — каркас. Фильтры живут в адресе (`useSearchParams`): так
      работают «назад» и ссылки из карточки смены.

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  Alert,
  Button,
  FilterBar,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeConflict, OfficeConflictScan } from "../../host/review.js";
import { useCan } from "../access.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { ssccText } from "../shifts/shift-card.js";
import {
  conflictQuery,
  loserBoxLink,
  readPage,
  readReviewed,
  REVIEWED_FILTERS,
  type ReviewedFilter,
} from "./conflict-list.js";

/**
 * «Конфликты» (plan КНФ, the cloud's `/conflicts`): two accepted scans of one
 * code, the earlier won it. Newest detection first, a page of 50, narrowed by
 * the losing shift and by review — unreviewed by default, as the cloud — all
 * in the address. Each row names the code by GTIN and serial (never the full
 * code), what happened, both scans — shift, station, operator, the instant to
 * the second, the box — and links the loser's box. «Отметить разобранным» (both
 * roles) marks it once; the notice takes the focus, and the list reads again.
 */
export function ConflictsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const shiftId = params.get("shift") ?? "";
  const reviewed = readReviewed(params.get("state"));
  const page = readPage(params.get("page"));
  const query = conflictQuery(shiftId, reviewed, page);
  const canReview = useCan("reviewConflicts");
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const noticeId = useId();
  const conflicts = useOfficeQuery(officeKeys.conflictList(query), (api, token) =>
    api.listConflicts(token, query),
  );
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token));
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const review = useOfficeMutation((api, token, id: string) => api.reviewConflict(token, id));

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat("ru", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: formTimeZone(org.data),
      }),
    [org.data],
  );
  const at = (instant: string) => time.format(new Date(instant));

  const setFilter = (next: { shift?: string; state?: ReviewedFilter; page?: number }) => {
    const merged = new URLSearchParams(params);
    if (next.shift !== undefined) merged.set("shift", next.shift);
    if (next.state !== undefined) merged.set("state", next.state);
    merged.set("page", String(next.page ?? 1));
    for (const [key, value] of [...merged.entries()]) {
      if (
        value === "" ||
        (key === "state" && value === "unreviewed") ||
        (key === "page" && value === "1")
      ) {
        merged.delete(key);
      }
    }
    setParams(merged);
  };

  const onReview = (conflict: OfficeConflict) => {
    setFailure(null);
    review.mutate(conflict.id, {
      onSuccess: () => {
        setNotice(t("office.conflicts.reviewedNotice", { serial: conflict.serial }));
        void queryClient.invalidateQueries({ queryKey: officeKeys.conflicts });
      },
      onError: (error) => setFailure(alertFailure(error)),
    });
  };

  const shiftOptions = [
    { value: "", label: t("office.conflicts.filters.shiftAll") },
    ...(shifts.data ?? []).map((shift) => ({ value: shift.id, label: shift.number })),
    ...(shiftId !== "" && shifts.data !== undefined && !shifts.data.some((s) => s.id === shiftId)
      ? [{ value: shiftId, label: t("office.conflicts.filters.shiftLinked") }]
      : []),
  ];

  const columns: TableColumn<OfficeConflict>[] = [
    {
      key: "code",
      title: t("office.conflicts.table.code"),
      mono: true,
      wrap: true,
      render: (row) => t("office.conflicts.code", { gtin: row.gtin14, serial: row.serial }),
    },
    {
      key: "kind",
      title: t("office.conflicts.table.kind"),
      wrap: true,
      render: (row) => t(`office.conflicts.kinds.${row.kind}`),
    },
    {
      key: "loser",
      title: t("office.conflicts.table.loser"),
      wrap: true,
      render: (row) => (
        <>
          <ScanCell scan={row.loser} at={at} />
          <Link
            to={loserBoxLink(row.loser)}
            aria-label={t("office.conflicts.loserBoxNamed", { number: row.loser.shiftNumber })}
          >
            {t("office.conflicts.loserBox")}
          </Link>
        </>
      ),
    },
    {
      key: "winner",
      title: t("office.conflicts.table.winner"),
      wrap: true,
      render: (row) => <ScanCell scan={row.winner} at={at} />,
    },
    {
      key: "detected",
      title: t("office.conflicts.table.detected"),
      wrap: true,
      render: (row) => at(row.detectedAt),
    },
    {
      key: "state",
      title: t("office.conflicts.table.state"),
      wrap: true,
      render: (row) =>
        row.reviewedAt !== null ? (
          <span className="shift-cell">
            <StatusChip phase="done" label={t("office.conflicts.reviewed")} />
            <span className="shift-cell__quiet">
              {t("office.conflicts.reviewedBy", {
                name: row.reviewedByName ?? t("office.common.none"),
                at: at(row.reviewedAt),
              })}
            </span>
          </span>
        ) : (
          <span className="shift-cell">
            <StatusChip phase="attention" label={t("office.conflicts.unreviewed")} />
            {canReview && (
              <Button
                variant="secondary"
                size="compact"
                disabled={review.isPending}
                aria-label={t("office.conflicts.reviewNamed", { serial: row.serial })}
                onClick={() => onReview(row)}
              >
                {t("office.conflicts.review")}
              </Button>
            )}
          </span>
        ),
    },
  ];

  const filtered = shiftId !== "" || reviewed !== "unreviewed";
  const content = () => {
    if (conflicts.isPending) return <PageLoading />;
    if (conflicts.isError) {
      return <LoadError error={conflicts.error} onRetry={() => void conflicts.refetch()} />;
    }
    const data = conflicts.data;
    return (
      <>
        <Table
          columns={columns}
          rows={data.items}
          getRowKey={(row) => row.id}
          empty={t(filtered ? "office.conflicts.emptyFiltered" : "office.conflicts.empty")}
          scrollLabel={t("office.conflicts.table.label")}
        />
        {data.pageCount > 1 && (
          <OfficePager
            label={t("office.conflicts.pager")}
            page={data.page}
            pageCount={data.pageCount}
            onPage={(next) => setFilter({ page: next })}
          />
        )}
      </>
    );
  };

  return (
    <div className="office-page">
      <PageHeader title={t("office.conflicts.title")} />
      <p className="office-note">{t("office.conflicts.intro")}</p>
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      <WriteFailureAlert failure={failure} />
      <FilterBar
        label={t("office.conflicts.filters.label")}
        resultSummary={
          conflicts.isSuccess ? t("office.conflicts.found", { total: conflicts.data.total }) : ""
        }
        {...(filtered
          ? {
              resetLabel: t("office.conflicts.filters.reset"),
              onReset: () => setParams(new URLSearchParams()),
            }
          : {})}
      >
        <Select
          native
          label={t("office.conflicts.filters.shift")}
          hint={t("office.conflicts.filters.shiftHint")}
          options={shiftOptions}
          value={shiftId}
          onValueChange={(value) => setFilter({ shift: value })}
        />
        <Select
          native
          label={t("office.conflicts.filters.reviewed")}
          options={REVIEWED_FILTERS.map((value) => ({
            value,
            label: t(`office.conflicts.filters.reviewedOptions.${value}`),
          }))}
          value={reviewed}
          onValueChange={(value) => setFilter({ state: readReviewed(value) })}
        />
      </FilterBar>
      {content()}
    </div>
  );
}

/** One side of a conflict: its shift (a link to its card), station, operator, instant and box. */
function ScanCell({ scan, at }: { scan: OfficeConflictScan; at: (instant: string) => string }) {
  const { t } = useTranslation();
  const box =
    scan.boxId === null
      ? t("office.conflicts.scan.noBox")
      : scan.boxSscc === null
        ? t("office.conflicts.scan.openBox")
        : t("office.conflicts.scan.box", { sscc: ssccText(scan.boxSscc) });
  return (
    <span className="shift-cell">
      <Link to={`/shifts/${scan.shiftId}`}>
        {t("office.conflicts.scan.shift", { number: scan.shiftNumber })}
      </Link>
      <span>{scan.deviceName}</span>
      <span className="shift-cell__quiet">
        {scan.operatorName === null
          ? t("office.conflicts.scan.noOperator")
          : t("office.conflicts.scan.operator", { name: scan.operatorName })}
      </span>
      <span className="shift-cell__quiet">{at(scan.scannedAt)}</span>
      <span className="shift-cell__quiet">{box}</span>
    </span>
  );
}
```

Проверить по коду:

- есть ли у `Select` проп `hint`. Он есть у `Input` (`ShiftCardPage.tsx:507`). Если у
  `Select` нет — подсказку ставить отдельным `<p id>` с `aria-describedby`, как в облаке;
- имя класса страницы (`office-page`) — по `ShiftsPage.tsx`;
- `WriteFailureAlert` без `onReload` объясняет отказ (`page-state.tsx:69-81`);
- `useSearchParams` есть в `react-router` 8.3 (предположение). Если нет — состояние фильтров
  держать в `useState`, а `?shift=` читать один раз из `useLocation().search`.

- [ ] **Шаг 5: меню, маршрут, возможность, ключи запросов** — по «Interfaces». В
      `officeKeys.conflicts` описать: «Every list of conflicts, whatever its filter: a review reads
      them all again».

- [ ] **Шаг 6: зелёные тесты, typecheck, lint, prettier.** Оба прогона по «Заметкам» (verbose и
      стенд с задержкой).

```bash
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/conflict-list.test.ts test/conflicts-page.test.tsx test/office-nav.test.ts
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

Если есть тест меню (`ls test | grep -i nav`), он может перечислять пункты — дописать
«Конфликты» и записать это.

Коммит: `feat(standalone): «Конфликты» in the office, with «Отметить разобранным»`.

---

## Задача 6: офис — разделы карточки смены и предупреждение выгрузки

**Files:**

- Create: `apps/standalone/src/office/shifts/ShiftReview.tsx`, `apps/standalone/test/shift-review.test.tsx`
- Modify:
  - `apps/standalone/src/office/shifts/ShiftCardPage.tsx` (разделы и параметр `box`);
  - `apps/standalone/src/office/office-query.ts` (`shiftExceptions`, `shiftRejections`);
  - `apps/standalone/src/office/exports/{export-checks.ts,ExportDialog.tsx}`;
  - `apps/standalone/src/i18n/ru.json`;
  - тесты `test/{shift-card,export-checks-warnings,export-dialog}.test.ts(x)`.

**Interfaces:**

- `export function ShiftExceptions({ shift, at }: ReviewSectionProps)`,
  `ShiftRejections({ shift, at })`, `ShiftConflicts({ shift, at })`, где `interface
ReviewSectionProps { shift: OfficeShift; at: (instant: string | null) => string }`.
- `officeKeys.shiftExceptions(id)`, `officeKeys.shiftRejections(id)`.
- `ExportWarning` дополняется `{ kind: "unreviewed_conflicts"; conflicts: number }`.
- `export function conflictWarnings(unreviewed: number): ExportWarning[]`.

- [ ] **Шаг 1: тексты.**

| Ключ                                                   | Текст                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `office.shiftCard.review.exceptions.title`             | «Исключения»                                                                                                                                                                                |
| `office.shiftCard.review.exceptions.table`             | «Список исключений»                                                                                                                                                                         |
| `office.shiftCard.review.exceptions.empty`             | «Исключений не было»                                                                                                                                                                        |
| `office.shiftCard.review.exceptions.when`              | «Время»                                                                                                                                                                                     |
| `office.shiftCard.review.exceptions.what`              | «Что сделано»                                                                                                                                                                               |
| `office.shiftCard.review.exceptions.subject`           | «Короб или паллета»                                                                                                                                                                         |
| `office.shiftCard.review.exceptions.reason`            | «Причина»                                                                                                                                                                                   |
| `office.shiftCard.review.exceptions.device`            | «Станция»                                                                                                                                                                                   |
| `office.shiftCard.review.exceptions.operator`          | «Оператор»                                                                                                                                                                                  |
| `office.shiftCard.review.exceptions.kinds.undo`        | «Отмена последнего скана»                                                                                                                                                                   |
| `office.shiftCard.review.exceptions.kinds.clear`       | «Очистка короба»                                                                                                                                                                            |
| `office.shiftCard.review.exceptions.kinds.reprint`     | «Повторная печать этикетки»                                                                                                                                                                 |
| `office.shiftCard.review.exceptions.kinds.disassemble` | «Расформирование»                                                                                                                                                                           |
| `office.shiftCard.review.exceptions.box`               | «Короб {{sscc}}»                                                                                                                                                                            |
| `office.shiftCard.review.exceptions.pallet`            | «Паллета {{sscc}}»                                                                                                                                                                          |
| `office.shiftCard.review.exceptions.openBox`           | «Открытый короб»                                                                                                                                                                            |
| `office.shiftCard.review.exceptions.code`              | «Код: серийный {{serial}}»                                                                                                                                                                  |
| `office.shiftCard.review.exceptions.reasonWords`       | «{{reason}}: {{words}}»                                                                                                                                                                     |
| `office.shiftCard.review.limited`                      | «Показаны последние {{shown}} из {{total}}.»                                                                                                                                                |
| `office.shiftCard.review.pager`                        | «Страницы раздела «{{title}}»»                                                                                                                                                              |
| `office.shiftCard.review.rejections.title`             | «Отклонённые записи станции»                                                                                                                                                                |
| `office.shiftCard.review.rejections.hint`              | «Хост хранит каждый отказ. Запись, которую станция отправила снова под новым номером, хост считает новой, и отказ здесь остаётся. Отказы записей неизвестной хосту смены сюда не попадают.» |
| `office.shiftCard.review.rejections.table`             | «Список отклонённых записей»                                                                                                                                                                |
| `office.shiftCard.review.rejections.empty`             | «Отклонённых записей нет»                                                                                                                                                                   |
| `office.shiftCard.review.rejections.when`              | «Получена»                                                                                                                                                                                  |
| `office.shiftCard.review.rejections.what`              | «Запись»                                                                                                                                                                                    |
| `office.shiftCard.review.rejections.reason`            | «Причина отказа»                                                                                                                                                                            |
| `office.shiftCard.review.rejections.field`             | «Поле: {{field}}»                                                                                                                                                                           |
| `office.shiftCard.review.rejections.unknownKind`       | «Запись неизвестного вида»                                                                                                                                                                  |
| `office.shiftCard.review.conflicts.title`              | «Конфликты»                                                                                                                                                                                 |
| `office.shiftCard.review.conflicts.empty`              | «Конфликтов, где проиграл скан этой смены, нет»                                                                                                                                             |
| `office.shiftCard.review.conflicts.summary`            | «Не разобрано: {{unreviewed}} из {{total}}»                                                                                                                                                 |
| `office.shiftCard.review.conflicts.all`                | «Все конфликты смены»                                                                                                                                                                       |
| `office.exports.warnings.unreviewed_conflicts`         | «Неразобранных конфликтов кодов в смене: {{count}}. Короб, где проиграл скан, может отличаться от выгруженного. Проверьте их в разделе «Конфликты»; выгрузку это не запрещает.»             |

Слова для кода отказа — существующие `floor.queue.code.<code>` (неизвестный код —
`floor.queue.code.other` с `{{code}}`). Для вида записи — `floor.queue.kind.<kind>`. Для
причин — `floor.exceptions.reasons.{reprint,disassemble}.<code>`. Это одни и те же слова на
станции и в офисе: не дублировать.

- [ ] **Шаг 2: красные тесты.**

`test/shift-review.test.tsx`, через `cardSession` из `shift-card.test.tsx`. Если её нельзя
импортировать (она локальна в файле) — вынести в `test/support/shifts.ts` как
`shiftCardSession` и записать это. Случаи:

1. Карточка активной смены показывает регионы «Исключения», «Отклонённые записи станции» и
   «Конфликты» после «Паллет». У запланированной смены их нет: она ничего не получала.
2. «Исключения» из `office-shift-exceptions.json` — строки в порядке ответа:
   - первая: время в зоне организации, «Расформирование», «Паллета (00)146006820000000409»,
     «Другая причина: Паллета упала», «Станция А», «Анна Кузнецова»;
   - вторая: «Отмена последнего скана», «Открытый короб», «Код: серийный S000004», причина «—»,
     оператор «—».
3. «Отклонённые записи станции» из `office-shift-rejections.json`:
   - «Закрытие короба» / «Хост не знает этот короб»;
   - «Скан» / «Хост не смог прочитать запись…» с «Поле: data.boxId»;
   - подсказка раздела на экране.
4. `total` больше числа строк (`total: 900`, 500 строк) — «Показаны последние 500 из 900.» и
   страницы по 50.
5. «Конфликты»:
   - `listConflicts(token, { shiftId: ACTIVE.id, page: 1 })` вызван;
   - сводка «Не разобрано: 1 из 2» по фикстуре;
   - ссылка «Все конфликты смены» ведёт на `/conflicts?shift=<id>&state=all`;
   - строки — код, вид и победитель (смена и станция).
6. Пустые ответы — тексты `empty` каждого раздела.
7. Ошибка одного раздела (`listShiftRejections` отвергает `HostError` `transport`) —
   `LoadError` только в нём, остальные разделы на месте; «Повторить» перечитывает.

В `test/shift-card.test.tsx` дописать случай: адрес `/shifts/<id>?box=046006820000015001`
открывает карточку, и поле «Последние цифры SSCC» уже содержит эти цифры. В таблице виден
только этот короб.

`test/export-checks-warnings.test.ts`:

```ts
import { conflictWarnings } from "../src/office/exports/export-checks.js";

describe("unreviewed conflicts (plan КНФ, ПР-12)", () => {
  it("warn with their number and never refuse", () => {
    expect(conflictWarnings(0)).toEqual([]);
    expect(conflictWarnings(3)).toEqual([{ kind: "unreviewed_conflicts", conflicts: 3 }]);
  });
});
```

`test/export-dialog.test.tsx` — в образце сессии подменить `listConflicts` на `{ items: [],
page: 1, pageCount: 1, total: 2 }`. Проверить:

- для смены с неразобранными конфликтами `listConflicts` вызван с `{ shiftId, reviewed: false,
page: 1 }`;
- предупреждение «Неразобранных конфликтов кодов в смене: 2. …» показано у формата смены;
- кнопка формирования (имя как в существующих тестах файла) доступна, и выгрузка проходит до
  конца (запись `recordShiftExport` вызвана);
- если `listConflicts` отверг — предупреждения нет, диалог работает.

Прогон — красный:

```bash
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-review.test.tsx test/shift-card.test.tsx test/export-checks-warnings.test.ts test/export-dialog.test.tsx
```

- [ ] **Шаг 3: `ShiftReview.tsx`** — три раздела в стиле `ShiftPallets` (`ShiftCardPage.tsx:521-617`):
      `section` с `aria-labelledby`, `h2`, `Card`, `Table` с `scrollLabel`, страницы по
      `BOX_PAGE_SIZE` (50) через `OfficePager`. Существенная часть:

```tsx
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { TFunction } from "i18next";

import { Card, Table, type TableColumn } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { FACT_RECEIPT_CODES } from "../../host/protocol.js";
import type {
  OfficeConflict,
  OfficeShiftException,
  OfficeShiftRejection,
} from "../../host/review.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BOX_PAGE_SIZE, ssccText } from "./shift-card.js";

export interface ReviewSectionProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
}

const RECEIPT_CODES: ReadonlySet<string> = new Set(FACT_RECEIPT_CODES);
const KINDS: ReadonlySet<string> = new Set([
  "scan",
  "box_closed",
  "box_label",
  "box_exception",
  "shift_closed",
  "pallet_closed",
  "pallet_label",
  "pallet_exception",
]);

/** A refusal's code in the station's words (`floor.queue.code.*`); a code a newer host adds, as itself. */
function refusalText(code: string, t: TFunction): string {
  return RECEIPT_CODES.has(code)
    ? t(`floor.queue.code.${code}`)
    : t("floor.queue.code.other", { code });
}

/** An exception's reason in the station's words; `other` with the words the operator typed. */
function reasonText(item: OfficeShiftException, t: TFunction): string {
  if (item.reasonCode === null) return t("office.common.none");
  const list = item.kind === "reprint" ? "reprint" : "disassemble";
  const reason = t(`floor.exceptions.reasons.${list}.${item.reasonCode}`, {
    defaultValue: item.reasonCode,
  });
  return item.reasonText === null
    ? reason
    : t("office.shiftCard.review.exceptions.reasonWords", { reason, words: item.reasonText });
}

/** The shift's exceptions as the stations sent them, newest first (plan КНФ). */
export function ShiftExceptions({ shift, at }: ReviewSectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [page, setPage] = useState(1);
  const list = useOfficeQuery(officeKeys.shiftExceptions(shift.id), (api, token) =>
    api.listShiftExceptions(token, shift.id),
  );
  const columns: TableColumn<OfficeShiftException>[] = [
    {
      key: "when",
      title: t("office.shiftCard.review.exceptions.when"),
      wrap: true,
      render: (item) => at(item.occurredAt),
    },
    {
      key: "what",
      title: t("office.shiftCard.review.exceptions.what"),
      wrap: true,
      render: (item) => (
        <span className="shift-cell">
          <span>{t(`office.shiftCard.review.exceptions.kinds.${item.kind}`)}</span>
          {item.serial !== null && (
            <span className="shift-cell__quiet">
              {t("office.shiftCard.review.exceptions.code", { serial: item.serial })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "subject",
      title: t("office.shiftCard.review.exceptions.subject"),
      mono: true,
      render: (item) =>
        item.sscc === null
          ? t("office.shiftCard.review.exceptions.openBox")
          : t(`office.shiftCard.review.exceptions.${item.subject}`, { sscc: ssccText(item.sscc) }),
    },
    {
      key: "reason",
      title: t("office.shiftCard.review.exceptions.reason"),
      wrap: true,
      render: (item) => reasonText(item, t),
    },
    {
      key: "device",
      title: t("office.shiftCard.review.exceptions.device"),
      render: (item) => item.deviceName,
    },
    {
      key: "operator",
      title: t("office.shiftCard.review.exceptions.operator"),
      render: (item) => item.operatorName ?? t("office.common.none"),
    },
  ];
  return (
    <ReviewSection
      titleId={titleId}
      title={t("office.shiftCard.review.exceptions.title")}
      query={list}
      columns={columns}
      rowKey={(item) => item.id}
      empty={t("office.shiftCard.review.exceptions.empty")}
      tableLabel={t("office.shiftCard.review.exceptions.table")}
      page={page}
      onPage={setPage}
    />
  );
}
```

Остальное:

- `ShiftRejections` строится так же. Колонки: «Получена» (`receivedAt`), «Запись» (вид словами
  `floor.queue.kind.*` или `unknownKind`), «Причина отказа» (`refusalText` плюс «Поле: …» из
  `details.field`, если это строка), «Станция». Подсказка `rejections.hint` — `<p
className="office-note">` под заголовком.
- `ShiftConflicts` читает `listConflicts(token, { shiftId: shift.id, page: 1 })` по ключу
  `officeKeys.conflictList({ shiftId: shift.id, page: 1 })`. Показывает сводку («Не
  разобрано: N из M»; N — число строк с `reviewedAt === null` на первой странице, при `total >
50` — по отдельному чтению `reviewed: false`, `total`). Таблица — код, вид, победитель
  (смена-ссылка и станция), состояние. Ссылка «Все конфликты смены» ведёт на
  `/conflicts?shift=${shift.id}&state=all`. Кнопку разбора повторно не делать: разбор — на
  странице «Конфликты».
- Общая часть — `ReviewSection<T>`: обёртка `section` + `Card`; ожидание, ошибка, таблица,
  `limited` при `total > items.length`, `OfficePager` при больше чем 50 строках. Generic с
  `query: UseQueryResult<{ items: T[]; total: number }, Error>`; импорт типа из
  `@tanstack/react-query`.

- [ ] **Шаг 4: `ShiftCardPage.tsx`.**
  - После `ShiftPallets` (`:289-291`) добавить для `current.status !== "planned"`:

    ```tsx
    <ShiftExceptions shift={current} at={at} />
    <ShiftRejections shift={current} at={at} />
    <ShiftConflicts shift={current} at={at} />
    ```

  - В `readAgain` (`:116-121`) инвалидировать `shiftExceptions(id)`, `shiftRejections(id)` и
    `officeKeys.conflicts`.
  - В `ShiftBoxes` (`:368-372`): `const [params] = useSearchParams();` и `const [tail, setTail] =
useState(() => ssccTail(params.get("box") ?? ""));`. Комментарий: «a conflict's link names
    the loser's box (plan КНФ) until plan КРТ gives a box its card».

- [ ] **Шаг 5: выгрузка.**
  - В `export-checks.ts` дописать к `ExportWarning`:

    ```ts
      /**
       * Code conflicts of the shift nobody reviewed (plan КНФ): a box where a scan lost may
       * differ from what the file writes. A warning, never a refusal (ПР-12).
       */
      | { kind: "unreviewed_conflicts"; conflicts: number };
    ```

    и функцию:

    ```ts
    /** The shift's unreviewed conflicts as a warning of every shift format (plan КНФ, ПР-12). */
    export function conflictWarnings(unreviewed: number): ExportWarning[] {
      return unreviewed > 0 ? [{ kind: "unreviewed_conflicts", conflicts: unreviewed }] : [];
    }
    ```

  - В `ExportDialog.tsx` рядом с `palletList` (`:88-92`):

    ```tsx
    // The shift's unreviewed conflicts (plan КНФ): information, so a list that does not load
    // leaves the dialog whole and the warning out (ПР-12: never a refusal).
    const conflictQuery = { shiftId: shift.id, reviewed: false, page: 1 } as const;
    const unreviewed = useOfficeQuery(officeKeys.conflictList(conflictQuery), (api, token) =>
      api.listConflicts(token, conflictQuery),
    );
    ```

    В `warnings` добавить `...conflictWarnings(unreviewed.data?.total ?? 0)` после
    `...selected.warnings`. В `warningText` добавить ветку:

    ```ts
        case "unreviewed_conflicts":
          return t("office.exports.warnings.unreviewed_conflicts", { count: warning.conflicts });
    ```

    `as const` у объекта запроса — не приведение типа, а фиксация литерала. Если линтер
    возразит — записать тип явно: `const conflictQuery: ConflictQuery = {…}`.

- [ ] **Шаг 6: зелёные тесты** (два прогона экранов), typecheck, lint, prettier.

```bash
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-review.test.tsx test/shift-card.test.tsx test/export-checks-warnings.test.ts test/export-checks.test.ts test/export-dialog.test.tsx
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

Коммит: `feat(standalone): a shift's exceptions, refused records and conflicts on its card; the
export warns of unreviewed conflicts`.

---

## Задача 7 (может быть отрезано): хост — статус конфликтов и вытеснения для устройства

Задача нужна только задаче 8. Если станционная часть отрезана, задача 7 не делается: маршрутов
без потребителя не заводим.

**Files:**

- Create: `apps/standalone/host/src/routes/device_conflicts.rs`, `apps/standalone/host/tests/device_conflicts.rs`,
  `apps/standalone/proto/fixtures/{conflict-status-request,conflict-status-response,device-displacements}.json`
- Modify: `apps/standalone/proto/src/review.rs`, `apps/standalone/proto/tests/review.rs`,
  `apps/standalone/src/host/review.ts`, `apps/standalone/src/host/api.ts`,
  `apps/standalone/test/review-protocol.test.ts`, `apps/standalone/test/support/office.tsx`,
  `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`

**Interfaces:**

- Rust (`markiro_proto::review`):
  - `MAX_CONFLICT_STATUS_RECORDS: usize = 200`, `DISPLACEMENT_PAGE_SIZE: u32 = 100`;
  - `#[serde(rename_all = "camelCase", deny_unknown_fields)] pub struct ConflictStatusRequest {
pub record_ids: Vec<String> }`;
  - `pub struct ReviewedRecord { pub record_id: String, pub reviewed_at: String }`;
  - `pub struct ConflictStatusResponse { pub reviewed: Vec<ReviewedRecord> }`;
  - `pub struct DeviceDisplacement { pub conflict_id: String, pub record_id: String, pub
shift_id: String, pub code_hash: String, pub box_id: Option<String>, pub detected_at: String,
pub winner: CodeOwner, pub reviewed_at: Option<String> }`;
  - `pub struct DeviceDisplacements { pub items: Vec<DeviceDisplacement>, pub more: bool }`.
- Маршруты `POST /v1/device/conflicts/status` и `GET /v1/device/displacements?afterAt=&afterId=`.
  Оба с `AskingDevice`: только чтение, `last_seen_at` не трогается (`routes/codes.rs`).
- TS:
  - `conflictStatusRequestSchema`, `conflictStatusResponseSchema`,
    `deviceDisplacementsSchema`;
  - `HostApi.conflictStatus(request: ConflictStatusRequest): Promise<ConflictStatusResponse>`;
  - `HostApi.listDisplacements(after: { at: string; id: string } | null):
Promise<DeviceDisplacements>`.

- [ ] **Шаг 1: фикстуры.**
  - `conflict-status-request.json`: `{ "recordIds": ["00000000-0000-4000-8000-000000000002",
"00000000-0000-4000-8000-000000000012"] }`.
  - `conflict-status-response.json`: `{ "reviewed": [{ "recordId":
"00000000-0000-4000-8000-000000000002", "reviewedAt": "2026-10-08T09:00:00Z" }] }`.
  - `device-displacements.json`:

```json
{
  "items": [
    {
      "conflictId": "c0000000-0000-4000-8000-000000000001",
      "recordId": "00000000-0000-4000-8000-000000000002",
      "shiftId": "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
      "codeHash": "0000000000000000000000000000000000000000000000000000000000000007",
      "boxId": "b0000000-0000-4000-8000-000000000001",
      "detectedAt": "2026-10-08T07:12:03Z",
      "winner": {
        "shiftId": "6b1d0f2f-4e5a-4c9b-8d3e-2f1a0b9c8d7e",
        "shiftNumber": "OCT26-005/S",
        "deviceId": "8d0f7780-8536-41ef-a55c-f18a2c3d4e5f",
        "scannedAt": "2026-10-08T06:00:50.000Z",
        "sameDevice": false
      },
      "reviewedAt": null
    }
  ],
  "more": false
}
```

- [ ] **Шаг 2: красные тесты.**
  - Rust: три фикстуры проходят круг без потерь. У `ConflictStatusRequest` лишнее поле — ошибка.
  - Vitest: Zod их разбирает.
  - Хост (`host/tests/device_conflicts.rs`): сцена из задачи 3. Помощник `scene` вынести в
    `host/tests/support/app.rs` как `pub async fn conflict_scene() -> ConflictScene` (правило
    «Add a helper there before copying one into a second test file») и в задаче 3 перейти на
    него.

```rust
#[tokio::test]
async fn a_station_learns_which_of_its_conflicts_the_office_reviewed() {
    let s = conflict_scene().await;
    let status = |key: String, ids: Vec<String>| {
        let app = &s.admin.app;
        async move {
            app.send(json(
                with_device(request("POST", "/v1/device/conflicts/status"), &key),
                json!({ "recordIds": ids }),
            ))
            .await
        }
    };
    // Nothing reviewed yet: B asks after its late scan and A's record, which is not B's.
    let (code, body) = status(s.b.key.clone(), vec![record_id(12), record_id(2)]).await;
    assert_eq!((code, body), (StatusCode::OK, json!({ "reviewed": [] })));
    for loser in [record_id(12), record_id(2)] {
        let id = conflict_id(&s.admin, &loser).await;
        s.admin.call("POST", &format!("/v1/office/conflicts/{id}/review"), None).await;
    }
    let reviewed_at = s.admin.app.state.timestamp();
    // Each station hears of its own losing records only, whatever it asks.
    let (_, of_b) = status(s.b.key.clone(), vec![record_id(12), record_id(2), record_id(11)]).await;
    assert_eq!(of_b, json!({ "reviewed": [{ "recordId": record_id(12), "reviewedAt": reviewed_at }] }));
    let (_, of_a) = status(s.a.key.clone(), vec![record_id(2), record_id(12)]).await;
    assert_eq!(of_a, json!({ "reviewed": [{ "recordId": record_id(2), "reviewedAt": reviewed_at }] }));
    // 0 and 201 ids, a malformed id, an extra field: validation_failed on recordIds.
    let too_many: Vec<String> = (1..=201).map(record_id).collect();
    for body in [json!({ "recordIds": [] }), json!({ "recordIds": too_many }),
                 json!({ "recordIds": ["x"] }), json!({ "recordIds": [record_id(1)], "x": 1 })] {
        let (code, answer) = s.admin.app.send(json(
            with_device(request("POST", "/v1/device/conflicts/status"), &s.b.key), body)).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{answer}");
    }
}

#[tokio::test]
async fn a_displaced_station_learns_of_its_displacements_after_its_cursor() {
    let s = conflict_scene().await;
    let list = |key: String, query: String| {
        let app = &s.admin.app;
        async move {
            app.send(empty(with_device(request("GET", &format!("/v1/device/displacements{query}")), &key))).await
        }
    };
    let (code, body) = list(s.a.key.clone(), String::new()).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let conflict = conflict_id(&s.admin, &record_id(2)).await;
    assert_eq!(
        body,
        json!({ "items": [{
            "conflictId": conflict, "recordId": record_id(2), "shiftId": s.a.shift,
            "codeHash": format!("{:064x}", 7), "boxId": box_id(1), "detectedAt": s.detected_at,
            "winner": { "shiftId": s.b.shift, "shiftNumber": s.b.number, "deviceId": s.b.station,
                        "scannedAt": instant(50, 0), "sameDevice": false },
            "reviewedAt": null
        }], "more": false })
    );
    // B lost late, not by displacement: nothing for it.
    let (_, of_b) = list(s.b.key.clone(), String::new()).await;
    assert_eq!(of_b, json!({ "items": [], "more": false }));
    // After the cursor of the one A holds: nothing more.
    let (_, after) = list(s.a.key.clone(), format!("?afterAt={}&afterId={conflict}", s.detected_at)).await;
    assert_eq!(after["items"], json!([]));
    // One end of the cursor without the other.
    let (code, _) = list(s.a.key.clone(), format!("?afterAt={}", s.detected_at)).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    // An office session alone (no device key) is refused like any device route.
    let (code, _) = s.admin.app.send(empty(request("GET", "/v1/device/displacements"))).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
}
```

Импорт `json` и `request` — из `support::app` (`json(builder, body)`). Прогон: `cargo test …
  --test device_conflicts` — красный.

- [ ] **Шаг 3: `routes/device_conflicts.rs`.**

```rust
//! What a device learns of its own conflicts (plan КНФ, the cloud's
//! `POST /station/conflicts/status`): `POST /v1/device/conflicts/status` — of
//! the records it names (1–200), those whose scan lost a conflict the office
//! has reviewed, with when; `GET /v1/device/displacements` — the scans of this
//! device an earlier scan elsewhere took the code from, oldest detection first
//! after the cursor it holds (`afterAt` and `afterId` together), a page of
//! `DISPLACEMENT_PAGE_SIZE`. Reads only, through `AskingDevice`: neither waits
//! for a writer. A device hears of its own scans only, whatever it names.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ConflictStatusRequest, ConflictStatusResponse, DeviceDisplacement, DeviceDisplacements,
    ReviewedRecord, DISPLACEMENT_PAGE_SIZE, MAX_CONFLICT_STATUS_RECORDS,
};
use markiro_proto::{CodeOwner, ShiftOrigin};
use serde::Deserialize;

use crate::auth::AskingDevice;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::server::AppState;
use crate::shifts;
use crate::validate;

const STATUS_SQL: &str = "SELECT l.record_id, c.reviewed_at FROM scans l \
     JOIN code_conflicts c ON c.loser_scan_id = l.id \
     WHERE l.device_id = ?1 AND l.record_id IN (SELECT value FROM json_each(?2)) \
     AND c.reviewed_at IS NOT NULL ORDER BY l.record_id";

const DISPLACEMENTS_SQL: &str = "SELECT c.id, l.record_id, l.shift_id, c.code_hash, l.box_id, \
     c.detected_at, c.reviewed_at, w.shift_id AS w_shift_id, ws.number_month_key, \
     ws.number_seq, ws.created_from, w.device_id AS w_device_id, w.scanned_at AS w_scanned_at \
     FROM code_conflicts c JOIN scans l ON l.id = c.loser_scan_id \
     JOIN scans w ON w.id = c.winner_scan_id JOIN shifts ws ON ws.id = w.shift_id \
     WHERE c.kind = 'displaced' AND l.device_id = ?1 \
     AND (c.detected_at > ?2 OR (c.detected_at = ?2 AND c.id > ?3)) \
     ORDER BY c.detected_at, c.id LIMIT ?4";

pub async fn conflict_status(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiJson(request): ApiJson<ConflictStatusRequest>,
) -> Result<Json<ConflictStatusResponse>, ApiError> {
    if !(1..=MAX_CONFLICT_STATUS_RECORDS).contains(&request.record_ids.len()) {
        return Err(ApiError::validation("recordIds", "1-200 record ids"));
    }
    for id in &request.record_ids {
        validate::client_uuid("recordIds", id)?;
    }
    let ids = serde_json::to_string(&request.record_ids).map_err(ApiError::internal)?;
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let rows: Vec<(String, String)> = sqlx::query_as(STATUS_SQL)
        .bind(&device.id)
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ConflictStatusResponse {
        reviewed: rows
            .into_iter()
            .map(|(record_id, reviewed_at)| ReviewedRecord { record_id, reviewed_at })
            .collect(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplacementQuery {
    after_at: Option<String>,
    after_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct DisplacementRow {
    id: String,
    record_id: String,
    shift_id: String,
    code_hash: String,
    box_id: Option<String>,
    detected_at: String,
    reviewed_at: Option<String>,
    w_shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    w_device_id: String,
    w_scanned_at: String,
}

pub async fn list_displacements(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiQuery(query): ApiQuery<DisplacementQuery>,
) -> Result<Json<DeviceDisplacements>, ApiError> {
    let (after_at, after_id) = match (query.after_at, query.after_id) {
        (None, None) => (String::new(), String::new()),
        (Some(at), Some(id)) => {
            crate::clock::parse_timestamp(&at)
                .map_err(|_| ApiError::validation("afterAt", "a host timestamp"))?;
            validate::client_uuid("afterId", &id)?;
            (at, id)
        }
        _ => return Err(ApiError::validation("afterId", "afterAt and afterId together")),
    };
    let limit = i64::from(DISPLACEMENT_PAGE_SIZE);
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let mut rows: Vec<DisplacementRow> = sqlx::query_as(DISPLACEMENTS_SQL)
        .bind(&device.id)
        .bind(&after_at)
        .bind(&after_id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let more = rows.len() > DISPLACEMENT_PAGE_SIZE as usize;
    rows.truncate(DISPLACEMENT_PAGE_SIZE as usize);
    let items = rows
        .into_iter()
        .map(|row| {
            let origin: ShiftOrigin = row.created_from.parse().map_err(ApiError::internal)?;
            Ok(DeviceDisplacement {
                winner: CodeOwner {
                    shift_number: shifts::format_number(&row.number_month_key, row.number_seq, origin),
                    shift_id: row.w_shift_id,
                    same_device: row.w_device_id == device.id,
                    device_id: row.w_device_id,
                    scanned_at: row.w_scanned_at,
                },
                conflict_id: row.id,
                record_id: row.record_id,
                shift_id: row.shift_id,
                code_hash: row.code_hash,
                box_id: row.box_id,
                detected_at: row.detected_at,
                reviewed_at: row.reviewed_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(DeviceDisplacements { items, more }))
}
```

Проверить:

- `crate::clock::parse_timestamp` (`clock.rs:62`, «Parse a timestamp written by
  format_timestamp») — точное имя и тип ошибки;
- `DISPLACEMENT_PAGE_SIZE as usize` — `clippy` может потребовать `usize::try_from`. Тогда
  `usize::try_from(DISPLACEMENT_PAGE_SIZE).map_err(ApiError::internal)?`;
- id конфликта — UUID v4 нижнего регистра (`registry::conflict_row`), значит
  `client_uuid("afterId")` годится.

Маршруты — рядом с `/v1/device/codes/{code_hash}`:

```rust
        .route("/v1/device/conflicts/status", post(crate::routes::device_conflicts::conflict_status))
        .route("/v1/device/displacements", get(crate::routes::device_conflicts::list_displacements))
```

- [ ] **Шаг 4: Zod и `HostApi`.**

```ts
export const conflictStatusRequestSchema = z.strictObject({
  recordIds: z.array(z.uuid()).min(1).max(200),
});
export type ConflictStatusRequest = z.infer<typeof conflictStatusRequestSchema>;
export const conflictStatusResponseSchema = z.object({
  reviewed: z.array(z.object({ recordId: z.string(), reviewedAt: instant })),
});
export type ConflictStatusResponse = z.infer<typeof conflictStatusResponseSchema>;
export const deviceDisplacementSchema = z.object({
  conflictId: z.uuid(),
  recordId: z.string(),
  shiftId: z.string(),
  codeHash,
  boxId: z.string().nullable(),
  detectedAt: instant,
  winner: codeOwnerSchema,
  reviewedAt: instant.nullable(),
});
export type DeviceDisplacement = z.infer<typeof deviceDisplacementSchema>;
export const deviceDisplacementsSchema = z.object({
  items: z.array(deviceDisplacementSchema),
  more: z.boolean(),
});
export type DeviceDisplacements = z.infer<typeof deviceDisplacementsSchema>;
```

`codeOwnerSchema` импортируется из `./protocol.js`.

В `createHostApi`:

```ts
    conflictStatus: (request) =>
      client.request("POST", "/v1/device/conflicts/status", {
        body: request,
        schema: conflictStatusResponseSchema,
      }),
    listDisplacements: (after) =>
      client.request(
        "GET",
        after === null
          ? "/v1/device/displacements"
          : `/v1/device/displacements?afterAt=${encodeURIComponent(after.at)}&afterId=${encodeURIComponent(after.id)}`,
        { schema: deviceDisplacementsSchema },
      ),
```

`fakeHostApi`: оба метода по умолчанию `unexpected(...)`.

- [ ] **Шаг 5: зелёные тесты, `cargo fmt --check`, typecheck.**

```bash
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-proto --test review
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host --test device_conflicts --test office_conflicts
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/review-protocol.test.ts
```

Коммит: `feat(standalone): a device asks after its reviewed conflicts and its displacements`.

---

## Задача 8 (может быть отрезано): станция — разбор офиса и вытеснения на экране очереди

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0016_conflict_notices.sql`,
  `apps/standalone/src/local/conflict-notices.ts`,
  `apps/standalone/test/{conflict-notices,host-link-notices,floor-conflict-notices-migration}.test.ts`
- Modify:
  - `apps/standalone/src-tauri/src/local_db.rs` (`TABLE_CLASSES`),
    `apps/standalone/src-tauri/tests/local_db.rs`;
  - `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`;
  - `apps/standalone/src/floor/queue/{outbox-recovery.ts,QueueScreen.tsx}`;
  - `apps/standalone/src/floor/{outbox-status.ts,FloorStatusBar.tsx}`;
  - `apps/standalone/src/i18n/ru.json`;
  - тесты `test/{floor-schema,floor-queue-screen,outbox-recovery,floor-outbox-status}.test.ts(x)`.

**Interfaces:**

- `conflict-notices.ts`:
  - `export const NOTICE_STATUS_CHUNK = 200;`
  - `export async function readConflictNotices(context: NoticeContext): Promise<{ changed:
boolean }>`, где `interface NoticeContext { local: LocalExecutor; pairing: Pairing;
conflictStatus: HostApi["conflictStatus"]; listDisplacements: HostApi["listDisplacements"];
now: () => Date }`;
  - SQL-константы `OPEN_NOTICE_IDS_SQL`, `APPLY_REVIEWED_OUTBOX_SQL`,
    `APPLY_REVIEWED_DISPLACEMENTS_SQL`, `DISPLACEMENT_CURSOR_SQL`, `INSERT_DISPLACEMENTS_SQL`.
- `HostLinkOptions`:
  - `conflictStatus?: HostApi["conflictStatus"]`;
  - `listDisplacements?: HostApi["listDisplacements"]` (без них чтение не идёт: старые тесты не
    меняются).
- `outbox-status.ts`: `DISPLACED_COUNT_SQL`, `OutboxStatus.displaced: number`.
- `outbox-recovery.ts`:
  - `QUEUE_DISPLACED_SQL`, `DISMISS_DISPLACEMENT_SQL`;
  - `QueueView.displaced: DisplacedRecord[]`;
  - `dismissDisplacement(context: RecoveryContext, conflictId: string): Promise<void>`.

- [ ] **Шаг 0: номер.** `ls $WT/apps/standalone/src-tauri/migrations` и ветки `claude/fb-*`.
      `0016` по распределению; если занят — следующий свободный, запись в «Отклонения».

- [ ] **Шаг 1: красные тесты.**
  - `test/floor-conflict-notices-migration.test.ts` — по образцу
    `floor-outbox-recovery-migration.test.ts`:
    - `migrate(db, "0001", "0013")` (и `0014`/`0015`, если РЕЖ уже влит — фильтр по именам);
    - вставить записи `outbox` (ожидающая, принятая, конфликт);
    - `migrate(db, "0016", "0016")`;
    - у всех записей `office_reviewed_at IS NULL`;
    - `floor_displacements` пуста, оба индекса есть;
    - `PRAGMA integrity_check` — `ok`;
    - планы прежних запросов очереди не изменились (`plans(db)` до и после).
  - `src-tauri/tests/local_db.rs`:
    - строка `floor_displacements` в классе `DeviceData`. Тест «у каждой таблицы есть класс»
      упадёт без записи в `TABLE_CLASSES`;
    - журнал мигратора содержит `16`;
    - путь обновления `0013 → 0016` сохраняет записи;
    - планы новых запросов (см. шаг 3) закреплены тем же текстом, что в `floor-schema.test.ts`.
  - `test/conflict-notices.test.ts` (`openLocalDb()`, поддельные `conflictStatus`,
    `listDisplacements`):
    1. Два конфликта пары в `outbox` и конфликт другой пары. Хост отвечает разобранным первым:
       - у первого `resolution = 'dismissed'`, `resolved_at` (время `now`), `resolved_by IS
NULL`, `office_reviewed_at` — из ответа;
       - второй не тронут; чужая пара не спрошена и не тронута;
       - `CONFLICT_COUNT_SQL` даёт 1;
       - `changed: true`.
    2. Вытеснение из ответа `listDisplacements` записано в `floor_displacements` с полями
       фикстуры `device-displacements.json`. Второй вызов спрашивает с курсором `{ at:
detectedAt, id: conflictId }` и не дублирует строку.
    3. Вытеснение, пришедшее с `reviewedAt`, записано сразу разобранным (`resolved_at`,
       `office_reviewed_at`).
    4. Открытое вытеснение входит в следующий запрос статуса. Хост отвечает его записью → у
       строки `resolved_at` и `office_reviewed_at`.
    5. 450 открытых номеров спрашиваются тремя запросами (200, 200, 50).
    6. `more: true` → второй запрос страницы с курсором последней строки.
    7. Хост отвечает `HostError` `api`/`not_found` (старый хост) → без ошибки, `changed:
false`, ничего не записано.
    8. Транспортная ошибка → отказ промиса (планировщик повторит).
    9. Нечего спрашивать (нет открытых) → `conflictStatus` не вызван.
  - `test/host-link-notices.test.ts` — по образцу `host-link-shifts.test.ts`:
    - чтение идёт после `watch` и после каждой ревизии;
    - `outbox_changed` отправляется, когда `changed`;
    - неудача — повтор по `nextSyncRetryMs` при связи;
    - отказ ключа (`HostError` `unauthorized` с `credential = device`) останавливает связь, как
      везде;
    - без `conflictStatus` в опциях чтение не идёт.
  - `test/floor-queue-screen.test.tsx`:
    - раздел «Вытесненные коды» со строкой «Короб (00)… · дд.мм чч:мм» и пояснением «Код из
      этого короба раньше отсканирован в смене OCT26-005/S…»;
    - «Разобрано» → подтверждение (тот же стражник 400 мс) → строка ушла, объявление
      «Вытеснение отмечено разобранным.», `onChanged` вызван;
    - пусто — «Вытесненных кодов нет.»;
    - конфликт, разобранный офисом, в разделе «Конфликты» не показан.
  - `test/floor-outbox-status.test.ts`: `displaced` считает открытые вытеснения пары;
    существующие ожидания `toEqual` дополнить `displaced: 0`.
  - `test/outbox-recovery.test.ts`: `readQueue` возвращает `displaced`; существующие `toEqual`
    дополнить `displaced: []`. `dismissDisplacement` пишет `resolved_at`/`resolved_by`, повтор —
    `StaleQueueError`.

  Прогон всех перечисленных — красный.

- [ ] **Шаг 2: миграция** `apps/standalone/src-tauri/migrations/0016_conflict_notices.sql`:

<!-- prettier-ignore -->
```sql
-- Plan КНФ, the station's part: what the host tells this station of its own
-- conflicts. `office_reviewed_at` — the host's instant at which the office
-- marked a conflicting record's conflict reviewed; the station then resolves
-- the record itself (`resolution = 'dismissed'`, `resolved_at` its own clock,
-- `resolved_by` NULL: no operator of this station did it), so the status bar,
-- the queue screen and the retention stop counting it. NULL for every record
-- written before this migration and for every one the office did not review.
ALTER TABLE outbox ADD COLUMN office_reviewed_at TEXT;

-- The scans of this station an earlier scan elsewhere took the code from
-- (`GET /v1/device/displacements`): the host had accepted them, so no receipt
-- says it. One row per conflict and pairing, as the host sent it; the winner
-- by its shift's number and whether it is this station's own (never a
-- device's name: the station keeps no list of devices). `learned_at` and
-- `resolved_at` are this computer's clock (`Date.toISOString`), `detected_at`
-- and `office_reviewed_at` the host's. A person resolves a row on the queue
-- screen (`resolved_by` the operator), or the office's review does
-- (`office_reviewed_at`, `resolved_by` NULL). `DeviceData`, no `shift_id`
-- retention: the rows are few, and the newest one is the cursor of the next
-- read, which must never go back. No foreign key (see `0006`).
CREATE TABLE floor_displacements (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  box_id TEXT,
  detected_at TEXT NOT NULL,
  winner_shift_number TEXT NOT NULL,
  winner_same_device INTEGER NOT NULL CHECK (winner_same_device IN (0, 1)),
  winner_scanned_at TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  office_reviewed_at TEXT,
  PRIMARY KEY (host_id, device_id, conflict_id),
  CHECK (resolved_by IS NULL OR resolved_at IS NOT NULL),
  CHECK (office_reviewed_at IS NULL OR resolved_at IS NOT NULL)
);
-- The cursor of the next read: the pairing's newest detection.
CREATE INDEX floor_displacements_cursor
  ON floor_displacements (host_id, device_id, detected_at, conflict_id);
-- The open ones: the status bar's count, the queue screen, the status read.
CREATE INDEX floor_displacements_open ON floor_displacements (host_id, device_id)
  WHERE resolved_at IS NULL;
```

В `TABLE_CLASSES` (`local_db.rs:76`) по алфавиту после `floor_codes`:
`("floor_displacements", TableClass::DeviceData),`.

- [ ] **Шаг 3: `src/local/conflict-notices.ts`.**

```ts
import { z } from "zod";

import { HostError } from "../host/client.js";
import type { HostApi } from "../host/api.js";
import type { DeviceDisplacement } from "../host/review.js";
import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** The most record ids one status request names (`MAX_CONFLICT_STATUS_RECORDS`). */
export const NOTICE_STATUS_CHUNK = 200;

/**
 * This pairing's records whose conflict, or whose displacement, nobody
 * resolved yet; parameters: host id, device id, host id, device id.
 */
export const OPEN_NOTICE_IDS_SQL =
  "SELECT id FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict' " +
  "AND resolved_at IS NULL UNION SELECT record_id FROM floor_displacements " +
  "WHERE host_id = ? AND device_id = ? AND resolved_at IS NULL";

/**
 * The office reviewed these conflicts: the records are resolved by this
 * station, by nobody of it (`resolved_by` NULL). The pluses look each record
 * up by its own key, as the sender's statements do. Parameters: the instant,
 * the JSON list of `{recordId, reviewedAt}`, host id, device id.
 */
export const APPLY_REVIEWED_OUTBOX_SQL =
  "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = NULL, " +
  "office_reviewed_at = r.value ->> 'reviewedAt' FROM json_each(?) AS r " +
  "WHERE outbox.id = r.value ->> 'recordId' AND +outbox.host_id = ? AND +outbox.device_id = ? " +
  "AND +outbox.outcome = 'conflict' AND outbox.resolved_at IS NULL";

/** The same for displacements; parameters as `APPLY_REVIEWED_OUTBOX_SQL`. */
export const APPLY_REVIEWED_DISPLACEMENTS_SQL =
  "UPDATE floor_displacements SET resolved_at = ?, office_reviewed_at = r.value ->> 'reviewedAt' " +
  "FROM json_each(?) AS r WHERE floor_displacements.host_id = ? " +
  "AND floor_displacements.device_id = ? AND floor_displacements.record_id = r.value ->> 'recordId' " +
  "AND floor_displacements.resolved_at IS NULL";

/** The pairing's newest displacement: the cursor of the next read; parameters: host id, device id. */
export const DISPLACEMENT_CURSOR_SQL =
  "SELECT detected_at, conflict_id FROM floor_displacements WHERE host_id = ? AND device_id = ? " +
  "ORDER BY detected_at DESC, conflict_id DESC LIMIT 1";

/**
 * The displacements the host sent, each once: parameters: the instant, host id,
 * device id, the JSON list. One reviewed already comes resolved.
 */
export const INSERT_DISPLACEMENTS_SQL =
  "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
  "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, winner_scanned_at, " +
  "learned_at, resolved_at, office_reviewed_at) SELECT ?2, ?3, d.value ->> 'conflictId', " +
  "d.value ->> 'recordId', d.value ->> 'shiftId', d.value ->> 'codeHash', d.value ->> 'boxId', " +
  "d.value ->> 'detectedAt', d.value ->> '$.winner.shiftNumber', " +
  "(d.value ->> '$.winner.sameDevice') = 1, d.value ->> '$.winner.scannedAt', ?1, " +
  "CASE WHEN d.value ->> 'reviewedAt' IS NULL THEN NULL ELSE ?1 END, d.value ->> 'reviewedAt' " +
  "FROM json_each(?4) AS d WHERE true ON CONFLICT (host_id, device_id, conflict_id) DO NOTHING";

const idRow = z.object({ id: z.string() });
const cursorRow = z.object({ detected_at: z.string(), conflict_id: z.string() });

export interface NoticeContext {
  local: LocalExecutor;
  pairing: Pairing;
  conflictStatus: HostApi["conflictStatus"];
  listDisplacements: HostApi["listDisplacements"];
  now: () => Date;
}

/** A host that does not know the routes yet (an older build): nothing to learn, no failure. */
function olderHost(error: unknown): boolean {
  return error instanceof HostError && error.kind === "api" && error.code === "not_found";
}

/**
 * What the host tells this station of its conflicts (plan КНФ): first the
 * displacements after the newest one kept, a page at a time, each kept once
 * (one the office reviewed already comes resolved); then, of every record
 * whose conflict or displacement nobody resolved, the ones the office
 * reviewed, in parts of `NOTICE_STATUS_CHUNK` — resolved here with the
 * office's instant and no operator. Each part is one transaction. An older
 * host (`not_found`) is no failure: nothing is learned. Any other failure
 * rejects, and the link retries. Answers whether anything was written, so
 * the status bar and the queue read again.
 */
export async function readConflictNotices(context: NoticeContext): Promise<{ changed: boolean }> {
  const { local, pairing } = context;
  const key = [pairing.hostId, pairing.deviceId];
  let changed = false;
  try {
    for (;;) {
      const [cursor] = await local.query(DISPLACEMENT_CURSOR_SQL, key, cursorRow);
      const page = await context.listDisplacements(
        cursor === undefined ? null : { at: cursor.detected_at, id: cursor.conflict_id },
      );
      if (page.items.length > 0) {
        changed = (await keep(context, page.items)) || changed;
      }
      if (!page.more) break;
    }
    const open = await local.query(OPEN_NOTICE_IDS_SQL, [...key, ...key], idRow);
    const ids = open.map((row) => row.id).sort();
    for (let start = 0; start < ids.length; start += NOTICE_STATUS_CHUNK) {
      const part = ids.slice(start, start + NOTICE_STATUS_CHUNK);
      const answer = await context.conflictStatus({ recordIds: part });
      const asked = new Set(part);
      const reviewed = answer.reviewed.filter((entry) => asked.has(entry.recordId));
      if (reviewed.length === 0) continue;
      const at = context.now().toISOString();
      const list = JSON.stringify(reviewed);
      await local.transaction([
        { sql: APPLY_REVIEWED_OUTBOX_SQL, values: [at, list, pairing.hostId, pairing.deviceId] },
        {
          sql: APPLY_REVIEWED_DISPLACEMENTS_SQL,
          values: [at, list, pairing.hostId, pairing.deviceId],
        },
      ]);
      changed = true;
    }
  } catch (error) {
    if (olderHost(error)) return { changed };
    throw error;
  }
  return { changed };
}

async function keep(
  context: NoticeContext,
  items: readonly DeviceDisplacement[],
): Promise<boolean> {
  await context.local.transaction([
    {
      sql: INSERT_DISPLACEMENTS_SQL,
      values: [
        context.now().toISOString(),
        context.pairing.hostId,
        context.pairing.deviceId,
        JSON.stringify(items),
      ],
    },
  ]);
  return true;
}
```

Проверить по коду и записать:

- `LocalStatement` — `{ sql, values, expectedChanges? }` (`src/local/executor.ts`);
- нумерованные параметры `?1…?4` проходят проверку оболочки (`check_statement` считает
  значения по числу привязок, `test/support/local-db.ts`). Если нумерация не поддержана —
  повторить значения позиционно (`?` ×5);
- `->>` с путём `'$.winner.shiftNumber'` поддерживается SQLite обеих сборок (3.53 в Node и в
  оболочке; так уже пишет `QUEUE_SETTLED_SQL`);
- `(… ->> '$.winner.sameDevice') = 1` даёт 0/1: `->>` возвращает JSON `true` как 1.

Планы запросов закрепить в `test/floor-schema.test.ts` и `src-tauri/tests/local_db.rs`:

- `OPEN_NOTICE_IDS_SQL` — `outbox_settled` и `floor_displacements_open`;
- `DISPLACEMENT_CURSOR_SQL` — `floor_displacements_cursor`;
- оба `APPLY_*` — поиск по ключу (`sqlite_autoindex_outbox_…` / первичный ключ
  `floor_displacements`);
- `DISPLACED_COUNT_SQL` — `floor_displacements_open`.

- [ ] **Шаг 4: `host-link.ts`.** В опции добавить `conflictStatus?` и `listDisplacements?` с
      документацией. В эффекте — счётчик и отложенный повтор, как у `shiftReader`:

```ts
// And for what the host tells this station of its conflicts (plan КНФ).
let noticeFailures = 0;
let noticeRetry: ReturnType<typeof setTimeout> | null = null;
const cancelNoticeRetry = () => {
  if (noticeRetry === null) return;
  clearTimeout(noticeRetry);
  noticeRetry = null;
};
```

планировщик после `shiftReader`:

```ts
// One read of the conflict notices at a time, retried like the reads above
// (plan КНФ): the office's review takes a revision, so a station online
// hears of it at once; a displacement takes none (the facts are not
// changed for it) and is heard at the next revision or reconnect. A
// refused key ends the link as everywhere; anything else keeps what the
// station has.
const noticeReader = createSyncScheduler(async () => {
  if (!active || conflictStatus === undefined || listDisplacements === undefined) return;
  cancelNoticeRetry();
  try {
    const { changed } = await readConflictNotices({
      local,
      pairing,
      conflictStatus,
      listDisplacements,
      now: () => new Date(),
    });
    if (!active) return;
    noticeFailures = 0;
    if (changed) dispatch({ type: "outbox_changed" });
  } catch (error) {
    if (!active) return;
    const action = shellActionFor(error, null);
    if (action) {
      stopAll();
      dispatch(action);
      return;
    }
    if (error instanceof HostError && error.code === "not_paired") return;
    noticeFailures += 1;
    if (online) {
      noticeRetry = setTimeout(() => {
        noticeRetry = null;
        noticeReader.trigger();
      }, nextSyncRetryMs(noticeFailures));
    }
  }
});
```

`noticeReader.stop()` и `cancelNoticeRetry()` дописать в `stopAll`, `noticeReader.trigger()` — в
`everything`. Очистку эффекта (`active = false` и остановки, ниже `:560`) дополнить тем же
образом, что для `shiftReader`. Зависимости эффекта дополнить двумя функциями. Длинный
комментарий над `useHostLink` дополнить фразой о чтении уведомлений о конфликтах.

В `App.tsx` (`:287-299`) передать `conflictStatus: hostApi.conflictStatus` и
`listDisplacements: hostApi.listDisplacements`.

- [ ] **Шаг 5: экран очереди и строка состояния.**
  - `outbox-recovery.ts`:

```ts
/** The open displacements of the pairing, oldest first, with the shift's number and the box's SSCC; parameters: host id, device id. */
export const QUEUE_DISPLACED_SQL =
  "SELECT d.conflict_id, d.shift_id, s.number AS shift_number, b.sscc, d.detected_at, " +
  "d.winner_shift_number, d.winner_same_device FROM floor_displacements d " +
  "LEFT JOIN floor_shifts s ON s.host_id = d.host_id AND s.device_id = d.device_id " +
  "AND s.id = d.shift_id LEFT JOIN floor_boxes b ON b.id = d.box_id " +
  "WHERE d.host_id = ? AND d.device_id = ? AND d.resolved_at IS NULL " +
  "ORDER BY d.detected_at, d.conflict_id LIMIT 100";

/** A displacement settled by a person; parameters: the instant, the operator, host id, device id, conflict id. */
export const DISMISS_DISPLACEMENT_SQL =
  "UPDATE floor_displacements SET resolved_at = ?, resolved_by = ? WHERE host_id = ? " +
  "AND device_id = ? AND conflict_id = ? AND resolved_at IS NULL";

export interface DisplacedRecord {
  conflictId: string;
  shiftId: string;
  shiftNumber: string | null;
  sscc: string | null;
  detectedAt: string;
  winnerShiftNumber: string;
  winnerSameDevice: boolean;
}
```

    `readQueue` читает `QUEUE_DISPLACED_SQL` в том же `Promise.all`. `dismissDisplacement`
    устроен как `dismissRecord`: `expectedChanges: 1`, `changes_mismatch` →
    `StaleQueueError("the displacement is resolved already")`.

- `QueueScreen.tsx`:
  - `Pending` получает `{ kind: "settleDisplaced"; conflictId: string }`, `NoticeKind` —
    `"settledDisplaced"`;
  - раздел «Вытесненные коды» после раздела «Конфликты» — тот же разметочный рисунок, что у
    конфликтов (`QueueScreen.tsx:485-515`);
  - кнопка «Разобрано» (`size="floor"`) с подтверждением `confirmSettleDisplaced` и тем же
    стражником `VIEW_GUARD_MS`;
  - запись: `dismissDisplacement` с `operator.id`, затем `onChanged()`.
- `outbox-status.ts`: `DISPLACED_COUNT_SQL = "SELECT count(*) AS n FROM floor_displacements
WHERE host_id = ? AND device_id = ? AND resolved_at IS NULL"`, четвёртый счёт в
  `readOutboxStatus`.
- `FloorStatusBar.tsx`: после пары «Конфликтов» (`:383-387`) — `outbox.displaced > 0`:
  `<dt>{t("floor.status.displaced")}</dt><dd>{formatQuantity(outbox.displaced)}</dd>`.

Тексты:

| Ключ                                  | Текст                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `floor.status.displaced`              | «Вытеснено кодов»                                                                                                                  |
| `floor.queue.displacedTitle`          | «Вытесненные коды»                                                                                                                 |
| `floor.queue.displacedNone`           | «Вытесненных кодов нет.»                                                                                                           |
| `floor.queue.displacedRecord`         | «Короб {{sscc}} · {{time}}»                                                                                                        |
| `floor.queue.displacedRecordOpen`     | «Короб без SSCC · {{time}}»                                                                                                        |
| `floor.queue.displacedReason`         | «Код из этого короба раньше отсканирован в смене {{number}}. На хосте он теперь там, а короб без него: проверьте короб.»           |
| `floor.queue.displacedReasonSame`     | «Код из этого короба раньше отсканирован этой станцией в смене {{number}}. На хосте короб без него: проверьте короб.»              |
| `floor.queue.confirmSettleDisplaced`  | «Отметить вытеснение разобранным? Запись останется в базе этого компьютера; станция запомнит, кто и когда отметил её разобранной.» |
| `floor.queue.notice.settledDisplaced` | «Вытеснение отмечено разобранным.»                                                                                                 |

- [ ] **Шаг 6: зелёные тесты** (экран очереди — два прогона по «Заметкам»), Rust-тесты
      оболочки (после сборки вебвью), typecheck, lint, prettier.

```bash
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/conflict-notices.test.ts test/host-link-notices.test.ts test/floor-conflict-notices-migration.test.ts test/floor-schema.test.ts test/floor-queue-screen.test.tsx test/outbox-recovery.test.ts test/floor-outbox-status.test.ts test/host-link-shifts.test.ts test/host-link-facts.test.ts test/host-link-restore.test.ts test/retention.test.ts
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-standalone --test local_db
```

Коммит: `feat(standalone): the station hears of the office's review and of its displaced scans`.

---

## Задача 9: документы и итоговые проверки

**Files:** Modify `apps/standalone/AGENTS.md`,
`docs/superpowers/specs/2026-10-13-standalone-office-parity-design.md`.

- [ ] **Шаг 1: `apps/standalone/AGENTS.md`.**
  - «Audit»: `conflict.review` — офисный пользователь, цель `code_conflict`, details `{ kind,
loserShiftId, loserDeviceId, winnerShiftId }` без хеша; повтор строки не пишет; берёт ревизию.
  - «Databases»: `0022` — `code_conflicts.kind` (заполнение по квитанции проигравшего),
    `reviewed_by` с `CHECK` «оба или ни одного», пять индексов и почему ни одного на `scans`.
  - «Facts», абзац о реестре (`:2987-3002`): «telling the displaced device and the office's review
    come with plan 2b» → каждая строка пишет `kind`; офис разбирает (КНФ); устройство узнаёт
    через `conflicts/status` и `displacements`. Упомянуть, что вытеснение ревизии не берёт.
  - Новый раздел «Conflicts and shift review» (после «Shift card and printed forms»):
    - маршруты, фильтр по смене проигравшего и почему;
    - страница «Конфликты» (адрес хранит фильтры), ссылка к коробу проигравшего через `?box=`
      до КРТ;
    - три раздела карточки и их пределы (500, страницы по 50);
    - что не попадает в «Отклонённые записи станции»;
    - предупреждение выгрузки (ПР-12).
  - «Shift exports»: в перечень предупреждений — `unreviewed_conflicts`.
  - Если задача 8 сделана:
    - «Local database»: `0016`, `outbox.office_reviewed_at`, `floor_displacements` (`DeviceData`,
      без срока хранения, курсор);
    - «Outbox recovery»: разбор офиса снимает конфликт (`resolved_by` NULL); раздел «Вытесненные
      коды»; четвёртый счёт строки состояния;
    - известные пределы: задержка вытеснения до ревизии; «Разобрано» станции до офиса не доходит.
  - «Verification»: что из этого проверено только в jsdom и `TestApp`.
- [ ] **Шаг 2: спецификация паритета.** В §8.1 у строки КНФ — «план исполнен <дата>, ветка …;
      станционная часть: сделана / отрезана». В §5.2 — примечание о действии «Создать документ
      дезагрегации из конфликта»: перенесено в ДЗГ-О.
- [ ] **Шаг 3: полный гейт** (раздел «Итоговая проверка плана»). Результаты и пропуски
      (`DATABASE_URL` автоному не нужен) — в отчёт. `graphify update .`, если в worktree есть
      `graphify-out/graph.json`.

Коммит: `docs(standalone): plan КНФ — conflicts and the review of a shift in AGENTS and the parity
spec`.

---

## Итоговая проверка плана

```bash
cargo fmt --manifest-path $WT/apps/standalone/Cargo.toml --all -- --check
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-proto
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-host
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path $WT/apps/standalone/Cargo.toml -p markiro-standalone
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --dir $WT --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
$WT/node_modules/.bin/prettier --check $(git -C $WT diff --name-only claude/integration -- '*.ts' '*.tsx' '*.json' '*.md')
git -C $WT diff --check
```

- Проверить: `git -C $WT diff --stat claude/integration` не затрагивает `Cargo.toml`,
  `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `apps/api`, `apps/admin`,
  `packages/*`.
- Применённые миграции не изменены: `git -C $WT diff claude/integration --
apps/standalone/host/migrations apps/standalone/src-tauri/migrations` показывает только новые
  файлы.
- Отчёт:
  - что изменилось в поведении;
  - файлы;
  - автоматические проверки с результатами;
  - что не проверялось на Windows, WebView2, двух станциях по сети и в ЛК ЧЗ.

## Проверки владельца

На Windows 10/11, с хостом на одном ПК и двумя станциями на других:

1. Станция Б отключена от сети (точка доступа выключена). Обе станции в своих сменах
   сканируют один и тот же КМ: сначала Б (офлайн), через минуту А (на связи). А закрывает короб.
   Связь Б возвращается. В офисе «Конфликты» показывает строку «Вытеснение…»:
   - проигравший — смена А, «Станция А», короб с SSCC;
   - победитель — смена Б;
   - код — GTIN и серийный, без криптохвоста.
2. Тот же КМ сканирует станция А ещё раз (поздний скан). Появляется строка «Поздний скан…», у
   проигравшего «Короб ещё открыт» или SSCC.
3. Ссылка «Короб проигравшего» открывает карточку смены А. В «Коробах» в фильтре стоит SSCC, и
   виден ровно этот короб. Мышью и клавиатурой (Tab, Enter): фильтры, страницы, кнопка «Отметить
   разобранным», видимый фокус, объявление после разбора.
4. «Отметить разобранным» технологом. Строка «Разобран», имя и время. В «Пользователях» →
   журнал (или база) — одна строка аудита `conflict.review`. Повторное нажатие из второго окна
   офиса ничего не дублирует.
5. Карточка смены А:
   - «Исключения» — отмена скана, расформирование короба с причиной и словами;
   - «Отклонённые записи станции» — запись, отказанная хостом (например, после восстановления
     хоста из копии);
   - «Конфликты» — сводка «Не разобрано: N из M» и ссылка «Все конфликты смены».
6. «Выгрузка» смены А с неразобранным конфликтом: предупреждение видно, файл формируется и
   сохраняется. После разбора предупреждения нет.
7. (Если задача 8 сделана.) На станции А строка состояния показывает «Вытеснено кодов: 1»,
   экран очереди — раздел «Вытесненные коды». «Разобрано» на станции снимает пометку. Станция Б
   с конфликтом позднего скана: после «Отметить разобранным» в офисе строка «Конфликтов»
   исчезает в течение нескольких секунд (Б на связи).
8. (Если задача 8 сделана.) Новая станция и старый хост (хост без задачи 7): работа
   и экран очереди без ошибок, в журнале станции нет повторяющихся отказов.

## Открытые вопросы

1. **Слова «разобран» или облачное «рассмотрен».** По умолчанию — «Отметить разобранным» /
   «Разобран», как на станции (Р11).
2. **Задержка вытеснения.** Станция узнаёт о вытеснении при следующей ревизии или
   переподключении, а не сразу. Можно брать ревизию в приёме фактов при вытеснении: это
   изменение `facts/mod.rs` и `registry.rs`, то есть отдельное решение. По умолчанию — задержка
   принимается.
3. **Открытый короб вытесненной станции.** Убирать ли код из `floor_codes`, чтобы открытый короб
   «досканировали» (облачная станция так делает для конфликтов, `apps/station/src/lib/sync.ts`
   около `:1977`)? По умолчанию — нет: офис разбирает короб, станция только показывает.
4. **«Разобрано» на станции → офис.** Отмечать ли конфликт разобранным на хосте, когда его
   разобрал оператор? По умолчанию — нет, как в облаке: разбор — решение офиса.
5. **Счёт вытеснений в строке состояния** отдельной строкой «Вытеснено кодов». По умолчанию —
   да. Альтернатива — прибавлять к «Конфликтов».

## Риски

- **Слияние с РЕЖ.** Обе ветки меняют `host/src/facts/registry.rs`: РЕЖ — `Claim.box_id:
Option<&str>`, КНФ — `conflict_row(…, kind, …)`. Конфликт текстовый, не логический. Миграция
  `0022` идёт после `0020`, которая перестраивает `scans`: в `0022` нет ни индекса, ни триггера
  на `scans`, а заполнение вида только читает `scans`. Запросы КНФ выдерживают `box_id = NULL`:
  `LEFT JOIN boxes`, «Без короба».
- **Слияние с «Поиском кодов» и ТОВ/ДЗГ.** Общие файлы — `server.rs`, `routes/mod.rs`, `ru.json`,
  `nav.ts`, `routes.tsx`, `office-query.ts`, `api.ts`, `test/support/office.tsx`. Конфликты
  только текстовые. Строку конфликта со временем стоит связать со ссылкой на карточку КМ
  «Поиска кодов» (`/codes/{codeHash}`) — это не входит в КНФ.
- **КРТ.** После слияния КРТ `loserBoxLink` должен вести на карточку короба. Пока это раздел
  карточки смены с фильтром: открытый короб без SSCC фильтром не найти.
- **Ревизия на разбор** будит потоки всех станций, и каждая читает ленту (пустую) и свои
  уведомления. Разборов единицы в день — нагрузка ничтожна.
- **Квитанции после восстановления хоста.** Восстановленный хост теряет конфликты после копии.
  Станция держит свои `floor_displacements`, а курсор может быть «впереди» хоста. Новые
  вытеснения после восстановления получат более позднее `detected_at`, так что ничего не
  теряется, но старые строки станции хост уже не знает: «Разобрано» в офисе для них невозможно,
  остаётся разбор на станции.
- **Ограничение 500 строк** в разделах карточки: после восстановления хоста отказов может быть
  тысячи. Офис говорит «Показаны последние 500 из N», полный список — только в базе.

## Не проверено

- Ничего не запускалось: план — документ.
- Имена существующих API проверены по коду ветки `claude/integration` `578906ef2`. Предположения,
  которые исполнитель подтверждает в шагах:
  - проп `hint` у `Select` в `@markiro/ui`;
  - `useSearchParams` в `react-router` 8.3;
  - нумерованные параметры `?1` в проверке оболочки;
  - точное имя `clock::parse_timestamp`;
  - `client.request("POST")` без тела;
  - поведение `OfficeContext` с ключом устройства без сессии;
  - перечни столбцов и индексов в `backup_schema.rs`/`restore.rs`.
- Не проверено, что `CHECK` в `ADD COLUMN` проверяется на существующих строках в сборке SQLite
  хоста. Тест миграции это закрепляет.
- Поведение на Windows, WebView2 и с двумя станциями по сети — только «Проверки владельца».

## Отклонения при исполнении

_(заполняет исполнитель)_
