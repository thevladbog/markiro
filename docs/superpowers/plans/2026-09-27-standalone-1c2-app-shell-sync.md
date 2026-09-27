# План 1c2: оболочка приложения для второго устройства — локальная база, подключение по коду, выбор линии и связь с хостом — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust-оболочка приложения хранит справочники станции в локальной SQLite и даёт вебвью два узких входа в неё. Она подключает устройство к хосту в сети по одноразовому коду, закрепляя отпечаток сертификата до отправки кода. Она запоминает выбранную станцией линию и держит фоновый поток SSE с хостом, сообщая интерфейсу о связи и о каждой новой ревизии. Привязки TypeScript к новым командам меняются вместе с ними.

**Architecture:**

- `local_db.rs` открывает `standalone-station.db` в локальном каталоге данных приложения:
  - один пишущий пул и пул только для чтения (sqlx);
  - миграции из `src-tauri/migrations`;
  - проверенные команды `local_query` и `local_transaction`.
- `DeviceState` получает методы `claim` и `select_line` и канал `watch` с текущей связкой «адрес, отпечаток, ключ».
- Фоновая задача `connection::supervise` следит за этим каналом:
  - держит `GET /v1/changes/stream` через клиент с закреплённым сертификатом;
  - разбирает SSE;
  - переподключается с растущей паузой;
  - публикует события Tauri и снимок для команды `connection_status`.
- В вебвью появляются тонкие привязки:
  - `src/host/device.ts` — `claim`, `selectLine`;
  - `src/host/connection.ts`;
  - `src/local/executor.ts` с исполнителем на `node:sqlite` для тестов по тем же миграциям.

  Экраны, синхронизация справочников и офисная страница «Устройства» — план 1c3.

**Tech Stack:**

- Rust: Tauri 2.11, sqlx 0.8.6 SQLite, reqwest 0.13.4 с rustls (aws-lc-rs), tokio 1.53.1.
- TypeScript: zod 4.4.3, `@tauri-apps/api` 2.11.1, Vitest с `node:sqlite`.

**Спецификации:**

- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:
  - §4.7 — подключение устройств;
  - §5.2 — Rust-часть приложения;
  - §5.3 — локальная база станции;
  - §5.4 — синхронизация справочников (реализует план 1c3);
  - §7 — тестирование.
- API хоста, которым пользуется этот план, — план 1c1 (`docs/superpowers/plans/2026-09-27-standalone-1c1-host-pairing-feed.md`):
  - `POST /v1/pairing/claim`;
  - `PUT /v1/device/line`;
  - `GET /v1/changes`;
  - `GET /v1/changes/stream`.
- Отложенные пункты прежних планов — ledger `.superpowers/sdd/progress.md`. Среди них IPC-тест `host_claim` вместо IPC-теста `host_local_pair`: тот всегда стучится на порт 45710.

## Global Constraints

**Зависимости**

- Новая зависимость оболочки — только `sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite", "migrate", "macros"] }`. Это тот же крейт и те же возможности, что у хоста; в `apps/standalone/Cargo.lock` он уже есть.
- У `tokio` оболочки добавляются возможности `macros` и `time`.
- Других крейтов и JS-зависимостей не добавлять.
- В `Cargo.lock` меняется только список зависимостей `markiro-standalone`.

**Локальная база**

