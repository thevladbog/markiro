# План 1b3: страницы офиса — организация, SSCC и пользователи — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в офисе приложения администратор ведёт профиль организации, счётчики и блоки номеров SSCC и офисных пользователей, технолог видит организацию и SSCC только для чтения, а кнопка «Выйти в цех» закрывает сессию офиса.

**Architecture:** страницы офиса ходят на хост только через `session.call` и `session.api` (`HostApi` поверх команды `host_request`), серверное состояние держит `@tanstack/react-query` — отдельный кэш на каждую сессию офиса, без повторов и без обновления по фокусу окна. Каждая запись отправляет `expectedRev` загруженной записи; ответ `stale_revision` предлагает загрузить данные заново. Формы — `react-hook-form` с `zodResolver`, правила полей общие с мастером первого запуска (`src/lib/rules.ts`). Отдельный тест на мок-среде Tauri закрепляет контракт IPC между вебвью и оболочкой.

**Tech Stack:** React 19, react-router 8.3.0, @tanstack/react-query 5.101.4, react-hook-form 7.85.0 + @hookform/resolvers 5.9.1, zod 4.4.3, @markiro/domain, @markiro/ui, Vitest + Testing Library; Rust (Tauri 2.11 с фичей `test` только для тестов).

**Спецификации:** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§4.6 — ошибки, §4.8 — роли, §5.5 — офис, §7 — тесты; этот план закрывает строку 1b раздела 8 вместе с планами 1b1 и 1b2). API хоста — план `docs/superpowers/plans/2026-09-26-standalone-1b1-host-office-api.md`; приложение — план `docs/superpowers/plans/2026-09-26-standalone-1b2-app-first-run-office.md`; оба — вместе с разделами «Отклонения при исполнении».

## Global Constraints

- Решение владельца 2026-09-26: «В цех» закрывает сессию офиса. В шапке офиса одна кнопка «Выйти в цех»: приложение сразу возвращается в цех, забывает токен и в фоне вызывает `POST /v1/office/logout` (ошибка вызова не показывается). Скрытой сессии нет; повторный вход в офис — только по логину и паролю.
- Роли (спецификация §4.8): организация и SSCC — администратор читает и пишет, технолог только читает; офисные пользователи — только администратор (технолог не видит пункт меню и получает «Нет доступа» на маршруте); свой пароль меняют оба.
- Страницы офиса обращаются к хосту только через `session.call((token) => session.api.<метод>(token, …))` — в хуках `useOfficeQuery` и `useOfficeMutation`. `invoke`, `HostClient` и `createHostApi` страницы напрямую не используют.
- `@tanstack/react-query` — точная версия `5.101.4`, как в `apps/admin` и `apps/station`. Один `QueryClient` на сессию офиса (создаётся при монтировании `Office`, `Office` монтируется с `key={session.token}`); `retry: false` для запросов и записей, `refetchOnWindowFocus: false`.
- Каждый `PUT` отправляет `expectedRev` из загруженной записи. Ответ `stale_revision` — предупреждение «Данные изменились…» с кнопкой «Загрузить заново»: запрос повторяется, форма показывает новые данные, правки пользователя отбрасываются. `details.currentRev` не подставляется вместо `expectedRev`.
- Правила форм совпадают с хостом: организация — как в мастере (название 1–200 символов, ИНН пусто/10/12 цифр, GLN 13 цифр с верной контрольной цифрой `hasValidCheckDigit`, префиксы GS1 4–12 цифр, не больше 10, часовой пояс из списка); следующий номер SSCC — целое от текущего `nextSerial` до `maxSerial` включительно; блоки — коробов 1–100 000, паллет 1–10 000; логин `[A-Za-z0-9._-]{3,64}`, имя 1–100 символов после обрезки пробелов, пароль 8–128 символов, роль `admin` или `technologist`.
- Разбор ответов записи: `validation_failed` с известным `details.field` — ошибка под полем «Хост не принял это значение. Проверьте его.»; `conflict` с `details.constraint = login` — «Этот логин уже занят»; `sscc_below_floor` — «Номер должен быть не меньше {{min}}» по `details.minSerial`; `stale_revision` — как выше; остальное — текст по коду (`errorMessageKey`). Ответ `forbidden` на любом запросе офиса перечитывает пользователя (`GET /v1/office/me`), чтобы меню и страницы увидели новую роль.
- Свою запись администратор меняет только в части имени: роль и признак «Может входить в офис» у своей строки заблокированы, пароль себе — только через «Сменить пароль» в шапке. После сохранения своего имени шапка показывает новое имя.
- Сообщения об успехе — `Alert` на странице или в диалоге, не всплывающие уведомления: у `toast` из `@markiro/ui` в этой ветке нет сброса между тестами.
- API хоста и протокол не меняются. Новых Rust-зависимостей нет; разрешено только включить фичу `test` у `tauri` в `[dev-dependencies]` `src-tauri` (задача 1).
- Весь текст интерфейса — через i18n (`src/i18n/ru.json`); отсутствующий ключ роняет тесты. Только компоненты `@markiro/ui`: ESLint запрещает нативные элементы форм в `apps/standalone/src`. Колбэк-свойства компонентов и члены интерфейсов объявляются свойствами функционального типа (`onSaved: (…) => void`), а не методами — этого требует правило `@typescript-eslint/unbound-method`.
- `apps/station` не меняется. Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

- Перед каждым коммитом: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` и `… --all -- --check` (если менялся Rust); `node_modules/.bin/prettier --write <изменённые TS/TSX/JSON/MD-файлы>` и `--check`; `git diff --check`.
- pnpm в песочнице: каждую команду запускайте с `--config.verifyDepsBeforeRun=false` (иначе pnpm сносит `node_modules`). `pnpm add` в песочнице падает `ERR_PNPM_UNEXPECTED_STORE` — запускайте его вне песочницы. `pnpm install` не запускать.
- Cargo — с `--offline`: все крейты уже скачаны. Если cargo просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo`), повторите команду вне песочницы. Тесты, которые слушают 127.0.0.1 (`src-tauri/tests/device.rs`, `src-tauri/tests/ipc.rs`, `host/tests/*.rs`), запускайте вне песочницы.
- Крейт `markiro-standalone` при компиляции встраивает `apps/standalone/dist`: если каталога нет, сначала `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.
- Вебвью читает `@markiro/domain` и `@markiro/ui` из собранного `dist`; в свежем worktree сначала `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Не использовать `git stash`; не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.
- В тестах jsdom у `Modal` из `@markiro/ui` кнопка «×» называется по `closeLabel`; диалоги этого плана передают `closeLabel={t("office.common.close")}` («Закрыть»).

## Файлы

Задачи выполняются по порядку: каждая опирается на имена и типы предыдущих.

```
apps/standalone/src-tauri/Cargo.toml, src-tauri/src/lib.rs, src-tauri/tests/ipc.rs          задача 1
apps/standalone/host/tests/office_auth.rs                                                   задача 1
apps/standalone/src/app/{shell.ts,App.tsx}, test/{shell.test.ts,app.test.tsx}               задачи 2, 3, 5
apps/standalone/src/office/{OfficeShell,OfficeLogin,office-session,Office}.tsx              задачи 2, 3, 5
apps/standalone/package.json, pnpm-lock.yaml                                                задача 3
apps/standalone/src/host/api.ts, test/api.test.ts                                           задача 3
apps/standalone/src/office/{office-query.ts,ChangePasswordDialog.tsx}, test/office-query.test.tsx   задача 3
apps/standalone/test/support/office.tsx, test/office.test.tsx                               задачи 2, 3, 5–7
apps/standalone/src/lib/{rules.ts,time-zones.ts}, src/wizard/*, test/{rules,wizard-form}.test.ts   задача 4
apps/standalone/src/office/{page-state.tsx,form-errors.ts}, test/form-errors.test.ts        задача 5
apps/standalone/src/office/{nav.ts,routes.tsx}                                              задачи 5–7
apps/standalone/src/office/org/OrgProfilePage.tsx, test/org-page.test.tsx                   задача 5
apps/standalone/src/office/sscc/*, test/sscc-page.test.tsx                                  задача 6
apps/standalone/src/office/{RequireRole.tsx,users/*}, test/users-page.test.tsx              задача 7
apps/standalone/src/i18n/ru.json, src/app/shell.css                                         задачи 2–7
apps/standalone/AGENTS.md                                                                   задачи 1–3, 7
apps/standalone/README.md                                                                   задача 7
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md (§5.5)                задача 2
```

---

### Task 1: Контракт IPC на мок-среде Tauri и тесты паролей хоста

До сих пор шов «вебвью ↔ оболочка» проверялся только моками в Vitest и прямыми вызовами `DeviceState` в Rust: имена команд, имя аргумента `officeToken`, форма `{ status, body }` и отказы-строки нигде не проходили через настоящий диспетчер команд Tauri. Окно `tauri dev` в этой среде не открыть, поэтому контракт закрепляет тест на мок-среде Tauri (`tauri::test`), где команды вызываются так же, как их вызывает `invoke` из вебвью.

Вторая часть — три пробела в тестах смены пароля на хосте из итогового ревью 1b2: отказ неверному текущему паролю не должен закрывать сессии; `400` не должен ничего менять; ограничение частоты должно отвечать именно отказом пароля, а не опираться на время жизни сессии.

**Files:**

- Modify: `apps/standalone/src-tauri/Cargo.toml` (`[dev-dependencies]`)
- Modify: `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/tests/ipc.rs`
- Modify: `apps/standalone/AGENTS.md` (раздел «Protocol»)
- Modify: `apps/standalone/host/tests/office_auth.rs`

**Interfaces:**

- Consumes: команды `host_hello`, `device_status`, `host_local_pair`, `host_request`, `device_forget` из `src-tauri/src/lib.rs`; `DeviceState::load(PathBuf)`, `DeviceState::local_pair(&str, &str, &str)`; `markiro_host::{start, RunningHost, StartOptions}`, `markiro_host::config::HostPaths` (как в `src-tauri/tests/device.rs`).
- Produces: `pub fn invoke_handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static` в `markiro_standalone_lib` — список команд оболочки; `run()` регистрирует его, тест гоняет его же.

- [ ] **Step 1: Фича `test` у `tauri` для тестов**

В `apps/standalone/src-tauri/Cargo.toml` в раздел `[dev-dependencies]` добавить строку (остальное не трогать):

```toml
tauri = { version = "2.11", features = ["test"] }
```

Фича `test` у `tauri` 2.11.6 пустая (`test = []`, модуль `tauri::test` и `MockRuntime`), новых крейтов не тянет; при `resolver = "2"` фичи dev-зависимостей не попадают в обычную сборку приложения. Проверка: `git diff --stat apps/standalone/Cargo.lock` после первой сборки тестов — пусто.

- [ ] **Step 2: Написать падающий тест**

Create `apps/standalone/src-tauri/tests/ipc.rs`:

```rust
//! The IPC contract between the webview and the shell, driven through
//! Tauri's mock runtime: command names, argument names (`officeToken`),
//! JSON shapes and bare-string rejections, exactly as `src/host/client.ts`,
//! `src/host/device.ts` and `src/host/probe.ts` send and read them. A real
//! `markiro-host` answers on 127.0.0.1.
//!
//! `host_local_pair` always targets port 45710 (the host on this computer),
//! so these tests pair through `DeviceState` directly and then load the
//! pairing from disk, as the app does at start.

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_standalone_lib::device::DeviceState;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow};

const NAME: &str = "Рабочее место хоста";
const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

/// A host on its own Tokio runtime: the test thread blocks inside each IPC
/// call (`get_ipc_response`) while the host keeps answering on the
/// runtime's workers. Tauri runs async commands on its own runtime.
struct Host {
    runtime: tokio::runtime::Runtime,
    running: RunningHost,
    _dir: tempfile::TempDir,
}

impl Host {
    fn start() -> Self {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let running = runtime
            .block_on(start(
                &HostPaths::new(dir.path()),
                StartOptions {
                    port_override: None,
                    bind: Some("127.0.0.1:0".parse().unwrap()),
                },
            ))
            .unwrap();
        Self {
            runtime,
            running,
            _dir: dir,
        }
    }

    fn address(&self) -> String {
        format!("https://{}", self.running.addr)
    }

    fn stop(self) {
        self.runtime.block_on(self.running.stop()).unwrap();
    }
}

/// The app's own command list on the mock runtime, with `state` managed.
/// The `App` is returned too: it must outlive the webview.
fn mock_app(state: DeviceState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(state)
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// Invokes `command` with `args` as the webview's `invoke` does; a rejection
/// comes back as the JSON value the command rejected with.
fn invoke(webview: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: args.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

/// The arguments `createTauriHostClient` (src/host/client.ts) sends.
fn request(method: &str, path: &str, body: Value, office_token: Option<&str>) -> Value {
    json!({ "method": method, "path": path, "body": body, "officeToken": office_token })
}

#[test]
fn an_unpaired_device_reports_null_and_refuses_host_requests() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));

    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(Value::Null));
    assert_eq!(
        invoke(&webview, "host_request", request("GET", "/v1/device", Value::Null, None)),
        Err(json!("not_paired"))
    );
    // The route allow-list is checked before the pairing state: a pairing
    // route is refused even on an unpaired device.
    assert_eq!(
        invoke(&webview, "host_request", request("POST", "/v1/local-pair", Value::Null, None)),
        Err(json!("invalid_request"))
    );
}

#[test]
fn a_paired_device_reaches_the_host_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    let status = host
        .runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let hello = invoke(&webview, "host_hello", json!({ "address": host.address() })).unwrap();
    assert_eq!(hello["hello"]["product"], "markiro-host");
    assert_eq!(hello["hello"]["initialized"], false);
    assert_eq!(hello["fingerprint"], host.running.fingerprint);

    let device = invoke(&webview, "device_status", json!({})).unwrap();
    let mut keys: Vec<&str> = device
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["deviceId", "fingerprint", "hostAddress", "hostId", "kind", "lineId"]
    );
    assert_eq!(device["deviceId"], status.device_id);
    assert_eq!(device["hostAddress"], host.address());

    // A method outside GET/POST/PUT/DELETE is refused by the paired client.
    assert_eq!(
        invoke(&webview, "host_request", request("PATCH", "/v1/device", Value::Null, None)),
        Err(json!("invalid_request"))
    );

    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = invoke(
        &webview,
        "host_request",
        request("POST", "/v1/bootstrap", bootstrap.clone(), None),
    )
    .unwrap();
    assert_eq!(created["status"], 200);
    let token = created["body"]["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    // `officeToken` reaches the host as the office session header.
    let me = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/office/me", Value::Null, Some(&token)),
    )
    .unwrap();
    assert_eq!(me["status"], 200);
    assert_eq!(me["body"]["login"], bootstrap["admin"]["login"]);

    // An error status is still an answer: `{ status, body }` with the error body.
    let anonymous = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/office/me", Value::Null, None),
    )
    .unwrap();
    assert_eq!(anonymous["status"], 401);
    assert_eq!(anonymous["body"]["error"]["code"], "unauthorized");
    assert_eq!(anonymous["body"]["error"]["details"]["credential"], "session");

    // A 204 comes back with a null body, which `client.ts` parses as `null`.
    let logout = invoke(
        &webview,
        "host_request",
        request("POST", "/v1/office/logout", Value::Null, Some(&token)),
    )
    .unwrap();
    assert_eq!(logout, json!({ "status": 204, "body": null }));

    drop(webview);
    host.stop();
}
```

- [ ] **Step 3: Запустить и убедиться, что тест не собирается**

Run (вне песочницы — тест слушает 127.0.0.1): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline`
Expected: ошибка компиляции `cannot find function invoke_handler in crate markiro_standalone_lib`.

- [ ] **Step 4: Вынести список команд**

В `apps/standalone/src-tauri/src/lib.rs` перед `#[cfg_attr(mobile, tauri::mobile_entry_point)]` добавить:

```rust
/// The shell's commands. `run` registers them; `tests/ipc.rs` drives the
/// same list through Tauri's mock runtime to pin the webview's IPC contract.
pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        host_hello,
        device_status,
        host_local_pair,
        host_request,
        device_forget
    ]
}
```

и в `run()` заменить блок `.invoke_handler(tauri::generate_handler![ … ])` на:

```rust
        .invoke_handler(invoke_handler())
```

- [ ] **Step 5: Запустить тест**

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline`
Expected: `test result: ok. 2 passed`.

Если `get_ipc_response` отвечает отказом доступа (ACL) вместо результата команды, соберите контекст из настоящей конфигурации приложения: `tauri::generate_context!()` вместо `mock_context(noop_assets())` (каталог `apps/standalone/dist` должен существовать) — и запишите это в отчёт.

- [ ] **Step 6: Правило в `AGENTS.md`**

В `apps/standalone/AGENTS.md` в конец раздела «Protocol» добавить абзац:

```markdown
The webview's IPC contract — command names, argument names such as
`officeToken`, the `{ status, body }` answer and bare-string rejections — is
pinned by `src-tauri/tests/ipc.rs` through Tauri's mock runtime. Change it
together with `src/host/client.ts`, `src/host/device.ts` and
`src/host/probe.ts`.
```

- [ ] **Step 7: Тесты паролей хоста**

В `apps/standalone/host/tests/office_auth.rs`:

1. Тест `a_wrong_current_password_changes_nothing`: сразу после строки `let token = login(&app, &key, "tech", "correct horse battery").await;` добавить вторую сессию того же пользователя на другом устройстве:

```rust
    let (_, other_key) = pair_device(&app, "office").await;
    let other_token = login(&app, &other_key, "tech", "correct horse battery").await;
```

а после проверки `assert_eq!(me.0, StatusCode::OK);` — проверку, что и она жива:

```rust
    let other = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &other_key,
            &other_token,
        )))
        .await;
    assert_eq!(other.0, StatusCode::OK, "a refused change ends no session");
```

2. Тест `the_new_password_is_validated` заменить целиком:

```rust
#[tokio::test]
async fn the_new_password_is_validated() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let tech_id = seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let token = login(&app, &key, "tech", "correct horse battery").await;
    let phc: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let before = host_revision(&app).await;

    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            change("correct horse battery", "short"),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["details"]["field"], "newPassword");
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            json!({ "currentPassword": "correct horse battery", "newPassword": "another long password", "extra": 1 }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");

    // A refused request changes nothing and leaves no audit row.
    let after: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(after, phc);
    assert_eq!(host_revision(&app).await, before);
    assert!(password_audit(&app, "ok").await.is_empty());
    assert!(password_audit(&app, "denied").await.is_empty());
}
```

3. Тест `password_change_attempts_are_rate_limited_and_shared_with_login`: цикл

```rust
    for _ in 0..10 {
        assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
    }
```

заменить на

```rust
    for _ in 0..10 {
        let (status, body) = attempt(LAN).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["details"]["credential"], "password");
    }
```

а последнюю строку теста (`assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);` после `app.clock.advance(…)`) — на

```rust
    let (status, body) = attempt(LAN).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "password");
