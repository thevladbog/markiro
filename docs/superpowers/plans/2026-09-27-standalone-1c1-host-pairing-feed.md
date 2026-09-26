# План 1c1: API хоста для второго устройства — коды подключения, выбор линии, лента изменений и SSE — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** хост подключает устройства в локальной сети по одноразовому коду, даёт станции выбрать линию, отдаёт справочники лентой изменений порциями и сообщает о каждой новой ревизии через SSE; журнал действий пишется по единому словарю.

**Architecture:** новые маршруты axum на существующем каркасе хоста (`AppState`, `AuthDevice`, `OfficeContext`, `begin_write`, `audit`). Коды подключения хранятся хешами SHA-256 в таблице `pairing_codes`; адреса хоста в локальной сети для машиночитаемого кода перечисляет крейт `if-addrs`. Лента изменений — объединение строк справочников и `tombstones` по ревизии, без разрыва ревизии между порциями; SSE строится на `tokio::sync::watch`, который писатели будят только после коммита (`db::commit_with_revision`).

**Tech Stack:** Rust (axum 0.8.9 с SSE, sqlx 0.8.6 SQLite, tokio 1.53.1, if-addrs 0.15.0, futures-util 0.3.34), serde; TypeScript (zod 4.4.3, Vitest) только для схем протокола и текстов ошибок.

**Спецификации:** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.3 — схема, §4.4 — ревизии и лента, §4.5 — протокол, §4.7 — подключение устройств, §4.9 — журнал, §4.10 — ограничение частоты; этот план — хостовая часть строки 1c раздела 8). Приложение (команда `host_claim`, локальная база, поток событий) — план 1c2, экраны — план 1c3. Отложенные пункты из планов 1b1–1b3 — ledger `.superpowers/sdd/progress.md`.

## Global Constraints

