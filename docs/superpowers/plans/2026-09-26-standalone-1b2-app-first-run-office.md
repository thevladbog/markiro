# План 1b2: первый запуск и вход в офис в приложении — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на одном ПК приложение само находит хост: на ненастроенном хосте проводит мастер первого запуска (подключение этого компьютера, администратор, организация, номера SSCC, линии), на настроенном — подключается само; из экрана цеха можно войти в офис по логину и паролю и выйти из него.

**Architecture:** Rust-оболочка (`src-tauri`) хранит `device.json` с ключом устройства под защитой DPAPI (Windows) или в файле `0600`, ходит на хост только клиентом с закреплённым отпечатком сертификата и отдаёт вебвью команды `device_status`, `host_local_pair`, `host_request`, `device_forget`; ключ устройства вебвью не видит. Вебвью — чистый автомат состояний оболочки (`nextShellView`) поверх снимка, мастер на `react-hook-form`, офис под `createMemoryRouter` с сессией в памяти. Ошибки хоста разбираются по коду и `details.credential`: `device` — переподключить устройство, `session` — войти снова, `password` — ошибка формы.

**Tech Stack:** Rust (Tauri 2.11, reqwest 0.13.4 + rustls/aws-lc-rs, windows-sys 0.61.2 для DPAPI), React 19, react-router 8.3.0, react-hook-form 7.85.0 + @hookform/resolvers 5.9.1, zod 4.4.3, @markiro/domain, @markiro/ui, Vitest + Testing Library.

**Спецификации:** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (раздел 5 — приложение, раздел 6 — контракт протокола; этот план — приложенческая половина строки 1b раздела 8); API хоста — план `docs/superpowers/plans/2026-09-26-standalone-1b1-host-office-api.md` вместе с его разделом «Отклонения при исполнении». Экраны офиса «Организация», «SSCC» и «Пользователи» — следующий план 1b3.

## Global Constraints

- Вебвью не выполняет HTTP: все обращения к хосту — команды Rust-оболочки. CSP в `tauri.conf.json` не меняется (`connect-src 'self' ipc: http://ipc.localhost`).
- Команды оболочки: `host_hello(address)` (есть с плана 1a), `device_status() -> DeviceStatus | null`, `host_local_pair(name) -> DeviceStatus`, `host_request(method, path, body, officeToken) -> { status, body }`, `device_forget()`. Отказ команды — строка-код: `config_unreadable`, `storage`, `not_paired`, `already_paired`, `unreachable`, `not_markiro_host`, `invalid_response`, `host_too_old`, `app_too_old`, `certificate_mismatch`, `invalid_request`, `pair_rejected`, `host_changed`.
- Аутентифицированные запросы принимают соединение только при совпадении SHA-256 сертификата хоста с отпечатком, сохранённым при подключении; без прокси и перенаправлений; соединение — 2 с, запрос — 10 с; заголовок `x-markiro-protocol: 1` в каждом запросе. `host_request` пропускает только методы `GET`, `POST`, `PUT`, `DELETE` и пути `/v1/…` из символов `[A-Za-z0-9/_.~?=&%-]` без `..` и `//`, до 512 символов.
- Ключ устройства хранится только защищённым: DPAPI текущего пользователя на Windows (схема `dpapi`), иначе как есть в `device.json` с правами `0600` (схема `plain`); схема записана рядом со значением, чужая схема — ошибка `config_unreadable`. Ключ не пересекает IPC и не попадает в журналы; `Debug` секретных типов его не печатает.
- `device.json` — в каталоге конфигурации приложения (`app_config_dir`), запись атомарная: временный файл `0600`, `fsync`, `rename`, `fsync` каталога (Unix).
- Локальное подключение — только к `https://127.0.0.1:45710` (`markiro_proto::DEFAULT_PORT`), тип устройства `station`, имя устройства — строка i18n `device.localName`; одновременные вызовы подключения сериализуются, второй получает `already_paired`.
- Токен офисной сессии живёт только в памяти вебвью (состояние React), в Rust уходит с каждым запросом и нигде не сохраняется. «Выйти» вызывает `POST /v1/office/logout` и возвращает в цех; «В цех» прячет офис, сессия остаётся, пока хост не закроет её по бездействию.
- Разбор ошибок: `unauthorized` с `details.credential = device` и транспортная `certificate_mismatch` — экран «Хост не принимает это устройство» с переподключением; `credential = session` — экран входа в офис с пометкой «сессия закончилась»; `credential = password` — ошибка формы входа.
- Новые JS-зависимости `@markiro/standalone` (точные версии, как в `apps/admin`): `@markiro/domain` `workspace:*`, `react-router` `8.3.0`, `react-hook-form` `7.85.0`, `@hookform/resolvers` `5.9.1`. Новые Rust-зависимости `markiro-standalone`: `thiserror = "2"`, `tokio = { version = "=1.53.1", features = ["sync"] }`; только для Windows — `base64 = "=0.22.1"`, `windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }`. Других зависимостей не добавлять.
- Схемы Zod: полезная нагрузка, которую пересобирает Rust (`hello`, `DeviceStatus`, обёртка ответа `{ status, body }`), — строгая (`.strict()`); тела ответов хоста — нестрогие; тела запросов — строгие, как `deny_unknown_fields` на хосте.
- Весь текст интерфейса — через i18n (`src/i18n/ru.json`); отсутствующий ключ роняет тесты. Только компоненты `@markiro/ui`: ESLint запрещает нативные элементы форм в `apps/standalone/src`.
- Формы проверяют поля правилами хоста и `@markiro/domain` до отправки: логин `[A-Za-z0-9._-]{3,64}`, пароль 8–128 символов, GLN — 13 цифр с верной контрольной цифрой (`hasValidCheckDigit`), префикс GS1 — 4–12 цифр (не больше 10), ИНН — пусто, 10 или 12 цифр, номер SSCC — целое от 1 (короб) или 0 (паллета) меньше `ssccSerialCapacity(первые 9 цифр GLN)`, 1–20 линий по 1–100 символов без повторов без учёта регистра.
- `apps/station` не меняется. Коммиты — явные пути, трейлер ровно `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Заметки для исполнения

- Перед каждым коммитом: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` и `… --all -- --check` (для Rust); `node_modules/.bin/prettier --write <изменённые TS/JSON/MD-файлы>` и `--check`; `git diff --check`.
- Cargo в песочнице не пишет в `~/.cargo`: все крейты уже скачаны, используйте `--offline`; если cargo всё же просит скачать или распаковать крейт («Operation not permitted» на `~/.cargo»), повторите команду вне песочницы. Тесты, которые слушают 127.0.0.1 (`host/tests/hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `src-tauri/tests/device.rs`), запускайте вне песочницы.
- Крейт `markiro-standalone` при компиляции встраивает `apps/standalone/dist`: если каталога нет, сначала `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`.
- pnpm в песочнице: каждую команду запускайте с `--config.verifyDepsBeforeRun=false` (иначе pnpm сносит `node_modules`); `pnpm add` в песочнице падает `ERR_PNPM_UNEXPECTED_STORE` — запускайте его вне песочницы. `pnpm install` не запускать.
- После добавления `@markiro/domain` вебвью читает его собранный `dist`: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- Код Windows (`secret_store::dpapi`) на macOS не компилируется в составе крейта (C-зависимости Tauri); проверяйте его отдельно: см. шаг задачи 2.
- Не использовать `git stash`; не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.

## Файлы

```
apps/standalone/proto/src/lib.rs, proto/tests/fixtures.rs                 задача 1 (Secret)
apps/standalone/host/src/routes/{pairing,office_auth,bootstrap,office_users}.rs   задача 1
apps/standalone/src-tauri/Cargo.toml                                      задачи 2–3
apps/standalone/src-tauri/src/secret_store.rs                             задача 2
apps/standalone/src-tauri/src/device_config.rs                            задача 2
apps/standalone/src-tauri/src/tls.rs                                      задача 3
apps/standalone/src-tauri/src/host_client.rs                              задача 3
apps/standalone/src-tauri/src/device.rs                                   задача 3
apps/standalone/src-tauri/src/host_probe.rs, src/lib.rs                   задача 3
apps/standalone/src-tauri/tests/device.rs                                 задача 3
apps/standalone/package.json, pnpm-lock.yaml                              задача 4
apps/standalone/src/host/protocol.ts, test/protocol.test.ts, test/phc-contract.test.ts   задача 4
eslint.config.mjs, tools/ci/affected.mjs, tools/ci/test/affected.test.mjs задача 4
apps/standalone/src/host/{client,device,api,errors}.ts, test/{client,device,errors}.test.ts   задача 5
apps/standalone/src/lib/form-error.ts                                     задача 6
apps/standalone/src/wizard/{wizard-form.ts,BootstrapWizard.tsx}, test/{wizard-form,wizard}.test.ts(x), test/support/*   задача 6
apps/standalone/src/office/*, test/office.test.tsx                        задача 7
apps/standalone/src/app/{shell.ts,screens.tsx,App.tsx}, test/{shell.test.ts,app.test.tsx}   задача 8
apps/standalone/src/i18n/ru.json, src/app/shell.css                       задачи 5–8
apps/standalone/AGENTS.md, apps/standalone/README.md                      задача 9
```

---

### Task 1: Секреты протокола не печатаются в `Debug`

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/host/src/routes/pairing.rs`, `apps/standalone/host/src/routes/office_auth.rs`, `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/host/src/routes/office_users.rs`

**Interfaces:**

- Produces: `markiro_proto::Secret` — `#[serde(transparent)]` обёртка над `String` с `new(impl Into<String>)`, `expose(&self) -> &str`, `From<String>`, `Debug` → `Secret(***)`. Поля типа `Secret`: `PairResponse.device_key`, `OfficeLoginRequest.password`, `OfficeSession.token`, `NewOfficeUser.password`, `OfficeUserCreate.password`, `PasswordSet.password`. JSON-форма и фикстуры не меняются.

- [ ] **Step 1: Написать падающий тест**

В `apps/standalone/proto/tests/fixtures.rs` добавить к импорту `use markiro_proto::{…}` имена, которых там ещё нет, из списка `BootstrapRequest, OfficeLoginRequest, OfficeSession, OfficeUserCreate, PairResponse, PasswordSet` и тест:

```rust
#[test]
fn secrets_never_appear_in_debug_output() {
    let pair: PairResponse = serde_json::from_value(fixture("pair-response.json")).unwrap();
    let login: OfficeLoginRequest =
        serde_json::from_value(fixture("office-login-request.json")).unwrap();
    let session: OfficeSession = serde_json::from_value(fixture("office-session.json")).unwrap();
    let bootstrap: BootstrapRequest =
        serde_json::from_value(fixture("bootstrap-request.json")).unwrap();
    let create: OfficeUserCreate =
        serde_json::from_value(fixture("office-user-create.json")).unwrap();
    let password: PasswordSet = serde_json::from_value(fixture("password-set.json")).unwrap();
    let debug = format!("{pair:?} {login:?} {session:?} {bootstrap:?} {create:?} {password:?}");
    for secret in [
        pair.device_key.expose(),
        login.password.expose(),
        session.token.expose(),
        bootstrap.admin.password.expose(),
        create.password.expose(),
        password.password.expose(),
    ] {
        assert!(!debug.contains(secret), "Debug output leaks a secret");
    }
    assert_eq!(debug.matches("Secret(***)").count(), 6);
}
```

- [ ] **Step 2: Убедиться, что тест не собирается**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures`
Expected: FAIL — нет метода `expose`.

- [ ] **Step 3: Реализовать**

В `apps/standalone/proto/src/lib.rs` сразу после `impl ErrorBody { … }` добавить:

```rust
/// A secret on the wire: a device key, a session token or a password. It
/// serializes as a plain JSON string, but `Debug` never prints the value, so
/// a stray `{:?}` or a `tracing` field cannot leak it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret itself; call only where the value is actually needed.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(***)")
    }
}
```

и заменить тип `String` на `Secret` у полей `PairResponse::device_key`, `OfficeLoginRequest::password`, `OfficeSession::token`, `NewOfficeUser::password`, `OfficeUserCreate::password`, `PasswordSet::password` (атрибуты `derive` и `serde` у этих структур не меняются).

На хосте держать секрет в `Secret` до места использования:

- `host/src/routes/pairing.rs`: при сборке ответа `device_key: key,` → `device_key: key.into(),`.
- `host/src/routes/office_auth.rs`: в замыкании `spawn_blocking` проверки пароля `verify_password(phc, &password)` → `verify_password(phc, password.expose())` (строка `let password = request.password.clone();` остаётся); при сборке `OfficeSession` `token,` → `token: token.into(),`.
- `host/src/routes/bootstrap.rs`: `validate::password("admin.password", &request.admin.password)?;` → `validate::password("admin.password", request.admin.password.expose())?;`; в замыкании хеширования `hash_password(&password)` → `hash_password(password.expose())`; при сборке `OfficeSession` `token,` → `token: token.into(),`.
- `host/src/routes/office_users.rs`: добавить `use markiro_proto::Secret;`; проверки паролей — `validate::password("password", create.password.expose())?;` и `validate::password("password", body.password.expose())?;`; вызовы `hash(create.password)` и `hash(body.password)` остаются, а сам помощник хеширования принимает `Secret`:

```rust
async fn hash(password: Secret) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(password.expose()))
        .await
        .map_err(ApiError::internal)
}
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы: часть тестов хоста слушает 127.0.0.1)
Expected: все тесты PASS, включая `secrets_never_appear_in_debug_output`; фикстуры по-прежнему проходят круговую проверку.

- [ ] **Step 5: Commit**

```bash
git add apps/standalone/proto apps/standalone/host/src/routes
git commit -m "fix(standalone): секреты протокола не печатаются в Debug" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Хранение ключа устройства и `device.json`

**Files:**

- Modify: `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/src/secret_store.rs`, `apps/standalone/src-tauri/src/device_config.rs`

**Interfaces:**

- Produces:
  - `secret_store::{Scheme { Dpapi, Plain }, ProtectedSecret { scheme, value }, SecretStoreError { Protect, Unprotect, WrongScheme(Scheme) }, NATIVE_SCHEME, protect(&str) -> Result<ProtectedSecret, SecretStoreError>, unprotect(&ProtectedSecret) -> Result<String, SecretStoreError>}`.
  - `device_config::{FILE_NAME = "device.json", DeviceConfig { host_address, fingerprint, host_id, device_id, kind: DeviceKind, line_id: Option<String>, device_key: ProtectedSecret }, DeviceConfigError { Io, Parse }, path(&Path) -> PathBuf, load(&Path) -> Result<Option<DeviceConfig>, DeviceConfigError>, save(&Path, &DeviceConfig) -> Result<(), DeviceConfigError>, clear(&Path) -> Result<(), DeviceConfigError>}`.

- [ ] **Step 1: Зависимости**

В `apps/standalone/src-tauri/Cargo.toml` в `[dependencies]` добавить `thiserror = "2"`; после секции `[dependencies]` добавить:

```toml
[target.'cfg(windows)'.dependencies]
base64 = "=0.22.1"
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }
```

В `apps/standalone/src-tauri/src/lib.rs` рядом с `pub mod host_probe;` добавить `pub mod device_config;` и `pub mod secret_store;`.

- [ ] **Step 2: Написать модули с тестами**

`apps/standalone/src-tauri/src/secret_store.rs`:

```rust
//! Protection of the device key at rest (spec §5.2). On Windows the key is
//! encrypted with DPAPI for the current user; elsewhere it is kept as is and
//! the only protection is the owner-only (0600) `device.json`. The scheme is
//! stored next to the value, so a file copied between systems fails loudly
//! instead of yielding garbage.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scheme {
    Dpapi,
    Plain,
}

/// A secret as stored in `device.json`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedSecret {
    pub scheme: Scheme,
    pub value: String,
}

impl std::fmt::Debug for ProtectedSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedSecret")
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretStoreError {
    #[error("the operating system could not protect the secret")]
    Protect,
    #[error("the stored secret cannot be read on this computer")]
    Unprotect,
    #[error("the stored secret uses the {0:?} scheme, which this system cannot read")]
    WrongScheme(Scheme),
}

/// The scheme this build writes and reads.
#[cfg(windows)]
pub const NATIVE_SCHEME: Scheme = Scheme::Dpapi;
#[cfg(not(windows))]
pub const NATIVE_SCHEME: Scheme = Scheme::Plain;

pub fn protect(plaintext: &str) -> Result<ProtectedSecret, SecretStoreError> {
    Ok(ProtectedSecret {
        scheme: NATIVE_SCHEME,
        value: write_native(plaintext)?,
    })
}

pub fn unprotect(secret: &ProtectedSecret) -> Result<String, SecretStoreError> {
    if secret.scheme != NATIVE_SCHEME {
        return Err(SecretStoreError::WrongScheme(secret.scheme));
    }
    read_native(&secret.value)
}

#[cfg(windows)]
fn write_native(plaintext: &str) -> Result<String, SecretStoreError> {
    dpapi::protect(plaintext)
}

#[cfg(windows)]
fn read_native(value: &str) -> Result<String, SecretStoreError> {
    dpapi::unprotect(value)
}

#[cfg(not(windows))]
fn write_native(plaintext: &str) -> Result<String, SecretStoreError> {
    Ok(plaintext.to_owned())
}

#[cfg(not(windows))]
fn read_native(value: &str) -> Result<String, SecretStoreError> {
    Ok(value.to_owned())
}

#[cfg(windows)]
mod dpapi {
    //! Per-user DPAPI, as in `apps/signer/signer-core/src/storage_dpapi.rs`:
    //! the ciphertext is bound to the Windows account that paired the device.

    use std::ptr;

    use base64::Engine as _;
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    use super::SecretStoreError;

