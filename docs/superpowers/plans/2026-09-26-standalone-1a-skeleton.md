# План 1a: каркас автономного приложения — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** появляется `apps/standalone`: служба хоста отвечает на `GET /v1/hello` по HTTPS с самоподписанным сертификатом, приложение Tauri находит хост на этом ПК и показывает его версию и отпечаток, CI собирает и тестирует всё это.

**Architecture:** Cargo-воркспейс из трёх крейтов — `proto` (типы протокола и фикстуры), `host` (библиотека и бинарник `markiro-host`: конфигурация, SQLite через sqlx, TLS через rustls/rcgen, axum поверх собственного TLS-приёмника), `src-tauri` (оболочка с командой `host_hello`). Веб-интерфейс на React ходит к хосту только через команды Rust; схемы Zod разбирают те же JSON-фикстуры, что и Rust.

**Tech Stack:** Rust 2021 (axum 0.8.9, sqlx 0.8.6, rustls 0.23.43 + aws-lc-rs, rcgen 0.14.10, tokio 1.53.1, reqwest 0.13.4, Tauri 2.11), React 19, Vite 8, Vitest 4, Zod 4, i18next.

**Спецификации:** `docs/superpowers/specs/2026-09-26-standalone-station-design.md` и `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (этот план — строка 1a раздела 8).

## Global Constraints

- Точные версии Rust-крейтов: `axum =0.8.9`, `rcgen =0.14.10`, `sqlx =0.8.6`, `tokio =1.53.1`, `tokio-rustls =0.26.4`, `rustls =0.23.43`, `reqwest =0.13.4`, `time =0.3.55`, `tracing-subscriber =0.3.23`, `tracing-appender =0.2.5`, `windows-service =0.8.1` (только Windows); `tauri = "2.11"`, `tauri-build = "2"`, `tauri-plugin-single-instance = "2"` — как у станции. Других новых крейтов, кроме перечисленных в задачах, не добавлять.
- Один криптопровайдер во всём воркспейсе — aws-lc-rs, и он всегда выбирается явно (`builder_with_provider`); на провайдер процесса по умолчанию не полагаться.
- Порт по умолчанию 45710 (`markiro_proto::DEFAULT_PORT`), версия протокола 1, заголовок `x-markiro-protocol`.
- Отпечаток сертификата — SHA-256 от DER в нижнем регистре hex (`markiro_proto::certificate_fingerprint`).
- Тело ошибки — `{ "error": { "code": "<snake_case>", "message": "...", "details"?: {...} } }`.
- Каталог данных хоста: Windows — `%ProgramData%\Markiro\Host`, другие ОС — `./.markiro-host`; внутри `host.json`, `host.db`, `tls/cert.der`, `tls/key.der` (на Unix права `0600`), `logs/` (ежедневная ротация, 14 файлов).
- SQLite: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`; миграции — `sqlx::migrate!` из `host/migrations`; применённую миграцию не редактировать.
- Веб-интерфейс сам не делает HTTP-запросов; сеть — только через команды Rust.
- В журнале процесса нет ключей, токенов, кодов подключения, паролей, PIN, хешей и закрытого ключа TLS.
- Тексты интерфейса — только на русском через i18n (`ru.json`); отсутствующий ключ в тестах бросает исключение.
- npm-зависимости — только уже используемые в репозитории версии (как у `apps/station`), новых npm-пакетов нет.
- `apps/station` не меняется.
- Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения (не требования к коду)

- Песочница запрещает запись в `~/.cargo`: команду cargo, которая скачивает или распаковывает крейты («Operation not permitted» на путях `~/.cargo/registry`), повторить вне песочницы (`dangerouslyDisableSandbox: true`). Остальные команды — в песочнице; для сети индекса нужны домены `index.crates.io`, `static.crates.io`, `crates.io`.
- Каждую команду pnpm запускать с `--config.verifyDepsBeforeRun=false` сразу после `pnpm`, иначе pnpm в песочнице пытается переустановить `node_modules`. `pnpm install` (задача 4) — только вне песочницы.
- Не использовать `git stash`. Не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.

## Файлы

```
apps/standalone/
  .gitignore                       задача 1
  Cargo.toml, Cargo.lock           задача 1 (члены дополняются в задачах 2 и 5)
  proto/Cargo.toml, src/lib.rs, fixtures/*.json, tests/fixtures.rs      задача 1
  host/Cargo.toml, build.rs, migrations/0001_host_foundation.sql        задача 2
  host/src/{lib,config,tls,db}.rs, tests/foundation.rs                  задача 2
  host/src/{error,server,logging,service,main}.rs, tests/{hello.rs,support/mod.rs}  задача 3
  package.json, turbo.json, tsconfig.json, vite.config.ts, vitest.config.ts, index.html  задача 4
  src/main.tsx, src/i18n/{index.ts,ru.json}, src/host/{protocol,probe}.ts,
  src/app/{App.tsx,use-local-host.ts,fingerprint.ts,shell.css}, test/*  задача 4
  src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,icons/*}  задача 5
  src-tauri/src/{main,lib,host_probe}.rs, src-tauri/tests/host_probe.rs  задача 5
  AGENTS.md, README.md             задача 6
eslint.config.mjs, pnpm-lock.yaml  задача 4
.prettierignore                    задача 1
tools/ci/affected.mjs, tools/ci/test/{affected,workflow,required-results}.test.mjs,
.github/workflows/ci.yml, AGENTS.md  задача 6
```

---

### Task 1: Cargo-воркспейс и крейт протокола

**Files:**

- Create: `apps/standalone/.gitignore`, `apps/standalone/Cargo.toml`, `apps/standalone/proto/Cargo.toml`, `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/hello.json`, `apps/standalone/proto/fixtures/error-not-found.json`, `apps/standalone/proto/fixtures/error-with-details.json`, `apps/standalone/proto/tests/fixtures.rs`
- Create (генерирует cargo): `apps/standalone/Cargo.lock`
- Modify: `.prettierignore`

**Interfaces:**

- Produces: крейт `markiro-proto` с `PROTOCOL_VERSION: u32 = 1`, `MIN_PROTOCOL_VERSION: u32 = 1`, `PROTOCOL_HEADER = "x-markiro-protocol"`, `HOST_PRODUCT = "markiro-host"`, `DEFAULT_PORT: u16 = 45710`, модуль `codes` (`NOT_FOUND`, `PROTOCOL_UNSUPPORTED`, `INTERNAL`), `fn certificate_fingerprint(der: &[u8]) -> String`, структуры `Hello`, `ErrorBody`, `ErrorDetail`, `ErrorBody::new(code: &str, message: impl Into<String>)`.

- [ ] **Step 1: Создать `.gitignore` воркспейса и записи Prettier**

`apps/standalone/.gitignore`:

```gitignore
# Cargo workspace build output
/target/
# Tauri-generated capability schemas, regenerated on every build
/src-tauri/gen/schemas
# Development data directory of `markiro-host run`
/.markiro-host/
```

Добавить в конец `.prettierignore`:

```gitignore

# Rust build output, Tauri schemas and the dev host data directory of the
# standalone workspace: gitignored in apps/standalone/.gitignore, which
# Prettier does not read.
apps/standalone/target/
apps/standalone/src-tauri/gen/schemas/
apps/standalone/.markiro-host/
```

- [ ] **Step 2: Манифесты воркспейса и крейта**

`apps/standalone/Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["proto"]
```

`apps/standalone/proto/Cargo.toml`:

```toml
[package]
name = "markiro-proto"
version = "0.1.0"
description = "Wire contract between the Markiro standalone host and its devices"
edition = "2021"
license-file = "../../../LICENSE"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
```

- [ ] **Step 3: Фикстуры**

`apps/standalone/proto/fixtures/hello.json`:

```json
{
  "product": "markiro-host",
  "protocol": 1,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "0.1.0",
  "time": "2026-09-26T09:15:00Z",
  "initialized": false
}
```

`apps/standalone/proto/fixtures/error-not-found.json`:

```json
{
  "error": {
    "code": "not_found",
    "message": "no route for GET /v1/unknown"
  }
}
```

`apps/standalone/proto/fixtures/error-with-details.json`:

```json
{
  "error": {
    "code": "protocol_unsupported",
    "message": "protocol 7 is outside 1..=1",
    "details": { "protocol": 7, "minProtocol": 1, "maxProtocol": 1 }
  }
}
```

- [ ] **Step 4: Написать падающий тест**

`apps/standalone/proto/tests/fixtures.rs`:

```rust
use markiro_proto::{certificate_fingerprint, codes, ErrorBody, Hello, HOST_PRODUCT, PROTOCOL_VERSION};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// Deserialize into `T` and serialize back: the JSON must survive unchanged.
fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(serde_json::to_value(&typed).unwrap(), original, "{name} changed on round trip");
    typed
}

#[test]
fn hello_fixture_round_trips() {
    let hello: Hello = round_trip("hello.json");
    assert_eq!(hello.product, HOST_PRODUCT);
    assert_eq!(hello.protocol, PROTOCOL_VERSION);
}

#[test]
fn error_fixtures_round_trip() {
    let not_found: ErrorBody = round_trip("error-not-found.json");
    assert_eq!(not_found.error.code, codes::NOT_FOUND);
    assert!(not_found.error.details.is_none());
    let unsupported: ErrorBody = round_trip("error-with-details.json");
    assert_eq!(unsupported.error.code, codes::PROTOCOL_UNSUPPORTED);
}

#[test]
fn unknown_fields_are_rejected() {
    let mut value = fixture("hello.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<Hello>(value).is_err());
}

#[test]
fn fingerprint_is_lower_case_hex_sha256() {
    assert_eq!(
        certificate_fingerprint(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}
```

- [ ] **Step 5: Убедиться, что тест не собирается**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: FAIL — `unresolved import markiro_proto::...` (библиотеки ещё нет). Если cargo сообщает «Operation not permitted» на `~/.cargo`, повторить вне песочницы.

- [ ] **Step 6: Реализовать крейт**

`apps/standalone/proto/src/lib.rs`:

```rust
//! Wire contract between the Markiro standalone host (`markiro-host`) and the
//! devices that talk to it. Every request and response shape has a JSON
//! fixture in `fixtures/`: `tests/fixtures.rs` round-trips them here and
//! `apps/standalone/test/protocol.test.ts` parses the same files with the Zod
//! schemas, so a shape cannot change on one side only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
pub const PROTOCOL_HEADER: &str = "x-markiro-protocol";
/// `product` value the host reports in [`Hello`].
pub const HOST_PRODUCT: &str = "markiro-host";
/// Default TCP port of the host (IANA-unassigned range 45679-45823).
pub const DEFAULT_PORT: u16 = 45710;

/// Stable error codes of [`ErrorDetail::code`]; clients show text by code.
pub mod codes {
    pub const NOT_FOUND: &str = "not_found";
    pub const PROTOCOL_UNSUPPORTED: &str = "protocol_unsupported";
    pub const INTERNAL: &str = "internal";
}

/// Lower-case hex SHA-256 of a certificate's DER: the value devices pin and
/// the pairing payload carries.
pub fn certificate_fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `GET /v1/hello`: who answers, which protocol range it understands, and
/// whether the first-run wizard has completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub product: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub host_id: String,
    pub version: String,
    /// Host clock, UTC RFC 3339.
    pub time: String,
    pub initialized: bool,
}

/// Body of every non-2xx response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDetail {
    /// One of [`codes`].
    pub code: String,
    /// Diagnostic text for logs; never shown to a person.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            error: ErrorDetail { code: code.to_owned(), message: message.into(), details: None },
        }
    }
}
```

- [ ] **Step 7: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add .prettierignore apps/standalone/.gitignore apps/standalone/Cargo.toml apps/standalone/Cargo.lock apps/standalone/proto
git commit -m "feat(standalone): Cargo-воркспейс и крейт протокола" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Основа хоста — конфигурация, TLS, база

**Files:**

- Create: `apps/standalone/host/Cargo.toml`, `apps/standalone/host/build.rs`, `apps/standalone/host/migrations/0001_host_foundation.sql`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/config.rs`, `apps/standalone/host/src/tls.rs`, `apps/standalone/host/src/db.rs`, `apps/standalone/host/tests/foundation.rs`
- Modify: `apps/standalone/Cargo.toml` (член `host`), `apps/standalone/Cargo.lock`

**Interfaces:**

- Consumes: `markiro_proto::{DEFAULT_PORT, certificate_fingerprint}`.
- Produces:
  - `config::HostPaths { data_dir: PathBuf }` с `new(impl Into<PathBuf>)`, `default_data_dir() -> PathBuf`, `config_file()`, `database_file()`, `tls_dir()`, `logs_dir() -> PathBuf`, `ensure() -> Result<(), ConfigError>`;
  - `config::HostConfig { host_id: String, port: u16 }` с `load_or_create(&HostPaths, Option<u16>) -> Result<HostConfig, ConfigError>`;
  - `tls::TlsIdentity { cert_der: Vec<u8>, fingerprint: String, .. }` с `load_or_create(&Path, host_id: &str) -> Result<TlsIdentity, TlsError>` и `server_config() -> Result<Arc<rustls::ServerConfig>, TlsError>`;
  - `db::open(&Path) -> Result<SqlitePool, sqlx::Error>`, `db::is_initialized(&SqlitePool) -> Result<bool, sqlx::Error>`, `db::MIGRATOR`.

- [ ] **Step 1: Манифест, build-скрипт, миграция**

В `apps/standalone/Cargo.toml` заменить `members = ["proto"]` на `members = ["proto", "host"]`.

`apps/standalone/host/Cargo.toml`:

```toml
[package]
name = "markiro-host"
version = "0.1.0"
description = "Markiro standalone host: the LAN service with the master database"
edition = "2021"
license-file = "../../../LICENSE"
publish = false

[lib]
name = "markiro_host"
path = "src/lib.rs"

[dependencies]
markiro-proto = { path = "../proto" }
rcgen = { version = "=0.14.10", default-features = false, features = ["crypto", "aws_lc_rs"] }
rustls = { version = "=0.23.43", default-features = false, features = ["aws_lc_rs", "std", "tls12", "logging"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite", "migrate", "macros"] }
thiserror = "2"
tokio = { version = "=1.53.1", features = ["rt-multi-thread", "macros", "net", "signal", "sync", "time"] }
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"
```

`apps/standalone/host/build.rs`:

```rust
// `sqlx::migrate!` embeds host/migrations at compile time; rebuild when a
// migration is added or changed.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
```

`apps/standalone/host/migrations/0001_host_foundation.sql`:

```sql
-- Global revision counter of reference data. Every transaction that changes
-- a reference table bumps it and stamps the changed rows (plan 1c).
CREATE TABLE host_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL
);
INSERT INTO host_revision (id, rev) VALUES (1, 0);

-- Site-wide settings. `initialized_at` is set by the first-run wizard (plan 1b);
-- the badge salt is created there too.
CREATE TABLE site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  badge_salt BLOB,
  box_block_size INTEGER NOT NULL DEFAULT 2000 CHECK (box_block_size > 0),
  pallet_block_size INTEGER NOT NULL DEFAULT 200 CHECK (pallet_block_size > 0),
  initialized_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO site (id) VALUES (1);
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/host/tests/foundation.rs`:

```rust
use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::db;
use markiro_host::tls::TlsIdentity;

#[test]
fn host_id_persists_and_port_override_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let first = HostConfig::load_or_create(&paths, None).unwrap();
    assert_eq!(first.port, markiro_proto::DEFAULT_PORT);
    let second = HostConfig::load_or_create(&paths, Some(46000)).unwrap();
    assert_eq!(second.host_id, first.host_id);
    assert_eq!(second.port, 46000);
    let third = HostConfig::load_or_create(&paths, None).unwrap();
    assert_eq!(third.port, 46000);
}

#[test]
fn corrupt_config_is_reported_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    std::fs::write(paths.config_file(), b"{not json").unwrap();
    assert!(HostConfig::load_or_create(&paths, None).is_err());
    assert_eq!(std::fs::read(paths.config_file()).unwrap(), b"{not json");
}

#[test]
fn port_zero_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    assert!(HostConfig::load_or_create(&paths, Some(0)).is_err());
}

#[test]
fn tls_identity_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let first = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let second = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(first.fingerprint, markiro_proto::certificate_fingerprint(&first.cert_der));
    assert_eq!(first.fingerprint.len(), 64);
    first.server_config().unwrap();
}

#[test]
fn incomplete_tls_identity_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    std::fs::remove_file(dir.path().join("cert.der")).unwrap();
    assert!(TlsIdentity::load_or_create(dir.path(), "host-a").is_err());
}

#[cfg(unix)]
#[test]
fn private_key_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let mode = std::fs::metadata(dir.path().join("key.der")).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn debug_output_never_contains_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let identity = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let debug = format!("{identity:?}");
    assert!(debug.contains(&identity.fingerprint));
    assert!(!debug.contains("key"));
}

#[tokio::test]
async fn migrations_apply_once_and_site_starts_uninitialized() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.db");
    let pool = db::open(&path).await.unwrap();
    assert!(!db::is_initialized(&pool).await.unwrap());
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rev, 0);
    pool.close().await;

    let reopened = db::open(&path).await.unwrap();
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(applied, 1);
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode").fetch_one(&reopened).await.unwrap();
    assert_eq!(journal, "wal");
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&reopened).await.unwrap();
    assert_eq!(foreign_keys, 1);
}
```

- [ ] **Step 3: Убедиться, что тесты не собираются**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host`
Expected: FAIL — нет модулей `config`, `db`, `tls` (новые крейты при первой сборке скачиваются; при «Operation not permitted» на `~/.cargo` повторить вне песочницы).

- [ ] **Step 4: Реализовать модули**

`apps/standalone/host/src/lib.rs`:

```rust
//! Markiro standalone host library. The binary wires it into the command line
//! (plan 1a, task 3); tests use the modules directly.

pub mod config;
pub mod db;
pub mod tls;
```

`apps/standalone/host/src/config.rs`:

```rust
//! Host data directory layout and the persisted host identity (`host.json`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("host data {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("host config {path} is unreadable: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("host config {path}: {reason}")]
    Invalid { path: PathBuf, reason: String },
}

/// Every file the host owns lives under one data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    pub data_dir: PathBuf,
}

impl HostPaths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self { data_dir: data_dir.into() }
    }

    /// `%ProgramData%\Markiro\Host` on Windows; `./.markiro-host` elsewhere,
    /// which is for development only.
    pub fn default_data_dir() -> PathBuf {
        #[cfg(windows)]
        {
            if let Some(program_data) = std::env::var_os("ProgramData") {
                return PathBuf::from(program_data).join("Markiro").join("Host");
            }
        }
        PathBuf::from(".markiro-host")
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("host.json")
    }

    pub fn database_file(&self) -> PathBuf {
        self.data_dir.join("host.db")
    }

    pub fn tls_dir(&self) -> PathBuf {
        self.data_dir.join("tls")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    pub fn ensure(&self) -> Result<(), ConfigError> {
        for dir in [self.data_dir.clone(), self.tls_dir(), self.logs_dir()] {
            fs::create_dir_all(&dir).map_err(|source| ConfigError::Io { path: dir.clone(), source })?;
        }
        Ok(())
    }
}

/// Persisted identity and listening port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    pub host_id: String,
    pub port: u16,
}

impl HostConfig {
    /// Load `host.json`, creating it with a fresh host id and the default port
    /// on first start. `port_override` (`--port`) is persisted for the next
    /// start. A corrupt file is reported, never replaced.
    pub fn load_or_create(paths: &HostPaths, port_override: Option<u16>) -> Result<Self, ConfigError> {
        let path = paths.config_file();
        let mut config = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<HostConfig>(&text)
                .map_err(|source| ConfigError::Parse { path: path.clone(), source })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HostConfig {
                host_id: uuid::Uuid::new_v4().to_string(),
                port: markiro_proto::DEFAULT_PORT,
            },
            Err(source) => return Err(ConfigError::Io { path, source }),
        };
        if uuid::Uuid::parse_str(&config.host_id).is_err() {
            return Err(ConfigError::Invalid { path, reason: "hostId is not a UUID".into() });
        }
        if let Some(port) = port_override {
            config.port = port;
        }
        if config.port == 0 {
            return Err(ConfigError::Invalid { path, reason: "port must not be 0".into() });
        }
        let bytes = serde_json::to_vec_pretty(&config).expect("host config serializes");
        write_atomically(&path, &bytes)?;
        Ok(config)
    }
}

/// Write through a sibling temporary file and rename it over the target, so a
/// crash never leaves a half-written `host.json`.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    let io = |source: std::io::Error| ConfigError::Io { path: path.to_path_buf(), source };
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    {
        let mut file = fs::File::create(&tmp).map_err(io)?;
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
    }
    fs::rename(&tmp, path).map_err(io)
}
```

