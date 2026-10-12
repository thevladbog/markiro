# План ХП: правки хоста и оболочки из ревью — возврат блоков без блоков, индексы по смене (миграция оболочки `0010`), досрочное закрытие паллеты без потери номеров и без ожидания хоста, импорт `EAN128`, тесты хоста — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть хвосты, которые ревью планов РК-С, 2a8 и ПЛ-Ц перенесли «в план, который владеет миграциями и хостом»: станция без блоков SSCC после восстановления хоста становится «Вернула»; удаление смены при очистке перестаёт читать `outbox`, `floor_exceptions` и `floor_pallet_exceptions` целиком; досрочное закрытие паллеты теряет до трёх негодных номеров подряд, как закрытие полной паллеты, а полная паллета, ждущая номеров, больше не держит очередь работы ожиданием хоста; импорт TSPL читает `EAN128`, который сам домен пишет для SSCC; хост получает тест «разборка и повторный скан в одном пакете» (аналог облачного #650) и убивает выжившую мутацию сценария.

**Architecture:**

- Задача 1 — возврат блоков: маршрут хоста `POST /v1/device/sscc/blocks/known` принимает 0–64 блока (пустой список только отмечает станцию), фикстура пустого запроса, Zod `max(64)`, станция шлёт один пустой запрос (`do … while`), тексты офиса без подсказки «станция без блоков остаётся «Не вернула»».
- Задача 2 — миграция оболочки `0010_shift_indexes.sql`: три индекса, **смена первой** (`outbox_shift (shift_id, host_id, device_id, acked_at)`, `floor_exceptions_shift`, `floor_pallet_exceptions_shift`); закрепления планов в обоих списках (`test/floor-schema.test.ts` на SQLite 3.53 и `src-tauri/tests/local_db.rs` на SQLite 3.46 оболочки), тесты миграции поверх `0009` в обоих движках.
- Задача 3 — рабочий экран: `closeLosingBadSerials` (цикл `PALLET_SERIAL_TRIES`) для обоих закрытий паллеты; `settlePallet` больше не ждёт `palletSupply.topUp()` внутри очереди — блок, принесённый пополнением после закрытия короба, ставит закрытие паллеты отдельным ходом (`palletArrived`), как это уже делает возврат связи.
- Задача 4 — `packages/domain/src/labels/tspl-import.ts`: `EAN128` читается как `code128` поля `sscc`.
- Задача 5 — тесты хоста: один пакет фактов с разборкой, очисткой и отменой скана и повторными сканами тех же кодов; сценарий сверяет `consumed_through` блоков (убивает HM2 ревью ПЛ-Ц).
- Задача 6 — документы: `apps/standalone/AGENTS.md`, памятка `docs/runbooks/standalone-backup-restore.md`, раздел 25 спецификации пилота.

