# План ОЧ: очередь отправки станции — «Отправить снова», снятие с очереди, хранение отказов до разбора, запас номеров, честные сигналы доставки и «Вернула» по последней части — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Станция автонома даёт человеку разобрать всё, что хост не принял: экран «Очередь отправки» показывает неотправленное по видам, отклонённые записи с причиной словами и конфликты; «Отправить снова» ставит отклонённые записи смены заново (новые `id`, `data` байт в байт, прежний порядок `seq`), «Снять с очереди» / «Разобрано» закрывает запись без отправки — всегда по подтверждению и с отметкой, кто и когда. Пока отказ или конфликт не разобран, срок хранения не удаляет смену, а сверка после восстановления хоста не открывает разобранные записи снова. Строка состояния говорит о запасе номеров SSCC коробов и паллет на порогах 25 %, 10 % блока и на последнем номере, о блоках, которые хост выдал, а станция не приняла, и о записях прежнего подключения; счётчик попыток считает повторы, а не сканы; офис ставит «Вернула», только когда станция вернула последнюю часть блоков, и станции без блоков тоже.

**Architecture:**

- База станции: миграция оболочки `0013_outbox_recovery.sql` — четыре столбца `outbox` (`resolution`, `resent_as`, `resolved_at`, `resolved_by`) и таблица `floor_block_drops` (`TableClass::DeviceData`).
- Чтения и срок хранения: счётчики «Отклонено хостом» / «Конфликтов», список отказанных закрытий, сверка после восстановления (`REOPEN_SQL`) и срок хранения (`DUE_SHIFTS_SQL`, `DONE_WITH`) учитывают разбор; квитанция `accepted` снимает пометки конфликта скана и `needs_fix` короба.
- Новый модуль `src/floor/queue/outbox-recovery.ts` (чтения экрана, `resendRefused`, `dismissRecord`, `readStrandedRecords`) и экран `src/floor/queue/QueueScreen.tsx`; вход — кнопка «Очередь отправки» в списке смен (`ShiftList`), вид `queue` в `FloorApp`.
- Строка состояния (`FloorStatusBar`, `outbox-status.ts`): запас номеров по уровням (`readShiftStock`), пункт «Не отправлено прежним подключением», предупреждение о непринятых блоках (`readBlockDrops`).
- Доставка: `createBlockSupply` записывает непринятый блок в `floor_block_drops`; просьба экрана после записи не обрывает паузу после сбоя (`useHostLink`).
- Хост и протокол: `KnownBlocksRequest.more` (Rust `proto`, Zod, фикстура); `register_known_blocks` принимает пустой последний запрос и отмечает станцию только последним запросом; станция шлёт `more: true` во всех частях, кроме последней, и один пустой запрос без блоков; тексты офиса.
- Документы: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, раздел 27 спецификации пилота.

**Tech Stack:** TypeScript — React 19, Zod 4, Vitest 4 с jsdom, `node:sqlite` за `LocalExecutor` в тестах, `@testing-library/react`, `@markiro/ui` (`Alert`, `Button`, `Card`); Rust — axum, serde, sqlx 0.8 (хост и тесты оболочки).

**База и порядок:** поток MISC — **после ХП и I1**. ХП берёт миграцию оболочки `0010` (индексы по `shift_id` у `outbox`, `floor_exceptions`, `floor_pallet_exceptions`) и правит те же файлы, что задача 2 этого плана (`src/local/retention.ts`, `test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`, раздел «Local database» `AGENTS.md`); I1 правит разделы «Backups and restore» `AGENTS.md` и памятку о восстановлении, которые трогает задача 8. Исполнять на ветке потока MISC после слияния ХП и I1. Если ХП уже научил хост принимать пустой список известных блоков, задача 7 берёт его правку и добавляет только `more` (см. шаг 0 задачи 7). Фрагменты взяты из `claude/integration` на `2c726efba`; проверка на копии не делалась (порядок контроллера «максимальная скорость»): фрагмент, который не находится дословно, применяется по смыслу, расхождение — в «Отклонения при исполнении».

**Спецификации и источники пунктов:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §9.3 «Что добавляет пилот: план ОЧ» (экран «Очередь», предупреждения о запасе 25 % / 10 % / последний номер), §11 (восстановление), §24 (РК-С).
- `.superpowers/sdd/OWNER-DECISIONS.md` — «DECISIONS 2026-10-11» (делать всё отложенное; I1 = вариант 1: личность хоста в копии), п. 3 (N21: отказ `rejected` на полу ничего не помечает — видно число в строке состояния).
- Пункты плана, по источникам:
  1. «Отправить снова» отклонённых записей и их отклонённых зависимых, новые `id`, прежний порядок `seq`, по действию человека — `.superpowers/sdd/2a2-minors.md` п. 2, `2a2-task-2-review.md` (решение владельца 1), `2a2-final-review-report.md` Q2/Q15, `2a6-constraints.md` (экран очереди ОЧ), план 2a6 «Перенесено» п. 1, план 2a8 «Перенесено» п. 2 и `2a8-constraints.md` «Контракт для ПЛ-Ц и ОЧ» (ВП2: отказанное закрытие; запись в обход `outboxStatement`), `plc-constraints.md` «Контракт для ОЧ» (записи паллет), план ПЛ-Ц «Перенесено» п. 1.
  2. Безопасность поздней повторной отправки исключений (хост сверяет `targetScannedAt` и срез очистки) — `2a2-task-5-review.md`, `2a2-minors.md` п. 15.
  3. Отказы и конфликты удаляются сроком хранения через 30 дней — `2a8-addenda.md` M2, `2a8-task-7-review.md` п. 2, `2a8-final-review-report.md` (строка «Refused/conflicting records purged after 30 days (M2)»), `AGENTS.md` «Known limits of the retention», п. 2.
  4. Пометки конфликта не снимаются принятой квитанцией той же записи — план РК-С «Перенесено» п. 3, `rks-task-5-brief.md` п. 3.
  5. Счётчик попыток считает сканы без связи — `2a6-final-review-report.md` m8 и таблица (N22, «new m8 offline attempts»), `2a6-final-fix-report.md`. Частично снято РК-С: `rks-final-fix-report.md` §1 (отправка ждёт статуса `online`); остаётся N22 — просьба экрана обрывает паузу после сбоя.
  6. Молчаливый сброс пересекающегося блока — `2a6-final-review-report.md` m3 (N18 m1) и таблица, `2a6-final-fix-report.md` («reporting of the dropped overlap (ОЧ/2b)»), докстрока `createBlockSupply` («a screen for it belongs to the queue, plan ОЧ»).
  7. Предупреждения о запасе SSCC без хоста на 25 % / 10 % / последнем номере, запас паллет в строке состояния — план 2a6 «Перенесено» п. 2, `plc-constraints.md` ВЦ5, план ПЛ-Ц «Перенесено» п. 1, `plc-task-10-brief.md`, спецификация §9.3.
  8. «Вернула» ставится на первой части блоков — `rks-task-2-review.md` M2, `rks-final-review-report.md` таблица п. 18, `rks-final-fix-report.md` m5; станция без блоков навсегда «Не вернула» — `rks-task-2-review.md` M1, `rks-addenda.md`, план РК-С «Перенесено» п. 2, `rks-final-review-report.md` таблица п. 5/17.
  9. Строка о записях, оставшихся под прежним подключением — `rks-addenda.md` (T3 report), `rks-task-2-review.md` (Task 3, optional), `rks-final-review-report.md` I-3 и таблица п. 12, `progress.md` (РК-С Task 3: «I1 status line for stranded records NOT done»).

## Допущения

Контроллер решает вопросы владельцу как рекомендовано; здесь — решения планировщика с причинами (правка при другом ответе — в скобках):

- **О1 — «Отправить снова» действует на смену целиком.** Все неразобранные отклонённые записи смены уходят заново одним действием, в порядке `seq`, под новыми `id`, `data` байт в байт; так «отклонённые зависимые» (`box_unknown` после отказанного `box_closed`, отказанное закрытие после отказанного короба) идут с причиной без графа зависимостей. Поздняя отправка безвредна по правилам хоста: исключение снимает только позицию своего момента (`targetScannedAt`, срез очистки — `2a2-task-5-review.md`), короб, досланный после закрытия паллеты, присоединяется к ней (ПЛ-Х), запись после закрытия смены помечает смену поздней (2a2). (Поштучная отправка — правка задачи 3: `RESEND_READ_SQL` по `id`.)
- **О2 — только человек и только по подтверждению.** Ни один путь не шлёт отказ сам; кнопка открывает подтверждение с последствиями словами; в базе — `resolution`, `resolved_at`, `resolved_by` (оператор смены экрана). Роль оператора не проверяется: в автономе роль — свободный текст (`ref_operators.role`).
- **О3 — «Снять с очереди» есть у отказа и конфликта, кроме закрытия смены.** Отказанное закрытие только отправляется снова: снятое закрытие оставило бы смену «Закрывается» без объяснения; как и раньше, карточка смены называет отказ, а смену закрывает офис.
- **О4 — отказ и конфликт держат смену до разбора.** Срок хранения удаляет смену, только когда ни одна её запись `rejected`/`conflict` не ждёт разбора (новое условие `DUE_SHIFTS_SQL`/`DONE_WITH`); решение 31 (30 дней после принятого закрытия) остаётся для остального. Рост диска ограничен действием человека. «Карантина» у очереди станции нет: `sync_quarantine` — строки справочников, срок хранения их не трогает, менять нечего.
- **О5 — сверка после восстановления не открывает разобранное.** `REOPEN_SQL` пропускает записи с `resolved_at`: иначе отказ, уже отправленный снова под новым `id`, ушёл бы ещё раз под старым — хост получил бы один факт дважды.
- **О6 — принятая квитанция снимает пометки конфликта.** `accepted` скана сбрасывает `floor_scans.conflict`, а короб теряет `needs_fix`, когда ни один его скан не в конфликте (после повторной отправки РК-С). Пометки идут по `id` исходной записи: скан, отправленный снова под новым `id`, пометок на полу не меняет; его судьба видна на экране очереди.
- **О7 — попытки считают повторы.** РК-С уже не шлёт очередь, пока связь не `online`. ОЧ добавляет: просьба экрана после записи не обрывает паузу после сбоя — паузу заканчивает таймер (меняет поведение N22 плана 2a6). Выход на связь и ревизия по-прежнему шлют сразу.
- **О8 — непринятый блок хранится и виден.** Блок, пересекающийся с полученным, или не тот (другой префикс, расширение, перевёрнутый диапазон) пишется в `floor_block_drops` в транзакции, удаляющей запрос; строка состояния держит ошибку с числом до сброса подключения. Сброс по `validation_failed` (блока нет) не записывается.
- **О9 — пороги запаса по §9.3.** Уровни от размера самого нового блока того же префикса и расширения: ≤ 25 % — предупреждение, ≤ 10 % — сильнее, 1 номер — «последний», 0 — «закончились». Прежний порог `SERIALS_LOW = 100` уходит. Паллеты — только у смены с паллетами. При онлайн-связи правило половины пополняет на 50 %, поэтому пороги срабатывают без связи или без ответа хоста. (Другие числа — две константы задачи 5.)
- **О10 — «Вернула» по последней части.** `KnownBlocksRequest.more` (по умолчанию `false`, в JSON только `true`): хост отмечает `known_blocks_epoch`, только когда `more` нет; пустой список допустим только в последнем запросе — станция без блоков шлёт один пустой запрос и тоже получает «Вернула». Старый запрос без поля — последний, как и раньше. Порядок блоков (`received_at`) не меняется.
- **О11 — записи прежнего подключения.** Пассивный пункт строки состояния «Не отправлено прежним подключением: N» (только при N > 0) и абзац на экране очереди со словами, что делать. При I1 = вариант 1 восстановление на новом ПК сохраняет подключение, поэтому строка появляется только после сброса подключения с «Сбросить всё равно» или нового подключения станции, которой нет в копии. Отправка таких записей — вне плана (I1 вариант 2).
- **О12 — вход с экрана смен, не из строки состояния.** §9.3 говорит «вход из строки состояния», но строка по правилу 1f2/2a5 «holds nothing to press»; кнопка «Очередь отправки» стоит рядом с «Рабочее место» в списке смен. §9.3 говорит «только чтение» — приказ владельца 2026-10-11 и решение 2a2 (повтор — действие человека на экране очереди) делают экран действующим. Обе правки записаны в §27.
- **О13 — номера.** Миграция оболочки `0013` (распределение контроллера); миграция хоста `0014`, закреплённая за ОЧ, не нужна — схема хоста не меняется. Раздел спецификации — 27. Если к исполнению A4/WH не взяли `0011`/`0012`, номер `0013` всё равно остаётся (sqlx применяет недостающие версии по порядку; тесты номер не считают подряд).

## Шаги владельца

Новых зависимостей нет: `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются. Для приёмки (вне автоматических проверок): ПК с Windows 10/11 и сенсорной панелью — экран очереди, касания ≥ 64 px, отказ, вызванный остановкой хоста с отказом, и «Отправить снова» после устранения причины.

## Global Constraints

**Приказ владельца и решения спецификаций**

1. Доделать всё отложенное (OWNER-DECISIONS, «DECISIONS 2026-10-11»); максимальная скорость: задача исполняется отдельно, со свежим контекстом, проверяема сама.
2. Отказ хранится на хосте навсегда; та же запись — та же квитанция (2a, §4.4); под тем же `id` отказ не отправляется никогда; повтор — новые `id`, `data` байт в байт, прежний порядок `seq`, вместе с отклонёнными зависимыми (2a2, решение владельца 1).
3. Повтор — видимое действие человека, никогда не молчаливое и не автоматическое (приказ контроллера для ОЧ; 2a6 «Перенесено» п. 1).
4. Неизвестный исход печати никогда не повторяется сам (2a7) — ОЧ печать не трогает.
5. Станция работает без хоста; запись очереди и факт — одной `local_transaction` (2a, решение 11); очередь никогда не пропускает запись (AGENTS «Floor work»).
6. Квитанции — одна транзакция (`receiptStatements`); ОЧ добавляет в неё два оператора и ничего не убирает.
7. Пороги запаса: 25 % и 10 % блока, последний номер (спецификация §9.3).
8. N21: отказ на полу ничего не помечает; видно число в строке состояния (OWNER-DECISIONS п. 3).

**Код и процесс**

- Правила `apps/standalone/AGENTS.md`: «Local database» (только `local_query`/`local_transaction`, класс каждой таблицы в `TABLE_CLASSES`, без внешних ключей), «Writes» (дисциплина очереди работ N9/N13 — экран очереди пишет вне очереди работ рабочего экрана: он открыт только из списка смен, когда работы смены нет), i18n — строки в `ru.json`, ключи уникальны.
- Каждый новый оператор над растущей таблицей закреплён планом запроса в `test/floor-schema.test.ts` (Node SQLite 3.53) и в `src-tauri/tests/local_db.rs` (`the_floors_repeating_reads_search_an_index`, SQLite оболочки 3.46), текст — одинаковый в обоих (тест сверки текстов).
- Фикстуры `proto/fixtures` — общие для Rust и Zod; новое поле — в обоих и в фикстуре.
- Применённые миграции не правятся (оболочка `0001`–`0010`, хост `0001`–`0012`).
- Доступность: семантические кнопки, видимый фокус, подтверждение получает фокус, текст ошибок словами, касание ≥ 64 px (`Button size="floor"`).
- Тесты React: прогон с `--reporter=verbose` без предупреждений `act(...)` и под стендом с отложенным `setImmediate` (как в планах 2a8, ПЛ-Ц, РК-С: временный файл настройки **вне дерева**, `setImmediate` через `setTimeout(…, 3)`); после коммита `git status --short` пуст.
- Коммиты — явные пути, сообщение из файла, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены; `git stash` запрещён.

## Заметки для исполнения

- «Фрагмент … заменить на …» дан так, как стоит в `claude/integration` на `2c726efba`; после ХП/I1 и соседних задач соседний текст мог сдвинуться — применять по смыслу и записывать расхождение.
- «Создать» — новый файл ровно как в блоке, с переводом строки в конце.
- Команды — из корня рабочего дерева потока. Vitest: `pnpm --filter @markiro/standalone exec vitest run <файлы>`. Cargo: `cargo test --manifest-path apps/standalone/Cargo.toml -p <пакет> --test <файл>` (пакеты `markiro-standalone`, `markiro-host`, `markiro-proto`; если имя пакета другое — взять из `Cargo.toml` и записать). В песочнице cargo-тесты оболочки могут падать на `sysctl EPERM` — запускать вне песочницы.
- В свежем дереве сначала `pnpm turbo run build --filter='@markiro/standalone^...'`.
- Массив `reads` в `the_floors_repeating_reads_search_an_index` имеет тип `[(&str, &str); N]`: после добавления записей поправить `N`.
- Перед каждой задачей — `git status --short` пуст; после — `git diff --check`, `node_modules/.bin/prettier --ignore-path .prettierignore --check <изменённые файлы>`, `pnpm --filter @markiro/standalone typecheck`, `pnpm --filter @markiro/standalone lint`.

## Файлы

- Create: `apps/standalone/src-tauri/migrations/0013_outbox_recovery.sql`, `apps/standalone/src/floor/queue/outbox-recovery.ts`, `apps/standalone/src/floor/queue/QueueScreen.tsx`, `apps/standalone/test/outbox-recovery.test.ts`, `apps/standalone/test/floor-queue-screen.test.tsx`, `apps/standalone/proto/fixtures/known-blocks-request-more.json`.
- Modify (вебвью): `src/local/facts-sender.ts`, `src/local/retention.ts`, `src/local/restore-reconcile.ts`, `src/floor/outbox-status.ts`, `src/floor/close/shift-close.ts`, `src/floor/FloorStatusBar.tsx`, `src/floor/FloorApp.tsx`, `src/floor/shifts/ShiftList.tsx`, `src/floor/work/block-supply.ts`, `src/app/host-link.ts`, `src/host/backups.ts`, `src/office/backups/BackupsPage.tsx` (только если меняется разметка), `src/i18n/ru.json`.
- Modify (Rust): `src-tauri/src/local_db.rs` (`TABLE_CLASSES`), `proto/src/backup.rs`, `host/src/routes/known_blocks.rs`.
- Tests: `test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`, `test/floor-outbox-status.test.ts`, `test/retention.test.ts`, `test/restore-reconcile.test.ts`, `test/facts-sender.test.ts`, `test/floor-status-bar.test.tsx`, `test/floor-shift-list.test.tsx`, `test/floor-app.test.tsx`, `test/floor-block-supply.test.ts`, `test/host-link-facts.test.ts`, `test/host-link-restore.test.ts`, `test/backups.test.ts`, `test/backups-page.test.tsx`, `proto/tests/backup.rs`, `host/tests/known_blocks.rs`.
- Docs: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (§27).

(Пути вебвью и Rust — от `apps/standalone/`.)

---

### Task 1: Миграция `0013` — разбор записей очереди и непринятые блоки

Схема без поведения: четыре столбца `outbox` для разбора отказа или конфликта человеком и таблица непринятых блоков. Старые записи получают `NULL` во всех новых столбцах; таблица — данные устройства, сброс подключения её сохраняет.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0013_outbox_recovery.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs`
- Test: `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/test/floor-schema.test.ts`