    pub fn protect(plaintext: &str) -> Result<String, SecretStoreError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(plaintext.len()).map_err(|_| SecretStoreError::Protect)?,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: `input` borrows `plaintext` for the duration of the call;
        // DPAPI allocates `output` with LocalAlloc and it is freed below.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretStoreError::Protect);
        }
        // SAFETY: DPAPI returned `cbData` initialized bytes at `pbData`.
        let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let encoded = base64::engine::general_purpose::STANDARD.encode(blob);
        // SAFETY: `pbData` was allocated by DPAPI and is not used after this.
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(encoded)
    }

    pub fn unprotect(protected: &str) -> Result<String, SecretStoreError> {
        let mut blob = base64::engine::general_purpose::STANDARD
            .decode(protected)
            .map_err(|_| SecretStoreError::Unprotect)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(blob.len()).map_err(|_| SecretStoreError::Unprotect)?,
            pbData: blob.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretStoreError::Unprotect);
        }
        // SAFETY: as in `protect`.
        let plaintext =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        // SAFETY: as in `protect`.
        unsafe { LocalFree(output.pbData as HLOCAL) };
        String::from_utf8(plaintext).map_err(|_| SecretStoreError::Unprotect)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_the_native_scheme() {
        let protected = protect("device-key-value").unwrap();
        assert_eq!(protected.scheme, NATIVE_SCHEME);
        assert_eq!(unprotect(&protected).unwrap(), "device-key-value");
    }

    #[cfg(windows)]
    #[test]
    fn windows_never_stores_the_plaintext() {
        let protected = protect("device-key-value").unwrap();
        assert_ne!(protected.value, "device-key-value");
        let corrupted = ProtectedSecret {
            scheme: Scheme::Dpapi,
            value: "not-base64-!!".into(),
        };
        assert_eq!(unprotect(&corrupted), Err(SecretStoreError::Unprotect));
    }

    #[test]
    fn a_foreign_scheme_is_refused() {
        let foreign = if NATIVE_SCHEME == Scheme::Dpapi {
            Scheme::Plain
        } else {
            Scheme::Dpapi
        };
        let secret = ProtectedSecret {
            scheme: foreign,
            value: "device-key-value".into(),
        };
        assert_eq!(unprotect(&secret), Err(SecretStoreError::WrongScheme(foreign)));
    }

    #[test]
    fn debug_output_hides_the_value() {
        let secret = ProtectedSecret {
            scheme: Scheme::Plain,
            value: "device-key-value".into(),
        };
        assert!(!format!("{secret:?}").contains("device-key-value"));
    }
}
```

`apps/standalone/src-tauri/src/device_config.rs`:

```rust
//! `device.json` in the app's config directory (spec §5.2): the host this
//! device is paired with and its protected key. Written atomically: a crash
//! leaves either the old file or the new one, never a torn file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use markiro_proto::DeviceKind;
use serde::{Deserialize, Serialize};

use crate::secret_store::ProtectedSecret;

pub const FILE_NAME: &str = "device.json";
const TEMPORARY_NAME: &str = ".device.json.tmp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceConfig {
    /// `https://<host>:<port>` of the paired host.
    pub host_address: String,
    /// Lower-case hex SHA-256 of the host certificate, pinned at pairing.
    pub fingerprint: String,
    pub host_id: String,
    pub device_id: String,
    pub kind: DeviceKind,
    pub line_id: Option<String>,
    pub device_key: ProtectedSecret,
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceConfigError {
    #[error("device config {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("device config {path} is unreadable: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// `Ok(None)` when this device is not paired yet.
pub fn load(dir: &Path) -> Result<Option<DeviceConfig>, DeviceConfigError> {
    let path = path(dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(DeviceConfigError::Io { path, source }),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|source| DeviceConfigError::Parse { path, source })
}

pub fn save(dir: &Path, config: &DeviceConfig) -> Result<(), DeviceConfigError> {
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |source| DeviceConfigError::Io { path, source }
    };
    fs::create_dir_all(dir).map_err(io(dir))?;
    let target = path(dir);
    let temporary = dir.join(TEMPORARY_NAME);
    // A leftover from a crash may have other permissions; start clean.
    let _ = fs::remove_file(&temporary);
    let data = serde_json::to_vec_pretty(config).expect("DeviceConfig serializes");
    write_owner_only(&temporary, &data).map_err(io(&temporary))?;
    if let Err(source) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(DeviceConfigError::Io {
            path: target,
            source,
        });
    }
    sync_dir(dir).map_err(io(dir))
}

pub fn clear(dir: &Path) -> Result<(), DeviceConfigError> {
    let path = path(dir);
    match fs::remove_file(&path) {
        Ok(()) => sync_dir(dir).map_err(|source| DeviceConfigError::Io {
            path: dir.to_path_buf(),
            source,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(DeviceConfigError::Io { path, source }),
    }
}

fn write_owner_only(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()
}

/// Make the rename durable (Unix); Windows commits the rename itself.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store::Scheme;

    fn sample() -> DeviceConfig {
        DeviceConfig {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            kind: DeviceKind::Station,
            line_id: None,
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
                value: "device-key-value".into(),
            },
        }
    }

    #[test]
    fn a_missing_file_means_not_paired() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
    }

    #[test]
    fn saves_atomically_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        let mut changed = sample();
        changed.line_id = Some("2b2d7ab8-2e1c-4a7e-9d2b-7b9b1f3c4d5e".into());
        save(dir.path(), &changed).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(changed));
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_owned()], "no temporary file is left behind");
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        let mode = fs::metadata(path(dir.path())).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_stale_temporary_file_does_not_block_saving() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TEMPORARY_NAME), "left by a crash").unwrap();
        save(dir.path(), &sample()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(sample()));
        assert!(!dir.path().join(TEMPORARY_NAME).exists());
    }

    #[test]
    fn a_corrupt_file_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(path(dir.path()), "{ not json").unwrap();
        assert!(matches!(load(dir.path()), Err(DeviceConfigError::Parse { .. })));
        assert_eq!(fs::read_to_string(path(dir.path())).unwrap(), "{ not json");
    }

    #[test]
    fn clear_removes_the_file_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        clear(dir.path()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        clear(dir.path()).unwrap();
    }
}
```

- [ ] **Step 3: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib`
Expected: PASS — 4 теста `secret_store` (тест Windows пропущен на macOS) и 6 тестов `device_config`, плюс прежние тесты `host_probe`.

- [ ] **Step 4: Проверить код DPAPI под Windows**

Код `#[cfg(windows)]` на macOS в составе крейта не компилируется (C-зависимости Tauri не собираются под `x86_64-pc-windows-msvc`), поэтому проверить его во временном крейте без них:

```bash
mkdir -p "$TMPDIR/dpapi-check/src"
cat > "$TMPDIR/dpapi-check/Cargo.toml" <<'EOF'
[package]
name = "dpapi-check"
version = "0.0.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
thiserror = "2"

[target.'cfg(windows)'.dependencies]
base64 = "=0.22.1"
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }
EOF
cp apps/standalone/src-tauri/src/secret_store.rs "$TMPDIR/dpapi-check/src/lib.rs"
cargo check --manifest-path "$TMPDIR/dpapi-check/Cargo.toml" --target x86_64-pc-windows-msvc --offline
```

Expected: `Finished` без ошибок (предупреждения о неиспользуемом коде допустимы). Если cargo без сети не может разрешить зависимости временного крейта, запустить ту же команду вне песочницы. Результат записать в отчёт; сам запуск DPAPI проверяет только задание `standalone-windows-build`.

- [ ] **Step 5: Commit**

```bash
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/Cargo.lock apps/standalone/src-tauri/src
git commit -m "feat(standalone): ключ устройства под DPAPI и атомарный device.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Клиент хоста с закреплённым отпечатком и команды устройства

**Files:**

- Modify: `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/src-tauri/src/host_probe.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Create: `apps/standalone/src-tauri/src/tls.rs`, `apps/standalone/src-tauri/src/host_client.rs`, `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/tests/device.rs`

**Interfaces:**

- Consumes: `secret_store::{protect, unprotect}`, `device_config::{DeviceConfig, load, save, clear}` (задача 2); `markiro_proto::{LocalPairRequest, PairResponse, DeviceKind, Secret, OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION, DEFAULT_PORT}`.
- Produces:
  - `tls::{FingerprintPolicy { Observe(Arc<Mutex<Option<String>>>), Pin { expected, mismatch: Arc<AtomicBool> } }, client_config(FingerprintPolicy) -> Result<rustls::ClientConfig, rustls::Error>}`.
  - `host_client::{HostResponse { status: u16, body: Option<Value> }, RequestError { Unreachable, CertificateMismatch, InvalidResponse, InvalidRequest }, RequestError::code, Credentials { device_key, office_token }, PinnedClient::{new(address, fingerprint), send(method, path, body, credentials)}}`.
  - `device::{DeviceStatus { host_address, fingerprint, host_id, device_id, kind, line_id }, DeviceError, DeviceError::code, DeviceState::{load(PathBuf), status(), local_pair(address, name, app_version), request(method, path, body, office_token), forget()}}`.
  - Команды Tauri: `device_status`, `host_local_pair(name)`, `host_request(method, path, body, officeToken)`, `device_forget` (плюс прежняя `host_hello`). JSON `DeviceStatus` — camelCase; `HostResponse` — `{ "status": u16, "body": JSON | null }`.

- [ ] **Step 1: Зависимость**

В `apps/standalone/src-tauri/Cargo.toml` в `[dependencies]` добавить `tokio = { version = "=1.53.1", features = ["sync"] }` (секция `[dev-dependencies]` с тем же `tokio` остаётся).

- [ ] **Step 2: Написать падающие интеграционные тесты**

`apps/standalone/src-tauri/tests/device.rs`:

```rust
//! The paired-device layer against a real `markiro-host` on 127.0.0.1.

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::host_client::{Credentials, PinnedClient, RequestError};
use markiro_standalone_lib::host_probe::ProbeError;
use serde_json::json;

const NAME: &str = "Рабочее место хоста";

async fn start_host(dir: &std::path::Path) -> RunningHost {
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

#[tokio::test]
async fn pairs_locally_and_remembers_the_pinned_host() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(state.status(), Ok(None));

    let status = state.local_pair(&address(&host), NAME, "0.1.0").await.unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.fingerprint, host.fingerprint);
    assert_eq!(status.host_id, host.host_id);
    assert_eq!(status.line_id, None);

    let reloaded = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status.clone())));
    let response = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    let body = response.body.unwrap();
    assert_eq!(body["id"], status.device_id);
    assert_eq!(body["kind"], "station");
    assert_eq!(body["name"], NAME);

    assert_eq!(
        state.local_pair(&address(&host), NAME, "0.1.0").await,
        Err(DeviceError::AlreadyPaired)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn concurrent_local_pairing_pairs_once() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let address = address(&host);
    let (first, second) = tokio::join!(
        state.local_pair(&address, NAME, "0.1.0"),
        state.local_pair(&address, NAME, "0.1.0")
    );
    let results = [first, second];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .any(|result| result == &Err(DeviceError::AlreadyPaired)));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn requests_carry_the_device_key_and_the_office_token() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    state.local_pair(&address(&host), NAME, "0.1.0").await.unwrap();

    let refused = state
        .request("GET", "/v1/office/me", None, None)
        .await
        .unwrap();
    assert_eq!(refused.status, 401);
    let body = refused.body.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "session");

    let wizard = json!({
        "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
        "org": { "name": "ООО «Атолл»", "gln": "4600682000013", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
        "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
        "lines": ["Линия 1"]
    });
    let created = state
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let me = state
        .request("GET", "/v1/office/me", None, Some(&token))
        .await
        .unwrap();
    assert_eq!(me.status, 200);
    assert_eq!(me.body.unwrap()["login"], "admin");

    let logout = state
        .request("POST", "/v1/office/logout", None, Some(&token))
        .await
        .unwrap();
    assert_eq!((logout.status, logout.body), (204, None));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_different_certificate_is_refused() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let client = PinnedClient::new(&address(&host), &"00".repeat(32)).unwrap();
    assert_eq!(
        client
            .send("GET", "/v1/hello", None, Credentials::default())
            .await,
        Err(RequestError::CertificateMismatch)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_closed_port_is_unreachable() {
    let client = PinnedClient::new(&closed_address(), &"00".repeat(32)).unwrap();
    assert_eq!(
        client
            .send("GET", "/v1/hello", None, Credentials::default())
            .await,
        Err(RequestError::Unreachable)
    );
}

#[tokio::test]
async fn pairing_without_a_host_reports_the_probe_error() {
    let app_dir = tempfile::tempdir().unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(
        state.local_pair(&closed_address(), NAME, "0.1.0").await,
        Err(DeviceError::Probe(ProbeError::Unreachable))
    );
    assert_eq!(state.status(), Ok(None));
}

#[tokio::test]
async fn an_unpaired_device_sends_nothing() {
    let app_dir = tempfile::tempdir().unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(
        state.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::NotPaired)
    );
}

#[tokio::test]
async fn forgetting_allows_pairing_again() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let first = state.local_pair(&address(&host), NAME, "0.1.0").await.unwrap();
    state.forget().unwrap();
    assert_eq!(state.status(), Ok(None));
    assert!(!app_dir.path().join("device.json").exists());
    let second = state.local_pair(&address(&host), NAME, "0.1.0").await.unwrap();
    assert_ne!(first.device_id, second.device_id);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unreadable_config_is_reported_until_forgotten() {
    let app_dir = tempfile::tempdir().unwrap();
    std::fs::write(app_dir.path().join("device.json"), "{").unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(state.status(), Err(DeviceError::ConfigUnreadable));
    assert_eq!(
        state.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::ConfigUnreadable)
    );
    state.forget().unwrap();
    assert_eq!(state.status(), Ok(None));
    assert!(!app_dir.path().join("device.json").exists());
}
```

- [ ] **Step 3: Убедиться, что тесты не собираются**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device`
Expected: FAIL — нет модулей `device` и `host_client`.

- [ ] **Step 4: Реализовать**

`apps/standalone/src-tauri/src/tls.rs`:

```rust
//! TLS client configuration for talking to a host. Hosts use self-signed
//! certificates, so trust comes only from the certificate's SHA-256
//! fingerprint: `Observe` records it (discovery, before a person or a
//! pairing code confirms it), `Pin` accepts only the fingerprint saved at
//! pairing. The aws-lc-rs provider is always selected explicitly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

#[derive(Debug, Clone)]
pub enum FingerprintPolicy {
    /// Accept any certificate and record its fingerprint.
    Observe(Arc<Mutex<Option<String>>>),
    /// Accept only `expected`; set `mismatch` when another certificate is presented.
    Pin {
        expected: String,
        mismatch: Arc<AtomicBool>,
    },
}

pub fn client_config(policy: FingerprintPolicy) -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Ok(
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintVerifier { policy, provider }))
            .with_no_client_auth(),
    )
}

#[derive(Debug)]
struct FingerprintVerifier {
    policy: FingerprintPolicy,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = markiro_proto::certificate_fingerprint(end_entity.as_ref());
        match &self.policy {
            FingerprintPolicy::Observe(seen) => {
                *seen.lock().expect("fingerprint lock") = Some(fingerprint);
                Ok(ServerCertVerified::assertion())
            }
            FingerprintPolicy::Pin { expected, mismatch } => {
                if &fingerprint == expected {
                    Ok(ServerCertVerified::assertion())
                } else {
                    mismatch.store(true, Ordering::SeqCst);
                    Err(rustls::Error::General(
                        "host certificate fingerprint mismatch".into(),
                    ))
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
```

В `apps/standalone/src-tauri/src/host_probe.rs`:

- в doc-комментарии модуля заменить «Authenticated requests use a pinning verifier (plan 1c).» на «Authenticated requests use `host_client`, which pins the fingerprint saved at pairing.»;
- удалить структуру `ObservingVerifier` с её `impl ServerCertVerifier` и импорты `rustls::client::danger::…`, `rustls::crypto::…`, `rustls::pki_types::…`, `rustls::{DigitallySignedStruct, SignatureScheme}`; добавить `use crate::tls::{self, FingerprintPolicy};`;
- в `observe_hello` заменить сборку `provider`/`config` на:

```rust
    let config = tls::client_config(FingerprintPolicy::Observe(seen.clone()))
        .map_err(|_| ProbeError::Unreachable)?;
```

(остальная функция, `classify_hello` и тесты не меняются).

`apps/standalone/src-tauri/src/host_client.rs`:

```rust
//! Authenticated calls to the paired host (spec §5.2). A connection is
//! accepted only when the host certificate's SHA-256 equals the fingerprint
//! pinned at pairing. No proxy, no redirects, short timeouts, and the
//! protocol header on every request.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::{OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::tls::{self, FingerprintPolicy};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PATH_LENGTH: usize = 512;

/// Any HTTP answer, error statuses included: the webview reads the error
/// body's code itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResponse {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestError {
    /// No connection, a TLS failure other than the pin, or a timeout.
    Unreachable,
    /// The host presented a certificate other than the pinned one.
    CertificateMismatch,
    /// The host answered with a body that is not JSON.
    InvalidResponse,
    /// The method or path is not allowed.
    InvalidRequest,
}

impl RequestError {
    /// Stable codes the webview maps to text (`src/host/client.ts`).
    pub fn code(self) -> &'static str {
        match self {
            RequestError::Unreachable => "unreachable",
            RequestError::CertificateMismatch => "certificate_mismatch",
            RequestError::InvalidResponse => "invalid_response",
            RequestError::InvalidRequest => "invalid_request",
        }
    }
}

/// Credentials attached to one request.
#[derive(Debug, Clone, Copy, Default)]
pub struct Credentials<'a> {
    pub device_key: Option<&'a str>,
    pub office_token: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct PinnedClient {
    client: reqwest::Client,
    address: String,
    mismatch: Arc<AtomicBool>,
}

impl PinnedClient {
    /// A client for `address` (`https://host:port`) that trusts only the
    /// certificate with this lower-case hex SHA-256 `fingerprint`.
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let mismatch = Arc::new(AtomicBool::new(false));
        let config = tls::client_config(FingerprintPolicy::Pin {
            expected: fingerprint.to_owned(),
            mismatch: mismatch.clone(),
        })
        .map_err(|_| RequestError::Unreachable)?;
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
            mismatch,
        })
    }

    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        credentials: Credentials<'_>,
    ) -> Result<HostResponse, RequestError> {
        let method = allowed_method(method)?;
        validate_path(path)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key);
        }
        if let Some(token) = credentials.office_token {
            request = request.header(OFFICE_SESSION_HEADER, token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_) if self.mismatch.swap(false, Ordering::SeqCst) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        let body = if bytes.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&bytes).map_err(|_| RequestError::InvalidResponse)?)
        };
        Ok(HostResponse { status, body })
    }
}

fn allowed_method(method: &str) -> Result<Method, RequestError> {
    match method {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(RequestError::InvalidRequest),
    }
}