```

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --offline`
Expected: PASS (код хоста не меняется — тесты закрепляют уже существующее поведение).

- [ ] **Step 8: Проверки и коммит**

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — все тесты PASS (включая `src-tauri/tests/device.rs`).
Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`, `git diff --check`; `git diff --stat apps/standalone/Cargo.lock` — пусто.

```bash
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/AGENTS.md apps/standalone/host/tests/office_auth.rs
git commit -m "test(standalone): контракт IPC на мок-среде Tauri и тесты смены пароля на хосте" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: «Выйти в цех» закрывает сессию офиса

Решение владельца 2026-09-26: на общем ПК-хосте скрытая сессия открывала офис администратора любому, кто нажмёт «Офис» в течение 30 минут. Теперь в шапке офиса одна кнопка «Выйти в цех»: приложение сразу возвращается в цех, забывает токен и в фоне сообщает хосту (`POST /v1/office/logout`). Состояние офиса в оболочке становится объединением «закрыт / вход / открыт» — скрытой сессии в нём нет. Попутно — два пункта итогового ревью 1b2: пометка на экране входа, когда мастер получил `already_initialized`, и `aria-hidden` у глифа темы.

**Files:**

- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/App.tsx`
- Modify: `apps/standalone/src/office/office-session.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/office/OfficeLogin.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/shell.test.ts`, `apps/standalone/test/app.test.tsx`, `apps/standalone/test/office.test.tsx`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes: `shellReducer`, `nextShellView`, `shellActionFor` (`src/app/shell.ts`), `HostApi.officeLogout(token)`.
- Produces:
  - `type OfficeLoginNotice = "session_ended" | "already_initialized"`;
  - `type OfficeState = { kind: "closed" } | { kind: "signing_in"; notice: OfficeLoginNotice | null } | { kind: "open"; session: OfficeSession }`;
  - действия `{ type: "office_requested"; notice?: OfficeLoginNotice }`, `{ type: "office_opened"; session }`, `{ type: "office_closed" }` (действий `office_left` и `logged_out` больше нет);
  - `OfficeSessionValue` без `leave`, с `logout: () => void`;
  - `OfficeLoginProps.notice: OfficeLoginNotice | null`.

- [ ] **Step 1: Тесты автомата оболочки**

В `apps/standalone/test/shell.test.ts`:

1. Тест `"shows the floor, the office sign-in and the office"` заменить на:

```ts
it("shows the floor, the office sign-in and the office", () => {
  expect(nextShellView(paired(), ADDRESS)).toEqual({ kind: "floor" });
  expect(
    nextShellView(paired({ office: { kind: "signing_in", notice: "session_ended" } }), ADDRESS),
  ).toEqual({ kind: "office_login", notice: "session_ended" });
  expect(nextShellView(paired({ office: { kind: "open", session: SESSION } }), ADDRESS)).toEqual({
    kind: "office",
    session: SESSION,
  });
});
```

2. В тесте `"puts a rejected device before everything else"` заменить `office: { visible: true, session: SESSION, notice: null }` на `office: { kind: "open", session: SESSION }`.

3. В `describe("shellReducer")` три теста — `"keeps the session when the office is left and drops it on sign-out"`, `"asks for a new sign-in when its own session ends"`, `"keeps a hidden office hidden when its session ends"` — и тест `"ignores a stale session_ended for a token that is not the current session"` заменить на:

```ts
it("opens the office sign-in, with a note when there is one", () => {
  expect(shellReducer(paired(), { type: "office_requested" }).office).toEqual({
    kind: "signing_in",
    notice: null,
  });
  expect(
    shellReducer(paired(), { type: "office_requested", notice: "already_initialized" }).office,
  ).toEqual({ kind: "signing_in", notice: "already_initialized" });
});

it("drops the session when the office is closed: there is no hidden session", () => {
  const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
  expect(open.office).toEqual({ kind: "open", session: SESSION });
  const closed = shellReducer(open, { type: "office_closed" });
  expect(closed.office).toEqual({ kind: "closed" });
  // Coming back asks for the password again.
  expect(shellReducer(closed, { type: "office_requested" }).office).toEqual({
    kind: "signing_in",
    notice: null,
  });
});

it("asks for a new sign-in when its own session ends", () => {
  const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
  expect(shellReducer(open, { type: "session_ended", token: SESSION.token }).office).toEqual({
    kind: "signing_in",
    notice: "session_ended",
  });
});

it("ignores a stale session_ended for a token that is not the current session", () => {
  const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
  expect(shellReducer(open, { type: "session_ended", token: "some-other-token" })).toEqual(open);
  // A late failure of a session the user already left changes nothing.
  const closed = shellReducer(open, { type: "office_closed" });
  expect(shellReducer(closed, { type: "session_ended", token: SESSION.token })).toEqual(closed);
  expect(shellReducer(paired(), { type: "session_ended", token: SESSION.token })).toEqual(paired());
});
```

4. В тесте `"closes the office for a rejected device and resets after forgetting"` оба ожидания `{ visible: false, session: null, notice: null }` заменить на `{ kind: "closed" }`; в тесте `"ignores a tokened device_rejected for a different session, but an untokened one always applies"` строку `expect(applied.office.visible).toBe(false);` заменить на `expect(applied.office).toEqual({ kind: "closed" });`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL (типы и ожидания старого `OfficeState`).

- [ ] **Step 2: Автомат оболочки без скрытой сессии**

В `apps/standalone/src/app/shell.ts`:

1. Интерфейс `OfficeState` заменить на:

```ts
/** Why the office sign-in shows a note. */
export type OfficeLoginNotice = "session_ended" | "already_initialized";

/**
 * The office: closed (the floor shows), signing in, or open with a session
 * kept only in memory. There is no hidden session: leaving the office ends
 * it (owner decision 2026-09-26), so coming back always asks to sign in.
 */
export type OfficeState =
  | { kind: "closed" }
  | { kind: "signing_in"; notice: OfficeLoginNotice | null }
  | { kind: "open"; session: OfficeSession };
```

2. В `ShellView` вариант `{ kind: "office_login"; notice: "session_ended" | null }` заменить на `{ kind: "office_login"; notice: OfficeLoginNotice | null }`.

3. В `ShellAction` строки `| { type: "office_requested" }`, `| { type: "office_left" }` и `| { type: "logged_out" }` заменить на:

```ts
  | { type: "office_requested"; notice?: OfficeLoginNotice }
  | { type: "office_closed" }
```

(строка `| { type: "office_opened"; session: OfficeSession }` остаётся).

4. `CLOSED_OFFICE` заменить на `const CLOSED_OFFICE: OfficeState = { kind: "closed" };`.

5. В `nextShellView` последние три строки (`if (!state.office.visible) …`, `if (state.office.session) …`, `return { kind: "office_login", … }`) заменить на:

```ts
switch (state.office.kind) {
  case "closed":
    return { kind: "floor" };
  case "signing_in":
    return { kind: "office_login", notice: state.office.notice };
  case "open":
    return { kind: "office", session: state.office.session };
}
```

6. В `shellReducer` ветки `office_requested`, `office_opened`, `office_left`, `logged_out`, `session_ended` и `device_rejected` заменить на:

```ts
    case "office_requested":
      return { ...state, office: { kind: "signing_in", notice: action.notice ?? null } };
    case "office_opened":
      return { ...state, office: { kind: "open", session: action.session } };
    case "office_closed":
      return { ...state, office: CLOSED_OFFICE };
    case "session_ended": {
      // A late failure from a session the user already left or replaced
      // (by leaving the office, or signing back in) must not disturb the
      // current one: only the session that actually ended asks to sign in.
      if (state.office.kind !== "open" || state.office.session.token !== action.token) {
        return state;
      }
      return { ...state, office: { kind: "signing_in", notice: "session_ended" } };
    }
    case "device_rejected": {
      // A tokened rejection (from an in-flight `call`) only applies to the
      // session that issued it, so a late answer from a superseded session
      // cannot mark a fresh pairing rejected. An untokened rejection (from
      // sign-in or the wizard, where no session exists yet) always applies.
      if (
        action.token !== undefined &&
        (state.office.kind !== "open" || state.office.session.token !== action.token)
      ) {
        return state;
      }
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE };
    }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: PASS.

- [ ] **Step 3: Тесты приложения и офиса**

В `apps/standalone/test/app.test.tsx`:

1. В тесте `"pairs with an initialized host and opens the office from the floor"` заменить `screen.getByRole("button", { name: "Выйти" })` на `screen.getByRole("button", { name: "Выйти в цех" })`.
2. Тест `"keeps the session when going back to the floor"` заменить на два теста:

```ts
it("ends the session when leaving the office, so coming back asks to sign in", async () => {
  const host = fakeHost();
  renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
  fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
  expect(await screen.findByText("Цех")).toBeTruthy();
  expect(host.officeLogout).toHaveBeenCalledTimes(1);
  expect(host.officeLogout).toHaveBeenCalledWith("office-session-token");

  fireEvent.click(screen.getByRole("button", { name: "Офис" }));
  expect(await screen.findByText("Вход в офис")).toBeTruthy();
  expect(host.officeLogin).toHaveBeenCalledTimes(1);
});

it("returns to the floor even when the host cannot be told about leaving", async () => {
  const host = fakeHost();
  host.officeLogout.mockRejectedValueOnce(
    new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
  );
  renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
  fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
  expect(await screen.findByText("Цех")).toBeTruthy();
  expect(
    screen.queryByText("Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена."),
  ).toBeNull();
});
```

3. В тесте `"recovers from a reinstalled host: rejects, reconnects, re-pairs and reaches the floor"` из комментария убрать слова «, or a database restored from a copy» (итоговое ревью 1b2): восстановленная из копии база сохраняет `hostId` и сертификат, это случай «ключ отклонён», а не «хост сменился». Комментарий должен кончаться на «(a reinstall).».
4. Добавить тест (рядом с другими тестами мастера):

```ts
it("sends the wizard to the office sign-in when the host was set up meanwhile", async () => {
  const host = fakeHost();
  host.bootstrap.mockRejectedValueOnce(
    new HostError({
      kind: "api",
      code: "already_initialized",
      status: 409,
      message: "the host is already initialized",
    }),
  );
  renderApp({ probe: probeAnswering(false), device: fakeDevice(null), host });
  await completeWizard();
  expect(await screen.findByText("Вход в офис")).toBeTruthy();
  expect(screen.getByText("Хост уже настроен. Войдите в офис.")).toBeTruthy();
});
```

В `apps/standalone/test/office.test.tsx`:

1. В `sessionFor` удалить строку `leave: vi.fn(),` и заменить `logout: vi.fn(async () => {}),` на `logout: vi.fn(),`.
2. Тест `"goes back to the floor and signs out from the header"` заменить на:

```ts
it("leaves for the floor from the header, ending the session", async () => {
  const session = sessionFor();
  renderOffice(session);
  fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
  expect(session.logout).toHaveBeenCalledTimes(1);
  // One way out: no button that would hide the office and keep the session.
  expect(screen.queryByRole("button", { name: "В цех" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
});
```

3. В `describe("OfficeLogin")` добавить:

```ts
  it("says the host was already set up when the wizard found it initialized", () => {
    render(<OfficeLogin notice="already_initialized" onLogin={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("Хост уже настроен. Войдите в офис.")).toBeTruthy();
  });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/office.test.tsx`
Expected: FAIL (нет кнопки «Выйти в цех», нет текста пометки).

- [ ] **Step 4: Приложение, шапка и экран входа**

1. `apps/standalone/src/office/office-session.tsx`: в `OfficeSessionValue` удалить член `leave` с его комментарием, а член `logout` заменить на:

```ts
  /**
   * «Выйти в цех»: ends the session at once — back to the floor, the token
   * dropped — and tells the host in the background.
   */
  logout: () => void;
```

2. `apps/standalone/src/app/App.tsx`:
   - в `bootstrap` ветку `already_initialized` заменить на:

```ts
if (error instanceof HostError && error.code === "already_initialized") {
  dispatch({ type: "host_initialized" });
  dispatch({ type: "office_requested", notice: "already_initialized" });
  return;
}
```

- в объекте, который возвращает `useMemo` сессии офиса, удалить `leave` и заменить `logout` на:

```ts
      logout: () => {
        dispatch({ type: "office_closed" });
        // The token is already gone from this device; if the host cannot be
        // told now, it expires the session on its own after 30 idle minutes.
        void hostApi.officeLogout(session.token).catch(() => undefined);
      },
```

- у `OfficeLogin` заменить `onBack={() => dispatch({ type: "office_left" })}` на `onBack={() => dispatch({ type: "office_closed" })}`.

3. `apps/standalone/src/office/OfficeLogin.tsx`: добавить `import type { OfficeLoginNotice } from "../app/shell.js";`, в `OfficeLoginProps` заменить `notice: "session_ended" | null;` на `notice: OfficeLoginNotice | null;`, над компонентом добавить

```ts
const NOTICE_TEXT: Readonly<Record<OfficeLoginNotice, string>> = {
  session_ended: "office.login.sessionEnded",
  already_initialized: "office.login.alreadyInitialized",
};
```

и строку `{notice === "session_ended" && <Alert tone="info">{t("office.login.sessionEnded")}</Alert>}` заменить на `{notice && <Alert tone="info">{t(NOTICE_TEXT[notice])}</Alert>}`.

4. `apps/standalone/src/office/OfficeShell.tsx`:
   - удалить кнопку `session.leave` («В цех») целиком;
   - кнопку выхода заменить на `<Button variant="secondary" onClick={session.logout}>{t("office.header.logout")}</Button>`;
   - у `IconButton` темы заменить `icon={dark ? "☀" : "☾"}` на `icon={<span aria-hidden="true">{dark ? "☀" : "☾"}</span>}`.

5. `apps/standalone/src/i18n/ru.json`: в `office.header` удалить `toFloor`, значение `logout` заменить на `"Выйти в цех"`; в `office.login` добавить `"alreadyInitialized": "Хост уже настроен. Войдите в офис."`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx test/office.test.tsx`
Expected: PASS.

- [ ] **Step 5: Документы**

1. `apps/standalone/AGENTS.md`, раздел «Device key and office session»: пункт «The office session token lives only in webview memory. «В цех» hides the office and keeps the session until the host expires it; «Выйти» ends it on the host.» заменить на:

```markdown
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
  tells the host in the background. There is no hidden session (owner
  decision 2026-09-26), so coming back to the office always asks to sign in.
```

2. Спецификация, §5.5, первый пункт: слова «шапка с именем пользователя, переключателем темы, кнопками «В цех» и «Выйти».» заменить на «шапка с именем пользователя, переключателем темы, кнопками «Сменить пароль» и «Выйти в цех» (сессия закрывается сразу — решение владельца 2026-09-26).».

- [ ] **Step 6: Проверки и коммит**

Run: пакетные `test`, `typecheck`, `lint` (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone <скрипт>`) — зелёные; `grep -rn "office_left\|logged_out\|\.leave\b\|toFloor" apps/standalone/src apps/standalone/test` — пусто; `node_modules/.bin/prettier --check` по изменённым файлам; `git diff --check`.

```bash
git add apps/standalone/src/app/shell.ts apps/standalone/src/app/App.tsx apps/standalone/src/office/office-session.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/office/OfficeLogin.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/shell.test.ts apps/standalone/test/app.test.tsx apps/standalone/test/office.test.tsx apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "feat(standalone): «Выйти в цех» закрывает сессию офиса" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Слой данных офиса

Страницам офиса нужен доступ к хосту, который нельзя обойти: каждый запрос идёт через `session.call`, а тот отправляет закончившуюся сессию на вход, отклонённое устройство — на переподключение и перечитывает пользователя при `forbidden`. Задача:

- добавляет в `HostApi` офисные методы;
- кладёт `api` в `OfficeSessionValue`;
- подключает `@tanstack/react-query` с отдельным кэшем на каждую сессию и хуками `useOfficeQuery` и `useOfficeMutation`;
- переводит на них диалог смены пароля.

Попутно — пункты итогового ревью 1b2: тесты веток диалога, закрытие диалога во время отправки, неприлипающее сообщение о смене пароля.

**Files:**

- Modify: `apps/standalone/package.json`, `pnpm-lock.yaml`
- Modify: `apps/standalone/src/host/api.ts`; Create: `apps/standalone/test/api.test.ts`
- Create: `apps/standalone/src/office/office-query.ts`, `apps/standalone/test/office-query.test.tsx`
- Modify: `apps/standalone/src/office/{Office,office-session,ChangePasswordDialog,OfficeShell}.tsx`
- Modify: `apps/standalone/src/app/{shell.ts,App.tsx}`
- Create: `apps/standalone/test/support/office.tsx`
- Test: `apps/standalone/test/{office.test.tsx,app.test.tsx,shell.test.ts}`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: `HostClient.request(method, path, { body?, officeToken?, schema })` (`src/host/client.ts`); схемы `officeUserSchema`, `orgProfileSchema`, `ssccCounterSchema`, `ssccStateSchema`, `officeUserRecordSchema` и типы запросов из `src/host/protocol.ts`; `OfficeState`, `office_closed` (задача 2).
- Produces:
  - `HostApi`: только свойства функционального типа — `bootstrap`, `officeLogin`, `officeLogout`, `officeMe(token) → OfficeUser`, `officeChangePassword`, `getOrg(token) → OrgProfile`, `updateOrg(token, OrgProfileUpdate) → OrgProfile`, `getSscc(token) → SsccState`, `updateSsccCounter(token, { issuerPrefix, extension }, SsccCounterUpdate) → SsccCounter`, `updateBlockSizes(token, BlockSizesUpdate) → SsccState`, `listUsers(token) → OfficeUserRecord[]`, `createUser(token, OfficeUserCreate) → OfficeUserRecord`, `updateUser(token, id, OfficeUserUpdate) → OfficeUserRecord`, `setUserPassword(token, id, PasswordSet) → void`. Плюс тип `SsccCounterKey { issuerPrefix: string; extension: number }`.
  - `OfficeSessionValue { user; api: HostApi; call; logout: () => void; refreshUser: () => Promise<void> }` — `changePassword` удалён.
  - `src/office/office-query.ts`:
    - `officeKeys = { org: ["office", "org"], sscc: ["office", "sscc"], users: ["office", "users"] } as const`;
    - `createOfficeQueryClient(): QueryClient`;
    - `useOfficeQuery<T>(key, read: (api: HostApi, token: string) => Promise<T>): UseQueryResult<T, Error>`;
    - `useOfficeMutation<V, T>(write: (api: HostApi, token: string, variables: V) => Promise<T>): UseMutationResult<T, Error, V>`.
  - Действие оболочки `{ type: "office_user_refreshed"; token: string; user: OfficeUser }`.
  - `test/support/office.tsx`:
    - `type FakeHostApi`, `fakeHostApi(overrides?)`;
    - `type FakeOfficeSession`, `fakeOfficeSession({ user?, api? })`;
    - `renderOffice(session)`;
    - `TECHNOLOGIST: OfficeUser`.

- [ ] **Step 1: Зависимость**

Вне песочницы (в песочнице `pnpm add` падает `ERR_PNPM_UNEXPECTED_STORE`):

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone add @tanstack/react-query@5.101.4 --save-exact
```