- Новые зависимости хоста — только `if-addrs = "=0.15.0"` (адреса хоста в локальной сети для машиночитаемого кода; его зависимости `libc 0.2` и `windows-sys 0.61.2` уже есть в `apps/standalone/Cargo.lock`) и `futures-util = "=0.3.34"` (уже в `Cargo.lock`; поток SSE через `stream::unfold`). Других крейтов не добавлять.
- Код подключения: 10 символов Crockford base32 (алфавит `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), живёт 10 минут; хост хранит SHA-256 нормализованного кода (`secrets::key_hash`), отмечает использование; код недействителен после 5 неудачных попыток; каждая неудачная попытка с неизвестным кодом засчитывается всем живым (не использованным и не истёкшим) кодам. Нормализация: верхний регистр, без пробелов и дефисов, `O → 0`, `I` и `L → 1`.
- Машиночитаемый код: `markiro-host:1?h=<адрес1,адрес2>&p=<порт>&f=<отпечаток>&c=<код>` — все IPv4-адреса хоста в состоянии «работает», кроме loopback, link-local (169.254/16) и 0.0.0.0, по возрастанию без повторов; отпечаток — 64 hex-символа в нижнем регистре.
- `POST /v1/pairing/claim`: без ключа устройства и не только с loopback; не больше 10 попыток в минуту с одного адреса (отдельный ограничитель); ответ — `PairResponse`. Отказ ограничителя частоты (`rate_limited`) не пишет строку журнала — ни у входа, ни у смены пароля, ни у `claim`.
- Коды ошибок: новые `pairing_code_invalid` и `pairing_code_expired` (HTTP 400) — в `markiro_proto::codes`, в списке `API_ERROR_CODES` вебвью и в `ru.json`; общий файл `proto/fixtures/error-codes.json` сверяется с обеих сторон.
- Выбор линии: `PUT /v1/device/line` с `{ lineId }` — только устройство вида `station`, только существующая неархивная линия; пишет строку журнала `device.line`, ревизию не меняет (устройства в ленту не входят).
- Лента: `GET /v1/changes?since=<ревизия ≥ 0>&limit=<1..1000, по умолчанию 500>` → `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data? }] }`; сущности `org_profile` (id `"1"`), `site` (id `"1"`, только после инициализации; `data`: `badgeSalt` — стандартный base64 с выравниванием, `boxBlockSize`, `palletBlockSize`), `lines`; удалённые записи — из `tombstones` с `deleted: true` без `data`; порядок `(rev, entity, id)`; порция никогда не разрывает ревизию; при `hasMore = false` поле `rev` — текущая ревизия хоста.
- Поток: `GET /v1/changes/stream` (ключ устройства) — `text/event-stream`: первым событие `rev` с текущей ревизией, затем событие `rev` после каждого коммита, поднявшего ревизию (`data: {"rev":N}`); комментарий-пульс каждые 15 с; открытые потоки заканчиваются, когда хост останавливается.
- Каждая транзакция, поднявшая ревизию (`next_revision`), коммитится через `db::commit_with_revision`: сначала коммит, потом оповещение подписчиков.
- Журнал действий: имя действия — только из `audit::actions`; у каждой строки с результатом `denied` есть `details.reason` из `audit::reasons`; строки изменений — `details.changed` (имена полей) плюс `{ from, to }` для каждого изменённого поля; в `details` никогда нет кода подключения, ключа, токена, пароля, соли и хешей. Смену своего пароля и установку пароля администратором пишет одно действие `office_user.password` (свою смену отличает `actor_id == target_id`).
- Протокол: любое изменение формы — одновременно `proto`, схемы Zod в `src/host/protocol.ts` и фикстуры `proto/fixtures`; Rust разбирает каждую фикстуру, Vitest — каждую, чья форма пересекает IPC. Запросы — `deny_unknown_fields`, ответы неизвестные поля пропускают.
- Правила записей из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на транзакцию, пул не трогать при открытой транзакции записи, PBKDF2 до `begin_write`, пустые изменения ничего не пишут, админские записи перепроверяют права внутри транзакции (`require_admin_in`).
- `apps/station` не меняется. Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

- Перед каждым коммитом: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` и `… --all -- --check`; для TS/JSON/MD — `node_modules/.bin/prettier --write <файлы>` и `--check`; `git diff --check`.
- Cargo — с `--offline`; крейт `if-addrs 0.15.0` уже скачан в `~/.cargo/registry`. Если cargo всё же просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы. Тесты, которые слушают 127.0.0.1 (`host/tests/hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, новый `changes_stream.rs`, `src-tauri/tests/*.rs`), запускайте вне песочницы. Остальные тесты хоста (`bootstrap.rs`, `office_*.rs`, `pairing.rs` и новые) работают в процессе и слушать порт не требуют.
- Крейт `markiro-standalone` встраивает `apps/standalone/dist`: для `cargo test --workspace` каталог должен существовать (`pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`).
- pnpm в песочнице — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать.
- Не использовать `git stash`; не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.
- Тесты хоста сверяют строку журнала целиком: `actor_kind`, `actor_id`, `action`, `target_type`, `target_id`, `result` и разобранный JSON `details` (корневой и локальный `AGENTS.md`).

## Файлы

Задачи выполняются по порядку.

```
apps/standalone/host/src/audit.rs, host/src/routes/{bootstrap,office_auth,office_users,org,sscc,pairing}.rs, host/src/lib.rs   задача 1
apps/standalone/host/tests/{bootstrap,office_admin,office_auth,pairing}.rs                                  задача 1
apps/standalone/host/Cargo.toml, Cargo.lock, host/migrations/0005_pairing_codes.sql                         задача 2
apps/standalone/host/src/{pairing_code,network}.rs, host/src/server.rs, host/tests/support/app.rs          задача 2
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs, proto/fixtures/*.json                           задачи 2–5
apps/standalone/src/host/protocol.ts, src/host/errors.ts, src/i18n/ru.json, test/{protocol,errors}.test.ts  задачи 2–5
apps/standalone/host/src/{validate,error}.rs, host/tests/{pairing_codes,claim}.rs, host/tests/no_secrets_in_logs.rs   задачи 2–3
apps/standalone/host/tests/device_line.rs                                                                   задача 4
apps/standalone/host/migrations/0006_change_feed.sql, host/src/routes/changes.rs, host/tests/changes.rs    задача 5
apps/standalone/host/src/db.rs, host/tests/changes_stream.rs                                               задача 6
apps/standalone/AGENTS.md, спецификация §2, §4.5, §4.7                                                     задачи 1–3, 5–6
```

---

### Task 1: Единый словарь журнала действий

До новых писателей (коды подключения, `claim`, выбор линии) журнал приводится к одному словарю. Отложенное из плана 1b1 (ledger, «Deferred — 1c»):

- имена действий — константы;
- у каждого отказа — причина: неизвестный логин пишется без введённого текста, изменение во время хеширования — отдельной причиной;
- у строк изменений — `{ from, to }`;
- стартовые номера SSCC попадают в строку мастера;
- «пустышка» PBKDF2 для неизвестного логина строится при старте хоста;
- два тестовых пробела: граница бездействия ровно 30:00 и отказ локального подключения без строки журнала.

**Files:**

- Modify: `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/lib.rs`
- Modify в `apps/standalone/host/src/routes/`: `bootstrap.rs`, `office_auth.rs`, `office_users.rs`, `org.rs`, `sscc.rs`, `pairing.rs`
- Test в `apps/standalone/host/tests/`: `bootstrap.rs`, `office_admin.rs`, `office_auth.rs`, `pairing.rs`
- Modify: `apps/standalone/AGENTS.md` (раздел «Audit»)

**Interfaces:**

- Consumes: `audit::{record, Entry, Actor, Outcome}` (`host/src/audit.rs`), `secrets::dummy_password_phc()`.
- Produces (`host/src/audit.rs`):
  - модуль `actions` с константами `HOST_BOOTSTRAP`, `DEVICE_LOCAL_PAIR`, `OFFICE_LOGIN`, `OFFICE_LOGOUT`, `OFFICE_USER_CREATE`, `OFFICE_USER_UPDATE`, `OFFICE_USER_PASSWORD`, `ORG_UPDATE`, `SSCC_COUNTER_UPDATE`, `SSCC_BLOCK_SIZES_UPDATE`;
  - модуль `reasons` с константами `INVALID_LOGIN`, `UNKNOWN_LOGIN`, `WRONG_PASSWORD`, `INACTIVE`, `CHANGED`, `WRONG_CURRENT_PASSWORD`;
  - функция `pub fn update_details(fields: &[(&str, Value, Value)]) -> Option<Value>` — `None`, если ни одно поле не изменилось.
    Задачи 2–4 дописывают в эти модули свои имена.

- [ ] **Step 1: Модульный тест `update_details`**

В конец `apps/standalone/host/src/audit.rs` добавить:

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::update_details;

    #[test]
    fn update_details_lists_changed_fields_with_their_values() {
        let details = update_details(&[
            ("name", json!("Старое"), json!("Новое")),
            ("role", json!("admin"), json!("admin")),
            ("active", json!(true), json!(false)),
        ]);
        assert_eq!(
            details,
            Some(json!({
                "changed": ["name", "active"],
                "name": { "from": "Старое", "to": "Новое" },
                "active": { "from": true, "to": false },
            }))
        );
    }

    #[test]
    fn update_details_is_none_when_nothing_changed() {
        assert_eq!(update_details(&[("name", json!("Та же"), json!("Та же"))]), None);
    }
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib audit --offline`
Expected: ошибка компиляции — `update_details` не найден.

- [ ] **Step 2: Словарь в `audit.rs`**

В `apps/standalone/host/src/audit.rs` после `use sqlx::SqliteConnection;` добавить:

```rust
/// Action names of `audit_log.action`. A new writer adds its name here, so
/// the audit screen (plan 5) translates one list.
pub mod actions {
    pub const HOST_BOOTSTRAP: &str = "host.bootstrap";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
    pub const OFFICE_USER_CREATE: &str = "office_user.create";
    pub const OFFICE_USER_UPDATE: &str = "office_user.update";
    /// An administrator set someone's password, or a user changed their own
    /// (then `actor_id == target_id`).
    pub const OFFICE_USER_PASSWORD: &str = "office_user.password";
    pub const ORG_UPDATE: &str = "org.update";
    pub const SSCC_COUNTER_UPDATE: &str = "sscc.counter.update";
    pub const SSCC_BLOCK_SIZES_UPDATE: &str = "sscc.block_sizes.update";
}

/// `details.reason` of a denied row: every denial names one.
pub mod reasons {
    /// The typed login is not a valid login at all; its text is not recorded.
    pub const INVALID_LOGIN: &str = "invalid_login";
    /// No such login; its text is not recorded either.
    pub const UNKNOWN_LOGIN: &str = "unknown_login";
    pub const WRONG_PASSWORD: &str = "wrong_password";
    pub const INACTIVE: &str = "inactive";
    /// The record changed while the password was being hashed.
    pub const CHANGED: &str = "changed";
    pub const WRONG_CURRENT_PASSWORD: &str = "wrong_current_password";
}

/// `details` of an update row: `changed` names the changed fields in order,
/// and each of them also appears as `{ "from": …, "to": … }`. `None` when
/// nothing changed, so the caller can return the record as-is.
pub fn update_details(fields: &[(&str, Value, Value)]) -> Option<Value> {
    let mut details = serde_json::Map::new();
    let mut changed = Vec::new();
    for (name, from, to) in fields {
        if from != to {
            changed.push(Value::String((*name).to_owned()));
            details.insert(
                (*name).to_owned(),
                serde_json::json!({ "from": from, "to": to }),
            );
        }
    }
    if changed.is_empty() {
        return None;
    }
    details.insert("changed".to_owned(), Value::Array(changed));
    Some(Value::Object(details))
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib audit --offline`
Expected: PASS (2 теста).

- [ ] **Step 3: Тесты хоста — на новый словарь (сначала красные)**

1. `apps/standalone/host/tests/office_auth.rs`, тест `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`:
   - в первой проверке `last_audit` заменить `json!({ "login": "irina" })` на `json!({ "reason": "wrong_password" })`;
   - во второй проверке заменить `json!({ "login": "nobody" })` на `json!({ "reason": "unknown_login" })`;
   - после последней проверки (неактивный пользователь) добавить:

```rust
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id.clone()),
            "office.login".into(),
            Some("office_user".into()),
            Some(user_id.clone()),
            "denied".into(),
            json!({ "reason": "inactive" })
        )
    );
```

Если `device_id` к этому месту уже перемещён (во второй проверке стоит `Some(device_id)`), замените там `Some(device_id)` на `Some(device_id.clone())`.

2. Там же добавить тест границы бездействия:

```rust
#[tokio::test]
async fn a_session_ends_exactly_30_idle_minutes_after_its_last_activity() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    app.clock
        .advance(time::Duration::minutes(30) - time::Duration::seconds(1));
    let (status, _) = app
        .send(empty(with_session(request("GET", "/v1/office/me"), &key, &token)))
        .await;
    assert_eq!(status, StatusCode::OK, "29:59 of idleness still keeps the session");

    // That request was activity: the idle limit now counts from it.
    app.clock.advance(time::Duration::minutes(30));
    let (status, body) = app
        .send(empty(with_session(request("GET", "/v1/office/me"), &key, &token)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "session");
}
```

(помощники `pair_device`, `seed_office_user`, `login`, `empty`, `with_session`, `request` уже импортированы в файл; если чего-то нет в `use support::app::{…}`, добавьте).

3. `apps/standalone/host/tests/pairing.rs` — добавить тест:

```rust
#[tokio::test]
async fn refused_local_pairing_writes_no_audit_row() {
    let app = TestApp::new().await;
    let (status, _) = app
        .send_from(
            LAN,
            json_request(
                request("POST", "/v1/local-pair"),
                json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .send(json_request(
            request("POST", "/v1/local-pair"),
            json!({ "kind": "handheld", "name": "ТСД", "appVersion": "0.1.0" }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(audit_rows(&app).await.is_empty());
}
```

4. `apps/standalone/host/tests/bootstrap.rs`:
   - в проверке строки `host.bootstrap` ожидание `json!({ "adminLogin": "admin", "orgName": "ООО «Атолл»", "issuerPrefix": "460068200", "lineCount": 2 })` дополнить стартовыми номерами:

```rust
json!({
    "adminLogin": "admin",
    "orgName": "ООО «Атолл»",
    "issuerPrefix": "460068200",
    "lineCount": 2,
    "boxNextSerial": 1500,
    "palletNextSerial": 40
})
```

- в тесте `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions` ожидание `json!({ "changed": ["name", "inn", "gln", "gs1Prefixes", "timeZone"] })` заменить на:

```rust
json!({
    "changed": ["name", "inn", "gln", "gs1Prefixes", "timeZone"],
    "name": { "from": "ООО «Атолл»", "to": "ООО «Атолл-Юг»" },
    "inn": { "from": "7701234567", "to": null },
    "gln": { "from": "4600682000010", "to": "4607091000017" },
    "gs1Prefixes": { "from": ["4600682"], "to": ["4600682", "4607091"] },
    "timeZone": { "from": "Europe/Moscow", "to": "Europe/Samara" }
})
```

5. `apps/standalone/host/tests/office_admin.rs`, ожидания `assert_audit`:
   - `sscc.counter.update`: `json!({ "from": 1500, "to": 2000 })` → `json!({ "changed": ["nextSerial"], "nextSerial": { "from": 1500, "to": 2000 } })`;
   - `sscc.block_sizes.update`: `json!({ "boxBlockSize": 5000, "palletBlockSize": 500 })` → `json!({ "changed": ["boxBlockSize", "palletBlockSize"], "boxBlockSize": { "from": 2000, "to": 5000 }, "palletBlockSize": { "from": 200, "to": 500 } })`;
   - `office_user.update` при повышении технолога: `json!({ "changed": ["role"] })` → `json!({ "changed": ["role"], "role": { "from": "technologist", "to": "admin" } })`.

   Остальные ожидания `office_user.update` в файле (если есть) переведите по тому же правилу: к списку `changed` добавляются `{ "from", "to" }` каждого изменённого поля. Значения берите из самого теста: исходные — из данных, которые тест создал, новые — из тела запроса. `active` записывается булевым значением, `role` — строкой.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --test pairing --test bootstrap --test office_admin --offline`
Expected: FAIL — новые ожидания `reason`, `from`/`to` и стартовые номера не совпадают. Тест `refused_local_pairing_writes_no_audit_row` и тест границы бездействия могут пройти сразу: они закрепляют уже существующее поведение.

- [ ] **Step 4: Писатели — на словарь**

1. `apps/standalone/host/src/routes/bootstrap.rs`:
   - в `use crate::audit::{…}` добавить `actions`;
   - `action: "host.bootstrap"` → `action: actions::HOST_BOOTSTRAP`;
   - в `details` строки мастера после `"lineCount": lines.len(),` добавить:

```rust
                "boxNextSerial": request.sscc.box_next_serial,
                "palletNextSerial": request.sscc.pallet_next_serial,
```

2. `apps/standalone/host/src/routes/pairing.rs`: в импорт `audit` добавить `actions`; `action: "device.local_pair"` → `action: actions::DEVICE_LOCAL_PAIR`.

3. `apps/standalone/host/src/routes/office_auth.rs`:
   - импорт `use crate::audit::{self, Actor, Entry, Outcome};` → `use crate::audit::{self, actions, reasons, Actor, Entry, Outcome};`;
   - в `login`:
     - в ветке неверного формата логина `action: "office.login"` → `actions::OFFICE_LOGIN`, `json!({ "reason": "invalid_login" })` → `json!({ "reason": reasons::INVALID_LOGIN })`;
     - весь хвост функции от строки `let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;`, которая идёт после вычисления `password_ok`, до конца функции заменить на:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // Re-read the user inside the write transaction: a password change or
    // deactivation committed while PBKDF2 was running (outside any
    // transaction) must not let this request open a session on a value that
    // no longer holds.
    let current: Option<(String, i64)> = match row.as_ref() {
        Some((id, ..)) if password_ok => {
            sqlx::query_as("SELECT password_phc, active FROM office_users WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?
        }
        _ => None,
    };
    // Why the sign-in is refused, if it is. The typed login is never recorded:
    // it could be a password typed into the wrong field.
    let refusal = match (row.as_ref(), stored_phc.as_ref(), current.as_ref()) {
        (None, ..) => Some(reasons::UNKNOWN_LOGIN),
        (Some(_), ..) if !password_ok => Some(reasons::WRONG_PASSWORD),
        (Some(_), _, Some((_, active))) if *active == 0 => Some(reasons::INACTIVE),
        (Some(_), Some(verified_phc), Some((current_phc, _))) if current_phc == verified_phc => {
            None
        }
        (Some(_), ..) => Some(reasons::CHANGED),
    };
    match (row, refusal) {
        (Some((id, login, name, role, _, _)), None) => {
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
                    action: actions::OFFICE_LOGIN,
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
                token: token.into(),
                user: OfficeUser {
                    id,
                    login,
                    name,
                    role,
                },
                expires_at: format_timestamp(expires),
            }))
        }
        (row, refusal) => {
            // `(None, None)` cannot happen: no row always refuses.
            let reason = refusal.unwrap_or(reasons::UNKNOWN_LOGIN);
            let target = row.as_ref().map(|row| row.0.as_str());
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: actions::OFFICE_LOGIN,
                    target_type: Some("office_user"),
                    target_id: target,
                    outcome: Outcome::Denied,
                    details: json!({ "reason": reason }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Err(ApiError::unauthorized(
                credentials::PASSWORD,
                "wrong login or password",
            ))
        }
    }
}
```

- в `logout`: `action: "office.logout"` → `actions::OFFICE_LOGOUT`;
- в `change_password` блок `let Some(new_phc) = new_phc.filter(|_| current == stored) else { … };` заменить на:

```rust
    let new_phc = match new_phc {
        Some(phc) if current == stored => phc,
        verified => {
            // A right current password against a hash an administrator
            // replaced meanwhile is "changed", not "wrong".
            let reason = if verified.is_some() {
                reasons::CHANGED
            } else {
                reasons::WRONG_CURRENT_PASSWORD
            };
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: context.actor(),
                    action: actions::OFFICE_USER_PASSWORD,
                    target_type: Some("office_user"),
                    target_id: Some(&context.user.id),
                    outcome: Outcome::Denied,
                    details: json!({ "reason": reason }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            return Err(ApiError::unauthorized(
                credentials::PASSWORD,
                "the current password is wrong",
            ));
        }
    };
```

4. `apps/standalone/host/src/routes/office_users.rs`:
   - в импорт `audit` добавить `actions`;
   - в `replace_password`: `action: "office_user.password"` → `actions::OFFICE_USER_PASSWORD`;
   - в `create_user`: `action: "office_user.create"` → `actions::OFFICE_USER_CREATE`;
   - в `update_user` блок от `let mut changed = Vec::new();` до `return Ok(Json(current)); }` включительно (сравнение трёх полей и возврат без изменений) заменить на:

```rust
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("role", json!(current.role.as_str()), json!(update.role.as_str())),
        ("active", json!(current.active), json!(update.active)),
    ]) else {
        // Nothing actually changed: report the record as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
```

     а в строке журнала этого обработчика `action: "office_user.update"` → `actions::OFFICE_USER_UPDATE`, `details: json!({ "changed": changed })` → `details`.

5. `apps/standalone/host/src/routes/org.rs`:

- в импорт `audit` добавить `actions`;
- блок от `let mut changed = Vec::new();` до `return Ok(Json(current)); }` включительно заменить на:

```rust
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(org.name)),
        ("inn", json!(current.inn), json!(org.inn)),
        ("gln", json!(current.gln), json!(org.gln)),
        ("gs1Prefixes", json!(current.gs1_prefixes), json!(org.gs1_prefixes)),
        ("timeZone", json!(current.time_zone), json!(org.time_zone)),
    ]) else {
        // Nothing actually changed: report the profile as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
```

     а в строке журнала `action: "org.update"` → `actions::ORG_UPDATE`, `details: json!({ "changed": changed })` → `details`.

6. `apps/standalone/host/src/routes/sscc.rs`:

- в импорт `audit` добавить `actions`;
- в `put_counter` строку журнала: `action: "sscc.counter.update"` → `actions::SSCC_COUNTER_UPDATE`, а `details: json!({ "from": current, "to": update.next_serial })` →

```rust
            details: json!({
                "changed": ["nextSerial"],
                "nextSerial": { "from": current, "to": update.next_serial },
            }),
```

     (сдвиг счётчика — всегда одно изменённое поле: случай «без изменений» функция возвращает раньше);

- в `put_block_sizes`: `action: "sscc.block_sizes.update"` → `actions::SSCC_BLOCK_SIZES_UPDATE`, а `details` →

```rust
            details: audit::update_details(&[
                ("boxBlockSize", json!(current_box), json!(update.box_block_size)),
                ("palletBlockSize", json!(current_pallet), json!(update.pallet_block_size)),
            ])
            .unwrap_or_else(|| json!({ "changed": [] })),
```

     (случай «без изменений» функция возвращает раньше, так что запасная ветка недостижима, но без `expect`).

7. `apps/standalone/host/src/lib.rs`, в `start` сразу после `let pool = db::open(&paths.database_file()).await?;`:

```rust
    // Build the unknown-login verifier now, off the async threads, so the
    // first unknown login does not pay for building it.
    tokio::task::spawn_blocking(|| {
        secrets::dummy_password_phc();
    });
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (вне песочницы — среди них есть тесты, которые слушают 127.0.0.1)
Expected: PASS все тесты хоста.

`grep -rn 'action: "' apps/standalone/host/src` — пусто: все имена действий — из `audit::actions`.

- [ ] **Step 5: Правило журнала в `AGENTS.md`**

В `apps/standalone/AGENTS.md` раздел «Audit» заменить целиком:

```markdown
## Audit

Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Action names come only from `audit::actions`; a new writer
adds its name there. Every `denied` row carries `details.reason` from
`audit::reasons`. An update row carries `details.changed` (field names) and
`{ from, to }` for each changed field (`audit::update_details`). Details never
hold pairing codes, keys, tokens, passwords, salts or hashes, and a refused
login never records the typed login. An attempt refused by a rate limiter
writes no row, so a flood cannot fill the log. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
target_id`). Tests assert the exact actor, action, target, result and parsed
details.
```

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`, `git diff --check`.

```bash
git add apps/standalone/host/src/audit.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/src/routes/office_auth.rs apps/standalone/host/src/routes/office_users.rs apps/standalone/host/src/routes/org.rs apps/standalone/host/src/routes/sscc.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/tests/bootstrap.rs apps/standalone/host/tests/office_admin.rs apps/standalone/host/tests/office_auth.rs apps/standalone/host/tests/pairing.rs apps/standalone/AGENTS.md
git commit -m "refactor(standalone): единый словарь журнала действий хоста" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Коды подключения

Администратор получает одноразовый код для второго устройства: 10 символов Crockford base32 и машиночитаемую строку `markiro-host:1?h=…&p=…&f=…&c=…`, которую офис нарисует DataMatrix-кодом (план 1c3). Хост хранит только SHA-256 кода. Адреса хоста в локальной сети перечисляет крейт `if-addrs`: стандартная библиотека Rust сетевые интерфейсы перечислять не умеет, а приём с `UdpSocket::connect` находит только интерфейс маршрута по умолчанию — в изолированной заводской сети без шлюза его может не быть вовсе.

**Files:**

- Modify: `apps/standalone/host/Cargo.toml`, `apps/standalone/Cargo.lock`
- Create: `apps/standalone/host/migrations/0005_pairing_codes.sql`
- Create: `apps/standalone/host/src/pairing_code.rs`, `apps/standalone/host/src/network.rs`
- Modify: `apps/standalone/host/src/{lib,server,audit}.rs`, `apps/standalone/host/src/routes/pairing.rs`
- Modify: `apps/standalone/host/tests/support/app.rs`; Create: `apps/standalone/host/tests/pairing_codes.rs`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`; Create: `apps/standalone/proto/fixtures/pairing-code.json`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/test/protocol.test.ts`
- Modify: спецификация §2 (решение 3)

**Interfaces:**

- Consumes: `OfficeContext::{require_admin, require_admin_in, actor}`, `secrets::key_hash`, `audit::{record, actions}`, `clock::format_timestamp`.
- Produces:
  - `pairing_code::{generate() -> String, normalize(&str) -> Option<String>, payload(&[Ipv4Addr], u16, &str, &str) -> String, CODE_LENGTH, CODE_LIFETIME, MAX_FAILED_ATTEMPTS}`;
  - `network::{lan_ipv4_addresses() -> Vec<Ipv4Addr>, usable(impl IntoIterator<Item = (Ipv4Addr, bool)>) -> Vec<Ipv4Addr>}`;
  - `server::Endpoint { fingerprint: String, port: u16, addresses: Arc<dyn Fn() -> Vec<Ipv4Addr> + Send + Sync> }` и поле `AppState.endpoint` со строителями `AppState::with_endpoint(fingerprint, port)` и `AppState::with_addresses(f)`;
  - маршрут `POST /v1/office/pairing-codes` → `markiro_proto::PairingCode { code: Secret, expires_at: String, payload: Secret }`;
  - действие журнала `audit::actions::PAIRING_CODE_CREATE = "pairing_code.create"`;
  - таблица `pairing_codes`;
  - в тестах `support::app::{test_fingerprint(), TEST_ADDRESSES}` — `TestApp` по умолчанию отвечает этим отпечатком, портом 45710 и адресами `10.0.0.5`, `192.168.1.10`;
  - схема Zod `pairingCodeSchema`.

- [ ] **Step 1: Зависимость `if-addrs`**

В `apps/standalone/host/Cargo.toml` в `[dependencies]` после строки `base64 = "=0.22.1"` добавить:

```toml
if-addrs = "=0.15.0"
```

Run (вне песочницы, если cargo попросит распаковать крейт): `cargo tree --manifest-path apps/standalone/Cargo.toml -p markiro-host -i if-addrs --offline`
Expected: `if-addrs v0.15.0` в дереве `markiro-host`. В `git diff apps/standalone/Cargo.lock` появилась одна новая запись `if-addrs 0.15.0`, других новых пакетов нет (`libc` и `windows-sys 0.61.2` там уже были). Если cargo тянет что-то ещё, остановитесь и опишите это в отчёте.

- [ ] **Step 2: Модульные тесты кода и адресов (падающие)**

Create `apps/standalone/host/src/pairing_code.rs`:

```rust
//! One-time pairing codes (spec §4.7): 10 Crockford base32 characters, and the
//! machine-readable payload the office shows as a DataMatrix code.

use std::net::Ipv4Addr;

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::{generate, normalize, payload, ALPHABET, CODE_LENGTH};

    #[test]
    fn a_code_is_ten_crockford_characters() {
        for _ in 0..100 {
            let code = generate();
            assert_eq!(code.len(), CODE_LENGTH);
            assert!(code.bytes().all(|byte| ALPHABET.contains(&byte)), "{code}");
        }
        assert_ne!(generate(), generate());
    }

    #[test]
    fn a_typed_code_is_normalized_like_crockford_decoding() {
        assert_eq!(normalize("7K3MQ9XV2D").as_deref(), Some("7K3MQ9XV2D"));
        assert_eq!(normalize(" 7k3mq-9xv2d ").as_deref(), Some("7K3MQ9XV2D"));
        // O is read as zero, I and L as one.
        assert_eq!(normalize("OIL0000000").as_deref(), Some("0110000000"));
        assert_eq!(normalize("7K3MQ9XV2U"), None, "U is not a Crockford symbol");
        assert_eq!(normalize("7K3MQ9XV2"), None, "too short");
        assert_eq!(normalize("7K3MQ9XV2DD"), None, "too long");
        assert_eq!(normalize("7K3MQ9XV2Ж"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn the_payload_carries_addresses_port_fingerprint_and_code() {
        let fingerprint = "ab".repeat(32);
        assert_eq!(
            payload(
                &[Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)],
                45710,
                &fingerprint,
                "7K3MQ9XV2D",
            ),
            format!("markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f={fingerprint}&c=7K3MQ9XV2D")
        );
        assert_eq!(
            payload(&[], 45710, &fingerprint, "7K3MQ9XV2D"),
            format!("markiro-host:1?h=&p=45710&f={fingerprint}&c=7K3MQ9XV2D")
        );
    }
}
```

Create `apps/standalone/host/src/network.rs`:

```rust
//! This host's addresses in the local network, for pairing payloads.

use std::net::Ipv4Addr;

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::usable;

    #[test]
    fn only_up_lan_addresses_remain_sorted_without_repeats() {
        let candidates = [
            (Ipv4Addr::new(192, 168, 1, 10), true),
            (Ipv4Addr::new(127, 0, 0, 1), true),
            (Ipv4Addr::new(169, 254, 3, 4), true),
            (Ipv4Addr::new(10, 0, 0, 5), true),
            (Ipv4Addr::new(10, 0, 0, 7), false),
            (Ipv4Addr::new(0, 0, 0, 0), true),
            (Ipv4Addr::new(192, 168, 1, 10), true),
        ];
        assert_eq!(
            usable(candidates),
            vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)]
        );
    }
}
```

В `apps/standalone/host/src/lib.rs` рядом с другими `pub mod` добавить `pub mod network;` и `pub mod pairing_code;` (по алфавиту).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib pairing_code network --offline`
Expected: ошибка компиляции — `generate`, `normalize`, `payload`, `usable` не найдены.

- [ ] **Step 3: Код подключения и адреса**

В `apps/standalone/host/src/pairing_code.rs` между `use std::net::Ipv4Addr;` и `#[cfg(test)]` вставить:

```rust
/// Crockford base32: no I, L, O or U, so a code read aloud or typed from a
/// screen cannot be confused.
pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LENGTH: usize = 10;
/// How long a code can be claimed.
pub const CODE_LIFETIME: time::Duration = time::Duration::minutes(10);
/// Failed claims a live code survives; the next one finds it dead.
pub const MAX_FAILED_ATTEMPTS: i64 = 5;

/// A new code: 50 random bits as 10 Crockford characters. Each random byte
/// keeps its low 5 bits; 256 is a multiple of 32, so every symbol is equally
/// likely.
pub fn generate() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random generator is available");
    bytes
        .iter()
        .map(|byte| char::from(ALPHABET[usize::from(byte & 0x1f)]))
        .collect()
}

/// The canonical form of a typed or scanned code: upper case, without spaces
/// or hyphens, with Crockford's aliases (O reads as 0, I and L as 1). `None`
/// when the input cannot be a code at all.
pub fn normalize(input: &str) -> Option<String> {
    let mut code = String::with_capacity(CODE_LENGTH);
    for symbol in input.chars() {
        let symbol = match symbol.to_ascii_uppercase() {
            ' ' | '-' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            other => match u8::try_from(other) {
                Ok(byte) if ALPHABET.contains(&byte) => other,
                _ => return None,
            },
        };
        code.push(symbol);
        if code.len() > CODE_LENGTH {
            return None;
        }
    }
    (code.len() == CODE_LENGTH).then_some(code)
}

/// The DataMatrix payload (spec §4.7):
/// `markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`.
pub fn payload(addresses: &[Ipv4Addr], port: u16, fingerprint: &str, code: &str) -> String {
    let hosts = addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("markiro-host:1?h={hosts}&p={port}&f={fingerprint}&c={code}")
}
```

В `apps/standalone/host/src/network.rs` между `use std::net::Ipv4Addr;` и `#[cfg(test)]` вставить:

```rust
/// Addresses other devices can try: IPv4 addresses of interfaces that are up,
/// except loopback, link-local (169.254/16) and 0.0.0.0, sorted and without
/// repeats. Read afresh for every code, so a new DHCP lease shows up without
/// a restart.
pub fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    let interfaces = match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces,
        Err(error) => {
            tracing::warn!(%error, "listing network interfaces failed");
            return Vec::new();
        }
    };
    usable(
        interfaces
            .iter()
            .filter_map(|interface| match &interface.addr {
                if_addrs::IfAddr::V4(v4) => Some((v4.ip, interface.is_oper_up())),
                if_addrs::IfAddr::V6(_) => None,
            }),
    )
}

/// The filter behind [`lan_ipv4_addresses`]: `(address, interface is up)`.
pub fn usable(candidates: impl IntoIterator<Item = (Ipv4Addr, bool)>) -> Vec<Ipv4Addr> {
    let mut addresses: Vec<Ipv4Addr> = candidates
        .into_iter()
        .filter(|(ip, up)| *up && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified())
        .map(|(ip, _)| ip)
        .collect();
    addresses.sort_unstable();
    addresses.dedup();
    addresses
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib pairing_code network --offline`
Expected: PASS (4 теста).

- [ ] **Step 4: Тип протокола и фикстура**

В `apps/standalone/proto/src/lib.rs` после структуры `PairResponse` добавить:

```rust
/// `POST /v1/office/pairing-codes`: a one-time code for pairing another
/// device. The code and the payload carrying it are shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// 10 Crockford base32 characters.
    pub code: Secret,
    pub expires_at: String,
    /// `markiro-host:1?h=<addresses>&p=<port>&f=<fingerprint>&c=<code>`.
    pub payload: Secret,
}
```

Create `apps/standalone/proto/fixtures/pairing-code.json`:

```json
{
  "code": "7K3MQ9XV2D",
  "expiresAt": "2026-09-26T09:25:00Z",
  "payload": "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D"
}
```

(в `f=` ровно 64 символа — `"ab"` 32 раза; проверьте длину).

В `apps/standalone/proto/tests/fixtures.rs`: добавить `PairingCode` в импорт из `markiro_proto` и тест:

```rust
#[test]
fn pairing_code_fixture_round_trips_without_leaking() {
    let code: PairingCode = round_trip("pairing-code.json");
    let debug = format!("{code:?}");
    assert!(!debug.contains(code.code.expose()), "{debug}");
    assert!(!debug.contains("markiro-host:1"), "{debug}");
}
```

В `apps/standalone/src/host/protocol.ts` после `bootstrapResponseSchema` добавить:

```ts
/** `POST /v1/office/pairing-codes`: a one-time code; the payload is what the DataMatrix encodes. */
export const pairingCodeSchema = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/),
  expiresAt: z.iso.datetime(),
  payload: z.string().startsWith("markiro-host:1?"),
});
export type PairingCode = z.infer<typeof pairingCodeSchema>;
```

В `apps/standalone/test/protocol.test.ts` добавить `pairingCodeSchema` в импорт и в `describe("protocol schemas parse the shared Rust fixtures")`:

```ts
it("pairing code", () => {
  expect(pairingCodeSchema.parse(fixture("pairing-code.json"))).toMatchObject({
    code: "7K3MQ9XV2D",
    expiresAt: "2026-09-26T09:25:00Z",
  });
});
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` и `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Тест маршрута (падающий)**