/// Only host API paths: `/v1/…` of plain URL characters, no traversal.
fn validate_path(path: &str) -> Result<(), RequestError> {
    let safe = path.starts_with("/v1/")
        && path.len() <= MAX_PATH_LENGTH
        && !path.contains("..")
        && !path.contains("//")
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_.~?=&%-".contains(&byte));
    if safe {
        Ok(())
    } else {
        Err(RequestError::InvalidRequest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_host_api_paths_pass() {
        for path in [
            "/v1/device",
            "/v1/office/sscc/counters/460068200/0",
            "/v1/changes?since=5&limit=100",
        ] {
            assert_eq!(validate_path(path), Ok(()), "{path}");
        }
        let too_long = format!("/v1/{}", "a".repeat(MAX_PATH_LENGTH));
        for path in [
            "/other",
            "v1/device",
            "https://example.com/v1/device",
            "/v1/../etc",
            "/v1//device",
            "/v1/device name",
            "/v1/device\n",
            too_long.as_str(),
        ] {
            assert_eq!(validate_path(path), Err(RequestError::InvalidRequest), "{path}");
        }
    }

    #[test]
    fn only_known_methods_pass() {
        for method in ["GET", "POST", "PUT", "DELETE"] {
            assert!(allowed_method(method).is_ok(), "{method}");
        }
        for method in ["PATCH", "get", "CONNECT", ""] {
            assert_eq!(allowed_method(method), Err(RequestError::InvalidRequest), "{method}");
        }
    }
}
```

`apps/standalone/src-tauri/src/device.rs`:

```rust
//! The paired device (spec §5.2): `device.json`, local pairing with the host
//! on this computer, and authenticated requests. The device key never leaves
//! this module: the webview sees `DeviceStatus`, never the key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use markiro_proto::{DeviceKind, LocalPairRequest, PairResponse};
use serde::Serialize;
use serde_json::Value;

use crate::device_config::{self, DeviceConfig};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, ProbeError};
use crate::secret_store;

/// What the webview may know about the pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub host_address: String,
    pub fingerprint: String,
    pub host_id: String,
    pub device_id: String,
    pub kind: DeviceKind,
    pub line_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    /// `device.json` exists but cannot be read, or its key cannot be unprotected.
    ConfigUnreadable,
    /// `device.json` could not be written or removed.
    Storage,
    /// A request needs a paired device and there is none.
    NotPaired,
    /// Local pairing was asked for a device that is already paired.
    AlreadyPaired,
    /// Discovering the host failed.
    Probe(ProbeError),
    /// Talking to the host failed.
    Request(RequestError),
    /// The host refused the pairing request.
    PairRejected,
    /// The host that answered the pairing is not the one `hello` described.
    HostChanged,
}

impl DeviceError {
    /// Stable codes the webview maps to text (`src/host/device.ts`).
    pub fn code(&self) -> &'static str {
        match self {
            DeviceError::ConfigUnreadable => "config_unreadable",
            DeviceError::Storage => "storage",
            DeviceError::NotPaired => "not_paired",
            DeviceError::AlreadyPaired => "already_paired",
            DeviceError::Probe(error) => error.code(),
            DeviceError::Request(error) => error.code(),
            DeviceError::PairRejected => "pair_rejected",
            DeviceError::HostChanged => "host_changed",
        }
    }
}

struct PairedDevice {
    config: DeviceConfig,
    key: String,
    client: PinnedClient,
}

impl PairedDevice {
    fn open(config: DeviceConfig) -> Result<Self, DeviceError> {
        let key = secret_store::unprotect(&config.device_key)
            .map_err(|_| DeviceError::ConfigUnreadable)?;
        let client = PinnedClient::new(&config.host_address, &config.fingerprint)
            .map_err(DeviceError::Request)?;
        Ok(Self {
            config,
            key,
            client,
        })
    }

    fn status(&self) -> DeviceStatus {
        DeviceStatus {
            host_address: self.config.host_address.clone(),
            fingerprint: self.config.fingerprint.clone(),
            host_id: self.config.host_id.clone(),
            device_id: self.config.device_id.clone(),
            kind: self.config.kind,
            line_id: self.config.line_id.clone(),
        }
    }
}

enum Current {
    Unpaired,
    Paired(Arc<PairedDevice>),
    Unreadable,
}

/// Tauri state: the pairing of this app installation.
pub struct DeviceState {
    config_dir: PathBuf,
    current: Mutex<Current>,
    pairing: tokio::sync::Mutex<()>,
}

impl DeviceState {
    /// Read `device.json` from `config_dir`; an unreadable file is reported
    /// by `status` until `forget` removes it.
    pub fn load(config_dir: PathBuf) -> Self {
        let current = match device_config::load(&config_dir) {
            Ok(None) => Current::Unpaired,
            Ok(Some(config)) => match PairedDevice::open(config) {
                Ok(device) => Current::Paired(Arc::new(device)),
                Err(_) => Current::Unreadable,
            },
            Err(_) => Current::Unreadable,
        };
        Self {
            config_dir,
            current: Mutex::new(current),
            pairing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn status(&self) -> Result<Option<DeviceStatus>, DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(None),
            Current::Paired(device) => Ok(Some(device.status())),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

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
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => {}
            Current::Paired(_) => return Err(DeviceError::AlreadyPaired),
            Current::Unreadable => return Err(DeviceError::ConfigUnreadable),
        }
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
        let pair: PairResponse = response
            .body
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
        device_config::save(&self.config_dir, &config).map_err(|_| DeviceError::Storage)?;
        let device = Arc::new(PairedDevice {
            key: pair.device_key.expose().to_owned(),
            client,
            config,
        });
        let status = device.status();
        *self.current.lock().expect("device lock") = Current::Paired(device);
        Ok(status)
    }

    /// Send a request to the paired host with this device's key and, for
    /// office routes, the session token.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        office_token: Option<&str>,
    ) -> Result<HostResponse, DeviceError> {
        let device = match &*self.current.lock().expect("device lock") {
            Current::Paired(device) => device.clone(),
            Current::Unpaired => return Err(DeviceError::NotPaired),
            Current::Unreadable => return Err(DeviceError::ConfigUnreadable),
        };
        device
            .client
            .send(
                method,
                path,
                body,
                Credentials {
                    device_key: Some(&device.key),
                    office_token,
                },
            )
            .await
            .map_err(DeviceError::Request)
    }

    /// Forget the pairing on this computer (the host no longer accepts it,
    /// or `device.json` is unreadable). The host keeps its record until the
    /// device is revoked in the office.
    pub fn forget(&self) -> Result<(), DeviceError> {
        device_config::clear(&self.config_dir).map_err(|_| DeviceError::Storage)?;
        *self.current.lock().expect("device lock") = Current::Unpaired;
        Ok(())
    }
}
```

`apps/standalone/src-tauri/src/lib.rs` заменить целиком:

```rust
//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks and the device key stay in Rust.

pub mod device;
pub mod device_config;
pub mod host_client;
pub mod host_probe;
pub mod secret_store;
pub mod tls;

use serde_json::Value;
use tauri::Manager;

use device::{DeviceState, DeviceStatus};
use host_client::HostResponse;

/// The host service on this computer.
fn local_host_address() -> String {
    format!("https://127.0.0.1:{}", markiro_proto::DEFAULT_PORT)
}