`apps/standalone/host/src/tls.rs`:

```rust
//! Self-signed TLS identity of the host. Devices pin the SHA-256 of the
//! certificate DER, so the names inside the certificate do not matter; the
//! file pair must survive restarts or every paired device loses trust.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("TLS file {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("only one of cert.der and key.der exists in {dir}; restore both or remove both")]
    Incomplete { dir: PathBuf },
    #[error("certificate generation failed: {0}")]
    Generate(String),
    #[error("TLS configuration rejected the host key: {0}")]
    Config(String),
}

pub struct TlsIdentity {
    pub cert_der: Vec<u8>,
    private_der: Vec<u8>,
    pub fingerprint: String,
}

impl std::fmt::Debug for TlsIdentity {
    // Prints only the fingerprint: the private key must never reach a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TlsIdentity")
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

impl TlsIdentity {
    pub fn load_or_create(tls_dir: &Path, host_id: &str) -> Result<Self, TlsError> {
        let cert_path = tls_dir.join("cert.der");
        let key_path = tls_dir.join("key.der");
        match (cert_path.exists(), key_path.exists()) {
            (true, true) => {
                let cert_der = read(&cert_path)?;
                let private_der = read(&key_path)?;
                let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
                Ok(Self { cert_der, private_der, fingerprint })
            }
            (false, false) => {
                let names = vec!["localhost".to_owned(), format!("markiro-host-{host_id}")];
                let certified = rcgen::generate_simple_self_signed(names)
                    .map_err(|error| TlsError::Generate(error.to_string()))?;
                let cert_der = certified.cert.der().to_vec();
                let private_der = certified.signing_key.serialize_der();
                write_private(&key_path, &private_der)?;
                write_file(&cert_path, &cert_der)?;
                let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
                Ok(Self { cert_der, private_der, fingerprint })
            }
            _ => Err(TlsError::Incomplete { dir: tls_dir.to_path_buf() }),
        }
    }

    /// Server configuration with the aws-lc-rs provider chosen explicitly: the
    /// workspace never relies on a process-wide default provider.
    pub fn server_config(&self) -> Result<Arc<rustls::ServerConfig>, TlsError> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| TlsError::Config(error.to_string()))?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.cert_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.private_der.clone())),
            )
            .map_err(|error| TlsError::Config(error.to_string()))?;
        Ok(Arc::new(config))
    }
}

fn read(path: &Path) -> Result<Vec<u8>, TlsError> {
    fs::read(path).map_err(|source| TlsError::Io { path: path.to_path_buf(), source })
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    fs::write(path, bytes).map_err(|source| TlsError::Io { path: path.to_path_buf(), source })
}

/// Owner-only on Unix. On Windows the file inherits the data directory's ACL;
/// the installer hardens that directory in stage 5.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let io = |source: std::io::Error| TlsError::Io { path: path.to_path_buf(), source };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(io)?;
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)
    }
    #[cfg(not(unix))]
    {
        write_file(path, bytes)
    }
}
```

Поле ключа в `rcgen 0.14` называется `signing_key` (`CertifiedKey<KeyPair>`), метод сертификата `der()`. Если компилятор сообщает другое имя, свериться с документацией закреплённой версии (`cargo doc -p rcgen --open` или исходники в `~/.cargo/registry/src`) и поправить только эти два обращения.

`apps/standalone/host/src/db.rs`:

```rust
//! Master database: SQLite in WAL mode, every transaction synced to disk.

use std::path::Path;
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

/// `host/migrations`, embedded at compile time. Applied migrations are never
/// edited: sqlx refuses to start when a checksum changes.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().max_connections(4).connect_with(options).await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// The first-run wizard has completed (`site.initialized_at` is set).
pub async fn is_initialized(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let initialized_at: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1").fetch_one(pool).await?;
    Ok(initialized_at.is_some())
}
```

- [ ] **Step 5: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host`
Expected: 8 passed (на Windows 7: тест прав ключа только для Unix).

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/Cargo.toml apps/standalone/Cargo.lock apps/standalone/host
git commit -m "feat(standalone): основа хоста — конфигурация, TLS-сертификат и база" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HTTPS-сервер, командная строка, журнал и точка входа службы

**Files:**

- Create: `apps/standalone/host/src/error.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/logging.rs`, `apps/standalone/host/src/service.rs`, `apps/standalone/host/src/main.rs`, `apps/standalone/host/tests/hello.rs`, `apps/standalone/host/tests/support/mod.rs`
- Modify: `apps/standalone/host/Cargo.toml`, `apps/standalone/host/src/lib.rs`, `apps/standalone/Cargo.lock`

**Interfaces:**

- Consumes: всё из задачи 2; `markiro_proto::{Hello, ErrorBody, codes, HOST_PRODUCT, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION}`.
- Produces (корень крейта `markiro_host`):
  - `pub type BoxError = Box<dyn std::error::Error + Send + Sync>;`
  - `#[derive(Debug, Clone, Copy, Default)] pub struct StartOptions { pub port_override: Option<u16>, pub bind: Option<SocketAddr> }`;
  - `pub struct RunningHost { pub addr: SocketAddr, pub fingerprint: String, pub host_id: String, .. }` с `pub async fn stop(self) -> Result<(), BoxError>`;
  - `pub async fn start(paths: &HostPaths, options: StartOptions) -> Result<RunningHost, BoxError>`;
  - `error::ApiError` (`new`, `not_found`, `internal`, `IntoResponse`), `server::{AppState, router, TlsListener, serve}`, `logging::init(&Path, also_stdout: bool)`.

- [ ] **Step 1: Зависимости**

В `apps/standalone/host/Cargo.toml` добавить после секции `[lib]`:

```toml
[[bin]]
name = "markiro-host"
path = "src/main.rs"
```

в `[dependencies]` добавить:

```toml
axum = "=0.8.9"
time = { version = "=0.3.55", features = ["formatting"] }
tokio-rustls = { version = "=0.26.4", default-features = false, features = ["aws_lc_rs", "logging", "tls12"] }
tracing = "0.1"
tracing-appender = "=0.2.5"
tracing-subscriber = "=0.3.23"
```

новую секцию:

```toml
[target.'cfg(windows)'.dependencies]
windows-service = "=0.8.1"
```

и в `[dev-dependencies]`:

```toml
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
```

- [ ] **Step 2: Написать падающие интеграционные тесты**

`apps/standalone/host/tests/support/mod.rs`:

```rust
//! HTTPS client that trusts exactly one certificate fingerprint, the way a
//! paired device will (plan 1c).

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

#[derive(Debug)]
struct PinnedVerifier {
    expected: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if markiro_proto::certificate_fingerprint(end_entity.as_ref()) == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("host certificate fingerprint mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn pinned_client(fingerprint: &str) -> reqwest::Client {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
            expected: fingerprint.to_owned(),
            provider,
        }))
        .with_no_client_auth();
    reqwest::Client::builder().use_preconfigured_tls(config).build().unwrap()
}
```

`apps/standalone/host/tests/hello.rs`:

```rust
mod support;

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};

async fn start_host(dir: &Path) -> RunningHost {
    let options = StartOptions { port_override: None, bind: Some("127.0.0.1:0".parse().unwrap()) };
    start(&HostPaths::new(dir), options).await.unwrap()
}

#[tokio::test]
async fn hello_answers_over_tls_with_the_pinned_certificate() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    let response = client.get(format!("https://{}/v1/hello", host.addr)).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    assert_eq!(hello.protocol, 1);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
    assert_eq!(hello.version, env!("CARGO_PKG_VERSION"));
    assert!(!hello.initialized);
    assert!(hello.time.ends_with('Z'), "{}", hello.time);
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_different_fingerprint_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&"0".repeat(64));
    assert!(client.get(format!("https://{}/v1/hello", host.addr)).send().await.is_err());
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn unknown_routes_return_the_protocol_error_body() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    let response = client.get(format!("https://{}/v1/unknown", host.addr)).send().await.unwrap();
    assert_eq!(response.status(), 404);
    let body: markiro_proto::ErrorBody = response.json().await.unwrap();
    assert_eq!(body.error.code, "not_found");
    assert_eq!(body.error.message, "no route for GET /v1/unknown");
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn plain_http_is_not_served() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    assert!(client.get(format!("http://{}/v1/hello", host.addr)).send().await.is_err());
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn restart_keeps_identity() {
    let dir = tempfile::tempdir().unwrap();
    let first = start_host(dir.path()).await;
    let (host_id, fingerprint) = (first.host_id.clone(), first.fingerprint.clone());
    first.stop().await.unwrap();
    let second = start_host(dir.path()).await;
    assert_eq!(second.host_id, host_id);
    assert_eq!(second.fingerprint, fingerprint);
    second.stop().await.unwrap();
}
```

- [ ] **Step 3: Убедиться, что тесты не собираются**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test hello`
Expected: FAIL — нет `start`, `RunningHost`, `StartOptions`.

- [ ] **Step 4: Реализовать ошибки, сервер и журнал**

`apps/standalone/host/src/error.rs`:

```rust
//! Error responses: an HTTP status plus the protocol's `ErrorBody`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{codes, ErrorBody};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self { status, body: ErrorBody::new(code, message) }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, codes::NOT_FOUND, message)
    }

    /// Logs the cause on the host; the client only learns that it failed.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "request failed");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, codes::INTERNAL, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}