- Файл `standalone-station.db` лежит в `app_local_data_dir`, рядом с `device.json`.
- Настройки: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout` 5 с.
- Миграции — `src-tauri/migrations` через `sqlx::migrate!`; применённую миграцию не редактируют.
- Одно пишущее соединение, транзакции `BEGIN IMMEDIATE`; чтение — через соединения только для чтения.
- Если базу не удалось открыть, приложение всё равно запускается, а команды отвечают `local_db_unavailable`.

**`local_query(sql, params)` и `local_transaction(statements)`**

- `local_query` принимает ровно один оператор `SELECT` или `WITH` и возвращает массив объектов по именам столбцов.
- `local_transaction` принимает `[{ sql, values, expectedChanges? }]` и возвращает массив числа изменённых строк.
- Ограничения:
  - от 1 до 32 операторов;
  - не больше 64 КБ SQL на оператор;
  - не больше 256 значений на оператор;
  - без `;` (кроме одной в конце), `--` и `/*`;
  - запрещены слова `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `CREATE`, `DROP`, `ALTER`, `REINDEX`.
- Несовпадение `expectedChanges` или любая ошибка откатывает всю пачку.
- Значения: `null`, логические, строки, целые (64 бита), дробные. BLOB в ответе не поддерживается.
- Коды отказов: `local_db_unavailable`, `invalid_statement`, `unsupported_value`, `statement_failed`, `changes_mismatch`.
- Большая порция справочника передаётся одним параметром JSON на сущность (`json_each`): ограничения держат размер SQL, а не число строк.

**Таблицы этапа 1c**

- `ref_org`, `ref_site`, `ref_lines` — копии записей ленты со своим `rev`.
- `sync_state(key, value)`.
- Операторы, бейджи, товары и шаблоны добавляют планы 1d и 1e.

**`host_claim(address, fingerprint, code, name)`**

- Устройство подключается видом `station`.
- Отпечаток — ровно 64 hex-символа в нижнем регистре. Иначе `invalid_request`, до любого обращения к сети.
- Сначала `hello` с наблюдением отпечатка: несовпадение с `fingerprint` — это `certificate_mismatch`, и код не отправляется.
- Сам код уходит только клиентом с закреплённым `fingerprint`.
- `hostId` из ответа должен совпасть с `hello`, иначе `host_changed`.
- Отказы хоста: `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`, остальное — `pair_rejected`.

**`device_select_line(lineId)`**

- Отправляет `PUT /v1/device/line`; при успехе `lineId` из ответа хоста записывается в `device.json`.
- Отказы: `line_rejected` (HTTP 400), `key_rejected` (HTTP 401), `request_failed` (иное).

**Маршруты `host_request`**

- Разрешены:
  - `/v1/device` и `/v1/device/…`, кроме `/v1/device/line`;
  - `/v1/bootstrap`;
  - ровно `/v1/changes`;
  - `/v1/office/…`.
- Поток `/v1/changes/stream` и выбор линии идут только своими путями: фоновой задачей и командой `device_select_line`.

**Связь с хостом**

- Поток: фоновая задача держит `GET /v1/changes/stream` с ключом устройства и закреплённым сертификатом.
- Таймауты: общего таймаута нет; соединение, молчащее 45 с (три пропущенных пульса по 15 с), считается потерянным. Соединение устанавливается не дольше 2 с.
- Переподключение: пауза 1 с, удваивается до 30 с; после соединения, которое было «на связи», пауза снова 1 с.
- Событие `standalone://host-status`:
  - `{ state: "online" | "connecting" | "offline", lastContactAt, lastError, seq }`;
  - `lastContactAt` — миллисекунды Unix или `null`;
  - `lastError` — один из кодов `unreachable`, `certificate_mismatch`, `key_rejected`, `stream_refused`, `stream_ended` или `null`.
- Событие `standalone://host-revision` — `{ rev }` на каждое событие `rev` потока, включая первое после каждого подключения.
- `connection_status()` возвращает последний статус. `seq` растёт на один с каждым опубликованным статусом.
- Неподключённое устройство — `offline` с `lastError: null`, без попыток соединения.

**Секреты и контракт**

- Ключ устройства не пересекает IPC. Код подключения приходит из вебвью только аргументом `host_claim`. Ни ключ, ни код не попадают в `Debug` и в журналы.
- Контракт IPC закрепляется в `src-tauri/tests/ipc.rs`:
  - имена команд и аргументов;
  - формы ответов;
  - отказы голыми строками.
- Привязки TypeScript меняются в этом же плане.
- `apps/station` не меняется. Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` и `… --all -- --check`.
- Для TS, JSON и MD: `node_modules/.bin/prettier --write <файлы>` и `--check`.
- `git diff --check`.

**Cargo и песочница**

- Cargo запускается с `--offline`. Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы.
- Тесты `src-tauri/tests/*.rs` запускают настоящий хост на 127.0.0.1 — только вне песочницы. `local_db.rs` порт не слушает.
- Вывод cargo может сокращать локальная обёртка `rtk`; если вывод выглядит урезанным, запускайте `rtk proxy cargo …`.
- Крейт `markiro-standalone` встраивает `apps/standalone/dist`: каталог должен существовать (`pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`).

**`Cargo.lock`**

- Добавление зависимости может заставить cargo без сети переразрешить посторонние пакеты на старые версии: так уже было в плане 1c1.
- После правки `Cargo.toml` посмотрите `git diff apps/standalone/Cargo.lock`. Допустима ровно одна новая строка `"sqlx",` в зависимостях `markiro-standalone`.
- Если изменилось что-то ещё, верните файл (`git checkout apps/standalone/Cargo.lock`), впишите строку вручную и проверьте `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --locked --offline`.

**pnpm и git**

- pnpm в песочнице — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать.
- Не использовать `git stash`.
- Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата.

**Тесты вебвью**

- Тесты, читающие файлы рядом с собой, сначала сохраняют `import.meta.url` в переменную, а потом строят `new URL(…, moduleUrl)`: окружение jsdom переписывает буквальный `new URL(…, import.meta.url)` (см. `test/protocol.test.ts`).

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/src-tauri/Cargo.toml, apps/standalone/Cargo.lock                                           задачи 1, 4
apps/standalone/src-tauri/migrations/0001_reference_data.sql, src-tauri/src/local_db.rs                    задача 1
apps/standalone/src-tauri/tests/local_db.rs                                                                задача 1
apps/standalone/src-tauri/src/lib.rs, src-tauri/tests/ipc.rs                                               задачи 1–4
apps/standalone/src-tauri/src/device.rs                                                                    задачи 2–4
apps/standalone/src-tauri/tests/claim.rs                                                                   задача 2
apps/standalone/src-tauri/tests/line.rs                                                                    задача 3
apps/standalone/src-tauri/src/{host_client,connection}.rs, src-tauri/tests/connection.rs                   задача 4
apps/standalone/src/host/{device,connection}.ts, src/local/executor.ts, src/i18n/ru.json                   задача 5
apps/standalone/test/{device,connection,local-executor}.test.ts, test/support/local-db.ts                  задача 5
apps/standalone/AGENTS.md, спецификация §5.2–5.3                                                           задачи 1–5
```

---

### Task 1: Локальная база станции — `local_query` и `local_transaction`

Станция хранит справочники хоста у себя, чтобы работать без хоста (спецификация, §5.3). Эта задача даёт базу и два узких входа в неё. Писатель — синхронизация справочников вебвью (план 1c3). Пишет она только пачками в одной транзакции, а читает на соединениях, которым SQLite запрещает запись. Схема — только миграции оболочки.

Лимиты пачки те же, что у `grant_atomic_execute` станции (`apps/station/src-tauri/src/grant_transaction.rs`), но 32 оператора не ограничивают число строк: порция ленты вставляется одним оператором на сущность с параметром JSON (`json_each`). Последний тест задачи это доказывает.

**Files:**

- Modify: `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/Cargo.lock`
- Create: `apps/standalone/src-tauri/migrations/0001_reference_data.sql`, `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src-tauri/tests/local_db.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2, §5.3)

**Interfaces:**

- Consumes: `DeviceState` (`device.rs`), `invoke_handler()` и `run()` (`lib.rs`), помощники `mock_app`/`invoke` в `tests/ipc.rs`.
- Produces:
  - `local_db::{LocalDb, LocalDbState, LocalStatement, LocalDbError, FILE_NAME, MAX_STATEMENTS, MAX_SQL_BYTES, MAX_VALUES}`;
  - `LocalDb::open(dir: &Path) -> Result<LocalDb, sqlx::Error>`;
  - `LocalDb::query(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, LocalDbError>`;
  - `LocalDb::transaction(&self, statements: Vec<LocalStatement>) -> Result<Vec<u64>, LocalDbError>`;
  - `LocalDbState::{open(dir).await, unavailable(), get()}`;
  - `LocalDbError::code() -> &'static str`;
  - команды `local_query { sql, params }` и `local_transaction { statements: [{ sql, values, expectedChanges? }] }`;
  - таблицы `ref_org`, `ref_site`, `ref_lines`, `sync_state`;
  - помощник тестов `mock_app_with(device, local)`.

- [ ] **Step 1: Зависимость `sqlx`**

В `apps/standalone/src-tauri/Cargo.toml` в `[dependencies]` после `serde_json = "1"` добавить:

```toml
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite", "migrate", "macros"] }
```

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`, затем `git diff apps/standalone/Cargo.lock`.
Expected: сборка проходит. В `Cargo.lock` — ровно одна новая строка `"sqlx",` в списке зависимостей пакета `markiro-standalone`. Если изменилось что-то ещё — см. «Заметки для исполнения» о `Cargo.lock`.

- [ ] **Step 2: Тесты базы (падающие)**

Create `apps/standalone/src-tauri/tests/local_db.rs`:

```rust
//! The station's local database on a real file: migrations, the read-only
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{LocalDb, LocalDbError, LocalStatement, FILE_NAME};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};

const INSERT_LINE: &str = "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)";
const LINE_1: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2: &str = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";

fn statement(sql: &str, values: Value) -> LocalStatement {
    serde_json::from_value(json!({ "sql": sql, "values": values })).unwrap()
}

fn expecting(sql: &str, values: Value, changes: u64) -> LocalStatement {
    serde_json::from_value(json!({ "sql": sql, "values": values, "expectedChanges": changes }))
        .unwrap()
}

async fn open() -> (tempfile::TempDir, LocalDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::open(dir.path()).await.unwrap();
    (dir, db)
}

/// Every line, ordered by name, as the webview receives them.
async fn lines(db: &LocalDb) -> Value {
    let rows = db
        .query("SELECT id, name, archived, rev FROM ref_lines ORDER BY name", vec![])
        .await
        .unwrap();
    Value::Array(rows.into_iter().map(Value::Object).collect())
}

#[tokio::test]
async fn opening_creates_the_reference_tables_in_wal_mode_and_keeps_data() {
    let (dir, db) = open().await;
    let tables = db
        .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '_sqlx_migrations' ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    let names: Vec<&str> = tables.iter().map(|row| row["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["ref_lines", "ref_org", "ref_site", "sync_state"]);

    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    raw.close().await.unwrap();

    db.transaction(vec![statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 3]))])
        .await
        .unwrap();
    drop(db);
    let reopened = LocalDb::open(dir.path()).await.unwrap();
    assert_eq!(
        lines(&reopened).await,
        json!([{ "id": LINE_1, "name": "Линия 1", "archived": 0, "rev": 3 }])
    );
}

#[tokio::test]
async fn a_batch_commits_together_and_values_come_back_typed() {
    let (_dir, db) = open().await;
    let changes = db
        .transaction(vec![
            statement(INSERT_LINE, json!([LINE_1, "Линия 1", false, 1])),
            statement(INSERT_LINE, json!([LINE_2, "Линия 2", true, 2])),
            statement(
                "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?)",
                json!(["2"]),
            ),
        ])
        .await
        .unwrap();
    assert_eq!(changes, [1, 1, 1]);
    assert_eq!(
        lines(&db).await,
        json!([
            { "id": LINE_1, "name": "Линия 1", "archived": 0, "rev": 1 },
            { "id": LINE_2, "name": "Линия 2", "archived": 1, "rev": 2 }
        ])
    );
    let values = db
        .query(
            "SELECT 1.5 AS fraction, NULL AS nothing, ? AS word, count(*) AS lines FROM ref_lines",
            vec![json!("да")],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(values[0].clone()),
        json!({ "fraction": 1.5, "nothing": null, "word": "да", "lines": 2 })
    );
}

#[tokio::test]
async fn a_failing_statement_rolls_back_the_whole_batch() {
    let (_dir, db) = open().await;
    let result = db
        .transaction(vec![
            statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 1])),
            statement(INSERT_LINE, json!([LINE_1, "Та же линия", 0, 1])),
        ])
        .await;
    assert_eq!(result, Err(LocalDbError::StatementFailed));
    assert_eq!(lines(&db).await, json!([]));
}

#[tokio::test]
async fn expected_changes_guard_the_batch() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 1]))])
        .await
        .unwrap();
    let rename = "UPDATE ref_lines SET name = ? WHERE id = ?";
    let result = db
        .transaction(vec![
            expecting(rename, json!(["Первая", LINE_1]), 1),
            expecting(rename, json!(["Вторая", LINE_2]), 1),
        ])
        .await;
    assert_eq!(result, Err(LocalDbError::ChangesMismatch));
    assert_eq!(lines(&db).await[0]["name"], "Линия 1", "the first update rolled back");
    assert_eq!(
        db.transaction(vec![expecting(rename, json!(["Первая", LINE_1]), 1)])
            .await,
        Ok(vec![1])
    );
}

#[tokio::test]
async fn queries_are_read_only_and_writes_are_not_queries() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 1]))])
        .await
        .unwrap();
    // `WITH` passes the syntax check; the read-only connection refuses the write.
    assert_eq!(
        db.query(
            "WITH doomed AS (SELECT id FROM ref_lines) DELETE FROM ref_lines WHERE id IN (SELECT id FROM doomed)",
            vec![],
        )
        .await,
        Err(LocalDbError::StatementFailed)
    );
    for sql in [
        "DELETE FROM ref_lines",
        "INSERT INTO sync_state (key, value) VALUES ('last_rev', '9')",
        "UPDATE ref_lines SET rev = 9",
    ] {
        assert_eq!(db.query(sql, vec![]).await, Err(LocalDbError::InvalidStatement), "{sql}");
    }
    assert_eq!(lines(&db).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn batches_and_values_outside_the_rules_are_refused() {
    let (_dir, db) = open().await;
    assert_eq!(db.transaction(vec![]).await, Err(LocalDbError::InvalidStatement));
    let too_many: Vec<LocalStatement> = (0..33).map(|_| statement("SELECT 1", json!([]))).collect();
    assert_eq!(db.transaction(too_many).await, Err(LocalDbError::InvalidStatement));
    for sql in ["CREATE TABLE extra (x)", "PRAGMA foreign_keys = OFF", "BEGIN", "DROP TABLE ref_lines"] {
        assert_eq!(
            db.transaction(vec![statement(sql, json!([]))]).await,
            Err(LocalDbError::InvalidStatement),
            "{sql}"
        );
    }
    assert_eq!(
        db.transaction(vec![statement(INSERT_LINE, json!([LINE_1, ["nested"], 0, 1]))])
            .await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.transaction(vec![statement(INSERT_LINE, json!([LINE_1, "Линия", 0, u64::MAX]))])
            .await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.query("SELECT x'00' AS bytes", vec![]).await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.query("SELECT ? AS nested", vec![json!({ "a": 1 })]).await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(lines(&db).await, json!([]));
}

/// The reference sync (plan 1c3) applies a feed page as one statement per
/// entity with a JSON parameter: a thousand rows stay one statement, and the
/// same page applied again changes nothing.
#[tokio::test]
async fn one_statement_upserts_a_whole_page_through_json_each() {
    const UPSERT: &str = "INSERT INTO ref_lines (id, name, archived, rev) \
        SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' \
        FROM json_each(?) WHERE true \
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, rev = excluded.rev \
        WHERE excluded.rev > ref_lines.rev";
    let (_dir, db) = open().await;
    let page = Value::Array(
        (0..1000)
            .map(|n| json!({ "id": format!("line-{n:04}"), "name": format!("Линия {n}"), "archived": 0, "rev": 7 }))
            .collect(),
    )
    .to_string();
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![1000])
    );
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![0])
    );
    let summary = db
        .query("SELECT count(*) AS lines, min(rev) AS rev FROM ref_lines", vec![])
        .await
        .unwrap();
    assert_eq!(Value::Object(summary[0].clone()), json!({ "lines": 1000, "rev": 7 }));
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`
Expected: ошибка компиляции — нет модуля `local_db`.

- [ ] **Step 3: Миграция и модуль `local_db.rs`**

Create `apps/standalone/src-tauri/migrations/0001_reference_data.sql`:

```sql
-- The station's copies of the host's reference records (stage 1 spec §5.3),
-- each with the host revision it last changed at. The webview's reference
-- sync is the only writer. Operators, badges, products and templates join
-- with plans 1d and 1e.
CREATE TABLE ref_org (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inn TEXT,
  gln TEXT NOT NULL,
  -- JSON array of GS1 company prefixes.
  gs1_prefixes TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_site (
  id TEXT PRIMARY KEY,
  -- Standard base64 with padding, exactly as the change feed carries it.
  badge_salt TEXT NOT NULL,
  box_block_size INTEGER NOT NULL,
  pallet_block_size INTEGER NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_lines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);

-- `last_rev`: the last fully applied feed revision; `host_id`: the host the
-- records came from.
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Create `apps/standalone/src-tauri/src/local_db.rs`:

```rust
//! The station's local SQLite (stage 1 spec §5.2–5.3): copies of the host's
//! reference records, kept by the webview's reference sync. The webview
//! reads with [`LocalDb::query`] (`local_query`) on read-only connections
//! and writes only with [`LocalDb::transaction`] (`local_transaction`): one
//! `BEGIN IMMEDIATE` transaction per call on the single writer connection.
//! DDL lives only in `src-tauri/migrations`.
//!
//! Statements carry literals as parameters: `;`, `--` and `/*` are refused,
//! and so are words that control transactions, connections or the schema.
//! A large reference page goes in as one JSON parameter per entity
//! (`json_each`), so the limits bound SQL, not rows.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Number, Value};
use sqlx::migrate::Migrator;
use sqlx::query::Query;
use sqlx::sqlite::{
    SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions,
    SqliteRow, SqliteSynchronous,
};
use sqlx::{Column, Row, Sqlite, TypeInfo, ValueRef};

pub const FILE_NAME: &str = "standalone-station.db";
pub const MAX_STATEMENTS: usize = 32;
pub const MAX_SQL_BYTES: usize = 64 * 1024;
pub const MAX_VALUES: usize = 256;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// `src-tauri/migrations`, embedded at compile time. Applied migrations are
/// never edited: sqlx refuses to open a database whose checksums changed.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Words a webview statement may not contain: the shell owns transactions,
/// connections and the schema.
const FORBIDDEN_WORDS: &[&str] = &[
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH", "PRAGMA", "VACUUM",
    "CREATE", "DROP", "ALTER", "REINDEX",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDbError {
    /// The database could not be opened or migrated when the app started.
    Unavailable,
    /// The statement or the batch breaks the rules in the module comment.
    InvalidStatement,
    /// A parameter is not a scalar, an integer does not fit 64 bits, or a
    /// result column holds a BLOB.
    UnsupportedValue,
    /// SQLite refused or failed the statement; a batch rolled back whole.
    StatementFailed,
    /// A statement changed another number of rows than `expectedChanges`;
    /// the batch rolled back whole.
    ChangesMismatch,
}

impl LocalDbError {
    /// Stable codes the webview maps to text (`src/local/executor.ts`).
    pub fn code(self) -> &'static str {
        match self {
            LocalDbError::Unavailable => "local_db_unavailable",
            LocalDbError::InvalidStatement => "invalid_statement",
            LocalDbError::UnsupportedValue => "unsupported_value",
            LocalDbError::StatementFailed => "statement_failed",
            LocalDbError::ChangesMismatch => "changes_mismatch",
        }
    }
}

/// One statement of `local_transaction`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalStatement {
    pub sql: String,
    #[serde(default)]
    pub values: Vec<Value>,
    /// Roll the batch back unless the statement changes exactly this many rows.
    #[serde(default)]
    pub expected_changes: Option<u64>,
}

pub struct LocalDb {
    writer: SqlitePool,
    readers: SqlitePool,
}

impl LocalDb {
    /// Open `standalone-station.db` in `dir`, creating the directory, the
    /// file and the schema as needed.
    pub async fn open(dir: &Path) -> Result<Self, sqlx::Error> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal)
                    .synchronous(SqliteSynchronous::Full)
                    .foreign_keys(true)
                    .busy_timeout(BUSY_TIMEOUT),
            )
            .await?;
        MIGRATOR.run(&writer).await?;
        let readers = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .read_only(true)
                    .busy_timeout(BUSY_TIMEOUT),
            )
            .await?;
        Ok(Self { writer, readers })
    }

    /// Run one `SELECT` or `WITH` statement on a read-only connection. Each
    /// row becomes an object keyed by column name: alias duplicate names.
    pub async fn query(
        &self,
        sql: &str,
        params: Vec<Value>,
    ) -> Result<Vec<Map<String, Value>>, LocalDbError> {
        check_statement(sql, params.len())?;
        if !is_query(sql) {
            return Err(LocalDbError::InvalidStatement);
        }
        let rows = bind(sqlx::query(sql), params)?
            .fetch_all(&self.readers)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        rows.iter().map(row_object).collect()
    }

    /// Run `statements` in one `BEGIN IMMEDIATE` transaction on the writer
    /// connection and return the rows each changed. Any failure and any
    /// `expectedChanges` mismatch rolls back every statement.
    pub async fn transaction(
        &self,
        statements: Vec<LocalStatement>,
    ) -> Result<Vec<u64>, LocalDbError> {
        if statements.is_empty() || statements.len() > MAX_STATEMENTS {
            return Err(LocalDbError::InvalidStatement);
        }
        for statement in &statements {
            check_statement(&statement.sql, statement.values.len())?;
        }
        let mut tx = self
            .writer
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let mut changes = Vec::with_capacity(statements.len());
        for LocalStatement {
            sql,
            values,
            expected_changes,
        } in statements
        {
            let changed = bind(sqlx::query(&sql), values)?
                .execute(&mut *tx)
                .await
                .map_err(|_| LocalDbError::StatementFailed)?
                .rows_affected();
            if expected_changes.is_some_and(|expected| expected != changed) {
                return Err(LocalDbError::ChangesMismatch);
            }
            changes.push(changed);
        }
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        Ok(changes)
    }
}

/// Tauri state: the local database, or `None` when it could not be opened.
/// The app still starts — the office works without it — and the local
/// commands answer `local_db_unavailable`.
pub struct LocalDbState(Option<LocalDb>);

impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        Self(LocalDb::open(dir).await.ok())
    }

    pub fn unavailable() -> Self {
        Self(None)
    }

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.0.as_ref().ok_or(LocalDbError::Unavailable)
    }
}

/// One statement within the size limits: no second statement, no comment,
/// no word that controls transactions, connections or the schema.
fn check_statement(sql: &str, values: usize) -> Result<(), LocalDbError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() || sql.len() > MAX_SQL_BYTES || values > MAX_VALUES {
        return Err(LocalDbError::InvalidStatement);
    }
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    if body.contains(';') || body.contains("--") || body.contains("/*") {
        return Err(LocalDbError::InvalidStatement);
    }
    let forbidden = words(body).any(|word| {
        FORBIDDEN_WORDS
            .iter()
            .any(|forbidden| word.eq_ignore_ascii_case(forbidden))
    });
    if forbidden {
        Err(LocalDbError::InvalidStatement)
    } else {
        Ok(())
    }
}

fn is_query(sql: &str) -> bool {
    words(sql.trim_start()).next().is_some_and(|first| {
        first.eq_ignore_ascii_case("SELECT") || first.eq_ignore_ascii_case("WITH")
    })
}

/// SQL split into words of letters, digits and `_`; `created_at` stays one word.
fn words(sql: &str) -> impl Iterator<Item = &str> {
    sql.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
}

fn bind<'q>(
    mut query: Query<'q, Sqlite, SqliteArguments<'q>>,
    values: Vec<Value>,
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, LocalDbError> {
    for value in values {
        query = match value {
            Value::Null => query.bind(None::<String>),
            Value::Bool(value) => query.bind(value),
            Value::String(value) => query.bind(value),
            Value::Number(number) => match number.as_i64() {
                Some(integer) => query.bind(integer),
                // Above i64::MAX: SQLite cannot hold it as an integer.
                None if number.is_u64() => return Err(LocalDbError::UnsupportedValue),
                None => query.bind(number.as_f64().ok_or(LocalDbError::UnsupportedValue)?),
            },
            Value::Array(_) | Value::Object(_) => return Err(LocalDbError::UnsupportedValue),
        };
    }
    Ok(query)
}

/// A row as a JSON object keyed by column name, typed by the value SQLite
/// actually holds (not the declared column type).
fn row_object(row: &SqliteRow) -> Result<Map<String, Value>, LocalDbError> {
    let mut object = Map::new();
    for column in row.columns() {
        let index = column.ordinal();
        let raw = row
            .try_get_raw(index)
            .map_err(|_| LocalDbError::StatementFailed)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            let type_info = raw.type_info();
            match type_info.name() {
                "INTEGER" => Value::from(decode::<i64>(row, index)?),
                "REAL" => Number::from_f64(decode::<f64>(row, index)?)
                    .map(Value::Number)
                    .ok_or(LocalDbError::UnsupportedValue)?,
                "TEXT" => Value::String(decode::<String>(row, index)?),
                _ => return Err(LocalDbError::UnsupportedValue),
            }
        };
        object.insert(column.name().to_owned(), value);
    }
    Ok(object)
}

fn decode<'r, T: sqlx::Decode<'r, Sqlite>>(
    row: &'r SqliteRow,
    index: usize,
) -> Result<T, LocalDbError> {
    row.try_get_unchecked(index)
        .map_err(|_| LocalDbError::StatementFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_statements_with_parameters_pass() {
        for sql in [
            "SELECT id, name FROM ref_lines WHERE archived = ?",
            "WITH live AS (SELECT * FROM ref_lines) SELECT count(*) FROM live;",
            "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_rev', ?)",
            "SELECT created_at, begin_date, dropped FROM events",
        ] {
            assert_eq!(check_statement(sql, 4), Ok(()), "{sql}");
        }
    }

    #[test]
    fn second_statements_comments_and_control_words_are_refused() {
        for sql in [
            "",
            "   ",
            "SELECT 1; SELECT 2",
            "SELECT 1 -- note",
            "SELECT /* note */ 1",
            "BEGIN",
            "commit",
            "ROLLBACK",
            "SAVEPOINT a",
            "RELEASE a",
            "PRAGMA journal_mode",
            "ATTACH 'other.db' AS other",
            "DETACH other",
            "VACUUM",
            "CREATE TABLE extra (x)",
            "DROP TABLE ref_lines",
            "ALTER TABLE ref_lines ADD COLUMN x",
            "REINDEX",
        ] {
            assert_eq!(
                check_statement(sql, 0),
                Err(LocalDbError::InvalidStatement),
                "{sql:?}"
            );
        }
    }

    #[test]
    fn statement_size_and_value_count_are_bounded() {
        let long = format!("SELECT '{}'", "x".repeat(MAX_SQL_BYTES));
        assert_eq!(check_statement(&long, 0), Err(LocalDbError::InvalidStatement));
        assert_eq!(check_statement("SELECT ?", MAX_VALUES), Ok(()));
        assert_eq!(
            check_statement("SELECT ?", MAX_VALUES + 1),
            Err(LocalDbError::InvalidStatement)
        );
    }

    #[test]
    fn only_select_and_with_are_queries() {
        assert!(is_query("select 1"));
        assert!(is_query("  WITH live AS (SELECT 1) SELECT * FROM live"));
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "REPLACE INTO t VALUES (1)",
            "VALUES (1)",
            "(SELECT 1)",
        ] {
            assert!(!is_query(sql), "{sql}");
        }
    }

    #[test]
    fn error_codes_are_stable() {
        let codes: Vec<&str> = [
            LocalDbError::Unavailable,
            LocalDbError::InvalidStatement,
            LocalDbError::UnsupportedValue,
            LocalDbError::StatementFailed,
            LocalDbError::ChangesMismatch,
        ]
        .into_iter()
        .map(LocalDbError::code)
        .collect();
        assert_eq!(
            codes,
            [
                "local_db_unavailable",
                "invalid_statement",
                "unsupported_value",
                "statement_failed",
                "changes_mismatch"
            ]
        );
    }
}
```

В `apps/standalone/src-tauri/src/lib.rs` добавить `pub mod local_db;` (по алфавиту, после `pub mod host_probe;`).

Если компилятор не принимает `Query<'q, Sqlite, SqliteArguments<'q>>`, возьмите тип, который возвращает `sqlx::query` в sqlx 0.8.6: `Query<'q, Sqlite, <Sqlite as sqlx::Database>::Arguments<'q>>`. Поведение не меняйте; причину запишите в отчёт.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib local_db --offline` и `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline`
Expected: PASS (5 модульных тестов и 7 интеграционных).