В `apps/standalone/host/tests/support/app.rs`:

- добавить `use std::net::Ipv4Addr;`;
- перед `pub struct TestApp` добавить:

```rust
/// The certificate fingerprint `TestApp` reports: "ab" 32 times.
pub fn test_fingerprint() -> String {
    "ab".repeat(32)
}

/// The LAN addresses `TestApp` reports for pairing payloads.
pub const TEST_ADDRESSES: [Ipv4Addr; 2] = [Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)];
```

- в `TestApp::new` строку `let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone());` заменить на:

```rust
        let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone())
            .with_endpoint(test_fingerprint(), 45710)
            .with_addresses(|| TEST_ADDRESSES.to_vec());
```

Create `apps/standalone/host/tests/pairing_codes.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::clock::format_timestamp;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, login, pair_device, request, seed_office_user, test_fingerprint,
    with_device, with_session, TestApp,
};

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type AuditRow = (String, Option<String>, String, Option<String>, Option<String>, String, String);

async fn code_audit(app: &TestApp) -> Vec<AuditRow> {
    sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log WHERE action = 'pairing_code.create' ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap()
}

async fn admin_id(app: &TestApp) -> String {
    sqlx::query_scalar("SELECT id FROM office_users WHERE login = 'admin'")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_administrator_gets_a_one_time_code_with_the_pairing_payload() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;

    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/pairing-codes"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = body["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 10);
    assert!(code.bytes().all(|byte| CROCKFORD.contains(&byte)), "{code}");
    let expires = format_timestamp(app.state.now() + time::Duration::minutes(10));
    assert_eq!(body["expiresAt"], expires);
    assert_eq!(
        body["payload"],
        format!(
            "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f={}&c={code}",
            test_fingerprint()
        )
    );

    let (id, code_hash, created_by, created_at, expires_at, used_at, failed): (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
    ) = sqlx::query_as(
        "SELECT id, code_hash, created_by, created_at, expires_at, used_at, failed_attempts FROM pairing_codes",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    let admin = admin_id(&app).await;
    assert_eq!(code_hash, key_hash(&code));
    assert_eq!(created_by, admin);
    assert_eq!(created_at, app.state.timestamp());
    assert_eq!(expires_at, expires);
    assert_eq!(used_at, None);
    assert_eq!(failed, 0);

    let rows = code_audit(&app).await;
    assert_eq!(rows.len(), 1);
    let (actor_kind, actor_id, action, target_type, target_id, result, details) =
        rows.into_iter().next().unwrap();
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            action.as_str(),
            target_type.as_deref(),
            target_id.as_deref(),
            result.as_str()
        ),
        (
            "office_user",
            Some(admin.as_str()),
            "pairing_code.create",
            Some("pairing_code"),
            Some(id.as_str()),
            "ok"
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "expiresAt": expires })
    );
    assert!(!details.contains(&code), "the audit row never holds the code");
}

#[tokio::test]
async fn every_request_gets_a_new_code() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let mut codes = Vec::new();
    for _ in 0..2 {
        let (status, body) = app
            .send(empty(with_session(
                request("POST", "/v1/office/pairing-codes"),
                &key,
                &token,
            )))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        codes.push(body["code"].as_str().unwrap().to_owned());
    }
    assert_ne!(codes[0], codes[1]);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn only_administrators_create_codes() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    seed_office_user(&app, "tech", "technologist", "technologist password").await;
    let tech_token = login(&app, &key, "tech", "technologist password").await;

    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/pairing-codes"),
            &key,
            &tech_token,
        )))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = app
        .send(empty(with_device(
            request("POST", "/v1/office/pairing-codes"),
            &key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "session");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(code_audit(&app).await.is_empty());
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing_codes --offline`
Expected: ошибка компиляции — нет `with_endpoint`/`with_addresses` у `AppState`.

- [ ] **Step 6: Миграция, `Endpoint` и маршрут**

Create `apps/standalone/host/migrations/0005_pairing_codes.sql`:

```sql
-- One-time pairing codes (spec §4.7). Only the SHA-256 of the normalized
-- code is stored. A code is live until it is used, expires (10 minutes) or
-- reaches 5 failed attempts; a claim with an unknown code counts against
-- every live code, because the hash cannot tell which one was meant.
CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES office_users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0)
);
CREATE INDEX pairing_codes_live ON pairing_codes (expires_at) WHERE used_at IS NULL;
```

В `apps/standalone/host/src/server.rs`:

- добавить `use std::net::Ipv4Addr;`;
- перед `#[derive(Clone)] pub struct AppState` добавить:

```rust
/// How other devices reach this host: what a pairing payload carries.
#[derive(Clone)]
pub struct Endpoint {
    /// SHA-256 of the TLS certificate, lower-case hex.
    pub fingerprint: String,
    pub port: u16,
    /// This host's addresses in the local network, read for every new code.
    pub addresses: Arc<dyn Fn() -> Vec<Ipv4Addr> + Send + Sync>,
}
```

- в `AppState` после поля `login_limiter` добавить `pub endpoint: Endpoint,`;
- в `AppState::new` в литерал `Self { … }` добавить:

```rust
            endpoint: Endpoint {
                fingerprint: String::new(),
                port: markiro_proto::DEFAULT_PORT,
                addresses: Arc::new(crate::network::lan_ipv4_addresses),
            },
```

- в `impl AppState` добавить:

```rust
    /// The certificate fingerprint and the port other devices connect to.
    pub fn with_endpoint(mut self, fingerprint: String, port: u16) -> Self {
        self.endpoint.fingerprint = fingerprint;
        self.endpoint.port = port;
        self
    }

    /// Replace the address lookup; tests use fixed addresses.
    pub fn with_addresses(
        mut self,
        addresses: impl Fn() -> Vec<Ipv4Addr> + Send + Sync + 'static,
    ) -> Self {
        self.endpoint.addresses = Arc::new(addresses);
        self
    }
```

- в `protected_routes()` добавить маршрут:

```rust
        .route(
            "/v1/office/pairing-codes",
            post(crate::routes::pairing::create_code),
        )
```

В `apps/standalone/host/src/lib.rs` в `start` вызов `server::AppState::new(…)` дополнить строителем (после закрывающей скобки `new(…)`):

```rust
    .with_endpoint(identity.fingerprint.clone(), addr.port());
```

(так, чтобы `let state = server::AppState::new(pool.clone(), config.host_id.clone(), std::sync::Arc::new(clock::SystemClock)).with_endpoint(identity.fingerprint.clone(), addr.port());`).

В `apps/standalone/host/src/audit.rs`, модуль `actions`, добавить:

```rust
    pub const PAIRING_CODE_CREATE: &str = "pairing_code.create";
```

В `apps/standalone/host/src/routes/pairing.rs`:

- обновить первый комментарий модуля: `//! Device pairing: the local device (`POST /v1/local-pair`), one-time codes for devices in the network (`POST /v1/office/pairing-codes`) and device self-information (`GET /v1/device`).`;
- импорты: добавить `PairingCode` и `Secret` в `use markiro_proto::{…}`, `OfficeContext` в `use crate::auth::{…}`, `use crate::clock::format_timestamp;`, `use crate::pairing_code;`;
- в конец файла добавить:

```rust
/// `POST /v1/office/pairing-codes` (administrators): a one-time code for a
/// device in the local network. Only its hash is stored; the code and the
/// payload are returned once.
pub async fn create_code(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<PairingCode>, ApiError> {
    context.require_admin()?;
    let code = pairing_code::generate();
    let now = state.now();
    let at = format_timestamp(now);
    let expires = format_timestamp(now + pairing_code::CODE_LIFETIME);
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query(
        "INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(key_hash(&code))
    .bind(&context.user.id)
    .bind(&at)
    .bind(&expires)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PAIRING_CODE_CREATE,
            target_type: Some("pairing_code"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "expiresAt": expires }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    let addresses = (state.endpoint.addresses)();
    let payload = pairing_code::payload(
        &addresses,
        state.endpoint.port,
        &state.endpoint.fingerprint,
        &code,
    );
    Ok(Json(PairingCode {
        code: Secret::new(code),
        expires_at: expires,
        payload: Secret::new(payload),
    }))
}
```

Коды подключения — не справочник: ревизию хоста они не поднимают.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing_codes --offline`
Expected: PASS (3 теста). Затем `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (вне песочницы) — все тесты хоста PASS.

- [ ] **Step 7: Спецификация — новый крейт**

В спецификации, §2, строка решения 3 («Новые крейты»): после перечня `windows-service` (только Windows) дописать `; план 1c1 — `if-addrs` (адреса хоста в локальной сети для кода подключения: стандартная библиотека интерфейсы не перечисляет, а маршрута по умолчанию в изолированной сети может не быть)`. Затем `node_modules/.bin/prettier --write` на спецификацию (таблица перевыровняется) и `--check`.

- [ ] **Step 8: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` по изменённым JSON/TS/MD; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `git diff --check`.

```bash
git add apps/standalone/host/Cargo.toml apps/standalone/Cargo.lock apps/standalone/host/migrations/0005_pairing_codes.sql apps/standalone/host/src/pairing_code.rs apps/standalone/host/src/network.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/pairing_codes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/pairing-code.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): одноразовые коды подключения на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Подключение по коду — `POST /v1/pairing/claim`

Устройство в локальной сети отправляет код из офиса вместе со своим описанием и получает ключ устройства — как при локальном подключении, но без проверки loopback. Попутно — отложенное из 1b1:

- `validate::device_registration`, общий для обоих способов подключения;
- версия протокола клиента передаётся обработчикам из охранника (расширение `ClientProtocol`) вместо повторного разбора заголовка;
- проверка журнала процесса дополняется новыми секретами и другими формами соли и закрытого ключа TLS.

Коды ошибок `pairing_code_invalid` и `pairing_code_expired` появляются в протоколе, в вебвью и в общей фикстуре кодов.

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`; Create: `apps/standalone/proto/fixtures/claim-request.json`, `apps/standalone/proto/fixtures/error-codes.json`
- Modify: `apps/standalone/host/src/{server,validate,audit}.rs`, `apps/standalone/host/src/routes/pairing.rs`
- Create: `apps/standalone/host/tests/claim.rs`; Modify: `apps/standalone/host/tests/no_secrets_in_logs.rs`
- Modify: `apps/standalone/src/host/errors.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/errors.test.ts`
- Modify: `apps/standalone/AGENTS.md` (раздел «Local pairing trust»), спецификация §4.7

**Interfaces:**

- Consumes: `pairing_code::{normalize, MAX_FAILED_ATTEMPTS}`, таблица `pairing_codes` (задача 2); `audit::{actions, reasons, record}` (задача 1); `rate_limit::RateLimiter`.
- Produces:
  - `markiro_proto::ClaimRequest { code: Secret, kind: DeviceKind, name: String, app_version: String, capabilities: Vec<String> }`;
  - `markiro_proto::codes::{PAIRING_CODE_INVALID, PAIRING_CODE_EXPIRED, ALL}`;
  - `server::ClientProtocol(pub u32)` в расширениях каждого запроса за охранником;
  - `AppState.claim_limiter`;
  - `validate::device_registration(name, app_version, capabilities) -> Result<(&str, &str), ApiError>`;
  - маршрут `POST /v1/pairing/claim` → `PairResponse`;
  - `audit::actions::DEVICE_CLAIM = "device.claim"`, `audit::reasons::{UNKNOWN_CODE, CODE_USED, TOO_MANY_ATTEMPTS, CODE_EXPIRED}`;
  - в вебвью `API_ERROR_CODES` с двумя новыми кодами.

- [ ] **Step 1: Протокол — запрос, коды и фикстуры**

В `apps/standalone/proto/src/lib.rs`:

1. В модуль `codes` после `INTERNAL` добавить:

```rust
    pub const PAIRING_CODE_INVALID: &str = "pairing_code_invalid";
    pub const PAIRING_CODE_EXPIRED: &str = "pairing_code_expired";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
        NOT_FOUND,
        METHOD_NOT_ALLOWED,
        PROTOCOL_UNSUPPORTED,
        VALIDATION_FAILED,
        UNAUTHORIZED,
        FORBIDDEN,
        STALE_REVISION,
        CONFLICT,
        LAST_ADMIN,
        SSCC_BELOW_FLOOR,
        ALREADY_INITIALIZED,
        LOOPBACK_ONLY,
        RATE_LIMITED,
        INTERNAL,
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
    ];
```

2. После `LocalPairRequest` добавить:

```rust
/// `POST /v1/pairing/claim`: a device in the local network pairs with a
/// one-time code from the office.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimRequest {
    pub code: Secret,
    pub kind: DeviceKind,
    pub name: String,
    pub app_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}
```

3. Комментарий у `PairResponse` «Response of `local-pair` (and, from plan 1c, `pairing/claim`).» → «Response of `local-pair` and `pairing/claim`.».

Create `apps/standalone/proto/fixtures/claim-request.json`:

```json
{
  "code": "7K3MQ9XV2D",
  "kind": "station",
  "name": "Станция на линии 2",
  "appVersion": "0.1.0",
  "capabilities": []
}
```

Create `apps/standalone/proto/fixtures/error-codes.json`:

```json
{
  "codes": [
    "not_found",
    "method_not_allowed",
    "protocol_unsupported",
    "validation_failed",
    "unauthorized",
    "forbidden",
    "stale_revision",
    "conflict",
    "last_admin",
    "sscc_below_floor",
    "already_initialized",
    "loopback_only",
    "rate_limited",
    "internal",
    "pairing_code_invalid",
    "pairing_code_expired"
  ]
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить `ClaimRequest` в импорт и тесты:

```rust
#[test]
fn claim_request_round_trips_rejects_unknown_fields_and_hides_the_code() {
    let request: ClaimRequest = round_trip("claim-request.json");
    assert!(!format!("{request:?}").contains("7K3MQ9XV2D"));
    let mut value = fixture("claim-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<ClaimRequest>(value).is_err());
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
    listed.sort_unstable();
    let mut known = markiro_proto::codes::ALL.to_vec();
    known.sort_unstable();
    assert_eq!(listed, known);
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Expected: PASS.

- [ ] **Step 2: Тесты `claim` (падающие)**

Create `apps/standalone/host/tests/claim.rs`:

```rust
mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, with_device,
    with_session, TestApp, LAN, LOOPBACK,
};

type AuditRow = (String, Option<String>, String, Option<String>, Option<String>, String, Value);

async fn claim_audit(app: &TestApp) -> Vec<AuditRow> {
    let rows: Vec<(String, Option<String>, String, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'device.claim' ORDER BY id",
        )
        .fetch_all(&app.state.pool)
        .await
        .unwrap();
    rows.into_iter()
        .map(|(kind, id, action, target_type, target_id, result, details)| {
            (kind, id, action, target_type, target_id, result, serde_json::from_str(&details).unwrap())
        })
        .collect()
}

/// A host after the wizard: the host device's key and the admin's session.
async fn host(app: &TestApp) -> (String, String) {
    let (_, key) = pair_device(app, "station").await;
    let token = bootstrap(app, &key).await;
    (key, token)
}