**Interfaces:**

- Produces: `outbox.resolution TEXT CHECK (NULL | 'resent' | 'dismissed')`, `outbox.resent_as TEXT`, `outbox.resolved_at TEXT`, `outbox.resolved_by TEXT`; таблица `floor_block_drops(host_id, device_id, block_id, request_id, issuer_prefix, extension, from_serial, to_serial, reason CHECK ('overlap' | 'mismatch'), dropped_at)`, ключ `(host_id, device_id, block_id)`, `TableClass::DeviceData`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/test/floor-schema.test.ts` в массив `DEVICE_TABLES` добавить `"floor_block_drops",` первой строкой (порядок по алфавиту). Если в тесте списка индексов (`isUnique`/`isPartial`) перечислены и автоиндексы ключей, добавить автоиндекс `floor_block_drops`.

2. Там же, в конец `describe("the rules of the production tables the first examples leave open", …)`, добавить:

<!-- prettier-ignore -->
```typescript
  it("take a person's resolution of a refused or conflicting record, and no other word (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "outcome_code, acked_at) VALUES ('r-1', ?, ?, 'scan', 'shift-1', '{}', ?, 'rejected', " +
        "'not_entered', ?)",
    ).run(HOST_ID, DEVICE_ID, AT, AT);
    expect(
      db
        .prepare("SELECT resolution, resent_as, resolved_at, resolved_by FROM outbox")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([{ resolution: null, resent_as: null, resolved_at: null, resolved_by: null }]);
    for (const resolution of ["resent", "dismissed"]) {
      await accepted(executor, {
        sql: "UPDATE outbox SET resolution = ?, resolved_at = ?, resolved_by = 'op-1' WHERE id = 'r-1'",
        values: [resolution, AT],
      });
    }
    await refused(executor, {
      sql: "UPDATE outbox SET resolution = 'forgotten' WHERE id = 'r-1'",
    });
  });

  it("keep a block the station did not take with its reason, once per pairing (plan ОЧ)", async () => {
    const { executor } = openLocalDb();
    const drop = (blockId: string, reason: string, deviceId = DEVICE_ID): LocalStatement => ({
      sql:
        "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, ?, 'req-1', " +
        "'460068200', 0, 5499, 3500, ?, ?)",
      values: [HOST_ID, deviceId, blockId, reason, AT],
    });
    // An inverted range is what such a row may hold: no CHECK on the serials.
    await accepted(executor, drop("block-1", "mismatch"));
    await accepted(executor, drop("block-2", "overlap"));
    await accepted(executor, drop("block-1", "overlap", OTHER_DEVICE));
    await refused(executor, drop("block-1", "overlap"));
    await refused(executor, drop("block-3", "lost"));
  });
```

`accepted`/`refused` — помощники этого файла (транзакция проходит / падает с `statement_failed`); если их имена другие, взять имеющиеся.

3. В `apps/standalone/src-tauri/tests/local_db.rs` после `migration_0009_keeps_the_rows_of_a_database_of_0008` добавить:

<!-- prettier-ignore -->
```rust
/// Migration `0013` over a station's database of the migrations before it that holds a refused
/// record: the record stays as it was with no resolution, a resolution takes only `resent` or
/// `dismissed`, and the table of the blocks the station did not take exists and is the device's
/// own data (plan ОЧ, additive).
#[tokio::test]
async fn migration_0013_keeps_the_outbox_and_adds_its_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < 13)
        .cloned()
        .collect();
    assert!(before.iter().any(|migration| migration.version == 9));
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(before),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, outcome_code, acked_at) VALUES ('record-1', 'host', 'device', 'scan', \
         'shift-1', '{}', '2026-10-09T08:00:00.000Z', 'rejected', 'not_entered', \
         '2026-10-09T08:00:05.000Z')",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();

    let db = LocalDb::open(dir.path()).await.unwrap();
    let records = db
        .query(
            "SELECT id, outcome, outcome_code, resolution, resent_as, resolved_at, resolved_by \
             FROM outbox",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(records.into_iter().map(Value::Object).collect()),
        json!([{
            "id": "record-1", "outcome": "rejected", "outcome_code": "not_entered",
            "resolution": null, "resent_as": null, "resolved_at": null, "resolved_by": null
        }])
    );
    assert!(db
        .transaction(vec![expecting(
            "UPDATE outbox SET resolution = 'later' WHERE id = 'record-1'",
            1,
        )])
        .await
        .is_err());
    db.transaction(vec![expecting(
        "UPDATE outbox SET resolution = 'dismissed', resolved_at = '2026-10-11T08:00:00.000Z', \
         resolved_by = 'op-1' WHERE id = 'record-1'",
        1,
    )])
    .await
    .unwrap();
    assert_eq!(count(&db, "floor_block_drops").await, json!(0));
    assert_eq!(
        markiro_standalone::local_db::table_class("floor_block_drops"),
        Some(markiro_standalone::local_db::TableClass::DeviceData)
    );
}
```

`expecting(sql, n)`, `count(&db, table)`, `FILE_NAME`, `MIGRATOR`, `LocalDb` — помощники и импорты этого файла (взять их настоящие сигнатуры: если `expecting` принимает только SQL, ожидание задаётся так, как в соседних тестах); путь к `table_class`/`TableClass` — как его импортируют соседние тесты.

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-schema.test.ts` и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db migration_0013`
Expected: FAIL — `no such table: floor_block_drops`, `no such column: resolution`; Rust — нет столбцов и класса.

- [ ] **Step 3: Миграция и класс таблицы**

1. Создать `apps/standalone/src-tauri/migrations/0013_outbox_recovery.sql`:

```sql
-- Plan ОЧ: a person resolves what the host did not take. A record the host
-- refused (`rejected`) or found in conflict (`conflict`) stays in the outbox
-- until someone resolves it on the queue screen: `resent` — the refused record
-- went again under a new id (`resent_as` names the record that carries it, data
-- byte for byte); `dismissed` — a person took it off the queue without sending
-- it. Who did it and when: `resolved_by` (the operator's id), `resolved_at` (UTC
-- RFC 3339 as `Date.toISOString` writes it). The retention keeps a shift while
-- any of its refused or conflicting records is unresolved, and the
-- reconciliation after a restore of the host (plan РК-С) leaves a resolved
-- record settled. Every record written before this migration, and every one
-- the host accepted, has NULL in all four.
ALTER TABLE outbox ADD COLUMN resolution TEXT
  CHECK (resolution IS NULL OR resolution IN ('resent', 'dismissed'));
ALTER TABLE outbox ADD COLUMN resent_as TEXT;
ALTER TABLE outbox ADD COLUMN resolved_at TEXT;
ALTER TABLE outbox ADD COLUMN resolved_by TEXT;

-- The blocks of SSCC serials the host gave this station that the station did
-- not keep (plan ОЧ; plan 2a6 dropped them silently): one that shares a serial
-- with a block the station holds — a host whose counter went back, restored or
-- reinstalled without its copy — or one that is not the block asked for
-- (another prefix or extension, an inverted range). The floor's status bar
-- counts the pairing's rows; each keeps what the host sent, for support. No
-- CHECK on the serials: a block that is not one is exactly what may be kept.
-- One row per block and pairing; no foreign key (see `0006`); a forget keeps
-- them (`TableClass::DeviceData`).
CREATE TABLE floor_block_drops (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL,
  from_serial INTEGER NOT NULL,
  to_serial INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('overlap', 'mismatch')),
  dropped_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, block_id)
);
```

2. В `apps/standalone/src-tauri/src/local_db.rs`, фрагмент

```rust
    ("floor_block_requests", TableClass::DeviceData),
```

заменить на

```rust
    ("floor_block_drops", TableClass::DeviceData),
    ("floor_block_requests", TableClass::DeviceData),
```

- [ ] **Step 4: Запустить — должны пройти**

Run: те же команды шага 2, затем `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db` целиком и `pnpm --filter @markiro/standalone exec vitest run test/floor-schema.test.ts test/local-executor.test.ts`
Expected: PASS. Тест, который сверяет каждую таблицу базы с `TABLE_CLASSES`, проходит с новой строкой.

- [ ] **Step 5: Коммит**

```bash
git add apps/standalone/src-tauri/migrations/0013_outbox_recovery.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/test/floor-schema.test.ts
git commit -F "$TMPDIR/och-1.txt"
```

Сообщение: `feat(standalone): the outbox keeps a person's resolution of a refused record, and the station keeps the blocks it did not take (plan ОЧ, migration 0013)` + пустая строка + трейлер.

---

### Task 2: Отказ ждёт человека — счётчики, отказанные закрытия, сверка и срок хранения учитывают разбор; принятая квитанция снимает пометки конфликта

**Files:**

- Modify: `apps/standalone/src/floor/outbox-status.ts`, `apps/standalone/src/floor/close/shift-close.ts`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/src/local/retention.ts`, `apps/standalone/src/local/facts-sender.ts`
- Test: `apps/standalone/test/floor-outbox-status.test.ts`, `apps/standalone/test/retention.test.ts`, `apps/standalone/test/restore-reconcile.test.ts`, `apps/standalone/test/facts-sender.test.ts`, `apps/standalone/test/floor-schema.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`

**Interfaces:**

- Consumes: столбцы задачи 1; индекс ХП `outbox (host_id, device_id, shift_id)` (имя — как у ХП).
- Produces: тексты `REJECTED_COUNT_SQL`, `CONFLICT_COUNT_SQL`, `REFUSED_CLOSES_SQL`, `REOPEN_SQL`, `DUE_SHIFTS_SQL`, `PURGE_COPY_SQL` с условием разбора; `receiptStatements` — шесть операторов (новые 4-й и 5-й).

- [ ] **Step 1: Тесты — сначала они**

1. `apps/standalone/test/floor-outbox-status.test.ts`, в конец файла:

<!-- prettier-ignore -->
```typescript
describe("resolved records (plan ОЧ)", () => {
  it("count neither as refused nor as in conflict once a person resolved them", async () => {
    const { db, executor } = openLocalDb();
    put(db, PAIRING, 3, "rejected");
    put(db, PAIRING, 2, "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = '2026-10-11T08:00:00.000Z', " +
        "resolved_by = 'op-1' WHERE id IN (SELECT id FROM outbox WHERE outcome = 'rejected' " +
        "ORDER BY seq LIMIT 2) OR id IN (SELECT id FROM outbox WHERE outcome = 'conflict' " +
        "ORDER BY seq LIMIT 1)",
    ).run();
    await expect(readOutboxStatus(executor, PAIRING)).resolves.toEqual({
      unsent: 0,
      rejected: 1,
      conflicts: 1,
    });
  });
});
```

2. `apps/standalone/test/facts-sender.test.ts`: импорт `readRefusedCloses` уже есть. Добавить в `describe("a batch of the outbox", …)` после теста «marks a conflict of a scan that has no box on the scan alone»:

<!-- prettier-ignore -->
```typescript
  it("takes the conflict off a scan and its box once the same record is accepted, and keeps the box marked while another scan of it is in conflict (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    const newId = countingIds();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift, { newId });
    await processScan(context, km("A1"));
    await processScan(context, km("A2"));
    await processScan(context, km("A3"));
    const ids = rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) => String(row["id"]));
    const [first = "", second = "", third = ""] = ids;
    await sendFactBatch(
      executor,
      PAIRING,
      vi.fn(async (): Promise<FactReceipt[]> => [
        { id: first, outcome: "conflict", details: { winner: WINNER } },
        { id: second, outcome: "conflict", details: { winner: WINNER } },
        { id: third, outcome: "accepted" },
      ]),
      steppingClock(),
    );
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    // A restore of the host sends the two again (plan РК-С); the restored host takes the first.
    db.prepare(
      "UPDATE outbox SET outcome = NULL, outcome_code = NULL, outcome_details = NULL, " +
        "acked_at = NULL WHERE id IN (?, ?)",
    ).run(first, second);
    await sendFactBatch(
      executor,
      PAIRING,
      vi.fn(async (): Promise<FactReceipt[]> => [
        { id: first, outcome: "accepted" },
        { id: second, outcome: "conflict", details: { winner: WINNER } },
      ]),
      steppingClock(),
    );
    expect(rows(db, "SELECT id FROM floor_scans WHERE conflict = 1")).toEqual([{ id: second }]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 1 }]);
    db.prepare(
      "UPDATE outbox SET outcome = NULL, outcome_code = NULL, outcome_details = NULL, " +
        "acked_at = NULL WHERE id = ?",
    ).run(second);
    await sendFactBatch(executor, PAIRING, acceptingAll(), steppingClock());
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans WHERE conflict = 1")).toEqual([
      { n: 0 },
    ]);
    expect(rows(db, "SELECT needs_fix FROM floor_boxes")).toEqual([{ needs_fix: 0 }]);
  });

  it("names no refused close a person resolved (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift, { newId: countingIds() });
    const result = await closeShift(context, null);
    expect(result.kind).toBe("closed");
    db.prepare(
      "UPDATE outbox SET outcome = 'rejected', outcome_code = 'box_state', acked_at = ? " +
        "WHERE kind = 'shift_closed'",
    ).run("2026-10-11T08:00:00.000Z");
    expect([...(await readRefusedCloses(executor, PAIRING)).keys()]).toEqual([SHIFT_ID]);
    db.prepare(
      "UPDATE outbox SET resolution = 'resent', resent_as = 'x', resolved_at = ?, " +
        "resolved_by = 'op-1' WHERE kind = 'shift_closed'",
    ).run("2026-10-11T08:01:00.000Z");
    expect((await readRefusedCloses(executor, PAIRING)).size).toBe(0);
  });
```

Если `closeShift(context, null)` в этом файле требует причину для неполного плана, взять вызов из соседнего теста «makes the station's close closed once the host takes it…».

3. `apps/standalone/test/restore-reconcile.test.ts`, в `describe` с тестом «takes the records of the window and no other…» добавить:

<!-- prettier-ignore -->
```typescript
  it("leaves a record a person resolved settled: a refusal sent again or taken off goes no second time (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    const [resent = "", dismissed = "", open = ""] = await unsentScans(executor, 3);
    const inWindow = new Date(NOW.getTime() - 60_000).toISOString();
    db.prepare(
      "UPDATE outbox SET outcome = 'rejected', outcome_code = 'not_entered', acked_at = ?",
    ).run(inWindow);
    db.prepare(
      "UPDATE outbox SET resolution = 'resent', resent_as = 'y', resolved_at = ?, " +
        "resolved_by = 'op-1' WHERE id = ?",
    ).run(inWindow, resent);
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = 'op-1' " +
        "WHERE id = ?",
    ).run(inWindow, dismissed);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await reconcileRestore({ local: executor, pairing: PAIRING, register: answering(), now: () => NOW });
    expect(rows(db, "SELECT id, outcome FROM outbox ORDER BY seq")).toEqual([
      { id: resent, outcome: "rejected" },
      { id: dismissed, outcome: "rejected" },
      { id: open, outcome: null },
    ]);
  });
```

`answering()` — помощник файла. (После задачи 7 запрос без блоков — один пустой; этому тесту всё равно.)

4. `apps/standalone/test/retention.test.ts`, в `describe` с тестами `purgeAcknowledged` добавить:

<!-- prettier-ignore -->
```typescript
  it("keeps a shift while a refused or conflicting record of it waits for a person, and purges it once each is resolved (plan ОЧ)", async () => {
    const at = await printStation();
    await finished(at, ENTERED, "01", "2026-10-01T12:00:00.000Z");
    const scans = rows(
      at.db,
      "SELECT id FROM outbox WHERE shift_id = ? AND kind = 'scan' ORDER BY seq",
      ENTERED.id,
    ).map((row) => String(row["id"]));
    const [refusedScan = "", conflictScan = ""] = scans;
    at.db
      .prepare("UPDATE outbox SET outcome = 'rejected', outcome_code = 'gtin_mismatch' WHERE id = ?")
      .run(refusedScan);
    at.db.prepare("UPDATE outbox SET outcome = 'conflict' WHERE id = ?").run(conflictScan);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    const resolve = at.db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = 'op-1' WHERE id = ?",
    );
    resolve.run("2026-10-02T12:00:00.000Z", refusedScan);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(0);
    resolve.run("2026-10-02T12:00:00.000Z", conflictScan);
    expect(await purgeAcknowledged(at.local, PAIRING, NOW)).toBe(1);
    expect(kept(at, ENTERED.id)["floor_shifts"]).toBe(0);
  });
```

Если `finished` пишет меньше двух сканов, второй отказ взять из записи другого вида той же смены (`kind <> 'shift_closed'`).

5. `apps/standalone/test/floor-schema.test.ts`: тексты меняются, а ожидания планов — нет, кроме `DUE_SHIFTS_SQL`. В тесте, где `const due = plan(DUE_SHIFTS_SQL).split("\n");`, после строки `expect(due.filter((step) => step.includes("TEMP"))).toEqual(["USE TEMP B-TREE FOR DISTINCT"]);` добавить:

<!-- prettier-ignore -->
```typescript
    // The unresolved refusals of a due shift (plan ОЧ) are found by the shift's key, never by a scan.
    expect(due.filter((step) => step.startsWith("SCAN "))).toEqual([]);
```

Если подзапрос `r` берёт `outbox_settled`, ожидание `due.filter((step) => step.includes("outbox_settled"))).toHaveLength(1)` поправить на фактическое (2) с комментарием и записать в отклонения; первый шаг (`due[0]`) должен остаться обходом `outbox_settled` по `o`.

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-outbox-status.test.ts test/facts-sender.test.ts test/restore-reconcile.test.ts test/retention.test.ts`
Expected: FAIL — счётчики `rejected: 3, conflicts: 2`; конфликт не снят (`needs_fix: 1`); разобранное закрытие названо; сверка открыла разобранные; смена удалена при неразобранном отказе (`1`, ожидалось `0`).