- [ ] **Step 4: Команды и IPC-тест**

В `apps/standalone/src-tauri/src/lib.rs`:

- импорты:

```rust
use serde_json::{Map, Value};
use tauri::Manager;

use device::{DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbState, LocalStatement};
```

(`serde_json::Value` уже импортирован — замените строку на `use serde_json::{Map, Value};`);

- после `device_forget` добавить команды:

```rust
#[tauri::command]
async fn local_query(
    state: tauri::State<'_, LocalDbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let db = state.get().map_err(|error| error.code().to_owned())?;
    db.query(&sql, params)
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn local_transaction(
    state: tauri::State<'_, LocalDbState>,
    statements: Vec<LocalStatement>,
) -> Result<Vec<u64>, String> {
    let db = state.get().map_err(|error| error.code().to_owned())?;
    db.transaction(statements)
        .await
        .map_err(|error| error.code().to_owned())
}
```

- в `invoke_handler()` список команд дополнить: `device_forget, local_query, local_transaction`;
- в `run()` тело `setup` заменить на:

```rust
            // The local data directory, not the (roaming, on Windows)
            // config directory: the device identity must stay on this
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            app.manage(DeviceState::load(dir.clone()));
            // The local database opens before the window shows. When it
            // cannot open, the app still starts and the local commands say so.
            app.manage(tauri::async_runtime::block_on(LocalDbState::open(&dir)));
            Ok(())
```

В `apps/standalone/src-tauri/tests/ipc.rs`:

- в импорты добавить `use markiro_standalone_lib::local_db::LocalDbState;`;
- функцию `mock_app` заменить на две:

```rust
/// The app's own command list on the mock runtime, with the shell's states
/// managed. The `App` is returned too: it must outlive the webview.
fn mock_app_with(
    device: DeviceState,
    local: LocalDbState,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(device)
        .manage(local)
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// The shell without a local database, as when it could not be opened.
fn mock_app(device: DeviceState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    mock_app_with(device, LocalDbState::unavailable())
}
```

- в конец файла добавить тесты:

```rust
/// The arguments `src/local/executor.ts` sends: `params` for a query,
/// `statements` of `{ sql, values, expectedChanges? }` for a batch.
#[test]
fn the_local_database_answers_through_the_ipc_shapes() {
    const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let app_dir = tempfile::tempdir().unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    let changes = invoke(
        &webview,
        "local_transaction",
        json!({ "statements": [
            {
                "sql": "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
                "values": [LINE, "Линия 1", 0, 1]
            },
            {
                "sql": "UPDATE ref_lines SET rev = ? WHERE id = ?",
                "values": [2, LINE],
                "expectedChanges": 1
            }
        ] }),
    )
    .unwrap();
    assert_eq!(changes, json!([1, 1]));

    let rows = invoke(
        &webview,
        "local_query",
        json!({ "sql": "SELECT id, name, rev FROM ref_lines WHERE archived = ?", "params": [0] }),
    )
    .unwrap();
    assert_eq!(rows, json!([{ "id": LINE, "name": "Линия 1", "rev": 2 }]));

    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "DELETE FROM ref_lines", "params": [] })
        ),
        Err(json!("invalid_statement"))
    );
    assert_eq!(
        invoke(
            &webview,
            "local_transaction",
            json!({ "statements": [{
                "sql": "UPDATE ref_lines SET rev = 3 WHERE id = ?",
                "values": ["no-such-line"],
                "expectedChanges": 1
            }] }),
        ),
        Err(json!("changes_mismatch"))
    );
}

#[test]
fn without_a_local_database_the_local_commands_say_so() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "local_query", json!({ "sql": "SELECT 1", "params": [] })),
        Err(json!("local_db_unavailable"))
    );
    assert_eq!(
        invoke(
            &webview,
            "local_transaction",
            json!({ "statements": [{ "sql": "SELECT 1", "values": [] }] })
        ),
        Err(json!("local_db_unavailable"))
    );
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline` (вне песочницы: другие тесты файла запускают хост)
Expected: PASS (4 теста).

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md` после раздела «Databases» добавить раздел:

```markdown
## Local database

`src-tauri/src/local_db.rs` keeps `standalone-station.db` in the app's local
data directory, next to `device.json`: WAL, `synchronous=FULL`, foreign
keys, a 5 s busy timeout, migrations in `src-tauri/migrations`. The webview
reads it with `local_query` — one `SELECT` or `WITH` statement on read-only
connections, rows as objects keyed by column name — and writes it only with
`local_transaction`: up to 32 statements of at most 64 KB and 256 values
each, run in one `BEGIN IMMEDIATE` transaction on the single writer
connection and rolled back whole on any error or `expectedChanges`
mismatch. Statements carry literals as parameters (no `;`, `--` or `/*`),
never control transactions, connections or the schema (`BEGIN`, `PRAGMA`,
`ATTACH`, `CREATE`, `DROP`, `ALTER`, …) and never read BLOBs. A large
reference page goes in as one JSON parameter per entity through
`json_each`, so the limits bound SQL, not rows. Rejections are bare codes:
`local_db_unavailable` (the database did not open; the app starts anyway),
`invalid_statement`, `unsupported_value`, `statement_failed`,
`changes_mismatch`.
```

2. В спецификации `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, §5.2, в пункте «Локальная база» после подпункта про `local_transaction` добавить подпункт (с тем же отступом, что у соседних):

```text
  - ответ `local_query` — массив объектов по именам столбцов, BLOB не
    поддерживается; отказы обеих команд — голые коды `local_db_unavailable`,
    `invalid_statement`, `unsupported_value`, `statement_failed`,
    `changes_mismatch`. Порция справочника вставляется одним оператором на
    сущность с параметром JSON (`json_each`): лимиты держат размер SQL, а не
    число строк.
```

3. Там же в §5.3 после перечня таблиц добавить абзац:

```text
План 1c создаёт `ref_org`, `ref_site`, `ref_lines` и `sync_state`; таблицы
операторов, бейджей, товаров и шаблонов добавляют планы 1d и 1e вместе со
своими сущностями ленты.
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы); `git diff --check`.
Expected: всё зелёное, без предупреждений компилятора.

```bash
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/Cargo.lock apps/standalone/src-tauri/migrations/0001_reference_data.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): локальная база станции — local_query и local_transaction" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Подключение по коду — `host_claim`

Второе устройство подключается одноразовым кодом из офиса (спецификация, §4.7). Экран подключения (план 1c3) даёт адрес хоста и отпечаток его сертификата — из отсканированного кода или сверенный человеком с экраном офиса — плюс сам код и имя устройства. Оболочка отправляет код, только когда сертификат хоста совпал с этим отпечатком:

1. Отпечаток плохого вида отвергается до обращения к сети.
2. Наблюдаемый `hello` должен показать тот же отпечаток.
3. Сам код уходит клиентом, который закрепил этот отпечаток.

Так код не достаётся чужому узлу в сети, даже если тот подменит сертификат между шагами. Ответ хоста сохраняется так же, как при локальном подключении: общий метод `remember`.

**Files:**

- Modify: `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/tests/claim.rs`
- Modify: `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2)

**Interfaces:**

- Consumes: `host_probe::{observe_hello, HelloObservation}`, `PinnedClient`, `Credentials`, `markiro_proto::{ClaimRequest, ErrorBody, PairResponse, codes}`, маршруты хоста `POST /v1/office/pairing-codes` и `POST /v1/pairing/claim` (план 1c1), `mock_app` в `tests/ipc.rs` (задача 1).
- Produces:
  - `DeviceState::claim(&self, address: &str, fingerprint: &str, code: &str, name: &str, app_version: &str) -> Result<DeviceStatus, DeviceError>`;
  - новые варианты `DeviceError::{CodeInvalid, CodeExpired, RateLimited}` с кодами `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`;
  - команда `host_claim { address, fingerprint, code, name } → DeviceStatus`.

- [ ] **Step 1: Тесты (падающие)**

Create `apps/standalone/src-tauri/tests/claim.rs`:

```rust
//! Pairing by code against a real `markiro-host` on 127.0.0.1: an office
//! installation creates a one-time code, a second installation claims it
//! with the host's fingerprint (stage 1 spec §4.7).

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::host_probe::ProbeError;
use serde_json::Value;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
const STATION: &str = "Станция на линии 2";
const WRONG_CODE: &str = "0000000000";

async fn start_host(dir: &Path) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

/// A local address where nothing listens.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// The host PC's own installation, paired over loopback with the wizard
/// done; returns it and the administrator's session token.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let office = DeviceState::load(dir.to_path_buf());
    office
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = office
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (office, token)
}

/// A fresh one-time code from the office.
async fn new_code(office: &DeviceState, token: &str) -> String {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    created.body.unwrap()["code"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_second_device_pairs_with_a_code_and_the_confirmed_fingerprint() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;

    let station = DeviceState::load(station_dir.path().to_path_buf());
    let status = station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.fingerprint, host.fingerprint);
    assert_eq!(status.host_id, host.host_id);
    assert_eq!(status.kind, DeviceKind::Station);
    assert_eq!(status.line_id, None);

    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status.clone())));
    let device = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(device.status, 200);
    let body = device.body.unwrap();
    assert_eq!(body["id"], status.device_id);
    assert_eq!(body["kind"], "station");
    assert_eq!(body["name"], STATION);

    assert_eq!(
        station
            .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
            .await,
        Err(DeviceError::AlreadyPaired)
    );
    host.stop().await.unwrap();
}

/// With another fingerprint the code never leaves the device: had it reached
/// the host, the host would have paired it (or counted it), and the same
/// code would not pair afterwards.
#[tokio::test]
async fn another_fingerprint_keeps_the_code_on_the_device() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;

    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(
        station
            .claim(&address(&host), &"0".repeat(64), &code, STATION, "0.1.0")
            .await,
        Err(DeviceError::Request(RequestError::CertificateMismatch))
    );
    assert_eq!(station.status(), Ok(None));
    assert!(station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .is_ok());
    host.stop().await.unwrap();
}

#[tokio::test]
async fn refused_codes_come_back_as_their_own_errors() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let claim = |code: String| {
        let station = &station;
        let host = &host;
        async move {
            station
                .claim(&address(host), &host.fingerprint, &code, STATION, "0.1.0")
                .await
        }
    };

    assert_eq!(claim(WRONG_CODE.to_owned()).await, Err(DeviceError::CodeInvalid));
    // Another device takes the code first: a used code is refused like an unknown one.
    DeviceState::load(other_dir.path().to_path_buf())
        .claim(&address(&host), &host.fingerprint, &code, "Станция 3", "0.1.0")
        .await
        .unwrap();
    assert_eq!(claim(code.clone()).await, Err(DeviceError::CodeInvalid));
    assert_eq!(station.status(), Ok(None));

    // The host allows 10 claims a minute from one address: 3 are spent.
    let mut outcomes = Vec::new();
    for _ in 0..8 {
        outcomes.push(claim(WRONG_CODE.to_owned()).await);
    }
    assert!(
        outcomes[..7]
            .iter()
            .all(|outcome| *outcome == Err(DeviceError::CodeInvalid)),
        "{outcomes:?}"
    );
    assert_eq!(outcomes[7], Err(DeviceError::RateLimited));
    assert_eq!(station.status(), Ok(None));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_malformed_fingerprint_is_refused_before_any_io() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let upper = "AB".repeat(32);
    let short = "ab".repeat(31);
    let not_hex = "zz".repeat(32);
    for fingerprint in ["", upper.as_str(), short.as_str(), not_hex.as_str()] {
        assert_eq!(
            station
                .claim(&closed_address(), fingerprint, WRONG_CODE, STATION, "0.1.0")
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{fingerprint:?}"
        );
    }
    // A well-formed fingerprint does reach the network, and finds nothing.
    assert_eq!(
        station
            .claim(&closed_address(), &"ab".repeat(32), WRONG_CODE, STATION, "0.1.0")
            .await,
        Err(DeviceError::Probe(ProbeError::Unreachable))
    );
}
```

В `apps/standalone/src-tauri/tests/ipc.rs` в конец файла добавить:

```rust
/// A second installation pairs by code with the webview's arguments:
/// `address`, `fingerprint`, `code` and `name` (`src/host/device.ts`).
#[test]
fn a_device_claims_a_code_through_the_ipc_shapes() {
    let host = Host::start();
    let office_dir = tempfile::tempdir().unwrap();
    let office = DeviceState::load(office_dir.path().to_path_buf());
    host.runtime
        .block_on(office.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(office.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let issued = host
        .runtime
        .block_on(office.request("POST", "/v1/office/pairing-codes", None, Some(&token)))
        .unwrap();
    let code = issued.body.unwrap()["code"].as_str().unwrap().to_owned();

    let station_dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(station_dir.path().to_path_buf()));
    let claim = |code: &str| {
        json!({
            "address": host.address(),
            "fingerprint": host.running.fingerprint,
            "code": code,
            "name": "Станция на линии 2"
        })
    };
    assert_eq!(
        invoke(&webview, "host_claim", claim("0000000000")),
        Err(json!("pairing_code_invalid"))
    );
    let status = invoke(&webview, "host_claim", claim(&code)).unwrap();
    assert_eq!(status["hostId"], host.running.host_id);
    assert_eq!(status["fingerprint"], host.running.fingerprint);
    assert_eq!(status["kind"], "station");
    assert_eq!(status["lineId"], Value::Null);
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(status));

    drop(webview);
    host.stop();
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test claim --test ipc --offline` (вне песочницы)
Expected: ошибка компиляции — нет `DeviceState::claim` и вариантов `CodeInvalid`, `RateLimited`.

- [ ] **Step 2: `DeviceState::claim` и общий `remember`**

В `apps/standalone/src-tauri/src/device.rs`:

1. Импорты:

```rust
use markiro_proto::{
    codes, ClaimRequest, DeviceKind, ErrorBody, LocalPairRequest, PairResponse, Secret,
};
use serde::Serialize;
use serde_json::Value;

use crate::device_config::{self, DeviceConfig};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, HelloObservation, ProbeError};
use crate::secret_store;
```

2. В `enum DeviceError` после `HostChanged` добавить:

```rust
    /// The host refused the pairing code: unknown, used or out of attempts.
    CodeInvalid,
    /// The pairing code has expired.
    CodeExpired,
    /// Too many pairing attempts from this computer; wait a minute.
    RateLimited,
