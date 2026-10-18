# План 1b1: API хоста — подключение, первый запуск, офис — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** хост умеет всё, что нужно первому запуску на одном ПК: подключить местное устройство, провести мастер (администратор, организация, стартовые номера SSCC), впустить офисного пользователя по паролю с ролями и вести профиль организации, счётчики SSCC и офисных пользователей, записывая каждое действие в журнал.

**Architecture:** все маршруты, кроме `GET /v1/hello`, проходят охрану версии протокола (`route_layer`). Личности: устройство по ключу (`Authorization: Bearer`), офисная сессия поверх устройства (`X-Office-Session`), роль перечитывается из базы на каждом запросе. Записи идут в транзакциях `BEGIN IMMEDIATE`, каждая меняющая справочник транзакция увеличивает глобальную ревизию. Время берётся из подменяемых часов в `AppState`. Пароли — PBKDF2-SHA256 в формате PHC `@markiro/domain` (600 000 итераций) через `aws-lc-rs`, который уже собирается вместе с rustls.

**Tech Stack:** Rust (axum 0.8.9, sqlx 0.8.6, aws-lc-rs 1.18.1, base64 0.22.1, time 0.3.55), тесты роутера через `tower::ServiceExt::oneshot` и `MockConnectInfo`.

**Спецификации:** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (разделы 4.3–4.10; этот план — хостовая половина строки 1b раздела 8); итоговое ревью плана 1a — раздел «Отклонения при исполнении» в `docs/superpowers/plans/2026-09-26-standalone-1a-skeleton.md`.

## Global Constraints

- Новые зависимости хоста — только `aws-lc-rs = "=1.18.1"` и `base64 = "=0.22.1"` (обе уже есть в `apps/standalone/Cargo.lock`); dev-зависимости — `tower = { version = "0.5", features = ["util"] }` и `http-body-util = "0.1"` (тоже уже в lock). У `time` включается фича `parsing`. Других крейтов не добавлять.
- Все маршруты, кроме `GET /v1/hello` и ответа «не найдено», требуют заголовок `x-markiro-protocol` со значением в `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`; иначе `400 protocol_unsupported` с `details { protocol, minProtocol, maxProtocol }`.
- Тело любой ошибки — `markiro_proto::ErrorBody`; отказы экстракторов JSON и пути — `400 validation_failed`; неверный метод — `405 method_not_allowed`.
- Коды ошибок (`markiro_proto::codes`): `not_found`, `method_not_allowed`, `protocol_unsupported`, `validation_failed` (с `details.field`, когда ошибка в поле), `unauthorized`, `forbidden`, `stale_revision` (с `details.currentRev`), `conflict` (с `details.constraint`), `last_admin`, `sscc_below_floor` (с `details.currentNextSerial`), `already_initialized`, `loopback_only`, `rate_limited`, `internal`.
- Ключ устройства и токен сессии — 32 случайных байта в base64url без выравнивания; в базе — только SHA-256 hex. Заголовки: `Authorization: Bearer <ключ>`, `x-office-session: <токен>`.
- Сессия офиса привязана к устройству; истекает через 30 минут бездействия или через 12 часов после входа; роль и активность пользователя перечитываются на каждом запросе. Закрытая или истёкшая сессия удаляется (столбцы `office_sessions` — ровно как в спецификации, §4.3).
- Мастер первого запуска создаёт 1–20 линий; имя — 1–100 символов после обрезки пробелов, уникально без учёта регистра по Unicode (ключ `name_key` — обрезанное имя в нижнем регистре). Ответ мастера — `{ session }` (спецификация, §4.5).
- Пароли: 8–128 символов; PHC `pbkdf2$sha256$<итерации>$<соль>$<хеш>`, соль 16 байт, хеш 32 байта, стандартный base64 с выравниванием (как `packages/domain/src/crypto/phc.ts`), 600 000 итераций для новых паролей, минимум 10 000 при проверке; неизвестный логин проверяется против фиктивного хеша.
- Вход в офис: не больше 10 попыток в минуту с одного адреса, иначе `429 rate_limited`.
- `POST /v1/local-pair` и `POST /v1/bootstrap` принимаются только с loopback-адреса (`403 loopback_only`).
- Каждая транзакция, меняющая данные с `rev`, увеличивает `host_revision.rev` ровно на один и ставит новое значение всем изменённым строкам.
- Журнал действий: вход (успех и отказ), выход, подключение устройства, инициализация, каждое изменение из офиса. В `details` — никаких паролей, PIN, ключей, токенов, хешей и соли. Тесты проверяют точные поля записи.
- В журнале процесса нет ключей, токенов, паролей, хешей и соли бейджей (тест задачи 5).
- Логин офиса — ASCII `[A-Za-z0-9._-]{3,64}`, сравнение без учёта регистра.
- Префикс-эмитент SSCC — первые 9 цифр GLN; вместимость серийника `10^(16 - длина префикса)`; стартовый номер: короба — от 1, паллеты — от 0; счётчик можно двигать только вперёд.
- Время в базе и в протоколе — UTC RFC 3339 без долей секунды.
- `apps/station` не меняется. Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