```

`apps/standalone/host/src/server.rs`:

```rust
//! HTTPS server: router, TLS accept loop and graceful shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{Method, Uri};
use axum::routing::get;
use axum::{Json, Router};
use sqlx::SqlitePool;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::error::ApiError;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub host_id: String,
}

pub fn router(state: AppState) -> Router {
    Router::new().route("/v1/hello", get(hello)).fallback(not_found).with_state(state)
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let initialized = crate::db::is_initialized(&state.pool).await.map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
        min_protocol: markiro_proto::MIN_PROTOCOL_VERSION,
        host_id: state.host_id.clone(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: now_rfc3339(),
        initialized,
    }))
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .expect("zero nanoseconds is always valid")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting of a UTC time cannot fail")
}

/// Connections whose TLS handshake already completed. Handshakes run in their
/// own tasks, so one slow client cannot stall accepting the next.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    bound: SocketAddr,
}

impl TlsListener {
    pub async fn bind(addr: SocketAddr, tls: Arc<rustls::ServerConfig>) -> std::io::Result<Self> {
        let tcp = TcpListener::bind(addr).await?;
        let bound = tcp.local_addr()?;
        let (sender, connections) = mpsc::channel(64);
        let acceptor = TlsAcceptor::from(tls);
        tokio::spawn(async move {
            loop {
                // Stop accepting (and release the port) as soon as the
                // listener is dropped, without waiting for another client.
                let accepted = tokio::select! {
                    _ = sender.closed() => break,
                    accepted = tcp.accept() => accepted,
                };
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, "accepting a TCP connection failed");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        Ok(Ok(tls_stream)) => {
                            let _ = sender.send((tls_stream, peer)).await;
                        }
                        Ok(Err(error)) => tracing::debug!(%peer, %error, "TLS handshake failed"),
                        Err(_) => tracing::debug!(%peer, "TLS handshake timed out"),
                    }
                });
            }
        });
        Ok(Self { connections, bound })
    }

    /// The address actually bound (useful after binding port 0).
    pub fn bound_addr(&self) -> SocketAddr {
        self.bound
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.connections.recv().await {
            Some(connection) => connection,
            // The accept task outlives this listener, so this never happens.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.bound)
    }
}

/// Serve until `shutdown` resolves; open connections finish first.
pub async fn serve(
    listener: TlsListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await
}
```

`apps/standalone/host/src/logging.rs`:

```rust
//! Process log: daily-rotated files under `logs/` (14 kept), plus stdout for
//! console runs. Never log device keys, session tokens, pairing codes,
//! passwords, PINs, hashes or the TLS private key.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::prelude::*;

pub fn init(logs_dir: &Path, also_stdout: bool) -> Result<WorkerGuard, crate::BoxError> {
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("host")
        .filename_suffix("log")
        .max_log_files(14)
        .build(logs_dir)?;
    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let file_layer = tracing_subscriber::fmt::layer().with_ansi(false).with_writer(file_writer);
    let stdout_layer = also_stdout.then(tracing_subscriber::fmt::layer);
    tracing_subscriber::registry()
        .with(LevelFilter::INFO)
        .with(file_layer)
        .with(stdout_layer)
        .try_init()?;
    Ok(guard)
}
```

`apps/standalone/host/src/lib.rs` заменить целиком:

```rust
//! Markiro standalone host library. `src/main.rs` wires it into the
//! `run` / `service` / `print-fingerprint` commands; tests start it directly.

pub mod config;
pub mod db;
pub mod error;
pub mod logging;
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod tls;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use config::{HostConfig, HostPaths};
use sqlx::SqlitePool;
use tls::TlsIdentity;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How to start the host. The default listens on every interface at the
/// configured port; tests bind `127.0.0.1:0`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StartOptions {
    /// `--port`; persisted into `host.json`.
    pub port_override: Option<u16>,
    /// Exact bind address; `None` means `0.0.0.0:<configured port>`.
    pub bind: Option<SocketAddr>,
}

/// A started host; `stop` shuts it down gracefully and closes the database.
pub struct RunningHost {
    pub addr: SocketAddr,
    pub fingerprint: String,
    pub host_id: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    pool: SqlitePool,
}

impl RunningHost {
    pub async fn stop(self) -> Result<(), BoxError> {
        let _ = self.shutdown.send(());
        self.task.await??;
        self.pool.close().await;
        tracing::info!("markiro-host stopped");
        Ok(())
    }
}

/// Open everything under `paths` and start serving.
pub async fn start(paths: &HostPaths, options: StartOptions) -> Result<RunningHost, BoxError> {
    paths.ensure()?;
    let config = HostConfig::load_or_create(paths, options.port_override)?;
    let pool = db::open(&paths.database_file()).await?;
    let identity = TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id)?;
    let bind = options
        .bind
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port));
    let listener = server::TlsListener::bind(bind, identity.server_config()?).await?;
    let addr = listener.bound_addr();
    let (shutdown, shutdown_signal) = tokio::sync::oneshot::channel::<()>();
    let state = server::AppState { pool: pool.clone(), host_id: config.host_id.clone() };
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = shutdown_signal.await;
    }));
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        %addr,
        fingerprint = %identity.fingerprint,
        host_id = %config.host_id,
        "markiro-host listening"
    );
    Ok(RunningHost {
        addr,
        fingerprint: identity.fingerprint.clone(),
        host_id: config.host_id,
        shutdown,
        task,
        pool,
    })
}
```

- [ ] **Step 5: Командная строка и служба Windows**

`apps/standalone/host/src/main.rs`:

```rust
//! `markiro-host` command line:
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint

use std::path::PathBuf;
use std::process::ExitCode;

use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::{BoxError, StartOptions};

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run { data_dir: PathBuf, port: Option<u16> },
    Service,
    PrintFingerprint { data_dir: PathBuf },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    let mut data_dir = None;
    let mut port = None;
    let mut index = 0;
    while index < rest.len() {
        let value = rest.get(index + 1);
        match rest[index].as_str() {
            "--data-dir" => {
                data_dir = Some(PathBuf::from(value.ok_or("--data-dir needs a path")?));
            }
            "--port" => {
                let text = value.ok_or("--port needs a number")?;
                port = Some(text.parse::<u16>().map_err(|_| "--port must be 1-65535")?);
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
        index += 2;
    }
    match command.as_str() {
        "run" => Ok(Command::Run {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
            port,
        }),
        "service" if rest.is_empty() => Ok(Command::Service),
        "print-fingerprint" if port.is_none() => Ok(Command::PrintFingerprint {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
        }),
        _ => Err(USAGE.to_owned()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let result = match command {
        Command::Run { data_dir, port } => run_foreground(data_dir, port),
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("markiro-host: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_foreground(data_dir: PathBuf, port: Option<u16>) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    paths.ensure()?;
    let _log_guard = markiro_host::logging::init(&paths.logs_dir(), true)?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let host = markiro_host::start(&paths, StartOptions { port_override: port, bind: None }).await?;
        let _ = tokio::signal::ctrl_c().await;
        host.stop().await
    })
}

#[cfg(windows)]
fn run_service() -> Result<(), BoxError> {
    markiro_host::service::dispatch()
}

#[cfg(not(windows))]
fn run_service() -> Result<(), BoxError> {
    Err("the service command is only available on Windows".into())
}

fn print_fingerprint(data_dir: PathBuf) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    paths.ensure()?;
    let config = HostConfig::load_or_create(&paths, None)?;
    let identity = markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id)?;
    println!("{}", identity.fingerprint);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn run_accepts_a_data_dir_and_a_port() {
        assert_eq!(
            parse(&args(&["run", "--data-dir", "/tmp/h", "--port", "46000"])),
            Ok(Command::Run { data_dir: PathBuf::from("/tmp/h"), port: Some(46000) })
        );
    }

    #[test]
    fn invalid_invocations_are_rejected() {
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["run", "--port", "70000"])).is_err());
        assert!(parse(&args(&["run", "--verbose"])).is_err());
        assert!(parse(&args(&["service", "--port", "1"])).is_err());
        assert!(parse(&args(&["print-fingerprint", "--port", "1"])).is_err());
        assert!(parse(&args(&["serve"])).is_err());
    }
}
```

`apps/standalone/host/src/service.rs`:

```rust
//! Windows service entry point. The installer registers `MarkiroHost` in
//! stage 5; this module only answers the service manager.

use std::ffi::OsString;
use std::sync::mpsc;
use std::time::Duration;

use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::config::HostPaths;
use crate::{BoxError, StartOptions};

pub const SERVICE_NAME: &str = "MarkiroHost";

define_windows_service!(ffi_service_main, service_main);

pub fn dispatch() -> Result<(), BoxError> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run() {
        tracing::error!(%error, "markiro-host service failed");
    }
}

fn status(state: ServiceState, accept: ServiceControlAccept) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    }
}

fn run() -> Result<(), BoxError> {
    let (stop_sender, stop_receiver) = mpsc::channel::<()>();
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_sender.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    handle.set_service_status(status(ServiceState::StartPending, ServiceControlAccept::empty()))?;

    let paths = HostPaths::new(HostPaths::default_data_dir());
    paths.ensure()?;
    let _log_guard = crate::logging::init(&paths.logs_dir(), false)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        let host = crate::start(&paths, StartOptions::default()).await?;
        handle.set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ))?;
        let _ = tokio::task::spawn_blocking(move || stop_receiver.recv()).await;
        host.stop().await
    });
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))?;
    result
}
```

Модуль службы компилируется только на Windows. На macOS и Linux его проверяет задание `standalone-windows-build` (задача 6); локально на Windows — `cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-host`.

- [ ] **Step 6: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host`
Expected: все тесты PASS — 8 из `foundation.rs`, 5 из `hello.rs`, 2 модульных теста командной строки.

Если `axum::serve` не принимает `TlsListener` из-за сигнатуры трейта `Listener` в закреплённой версии, свериться с `axum::serve::Listener` в исходниках axum 0.8.9 и поправить только реализацию трейта; поведение (рукопожатие в отдельной задаче, адрес пира как `SocketAddr`) не менять.

