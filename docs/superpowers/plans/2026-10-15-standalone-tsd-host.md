# План ТСД-Х: хост «Markiro Автоном» принимает ТСД (допуск по виду устройства, складские паллеты, реестр коробов, печать организации, перепривязка) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автонома уже умеет спаривать устройство вида `handheld` (`POST /v1/pairing/claim`, место и
возможность лицензии), но не пускает его ни к сменам, ни к блокам SSCC, а складских паллет и реестра
коробов для устройства нет вовсе. После плана:

- права видов устройств заданы одной таблицей «метод × маршрут × виды» (`host/src/device_kinds.rs`) и
  проверяются в экстракторе `AuthDevice` до чтения тела; всё, чего нет в таблице, — `forbidden`.
  Попутно закрыта дыра: ключ устройства вида `handheld` сегодня открывает `POST /v1/office/login`
  (экстрактор не смотрит на вид), и тот, кто знает пароль офисного пользователя, входит в офис с ТСД;
- ТСД входит в смену своей линии (`enter`, `supports: handheld-host-v1`), берёт блоки SSCC обоих
  расширений, шлёт факты и закрывает смену — теми же маршрутами, что станция;
- складские паллеты: таблицы `warehouse_pallets`, `warehouse_pallet_boxes`, канал
  `POST /v1/device/pallet-events` с квитанцией на каждую запись и идемпотентностью по `(device, id)`;
- реестр закрытых коробов для устройства `GET /v1/device/box-registry` (курсор, окно `since/until`,
  `restoreEpoch`), основа — `boxes.changed_at`;
- `GET /v1/device/org/print` (имя, ИНН, печатный логотип, префикс эмитента) и список складских паллет в
  офисе;
- перепривязка тем же `deviceId` (`POST /v1/office/devices/{id}/pairing-code`, `claim.recoverDeviceId`).

**Architecture:**

- **Права видов.** Новый модуль `device_kinds` с таблицей `ROUTE_KINDS` для `/v1/device/*` и
  `/v1/changes*` и правилом для офисных маршрутов (`/v1/office/*`, `/v1/bootstrap`: станция и офисный ПК).
  `auth::authenticate` читает `MatchedPath` и вызывает `device_kinds::check` сразу после определения вида:
  отказ приходит раньше разбора тела. Ручные `kind != Station` остаются только там, где маршрут
  станционный по таблице (защита в глубину при прямом вызове обработчика из тестов).
- **Смены.** `list_device_shifts` и `enter_shift` перестают звать `require_station`; вход ТСД обязан
  назвать `handheld-host-v1` (`station_update` иначе). `PUT /v1/office/devices/{id}` разрешает линию и
  ТСД (линию ТСД назначает только офис).
- **Складские паллеты.** Миграции `0035` (две таблицы с теми же CHECK, что у `pallets`, и частичным
  уникальным индексом «короб на одной живой паллете») и `0036` (`device_event_receipts`). Модуль
  `host/src/pallet_events/` читает запись из собственного JSON, как `facts::receive`; одна транзакция
  `BEGIN IMMEDIATE` на пачку; нечитаемая запись — `rejected` без остановки остальных.
- **Реестр коробов.** Миграция `0037` добавляет `boxes.changed_at`; единая функция
  `facts::registry_touch::touch_box` обновляет её во всех местах записи короба.
- **Перепривязка.** Миграция `0038` добавляет `pairing_codes.device_id` (в спецификации этой колонки нет,
  без неё код нельзя привязать к устройству); `claim` с `recoverDeviceId` выдаёт новый ключ тому же
  `deviceId` и отзывает старый.
- **Лицензия.** Новые маршруты сразу попадают в `license/gate.rs`; складская паллета проверяет
  возможность `pallets` только при открытии.

**Tech Stack:** Rust (axum, sqlx 0.8.6 на SQLite, serde, uuid, aws-lc-rs), `markiro-host` и
`markiro-proto`; React 19 + TypeScript 6 strict, zod 4, Vitest 4 для двух правок офиса (кнопка
«Привязать заново», список складских паллет); фикстуры `apps/standalone/proto/fixtures`.

**Спецификация:** `docs/superpowers/specs/2026-10-15-standalone-handheld-on-host-design.md`
(разделы 2, 3, 6, 7, 11.1, 15 поток Х, решения владельца в конце). Родительские:
`apps/standalone/AGENTS.md` («Protocol», «Local pairing trust», «Facts», «Warehouse reprint»),
`docs/standalone/ledger/agent-rules.md`.

## Порядок и зависимости трёх планов

Три плана независимы по файлам, но не по порядку. Номера задач — как в разделе 15 спецификации.

| План                                    | Задачи                                                  | Что даёт остальным                                         |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `2026-10-15-standalone-tsd-protocol.md` | П1 типы и коды, П2 фикстуры и Zod, П3 Kotlin, П4 мастер | типы `proto` (П1) нужны Х3–Х6; фикстуры (П3) нужны Android |
| `2026-10-15-standalone-tsd-host.md`     | Х1, Х2, Х3, Х4, Х5, Х6, Х8                              | маршруты, на которые ходит приложение                      |
| `2026-10-15-standalone-tsd-android.md`  | С1–С5, Д1–Д5 (Д6 — шаг 1б, отдельным планом)            | —                                                          |

Порядок исполнения (стрелка — «после»):

```text
П1 ──► Х1 ──► Х2 ──► Х3 ──► Х4 ──► Х5 ──► Х6 ──► Х8      (П1 — типы, версия 6, коды; Х2 берёт из него
                                                          shift_supports::HANDHELD_HOST, Х3–Х6 — типы и коды)
П1 ──► П2 ──► П3 ──► С1 ──► С2 ──► С4 ──► С5 ──► Д1 ──► Д2 ──► Д3 ──► Д4 ──► Д5
Х2 + Х6 ──► С4        Х2 ──► С5        Х3 + Х4 + Х5 ──► Д3        Х8 ──► Д5
П1 ──► П4 (мастер: адрес хоста; в спецификации это Х7)
```

Х1 и Х2 можно начинать, как только в ветке есть константа из П1; Х3–Х6 независимы друг от друга по файлам
(кроме общей таблицы `device_kinds.rs` и `license/gate.rs`: правки строк в них сливаются без конфликтов по смыслу,
порядок номеров миграций держите возрастающим).

Задача Х7 спецификации («Постоянный адрес») по решению постановки живёт в плане протокола как П4: она
меняет мастер, `markiro-host` и офисную плашку, а не маршруты ТСД. Номера миграций: `0035`–`0037` из
спецификации плюс `0038` (`pairing_codes.device_id`, задача Х6) и `0039` (`site.address_confirmed_at`,
задача П4). Если параллельная ветка заняла номер, тест уникальности версий
(`host/tests/migration_beta3_upgrade.rs`) это покажет; перенумеруйте свои файлы и ссылки на них в плане.

## Global Constraints

- Рабочее дерево: `git -C /tmp/claude/wt/integ worktree add /tmp/claude/wt/tsd-host -b claude/tsd-host claude/integration`,
  затем клонирование зависимостей по `docs/standalone/ledger/agent-rules.md` (пункты 1–3). Дальше `WT=/tmp/claude/wt/tsd-host`.
  Не `cd`, только абсолютные пути; не `git stash`; не push.
- Cargo: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" ...`. Интеграционные
  тесты хоста слушают loopback: запускать вне песочницы. Vitest: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/<файл>`.
- Миграции — только новые файлы; применённые не правятся. Любое поле провода — в `proto`, Zod и фикстуре
  одновременно (план протокола П1–П2); поле запроса хоста — `deny_unknown_fields`, поле ответа терпит неизвестные.
- Каждый новый маршрут в одном коммите попадает в `license/gate.rs` (`NEVER`/`GATED`/`LIMITED`),
  в `device_kinds::ROUTE_KINDS` и в `held_by_a_restore`, если зависит от смен, коробов или кодов, которых
  копия может не содержать. Тесты `license_routes.rs` и `device_kind_routes.rs` красные, пока строки нет.
- Аудит проверяется точно: актор, действие, цель, результат, детали. Тест отказа проверяет, что строки и
  ревизии не появилось.
- Тест, который утверждал «ТСД не может» то, что решение владельца теперь разрешает, меняется явно и
  называется в отчёте (их три, см. Х1 и Х2); ослаблять проверки ради зелёного запрещено.
- Гейты перед завершением плана: `cargo test` пакетов `markiro-proto` и `markiro-host`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` (если репозиторий его гоняет: смотрите CI-job
  `standalone_rust`), Vitest пакета `@markiro/standalone`, `typecheck`, `lint`, `prettier --check` по
  тронутым файлам, `git diff --check`. Хостовые тесты не доказывают ничего про Windows-службу, брандмауэр,
  реальный Wi-Fi и реальный ТСД.
- Коммит: явные пути, одна строка трейлера
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- После правок кода `graphify update .` (если есть локальный граф).

## Что проверено по коду ветки `claude/integration` (`598627c66`, база спецификации)

- Следующий свободный номер миграции хоста — `0035` (последняя `0034_product_photo_media_type.sql`).
- `AuthDevice` и `AskingDevice` (`host/src/auth.rs`) не смотрят на вид устройства; ручные проверки вида:
  `routes/device_shifts.rs` (`require_station`, `require_station_in` на 140, 185, 218, 408, 413),
  `routes/sscc_blocks.rs:60,78`, `routes/known_blocks.rs:174,188`, `routes/warehouse.rs:133,332`,
  `routes/devices.rs:92` (`select_line`) и `227` (`update_device`, линия только станции).
- `OfficeContext::from_request_parts` вызывает `AuthDevice::from_request_parts` и не проверяет вид:
  `POST /v1/office/login` принимает ключ любого вида. Спецификация (раздел 6.2, последняя строка) считает
  это закрытым; в коде это не так (Х1 закрывает).
- `FactRecord`, `FactReceipt`, `facts::receive`, `facts::rules::record_digest` публичны; `blocks::issued`
  принимает `Context` смены, для событий вне смены нужен вариант без смены (Х3).
- `held_by_a_restore` (`server.rs`) держит `facts`, `codes/`, `warehouse/`: `pallet-events` обязан быть там же.
- `ClaimRequest` строится в `src-tauri/src/device.rs:351`: новое поле потребует правки и там (Х6).
- Существующие тесты хоста регистрируют ТСД с `capabilities: ["scanner"]` (`claim.rs`, `license_*.rs`,
  `cloud_import.rs`): `claim` НЕ может требовать `handheld-host-v1`; обязательность проверяется на входе в смену.

## Task Х1: таблица «маршрут × вид устройства» и её проверка в экстракторе

**Files:**

- Create: `apps/standalone/host/src/device_kinds.rs`
- Modify: `apps/standalone/host/src/lib.rs` (строка `pub mod device_kinds;` после `pub mod db;`)
- Modify: `apps/standalone/host/src/auth.rs` (функция `authenticate`)
- Modify: `apps/standalone/host/tests/support/mod.rs` (`pub mod routes;`)
- Create: `apps/standalone/host/tests/support/routes.rs` (разбор `server.rs`, копия из `license_routes.rs`)
- Modify: `apps/standalone/host/tests/support/app.rs` (`pair_handheld`)
- Test: `apps/standalone/host/tests/device_kind_routes.rs`

**Interfaces:**

- Consumes: `markiro_proto::DeviceKind`; `axum::extract::MatchedPath`; `ApiError::forbidden`.
- Produces: `pub const ROUTE_KINDS: &[(&str, &str, &[DeviceKind])]`; `pub const OFFICE_KINDS: &[DeviceKind]`;
  `pub fn allowed_kinds(method: &str, route: &str) -> Option<&'static [DeviceKind]>`;
  `pub fn check(method: &str, route: &str, kind: DeviceKind) -> Result<(), ApiError>`;
  тестовые помощники `support::routes::routed() -> BTreeSet<(String, String)>` и
  `support::app::pair_handheld(&Admin) -> String`. Задачи Х3–Х5 добавляют строки в `ROUTE_KINDS`.

- [ ] **Step 1: помощники тестов.** В `tests/support/mod.rs` добавьте `pub mod routes;`. Создайте
      `tests/support/routes.rs`: копию `router_source`, `calls` и `routed` из `tests/license_routes.rs`
      (строки 15–82, дословно, с `pub`). Файл `license_routes.rs` не меняется: общий модуль не вводится,
      чтобы лицензионный страж остался нетронутым.

```rust
//! The router's `.route("<path>", get(..).post(..))` calls, read from `src/server.rs`
//! (a copy of `license_routes.rs`'s parser: that guard stays untouched).

use std::collections::BTreeSet;

pub fn router_source() -> String {
    include_str!("../../src/server.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("the source of the router")
        .replace("\r\n", "\n")
}

fn calls(text: &str, call: &str) -> usize {
    let mut count = 0;
    let mut search = text;
    while let Some(at) = search.find(call) {
        let before = search[..at].chars().next_back();
        if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            count += 1;
        }
        search = &search[at + call.len()..];
    }
    count
}

pub fn routed() -> BTreeSet<(String, String)> {
    let source = router_source();
    let mut found = BTreeSet::new();
    let mut rest = source.as_str();
    while let Some(start) = rest.find(".route(") {
        let after = rest[start + ".route(".len()..].trim_start();
        let after = after.strip_prefix('"').expect("a route's path is a literal");
        let end = after.find('"').expect("a route's path ends");
        let path = &after[..end];
        let body = &after[end..];
        let stop = [body.find(".route("), body.find("\n}\n")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(body.len());
        let segment = &body[..stop];
        for (method, call) in [
            ("GET", "get("),
            ("POST", "post("),
            ("PUT", "put("),
            ("DELETE", "delete("),
        ] {
            if calls(segment, call) > 0 {
                found.insert((method.to_owned(), path.to_owned()));
            }
        }
        rest = &after[end..];
    }
    found
}
```

В `tests/support/app.rs` добавьте рядом с `pair_device` (копия `pair_handheld` из `device_shifts.rs`; локальные
копии в тестах не трогаются). Приложение называет возможность `handheld-host-v1` при сопряжении:

```rust
/// A handheld paired with a code from the office, as the office hands one out (it cannot pair
/// locally); returns its key.
pub async fn pair_handheld(admin: &Admin) -> String {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    let (status, paired) = admin
        .app
        .send_from(
            LAN,
            json(
                request("POST", "/v1/pairing/claim"),
                serde_json::json!({
                    "code": code["code"], "kind": "handheld", "name": "ТСД 1",
                    "appVersion": "1.2.0", "capabilities": ["handheld-host-v1"]
                }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    paired["deviceKey"].as_str().unwrap().to_owned()
}
```

- [ ] **Step 2: написать падающий тест.** `tests/device_kind_routes.rs`:

```rust
//! Which kind of device calls which route (plan ТСД-Х, task Х1, spec 6.2): every `/v1/device/*`
//! and `/v1/changes*` route has a row of `device_kinds::ROUTE_KINDS`, a route refuses a kind its
//! row does not list before it reads the body, and a handheld's key opens no office route.

mod support;

use std::collections::BTreeSet;

use axum::http::StatusCode;
use markiro_host::device_kinds::ROUTE_KINDS;
use markiro_host::secrets::key_hash;
use markiro_proto::DeviceKind;
use serde_json::json;
use support::app::{
    admin, audit_rows, empty, json as json_request, pair_device, pair_handheld, request,
    with_device, Admin,
};
use support::routes::routed;

fn in_scope(path: &str) -> bool {
    path.starts_with("/v1/device") || path.starts_with("/v1/changes")
}

fn concrete(path: &str) -> String {
    path.replace("{id}", "00000000-0000-4000-8000-000000000001")
        .replace("{code_hash}", &"a".repeat(64))
}

async fn keys(admin: &Admin) -> Vec<(DeviceKind, String)> {
    let (_, station) = pair_device(&admin.app, "station").await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let handheld = pair_handheld(admin).await;
    vec![
        (DeviceKind::Station, station),
        (DeviceKind::Office, office),
        (DeviceKind::Handheld, handheld),
    ]
}

#[test]
fn every_device_and_changes_route_has_a_row_and_every_row_a_route() {
    let routed: BTreeSet<(String, String)> = routed()
        .into_iter()
        .filter(|(_, path)| in_scope(path))
        .collect();
    assert!(routed.len() >= 15, "the router was not read: {routed:?}");
    let rows: BTreeSet<(String, String)> = ROUTE_KINDS
        .iter()
        .map(|(method, path, _)| ((*method).to_owned(), (*path).to_owned()))
        .collect();
    assert_eq!(rows.len(), ROUTE_KINDS.len(), "a route has two rows");
    let unlisted: Vec<_> = routed.difference(&rows).collect();
    assert!(unlisted.is_empty(), "routes without a row: {unlisted:?}");
    let gone: Vec<_> = rows.difference(&routed).collect();
    assert!(gone.is_empty(), "rows of no route: {gone:?}");
}

#[tokio::test]
async fn a_route_refuses_a_kind_its_row_does_not_list_before_it_reads_the_body() {
    let admin = admin().await;
    let keys = keys(&admin).await;
    let before = audit_rows(&admin.app).await;
    for (kind, key) in keys {
        for (method, path, allowed) in ROUTE_KINDS {
            // An event stream of an allowed kind would never end.
            if allowed.contains(&kind) && path.ends_with("/stream") {
                continue;
            }
            let builder = with_device(request(method, &concrete(path)), &key);
            // A body no route reads: the refusal by kind must come first.
            let (status, body) = admin
                .app
                .send(json_request(builder, json!({ "garbage": true })))
                .await;
            if allowed.contains(&kind) {
                assert_ne!(
                    status,
                    StatusCode::FORBIDDEN,
                    "{kind:?} {method} {path}: {body}"
                );
            } else {
                assert_eq!(
                    (status, body["error"]["code"].clone()),
                    (StatusCode::FORBIDDEN, json!("forbidden")),
                    "{kind:?} {method} {path}"
                );
            }
        }
    }
    // No call with a body no route reads writes an audit row.
    assert_eq!(audit_rows(&admin.app).await, before);
}

#[tokio::test]
async fn a_handheld_key_opens_no_office_route_whatever_the_password() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let (status, refused) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &handheld),
            json!({ "login": "admin", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let station: String = sqlx::query_scalar("SELECT id FROM devices WHERE key_hash = ?")
        .bind(key_hash(&admin.key))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let foreign: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id != ?")
            .bind(&station)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(foreign, 0, "a handheld got an office session");
    for (method, path) in [
        ("GET", "/v1/office/me"),
        ("GET", "/v1/office/devices"),
        ("POST", "/v1/bootstrap"),
        ("GET", "/v1/office/license"),
    ] {
        let (status, refused) = admin
            .app
            .send(empty(with_device(request(method, path), &handheld)))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
    // The station that runs the office keeps working.
    let (status, _) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(status, StatusCode::OK);
}
```

- [ ] **Step 3: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test device_kind_routes`
  Expected: ошибка компиляции `unresolved import markiro_host::device_kinds` (модуля ещё нет).

- [ ] **Step 4: реализовать.** `host/src/device_kinds.rs`:

```rust
//! Which kind of device may call which route (plan ТСД-Х, spec 6.2, decision Д7). The one source:
//! `auth::authenticate` checks it right after it knows the kind, before a handler reads the body.
//! A route that authenticates a device and has no row here is `forbidden` for everybody, so a new
//! route is closed until its row is written (`tests/device_kind_routes.rs` fails first).
//!
//! The office's routes (`/v1/office/*`, `/v1/bootstrap`) are one rule, not a row each: they take a
//! station or an office PC. A handheld's key never opens them, whatever password follows (three
//! identities, `apps/standalone/AGENTS.md`).

use markiro_proto::DeviceKind::{self, Handheld, Office, Station};

use crate::error::ApiError;

/// `(method, route as the router writes it, the kinds that may call it)`.
pub const ROUTE_KINDS: &[(&str, &str, &[DeviceKind])] = &[
    ("GET", "/v1/device", &[Station, Handheld, Office]),
    ("PUT", "/v1/device/line", &[Station]),
    ("GET", "/v1/device/shifts", &[Station, Handheld]),
    ("POST", "/v1/device/shifts", &[Station]),
    ("POST", "/v1/device/shifts/{id}/enter", &[Station, Handheld]),
    ("POST", "/v1/device/sscc/blocks", &[Station, Handheld]),
    ("POST", "/v1/device/sscc/blocks/known", &[Station, Handheld]),
    ("POST", "/v1/device/facts", &[Station, Handheld]),
    ("GET", "/v1/device/codes/{code_hash}", &[Station, Handheld]),
    ("POST", "/v1/device/conflicts/status", &[Station, Handheld]),
    ("GET", "/v1/device/displacements", &[Station, Handheld]),
    ("GET", "/v1/device/products/{id}/photo", &[Station]),
    ("GET", "/v1/device/pallet-sheets", &[Station]),
    ("POST", "/v1/device/warehouse/lookup", &[Station]),
    ("POST", "/v1/device/warehouse/reprints", &[Station]),
    ("GET", "/v1/changes", &[Station, Handheld, Office]),
    ("GET", "/v1/changes/stream", &[Station, Handheld, Office]),
];

/// Kinds that may call the office's routes.
pub const OFFICE_KINDS: &[DeviceKind] = &[Station, Office];

/// The kinds allowed on `route` with `method`, or `None` for a route with no rule.
pub fn allowed_kinds(method: &str, route: &str) -> Option<&'static [DeviceKind]> {
    if let Some((_, _, kinds)) = ROUTE_KINDS
        .iter()
        .find(|(m, path, _)| *m == method && *path == route)
    {
        return Some(kinds);
    }
    (route.starts_with("/v1/office/") || route == "/v1/bootstrap").then_some(OFFICE_KINDS)
}

/// `Ok` when `kind` may call `route`; `forbidden` otherwise, with no detail about the table.
pub fn check(method: &str, route: &str, kind: DeviceKind) -> Result<(), ApiError> {
    match allowed_kinds(method, route) {
        Some(kinds) if kinds.contains(&kind) => Ok(()),
        _ => Err(ApiError::forbidden(
            "this kind of device does not call this route",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_without_a_rule_is_closed_to_every_kind() {
        for kind in [Station, Office, Handheld] {
            assert!(check("GET", "/v1/device/unheard-of", kind).is_err());
        }
    }

    #[test]
    fn the_office_rule_takes_a_station_and_an_office_pc_only() {
        assert!(check("POST", "/v1/office/login", Station).is_ok());
        assert!(check("GET", "/v1/office/me", Office).is_ok());
        assert!(check("POST", "/v1/office/login", Handheld).is_err());
        assert!(check("POST", "/v1/bootstrap", Handheld).is_err());
    }

    #[test]
    fn a_row_names_the_method_too() {
        assert!(check("GET", "/v1/device/shifts", Handheld).is_ok());
        assert!(check("POST", "/v1/device/shifts", Handheld).is_err());
    }
}
```

В `auth.rs` в `authenticate`, сразу после
`let kind: DeviceKind = kind.parse().map_err(ApiError::internal)?;`:

```rust
    // The kind's right to this route, before anything is written for the request (not even
    // `last_seen_at`) and before a handler reads the body. A call outside the router (a unit test
    // calling a handler) has no matched path and skips the check: the router always has one.
    if let Some(route) = parts.extensions.get::<axum::extract::MatchedPath>() {
        crate::device_kinds::check(parts.method.as_str(), route.as_str(), kind)?;
    }
```

В `lib.rs` добавьте `pub mod device_kinds;`.

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test device_kind_routes`
  Expected: `test result: ok. 3 passed`.

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --lib device_kinds`
  Expected: `test result: ok. 3 passed`.

- [ ] **Step 6: прогнать весь набор хоста и разобрать красные.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host`
  Expected: красными остаются только тесты, где вид, которому таблица теперь отказывает, вызывал закрытый
  маршрут. Ожидаемо: `device_shifts.rs::only_a_station_reads_and_creates_shifts` (ТСД теперь читает
  смены — правится в Х2) и `an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift` (ТСД
  теперь входит — правится в Х2); любой тест, где вид `office` бил по `facts`, `sscc/blocks`, `shifts`
  ожидая не `forbidden`, — верное закрытие, тест правится на `forbidden`. Всё остальное — ошибка
  реализации. Список исправленных тестов — в отчёт и в раздел «Отклонения при исполнении».

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/device_kinds.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/auth.rs apps/standalone/host/tests/support/mod.rs apps/standalone/host/tests/support/routes.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/device_kind_routes.rs
git -C "$WT" commit -m "feat(standalone): device kinds table, checked in the extractor (a handheld key opens no office route)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х2: ТСД допущен к сменам, блокам SSCC и фактам

**Files:**

- Modify: `apps/standalone/host/src/auth.rs` (`AuthDevice::require_kinds_in`)
- Modify: `apps/standalone/host/src/routes/device_shifts.rs` (`list_device_shifts`, `enter_shift`, `require_supports`)
- Modify: `apps/standalone/host/src/routes/sscc_blocks.rs` (`issue_block`)
- Modify: `apps/standalone/host/src/routes/known_blocks.rs` (`register_known_blocks`)
- Modify: `apps/standalone/host/src/routes/devices.rs` (`update_device`: линию получает станция или ТСД)
- Modify: `apps/standalone/host/tests/device_shifts.rs` (два теста, решение владельца меняет утверждение)
- Test: `apps/standalone/host/tests/handheld_floor.rs`

**Interfaces:**

- Consumes: Х1 (`ROUTE_KINDS` уже пускает ТСД на эти маршруты); П1: `markiro_proto::shift_supports::HANDHELD_HOST`
  (`"handheld-host-v1"`).
- Produces: `AuthDevice::require_kinds_in(&self, &mut SqliteConnection, &[DeviceKind], &str) -> Result<DeviceKind, ApiError>`;
  вход ТСД в смену без `handheld-host-v1` — `409 station_update`.

- [ ] **Step 1: написать падающие тесты.** Создайте `tests/handheld_floor.rs`:

```rust
//! A handheld on the host's floor (plan ТСД-Х, task Х2, spec 6.3, 6.7): the office gives it a
//! line, it reads and enters its line's shift naming `handheld-host-v1`, gets blocks of both
//! extensions, sends facts and closes the shift; a station on the same line finds the shift busy;
//! a license that ran out stops its first entry and nothing that runs.

mod support;

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code_hash, empty, fact, host_revision, instant,
    json as json_request, ok_scan, pair_handheld, plan_shift, receipts, record_id, request,
    shift_body, shift_closed, shift_setup, with_device, Admin, ShiftSetup,
};
use support::license::{expired_file, load_ok};

const SUPPORTS: &str = "handheld-host-v1";

async fn device_call(admin: &Admin, key: &str, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

/// A handheld the office put on `line`; returns its id and key.
async fn handheld_on(admin: &Admin, line: &str) -> (String, String) {
    let key = pair_handheld(admin).await;
    let (status, info) = device_call(admin, &key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    (id, key)
}

async fn enter(admin: &Admin, key: &str, shift: &Value, supports: Option<&[&str]>) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(admin, key, "POST", &path, supports.map(|names| json!({ "supports": names }))).await
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

async fn block(admin: &Admin, key: &str, request_id: &str, extension: u8) -> Value {
    let (status, block) = device_call(
        admin,
        key,
        "POST",
        "/v1/device/sscc/blocks",
        Some(json!({ "requestId": request_id, "issuerPrefix": "460068200", "extension": extension })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

async fn planned(admin: &Admin, setup: &ShiftSetup) -> Value {
    plan_shift(admin, shift_body(setup)).await
}

#[tokio::test]
async fn a_handheld_on_a_line_reads_and_enters_its_shift_naming_the_capability() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (id, key) = handheld_on(&admin, &setup.line).await;

    let (status, listed) = device_call(&admin, &key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["shifts"][0]["id"], shift["id"]);

    // Without the capability the host asks for an update, and writes nothing.
    let (rows, rev) = (audit_rows(&admin.app).await, host_revision(&admin.app).await);
    for supports in [None, Some(&["validation-v1"][..])] {
        let (status, refused) = enter(&admin, &key, &shift, supports).await;
        assert_eq!((status, constraint(&refused)), (StatusCode::CONFLICT, json!("station_update")), "{supports:?}");
    }
    assert_eq!((audit_rows(&admin.app).await, host_revision(&admin.app).await), (rows, rev));

    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["status"], json!("active"));
    assert_eq!(entered["ownerDeviceId"], json!(id));
    assert_eq!(entered["snapshot"]["issuerPrefix"], json!("460068200"));
    // The owner enters again and gets the same snapshot.
    let (status, again) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!((status, again["snapshot"].clone()), (StatusCode::OK, entered["snapshot"].clone()));
}

#[tokio::test]
async fn a_handheld_without_a_line_or_on_another_line_finds_the_shift_on_another_line() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, elsewhere) = handheld_on(&admin, &setup.other_line).await;
    let (status, refused) = enter(&admin, &elsewhere, &shift, Some(&[SUPPORTS])).await;
    assert_eq!((status, constraint(&refused)), (StatusCode::CONFLICT, json!("shift_line")));
    let unassigned = pair_handheld(&admin).await;
    let (status, refused) = enter(&admin, &unassigned, &shift, Some(&[SUPPORTS])).await;
    assert_eq!((status, constraint(&refused)), (StatusCode::CONFLICT, json!("shift_line")));
}

#[tokio::test]
async fn one_device_works_a_shift_so_a_station_on_the_line_finds_it_busy() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, moved) = device_call(&admin, &admin.key, "PUT", "/v1/device/line", Some(json!({ "lineId": setup.line }))).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let (status, busy) = enter(&admin, &admin.key, &shift, None).await;
    assert_eq!((status, constraint(&busy)), (StatusCode::CONFLICT, json!("shift_busy")));
}

#[tokio::test]
async fn a_handheld_gets_blocks_sends_facts_and_closes_its_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let boxes = block(&admin, &key, "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b", 0).await;
    assert_eq!((boxes["fromSerial"].clone(), boxes["toSerial"].clone()), (json!(1500), json!(3499)));
    // The pallet extension too, from the pallet counter the wizard started at 40.
    let pallets = block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c", 1).await;
    assert_eq!(pallets["fromSerial"], json!(40));

    let shift_id = shift["id"].as_str().unwrap();
    let digest = box_membership_digest(&[code_hash(1)]);
    let batch = [
        fact(&record_id(1), "scan", shift_id, ok_scan(1, &box_id(1), &instant(1, 0))),
        fact(
            &record_id(2),
            "box_closed",
            shift_id,
            json!({
                "boxId": box_id(1), "sscc": "046006820000015000", "blockId": boxes["id"],
                "serial": 1500, "openedAt": instant(1, 0), "closedAt": instant(30, 0),
                "itemCount": 1, "membershipDigest": digest
            }),
        ),
        fact(&record_id(3), "shift_closed", shift_id, shift_closed(None, 1, 1, None, &instant(60, 0))),
    ];
    assert_eq!(
        receipts(&admin.app, &key, &batch).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2)), accepted(&record_id(3))]
    );
    let status: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "closed");
}
```

Допишите в тот же файл тест лицензии (идёт строго после предыдущих, использует `expired_file` и `load_ok`):

```rust
#[tokio::test]
async fn a_license_that_ran_out_stops_a_first_entry_and_never_an_open_handheld_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let open = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, entered) = enter(&admin, &key, &open, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let next = planned(&admin, &setup).await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;

    // The first entry into another planned shift is the one closed move.
    let (status, refused) = enter(&admin, &key, &next, Some(&[SUPPORTS])).await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("license_restricted"))
    );
    // The open shift is entered again, gets facts and is closed.
    let (status, again) = enter(&admin, &key, &open, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let shift_id = open["id"].as_str().unwrap();
    assert_eq!(
        receipts(
            &admin.app,
            &key,
            &[
                fact(&record_id(1), "scan", shift_id, ok_scan(1, &box_id(1), &instant(1, 0))),
                fact(&record_id(2), "shift_closed", shift_id, shift_closed(None, 1, 0, None, &instant(60, 0))),
            ],
        )
        .await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
}
```

Затем измените два существующих теста в `tests/device_shifts.rs`:

1. `only_a_station_reads_and_creates_shifts` (строки ≈226–260). Цикл по `(method, body)` с
   `for (kind, key) in [("office", &office_pc), ("handheld", &handheld)]` заменяется на явное решение
   владельца: офисный ПК закрыт везде, ТСД читает список и не создаёт смен:

```rust
    for (method, body) in [
        ("GET", None),
        ("POST", Some(device_create(&setup, REQUEST))),
    ] {
        let (status, refused) =
            device_call(&admin, &office_pc, method, "/v1/device/shifts", body.clone()).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "office {method}"
        );
        let (status, answer) =
            device_call(&admin, &handheld, method, "/v1/device/shifts", body.clone()).await;
        if method == "GET" {
            // A handheld reads its line's shifts (spec 6.3); this one has no line.
            assert_eq!((status, answer["shifts"].clone()), (StatusCode::OK, json!([])));
        } else {
            assert_eq!(
                (status, answer["error"]["code"].clone()),
                (StatusCode::FORBIDDEN, json!("forbidden")),
                "handheld creates no shift"
            );
        }
        // …оставшаяся часть цикла (запрос без ключа → 401 `device`) не меняется.
```

2. `an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift` (строки ≈1272–1277): утверждение
   «ТСД не входит» заменяется на «у ТСД без линии вход — `shift_line`, как у станции без линии»:

```rust
    // A handheld enters like a station: without a line it is the line that refuses.
    assert_eq!(refused_entry(&admin, &handheld, &shift).await, line);
```

Обе правки — следствие решения владельца В1/Д10 (ТСД ведёт смену); в отчёте назвать их как изменённые
утверждения, не ослабленные.

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test handheld_floor --test device_shifts`
  Expected: падают `a_handheld_on_a_line_*` (`403 forbidden` на `enter`/`PUT /v1/office/devices/{id}` с `lineId`),
  `a_handheld_gets_blocks_*` и обновлённые тесты `device_shifts.rs`.

- [ ] **Step 3: реализовать.**

  `auth.rs`, в `impl AuthDevice` после `require_station_in`:

```rust
    /// The device is still paired and not revoked, and its kind (as stored) is one of `kinds`; the
    /// kind is returned. `forbidden` is the text for another kind. A station or a handheld works on
    /// shifts and gets blocks (plan ТСД-Х, Х2).
    pub async fn require_kinds_in(
        &self,
        conn: &mut SqliteConnection,
        kinds: &[DeviceKind],
        forbidden: &str,
    ) -> Result<DeviceKind, ApiError> {
        let kind = self.require_live_in(conn).await?;
        if kinds.contains(&kind) {
            Ok(kind)
        } else {
            Err(ApiError::forbidden(forbidden))
        }
    }
```

`routes/device_shifts.rs`:

- в `list_device_shifts` удалите строку `require_station(&device)?;` (экстрактор уже проверил вид по таблице);
- в `enter_shift` удалите `require_station(&device)?;`, а строку
  `device.require_station_in(&mut tx, STATION_ONLY).await?;` замените на

```rust
    let kind = device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            "only a station or a handheld works on shifts",
        )
        .await?;
```

- `require_supports` получает вид и требует возможность ТСД всегда:

```rust
fn require_supports(
    kind: DeviceKind,
    mode: ShiftMode,
    prints: bool,
    enter: &ShiftEnter,
) -> Result<(), ApiError> {
    let mut needed: Vec<&str> = match (mode, prints) {
        (ShiftMode::Aggregation, _) => Vec::new(),
        (ShiftMode::Validation, false) => vec![shift_supports::VALIDATION],
        (ShiftMode::Validation, true) => vec![
            shift_supports::VALIDATION,
            shift_supports::VALIDATION_DM_DUPLICATE,
        ],
    };
    // A handheld names the capability on every entry, whatever the mode: a build that does not
    // know the host's protocol must not work the shift (spec 6.3).
    if kind == DeviceKind::Handheld {
        needed.push(shift_supports::HANDHELD_HOST);
    }
    if needed
        .iter()
        .all(|needed| enter.supports.iter().any(|name| name == needed))
    {
        Ok(())
    } else {
        Err(station_update())
    }
}
```

    и единственный вызов (≈строка 456) принимает `kind` первым аргументом:
    `require_supports(kind, shift.mode.parse()..., duplicate.is_some(), &enter)?;`. Комментарий над `enter_shift`
    дополните: «A handheld (plan ТСД-Х) enters the same way and always names `handheld-host-v1`».

`routes/sscc_blocks.rs`: в начале `issue_block` вместо `if device.kind != DeviceKind::Station {…}`

```rust
    if !matches!(device.kind, DeviceKind::Station | DeviceKind::Handheld) {
        return Err(ApiError::forbidden("only a station or a handheld gets SSCC blocks"));
    }
```

    и в транзакции вместо `require_station_in(...)`:
    `device.require_kinds_in(&mut tx, &[DeviceKind::Station, DeviceKind::Handheld], "only a station or a handheld gets SSCC blocks").await?;`.

`routes/known_blocks.rs`: те же две замены (константа `FORBIDDEN` в этом файле получает текст
`"only a station or a handheld registers its blocks"`; проверьте, что существующий тест на текст отказа
его не фиксирует: `grep -n "registers its" host/tests/known_blocks.rs`).

`routes/devices.rs` (`update_device`, строка ≈227): условие

```rust
            if !matches!(current.kind, DeviceKind::Station | DeviceKind::Handheld) {
                return Err(ApiError::validation(
                    "lineId",
                    "only a station or a handheld works on a line",
                ));
            }
```

`select_line` (`PUT /v1/device/line`) остаётся станционным: линию ТСД назначает только офис.

- [ ] **Step 4: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test handheld_floor --test device_shifts --test device_kind_routes --test license_routes`
  Expected: все четыре файла `ok`; в `handheld_floor` — `5 passed`.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/auth.rs apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/sscc_blocks.rs apps/standalone/host/src/routes/known_blocks.rs apps/standalone/host/src/routes/devices.rs apps/standalone/host/tests/handheld_floor.rs apps/standalone/host/tests/device_shifts.rs
git -C "$WT" commit -m "feat(standalone): a handheld works shifts and gets SSCC blocks on the host

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х3: складские паллеты — миграции `0035`–`0036`, канал `POST /v1/device/pallet-events`

**Files:**

- Create: `apps/standalone/host/tests/support/handheld.rs`; Modify: `apps/standalone/host/tests/support/mod.rs`
- Create: `apps/standalone/host/migrations/0035_warehouse_pallets.sql`
- Create: `apps/standalone/host/migrations/0036_device_events.sql`
- Create: `apps/standalone/host/src/pallet_events.rs`
- Create: `apps/standalone/host/src/routes/pallet_events.rs`
- Modify: `apps/standalone/host/src/lib.rs` (`pub mod pallet_events;`), `host/src/routes/mod.rs` (`pub mod pallet_events;`)
- Modify: `apps/standalone/host/src/server.rs` (маршрут; `held_by_a_restore`)
- Modify: `apps/standalone/host/src/facts/blocks.rs` (`issued_to`)
- Modify: `apps/standalone/host/src/device_kinds.rs` (строка таблицы)
- Modify: `apps/standalone/host/src/license/gate.rs` (`NEVER`, `LIMITED`)
- Modify: `apps/standalone/host/tests/license_routes.rs` (ожидаемое множество `LIMITED`)
- Modify: `apps/standalone/host/tests/restore_hold.rs` (удержание после восстановления)
- Test: `apps/standalone/host/tests/pallet_events.rs`, `apps/standalone/host/tests/migration_handheld_host.rs`

**Interfaces:**

- Consumes (П1, `markiro-proto`): `PalletEventKind` (`warehouse_pallet_opened`, `pallet_box_added`,
  `pallet_box_removed`, `warehouse_pallet_closed`, `warehouse_pallet_label`), `PalletEventRecord`
  (`id`, `kind`, `operatorId`, `data`), `WarehousePalletOpenedData`, `PalletBoxAddedData`,
  `PalletBoxRemovedData`, `WarehousePalletClosedData`, `WarehousePalletLabelData`, `FactReceipts`,
  `receipt_codes::{BOX_NOT_FOUND, BOX_NOT_CLOSED, BOX_ON_PALLET, PRODUCT_MISMATCH, PALLET_NOT_OPEN,
PALLET_COUNT_MISMATCH, FEATURE_DISABLED}` (уже есть: `PALLET_UNKNOWN`, `SSCC_NOT_ISSUED`, `SSCC_TAKEN`,
  `PALLET_ALREADY_CLOSED`, `INVALID_RECORD`, `PAYLOAD_MISMATCH`).
- Produces: таблицы `warehouse_pallets`, `warehouse_pallet_boxes`, `device_event_receipts`;
  `pallet_events::receive(...)`; `blocks::issued_to(conn, device_id, issuer_prefix, block_id, extension, serial)`.
  Х4 добавляет вызовы `registry_touch::touch_box` в три места этого модуля; Х5 читает обе таблицы.

Решения, которых нет в спецификации (записать в «Отклонения при исполнении», если исполнитель их меняет):

- Отказ «короб уже на паллете» (`box_on_pallet`) — квитанция `rejected` с `details.palletSscc`
  (`null`, пока та паллета открыта) и `details.palletId`; исход `conflict` в шаге 1 не используется:
  `CHECK ((outcome = 'rejected') = (code IS NOT NULL))` оставляет у `conflict` пустой код, а приложению
  нужен код, чтобы показать «короб на другой паллете».
- `box_not_closed` — короб известен, но расформирован (открытый короб SSCC не имеет и по SSCC не находится).
- Открытие новой паллеты устройством, у которого уже есть открытая пустая паллета, удаляет пустую (ТСД
  выбросил черновик, оставив `opened`); если у открытой есть живые короба — `pallet_state`.
- `pallets`-возможность проверяется только при открытии и только для новой паллеты; при её отсутствии
  квитанция `rejected` `feature_disabled` (пачка не падает, существующие паллеты продолжают жить).

- [ ] **Step 1: написать падающие тесты.**

  `tests/migration_handheld_host.rs` (образец — `migration_validation_scans.rs`, функция `through(last)`):

```rust
//! Migrations 0035-0037 of plan ТСД-Х on a database that has the earlier ones (spec 6.4): a host
//! with live shifts, boxes and pallets upgrades without losing a row and gets the new tables.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

/// The migrations up to and including `last`.
fn through(last: i64) -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version <= last)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

async fn pool(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(path).create_if_missing(true))
        .await
        .unwrap()
}

async fn tables(pool: &SqlitePool) -> BTreeSet<String> {
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

#[tokio::test]
async fn the_warehouse_tables_arrive_beside_a_live_database_and_enforce_their_rules() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(34).run(&pool).await.unwrap();
    assert!(!tables(&pool).await.contains("warehouse_pallets"));
    MIGRATOR.run(&pool).await.unwrap();
    let tables = tables(&pool).await;
    for table in ["warehouse_pallets", "warehouse_pallet_boxes", "device_event_receipts"] {
        assert!(tables.contains(table), "{table}");
    }
    // The versions are unique and the new ones are the next free numbers.
    let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    assert_eq!(versions.len(), versions.iter().collect::<BTreeSet<_>>().len());
    for version in [35, 36] {
        assert!(versions.contains(&version), "{version}");
    }
    // A closed pallet holds its SSCC, block, serial and count together, and starts with 1.
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&pool).await.unwrap();
    let refused = |sql: &str| {
        let sql = sql.to_owned();
        let pool = pool.clone();
        async move { sqlx::query(&sql).execute(&pool).await.is_err() }
    };
    let head = "INSERT INTO warehouse_pallets (id, device_id, product_id, gtin14, opened_at, received_at";
    assert!(refused(&format!("{head}, closed_at) VALUES ('p1','d','pr','04600682000013','t','t','t')")).await);
    assert!(
        refused(&format!(
            "{head}, closed_at, sscc, block_id, serial, box_count_reported) \
             VALUES ('p2','d','pr','04600682000013','t','t','t','046006820000015000','b',1,1)"
        ))
        .await,
        "a pallet SSCC starts with 1"
    );
    assert!(!refused(&format!("{head}) VALUES ('p3','d','pr','04600682000013','t','t')")).await);
    // A box stands on one live pallet only; a removed row frees it.
    let add = "INSERT INTO warehouse_pallet_boxes (pallet_id, box_sscc, added_at, record_id, device_id, removed_at) VALUES";
    assert!(!refused(&format!("{add} ('p3','s','t','r1','d',NULL)")).await);
    assert!(refused(&format!("{add} ('p3','s','t','r2','d',NULL)")).await);
    assert!(!refused(&format!("{add} ('p3','s','t','r3','d','t2')")).await);
}
```

`tests/support/mod.rs`: добавьте `pub mod handheld;`. Создайте `tests/support/handheld.rs` (помощники ТСД,
общие для `pallet_events.rs`, `box_registry.rs`, `handheld_scenario.rs`):

```rust
//! A handheld's side of the host's floor for tests (plan ТСД-Х): closed boxes to build a warehouse
//! pallet of, and the records of `POST /v1/device/pallet-events`.

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};

use super::app::{
    box_id, code_hash, fact, instant, issue_block, json as json_request, ok_scan, open_floor,
    receipts, record_id, request, with_device, Admin, Floor, ShiftSetup,
};

pub const PALLET_A: &str = "a1000000-0000-4000-8000-000000000001";
pub const PALLET_B: &str = "a1000000-0000-4000-8000-000000000002";
pub const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// The SSCC of box serial `n` of the first box block (the host never checks the check digit).
pub fn box_sscc(n: u32) -> String {
    format!("0460068200{n:07}0")
}

pub fn pallet_sscc(n: u32) -> String {
    format!("1460068200{n:07}9")
}

pub async fn events(admin: &Admin, key: &str, records: &[Value]) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/pallet-events"), key),
            json!({ "records": records }),
        ))
        .await
}

pub async fn receipts_of(admin: &Admin, key: &str, records: &[Value]) -> Vec<Value> {
    let (status, body) = events(admin, key, records).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

pub fn event(n: u32, kind: &str, data: Value) -> Value {
    json!({ "id": record_id(n), "kind": kind, "operatorId": OPERATOR, "data": data })
}

pub fn opened(n: u32, pallet: &str, product: &str, at: &str) -> Value {
    event(n, "warehouse_pallet_opened", json!({ "palletId": pallet, "productId": product, "openedAt": at }))
}

pub fn added(n: u32, pallet: &str, sscc: &str, at: &str) -> Value {
    event(n, "pallet_box_added", json!({ "palletId": pallet, "boxSscc": sscc, "addedAt": at }))
}

pub fn accepted(n: u32) -> Value {
    json!({ "id": record_id(n), "outcome": "accepted" })
}

pub fn rejected(n: u32, code: &str, details: Option<Value>) -> Value {
    let mut receipt = json!({ "id": record_id(n), "outcome": "rejected", "code": code });
    if let Some(details) = details {
        receipt["details"] = details;
    }
    receipt
}

/// A station closes box `n` (serial 1499 + n) in a shift of `setup`'s product: the boxes a
/// warehouse pallet is built of. Returns the floor: the station's shift and key (its box block is
/// 1500-3499, the wizard's first).
pub async fn closed_boxes(admin: &Admin, setup: &ShiftSetup, count: u32) -> Floor {
    let floor = open_floor(admin, setup, &admin.key, &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b").await;
    for n in 1..=count {
        let digest = box_membership_digest(&[code_hash(n)]);
        let batch = [
            fact(&record_id(100 + n), "scan", &floor.shift, ok_scan(n, &box_id(n), &instant(n, 0))),
            fact(
                &record_id(200 + n),
                "box_closed",
                &floor.shift,
                json!({
                    "boxId": box_id(n), "sscc": box_sscc(1499 + n), "blockId": block["id"],
                    "serial": 1499 + n, "openedAt": instant(n, 0), "closedAt": instant(n, 500),
                    "itemCount": 1, "membershipDigest": digest
                }),
            ),
        ];
        assert_eq!(receipts(&admin.app, &floor.key, &batch).await.len(), 2);
    }
    floor
}

/// The id of the pallet block (extension 1) the handheld `key` was issued.
pub async fn pallet_block(admin: &Admin, key: &str, request_id: &str) -> Value {
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            json!({ "requestId": request_id, "issuerPrefix": "460068200", "extension": 1 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

pub fn product_of(setup: &ShiftSetup) -> &str {
    &setup.product
}
```

`tests/pallet_events.rs` (импорты — из `support::handheld`):

```rust
//! The warehouse pallet channel (plan ТСД-Х, task Х3, spec 6.4): a handheld opens a pallet outside
//! any shift, scans closed boxes onto it, takes one off and closes it with an SSCC of its pallet
//! block; every record gets a receipt, a record sent again gets the same one, and a record whose
//! content changed is a `payload_mismatch` that stores nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, host_revision, instant, pair_handheld, shift_setup};
use support::handheld::{
    accepted, added, closed_boxes, event, events, opened, pallet_block, pallet_sscc, box_sscc,
    product_of, receipts_of, rejected, PALLET_A, PALLET_B,
};
use support::license::{file, load_ok};

#[tokio::test]
async fn a_warehouse_pallet_is_opened_filled_and_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    let batch = [
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        added(3, PALLET_A, &box_sscc(1501), &instant(102, 0)),
        event(
            4,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 2
            }),
        ),
    ];
    let rev = host_revision(&admin.app).await;
    assert_eq!(
        receipts_of(&admin, &key, &batch).await,
        vec![accepted(1), accepted(2), accepted(3), accepted(4)]
    );
    let (sscc, count, closed_at): (String, i64, String) = sqlx::query_as(
        "SELECT sscc, box_count_reported, closed_at FROM warehouse_pallets WHERE id = ?",
    )
    .bind(PALLET_A)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!((sscc, count, closed_at), (pallet_sscc(40), 2, instant(110, 0)));
    let consumed: Option<i64> = sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
        .bind(block["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(consumed, Some(40));
    // The close is an event for the office: one revision for the batch.
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    // Sent again, the batch gets the same receipts and writes nothing.
    assert_eq!(
        receipts_of(&admin, &key, &batch).await,
        vec![accepted(1), accepted(2), accepted(3), accepted(4)]
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
}

#[tokio::test]
async fn a_record_sent_again_with_other_content_is_a_payload_mismatch_and_stores_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let first = [opened(1, PALLET_A, product_of(&setup), &instant(100, 0)), added(2, PALLET_A, &box_sscc(1500), &instant(101, 0))];
    assert_eq!(receipts_of(&admin, &key, &first).await, vec![accepted(1), accepted(2)]);
    let changed = added(2, PALLET_A, &box_sscc(1501), &instant(101, 0));
    assert_eq!(receipts_of(&admin, &key, &[changed]).await, vec![rejected(2, "payload_mismatch", None)]);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallet_boxes")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!((rows, kept), (1, 2), "the mismatch is kept nowhere");
}

#[tokio::test]
async fn a_box_on_another_pallet_is_rejected_with_that_pallet_and_a_removal_frees_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let first = pair_handheld(&admin).await;
    let second = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &first, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    assert_eq!(
        receipts_of(&admin, &first, &[opened(1, PALLET_A, product_of(&setup), &instant(100, 0)), added(2, PALLET_A, &box_sscc(1500), &instant(101, 0))]).await,
        vec![accepted(1), accepted(2)]
    );
    // The other handheld wants the same box while the first pallet is open: no SSCC yet.
    assert_eq!(
        receipts_of(&admin, &second, &[opened(10, PALLET_B, product_of(&setup), &instant(120, 0)), added(11, PALLET_B, &box_sscc(1500), &instant(121, 0))]).await,
        vec![accepted(10), rejected(11, "box_on_pallet", Some(json!({ "palletSscc": null, "palletId": PALLET_A })))]
    );
    // The first closes; the same box now names the closed pallet's SSCC.
    let close = event(3, "warehouse_pallet_closed", json!({
        "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
        "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
    }));
    assert_eq!(receipts_of(&admin, &first, &[close]).await, vec![accepted(3)]);
    assert_eq!(
        receipts_of(&admin, &second, &[added(12, PALLET_B, &box_sscc(1500), &instant(122, 0))]).await,
        vec![rejected(12, "box_on_pallet", Some(json!({ "palletSscc": pallet_sscc(40), "palletId": PALLET_A })))]
    );
    // The second pallet's own box can leave and come back.
    assert_eq!(
        receipts_of(&admin, &second, &[
            added(13, PALLET_B, &box_sscc(1501), &instant(123, 0)),
            event(14, "pallet_box_removed", json!({ "palletId": PALLET_B, "boxSscc": box_sscc(1501), "removedAt": instant(124, 0) })),
            added(15, PALLET_B, &box_sscc(1501), &instant(125, 0)),
        ]).await,
        vec![accepted(13), accepted(14), accepted(15)]
    );
}

#[tokio::test]
async fn each_refusal_names_its_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let other = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    // A second product the first pallet is of: the boxes belong to the setup's product.
    let (status, other_product) = admin
        .call("POST", "/v1/office/products", Some(json!({
            "gtin14": "04600682000020", "name": "Кефир", "printName": null, "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultPalletSheetId": null, "egaisCode": null, "defaultCounterpartyId": null
        })))
        .await;
    assert_eq!(status, StatusCode::OK, "{other_product}");
    let batch = [
        opened(1, PALLET_A, other_product["id"].as_str().unwrap(), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),                      // product_mismatch
        added(3, PALLET_A, "046006820099999990", &instant(102, 0)),                 // box_not_found
        added(4, "a1000000-0000-4000-8000-0000000000ff", &box_sscc(1500), &instant(103, 0)), // pallet_unknown
        event(5, "warehouse_pallet_closed", json!({
            "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
            "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 3
        })),                                                                          // pallet_count_mismatch
    ];
    let got = receipts_of(&admin, &key, &batch).await;
    assert_eq!(got[0], accepted(1));
    assert_eq!(got[1], rejected(2, "product_mismatch", None));
    assert_eq!(got[2], rejected(3, "box_not_found", None));
    assert_eq!(got[3], rejected(4, "pallet_unknown", None));
    assert_eq!(got[4], rejected(5, "pallet_count_mismatch", Some(json!({ "counted": 0 }))));
    // A block of another device is not this device's: `sscc_not_issued`; the consumed mark stays.
    let foreign = events(&admin, &other, &[
        opened(20, PALLET_B, product_of(&setup), &instant(130, 0)),
        added(21, PALLET_B, &box_sscc(1500), &instant(131, 0)),
        event(22, "warehouse_pallet_closed", json!({
            "palletId": PALLET_B, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
            "openedAt": instant(130, 0), "closedAt": instant(140, 0), "boxCount": 1
        })),
    ]).await;
    assert_eq!(foreign.0, StatusCode::OK);
    assert_eq!(foreign.1["receipts"][2], rejected(22, "sscc_not_issued", None));
    // A pallet whose time is no device instant is `invalid_record` on that field, the rest go on.
    let bad = receipts_of(&admin, &key, &[
        event(30, "pallet_box_added", json!({ "palletId": PALLET_A, "boxSscc": box_sscc(1500), "addedAt": "yesterday" })),
        json!("not an object"),
        accepted_probe(),
    ]).await;
    assert_eq!(bad[0], rejected(30, "invalid_record", Some(json!({ "field": "data.addedAt" }))));
    assert_eq!(bad[1], json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }));
    // The label of a pallet that was never closed.
    assert_eq!(bad[2], rejected(31, "pallet_state", None));
}

/// A well-formed label event of a pallet that exists: the record after the unreadable one.
fn accepted_probe() -> Value {
    event(31, "warehouse_pallet_label", json!({ "palletId": PALLET_A, "outcome": "verified", "at": instant(150, 0) }))
}

#[tokio::test]
async fn a_license_without_pallets_refuses_a_new_pallet_and_never_an_open_one() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    assert_eq!(
        receipts_of(&admin, &key, &[opened(1, PALLET_A, product_of(&setup), &instant(100, 0))]).await,
        vec![accepted(1)]
    );
    load_ok(&admin, &file(&admin.app.state.host_id, |terms| terms["features"]["pallets"] = json!(false))).await;
    // The open pallet keeps taking boxes; a new pallet is refused with no row.
    assert_eq!(
        receipts_of(&admin, &key, &[
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
            opened(3, PALLET_B, product_of(&setup), &instant(102, 0)),
        ]).await,
        vec![accepted(2), rejected(3, "feature_disabled", None)]
    );
    let pallets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(pallets, 1);
}

#[tokio::test]
async fn only_a_handheld_sends_pallet_events_and_a_database_error_is_no_receipt() {
    let admin = admin().await;
    let (status, refused) = events(&admin, &admin.key, &[opened(1, PALLET_A, "x", &instant(1, 0))]).await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
    let key = pair_handheld(&admin).await;
    // 1-100 records.
    let (status, body) = events(&admin, &key, &[]).await;
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!("validation_failed")));
    // A database error fails the batch (500) and keeps no receipt: the handheld sends it again.
    sqlx::query("DROP TABLE warehouse_pallet_boxes").execute(&admin.app.state.pool).await.unwrap();
    let setup = shift_setup(&admin).await;
    let (status, _) = events(&admin, &key, &[opened(1, PALLET_A, product_of(&setup), &instant(1, 0)), added(2, PALLET_A, &box_sscc(1500), &instant(2, 0))]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(kept, 0);
}
```

Дополнительно в `tests/restore_hold.rs` допишите тест (по образцу `a_held_host_answers_facts_…`):

```rust
#[tokio::test]
async fn a_held_host_holds_pallet_events_like_facts() {
    let (admin, _) = held().await;
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/pallet-events"), &admin.key),
            json!({ "records": [] }),
        ))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
}
```

(ключ станции `admin.key` для этого теста годится: удержание — слой над роутером и срабатывает раньше
проверки вида.)

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test migration_handheld_host --test pallet_events --test restore_hold`
  Expected: `migration_handheld_host` падает на «`warehouse_pallets`»; `pallet_events` — компиляция/404
  `no route for POST /v1/device/pallet-events`; `a_held_host_holds_pallet_events_like_facts` — 404.

- [ ] **Step 3: миграции.**

  `0035_warehouse_pallets.sql`:

```sql
-- Warehouse pallets (plan ТСД-Х, spec 6.4, decision Д5): a pallet a handheld builds OUTSIDE a shift
-- from boxes that other shifts closed. Not `pallets.kind`: `pallets.shift_id` is NOT NULL, and a
-- SQLite column constraint changes only by rebuilding the table with the foreign keys that point
-- at it (`boxes.pallet_id`, `pallet_exceptions`, the disaggregation lines). The CHECKs are the
-- production pallets' (`0012`); the pallet carries one product.
CREATE TABLE warehouse_pallets (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  box_count_reported INTEGER CHECK (box_count_reported IS NULL OR box_count_reported > 0),
  operator_id TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (box_count_reported IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL),
  CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc GLOB '1*'))
);
CREATE UNIQUE INDEX warehouse_pallets_sscc ON warehouse_pallets (sscc) WHERE sscc IS NOT NULL;
CREATE UNIQUE INDEX warehouse_pallets_block_serial ON warehouse_pallets (block_id, serial)
  WHERE block_id IS NOT NULL AND serial IS NOT NULL;
CREATE INDEX warehouse_pallets_device_open ON warehouse_pallets (device_id) WHERE closed_at IS NULL;

-- The boxes on a warehouse pallet, one row per stay: a box that left and came back has two. A box
-- stands on one live pallet only (`removed_at IS NULL`): the index is the host's check of two
-- handhelds racing for one box, and the reason of `box_on_pallet`.
CREATE TABLE warehouse_pallet_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pallet_id TEXT NOT NULL REFERENCES warehouse_pallets (id),
  box_sscc TEXT NOT NULL CHECK (length(box_sscc) = 18),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  operator_id TEXT,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id)
);
CREATE UNIQUE INDEX warehouse_pallet_boxes_live ON warehouse_pallet_boxes (box_sscc)
  WHERE removed_at IS NULL;
CREATE INDEX warehouse_pallet_boxes_pallet ON warehouse_pallet_boxes (pallet_id);
```

`0036_device_events.sql`:

```sql
-- The receipts of a device's events outside a shift (plan ТСД-Х, spec 6.4): the idempotent outbox of
-- `POST /v1/device/pallet-events`. `fact_receipts` is not reused on purpose: its rows are indexed
-- by shift. A record is kept as its SHA-256 (`facts::rules::record_digest`): the same id with the
-- same digest answers the stored receipt, with another digest `payload_mismatch`, kept nowhere.
CREATE TABLE device_event_receipts (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  kind TEXT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  code TEXT,
  details TEXT CHECK (details IS NULL OR (json_valid(details) AND json_type(details) = 'object')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((outcome = 'rejected') = (code IS NOT NULL))
);
```

- [ ] **Step 4: блоки без смены.** `facts/blocks.rs`: перенесите тело `issued` в

```rust
/// [`issued`] for a record outside a shift: the device and the issuer prefix are named, not read
/// from the shift's context (a warehouse pallet has no shift).
pub async fn issued_to(
    conn: &mut SqliteConnection,
    device_id: &str,
    issuer_prefix: &str,
    block_id: &str,
    extension: u8,
    serial: i64,
) -> Result<bool, ApiError> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
         AND extension = ? AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
    )
    .bind(block_id)
    .bind(device_id)
    .bind(issuer_prefix)
    .bind(i64::from(extension))
    .bind(serial)
    .bind(serial)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(found.is_some())
}
```

а `issued` сведите к `issued_to(conn, context.device_id, &context.shift.issuer_prefix, block_id, extension, serial).await`.

- [ ] **Step 5: модуль `host/src/pallet_events.rs`.**

```rust
//! The events of a device outside a shift (plan ТСД-Х, spec 6.4): a handheld's warehouse pallets.
//! One record, one receipt, as `facts::receive` does it: a record whose id has a kept receipt
//! answers that receipt when its digest is the same and `payload_mismatch` (kept nowhere) when it
//! is not; a record that cannot be read or breaks a rule is a `rejected` receipt and writes
//! nothing but the receipt; a database error is no receipt, it fails the batch and the device
//! sends it again.

use axum::http::StatusCode;
use markiro_proto::{
    receipt_codes, FactOutcome, FactReceipt, PalletBoxAddedData, PalletBoxRemovedData,
    PalletEventKind, PalletEventRecord, WarehousePalletClosedData, WarehousePalletLabelData,
    WarehousePalletOpenedData,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::db::next_revision;
use crate::error::ApiError;
use crate::facts::{blocks, rules, Applied, Failure, Reject};
use crate::license::seats::{require_feature, Feature};
use crate::server::AppState;
use crate::validate;

/// The largest record (spec 6.4.1).
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

struct Context<'a> {
    device_id: &'a str,
    record_id: &'a str,
    operator_id: Option<&'a str>,
    received_at: &'a str,
}

fn object(details: Option<Value>) -> Option<serde_json::Map<String, Value>> {
    match details {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn rejected(id: Option<String>, reject: Reject) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(reject.code.to_owned()),
        details: object(reject.details),
    }
}

/// Receive one record of a batch inside the batch's write transaction; `revision` is taken on the
/// first record that changes what the office shows (a pallet's close).
pub async fn receive(
    app: &AppState,
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<FactReceipt, ApiError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| validate::client_uuid("id", id).is_ok())
        .map(str::to_owned);
    let digest = rules::record_digest(value);
    if let Some(id) = &id {
        if let Some((stored_digest, receipt)) = stored(conn, device_id, id).await? {
            if stored_digest == digest {
                return Ok(receipt);
            }
            tracing::warn!(device = %device_id, record = %id, "a pallet event was rejected: payload_mismatch");
            return Ok(rejected(Some(id.clone()), Reject::new(receipt_codes::PAYLOAD_MISMATCH)));
        }
    }
    let (kind, answer) = apply(app, conn, device_id, value, received_at, revision).await?;
    let receipt = match answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
            outcome: applied.outcome,
            code: None,
            details: object(applied.details),
        },
        Err(reject) => {
            tracing::warn!(device = %device_id, record = ?id, code = reject.code, "a pallet event was rejected");
            rejected(id.clone(), reject)
        }
    };
    if let Some(id) = &id {
        sqlx::query(
            "INSERT INTO device_event_receipts (device_id, record_id, kind, digest, outcome, code, \
             details, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(id)
        .bind(kind.map(PalletEventKind::as_str))
        .bind(&digest)
        .bind(receipt.outcome.as_str())
        .bind(&receipt.code)
        .bind(receipt.details.as_ref().map(|d| Value::Object(d.clone()).to_string()))
        .bind(received_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(receipt)
}

async fn stored(
    conn: &mut SqliteConnection,
    device_id: &str,
    id: &str,
) -> Result<Option<(String, FactReceipt)>, ApiError> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT digest, outcome, code, details FROM device_event_receipts \
         WHERE device_id = ? AND record_id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(|(digest, outcome, code, details)| {
        Ok((
            digest,
            FactReceipt {
                id: Some(id.to_owned()),
                outcome: outcome.parse().map_err(ApiError::internal)?,
                code,
                details: details
                    .map(|details| serde_json::from_str(&details))
                    .transpose()
                    .map_err(ApiError::internal)?,
            },
        ))
    })
    .transpose()
}

type Answer = Result<Applied, Reject>;

async fn apply(
    app: &AppState,
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<(Option<PalletEventKind>, Answer), ApiError> {
    if value.to_string().len() > MAX_RECORD_BYTES {
        return Ok((None, Err(Reject::field("record"))));
    }
    let Ok(record) = serde_json::from_value::<PalletEventRecord>(value.clone()) else {
        return Ok((None, Err(Reject::new(receipt_codes::INVALID_RECORD))));
    };
    let kind = Some(record.kind);
    if let Some(operator) = &record.operator_id {
        if validate::client_uuid("operatorId", operator).is_err() {
            return Ok((kind, Err(Reject::field("operatorId"))));
        }
    }
    let context = Context {
        device_id,
        record_id: &record.id,
        operator_id: record.operator_id.as_deref(),
        received_at,
    };
    let answer = match record.kind {
        PalletEventKind::WarehousePalletOpened => opened(app, conn, &context, &record.data).await,
        PalletEventKind::PalletBoxAdded => box_added(conn, &context, &record.data).await,
        PalletEventKind::PalletBoxRemoved => box_removed(conn, &context, &record.data).await,
        PalletEventKind::WarehousePalletClosed => {
            closed(conn, &context, &record.data, revision).await
        }
        PalletEventKind::WarehousePalletLabel => label(conn, &context, &record.data).await,
    };
    match answer {
        Ok(applied) => Ok((kind, Ok(applied))),
        Err(Failure::Reject(reject)) => Ok((kind, Err(reject))),
        Err(Failure::Internal(error)) => Err(error),
    }
}

fn uuid_field(field: &str, id: &str) -> Result<(), Reject> {
    validate::client_uuid(field, id).map_err(|_| Reject::field(field))
}

fn instant_field(field: &str, at: &str) -> Result<(), Reject> {
    rules::device_instant(at).map(|_| ()).ok_or_else(|| Reject::field(field))
}

/// A pallet of this device: `(closed_at, product_id)`; `pallet_unknown` when no pallet of this
/// device has the id (another device's pallet is as unknown as none).
async fn own_pallet(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<(Option<String>, String), Failure> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT closed_at, product_id FROM warehouse_pallets WHERE id = ? AND device_id = ?",
    )
    .bind(id)
    .bind(context.device_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    row.ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN).into())
}

async fn opened(
    app: &AppState,
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: WarehousePalletOpenedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    uuid_field("data.productId", &data.product_id)?;
    instant_field("data.openedAt", &data.opened_at)?;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT device_id, product_id FROM warehouse_pallets WHERE id = ?")
            .bind(&data.pallet_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    match existing {
        // Another device's pallet has this id: an id made up twice is the device's fault.
        Some((device, _)) if device != context.device_id => {
            return Err(Reject::field("data.palletId").into())
        }
        Some((_, product)) if product != data.product_id => {
            return Err(Reject::field("data.productId").into())
        }
        // Sent again under another record id: nothing to write.
        Some(_) => return Ok(Applied::accepted()),
        None => {}
    }
    let gtin14: Option<String> =
        sqlx::query_scalar("SELECT gtin14 FROM products WHERE id = ? AND archived = 0")
            .bind(&data.product_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let Some(gtin14) = gtin14 else {
        return Err(Reject::field("data.productId").into());
    };
    // The one move the license closes here: a NEW pallet. Boxes added to an open one never ask.
    match require_feature(app, conn, Feature::Pallets).await {
        Ok(()) => {}
        Err(error) if error.status() == StatusCode::CONFLICT => {
            return Err(Reject::new(receipt_codes::FEATURE_DISABLED).into())
        }
        Err(error) => return Err(error.into()),
    }
    // A handheld works one open pallet. An empty one it left (a draft the operator threw away
    // after the host heard `opened`) goes; one with boxes on it is a state the device must fix.
    let open: Option<String> = sqlx::query_scalar(
        "SELECT id FROM warehouse_pallets WHERE device_id = ? AND closed_at IS NULL",
    )
    .bind(context.device_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if let Some(open) = open {
        let live: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL",
        )
        .bind(&open)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        if live > 0 {
            return Err(Reject::new(receipt_codes::PALLET_STATE).into());
        }
        sqlx::query("DELETE FROM warehouse_pallet_boxes WHERE pallet_id = ?")
            .bind(&open)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("DELETE FROM warehouse_pallets WHERE id = ?")
            .bind(&open)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query(
        "INSERT INTO warehouse_pallets (id, device_id, product_id, gtin14, opened_at, operator_id, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&data.pallet_id)
    .bind(context.device_id)
    .bind(&data.product_id)
    .bind(gtin14)
    .bind(&data.opened_at)
    .bind(context.operator_id)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

fn on_pallet(sscc: Option<String>, pallet_id: &str) -> Failure {
    Reject {
        code: receipt_codes::BOX_ON_PALLET,
        details: Some(json!({ "palletSscc": sscc, "palletId": pallet_id })),
    }
    .into()
}

async fn box_added(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: PalletBoxAddedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.addedAt", &data.added_at)?;
    if data.box_sscc.len() != 18 || !data.box_sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.boxSscc").into());
    }
    let (closed_at, pallet_product) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_NOT_OPEN).into());
    }
    type BoxRow = (String, Option<String>, String, Option<String>, Option<String>, Option<String>);
    let found: Option<BoxRow> = sqlx::query_as(
        "SELECT b.id, b.disassembled_at, sh.product_id, p.id, p.sscc, p.disassembled_at \
         FROM boxes b JOIN shifts sh ON sh.id = b.shift_id LEFT JOIN pallets p ON p.id = b.pallet_id \
         WHERE b.sscc = ?",
    )
    .bind(&data.box_sscc)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((_, disassembled_at, product, production_pallet, production_sscc, production_off)) = found
    else {
        return Err(Reject::new(receipt_codes::BOX_NOT_FOUND).into());
    };
    if disassembled_at.is_some() {
        return Err(Reject::new(receipt_codes::BOX_NOT_CLOSED).into());
    }
    if product != pallet_product {
        return Err(Reject::new(receipt_codes::PRODUCT_MISMATCH).into());
    }
    // On a production pallet that stands (a taken-apart pallet frees its boxes).
    if let (Some(pallet), None) = (production_pallet, production_off) {
        return Err(on_pallet(production_sscc, &pallet));
    }
    let live: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT wp.id, wp.sscc FROM warehouse_pallet_boxes wb \
         JOIN warehouse_pallets wp ON wp.id = wb.pallet_id \
         WHERE wb.box_sscc = ? AND wb.removed_at IS NULL",
    )
    .bind(&data.box_sscc)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match live {
        // Scanned twice onto the same pallet (under another record id): nothing to write.
        Some((pallet, _)) if pallet == data.pallet_id => return Ok(Applied::accepted()),
        Some((pallet, sscc)) => return Err(on_pallet(sscc, &pallet)),
        None => {}
    }
    sqlx::query(
        "INSERT INTO warehouse_pallet_boxes (pallet_id, box_sscc, added_at, operator_id, record_id, \
         device_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&data.pallet_id)
    .bind(&data.box_sscc)
    .bind(&data.added_at)
    .bind(context.operator_id)
    .bind(context.record_id)
    .bind(context.device_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

async fn box_removed(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: PalletBoxRemovedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.removedAt", &data.removed_at)?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_NOT_OPEN).into());
    }
    // A box that is not on the pallet is already where the handheld wants it: accepted.
    sqlx::query(
        "UPDATE warehouse_pallet_boxes SET removed_at = ? \
         WHERE pallet_id = ? AND box_sscc = ? AND removed_at IS NULL",
    )
    .bind(&data.removed_at)
    .bind(&data.pallet_id)
    .bind(&data.box_sscc)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

async fn closed(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
    revision: &mut Option<i64>,
) -> Result<Applied, Failure> {
    let data: WarehousePalletClosedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    uuid_field("data.blockId", &data.block_id)?;
    instant_field("data.openedAt", &data.opened_at)?;
    instant_field("data.closedAt", &data.closed_at)?;
    if data.sscc.len() != 18 || !data.sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.sscc").into());
    }
    if data.box_count == 0 {
        return Err(Reject::field("data.boxCount").into());
    }
    let serial = i64::try_from(data.serial).map_err(|_| Reject::field("data.serial"))?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        let stored: Option<String> =
            sqlx::query_scalar("SELECT sscc FROM warehouse_pallets WHERE id = ?")
                .bind(&data.pallet_id)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        // The same close sent again under another id changes nothing.
        return if stored.as_deref() == Some(data.sscc.as_str()) {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::PALLET_ALREADY_CLOSED).into())
        };
    }
    let gln: String = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let prefix = validate::issuer_prefix(&gln);
    if !rules::names_serial(&data.sscc, 1, prefix, data.serial)
        || !blocks::issued_to(&mut *conn, context.device_id, prefix, &data.block_id, 1, serial)
            .await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    // One serial of a pallet block is one label, on whichever kind of pallet it is printed.
    let taken: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM pallets WHERE sscc = ?1 OR (block_id = ?2 AND serial = ?3) \
         UNION ALL SELECT 1 FROM warehouse_pallets \
         WHERE id != ?4 AND (sscc = ?1 OR (block_id = ?2 AND serial = ?3))",
    )
    .bind(&data.sscc)
    .bind(&data.block_id)
    .bind(serial)
    .bind(&data.pallet_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    let counted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL",
    )
    .bind(&data.pallet_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if counted != i64::from(data.box_count) {
        return Err(Reject {
            code: receipt_codes::PALLET_COUNT_MISMATCH,
            details: Some(json!({ "counted": counted })),
        }
        .into());
    }
    sqlx::query(
        "UPDATE warehouse_pallets SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, \
         serial = ?, box_count_reported = ?, operator_id = ? WHERE id = ?",
    )
    .bind(&data.opened_at)
    .bind(&data.closed_at)
    .bind(&data.sscc)
    .bind(&data.block_id)
    .bind(serial)
    .bind(data.box_count)
    .bind(context.operator_id)
    .bind(&data.pallet_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    blocks::consume(&mut *conn, &data.block_id, serial).await?;
    // A pallet's close is an event for the office, as a shift's close is.
    if revision.is_none() {
        *revision = Some(next_revision(&mut *conn).await.map_err(ApiError::internal)?);
    }
    Ok(Applied::accepted())
}

async fn label(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: WarehousePalletLabelData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.at", &data.at)?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    // The label of a pallet that was never closed is a state the device must fix.
    if closed_at.is_none() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    Ok(Applied::accepted())
}
```

- [ ] **Step 6: маршрут и таблицы.** `routes/pallet_events.rs`:

```rust
//! `POST /v1/device/pallet-events`: a handheld's warehouse pallets outside any shift (plan ТСД-Х,
//! spec 6.4.1).

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceKind, FactReceipts};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision};
use crate::error::{ApiError, ApiJson};
use crate::pallet_events;
use crate::routes::facts::MAX_RECORDS;
use crate::server::AppState;

/// The body as the host reads it: each record a JSON value of its own, so a record it cannot read
/// is answered `rejected` and the others are applied.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingEvents {
    records: Vec<Value>,
}

pub async fn receive_events(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingEvents>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation("records", format!("1-{MAX_RECORDS} records")));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock sends nothing.
    device
        .require_kinds_in(&mut tx, &[DeviceKind::Handheld], "only a handheld sends pallet events")
        .await?;
    let received_at = state.timestamp();
    let mut receipts = Vec::with_capacity(batch.records.len());
    let mut revision = None;
    for (position, record) in batch.records.iter().enumerate() {
        match pallet_events::receive(&state, &mut tx, &device.id, record, &received_at, &mut revision).await {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                // The device sends the same batch again; support learns which record failed.
                tracing::error!(device = %device.id, position, "a pallet event batch failed");
                return Err(error);
            }
        }
    }
    match revision {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
        None => tx.commit().await,
    }
    .map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
```

`server.rs` — после маршрута `/v1/device/facts`:

```rust
        .route(
            "/v1/device/pallet-events",
            post(crate::routes::pallet_events::receive_events),
        )
```

и в `held_by_a_restore` добавьте `|| path == "/v1/device/pallet-events"` с комментарием «его записи опираются на
короба и блоки, которых копия может не содержать». `lib.rs`: `pub mod pallet_events;`;
`routes/mod.rs`: `pub mod pallet_events;`.

`device_kinds.rs` — строка `("POST", "/v1/device/pallet-events", &[Handheld]),` после `facts`.

`license/gate.rs` — в `NEVER` после `facts`: `("POST", "/v1/device/pallet-events"),`; в `LIMITED`:
`("POST", "/v1/device/pallet-events", "pallets: a new warehouse pallet"),`. В
`tests/license_routes.rs` в ожидаемое множество `LIMITED` добавьте `("POST", "/v1/device/pallet-events")`.

- [ ] **Step 7: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test migration_handheld_host --test pallet_events --test restore_hold --test license_routes --test device_kind_routes`
  Expected: все пять файлов `ok` (`pallet_events`: `6 passed`, `migration_handheld_host`: `1 passed`).

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test migration_beta3_upgrade --test foundation`
  Expected: `ok` (новые версии уникальны, число применённых миграций совпадает с `MIGRATOR`).

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/host/migrations/0035_warehouse_pallets.sql apps/standalone/host/migrations/0036_device_events.sql apps/standalone/host/src/pallet_events.rs apps/standalone/host/src/routes/pallet_events.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/server.rs apps/standalone/host/src/facts/blocks.rs apps/standalone/host/src/device_kinds.rs apps/standalone/host/src/license/gate.rs apps/standalone/host/tests/license_routes.rs apps/standalone/host/tests/restore_hold.rs apps/standalone/host/tests/pallet_events.rs apps/standalone/host/tests/migration_handheld_host.rs
git -C "$WT" commit -m "feat(standalone): warehouse pallets and the handheld's pallet-events channel on the host

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х4: реестр закрытых коробов — миграция `0037`, `boxes.changed_at`, `GET /v1/device/box-registry`

**Files:**

- Create: `apps/standalone/host/migrations/0037_box_registry_changes.sql`
- Create: `apps/standalone/host/src/facts/registry_touch.rs`; Modify: `apps/standalone/host/src/facts/mod.rs` (`pub mod registry_touch;`)
- Modify: `apps/standalone/host/src/facts/box_closed.rs`, `facts/exception.rs`, `facts/pallet_closed.rs`,
  `facts/pallet_exception.rs`, `apps/standalone/host/src/disaggregation.rs`, `apps/standalone/host/src/pallet_events.rs`
  (вызовы `registry_touch` в каждом месте, меняющем короб или то, на чём он стоит)
- Create: `apps/standalone/host/src/routes/box_registry.rs`; Modify: `routes/mod.rs`, `server.rs`, `device_kinds.rs`, `license/gate.rs`
- Test: `apps/standalone/host/tests/box_registry.rs`, `apps/standalone/host/tests/box_registry_touch.rs`;
  Modify: `apps/standalone/host/tests/migration_handheld_host.rs` (заполнение колонки)

**Interfaces:**

- Consumes (П1): `BoxRegistryPage { until, items, nextCursor, restoreEpoch }`,
  `BoxRegistryItem { kind: upsert|remove, sscc, updatedAt, boxId, productId, bottleCount, palletId,
palletSscc, palletActive, closedAt, productionDate }` — имена полей те же, что у `BoxRegistryItemDto`
  приложения, чтобы `BoxRegistryMirror` читал ответ хоста без перевода; Х3: таблицы складских паллет.
- Produces: `boxes.changed_at`; `registry_touch::{box_by_id, box_by_sscc, pallet_boxes, warehouse_pallet_boxes}`;
  маршрут `GET /v1/device/box-registry?since=&until=&cursor=&limit=`.

Решения, которых нет в спецификации:

- Форма элемента — форма облачного `BoxRegistryItemDto` (`kind` = `upsert`/`remove`, `boxId`, `bottleCount`,
  `productionDate`, `palletId`, `palletActive`), а не усечённая из раздела 6.5: зеркало приложения
  требует `boxId` и `bottleCount` (число единиц, из них считается количество на паллете), а
  `productionDate` печатается на этикетке складской паллеты. `contentKeys` (полные коды для списания)
  хост не отдаёт никогда; приложение в режиме `host` читает их как пустой список.
- `changed_at` — часы хоста (`state.timestamp()`), всегда одного формата: устройственные метки
  (`…SSS Z`) с хостовыми (`…SS Z`) строкой не сравниваются. Окно — `since <= changed_at <= until`
  (повторная доставка строки на границе безвредна: зеркало применяет её идемпотентно).
- Расформированный короб — элемент `remove`; в полной выгрузке (без `since`) он не попадает.

- [ ] **Step 1: написать падающие тесты.**

  В `tests/migration_handheld_host.rs` добавьте (заполнение колонки по `closed_at`/`disassembled_at`):

```rust
#[tokio::test]
async fn a_closed_box_of_a_live_database_gets_its_change_time_and_an_open_one_gets_none() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(36).run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&pool).await.unwrap();
    for sql in [
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
         VALUES ('open', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:00Z')",
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         item_count_reported, membership_digest, digest_matches, received_at) \
         VALUES ('closed', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:10:00.000Z', \
         '046006820000015000', 'b', 1500, 1, 'x', 1, '2026-10-08T06:11:00Z')",
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         item_count_reported, membership_digest, digest_matches, disassembled_at, received_at) \
         VALUES ('apart', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:10:00.000Z', \
         '046006820000015010', 'b', 1501, 1, 'x', 1, '2026-10-09T08:00:00.000Z', '2026-10-08T06:11:00Z')",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    MIGRATOR.run(&pool).await.unwrap();
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, changed_at FROM boxes ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    // The host's own time of receipt for a closed box; a taken-apart box keeps the later of the two.
    assert_eq!(
        rows,
        vec![
            ("apart".to_owned(), Some("2026-10-09T08:00:00.000Z".to_owned())),
            ("closed".to_owned(), Some("2026-10-08T06:11:00Z".to_owned())),
            ("open".to_owned(), None),
        ]
    );
}
```

(в миграции `changed_at` у уже существующих строк заполняется временем приёма хоста `received_at`, а у
расформированного короба — `max(received_at, disassembled_at)`; формат устройственной метки у старой
строки безвреден: новые изменения идут в хостовом формате позже по времени, и `since` в приложении
всегда берётся из ответа хоста.)

`tests/box_registry_touch.rs` — страж «ни одного забытого писателя»: тест читает все файлы `host/src`
и сверяет число операторов записи коробов с разрешённым списком; новый оператор записи в `boxes` без
решения о реестре краснит тест.

```rust
//! Every statement that writes the `boxes` table is known (plan ТСД-Х, task Х4): the registry the
//! handhelds mirror is derived from `boxes.changed_at`, so a writer that changes a closed box and
//! does not touch it would leave a handheld with a stale box until the next full walk.

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// `(file under src/, the statement, how many times)`: each with the reason it is allowed.
const WRITERS: &[(&str, &str, usize)] = &[
    // An open box has no SSCC and is not in the registry.
    ("facts/scan.rs", "INSERT INTO boxes", 1),
    // Closing: touches the box (`registry_touch::box_by_id`).
    ("facts/box_closed.rs", "UPDATE boxes SET", 1),
    // A label check changes print columns the registry does not carry.
    ("facts/box_label.rs", "UPDATE boxes SET", 1),
    // A box taken apart by a station's exception: touches the box.
    ("facts/exception.rs", "UPDATE boxes SET", 1),
    // A box taken apart by a disaggregation document: touches the box.
    ("disaggregation.rs", "UPDATE boxes SET", 1),
    // `registry_touch` itself.
    ("facts/registry_touch.rs", "UPDATE boxes SET", 4),
    // A unit-test fixture of the restore module, not a writer.
    ("restore.rs", "INSERT INTO boxes", 1),
];

#[test]
fn every_writer_of_boxes_is_known() {
    let mut files = Vec::new();
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut found: Vec<(String, &str, usize)> = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        let relative = file
            .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for statement in ["UPDATE boxes SET", "INSERT INTO boxes"] {
            let count = text.matches(statement).count();
            if count > 0 {
                found.push((relative.clone(), statement, count));
            }
        }
    }
    found.sort();
    let mut known: Vec<(String, &str, usize)> = WRITERS
        .iter()
        .map(|(file, statement, count)| ((*file).to_owned(), *statement, *count))
        .collect();
    known.sort();
    assert_eq!(found, known, "a new writer of `boxes`: decide whether it touches the registry");
}
```

`tests/box_registry.rs`:

```rust
//! The registry of closed boxes for a handheld (plan ТСД-Х, task Х4, spec 6.5): pages by
//! `(changed_at, sscc)`, a window `since..until`, no codes, and a change time that moves with every
//! write that changes a box or what it stands on.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_id, code_hash, empty, fact, instant, json as json_request, pair_handheld,
    record_id, request, shift_setup, with_device, Admin,
};
use support::handheld::{
    added, box_sscc, closed_boxes, event, opened, pallet_block, pallet_sscc, product_of,
    receipts_of, PALLET_A,
};
use time::Duration;

async fn registry(admin: &Admin, key: &str, query: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/box-registry{query}")),
            key,
        )))
        .await
}

/// A whole walk: every page of one window; returns the window's `until` and the items.
async fn walk(admin: &Admin, key: &str, since: Option<&str>, limit: u32) -> (String, Vec<Value>) {
    let since = since.map(|since| format!("&since={since}")).unwrap_or_default();
    let (status, first) = registry(admin, key, &format!("?limit={limit}{since}")).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let until = first["until"].as_str().unwrap().to_owned();
    let mut items = first["items"].as_array().unwrap().clone();
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    while let Some(next) = cursor {
        let (status, page) =
            registry(admin, key, &format!("?limit={limit}&until={until}&cursor={next}{since}")).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["until"], json!(until));
        items.extend(page["items"].as_array().unwrap().clone());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    (until, items)
}

#[tokio::test]
async fn a_walk_lists_closed_boxes_in_pages_without_a_code_of_theirs() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 3).await;
    let key = pair_handheld(&admin).await;
    let (until, items) = walk(&admin, &key, None, 2).await;
    assert_eq!(items.len(), 3);
    let sscc: Vec<&str> = items.iter().map(|item| item["sscc"].as_str().unwrap()).collect();
    let mut sorted = sscc.clone();
    sorted.sort_unstable();
    assert_eq!(sscc, sorted, "one change time here: the order falls back to the SSCC");
    let first = &items[0];
    assert_eq!(first["kind"], json!("upsert"));
    assert_eq!(first["productId"], json!(setup.product));
    assert_eq!(first["bottleCount"], json!(1));
    assert_eq!(first["palletActive"], json!(false));
    assert_eq!(first["productionDate"], json!("2026-10-08"));
    assert!(first.get("palletSscc").is_none() && first.get("contentKeys").is_none());
    assert_eq!(first["closedAt"], json!(instant(1, 500)));
    // No code, no hash and no canonical text of a code leaves the host.
    let text = Value::Array(items.clone()).to_string();
    assert!(!text.contains(&code_hash(1)) && !text.contains("canonical"));
    // The first page names its window; asking for one on the first page is the device's mistake.
    let (status, refused) = registry(&admin, &key, &format!("?until={until}")).await;
    assert_eq!((status, refused["error"]["details"]["field"].clone()), (StatusCode::BAD_REQUEST, json!("until")));
    let (status, refused) = registry(&admin, &key, "?cursor=2026-10-08T06:00:00Z%7C046006820000015000").await;
    assert_eq!((status, refused["error"]["details"]["field"].clone()), (StatusCode::BAD_REQUEST, json!("until")));
}

#[tokio::test]
async fn a_change_moves_a_box_into_the_next_window_with_its_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let (until, _) = walk(&admin, &key, None, 100).await;
    admin.app.clock.advance(Duration::seconds(30));
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(&admin, &key, &[
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
    ])
    .await;
    // Only the box that was put on the pallet is in the next window, standing on an open pallet.
    let (next, items) = walk(&admin, &key, Some(&until), 100).await;
    let on_pallet: Vec<&Value> = items.iter().filter(|item| item["sscc"] == json!(box_sscc(1500))).collect();
    assert_eq!(on_pallet.len(), 1);
    assert_eq!(on_pallet[0]["palletId"], json!(PALLET_A));
    assert_eq!(on_pallet[0]["palletActive"], json!(true));
    assert!(on_pallet[0].get("palletSscc").is_none());
    assert!(items.iter().all(|item| item["sscc"] != json!(box_sscc(1501))));
    // The pallet closes: its boxes carry the SSCC now.
    admin.app.clock.advance(Duration::seconds(30));
    receipts_of(&admin, &key, &[event(3, "warehouse_pallet_closed", json!({
        "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
        "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
    }))])
    .await;
    let (_, items) = walk(&admin, &key, Some(&next), 100).await;
    assert_eq!(items[0]["palletSscc"], json!(pallet_sscc(40)));
}

#[tokio::test]
async fn a_taken_apart_box_is_a_removal_and_the_restore_epoch_rides_every_page() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let (until, _) = walk(&admin, &key, None, 100).await;
    admin.app.clock.advance(Duration::seconds(30));
    let exception = fact(
        &record_id(900),
        "box_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
            "targetScannedAt": null, "reasonCode": "other", "reasonText": "Короб рассыпался",
            "occurredAt": instant(300, 0)
        }),
    );
    let (status, sent) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/facts"), &floor.key),
            json!({ "records": [exception] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["receipts"][0]["outcome"], json!("accepted"), "{sent}");
    let (_, items) = walk(&admin, &key, Some(&until), 100).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], json!("remove"));
    assert_eq!(items[0]["sscc"], json!(box_sscc(1500)));
    assert!(items[0].get("boxId").is_none());
    // A whole walk does not list it.
    let (_, whole) = walk(&admin, &key, None, 100).await;
    assert_eq!(whole.len(), 1);
    // After a restore from a copy the epoch is on the page.
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    sqlx::query("UPDATE site SET restore_epoch = ?").bind(epoch).execute(&admin.app.state.pool).await.unwrap();
    let (_, page) = registry(&admin, &key, "").await;
    assert_eq!(page["restoreEpoch"], json!(epoch));
}

#[tokio::test]
async fn only_a_handheld_reads_the_registry_and_a_bad_query_is_a_validation_error() {
    let admin = admin().await;
    let (status, refused) = registry(&admin, &admin.key, "").await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
    let key = pair_handheld(&admin).await;
    for query in ["?limit=0", "?limit=501", "?since=yesterday", "?cursor=nothing&until=2026-10-08T06:00:00Z"] {
        let (status, body) = registry(&admin, &key, query).await;
        assert_eq!((status, body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!("validation_failed")), "{query}");
    }
}
```

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test box_registry --test box_registry_touch --test migration_handheld_host`
  Expected: `box_registry` — `404 no route`; `box_registry_touch` — падает на разнице списков (`registry_touch.rs` ещё нет);
  `migration_handheld_host` — `no such column: changed_at`.

- [ ] **Step 3: миграция.** `0037_box_registry_changes.sql`:

```sql
-- When a closed box last changed what a handheld's registry shows (plan ТСД-Х, spec 6.4, 6.5): it
-- closed, was taken apart, stood on a pallet or left one, or the pallet it stands on closed or was
-- taken apart. The host's clock, in the stored timestamp format, set by `facts::registry_touch` in
-- the transaction that changes the box. A rowid would do, but a copy (`VACUUM INTO`) does not
-- promise to keep it. NULL for an open box: it has no SSCC and is in no registry.
ALTER TABLE boxes ADD COLUMN changed_at TEXT;
-- Existing boxes: the host's own time of receipt; a box taken apart is later than that.
UPDATE boxes SET changed_at = CASE
  WHEN disassembled_at IS NOT NULL AND disassembled_at > received_at THEN disassembled_at
  ELSE received_at END
WHERE sscc IS NOT NULL;
CREATE INDEX boxes_registry ON boxes (changed_at, sscc) WHERE sscc IS NOT NULL;
```

- [ ] **Step 4: `facts/registry_touch.rs`.**

```rust
//! The change time of a closed box (`boxes.changed_at`, migration `0037`): every write that changes
//! what `GET /v1/device/box-registry` shows about a box calls one of these in the same
//! transaction, with the host's clock in the stored timestamp format (`context.received_at`,
//! `AppState::timestamp()`). `tests/box_registry_touch.rs` knows every writer of `boxes`.

use sqlx::SqliteConnection;

use crate::error::ApiError;

/// One closed box, by id (it closed, or was taken apart).
pub async fn box_by_id(conn: &mut SqliteConnection, box_id: &str, at: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE id = ? AND sscc IS NOT NULL")
        .bind(at)
        .bind(box_id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// One closed box, by its SSCC (a warehouse pallet took it or gave it back).
pub async fn box_by_sscc(conn: &mut SqliteConnection, sscc: &str, at: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE sscc = ?")
        .bind(at)
        .bind(sscc)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// Every closed box of a production pallet (it closed, or was taken apart).
pub async fn pallet_boxes(conn: &mut SqliteConnection, pallet_id: &str, at: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE pallet_id = ? AND sscc IS NOT NULL")
        .bind(at)
        .bind(pallet_id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// Every box now on a warehouse pallet (it closed).
pub async fn warehouse_pallet_boxes(
    conn: &mut SqliteConnection,
    pallet_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE boxes SET changed_at = ? WHERE sscc IN \
         (SELECT box_sscc FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL)",
    )
    .bind(at)
    .bind(pallet_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
```

Вызовы:

- `facts/box_closed.rs` — сразу после `UPDATE boxes SET opened_at = …`:
  `registry_touch::box_by_id(&mut *conn, &closed.box_id, context.received_at).await?;`
- `facts/exception.rs` — внутри `if exception.exception == ExceptionKind::Disassemble { … }` после `UPDATE boxes`:
  `registry_touch::box_by_id(&mut *conn, &exception.box_id, context.received_at).await?;`
- `facts/pallet_closed.rs` — после `INSERT INTO pallets … ON CONFLICT`:
  `registry_touch::pallet_boxes(&mut *conn, &closed.pallet_id, context.received_at).await?;`
- `facts/pallet_exception.rs` — в ветке `Disassemble` после `UPDATE pallets`:
  `registry_touch::pallet_boxes(&mut *conn, &exception.pallet_id, context.received_at).await?;`
- `disaggregation.rs`, `apply_targets`: после `UPDATE boxes SET disassembled_at … RETURNING shift_id`
  `crate::facts::registry_touch::box_by_id(&mut *conn, box_id, at).await?;` (`at` — хостовое время параметра
  функции, не `instant`), а после `UPDATE pallets SET disassembled_at` для паллеты —
  `crate::facts::registry_touch::pallet_boxes(&mut *conn, pallet_id, at).await?;` (имя переменной паллеты
  возьмите из окружающего кода).
- `pallet_events.rs`: в `box_added` после `INSERT INTO warehouse_pallet_boxes` —
  `registry_touch::box_by_sscc(&mut *conn, &data.box_sscc, context.received_at).await?;`; в `box_removed` —
  то же после `UPDATE` (всегда, даже если строки не было: безвредно); в `closed` после `UPDATE warehouse_pallets` —
  `registry_touch::warehouse_pallet_boxes(&mut *conn, &data.pallet_id, context.received_at).await?;`.
  В `use` модуля добавьте `registry_touch`.

- [ ] **Step 5: маршрут.** `routes/box_registry.rs`:

```rust
//! `GET /v1/device/box-registry`: the closed boxes a handheld builds warehouse pallets of (plan
//! ТСД-Х, spec 6.5). A delta by the boxes' change time: `since` (the previous walk's `until`),
//! pages of `(changed_at, sscc)` after `cursor`, every page of one walk under the `until` the first
//! page named. No code of a unit leaves the host (unlike a station's warehouse lookup).

use axum::extract::State;
use axum::Json;
use markiro_proto::{BoxRegistryItem, BoxRegistryKind, BoxRegistryPage};
use serde::Deserialize;

use crate::auth::AskingDevice;
use crate::clock::parse_timestamp;
use crate::error::{ApiError, ApiQuery};
use crate::server::AppState;

const DEFAULT_LIMIT: u32 = 250;
const MAX_LIMIT: u32 = 500;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryQuery {
    since: Option<String>,
    until: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(sqlx::FromRow)]
struct Row {
    sscc: String,
    changed_at: String,
    id: String,
    product_id: String,
    item_count_reported: Option<i64>,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    production_date: String,
    prod_pallet: Option<String>,
    prod_sscc: Option<String>,
    prod_off: Option<String>,
    wh_pallet: Option<String>,
    wh_sscc: Option<String>,
}

fn timestamp(field: &str, text: &str) -> Result<(), ApiError> {
    parse_timestamp(text)
        .map(|_| ())
        .map_err(|_| ApiError::validation(field, "a time as the host writes it"))
}

pub async fn box_registry(
    State(state): State<AppState>,
    _device: AskingDevice,
    ApiQuery(query): ApiQuery<RegistryQuery>,
) -> Result<Json<BoxRegistryPage>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::validation("limit", format!("1-{MAX_LIMIT}")));
    }
    if let Some(since) = &query.since {
        timestamp("since", since)?;
    }
    // The first page names its window; the next ones repeat it (the cloud's rule).
    let (until, after) = match (&query.cursor, &query.until) {
        (None, Some(_)) => {
            return Err(ApiError::validation("until", "not on the first page of a walk"))
        }
        (Some(_), None) => return Err(ApiError::validation("until", "required after the first page")),
        (None, None) => (state.timestamp(), None),
        (Some(cursor), Some(until)) => {
            timestamp("until", until)?;
            let (changed_at, sscc) = cursor
                .split_once('|')
                .filter(|(at, sscc)| parse_timestamp(at).is_ok() && sscc.len() == 18)
                .ok_or_else(|| ApiError::validation("cursor", "a cursor of this registry"))?;
            (until.clone(), Some((changed_at.to_owned(), sscc.to_owned())))
        }
    };
    let (after_at, after_sscc) = after.unwrap_or_default();
    // One snapshot: the window and its rows come from the same read.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT b.sscc AS sscc, b.changed_at AS changed_at, b.id AS id, sh.product_id AS product_id, \
         b.item_count_reported AS item_count_reported, b.closed_at AS closed_at, \
         b.disassembled_at AS disassembled_at, sh.production_date AS production_date, \
         p.id AS prod_pallet, p.sscc AS prod_sscc, p.disassembled_at AS prod_off, \
         wp.id AS wh_pallet, wp.sscc AS wh_sscc \
         FROM boxes b JOIN shifts sh ON sh.id = b.shift_id \
         LEFT JOIN pallets p ON p.id = b.pallet_id \
         LEFT JOIN warehouse_pallet_boxes wb ON wb.box_sscc = b.sscc AND wb.removed_at IS NULL \
         LEFT JOIN warehouse_pallets wp ON wp.id = wb.pallet_id \
         WHERE b.sscc IS NOT NULL AND b.changed_at >= ?1 AND b.changed_at <= ?2 \
         AND (?1 <> '' OR b.disassembled_at IS NULL) \
         AND (b.changed_at, b.sscc) > (?3, ?4) \
         ORDER BY b.changed_at, b.sscc LIMIT ?5",
    )
    .bind(query.since.as_deref().unwrap_or(""))
    .bind(&until)
    .bind(&after_at)
    .bind(&after_sscc)
    .bind(i64::from(limit) + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let restore_epoch: Option<String> =
        sqlx::query_scalar("SELECT restore_epoch FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let more = rows.len() > limit as usize;
    let rows = &rows[..rows.len().min(limit as usize)];
    let next_cursor = more
        .then(|| rows.last().map(|row| format!("{}|{}", row.changed_at, row.sscc)))
        .flatten();
    let items = rows.iter().map(item).collect();
    Ok(Json(BoxRegistryPage {
        until,
        items,
        next_cursor,
        restore_epoch,
    }))
}

fn item(row: &Row) -> BoxRegistryItem {
    if row.disassembled_at.is_some() {
        return BoxRegistryItem::remove(row.sscc.clone(), row.changed_at.clone());
    }
    // A warehouse pallet outranks a taken-apart production one; a standing production pallet
    // holds its boxes from the box's close.
    let (pallet_id, pallet_sscc, active) = match (&row.wh_pallet, &row.prod_pallet, &row.prod_off) {
        (Some(pallet), _, _) => (Some(pallet.clone()), row.wh_sscc.clone(), true),
        (None, Some(pallet), None) => (Some(pallet.clone()), row.prod_sscc.clone(), true),
        _ => (None, None, false),
    };
    BoxRegistryItem {
        kind: BoxRegistryKind::Upsert,
        sscc: row.sscc.clone(),
        updated_at: row.changed_at.clone(),
        box_id: Some(row.id.clone()),
        product_id: Some(row.product_id.clone()),
        bottle_count: row.item_count_reported.and_then(|count| u32::try_from(count).ok()),
        pallet_id,
        pallet_sscc,
        pallet_active: Some(active),
        closed_at: row.closed_at.clone(),
        production_date: Some(row.production_date.clone()),
    }
}
```

`crate::error::ApiQuery` и `parse_timestamp` существуют (`ApiQuery` — как в `routes/changes.rs`; `parse_timestamp` —
`crate::clock`); `BoxRegistryItem::remove(sscc, updated_at)` и поля структуры — из П1. В `server.rs` после
`/v1/device/pallet-events`:

```rust
        .route(
            "/v1/device/box-registry",
            get(crate::routes::box_registry::box_registry),
        )
```

`routes/mod.rs`: `pub mod box_registry;`. `device_kinds.rs`: `("GET", "/v1/device/box-registry", &[Handheld]),`.
`license/gate.rs` `NEVER`: `("GET", "/v1/device/box-registry"),`.

Замечание о `Row`: первые две колонки запроса названы `AS sscc`, `AS changed_at`, чтобы `FromRow` не зависел
от порядка; `id` и `product_id` тоже названы явно.

- [ ] **Step 6: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test box_registry --test box_registry_touch --test migration_handheld_host --test pallet_events --test device_kind_routes --test license_routes`
  Expected: все `ok` (`box_registry`: `4 passed`, `box_registry_touch`: `1 passed`, `migration_handheld_host`: `2 passed`).

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host`
  Expected: весь набор `ok` (тесты выгрузок и дезагрегации не меняются: `changed_at` не входит ни в один их запрос).

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/host/migrations/0037_box_registry_changes.sql apps/standalone/host/src/facts/registry_touch.rs apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/box_closed.rs apps/standalone/host/src/facts/exception.rs apps/standalone/host/src/facts/pallet_closed.rs apps/standalone/host/src/facts/pallet_exception.rs apps/standalone/host/src/disaggregation.rs apps/standalone/host/src/pallet_events.rs apps/standalone/host/src/routes/box_registry.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/device_kinds.rs apps/standalone/host/src/license/gate.rs apps/standalone/host/tests/box_registry.rs apps/standalone/host/tests/box_registry_touch.rs apps/standalone/host/tests/migration_handheld_host.rs
git -C "$WT" commit -m "feat(standalone): the closed-box registry for a handheld (boxes.changed_at, box-registry)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х5: печать организации для ТСД и список складских паллет в офисе

**Files:**

- Create: `apps/standalone/host/src/routes/org_print.rs`, `apps/standalone/host/src/routes/office_warehouse_pallets.rs`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `server.rs`, `device_kinds.rs`, `license/gate.rs`
- Test: `apps/standalone/host/tests/org_print.rs`, `apps/standalone/host/tests/office_warehouse_pallets.rs`
- Modify (webview): `apps/standalone/src/host/api.ts` (`listWarehousePallets`),
  `apps/standalone/src/office/codes/PalletsTab.tsx`, `apps/standalone/src/i18n/ru.json`,
  `apps/standalone/test/support/office.tsx`, `apps/standalone/test/support/pack-cards.ts`
- Create (webview): `apps/standalone/src/office/codes/WarehousePalletsSection.tsx`,
  `apps/standalone/test/warehouse-pallets-section.test.tsx`

**Interfaces:**

- Consumes (П1/П2): `OrgPrint { name, inn, issuerPrefix, logo: ShiftSnapshotLogo | null }`,
  `OfficeWarehousePallets { pallets: [OfficeWarehousePallet] }`, Zod `orgPrintSchema`,
  `officeWarehousePalletsSchema` в `src/host/protocol.ts`; Х3: таблицы складских паллет.
- Produces: `GET /v1/device/org/print`; `GET /v1/office/warehouse-pallets`; `HostApi.listWarehousePallets(token)`.

Решение, которого нет в спецификации: `OrgPrint` несёт ещё и `issuerPrefix` (первые девять цифр GLN,
`validate::issuer_prefix`): складская паллета печатается и нумеруется вне смены, а префикс эмитента
приложение иначе берёт только из снимка смены; считать его на Kotlin из GLN — второе место правила.

- [ ] **Step 1: написать падающие тесты хоста.**

  `tests/org_print.rs`:

```rust
//! What a device prints about the organization outside a shift (plan ТСД-Х, task Х5): its name,
//! INN, SSCC issuer prefix and, when the license has `customLogo`, its print logo.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, pair_device, pair_handheld, request, with_device, Admin};
use support::license::{file, load_ok};

async fn org_print(admin: &Admin, key: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(request("GET", "/v1/device/org/print"), key)))
        .await
}

#[tokio::test]
async fn a_handheld_and_a_station_read_the_organization_to_print() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let expected = json!({
        "name": "ООО «Атолл»", "inn": "7707083893", "issuerPrefix": "460068200", "logo": null
    });
    for key in [&handheld, &admin.key] {
        let (status, body) = org_print(&admin, key).await;
        assert_eq!((status, body), (StatusCode::OK, expected.clone()));
    }
    let (_, office) = pair_device(&admin.app, "office").await;
    let (status, refused) = org_print(&admin, &office).await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
}

#[tokio::test]
async fn the_logo_comes_with_the_feature_and_never_without_it() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let logo = json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" });
    let (status, set) = admin.call("PUT", "/v1/office/org/logo", Some(logo.clone())).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let (_, body) = org_print(&admin, &handheld).await;
    assert_eq!(body["logo"], logo);
    load_ok(&admin, &file(&admin.app.state.host_id, |terms| terms["features"]["customLogo"] = json!(false))).await;
    let (_, body) = org_print(&admin, &handheld).await;
    assert_eq!(body["logo"], Value::Null, "the bundled Markiro logo prints without the feature");
    assert_eq!(body["name"], json!("ООО «Атолл»"));
}
```

`tests/office_warehouse_pallets.rs`:

```rust
//! The office's list of warehouse pallets (plan ТСД-Х, task Х5, decision В-6): a list, newest first,
//! open ones before closed; no card, no export.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, empty, instant, pair_handheld, request, shift_setup, with_device};
use support::handheld::{
    added, closed_boxes, event, opened, pallet_block, pallet_sscc, box_sscc, product_of,
    receipts_of, PALLET_A, PALLET_B,
};

#[tokio::test]
async fn the_list_shows_open_pallets_first_and_counts_the_boxes_on_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(&admin, &key, &[
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        event(3, "warehouse_pallet_closed", json!({
            "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
            "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
        })),
        opened(4, PALLET_B, product_of(&setup), &instant(120, 0)),
        added(5, PALLET_B, &box_sscc(1501), &instant(121, 0)),
    ])
    .await;
    let (status, list) = admin.call("GET", "/v1/office/warehouse-pallets", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let pallets = list["pallets"].as_array().unwrap();
    assert_eq!(pallets.len(), 2);
    assert_eq!(pallets[0]["id"], json!(PALLET_B));
    assert_eq!((pallets[0]["sscc"].clone(), pallets[0]["closedAt"].clone(), pallets[0]["boxes"].clone()), (json!(null), json!(null), json!(1)));
    assert_eq!(pallets[1]["sscc"], json!(pallet_sscc(40)));
    assert_eq!(pallets[1]["boxCountReported"], json!(1));
    assert_eq!(pallets[1]["productName"], json!("Молоко 3,2% 0,9 л"));
    assert_eq!(pallets[1]["deviceName"], json!("ТСД 1"));
    // A handheld's key opens no office route; without a session nothing opens.
    let (status, refused) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/office/warehouse-pallets"), &key)))
        .await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
}
```

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test org_print --test office_warehouse_pallets`
  Expected: `404 no route for GET /v1/device/org/print`, `404 … /v1/office/warehouse-pallets`.

- [ ] **Step 3: реализовать маршруты.** `routes/org_print.rs`:

```rust
//! `GET /v1/device/org/print`: what a device prints about the organization when no shift is open
//! (plan ТСД-Х, task Х5): the name, INN, SSCC issuer prefix and the print logo. A shift's snapshot
//! freezes the same for a running shift; a handheld's warehouse pallet has none. The logo is the
//! license's feature `customLogo`: without it `null`, and a device prints the bundled Markiro one.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgPrint, ShiftSnapshotLogo};

use crate::auth::AskingDevice;
use crate::error::ApiError;
use crate::server::AppState;

pub async fn org_print(
    State(state): State<AppState>,
    _device: AskingDevice,
) -> Result<Json<OrgPrint>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let profile: Option<(String, Option<String>, String)> =
        sqlx::query_as("SELECT name, inn, gln FROM org_profile WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let (name, inn, gln) =
        profile.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let own_logo = crate::license::gate::custom_branding(&state, &mut conn).await?;
    let logo = if own_logo {
        crate::routes::org_logo::read_logo(&mut conn)
            .await?
            .map(|logo| ShiftSnapshotLogo {
                width: logo.width,
                height: logo.height,
                pixels_base64: logo.pixels_base64,
            })
    } else {
        None
    };
    Ok(Json(OrgPrint {
        name,
        inn,
        issuer_prefix: crate::validate::issuer_prefix(&gln).to_owned(),
        logo,
    }))
}
```

`routes/office_warehouse_pallets.rs`:

```rust
//! `GET /v1/office/warehouse-pallets`: the pallets handhelds built outside shifts (plan ТСД-Х,
//! task Х5, decision В-6): open ones first, then closed newest first, the latest 200. A list only:
//! no card, no export, no disassembly (the parity wave of the office).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeWarehousePallet, OfficeWarehousePallets};

use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

const LIMIT: i64 = 200;

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    device_id: String,
    device_name: String,
    product_id: String,
    product_name: String,
    opened_at: String,
    closed_at: Option<String>,
    sscc: Option<String>,
    box_count_reported: Option<i64>,
    boxes: i64,
}

pub async fn list(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeWarehousePallets>, ApiError> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT wp.id AS id, wp.device_id AS device_id, d.name AS device_name, \
         wp.product_id AS product_id, pr.name AS product_name, wp.opened_at AS opened_at, \
         wp.closed_at AS closed_at, wp.sscc AS sscc, wp.box_count_reported AS box_count_reported, \
         (SELECT COUNT(*) FROM warehouse_pallet_boxes wb \
          WHERE wb.pallet_id = wp.id AND wb.removed_at IS NULL) AS boxes \
         FROM warehouse_pallets wp JOIN devices d ON d.id = wp.device_id \
         JOIN products pr ON pr.id = wp.product_id \
         ORDER BY ifnull(wp.closed_at, '~') DESC, wp.id DESC LIMIT ?",
    )
    .bind(LIMIT)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(OfficeWarehousePallets {
        pallets: rows
            .into_iter()
            .map(|row| OfficeWarehousePallet {
                id: row.id,
                device_id: row.device_id,
                device_name: row.device_name,
                product_id: row.product_id,
                product_name: row.product_name,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                sscc: row.sscc,
                boxes: u32::try_from(row.boxes).unwrap_or(0),
                box_count_reported: row
                    .box_count_reported
                    .and_then(|count| u32::try_from(count).ok()),
            })
            .collect(),
    }))
}
```

`server.rs`: после `/v1/device/box-registry`

```rust
        .route(
            "/v1/device/org/print",
            get(crate::routes::org_print::org_print),
        )
```

и рядом с `/v1/office/org/logo` —
`.route("/v1/office/warehouse-pallets", get(crate::routes::office_warehouse_pallets::list))`.
`routes/mod.rs`: `pub mod org_print; pub mod office_warehouse_pallets;`.
`device_kinds.rs`: `("GET", "/v1/device/org/print", &[Station, Handheld]),`.
`license/gate.rs` `NEVER`: `("GET", "/v1/device/org/print"),` и `("GET", "/v1/office/warehouse-pallets"),`.

- [ ] **Step 4: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test org_print --test office_warehouse_pallets --test device_kind_routes --test license_routes`
  Expected: все `ok` (`org_print`: `2 passed`, `office_warehouse_pallets`: `1 passed`).

- [ ] **Step 5: webview — падающий тест.** `test/warehouse-pallets-section.test.tsx` (образец —
      `test/pallets-tab.test.tsx`: те же `openCodes`, `chooseTab`, `packSession` из `support/pack-cards.js`):

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { chooseTab, openCodes, packSession } from "./support/pack-cards.js";

const WAREHOUSE = {
  pallets: [
    {
      id: "a1000000-0000-4000-8000-000000000002",
      deviceId: "d1000000-0000-4000-8000-000000000001",
      deviceName: "ТСД 1",
      productId: "p1000000-0000-4000-8000-000000000001",
      productName: "Молоко 3,2% 0,9 л",
      openedAt: "2026-10-08T06:02:00.000Z",
      closedAt: null,
      sscc: null,
      boxes: 3,
      boxCountReported: null,
    },
    {
      id: "a1000000-0000-4000-8000-000000000001",
      deviceId: "d1000000-0000-4000-8000-000000000001",
      deviceName: "ТСД 1",
      productId: "p1000000-0000-4000-8000-000000000001",
      productName: "Молоко 3,2% 0,9 л",
      openedAt: "2026-10-08T05:00:00.000Z",
      closedAt: "2026-10-08T05:30:00.000Z",
      sscc: "146006820000000409",
      boxes: 40,
      boxCountReported: 40,
    },
  ],
};

describe("warehouse pallets in «Поиск кодов» → «Паллеты» (plan ТСД-Х, decision В-6)", () => {
  it("lists what handhelds built outside shifts, open ones first, and nothing more", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue(WAREHOUSE);
    await openCodes(session);
    chooseTab("Паллеты");
    const section = await screen.findByRole("region", { name: "Складские паллеты" });
    const rows = within(section).getAllByRole("row");
    // The header and two pallets: the open one (no SSCC yet) first.
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Открыта")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("3")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("(00)146006820000000409")).toBeTruthy();
    expect(within(section).queryByRole("link")).toBeNull();
    await waitFor(() => expect(session.api.listWarehousePallets).toHaveBeenCalledTimes(1));
  });

  it("says there are none when no handheld built a pallet", async () => {
    const session = packSession();
    session.api.listWarehousePallets.mockResolvedValue({ pallets: [] });
    await openCodes(session);
    chooseTab("Паллеты");
    const section = await screen.findByRole("region", { name: "Складские паллеты" });
    expect(within(section).getByText("Складских паллет пока нет.")).toBeTruthy();
  });
});
```

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-pallets-section.test.tsx`
Expected: FAIL (`session.api.listWarehousePallets is not a function` / region не найден).

- [ ] **Step 6: webview — реализация.**

  `src/host/api.ts`: в интерфейс `HostApi` рядом с `listPallets` —
  `listWarehousePallets: (token: string) => Promise<OfficeWarehousePallets>;`, в фабрику рядом с `listPallets` —

```ts
    listWarehousePallets: (token) =>
      client.request("GET", "/v1/office/warehouse-pallets", {
        officeToken: token,
        schema: officeWarehousePalletsSchema,
      }),
```

(импорт `officeWarehousePalletsSchema` и тип `OfficeWarehousePallets` из `./protocol.js` — их добавляет П2).
`src/office/office-query.ts`: в `officeKeys` рядом с `palletSheets` — `warehousePallets: ["office", "warehouse-pallets"],`.
`test/support/office.tsx` рядом со строкой `listPallets: vi.fn<HostApi["listPallets"]>(() => unexpected("listPallets")),` —
`listWarehousePallets: vi.fn<HostApi["listWarehousePallets"]>(() => unexpected("listWarehousePallets")),`;
`test/support/pack-cards.ts` в `packSession` рядом со строкой 66 —
`session.api.listWarehousePallets.mockResolvedValue({ pallets: [] });` (иначе существующие тесты вкладки падают на `unexpected`).

`src/office/codes/WarehousePalletsSection.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Card, EmptyState, Table, type TableColumn } from "@markiro/ui";

import type { OfficeWarehousePallet } from "../../host/protocol.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { instantFormat } from "./CodeCard.js";

const COUNT = new Intl.NumberFormat("ru");

/**
 * «Складские паллеты» under the pallets of shifts (plan ТСД-Х, decision В-6): what handhelds built
 * outside shifts from closed boxes. A list only: no card, no export, no taking apart. Open ones
 * first, as the host sends them.
 */