- Перед каждым коммитом: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` и `... --all -- --check`; новые и изменённые JSON- и markdown-файлы — `node_modules/.bin/prettier --write <файлы>` (CI проверяет форматирование всего репозитория, фикстуры в плане уже в виде prettier).
- Cargo в песочнице не пишет в `~/.cargo`: все крейты уже скачаны, используйте `--offline`. Если cargo всё же просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы. Тесты с настоящим HTTPS (`hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`) слушают 127.0.0.1 — при отказе песочницы (EPERM) запускайте их вне песочницы.
- Не использовать `git stash`; не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.
- PBKDF2 с 600 000 итераций в отладочной сборке без оптимизации C-кода работает секундами, поэтому задача 1 включает оптимизацию `aws-lc-sys`/`aws-lc-rs` в профиле `dev`.
- Новые фикстуры `proto/fixtures` этого плана проверяются только в Rust; схемы Zod для них добавляет план 1b2. Vitest читает фикстуры по имени, поэтому новые файлы TypeScript-тесты не роняют.

## Файлы

```
apps/standalone/Cargo.toml                         задача 1 (профиль dev для aws-lc)
apps/standalone/proto/src/lib.rs                   задачи 1–5 (коды и типы протокола)
apps/standalone/proto/fixtures/*.json, proto/tests/fixtures.rs    задачи 2–5
apps/standalone/host/Cargo.toml                    задача 1
apps/standalone/host/migrations/0002_devices_lines_audit.sql       задача 2
apps/standalone/host/migrations/0003_office_auth.sql               задача 3
apps/standalone/host/migrations/0004_org_sscc.sql                  задача 4
apps/standalone/host/src/clock.rs                  задача 1
apps/standalone/host/src/error.rs                  задача 1
apps/standalone/host/src/db.rs, config.rs, lib.rs, server.rs       задача 1 (+ маршруты в 2–5)
apps/standalone/host/src/secrets.rs                задачи 2–3
apps/standalone/host/src/audit.rs, auth.rs         задачи 2–3
apps/standalone/host/src/rate_limit.rs             задача 3
apps/standalone/host/src/validate.rs               задачи 3–5
apps/standalone/host/src/routes/{mod,pairing,office_auth,bootstrap,org,sscc,office_users}.rs  задачи 2–5
apps/standalone/host/tests/support/{mod,app}.rs    задачи 1–5
apps/standalone/host/tests/{platform,pairing,office_auth,bootstrap,office_admin,no_secrets_in_logs}.rs
apps/standalone/AGENTS.md, docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md   задачи 2, 5
```

---

### Task 1: Платформа — коды, ошибки, охрана протокола, часы, транзакции, блокировка каталога

**Files:**

- Modify: `apps/standalone/Cargo.toml`, `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/Cargo.toml`, `apps/standalone/host/src/error.rs`, `apps/standalone/host/src/db.rs`, `apps/standalone/host/src/config.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/tests/support/mod.rs`
- Create: `apps/standalone/host/src/clock.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/platform.rs`

**Interfaces:**

- Produces:
  - `markiro_proto::codes::{METHOD_NOT_ALLOWED, VALIDATION_FAILED, UNAUTHORIZED, FORBIDDEN, STALE_REVISION, CONFLICT, LAST_ADMIN, SSCC_BELOW_FLOOR, ALREADY_INITIALIZED, LOOPBACK_ONLY, RATE_LIMITED}` (плюс существующие).
  - `clock::{Clock, SystemClock, ManualClock, format_timestamp, parse_timestamp}`; `ManualClock::new(OffsetDateTime)`, `advance(time::Duration)`.
  - `error::ApiError::{new, with_details, status, code, not_found, method_not_allowed, protocol_unsupported, validation, malformed, unauthorized, forbidden, conflict, stale_revision, internal}`; экстракторы `error::ApiJson<T>`, `error::ApiPath<T>`.
  - `server::AppState { pool, host_id, clock }` с `AppState::new(pool, host_id, clock: Arc<dyn Clock>)`, `now() -> OffsetDateTime`, `timestamp() -> String`; `server::protocol_guard` (middleware); `server::router(AppState) -> Router`.
  - `db::begin_write(&SqlitePool) -> Result<Transaction<'static, Sqlite>, sqlx::Error>`, `db::next_revision(&mut SqliteConnection) -> Result<i64, sqlx::Error>`.
  - `config::HostPaths::{lock_file, lock}`, `config::ConfigError::Locked { path }`.
  - Тестовая обвязка `tests/support/app.rs`: `TestApp { state, clock }` с `new()`, `send(Request)`, `send_from(peer, Request)`; функции `request(method, path)`, `json(builder, Value)`, `empty(builder)`; константы `LOOPBACK`, `LAN`.

- [ ] **Step 1: Зависимости и профиль**

В конец `apps/standalone/Cargo.toml` добавить:

```toml

# PBKDF2 with 600 000 iterations runs in tests too; optimise the crypto
# primitives even in debug builds, or every password hash takes seconds.
[profile.dev.package.aws-lc-sys]
opt-level = 3

[profile.dev.package.aws-lc-rs]
opt-level = 3
```

В `apps/standalone/host/Cargo.toml` в `[dependencies]` добавить `aws-lc-rs = "=1.18.1"` и `base64 = "=0.22.1"`, у `time` заменить `features = ["formatting"]` на `features = ["formatting", "parsing"]`; в `[dev-dependencies]` добавить `http-body-util = "0.1"` и `tower = { version = "0.5", features = ["util"] }`.

- [ ] **Step 2: Коды ошибок протокола**

В `apps/standalone/proto/src/lib.rs` заменить модуль `codes` целиком:

```rust
/// Stable error codes of [`ErrorDetail::code`]; clients show text by code.
pub mod codes {
    pub const NOT_FOUND: &str = "not_found";
    pub const METHOD_NOT_ALLOWED: &str = "method_not_allowed";
    pub const PROTOCOL_UNSUPPORTED: &str = "protocol_unsupported";
    pub const VALIDATION_FAILED: &str = "validation_failed";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    pub const STALE_REVISION: &str = "stale_revision";
    pub const CONFLICT: &str = "conflict";
    pub const LAST_ADMIN: &str = "last_admin";
    pub const SSCC_BELOW_FLOOR: &str = "sscc_below_floor";
    pub const ALREADY_INITIALIZED: &str = "already_initialized";
    pub const LOOPBACK_ONLY: &str = "loopback_only";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const INTERNAL: &str = "internal";
}
```

- [ ] **Step 3: Написать падающие тесты**

`apps/standalone/host/tests/support/app.rs`:

```rust
//! In-process router harness: real SQLite in a temp dir, a manual clock, and
//! `MockConnectInfo` so routes that check the peer address can be exercised.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::request::Builder;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use markiro_host::clock::ManualClock;
use markiro_host::server::{router, AppState};
use serde_json::Value;
use tower::ServiceExt;

pub const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 50_000);
pub const LAN: ([u8; 4], u16) = ([192, 168, 1, 20], 50_000);

/// 2026-09-21T14:13:20Z — a fixed start for the manual clock.
pub const START: i64 = 1_790_000_000;

pub struct TestApp {
    pub state: AppState,
    pub clock: Arc<ManualClock>,
    _dir: tempfile::TempDir,
}

impl TestApp {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = markiro_host::db::open(&dir.path().join("host.db")).await.unwrap();
        let clock = Arc::new(ManualClock::new(
            time::OffsetDateTime::from_unix_timestamp(START).unwrap(),
        ));
        let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone());
        Self { state, clock, _dir: dir }
    }

    /// Send `request` as if it came from `peer`; returns the status and the
    /// JSON body (`Value::Null` when the body is empty).
    pub async fn send_from(
        &self,
        peer: impl Into<SocketAddr>,
        request: Request<Body>,
    ) -> (StatusCode, Value) {
        let response = router(self.state.clone())
            .layer(MockConnectInfo(peer.into()))
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
    }

    pub async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        self.send_from(LOOPBACK, request).await
    }
}

/// A request builder with the protocol header already set.
pub fn request(method: &str, path: &str) -> Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .header(
            markiro_proto::PROTOCOL_HEADER,
            markiro_proto::PROTOCOL_VERSION.to_string(),
        )
}

pub fn json(builder: Builder, body: Value) -> Request<Body> {
    builder
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub fn empty(builder: Builder) -> Request<Body> {
    builder.body(Body::empty()).unwrap()
}
```

В `apps/standalone/host/tests/support/mod.rs` сразу после doc-комментария модуля (строки `//!`) и перед `use std::sync::Arc;` вставить:

```rust
// Each integration-test binary uses a different subset of these helpers.
#![allow(dead_code)]

pub mod app;
```

(`#![allow]` — внутренний атрибут, как и `//!`, поэтому он идёт в начале модуля; `pub mod app;` — элемент и должен стоять после всех внутренних атрибутов.)

`apps/standalone/host/tests/platform.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::clock::{format_timestamp, parse_timestamp, Clock, ManualClock};
use markiro_host::config::HostPaths;
use markiro_host::{db, start, StartOptions};
use support::app::{empty, request, TestApp, START};

#[tokio::test]
async fn hello_needs_no_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::get("/v1/hello")
        .body(axum::body::Body::empty())
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
}

#[tokio::test]
async fn a_wrong_method_gets_the_protocol_error_body() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("POST", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body["error"]["code"], "method_not_allowed");
    assert_eq!(body["error"]["message"], "POST is not allowed on /v1/hello");
}

#[tokio::test]
async fn unknown_routes_stay_not_found_without_a_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::get("/v1/nothing")
        .body(axum::body::Body::empty())
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[tokio::test]
async fn revisions_increase_by_one_per_call() {
    let app = TestApp::new().await;
    let mut tx = db::begin_write(&app.state.pool).await.unwrap();
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 1);
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 2);
    tx.commit().await.unwrap();
    let mut tx = db::begin_write(&app.state.pool).await.unwrap();
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 3);
    tx.rollback().await.unwrap();
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(rev, 2);
}

#[test]
fn timestamps_are_utc_whole_seconds_and_round_trip() {
    let clock = ManualClock::new(time::OffsetDateTime::from_unix_timestamp(START).unwrap());
    clock.advance(time::Duration::milliseconds(1_500));
    let text = format_timestamp(clock.now());
    assert_eq!(text, "2026-09-21T14:13:21Z");
    assert_eq!(
        parse_timestamp(&text).unwrap().unix_timestamp(),
        START + 1
    );
}

#[tokio::test]
async fn a_second_host_on_the_same_data_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let first = start(&paths, options).await.unwrap();
    let error = start(&paths, options).await.err().expect("second start must fail");
    assert!(error.to_string().contains("host.lock"), "{error}");
    first.stop().await.unwrap();
    let again = start(&paths, options).await.unwrap();
    again.stop().await.unwrap();
}
```

В конец `apps/standalone/host/src/server.rs` добавить модульные тесты охраны протокола:

```rust
#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::{middleware, Router};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    async fn call(header: Option<&str>) -> (StatusCode, Value) {
        let app = Router::new()
            .route("/probe", get(|| async { "ok" }))
            .route_layer(middleware::from_fn(super::protocol_guard));
        let mut builder = Request::get("/probe");
        if let Some(value) = header {
            builder = builder.header(markiro_proto::PROTOCOL_HEADER, value);
        }
        let response = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn a_supported_version_passes() {
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_missing_header_is_refused_with_details() {
        let (status, body) = call(None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "protocol_unsupported");
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 1);
    }

    #[tokio::test]
    async fn an_out_of_range_or_garbled_version_is_refused() {
        let (status, body) = call(Some("7")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["details"]["protocol"], 7);
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
    }
}
```

- [ ] **Step 4: Убедиться, что тесты не собираются**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline`
Expected: FAIL — нет `clock`, `AppState::new`, `db::begin_write`, `protocol_guard`.

- [ ] **Step 5: Реализовать**

`apps/standalone/host/src/clock.rs`:

```rust
//! Time source. Handlers read the clock from `AppState`, so tests can move
//! time forward (session expiry, rate limits) without sleeping.

use std::sync::Mutex;

use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;
}

/// The real UTC clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

/// A clock that moves only when told to; for tests.
#[derive(Debug)]
pub struct ManualClock {
    now: Mutex<OffsetDateTime>,
}

impl ManualClock {
    pub fn new(start: OffsetDateTime) -> Self {
        Self {
            now: Mutex::new(start),
        }
    }

    pub fn advance(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.now.lock().expect("clock lock")
    }
}

/// UTC RFC 3339 without fractional seconds — the only timestamp format stored
/// in the database, so comparing the text orders the instants.
pub fn format_timestamp(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .replace_nanosecond(0)
        .expect("zero nanoseconds is always valid")
        .format(&Rfc3339)
        .expect("RFC 3339 formatting of a UTC time cannot fail")
}

/// Parse a timestamp written by [`format_timestamp`].
pub fn parse_timestamp(text: &str) -> Result<OffsetDateTime, time::error::Parse> {
    OffsetDateTime::parse(text, &Rfc3339)
}
```

`apps/standalone/host/src/error.rs` заменить целиком:

```rust
//! Error responses: an HTTP status plus the protocol's `ErrorBody`, and the
//! extractors whose rejections must use that body too.

use axum::extract::{FromRequest, FromRequestParts, Path, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{codes, ErrorBody, MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody::new(code, message),
        }
    }

    /// Attach structured detail. Only a JSON object is kept: the protocol's
    /// `details` is always an object.
    pub fn with_details(mut self, details: Value) -> Self {
        if let Value::Object(map) = details {
            self.body.error.details = Some(map);
        }
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &str {
        &self.body.error.code
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, codes::NOT_FOUND, message)
    }

    pub fn method_not_allowed(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            codes::METHOD_NOT_ALLOWED,
            message,
        )
    }

    /// `received` is the version the client sent, if any could be read.
    pub fn protocol_unsupported(received: Option<u32>) -> Self {
        let message = match received {
            Some(version) => format!(
                "protocol {version} is outside {MIN_PROTOCOL_VERSION}..={PROTOCOL_VERSION}"
            ),
            None => format!("header {PROTOCOL_HEADER} with a protocol version is required"),
        };
        Self::new(StatusCode::BAD_REQUEST, codes::PROTOCOL_UNSUPPORTED, message).with_details(
            json!({
                "protocol": received,
                "minProtocol": MIN_PROTOCOL_VERSION,
                "maxProtocol": PROTOCOL_VERSION,
            }),
        )
    }

    /// A field-level input error; `field` uses the request's JSON path
    /// (`org.gln`, `admin.password`).
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
            .with_details(json!({ "field": field }))
    }

    /// A request that could not be read at all (bad JSON, wrong types, unknown fields).
    pub fn malformed(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, codes::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, codes::FORBIDDEN, message)
    }

    /// A uniqueness conflict; `constraint` names it (`login`, `gtin`, …).
    pub fn conflict(constraint: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, codes::CONFLICT, message)
            .with_details(json!({ "constraint": constraint }))
    }

    /// The row changed since the client read it.
    pub fn stale_revision(current_rev: i64) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            codes::STALE_REVISION,
            "the record changed since it was read",
        )
        .with_details(json!({ "currentRev": current_rev }))
    }

    /// Logs the cause on the host; the client only learns that it failed.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::INTERNAL,
            "internal error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// `Json<T>` whose rejections become `validation_failed`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// `Path<T>` whose rejections become `validation_failed`.
pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}
```

В `apps/standalone/host/src/db.rs` добавить к импортам `use sqlx::{Sqlite, SqliteConnection, Transaction};` и в конец файла:

```rust
/// Start a write transaction that takes SQLite's write lock up front
/// (`BEGIN IMMEDIATE`). With a deferred `BEGIN`, a read followed by a write on
/// a stale WAL snapshot fails with SQLITE_BUSY at once and `busy_timeout`
/// cannot help; the revision bump below is exactly that pattern.
pub async fn begin_write(pool: &SqlitePool) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// Increase the global revision by one inside the current transaction and
/// return the new value (spec §4.4: one revision per changing transaction).
pub async fn next_revision(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("UPDATE host_revision SET rev = rev + 1 WHERE id = 1 RETURNING rev")
        .fetch_one(conn)
        .await
}
```

В `apps/standalone/host/src/config.rs`:

- в `enum ConfigError` добавить вариант:

```rust
    #[error("another markiro-host is using this data directory ({path} is locked)")]
    Locked { path: PathBuf },
```

- в `impl HostPaths` добавить:

```rust
    pub fn lock_file(&self) -> PathBuf {
        self.data_dir.join("host.lock")
    }

    /// An exclusive lock on the data directory, held while the returned file
    /// is alive: two hosts must never open the same database and TLS identity.
    pub fn lock(&self) -> Result<fs::File, ConfigError> {
        let path = self.lock_file();
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|source| ConfigError::Io {
                path: path.clone(),
                source,
            })?;
        match file.try_lock() {
            Ok(()) => Ok(file),
            Err(fs::TryLockError::WouldBlock) => Err(ConfigError::Locked { path }),
            Err(fs::TryLockError::Error(source)) => Err(ConfigError::Io { path, source }),
        }
    }
```

В `apps/standalone/host/src/server.rs`:

- импорты: добавить `use axum::extract::Request;`, `use axum::middleware::{self, Next};`, `use axum::response::Response;`, `use crate::clock::{format_timestamp, Clock};`, `use time::OffsetDateTime;`; удалить функцию `now_rfc3339`;
- заменить `AppState`, `router`, `hello` и `not_found` на:

```rust
#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub host_id: String,
    pub clock: Arc<dyn Clock>,
}

impl AppState {
    pub fn new(pool: SqlitePool, host_id: String, clock: Arc<dyn Clock>) -> Self {
        Self {
            pool,
            host_id,
            clock,
        }
    }

    pub fn now(&self) -> OffsetDateTime {
        self.clock.now()
    }

    /// `now()` in the stored timestamp format.
    pub fn timestamp(&self) -> String {
        format_timestamp(self.now())
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .with_state(state)
}

/// Every route except `hello` requires a supported protocol version
/// (spec §4.5). Apply with `route_layer` on the protected routes only, so
/// `hello` answers any version and unknown paths stay `not_found`.
pub async fn protocol_guard(request: Request, next: Next) -> Result<Response, ApiError> {
    let version = request
        .headers()
        .get(markiro_proto::PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok());
    match version {
        Some(version)
            if (markiro_proto::MIN_PROTOCOL_VERSION..=markiro_proto::PROTOCOL_VERSION)
                .contains(&version) =>
        {
            Ok(next.run(request).await)
        }
        other => Err(ApiError::protocol_unsupported(other)),
    }
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let initialized = crate::db::is_initialized(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
        min_protocol: markiro_proto::MIN_PROTOCOL_VERSION,
        host_id: state.host_id.clone(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: state.timestamp(),
        initialized,
    }))
}

async fn method_not_allowed(method: Method, uri: Uri) -> ApiError {
    ApiError::method_not_allowed(format!("{method} is not allowed on {}", uri.path()))
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}
```

`middleware` в этом шаге используется только в модульных тестах; если компилятор предупреждает о неиспользуемом импорте `middleware` вне тестов, импортируйте в основном коде только `Next`, а `middleware` — внутри `mod tests` (он там уже импортирован).

В `apps/standalone/host/src/lib.rs`:

- добавить `pub mod clock;` в список модулей;
- добавить константу и поле, заменить `stop` и создание состояния:

```rust
/// How long `stop` waits for open connections before aborting them.
const SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
```

в `struct RunningHost` добавить последнее поле `_lock: std::fs::File,` (держит блокировку каталога данных до остановки);

```rust
impl RunningHost {
    pub async fn stop(self) -> Result<(), BoxError> {
        let _ = self.shutdown.send(());
        let mut task = self.task;
        match tokio::time::timeout(SHUTDOWN_DEADLINE, &mut task).await {
            Ok(joined) => joined??,
            Err(_) => {
                tracing::warn!("graceful shutdown timed out; aborting open connections");
                task.abort();
            }
        }
        self.pool.close().await;
        tracing::info!("markiro-host stopped");
        Ok(())
    }
}
```

в `start` сразу после `paths.ensure()?;` добавить `let lock = paths.lock()?;`, заменить создание `state` на

```rust
    let state = server::AppState::new(
        pool.clone(),
        config.host_id.clone(),
        std::sync::Arc::new(clock::SystemClock),
    );
```

и в возвращаемый `RunningHost { … }` добавить `_lock: lock,`.

- [ ] **Step 6: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline`
Expected: все прежние тесты PASS, плюс 6 новых в `platform.rs` и 3 модульных теста охраны. Тест блокировки и прежние HTTPS-тесты слушают 127.0.0.1 — при отказе песочницы запускайте вне её.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/Cargo.toml apps/standalone/Cargo.lock apps/standalone/proto/src/lib.rs apps/standalone/host/Cargo.toml apps/standalone/host/src apps/standalone/host/tests
git commit -m "feat(standalone): платформа хоста — ошибки протокола, охрана версии, часы, транзакции записи, блокировка каталога" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Устройства, журнал действий и подключение местной станции

**Files:**

- Create: `apps/standalone/host/migrations/0002_devices_lines_audit.sql`, `apps/standalone/host/src/secrets.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/auth.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/routes/pairing.rs`, `apps/standalone/host/tests/pairing.rs`, `apps/standalone/proto/fixtures/local-pair-request.json`, `apps/standalone/proto/fixtures/pair-response.json`, `apps/standalone/proto/fixtures/device-info.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/foundation.rs`, `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: всё из задачи 1.
- Produces:
  - proto: `DeviceKind { Station, Office, Handheld }` (`snake_case`, `as_str()`), `LocalPairRequest { kind, name, app_version, capabilities }` (`deny_unknown_fields`), `PairResponse { device_id, device_key, host_id }`, `DeviceInfo { id, kind, name, line_id: Option<String>, paired_at }`.
  - `secrets::{random_key() -> String, key_hash(&str) -> String}`.
  - `audit::{Actor, Outcome, Entry, record(&mut SqliteConnection, at: &str, Entry)}`.
  - `auth::{AuthDevice { id, kind }, require_loopback(SocketAddr) -> Result<(), ApiError>}`; `AuthDevice` — экстрактор (`FromRequestParts<AppState>`).
  - Маршруты `POST /v1/local-pair`, `GET /v1/device` за охраной протокола.
  - Обвязка тестов: `support::app::pair_device(&TestApp, kind: &str) -> (String /*id*/, String /*key*/)`, `support::app::with_device(builder, key) -> Builder`.

- [ ] **Step 1: Миграция**

`apps/standalone/host/migrations/0002_devices_lines_audit.sql`:

```sql
-- Lines: created now so devices can reference them; the office screens for
-- lines arrive in plan 1d. `name_key` is the trimmed, Unicode-lowercased name
-- computed by the host (SQLite's lower() folds ASCII only).
CREATE TABLE lines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX lines_active_name_key ON lines (name_key) WHERE archived = 0;

-- Paired devices. Only the SHA-256 of the device key is stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('station', 'office', 'handheld')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  line_id TEXT REFERENCES lines (id),
  key_hash TEXT NOT NULL UNIQUE,
  app_version TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

-- Audit trail (spec §4.9). `details` never holds secrets or hashes.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('office_user', 'device', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
  details TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(details) AND json_type(details) = 'object')
);
CREATE INDEX audit_log_at ON audit_log (at);
```

В `apps/standalone/host/tests/foundation.rs` тест `migrations_apply_once_and_site_starts_uninitialized` сравнивает число применённых миграций с единицей; с новыми миграциями он должен сравнивать с числом встроенных. Заменить `assert_eq!(applied, 1);` на:

```rust
    assert_eq!(applied, i64::try_from(db::MIGRATOR.iter().count()).unwrap());
```

- [ ] **Step 2: Типы протокола и фикстуры**

В `apps/standalone/proto/src/lib.rs` добавить после `ErrorBody`/`impl ErrorBody`:

```rust
/// Kind of a paired device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Station,
    Office,
    Handheld,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Station => "station",
            DeviceKind::Office => "office",
            DeviceKind::Handheld => "handheld",
        }
    }
}

/// `POST /v1/local-pair`: a device on the host's own computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPairRequest {
    pub kind: DeviceKind,
    pub name: String,
    pub app_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// Response of `local-pair` (and, from plan 1c, `pairing/claim`). The device
/// key is shown exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_key: String,
    pub host_id: String,
}

/// `GET /v1/device`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub paired_at: String,
}
```

`apps/standalone/proto/fixtures/local-pair-request.json`:

```json
{
  "kind": "station",
  "name": "Станция линии 1",
  "appVersion": "0.1.0",
  "capabilities": ["validation-dm-duplicate-v1"]
}
```

`apps/standalone/proto/fixtures/pair-response.json`:

```json
{
  "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "deviceKey": "3q2-7w0W7W9x1YpQ4nL8vT0uB5cH2gJ6kM9sR1eA4dF",
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
}
```

`apps/standalone/proto/fixtures/device-info.json`:

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "kind": "station",
  "name": "Станция линии 1",
  "lineId": null,
  "pairedAt": "2026-09-26T09:15:00Z"
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить к `use markiro_proto::{…}` имена `DeviceInfo, DeviceKind, LocalPairRequest, PairResponse` и тесты:

```rust
#[test]
fn pairing_fixtures_round_trip() {
    let request: LocalPairRequest = round_trip("local-pair-request.json");
    assert_eq!(request.kind, DeviceKind::Station);
    let _: PairResponse = round_trip("pair-response.json");
    let info: DeviceInfo = round_trip("device-info.json");
    assert!(info.line_id.is_none());
}