#[tauri::command]
async fn host_hello(address: String) -> Result<host_probe::HelloObservation, String> {
    host_probe::observe_hello(&address)
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
fn device_status(state: tauri::State<'_, DeviceState>) -> Result<Option<DeviceStatus>, String> {
    state.status().map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn host_local_pair(
    state: tauri::State<'_, DeviceState>,
    name: String,
) -> Result<DeviceStatus, String> {
    state
        .local_pair(&local_host_address(), &name, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn host_request(
    state: tauri::State<'_, DeviceState>,
    method: String,
    path: String,
    body: Option<Value>,
    office_token: Option<String>,
) -> Result<HostResponse, String> {
    state
        .request(&method, &path, body.as_ref(), office_token.as_deref())
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
fn device_forget(state: tauri::State<'_, DeviceState>) -> Result<(), String> {
    state.forget().map_err(|error| error.code().to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(DeviceState::load(config_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_hello,
            device_status,
            host_local_pair,
            host_request,
            device_forget
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
```

- [ ] **Step 5: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (вне песочницы: тесты слушают 127.0.0.1)
Expected: PASS — 9 тестов в `tests/device.rs`, 2 модульных теста `host_client`, прежние тесты `host_probe`, `secret_store`, `device_config`.

Затем весь воркспейс: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/src-tauri apps/standalone/Cargo.lock
git commit -m "feat(standalone): клиент хоста с закреплённым отпечатком и команды устройства" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Зависимости вебвью, схемы протокола и контракт фикстур

**Files:**

- Modify: `apps/standalone/package.json`, `pnpm-lock.yaml`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/test/protocol.test.ts`, `eslint.config.mjs`, `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`
- Create: `apps/standalone/test/phc-contract.test.ts`

**Interfaces:**

- Produces (`src/host/protocol.ts`, всё с `export`): схемы и типы `deviceKindSchema`/`DeviceKind`, `officeRoleSchema`/`OfficeRole`, `credentialSchema`/`Credential`, `deviceStatusSchema`/`DeviceStatus` (strict), `hostResponseSchema`/`HostResponse` (strict), `deviceInfoSchema`/`DeviceInfo`, `officeUserSchema`/`OfficeUser`, `officeSessionSchema`/`OfficeSession`, `bootstrapResponseSchema`/`BootstrapResponse`, `orgProfileSchema`/`OrgProfile`, `ssccCounterSchema`/`SsccCounter`, `ssccStateSchema`/`SsccState`, `officeUserRecordSchema`/`OfficeUserRecord` (ответы — нестрогие), `officeLoginRequestSchema`/`OfficeLoginRequest`, `newOfficeUserSchema`/`NewOfficeUser`, `orgProfileInputSchema`/`OrgProfileInput`, `ssccStartSchema`/`SsccStart`, `bootstrapRequestSchema`/`BootstrapRequest`, `orgProfileUpdateSchema`/`OrgProfileUpdate`, `ssccCounterUpdateSchema`/`SsccCounterUpdate`, `blockSizesUpdateSchema`/`BlockSizesUpdate`, `officeUserCreateSchema`/`OfficeUserCreate`, `officeUserUpdateSchema`/`OfficeUserUpdate`, `passwordSetSchema`/`PasswordSet` (запросы — строгие); прежние `PROTOCOL_VERSION`, `DEFAULT_HOST_PORT`, `LOCAL_HOST_ADDRESS`, `helloSchema`/`Hello`, `errorBodySchema`/`ErrorBody` (теперь нестрогая).

- [ ] **Step 1: Установить зависимости (вне песочницы)**

```bash
pnpm add --save-exact --filter @markiro/standalone "@markiro/domain@workspace:*" react-router@8.3.0 react-hook-form@7.85.0 @hookform/resolvers@5.9.1
```

Проверить: в `apps/standalone/package.json` в `dependencies` появились ровно `"@hookform/resolvers": "5.9.1"`, `"@markiro/domain": "workspace:*"`, `"react-hook-form": "7.85.0"`, `"react-router": "8.3.0"`; `git diff pnpm-lock.yaml` меняет только раздел `importers` → `apps/standalone` (эти версии уже есть в lockfile у `apps/admin`, новых пакетов нет). Если pnpm добавил другое — остановиться и сообщить.

Затем собрать зависимости вебвью: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.

- [ ] **Step 2: Написать падающие тесты контракта**

В `apps/standalone/test/protocol.test.ts` заменить строку импорта схем на:

```ts
import {
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  credentialSchema,
  deviceInfoSchema,
  errorBodySchema,
  helloSchema,
  officeLoginRequestSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  passwordSetSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";
```

и дописать в конец файла:

```ts
// Host responses pass through the shell unchanged: lenient, like the Rust
// response types. Requests are strict, like the host's deny_unknown_fields.
const RESPONSES = [
  ["device-info.json", deviceInfoSchema],
  ["office-user.json", officeUserSchema],
  ["office-session.json", officeSessionSchema],
  ["bootstrap-response.json", bootstrapResponseSchema],
  ["org-profile.json", orgProfileSchema],
  ["sscc-state.json", ssccStateSchema],
  ["office-user-record.json", officeUserRecordSchema],
  ["error-unauthorized.json", errorBodySchema],
] as const;

const REQUESTS = [
  ["office-login-request.json", officeLoginRequestSchema],
  ["bootstrap-request.json", bootstrapRequestSchema],
  ["org-profile-update.json", orgProfileUpdateSchema],
  ["sscc-counter-update.json", ssccCounterUpdateSchema],
  ["block-sizes-update.json", blockSizesUpdateSchema],
  ["office-user-create.json", officeUserCreateSchema],
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
] as const;

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(true);
  });
});

describe.each(REQUESTS)("request fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("rejects an unknown field, like the host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(false);
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});
```

`apps/standalone/test/phc-contract.test.ts`:

```ts
// @vitest-environment node
// Node's WebCrypto: PBKDF2 needs `crypto.subtle`, which this test must not
// borrow from a DOM emulation.
import { readFileSync } from "node:fs";

import { parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { describe, expect, it } from "vitest";

const testModuleUrl = import.meta.url;

interface PhcFixture {
  password: string;
  passwordPhc: string;
  pin: string;
  pinPhc: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../proto/fixtures/phc-password.json", testModuleUrl), "utf8"),
) as PhcFixture;

describe("PHC strings shared with the host (spec §6)", () => {
  it("verifies the password PHC in the host's format", async () => {
    expect(parsePhc(fixture.passwordPhc)?.iterations).toBe(600_000);
    await expect(verifyPhc(fixture.password, fixture.passwordPhc)).resolves.toBe(true);
    await expect(verifyPhc(`${fixture.password}!`, fixture.passwordPhc)).resolves.toBe(false);
  });

  it("verifies the PIN PHC made by the domain", async () => {
    expect(parsePhc(fixture.pinPhc)?.iterations).toBe(PHC_ITERATIONS);
    await expect(verifyPhc(fixture.pin, fixture.pinPhc)).resolves.toBe(true);
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/phc-contract.test.ts`
Expected: FAIL — в `protocol.ts` нет новых схем (тест PHC уже зелёный: он проверяет только домен и фикстуру).

- [ ] **Step 4: Реализовать схемы**

`apps/standalone/src/host/protocol.ts` заменить целиком:

```ts
import { z } from "zod";

/** Mirrors `markiro_proto::PROTOCOL_VERSION` (apps/standalone/proto). */
export const PROTOCOL_VERSION = 1;
/** Mirrors `markiro_proto::DEFAULT_PORT`. */
export const DEFAULT_HOST_PORT = 45710;
/** The host on this computer, when the app runs next to the service. */
export const LOCAL_HOST_ADDRESS = `https://127.0.0.1:${DEFAULT_HOST_PORT}`;

// Three kinds of shapes cross the IPC boundary:
// - payloads the Rust shell rebuilds from proto types are strict: an unknown
//   key means the webview and the shell come from different builds;
// - host response bodies pass through the shell unchanged and are lenient,
//   like the Rust response types (a newer host may add fields);
// - request bodies are strict, like the host's `deny_unknown_fields`.

/** Mirrors `markiro_proto::Hello`; rebuilt by the shell, so strict. */
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

/** Mirrors `markiro_proto::ErrorBody`; a host response, so lenient. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Mirrors `markiro_proto::DeviceKind`. */
export const deviceKindSchema = z.enum(["station", "office", "handheld"]);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

/** Mirrors `markiro_proto::OfficeRole`. */
export const officeRoleSchema = z.enum(["admin", "technologist"]);
export type OfficeRole = z.infer<typeof officeRoleSchema>;

/** Mirrors `markiro_proto::credentials`: which credential `unauthorized` rejected. */
export const credentialSchema = z.enum(["device", "session", "password"]);
export type Credential = z.infer<typeof credentialSchema>;

// --- The Rust shell's own payloads (strict) ---

/** `device_status` / `host_local_pair`: the pairing, never the device key. */
export const deviceStatusSchema = z
  .object({
    hostAddress: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    hostId: z.uuid(),
    deviceId: z.uuid(),
    kind: deviceKindSchema,
    lineId: z.uuid().nullable(),
  })
  .strict();
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

/** `host_request`: any HTTP answer, error statuses included. */
export const hostResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  })
  .strict();
export type HostResponse = z.infer<typeof hostResponseSchema>;

// --- Host responses (lenient) ---

/** `GET /v1/device`. */
export const deviceInfoSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  pairedAt: z.iso.datetime(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** The signed-in office user. */
export const officeUserSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: officeRoleSchema,
});
export type OfficeUser = z.infer<typeof officeUserSchema>;

/** `POST /v1/office/login`: the token is shown once and kept only in memory. */
export const officeSessionSchema = z.object({
  token: z.string().min(1),
  user: officeUserSchema,
  expiresAt: z.iso.datetime(),
});
export type OfficeSession = z.infer<typeof officeSessionSchema>;

/** `POST /v1/bootstrap`. */
export const bootstrapResponseSchema = z.object({ session: officeSessionSchema });
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/** `GET /v1/office/org`. */
export const orgProfileSchema = z.object({
  name: z.string(),
  inn: z.string().nullable(),
  gln: z.string(),
  gs1Prefixes: z.array(z.string()),
  timeZone: z.string(),
  rev: z.number().int(),
});
export type OrgProfile = z.infer<typeof orgProfileSchema>;

/** One SSCC counter; `extension` 0 is a box, 1 a pallet. */
export const ssccCounterSchema = z.object({
  issuerPrefix: z.string(),
  extension: z.number().int().min(0).max(9),
  nextSerial: z.number().int().nonnegative(),
  maxSerial: z.number().int().nonnegative(),
  rev: z.number().int(),
});
export type SsccCounter = z.infer<typeof ssccCounterSchema>;

/** `GET /v1/office/sscc`. */
export const ssccStateSchema = z.object({
  counters: z.array(ssccCounterSchema),
  boxBlockSize: z.number().int().positive(),
  palletBlockSize: z.number().int().positive(),
  currentIssuerPrefix: z.string(),
  blockSizesRev: z.number().int(),
});
export type SsccState = z.infer<typeof ssccStateSchema>;

/** An office user as the administrator sees it. */
export const officeUserRecordSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  name: z.string(),
  role: officeRoleSchema,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  rev: z.number().int(),
});
export type OfficeUserRecord = z.infer<typeof officeUserRecordSchema>;

// --- Request bodies (strict) ---

export const officeLoginRequestSchema = z
  .object({ login: z.string(), password: z.string() })
  .strict();
export type OfficeLoginRequest = z.infer<typeof officeLoginRequestSchema>;

export const newOfficeUserSchema = z
  .object({ login: z.string(), name: z.string(), password: z.string() })
  .strict();
export type NewOfficeUser = z.infer<typeof newOfficeUserSchema>;

export const orgProfileInputSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable().optional(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
  })
  .strict();
export type OrgProfileInput = z.infer<typeof orgProfileInputSchema>;

export const ssccStartSchema = z
  .object({
    boxNextSerial: z.number().int().nonnegative(),
    palletNextSerial: z.number().int().nonnegative(),
  })
  .strict();
export type SsccStart = z.infer<typeof ssccStartSchema>;

export const bootstrapRequestSchema = z
  .object({
    admin: newOfficeUserSchema,
    org: orgProfileInputSchema,
    sscc: ssccStartSchema,
    lines: z.array(z.string()),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const orgProfileUpdateSchema = z
  .object({
    name: z.string(),
    inn: z.string().nullable().optional(),
    gln: z.string(),
    gs1Prefixes: z.array(z.string()),
    timeZone: z.string(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OrgProfileUpdate = z.infer<typeof orgProfileUpdateSchema>;

export const ssccCounterUpdateSchema = z
  .object({ nextSerial: z.number().int().nonnegative(), expectedRev: z.number().int() })
  .strict();
export type SsccCounterUpdate = z.infer<typeof ssccCounterUpdateSchema>;

export const blockSizesUpdateSchema = z
  .object({
    boxBlockSize: z.number().int().positive(),
    palletBlockSize: z.number().int().positive(),
    expectedRev: z.number().int(),
  })
  .strict();
export type BlockSizesUpdate = z.infer<typeof blockSizesUpdateSchema>;

export const officeUserCreateSchema = z
  .object({ login: z.string(), name: z.string(), role: officeRoleSchema, password: z.string() })
  .strict();
export type OfficeUserCreate = z.infer<typeof officeUserCreateSchema>;

export const officeUserUpdateSchema = z
  .object({
    name: z.string(),
    role: officeRoleSchema,
    active: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();
export type OfficeUserUpdate = z.infer<typeof officeUserUpdateSchema>;

export const passwordSetSchema = z.object({ password: z.string() }).strict();
export type PasswordSet = z.infer<typeof passwordSetSchema>;
```

- [ ] **Step 5: Запрет нативных элементов форм и маршрутизация CI**

В `eslint.config.mjs` у блока с правилом `no-restricted-syntax` (запрет `input`, `select`, `textarea`, `button`, `option`, `datalist`) заменить `files: ["apps/admin/src/**/*.{ts,tsx}"]` на `files: ["apps/admin/src/**/*.{ts,tsx}", "apps/standalone/src/**/*.{ts,tsx}"]` (спецификация, §7: приложение подчиняется тому же запрету, что админка).

В `tools/ci/affected.mjs` в `sharedJobs.domain` после `...stationJobs` добавить `...standaloneJobs` (вебвью теперь зависит от `@markiro/domain`). В `tools/ci/test/affected.test.mjs` в тесте `shared packages fan out to their current consumers` в ожидаемом списке для `packages/domain/src/gtin.ts` после `"station_windows_build"` добавить `"standalone_rust"` и `"standalone_windows_build"`.

- [ ] **Step 6: Проверки проходят**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
node --test tools/ci/test/affected.test.mjs
node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/package.json eslint.config.mjs tools/ci
```

Expected: все зелёные; в `protocol.test.ts` — прежние 4 теста и 34 новых (8 ответов × 2, 8 запросов × 2, credential), в `phc-contract.test.ts` — 2.

- [ ] **Step 7: Commit**

```bash
git add apps/standalone/package.json pnpm-lock.yaml apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/test/phc-contract.test.ts eslint.config.mjs tools/ci/affected.mjs tools/ci/test/affected.test.mjs
git commit -m "feat(standalone): схемы протокола офиса и контракт фикстур в вебвью" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Клиент хоста, API устройства и тексты ошибок в вебвью

**Files:**

- Create: `apps/standalone/src/host/client.ts`, `apps/standalone/src/host/device.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/src/host/errors.ts`, `apps/standalone/test/support/fixtures.ts`, `apps/standalone/test/client.test.ts`, `apps/standalone/test/device.test.ts`, `apps/standalone/test/errors.test.ts`
- Modify: `apps/standalone/src/i18n/ru.json`

**Interfaces:**

- Consumes: схемы и типы из `src/host/protocol.ts` (задача 4); команды оболочки из задачи 3.
- Produces:
  - `client.ts`: `HttpMethod = "GET" | "POST" | "PUT" | "DELETE"`; `TRANSPORT_CODES` (`unreachable`, `certificate_mismatch`, `invalid_response`, `invalid_request`, `not_paired`, `config_unreadable`) и `TransportCode`; класс `HostError` (`kind: "transport" | "api"`, `code`, `status: number | null`, `details`, геттеры `credential: Credential | null`, `field: string | null`); `HostRequestOptions<T> { body?, officeToken?, schema: z.ZodType<T> }`; `HostClient { request<T>(method, path, options): Promise<T> }`; `createTauriHostClient(call = invoke)`.
  - `device.ts`: `DEVICE_ERROR_CODES` (13 кодов из Global Constraints) и `DeviceErrorCode`; класс `DeviceError` (`code`); `DeviceApi { status(): Promise<DeviceStatus | null>; pairLocally(name): Promise<DeviceStatus>; forget(): Promise<void> }`; `createTauriDeviceApi(call = invoke)`.
  - `api.ts`: `HostApi { bootstrap(request): Promise<BootstrapResponse>; officeLogin(request): Promise<OfficeSession>; officeLogout(token): Promise<void> }`; `createHostApi(client: HostClient)`.
  - `errors.ts`: `API_ERROR_CODES` (14 кодов протокола) и `errorMessageKey(error: unknown): string` — ключ i18n: `errors.transport.<code>`, `errors.unauthorized.<credential>`, `errors.api.<code>`, `errors.device.<code>` или `errors.unknown`.
  - `test/support/fixtures.ts`: `DEVICE_STATUS: DeviceStatus`, `HOST_ID`, `observation(initialized: boolean): HelloObservation`, `SESSION: OfficeSession` — общие данные тестов задач 5–8.

- [ ] **Step 1: Тексты ошибок**

В `apps/standalone/src/i18n/ru.json` добавить верхнеуровневый ключ `errors` (рядом с `shell`):

```json
"errors": {
  "unknown": "Что-то пошло не так. Повторите попытку.",
  "transport": {
    "unreachable": "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    "certificate_mismatch": "Сертификат хоста не совпадает с сохранённым при подключении.",
    "invalid_response": "Хост ответил в неожиданном формате.",
    "invalid_request": "Приложение сформировало недопустимый запрос.",
    "not_paired": "Это устройство ещё не подключено к хосту.",
    "config_unreadable": "Настройки подключения к хосту повреждены."
  },
  "unauthorized": {
    "device": "Хост не принимает это устройство.",
    "session": "Сессия офиса закончилась. Войдите снова.",
    "password": "Неверный логин или пароль."
  },
  "api": {
    "not_found": "Запись не найдена.",
    "method_not_allowed": "Хост не поддерживает это действие.",
    "protocol_unsupported": "Версии приложения и хоста несовместимы.",
    "validation_failed": "Хост не принял данные. Проверьте поля формы.",
    "unauthorized": "Нужно войти заново.",
    "forbidden": "Недостаточно прав для этого действия.",
    "stale_revision": "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
    "conflict": "Такая запись уже есть.",
    "last_admin": "Нельзя выключить или понизить последнего администратора.",
    "sscc_below_floor": "Счётчик SSCC можно только увеличить.",
    "already_initialized": "Хост уже настроен.",
    "loopback_only": "Это действие доступно только на ПК-хосте.",
    "rate_limited": "Слишком много попыток. Подождите минуту и попробуйте снова.",
    "internal": "На хосте произошла ошибка. Повторите попытку."
  },
  "device": {
    "config_unreadable": "Настройки подключения к хосту повреждены.",
    "storage": "Не удалось сохранить настройки подключения на этом компьютере.",
    "not_paired": "Это устройство ещё не подключено к хосту.",
    "already_paired": "Это устройство уже подключено к хосту.",
    "unreachable": "Служба хоста на этом компьютере не отвечает.",
    "not_markiro_host": "На этом компьютере отвечает не служба Markiro.",
    "invalid_response": "Служба хоста ответила в неожиданном формате.",
    "host_too_old": "Служба «Markiro Хост» старее этого приложения. Обновите службу.",
    "app_too_old": "Это приложение старее службы «Markiro Хост». Обновите приложение.",
    "certificate_mismatch": "Сертификат хоста изменился во время подключения.",
    "invalid_request": "Приложение сформировало недопустимый запрос.",
    "pair_rejected": "Хост отказал в подключении этого устройства.",
    "host_changed": "Во время подключения ответил другой хост."
  }
}
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/test/support/fixtures.ts`:

```ts
import type { HelloObservation } from "../../src/host/probe.js";
import type { DeviceStatus, OfficeSession } from "../../src/host/protocol.js";

export const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

export const DEVICE_STATUS: DeviceStatus = {
  hostAddress: "https://127.0.0.1:45710",
  fingerprint: "ab".repeat(32),
  hostId: HOST_ID,
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  lineId: null,
};

export function observation(initialized: boolean): HelloObservation {
  return {
    hello: {
      product: "markiro-host",
      protocol: 1,
      minProtocol: 1,
      hostId: HOST_ID,
      version: "0.1.0",
      time: "2026-09-26T09:15:00Z",
      initialized,
    },
    fingerprint: "ab".repeat(32),
  };
}

export const SESSION: OfficeSession = {
  token: "office-session-token",
  user: {
    id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
    login: "admin",
    name: "Ирина Смирнова",
    role: "admin",
  },
  expiresAt: "2026-09-26T21:15:00Z",
};
```

`apps/standalone/test/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTauriHostClient, HostError, TRANSPORT_CODES } from "../src/host/client.js";

const valueSchema = z.object({ value: z.number() });

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HostError);
  return error as HostError;
}

describe("Tauri host client", () => {
  it("sends the request through host_request and parses a 2xx body", async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: { value: 7 } });
    const result = await createTauriHostClient(call).request("PUT", "/v1/office/org", {
      body: { name: "ООО" },
      officeToken: "token",
      schema: valueSchema,
    });
    expect(result).toEqual({ value: 7 });
    expect(call).toHaveBeenCalledWith("host_request", {
      method: "PUT",
      path: "/v1/office/org",
      body: { name: "ООО" },
      officeToken: "token",
    });
  });

  it("sends null for an absent body and token and accepts an empty 204", async () => {
    const call = vi.fn().mockResolvedValue({ status: 204, body: null });
    await expect(
      createTauriHostClient(call).request("POST", "/v1/office/logout", { schema: z.null() }),
    ).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: "/v1/office/logout",
      body: null,
      officeToken: null,
    });
  });

  it("turns an error body into an api error naming the credential", async () => {
    const call = vi.fn().mockResolvedValue({
      status: 401,
      body: {
        error: {
          code: "unauthorized",
          message: "office session expired",
          details: { credential: "session" },
        },
      },
    });
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/office/me", { schema: z.unknown() }),
    );
    expect(error.kind).toBe("api");
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.credential).toBe("session");
    expect(error.field).toBeNull();
  });

  it("names the field of a validation error", async () => {
    const call = vi.fn().mockResolvedValue({
      status: 400,
      body: { error: { code: "validation_failed", message: "bad", details: { field: "org.gln" } } },
    });
    const error = await failure(
      createTauriHostClient(call).request("POST", "/v1/bootstrap", { schema: z.unknown() }),
    );
    expect(error.field).toBe("org.gln");
    expect(error.credential).toBeNull();
  });

  it.each(TRANSPORT_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: z.unknown() }),
    );
    expect(error.kind).toBe("transport");
    expect(error.code).toBe(code);
    expect(error.status).toBeNull();
  });

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: z.unknown() }),
    );
    expect(error.code).toBe("unreachable");
  });

  it.each([
    ["a 2xx body the schema rejects", { status: 200, body: { value: "seven" } }],
    ["an error status without an error body", { status: 500, body: null }],
    ["a malformed shell answer", { status: 200 }],
  ])("reports %s as an invalid response", async (_case, answer) => {
    const call = vi.fn().mockResolvedValue(answer);
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: valueSchema }),
    );
    expect(error.kind).toBe("transport");
    expect(error.code).toBe("invalid_response");
  });
});
```

`apps/standalone/test/device.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createTauriDeviceApi, DEVICE_ERROR_CODES, DeviceError } from "../src/host/device.js";
import { DEVICE_STATUS } from "./support/fixtures.js";

async function failure(promise: Promise<unknown>): Promise<DeviceError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DeviceError);
  return error as DeviceError;
}

describe("Tauri device API", () => {
  it("reports an unpaired device as null", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await expect(createTauriDeviceApi(call).status()).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith("device_status", {});
  });

  it("validates the pairing the shell reports", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual(DEVICE_STATUS);
  });

  it("pairs locally under the given device name", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).pairLocally("Рабочее место хоста")).resolves.toEqual(
      DEVICE_STATUS,
    );
    expect(call).toHaveBeenCalledWith("host_local_pair", { name: "Рабочее место хоста" });
  });

  it("forgets the pairing", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTauriDeviceApi(call).forget();
    expect(call).toHaveBeenCalledWith("device_forget", {});
  });

  it.each(DEVICE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    expect((await failure(createTauriDeviceApi(call).pairLocally("x"))).code).toBe(code);
  });

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("unreachable");
  });

  it("rejects a pairing that does not match the shell's shape", async () => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, deviceKey: "leaked" });
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("invalid_response");
  });
});
```

`apps/standalone/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { HostError, TRANSPORT_CODES } from "../src/host/client.js";
import { DEVICE_ERROR_CODES, DeviceError } from "../src/host/device.js";
import { API_ERROR_CODES, errorMessageKey } from "../src/host/errors.js";
import i18n from "../src/i18n/index.js";