export function WarehousePalletsSection({ zone }: { zone: ReturnType<typeof formTimeZone> }) {
  const { t } = useTranslation();
  const format = instantFormat(zone);
  const list = useOfficeQuery(officeKeys.warehousePallets, (api, token) =>
    api.listWarehousePallets(token),
  );
  const columns: TableColumn<OfficeWarehousePallet>[] = [
    {
      key: "sscc",
      title: t("office.warehousePallets.table.sscc"),
      mono: true,
      render: (pallet) =>
        pallet.sscc === null ? t("office.warehousePallets.open") : `(00)${pallet.sscc}`,
    },
    {
      key: "productName",
      title: t("office.warehousePallets.table.product"),
      wrap: true,
      minWidth: 120,
    },
    {
      key: "deviceName",
      title: t("office.warehousePallets.table.device"),
      wrap: true,
      minWidth: 90,
    },
    {
      key: "boxes",
      title: t("office.warehousePallets.table.boxes"),
      mono: true,
      align: "right",
      render: (pallet) => COUNT.format(pallet.boxes),
    },
    {
      key: "openedAt",
      title: t("office.warehousePallets.table.openedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) => format(pallet.openedAt),
    },
    {
      key: "closedAt",
      title: t("office.warehousePallets.table.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) =>
        pallet.closedAt === null ? t("office.common.none") : format(pallet.closedAt),
    },
  ];
  const content = () => {
    if (list.isPending) return <PageLoading />;
    if (list.isError) return <LoadError error={list.error} onRetry={() => void list.refetch()} />;
    if (list.data.pallets.length === 0)
      return <EmptyState title={t("office.warehousePallets.empty")} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={list.data.pallets}
          getRowKey={(pallet) => pallet.id}
          scrollLabel={t("office.warehousePallets.table.label")}
        />
      </Card>
    );
  };
  return (
    <section aria-label={t("office.warehousePallets.title")} className="office-stack">
      <h2>{t("office.warehousePallets.title")}</h2>
      <p>{t("office.warehousePallets.hint")}</p>
      {content()}
    </section>
  );
}
```

Заголовок секции — обычный `<h2>`, как у соседних подразделов (`PackDocuments.tsx`, `BoxCardPage.tsx`);
нового CSS нет. В `PalletsTab.tsx` в `return` после `{content()}` (последний дочерний элемент `office-stack`) добавьте
`<WarehousePalletsSection zone={zone} />` и импорт. `src/i18n/ru.json`, внутри объекта `office`:

```json
"warehousePallets": {
  "title": "Складские паллеты",
  "hint": "Собраны на ТСД из закрытых коробов вне смены.",
  "empty": "Складских паллет пока нет.",
  "open": "Открыта",
  "table": {
    "label": "Складские паллеты",
    "sscc": "SSCC",
    "product": "Товар",
    "device": "ТСД",
    "boxes": "Коробов",
    "openedAt": "Начата",
    "closedAt": "Закрыта"
  }
}
```

- [ ] **Step 7: запустить, увидеть успех.**

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/warehouse-pallets-section.test.tsx test/pallets-tab.test.tsx test/registry-tabs.test.tsx`
  Expected: три файла `passed`.

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck && pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
  Expected: без ошибок (`tsc` потребует поле `listWarehousePallets` у всех фабрик `HostApi` — единственная тестовая фабрика уже дополнена).

  Визуальной проверки в браузере нет: страницу офиса запускает только оболочка Tauri; в отчёте это назвать явно.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/org_print.rs apps/standalone/host/src/routes/office_warehouse_pallets.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/device_kinds.rs apps/standalone/host/src/license/gate.rs apps/standalone/host/tests/org_print.rs apps/standalone/host/tests/office_warehouse_pallets.rs apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/codes/PalletsTab.tsx apps/standalone/src/office/codes/WarehousePalletsSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/support/pack-cards.ts apps/standalone/test/warehouse-pallets-section.test.tsx
git -C "$WT" commit -m "feat(standalone): org/print for devices and the office's list of warehouse pallets

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х6: перепривязка устройства тем же `deviceId` (`recoverDeviceId`)

**Files:**

- Create: `apps/standalone/host/migrations/0038_pairing_code_device.sql`
- Modify: `apps/standalone/host/src/routes/pairing.rs` (`StoredCode`, `claim`, `create_code` → общая `issue_code`, `create_device_code`)
- Modify: `apps/standalone/host/src/audit.rs` (`actions::DEVICE_REKEY`, `reasons::RECOVERY_MISMATCH`)
- Modify: `apps/standalone/host/src/server.rs` (маршрут), `device_kinds.rs` (правило офиса уже покрывает `/v1/office/*`), `license/gate.rs` (`NEVER`)
- Modify: `apps/standalone/src-tauri/src/device.rs` (литерал `ClaimRequest`, строка ≈351: `recover_device_id: None`)
- Test: `apps/standalone/host/tests/handheld_pairing.rs`; Modify: `apps/standalone/host/tests/migration_handheld_host.rs`
- Modify (webview): `apps/standalone/src/host/api.ts` (`createDevicePairingCode`),
  `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/src/office/devices/PairingCodeDialog.tsx`,
  `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/office.tsx`
- Create (webview): `apps/standalone/test/devices-repair.test.tsx`

**Interfaces:**

- Consumes (П1/П2): `ClaimRequest.recover_device_id: Option<String>` (`recoverDeviceId`, необязательное,
  `skip_serializing_if`); Zod `claimRequestSchema` с тем же полем; `PairingCode` без изменений.
- Produces: `POST /v1/office/devices/{id}/pairing-code` (администратор) — код, привязанный к устройству;
  `POST /v1/pairing/claim` с `recoverDeviceId` — НОВЫЙ ключ тому же `deviceId`, старый отозван,
  новая строка устройства и новое место лицензии не создаются; `HostApi.createDevicePairingCode(token, id)`.

Решения, которых нет в спецификации:

- Миграция `0038`: `pairing_codes.device_id`. Без неё код нельзя привязать к устройству (в `0005` колонки нет).
- Код, привязанный к устройству, и запрос без `recoverDeviceId` (или с другим) — `pairing_code_invalid`; код при
  этом не сгорает и счётчик неверных попыток не растёт (владелец ошибся приложением, а не угадывает код).
  Обратно, обычный код с `recoverDeviceId` — тот же отказ. Аудит отказа — `device.claim`, `denied`,
  `reason = recovery_mismatch`.
- Перепривязка станции заканчивает и её офисные сессии: ключ, потерянный вместе с ПК, не должен оставлять живую сессию.
- Имя и линия устройства при перепривязке не меняются (они принадлежат офису); версия, протокол и возможности
  берутся из запроса: приложение после обновления.

- [ ] **Step 1: написать падающие тесты хоста.** `tests/handheld_pairing.rs`:

```rust
//! A handheld paired again with the same `deviceId` (plan ТСД-Х, task Х6, spec 6.6): the office
//! issues a code for one device; the claim with `recoverDeviceId` gives that device a new key and
//! ends the old one, takes no new seat and writes the audit rows exactly.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, json as json_request, login, pair_device, pair_handheld, request,
    with_device, Admin, LAN,
};

async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, info) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    info["id"].as_str().unwrap().to_owned()
}

async fn code_for(admin: &Admin, device: &str) -> (StatusCode, Value) {
    admin
        .call("POST", &format!("/v1/office/devices/{device}/pairing-code"), None)
        .await
}

async fn claim(admin: &Admin, code: &Value, kind: &str, recover: Option<&str>) -> (StatusCode, Value) {
    let mut body = json!({
        "code": code, "kind": kind, "name": "Другое имя", "appVersion": "1.3.0",
        "capabilities": ["handheld-host-v1"]
    });
    if let Some(recover) = recover {
        body["recoverDeviceId"] = json!(recover);
    }
    admin
        .app
        .send_from(LAN, json_request(request("POST", "/v1/pairing/claim"), body))
        .await
}

async fn live_devices(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_code_for_a_device_gives_it_a_new_key_and_ends_the_old_one() {
    let admin = admin().await;
    let old = pair_handheld(&admin).await;
    let id = device_id(&admin, &old).await;
    let devices = live_devices(&admin).await;
    let (status, code) = code_for(&admin, &id).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    assert_eq!(code["code"].as_str().unwrap().len(), 10);
    assert!(code["payload"].as_str().unwrap().starts_with("markiro-host:1?"));

    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    assert_eq!(paired["deviceId"], json!(id));
    assert_eq!(paired["hostId"], json!(admin.app.state.host_id));
    let new = paired["deviceKey"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    // The old key is dead at once; the new one is the same device, same name and no new seat.
    let (status, refused) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &old)))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    let (status, info) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &new)))
        .await;
    assert_eq!((status, info["id"].clone(), info["name"].clone()), (StatusCode::OK, json!(id), json!("ТСД 1")));
    assert_eq!(live_devices(&admin).await, devices);
    // The stored record took the new app's version and capabilities.
    let (version, capabilities): (String, String) =
        sqlx::query_as("SELECT app_version, capabilities FROM devices WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((version.as_str(), capabilities.as_str()), ("1.3.0", r#"["handheld-host-v1"]"#));
    // The code is spent.
    let (status, again) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!((status, again["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!("pairing_code_invalid")));

    // The trail: the re-keying is the device's own row; the code's creation names the device.
    let rekey = audit_trail(&admin.app, "device.rekey").await;
    assert_eq!(rekey.len(), 1);
    assert_eq!(
        (&rekey[0].0[..], rekey[0].1.as_deref(), rekey[0].3.as_deref(), rekey[0].4.as_deref(), &rekey[0].5[..]),
        ("device", Some(id.as_str()), Some("device"), Some(id.as_str()), "ok")
    );
    assert_eq!(rekey[0].6["kind"], json!("handheld"));
    assert_eq!(rekey[0].6["address"], json!("192.168.1.20"));
    let created = audit_trail(&admin.app, "pairing_code.create").await;
    assert_eq!(created.last().unwrap().6["deviceId"], json!(id));
}

#[tokio::test]
async fn a_code_works_only_for_its_own_device_and_a_wrong_use_does_not_burn_it() {
    let admin = admin().await;
    let first = pair_handheld(&admin).await;
    let second = pair_handheld(&admin).await;
    let (first_id, second_id) = (device_id(&admin, &first).await, device_id(&admin, &second).await);
    let (_, code) = code_for(&admin, &first_id).await;
    let invalid = |answer: (StatusCode, Value)| (answer.0, answer.1["error"]["code"].clone());
    let refused = (StatusCode::BAD_REQUEST, json!("pairing_code_invalid"));
    // Another device's id, no id, and a different kind: all refused, the code stays whole.
    assert_eq!(invalid(claim(&admin, &code["code"], "handheld", Some(&second_id)).await), refused);
    assert_eq!(invalid(claim(&admin, &code["code"], "handheld", None).await), refused);
    assert_eq!(invalid(claim(&admin, &code["code"], "station", Some(&first_id)).await), refused);
    let (used, failed): (Option<String>, i64) =
        sqlx::query_as("SELECT used_at, failed_attempts FROM pairing_codes ORDER BY created_at DESC LIMIT 1")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((used, failed), (None, 0));
    let denied: Vec<_> = audit_trail(&admin.app, "device.claim")
        .await
        .into_iter()
        .filter(|row| row.5 == "denied")
        .collect();
    assert_eq!(denied.len(), 3);
    assert!(denied.iter().all(|row| row.6["reason"] == json!("recovery_mismatch")));
    // A plain code never re-keys a device.
    let (_, plain) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(invalid(claim(&admin, &plain["code"], "handheld", Some(&first_id)).await), refused);
    // …and the right claim still works.
    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&first_id)).await;
    assert_eq!((status, paired["deviceId"].clone()), (StatusCode::OK, json!(first_id)));
}

#[tokio::test]
async fn only_a_live_station_or_handheld_gets_a_code_and_only_an_administrator_asks() {
    let admin = admin().await;
    let key = pair_handheld(&admin).await;
    let id = device_id(&admin, &key).await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let office_id = device_id(&admin, &office).await;
    let (status, refused) = code_for(&admin, &office_id).await;
    assert_eq!((status, refused["error"]["details"]["field"].clone()), (StatusCode::BAD_REQUEST, json!("id")));
    let (status, missing) = code_for(&admin, "00000000-0000-4000-8000-0000000000aa").await;
    assert_eq!((status, missing["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    // A device revoked after the code was made is refused at the claim.
    let (_, code) = code_for(&admin, &id).await;
    let (status, revoked) = admin.call("POST", &format!("/v1/office/devices/{id}/revoke"), None).await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, refused) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!("pairing_code_invalid")));
    let (status, missing) = code_for(&admin, &id).await;
    assert_eq!((status, missing["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    // A technologist is not an administrator.
    let technologist = admin.technologist().await;
    let (status, forbidden) = admin
        .call_as(&technologist, "POST", &format!("/v1/office/devices/{id}/pairing-code"), None)
        .await;
    assert_eq!((status, forbidden["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
}

#[tokio::test]
async fn a_station_paired_again_loses_its_office_sessions() {
    let admin = admin().await;
    let (station_id, station_key) = pair_device(&admin.app, "station").await;
    let token = login(&admin.app, &station_key, "admin", "correct horse battery").await;
    let (status, _) = admin
        .app
        .send(empty(support::app::with_session(request("GET", "/v1/office/me"), &station_key, &token)))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, code) = code_for(&admin, &station_id).await;
    let (status, paired) = claim(&admin, &code["code"], "station", Some(&station_id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    assert_ne!(paired["deviceKey"].as_str().unwrap(), station_key);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id = ?")
        .bind(&station_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0, "the session ended with the old key");
}
```

В `tests/migration_handheld_host.rs` допишите проверку колонки:

```rust
#[tokio::test]
async fn a_pairing_code_may_name_a_device() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(37).run(&pool).await.unwrap();
    sqlx::query("INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
                 VALUES ('u', 'admin', 'A', 'admin', 'x', 1, 't', 1)")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at) \
                 VALUES ('c', 'h', 'u', 't', 't2')")
        .execute(&pool).await.unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    let device: Option<String> = sqlx::query_scalar("SELECT device_id FROM pairing_codes WHERE id = 'c'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(device, None, "an existing code names no device");
}
```

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test handheld_pairing --test migration_handheld_host`
  Expected: `404 no route for POST /v1/office/devices/{id}/pairing-code`; `no such column: device_id`.

- [ ] **Step 3: миграция.** `0038_pairing_code_device.sql`:

```sql
-- A one-time code made for ONE device (plan ТСД-Х, task Х6, spec 6.6): the office re-pairs a
-- handheld whose key was lost, or whose app was installed anew, with the same `deviceId`, so the
-- queue the old key left stays the device's own (`not_entered` otherwise: a new device never
-- entered the shifts the old one did). NULL: an ordinary code, which pairs a new device.
ALTER TABLE pairing_codes ADD COLUMN device_id TEXT REFERENCES devices (id);
```

- [ ] **Step 4: реализовать.** `audit.rs`: в `actions` — `pub const DEVICE_REKEY: &str = "device.rekey";`;
      в `reasons` — `pub const RECOVERY_MISMATCH: &str = "recovery_mismatch";`.

  `routes/pairing.rs`:

  1. `StoredCode` получает `device_id: Option<String>`; запрос читает `SELECT id, expires_at, used_at, failed_attempts, device_id FROM pairing_codes WHERE code_hash = ?`.
  2. Тело `create_code` переносится в `async fn issue_code(state: &AppState, context: &OfficeContext, device: Option<&str>, replaces: Option<String>) -> Result<Json<PairingCode>, ApiError>`;
     `create_code` вызывает `issue_code(&state, &context, None, replaces)` (поведение и аудит `{expiresAt}` /
     `{expiresAt, replaces}` не меняются). В `issue_code` после `context.require_admin_in(&mut tx).await?`:

```rust
    if let Some(device) = device {
        let kind: Option<String> =
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
                .bind(device)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        let kind: DeviceKind = kind
            .ok_or_else(|| ApiError::not_found("no such live device"))?
            .parse()
            .map_err(ApiError::internal)?;
        if !matches!(kind, DeviceKind::Station | DeviceKind::Handheld) {
            return Err(ApiError::validation(
                "id",
                "only a station or a handheld pairs again with a code",
            ));
        }
    }