**Tech Stack:** Rust (axum, sqlx 0.8.6, SQLite 3.46 в оболочке), TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, React 19.2, Vitest 4 с jsdom и `node:sqlite` (SQLite 3.53) за `LocalExecutor`.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §19 (ПЛ-Ц, известные ограничения), §24 (РК-С: «Подключение без блоков маршрут не вызывает…»); этот план дописывает §25.
- `.superpowers/sdd/rks-task-2-review.md` (M1: станция без блоков никогда не «Вернула»), `.superpowers/sdd/rks-task-4-report.md` (тексты офиса `blocksNote`, `confirmNoBlocks`), `.superpowers/sdd/rks-final-review-report.md` (строка 5: CARRY host).
- `.superpowers/sdd/2a8-task-7-review.md` (Minor 1: полный просмотр `outbox`/`floor_exceptions` в удалении, 176 мс против 37 мс; цена `secure_delete`), `.superpowers/sdd/plc-task-2-review.md` (`floor_pallet_exceptions` без индекса, «нужна новая миграция»).
- `.superpowers/sdd/plc-final-review-report.md` (m10 — HM2, m11 — ожидание хоста внутри очереди, m12 — досрочное закрытие без цикла попыток).
- Облако: коммит `a5f7b21ed` (#650) — `apps/api/src/modules/station-scans/station-scans.service.ts`, `reclaimReleasedCodes`.

## Допущения

Владелец велел «максимально быстро»; контроллер решает вопросы по рекомендации. Решения этого плана:

- **Д1 — индексы начинаются со смены, а не с подключения.** Поручение называет `outbox (host_id, device_id, shift_id)`. Проверено на копии схемы `0001`–`0009` (`node:sqlite` 3.53 и `sqlite3` 3.44): с индексом `(host_id, device_id, shift_id)` первым шагом часовой выборки `DUE_SHIFTS_SQL` становится `SEARCH o USING INDEX outbox_shift (host_id=? AND device_id=?)` — проход по **всем** записям подключения вместо `outbox_settled`, закрепление «первый шаг — `outbox_settled`» падает; с `(host_id, device_id, shift_id, acked_at)` вдобавок счёт неотправленных записей строки состояния уходит с `outbox_unsent` на полный проход подключения. С `(shift_id, host_id, device_id, acked_at)` выборка остаётся на `outbox_settled`, удаление идёт по `outbox_shift`, проверка «есть неотправленная запись смены» читает только индекс (`COVERING INDEX … acked_at=?`), чтения отправителя и строки состояния не меняются. Цена — ещё одна запись индекса на каждую запись очереди и обновление при квитанции.
- **Д2 — пустой список только отмечает станцию.** Хост проверяет длину до проверки эпохи: пустой список до восстановления — `conflict` `no_restore`, как любой; после — ответ `{ "results": [] }`, ревизии и записи журнала нет, `known_blocks_epoch` ставится. Zod запроса получает `.max(64)` (граница хоста; поле `MAX_KNOWN_BLOCKS` станции остаётся источником для разбиения). Новая станция без блоков, подключённая к восстановленному хосту, тоже отмечается «Вернула»; запись прежнего устройства из копии остаётся «Не вернула», пока устройство не отозвано, — тексты так и говорят. Ключ `confirmNoBlocks` переименован в `confirmNotReturned`: смысл другой.
- **Д3 — ожидание хоста для полной паллеты убрано из очереди совсем** (ревью ПЛ-Ц, m11, «preferred fix»): ограниченное ожидание по таймеру оставило бы зависший запрос, который всё равно держит общий `running` пополнения. Досрочное закрытие («Закрыть паллету досрочно», «Закрыть паллету и смену») по-прежнему спрашивает хост внутри очереди, когда номеров нет, — как закрытие короба без номеров коробов: оператор нажал и ждёт ответа на своё нажатие.
- **Д4 — досрочное закрытие получает тот же цикл `PALLET_SERIAL_TRIES`** (ревью ПЛ-Ц, m12): после чужих занятых SSCC оно больше не требует нескольких нажатий; после трёх подряд — прежняя остановка `pallet_failed` с «Повторить».
- **Д5 — `EAN128` читается только как SSCC.** Домен пишет `EAN128` лишь для поля `sscc` (`renderTsplBarcodeElement`: `00` + 18 цифр, FNC1 — принтера). Импорт принимает `00` + верный SSCC (образец выгрузки), `00{{sscc}}` и `{{sscc}}` и делает из них `code128` с `data: "sscc"`; прочее содержимое `EAN128` — `LABEL_CODE_INVALID` (у модели нет элемента «произвольный GS1-128»).
- **Д6 — #650 на хосте — тест, а не исправление.** Облако теряло коды, потому что применяло исключения после сканов пакета; хост автономного продукта применяет записи пакета по одной в порядке очереди станции (`facts::receive`), исключение освобождает коды (`registry::release`) раньше повторного скана. Если тест задачи 5 всё же упадёт, это дефект хоста: исполнитель чинит его наименьшей правкой в `host/src/facts/exception.rs` или `registry.rs` и записывает в «Отклонения».
- **Д7 — HM2 убивается в сценарии**, хотя ревью ПЛ-Ц назвало его DROP: поручение просит выжившие мутации хоста; одна строка сверки `max(consumed_through)` по расширению дешевле спора.
- **Д8 — раздел 24 спецификации не переписывается**: §25 говорит, что снято. Текущее состояние — в `AGENTS.md` и памятке, они правятся.

## Global Constraints

**Поручение владельца (2026-10-11, `.superpowers/sdd/OWNER-DECISIONS.md`):** «доделываем всё, что ты вынес»; максимальная скорость — задачи исполняются по одной свежим исполнителем; после всех доработок контроллер выливает ветку и собирает первую бету (не задачи этого плана).

**Распределение (`.superpowers/sdd/new-plans-context.md`, BINDING):** ХП берёт миграцию оболочки `0010`; миграций хоста не добавляет; раздел спецификации — §25; поток MISC: ХП, затем I1, затем ОЧ — ХП не зависит от несмёрженного кода других планов.

**Правила исполненного состояния**

- Применённые миграции не меняются: оболочка `0001`–`0009`, хост `0001`–`0012`.
- Каждое новое или изменённое SQL-чтение растущей таблицы закреплено планом запроса в **обоих** списках: `test/floor-schema.test.ts` (Node SQLite 3.53) и `src-tauri/tests/local_db.rs` (`the_floors_repeating_reads_search_an_index`, SQLite 3.46 оболочки); тест «are pinned on the shell's SQLite…» требует совпадения текстов.
- Формы на проводе — фикстуры `proto/fixtures` для Rust и Zod одновременно.
- Неизвестный исход печати сам не переотправляется (ничего в задаче 3 этого не меняет); запись в цехе — только из очереди работы и под воротами (`track`).
- Ключи `src/i18n/ru.json` уникальны, русский текст — буквами; кнопки цеха — `size="floor"` (≥ 64 px; задача 3 кнопок не добавляет).
- React-тесты рабочего экрана: действие и ожидание внутри одного асинхронного `act`; ожидание ограничено числом шагов, а не временем; новые и изменённые тестовые файлы с React — один прогон `--reporter=verbose` (нет `stderr |`) и один под стендом с задержкой `setImmediate` на 3 мс (стенд — плана ПЛ-Ц, «Заметки для исполнения»; два временных файла удалить сразу после прогона).

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml` и `Cargo.lock` не меняются; `package.json` и `pnpm-lock.yaml` не меняются.
- Журнал процесса не видит ни кодов, ни SSCC: новых `console.*` и `tracing` с ними нет.
- Коммиты — явные пути, сообщение из файла, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR и бета — не задачи плана.

## Заметки для исполнения

**Основа плана.** Ветка потока MISC от `claude/integration` (`2c726efba` или новее). Перед задачей 1 убедиться, что есть `apps/standalone/host/src/routes/known_blocks.rs`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/src-tauri/migrations/0009_restore_epochs.sql` и **нет** `0010_*.sql`; иначе остановиться и назвать это в отчёте.

**Фрагменты.** Фрагменты взяты из настоящего дерева `/tmp/claude/wt/integ` (`2c726efba`), на копии не прогонялись (скорость). «Фрагмент … заменить на …» дан так, как стоит в файле; не находится — применить по смыслу и записать в «Отклонения при исполнении». Планы запросов задачи 2 сняты на копии схемы: `node:sqlite` 3.53.4 и `sqlite3` 3.44.4 дали одинаковые строки; SQLite 3.46 оболочки проверяет `cargo test … --test local_db` — расхождение строки плана исправляется по выводу теста и записывается.

**Мутации.** `cp <файл> /tmp/claude/before && shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL названного теста; `cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum` тот же. Мутацию не коммитить.

**Перед каждым коммитом.** `node_modules/.bin/prettier --ignore-path .prettierignore --write` на изменённые TS, TSX, JSON и MD, затем `--check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint` (задача 4 — `@markiro/domain`); Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo.** pnpm — только с `--config.verifyDepsBeforeRun=false`, без `pnpm install`/`add`; команды из корня, без `cd`; без `git stash`. В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`. Cargo — `--offline --locked`; `--test local_db`, `--test known_blocks`, `--test facts`, `--test floor_scenario` и тесты `markiro-proto` сокета не открывают и идут в песочнице; перед `-p markiro-standalone` в свежем worktree — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`). Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный `rtk` вывод — `rtk proxy <команда>`.

## Файлы

- Create: `apps/standalone/proto/fixtures/known-blocks-request-empty.json`, `apps/standalone/src-tauri/migrations/0010_shift_indexes.sql`, `apps/standalone/test/floor-shift-indexes.test.ts`
- Modify (хост и протокол): `apps/standalone/host/src/routes/known_blocks.rs`, `apps/standalone/host/tests/known_blocks.rs`, `apps/standalone/host/tests/facts.rs`, `apps/standalone/host/tests/floor_scenario.rs`, `apps/standalone/proto/tests/backup.rs`
- Modify (оболочка): `apps/standalone/src-tauri/tests/local_db.rs`
- Modify (вебвью): `apps/standalone/src/host/backups.ts`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/src/office/backups/BackupsPage.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/floor/work/WorkScreen.tsx`
- Modify (тесты вебвью): `apps/standalone/test/backups.test.ts`, `apps/standalone/test/backups-page.test.tsx`, `apps/standalone/test/restore-reconcile.test.ts`, `apps/standalone/test/floor-schema.test.ts`, `apps/standalone/test/floor-work-pallets.test.tsx`, `apps/standalone/test/floor-work-close-pallets.test.tsx`
- Modify (домен): `packages/domain/src/labels/tspl-import.ts`, `packages/domain/test/labels-import.test.ts`
- Modify (документы): `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`
- Возможные правки по смыслу (если упадут на новом поведении задачи 1): `apps/standalone/test/host-link-restore.test.ts`, `apps/standalone/test/app.test.tsx` — тест, который ждал, что подключение без блоков маршрут не вызывает.

---

### Task 1: Возврат блоков без блоков — хост принимает 0–64, станция шлёт пустой запрос, тексты офиса

**Files:**

- Create: `apps/standalone/proto/fixtures/known-blocks-request-empty.json`
- Modify: `apps/standalone/host/src/routes/known_blocks.rs`, `apps/standalone/src/host/backups.ts`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/src/office/backups/BackupsPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/host/tests/known_blocks.rs`, `apps/standalone/proto/tests/backup.rs`, `apps/standalone/test/backups.test.ts`, `apps/standalone/test/restore-reconcile.test.ts`, `apps/standalone/test/backups-page.test.tsx`

**Interfaces:**

- Consumes: `register_known_blocks`, `MAX_BLOCKS` (хост); `knownBlocksRequestSchema`, `reconcileRestore`, `MAX_KNOWN_BLOCKS`, `KnownBlocksMismatchError` (станция).
- Produces: маршрут принимает `{ "blocks": [] }` → `200 { "results": [] }` и `known_blocks_epoch`; `knownBlocksRequestSchema` с `.max(64)`; `reconcileRestore` для подключения без блоков вызывает `register({ blocks: [] })` ровно один раз; ключ `office.backups.hold.confirmNotReturned` вместо `confirmNoBlocks`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/proto/fixtures/known-blocks-request-empty.json`:

<!-- prettier-ignore -->
```json
{ "blocks": [] }
```

Правка `apps/standalone/proto/tests/backup.rs`:

Фрагмент:

```rust
    let request: KnownBlocksRequest = round_trip("known-blocks-request.json");
    assert_eq!(request.blocks[0].to_serial, 5499);
```

заменить на:

```rust
    let request: KnownBlocksRequest = round_trip("known-blocks-request.json");
    assert_eq!(request.blocks[0].to_serial, 5499);
    // A station that never took a block sends an empty list (plan ХП).
    let empty: KnownBlocksRequest = round_trip("known-blocks-request-empty.json");
    assert!(empty.blocks.is_empty());
```

Правка `apps/standalone/host/tests/known_blocks.rs`:

Фрагмент 1:

```rust
    for (blocks, field) in [
        (vec![], "blocks"),
        (vec![block(LOST, PREFIX, 0, 1, 10); 65], "blocks"),
```

заменить на:

```rust
    for (blocks, field) in [
        (vec![block(LOST, PREFIX, 0, 1, 10); 65], "blocks"),
```

Фрагмент 2 (перед `#[tokio::test]` теста `a_station_revoked_while_it_waited_registers_nothing`):

```rust
#[tokio::test]
async fn a_station_revoked_while_it_waited_registers_nothing() {
```

заменить на:

```rust
#[tokio::test]
async fn a_station_without_blocks_is_marked_by_an_empty_list_and_nothing_else_changes() {
    let admin = admin().await;
    // Before a restore an empty list is heard as any other: the host lost nothing.
    let (status, body) = send(&admin, &admin.key, vec![]).await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (StatusCode::CONFLICT, json!({ "constraint": "no_restore" }))
    );
    restored(&admin).await;
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
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let blocks = block_rows(&admin).await;
    for _ in 0..2 {
        let (status, body) = send(&admin, &admin.key, vec![]).await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "results": [] })));
        assert_eq!(
            known_epoch().await.as_deref(),
            Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
        );
    }
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, blocks);
}

#[tokio::test]
async fn a_station_revoked_while_it_waited_registers_nothing() {
```

Правка `apps/standalone/test/backups.test.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
    const topLevel = { ...(fixture("known-blocks-request.json") as object), epoch: "5d2c8e1a" };
    expect(knownBlocksRequestSchema.safeParse(topLevel).success).toBe(false);
```

заменить на:

<!-- prettier-ignore -->
```ts
    const topLevel = { ...(fixture("known-blocks-request.json") as object), epoch: "5d2c8e1a" };
    expect(knownBlocksRequestSchema.safeParse(topLevel).success).toBe(false);
    // Plan ХП: a station that never took a block sends an empty list; the host takes 0-64.
    expect(knownBlocksRequestSchema.parse(fixture("known-blocks-request-empty.json")).blocks).toEqual(
      [],
    );
    const block = request.blocks[0];
    expect(knownBlocksRequestSchema.safeParse({ blocks: Array(64).fill(block) }).success).toBe(true);
    expect(knownBlocksRequestSchema.safeParse({ blocks: Array(65).fill(block) }).success).toBe(false);
```

Правка `apps/standalone/test/restore-reconcile.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    // No block: nothing to ask the host.
    expect(register).not.toHaveBeenCalled();
```

заменить на:

<!-- prettier-ignore -->
```ts
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    // No block: one empty request, so the host marks the station (plan ХП).
    expect(register.mock.calls).toEqual([[{ blocks: [] }]]);
```

Фрагмент 2 (перед тестом «keeps owing the blocks when a request fails…»):

<!-- prettier-ignore -->
```ts
  it("keeps owing the blocks when a request fails, and the next run sends them all again", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("sends one empty request for a pairing that holds no block, and settles with nothing refused", async () => {
    const { executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering();
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 0, refused: 0 });
    expect(register.mock.calls).toEqual([[{ blocks: [] }]]);
    await expect(restoreDue(executor, PAIRING)).resolves.toBe(false);
  });

  it("keeps owing when the host answers the empty request with a result", async () => {
    const { executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async () =>
      knownBlocksResponseSchema.parse({ results: [{ id: "x", outcome: "known", code: null }] }),
    );
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    await expect(restoreDue(executor, PAIRING)).resolves.toBe(true);
  });

  it("keeps owing the blocks when a request fails, and the next run sends them all again", async () => {
```

Правка `apps/standalone/test/backups-page.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
        "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Отметка «Вернула» ставится, когда хост получил первую часть её блоков и ответил на неё — даже если какие-то блоки отклонил; отклонённые блоки видны только в строке состояния самой станции. Станция, которая ещё не получала блоков SSCC, остаётся «Не вернула»: возвращать ей нечего. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь; станция, которая ещё не получала блоков, отправляет пустой список и тоже отмечается «Вернула». Отметка «Вернула» ставится, когда хост получил первую часть её блоков и ответил на неё — даже если какие-то блоки отклонил; отклонённые блоки видны только в строке состояния самой станции. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
        "«Не вернула» не всегда сбой: станция, которая ещё не получала блоков SSCC, их и не возвращает. По остальным станциям, не вернувшим блоки, сверьте счётчики по памятке.",
```

заменить на:

<!-- prettier-ignore -->
```ts
        "«Не вернула» — станция ещё не вернула блоки восстановленному хосту: она не выходила на связь, хост отвечает ей ошибкой, или это прежняя запись станции, подключённой заново. По таким станциям сверьте счётчики по памятке.",
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts test/restore-reconcile.test.ts test/backups-page.test.tsx
```

Ожидается: `a_station_without_blocks_is_marked_by_an_empty_list_and_nothing_else_changes` — FAIL (`400` на пустой список); Vitest — FAIL «read the known blocks…» (65 блоков проходят), «sends one empty request…», «asks the next sync to start from zero…», «keeps owing when the host answers the empty request…», два текста страницы. `cargo test -p markiro-proto --test backup` уже PASS (`Vec` принимает пустой список) — фикстура закрепляет форму для обеих сторон.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/routes/known_blocks.rs`:

Фрагмент 1:

```rust
//! the facts. Only a station, only after a restore (`conflict` on
//! `no_restore` before any), at most [`MAX_BLOCKS`] blocks; the facts' hold
//! does not stop it.
```

заменить на:

```rust
//! the facts. Only a station, only after a restore (`conflict` on
//! `no_restore` before any), at most [`MAX_BLOCKS`] blocks; an empty list
//! (a station that never took a block, plan ХП) only marks the station. The
//! facts' hold does not stop it.
```

Фрагмент 2:

```rust
    if request.blocks.is_empty() || request.blocks.len() > MAX_BLOCKS {
        return Err(ApiError::validation("blocks", "1-64 blocks"));
    }
```

заменить на:

```rust
    if request.blocks.len() > MAX_BLOCKS {
        return Err(ApiError::validation("blocks", "0-64 blocks"));
    }
```

Правка `apps/standalone/src/host/backups.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
/** `POST /v1/device/sscc/blocks/known`: every block the station holds, after a restore. */
export const knownBlocksRequestSchema = z.object({ blocks: z.array(knownBlockSchema) }).strict();
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * `POST /v1/device/sscc/blocks/known`: every block the station holds, after a restore, 64 at
 * most to a request (`known_blocks::MAX_BLOCKS`); an empty list from a station that never took
 * a block only marks it (plan ХП).
 */
export const knownBlocksRequestSchema = z
  .object({ blocks: z.array(knownBlockSchema).max(64) })
  .strict();
```

Правка `apps/standalone/src/local/restore-reconcile.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
 * again (the host answers `known` for one it took). A host that says it was
 * never restored owes nothing back. Nothing is asked of the host for a
 * pairing without blocks.
 */
```

заменить на:

<!-- prettier-ignore -->
```ts
 * again (the host answers `known` for one it took). A host that says it was
 * never restored owes nothing back. A pairing without blocks sends one empty
 * request: the host marks a station only on a request it answered (plan ХП).
 */
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  for (let start = 0; start < blocks.length; start += MAX_KNOWN_BLOCKS) {
    const chunk = blocks.slice(start, start + MAX_KNOWN_BLOCKS);
```

заменить на:

<!-- prettier-ignore -->
```ts
  // One request per 64 blocks, and one empty request when the pairing holds none.
  let start = 0;
  do {
    const chunk = blocks.slice(start, start + MAX_KNOWN_BLOCKS);
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      await local.transaction([retireStatement(pairing, ids)]);
      refusedBlocks.push(...refusedHere);
    }
  }
  const refused = refusedBlocks.length;
```

заменить на:

<!-- prettier-ignore -->
```ts
      await local.transaction([retireStatement(pairing, ids)]);
      refusedBlocks.push(...refusedHere);
    }
    start += MAX_KNOWN_BLOCKS;
  } while (start < blocks.length);
  const refused = refusedBlocks.length;
```

Правка `apps/standalone/src/office/backups/BackupsPage.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
 * never marks a station that never took a block), and, for an administrator, resuming the facts the host
```

заменить на:

<!-- prettier-ignore -->
```tsx
 * marks a station that never took a block by its empty list, plan ХП), and, for an administrator, resuming the facts the host
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
            <p>{t("office.backups.hold.confirmNoBlocks")}</p>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            <p>{t("office.backups.hold.confirmNotReturned")}</p>
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
        "blocksNote": "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Отметка «Вернула» ставится, когда хост получил первую часть её блоков и ответил на неё — даже если какие-то блоки отклонил; отклонённые блоки видны только в строке состояния самой станции. Станция, которая ещё не получала блоков SSCC, остаётся «Не вернула»: возвращать ей нечего. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
```

заменить на:

<!-- prettier-ignore -->
```json
        "blocksNote": "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь; станция, которая ещё не получала блоков, отправляет пустой список и тоже отмечается «Вернула». Отметка «Вернула» ставится, когда хост получил первую часть её блоков и ответил на неё — даже если какие-то блоки отклонил; отклонённые блоки видны только в строке состояния самой станции. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
        "confirmNoBlocks": "«Не вернула» не всегда сбой: станция, которая ещё не получала блоков SSCC, их и не возвращает. По остальным станциям, не вернувшим блоки, сверьте счётчики по памятке.",
```

заменить на:

<!-- prettier-ignore -->
```json
        "confirmNotReturned": "«Не вернула» — станция ещё не вернула блоки восстановленному хосту: она не выходила на связь, хост отвечает ей ошибкой, или это прежняя запись станции, подключённой заново. По таким станциям сверьте счётчики по памятке.",
```

- [ ] **Step 4: Убедиться, что тесты проходят, и прогнать соседей**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test backup
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts test/restore-reconcile.test.ts test/backups-page.test.tsx test/host-link-restore.test.ts test/app.test.tsx test/api.test.ts
```