Проверить: в `apps/standalone/package.json` в `dependencies` появилась строка `"@tanstack/react-query": "5.101.4"`. В `pnpm-lock.yaml` изменился только импортёр `apps/standalone`, новых пакетов нет: версия уже стоит у `apps/admin` и `apps/station`. Это видно в `git diff --stat pnpm-lock.yaml` и в самом диффе.

- [ ] **Step 2: Написать падающие тесты API**

Create `apps/standalone/test/api.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import { orgProfileUpdateSchema } from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

interface Sent {
  method: HttpMethod;
  path: string;
  body: unknown;
  officeToken: string | undefined;
}

/** A client that records the request and answers `answer`, parsed by the caller's schema. */
function recording(answer: unknown) {
  const sent: Sent[] = [];
  const client: HostClient = {
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body, officeToken: options.officeToken });
      return options.schema.parse(answer);
    },
  };
  return { api: createHostApi(client), sent };
}

const TOKEN = "office-session-token";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ORG_UPDATE = orgProfileUpdateSchema.parse(fixture("org-profile-update.json"));

type Case = [
  name: string,
  answer: unknown,
  run: (api: HostApi) => Promise<unknown>,
  expected: Omit<Sent, "officeToken">,
];

const CASES: Case[] = [
  [
    "officeMe",
    fixture("office-user.json"),
    (api) => api.officeMe(TOKEN),
    { method: "GET", path: "/v1/office/me", body: undefined },
  ],
  [
    "getOrg",
    fixture("org-profile.json"),
    (api) => api.getOrg(TOKEN),
    { method: "GET", path: "/v1/office/org", body: undefined },
  ],
  [
    "updateOrg",
    fixture("org-profile.json"),
    (api) => api.updateOrg(TOKEN, ORG_UPDATE),
    { method: "PUT", path: "/v1/office/org", body: ORG_UPDATE },
  ],
  [
    "getSscc",
    fixture("sscc-state.json"),
    (api) => api.getSscc(TOKEN),
    { method: "GET", path: "/v1/office/sscc", body: undefined },
  ],
  [
    "updateSsccCounter",
    { issuerPrefix: "460068200", extension: 1, nextSerial: 50, maxSerial: 9999999, rev: 7 },
    (api) =>
      api.updateSsccCounter(
        TOKEN,
        { issuerPrefix: "460068200", extension: 1 },
        { nextSerial: 50, expectedRev: 1 },
      ),
    {
      method: "PUT",
      path: "/v1/office/sscc/counters/460068200/1",
      body: { nextSerial: 50, expectedRev: 1 },
    },
  ],
  [
    "updateBlockSizes",
    fixture("sscc-state.json"),
    (api) =>
      api.updateBlockSizes(TOKEN, { boxBlockSize: 1000, palletBlockSize: 100, expectedRev: 1 }),
    {
      method: "PUT",
      path: "/v1/office/sscc/block-sizes",
      body: { boxBlockSize: 1000, palletBlockSize: 100, expectedRev: 1 },
    },
  ],
  [
    "listUsers",
    [fixture("office-user-record.json")],
    (api) => api.listUsers(TOKEN),
    { method: "GET", path: "/v1/office/users", body: undefined },
  ],
  [
    "createUser",
    fixture("office-user-record.json"),
    (api) =>
      api.createUser(TOKEN, {
        login: "tech",
        name: "Павел Орлов",
        role: "technologist",
        password: "technologist password",
      }),
    {
      method: "POST",
      path: "/v1/office/users",
      body: {
        login: "tech",
        name: "Павел Орлов",
        role: "technologist",
        password: "technologist password",
      },
    },
  ],
  [
    "updateUser",
    fixture("office-user-record.json"),
    (api) =>
      api.updateUser(TOKEN, USER_ID, {
        name: "Павел Орлов",
        role: "technologist",
        active: false,
        expectedRev: 3,
      }),
    {
      method: "PUT",
      path: `/v1/office/users/${USER_ID}`,
      body: { name: "Павел Орлов", role: "technologist", active: false, expectedRev: 3 },
    },
  ],
  [
    "setUserPassword",
    null,
    (api) => api.setUserPassword(TOKEN, USER_ID, { password: "a new long password" }),
    {
      method: "PUT",
      path: `/v1/office/users/${USER_ID}/password`,
      body: { password: "a new long password" },
    },
  ],
];

describe("HostApi office endpoints", () => {
  it.each(CASES)(
    "%s sends the office token to the right route",
    async (_name, answer, run, expected) => {
      const { api, sent } = recording(answer);
      await run(api);
      expect(sent).toEqual([{ ...expected, officeToken: TOKEN }]);
    },
  );

  it("returns the parsed answer", async () => {
    const { api } = recording(fixture("sscc-state.json"));
    await expect(api.getSscc(TOKEN)).resolves.toMatchObject({
      currentIssuerPrefix: "460068200",
      blockSizesRev: 1,
    });
  });

  it("rejects a users answer that is not a list", async () => {
    const { api } = recording(fixture("office-user-record.json"));
    await expect(api.listUsers(TOKEN)).rejects.toThrow();
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts`
Expected: FAIL — `api.officeMe is not a function` и так далее.

- [ ] **Step 3: Офисные методы `HostApi`**

Replace `apps/standalone/src/host/api.ts` целиком:

```ts
import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  officeSessionSchema,
  officeUserRecordSchema,
  officeUserSchema,
  orgProfileSchema,
  ssccCounterSchema,
  ssccStateSchema,
  type BlockSizesUpdate,
  type BootstrapRequest,
  type BootstrapResponse,
  type OfficeLoginRequest,
  type OfficeSession,
  type OfficeUser,
  type OfficeUserCreate,
  type OfficeUserRecord,
  type OfficeUserUpdate,
  type OrgProfile,
  type OrgProfileUpdate,
  type PasswordChange,
  type PasswordSet,
  type SsccCounter,
  type SsccCounterUpdate,
  type SsccState,
} from "./protocol.js";

/** An SSCC counter's address: its issuer prefix and extension digit (0 box, 1 pallet). */
export interface SsccCounterKey {
  issuerPrefix: string;
  extension: number;
}

/**
 * Host endpoints over `host_request`. Office screens reach them only through
 * `OfficeSessionValue.call`, so an ended session or a rejected device is
 * routed to the shell. Members are function-typed properties, not methods,
 * so they can be passed around unbound (`@typescript-eslint/unbound-method`).
 */
export interface HostApi {
  bootstrap: (request: BootstrapRequest) => Promise<BootstrapResponse>;
  officeLogin: (request: OfficeLoginRequest) => Promise<OfficeSession>;
  officeLogout: (token: string) => Promise<void>;
  officeMe: (token: string) => Promise<OfficeUser>;
  officeChangePassword: (token: string, request: PasswordChange) => Promise<void>;
  getOrg: (token: string) => Promise<OrgProfile>;
  updateOrg: (token: string, update: OrgProfileUpdate) => Promise<OrgProfile>;
  getSscc: (token: string) => Promise<SsccState>;
  updateSsccCounter: (
    token: string,
    counter: SsccCounterKey,
    update: SsccCounterUpdate,
  ) => Promise<SsccCounter>;
  updateBlockSizes: (token: string, update: BlockSizesUpdate) => Promise<SsccState>;
  listUsers: (token: string) => Promise<OfficeUserRecord[]>;
  createUser: (token: string, create: OfficeUserCreate) => Promise<OfficeUserRecord>;
  updateUser: (token: string, id: string, update: OfficeUserUpdate) => Promise<OfficeUserRecord>;
  setUserPassword: (token: string, id: string, request: PasswordSet) => Promise<void>;
}

/** A 204 answer parses as `null`. */
const NO_CONTENT = z.null();

export function createHostApi(client: HostClient): HostApi {
  return {
    bootstrap: (request) =>
      client.request("POST", "/v1/bootstrap", { body: request, schema: bootstrapResponseSchema }),
    officeLogin: (request) =>
      client.request("POST", "/v1/office/login", { body: request, schema: officeSessionSchema }),
    officeLogout: async (token) => {
      await client.request("POST", "/v1/office/logout", {
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    officeMe: (token) =>
      client.request("GET", "/v1/office/me", { officeToken: token, schema: officeUserSchema }),
    officeChangePassword: async (token, request) => {
      await client.request("PUT", "/v1/office/me/password", {
        body: request,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
    getOrg: (token) =>
      client.request("GET", "/v1/office/org", { officeToken: token, schema: orgProfileSchema }),
    updateOrg: (token, update) =>
      client.request("PUT", "/v1/office/org", {
        body: update,
        officeToken: token,
        schema: orgProfileSchema,
      }),
    getSscc: (token) =>
      client.request("GET", "/v1/office/sscc", { officeToken: token, schema: ssccStateSchema }),
    updateSsccCounter: (token, { issuerPrefix, extension }, update) =>
      client.request("PUT", `/v1/office/sscc/counters/${issuerPrefix}/${extension}`, {
        body: update,
        officeToken: token,
        schema: ssccCounterSchema,
      }),
    updateBlockSizes: (token, update) =>
      client.request("PUT", "/v1/office/sscc/block-sizes", {
        body: update,
        officeToken: token,
        schema: ssccStateSchema,
      }),
    listUsers: (token) =>
      client.request("GET", "/v1/office/users", {
        officeToken: token,
        schema: z.array(officeUserRecordSchema),
      }),
    createUser: (token, create) =>
      client.request("POST", "/v1/office/users", {
        body: create,
        officeToken: token,
        schema: officeUserRecordSchema,
      }),
    updateUser: (token, id, update) =>
      client.request("PUT", `/v1/office/users/${id}`, {
        body: update,
        officeToken: token,
        schema: officeUserRecordSchema,
      }),
    setUserPassword: async (token, id, request) => {
      await client.request("PUT", `/v1/office/users/${id}/password`, {
        body: request,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
  };
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 4: Поддержка тестов офиса**

Create `apps/standalone/test/support/office.tsx`:

```tsx
import { render } from "@testing-library/react";
import { vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../../src/host/api.js";
import type { OfficeUser } from "../../src/host/protocol.js";
import { Office } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import { SESSION } from "./fixtures.js";

/** A `HostApi` of mocks. */
export type FakeHostApi = { [K in keyof HostApi]: Mock<HostApi[K]> };

function unexpected(name: keyof HostApi): Promise<never> {
  return Promise.reject(new Error(`unexpected HostApi.${name} call`));
}

/** Every method a test did not stub fails loudly; `officeLogout` succeeds. */
export function fakeHostApi(overrides: Partial<FakeHostApi> = {}): FakeHostApi {
  return {
    bootstrap: vi.fn<HostApi["bootstrap"]>(() => unexpected("bootstrap")),
    officeLogin: vi.fn<HostApi["officeLogin"]>(() => unexpected("officeLogin")),
    officeLogout: vi.fn<HostApi["officeLogout"]>(async () => undefined),
    officeMe: vi.fn<HostApi["officeMe"]>(() => unexpected("officeMe")),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(() =>
      unexpected("officeChangePassword"),
    ),
    getOrg: vi.fn<HostApi["getOrg"]>(() => unexpected("getOrg")),
    updateOrg: vi.fn<HostApi["updateOrg"]>(() => unexpected("updateOrg")),
    getSscc: vi.fn<HostApi["getSscc"]>(() => unexpected("getSscc")),
    updateSsccCounter: vi.fn<HostApi["updateSsccCounter"]>(() => unexpected("updateSsccCounter")),
    updateBlockSizes: vi.fn<HostApi["updateBlockSizes"]>(() => unexpected("updateBlockSizes")),
    listUsers: vi.fn<HostApi["listUsers"]>(() => unexpected("listUsers")),
    createUser: vi.fn<HostApi["createUser"]>(() => unexpected("createUser")),
    updateUser: vi.fn<HostApi["updateUser"]>(() => unexpected("updateUser")),
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    ...overrides,
  };
}

export type FakeOfficeSession = OfficeSessionValue & {
  api: FakeHostApi;
  logout: Mock<OfficeSessionValue["logout"]>;
  refreshUser: Mock<OfficeSessionValue["refreshUser"]>;
};

/** The session value the shell gives the office; `call` passes the fixture token through. */
export function fakeOfficeSession(
  options: { user?: OfficeUser; api?: FakeHostApi } = {},
): FakeOfficeSession {
  return {
    user: options.user ?? SESSION.user,
    api: options.api ?? fakeHostApi(),
    call: <T,>(operation: (token: string) => Promise<T>) => operation(SESSION.token),
    logout: vi.fn<OfficeSessionValue["logout"]>(),
    refreshUser: vi.fn<OfficeSessionValue["refreshUser"]>(async () => undefined),
  };
}

/** The office as the shell renders it, in the dark theme. */
export function renderOffice(session: OfficeSessionValue) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} />
    </ThemeProvider>,
  );
}

export const TECHNOLOGIST: OfficeUser = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  login: "tech",
  name: "Павел Орлов",
  role: "technologist",
};
```

- [ ] **Step 5: Написать падающие тесты слоя данных**

Create `apps/standalone/test/office-query.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OrgProfile } from "../src/host/protocol.js";
import {
  createOfficeQueryClient,
  officeKeys,
  useOfficeMutation,
  useOfficeQuery,
} from "../src/office/office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "../src/office/office-session.js";
import { fakeOfficeSession } from "./support/office.js";

const PROFILE: OrgProfile = {
  name: "ООО «Атолл»",
  inn: null,
  gln: "4600682000013",
  gs1Prefixes: [],
  timeZone: "Europe/Moscow",
  rev: 4,
};

function wrapperFor(session: OfficeSessionValue) {
  const client = createOfficeQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={session}>{children}</OfficeSessionProvider>
      </QueryClientProvider>
    );
  };
}

describe("useOfficeQuery", () => {
  it("reads through the session's call with its api and token", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(PROFILE);
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.data).toEqual(PROFILE));
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");
  });

  it("does not retry a failed read: the page explains it and offers a retry", async () => {
    const failure = new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
    const session = fakeOfficeSession();
    session.api.getOrg.mockRejectedValue(failure);
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(failure);
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });
});