- [ ] **Step 3: Реализация**

1. `apps/standalone/src/floor/outbox-status.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export const REJECTED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'rejected'";
export const CONFLICT_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict'";
```

заменить на

<!-- prettier-ignore -->
```ts
// A record a person resolved on the queue screen (plan ОЧ) is no longer counted.
export const REJECTED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'rejected' " +
  "AND resolved_at IS NULL";
export const CONFLICT_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict' " +
  "AND resolved_at IS NULL";
```

2. `apps/standalone/src/floor/close/shift-close.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  "AND kind = 'shift_closed' AND outcome = 'rejected' ORDER BY seq";
```

заменить на

<!-- prettier-ignore -->
```ts
  "AND kind = 'shift_closed' AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";
```

и в докстроке `readRefusedCloses` после «and the office closes it on the host.» дописать: « A refused close sent again from the queue screen (plan ОЧ) is resolved and no longer named; its new record waits like any other.»

3. `apps/standalone/src/local/restore-reconcile.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  "acked_at = NULL WHERE host_id = ? AND device_id = ? AND outcome IS NOT NULL AND acked_at >= ?";
```

заменить на

<!-- prettier-ignore -->
```ts
  "acked_at = NULL WHERE host_id = ? AND device_id = ? AND outcome IS NOT NULL AND acked_at >= ? " +
  "AND resolved_at IS NULL";
```

и в докстроку `REOPEN_SQL` дописать: «A record a person resolved (plan ОЧ) stays settled: a refusal sent again under a new id would otherwise reach the host twice, and one taken off was meant never to go.»

4. `apps/standalone/src/local/retention.ts`:

Фрагмент

<!-- prettier-ignore -->
```ts
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
```

заменить на

<!-- prettier-ignore -->
```ts
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = s.host_id " +
  "AND r.device_id = s.device_id AND r.shift_id = s.id " +
  "AND r.outcome IN ('rejected', 'conflict') AND r.resolved_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
```

Фрагмент

<!-- prettier-ignore -->
```ts
  "AND u.device_id = o.device_id AND u.shift_id = o.shift_id AND u.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = o.host_id " +
```

заменить на

<!-- prettier-ignore -->
```ts
  "AND u.device_id = o.device_id AND u.shift_id = o.shift_id AND u.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = o.host_id " +
  "AND r.device_id = o.device_id AND r.shift_id = o.shift_id " +
  "AND r.outcome IN ('rejected', 'conflict') AND r.resolved_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = o.host_id " +
```

В докстроке `DONE_WITH` после «every record of the shift has its receipt,» вставить «no refused or conflicting record of it waits for a person (plan ОЧ: a refusal leaves the station only when someone resolved it on the queue screen),».

5. `apps/standalone/src/local/facts-sender.ts`, в `receiptStatements` фрагмент

<!-- prettier-ignore -->
```ts
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? " +
```

заменить на

<!-- prettier-ignore -->
```ts
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    // An accepted scan was answered `conflict` before (a restore sent it again,
    // plan РК-С): its mark goes, and its box's once no scan of it is in conflict.
    {
      sql:
        "UPDATE floor_scans SET conflict = 0 WHERE +host_id = ? AND +device_id = ? AND conflict = 1 " +
        "AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')",
      values: [hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 " +
        "AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? " +
        "AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) " +
        "WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) " +
        "AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id " +
        "AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id " +
        "AND c.box_id = floor_boxes.id AND c.conflict = 1)",
      values: [hostId, deviceId, hostId, deviceId, answers],
    },
    {
      sql:
        "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? " +
```

В докстроке `receiptStatements` «the marks a `conflict` of a scan leaves on the scan and on its box,» дополнить «and takes off again once the same record is accepted (plan ОЧ),»; в докстроке `sendFactBatch` после «(`floor_scans.conflict`, `floor_boxes.needs_fix`);» вставить «an `accepted` of a scan in conflict before clears both (plan ОЧ);».

6. `apps/standalone/src-tauri/tests/local_db.rs`:
   - в `reads`: тексты счётчиков `outcome = 'rejected'` / `outcome = 'conflict'` дописать `AND resolved_at IS NULL` (как в п. 1, через продолжение строки `\`);
   - после записи `UPDATE floor_boxes SET needs_fix = 1 …` с `sqlite_autoindex_floor_scans_1 (id=?)` добавить три записи:

```rust
        // Plan ОЧ: an accepted scan takes its conflict off, and its box's mark once no scan of it
        // is in conflict; each by the records' own key, the box's other scans by its shift.
        (
            "UPDATE floor_scans SET conflict = 0 WHERE +host_id = ? AND +device_id = ? AND conflict = 1 \
             AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')",
            "sqlite_autoindex_floor_scans_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 \
             AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) \
             AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id \
             AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id \
             AND c.box_id = floor_boxes.id AND c.conflict = 1)",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 \
             AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) \
             AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id \
             AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id \
             AND c.box_id = floor_boxes.id AND c.conflict = 1)",
            "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
```

- константы `DUE_SHIFTS`, `PURGE_COPY`, `REFUSED_CLOSES`, `RESTORE_REOPEN` переписать новыми текстами (дословно, как в п. 2–4; продолжения строк — по месту); у `DUE_SHIFTS` добавить запись ожидания индекса подзапроса `r` (индекс ХП по `shift_id` или `outbox_settled` — тот, что называет план 3.46);
- поправить `N` в типе массива.

Если план 3.46 для нового оператора называет другой индекс — закрепить фактический с комментарием и записать в отклонения; `SCAN floor_scans` недопустим.

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2, затем `pnpm --filter @markiro/standalone exec vitest run test/floor-schema.test.ts test/floor-status-bar.test.tsx test/floor-shift-list.test.tsx test/app.test.tsx` и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS. Тест сверки текстов («are pinned on the shell's SQLite with the sender's own statements» и соседние) находит новые тексты в `local_db.rs`.

Мутации (каждую вернуть, `git diff` пуст): (a) убрать `AND resolved_at IS NULL` из `REOPEN_SQL` — падает тест сверки; (b) убрать новое `NOT EXISTS … r …` из `DUE_SHIFTS_SQL` — падает тест срока хранения; (c) убрать `AND c.conflict = 1` из 5-го оператора — падает тест квитанций.

- [ ] **Step 5: Коммит**

Пути: пять файлов `src/…` и шесть тестов задачи. Сообщение: `feat(standalone): a refusal or conflict waits for a person — counts, refused closes, the restore's reopen and the retention honour its resolution, and an accepted receipt takes a conflict off (plan ОЧ)` + трейлер.

---

### Task 3: Модуль очереди — чтения экрана, «Отправить снова», «Снять с очереди», записи прежнего подключения

Без экрана: всё над базой станции, проверяется на `node:sqlite`.

**Files:**

- Create: `apps/standalone/src/floor/queue/outbox-recovery.ts`, `apps/standalone/test/outbox-recovery.test.ts`
- Test: `apps/standalone/test/floor-schema.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`

**Interfaces:**