```

и в `code()`:

```rust
            DeviceError::CodeInvalid => codes::PAIRING_CODE_INVALID,
            DeviceError::CodeExpired => codes::PAIRING_CODE_EXPIRED,
            DeviceError::RateLimited => codes::RATE_LIMITED,
```

3. Метод `local_pair` заменить, а после него добавить `claim` и два помощника:

```rust
    /// Pair with the host at `address` over loopback (`POST /v1/local-pair`)
    /// and remember it. Calls are serialised: a second call waits for the
    /// first and then finds the device already paired.
    pub async fn local_pair(
        &self,
        address: &str,
        name: &str,
        app_version: &str,
    ) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        self.ensure_unpaired()?;
        let observation = host_probe::observe_hello(address)
            .await
            .map_err(DeviceError::Probe)?;
        let client =
            PinnedClient::new(address, &observation.fingerprint).map_err(DeviceError::Request)?;
        let request = LocalPairRequest {
            kind: DeviceKind::Station,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
            capabilities: Vec::new(),
        };
        let body = serde_json::to_value(&request).expect("LocalPairRequest serializes");
        let response = client
            .send("POST", "/v1/local-pair", Some(&body), Credentials::default())
            .await
            .map_err(DeviceError::Request)?;
        if response.status != 200 {
            return Err(DeviceError::PairRejected);
        }
        self.remember(address, observation, client, response.body)
    }

    /// Pair with the host at `address` using a one-time `code` from the
    /// office (`POST /v1/pairing/claim`). `fingerprint` is the one in the
    /// scanned pairing code, or one a person compared with the office
    /// screen. The code goes out only after `hello` showed that certificate,
    /// and only through a client that pins it, so no other machine on the
    /// network ever receives it.
    pub async fn claim(
        &self,
        address: &str,
        fingerprint: &str,
        code: &str,
        name: &str,
        app_version: &str,
    ) -> Result<DeviceStatus, DeviceError> {
        if !is_fingerprint(fingerprint) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        let _pairing = self.pairing.lock().await;
        self.ensure_unpaired()?;
        let observation = host_probe::observe_hello(address)
            .await
            .map_err(DeviceError::Probe)?;
        if observation.fingerprint != fingerprint {
            return Err(DeviceError::Request(RequestError::CertificateMismatch));
        }
        let client = PinnedClient::new(address, fingerprint).map_err(DeviceError::Request)?;
        let request = ClaimRequest {
            code: Secret::new(code),
            kind: DeviceKind::Station,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
            capabilities: Vec::new(),
        };
        let body = serde_json::to_value(&request).expect("ClaimRequest serializes");
        let response = client
            .send("POST", "/v1/pairing/claim", Some(&body), Credentials::default())
            .await
            .map_err(DeviceError::Request)?;
        if response.status != 200 {
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, response.body)
    }

    fn ensure_unpaired(&self) -> Result<(), DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(()),
            Current::Paired(_) => Err(DeviceError::AlreadyPaired),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    /// Save a pairing the host just granted and make it current. The host
    /// that answered must be the one `hello` described.
    fn remember(
        &self,
        address: &str,
        observation: HelloObservation,
        client: PinnedClient,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
        let pair: PairResponse = body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        if pair.host_id != observation.hello.host_id {
            return Err(DeviceError::HostChanged);
        }
        let config = DeviceConfig {
            host_address: address.trim_end_matches('/').to_owned(),
            fingerprint: observation.fingerprint,
            host_id: pair.host_id,
            device_id: pair.device_id,
            kind: DeviceKind::Station,
            line_id: None,
            device_key: secret_store::protect(pair.device_key.expose())
                .map_err(|_| DeviceError::Storage)?,
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let device = Arc::new(PairedDevice {
            key: pair.device_key,
            client,
            config,
        });
        let status = device.status();
        *self.current.lock().expect("device lock") = Current::Paired(device);
        Ok(status)
    }
```

4. После функции `webview_may_reach` добавить:

```rust
/// A SHA-256 fingerprint as the host prints it: 64 lower-case hex characters.
fn is_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The error for a refused claim: the host's reason when it is one the
/// webview explains, a plain refusal otherwise.
fn claim_refusal(body: Option<&Value>) -> DeviceError {
    let code = body
        .and_then(|body| serde_json::from_value::<ErrorBody>(body.clone()).ok())
        .map(|body| body.error.code);
    match code.as_deref() {
        Some(codes::PAIRING_CODE_INVALID) => DeviceError::CodeInvalid,
        Some(codes::PAIRING_CODE_EXPIRED) => DeviceError::CodeExpired,
        Some(codes::RATE_LIMITED) => DeviceError::RateLimited,
        _ => DeviceError::PairRejected,
    }
}
```

5. В модуль `tests` файла добавить (и `use serde_json::json;` в его импорты):

```rust
    #[test]
    fn claim_refusals_keep_the_reason_the_webview_explains() {
        let body = |code: &str| json!({ "error": { "code": code, "message": "refused" } });
        assert_eq!(
            claim_refusal(Some(&body("pairing_code_invalid"))),
            DeviceError::CodeInvalid
        );
        assert_eq!(
            claim_refusal(Some(&body("pairing_code_expired"))),
            DeviceError::CodeExpired
        );
        assert_eq!(claim_refusal(Some(&body("rate_limited"))), DeviceError::RateLimited);
        assert_eq!(
            claim_refusal(Some(&body("validation_failed"))),
            DeviceError::PairRejected
        );
        assert_eq!(claim_refusal(Some(&json!("not an error body"))), DeviceError::PairRejected);
        assert_eq!(claim_refusal(None), DeviceError::PairRejected);
    }

    #[test]
    fn claim_error_codes_match_the_hosts() {
        assert_eq!(DeviceError::CodeInvalid.code(), "pairing_code_invalid");
        assert_eq!(DeviceError::CodeExpired.code(), "pairing_code_expired");
        assert_eq!(DeviceError::RateLimited.code(), "rate_limited");
    }

    #[test]
    fn fingerprints_are_64_lower_case_hex_characters() {
        assert!(is_fingerprint(&"0123456789abcdef".repeat(4)));
        for value in ["", "AB".repeat(32).as_str(), "ab".repeat(33).as_str(), "gg".repeat(32).as_str()] {
            assert!(!is_fingerprint(value), "{value:?}");
        }
    }
```

- [ ] **Step 3: Команда `host_claim`**

В `apps/standalone/src-tauri/src/lib.rs` после `host_local_pair` добавить:

```rust
#[tauri::command]
async fn host_claim(
    state: tauri::State<'_, DeviceState>,
    address: String,
    fingerprint: String,
    code: String,
    name: String,
) -> Result<DeviceStatus, String> {
    state
        .claim(&address, &fingerprint, &code, &name, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|error| error.code().to_owned())
}
```

и в список `invoke_handler()` после `host_local_pair` — `host_claim`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы)
Expected: PASS — модульные тесты `device.rs`, `claim.rs` (4 теста), `ipc.rs` (5 тестов), остальные файлы без изменений.

- [ ] **Step 4: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Local pairing trust», последнее предложение («The claiming device pins the fingerprint from the scanned payload, or one a person compared with the office screen.») заменить на:

```text
The claiming device pins the fingerprint from the scanned payload, or one a
person compared with the office screen: `host_claim` refuses a malformed
fingerprint before any I/O, observes `hello` and stops unless the observed
fingerprint equals the confirmed one, and sends the code only through a
client that pins it. A refused claim comes back as `pairing_code_invalid`,
`pairing_code_expired` or `rate_limited`; anything else is `pair_rejected`.
```

2. Там же, раздел «Network and TLS»: фрагмент

```text
(`host_local_pair`, later `host_claim`)
```

заменить на

```text
(`host_local_pair`, `host_claim`)
```

3. В спецификации, §5.2: фрагмент

```text
`host_claim(address, fingerprint, code, device)`
```

заменить на

```text
`host_claim(address, fingerprint, code, name)` (устройство подключается видом `station`)
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 5: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы); `git diff --check`.

```bash
git add apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/claim.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): подключение устройства по коду — host_claim" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Выбор линии и список маршрутов вебвью

После подключения станция выбирает линию (спецификация, §5.1). Выбор хранится в `device.json`: станция должна открыться на своей линии и при выключенном хосте. Поэтому линию меняет только команда `device_select_line`, а `host_request` этот маршрут больше не пропускает. Иначе выбор, сделанный в обход команды, оставил бы `device.json` устаревшим.

Тем же изменением в список `host_request` входит лента `GET /v1/changes`: её забирает синхронизация справочников вебвью. Поток `/v1/changes/stream` остаётся за фоновой задачей (задача 4).

**Files:**

- Modify: `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/tests/line.rs`
- Modify: `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2)

**Interfaces:**

- Consumes:
  - `DeviceState` с `ensure_unpaired`/`remember` (задача 2);
  - `markiro_proto::{DeviceLineRequest, DeviceInfo}`;
  - маршруты хоста `PUT /v1/device/line` и `GET /v1/changes` (план 1c1);
  - `device_config::{save, DeviceConfig}`, `secret_store::protect` — ими тест пишет `device.json` с ключом, которого хост не выдавал.
- Produces:
  - `DeviceState::select_line(&self, line_id: &str) -> Result<DeviceStatus, DeviceError>`;
  - новые варианты `DeviceError::{LineRejected, KeyRejected, RequestFailed}` с кодами `line_rejected`, `key_rejected`, `request_failed`;
  - команда `device_select_line { lineId } → DeviceStatus`;
  - `host_request` пропускает `/v1/changes` и отвергает `/v1/device/line` и `/v1/changes/stream`.

- [ ] **Step 1: Тесты (падающие)**

Create `apps/standalone/src-tauri/tests/line.rs`:

```rust
//! Line selection and the webview's route list against a real `markiro-host`
//! on 127.0.0.1 (stage 1 spec §5.1–5.2).

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::secret_store;
use serde_json::{json, Value};

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
const UNKNOWN_LINE: &str = "9b2e4a6c-0000-4000-8000-000000000000";

async fn start_host(dir: &Path) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

/// A station paired over loopback with the wizard done (one line).
async fn paired_station(host: &RunningHost, dir: &Path) -> DeviceState {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = station
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    station
}

/// The ids of the host's lines, read from the change feed as the webview does.
async fn line_ids(station: &DeviceState) -> Vec<String> {
    let feed = station
        .request("GET", "/v1/changes?since=0", None, None)
        .await
        .unwrap();
    assert_eq!(feed.status, 200, "{:?}", feed.body);
    feed.body.unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "lines")
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_station_chooses_its_line_and_keeps_it_across_restarts() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;
    let lines = line_ids(&station).await;
    assert_eq!(lines.len(), 1);

    let status = station.select_line(&lines[0]).await.unwrap();
    assert_eq!(status.line_id.as_deref(), Some(lines[0].as_str()));
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status)));
    let device = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(device.body.unwrap()["lineId"], lines[0]);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unknown_line_is_rejected_and_nothing_is_saved() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;

    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::LineRejected)
    );
    assert_eq!(station.status().unwrap().unwrap().line_id, None);
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status().unwrap().unwrap().line_id, None);
    host.stop().await.unwrap();
}

/// A `device.json` whose key the host never issued (as after a revocation).
#[tokio::test]
async fn a_key_the_host_does_not_know_is_rejected() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let config = DeviceConfig {
        host_address: address(&host),
        fingerprint: host.fingerprint.clone(),
        host_id: host.host_id.clone(),
        device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
        kind: DeviceKind::Station,
        line_id: None,
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
    device_config::save(station_dir.path(), &config).unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());

    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::KeyRejected)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn line_selection_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::NotPaired)
    );
}

#[tokio::test]
async fn the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;

    let feed = station
        .request("GET", "/v1/changes?since=0&limit=10", None, None)
        .await
        .unwrap();
    assert_eq!(feed.status, 200);
    assert_eq!(feed.body.unwrap()["hostId"], host.host_id);
    for (method, path) in [("GET", "/v1/changes/stream"), ("PUT", "/v1/device/line")] {
        assert_eq!(
            station
                .request(method, path, Some(&json!({ "lineId": UNKNOWN_LINE })), None)
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{method} {path}"
        );
    }
    host.stop().await.unwrap();
}
```

В `apps/standalone/src-tauri/tests/ipc.rs` в конец файла добавить:

```rust
/// Line selection with the webview's `lineId`, the feed through
/// `host_request`, and the stream refused there.
#[test]
fn a_station_selects_its_line_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    host.runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(pairing.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    assert_eq!(created.status, 200);
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let feed = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/changes?since=0", Value::Null, None),
    )
    .unwrap();
    assert_eq!(feed["status"], 200);
    let line = feed["body"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "lines")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(
        invoke(
            &webview,
            "device_select_line",
            json!({ "lineId": "9b2e4a6c-0000-4000-8000-000000000000" })
        ),
        Err(json!("line_rejected"))
    );
    let status = invoke(&webview, "device_select_line", json!({ "lineId": line })).unwrap();
    assert_eq!(status["lineId"], line);
    assert_eq!(
        invoke(&webview, "device_status", json!({})).unwrap()["lineId"],
        line
    );
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("GET", "/v1/changes/stream", Value::Null, None)
        ),
        Err(json!("invalid_request"))
    );

    drop(webview);
    host.stop();
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --offline` (вне песочницы)
Expected: ошибка компиляции — нет `DeviceState::select_line` и вариантов `LineRejected`, `KeyRejected`.

- [ ] **Step 2: `select_line` и список маршрутов**

В `apps/standalone/src-tauri/src/device.rs`:

1. Импорт proto дополнить: `use markiro_proto::{codes, ClaimRequest, DeviceInfo, DeviceKind, DeviceLineRequest, ErrorBody, LocalPairRequest, PairResponse, Secret};`.

2. После импортов добавить:

```rust
/// A station's line (`PUT /v1/device/line`): only [`DeviceState::select_line`]
/// reaches it, so `device.json` always holds the line the host confirmed.
const LINE_ROUTE: &str = "/v1/device/line";
```