#[test]
fn requests_reject_unknown_fields() {
    let mut value = fixture("local-pair-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<LocalPairRequest>(value).is_err());
}
```

- [ ] **Step 3: Написать падающие тесты хоста**

В конец `apps/standalone/host/tests/support/app.rs` добавить:

```rust
/// Add `Authorization: Bearer <key>`.
pub fn with_device(builder: Builder, key: &str) -> Builder {
    builder.header("authorization", format!("Bearer {key}"))
}

/// Pair a device of `kind` from loopback; returns its id and key.
pub async fn pair_device(app: &TestApp, kind: &str) -> (String, String) {
    let (status, body) = app
        .send(json(
            request("POST", "/v1/local-pair"),
            serde_json::json!({ "kind": kind, "name": "Тестовое устройство", "appVersion": "0.1.0" }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["deviceId"].as_str().unwrap().to_owned(),
        body["deviceKey"].as_str().unwrap().to_owned(),
    )
}
```

`apps/standalone/host/tests/pairing.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{empty, json as json_request, pair_device, request, with_device, TestApp, LAN};

async fn audit_rows(app: &TestApp) -> Vec<(String, String, Option<String>, String, Option<String>, Option<String>, String, String)> {
    sqlx::query_as(
        "SELECT at, actor_kind, actor_id, action, target_type, target_id, result, details FROM audit_log ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_local_station_pairs_and_only_the_key_hash_is_stored() {
    let app = TestApp::new().await;
    let (status, body) = app
        .send(json_request(
            request("POST", "/v1/local-pair"),
            json!({ "kind": "station", "name": "  Станция 1  ", "appVersion": "0.1.0", "capabilities": ["a"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["deviceId"].as_str().unwrap();
    let key = body["deviceKey"].as_str().unwrap();
    assert_eq!(key.len(), 43);
    assert_eq!(body["hostId"], app.state.host_id);

    let (kind, name, stored_hash, capabilities, paired_at): (String, String, String, String, String) =
        sqlx::query_as("SELECT kind, name, key_hash, capabilities, paired_at FROM devices WHERE id = ?")
            .bind(id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(kind, "station");
    assert_eq!(name, "Станция 1");
    assert_eq!(stored_hash, key_hash(key));
    assert_eq!(capabilities, r#"["a"]"#);
    assert_eq!(paired_at, app.state.timestamp());

    let rows = audit_rows(&app).await;
    assert_eq!(rows.len(), 1);
    let (at, actor_kind, actor_id, action, target_type, target_id, result, details) = &rows[0];
    assert_eq!(at, &app.state.timestamp());
    assert_eq!(actor_kind, "device");
    assert_eq!(actor_id.as_deref(), Some(id));
    assert_eq!(action, "device.local_pair");
    assert_eq!(target_type.as_deref(), Some("device"));
    assert_eq!(target_id.as_deref(), Some(id));
    assert_eq!(result, "ok");
    assert_eq!(
        serde_json::from_str::<Value>(details).unwrap(),
        json!({ "kind": "station", "name": "Станция 1" })
    );
}

#[tokio::test]
async fn local_pairing_from_the_network_is_refused() {
    let app = TestApp::new().await;
    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                request("POST", "/v1/local-pair"),
                json!({ "kind": "station", "name": "Чужая", "appVersion": "0.1.0" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "loopback_only");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn invalid_local_pair_requests_are_validation_errors() {
    let app = TestApp::new().await;
    let cases = [
        (json!({ "kind": "handheld", "name": "ТСД", "appVersion": "0.1.0" }), Some("kind")),
        (json!({ "kind": "station", "name": "   ", "appVersion": "0.1.0" }), Some("name")),
        (json!({ "kind": "station", "name": "С", "appVersion": "" }), Some("appVersion")),
        (json!({ "kind": "station", "name": "С", "appVersion": "0.1.0", "extra": 1 }), None),
    ];
    for (body, field) in cases {
        let (status, response) = app
            .send(json_request(request("POST", "/v1/local-pair"), body.clone()))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["error"]["code"], "validation_failed", "{body}");
        match field {
            Some(field) => assert_eq!(response["error"]["details"]["field"], field),
            None => assert!(response["error"]["details"].is_null()),
        }
    }
}

#[tokio::test]
async fn protected_routes_require_the_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::post("/v1/local-pair")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({ "kind": "station", "name": "С", "appVersion": "0.1.0" }).to_string(),
        ))
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "protocol_unsupported");
}

#[tokio::test]
async fn a_device_reads_itself_with_its_key_until_revoked() {
    let app = TestApp::new().await;
    let (id, key) = pair_device(&app, "office").await;

    app.clock.advance(time::Duration::minutes(5));
    let (status, body) = app.send(empty(with_device(request("GET", "/v1/device"), &key))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], id);
    assert_eq!(body["kind"], "office");
    assert_eq!(body["lineId"], Value::Null);
    let last_seen: String = sqlx::query_scalar("SELECT last_seen_at FROM devices WHERE id = ?")
        .bind(&id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(last_seen, app.state.timestamp());

    let (status, body) = app.send(empty(with_device(request("GET", "/v1/device"), "wrong"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");

    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(&id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, _) = app.send(empty(with_device(request("GET", "/v1/device"), &key))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app.send(empty(request("GET", "/v1/device"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
```

Добавить в `apps/standalone/host/src/secrets.rs` (создаётся в шаге 5) модульные тесты — они в том же шаге.

- [ ] **Step 4: Убедиться, что тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test pairing`
Expected: FAIL — нет `secrets`, маршрутов подключения.

- [ ] **Step 5: Реализовать**

`apps/standalone/host/src/secrets.rs`:

```rust
//! Secrets: random device keys and session tokens and their stored hashes.
//! (The PBKDF2 PHC format for passwords joins in plan 1b1, task 3.)

use aws_lc_rs::digest::{digest, SHA256};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

const KEY_BYTES: usize = 32;

/// A new device key or session token: 32 random bytes, base64url.
pub fn random_key() -> String {
    let mut bytes = [0u8; KEY_BYTES];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random generator is available");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// What the database stores for a key or a token: lower-case hex SHA-256.
/// Keys are 256-bit random values, so an unsalted hash is enough.
pub fn key_hash(key: &str) -> String {
    digest(&SHA256, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_43_base64url_characters_and_distinct() {
        let first = random_key();
        let second = random_key();
        assert_eq!(first.len(), 43);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(first, second);
    }

    #[test]
    fn key_hash_is_hex_sha256() {
        assert_eq!(
            key_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
```

`apps/standalone/host/src/audit.rs`:

```rust
//! Audit trail of office actions, pairing and initialization (spec §4.9).
//! `details` never contains PINs, passwords, keys, tokens, salts or hashes.

use serde_json::Value;
use sqlx::SqliteConnection;

#[derive(Debug, Clone, Copy)]
pub enum Actor<'a> {
    OfficeUser(&'a str),
    Device(&'a str),
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Denied,
    Failed,
}

pub struct Entry<'a> {
    pub actor: Actor<'a>,
    pub action: &'a str,
    pub target_type: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub outcome: Outcome,
    pub details: Value,
}

pub async fn record(
    conn: &mut SqliteConnection,
    at: &str,
    entry: Entry<'_>,
) -> Result<(), sqlx::Error> {
    let (actor_kind, actor_id) = match entry.actor {
        Actor::OfficeUser(id) => ("office_user", Some(id)),
        Actor::Device(id) => ("device", Some(id)),
        Actor::System => ("system", None),
    };
    let outcome = match entry.outcome {
        Outcome::Ok => "ok",
        Outcome::Denied => "denied",
        Outcome::Failed => "failed",
    };
    sqlx::query(
        "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, result, details) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(at)
    .bind(actor_kind)
    .bind(actor_id)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(outcome)
    .bind(entry.details.to_string())
    .execute(conn)
    .await?;
    Ok(())
}
```

`apps/standalone/host/src/auth.rs`:

```rust
//! Request identities. Rights come only from these extractors, never from
//! identifiers the client sends.

use std::net::SocketAddr;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::StatusCode;
use markiro_proto::{codes, DeviceKind};

use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::secrets::key_hash;
use crate::server::AppState;

/// A paired, non-revoked device, identified by `Authorization: Bearer <key>`.
#[derive(Debug, Clone)]
pub struct AuthDevice {
    pub id: String,
    pub kind: DeviceKind,
}

impl FromRequestParts<AppState> for AuthDevice {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let key = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|key| !key.is_empty())
            .ok_or_else(|| ApiError::unauthorized("a device key is required"))?;
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT id, kind FROM devices WHERE key_hash = ? AND revoked_at IS NULL")
                .bind(key_hash(key))
                .fetch_optional(&state.pool)
                .await
                .map_err(ApiError::internal)?;
        let (id, kind) =
            row.ok_or_else(|| ApiError::unauthorized("unknown or revoked device key"))?;
        let kind: DeviceKind =
            serde_json::from_value(serde_json::Value::String(kind)).map_err(ApiError::internal)?;
        // Record activity at most once a minute to keep writes rare.
        let now = state.now();
        sqlx::query(
            "UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
        )
        .bind(format_timestamp(now))
        .bind(&id)
        .bind(format_timestamp(now - time::Duration::minutes(1)))
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(Self { id, kind })
    }
}

/// Only peers on this computer (spec §2, decision 14).
pub fn require_loopback(peer: SocketAddr) -> Result<(), ApiError> {
    if peer.ip().to_canonical().is_loopback() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            codes::LOOPBACK_ONLY,
            "only accepted from this computer",
        ))
    }
}
```

`apps/standalone/host/src/routes/mod.rs`:

```rust
//! Route handlers, one module per area; `server::router` wires them.

pub mod pairing;
```

`apps/standalone/host/src/routes/pairing.rs`:

```rust
//! Device pairing: the local device (`POST /v1/local-pair`) and device
//! self-information (`GET /v1/device`). Code pairing arrives in plan 1c.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, LocalPairRequest, PairResponse, PROTOCOL_HEADER};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{require_loopback, AuthDevice};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::secrets::{key_hash, random_key};
use crate::server::AppState;

pub async fn local_pair(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<LocalPairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    require_loopback(peer)?;
    if request.kind == DeviceKind::Handheld {
        return Err(ApiError::validation(
            "kind",
            "a handheld pairs with a code, not locally",
        ));
    }
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::validation("name", "the name must be 1-100 characters"));
    }
    let app_version = request.app_version.trim();
    if app_version.is_empty() || app_version.len() > 50 {
        return Err(ApiError::validation(
            "appVersion",
            "the app version must be 1-50 characters",
        ));
    }
    if request.capabilities.len() > 32
        || request
            .capabilities
            .iter()
            .any(|capability| capability.is_empty() || capability.len() > 64)
    {
        return Err(ApiError::validation(
            "capabilities",
            "at most 32 capabilities of 1-64 characters",
        ));
    }
    // The guard already checked the header; record the version this device speaks.
    let protocol: i64 = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(i64::from(markiro_proto::PROTOCOL_VERSION));

    let id = uuid::Uuid::new_v4().to_string();
    let key = random_key();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, capabilities, paired_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(request.kind.as_str())
    .bind(name)
    .bind(key_hash(&key))
    .bind(app_version)
    .bind(protocol)
    .bind(serde_json::to_string(&request.capabilities).map_err(ApiError::internal)?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &now,
        Entry {
            actor: Actor::Device(&id),
            action: "device.local_pair",
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "kind": request.kind.as_str(), "name": name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(PairResponse {
        device_id: id,
        device_key: key,
        host_id: state.host_id.clone(),
    }))
}

pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let (name, line_id, paired_at): (String, Option<String>, String) =
        sqlx::query_as("SELECT name, line_id, paired_at FROM devices WHERE id = ?")
            .bind(&device.id)
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(DeviceInfo {
        id: device.id,
        kind: device.kind,
        name,
        line_id,
        paired_at,
    }))
}
```

В `apps/standalone/host/src/lib.rs` добавить модули `pub mod audit;`, `pub mod auth;`, `pub mod routes;`, `pub mod secrets;`.

В `apps/standalone/host/src/server.rs` добавить импорт `use axum::routing::post;` (рядом с `get`) и заменить `router` на:

```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .with_state(state)
}

/// Routes behind the protocol guard.
fn protected_routes() -> Router<AppState> {
    Router::new()
        .route("/v1/local-pair", post(crate::routes::pairing::local_pair))
        .route("/v1/device", get(crate::routes::pairing::device_info))
}
```

(Импорт `middleware` теперь используется в основном коде.)

В `apps/standalone/AGENTS.md` после раздела «Three identities» добавить:

```markdown
## Local pairing trust

`POST /v1/local-pair` and `POST /v1/bootstrap` accept only loopback peers, and
loopback is their only gate: any process on the host PC can pair a device.
That is acceptable because the host PC is the site's trusted machine; the
app pins the certificate it observed over loopback. Devices on the network
pair only with a one-time code (plan 1c).

## Audit

Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Tests assert the exact actor, action, target, result and
details; details never hold secrets, salts or hashes.
```

- [ ] **Step 6: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
Expected: все тесты PASS, в том числе 5 новых в `pairing.rs`, 2 модульных в `secrets.rs` и 2 новых теста фикстур.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/proto apps/standalone/host apps/standalone/AGENTS.md
git commit -m "feat(standalone): устройства, журнал действий и подключение местной станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Пароли, офисные сессии и вход

**Files:**

- Create: `apps/standalone/host/migrations/0003_office_auth.sql`, `apps/standalone/host/src/rate_limit.rs`, `apps/standalone/host/src/validate.rs`, `apps/standalone/host/src/routes/office_auth.rs`, `apps/standalone/host/tests/office_auth.rs`, `apps/standalone/proto/fixtures/office-login-request.json`, `apps/standalone/proto/fixtures/office-session.json`, `apps/standalone/proto/fixtures/office-user.json`, `apps/standalone/proto/fixtures/phc-password.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/secrets.rs`, `apps/standalone/host/src/auth.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/tests/support/app.rs`

**Interfaces:**

- Consumes: всё из задач 1–2.
- Produces:
  - proto: `OFFICE_SESSION_HEADER = "x-office-session"`, `OfficeRole { Admin, Technologist }` (`snake_case`, `as_str()`), `OfficeLoginRequest { login, password }` (`deny_unknown_fields`), `OfficeUser { id, login, name, role }`, `OfficeSession { token, user, expires_at }`.
  - `secrets::{PASSWORD_ITERATIONS, Phc, parse_phc, hash_password, verify_password, dummy_password_phc}`.
  - `rate_limit::RateLimiter::{new(max, window, clock), check(IpAddr) -> Result<(), ApiError>}`; поле `AppState.login_limiter: Arc<RateLimiter>` (10 попыток в минуту), создаётся в `AppState::new`.
  - `validate::{office_login(field, &str) -> Result<(), ApiError>, person_name(field, &str) -> Result<String, ApiError>, password(field, &str) -> Result<(), ApiError>}`.
  - `auth::{SESSION_IDLE, SESSION_ABSOLUTE, OfficeContext { device_id, session_id, user }, OfficeContext::{actor, require_admin}, open_session(&mut SqliteConnection, user_id, device_id, now: OffsetDateTime) -> Result<(String, OffsetDateTime), sqlx::Error>, end_session(&mut SqliteConnection, session_id) -> Result<(), sqlx::Error>}`; `OfficeContext` — экстрактор.
  - Фикстура `phc-password.json`: PHC пароля в формате хоста и PHC PIN, созданная `@markiro/domain` (спецификация, §6); TypeScript-сторону проверки добавляет план 1b2.
  - Маршруты `POST /v1/office/login`, `POST /v1/office/logout` (204), `GET /v1/office/me`.
  - Обвязка тестов: `support::app::{seed_office_user(&TestApp, login, role, password) -> String, login(&TestApp, device_key, login, password) -> String /*token*/, with_session(builder, device_key, token) -> Builder}`.

- [ ] **Step 1: Миграция**

`apps/standalone/host/migrations/0003_office_auth.sql`:

```sql
-- Office users (spec §4.3). Logins are ASCII and compared without case.
CREATE TABLE office_users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(login) BETWEEN 3 AND 64),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  role TEXT NOT NULL CHECK (role IN ('admin', 'technologist')),
  password_phc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  rev INTEGER NOT NULL
);

-- Office sessions, bound to the device they were opened on. Only the SHA-256
-- of the token is stored. `expires_at` is the absolute limit; the idle limit
-- is computed from `last_seen_at`. Ended and expired sessions are deleted;
-- the audit log keeps the history of logins and logouts.
CREATE TABLE office_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES office_users (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX office_sessions_user ON office_sessions (user_id);
```

- [ ] **Step 2: Типы протокола и фикстуры**

В `apps/standalone/proto/src/lib.rs` добавить константу рядом с `PROTOCOL_HEADER`:

```rust
/// Request header carrying the office session token.
pub const OFFICE_SESSION_HEADER: &str = "x-office-session";
```

и типы в конец файла:

```rust
/// Role of an office user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfficeRole {
    Admin,
    Technologist,
}

impl OfficeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            OfficeRole::Admin => "admin",
            OfficeRole::Technologist => "technologist",
        }
    }
}

/// `POST /v1/office/login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeLoginRequest {
    pub login: String,
    pub password: String,
}

/// The signed-in office user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUser {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
}

/// A new office session; the token is shown exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSession {
    pub token: String,
    pub user: OfficeUser,
    /// Absolute expiry; the session also ends after 30 idle minutes.
    pub expires_at: String,
}
```

`apps/standalone/proto/fixtures/office-login-request.json`:

```json
{
  "login": "admin",
  "password": "correct horse battery"
}
```

`apps/standalone/proto/fixtures/office-user.json`:

```json
{
  "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  "login": "admin",
  "name": "Ирина Смирнова",
  "role": "admin"
}
```

`apps/standalone/proto/fixtures/office-session.json`:

```json
{
  "token": "Zx8c1Qe-3aTf9GhJkLm2Np4Rs6Uv8Wy0Ab2Cd4Ef6Gh",
  "user": {
    "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
    "login": "admin",
    "name": "Ирина Смирнова",
    "role": "admin"
  },
  "expiresAt": "2026-09-26T21:15:00Z"
}
```

`apps/standalone/proto/fixtures/phc-password.json` — `passwordPhc` в формате хоста (600 000 итераций, посчитан независимо через Python `hashlib.pbkdf2_hmac`, `verifyPhc` из `@markiro/domain` его принимает), `pinPhc` создан `deriveDigestB64` + `formatPhc` из `@markiro/domain`:

```json
{
  "password": "correct horse battery",
  "passwordPhc": "pbkdf2$sha256$600000$bWFya2lyby1ob3N0LXB3ZA==$I+1UisWSgOjI03mX2uVw6S0ntlhUtVrfJb3svIAJNh8=",
  "pin": "4821",
  "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить к импортам `OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser` и тест:

```rust
#[test]
fn office_auth_fixtures_round_trip() {
    let _: OfficeLoginRequest = round_trip("office-login-request.json");
    let user: OfficeUser = round_trip("office-user.json");
    assert_eq!(user.role, OfficeRole::Admin);
    let session: OfficeSession = round_trip("office-session.json");
    assert_eq!(session.user, user);
}
```

- [ ] **Step 3: Написать падающие тесты**

В конец `apps/standalone/host/tests/support/app.rs` добавить:

```rust
/// Insert an active office user directly; returns its id.
pub async fn seed_office_user(app: &TestApp, login: &str, role: &str, password: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let phc = markiro_host::secrets::hash_password(password);
    let mut tx = markiro_host::db::begin_write(&app.state.pool).await.unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(login)
    .bind(format!("Пользователь {login}"))
    .bind(role)
    .bind(phc)
    .bind(app.state.timestamp())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// Add the device key and the office session token.
pub fn with_session(builder: Builder, device_key: &str, token: &str) -> Builder {
    with_device(builder, device_key).header(markiro_proto::OFFICE_SESSION_HEADER, token)
}

/// Log in on the device; returns the session token.
pub async fn login(app: &TestApp, device_key: &str, login: &str, password: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/office/login"), device_key),
            serde_json::json!({ "login": login, "password": password }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["token"].as_str().unwrap().to_owned()
}
```

`apps/standalone/host/tests/office_auth.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    empty, json as json_request, login, pair_device, request, seed_office_user, with_device,
    with_session, TestApp, LAN, LOOPBACK,
};

async fn last_audit(app: &TestApp) -> (String, Option<String>, String, Option<String>, String, Value) {
    let (actor_kind, actor_id, action, target_id, result, details): (String, Option<String>, String, Option<String>, String, String) =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_id, result, details FROM audit_log ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    (actor_kind, actor_id, action, target_id, result, serde_json::from_str(&details).unwrap())
}

#[tokio::test]
async fn login_opens_a_session_bound_to_the_device() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "IRINA", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = body["token"].as_str().unwrap();
    assert_eq!(token.len(), 43);
    assert_eq!(body["user"], json!({ "id": user_id, "login": "irina", "name": "Пользователь irina", "role": "admin" }));
    let expected_expiry = markiro_host::clock::format_timestamp(app.state.now() + time::Duration::hours(12));
    assert_eq!(body["expiresAt"], expected_expiry);

    let (stored_user, stored_device): (String, String) =
        sqlx::query_as("SELECT user_id, device_id FROM office_sessions WHERE token_hash = ?")
            .bind(key_hash(token))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!((stored_user.as_str(), stored_device.as_str()), (user_id.as_str(), device_id.as_str()));
    assert_eq!(
        last_audit(&app).await,
        ("device".into(), Some(device_id), "office.login".into(), Some(user_id), "ok".into(), json!({ "login": "irina" }))
    );
}

#[tokio::test]
async fn wrong_password_unknown_login_and_inactive_user_are_denied_and_audited() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "irina", "password": "wrong password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        last_audit(&app).await,
        ("device".into(), Some(device_id.clone()), "office.login".into(), Some(user_id.clone()), "denied".into(), json!({ "login": "irina" }))
    );

    let (status, _) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "nobody", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        last_audit(&app).await,
        ("device".into(), Some(device_id), "office.login".into(), None, "denied".into(), json!({ "login": "nobody" }))
    );

    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&user_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, _) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_requires_a_device() {
    let app = TestApp::new().await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let (status, _) = app
        .send(json_request(
            request("POST", "/v1/office/login"),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_reloads_role_and_rejects_foreign_devices() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let (_, other_key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    let (status, body) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["role"], "admin");

    sqlx::query("UPDATE office_users SET role = 'technologist' WHERE id = ?")
        .bind(&user_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (_, body) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(body["role"], "technologist");

    let (status, _) = app.send(empty(with_session(request("GET", "/v1/office/me"), &other_key, &token))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app.send(empty(with_device(request("GET", "/v1/office/me"), &key))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sessions_end_after_idle_and_absolute_limits() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let token = login(&app, &key, "irina", "correct horse battery").await;
    app.clock.advance(time::Duration::minutes(29));
    let (status, _) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(status, StatusCode::OK);
    app.clock.advance(time::Duration::minutes(31));
    let (status, body) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["message"], "office session expired");
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?")
        .bind(key_hash(&token))
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "an expired session is deleted");

    let token = login(&app, &key, "irina", "correct horse battery").await;
    for _ in 0..24 {
        app.clock.advance(time::Duration::minutes(29));
        let (status, _) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
        assert_eq!(status, StatusCode::OK);
    }
    app.clock.advance(time::Duration::minutes(29));
    let (status, _) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "12 hours is the absolute limit");
}

#[tokio::test]
async fn logout_ends_the_session_and_is_audited() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    let (status, body) = app.send(empty(with_session(request("POST", "/v1/office/logout"), &key, &token))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);
    let (status, _) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, &token))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (actor_kind, actor_id, action, target_id, result, details) = last_audit(&app).await;
    assert_eq!(
        (actor_kind.as_str(), actor_id.as_deref(), action.as_str(), target_id.as_deref(), result.as_str()),
        ("office_user", Some(user_id.as_str()), "office.logout", Some(user_id.as_str()), "ok")
    );
    assert_eq!(details, json!({}));
}

#[tokio::test]
async fn login_attempts_are_limited_per_address() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let attempt = |peer: ([u8; 4], u16)| {
        let app = &app;
        let key = key.clone();
        async move {
            app.send_from(
                peer,
                json_request(
                    with_device(request("POST", "/v1/office/login"), &key),
                    json!({ "login": "nobody", "password": "whatever-password" }),
                ),
            )
            .await
        }
    };
    for _ in 0..10 {
        assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
    }
    let (status, body) = attempt(LAN).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
    assert_eq!(attempt(LOOPBACK).await.0, StatusCode::UNAUTHORIZED);
    app.clock.advance(time::Duration::seconds(61));
    assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
}
```

Модульные тесты PHC — в `secrets.rs` (шаг 5).

- [ ] **Step 4: Убедиться, что тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_auth`
Expected: FAIL — нет `hash_password`, маршрутов офиса.

- [ ] **Step 5: Реализовать**

В `apps/standalone/host/src/secrets.rs` обновить doc-комментарий модуля на «Secrets: random device keys and session tokens, their stored hashes, and the PBKDF2 PHC format for office passwords, shared with `@markiro/domain` (`crypto/phc.ts`).», добавить импорты `use std::num::NonZeroU32;`, `use std::sync::OnceLock;`, `use aws_lc_rs::pbkdf2;`, `use base64::engine::general_purpose::STANDARD;` и код (над `#[cfg(test)]`):

```rust
/// Iterations for office passwords, verified only on the host, so it can
/// afford more work than a kiosk tablet. PINs and badges keep the domain's
/// 100 000.
pub const PASSWORD_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const DIGEST_BYTES: usize = 32;
/// The domain's floor: a tampered verifier must not cheapen the work.
const MIN_ITERATIONS: u32 = 10_000;

/// A parsed `pbkdf2$sha256$<iterations>$<salt>$<digest>` string.
pub struct Phc {
    pub iterations: u32,
    salt: Vec<u8>,
    digest: Vec<u8>,
}

/// Parse a PHC string in the `@markiro/domain` format: canonical standard
/// base64 with padding, a 16-byte salt and a 32-byte digest. Stricter than
/// `parsePhc` on the iteration count, which must be plain ASCII digits.
pub fn parse_phc(text: &str) -> Option<Phc> {
    let mut parts = text.split('$');
    let (Some("pbkdf2"), Some("sha256"), Some(iterations), Some(salt), Some(digest), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    if !iterations.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let iterations: u32 = iterations.parse().ok()?;
    if iterations < MIN_ITERATIONS {
        return None;
    }
    Some(Phc {
        iterations,
        salt: decode_canonical(salt, SALT_BYTES)?,
        digest: decode_canonical(digest, DIGEST_BYTES)?,
    })
}

fn decode_canonical(text: &str, expected_bytes: usize) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(text).ok()?;
    (bytes.len() == expected_bytes && STANDARD.encode(&bytes) == text).then_some(bytes)
}

/// Hash a password for storage with a fresh random salt.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_BYTES];
    aws_lc_rs::rand::fill(&mut salt).expect("the system random generator is available");
    let mut digest = [0u8; DIGEST_BYTES];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PASSWORD_ITERATIONS).expect("non-zero"),
        &salt,
        password.as_bytes(),
        &mut digest,
    );
    format!(
        "pbkdf2$sha256${PASSWORD_ITERATIONS}${}${}",
        STANDARD.encode(salt),
        STANDARD.encode(digest)
    )
}

/// Constant-time check of `password` against a stored PHC string; a
/// malformed verifier never matches.
pub fn verify_password(phc: &str, password: &str) -> bool {
    let Some(parsed) = parse_phc(phc) else {
        return false;
    };
    let iterations = NonZeroU32::new(parsed.iterations).expect("parse_phc enforces the floor");
    pbkdf2::verify(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &parsed.salt,
        password.as_bytes(),
        &parsed.digest,
    )
    .is_ok()
}

/// A verifier for a password nobody has: an unknown login costs the same as
/// a wrong password.
pub fn dummy_password_phc() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("markiro: no such office user"))
}
```

и в модуль тестов `secrets.rs` добавить:

```rust
    /// Computed independently with Python's `hashlib.pbkdf2_hmac`.
    const REFERENCE: &str =
        "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=";

    #[test]
    fn verifies_an_independently_computed_phc() {
        assert!(verify_password(REFERENCE, "correct horse battery"));
        assert!(!verify_password(REFERENCE, "correct horse batterY"));
    }

    #[test]
    fn hashes_round_trip_in_the_domain_format() {
        let phc = hash_password("пароль-сотрудника");
        let parts: Vec<&str> = phc.split('$').collect();
        assert_eq!(parts[..3], ["pbkdf2", "sha256", "600000"]);
        assert_eq!(parts[3].len(), 24);
        assert_eq!(parts[4].len(), 44);
        assert!(verify_password(&phc, "пароль-сотрудника"));
        assert!(!verify_password(&phc, "другой пароль"));
    }

    /// Spec §6: the host and `@markiro/domain` read each other's PHC strings.
    #[test]
    fn shares_the_phc_format_with_the_domain() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/phc-password.json")).unwrap();
        let text = |key: &str| fixture[key].as_str().unwrap().to_owned();
        assert!(verify_password(&text("passwordPhc"), &text("password")));
        assert!(verify_password(&text("pinPhc"), &text("pin")));
        assert_eq!(parse_phc(&text("pinPhc")).unwrap().iterations, 100_000);
    }

    #[test]
    fn malformed_verifiers_never_match() {
        for bad in [
            "pbkdf2$sha256$9999$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha1$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$+10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=$x",
            "",
        ] {
            assert!(parse_phc(bad).is_none(), "{bad}");
            assert!(!verify_password(bad, "correct horse battery"), "{bad}");
        }
    }
```

`apps/standalone/host/src/validate.rs`:

```rust
//! Input rules the host enforces itself. Marking rules (GTIN, KM, labels)
//! stay in `@markiro/domain`; these are structural checks of host data.

use crate::error::ApiError;

/// Office login: ASCII letters, digits, `.`, `_`, `-`; 3-64 characters.
pub fn office_login(field: &str, login: &str) -> Result<(), ApiError> {
    let valid = (3..=64).contains(&login.len())
        && login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "3-64 Latin letters, digits, dots, underscores or hyphens",
        ))
    }
}

/// A person's display name: trimmed, 1-100 characters.
pub fn person_name(field: &str, name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        Err(ApiError::validation(field, "the name must be 1-100 characters"))
    } else {
        Ok(trimmed.to_owned())
    }
}

/// A password: 8-128 characters (the upper bound keeps PBKDF2 input small).
pub fn password(field: &str, password: &str) -> Result<(), ApiError> {
    if (8..=128).contains(&password.chars().count()) {
        Ok(())
    } else {
        Err(ApiError::validation(field, "the password must be 8-128 characters"))
    }
}
```

`apps/standalone/host/src/rate_limit.rs`:

```rust
//! Per-address attempt limit for office login (and, from plan 1c, pairing
//! claims): at most `max` attempts within a sliding `window`.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use time::{Duration, OffsetDateTime};

use crate::clock::Clock;
use crate::error::ApiError;

pub struct RateLimiter {
    max: usize,
    window: Duration,
    clock: Arc<dyn Clock>,
    attempts: Mutex<HashMap<IpAddr, VecDeque<OffsetDateTime>>>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration, clock: Arc<dyn Clock>) -> Self {
        Self {
            max,
            window,
            clock,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Count one attempt from `ip`; refuse it when the window is already full.
    pub fn check(&self, ip: IpAddr) -> Result<(), ApiError> {
        let now = self.clock.now();
        let mut attempts = self.attempts.lock().expect("rate limiter lock");
        attempts.retain(|_, seen| {
            while seen.front().is_some_and(|at| *at <= now - self.window) {
                seen.pop_front();
            }
            !seen.is_empty()
        });
        let seen = attempts.entry(ip.to_canonical()).or_default();
        if seen.len() >= self.max {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                markiro_proto::codes::RATE_LIMITED,
                "too many attempts, try again later",
            ));
        }
        seen.push_back(now);
        Ok(())
    }
}
```

В `apps/standalone/host/src/server.rs`:

- в `AppState` добавить поле `pub login_limiter: Arc<crate::rate_limit::RateLimiter>,` и в `AppState::new` инициализировать его: `login_limiter: Arc::new(crate::rate_limit::RateLimiter::new(10, time::Duration::minutes(1), clock.clone())),` (перед перемещением `clock` в поле);
- в `protected_routes` добавить маршруты:

```rust
        .route("/v1/office/login", post(crate::routes::office_auth::login))
        .route("/v1/office/logout", post(crate::routes::office_auth::logout))
        .route("/v1/office/me", get(crate::routes::office_auth::me))
```

В `apps/standalone/host/src/auth.rs` добавить импорты `use markiro_proto::{OfficeRole, OfficeUser, OFFICE_SESSION_HEADER};`, `use sqlx::SqliteConnection;`, `use time::OffsetDateTime;`, `use crate::audit::Actor;`, `use crate::clock::parse_timestamp;`, `use crate::secrets::random_key;` и код:

```rust
/// Office sessions end after 30 idle minutes or 12 hours (spec §2, decision 7).
pub const SESSION_IDLE: time::Duration = time::Duration::minutes(30);
pub const SESSION_ABSOLUTE: time::Duration = time::Duration::hours(12);

/// A live office session on the requesting device. The user's role and
/// activity are read from the database on every request.
#[derive(Debug, Clone)]
pub struct OfficeContext {
    pub device_id: String,
    pub session_id: String,
    pub user: OfficeUser,
}

impl OfficeContext {
    pub fn actor(&self) -> Actor<'_> {
        Actor::OfficeUser(&self.user.id)
    }

    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.user.role == OfficeRole::Admin {
            Ok(())
        } else {
            Err(ApiError::forbidden("the administrator role is required"))
        }
    }
}

type SessionRow = (String, String, String, String, String, String, String, i64);

impl FromRequestParts<AppState> for OfficeContext {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let device = AuthDevice::from_request_parts(parts, state).await?;
        let token = parts
            .headers
            .get(OFFICE_SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|token| !token.is_empty())
            .ok_or_else(|| ApiError::unauthorized("an office session is required"))?;
        let row: Option<SessionRow> = sqlx::query_as(
            "SELECT s.id, s.last_seen_at, s.expires_at, u.id, u.login, u.name, u.role, u.active \
             FROM office_sessions s JOIN office_users u ON u.id = s.user_id \
             WHERE s.token_hash = ? AND s.device_id = ? AND s.ended_at IS NULL",
        )
        .bind(key_hash(token))
        .bind(&device.id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        let (session_id, last_seen_at, expires_at, user_id, login, name, role, active) =
            row.ok_or_else(|| ApiError::unauthorized("unknown or ended office session"))?;
        let now = state.now();
        let last_seen = parse_timestamp(&last_seen_at).map_err(ApiError::internal)?;
        let expires = parse_timestamp(&expires_at).map_err(ApiError::internal)?;
        if now >= expires || now >= last_seen + SESSION_IDLE || active == 0 {
            let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
            end_session(&mut conn, &session_id)
                .await
                .map_err(ApiError::internal)?;
            return Err(ApiError::unauthorized("office session expired"));
        }
        sqlx::query("UPDATE office_sessions SET last_seen_at = ? WHERE id = ?")
            .bind(format_timestamp(now))
            .bind(&session_id)
            .execute(&state.pool)
            .await
            .map_err(ApiError::internal)?;
        let role: OfficeRole =
            serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)?;
        Ok(Self {
            device_id: device.id,
            session_id,
            user: OfficeUser {
                id: user_id,
                login,
                name,
                role,
            },
        })
    }
}

/// Open a session for `user_id` on `device_id`; returns the token (shown
/// once) and the absolute expiry.
pub async fn open_session(
    conn: &mut SqliteConnection,
    user_id: &str,
    device_id: &str,
    now: OffsetDateTime,
) -> Result<(String, OffsetDateTime), sqlx::Error> {
    // Sessions nobody ended (the app was simply closed) are cleared here.
    sqlx::query("DELETE FROM office_sessions WHERE expires_at <= ? OR last_seen_at <= ?")
        .bind(format_timestamp(now))
        .bind(format_timestamp(now - SESSION_IDLE))
        .execute(&mut *conn)
        .await?;
    let token = random_key();
    let expires = now + SESSION_ABSOLUTE;
    sqlx::query(
        "INSERT INTO office_sessions (id, token_hash, user_id, device_id, created_at, last_seen_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(key_hash(&token))
    .bind(user_id)
    .bind(device_id)
    .bind(format_timestamp(now))
    .bind(format_timestamp(now))
    .bind(format_timestamp(expires))
    .execute(conn)
    .await?;
    Ok((token, expires))
}

pub async fn end_session(conn: &mut SqliteConnection, session_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM office_sessions WHERE id = ?")
        .bind(session_id)
        .execute(conn)
        .await?;
    Ok(())
}
```

`apps/standalone/host/src/routes/office_auth.rs`:

```rust
//! Office sign-in: `POST /v1/office/login`, `POST /v1/office/logout`,
//! `GET /v1/office/me`.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{end_session, open_session, AuthDevice, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::secrets::{dummy_password_phc, verify_password};
use crate::server::AppState;

type UserRow = (String, String, String, String, String, i64);

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<OfficeLoginRequest>,
) -> Result<Json<OfficeSession>, ApiError> {
    state.login_limiter.check(peer.ip())?;
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, password_phc, active FROM office_users WHERE login = ?",
    )
    .bind(&request.login)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    // Always run PBKDF2 so an unknown login costs the same as a wrong password;
    // the dummy verifier is built on first use, also off the async threads.
    let stored_phc = row.as_ref().map(|row| row.4.clone());
    let password = request.password.clone();
    let password_ok = tokio::task::spawn_blocking(move || {
        let phc = stored_phc.as_deref().unwrap_or_else(dummy_password_phc);
        verify_password(phc, &password)
    })
    .await
    .map_err(ApiError::internal)?;

    let now = state.now();
    let at = format_timestamp(now);
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    match row {
        Some((id, login, name, role, _, active)) if password_ok && active == 1 => {
            let role: OfficeRole = serde_json::from_value(serde_json::Value::String(role))
                .map_err(ApiError::internal)?;
            let (token, expires) = open_session(&mut tx, &id, &device.id, now)
                .await
                .map_err(ApiError::internal)?;
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: "office.login",
                    target_type: Some("office_user"),
                    target_id: Some(&id),
                    outcome: Outcome::Ok,
                    details: json!({ "login": login }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Ok(Json(OfficeSession {
                token,
                user: OfficeUser {
                    id,
                    login,
                    name,
                    role,
                },
                expires_at: format_timestamp(expires),
            }))
        }
        other => {
            let target = other.as_ref().map(|row| row.0.as_str());
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: "office.login",
                    target_type: Some("office_user"),
                    target_id: target,
                    outcome: Outcome::Denied,
                    details: json!({ "login": request.login }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Err(ApiError::unauthorized("wrong login or password"))
        }
    }
}

pub async fn logout(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<StatusCode, ApiError> {
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    end_session(&mut tx, &context.session_id)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office.logout",
            target_type: Some("office_user"),
            target_id: Some(&context.user.id),
            outcome: Outcome::Ok,
            details: json!({}),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(context: OfficeContext) -> Json<OfficeUser> {
    Json(context.user)
}
```

В `apps/standalone/host/src/routes/mod.rs` добавить `pub mod office_auth;`, в `apps/standalone/host/src/lib.rs` — `pub mod rate_limit;` и `pub mod validate;` (`validate` понадобится задаче 4; модуль и его функции публичные, предупреждений о неиспользуемом коде не будет).

- [ ] **Step 6: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
Expected: все тесты PASS, включая 7 новых в `office_auth.rs`, 4 модульных теста PHC и тест фикстур офиса. Хеширование 600 000 итераций в тестах должно занимать доли секунды благодаря профилю из задачи 1; если отдельный тест идёт дольше 10 с, проверьте, что профиль применился (`cargo test -v` показывает `-O3`/`opt-level=3` для `aws-lc-sys`).

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/proto apps/standalone/host
git commit -m "feat(standalone): пароли PHC, офисные сессии и вход с ограничением попыток" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Мастер первого запуска и профиль организации

**Files:**

- Create: `apps/standalone/host/migrations/0004_org_sscc.sql`, `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/host/src/routes/org.rs`, `apps/standalone/host/tests/bootstrap.rs`, `apps/standalone/proto/fixtures/bootstrap-request.json`, `apps/standalone/proto/fixtures/bootstrap-response.json`, `apps/standalone/proto/fixtures/org-profile.json`, `apps/standalone/proto/fixtures/org-profile-update.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/validate.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/tests/support/app.rs`

**Interfaces:**

- Consumes: всё из задач 1–3.
- Produces:
  - proto: `NewOfficeUser { login, name, password }`, `OrgProfileInput { name, inn: Option<String>, gln, gs1_prefixes, time_zone }`, `SsccStart { box_next_serial: u64, pallet_next_serial: u64 }`, `BootstrapRequest { admin, org, sscc, lines: Vec<String> }` (все `deny_unknown_fields`); `BootstrapResponse { session: OfficeSession }`; `OrgProfile { name, inn, gln, gs1_prefixes, time_zone, rev }`; `OrgProfileUpdate { name, inn, gln, gs1_prefixes, time_zone, expected_rev }` (`deny_unknown_fields`).
  - `validate::{ValidOrg { name, inn, gln, gs1_prefixes, time_zone }, org(prefix: &str, input) -> Result<ValidOrg, ApiError>, issuer_prefix(gln: &str) -> &str, serial_capacity(prefix: &str) -> u64, first_serial(extension: u8) -> u64, sscc_serial(field, extension, prefix, serial) -> Result<(), ApiError>, line_name(field, &str) -> Result<(String /*name*/, String /*name_key*/), ApiError>}` (`line_name` понадобится экранам линий в плане 1d).
  - Маршруты `POST /v1/bootstrap`, `GET /v1/office/org`, `PUT /v1/office/org`.
  - Обвязка тестов: `support::app::{bootstrap_body() -> Value, bootstrap(&TestApp, device_key) -> String /*admin token*/}`.

- [ ] **Step 1: Миграция**

`apps/standalone/host/migrations/0004_org_sscc.sql`:

```sql
-- The organization (one row). Default label template columns are added with
-- the templates table in plan 1e.
CREATE TABLE org_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  inn TEXT CHECK (inn IS NULL OR (length(inn) IN (10, 12) AND inn NOT GLOB '*[^0-9]*')),
  gln TEXT NOT NULL CHECK (length(gln) = 13 AND gln NOT GLOB '*[^0-9]*'),
  gs1_prefixes TEXT NOT NULL CHECK (json_valid(gs1_prefixes) AND json_type(gs1_prefixes) = 'array'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  rev INTEGER NOT NULL
);

-- SSCC counters per issuer prefix (the first 9 digits of the GLN, as in the
-- cloud) and extension digit (0 = box, 1 = pallet).
CREATE TABLE sscc_counters (
  issuer_prefix TEXT NOT NULL
    CHECK (length(issuer_prefix) BETWEEN 4 AND 12 AND issuer_prefix NOT GLOB '*[^0-9]*'),
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  next_serial INTEGER NOT NULL CHECK (next_serial >= 0),
  rev INTEGER NOT NULL,
  PRIMARY KEY (issuer_prefix, extension)
);
```

- [ ] **Step 2: Типы протокола и фикстуры**

В `apps/standalone/proto/src/lib.rs` добавить:

```rust
/// A new office user created by the first-run wizard (always an administrator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewOfficeUser {
    pub login: String,
    pub name: String,
    pub password: String,
}

/// Organization fields as entered in the wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgProfileInput {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

/// First serials of the SSCC counters; needed when the company already
/// printed SSCC with other software.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccStart {
    pub box_next_serial: u64,
    pub pallet_next_serial: u64,
}

/// `POST /v1/bootstrap`: the first-run wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub admin: NewOfficeUser,
    pub org: OrgProfileInput,
    pub sscc: SsccStart,
    /// Names of the first production lines (1-20).
    pub lines: Vec<String>,
}

/// Response of `POST /v1/bootstrap`: the administrator is signed in on the
/// device that ran the wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub session: OfficeSession,
}

/// `GET /v1/office/org`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgProfile {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
    pub rev: i64,
}

/// `PUT /v1/office/org`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgProfileUpdate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
    pub expected_rev: i64,
}
```

`apps/standalone/proto/fixtures/bootstrap-request.json`:

```json
{
  "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
  "org": {
    "name": "ООО «Атолл»",
    "inn": "7701234567",
    "gln": "4600682000010",
    "gs1Prefixes": ["4600682"],
    "timeZone": "Europe/Moscow"
  },
  "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
  "lines": ["Линия 1"]
}
```

`apps/standalone/proto/fixtures/bootstrap-response.json`:

```json
{
  "session": {
    "token": "Zx8c1Qe-3aTf9GhJkLm2Np4Rs6Uv8Wy0Ab2Cd4Ef6Gh",
    "user": {
      "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
      "login": "admin",
      "name": "Ирина Смирнова",
      "role": "admin"
    },
    "expiresAt": "2026-09-26T21:15:00Z"
  }
}
```

`apps/standalone/proto/fixtures/org-profile.json`:

```json
{
  "name": "ООО «Атолл»",
  "inn": "7701234567",
  "gln": "4600682000010",
  "gs1Prefixes": ["4600682"],
  "timeZone": "Europe/Moscow",
  "rev": 1
}
```

`apps/standalone/proto/fixtures/org-profile-update.json`:

```json
{
  "name": "ООО «Атолл»",
  "inn": null,
  "gln": "4600682000010",
  "gs1Prefixes": ["4600682", "4607091"],
  "timeZone": "Europe/Samara",
  "expectedRev": 1
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить к импортам `BootstrapRequest, BootstrapResponse, OrgProfile, OrgProfileUpdate` и тест:

```rust
#[test]
fn bootstrap_and_org_fixtures_round_trip() {
    let bootstrap: BootstrapRequest = round_trip("bootstrap-request.json");
    assert_eq!(bootstrap.sscc.pallet_next_serial, 0);
    assert_eq!(bootstrap.lines, vec!["Линия 1".to_owned()]);
    let response: BootstrapResponse = round_trip("bootstrap-response.json");
    assert_eq!(response.session.user.login, "admin");
    let _: OrgProfile = round_trip("org-profile.json");
    let update: OrgProfileUpdate = round_trip("org-profile-update.json");
    assert!(update.inn.is_none());
}
```

- [ ] **Step 3: Написать падающие тесты**

В конец `apps/standalone/host/tests/support/app.rs` добавить:

```rust
/// A valid wizard request.
pub fn bootstrap_body() -> Value {
    serde_json::json!({
        "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
        "org": {
            "name": "ООО «Атолл»",
            "inn": "7701234567",
            "gln": "4600682000010",
            "gs1Prefixes": ["4600682"],
            "timeZone": "Europe/Moscow"
        },
        "sscc": { "boxNextSerial": 1500, "palletNextSerial": 40 },
        "lines": ["Линия 1", "Линия 2"]
    })
}

/// Run the wizard from loopback with `device_key`; returns the admin's token.
pub async fn bootstrap(app: &TestApp, device_key: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/bootstrap"), device_key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["session"]["token"].as_str().unwrap().to_owned()
}
```

`apps/standalone/host/tests/bootstrap.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::secrets::verify_password;
use serde_json::{json, Value};
use support::app::{
    bootstrap, bootstrap_body, empty, json as json_request, login, pair_device, request,
    seed_office_user, with_device, with_session, TestApp, LAN,
};

#[tokio::test]
async fn the_wizard_initializes_the_host_and_signs_the_admin_in() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "station").await;
    let (status, body) = app
        .send(json_request(with_device(request("POST", "/v1/bootstrap"), &key), bootstrap_body()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let session = &body["session"];
    assert_eq!(session["user"]["login"], "admin");
    assert_eq!(session["user"]["role"], "admin");
    let admin_id = session["user"]["id"].as_str().unwrap().to_owned();

    let (initialized_at, salt, site_rev): (Option<String>, Option<Vec<u8>>, i64) =
        sqlx::query_as("SELECT initialized_at, badge_salt, rev FROM site WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(initialized_at, Some(app.state.timestamp()));
    assert_eq!(salt.map(|salt| salt.len()), Some(16));
    assert_eq!(site_rev, 1);

    let org: (String, Option<String>, String, String, String, i64) = sqlx::query_as(
        "SELECT name, inn, gln, gs1_prefixes, time_zone, rev FROM org_profile WHERE id = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        org,
        ("ООО «Атолл»".into(), Some("7701234567".into()), "4600682000010".into(), r#"["4600682"]"#.into(), "Europe/Moscow".into(), 1)
    );
    let counters: Vec<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY extension")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(counters, vec![("460068200".into(), 0, 1500, 1), ("460068200".into(), 1, 40, 1)]);
    let lines: Vec<(String, String, i64, i64)> =
        sqlx::query_as("SELECT name, name_key, archived, rev FROM lines ORDER BY name")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        lines,
        vec![("Линия 1".into(), "линия 1".into(), 0, 1), ("Линия 2".into(), "линия 2".into(), 0, 1)]
    );

    let (phc, role): (String, String) =
        sqlx::query_as("SELECT password_phc, role FROM office_users WHERE id = ?")
            .bind(&admin_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert!(verify_password(&phc, "correct horse battery"));
    assert_eq!(role, "admin");

    let (actor_kind, actor_id, action, target_type, target_id, result, details): (String, Option<String>, String, Option<String>, Option<String>, String, String) =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_type, target_id, result, details FROM audit_log WHERE action = 'host.bootstrap'",
        )
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (actor_kind.as_str(), actor_id.as_deref(), target_type.as_deref(), target_id.as_deref(), result.as_str()),
        ("device", Some(device_id.as_str()), Some("office_user"), Some(admin_id.as_str()), "ok")
    );
    assert_eq!(action, "host.bootstrap");
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "adminLogin": "admin", "orgName": "ООО «Атолл»", "issuerPrefix": "460068200", "lineCount": 2 })
    );

    let token = session["token"].as_str().unwrap();
    let (status, me) = app.send(empty(with_session(request("GET", "/v1/office/me"), &key, token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], admin_id);
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], true);
}

#[tokio::test]
async fn the_wizard_runs_once_from_loopback_with_a_device() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;

    let (status, body) = app
        .send_from(LAN, json_request(with_device(request("POST", "/v1/bootstrap"), &key), bootstrap_body()))
        .await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("loopback_only")));
    let (status, _) = app.send(json_request(request("POST", "/v1/bootstrap"), bootstrap_body())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    bootstrap(&app, &key).await;
    let (status, body) = app
        .send(json_request(with_device(request("POST", "/v1/bootstrap"), &key), bootstrap_body()))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "already_initialized");
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_users")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(users, 1);
}

#[tokio::test]
async fn concurrent_wizards_initialize_exactly_once() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let send = || app.send(json_request(with_device(request("POST", "/v1/bootstrap"), &key), bootstrap_body()));
    let (first, second) = tokio::join!(send(), send());
    let mut statuses = [first.0, second.0];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
}

#[tokio::test]
async fn invalid_wizard_input_names_the_field() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let cases: [(&str, Value, &str); 12] = [
        ("/admin/login", json!("ад"), "admin.login"),
        ("/admin/name", json!("  "), "admin.name"),
        ("/admin/password", json!("short"), "admin.password"),
        ("/org/name", json!(""), "org.name"),
        ("/org/inn", json!("12345"), "org.inn"),
        ("/org/gln", json!("460068200001"), "org.gln"),
        ("/org/gs1Prefixes", json!(["12"]), "org.gs1Prefixes"),
        ("/sscc/boxNextSerial", json!(0), "sscc.boxNextSerial"),
        ("/sscc/palletNextSerial", json!(10_000_000), "sscc.palletNextSerial"),
        ("/lines", json!([]), "lines"),
        ("/lines", json!(["  "]), "lines.0"),
        ("/lines", json!(["Линия 1", " линия 1 "]), "lines.1"),
    ];
    for (pointer, value, field) in cases {
        let mut body = bootstrap_body();
        *body.pointer_mut(pointer).unwrap() = value;
        let (status, response) = app
            .send(json_request(with_device(request("POST", "/v1/bootstrap"), &key), body))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}");
        assert_eq!(response["error"]["code"], "validation_failed", "{field}");
        assert_eq!(response["error"]["details"]["field"], field, "{field}");
    }
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], false);
}

#[tokio::test]
async fn the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let admin_token = bootstrap(&app, &key).await;
    seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let tech_token = login(&app, &key, "tech", "correct horse battery").await;

    let (status, org) = app.send(empty(with_session(request("GET", "/v1/office/org"), &key, &tech_token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(org["gln"], "4600682000010");
    let rev = org["rev"].as_i64().unwrap();

    let update = |expected_rev: i64, gln: &str| {
        json!({
            "name": "ООО «Атолл-Юг»",
            "inn": null,
            "gln": gln,
            "gs1Prefixes": ["4600682", "4607091"],
            "timeZone": "Europe/Samara",
            "expectedRev": expected_rev
        })
    };
    let (status, _) = app
        .send(json_request(with_session(request("PUT", "/v1/office/org"), &key, &tech_token), update(rev, "4600682000010")))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = app
        .send(json_request(with_session(request("PUT", "/v1/office/org"), &key, &admin_token), update(rev - 1, "4600682000010")))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "stale_revision");
    assert_eq!(body["error"]["details"]["currentRev"], rev);

    let (status, body) = app
        .send(json_request(with_session(request("PUT", "/v1/office/org"), &key, &admin_token), update(rev, "4607091000017")))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "ООО «Атолл-Юг»");
    assert_eq!(body["inn"], Value::Null);
    assert!(body["rev"].as_i64().unwrap() > rev);
    let global: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(body["rev"].as_i64().unwrap(), global);

    let counters: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT issuer_prefix, extension, next_serial FROM sscc_counters ORDER BY issuer_prefix, extension")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        counters,
        vec![
            ("460068200".into(), 0, 1500),
            ("460068200".into(), 1, 40),
            ("460709100".into(), 0, 1),
            ("460709100".into(), 1, 0),
        ]
    );
    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'org.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "changed": ["name", "inn", "gln", "gs1Prefixes", "timeZone"] })
    );
}
```

- [ ] **Step 4: Убедиться, что тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test bootstrap`
Expected: FAIL — нет маршрутов мастера и профиля.

- [ ] **Step 5: Реализовать**

В конец `apps/standalone/host/src/validate.rs` добавить:

```rust
use markiro_proto::OrgProfileInput;

/// Organization fields after validation (trimmed, normalized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidOrg {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

fn digits(text: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Validate organization fields; `prefix` is the JSON path of the object in
/// the request (`org` in the wizard, empty for `PUT /v1/office/org`).
pub fn org(prefix: &str, input: &OrgProfileInput) -> Result<ValidOrg, ApiError> {
    let field = |name: &str| {
        if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}.{name}")
        }
    };
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::validation(&field("name"), "the name must be 1-200 characters"));
    }
    let inn = match input.inn.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(inn) if digits(inn, 10..=10) || digits(inn, 12..=12) => Some(inn.to_owned()),
        Some(_) => return Err(ApiError::validation(&field("inn"), "the INN must be 10 or 12 digits")),
    };
    let gln = input.gln.trim();
    if !digits(gln, 13..=13) {
        return Err(ApiError::validation(&field("gln"), "the GLN must be 13 digits"));
    }
    let mut gs1_prefixes: Vec<String> = Vec::new();
    for gs1_prefix in &input.gs1_prefixes {
        let gs1_prefix = gs1_prefix.trim();
        if !digits(gs1_prefix, 4..=12) {
            return Err(ApiError::validation(&field("gs1Prefixes"), "each GS1 prefix must be 4-12 digits"));
        }
        if !gs1_prefixes.iter().any(|known| known == gs1_prefix) {
            gs1_prefixes.push(gs1_prefix.to_owned());
        }
    }
    if gs1_prefixes.len() > 10 {
        return Err(ApiError::validation(&field("gs1Prefixes"), "at most 10 GS1 prefixes"));
    }
    let time_zone = input.time_zone.trim();
    let time_zone_ok = (1..=64).contains(&time_zone.len())
        && time_zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'));
    if !time_zone_ok {
        return Err(ApiError::validation(&field("timeZone"), "an IANA time zone name is required"));
    }
    Ok(ValidOrg {
        name: name.to_owned(),
        inn,
        gln: gln.to_owned(),
        gs1_prefixes,
        time_zone: time_zone.to_owned(),
    })
}

/// SSCC issuer prefix: the first 9 digits of the GLN, as in the cloud
/// (`deriveIssuerPrefix` in apps/api).
pub fn issuer_prefix(gln: &str) -> &str {
    &gln[..9]
}

/// How many serials fit after `prefix` in an SSCC (`buildSscc` in the domain).
pub fn serial_capacity(prefix: &str) -> u64 {
    10u64.pow(16 - prefix.len() as u32)
}

/// The first serial of an extension digit: boxes start at 1, pallets at 0.
pub fn first_serial(extension: u8) -> u64 {
    if extension == 0 {
        1
    } else {
        0
    }
}

/// A production line name: trimmed, 1-100 characters. Returns the name and
/// its uniqueness key (Unicode lower case; SQLite's `lower()` folds ASCII only).
pub fn line_name(field: &str, name: &str) -> Result<(String, String), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        Err(ApiError::validation(field, "the line name must be 1-100 characters"))
    } else {
        Ok((trimmed.to_owned(), trimmed.to_lowercase()))
    }
}

pub fn sscc_serial(field: &str, extension: u8, prefix: &str, serial: u64) -> Result<(), ApiError> {
    let capacity = serial_capacity(prefix);
    if serial < first_serial(extension) || serial >= capacity {
        Err(ApiError::validation(
            field,
            format!("the serial must be {}..{}", first_serial(extension), capacity - 1),
        ))
    } else {
        Ok(())
    }
}
```

(Импорт `use markiro_proto::OrgProfileInput;` поставить в начало файла рядом с `use crate::error::ApiError;`.)

`apps/standalone/host/src/routes/bootstrap.rs`:

```rust
//! The first-run wizard: `POST /v1/bootstrap` (loopback, paired device, host
//! not initialized). One transaction creates the administrator, the badge
//! salt, the organization, the SSCC counters and the first lines and signs
//! the admin in. Stock label templates join in plan 1e.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, BootstrapRequest, BootstrapResponse, OfficeRole, OfficeSession, OfficeUser,
};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{open_session, require_loopback, AuthDevice};
use crate::clock::format_timestamp;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::secrets::hash_password;
use crate::server::AppState;
use crate::validate;

pub async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<BootstrapRequest>,
) -> Result<Json<BootstrapResponse>, ApiError> {
    require_loopback(peer)?;
    let login = request.admin.login.trim().to_owned();
    validate::office_login("admin.login", &login)?;
    let name = validate::person_name("admin.name", &request.admin.name)?;
    validate::password("admin.password", &request.admin.password)?;
    let org = validate::org("org", &request.org)?;
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
    validate::sscc_serial("sscc.boxNextSerial", 0, &prefix, request.sscc.box_next_serial)?;
    validate::sscc_serial("sscc.palletNextSerial", 1, &prefix, request.sscc.pallet_next_serial)?;
    if request.lines.is_empty() || request.lines.len() > 20 {
        return Err(ApiError::validation("lines", "1-20 lines are required"));
    }
    let mut lines: Vec<(String, String)> = Vec::with_capacity(request.lines.len());
    for (index, line) in request.lines.iter().enumerate() {
        let field = format!("lines.{index}");
        let (line_name, name_key) = validate::line_name(&field, line)?;
        if lines.iter().any(|(_, known)| *known == name_key) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push((line_name, name_key));
    }

    // Hash before taking the write lock: PBKDF2 takes a noticeable fraction
    // of a second.
    let password = request.admin.password.clone();
    let password_phc = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(ApiError::internal)?;

    let now = state.now();
    let at = format_timestamp(now);
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let initialized_at: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if initialized_at.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::ALREADY_INITIALIZED,
            "the host is already initialized",
        ));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let admin_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)",
    )
    .bind(&admin_id)
    .bind(&login)
    .bind(&name)
    .bind(&password_phc)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;

    let mut badge_salt = [0u8; 16];
    aws_lc_rs::rand::fill(&mut badge_salt).map_err(|_| ApiError::internal("no system randomness"))?;
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

    sqlx::query(
        "INSERT INTO org_profile (id, name, inn, gln, gs1_prefixes, time_zone, rev) VALUES (1, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;

    for (extension, next_serial) in [
        (0_i64, request.sscc.box_next_serial),
        (1_i64, request.sscc.pallet_next_serial),
    ] {
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?)",
        )
        .bind(&prefix)
        .bind(extension)
        .bind(i64::try_from(next_serial).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }

    for (line_name, name_key) in &lines {
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(line_name)
            .bind(name_key)
            .bind(rev)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }

    let (token, expires) = open_session(&mut tx, &admin_id, &device.id, now)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: "host.bootstrap",
            target_type: Some("office_user"),
            target_id: Some(&admin_id),
            outcome: Outcome::Ok,
            details: json!({
                "adminLogin": login,
                "orgName": org.name,
                "issuerPrefix": prefix,
                "lineCount": lines.len(),
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;

    Ok(Json(BootstrapResponse {
        session: OfficeSession {
            token,
            user: OfficeUser {
                id: admin_id,
                login,
                name,
                role: OfficeRole::Admin,
            },
            expires_at: format_timestamp(expires),
        },
    }))
}
```

`apps/standalone/host/src/routes/org.rs`:

```rust
//! Organization profile: `GET /v1/office/org` (every role) and
//! `PUT /v1/office/org` (administrators, with `expectedRev`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgProfile, OrgProfileInput, OrgProfileUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

type OrgRow = (String, Option<String>, String, String, String, i64);

async fn read_org(conn: &mut SqliteConnection) -> Result<OrgProfile, ApiError> {
    let row: Option<OrgRow> = sqlx::query_as(
        "SELECT name, inn, gln, gs1_prefixes, time_zone, rev FROM org_profile WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let (name, inn, gln, gs1_prefixes, time_zone, rev) =
        row.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    Ok(OrgProfile {
        name,
        inn,
        gln,
        gs1_prefixes: serde_json::from_str(&gs1_prefixes).map_err(ApiError::internal)?,
        time_zone,
        rev,
    })
}

pub async fn get_org(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OrgProfile>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read_org(&mut conn).await.map(Json)
}

pub async fn put_org(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<OrgProfileUpdate>,
) -> Result<Json<OrgProfile>, ApiError> {
    context.require_admin()?;
    let org = validate::org(
        "",
        &OrgProfileInput {
            name: update.name,
            inn: update.inn,
            gln: update.gln,
            gs1_prefixes: update.gs1_prefixes,
            time_zone: update.time_zone,
        },
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let current = read_org(&mut tx).await?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let mut changed = Vec::new();
    if current.name != org.name {
        changed.push("name");
    }
    if current.inn != org.inn {
        changed.push("inn");
    }
    if current.gln != org.gln {
        changed.push("gln");
    }
    if current.gs1_prefixes != org.gs1_prefixes {
        changed.push("gs1Prefixes");
    }
    if current.time_zone != org.time_zone {
        changed.push("timeZone");
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE org_profile SET name = ?, inn = ?, gln = ?, gs1_prefixes = ?, time_zone = ?, rev = ? WHERE id = 1",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    // A new GLN means a new issuer prefix: give it counters at the first
    // serials. Existing counters, including the old prefix's, stay as they are.
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
    for extension in [0_u8, 1] {
        sqlx::query(
            "INSERT OR IGNORE INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?)",
        )
        .bind(&prefix)
        .bind(i64::from(extension))
        .bind(i64::try_from(validate::first_serial(extension)).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "org.update",
            target_type: Some("org_profile"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "changed": changed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_org(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

В `apps/standalone/host/src/routes/mod.rs` добавить `pub mod bootstrap;` и `pub mod org;`; в `protected_routes` (`server.rs`) — маршруты:

```rust
        .route("/v1/bootstrap", post(crate::routes::bootstrap::bootstrap))
        .route(
            "/v1/office/org",
            get(crate::routes::org::get_org).put(crate::routes::org::put_org),
        )
```

- [ ] **Step 6: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
Expected: все тесты PASS, включая 5 новых в `bootstrap.rs` и тест фикстур мастера.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/proto apps/standalone/host
git commit -m "feat(standalone): мастер первого запуска и профиль организации на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: SSCC, офисные пользователи и «секретов нет в журнале»

**Files:**

- Create: `apps/standalone/host/src/routes/sscc.rs`, `apps/standalone/host/src/routes/office_users.rs`, `apps/standalone/host/tests/office_admin.rs`, `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/proto/fixtures/sscc-state.json`, `apps/standalone/proto/fixtures/sscc-counter-update.json`, `apps/standalone/proto/fixtures/block-sizes-update.json`, `apps/standalone/proto/fixtures/office-user-record.json`, `apps/standalone/proto/fixtures/office-user-create.json`, `apps/standalone/proto/fixtures/office-user-update.json`, `apps/standalone/proto/fixtures/password-set.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/routes/mod.rs`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

**Interfaces:**

- Consumes: всё из задач 1–4.
- Produces:
  - proto: `SsccCounter { issuer_prefix, extension: u8, next_serial: u64, max_serial: u64, rev }`, `SsccState { counters, box_block_size: u32, pallet_block_size: u32, rev }`, `SsccCounterUpdate { next_serial, expected_rev }`, `BlockSizesUpdate { box_block_size, pallet_block_size, expected_rev }`, `OfficeUserRecord { id, login, name, role, active, created_at, rev }`, `OfficeUserCreate { login, name, role, password }`, `OfficeUserUpdate { name, role, active, expected_rev }`, `PasswordSet { password }` (запросы — `deny_unknown_fields`).
  - Маршруты `GET /v1/office/sscc`, `PUT /v1/office/sscc/counters/{prefix}/{extension}`, `PUT /v1/office/sscc/block-sizes`, `GET|POST /v1/office/users`, `PUT /v1/office/users/{id}`, `PUT /v1/office/users/{id}/password` (204).

- [ ] **Step 1: Типы протокола и фикстуры**

В `apps/standalone/proto/src/lib.rs` добавить:

```rust
/// One SSCC counter (`GET /v1/office/sscc`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccCounter {
    pub issuer_prefix: String,
    /// 0 = box, 1 = pallet.
    pub extension: u8,
    pub next_serial: u64,
    pub max_serial: u64,
    pub rev: i64,
}