/// A new code from the office; returns the code and its row id.
async fn new_code(app: &TestApp, key: &str, token: &str) -> (String, String) {
    let (status, body) = app
        .send(empty(with_session(request("POST", "/v1/office/pairing-codes"), key, token)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = body["code"].as_str().unwrap().to_owned();
    let id = sqlx::query_scalar("SELECT id FROM pairing_codes WHERE code_hash = ?")
        .bind(key_hash(&code))
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    (code, id)
}

fn claim_body(code: &str) -> Value {
    json!({ "code": code, "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" })
}

async fn claim(app: &TestApp, body: Value) -> (StatusCode, Value) {
    app.send_from(LAN, json_request(request("POST", "/v1/pairing/claim"), body)).await
}

async fn failed_attempts(app: &TestApp, id: &str) -> i64 {
    sqlx::query_scalar("SELECT failed_attempts FROM pairing_codes WHERE id = ?")
        .bind(id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

fn denied(reason: &str, target: Option<&str>) -> AuditRow {
    (
        "system".into(),
        None,
        "device.claim".into(),
        Some("pairing_code".into()),
        target.map(str::to_owned),
        "denied".into(),
        json!({ "reason": reason, "kind": "station", "name": "Станция 2", "address": "192.168.1.20" }),
    )
}

#[tokio::test]
async fn a_device_in_the_network_pairs_with_a_code_typed_in_any_case() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    let typed = format!("{}-{}", &code[..5], &code[5..]).to_lowercase();

    let (status, body) = claim(&app, claim_body(&typed)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let device_id = body["deviceId"].as_str().unwrap().to_owned();
    let device_key = body["deviceKey"].as_str().unwrap().to_owned();
    assert_eq!(device_key.len(), 43);
    assert_eq!(body["hostId"], app.state.host_id);

    let (kind, name, stored_hash, protocol, paired_at): (String, String, String, i64, String) =
        sqlx::query_as("SELECT kind, name, key_hash, protocol, paired_at FROM devices WHERE id = ?")
            .bind(&device_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 1, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
    let used_at: Option<String> = sqlx::query_scalar("SELECT used_at FROM pairing_codes WHERE id = ?")
        .bind(&code_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(used_at, Some(app.state.timestamp()));

    // The new key works from the network.
    let (status, me) = app
        .send_from(LAN, empty(with_device(request("GET", "/v1/device"), &device_key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["name"], "Станция 2");

    assert_eq!(
        claim_audit(&app).await,
        vec![(
            "device".into(),
            Some(device_id.clone()),
            "device.claim".into(),
            Some("device".into()),
            Some(device_id),
            "ok".into(),
            json!({ "kind": "station", "name": "Станция 2", "pairingCodeId": code_id, "address": "192.168.1.20" }),
        )]
    );
}

#[tokio::test]
async fn a_code_is_claimed_once() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    assert_eq!(claim(&app, claim_body(&code)).await.0, StatusCode::OK);

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_invalid");
    let devices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(devices, 2, "the host device and the one that claimed first");
    assert_eq!(claim_audit(&app).await[1], denied("code_used", Some(&code_id)));
}

#[tokio::test]
async fn a_code_expires_after_ten_minutes() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    app.clock.advance(time::Duration::minutes(10));

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_expired");
    assert_eq!(claim_audit(&app).await, vec![denied("code_expired", Some(&code_id))]);
}

#[tokio::test]
async fn five_wrong_codes_kill_every_live_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    for attempt in 1..=5 {
        let wrong = if attempt == 3 { "hello" } else { "0000000000" };
        let (status, body) = claim(&app, claim_body(wrong)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"]["code"], "pairing_code_invalid");
        assert_eq!(failed_attempts(&app, &code_id).await, attempt);
    }

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_invalid");
    let rows = claim_audit(&app).await;
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0], denied("unknown_code", None));
    assert_eq!(rows[5], denied("too_many_attempts", Some(&code_id)));
}

#[tokio::test]
async fn claims_are_limited_per_address_separately_from_logins() {
    let app = TestApp::new().await;
    let (key, _) = host(&app).await;
    for _ in 0..10 {
        assert_eq!(claim(&app, claim_body("0000000000")).await.0, StatusCode::BAD_REQUEST);
    }
    let (status, body) = claim(&app, claim_body("0000000000")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
    assert_eq!(claim_audit(&app).await.len(), 10, "a refused-by-limit attempt writes no row");

    // Another address still gets an answer, and logins from this address are not affected.
    let (status, _) = app
        .send_from(LOOPBACK, json_request(request("POST", "/v1/pairing/claim"), claim_body("0000000000")))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                with_device(request("POST", "/v1/office/login"), &key),
                json!({ "login": "admin", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_claim_is_checked_before_the_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;

    let (status, body) = claim(&app, json!({ "code": code, "kind": "station", "name": "  ", "appVersion": "0.1.0" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
    assert_eq!(body["error"]["details"]["field"], "name");
    let mut extra = claim_body(&code);
    extra["extra"] = json!(true);
    let (status, body) = claim(&app, extra).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");

    assert_eq!(failed_attempts(&app, &code_id).await, 0);
    assert!(claim_audit(&app).await.is_empty());
}

#[tokio::test]
async fn a_handheld_pairs_with_a_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, _) = new_code(&app, &key, &token).await;
    let (status, body) = claim(
        &app,
        json!({ "code": code, "kind": "handheld", "name": "ТСД 1", "appVersion": "1.2.0", "capabilities": ["scanner"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (kind, capabilities): (String, String) =
        sqlx::query_as("SELECT kind, capabilities FROM devices WHERE id = ?")
            .bind(body["deviceId"].as_str().unwrap())
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!((kind.as_str(), capabilities.as_str()), ("handheld", r#"["scanner"]"#));
}
```

(`login` импортирован на случай, если понадобится; если компилятор предупредит о неиспользуемом импорте — уберите его.)

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test claim --offline`
Expected: FAIL — маршрута `/v1/pairing/claim` нет (404).

- [ ] **Step 3: `ClientProtocol`, ограничитель и общая проверка устройства**

В `apps/standalone/host/src/server.rs`:

- перед `pub async fn protocol_guard` добавить:

```rust
/// The protocol version the client sent, set by [`protocol_guard`] for every
/// route behind it: handlers that record it read this instead of parsing the
/// header again.
#[derive(Debug, Clone, Copy)]
pub struct ClientProtocol(pub u32);
```

- `protocol_guard` сделать `pub async fn protocol_guard(mut request: Request, next: Next) -> Result<Response, ApiError>` и в ветке принятой версии перед `Ok(next.run(request).await)` добавить `request.extensions_mut().insert(ClientProtocol(version));`;
- в `AppState` после `login_limiter` добавить поле:

```rust
    /// Pairing claims, per address; separate from `login_limiter`, so a
    /// mistyped pairing code never locks the office out on the same computer.
    pub claim_limiter: Arc<crate::rate_limit::RateLimiter>,
```

и в `AppState::new` рядом с `login_limiter`:

```rust
            claim_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
```

(так, чтобы `clock` перемещался в поле последним, как сейчас);

- в `protected_routes()` добавить `.route("/v1/pairing/claim", post(crate::routes::pairing::claim))`.

В `apps/standalone/host/src/rate_limit.rs` первый комментарий `//! Per-address attempt limit for office login (and, from plan 1c, pairing claims): …` → `//! Per-address attempt limit (office login and password change share one; pairing claims have their own): …`.

В `apps/standalone/host/src/validate.rs` добавить:

```rust
/// A device's own description at pairing (`local-pair` and `pairing/claim`):
/// returns the trimmed name and app version.
pub fn device_registration<'a>(
    name: &'a str,
    app_version: &'a str,
    capabilities: &[String],
) -> Result<(&'a str, &'a str), ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::validation("name", "the name must be 1-100 characters"));
    }
    let app_version = app_version.trim();
    if app_version.is_empty() || app_version.len() > 50 {
        return Err(ApiError::validation(
            "appVersion",
            "the app version must be 1-50 characters",
        ));
    }
    if capabilities.len() > 32
        || capabilities
            .iter()
            .any(|capability| capability.is_empty() || capability.len() > 64)
    {
        return Err(ApiError::validation(
            "capabilities",
            "at most 32 capabilities of 1-64 characters",
        ));
    }
    Ok((name, app_version))
}
```

В `apps/standalone/host/src/audit.rs`: в `actions` добавить `pub const DEVICE_CLAIM: &str = "device.claim";`, в `reasons`:

```rust
    /// No live code matches (or the input is not a code at all).
    pub const UNKNOWN_CODE: &str = "unknown_code";
    pub const CODE_USED: &str = "code_used";
    pub const TOO_MANY_ATTEMPTS: &str = "too_many_attempts";
    pub const CODE_EXPIRED: &str = "code_expired";
```

- [ ] **Step 4: Обработчики подключения**

В `apps/standalone/host/src/routes/pairing.rs`:

1. Импорты привести к:

```rust
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use markiro_proto::{
    codes, ClaimRequest, DeviceInfo, DeviceKind, LocalPairRequest, PairResponse, PairingCode,
    Secret,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, reasons, Actor, Entry, Outcome};
use crate::auth::{require_loopback, AuthDevice, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::pairing_code;
use crate::secrets::{key_hash, random_key};
use crate::server::{AppState, ClientProtocol};
use crate::validate;
```

(уберите импорты, которые после правок не используются, например `HeaderMap` и `PROTOCOL_HEADER`).

2. Функцию `local_pair` заменить целиком:

```rust
pub async fn local_pair(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(ClientProtocol(protocol)): Extension<ClientProtocol>,
    ApiJson(request): ApiJson<LocalPairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    require_loopback(peer)?;
    if request.kind == DeviceKind::Handheld {
        return Err(ApiError::validation(
            "kind",
            "a handheld pairs with a code, not locally",
        ));
    }
    let (name, app_version) =
        validate::device_registration(&request.name, &request.app_version, &request.capabilities)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let key = insert_device(
        &mut tx,
        &NewDevice {
            id: &id,
            kind: request.kind,
            name,
            app_version,
            protocol,
            capabilities: &request.capabilities,
            at: &now,
        },
    )
    .await?;
    audit::record(
        &mut tx,
        &now,
        Entry {
            actor: Actor::Device(&id),
            action: actions::DEVICE_LOCAL_PAIR,
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
        device_key: key.into(),
        host_id: state.host_id.clone(),
    }))
}
```

3. После `local_pair` добавить:

```rust
/// A device being paired, as `devices` stores it.
struct NewDevice<'a> {
    id: &'a str,
    kind: DeviceKind,
    name: &'a str,
    app_version: &'a str,
    protocol: u32,
    capabilities: &'a [String],
    at: &'a str,
}

/// Insert a new device; returns its key (shown once, stored only as a hash).
async fn insert_device(conn: &mut SqliteConnection, device: &NewDevice<'_>) -> Result<String, ApiError> {
    let key = random_key();
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, capabilities, paired_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device.id)
    .bind(device.kind.as_str())
    .bind(device.name)
    .bind(key_hash(&key))
    .bind(device.app_version)
    .bind(i64::from(device.protocol))
    .bind(serde_json::to_string(device.capabilities).map_err(ApiError::internal)?)
    .bind(device.at)
    .bind(device.at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(key)
}

#[derive(sqlx::FromRow)]
struct StoredCode {
    id: String,
    expires_at: String,
    used_at: Option<String>,
    failed_attempts: i64,
}

/// `POST /v1/pairing/claim`: a device in the local network pairs with a
/// one-time code. No device key and no loopback check: the code is the
/// credential, bounded by its lifetime, one use, 5 failed attempts and the
/// per-address limit.
pub async fn claim(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(ClientProtocol(protocol)): Extension<ClientProtocol>,
    ApiJson(request): ApiJson<ClaimRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    state.claim_limiter.check(peer.ip())?;
    let (name, app_version) =
        validate::device_registration(&request.name, &request.app_version, &request.capabilities)?;
    let address = peer.ip().to_canonical().to_string();
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let found: Option<StoredCode> = match pairing_code::normalize(request.code.expose()) {
        Some(code) => sqlx::query_as(
            "SELECT id, expires_at, used_at, failed_attempts FROM pairing_codes WHERE code_hash = ?",
        )
        .bind(key_hash(&code))
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?,
        None => None,
    };
    let refusal = match &found {
        None => Some((reasons::UNKNOWN_CODE, codes::PAIRING_CODE_INVALID)),
        Some(code) if code.used_at.is_some() => Some((reasons::CODE_USED, codes::PAIRING_CODE_INVALID)),
        Some(code) if code.failed_attempts >= pairing_code::MAX_FAILED_ATTEMPTS => {
            Some((reasons::TOO_MANY_ATTEMPTS, codes::PAIRING_CODE_INVALID))
        }
        // Timestamps share one sortable format, so text order is time order.
        Some(code) if code.expires_at <= at => Some((reasons::CODE_EXPIRED, codes::PAIRING_CODE_EXPIRED)),
        Some(_) => None,
    };
    let code = match (found, refusal) {
        (Some(code), None) => code,
        (found, refusal) => {
            // `(None, None)` cannot happen: no row always refuses.
            let (reason, error_code) =
                refusal.unwrap_or((reasons::UNKNOWN_CODE, codes::PAIRING_CODE_INVALID));
            if reason == reasons::UNKNOWN_CODE {
                // The hash cannot tell which code was meant, so a wrong code
                // counts against every live one: each survives at most
                // MAX_FAILED_ATTEMPTS wrong tries in total.
                sqlx::query(
                    "UPDATE pairing_codes SET failed_attempts = failed_attempts + 1 \
                     WHERE used_at IS NULL AND expires_at > ?",
                )
                .bind(&at)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            }
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::System,
                    action: actions::DEVICE_CLAIM,
                    target_type: Some("pairing_code"),
                    target_id: found.as_ref().map(|code| code.id.as_str()),
                    outcome: Outcome::Denied,
                    details: json!({
                        "reason": reason,
                        "kind": request.kind.as_str(),
                        "name": name,
                        "address": address,
                    }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            let message = if error_code == codes::PAIRING_CODE_EXPIRED {
                "the pairing code expired"
            } else {
                "the pairing code is not valid"
            };
            return Err(ApiError::new(StatusCode::BAD_REQUEST, error_code, message));
        }
    };
    sqlx::query("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&code.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let device_id = uuid::Uuid::new_v4().to_string();
    let key = insert_device(
        &mut tx,
        &NewDevice {
            id: &device_id,
            kind: request.kind,
            name,
            app_version,
            protocol,
            capabilities: &request.capabilities,
            at: &at,
        },
    )
    .await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device_id),
            action: actions::DEVICE_CLAIM,
            target_type: Some("device"),
            target_id: Some(&device_id),
            outcome: Outcome::Ok,
            details: json!({
                "kind": request.kind.as_str(),
                "name": name,
                "pairingCodeId": code.id,
                "address": address,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(PairResponse {
        device_id,
        device_key: key.into(),
        host_id: state.host_id.clone(),
    }))
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test claim --test pairing --test pairing_codes --offline`
Expected: PASS. Затем все тесты хоста (вне песочницы) — PASS.

- [ ] **Step 5: Журнал процесса — новые секреты**

В `apps/standalone/host/tests/no_secrets_in_logs.rs`:

- в импорт `base64` добавить `STANDARD_NO_PAD` и `URL_SAFE_NO_PAD`, если их нет: `use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};` (оставьте существующее использование `STANDARD` как есть);
- перед строкой `// A wrong device key and a wrong session token are both rejected...` добавить:

```rust
    // A pairing code and a device paired with it: neither the code, the
    // payload carrying it, nor the new device key may reach the log.
    let pairing: serde_json::Value = client
        .post(format!("{base}/v1/office/pairing-codes"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing_code = pairing["code"].as_str().unwrap().to_owned();
    let pairing_payload = pairing["payload"].as_str().unwrap().to_owned();
    let claimed: serde_json::Value = client
        .post(format!("{base}/v1/pairing/claim"))
        .header(protocol.0, &protocol.1)
        .json(&json!({ "code": pairing_code, "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claimed_key = claimed["deviceKey"].as_str().unwrap().to_owned();
```

- после чтения соли (`let salt: Vec<u8> = …`) добавить `let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();`;
- в вектор `secrets` добавить элементы:

```rust
        pairing_code,
        pairing_payload,
        claimed_key,
        format!("{salt:?}"),
        STANDARD_NO_PAD.encode(&salt),
        URL_SAFE_NO_PAD.encode(&salt),
        STANDARD.encode(&key_der),
        key_der.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
```

(порядок элементов значения не имеет; если имена переменных в файле другие — `token` для сессии администратора, `key` для ключа устройства, `paths` для каталога данных — используйте их).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline`
Expected: PASS.

- [ ] **Step 6: Коды ошибок в вебвью**

В `apps/standalone/src/host/errors.ts` в массив `API_ERROR_CODES` после `"internal"` добавить `"pairing_code_invalid"` и `"pairing_code_expired"`.

В `apps/standalone/src/i18n/ru.json` в `errors.api` добавить:

```json
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе."
```

В `apps/standalone/test/errors.test.ts`:

- добавить импорты `import { readFileSync } from "node:fs";` и `import { z } from "zod";`;
- перед `describe(` добавить `const testModuleUrl = import.meta.url;` (см. `test/protocol.test.ts`: адрес модуля связывается до построения URL);
- в `describe("error messages")` добавить тест:

```ts
it("list exactly the host's error codes (proto/fixtures/error-codes.json)", () => {
  const fixture = z
    .object({ codes: z.array(z.string()) })
    .parse(
      JSON.parse(
        readFileSync(new URL("../proto/fixtures/error-codes.json", testModuleUrl), "utf8"),
      ),
    );
  expect([...API_ERROR_CODES].sort()).toEqual([...fixture.codes].sort());
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/errors.test.ts`
Expected: PASS (включая существующий тест, что у каждого кода есть текст).

- [ ] **Step 7: Документы**

1. `apps/standalone/AGENTS.md`, раздел «Local pairing trust»: последнее предложение «Devices on the network pair only with a one-time code (plan 1c).» заменить на:

```markdown
Devices on the network pair only with a one-time code. An administrator
creates it (`POST /v1/office/pairing-codes`); it lives 10 minutes, is stored
as a hash, is claimed once (`POST /v1/pairing/claim`, 10 attempts a minute
per address) and dies after 5 failed claims — a wrong code counts against
every live code, since the hash cannot tell which one was meant. The claiming
device pins the fingerprint from the scanned payload, or one a person
compared with the office screen.
```

2. Спецификация, §4.7, третий пункт («Хост хранит SHA-256 кода …») заменить на:

```markdown
- Хост хранит SHA-256 кода, отмечает использование, считает неудачные попытки
  (после пятой код недействителен) и пишет в журнал действий создание кода,
  подключение и отказ. Неверный код засчитывается всем живым кодам: по хешу
  нельзя понять, какой код пытались ввести. Отказы — `pairing_code_invalid`
  (код неизвестен, использован или исчерпал попытки) и `pairing_code_expired`.
```

- [ ] **Step 8: Проверки и коммит**

Run: все тесты хоста и `markiro-proto` (вне песочницы); `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; пакетные `test`, `typecheck`, `lint` вебвью; `node_modules/.bin/prettier --check` по изменённым JSON/TS/MD; `git diff --check`.

```bash
git add apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/claim-request.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/host/src/server.rs apps/standalone/host/src/rate_limit.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/tests/claim.rs apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json apps/standalone/test/errors.test.ts apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): подключение устройства по коду — POST /v1/pairing/claim" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Выбор линии станцией и список устройств

После подключения станция выбирает линию (`PUT /v1/device/line`), а офис видит подключённые устройства (`GET /v1/office/devices`). В плане 1c3 на этом списке построена страница «Устройства» с диалогом кода подключения; переименование, смена линии из офиса и отзыв — план 1d. Обработчики самого устройства (`GET /v1/device` и выбор линии) и список для офиса переезжают в отдельный модуль `routes/devices.rs`.

**Files:**

- Create: `apps/standalone/host/src/routes/devices.rs`, `apps/standalone/host/tests/device_line.rs`
- Modify: `apps/standalone/host/src/routes/{mod,pairing}.rs`, `apps/standalone/host/src/{server,audit}.rs`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`; Create: `apps/standalone/proto/fixtures/device-line-request.json`, `apps/standalone/proto/fixtures/device-record.json`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- Consumes: `AuthDevice { id, kind }`, `OfficeContext::require_admin`, `audit::{update_details, record, actions}`, таблицы `devices` и `lines`.
- Produces:
  - `markiro_proto::DeviceLineRequest { line_id: String }`;
  - `markiro_proto::DeviceRecord { id, kind, name, line_id: Option<String>, app_version, paired_at, last_seen_at: Option<String>, revoked_at: Option<String> }`;
  - маршруты `PUT /v1/device/line` → `DeviceInfo` и `GET /v1/office/devices` → `Vec<DeviceRecord>`;
  - `routes::devices::{device_info, select_line, list_devices}` (`device_info` переезжает сюда из `pairing.rs`);
  - `audit::actions::DEVICE_LINE = "device.line"`;
  - схема Zod `deviceRecordSchema`.

- [ ] **Step 1: Протокол и фикстуры**

В `apps/standalone/proto/src/lib.rs` после `DeviceInfo` добавить:

```rust
/// `PUT /v1/device/line`: a station chooses the line it works on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceLineRequest {
    pub line_id: String,
}

/// A paired device as the administrator sees it (`GET /v1/office/devices`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub app_version: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}
```

Create `apps/standalone/proto/fixtures/device-line-request.json`:

```json
{ "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61" }
```

Create `apps/standalone/proto/fixtures/device-record.json`:

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "kind": "station",
  "name": "Станция на линии 2",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "appVersion": "0.1.0",
  "pairedAt": "2026-09-26T09:15:00Z",
  "lastSeenAt": "2026-09-26T10:40:00Z",
  "revokedAt": null
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить `DeviceLineRequest` и `DeviceRecord` в импорт и тест:

```rust
#[test]
fn device_line_and_record_fixtures_round_trip() {
    let request: DeviceLineRequest = round_trip("device-line-request.json");
    assert_eq!(request.line_id, "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61");
    let mut value = fixture("device-line-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<DeviceLineRequest>(value).is_err());
    let record: DeviceRecord = round_trip("device-record.json");
    assert_eq!(record.kind, DeviceKind::Station);
    assert_eq!(record.revoked_at, None);
}
```

В `apps/standalone/src/host/protocol.ts` после `deviceInfoSchema` добавить:

```ts
/** `GET /v1/office/devices`: a paired device as the administrator sees it. */
export const deviceRecordSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  appVersion: z.string(),
  pairedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
```

В `apps/standalone/test/protocol.test.ts` добавить `deviceRecordSchema` в импорт и тест:

```ts
it("device record", () => {
  expect(deviceRecordSchema.parse(fixture("device-record.json"))).toMatchObject({
    kind: "station",
    lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
    revokedAt: null,
  });
});
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` и `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS.

- [ ] **Step 2: Тесты (падающие)**

Create `apps/standalone/host/tests/device_line.rs`:

```rust
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, seed_office_user,
    with_device, with_session, TestApp,
};

async fn line_ids(app: &TestApp) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&app.state.pool)
        .await
        .unwrap()
}

async fn select(app: &TestApp, key: &str, body: Value) -> (StatusCode, Value) {
    app.send(json_request(with_device(request("PUT", "/v1/device/line"), key), body))
        .await
}

type AuditRow = (String, Option<String>, String, Option<String>, Option<String>, String, Value);

async fn line_audit(app: &TestApp) -> Vec<AuditRow> {
    let rows: Vec<(String, Option<String>, String, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'device.line' ORDER BY id",
        )
        .fetch_all(&app.state.pool)
        .await
        .unwrap();
    rows.into_iter()
        .map(|(kind, id, action, target_type, target_id, result, details)| {
            (kind, id, action, target_type, target_id, result, serde_json::from_str(&details).unwrap())
        })
        .collect()
}

async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_station_chooses_an_active_line() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    let revision = host_revision(&app).await;

    let (status, body) = select(&app, &key, json!({ "lineId": lines[0] })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["id"], device_id);
    assert_eq!(body["lineId"], lines[0]);
    let (status, info) = app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["lineId"], lines[0]);
    assert_eq!(host_revision(&app).await, revision, "devices are not in the change feed");

    // The same line again changes nothing; another line is recorded with both values.
    assert_eq!(select(&app, &key, json!({ "lineId": lines[0] })).await.0, StatusCode::OK);
    assert_eq!(select(&app, &key, json!({ "lineId": lines[1] })).await.0, StatusCode::OK);
    let row = |from: Value, to: &str| -> AuditRow {
        (
            "device".into(),
            Some(device_id.clone()),
            "device.line".into(),
            Some("device".into()),
            Some(device_id.clone()),
            "ok".into(),
            json!({ "changed": ["lineId"], "lineId": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        line_audit(&app).await,
        vec![row(Value::Null, &lines[0]), row(json!(lines[0]), &lines[1])]
    );
}

#[tokio::test]
async fn only_an_existing_active_line_is_accepted() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    sqlx::query("UPDATE lines SET archived = 1 WHERE id = ?")
        .bind(&lines[1])
        .execute(&app.state.pool)
        .await
        .unwrap();

    for line_id in [lines[1].as_str(), "9b2e4a6c-0000-4000-8000-000000000000", "not-a-uuid"] {
        let (status, body) = select(&app, &key, json!({ "lineId": line_id })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{line_id}");
        assert_eq!(body["error"]["code"], "validation_failed");
        assert_eq!(body["error"]["details"]["field"], "lineId");
    }
    let (status, body) = select(&app, &key, json!({ "lineId": lines[0], "extra": 1 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
    assert!(line_audit(&app).await.is_empty());
}

#[tokio::test]
async fn only_a_station_works_on_a_line() {
    let app = TestApp::new().await;
    let (_, station_key) = pair_device(&app, "station").await;
    bootstrap(&app, &station_key).await;
    let (_, office_key) = pair_device(&app, "office").await;
    let lines = line_ids(&app).await;

    let (status, _) = select(&app, &office_key, json!({ "lineId": lines[0] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = app
        .send(json_request(request("PUT", "/v1/device/line"), json!({ "lineId": lines[0] })))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

#[tokio::test]
async fn the_administrator_lists_paired_devices() {
    let app = TestApp::new().await;
    let (station_id, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    assert_eq!(select(&app, &key, json!({ "lineId": lines[0] })).await.0, StatusCode::OK);
    let (office_id, _) = pair_device(&app, "office").await;

    let (status, body) = app
        .send(empty(with_session(request("GET", "/v1/office/devices"), &key, &token)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let now = app.state.timestamp();
    assert_eq!(
        body,
        json!([
            {
                "id": station_id,
                "kind": "station",
                "name": "Тестовое устройство",
                "lineId": lines[0],
                "appVersion": "0.1.0",
                "pairedAt": now,
                "lastSeenAt": now,
                "revokedAt": null
            },
            {
                "id": office_id,
                "kind": "office",
                "name": "Тестовое устройство",
                "lineId": null,
                "appVersion": "0.1.0",
                "pairedAt": now,
                "lastSeenAt": now,
                "revokedAt": null
            }
        ])
        .as_array()
        .map(|devices| {
            // Same pairing time: the host orders by id then.
            let mut devices = devices.clone();
            devices.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
            Value::Array(devices)
        })
        .unwrap()
    );

    seed_office_user(&app, "tech", "technologist", "technologist password").await;
    let tech = login(&app, &key, "tech", "technologist password").await;
    let (status, _) = app
        .send(empty(with_session(request("GET", "/v1/office/devices"), &key, &tech)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --offline`
Expected: FAIL — маршрутов нет (405 у `PUT /v1/device/line`, 404 у списка).

- [ ] **Step 3: Модуль `routes/devices.rs`**

Create `apps/standalone/host/src/routes/devices.rs`:

```rust
//! A device's own record (`GET /v1/device`), a station's choice of line
//! (`PUT /v1/device/line`) and the administrator's list of paired devices
//! (`GET /v1/office/devices`). Renaming, reassigning and revoking from the
//! office arrive in plan 1d.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AuthDevice, OfficeContext};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

async fn read_info(conn: &mut SqliteConnection, device: &AuthDevice) -> Result<DeviceInfo, ApiError> {
    let (name, line_id, paired_at): (String, Option<String>, String) =
        sqlx::query_as("SELECT name, line_id, paired_at FROM devices WHERE id = ?")
            .bind(&device.id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(DeviceInfo {
        id: device.id.clone(),
        kind: device.kind,
        name,
        line_id,
        paired_at,
    })
}

pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read_info(&mut conn, &device).await.map(Json)
}

/// A station picks the line it works on: only an existing, active line.
/// Devices are not in the change feed, so the host revision stays.
pub async fn select_line(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<DeviceLineRequest>,
) -> Result<Json<DeviceInfo>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden("only a station works on a line"));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(&request.line_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if archived != Some(0) {
        return Err(ApiError::validation("lineId", "no such active line"));
    }
    let current: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if let Some(details) =
        audit::update_details(&[("lineId", json!(current), json!(request.line_id))])
    {
        sqlx::query("UPDATE devices SET line_id = ? WHERE id = ?")
            .bind(&request.line_id)
            .bind(&device.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: Actor::Device(&device.id),
                action: actions::DEVICE_LINE,
                target_type: Some("device"),
                target_id: Some(&device.id),
                outcome: Outcome::Ok,
                details,
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let info = read_info(&mut tx, &device).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(info))
}

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    kind: String,
    name: String,
    line_id: Option<String>,
    app_version: String,
    paired_at: String,
    last_seen_at: Option<String>,
    revoked_at: Option<String>,
}

/// `GET /v1/office/devices` (administrators): every paired device, revoked
/// ones included, in pairing order.
pub async fn list_devices(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<DeviceRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT id, kind, name, line_id, app_version, paired_at, last_seen_at, revoked_at \
         FROM devices ORDER BY paired_at, id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|row| {
            let kind: DeviceKind = serde_json::from_value(serde_json::Value::String(row.kind))
                .map_err(ApiError::internal)?;
            Ok(DeviceRecord {
                id: row.id,
                kind,
                name: row.name,
                line_id: row.line_id,
                app_version: row.app_version,
                paired_at: row.paired_at,
                last_seen_at: row.last_seen_at,
                revoked_at: row.revoked_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}
```

- В `apps/standalone/host/src/routes/mod.rs` добавить `pub mod devices;` (по алфавиту).
- В `apps/standalone/host/src/routes/pairing.rs` удалить функцию `device_info`. Из импортов убрать то, что осталось только ради неё: `DeviceInfo`, `AuthDevice` — если больше нигде не используются. В комментарии модуля убрать упоминание `GET /v1/device`.
- В `apps/standalone/host/src/server.rs`:
  - маршрут `.route("/v1/device", get(crate::routes::pairing::device_info))` → `.route("/v1/device", get(crate::routes::devices::device_info))`;
  - добавить `.route("/v1/device/line", put(crate::routes::devices::select_line))` и `.route("/v1/office/devices", get(crate::routes::devices::list_devices))`.
- В `apps/standalone/host/src/audit.rs`, модуль `actions`, добавить `pub const DEVICE_LINE: &str = "device.line";`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --test pairing --offline`
Expected: PASS. Затем все тесты хоста (вне песочницы) — PASS.

- [ ] **Step 4: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` по изменённым JSON/TS; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `git diff --check`.

```bash
git add apps/standalone/host/src/routes/devices.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/device_line.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/device-line-request.json apps/standalone/proto/fixtures/device-record.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
git commit -m "feat(standalone): выбор линии станцией и список устройств для офиса" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Лента изменений — `GET /v1/changes`

Станции забирают справочники порциями: всё, что изменилось после их ревизии. В плане 1c в ленте:

- профиль организации;
- соль бейджей и размеры блоков площадки;
- линии;
- удаления (`tombstones`) — таблица и путь в ленте появляются сейчас, чтобы планы 1d и 1e только добавляли свои сущности.

Порция никогда не разрывает ревизию: одна транзакция хоста меняет несколько строк под одной ревизией, и станция, запомнившая `rev`, иначе пропустила бы остаток. Попутно — отложенное из 1b1:

- ревизии без видимых станции строк (офисные пользователи, счётчики SSCC) не оставляют станцию позади: без новых записей ответ всё равно несёт текущую ревизию;
- соль бейджей отдаётся в каноническом base64 с выравниванием.

**Files:**

- Create: `apps/standalone/host/migrations/0006_change_feed.sql`, `apps/standalone/host/src/routes/changes.rs`, `apps/standalone/host/tests/changes.rs`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/{server,error}.rs`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`; Create: `apps/standalone/proto/fixtures/changes-response.json`
- Modify: `apps/standalone/src/host/protocol.ts`, `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- Consumes: `AuthDevice`, таблицы `org_profile`, `site`, `lines`, `host_revision`.
- Produces:
  - таблица `tombstones(entity, id, rev)`;
  - `markiro_proto::entities::{ORG_PROFILE, SITE, LINES}`;
  - `markiro_proto::{ChangesResponse { host_id, rev: i64, has_more, items }, ChangeItem { entity, id, rev: i64, deleted, data: Option<Value> }, OrgRecord, SiteRecord, LineRecord}`;
  - маршрут `GET /v1/changes?since&limit`;
  - `error::ApiQuery<T>` — `Query<T>`, чьи отказы становятся `validation_failed`;
  - схемы Zod `changeItemSchema`, `changesResponseSchema`, `orgRecordSchema`, `siteRecordSchema`, `lineRecordSchema`.

- [ ] **Step 1: Протокол и фикстура**

В `apps/standalone/proto/src/lib.rs` добавить (например, после `DeviceRecord`):

```rust
/// Entities of the change feed (spec §4.4). Plans 1d and 1e add operators,
/// badges, products, templates and template defaults.
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
}

/// `GET /v1/changes`: reference records changed after `since`, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    /// A device paired with another host stops syncing on a mismatch.
    pub host_id: String,
    /// Apply `items`, remember this revision, and ask again with `since = rev`
    /// while `has_more`. Without more items it is the host's current revision.
    pub rev: i64,
    pub has_more: bool,
    pub items: Vec<ChangeItem>,
}

/// One changed or deleted reference record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    /// One of [`entities`].
    pub entity: String,
    pub id: String,
    pub rev: i64,
    pub deleted: bool,
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`], …); absent
    /// when `deleted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// `data` of an `org_profile` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRecord {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

/// `data` of a `site` item: only what stations use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    /// The site's badge salt: 16 bytes, standard base64 with padding.
    pub badge_salt: String,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
}

/// `data` of a `lines` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRecord {
    pub name: String,
    pub archived: bool,
}
```

Create `apps/standalone/proto/fixtures/changes-response.json`:

```json
{
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "rev": 42,
  "hasMore": false,
  "items": [
    {
      "entity": "lines",
      "id": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      "rev": 40,
      "deleted": false,
      "data": { "name": "Линия 2", "archived": false }
    },
    {
      "entity": "org_profile",
      "id": "1",
      "rev": 41,
      "deleted": false,
      "data": {
        "name": "ООО «Атолл»",
        "inn": null,
        "gln": "4600682000013",
        "gs1Prefixes": ["4600682"],
        "timeZone": "Europe/Moscow"
      }
    },
    {
      "entity": "site",
      "id": "1",
      "rev": 41,
      "deleted": false,
      "data": {
        "badgeSalt": "AAECAwQFBgcICQoLDA0ODw==",
        "boxBlockSize": 2000,
        "palletBlockSize": 200
      }
    },
    { "entity": "lines", "id": "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21", "rev": 42, "deleted": true }
  ]
}
```

В `apps/standalone/proto/tests/fixtures.rs` добавить `ChangesResponse`, `OrgRecord`, `SiteRecord`, `LineRecord` в импорт и тест:

```rust
#[test]
fn the_change_feed_fixture_round_trips_with_typed_records() {
    let changes: ChangesResponse = round_trip("changes-response.json");
    assert_eq!(changes.items.len(), 4);
    let line: LineRecord = serde_json::from_value(changes.items[0].data.clone().unwrap()).unwrap();
    assert_eq!(line, LineRecord { name: "Линия 2".into(), archived: false });
    let org: OrgRecord = serde_json::from_value(changes.items[1].data.clone().unwrap()).unwrap();
    assert_eq!(org.inn, None);
    let site: SiteRecord = serde_json::from_value(changes.items[2].data.clone().unwrap()).unwrap();
    assert_eq!(site.badge_salt.len(), 24);
    assert!(changes.items[3].deleted && changes.items[3].data.is_none());
}
```

В `apps/standalone/src/host/protocol.ts` после `deviceRecordSchema` добавить:

```ts
/** One changed or deleted reference record of `GET /v1/changes`. */
export const changeItemSchema = z.object({
  entity: z.string().min(1),
  id: z.string().min(1),
  rev: z.number().int().nonnegative(),
  deleted: z.boolean(),
  data: z.unknown().optional(),
});
export type ChangeItem = z.infer<typeof changeItemSchema>;

/** `GET /v1/changes`: apply `items`, keep `rev`, ask again while `hasMore`. */
export const changesResponseSchema = z.object({
  hostId: z.uuid(),
  rev: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  items: z.array(changeItemSchema),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/** `data` of an `org_profile` item. */
export const orgRecordSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

/** `data` of a `site` item: the badge salt is standard base64 with padding. */
export const siteRecordSchema = z.object({
  badgeSalt: z.string().min(1),
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
});
export type SiteRecord = z.infer<typeof siteRecordSchema>;

/** `data` of a `lines` item. */
export const lineRecordSchema = z.object({ name: z.string(), archived: z.boolean() });
export type LineRecord = z.infer<typeof lineRecordSchema>;
```

В `apps/standalone/test/protocol.test.ts` добавить новые схемы в импорт и тест:

```ts
it("change feed", () => {
  const changes = changesResponseSchema.parse(fixture("changes-response.json"));
  expect(changes.items).toHaveLength(4);
  expect(lineRecordSchema.parse(changes.items[0]?.data)).toEqual({
    name: "Линия 2",
    archived: false,
  });
  expect(orgRecordSchema.parse(changes.items[1]?.data).inn).toBeNull();
  expect(siteRecordSchema.parse(changes.items[2]?.data).boxBlockSize).toBe(2000);
  expect(changes.items[3]).toMatchObject({ deleted: true });
  expect(changes.items[3]?.data).toBeUndefined();
});
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` и `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: PASS.

- [ ] **Step 2: Тесты ленты (падающие)**

Create `apps/standalone/host/tests/changes.rs`:

```rust
mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{bootstrap, empty, pair_device, request, seed_office_user, with_device, TestApp};

async fn changes(app: &TestApp, key: &str, query: &str) -> (StatusCode, Value) {
    app.send(empty(with_device(request("GET", &format!("/v1/changes{query}")), key)))
        .await
}

/// `(entity, id, rev)` of each item, in the answer's order.
fn keys(body: &Value) -> Vec<(String, String, i64)> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["entity"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
                item["rev"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Insert lines in one transaction at a new revision; returns their ids (in
/// the given order) and the revision.
async fn add_lines(app: &TestApp, names: &[&str]) -> (Vec<String>, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool).await.unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let mut ids = Vec::new();
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(&id)
            .bind(name)
            .bind(name.to_lowercase())
            .bind(rev)
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    (ids, rev)
}

async fn line_ids_by_name(app: &TestApp) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_fresh_host_has_an_empty_feed() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let (status, body) = changes(&app, &key, "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 0, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn after_the_wizard_the_feed_holds_the_organization_the_site_and_the_lines() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let salt: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let mut lines: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM lines")
        .fetch_all(&app.state.pool)
        .await
        .unwrap();
    lines.sort();

    let (status, body) = changes(&app, &key, "?since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut expected: Vec<Value> = lines
        .iter()
        .map(|(id, name)| {
            json!({ "entity": "lines", "id": id, "rev": 1, "deleted": false, "data": { "name": name, "archived": false } })
        })
        .collect();
    expected.push(json!({
        "entity": "org_profile", "id": "1", "rev": 1, "deleted": false,
        "data": { "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow" }
    }));
    expected.push(json!({
        "entity": "site", "id": "1", "rev": 1, "deleted": false,
        "data": { "badgeSalt": STANDARD.encode(&salt), "boxBlockSize": 2000, "palletBlockSize": 200 }
    }));
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 1, "hasMore": false, "items": expected })
    );
    assert_eq!(STANDARD.encode(&salt).len(), 24, "16 bytes, padded");

    let (_, again) = changes(&app, &key, "?since=1").await;
    assert_eq!(again["items"], json!([]));
    assert_eq!(again["rev"], 1);
}

#[tokio::test]
async fn revisions_without_station_records_still_move_the_device_forward() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    seed_office_user(&app, "tech", "technologist", "technologist password").await;

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 2, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn a_page_never_splits_a_revision() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;

    // Revision 1 has four records (two lines, the organization, the site),
    // more than a page of two: it comes whole.
    let (_, body) = changes(&app, &key, "?since=0&limit=2").await;
    assert_eq!(keys(&body).len(), 4);
    assert_eq!((body["rev"].clone(), body["hasMore"].clone()), (json!(1), json!(true)));
    let (_, body) = changes(&app, &key, "?since=1&limit=2").await;
    assert_eq!((body["items"].clone(), body["rev"].clone(), body["hasMore"].clone()), (json!([]), json!(1), json!(false)));

    let (a, rev_a) = add_lines(&app, &["Линия A"]).await;
    let (bc, rev_bc) = add_lines(&app, &["Линия B", "Линия C"]).await;
    let mut bc_sorted = bc.clone();
    bc_sorted.sort();

    // A page boundary inside revision `rev_bc` stops before it.
    let (_, body) = changes(&app, &key, "?since=1&limit=2").await;
    assert_eq!(keys(&body), vec![("lines".to_owned(), a[0].clone(), rev_a)]);
    assert_eq!((body["rev"].clone(), body["hasMore"].clone()), (json!(rev_a), json!(true)));
    // A boundary between revisions keeps the page full.
    let (_, body) = changes(&app, &key, "?since=1&limit=1").await;
    assert_eq!(keys(&body), vec![("lines".to_owned(), a[0].clone(), rev_a)]);
    assert_eq!((body["rev"].clone(), body["hasMore"].clone()), (json!(rev_a), json!(true)));
    // The rest fits: no more pages, and `rev` is the host's current revision.
    let (_, body) = changes(&app, &key, &format!("?since={rev_a}&limit=2")).await;
    assert_eq!(
        keys(&body),
        bc_sorted.iter().map(|id| ("lines".to_owned(), id.clone(), rev_bc)).collect::<Vec<_>>()
    );
    assert_eq!((body["rev"].clone(), body["hasMore"].clone()), (json!(rev_bc), json!(false)));
}

#[tokio::test]
async fn archived_lines_stay_and_deleted_records_come_as_tombstones() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids_by_name(&app).await;

    let mut tx = markiro_host::db::begin_write(&app.state.pool).await.unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE lines SET archived = 1, rev = ? WHERE id = ?")
        .bind(rev)
        .bind(&lines[0])
        .execute(&mut *tx)
        .await
        .unwrap();
    let gone = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    sqlx::query("INSERT INTO tombstones (entity, id, rev) VALUES ('lines', ?, ?)")
        .bind(gone)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (_, body) = changes(&app, &key, "?since=1").await;
    let mut expected = vec![
        json!({ "entity": "lines", "id": lines[0], "rev": rev, "deleted": false, "data": { "name": "Линия 1", "archived": true } }),
        json!({ "entity": "lines", "id": gone, "rev": rev, "deleted": true }),
    ];
    expected.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    assert_eq!(body["items"], Value::Array(expected));
}

#[tokio::test]
async fn the_feed_checks_its_query() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    for (query, field) in [("?since=-1", "since"), ("?limit=0", "limit"), ("?limit=1001", "limit")] {
        let (status, body) = changes(&app, &key, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(body["error"]["code"], "validation_failed");
        assert_eq!(body["error"]["details"]["field"], field, "{query}");
    }
    let (status, body) = changes(&app, &key, "?since=abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
}

#[tokio::test]
async fn the_feed_needs_a_device_key_but_no_office_session() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: FAIL — маршрута `/v1/changes` нет; также ошибка компиляции на таблице `tombstones` не возникнет, но запрос к ней упадёт — тест упадёт на 404.

- [ ] **Step 3: Миграция, `ApiQuery` и обработчик**

Create `apps/standalone/host/migrations/0006_change_feed.sql`:

```sql
-- Deleted reference records, so devices syncing the change feed learn about
-- deletions (spec §4.4). One row per deleted record; a re-deletion moves it
-- to the newer revision.
CREATE TABLE tombstones (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
CREATE INDEX tombstones_rev ON tombstones (rev);
CREATE INDEX lines_rev ON lines (rev);
```

В `apps/standalone/host/src/error.rs`:

- импорт `use axum::extract::{FromRequest, FromRequestParts, Path, Request};` → `use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request};`;
- в конец файла добавить:

```rust
/// `Query<T>` whose rejections become `validation_failed`.
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}
```

Create `apps/standalone/host/src/routes/changes.rs`:

```rust
//! The change feed (spec §4.4): `GET /v1/changes` returns reference records
//! changed after a device's revision, in pages that never split a revision.
//! Adding an entity means a branch in `FEED_KEYS` and in `record`, its proto
//! record type, Zod schema and fixture, and a tombstone wherever it is deleted.

use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{entities, ChangeItem, ChangesResponse, LineRecord, OrgRecord, SiteRecord};
use serde::Deserialize;
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiQuery};
use crate::server::AppState;

pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 1000;

/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT entity, id, rev, 1 FROM tombstones WHERE rev > ?1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangesQuery {
    since: Option<i64>,
    limit: Option<u32>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Key {
    entity: String,
    id: String,
    rev: i64,
    deleted: bool,
}

struct Page {
    keys: Vec<Key>,
    /// The last revision the page holds completely; `None` when nothing
    /// more follows, so the answer carries the host's current revision.
    more_after: Option<i64>,
}

pub async fn changes(
    State(state): State<AppState>,
    _device: AuthDevice,
    ApiQuery(query): ApiQuery<ChangesQuery>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let since = query.since.unwrap_or(0);
    if since < 0 {
        return Err(ApiError::validation("since", "since is a revision: 0 or more"));
    }
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::validation("limit", "1-1000 items per page"));
    }
    // One read transaction: the records and the current revision come from
    // one WAL snapshot, so a concurrent write cannot slip between them.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let current: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let page = page(&mut tx, since, limit).await?;
    let mut items = Vec::with_capacity(page.keys.len());
    for key in &page.keys {
        items.push(item(&mut tx, key).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(ChangesResponse {
        host_id: state.host_id.clone(),
        rev: page.more_after.unwrap_or(current),
        has_more: page.more_after.is_some(),
        items,
    }))
}

/// Up to `limit` keys after `since`, cut only between revisions. When one
/// revision alone is larger than a page, it comes whole.
async fn page(conn: &mut SqliteConnection, since: i64, limit: u32) -> Result<Page, ApiError> {
    let limit = usize::try_from(limit).map_err(ApiError::internal)?;
    let fetched: Vec<Key> = sqlx::query_as(&format!("{FEED_KEYS} ORDER BY rev, entity, id LIMIT ?2"))
        .bind(since)
        .bind(i64::try_from(limit + 1).map_err(ApiError::internal)?)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if fetched.len() <= limit {
        return Ok(Page {
            keys: fetched,
            more_after: None,
        });
    }
    let last = fetched[limit - 1].rev;
    if fetched[limit].rev != last {
        let mut keys = fetched;
        keys.truncate(limit);
        return Ok(Page {
            keys,
            more_after: Some(last),
        });
    }
    // The limit falls inside revision `last`: stop before it...
    let whole: Vec<Key> = fetched
        .into_iter()
        .take(limit)
        .filter(|key| key.rev < last)
        .collect();
    if let Some(end) = whole.last().map(|key| key.rev) {
        return Ok(Page {
            keys: whole,
            more_after: Some(end),
        });
    }
    // ...unless that revision alone fills the page: send all of it.
    let keys: Vec<Key> = sqlx::query_as(&format!(
        "SELECT entity, id, rev, deleted FROM ({FEED_KEYS}) WHERE rev = ?2 ORDER BY entity, id"
    ))
    .bind(since)
    .bind(last)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Page {
        keys,
        more_after: Some(last),
    })
}

async fn item(conn: &mut SqliteConnection, key: &Key) -> Result<ChangeItem, ApiError> {
    let data = if key.deleted {
        None
    } else {
        Some(record(conn, key).await?)
    };
    Ok(ChangeItem {
        entity: key.entity.clone(),
        id: key.id.clone(),
        rev: key.rev,
        deleted: key.deleted,
        data,
    })
}

/// The live record behind a feed key, as its proto record type.
async fn record(conn: &mut SqliteConnection, key: &Key) -> Result<serde_json::Value, ApiError> {
    let value = match key.entity.as_str() {
        entities::ORG_PROFILE => {
            let (name, inn, gln, gs1_prefixes, time_zone): (String, Option<String>, String, String, String) =
                sqlx::query_as(
                    "SELECT name, inn, gln, gs1_prefixes, time_zone FROM org_profile WHERE id = 1",
                )
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            serde_json::to_value(OrgRecord {
                name,
                inn,
                gln,
                gs1_prefixes: serde_json::from_str(&gs1_prefixes).map_err(ApiError::internal)?,
                time_zone,
            })
        }
        entities::SITE => {
            let (badge_salt, box_block_size, pallet_block_size): (Vec<u8>, i64, i64) =
                sqlx::query_as(
                    "SELECT badge_salt, box_block_size, pallet_block_size FROM site WHERE id = 1",
                )
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            serde_json::to_value(SiteRecord {
                badge_salt: STANDARD.encode(badge_salt),
                box_block_size: u32::try_from(box_block_size).map_err(ApiError::internal)?,
                pallet_block_size: u32::try_from(pallet_block_size).map_err(ApiError::internal)?,
            })
        }
        entities::LINES => {
            let (name, archived): (String, bool) =
                sqlx::query_as("SELECT name, archived FROM lines WHERE id = ?")
                    .bind(&key.id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
            serde_json::to_value(LineRecord { name, archived })
        }
        other => return Err(ApiError::internal(format!("no feed record type for {other}"))),
    };
    value.map_err(ApiError::internal)
}
```

- В `apps/standalone/host/src/routes/mod.rs` добавить `pub mod changes;` (по алфавиту).
- В `apps/standalone/host/src/server.rs` в `protected_routes()` добавить `.route("/v1/changes", get(crate::routes::changes::changes))`.

Если `sqlx` не выводит `bool` для столбца `deleted` (`0 AS deleted` в `UNION ALL`) или `archived`, объявите поле как `i64` и сравнивайте с `1`. Не меняйте форму ответа; причину запишите в отчёт.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline`
Expected: PASS (7 тестов). Затем все тесты хоста (вне песочницы) — PASS.

- [ ] **Step 4: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check` по изменённым JSON/TS; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `git diff --check`.

```bash
git add apps/standalone/host/migrations/0006_change_feed.sql apps/standalone/host/src/routes/changes.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/error.rs apps/standalone/host/tests/changes.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/changes-response.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
git commit -m "feat(standalone): лента изменений справочников на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Поток изменений — `GET /v1/changes/stream` и оповещение после коммита

Станция держит поток SSE и сразу узнаёт о новой ревизии. Хост:

- первым событием отдаёт текущую ревизию;
- после каждого коммита, поднявшего ревизию, отдаёт новую;
- каждые 15 секунд пишет комментарий-пульс, чтобы соединение не заглохло.

Писатели будят подписчиков только после коммита — через `db::commit_with_revision`. Это отложенный пункт 1b1: устройство, которое сразу пошло за изменениями, уже видит новые строки. При остановке хоста открытые потоки заканчиваются, иначе плавная остановка ждала бы их до аварийного срока.

**Files:**

- Modify: `apps/standalone/host/Cargo.toml`, `apps/standalone/Cargo.lock`
- Modify: `apps/standalone/host/src/{db,server,lib}.rs`, `apps/standalone/host/src/routes/{changes,bootstrap,org,sscc,office_users,office_auth}.rs`
- Create: `apps/standalone/host/tests/changes_stream.rs`
- Modify: `apps/standalone/AGENTS.md` (разделы «Writes» и новый «Change feed»), спецификация §4.5

**Interfaces:**

- Consumes: `routes::changes` (задача 5), `next_revision`, `AuthDevice`, `RunningHost`.
- Produces:
  - `db::commit_with_revision(tx: Transaction<'_, Sqlite>, revisions: &watch::Sender<i64>, rev: i64) -> Result<(), sqlx::Error>`;
  - поля `AppState`:
    - `revisions: Arc<watch::Sender<i64>>`;
    - `stopping: Arc<watch::Sender<bool>>`;
    - `stream_heartbeat: std::time::Duration`;
  - строитель `AppState::with_stream_heartbeat(Duration)`;
  - маршрут `GET /v1/changes/stream`;
  - `replace_password` теперь возвращает новую ревизию: `Result<i64, ApiError>`;
  - `RunningHost::stop` заканчивает открытые потоки: переключает `stopping`, а не одноразовый канал.

- [ ] **Step 1: Зависимость `futures-util`**

В `apps/standalone/host/Cargo.toml` в `[dependencies]` после `base64` добавить:

```toml
futures-util = "=0.3.34"
```

Run: `cargo tree --manifest-path apps/standalone/Cargo.toml -p markiro-host -i futures-util --offline`
Expected: `futures-util v0.3.34`. В `Cargo.lock` новых пакетов нет, меняется только список зависимостей `markiro-host`.

- [ ] **Step 2: Тесты потока (падающие)**

Create `apps/standalone/host/tests/changes_stream.rs`:

```rust
mod support;

use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::StatusCode;
use http_body_util::BodyExt;
use markiro_host::config::HostPaths;
use markiro_host::server::router;
use markiro_host::{start, StartOptions};
use serde_json::{json, Value};
use tower::ServiceExt;
use support::app::{
    bootstrap, empty, json as json_request, pair_device, request, with_device, with_session,
    TestApp, LOOPBACK,
};

/// Open the stream in-process; returns the status, the content type and the body.
async fn open_stream(app: &TestApp, key: &str) -> (StatusCode, String, Body) {
    let response = router(app.state.clone())
        .layer(MockConnectInfo(SocketAddr::from(LOOPBACK)))
        .oneshot(empty(with_device(request("GET", "/v1/changes/stream"), key)))
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (status, content_type, response.into_body())
}

/// The next chunk of the stream as text, within 5 seconds.
async fn next_text(body: &mut Body) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("an event within 5 s")
        .expect("the stream is open")
        .expect("a frame");
    String::from_utf8(frame.into_data().expect("a data frame").to_vec()).unwrap()
}

fn rev_event(rev: i64) -> String {
    format!("event: rev\ndata: {{\"rev\":{rev}}}\n\n")
}

fn org_update(expected_rev: i64) -> Value {
    json!({
        "name": "ООО «Атолл-Юг»",
        "inn": null,
        "gln": "4600682000010",
        "gs1Prefixes": ["4600682"],
        "timeZone": "Europe/Moscow",
        "expectedRev": expected_rev
    })
}

async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_stream_sends_the_current_revision_then_every_new_one() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;

    let (status, content_type, mut body) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/event-stream");
    assert_eq!(next_text(&mut body).await, rev_event(1));

    let (status, org) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{org}");
    assert_eq!(next_text(&mut body).await, rev_event(org["rev"].as_i64().unwrap()));
}

#[tokio::test]
async fn the_stream_sends_a_heartbeat_comment() {
    let mut app = TestApp::new().await;
    app.state = app.state.clone().with_stream_heartbeat(Duration::from_millis(50));
    let (_, key) = pair_device(&app, "station").await;

    let (_, _, mut body) = open_stream(&app, &key).await;
    assert_eq!(next_text(&mut body).await, rev_event(0));
    assert!(next_text(&mut body).await.starts_with(':'), "a comment line keeps the connection alive");
}

#[tokio::test]
async fn the_stream_needs_a_device_key() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes/stream"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

#[tokio::test]
async fn every_revision_bump_wakes_subscribers_after_its_commit() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let latest = || *app.state.revisions.borrow();
    assert_eq!(latest(), 1, "the wizard");

    let (_, org) = app
        .send(json_request(with_session(request("PUT", "/v1/office/org"), &key, &token), org_update(1)))
        .await;
    assert_eq!(latest(), org["rev"].as_i64().unwrap(), "organization");

    let (_, sscc) = app
        .send(empty(with_session(request("GET", "/v1/office/sscc"), &key, &token)))
        .await;
    let (_, sizes) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/sscc/block-sizes"), &key, &token),
            json!({ "boxBlockSize": 1000, "palletBlockSize": 100, "expectedRev": sscc["blockSizesRev"] }),
        ))
        .await;
    assert_eq!(latest(), sizes["blockSizesRev"].as_i64().unwrap(), "block sizes");

    let (_, counter) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/sscc/counters/460068200/0"), &key, &token),
            json!({ "nextSerial": 2000, "expectedRev": 1 }),
        ))
        .await;
    assert_eq!(latest(), counter["rev"].as_i64().unwrap(), "counter");

    let (_, user) = app
        .send(json_request(
            with_session(request("POST", "/v1/office/users"), &key, &token),
            json!({ "login": "tech", "name": "Павел Орлов", "role": "technologist", "password": "technologist password" }),
        ))
        .await;
    assert_eq!(latest(), user["rev"].as_i64().unwrap(), "new user");
    let user_path = format!("/v1/office/users/{}", user["id"].as_str().unwrap());

    let (_, updated) = app
        .send(json_request(
            with_session(request("PUT", &user_path), &key, &token),
            json!({ "name": "Павел Орлов-Старший", "role": "technologist", "active": true, "expectedRev": user["rev"] }),
        ))
        .await;
    assert_eq!(latest(), updated["rev"].as_i64().unwrap(), "user update");

    let (status, _) = app
        .send(json_request(
            with_session(request("PUT", &format!("{user_path}/password")), &key, &token),
            json!({ "password": "another long password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(latest(), host_revision(&app).await, "password set by the administrator");

    let (status, _) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            json!({ "currentPassword": "correct horse battery", "newPassword": "a brand new admin password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(latest(), host_revision(&app).await, "own password change");
}

#[tokio::test]
async fn open_streams_end_when_the_host_stops() {
    let dir = tempfile::tempdir().unwrap();
    let host = start(
        &HostPaths::new(dir.path()),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap();
    let client = support::pinned_client(&host.fingerprint);
    let base = format!("https://{}", host.addr);
    let paired: Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(markiro_proto::PROTOCOL_HEADER, "1")
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = paired["deviceKey"].as_str().unwrap().to_owned();
    let mut stream = client
        .get(format!("{base}/v1/changes/stream"))
        .header(markiro_proto::PROTOCOL_HEADER, "1")
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), 200);
    let first = stream.chunk().await.unwrap().expect("the first event");
    assert_eq!(String::from_utf8(first.to_vec()).unwrap(), rev_event(0));

    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(5), host.stop())
        .await
        .expect("the host stops without waiting for the stream")
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        !matches!(stream.chunk().await, Ok(Some(_))),
        "the stream ended with the host"
    );
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline`
Expected: ошибка компиляции — нет `with_stream_heartbeat` и `revisions` у `AppState`.

- [ ] **Step 3: `commit_with_revision` и поля `AppState`**

В `apps/standalone/host/src/db.rs`:

- добавить `use tokio::sync::watch;`;
- в конец файла:

```rust
/// Commit a write transaction that moved the global revision to `rev`, then
/// wake change-stream subscribers. Notifying only after the commit means a
/// device that reacts at once already reads the new rows.
pub async fn commit_with_revision(
    tx: Transaction<'_, Sqlite>,
    revisions: &watch::Sender<i64>,
    rev: i64,
) -> Result<(), sqlx::Error> {
    tx.commit().await?;
    revisions.send_if_modified(|latest| {
        if rev > *latest {
            *latest = rev;
            true
        } else {
            false
        }
    });
    Ok(())
}
```

В `apps/standalone/host/src/server.rs`:

- добавить `use tokio::sync::watch;`;
- в `AppState` добавить поля:

```rust
    /// The newest committed revision; change streams wait on it.
    pub revisions: Arc<watch::Sender<i64>>,
    /// Becomes `true` once when the host stops; open change streams end.
    pub stopping: Arc<watch::Sender<bool>>,
    /// How often a change stream writes a comment to keep the connection
    /// alive (15 s; tests shorten it).
    pub stream_heartbeat: Duration,
```

- в `AppState::new`:

```rust
            revisions: Arc::new(watch::channel(0).0),
            stopping: Arc::new(watch::channel(false).0),
            stream_heartbeat: Duration::from_secs(15),
```

(`Duration` здесь — `std::time::Duration`, он уже импортирован в `server.rs`);

- в `impl AppState` добавить:

```rust
    /// Change-stream heartbeat interval; tests use a short one.
    pub fn with_stream_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.stream_heartbeat = heartbeat;
        self
    }
```

- в `protected_routes()` добавить `.route("/v1/changes/stream", get(crate::routes::changes::stream))`.

- [ ] **Step 4: Писатели — через `commit_with_revision`**

`grep -n "next_revision" apps/standalone/host/src/routes/*.rs` находит все транзакции, которые поднимают ревизию. Каждую из них закончить через `commit_with_revision` вместо `tx.commit()`:

1. `routes/bootstrap.rs`: импорт `use crate::db::{begin_write, commit_with_revision, next_revision};`; в конце обработчика `tx.commit().await.map_err(ApiError::internal)?;` → `commit_with_revision(tx, &state.revisions, rev).await.map_err(ApiError::internal)?;`.
2. `routes/org.rs` (`put_org`): так же с `rev`.
3. `routes/sscc.rs`: в `put_counter` и `put_block_sizes` — с `new_rev` (коммит успешной ветки; ветки «без изменений» ничего не коммитят и не меняются).
4. `routes/office_users.rs`:
   - `create_user` и `update_user` — с `rev`;
   - `replace_password` вернуть новую ревизию: сигнатура `-> Result<i64, ApiError>`, после записи в журнал `Ok(rev)`. Для этого завершите `audit::record(…).await.map_err(ApiError::internal)?;` и добавьте `Ok(rev)`;
   - `set_password`: `let rev = replace_password(…).await?;`, затем `commit_with_revision(tx, &state.revisions, rev)`.
5. `routes/office_auth.rs` (`change_password`): `let rev = replace_password(…).await?;` и `commit_with_revision(tx, &state.revisions, rev)`.

После правок: `grep -n "tx.commit()" apps/standalone/host/src/routes/{bootstrap,org,sscc,office_users,office_auth}.rs` находит только транзакции без `next_revision`: вход, выход, отказы с записью в журнал.

- [ ] **Step 5: Обработчик потока и остановка**

В `apps/standalone/host/src/routes/changes.rs`:

- импорты дополнить:

```rust
use std::convert::Infallible;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use futures_util::stream::unfold;
use serde_json::json;
```

- в конец файла добавить:

```rust
/// `GET /v1/changes/stream`: server-sent events. The first `rev` event
/// carries the current revision, then one follows every commit that moved
/// it; a comment line every heartbeat keeps the connection alive. The stream
/// ends when the host stops.
pub async fn stream(
    State(state): State<AppState>,
    _device: AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    // Subscribe before reading the current revision: a commit in between
    // then shows up as one more event instead of being missed.
    let revisions = state.revisions.subscribe();
    let stopping = state.stopping.subscribe();
    let current: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    let events = unfold(
        (Some(current), revisions, stopping),
        |(first, mut revisions, mut stopping)| async move {
            if let Some(rev) = first {
                return Some((Ok::<_, Infallible>(rev_event(rev)), (None, revisions, stopping)));
            }
            if *stopping.borrow() {
                return None;
            }
            tokio::select! {
                changed = revisions.changed() => {
                    changed.ok()?;
                    let rev = *revisions.borrow_and_update();
                    Some((Ok(rev_event(rev)), (None, revisions, stopping)))
                }
                _ = stopping.wait_for(|stopping| *stopping) => None,
            }
        },
    );
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(state.stream_heartbeat)))
}

fn rev_event(rev: i64) -> Event {
    Event::default()
        .event("rev")
        .data(json!({ "rev": rev }).to_string())
}
```

В `apps/standalone/host/src/lib.rs`:

- в `RunningHost` поле `shutdown: tokio::sync::oneshot::Sender<()>,` заменить на `stopping: std::sync::Arc<tokio::sync::watch::Sender<bool>>,`;
- в `RunningHost::stop` строку `let _ = self.shutdown.send(());` заменить на `self.stopping.send_replace(true);`;
- в `start` строки с `let (shutdown, shutdown_signal) = tokio::sync::oneshot::channel::<()>();` и `spawn(server::serve(listener, state, async move { let _ = shutdown_signal.await; }))` заменить на:

```rust
    let stopping = state.stopping.clone();
    let mut stopped = state.stopping.subscribe();
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = stopped.wait_for(|stopping| *stopping).await;
    }));
```

(объявление `state` должно стоять до этих строк — перенесите `let state = …` выше, если нужно), а в литерале `RunningHost { … }` поле `shutdown,` заменить на `stopping,`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline` (вне песочницы — последний тест слушает 127.0.0.1)
Expected: PASS (5 тестов). Затем `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы) — все PASS.

- [ ] **Step 6: Документы**

1. `apps/standalone/AGENTS.md`, раздел «Writes»: после пункта про `next_revision` добавить пункт:

```markdown
- A transaction that called `next_revision` commits through
  `db::commit_with_revision`, which wakes change-stream subscribers only
  after the commit: a device that reacts at once already reads the new rows.
```

2. Там же после раздела «Writes» добавить раздел:

```markdown
## Change feed

`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, plus deletions
from `tombstones`. Pages are ordered by `(rev, entity, id)` and never split a
revision; with `hasMore = false`, `rev` is the host's current revision, so
revisions that changed only office data still move a device forward.
`GET /v1/changes/stream` sends the current revision first and then one `rev`
event per commit that moved it, with a comment heartbeat every 15 s; streams
end when the host stops. A new feed entity needs a branch in `FEED_KEYS` and
in `record`, its proto record type, Zod schema and fixture, a tombstone
wherever it is deleted, and the station's local table.
```

3. Спецификация, §4.5, строку таблицы `GET /v1/changes?since=<rev>&limit=<n>` — в колонке назначения `{ rev, hasMore, items: [{ entity, id, rev, deleted, data }] }, по умолчанию 500 записей` заменить на `{ hostId, rev, hasMore, items: [{ entity, id, rev, deleted, data }] }`, по умолчанию 500 записей (не больше 1000); порция не разрывает ревизию; без новых записей `rev` — текущая ревизия хоста`. Строку `GET /v1/changes/stream`дополнить:`первым событием — текущая ревизия; поток заканчивается при остановке хоста`. Затем `node_modules/.bin/prettier --write`на спецификацию и`--check`.

- [ ] **Step 7: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`.

```bash
git add apps/standalone/host/Cargo.toml apps/standalone/Cargo.lock apps/standalone/host/src/db.rs apps/standalone/host/src/server.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/routes/changes.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/src/routes/org.rs apps/standalone/host/src/routes/sscc.rs apps/standalone/host/src/routes/office_users.rs apps/standalone/host/src/routes/office_auth.rs apps/standalone/host/tests/changes_stream.rs apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): поток изменений SSE и оповещение после коммита" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы) — все тесты PASS, без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `git diff --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — зелёные.
- [ ] `node --test tools/ci/test/affected.test.mjs` — зелёный; `node_modules/.bin/prettier --check` по изменённым файлам — чисто.
- [ ] В `Cargo.lock` из новых пакетов — только `if-addrs 0.15.0`.
- [ ] В отчёте отдельно: второй ПК в сети, настоящий обмен кодом и работа SSE через реальную сеть не проверялись — это проверяется вручную после плана 1c3; задание `standalone-windows-build` (перечисление интерфейсов на Windows) не запускалось — для CI нужен push.