- [ ] **Step 7: Проверить запуск вручную**

Run:

```bash
cargo run --manifest-path apps/standalone/Cargo.toml -p markiro-host -- print-fingerprint --data-dir "$TMPDIR/markiro-host-manual"
cargo run --manifest-path apps/standalone/Cargo.toml -p markiro-host -- print-fingerprint --data-dir "$TMPDIR/markiro-host-manual"
```

Expected: оба раза одна и та же строка из 64 символов hex. Каталог `$TMPDIR/markiro-host-manual` после проверки удалить.

- [ ] **Step 8: Commit**

```bash
git add apps/standalone/Cargo.lock apps/standalone/host
git commit -m "feat(standalone): HTTPS-сервер хоста, командная строка и точка входа службы" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Веб-интерфейс — пакет, поиск хоста, экран оболочки

**Files:**

- Create: `apps/standalone/package.json`, `apps/standalone/turbo.json`, `apps/standalone/tsconfig.json`, `apps/standalone/vite.config.ts`, `apps/standalone/vitest.config.ts`, `apps/standalone/index.html`, `apps/standalone/src/main.tsx`, `apps/standalone/src/i18n/index.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/probe.ts`, `apps/standalone/src/app/fingerprint.ts`, `apps/standalone/src/app/use-local-host.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/test/setup.ts`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/probe.test.ts`, `apps/standalone/test/fingerprint.test.ts`, `apps/standalone/test/app.test.tsx`
- Modify: `eslint.config.mjs`, `pnpm-lock.yaml` (через pnpm)

**Interfaces:**

- Consumes: фикстуры `apps/standalone/proto/fixtures/*.json` (задача 1); команда Rust `host_hello(address)` (появится в задаче 5; в тестах подменяется).
- Produces:
  - `src/host/protocol.ts`: `PROTOCOL_VERSION = 1`, `DEFAULT_HOST_PORT = 45710`, `LOCAL_HOST_ADDRESS = "https://127.0.0.1:45710"`, `helloSchema`, `type Hello`, `errorBodySchema`, `type ErrorBody`;
  - `src/host/probe.ts`: `type HostProbeErrorCode = "unreachable" | "not_markiro_host" | "invalid_response"`, `class HostProbeError { code }`, `interface HelloObservation { hello: Hello; fingerprint: string }`, `interface HostProbe { hello(address: string): Promise<HelloObservation> }`, `createTauriHostProbe(call?)`;
  - `src/app/fingerprint.ts`: `formatFingerprint(hex: string): string`;
  - `src/app/use-local-host.ts`: `type LocalHostState`, `useLocalHost(probe, address)`;
  - `src/app/App.tsx`: `App({ probe?, address? })`.

- [ ] **Step 1: Файлы пакета**

`apps/standalone/package.json`:

```json
{
  "name": "@markiro/standalone",
  "version": "0.1.0",
  "private": true,
  "license": "SEE LICENSE IN LICENSE",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "lint": "eslint . --ignore-pattern 'target/**' --ignore-pattern 'src-tauri/gen/**' --ignore-pattern '.markiro-host/**'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "@markiro/ui": "workspace:*",
    "@tauri-apps/api": "2.11.1",
    "i18next": "26.3.6",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-i18next": "17.0.11",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.4",
    "@testing-library/react": "16.3.2",
    "@types/node": "26.2.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "29.1.1",
    "typescript": "6.0.3",
    "vite": "8.2.1",
    "vitest": "4.1.11"
  }
}
```

`apps/standalone/turbo.json`:

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "extends": ["//"]
}
```

`apps/standalone/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // Vite-bundled app, same deviation from the NodeNext base as apps/station:
    // "bundler" resolution, JSON imports without attributes, vite/client types.
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals"],
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/standalone/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built webview from `dist/`. `clearScreen: false` keeps the
// Rust compiler output visible during `tauri dev`; the port is fixed so
// `devUrl` in src-tauri/tauri.conf.json matches. Unlike the cloud station there
// is no build-time API URL: the host is found at run time.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5274, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
```

`apps/standalone/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
```

`apps/standalone/index.html`:

```html
<!doctype html>
<html lang="ru" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Markiro Автоном</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

В `eslint.config.mjs` в строке `files: ["apps/{admin,kiosk,signer,station}/**/*.{ts,tsx}", "packages/{email,ui}/**/*.{ts,tsx}"],` заменить `apps/{admin,kiosk,signer,station}` на `apps/{admin,kiosk,signer,standalone,station}`.

- [ ] **Step 2: Обновить lockfile**

Run (вне песочницы: pnpm пишет в глобальное хранилище `~/Library/pnpm/store`):

```bash
pnpm install --prefer-offline
git diff --stat pnpm-lock.yaml
```

Expected: в `pnpm-lock.yaml` добавлен только импортёр `apps/standalone` со ссылками на уже существующие версии; новых записей в `packages:` нет. Если pnpm предлагает новые версии или трогает другие импортёры — остановиться и сообщить (NEEDS_CONTEXT).

- [ ] **Step 3: Написать падающие тесты**

`apps/standalone/test/setup.ts`:

```ts
// Initializes the i18next singleton (RU resources, missing key throws in test
// mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";
```

`apps/standalone/test/protocol.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { errorBodySchema, helloSchema } from "../src/host/protocol.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("protocol schemas parse the shared Rust fixtures", () => {
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: 1,
      initialized: false,
    });
  });

  it("error bodies", () => {
    expect(errorBodySchema.parse(fixture("error-not-found.json")).error.code).toBe("not_found");
    expect(errorBodySchema.parse(fixture("error-with-details.json")).error.details).toEqual({
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 1,
    });
  });

  it("rejects unknown fields, like serde's deny_unknown_fields", () => {
    const hello = { ...(fixture("hello.json") as Record<string, unknown>), extra: true };
    expect(helloSchema.safeParse(hello).success).toBe(false);
  });
});
```

`apps/standalone/test/probe.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createTauriHostProbe, HostProbeError } from "../src/host/probe.js";

const RAW = {
  hello: {
    product: "markiro-host",
    protocol: 1,
    minProtocol: 1,
    hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    version: "0.1.0",
    time: "2026-09-26T09:15:00Z",
    initialized: false,
  },
  fingerprint: "0f".repeat(32),
};

describe("Tauri host probe", () => {
  it("asks the Rust shell for hello at the address and validates the answer", async () => {
    const call = vi.fn().mockResolvedValue(RAW);
    await expect(createTauriHostProbe(call).hello("https://127.0.0.1:45710")).resolves.toEqual(RAW);
    expect(call).toHaveBeenCalledWith("host_hello", { address: "https://127.0.0.1:45710" });
  });

  it.each(["unreachable", "not_markiro_host", "invalid_response"] as const)(
    "keeps the shell's %s code",
    async (code) => {
      const call = vi.fn().mockRejectedValue(code);
      await expect(createTauriHostProbe(call).hello("https://h")).rejects.toMatchObject({ code });
    },
  );

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(createTauriHostProbe(call).hello("https://h")).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("rejects a malformed answer", async () => {
    const call = vi.fn().mockResolvedValue({ ...RAW, fingerprint: "XYZ" });
    const error: unknown = await createTauriHostProbe(call)
      .hello("https://h")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostProbeError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });
});
```

`apps/standalone/test/fingerprint.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatFingerprint } from "../src/app/fingerprint.js";

describe("formatFingerprint", () => {
  it("shows the first 32 hex characters in eight upper-case groups of four", () => {
    expect(formatFingerprint("0123456789abcdef".repeat(4))).toBe(
      "0123 4567 89AB CDEF 0123 4567 89AB CDEF",
    );
  });
});
```

`apps/standalone/test/app.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";

const OBSERVATION: HelloObservation = {
  hello: {
    product: "markiro-host",
    protocol: 1,
    minProtocol: 1,
    hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    version: "0.1.0",
    time: "2026-09-26T09:15:00Z",
    initialized: false,
  },
  fingerprint: "ab".repeat(32),
};

describe("App shell", () => {
  it("explains a missing host and finds it after a retry", async () => {
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockRejectedValueOnce(new HostProbeError("unreachable", "down"))
      .mockResolvedValueOnce(OBSERVATION);
    render(<App probe={{ hello }} address="https://127.0.0.1:45710" />);

    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
    expect(screen.getByText("Нет соединения.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));

    expect(await screen.findByText("Служба хоста найдена")).toBeTruthy();
    expect(screen.getByTestId("host-fingerprint").textContent).toBe(
      "ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB",
    );
    expect(screen.getByText(/Хост ещё не настроен/)).toBeTruthy();
    expect(hello).toHaveBeenCalledTimes(2);
    expect(hello).toHaveBeenCalledWith("https://127.0.0.1:45710");
  });

  it("names a foreign service instead of a missing one", async () => {
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockRejectedValue(new HostProbeError("not_markiro_host", "foreign"));
    render(<App probe={{ hello }} />);
    expect(await screen.findByText("По этому адресу отвечает не служба Markiro.")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Убедиться, что тесты падают**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
```

Expected: FAIL — модулей `src/host/*`, `src/app/*`, `src/i18n/*` ещё нет.

- [ ] **Step 5: Реализовать**

`apps/standalone/src/i18n/index.ts`:

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import ru from "./ru.json";

/** Russian only in the first version; every string still goes through i18n. */
export const SUPPORTED_LANGUAGES = ["ru"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const isTestEnv = import.meta.env.MODE === "test";

// A missing key must fail tests loudly rather than render the raw key.
// Spread conditionally: `exactOptionalPropertyTypes` rejects an explicit
// `undefined` for i18next's `missingKeyHandler`.
const missingKeyOptions = isTestEnv
  ? {
      saveMissing: true,
      missingKeyHandler: (languages: readonly string[], namespace: string, key: string) => {
        throw new Error(`Missing i18n key: ${namespace}:${key} (${languages.join(", ")})`);
      },
    }
  : {};

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  ...missingKeyOptions,
});