3. В `enum DeviceError` после `RateLimited` добавить:

```rust
    /// The host refused the chosen line: it is archived or does not exist.
    LineRejected,
    /// The host no longer accepts this device's key (for example, it was
    /// revoked in the office): the device needs a new pairing.
    KeyRejected,
    /// The host answered a device request with another error.
    RequestFailed,
```

и в `code()`:

```rust
            DeviceError::LineRejected => "line_rejected",
            DeviceError::KeyRejected => "key_rejected",
            DeviceError::RequestFailed => "request_failed",
```

4. После метода `claim` добавить:

```rust
    /// Choose the line this station works on (`PUT /v1/device/line`) and
    /// keep the host's answer in `device.json`, so the station opens on its
    /// line even while the host is away. Serialised with pairing and
    /// forgetting, so it never writes over a pairing that changed meanwhile.
    pub async fn select_line(&self, line_id: &str) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let body = serde_json::to_value(DeviceLineRequest {
            line_id: line_id.to_owned(),
        })
        .expect("DeviceLineRequest serializes");
        let response = device
            .client
            .send(
                "PUT",
                LINE_ROUTE,
                Some(&body),
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                },
            )
            .await
            .map_err(DeviceError::Request)?;
        match response.status {
            200 => {}
            400 => return Err(DeviceError::LineRejected),
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        let info: DeviceInfo = response
            .body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        let config = DeviceConfig {
            line_id: info.line_id,
            ..device.config.clone()
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let updated = Arc::new(PairedDevice {
            config,
            key: device.key.clone(),
            client: device.client.clone(),
        });
        let status = updated.status();
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        Ok(status)
    }

    fn paired(&self) -> Result<Arc<PairedDevice>, DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Paired(device) => Ok(device.clone()),
            Current::Unpaired => Err(DeviceError::NotPaired),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }
```

5. В методе `request` блок `let device = match &*self.current.lock()… };` заменить на `let device = self.paired()?;`.

6. Функцию `webview_may_reach` заменить:

```rust
/// Routes the webview may reach through `host_request`. Pairing routes are
/// excluded: their answers carry a new device key, which must never cross
/// IPC. The line goes through [`DeviceState::select_line`], which also keeps
/// it in `device.json`; the change stream belongs to the connection task.
fn webview_may_reach(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    let device_route =
        route == "/v1/device" || (route.starts_with("/v1/device/") && route != LINE_ROUTE);
    device_route
        || route == "/v1/bootstrap"
        || route == "/v1/changes"
        || route.starts_with("/v1/office/")
}
```

7. В модуле `tests` тест `webview_reachable_routes_exclude_pairing` заменить на:

```rust
    #[test]
    fn webview_reachable_routes_exclude_pairing_the_line_and_the_stream() {
        for route in [
            "/v1/device",
            "/v1/device/foo",
            "/v1/bootstrap",
            "/v1/changes",
            "/v1/changes?since=5&limit=100",
            "/v1/office/me",
            "/v1/office/logout",
            "/v1/office/sscc/counters/460068200/0?since=1",
        ] {
            assert!(webview_may_reach(route), "{route}");
        }
        for route in [
            "/v1/local-pair",
            "/v1/pairing/claim",
            "/v1/hello",
            "/v1/devices",
            "/v1/bootstrap-status",
            "/v1/device/line",
            "/v1/device/line?lineId=1",
            "/v1/changes/stream",
            "/v1/changes/",
            "/v1/changesx",
        ] {
            assert!(!webview_may_reach(route), "{route}");
        }
    }

    #[test]
    fn line_and_key_error_codes_are_stable() {
        assert_eq!(DeviceError::LineRejected.code(), "line_rejected");
        assert_eq!(DeviceError::KeyRejected.code(), "key_rejected");
        assert_eq!(DeviceError::RequestFailed.code(), "request_failed");
    }
```

- [ ] **Step 3: Команда `device_select_line`**

В `apps/standalone/src-tauri/src/lib.rs` после `host_request` добавить:

```rust
#[tauri::command]
async fn device_select_line(
    state: tauri::State<'_, DeviceState>,
    line_id: String,
) -> Result<DeviceStatus, String> {
    state
        .select_line(&line_id)
        .await
        .map_err(|error| error.code().to_owned())
}
```

и в список `invoke_handler()` после `host_request` — `device_select_line`. Tauri принимает аргумент из вебвью в camelCase (`lineId`), как `officeToken` у `host_request`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы)
Expected: PASS — модульные тесты `device.rs`, `line.rs` (5 тестов), `ipc.rs` (6 тестов), остальные файлы без изменений.

- [ ] **Step 4: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Network and TLS», второй абзац: фрагмент

```text
and only the routes `/v1/device[/…]`, `/v1/bootstrap` and `/v1/office/…`.
```

заменить на

```text
and only the routes `/v1/device[/…]` except `/v1/device/line`,
`/v1/bootstrap`, `/v1/changes` (not `/v1/changes/stream`) and
`/v1/office/…`. The line goes through `device_select_line`, which also keeps
the host's answer in `device.json`, so the station opens on its line with the
host away; the change stream belongs to the connection task.
```

2. В спецификации, §5.2, пункт «Клиент хоста»: в перечень команд после `host_request(method, path, body, officeToken?)` добавить

```text
`device_select_line(lineId)` (выбор линии; ответ хоста сохраняется в `device.json`)
```

3. Там же фрагмент

```text
`host_request` пропускает только маршруты `/v1/device[/…]`,
  `/v1/bootstrap` и `/v1/office/…`
```

(перенос строки в файле может стоять в другом месте) заменить на

```text
`host_request` пропускает только маршруты `/v1/device[/…]` (кроме
  `/v1/device/line`), `/v1/bootstrap`, `/v1/changes` (без `/stream`) и
  `/v1/office/…`
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 5: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы); `git diff --check`.

```bash
git add apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/line.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): выбор линии станцией и лента в маршрутах вебвью" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Связь с хостом — фоновый поток изменений

Изменения из офиса должны доходить до станций за секунды, а после обрыва станция догоняет пропущенное (спецификация, §1 и §5.2). Оболочка держит `GET /v1/changes/stream` одной фоновой задачей на приложение. Она сообщает вебвью о связи (`standalone://host-status`) и о каждой ревизии хоста (`standalone://host-revision`). Первое событие после каждого подключения несёт текущую ревизию — по нему синхронизация (план 1c3) и догоняет пропущенное.

Задача следит за подключением через канал `watch` в `DeviceState`:

- подключили — начинает держать поток;
- забыли подключение — рвёт поток и остаётся «вне связи» без попыток.

Снимок `connection_status` с порядковым номером `seq` защищает от гонки: иначе вебвью, открывшийся после первого события, не узнал бы статус.

**Files:**

- Modify: `apps/standalone/src-tauri/Cargo.toml`
- Modify: `apps/standalone/src-tauri/src/host_client.rs`, `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/src/connection.rs`, `apps/standalone/src-tauri/tests/connection.rs`
- Modify: `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.2)

**Interfaces:**

- Consumes:
  - `DeviceState` с `remember`, `forget`, `select_line` (задачи 2–3);
  - `PinnedClient`, `validate_path`, `is_fingerprint_mismatch` (`host_client.rs`);
  - поток хоста `GET /v1/changes/stream`: `event: rev` / `data: {"rev":N}`, комментарий-пульс каждые 15 с; открытые потоки заканчиваются при остановке хоста (план 1c1, задача 6);
  - `markiro_proto::credentials::DEVICE`.
- Produces:
  - `device::HostLink { pub address, pub fingerprint, key }` с `HostLink::new(address, fingerprint, key: Secret)` и `key() -> &Secret`;
  - `DeviceState::watch_link() -> watch::Receiver<Option<Arc<HostLink>>>`;
  - `host_client::{StreamClient, StreamOpen, HostStream, STREAM_SILENCE_LIMIT}`;
  - `connection::{supervise, Backoff, ConnectionState, HostStatus, HostRevision, LinkState, LinkError, LinkEvents, SseParser, SseItem, STATUS_EVENT, REVISION_EVENT}`;
  - команда `connection_status {} → HostStatus`.

- [ ] **Step 1: Возможности `tokio`**

В `apps/standalone/src-tauri/Cargo.toml` строку `tokio = { version = "=1.53.1", features = ["sync"] }` в `[dependencies]` заменить на:

```toml
tokio = { version = "=1.53.1", features = ["sync", "macros", "time"] }
```

Run: `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`, затем `git diff apps/standalone/Cargo.lock`.
Expected: сборка проходит; `Cargo.lock` не меняется (`tokio-macros` в нём уже есть).

- [ ] **Step 2: Тесты связи (падающие)**

Create `apps/standalone/src-tauri/tests/connection.rs`:

```rust
//! The link task against a real `markiro-host` on 127.0.0.1: the statuses and
//! revisions the webview receives, reconnection, and following the pairing.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::Secret;
use markiro_standalone_lib::connection::{
    self, Backoff, ConnectionState, HostRevision, HostStatus, LinkError, LinkEvents, LinkState,
};
use markiro_standalone_lib::device::{DeviceState, HostLink};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
/// Short pauses, so a reconnection shows within a test.
const FAST: Backoff = Backoff {
    initial: Duration::from_millis(50),
    max: Duration::from_millis(200),
};

#[derive(Debug, Clone, PartialEq)]
enum Heard {
    Status(HostStatus),
    Revision(i64),
}

struct Recorder(mpsc::UnboundedSender<Heard>);

impl LinkEvents for Recorder {
    fn status(&self, status: &HostStatus) {
        let _ = self.0.send(Heard::Status(status.clone()));
    }

    fn revision(&self, revision: HostRevision) {
        let _ = self.0.send(Heard::Revision(revision.rev));
    }
}

/// Run the link task on `link`; returns what it reports, its state and its task.
fn follow(
    link: watch::Receiver<Option<Arc<HostLink>>>,
) -> (mpsc::UnboundedReceiver<Heard>, ConnectionState, JoinHandle<()>) {
    let (sender, heard) = mpsc::unbounded_channel();
    let state = ConnectionState::default();
    let task = tokio::spawn(connection::supervise(
        link,
        Arc::new(Recorder(sender)),
        state.clone(),
        FAST,
    ));
    (heard, state, task)
}

/// The next report matching `wanted`, skipping the others, within 10 s.
async fn until(
    heard: &mut mpsc::UnboundedReceiver<Heard>,
    wanted: impl Fn(&Heard) -> bool,
) -> Heard {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let next = heard.recv().await.expect("the link task is running");
            if wanted(&next) {
                return next;
            }
        }
    })
    .await
    .expect("the report arrives within 10 s")
}

/// The next status in `state`.
async fn status_in(heard: &mut mpsc::UnboundedReceiver<Heard>, state: LinkState) -> HostStatus {
    match until(heard, |heard| matches!(heard, Heard::Status(status) if status.state == state)).await
    {
        Heard::Status(status) => status,
        Heard::Revision(_) => unreachable!("only statuses match"),
    }
}

async fn next_revision(heard: &mut mpsc::UnboundedReceiver<Heard>) -> i64 {
    match until(heard, |heard| matches!(heard, Heard::Revision(_))).await {
        Heard::Revision(rev) => rev,
        Heard::Status(_) => unreachable!("only revisions match"),
    }
}

async fn start_host(dir: &Path, bind: &str) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some(bind.parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

async fn paired(host: &RunningHost, dir: &Path) -> DeviceState {
    let device = DeviceState::load(dir.to_path_buf());
    device
        .local_pair(&address(host), "Станция", "0.1.0")
        .await
        .unwrap();
    device
}

#[tokio::test]
async fn an_unpaired_device_stays_offline_without_trying() {
    let app_dir = tempfile::tempdir().unwrap();
    let device = DeviceState::load(app_dir.path().to_path_buf());
    let (mut heard, state, task) = follow(device.watch_link());

    assert_eq!(
        until(&mut heard, |_| true).await,
        Heard::Status(HostStatus {
            state: LinkState::Offline,
            last_contact_at: None,
            last_error: None,
            seq: 1,
        })
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(heard.try_recv().is_err(), "nothing more while unpaired");
    assert_eq!(state.snapshot().seq, 1);
    task.abort();
}

#[tokio::test]
async fn a_paired_device_comes_online_and_hears_every_revision() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, state, task) = follow(device.watch_link());

    let online = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(online.last_error, None);
    assert!(online.last_contact_at.is_some());
    assert_eq!(next_revision(&mut heard).await, 0, "the current revision comes first");

    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = device
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200);
    assert_eq!(next_revision(&mut heard).await, 1, "the wizard's commit");
    assert_eq!(state.snapshot().state, LinkState::Online);
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn the_link_goes_offline_with_the_host_and_returns_with_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let bound = host.addr.to_string();
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Online).await;

    host.stop().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert!(
        matches!(
            offline.last_error,
            Some(LinkError::StreamEnded | LinkError::Unreachable)
        ),
        "{offline:?}"
    );

    // The same host comes back on the same address: the link returns on its own.
    let host = start_host(host_dir.path(), &bound).await;
    status_in(&mut heard, LinkState::Online).await;
    assert_eq!(next_revision(&mut heard).await, 0);
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn forgetting_the_device_stops_the_link() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Online).await;

    device.forget().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!((offline.last_error, offline.last_contact_at), (None, None));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let later: Vec<Heard> = std::iter::from_fn(|| heard.try_recv().ok()).collect();
    assert!(later.is_empty(), "no attempts after forgetting: {later:?}");
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn pairing_later_starts_the_link() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = DeviceState::load(app_dir.path().to_path_buf());
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Offline).await;

    device
        .local_pair(&address(&host), "Станция", "0.1.0")
        .await
        .unwrap();
    status_in(&mut heard, LinkState::Online).await;
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_rejected_key_and_a_changed_certificate_are_reported() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;

    let wrong_key = HostLink::new(
        address(&host),
        host.fingerprint.clone(),
        Secret::new("not-a-key-the-host-issued"),
    );
    let (_key_sender, link) = watch::channel(Some(Arc::new(wrong_key)));
    let (mut heard, _state, task) = follow(link);
    let refused = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(refused.last_error, Some(LinkError::KeyRejected));
    task.abort();

    let wrong_certificate = HostLink::new(address(&host), "0".repeat(64), Secret::new("any"));
    let (_certificate_sender, link) = watch::channel(Some(Arc::new(wrong_certificate)));
    let (mut heard, _state, task) = follow(link);
    let refused = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(refused.last_error, Some(LinkError::CertificateMismatch));
    task.abort();
    host.stop().await.unwrap();
}
```

В `apps/standalone/src-tauri/tests/ipc.rs`:

- в импорты добавить `use markiro_standalone_lib::connection::ConnectionState;`;
- в `mock_app_with` после `.manage(local)` добавить `.manage(ConnectionState::default())`;
- в конец файла добавить:

```rust
/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
fn the_connection_status_has_the_webview_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "connection_status", json!({})),
        Ok(json!({ "state": "offline", "lastContactAt": null, "lastError": null, "seq": 0 }))
    );
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test connection --offline` (вне песочницы)
Expected: ошибка компиляции — нет модуля `connection` и типа `HostLink`.

- [ ] **Step 3: Клиент потока в `host_client.rs`**

В `apps/standalone/src-tauri/src/host_client.rs`:

1. После `const MAX_PATH_LENGTH: usize = 512;` добавить:

```rust
/// How long a stream may stay silent before the link counts as lost: three
/// missed 15 s heartbeats.
pub const STREAM_SILENCE_LIMIT: Duration = Duration::from_secs(45);
```

2. `PinnedClient::new` заменить на версию через общий построитель, а после `impl PinnedClient` добавить клиент потока:

```rust
impl PinnedClient {
    /// A client for `address` (`https://host:port`) that trusts only the
    /// certificate with this lower-case hex SHA-256 `fingerprint`.
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }
```

(метод `send` остаётся без изменений);

```rust
/// A long-lived request to the paired host — the change stream — with the
/// same pinned certificate, headers and path rules as [`PinnedClient`], but
/// no limit on the whole exchange: only on silence.
#[derive(Debug, Clone)]
pub struct StreamClient {
    client: reqwest::Client,
    address: String,
}