describe("useOfficeMutation", () => {
  it("writes through the session's call", async () => {
    const session = fakeOfficeSession();
    session.api.updateOrg.mockResolvedValue({ ...PROFILE, rev: 5 });
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () =>
        useOfficeMutation((api, token, expectedRev: number) =>
          api.updateOrg(token, {
            name: PROFILE.name,
            inn: null,
            gln: PROFILE.gln,
            gs1Prefixes: [],
            timeZone: PROFILE.timeZone,
            expectedRev,
          }),
        ),
      { wrapper: wrapperFor(session) },
    );
    await act(async () => {
      await expect(result.current.mutateAsync(4)).resolves.toMatchObject({ rev: 5 });
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.updateOrg).toHaveBeenCalledWith(
      "office-session-token",
      expect.objectContaining({ expectedRev: 4 }),
    );
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office-query.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/office/office-query.js"`.

- [ ] **Step 6: Хуки и кэш на сессию**

Create `apps/standalone/src/office/office-query.ts`:

```ts
import {
  QueryClient,
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { HostApi } from "../host/api.js";
import { useOfficeSession } from "./office-session.js";

/** Query keys of office data, one per host resource. */
export const officeKeys = {
  org: ["office", "org"],
  sscc: ["office", "sscc"],
  users: ["office", "users"],
} as const;

/**
 * One cache per office session: `Office` creates it on mount, and `App`
 * remounts `Office` for every session, so no data outlives its session.
 * A host error is an answer, not a flake: the page explains it and offers
 * a retry, so nothing retries on its own.
 */
export function createOfficeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/** Reads office data through `session.call`. */
export function useOfficeQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string) => Promise<T>,
): UseQueryResult<T, Error> {
  const { api, call } = useOfficeSession();
  return useQuery({ queryKey: key, queryFn: () => call((token) => read(api, token)) });
}

/** Writes office data through `session.call`. */
export function useOfficeMutation<V, T>(
  write: (api: HostApi, token: string, variables: V) => Promise<T>,
): UseMutationResult<T, Error, V> {
  const { api, call } = useOfficeSession();
  return useMutation({
    mutationFn: (variables: V) => call((token) => write(api, token, variables)),
  });
}
```

Replace `apps/standalone/src/office/Office.tsx` целиком:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { createOfficeQueryClient } from "./office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
}

/**
 * The office: an in-memory router (a desktop window has no address bar) and
 * a query cache, both living exactly as long as one session — `App` mounts
 * `Office` with the session token as its key.
 */
export function Office({ session }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  const [queryClient] = useState(createOfficeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={session}>
        <RouterProvider router={router} />
      </OfficeSessionProvider>
    </QueryClientProvider>
  );
}
```

В `apps/standalone/src/office/office-session.tsx` заменить импорт `import type { OfficeUser, PasswordChange } from "../host/protocol.js";` на

```ts
import type { HostApi } from "../host/api.js";
import type { OfficeUser } from "../host/protocol.js";
```

и в `OfficeSessionValue`:

- удалить член `changePassword` с комментарием;
- после `user` добавить член `api`;
- заменить комментарий члена `call`;
- после `logout` добавить член `refreshUser`.

```ts
/**
 * Host endpoints. Office screens reach them only through `call` — via
 * `useOfficeQuery` and `useOfficeMutation` — never directly.
 */
api: HostApi;
/**
 * Runs a host call with the session token. An ended session or a rejected
 * device is routed to the shell before the error is rethrown; `forbidden`
 * also re-reads the user, whose role may have changed on the host.
 */
call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
```

```ts
/** Re-reads the signed-in user (name, role) from the host into the shell. */
refreshUser: () => Promise<void>;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office-query.test.tsx`
Expected: PASS.

- [ ] **Step 7: Оболочка — `api`, `refreshUser` и `forbidden`**

1. `apps/standalone/src/app/shell.ts`: добавить `OfficeUser` в импорт типов из `../host/protocol.js`; в `ShellAction` — строку `| { type: "office_user_refreshed"; token: string; user: OfficeUser }`; в `shellReducer` — ветку:

```ts
    case "office_user_refreshed":
      // Only the session the answer belongs to takes the new name and role.
      if (state.office.kind !== "open" || state.office.session.token !== action.token) {
        return state;
      }
      return {
        ...state,
        office: { kind: "open", session: { ...state.office.session, user: action.user } },
      };
```

2. `apps/standalone/test/shell.test.ts`, в `describe("shellReducer")`:

```ts
it("takes a re-read user only for its own session", () => {
  const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
  const renamed = { ...SESSION.user, name: "Ирина Орлова", role: "technologist" as const };
  expect(
    shellReducer(open, { type: "office_user_refreshed", token: SESSION.token, user: renamed })
      .office,
  ).toEqual({ kind: "open", session: { ...SESSION, user: renamed } });
  expect(
    shellReducer(open, { type: "office_user_refreshed", token: "some-other-token", user: renamed }),
  ).toEqual(open);
  const closed = shellReducer(open, { type: "office_closed" });
  expect(
    shellReducer(closed, { type: "office_user_refreshed", token: SESSION.token, user: renamed }),
  ).toEqual(closed);
});
```

3. `apps/standalone/src/app/App.tsx`: весь `useMemo` сессии офиса (от `const officeSession = useMemo<OfficeSessionValue | null>(() => {` до его `}, [session, hostApi]);`) заменить на:

```tsx
const officeSession = useMemo<OfficeSessionValue | null>(() => {
  if (!session) return null;
  // Scoped to this session's token: a late failure from a session the
  // user already left or replaced must not pull them back into sign-in or
  // mark a fresh pairing rejected.
  const route = (error: unknown): void => {
    const action = shellActionFor(error, session.token);
    if (action) dispatch(action);
  };
  const refreshUser = async (): Promise<void> => {
    try {
      const user = await hostApi.officeMe(session.token);
      dispatch({ type: "office_user_refreshed", token: session.token, user });
    } catch (error) {
      route(error);
      throw error;
    }
  };
  const call = async <T,>(operation: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await operation(session.token);
    } catch (error) {
      route(error);
      if (error instanceof HostError && error.code === "forbidden") {
        // The role changed on the host: read the user again so the menu
        // and the pages follow it. A failure there is routed like any other.
        void refreshUser().catch(() => undefined);
      }
      throw error;
    }
  };
  return {
    user: session.user,
    api: hostApi,
    call,
    refreshUser,
    logout: () => {
      dispatch({ type: "office_closed" });
      // The token is already gone from this device; if the host cannot be
      // told now, it expires the session on its own after 30 idle minutes.
      void hostApi.officeLogout(session.token).catch(() => undefined);
    },
  };
}, [session, hostApi]);

if (session && officeSession) return <Office key={session.token} session={officeSession} />;
```

(строка `if (officeSession) return <Office session={officeSession} />;` заменяется последней строкой этого блока).

4. `apps/standalone/src/office/ChangePasswordDialog.tsx`:
   - импорт `import { useOfficeSession } from "./office-session.js";` заменить на `import { useOfficeMutation } from "./office-query.js";`;
   - добавить `import type { PasswordChange } from "../host/protocol.js";`;
   - строку `const session = useOfficeSession();` заменить на:

```ts
const change = useOfficeMutation((api, token, request: PasswordChange) =>
  api.officeChangePassword(token, request),
);
```

- вызов `await session.changePassword({ … })` заменить на `await change.mutateAsync({ … })` (аргумент тот же).

5. `apps/standalone/src/office/OfficeShell.tsx` — сообщение «Пароль изменён…» показывается только на той странице, где пароль сменили:
   - импорт `react-router` расширить до `import { NavLink, Outlet, useLocation } from "react-router";`;
   - состояние `const [passwordChanged, setPasswordChanged] = useState(false);` заменить на

```ts
const location = useLocation();
// The page the password was changed on; the notice stays on that page only.
const [passwordChangedAt, setPasswordChangedAt] = useState<string | null>(null);
```

- в обработчике кнопки «Сменить пароль» заменить `setPasswordChanged(false);` на `setPasswordChangedAt(null);`;
- строку `{passwordChanged && <Alert tone="ok">{t("office.password.done")}</Alert>}` заменить на `{passwordChangedAt === location.pathname && <Alert tone="ok">{t("office.password.done")}</Alert>}`;
- в `onChanged` диалога заменить `setPasswordChanged(true);` на `setPasswordChangedAt(location.pathname);`.

- [ ] **Step 8: Тесты офиса и приложения — на новый слой**

1. `apps/standalone/test/office.test.tsx`:
   - удалить локальную функцию `sessionFor` и обе локальные функции `renderOffice`, импорт `import type { OfficeSessionValue } …` и неиспользуемые после этого импорты;
   - добавить `import { fakeOfficeSession, renderOffice } from "./support/office.js";`;
   - заменить вызовы `sessionFor()` на `fakeOfficeSession()`, а `sessionFor({ ...SESSION.user, role: "technologist" })` — на `fakeOfficeSession({ user: { ...SESSION.user, role: "technologist" } })`;
   - в `describe("ChangePasswordDialog")` вместо `session.changePassword` использовать `session.api.officeChangePassword`:
     - успешный тест перед рендером делает `session.api.officeChangePassword.mockResolvedValue(undefined);` и ожидает `toHaveBeenCalledWith("office-session-token", { currentPassword: "correct horse battery", newPassword: "another long password" })`;
     - `session.changePassword.mockRejectedValueOnce(…)` → `session.api.officeChangePassword.mockRejectedValueOnce(…)`;
     - `expect(session.changePassword).not.toHaveBeenCalled()` → `expect(session.api.officeChangePassword).not.toHaveBeenCalled()`.

   Затем в конец `describe("ChangePasswordDialog")` добавить тесты веток (пункты итогового ревью 1b2). Тестовая функция `fill`:

```tsx
function fill(current: string, next: string, repeat = next): void {
  type("Текущий пароль", current);
  type("Новый пароль", next);
  type("Повторите новый пароль", repeat);
}

it("checks the new password's length before calling the host", async () => {
  const session = fakeOfficeSession();
  renderOffice(session);
  await openDialog();
  fill("correct horse battery", "short");
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  expect(await screen.findByText("Пароль — от 8 до 128 символов")).toBeTruthy();
  expect(session.api.officeChangePassword).not.toHaveBeenCalled();
});

it("puts the host's refusal of the new password under its field", async () => {
  const session = fakeOfficeSession();
  session.api.officeChangePassword.mockRejectedValueOnce(
    new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "the password must be 8-128 characters",
      details: { field: "newPassword" },
    }),
  );
  renderOffice(session);
  await openDialog();
  fill("correct horse battery", "another long password");
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  expect(await screen.findByText("Пароль — от 8 до 128 символов")).toBeTruthy();
});

it("explains any other failure above the form and stays open", async () => {
  const session = fakeOfficeSession();
  session.api.officeChangePassword.mockRejectedValueOnce(
    new HostError({ kind: "api", code: "rate_limited", status: 429, message: "slow down" }),
  );
  renderOffice(session);
  await openDialog();
  fill("correct horse battery", "another long password");
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  expect(
    await screen.findByText("Слишком много попыток. Подождите минуту и попробуйте снова."),
  ).toBeTruthy();
  expect(screen.getByText("Смена пароля")).toBeTruthy();
});

it("starts empty again after being cancelled", async () => {
  renderOffice(fakeOfficeSession());
  await openDialog();
  type("Текущий пароль", "correct horse battery");
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.queryByText("Смена пароля")).toBeNull();
  await openDialog();
  expect(screen.getByLabelText("Текущий пароль")).toHaveProperty("value", "");
});