/// `GET /v1/office/sscc`: counters and the device block sizes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccState {
    pub counters: Vec<SsccCounter>,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    /// Revision of the block sizes (site settings).
    pub rev: i64,
}

/// `PUT /v1/office/sscc/counters/{prefix}/{extension}`: move a counter forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccCounterUpdate {
    pub next_serial: u64,
    pub expected_rev: i64,
}

/// `PUT /v1/office/sscc/block-sizes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockSizesUpdate {
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    pub expected_rev: i64,
}

/// An office user as the administrator sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUserRecord {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
    pub active: bool,
    pub created_at: String,
    pub rev: i64,
}

/// `POST /v1/office/users`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeUserCreate {
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
    pub password: String,
}

/// `PUT /v1/office/users/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeUserUpdate {
    pub name: String,
    pub role: OfficeRole,
    pub active: bool,
    pub expected_rev: i64,
}

/// `PUT /v1/office/users/{id}/password`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordSet {
    pub password: String,
}
```

`apps/standalone/proto/fixtures/sscc-state.json`:

```json
{
  "counters": [
    {
      "issuerPrefix": "460068200",
      "extension": 0,
      "nextSerial": 1500,
      "maxSerial": 9999999,
      "rev": 1
    },
    {
      "issuerPrefix": "460068200",
      "extension": 1,
      "nextSerial": 40,
      "maxSerial": 9999999,
      "rev": 1
    }
  ],
  "boxBlockSize": 2000,
  "palletBlockSize": 200,
  "rev": 1
}
```

`apps/standalone/proto/fixtures/sscc-counter-update.json`:

```json
{ "nextSerial": 2000, "expectedRev": 1 }
```

`apps/standalone/proto/fixtures/block-sizes-update.json`:

```json
{ "boxBlockSize": 5000, "palletBlockSize": 500, "expectedRev": 1 }
```

`apps/standalone/proto/fixtures/office-user-record.json`:

```json
{
  "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  "login": "tech",
  "name": "Павел Орлов",
  "role": "technologist",
  "active": true,
  "createdAt": "2026-09-26T09:20:00Z",
  "rev": 3
}
```

`apps/standalone/proto/fixtures/office-user-create.json`:

```json
{
  "login": "tech",
  "name": "Павел Орлов",
  "role": "technologist",
  "password": "correct horse battery"
}
```

`apps/standalone/proto/fixtures/office-user-update.json`:

```json
{ "name": "Павел Орлов", "role": "admin", "active": false, "expectedRev": 3 }
```

`apps/standalone/proto/fixtures/password-set.json`:

```json
{ "password": "another long password" }
```

В `apps/standalone/proto/tests/fixtures.rs` добавить к импортам `BlockSizesUpdate, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, PasswordSet, SsccCounterUpdate, SsccState` и тест:

```rust
#[test]
fn sscc_and_user_admin_fixtures_round_trip() {
    let state: SsccState = round_trip("sscc-state.json");
    assert_eq!(state.counters[0].max_serial, 9_999_999);
    let _: SsccCounterUpdate = round_trip("sscc-counter-update.json");
    let _: BlockSizesUpdate = round_trip("block-sizes-update.json");
    let record: OfficeUserRecord = round_trip("office-user-record.json");
    assert!(record.active);
    let _: OfficeUserCreate = round_trip("office-user-create.json");
    let _: OfficeUserUpdate = round_trip("office-user-update.json");
    let _: PasswordSet = round_trip("password-set.json");
}
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/host/tests/office_admin.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::secrets::verify_password;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, with_session, TestApp,
};