/// The answer to a stream request.
#[derive(Debug)]
pub enum StreamOpen {
    /// A 2xx answer: read it with [`HostStream::chunk`].
    Open(HostStream),
    /// Any other answer, read whole.
    Refused(HostResponse),
}

#[derive(Debug)]
pub struct HostStream {
    response: reqwest::Response,
}

impl StreamClient {
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .read_timeout(STREAM_SILENCE_LIMIT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }

    /// `GET path` with the device key.
    pub async fn open(&self, path: &str, key: &Secret) -> Result<StreamOpen, RequestError> {
        validate_path(path)?;
        let sent = self
            .client
            .get(format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
            .bearer_auth(key.expose())
            .send()
            .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) if is_fingerprint_mismatch(&error) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        if response.status().is_success() {
            return Ok(StreamOpen::Open(HostStream { response }));
        }
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        Ok(StreamOpen::Refused(HostResponse {
            status,
            body: serde_json::from_slice(&bytes).ok(),
        }))
    }
}

impl HostStream {
    /// The next bytes, `None` once the host closed the stream. Silence past
    /// [`STREAM_SILENCE_LIMIT`] is an error.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, RequestError> {
        match self.response.chunk().await {
            Ok(chunk) => Ok(chunk.map(|bytes| bytes.to_vec())),
            Err(_) => Err(RequestError::Unreachable),
        }
    }
}

/// A client builder that trusts only the certificate with `fingerprint`:
/// no proxy, no redirects, HTTPS only, 2 s to connect.
fn pinned_builder(fingerprint: &str) -> Result<reqwest::ClientBuilder, RequestError> {
    let config = tls::client_config(FingerprintPolicy::Pin {
        expected: fingerprint.to_owned(),
    })
    .map_err(|_| RequestError::Unreachable)?;
    Ok(reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .connect_timeout(CONNECT_TIMEOUT)
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none()))
}
```

3. Комментарий модуля дополнить предложением: `[`StreamClient`] holds the change stream the same way, limited by silence instead of a total time.`

- [ ] **Step 4: Связка с хостом в `DeviceState`**

В `apps/standalone/src-tauri/src/device.rs`:

1. В импорты добавить `use tokio::sync::watch;`.

2. После `struct DeviceStatus` добавить:

```rust
/// What the connection task needs to reach the paired host. The key stays
/// in Rust: `Debug` hides it, and nothing serializes this type.
#[derive(Debug, Clone)]
pub struct HostLink {
    pub address: String,
    pub fingerprint: String,
    key: Secret,
}

impl HostLink {
    pub fn new(address: String, fingerprint: String, key: Secret) -> Self {
        Self {
            address,
            fingerprint,
            key,
        }
    }

    pub fn key(&self) -> &Secret {
        &self.key
    }
}
```

3. В `impl PairedDevice` после `status` добавить:

```rust
    fn link(&self) -> Arc<HostLink> {
        Arc::new(HostLink::new(
            self.config.host_address.clone(),
            self.config.fingerprint.clone(),
            self.key.clone(),
        ))
    }
```

4. В `struct DeviceState` добавить поле:

```rust
    /// The host the connection task should hold a stream to; `None` while
    /// unpaired. Replaced on pairing and forgetting.
    link: watch::Sender<Option<Arc<HostLink>>>,
```

5. В `DeviceState::load` перед `Self { … }` добавить `let link = match &current { Current::Paired(device) => Some(device.link()), _ => None };`, а в литерал — поле `link: watch::channel(link).0,`. Значение канала меняет только `send_replace`: он обновляет его и без подписчиков, а обычный `send` без них ничего не меняет.

6. После `status` добавить:

```rust
    /// Follow the pairing: the connection task holds a stream while this is
    /// `Some` and stays offline while it is `None`.
    pub fn watch_link(&self) -> watch::Receiver<Option<Arc<HostLink>>> {
        self.link.subscribe()
    }
```

7. В `remember` после строки `*self.current.lock().expect("device lock") = Current::Paired(device);` сохранить связку. Для этого `Arc` устройства клонируется до присваивания:

```rust
        let status = device.status();
        let link = device.link();
        *self.current.lock().expect("device lock") = Current::Paired(device);
        self.link.send_replace(Some(link));
        Ok(status)
```

8. В `forget` после `*self.current.lock().expect("device lock") = Current::Unpaired;` добавить `self.link.send_replace(None);`. `select_line` связку не меняет: адрес, отпечаток и ключ те же.

- [ ] **Step 5: Модуль `connection.rs`**

Create `apps/standalone/src-tauri/src/connection.rs`:

```rust
//! The link to the paired host (stage 1 spec §5.2). A background task keeps
//! `GET /v1/changes/stream` open with the device key and the pinned
//! certificate, reconnects after a pause that grows from 1 to 30 s, and tells
//! the webview how the link is (`standalone://host-status`) and which
//! revision the host reached (`standalone://host-revision`). The webview syncs
//! reference data on every revision; it never opens the stream itself.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::device::HostLink;
use crate::host_client::{HostResponse, RequestError, StreamClient, StreamOpen};

pub const STATUS_EVENT: &str = "standalone://host-status";
pub const REVISION_EVENT: &str = "standalone://host-revision";
const STREAM_PATH: &str = "/v1/changes/stream";
/// An event longer than this is not from a Markiro host.
const MAX_EVENT_BYTES: usize = 64 * 1024;

/// How the link is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// The stream is open and the host has spoken on it.
    Online,
    /// Opening the stream.
    Connecting,
    /// No stream: waiting to reconnect, or not paired.
    Offline,
}

/// Why the last attempt failed, as a stable code the webview maps to text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkError {
    /// No connection, a TLS failure other than the pin, or no answer in time.
    Unreachable,
    /// The host presented a certificate other than the pinned one.
    CertificateMismatch,
    /// The host no longer accepts this device's key.
    KeyRejected,
    /// The host refused the stream with another error.
    StreamRefused,
    /// The stream closed, went silent or carried something unreadable.
    StreamEnded,
}

/// `standalone://host-status` and the answer of `connection_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub state: LinkState,
    /// When the host last sent anything on the stream, in milliseconds since
    /// the Unix epoch; `None` before the first contact and while unpaired.
    pub last_contact_at: Option<u64>,
    /// Why the last attempt failed; `None` while online and while unpaired.
    pub last_error: Option<LinkError>,
    /// Grows by one with every published status, so the webview can order a
    /// `connection_status` answer against events that raced it.
    pub seq: u64,
}

impl Default for HostStatus {
    fn default() -> Self {
        Self {
            state: LinkState::Offline,
            last_contact_at: None,
            last_error: None,
            seq: 0,
        }
    }
}

/// `standalone://host-revision`: the host has committed revision `rev`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRevision {
    pub rev: i64,
}

/// Where the task reports: the app emits Tauri events, tests record them.
pub trait LinkEvents: Send + Sync + 'static {
    fn status(&self, status: &HostStatus);
    fn revision(&self, revision: HostRevision);
}

/// Tauri state: the latest status, for `connection_status`.
#[derive(Debug, Clone, Default)]
pub struct ConnectionState(Arc<Mutex<HostStatus>>);

impl ConnectionState {
    pub fn snapshot(&self) -> HostStatus {
        self.0.lock().expect("status lock").clone()
    }

    fn touch(&self) {
        self.0.lock().expect("status lock").last_contact_at = Some(now_ms());
    }

    fn publish(&self, events: &dyn LinkEvents, state: LinkState, last_error: Option<LinkError>) {
        let status = {
            let mut current = self.0.lock().expect("status lock");
            current.state = state;
            current.last_error = last_error;
            current.seq += 1;
            current.clone()
        };
        events.status(&status);
    }

    /// Offline with nothing to report: the device is not paired.
    fn unpaired(&self, events: &dyn LinkEvents) {
        self.0.lock().expect("status lock").last_contact_at = None;
        self.publish(events, LinkState::Offline, None);
    }
}

/// Pauses between attempts: `initial`, doubling up to `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    fn after(self, pause: Duration) -> Duration {
        pause.saturating_mul(2).min(self.max)
    }
}

/// Follow the pairing: hold the stream while paired, stay offline and try
/// nothing while not. Returns once the `DeviceState` behind `link` is gone.
pub async fn supervise(
    mut link: watch::Receiver<Option<Arc<HostLink>>>,
    events: Arc<dyn LinkEvents>,
    state: ConnectionState,
    backoff: Backoff,
) {
    loop {
        let current = link.borrow_and_update().clone();
        let changed = match current {
            None => {
                state.unpaired(&*events);
                link.changed().await
            }
            Some(current) => tokio::select! {
                never = hold(&current, &*events, &state, backoff) => match never {},
                changed = link.changed() => changed,
            },
        };
        if changed.is_err() {
            return;
        }
    }
}

/// Keep the stream to one host open, reconnecting forever. A pairing change
/// drops this future, which closes the connection.
async fn hold(
    link: &HostLink,
    events: &dyn LinkEvents,
    state: &ConnectionState,
    backoff: Backoff,
) -> Infallible {
    let mut pause = backoff.initial;
    let mut last_error = None;
    loop {
        state.publish(events, LinkState::Connecting, last_error);
        let (error, came_online) = follow(link, events, state).await;
        last_error = Some(error);
        state.publish(events, LinkState::Offline, last_error);
        if came_online {
            pause = backoff.initial;
        }
        tokio::time::sleep(pause).await;
        pause = backoff.after(pause);
    }
}

/// One connection: open the stream and pass its events on until it ends.
/// Returns why it ended and whether the host had spoken on it.
async fn follow(
    link: &HostLink,
    events: &dyn LinkEvents,
    state: &ConnectionState,
) -> (LinkError, bool) {
    let client = match StreamClient::new(&link.address, &link.fingerprint) {
        Ok(client) => client,
        Err(error) => return (request_error(error), false),
    };
    let mut stream = match client.open(STREAM_PATH, link.key()).await {
        Ok(StreamOpen::Open(stream)) => stream,
        Ok(StreamOpen::Refused(response)) => return (refusal(&response), false),
        Err(error) => return (request_error(error), false),
    };
    let mut parser = SseParser::default();
    let mut online = false;
    loop {
        let bytes = match stream.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => return (LinkError::StreamEnded, online),
        };
        state.touch();
        let Ok(items) = parser.push(&bytes) else {
            return (LinkError::StreamEnded, online);
        };
        for item in items {
            if !online {
                online = true;
                state.publish(events, LinkState::Online, None);
            }
            if let SseItem::Revision(rev) = item {
                events.revision(HostRevision { rev });
            }
        }
    }
}

fn request_error(error: RequestError) -> LinkError {
    match error {
        RequestError::CertificateMismatch => LinkError::CertificateMismatch,
        _ => LinkError::Unreachable,
    }
}

/// A refused stream: a rejected device key needs a new pairing; any other
/// refusal is the host's to explain in its own log.
fn refusal(response: &HostResponse) -> LinkError {
    let credential = response
        .body
        .as_ref()
        .and_then(|body| body["error"]["details"]["credential"].as_str());
    if response.status == 401 && credential == Some(markiro_proto::credentials::DEVICE) {
        LinkError::KeyRejected
    } else {
        LinkError::StreamRefused
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What one server-sent event carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// `event: rev` with `data: {"rev": N}`.
    Revision(i64),
    /// A comment (the heartbeat) or an event this build does not read.
    Other,
}

/// An event grew past the limit without ending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventTooLong;

/// Splits a `text/event-stream` into events: blocks of lines that end with a
/// blank line, with LF or CRLF line ends.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    /// Feed the next bytes; returns the events they completed.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseItem>, EventTooLong> {
        self.buffer
            .extend(bytes.iter().copied().filter(|&byte| byte != b'\r'));
        let mut items = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\n\n") {
            let block: Vec<u8> = self.buffer.drain(..end + 2).collect();
            items.push(parse_event(&block[..end]));
        }
        if self.buffer.len() > MAX_EVENT_BYTES {
            return Err(EventTooLong);
        }
        Ok(items)
    }
}

/// One event block: `event:` names it, `data:` lines carry it, lines that
/// start with `:` are comments.
fn parse_event(block: &[u8]) -> SseItem {
    let text = String::from_utf8_lossy(block);
    let mut name = None;
    let mut data = String::new();
    for line in text.split('\n') {
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => name = Some(value),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            _ => {}
        }
    }
    match (name, serde_json::from_str::<HostRevision>(&data)) {
        (Some("rev"), Ok(revision)) => SseItem::Revision(revision.rev),
        _ => SseItem::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const REV_7: &[u8] = b"event: rev\ndata: {\"rev\":7}\n\n";

    #[test]
    fn a_revision_event_is_read_whole_or_in_pieces() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(REV_7), Ok(vec![SseItem::Revision(7)]));
        for split in 1..REV_7.len() {
            let mut parser = SseParser::default();
            let mut items = parser.push(&REV_7[..split]).unwrap();
            items.extend(parser.push(&REV_7[split..]).unwrap());
            assert_eq!(items, vec![SseItem::Revision(7)], "split at {split}");
        }
    }

    #[test]
    fn heartbeats_crlf_and_several_events_in_one_chunk() {
        let mut parser = SseParser::default();
        let chunk =
            b":\n\nevent: rev\r\ndata: {\"rev\":1}\r\n\r\nevent: rev\ndata: {\"rev\":2}\n\n";
        assert_eq!(
            parser.push(chunk),
            Ok(vec![SseItem::Other, SseItem::Revision(1), SseItem::Revision(2)])
        );
    }

    #[test]
    fn unknown_or_unreadable_events_are_other() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(b"event: hello\ndata: {}\n\n"), Ok(vec![SseItem::Other]));
        assert_eq!(parser.push(b"event: rev\ndata: not json\n\n"), Ok(vec![SseItem::Other]));
        assert_eq!(parser.push(b"data: {\"rev\":3}\n\n"), Ok(vec![SseItem::Other]));
    }

    #[test]
    fn an_endless_event_is_refused() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(&vec![b'x'; MAX_EVENT_BYTES + 1]), Err(EventTooLong));
    }

    #[test]
    fn pauses_double_up_to_the_limit() {
        let backoff = Backoff::default();
        let mut pause = backoff.initial;
        let mut seconds = vec![pause.as_secs()];
        for _ in 0..6 {
            pause = backoff.after(pause);
            seconds.push(pause.as_secs());
        }
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn a_rejected_device_key_is_told_apart_from_other_refusals() {
        let refused = |status: u16, body: serde_json::Value| {
            refusal(&HostResponse {
                status,
                body: Some(body),
            })
        };
        assert_eq!(
            refused(
                401,
                json!({ "error": { "code": "unauthorized", "message": "", "details": { "credential": "device" } } })
            ),
            LinkError::KeyRejected
        );
        assert_eq!(
            refused(400, json!({ "error": { "code": "protocol_unsupported", "message": "" } })),
            LinkError::StreamRefused
        );
        assert_eq!(
            refusal(&HostResponse {
                status: 500,
                body: None
            }),
            LinkError::StreamRefused
        );
    }

    #[test]
    fn statuses_and_revisions_serialize_to_the_webview_shape() {
        let status = HostStatus {
            state: LinkState::Offline,
            last_contact_at: Some(1_700_000_000_000),
            last_error: Some(LinkError::CertificateMismatch),
            seq: 4,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "offline", "lastContactAt": 1_700_000_000_000u64, "lastError": "certificate_mismatch", "seq": 4 })
        );
        assert_eq!(serde_json::to_value(HostRevision { rev: 12 }).unwrap(), json!({ "rev": 12 }));
    }
}
```

В `apps/standalone/src-tauri/src/lib.rs` добавить `pub mod connection;` (по алфавиту, первым модулем).

- [ ] **Step 6: Задача в приложении и команда `connection_status`**

В `apps/standalone/src-tauri/src/lib.rs`:

1. Импорты:

```rust
use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{Emitter, Manager, Runtime};