export default i18n;
```

`apps/standalone/src/i18n/ru.json`:

```json
{
  "shell": {
    "probing": "Ищем службу хоста на этом компьютере…",
    "hostMissing": {
      "title": "Служба хоста не отвечает",
      "body": "Служба «Markiro Хост» не отвечает по адресу {{address}}. Проверьте, что она запущена на этом компьютере.",
      "unreachable": "Нет соединения.",
      "notHost": "По этому адресу отвечает не служба Markiro.",
      "invalidResponse": "Служба ответила в неожиданном формате.",
      "retry": "Проверить снова"
    },
    "hostFound": {
      "title": "Служба хоста найдена",
      "version": "Версия службы: {{version}}",
      "fingerprint": "Отпечаток сертификата",
      "uninitialized": "Хост ещё не настроен. Мастер первого запуска ещё не реализован.",
      "initialized": "Хост настроен. Подключение станции ещё не реализовано."
    }
  }
}
```

`apps/standalone/src/host/protocol.ts`:

```ts
import { z } from "zod";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 1;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
export const LOCAL_HOST_ADDRESS = `https://127.0.0.1:${DEFAULT_HOST_PORT}`;

/** Mirrors `markiro_proto::Hello`; `.strict()` matches `deny_unknown_fields`. */
export const helloSchema = z
  .object({
    product: z.literal("markiro-host"),
    protocol: z.number().int().positive(),
    minProtocol: z.number().int().positive(),
    hostId: z.uuid(),
    version: z.string().min(1),
    time: z.iso.datetime(),
    initialized: z.boolean(),
  })
  .strict();
export type Hello = z.infer<typeof helloSchema>;

/** Mirrors `markiro_proto::ErrorBody`. */
export const errorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorBody = z.infer<typeof errorBodySchema>;
```

`apps/standalone/src/host/probe.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { helloSchema, type Hello } from "./protocol.js";

export type HostProbeErrorCode = "unreachable" | "not_markiro_host" | "invalid_response";

const ERROR_CODES: readonly HostProbeErrorCode[] = [
  "unreachable",
  "not_markiro_host",
  "invalid_response",
];

export class HostProbeError extends Error {
  readonly code: HostProbeErrorCode;

  constructor(code: HostProbeErrorCode, message: string) {
    super(message);
    this.name = "HostProbeError";
    this.code = code;
  }
}

export interface HelloObservation {
  hello: Hello;
  /** Lower-case hex SHA-256 of the certificate the host presented. */
  fingerprint: string;
}

export interface HostProbe {
  hello(address: string): Promise<HelloObservation>;
}