```

     `INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at, device_id) VALUES (?, ?, ?, ?, ?, ?)`
     с `.bind(device)`; детали аудита при `device`: `json!({ "expiresAt": expires, "deviceId": device })`.

3. Новый обработчик:

```rust
/// `POST /v1/office/devices/{id}/pairing-code` (administrators): a one-time code that re-pairs
/// device `{id}` with its own `deviceId` (plan ТСД-Х, task Х6).
pub async fn create_device_code(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(device): ApiPath<String>,
) -> Result<Json<PairingCode>, ApiError> {
    context.require_admin()?;
    validate::client_uuid("id", &device)?;
    issue_code(&state, &context, Some(&device), None).await
}
```

4. В `claim`, до проверки кода: `if let Some(id) = &request.recover_device_id { validate::client_uuid("recoverDeviceId", id)?; }`.
   После вычисления `code` (успешной проверки живости) и до блока «The license's feature and seat»:

```rust
    // Re-pairing: a code made for one device is that device's, and an ordinary code never
    // re-keys one. A mistake of the app is not a guess at the code: the code stays whole.
    let recovered = match (&code.device_id, &request.recover_device_id) {
        (None, None) => false,
        (Some(bound), Some(asked)) if bound == asked => {
            let kind: Option<String> =
                sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
                    .bind(bound)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(ApiError::internal)?;
            let kind = kind
                .map(|kind| kind.parse::<DeviceKind>())
                .transpose()
                .map_err(ApiError::internal)?;
            if kind != Some(request.kind) {
                return Err(deny_recovery(tx, &at, &code.id, &request, name, &address).await);
            }
            true
        }
        _ => return Err(deny_recovery(tx, &at, &code.id, &request, name, &address).await),
    };