struct Admin {
    app: TestApp,
    key: String,
    token: String,
}

async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    Admin { app, key, token }
}

impl Admin {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, &self.token);
        match body {
            Some(body) => self.app.send(json_request(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }
}

#[tokio::test]
async fn sscc_counters_move_only_forward_within_capacity() {
    let admin = admin().await;
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["boxBlockSize"], 2000);
    assert_eq!(state["palletBlockSize"], 200);
    let counter = &state["counters"][0];
    assert_eq!(counter["issuerPrefix"], "460068200");
    assert_eq!(counter["extension"], 0);
    assert_eq!(counter["nextSerial"], 1500);
    assert_eq!(counter["maxSerial"], 9_999_999);
    let rev = counter["rev"].as_i64().unwrap();

    let path = "/v1/office/sscc/counters/460068200/0";
    let (status, body) = admin.call("PUT", path, Some(json!({ "nextSerial": 1499, "expectedRev": rev }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "sscc_below_floor");
    assert_eq!(body["error"]["details"]["currentNextSerial"], 1500);
    let (status, body) = admin.call("PUT", path, Some(json!({ "nextSerial": 10_000_000, "expectedRev": rev }))).await;
    assert_eq!((status, body["error"]["details"]["field"].clone()), (StatusCode::BAD_REQUEST, json!("nextSerial")));
    let (status, body) = admin.call("PUT", path, Some(json!({ "nextSerial": 2000, "expectedRev": rev - 1 }))).await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::CONFLICT, json!("stale_revision")));

    let (status, body) = admin.call("PUT", path, Some(json!({ "nextSerial": 2000, "expectedRev": rev }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["nextSerial"], 2000);
    assert!(body["rev"].as_i64().unwrap() > rev);
    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'sscc.counter.update' AND target_id = '460068200/0'",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&details).unwrap(), json!({ "from": 1500, "to": 2000 }));

    let (status, body) = admin.call("PUT", "/v1/office/sscc/counters/999999999/0", Some(json!({ "nextSerial": 5, "expectedRev": 1 }))).await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    let (status, _) = admin.call("PUT", "/v1/office/sscc/counters/460068200/x", Some(json!({ "nextSerial": 5, "expectedRev": 1 }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn block_sizes_are_validated_and_versioned() {
    let admin = admin().await;
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = state["rev"].as_i64().unwrap();
    let (status, body) = admin
        .call("PUT", "/v1/office/sscc/block-sizes", Some(json!({ "boxBlockSize": 0, "palletBlockSize": 200, "expectedRev": rev })))
        .await;
    assert_eq!((status, body["error"]["details"]["field"].clone()), (StatusCode::BAD_REQUEST, json!("boxBlockSize")));
    let (status, body) = admin
        .call("PUT", "/v1/office/sscc/block-sizes", Some(json!({ "boxBlockSize": 5000, "palletBlockSize": 500, "expectedRev": rev })))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((body["boxBlockSize"].clone(), body["palletBlockSize"].clone()), (json!(5000), json!(500)));
    assert!(body["rev"].as_i64().unwrap() > rev);
}

#[tokio::test]
async fn technologists_cannot_administer() {
    let admin = admin().await;
    let (status, created) = admin
        .call("POST", "/v1/office/users", Some(json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "correct horse battery" })))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let tech_token = login(&admin.app, &admin.key, "tech", "correct horse battery").await;
    let tech = |method: &str, path: &str| with_session(request(method, path), &admin.key, &tech_token);

    assert_eq!(admin.app.send(empty(tech("GET", "/v1/office/sscc"))).await.0, StatusCode::OK);
    assert_eq!(admin.app.send(empty(tech("GET", "/v1/office/users"))).await.0, StatusCode::FORBIDDEN);
    let (status, body) = admin
        .app
        .send(json_request(tech("PUT", "/v1/office/sscc/counters/460068200/0"), json!({ "nextSerial": 9000, "expectedRev": 1 })))
        .await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
}

#[tokio::test]
async fn users_are_created_updated_and_the_last_admin_is_protected() {
    let admin = admin().await;
    let (status, created) = admin
        .call("POST", "/v1/office/users", Some(json!({ "login": "Tech", "name": " Павел Орлов ", "role": "technologist", "password": "correct horse battery" })))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["login"], "Tech");
    assert_eq!(created["name"], "Павел Орлов");
    assert_eq!(created["active"], true);
    let tech_id = created["id"].as_str().unwrap().to_owned();

    let (status, body) = admin
        .call("POST", "/v1/office/users", Some(json!({ "login": "tech", "name": "Двойник", "role": "technologist", "password": "correct horse battery" })))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["constraint"], "login");

    let (_, list) = admin.call("GET", "/v1/office/users", None).await;
    let logins: Vec<&str> = list.as_array().unwrap().iter().map(|user| user["login"].as_str().unwrap()).collect();
    assert_eq!(logins, vec!["admin", "Tech"]);
    let admin_record = list.as_array().unwrap().iter().find(|user| user["login"] == "admin").unwrap().clone();

    let admin_path = format!("/v1/office/users/{}", admin_record["id"].as_str().unwrap());
    let (status, body) = admin
        .call("PUT", &admin_path, Some(json!({ "name": "Ирина", "role": "technologist", "active": true, "expectedRev": admin_record["rev"] })))
        .await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::CONFLICT, json!("last_admin")));

    let tech_path = format!("/v1/office/users/{tech_id}");
    let (status, promoted) = admin
        .call("PUT", &tech_path, Some(json!({ "name": "Павел Орлов", "role": "admin", "active": true, "expectedRev": created["rev"] })))
        .await;
    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["role"], "admin");
    let (status, _) = admin
        .call("PUT", &admin_path, Some(json!({ "name": "Ирина", "role": "technologist", "active": true, "expectedRev": admin_record["rev"] })))
        .await;
    assert_eq!(status, StatusCode::OK);

    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'office_user.create' AND target_id = ?",
    )
    .bind(&tech_id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&details).unwrap(), json!({ "login": "Tech", "role": "technologist" }));
}