function apiError(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

describe("error messages", () => {
  it("have a text for every code the shell and the host send", () => {
    const keys = [
      ...TRANSPORT_CODES.map((code) =>
        errorMessageKey(new HostError({ kind: "transport", code, message: code })),
      ),
      ...API_ERROR_CODES.map((code) => errorMessageKey(apiError(code))),
      ...(["device", "session", "password"] as const).map((credential) =>
        errorMessageKey(apiError("unauthorized", { credential })),
      ),
      ...DEVICE_ERROR_CODES.map((code) => errorMessageKey(new DeviceError(code, code))),
    ];
    for (const key of keys) {
      expect(i18n.exists(key), key).toBe(true);
    }
  });

  it("prefer the rejected credential for unauthorized answers", () => {
    expect(errorMessageKey(apiError("unauthorized", { credential: "password" }))).toBe(
      "errors.unauthorized.password",
    );
    expect(errorMessageKey(apiError("unauthorized"))).toBe("errors.api.unauthorized");
  });

  it("fall back to a generic text for anything unknown", () => {
    expect(errorMessageKey(apiError("from_a_newer_host"))).toBe("errors.unknown");
    expect(errorMessageKey(new Error("boom"))).toBe("errors.unknown");
    expect(errorMessageKey("boom")).toBe("errors.unknown");
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/client.test.ts test/device.test.ts test/errors.test.ts`
Expected: FAIL — модулей `client`, `device`, `errors` нет.

- [ ] **Step 4: Реализовать**

`apps/standalone/src/host/client.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod";

import {
  credentialSchema,
  errorBodySchema,
  hostResponseSchema,
  type Credential,
} from "./protocol.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Codes the shell rejects `host_request` with (`DeviceError::code` in src-tauri). */
export const TRANSPORT_CODES = [
  "unreachable",
  "certificate_mismatch",
  "invalid_response",
  "invalid_request",
  "not_paired",
  "config_unreadable",
] as const;
export type TransportCode = (typeof TRANSPORT_CODES)[number];

interface HostErrorInit {
  kind: "transport" | "api";
  code: string;
  message: string;
  status?: number;
  details?: Record<string, unknown>;
}

/**
 * A failed host call: the shell got no usable answer (`transport`), or the
 * host answered with an error body (`api`). Screens choose text by `code`.
 */
export class HostError extends Error {
  readonly kind: "transport" | "api";
  readonly code: string;
  readonly status: number | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(init: HostErrorInit) {
    super(init.message);
    this.name = "HostError";
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details ?? {};
  }

  /** The credential an `unauthorized` answer rejected. */
  get credential(): Credential | null {
    if (this.code !== "unauthorized") return null;
    const parsed = credentialSchema.safeParse(this.details.credential);
    return parsed.success ? parsed.data : null;
  }

  /** The request field a `validation_failed` answer names (`org.gln`, `lines.1`). */
  get field(): string | null {
    const field = this.details.field;
    return this.code === "validation_failed" && typeof field === "string" ? field : null;
  }
}

export interface HostRequestOptions<T> {
  body?: unknown;
  officeToken?: string;
  /** Parses a 2xx body; a 204 answer parses as `null`. */
  schema: z.ZodType<T>;
}

export interface HostClient {
  request<T>(method: HttpMethod, path: string, options: HostRequestOptions<T>): Promise<T>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Calls the host through the shell's `host_request`: the webview never performs HTTP. */
export function createTauriHostClient(call: Invoke = invoke): HostClient {
  return {
    async request(method, path, { body, officeToken, schema }) {
      let raw: unknown;
      try {
        raw = await call("host_request", {
          method,
          path,
          body: body ?? null,
          officeToken: officeToken ?? null,
        });
      } catch (error) {
        const code = TRANSPORT_CODES.find((candidate) => candidate === error) ?? "unreachable";
        throw new HostError({
          kind: "transport",
          code,
          message: `${method} ${path}: ${String(error)}`,
        });
      }
      const answer = hostResponseSchema.safeParse(raw);
      if (!answer.success) throw invalidResponse(method, path, answer.error.message);
      const { status } = answer.data;
      if (status >= 200 && status < 300) {
        const parsed = schema.safeParse(answer.data.body ?? null);
        if (!parsed.success) throw invalidResponse(method, path, parsed.error.message);
        return parsed.data;
      }
      const failure = errorBodySchema.safeParse(answer.data.body);
      if (!failure.success) {
        throw invalidResponse(method, path, `HTTP ${status} without an error body`);
      }
      throw new HostError({
        kind: "api",
        code: failure.data.error.code,
        message: failure.data.error.message,
        status,
        details: failure.data.error.details ?? {},
      });
    },
  };
}

function invalidResponse(method: string, path: string, reason: string): HostError {
  return new HostError({
    kind: "transport",
    code: "invalid_response",
    message: `${method} ${path}: ${reason}`,
  });
}
```

`apps/standalone/src/host/device.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

import { deviceStatusSchema, type DeviceStatus } from "./protocol.js";

/** Codes the shell rejects device commands with (`DeviceError::code` in src-tauri). */
export const DEVICE_ERROR_CODES = [
  "config_unreadable",
  "storage",
  "not_paired",
  "already_paired",
  "unreachable",
  "not_markiro_host",
  "invalid_response",
  "host_too_old",
  "app_too_old",
  "certificate_mismatch",
  "invalid_request",
  "pair_rejected",
  "host_changed",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export class DeviceError extends Error {
  readonly code: DeviceErrorCode;

  constructor(code: DeviceErrorCode, message: string) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
  }
}

/** The pairing of this installation, kept by the shell (`device.json`). */
export interface DeviceApi {
  status(): Promise<DeviceStatus | null>;
  /** Pair with the host on this computer (`POST /v1/local-pair`, loopback only). */
  pairLocally(name: string): Promise<DeviceStatus>;
  /** Forget the pairing kept on this computer. */
  forget(): Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function createTauriDeviceApi(call: Invoke = invoke): DeviceApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = DEVICE_ERROR_CODES.find((candidate) => candidate === error) ?? "unreachable";
      throw new DeviceError(code, `${command}: ${String(error)}`);
    }
  }

  return {
    async status() {
      const raw = await run("device_status", {});
      return raw === null ? null : parseStatus(raw);
    },
    async pairLocally(name) {
      return parseStatus(await run("host_local_pair", { name }));
    },
    async forget() {
      await run("device_forget", {});
    },
  };
}

function parseStatus(raw: unknown): DeviceStatus {
  const parsed = deviceStatusSchema.safeParse(raw);
  if (!parsed.success) throw new DeviceError("invalid_response", parsed.error.message);
  return parsed.data;
}
```

`apps/standalone/src/host/api.ts`:

```ts
import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  officeSessionSchema,
  type BootstrapRequest,
  type BootstrapResponse,
  type OfficeLoginRequest,
  type OfficeSession,
} from "./protocol.js";

/** Host endpoints the shell uses; office screens add their own (plan 1b3). */
export interface HostApi {
  bootstrap(request: BootstrapRequest): Promise<BootstrapResponse>;
  officeLogin(request: OfficeLoginRequest): Promise<OfficeSession>;
  officeLogout(token: string): Promise<void>;
}

export function createHostApi(client: HostClient): HostApi {
  return {
    bootstrap: (request) =>
      client.request("POST", "/v1/bootstrap", { body: request, schema: bootstrapResponseSchema }),
    officeLogin: (request) =>
      client.request("POST", "/v1/office/login", { body: request, schema: officeSessionSchema }),
    officeLogout: async (token) => {
      await client.request("POST", "/v1/office/logout", {
        officeToken: token,
        schema: z.null(),
      });
    },
  };
}
```

`apps/standalone/src/host/errors.ts`:

```ts
import { HostError } from "./client.js";
import { DeviceError } from "./device.js";

/** Error codes of the host protocol (`markiro_proto::codes`). */
export const API_ERROR_CODES = [
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
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** The i18n key of the text to show for an error from the host or the shell. */
export function errorMessageKey(error: unknown): string {
  if (error instanceof HostError) {
    if (error.kind === "transport") return `errors.transport.${error.code}`;
    const credential = error.credential;
    if (credential) return `errors.unauthorized.${credential}`;
    return API_CODES.has(error.code) ? `errors.api.${error.code}` : "errors.unknown";
  }
  if (error instanceof DeviceError) return `errors.device.${error.code}`;
  return "errors.unknown";
}
```

- [ ] **Step 5: Проверки проходят**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

Expected: все зелёные: 14 тестов `client.test.ts` (6 кодов транспорта, 3 случая неверного ответа, 5 одиночных), 19 тестов `device.test.ts` (13 кодов и 6 одиночных), 3 теста `errors.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/src/host apps/standalone/src/i18n/ru.json apps/standalone/test
git commit -m "feat(standalone): клиент хоста, API устройства и тексты ошибок в вебвью" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Мастер первого запуска

**Files:**

- Create: `apps/standalone/src/lib/form-error.ts`, `apps/standalone/src/wizard/wizard-form.ts`, `apps/standalone/src/wizard/BootstrapWizard.tsx`, `apps/standalone/test/support/wizard.ts`, `apps/standalone/test/wizard-form.test.ts`, `apps/standalone/test/wizard.test.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`

**Interfaces:**

- Consumes: `HostError` (`field`), `DeviceError`, `errorMessageKey` (задача 5); тип `BootstrapRequest` (задача 4); `hasValidCheckDigit`, `ssccSerialCapacity` из `@markiro/domain`.
- Produces:
  - `src/lib/form-error.ts`: `errorProp(message?: string): { error?: string }` (как `apps/admin/src/lib/form-error.ts`).
  - `src/wizard/wizard-form.ts`: `WIZARD_STEPS`, `WizardStep`, `MAX_LINES = 20`, `DEFAULT_TIME_ZONE = "Europe/Moscow"`, `WizardValues`, `WizardField`, `FieldIssue { field, message }` (message — ключ i18n), `defaultWizardValues(firstLineName)`, `issuerPrefix(gln)`, `parsePrefixList(text)`, `validateStep(step, values): FieldIssue[]`, `toBootstrapRequest(values): BootstrapRequest`, `fieldFromHost(path): WizardField | null`, `stepOf(field): WizardStep`.
  - `src/wizard/BootstrapWizard.tsx`: `BootstrapWizard({ onSubmit(request): Promise<void> })`.
  - `test/support/wizard.ts`: `completeWizard()` и `EXPECTED_REQUEST` — для тестов задач 6 и 8.

- [ ] **Step 1: Тексты и стили**

В `apps/standalone/src/i18n/ru.json` добавить верхнеуровневый ключ `wizard`:

```json
"wizard": {
  "title": "Первый запуск",
  "stepOf": "Шаг {{current}} из {{total}}",
  "steps": {
    "admin": "Администратор",
    "org": "Организация",
    "sscc": "Номера SSCC",
    "lines": "Линии",
    "review": "Проверка"
  },
  "back": "Назад",
  "next": "Далее",
  "submit": "Создать",
  "admin": {
    "intro": "Администратор управляет организацией, номерами SSCC, линиями, операторами и доступом в офис.",
    "login": "Логин",
    "loginHint": "3–64 символа: латиница, цифры, точка, дефис, подчёркивание",
    "name": "Имя и фамилия",
    "password": "Пароль",
    "passwordHint": "От 8 до 128 символов",
    "passwordConfirm": "Повторите пароль"
  },
  "org": {
    "intro": "Эти данные печатаются на этикетках и в формах.",
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
  "sscc": {
    "intro": "Если SSCC уже печатались другой программой, продолжите её нумерацию: укажите следующий свободный номер. Иначе оставьте как есть.",
    "prefix": "Префикс SSCC — {{prefix}}, номера до {{max}}.",
    "prefixUnknown": "Префикс SSCC появится после ввода GLN.",
    "box": "Следующий номер короба",
    "pallet": "Следующий номер паллеты"
  },
  "lines": {
    "intro": "Линии, на которых будут работать станции. Список можно изменить позже в офисе.",
    "name": "Линия {{index}}",
    "defaultName": "Линия 1",
    "add": "Добавить линию",
    "remove": "Удалить линию {{index}}"
  },
  "review": {
    "intro": "Проверьте данные. После создания мастер больше не откроется: всё остальное меняется в офисе.",
    "admin": "Администратор",
    "org": "Организация",
    "gln": "GLN",
    "prefix": "Префикс SSCC",
    "box": "Первый номер короба",
    "pallet": "Первый номер паллеты",
    "lines": "Линии"
  },
  "errors": {
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
    "serial": "Укажите целое неотрицательное число",
    "boxSerial": "Номера коробов начинаются с 1",
    "serialCapacity": "Номер не помещается в SSCC с этим префиксом",
    "lineName": "Укажите название линии, до 100 символов",
    "lineDuplicate": "Такая линия уже есть",
    "lines": "Нужна хотя бы одна линия, но не больше 20",
    "rejected": "Хост не принял это значение. Проверьте его."
  }
}
```

В конец `apps/standalone/src/app/shell.css` добавить:

```css
.standalone-form {
  display: grid;
  gap: 16px;
}

.standalone-form p {
  margin: 0;
}

.standalone-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.standalone-wizard__step,
.standalone-wizard__note {
  color: var(--fg-2);
}

.standalone-wizard__line {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: 8px;
}

.standalone-wizard__review {
  display: grid;
  gap: 8px;
  margin: 0;
}

.standalone-wizard__review div {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 16px;
}

.standalone-wizard__review dt {
  color: var(--fg-2);
}

.standalone-wizard__review dd {
  margin: 0;
  font-family: var(--font-mono);
}
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/test/support/wizard.ts`:

```ts
import { fireEvent, screen } from "@testing-library/react";

import type { BootstrapRequest } from "../../src/host/protocol.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

/**
 * Fill every step with valid answers and press «Создать». The GLN has a
 * correct check digit: 4600682000013.
 */
export async function completeWizard(): Promise<void> {
  await screen.findByText("Шаг 1 из 5 · Администратор");
  type("Логин", " admin ");
  type("Имя и фамилия", " Ирина Смирнова ");
  type("Пароль", "correct horse battery");
  type("Повторите пароль", "correct horse battery");
  next();

  await screen.findByText("Шаг 2 из 5 · Организация");
  type("Название организации", " ООО «Атолл» ");
  type("ИНН", "7701234567");
  type("GLN организации", "4600682000013");
  type("Префиксы GS1", "4600682, 4607091");
  next();

  await screen.findByText("Шаг 3 из 5 · Номера SSCC");
  type("Следующий номер короба", "1500");
  type("Следующий номер паллеты", "40");
  next();

  await screen.findByText("Шаг 4 из 5 · Линии");
  fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
  type("Линия 2", "Линия 2");
  next();

  await screen.findByText("Шаг 5 из 5 · Проверка");
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
}

/** The request `completeWizard` produces. */
export const EXPECTED_REQUEST: BootstrapRequest = {
  admin: { login: "admin", name: "Ирина Смирнова", password: "correct horse battery" },
  org: {
    name: "ООО «Атолл»",
    inn: "7701234567",
    gln: "4600682000013",
    gs1Prefixes: ["4600682", "4607091"],
    timeZone: "Europe/Moscow",
  },
  sscc: { boxNextSerial: 1500, palletNextSerial: 40 },
  lines: ["Линия 1", "Линия 2"],
};
```

`apps/standalone/test/wizard-form.test.ts`:

```ts
import { hasValidCheckDigit } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  defaultWizardValues,
  fieldFromHost,
  stepOf,
  toBootstrapRequest,
  validateStep,
  type WizardValues,
} from "../src/wizard/wizard-form.js";

function values(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
    ...defaultWizardValues("Линия 1"),
    login: "admin",
    adminName: "Ирина Смирнова",
    password: "correct horse battery",
    passwordConfirm: "correct horse battery",
    orgName: "ООО «Атолл»",
    gln: "4600682000013",
    ...overrides,
  };
}

describe("wizard steps", () => {
  it("accept valid answers on every step", () => {
    expect(hasValidCheckDigit("4600682000013")).toBe(true);
    expect(validateStep("review", values())).toEqual([]);
  });

  it("check the administrator", () => {
    expect(validateStep("admin", values({ login: "ад" }))).toEqual([
      { field: "login", message: "wizard.errors.login" },
    ]);
    expect(validateStep("admin", values({ adminName: "я".repeat(101) }))).toEqual([
      { field: "adminName", message: "wizard.errors.name" },
    ]);
    expect(validateStep("admin", values({ password: "short", passwordConfirm: "short" }))).toEqual([
      { field: "password", message: "wizard.errors.password" },
    ]);
    expect(validateStep("admin", values({ passwordConfirm: "another one" }))).toEqual([
      { field: "passwordConfirm", message: "wizard.errors.passwordConfirm" },
    ]);
  });

  it("check the organization, including the GLN check digit", () => {
    expect(validateStep("org", values({ gln: "460068200001" }))).toEqual([
      { field: "gln", message: "wizard.errors.gln" },
    ]);
    expect(validateStep("org", values({ gln: "4600682000010" }))).toEqual([
      { field: "gln", message: "wizard.errors.glnCheckDigit" },
    ]);
    expect(validateStep("org", values({ inn: "77012345678" }))).toEqual([
      { field: "inn", message: "wizard.errors.inn" },
    ]);
    expect(validateStep("org", values({ gs1Prefixes: "12, 4600682" }))).toEqual([
      { field: "gs1Prefixes", message: "wizard.errors.gs1Prefixes" },
    ]);
    const eleven = Array.from({ length: 11 }, (_, index) => String(4600680 + index)).join(",");
    expect(validateStep("org", values({ gs1Prefixes: eleven }))).toEqual([
      { field: "gs1Prefixes", message: "wizard.errors.gs1Prefixes" },
    ]);
    expect(validateStep("org", values({ orgName: "  " }))).toEqual([
      { field: "orgName", message: "wizard.errors.orgName" },
    ]);
  });

  it("check the SSCC starts against the prefix capacity", () => {
    expect(validateStep("sscc", values({ boxNextSerial: 0 }))).toEqual([
      { field: "boxNextSerial", message: "wizard.errors.boxSerial" },
    ]);
    expect(validateStep("sscc", values({ palletNextSerial: Number.NaN }))).toEqual([
      { field: "palletNextSerial", message: "wizard.errors.serial" },
    ]);
    expect(validateStep("sscc", values({ boxNextSerial: 10_000_000 }))).toEqual([
      { field: "boxNextSerial", message: "wizard.errors.serialCapacity" },
    ]);
    expect(validateStep("sscc", values({ boxNextSerial: 9_999_999 }))).toEqual([]);
  });

  it("check the lines, repeats ignoring case", () => {
    expect(
      validateStep("lines", values({ lines: [{ name: "Линия 1" }, { name: " линия 1 " }] })),
    ).toEqual([{ field: "lines.1.name", message: "wizard.errors.lineDuplicate" }]);
    expect(validateStep("lines", values({ lines: [{ name: " " }] }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lineName" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `Линия ${index + 1}` }));
    expect(validateStep("lines", values({ lines: many }))).toEqual([
      { field: "lines.0.name", message: "wizard.errors.lines" },
    ]);
  });
});

describe("the wizard request", () => {
  it("is trimmed and normalized", () => {
    const request = toBootstrapRequest(
      values({
        login: " admin ",
        orgName: " ООО «Атолл» ",
        inn: " ",
        gs1Prefixes: " 4600682 ;4607091, 4600682 ",
        lines: [{ name: " Линия 1 " }],
      }),
    );
    expect(request).toEqual({
      admin: { login: "admin", name: "Ирина Смирнова", password: "correct horse battery" },
      org: {
        name: "ООО «Атолл»",
        inn: null,
        gln: "4600682000013",
        gs1Prefixes: ["4600682", "4607091"],
        timeZone: "Europe/Moscow",
      },
      sscc: { boxNextSerial: 1, palletNextSerial: 0 },
      lines: ["Линия 1"],
    });
  });

  it("maps host field paths back to wizard fields and steps", () => {
    expect(fieldFromHost("org.gln")).toBe("gln");
    expect(fieldFromHost("admin.password")).toBe("password");
    expect(fieldFromHost("sscc.palletNextSerial")).toBe("palletNextSerial");
    expect(fieldFromHost("lines")).toBe("lines.0.name");
    expect(fieldFromHost("lines.3")).toBe("lines.3.name");
    expect(fieldFromHost("somethingElse")).toBeNull();
    expect(stepOf("gln")).toBe("org");
    expect(stepOf("boxNextSerial")).toBe("sscc");
    expect(stepOf("lines.3.name")).toBe("lines");
    expect(stepOf("passwordConfirm")).toBe("admin");
  });
});
```

`apps/standalone/test/wizard.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import { BootstrapWizard } from "../src/wizard/BootstrapWizard.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("BootstrapWizard", () => {
  it("creates the site from every answer", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(EXPECTED_REQUEST));
  });

  it("stays on a step until its fields are right", async () => {
    render(<BootstrapWizard onSubmit={vi.fn()} />);
    type("Логин", "admin");
    type("Имя и фамилия", "Ирина");
    type("Пароль", "correct horse battery");
    type("Повторите пароль", "another password");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(screen.getByText("Шаг 1 из 5 · Администратор")).toBeTruthy();
  });

  it("checks the GLN check digit before leaving the organization step", async () => {
    render(<BootstrapWizard onSubmit={vi.fn()} />);
    type("Имя и фамилия", "Ирина");
    type("Пароль", "correct horse battery");
    type("Повторите пароль", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Шаг 2 из 5 · Организация");
    type("Название организации", "ООО «Атолл»");
    type("GLN организации", "4600682000010");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeTruthy();
  });

  it("returns to the field the host rejected", async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "the GLN must be 13 digits",
        details: { field: "org.gln" },
      }),
    );
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    expect(await screen.findByText("Хост не принял это значение. Проверьте его.")).toBeTruthy();
    expect(screen.getByText("Шаг 2 из 5 · Организация")).toBeTruthy();
    expect(screen.getByLabelText("GLN организации")).toBeTruthy();
  });

  it("shows any other failure above the form", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new DeviceError("unreachable", "down"));
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    expect(await screen.findByText("Служба хоста на этом компьютере не отвечает.")).toBeTruthy();
    expect(screen.getByText("Шаг 5 из 5 · Проверка")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx`
Expected: FAIL — модулей мастера нет.

- [ ] **Step 4: Реализовать**

`apps/standalone/src/lib/form-error.ts`:

```ts
/**
 * Converts a possibly-undefined error message into a prop bag for the
 * `error?: string` prop of @markiro/ui controls. `exactOptionalPropertyTypes`
 * rejects an explicit `undefined`, so the key must be absent instead.
 */
export function errorProp(message?: string): { error?: string } {
  return message === undefined ? {} : { error: message };
}
```

`apps/standalone/src/wizard/wizard-form.ts`:

```ts
import { hasValidCheckDigit, ssccSerialCapacity } from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest } from "../host/protocol.js";

/** Administrator, organization, SSCC starts and lines (stage 1 spec §1), then a review. */
export const WIZARD_STEPS = ["admin", "org", "sscc", "lines", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** At most 20 lines, as on the host. */
export const MAX_LINES = 20;
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

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

/** The SSCC issuer prefix the host derives from a GLN: its first 9 digits, as in the cloud. */
export function issuerPrefix(gln: string): string {
  return gln.slice(0, 9);
}

/** Split on commas, semicolons and spaces; repeats collapse. */
export function parsePrefixList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((prefix) => prefix.length > 0))];
}

/** Characters as the host counts them (Unicode scalar values). */
function characters(text: string): number {
  return [...text].length;
}

function isValidPrefixList(text: string): boolean {
  const prefixes = parsePrefixList(text);
  return prefixes.length <= 10 && prefixes.every((prefix) => /^\d{4,12}$/.test(prefix));
}

const THIRTEEN_DIGITS = /^\d{13}$/;

const adminSchema = z.object({
  login: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{3,64}$/, "wizard.errors.login"),
  adminName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 100, "wizard.errors.name"),
  password: z
    .string()
    .refine(
      (password) => characters(password) >= 8 && characters(password) <= 128,
      "wizard.errors.password",
    ),
});

const orgSchema = z.object({
  orgName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 200, "wizard.errors.orgName"),
  inn: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{12})?$/, "wizard.errors.inn"),
  gln: z
    .string()
    .trim()
    .regex(THIRTEEN_DIGITS, "wizard.errors.gln")
    .refine(
      (gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln),
      "wizard.errors.glnCheckDigit",
    ),
  gs1Prefixes: z.string().refine(isValidPrefixList, "wizard.errors.gs1Prefixes"),
  timeZone: z.string().min(1, "wizard.errors.timeZone"),
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
        issues.push({ field: "passwordConfirm", message: "wizard.errors.passwordConfirm" });
      }
      return issues;
    }
    case "org":
      return issuesOf(orgSchema.safeParse(values).error);
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
  const inn = values.inn.trim();
  return {
    admin: {
      login: values.login.trim(),
      name: values.adminName.trim(),
      password: values.password,
    },
    org: {
      name: values.orgName.trim(),
      inn: inn === "" ? null : inn,
      gln: values.gln.trim(),
      gs1Prefixes: parsePrefixList(values.gs1Prefixes),
      timeZone: values.timeZone,
    },
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
  };
}

const HOST_FIELDS: Readonly<Record<string, WizardField>> = {
  "admin.login": "login",
  "admin.name": "adminName",
  "admin.password": "password",
  "org.name": "orgName",
  "org.inn": "inn",
  "org.gln": "gln",
  "org.gs1Prefixes": "gs1Prefixes",
  "org.timeZone": "timeZone",
  "sscc.boxNextSerial": "boxNextSerial",
  "sscc.palletNextSerial": "palletNextSerial",
  lines: "lines.0.name",
};

/** The wizard field a host `validation_failed` names (`org.gln`, `lines.2`). */
export function fieldFromHost(path: string): WizardField | null {
  const line = /^lines\.(\d+)$/.exec(path);
  if (line) return `lines.${Number(line[1])}.name`;
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

`apps/standalone/src/wizard/BootstrapWizard.tsx`:

```tsx
import { ssccSerialCapacity } from "@markiro/domain";
import { useMemo, useState, type FormEvent } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Combobox, IconButton, Input } from "@markiro/ui";

import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";
import type { BootstrapRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";
import {
  DEFAULT_TIME_ZONE,
  defaultWizardValues,
  fieldFromHost,
  issuerPrefix,
  MAX_LINES,
  stepOf,
  toBootstrapRequest,
  validateStep,
  WIZARD_STEPS,
  type FieldIssue,
  type WizardStep,
  type WizardValues,
} from "./wizard-form.js";

/** IANA zones this runtime knows, the default first. */
const TIME_ZONES = [...new Set([DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")])];

export interface BootstrapWizardProps {
  /** Pairs this computer if needed and creates the site; rejects with a `HostError` or a `DeviceError`. */
  onSubmit(request: BootstrapRequest): Promise<void>;
}

export function BootstrapWizard({ onSubmit }: BootstrapWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>("admin");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    control,
    getValues,
    setError,
    clearErrors,
    watch,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<WizardValues>({
    defaultValues: defaultWizardValues(t("wizard.lines.defaultName")),
  });
  const lines = useFieldArray({ control, name: "lines" });
  const position = WIZARD_STEPS.indexOf(step);
  const gln = watch("gln").trim();
  const prefix = /^\d{13}$/.test(gln) ? issuerPrefix(gln) : null;
  const zones = useMemo(
    () =>
      TIME_ZONES.map((zone) => ({
        value: zone,
        label: zone.replaceAll("_", " "),
        keywords: [zone],
      })),
    [],
  );

  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const show = (issues: readonly FieldIssue[]) => {
    for (const issue of issues) setError(issue.field, { type: "validate", message: issue.message });
  };

  const goNext = () => {
    clearErrors();
    const issues = validateStep(step, getValues());
    if (issues.length > 0) {
      show(issues);
      return;
    }
    const following = WIZARD_STEPS[position + 1];
    if (following) setStep(following);
  };

  const goBack = () => {
    clearErrors();
    const previous = WIZARD_STEPS[position - 1];
    if (previous) setStep(previous);
  };

  const create = handleSubmit(async (values) => {
    setSubmitError(null);
    clearErrors();
    const issues = validateStep("review", values);
    const first = issues[0];
    if (first) {
      setStep(stepOf(first.field));
      show(issues);
      return;
    }
    try {
      await onSubmit(toBootstrapRequest(values));
    } catch (error) {
      const field = error instanceof HostError && error.field ? fieldFromHost(error.field) : null;
      if (field) {
        setStep(stepOf(field));
        setError(field, { type: "server", message: "wizard.errors.rejected" });
        return;
      }
      setSubmitError(errorMessageKey(error));
    }
  });

  // Enter on a step moves on; only the review step creates the site.
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    if (step === "review") {
      void create(event);
      return;
    }
    event.preventDefault();
    goNext();
  };

  return (
    <Card className="standalone-card" title={t("wizard.title")} titleAs="h2">
      <form className="standalone-form" onSubmit={submitForm} noValidate>
        <p className="standalone-wizard__step">
          {t("wizard.stepOf", { current: position + 1, total: WIZARD_STEPS.length })}
          {" · "}
          {t(`wizard.steps.${step}`)}
        </p>
        {submitError && <Alert tone="error">{t(submitError)}</Alert>}

        {step === "admin" && (
          <>
            <p>{t("wizard.admin.intro")}</p>
            <Input
              label={t("wizard.admin.login")}
              hint={t("wizard.admin.loginHint")}
              autoComplete="username"
              {...fieldError(errors.login?.message)}
              {...register("login")}
            />
            <Input
              label={t("wizard.admin.name")}
              {...fieldError(errors.adminName?.message)}
              {...register("adminName")}
            />
            <Input
              type="password"
              autoComplete="new-password"
              label={t("wizard.admin.password")}
              hint={t("wizard.admin.passwordHint")}
              {...fieldError(errors.password?.message)}
              {...register("password")}
            />
            <Input
              type="password"
              autoComplete="new-password"
              label={t("wizard.admin.passwordConfirm")}
              {...fieldError(errors.passwordConfirm?.message)}
              {...register("passwordConfirm")}
            />
          </>
        )}

        {step === "org" && (
          <>
            <p>{t("wizard.org.intro")}</p>
            <Input
              label={t("wizard.org.name")}
              {...fieldError(errors.orgName?.message)}
              {...register("orgName")}
            />
            <Input
              label={t("wizard.org.inn")}
              hint={t("wizard.org.innHint")}
              inputMode="numeric"
              mono
              {...fieldError(errors.inn?.message)}
              {...register("inn")}
            />
            <Input
              label={t("wizard.org.gln")}
              hint={t("wizard.org.glnHint")}
              inputMode="numeric"
              mono
              {...fieldError(errors.gln?.message)}
              {...register("gln")}
            />
            <Input
              label={t("wizard.org.gs1Prefixes")}
              hint={t("wizard.org.gs1PrefixesHint")}
              mono
              {...fieldError(errors.gs1Prefixes?.message)}
              {...register("gs1Prefixes")}
            />
            <Controller
              control={control}
              name="timeZone"
              render={({ field }) => (
                <Combobox
                  label={t("wizard.org.timeZone")}
                  options={zones}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder={t("wizard.org.timeZonePlaceholder")}
                  searchPlaceholder={t("wizard.org.timeZoneSearch")}
                  emptyText={t("wizard.org.timeZoneEmpty")}
                  loadingText={t("wizard.org.timeZoneLoading")}
                  {...fieldError(errors.timeZone?.message)}
                />
              )}
            />
          </>
        )}

        {step === "sscc" && (
          <>
            <p>{t("wizard.sscc.intro")}</p>
            <p className="standalone-wizard__note">
              {prefix
                ? t("wizard.sscc.prefix", { prefix, max: ssccSerialCapacity(prefix) - 1 })
                : t("wizard.sscc.prefixUnknown")}
            </p>
            <Input
              type="number"
              min={1}
              step={1}
              mono
              label={t("wizard.sscc.box")}
              {...fieldError(errors.boxNextSerial?.message)}
              {...register("boxNextSerial", { valueAsNumber: true })}
            />
            <Input
              type="number"
              min={0}
              step={1}
              mono
              label={t("wizard.sscc.pallet")}
              {...fieldError(errors.palletNextSerial?.message)}
              {...register("palletNextSerial", { valueAsNumber: true })}
            />
          </>
        )}

        {step === "lines" && (
          <>
            <p>{t("wizard.lines.intro")}</p>
            {lines.fields.map((line, index) => (
              <div className="standalone-wizard__line" key={line.id}>
                <Input
                  label={t("wizard.lines.name", { index: index + 1 })}
                  {...fieldError(errors.lines?.[index]?.name?.message)}
                  {...register(`lines.${index}.name`)}
                />
                {lines.fields.length > 1 && (
                  <IconButton
                    variant="secondary"
                    icon="✕"
                    aria-label={t("wizard.lines.remove", { index: index + 1 })}
                    onClick={() => lines.remove(index)}
                  />
                )}
              </div>
            ))}
            <Button
              variant="secondary"
              onClick={() => lines.append({ name: "" })}
              disabled={lines.fields.length >= MAX_LINES}
            >
              {t("wizard.lines.add")}
            </Button>
          </>
        )}

        {step === "review" && <WizardReview values={getValues()} />}

        <div className="standalone-form__actions">
          {position > 0 && (
            <Button variant="secondary" onClick={goBack} disabled={isSubmitting}>
              {t("wizard.back")}
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {t(step === "review" ? "wizard.submit" : "wizard.next")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function WizardReview({ values }: { values: WizardValues }) {
  const { t } = useTranslation();
  const request = toBootstrapRequest(values);
  const rows: [string, string][] = [
    [t("wizard.review.admin"), request.admin.login],
    [t("wizard.review.org"), request.org.name],
    [t("wizard.review.gln"), request.org.gln],
    [t("wizard.review.prefix"), issuerPrefix(request.org.gln)],
    [t("wizard.review.box"), String(request.sscc.boxNextSerial)],
    [t("wizard.review.pallet"), String(request.sscc.palletNextSerial)],
    [t("wizard.review.lines"), request.lines.join(", ")],
  ];
  return (
    <>
      <p>{t("wizard.review.intro")}</p>
      <dl className="standalone-wizard__review">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
```

- [ ] **Step 5: Проверки проходят**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

Expected: всё зелёное; 7 тестов в `wizard-form.test.ts`, 5 — в `wizard.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/src/lib apps/standalone/src/wizard apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/support/wizard.ts apps/standalone/test/wizard-form.test.ts apps/standalone/test/wizard.test.tsx
git commit -m "feat(standalone): мастер первого запуска в приложении" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Вход в офис и рамка офиса

**Files:**

- Create: `apps/standalone/src/office/office-session.tsx`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/OfficeLogin.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/office/OfficeOverview.tsx`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/test/office.test.tsx`
- Modify: `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`

**Interfaces:**

- Consumes: `errorMessageKey` (задача 5), `errorProp` (задача 6), типы `OfficeLoginRequest`, `OfficeUser`, `OfficeRole` (задача 4).
- Produces:
  - `office-session.tsx`: `OfficeSessionValue { user: OfficeUser; call<T>(operation: (token: string) => Promise<T>): Promise<T>; leave(): void; logout(): Promise<void> }`, `OfficeSessionProvider`, `useOfficeSession()`. Токен виден только внутри `call`.
  - `nav.ts`: `OfficeNavItem { to, labelKey, sectionKey, roles }`, `OFFICE_NAV` — сейчас только «Обзор»; план 1b3 добавляет разделы.
  - `routes.tsx`: `officeRoutes: RouteObject[]` — `/` → `OfficeShell` → индекс `OfficeOverview`.
  - `Office.tsx`: `Office({ session: OfficeSessionValue })` — `createMemoryRouter(officeRoutes)` внутри `OfficeSessionProvider`.
  - `OfficeLogin.tsx`: `OfficeLogin({ notice: "session_ended" | null; onLogin(request): Promise<void>; onBack(): void })`.

- [ ] **Step 1: Тексты и стили**

В `apps/standalone/src/i18n/ru.json` добавить верхнеуровневый ключ `office`:

```json
"office": {
  "login": {
    "title": "Вход в офис",
    "login": "Логин",
    "password": "Пароль",
    "submit": "Войти",
    "back": "В цех",
    "sessionEnded": "Сессия офиса закончилась. Войдите снова.",
    "required": "Заполните поле"
  },
  "nav": {
    "label": "Разделы офиса",
    "sections": { "office": "Офис" },
    "overview": "Обзор"
  },
  "header": {
    "toFloor": "В цех",
    "logout": "Выйти",
    "darkTheme": "Включить тёмную тему",
    "lightTheme": "Включить светлую тему"
  },
  "overview": {
    "title": "Офис",
    "greeting": "Вы вошли как {{name}}.",
    "role": "Роль: {{role}}."
  },
  "roles": {
    "admin": "администратор",
    "technologist": "технолог"
  }
}
```

В конец `apps/standalone/src/app/shell.css` добавить:

```css
.office-shell {
  display: flex;
  min-height: 100vh;
  background: var(--surface-page);
  color: var(--fg-1);
  font-family: var(--font-ui);
}

.office-shell__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.office-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
}

.office-header__user {
  display: flex;
  flex-direction: column;
}

.office-header__name {
  font-weight: 600;
}

.office-header__role {
  color: var(--fg-2);
}

.office-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.office-shell__content {
  display: grid;
  align-content: start;
  gap: 16px;
  padding: 24px;
}
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/test/office.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type { OfficeUser } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
import type { OfficeSessionValue } from "../src/office/office-session.js";
import { SESSION } from "./support/fixtures.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function sessionFor(user: OfficeUser = SESSION.user) {
  return {
    user,
    call: <T,>(operation: (token: string) => Promise<T>) => operation(SESSION.token),
    leave: vi.fn(),
    logout: vi.fn(async () => {}),
  } satisfies OfficeSessionValue;
}

describe("OfficeLogin", () => {
  it("signs in with the trimmed login", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    type("Логин", " admin ");
    type("Пароль", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ login: "admin", password: "correct horse battery" }),
    );
  });

  it("asks for both fields before calling the host", async () => {
    const onLogin = vi.fn();
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findAllByText("Заполните поле")).toHaveLength(2);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it.each([
    [
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "wrong login or password",
        details: { credential: "password" },
      }),
      "Неверный логин или пароль.",
    ],
    [
      new HostError({ kind: "api", code: "rate_limited", status: 429, message: "slow down" }),
      "Слишком много попыток. Подождите минуту и попробуйте снова.",
    ],
    [
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    ],
  ])("explains a failed sign-in (%#)", async (error, text) => {
    render(
      <OfficeLogin notice={null} onLogin={vi.fn().mockRejectedValue(error)} onBack={vi.fn()} />,
    );
    type("Логин", "admin");
    type("Пароль", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("says why the session ended and goes back to the floor", () => {
    const onBack = vi.fn();
    render(<OfficeLogin notice="session_ended" onLogin={vi.fn()} onBack={onBack} />);
    expect(screen.getByText("Сессия офиса закончилась. Войдите снова.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "В цех" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("Office", () => {
  // ThemeProvider keeps the chosen theme in localStorage; start each test dark.
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  function renderOffice(session: OfficeSessionValue) {
    return render(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} />
      </ThemeProvider>,
    );
  }

  it("shows who is signed in and the sections of their role", async () => {
    renderOffice(sessionFor());
    expect(await screen.findByText("Ирина Смирнова")).toBeTruthy();
    expect(screen.getByText("администратор")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Обзор" })).toBeTruthy();
    expect(screen.getByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.getByText("Роль: администратор.")).toBeTruthy();
  });

  it("names the technologist role", async () => {
    renderOffice(sessionFor({ ...SESSION.user, role: "technologist" }));
    expect(await screen.findByText("технолог")).toBeTruthy();
  });

  it("goes back to the floor and signs out from the header", async () => {
    const session = sessionFor();
    renderOffice(session);
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    expect(session.leave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it("switches the theme", async () => {
    renderOffice(sessionFor());
    fireEvent.click(await screen.findByRole("button", { name: "Включить светлую тему" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Включить тёмную тему" })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx`
Expected: FAIL — модулей офиса нет.

- [ ] **Step 4: Реализовать**

`apps/standalone/src/office/office-session.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { OfficeUser } from "../host/protocol.js";

/** The open office session, provided by the shell to every office screen. */
export interface OfficeSessionValue {
  user: OfficeUser;
  /**
   * Runs a host call with the session token. An ended session or a rejected
   * device is routed to the shell before the error is rethrown.
   */
  call<T>(operation: (token: string) => Promise<T>): Promise<T>;
  /** Back to the floor; the session stays open until the host expires it. */
  leave(): void;
  /** Ends the session on the host and returns to the floor. */
  logout(): Promise<void>;
}

const OfficeSessionContext = createContext<OfficeSessionValue | null>(null);

export function OfficeSessionProvider({
  value,
  children,
}: {
  value: OfficeSessionValue;
  children: ReactNode;
}) {
  return <OfficeSessionContext.Provider value={value}>{children}</OfficeSessionContext.Provider>;
}

export function useOfficeSession(): OfficeSessionValue {
  const value = useContext(OfficeSessionContext);
  if (!value) throw new Error("useOfficeSession must be used inside OfficeSessionProvider");
  return value;
}
```

`apps/standalone/src/office/nav.ts`:

```ts
import type { OfficeRole } from "../host/protocol.js";

export interface OfficeNavItem {
  to: string;
  labelKey: string;
  sectionKey: string;
  roles: readonly OfficeRole[];
}

/** Office sections by role (spec §4.8); plan 1b3 adds the organization, SSCC and users. */
export const OFFICE_NAV: readonly OfficeNavItem[] = [
  {
    to: "/",
    labelKey: "office.nav.overview",
    sectionKey: "office.nav.sections.office",
    roles: ["admin", "technologist"],
  },
];
```

`apps/standalone/src/office/OfficeLogin.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Input } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";
import type { OfficeLoginRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";

const loginSchema = z.object({
  login: z.string().trim().min(1, "office.login.required"),
  password: z.string().min(1, "office.login.required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export interface OfficeLoginProps {
  notice: "session_ended" | null;
  /** Rejects with a `HostError` the form explains. */
  onLogin(request: OfficeLoginRequest): Promise<void>;
  onBack(): void;
}

export function OfficeLogin({ notice, onLogin, onBack }: OfficeLoginProps) {
  const { t } = useTranslation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { login: "", password: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await onLogin({ login: values.login, password: values.password });
    } catch (error) {
      setSubmitError(errorMessageKey(error));
    }
  });

  return (
    <Card className="standalone-card" title={t("office.login.title")} titleAs="h2">
      <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
        {notice === "session_ended" && <Alert tone="info">{t("office.login.sessionEnded")}</Alert>}
        {submitError && <Alert tone="error">{t(submitError)}</Alert>}
        <Input
          label={t("office.login.login")}
          autoComplete="username"
          {...fieldError(errors.login?.message)}
          {...register("login")}
        />
        <Input
          type="password"
          autoComplete="current-password"
          label={t("office.login.password")}
          {...fieldError(errors.password?.message)}
          {...register("password")}
        />
        <div className="standalone-form__actions">
          <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
            {t("office.login.back")}
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
```

`apps/standalone/src/office/OfficeShell.tsx`:

```tsx
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";

import { Button, cn, IconButton, Sidebar, useTheme, type SidebarItem } from "@markiro/ui";

import { OFFICE_NAV } from "./nav.js";
import { useOfficeSession } from "./office-session.js";

/** Office layout after `apps/admin/src/layout/AppShell.tsx`: sidebar, header, page. */
export function OfficeShell() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const items = useMemo<SidebarItem[]>(
    () =>
      OFFICE_NAV.filter((item) => item.roles.includes(session.user.role)).map((item) => ({
        to: item.to,
        labelKey: t(item.labelKey),
        section: t(item.sectionKey),
      })),
    [session.user.role, t],
  );

  return (
    <div className="office-shell">
      <Sidebar
        items={items}
        navLabel={t("office.nav.label")}
        renderLink={(item, content) => (
          <NavLink
            to={item.to}
            end
            className={({ isActive }) =>
              cn("mk-sidebar__link", isActive && "mk-sidebar__link--active")
            }
          >
            {content}
          </NavLink>
        )}
      />
      <div className="office-shell__main">
        <header className="office-header">
          <div className="office-header__user">
            <span className="office-header__name">{session.user.name}</span>
            <span className="office-header__role">{t(`office.roles.${session.user.role}`)}</span>
          </div>
          <div className="office-header__actions">
            <IconButton
              variant="secondary"
              icon={dark ? "☀" : "☾"}
              aria-label={t(dark ? "office.header.lightTheme" : "office.header.darkTheme")}
              onClick={() => setTheme(dark ? "light" : "dark")}
            />
            <Button variant="secondary" onClick={session.leave}>
              {t("office.header.toFloor")}
            </Button>
            <Button variant="secondary" onClick={() => void session.logout()}>
              {t("office.header.logout")}
            </Button>
          </div>
        </header>
        <main className="office-shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

`apps/standalone/src/office/OfficeOverview.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Card, PageHeader } from "@markiro/ui";

import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  return (
    <>
      <PageHeader title={t("office.overview.title")} />
      <Card>
        <p>{t("office.overview.greeting", { name: user.name })}</p>
        <p>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</p>
      </Card>
    </>
  );
}
```

`apps/standalone/src/office/routes.tsx`:

```tsx
import type { RouteObject } from "react-router";

import { OfficeOverview } from "./OfficeOverview.js";
import { OfficeShell } from "./OfficeShell.js";

/** Office routes; plan 1b3 adds the organization, SSCC and users pages as children. */
export const officeRoutes: RouteObject[] = [
  {
    path: "/",
    element: <OfficeShell />,
    children: [{ index: true, element: <OfficeOverview /> }],
  },
];
```

`apps/standalone/src/office/Office.tsx`:

```tsx
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { OfficeSessionProvider, type OfficeSessionValue } from "./office-session.js";
import { officeRoutes } from "./routes.js";

export interface OfficeProps {
  session: OfficeSessionValue;
}

/** The office: an in-memory router (a desktop window has no address bar) under the session. */
export function Office({ session }: OfficeProps) {
  const [router] = useState(() => createMemoryRouter(officeRoutes, { initialEntries: ["/"] }));
  return (
    <OfficeSessionProvider value={session}>
      <RouterProvider router={router} />
    </OfficeSessionProvider>
  );
}
```

- [ ] **Step 5: Проверки проходят**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
```

Expected: всё зелёное; 10 тестов в `office.test.tsx`: 6 для `OfficeLogin` (из них 3 — случаи отказа входа) и 4 для `Office`.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/src/office apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/office.test.tsx
git commit -m "feat(standalone): вход в офис и рамка офиса" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Автомат состояний оболочки и сборка приложения

**Files:**

- Create: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/screens.tsx`, `apps/standalone/test/shell.test.ts`
- Modify: `apps/standalone/src/app/App.tsx` (заменить целиком), `apps/standalone/test/app.test.tsx` (заменить целиком), `apps/standalone/src/i18n/ru.json`
- Delete: `apps/standalone/src/app/use-local-host.ts`

**Interfaces:**

- Consumes: всё из задач 4–7; `createTauriHostProbe`, `HostProbeError`, `HelloObservation`, `HostProbeErrorCode` из `src/host/probe.ts` (план 1a).
- Produces:
  - `shell.ts`: `LocalHostState`, `DeviceState`, `PairingState`, `RejectionReason = "key_rejected" | "host_changed"`, `ShellState`, `ShellView`, `ShellAction`, `initialShellState`, `nextShellView(state): ShellView`, `shellReducer(state, action): ShellState`, `shellActionFor(error: unknown): ShellAction | null`.
  - `App.tsx`: `App({ probe?, device?, host?, address? })` — без аргументов берёт команды Tauri.

- [ ] **Step 1: Тексты**

В `apps/standalone/src/i18n/ru.json` заменить верхнеуровневый ключ `shell` целиком (ключи `probing` и `hostFound` из плана 1a больше не нужны) и добавить ключи `device` и `floor`:

```json
"shell": {
  "loading": "Загрузка…",
  "hostMissing": {
    "title": "Служба хоста не отвечает",
    "body": "Служба «Markiro Хост» не отвечает по адресу {{address}}. Проверьте, что она запущена на этом компьютере.",
    "unreachable": "Нет соединения.",
    "notHost": "По этому адресу отвечает не служба Markiro.",
    "invalidResponse": "Служба ответила в неожиданном формате.",
    "retry": "Проверить снова"
  },
  "version": {
    "title": "Версии не совпадают",
    "hostTooOld": "Служба «Markiro Хост» старее этого приложения. Обновите службу на ПК-хосте.",
    "appTooOld": "Это приложение старее службы «Markiro Хост». Обновите приложение."
  },
  "configError": {
    "title": "Настройки подключения повреждены",
    "body": "Файл подключения этого компьютера к хосту не читается. Сбросьте подключение — приложение подключится к хосту на этом компьютере заново.",
    "reset": "Сбросить подключение"
  },
  "pairing": {
    "title": "Подключаем этот компьютер к хосту…"
  },
  "pairFailed": {
    "title": "Не удалось подключиться к хосту",
    "retry": "Повторить"
  },
  "deviceRejected": {
    "title": "Хост не принимает это устройство",
    "keyRejected": "Хост не узнаёт ключ этого устройства: устройство могли отключить в офисе или восстановить базу хоста из копии.",
    "hostChanged": "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
    "repair": "Подключить заново"
  }
},
"device": {
  "localName": "Рабочее место хоста"
},
"floor": {
  "title": "Цех",
  "body": "Рабочий экран цеха появится в следующем обновлении. Отсюда можно перейти в офис.",
  "office": "Офис"
}
```

- [ ] **Step 2: Написать падающие тесты**

`apps/standalone/test/shell.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  initialShellState,
  nextShellView,
  shellActionFor,
  shellReducer,
  type ShellState,
} from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";

function unpaired(overrides: Partial<ShellState> = {}): ShellState {
  return { ...initialShellState, device: { kind: "ready", status: null }, ...overrides };
}

function paired(overrides: Partial<ShellState> = {}): ShellState {
  return {
    ...initialShellState,
    device: { kind: "ready", status: DEVICE_STATUS },
    localHost: { kind: "found", observation: observation(true) },
    ...overrides,
  };
}

describe("nextShellView", () => {
  it("waits for the device and the local host", () => {
    expect(nextShellView(initialShellState)).toEqual({ kind: "loading" });
    expect(nextShellView(unpaired())).toEqual({ kind: "loading" });
  });

  it("reports an unreadable device config", () => {
    expect(nextShellView({ ...initialShellState, device: { kind: "unreadable" } })).toEqual({
      kind: "config_error",
    });
  });

  it("routes an unpaired device by what the local host says", () => {
    expect(
      nextShellView(unpaired({ localHost: { kind: "missing", reason: "unreachable" } })),
    ).toEqual({ kind: "host_missing", reason: "unreachable" });
    expect(
      nextShellView(unpaired({ localHost: { kind: "found", observation: observation(false) } })),
    ).toEqual({ kind: "bootstrap" });
    expect(
      nextShellView(unpaired({ localHost: { kind: "found", observation: observation(true) } })),
    ).toEqual({ kind: "pairing" });
    expect(
      nextShellView(
        unpaired({
          localHost: { kind: "found", observation: observation(true) },
          pairing: { kind: "failed", code: "pair_rejected" },
        }),
      ),
    ).toEqual({ kind: "pair_failed", code: "pair_rejected" });
  });

  it("finishes the wizard for a paired device whose host is not initialized", () => {
    expect(
      nextShellView(paired({ localHost: { kind: "found", observation: observation(false) } })),
    ).toEqual({ kind: "bootstrap" });
    const otherHost = observation(false);
    otherHost.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
    expect(nextShellView(paired({ localHost: { kind: "found", observation: otherHost } }))).toEqual(
      { kind: "floor" },
    );
  });

  it("shows the floor, the office sign-in and the office", () => {
    expect(nextShellView(paired())).toEqual({ kind: "floor" });
    expect(
      nextShellView(paired({ office: { visible: true, session: null, notice: "session_ended" } })),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(
      nextShellView(paired({ office: { visible: true, session: SESSION, notice: null } })),
    ).toEqual({ kind: "office", session: SESSION });
  });

  it("puts a rejected device before everything else", () => {
    expect(
      nextShellView(
        paired({
          rejection: "key_rejected",
          office: { visible: true, session: SESSION, notice: null },
        }),
      ),
    ).toEqual({ kind: "device_rejected", reason: "key_rejected" });
  });
});

describe("shellReducer", () => {
  it("keeps the session when the office is left and drops it on sign-out", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const left = shellReducer(open, { type: "office_left" });
    expect(left.office).toEqual({ visible: false, session: SESSION, notice: null });
    expect(shellReducer(left, { type: "office_requested" }).office.visible).toBe(true);
    expect(shellReducer(open, { type: "logged_out" }).office).toEqual({
      visible: false,
      session: null,
      notice: null,
    });
  });

  it("asks for a new sign-in when the session ends", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    expect(shellReducer(open, { type: "session_ended" }).office).toEqual({
      visible: true,
      session: null,
      notice: "session_ended",
    });
  });

  it("closes the office for a rejected device and resets after forgetting", () => {
    const open = shellReducer(paired(), { type: "office_opened", session: SESSION });
    const rejected = shellReducer(open, { type: "device_rejected", reason: "host_changed" });
    expect(rejected.rejection).toBe("host_changed");
    expect(rejected.office.session).toBeNull();
    const forgotten = shellReducer(rejected, { type: "forgotten" });
    expect(forgotten.device).toEqual({ kind: "ready", status: null });
    expect(forgotten.rejection).toBeNull();
  });

  it("marks the local host initialized after the wizard", () => {
    const fresh = unpaired({ localHost: { kind: "found", observation: observation(false) } });
    const next = shellReducer(fresh, { type: "host_initialized" });
    expect(next.localHost).toEqual({ kind: "found", observation: observation(true) });
  });

  it("retries a failed pairing", () => {
    const failed = unpaired({ pairing: { kind: "failed", code: "unreachable" } });
    expect(shellReducer(failed, { type: "pairing_retried" }).pairing).toEqual({ kind: "idle" });
  });
});

describe("shellActionFor", () => {
  function unauthorized(credential: string): HostError {
    return new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: credential,
      details: { credential },
    });
  }

  it("routes session and device rejections to the shell", () => {
    expect(shellActionFor(unauthorized("session"))).toEqual({ type: "session_ended" });
    expect(shellActionFor(unauthorized("device"))).toEqual({
      type: "device_rejected",
      reason: "key_rejected",
    });
    expect(
      shellActionFor(
        new HostError({ kind: "transport", code: "certificate_mismatch", message: "" }),
      ),
    ).toEqual({ type: "device_rejected", reason: "host_changed" });
  });

  it("leaves everything else to the screen", () => {
    expect(shellActionFor(unauthorized("password"))).toBeNull();
    expect(
      shellActionFor(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBeNull();
    expect(shellActionFor(new Error("boom"))).toBeNull();
  });
});
```

`apps/standalone/test/app.test.tsx` заменить целиком:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { App } from "../src/app/App.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type { DeviceStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

const ADDRESS = "https://127.0.0.1:45710";

/** Answers `hello` in order; the last answer repeats. `true`/`false` is `initialized`. */
function probeAnswering(...answers: Array<boolean | HostProbeError>) {
  let calls = 0;
  const hello = vi.fn<HostProbe["hello"]>(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? true;
    calls += 1;
    if (answer instanceof HostProbeError) throw answer;
    return observation(answer);
  });
  return { hello };
}

function fakeDevice(initial: DeviceStatus | null | DeviceError) {
  let paired: DeviceStatus | null = initial instanceof DeviceError ? null : initial;
  let broken = initial instanceof DeviceError ? initial : null;
  return {
    status: vi.fn<DeviceApi["status"]>(async () => {
      if (broken) throw broken;
      return paired;
    }),
    pairLocally: vi.fn<DeviceApi["pairLocally"]>(async () => {
      paired = DEVICE_STATUS;
      return DEVICE_STATUS;
    }),
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
      broken = null;
    }),
  };
}

function fakeHost() {
  return {
    bootstrap: vi.fn<HostApi["bootstrap"]>(async () => ({ session: SESSION })),
    officeLogin: vi.fn<HostApi["officeLogin"]>(async () => SESSION),
    officeLogout: vi.fn<HostApi["officeLogout"]>(async () => {}),
  };
}

function renderApp(services: { probe: HostProbe; device: DeviceApi; host: HostApi }) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App {...services} address={ADDRESS} />
    </ThemeProvider>,
  );
}

async function signIn(): Promise<void> {
  await screen.findByText("Вход в офис");
  fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));
}

describe("App", () => {
  it("creates the site on a fresh host and opens the office", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(false), device, host });
    expect(await screen.findByText("Первый запуск")).toBeTruthy();
    await completeWizard();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledWith("Рабочее место хоста");
    expect(host.bootstrap).toHaveBeenCalledWith(EXPECTED_REQUEST);
  });

  it("finishes the wizard without pairing again when the device is already paired", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(false), device, host });
    await screen.findByText("Первый запуск");
    await completeWizard();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(device.pairLocally).not.toHaveBeenCalled();
  });

  it("pairs with an initialized host and opens the office from the floor", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(true), device, host });
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(host.officeLogin).toHaveBeenCalledWith({
      login: "admin",
      password: "correct horse battery",
    });

    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(host.officeLogout).toHaveBeenCalledWith("office-session-token");
  });

  it("keeps the session when going back to the floor", async () => {
    const host = fakeHost();
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(host.officeLogin).toHaveBeenCalledTimes(1);
    expect(host.officeLogout).not.toHaveBeenCalled();
  });

  it("adopts a pairing another start of the app already made", async () => {
    const device = fakeDevice(null);
    device.pairLocally.mockRejectedValueOnce(new DeviceError("already_paired", "raced"));
    device.status.mockResolvedValueOnce(null).mockResolvedValueOnce(DEVICE_STATUS);
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Цех")).toBeTruthy();
  });

  it("sends a rejected device back to pairing", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.officeLogin.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "unknown or revoked device key",
        details: { credential: "device" },
      }),
    );
    renderApp({ probe: probeAnswering(true), device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("offers to reset an unreadable device config", async () => {
    const device = fakeDevice(new DeviceError("config_unreadable", "broken"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Настройки подключения повреждены")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить подключение" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("explains a missing host and finds it after a retry", async () => {
    const probe = probeAnswering(new HostProbeError("unreachable", "down"), true);
    renderApp({ probe, device: fakeDevice(null), host: fakeHost() });
    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
    expect(screen.getByText("Нет соединения.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(probe.hello).toHaveBeenCalledWith(ADDRESS);
  });

  it("explains a version mismatch instead of a missing host", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("app_too_old", "old")),
      device: fakeDevice(null),
      host: fakeHost(),
    });
    expect(await screen.findByText("Версии не совпадают")).toBeTruthy();
    expect(
      screen.getByText("Это приложение старее службы «Markiro Хост». Обновите приложение."),
    ).toBeTruthy();
  });

  it("retries a failed pairing", async () => {
    const device = fakeDevice(null);
    device.pairLocally.mockRejectedValueOnce(new DeviceError("pair_rejected", "no"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Не удалось подключиться к хосту")).toBeTruthy();
    expect(screen.getByText("Хост отказал в подключении этого устройства.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx`
Expected: FAIL — нет `src/app/shell.ts`, старый `App` не знает новых свойств.

- [ ] **Step 4: Реализовать**

`apps/standalone/src/app/shell.ts`:

```ts
import { HostError } from "../host/client.js";
import type { DeviceErrorCode } from "../host/device.js";
import type { HelloObservation, HostProbeErrorCode } from "../host/probe.js";
import type { DeviceStatus, OfficeSession } from "../host/protocol.js";

/** What the probe of the host on this computer found. */
export type LocalHostState =
  | { kind: "probing" }
  | { kind: "missing"; reason: HostProbeErrorCode }
  | { kind: "found"; observation: HelloObservation };

/** The pairing kept by the shell; `null` status means not paired. */
export type DeviceState =
  { kind: "loading" } | { kind: "unreadable" } | { kind: "ready"; status: DeviceStatus | null };

export type PairingState =
  { kind: "idle" } | { kind: "pairing" } | { kind: "failed"; code: DeviceErrorCode };

/** Why the host no longer accepts this device. */
export type RejectionReason = "key_rejected" | "host_changed";

export interface OfficeState {
  visible: boolean;
  /** Kept only in memory; the host ends it after 30 idle minutes. */
  session: OfficeSession | null;
  notice: "session_ended" | null;
}

export interface ShellState {
  device: DeviceState;
  localHost: LocalHostState;
  pairing: PairingState;
  rejection: RejectionReason | null;
  office: OfficeState;
}

export type ShellView =
  | { kind: "loading" }
  | { kind: "config_error" }
  | { kind: "host_missing"; reason: HostProbeErrorCode }
  | { kind: "bootstrap" }
  | { kind: "pairing" }
  | { kind: "pair_failed"; code: DeviceErrorCode }
  | { kind: "device_rejected"; reason: RejectionReason }
  | { kind: "floor" }
  | { kind: "office_login"; notice: "session_ended" | null }
  | { kind: "office"; session: OfficeSession };

export type ShellAction =
  | { type: "device_loaded"; status: DeviceStatus | null }
  | { type: "device_unreadable" }
  | { type: "host_probed"; localHost: LocalHostState }
  | { type: "pairing_started" }
  | { type: "paired"; status: DeviceStatus }
  | { type: "pairing_failed"; code: DeviceErrorCode }
  | { type: "pairing_retried" }
  | { type: "forgotten" }
  | { type: "host_initialized" }
  | { type: "office_requested" }
  | { type: "office_opened"; session: OfficeSession }
  | { type: "office_left" }
  | { type: "logged_out" }
  | { type: "session_ended" }
  | { type: "device_rejected"; reason: RejectionReason };

const CLOSED_OFFICE: OfficeState = { visible: false, session: null, notice: null };

export const initialShellState: ShellState = {
  device: { kind: "loading" },
  localHost: { kind: "probing" },
  pairing: { kind: "idle" },
  rejection: null,
  office: CLOSED_OFFICE,
};

/**
 * The screen for a snapshot (stage 1 spec §5.1), a pure function like the
 * station's `nextStationView`. Code pairing and line selection arrive in
 * plan 1c; until then an unpaired device can only pair with the host on
 * this computer.
 */
export function nextShellView(state: ShellState): ShellView {
  const { device, localHost } = state;
  if (device.kind === "loading") return { kind: "loading" };
  if (device.kind === "unreadable") return { kind: "config_error" };
  const status = device.status;
  if (status === null) {
    if (localHost.kind === "probing") return { kind: "loading" };
    if (localHost.kind === "missing") return { kind: "host_missing", reason: localHost.reason };
    if (!localHost.observation.hello.initialized) return { kind: "bootstrap" };
    if (state.pairing.kind === "failed") return { kind: "pair_failed", code: state.pairing.code };
    return { kind: "pairing" };
  }
  if (state.rejection) return { kind: "device_rejected", reason: state.rejection };
  if (
    localHost.kind === "found" &&
    localHost.observation.hello.hostId === status.hostId &&
    !localHost.observation.hello.initialized
  ) {
    return { kind: "bootstrap" };
  }
  if (!state.office.visible) return { kind: "floor" };
  if (state.office.session) return { kind: "office", session: state.office.session };
  return { kind: "office_login", notice: state.office.notice };
}

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "device_loaded":
      return { ...state, device: { kind: "ready", status: action.status } };
    case "device_unreadable":
      return { ...state, device: { kind: "unreadable" } };
    case "host_probed":
      return { ...state, localHost: action.localHost };
    case "pairing_started":
      return { ...state, pairing: { kind: "pairing" } };
    case "paired":
      return {
        ...state,
        device: { kind: "ready", status: action.status },
        pairing: { kind: "idle" },
        rejection: null,
      };
    case "pairing_failed":
      return { ...state, pairing: { kind: "failed", code: action.code } };
    case "pairing_retried":
      return { ...state, pairing: { kind: "idle" } };
    case "forgotten":
      return {
        ...state,
        device: { kind: "ready", status: null },
        pairing: { kind: "idle" },
        rejection: null,
        office: CLOSED_OFFICE,
      };
    case "host_initialized":
      if (state.localHost.kind !== "found") return state;
      return {
        ...state,
        localHost: {
          kind: "found",
          observation: {
            ...state.localHost.observation,
            hello: { ...state.localHost.observation.hello, initialized: true },
          },
        },
      };
    case "office_requested":
      return { ...state, office: { ...state.office, visible: true, notice: null } };
    case "office_opened":
      return { ...state, office: { visible: true, session: action.session, notice: null } };
    case "office_left":
      return { ...state, office: { ...state.office, visible: false, notice: null } };
    case "logged_out":
      return { ...state, office: CLOSED_OFFICE };
    case "session_ended":
      return { ...state, office: { visible: true, session: null, notice: "session_ended" } };
    case "device_rejected":
      return { ...state, rejection: action.reason, office: CLOSED_OFFICE };
  }
}

/**
 * The shell action a failed host call implies: an ended session asks for a
 * new sign-in, a rejected device key or a changed host certificate needs a
 * new pairing. Everything else is the screen's to explain.
 */
export function shellActionFor(error: unknown): ShellAction | null {
  if (!(error instanceof HostError)) return null;
  if (error.kind === "transport") {
    return error.code === "certificate_mismatch"
      ? { type: "device_rejected", reason: "host_changed" }
      : null;
  }
  if (error.credential === "device") return { type: "device_rejected", reason: "key_rejected" };
  if (error.credential === "session") return { type: "session_ended" };
  return null;
}
```

`apps/standalone/src/app/screens.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import type { DeviceErrorCode } from "../host/device.js";
import type { HostProbeErrorCode } from "../host/probe.js";
import type { RejectionReason } from "./shell.js";

const PROBE_REASON_KEY = {
  unreachable: "shell.hostMissing.unreachable",
  not_markiro_host: "shell.hostMissing.notHost",
  invalid_response: "shell.hostMissing.invalidResponse",
  host_too_old: "shell.version.hostTooOld",
  app_too_old: "shell.version.appTooOld",
} as const satisfies Record<HostProbeErrorCode, string>;

export function WaitScreen({
  messageKey,
}: {
  messageKey: "shell.loading" | "shell.pairing.title";
}) {
  const { t } = useTranslation();
  return (
    <div className="standalone-probing" role="status">
      <Spinner size={32} />
      <p>{t(messageKey)}</p>
    </div>
  );
}

export function HostMissingScreen({
  reason,
  address,
  onRetry,
}: {
  reason: HostProbeErrorCode;
  address: string;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const versionMismatch = reason === "host_too_old" || reason === "app_too_old";
  return (
    <Card
      className="standalone-card"
      title={t(versionMismatch ? "shell.version.title" : "shell.hostMissing.title")}
      titleAs="h2"
    >
      {!versionMismatch && <p>{t("shell.hostMissing.body", { address })}</p>}
      <Alert tone="warn">{t(PROBE_REASON_KEY[reason])}</Alert>
      <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
    </Card>
  );
}

export function ConfigErrorScreen({ onReset }: { onReset(): void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.configError.title")} titleAs="h2">
      <p>{t("shell.configError.body")}</p>
      <Button onClick={onReset}>{t("shell.configError.reset")}</Button>
    </Card>
  );
}

export function PairFailedScreen({ code, onRetry }: { code: DeviceErrorCode; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.pairFailed.title")} titleAs="h2">
      <Alert tone="error">{t(`errors.device.${code}`)}</Alert>
      <Button onClick={onRetry}>{t("shell.pairFailed.retry")}</Button>
    </Card>
  );
}

export function DeviceRejectedScreen({
  reason,
  onRepair,
}: {
  reason: RejectionReason;
  onRepair(): void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("shell.deviceRejected.title")} titleAs="h2">
      <Alert tone="warn">
        {t(
          reason === "key_rejected"
            ? "shell.deviceRejected.keyRejected"
            : "shell.deviceRejected.hostChanged",
        )}
      </Alert>
      <Button onClick={onRepair}>{t("shell.deviceRejected.repair")}</Button>
    </Card>
  );
}

/** The floor placeholder until plan 1f: the way into the office. */
export function FloorScreen({ onOffice }: { onOffice(): void }) {
  const { t } = useTranslation();
  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <p>{t("floor.body")}</p>
      <Button onClick={onOffice}>{t("floor.office")}</Button>
    </Card>
  );
}
```

`apps/standalone/src/app/App.tsx` заменить целиком:

```tsx
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";

import { createHostApi, type HostApi } from "../host/api.js";
import { createTauriHostClient, HostError } from "../host/client.js";
import { createTauriDeviceApi, DeviceError, type DeviceApi } from "../host/device.js";
import { createTauriHostProbe, HostProbeError, type HostProbe } from "../host/probe.js";
import {
  LOCAL_HOST_ADDRESS,
  type BootstrapRequest,
  type DeviceStatus,
  type OfficeLoginRequest,
} from "../host/protocol.js";
import { Office } from "../office/Office.js";
import { OfficeLogin } from "../office/OfficeLogin.js";
import type { OfficeSessionValue } from "../office/office-session.js";
import { BootstrapWizard } from "../wizard/BootstrapWizard.js";
import {
  ConfigErrorScreen,
  DeviceRejectedScreen,
  FloorScreen,
  HostMissingScreen,
  PairFailedScreen,
  WaitScreen,
} from "./screens.js";
import { initialShellState, nextShellView, shellActionFor, shellReducer } from "./shell.js";

export interface AppProps {
  probe?: HostProbe;
  device?: DeviceApi;
  host?: HostApi;
  address?: string;
}

export function App({ probe, device, host, address = LOCAL_HOST_ADDRESS }: AppProps) {
  const { t } = useTranslation();
  const hostProbe = useMemo(() => probe ?? createTauriHostProbe(), [probe]);
  const deviceApi = useMemo(() => device ?? createTauriDeviceApi(), [device]);
  const hostApi = useMemo(() => host ?? createHostApi(createTauriHostClient()), [host]);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const view = nextShellView(state);
  const localName = t("device.localName");

  useEffect(() => {
    let cancelled = false;
    deviceApi.status().then(
      (status) => {
        if (!cancelled) dispatch({ type: "device_loaded", status });
      },
      () => {
        if (!cancelled) dispatch({ type: "device_unreadable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceApi]);

  useEffect(() => {
    let cancelled = false;
    hostProbe.hello(address).then(
      (observation) => {
        if (!cancelled)
          dispatch({ type: "host_probed", localHost: { kind: "found", observation } });
      },
      (error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "host_probed",
            localHost: {
              kind: "missing",
              reason: error instanceof HostProbeError ? error.code : "unreachable",
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostProbe, address, probeAttempt]);

  /** Pair with the host on this computer; a pairing another call already made is adopted. */
  const pairLocally = useCallback(async (): Promise<DeviceStatus> => {
    try {
      return await deviceApi.pairLocally(localName);
    } catch (error) {
      if (error instanceof DeviceError && error.code === "already_paired") {
        const status = await deviceApi.status();
        if (status) return status;
      }
      throw error;
    }
  }, [deviceApi, localName]);

  const pairingDue = view.kind === "pairing" && state.pairing.kind === "idle";
  useEffect(() => {
    if (!pairingDue) return;
    dispatch({ type: "pairing_started" });
    pairLocally().then(
      (status) => dispatch({ type: "paired", status }),
      (error: unknown) =>
        dispatch({
          type: "pairing_failed",
          code: error instanceof DeviceError ? error.code : "unreachable",
        }),
    );
  }, [pairingDue, pairLocally]);

  const retryProbe = useCallback(() => {
    dispatch({ type: "host_probed", localHost: { kind: "probing" } });
    setProbeAttempt((attempt) => attempt + 1);
  }, []);

  const repair = useCallback(() => {
    deviceApi.forget().then(
      () => {
        dispatch({ type: "forgotten" });
        retryProbe();
      },
      () => {
        // The config could not be removed; this screen stays and offers the same action again.
      },
    );
  }, [deviceApi, retryProbe]);

  const unpaired = state.device.kind === "ready" && state.device.status === null;
  const bootstrap = useCallback(
    async (request: BootstrapRequest) => {
      if (unpaired) dispatch({ type: "paired", status: await pairLocally() });
      try {
        const response = await hostApi.bootstrap(request);
        dispatch({ type: "host_initialized" });
        dispatch({ type: "office_opened", session: response.session });
      } catch (error) {
        if (error instanceof HostError && error.code === "already_initialized") {
          dispatch({ type: "host_initialized" });
          dispatch({ type: "office_requested" });
          return;
        }
        throw error;
      }
    },
    [unpaired, pairLocally, hostApi],
  );

  const login = useCallback(
    async (request: OfficeLoginRequest) => {
      try {
        dispatch({ type: "office_opened", session: await hostApi.officeLogin(request) });
      } catch (error) {
        const action = shellActionFor(error);
        if (action?.type === "device_rejected") {
          dispatch(action);
          return;
        }
        throw error;
      }
    },
    [hostApi],
  );

  const session = view.kind === "office" ? view.session : null;
  const officeSession = useMemo<OfficeSessionValue | null>(() => {
    if (!session) return null;
    return {
      user: session.user,
      call: async <T,>(operation: (token: string) => Promise<T>): Promise<T> => {
        try {
          return await operation(session.token);
        } catch (error) {
          const action = shellActionFor(error);
          if (action) dispatch(action);
          throw error;
        }
      },
      leave: () => dispatch({ type: "office_left" }),
      logout: async () => {
        try {
          await hostApi.officeLogout(session.token);
        } catch {
          // The session ends on this device regardless; the host expires it on its own.
        }
        dispatch({ type: "logged_out" });
      },
    };
  }, [session, hostApi]);

  if (officeSession) return <Office session={officeSession} />;

  return (
    <main className="standalone-screen">
      {view.kind === "loading" && <WaitScreen messageKey="shell.loading" />}
      {view.kind === "config_error" && <ConfigErrorScreen onReset={repair} />}
      {view.kind === "host_missing" && (
        <HostMissingScreen reason={view.reason} address={address} onRetry={retryProbe} />
      )}
      {view.kind === "bootstrap" && <BootstrapWizard onSubmit={bootstrap} />}
      {view.kind === "pairing" && <WaitScreen messageKey="shell.pairing.title" />}
      {view.kind === "pair_failed" && (
        <PairFailedScreen code={view.code} onRetry={() => dispatch({ type: "pairing_retried" })} />
      )}
      {view.kind === "device_rejected" && (
        <DeviceRejectedScreen reason={view.reason} onRepair={repair} />
      )}
      {view.kind === "floor" && (
        <FloorScreen onOffice={() => dispatch({ type: "office_requested" })} />
      )}
      {view.kind === "office_login" && (
        <OfficeLogin
          notice={view.notice}
          onLogin={login}
          onBack={() => dispatch({ type: "office_left" })}
        />
      )}
    </main>
  );
}
```

Удалить `apps/standalone/src/app/use-local-host.ts` (его тип `LocalHostState` теперь в `shell.ts`, а опрос — в `App`).

- [ ] **Step 5: Проверки проходят**

Run:

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
```

Expected: всё зелёное; 13 тестов в `shell.test.ts`, 10 — в `app.test.tsx`; сборка `dist/` без ошибок.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/src/app apps/standalone/src/i18n/ru.json apps/standalone/test/shell.test.ts apps/standalone/test/app.test.tsx
git rm apps/standalone/src/app/use-local-host.ts
git commit -m "feat(standalone): оболочка приложения — мастер, подключение, цех и офис" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Документация

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `apps/standalone/README.md`

- [ ] **Step 1: `AGENTS.md`**

В `apps/standalone/AGENTS.md` раздел «Network and TLS» заменить целиком:

```markdown
## Network and TLS

The webview never performs HTTP. Rust calls the host with the aws-lc-rs
provider selected explicitly (`src-tauri/src/tls.rs`). `host_client` trusts
only the certificate whose SHA-256 was saved at pairing
(`FingerprintPolicy::Pin`); `host_probe` observes a fingerprint without
trusting it (`FingerprintPolicy::Observe`) and exists only to discover a host
before loopback, a person or a pairing code confirms it. `host_request`
accepts only `GET`, `POST`, `PUT`, `DELETE` and `/v1/…` paths.
```

и после него добавить раздел:

```markdown
## Device key and office session

- The device key lives only in `device.json` in the app config directory:
  DPAPI-protected for the Windows user on Windows, plain in an owner-only
  (0600) file elsewhere. It never crosses IPC: the webview gets
  `DeviceStatus`, and `host_request` attaches the key in Rust. A file written
  on another system or for another Windows user is `config_unreadable`; the
  app offers to reset and pair again.
- The office session token lives only in webview memory. «В цех» hides the
  office and keeps the session until the host expires it; «Выйти» ends it on
  the host.
- Screens pick text by error code (`src/host/errors.ts`). An `unauthorized`
  answer names its `details.credential`: `device` (and a
  `certificate_mismatch`) sends the app to re-pairing, `session` to the office
  sign-in, `password` stays a form error.
- UI text goes through `src/i18n/ru.json`; controls come from `@markiro/ui`
  (ESLint bans native form elements in `src/`); forms check the host's and
  `@markiro/domain` rules before sending.
```

- [ ] **Step 2: `README.md`**

В `apps/standalone/README.md` пункт 2 раздела «Development» заменить на:

```markdown
2. Start the app: `pnpm --filter @markiro/standalone tauri dev`. It looks for
   the host at `https://127.0.0.1:45710`. On a fresh host it opens the
   first-run wizard (administrator, organization, SSCC starts, lines); on an
   initialized host it pairs this computer by itself and shows the floor,
   where «Офис» leads to the office sign-in. The pairing is kept in
   `device.json` in the app config directory; delete it to pair again.
```

- [ ] **Step 3: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/README.md` и `git diff --check`.

```bash
git add apps/standalone/AGENTS.md apps/standalone/README.md
git commit -m "docs(standalone): ключ устройства, сессия офиса и первый запуск приложения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (вне песочницы) — все тесты PASS.
- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и `git diff --check` — чисто.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — зелёные.
- [ ] `node --test tools/ci/test/affected.test.mjs` — зелёный; `node_modules/.bin/prettier --check` по изменённым файлам — чисто.
- [ ] В отчёте отдельно: окно `tauri dev` вручную не открывалось (нет графической сессии), DPAPI и Windows-задание CI не запускались — код DPAPI только проверен `cargo check` под `x86_64-pc-windows-msvc`.