use connection::{Backoff, ConnectionState, HostRevision, HostStatus, LinkEvents};
use device::{DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbState, LocalStatement};
```

2. После `local_host_address` добавить:

```rust
/// The connection task's reports as Tauri events (`src/host/connection.ts`).
struct TauriLinkEvents<R: Runtime>(tauri::AppHandle<R>);

impl<R: Runtime> LinkEvents for TauriLinkEvents<R> {
    fn status(&self, status: &HostStatus) {
        // A closed window hears nothing; the next status replaces this one.
        let _ = self.0.emit(connection::STATUS_EVENT, status);
    }

    fn revision(&self, revision: HostRevision) {
        let _ = self.0.emit(connection::REVISION_EVENT, revision);
    }
}
```

3. После `local_transaction` добавить команду:

```rust
#[tauri::command]
fn connection_status(state: tauri::State<'_, ConnectionState>) -> HostStatus {
    state.snapshot()
}
```

и в конец списка `invoke_handler()` — `connection_status`.

4. Тело `setup` в `run()` заменить на:

```rust
            // The local data directory, not the (roaming, on Windows)
            // config directory: the device identity must stay on this
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            let device = DeviceState::load(dir.clone());
            let link = device.watch_link();
            app.manage(device);
            // The local database opens before the window shows. When it
            // cannot open, the app still starts and the local commands say so.
            app.manage(tauri::async_runtime::block_on(LocalDbState::open(&dir)));
            let status = ConnectionState::default();
            app.manage(status.clone());
            tauri::async_runtime::spawn(connection::supervise(
                link,
                Arc::new(TauriLinkEvents(app.handle().clone())),
                status,
                Backoff::default(),
            ));
            Ok(())
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы)
Expected: PASS — модульные тесты `connection.rs` (7), `connection.rs` интеграционный (6 тестов), `ipc.rs` (7 тестов), остальные без изменений.

- [ ] **Step 7: Документы**

1. В `apps/standalone/AGENTS.md` после раздела «Network and TLS» добавить раздел:

```markdown
## Connection to the host

`src-tauri/src/connection.rs` runs one background task per app. It follows
the pairing (`DeviceState::watch_link`). While paired it holds
`GET /v1/changes/stream` with the device key and the pinned certificate
(`host_client::StreamClient`: no overall timeout, but 45 s of silence —
three missed heartbeats — drops the connection) and reconnects after a
pause of 1 s doubling to 30 s, back to 1 s after a stream that was online.
While unpaired it stays offline and tries nothing. It emits
`standalone://host-status` (`{ state: online | connecting | offline,
lastContactAt, lastError, seq }`, `lastError` one of `unreachable`,
`certificate_mismatch`, `key_rejected`, `stream_refused`, `stream_ended`)
and `standalone://host-revision` (`{ rev }` for every stream event, the
first one after each connect included). `connection_status` answers the
latest status; `seq` grows with every status, so the webview subscribes
first, then asks, and keeps whichever is newest. The webview syncs reference
data on each revision and never opens the stream itself.
```

2. В спецификации, §5.2, пункт «Поток изменений» заменить на:

```markdown
- **Поток изменений.** Фоновая задача держит SSE, пока устройство подключено
  (без общего таймаута; 45 с молчания — связь потеряна), переподключается с
  паузой от 1 до 30 с (после сеанса «на связи» — снова 1 с) и шлёт в
  интерфейс события `standalone://host-status` (`online | connecting |
offline`, время последней связи в миллисекундах Unix, последняя ошибка —
  `unreachable`, `certificate_mismatch`, `key_rejected`, `stream_refused` или
  `stream_ended`, и порядковый номер `seq`) и `standalone://host-revision`
  (`{ rev }`, в том числе первое событие после каждого подключения). Команда
  `connection_status()` возвращает последний статус: интерфейс сначала
  подписывается на события, потом спрашивает и оставляет статус с большим
  `seq`.
```

Затем `node_modules/.bin/prettier --write` и `--check` на оба файла.

- [ ] **Step 8: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы); `git diff --check`.
Expected: все тесты воркспейса PASS, без предупреждений компилятора.

```bash
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/src-tauri/src/host_client.rs apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/connection.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/connection.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): связь с хостом — фоновый поток изменений и статус" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Привязки вебвью — `device.ts`, `connection.ts`, `local/executor.ts`

Контракт IPC меняется вместе с его стороной в TypeScript (`apps/standalone/AGENTS.md`, «Network and TLS»). Экраны плана 1c3 будут звать новые команды только через эти привязки:

- `DeviceApi` получает `claim` и `selectLine` и новые коды отказов с текстами;
- `ConnectionApi` сначала подписывается на события связи, потом спрашивает снимок и отдаёт только статусы новее уже виденных (по `seq`);
- `LocalExecutor` — единственный вход вебвью в локальную базу.

В тестах `LocalExecutor` работает на `node:sqlite` по тем же миграциям оболочки, что и приложение. Синхронизация справочников (план 1c3) проверяется на настоящей базе, а SQL из тестов не расходится со схемой.

**Files:**

- Modify: `apps/standalone/src/host/device.ts`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/i18n/ru.json`
- Create: `apps/standalone/src/host/connection.ts`, `apps/standalone/src/local/executor.ts`
- Modify: `apps/standalone/test/device.test.ts`, `apps/standalone/test/app.test.tsx`
- Create: `apps/standalone/test/connection.test.ts`, `apps/standalone/test/local-executor.test.ts`, `apps/standalone/test/support/local-db.ts`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes:
  - команды `host_claim { address, fingerprint, code, name }`, `device_select_line { lineId }`, `connection_status {}`, `local_query { sql, params }`, `local_transaction { statements }`;
  - события `standalone://host-status` и `standalone://host-revision`;
  - коды отказов (задачи 1–4);
  - миграции `src-tauri/migrations/*.sql`.
- Produces:
  - `DeviceApi.claim(input: ClaimInput): Promise<DeviceStatus>`, `DeviceApi.selectLine(lineId: string): Promise<DeviceStatus>`, тип `ClaimInput { address, fingerprint, code, name }`;
  - `DEVICE_ERROR_CODES` с `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`, `line_rejected`, `key_rejected`, `request_failed`;
  - `hostStatusSchema`/`HostStatus`, `hostRevisionSchema` в `protocol.ts`;
  - `createTauriConnectionApi(call?, subscribe?): ConnectionApi` с `watch({ onStatus, onRevision }): Promise<() => void>`, `HOST_STATUS_EVENT`, `HOST_REVISION_EVENT`;
  - `LocalExecutor { query<T>(sql, params, row: z.ZodType<T>): Promise<T[]>; transaction(statements): Promise<number[]> }`, `createTauriLocalExecutor(call?)`, `LocalStatement`, `LocalDbError`, `LOCAL_DB_ERROR_CODES`;
  - `openLocalDb(): { db: DatabaseSync; executor: LocalExecutor }` в `test/support/local-db.ts`.

- [ ] **Step 1: Тесты (падающие)**

В `apps/standalone/test/device.test.ts` после теста «forgets the pairing» добавить:

```ts
it("pairs by code with the host's address, the confirmed fingerprint and a name", async () => {
  const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
  const input = {
    address: "https://192.168.1.10:45710",
    fingerprint: "ab".repeat(32),
    code: "7KQ2M9XRTD",
    name: "Станция на линии 2",
  };
  await expect(createTauriDeviceApi(call).claim(input)).resolves.toEqual(DEVICE_STATUS);
  expect(call).toHaveBeenCalledWith("host_claim", input);
});

it("selects the station's line", async () => {
  const lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
  const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, lineId });
  await expect(createTauriDeviceApi(call).selectLine(lineId)).resolves.toEqual({
    ...DEVICE_STATUS,
    lineId,
  });
  expect(call).toHaveBeenCalledWith("device_select_line", { lineId });
});
```

Тест `it.each(DEVICE_ERROR_CODES)` из того же файла проверит новые коды сам. Тест текстов в `test/errors.test.ts` потребует для каждого кода ключ `errors.device.<код>`.

Create `apps/standalone/test/connection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createTauriConnectionApi,
  HOST_REVISION_EVENT,
  HOST_STATUS_EVENT,
} from "../src/host/connection.js";
import type { HostStatus } from "../src/host/protocol.js";

type Handler = (event: { payload: unknown }) => void;

/** A fake `listen`: records handlers so the test can emit shell events. */
function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const listen = vi.fn(async (event: string, handler: Handler) => {
    order.push(`listen ${event}`);
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload });
  return { listen, emit, handlers, order };
}

function status(seq: number, state: HostStatus["state"] = "online"): HostStatus {
  return {
    state,
    lastContactAt: state === "online" ? 1_700_000_000_000 : null,
    lastError: state === "offline" ? "unreachable" : null,
    seq,
  };
}

describe("connection to the host", () => {
  it("subscribes to both events before asking for the current status", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      events.order.push(command);
      return status(1);
    });
    const onStatus = vi.fn();
    await createTauriConnectionApi(call, events.listen).watch({ onStatus, onRevision: vi.fn() });
    expect(events.order).toEqual([
      `listen ${HOST_STATUS_EVENT}`,
      `listen ${HOST_REVISION_EVENT}`,
      "connection_status",
    ]);
    expect(call).toHaveBeenCalledWith("connection_status", {});
    expect(onStatus).toHaveBeenCalledWith(status(1));
  });

  it("keeps only statuses newer than the newest seen", async () => {
    const events = fakeEvents();
    const onStatus = vi.fn();
    // The shell published seq 3 while the snapshot (seq 2) was on its way.
    const call = vi.fn(async () => {
      events.emit(HOST_STATUS_EVENT, status(3, "offline"));
      return status(2);
    });
    await createTauriConnectionApi(call, events.listen).watch({ onStatus, onRevision: vi.fn() });
    events.emit(HOST_STATUS_EVENT, status(3, "online"));
    events.emit(HOST_STATUS_EVENT, status(4, "connecting"));
    expect(onStatus.mock.calls).toEqual([[status(3, "offline")], [status(4, "connecting")]]);
  });

  it("passes revisions on and ignores events it cannot read", async () => {
    const events = fakeEvents();
    const onStatus = vi.fn();
    const onRevision = vi.fn();
    await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus,
      onRevision,
    });
    events.emit(HOST_REVISION_EVENT, { rev: 7 });
    events.emit(HOST_REVISION_EVENT, { rev: -1 });
    events.emit(HOST_REVISION_EVENT, { rev: 8, extra: true });
    events.emit(HOST_STATUS_EVENT, { ...status(5), state: "sleeping" });
    expect(onRevision.mock.calls).toEqual([[7]]);
    expect(onStatus.mock.calls).toEqual([[status(1)]]);
  });

  it("stops listening when asked", async () => {
    const events = fakeEvents();
    const stop = await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus: vi.fn(),
      onRevision: vi.fn(),
    });
    expect(events.handlers.size).toBe(2);
    stop();
    expect(events.handlers.size).toBe(0);
  });

  it("stops listening and fails when the snapshot cannot be read", async () => {
    const events = fakeEvents();
    const watching = createTauriConnectionApi(
      async () => ({ ...status(1), extra: true }),
      events.listen,
    ).watch({ onStatus: vi.fn(), onRevision: vi.fn() });
    await expect(watching).rejects.toThrow();
    expect(events.handlers.size).toBe(0);
  });
});
```