```

     где

```rust
/// A refused re-pairing: audited as a denied claim and committed (the audit row stays, the code is
/// untouched), answered like any invalid code.
async fn deny_recovery(
    mut tx: sqlx::Transaction<'static, sqlx::Sqlite>,
    at: &str,
    code_id: &str,
    request: &ClaimRequest,
    name: &str,
    address: &str,
) -> ApiError {
    let written = async {
        audit::record(
            &mut tx,
            at,
            Entry {
                actor: Actor::System,
                action: actions::DEVICE_CLAIM,
                target_type: Some("pairing_code"),
                target_id: Some(code_id),
                outcome: Outcome::Denied,
                details: json!({
                    "reason": reasons::RECOVERY_MISMATCH,
                    "kind": request.kind.as_str(),
                    "name": name,
                    "address": address,
                }),
            },
        )
        .await?;
        tx.commit().await
    }
    .await;
    match written {
        Ok(()) => ApiError::new(
            StatusCode::BAD_REQUEST,
            codes::PAIRING_CODE_INVALID,
            "the pairing code is not valid",
        ),
        Err(error) => ApiError::internal(error),
    }
}
```

     Затем ветка перепривязки перед `insert_device`:

```rust
    if recovered {
        let device_id = code.device_id.clone().expect("a recovery names its device");
        sqlx::query("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
            .bind(&at)
            .bind(&code.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let key = random_key();
        sqlx::query(
            "UPDATE devices SET key_hash = ?, app_version = ?, protocol = ?, capabilities = ?, \
             last_seen_at = ?, version_seen_at = ? WHERE id = ?",
        )
        .bind(key_hash(&key))
        .bind(app_version)
        .bind(i64::from(protocol))
        .bind(serde_json::to_string(&request.capabilities).map_err(ApiError::internal)?)
        .bind(&at)
        .bind(&at)
        .bind(&device_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        // The key lost with a PC may have left a session behind.
        sqlx::query("DELETE FROM office_sessions WHERE device_id = ?")
            .bind(&device_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: Actor::Device(&device_id),
                action: actions::DEVICE_REKEY,
                target_type: Some("device"),
                target_id: Some(&device_id),
                outcome: Outcome::Ok,
                details: json!({
                    "kind": request.kind.as_str(),
                    "pairingCodeId": code.id,
                    "address": address,
                }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        tx.commit().await.map_err(ApiError::internal)?;
        return Ok(Json(PairResponse {
            device_id,
            device_key: key.into(),
            host_id: state.host_id.clone(),
        }));
    }
```

     Ветка стоит ДО проверок возможности и места: перепривязка не занимает нового места и не требует
     возможности `handheld` (устройство уже в файле лицензии).

5. `server.rs`: рядом с `/v1/office/devices/{id}/revoke` —
`.route("/v1/office/devices/{id}/pairing-code", post(crate::routes::pairing::create_device_code))`.
`license/gate.rs` `NEVER`: `("POST", "/v1/office/devices/{id}/pairing-code"),`. 6. `src-tauri/src/device.rs`: в литерале `ClaimRequest { … }` добавьте `recover_device_id: None,`.

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test handheld_pairing --test migration_handheld_host --test claim --test pairing_codes --test license_routes --test device_kind_routes --test license_seats`
  Expected: все `ok` (`handheld_pairing`: `4 passed`).

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" check -p markiro-standalone --tests`
  Expected: `Finished` без ошибок (литерал `ClaimRequest` оболочки собирается с новым полем). Если на хосте
  разработчика нет системных библиотек Tauri, эта проверка идёт в CI-задаче `standalone_rust`; в отчёте назвать, где
  она выполнялась.

- [ ] **Step 6: webview — падающий тест.** `test/devices-repair.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeviceRecord, PairingCode } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice } from "./support/office.js";

const TSD: DeviceRecord = {
  id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
  kind: "handheld",
  name: "ТСД склада",
  lineId: null,
  appVersion: "1.0.0",
  pairedAt: "2026-09-26T10:00:00Z",
  lastSeenAt: null,
  revokedAt: null,
};
const OFFICE: DeviceRecord = {
  ...TSD,
  id: "8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b",
  kind: "office",
  name: "Офис",
};
const GONE: DeviceRecord = {
  ...TSD,
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  name: "Старый ТСД",
  revokedAt: "2026-09-26T12:00:00Z",
};

function code(): PairingCode {
  return {
    id: "4c2a9e7b-1d3f-4a5b-8c6d-7e8f9a0b1c2d",
    code: "7K3MQ9XV2D",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    payload: `markiro-host:1?h=10.0.0.5&p=45710&f=${"ab".repeat(32)}&c=7K3MQ9XV2D`,
  };
}

async function open() {
  const session = fakeOfficeSession();
  session.api.listDevices.mockResolvedValue([TSD, OFFICE, GONE]);
  session.api.listLines.mockResolvedValue([]);
  renderOffice(session, { initialPath: "/devices" });
  await screen.findByText("ТСД склада");
  return session;
}

describe("«Привязать заново» (plan ТСД-Х, task Х6)", () => {
  it("is offered for a live station or handheld, not for an office PC or a revoked device", async () => {
    await open();
    expect(
      screen.getByRole("button", { name: "Привязать заново устройство «ТСД склада»" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Привязать заново устройство «Офис»/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Привязать заново устройство «Старый ТСД»/ }),
    ).toBeNull();
  });

  it("asks the host for a code of that device and shows it with what the app must do", async () => {
    const session = await open();
    session.api.createDevicePairingCode.mockResolvedValue(code());
    fireEvent.click(
      screen.getByRole("button", { name: "Привязать заново устройство «ТСД склада»" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Привязать заново: ТСД склада" });
    await waitFor(() =>
      expect(session.api.createDevicePairingCode).toHaveBeenCalledWith(
        "office-session-token",
        TSD.id,
      ),
    );
    expect(within(dialog).getByText("7K3MQ 9XV2D")).toBeTruthy();
    expect(within(dialog).getByText(/Устройство сохранит свои данные/)).toBeTruthy();
    // It is not the dialog of a new device: «Новый код» asks for another code of the same device.
    fireEvent.click(within(dialog).getByRole("button", { name: "Новый код" }));
    await waitFor(() => expect(session.api.createDevicePairingCode).toHaveBeenCalledTimes(2));
    expect(session.api.createPairingCode).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-repair.test.tsx`
Expected: FAIL (`createDevicePairingCode` не определён; кнопки нет).

- [ ] **Step 7: webview — реализация.**

  `src/host/api.ts`: в `HostApi` — `createDevicePairingCode: (token: string, id: string) => Promise<PairingCode>;`, в фабрике:

```ts
    createDevicePairingCode: (token, id) =>
      client.request("POST", `/v1/office/devices/${id}/pairing-code`, {
        officeToken: token,
        schema: pairingCodeSchema,
      }),
```

`test/support/office.tsx`: рядом со строкой `createPairingCode` —
`createDevicePairingCode: vi.fn<HostApi["createDevicePairingCode"]>(() => unexpected("createDevicePairingCode")),`.

`PairingCodeDialog.tsx`: добавьте необязательный проп `repairFor?: string` (имя устройства): при нём заголовок
`t("office.devices.repair.title", { name: repairFor })`, вводный абзац `t("office.devices.repair.intro")` вместо
`office.devices.pairing.intro`, а опрос списка устройств (`refetchInterval`) не включается
(`{ refetchInterval: repairFor === undefined ? DEVICE_POLL_MS : false }`): новое устройство при перепривязке
не появляется.

`DevicesPage.tsx`:

- `Pairing` получает `repairFor?: DeviceRecord`;
- `create` принимает `{ replaces: string | null; device: string | null }` и зовёт
  `api.createDevicePairingCode(token, device)`, если `device !== null`;
- `newCode(device?: DeviceRecord)`: `const target = device ?? pairing?.repairFor;` — для устройства код
  запрашивается через `createDevicePairingCode`, «Новый код» в его диалоге повторяет запрос для того же устройства;
- `joined` вычисляется только при `pairing.repairFor === undefined`;
- в `RowActions` рядом с «Отозвать», для `device.kind !== "office"`, кнопка

```tsx
{
  device.kind !== "office" && (
    <Button
      variant="secondary"
      size="compact"
      aria-label={t("office.devices.repairNamed", { name: device.name })}
      onClick={() => void newCode(device)}
    >
      {t("office.devices.repair.button")}
    </Button>
  );
}
```

- в `<PairingCodeDialog …>` передайте `repairFor={pairing.repairFor?.name}`.

`src/i18n/ru.json`, внутри `office.devices`:

```json
"repairNamed": "Привязать заново устройство «{{name}}»",
"repair": {
  "button": "Привязать заново",
  "title": "Привязать заново: {{name}}",
  "intro": "Устройство сохранит свои данные и неотправленную очередь. На нём откройте «Привязать заново», отсканируйте код или введите адрес хоста и код."
}
```

Тест ищет заголовок диалога `Привязать заново: ТСД склада` (его даёт `title` через `Modal`) и фразу
«Устройство сохранит свои данные». Старый ключ устройства перестаёт работать в момент, когда устройство
использует код; в тексте диалога об этом не нужно говорить подробнее.

- [ ] **Step 8: запустить, увидеть успех.**

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-repair.test.tsx test/devices-page.test.tsx`
  Expected: два файла `passed`.

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck && pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
  Expected: без ошибок.

- [ ] **Step 9: Commit.**

```bash
git -C "$WT" add apps/standalone/host/migrations/0038_pairing_code_device.sql apps/standalone/host/src/routes/pairing.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/license/gate.rs apps/standalone/src-tauri/src/device.rs apps/standalone/host/tests/handheld_pairing.rs apps/standalone/host/tests/migration_handheld_host.rs apps/standalone/src/host/api.ts apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/PairingCodeDialog.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/devices-repair.test.tsx
git -C "$WT" commit -m "feat(standalone): re-pair a device with its own deviceId (a code made for one device)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Х8: сценарий ТСД на хосте, апгрейд баз, документы

**Files:**

- Modify: `apps/standalone/host/tests/support/handheld.rs` (`open_handheld_pallet_floor`)
- Test: `apps/standalone/host/tests/handheld_floor_scenario.rs`
- Modify: `apps/standalone/host/tests/migration_beta3_upgrade.rs` (комментарий: список новых миграций)
- Modify: `apps/standalone/AGENTS.md` («Three identities», «Local pairing trust», «Protocol»)
- Modify: `docs/standalone/ROADMAP.md` (строка про ТСД: ссылка на три плана ТСД)

**Interfaces:**

- Consumes: Х1–Х6 целиком; `proto/fixtures/floor-scenario.json` как источник записей смены (его пишут модули
  станции, `test/floor-scenario.test.ts` следит, что он не меняется: ТСД шлёт те же записи теми же
  квитанциями, поэтому отдельный файл сценария ТСД для смены не нужен).
- Produces: `support::handheld::open_handheld_pallet_floor(&Admin, &ShiftSetup) -> Floor`.

Отличие от спецификации (раздел 11.1: «`floor_scenario.rs` расширяется сценарием ТСД»): `floor-scenario.json`
записан модулями станции и закреплён тестом Vitest, поэтому новый тест проигрывает тот же файл от имени ТСД
и дописывает складскую часть событиями в самом тесте; файл фикстуры не меняется.

- [ ] **Step 1: помощник.** В `tests/support/handheld.rs` добавьте (импорты расширьте: `pallet_shift_body`,
      `pallet_template`, `plan_shift`, `empty` из `super::app`):

```rust
/// A handheld on `setup`'s line (the office gives it the line), a shift with pallets planned on that
/// line and entered by the handheld naming `handheld-host-v1`: the handheld is the shift's owner.
pub async fn open_handheld_pallet_floor(admin: &Admin, setup: &ShiftSetup) -> Floor {
    let key = super::app::pair_handheld(admin).await;
    let (status, info) = admin
        .app
        .send(super::app::empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": setup.line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let template = super::app::pallet_template(admin).await;
    let shift = super::app::plan_shift(admin, super::app::pallet_shift_body(setup, &template)).await;
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    let (status, entered) = admin
        .app
        .send(json_request(
            with_device(request("POST", &path), &key),
            json!({ "supports": ["handheld-host-v1"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    Floor {
        shift: shift["id"].as_str().unwrap().to_owned(),
        number: shift["number"].as_str().unwrap().to_owned(),
        station: id,
        key,
    }
}
```

- [ ] **Step 2: написать падающий тест.** `tests/handheld_floor_scenario.rs`:

```rust
//! The floor scenario replayed by a handheld (plan ТСД-Х, task Х8): the records of
//! `proto/fixtures/floor-scenario.json` — the scans, boxes, labels, exceptions, pallets and the close
//! of one shift with pallets — reach the host from a HANDHELD key and get the station's receipts and
//! numbers; then the same handheld builds a warehouse pallet of what the shift left free.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, instant, issue_block, issue_pallet_block, send_facts, shift_setup, Admin, Floor,
};
use support::handheld::{
    accepted, added, event, open_handheld_pallet_floor, opened, receipts_of, rejected, PALLET_A,
};

/// The scenario, with the station's ids of the shift, the box block and the pallet block replaced by
/// the host's (the fixture was written by a station whose shift and blocks the host never issued).
fn scenario(shift: &str, block: &str, pallet_block: &str) -> Value {
    let path = format!("{}/../proto/fixtures/floor-scenario.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let raw: Value = serde_json::from_str(&text).unwrap();
    let station = |key: &str| raw["station"][key].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station("shiftId"), shift)
            .replace(&station("blockId"), block)
            .replace(&station("palletBlockId"), pallet_block),
    )
    .unwrap()
}

async fn handheld() -> (Admin, Floor, Value, String) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_handheld_pallet_floor(&admin, &setup).await;
    let block = issue_block(&admin.app, &floor.key, "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b").await;
    assert_eq!((block["fromSerial"].clone(), block["toSerial"].clone()), (json!(1500), json!(3499)));
    let pallets = issue_pallet_block(&admin.app, &floor.key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    assert_eq!((pallets["fromSerial"].clone(), pallets["toSerial"].clone()), (json!(40), json!(239)));
    let scenario = scenario(&floor.shift, block["id"].as_str().unwrap(), pallets["id"].as_str().unwrap());
    (admin, floor, scenario, setup.product)
}

fn batch(scenario: &Value, send: &Value) -> Vec<Value> {
    let records = scenario["records"].as_array().unwrap();
    send["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| records.iter().find(|record| &record["id"] == id).unwrap_or_else(|| panic!("no record {id}")).clone())
        .collect()
}

fn all_accepted(records: &[Value]) -> Vec<Value> {
    records.iter().map(|record| json!({ "id": record["id"], "outcome": "accepted" })).collect()
}

async fn take_all(admin: &Admin, floor: &Floor, scenario: &Value) {
    for send in scenario["sends"].as_array().unwrap() {
        if send["answer"] == "unreachable" {
            continue;
        }
        let records = batch(scenario, send);
        let (status, body) = send_facts(&admin.app, &floor.key, &records).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["receipts"], Value::Array(all_accepted(&records)));
    }
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_shift_from_a_handheld_and_ends_with_the_numbers() {
    let (admin, floor, scenario, _) = handheld().await;
    take_all(&admin, &floor, &scenario).await;
    let (status, shift) = admin.call("GET", &format!("/v1/office/shifts/{}", floor.shift), None).await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let station = &scenario["station"];
    assert_eq!(shift["status"], "closed");
    assert_eq!(
        (shift["totals"]["acceptedUnits"].clone(), shift["totals"]["closedBoxes"].clone(), shift["totals"]["closedPallets"].clone()),
        (station["acceptedUnits"].clone(), station["closedBoxes"].clone(), station["closedPallets"].clone())
    );
    // The close is the handheld's own: a device, with the station's reason, and not late.
    let (by, reason, late): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT closed_by_kind, close_reason_code, late_data_at FROM shifts WHERE id = ?",
    )
    .bind(&floor.shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!((by.as_str(), reason.as_deref(), late), ("device", Some("production_order_changed"), None));
    // The last batch again: the same receipts, nothing written.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fact_receipts").fetch_one(&admin.app.state.pool).await.unwrap();
    let last = batch(&scenario, scenario["sends"].as_array().unwrap().last().unwrap());
    let (status, body) = send_facts(&admin.app, &floor.key, &last).await;
    assert_eq!((status, body["receipts"].clone()), (StatusCode::OK, Value::Array(all_accepted(&last))));
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fact_receipts").fetch_one(&admin.app.state.pool).await.unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn what_the_shift_left_free_goes_onto_a_warehouse_pallet_and_the_rest_is_refused_with_its_pallet() {
    let (admin, floor, scenario, product) = handheld().await;
    take_all(&admin, &floor, &scenario).await;
    // After the scenario: box 1500 is taken apart, box 1501 stands on the first pallet (SSCC …409),
    // box 1502 stood on the second pallet, which was taken apart: it is free.
    let free = "046006820000015024";
    let on_pallet = "046006820000015017";
    let apart = "046006820000015000";
    let got = receipts_of(&admin, &floor.key, &[
        opened(1, PALLET_A, &product, &instant(400, 0)),
        added(2, PALLET_A, free, &instant(401, 0)),
        added(3, PALLET_A, on_pallet, &instant(402, 0)),
        added(4, PALLET_A, apart, &instant(403, 0)),
        event(5, "pallet_box_removed", json!({ "palletId": PALLET_A, "boxSscc": free, "removedAt": instant(404, 0) })),
        added(6, PALLET_A, free, &instant(405, 0)),
    ])
    .await;
    assert_eq!(
        got,
        vec![
            accepted(1),
            accepted(2),
            rejected(3, "box_on_pallet", Some(json!({ "palletSscc": "146006820000000409", "palletId": scenario_pallet(&scenario, 40) }))),
            rejected(4, "box_not_closed", None),
            accepted(5),
            accepted(6),
        ]
    );
}

/// The id the scenario gave the pallet of `serial`.
fn scenario_pallet(scenario: &Value, serial: u64) -> Value {
    scenario["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["kind"] == "pallet_closed" && record["data"]["serial"] == serial)
        .map(|record| record["data"]["palletId"].clone())
        .expect("the scenario closes that pallet")
}
```

SSCC `…15000`, `…15017`, `…15024` и паллета `…0409` в тесте — из `floor-scenario.json`; сверка:
`grep -o '"sscc": "[0-9]*"' apps/standalone/proto/fixtures/floor-scenario.json`.

- [ ] **Step 3: запустить, увидеть результат.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test handheld_floor_scenario`
  Expected: `test result: ok. 2 passed`. Если `box_on_pallet` приходит без `palletId`, исправляйте реализацию
  Х3 (`on_pallet`), а не ожидание: деталь нужна приложению.

- [ ] **Step 4: документы.**

  `apps/standalone/AGENTS.md`:

  - В конец раздела «Three identities» (после абзаца «…A device key alone never opens office routes.») добавьте:
    «The rule is enforced per route and per kind, not only by the office session: `host/src/device_kinds.rs`
    lists the kinds that may call each `/v1/device/*` and `/v1/changes*` route, `/v1/office/*` and `/v1/bootstrap`
    take a station or an office PC, and a route with no rule is `forbidden`. A handheld's key opens no office
    route even with an administrator's password (plan ТСД-Х).»
  - В раздел «Local pairing trust» добавьте абзац о перепривязке: «A code the office makes for one device
    (`POST /v1/office/devices/{id}/pairing-code`, stored in `pairing_codes.device_id`) re-pairs that device with
    its own `deviceId`: the claim names `recoverDeviceId`, the host gives the device a new key, ends the old key
    and the device's office sessions, takes no seat and writes `device.rekey`. A code for one device used without
    that id, or an ordinary code with one, is `pairing_code_invalid` and stays whole.»
  - В конец раздела «Protocol» (перед «Signed documents and trust keys») добавьте подраздел «Handhelds on the
    host»: протокол 6; возможность `handheld-host-v1` в `claim` и в `ShiftEnter.supports` (хост требует её у ТСД
    на каждом входе); ТСД читает смены своей линии (линию назначает офис), берёт блоки обоих расширений,
    шлёт факты и закрывает смену; складские паллеты — `POST /v1/device/pallet-events` (пять видов записей,
    квитанция на каждую, `device_event_receipts`, коды `box_not_found`, `box_not_closed`, `box_on_pallet`,
    `product_mismatch`, `pallet_not_open`, `pallet_count_mismatch`, `feature_disabled`), реестр коробов
    `GET /v1/device/box-registry` (`boxes.changed_at`, окно `since..until`, без кодов), `GET /v1/device/org/print`;
    удержание после восстановления касается и `pallet-events`; `tests/box_registry_touch.rs` знает каждого
    писателя в `boxes`.
  - `docs/standalone/ROADMAP.md`: в пункте про ТСД укажите три плана `2026-10-15-standalone-tsd-{host,protocol,android}.md`
    и что хост-часть (Х) исполнена; статус Android-частей оставьте прежним.
  - `tests/migration_beta3_upgrade.rs`: в шапке-комментарии к списку «Three later ones are new» допишите
    «`0035`–`0039` (plan ТСД-Х): warehouse pallets, device event receipts, the box registry's change time, a pairing
    code's device and the address mark»; сами проверки не меняются (`beta3()` перечисляет только применённые версии).

- [ ] **Step 5: полные гейты плана.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" fmt --check` — Expected: пусто.
  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" clippy -p markiro-host -p markiro-proto --all-targets -- -D warnings` — Expected: `Finished`, без предупреждений.
  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto -p markiro-host` — Expected: все `ok`.
  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — Expected: весь Vitest пакета `passed`.
  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` и `... lint` — Expected: без ошибок.
  Run: `pnpm --dir "$WT" exec prettier --check apps/standalone/src apps/standalone/test docs/superpowers/plans/2026-10-15-standalone-tsd-host.md` — Expected: `All matched files use Prettier code style!`.
  Run: `git -C "$WT" diff --check` — Expected: пусто.
  Run: `pnpm --dir "$WT" test:production-bundle:contract` — Expected: `ok` (критерий готовности шага 1, раздел 16 спецификации).

  Не проверено этим планом, отчёт называет это отдельно: Windows-служба и брандмауэр с реальным ТСД, TLS-совместимость
  с Android 9 на устройстве, поведение Wi-Fi и DHCP, печать на реальном принтере ТСД. Визуальная проверка двух офисных
  правок (`WarehousePalletsSection`, «Привязать заново») в браузере невозможна без оболочки Tauri; Vitest доказывает
  только DOM.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/tests/support/handheld.rs apps/standalone/host/tests/handheld_floor_scenario.rs apps/standalone/host/tests/migration_beta3_upgrade.rs apps/standalone/AGENTS.md docs/standalone/ROADMAP.md
git -C "$WT" commit -m "test(standalone): the floor scenario from a handheld key, and the handheld rules in AGENTS.md

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Отклонения при исполнении

Раздел заполняет исполнитель, не автор плана: для каждой задачи — что пришлось сделать иначе, коммиты и причина
(образец — «Отклонения при исполнении» в `2026-10-13-standalone-shift-modes.md`). Обязательно назвать: какие
существующие тесты изменены решением владельца (`only_a_station_reads_and_creates_shifts`,
`an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift`, все тесты вида `office` на закрытых
теперь маршрутах), какое поле реестра коробов пришлось добавить и какие номера миграций пришлось сдвинуть.

- **Х1.** Строки `ROUTE_KINDS` для смен (`GET /v1/device/shifts`, `POST .../{id}/enter`), `POST /v1/device/sscc/blocks`
  и `.../known` оставлены `Station`, а не `Station, Handheld`: обработчики ещё зовут `require_station`, и тест
  «допущенный вид не получает `forbidden`» был бы красным до Х2. Х2 снимает `require_station` и расширяет эти
  четыре строки в одном коммите.
- **Х1.** Строка `GET /v1/device/codes/{code_hash}` включает `Office` (`Station, Handheld, Office`): существующие тесты
  `codes.rs` сознательно проверяют, что офисный ПК читает проверку кода; закрывать чтение не нужно.
- **Х1.** Изменённые существующие тесты: `facts.rs::a_record_names_a_shift_the_device_entered_and_a_batch_holds_1_to_100`
  (офисный ПК на `POST /v1/device/facts` теперь `403 forbidden` вместо квитанции `not_entered`) и
  `cloud_import.rs::nobody_without_an_office_session_of_their_own_device_imports` (два случая ТСД теперь `403 forbidden`
  по виду вместо `401 session`). Остальные тесты хоста не менялись.
- **Х1.** Тест `a_handheld_key_is_refused_on_every_office_route_of_the_router` добавлен сверх плана: перебирает все
  офисные маршруты роутера (в том числе `host-network`) и требует `forbidden` для ключа ТСД.
- **Х1.** `concrete()` в тесте подставляет любые `{...}`-сегменты, а не только `{id}`/`{code_hash}`.
- **Х2.** Четыре строки `ROUTE_KINDS` (`GET /v1/device/shifts`, `POST .../{id}/enter`, `POST /v1/device/sscc/blocks`,
  `.../known`) расширены до `Station, Handheld` в одном коммите со снятием `require_station` в обработчиках; создание
  смены (`POST /v1/device/shifts`) и `PUT /v1/device/line` остаются станционными (`require_station` в
  `create_device_shift` сохранён).
- **Х2.** Изменённые существующие тесты (решение владельца, утверждение заменено, не ослаблено):
  `device_shifts.rs::only_a_station_reads_and_creates_shifts` (ТСД читает список — пустой без линии, смену не создаёт),
  `device_shifts.rs::an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift` (ТСД без линии — `shift_line`);
  сверх плана — `sscc_blocks.rs::only_a_station_asks_whatever_the_body_says` и
  `sscc_blocks.rs::a_pallet_block_is_for_a_current_station_and_a_known_pallet_counter`: ТСД убран из перечня отказов
  (офисный ПК и подмена вида в транзакции проверяются по-прежнему), добавлено, что ТСД проходит проверку вида и
  упирается в тело (не `forbidden`).
- **Х3.** Тест миграции из плана вставлял `box_sscc = 's'`, что нарушает `CHECK (length(box_sscc) = 18)`: в тесте
  подставлен 18-значный SSCC. Тест ошибки БД (`only_a_handheld_sends_pallet_events_…`) в плане не создавал короб, и
  `added` получал `box_not_found` (200) вместо 500: добавлен `closed_boxes` до `DROP TABLE`. В `migration_handheld_host.rs`
  «0035-0037» исправлено на «0035-0036».
- **Х3.** Сверх плана добавлены тесты изоляции и мутаций: `one_device_never_touches_another_devices_pallet_or_receipts`
  (чужая паллета — `pallet_unknown`, открытие паллеты с чужим id — `invalid_record data.palletId`, квитанции и
  идемпотентность по паре `(device, id)`) и `a_box_block_does_not_close_a_pallet` (блок расширения 0 с серийником внутри
  диапазона не закрывает паллету: `sscc_not_issued`).
- **Х3.** В базе уже есть миграция `0045_host_address.sql` (поток П4): версии 35–36 свободны, пробел 37–44 sqlx не мешает.
- **Х4.** Окно реестра закрыто с обоих концов (`since <= changed_at <= until`, как в плане), поэтому тесты плана с замороженными часами
  теряли различие «до/после»: перед первым обходом в тестах добавлен `clock.advance(5 с)` (и перед обходом после добавления короба
  на паллету, иначе мутант «нет `warehouse_pallet_boxes` при закрытии» выживал). Утверждения не ослаблены.
- **Х4.** Изменён существующий `no_secrets_in_logs.rs`: число файлов `facts/` 19 → 20 (новый `facts/registry_touch.rs`, он не логирует).
- **Х4.** Сверх плана: `tests/box_registry_sites.rs` (по тесту на каждый вызов `registry_touch`: закрытие короба, закрытие и
  расформирование производственной паллеты, дезагрегация короба и паллеты офисом, снятие короба со складской паллеты) и тест
  `a_walk_keeps_its_window_while_boxes_change_and_lists_by_change_time` (окно обхода, порядок по времени изменения, курсор без `until`).
  Мутанты (20, скрипт перебора) все убиты: границы окна, курсор `>=`/только время, сортировка, полная выгрузка без `remove`, `restoreEpoch`,
  `limit+1`, каждый вызов `registry_touch` и мёртвые `box_by_id`/`box_by_sscc`.
- **Х4.** `GET /v1/device/box-registry` не включён в `held_by_a_restore`: это чтение, после восстановления меняется `restoreEpoch`
  (ТСД обходит заново), а повторно присланные станцией факты получают новое `changed_at` и попадают в следующее окно.
- **Х4.** `cargo clippy -D warnings` на хосте не доходит до цели: падает на `markiro-proto` (старые замечания `map_or`/`large_enum_variant`
  нового тулчейна 1.93, не из этой задачи); замечаний в тронутых файлах хоста нет.
- **Х5.** `scrollLabel` таблицы складских паллет в плане совпадал с именем секции («Складские паллеты»): `findByRole("region")` находил два региона. Подпись таблицы — «Список складских паллет». Тест веб-части открывает `/codes/pallets` (в плане `chooseTab`) и ждёт таблицу внутри секции.
- **Х5.** `orgPrintSchema` в `src/host/protocol.ts` не добавлялся и не нужен: приложение читает `org/print` на Kotlin, офису этот маршрут не нужен; `officeWarehousePalletsSchema` уже был (П2), `HostApi.listWarehousePallets` берёт её. Существующие тесты не менялись; `cargo clippy -D warnings` по-прежнему красный только на `markiro-proto` (до хоста не доходит).
- **Х6.** `ClaimRequest.recover_device_id` и литерал `src-tauri/src/device.rs` (`recover_device_id: None`) уже были с П1: правок в `proto` и оболочке не потребовалось. Миграция `0038` встала как есть (в базе есть и `0045_host_address.sql`, пробел 38–44 sqlx не мешает).
- **Х6.** Тест плана `a_code_works_only_for_its_own_device…` выбирал код `ORDER BY created_at DESC LIMIT 1`: часы в тесте заморожены, `created_at` кода `pair_handheld` совпадает, и строка выходила другая. Заменено на `WHERE device_id IS NOT NULL`. Сверх плана: тест «полный пул мест + истёкший код» (перепривязка не занимает места при `stations = 1`, истёкший код ничего не меняет и не пишет `device.rekey`), тест `recoverDeviceId` не UUID (`validation_failed`, старый ключ жив), проверка внешнего ключа `pairing_codes.device_id` в тесте миграции; веб: диалог остаётся открытым при устройстве «позже кода» и ошибка хоста.
- **Х6.** Мутанты (19, скрипт перебора, критерий — код возврата cargo): все убиты, кроме эквивалентного: удаление раннего `require_admin()` в `create_device_code` (тот же отказ даёт `require_admin_in` в транзакции). Веб-мутанты: `joined` для перепривязки, кнопка для офисного ПК, повтор запроса для того же устройства убиты; `replaces: shown` при заданном устройстве эквивалентен (мутация на устройство не смотрит на `replaces`).
- **Х6.** Открытое: «Новый код» в диалоге перепривязки не гасит прежний живой код того же устройства (хост для кода устройства `replaces` не принимает, как в плане); старый код живёт до истечения (10 минут) и привязан к тому же устройству и администратору.