Ожидается: PASS. Тест, который ждал, что подключение без блоков маршрут не вызывает (например, ожидание `registerKnownBlocks` в `test/app.test.tsx` или `test/host-link-restore.test.ts`), исправляется по смыслу: теперь вызов один, с `{ blocks: [] }`; правка — в «Отклонения». `grep -rn "confirmNoBlocks" apps/standalone/src apps/standalone/test` — пусто.

- [ ] **Step 5: Мутации**

- M1: в `restore-reconcile.ts` вернуть `for (let start = 0; start < blocks.length; …)` (без пустого запроса) → FAIL «sends one empty request for a pairing that holds no block…», «asks the next sync to start from zero…».
- M2: в `known_blocks.rs` вернуть `request.blocks.is_empty() ||` → FAIL `a_station_without_blocks_is_marked_by_an_empty_list_and_nothing_else_changes`.
- M3: в `backups.ts` убрать `.max(64)` → FAIL «read the known blocks a station sends and the host's answer».

- [ ] **Step 6: Коммит**

```bash
git add apps/standalone/proto/fixtures/known-blocks-request-empty.json apps/standalone/proto/tests/backup.rs apps/standalone/host/src/routes/known_blocks.rs apps/standalone/host/tests/known_blocks.rs apps/standalone/src/host/backups.ts apps/standalone/src/local/restore-reconcile.ts apps/standalone/src/office/backups/BackupsPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/backups.test.ts apps/standalone/test/restore-reconcile.test.ts apps/standalone/test/backups-page.test.tsx
git commit -F /tmp/claude/msg-hp-1.txt
```

Сообщение (`/tmp/claude/msg-hp-1.txt`): `fix(standalone): a station without SSCC blocks gives them back with an empty list, so the office marks it` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Тесты, поправленные по смыслу на шаге 4, — в тот же коммит явными путями.

---

### Task 2: Миграция оболочки `0010` — индексы по смене для удаления при очистке, планы в обоих списках

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0010_shift_indexes.sql`, `apps/standalone/test/floor-shift-indexes.test.ts`
- Test: `apps/standalone/test/floor-schema.test.ts` (Modify), `apps/standalone/src-tauri/tests/local_db.rs` (Modify)

**Interfaces:**

- Consumes: `RETAINED_TABLES`, `purgeTableSql`, `DUE_SHIFTS_SQL`, `PURGE_COPY_SQL`, `REFUSED_CLOSES_SQL` (`src/local/retention.ts`, `src/floor/close/shift-close.ts`) — тексты не меняются.
- Produces: индексы `outbox_shift (shift_id, host_id, device_id, acked_at)`, `floor_exceptions_shift (shift_id, host_id, device_id)`, `floor_pallet_exceptions_shift (shift_id, host_id, device_id)`; все удаления `RETAINED_TABLES` идут поиском по индексу смены — закреплено в обоих списках.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/floor-shift-indexes.test.ts`:

<!-- prettier-ignore -->
```ts
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);
const AT = "2026-10-09T08:00:00.000Z";
const SHIFT_INDEXES = ["floor_exceptions_shift", "floor_pallet_exceptions_shift", "outbox_shift"];

function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

describe("migration 0010 over a database of 0009 (plan ХП)", () => {
  it("adds the indexes by shift, the shift first, and keeps every row", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0009_zzz");
    const pairing = [HOST_ID, DEVICE_ID];
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "acked_at) VALUES ('record-1', ?, ?, 'shift_closed', 'shift-1', '{}', ?, 'accepted', ?)",
    ).run(...pairing, AT, AT);
    db.prepare(
      "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, occurred_at) " +
        "VALUES ('exception-1', ?, ?, 'shift-1', 'clear', 'box-1', ?)",
    ).run(...pairing, AT);
    db.prepare(
      "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, pallet_id, " +
        "reason_code, occurred_at) VALUES ('pallet-exception-1', ?, ?, 'shift-1', 'reprint', " +
        "'pallet-1', 'damaged_label', ?)",
    ).run(...pairing, AT);
    const indexes = () =>
      db
        .prepare(
          "SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index' " +
            `AND name IN (${SHIFT_INDEXES.map(() => "?").join(", ")}) ORDER BY name`,
        )
        .all(...SHIFT_INDEXES);
    expect(indexes()).toEqual([]);

    migrate(db, "0010", "0010_zzz");

    expect(indexes()).toEqual([
      { name: "floor_exceptions_shift", tableName: "floor_exceptions" },
      { name: "floor_pallet_exceptions_shift", tableName: "floor_pallet_exceptions" },
      { name: "outbox_shift", tableName: "outbox" },
    ]);
    const columns = (index: string) =>
      db
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(index)
        .map((row) => row["name"]);
    // The shift leads (plan ХП, Д1): led by the pairing, the index would become the hourly due
    // select's first step and the status bar's count of unsent records.
    expect(columns("outbox_shift")).toEqual(["shift_id", "host_id", "device_id", "acked_at"]);
    expect(columns("floor_exceptions_shift")).toEqual(["shift_id", "host_id", "device_id"]);
    expect(columns("floor_pallet_exceptions_shift")).toEqual(["shift_id", "host_id", "device_id"]);
    expect(db.prepare("SELECT id, outcome, acked_at FROM outbox").all()).toEqual([
      { id: "record-1", outcome: "accepted", acked_at: AT },
    ]);
    expect(db.prepare("SELECT id FROM floor_exceptions").all()).toEqual([{ id: "exception-1" }]);
    expect(db.prepare("SELECT id FROM floor_pallet_exceptions").all()).toEqual([
      { id: "pallet-exception-1" },
    ]);
    db.close();
  });
});
```

Правка `apps/standalone/test/floor-schema.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
      { tableName: "floor_codes", name: "floor_codes_shift", isUnique: 0, isPartial: 0 },
      { tableName: "floor_pallets", name: "floor_pallets_open", isUnique: 1, isPartial: 1 },
```

заменить на:

<!-- prettier-ignore -->
```ts
      { tableName: "floor_codes", name: "floor_codes_shift", isUnique: 0, isPartial: 0 },
      {
        tableName: "floor_exceptions",
        name: "floor_exceptions_shift",
        isUnique: 0,
        isPartial: 0,
      },
      {
        tableName: "floor_pallet_exceptions",
        name: "floor_pallet_exceptions_shift",
        isUnique: 0,
        isPartial: 0,
      },
      { tableName: "floor_pallets", name: "floor_pallets_open", isUnique: 1, isPartial: 1 },
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      { tableName: "outbox", name: "outbox_settled", isUnique: 0, isPartial: 1 },
      { tableName: "outbox", name: "outbox_unsent", isUnique: 0, isPartial: 1 },
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
      { tableName: "outbox", name: "outbox_settled", isUnique: 0, isPartial: 1 },
      { tableName: "outbox", name: "outbox_shift", isUnique: 0, isPartial: 0 },
      { tableName: "outbox", name: "outbox_unsent", isUnique: 0, isPartial: 1 },
    ]);
```

Фрагмент 3 (весь блок от комментария «The retention pass (plan 2a8), once an hour.» до `expect(plan(PURGE_COPY_SQL)).not.toContain("TEMP");` включительно):

<!-- prettier-ignore -->
```ts
    // The retention pass (plan 2a8), once an hour. The due select starts from the accepted
    // closes: its first step walks `outbox_settled` once, and each close it finds costs a search
    // of the unsent records, of the shift's jobs and of the shift's copy by its key. Asking per
    // copy instead walked the pairing's accepted records once for every shift (shifts ×
    // records: 6.5 s at 600 000 rows and 70 shifts). The only temporary structure allowed is
    // the one of its `DISTINCT`.
    const due = plan(DUE_SHIFTS_SQL).split("\n");
    expect(due[0], DUE_SHIFTS_SQL).toBe(
      "SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)",
    );
    expect(due.filter((step) => step.includes("outbox_settled"))).toHaveLength(1);
    expect(due.filter((step) => step.startsWith("SCAN "))).toEqual([]);
    expect(due.filter((step) => step.includes("TEMP"))).toEqual(["USE TEMP B-TREE FOR DISTINCT"]);
    // The delete of a copy walks the settled records for the one shift it deletes (its close
    // lies among the oldest records), so it searches the same indexes, and no temporary one.
    for (const [sql, key] of [
      [DUE_SHIFTS_SQL, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"],
      [PURGE_COPY_SQL, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"],
    ] as const) {
      const retention = plan(sql);
      expect(retention, sql).toContain(key);
      expect(retention, sql).toContain("outbox_unsent (host_id=? AND device_id=?)");
      expect(retention, sql).toContain("outbox_settled (host_id=? AND device_id=? AND outcome=?)");
      expect(retention, sql).toContain(
        "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
      );
      expect(
        retention.split("\n").filter((step) => step.startsWith("SCAN ")),
        sql,
      ).toEqual([]);
    }
    expect(plan(PURGE_COPY_SQL)).not.toContain("TEMP");
```

заменить на:

<!-- prettier-ignore -->
```ts
    // The retention pass (plan 2a8), once an hour. The due select starts from the accepted
    // closes: its first step walks `outbox_settled` once, and each close it finds costs a search
    // of the shift's unsent records (`outbox_shift`, migration `0010`, the index alone), of the
    // shift's jobs and of the shift's copy by its key. Asking per copy instead walked the
    // pairing's accepted records once for every shift (shifts × records: 6.5 s at 600 000 rows
    // and 70 shifts). The only temporary structure allowed is the one of its `DISTINCT`. An index
    // by shift led by the pairing would become this first step (a walk of every record of the
    // pairing): `outbox_shift` is led by the shift on purpose (plan ХП, Д1).
    const due = plan(DUE_SHIFTS_SQL).split("\n");
    expect(due[0], DUE_SHIFTS_SQL).toBe(
      "SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)",
    );
    expect(due.filter((step) => step.includes("outbox_settled"))).toHaveLength(1);
    expect(due.filter((step) => step.startsWith("SCAN "))).toEqual([]);
    expect(due.filter((step) => step.includes("TEMP"))).toEqual(["USE TEMP B-TREE FOR DISTINCT"]);
    for (const key of [
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
      "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
    ]) {
      expect(due.join("\n"), key).toContain(key);
    }
    // The delete of a copy searches the one shift's own records: its accepted close and its
    // unsent records through `outbox_shift`, its jobs, the copy by its key; no temporary one.
    const purge = plan(PURGE_COPY_SQL);
    for (const key of [
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at<?)",
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
      "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
    ]) {
      expect(purge, key).toContain(key);
    }
    expect(purge.split("\n").filter((step) => step.startsWith("SCAN "))).toEqual([]);
    expect(purge).not.toContain("TEMP");
```

Фрагмент 4 (блок `bySearch` и проверки после него):