- Consumes: `factRecordSchema` (`src/host/protocol.ts`), `LocalExecutor`, `LocalDbError`, `Pairing`; столбцы задачи 1; правило задачи 2.
- Produces (`src/floor/queue/outbox-recovery.ts`): `RESEND_CHUNK = 50`; SQL-константы `QUEUE_UNSENT_SQL`, `QUEUE_SETTLED_SQL`, `RESEND_READ_SQL`, `RESEND_INSERT_SQL`, `RESEND_MARK_SQL`, `DISMISS_SQL`, `STRANDED_COUNT_SQL`; типы `UnsentKind { kind; count; oldest }`, `SettledRecord { id; seq; kind; shiftId; shiftNumber: string | null; createdAt; outcome: "rejected" | "conflict"; code: string | null; sscc: string | null }`, `QueueView { unsent; settled; stranded }`, `RecoveryContext { local; pairing; operatorId; newId; now }`; классы `StaleQueueError`, `UnreadableRecordError` (`recordId`); функции `readQueue(local, pairing): Promise<QueueView>`, `resendRefused(context, shiftId): Promise<number>`, `dismissRecord(context, recordId): Promise<void>`, `readStrandedRecords(local, pairing): Promise<number>`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/outbox-recovery.test.ts`:

<!-- prettier-ignore -->
```typescript
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { outboxStatement, shiftClosedRecord } from "../src/floor/facts.js";
import {
  dismissRecord,
  readQueue,
  readStrandedRecords,
  RESEND_CHUNK,
  resendRefused,
  StaleQueueError,
  UnreadableRecordError,
  type RecoveryContext,
} from "../src/floor/queue/outbox-recovery.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { receiptStatements } from "../src/local/facts-sender.js";
import { ENTERED, OPERATOR_ID, PAIRING, rows, SHIFT_ID, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const AT = "2026-10-11T08:00:00.000Z";
const NOW = new Date("2026-10-11T09:00:00.000Z");
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
const CLOSE_ID = "00000000-0000-4000-8000-c00000000001";

/** Ids `…f00000000001`, `…f00000000002`, … */
function counting(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-f${String(n).padStart(11, "0")}`;
  };
}

function settle(
  db: DatabaseSync,
  ids: readonly string[],
  outcome: "rejected" | "conflict" | "accepted",
  code: string | null = null,
): void {
  const statement = db.prepare(
    "UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = ? WHERE id = ?",
  );
  for (const id of ids) statement.run(outcome, code, AT, id);
}

async function station() {
  const { db, executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
  return { db, local: executor };
}

function context(local: LocalExecutor, newId = counting()): RecoveryContext {
  return { local, pairing: PAIRING, operatorId: OPERATOR_ID, newId, now: () => NOW };
}

function payloadOf(db: DatabaseSync, id: string): string {
  return String(rows(db, "SELECT payload FROM outbox WHERE id = ?", id)[0]?.["payload"]);
}

describe("the queue screen's reads", () => {
  it("list what waits by kind with its oldest record, and the unresolved refused and conflicting records with their shift", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = "", waiting = "", resolved = ""] = await unsentScans(local, 4);
    settle(db, [refused, resolved], "rejected", "gtin_mismatch");
    settle(db, [conflict], "conflict");
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(AT, OPERATOR_ID, resolved);
    const created = String(
      rows(db, "SELECT created_at FROM outbox WHERE id = ?", waiting)[0]?.["created_at"],
    );
    const view = await readQueue(local, PAIRING);
    expect(view.unsent).toEqual([{ kind: "scan", count: 1, oldest: created }]);
    expect(view.settled.map((record) => [record.id, record.outcome, record.code])).toEqual([
      [refused, "rejected", "gtin_mismatch"],
      [conflict, "conflict", null],
    ]);
    expect(view.settled[0]).toMatchObject({
      kind: "scan",
      shiftId: SHIFT_ID,
      shiftNumber: ENTERED.number,
      sscc: null,
    });
    expect(view.stranded).toBe(0);
  });

  it("count the unsent records other pairings of this computer left, and show none of them as this pairing's", async () => {
    const { local } = await station();
    await unsentScans(local, 2, OTHER_PAIRING, 50);
    await expect(readStrandedRecords(local, PAIRING)).resolves.toBe(2);
    const view = await readQueue(local, PAIRING);
    expect(view.unsent).toEqual([]);
    expect(view.stranded).toBe(2);
  });
});

describe("sending refused records again", () => {
  it("writes the shift's refused records after everything, under new ids, with the same data, and marks them resent", async () => {
    const { db, local } = await station();
    const [one = "", two = "", three = ""] = await unsentScans(local, 3);
    settle(db, [one, three], "rejected", "not_entered");
    settle(db, [two], "accepted");
    const before = { one: payloadOf(db, one), three: payloadOf(db, three) };
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(2);
    const first = "00000000-0000-4000-8000-f00000000001";
    const second = "00000000-0000-4000-8000-f00000000002";
    expect(rows(db, "SELECT id FROM outbox ORDER BY seq").map((row) => row["id"])).toEqual([
      one,
      two,
      three,
      first,
      second,
    ]);
    // Byte for byte but the id: the host matches an exception by its instants (plan 2a2).
    expect(payloadOf(db, first)).toBe(before.one.replace(one, first));
    expect(payloadOf(db, second)).toBe(before.three.replace(three, second));
    expect(
      rows(
        db,
        "SELECT id, kind, shift_id, created_at, outcome, resolution, resent_as, resolved_at, " +
          "resolved_by FROM outbox WHERE id IN (?, ?, ?, ?) ORDER BY seq",
        one,
        three,
        first,
        second,
      ),
    ).toEqual([
      { id: one, kind: "scan", shift_id: SHIFT_ID, created_at: expect.any(String), outcome: "rejected", resolution: "resent", resent_as: first, resolved_at: NOW.toISOString(), resolved_by: OPERATOR_ID },
      { id: three, kind: "scan", shift_id: SHIFT_ID, created_at: expect.any(String), outcome: "rejected", resolution: "resent", resent_as: second, resolved_at: NOW.toISOString(), resolved_by: OPERATOR_ID },
      { id: first, kind: "scan", shift_id: SHIFT_ID, created_at: NOW.toISOString(), outcome: null, resolution: null, resent_as: null, resolved_at: null, resolved_by: null },
      { id: second, kind: "scan", shift_id: SHIFT_ID, created_at: NOW.toISOString(), outcome: null, resolution: null, resent_as: null, resolved_at: null, resolved_by: null },
    ]);
    const view = await readQueue(local, PAIRING);
    expect(view.settled).toEqual([]);
    expect(view.unsent).toEqual([{ kind: "scan", count: 2, oldest: NOW.toISOString() }]);
  });

  it("carries a refused close of a shift this station closed, and the host's acceptance closes the shift", async () => {
    const { db, local } = await station();
    const [scan = ""] = await unsentScans(local, 1);
    await local.transaction([
      outboxStatement(
        shiftClosedRecord(
          { id: CLOSE_ID, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          { plannedQtySnapshot: 1200, actualQty: 0, closedBoxCount: 0, reasonCode: null, closedAt: AT },
        ),
        PAIRING,
        AT,
      ),
    ]);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(SHIFT_ID);
    settle(db, [scan], "rejected", "not_entered");
    settle(db, [CLOSE_ID], "rejected", "box_state");
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(2);
    const carried = rows(
      db,
      "SELECT id, kind FROM outbox WHERE outcome IS NULL ORDER BY seq",
    ).map((row) => ({ id: String(row["id"]), kind: String(row["kind"]), outcome: "accepted" }));
    expect(carried.map((record) => record.kind)).toEqual(["scan", "shift_closed"]);
    await local.transaction(receiptStatements(PAIRING, JSON.stringify(carried), NOW.toISOString()));
    expect(rows(db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)).toEqual([
      { local_state: "closed" },
    ]);
  });

  it("goes in parts of RESEND_CHUNK, in the order the records were kept", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, RESEND_CHUNK * 2 + 3);
    settle(db, ids, "rejected", "not_entered");
    const transaction = vi.spyOn(local, "transaction");
    await expect(resendRefused(context(local), SHIFT_ID)).resolves.toBe(ids.length);
    expect(transaction).toHaveBeenCalledTimes(3);
    const pairs = rows(
      db,
      "SELECT o.seq AS old, n.seq AS new FROM outbox o JOIN outbox n ON n.id = o.resent_as " +
        "ORDER BY o.seq",
    ).map((row) => Number(row["new"]));
    expect(pairs).toEqual([...pairs].sort((a, b) => a - b));
    expect(pairs).toHaveLength(ids.length);
  });

  it("writes nothing when a refused record of the shift was resolved meanwhile", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    settle(db, [one, two], "rejected", "not_entered");
    const racing: LocalExecutor = {
      query: (sql, params, row) => local.query(sql, params, row),
      transaction: async (statements) => {
        db.prepare(
          "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ?",
        ).run(AT, OPERATOR_ID, two);
        return local.transaction(statements);
      },
    };
    await expect(resendRefused({ ...context(local), local: racing }, SHIFT_ID)).rejects.toBeInstanceOf(
      StaleQueueError,
    );
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT resolution FROM outbox WHERE id = ?", one)).toEqual([{ resolution: null }]);
  });

  it("refuses a shift with a record this build cannot read, before writing anything", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES ('old-build', ?, ?, 'scan', ?, '{\"id\":\"old-build\",\"kind\":\"scan\"}', ?)",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID, AT);
    settle(db, [one, "old-build"], "rejected", "invalid_record");
    const error = await resendRefused(context(local), SHIFT_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableRecordError);
    expect(error instanceof UnreadableRecordError ? error.recordId : null).toBe("old-build");
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });

  it("never takes another pairing's refusals for this pairing's", async () => {
    const { db, local } = await station();
    const [theirs = ""] = await unsentScans(local, 1, OTHER_PAIRING, 50);
    settle(db, [theirs], "rejected", "not_entered");
    await expect(resendRefused(context(local), SHIFT_ID)).rejects.toBeInstanceOf(StaleQueueError);
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
  });
});

describe("taking a record off the queue", () => {
  it("marks a refused record and a conflict as taken off by the operator, never a close", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 2);
    await local.transaction([
      outboxStatement(
        shiftClosedRecord(
          { id: CLOSE_ID, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
          { plannedQtySnapshot: 1200, actualQty: 0, closedBoxCount: 0, reasonCode: null, closedAt: AT },
        ),
        PAIRING,
        AT,
      ),
    ]);
    settle(db, [refused, CLOSE_ID], "rejected", "box_state");
    settle(db, [conflict], "conflict");
    await dismissRecord(context(local), refused);
    await dismissRecord(context(local), conflict);
    await expect(dismissRecord(context(local), CLOSE_ID)).rejects.toBeInstanceOf(StaleQueueError);
    await expect(dismissRecord(context(local), refused)).rejects.toBeInstanceOf(StaleQueueError);
    expect(
      rows(db, "SELECT id, resolution, resolved_by, resolved_at FROM outbox ORDER BY seq"),
    ).toEqual([
      { id: refused, resolution: "dismissed", resolved_by: OPERATOR_ID, resolved_at: NOW.toISOString() },
      { id: conflict, resolution: "dismissed", resolved_by: OPERATOR_ID, resolved_at: NOW.toISOString() },
      { id: CLOSE_ID, resolution: null, resolved_by: null, resolved_at: null },
    ]);
    expect((await readQueue(local, PAIRING)).settled.map((record) => record.id)).toEqual([CLOSE_ID]);
  });
});
```

Если `vi.spyOn(local, "transaction")` неприменим к исполнителю тестов (объект без собственного свойства), обернуть исполнитель счётчиком, как `holdingWrites` в `test/support/floor-work.ts`.

2. `apps/standalone/test/floor-schema.test.ts`: импорт

<!-- prettier-ignore -->
```typescript
import {
  DISMISS_SQL,
  QUEUE_SETTLED_SQL,
  QUEUE_UNSENT_SQL,
  RESEND_INSERT_SQL,
  RESEND_MARK_SQL,
  RESEND_READ_SQL,
  STRANDED_COUNT_SQL,
} from "../src/floor/queue/outbox-recovery.js";
```

и два теста в `describe`, где стоит «serve the reads the floor makes from an index»:

<!-- prettier-ignore -->
```typescript
  // The queue screen (plan ОЧ) reads on opening and writes on a person's press: seeks in the
  // outbox's partial indexes and by the records' own key. Pinned on the shell too.
  it("serve the queue screen's reads and writes from an index (plan ОЧ)", () => {
    const { db } = openLocalDb();
    const plan = (sql: string): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: sql.split("?").length - 1 }, () => "x"))
        .map((step) => String(step["detail"]));
    const unsent = plan(QUEUE_UNSENT_SQL);
    expect(unsent.join("\n")).toContain("outbox_unsent (host_id=? AND device_id=?)");
    expect(unsent.filter((step) => step.startsWith("SCAN ") || step.includes("TEMP"))).toEqual([
      "USE TEMP B-TREE FOR GROUP BY",
    ]);
    const settled = plan(QUEUE_SETTLED_SQL);
    for (const index of [
      "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
      "sqlite_autoindex_floor_boxes_1 (id=?)",
      "sqlite_autoindex_floor_pallets_1 (id=?)",
    ]) {
      expect(settled.join("\n"), index).toContain(index);
    }
    expect(settled.filter((step) => step.startsWith("SCAN ") || step.includes("TEMP"))).toEqual([]);
    expect(plan(RESEND_READ_SQL).filter((step) => step.startsWith("SCAN "))).toEqual([]);
    for (const sql of [RESEND_INSERT_SQL, RESEND_MARK_SQL, DISMISS_SQL]) {
      expect(plan(sql).join("\n"), sql).toContain("sqlite_autoindex_outbox_1 (id=?)");
    }
    // The only walk: the unsent records of every pairing, in their partial index.
    expect(plan(STRANDED_COUNT_SQL)).toEqual(["SCAN outbox USING COVERING INDEX outbox_unsent"]);
  });

  it("are pinned on the shell's SQLite with the queue screen's own statements (plan ОЧ)", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    const statements = [
      QUEUE_UNSENT_SQL,
      QUEUE_SETTLED_SQL,
      RESEND_READ_SQL,
      RESEND_INSERT_SQL,
      RESEND_MARK_SQL,
      DISMISS_SQL,
      STRANDED_COUNT_SQL,
    ];
    expect(new Set(statements).size).toBe(7);
    for (const sql of statements) expect(source).toContain(`"${sql}"`);
  });
```

3. `apps/standalone/src-tauri/tests/local_db.rs`, в `reads` (и `N`) — семь записей тех же текстов (дословно, продолжения строк по месту) с ожиданиями: `QUEUE_UNSENT` → `"outbox_unsent (host_id=? AND device_id=?)"`; `QUEUE_SETTLED` → `"outbox_settled (host_id=? AND device_id=? AND outcome=?)"`; `RESEND_READ` → индекс, который называет план 3.46 (ХП по `shift_id` или `outbox_settled`); `RESEND_INSERT`, `RESEND_MARK`, `DISMISS` → `"sqlite_autoindex_outbox_1 (id=?)"`; `STRANDED_COUNT` → `"COVERING INDEX outbox_unsent"`. Комментарий над ними: «The queue screen (plan ОЧ): read on opening, written on a person's press; `test/floor-schema.test.ts` checks the texts agree.»

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/outbox-recovery.test.ts test/floor-schema.test.ts`
Expected: FAIL — `Failed to resolve import "../src/floor/queue/outbox-recovery.js"`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/queue/outbox-recovery.ts`:

<!-- prettier-ignore -->
```typescript
import { z } from "zod";

import { factRecordSchema } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/**
 * The most refused records one transaction carries again: a record is at most
 * 16 KiB (`MAX_RECORD_BYTES`), so a part stays under a megabyte of bound JSON.
 */
export const RESEND_CHUNK = 50;

/** What waits for the host, by kind, with the oldest record of each; parameters: host id, device id. */
export const QUEUE_UNSENT_SQL =
  "SELECT kind, count(*) AS n, min(created_at) AS oldest FROM outbox " +
  "WHERE host_id = ? AND device_id = ? AND acked_at IS NULL GROUP BY kind";

/**
 * The refused and conflicting records nobody resolved yet, with the number of
 * their shift and the SSCC of the box or pallet they name (never a code of
 * marking); parameters: host id, device id. Sorted by `seq` in memory: a person
 * resolves them one by one, so they are few.
 */
export const QUEUE_SETTLED_SQL =
  "SELECT o.id, o.seq, o.kind, o.shift_id, s.number AS shift_number, o.created_at, o.outcome, " +
  "o.outcome_code AS code, coalesce(o.payload ->> '$.data.sscc', b.sscc, p.sscc) AS sscc " +
  "FROM outbox o LEFT JOIN floor_shifts s ON s.host_id = o.host_id " +
  "AND s.device_id = o.device_id AND s.id = o.shift_id " +
  "LEFT JOIN floor_boxes b ON b.id = (o.payload ->> '$.data.boxId') " +
  "LEFT JOIN floor_pallets p ON p.id = (o.payload ->> '$.data.palletId') " +
  "WHERE o.host_id = ? AND o.device_id = ? AND o.outcome IN ('rejected', 'conflict') " +
  "AND o.resolved_at IS NULL";

/** A shift's refused records nobody resolved, in the order they were kept; parameters: host id, device id, shift id. */
export const RESEND_READ_SQL =
  "SELECT id, payload FROM outbox WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
  "AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";

/**
 * The refused records again under new ids — a JSON list of `{oldId, newId,
 * payload}` — after everything kept so far, in their order, each with its own
 * kind and shift. A record sent again after its shift's close is late by
 * definition and is written past `outboxStatement`'s check (plan 2a8,
 * «Контракт для ПЛ-Ц и ОЧ»). Parameters: the instant, the list, host id,
 * device id.
 */
export const RESEND_INSERT_SQL =
  "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
  "SELECT r.value ->> 'newId', o.host_id, o.device_id, o.kind, o.shift_id, " +
  "r.value ->> 'payload', ? FROM json_each(?) AS r JOIN outbox AS o ON o.id = r.value ->> 'oldId' " +
  "WHERE +o.host_id = ? AND +o.device_id = ? AND +o.outcome = 'rejected' " +
  "AND o.resolved_at IS NULL ORDER BY o.seq";

/** The refused records marked as sent again; parameters: the instant, the operator, the list, host id, device id. */
export const RESEND_MARK_SQL =
  "UPDATE outbox SET resolution = 'resent', resent_as = r.value ->> 'newId', resolved_at = ?, " +
  "resolved_by = ? FROM json_each(?) AS r WHERE outbox.id = r.value ->> 'oldId' " +
  "AND +outbox.host_id = ? AND +outbox.device_id = ? AND +outbox.outcome = 'rejected' " +
  "AND outbox.resolved_at IS NULL";

/**
 * A refused or conflicting record taken off the queue by a person — never a
 * shift's close, which only goes again; parameters: the instant, the operator,
 * host id, device id, record id.
 */
export const DISMISS_SQL =
  "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? " +
  "WHERE host_id = ? AND device_id = ? AND id = ? AND outcome IN ('rejected', 'conflict') " +
  "AND kind <> 'shift_closed' AND resolved_at IS NULL";

/**
 * The records other pairings of this computer left without a receipt (a forget
 * with «Сбросить всё равно», a re-pair): they never go, and stay on disk for
 * support. Parameters: host id, device id.
 */
export const STRANDED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL AND NOT (host_id = ? AND device_id = ?)";

/** The queue changed under the person's decision: nothing was written, the screen reads again. */
export class StaleQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleQueueError";
  }
}

/** A refused record this build cannot carry again unchanged: it can only be taken off. */
export class UnreadableRecordError extends Error {
  readonly recordId: string;

  constructor(recordId: string) {
    super(`record ${recordId} cannot be carried again by this build`);
    this.name = "UnreadableRecordError";
    this.recordId = recordId;
  }
}

export interface UnsentKind {
  kind: string;
  count: number;
  /** The oldest record's `created_at`. */
  oldest: string;
}

export interface SettledRecord {
  id: string;
  seq: number;
  kind: string;
  shiftId: string;
  /** `null` when this pairing keeps no copy of the shift. */
  shiftNumber: string | null;
  createdAt: string;
  outcome: "rejected" | "conflict";
  /** The host's code of a refusal; `null` for a conflict or a refusal without one. */
  code: string | null;
  /** The SSCC of the box or pallet the record names, when the station knows it. */
  sscc: string | null;
}

export interface QueueView {
  unsent: UnsentKind[];
  settled: SettledRecord[];
  stranded: number;
}

/** What a person's decision needs: the operator who makes it, new ids and the clock. */
export interface RecoveryContext {
  local: LocalExecutor;
  pairing: Pairing;
  operatorId: string;
  newId: () => string;
  now: () => Date;
}

const unsentRow = z.object({ kind: z.string(), n: z.number().int().positive(), oldest: z.string() });
const settledRow = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  shift_id: z.string(),
  shift_number: z.string().nullable(),
  created_at: z.string(),
  outcome: z.enum(["rejected", "conflict"]),
  code: z.string().nullable(),
  sscc: z.string().nullable(),
});
const payloadRow = z.object({ id: z.string(), payload: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

/** The records other pairings of this computer left without a receipt. */
export async function readStrandedRecords(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(STRANDED_COUNT_SQL, [pairing.hostId, pairing.deviceId], countRow);
  return row?.n ?? 0;
}

/**
 * What the queue screen shows (pilot spec §9.3, plan ОЧ): this pairing's
 * records waiting for the host by kind, oldest kind first; its refused and
 * conflicting records nobody resolved, in the order they were kept; and the
 * records older pairings left unsent. A failed read rejects.
 */
export async function readQueue(local: LocalExecutor, pairing: Pairing): Promise<QueueView> {
  const key = [pairing.hostId, pairing.deviceId];
  const [unsent, settled, stranded] = await Promise.all([
    local.query(QUEUE_UNSENT_SQL, key, unsentRow),
    local.query(QUEUE_SETTLED_SQL, key, settledRow),
    readStrandedRecords(local, pairing),
  ]);
  return {
    unsent: unsent
      .map((row) => ({ kind: row.kind, count: row.n, oldest: row.oldest }))
      .sort((a, b) => a.oldest.localeCompare(b.oldest) || a.kind.localeCompare(b.kind)),
    settled: settled
      .map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        shiftId: row.shift_id,
        shiftNumber: row.shift_number,
        createdAt: row.created_at,
        outcome: row.outcome,
        code: row.code,
        sscc: row.sscc,
      }))
      .sort((a, b) => a.seq - b.seq),
    stranded,
  };
}

/**
 * The record's payload under `newId`, every other byte as kept: the record must
 * read as this build's, and its `data` must come back exactly as stored (the
 * host matches an exception by its instants, plan 2a2), or it cannot go again.
 */
function carried(row: { id: string; payload: string }, newId: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    throw new UnreadableRecordError(row.id);
  }
  const parsed = factRecordSchema.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null || !("data" in raw)) {
    throw new UnreadableRecordError(row.id);
  }
  if (JSON.stringify(parsed.data.data) !== JSON.stringify(raw.data)) {
    throw new UnreadableRecordError(row.id);
  }
  return JSON.stringify({ ...parsed.data, id: newId });
}

/**
 * «Отправить снова» (plan ОЧ; plan 2a2, the owner's decision 1): every refused
 * record of the shift nobody resolved goes again under a new id, its data byte
 * for byte, after everything kept so far and in the order it was kept — so a
 * refused record's refused dependents follow it. Each old record is marked
 * `resent` with the id that carries it, the operator and the time, in the
 * transaction that writes the new one; parts of `RESEND_CHUNK` keep the order
 * whatever happens to a later part. A refused close goes the same way; once the
 * host takes it, the receipt makes the shift `closed` (plan 2a8). Every record
 * is read before anything is written: one this build cannot carry rejects the
 * whole shift (`UnreadableRecordError`). A record resolved meanwhile, or none
 * left to send, is a `StaleQueueError`. Returns how many records went again.
 */
export async function resendRefused(context: RecoveryContext, shiftId: string): Promise<number> {
  const { local, pairing } = context;
  const refused = await local.query(
    RESEND_READ_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    payloadRow,
  );
  if (refused.length === 0) throw new StaleQueueError("no refused record of the shift waits");
  const list = refused.map((row) => {
    const newId = context.newId();
    return { oldId: row.id, newId, payload: carried(row, newId) };
  });
  for (let start = 0; start < list.length; start += RESEND_CHUNK) {
    const part = list.slice(start, start + RESEND_CHUNK);
    const at = context.now().toISOString();
    const json = JSON.stringify(part);
    try {
      await local.transaction([
        {
          sql: RESEND_INSERT_SQL,
          values: [at, json, pairing.hostId, pairing.deviceId],
          expectedChanges: part.length,
        },
        {
          sql: RESEND_MARK_SQL,
          values: [at, context.operatorId, json, pairing.hostId, pairing.deviceId],
          expectedChanges: part.length,
        },
      ]);
    } catch (error) {
      if (error instanceof LocalDbError && error.code === "changes_mismatch") {
        throw new StaleQueueError("a refused record of the shift changed meanwhile");
      }
      throw error;
    }
  }
  return list.length;
}

/**
 * «Снять с очереди» / «Разобрано» (plan ОЧ): a refused record — never a
 * shift's close — or a conflict is taken off by a person, with who and when; it
 * is never sent, and the retention may take its shift. A record resolved
 * meanwhile, or a close, is a `StaleQueueError`.
 */
export async function dismissRecord(context: RecoveryContext, recordId: string): Promise<void> {
  const { local, pairing } = context;
  try {
    await local.transaction([
      {
        sql: DISMISS_SQL,
        values: [
          context.now().toISOString(),
          context.operatorId,
          pairing.hostId,
          pairing.deviceId,
          recordId,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleQueueError("the record is resolved already, or a close");
    }
    throw error;
  }
}
```

Если `raw.data` после сужения `"data" in raw` не проходит строгую проверку типов, заменить на `Reflect.get(raw, "data")` — без `as`.

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2 и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS.

Мутации: (a) убрать `ORDER BY o.seq` у `RESEND_INSERT_SQL` и развернуть список в коде (`list.reverse()`) — падает тест порядка; (b) убрать `kind <> 'shift_closed'` — падает тест снятия; (c) не сверять `data` в `carried` — тест «cannot read» должен по-прежнему ловить запись без `data` (проверить, что падает хотя бы тест «byte for byte», если вместо `{ ...parsed.data, id }` собрать заново ключи в другом порядке).

- [ ] **Step 5: Коммит**

Пути: `src/floor/queue/outbox-recovery.ts`, `test/outbox-recovery.test.ts`, `test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`. Сообщение: `feat(standalone): the outbox's recovery by a person — the queue's reads, «Отправить снова» under new ids in the old order, «Снять с очереди», and the records an older pairing left (plan ОЧ)` + трейлер.

---

### Task 4: Экран «Очередь отправки» и вход в него из списка смен

**Files:**

- Create: `apps/standalone/src/floor/queue/QueueScreen.tsx`, `apps/standalone/test/floor-queue-screen.test.tsx`
- Modify: `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-shift-list.test.tsx`, `apps/standalone/test/floor-app.test.tsx`

**Interfaces:**

- Consumes: модуль задачи 3; `HostStatusLine`; `waitUnits` (`outbox-status.ts`); `formatQuantity`; `FACT_RECEIPT_CODES`.
- Produces: `QueueScreen(props: QueueScreenProps)` (`{ local; pairing; operator: FloorSession; link: HostStatus | null; onChanged(): void; onBack(): void; newId?; now? }`); `ShiftListProps.onQueue?: () => void`; вид `FloorView` `{ kind: "queue" }`; ключи `floor.shifts.queue`, `floor.queue.*`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/floor-queue-screen.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import { QueueScreen } from "../src/floor/queue/QueueScreen.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { FACT_RECEIPT_CODES } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import ru from "../src/i18n/ru.json";
import { ENTERED, OPERATOR_ID, PAIRING, rows, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OPERATOR: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
// The scans of `unsentScans` are kept at 06:15 UTC; two hours and five minutes later.
const NOW = new Date("2026-10-08T08:20:00.000Z");

async function station() {
  const { db, executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
  return { db, local: executor };
}

function refuse(db: ReturnType<typeof openLocalDb>["db"], id: string, outcome: string, code: string | null) {
  db.prepare("UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = ? WHERE id = ?").run(
    outcome,
    code,
    "2026-10-08T06:30:00.000Z",
    id,
  );
}

function view(local: LocalExecutor, onChanged = vi.fn(), onBack = vi.fn()) {
  let n = 0;
  render(
    <ThemeProvider>
      <QueueScreen
        local={local}
        pairing={PAIRING}
        operator={OPERATOR}
        link={null}
        onChanged={onChanged}
        onBack={onBack}
        newId={() => {
          n += 1;
          return `00000000-0000-4000-8000-f${String(n).padStart(11, "0")}`;
        }}
        now={() => NOW}
      />
    </ThemeProvider>,
  );
  return { onChanged, onBack };
}

describe("the queue screen", () => {
  it("says what waits by kind and for how long, the refused records by shift with their reason in words, and the conflicts", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 3);
    refuse(db, refused, "rejected", "gtin_mismatch");
    refuse(db, conflict, "conflict", null);
    view(local);
    expect(await screen.findByText("Ждут отправки на хост")).toBeTruthy();
    expect(screen.getByText("1, самая старая ждёт 2 ч 5 мин")).toBeTruthy();
    expect(screen.getByText(`Смена ${ENTERED.number}`)).toBeTruthy();
    expect(screen.getByText("Код другого товара, не товара смены")).toBeTruthy();
    expect(screen.getByText("Код уже принят хостом в другом месте: проверьте короб.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отправить снова" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Разобрано" })).toBeTruthy();
  });

  it("sends a shift's refused records again only once the operator confirms, and says so", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "rejected", "not_entered");
    const { onChanged } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await screen.findByRole("group", { name: "Подтверждение" });
    expect(within(confirm).getByText(/Отправить снова отклонённые записи смены \(2\)/)).toBeTruthy();
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    expect(await screen.findByText("Записи поставлены в очередь заново.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy());
    expect(onChanged).toHaveBeenCalled();
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution = 'resent'")).toEqual([{ n: 2 }]);
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
  });

  it("takes a refused record off on confirmation, offers it for no close, and settles a conflict", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 2);
    refuse(db, refused, "rejected", "not_entered");
    refuse(db, conflict, "conflict", null);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await screen.findByRole("group", { name: "Подтверждение" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Разобрано" }));
    const settle = await screen.findByRole("group", { name: "Подтверждение" });
    fireEvent.click(within(settle).getByRole("button", { name: "Разобрано" }));
    await waitFor(() => expect(screen.getByText("Конфликтов нет.")).toBeTruthy());
    expect(rows(db, "SELECT resolution FROM outbox ORDER BY seq")).toEqual([
      { resolution: "dismissed" },
      { resolution: "dismissed" },
    ]);
  });

  it("says the queue changed when a record was resolved while the operator decided", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await screen.findByRole("group", { name: "Подтверждение" });
    db.prepare("UPDATE outbox SET resolution = 'dismissed', resolved_at = 'x', resolved_by = 'y'").run();
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    expect(
      await screen.findByText("Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз."),
    ).toBeTruthy();
  });

  it("names the records an older pairing left unsent", async () => {
    const { local } = await station();
    await unsentScans(local, 2, OTHER_PAIRING, 50);
    view(local);
    expect(await screen.findByText(/остались неотправленные записи прежнего подключения: 2/)).toBeTruthy();
  });

  it("goes back to the list", async () => {
    const { local } = await station();
    const { onBack } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("has words for every code of refusal the host gives", () => {
    const codes: Record<string, unknown> = ru.floor.queue.code;
    for (const code of FACT_RECEIPT_CODES) expect(codes[code], code).toEqual(expect.any(String));
  });
});
```

Если `ru.json` в тестах импортируется иначе (см. соседние тесты i18n), взять их способ.

2. `apps/standalone/test/floor-shift-list.test.tsx`: в `Options` добавить `onQueue?: () => void;`, в разметку `renderList` — `{...(options.onQueue === undefined ? {} : { onQueue: options.onQueue })}` рядом с `onSetup`; тест:

<!-- prettier-ignore -->
```tsx
  it("opens the queue of what was not sent, and offers no button without it (plan ОЧ)", async () => {
    const { executor } = openLocalDb();
    const onQueue = vi.fn();
    renderList(executor, { onQueue });
    fireEvent.click(await screen.findByRole("button", { name: "Очередь отправки" }));
    expect(onQueue).toHaveBeenCalledTimes(1);
  });
```

(Если `renderList` требует подготовленных копий смен, взять подготовку из первого теста файла.)

3. `apps/standalone/test/floor-app.test.tsx`: тест по образцу перехода в «Рабочее место» из списка: «opens «Очередь отправки» from the list and comes back (plan ОЧ)» — нажать «Очередь отправки», найти заголовок «Очередь отправки» (`role="heading"`), нажать «Назад», снова видеть «Смены линии».

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-queue-screen.test.tsx test/floor-shift-list.test.tsx test/floor-app.test.tsx`
Expected: FAIL — нет модуля `QueueScreen`, нет кнопки «Очередь отправки».

- [ ] **Step 3: Реализация**

1. `apps/standalone/src/i18n/ru.json`:
   - в `floor.shifts` после `"setup": "Рабочее место",` добавить `"queue": "Очередь отправки",`;
   - в `floor` после объекта `"shifts"` (на его уровне) добавить объект `"queue"`:

<!-- prettier-ignore -->
```json
    "queue": {
      "title": "Очередь отправки",
      "loading": "Читаем очередь…",
      "readFailed": "Не удалось прочитать очередь в базе этого компьютера.",
      "retry": "Повторить",
      "unsentTitle": "Ждут отправки на хост",
      "unsentNone": "Все записи отправлены.",
      "unsentValue": "{{n}}, самая старая ждёт {{age}}",
      "stranded": "На этом компьютере остались неотправленные записи прежнего подключения: {{n}}. На хост они не уйдут: станция подключена заново. Записи хранятся на диске этого ПК — сообщите администратору.",
      "refusedTitle": "Не приняты хостом",
      "refusedNone": "Отклонённых записей нет.",
      "conflictsTitle": "Конфликты",
      "conflictsNone": "Конфликтов нет.",
      "shift": "Смена {{number}}",
      "record": "{{kind}} · {{time}}",
      "recordSscc": "{{kind}} · SSCC {{sscc}} · {{time}}",
      "conflictReason": "Код уже принят хостом в другом месте: проверьте короб.",
      "resend": "Отправить снова",
      "dismiss": "Снять с очереди",
      "settle": "Разобрано",
      "confirmLabel": "Подтверждение",
      "confirmResend": "Отправить снова отклонённые записи смены ({{n}})? Они уйдут на хост заново, с новыми номерами, в прежнем порядке. Если причина отказа не устранена, хост отклонит их снова.",
      "confirmDismiss": "Снять запись с очереди, не отправляя? Хост её так и не получит; станция запомнит, кто и когда её снял.",
      "confirmSettle": "Отметить конфликт разобранным? Запись останется в базе этого компьютера.",
      "resendConfirm": "Отправить снова",
      "dismissConfirm": "Снять",
      "settleConfirm": "Разобрано",
      "cancel": "Отмена",
      "back": "Назад",
      "notice": {
        "resent": "Записи поставлены в очередь заново.",
        "dismissed": "Запись снята с очереди.",
        "stale": "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
        "unreadable": "Одна из записей смены не читается этой версией станции: отправить её снова нельзя. Снимите её с очереди или сообщите администратору.",
        "local": "Не удалось записать в базу этого компьютера. Освободите место на диске или обратитесь к администратору."
      },
      "kind": {
        "scan": "Скан",
        "box_closed": "Закрытие короба",
        "box_label": "Этикетка короба",
        "box_exception": "Исключение короба",
        "shift_closed": "Закрытие смены",
        "pallet_closed": "Закрытие паллеты",
        "pallet_label": "Этикетка паллеты",
        "pallet_exception": "Исключение паллеты"
      },
      "code": {
        "invalid_record": "Хост не смог прочитать запись: ошибка версии станции",
        "payload_mismatch": "Запись с этим номером уже пришла с другим содержимым",
        "unknown_shift": "Хост не знает эту смену",
        "not_entered": "На хосте станция не входила в эту смену",
        "gtin_mismatch": "Код другого товара, не товара смены",
        "box_unknown": "Хост не знает этот короб",
        "box_closed": "Короб уже закрыт на хосте",
        "box_already_closed": "Короб уже закрыт на хосте с другими данными",
        "box_state": "Короб в состоянии, которое не допускает эту запись",
        "sscc_not_issued": "Номер SSCC не из блока, выданного этой станции",
        "sscc_taken": "Номер SSCC уже занят другим коробом или паллетой",
        "no_pallets": "Смена без паллет",
        "pallet_unknown": "Хост не знает эту паллету",
        "pallet_already_closed": "Паллета уже закрыта на хосте",
        "pallet_state": "Паллета в состоянии, которое не допускает эту запись",
        "other": "Код отказа хоста: {{code}}"
      }
    },
```

Сверить слова кодов с `host/src/facts/*.rs` (что значит каждый код) и поправить неточность — в отклонения. Проверка уникальности ключей: `python3 -c "import json;json.load(open('apps/standalone/src/i18n/ru.json'),object_pairs_hook=lambda p:(_ for _ in ()).throw(SystemExit('dup '+str([k for k,_ in p if [x for x,_ in p].count(k)>1]))) if len({k for k,_ in p})!=len(p) else dict(p))"` — без вывода.

2. Создать `apps/standalone/src/floor/queue/QueueScreen.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card } from "@markiro/ui";

import { HostStatusLine } from "../../app/HostStatusLine.js";
import type { FloorSession } from "../../app/shell.js";
import { FACT_RECEIPT_CODES, type HostStatus } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { waitUnits } from "../outbox-status.js";
import { formatQuantity } from "../shifts/shift-text.js";
import {
  dismissRecord,
  readQueue,
  resendRefused,
  StaleQueueError,
  UnreadableRecordError,
  type QueueView,
  type SettledRecord,
} from "./outbox-recovery.js";

export interface QueueScreenProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The operator signed in: a decision on the queue is theirs (`resolved_by`). */
  operator: FloorSession;
  link: HostStatus | null;
  /** The outbox changed: the status bar counts again, and the outbox goes. */
  onChanged: () => void;
  onBack: () => void;
  newId?: () => string;
  now?: () => Date;
}

type Pending =
  | { kind: "resend"; shiftId: string; count: number }
  | { kind: "dismiss"; record: SettledRecord };

type Notice = "resent" | "dismissed" | "stale" | "unreadable" | "local";

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
const CODES: ReadonlySet<string> = new Set(FACT_RECEIPT_CODES);
/** Day, month, hours and minutes on this computer's clock. */
const MOMENT = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function kindText(t: TFunction, kind: string): string {
  return KINDS.has(kind) ? t(`floor.queue.kind.${kind}`) : kind;
}

function reasonText(t: TFunction, record: SettledRecord): string {
  if (record.outcome === "conflict") return t("floor.queue.conflictReason");
  if (record.code !== null && CODES.has(record.code)) return t(`floor.queue.code.${record.code}`);
  return t("floor.queue.code.other", { code: record.code ?? "—" });
}

function waitText(t: TFunction, ms: number): string {
  const parts = waitUnits(ms);
  return parts.length === 0
    ? t("floor.status.wait.none")
    : parts.map((part) => t(`floor.status.wait.${part.unit}`, { n: part.n })).join(" ");
}

function recordText(t: TFunction, record: SettledRecord): string {
  const kind = kindText(t, record.kind);
  const time = MOMENT.format(new Date(record.createdAt));
  return record.sscc === null
    ? t("floor.queue.record", { kind, time })
    : t("floor.queue.recordSscc", { kind, sscc: record.sscc, time });
}

/** The refused records of each shift, in the order they were kept; the shift of the oldest first. */
function byShift(records: readonly SettledRecord[]) {
  const groups = new Map<string, { shiftId: string; shiftNumber: string | null; records: SettledRecord[] }>();
  for (const record of records) {
    const group = groups.get(record.shiftId);
    if (group === undefined) {
      groups.set(record.shiftId, {
        shiftId: record.shiftId,
        shiftNumber: record.shiftNumber,
        records: [record],
      });
    } else {
      group.records.push(record);
    }
  }
  return [...groups.values()];
}

/**
 * «Очередь отправки» (pilot spec §9.3, plan ОЧ): the link and when the host
 * last answered; this pairing's records waiting for the host by kind, with how
 * long the oldest waited; its refused records by shift, each with its reason in
 * words, and its conflicts — never a code of marking, the SSCC of the box or
 * pallet only; and the records an older pairing left. A person resolves them:
 * «Отправить снова» sends a shift's refused records again, «Снять с очереди»
 * takes a refused record off (not a close), «Разобрано» a conflict — each
 * only after a confirmation that says what follows, which takes the focus.
 * Opened from the shift list, so no work of a shift is running: its writes do
 * not go through the work screen's queue. A decision that lost a race with
 * another says so and the list is read again.
 */
export function QueueScreen({
  local,
  pairing,
  operator,
  link,
  onChanged,
  onBack,
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
}: QueueScreenProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [queue, setQueue] = useState<QueueView | "loading" | "failed">("loading");
  const [reads, setReads] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    readQueue(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setQueue(next);
      },
      () => {
        if (!cancelled) setQueue("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, reads]);

  useEffect(() => {
    if (pending !== null) confirmRef.current?.focus();
  }, [pending]);

  const decide = async (step: Pending) => {
    setBusy(true);
    setNotice(null);
    const context = { local, pairing: { hostId, deviceId }, operatorId: operator.id, newId, now };
    let outcome: Notice;
    try {
      if (step.kind === "resend") await resendRefused(context, step.shiftId);
      else await dismissRecord(context, step.record.id);
      outcome = step.kind === "resend" ? "resent" : "dismissed";
    } catch (error) {
      outcome =
        error instanceof StaleQueueError
          ? "stale"
          : error instanceof UnreadableRecordError
            ? "unreadable"
            : "local";
    }
    if (!alive.current) return;
    // A part already written still counts: the bar reads again either way.
    onChanged();
    setNotice(outcome);
    setPending(null);
    setBusy(false);
    setReads((count) => count + 1);
  };

  const view = typeof queue === "object" ? queue : null;
  const refused = view === null ? [] : view.settled.filter((record) => record.outcome === "rejected");
  const conflicts = view === null ? [] : view.settled.filter((record) => record.outcome === "conflict");

  return (
    <Card className="standalone-card shift-list" title={t("floor.queue.title")} titleAs="h2">
      <div className="standalone-form">
        <HostStatusLine status={link} sync={null} />
        <div className="floor-sign-in__message floor-sign-in__message--stack" aria-live="polite">
          {notice !== null && <p>{t(`floor.queue.notice.${notice}`)}</p>}
        </div>
        {queue === "loading" && <p>{t("floor.queue.loading")}</p>}
        {queue === "failed" && (
          <>
            <p>{t("floor.queue.readFailed")}</p>
            <Button size="floor" variant="secondary" onClick={() => setReads((count) => count + 1)}>
              {t("floor.queue.retry")}
            </Button>
          </>
        )}
        {view !== null && (
          <>
            <section aria-labelledby="floor-queue-unsent">
              <h3 id="floor-queue-unsent">{t("floor.queue.unsentTitle")}</h3>
              {view.unsent.length === 0 ? (
                <p>{t("floor.queue.unsentNone")}</p>
              ) : (
                <dl>
                  {view.unsent.map((group) => (
                    <div key={group.kind} className="floor-status__item">
                      <dt>{kindText(t, group.kind)}</dt>
                      <dd>
                        {t("floor.queue.unsentValue", {
                          n: formatQuantity(group.count),
                          age: waitText(t, Math.max(0, now().getTime() - Date.parse(group.oldest))),
                        })}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
            {view.stranded > 0 && (
              <Alert tone="warn">
                {t("floor.queue.stranded", { n: formatQuantity(view.stranded) })}
              </Alert>
            )}
            <section aria-labelledby="floor-queue-refused">
              <h3 id="floor-queue-refused">{t("floor.queue.refusedTitle")}</h3>
              {refused.length === 0 ? (
                <p>{t("floor.queue.refusedNone")}</p>
              ) : (
                byShift(refused).map((group) => (
                  <Card key={group.shiftId} className="shift-card">
                    <h4>{t("floor.queue.shift", { number: group.shiftNumber ?? "—" })}</h4>
                    <ul>
                      {group.records.map((record) => (
                        <li key={record.id}>
                          <p>{recordText(t, record)}</p>
                          <p>{reasonText(t, record)}</p>
                          {record.kind !== "shift_closed" && (
                            <Button
                              size="floor"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => setPending({ kind: "dismiss", record })}
                            >
                              {t("floor.queue.dismiss")}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <Button
                      size="floor"
                      disabled={busy}
                      onClick={() =>
                        setPending({
                          kind: "resend",
                          shiftId: group.shiftId,
                          count: group.records.length,
                        })
                      }
                    >
                      {t("floor.queue.resend")}
                    </Button>
                  </Card>
                ))
              )}
            </section>
            <section aria-labelledby="floor-queue-conflicts">
              <h3 id="floor-queue-conflicts">{t("floor.queue.conflictsTitle")}</h3>
              {conflicts.length === 0 ? (
                <p>{t("floor.queue.conflictsNone")}</p>
              ) : (
                <ul>
                  {conflicts.map((record) => (
                    <li key={record.id}>
                      <p>
                        {t("floor.queue.shift", { number: record.shiftNumber ?? "—" })} ·{" "}
                        {recordText(t, record)}
                      </p>
                      <p>{reasonText(t, record)}</p>
                      <Button
                        size="floor"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setPending({ kind: "dismiss", record })}
                      >
                        {t("floor.queue.settle")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {pending !== null && (
          <div
            ref={confirmRef}
            tabIndex={-1}
            role="group"
            aria-label={t("floor.queue.confirmLabel")}
          >
            <p>
              {pending.kind === "resend"
                ? t("floor.queue.confirmResend", { n: formatQuantity(pending.count) })
                : t(
                    pending.record.outcome === "conflict"
                      ? "floor.queue.confirmSettle"
                      : "floor.queue.confirmDismiss",
                  )}
            </p>
            <div className="standalone-form__actions">
              <Button size="floor" disabled={busy} onClick={() => void decide(pending)}>
                {pending.kind === "resend"
                  ? t("floor.queue.resendConfirm")
                  : pending.record.outcome === "conflict"
                    ? t("floor.queue.settleConfirm")
                    : t("floor.queue.dismissConfirm")}
              </Button>
              <Button size="floor" variant="secondary" disabled={busy} onClick={() => setPending(null)}>
                {t("floor.queue.cancel")}
              </Button>
            </div>
          </div>
        )}
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t("floor.queue.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

Если `Card` не принимает вложенный `Card` или заголовок `h4` ломает иерархию заголовков `Card` (`titleAs="h2"`), заменить внутреннюю карточку на `<section className="shift-card">` — в отклонения. Если `HostStatusLine` требует `sync` не `null`, передать `null` разрешено (`SyncState | null`).

3. `apps/standalone/src/floor/shifts/ShiftList.tsx`:
   - фрагмент

<!-- prettier-ignore -->
```ts
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
}
```

- в деструктуризации после `onSetup,` добавить `onQueue,`;
- фрагмент

<!-- prettier-ignore -->
```tsx
          {/* Never held by an entry: one that never settles must not trap the station here. */}
```

заменить на

<!-- prettier-ignore -->
```tsx
          {onQueue !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onQueue}>
              {t("floor.shifts.queue")}
            </Button>
          )}
          {/* Never held by an entry: one that never settles must not trap the station here. */}
```

4. `apps/standalone/src/floor/FloorApp.tsx`:
   - импорт `import { QueueScreen } from "./queue/QueueScreen.js";` рядом с импортом `WorkScreen`;
   - фрагмент

<!-- prettier-ignore -->
```ts
  | { kind: "setup"; back: WorkShift | null };
```

заменить на

<!-- prettier-ignore -->
```ts
  | { kind: "setup"; back: WorkShift | null }
  | { kind: "queue" };
```

- фрагмент

<!-- prettier-ignore -->
```tsx
  if (view.kind === "new_shift") {
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (view.kind === "queue") {
    return (
      <QueueScreen
        local={local}
        pairing={{ hostId, deviceId }}
        operator={operator}
        link={link}
        onChanged={recorded}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }
  if (view.kind === "new_shift") {
```

- фрагмент

<!-- prettier-ignore -->
```tsx
      onSetup={() => setView({ kind: "setup", back: null })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
```

заменить на

<!-- prettier-ignore -->
```tsx
      onSetup={() => setView({ kind: "setup", back: null })}
      onQueue={() => setView({ kind: "queue" })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
```

- в докстроке `FloorApp` после «the shifts of the line and the work screen of the one entered,» вставить «the queue of what was not sent (plan ОЧ),».

Если в `FloorApp` есть исчерпывающая проверка `view.kind` (например в `finish` или в обработке ухода), добавить в неё `queue` так же, как `new_shift`.

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2 с `--reporter=verbose` (stderr пуст) и тот же прогон под стендом отложенного `setImmediate`; затем `pnpm --filter @markiro/standalone typecheck` и `lint`.
Expected: PASS.

- [ ] **Step 5: Коммит**

Пути: `src/floor/queue/QueueScreen.tsx`, `src/floor/FloorApp.tsx`, `src/floor/shifts/ShiftList.tsx`, `src/i18n/ru.json`, `test/floor-queue-screen.test.tsx`, `test/floor-shift-list.test.tsx`, `test/floor-app.test.tsx`. Сообщение: `feat(standalone): «Очередь отправки» on the floor — what waits, what the host refused with its reason in words, conflicts, «Отправить снова» and «Снять с очереди» on confirmation (plan ОЧ)` + трейлер.

---

### Task 5: Строка состояния — запас номеров по порогам, непринятые блоки, записи прежнего подключения

**Files:**

- Modify: `apps/standalone/src/floor/outbox-status.ts`, `apps/standalone/src/floor/work/block-supply.ts`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-outbox-status.test.ts`, `apps/standalone/test/floor-status-bar.test.tsx`, `apps/standalone/test/floor-schema.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`

**Interfaces:**

- Consumes: `remainingSerials`, `BOX_EXTENSION`, `PALLET_EXTENSION`, `readStrandedRecords` (задача 3), таблица `floor_block_drops` (задача 1).
- Produces (`outbox-status.ts`): `SHIFT_STOCK_SQL` (вместо `SHIFT_PREFIX_SQL`), `type StockLevel = "ok" | "quarter" | "tenth" | "last" | "none"`, `stockLevel(left, blockSize: number | null): StockLevel`, `SerialStock { left; level }`, `ShiftStock { boxes: SerialStock; pallets: SerialStock | null }`, `readShiftStock(local, pairing, shiftId): Promise<ShiftStock | null>` (вместо `readSerialsLeft`), `BLOCK_DROPS_COUNT_SQL`, `readBlockDrops(local, pairing): Promise<number>`; `SERIALS_LOW` удалён. `block-supply.ts`: `NEWEST_BLOCK_SQL` (текст запроса `blockWanted`, без изменений). Ключи `floor.status.palletSerials`, `floor.status.stranded`, `floor.status.blockDrops`, `floor.status.stock.{box,pallet}.{quarter,tenth,last,none}`; ключи `floor.status.serialsLow`, `floor.status.serialsNone` удалены.

- [ ] **Step 1: Тесты — сначала они**

1. `apps/standalone/test/floor-outbox-status.test.ts`: импорт `readSerialsLeft` заменить на `readBlockDrops, readShiftStock, stockLevel`; тесты `readSerialsLeft` переписать на `readShiftStock(...).boxes.left` (то же число); добавить:

<!-- prettier-ignore -->
```typescript
describe("the stock of serials (pilot spec §9.3, plan ОЧ)", () => {
  it("is low at a quarter and a tenth of the newest block, then at the last serial, then gone", () => {
    expect(stockLevel(501, 2000)).toBe("ok");
    expect(stockLevel(500, 2000)).toBe("quarter");
    expect(stockLevel(201, 2000)).toBe("quarter");
    expect(stockLevel(200, 2000)).toBe("tenth");
    expect(stockLevel(2, 2000)).toBe("tenth");
    expect(stockLevel(1, 2000)).toBe("last");
    expect(stockLevel(0, 2000)).toBe("none");
    // No block to measure by: only the last serial and none say anything.
    expect(stockLevel(5, null)).toBe("ok");
    expect(stockLevel(1, null)).toBe("last");
  });

  it("reads the boxes' serials of the shift and, for a shift with pallets, the pallets'", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000, next: 1601 });
    await expect(readShiftStock(executor, PAIRING, ENTERED.id)).resolves.toEqual({
      boxes: { left: 400, level: "quarter" },
      pallets: null,
    });
    db.prepare("UPDATE floor_shifts SET pallets_enabled = 1 WHERE id = ?").run(ENTERED.id);
    seedBlock(db, {
      blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
      from: 1,
      to: 200,
      next: 200,
      extension: 1,
    });
    await expect(readShiftStock(executor, PAIRING, ENTERED.id)).resolves.toEqual({
      boxes: { left: 400, level: "quarter" },
      pallets: { left: 1, level: "last" },
    });
    await expect(readShiftStock(executor, PAIRING, "no-such-shift")).resolves.toBeNull();
  });

  it("counts the blocks this pairing did not take, and no other pairing's", async () => {
    const { db, executor } = openLocalDb();
    const drop = db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, ?, 'r', '460068200', " +
        "0, 1, 10, 'overlap', '2026-10-11T08:00:00.000Z')",
    );
    drop.run(PAIRING.hostId, PAIRING.deviceId, "b-1");
    drop.run(PAIRING.hostId, PAIRING.deviceId, "b-2");
    drop.run(OTHER_DEVICE.hostId, OTHER_DEVICE.deviceId, "b-3");
    await expect(readBlockDrops(executor, PAIRING)).resolves.toBe(2);
  });
});
```

(Если копия `ENTERED` в этом файле хранит `pallets_enabled` иначе, взять способ из `test/support/pallets.ts`.)

2. `apps/standalone/test/floor-status-bar.test.tsx`: тест «warns, in the polite region that was there before, when the serials run out, and says so at zero» переписать на уровни:

<!-- prettier-ignore -->
```tsx
  it("warns, in the polite region that was there before, at a quarter and a tenth of the block, at the last serial, and says so at zero (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    // A block of 2 000 with 501 left: nothing to say yet.
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000, next: 1500 });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("501"));
    const before = politeRegions();
    expect(screen.queryByText(/Номеров SSCC для коробов осталось/)).toBeNull();

    const step = async (next: number, version: number) => {
      db.prepare("UPDATE floor_sscc_blocks SET next_serial = ?").run(next);
      view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: version }));
    };
    await step(1501, 1);
    const quarter = await screen.findByText(
      "Номеров SSCC для коробов осталось 500 — меньше четверти блока. Новые номера выдаёт хост: станция должна быть с ним на связи.",
    );
    expect(heardOnce(before, quarter)).toBe(true);
    await step(1801, 2);
    expect(
      await screen.findByText(
        "Номеров SSCC для коробов осталось 200 — меньше десятой части блока. Без связи с хостом короба скоро не закрыть.",
      ),
    ).toBeTruthy();
    await step(2000, 3);
    expect(
      await screen.findByText(
        "Остался последний номер SSCC для коробов: следующий короб без связи с хостом не закрыть.",
      ),
    ).toBeTruthy();
    await step(2001, 4);
    expect(
      await screen.findByText(
        "Номера SSCC для коробов закончились: короб не закрыть, пока хост не выдаст станции новый блок. Нужна связь с хостом.",
      ),
    ).toBeTruthy();
    expect(shown("Номеров SSCC")).toBe("0");
  });

  it("shows and warns of the pallets' serials only in a shift with pallets (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 200, next: 181, extension: 1 });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2 000"));
    expect(shown("Номеров SSCC паллет")).toBeNull();
    db.prepare("UPDATE floor_shifts SET pallets_enabled = 1 WHERE id = ?").run(ENTERED.id);
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC паллет")).toBe("20"));
    expect(
      screen.getByText(
        "Номеров SSCC для паллет осталось 20 — меньше десятой части блока. Без связи с хостом полную паллету скоро не закрыть.",
      ),
    ).toBeTruthy();
  });

  it("says the blocks the host gave and the station did not take, and the records an older pairing left (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, 'b-1', 'r', " +
        "'460068200', 0, 1, 10, 'overlap', '2026-10-11T08:00:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    await unsentScans(executor, 3, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 50);
    render(bar({ local: executor }));
    expect(await screen.findByText(/станции блоков номеров SSCC, которые она не приняла: 1/)).toBeTruthy();
    await waitFor(() => expect(shown("Не отправлено прежним подключением")).toBe("3"));
  });
```

Помощники `shown`, `politeRegions`, `heardOnce` — этого файла. Прочие тесты файла, которые ищут текст «Номера SSCC на исходе» или «Номера SSCC закончились», переписать на новые тексты (уровни — по размеру блока теста); тест «keeps reading the serials by itself exactly while the warning stands» — порог по уровню, не по 100.

3. `apps/standalone/test/floor-schema.test.ts`: в импорте из `outbox-status.js` заменить `SHIFT_PREFIX_SQL` на `SHIFT_STOCK_SQL` и добавить `BLOCK_DROPS_COUNT_SQL`; во всех местах, где стоит `SHIFT_PREFIX_SQL`, поставить `SHIFT_STOCK_SQL` (ожидание то же: `sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)`); в «serve the reads the floor makes from an index» добавить `expect(plan(BLOCK_DROPS_COUNT_SQL)).toContain("sqlite_autoindex_floor_block_drops_1 (host_id=? AND device_id=?)");` и внести `BLOCK_DROPS_COUNT_SQL` в списки «без SCAN/TEMP» и сверки текстов (`statements`, `new Set(statements).size` +1). Литерал запроса самого нового блока можно заменить на `NEWEST_BLOCK_SQL`.

4. `apps/standalone/src-tauri/tests/local_db.rs`: текст `SHIFT_PREFIX` заменить текстом `SHIFT_STOCK_SQL`; добавить запись `BLOCK_DROPS_COUNT_SQL` → `"sqlite_autoindex_floor_block_drops_1 (host_id=? AND device_id=?)"`; поправить `N`.

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-outbox-status.test.ts test/floor-status-bar.test.tsx test/floor-schema.test.ts`
Expected: FAIL — нет `readShiftStock`, `stockLevel`, `readBlockDrops`; тексты строки состояния старые.

- [ ] **Step 3: Реализация**

1. `apps/standalone/src/floor/work/block-supply.ts`: перед `async function blockWanted` добавить

<!-- prettier-ignore -->
```typescript
/**
 * The newest block of the prefix and extension (the half rule's, and the
 * status bar's measure of the stock); its text is pinned in both query-plan
 * lists. Parameters: host id, device id, prefix, extension.
 */
export const NEWEST_BLOCK_SQL =
  "SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks " +
  "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
  "ORDER BY from_serial DESC LIMIT 1";
```

и в `blockWanted` литерал запроса заменить на `NEWEST_BLOCK_SQL`.

2. `apps/standalone/src/floor/outbox-status.ts`:
   - импорт `import { remainingSerials } from "./work/block-supply.js";` заменить на

<!-- prettier-ignore -->
```ts
import { PALLET_EXTENSION } from "./pallets/pallets.js";
import { BOX_EXTENSION } from "./work/box-close.js";
import { NEWEST_BLOCK_SQL, remainingSerials } from "./work/block-supply.js";
```

(если `pallets.ts` импортирует `outbox-status.ts`, взять литерал `1` с комментарием `// PALLET_EXTENSION`);

- весь хвост файла от `/**\n * The statement that finds the issuer prefix of a shift this pairing entered;` до конца (`SHIFT_PREFIX_SQL`, `prefixRow`, `readSerialsLeft`, `SERIALS_LOW`) заменить на:

<!-- prettier-ignore -->
```typescript
/**
 * The issuer prefix of a shift this pairing entered (`NULL` for a shift it only
 * listed) and whether it has pallets.
 */
export const SHIFT_STOCK_SQL =
  "SELECT snapshot ->> 'issuerPrefix' AS prefix, pallets_enabled FROM floor_shifts " +
  "WHERE host_id = ? AND device_id = ? AND id = ?";

const stockRow = z.object({ prefix: z.string().nullable(), pallets_enabled: z.number().int() });
const newestRow = z.object({
  from_serial: z.number().int(),
  to_serial: z.number().int(),
  next_serial: z.number().int(),
});

/** How low a stock of serials is (pilot spec §9.3, plan ОЧ). */
export type StockLevel = "ok" | "quarter" | "tenth" | "last" | "none";

/** A quarter and a tenth of a block: the thresholds of pilot spec §9.3. */
const QUARTER = 4;
const TENTH = 10;

/**
 * The level of `left` serials against the newest block's size: none, the last
 * one, a tenth of the block or less, a quarter or less. Online the station asks
 * for a block at half (stage 2a spec §5.7.4), so a level below `ok` means the
 * host did not answer, has no serials, or the link is down. Without a block to
 * measure by only the last serial and none say anything.
 */
export function stockLevel(left: number, blockSize: number | null): StockLevel {
  if (left <= 0) return "none";
  if (left === 1) return "last";
  if (blockSize === null || blockSize <= 0) return "ok";
  if (left * TENTH <= blockSize) return "tenth";
  if (left * QUARTER <= blockSize) return "quarter";
  return "ok";
}

export interface SerialStock {
  left: number;
  level: StockLevel;
}

/** The serials of a shift's boxes and, in a shift with pallets, of its pallets. */
export interface ShiftStock {
  boxes: SerialStock;
  pallets: SerialStock | null;
}

async function serialStock(
  local: LocalExecutor,
  pairing: Pairing,
  prefix: string,
  extension: number,
): Promise<SerialStock> {
  const [left, [newest]] = await Promise.all([
    remainingSerials(local, pairing, prefix, extension),
    local.query(NEWEST_BLOCK_SQL, [pairing.hostId, pairing.deviceId, prefix, extension], newestRow),
  ]);
  const size = newest === undefined ? null : newest.to_serial - newest.from_serial + 1;
  return { left, level: stockLevel(left, size) };
}

/**
 * The SSCC serials this pairing has left for a shift it entered, counted the
 * way a close takes them (`remainingSerials`): its boxes', and its pallets'
 * when it has pallets, each with its level; `null` for a shift without a
 * snapshot.
 */
export async function readShiftStock(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ShiftStock | null> {
  const [row] = await local.query(
    SHIFT_STOCK_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    stockRow,
  );
  if (row === undefined || row.prefix === null) return null;
  const boxes = await serialStock(local, pairing, row.prefix, BOX_EXTENSION);
  const pallets =
    row.pallets_enabled === 1
      ? await serialStock(local, pairing, row.prefix, PALLET_EXTENSION)
      : null;
  return { boxes, pallets };
}

/** The blocks the host gave this pairing that the station did not take (plan ОЧ). */
export const BLOCK_DROPS_COUNT_SQL =
  "SELECT count(*) AS n FROM floor_block_drops WHERE host_id = ? AND device_id = ?";

export async function readBlockDrops(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(
    BLOCK_DROPS_COUNT_SQL,
    [pairing.hostId, pairing.deviceId],
    countRow,
  );
  return row?.n ?? 0;
}
```

3. `apps/standalone/src/i18n/ru.json`, в `floor.status`:
   - фрагмент

<!-- prettier-ignore -->
```json
      "serials": "Номеров SSCC",
```

заменить на

<!-- prettier-ignore -->
```json
      "serials": "Номеров SSCC",
      "palletSerials": "Номеров SSCC паллет",
      "stranded": "Не отправлено прежним подключением",
```

- строки `"serialsLow": …` и `"serialsNone": …` заменить на

<!-- prettier-ignore -->
```json
      "stock": {
        "box": {
          "quarter": "Номеров SSCC для коробов осталось {{n}} — меньше четверти блока. Новые номера выдаёт хост: станция должна быть с ним на связи.",
          "tenth": "Номеров SSCC для коробов осталось {{n}} — меньше десятой части блока. Без связи с хостом короба скоро не закрыть.",
          "last": "Остался последний номер SSCC для коробов: следующий короб без связи с хостом не закрыть.",
          "none": "Номера SSCC для коробов закончились: короб не закрыть, пока хост не выдаст станции новый блок. Нужна связь с хостом."
        },
        "pallet": {
          "quarter": "Номеров SSCC для паллет осталось {{n}} — меньше четверти блока. Новые номера выдаёт хост: станция должна быть с ним на связи.",
          "tenth": "Номеров SSCC для паллет осталось {{n}} — меньше десятой части блока. Без связи с хостом полную паллету скоро не закрыть.",
          "last": "Остался последний номер SSCC для паллет: следующую полную паллету без связи с хостом не закрыть.",
          "none": "Номера SSCC для паллет закончились: полную паллету не закрыть, пока хост не выдаст станции новый блок. Нужна связь с хостом."
        }
      },
      "blockDrops": "Хост выдал станции блоков номеров SSCC, которые она не приняла: {{n}}. Они пересекаются с уже полученными номерами или не того префикса — станция их не использует. Сообщите администратору: возможно, хост восстановлен или переустановлен без копии.",
```

4. `apps/standalone/src/floor/FloorStatusBar.tsx`:
   - импорт из `./outbox-status.js` заменить на

<!-- prettier-ignore -->
```ts
import { readStrandedRecords } from "./queue/outbox-recovery.js";
import {
  readBlockDrops,
  readDeliveryStuck,
  readOutboxStatus,
  readShiftStock,
  waitUnits,
  type DeliveryStuck,
  type OutboxStatus,
  type SerialStock,
  type ShiftStock,
} from "./outbox-status.js";
```

- после функции `stuckText` добавить

<!-- prettier-ignore -->
```tsx
/** The warning of a stock of serials below `ok`, in the tone its level calls for. */
function stockAlert(t: TFunction, what: "box" | "pallet", stock: SerialStock) {
  if (stock.level === "ok") return null;
  return (
    <Alert tone={stock.level === "last" || stock.level === "none" ? "error" : "warn"} role="presentation">
      {t(`floor.status.stock.${what}.${stock.level}`, { n: formatQuantity(stock.left) })}
    </Alert>
  );
}
```

- блок от `const [serials, setSerials] = useState<{ shiftId: string; left: number | null } | null>(null);` до `const serialsRunningOut = serialsLeft !== null && serialsLeft <= SERIALS_LOW;` включительно заменить на

<!-- prettier-ignore -->
```tsx
  const [stock, setStock] = useState<{ shiftId: string; stock: ShiftStock | null } | null>(null);
  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readShiftStock(local, { hostId, deviceId }, shiftId).then(
      (next) => {
        if (!cancelled) setStock({ shiftId, stock: next });
      },
      () => {
        if (!cancelled) setStock(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, outboxVersion, tick]);
  // Only the shift on screen's serials: none after it is left.
  const shiftStock = stock !== null && stock.shiftId === shiftId ? stock.stock : null;
  const serialsRunningOut =
    shiftStock !== null &&
    (shiftStock.boxes.level !== "ok" ||
      (shiftStock.pallets !== null && shiftStock.pallets.level !== "ok"));

  // The blocks the host gave and the station did not take (plan ОЧ), read with
  // the outbox; the records an older pairing left unsent, read once per pairing
  // (a walk of every pairing's unsent records, too dear for every scan).
  const [drops, setDrops] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readBlockDrops(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setDrops(next);
      },
      () => {
        if (!cancelled) setDrops(0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);
  const [stranded, setStranded] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readStrandedRecords(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setStranded(next);
      },
      () => {
        if (!cancelled) setStranded(0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId]);
```

- фрагмент

<!-- prettier-ignore -->
```tsx
        {serialsLeft !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.serials")}</dt>
            <dd>{formatQuantity(serialsLeft)}</dd>
          </div>
        )}
```

заменить на

<!-- prettier-ignore -->
```tsx
        {shiftStock !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.serials")}</dt>
            <dd>{formatQuantity(shiftStock.boxes.left)}</dd>
          </div>
        )}
        {shiftStock !== null && shiftStock.pallets !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.palletSerials")}</dt>
            <dd>{formatQuantity(shiftStock.pallets.left)}</dd>
          </div>
        )}
```

- после пункта `floor.status.conflicts` (закрывающий `)}` его блока) добавить

<!-- prettier-ignore -->
```tsx
        {stranded > 0 && (
          <div className="floor-status__item">
            <dt>{t("floor.status.stranded")}</dt>
            <dd>{formatQuantity(stranded)}</dd>
          </div>
        )}
```

- фрагмент от `{serialsLeft !== null && serialsLeft === 0 && (` до закрывающего `)}` предупреждения `serialsLow` заменить на

<!-- prettier-ignore -->
```tsx
          {shiftStock !== null && stockAlert(t, "box", shiftStock.boxes)}
          {shiftStock !== null &&
            shiftStock.pallets !== null &&
            stockAlert(t, "pallet", shiftStock.pallets)}
          {drops > 0 && (
            <Alert tone="error" role="presentation">
              {t("floor.status.blockDrops", { n: formatQuantity(drops) })}
            </Alert>
          )}
```

- в докстроке компонента после «and how many blocks it refused (their serials are no longer used), read with the outbox.» дописать: «Plan ОЧ: the serials of the boxes and, in a shift with pallets, of the pallets, warned at a quarter and a tenth of the newest block, at the last serial and at none; the blocks the host gave that the station did not take; and, as an item, the records an older pairing left unsent.»

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2 + `test/floor-app.test.tsx test/app.test.tsx` (`--reporter=verbose`, затем под стендом) и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`
Expected: PASS; `grep -rn "SERIALS_LOW\|readSerialsLeft\|SHIFT_PREFIX_SQL\|serialsLow\|serialsNone" apps/standalone/src apps/standalone/test` — пусто.

- [ ] **Step 5: Коммит**

Пути: четыре файла `src/…` и четыре теста задачи. Сообщение: `feat(standalone): the floor's status bar warns of the boxes' and pallets' serials at a quarter, a tenth and the last of a block, of blocks the station did not take, and names records an older pairing left (plan ОЧ)` + трейлер.

---

### Task 6: Честные сигналы доставки — непринятый блок записывается, попытки считают повторы

**Files:**

- Modify: `apps/standalone/src/floor/work/block-supply.ts`, `apps/standalone/src/app/host-link.ts`
- Test: `apps/standalone/test/floor-block-supply.test.ts`, `apps/standalone/test/host-link-facts.test.ts`

**Interfaces:**

- Produces: строки `floor_block_drops` (`reason` `overlap` / `mismatch`) в транзакции, удаляющей запрос; `HostLinkControls.requestFacts` не обрывает паузу после сбоя.

- [ ] **Step 1: Тесты — сначала они**

1. `apps/standalone/test/floor-block-supply.test.ts`:
   - в тест «keeps no block of another prefix or extension than it asked for» после `expect(requests(db)).toEqual([]);` добавить

<!-- prettier-ignore -->
```typescript
    // Kept for the status bar and support (plan ОЧ): the host's block, once per id.
    expect(
      rows(db, "SELECT block_id, issuer_prefix, extension, from_serial, to_serial, reason FROM floor_block_drops"),
    ).toEqual([
      { block_id: BLOCK_ID, issuer_prefix: "460068201", extension: 0, from_serial: 3500, to_serial: 5499, reason: "mismatch" },
    ]);
```

- в тест «is not kept when it shares a serial with a block already kept, and the request goes» в цикл после `expect(requests(db)).toEqual([]);` добавить

<!-- prettier-ignore -->
```typescript
      expect(rows(db, "SELECT block_id, reason FROM floor_block_drops"), `${from}-${to}`).toEqual([
        { block_id: BLOCK_ID, reason: "overlap" },
      ]);
      db.prepare("DELETE FROM floor_block_drops").run();
```

- новый тест рядом:

<!-- prettier-ignore -->
```typescript
  it("keeps nothing of a request the host refused on requestId: no block came (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    const supply = createBlockSupply(
      supplyContext(executor, {
        requestBlock: async () => {
          throw refusal("validation_failed");
        },
      }),
    );
    await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    expect(rows(db, "SELECT count(*) AS n FROM floor_block_drops")).toEqual([{ n: 0 }]);
  });
```

(Если `refusal` строит `HostError` без `field`, тест всё равно проверяет: отказ `validation_failed` блок не пишет.)

2. `apps/standalone/test/host-link-facts.test.ts`: тест «sends at once when a screen asks during a pause, and the pause it cut short does not send again» заменить на

<!-- prettier-ignore -->
```typescript
  it("waits out a failed send's pause when a screen asks during it: the pause sends, so attempts count retries, not scans (plan ОЧ)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => Promise.reject(DOWN()), HOST_ID, 1);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await elapse(800);
    station.hook.result.current.requestFacts();
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    // The first pause (2 s) ends here and sends once.
    await elapse(1_300);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(2));
    expect(rows(station.db, "SELECT attempts FROM outbox")).toEqual([{ attempts: 2 }]);
    station.hook.unmount();
  });
```

(`DOWN`, `elapse`, `settle`, `rows` — этого файла; если `rows` не импортирован, добавить импорт из `./support/floor-work.js`.)

- [ ] **Step 2: Запустить — должны упасть**

Run: `pnpm --filter @markiro/standalone exec vitest run test/floor-block-supply.test.ts test/host-link-facts.test.ts`
Expected: FAIL — `floor_block_drops` пуста; `send` вызван 3 раза.

- [ ] **Step 3: Реализация**

1. `apps/standalone/src/floor/work/block-supply.ts`:
   - после функции `dropRequest` добавить

<!-- prettier-ignore -->
```typescript
/**
 * A block the station does not keep, kept for the status bar and support with
 * why (plan ОЧ), in the transaction that drops its request: a block another
 * answer to the same request brings again is kept once.
 */
async function dropBlock(
  context: BlockContext,
  request: SsccBlockRequest,
  block: SsccBlock,
  reason: "overlap" | "mismatch",
): Promise<void> {
  await context.local.transaction([
    {
      sql:
        "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (host_id, device_id, block_id) DO NOTHING",
      values: [
        context.pairing.hostId,
        context.pairing.deviceId,
        block.id,
        request.requestId,
        block.issuerPrefix,
        block.extension,
        block.fromSerial,
        block.toSerial,
        reason,
        context.now().toISOString(),
      ],
    },
    { sql: "DELETE FROM floor_block_requests WHERE request_id = ?", values: [request.requestId] },
  ]);
}
```

- фрагмент

<!-- prettier-ignore -->
```ts
    if (
      block.issuerPrefix !== request.issuerPrefix ||
      block.extension !== request.extension ||
      block.toSerial < block.fromSerial ||
      (await sharesSerials(context, block))
    ) {
      // Not the block asked for, or one that shares serials with a block kept
      // (a serial would label two boxes): never filed, and never asked for again.
      await dropRequest(context, request.requestId);
      return { kind: "failed" };
    }
```

заменить на

<!-- prettier-ignore -->
```ts
    const mismatch =
      block.issuerPrefix !== request.issuerPrefix ||
      block.extension !== request.extension ||
      block.toSerial < block.fromSerial;
    if (mismatch || (await sharesSerials(context, block))) {
      // Not the block asked for, or one that shares serials with a block kept
      // (a serial would label two boxes): never filed, never asked for again,
      // and kept with why for the status bar and support (plan ОЧ).
      await dropBlock(context, request, block, mismatch ? "mismatch" : "overlap");
      return { kind: "failed" };
    }
```

- докстроки: в `SupplyResult` «that request is dropped, and nothing but this result says so.» заменить на «that request is dropped, and the block is kept in `floor_block_drops` for the status bar (plan ОЧ); a `validation_failed` brings no block and leaves no row.»; в `createBlockSupply` «with no report through `onHostError` (a screen for it belongs to the queue, plan ОЧ)» заменить на «with no report through `onHostError`: the block goes to `floor_block_drops`, and the floor's status bar says how many (plan ОЧ)».

2. `apps/standalone/src/app/host-link.ts`:
   - фрагмент

<!-- prettier-ignore -->
```ts
    factsNow.current = () => factSender.trigger();
```

заменить на

<!-- prettier-ignore -->
```ts
    // A screen's request after a local write sends at once, unless a failed
    // send's pause runs: that pause sends, so `attempts` counts retries and not
    // scans (plan ОЧ; final review of plan 2a6, m8). Going online, a revision
    // and the pause's end still send at once.
    factsNow.current = () => {
      if (factRetry !== null) return;
      factSender.trigger();
    };
```

- в `HostLinkControls` комментарий `requestFacts` заменить на `/** Sends the outbox now (after a local write); nothing goes while the link is stopped or not online, or while a failed send's pause runs (its end sends). */`;
- в докстроке `useHostLink` «and whenever a screen asks after a local write;» заменить на «and whenever a screen asks after a local write — unless a failed send's pause runs, whose end sends (plan ОЧ);».

- [ ] **Step 3a: Соседние тесты**

`grep -n "requestFacts()" apps/standalone/test/*.ts*` — тесты, которые просят отправку во время паузы и ждут немедленной отправки, переписать на ожидание конца паузы (в отклонения — какие).

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2 + `test/host-link-restore.test.ts test/floor-work-screen.test.tsx test/app.test.tsx` (`--reporter=verbose`, затем под стендом).
Expected: PASS.

Мутации: `if (factRetry !== null) return;` убрать — падает новый тест; `"mismatch" : "overlap"` поменять местами — падают тесты сброса.

- [ ] **Step 5: Коммит**

Пути: `src/floor/work/block-supply.ts`, `src/app/host-link.ts`, оба теста (и переписанные соседние). Сообщение: `fix(standalone): a block the station does not take is kept and shown, and a screen's request no longer cuts a failed send's pause, so attempts count retries (plan ОЧ)` + трейлер.

---

### Task 7: «Вернула» по последней части — `more` в протоколе, пустой последний запрос, хост отмечает станцию в конце

**Files:**

- Modify: `apps/standalone/proto/src/backup.rs`, `apps/standalone/host/src/routes/known_blocks.rs`, `apps/standalone/src/host/backups.ts`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/src/i18n/ru.json`
- Create: `apps/standalone/proto/fixtures/known-blocks-request-more.json`
- Test: `apps/standalone/proto/tests/backup.rs`, `apps/standalone/host/tests/known_blocks.rs`, `apps/standalone/test/backups.test.ts`, `apps/standalone/test/restore-reconcile.test.ts`, `apps/standalone/test/host-link-restore.test.ts`, `apps/standalone/test/backups-page.test.tsx`

**Interfaces:**

- Produces: `KnownBlocksRequest { blocks, more: bool }` (`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`); Zod `knownBlocksRequestSchema` с `more: z.boolean().optional()`; хост: 0–64 блока, пустой — только при `more` нет, отметка `known_blocks_epoch` — только без `more`; станция: `more: true` во всех частях, кроме последней; без блоков — один запрос `{ blocks: [] }`.

- [ ] **Step 0: Что уже сделал ХП**

Открыть `host/src/routes/known_blocks.rs`: если проверка уже `0-64` (ХП принял пустой список), шаги про пустой список (тест хоста `vec![]`, станция без блоков) уже могут быть сделаны — оставить их и добавить только `more`; записать в отклонения.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/proto/fixtures/known-blocks-request-more.json`:

<!-- prettier-ignore -->
```json
{
  "blocks": [
    {
      "id": "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "issuerPrefix": "460068200",
      "extension": 0,
      "fromSerial": 3500,
      "toSerial": 5499
    }
  ],
  "more": true
}
```

2. `apps/standalone/proto/tests/backup.rs`, в `known_blocks_round_trip_and_the_request_is_strict` после `assert_eq!(request.blocks[0].to_serial, 5499);` добавить

```rust
    assert!(!request.more, "a request without the field is the last part");
    let part: KnownBlocksRequest = round_trip("known-blocks-request-more.json");
    assert!(part.more);
    let empty: KnownBlocksRequest = serde_json::from_value(json!({ "blocks": [] })).unwrap();
    assert!(empty.blocks.is_empty() && !empty.more);
```

3. `apps/standalone/test/backups.test.ts`, в «read the known blocks a station sends and the host's answer» добавить

<!-- prettier-ignore -->
```typescript
    expect(knownBlocksRequestSchema.parse(fixture("known-blocks-request-more.json")).more).toBe(true);
    expect(knownBlocksRequestSchema.parse({ blocks: [] })).toEqual({ blocks: [] });
    expect(knownBlocksRequestSchema.safeParse({ blocks: [], more: "yes" }).success).toBe(false);
```

4. `apps/standalone/host/tests/known_blocks.rs`:
   - в `only_a_station_after_a_restore_is_heard` из списка случаев проверки удалить `(vec![], "blocks"),` (пустая последняя часть теперь допустима);
   - добавить помощник и тест:

```rust
async fn send_part(admin: &Admin, key: &str, blocks: Vec<Value>, more: bool) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), key),
            json!({ "blocks": blocks, "more": more }),
        ))
        .await
}

#[tokio::test]
async fn a_station_is_marked_by_its_last_part_only_and_an_empty_last_part_marks_one_without_blocks() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let known_epoch = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT known_blocks_epoch FROM devices WHERE id = ?",
        )
        .bind(&station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    let (status, body) = send_part(&admin, &admin.key, vec![issued.clone()], true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(known_epoch().await, None, "a part with more to come marks nothing");
    let (status, body) = send_part(&admin, &admin.key, vec![], true).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("blocks")),
        "an empty part is only the last one"
    );
    let (status, body) = send_part(&admin, &admin.key, vec![], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"], json!([]));
    assert_eq!(
        known_epoch().await.as_deref(),
        Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
    );
}
```

5. `apps/standalone/test/restore-reconcile.test.ts`:
   - в «sends every block of the pairing as the host issued it, in requests of 64» после `expect(sent.map((request) => request.blocks.length)).toEqual([64, 1]);` добавить `expect(sent.map((request) => request.more ?? false)).toEqual([true, false]);`;
   - в «asks the next sync to start from zero and sends the records of the last 30 days again» строки

<!-- prettier-ignore -->
```ts
    // No block: nothing to ask the host.
    expect(register).not.toHaveBeenCalled();
```

заменить на

<!-- prettier-ignore -->
```ts
    // No block: one empty last part, so the office sees this station returned all it had.
    expect(register.mock.calls.map(([request]) => request)).toEqual([{ blocks: [] }]);
```

- другие тесты, которые для подключения без блоков ждут `register` не вызванным (сюда же `test/host-link-restore.test.ts`, где `station.register` «not called» при обязательстве), переписать на один пустой запрос; тесты без обязательства (нет новой эпохи) не трогать.

6. `apps/standalone/test/backups-page.test.tsx`: закреплённые тексты `blocksNote`/`confirmNoBlocks` заменить новыми (п. 4 шага 3).

- [ ] **Step 2: Запустить — должны упасть**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test backup`, `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`, `pnpm --filter @markiro/standalone exec vitest run test/backups.test.ts test/restore-reconcile.test.ts test/host-link-restore.test.ts test/backups-page.test.tsx`
Expected: FAIL — нет поля `more` (`unknown field`), пустой список — 400, станция не шлёт пустой запрос.

- [ ] **Step 3: Реализация**

1. `apps/standalone/proto/src/backup.rs`, фрагмент

```rust
pub struct KnownBlocksRequest {
    pub blocks: Vec<KnownBlock>,
}
```

заменить на

```rust
pub struct KnownBlocksRequest {
    pub blocks: Vec<KnownBlock>,
    /// More parts of this run follow (plan ОЧ): the host marks the station as
    /// having sent its blocks only on the last part, which may be empty — a
    /// station that never got a block sends one empty last part. Absent means
    /// last, as every request before the field was.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
}
```

Найти и дополнить `more: false` все литералы `KnownBlocksRequest { … }` в `host/`, `proto/`, `src-tauri/` (`grep -rn "KnownBlocksRequest {" apps/standalone`).

2. `apps/standalone/host/src/routes/known_blocks.rs`:
   - в модульной докстроке «The station is marked as having sent its blocks for the current epoch (`devices.known_blocks_epoch`)» дописать «— on the last part of its run only (`more` absent; plan ОЧ), which may be empty for a station that never got a block»; «at most [`MAX_BLOCKS`] blocks» → «0 to [`MAX_BLOCKS`] blocks, none only in the last part»;
   - фрагмент

```rust
    if request.blocks.is_empty() || request.blocks.len() > MAX_BLOCKS {
        return Err(ApiError::validation("blocks", "1-64 blocks"));
    }
```

заменить на

```rust
    if request.blocks.len() > MAX_BLOCKS || (request.blocks.is_empty() && request.more) {
        return Err(ApiError::validation(
            "blocks",
            "0-64 blocks, none only in the last part",
        ));
    }
```

- фрагмент

```rust
    // The station gave its blocks back for this epoch, whatever became of
    // each: the office lists the stations that did not yet.
    let marked = sqlx::query(
```

заменить на

```rust
    // The station gave its blocks back for this epoch, whatever became of
    // each, once its last part is in (plan ОЧ): the office lists the stations
    // that did not yet.
    let marked = if request.more {
        0
    } else {
        sqlx::query(
```

и после `.rows_affected();` этого запроса закрыть ветку: `.rows_affected()\n    };` (точка с запятой после `}`); отступы — `cargo fmt`.

3. `apps/standalone/src/host/backups.ts`, фрагмент

<!-- prettier-ignore -->
```ts
export const knownBlocksRequestSchema = z.object({ blocks: z.array(knownBlockSchema) }).strict();
```

заменить на

<!-- prettier-ignore -->
```ts
export const knownBlocksRequestSchema = z
  .object({
    blocks: z.array(knownBlockSchema),
    /** More parts of this run follow; absent — the last part (plan ОЧ). */
    more: z.boolean().optional(),
  })
  .strict();
```

и в докстроке над ним дописать «, in parts of 64; the host marks the station on the last part, which may be empty».

4. `apps/standalone/src/local/restore-reconcile.ts`, в `reconcileRestore` фрагмент

<!-- prettier-ignore -->
```ts
  for (let start = 0; start < blocks.length; start += MAX_KNOWN_BLOCKS) {
    const chunk = blocks.slice(start, start + MAX_KNOWN_BLOCKS);
    let answer: KnownBlocksResponse;
    try {
      answer = await register({
        blocks: chunk.map((block) => ({
          id: block.block_id,
          issuerPrefix: block.issuer_prefix,
          extension: block.extension,
          fromSerial: block.from_serial,
          toSerial: block.to_serial,
        })),
      });
```

заменить на

<!-- prettier-ignore -->
```ts
  // Parts of 64 in the order the blocks arrived; a pairing without blocks
  // sends one empty part. Every part but the last says `more`, so the host
  // marks the station only once all of them are in (plan ОЧ).
  const chunks: (typeof blocks)[] = [];
  for (let start = 0; start < blocks.length; start += MAX_KNOWN_BLOCKS) {
    chunks.push(blocks.slice(start, start + MAX_KNOWN_BLOCKS));
  }
  if (chunks.length === 0) chunks.push([]);
  for (const [index, chunk] of chunks.entries()) {
    const more = index < chunks.length - 1;
    let answer: KnownBlocksResponse;
    try {
      answer = await register({
        blocks: chunk.map((block) => ({
          id: block.block_id,
          issuerPrefix: block.issuer_prefix,
          extension: block.extension,
          fromSerial: block.from_serial,
          toSerial: block.to_serial,
        })),
        ...(more ? { more: true } : {}),
      });
```

В докстроке `reconcileRestore` п. 1 «every block it holds goes back, 64 to a request, as the host issued it;» дополнить «every request but the last says `more`, and a pairing without blocks sends one empty request (plan ОЧ);»; последнюю фразу «Nothing is asked of the host for a pairing without blocks.» удалить.

5. `apps/standalone/src/i18n/ru.json`, `office.backups.hold`:

<!-- prettier-ignore -->
```json
        "blocksNote": "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Отметка «Вернула» ставится, когда хост получил последнюю часть её блоков, — даже если какие-то блоки отклонил; отклонённые блоки видны только в строке состояния самой станции. Станция, которая ещё не получала блоков SSCC, тоже получает «Вернула»: она сообщает хосту, что возвращать ей нечего. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
```

<!-- prettier-ignore -->
```json
        "confirmNoBlocks": "Станция «Не вернула» ещё не выходила на связь после восстановления или работает на выключенном компьютере: по ней сверьте счётчики и блоки по памятке.",
```

Докстроку `BackupsPage.tsx` («first accepted part» / «первой части») поправить на «the last part» — только комментарий.

- [ ] **Step 4: Запустить — должны пройти**

Run: шаг 2 + `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold --test restore` и `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
Expected: PASS.

Мутации: (a) отмечать станцию при `more` (`let marked = …` без ветки) — падает новый тест хоста; (b) у станции `more` на всех частях — падает тест порядка частей.

- [ ] **Step 5: Коммит**

Пути: `proto/src/backup.rs`, `proto/fixtures/known-blocks-request-more.json`, `proto/tests/backup.rs`, `host/src/routes/known_blocks.rs`, `host/tests/known_blocks.rs`, `src/host/backups.ts`, `src/local/restore-reconcile.ts`, `src/i18n/ru.json`, (`src/office/backups/BackupsPage.tsx`), `test/backups.test.ts`, `test/restore-reconcile.test.ts`, `test/host-link-restore.test.ts`, `test/backups-page.test.tsx`. Сообщение: `feat(standalone): the office marks a station «Вернула» on the last part of its blocks, and a station without blocks says so with an empty last part (plan ОЧ, protocol field more)` + трейлер.

---

### Task 8: Документы — `AGENTS.md`, памятка о восстановлении, раздел 27 спецификации пилота; полная проверка

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

1. Раздел «Facts», фрагмент

```markdown
record stays, with its code, for the queue screen of the pilot (plan ОЧ, not
built yet). The host keeps a refusal for good and answers the same record id
with it again, so a refused record is never sent again under its id: sending it
again is a person's act that writes the refused record and its refused
dependents again under new ids, in their order.
```

заменить на

```markdown
record stays, with its code, for the queue screen («Очередь отправки», plan
ОЧ; see «Outbox recovery»). The host keeps a refusal for good and answers the
same record id with it again, so a refused record is never sent again under
its id: sending it again is a person's act on the queue screen that writes the
shift's refused records again under new ids, data byte for byte, in their
order. An `accepted` of a scan that was in conflict takes the marks off again.
```

2. Раздел «Floor exceptions and close», «Known limits of the retention»: пункт «A refused or conflicting record of a shift whose close was accepted is purged with it after 30 days…» заменить на

```markdown
- A refused or conflicting record keeps its shift until a person resolves it
  on the queue screen (plan ОЧ): `DUE_SHIFTS_SQL` and `PURGE_COPY_SQL` take a
  shift only when none of its `rejected`/`conflict` records has
  `resolved_at IS NULL`. The outbox has no quarantined state; the reference
  copies' `sync_quarantine` is not a shift's and the retention never reads it.
```

(Если ХП уже переписал пункт об индексе по `shift_id` — его не трогать.)

3. Перед «## Floor pallets» вставить раздел:

```markdown
## Outbox recovery

Plan ОЧ. «Очередь отправки» (`src/floor/queue/QueueScreen.tsx`) opens from
the shift list beside «Рабочее место» (never from the status bar, which holds
nothing to press), so no work of a shift runs while it writes. It shows the
link (`HostStatusLine`), this pairing's records waiting for the host by kind
with the oldest one's wait, its refused records by shift with the reason in
words (`floor.queue.code.*`, one per `FACT_RECEIPT_CODES` entry; a test fails
for a code without words) and its conflicts — never a code of marking, only the
SSCC of the box or pallet a record names — and the records an older pairing
left unsent.

A person resolves them (`src/floor/queue/outbox-recovery.ts`, migration
`0013`), always after a confirmation that says what follows and takes the
focus, and the row keeps who and when (`resolution`, `resolved_by`,
`resolved_at`):

- «Отправить снова» (`resendRefused`) writes every unresolved refused record of
  the shift again under a new id, its payload byte for byte but the id, after
  everything kept and in the old `seq` order, in parts of `RESEND_CHUNK` (50);
  each old record is marked `resent` with `resent_as` in the transaction that
  writes the new one. The insert goes past `outboxStatement`'s check: a record
  sent again after its shift's close is late by definition (the host marks the
  shift late). A refused close goes the same way and its `accepted` makes the
  shift `closed`. A record this build cannot carry unchanged
  (`UnreadableRecordError`) stops the whole shift before anything is written; a
  record resolved meanwhile is a `StaleQueueError` and the screen reads again.
  A late exception is harmless only because the host matches an undo by its
  `targetScannedAt` and a clear by its cutoff (plan 2a2).
- «Снять с очереди» (a refused record) and «Разобрано» (a conflict) —
  `dismissRecord` — mark the record `dismissed`; a shift's close cannot be
  taken off (its card names the refusal; the office closes the shift).

A resolved record no longer counts on the status bar, is not named as a
refused close, is not reopened by a restore's reconciliation (`REOPEN_SQL`),
and no longer holds its shift from the retention. A scan sent again under a new
id leaves the floor's marks of the original as they were.

The status bar also warns of the serials left (`readShiftStock`): the boxes'
and, in a shift with pallets, the pallets', at a quarter and a tenth of the
newest block of that prefix and extension, at the last serial and at none
(pilot spec §9.3); it says how many blocks the host gave that the station did
not take (`floor_block_drops`: a block that shares serials with one kept —
`overlap` — or is not the one asked for — `mismatch`; written with the drop of
its request, `TableClass::DeviceData`), and names, as an item, the records an
older pairing left unsent (read once per pairing). A screen's request to send
after a local write does not cut a failed send's pause short, so the stuck
line's attempts count retries.
```

4. Раздел «Backups and restore»: «the host sets the flag on the first part of a station's blocks it takes.» → «the host sets the flag on the last part of a station's blocks (`more` absent), which is empty for a station that never got a block.»; «Only a station, only after a restore (`conflict` on `no_restore`), 1-64 blocks.» → «Only a station, only after a restore (`conflict` on `no_restore`), 0–64 blocks, none only in the last part; every part but the last says `more`.»; в «Left open» удалить два первых пункта («A pairing without blocks never calls the route…», «The host sets `reconciled` on the FIRST part…») и пункт о строке записей прежнего подключения, если он есть.

5. Раздел «Local database»: счёт таблиц («Of the 24 tables 12 are `Disposable`» или текущий после ХП/I1) увеличить на одну таблицу `DeviceData` (`floor_block_drops`); в перечне миграций оболочки добавить `0013_outbox_recovery.sql`.

- [ ] **Step 2: `docs/runbooks/standalone-backup-restore.md`**

1. Фрагмент проверки 5

```markdown
- в «Резервные копии» у станции «Вернула». Оговорки: отметку хост ставит, получив **первую часть**
  блоков станции и ответив на неё (по 64 в запросе, старые блоки идут первыми), — даже если какие-то
  или все блоки этой части он отклонил; отказы видны только в строке состояния станции. У станции с
  многими блоками «Вернула» может появиться раньше, чем вернулись самые новые; станция, у которой
  блоков не было вовсе, и станция, подключённая заново на новом ПК, остаются «Не вернула», хотя
  возвращать им нечего (хост пока не принимает пустой список блоков).
```

заменить на

```markdown
- в «Резервные копии» у станции «Вернула». Отметку хост ставит, получив **последнюю часть** блоков
  станции (по 64 в запросе), — даже если какие-то блоки он отклонил; отказы видны только в строке
  состояния станции. Станция без блоков отправляет один пустой запрос и тоже получает «Вернула».
```

2. Фрагмент «Станция без блоков и отметка «Вернула»» (пункт со словами «хост принимает от 1 до 64 блоков») заменить на: «- **Отметка «Вернула».** Хост ставит её на последней части блоков станции; станция без блоков отправляет пустую последнюю часть.»

3. В разделе о сбросе подключения (§8, «Сброс подключения…») дописать абзац: «Если сброс сделан с «Сбросить всё равно», строка состояния станции показывает «Не отправлено прежним подключением: N», а экран «Очередь отправки» объясняет, что эти записи на хост не уйдут и хранятся на диске ПК. Запишите N в журнал восстановления.»

4. В проверке 5 после абзаца о строке «Блоков номеров SSCC, которые хост не принял…» дописать: «Отказы хоста по записям смен после восстановления видны на экране «Очередь отправки» (кнопка в списке смен): записи смен, которых копия не знает (`unknown_shift`, `not_entered`), отправлять снова бесполезно — снимите их с очереди после сверки с офисом.»

- [ ] **Step 3: Раздел 27 спецификации пилота**

В конец `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` добавить (после разделов 25 и 26 планов ХП и I1):

```markdown
## 27. Уточнения плана ОЧ

План `docs/superpowers/plans/2026-10-11-standalone-och-outbox-recovery.md`.

- **Экран «Очередь отправки»** (уточнение §9.3): вход — кнопка в списке смен рядом с «Рабочее
  место», а не из строки состояния (в строке нечего нажимать); экран не только читает —
  «Отправить снова» (отклонённые записи смены целиком, новые `id`, `data` байт в байт, прежний
  порядок `seq`), «Снять с очереди» (отказ, кроме закрытия смены) и «Разобрано» (конфликт) — после
  подтверждения, с отметкой, кто и когда. Без связи действия только ставят записи в очередь.
- **Хранение.** Отказ и конфликт держат смену до разбора человеком; решение 31 (30 дней после
  принятого закрытия) — для остального. Сверка после восстановления хоста разобранное не открывает.
- **Пометки конфликта** снимает принятая квитанция той же записи.
- **Запас SSCC** — пороги §9.3 от размера самого нового блока того же префикса и расширения: 25 %,
  10 %, последний номер, ноль; для коробов всегда, для паллет — в смене с паллетами. Прежний порог
  «100 номеров» снят.
- **Непринятый блок** (пересекается с полученным или не тот) хранится в базе станции и виден
  ошибкой в строке состояния до сброса подключения.
- **Попытки отправки** считают повторы: без связи очередь не отправляется (РК-С), а просьба экрана
  во время паузы после сбоя паузу не обрывает.
- **«Вернула»** — по последней части блоков (поле `more` запроса известных блоков); станция без
  блоков отправляет пустую последнюю часть и тоже получает «Вернула».
- **Записи прежнего подключения** — пункт строки состояния и абзац экрана очереди; на хост они не
  уходят (при I1 = вариант 1 восстановление на новом ПК подключение сохраняет).
- **Миграции:** оболочка `0013_outbox_recovery.sql`; схема хоста не меняется.
- **Не сделано:** ожидание номеров паллет внутри очереди работ (m11 ПЛ-Ц), повтор досрочного
  закрытия паллеты без «Повторить» (m12), поштучная повторная отправка, отправка записей прежнего
  подключения, список отклонённых записей в карточке смены офиса.
```

Если номера 25/26 к исполнению не заняты, раздел всё равно 27 (распределение контроллера).

- [ ] **Step 4: Полная проверка**

Run (из корня дерева):

```bash
pnpm turbo run build --filter='@markiro/standalone^...'
pnpm --filter @markiro/standalone test
pnpm --filter @markiro/standalone typecheck
pnpm --filter @markiro/standalone lint
pnpm --filter @markiro/standalone build
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks --test restore --test restore_hold --test floor_scenario
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/runbooks/standalone-backup-restore.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git diff --check
```

Expected: всё зелёное; известные тайм-ауты `template-editor` под загрузкой — назвать в отчёте, не скрывать. Гейт `cargo test --workspace` — частями, как в прежних планах.

- [ ] **Step 5: Коммит**

Пути: три документа. Сообщение: `docs(standalone): plan ОЧ in AGENTS, the restore runbook and the pilot spec §27` + трейлер. Затем `graphify update .`, если граф есть в дереве.

---

## Итоговая проверка плана

- Пункты из источников покрыты: 1 → задачи 3–4; 2 → О1, задача 3 (`data` байт в байт); 3 → задача 2; 4 → задача 2; 5 → задача 6 (+ РК-С); 6 → задачи 1, 5, 6; 7 → задача 5; 8 → задача 7; 9 → задачи 3, 5.
- Каждый новый оператор над `outbox`, `floor_scans`, `floor_boxes`, `floor_block_drops` закреплён в обоих списках планов (задачи 2, 3, 5).
- Миграция одна — оболочки `0013`; хост `0014` не занят.

## Перенесено

- **Ожидание номеров паллет внутри очереди работ** (`plc-final-review-report.md` m11): `settlePallet` ждёт `palletSupply.topUp()` в очереди работ до 2 × 10 с при зависшем хосте — поведение для владельца или плана 2b.
- **Досрочное закрытие паллеты теряет один номер на «Повторить»** (m12, ВЦ2) — по просьбе владельца.
- **Поштучная повторная отправка** и **снятие отказанного закрытия** — по просьбе владельца (О1, О3).
- **Пометки пола для скана, отправленного снова под новым `id`** — нет (О6); судьба записи — на экране очереди.
- **Отправка записей прежнего подключения** (I1 вариант 2, rk-minors 11) — вне плана.
- **Отклонённые записи в карточке смены офиса** (О-Ф, Ф7) — отдельный план.
- **Коды отклонённых блоков восстановления на экране очереди** (`floor_restore_epochs.refused_blocks`) — поддержка читает базу; экран — по просьбе.
- **Проверка часов станции перед сроком хранения** (`2a8-addenda.md` M3) и **след неудачного прохода срока хранения** (M4) — план 2b / журнал процесса этапа 5.
- **Экран «обновите хост»** на `protocol_unsupported` (2a6 «Перенесено») — план 5.

## Не проверено (без Windows и оборудования)

- Экран очереди и строка состояния в WebView2 на сенсорной панели: касание ≥ 64 px, фокус подтверждения, читаемость длинных строк; `Button size="floor"` закреплён контрактом `tools/production-browser`, который этот план не запускает.
- Настоящий отказ хоста и «Отправить снова» после устранения причины на двух ПК; восстановление хоста с пустой последней частью блоков — по памятке, раздел 10.
- Планы запросов на SQLite 3.46 проверяются тестом оболочки на машине разработчика, не на Windows.

## Отклонения при исполнении