#[tokio::test]
async fn deactivation_and_password_changes_end_the_users_sessions() {
    let admin = admin().await;
    let (_, created) = admin
        .call("POST", "/v1/office/users", Some(json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "correct horse battery" })))
        .await;
    let tech_id = created["id"].as_str().unwrap().to_owned();
    let tech_token = login(&admin.app, &admin.key, "tech", "correct horse battery").await;

    let (status, _) = admin
        .call("PUT", &format!("/v1/office/users/{tech_id}/password"), Some(json!({ "password": "short" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = admin
        .call("PUT", &format!("/v1/office/users/{tech_id}/password"), Some(json!({ "password": "another long password" })))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);
    let phc: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(verify_password(&phc, "another long password"));
    let (status, _) = admin
        .app
        .send(empty(with_session(request("GET", "/v1/office/me"), &admin.key, &tech_token)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the password change ends the session");
    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'office_user.password' AND target_id = ?",
    )
    .bind(&tech_id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(details, "{}");

    let tech_token = login(&admin.app, &admin.key, "tech", "another long password").await;
    let (_, list) = admin.call("GET", "/v1/office/users", None).await;
    let rev = list.as_array().unwrap().iter().find(|user| user["id"] == tech_id).unwrap()["rev"].clone();
    let (status, _) = admin
        .call("PUT", &format!("/v1/office/users/{tech_id}"), Some(json!({ "name": "Павел", "role": "technologist", "active": false, "expectedRev": rev })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .app
        .send(empty(with_session(request("GET", "/v1/office/me"), &admin.key, &tech_token)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
```

`apps/standalone/host/tests/no_secrets_in_logs.rs`:

```rust
//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password hashes or the badge salt. Its own binary, because it
//! installs the global tracing subscriber.

mod support;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use serde_json::json;

#[tokio::test]
async fn secrets_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&paths, options).await.unwrap();
    let base = format!("https://{}", host.addr);
    let client = support::pinned_client(&host.fingerprint);
    let protocol = (markiro_proto::PROTOCOL_HEADER, markiro_proto::PROTOCOL_VERSION.to_string());

    let pair: serde_json::Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(protocol.0, &protocol.1)
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = pair["deviceKey"].as_str().unwrap().to_owned();
    let session: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();
    let wrong = client
        .post(format!("{base}/v1/office/login"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "login": "admin", "password": "not the password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    let created = client
        .post(format!("{base}/v1/office/users"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "technologist password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);

    let pool = markiro_host::db::open(&paths.database_file()).await.unwrap();
    let hashes: Vec<String> = sqlx::query_scalar("SELECT password_phc FROM office_users")
        .fetch_all(&pool)
        .await
        .unwrap();
    let salt: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;

    drop(client);
    host.stop().await.unwrap();
    drop(guard);

    let mut log = String::new();
    for entry in std::fs::read_dir(paths.logs_dir()).unwrap() {
        log.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(log.contains("markiro-host listening"), "the log must not be empty");
    let salt_hex: String = salt.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut secrets = vec![
        key,
        token,
        "correct horse battery".to_owned(),
        "not the password".to_owned(),
        "technologist password".to_owned(),
        salt_hex,
        "pbkdf2$".to_owned(),
    ];
    secrets.extend(hashes);
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
}
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --test office_admin`
Expected: FAIL — нет маршрутов SSCC и пользователей.

- [ ] **Step 4: Реализовать**

`apps/standalone/host/src/routes/sscc.rs`:

```rust
//! SSCC counters and block sizes: `GET /v1/office/sscc` (every role);
//! `PUT …/counters/{prefix}/{extension}` and `PUT …/block-sizes`
//! (administrators). Counters only move forward (spec §4.3); the checks for
//! active shifts and issued blocks join with the blocks in plan 2a.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{codes, BlockSizesUpdate, SsccCounter, SsccCounterUpdate, SsccState};
use serde_json::json;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

fn counter(issuer_prefix: String, extension: i64, next_serial: i64, rev: i64) -> Result<SsccCounter, ApiError> {
    let max_serial = validate::serial_capacity(&issuer_prefix) - 1;
    Ok(SsccCounter {
        issuer_prefix,
        extension: u8::try_from(extension).map_err(ApiError::internal)?,
        next_serial: u64::try_from(next_serial).map_err(ApiError::internal)?,
        max_serial,
        rev,
    })
}

async fn read_state(state: &AppState) -> Result<SsccState, ApiError> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY issuer_prefix, extension",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (box_block_size, pallet_block_size, rev): (i64, i64, i64) =
        sqlx::query_as("SELECT box_block_size, pallet_block_size, rev FROM site WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(SsccState {
        counters: rows
            .into_iter()
            .map(|(prefix, extension, next, rev)| counter(prefix, extension, next, rev))
            .collect::<Result<_, _>>()?,
        box_block_size: u32::try_from(box_block_size).map_err(ApiError::internal)?,
        pallet_block_size: u32::try_from(pallet_block_size).map_err(ApiError::internal)?,
        rev,
    })
}

pub async fn get_sscc(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<SsccState>, ApiError> {
    read_state(&state).await.map(Json)
}

pub async fn put_counter(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath((prefix, extension)): ApiPath<(String, u8)>,
    ApiJson(update): ApiJson<SsccCounterUpdate>,
) -> Result<Json<SsccCounter>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT next_serial, rev FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(&prefix)
    .bind(i64::from(extension))
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (current, rev) = row.ok_or_else(|| ApiError::not_found("no such SSCC counter"))?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    let current = u64::try_from(current).map_err(ApiError::internal)?;
    if update.next_serial < current {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::SSCC_BELOW_FLOOR,
            "an SSCC counter only moves forward",
        )
        .with_details(json!({ "currentNextSerial": current })));
    }
    validate::sscc_serial("nextSerial", extension, &prefix, update.next_serial)?;
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_counters SET next_serial = ?, rev = ? WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(i64::try_from(update.next_serial).map_err(ApiError::internal)?)
    .bind(new_rev)
    .bind(&prefix)
    .bind(i64::from(extension))
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let target = format!("{prefix}/{extension}");
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "sscc.counter.update",
            target_type: Some("sscc_counter"),
            target_id: Some(&target),
            outcome: Outcome::Ok,
            details: json!({ "from": current, "to": update.next_serial }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    counter(
        prefix,
        i64::from(extension),
        i64::try_from(update.next_serial).map_err(ApiError::internal)?,
        new_rev,
    )
    .map(Json)
}

pub async fn put_block_sizes(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<BlockSizesUpdate>,
) -> Result<Json<SsccState>, ApiError> {
    context.require_admin()?;
    if !(1..=100_000).contains(&update.box_block_size) {
        return Err(ApiError::validation("boxBlockSize", "1-100000 serials per block"));
    }
    if !(1..=10_000).contains(&update.pallet_block_size) {
        return Err(ApiError::validation("palletBlockSize", "1-10000 serials per block"));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE site SET box_block_size = ?, pallet_block_size = ?, rev = ? WHERE id = 1")
        .bind(i64::from(update.box_block_size))
        .bind(i64::from(update.pallet_block_size))
        .bind(new_rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "sscc.block_sizes.update",
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "boxBlockSize": update.box_block_size,
                "palletBlockSize": update.pallet_block_size,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    read_state(&state).await.map(Json)
}
```

`apps/standalone/host/src/routes/office_users.rs`:

```rust
//! Office users, administrators only: list, create, update (with the
//! last-administrator guard) and set a password.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{codes, OfficeRole, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, PasswordSet};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::secrets::hash_password;
use crate::server::AppState;
use crate::validate;

type UserRow = (String, String, String, String, i64, String, i64);

fn record((id, login, name, role, active, created_at, rev): UserRow) -> Result<OfficeUserRecord, ApiError> {
    Ok(OfficeUserRecord {
        id,
        login,
        name,
        role: serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)?,
        active: active == 1,
        created_at,
        rev,
    })
}

async fn read_user(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeUserRecord>, ApiError> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, active, created_at, rev FROM office_users WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

async fn hash(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(ApiError::internal)
}

pub async fn list_users(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<OfficeUserRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, active, created_at, rev FROM office_users ORDER BY login COLLATE NOCASE",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter().map(record).collect::<Result<Vec<_>, _>>().map(Json)
}

pub async fn create_user(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<OfficeUserCreate>,
) -> Result<Json<OfficeUserRecord>, ApiError> {
    context.require_admin()?;
    let login = create.login.trim().to_owned();
    validate::office_login("login", &login)?;
    let name = validate::person_name("name", &create.name)?;
    validate::password("password", &create.password)?;
    let password_phc = hash(create.password).await?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let inserted = sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(&login)
    .bind(&name)
    .bind(create.role.as_str())
    .bind(&password_phc)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        return Err(match error.as_database_error() {
            Some(database) if database.is_unique_violation() => {
                ApiError::conflict("login", "this login is already taken")
            }
            _ => ApiError::internal(error),
        });
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.create",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "login": login, "role": create.role.as_str() }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read_user(&mut tx, &id).await?.ok_or_else(|| ApiError::internal("user vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_user(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<OfficeUserUpdate>,
) -> Result<Json<OfficeUserRecord>, ApiError> {
    context.require_admin()?;
    let name = validate::person_name("name", &update.name)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let current = read_user(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such office user"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let loses_admin = current.active
        && current.role == OfficeRole::Admin
        && (update.role != OfficeRole::Admin || !update.active);
    if loses_admin {
        let other_admins: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM office_users WHERE role = 'admin' AND active = 1 AND id <> ?",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        if other_admins == 0 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                codes::LAST_ADMIN,
                "the last active administrator must stay",
            ));
        }
    }
    let mut changed = Vec::new();
    if current.name != name {
        changed.push("name");
    }
    if current.role != update.role {
        changed.push("role");
    }
    if current.active != update.active {
        changed.push("active");
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE office_users SET name = ?, role = ?, active = ?, rev = ? WHERE id = ?")
        .bind(&name)
        .bind(update.role.as_str())
        .bind(i64::from(update.active))
        .bind(rev)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if !update.active {
        sqlx::query("DELETE FROM office_sessions WHERE user_id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.update",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "changed": changed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_user(&mut tx, &id).await?.ok_or_else(|| ApiError::internal("user vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

pub async fn set_password(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<PasswordSet>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    validate::password("password", &body.password)?;
    let password_phc = hash(body.password).await?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if read_user(&mut tx, &id).await?.is_none() {
        return Err(ApiError::not_found("no such office user"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE office_users SET password_phc = ?, rev = ? WHERE id = ?")
        .bind(&password_phc)
        .bind(rev)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // Every other session of that user ends; the caller's own session stays.
    sqlx::query("DELETE FROM office_sessions WHERE user_id = ? AND id <> ?")
        .bind(&id)
        .bind(&context.session_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.password",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({}),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
```

В `apps/standalone/host/src/routes/mod.rs` добавить `pub mod office_users;` и `pub mod sscc;`; в `protected_routes` (`server.rs`) — маршруты (импортировать `put` из `axum::routing`):

```rust
        .route("/v1/office/sscc", get(crate::routes::sscc::get_sscc))
        .route(
            "/v1/office/sscc/counters/{prefix}/{extension}",
            put(crate::routes::sscc::put_counter),
        )
        .route(
            "/v1/office/sscc/block-sizes",
            put(crate::routes::sscc::put_block_sizes),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
        .route(
            "/v1/office/users/{id}/password",
            put(crate::routes::office_users::set_password),
        )
```

В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:

- в разделе 4.6 в перечень кодов этапа после `not_found` добавить `method_not_allowed`;
- в разделе 4.3 в пункте про `lines` дописать: «Таблица создаётся миграцией плана 1b1 вместе с `devices`, первые линии создаёт мастер; уникальность имени без учёта регистра обеспечивает столбец `name_key` (обрезанное имя в нижнем регистре по Unicode, считает хост), потому что `lower()` SQLite складывает только ASCII.»; в пункте про `org_profile` — «Столбцы шаблонов по умолчанию добавляются миграцией плана 1e вместе с таблицей шаблонов.»; в пункте про `office_sessions` — «Закрытая или истёкшая сессия удаляется; историю входов хранит журнал действий.»

- [ ] **Step 5: Тесты проходят**

Run:

```bash
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --check docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md apps/standalone/AGENTS.md
```

Expected: все тесты PASS, включая 5 в `office_admin.rs`, `no_secrets_in_logs.rs` (слушает 127.0.0.1 — при отказе песочницы вне её) и тест фикстур; форматирование чистое.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/proto apps/standalone/host docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): SSCC и офисные пользователи на хосте, проверка журнала на секреты" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — все тесты PASS.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `git diff --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — веб-интерфейс не сломан (он не менялся).
- [ ] В отчёте отдельно: Windows-задание CI и работа службы на Windows не проверялись.

## Отклонения при исполнении

Записано по итогам исполнения 2026-09-26; код в ветке соответствует этому разделу, а не буквальному тексту задач выше там, где они расходятся.

- **Сессии офиса (задача 3).** Условие `AND s.ended_at IS NULL` в запросе `OfficeContext` убрано: столбца `ended_at` нет, закрытые и истёкшие сессии удаляются. `unwrap_or_else(dummy_password_phc)` заменено замыканием `|| dummy_password_phc()` (ошибка времени жизни E0597).
- **Вход в офис (ревью задачи 3).** Логин обрезается и проверяется правилом `validate::office_login` до поиска пользователя: неверный формат — отказ без PBKDF2, в журнале `{"reason":"invalid_login"}` без введённого текста. Внутри транзакции записи хост перечитывает `password_phc` и `active`: если пароль сменили или пользователя выключили, пока шло хеширование, вход отклоняется.
- **Профиль организации (ревью задачи 4).** Счётчики нового префикса создаются через `INSERT … ON CONFLICT (issuer_prefix, extension) DO NOTHING`: `INSERT OR IGNORE` молча пропускал и нарушения `CHECK`. `PUT` без фактических изменений возвращает текущий профиль без новой ревизии, записи и строки журнала.
- **SSCC и пользователи (ревью задачи 5).** То же правило «без изменений — без записи» действует для пользователя, счётчика (`nextSerial`, равный текущему) и размеров блоков. Добавлены регресс-тесты: выключение последнего администратора, 403 технологу на всех админских маршрутах, удаление сессий при выключении, чтение счётчика после сдвига, смена собственного пароля.
- **Журнал действий в тестах.** Во всех задачах тесты сверяют строку журнала целиком (вид и идентификатор исполнителя, действие, объект, результат, детали), а не только `details`, как требуют корневой и локальный `AGENTS.md`.
- **Итоговое ревью.**
  - `unauthorized` несёт `details.credential`: `device` (ключ устройства неизвестен или отозван — переподключить устройство), `session` (сессия офиса закончилась — войти снова), `password` (неверный логин или пароль). Спецификация, §4.6, дополнена. Новая фикстура — `error-unauthorized.json`.
  - Деталь ошибки `sscc_below_floor` называется `minSerial`, а не `currentNextSerial`: имя переживёт правило напечатанного минимума из плана 2a и совпадает с облаком.
  - В `SsccState` поле `rev` переименовано в `blockSizesRev` (это ревизия размеров блоков). Добавлено `currentIssuerPrefix`: интерфейс не выводит правило префикса сам.
  - Админские записи перепроверяют права внутри транзакции (`OfficeContext::require_admin_in`), потому что роль могли понизить, пока шло хеширование.
  - `put_block_sizes` читает состояние через свою транзакцию и не берёт второе соединение из пула, пока держит блокировку записи.
  - `GET /v1/office/sscc` читает счётчики, размеры блоков и GLN в одной транзакции чтения: один снимок WAL, `currentIssuerPrefix` всегда есть среди счётчиков. Без профиля организации ответ — `not_found`, а не 500.
  - `last_seen_at` сессии офиса пишется не чаще раза в минуту, как у устройства.
  - `hash_password_with_salt` воспроизводит `passwordPhc` фикстуры `phc-password.json` байт в байт.
  - В `apps/standalone/AGENTS.md` добавлен раздел «Writes»; в спецификации, §4.1, — файл `host.lock`, а §4.2 говорит, что записи идут в транзакциях `BEGIN IMMEDIATE` (`db::begin_write`).
- **Перенесено в следующие планы.** TypeScript-сторона новых фикстур и скрытие секретов в `Debug` у типов протокола — план 1b2. Словарь действий журнала (`reason` у каждого отказа, `{from, to}` для роли, активности и GLN) — план 1c.
- **Не проверено локально:** задание `standalone-windows-build` и работа службы Windows.