<!-- prettier-ignore -->
```ts
    // The deletes of a purged shift's records: the tables with an index by shift search it; the
    // outbox and the exceptions carry the shift only as a column, so each costs one read of its
    // table, once for a shift done with for 30 days (not on a scan).
    const bySearch = {
      floor_scans: "floor_scans_shift",
      floor_codes: "floor_codes_shift",
      floor_print_jobs: "floor_print_jobs_shift",
      floor_boxes: "floor_boxes_shift",
      floor_pallets: "floor_pallets_shift",
    } as const;
    for (const table of RETAINED_TABLES) {
      const steps = plan(purgeTableSql(table)).split("\n");
      const index = table in bySearch ? bySearch[table as keyof typeof bySearch] : null;
      if (index !== null) {
        expect(steps.join("\n"), table).toContain(
          `${index} (host_id=? AND device_id=? AND shift_id=?`,
        );
        expect(
          steps.filter((step) => step.startsWith("SCAN ")),
          table,
        ).toEqual([]);
      } else {
        expect(
          steps.filter((step) => step.startsWith("SCAN ")),
          table,
        ).toEqual([`SCAN ${table}`]);
      }
    }
    expect(RETAINED_TABLES.filter((table) => !(table in bySearch))).toEqual([
      "floor_exceptions",
      "floor_pallet_exceptions",
      "outbox",
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
    // The deletes of a purged shift's records search the table's index by shift: every table of
    // `RETAINED_TABLES` has one since migration `0010` (plan ХП), and a table that joins the list
    // needs one too, or this fails.
    const bySearch: ReadonlyMap<string, string> = new Map([
      ["floor_scans", "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_codes", "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_print_jobs", "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_boxes", "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_pallets", "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_exceptions", "floor_exceptions_shift (shift_id=? AND host_id=? AND device_id=?"],
      [
        "floor_pallet_exceptions",
        "floor_pallet_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
      ],
      ["outbox", "outbox_shift (shift_id=? AND host_id=? AND device_id=?"],
    ]);
    for (const table of RETAINED_TABLES) {
      const steps = plan(purgeTableSql(table)).split("\n");
      expect(steps.join("\n"), table).toContain(bySearch.get(table) ?? `${table}: no index`);
      expect(
        steps.filter((step) => step.startsWith("SCAN ")),
        table,
      ).toEqual([]);
    }
```

Фрагмент 5 (тест «are pinned on the shell's SQLite with the status bar's…», хвост):

<!-- prettier-ignore -->
```ts
    // The retention pass's statements, as `tests/local_db.rs` plans them (the refused closes' read
    // among them): the long ones as constants, the deletes of the tables with an index by shift as literals, the three that read
    // their whole table from one format string.
    const retention = [
      DUE_SHIFTS_SQL,
      PURGE_COPY_SQL,
      REFUSED_CLOSES_SQL,
      ...(
        ["floor_scans", "floor_codes", "floor_print_jobs", "floor_boxes", "floor_pallets"] as const
      ).map(purgeTableSql),
    ];
    expect(new Set(retention).size).toBe(8);
    for (const sql of retention) expect(source).toContain(`"${sql}"`);
    expect(source).toContain(
      'for table in ["outbox", "floor_exceptions", "floor_pallet_exceptions"] {',
    );
    expect(source).toContain(`"${purgeTableSql("outbox").replace("outbox", "{table}")}"`);
```

заменить на:

<!-- prettier-ignore -->
```ts
    // The retention pass's statements, as `tests/local_db.rs` plans them (the refused closes' read
    // among them): the long ones as constants, every table's delete by shift as a literal (each
    // searches an index by shift since migration `0010`, plan ХП).
    const retention = [
      DUE_SHIFTS_SQL,
      PURGE_COPY_SQL,
      REFUSED_CLOSES_SQL,
      ...RETAINED_TABLES.map(purgeTableSql),
    ];
    expect(new Set(retention).size).toBe(11);
    for (const sql of retention) expect(source).toContain(`"${sql}"`);
```

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент 1 (перед `#[tokio::test]` теста `a_batch_commits_together_and_values_come_back_typed`):

```rust
#[tokio::test]
async fn a_batch_commits_together_and_values_come_back_typed() {
```

заменить на:

```rust
/// Migration `0010` over a station's database of `0009` (plan ХП): the shell's own SQLite adds
/// the three indexes by shift the retention's deletes search, and every row stays as it was.
#[tokio::test]
async fn migration_0010_adds_the_shift_indexes_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let until_0009: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version <= 9)
        .cloned()
        .collect();
    assert_eq!(until_0009.len(), 9, "migrations 0001 to 0009 exist");
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(until_0009),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('record-1', 'host', 'device', 'shift_closed', 'shift-1', \
         '{}', '2026-10-09T08:00:00.000Z', 'accepted', '2026-10-09T08:00:05.000Z')",
        "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, \
         occurred_at) VALUES ('exception-1', 'host', 'device', 'shift-1', 'clear', 'box-1', \
         '2026-10-09T08:00:00.000Z')",
        "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, pallet_id, \
         reason_code, occurred_at) VALUES ('pallet-exception-1', 'host', 'device', 'shift-1', \
         'reprint', 'pallet-1', 'damaged_label', '2026-10-09T08:00:00.000Z')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let indexes = db
        .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name IN \
             ('outbox_shift', 'floor_exceptions_shift', 'floor_pallet_exceptions_shift') \
             ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(indexes.into_iter().map(Value::Object).collect()),
        json!([
            { "name": "floor_exceptions_shift", "tbl_name": "floor_exceptions" },
            { "name": "floor_pallet_exceptions_shift", "tbl_name": "floor_pallet_exceptions" },
            { "name": "outbox_shift", "tbl_name": "outbox" }
        ])
    );
    for table in ["outbox", "floor_exceptions", "floor_pallet_exceptions"] {
        assert_eq!(count(&db, table).await, json!(1), "{table} keeps its row");
    }
    assert!(MIGRATOR.iter().any(|migration| migration.version == 10));
}

#[tokio::test]
async fn a_batch_commits_together_and_values_come_back_typed() {
```

Фрагмент 2:

```rust
    let reads: [(&str, &str); 83] = [
```

заменить на:

```rust
    let reads: [(&str, &str); 86] = [
```

Фрагмент 3:

```rust
        // The retention pass (plan 2a8), once an hour: the shifts done with and the delete of a
        // copy search the shift's key, the unsent records, the settled ones and the shift's
        // jobs. The due select must walk the settled records once (not once per shift): that is
        // pinned after the loop. Three of the deletes (not listed) read the whole table (no index by
        // shift): pinned after the loop too.
        (DUE_SHIFTS, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (DUE_SHIFTS, "outbox_unsent (host_id=? AND device_id=?)"),
        (DUE_SHIFTS, "outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        (DUE_SHIFTS, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
        (PURGE_COPY, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (PURGE_COPY, "outbox_unsent (host_id=? AND device_id=?)"),
        (PURGE_COPY, "outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        (PURGE_COPY, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
```

заменить на:

```rust
        // The retention pass (plan 2a8), once an hour: the due select walks the settled records
        // once (pinned after the loop) and searches each close's shift — its unsent records
        // through `outbox_shift` (migration `0010`, plan ХП), its jobs, its copy by its key; the
        // delete of a copy searches the one shift's close and unsent records through
        // `outbox_shift`. Every delete of a shift's rows searches an index by shift.
        (DUE_SHIFTS, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (
            DUE_SHIFTS,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
        ),
        (DUE_SHIFTS, "outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        (DUE_SHIFTS, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
        (PURGE_COPY, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (
            PURGE_COPY,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at<?)",
        ),
        (
            PURGE_COPY,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
        ),
        (PURGE_COPY, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
```

Фрагмент 4:

```rust
        (
            "DELETE FROM floor_pallets WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
```

заменить на:

```rust
        (
            "DELETE FROM floor_pallets WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM outbox WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "outbox_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
        (
            "DELETE FROM floor_exceptions WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
        (
            "DELETE FROM floor_pallet_exceptions WHERE host_id = ? AND device_id = ? \
             AND shift_id = ?",
            "floor_pallet_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
```

Фрагмент 5 (хвост теста `the_floors_repeating_reads_search_an_index`):

```rust
    // The three deletes of the retention pass with no index by shift: the outbox and the
    // exceptions (a box's, a pallet's) carry the shift only as a column, so a purged shift costs
    // one read of each table. They run once for a shift that has been done with for 30 days, not
    // on a scan.
    for table in ["outbox", "floor_exceptions", "floor_pallet_exceptions"] {
        let delete =
            format!("DELETE FROM {table} WHERE host_id = ? AND device_id = ? AND shift_id = ?");
        let text = format!("EXPLAIN QUERY PLAN {delete}");
        let mut explain = sqlx::query(&text);
        for _ in 0..delete.matches('?').count() {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        let scans: Vec<&String> = plan
            .iter()
            .filter(|step| step.starts_with("SCAN "))
            .collect();
        assert_eq!(
            scans,
            [&format!("SCAN {table}")],
            "{delete}\n  should read only {table}, its plan is {plan:?}"
        );
    }
    raw.close().await.unwrap();
}
```

заменить на:

```rust
    raw.close().await.unwrap();
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-indexes.test.ts test/floor-schema.test.ts
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db
```

Ожидается: FAIL — «adds the indexes by shift…» (нет `0010`), «fixes the indexes…», «serve the reads the floor makes from an index» (удаления — `SCAN`), `migration_0010_adds_the_shift_indexes_and_keeps_every_row` (`until_0009.len()` верно, но индексов нет), `the_floors_repeating_reads_search_an_index` (нет `outbox_shift`). «are pinned on the shell's SQLite…» уже PASS после правки Rust-файла (тексты совпадают).

- [ ] **Step 3: Миграция**

Создать `apps/standalone/src-tauri/migrations/0010_shift_indexes.sql`:

```sql
-- Plan ХП: indexes by shift for the retention's deletes (stage 2a, decision
-- 31; plan 2a8). The pass deletes a purged shift's rows by `host_id`,
-- `device_id` and `shift_id`; without these `outbox`, `floor_exceptions` and
-- `floor_pallet_exceptions` were read whole inside the write transaction
-- (176 ms against 37 ms at 600 000 outbox rows). The shift leads each index
-- on purpose: led by `(host_id, device_id)` an index becomes the first step of
-- the hourly due select (`DUE_SHIFTS_SQL`, a walk of every record of the
-- pairing instead of `outbox_settled`), and with `acked_at` after the shift
-- also of the status bar's count of unsent records. `acked_at` ends the
-- outbox's index, so the retention's check for an unsent record of a shift
-- reads the index alone. Additive: no row changes, no foreign key (see
-- `0006`).
CREATE INDEX outbox_shift ON outbox (shift_id, host_id, device_id, acked_at);

CREATE INDEX floor_exceptions_shift ON floor_exceptions (shift_id, host_id, device_id);

CREATE INDEX floor_pallet_exceptions_shift ON floor_pallet_exceptions (shift_id, host_id, device_id);
```

- [ ] **Step 4: Убедиться, что тесты проходят, и прогнать соседей**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-indexes.test.ts test/floor-schema.test.ts test/floor-pallet-schema.test.ts test/retention.test.ts test/restore-reconcile.test.ts test/facts-sender.test.ts
cargo fmt --manifest-path apps/standalone/Cargo.toml --all
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db
```

Ожидается: PASS. `test/retention.test.ts` не меняется: поведение очистки то же, тесты — проверка регресса. Если SQLite 3.46 оболочки показывает строку плана иначе (например `acked_at<=?`), исправить строку закрепления в Rust-файле по выводу теста и записать в «Отклонения»; закрепление «нет `SCAN`» не ослабляется. Если `facts-sender.test.ts` не существует — прогнать файлы, которые закрепляют чтения отправителя (`grep -ln UNSENT_SQL apps/standalone/test`).

- [ ] **Step 5: Мутации**

- M1: в `0010_shift_indexes.sql` порядок `outbox_shift` — `(host_id, device_id, shift_id, acked_at)` → FAIL «serve the reads…» (первый шаг `DUE_SHIFTS_SQL` — `outbox_shift`), «adds the indexes by shift, the shift first…» (столбцы); `--test local_db` — FAIL (первый шаг выборки).
- M2: убрать `floor_pallet_exceptions_shift` из миграции → FAIL «serve the reads…» (`floor_pallet_exceptions` — `SCAN`), «fixes the indexes…».
- M3: убрать `acked_at` из `outbox_shift` → FAIL «serve the reads…» (`… AND acked_at=?` не найден), «adds the indexes by shift…».

- [ ] **Step 6: Коммит**

```bash
git add apps/standalone/src-tauri/migrations/0010_shift_indexes.sql apps/standalone/src-tauri/tests/local_db.rs apps/standalone/test/floor-shift-indexes.test.ts apps/standalone/test/floor-schema.test.ts
git commit -F /tmp/claude/msg-hp-2.txt
```

Сообщение: `feat(standalone): migration 0010 indexes the outbox and the exceptions by shift, so the retention's deletes stop reading them whole` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 3: Досрочное закрытие паллеты с циклом попыток, полная паллета без ожидания хоста в очереди

**Files:**

- Modify: `apps/standalone/src/floor/work/WorkScreen.tsx`
- Test: `apps/standalone/test/floor-work-pallets.test.tsx` (Modify), `apps/standalone/test/floor-work-close-pallets.test.tsx` (Modify)

**Interfaces:**

- Consumes: `closeOpenPallet`, `closePalletIfFull`, `PalletCloseResult` (`src/floor/pallets/pallets.ts`), `createBlockSupply` (`src/floor/work/block-supply.ts`), `createWorkQueue`.
- Produces: модульная `closeLosingBadSerials(close)` в `WorkScreen.tsx`; `settlePallet` без `palletSupply.topUp()`; `palletArrived` — ход очереди, который ставит цепочка пополнения после закрытия короба, когда блок паллет сохранён.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-work-pallets.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { screen } from "@testing-library/react";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { act, screen } from "@testing-library/react";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
import type { SsccBlockRequest } from "../src/host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import type { SsccBlock, SsccBlockRequest } from "../src/host/protocol.js";
```

Фрагмент 3 (после функции `palletLine`):

<!-- prettier-ignore -->
```ts
/** The pallet's fact: its line in the work screen's numbers. */
function palletLine(): string | null {
  const term = screen.getByText("Паллета", { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
/** The pallet's fact: its line in the work screen's numbers. */
function palletLine(): string | null {
  const term = screen.getByText("Паллета", { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

/** Lets the work run until `done` holds, for a bounded number of turns of the event loop. */
async function turnsUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
```

Фрагмент 4 (перед тестом «after a restart decides the box's cut label…»):

<!-- prettier-ignore -->
```ts
  it("after a restart decides the box's cut label before the pallet's, which is sent right after it and not before", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("keeps the line going while the host holds the pallet block's request, and closes the full pallet in a turn of its own once the block comes", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1, palletBlock: false });
    let answer: (block: SsccBlock) => void = () => undefined;
    // The first ask (on entry) finds no host; the next, after a box's close, waits for the test.
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockImplementation(
        () =>
          new Promise<SsccBlock>((resolve) => {
            answer = resolve;
          }),
      );
    const work = renderWork(at, { overrides: { requestBlock, online: true } });
    await work.scanner.listening();
    await work.settled();
    await act(async () => {
      work.scanner.emit(km("A1"));
      work.scanner.emit(km("A2"));
      await turnsUntil(() => count(at, "floor_boxes", "closed_at IS NOT NULL") === 2);
      // Both boxes closed while the host held the request: the queue never waited for it.
      expect(count(at, "floor_boxes", "closed_at IS NOT NULL")).toBe(2);
      expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
      answer({
        id: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
        issuerPrefix: PREFIX,
        extension: PALLET_EXTENSION,
        fromSerial: 0,
        toSerial: 199,
      });
      await work.gate.drain();
    });
    // The block a box's top-up brought closes the full pallet, with both boxes on it.
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'pallet_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toMatchObject({ data: { boxCount: 2 } });
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
    expect(palletLine()).toBe("0 из 1 коробов");
    expect(requestBlock).toHaveBeenCalledWith(
      expect.objectContaining({ extension: PALLET_EXTENSION }),
    );
  });

  it("after a restart decides the box's cut label before the pallet's, which is sent right after it and not before", async () => {
```

Фрагмент 5 (тест «says the early close did not take when its serial is lost…», целиком до строки `  it("starts no early close once the floor has begun to leave", async () => {`):

<!-- prettier-ignore -->
```ts
  it("says the early close did not take when its serial is lost, and takes the next on «Повторить»", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    holdSscc(at, 0);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.getByText("Паллета не закрыта")).toBeTruthy();
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("closes early past a serial that cannot label a pallet, losing it, with no stop", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    holdSscc(at, 0);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(palletCursor(at)).toEqual([2]);
    expect(work.shell.sends.at(-1)?.text).toBe(
      renderedText(ZEBRA, buildSscc(PALLET_EXTENSION, PREFIX, 1), "100x150"),
    );
  });

  it("says the early close did not take after three serials in a row are lost, and takes the next on «Повторить»", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    for (const serial of [0, 1, 2]) holdSscc(at, serial);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.getByText("Паллета не закрыта")).toBeTruthy();
```

Фрагмент 6 (в том же, теперь третьем, тесте):

<!-- prettier-ignore -->
```ts
    expect(kinds(at)).not.toContain("pallet_closed");
    expect(palletCursor(at)).toEqual([1]);
    await work.press("Повторить");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    expect(work.shell.sends.at(-1)?.text).toBe(
      renderedText(ZEBRA, buildSscc(PALLET_EXTENSION, PREFIX, 1), "100x150"),
    );
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(kinds(at)).not.toContain("pallet_closed");
    expect(palletCursor(at)).toEqual([3]);
    await work.press("Повторить");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    expect(work.shell.sends.at(-1)?.text).toBe(
      renderedText(ZEBRA, buildSscc(PALLET_EXTENSION, PREFIX, 3), "100x150"),
    );
```

Правка `apps/standalone/test/floor-work-close-pallets.test.tsx` (обе остановки «Паллета не закрыта» теперь требуют трёх негодных номеров подряд):

Фрагмент 1:

<!-- prettier-ignore -->
```ts
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    holdSscc(at, 0);
    const work = await twoBoxesThenClose(at);
```

заменить на:

<!-- prettier-ignore -->
```ts
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    for (const serial of [0, 1, 2]) holdSscc(at, serial);
    const work = await twoBoxesThenClose(at);
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    holdSscc(at, 0);
    const work = await twoBoxesThenClose(at);
```

заменить на:

<!-- prettier-ignore -->
```ts
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    for (const serial of [0, 1, 2]) holdSscc(at, serial);
    const work = await twoBoxesThenClose(at);
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx test/floor-work-close-pallets.test.tsx
```

Ожидается: FAIL «keeps the line going while the host holds…» (закрыт один короб: очередь ждёт хоста), «closes early past a serial…» («Паллета не закрыта»), «says the early close did not take after three…» (курсор `[1]`); оба изменённых теста закрытия смены сейчас PASS (с тремя занятыми номерами без цикла тоже стоп) — они закрепляют поведение после реализации.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/work/WorkScreen.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
/** How many pallet serials a full pallet's close may lose, one per try, before it waits for the next close. */
const PALLET_SERIAL_TRIES = 3;
```

заменить на:

<!-- prettier-ignore -->
```tsx
/**
 * How many pallet serials a pallet's close may lose in a row, one per try: the full pallet's
 * close then waits for the next close, the early close stops with «Повторить» (plan ХП).
 */
const PALLET_SERIAL_TRIES = 3;
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  for (let attempt = 1; attempt < CLOSE_TRIES && result?.kind === "stale"; attempt += 1) {
    result = await close();
  }
  return result;
}

/** How an attempt to close the box ended, for the screen to act on. */
```

заменить на:

<!-- prettier-ignore -->
```tsx
  for (let attempt = 1; attempt < CLOSE_TRIES && result?.kind === "stale"; attempt += 1) {
    result = await close();
  }
  return result;
}

/**
 * A pallet's close again while it lost a serial that cannot label a pallet (`invalid_serial`:
 * past the prefix's range, or its SSCC held by another pallet): each such answer spent that
 * serial alone, so the next call takes the next one, `PALLET_SERIAL_TRIES` calls in all — the
 * full pallet's close and the early close alike (plan ХП).
 */
async function closeLosingBadSerials<Result extends { kind: string } | null>(
  close: () => Promise<Result>,
): Promise<Result> {
  let result = await close();
  for (
    let tries = 1;
    tries < PALLET_SERIAL_TRIES && result?.kind === "invalid_serial";
    tries += 1
  ) {
    result = await close();
  }
  return result;
}

/** How an attempt to close the box ended, for the screen to act on. */
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  /** A top-up of serials as a piece of the floor's work: handed to the gate before it starts. */
  const topUpTracked = useCallback(
    (blocks: { topUp: () => Promise<SupplyResult> }) =>
      live.current.track(Promise.resolve().then(() => blocks.topUp())),
    [],
  );

  /** After a box closed (also one read back after a lost answer): tell, and keep serials in stock. */
  const afterClosed = useCallback(
    (box: ClosingBox) => {
      live.current.onRecorded();
      try {
        live.current.onClosed?.(box);
      } catch {
        // The label's plan answers for its own failures; the box is closed.
      }
      // The half rule after every close: work of its own, not the line's — for the
      // pallet serials too, in a shift with pallets.
      for (const blocks of live.current.pallets === null ? [supply] : [supply, palletSupply]) {
        void topUpTracked(blocks).then(
          (topped) => {
            if (topped.kind === "stored") live.current.onRecorded();
          },
          () => undefined,
        );
      }
    },
    [topUpTracked, supply, palletSupply],
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /**
   * The turn a pallet block brought by a box's top-up queues (plan ХП); set once
   * `settlePalletSafely` exists, below. Until then it does nothing.
   */
  const palletArrived = useRef<() => Promise<void>>(async () => undefined);

  /** After a box closed (also one read back after a lost answer): tell, and keep serials in stock. */
  const afterClosed = useCallback(
    (box: ClosingBox) => {
      live.current.onRecorded();
      try {
        live.current.onClosed?.(box);
      } catch {
        // The label's plan answers for its own failures; the box is closed.
      }
      // The half rule after every close: work of its own, not the line's — for the
      // pallet serials too, in a shift with pallets. A pallet block that comes queues the
      // full pallet's close as a turn of its own (plan ХП): the box's turn never waits for
      // the host. The gate holds the whole chain, the queued turn included.
      for (const blocks of live.current.pallets === null ? [supply] : [supply, palletSupply]) {
        const pallet = blocks === palletSupply;
        void live.current
          .track(
            Promise.resolve()
              .then(() => blocks.topUp())
              .then(async (topped) => {
                if (topped.kind !== "stored") return;
                live.current.onRecorded();
                if (pallet) await palletArrived.current();
              }),
          )
          .catch(() => undefined);
      }
    },
    [supply, palletSupply],
  );
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
    const pallets = live.current.pallets;
    if (pallets === null) return null;
    const attempt = () => closeSettled(() => closePalletIfFull(palletContextOf(live), pallets));
    let result = await attempt();
    for (
      let tries = 1;
      tries < PALLET_SERIAL_TRIES && result?.kind === "invalid_serial";
      tries += 1
    ) {
      result = await attempt();
    }
    return result;
  }, []);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const pallets = live.current.pallets;
    if (pallets === null) return null;
    return closeLosingBadSerials(() =>
      closeSettled(() => closePalletIfFull(palletContextOf(live), pallets)),
    );
  }, []);
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
   * boxes join it — the line never stops for it. The pallet's label goes at
```

заменить на:

<!-- prettier-ignore -->
```tsx
   * boxes join it — the line never stops for it, and this turn never waits for the host
   * (plan ХП): the block a box's top-up or the link's return brings queues it again. The
   * pallet's label goes at
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
  const settlePallet = useCallback(async (): Promise<void> => {
    if (live.current.pallets === null) return;
    let result = await closeFullPallet();
    if (result?.kind === "no_serials") {
      const supplied = await palletSupply.topUp();
      if (supplied.kind === "stored") {
        live.current.onRecorded();
        result = await closeFullPallet();
      }
    }
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const settlePallet = useCallback(async (): Promise<void> => {
    if (live.current.pallets === null) return;
    const result = await closeFullPallet();
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
  }, [closeFullPallet, palletSupply, settleLabel]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  }, [closeFullPallet, settleLabel]);
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
  /** `settlePallet`, whose failure stops the line with the failed write instead of being lost. */
  const settlePalletSafely = useCallback(async (): Promise<void> => {
    try {
      await settlePallet();
    } catch {
      setStop({ kind: "system_error", cause: "write" });
    }
  }, [settlePallet, setStop]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /** `settlePallet`, whose failure stops the line with the failed write instead of being lost. */
  const settlePalletSafely = useCallback(async (): Promise<void> => {
    try {
      await settlePallet();
    } catch {
      setStop({ kind: "system_error", cause: "write" });
    }
  }, [settlePallet, setStop]);

  // The turn a pallet block from a box's top-up queues (plan ХП): the full pallet that waited
  // for serials closes while no stop stands, as the link-back's turn does.
  useLayoutEffect(() => {
    palletArrived.current = () =>
      live.current.track(
        queue.run(async () => {
          if (stopRef.current === null) await settlePalletSafely();
          await refreshQuietly();
        }),
      );
  }, [queue, settlePalletSafely, refreshQuietly]);
```

Фрагмент 9:

<!-- prettier-ignore -->
```tsx
      const close = () => closeOpenPallet(palletContextOf(live), pallets);
      let result = await closeSettled(close);
      let supplied: SupplyResult | null = null;
      if (result.kind === "no_serials") {
        supplied = await palletSupply.topUp();
        if (supplied.kind === "stored") {
          live.current.onRecorded();
          result = await closeSettled(close);
        }
      }
```

заменить на:

<!-- prettier-ignore -->
```tsx
      // A serial that cannot label a pallet is lost and the next taken, up to three in a row,
      // as for a full pallet (plan ХП); a stale write is tried again inside each try.
      const close = () =>
        closeLosingBadSerials(() =>
          closeSettled(() => closeOpenPallet(palletContextOf(live), pallets)),
        );
      let result = await close();
      let supplied: SupplyResult | null = null;
      if (result.kind === "no_serials") {
        supplied = await palletSupply.topUp();
        if (supplied.kind === "stored") {
          live.current.onRecorded();
          result = await close();
        }
      }
```

Фрагмент 10:

<!-- prettier-ignore -->
```tsx
      // A serial that could not label a pallet is lost (the next try takes the next),
      // or the pallet changed under three tries: nothing was closed.
```

заменить на:

<!-- prettier-ignore -->
```tsx
      // Three serials in a row could not label a pallet (each lost: «Повторить» takes the
      // next), or the pallet changed under three tries: nothing was closed.
```

Заметка: `refreshQuietly` и `queue` объявлены раньше `afterClosed`; `useRef` и `useLayoutEffect` уже импортированы (`live`, `stopRef`). Если линтер хуков требует иного места эффекта — перенести его ниже по смыслу и записать.

- [ ] **Step 4: Убедиться, что тесты проходят, и прогнать соседей**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx test/floor-work-close-pallets.test.tsx test/floor-work-pallet-exceptions.test.tsx test/floor-pallets.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-work-pallets.test.tsx test/floor-work-close-pallets.test.tsx --reporter=verbose
```

Ожидается: PASS, в verbose-выводе нет `stderr |`; затем один прогон тех же двух файлов под стендом с задержкой `setImmediate` (план ПЛ-Ц, «Заметки для исполнения»; временные файлы удалить до `lint`). Тест, который ждал закрытия полной паллеты в ходе самого короба при живой связи (а не после хода пополнения), правится по смыслу (`await work.settled()` после скана) и записывается.

- [ ] **Step 5: Мутации**

- M1: в `closePallet` `const close = () => closeSettled(() => closeOpenPallet(palletContextOf(live), pallets));` (без цикла) → FAIL «closes early past a serial that cannot label a pallet…».
- M2: вернуть в `settlePallet` ожидание `await palletSupply.topUp()` при `no_serials` и повторное `closeFullPallet()` после `stored` → FAIL «keeps the line going while the host holds…» (`toBe(2)`).
- M3: убрать `if (pallet) await palletArrived.current();` в `afterClosed` → FAIL «keeps the line going…» (нет `pallet_closed`).
- M4: `PALLET_SERIAL_TRIES = 1` → FAIL «closes early past a serial…» и тест плана ПЛ-Ц «loses the pallet serials that cannot label a pallet in a few tries…».

- [ ] **Step 6: Коммит**

```bash
git add apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/test/floor-work-pallets.test.tsx apps/standalone/test/floor-work-close-pallets.test.tsx
git commit -F /tmp/claude/msg-hp-3.txt
```

Сообщение: `fix(standalone): the early pallet close loses up to three bad serials, and a full pallet never holds the work queue for the host` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 4: Импорт TSPL читает `EAN128` SSCC, который пишет сам домен

**Files:**

- Modify: `packages/domain/src/labels/tspl-import.ts`
- Test: `packages/domain/test/labels-import.test.ts`

**Interfaces:**

- Consumes: `renderTsplBarcodeElement` (`EAN128` с `00` + SSCC для поля `sscc`), `isValidSscc` (`src/gs1/sscc.ts`), `parseTemplatePayload`.
- Produces: `parseTsplLabel` принимает `BARCODE …,"EAN128",…` с `00` + верным SSCC, `00{{sscc}}` или `{{sscc}}` → `{ kind: "barcode", format: "code128", data: "sscc" }`; иное содержимое `EAN128` — `LABEL_CODE_INVALID`.

- [ ] **Step 1: Написать падающие тесты**

Правка `packages/domain/test/labels-import.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { parseTsplLabel } from "../src/labels/tspl-import.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { parseTsplLabel } from "../src/labels/tspl-import.js";
import { generateTspl } from "../src/labels/tspl.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    it("decodes doubled quotes and reports unsupported bitmap lines", () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
    it("reads back as the SSCC field the EAN128 the domain writes for it", async () => {
      const spec = parseLabelTemplate({
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "tspl",
        elements: [
          { kind: "barcode", id: "b1", xMm: 5, yMm: 5, format: "code128", data: "sscc", sizeMm: 10 },
        ],
      });
      const exported = await generateTspl(spec, sampleLabelData());
      expect(exported).toContain('"EAN128"');
      const result = parseTsplLabel(exported, 203);
      expect(result.spec.elements).toEqual([
        expect.objectContaining({ kind: "barcode", format: "code128", data: "sscc" }),
      ]);
      expect(result.warnings).toEqual([]);
      for (const payload of ["00{{sscc}}", "{{sscc}}"]) {
        const again = parseTsplLabel(
          `SIZE 58 mm, 40 mm\nBARCODE 40,40,"EAN128",80,0,0,2,2,"${payload}"`,
          203,
        );
        expect(again.spec.elements[0]).toEqual(
          expect.objectContaining({ format: "code128", data: "sscc" }),
        );
      }
    });

    it("refuses an EAN128 that holds no SSCC", () => {
      for (const payload of [
        "0012345",
        "0104600682000013",
        "00004601234560000018",
        "{{product.gtin}}",
        "00{{product.gtin}}",
      ]) {
        expect(
          () =>
            parseTsplLabel(`SIZE 58 mm, 40 mm\nBARCODE 40,40,"EAN128",80,0,0,2,2,"${payload}"`, 203),
          payload,
        ).toThrow(expect.objectContaining({ code: "LABEL_CODE_INVALID" }));
      }
    });

    it("decodes doubled quotes and reports unsupported bitmap lines", () => {
```

(`00004601234560000018` — `00` и SSCC с неверной контрольной цифрой: верный — `…17`, его пишет тест `labels-tspl.test.ts`.)

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-import.test.ts
```

Ожидается: FAIL «reads back as the SSCC field…» (`unsupported TSPL barcode type EAN128`); «refuses an EAN128…» уже PASS (тип отклоняется целиком) — закрепляет границу после реализации.

- [ ] **Step 3: Реализация**

Правка `packages/domain/src/labels/tspl-import.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { DomainError } from "../errors.js";
import { parseLabelTemplate, type LabelElement, type LabelTemplateSpec } from "./model.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { DomainError } from "../errors.js";
import { isValidSscc } from "../gs1/sscc.js";
import {
  parseLabelTemplate,
  type LabelBarcodeElement,
  type LabelElement,
  type LabelTemplateSpec,
} from "./model.js";
```

Фрагмент 2 (перед `function parseBarcode(`):

<!-- prettier-ignore -->
```ts
function parseBarcode(
```

заменить на:

<!-- prettier-ignore -->
```ts
/**
 * The data of an `EAN128` barcode: TSC's GS1-128, which the domain writes only for the SSCC
 * (`renderTsplBarcodeElement`: AI `00` before the 18 digits; the printer adds the leading
 * FNC1). Read back as the `sscc` field — a code file carries the layout's sample SSCC, never one
 * to print — whether it holds that sample (`00` and a valid SSCC), the placeholder after the AI
 * (`00{{sscc}}`) or the placeholder alone. Anything else is no barcode of the label model.
 */
function ean128Data(payload: string, line: number, source: string): "sscc" {
  if (payload === "{{sscc}}" || payload === "00{{sscc}}") return "sscc";
  if (payload.startsWith("00") && isValidSscc(payload.slice(2))) return "sscc";
  fail(line, source, "TSPL EAN128 is read only as an SSCC: AI 00 and 18 digits");
}

function parseBarcode(
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
  const type = required(args, 2, line, source).toUpperCase();
  const format = type === "128" ? "code128" : type === "EAN13" ? "ean13" : undefined;
  if (!format) fail(line, source, `unsupported TSPL barcode type ${type}`);
  const sizeMm = Math.max(0.1, dotsToMm(numberAt(args, 3, line, source), dpi));
  if (numberAt(args, 5, line, source) !== 0)
    fail(line, source, "only non-rotated TSPL barcodes are supported");
  const parsed = parseTemplatePayload(required(args, 8, line, source), line);
  return {
    kind: "barcode",
    id: importedElementId("tspl", ordinal),
    xMm,
    yMm,
    format,
    sizeMm,
    data: parsed.kind === "field" ? parsed.field : { literal: parsed.value },
  };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  const type = required(args, 2, line, source).toUpperCase();
  const format =
    type === "128" || type === "EAN128" ? "code128" : type === "EAN13" ? "ean13" : undefined;
  if (!format) fail(line, source, `unsupported TSPL barcode type ${type}`);
  const sizeMm = Math.max(0.1, dotsToMm(numberAt(args, 3, line, source), dpi));
  if (numberAt(args, 5, line, source) !== 0)
    fail(line, source, "only non-rotated TSPL barcodes are supported");
  const payload = required(args, 8, line, source);
  let data: LabelBarcodeElement["data"];
  if (type === "EAN128") {
    data = ean128Data(payload, line, source);
  } else {
    const parsed = parseTemplatePayload(payload, line);
    data = parsed.kind === "field" ? parsed.field : { literal: parsed.value };
  }
  return {
    kind: "barcode",
    id: importedElementId("tspl", ordinal),
    xMm,
    yMm,
    format,
    sizeMm,
    data,
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят; гейты пакета и потребителей**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-import.test.tsx test/import-analysis.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run --passWithNoTests -t "import"
```

Ожидается: PASS. Имена тестовых файлов импорта в standalone и admin уточнить `grep -ln "parseLabelCode\|import-analysis" apps/standalone/test apps/admin/test` и прогнать найденные; их список — в отчёте.

- [ ] **Step 5: Мутации**

- M1: в `ean128Data` убрать проверку `isValidSscc` (оставить `startsWith("00")`) → FAIL «refuses an EAN128 that holds no SSCC» (`0012345`).
- M2: `type === "EAN128"` в выборе `format` убрать → FAIL «reads back as the SSCC field…».

- [ ] **Step 6: Коммит**

```bash
git add packages/domain/src/labels/tspl-import.ts packages/domain/test/labels-import.test.ts
git commit -F /tmp/claude/msg-hp-4.txt
```

Сообщение: `fix(domain): the TSPL import reads back the EAN128 SSCC the domain itself exports` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 5: Тесты хоста — освобождение и повторный скан в одном пакете, расход блоков в сквозном сценарии

**Files:**

- Test: `apps/standalone/host/tests/facts.rs` (Modify), `apps/standalone/host/tests/floor_scenario.rs` (Modify)

**Interfaces:**

- Consumes: `receive_facts` через `TestApp`; опоры `floor`, `issue_block`, `fact`, `ok_scan`, `box_closed`, `box_exception`, `receipts`, `accepted`, `owned`, `sorted`, `items`, `conflicts` (`host/tests/facts.rs`, `host/tests/support/app.rs`); `pallets`, `station` (`host/tests/floor_scenario.rs`).
- Produces: тест `codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan` и сверка `consumed` в `the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers`. Исходники хоста не меняются (Д6).

- [ ] **Step 1: Тест пакета — дописать в конец `apps/standalone/host/tests/facts.rs`**

```rust

/// A station takes a box apart and packs its codes again, clears an open box and fills it
/// again, undoes a scan and takes it again — and the records reach the host in one batch (the
/// cloud's #650 lost such codes: it applied a batch's exceptions after its scans). The host
/// applies a batch record by record in the station's order, so each exception frees its codes
/// before the scan that takes them again: every record is accepted, the new scans hold the
/// codes, and no conflict is written.
#[tokio::test]
async fn codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    let mut disassemble = box_exception("disassemble", &box_id(1), &instant(11, 0));
    disassemble["reasonCode"] = json!("wrong_quantity");
    let mut undo = box_exception("undo", &box_id(3), &instant(31, 0));
    undo["codeHash"] = json!(code_hash(5));
    undo["targetScannedAt"] = json!(instant(30, 0));
    let batch = vec![
        // A closed box taken apart, its codes packed into another box.
        scan(1, 1, 1, 1),
        scan(2, 2, 1, 2),
        fact(
            &record_id(3),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2],
                &instant(1, 0),
                &instant(10, 0),
            ),
        ),
        fact(&record_id(4), "box_exception", shift, disassemble),
        scan(5, 1, 2, 12),
        scan(6, 2, 2, 13),
        fact(
            &record_id(7),
            "box_closed",
            shift,
            box_closed(
                &box_id(2),
                &block,
                1501,
                &[1, 2],
                &instant(12, 0),
                &instant(20, 0),
            ),
        ),
        // An open box cleared and filled again.
        scan(8, 3, 4, 21),
        fact(
            &record_id(9),
            "box_exception",
            shift,
            box_exception("clear", &box_id(4), &instant(22, 0)),
        ),
        scan(10, 3, 4, 23),
        // A scan undone and taken again.
        scan(11, 5, 3, 30),
        fact(&record_id(12), "box_exception", shift, undo),
        scan(13, 5, 3, 32),
    ];
    let all: Vec<Value> = (1..=13).map(|n| accepted(&record_id(n))).collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, all);
    assert_eq!(conflicts(&admin).await, Vec::<Value>::new());
    assert_eq!(
        owned(&admin).await,
        sorted(vec![
            (code_hash(1), record_id(5)),
            (code_hash(2), record_id(6)),
            (code_hash(3), record_id(10)),
            (code_hash(5), record_id(13)),
        ])
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(1), code_hash(1), instant(1, 0), instant(11, 0), null]),
            json!([record_id(2), code_hash(2), instant(2, 0), instant(11, 0), null]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![
            json!([record_id(5), code_hash(1), instant(12, 0), null, null]),
            json!([record_id(6), code_hash(2), instant(13, 0), null, null]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(4)).await,
        vec![
            json!([record_id(8), code_hash(3), instant(21, 0), instant(22, 0), null]),
            json!([record_id(10), code_hash(3), instant(23, 0), null, null]),
        ]
    );
    // The batch once more: the same receipts, nothing written again.
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        (1..=13)
            .map(|n| accepted(&record_id(n)))
            .collect::<Vec<_>>()
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}
```

- [ ] **Step 2: Сверка расхода блоков в сценарии — `apps/standalone/host/tests/floor_scenario.rs`**

Фрагмент 1:

```rust
/// What the host keeps of the pallets, read by their serials: whether each
```

заменить на:

```rust
/// The highest serial the closes used, per extension (a box's block 0, a pallet's 1): what
/// `blocks::consume` keeps for a restore and for the office's counters.
async fn consumed(admin: &Admin) -> Vec<(i64, Option<i64>)> {
    sqlx::query_as(
        "SELECT extension, max(consumed_through) FROM sscc_blocks \
         GROUP BY extension ORDER BY extension",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

/// What the host keeps of the pallets, read by their serials: whether each
```

Фрагмент 2:

```rust
    assert_eq!(
        pallets(&admin).await,
        vec![(40, Some(2), 2, false), (41, Some(1), 1, true)]
    );
```

заменить на:

```rust
    assert_eq!(
        pallets(&admin).await,
        vec![(40, Some(2), 2, false), (41, Some(1), 1, true)]
    );
    // Each kind of block remembers the highest serial its closes used: the third box and the
    // second pallet (plan ХП; a pallet's close consumes its pallet block like a box's).
    assert_eq!(consumed(&admin).await, vec![(0, Some(1502)), (1, Some(41))]);
```

- [ ] **Step 3: Прогнать**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test facts codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test floor_scenario
```

Ожидается: PASS (поведение хоста уже верно — Д6). Если первый тест падает (конфликт, отказ `box_state`, иная форма квитанции), сначала проверить опоры (`box_exception` у `undo` требует `reasonCode: null` — так и есть; `box_closed` второго короба — серийник 1501 в блоке 1500…); подтверждённый дефект хоста — наименьшая правка в `host/src/facts/exception.rs`/`registry.rs`, тест хоста под правку, запись в «Отклонения».

- [ ] **Step 4: Мутации**

- H1: в `host/src/facts/exception.rs` убрать `registry::release(&mut *conn, scan_id).await?;` → FAIL `codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan` (`conflict` у повторных сканов).
- H2 (HM2 ревью ПЛ-Ц): в `host/src/facts/pallet_closed.rs` убрать `blocks::consume(&mut *conn, &closed.block_id, serial).await?;` → FAIL `--test floor_scenario` (`(1, None)`).

Для мутаций Rust после восстановления файла — `touch` его, чтобы cargo пересобрал.

- [ ] **Step 5: Коммит**

```bash
git add apps/standalone/host/tests/facts.rs apps/standalone/host/tests/floor_scenario.rs
git commit -F /tmp/claude/msg-hp-5.txt
```

Сообщение: `test(standalone): the host keeps codes freed and scanned again in one batch, and the scenario pins the blocks' use` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 6: Документы — `AGENTS.md`, памятка о восстановлении, раздел 25 спецификации

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

**Interfaces:**

- Consumes: всё задач 1–5 (как исполнено; «Отклонения» каждой задачи).
- Produces: документы говорят то, что делает код.

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
`floor_pallet_exceptions` has none, on purpose (see «Floor pallets», known
limits). Additive only, `0007` rows stay as they were (a test on Node's SQLite
````

заменить на:

<!-- prettier-ignore -->
````markdown
`floor_pallet_exceptions` got its index by shift with migration `0010` (plan
ХП, below). Additive only, `0007` rows stay as they were (a test on Node's SQLite
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
and `tests/local_db.rs` pin the columns, the indexes and the query plans of the
pallets' reads on both SQLite engines (Node's and the shell's older one).

## Writes
````

заменить на:

<!-- prettier-ignore -->
````markdown
and `tests/local_db.rs` pin the columns, the indexes and the query plans of the
pallets' reads on both SQLite engines (Node's and the shell's older one).

Migration `0010_shift_indexes` (plan ХП) adds three indexes by shift for the
retention's deletes: `outbox_shift (shift_id, host_id, device_id, acked_at)`,
`floor_exceptions_shift (shift_id, host_id, device_id)` and
`floor_pallet_exceptions_shift (shift_id, host_id, device_id)`. The shift leads
each on purpose: an index led by `(host_id, device_id)` becomes the first step
of the hourly due select on SQLite 3.53 (a walk of every record of the pairing
instead of `outbox_settled`), and with `acked_at` after the shift the status
bar's count of unsent records too. `acked_at` ends the outbox's index, so the
retention's check for an unsent record of a shift reads the index alone.
Additive only: `test/floor-shift-indexes.test.ts` (Node's SQLite) and
`migration_0010_adds_the_shift_indexes_and_keeps_every_row` (`tests/local_db.rs`,
the shell's own `Migrator`) apply it over a database of `0009`. Every delete of
`RETAINED_TABLES` searches an index by shift, pinned in both lists of plans.

## Writes
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
- The delete of a purged shift reads `outbox` and `floor_exceptions` whole
  (there is no index by `shift_id`; measured 176 ms against 37 ms with one),
  and, with `secure_delete` on, the WAL grows by about 31 MB per 1000 deleted
  print jobs. A migration with `outbox (host_id, device_id, shift_id)` and
  `floor_exceptions (host_id, device_id, shift_id)` would remove both. Plan
  ПЛ-Ц's migration `0008_floor_pallets` did not add them (it adds only
  `floor_pallets_shift`), and plan РК, which brought the backups, added no station
  migration either: the owner decides. `floor_pallet_exceptions`
  is read whole by the delete in the same way, and its scan is pinned in both
  engines' plan lists.
````

заменить на:

<!-- prettier-ignore -->
````markdown
- Every delete of a purged shift searches an index by shift (migration `0010`,
  plan ХП; before it `outbox`, `floor_exceptions` and `floor_pallet_exceptions`
  were read whole: 176 ms against 37 ms at 600 000 outbox rows). What stays is
  the cost of `secure_delete`: the WAL grows by about 31 MB per 1000 deleted
  print jobs (138 ms on NVMe; on eMMC or SATA under `synchronous = FULL` likely
  0.5–2 s of stalled floor writes, once or twice a day, with no risk to data).
  The zeroing is kept: it is what takes deleted codes off the disk.
````

Фрагмент 4:

<!-- prettier-ignore -->
````markdown
  which loses it; the screen's `settlePallet` retries up to three lost serials
  in a row and then waits with «Номер SSCC паллеты не подошёл и пропущен» —
  never a stop of the line.
````

заменить на:

<!-- prettier-ignore -->
````markdown
  which loses it. The screen's full-pallet close (`settlePallet`) and the early
  close both lose up to three serials in a row (`closeLosingBadSerials`, plan
  ХП): the full pallet then waits with «Номер SSCC паллеты не подошёл и
  пропущен» — never a stop of the line —, the early close stops with
  «Повторить».
````

Фрагмент 5:

<!-- prettier-ignore -->
````markdown
  soon as serials come (`closePalletIfFull`: on entry, after a box, when a
  pallet block arrives). The message is derived (`palletWaitsNow`): it shows
````

заменить на:

<!-- prettier-ignore -->
````markdown
  soon as serials come (`closePalletIfFull`: on entry, after a box, when a
  pallet block arrives — the block a box's top-up brings queues the close as a
  turn of its own, plan ХП). The message is derived (`palletWaitsNow`): it shows
````

Фрагмент 6:

<!-- prettier-ignore -->
````markdown
  stops the work with its reason (`pallet_no_serials`); an `invalid_serial` is
  the stop `pallet_failed` with «Повторить». The button is off while any stop
````

заменить на:

<!-- prettier-ignore -->
````markdown
  stops the work with its reason (`pallet_no_serials`); three `invalid_serial`
  in a row are the stop `pallet_failed` with «Повторить». The button is off while any stop
````

Фрагмент 7:

<!-- prettier-ignore -->
````markdown
- `floor_pallet_exceptions` has no shift index: no read of it by pallet or shift
  exists (it is only written), and the retention's delete scans it whole, as it
  scans `floor_exceptions` and `outbox`. A read by pallet or shift needs a new
  migration and moves the table off the two pinned scan lists.
- The intention to close the shift is not kept across a pallet stop (no serial,
````

заменить на:

<!-- prettier-ignore -->
````markdown
- The intention to close the shift is not kept across a pallet stop (no serial,
````

Фрагмент 8:

<!-- prettier-ignore -->
````markdown
- A full pallet waiting for serials asks the host for them, inside the work
  queue, on every box close while the link is up: up to 2 × 10 s when the host
  hangs, during which the work queue waits, as a box close waiting for box
  serials does.
````

заменить на:

<!-- prettier-ignore -->
````markdown
- A full pallet waiting for serials never holds the work queue (plan ХП): the
  top-up after each box close asks the host in the background, and a block
  that comes queues the pallet's close (`palletArrived`). The early close
  («Закрыть паллету досрочно», «Закрыть паллету и смену») still asks the host
  inside the queue when no serial is left — up to 2 × 10 s with a hung host, as
  a box close waiting for box serials does: the operator pressed it and waits
  for its answer.
````

Фрагмент 9:

<!-- prettier-ignore -->
````markdown
only after a restore (`conflict` on `no_restore`), 1-64 blocks.
````

заменить на:

<!-- prettier-ignore -->
````markdown
only after a restore (`conflict` on `no_restore`), 0-64 blocks: an empty list
(a station that never took a block, plan ХП) only marks the station.
````

Фрагмент 10:

<!-- prettier-ignore -->
````markdown
- A pairing without blocks never calls the route (the host asks for 1–64
  blocks), so the office lists it «Не вернула» although nothing is owed; the
  station says nothing. The follow-up is the host's: accept an empty list, or
  expose whether the station ever had blocks (`hasBlocks`).
````

заменить на:

<!-- prettier-ignore -->
````markdown
- A pairing without blocks sends one empty request (plan ХП), so it is marked
  «Вернула» once it reaches the host. A station paired again leaves its former
  device's row (from the copy) «Не вернула» until that device is revoked; the
  office's texts say so (`blocksNote`, `confirmNotReturned`).
````

- [ ] **Step 2: `docs/runbooks/standalone-backup-restore.md`**

Фрагмент 1:

<!-- prettier-ignore -->
````markdown
- на странице «Резервные копии» станции, подключённые заново, остаются «Не вернула» (блоков под
  новым подключением нет), как и записи станций из копии. «Вернули … из …» там будет 0: это не сбой и
  не сигнал.
````

заменить на:

<!-- prettier-ignore -->
````markdown
- на странице «Резервные копии» станция, подключённая заново, отмечается «Вернула» под новым
  подключением (блоков у неё нет, она отправляет пустой список), а запись её прежнего устройства из
  копии остаётся «Не вернула», пока устройство не отозвано: это не сбой и не сигнал.
````

Фрагмент 2:

<!-- prettier-ignore -->
````markdown
  блоков не было вовсе, и станция, подключённая заново на новом ПК, остаются «Не вернула», хотя
  возвращать им нечего (хост пока не принимает пустой список блоков).
````

заменить на:

<!-- prettier-ignore -->
````markdown
  блоков не было вовсе, и станция, подключённая заново на новом ПК, отправляют пустой список и тоже
  отмечаются «Вернула»; запись прежнего устройства станции, подключённой заново, остаётся
  «Не вернула», пока устройство не отозвано.
````

Фрагмент 3:

<!-- prettier-ignore -->
````markdown
- **Станция без блоков и отметка «Вернула».** Станция, которая ещё не получала блоков SSCC, остаётся
  «Не вернула» (хост принимает от 1 до 64 блоков; доработка хоста: принимать пустой список или
  показывать, были ли блоки). Отметку хост ставит, ответив на первую часть блоков, — не на последней
  и даже тогда, когда все её блоки он отклонил.
````

заменить на:

<!-- prettier-ignore -->
````markdown
- **Станция без блоков и отметка «Вернула».** Станция, которая ещё не получала блоков SSCC,
  отправляет хосту пустой список и отмечается «Вернула», как только выйдет на связь (план ХП: хост
  принимает от 0 до 64 блоков). Отметку хост ставит, ответив на первую часть блоков, — не на
  последней и даже тогда, когда все её блоки он отклонил.
````

Фрагмент 4:

<!-- prettier-ignore -->
````markdown
      блоки (если есть) переданы разработчику, в «Резервные копии» у станций «Вернула» (кроме
      станций без блоков и подключённых заново на новом ПК), справочники совпадают с офисом
````

заменить на:

<!-- prettier-ignore -->
````markdown
      блоки (если есть) переданы разработчику, в «Резервные копии» у станций «Вернула» (кроме
      прежних записей станций, подключённых заново на новом ПК), справочники совпадают с офисом
````

- [ ] **Step 3: Спецификация пилота — дописать в конец `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`**

<!-- prettier-ignore -->
````markdown

## 25. Уточнения плана ХП

План ХП собрал правки хоста и оболочки, которые ревью планов РК-С, 2a8 и ПЛ-Ц перенесли в план с
миграциями.

- **Возврат блоков без блоков.** `POST /v1/device/sscc/blocks/known` принимает от 0 до 64 блоков;
  пустой список только отмечает станцию для текущей эпохи (`devices.known_blocks_epoch`): ревизии и
  записи журнала нет. Станция без блоков отправляет один пустой запрос, поэтому в карточке удержания
  она «Вернула», как только выйдет на связь. «Не вернула» остаётся у станции, которая ещё не выходила
  на связь или которой хост отвечает ошибкой, и у записи прежнего устройства станции, подключённой
  заново. Ограничение раздела 24 о станции без блоков снято.
- **Индексы по смене — миграция оболочки `0010`.** `outbox_shift (shift_id, host_id, device_id,
  acked_at)`, `floor_exceptions_shift` и `floor_pallet_exceptions_shift (shift_id, host_id,
  device_id)`: удаление смены при очистке больше не читает эти таблицы целиком. Смена стоит первой
  намеренно: индекс, начинающийся с подключения, SQLite делает первым шагом часовой выборки смен к
  очистке (проход по всем записям подключения), а с `acked_at` — и счёта неотправленных записей.
  Планы запросов закреплены в обоих списках. Остаётся цена `secure_delete` — около 31 МБ журнала WAL
  на 1000 удалённых заданий печати.
- **Досрочное закрытие паллеты** теряет до трёх номеров подряд, из которых не выходит SSCC, как
  закрытие полной паллеты, и только после трёх останавливается с «Повторить».
- **Номера паллет без ожидания хоста.** Полная паллета, ждущая номеров, больше не держит очередь
  работы: номера просит пополнение после закрытия короба, и пришедший блок ставит закрытие паллеты
  отдельным ходом очереди. Досрочное закрытие без номеров по-прежнему спрашивает хост внутри очереди
  (до 2 × 10 с при зависшем хосте): оператор нажал и ждёт ответа. Ограничение раздела 19 об ожидании
  до 2 × 10 с на каждое закрытие короба снято.
- **Импорт TSPL** читает `EAN128`, который пишет сам домен для SSCC (ИИ `00` и верный SSCC, а также
  `00{{sscc}}` и `{{sscc}}`), как штрихкод Code 128 поля `sscc`; `EAN128` с другим содержимым
  отклоняется. Ширины штрихов TSPL импорт по-прежнему не читает.
- **Тесты хоста.** Разборка короба, очистка и отмена скана с повторным сканом тех же кодов в одном
  пакете фактов (аналог облачного #650): хост применяет записи по порядку очереди станции,
  повторный скан получает код, конфликтов нет. Сквозной сценарий сверяет наибольший использованный
  номер блоков коробов и паллет (`consumed_through`).
- **Не проверено:** Windows, WebView2, принтеры и зависший хост в настоящей сети цеха; SQLite 3.46
  оболочки проверена только тестом `local_db` на компьютере разработчика; объём записи индекса
  `outbox_shift` на настоящем потоке сканов не измерялся.
````

Если задачи 1–5 исполнены с отклонениями, текст раздела и `AGENTS.md` правится под исполненное.

- [ ] **Step 4: Проверка и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/runbooks/standalone-backup-restore.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git diff --check
git add apps/standalone/AGENTS.md docs/runbooks/standalone-backup-restore.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -F /tmp/claude/msg-hp-6.txt
```

Сообщение: `docs(standalone): plan ХП — empty block list, shift indexes, pallet serials, EAN128 import` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Итоговая проверка плана

1. Пакет вебвью: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS. Падение старого теста под нагрузкой записывается и разбирается, а не лечится повтором.
2. Домен: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain test`, `typecheck`, `lint`, `build` — PASS; тесты импорта потребителей (standalone, admin) — PASS.
3. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db`; `-p markiro-host --test known_blocks`, `--test facts`, `--test floor_scenario`; `-p markiro-proto --test backup` — PASS. Гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы (его `ipc` и `hello` открывают сокет), частями, если весь не помещается.
4. Стенд с задержкой `setImmediate` и verbose-прогон — `floor-work-pallets.test.tsx`, `floor-work-close-pallets.test.tsx`, `backups-page.test.tsx`: PASS, нет `stderr |`.
5. Каждая мутация задач 1–5 — FAIL названного теста; файл восстановлен (`cmp`, тот же `shasum`); `git status --short` после всех — пуст.
6. `git diff --stat <основа> -- apps/standalone/src-tauri/migrations` — только `0010_shift_indexes.sql`; `-- apps/standalone/host/migrations` — пусто; `-- apps/standalone/host/src` — только `routes/known_blocks.rs` (и, если Д6 сработала, `facts/exception.rs`/`registry.rs`, записанные в «Отклонения»).
7. `grep -rn "confirmNoBlocks" apps/standalone` — пусто; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — только `src/host/pairing-code.ts:66`.
8. `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».

## Перенесено

- **ZPL-импорт `>;>800…`** (SSCC, который домен пишет в `^BC`): импорт ZPL читает его как литерал Code 128 — тот же класс, что `EAN128` в TSPL, но поручение назвало только TSPL. Правка `zpl-import.ts` по образцу `ean128Data` — отдельной задачей.
- **Ширины штрихов TSPL** (`BARCODE …,<narrow>,<wide>,…`) импорт не читает в `moduleWidthMm`, как ZPL-импорт читает `^BY`.
- **Отметка «Вернула» на первой части** (ревью РК-С, M2/m5): хост ставит её на первом ответе, даже если отклонил все блоки; признак «последняя часть» — отдельная правка протокола.
- **Отказанные и конфликтные записи и очистка через 30 дней** (ревью 2a8, Minor 2) — план ОЧ и владелец.
- **Выключение `secure_delete` для очистки** — не делается: обнуление удалённых строк держит коды вне диска.
- **Мутация T4 сценария** (`closeShift` без `openPalletGuard`) выживает в сценарии по замыслу: её ловят тесты задачи 6 ПЛ-Ц.

## Не проверено

- Windows, WebView2, сенсорная панель, принтеры, сканеры — ничего из задачи 3 не запускалось вне jsdom с `node:sqlite`.
- Зависший хост в настоящей сети цеха (ожидание пополнения в фоне, ход очереди после блока паллет).
- Планы запросов на SQLite 3.46 оболочки при написании плана сняты не были (сняты на 3.53 и 3.44); их проверяет `--test local_db` исполнителя.
- Цена записи индекса `outbox_shift` на настоящем потоке сканов и цена `secure_delete` на eMMC/SATA ПК клиента.
- Настоящее восстановление `markiro-host restore` со станцией без блоков и с переподключённой станцией (памятка, раздел 10).

## Отклонения при исполнении

- **Задача 1.**
  - Фрагменты брифа совпали по одному разу.
  - `test/floor-status-bar.test.tsx` (нет в списке файлов) исправлен по смыслу, как предусматривает шаг 4: подключение без блоков теперь делает один запрос `{ blocks: [] }`.
  - Сверх плана: хост принимает 64 блока и отклоняет 65; станция отправляет ровно 64 блока одним запросом; хост без восстановления слышит пустой запрос, и подключение рассчитывается; упавший пустой запрос оставляет долг.
- **Задача 2.**
  - Без отклонений: фрагменты совпали, планы запросов на SQLite 3.46 оболочки совпали со строками брифа.
  - Создание трёх индексов на 600 000 записях `outbox` (`node:sqlite`) — около 0,37 с.
- **Задача 3.**
  - Тест «says the pallet did not close when its serial was lost…» падал до реализации, а не проходил, как ждал бриф: с тремя занятыми номерами без цикла «Повторить» тратит второй номер. С циклом три попытки теряют 0, 1, 2, «Повторить» берёт 3.
  - Начальное значение `palletArrived` записано как `() => Promise.resolve()`: `async () => undefined` не проходит правило линтера `require-await`.
  - Тест с удержанным запросом хоста использует `act` и `turnsUntil`, а не `work.scan`: стенд ждёт ворота, а значит и удержанный запрос.
  - `topUpTracked` удалён: единственным потребителем был `afterClosed`.
  - Сверх плана: тест «closes no pallet in the turn a pallet block queues while a stop stands on the line» (убивает мутации M6 и M12).
  - Мутация M13 (`const pallet = true`) выживает: лишний ход очереди не находит паллеты к закрытию, поведение то же.
- **Задача 4.**
  - Фрагменты совпали; отклонений нет.
  - Сверх плана: обратное чтение 45 SSCC через `generateTspl`, регистр типа (`ean128`), расширенный список отказов, прежние формы `128` и `EAN13`, неизвестные типы по-прежнему отклоняются.
  - Прежний экспорт `"128"` + `"!100<sscc>"` по-прежнему читается литералом Code 128 (закреплено тестом); `allowLegacyBangOnePrefix` живёт в `parseScannedSscc`, импорт его не использует.
- **Задача 5.**
  - Исходники хоста не менялись (Д6), фазы RED не было: красным доказательством служат мутации хоста A1–A9 и S1–S5.
  - Мутация S4 (запись последнего номера без `max`) сценарием не убивается — закрытия приходят по возрастанию; её убивают два существующих теста `--test facts`.
  - Проверку «ничего не записано повторно» после повтора пакета ни одна однострочная мутация хоста отдельно не убивает: мутации повтора падают раньше.
- **Задача 6.**
  - Пункт об индексах в §25 переписан без кода через перенос строки: prettier снимает отступ такого продолжения, и файл не проходит гейт.
  - Сверх плана: коммит `fdb8ee569` устраняет вероятностный сбой теста хоста `the_office_reads_a_shifts_totals_from_its_facts` (1 из 50 прогонов). Второе устройство получает построенный id `ffffffff-ffff-4fff-bfff-ffffffffffff`, а не случайный; мутация порядка в `office_shifts.rs` валит тест детерминированно.
- **Слияние с интеграцией (`0ca4d78d0`).**
  - После миграции `0010` запрос `FORGET_UNSENT_ANY_SQL` и счёт `UnsentGuard::AnyPairing` оболочки планировались как `SCAN outbox USING COVERING INDEX outbox_shift` (вся таблица с рассчитанными записями) вместо `outbox_unsent`; закреплённый тест планов СКЛ падал в обоих списках.
  - Исправлено по образцу ОЧ для `STRANDED_COUNT_SQL`: `INDEXED BY outbox_unsent` в `src/local/outbox.ts`, `INDEXED BY {table}_unsent` в `count_unsent` `src-tauri/src/local_db.rs`; закрепления обновлены в обоих списках, тест совпадения текстов расширен. Результаты те же, меняется только план.
  - Добавлены тесты порядка миграций: `0009`/`0010` → `0012` + `0013` за один запуск и `0010`, пришедшая после `0012` и `0013`. Тесты журнала читают список `MIGRATOR`, пропуск `0011` законен.
  - `knownBlocksRequestSchema` после слияния сохраняет `.max(64)`.
- **Счёт тестов.** План чисел не задавал. `cargo test --workspace`: 1126 (задача 1) → 1127 (задача 2) → 1128 (задачи 5 и 6). Vitest пакета после задачи 3: 4613 прошло и 3 падения по таймауту 5 с в `template-editor.test.tsx` под нагрузкой (отдельно 97 из 97). Домен: 1210 прошло, 3 падения `print-forms-snapshot` (`ПАЛЕТА`/`ПАЛЛЕТА`) были до плана и исправлены коммитом `26572c386`; `labels-import` — 29. После слияния `0ca4d78d0`: Vitest 165 файлов, 5090 тестов; `cargo test --workspace` — 1313.
- **Итоговое ревью.**
  - Критических и важных замечаний нет, восемь мелких; одобрено для беты.
  - Счёт неотправленных записей всех подключений после `0010` обходил `outbox_shift` (около 25 мс на 600 000 записей) — исправлено при слиянии `0ca4d78d0`.
  - Необязательная волна исправлений не исполнялась. Открыты: ошибка записи в ходе `palletArrived` не закреплена (мутация K9 выживает); повтор досрочного закрытия после пополнения не закреплён за `closeLosingBadSerials` (K8); граница ровно 18 цифр у `EAN128` не закреплена (K12); устаревшая строка «1-64 a request» в комментарии `src/host/api.ts`.
  - Перенесены: старые таймауты наборов офиса под нагрузкой — отдельной задачей; прежний TSPL `"!100<sscc>"` — вместе с ZPL-импортом `>;>800`; сохранность `.max(64)` в задаче 7 ОЧ — подтверждена слиянием; непрерывность версий в `local_db.rs` — снята слиянием (список `MIGRATOR`).
  - Без подъёма `PROTOCOL_VERSION` для пустого списка: хост с маршрутом `known` до ХП не выпускался.