const observationSchema = z
  .object({ hello: helloSchema, fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Asks the Rust shell to fetch `/v1/hello`: the webview never performs HTTP
 * itself. The shell rejects with one of the `HostProbeErrorCode` strings.
 */
export function createTauriHostProbe(call: Invoke = invoke): HostProbe {
  return {
    async hello(address) {
      let raw: unknown;
      try {
        raw = await call("host_hello", { address });
      } catch (error) {
        const code = ERROR_CODES.find((candidate) => candidate === error) ?? "unreachable";
        throw new HostProbeError(code, `host_hello failed: ${String(error)}`);
      }
      const parsed = observationSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HostProbeError("invalid_response", parsed.error.message);
      }
      return parsed.data;
    },
  };
}
```

`apps/standalone/src/app/fingerprint.ts`:

```ts
/**
 * Fingerprint for visual comparison with the office screen: the first 32 hex
 * characters of the SHA-256, upper-cased, in eight groups of four.
 */
export function formatFingerprint(hex: string): string {
  return (
    hex
      .slice(0, 32)
      .toUpperCase()
      .match(/.{1,4}/g) ?? []
  ).join(" ");
}
```

`apps/standalone/src/app/use-local-host.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

import {
  HostProbeError,
  type HelloObservation,
  type HostProbe,
  type HostProbeErrorCode,
} from "../host/probe.js";

export type LocalHostState =
  | { kind: "probing" }
  | { kind: "missing"; reason: HostProbeErrorCode }
  | { kind: "found"; observation: HelloObservation };

/** Probes `address` once per attempt; `retry` starts a new attempt. */
export function useLocalHost(probe: HostProbe, address: string) {
  const [state, setState] = useState<LocalHostState>({ kind: "probing" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    probe.hello(address).then(
      (observation) => {
        if (!cancelled) setState({ kind: "found", observation });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "missing",
            reason: error instanceof HostProbeError ? error.code : "unreachable",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [probe, address, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "probing" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
```

`apps/standalone/src/app/App.tsx`:

```tsx
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import { createTauriHostProbe, type HostProbe } from "../host/probe.js";
import { LOCAL_HOST_ADDRESS } from "../host/protocol.js";
import { formatFingerprint } from "./fingerprint.js";
import { useLocalHost } from "./use-local-host.js";

export interface AppProps {
  probe?: HostProbe;
  address?: string;
}

const REASON_KEY = {
  unreachable: "shell.hostMissing.unreachable",
  not_markiro_host: "shell.hostMissing.notHost",
  invalid_response: "shell.hostMissing.invalidResponse",
} as const;

export function App({ probe, address = LOCAL_HOST_ADDRESS }: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const { state, retry } = useLocalHost(hostProbe, address);

  return (
    <main className="standalone-screen">
      {state.kind === "probing" && (
        <div className="standalone-probing" role="status">
          <Spinner size={32} />
          <p>{t("shell.probing")}</p>
        </div>
      )}
      {state.kind === "missing" && (
        <Card className="standalone-card" title={t("shell.hostMissing.title")} titleAs="h2">
          <p>{t("shell.hostMissing.body", { address })}</p>
          <Alert tone="warn">{t(REASON_KEY[state.reason])}</Alert>
          <Button onClick={retry}>{t("shell.hostMissing.retry")}</Button>
        </Card>
      )}
      {state.kind === "found" && (
        <Card className="standalone-card" title={t("shell.hostFound.title")} titleAs="h2">
          <p>{t("shell.hostFound.version", { version: state.observation.hello.version })}</p>
          <p className="standalone-fingerprint-label">{t("shell.hostFound.fingerprint")}</p>
          <p className="standalone-fingerprint" data-testid="host-fingerprint">
            {formatFingerprint(state.observation.fingerprint)}
          </p>
          <Alert tone="info">
            {t(
              state.observation.hello.initialized
                ? "shell.hostFound.initialized"
                : "shell.hostFound.uninitialized",
            )}
          </Alert>
        </Card>
      )}
    </main>
  );
}
```

`apps/standalone/src/app/shell.css`:

```css
/* Standalone shell layout; colours and type come from @markiro/ui tokens. */
.standalone-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--surface-page);
  color: var(--fg-1);
  font-family: var(--font-ui);
}

.standalone-card {
  width: min(560px, 100%);
}

.standalone-card p {
  margin: 0 0 16px;
}

.standalone-probing {
  display: grid;
  justify-items: center;
  gap: 16px;
}

.standalone-fingerprint-label {
  color: var(--fg-2);
}

.standalone-fingerprint {
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
}
```

`apps/standalone/src/main.tsx`:

```tsx
import "@markiro/ui/styles.css";
import "./app/shell.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./app/App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

// The floor is dark (design brief 02/04); office screens will share this
// provider and switch the theme from their header.
createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Проверки пакета**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
node_modules/.bin/prettier --check apps/standalone eslint.config.mjs
```

Expected: 4 файла тестов PASS, typecheck/lint/build без ошибок, `apps/standalone/dist/index.html` создан, Prettier без замечаний.

- [ ] **Step 7: Commit**

```bash
git add eslint.config.mjs pnpm-lock.yaml apps/standalone/package.json apps/standalone/turbo.json apps/standalone/tsconfig.json apps/standalone/vite.config.ts apps/standalone/vitest.config.ts apps/standalone/index.html apps/standalone/src apps/standalone/test
git commit -m "feat(standalone): веб-оболочка — поиск хоста на этом ПК" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Оболочка Tauri и команда `host_hello`

**Files:**

- Create: `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/src-tauri/build.rs`, `apps/standalone/src-tauri/tauri.conf.json`, `apps/standalone/src-tauri/capabilities/default.json`, `apps/standalone/src-tauri/icons/*` (копия `apps/station/src-tauri/icons/*`), `apps/standalone/src-tauri/src/main.rs`, `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/src/host_probe.rs`, `apps/standalone/src-tauri/tests/host_probe.rs`
- Modify: `apps/standalone/Cargo.toml` (член `src-tauri`), `apps/standalone/Cargo.lock`

**Interfaces:**

- Consumes: `markiro_proto::{Hello, HOST_PRODUCT, PROTOCOL_HEADER, PROTOCOL_VERSION, certificate_fingerprint}`; `markiro_host::{start, StartOptions, RunningHost, config::HostPaths}` (только в тестах); собранный веб-интерфейс `apps/standalone/dist` (задача 4).
- Produces: команда Tauri `host_hello(address: String) -> Result<HelloObservation, String>`, где ошибка — одна из строк `unreachable`, `not_markiro_host`, `invalid_response` (их ждёт `src/host/probe.ts`); `host_probe::{observe_hello, HelloObservation, ProbeError}`.

- [ ] **Step 1: Манифест, конфигурация, иконки**

В `apps/standalone/Cargo.toml` заменить `members = ["proto", "host"]` на `members = ["proto", "host", "src-tauri"]`.

`apps/standalone/src-tauri/Cargo.toml`:

```toml
[package]
name = "markiro-standalone"
version = "0.1.0"
description = "Markiro standalone station and office"
edition = "2021"
license-file = "../../../LICENSE"
publish = false

[lib]
name = "markiro_standalone_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
markiro-proto = { path = "../proto" }
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
rustls = { version = "=0.23.43", default-features = false, features = ["aws_lc_rs", "std", "tls12", "logging"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2.11", features = [] }
tauri-plugin-single-instance = "2"

[dev-dependencies]
markiro-host = { path = "../host" }
tempfile = "3"
tokio = { version = "=1.53.1", features = ["macros", "rt-multi-thread"] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

`apps/standalone/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

`apps/standalone/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Markiro Standalone",
  "version": "0.1.0",
  "identifier": "app.markiro.standalone",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5274",
    "beforeDevCommand": "pnpm --filter @markiro/standalone dev",
    "beforeBuildCommand": "pnpm --filter @markiro/standalone build"
  },
  "app": {
    "windows": [
      {
        "title": "Markiro Автоном",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "nsis": {
        "installerIcon": "icons/icon.ico"
      }
    }
  }
}
```

`apps/standalone/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Standalone webview capabilities",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

Run: `mkdir -p apps/standalone/src-tauri/icons && cp apps/station/src-tauri/icons/* apps/standalone/src-tauri/icons/`

- [ ] **Step 2: Написать падающий тест**

`apps/standalone/src-tauri/tests/host_probe.rs`:

```rust
use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use markiro_standalone_lib::host_probe::{observe_hello, ProbeError};

#[tokio::test]
async fn observes_the_host_and_the_certificate_it_presents() {
    let dir = tempfile::tempdir().unwrap();
    let options = StartOptions { port_override: None, bind: Some("127.0.0.1:0".parse().unwrap()) };
    let host = start(&HostPaths::new(dir.path()), options).await.unwrap();

    let observation = observe_hello(&format!("https://{}", host.addr)).await.unwrap();
    assert_eq!(observation.fingerprint, host.fingerprint);
    assert_eq!(observation.hello.host_id, host.host_id);
    assert!(!observation.hello.initialized);

    host.stop().await.unwrap();
}

#[tokio::test]
async fn nothing_listening_is_unreachable() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let result = observe_hello(&format!("https://127.0.0.1:{port}")).await;
    assert_eq!(result.map(|observation| observation.fingerprint), Err(ProbeError::Unreachable));
}
```

- [ ] **Step 3: Убедиться, что тест не собирается**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone`
Expected: FAIL — нет `markiro_standalone_lib::host_probe`. Сборке нужен `apps/standalone/dist` из задачи 4; если его нет — `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.

- [ ] **Step 4: Реализовать**

`apps/standalone/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markiro_standalone_lib::run();
}
```

`apps/standalone/src-tauri/src/lib.rs`:

```rust
//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks stay in Rust.

pub mod host_probe;

#[tauri::command]
async fn host_hello(address: String) -> Result<host_probe::HelloObservation, String> {
    host_probe::observe_hello(&address).await.map_err(|error| error.code().to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .invoke_handler(tauri::generate_handler![host_hello])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
```

`apps/standalone/src-tauri/src/host_probe.rs`:

```rust
//! `GET /v1/hello` against an address whose certificate is not pinned yet.
//! The verifier accepts any certificate and records its fingerprint, so this
//! module only *discovers* a host: the fingerprint is shown to a person or
//! compared with a scanned pairing code before anything is trusted.
//! Authenticated requests use a pinning verifier (plan 1c).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::{Hello, HOST_PRODUCT, PROTOCOL_HEADER, PROTOCOL_VERSION};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloObservation {
    pub hello: Hello,
    /// Lower-case hex SHA-256 of the certificate the host presented.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    /// Nothing answered, or the TLS handshake failed.
    Unreachable,
    /// Something answered, but it is not a Markiro host.
    NotMarkiroHost,
    /// A Markiro host answered with a body this build cannot read.
    InvalidResponse,
}

impl ProbeError {
    /// Stable codes the webview maps to text (`src/host/probe.ts`).
    pub fn code(self) -> &'static str {
        match self {
            ProbeError::Unreachable => "unreachable",
            ProbeError::NotMarkiroHost => "not_markiro_host",
            ProbeError::InvalidResponse => "invalid_response",
        }
    }
}

pub async fn observe_hello(address: &str) -> Result<HelloObservation, ProbeError> {
    let seen = Arc::new(Mutex::new(None::<String>));
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| ProbeError::Unreachable)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ObservingVerifier { seen: seen.clone(), provider }))
        .with_no_client_auth();
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| ProbeError::Unreachable)?;
    let response = client
        .get(format!("{}/v1/hello", address.trim_end_matches('/')))
        .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
        .send()
        .await
        .map_err(|_| ProbeError::Unreachable)?;
    if !response.status().is_success() {
        return Err(ProbeError::NotMarkiroHost);
    }
    let body: serde_json::Value = response.json().await.map_err(|_| ProbeError::NotMarkiroHost)?;
    if body.get("product").and_then(serde_json::Value::as_str) != Some(HOST_PRODUCT) {
        return Err(ProbeError::NotMarkiroHost);
    }
    let hello: Hello = serde_json::from_value(body).map_err(|_| ProbeError::InvalidResponse)?;
    let fingerprint = seen.lock().expect("fingerprint lock").clone().ok_or(ProbeError::Unreachable)?;
    Ok(HelloObservation { hello, fingerprint })
}

#[derive(Debug)]
struct ObservingVerifier {
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for ObservingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = markiro_proto::certificate_fingerprint(end_entity.as_ref());
        *self.seen.lock().expect("fingerprint lock") = Some(fingerprint);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}
```

- [ ] **Step 5: Тесты проходят, весь воркспейс собирается**

Run:

```bash
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone
cargo test --manifest-path apps/standalone/Cargo.toml --workspace
```

Expected: 2 теста оболочки PASS; во всём воркспейсе все тесты PASS.

- [ ] **Step 6: Проверить вручную связку хост + приложение (macOS/Linux, без киоск-режима)**

В одном терминале: `cargo run --manifest-path apps/standalone/Cargo.toml -p markiro-host -- run --data-dir apps/standalone/.markiro-host`. В другом: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone tauri dev`. Ожидается окно «Служба хоста найдена» с версией 0.1.0 и тем же отпечатком (первые 32 символа), что печатает `print-fingerprint --data-dir apps/standalone/.markiro-host`. Остановить хост и нажать «Проверить снова» — экран «Служба хоста не отвечает». Если окно запустить нельзя (нет графической сессии), записать это в отчёт как невыполненную ручную проверку.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/Cargo.toml apps/standalone/Cargo.lock apps/standalone/src-tauri
git status --short
git commit -m "feat(standalone): оболочка Tauri и команда host_hello" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

В индекс не должны попасть `apps/standalone/src-tauri/gen/` и `apps/standalone/target/`.

---

### Task 6: CI, руководство приложения и документация

**Files:**

- Create: `apps/standalone/AGENTS.md`, `apps/standalone/README.md`
- Modify: `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`, `tools/ci/test/workflow.test.mjs`, `tools/ci/test/required-results.test.mjs`, `.github/workflows/ci.yml`, `AGENTS.md`

**Interfaces:**

- Consumes: пакет и воркспейс из задач 1–5.
- Produces: выходы классификатора `standalone_rust`, `standalone_windows_build`; задания CI `standalone-rust`, `standalone-windows-build`.

- [ ] **Step 1: Написать падающие тесты классификатора**

В `tools/ci/test/affected.test.mjs`:

1. В массив `jobNames` после `"handheld_android",` добавить:

```js
  "standalone_rust",
  "standalone_windows_build",
```

2. В объект `signerOnly.jobs` после `handheld_android: false,` добавить:

```js
    standalone_rust: false,
    standalone_windows_build: false,
```

3. В тесте «shared packages fan out to their current consumers» в ожидаемом массиве для `"packages/ui/src/Button.tsx"` после `"signer_windows_build",` добавить:

```js
        "standalone_rust",
        "standalone_windows_build",
```

4. В тесте «CLI writes exact GitHub outputs for a NUL-delimited diff» после строки `"handheld_android=false",` добавить:

```js
      "standalone_rust=false",
      "standalone_windows_build=false",
```

5. Добавить после теста «Station native and web changes select different downstream work»:

```js
test("Standalone native and web changes select their jobs", () => {
  for (const path of [
    "apps/standalone/host/src/server.rs",
    "apps/standalone/src-tauri/src/lib.rs",
    "apps/standalone/Cargo.lock",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["standalone_rust", "standalone_windows_build"],
      path,
    );
  }
  for (const path of [
    "apps/standalone/src/app/App.tsx",
    "apps/standalone/proto/fixtures/hello.json",
  ]) {
    assert.deepEqual(
      enabledJobs(classifyChangedFiles([path])),
      ["verify_static", "verify_app_tests", "standalone_rust", "standalone_windows_build"],
      path,
    );
  }
});
```

В `tools/ci/test/workflow.test.mjs` в массив `heavyJobs` после `["handheld-android", "handheld_android"],` добавить:

```js
  ["standalone-rust", "standalone_rust"],
  ["standalone-windows-build", "standalone_windows_build"],
```

В `tools/ci/test/required-results.test.mjs` в массив `jobPairs` после `["handheld_android", "handheld-android"],` добавить:

```js
  ["standalone_rust", "standalone-rust"],
  ["standalone_windows_build", "standalone-windows-build"],
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs`
Expected: FAIL — классификатор и workflow ещё не знают новых заданий.

- [ ] **Step 3: Классификатор**

В `tools/ci/affected.mjs`:

- в `HEAVY_JOBS` после `"handheld_android",` добавить `"standalone_rust",` и `"standalone_windows_build",`;
- после строки `const stationJobs = ["station_rust", "station_windows_build"];` добавить:

```js
const standaloneJobs = ["standalone_rust", "standalone_windows_build"];
```

- в `sharedJobs.ui` заменить `...stationJobs, ...signerJobs],` на `...stationJobs, ...signerJobs, ...standaloneJobs],`;
- в `jobsForPath` перед комментарием `// The Android app is a Gradle project outside the pnpm workspace: only its own job runs.` добавить:

```js
// Host and shell crates run only the Rust jobs; everything else in the app
// (webview, protocol fixtures read by both suites, package files) also runs
// the JavaScript gates.
if (path.startsWith("apps/standalone/")) {
  if (
    path.startsWith("apps/standalone/host/") ||
    path.startsWith("apps/standalone/src-tauri/") ||
    /^apps\/standalone\/Cargo\.(?:toml|lock)$/u.test(path)
  ) {
    return standaloneJobs;
  }
  return ["verify_static", "verify_app_tests", ...standaloneJobs];
}
```

- [ ] **Step 4: Workflow**

В `.github/workflows/ci.yml`:

- в `classify-changes.outputs` после `handheld_android: ${{ steps.affected.outputs.handheld_android }}` добавить:

<!-- prettier-ignore -->
```yaml
      standalone_rust: ${{ steps.affected.outputs.standalone_rust }}
      standalone_windows_build: ${{ steps.affected.outputs.standalone_windows_build }}
```

- перед заданием `handheld-android:` добавить два задания:

<!-- prettier-ignore -->
```yaml
  standalone-rust:
    needs: classify-changes
    if: needs.classify-changes.outputs.standalone_rust == 'true'
    runs-on: ubuntu-latest
    # Same WebKit apt headroom as station-rust.
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - name: Install Linux webkit deps
        env:
          DEBIAN_FRONTEND: noninteractive
        run: |
          sudo apt-get -o Acquire::Retries=3 update
          sudo apt-get -o Acquire::Retries=3 install --no-install-recommends -y \
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
      - run: pnpm install --frozen-lockfile
      # `tauri::generate_context!` needs `apps/standalone/dist` at compile time.
      - name: Build standalone webview + workspace deps
        run: pnpm turbo build --filter '@markiro/standalone...'
      - name: cargo build + test (protocol, host and shell)
        run: |
          cargo build --manifest-path apps/standalone/Cargo.toml --workspace
          cargo test  --manifest-path apps/standalone/Cargo.toml --workspace

  standalone-windows-build:
    needs: classify-changes
    if: needs.classify-changes.outputs.standalone_windows_build == 'true'
    runs-on: windows-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
      - run: pnpm install --frozen-lockfile
      - name: Build standalone webview + workspace deps
        run: pnpm turbo build --filter '@markiro/standalone...'
      # The Windows service entry point only compiles on Windows, so this is
      # the only job that exercises it.
      - name: cargo test (Windows paths)
        run: cargo test --manifest-path apps/standalone/Cargo.toml --workspace
      - name: Compile the Windows Tauri application
        run: pnpm --filter @markiro/standalone tauri build --debug --no-bundle
```

- в `ci-required.needs` после `- handheld-android` добавить:

<!-- prettier-ignore -->
```yaml
      - standalone-rust
      - standalone-windows-build
```

- [ ] **Step 5: Тесты CI проходят**

Run: `node --test tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs`
Expected: все PASS. Если `js-yaml` не находится (`workflow.test.mjs` его импортирует), запускать так же, как CI: `pnpm --config.verifyDepsBeforeRun=false exec node --test tools/ci/test/workflow.test.mjs`.

- [ ] **Step 6: Руководство и документация**

`apps/standalone/AGENTS.md`:

```markdown
# Standalone agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for
`apps/standalone`, the cloud-less product described in
[the design](../../docs/superpowers/specs/2026-09-26-standalone-station-design.md)
and [stage 1](../../docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md).

## Layout

- `host/` — `markiro-host`, the LAN service: HTTPS on port 45710 and the
  master SQLite; migrations in `host/migrations`.
- `src-tauri/` — the station and office shell; the local SQLite and every
  network call to the host live here.
- `proto/` — wire types (serde) and JSON fixtures; `src/host/protocol.ts`
  mirrors them with Zod.
- `src/` — the React webview.

## Single site, no tenants

One installation serves one site. Schemas have no `tenant_id`, so the root
rule about composite tenant keys does not apply here; isolation is the
separate installation.

## Three identities

Office users (login and password, a session bound to a device), operators
(PIN and badge, verified on the device) and devices (a per-device key) never
grant each other's rights. A device key alone never opens office routes.

## Databases

DDL lives only in `host/migrations` and `src-tauri/migrations`. An applied
migration is never edited — add a new one; sqlx verifies checksums at start.

## Protocol

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; both test suites parse every fixture. Raise
`PROTOCOL_VERSION` for an incompatible change; the host keeps accepting the
previous version.

## Network and TLS

The webview never performs HTTP. Rust calls the host with the aws-lc-rs
provider selected explicitly and verifies the pinned certificate fingerprint
(`markiro_proto::certificate_fingerprint`). `host_probe` accepts any
certificate and exists only to discover a host before a person or a pairing
code confirms the fingerprint.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

Never log device keys, session tokens, pairing codes, passwords, PINs, any
hash or the TLS private key.

## Verification

- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`. The
  Tauri crate needs `apps/standalone/dist`: build the webview first with
  `pnpm turbo run build --filter='@markiro/standalone...'`.
- `pnpm --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- The Windows service (and later DPAPI and kiosk mode) is exercised only by
  the `standalone-windows-build` job and manual checks; a host run on macOS
  proves none of it.
```

`apps/standalone/README.md`:

```markdown
# @markiro/standalone

Cloud-less Markiro («Markiro Автоном»): the `markiro-host` LAN service with
the master database plus the station and office desktop app. Design:
`docs/superpowers/specs/2026-09-26-standalone-station-design.md`; rules for
changes: [AGENTS.md](AGENTS.md).

## Development

1. Start the host (development data stays in `apps/standalone/.markiro-host`):

   `cargo run --manifest-path apps/standalone/Cargo.toml -p markiro-host -- run --data-dir apps/standalone/.markiro-host`

   The log shows the port (45710) and the certificate fingerprint;
   `print-fingerprint --data-dir apps/standalone/.markiro-host` prints it again.

2. Start the app: `pnpm --filter @markiro/standalone tauri dev`. It looks for
   the host at `https://127.0.0.1:45710`.

## Tests

- Rust: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
  (build the webview first — the Tauri crate embeds `dist/`).
- Webview: `pnpm --filter @markiro/standalone test`.
```

В корневом `AGENTS.md`:

- в разделе «Scoped instructions» после пункта `- [API](apps/api/AGENTS.md): …` добавить:

```markdown
- [Standalone](apps/standalone/AGENTS.md): single-site data model, the three
  identities, the host protocol and fixtures, and Windows-only checks.
```

- в «Repository map» после пункта `apps/signer` добавить:

```markdown
- `apps/standalone`: cloud-less desktop product («Markiro Автоном») for sites
  without a cloud: a React/Vite webview plus a Cargo workspace — `host`
  (`markiro-host`, the LAN service with the master SQLite), `src-tauri` (the
  station and office shell) and `proto` (wire types and fixtures shared with
  the Zod schemas). Single site, no tenants; see its scoped guide.
```

- в таблице «Minimum checks by change area» после строки `apps/signer` добавить строку:

```markdown
| `apps/standalone` | focused Vitest and cargo tests, package test, typecheck, lint, build, `cargo test --workspace` | the Windows service, LAN pairing and kiosk need Windows and manual checks |
```

- в абзаце про Rust-изменения перед блоком с командами `cargo test` заменить «For Rust changes under `apps/station/src-tauri` or in the `apps/signer` Cargo workspace» на «For Rust changes under `apps/station/src-tauri` or in the `apps/signer` or `apps/standalone` Cargo workspaces», а в блок команд добавить строку `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`.

- [ ] **Step 7: Проверки и commit**

Run:

```bash
node --test tools/ci/test/affected.test.mjs tools/ci/test/required-results.test.mjs
pnpm --config.verifyDepsBeforeRun=false exec node --test tools/ci/test/workflow.test.mjs
node_modules/.bin/prettier --write AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md
node_modules/.bin/prettier --check AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md tools/ci .github/workflows/ci.yml
git diff --check
```

Expected: тесты PASS, Prettier без замечаний, `git diff --check` пуст.

```bash
git add tools/ci/affected.mjs tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs .github/workflows/ci.yml AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md
git commit -m "ci(standalone): задания Rust и Windows, руководство приложения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace` — все тесты PASS.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — без ошибок.
- [ ] `node --test tools/ci/test/affected.test.mjs tools/ci/test/required-results.test.mjs` и `pnpm --config.verifyDepsBeforeRun=false exec node --test tools/ci/test/workflow.test.mjs` — PASS.
- [ ] `node_modules/.bin/prettier --check apps/standalone AGENTS.md tools/ci .github/workflows/ci.yml` и `git diff --check` — чисто.
- [ ] В отчёте отдельно: задание `standalone-windows-build` (служба Windows, сборка Tauri на Windows) и ручная проверка окна на Windows локально не выполнялись.

## Отклонения при исполнении

Записано по итогам исполнения 2026-09-26; код в ветке соответствует этому разделу, а не буквальному тексту задач выше там, где они расходятся.

- **Форматирование Rust.** Весь воркспейс прогнан через `cargo fmt`; код задач выше местами отформатирован иначе. Задание `standalone-rust` получило компонент `rustfmt` и шаг `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, а `apps/standalone/AGENTS.md` — соответствующий пункт в разделе проверок.
- **`details` в теле ошибки** — объект с обеих сторон: в Rust `Option<serde_json::Map<String, serde_json::Value>>` вместо `Option<serde_json::Value>`, в Zod — `z.record(...)`; тесты с обеих сторон отвергают не-объект.
- **`TlsListener` и адрес клиента.** Прямая реализация `Connected<IncomingStream<'_, TlsListener>>` для `SocketAddr` нарушает правило сиротских реализаций (E0117), поэтому `serve()` оборачивает слушатель штатным `ListenerExt::tap_io` из axum; поведение приёма и рукопожатия не изменилось.
- **Тест фикстур протокола** (`test/protocol.test.ts`) сначала сохраняет `import.meta.url` в константу: встроенный плагин Vite `vite:asset-import-meta-url` переписывает `new URL(<шаблон>, import.meta.url)` в окружении jsdom.
- **Не выполнено локально:** ручная проверка окна `tauri dev` (нет графической сессии) и задание `standalone-windows-build`. Модуль службы Windows проверен `cargo check --target x86_64-pc-windows-msvc` во временном крейте против `windows-service 0.8.1`; сам крейт хоста под Windows локально не собирается из-за C-зависимостей (`aws-lc-sys`, `libsqlite3-sys`).