Create `apps/standalone/test/local-executor.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTauriLocalExecutor,
  LOCAL_DB_ERROR_CODES,
  LocalDbError,
} from "../src/local/executor.js";
import { openLocalDb } from "./support/local-db.js";

const LINE = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const INSERT_LINE = "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)";
const lineRow = z
  .object({ id: z.string(), name: z.string(), archived: z.number(), rev: z.number() })
  .strict();
/** The reference sync's page upsert (plan 1c3), as the shell test runs it too. */
const UPSERT_LINES =
  "INSERT INTO ref_lines (id, name, archived, rev) " +
  "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, rev = excluded.rev " +
  "WHERE excluded.rev > ref_lines.rev";

async function failure(promise: Promise<unknown>): Promise<LocalDbError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LocalDbError);
  return error as LocalDbError;
}

describe("Tauri local executor", () => {
  it("sends a query with its parameters and checks every row", async () => {
    const row = { id: LINE, name: "Линия 1", archived: 0, rev: 1 };
    const call = vi.fn().mockResolvedValue([row]);
    const sql = "SELECT id, name, archived, rev FROM ref_lines WHERE archived = ?";
    await expect(createTauriLocalExecutor(call).query(sql, [0], lineRow)).resolves.toEqual([row]);
    expect(call).toHaveBeenCalledWith("local_query", { sql, params: [0] });
  });

  it("sends a batch with its values and only the expectations it has", async () => {
    const call = vi.fn().mockResolvedValue([1, 1, 0]);
    const update = "UPDATE sync_state SET value = ? WHERE key = 'last_rev'";
    const cleanup = "DELETE FROM ref_lines WHERE rev < 0";
    await expect(
      createTauriLocalExecutor(call).transaction([
        { sql: INSERT_LINE, values: [LINE, "Линия 1", 0, 1] },
        { sql: update, values: ["1"], expectedChanges: 1 },
        { sql: cleanup },
      ]),
    ).resolves.toEqual([1, 1, 0]);
    expect(call).toHaveBeenCalledWith("local_transaction", {
      statements: [
        { sql: INSERT_LINE, values: [LINE, "Линия 1", 0, 1] },
        { sql: update, values: ["1"], expectedChanges: 1 },
        { sql: cleanup, values: [] },
      ],
    });
  });

  it.each(LOCAL_DB_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    const error = await failure(createTauriLocalExecutor(call).transaction([{ sql: "SELECT 1" }]));
    expect(error.code).toBe(code);
  });

  it("treats an unexpected shell error as a failed statement", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const error = await failure(createTauriLocalExecutor(call).query("SELECT 1", [], z.unknown()));
    expect(error.code).toBe("statement_failed");
  });

  it("rejects answers it cannot read", async () => {
    const rows = vi.fn().mockResolvedValue([{ id: LINE }]);
    const error = await failure(
      createTauriLocalExecutor(rows).query("SELECT id FROM ref_lines", [], lineRow),
    );
    expect(error.code).toBe("invalid_response");
    const changes = vi.fn().mockResolvedValue(["one"]);
    const batch = await failure(
      createTauriLocalExecutor(changes).transaction([{ sql: "SELECT 1" }]),
    );
    expect(batch.code).toBe("invalid_response");
  });
});

describe("local database on node:sqlite", () => {
  it("has exactly the shell's reference tables", async () => {
    const { executor } = openLocalDb();
    const tables = await executor.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
      z.object({ name: z.string() }),
    );
    expect(tables.map((table) => table.name)).toEqual([
      "ref_lines",
      "ref_org",
      "ref_site",
      "sync_state",
    ]);
  });

  it("commits a batch together and rolls it back whole", async () => {
    const { executor } = openLocalDb();
    await expect(
      executor.transaction([{ sql: INSERT_LINE, values: [LINE, "Линия 1", false, 1] }]),
    ).resolves.toEqual([1]);
    const duplicate = await failure(
      executor.transaction([
        { sql: "UPDATE ref_lines SET name = ? WHERE id = ?", values: ["Первая", LINE] },
        { sql: INSERT_LINE, values: [LINE, "Та же линия", 0, 1] },
      ]),
    );
    expect(duplicate.code).toBe("statement_failed");
    const mismatch = await failure(
      executor.transaction([
        { sql: "UPDATE ref_lines SET name = ? WHERE id = ?", values: ["Первая", LINE] },
        {
          sql: "UPDATE ref_lines SET name = ? WHERE id = ?",
          values: ["Вторая", "no-such-line"],
          expectedChanges: 1,
        },
      ]),
    );
    expect(mismatch.code).toBe("changes_mismatch");
    await expect(
      executor.query("SELECT id, name, archived, rev FROM ref_lines", [], lineRow),
    ).resolves.toEqual([{ id: LINE, name: "Линия 1", archived: 0, rev: 1 }]);
  });

  it("upserts a whole page through json_each as the shell does", async () => {
    const { executor } = openLocalDb();
    const page = JSON.stringify(
      Array.from({ length: 1000 }, (_, n) => ({
        id: `line-${String(n).padStart(4, "0")}`,
        name: `Линия ${n}`,
        archived: 0,
        rev: 7,
      })),
    );
    await expect(executor.transaction([{ sql: UPSERT_LINES, values: [page] }])).resolves.toEqual([
      1000,
    ]);
    await expect(executor.transaction([{ sql: UPSERT_LINES, values: [page] }])).resolves.toEqual([
      0,
    ]);
  });

  it("refuses values the shell cannot bind", async () => {
    const { executor } = openLocalDb();
    const error = await failure(
      executor.transaction([{ sql: INSERT_LINE, values: [LINE, ["nested"], 0, 1] }]),
    );
    expect(error.code).toBe("unsupported_value");
  });
});
```

В `apps/standalone/test/app.test.tsx` в `fakeDevice` после `pairLocally` добавить (приложение этого плана их не вызывает, экраны — план 1c3):

```ts
    claim: vi.fn<DeviceApi["claim"]>(async () => {
      throw new Error("pairing by code is not part of the app yet");
    }),
    selectLine: vi.fn<DeviceApi["selectLine"]>(async () => {
      throw new Error("line selection is not part of the app yet");
    }),
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/connection.test.ts test/local-executor.test.ts`
Expected: FAIL — нет модулей `src/host/connection.ts`, `src/local/executor.ts`, `test/support/local-db.ts` и методов `claim`, `selectLine`.

- [ ] **Step 2: `device.ts` и тексты**

В `apps/standalone/src/host/device.ts`:

1. Список `DEVICE_ERROR_CODES` после `"host_changed",` дополнить:

```ts
  "pairing_code_invalid",
  "pairing_code_expired",
  "rate_limited",
  "line_rejected",
  "key_rejected",
  "request_failed",
```

2. Перед `interface DeviceApi` добавить:

```ts
/**
 * What `host_claim` needs: the host's address, its certificate fingerprint
 * (from the scanned pairing code, or compared by a person with the office
 * screen), the one-time code and this device's name.
 */
export interface ClaimInput {
  address: string;
  fingerprint: string;
  code: string;
  name: string;
}
```

3. В `interface DeviceApi` после `pairLocally` добавить:

```ts
  /** Pair with a host in the network by a one-time code from the office (`host_claim`). */
  claim(input: ClaimInput): Promise<DeviceStatus>;
  /** Choose this station's line; the shell keeps the host's answer in `device.json`. */
  selectLine(lineId: string): Promise<DeviceStatus>;
```

4. В `createTauriDeviceApi` после `pairLocally` добавить:

```ts
    async claim({ address, fingerprint, code, name }) {
      return parseStatus(await run("host_claim", { address, fingerprint, code, name }));
    },
    async selectLine(lineId) {
      return parseStatus(await run("device_select_line", { lineId }));
    },
```

В `apps/standalone/src/i18n/ru.json` в `errors.device` после `"host_changed"` добавить:

```json
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе.",
      "rate_limited": "Слишком много попыток подключения. Подождите минуту и попробуйте снова.",
      "line_rejected": "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "request_failed": "Хост не выполнил запрос. Повторите попытку."
```

- [ ] **Step 3: Схемы связи и `connection.ts`**

В `apps/standalone/src/host/protocol.ts` после `hostResponseSchema` (раздел «The Rust shell's own payloads (strict)») добавить:

```ts
/** `connection_status` and `standalone://host-status`: the link to the host. */
export const hostStatusSchema = z
  .object({
    state: z.enum(["online", "connecting", "offline"]),
    /** When the host last sent anything, in milliseconds since the Unix epoch. */
    lastContactAt: z.number().int().nonnegative().nullable(),
    lastError: z
      .enum([
        "unreachable",
        "certificate_mismatch",
        "key_rejected",
        "stream_refused",
        "stream_ended",
      ])
      .nullable(),
    /** Grows with every status the shell publishes. */
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** `standalone://host-revision`: the host committed revision `rev`. */
export const hostRevisionSchema = z.object({ rev: z.number().int().nonnegative() }).strict();
```

Create `apps/standalone/src/host/connection.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { hostRevisionSchema, hostStatusSchema, type HostStatus } from "./protocol.js";

/** Events of the shell's connection task (`src-tauri/src/connection.rs`). */
export const HOST_STATUS_EVENT = "standalone://host-status";
export const HOST_REVISION_EVENT = "standalone://host-revision";

export interface ConnectionHandlers {
  /** The current status first, then every newer one. */
  onStatus(status: HostStatus): void;
  /** The host committed revision `rev`: time to sync reference data. */
  onRevision(rev: number): void;
}

/** The link to the host, as the shell's connection task reports it. */
export interface ConnectionApi {
  /** Follow the link until the returned function is called. */
  watch(handlers: ConnectionHandlers): Promise<() => void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/**
 * Subscribes first and asks for the current status second, so no status is
 * lost in between; `seq` orders the answer against events that raced it.
 */
export function createTauriConnectionApi(
  call: Invoke = invoke,
  subscribe: Listen = listen,
): ConnectionApi {
  return {
    async watch({ onStatus, onRevision }) {
      let newest = -1;
      const accept = (status: HostStatus) => {
        if (status.seq <= newest) return;
        newest = status.seq;
        onStatus(status);
      };
      const stops = await Promise.all([
        subscribe(HOST_STATUS_EVENT, (event) => {
          const parsed = hostStatusSchema.safeParse(event.payload);
          if (parsed.success) accept(parsed.data);
        }),
        subscribe(HOST_REVISION_EVENT, (event) => {
          const parsed = hostRevisionSchema.safeParse(event.payload);
          if (parsed.success) onRevision(parsed.data.rev);
        }),
      ]);
      const stop = () => {
        for (const unlisten of stops) unlisten();
      };
      try {
        accept(hostStatusSchema.parse(await call("connection_status", {})));
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    },
  };
}
```

Если `listen` из `@tauri-apps/api/event` не присваивается типу `Listen` (у настоящей функции обобщённый обработчик `EventCallback<T>`), оберните её: `(event, handler) => listen(event, handler)`. Приведения типов не используйте.

- [ ] **Step 4: `local/executor.ts` и исполнитель на `node:sqlite`**

Create `apps/standalone/src/local/executor.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/** One statement of a batch: literals go in `values`, never in `sql`. */
export interface LocalStatement {
  sql: string;
  values?: readonly unknown[];
  /** Roll the whole batch back unless this statement changes exactly this many rows. */
  expectedChanges?: number;
}

/** Codes the shell rejects the local commands with (`LocalDbError::code` in src-tauri). */
export const LOCAL_DB_ERROR_CODES = [
  "local_db_unavailable",
  "invalid_statement",
  "unsupported_value",
  "statement_failed",
  "changes_mismatch",
] as const;
/** Plus `invalid_response`: the shell answered in a shape this build cannot read. */
export type LocalDbErrorCode = (typeof LOCAL_DB_ERROR_CODES)[number] | "invalid_response";

export class LocalDbError extends Error {
  readonly code: LocalDbErrorCode;

  constructor(code: LocalDbErrorCode, message: string) {
    super(message);
    this.name = "LocalDbError";
    this.code = code;
  }
}

/**
 * The station's local database (stage 1 spec §5.2): the shell's
 * `local_query` and `local_transaction` in the app, node:sqlite with the same
 * migrations in tests (`test/support/local-db.ts`).
 */
export interface LocalExecutor {
  /** One `SELECT` or `WITH` statement; every row is checked against `row`. */
  query<T>(sql: string, params: readonly unknown[], row: z.ZodType<T>): Promise<T[]>;
  /** All statements in one transaction; the rows each changed. */
  transaction(statements: readonly LocalStatement[]): Promise<number[]>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const changesSchema = z.array(z.number().int().nonnegative());

export function createTauriLocalExecutor(call: Invoke = invoke): LocalExecutor {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code =
        LOCAL_DB_ERROR_CODES.find((candidate) => candidate === error) ?? "statement_failed";
      throw new LocalDbError(code, `${command}: ${String(error)}`);
    }
  }

  return {
    async query(sql, params, row) {
      const rows = z.array(row).safeParse(await run("local_query", { sql, params: [...params] }));
      if (!rows.success) throw new LocalDbError("invalid_response", rows.error.message);
      return rows.data;
    },
    async transaction(statements) {
      const changes = changesSchema.safeParse(
        await run("local_transaction", { statements: statements.map(toShellStatement) }),
      );
      if (!changes.success) throw new LocalDbError("invalid_response", changes.error.message);
      return changes.data;
    },
  };
}

function toShellStatement({ sql, values = [], expectedChanges }: LocalStatement) {
  return expectedChanges === undefined
    ? { sql, values: [...values] }
    : { sql, values: [...values], expectedChanges };
}
```

Create `apps/standalone/test/support/local-db.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { z } from "zod";

import { LocalDbError, type LocalExecutor } from "../../src/local/executor.js";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const moduleUrl = import.meta.url;
const MIGRATIONS = new URL("../../src-tauri/migrations/", moduleUrl);

/**
 * The shell's local database on node:sqlite: the same migrations, in
 * memory, behind the same `LocalExecutor` the app uses. SQL behaves as in
 * the shell; the shell's statement limits are pinned by its Rust tests.
 */
export function openLocalDb(): { db: DatabaseSync; executor: LocalExecutor } {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  return { db, executor: nodeExecutor(db) };
}

function nodeExecutor(db: DatabaseSync): LocalExecutor {
  return {
    async query(sql, params, row) {
      const rows = z.array(row).safeParse(db.prepare(sql).all(...params.map(toSqlValue)));
      if (!rows.success) throw new LocalDbError("invalid_response", rows.error.message);
      return rows.data;
    },
    async transaction(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map(({ sql, values = [], expectedChanges }) => {
          const changed = Number(db.prepare(sql).run(...values.map(toSqlValue)).changes);
          if (expectedChanges !== undefined && changed !== expectedChanges) {
            throw new LocalDbError("changes_mismatch", sql);
          }
          return changed;
        });
        db.exec("COMMIT");
        return changes;
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof LocalDbError) throw error;
        throw new LocalDbError("statement_failed", String(error));
      }
    },
  };
}

/** The shell binds booleans as 0 and 1 and refuses arrays and objects; so does this. */
function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new LocalDbError("unsupported_value", `cannot bind a value of type ${typeof value}`);
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/connection.test.ts test/local-executor.test.ts test/errors.test.ts test/app.test.tsx`
Expected: PASS.

- [ ] **Step 5: Документы**

1. В `apps/standalone/AGENTS.md`, раздел «Network and TLS»: фрагмент

```text
Change it together with `src/host/client.ts`,
`src/host/device.ts` and `src/host/probe.ts`.
```

(перенос строки в файле может стоять в другом месте) заменить на

```text
Change it together with `src/host/client.ts`,
`device.ts`, `probe.ts` and `connection.ts` and `src/local/executor.ts`.
```

2. Там же в конец раздела «Local database» добавить:

```text
The webview reaches it only through `LocalExecutor` (`src/local/executor.ts`);
Vitest runs the same migrations on node:sqlite behind the same interface
(`test/support/local-db.ts`), so SQL in tests never drifts from the schema.
```

Затем `node_modules/.bin/prettier --write` и `--check` на `AGENTS.md` и изменённые TS/JSON-файлы.

- [ ] **Step 6: Проверки и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`, `… build`; `git diff --check`.
Expected: всё зелёное; вывод Vitest без предупреждений.

```bash
git add apps/standalone/src/host/device.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/connection.ts apps/standalone/src/local/executor.ts apps/standalone/src/i18n/ru.json apps/standalone/test/device.test.ts apps/standalone/test/app.test.tsx apps/standalone/test/connection.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/test/support/local-db.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): привязки вебвью к подключению по коду, линии, связи и локальной базе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы) — все тесты PASS, без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `git diff --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — зелёные.
- [ ] `node_modules/.bin/prettier --check` по изменённым файлам — чисто.
- [ ] `git diff <начало плана>..HEAD -- apps/standalone/Cargo.lock` — только строка `"sqlx",` в зависимостях `markiro-standalone`.
- [ ] В отчёте отдельно — что не проверялось и почему:
  - окно `tauri dev`: события Tauri в настоящем вебвью и открытие локальной базы при запуске приложения — автоматически проверены только на мок-среде Tauri (`src-tauri/tests/ipc.rs`) и прямыми тестами модулей;
  - задание `standalone-windows-build` (сборка оболочки с sqlx и тесты DPAPI на Windows) — для CI нужен push;
  - второй ПК в локальной сети, подключение по коду через настоящую сеть и работа потока через неё — вручную после плана 1c3, когда появятся экраны.