it("cannot be closed while the change is being sent", async () => {
  const session = fakeOfficeSession();
  let finish: () => void = () => undefined;
  session.api.officeChangePassword.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  renderOffice(session);
  await openDialog();
  fill("correct horse battery", "another long password");
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  await waitFor(() => expect(session.api.officeChangePassword).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  expect(screen.getByText("Смена пароля")).toBeTruthy();
  finish();
  expect(
    await screen.findByText("Пароль изменён. На других устройствах нужно войти заново."),
  ).toBeTruthy();
});
```

2. `apps/standalone/test/app.test.tsx`:
   - функцию `fakeHost` заменить на

```ts
function fakeHost() {
  return fakeHostApi({
    bootstrap: vi.fn<HostApi["bootstrap"]>(async () => ({ session: SESSION })),
    officeLogin: vi.fn<HostApi["officeLogin"]>(async () => SESSION),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(async () => undefined),
  });
}
```

- добавить импорт `import { fakeHostApi } from "./support/office.js";`;
- добавить тест:

```ts
it("re-reads the signed-in user when the host answers forbidden", async () => {
  const host = fakeHost();
  host.officeChangePassword.mockRejectedValueOnce(
    new HostError({ kind: "api", code: "forbidden", status: 403, message: "not allowed" }),
  );
  host.officeMe.mockResolvedValueOnce({
    ...SESSION.user,
    name: "Ирина Орлова",
    role: "technologist",
  });
  renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
  fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
  fireEvent.change(await screen.findByLabelText("Текущий пароль"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.change(screen.getByLabelText("Новый пароль"), {
    target: { value: "another long password" },
  });
  fireEvent.change(screen.getByLabelText("Повторите новый пароль"), {
    target: { value: "another long password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  expect(await screen.findByText("Недостаточно прав для этого действия.")).toBeTruthy();
  expect(await screen.findByText("Ирина Орлова")).toBeTruthy();
  expect(screen.getByText("технолог")).toBeTruthy();
  expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx test/app.test.tsx test/shell.test.ts test/office-query.test.tsx test/api.test.ts`
Expected: PASS.

- [ ] **Step 9: Правило в `AGENTS.md`**

В `apps/standalone/AGENTS.md` после раздела «Device key and office session» добавить раздел:

```markdown
## Office pages

- Every office request goes through `session.call` with `session.api`
  (`useOfficeQuery`, `useOfficeMutation` in `src/office/office-query.ts`).
  `call` routes an ended session to the sign-in and a rejected device to
  re-pairing, and re-reads the user on `forbidden`. Pages never call
  `invoke`, `HostClient` or `createHostApi` themselves.
- React Query keeps one cache per office session (`Office` is keyed by the
  session token), with no retries and no refetch on window focus: a host
  error is an answer the page explains, with a retry button.
- Every write sends the loaded record's `expectedRev`. On `stale_revision`
  the page offers to load the data again and drops the user's edits; it
  never retries with `details.currentRev`.
```

- [ ] **Step 10: Проверки и коммит**

Run: пакетные `test`, `typecheck`, `lint`, `build` (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone <скрипт>`) — зелёные; `grep -rn "changePassword" apps/standalone/src apps/standalone/test` находит только `officeChangePassword`; `node_modules/.bin/prettier --check` по изменённым файлам; `git diff --check`.

```bash
git add apps/standalone/package.json pnpm-lock.yaml apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/Office.tsx apps/standalone/src/office/office-session.tsx apps/standalone/src/office/ChangePasswordDialog.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/app/shell.ts apps/standalone/src/app/App.tsx apps/standalone/test/support/office.tsx apps/standalone/test/api.test.ts apps/standalone/test/office-query.test.tsx apps/standalone/test/office.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/shell.test.ts apps/standalone/AGENTS.md
git commit -m "feat(standalone): слой данных офиса — HostApi, react-query и call на сессию" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Общие правила полей для мастера и офиса

Страница организации (задача 5) и пользователи (задача 7) проверяют те же поля, что мастер первого запуска: логин, имя, пароль, название, ИНН, GLN, префиксы GS1, часовой пояс. Сейчас эти правила и тексты живут в `src/wizard/wizard-form.ts` под ключами `wizard.errors.*` и `wizard.org.*`. Задача выносит их в `src/lib/rules.ts` и `src/lib/time-zones.ts`, а тексты — в общие ключи `rules.*` и `org.*`. Поведение мастера не меняется: его тесты проверяют те же тексты на экране.

**Files:**

- Create: `apps/standalone/src/lib/rules.ts`, `apps/standalone/src/lib/time-zones.ts`, `apps/standalone/test/rules.test.ts`
- Modify: `apps/standalone/src/wizard/wizard-form.ts`, `apps/standalone/src/wizard/BootstrapWizard.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/wizard-form.test.ts`

**Interfaces:**

- Consumes: `hasValidCheckDigit` из `@markiro/domain`; `OrgProfileInput` из `src/host/protocol.ts`; `ComboboxOption` из `@markiro/ui`.
- Produces (`src/lib/rules.ts`): `characters(text: string): number`, `THIRTEEN_DIGITS: RegExp`, `issuerPrefix(gln: string): string`, `parsePrefixList(text: string): string[]`, `loginRule`, `personNameRule`, `passwordRule` (схемы zod со строками-ключами `rules.*`), `orgFieldsSchema` (zod-объект с полями `orgName`, `inn`, `gln`, `gs1Prefixes`, `timeZone`), `type OrgFields`, `toOrgInput(values: OrgFields): OrgProfileInput`, `ORG_HOST_FIELDS: Readonly<Record<string, keyof OrgFields>>` (поле `validation_failed` хоста → поле формы).
- Produces (`src/lib/time-zones.ts`): `DEFAULT_TIME_ZONE = "Europe/Moscow"`, `TIME_ZONE_OPTIONS: readonly ComboboxOption[]`.
- Produces (i18n): ключи `rules.{login,name,password,passwordConfirm,orgName,inn,gln,glnCheckDigit,gs1Prefixes,timeZone,rejected}` и `org.{name,inn,innHint,gln,glnHint,gs1Prefixes,gs1PrefixesHint,timeZone,timeZonePlaceholder,timeZoneSearch,timeZoneEmpty,timeZoneLoading}`.

- [ ] **Step 1: Написать падающий тест общих правил**

Create `apps/standalone/test/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  parsePrefixList,
  passwordRule,
  personNameRule,
  toOrgInput,
  type OrgFields,
} from "../src/lib/rules.js";
import { DEFAULT_TIME_ZONE, TIME_ZONE_OPTIONS } from "../src/lib/time-zones.js";

const ORG: OrgFields = {
  orgName: " ООО «Атолл» ",
  inn: "",
  gln: "4600682000013",
  gs1Prefixes: "4600682, 4600682;4607091",
  timeZone: "Europe/Moscow",
};

function orgMessage(overrides: Partial<OrgFields>): string | undefined {
  return orgFieldsSchema.safeParse({ ...ORG, ...overrides }).error?.issues[0]?.message;
}

describe("organization rules", () => {
  it("accepts a valid organization and builds the host's input from it", () => {
    expect(orgFieldsSchema.safeParse(ORG).success).toBe(true);
    expect(toOrgInput(ORG)).toEqual({
      name: "ООО «Атолл»",
      inn: null,
      gln: "4600682000013",
      gs1Prefixes: ["4600682", "4607091"],
      timeZone: "Europe/Moscow",
    });
  });

  it.each([
    [{ orgName: "  " }, "rules.orgName"],
    [{ inn: "12345678901" }, "rules.inn"],
    [{ gln: "460068200001" }, "rules.gln"],
    [{ gln: "4600682000010" }, "rules.glnCheckDigit"],
    [{ gs1Prefixes: "460" }, "rules.gs1Prefixes"],
    [
      { gs1Prefixes: "1001 1002 1003 1004 1005 1006 1007 1008 1009 1010 1011" },
      "rules.gs1Prefixes",
    ],
    [{ timeZone: "" }, "rules.timeZone"],
  ] satisfies [Partial<OrgFields>, string][])("rejects %j with %s", (overrides, message) => {
    expect(orgMessage(overrides)).toBe(message);
  });

  it("maps the host's organization fields to form fields", () => {
    expect(ORG_HOST_FIELDS.name).toBe("orgName");
    expect(ORG_HOST_FIELDS.gs1Prefixes).toBe("gs1Prefixes");
    expect(ORG_HOST_FIELDS.unknown).toBeUndefined();
  });

  it("splits a prefix list on commas, semicolons and spaces", () => {
    expect(parsePrefixList(" 4600682,4607091 ;4600682 ")).toEqual(["4600682", "4607091"]);
  });
});

describe("office user rules", () => {
  it("checks logins, names and passwords like the host", () => {
    expect(loginRule.safeParse(" tech.2 ").data).toBe("tech.2");
    expect(loginRule.safeParse("ab").error?.issues[0]?.message).toBe("rules.login");
    expect(loginRule.safeParse("иван").error?.issues[0]?.message).toBe("rules.login");
    expect(personNameRule.safeParse(" Павел ").data).toBe("Павел");
    expect(personNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.name");
    expect(personNameRule.safeParse("я".repeat(101)).success).toBe(false);
    expect(passwordRule.safeParse("seven77").error?.issues[0]?.message).toBe("rules.password");
    // Eight Cyrillic letters are 16 bytes but 8 characters, as the host counts.
    expect(passwordRule.safeParse("пароль12").success).toBe(true);
    expect(passwordRule.safeParse("x".repeat(129)).success).toBe(false);
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
      value: DEFAULT_TIME_ZONE,
      label: "Europe/Moscow",
      keywords: ["Europe/Moscow"],
    });
    const values = TIME_ZONE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("America/New_York");
    expect(TIME_ZONE_OPTIONS.find((option) => option.value === "America/New_York")?.label).toBe(
      "America/New York",
    );
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/rules.js"`.

- [ ] **Step 3: Создать `src/lib/rules.ts` и `src/lib/time-zones.ts`**

Create `apps/standalone/src/lib/rules.ts`:

```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { z } from "zod";

import type { OrgProfileInput } from "../host/protocol.js";

// Field rules shared by the first-run wizard and the office pages. They
// mirror the host's own checks (`host/src/validate.rs`), so a form fails
// before the request is sent. Messages are i18n keys under `rules.`.

/** Characters as the host counts them (Unicode scalar values). */
export function characters(text: string): number {
  return [...text].length;
}

export const THIRTEEN_DIGITS = /^\d{13}$/;

/** The SSCC issuer prefix the host derives from a GLN: its first 9 digits, as in the cloud. */
export function issuerPrefix(gln: string): string {
  return gln.slice(0, 9);
}

/** Split on commas, semicolons and spaces; repeats collapse. */
export function parsePrefixList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((prefix) => prefix.length > 0))];
}

function isValidPrefixList(text: string): boolean {
  const prefixes = parsePrefixList(text);
  return prefixes.length <= 10 && prefixes.every((prefix) => /^\d{4,12}$/.test(prefix));
}

/** An office login (`validate::office_login`). */
export const loginRule = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,64}$/, "rules.login");

/** A person's display name (`validate::person_name`). */
export const personNameRule = z
  .string()
  .trim()
  .refine((name) => characters(name) >= 1 && characters(name) <= 100, "rules.name");

/** A password (`validate::password`). */
export const passwordRule = z
  .string()
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password");

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
  orgName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 200, "rules.orgName"),
  inn: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{12})?$/, "rules.inn"),
  gln: z
    .string()
    .trim()
    .regex(THIRTEEN_DIGITS, "rules.gln")
    .refine((gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln), "rules.glnCheckDigit"),
  gs1Prefixes: z.string().refine(isValidPrefixList, "rules.gs1Prefixes"),
  timeZone: z.string().min(1, "rules.timeZone"),
});
export type OrgFields = z.input<typeof orgFieldsSchema>;

/** The host's organization fields for form values. */
export function toOrgInput(values: OrgFields): OrgProfileInput {
  const inn = values.inn.trim();
  return {
    name: values.orgName.trim(),
    inn: inn === "" ? null : inn,
    gln: values.gln.trim(),
    gs1Prefixes: parsePrefixList(values.gs1Prefixes),
    timeZone: values.timeZone,
  };
}

/**
 * The form field an organization `validation_failed` names. `PUT
 * /v1/office/org` names bare fields (`gln`); the wizard strips its `org.`.
 */
export const ORG_HOST_FIELDS: Readonly<Record<string, keyof OrgFields>> = {
  name: "orgName",
  inn: "inn",
  gln: "gln",
  gs1Prefixes: "gs1Prefixes",
  timeZone: "timeZone",
};
```

Create `apps/standalone/src/lib/time-zones.ts`:

```ts
import type { ComboboxOption } from "@markiro/ui";

/** The default for a new site. */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

/** IANA zones this runtime knows, the default first, as time-zone picker options. */
export const TIME_ZONE_OPTIONS: readonly ComboboxOption[] = [
  ...new Set([DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")]),
].map((zone) => ({ value: zone, label: zone.replaceAll("_", " "), keywords: [zone] }));
```

- [ ] **Step 4: Перенести тексты в `ru.json`**

В `apps/standalone/src/i18n/ru.json`:

1. Добавить верхнеуровневые объекты `rules` и `org` (тексты — те же, что сейчас под `wizard.errors.*` и `wizard.org.*`):

```json
  "rules": {
    "login": "3–64 символа: латиница, цифры, точка, дефис, подчёркивание",
    "name": "Укажите имя, до 100 символов",
    "password": "Пароль — от 8 до 128 символов",
    "passwordConfirm": "Пароли не совпадают",
    "orgName": "Укажите название, до 200 символов",
    "inn": "ИНН — 10 или 12 цифр",
    "gln": "GLN — 13 цифр",
    "glnCheckDigit": "Неверная контрольная цифра GLN",
    "gs1Prefixes": "Каждый префикс — от 4 до 12 цифр, не больше 10 префиксов",
    "timeZone": "Выберите часовой пояс",
    "rejected": "Хост не принял это значение. Проверьте его."
  },
  "org": {
    "name": "Название организации",
    "inn": "ИНН",
    "innHint": "Необязательно: 10 или 12 цифр",
    "gln": "GLN организации",
    "glnHint": "13 цифр; первые 9 становятся префиксом SSCC",
    "gs1Prefixes": "Префиксы GS1",
    "gs1PrefixesHint": "Через запятую, от 4 до 12 цифр; можно оставить пустым",
    "timeZone": "Часовой пояс",
    "timeZonePlaceholder": "Выберите часовой пояс",
    "timeZoneSearch": "Город или пояс",
    "timeZoneEmpty": "Ничего не найдено",
    "timeZoneLoading": "Загрузка…"
  },
```

2. Удалить из `wizard.errors` ключи `login`, `name`, `password`, `passwordConfirm`, `orgName`, `inn`, `gln`, `glnCheckDigit`, `gs1Prefixes`, `timeZone`, `rejected` (остаются `serial`, `boxSerial`, `serialCapacity`, `lineName`, `lineDuplicate`, `lines`), а из `wizard.org` — всё, кроме `intro`.

- [ ] **Step 5: Мастер — на общие правила**

Replace `apps/standalone/src/wizard/wizard-form.ts` целиком:

```ts
import { ssccSerialCapacity } from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest } from "../host/protocol.js";
import {
  characters,
  issuerPrefix,
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  passwordRule,
  personNameRule,
  THIRTEEN_DIGITS,
  toOrgInput,
} from "../lib/rules.js";
import { DEFAULT_TIME_ZONE } from "../lib/time-zones.js";

/** Administrator, organization, SSCC starts and lines (stage 1 spec §1), then a review. */
export const WIZARD_STEPS = ["admin", "org", "sscc", "lines", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** At most 20 lines, as on the host. */
export const MAX_LINES = 20;

export interface WizardValues {
  login: string;
  adminName: string;
  password: string;
  passwordConfirm: string;
  orgName: string;
  inn: string;
  gln: string;
  /** Comma-separated in the form; a list in the request. */
  gs1Prefixes: string;
  timeZone: string;
  boxNextSerial: number;
  palletNextSerial: number;
  lines: { name: string }[];
}

const PLAIN_FIELDS = [
  "login",
  "adminName",
  "password",
  "passwordConfirm",
  "orgName",
  "inn",
  "gln",
  "gs1Prefixes",
  "timeZone",
  "boxNextSerial",
  "palletNextSerial",
] as const;

/** A form field that can carry an error. */
export type WizardField = (typeof PLAIN_FIELDS)[number] | `lines.${number}.name`;

export interface FieldIssue {
  field: WizardField;
  /** An i18n key. */
  message: string;
}

export function defaultWizardValues(firstLineName: string): WizardValues {
  return {
    login: "admin",
    adminName: "",
    password: "",
    passwordConfirm: "",
    orgName: "",
    inn: "",
    gln: "",
    gs1Prefixes: "",
    timeZone: DEFAULT_TIME_ZONE,
    boxNextSerial: 1,
    palletNextSerial: 0,
    lines: [{ name: firstLineName }],
  };
}

const adminSchema = z.object({
  login: loginRule,
  adminName: personNameRule,
  password: passwordRule,
});

function isPlainField(value: string): value is (typeof PLAIN_FIELDS)[number] {
  return (PLAIN_FIELDS as readonly string[]).includes(value);
}

/** The first issue per field; the schemas above only have plain fields. */
function issuesOf(error: z.ZodError | undefined): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const issue of error?.issues ?? []) {
    const field = String(issue.path[0]);
    if (isPlainField(field) && !issues.some((known) => known.field === field)) {
      issues.push({ field, message: issue.message });
    }
  }
  return issues;
}

function ssccIssues(values: WizardValues): FieldIssue[] {
  const gln = values.gln.trim();
  const capacity = THIRTEEN_DIGITS.test(gln) ? ssccSerialCapacity(issuerPrefix(gln)) : null;
  const issues: FieldIssue[] = [];
  const check = (
    field: "boxNextSerial" | "palletNextSerial",
    value: number,
    minimum: number,
    belowMinimum: string,
  ) => {
    if (!Number.isInteger(value)) issues.push({ field, message: "wizard.errors.serial" });
    else if (value < minimum) issues.push({ field, message: belowMinimum });
    else if (capacity !== null && value >= capacity) {
      issues.push({ field, message: "wizard.errors.serialCapacity" });
    }
  };
  check("boxNextSerial", values.boxNextSerial, 1, "wizard.errors.boxSerial");
  check("palletNextSerial", values.palletNextSerial, 0, "wizard.errors.serial");
  return issues;
}

function lineIssues(lines: readonly { name: string }[]): FieldIssue[] {
  if (lines.length === 0 || lines.length > MAX_LINES) {
    return [{ field: "lines.0.name", message: "wizard.errors.lines" }];
  }
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const name = line.name.trim();
    const field: WizardField = `lines.${index}.name`;
    if (characters(name) < 1 || characters(name) > 100) {
      issues.push({ field, message: "wizard.errors.lineName" });
      return;
    }
    // The host keys names by their Unicode lower case, as `toLowerCase` does.
    const key = name.toLowerCase();
    if (seen.has(key)) issues.push({ field, message: "wizard.errors.lineDuplicate" });
    seen.add(key);
  });
  return issues;
}

/** Problems that keep the user on `step`; `review` checks every step. */
export function validateStep(step: WizardStep, values: WizardValues): FieldIssue[] {
  switch (step) {
    case "admin": {
      const issues = issuesOf(adminSchema.safeParse(values).error);
      if (values.password !== values.passwordConfirm) {
        issues.push({ field: "passwordConfirm", message: "rules.passwordConfirm" });
      }
      return issues;
    }
    case "org":
      return issuesOf(orgFieldsSchema.safeParse(values).error);
    case "sscc":
      return ssccIssues(values);
    case "lines":
      return lineIssues(values.lines);
    case "review":
      return (["admin", "org", "sscc", "lines"] as const).flatMap((each) =>
        validateStep(each, values),
      );
  }
}

export function toBootstrapRequest(values: WizardValues): BootstrapRequest {
  return {
    admin: {
      login: values.login.trim(),
      name: values.adminName.trim(),
      password: values.password,
    },
    org: toOrgInput(values),
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
  };
}

const HOST_FIELDS: Readonly<Record<string, WizardField>> = {
  "admin.login": "login",
  "admin.name": "adminName",
  "admin.password": "password",
  "sscc.boxNextSerial": "boxNextSerial",
  "sscc.palletNextSerial": "palletNextSerial",
  lines: "lines.0.name",
};

/** The wizard field a host `validation_failed` names (`org.gln`, `lines.2`). */
export function fieldFromHost(path: string): WizardField | null {
  const line = /^lines\.(\d+)$/.exec(path);
  if (line) return `lines.${Number(line[1])}.name`;
  if (path.startsWith("org.")) return ORG_HOST_FIELDS[path.slice("org.".length)] ?? null;
  return HOST_FIELDS[path] ?? null;
}

const ORG_FIELDS: ReadonlySet<WizardField> = new Set<WizardField>([
  "orgName",
  "inn",
  "gln",
  "gs1Prefixes",
  "timeZone",
]);

/** The step that shows `field`. */
export function stepOf(field: WizardField): WizardStep {
  if (field.startsWith("lines.")) return "lines";
  if (field === "boxNextSerial" || field === "palletNextSerial") return "sscc";
  if (ORG_FIELDS.has(field)) return "org";
  return "admin";
}
```

В `apps/standalone/src/wizard/BootstrapWizard.tsx`:

1. Из импорта `./wizard-form.js` убрать `DEFAULT_TIME_ZONE` и `issuerPrefix`; добавить импорты `import { issuerPrefix } from "../lib/rules.js";` и `import { TIME_ZONE_OPTIONS } from "../lib/time-zones.js";`.
2. Удалить константу `TIME_ZONES` (с её комментарием) и `useMemo` с `zones`; в `Combobox` передавать `options={TIME_ZONE_OPTIONS}`. Если после этого `useMemo` больше не используется, убрать его из импорта `react`.
3. Ключи полей организации: `wizard.org.name` → `org.name`, `wizard.org.inn` → `org.inn`, `wizard.org.innHint` → `org.innHint`, `wizard.org.gln` → `org.gln`, `wizard.org.glnHint` → `org.glnHint`, `wizard.org.gs1Prefixes` → `org.gs1Prefixes`, `wizard.org.gs1PrefixesHint` → `org.gs1PrefixesHint`, `wizard.org.timeZone` → `org.timeZone`, `wizard.org.timeZonePlaceholder` → `org.timeZonePlaceholder`, `wizard.org.timeZoneSearch` → `org.timeZoneSearch`, `wizard.org.timeZoneEmpty` → `org.timeZoneEmpty`, `wizard.org.timeZoneLoading` → `org.timeZoneLoading`. `wizard.org.intro` остаётся.
4. `"wizard.errors.rejected"` → `"rules.rejected"`.

После правок `grep -rn "wizard\.errors\.\(login\|name\|password\|passwordConfirm\|orgName\|inn\|gln\|glnCheckDigit\|gs1Prefixes\|timeZone\|rejected\)\b\|wizard\.org\.[a-zA-Z]" apps/standalone/src` должен найти только `wizard.org.intro`.

- [ ] **Step 6: Тесты мастера — на новые ключи**

В `apps/standalone/test/wizard-form.test.ts` ожидаемые сообщения перенесённых правил заменить: `wizard.errors.login` → `rules.login`, `wizard.errors.name` → `rules.name`, `wizard.errors.password` → `rules.password`, `wizard.errors.passwordConfirm` → `rules.passwordConfirm`, `wizard.errors.orgName` → `rules.orgName`, `wizard.errors.inn` → `rules.inn`, `wizard.errors.gln` → `rules.gln`, `wizard.errors.glnCheckDigit` → `rules.glnCheckDigit`, `wizard.errors.gs1Prefixes` → `rules.gs1Prefixes`. Ожидания `wizard.errors.serial*`, `wizard.errors.boxSerial`, `wizard.errors.line*`, `wizard.errors.lines` не меняются. Остальные утверждения не трогать.

- [ ] **Step 7: Запустить тесты**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx`
Expected: PASS. Затем пакетные `test`, `typecheck`, `lint` (каждая команда — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone <скрипт>`) — зелёные.

- [ ] **Step 8: Коммит**

Run: `node_modules/.bin/prettier --check` по изменённым файлам и `git diff --check`.

```bash
git add apps/standalone/src/lib/rules.ts apps/standalone/src/lib/time-zones.ts apps/standalone/test/rules.test.ts apps/standalone/src/wizard/wizard-form.ts apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/wizard-form.test.ts
git commit -m "refactor(standalone): общие правила полей мастера и офиса" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Страница «Профиль организации»

Первая страница офиса с данными хоста. Администратор правит название, ИНН, GLN, префиксы GS1 и часовой пояс; технолог видит то же без формы. Задача:

- заводит общие для страниц части: загрузку, ошибку загрузки, предупреждение об устаревшей записи и разбор отказа записи;
- добавляет раздел меню «Организация»;
- переводит фокус на страницу после перехода по меню.

**Files:**

- Create: `apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/office/org/OrgProfilePage.tsx`
- Create: `apps/standalone/test/form-errors.test.ts`, `apps/standalone/test/org-page.test.tsx`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Modify: `apps/standalone/test/support/office.tsx`, `apps/standalone/test/office.test.tsx`, `apps/standalone/test/app.test.tsx`

**Interfaces:**

- Consumes:
  - `useOfficeQuery`, `useOfficeMutation`, `officeKeys` (задача 3);
  - `fakeOfficeSession`, `renderOffice`, `TECHNOLOGIST`, `fakeHostApi` (задача 3);
  - `orgFieldsSchema`, `toOrgInput`, `ORG_HOST_FIELDS`, `issuerPrefix`, `THIRTEEN_DIGITS`, `type OrgFields` (задача 4);
  - `TIME_ZONE_OPTIONS` (задача 4);
  - `errorMessageKey` (`src/host/errors.ts`), `errorProp` (`src/lib/form-error.ts`).
- Produces:
  - `page-state.tsx`:
    - `PageLoading()`;
    - `LoadError({ error: unknown; onRetry: () => void })`;
    - `StaleAlert({ onReload: () => void })`.
  - `form-errors.ts`:
    - `type WriteFailure<F extends string> = { kind: "field"; field: F; message: string } | { kind: "stale" } | { kind: "alert"; message: string }`;
    - `writeFailure<F extends string>(error: unknown, fields: Readonly<Record<string, F>>): WriteFailure<F>`.
  - `OrgProfilePage` на маршруте `/org`.
  - Ключи i18n `office.common.*`: `loading`, `retry`, `reload`, `save`, `cancel`, `close`, `saved`, `none`, `readOnly`.
  - `test/support/office.tsx`: `ORG_PROFILE: OrgProfile`.

- [ ] **Step 1: Тест разбора отказов записи**

Create `apps/standalone/test/form-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { writeFailure } from "../src/office/form-errors.js";

const FIELDS = { name: "orgName", gln: "gln" } as const;

describe("writeFailure", () => {
  it("puts a validation failure under the form field the host names", () => {
    const error = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "the GLN must be 13 digits",
      details: { field: "gln" },
    });
    expect(writeFailure(error, FIELDS)).toEqual({
      kind: "field",
      field: "gln",
      message: "rules.rejected",
    });
  });

  it("asks to reload after a stale write", () => {
    const error = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { currentRev: 9 },
    });
    expect(writeFailure(error, FIELDS)).toEqual({ kind: "stale" });
  });

  it("explains everything else by its code", () => {
    const unknownField = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "bad",
      details: { field: "somethingElse" },
    });
    expect(writeFailure(unknownField, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    expect(writeFailure(down, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.transport.unreachable",
    });
    expect(writeFailure(new Error("boom"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.unknown",
    });
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts`
Expected: FAIL — `Failed to resolve import "../src/office/form-errors.js"`.

- [ ] **Step 2: Общие части страниц**

Create `apps/standalone/src/office/form-errors.ts`:

```ts
import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";

/** What a form shows for a failed write. Messages are i18n keys. */
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string };

/**
 * Sorts a failed office write: a `validation_failed` naming a known field
 * goes under that field, `stale_revision` offers to reload, and anything
 * else is an alert explained by its code. `fields` maps the host's field
 * names to the form's.
 */
export function writeFailure<F extends string>(
  error: unknown,
  fields: Readonly<Record<string, F>>,
): WriteFailure<F> {
  if (error instanceof HostError) {
    if (error.code === "stale_revision") return { kind: "stale" };
    const path = error.field;
    const field = path === null ? undefined : fields[path];
    if (field !== undefined) return { kind: "field", field, message: "rules.rejected" };
  }
  return { kind: "alert", message: errorMessageKey(error) };
}
```

Create `apps/standalone/src/office/page-state.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";

/** An office page while its data loads. */
export function PageLoading() {
  const { t } = useTranslation();
  return <Spinner label={t("office.common.loading")} />;
}

export interface LoadErrorProps {
  error: unknown;
  onRetry: () => void;
}

/** An office page whose data did not load. */
export function LoadError({ error, onRetry }: LoadErrorProps) {
  const { t } = useTranslation();
  return (
    <Alert
      tone="error"
      action={
        <Button variant="secondary" size="compact" onClick={onRetry}>
          {t("office.common.retry")}
        </Button>
      }
    >
      {t(errorMessageKey(error))}
    </Alert>
  );
}

export interface StaleAlertProps {
  onReload: () => void;
}

/** A write the host refused as stale: reloading shows the new data and drops this form's edits. */
export function StaleAlert({ onReload }: StaleAlertProps) {
  const { t } = useTranslation();
  return (
    <Alert
      tone="warn"
      action={
        <Button variant="secondary" size="compact" onClick={onReload}>
          {t("office.common.reload")}
        </Button>
      }
    >
      {t("errors.api.stale_revision")}
    </Alert>
  );
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts`
Expected: PASS.

- [ ] **Step 3: Фикстура и падающие тесты страницы**

В `apps/standalone/test/support/office.tsx` добавить `OrgProfile` в импорт типов из `../../src/host/protocol.js` и в конец файла:

```tsx
export const ORG_PROFILE: OrgProfile = {
  name: "ООО «Атолл»",
  inn: "7701234567",
  gln: "4600682000013",
  gs1Prefixes: ["4600682"],
  timeZone: "Europe/Moscow",
  rev: 4,
};
```

Create `apps/standalone/test/org-page.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens the profile from the menu, as a user does. */
async function openProfile(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  await screen.findByRole("heading", { name: "Профиль организации" });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  return session;
}

describe("organization profile", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist the profile without a form", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    await openProfile(session);
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.getByText("4600682000013")).toBeTruthy();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");
  });

  it("saves an administrator's change with the loaded revision", async () => {
    const session = adminSession();
    session.api.updateOrg.mockResolvedValue({ ...ORG_PROFILE, name: "ООО «Атолл-Юг»", rev: 5 });
    await openProfile(session);
    const name = await screen.findByLabelText("Название организации");
    expect(name).toHaveProperty("value", "ООО «Атолл»");
    expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", true);
    fireEvent.change(name, { target: { value: " ООО «Атолл-Юг» " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateOrg).toHaveBeenCalledWith("office-session-token", {
      name: "ООО «Атолл-Юг»",
      inn: "7701234567",
      gln: "4600682000013",
      gs1Prefixes: ["4600682"],
      timeZone: "Europe/Moscow",
      expectedRev: 4,
    });
    expect(screen.getByLabelText("Название организации")).toHaveProperty("value", "ООО «Атолл-Юг»");
    // The saved profile replaced the cached one; nothing was read again.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("checks the GLN's check digit before calling the host", async () => {
    const session = adminSession();
    await openProfile(session);
    await screen.findByLabelText("GLN организации");
    type("GLN организации", "4600682000010");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(session.api.updateOrg).not.toHaveBeenCalled();
  });

  it("warns that a GLN with another prefix starts other SSCC counters", async () => {
    await openProfile(adminSession());
    await screen.findByLabelText("GLN организации");
    expect(screen.queryByText(/Префикс SSCC станет/)).toBeNull();
    type("GLN организации", "4607091000016");
    expect(await screen.findByText(/Префикс SSCC станет 460709100\./)).toBeTruthy();
  });

  it("puts the host's refusal under the field it names", async () => {
    const session = adminSession();
    session.api.updateOrg.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "an IANA time zone name is required",
        details: { field: "timeZone" },
      }),
    );
    await openProfile(session);
    await screen.findByLabelText("Название организации");
    type("Название организации", "ООО «Атолл-Юг»");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Хост не принял это значение. Проверьте его.")).toBeTruthy();
  });

  it("offers to load the profile again after a stale save", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg
      .mockResolvedValueOnce(ORG_PROFILE)
      .mockResolvedValueOnce({ ...ORG_PROFILE, name: "ООО «Атолл-Север»", rev: 6 });
    session.api.updateOrg.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 6 },
      }),
    );
    await openProfile(session);
    await screen.findByLabelText("Название организации");
    type("Название организации", "ООО «Атолл-Юг»");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Название организации")).toHaveProperty(
        "value",
        "ООО «Атолл-Север»",
      ),
    );
    expect(session.api.getOrg).toHaveBeenCalledTimes(2);
    expect(session.api.updateOrg).toHaveBeenCalledTimes(1);
  });

  it("explains a failed load and retries it", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(ORG_PROFILE);
    await openProfile(session);
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название организации")).toBeTruthy();
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/org-page.test.tsx`
Expected: FAIL — ссылки «Профиль» нет.

- [ ] **Step 4: Страница, меню и маршрут**

Create `apps/standalone/src/office/org/OrgProfilePage.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Combobox, DefinitionGrid, Input, PageHeader } from "@markiro/ui";

import type { OrgProfile } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import {
  issuerPrefix,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  THIRTEEN_DIGITS,
  toOrgInput,
  type OrgFields,
} from "../../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../../lib/time-zones.js";
import { writeFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading, StaleAlert } from "../page-state.js";

/** The organization profile (spec §5.5): administrators edit it, technologists read it. */
export function OrgProfilePage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.org.title")} />
      <OrgProfileContent />
    </>
  );
}

function OrgProfileContent() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The revision the last save produced; its notice stays until the data changes.
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (org.isPending) return <PageLoading />;
  if (org.isError) return <LoadError error={org.error} onRetry={() => void org.refetch()} />;

  const saved = (profile: OrgProfile) => {
    queryClient.setQueryData(officeKeys.org, profile);
    setSavedRev(profile.rev);
  };

  return (
    <Card>
      {savedRev === org.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {user.role === "admin" ? (
        // A new revision — after a save or a reload — starts the form afresh.
        <OrgProfileForm
          key={org.data.rev}
          profile={org.data}
          onSaved={saved}
          onReload={() => void org.refetch()}
        />
      ) : (
        <OrgProfileView profile={org.data} />
      )}
    </Card>
  );
}

interface OrgProfileFormProps {
  profile: OrgProfile;
  onSaved: (profile: OrgProfile) => void;
  onReload: () => void;
}

function OrgProfileForm({ profile, onSaved, onReload }: OrgProfileFormProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, values: OrgFields) =>
    api.updateOrg(token, { ...toOrgInput(values), expectedRev: profile.rev }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<OrgFields>({
    resolver: zodResolver(orgFieldsSchema),
    defaultValues: {
      orgName: profile.name,
      inn: profile.inn ?? "",
      gln: profile.gln,
      gs1Prefixes: profile.gs1Prefixes.join(", "),
      timeZone: profile.timeZone,
    },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));
  const gln = useWatch({ control, name: "gln" }).trim();
  const newPrefix =
    THIRTEEN_DIGITS.test(gln) && issuerPrefix(gln) !== issuerPrefix(profile.gln)
      ? issuerPrefix(gln)
      : null;

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, ORG_HOST_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
      {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
      <Input
        label={t("org.name")}
        {...fieldError(errors.orgName?.message)}
        {...register("orgName")}
      />
      <Input
        label={t("org.inn")}
        hint={t("org.innHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.inn?.message)}
        {...register("inn")}
      />
      <Input
        label={t("org.gln")}
        hint={t("org.glnHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.gln?.message)}
        {...register("gln")}
      />
      {newPrefix && (
        <Alert tone="warn">{t("office.org.prefixChange", { prefix: newPrefix })}</Alert>
      )}
      <Input
        label={t("org.gs1Prefixes")}
        hint={t("org.gs1PrefixesHint")}
        mono
        {...fieldError(errors.gs1Prefixes?.message)}
        {...register("gs1Prefixes")}
      />
      <Controller
        control={control}
        name="timeZone"
        render={({ field }) => (
          <Combobox
            label={t("org.timeZone")}
            options={TIME_ZONE_OPTIONS}
            value={field.value}
            onValueChange={field.onChange}
            placeholder={t("org.timeZonePlaceholder")}
            searchPlaceholder={t("org.timeZoneSearch")}
            emptyText={t("org.timeZoneEmpty")}
            loadingText={t("org.timeZoneLoading")}
            {...fieldError(errors.timeZone?.message)}
          />
        )}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
      </div>
    </form>
  );
}

function OrgProfileView({ profile }: { profile: OrgProfile }) {
  const { t } = useTranslation();
  const none = t("office.common.none");
  return (
    <>
      <DefinitionGrid
        items={[
          { id: "name", term: t("org.name"), description: profile.name },
          { id: "inn", term: t("org.inn"), description: profile.inn ?? none, mono: true },
          { id: "gln", term: t("org.gln"), description: profile.gln, mono: true },
          {
            id: "gs1Prefixes",
            term: t("org.gs1Prefixes"),
            description: profile.gs1Prefixes.length > 0 ? profile.gs1Prefixes.join(", ") : none,
            mono: true,
          },
          {
            id: "timeZone",
            term: t("org.timeZone"),
            description: profile.timeZone.replaceAll("_", " "),
          },
        ]}
      />
      <p className="office-note">{t("office.common.readOnly")}</p>
    </>
  );
}
```

`apps/standalone/src/office/nav.ts`: комментарий над `OFFICE_NAV` заменить на `/** Office sections by role (spec §4.8); paths match \`officeRoutes\`. */` и в массив после пункта обзора добавить:

```ts
  {
    to: "/org",
    labelKey: "office.nav.orgProfile",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
```

`apps/standalone/src/office/routes.tsx` заменить целиком:

```tsx
import type { RouteObject } from "react-router";

import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";
import { OrgProfilePage } from "./org/OrgProfilePage.js";

/** Office routes; paths match `OFFICE_NAV`. */
export const officeRoutes: RouteObject[] = [
  {
    path: "/",
    element: <OfficeShell />,
    children: [
      { index: true, element: <OfficeOverview /> },
      { path: "org", element: <OrgProfilePage /> },
    ],
  },
];
```

`apps/standalone/src/i18n/ru.json`:

- в `office.nav.sections` добавить `"organization": "Организация"`, в `office.nav` — `"orgProfile": "Профиль"`;
- в `office` добавить объекты:

```json
    "common": {
      "loading": "Загрузка…",
      "retry": "Повторить",
      "reload": "Загрузить заново",
      "save": "Сохранить",
      "cancel": "Отмена",
      "close": "Закрыть",
      "saved": "Изменения сохранены.",
      "none": "—",
      "readOnly": "Изменять эти данные может только администратор."
    },
    "org": {
      "title": "Профиль организации",
      "prefixChange": "Префикс SSCC станет {{prefix}}. Если по нему ещё не печатали, коробы начнутся с номера 1, паллеты — с 0; счётчики прежнего префикса сохранятся."
    },
```

`apps/standalone/src/app/shell.css`, в конец:

```css
.office-note {
  margin: 0;
  color: var(--fg-2);
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/org-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Фокус после перехода и тесты рамки**

В `apps/standalone/test/office.test.tsx`, в `describe("Office")`:

1. К импорту из `./support/office.js` добавить `ORG_PROFILE` и `TECHNOLOGIST`.
2. Добавить тесты:

```tsx
it("offers the organization profile to both roles", async () => {
  renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
  expect(await screen.findByRole("link", { name: "Профиль" })).toBeTruthy();
  expect(screen.getByText("Организация")).toBeTruthy();
});

it("moves focus to the page after a menu navigation", async () => {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  await screen.findByRole("heading", { name: "Профиль организации" });
  expect(document.activeElement).toBe(screen.getByRole("main"));
});
```

3. В `describe("ChangePasswordDialog")` добавить:

```tsx
it("keeps the password notice on the page it was changed on", async () => {
  const session = fakeOfficeSession();
  session.api.officeChangePassword.mockResolvedValue(undefined);
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  renderOffice(session);
  await openDialog();
  fill("correct horse battery", "another long password");
  fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
  const notice = "Пароль изменён. На других устройствах нужно войти заново.";
  expect(await screen.findByText(notice)).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
  await screen.findByRole("heading", { name: "Профиль организации" });
  expect(screen.queryByText(notice)).toBeNull();
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx`
Expected: FAIL в тесте фокуса (`document.activeElement` — ссылка меню).

В `apps/standalone/src/office/OfficeShell.tsx`:

- импорт `react` расширить до `import { useEffect, useMemo, useRef, useState } from "react";`;
- после `const location = useLocation();` добавить:

```tsx
const mainRef = useRef<HTMLElement>(null);
const shownPath = useRef(location.pathname);
useEffect(() => {
  // After a menu navigation, move focus to the new page so a screen
  // reader announces it; the first page keeps the browser's focus.
  if (shownPath.current === location.pathname) return;
  shownPath.current = location.pathname;
  mainRef.current?.focus();
}, [location.pathname]);
```

- `<main className="office-shell__content">` заменить на `<main ref={mainRef} tabIndex={-1} className="office-shell__content">`.

В `apps/standalone/src/app/shell.css` после правила `.office-shell__content { … }` добавить:

```css
/* Focus lands on the page container only programmatically, after a menu navigation. */
.office-shell__content:focus {
  outline: none;
}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx`
Expected: PASS.

- [ ] **Step 6: Поздний ответ ушедшей сессии**

Пункт итогового ревью 1b2: токен-привязка `call` ещё не проверялась страницей, которая действительно ходит на хост. В `apps/standalone/test/app.test.tsx`:

- к импорту из `./support/office.js` добавить `ORG_PROFILE`;
- в импорт из `@testing-library/react` добавить `waitFor`, если его там нет;
- добавить тест:

```tsx
it("ignores a late answer from a session the user already left", async () => {
  const host = fakeHost();
  let failFirstRead: (error: unknown) => void = () => undefined;
  host.getOrg
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirstRead = reject;
        }),
    )
    .mockResolvedValue(ORG_PROFILE);
  host.officeLogin
    .mockResolvedValueOnce(SESSION)
    .mockResolvedValueOnce({ ...SESSION, token: "second-session-token" });
  renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  await waitFor(() => expect(host.getOrg).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  expect(await screen.findByLabelText("Название организации")).toBeTruthy();

  // The first session's read now fails as an ended session; the second
  // session must not be sent back to the sign-in.
  failFirstRead(
    new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "office session ended",
      details: { credential: "session" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Вход в офис")).toBeNull();
  expect(screen.getByLabelText("Название организации")).toBeTruthy();
  expect(host.getOrg).toHaveBeenLastCalledWith("second-session-token");
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
Expected: PASS. Если тест падает, это настоящая ошибка токен-привязки: исправьте код, а не тест, и опишите причину в отчёте.

- [ ] **Step 7: Проверки и коммит**

Run: пакетные `test`, `typecheck`, `lint`, `build` — зелёные; `node_modules/.bin/prettier --check` по изменённым файлам; `git diff --check`.

```bash
git add apps/standalone/src/office/page-state.tsx apps/standalone/src/office/form-errors.ts apps/standalone/src/office/org/OrgProfilePage.tsx apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/form-errors.test.ts apps/standalone/test/org-page.test.tsx apps/standalone/test/office.test.tsx apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): страница профиля организации в офисе" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Страница SSCC

На странице видны счётчики номеров SSCC: для каждого префикса есть счётчик коробов и счётчик паллет; префикс текущего GLN идёт первым с пометкой «текущий». Там же размеры блоков номеров, которые станции получают заранее. Администратор может:

- сдвинуть счётчик вперёд — например, если SSCC печатали и другой программой;
- поменять размеры блоков.

Технолог всё это только видит.

**Files:**

- Create: `apps/standalone/src/office/sscc/SsccPage.tsx`, `apps/standalone/src/office/sscc/CounterDialog.tsx`, `apps/standalone/src/office/sscc/BlockSizesForm.tsx`, `apps/standalone/src/office/sscc/counter-kind.ts`
- Create: `apps/standalone/test/sscc-page.test.tsx`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/office.tsx`

**Interfaces:**

- Consumes:
  - `useOfficeQuery`, `useOfficeMutation`, `officeKeys` (задача 3); `writeFailure`, `PageLoading`, `LoadError`, `StaleAlert`, ключи `office.common.*` (задача 5);
  - `HostApi.getSscc(token)`, `HostApi.updateSsccCounter(token, { issuerPrefix, extension }, { nextSerial, expectedRev })`, `HostApi.updateBlockSizes(token, { boxBlockSize, palletBlockSize, expectedRev })` (задача 3);
  - `HostError.details` (`src/host/client.ts`).
- Produces:
  - `SsccPage` на маршруте `/sscc`;
  - `counterKindKey(counter: Pick<SsccCounter, "extension">): string`;
  - `test/support/office.tsx`: `SSCC_STATE: SsccState`.

- [ ] **Step 1: Фикстура и падающие тесты**

В `apps/standalone/test/support/office.tsx` добавить `SsccState` в импорт типов и в конец файла:

```tsx
/** Two prefixes: the current GLN's (460709100) and an earlier one's. */
export const SSCC_STATE: SsccState = {
  counters: [
    { issuerPrefix: "460068200", extension: 0, nextSerial: 1500, maxSerial: 9999999, rev: 1 },
    { issuerPrefix: "460068200", extension: 1, nextSerial: 40, maxSerial: 9999999, rev: 1 },
    { issuerPrefix: "460709100", extension: 0, nextSerial: 1, maxSerial: 9999999, rev: 2 },
    { issuerPrefix: "460709100", extension: 1, nextSerial: 0, maxSerial: 9999999, rev: 2 },
  ],
  boxBlockSize: 2000,
  palletBlockSize: 200,
  currentIssuerPrefix: "460709100",
  blockSizesRev: 3,
};
```

Create `apps/standalone/test/sscc-page.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  fakeOfficeSession,
  renderOffice,
  SSCC_STATE,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function openSscc(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "SSCC" }));
  await screen.findByRole("heading", { name: "SSCC" });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getSscc.mockResolvedValue(SSCC_STATE);
  return session;
}

/** Data rows of the counters table, top to bottom. */
async function counterRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole("table");
  return within(table).getAllByRole("row").slice(1);
}

describe("SSCC page", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist the counters, current prefix first, and the blocks read-only", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getSscc.mockResolvedValue(SSCC_STATE);
    await openSscc(session);
    const rows = await counterRows();
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("460709100")).toBeTruthy();
    expect(within(rows[0]!).getByText("текущий")).toBeTruthy();
    expect(within(rows[0]!).getByText("Короба")).toBeTruthy();
    expect(within(rows[1]!).getByText("Паллеты")).toBeTruthy();
    expect(within(rows[2]!).getByText("460068200")).toBeTruthy();
    expect(within(rows[2]!).getByText("1500")).toBeTruthy();
    expect(screen.getByText("2000")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Изменить счётчик/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("moves a counter forward with its revision", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockResolvedValue({
      issuerPrefix: "460709100",
      extension: 1,
      nextSerial: 25,
      maxSerial: 9999999,
      rev: 7,
    });
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460709100" }),
    );
    type("Следующий номер", "25");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateSsccCounter).toHaveBeenCalledWith(
      "office-session-token",
      { issuerPrefix: "460709100", extension: 1 },
      { nextSerial: 25, expectedRev: 2 },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const rows = await counterRows();
    expect(within(rows[1]!).getByText("25")).toBeTruthy();
    expect(session.api.getSscc).toHaveBeenCalledTimes(1);
  });

  it("does not let a counter go back", async () => {
    const session = adminSession();
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460068200" }),
    );
    type("Следующий номер", "39");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Номер должен быть не меньше 40")).toBeTruthy();
    expect(session.api.updateSsccCounter).not.toHaveBeenCalled();
  });

  it("shows the host's floor when the counter moved meanwhile", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "sscc_below_floor",
        status: 409,
        message: "an SSCC counter only moves forward",
        details: { minSerial: 60 },
      }),
    );
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460068200" }),
    );
    type("Следующий номер", "50");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Номер должен быть не меньше 60")).toBeTruthy();
  });

  it("offers to load the counters again after a stale change", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 9 },
      }),
    );
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Короба, префикс 460709100" }),
    );
    type("Следующий номер", "100");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.getSscc).toHaveBeenCalledTimes(2));
  });

  it("saves the block sizes with their revision", async () => {
    const session = adminSession();
    session.api.updateBlockSizes.mockResolvedValue({
      ...SSCC_STATE,
      boxBlockSize: 1000,
      blockSizesRev: 8,
    });
    await openSscc(session);
    const box = await screen.findByLabelText("Номеров в блоке для коробов");
    expect(box).toHaveProperty("value", "2000");
    type("Номеров в блоке для коробов", "1000");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateBlockSizes).toHaveBeenCalledWith("office-session-token", {
      boxBlockSize: 1000,
      palletBlockSize: 200,
      expectedRev: 3,
    });
    expect(screen.getByLabelText("Номеров в блоке для коробов")).toHaveProperty("value", "1000");
  });

  it("checks the block sizes against the host's limits", async () => {
    const session = adminSession();
    await openSscc(session);
    await screen.findByLabelText("Номеров в блоке для коробов");
    type("Номеров в блоке для коробов", "100001");
    type("Номеров в блоке для паллет", "0");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 10 000")).toBeTruthy();
    expect(session.api.updateBlockSizes).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx`
Expected: FAIL — ссылки «SSCC» нет.

- [ ] **Step 2: Название вида счётчика**

Create `apps/standalone/src/office/sscc/counter-kind.ts`:

```ts
import type { SsccCounter } from "../../host/protocol.js";

/** The i18n key naming what a counter numbers: extension 0 boxes, 1 pallets. */
export function counterKindKey(counter: Pick<SsccCounter, "extension">): string {
  if (counter.extension === 0) return "office.sscc.kinds.box";
  if (counter.extension === 1) return "office.sscc.kinds.pallet";
  return "office.sscc.kinds.other";
}
```

- [ ] **Step 3: Диалог счётчика**

Create `apps/standalone/src/office/sscc/CounterDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { SsccCounter } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";
import { counterKindKey } from "./counter-kind.js";

const COUNTER_FIELDS = { nextSerial: "nextSerial" } as const;

interface CounterValues {
  nextSerial: number;
}

export interface CounterDialogProps {
  counter: SsccCounter;
  onClose: () => void;
  onSaved: (counter: SsccCounter) => void;
  /** The counter changed on the host: close and load the counters again. */
  onReload: () => void;
}

/** Moves one SSCC counter forward; it never goes back (spec §4.3). */
export function CounterDialog({ counter, onClose, onSaved, onReload }: CounterDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  // The smallest allowed value: the loaded counter, or the host's newer one.
  const [floor, setFloor] = useState(counter.nextSerial);
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const schema = useMemo(
    () =>
      z.object({
        nextSerial: z
          .number({ error: "office.sscc.errors.range" })
          .int("office.sscc.errors.range")
          .min(counter.nextSerial, "office.sscc.errors.belowFloor")
          .max(counter.maxSerial, "office.sscc.errors.range"),
      }),
    [counter],
  );
  const update = useOfficeMutation((api, token, nextSerial: number) =>
    api.updateSsccCounter(
      token,
      { issuerPrefix: counter.issuerPrefix, extension: counter.extension },
      { nextSerial, expectedRev: counter.rev },
    ),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CounterValues>({
    resolver: zodResolver(schema),
    defaultValues: { nextSerial: counter.nextSerial },
  });
  const limits = { min: floor, max: counter.maxSerial };
  const message = errors.nextSerial?.message;
  const kind = t(counterKindKey(counter), { extension: counter.extension });

  const close = () => {
    if (isSubmitting) return;
    onClose();
  };

  const submit = handleSubmit(async ({ nextSerial }) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(nextSerial));
    } catch (error) {
      if (error instanceof HostError && error.code === "sscc_below_floor") {
        const minSerial = error.details.minSerial;
        if (typeof minSerial === "number") setFloor(minSerial);
        setError("nextSerial", { type: "server", message: "office.sscc.errors.belowFloor" });
        return;
      }
      const outcome = writeFailure(error, COUNTER_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.sscc.counterDialog.title", { kind, prefix: counter.issuerPrefix })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting} disabled={!isDirty}>
            {t("office.common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
        {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
        <p>{t("office.sscc.counterDialog.intro")}</p>
        <Input
          type="number"
          min={floor}
          max={counter.maxSerial}
          step={1}
          mono
          label={t("office.sscc.counterDialog.field")}
          hint={t("office.sscc.counterDialog.hint", limits)}
          {...errorProp(message === undefined ? undefined : t(message, limits))}
          {...register("nextSerial", { valueAsNumber: true })}
        />
      </form>
    </Modal>
  );
}
```

- [ ] **Step 4: Форма блоков**

Create `apps/standalone/src/office/sscc/BlockSizesForm.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import type { SsccState } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";

/** The host's limits (`put_block_sizes`): 1-100 000 box serials, 1-10 000 pallet serials. */
const blockSizesSchema = z.object({
  boxBlockSize: z
    .number({ error: "office.sscc.errors.boxBlock" })
    .int("office.sscc.errors.boxBlock")
    .min(1, "office.sscc.errors.boxBlock")
    .max(100_000, "office.sscc.errors.boxBlock"),
  palletBlockSize: z
    .number({ error: "office.sscc.errors.palletBlock" })
    .int("office.sscc.errors.palletBlock")
    .min(1, "office.sscc.errors.palletBlock")
    .max(10_000, "office.sscc.errors.palletBlock"),
});
type BlockSizes = z.infer<typeof blockSizesSchema>;

const BLOCK_FIELDS = { boxBlockSize: "boxBlockSize", palletBlockSize: "palletBlockSize" } as const;

export interface BlockSizesFormProps {
  state: SsccState;
  onSaved: (state: SsccState) => void;
  onReload: () => void;
}

/** How many serials a station takes at a time; administrators only. */
export function BlockSizesForm({ state, onSaved, onReload }: BlockSizesFormProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, sizes: BlockSizes) =>
    api.updateBlockSizes(token, { ...sizes, expectedRev: state.blockSizesRev }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<BlockSizes>({
    resolver: zodResolver(blockSizesSchema),
    defaultValues: { boxBlockSize: state.boxBlockSize, palletBlockSize: state.palletBlockSize },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const submit = handleSubmit(async (sizes) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(sizes));
    } catch (error) {
      const outcome = writeFailure(error, BLOCK_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
      {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
      <Input
        type="number"
        min={1}
        max={100_000}
        step={1}
        mono
        label={t("office.sscc.boxBlock")}
        hint={t("office.sscc.boxBlockHint")}
        {...fieldError(errors.boxBlockSize?.message)}
        {...register("boxBlockSize", { valueAsNumber: true })}
      />
      <Input
        type="number"
        min={1}
        max={10_000}
        step={1}
        mono
        label={t("office.sscc.palletBlock")}
        hint={t("office.sscc.palletBlockHint")}
        {...fieldError(errors.palletBlockSize?.message)}
        {...register("palletBlockSize", { valueAsNumber: true })}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Страница, меню, маршрут и тексты**

Create `apps/standalone/src/office/sscc/SsccPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionGrid,
  PageHeader,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { SsccCounter, SsccState } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BlockSizesForm } from "./BlockSizesForm.js";
import { CounterDialog } from "./CounterDialog.js";
import { counterKindKey } from "./counter-kind.js";

/** The current GLN's counters first; the host already orders by prefix and extension. */
function orderedCounters(state: SsccState): SsccCounter[] {
  const current = state.counters.filter((each) => each.issuerPrefix === state.currentIssuerPrefix);
  const others = state.counters.filter((each) => each.issuerPrefix !== state.currentIssuerPrefix);
  return [...current, ...others];
}

function replaceCounter(state: SsccState, updated: SsccCounter): SsccState {
  return {
    ...state,
    counters: state.counters.map((each) =>
      each.issuerPrefix === updated.issuerPrefix && each.extension === updated.extension
        ? updated
        : each,
    ),
  };
}

/** SSCC counters and block sizes (spec §4.3, §5.5): administrators change them, technologists read them. */
export function SsccPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.sscc.title")} />
      <SsccContent />
    </>
  );
}

function SsccContent() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const sscc = useOfficeQuery(officeKeys.sscc, (api, token) => api.getSscc(token));
  const [editing, setEditing] = useState<SsccCounter | null>(null);
  const [saved, setSaved] = useState<"counter" | "blocks" | null>(null);

  if (sscc.isPending) return <PageLoading />;
  if (sscc.isError) return <LoadError error={sscc.error} onRetry={() => void sscc.refetch()} />;

  const state = sscc.data;
  const admin = user.role === "admin";
  const kindOf = (counter: SsccCounter) =>
    t(counterKindKey(counter), { extension: counter.extension });
  const columns: TableColumn<SsccCounter>[] = [
    {
      key: "prefix",
      title: t("office.sscc.table.prefix"),
      mono: true,
      render: (counter) => (
        <>
          {counter.issuerPrefix}
          {counter.issuerPrefix === state.currentIssuerPrefix && (
            <>
              {" "}
              <Badge tone="info">{t("office.sscc.current")}</Badge>
            </>
          )}
        </>
      ),
    },
    { key: "kind", title: t("office.sscc.table.kind"), render: kindOf },
    {
      key: "next",
      title: t("office.sscc.table.next"),
      mono: true,
      align: "right",
      render: (counter) => String(counter.nextSerial),
    },
    {
      key: "max",
      title: t("office.sscc.table.max"),
      mono: true,
      align: "right",
      render: (counter) => String(counter.maxSerial),
    },
  ];
  if (admin) {
    columns.push({
      key: "actions",
      title: t("office.sscc.table.actions"),
      render: (counter) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.sscc.editNamed", {
            kind: kindOf(counter),
            prefix: counter.issuerPrefix,
          })}
          onClick={() => {
            setSaved(null);
            setEditing(counter);
          }}
        >
          {t("office.sscc.edit")}
        </Button>
      ),
    });
  }

  return (
    <>
      <Card title={t("office.sscc.countersTitle")} titleAs="h2">
        {saved === "counter" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.countersIntro")}</p>
        <Table
          columns={columns}
          rows={orderedCounters(state)}
          getRowKey={(counter) => `${counter.issuerPrefix}-${counter.extension}`}
          scrollLabel={t("office.sscc.countersTitle")}
        />
      </Card>
      <Card title={t("office.sscc.blocksTitle")} titleAs="h2">
        {saved === "blocks" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.blocksIntro")}</p>
        {admin ? (
          <BlockSizesForm
            key={state.blockSizesRev}
            state={state}
            onSaved={(next) => {
              queryClient.setQueryData(officeKeys.sscc, next);
              setSaved("blocks");
            }}
            onReload={() => void sscc.refetch()}
          />
        ) : (
          <>
            <DefinitionGrid
              items={[
                {
                  id: "box",
                  term: t("office.sscc.boxBlock"),
                  description: String(state.boxBlockSize),
                  mono: true,
                },
                {
                  id: "pallet",
                  term: t("office.sscc.palletBlock"),
                  description: String(state.palletBlockSize),
                  mono: true,
                },
              ]}
            />
            <p className="office-note">{t("office.common.readOnly")}</p>
          </>
        )}
      </Card>
      {editing && (
        <CounterDialog
          counter={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            queryClient.setQueryData<SsccState>(officeKeys.sscc, (current) =>
              current ? replaceCounter(current, updated) : current,
            );
            setEditing(null);
            setSaved("counter");
          }}
          onReload={() => {
            setEditing(null);
            void sscc.refetch();
          }}
        />
      )}
    </>
  );
}
```

`apps/standalone/src/office/nav.ts` — в массив после пункта профиля добавить:

```ts
  {
    to: "/sscc",
    labelKey: "office.nav.sscc",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
```

`apps/standalone/src/office/routes.tsx`: добавить импорт `import { SsccPage } from "./sscc/SsccPage.js";` и в `children` после `{ path: "org", … }` — `{ path: "sscc", element: <SsccPage /> },`.

`apps/standalone/src/i18n/ru.json`: в `office.nav` добавить `"sscc": "SSCC"`; в `office` добавить объект:

```json
    "sscc": {
      "title": "SSCC",
      "countersTitle": "Счётчики номеров",
      "countersIntro": "Следующий номер получит следующий короб или паллета. Номера только растут.",
      "current": "текущий",
      "table": {
        "prefix": "Префикс",
        "kind": "Что нумерует",
        "next": "Следующий номер",
        "max": "Последний номер",
        "actions": "Действия"
      },
      "kinds": {
        "box": "Короба",
        "pallet": "Паллеты",
        "other": "Расширение {{extension}}"
      },
      "edit": "Изменить",
      "editNamed": "Изменить счётчик: {{kind}}, префикс {{prefix}}",
      "counterDialog": {
        "title": "{{kind}}: префикс {{prefix}}",
        "intro": "Счётчик можно только увеличить: меньшие номера уже могли быть напечатаны. Увеличьте его, если SSCC печатали и другой программой.",
        "field": "Следующий номер",
        "hint": "От {{min}} до {{max}}"
      },
      "blocksTitle": "Блоки номеров",
      "blocksIntro": "Станция заранее получает блок номеров и печатает из него, даже когда нет связи с хостом.",
      "boxBlock": "Номеров в блоке для коробов",
      "boxBlockHint": "От 1 до 100 000",
      "palletBlock": "Номеров в блоке для паллет",
      "palletBlockHint": "От 1 до 10 000",
      "errors": {
        "belowFloor": "Номер должен быть не меньше {{min}}",
        "range": "Укажите целое число от {{min}} до {{max}}",
        "boxBlock": "Укажите целое число от 1 до 100 000",
        "palletBlock": "Укажите целое число от 1 до 10 000"
      }
    },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx`
Expected: PASS.

Если `Table` из `@markiro/ui` не отдаёт строкам роль `row` (тест `counterRows`), не меняйте компонент: найдите строки через `within(table).getAllByRole("row")` по фактической разметке `packages/ui/src/components/Table.tsx` и опишите это в отчёте.

- [ ] **Step 6: Проверки и коммит**

Run: пакетные `test`, `typecheck`, `lint`, `build` — зелёные; `node_modules/.bin/prettier --check` по изменённым файлам; `git diff --check`.

```bash
git add apps/standalone/src/office/sscc apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/sscc-page.test.tsx
git commit -m "feat(standalone): страница SSCC в офисе — счётчики и блоки номеров" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Пользователи офиса

Администратор ведёт офисных пользователей: добавляет их, меняет имя, роль и доступ, задаёт пароль. Раздел «Доступ» → «Пользователи» виден только администратору. Если роль сменилась за время сессии, маршрут показывает «Нет доступа». Свою строку администратор меняет только в части имени — роль и доступ у себя меняет другой администратор, а пароль себе — «Сменить пароль» в шапке.

**Files:**

- Create: `apps/standalone/src/office/RequireRole.tsx`
- Create в `apps/standalone/src/office/users/`: `OfficeUsersPage.tsx`, `CreateUserDialog.tsx`, `EditUserDialog.tsx`, `SetPasswordDialog.tsx`, `RoleRadios.tsx`, `user-forms.ts`
- Create: `apps/standalone/test/users-page.test.tsx`
- Modify: `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/office.tsx`
- Modify: `apps/standalone/AGENTS.md`, `apps/standalone/README.md`

**Interfaces:**

- Consumes:
  - `useOfficeQuery`, `useOfficeMutation`, `officeKeys` (задача 3); `writeFailure`, `PageLoading`, `LoadError`, `StaleAlert`, `office.common.*` (задача 5);
  - `loginRule`, `personNameRule`, `passwordRule` (задача 4); `officeRoleSchema` (`src/host/protocol.ts`);
  - `HostApi.listUsers`, `createUser`, `updateUser`, `setUserPassword` (задача 3); `OfficeSessionValue.user` и `refreshUser` (задача 3).
- Produces:
  - `RequireRole({ roles: readonly OfficeRole[]; children: ReactNode })`;
  - `OfficeUsersPage` на маршруте `/users` под `RequireRole roles={["admin"]}`;
  - `test/support/office.tsx`: `OFFICE_USERS: OfficeUserRecord[]`.

- [ ] **Step 1: Фикстура и падающие тесты**

В `apps/standalone/test/support/office.tsx` добавить `OfficeUserRecord` в импорт типов и в конец файла:

```tsx
/** The signed-in administrator (the `SESSION` user) and the technologist. */
export const OFFICE_USERS: OfficeUserRecord[] = [
  {
    id: SESSION.user.id,
    login: "admin",
    name: "Ирина Смирнова",
    role: "admin",
    active: true,
    createdAt: "2026-09-26T09:15:00Z",
    rev: 1,
  },
  {
    id: TECHNOLOGIST.id,
    login: "tech",
    name: "Павел Орлов",
    role: "technologist",
    active: true,
    createdAt: "2026-09-26T09:20:00Z",
    rev: 3,
  },
];
```

(константа `TECHNOLOGIST` уже объявлена выше в этом файле; `OFFICE_USERS` должна идти после неё).

Create `apps/standalone/test/users-page.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import { Office } from "../src/office/Office.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { RequireRole } from "../src/office/RequireRole.js";
import {
  fakeOfficeSession,
  OFFICE_USERS,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const TECH_ID = TECHNOLOGIST.id;

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listUsers.mockResolvedValue(OFFICE_USERS);
  return session;
}

async function openUsers(session: FakeOfficeSession) {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Пользователи" }));
  await screen.findByText("Павел Орлов");
  return view;
}

function rowOf(login: string): HTMLElement {
  const row = screen.getByText(login).closest("tr");
  if (!row) throw new Error(`no row for ${login}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office users", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for administrators only", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
    expect(screen.queryByText("Доступ")).toBeNull();
  });

  it("shows no access to a role that may not open the page", () => {
    render(
      <OfficeSessionProvider value={fakeOfficeSession({ user: TECHNOLOGIST })}>
        <RequireRole roles={["admin"]}>
          <p>Секрет</p>
        </RequireRole>
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByText("Секрет")).toBeNull();
  });

  it("closes the page when the user's role changes to technologist", async () => {
    const session = adminSession();
    const view = await openUsers(session);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={{ ...session, user: { ...session.user, role: "technologist" } }} />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
  });

  it("lists the users and marks the signed-in one", async () => {
    await openUsers(adminSession());
    const own = rowOf("admin");
    expect(within(own).getByText("это вы")).toBeTruthy();
    expect(within(own).getByText("Администратор")).toBeTruthy();
    expect(within(own).queryByRole("button", { name: /Задать пароль/ })).toBeNull();
    const tech = rowOf("tech");
    expect(within(tech).getByText("Технолог")).toBeTruthy();
    expect(within(tech).getByText("Входит в офис")).toBeTruthy();
    expect(
      within(tech).getByRole("button", { name: "Задать пароль пользователю tech" }),
    ).toBeTruthy();
  });

  it("adds a user", async () => {
    const session = adminSession();
    session.api.createUser.mockResolvedValue({
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      login: "anna",
      name: "Анна Козлова",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T10:00:00Z",
      rev: 9,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", " anna ");
    type("Имя", "Анна Козлова");
    type("Пароль", "anna long password");
    type("Повторите пароль", "anna long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пользователь anna добавлен.")).toBeTruthy();
    expect(session.api.createUser).toHaveBeenCalledWith("office-session-token", {
      login: "anna",
      name: "Анна Козлова",
      role: "technologist",
      password: "anna long password",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("anna")).toBeTruthy();
  });

  it("says when the login is taken", async () => {
    const session = adminSession();
    session.api.createUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "this login is already taken",
        details: { constraint: "login" },
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "tech");
    type("Имя", "Павел Второй");
    type("Пароль", "another long password");
    type("Повторите пароль", "another long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Этот логин уже занят")).toBeTruthy();
  });

  it("checks the repeated password before calling the host", async () => {
    const session = adminSession();
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "anna");
    type("Имя", "Анна Козлова");
    type("Пароль", "anna long password");
    type("Повторите пароль", "a different password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(session.api.createUser).not.toHaveBeenCalled();
  });

  it("changes another user's role and access with the loaded revision", async () => {
    const session = adminSession();
    session.api.updateUser.mockResolvedValue({
      ...OFFICE_USERS[1]!,
      role: "admin",
      active: false,
      rev: 10,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Администратор" }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Может входить в офис" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateUser).toHaveBeenCalledWith("office-session-token", TECH_ID, {
      name: "Павел Орлов",
      role: "admin",
      active: false,
      expectedRev: 3,
    });
    expect(within(rowOf("tech")).getByText("Выключен")).toBeTruthy();
    expect(session.refreshUser).not.toHaveBeenCalled();
  });

  it("lets administrators rename themselves but not change their own role or access", async () => {
    const session = adminSession();
    session.api.updateUser.mockResolvedValue({
      ...OFFICE_USERS[0]!,
      name: "Ирина Орлова",
      rev: 11,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя admin" }));
    expect(within(dialog()).getByRole("radio", { name: "Технолог" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog()).getByRole("checkbox", { name: "Может входить в офис" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(dialog()).getByText("Свою роль и доступ может изменить только другой администратор."),
    ).toBeTruthy();
    type("Имя", "Ирина Орлова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateUser).toHaveBeenCalledWith(
      "office-session-token",
      OFFICE_USERS[0]!.id,
      { name: "Ирина Орлова", role: "admin", active: true, expectedRev: 1 },
    );
    // The header shows the signed-in user's name: the shell reads it again.
    expect(session.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("explains the last administrator rule", async () => {
    const session = adminSession();
    session.api.updateUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "last_admin",
        status: 409,
        message: "the last administrator cannot be demoted",
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    type("Имя", "Павел Орлов-Старший");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText("Нельзя выключить или понизить последнего администратора."),
    ).toBeTruthy();
  });

  it("offers to load the users again after a stale change", async () => {
    const session = adminSession();
    session.api.updateUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 12 },
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    type("Имя", "Павел Орлов-Старший");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listUsers).toHaveBeenCalledTimes(2));
  });

  it("sets another user's password", async () => {
    const session = adminSession();
    session.api.setUserPassword.mockResolvedValue(undefined);
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Задать пароль пользователю tech" }));
    expect(
      within(dialog()).getByText(
        "Пользователь войдёт с новым паролем; его сессии на всех устройствах закроются.",
      ),
    ).toBeTruthy();
    type("Пароль", "a brand new password");
    type("Повторите пароль", "a brand new password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Задать пароль" }));
    expect(await screen.findByText("Пароль пользователя tech изменён.")).toBeTruthy();
    expect(session.api.setUserPassword).toHaveBeenCalledWith("office-session-token", TECH_ID, {
      password: "a brand new password",
    });
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx`
Expected: FAIL — нет `src/office/RequireRole.tsx`.

- [ ] **Step 2: Защита маршрута по роли**

Create `apps/standalone/src/office/RequireRole.tsx`:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@markiro/ui";

import type { OfficeRole } from "../host/protocol.js";
import { useOfficeSession } from "./office-session.js";

export interface RequireRoleProps {
  roles: readonly OfficeRole[];
  children: ReactNode;
}

/**
 * A route only these roles may open (spec §4.8). The menu hides it from the
 * others; this covers a role that changed while the page was open. The host
 * enforces the rule itself.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  if (roles.includes(user.role)) return children;
  return <EmptyState title={t("office.noAccess.title")} hint={t("office.noAccess.hint")} />;
}
```

- [ ] **Step 3: Схемы форм и выбор роли**

Create `apps/standalone/src/office/users/user-forms.ts`:

```ts
import { z } from "zod";

import { officeRoleSchema } from "../../host/protocol.js";
import { loginRule, passwordRule, personNameRule } from "../../lib/rules.js";

const repeated = { message: "rules.passwordConfirm", path: ["confirm"] };

/** A new office user; `confirm` repeats the password. */
export const newUserSchema = z
  .object({
    login: loginRule,
    name: personNameRule,
    role: officeRoleSchema,
    password: passwordRule,
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, repeated);
export type NewUserValues = z.input<typeof newUserSchema>;

/** Name, role and access of an existing office user. */
export const userEditSchema = z.object({
  name: personNameRule,
  role: officeRoleSchema,
  active: z.boolean(),
});
export type UserEditValues = z.input<typeof userEditSchema>;

/** A password an administrator sets for someone else. */
export const passwordSetFormSchema = z
  .object({ password: passwordRule, confirm: z.string() })
  .refine((values) => values.password === values.confirm, repeated);
export type PasswordSetValues = z.input<typeof passwordSetFormSchema>;
```

Create `apps/standalone/src/office/users/RoleRadios.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { RadioGroup } from "@markiro/ui";

import { officeRoleSchema, type OfficeRole } from "../../host/protocol.js";

export interface RoleRadiosProps {
  value: OfficeRole;
  onChange: (role: OfficeRole) => void;
  disabled: boolean;
  /** Why the role cannot change, when it cannot. */
  hint: string | null;
}

export function RoleRadios({ value, onChange, disabled, hint }: RoleRadiosProps) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      label={t("office.users.fields.role")}
      options={[
        { value: "technologist", label: t("office.users.roles.technologist") },
        { value: "admin", label: t("office.users.roles.admin") },
      ]}
      value={value}
      onValueChange={(next) => {
        const role = officeRoleSchema.safeParse(next);
        if (role.success) onChange(role.data);
      }}
      disabled={disabled}
      {...(hint === null ? {} : { hint })}
    />
  );
}
```

- [ ] **Step 4: Диалоги**

Create `apps/standalone/src/office/users/CreateUserDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { RoleRadios } from "./RoleRadios.js";
import { newUserSchema, type NewUserValues } from "./user-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", password: "password" } as const;

export interface CreateUserDialogProps {
  onClose: () => void;
  onCreated: (user: OfficeUserRecord) => void;
}

export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const create = useOfficeMutation((api, token, values: NewUserValues) =>
    api.createUser(token, {
      login: values.login,
      name: values.name,
      role: values.role,
      password: values.password,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { login: "", name: "", role: "technologist", password: "", confirm: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onCreated(await create.mutateAsync(values));
    } catch (error) {
      if (
        error instanceof HostError &&
        error.code === "conflict" &&
        error.details.constraint === "login"
      ) {
        setError("login", { type: "server", message: "office.users.errors.loginTaken" });
        return;
      }
      const outcome = writeFailure(error, CREATE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome.kind === "alert" ? outcome.message : "errors.api.stale_revision");
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.createTitle")}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting}>
            {t("office.users.create")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure && <Alert tone="error">{t(failure)}</Alert>}
        <Input
          label={t("office.users.fields.login")}
          hint={t("office.users.fields.loginHint")}
          autoComplete="off"
          mono
          {...fieldError(errors.login?.message)}
          {...register("login")}
        />
        <Input
          label={t("office.users.fields.name")}
          {...fieldError(errors.name?.message)}
          {...register("name")}
        />
        <Controller
          control={control}
          name="role"
          render={({ field }) => (
            <RoleRadios
              value={field.value}
              onChange={field.onChange}
              disabled={false}
              hint={null}
            />
          )}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.users.fields.password")}
          hint={t("office.users.fields.passwordHint")}
          {...fieldError(errors.password?.message)}
          {...register("password")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.users.fields.confirm")}
          {...fieldError(errors.confirm?.message)}
          {...register("confirm")}
        />
      </form>
    </Modal>
  );
}
```

Create `apps/standalone/src/office/users/EditUserDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Modal } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";
import { RoleRadios } from "./RoleRadios.js";
import { userEditSchema, type UserEditValues } from "./user-forms.js";

const EDIT_FIELDS = { name: "name", role: "role", active: "active" } as const;

export interface EditUserDialogProps {
  user: OfficeUserRecord;
  /** The signed-in administrator's own record: only the name can change. */
  own: boolean;
  onClose: () => void;
  onSaved: (user: OfficeUserRecord) => void;
  /** The record changed on the host: close and load the users again. */
  onReload: () => void;
}

export function EditUserDialog({ user, own, onClose, onSaved, onReload }: EditUserDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, values: UserEditValues) =>
    api.updateUser(token, user.id, {
      name: values.name,
      role: values.role,
      active: values.active,
      expectedRev: user.rev,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<UserEditValues>({
    resolver: zodResolver(userEditSchema),
    defaultValues: { name: user.name, role: user.role, active: user.active },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.editTitle", { login: user.login })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting} disabled={!isDirty}>
            {t("office.common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
        {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
        <Input
          label={t("office.users.fields.name")}
          {...fieldError(errors.name?.message)}
          {...register("name")}
        />
        <Controller
          control={control}
          name="role"
          render={({ field }) => (
            <RoleRadios
              value={field.value}
              onChange={field.onChange}
              disabled={own}
              hint={own ? t("office.users.ownHint") : null}
            />
          )}
        />
        <Controller
          control={control}
          name="active"
          render={({ field }) => (
            <Checkbox
              label={t("office.users.fields.active")}
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={own}
            />
          )}
        />
      </form>
    </Modal>
  );
}
```

Create `apps/standalone/src/office/users/SetPasswordDialog.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { passwordSetFormSchema, type PasswordSetValues } from "./user-forms.js";

const PASSWORD_FIELDS = { password: "password" } as const;

export interface SetPasswordDialogProps {
  user: OfficeUserRecord;
  onClose: () => void;
  onChanged: () => void;
}

/** An administrator sets someone else's password; the host ends that user's sessions. */
export function SetPasswordDialog({ user, onClose, onChanged }: SetPasswordDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const set = useOfficeMutation((api, token, password: string) =>
    api.setUserPassword(token, user.id, { password }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordSetValues>({
    resolver: zodResolver(passwordSetFormSchema),
    defaultValues: { password: "", confirm: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      await set.mutateAsync(values.password);
      onChanged();
    } catch (error) {
      const outcome = writeFailure(error, PASSWORD_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome.kind === "alert" ? outcome.message : "errors.api.stale_revision");
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.passwordTitle", { login: user.login })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting}>
            {t("office.users.passwordSubmit")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure && <Alert tone="error">{t(failure)}</Alert>}
        <p>{t("office.users.passwordNote")}</p>
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.users.fields.password")}
          hint={t("office.users.fields.passwordHint")}
          {...fieldError(errors.password?.message)}
          {...register("password")}
        />
        <Input
          type="password"
          autoComplete="new-password"
          label={t("office.users.fields.confirm")}
          {...fieldError(errors.confirm?.message)}
          {...register("confirm")}
        />
      </form>
    </Modal>
  );
}
```

- [ ] **Step 5: Страница**

Create `apps/standalone/src/office/users/OfficeUsersPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { CreateUserDialog } from "./CreateUserDialog.js";
import { EditUserDialog } from "./EditUserDialog.js";
import { SetPasswordDialog } from "./SetPasswordDialog.js";

type UsersDialog =
  | { kind: "create" }
  | { kind: "edit"; user: OfficeUserRecord }
  | { kind: "password"; user: OfficeUserRecord };

/** Replace or add `user`, keeping the host's order (by login, case-insensitive). */
function withUser(list: readonly OfficeUserRecord[], user: OfficeUserRecord): OfficeUserRecord[] {
  return [...list.filter((each) => each.id !== user.id), user].sort((a, b) =>
    a.login.localeCompare(b.login, undefined, { sensitivity: "base" }),
  );
}

/** Office users (spec §4.8, administrators only; the route is wrapped in `RequireRole`). */
export function OfficeUsersPage() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const users = useOfficeQuery(officeKeys.users, (api, token) => api.listUsers(token));
  const [dialog, setDialog] = useState<UsersDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: UsersDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const store = (user: OfficeUserRecord) => {
    queryClient.setQueryData<OfficeUserRecord[]>(officeKeys.users, (list) =>
      withUser(list ?? [], user),
    );
  };

  const columns: TableColumn<OfficeUserRecord>[] = [
    {
      key: "login",
      title: t("office.users.table.login"),
      mono: true,
      render: (user) => user.login,
    },
    {
      key: "name",
      title: t("office.users.table.name"),
      render: (user) => (
        <>
          {user.name}
          {user.id === session.user.id && (
            <>
              {" "}
              <Badge tone="info">{t("office.users.you")}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: "role",
      title: t("office.users.table.role"),
      render: (user) => t(`office.users.roles.${user.role}`),
    },
    {
      key: "status",
      title: t("office.users.table.status"),
      render: (user) => (
        <StatusChip
          phase={user.active ? "active" : "retired"}
          label={t(user.active ? "office.users.status.active" : "office.users.status.inactive")}
        />
      ),
    },
    {
      key: "actions",
      title: t("office.users.table.actions"),
      render: (user) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.users.editNamed", { login: user.login })}
            onClick={() => open({ kind: "edit", user })}
          >
            {t("office.users.edit")}
          </Button>
          {user.id !== session.user.id && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.users.passwordNamed", { login: user.login })}
              onClick={() => open({ kind: "password", user })}
            >
              {t("office.users.password")}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (users.isPending) return <PageLoading />;
    if (users.isError)
      return <LoadError error={users.error} onRetry={() => void users.refetch()} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={users.data}
          getRowKey={(user) => user.id}
          scrollLabel={t("office.users.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.users.title")}
        actions={<Button onClick={() => open({ kind: "create" })}>{t("office.users.add")}</Button>}
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {dialog?.kind === "create" && (
        <CreateUserDialog
          onClose={() => setDialog(null)}
          onCreated={(user) => {
            store(user);
            setDialog(null);
            setNotice(t("office.users.created", { login: user.login }));
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditUserDialog
          user={dialog.user}
          own={dialog.user.id === session.user.id}
          onClose={() => setDialog(null)}
          onSaved={(user) => {
            store(user);
            setDialog(null);
            setNotice(t("office.common.saved"));
            // The header shows the signed-in user's own name.
            if (user.id === session.user.id) void session.refreshUser().catch(() => undefined);
          }}
          onReload={() => {
            setDialog(null);
            void users.refetch();
          }}
        />
      )}
      {dialog?.kind === "password" && (
        <SetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onChanged={() => {
            setDialog(null);
            setNotice(t("office.users.passwordSet", { login: dialog.user.login }));
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 6: Меню, маршрут и тексты**

`apps/standalone/src/office/nav.ts` — в конец массива:

```ts
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
```

`apps/standalone/src/office/routes.tsx`: добавить импорты `import { RequireRole } from "./RequireRole.js";` и `import { OfficeUsersPage } from "./users/OfficeUsersPage.js";` и в `children` после маршрута `sscc`:

```tsx
      {
        path: "users",
        element: (
          <RequireRole roles={["admin"]}>
            <OfficeUsersPage />
          </RequireRole>
        ),
      },
```

`apps/standalone/src/i18n/ru.json`:

- в `office.nav.sections` добавить `"access": "Доступ"`, в `office.nav` — `"users": "Пользователи"`;
- в `office` добавить объекты:

```json
    "users": {
      "title": "Пользователи офиса",
      "add": "Добавить пользователя",
      "table": {
        "login": "Логин",
        "name": "Имя",
        "role": "Роль",
        "status": "Доступ",
        "actions": "Действия"
      },
      "you": "это вы",
      "roles": {
        "admin": "Администратор",
        "technologist": "Технолог"
      },
      "status": {
        "active": "Входит в офис",
        "inactive": "Выключен"
      },
      "edit": "Изменить",
      "editNamed": "Изменить пользователя {{login}}",
      "password": "Задать пароль",
      "passwordNamed": "Задать пароль пользователю {{login}}",
      "createTitle": "Новый пользователь",
      "create": "Добавить",
      "editTitle": "Пользователь {{login}}",
      "passwordTitle": "Пароль пользователя {{login}}",
      "passwordSubmit": "Задать пароль",
      "fields": {
        "login": "Логин",
        "loginHint": "Латиница, цифры, точка, дефис, подчёркивание; от 3 до 64 символов",
        "name": "Имя",
        "role": "Роль",
        "password": "Пароль",
        "passwordHint": "От 8 до 128 символов",
        "confirm": "Повторите пароль",
        "active": "Может входить в офис"
      },
      "ownHint": "Свою роль и доступ может изменить только другой администратор.",
      "passwordNote": "Пользователь войдёт с новым паролем; его сессии на всех устройствах закроются.",
      "created": "Пользователь {{login}} добавлен.",
      "passwordSet": "Пароль пользователя {{login}} изменён.",
      "errors": {
        "loginTaken": "Этот логин уже занят"
      }
    },
    "noAccess": {
      "title": "Нет доступа",
      "hint": "Этот раздел доступен только администратору."
    },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx`
Expected: PASS.

Если радиокнопки или флажок `@markiro/ui` (Radix) в jsdom не переключаются по `fireEvent.click`, не меняйте компоненты `@markiro/ui`: посмотрите, как их нажимают тесты `packages/ui` (`grep -rn "radio\|checkbox" packages/ui/test`), сделайте так же и опишите это в отчёте.

- [ ] **Step 7: Документы**

1. `apps/standalone/AGENTS.md`, раздел «Office pages», добавить пункт:

```markdown
- Roles (spec §4.8) are enforced by the host. The office hides menu items by
  role (`OFFICE_NAV`) and wraps administrator-only routes in `RequireRole`,
  which shows «Нет доступа» when a role changes mid-session. An
  administrator's own row in «Пользователи» changes only the name: another
  administrator changes their role or access.
```

2. `apps/standalone/README.md`, в конец пункта 2 раздела «Development» (после предложения про `device.json`) добавить абзац с тем же отступом:

```markdown
In the office an administrator edits the organization profile, the SSCC
counters and block sizes, and the office users; a technologist sees the
organization and SSCC read-only. «Выйти в цех» ends the office session.
```

- [ ] **Step 8: Проверки и коммит**

Run: пакетные `test`, `typecheck`, `lint`, `build` — зелёные; `node_modules/.bin/prettier --check` по изменённым файлам; `git diff --check`.

```bash
git add apps/standalone/src/office/RequireRole.tsx apps/standalone/src/office/users apps/standalone/src/office/nav.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/users-page.test.tsx apps/standalone/AGENTS.md apps/standalone/README.md
git commit -m "feat(standalone): пользователи офиса — список, добавление, роль, доступ и пароль" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы) — все тесты PASS, без предупреждений.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `git diff --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — зелёные.
- [ ] `node --test tools/ci/test/affected.test.mjs` — зелёный; `node_modules/.bin/prettier --check` по изменённым файлам — чисто.
- [ ] В отчёте отдельно:
  - окно `tauri dev` вручную не открывалось — нет графической сессии; шов IPC закрепляет `src-tauri/tests/ipc.rs` на мок-среде Tauri;
  - задание `standalone-windows-build`, DPAPI на настоящем профиле Windows и служба Windows не проверялись.
