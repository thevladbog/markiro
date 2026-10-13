# План ЛЦ-2: хост — лицензия, рабочие места, ИНН (миграция хоста `0030`, состояния и пробный период, маршруты лицензии с предпросмотром, места и возможности в точках сопряжения и создания, сверка ИНН, перенос при восстановлении) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автонома знает лицензию площадки: принимает подписанный файл `.mklic` (проверка по разделу 4.3 спецификации, предпросмотр «было → станет», апгрейд по `sequence`), хранит файлы и «отметку времени», считает состояние (`trial` 14 дней с отметкой в реестре Windows, `active`, `expiring`, `grace`, `restricted`, `wrong_host`, `inn_mismatch`, `trial_expired`) и закрывает ровно открытие новых смен; применяет квоты и возможности файла к новым устройствам, пользователям офиса, линиям, сменам с паллетами и правке шаблонов, никогда не отключая работающее; сверяет ИНН организации с подписанным ИНН при загрузке, при старте, после правки профиля, импорта и восстановления; мастер требует ИНН с верной контрольной суммой; переходы, загрузки и аварийное продление пишутся в журнал аудита; `markiro-host restore` переносит лицензии, загруженные после копии.

**Architecture:**

- Задача 1 — провод: модуль `markiro_proto::license` (`OfficeLicense`, `LicensePreview`, `LicenseTerms`, `DeviceLicense`, `LicenseLoadRequest`, коды отказов, предупреждений и ограничений), необязательное `DeviceInfo.license`, фикстуры, Zod в `src/host/protocol.ts`, построитель `licenseLoad`, пять методов `HostApi`.
- Задача 2 — миграция хоста `0030_license.sql` (`licenses`, `license_clock`), имена `audit::actions` и `audit::reasons`.
- Задача 3 — мастер требует ИНН с контрольной суммой (хост и вебвью), тестовый ИНН хоста и фикстур меняется на `7707083893`, мастер записывает начало пробного периода и его ИНН.
- Задача 4 — `license/state.rs`: чистая функция «файлы + пробный период + время + ИНН → состояние» с модульными тестами каждого перехода.
- Задача 5 — время: `Clock::monotonic`, `ManualClock::move_wall`, `license/clock.rs` (отметка, монотонный предел, 400 дней при запуске, `issuedAt − 1 день`).
- Задача 6 — служба лицензии: `license/mod.rs` (`LicenseService`, `Snapshot`), `store.rs`, `seats.rs` (использование), `trial_mark.rs` (трейт и пустая отметка), `AppState.license`; маршруты `GET /v1/office/license` и `GET /v1/office/license/activation-request`; тестовая подпись файлов.
- Задача 7 — `license/verify.rs` и маршруты `POST /v1/office/license/preview`, `PUT /v1/office/license`: порядок проверки 4.3, `license.load` (`ok` и `denied`), ограничитель, апгрейд, предупреждения, паритет с фикстурами ЛЦ-1.
- Задача 8 — переходы: `refresh` (строка `license.state` и ревизия на смену состояния, отметка раз в час), фоновая задача раз в минуту, проверка при старте (начало пробного периода площадок до лицензии), `GET /v1/device` с `license`, пересчёт после мастера, загрузки, правки профиля и импорта.
- Задача 9 — закрытие открытия: `license/gate.rs::require_new_shifts` в первом входе в смену и в создании смены станцией; аварийное продление `POST /v1/office/license/emergency`.
- Задача 10 — рабочие места: `require_seat` в `local_pair`, `claim`, создании и включении пользователя, создании и снятии с архива линии; `overLimit` ничего не отключает.
- Задача 11 — возможности: `require_feature` для `handheld` (сопряжение ТСД), `pallets` (планирование и создание смены с паллетами, включение паллет), `labelEditor` (создание и правка шаблона).
- Задача 12 — отметка пробного периода в реестре: `RegistryMark` через `install::Commands` и `%SystemRoot%\System32\reg.exe`, ключ и право записи в `markiro-host install`, самое раннее начало из базы и реестра.
- Задача 13 — `markiro-host restore` переносит строки `licenses` с большим `sequence` и `license_clock`; сводка и аудит говорят об этом.
- Задача 14 — таблицы маршрутов «закрываемые» / «никогда» и тест классификации, `no_secrets_in_logs.rs`, документы (`AGENTS.md`, памятка, раздел 19 спецификации).

**Tech Stack:** Rust (axum 0.8.9, sqlx 0.8.6 SQLite, aws-lc-rs 1.18.1, time 0.3.55), `markiro_proto::trust` плана ЛЦ-1; TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, Vitest 4.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (редакция 3, принята владельцем) — §3 целиком, §4.3–§4.9 (сторона хоста), §6.3, §7, §8, §12.1 (части хоста), §13 строка 2, §14 и §14.1 (ЛО22–ЛО27 по рекомендации); этот план дописывает §19.
- Бриф `/tmp/claude/fb/license-plans-brief.md` — контракт имён ЛЦ-1 и ЛЦ-2 (BINDING).
- Код ветки `claude/fb-license` (`f38f4a3e9`, основа `claude/integration` `a4eef5cd6`): `apps/standalone/host/src/{server.rs,auth.rs,audit.rs,error.rs,clock.rs,db.rs,install.rs,restore.rs,validate.rs,lib.rs,routes/*}`, `host/tests/support/app.rs`, `proto/src/lib.rs`, `src/host/{protocol.ts,requests.ts,api.ts}`.
- `apps/standalone/AGENTS.md` — «Audit», «Protocol», «Network and TLS», «Installer and service», «Backups and restore», «Logs», «Verification».

## Допущения

Решения, которые план принимает по коду и рекомендации спецификации (вопросы ЛО22–ЛО27 — как рекомендовано):

- **Д1 — хост читает нагрузку ЛЦ-1 по именам провода.** Контракт ЛЦ-1 даёт `markiro_proto::trust::{verify_license, license_keyset, Keyset, TrustError, LicensePayloadV1}`, но не типы полей Rust (`u64` или `i64` у `sequence`, перечисление или строка у `plan`). Хост переводит проверенную нагрузку в `serde_json::Value` и читает поля по именам §4.2 (`verify::from_payload`) — единственное место, зависящее от формы нагрузки. Нужно только `LicensePayloadV1: Serialize` (контракт говорит «serde»). Хост сам ещё раз проверяет предел 16 КиБ, `issuer` против `Keyset::origin`, `version == 1`, `graceDays` 0–60 и `validUntil > validFrom`: дёшево и не зависит от того, проверяет ли это ЛЦ-1.
- **Д2 — тесты хоста подписывают свои файлы тестовым ключом.** `host/tests/support/license.rs` берёт закрытый JWK `kid = "test-lic-1"` из `packages/domain/fixtures/standalone-license/test-private-keys.json` (ищет объект с этим `kid` на любой глубине — форма файла в контракте не закреплена) и подписывает любую нагрузку через `aws_lc_rs::signature::EcdsaKeyPair::from_private_key_and_public_key` (`ECDSA_P256_SHA256_FIXED_SIGNING`, 64 байта). Так тест выбирает свои сроки, `hostId`, ИНН и квоты относительно `START` ручных часов. Паритет с фикстурами ЛЦ-1 (`license-*.jws`) — отдельный тест задачи 7 на хосте с `hostId` фикстур.
- **Д3 — столбцы сверх списка брифа (добавление, не переименование).** `licenses` получает `host_id` (без него `wrong_host` пришлось бы разбирать из JWS при каждом чтении) и `plan_version_id` (поле `license.planVersionId` ответа §8.2); `license_clock` — `wrong_host_since` (окно 30 дней от обнаружения переживает перезапуск), `last_state` и `last_state_at` (с чем сравнивать для строки `license.state` и с какого момента `inn_mismatch`). Времена в обеих таблицах — целые миллисекунды UTC, как в файле; на проводе — RFC 3339 хоста (`clock::format_timestamp`, секунды). `loaded_by` — без внешнего ключа: `restore` переносит строку в копию, где такого пользователя может не быть.
- **Д4 — форма ответов шире §8.2 (добавочные поля).** `OfficeLicense` получает `since` (начало состояния), `opensNewShifts` (с учётом аварийного продления) и `license.kid` (блок поддержки §9.4); `DeviceLicense` — `emergencyUntil` (иначе станция при `restricted` с действующим продлением показала бы отказ до запроса); предпросмотр отдаёт `before` всегда (у пробного периода — `plan: "trial"`, без квот, все возможности), `changes` — имена полей в порядке `plan`, `validFrom`, `validUntil`, `graceDays`, `quotas.<ключ>`, `features.<ключ>`. Состояние на проводе — слово (`String`), не перечисление: `DeviceInfo` читает и оболочка, и неизвестное новое слово не должно ломать `device_refresh`. Новое ограничение `emergency_not_needed` — продление при открывающихся сменах.
- **Д5 — ограничитель загрузки — на адрес, как у входа.** §8.3: «как у входа (10 попыток в минуту на сессию)»; ограничитель входа хоста считает адреса (`rate_limit.rs`), и `RateLimiter` знает только `IpAddr`. Новый `AppState::license_limiter` — 10 в минуту на адрес, общий для предпросмотра и загрузки; отказ ограничителя строк не пишет.
- **Д6 — старшинство состояний:** `wrong_host` → `inn_mismatch` → сроки (`active`/`expiring`/`grace`/`restricted`); без действующего файла — `trial`/`trial_expired`. Аварийное продление доступно, только когда новые смены не открываются, один раз на ключ (`licenseId` или `"trial"`); повтор — `emergency_used` (проверяется первым), ненужное — `emergency_not_needed`.
- **Д7 — первая оценка ставит точку отсчёта молча.** `refresh` при пустом `last_state` записывает состояние без строки аудита и без ревизии (это не переход); дальше каждая смена — одна строка `license.state` от хоста и одна ревизия. `refresh` зовут: старт службы, задача раз в минуту, после мастера, загрузки файла, правки профиля организации и импорта из облака.
- **Д8 — что закрывают возможности (ЛО23).** `labelEditor` — создание шаблона (импорт и копия в редакторе — тот же `POST`) и правка, меняющая имя или макет; включение, выключение, категории и удаление не закрываются. `pallets` — план и создание смены с паллетами и включение паллет в плане; открытие запланированной смены с паллетами и правка прочих полей такой смены не закрываются. `handheld` — сопряжение ТСД кодом (`local-pair` ТСД и так отвергает). `chzIntegration`, `inventory`, `commerceMl`, `publicApi` только показываются.
- **Д9 — место проверяется до траты кода сопряжения.** В `claim` квота и `handheld` проверяются после проверки кода и до `UPDATE pairing_codes SET used_at`: отказанное устройство сохраняет код до его срока, строки аудита нет.
- **Д10 — ИНН мастера (ЛО24, ЛО27).** Хост требует в мастере ИНН, который проходит `crate::inn::normalize` (ЛЦ-1), поле `org.inn`; «Профиль организации» сохраняет прежнее правило 10/12 цифр. Тестовый ИНН `7701234567` контрольную сумму не проходит (вес 10: сумма 176, `176 % 11 % 10 = 0 ≠ 7`), поэтому `bootstrap_body()`, тесты хоста, ожидающие ИНН мастера, и фикстуры `bootstrap-request*.json` переходят на `7707083893` (сумма 267, `267 % 11 = 3` — последняя цифра). Вебвью-мастер проверяет то же через `isValidInn` из `@markiro/domain` (ЛЦ-1), чтобы человек видел ошибку поля, а не отказ хоста.
- **Д11 — отметка в реестре.** Ключ `HKLM\SOFTWARE\Markiro\Standalone\Trial` создаёт `markiro-host install` скриптом PowerShell (с правами администратора, лучшее усилие: отказ пишется в журнал и установку не останавливает) и даёт `*S-1-5-19` права `ReadKey, SetValue` только на этот ключ; значения `StartedAt` (RFC 3339 UTC), `HostId`, `Inn` пишет и читает служба через `reg.exe` (`install::Commands`, абсолютный путь `system_program`). Служба читает реестр один раз при старте, пишет при мастере и при старте, только если значения ещё нет. Действующее начало — самое раннее из базы и реестра. На других ОС — `NoMark`.
- **Д12 — перенос при восстановлении — как отзывы.** Только когда текущая база — история копии (`history_known`): строки `licenses` с `sequence` больше наибольшего в копии и `license_clock` (более поздняя отметка, более раннее начало пробного периода с его ИНН, более позднее аварийное продление). Сводка и аудит `host.restore` получают `licensesCarried`.
- **Д13 — импорт из облака ИНН не пишет.** `routes/cloud_import.rs` требует пустую площадку и совпадение GLN и обновляет в `org_profile` только шаблоны по умолчанию; «сверка после импорта» (§4.9) — вызов `refresh` для единообразия, тест подтверждает, что состояние не меняется.
- **Д14 — запрос активации строит хост как JSON** (`json!`), тест разбирает ответ типом ЛЦ-1 `markiro_proto::trust::ActivationRequest` и сверяет набор ключей с фикстурой `packages/domain/fixtures/standalone-license/activation-request.json`; вебвью читает его схемой `standaloneActivationRequestSchema` из `@markiro/domain` (имя типа — `StandaloneActivationRequest`, предположение; иное — записать в «Отклонения»).
- **Д15 — `TestApp::with_host_id` и `admin_on`** добавляются в `support/app.rs` для паритета с фикстурами ЛЦ-1, выданными на `hostId` `3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f`.
- **Д16 — фоновая задача раз в минуту** сама не тестируется (её тело — `refresh`, у которого свои тесты); её старт и остановка проходят в `no_secrets_in_logs.rs` настоящим `start`.

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` (ЛЦ-2), `0031_device_versions.sql` (ОБН-1); `0032`–`0033` — резерв. Открытые ветки берут `0017`–`0018` (fb-codesearch, fb-people, fb-templates, fb-mode) — их не трогать.
- Оболочка (`src-tauri/migrations`) — в этом направлении новых миграций нет (`0030`–`0031` зарезервированы и не используются).
- Облако (`packages/db/migrations`, ЛЦ-0): следующий свободный номер Drizzle на момент исполнения.
- Разделы спецификации «Уточнения плана …»: §18 ЛЦ-1, **§19 ЛЦ-2**, §20 ОБН-1, §21 ЛЦ-3, §22 ОБН-2, §23 ОБН-3, §24 ЛЦ-0.
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (ЛЦ-3 ∥ ОБН-2) → ОБН-3.

**Контракт ЛЦ-2 (бриф, BINDING; отклонения — в Д3, Д4):** миграция `0030_license.sql` (`licenses`, `license_clock`); модуль `apps/standalone/host/src/license/` (`state.rs`, `clock.rs`, `trial_mark.rs`, `seats.rs`, `routes.rs`; плюс `store.rs`, `verify.rs`, `gate.rs`, `mod.rs`); `AppState.license`; `markiro_proto::license::{OfficeLicense, LicensePreview, DeviceLicense, LicenseLoadRequest}`; фикстуры `office-license.json`, `office-license-preview.json`, `device-license.json`, `license-load-request.json`; Zod `officeLicenseSchema`, `licensePreviewSchema`, `deviceLicenseSchema`; построитель `licenseLoad(file)`; `HostApi.getLicense`, `previewLicense`, `loadLicense`, `getActivationRequest`, `enableLicenseEmergency`; маршруты `GET /v1/office/license`, `POST /v1/office/license/preview`, `PUT /v1/office/license`, `GET /v1/office/license/activation-request`, `POST /v1/office/license/emergency`; `GET /v1/device` с необязательным `license`; ограничения `license_restricted`, `seat_limit` (`quota`, `used`, `limit`), `feature_disabled` (`feature`); причины на `file`: `license_malformed`, `license_unknown_key`, `license_signature`, `license_wrong_host`, `license_inn_mismatch`, `license_inn_missing`, `license_older`; аудит `LICENSE_LOAD = "license.load"`, `LICENSE_STATE = "license.state"`, `LICENSE_EMERGENCY = "license.emergency"`; пробный период 14 дней без льготы, предупреждение `min(30, ⌊срок/3⌋)` дней.

**Правила (повторяются в каждой задаче):**

- Без `git stash`; команды из корня репозитория, пути абсолютные или от корня, без `cd`; pnpm — `pnpm --config.verifyDepsBeforeRun=false …`, без `pnpm install`/`add` (новая JS-зависимость — шаг владельца); cargo — `--offline --locked`; тесты хоста, открывающие сокет на loopback (`no_secrets_in_logs`, `hello`), — вне песочницы.
- TDD: сначала падающий тест, потом код. Существующие утверждения не ослабляются (точные значения, изменившиеся по этому плану, — обновляются: ИНН мастера, сводка и аудит восстановления, индексы команд установки). Аудит проверяется точно: субъект, действие, цель, итог, разобранные `details`. В журнал службы — только `licenseId`, состояние и код отказа: ни текста файла, ни подписи, ни ИНН, ни названия клиента, ни запроса активации.
- Провод: `proto` + Zod + фикстуры вместе; типы ответов терпимы, типы запросов — `deny_unknown_fields` / `.strict()`.
- i18n — только `apps/standalone/src/i18n/ru.json`; `@markiro/ui` и доступность — в ЛЦ-3 (этот план вебвью трогает лишь мастер).
- Применённые миграции хоста `0001`–`0016` не меняются. `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются.
- Коммиты — явные пути, сообщение, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR и выпуск — не задачи плана.

## Заметки для исполнения

**Предусловие (ЛЦ-1 смержен).** До задачи 1 проверить и, если чего-то нет, остановиться и назвать это в отчёте:

```bash
test -f apps/standalone/host/src/inn.rs && grep -n "pub fn normalize\|pub fn is_valid" apps/standalone/host/src/inn.rs
grep -n "pub mod inn" apps/standalone/host/src/lib.rs
grep -rn "pub fn verify_license\|pub fn license_keyset\|pub struct Keyset\|pub enum TrustError\|pub struct LicensePayloadV1\|pub struct ActivationRequest" apps/standalone/proto/src
grep -n "test-keys" apps/standalone/proto/Cargo.toml apps/standalone/host/Cargo.toml
ls packages/domain/fixtures/standalone-license/
grep -rn "isValidInn\|STANDALONE_QUOTA_KEYS\|STANDALONE_FEATURE_KEYS\|standaloneActivationRequestSchema\|StandaloneActivationRequest" packages/domain/src | head
```

Ожидается: `inn::normalize`/`is_valid`; `trust::verify_license(compact, &Keyset) -> Result<(LicensePayloadV1, String), TrustError>`, `license_keyset() -> Keyset` (с `origin: Option<String>`), `TrustError::{Malformed, UnknownKey, BadSignature}`, `LicensePayloadV1: Serialize + Deserialize`; dev-зависимость хоста на `markiro-proto` с фичей `test-keys` (тесты хоста видят `kid = "test-lic-1"` в `license_keyset()`); в фикстурах домена `test-keyset.json`, `test-private-keys.json`, `license-*.jws`, `activation-request.json`. Проверить в коде хоста одной строкой теста задачи 6 (`license_keyset().keys` содержит `test-lic-1`, `origin == Some("https://license.test.invalid")`). Расхождение имени — правка в одном месте (`verify.rs`, `support/license.rs`) и запись в «Отклонения».

Распаковать нагрузку фикстуры подписки и записать её `hostId`, `customer.inn`, `sequence` (для паритета задачи 7):

```bash
cut -d. -f2 packages/domain/fixtures/standalone-license/license-subscription.jws | tr '_-' '/+' | base64 -d 2>/dev/null; echo
```

Ожидается `hostId` `3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f` и ИНН `7707083893`; иначе тест паритета берёт значения из нагрузки (как предусмотрено) — записать.

**Основа.** Ветка от `claude/integration` с ЛЦ-1 (или новее). Маршруты маршрутизатора на момент исполнения могли прибавиться (ветки `fb-*`): тест классификации задачи 14 перечислит их — новые маршруты, не названные в задачах 9–11, идут в «никогда»; записать.

**Фрагменты.** Взяты из `/tmp/claude/wt/fb-license` (`f38f4a3e9`). «Фрагмент … заменить на …» дан так, как стоит в файле; не находится — применить по смыслу и записать в «Отклонения при исполнении». Код плана при написании не компилировался и не запускался.

**Сборка в свежем worktree.** `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'` (домен ЛЦ-1 собран в `dist`).

**Перед каждым коммитом.** `node_modules/.bin/prettier --ignore-path .prettierignore --check <изменённые TS, TSX, JSON, MD>` (при отказе — `--write`, затем `--check`); при правке вебвью — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`, сборка без предупреждений (`cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests`); `git diff --check`. Вывод тестов не резать через `tail`/`grep`, когда нужен код возврата; урезанный `rtk` вывод — `rtk proxy <команда>`.

**Тесты хоста.** Все новые `host/tests/license_*.rs` идут через `TestApp` (сокета нет) — в песочнице. `no_secrets_in_logs` и полный `cargo test --workspace` — вне песочницы.

## Файлы

- Create (провод): `apps/standalone/proto/src/license.rs`, `apps/standalone/proto/tests/license.rs`, `apps/standalone/proto/fixtures/{office-license.json,office-license-preview.json,device-license.json,license-load-request.json,error-license-restricted.json,error-seat-limit.json,error-feature-disabled.json,error-license-refused.json}`, `apps/standalone/test/license-protocol.test.ts`
- Create (хост): `apps/standalone/host/migrations/0030_license.sql`, `apps/standalone/host/src/license/{mod.rs,state.rs,clock.rs,store.rs,verify.rs,seats.rs,gate.rs,trial_mark.rs,routes.rs}`, `apps/standalone/host/tests/support/license.rs`, `apps/standalone/host/tests/{license_schema.rs,license_office.rs,license_load.rs,license_state.rs,license_gate.rs,license_seats.rs,license_features.rs,license_trial.rs,license_routes.rs}`
- Modify (провод и вебвью): `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/{bootstrap-request.json,bootstrap-request-templates.json}`, `apps/standalone/src/host/{protocol.ts,requests.ts,api.ts}`, `apps/standalone/src/wizard/{wizard-form.ts,BootstrapWizard.tsx}`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/{api.test.ts,wizard-form.test.ts}`, `apps/standalone/test/support/{office.tsx,wizard.ts}`
- Modify (хост): `apps/standalone/host/src/{lib.rs,server.rs,clock.rs,audit.rs,install.rs,restore.rs}`, `apps/standalone/host/src/routes/{bootstrap.rs,devices.rs,device_shifts.rs,office_shifts.rs,office_users.rs,lines.rs,org.rs,pairing.rs,templates.rs,cloud_import.rs}`
- Modify (тесты хоста): `apps/standalone/host/tests/support/{app.rs,mod.rs}`, `apps/standalone/host/tests/{bootstrap.rs,device_shifts.rs,office_exports.rs,changes.rs,template_defaults.rs,office_reports.rs,no_secrets_in_logs.rs,install.rs,restore.rs}`
- Modify (документы): `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (§19)

---

### Task 1: Провод лицензии — `markiro_proto::license`, `DeviceInfo.license`, фикстуры, Zod, `licenseLoad`, методы `HostApi`

**Files:**

- Create: `apps/standalone/proto/src/license.rs`, `apps/standalone/proto/fixtures/office-license.json`, `apps/standalone/proto/fixtures/office-license-preview.json`, `apps/standalone/proto/fixtures/device-license.json`, `apps/standalone/proto/fixtures/license-load-request.json`, `apps/standalone/proto/fixtures/error-license-restricted.json`, `apps/standalone/proto/fixtures/error-seat-limit.json`, `apps/standalone/proto/fixtures/error-feature-disabled.json`, `apps/standalone/proto/fixtures/error-license-refused.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/routes/devices.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`
- Test: `apps/standalone/proto/tests/license.rs`, `apps/standalone/test/license-protocol.test.ts`, `apps/standalone/test/api.test.ts`

**Interfaces:**

- Consumes: `markiro_proto::{DeviceInfo, ErrorBody, codes}`; `@markiro/domain` (ЛЦ-1): `STANDALONE_QUOTA_KEYS`, `STANDALONE_FEATURE_KEYS`, `standaloneActivationRequestSchema`, тип `StandaloneActivationRequest`; `createHostApi`, `HostClient`.
- Produces: `markiro_proto::license::{constraints, refusals, warnings, states, plans, QUOTA_KEYS, FEATURE_KEYS, QuotaUse, LicenseQuotas, LicenseFeatures, LicenseCustomer, LicenseSummary, TrialInfo, LicenseBinding, LicenseFlags, LicenseEmergency, OfficeLicense, LicenseTerms, LicensePreview, DeviceLicense, LicenseLoadRequest}`; `DeviceInfo.license: Option<DeviceLicense>`; Zod `officeLicenseSchema`, `licensePreviewSchema`, `licenseTermsSchema`, `deviceLicenseSchema`, `licenseLoadRequestSchema`, константы `LICENSE_*`; `licenseLoad(file)`; `HostApi.getLicense`, `previewLicense`, `loadLicense`, `getActivationRequest`, `enableLicenseEmergency`.

- [ ] **Step 1: Фикстуры и падающие тесты**

Создать `apps/standalone/proto/fixtures/office-license.json`:

```json
{
  "state": "active",
  "since": "2026-10-20T09:00:00Z",
  "flags": { "clockBehindDays": null, "clockAhead": false },
  "effectiveAt": "2026-11-02T08:30:00Z",
  "phaseEndsAt": "2027-09-20T09:00:00Z",
  "daysLeft": 353,
  "warnDays": 30,
  "opensNewShifts": true,
  "license": {
    "licenseId": "6d1f0a52-3c4b-4e8f-9a1d-2b3c4d5e6f70",
    "sequence": 3,
    "kid": "markiro-lic-2026-1",
    "customer": { "name": "ООО «Атолл»", "inn": "7707083893" },
    "plan": "subscription",
    "planVersionId": "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
    "issuedAt": "2026-10-20T08:55:00Z",
    "validFrom": "2026-10-20T09:00:00Z",
    "validUntil": "2027-10-20T09:00:00Z",
    "graceDays": 14
  },
  "trial": {
    "startedAt": "2026-10-06T07:00:00Z",
    "endsAt": "2026-10-20T07:00:00Z",
    "inn": "7707083893"
  },
  "binding": {
    "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    "fingerprint": "abababababababababababababababababababababababababababababababab",
    "orgInn": "7707083893",
    "innMatches": true
  },
  "quotas": {
    "lines": { "limit": 2, "used": 1, "over": false },
    "stations": { "limit": 3, "used": 4, "over": true },
    "kiosks": { "limit": null, "used": 0, "over": false },
    "cabinetUsers": { "limit": null, "used": 2, "over": false }
  },
  "features": {
    "labelEditor": true,
    "publicApi": false,
    "pallets": true,
    "chzIntegration": true,
    "inventory": false,
    "commerceMl": false,
    "handheld": true
  },
  "emergency": { "available": false, "until": null }
}
```

Создать `apps/standalone/proto/fixtures/office-license-preview.json`:

```json
{
  "before": {
    "licenseId": null,
    "sequence": null,
    "plan": "trial",
    "validFrom": "2026-10-06T07:00:00Z",
    "validUntil": "2026-10-20T07:00:00Z",
    "graceDays": 0,
    "quotas": {
      "lines": { "limit": null, "used": 2, "over": false },
      "stations": { "limit": null, "used": 4, "over": false },
      "kiosks": { "limit": null, "used": 0, "over": false },
      "cabinetUsers": { "limit": null, "used": 2, "over": false }
    },
    "features": {
      "labelEditor": true,
      "publicApi": true,
      "pallets": true,
      "chzIntegration": true,
      "inventory": true,
      "commerceMl": true,
      "handheld": true
    }
  },
  "after": {
    "licenseId": "6d1f0a52-3c4b-4e8f-9a1d-2b3c4d5e6f70",
    "sequence": 1,
    "plan": "subscription",
    "validFrom": "2026-10-20T09:00:00Z",
    "validUntil": "2027-10-20T09:00:00Z",
    "graceDays": 14,
    "quotas": {
      "lines": { "limit": 2, "used": 2, "over": false },
      "stations": { "limit": 3, "used": 4, "over": true },
      "kiosks": { "limit": null, "used": 0, "over": false },
      "cabinetUsers": { "limit": null, "used": 2, "over": false }
    },
    "features": {
      "labelEditor": true,
      "publicApi": false,
      "pallets": true,
      "chzIntegration": true,
      "inventory": false,
      "commerceMl": false,
      "handheld": true
    }
  },
  "changes": [
    "plan",
    "validFrom",
    "validUntil",
    "graceDays",
    "quotas.lines",
    "quotas.stations",
    "features.publicApi",
    "features.inventory",
    "features.commerceMl"
  ],
  "warnings": ["over_limit"]
}
```

Создать `apps/standalone/proto/fixtures/device-license.json` (ответ `GET /v1/device` хоста ЛЦ-2):

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "kind": "station",
  "name": "Станция линии 1",
  "lineId": null,
  "pairedAt": "2026-09-26T09:15:00Z",
  "license": {
    "state": "grace",
    "since": "2027-10-20T09:00:00Z",
    "phaseEndsAt": "2027-11-03T09:00:00Z",
    "emergencyUntil": null
  }
}
```

Создать `apps/standalone/proto/fixtures/license-load-request.json` (текст файла непрозрачен для формы: подпись проверяет хост):

```json
{
  "file": "eyJ0eXAiOiJtYXJraXJvLXN0YW5kYWxvbmUtbGljZW5zZStqd3MiLCJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QtbGljLTEifQ.eyJ2ZXJzaW9uIjoxfQ.c2lnbmF0dXJl"
}
```

Создать `apps/standalone/proto/fixtures/error-license-restricted.json`:

```json
{
  "error": {
    "code": "conflict",
    "message": "new shifts do not open under the site's license",
    "details": {
      "constraint": "license_restricted",
      "state": "restricted",
      "since": "2027-11-03T09:00:00Z"
    }
  }
}
```

Создать `apps/standalone/proto/fixtures/error-seat-limit.json`:

```json
{
  "error": {
    "code": "conflict",
    "message": "every seat of the license is taken",
    "details": { "constraint": "seat_limit", "quota": "stations", "used": 3, "limit": 3 }
  }
}
```

Создать `apps/standalone/proto/fixtures/error-feature-disabled.json`:

```json
{
  "error": {
    "code": "conflict",
    "message": "the site's license does not include this feature",
    "details": { "constraint": "feature_disabled", "feature": "handheld" }
  }
}
```

Создать `apps/standalone/proto/fixtures/error-license-refused.json`:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "the license file was refused",
    "details": {
      "field": "file",
      "reason": "license_wrong_host",
      "fileHostId": "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f"
    }
  }
}
```

Создать `apps/standalone/proto/tests/license.rs`:

```rust
//! The license shapes (plan ЛЦ-2) against their fixtures, which
//! `test/license-protocol.test.ts` parses with the Zod schemas too.

use markiro_proto::license::{
    constraints, plans, refusals, states, warnings, DeviceLicense, LicenseLoadRequest,
    LicensePreview, OfficeLicense, FEATURE_KEYS, QUOTA_KEYS,
};
use markiro_proto::{codes, DeviceInfo, ErrorBody};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// Deserialize into `T` and serialize back: the JSON must survive unchanged.
fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        serde_json::to_value(&typed).unwrap(),
        original,
        "{name} changed on round trip"
    );
    typed
}

fn keys(value: &Value) -> Vec<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn the_office_reads_the_license_with_its_seats_features_and_binding() {
    let license: OfficeLicense = round_trip("office-license.json");
    assert_eq!(license.state, states::ACTIVE);
    assert!(license.opens_new_shifts);
    assert!(license.warnings.is_empty());
    let summary = license.license.expect("the fixture has a file");
    assert_eq!((summary.sequence, summary.plan.as_str()), (3, plans::SUBSCRIPTION));
    assert_eq!(license.quotas.stations.limit, Some(3));
    assert!(license.quotas.stations.over);
    assert_eq!(license.quotas.kiosks.limit, None);
    assert!(!license.features.public_api && license.features.handheld);
    assert_eq!(license.binding.inn_matches, Some(true));
    // The wire names of the quotas and features are the cloud's (plan ЛЦ-1).
    let value = fixture("office-license.json");
    let mut quota_keys = keys(&value["quotas"]);
    let mut feature_keys = keys(&value["features"]);
    let mut expected_quotas: Vec<String> = QUOTA_KEYS.iter().map(|key| key.to_string()).collect();
    let mut expected_features: Vec<String> =
        FEATURE_KEYS.iter().map(|key| key.to_string()).collect();
    for list in [
        &mut quota_keys,
        &mut feature_keys,
        &mut expected_quotas,
        &mut expected_features,
    ] {
        list.sort();
    }
    assert_eq!((quota_keys, feature_keys), (expected_quotas, expected_features));
}

#[test]
fn a_newer_host_may_add_fields_and_states() {
    let mut value = fixture("office-license.json");
    value["addedLater"] = Value::Bool(true);
    value["state"] = Value::String("some_future_state".into());
    let license: OfficeLicense = serde_json::from_value(value).unwrap();
    assert_eq!(license.state, "some_future_state");
    let mut device = fixture("device-license.json");
    device["license"]["state"] = Value::String("some_future_state".into());
    device["license"]["addedLater"] = Value::Bool(true);
    let info: DeviceInfo = serde_json::from_value(device).unwrap();
    assert_eq!(info.license.unwrap().state, "some_future_state");
}

#[test]
fn the_preview_names_what_changes_and_warns_of_seats_over_the_file() {
    let preview: LicensePreview = round_trip("office-license-preview.json");
    assert_eq!(preview.before.plan, plans::TRIAL);
    assert_eq!(preview.before.license_id, None);
    assert_eq!(preview.after.sequence, Some(1));
    assert!(preview.after.quotas.stations.over);
    assert_eq!(preview.warnings, [warnings::OVER_LIMIT]);
    assert!(preview.changes.contains(&"quotas.stations".to_owned()));
}

#[test]
fn a_device_reads_the_license_with_its_record_and_an_older_host_sends_none() {
    let info: DeviceInfo = round_trip("device-license.json");
    let license: DeviceLicense = info.license.expect("the fixture has a license");
    assert_eq!(license.state, states::GRACE);
    assert_eq!(license.emergency_until, None);
    let older: DeviceInfo = round_trip("device-info.json");
    assert_eq!(older.license, None);
}

#[test]
fn the_load_request_is_strict() {
    let request: LicenseLoadRequest = round_trip("license-load-request.json");
    assert!(request.file.starts_with("eyJ"));
    let mut value = fixture("license-load-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<LicenseLoadRequest>(value).is_err());
}

#[test]
fn the_refusals_name_their_constraint_or_reason() {
    let restricted: ErrorBody = round_trip("error-license-restricted.json");
    assert_eq!(restricted.error.code, codes::CONFLICT);
    let details = restricted.error.details.unwrap();
    assert_eq!(details["constraint"], constraints::LICENSE_RESTRICTED);
    assert_eq!(details["state"], states::RESTRICTED);
    let seats: ErrorBody = round_trip("error-seat-limit.json");
    let details = seats.error.details.unwrap();
    assert_eq!(details["constraint"], constraints::SEAT_LIMIT);
    assert_eq!((details["used"].as_u64(), details["limit"].as_u64()), (Some(3), Some(3)));
    let feature: ErrorBody = round_trip("error-feature-disabled.json");
    assert_eq!(
        feature.error.details.unwrap()["constraint"],
        constraints::FEATURE_DISABLED
    );
    let refused: ErrorBody = round_trip("error-license-refused.json");
    assert_eq!(refused.error.code, codes::VALIDATION_FAILED);
    let details = refused.error.details.unwrap();
    assert_eq!(details["field"], "file");
    assert!(refusals::ALL.contains(&details["reason"].as_str().unwrap()));
}

#[test]
fn every_list_holds_its_codes_once() {
    for list in [
        constraints::ALL,
        refusals::ALL,
        warnings::ALL,
        states::ALL,
        plans::ALL,
    ] {
        let mut sorted = list.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len(), "{list:?}");
    }
    assert_eq!(states::ALL.len(), 8);
    assert_eq!(refusals::ALL.len(), 7);
}
```

Создать `apps/standalone/test/license-protocol.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { STANDALONE_FEATURE_KEYS, STANDALONE_QUOTA_KEYS } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import {
  deviceInfoSchema,
  deviceLicenseSchema,
  errorBodySchema,
  LICENSE_FEATURE_KEYS,
  LICENSE_QUOTA_KEYS,
  LICENSE_REFUSALS,
  licenseLoadRequestSchema,
  licensePreviewSchema,
  officeLicenseSchema,
} from "../src/host/protocol.js";
import { licenseLoad } from "../src/host/requests.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe("license shapes (proto/fixtures, plan ЛЦ-2)", () => {
  it("read the office's license without losing a field, and a newer host's", () => {
    expect(officeLicenseSchema.parse(fixture("office-license.json"))).toEqual(
      fixture("office-license.json"),
    );
    expect(officeLicenseSchema.safeParse(extended("office-license.json")).success).toBe(true);
    const future = { ...extended("office-license.json"), state: "some_future_state" };
    expect(officeLicenseSchema.parse(future).state).toBe("some_future_state");
  });

  it("read the preview's two columns and its warnings", () => {
    const preview = licensePreviewSchema.parse(fixture("office-license-preview.json"));
    expect(preview).toEqual(fixture("office-license-preview.json"));
    expect(preview.before.plan).toBe("trial");
    expect(preview.after.quotas.stations).toEqual({ limit: 3, used: 4, over: true });
    expect(preview.warnings).toEqual(["over_limit"]);
  });

  it("read a device's license with its record, and a record without one", () => {
    const info = deviceInfoSchema.parse(fixture("device-license.json"));
    expect(info.license).toEqual({
      state: "grace",
      since: "2027-10-20T09:00:00Z",
      phaseEndsAt: "2027-11-03T09:00:00Z",
      emergencyUntil: null,
    });
    expect(deviceInfoSchema.parse(fixture("device-info.json")).license).toBeUndefined();
    expect(
      deviceLicenseSchema.safeParse({ state: "grace", since: "yesterday", phaseEndsAt: null })
        .success,
    ).toBe(false);
  });

  it("send the file strictly through its one builder", () => {
    const file = (fixture("license-load-request.json") as { file: string }).file;
    expect(licenseLoad(file)).toEqual(fixture("license-load-request.json"));
    expect(licenseLoadRequestSchema.safeParse({ file, extra: true }).success).toBe(false);
    expect(licenseLoadRequestSchema.safeParse({ file: "" }).success).toBe(false);
    expect(licenseLoadRequestSchema.safeParse({ file: "a".repeat(16385) }).success).toBe(false);
  });

  it("read the refusals with their constraint, quota, feature or reason", () => {
    expect(errorBodySchema.parse(fixture("error-license-restricted.json")).error.details).toEqual({
      constraint: "license_restricted",
      state: "restricted",
      since: "2027-11-03T09:00:00Z",
    });
    expect(errorBodySchema.parse(fixture("error-seat-limit.json")).error.details).toEqual({
      constraint: "seat_limit",
      quota: "stations",
      used: 3,
      limit: 3,
    });
    expect(errorBodySchema.parse(fixture("error-feature-disabled.json")).error.details).toEqual({
      constraint: "feature_disabled",
      feature: "handheld",
    });
    const refused = errorBodySchema.parse(fixture("error-license-refused.json"));
    expect(LICENSE_REFUSALS).toContain(refused.error.details?.reason);
  });

  it("name the quotas and features as the cloud does (plan ЛЦ-1)", () => {
    expect([...LICENSE_QUOTA_KEYS]).toEqual([...STANDALONE_QUOTA_KEYS]);
    expect([...LICENSE_FEATURE_KEYS]).toEqual([...STANDALONE_FEATURE_KEYS]);
  });
});
```

В `apps/standalone/test/api.test.ts`:

Фрагмент (импорт клиента):

```ts
import { fakeHostApi } from "./support/office.js";
```

заменить на:

```ts
import { licenseLoad } from "../src/host/requests.js";
import { fakeHostApi } from "./support/office.js";
```

и дописать в конец файла:

```ts
describe("the license (plan ЛЦ-2)", () => {
  it("reads, previews and loads a file, asks for the activation request and the emergency, with the session", async () => {
    const office = fixture("office-license.json");
    const load = licenseLoad("eyJ0eXAiOiJ4In0.e30.c2ln");
    const activation = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/domain/fixtures/standalone-license/activation-request.json",
          testModuleUrl,
        ),
        "utf8",
      ),
    ) as unknown;
    const read = recording(office);
    await expect(read.api.getLicense(TOKEN)).resolves.toEqual(office);
    const previewed = recording(fixture("office-license-preview.json"));
    await previewed.api.previewLicense(TOKEN, load);
    const loaded = recording(office);
    await loaded.api.loadLicense(TOKEN, load);
    const asked = recording(activation);
    await expect(asked.api.getActivationRequest(TOKEN)).resolves.toEqual(activation);
    const extended = recording(office);
    await extended.api.enableLicenseEmergency(TOKEN);
    expect([
      ...read.sent,
      ...previewed.sent,
      ...loaded.sent,
      ...asked.sent,
      ...extended.sent,
    ]).toEqual([
      { method: "GET", path: "/v1/office/license", body: undefined, officeToken: TOKEN },
      { method: "POST", path: "/v1/office/license/preview", body: load, officeToken: TOKEN },
      { method: "PUT", path: "/v1/office/license", body: load, officeToken: TOKEN },
      {
        method: "GET",
        path: "/v1/office/license/activation-request",
        body: undefined,
        officeToken: TOKEN,
      },
      { method: "POST", path: "/v1/office/license/emergency", body: undefined, officeToken: TOKEN },
    ]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test license
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-protocol.test.ts test/api.test.ts
```

Ожидается: Rust — ошибка компиляции (нет `markiro_proto::license`, нет `DeviceInfo.license`); Vitest — ошибки импорта (`officeLicenseSchema`, `licenseLoad`, `getLicense` не существуют).

- [ ] **Step 3: Реализация — Rust**

Создать `apps/standalone/proto/src/license.rs`:

```rust
//! The site's license (plan ЛЦ-2, spec 2026-10-13 §8.2): what the office
//! reads (`GET /v1/office/license`), the preview and the load of a file, and
//! the license line of a device's own record (`GET /v1/device`). The state
//! is a word, not an enum, in every answer: a newer host may add one, and an
//! older device must still read its record (the shell parses `DeviceInfo`
//! too).

use serde::{Deserialize, Serialize};

/// `details.constraint` of a `conflict` the license causes.
pub mod constraints {
    /// New shifts do not open: the license or the trial ran out, or the
    /// organization's INN is not the file's (`details.state`, `since`).
    pub const LICENSE_RESTRICTED: &str = "license_restricted";
    /// Every seat of a quota is taken (`details.quota`, `used`, `limit`).
    pub const SEAT_LIMIT: &str = "seat_limit";
    /// The license does not include the feature (`details.feature`).
    pub const FEATURE_DISABLED: &str = "feature_disabled";
    /// The emergency extension of this file (or of the trial) was used.
    pub const EMERGENCY_USED: &str = "emergency_used";
    /// New shifts open: there is nothing to extend.
    pub const EMERGENCY_NOT_NEEDED: &str = "emergency_not_needed";

    pub const ALL: &[&str] = &[
        LICENSE_RESTRICTED,
        SEAT_LIMIT,
        FEATURE_DISABLED,
        EMERGENCY_USED,
        EMERGENCY_NOT_NEEDED,
    ];
}

/// `details.reason` of a refused file (`validation_failed` on `file`) and of
/// the `denied` row of `license.load`, in the order the host checks (§4.3).
pub mod refusals {
    pub const MALFORMED: &str = "license_malformed";
    pub const UNKNOWN_KEY: &str = "license_unknown_key";
    pub const SIGNATURE: &str = "license_signature";
    pub const WRONG_HOST: &str = "license_wrong_host";
    pub const INN_MISMATCH: &str = "license_inn_mismatch";
    pub const INN_MISSING: &str = "license_inn_missing";
    pub const OLDER: &str = "license_older";

    pub const ALL: &[&str] = &[
        MALFORMED,
        UNKNOWN_KEY,
        SIGNATURE,
        WRONG_HOST,
        INN_MISMATCH,
        INN_MISSING,
        OLDER,
    ];
}

/// What an accepted file warns of (`warnings`).
pub mod warnings {
    /// The file's term ended already: it is kept, and new shifts need a newer one.
    pub const EXPIRED: &str = "expired";
    /// The file begins later: it waits for its `validFrom`.
    pub const NOT_YET_VALID: &str = "not_yet_valid";
    /// A quota is below what the site uses: nothing is disconnected, new
    /// additions are refused.
    pub const OVER_LIMIT: &str = "over_limit";

    pub const ALL: &[&str] = &[EXPIRED, NOT_YET_VALID, OVER_LIMIT];
}

/// The license states (spec §3.2).
pub mod states {
    pub const TRIAL: &str = "trial";
    pub const ACTIVE: &str = "active";
    pub const EXPIRING: &str = "expiring";
    pub const GRACE: &str = "grace";
    pub const RESTRICTED: &str = "restricted";
    pub const WRONG_HOST: &str = "wrong_host";
    pub const INN_MISMATCH: &str = "inn_mismatch";
    pub const TRIAL_EXPIRED: &str = "trial_expired";

    pub const ALL: &[&str] = &[
        TRIAL,
        ACTIVE,
        EXPIRING,
        GRACE,
        RESTRICTED,
        WRONG_HOST,
        INN_MISMATCH,
        TRIAL_EXPIRED,
    ];
}

/// `plan` of a file, and the built-in trial's in a preview.
pub mod plans {
    pub const TRIAL: &str = "trial";
    pub const DEMO: &str = "demo";
    pub const SUBSCRIPTION: &str = "subscription";

    pub const ALL: &[&str] = &[TRIAL, DEMO, SUBSCRIPTION];
}

/// The file's quota keys, as the cloud names them (`ENTITLEMENT_QUOTA_KEYS`).
pub const QUOTA_KEYS: [&str; 4] = ["lines", "stations", "kiosks", "cabinetUsers"];
/// The file's feature keys (`ENTITLEMENT_FEATURE_KEYS`).
pub const FEATURE_KEYS: [&str; 7] = [
    "labelEditor",
    "publicApi",
    "pallets",
    "chzIntegration",
    "inventory",
    "commerceMl",
    "handheld",
];

/// A quota: the file's limit (`None`: no limit), what the site uses, and
/// whether it uses more than the file allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaUse {
    pub limit: Option<u32>,
    pub used: u32,
    pub over: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseQuotas {
    pub lines: QuotaUse,
    pub stations: QuotaUse,
    pub kiosks: QuotaUse,
    pub cabinet_users: QuotaUse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFeatures {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseCustomer {
    pub name: String,
    pub inn: String,
}

/// The file in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseSummary {
    pub license_id: String,
    pub sequence: u64,
    pub kid: String,
    pub customer: LicenseCustomer,
    /// `demo` or `subscription`.
    pub plan: String,
    pub plan_version_id: String,
    pub issued_at: String,
    pub valid_from: String,
    /// Exclusive.
    pub valid_until: String,
    pub grace_days: u32,
}

/// The built-in trial: its start (the wizard), its end and the INN the
/// wizard took.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialInfo {
    pub started_at: String,
    pub ends_at: String,
    pub inn: Option<String>,
}

/// What the license is bound to: this host and the organization's INN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseBinding {
    pub host_id: String,
    pub fingerprint: String,
    pub org_inn: Option<String>,
    /// `None` without a file in force.
    pub inn_matches: Option<bool>,
}

/// The PC's clock as the host sees it (spec §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFlags {
    /// Days the PC's clock is behind the last known time; `None` within a day.
    pub clock_behind_days: Option<u32>,
    /// The PC's clock is more than a day ahead of the time the host trusts.
    pub clock_ahead: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseEmergency {
    pub available: bool,
    /// The end of an emergency extension that runs now.
    pub until: Option<String>,
}

/// `GET /v1/office/license` (every office role), and the answer of a load
/// (with `warnings`) and of the emergency extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLicense {
    /// One of [`states`].
    pub state: String,
    pub since: String,
    pub flags: LicenseFlags,
    pub effective_at: String,
    pub phase_ends_at: Option<String>,
    pub days_left: Option<u32>,
    pub warn_days: u32,
    /// New shifts open now (the state, or an emergency extension that runs).
    pub opens_new_shifts: bool,
    pub license: Option<LicenseSummary>,
    pub trial: Option<TrialInfo>,
    pub binding: LicenseBinding,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
    pub emergency: LicenseEmergency,
    /// What an accepted file warns of ([`warnings`]); empty and left out
    /// when there is nothing to say.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// One column of the preview's «было → станет».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseTerms {
    /// `None` for the built-in trial.
    pub license_id: Option<String>,
    pub sequence: Option<u64>,
    /// One of [`plans`].
    pub plan: String,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub grace_days: u32,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
}

/// `POST /v1/office/license/preview` (administrators): the file checked as a
/// load checks it, nothing written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePreview {
    pub before: LicenseTerms,
    pub after: LicenseTerms,
    /// `plan`, `validFrom`, `validUntil`, `graceDays`, `quotas.<key>`,
    /// `features.<key>` that differ, in that order.
    pub changes: Vec<String>,
    pub warnings: Vec<String>,
}

/// The license line of `GET /v1/device`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLicense {
    /// One of [`states`].
    pub state: String,
    pub since: String,
    pub phase_ends_at: Option<String>,
    /// New shifts open until then although the state says otherwise (§3.5).
    pub emergency_until: Option<String>,
}

/// `POST /v1/office/license/preview` and `PUT /v1/office/license`: the text
/// of a `.mklic` file, at most 16 KiB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseLoadRequest {
    pub file: String,
}
```

Правка `apps/standalone/proto/src/lib.rs`:

Фрагмент:

```rust
pub mod backup;
pub mod cloud_import;
pub mod pairing;
```

заменить на:

```rust
pub mod backup;
pub mod cloud_import;
pub mod license;
pub mod pairing;
```

Фрагмент:

```rust
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

заменить на:

```rust
/// `GET /v1/device`. `license` (plan ЛЦ-2) is the site's license state as
/// the host computed it: a host before ЛЦ-2 sends none, and `PUT
/// /v1/device/line` answers without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub paired_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<license::DeviceLicense>,
}
```

Правка `apps/standalone/host/src/routes/devices.rs` (иначе хост не собирается):

Фрагмент:

```rust
        line_id,
        paired_at,
    })
}
```

заменить на:

```rust
        line_id,
        paired_at,
        // `GET /v1/device` adds the license (plan ЛЦ-2); the line's answer has none.
        license: None,
    })
}
```

- [ ] **Step 4: Реализация — вебвью**

Правка `apps/standalone/src/host/protocol.ts` — перед блоком `GET /v1/device`:

Фрагмент:

```ts
/** `GET /v1/device`. */
export const deviceInfoSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  pairedAt: z.iso.datetime(),
});
```

заменить на:

```ts
// --- The site's license (plan ЛЦ-2, `proto/src/license.rs`) ---
// Answers are lenient like every host response; the state is a word, not an
// enum, so a state a newer host adds does not fail the page.

/** `state` of a license answer (spec §3.2). */
export const LICENSE_STATES = [
  "trial",
  "active",
  "expiring",
  "grace",
  "restricted",
  "wrong_host",
  "inn_mismatch",
  "trial_expired",
] as const;
/** `details.reason` of a refused file, in the host's order of checks (§4.3). */
export const LICENSE_REFUSALS = [
  "license_malformed",
  "license_unknown_key",
  "license_signature",
  "license_wrong_host",
  "license_inn_mismatch",
  "license_inn_missing",
  "license_older",
] as const;
export const LICENSE_WARNINGS = ["expired", "not_yet_valid", "over_limit"] as const;
/** `details.constraint` of a `conflict` the license causes. */
export const LICENSE_CONSTRAINTS = [
  "license_restricted",
  "seat_limit",
  "feature_disabled",
  "emergency_used",
  "emergency_not_needed",
] as const;
export const LICENSE_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
export const LICENSE_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
] as const;
/** The most a license file may hold (`verify::MAX_FILE_BYTES`). */
export const MAX_LICENSE_FILE_BYTES = 16 * 1024;

const quotaUseSchema = z.object({
  limit: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative(),
  over: z.boolean(),
});
export const licenseQuotasSchema = z.object({
  lines: quotaUseSchema,
  stations: quotaUseSchema,
  kiosks: quotaUseSchema,
  cabinetUsers: quotaUseSchema,
});
export const licenseFeaturesSchema = z.object({
  labelEditor: z.boolean(),
  publicApi: z.boolean(),
  pallets: z.boolean(),
  chzIntegration: z.boolean(),
  inventory: z.boolean(),
  commerceMl: z.boolean(),
  handheld: z.boolean(),
});

/** `GET /v1/office/license`, and the answers of a load and of the emergency extension. */
export const officeLicenseSchema = z.object({
  state: z.string(),
  since: z.iso.datetime(),
  flags: z.object({
    clockBehindDays: z.number().int().positive().nullable(),
    clockAhead: z.boolean(),
  }),
  effectiveAt: z.iso.datetime(),
  phaseEndsAt: z.iso.datetime().nullable(),
  daysLeft: z.number().int().nonnegative().nullable(),
  warnDays: z.number().int().nonnegative(),
  opensNewShifts: z.boolean(),
  license: z
    .object({
      licenseId: z.uuid(),
      sequence: z.number().int().positive(),
      kid: z.string(),
      customer: z.object({ name: z.string(), inn: z.string() }),
      plan: z.string(),
      planVersionId: z.string(),
      issuedAt: z.iso.datetime(),
      validFrom: z.iso.datetime(),
      validUntil: z.iso.datetime(),
      graceDays: z.number().int().nonnegative(),
    })
    .nullable(),
  trial: z
    .object({
      startedAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      inn: z.string().nullable(),
    })
    .nullable(),
  binding: z.object({
    hostId: z.uuid(),
    fingerprint: z.string(),
    orgInn: z.string().nullable(),
    innMatches: z.boolean().nullable(),
  }),
  quotas: licenseQuotasSchema,
  features: licenseFeaturesSchema,
  emergency: z.object({ available: z.boolean(), until: z.iso.datetime().nullable() }),
  warnings: z.array(z.string()).optional(),
});
export type OfficeLicense = z.infer<typeof officeLicenseSchema>;

/** One column of the preview's «было → станет». */
export const licenseTermsSchema = z.object({
  licenseId: z.uuid().nullable(),
  sequence: z.number().int().positive().nullable(),
  plan: z.string(),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  graceDays: z.number().int().nonnegative(),
  quotas: licenseQuotasSchema,
  features: licenseFeaturesSchema,
});
export type LicenseTerms = z.infer<typeof licenseTermsSchema>;

/** `POST /v1/office/license/preview`. */
export const licensePreviewSchema = z.object({
  before: licenseTermsSchema,
  after: licenseTermsSchema,
  changes: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type LicensePreview = z.infer<typeof licensePreviewSchema>;

/** The license line of `GET /v1/device`. */
export const deviceLicenseSchema = z.object({
  state: z.string(),
  since: z.iso.datetime(),
  phaseEndsAt: z.iso.datetime().nullable(),
  emergencyUntil: z.iso.datetime().nullable(),
});
export type DeviceLicense = z.infer<typeof deviceLicenseSchema>;

/** `POST /v1/office/license/preview` and `PUT /v1/office/license` (strict, `licenseLoad`). */
export const licenseLoadRequestSchema = z
  .object({ file: z.string().min(1).max(MAX_LICENSE_FILE_BYTES) })
  .strict();
export type LicenseLoadRequest = z.infer<typeof licenseLoadRequestSchema>;

/** `GET /v1/device`; `license` since plan ЛЦ-2. */
export const deviceInfoSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  pairedAt: z.iso.datetime(),
  license: deviceLicenseSchema.optional(),
});
```

Правка `apps/standalone/src/host/requests.ts`:

Фрагмент:

```ts
  LabelTemplate,
  LineCreate,
```

заменить на:

```ts
  LabelTemplate,
  LicenseLoadRequest,
  LineCreate,
```

и дописать в конец файла:

```ts
/**
 * `POST /v1/office/license/preview` and `PUT /v1/office/license`
 * (`license-load-request.json`): the file's text as it was read; the host
 * trims it and checks everything else.
 */
export function licenseLoad(file: string): LicenseLoadRequest {
  return { file };
}
```

Правка `apps/standalone/src/host/api.ts`:

Фрагмент:

```ts
import { z } from "zod";

import {
  backupStateSchema,
```

заменить на:

```ts
import {
  standaloneActivationRequestSchema,
  type StandaloneActivationRequest,
} from "@markiro/domain";
import { z } from "zod";

import {
  backupStateSchema,
```

В импорт из `"./protocol.js"` добавить (в алфавитном месте списка, как он устроен) `licensePreviewSchema`, `officeLicenseSchema`, `type LicenseLoadRequest`, `type LicensePreview`, `type OfficeLicense`.

Фрагмент (конец интерфейса):

```ts
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
}
```

заменить на:

```ts
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
  /** The site's license (plan ЛЦ-2); every office role reads it. */
  getLicense: (token: string) => Promise<OfficeLicense>;
  /** «было → станет» of a file, checked as a load checks it; administrators, nothing written. */
  previewLicense: (token: string, request: LicenseLoadRequest) => Promise<LicensePreview>;
  /** Load a file (administrators); a refusal is `validation_failed` on `file` with `details.reason`. */
  loadLicense: (token: string, request: LicenseLoadRequest) => Promise<OfficeLicense>;
  /** The activation request the office saves for Маркиро (administrators). */
  getActivationRequest: (token: string) => Promise<StandaloneActivationRequest>;
  /** «Открывать новые смены ещё 3 дня» (administrators), once per file and once for the trial. */
  enableLicenseEmergency: (token: string) => Promise<OfficeLicense>;
}
```

Фрагмент (конец `createHostApi`):

```ts
    resumeFacts: (token) =>
      client.request("POST", "/v1/office/backups/resume", {
        officeToken: token,
        schema: backupStateSchema,
      }),
  };
}
```

заменить на:

```ts
    resumeFacts: (token) =>
      client.request("POST", "/v1/office/backups/resume", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    getLicense: (token) =>
      client.request("GET", "/v1/office/license", {
        officeToken: token,
        schema: officeLicenseSchema,
      }),
    previewLicense: (token, request) =>
      client.request("POST", "/v1/office/license/preview", {
        body: request,
        officeToken: token,
        schema: licensePreviewSchema,
      }),
    loadLicense: (token, request) =>
      client.request("PUT", "/v1/office/license", {
        body: request,
        officeToken: token,
        schema: officeLicenseSchema,
      }),
    getActivationRequest: (token) =>
      client.request("GET", "/v1/office/license/activation-request", {
        officeToken: token,
        schema: standaloneActivationRequestSchema,
      }),
    enableLicenseEmergency: (token) =>
      client.request("POST", "/v1/office/license/emergency", {
        officeToken: token,
        schema: officeLicenseSchema,
      }),
  };
}
```

Правка `apps/standalone/test/support/office.tsx`:

Фрагмент:

```ts
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    ...overrides,
```

заменить на:

```ts
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    getLicense: vi.fn<HostApi["getLicense"]>(() => unexpected("getLicense")),
    previewLicense: vi.fn<HostApi["previewLicense"]>(() => unexpected("previewLicense")),
    loadLicense: vi.fn<HostApi["loadLicense"]>(() => unexpected("loadLicense")),
    getActivationRequest: vi.fn<HostApi["getActivationRequest"]>(() =>
      unexpected("getActivationRequest"),
    ),
    enableLicenseEmergency: vi.fn<HostApi["enableLicenseEmergency"]>(() =>
      unexpected("enableLicenseEmergency"),
    ),
    ...overrides,
```

- [ ] **Step 5: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-protocol.test.ts test/api.test.ts test/protocol.test.ts
```

Ожидается: PASS; хост собирается без предупреждений; `device-info.json` по-прежнему проходит круг (`license` пропущен).

- [ ] **Step 6: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/proto/fixtures/office-license.json apps/standalone/proto/fixtures/office-license-preview.json apps/standalone/proto/fixtures/device-license.json apps/standalone/proto/fixtures/license-load-request.json apps/standalone/proto/fixtures/error-license-restricted.json apps/standalone/proto/fixtures/error-seat-limit.json apps/standalone/proto/fixtures/error-feature-disabled.json apps/standalone/proto/fixtures/error-license-refused.json apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/license-protocol.test.ts apps/standalone/test/api.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/proto/src/license.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/license.rs apps/standalone/proto/fixtures/office-license.json apps/standalone/proto/fixtures/office-license-preview.json apps/standalone/proto/fixtures/device-license.json apps/standalone/proto/fixtures/license-load-request.json apps/standalone/proto/fixtures/error-license-restricted.json apps/standalone/proto/fixtures/error-seat-limit.json apps/standalone/proto/fixtures/error-feature-disabled.json apps/standalone/proto/fixtures/error-license-refused.json apps/standalone/host/src/routes/devices.rs apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/license-protocol.test.ts apps/standalone/test/api.test.ts
git commit -F - <<'EOF'
feat(standalone): the license on the wire — office license, preview, device line, load request (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Миграция хоста `0030_license.sql` и имена аудита

**Files:**

- Create: `apps/standalone/host/migrations/0030_license.sql`
- Modify: `apps/standalone/host/src/audit.rs`
- Test: `apps/standalone/host/tests/license_schema.rs`

**Interfaces:**

- Consumes: `markiro_proto::license::refusals` (задача 1), `db::MIGRATOR`.
- Produces: таблицы `licenses` (только пополняется) и `license_clock` (одна строка `id = 1`); `audit::actions::{LICENSE_LOAD, LICENSE_STATE, LICENSE_EMERGENCY}`; `audit::reasons::{LICENSE_MALFORMED, LICENSE_UNKNOWN_KEY, LICENSE_SIGNATURE, LICENSE_WRONG_HOST, LICENSE_INN_MISMATCH, LICENSE_INN_MISSING, LICENSE_OLDER}`.

- [ ] **Step 1: Падающий тест**

Создать `apps/standalone/host/tests/license_schema.rs`:

```rust
//! Migration `0030` (plan ЛЦ-2): the site's license files, append-only, and
//! the one row of the license clock.

mod support;

use support::app::TestApp;

const INSERT: &str = "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, \
     issued_at, valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
     customer_inn, quotas, features, loaded_at, loaded_by) \
     VALUES (?, ?, 'a.b.c', 'test-lic-1', '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', 1, 1, ?, ?, ?, \
     '0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4', 'ООО «Атолл»', '7707083893', '{}', '{}', \
     '2026-10-13T09:00:00Z', NULL)";

async fn insert(
    app: &TestApp,
    id: &str,
    sequence: i64,
    valid_until: i64,
    grace_days: i64,
    plan: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(INSERT)
        .bind(id)
        .bind(sequence)
        .bind(valid_until)
        .bind(grace_days)
        .bind(plan)
        .execute(&app.state.pool)
        .await
        .map(|_| ())
}

#[tokio::test]
async fn a_new_host_has_no_license_and_an_empty_clock() {
    let app = TestApp::new().await;
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(files, 0);
    #[allow(clippy::type_complexity)]
    let clock: (
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until, \
         wrong_host_since, last_state, last_state_at FROM license_clock WHERE id = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(clock, (None, None, None, None, None, None, None, None));
}

#[tokio::test]
async fn the_tables_refuse_what_no_verified_file_holds() {
    let app = TestApp::new().await;
    let id = "6d1f0a52-3c4b-4e8f-9a1d-000000000001";
    insert(&app, id, 1, 2, 14, "subscription").await.unwrap();
    for (name, result) in [
        ("a second clock row", {
            sqlx::query("INSERT INTO license_clock (id) VALUES (2)")
                .execute(&app.state.pool)
                .await
                .map(|_| ())
        }),
        (
            "a sequence of 0",
            insert(&app, "6d1f0a52-3c4b-4e8f-9a1d-000000000002", 0, 2, 14, "demo").await,
        ),
        (
            "61 days of grace",
            insert(&app, "6d1f0a52-3c4b-4e8f-9a1d-000000000003", 3, 2, 61, "demo").await,
        ),
        (
            "an unknown plan",
            insert(&app, "6d1f0a52-3c4b-4e8f-9a1d-000000000004", 4, 2, 0, "trial").await,
        ),
        (
            "an end before the start",
            insert(&app, "6d1f0a52-3c4b-4e8f-9a1d-000000000005", 5, 1, 0, "demo").await,
        ),
    ] {
        let error = result.expect_err(name);
        assert!(error.to_string().contains("CHECK"), "{name}: {error}");
    }
    for (name, result) in [
        (
            "the same sequence",
            insert(&app, "6d1f0a52-3c4b-4e8f-9a1d-000000000006", 1, 2, 0, "demo").await,
        ),
        ("the same file", insert(&app, id, 7, 2, 0, "demo").await),
    ] {
        let error = result.expect_err(name);
        assert!(error.to_string().contains("UNIQUE"), "{name}: {error}");
    }
}

#[test]
fn the_audit_names_the_license_and_its_refusals() {
    use markiro_host::audit::{actions, reasons};
    use markiro_proto::license::refusals;
    assert_eq!(
        [actions::LICENSE_LOAD, actions::LICENSE_STATE, actions::LICENSE_EMERGENCY],
        ["license.load", "license.state", "license.emergency"]
    );
    assert_eq!(
        [
            reasons::LICENSE_MALFORMED,
            reasons::LICENSE_UNKNOWN_KEY,
            reasons::LICENSE_SIGNATURE,
            reasons::LICENSE_WRONG_HOST,
            reasons::LICENSE_INN_MISMATCH,
            reasons::LICENSE_INN_MISSING,
            reasons::LICENSE_OLDER,
        ],
        refusals::ALL
    );
}
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_schema
```

Ожидается: ошибка компиляции (`actions::LICENSE_LOAD` нет); после добавления имён — FAIL «no such table: licenses».

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/migrations/0030_license.sql`:

```sql
-- Plan ЛЦ-2 (spec 2026-10-13 §4.4, §8.1): the site's license files and the
-- license clock. Times are milliseconds since the Unix epoch, UTC, as the
-- signed file counts them.

-- Every file the office loaded, verified before it was written; append-only.
-- The file in force is the highest `sequence` whose `valid_from` came.
-- `loaded_by` names an office user without a foreign key: a restore carries
-- a row into a copy that may lack that user.
CREATE TABLE licenses (
    license_id TEXT PRIMARY KEY NOT NULL CHECK (length(license_id) = 36),
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
    compact TEXT NOT NULL CHECK (length(compact) BETWEEN 1 AND 16384),
    kid TEXT NOT NULL CHECK (length(kid) BETWEEN 1 AND 200),
    host_id TEXT NOT NULL CHECK (length(host_id) = 36),
    issued_at INTEGER NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER NOT NULL CHECK (valid_until > valid_from),
    grace_days INTEGER NOT NULL CHECK (grace_days BETWEEN 0 AND 60),
    plan TEXT NOT NULL CHECK (plan IN ('demo', 'subscription')),
    plan_version_id TEXT NOT NULL CHECK (length(plan_version_id) BETWEEN 1 AND 64),
    customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 500),
    customer_inn TEXT NOT NULL CHECK (length(customer_inn) BETWEEN 1 AND 32),
    quotas TEXT NOT NULL CHECK (json_valid(quotas)),
    features TEXT NOT NULL CHECK (json_valid(features)),
    loaded_at TEXT NOT NULL,
    loaded_by TEXT
);

-- One row: the last time the host knew (§7), the trial's start and the INN
-- the wizard took (§3.4), the emergency extension (§3.5), when a file of
-- another host was first seen in force (§4.6) and the last state a
-- `license.state` row named.
CREATE TABLE license_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_seen_at INTEGER,
    trial_started_at INTEGER,
    trial_inn TEXT,
    emergency_used_for TEXT,
    emergency_until INTEGER,
    wrong_host_since INTEGER,
    last_state TEXT,
    last_state_at INTEGER
);

INSERT INTO license_clock (id) VALUES (1);
```

Правка `apps/standalone/host/src/audit.rs`:

Фрагмент:

```rust
    /// An administrator set or cleared the second folder of copies.
    pub const BACKUP_SETTINGS_UPDATE: &str = "backup.settings.update";
}
```

заменить на:

```rust
    /// An administrator set or cleared the second folder of copies.
    pub const BACKUP_SETTINGS_UPDATE: &str = "backup.settings.update";
    /// An administrator loaded a license file (plan ЛЦ-2); `denied` for a
    /// file the host refused, with its reason: unlike other refused office
    /// writes, a foreign or forged file is an event for the log.
    pub const LICENSE_LOAD: &str = "license.load";
    /// The license state changed (the host is the actor): a phase that ended
    /// by time, a file, the organization's INN.
    pub const LICENSE_STATE: &str = "license.state";
    /// An administrator opened new shifts for 72 hours more (spec §3.5).
    pub const LICENSE_EMERGENCY: &str = "license.emergency";
}
```

Фрагмент:

```rust
    pub const CODE_EXPIRED: &str = "code_expired";
}
```

заменить на:

```rust
    pub const CODE_EXPIRED: &str = "code_expired";
    /// A refused license file (plan ЛЦ-2, spec §4.3), as the answer names it.
    pub const LICENSE_MALFORMED: &str = markiro_proto::license::refusals::MALFORMED;
    pub const LICENSE_UNKNOWN_KEY: &str = markiro_proto::license::refusals::UNKNOWN_KEY;
    pub const LICENSE_SIGNATURE: &str = markiro_proto::license::refusals::SIGNATURE;
    pub const LICENSE_WRONG_HOST: &str = markiro_proto::license::refusals::WRONG_HOST;
    pub const LICENSE_INN_MISMATCH: &str = markiro_proto::license::refusals::INN_MISMATCH;
    pub const LICENSE_INN_MISSING: &str = markiro_proto::license::refusals::INN_MISSING;
    pub const LICENSE_OLDER: &str = markiro_proto::license::refusals::OLDER;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_schema --test backup_schema
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib db::
```

Ожидается: PASS (миграции встроены с LF — `the_migrations_are_embedded_with_lf_line_endings`).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/migrations/0030_license.sql apps/standalone/host/src/audit.rs apps/standalone/host/tests/license_schema.rs
git commit -F - <<'EOF'
feat(standalone): host migration 0030 — license files and the license clock, audit names (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Мастер требует ИНН с контрольной суммой и начинает пробный период

**Files:**

- Modify: `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/proto/fixtures/bootstrap-request.json`, `apps/standalone/proto/fixtures/bootstrap-request-templates.json`, `apps/standalone/src/wizard/wizard-form.ts`, `apps/standalone/src/wizard/BootstrapWizard.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/wizard.ts`
- Test: `apps/standalone/host/tests/bootstrap.rs`, `apps/standalone/host/tests/{device_shifts.rs,office_exports.rs,changes.rs,template_defaults.rs,office_reports.rs,no_secrets_in_logs.rs}`, `apps/standalone/test/wizard-form.test.ts`

**Interfaces:**

- Consumes: `crate::inn::normalize` (ЛЦ-1), `license_clock` (задача 2); `isValidInn` из `@markiro/domain` (ЛЦ-1).
- Produces: `POST /v1/bootstrap` отвечает `validation_failed` на `org.inn`, если ИНН нет, пуст или не проходит контрольную сумму; мастер пишет `license_clock.trial_started_at` (мс) и `trial_inn` (нормализованный) один раз; `validateStep("org")` даёт `wizard.errors.innRequired` / `wizard.errors.innChecksum`.

- [ ] **Step 1: Тестовый ИНН мастера**

Заменить ИНН мастера в тестах хоста и фикстурах (граница слова: 12-значный `770123456789` в `office_exports.rs` — ИНН профиля, не мастера — не трогается):

```bash
perl -pi -e 's/\b7701234567\b/7707083893/g' apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/bootstrap.rs apps/standalone/host/tests/device_shifts.rs apps/standalone/host/tests/office_exports.rs apps/standalone/host/tests/changes.rs apps/standalone/host/tests/template_defaults.rs apps/standalone/host/tests/office_reports.rs apps/standalone/proto/fixtures/bootstrap-request.json apps/standalone/proto/fixtures/bootstrap-request-templates.json
git diff --stat
```

Ожидается: только перечисленные файлы, по строкам из списка задачи (17 строк в тестах хоста, по одной в каждой фикстуре); `770123456789` не изменён. Все эти значения приходят из `bootstrap_body()` через мастер. Если тест вебвью сверяет одну из двух фикстур мастера с прежним ИНН — обновить его так же и записать.

В `apps/standalone/host/tests/no_secrets_in_logs.rs` мастер шлёт организацию без ИНН. Фрагмент:

```rust
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
```

заменить на:

```rust
            "org": { "name": "ООО «Атолл»", "inn": "7707083893", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
```

- [ ] **Step 2: Падающие тесты**

Правка `apps/standalone/host/tests/bootstrap.rs`:

Фрагмент:

```rust
    let cases: [(&str, Value, &str); 12] = [
        ("/admin/login", json!("ад"), "admin.login"),
        ("/admin/name", json!("  "), "admin.name"),
        ("/admin/password", json!("short"), "admin.password"),
        ("/org/name", json!(""), "org.name"),
        ("/org/inn", json!("12345"), "org.inn"),
```

заменить на:

```rust
    let cases: [(&str, Value, &str); 15] = [
        ("/admin/login", json!("ад"), "admin.login"),
        ("/admin/name", json!("  "), "admin.name"),
        ("/admin/password", json!("short"), "admin.password"),
        ("/org/name", json!(""), "org.name"),
        ("/org/inn", json!("12345"), "org.inn"),
        // A license is issued to the INN (plan ЛЦ-2): the wizard takes only
        // one whose check digit holds, and none at all is refused.
        ("/org/inn", json!("7707083894"), "org.inn"),
        ("/org/inn", json!(""), "org.inn"),
        ("/org/inn", json!(null), "org.inn"),
```

Дописать в конец файла:

```rust
/// The trial starts with the wizard (plan ЛЦ-2, spec §3.4): once, with the
/// INN the wizard took, normalized.
#[tokio::test]
async fn the_wizard_starts_the_trial_with_its_inn() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let mut body = bootstrap_body();
    body["org"]["inn"] = json!(" 7707083893 ");
    let (status, answer) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let clock: (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT trial_started_at, trial_inn FROM license_clock WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        clock,
        (Some(support::app::START * 1000), Some("7707083893".to_owned()))
    );
}
```

Правка `apps/standalone/test/wizard-form.test.ts`:

Фрагмент:

```ts
    orgName: "ООО «Атолл»",
    gln: "4600682000013",
    ...overrides,
```

заменить на:

```ts
    orgName: "ООО «Атолл»",
    inn: "7707083893",
    gln: "4600682000013",
    ...overrides,
```

Фрагмент:

<!-- prettier-ignore -->
```ts
    expect(validateStep("org", values({ inn: "77012345678" }))).toEqual([
      { field: "inn", message: "rules.inn" },
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(validateStep("org", values({ inn: "77012345678" }))).toEqual([
      { field: "inn", message: "rules.inn" },
    ]);
    // A license is issued to the INN (plan ЛЦ-2): the wizard needs one whose check digit holds.
    expect(validateStep("org", values({ inn: "" }))).toEqual([
      { field: "inn", message: "wizard.errors.innRequired" },
    ]);
    expect(validateStep("org", values({ inn: "7707083894" }))).toEqual([
      { field: "inn", message: "wizard.errors.innChecksum" },
    ]);
    expect(validateStep("org", values({ inn: " 7707083893 " }))).toEqual([]);
```

Правка `apps/standalone/test/support/wizard.ts`: `type("ИНН", "7701234567");` → `type("ИНН", "7707083893");` и в `EXPECTED_REQUEST` `inn: "7701234567",` → `inn: "7707083893",`.

- [ ] **Step 3: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx
```

Ожидается: `invalid_wizard_input_names_the_field` — FAIL на `7707083894` (`200`); `the_wizard_starts_the_trial_with_its_inn` — FAIL (`(None, None)`); Vitest — FAIL трёх новых ожиданий; `wizard.test.tsx` — PASS (новый ИНН верен).

- [ ] **Step 4: Реализация — хост**

Правка `apps/standalone/host/src/routes/bootstrap.rs`:

Фрагмент:

```rust
    let org = validate::org("org", &request.org)?;
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
```

заменить на:

```rust
    let org = validate::org("org", &request.org)?;
    // A license is issued to the organization's INN (plan ЛЦ-2, spec §4.9,
    // ЛО24): the wizard takes only one whose check digit holds. The office's
    // profile keeps the plain 10-or-12-digit rule (ЛО27).
    let trial_inn = org
        .inn
        .as_deref()
        .and_then(crate::inn::normalize)
        .ok_or_else(|| {
            ApiError::validation("org.inn", "an INN whose check digit holds is required")
        })?;
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
```

Фрагмент:

```rust
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
```

заменить на:

```rust
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // The built-in trial starts with the wizard (plan ЛЦ-2, spec §3.4),
    // once, with the INN the wizard took (it goes into the activation
    // request).
    let started_at =
        i64::try_from(now.unix_timestamp_nanos() / 1_000_000).map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE license_clock SET trial_started_at = coalesce(trial_started_at, ?), \
         trial_inn = coalesce(trial_inn, ?) WHERE id = 1",
    )
    .bind(started_at)
    .bind(&trial_inn)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
```

- [ ] **Step 5: Реализация — вебвью**

Правка `apps/standalone/src/wizard/wizard-form.ts`:

Фрагмент:

```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  ssccSerialCapacity,
  type LabelTemplateSpec,
} from "@markiro/domain";
```

заменить на:

```ts
import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  isValidInn,
  PALLET_LABEL_TEMPLATE_NAME,
  ssccSerialCapacity,
  type LabelTemplateSpec,
} from "@markiro/domain";
```

Фрагмент:

```ts
    case "org":
      return issuesOf(orgFieldsSchema.safeParse(values).error);
```

заменить на:

```ts
    case "org": {
      const issues = issuesOf(orgFieldsSchema.safeParse(values).error);
      // A license is issued to the INN (plan ЛЦ-2): the wizard needs one, and
      // its check digit must hold, as the host checks (`crate::inn`). The
      // office's profile keeps the form's plain rule.
      if (!issues.some((issue) => issue.field === "inn")) {
        const inn = values.inn.trim();
        if (inn === "") issues.push({ field: "inn", message: "wizard.errors.innRequired" });
        else if (!isValidInn(inn)) issues.push({ field: "inn", message: "wizard.errors.innChecksum" });
      }
      return issues;
    }
```

Правка `apps/standalone/src/wizard/BootstrapWizard.tsx`: `hint={t("org.innHint")}` (строка поля ИНН мастера) → `hint={t("wizard.innHint")}`.

Правка `apps/standalone/src/i18n/ru.json` (блок `wizard`):

Фрагмент:

```json
      "lineDuplicate": "Такая линия уже есть",
      "lines": "Нужна хотя бы одна линия, но не больше 20"
    }
  },
```

заменить на:

```json
      "lineDuplicate": "Такая линия уже есть",
      "lines": "Нужна хотя бы одна линия, но не больше 20",
      "innRequired": "Укажите ИНН организации: на него выдаётся лицензия",
      "innChecksum": "Неверная контрольная цифра ИНН"
    },
    "innHint": "10 или 12 цифр. На этот ИНН выдаётся лицензия"
  },
```

(ключи `wizard.*` уникальны: проверить `grep -n '"innHint"' apps/standalone/src/i18n/ru.json` — две строки, `org.innHint` и `wizard.innHint`).

- [ ] **Step 6: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap --test device_shifts --test office_exports --test changes --test template_defaults --test office_reports --test feed_machine
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx test/app.test.tsx test/protocol.test.ts
```

Ожидается: PASS. Тест вебвью, который ищет прежнюю подсказку «Необязательно: 10 или 12 цифр» в мастере, — обновить на новый текст и записать.

- [ ] **Step 7: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/wizard/wizard-form.ts apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/wizard-form.test.ts apps/standalone/test/support/wizard.ts apps/standalone/proto/fixtures/bootstrap-request.json apps/standalone/proto/fixtures/bootstrap-request-templates.json
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/bootstrap.rs apps/standalone/host/tests/device_shifts.rs apps/standalone/host/tests/office_exports.rs apps/standalone/host/tests/changes.rs apps/standalone/host/tests/template_defaults.rs apps/standalone/host/tests/office_reports.rs apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/proto/fixtures/bootstrap-request.json apps/standalone/proto/fixtures/bootstrap-request-templates.json apps/standalone/src/wizard/wizard-form.ts apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/wizard-form.test.ts apps/standalone/test/support/wizard.ts
git commit -F - <<'EOF'
feat(standalone): the wizard requires an INN whose check digit holds and starts the 14-day trial (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Состояние лицензии — чистая функция `license/state.rs`

**Files:**

- Create: `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/license/state.rs`
- Modify: `apps/standalone/host/src/lib.rs`
- Test: модульные тесты в `apps/standalone/host/src/license/state.rs`

**Interfaces:**

- Consumes: `crate::inn::normalize` (ЛЦ-1), `markiro_proto::license::states` (задача 1).
- Produces: `license::state::{DAY_MS, TRIAL_DAYS, WRONG_HOST_DAYS, EMERGENCY_MS, MAX_WARN_DAYS, TRIAL_KEY, Phase, Quotas, Features, StoredLicense, Trial, Inputs, Evaluation, warn_days, days_until, effective, inn_matches, evaluate}`.

- [ ] **Step 1: Модуль с падающими тестами**

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент:

```rust
pub mod install_windows;
pub mod logging;
```

заменить на:

```rust
pub mod install_windows;
pub mod license;
pub mod logging;
```

Создать `apps/standalone/host/src/license/mod.rs`:

```rust
//! The site's license (plan ЛЦ-2, spec 2026-10-13 §3, §4, §7, §8): the files
//! the office loads, the state the host computes from them and the time it
//! trusts, and the gates of new shifts, seats and features. Only the host
//! decides the state; devices read it (`GET /v1/device`).

pub mod state;
```

Создать `apps/standalone/host/src/license/state.rs` с телом из шага 3 и тестами:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const OTHER_HOST: &str = "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f";
    /// A valid INN: its check digit holds.
    const INN: &str = "7707083893";
    /// 2026-09-21T14:13:20Z, the manual clock's start in the host's tests.
    const T0: i64 = 1_790_000_000_000;

    fn day(n: i64) -> i64 {
        T0 + n * DAY_MS
    }

    fn file(sequence: i64, from: i64, until: i64, grace: i64) -> StoredLicense {
        StoredLicense {
            license_id: format!("6d1f0a52-3c4b-4e8f-9a1d-{sequence:012}"),
            sequence,
            kid: "test-lic-1".to_owned(),
            host_id: HOST.to_owned(),
            issued_at: from,
            valid_from: from,
            valid_until: until,
            grace_days: grace,
            plan: "subscription".to_owned(),
            plan_version_id: "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4".to_owned(),
            customer_name: "ООО «Атолл»".to_owned(),
            customer_inn: INN.to_owned(),
            quotas: Quotas {
                stations: Some(3),
                ..Quotas::default()
            },
            features: Features {
                pallets: false,
                ..Features::ALL
            },
        }
    }

    fn inputs<'a>(now: i64, licenses: &'a [StoredLicense]) -> Inputs<'a> {
        Inputs {
            now,
            host_id: HOST,
            org_inn: Some(INN),
            licenses,
            trial_started_at: Some(T0),
            wrong_host_since: None,
            inn_mismatch_since: None,
            emergency: None,
        }
    }

    fn at(now: i64, licenses: &[StoredLicense]) -> Evaluation {
        evaluate(&inputs(now, licenses))
    }

    #[test]
    fn the_trial_runs_fourteen_days_from_the_wizard_without_grace() {
        let first = at(day(0), &[]);
        assert_eq!(
            (first.phase, first.since, first.phase_ends_at, first.days_left, first.warn_days),
            (Phase::Trial, T0, Some(day(14)), Some(14), 4)
        );
        assert_eq!(first.trial, Some(Trial { started_at: T0, ends_at: day(14) }));
        assert_eq!((first.quotas, first.features), (Quotas::default(), Features::ALL));
        assert!(first.opens_new_shifts && first.license.is_none() && first.inn_matches.is_none());
        assert_eq!(at(day(14) - 1, &[]).days_left, Some(1));
        let over = at(day(14), &[]);
        assert_eq!((over.phase, over.since, over.phase_ends_at), (Phase::TrialExpired, day(14), None));
        assert!(!over.opens_new_shifts && over.emergency_available);
        assert_eq!(over.emergency_key, TRIAL_KEY);
    }

    #[test]
    fn the_warning_is_a_third_of_the_term_and_at_most_thirty_days() {
        assert_eq!(warn_days(365 * DAY_MS), 30);
        assert_eq!(warn_days(30 * DAY_MS), 10);
        assert_eq!(warn_days(14 * DAY_MS), 4);
        assert_eq!(warn_days(2 * DAY_MS), 0);
    }

    #[test]
    fn a_year_runs_active_then_expiring_then_grace_then_restricted() {
        let files = [file(1, day(0), day(365), 14)];
        let steps = [
            (day(0), Phase::Active, day(0), Some(day(335)), Some(365)),
            (day(335) - 1, Phase::Active, day(0), Some(day(335)), Some(31)),
            (day(335), Phase::Expiring, day(335), Some(day(365)), Some(30)),
            (day(365) - 1, Phase::Expiring, day(335), Some(day(365)), Some(1)),
            // `validUntil` is exclusive.
            (day(365), Phase::Grace, day(365), Some(day(379)), Some(14)),
            (day(379), Phase::Restricted, day(379), None, None),
        ];
        for (now, phase, since, ends, days_left) in steps {
            let evaluation = at(now, &files);
            assert_eq!(
                (evaluation.phase, evaluation.since, evaluation.phase_ends_at, evaluation.days_left),
                (phase, since, ends, days_left),
                "at {now}"
            );
            assert_eq!(evaluation.quotas.stations, Some(3));
            assert!(!evaluation.features.pallets);
            assert_eq!(evaluation.inn_matches, Some(true));
            assert_eq!(evaluation.opens_new_shifts, phase != Phase::Restricted);
        }
    }

    #[test]
    fn without_grace_the_end_restricts_at_once() {
        let demo = [file(1, day(0), day(14), 0)];
        assert_eq!(at(day(9), &demo).phase, Phase::Active);
        assert_eq!(at(day(10), &demo).phase, Phase::Expiring);
        let ended = at(day(14), &demo);
        assert_eq!((ended.phase, ended.since), (Phase::Restricted, day(14)));
    }

    #[test]
    fn a_file_waits_for_its_start_and_the_highest_sequence_that_began_wins() {
        let waiting = [file(1, day(5), day(365), 14)];
        assert_eq!(at(day(1), &waiting).phase, Phase::Trial);
        assert_eq!(at(day(5), &waiting).phase, Phase::Active);
        let both = [file(1, day(0), day(365), 14), file(2, day(30), day(60), 0)];
        assert_eq!(at(day(10), &both).license.map(|license| license.sequence), Some(1));
        assert_eq!(at(day(30), &both).license.map(|license| license.sequence), Some(2));
        // A newer, shorter file ends the site's term, though the older one runs.
        assert_eq!(at(day(60), &both).phase, Phase::Restricted);
    }

    #[test]
    fn a_file_of_another_host_keeps_thirty_days_from_when_it_was_seen() {
        let mut foreign = file(1, day(0), day(365), 14);
        foreign.host_id = OTHER_HOST.to_owned();
        let files = [foreign];
        let seen = at(day(3), &files);
        assert_eq!(
            (seen.phase, seen.since, seen.phase_ends_at, seen.wrong_host_since),
            (Phase::WrongHost, day(3), Some(day(33)), Some(day(3)))
        );
        assert!(seen.opens_new_shifts);
        let later = evaluate(&Inputs {
            wrong_host_since: Some(day(3)),
            ..inputs(day(33), &files)
        });
        assert_eq!(
            (later.phase, later.since, later.wrong_host_since),
            (Phase::Restricted, day(33), Some(day(3)))
        );
        assert_eq!(at(day(3), &[file(1, day(0), day(365), 14)]).wrong_host_since, None);
    }

    #[test]
    fn an_inn_that_differs_fails_its_check_digit_or_is_missing_restricts() {
        let files = [file(1, day(0), day(365), 14)];
        for org in [Some("7701234560"), Some("7707083894"), Some(""), None] {
            let evaluation = evaluate(&Inputs {
                org_inn: org,
                ..inputs(day(1), &files)
            });
            assert_eq!(
                (evaluation.phase, evaluation.since, evaluation.inn_matches),
                (Phase::InnMismatch, day(1), Some(false)),
                "{org:?}"
            );
            assert!(!evaluation.opens_new_shifts);
        }
        let since = evaluate(&Inputs {
            org_inn: Some("7701234560"),
            inn_mismatch_since: Some(day(0)),
            ..inputs(day(1), &files)
        });
        assert_eq!(since.since, day(0));
        let spaced = evaluate(&Inputs {
            org_inn: Some(" 7707083893 "),
            ..inputs(day(1), &files)
        });
        assert_eq!(spaced.phase, Phase::Active);
    }

    #[test]
    fn the_emergency_opens_new_shifts_for_72_hours_once_per_file() {
        let files = [file(1, day(0), day(10), 0)];
        let key = files[0].license_id.clone();
        let restricted = at(day(11), &files);
        assert!(restricted.emergency_available && !restricted.emergency_used);
        let running = evaluate(&Inputs {
            emergency: Some((key.as_str(), day(11) + EMERGENCY_MS)),
            ..inputs(day(11), &files)
        });
        assert_eq!(running.phase, Phase::Restricted);
        assert!(running.opens_new_shifts && running.emergency_used && !running.emergency_available);
        assert_eq!(running.emergency_until, Some(day(11) + EMERGENCY_MS));
        let spent = evaluate(&Inputs {
            emergency: Some((key.as_str(), day(11) + EMERGENCY_MS)),
            ..inputs(day(11) + EMERGENCY_MS, &files)
        });
        assert!(!spent.opens_new_shifts && spent.emergency_used && !spent.emergency_available);
        // The trial's emergency is not the file's.
        let trial_used = evaluate(&Inputs {
            emergency: Some((TRIAL_KEY, day(12))),
            ..inputs(day(11), &files)
        });
        assert!(!trial_used.emergency_used && trial_used.emergency_available);
        // A state that opens new shifts needs none.
        assert!(!at(day(1), &files).emergency_available);
    }
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib license::state
```

Ожидается: ошибка компиляции (тело модуля ещё не написано: нет `evaluate`, `Phase` и прочего).

- [ ] **Step 3: Реализация**

Тело `apps/standalone/host/src/license/state.rs` (перед модулем тестов):

```rust
//! The license state as a pure function (plan ЛЦ-2, spec 2026-10-13 §3.2,
//! §3.4, §3.5, §4.6–§4.9): the stored files, the trial's start, the time the
//! host trusts and the organization's INN in, the state out. No I/O and no
//! clock of its own, so a test moves the time instead of waiting.

use markiro_proto::license::states;
use serde::{Deserialize, Serialize};

/// One day in the file's unit (milliseconds).
pub const DAY_MS: i64 = 86_400_000;
/// The built-in trial: 14 days from the wizard, without grace (§3.4).
pub const TRIAL_DAYS: i64 = 14;
/// How long a file issued to another host keeps everything open (§4.6).
pub const WRONG_HOST_DAYS: i64 = 30;
/// The emergency extension: 72 hours, once per file and once for the trial (§3.5).
pub const EMERGENCY_MS: i64 = 72 * 60 * 60 * 1000;
/// The longest warning, whatever the term (§3.2).
pub const MAX_WARN_DAYS: i64 = 30;
/// What the emergency extension of the built-in trial is recorded under.
pub const TRIAL_KEY: &str = "trial";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Trial,
    Active,
    Expiring,
    Grace,
    Restricted,
    WrongHost,
    InnMismatch,
    TrialExpired,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Trial => states::TRIAL,
            Phase::Active => states::ACTIVE,
            Phase::Expiring => states::EXPIRING,
            Phase::Grace => states::GRACE,
            Phase::Restricted => states::RESTRICTED,
            Phase::WrongHost => states::WRONG_HOST,
            Phase::InnMismatch => states::INN_MISMATCH,
            Phase::TrialExpired => states::TRIAL_EXPIRED,
        }
    }

    /// New shifts open (a planned one entered for the first time, one a
    /// station creates) in every state but these three (§3.3).
    pub fn opens_new_shifts(self) -> bool {
        !matches!(
            self,
            Phase::Restricted | Phase::InnMismatch | Phase::TrialExpired
        )
    }
}

/// The file's quotas; `None` is no limit, as in the cloud.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quotas {
    pub lines: Option<u32>,
    pub stations: Option<u32>,
    pub kiosks: Option<u32>,
    pub cabinet_users: Option<u32>,
}

/// The file's features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Features {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
}

impl Features {
    /// The built-in trial's: every feature.
    pub const ALL: Features = Features {
        label_editor: true,
        public_api: true,
        pallets: true,
        chz_integration: true,
        inventory: true,
        commerce_ml: true,
        handheld: true,
    };
}

/// A stored license file: the verified payload's fields, times in ms UTC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLicense {
    pub license_id: String,
    pub sequence: i64,
    pub kid: String,
    pub host_id: String,
    pub issued_at: i64,
    pub valid_from: i64,
    /// Exclusive.
    pub valid_until: i64,
    pub grace_days: i64,
    /// `demo` or `subscription`.
    pub plan: String,
    pub plan_version_id: String,
    pub customer_name: String,
    pub customer_inn: String,
    pub quotas: Quotas,
    pub features: Features,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trial {
    pub started_at: i64,
    pub ends_at: i64,
}

/// What the state is computed from.
pub struct Inputs<'a> {
    /// The effective time (`clock.rs`), ms UTC.
    pub now: i64,
    pub host_id: &'a str,
    /// `org_profile.inn` as stored; `None` without one.
    pub org_inn: Option<&'a str>,
    pub licenses: &'a [StoredLicense],
    /// The earlier of the database's and the registry's start (§3.4).
    pub trial_started_at: Option<i64>,
    /// When a file of another host was first seen in force.
    pub wrong_host_since: Option<i64>,
    /// When the INN stopped matching, as the last `license.state` row says.
    pub inn_mismatch_since: Option<i64>,
    /// `license_clock.emergency_used_for` and `emergency_until`.
    pub emergency: Option<(&'a str, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub phase: Phase,
    /// When this state began, as far as the host knows.
    pub since: i64,
    /// When it ends by time; `None` for a state that only a file or an INN ends.
    pub phase_ends_at: Option<i64>,
    /// Whole days, rounded up, until the file's or the trial's end (or the
    /// end of the grace or of the wrong host's window).
    pub days_left: Option<u32>,
    pub warn_days: u32,
    /// The file in force: the highest `sequence` whose start came.
    pub license: Option<StoredLicense>,
    pub trial: Option<Trial>,
    pub quotas: Quotas,
    pub features: Features,
    /// Whether the organization's INN is the file's; `None` without a file.
    pub inn_matches: Option<bool>,
    /// The file's id, or [`TRIAL_KEY`].
    pub emergency_key: String,
    pub emergency_used: bool,
    /// The end of an emergency extension that runs now.
    pub emergency_until: Option<i64>,
    pub emergency_available: bool,
    pub opens_new_shifts: bool,
    /// What `license_clock.wrong_host_since` should hold now.
    pub wrong_host_since: Option<i64>,
}

/// `min(30, ⌊term in days / 3⌋)` (§3.2, the owner's ЛО2).
pub fn warn_days(term_ms: i64) -> i64 {
    (term_ms.max(0) / DAY_MS / 3).min(MAX_WARN_DAYS)
}

/// Whole days until `end`, rounded up; 0 once it passed.
pub fn days_until(end: i64, now: i64) -> u32 {
    if end <= now {
        return 0;
    }
    u32::try_from((end - now + DAY_MS - 1) / DAY_MS).unwrap_or(u32::MAX)
}

/// The file in force at `now`: the highest `sequence` among those that began.
pub fn effective(licenses: &[StoredLicense], now: i64) -> Option<&StoredLicense> {
    licenses
        .iter()
        .filter(|license| license.valid_from <= now)
        .max_by_key(|license| license.sequence)
}

/// Both INNs normalized and checked by their check digit, then compared as
/// text (§4.9): an INN whose check digit fails equals nothing.
pub fn inn_matches(org: Option<&str>, file: &str) -> bool {
    match (org.and_then(crate::inn::normalize), crate::inn::normalize(file)) {
        (Some(org), Some(file)) => org == file,
        _ => false,
    }
}

struct Phased {
    phase: Phase,
    since: i64,
    ends: Option<i64>,
    days_left: Option<u32>,
}

fn of_trial(trial: Trial, now: i64) -> Phased {
    if now < trial.ends_at {
        Phased {
            phase: Phase::Trial,
            since: trial.started_at,
            ends: Some(trial.ends_at),
            days_left: Some(days_until(trial.ends_at, now)),
        }
    } else {
        Phased {
            phase: Phase::TrialExpired,
            since: trial.ends_at,
            ends: None,
            days_left: None,
        }
    }
}

fn of_term(file: &StoredLicense, warn: i64, now: i64) -> Phased {
    let expiring_from = file.valid_until - warn * DAY_MS;
    let grace_end = file.valid_until + file.grace_days * DAY_MS;
    if now < expiring_from {
        Phased {
            phase: Phase::Active,
            since: file.valid_from,
            ends: Some(expiring_from),
            days_left: Some(days_until(file.valid_until, now)),
        }
    } else if now < file.valid_until {
        Phased {
            phase: Phase::Expiring,
            since: expiring_from.max(file.valid_from),
            ends: Some(file.valid_until),
            days_left: Some(days_until(file.valid_until, now)),
        }
    } else if now < grace_end {
        Phased {
            phase: Phase::Grace,
            since: file.valid_until,
            ends: Some(grace_end),
            days_left: Some(days_until(grace_end, now)),
        }
    } else {
        Phased {
            phase: Phase::Restricted,
            since: grace_end,
            ends: None,
            days_left: None,
        }
    }
}

/// The state at `inputs.now` (§3.2): another host's file first, then the
/// INN, then the file's term; without a file in force, the trial.
pub fn evaluate(inputs: &Inputs<'_>) -> Evaluation {
    let now = inputs.now;
    let trial = inputs.trial_started_at.map(|started_at| Trial {
        started_at,
        ends_at: started_at + TRIAL_DAYS * DAY_MS,
    });
    let license = effective(inputs.licenses, now).cloned();
    let mut wrong_host_since = None;
    let (phased, warn, matched) = match &license {
        // Before the wizard there is no start yet: the trial counts from now.
        None => {
            let trial = trial.unwrap_or(Trial {
                started_at: now,
                ends_at: now + TRIAL_DAYS * DAY_MS,
            });
            (of_trial(trial, now), warn_days(TRIAL_DAYS * DAY_MS), None)
        }
        Some(file) => {
            let warn = warn_days(file.valid_until - file.valid_from);
            let matches = inn_matches(inputs.org_inn, &file.customer_inn);
            let phased = if file.host_id != inputs.host_id {
                let seen = inputs.wrong_host_since.unwrap_or(now);
                wrong_host_since = Some(seen);
                let ends = seen + WRONG_HOST_DAYS * DAY_MS;
                if now < ends {
                    Phased {
                        phase: Phase::WrongHost,
                        since: seen,
                        ends: Some(ends),
                        days_left: Some(days_until(ends, now)),
                    }
                } else {
                    Phased {
                        phase: Phase::Restricted,
                        since: ends,
                        ends: None,
                        days_left: None,
                    }
                }
            } else if !matches {
                Phased {
                    phase: Phase::InnMismatch,
                    since: inputs.inn_mismatch_since.unwrap_or(now),
                    ends: None,
                    days_left: None,
                }
            } else {
                of_term(file, warn, now)
            };
            (phased, warn, Some(matches))
        }
    };
    let emergency_key = license
        .as_ref()
        .map_or_else(|| TRIAL_KEY.to_owned(), |file| file.license_id.clone());
    let (emergency_used, emergency_until) = match inputs.emergency {
        Some((used_for, until)) if used_for == emergency_key => {
            (true, (now < until).then_some(until))
        }
        _ => (false, None),
    };
    let phase = phased.phase;
    Evaluation {
        phase,
        since: phased.since,
        phase_ends_at: phased.ends,
        days_left: phased.days_left,
        warn_days: u32::try_from(warn).unwrap_or(0),
        quotas: license
            .as_ref()
            .map_or_else(Quotas::default, |file| file.quotas),
        features: license.as_ref().map_or(Features::ALL, |file| file.features),
        license,
        trial,
        inn_matches: matched,
        emergency_key,
        emergency_used,
        emergency_until,
        emergency_available: !emergency_used && !phase.opens_new_shifts(),
        opens_new_shifts: phase.opens_new_shifts() || emergency_until.is_some(),
        wrong_host_since,
    }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib license::state
```

Ожидается: 8 тестов PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/lib.rs apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/state.rs
git commit -F - <<'EOF'
feat(standalone): the license state as a pure function of files, trial, time and INN (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Время лицензии — монотонные часы и отметка последнего известного времени

**Files:**

- Create: `apps/standalone/host/src/license/clock.rs`
- Modify: `apps/standalone/host/src/clock.rs`, `apps/standalone/host/src/license/mod.rs`
- Test: модульные тесты в `apps/standalone/host/src/clock.rs` и `apps/standalone/host/src/license/clock.rs`

**Interfaces:**

- Consumes: `license::state::DAY_MS`.
- Produces: `Clock::monotonic(&self) -> std::time::Duration` (новый обязательный метод; `SystemClock` — от первого вызова в процессе, `ManualClock` — сумма шагов `advance` вперёд); `ManualClock::move_wall(by)` — двигает только часы ПК; `license::clock::{RUNNING_SLACK_MS, START_JUMP_MS, BEHIND_FLAG_MS, AHEAD_FLAG_MS, PERSIST_EVERY_MS, Reading, LicenseClock}`.

- [ ] **Step 1: Падающие тесты**

Дописать в конец `apps/standalone/host/src/clock.rs`:

```rust
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_manual_clock_moves_its_monotonic_time_only_when_time_passes() {
        let clock = ManualClock::new(OffsetDateTime::UNIX_EPOCH);
        clock.advance(time::Duration::hours(2));
        assert_eq!(clock.monotonic(), Duration::from_secs(7200));
        // The PC's clock set back, or moved by a person: the process's time stays.
        clock.advance(time::Duration::hours(-3));
        clock.move_wall(time::Duration::days(400));
        assert_eq!(clock.monotonic(), Duration::from_secs(7200));
        assert_eq!(
            clock.now(),
            OffsetDateTime::UNIX_EPOCH - time::Duration::hours(1) + time::Duration::days(400)
        );
    }

    #[test]
    fn the_system_clocks_monotonic_time_never_goes_back() {
        let first = SystemClock.monotonic();
        let second = SystemClock.monotonic();
        assert!(second >= first);
    }
}
```

Правка `apps/standalone/host/src/license/mod.rs`:

Фрагмент:

```rust
pub mod state;
```

заменить на:

```rust
pub mod clock;
pub mod state;
```

Создать `apps/standalone/host/src/license/clock.rs` с телом из шага 3 и тестами:

```rust
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const T0: i64 = 1_790_000_000_000;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_first_start_trusts_the_pcs_clock() {
        let mut clock = LicenseClock::at_start(None, T0, secs(0), None);
        assert_eq!(
            clock.observe(T0, secs(0)),
            Reading { effective: T0, behind_ms: 0, ahead: false }
        );
        assert_eq!(clock.observe(T0 + 3_600_000, secs(3600)).effective, T0 + 3_600_000);
    }

    #[test]
    fn a_clock_set_back_two_days_moves_no_time_back_and_is_flagged() {
        let mut started = LicenseClock::at_start(Some(T0), T0 - 2 * DAY_MS, secs(0), None);
        let reading = started.observe(T0 - 2 * DAY_MS, secs(0));
        assert_eq!((reading.effective, reading.behind_days()), (T0, Some(2)));
        let mut running = LicenseClock::at_start(None, T0, secs(0), None);
        running.observe(T0 + 3_600_000, secs(3600));
        let reading = running.observe(T0 - 2 * DAY_MS + 3_600_000, secs(3601));
        assert_eq!((reading.effective, reading.behind_days()), (T0 + 3_600_000, Some(2)));
        // Within a day, a clock behind is no flag (summer time, NTP).
        let mut slightly = LicenseClock::at_start(Some(T0), T0 - 3_600_000, secs(0), None);
        assert_eq!(slightly.observe(T0 - 3_600_000, secs(0)).behind_days(), None);
    }

    #[test]
    fn a_jump_at_a_start_is_taken_up_to_400_days() {
        let mut taken = LicenseClock::at_start(Some(T0), T0 + 399 * DAY_MS, secs(0), None);
        let reading = taken.observe(T0 + 399 * DAY_MS, secs(0));
        assert_eq!((reading.effective, reading.ahead), (T0 + 399 * DAY_MS, false));
        let mut capped = LicenseClock::at_start(Some(T0), T0 + 402 * DAY_MS, secs(0), None);
        let reading = capped.observe(T0 + 402 * DAY_MS, secs(0));
        assert_eq!(
            (reading.effective, reading.ahead),
            (T0 + START_JUMP_MS + RUNNING_SLACK_MS, true)
        );
    }

    #[test]
    fn while_running_the_time_moves_no_faster_than_the_process() {
        let mut clock = LicenseClock::at_start(None, T0, secs(100), None);
        let reading = clock.observe(T0 + 365 * DAY_MS, secs(160));
        assert_eq!((reading.effective, reading.ahead), (T0 + 60_000 + RUNNING_SLACK_MS, true));
        // The clock put right: time runs with the process again.
        let mut fresh = LicenseClock::at_start(None, T0, secs(100), None);
        assert_eq!(fresh.observe(T0 + 7_200_000, secs(7300)).effective, T0 + 7_200_000);
    }

    #[test]
    fn a_files_issue_is_a_floor_of_the_time() {
        let mut clock = LicenseClock::at_start(None, T0, secs(0), Some(T0 + 10 * DAY_MS));
        let reading = clock.observe(T0, secs(0));
        assert_eq!((reading.effective, reading.behind_days()), (T0 + 10 * DAY_MS, Some(10)));
        clock.raise_floor(T0 + 20 * DAY_MS, secs(5));
        assert_eq!(clock.observe(T0 + 5000, secs(5)).effective, T0 + 20 * DAY_MS);
        assert_eq!(clock.mark(), T0 + 20 * DAY_MS);
    }

    #[test]
    fn the_days_behind_round_down_and_start_after_a_whole_day() {
        let reading = |behind_ms| Reading { effective: T0, behind_ms, ahead: false };
        assert_eq!(reading(DAY_MS).behind_days(), None);
        assert_eq!(reading(DAY_MS + 1).behind_days(), Some(1));
        assert_eq!(reading(3 * DAY_MS + 5).behind_days(), Some(3));
    }
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib clock::
```

Ожидается: ошибка компиляции (`monotonic`, `move_wall`, `LicenseClock` нет).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/clock.rs`:

Фрагмент:

```rust
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
```

заменить на:

```rust
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;

    /// Time since an arbitrary start that never goes back, whatever happens
    /// to the PC's clock: the license's time may run no faster (plan ЛЦ-2,
    /// spec 2026-10-13 §7).
    fn monotonic(&self) -> std::time::Duration;
}

/// The instant the process first asked for its monotonic time.
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// The real UTC clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    fn monotonic(&self) -> std::time::Duration {
        PROCESS_START
            .get_or_init(std::time::Instant::now)
            .elapsed()
    }
}

/// A clock that moves only when told to; for tests.
#[derive(Debug)]
pub struct ManualClock {
    now: Mutex<OffsetDateTime>,
    monotonic: Mutex<std::time::Duration>,
}

impl ManualClock {
    pub fn new(start: OffsetDateTime) -> Self {
        Self {
            now: Mutex::new(start),
            monotonic: Mutex::new(std::time::Duration::ZERO),
        }
    }

    /// Time passes: the PC's clock and the monotonic time move together. A
    /// negative step is the PC's clock set back, which leaves the monotonic
    /// time where it was.
    pub fn advance(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
        if let Ok(forward) = std::time::Duration::try_from(by) {
            *self.monotonic.lock().expect("clock lock") += forward;
        }
    }

    /// Move only the PC's clock, as a person who changes the date in
    /// Windows: no time passes for the process.
    pub fn move_wall(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.now.lock().expect("clock lock")
    }

    fn monotonic(&self) -> std::time::Duration {
        *self.monotonic.lock().expect("clock lock")
    }
}
```

Тело `apps/standalone/host/src/license/clock.rs` (перед модулем тестов):

```rust
//! The time the license trusts (plan ЛЦ-2, spec 2026-10-13 §7): the PC's
//! clock, never earlier than the last time the host knew, never further
//! ahead than the process's monotonic time allows while it runs, at most 400
//! days ahead of the last mark at a start, and never before a loaded file's
//! issue less a day. A clock set back only stops the license's time; a
//! clock set far ahead is flagged and not believed.

use std::time::Duration;

use super::state::DAY_MS;

/// How much faster than the process the PC's clock may run while the host
/// runs (NTP corrections, a person putting the clock right).
pub const RUNNING_SLACK_MS: i64 = 5 * 60 * 1000;
/// The longest jump of the PC's clock a start believes: a host switched off
/// for a holiday gets its time.
pub const START_JUMP_MS: i64 = 400 * DAY_MS;
/// A PC's clock behind the mark by more than this is flagged.
pub const BEHIND_FLAG_MS: i64 = DAY_MS;
/// A PC's clock ahead of the trusted time by more than this is flagged.
pub const AHEAD_FLAG_MS: i64 = DAY_MS;
/// How often the mark is written to the database at most, besides every
/// change of state.
pub const PERSIST_EVERY_MS: i64 = 60 * 60 * 1000;

/// One look at the time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    /// The time the license trusts, ms UTC.
    pub effective: i64,
    /// How far the PC's clock is behind it.
    pub behind_ms: i64,
    /// The PC's clock is more than a day ahead of it.
    pub ahead: bool,
}

impl Reading {
    /// Whole days the PC's clock is behind, once that is more than a day.
    pub fn behind_days(&self) -> Option<u32> {
        (self.behind_ms > BEHIND_FLAG_MS)
            .then(|| u32::try_from(self.behind_ms / DAY_MS).unwrap_or(u32::MAX).max(1))
    }
}

/// The mark in memory: the last effective time, and the anchor the
/// monotonic ceiling counts from.
#[derive(Debug, Clone)]
pub struct LicenseClock {
    mark: i64,
    anchor: i64,
    anchor_mono: Duration,
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl LicenseClock {
    /// At a start: `stored` is `license_clock.max_seen_at`, `wall` the PC's
    /// clock, `mono` the monotonic time, `floor` the newest file's issue less
    /// a day.
    pub fn at_start(stored: Option<i64>, wall: i64, mono: Duration, floor: Option<i64>) -> Self {
        let base = stored.unwrap_or(wall);
        let mut mark = if wall >= base {
            wall.min(base.saturating_add(START_JUMP_MS))
        } else {
            base
        };
        if let Some(floor) = floor {
            mark = mark.max(floor);
        }
        Self {
            mark,
            anchor: mark,
            anchor_mono: mono,
        }
    }

    /// The last effective time: what `license_clock.max_seen_at` gets.
    pub fn mark(&self) -> i64 {
        self.mark
    }

    /// The effective time now.
    pub fn observe(&mut self, wall: i64, mono: Duration) -> Reading {
        let ceiling = self
            .anchor
            .saturating_add(millis(mono.saturating_sub(self.anchor_mono)))
            .saturating_add(RUNNING_SLACK_MS);
        let effective = wall.min(ceiling).max(self.mark);
        if wall <= ceiling && wall >= self.mark {
            // The PC's clock is believable: the next ceiling counts from it,
            // so a monotonic clock that drifts from the PC's over weeks
            // changes nothing.
            self.anchor = effective;
            self.anchor_mono = mono;
        }
        self.mark = effective;
        Reading {
            effective,
            behind_ms: (effective - wall).max(0),
            ahead: wall - effective > AHEAD_FLAG_MS,
        }
    }

    /// A file loaded now proves the time is not before its issue less a day.
    pub fn raise_floor(&mut self, floor: i64, mono: Duration) {
        if floor > self.mark {
            self.mark = floor;
            self.anchor = floor;
            self.anchor_mono = mono;
        }
    }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib clock::
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker --test platform
```

Ожидается: PASS (`backup_worker.rs` двигает часы назад `advance(-3 h)` — монотонное время не трогается, поведение то же).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/clock.rs apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/clock.rs
git commit -F - <<'EOF'
feat(standalone): the license's time — monotonic clock, the last known time, 400 days at a start (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Служба лицензии, `GET /v1/office/license` и запрос активации

**Files:**

- Create: `apps/standalone/host/src/license/store.rs`, `apps/standalone/host/src/license/seats.rs`, `apps/standalone/host/src/license/trial_mark.rs`, `apps/standalone/host/src/license/routes.rs`, `apps/standalone/host/tests/support/license.rs`
- Modify: `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/support/mod.rs`
- Test: `apps/standalone/host/tests/license_office.rs`

**Interfaces:**

- Consumes: `state::evaluate`, `clock::LicenseClock` (задачи 4–5); `markiro_proto::trust::{license_keyset, Keyset, verify_license, ActivationRequest}` (ЛЦ-1); `OfficeContext`, `AppState`.
- Produces: `license::{to_ms, ms_text, Snapshot, LicenseService}` (`new`, `keyset`, `snapshot`, `office_license_now`); `license::store::{StoredLicense чтение, ClockRow, licenses, clock_row, org_inn, insert, persist_mark, set_state, set_wrong_host_since, set_emergency}`; `license::seats::{Usage, usage, Quota, seat_of, over, over_any}`; `license::trial_mark::{TrialMark, Mark, NoMark}`; `license::routes::{get_license, activation_request, office_license, quotas_wire, features_wire}`; `AppState.license: Arc<LicenseService>`, `AppState::with_license`; маршруты `GET /v1/office/license` (каждая роль), `GET /v1/office/license/activation-request` (администратор); тестовые `TestApp::with_host_id`, `admin_on`, `support::license::{TEST_KID, INN, OTHER_INN, DAY_MS, START_MS, FIXTURE_HOST_ID, issuer, license_id, terms, sign, sign_with_kid, file, seed, text}`.

- [ ] **Step 1: Тестовая опора**

Правка `apps/standalone/host/tests/support/mod.rs`:

Фрагмент:

```rust
pub mod app;
pub mod backup;
```

заменить на:

```rust
pub mod app;
pub mod backup;
pub mod license;
```

Правка `apps/standalone/host/tests/support/app.rs`:

Фрагмент:

```rust
impl TestApp {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = markiro_host::db::open(&dir.path().join("host.db"))
            .await
            .unwrap();
        let clock = Arc::new(ManualClock::new(
            time::OffsetDateTime::from_unix_timestamp(START).unwrap(),
        ));
        let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone())
```

заменить на:

```rust
impl TestApp {
    pub async fn new() -> Self {
        Self::with_host_id(&uuid::Uuid::new_v4().to_string()).await
    }

    /// A host whose `hostId` is `host_id`: the license fixtures of plan
    /// ЛЦ-1 are issued to one.
    pub async fn with_host_id(host_id: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = markiro_host::db::open(&dir.path().join("host.db"))
            .await
            .unwrap();
        let clock = Arc::new(ManualClock::new(
            time::OffsetDateTime::from_unix_timestamp(START).unwrap(),
        ));
        let state = AppState::new(pool, host_id.to_owned(), clock.clone())
```

Фрагмент:

```rust
pub async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
```

заменить на:

```rust
pub async fn admin() -> Admin {
    admin_of(TestApp::new().await).await
}

/// `admin()` on a host whose `hostId` is `host_id`.
pub async fn admin_on(host_id: &str) -> Admin {
    admin_of(TestApp::with_host_id(host_id).await).await
}

async fn admin_of(app: TestApp) -> Admin {
    let (_, key) = pair_device(&app, "station").await;
```

Создать `apps/standalone/host/tests/support/license.rs`:

```rust
//! License files for the host's tests (plan ЛЦ-2). The TEST key of
//! `packages/domain/fixtures/standalone-license/test-private-keys.json`
//! (plan ЛЦ-1) signs any payload, so a test picks its own terms, host and
//! INN relative to the manual clock's start. Never a real key.

use axum::http::StatusCode;
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use super::app::{Admin, TestApp, START};

/// The kid of the test license key.
pub const TEST_KID: &str = "test-lic-1";
/// The organization's INN in `bootstrap_body` (its check digit holds).
pub const INN: &str = "7707083893";
/// Another INN whose check digit holds: weights 2,4,10,3,5,9,4,6,8 over
/// 770123456 give 176, and 176 mod 11 mod 10 is 0.
pub const OTHER_INN: &str = "7701234560";
pub const DAY_MS: i64 = 86_400_000;
/// The manual clock's start in milliseconds.
pub const START_MS: i64 = START * 1000;
/// The host the license fixtures of plan ЛЦ-1 are issued to.
pub const FIXTURE_HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

fn domain_fixture(name: &str) -> String {
    let path = format!(
        "{}/../../../packages/domain/fixtures/standalone-license/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

/// A license fixture of plan ЛЦ-1 (`license-subscription.jws`, …).
pub fn fixture_file(name: &str) -> String {
    domain_fixture(name).trim().to_owned()
}

/// The private JWK of `kid`, wherever the fixture file holds it.
fn private_jwk(kid: &str) -> Value {
    fn find(value: &Value, kid: &str) -> Option<Value> {
        match value {
            Value::Object(map) => {
                if map.get("kid").and_then(Value::as_str) == Some(kid) {
                    let jwk = map.get("jwk").unwrap_or(value);
                    if jwk.get("d").is_some() {
                        return Some(jwk.clone());
                    }
                }
                map.values().find_map(|inner| find(inner, kid))
            }
            Value::Array(items) => items.iter().find_map(|inner| find(inner, kid)),
            _ => None,
        }
    }
    let keys: Value = serde_json::from_str(&domain_fixture("test-private-keys.json")).unwrap();
    find(&keys, kid).unwrap_or_else(|| panic!("no private key {kid} in test-private-keys.json"))
}

/// `payload` signed by the test license key under the header's `kid`.
pub fn sign_with_kid(payload: &Value, kid: &str) -> String {
    let jwk = private_jwk(TEST_KID);
    let decode = |field: &str| URL_SAFE_NO_PAD.decode(jwk[field].as_str().unwrap()).unwrap();
    let mut public = vec![4u8];
    public.extend(decode("x"));
    public.extend(decode("y"));
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &decode("d"),
        &public,
    )
    .unwrap();
    // The header's bytes as the format writes them: `typ`, `alg`, `kid`.
    let header = format!(
        r#"{{"typ":"markiro-standalone-license+jws","alg":"ES256","kid":"{kid}"}}"#
    );
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    let signature = pair
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .unwrap();
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

/// `payload` signed by the test license key.
pub fn sign(payload: &Value) -> String {
    sign_with_kid(payload, TEST_KID)
}

/// The issuer the test keyset trusts.
pub fn issuer() -> String {
    markiro_proto::trust::license_keyset()
        .origin
        .expect("the test keyset names its origin")
}

/// The id of file `n`, a canonical UUID.
pub fn license_id(n: u32) -> String {
    format!("6d1f0a52-3c4b-4e8f-9a1d-{n:012}")
}

/// A year's subscription from the manual clock's start for `host_id`, issued
/// to `INN`, with every feature, no quota and 14 days of grace.
pub fn terms(host_id: &str) -> Value {
    json!({
        "version": 1,
        "licenseId": license_id(1),
        "sequence": 1,
        "issuer": issuer(),
        "tenantId": "11111111-2222-4333-8444-555555555555",
        "siteId": "66666666-7777-4888-9999-aaaaaaaaaaaa",
        "hostId": host_id,
        "customer": { "name": "ООО «Атолл»", "inn": INN },
        "plan": "subscription",
        "planVersionId": "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
        "entitlementRevision": "42",
        "issuedAt": START_MS,
        "validFrom": START_MS,
        "validUntil": START_MS + 365 * DAY_MS,
        "graceDays": 14,
        "quotas": { "lines": null, "stations": null, "kiosks": null, "cabinetUsers": null },
        "features": {
            "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
            "inventory": true, "commerceMl": true, "handheld": true
        },
        "replaces": null
    })
}

/// `terms(host_id)` changed by `edit`, signed.
pub fn file(host_id: &str, edit: impl FnOnce(&mut Value)) -> String {
    let mut payload = terms(host_id);
    edit(&mut payload);
    sign(&payload)
}

/// The host's timestamp text of `ms`.
pub fn text(ms: i64) -> String {
    markiro_host::license::ms_text(ms)
}

/// Put the file of `payload` straight into `licenses`, as a load would.
pub async fn seed(app: &TestApp, payload: &Value) {
    sqlx::query(
        "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, issued_at, \
         valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
         customer_inn, quotas, features, loaded_at, loaded_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(payload["licenseId"].as_str().unwrap())
    .bind(payload["sequence"].as_i64().unwrap())
    .bind(sign(payload))
    .bind(TEST_KID)
    .bind(payload["hostId"].as_str().unwrap())
    .bind(payload["issuedAt"].as_i64().unwrap())
    .bind(payload["validFrom"].as_i64().unwrap())
    .bind(payload["validUntil"].as_i64().unwrap())
    .bind(payload["graceDays"].as_i64().unwrap())
    .bind(payload["plan"].as_str().unwrap())
    .bind(payload["planVersionId"].as_str().unwrap())
    .bind(payload["customer"]["name"].as_str().unwrap())
    .bind(payload["customer"]["inn"].as_str().unwrap())
    .bind(payload["quotas"].to_string())
    .bind(payload["features"].to_string())
    .bind(app.state.timestamp())
    .execute(&app.state.pool)
    .await
    .unwrap();
}

/// `PUT /v1/office/license` as the administrator.
pub async fn load(admin: &Admin, file: &str) -> (StatusCode, Value) {
    admin
        .call("PUT", "/v1/office/license", Some(json!({ "file": file })))
        .await
}

/// `load`, which must be accepted; returns the answer.
pub async fn load_ok(admin: &Admin, file: &str) -> Value {
    let (status, body) = load(admin, file).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// `POST /v1/office/license/preview` as the administrator.
pub async fn preview(admin: &Admin, file: &str) -> (StatusCode, Value) {
    admin
        .call("POST", "/v1/office/license/preview", Some(json!({ "file": file })))
        .await
}

/// The office's `GET /v1/office/license` as the administrator.
pub async fn office_license(admin: &Admin) -> Value {
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Claim a pairing code from the LAN as a device of `kind`; the status and
/// the body.
pub async fn claim_device(admin: &Admin, code: &Value, kind: &str) -> (StatusCode, Value) {
    admin
        .app
        .send_from(
            super::app::LAN,
            super::app::json(
                super::app::request("POST", "/v1/pairing/claim"),
                json!({ "code": code["code"], "kind": kind, "name": "Устройство в сети",
                    "appVersion": "1.2.0", "capabilities": [] }),
            ),
        )
        .await
}

/// A new pairing code from the administrator.
pub async fn pairing_code(admin: &Admin) -> Value {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    code
}
```

(Помощник `refresh` зовёт `LicenseService::refresh` задачи 8, а опора компилируется в каждом тестовом бинарнике: до задачи 8 его в файле нет — он добавляется шагом 1 задачи 8. Остальные помощники ходят HTTP и компилируются сразу; маршруты, которые они зовут, появляются в задачах 7 и 10.)

- [ ] **Step 2: Падающие тесты**

Создать `apps/standalone/host/tests/license_office.rs`:

```rust
//! The office's view of the license (plan ЛЦ-2, spec §8.2): `GET
//! /v1/office/license` for every role, the activation request for the
//! administrator, and the test keys of plan ЛЦ-1 the other license tests sign
//! with.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, test_fingerprint, with_device};
use support::license::{
    file, issuer, license_id, seed, terms, text, DAY_MS, INN, START_MS, TEST_KID,
};

fn all_features() -> Value {
    json!({
        "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
        "inventory": true, "commerceMl": true, "handheld": true
    })
}

fn unlimited(lines: u32, stations: u32, cabinet_users: u32) -> Value {
    json!({
        "lines": { "limit": null, "used": lines, "over": false },
        "stations": { "limit": null, "used": stations, "over": false },
        "kiosks": { "limit": null, "used": 0, "over": false },
        "cabinetUsers": { "limit": null, "used": cabinet_users, "over": false }
    })
}

#[test]
fn the_test_keys_sign_files_the_trust_module_accepts() {
    let keyset = markiro_proto::trust::license_keyset();
    assert!(keyset.keys.iter().any(|key| key.kid == TEST_KID));
    assert_eq!(keyset.origin.as_deref(), Some(issuer().as_str()));
    let (_, kid) =
        markiro_proto::trust::verify_license(&file(support::license::FIXTURE_HOST_ID, |_| {}), &keyset)
            .unwrap();
    assert_eq!(kid, TEST_KID);
}

#[tokio::test]
async fn a_new_site_reads_its_trial_its_seats_and_its_binding() {
    let admin = admin().await;
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "state": "trial",
            "since": text(START_MS),
            "flags": { "clockBehindDays": null, "clockAhead": false },
            "effectiveAt": text(START_MS),
            "phaseEndsAt": text(START_MS + 14 * DAY_MS),
            "daysLeft": 14,
            "warnDays": 4,
            "opensNewShifts": true,
            "license": null,
            "trial": {
                "startedAt": text(START_MS),
                "endsAt": text(START_MS + 14 * DAY_MS),
                "inn": INN
            },
            "binding": {
                "hostId": admin.app.state.host_id,
                "fingerprint": test_fingerprint(),
                "orgInn": INN,
                "innMatches": null
            },
            // The wizard's two lines, the station that ran it, the administrator.
            "quotas": unlimited(2, 1, 1),
            "features": all_features(),
            "emergency": { "available": false, "until": null }
        })
    );
}

#[tokio::test]
async fn every_office_role_reads_it_and_a_device_key_alone_does_not() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, body) = admin.call_as(&tech, "GET", "/v1/office/license", None).await;
    assert_eq!((status, body["state"].clone()), (StatusCode::OK, json!("trial")));
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/license"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
}

#[tokio::test]
async fn a_stored_file_is_read_with_its_term_seats_and_features() {
    let admin = admin().await;
    let mut payload = terms(&admin.app.state.host_id);
    payload["quotas"]["stations"] = json!(3);
    payload["features"]["pallets"] = json!(false);
    seed(&admin.app, &payload).await;
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["state"].clone(),
            body["since"].clone(),
            body["phaseEndsAt"].clone(),
            body["daysLeft"].clone(),
            body["warnDays"].clone()
        ),
        (
            json!("active"),
            json!(text(START_MS)),
            json!(text(START_MS + 335 * DAY_MS)),
            json!(365),
            json!(30)
        )
    );
    assert_eq!(
        body["license"],
        json!({
            "licenseId": license_id(1),
            "sequence": 1,
            "kid": TEST_KID,
            "customer": { "name": "ООО «Атолл»", "inn": INN },
            "plan": "subscription",
            "planVersionId": "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
            "issuedAt": text(START_MS),
            "validFrom": text(START_MS),
            "validUntil": text(START_MS + 365 * DAY_MS),
            "graceDays": 14
        })
    );
    assert_eq!(body["binding"]["innMatches"], true);
    assert_eq!(
        body["quotas"]["stations"],
        json!({ "limit": 3, "used": 1, "over": false })
    );
    assert_eq!(body["features"]["pallets"], false);
    // The trial is still told: its start goes into the activation request.
    assert_eq!(body["trial"]["startedAt"], text(START_MS));
}

#[tokio::test]
async fn the_activation_request_names_the_host_the_organization_the_trial_and_the_usage() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(&tech, "GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "format": "markiro-activation-request-v1",
            "hostId": admin.app.state.host_id,
            "hostFingerprint": test_fingerprint(),
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "organization": { "name": "ООО «Атолл»", "inn": INN },
            "trial": { "startedAt": text(START_MS), "inn": INN },
            "currentLicense": null,
            // The technologist made above is a second office user.
            "usage": { "stations": 1, "cabinetUsers": 2, "lines": 2 },
            "createdAt": text(START_MS)
        })
    );
    serde_json::from_value::<markiro_proto::trust::ActivationRequest>(body.clone())
        .expect("plan ЛЦ-1's type reads it");
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/domain/fixtures/standalone-license/activation-request.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let keys = |value: &Value| {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&body), keys(&fixture));
    seed(&admin.app, &terms(&admin.app.state.host_id)).await;
    let (_, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(
        body["currentLicense"],
        json!({ "licenseId": license_id(1), "sequence": 1 })
    );
}
```

- [ ] **Step 3: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_office
```

Ожидается: ошибка компиляции (`markiro_host::license::ms_text`, `TestApp::with_host_id` пока нет — опора уже есть, маршрутов нет); после шага 4 — PASS. Помощника `refresh` в опоре до задачи 8 нет (см. шаг 1).

- [ ] **Step 4: Реализация**

Правка `apps/standalone/host/src/license/mod.rs` — заменить файл целиком:

```rust
//! The site's license (plan ЛЦ-2, spec 2026-10-13 §3, §4, §7, §8): the files
//! the office loads, the state the host computes from them and the time it
//! trusts, and the gates of new shifts, seats and features. Only the host
//! decides the state; devices read it (`GET /v1/device`).

pub mod clock;
pub mod routes;
pub mod seats;
pub mod state;
pub mod store;
pub mod trial_mark;

use std::sync::{Arc, Mutex};

use markiro_proto::license::OfficeLicense;
use markiro_proto::trust::Keyset;
use sqlx::SqliteConnection;
use time::OffsetDateTime;

use self::state::{Evaluation, Inputs, Phase, StoredLicense};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::server::AppState;

/// Milliseconds since the Unix epoch, as the file counts time.
pub fn to_ms(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// The host's timestamp text of `ms` (UTC, whole seconds).
pub fn ms_text(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format_timestamp(at)
}

/// What the host knows of its license at one moment.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub evaluation: Evaluation,
    pub reading: clock::Reading,
    /// Every stored file, by `sequence`.
    pub licenses: Vec<StoredLicense>,
    pub clock_row: store::ClockRow,
    pub org_inn: Option<String>,
}

/// The license of this host: the keys it trusts, the trial's mark in the
/// registry, and the time it trusts, kept in memory between requests.
pub struct LicenseService {
    keyset: Keyset,
    mark: Arc<dyn trial_mark::TrialMark>,
    clock: Mutex<Option<clock::LicenseClock>>,
    /// The registry's start of the trial, read once at a start.
    registry_started_at: Mutex<Option<i64>>,
}

impl LicenseService {
    pub fn new(keyset: Keyset, mark: Arc<dyn trial_mark::TrialMark>) -> Self {
        Self {
            keyset,
            mark,
            clock: Mutex::new(None),
            registry_started_at: Mutex::new(None),
        }
    }

    /// The license keys this build trusts (`markiro_proto::trust`).
    pub fn keyset(&self) -> &Keyset {
        &self.keyset
    }

    /// The state now, read on `conn` (a writer's transaction or a reader's).
    /// It writes nothing: only the time in memory moves.
    pub async fn snapshot(
        &self,
        app: &AppState,
        conn: &mut SqliteConnection,
    ) -> Result<Snapshot, sqlx::Error> {
        let licenses = store::licenses(&mut *conn).await?;
        let clock_row = store::clock_row(&mut *conn).await?;
        let org_inn = store::org_inn(&mut *conn).await?;
        let wall = to_ms(app.now());
        let mono = app.clock.monotonic();
        let reading = {
            let mut guard = self.clock.lock().expect("license clock lock");
            let clock = guard.get_or_insert_with(|| {
                let floor = licenses
                    .iter()
                    .map(|license| license.issued_at - state::DAY_MS)
                    .max();
                clock::LicenseClock::at_start(clock_row.max_seen_at, wall, mono, floor)
            });
            clock.observe(wall, mono)
        };
        let registry = *self
            .registry_started_at
            .lock()
            .expect("registry mark lock");
        let trial_started_at = match (clock_row.trial_started_at, registry) {
            (Some(stored), Some(marked)) => Some(stored.min(marked)),
            (stored, marked) => stored.or(marked),
        };
        let inn_mismatch_since = clock_row
            .last_state
            .as_deref()
            .filter(|last| *last == Phase::InnMismatch.as_str())
            .and(clock_row.last_state_at);
        let evaluation = state::evaluate(&Inputs {
            now: reading.effective,
            host_id: &app.host_id,
            org_inn: org_inn.as_deref(),
            licenses: &licenses,
            trial_started_at,
            wrong_host_since: clock_row.wrong_host_since,
            inn_mismatch_since,
            emergency: clock_row
                .emergency_used_for
                .as_deref()
                .zip(clock_row.emergency_until),
        });
        Ok(Snapshot {
            evaluation,
            reading,
            licenses,
            clock_row,
            org_inn,
        })
    }

    /// `GET /v1/office/license` as of now, read in one transaction.
    pub async fn office_license_now(&self, app: &AppState) -> Result<OfficeLicense, ApiError> {
        let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
        let snapshot = self
            .snapshot(app, &mut tx)
            .await
            .map_err(ApiError::internal)?;
        let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
        tx.rollback().await.map_err(ApiError::internal)?;
        Ok(routes::office_license(app, &snapshot, &usage))
    }
}
```

(`mark` читается с задачи 12; до неё поле не используется — если сборка предупреждает `field is never read`, добавить к полю `#[allow(dead_code)] // read by plan ЛЦ-2 task 12` и снять в задаче 12.)

Создать `apps/standalone/host/src/license/store.rs`:

```rust
//! The license's rows (migration `0030`): the files, append-only, and the one
//! row of the license clock. Plain reads and writes; the decisions are
//! `state.rs`'s and `mod.rs`'s.

use sqlx::SqliteConnection;

use super::state::StoredLicense;

/// `license_clock`, times in ms UTC.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClockRow {
    pub max_seen_at: Option<i64>,
    pub trial_started_at: Option<i64>,
    pub trial_inn: Option<String>,
    pub emergency_used_for: Option<String>,
    pub emergency_until: Option<i64>,
    pub wrong_host_since: Option<i64>,
    pub last_state: Option<String>,
    pub last_state_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct LicenseRow {
    license_id: String,
    sequence: i64,
    kid: String,
    host_id: String,
    issued_at: i64,
    valid_from: i64,
    valid_until: i64,
    grace_days: i64,
    plan: String,
    plan_version_id: String,
    customer_name: String,
    customer_inn: String,
    quotas: String,
    features: String,
}

fn decode(error: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(error))
}

/// Every stored file, by `sequence`.
pub async fn licenses(conn: &mut SqliteConnection) -> Result<Vec<StoredLicense>, sqlx::Error> {
    let rows: Vec<LicenseRow> = sqlx::query_as(
        "SELECT license_id, sequence, kid, host_id, issued_at, valid_from, valid_until, \
         grace_days, plan, plan_version_id, customer_name, customer_inn, quotas, features \
         FROM licenses ORDER BY sequence",
    )
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(StoredLicense {
                quotas: serde_json::from_str(&row.quotas).map_err(decode)?,
                features: serde_json::from_str(&row.features).map_err(decode)?,
                license_id: row.license_id,
                sequence: row.sequence,
                kid: row.kid,
                host_id: row.host_id,
                issued_at: row.issued_at,
                valid_from: row.valid_from,
                valid_until: row.valid_until,
                grace_days: row.grace_days,
                plan: row.plan,
                plan_version_id: row.plan_version_id,
                customer_name: row.customer_name,
                customer_inn: row.customer_inn,
            })
        })
        .collect()
}

pub async fn clock_row(conn: &mut SqliteConnection) -> Result<ClockRow, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let row: (
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until, \
         wrong_host_since, last_state, last_state_at FROM license_clock WHERE id = 1",
    )
    .fetch_one(conn)
    .await?;
    let (
        max_seen_at,
        trial_started_at,
        trial_inn,
        emergency_used_for,
        emergency_until,
        wrong_host_since,
        last_state,
        last_state_at,
    ) = row;
    Ok(ClockRow {
        max_seen_at,
        trial_started_at,
        trial_inn,
        emergency_used_for,
        emergency_until,
        wrong_host_since,
        last_state,
        last_state_at,
    })
}

/// The organization's INN as stored; `None` before the wizard or without one.
pub async fn org_inn(conn: &mut SqliteConnection) -> Result<Option<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar::<_, Option<String>>("SELECT inn FROM org_profile WHERE id = 1")
            .fetch_optional(conn)
            .await?
            .flatten(),
    )
}

/// Keep a verified file (spec §4.4); `compact` is its text.
pub async fn insert(
    conn: &mut SqliteConnection,
    license: &StoredLicense,
    compact: &str,
    loaded_at: &str,
    loaded_by: Option<&str>,
) -> Result<(), sqlx::Error> {
    let encode = |error: serde_json::Error| sqlx::Error::Encode(Box::new(error));
    sqlx::query(
        "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, issued_at, \
         valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
         customer_inn, quotas, features, loaded_at, loaded_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&license.license_id)
    .bind(license.sequence)
    .bind(compact)
    .bind(&license.kid)
    .bind(&license.host_id)
    .bind(license.issued_at)
    .bind(license.valid_from)
    .bind(license.valid_until)
    .bind(license.grace_days)
    .bind(&license.plan)
    .bind(&license.plan_version_id)
    .bind(&license.customer_name)
    .bind(&license.customer_inn)
    .bind(serde_json::to_string(&license.quotas).map_err(encode)?)
    .bind(serde_json::to_string(&license.features).map_err(encode)?)
    .bind(loaded_at)
    .bind(loaded_by)
    .execute(conn)
    .await?;
    Ok(())
}

/// Raise the stored mark to `mark` (never lower it).
pub async fn persist_mark(conn: &mut SqliteConnection, mark: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE license_clock SET max_seen_at = max(coalesce(max_seen_at, ?1), ?1) WHERE id = 1",
    )
    .bind(mark)
    .execute(conn)
    .await?;
    Ok(())
}

/// The state a `license.state` row (or the first look) named, and when; the mark with it.
pub async fn set_state(
    conn: &mut SqliteConnection,
    state: &str,
    at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE license_clock SET last_state = ?1, last_state_at = ?2, \
         max_seen_at = max(coalesce(max_seen_at, ?2), ?2) WHERE id = 1",
    )
    .bind(state)
    .bind(at)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn set_wrong_host_since(
    conn: &mut SqliteConnection,
    since: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE license_clock SET wrong_host_since = ? WHERE id = 1")
        .bind(since)
        .execute(conn)
        .await?;
    Ok(())
}

/// The emergency extension of `key` (a file's id or `trial`) until `until`.
pub async fn set_emergency(
    conn: &mut SqliteConnection,
    key: &str,
    until: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE license_clock SET emergency_used_for = ?, emergency_until = ? WHERE id = 1")
        .bind(key)
        .bind(until)
        .execute(conn)
        .await?;
    Ok(())
}
```

Создать `apps/standalone/host/src/license/seats.rs`:

```rust
//! The license's seats (spec §4.7): what the site uses of each quota. A
//! quota refuses an addition beyond the file and never what runs: a device,
//! a user or a line over the limit keeps working, and only new ones are
//! refused until enough are revoked, turned off or archived.

use markiro_proto::DeviceKind;
use sqlx::SqliteConnection;

use super::state::Quotas;

/// What the site uses of each quota.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub lines: u32,
    pub stations: u32,
    /// No kiosk in the standalone product yet: always 0.
    pub kiosks: u32,
    pub cabinet_users: u32,
}

/// Stations and handhelds not revoked (one pool, as in the cloud), active
/// office users (accounts, not PCs) and lines not archived.
pub async fn usage(conn: &mut SqliteConnection) -> Result<Usage, sqlx::Error> {
    let (stations, cabinet_users, lines): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL AND kind IN ('station', 'handheld')), \
         (SELECT COUNT(*) FROM office_users WHERE active = 1), \
         (SELECT COUNT(*) FROM lines WHERE archived = 0)",
    )
    .fetch_one(conn)
    .await?;
    let count = |n: i64| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Usage {
        lines: count(lines),
        stations: count(stations),
        kiosks: 0,
        cabinet_users: count(cabinet_users),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quota {
    Lines,
    Stations,
    Kiosks,
    CabinetUsers,
}

impl Quota {
    pub const ALL: [Quota; 4] = [
        Quota::Lines,
        Quota::Stations,
        Quota::Kiosks,
        Quota::CabinetUsers,
    ];

    /// The file's and the cloud's name.
    pub fn key(self) -> &'static str {
        match self {
            Quota::Lines => "lines",
            Quota::Stations => "stations",
            Quota::Kiosks => "kiosks",
            Quota::CabinetUsers => "cabinetUsers",
        }
    }

    pub fn limit(self, quotas: &Quotas) -> Option<u32> {
        match self {
            Quota::Lines => quotas.lines,
            Quota::Stations => quotas.stations,
            Quota::Kiosks => quotas.kiosks,
            Quota::CabinetUsers => quotas.cabinet_users,
        }
    }

    pub fn used(self, usage: &Usage) -> u32 {
        match self {
            Quota::Lines => usage.lines,
            Quota::Stations => usage.stations,
            Quota::Kiosks => usage.kiosks,
            Quota::CabinetUsers => usage.cabinet_users,
        }
    }
}

/// The quota a device of `kind` takes a seat of: stations and handhelds share
/// the cloud's `stations` pool (ЛО22); an office PC takes none, its seats are
/// its users.
pub fn seat_of(kind: DeviceKind) -> Option<Quota> {
    match kind {
        DeviceKind::Station | DeviceKind::Handheld => Some(Quota::Stations),
        DeviceKind::Office => None,
    }
}

/// The site uses more of `quota` than the file allows (a restore, a smaller file).
pub fn over(quota: Quota, quotas: &Quotas, usage: &Usage) -> bool {
    quota
        .limit(quotas)
        .is_some_and(|limit| quota.used(usage) > limit)
}

pub fn over_any(quotas: &Quotas, usage: &Usage) -> bool {
    Quota::ALL
        .iter()
        .any(|quota| over(*quota, quotas, usage))
}
```

Создать `apps/standalone/host/src/license/trial_mark.rs`:

```rust
//! The trial's mark outside the database (spec §3.4): on Windows, values in
//! `HKLM\SOFTWARE\Markiro\Standalone\Trial` that a reinstall and even a new
//! data folder do not take away (plan ЛЦ-2 task 12); elsewhere none. The
//! trial's start is the earlier of the database's and the mark's.

/// What the mark holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    /// ms UTC.
    pub started_at: i64,
    pub host_id: String,
    pub inn: Option<String>,
}

/// Where the mark lives. Calls block (an external program on Windows): the
/// service calls them off the async threads.
pub trait TrialMark: Send + Sync + 'static {
    /// The mark's start; `None` when there is none or it does not read.
    fn started_at(&self) -> Option<i64>;
    /// Write the mark's values. The caller writes only when there is none.
    fn write(&self, mark: &Mark) -> Result<(), String>;
}

/// No mark: other systems than Windows, and the tests that do not ask for one.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoMark;

impl TrialMark for NoMark {
    fn started_at(&self) -> Option<i64> {
        None
    }

    fn write(&self, _mark: &Mark) -> Result<(), String> {
        Ok(())
    }
}
```

Создать `apps/standalone/host/src/license/routes.rs`:

```rust
//! The license's routes (plan ЛЦ-2, spec §8.2) and the wire shapes they
//! answer with (`markiro_proto::license`).

use axum::extract::State;
use axum::Json;
use markiro_proto::license::{
    LicenseBinding, LicenseCustomer, LicenseEmergency, LicenseFeatures, LicenseFlags,
    LicenseQuotas, LicenseSummary, OfficeLicense, QuotaUse, TrialInfo,
};
use serde_json::{json, Value};

use super::seats::{self, Usage};
use super::state::{Features, Quotas, StoredLicense};
use super::{ms_text, Snapshot};
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

fn quota_use(limit: Option<u32>, used: u32) -> QuotaUse {
    QuotaUse {
        limit,
        used,
        over: limit.is_some_and(|limit| used > limit),
    }
}

pub fn quotas_wire(quotas: &Quotas, usage: &Usage) -> LicenseQuotas {
    LicenseQuotas {
        lines: quota_use(quotas.lines, usage.lines),
        stations: quota_use(quotas.stations, usage.stations),
        kiosks: quota_use(quotas.kiosks, usage.kiosks),
        cabinet_users: quota_use(quotas.cabinet_users, usage.cabinet_users),
    }
}

pub fn features_wire(features: &Features) -> LicenseFeatures {
    LicenseFeatures {
        label_editor: features.label_editor,
        public_api: features.public_api,
        pallets: features.pallets,
        chz_integration: features.chz_integration,
        inventory: features.inventory,
        commerce_ml: features.commerce_ml,
        handheld: features.handheld,
    }
}

fn summary(license: &StoredLicense) -> LicenseSummary {
    LicenseSummary {
        license_id: license.license_id.clone(),
        sequence: u64::try_from(license.sequence).unwrap_or(0),
        kid: license.kid.clone(),
        customer: LicenseCustomer {
            name: license.customer_name.clone(),
            inn: license.customer_inn.clone(),
        },
        plan: license.plan.clone(),
        plan_version_id: license.plan_version_id.clone(),
        issued_at: ms_text(license.issued_at),
        valid_from: ms_text(license.valid_from),
        valid_until: ms_text(license.valid_until),
        grace_days: u32::try_from(license.grace_days).unwrap_or(0),
    }
}

/// `GET /v1/office/license` of `snapshot`.
pub fn office_license(app: &AppState, snapshot: &Snapshot, usage: &Usage) -> OfficeLicense {
    let evaluation = &snapshot.evaluation;
    OfficeLicense {
        state: evaluation.phase.as_str().to_owned(),
        since: ms_text(evaluation.since),
        flags: LicenseFlags {
            clock_behind_days: snapshot.reading.behind_days(),
            clock_ahead: snapshot.reading.ahead,
        },
        effective_at: ms_text(snapshot.reading.effective),
        phase_ends_at: evaluation.phase_ends_at.map(ms_text),
        days_left: evaluation.days_left,
        warn_days: evaluation.warn_days,
        opens_new_shifts: evaluation.opens_new_shifts,
        license: evaluation.license.as_ref().map(summary),
        trial: evaluation.trial.map(|trial| TrialInfo {
            started_at: ms_text(trial.started_at),
            ends_at: ms_text(trial.ends_at),
            inn: snapshot.clock_row.trial_inn.clone(),
        }),
        binding: LicenseBinding {
            host_id: app.host_id.clone(),
            fingerprint: app.endpoint.fingerprint.clone(),
            org_inn: snapshot.org_inn.clone(),
            inn_matches: evaluation.inn_matches,
        },
        quotas: quotas_wire(&evaluation.quotas, usage),
        features: features_wire(&evaluation.features),
        emergency: LicenseEmergency {
            available: evaluation.emergency_available,
            until: evaluation.emergency_until.map(ms_text),
        },
        warnings: Vec::new(),
    }
}

/// `GET /v1/office/license`: every office role.
pub async fn get_license(
    State(app): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeLicense>, ApiError> {
    app.license.office_license_now(&app).await.map(Json)
}

/// `GET /v1/office/license/activation-request` (administrators): what the
/// office saves for Маркиро to issue a file (spec §6.3). Not signed, no
/// secret in it; `usage` keeps an operator from issuing a quota below it.
pub async fn activation_request(
    State(app): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Value>, ApiError> {
    context.require_admin()?;
    let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let newest = snapshot
        .licenses
        .iter()
        .max_by_key(|license| license.sequence);
    Ok(Json(json!({
        "format": "markiro-activation-request-v1",
        "hostId": app.host_id,
        "hostFingerprint": app.endpoint.fingerprint,
        "hostVersion": env!("CARGO_PKG_VERSION"),
        "organization": { "name": name, "inn": snapshot.org_inn },
        "trial": snapshot.evaluation.trial.map(|trial| json!({
            "startedAt": ms_text(trial.started_at),
            "inn": snapshot.clock_row.trial_inn,
        })),
        "currentLicense": newest.map(|license| json!({
            "licenseId": license.license_id,
            "sequence": license.sequence,
        })),
        "usage": {
            "stations": usage.stations,
            "cabinetUsers": usage.cabinet_users,
            "lines": usage.lines,
        },
        "createdAt": app.timestamp(),
    })))
}
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент:

```rust
    /// The copies of the database (plan РК); `None` answers the office's
    /// backup routes `not_found`. `crate::start` always sets it.
    pub backups: Option<Arc<crate::backup::Backups>>,
}
```

заменить на:

```rust
    /// The copies of the database (plan РК); `None` answers the office's
    /// backup routes `not_found`. `crate::start` always sets it.
    pub backups: Option<Arc<crate::backup::Backups>>,
    /// The site's license (plan ЛЦ-2): its files, its state, the time it
    /// trusts and its gates.
    pub license: Arc<crate::license::LicenseService>,
}
```

Фрагмент:

```rust
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            clock,
        }
    }
```

заменить на:

```rust
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            license: Arc::new(crate::license::LicenseService::new(
                markiro_proto::trust::license_keyset(),
                Arc::new(crate::license::trial_mark::NoMark),
            )),
            clock,
        }
    }
```

Фрагмент:

```rust
    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }
}
```

заменить на:

```rust
    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }

    /// Replace the license service (`crate::start` gives it the registry's
    /// mark; tests a mark of their own).
    pub fn with_license(mut self, license: Arc<crate::license::LicenseService>) -> Self {
        self.license = license;
        self
    }
}
```

Фрагмент:

```rust
        .route(
            "/v1/office/pairing-codes",
            post(crate::routes::pairing::create_code),
        )
        .route("/v1/pairing/claim", post(crate::routes::pairing::claim))
}
```

заменить на:

```rust
        .route(
            "/v1/office/pairing-codes",
            post(crate::routes::pairing::create_code),
        )
        .route("/v1/pairing/claim", post(crate::routes::pairing::claim))
        .route(
            "/v1/office/license",
            get(crate::license::routes::get_license),
        )
        .route(
            "/v1/office/license/activation-request",
            get(crate::license::routes::activation_request),
        )
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_office --test bootstrap --test pairing
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib license::
```

Ожидается: PASS.

- [ ] **Step 6: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/store.rs apps/standalone/host/src/license/seats.rs apps/standalone/host/src/license/trial_mark.rs apps/standalone/host/src/license/routes.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/support/mod.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/support/license.rs apps/standalone/host/tests/license_office.rs
git commit -F - <<'EOF'
feat(standalone): the host's license service, GET office license and the activation request (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Загрузка файла — проверка 4.3, предпросмотр, `PUT /v1/office/license`, `license.load`, апгрейд

**Files:**

- Create: `apps/standalone/host/src/license/verify.rs`
- Modify: `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/license/routes.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/support/license.rs`
- Test: `apps/standalone/host/tests/license_load.rs`

**Interfaces:**

- Consumes: `markiro_proto::trust::{verify_license, Keyset, TrustError}` (ЛЦ-1), `crate::inn` (через `state::inn_matches`), `store::insert`, `seats::{usage, over_any}`, `audit::update_details`.
- Produces: `license::verify::{MAX_FILE_BYTES, Refusal, Verified, Admission, read, admit, warnings_for}`; `LicenseService::raise_floor`; `routes::{MAX_BODY_BYTES, preview_license, load_license, preview_of}`; `AppState.license_limiter` (10 в минуту на адрес); маршруты `POST /v1/office/license/preview`, `PUT /v1/office/license` (администратор); строки `license.load` `ok` и `denied`; тестовые `support::license::{set_org_inn, payload_of}`.

- [ ] **Step 1: Падающие тесты**

Дописать в `apps/standalone/host/tests/support/license.rs`:

```rust
/// The payload of a compact file, as JSON.
pub fn payload_of(file: &str) -> Value {
    let segment = file.split('.').nth(1).expect("three segments");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
}

/// Set the organization's INN in the profile (`null` clears it; the profile
/// takes any 10 or 12 digits, plan ЛЦ-2 leaves its rule alone).
pub async fn set_org_inn(admin: &Admin, inn: Value) {
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let body = json!({
        "name": org["name"], "inn": inn, "gln": org["gln"],
        "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"]
    });
    let (status, updated) = admin.call("PUT", "/v1/office/org", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
}
```

Создать `apps/standalone/host/tests/license_load.rs`:

```rust
//! Loading a license file (plan ЛЦ-2, spec §4.3, §4.8, §8.3): the order of
//! the checks, the `license.load` rows, the preview that writes nothing, the
//! upgrade by `sequence`, the warnings, the rate limit, and the files plan
//! ЛЦ-1 signs as the cloud will issue them.

mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use markiro_host::audit::actions;
use serde_json::{json, Value};
use support::app::{admin, admin_on, audit_rows, audit_trail, host_revision, Admin, AuditRow};
use support::license::{
    file, fixture_file, license_id, load, load_ok, payload_of, preview, set_org_inn,
    sign_with_kid, terms, text, DAY_MS, FIXTURE_HOST_ID, INN, OTHER_INN, START_MS, TEST_KID,
};

const OTHER_HOST: &str = "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f";

fn all_features() -> Value {
    json!({
        "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
        "inventory": true, "commerceMl": true, "handheld": true
    })
}

/// The `denied` row of a refused file.
fn denied(admin: &Admin, license_id: Option<&str>, details: Value) -> AuditRow {
    (
        "office_user".to_owned(),
        Some(admin.id.clone()),
        actions::LICENSE_LOAD.to_owned(),
        Some("license".to_owned()),
        license_id.map(str::to_owned),
        "denied".to_owned(),
        details,
    )
}

async fn stored(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn last_load_row(admin: &Admin) -> AuditRow {
    audit_trail(&admin.app, actions::LICENSE_LOAD)
        .await
        .pop()
        .expect("a license.load row")
}

#[tokio::test]
async fn each_refusal_names_its_reason_and_writes_one_denied_row() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let good = file(&host, |_| {});
    let parts: Vec<&str> = good.split('.').collect();
    let mut changed = terms(&host);
    changed["graceDays"] = json!(60);
    let tampered = format!(
        "{}.{}.{}",
        parts[0],
        URL_SAFE_NO_PAD.encode(changed.to_string()),
        parts[2]
    );
    let cases: Vec<(&str, String, Option<String>, Value)> = vec![
        ("not a file", "not a license".to_owned(), None, json!({ "reason": "license_malformed" })),
        (
            "16 KiB and a byte",
            "a".repeat(16 * 1024 + 1),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            "a key this build does not know",
            sign_with_kid(&terms(&host), "test-lic-9"),
            None,
            json!({ "reason": "license_unknown_key" }),
        ),
        ("a changed payload", tampered, None, json!({ "reason": "license_signature" })),
        (
            "another issuer",
            file(&host, |terms| terms["issuer"] = json!("https://other.invalid")),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            "another host",
            file(OTHER_HOST, |_| {}),
            Some(license_id(1)),
            json!({ "reason": "license_wrong_host", "fileHostId": OTHER_HOST }),
        ),
        (
            "another organization",
            file(&host, |terms| terms["customer"]["inn"] = json!(OTHER_INN)),
            Some(license_id(1)),
            json!({ "reason": "license_inn_mismatch" }),
        ),
    ];
    for (name, text, target, details) in cases {
        let rows = audit_rows(&admin.app).await;
        let rev = host_revision(&admin.app).await;
        let (status, body) = load(&admin, &text).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {body}");
        assert_eq!(
            (
                body["error"]["code"].clone(),
                body["error"]["details"]["field"].clone(),
                body["error"]["details"]["reason"].clone()
            ),
            (json!("validation_failed"), json!("file"), details["reason"].clone()),
            "{name}"
        );
        assert_eq!(audit_rows(&admin.app).await, rows + 1, "{name}");
        assert_eq!(host_revision(&admin.app).await, rev, "{name}");
        assert_eq!(last_load_row(&admin).await, denied(&admin, target.as_deref(), details), "{name}");
    }
    let (_, body) = load(&admin, &file(OTHER_HOST, |_| {})).await;
    assert_eq!(body["error"]["details"]["fileHostId"], OTHER_HOST);
    assert_eq!(stored(&admin).await, 0);
}

#[tokio::test]
async fn the_inn_is_checked_against_the_profile_and_a_missing_one_is_named() {
    let admin = admin().await;
    let good = file(&admin.app.state.host_id, |_| {});
    set_org_inn(&admin, Value::Null).await;
    let (status, body) = load(&admin, &good).await;
    assert_eq!(
        (status, body["error"]["details"]["reason"].clone()),
        (StatusCode::BAD_REQUEST, json!("license_inn_missing"))
    );
    assert_eq!(
        last_load_row(&admin).await,
        denied(&admin, Some(&license_id(1)), json!({ "reason": "license_inn_missing" }))
    );
    // The profile takes an INN whose check digit fails; it equals nothing.
    set_org_inn(&admin, json!("7707083894")).await;
    let (status, body) = load(&admin, &good).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"]["details"],
        json!({
            "field": "file", "reason": "license_inn_mismatch",
            "fileInn": INN, "orgInn": "7707083894"
        })
    );
    set_org_inn(&admin, json!(INN)).await;
    load_ok(&admin, &good).await;
}

#[tokio::test]
async fn an_accepted_file_is_kept_with_one_row_and_a_revision() {
    let admin = admin().await;
    let good = file(&admin.app.state.host_id, |terms| {
        terms["quotas"]["stations"] = json!(3);
    });
    let rev = host_revision(&admin.app).await;
    let body = load_ok(&admin, &good).await;
    assert_eq!(
        (body["state"].clone(), body["license"]["sequence"].clone()),
        (json!("active"), json!(1))
    );
    assert!(body.get("warnings").is_none(), "{body}");
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_LOAD).await,
        [admin.row(
            actions::LICENSE_LOAD,
            "license",
            &license_id(1),
            json!({
                "licenseId": license_id(1),
                "sequence": 1,
                "previousSequence": null,
                "kid": TEST_KID,
                "warnings": [],
                "changed": ["quotas", "features", "validUntil", "plan"],
                "quotas": {
                    "from": null,
                    "to": { "lines": null, "stations": 3, "kiosks": null, "cabinetUsers": null }
                },
                "features": { "from": null, "to": all_features() },
                "validUntil": { "from": null, "to": text(START_MS + 365 * DAY_MS) },
                "plan": { "from": null, "to": "subscription" }
            })
        )]
    );
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT compact, loaded_by FROM licenses WHERE license_id = ?")
            .bind(license_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(row, (good.clone(), Some(admin.id.clone())));
    // The same file again: the same answer, nothing written.
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let again = load_ok(&admin, &format!("{good}\n")).await;
    assert_eq!(again["license"], body["license"]);
    assert_eq!(
        (audit_rows(&admin.app).await, host_revision(&admin.app).await, stored(&admin).await),
        (rows, rev, 1)
    );
}

#[tokio::test]
async fn a_newer_file_replaces_by_sequence_and_an_older_or_equal_one_is_refused() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    load_ok(&admin, &file(&host, |terms| terms["quotas"]["stations"] = json!(3))).await;
    let upgraded = load_ok(
        &admin,
        &file(&host, |terms| {
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
            terms["quotas"]["stations"] = json!(5);
            terms["replaces"] = json!(license_id(1));
        }),
    )
    .await;
    // At once: no restart, no edit of data.
    assert_eq!(upgraded["quotas"]["stations"]["limit"], 5);
    assert_eq!(
        last_load_row(&admin).await,
        admin.row(
            actions::LICENSE_LOAD,
            "license",
            &license_id(2),
            json!({
                "licenseId": license_id(2), "sequence": 2, "previousSequence": 1,
                "kid": TEST_KID, "warnings": [], "changed": ["quotas"],
                "quotas": {
                    "from": { "lines": null, "stations": 3, "kiosks": null, "cabinetUsers": null },
                    "to": { "lines": null, "stations": 5, "kiosks": null, "cabinetUsers": null }
                }
            })
        )
    );
    for (n, sequence) in [(3, 1), (4, 2)] {
        let (status, body) = load(
            &admin,
            &file(&host, |terms| {
                terms["licenseId"] = json!(license_id(n));
                terms["sequence"] = json!(sequence);
                terms["quotas"]["stations"] = json!(50);
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["error"]["details"],
            json!({ "field": "file", "reason": "license_older", "newestSequence": 2 })
        );
        assert_eq!(
            last_load_row(&admin).await,
            denied(&admin, Some(&license_id(n)), json!({ "reason": "license_older" }))
        );
    }
    assert_eq!(stored(&admin).await, 2);
}

#[tokio::test]
async fn the_preview_tells_before_and_after_and_writes_nothing() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = preview(
        &admin,
        &file(&host, |terms| {
            terms["quotas"]["stations"] = json!(0);
            terms["features"]["pallets"] = json!(false);
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let unlimited = |lines: u32, stations: u32, users: u32| {
        json!({
            "lines": { "limit": null, "used": lines, "over": false },
            "stations": { "limit": null, "used": stations, "over": false },
            "kiosks": { "limit": null, "used": 0, "over": false },
            "cabinetUsers": { "limit": null, "used": users, "over": false }
        })
    };
    let mut after_quotas = unlimited(2, 1, 1);
    after_quotas["stations"] = json!({ "limit": 0, "used": 1, "over": true });
    let mut after_features = all_features();
    after_features["pallets"] = json!(false);
    assert_eq!(
        body,
        json!({
            "before": {
                "licenseId": null, "sequence": null, "plan": "trial",
                "validFrom": text(START_MS), "validUntil": text(START_MS + 14 * DAY_MS),
                "graceDays": 0, "quotas": unlimited(2, 1, 1), "features": all_features()
            },
            "after": {
                "licenseId": license_id(1), "sequence": 1, "plan": "subscription",
                "validFrom": text(START_MS), "validUntil": text(START_MS + 365 * DAY_MS),
                "graceDays": 14, "quotas": after_quotas, "features": after_features
            },
            "changes": ["plan", "validUntil", "graceDays", "quotas.stations", "features.pallets"],
            "warnings": ["over_limit"]
        })
    );
    let (status, body) = preview(&admin, &file(OTHER_HOST, |_| {})).await;
    assert_eq!(
        (status, body["error"]["details"]["reason"].clone()),
        (StatusCode::BAD_REQUEST, json!("license_wrong_host"))
    );
    assert_eq!(
        (audit_rows(&admin.app).await, host_revision(&admin.app).await, stored(&admin).await),
        (rows, rev, 0)
    );
}

#[tokio::test]
async fn an_expired_a_waiting_and_a_smaller_file_are_taken_with_a_warning() {
    let expired = admin().await;
    let body = load_ok(
        &expired,
        &file(&expired.app.state.host_id, |terms| {
            terms["issuedAt"] = json!(START_MS - 30 * DAY_MS);
            terms["validFrom"] = json!(START_MS - 30 * DAY_MS);
            terms["validUntil"] = json!(START_MS - DAY_MS);
            terms["graceDays"] = json!(0);
        }),
    )
    .await;
    assert_eq!(
        (body["state"].clone(), body["warnings"].clone()),
        (json!("restricted"), json!(["expired"]))
    );
    let waiting = admin().await;
    let body = load_ok(
        &waiting,
        &file(&waiting.app.state.host_id, |terms| {
            terms["validFrom"] = json!(START_MS + 10 * DAY_MS);
        }),
    )
    .await;
    assert_eq!(
        (body["state"].clone(), body["license"].clone(), body["warnings"].clone()),
        (json!("trial"), Value::Null, json!(["not_yet_valid"]))
    );
    let smaller = admin().await;
    let body = load_ok(
        &smaller,
        &file(&smaller.app.state.host_id, |terms| terms["quotas"]["stations"] = json!(0)),
    )
    .await;
    assert_eq!(body["warnings"], json!(["over_limit"]));
    assert_eq!(body["quotas"]["stations"], json!({ "limit": 0, "used": 1, "over": true }));
}

#[tokio::test]
async fn the_technologist_may_read_but_neither_preview_nor_load() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let good = json!({ "file": file(&admin.app.state.host_id, |_| {}) });
    let rows = audit_rows(&admin.app).await;
    for (method, path) in [("PUT", "/v1/office/license"), ("POST", "/v1/office/license/preview")] {
        let (status, _) = admin.call_as(&tech, method, path, Some(good.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn ten_attempts_a_minute_then_the_limit_refuses_without_a_row() {
    let admin = admin().await;
    for _ in 0..10 {
        assert_eq!(load(&admin, "not a license").await.0, StatusCode::BAD_REQUEST);
    }
    let rows = audit_rows(&admin.app).await;
    // The preview shares the limit with the load.
    let (status, body) = preview(&admin, "not a license").await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::TOO_MANY_REQUESTS, json!("rate_limited"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(audit_trail(&admin.app, actions::LICENSE_LOAD).await.len(), 10);
    admin.app.clock.advance(time::Duration::seconds(61));
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
}

#[tokio::test]
async fn the_files_plan_lc1_signs_are_read_as_the_cloud_will_send_them() {
    let admin = admin_on(FIXTURE_HOST_ID).await;
    let subscription = fixture_file("license-subscription.jws");
    let payload = payload_of(&subscription);
    assert_eq!(
        (payload["hostId"].clone(), payload["customer"]["inn"].clone()),
        (json!(FIXTURE_HOST_ID), json!(INN))
    );
    for (name, reason) in [
        ("license-tampered.jws", "license_signature"),
        ("license-unknown-kid.jws", "license_unknown_key"),
        ("license-other-host.jws", "license_wrong_host"),
        ("license-other-inn.jws", "license_inn_mismatch"),
    ] {
        let (status, body) = load(&admin, &fixture_file(name)).await;
        assert_eq!(
            (status, body["error"]["details"]["reason"].clone()),
            (StatusCode::BAD_REQUEST, json!(reason)),
            "{name}"
        );
    }
    // Accepted, whatever its dates (an expired file is kept with a warning).
    load_ok(&admin, &subscription).await;
    load_ok(&admin, &fixture_file("license-upgrade.jws")).await;
    let (status, body) = load(&admin, &fixture_file("license-older.jws")).await;
    assert_eq!(
        (status, body["error"]["details"]["reason"].clone()),
        (StatusCode::BAD_REQUEST, json!("license_older"))
    );
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_load
```

Ожидается: каждый тест FAIL — `PUT /v1/office/license` отвечает `405 method_not_allowed`, предпросмотр — `404`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/src/license/verify.rs`:

```rust
//! The check of a license file before anything is written (spec §4.3), in
//! its order: the form, the key and the signature (`markiro_proto::trust`,
//! plan ЛЦ-1), the payload and its issuer, then this host, the
//! organization's INN and the order of the site's files.

use markiro_proto::license::{refusals, warnings};
use markiro_proto::trust::{Keyset, TrustError};
use serde_json::Value;

use super::seats::{self, Usage};
use super::state::{self, Features, Quotas, StoredLicense};

/// The most a license file may hold.
pub const MAX_FILE_BYTES: usize = 16 * 1024;

/// Why a file was refused. From `WrongHost` on, the signature checked out,
/// so the file's id can name it in the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    UnknownKey,
    Signature,
    WrongHost {
        license_id: String,
        file_host_id: String,
    },
    InnMismatch {
        license_id: String,
        file_inn: String,
        org_inn: String,
    },
    InnMissing {
        license_id: String,
    },
    Older {
        license_id: String,
        newest: i64,
    },
}

impl Refusal {
    /// `details.reason` ([`refusals`]).
    pub fn reason(&self) -> &'static str {
        match self {
            Refusal::Malformed => refusals::MALFORMED,
            Refusal::UnknownKey => refusals::UNKNOWN_KEY,
            Refusal::Signature => refusals::SIGNATURE,
            Refusal::WrongHost { .. } => refusals::WRONG_HOST,
            Refusal::InnMismatch { .. } => refusals::INN_MISMATCH,
            Refusal::InnMissing { .. } => refusals::INN_MISSING,
            Refusal::Older { .. } => refusals::OLDER,
        }
    }

    /// The file's id, once its signature checked out.
    pub fn license_id(&self) -> Option<&str> {
        match self {
            Refusal::WrongHost { license_id, .. }
            | Refusal::InnMismatch { license_id, .. }
            | Refusal::InnMissing { license_id }
            | Refusal::Older { license_id, .. } => Some(license_id),
            Refusal::Malformed | Refusal::UnknownKey | Refusal::Signature => None,
        }
    }
}

/// A file this build trusts, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub license: StoredLicense,
    /// The file's text, trimmed: what `licenses.compact` keeps.
    pub compact: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Newer than every stored file.
    New,
    /// The file is stored already: nothing to write.
    Same,
}

/// Steps 1–4: the form, the key, the signature, the payload and its issuer.
pub fn read(file: &str, keyset: &Keyset) -> Result<Verified, Refusal> {
    if file.len() > MAX_FILE_BYTES {
        return Err(Refusal::Malformed);
    }
    let compact = file.trim();
    let (payload, kid) = markiro_proto::trust::verify_license(compact, keyset).map_err(
        |error| match error {
            TrustError::Malformed => Refusal::Malformed,
            TrustError::UnknownKey => Refusal::UnknownKey,
            TrustError::BadSignature => Refusal::Signature,
        },
    )?;
    // Through JSON: the host reads the payload by its wire names (§4.2),
    // whatever Rust types plan ЛЦ-1 gave them.
    let value = serde_json::to_value(&payload).map_err(|_| Refusal::Malformed)?;
    if keyset.origin.as_deref() != value["issuer"].as_str() {
        return Err(Refusal::Malformed);
    }
    let license = from_payload(&value, &kid).ok_or(Refusal::Malformed)?;
    Ok(Verified {
        license,
        compact: compact.to_owned(),
    })
}

fn from_payload(value: &Value, kid: &str) -> Option<StoredLicense> {
    let text = |name: &str| value[name].as_str().map(str::to_owned);
    let ms = |name: &str| value[name].as_i64();
    let license = StoredLicense {
        license_id: text("licenseId")?,
        sequence: value["sequence"].as_i64().filter(|sequence| *sequence >= 1)?,
        kid: kid.to_owned(),
        host_id: text("hostId")?,
        issued_at: ms("issuedAt")?,
        valid_from: ms("validFrom")?,
        valid_until: ms("validUntil")?,
        grace_days: value["graceDays"]
            .as_i64()
            .filter(|days| (0..=60).contains(days))?,
        plan: text("plan").filter(|plan| plan == "demo" || plan == "subscription")?,
        plan_version_id: text("planVersionId")?,
        customer_name: value["customer"]["name"].as_str()?.to_owned(),
        customer_inn: value["customer"]["inn"].as_str()?.to_owned(),
        quotas: serde_json::from_value::<Quotas>(value["quotas"].clone()).ok()?,
        features: serde_json::from_value::<Features>(value["features"].clone()).ok()?,
    };
    (value["version"].as_i64() == Some(1) && license.valid_until > license.valid_from)
        .then_some(license)
}

/// Steps 5–7: this host's file, the organization's INN, newer than every
/// stored file (the same file again is no refusal: nothing changes).
pub fn admit(
    verified: &Verified,
    host_id: &str,
    org_inn: Option<&str>,
    stored: &[StoredLicense],
) -> Result<Admission, Refusal> {
    let license = &verified.license;
    let license_id = license.license_id.clone();
    if license.host_id != host_id {
        return Err(Refusal::WrongHost {
            license_id,
            file_host_id: license.host_id.clone(),
        });
    }
    let Some(org) = org_inn.map(str::trim).filter(|inn| !inn.is_empty()) else {
        return Err(Refusal::InnMissing { license_id });
    };
    if !state::inn_matches(Some(org), &license.customer_inn) {
        return Err(Refusal::InnMismatch {
            license_id,
            file_inn: license.customer_inn.clone(),
            org_inn: org.to_owned(),
        });
    }
    if stored
        .iter()
        .any(|known| known.license_id == license.license_id)
    {
        return Ok(Admission::Same);
    }
    match stored.iter().map(|known| known.sequence).max() {
        Some(newest) if license.sequence <= newest => Err(Refusal::Older { license_id, newest }),
        _ => Ok(Admission::New),
    }
}

/// What an accepted file warns of, at the effective time `now`.
pub fn warnings_for(license: &StoredLicense, now: i64, usage: &Usage) -> Vec<String> {
    let mut found = Vec::new();
    if license.valid_until <= now {
        found.push(warnings::EXPIRED.to_owned());
    }
    if license.valid_from > now {
        found.push(warnings::NOT_YET_VALID.to_owned());
    }
    if seats::over_any(&license.quotas, usage) {
        found.push(warnings::OVER_LIMIT.to_owned());
    }
    found
}
```

Правка `apps/standalone/host/src/license/mod.rs`:

Фрагмент:

```rust
pub mod store;
pub mod trial_mark;
```

заменить на:

```rust
pub mod store;
pub mod trial_mark;
pub mod verify;
```

Фрагмент (в `impl LicenseService`, после `keyset`):

```rust
    /// The license keys this build trusts (`markiro_proto::trust`).
    pub fn keyset(&self) -> &Keyset {
        &self.keyset
    }
```

заменить на:

```rust
    /// The license keys this build trusts (`markiro_proto::trust`).
    pub fn keyset(&self) -> &Keyset {
        &self.keyset
    }

    /// A file just stored proves the time is not before `floor` (§7).
    pub fn raise_floor(&self, app: &AppState, floor: i64) {
        let mono = app.clock.monotonic();
        if let Some(clock) = self.clock.lock().expect("license clock lock").as_mut() {
            clock.raise_floor(floor, mono);
        }
    }
```

Правка `apps/standalone/host/src/license/routes.rs`:

Фрагмент:

```rust
use axum::extract::State;
use axum::Json;
use markiro_proto::license::{
    LicenseBinding, LicenseCustomer, LicenseEmergency, LicenseFeatures, LicenseFlags,
    LicenseQuotas, LicenseSummary, OfficeLicense, QuotaUse, TrialInfo,
};
use serde_json::{json, Value};

use super::seats::{self, Usage};
use super::state::{Features, Quotas, StoredLicense};
use super::{ms_text, Snapshot};
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;
```

заменить на:

```rust
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::codes;
use markiro_proto::license::{
    plans, LicenseBinding, LicenseCustomer, LicenseEmergency, LicenseFeatures, LicenseFlags,
    LicenseLoadRequest, LicensePreview, LicenseQuotas, LicenseSummary, LicenseTerms,
    OfficeLicense, QuotaUse, TrialInfo,
};
use serde_json::{json, Value};

use super::seats::{self, Usage};
use super::state::{self, Evaluation, Features, Quotas, StoredLicense};
use super::verify::{self, Admission, Refusal};
use super::{ms_text, store, Snapshot};
use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

/// The body limit of a preview and a load: a file is at most 16 KiB, and its
/// JSON envelope a little more.
pub const MAX_BODY_BYTES: usize = 32 * 1024;
```

Дописать в конец `apps/standalone/host/src/license/routes.rs`:

```rust
/// One column of «было → станет» for a file.
fn terms_of_file(license: &StoredLicense, usage: &Usage) -> LicenseTerms {
    LicenseTerms {
        license_id: Some(license.license_id.clone()),
        sequence: u64::try_from(license.sequence).ok(),
        plan: license.plan.clone(),
        valid_from: Some(ms_text(license.valid_from)),
        valid_until: Some(ms_text(license.valid_until)),
        grace_days: u32::try_from(license.grace_days).unwrap_or(0),
        quotas: quotas_wire(&license.quotas, usage),
        features: features_wire(&license.features),
    }
}

/// The column of what is in force now: the file, or the built-in trial.
fn terms_now(evaluation: &Evaluation, usage: &Usage) -> LicenseTerms {
    match &evaluation.license {
        Some(license) => terms_of_file(license, usage),
        None => LicenseTerms {
            license_id: None,
            sequence: None,
            plan: plans::TRIAL.to_owned(),
            valid_from: evaluation.trial.map(|trial| ms_text(trial.started_at)),
            valid_until: evaluation.trial.map(|trial| ms_text(trial.ends_at)),
            grace_days: 0,
            quotas: quotas_wire(&Quotas::default(), usage),
            features: features_wire(&Features::ALL),
        },
    }
}

fn quota_list(quotas: &LicenseQuotas) -> [(&'static str, QuotaUse); 4] {
    [
        ("lines", quotas.lines),
        ("stations", quotas.stations),
        ("kiosks", quotas.kiosks),
        ("cabinetUsers", quotas.cabinet_users),
    ]
}

fn feature_list(features: &LicenseFeatures) -> [(&'static str, bool); 7] {
    [
        ("labelEditor", features.label_editor),
        ("publicApi", features.public_api),
        ("pallets", features.pallets),
        ("chzIntegration", features.chz_integration),
        ("inventory", features.inventory),
        ("commerceMl", features.commerce_ml),
        ("handheld", features.handheld),
    ]
}

/// The fields of `after` that differ from `before`, in the preview's order.
fn changes(before: &LicenseTerms, after: &LicenseTerms) -> Vec<String> {
    let mut changes = Vec::new();
    if before.plan != after.plan {
        changes.push("plan".to_owned());
    }
    if before.valid_from != after.valid_from {
        changes.push("validFrom".to_owned());
    }
    if before.valid_until != after.valid_until {
        changes.push("validUntil".to_owned());
    }
    if before.grace_days != after.grace_days {
        changes.push("graceDays".to_owned());
    }
    for ((key, was), (_, will)) in quota_list(&before.quotas)
        .into_iter()
        .zip(quota_list(&after.quotas))
    {
        if was.limit != will.limit {
            changes.push(format!("quotas.{key}"));
        }
    }
    for ((key, was), (_, will)) in feature_list(&before.features)
        .into_iter()
        .zip(feature_list(&after.features))
    {
        if was != will {
            changes.push(format!("features.{key}"));
        }
    }
    changes
}

/// «было → станет» of `license` against what is in force (spec §4.8).
pub fn preview_of(snapshot: &Snapshot, usage: &Usage, license: &StoredLicense) -> LicensePreview {
    let before = terms_now(&snapshot.evaluation, usage);
    let after = terms_of_file(license, usage);
    LicensePreview {
        changes: changes(&before, &after),
        warnings: verify::warnings_for(license, snapshot.reading.effective, usage),
        before,
        after,
    }
}

/// `validation_failed` on `file` with the refusal's reason and what the
/// office's text needs (the file's host, both INNs, the newest number).
fn refused(refusal: &Refusal) -> ApiError {
    let mut details = json!({ "field": "file", "reason": refusal.reason() });
    match refusal {
        Refusal::WrongHost { file_host_id, .. } => details["fileHostId"] = json!(file_host_id),
        Refusal::InnMismatch {
            file_inn, org_inn, ..
        } => {
            details["fileInn"] = json!(file_inn);
            details["orgInn"] = json!(org_inn);
        }
        Refusal::Older { newest, .. } => details["newestSequence"] = json!(newest),
        Refusal::Malformed | Refusal::UnknownKey | Refusal::Signature | Refusal::InnMissing { .. } => {}
    }
    ApiError::new(
        StatusCode::BAD_REQUEST,
        codes::VALIDATION_FAILED,
        "the license file was refused",
    )
    .with_details(details)
}

/// `POST /v1/office/license/preview` (administrators): the file checked as
/// a load checks it, nothing written and no audit row.
pub async fn preview_license(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiJson(request): ApiJson<LicenseLoadRequest>,
) -> Result<Json<LicensePreview>, ApiError> {
    context.require_admin()?;
    app.license_limiter.check(peer.ip())?;
    let read = verify::read(&request.file, app.license.keyset());
    let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let verified = read
        .and_then(|verified| {
            verify::admit(
                &verified,
                &app.host_id,
                snapshot.org_inn.as_deref(),
                &snapshot.licenses,
            )
            .map(|_| verified)
        })
        .map_err(|refusal| refused(&refusal))?;
    Ok(Json(preview_of(&snapshot, &usage, &verified.license)))
}

/// `PUT /v1/office/license` (administrators): load a file. A refused file
/// writes a `denied` row (spec §8.3: a foreign or forged file is an event);
/// the same file again writes nothing.
pub async fn load_license(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiJson(request): ApiJson<LicenseLoadRequest>,
) -> Result<Json<OfficeLicense>, ApiError> {
    context.require_admin()?;
    app.license_limiter.check(peer.ip())?;
    let read = verify::read(&request.file, app.license.keyset());
    let at = app.timestamp();
    let mut tx = begin_write(&app.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let admitted = read.and_then(|verified| {
        verify::admit(
            &verified,
            &app.host_id,
            snapshot.org_inn.as_deref(),
            &snapshot.licenses,
        )
        .map(|admission| (verified, admission))
    });
    let (verified, admission) = match admitted {
        Ok(admitted) => admitted,
        Err(refusal) => {
            let mut details = json!({ "reason": refusal.reason() });
            if let Refusal::WrongHost { file_host_id, .. } = &refusal {
                details["fileHostId"] = json!(file_host_id);
            }
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: context.actor(),
                    action: actions::LICENSE_LOAD,
                    target_type: Some("license"),
                    target_id: refusal.license_id(),
                    outcome: Outcome::Denied,
                    details,
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            tracing::info!(reason = refusal.reason(), "a license file was refused");
            return Err(refused(&refusal));
        }
    };
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    let warnings = verify::warnings_for(&verified.license, snapshot.reading.effective, &usage);
    if admission == Admission::Same {
        tx.rollback().await.map_err(ApiError::internal)?;
        let mut answer = office_license(&app, &snapshot, &usage);
        answer.warnings = warnings;
        return Ok(Json(answer));
    }
    let license = &verified.license;
    let previous = snapshot
        .licenses
        .iter()
        .max_by_key(|license| license.sequence);
    store::insert(
        &mut tx,
        license,
        &verified.compact,
        &at,
        Some(&context.user.id),
    )
    .await
    .map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let mut details = json!({
        "licenseId": license.license_id,
        "sequence": license.sequence,
        "previousSequence": previous.map(|previous| previous.sequence),
        "kid": license.kid,
        "warnings": warnings,
    });
    let changed = audit::update_details(&[
        (
            "quotas",
            previous.map_or(Value::Null, |previous| json!(previous.quotas)),
            json!(license.quotas),
        ),
        (
            "features",
            previous.map_or(Value::Null, |previous| json!(previous.features)),
            json!(license.features),
        ),
        (
            "validUntil",
            previous.map_or(Value::Null, |previous| json!(ms_text(previous.valid_until))),
            json!(ms_text(license.valid_until)),
        ),
        (
            "plan",
            previous.map_or(Value::Null, |previous| json!(previous.plan)),
            json!(license.plan),
        ),
    ])
    .unwrap_or_else(|| json!({ "changed": [] }));
    if let (Value::Object(target), Value::Object(source)) = (&mut details, changed) {
        target.extend(source);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LICENSE_LOAD,
            target_type: Some("license"),
            target_id: Some(&license.license_id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &app.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    app.license
        .raise_floor(&app, license.issued_at - state::DAY_MS);
    tracing::info!(
        license_id = %license.license_id,
        sequence = license.sequence,
        "a license file was loaded"
    );
    let mut answer = app.license.office_license_now(&app).await?;
    answer.warnings = warnings;
    Ok(Json(answer))
}
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент:

```rust
    pub claim_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub endpoint: Endpoint,
```

заменить на:

```rust
    pub claim_limiter: Arc<crate::rate_limit::RateLimiter>,
    /// License previews and loads, per address (plan ЛЦ-2, spec §8.3: like
    /// the sign-in); its refusals write no row.
    pub license_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub endpoint: Endpoint,
```

Фрагмент:

```rust
            claim_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            endpoint: Endpoint {
```

заменить на:

```rust
            claim_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            license_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            endpoint: Endpoint {
```

Фрагмент (маршрут задачи 6):

```rust
        .route(
            "/v1/office/license",
            get(crate::license::routes::get_license),
        )
```

заменить на:

```rust
        .route(
            "/v1/office/license",
            get(crate::license::routes::get_license)
                .put(crate::license::routes::load_license)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::license::routes::MAX_BODY_BYTES,
                )),
        )
        .route(
            "/v1/office/license/preview",
            post(crate::license::routes::preview_license).layer(
                axum::extract::DefaultBodyLimit::max(crate::license::routes::MAX_BODY_BYTES),
            ),
        )
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_load --test license_office
```

Ожидается: PASS. Если тест паритета находит в фикстурах ЛЦ-1 другой `hostId` или ИНН — взять их из нагрузки (`admin_on(payload["hostId"])`, ИНН мастера — через `set_org_inn`) и записать в «Отклонения».

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/verify.rs apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/routes.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/support/license.rs apps/standalone/host/tests/license_load.rs
git commit -F - <<'EOF'
feat(standalone): load a license file — the checks of §4.3, the preview, the upgrade by sequence, license.load (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Переходы состояния, проверка при старте, `GET /v1/device` с `license`, пересчёт после записей

**Files:**

- Modify: `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/license/routes.rs`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/routes/devices.rs`, `apps/standalone/host/src/routes/org.rs`, `apps/standalone/host/src/routes/cloud_import.rs`, `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/host/tests/support/license.rs`
- Test: `apps/standalone/host/tests/license_state.rs`, `apps/standalone/host/tests/license_load.rs`

**Interfaces:**

- Consumes: `LicenseService::snapshot`, `store::{set_state, persist_mark, set_wrong_host_since}`, `clock::PERSIST_EVERY_MS`, `audit::actions::LICENSE_STATE`.
- Produces: `LicenseService::{refresh, refresh_after_write, startup}`, `license::{TICK, spawn_ticker}`, `routes::device_license`; `RunningHost` останавливает задачу лицензии; `GET /v1/device` → `license`; строки `license.state` (субъект — хост, цель — файл или пусто, `{ from, to, licenseId, effectiveAt, clockBehindDays, clockAhead }`) и ревизия на каждую смену состояния; пересчёт после мастера, загрузки, `PUT /v1/office/org`, `POST /v1/office/import`; тестовый `support::license::refresh`.

- [ ] **Step 1: Падающие тесты**

Дописать в `apps/standalone/host/tests/support/license.rs` (помощник, отложенный в задаче 6):

```rust
/// What the minute's look does (`LicenseService::refresh`).
pub async fn refresh(app: &TestApp) {
    app.state.license.refresh(&app.state).await.unwrap();
}
```

Правка `apps/standalone/host/tests/license_load.rs` (загрузка теперь ещё и меняет состояние):

Фрагмент:

```rust
    assert!(body.get("warnings").is_none(), "{body}");
    assert_eq!(host_revision(&admin.app).await, rev + 1);
```

заменить на:

```rust
    assert!(body.get("warnings").is_none(), "{body}");
    // The load takes one revision, the state's change (trial → active) another.
    assert_eq!(host_revision(&admin.app).await, rev + 2);
```

Создать `apps/standalone/host/tests/license_state.rs`:

```rust
//! The license state over time (plan ЛЦ-2, spec §3.2, §7, §8.2): one
//! `license.state` row of the host and one revision per change, the first
//! look and a quiet hour writing none, the device's line, the start of a site
//! that predates the license, the INN after the profile and the import, and
//! the PC's clock set back or far ahead.

mod support;

use axum::http::StatusCode;
use markiro_host::audit::actions;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, cloud_import_request, empty, host_revision, json as json_request,
    request, with_device, AuditRow, IMPORT_ID,
};
use support::license::{
    file, license_id, load_ok, office_license, refresh, set_org_inn, text, DAY_MS, INN,
    OTHER_INN, START_MS,
};

/// A `license.state` row of the host.
fn state_row(license_id: Option<&str>, from: &str, to: &str, at_ms: i64) -> AuditRow {
    (
        "system".to_owned(),
        None,
        actions::LICENSE_STATE.to_owned(),
        Some("license".to_owned()),
        license_id.map(str::to_owned),
        "ok".to_owned(),
        json!({
            "from": from, "to": to, "licenseId": license_id, "effectiveAt": text(at_ms),
            "clockBehindDays": null, "clockAhead": false
        }),
    )
}

/// A file that ended a day before the clock's start, without grace.
fn expired(host: &str) -> String {
    file(host, |terms| {
        terms["issuedAt"] = json!(START_MS - 30 * DAY_MS);
        terms["validFrom"] = json!(START_MS - 30 * DAY_MS);
        terms["validUntil"] = json!(START_MS - DAY_MS);
        terms["graceDays"] = json!(0);
    })
}

async fn device_record(admin: &support::app::Admin) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn time_moves_the_state_and_each_change_writes_one_row_and_one_revision() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let id = license_id(1);
    load_ok(
        &admin,
        &file(&host, |terms| {
            terms["validUntil"] = json!(START_MS + 90 * DAY_MS);
            terms["graceDays"] = json!(7);
        }),
    )
    .await;
    let mut expected = vec![state_row(Some(&id), "trial", "active", START_MS)];
    let mut at = START_MS;
    let mut from = "active";
    // A 90-day term warns 30 days ahead; 7 days of grace.
    for (days, to) in [(60, "expiring"), (30, "grace"), (7, "restricted")] {
        admin.app.clock.advance(time::Duration::days(days));
        at += days * DAY_MS;
        let rev = host_revision(&admin.app).await;
        refresh(&admin.app).await;
        // The next look finds nothing new.
        refresh(&admin.app).await;
        assert_eq!(host_revision(&admin.app).await, rev + 1, "{to}");
        assert_eq!(office_license(&admin).await["state"], to);
        expected.push(state_row(Some(&id), from, to, at));
        from = to;
    }
    assert_eq!(audit_trail(&admin.app, actions::LICENSE_STATE).await, expected);
}

#[tokio::test]
async fn the_first_look_and_a_quiet_hour_write_no_row_and_the_mark_moves_hourly() {
    let admin = admin().await;
    let clock = || async {
        sqlx::query_as::<_, (Option<String>, Option<i64>)>(
            "SELECT last_state, max_seen_at FROM license_clock WHERE id = 1",
        )
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    // The wizard's look set the state to compare with.
    assert_eq!(clock().await, (Some("trial".to_owned()), Some(START_MS)));
    let rev = host_revision(&admin.app).await;
    admin.app.clock.advance(time::Duration::minutes(30));
    refresh(&admin.app).await;
    assert_eq!(clock().await.1, Some(START_MS));
    admin.app.clock.advance(time::Duration::minutes(31));
    refresh(&admin.app).await;
    assert_eq!(clock().await.1, Some(START_MS + 61 * 60_000));
    assert_eq!(host_revision(&admin.app).await, rev);
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE).await.is_empty());
}

#[tokio::test]
async fn a_device_reads_the_license_with_its_record_and_not_with_its_line() {
    let admin = admin().await;
    assert_eq!(
        device_record(&admin).await["license"],
        json!({
            "state": "trial", "since": text(START_MS),
            "phaseEndsAt": text(START_MS + 14 * DAY_MS), "emergencyUntil": null
        })
    );
    load_ok(&admin, &expired(&admin.app.state.host_id)).await;
    assert_eq!(
        device_record(&admin).await["license"],
        json!({
            "state": "restricted", "since": text(START_MS - DAY_MS),
            "phaseEndsAt": null, "emergencyUntil": null
        })
    );
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let (status, moved) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": lines[0]["id"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert!(moved.get("license").is_none(), "{moved}");
}

#[tokio::test]
async fn a_site_whose_wizard_ran_before_the_license_starts_its_trial_at_its_first_start() {
    let admin = admin().await;
    sqlx::query(
        "UPDATE license_clock SET trial_started_at = NULL, trial_inn = NULL, last_state = NULL",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    admin.app.clock.advance(time::Duration::days(100));
    admin.app.state.license.startup(&admin.app.state).await;
    let started = || async {
        sqlx::query_as::<_, (Option<i64>, Option<String>)>(
            "SELECT trial_started_at, trial_inn FROM license_clock WHERE id = 1",
        )
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(
        started().await,
        (Some(START_MS + 100 * DAY_MS), Some(INN.to_owned()))
    );
    let license = office_license(&admin).await;
    assert_eq!(
        (license["state"].clone(), license["daysLeft"].clone()),
        (json!("trial"), json!(14))
    );
    // A second start moves nothing.
    admin.app.clock.advance(time::Duration::days(1));
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(started().await.0, Some(START_MS + 100 * DAY_MS));
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE).await.is_empty());
}

#[tokio::test]
async fn an_inn_changed_in_the_profile_closes_new_shifts_until_it_is_put_back() {
    let admin = admin().await;
    let id = license_id(1);
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["opensNewShifts"].clone(),
            license["binding"]["innMatches"].clone()
        ),
        (json!("inn_mismatch"), json!(false), json!(false))
    );
    set_org_inn(&admin, json!(INN)).await;
    assert_eq!(office_license(&admin).await["state"], "active");
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await,
        [
            state_row(Some(&id), "trial", "active", START_MS),
            state_row(Some(&id), "active", "inn_mismatch", START_MS),
            state_row(Some(&id), "inn_mismatch", "active", START_MS),
        ]
    );
}

#[tokio::test]
async fn the_trial_keeps_its_start_and_its_inn_when_the_inn_changes() {
    let admin = admin().await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["trial"]["startedAt"].clone(),
            license["trial"]["inn"].clone()
        ),
        (json!("trial"), json!(text(START_MS)), json!(INN))
    );
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE).await.is_empty());
}

#[tokio::test]
async fn the_cloud_import_keeps_the_inn_and_the_state() {
    let admin = admin().await;
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    let (status, summary) = admin
        .call("POST", "/v1/office/import", Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let license = office_license(&admin).await;
    assert_eq!(
        (license["state"].clone(), license["binding"]["orgInn"].clone()),
        (json!("active"), json!(INN))
    );
    assert_eq!(audit_trail(&admin.app, actions::LICENSE_STATE).await.len(), 1);
}

#[tokio::test]
async fn a_clock_set_back_two_days_is_flagged_and_moves_no_time_back() {
    let admin = admin().await;
    admin.app.clock.advance(time::Duration::days(-2));
    let license = office_license(&admin).await;
    assert_eq!(
        (license["flags"].clone(), license["effectiveAt"].clone()),
        (
            json!({ "clockBehindDays": 2, "clockAhead": false }),
            json!(text(START_MS))
        )
    );
}

#[tokio::test]
async fn a_clock_set_far_ahead_while_running_is_flagged_and_not_believed() {
    let admin = admin().await;
    admin.app.clock.move_wall(time::Duration::days(500));
    let license = office_license(&admin).await;
    assert_eq!(
        (license["flags"].clone(), license["effectiveAt"].clone(), license["state"].clone()),
        (
            json!({ "clockBehindDays": null, "clockAhead": true }),
            json!(text(START_MS + 5 * 60_000)),
            json!("trial")
        )
    );
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_state --test license_load
```

Ожидается: ошибка компиляции (`LicenseService::refresh`, `startup` нет); после их появления без вызовов из маршрутов — FAIL: нет строк `license.state`, нет `license` в `GET /v1/device`, `rev + 2`.

- [ ] **Step 3: Реализация — служба**

Правка `apps/standalone/host/src/license/mod.rs`:

Фрагмент:

```rust
use self::state::{Evaluation, Inputs, Phase, StoredLicense};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::server::AppState;
```

заменить на:

```rust
use serde_json::json;

use self::state::{Evaluation, Inputs, Phase, StoredLicense};
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::ApiError;
use crate::server::AppState;

/// How often the host looks at the state: a phase that ends by time (the
/// grace at midnight) gets its row and wakes the stations within a minute.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// The minute's look, until the host stops.
pub fn spawn_ticker(
    app: AppState,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is at once: the start looked already.
        interval.tick().await;
        loop {
            tokio::select! {
                _ = stopping.wait_for(|stopping| *stopping) => break,
                _ = interval.tick() => app.license.refresh_after_write(&app).await,
            }
        }
    })
}
```

Дописать в `impl LicenseService` (после `office_license_now`):

```rust
    /// Write what changed since the last look (spec §8.2): a new state with
    /// one `license.state` row of the host and one revision, so open streams
    /// wake and stations read `GET /v1/device` again; the first look sets the
    /// state to compare with and writes no row; the time's mark at most once
    /// an hour; when a file of another host was first seen.
    pub async fn refresh(&self, app: &AppState) -> Result<(), sqlx::Error> {
        let mut tx = begin_write(&app.pool).await?;
        let snapshot = self.snapshot(app, &mut tx).await?;
        let now = snapshot.reading.effective;
        let evaluation = &snapshot.evaluation;
        let phase = evaluation.phase.as_str();
        let row = &snapshot.clock_row;
        let mut wrote = false;
        if evaluation.wrong_host_since != row.wrong_host_since {
            store::set_wrong_host_since(&mut tx, evaluation.wrong_host_since).await?;
            wrote = true;
        }
        match row.last_state.as_deref() {
            None => {
                store::set_state(&mut tx, phase, now).await?;
                tx.commit().await?;
            }
            Some(last) if last == phase => {
                let due = row
                    .max_seen_at
                    .is_none_or(|seen| now - seen >= clock::PERSIST_EVERY_MS);
                if due {
                    store::persist_mark(&mut tx, now).await?;
                }
                if due || wrote {
                    tx.commit().await?;
                }
            }
            Some(last) => {
                let rev = next_revision(&mut tx).await?;
                store::set_state(&mut tx, phase, now).await?;
                let license_id = evaluation
                    .license
                    .as_ref()
                    .map(|license| license.license_id.as_str());
                audit::record(
                    &mut tx,
                    &app.timestamp(),
                    Entry {
                        actor: Actor::System,
                        action: actions::LICENSE_STATE,
                        target_type: Some("license"),
                        target_id: license_id,
                        outcome: Outcome::Ok,
                        details: json!({
                            "from": last,
                            "to": phase,
                            "licenseId": license_id,
                            "effectiveAt": ms_text(now),
                            "clockBehindDays": snapshot.reading.behind_days(),
                            "clockAhead": snapshot.reading.ahead,
                        }),
                    },
                )
                .await?;
                commit_with_revision(tx, &app.revisions, rev).await?;
                tracing::info!(from = last, to = phase, "license state changed");
            }
        }
        Ok(())
    }

    /// [`Self::refresh`] after a write that may change the state (a file, the
    /// organization's INN, an import, the wizard): its failure is logged and
    /// left to the next minute's look, never to the write that is done.
    pub async fn refresh_after_write(&self, app: &AppState) {
        if let Err(error) = self.refresh(app).await {
            tracing::warn!(%error, "the license state was not refreshed");
        }
    }

    /// At the service's start (spec §3.4, §4.9): a site whose wizard ran
    /// before the build with the license starts its trial now; then the
    /// state, with the INN, is looked at and logged by its word and file id.
    pub async fn startup(&self, app: &AppState) {
        if let Err(error) = self.start_inner(app).await {
            tracing::warn!(%error, "the license could not be checked at start");
        }
    }

    async fn start_inner(&self, app: &AppState) -> Result<(), sqlx::Error> {
        let at = to_ms(app.now());
        let mut tx = begin_write(&app.pool).await?;
        sqlx::query(
            "UPDATE license_clock SET trial_started_at = ?, \
             trial_inn = (SELECT inn FROM org_profile WHERE id = 1) \
             WHERE id = 1 AND trial_started_at IS NULL \
             AND (SELECT initialized_at FROM site WHERE id = 1) IS NOT NULL",
        )
        .bind(at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.refresh(app).await?;
        let mut tx = app.pool.begin().await?;
        let snapshot = self.snapshot(app, &mut tx).await?;
        tx.rollback().await?;
        tracing::info!(
            state = snapshot.evaluation.phase.as_str(),
            license_id = snapshot
                .evaluation
                .license
                .as_ref()
                .map_or("none", |license| license.license_id.as_str()),
            "license state"
        );
        Ok(())
    }
```

Дописать в `apps/standalone/host/src/license/routes.rs` (и `DeviceLicense` — в импорт из `markiro_proto::license`):

```rust
/// The license line of `GET /v1/device`.
pub fn device_license(snapshot: &Snapshot) -> DeviceLicense {
    let evaluation = &snapshot.evaluation;
    DeviceLicense {
        state: evaluation.phase.as_str().to_owned(),
        since: ms_text(evaluation.since),
        phase_ends_at: evaluation.phase_ends_at.map(ms_text),
        emergency_until: evaluation.emergency_until.map(ms_text),
    }
}
```

В `load_license` (`routes.rs`) фрагмент:

```rust
    tracing::info!(
        license_id = %license.license_id,
        sequence = license.sequence,
        "a license file was loaded"
    );
    let mut answer = app.license.office_license_now(&app).await?;
```

заменить на:

```rust
    tracing::info!(
        license_id = %license.license_id,
        sequence = license.sequence,
        "a license file was loaded"
    );
    app.license.refresh_after_write(&app).await;
    let mut answer = app.license.office_license_now(&app).await?;
```

- [ ] **Step 4: Реализация — точки вызова**

Правка `apps/standalone/host/src/routes/devices.rs`:

Фрагмент:

```rust
pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read_info(&mut conn, &device).await.map(Json)
}
```

заменить на:

```rust
pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let mut info = read_info(&mut tx, &device).await?;
    // The site's license as the host computes it (plan ЛЦ-2): a station
    // explains a refusal before it asks.
    let snapshot = state
        .license
        .snapshot(&state, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    info.license = Some(crate::license::routes::device_license(&snapshot));
    Ok(Json(info))
}
```

Правка `apps/standalone/host/src/routes/org.rs`:

Фрагмент:

```rust
    let updated = read_org(&mut tx).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

заменить на:

```rust
    let updated = read_org(&mut tx).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // Another INN may no longer be the license's (plan ЛЦ-2, spec §4.9).
    state.license.refresh_after_write(&state).await;
    Ok(Json(updated))
}
```

Правка `apps/standalone/host/src/routes/cloud_import.rs` (модуль импорта ничего не пишет в журнал: вызов без своей строки журнала):

Фрагмент:

```rust
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(summary))
}
```

заменить на:

```rust
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // The import never writes the organization's INN; the license is looked
    // at again all the same (plan ЛЦ-2, spec §4.9).
    state.license.refresh_after_write(&state).await;
    Ok(Json(summary))
}
```

Правка `apps/standalone/host/src/routes/bootstrap.rs`:

Фрагмент:

```rust
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(BootstrapResponse {
```

заменить на:

```rust
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // The license's first look: the state later looks compare with (plan ЛЦ-2).
    state.license.refresh_after_write(&state).await;

    Ok(Json(BootstrapResponse {
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент:

```rust
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
```

заменить на:

```rust
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
    /// The license's minute look (plan ЛЦ-2); it ends with `stopping`.
    license: tokio::task::JoinHandle<()>,
```

Фрагмент:

```rust
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
        self.pool.close().await;
```

заменить на:

```rust
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
        let mut license = self.license;
        if tokio::time::timeout(SHUTDOWN_DEADLINE, &mut license)
            .await
            .is_err()
        {
            license.abort();
        }
        self.pool.close().await;
```

Фрагмент:

```rust
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
```

заменить на:

```rust
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
    // The license (plan ЛЦ-2): the trial of a site from before it, the state
    // and the INN at the start, then a look every minute.
    state.license.startup(&state).await;
    let license_ticker = license::spawn_ticker(state.clone(), stopping.subscribe());
```

Фрагмент:

```rust
        backups: backup_worker,
        pool,
        _lock: lock,
    })
```

заменить на:

```rust
        backups: backup_worker,
        license: license_ticker,
        pool,
        _lock: lock,
    })
```

- [ ] **Step 5: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_state --test license_load --test license_office --test bootstrap --test devices --test device_line --test pairing --test cloud_import --test feed_machine
```

Ожидается: PASS. Существующие тесты, сверяющие ревизию после правки профиля или импорта, не меняются: пересчёт без смены состояния ревизии не берёт.

- [ ] **Step 6: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/routes.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/routes/devices.rs apps/standalone/host/src/routes/org.rs apps/standalone/host/src/routes/cloud_import.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/tests/support/license.rs apps/standalone/host/tests/license_state.rs apps/standalone/host/tests/license_load.rs
git commit -F - <<'EOF'
feat(standalone): license state changes — rows and revisions, the start's check, the device's line, the INN after writes (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Закрытие открытия новых смен и аварийное продление

**Files:**

- Create: `apps/standalone/host/src/license/gate.rs`
- Modify: `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/license/routes.rs`, `apps/standalone/host/src/routes/device_shifts.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/support/license.rs`, `apps/standalone/host/tests/license_state.rs`
- Test: `apps/standalone/host/tests/license_gate.rs`

**Interfaces:**

- Consumes: `LicenseService::snapshot`, `Evaluation::{opens_new_shifts, emergency_used, emergency_key}`, `store::set_emergency`, `state::EMERGENCY_MS`.
- Produces: `license::gate::require_new_shifts(app, conn)` → `conflict` `license_restricted` (`details.state`, `since`); первый вход в запланированную смену и создание смены станцией закрыты в `restricted`, `trial_expired`, `inn_mismatch` (повтор создания с тем же `requestId` и повторный вход владельца — нет); `POST /v1/office/license/emergency` (администратор) → `OfficeLicense`, строка `license.emergency` `{ until, licenseId }`, ревизия; отказы `emergency_used`, `emergency_not_needed`; тестовые `support::app::device_shift_body`, `support::license::{expire, expired_file}`.

- [ ] **Step 1: Падающие тесты**

Дописать в `apps/standalone/host/tests/support/app.rs`:

```rust
/// The smallest shift a station creates on its own line with `request_id`.
pub fn device_shift_body(setup: &ShiftSetup, request_id: &str) -> Value {
    serde_json::json!({
        "requestId": request_id,
        "productId": setup.product,
        "boxTemplateId": setup.template,
        "productionDate": "2026-10-09"
    })
}
```

Дописать в `apps/standalone/host/tests/support/license.rs`:

```rust
/// Make `terms` a file that ended a day before the clock's start, issued a
/// month before it, without grace.
pub fn expire(terms: &mut Value) {
    terms["issuedAt"] = json!(START_MS - 30 * DAY_MS);
    terms["validFrom"] = json!(START_MS - 30 * DAY_MS);
    terms["validUntil"] = json!(START_MS - DAY_MS);
    terms["graceDays"] = json!(0);
}

/// `terms(host_id)` expired by [`expire`], signed.
pub fn expired_file(host_id: &str) -> String {
    file(host_id, expire)
}
```

Правка `apps/standalone/host/tests/license_state.rs` (помощник переехал в опору): удалить функцию `expired` целиком, в импорт `support::license` добавить `expired_file`, вызов `load_ok(&admin, &expired(&admin.app.state.host_id)).await;` заменить на `load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;`.

Создать `apps/standalone/host/tests/license_gate.rs`:

```rust
//! What a license that ran out closes and what it never does (plan ЛЦ-2,
//! spec §3.3, §3.5): the first entry into a planned shift and a station's
//! new shift are refused without a row or a revision; everything that runs
//! goes on; the emergency extension opens new shifts for 72 hours once per
//! file and once for the trial.

mod support;

use axum::http::StatusCode;
use markiro_host::audit::actions;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, audit_trail, box_id, close_from_office, device_shift_body,
    empty, fact, host_revision, instant, issue_block, json as json_request, ok_scan,
    open_floor, pair_device, plan_shift, receipts, record_id, request, shift_body,
    shift_setup, with_device, Admin, AuditRow,
};
use support::license::{
    expire, expired_file, file, license_id, load_ok, office_license, set_org_inn, text,
    DAY_MS, OTHER_INN, START_MS,
};

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const HOURS_72_MS: i64 = 72 * 60 * 60 * 1000;

async fn device_call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

async fn put_on_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) =
        device_call(admin, key, "PUT", "/v1/device/line", Some(json!({ "lineId": line }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn enter(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(admin, key, "POST", &path, None).await
}

fn restricted(state: &str, since: i64) -> Value {
    json!({ "constraint": "license_restricted", "state": state, "since": text(since) })
}

fn refusal(body: &Value) -> (Value, Value) {
    (body["error"]["code"].clone(), body["error"]["details"].clone())
}

#[tokio::test]
async fn a_planned_shift_does_not_open_and_a_station_creates_none_while_restricted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    // Planning is never closed: the plan opens once a file is loaded.
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let expected = (json!("conflict"), restricted("restricted", START_MS - DAY_MS));
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!((status, refusal(&body)), (StatusCode::CONFLICT, expected.clone()));
    let (status, body) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_shift_body(&setup, REQUEST)),
    )
    .await;
    assert_eq!((status, refusal(&body)), (StatusCode::CONFLICT, expected));
    assert_eq!(
        (audit_rows(&admin.app).await, host_revision(&admin.app).await),
        (rows, rev)
    );
}

#[tokio::test]
async fn what_runs_goes_on_while_restricted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_shift_body(&setup, REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    assert_eq!(office_license(&admin).await["state"], "restricted");
    // The owner enters its open shift again (a station that lost its database).
    let open = json!({ "id": floor.shift });
    let (status, body) = enter(&admin, &floor.key, &open).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // A create retried after a lost answer answers the shift it made.
    let (status, again) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_shift_body(&setup, REQUEST)),
    )
    .await;
    assert_eq!((status, again["id"].clone()), (StatusCode::OK, created["id"].clone()));
    // Numbers, facts, the office's plans, close and export, the feed.
    issue_block(&admin.app, &floor.key, "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910").await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(1), "scan", &floor.shift, ok_scan(1, &box_id(1), &instant(1, 0)))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    plan_shift(&admin, shift_body(&setup)).await;
    close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    let (status, _) = admin
        .call("GET", &format!("/v1/office/shifts/{}/export-source", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = device_call(&admin, &floor.key, "GET", "/v1/changes?since=0", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_trial_ends_after_fourteen_days_and_closes_the_opening() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    admin.app.clock.advance(time::Duration::days(14));
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), restricted("trial_expired", START_MS + 14 * DAY_MS))
        )
    );
}

#[tokio::test]
async fn an_inn_that_no_longer_matches_closes_the_opening() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, refusal(&body)),
        (StatusCode::CONFLICT, (json!("conflict"), restricted("inn_mismatch", START_MS)))
    );
}

#[tokio::test]
async fn the_emergency_opens_new_shifts_for_72_hours_once_per_file() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    let (status, body) = admin.call("POST", "/v1/office/license/emergency", None).await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("emergency_not_needed"))
    );
    load_ok(&admin, &expired_file(&host)).await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(&tech, "POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin.call("POST", "/v1/office/license/emergency", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = text(START_MS + HOURS_72_MS);
    assert_eq!(
        (body["state"].clone(), body["opensNewShifts"].clone(), body["emergency"].clone()),
        (
            json!("restricted"),
            json!(true),
            json!({ "available": false, "until": until })
        )
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_EMERGENCY).await,
        [admin.row(
            actions::LICENSE_EMERGENCY,
            "license",
            &license_id(1),
            json!({ "until": until, "licenseId": license_id(1) })
        )]
    );
    // The station sees it before it asks, and opens.
    let (_, device) = device_call(&admin, &admin.key, "GET", "/v1/device", None).await;
    assert_eq!(device["license"]["emergencyUntil"], json!(until));
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(enter(&admin, &admin.key, &shift).await.0, StatusCode::OK);
    // Once per file.
    let (status, body) = admin.call("POST", "/v1/office/license/emergency", None).await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("emergency_used"))
    );
    // After 72 hours new shifts close again.
    admin.app.clock.advance(time::Duration::hours(72));
    let (_, other_key) = pair_device(&admin.app, "station").await;
    put_on_line(&admin, &other_key, &setup.other_line).await;
    let mut body = shift_body(&setup);
    body["lineId"] = json!(setup.other_line);
    let other = plan_shift(&admin, body).await;
    assert_eq!(enter(&admin, &other_key, &other).await.0, StatusCode::CONFLICT);
    // A newer file, expired too, has an emergency of its own.
    load_ok(
        &admin,
        &file(&host, |terms| {
            expire(terms);
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
        }),
    )
    .await;
    let (status, body) = admin.call("POST", "/v1/office/license/emergency", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["emergency"]["until"], text(START_MS + 2 * HOURS_72_MS));
    assert_eq!(enter(&admin, &other_key, &other).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_trials_emergency_is_its_own() {
    let admin = admin().await;
    admin.app.clock.advance(time::Duration::days(14));
    let (status, body) = admin.call("POST", "/v1/office/license/emergency", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = text(START_MS + 14 * DAY_MS + HOURS_72_MS);
    let row: AuditRow = (
        "office_user".to_owned(),
        Some(admin.id.clone()),
        actions::LICENSE_EMERGENCY.to_owned(),
        Some("license".to_owned()),
        None,
        "ok".to_owned(),
        json!({ "until": until, "licenseId": "trial" }),
    );
    assert_eq!(audit_trail(&admin.app, actions::LICENSE_EMERGENCY).await, [row]);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_gate
```

Ожидается: FAIL — вход и создание отвечают `200` в `restricted`, маршрут продления — `404`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/src/license/gate.rs`:

```rust
//! The gate of new shifts (spec §3.3): the one move a license that ran out
//! closes is a planned shift's opening, and a station's new shift (one it
//! could not open). Everything that runs goes on.

use markiro_proto::license::constraints;
use serde_json::json;
use sqlx::SqliteConnection;

use super::ms_text;
use crate::error::ApiError;
use crate::server::AppState;

/// New shifts open (the state, or an emergency extension that runs); else
/// `conflict` on `license_restricted` with the state and since when. A
/// refusal writes no row, like every refused write of a station.
pub async fn require_new_shifts(
    app: &AppState,
    conn: &mut SqliteConnection,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, conn)
        .await
        .map_err(ApiError::internal)?;
    let evaluation = &snapshot.evaluation;
    if evaluation.opens_new_shifts {
        return Ok(());
    }
    Err(ApiError::conflict(
        constraints::LICENSE_RESTRICTED,
        "new shifts do not open under the site's license",
    )
    .with_details(json!({
        "constraint": constraints::LICENSE_RESTRICTED,
        "state": evaluation.phase.as_str(),
        "since": ms_text(evaluation.since),
    })))
}
```

Правка `apps/standalone/host/src/license/mod.rs`:

Фрагмент:

```rust
pub mod clock;
pub mod routes;
```

заменить на:

```rust
pub mod clock;
pub mod gate;
pub mod routes;
```

Правка `apps/standalone/host/src/routes/device_shifts.rs`:

Фрагмент:

```rust
    if let Some(id) = repeated {
        // Nothing to write: the transaction rolls back when dropped.
        return read(&mut tx, &id)
            .await?
            .map(Json)
            .ok_or_else(|| ApiError::internal("shift vanished"));
    }
```

заменить на:

```rust
    if let Some(id) = repeated {
        // Nothing to write: the transaction rolls back when dropped.
        return read(&mut tx, &id)
            .await?
            .map(Json)
            .ok_or_else(|| ApiError::internal("shift vanished"));
    }
    // A new shift the station could not open (plan ЛЦ-2, spec §3.3): a
    // retried create above still answers the shift it made.
    crate::license::gate::require_new_shifts(&state, &mut tx).await?;
```

Фрагмент:

```rust
        None => {
            shifts::snapshot(
```

заменить на:

```rust
        None => {
            // Opening is the one move a license that ran out closes (plan
            // ЛЦ-2, spec §3.3); the owner's entry again above never is.
            crate::license::gate::require_new_shifts(&state, &mut tx).await?;
            shifts::snapshot(
```

Дописать в `apps/standalone/host/src/license/routes.rs` (в импорт: `markiro_proto::license::constraints`; `crate::db::begin_write`, `commit_with_revision`, `next_revision` уже есть):

```rust
/// `POST /v1/office/license/emergency` (administrators, spec §3.5): new
/// shifts open 72 hours more, once per file and once for the trial. A
/// repeat is `emergency_used`, a state that opens new shifts
/// `emergency_not_needed`; neither writes a row.
pub async fn enable_emergency(
    State(app): State<AppState>,
    context: OfficeContext,
) -> Result<Json<OfficeLicense>, ApiError> {
    context.require_admin()?;
    let at = app.timestamp();
    let mut tx = begin_write(&app.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let evaluation = &snapshot.evaluation;
    if evaluation.emergency_used {
        return Err(ApiError::conflict(
            constraints::EMERGENCY_USED,
            "the emergency extension of this license was used",
        ));
    }
    if evaluation.opens_new_shifts {
        return Err(ApiError::conflict(
            constraints::EMERGENCY_NOT_NEEDED,
            "new shifts open: there is nothing to extend",
        ));
    }
    let until = snapshot.reading.effective + state::EMERGENCY_MS;
    store::set_emergency(&mut tx, &evaluation.emergency_key, until)
        .await
        .map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LICENSE_EMERGENCY,
            target_type: Some("license"),
            target_id: evaluation
                .license
                .as_ref()
                .map(|license| license.license_id.as_str()),
            outcome: Outcome::Ok,
            details: json!({ "until": ms_text(until), "licenseId": evaluation.emergency_key }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &app.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    app.license.office_license_now(&app).await.map(Json)
}
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент:

```rust
        .route(
            "/v1/office/license/activation-request",
            get(crate::license::routes::activation_request),
        )
}
```

заменить на:

```rust
        .route(
            "/v1/office/license/activation-request",
            get(crate::license::routes::activation_request),
        )
        .route(
            "/v1/office/license/emergency",
            post(crate::license::routes::enable_emergency),
        )
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_gate --test license_state --test device_shifts --test office_shifts --test facts --test floor_scenario
```

Ожидается: PASS (существующие тесты смен идут в пробном периоде: новые смены открываются).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/gate.rs apps/standalone/host/src/license/mod.rs apps/standalone/host/src/license/routes.rs apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/support/license.rs apps/standalone/host/tests/license_state.rs apps/standalone/host/tests/license_gate.rs
git commit -F - <<'EOF'
feat(standalone): a license that ran out closes only new shifts; the 72-hour emergency extension (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Рабочие места — сопряжение, пользователи офиса, линии; превышение ничего не отключает

**Files:**

- Modify: `apps/standalone/host/src/license/seats.rs`, `apps/standalone/host/src/routes/pairing.rs`, `apps/standalone/host/src/routes/office_users.rs`, `apps/standalone/host/src/routes/lines.rs`
- Test: `apps/standalone/host/tests/license_seats.rs`

**Interfaces:**

- Consumes: `seats::{usage, Quota, seat_of}`, `LicenseService::snapshot`.
- Produces: `seats::require_seat(app, conn, quota)` → `conflict` `seat_limit` `{ quota, used, limit }`; места проверяются в транзакции записи: `local_pair` и `claim` (станции и ТСД — один пул `stations`, ПК офиса — без места; в `claim` — до траты кода), создание пользователя и его включение (`cabinetUsers`), создание линии и снятие с архива (`lines`). Отказ строк аудита не пишет.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/license_seats.rs`:

```rust
//! The license's seats (plan ЛЦ-2, spec §4.7): stations and handhelds share
//! the `stations` pool, office users and lines have their own; an addition
//! beyond the file is refused without a row, and nothing that runs is ever
//! disconnected, not even over the limit.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, empty, json as json_request, pair_device, request, with_device, Admin,
};
use support::license::{claim_device, file, load_ok, office_license, pairing_code};

fn quota(host: &str, key: &str, limit: u32) -> String {
    file(host, |terms| terms["quotas"][key] = json!(limit))
}

fn seat_limit(quota: &str, used: u32, limit: u32) -> Value {
    json!({ "constraint": "seat_limit", "quota": quota, "used": used, "limit": limit })
}

async fn local_pair(admin: &Admin, kind: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            request("POST", "/v1/local-pair"),
            json!({ "kind": kind, "name": "Ещё устройство", "appVersion": "0.1.0" }),
        ))
        .await
}

fn refused_with(answer: &(StatusCode, Value)) -> (StatusCode, Value) {
    (answer.0, answer.1["error"]["details"].clone())
}

#[tokio::test]
async fn stations_and_handhelds_share_the_stations_pool_and_a_refused_device_keeps_its_code() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    load_ok(&admin, &quota(&host, "stations", 3)).await;
    assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    let code = pairing_code(&admin).await;
    let (status, handheld) = claim_device(&admin, &code, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{handheld}");
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        refused_with(&local_pair(&admin, "station").await),
        (StatusCode::CONFLICT, seat_limit("stations", 3, 3))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // An office PC takes no seat: its seats are its users.
    assert_eq!(local_pair(&admin, "office").await.0, StatusCode::OK);
    let code = pairing_code(&admin).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        refused_with(&claim_device(&admin, &code, "station").await),
        (StatusCode::CONFLICT, seat_limit("stations", 3, 3))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Revoking a device frees its seat at once; the refused claim kept the code.
    let revoke = format!(
        "/v1/office/devices/{}/revoke",
        handheld["deviceId"].as_str().unwrap()
    );
    assert_eq!(admin.call("POST", &revoke, None).await.0, StatusCode::OK);
    let (status, body) = claim_device(&admin, &code, "station").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn the_trial_and_a_quota_of_null_limit_nothing() {
    let admin = admin().await;
    for _ in 0..4 {
        assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    }
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    assert_eq!(
        office_license(&admin).await["quotas"]["stations"],
        json!({ "limit": null, "used": 6, "over": false })
    );
}

#[tokio::test]
async fn a_smaller_file_flags_the_quota_and_disconnects_nothing() {
    let admin = admin().await;
    let (_, second) = pair_device(&admin.app, "station").await;
    let (_, third) = pair_device(&admin.app, "station").await;
    let body = load_ok(&admin, &quota(&admin.app.state.host_id, "stations", 1)).await;
    assert_eq!(body["warnings"], json!(["over_limit"]));
    assert_eq!(
        body["quotas"]["stations"],
        json!({ "limit": 1, "used": 3, "over": true })
    );
    for key in [admin.key.as_str(), second.as_str(), third.as_str()] {
        for path in ["/v1/device", "/v1/changes?since=0"] {
            let (status, answer) = admin
                .app
                .send(empty(with_device(request("GET", path), key)))
                .await;
            assert_eq!(status, StatusCode::OK, "{path}: {answer}");
        }
    }
    assert_eq!(
        refused_with(&local_pair(&admin, "station").await),
        (StatusCode::CONFLICT, seat_limit("stations", 3, 1))
    );
}

#[tokio::test]
async fn office_users_and_their_return_take_cabinet_seats() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "cabinetUsers", 2)).await;
    let create = |login: &str| {
        json!({
            "login": login, "name": "Павел Орлов", "role": "technologist",
            "password": "technologist password"
        })
    };
    let (status, first) = admin
        .call("POST", "/v1/office/users", Some(create("first")))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        refused_with(&admin.call("POST", "/v1/office/users", Some(create("second"))).await),
        (StatusCode::CONFLICT, seat_limit("cabinetUsers", 2, 2))
    );
    let path = format!("/v1/office/users/{}", first["id"].as_str().unwrap());
    let update = |user: &Value, active: bool, name: &str| {
        json!({ "name": name, "role": "technologist", "active": active, "expectedRev": user["rev"] })
    };
    // Turning one off frees its seat; turning it on again takes one.
    let (status, first) = admin
        .call("PUT", &path, Some(update(&first, false, "Павел Орлов")))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, second) = admin
        .call("POST", "/v1/office/users", Some(create("second")))
        .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(
        refused_with(&admin.call("PUT", &path, Some(update(&first, true, "Павел Орлов"))).await),
        (StatusCode::CONFLICT, seat_limit("cabinetUsers", 2, 2))
    );
    // A rename of a user who stays off takes none.
    let (status, renamed) = admin
        .call("PUT", &path, Some(update(&first, false, "Павел Орлов-Смирнов")))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
}

#[tokio::test]
async fn lines_and_their_return_from_the_archive_take_line_seats() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "lines", 2)).await;
    let create = json!({ "name": "Линия 3" });
    assert_eq!(
        refused_with(&admin.call("POST", "/v1/office/lines", Some(create.clone())).await),
        (StatusCode::CONFLICT, seat_limit("lines", 2, 2))
    );
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let second = lines
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["name"] == "Линия 2")
        .unwrap()
        .clone();
    let path = format!("/v1/office/lines/{}", second["id"].as_str().unwrap());
    let (status, archived) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": second["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, third) = admin.call("POST", "/v1/office/lines", Some(create)).await;
    assert_eq!(status, StatusCode::OK, "{third}");
    assert_eq!(
        refused_with(
            &admin
                .call(
                    "PUT",
                    &path,
                    Some(json!({ "archived": false, "expectedRev": archived["rev"] })),
                )
                .await
        ),
        (StatusCode::CONFLICT, seat_limit("lines", 2, 2))
    );
    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Линия 2 (старая)", "expectedRev": archived["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_seats
```

Ожидается: FAIL — добавления сверх квоты отвечают `200`; `the_trial_and_a_quota_of_null_limit_nothing` и `a_smaller_file…` до последней проверки — PASS.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/license/seats.rs`:

Фрагмент:

```rust
use markiro_proto::DeviceKind;
use sqlx::SqliteConnection;

use super::state::Quotas;
```

заменить на:

```rust
use markiro_proto::license::constraints;
use markiro_proto::DeviceKind;
use serde_json::json;
use sqlx::SqliteConnection;

use super::state::Quotas;
use crate::error::ApiError;
use crate::server::AppState;
```

Дописать в конец `apps/standalone/host/src/license/seats.rs`:

```rust
/// A seat of `quota` is free under the license (spec §4.7); else `conflict`
/// on `seat_limit` with the quota, what is used and the limit. Called inside
/// the writer's transaction (`BEGIN IMMEDIATE`), so two additions cannot both
/// take the last seat. A refusal writes no row.
pub async fn require_seat(
    app: &AppState,
    conn: &mut SqliteConnection,
    quota: Quota,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, &mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(limit) = quota.limit(&snapshot.evaluation.quotas) else {
        return Ok(());
    };
    let used = quota.used(&usage(&mut *conn).await.map_err(ApiError::internal)?);
    if used < limit {
        return Ok(());
    }
    Err(
        ApiError::conflict(constraints::SEAT_LIMIT, "every seat of the license is taken")
            .with_details(json!({
                "constraint": constraints::SEAT_LIMIT,
                "quota": quota.key(),
                "used": used,
                "limit": limit,
            })),
    )
}
```

Правка `apps/standalone/host/src/routes/pairing.rs`:

Фрагмент:

```rust
    let id = uuid::Uuid::new_v4().to_string();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let key = insert_device(
```

заменить на:

```rust
    let id = uuid::Uuid::new_v4().to_string();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A seat of the license (plan ЛЦ-2, spec §4.7); an office PC takes none.
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
        crate::license::seats::require_seat(&state, &mut tx, quota).await?;
    }
    let key = insert_device(
```

Фрагмент:

```rust
    sqlx::query("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&code.id)
```

заменить на:

```rust
    // The license's seat (plan ЛЦ-2, spec §4.7), before the code is used up:
    // a refused device keeps the code for its next try, and the refusal
    // writes no row.
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
        crate::license::seats::require_seat(&state, &mut tx, quota).await?;
    }
    sqlx::query("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&code.id)
```

Правка `apps/standalone/host/src/routes/office_users.rs`:

Фрагмент:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
```

заменить на:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // A seat of the license (plan ЛЦ-2): office users, not office PCs.
    crate::license::seats::require_seat(
        &state,
        &mut tx,
        crate::license::seats::Quota::CabinetUsers,
    )
    .await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
```

Фрагмент:

```rust
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        (
            "role",
```

заменить на:

```rust
    // Turning a user on again takes a seat of the license (plan ЛЦ-2).
    if update.active && !current.active {
        crate::license::seats::require_seat(
            &state,
            &mut tx,
            crate::license::seats::Quota::CabinetUsers,
        )
        .await?;
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        (
            "role",
```

Правка `apps/standalone/host/src/routes/lines.rs`:

Фрагмент:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
```

заменить на:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // A seat of the license (plan ЛЦ-2): lines that are not archived.
    crate::license::seats::require_seat(&state, &mut tx, crate::license::seats::Quota::Lines)
        .await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
```

Фрагмент:

```rust
    let archived = update.archived.unwrap_or(current.archived);
```

заменить на:

```rust
    let archived = update.archived.unwrap_or(current.archived);
    // A line back from the archive takes a seat of the license (plan ЛЦ-2).
    if current.archived && !archived {
        crate::license::seats::require_seat(&state, &mut tx, crate::license::seats::Quota::Lines)
            .await?;
    }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_seats --test pairing --test pairing_codes --test claim --test office_admin --test lines --test devices
```

Ожидается: PASS (пробный период мест не ограничивает).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/seats.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/src/routes/office_users.rs apps/standalone/host/src/routes/lines.rs apps/standalone/host/tests/license_seats.rs
git commit -F - <<'EOF'
feat(standalone): the license's seats at pairing, office users and lines; over the limit nothing is disconnected (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 11: Возможности — ТСД, паллеты, редактор шаблонов

**Files:**

- Modify: `apps/standalone/host/src/license/seats.rs`, `apps/standalone/host/src/routes/pairing.rs`, `apps/standalone/host/src/routes/office_shifts.rs`, `apps/standalone/host/src/routes/device_shifts.rs`, `apps/standalone/host/src/routes/templates.rs`
- Test: `apps/standalone/host/tests/license_features.rs`

**Interfaces:**

- Consumes: `LicenseService::snapshot`, `state::Features`.
- Produces: `seats::{Feature, require_feature}` → `conflict` `feature_disabled` `{ feature }`; `handheld` — сопряжение ТСД кодом (до траты кода); `pallets` — план и создание смены с паллетами и включение паллет в плане; `labelEditor` — создание шаблона и правка его имени или макета. Открытие запланированной смены с паллетами, правка прочих полей, включение и выключение шаблона, печать — не закрываются (Д8).

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/license_features.rs`:

```rust
//! The license's features (plan ЛЦ-2, spec §4.7, ЛО23): `handheld`,
//! `pallets` and `labelEditor` refuse new actions only; what was planned or
//! made before keeps working.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, device_shift_body, empty, json as json_request, office_template,
    pallet_shift_body, pallet_template, plan_shift, request, shift_body, shift_setup,
    with_device, Admin,
};
use support::license::{claim_device, file, load_ok, pairing_code};

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

fn without(host: &str, feature: &str) -> String {
    file(host, |terms| terms["features"][feature] = json!(false))
}

fn disabled(feature: &str) -> (StatusCode, Value) {
    (
        StatusCode::CONFLICT,
        json!({ "constraint": "feature_disabled", "feature": feature }),
    )
}

fn refused(answer: (StatusCode, Value)) -> (StatusCode, Value) {
    (answer.0, answer.1["error"]["details"].clone())
}

async fn device_call(
    admin: &Admin,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), &admin.key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

#[tokio::test]
async fn a_handheld_pairs_only_with_the_feature_and_keeps_the_code() {
    let admin = admin().await;
    load_ok(&admin, &without(&admin.app.state.host_id, "handheld")).await;
    let code = pairing_code(&admin).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        refused(claim_device(&admin, &code, "handheld").await),
        disabled("handheld")
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, body) = claim_device(&admin, &code, "station").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn pallets_are_refused_to_new_plans_and_kept_by_the_plans_that_have_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let planned = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    load_ok(&admin, &without(&admin.app.state.host_id, "pallets")).await;
    assert_eq!(
        refused(
            admin
                .call("POST", "/v1/office/shifts", Some(pallet_shift_body(&setup, &template)))
                .await
        ),
        disabled("pallets")
    );
    assert_eq!(
        admin
            .call("POST", "/v1/office/shifts", Some(shift_body(&setup)))
            .await
            .0,
        StatusCode::OK
    );
    let plain_path = format!("/v1/office/shifts/{}", plain["id"].as_str().unwrap());
    assert_eq!(
        refused(
            admin
                .call(
                    "PUT",
                    &plain_path,
                    Some(json!({
                        "palletsEnabled": true, "palletTemplateId": template,
                        "expectedRev": plain["rev"]
                    })),
                )
                .await
        ),
        disabled("pallets")
    );
    let planned_path = format!("/v1/office/shifts/{}", planned["id"].as_str().unwrap());
    let (status, edited) = admin
        .call(
            "PUT",
            &planned_path,
            Some(json!({ "plannedQty": 120, "expectedRev": planned["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["palletsEnabled"], true);
    let (status, moved) = device_call(
        &admin,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let mut create = device_shift_body(&setup, REQUEST);
    create["palletsEnabled"] = json!(true);
    create["palletTemplateId"] = json!(template);
    assert_eq!(
        refused(device_call(&admin, "POST", "/v1/device/shifts", Some(create)).await),
        disabled("pallets")
    );
    let enter = format!("/v1/device/shifts/{}/enter", planned["id"].as_str().unwrap());
    let (status, entered) = device_call(&admin, "POST", &enter, None).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
}

#[tokio::test]
async fn templates_are_made_and_edited_only_with_the_label_editor() {
    let admin = admin().await;
    let id = office_template(&admin, "pallet", true, Value::Null).await;
    load_ok(&admin, &without(&admin.app.state.host_id, "labelEditor")).await;
    let layout = json!({
        "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": []
    });
    // A new template is refused: an import and a copy are new ones too.
    assert_eq!(
        refused(
            admin
                .call(
                    "POST",
                    "/v1/office/templates",
                    Some(json!({
                        "name": "Импорт", "purpose": "pallet", "enabled": true,
                        "chzProductGroupCodes": null, "spec": layout
                    })),
                )
                .await
        ),
        disabled("labelEditor")
    );
    let path = format!("/v1/office/templates/{id}");
    let (_, current) = admin.call("GET", &path, None).await;
    let mut other_layout = layout.clone();
    other_layout["heightMm"] = json!(100);
    for edit in [
        json!({ "name": "Другое имя", "expectedRev": current["rev"] }),
        json!({ "spec": other_layout, "expectedRev": current["rev"] }),
    ] {
        assert_eq!(
            refused(admin.call("PUT", &path, Some(edit)).await),
            disabled("labelEditor")
        );
    }
    // Turning it off is no edit of its layout.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "enabled": false, "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_features
```

Ожидается: FAIL — ТСД, паллеты и шаблоны принимаются (`200`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/license/seats.rs`:

Фрагмент:

```rust
use super::state::Quotas;
```

заменить на:

```rust
use super::state::{Features, Quotas};
```

Дописать в конец файла:

```rust
/// A feature of the file (spec §4.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    LabelEditor,
    PublicApi,
    Pallets,
    ChzIntegration,
    Inventory,
    CommerceMl,
    Handheld,
}

impl Feature {
    /// The file's and the cloud's name.
    pub fn key(self) -> &'static str {
        match self {
            Feature::LabelEditor => "labelEditor",
            Feature::PublicApi => "publicApi",
            Feature::Pallets => "pallets",
            Feature::ChzIntegration => "chzIntegration",
            Feature::Inventory => "inventory",
            Feature::CommerceMl => "commerceMl",
            Feature::Handheld => "handheld",
        }
    }

    pub fn enabled(self, features: &Features) -> bool {
        match self {
            Feature::LabelEditor => features.label_editor,
            Feature::PublicApi => features.public_api,
            Feature::Pallets => features.pallets,
            Feature::ChzIntegration => features.chz_integration,
            Feature::Inventory => features.inventory,
            Feature::CommerceMl => features.commerce_ml,
            Feature::Handheld => features.handheld,
        }
    }
}

/// The license includes `feature`; else `conflict` on `feature_disabled`
/// with its name. Only new actions ask (ЛО23): what runs never does. A
/// refusal writes no row.
pub async fn require_feature(
    app: &AppState,
    conn: &mut SqliteConnection,
    feature: Feature,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, conn)
        .await
        .map_err(ApiError::internal)?;
    if feature.enabled(&snapshot.evaluation.features) {
        return Ok(());
    }
    Err(ApiError::conflict(
        constraints::FEATURE_DISABLED,
        "the site's license does not include this feature",
    )
    .with_details(json!({
        "constraint": constraints::FEATURE_DISABLED,
        "feature": feature.key(),
    })))
}
```

Правка `apps/standalone/host/src/routes/pairing.rs`:

Фрагмент:

```rust
    // The license's seat (plan ЛЦ-2, spec §4.7), before the code is used up:
    // a refused device keeps the code for its next try, and the refusal
    // writes no row.
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
```

заменить на:

```rust
    // The license's seat and features (plan ЛЦ-2, spec §4.7), before the
    // code is used up: a refused device keeps the code for its next try, and
    // the refusal writes no row.
    if request.kind == DeviceKind::Handheld {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Handheld,
        )
        .await?;
    }
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
```

Правка `apps/standalone/host/src/routes/office_shifts.rs`:

Фрагмент:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    require_active_line(&mut tx, &create.line_id).await?;
```

заменить на:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    // Pallets are a feature of the license (plan ЛЦ-2): a new plan with them asks.
    if create.pallets_enabled {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Pallets,
        )
        .await?;
    }
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    require_active_line(&mut tx, &create.line_id).await?;
```

Фрагмент:

```rust
    let pallets_enabled = update.pallets_enabled.unwrap_or(current.pallets_enabled);
```

заменить на:

```rust
    let pallets_enabled = update.pallets_enabled.unwrap_or(current.pallets_enabled);
    // Pallets turned on in a plan ask the license (plan ЛЦ-2); a plan that
    // has them keeps them.
    if pallets_enabled && !current.pallets_enabled {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Pallets,
        )
        .await?;
    }
```

Правка `apps/standalone/host/src/routes/device_shifts.rs`:

Фрагмент:

```rust
    // A new shift the station could not open (plan ЛЦ-2, spec §3.3): a
    // retried create above still answers the shift it made.
    crate::license::gate::require_new_shifts(&state, &mut tx).await?;
```

заменить на:

```rust
    // A new shift the station could not open (plan ЛЦ-2, spec §3.3): a
    // retried create above still answers the shift it made.
    crate::license::gate::require_new_shifts(&state, &mut tx).await?;
    if create.pallets_enabled {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Pallets,
        )
        .await?;
    }
```

Правка `apps/standalone/host/src/routes/templates.rs`:

Фрагмент:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    templates::check_groups(&mut tx, "chzProductGroupCodes", codes).await?;
```

заменить на:

```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    // A new template (an import and a copy too) is the label editor's,
    // a feature of the license (plan ЛЦ-2).
    crate::license::seats::require_feature(
        &state,
        &mut tx,
        crate::license::seats::Feature::LabelEditor,
    )
    .await?;
    templates::check_groups(&mut tx, "chzProductGroupCodes", codes).await?;
```

Фрагмент:

```rust
    let spec_changed = update
        .spec
        .as_ref()
        .is_some_and(|spec| *spec != current.spec);
```

заменить на:

```rust
    let spec_changed = update
        .spec
        .as_ref()
        .is_some_and(|spec| *spec != current.spec);
    // A new name or layout is an edit of the label editor (plan ЛЦ-2); the
    // flag and the categories are not, and printing never asks.
    if spec_changed || name != current.name {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::LabelEditor,
        )
        .await?;
    }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_features --test templates --test office_shifts --test device_shifts --test pallet_facts --test claim --test pairing_codes
```

Ожидается: PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/seats.rs apps/standalone/host/src/routes/pairing.rs apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/templates.rs apps/standalone/host/tests/license_features.rs
git commit -F - <<'EOF'
feat(standalone): the license's features — handhelds, pallets, the label editor — for new actions only (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 12: Отметка пробного периода в реестре Windows

**Files:**

- Modify: `apps/standalone/host/src/license/trial_mark.rs`, `apps/standalone/host/src/license/mod.rs`, `apps/standalone/host/src/install.rs`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/routes/bootstrap.rs`, `apps/standalone/host/tests/support/app.rs`
- Test: модульные тесты в `apps/standalone/host/src/license/trial_mark.rs`, `apps/standalone/host/tests/license_trial.rs`, `apps/standalone/host/tests/install.rs`

**Interfaces:**

- Consumes: `install::{Commands, CommandOutput, run_checked, powershell_args, system_program, SystemCommands}`, `clock::parse_timestamp`, `store::clock_row`.
- Produces: `trial_mark::{TRIAL_KEY_PATH, query_args, add_args, registry_value, RegistryMark, system}`; `install::trial_key_script()` и его запуск первым шагом `install_host` (лучшее усилие); `system_program("reg.exe", root)` → `<root>\System32\reg.exe`; `LicenseService::after_bootstrap`; старт читает отметку один раз и пишет её, если её нет; `crate::start` берёт `trial_mark::system()`; тестовый `support::app::admin_of` (публичный).

- [ ] **Step 1: Падающие тесты**

Модульные тесты в конец `apps/standalone/host/src/license/trial_mark.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{CommandOutput, InstallError};

    /// `reg.exe` answering `code` and `stdout`; from run number `fail_from`
    /// on (counting from 1), code 1.
    #[derive(Default)]
    struct Fake {
        runs: Vec<(String, Vec<String>)>,
        code: i32,
        stdout: Vec<u8>,
        fail_from: Option<usize>,
    }

    impl Commands for Fake {
        fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
            self.runs.push((program.to_owned(), args.to_vec()));
            let failing = self.fail_from.is_some_and(|from| self.runs.len() >= from);
            Ok(CommandOutput {
                code: Some(if failing { 1 } else { self.code }),
                stdout: self.stdout.clone(),
            })
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_mark_is_the_value_reg_query_prints() {
        let stdout = b"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Markiro\\Standalone\\Trial\r\n    StartedAt    REG_SZ    2026-10-20T09:00:00Z\r\n\r\n".to_vec();
        let mark = RegistryMark::new(Fake {
            stdout,
            ..Fake::default()
        });
        let expected = super::super::to_ms(
            crate::clock::parse_timestamp("2026-10-20T09:00:00Z").unwrap(),
        );
        assert_eq!(mark.started_at(), Some(expected));
        assert_eq!(
            mark.commands.lock().unwrap().runs,
            [(
                "reg.exe".to_owned(),
                strings(&["query", TRIAL_KEY_PATH, "/v", "StartedAt"])
            )]
        );
    }

    #[test]
    fn no_value_or_one_that_does_not_read_is_no_mark() {
        let missing = RegistryMark::new(Fake {
            code: 1,
            ..Fake::default()
        });
        assert_eq!(missing.started_at(), None);
        let garbled = RegistryMark::new(Fake {
            stdout: b"    StartedAt    REG_SZ    yesterday\r\n".to_vec(),
            ..Fake::default()
        });
        assert_eq!(garbled.started_at(), None);
    }

    #[test]
    fn the_mark_writes_its_values_and_stops_at_a_refusal() {
        let mark = RegistryMark::new(Fake::default());
        let started_at = super::super::to_ms(
            crate::clock::parse_timestamp("2026-10-20T09:00:00Z").unwrap(),
        );
        let written = Mark {
            started_at,
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".to_owned(),
            inn: Some("7707083893".to_owned()),
        };
        mark.write(&written).unwrap();
        let add = |name: &str, value: &str| ("reg.exe".to_owned(), add_args(name, value));
        assert_eq!(
            mark.commands.lock().unwrap().runs,
            [
                add("StartedAt", "2026-10-20T09:00:00Z"),
                add("HostId", "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"),
                add("Inn", "7707083893"),
            ]
        );
        assert_eq!(
            add_args("Inn", "7707083893"),
            strings(&[
                "add", TRIAL_KEY_PATH, "/v", "Inn", "/t", "REG_SZ", "/d", "7707083893", "/f"
            ])
        );
        let without_inn = RegistryMark::new(Fake::default());
        without_inn
            .write(&Mark {
                inn: None,
                ..written.clone()
            })
            .unwrap();
        assert_eq!(without_inn.commands.lock().unwrap().runs.len(), 2);
        let refusing = RegistryMark::new(Fake {
            fail_from: Some(2),
            ..Fake::default()
        });
        assert!(refusing.write(&written).is_err());
        assert_eq!(refusing.commands.lock().unwrap().runs.len(), 2);
    }
}
```

Правка `apps/standalone/host/tests/support/app.rs`:

Фрагмент:

```rust
async fn admin_of(app: TestApp) -> Admin {
```

заменить на:

```rust
/// `admin()` on `app`: a station pairs, runs the wizard and stays signed in.
pub async fn admin_of(app: TestApp) -> Admin {
```

Создать `apps/standalone/host/tests/license_trial.rs`:

```rust
//! The trial's mark outside the database (plan ЛЦ-2, spec §3.4): the wizard
//! writes it once, a start writes a missing one, and the trial starts at the
//! earlier of the database's and the mark's start, so neither a reinstall nor
//! an edited value buys a new trial.

mod support;

use std::sync::{Arc, Mutex};

use markiro_host::license::trial_mark::{Mark, TrialMark};
use markiro_host::license::LicenseService;
use serde_json::json;
use support::app::{admin, admin_of, TestApp};
use support::license::{office_license, text, DAY_MS, INN, START_MS};

#[derive(Default)]
struct FakeMark {
    started_at: Mutex<Option<i64>>,
    writes: Mutex<Vec<Mark>>,
    refuses: bool,
}

impl TrialMark for FakeMark {
    fn started_at(&self) -> Option<i64> {
        *self.started_at.lock().unwrap()
    }

    fn write(&self, mark: &Mark) -> Result<(), String> {
        self.writes.lock().unwrap().push(mark.clone());
        if self.refuses {
            return Err("reg.exe ended with code 1".to_owned());
        }
        *self.started_at.lock().unwrap() = Some(mark.started_at);
        Ok(())
    }
}

fn service(mark: Arc<FakeMark>) -> Arc<LicenseService> {
    Arc::new(LicenseService::new(
        markiro_proto::trust::license_keyset(),
        mark,
    ))
}

/// A new host whose trial mark is `mark`, before its wizard.
async fn host_with(mark: Arc<FakeMark>) -> TestApp {
    let mut app = TestApp::new().await;
    app.state = app.state.clone().with_license(service(mark));
    app
}

#[tokio::test]
async fn the_wizard_writes_the_mark_once_with_its_start_its_host_and_its_inn() {
    let mark = Arc::new(FakeMark::default());
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert_eq!(
        *mark.writes.lock().unwrap(),
        [Mark {
            started_at: START_MS,
            host_id: admin.app.state.host_id.clone(),
            inn: Some(INN.to_owned()),
        }]
    );
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(mark.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_reinstall_does_not_buy_a_new_trial() {
    // The mark of an earlier installation on this computer.
    let mark = Arc::new(FakeMark::default());
    *mark.started_at.lock().unwrap() = Some(START_MS - 20 * DAY_MS);
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert!(mark.writes.lock().unwrap().is_empty());
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["since"].clone(),
            license["trial"]["startedAt"].clone()
        ),
        (
            json!("trial_expired"),
            json!(text(START_MS - 6 * DAY_MS)),
            json!(text(START_MS - 20 * DAY_MS))
        )
    );
}

#[tokio::test]
async fn a_later_value_in_the_registry_does_not_extend_the_trial() {
    let mark = Arc::new(FakeMark::default());
    *mark.started_at.lock().unwrap() = Some(START_MS + 10 * DAY_MS);
    let admin = admin_of(host_with(mark).await).await;
    let license = office_license(&admin).await;
    assert_eq!(
        (license["trial"]["startedAt"].clone(), license["trial"]["endsAt"].clone()),
        (json!(text(START_MS)), json!(text(START_MS + 14 * DAY_MS)))
    );
}

#[tokio::test]
async fn a_trial_in_the_database_without_a_mark_writes_it_at_a_start() {
    let mut admin = admin().await;
    let mark = Arc::new(FakeMark::default());
    admin.app.state = admin.app.state.clone().with_license(service(mark.clone()));
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(
        *mark.writes.lock().unwrap(),
        [Mark {
            started_at: START_MS,
            host_id: admin.app.state.host_id.clone(),
            inn: Some(INN.to_owned()),
        }]
    );
}

#[tokio::test]
async fn a_mark_that_cannot_be_written_changes_nothing_else() {
    let mark = Arc::new(FakeMark {
        refuses: true,
        ..FakeMark::default()
    });
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert_eq!(mark.writes.lock().unwrap().len(), 1);
    let license = office_license(&admin).await;
    assert_eq!(
        (license["state"].clone(), license["trial"]["startedAt"].clone()),
        (json!("trial"), json!(text(START_MS)))
    );
}
```

Правка `apps/standalone/host/tests/install.rs`:

Фрагмент:

```rust
use markiro_host::install::{
    self, delete_refusal_is_harmless, encode_command, firewall_close_script, firewall_open_script,
    icacls_args, service_error_text, service_spec, start_refusal_is_harmless,
    stop_refusal_is_harmless, system_program, trusted_system_root, CommandOutput, Commands,
    InstallError, ServiceSpec, ServiceState, Services, POLL_EVERY,
};
```

заменить на:

```rust
use markiro_host::install::{
    self, delete_refusal_is_harmless, encode_command, firewall_close_script, firewall_open_script,
    icacls_args, service_error_text, service_spec, start_refusal_is_harmless,
    stop_refusal_is_harmless, system_program, trial_key_script, trusted_system_root,
    CommandOutput, Commands, InstallError, ServiceSpec, ServiceState, Services, POLL_EVERY,
};
```

Фрагмент:

```rust
    assert_eq!(commands.directory_existed, [true, true, true]);
    assert!(paths.logs_dir().is_dir() && paths.tls_dir().is_dir());
    assert_eq!(
        commands.inner.runs[2].1[0],
        paths.data_dir.display().to_string()
    );
    assert_eq!(
        script_of(&commands.inner.runs[3].1),
        firewall_open_script(45710)
    );
}
```

заменить на:

```rust
    assert_eq!(commands.directory_existed, [true, true, true]);
    assert!(paths.logs_dir().is_dir() && paths.tls_dir().is_dir());
    // The trial's key first (plan ЛЦ-2), then the data folder and the service.
    assert_eq!(commands.inner.runs[0].0, "powershell.exe");
    assert_eq!(script_of(&commands.inner.runs[0].1), trial_key_script());
    assert_eq!(
        commands.inner.runs[3].1[0],
        paths.data_dir.display().to_string()
    );
    assert_eq!(
        script_of(&commands.inner.runs[4].1),
        firewall_open_script(45710)
    );
}
```

Фрагмент:

```rust
    assert_eq!(
        script_of(&commands.inner.runs[2].1),
        firewall_open_script(46123)
    );
}
```

заменить на:

```rust
    assert_eq!(
        script_of(&commands.inner.runs[3].1),
        firewall_open_script(46123)
    );
}

/// The trial's key is a second mark of the trial, not a condition of the
/// host: a refusal is logged and the install goes on.
#[test]
fn a_trial_key_the_installer_cannot_make_does_not_stop_the_install() {
    struct FirstPowershellFails {
        inner: FakeCommands,
        failed: bool,
    }
    impl Commands for FirstPowershellFails {
        fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
            let output = self.inner.run(program, args)?;
            if program == "powershell.exe" && !self.failed {
                self.failed = true;
                return Ok(CommandOutput {
                    code: Some(1),
                    ..output
                });
            }
            Ok(output)
        }
    }
    let root = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(root.path().join("Host"));
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None, Some(ServiceState::Running)]);
    let mut commands = FirstPowershellFails {
        inner: FakeCommands::new(&log),
        failed: false,
    };
    install::install_host(
        &paths,
        Path::new(EXE),
        &mut services,
        &mut commands,
        &mut |_| (),
    )
    .unwrap();
    let last = commands.inner.runs.last().unwrap();
    assert_eq!(script_of(&last.1), firewall_open_script(45710));
}

#[test]
fn the_trial_key_lets_the_service_set_values_in_it_and_keeps_an_existing_one() {
    let script = trial_key_script();
    for part in [
        r"$path = 'HKLM:\SOFTWARE\Markiro\Standalone\Trial'",
        "if (-not (Test-Path -LiteralPath $path))",
        "SecurityIdentifier('S-1-5-19')",
        "RegistryAccessRule($sid, 'ReadKey, SetValue', 'None', 'None', 'Allow')",
        "Set-Acl -LiteralPath $path -AclObject $acl",
    ] {
        assert!(script.contains(part), "{part}\n{script}");
    }
    assert!(!script.contains("Remove-Item"), "{script}");
}
```

Фрагмент:

```rust
    // Whatever else is asked for is not ours to resolve.
    assert_eq!(system_program("cmd.exe", r"C:\Windows"), None);
```

заменить на:

```rust
    // The trial's mark (plan ЛЦ-2).
    assert_eq!(
        system_program("reg.exe", r"D:\WINNT"),
        Some(r"D:\WINNT\System32\reg.exe".to_owned())
    );
    // Whatever else is asked for is not ours to resolve.
    assert_eq!(system_program("cmd.exe", r"C:\Windows"), None);
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib license::trial_mark
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_trial --test install
```

Ожидается: ошибки компиляции (`RegistryMark`, `trial_key_script`, `admin_of` публичный — есть после правки опоры); затем FAIL: мастер отметку не пишет, реестр не читается, `reg.exe` не разрешается.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/license/trial_mark.rs`:

Фрагмент:

```rust
/// What the mark holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
```

заменить на:

```rust
use std::sync::{Arc, Mutex};

use crate::install::{run_checked, Commands};

/// The mark's key. `markiro-host install` makes it with administrator
/// rights and lets the service (LocalService) read and set values in it
/// only (`install::trial_key_script`); an uninstall leaves it.
pub const TRIAL_KEY_PATH: &str = r"HKLM\SOFTWARE\Markiro\Standalone\Trial";

/// `reg query <key> /v <name>`.
pub fn query_args(name: &str) -> Vec<String> {
    ["query", TRIAL_KEY_PATH, "/v", name]
        .iter()
        .map(|part| (*part).to_owned())
        .collect()
}

/// `reg add <key> /v <name> /t REG_SZ /d <value> /f`.
pub fn add_args(name: &str, value: &str) -> Vec<String> {
    ["add", TRIAL_KEY_PATH, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]
        .iter()
        .map(|part| (*part).to_owned())
        .collect()
}

/// The value of the `REG_SZ` line `reg query` prints
/// (`    StartedAt    REG_SZ    2026-10-20T09:00:00Z`).
pub fn registry_value(text: &str) -> Option<&str> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        parts.next()?;
        if parts.next()? == "REG_SZ" {
            parts.next()
        } else {
            None
        }
    })
}

/// What the mark holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
```

Дописать после `impl TrialMark for NoMark { … }`:

```rust
/// The registry's mark through `reg.exe` (`install::system_program` runs it
/// by its absolute path under `%SystemRoot%` on Windows). Values are text a
/// person can read in `regedit`: `StartedAt` (RFC 3339 UTC), `HostId`, `Inn`.
pub struct RegistryMark<C> {
    commands: Mutex<C>,
}

impl<C> RegistryMark<C> {
    pub fn new(commands: C) -> Self {
        Self {
            commands: Mutex::new(commands),
        }
    }
}

impl<C: Commands + Send + 'static> TrialMark for RegistryMark<C> {
    fn started_at(&self) -> Option<i64> {
        let mut commands = self.commands.lock().ok()?;
        let output = commands.run("reg.exe", &query_args("StartedAt")).ok()?;
        if output.code != Some(0) {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let value = registry_value(&text)?;
        crate::clock::parse_timestamp(value)
            .ok()
            .map(super::to_ms)
    }

    fn write(&self, mark: &Mark) -> Result<(), String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "the mark's lock is poisoned".to_owned())?;
        let mut values = vec![
            ("StartedAt", super::ms_text(mark.started_at)),
            ("HostId", mark.host_id.clone()),
        ];
        if let Some(inn) = &mark.inn {
            values.push(("Inn", inn.clone()));
        }
        for (name, value) in values {
            run_checked(&mut *commands, "reg.exe", &add_args(name, &value))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

/// The mark this build keeps: the registry on Windows, none elsewhere.
pub fn system() -> Arc<dyn TrialMark> {
    #[cfg(windows)]
    {
        Arc::new(RegistryMark::new(crate::install::SystemCommands))
    }
    #[cfg(not(windows))]
    {
        Arc::new(NoMark)
    }
}
```

Правка `apps/standalone/host/src/license/mod.rs` (если в задаче 6 к полю `mark` добавлен `#[allow(dead_code)]` — снять его). Дописать в `impl LicenseService`:

```rust
    /// The registry's start, read off the async threads.
    async fn read_mark(&self) -> Option<i64> {
        let mark = self.mark.clone();
        tokio::task::spawn_blocking(move || mark.started_at())
            .await
            .ok()
            .flatten()
    }

    /// Write the mark off the async threads; whether it was written.
    async fn write_mark(&self, mark: trial_mark::Mark) -> bool {
        let writer = self.mark.clone();
        match tokio::task::spawn_blocking(move || writer.write(&mark)).await {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                tracing::warn!(%error, "the trial mark was not written");
                false
            }
            Err(_) => {
                tracing::warn!("the trial mark's writer did not finish");
                false
            }
        }
    }

    /// Read the registry's mark once and keep it; write the database's
    /// trial into it when it has none (spec §3.4).
    async fn mark_trial(&self, app: &AppState) -> Result<(), sqlx::Error> {
        let registry = self.read_mark().await;
        *self
            .registry_started_at
            .lock()
            .expect("registry mark lock") = registry;
        if registry.is_some() {
            return Ok(());
        }
        let mut conn = app.pool.acquire().await?;
        let row = store::clock_row(&mut conn).await?;
        drop(conn);
        if let Some(started_at) = row.trial_started_at {
            let written = self
                .write_mark(trial_mark::Mark {
                    started_at,
                    host_id: app.host_id.clone(),
                    inn: row.trial_inn.clone(),
                })
                .await;
            if written {
                *self
                    .registry_started_at
                    .lock()
                    .expect("registry mark lock") = Some(started_at);
            }
        }
        Ok(())
    }

    /// After the wizard: the trial's mark (when the registry has none) and
    /// the license's first look.
    pub async fn after_bootstrap(&self, app: &AppState) {
        if let Err(error) = self.mark_trial(app).await {
            tracing::warn!(%error, "the trial mark was not checked");
        }
        self.refresh_after_write(app).await;
    }
```

В `start_inner` фрагмент:

```rust
        .bind(at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.refresh(app).await?;
```

заменить на:

```rust
        .bind(at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.mark_trial(app).await?;
        self.refresh(app).await?;
```

Правка `apps/standalone/host/src/routes/bootstrap.rs`:

Фрагмент:

```rust
    // The license's first look: the state later looks compare with (plan ЛЦ-2).
    state.license.refresh_after_write(&state).await;
```

заменить на:

```rust
    // The trial's mark outside the database and the license's first look
    // (plan ЛЦ-2, spec §3.4).
    state.license.after_bootstrap(&state).await;
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент:

```rust
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone());
```

заменить на:

```rust
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone())
        .with_license(std::sync::Arc::new(license::LicenseService::new(
            markiro_proto::trust::license_keyset(),
            license::trial_mark::system(),
        )));
```

Правка `apps/standalone/host/src/install.rs`:

Фрагмент:

```rust
pub fn install_host(
    paths: &HostPaths,
    executable: &Path,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), crate::BoxError> {
    paths.ensure()?;
    install(
```

заменить на:

```rust
pub fn install_host(
    paths: &HostPaths,
    executable: &Path,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), crate::BoxError> {
    paths.ensure()?;
    // The trial's mark (plan ЛЦ-2): a key the service may set values in. A
    // refusal does not stop the install: the database keeps the trial too.
    if let Err(error) = run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&trial_key_script()),
    ) {
        tracing::warn!(%error, "the trial mark's key was not prepared");
    }
    install(
```

Фрагмент:

```rust
/// Removes the rule; a rule that is already gone is no error.
pub fn firewall_close_script() -> String {
```

заменить на:

```rust
/// The key of the trial's mark (plan ЛЦ-2, spec §3.4), made with the
/// installer's administrator rights; LocalService (`*S-1-5-19`) may read it
/// and set values in this key only. An existing key keeps its values, and an
/// uninstall leaves it (`PREUNINSTALL` removes only `Role`).
pub fn trial_key_script() -> String {
    "$ErrorActionPreference = 'Stop'; \
$path = 'HKLM:\\SOFTWARE\\Markiro\\Standalone\\Trial'; \
if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }; \
$acl = Get-Acl -LiteralPath $path; \
$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19'); \
$rule = New-Object System.Security.AccessControl.RegistryAccessRule($sid, 'ReadKey, SetValue', 'None', 'None', 'Allow'); \
$acl.SetAccessRule($rule); \
Set-Acl -LiteralPath $path -AclObject $acl"
        .to_owned()
}

/// Removes the rule; a rule that is already gone is no error.
pub fn firewall_close_script() -> String {
```

Фрагмент:

```rust
        "powershell.exe" => Some(format!(
            r"{system_root}\System32\WindowsPowerShell\v1.0\powershell.exe"
        )),
        _ => None,
```

заменить на:

```rust
        "powershell.exe" => Some(format!(
            r"{system_root}\System32\WindowsPowerShell\v1.0\powershell.exe"
        )),
        // The trial's mark (plan ЛЦ-2, `license::trial_mark`).
        "reg.exe" => Some(format!(r"{system_root}\System32\reg.exe")),
        _ => None,
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib license::trial_mark
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_trial --test install --test installer_cli --test license_state --test bootstrap
```

Ожидается: PASS. Прочие тесты `install.rs` проверяют `install::install` — его шаги не менялись.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/trial_mark.rs apps/standalone/host/src/license/mod.rs apps/standalone/host/src/install.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/license_trial.rs apps/standalone/host/tests/install.rs
git commit -F - <<'EOF'
feat(standalone): the trial's mark in the Windows registry — the earlier start wins, a reinstall buys no trial (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 13: `markiro-host restore` переносит лицензии и часы лицензии

**Files:**

- Modify: `apps/standalone/host/src/restore.rs`
- Test: `apps/standalone/host/tests/restore.rs`

**Interfaces:**

- Consumes: таблицы `licenses`, `license_clock` (задача 2); `Revoked`, `read_revoked`, `raise_in`, `summary` (`restore.rs`).
- Produces: `RestoreReport.licenses_carried: Option<u64>` (`None`, когда текущая база не история копии); строки `licenses` текущей базы с `sequence` больше наибольшего в копии переносятся, `license_clock` — более поздняя отметка, более раннее начало пробного периода с его ИНН, более позднее аварийное продление; `host.restore` получает `details.licensesCarried`; сводка — строку о лицензиях.

- [ ] **Step 1: Падающие тесты**

Правка `apps/standalone/host/tests/restore.rs`:

Фрагмент (импорт):

```rust
use markiro_host::StartOptions;
```

заменить на:

```rust
use markiro_host::clock::ManualClock;
use markiro_host::license::state::Phase;
use markiro_host::server::AppState;
use markiro_host::StartOptions;
```

Фрагмент (точные `details` первого теста):

```rust
            "carried": { "devices": 0, "operators": 0, "badges": 0, "officeUsers": 0 },
            "sessionsEnded": 1,
            "identity": "kept",
```

заменить на:

```rust
            "carried": { "devices": 0, "operators": 0, "badges": 0, "officeUsers": 0 },
            "licensesCarried": 0,
            "sessionsEnded": 1,
            "identity": "kept",
```

Фрагмент (точная сводка первого теста):

```rust
            "revocations carried over from the previous database: 0 devices, 0 operators, 0 badges, 0 office users".to_owned(),
            "every office session was ended: everyone signs in to the office again".to_owned(),
```

заменить на:

```rust
            "revocations carried over from the previous database: 0 devices, 0 operators, 0 badges, 0 office users".to_owned(),
            "license files carried over from the previous database: 0".to_owned(),
            "every office session was ended: everyone signs in to the office again".to_owned(),
```

Фрагмент (помощник `assert_unread_margins`):

```rust
    assert_eq!(report.carried, None);
    let lines = summary(report);
```

заменить на:

```rust
    assert_eq!((report.carried, report.licenses_carried), (None, None));
    let lines = summary(report);
    assert!(lines.contains(&format!(
        "license files loaded after {} are not in the restored database: load the newest license file again in the office (Информация → Лицензия)",
        report.copy_made
    )), "{lines:#?}");
```

Фрагмент (конец того же помощника):

```rust
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(details["carried"], Value::Null);
}
```

заменить на:

```rust
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(details["carried"], Value::Null);
    assert_eq!(details["licensesCarried"], Value::Null);
}
```

Дописать в конец файла:

```rust
/// A license loaded after the copy (plan ЛЦ-2, spec §4.4) is carried into
/// the restored database with the license clock: the later mark, the trial
/// as it was. The summary and the audit row count it.
#[tokio::test]
async fn a_license_loaded_after_the_copy_is_carried_over_with_the_clock() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    admin.app.clock.advance(time::Duration::days(3));
    support::license::refresh(&admin.app).await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(1));
    assert!(summary(&report)
        .contains(&"license files carried over from the previous database: 1".to_owned()));
    let pool = reopen(&paths).await;
    let file: (String, Option<String>) =
        sqlx::query_as("SELECT license_id, loaded_by FROM licenses")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        file,
        (support::license::license_id(1), Some(admin.id.clone()))
    );
    let clock: (Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn FROM license_clock WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        clock,
        (
            Some(support::license::START_MS + 3 * support::license::DAY_MS),
            Some(support::license::START_MS),
            Some(support::license::INN.to_owned())
        )
    );
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(details["licensesCarried"], 1);
}

/// What the restored database holds decides the state when the host starts
/// (spec §4.6, §4.9): another organization's INN is `inn_mismatch`, and the
/// same files under another host identity are `wrong_host`.
#[tokio::test]
async fn a_restored_database_is_judged_by_its_own_inn_and_this_hosts_identity() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    support::license::set_org_inn(&admin, json!(support::license::OTHER_INN)).await;
    let (copy_path, _) = copy(&admin.app).await;
    support::license::set_org_inn(&admin, json!(support::license::INN)).await;
    let paths = stop(&admin.app).await;

    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let pool = reopen(&paths).await;
    let clock = std::sync::Arc::new(ManualClock::new(
        time::OffsetDateTime::from_unix_timestamp(support::app::START).unwrap(),
    ));
    let mut conn = pool.acquire().await.unwrap();
    let state = AppState::new(pool.clone(), host, clock.clone());
    let snapshot = state.license.snapshot(&state, &mut conn).await.unwrap();
    assert_eq!(snapshot.evaluation.phase, Phase::InnMismatch);
    let other = AppState::new(
        pool.clone(),
        "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f".to_owned(),
        clock,
    );
    let snapshot = other.license.snapshot(&other, &mut conn).await.unwrap();
    assert_eq!(snapshot.evaluation.phase, Phase::WrongHost);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore
```

Ожидается: ошибка компиляции (`licenses_carried` нет).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/restore.rs`:

Фрагмент (документ модуля):

```rust
//!    * the revocations of the current database carried over (a device, a
//!      badge stays revoked, an operator, an office user stays turned off;
//!      nothing the copy lacks comes back), every office session ended,
```

заменить на:

```rust
//!    * the revocations of the current database carried over (a device, a
//!      badge stays revoked, an operator, an office user stays turned off;
//!      nothing the copy lacks comes back), every office session ended,
//!    * the license files the current database loaded after the copy (a
//!      higher `sequence`) carried over with its license clock: the later
//!      mark, the earlier trial, the later emergency extension (plan ЛЦ-2),
```

Фрагмент:

```rust
/// What the current database revoked or turned off.
#[derive(Debug, Default, Clone)]
struct Revoked {
    /// `(id, revoked_at)`.
    devices: Vec<(String, String)>,
    operators: Vec<String>,
    /// `(id, revoked_at)`.
    badges: Vec<(String, String)>,
    office_users: Vec<String>,
}
```

заменить на:

```rust
/// What the current database revoked or turned off, and its license (plan
/// ЛЦ-2): carried over like a revocation, only toward what it knew later.
#[derive(Debug, Default, Clone)]
struct Revoked {
    /// `(id, revoked_at)`.
    devices: Vec<(String, String)>,
    operators: Vec<String>,
    /// `(id, revoked_at)`.
    badges: Vec<(String, String)>,
    office_users: Vec<String>,
    licenses: Vec<LicenseRow>,
    license_clock: Option<LicenseClockRow>,
}

/// A license file of the current database, as `licenses` keeps it.
#[derive(Debug, Clone, sqlx::FromRow)]
struct LicenseRow {
    license_id: String,
    sequence: i64,
    compact: String,
    kid: String,
    host_id: String,
    issued_at: i64,
    valid_from: i64,
    valid_until: i64,
    grace_days: i64,
    plan: String,
    plan_version_id: String,
    customer_name: String,
    customer_inn: String,
    quotas: String,
    features: String,
    loaded_at: String,
    loaded_by: Option<String>,
}

/// The license clock of the current database.
#[derive(Debug, Clone, Default)]
struct LicenseClockRow {
    max_seen_at: Option<i64>,
    trial_started_at: Option<i64>,
    trial_inn: Option<String>,
    emergency_used_for: Option<String>,
    emergency_until: Option<i64>,
}
```

Фрагмент (конец `read_revoked`):

```rust
    if tables.contains("office_users") {
        revoked.office_users =
            sqlx::query_scalar("SELECT id FROM office_users WHERE active = 0 ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
    }
    Ok(revoked)
}
```

заменить на:

```rust
    if tables.contains("office_users") {
        revoked.office_users =
            sqlx::query_scalar("SELECT id FROM office_users WHERE active = 0 ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
    }
    if tables.contains("licenses") {
        revoked.licenses = sqlx::query_as(
            "SELECT license_id, sequence, compact, kid, host_id, issued_at, valid_from, \
             valid_until, grace_days, plan, plan_version_id, customer_name, customer_inn, \
             quotas, features, loaded_at, loaded_by FROM licenses ORDER BY sequence",
        )
        .fetch_all(&mut *conn)
        .await?;
    }
    if tables.contains("license_clock") {
        let row: Option<(Option<i64>, Option<i64>, Option<String>, Option<String>, Option<i64>)> =
            sqlx::query_as(
                "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, \
                 emergency_until FROM license_clock WHERE id = 1",
            )
            .fetch_optional(&mut *conn)
            .await?;
        revoked.license_clock = row.map(
            |(max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until)| {
                LicenseClockRow {
                    max_seen_at,
                    trial_started_at,
                    trial_inn,
                    emergency_used_for,
                    emergency_until,
                }
            },
        );
    }
    Ok(revoked)
}
```

Фрагмент:

```rust
async fn raise_in(
    tx: &mut SqliteConnection,
```

заменить на:

```rust
/// Carry the license files the current database loaded after the copy (a
/// higher `sequence` than any the copy has) and its license clock (plan
/// ЛЦ-2, spec §4.4): the later mark, the earlier trial with its INN, the
/// later emergency extension. A restore never brings a trial back, nor the
/// time back.
async fn carry_licenses(tx: &mut SqliteConnection, revoked: &Revoked) -> Result<u64, sqlx::Error> {
    let newest: Option<i64> = sqlx::query_scalar("SELECT max(sequence) FROM licenses")
        .fetch_one(&mut *tx)
        .await?;
    let mut carried = 0;
    for row in revoked
        .licenses
        .iter()
        .filter(|row| newest.is_none_or(|newest| row.sequence > newest))
    {
        carried += sqlx::query(
            "INSERT OR IGNORE INTO licenses (license_id, sequence, compact, kid, host_id, \
             issued_at, valid_from, valid_until, grace_days, plan, plan_version_id, \
             customer_name, customer_inn, quotas, features, loaded_at, loaded_by) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&row.license_id)
        .bind(row.sequence)
        .bind(&row.compact)
        .bind(&row.kid)
        .bind(&row.host_id)
        .bind(row.issued_at)
        .bind(row.valid_from)
        .bind(row.valid_until)
        .bind(row.grace_days)
        .bind(&row.plan)
        .bind(&row.plan_version_id)
        .bind(&row.customer_name)
        .bind(&row.customer_inn)
        .bind(&row.quotas)
        .bind(&row.features)
        .bind(&row.loaded_at)
        .bind(&row.loaded_by)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    if let Some(clock) = &revoked.license_clock {
        // SQLite computes every SET from the row as it was.
        sqlx::query(
            "UPDATE license_clock SET \
             max_seen_at = CASE WHEN ?1 IS NULL THEN max_seen_at \
                 WHEN max_seen_at IS NULL OR ?1 > max_seen_at THEN ?1 ELSE max_seen_at END, \
             trial_inn = CASE WHEN ?2 IS NOT NULL \
                 AND (trial_started_at IS NULL OR ?2 < trial_started_at) THEN ?3 ELSE trial_inn END, \
             trial_started_at = CASE WHEN ?2 IS NOT NULL \
                 AND (trial_started_at IS NULL OR ?2 < trial_started_at) THEN ?2 \
                 ELSE trial_started_at END, \
             emergency_used_for = CASE WHEN ?4 IS NOT NULL \
                 AND (emergency_until IS NULL OR ?5 > emergency_until) THEN ?4 \
                 ELSE emergency_used_for END, \
             emergency_until = CASE WHEN ?4 IS NOT NULL \
                 AND (emergency_until IS NULL OR ?5 > emergency_until) THEN ?5 \
                 ELSE emergency_until END \
             WHERE id = 1",
        )
        .bind(clock.max_seen_at)
        .bind(clock.trial_started_at)
        .bind(&clock.trial_inn)
        .bind(&clock.emergency_used_for)
        .bind(clock.emergency_until)
        .execute(&mut *tx)
        .await?;
    }
    Ok(carried)
}

async fn raise_in(
    tx: &mut SqliteConnection,
```

Фрагмент:

```rust
    let carried = match revoked {
        Some(revoked) => Some(carry_revocations(&mut *tx, revoked, revision).await?),
        None => None,
    };
```

заменить на:

```rust
    let carried = match revoked {
        Some(revoked) => Some(carry_revocations(&mut *tx, revoked, revision).await?),
        None => None,
    };
    let licenses_carried = match revoked {
        Some(revoked) => Some(carry_licenses(&mut *tx, revoked).await?),
        None => None,
    };
```

Фрагмент:

```rust
                    "officeUsers": carried.office_users,
                })),
                "sessionsEnded": sessions_ended,
```

заменить на:

```rust
                    "officeUsers": carried.office_users,
                })),
                "licensesCarried": licenses_carried,
                "sessionsEnded": sessions_ended,
```

Фрагмент:

```rust
    Ok(Raised {
        epoch,
        revision,
        counters,
        shift_numbers,
        carried,
        sessions_ended,
        copy_made: format_timestamp(copy_made),
    })
```

заменить на:

```rust
    Ok(Raised {
        epoch,
        revision,
        counters,
        shift_numbers,
        carried,
        licenses_carried,
        sessions_ended,
        copy_made: format_timestamp(copy_made),
    })
```

Фрагмент:

```rust
    shift_numbers: Vec<ShiftNumberRaise>,
    carried: Option<Carried>,
    sessions_ended: u64,
    copy_made: String,
}
```

заменить на:

```rust
    shift_numbers: Vec<ShiftNumberRaise>,
    carried: Option<Carried>,
    licenses_carried: Option<u64>,
    sessions_ended: u64,
    copy_made: String,
}
```

Фрагмент:

```rust
    pub carried: Option<Carried>,
    pub sessions_ended: u64,
    pub interrupted: Option<Interrupted>,
```

заменить на:

```rust
    pub carried: Option<Carried>,
    /// How many license files the current database loaded after the copy
    /// were carried over (plan ЛЦ-2); `None` like `carried`.
    pub licenses_carried: Option<u64>,
    pub sessions_ended: u64,
    pub interrupted: Option<Interrupted>,
```

Фрагмент:

```rust
        carried: raised.carried,
```

заменить на:

```rust
        carried: raised.carried,
        licenses_carried: raised.licenses_carried,
```

Фрагмент (сводка):

```rust
        None => format!(
            "the previous database was not read: devices, operators, badges and office users revoked after {} are active again: check them in the office",
            report.copy_made
        ),
    });
```

заменить на:

```rust
        None => format!(
            "the previous database was not read: devices, operators, badges and office users revoked after {} are active again: check them in the office",
            report.copy_made
        ),
    });
    lines.push(match report.licenses_carried {
        Some(count) => {
            format!("license files carried over from the previous database: {count}")
        }
        None => format!(
            "license files loaded after {} are not in the restored database: load the newest license file again in the office (Информация → Лицензия)",
            report.copy_made
        ),
    });
```

Модульные тесты `restore.rs` (две сборки структур). Фрагмент:

```rust
            history_known: false,
            carried: None,
            sessions_ended: 0,
```

заменить на:

```rust
            history_known: false,
            carried: None,
            licenses_carried: None,
            sessions_ended: 0,
```

Фрагмент:

```rust
            shift_numbers: Vec::new(),
            carried: None,
            sessions_ended: 0,
            copy_made: String::new(),
```

заменить на:

```rust
            shift_numbers: Vec::new(),
            carried: None,
            licenses_carried: None,
            sessions_ended: 0,
            copy_made: String::new(),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore --test restore_hold
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib restore::
```

Ожидается: PASS. Тест, сравнивающий сводку целиком в другом случае (новый ПК, не история копии), получает строку о лицензиях после строки об отзывах — обновить точное ожидание и записать в «Отклонения».

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/restore.rs apps/standalone/host/tests/restore.rs
git commit -F - <<'EOF'
feat(standalone): restore carries the license files loaded after the copy and the license clock (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 14: Таблицы маршрутов «закрываемые» / «никогда», журнал службы без секретов лицензии, документы

**Files:**

- Modify: `apps/standalone/host/src/license/gate.rs`, `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Test: `apps/standalone/host/tests/license_routes.rs`, `apps/standalone/host/tests/no_secrets_in_logs.rs`

**Interfaces:**

- Consumes: маршрутизатор `server::router` (исходник `host/src/server.rs`), `support::license::{file, license_id, INN}`.
- Produces: `license::gate::{GATED, NEVER}` — каждый маршрут хоста ровно в одной таблице; тест сверяет их с маршрутизатором; `no_secrets_in_logs.rs` загружает принятый и отвергнутый файл и видит переход состояния, журнал не содержит ни текста файла, ни его сегментов, ни ИНН, ни названия клиента; закрепление числа вызовов `tracing::` в `license/`; `AGENTS.md` (раздел «License», «Audit», «Installer and service»), памятка (ключ реестра), §19 спецификации.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/license_routes.rs`:

```rust
//! Every route of the host is in exactly one of the license's tables (plan
//! ЛЦ-2, spec §3.3, §12.1): closed by the license in some state or for some
//! addition (`GATED`), or never (`NEVER`). A route added to the router and to
//! neither table fails here, so none stays unclassified.

use std::collections::BTreeSet;

use markiro_host::license::gate::{GATED, NEVER};

/// `(method, path)` of every `.route("<path>", <methods>)` in
/// `src/server.rs`: the method calls (`get(`, `post(`, `put(`, `delete(`)
/// up to the next route or the end of the function, outside the unit tests.
fn routed() -> BTreeSet<(String, String)> {
    // The router only: the module of unit tests builds probe routes of its own.
    let source = include_str!("../src/server.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("the source of the router");
    let mut found = BTreeSet::new();
    let mut rest = source;
    while let Some(start) = rest.find(".route(\"") {
        let after = &rest[start + ".route(\"".len()..];
        let end = after.find('"').expect("a route's path ends");
        let path = &after[..end];
        let body = &after[end..];
        let stop = [body.find(".route(\""), body.find("\n}\n")]
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
            let mut search = segment;
            while let Some(at) = search.find(call) {
                let before = search[..at].chars().next_back();
                if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    found.insert((method.to_owned(), path.to_owned()));
                }
                search = &search[at + call.len()..];
            }
        }
        rest = &after[end..];
    }
    found
}

#[test]
fn every_route_is_closed_by_the_license_or_never_and_not_both() {
    let routed = routed();
    assert!(routed.len() > 80, "the router was not read: {routed:?}");
    let gated: BTreeSet<(String, String)> = GATED
        .iter()
        .map(|(method, path, _)| ((*method).to_owned(), (*path).to_owned()))
        .collect();
    let never: BTreeSet<(String, String)> = NEVER
        .iter()
        .map(|(method, path)| ((*method).to_owned(), (*path).to_owned()))
        .collect();
    assert_eq!(gated.len(), GATED.len(), "a route twice in GATED");
    assert_eq!(never.len(), NEVER.len(), "a route twice in NEVER");
    let both: Vec<_> = gated.intersection(&never).collect();
    assert!(both.is_empty(), "routes in both tables: {both:?}");
    let classified: BTreeSet<(String, String)> = gated.union(&never).cloned().collect();
    let unclassified: Vec<_> = routed.difference(&classified).collect();
    assert!(unclassified.is_empty(), "routes in neither table: {unclassified:?}");
    let gone: Vec<_> = classified.difference(&routed).collect();
    assert!(gone.is_empty(), "classified routes the router does not have: {gone:?}");
}

#[test]
fn the_gated_routes_are_the_ones_the_spec_names() {
    let gated: Vec<(&str, &str)> = GATED.iter().map(|(method, path, _)| (*method, *path)).collect();
    for route in [
        ("POST", "/v1/device/shifts/{id}/enter"),
        ("POST", "/v1/device/shifts"),
        ("POST", "/v1/local-pair"),
        ("POST", "/v1/pairing/claim"),
    ] {
        assert!(gated.contains(&route), "{route:?}");
    }
    for route in [
        ("POST", "/v1/office/shifts/{id}/close"),
        ("POST", "/v1/device/facts"),
        ("PUT", "/v1/office/license"),
        ("POST", "/v1/office/license/emergency"),
    ] {
        assert!(!gated.contains(&route), "{route:?}");
    }
}
```

Правка `apps/standalone/host/tests/no_secrets_in_logs.rs`:

Фрагмент (после мастера):

```rust
    let session: serde_json::Value = wizard.json().await.unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();
```

заменить на:

```rust
    let session: serde_json::Value = wizard.json().await.unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();

    // A license file accepted (the state moves from the trial) and one
    // refused (plan ЛЦ-2): the log holds the file's id, the state and the
    // refusal's code, never the file, its segments, the INN or the customer.
    let accepted_file = support::license::file(&host.host_id, |terms| {
        terms["customer"]["name"] = json!("ООО «Лицензия-маркер»");
    });
    let refused_file = support::license::file(&host.host_id, |terms| {
        terms["licenseId"] = json!(support::license::license_id(2));
        terms["sequence"] = json!(2);
        terms["hostId"] = json!("9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f");
        terms["customer"]["name"] = json!("ООО «Лицензия-маркер»");
    });
    for (file, expected) in [(&accepted_file, 200), (&refused_file, 400)] {
        let answer = client
            .put(format!("{base}/v1/office/license"))
            .header(protocol.0, &protocol.1)
            .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
            .bearer_auth(&key)
            .json(&json!({ "file": file }))
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), expected);
    }
    let mut license_needles = vec![
        "ООО «Лицензия-маркер»".to_owned(),
        support::license::INN.to_owned(),
    ];
    for file in [&accepted_file, &refused_file] {
        license_needles.push(file.clone());
        license_needles.extend(file.split('.').skip(1).map(str::to_owned));
    }
```

Фрагмент (после проверки секретов):

```rust
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
```

заменить на:

```rust
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
    // The license's lines are there, by the file's id and the state alone.
    for line in [
        "a license file was loaded",
        "a license file was refused",
        "license state changed",
    ] {
        assert!(log.contains(line), "the log lacks {line:?}");
    }
    for needle in license_needles {
        assert!(
            !log.contains(&needle),
            "the process log contains a license file's text, its INN or its customer"
        );
    }
```

Фрагмент (закрепление исходника, после проверки модулей импорта):

```rust
        if import_path.contains(&relative.as_str()) {
```

заменить на:

```rust
        // The license (plan ЛЦ-2) logs by the file's id, the state and the
        // refusal's code: its calls are counted, and no field holds the file,
        // the payload, an INN or the customer.
        if relative.starts_with("license/") {
            let expected = match relative.as_str() {
                "license/mod.rs" => 7,
                "license/routes.rs" => 2,
                _ => 0,
            };
            assert_eq!(
                text.matches("tracing::").count(),
                expected,
                "{relative} has a logging call this test does not know"
            );
            for field in ["%compact", "?compact", "?payload", "%payload", "%inn", "?inn", "%org_inn", "customer_name ="] {
                assert!(!text.contains(field), "{relative} logs {field}");
            }
        }
        if import_path.contains(&relative.as_str()) {
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_routes
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs
```

Ожидается: `license_routes` — ошибка компиляции (`GATED`, `NEVER` нет); `no_secrets_in_logs` (вне песочницы: тест поднимает хост на `127.0.0.1`) — PASS или FAIL по числу вызовов: если число в `license/mod.rs` или `routes.rs` иное, чем 7 и 2, сверить каждый вызов с правилом журнала и записать фактическое число в тест и в «Отклонения».

- [ ] **Step 3: Реализация**

Дописать в конец `apps/standalone/host/src/license/gate.rs`:

```rust
/// Every route the license closes in some state or for some addition (spec
/// §3.3, §4.7), with the gate it asks. A new route goes into this table or
/// into [`NEVER`]: `tests/license_routes.rs` compares both with the router.
pub const GATED: &[(&str, &str, &str)] = &[
    ("POST", "/v1/local-pair", "a seat of stations"),
    ("POST", "/v1/pairing/claim", "a seat of stations; handheld"),
    ("POST", "/v1/device/shifts", "new shifts; pallets"),
    ("POST", "/v1/device/shifts/{id}/enter", "new shifts: the first entry only"),
    ("POST", "/v1/office/users", "a seat of office users"),
    ("PUT", "/v1/office/users/{id}", "a seat of office users: turned on again"),
    ("POST", "/v1/office/lines", "a seat of lines"),
    ("PUT", "/v1/office/lines/{id}", "a seat of lines: back from the archive"),
    ("POST", "/v1/office/shifts", "pallets"),
    ("PUT", "/v1/office/shifts/{id}", "pallets: turned on"),
    ("POST", "/v1/office/templates", "the label editor"),
    ("PUT", "/v1/office/templates/{id}", "the label editor: a name or a layout"),
];

/// Every route the license never closes: what runs, the client's data, its
/// copies, the license itself (spec §3.3).
pub const NEVER: &[(&str, &str)] = &[
    ("GET", "/v1/hello"),
    ("GET", "/v1/device"),
    ("PUT", "/v1/device/line"),
    ("GET", "/v1/device/shifts"),
    ("POST", "/v1/device/sscc/blocks"),
    ("POST", "/v1/device/sscc/blocks/known"),
    ("POST", "/v1/device/facts"),
    ("GET", "/v1/device/codes/{code_hash}"),
    ("POST", "/v1/device/warehouse/lookup"),
    ("POST", "/v1/device/warehouse/reprints"),
    ("GET", "/v1/changes"),
    ("GET", "/v1/changes/stream"),
    ("GET", "/v1/office/devices"),
    ("PUT", "/v1/office/devices/{id}"),
    ("POST", "/v1/office/devices/{id}/revoke"),
    ("POST", "/v1/office/login"),
    ("POST", "/v1/office/logout"),
    ("GET", "/v1/office/me"),
    ("PUT", "/v1/office/me/password"),
    ("POST", "/v1/bootstrap"),
    ("GET", "/v1/office/org"),
    ("PUT", "/v1/office/org"),
    ("GET", "/v1/office/org/logo"),
    ("PUT", "/v1/office/org/logo"),
    ("DELETE", "/v1/office/org/logo"),
    ("GET", "/v1/office/sscc"),
    ("PUT", "/v1/office/sscc/counters/{prefix}/{extension}"),
    ("PUT", "/v1/office/sscc/block-sizes"),
    ("GET", "/v1/office/counterparties"),
    ("POST", "/v1/office/counterparties"),
    ("PUT", "/v1/office/counterparties/{id}"),
    ("GET", "/v1/office/lines"),
    ("GET", "/v1/office/operators"),
    ("POST", "/v1/office/operators"),
    ("PUT", "/v1/office/operators/{id}"),
    ("POST", "/v1/office/operators/{id}/badges"),
    ("DELETE", "/v1/office/operators/{id}/badges/{badge_id}"),
    ("GET", "/v1/office/badge-salt"),
    ("GET", "/v1/office/product-groups"),
    ("GET", "/v1/office/products"),
    ("POST", "/v1/office/products"),
    ("PUT", "/v1/office/products/{id}"),
    ("GET", "/v1/office/templates"),
    ("GET", "/v1/office/templates/{id}"),
    ("DELETE", "/v1/office/templates/{id}"),
    ("GET", "/v1/office/template-defaults"),
    ("PUT", "/v1/office/template-defaults"),
    ("GET", "/v1/office/pallet-sheets"),
    ("POST", "/v1/office/pallet-sheets"),
    ("PUT", "/v1/office/pallet-sheets/{id}"),
    ("DELETE", "/v1/office/pallet-sheets/{id}"),
    ("PUT", "/v1/office/pallet-sheet-default"),
    ("GET", "/v1/office/shifts"),
    ("GET", "/v1/office/shifts/{id}"),
    ("DELETE", "/v1/office/shifts/{id}"),
    ("POST", "/v1/office/shifts/{id}/close"),
    ("GET", "/v1/office/shifts/{id}/boxes"),
    ("GET", "/v1/office/shifts/{id}/pallets"),
    ("GET", "/v1/office/shifts/{id}/export-source"),
    ("POST", "/v1/office/shifts/{id}/exports"),
    ("GET", "/v1/office/shifts/{id}/pallet-report-data"),
    ("GET", "/v1/office/boxes/{id}/report-data"),
    ("GET", "/v1/office/backups"),
    ("POST", "/v1/office/backups"),
    ("PUT", "/v1/office/backups/settings"),
    ("POST", "/v1/office/backups/resume"),
    ("POST", "/v1/office/import"),
    ("GET", "/v1/office/users"),
    ("PUT", "/v1/office/users/{id}/password"),
    ("POST", "/v1/office/pairing-codes"),
    ("GET", "/v1/office/license"),
    ("PUT", "/v1/office/license"),
    ("POST", "/v1/office/license/preview"),
    ("GET", "/v1/office/license/activation-request"),
    ("POST", "/v1/office/license/emergency"),
];
```

Документ модуля `gate.rs` (первые строки) заменить на:

```rust
//! The gate of new shifts (spec §3.3): the one move a license that ran out
//! closes is a planned shift's opening, and a station's new shift (one it
//! could not open). Everything that runs goes on. And the two tables of
//! every host route: closed by the license (in some state, or for an
//! addition beyond the file) or never.
```

Правка `apps/standalone/AGENTS.md`:

Фрагмент (раздел «Audit»):

```markdown
Backups (plan РК) write `backup.create` (the host or the office user who asked;
`failed` when a folder did not get the copy), `backup.settings.update`,
`host.restore` (the host), `host.restore.resume` and `sscc.block.register`
(the station).
```

заменить на:

```markdown
Backups (plan РК) write `backup.create` (the host or the office user who asked;
`failed` when a folder did not get the copy), `backup.settings.update`,
`host.restore` (the host), `host.restore.resume` and `sscc.block.register`
(the station). The license (plan ЛЦ-2) writes `license.load` (the
administrator; `denied` for a refused file with its reason — a foreign or
forged file is an event, unlike other refused office writes; the file itself
never enters `details`), `license.state` (the host, one row per change of
state, none for the first look) and `license.emergency`.
```

Дописать перед разделом `## Marking rules`:

```markdown
## License

Plan ЛЦ-2 (`docs/superpowers/plans/2026-10-13-standalone-lc2-host-license.md`,
the spec `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`,
§3, §4, §7, §8 and §19). Only the host decides the license's state
(`host/src/license/`); devices read it in `GET /v1/device` (`license`, a word
and its dates, never in the strict `site` feed record).

- A file is a compact JWS ES256 (`markiro_proto::trust`, plan ЛЦ-1), at most
  16 KiB, checked in the order of §4.3 (`license/verify.rs`) before anything
  is written: form, key, signature, payload and issuer, this host's `hostId`,
  the organization's INN by its check digit, a `sequence` above every stored
  file (the same file again changes nothing). `licenses` only grows; the file
  in force is the highest `sequence` whose `validFrom` came.
- The state (`license/state.rs`, a pure function): `wrong_host` (30 days from
  when it was seen) before `inn_mismatch` before the file's term (`active`,
  `expiring` at `min(30, ⌊term/3⌋)` days, `grace`, `restricted`); without a
  file, the 14-day trial from the wizard (`trial`, `trial_expired`, no
  grace). The time (`license/clock.rs`): the PC's clock, never below the last
  known time (`license_clock.max_seen_at`, written hourly and at every change)
  nor below a loaded file's issue less a day, never faster than the process's
  monotonic time while it runs, at most 400 days ahead at a start.
- What it closes (`license/gate.rs`): in `restricted`, `trial_expired` and
  `inn_mismatch` only a planned shift's first entry and a station's new shift
  (`conflict` `license_restricted`, no row); the owner's entry again, facts,
  blocks, closes, exports, copies and the office never. Every router route is
  in `GATED` or `NEVER`; `tests/license_routes.rs` fails on a route in
  neither. The emergency extension opens new shifts for 72 hours once per file
  and once for the trial.
- Seats and features (`license/seats.rs`) refuse additions only, inside the
  writer's transaction: stations and handhelds share `stations` (pairing,
  checked before a pairing code is used up), `cabinetUsers` are active office
  users, `lines` lines not archived; `handheld`, `pallets` (plans with pallets
  and pallets turned on) and `labelEditor` (a new template, a new name or
  layout). Nothing that runs is disconnected, even over the limit.
- The trial's mark outside the database: `HKLM\SOFTWARE\Markiro\Standalone\Trial`
  (`StartedAt`, `HostId`, `Inn`) through `reg.exe` (`license/trial_mark.rs`);
  `markiro-host install` makes the key and lets LocalService set values in it;
  the trial starts at the earlier of the database's and the mark's start.
  Other systems have no mark.
- `markiro-host restore` carries the files the current database loaded after
  the copy and its license clock, only when it is the copy's history.
- The log holds a file's id, the state and a refusal's code: never the file,
  its signature, the activation request, the INN or the customer's name
  (`no_secrets_in_logs.rs` loads an accepted and a refused file and counts
  the license's logging calls).
```

В разделе «Installer and service» после первого абзаца о `markiro-host install` дописать предложение:

```markdown
`install_host` first makes the key of the trial's mark
(`HKLM\SOFTWARE\Markiro\Standalone\Trial`, `install::trial_key_script`:
LocalService may read it and set values in it only; an existing key keeps its
values, an uninstall leaves it); a refusal is logged and does not stop the
install (plan ЛЦ-2).
```

Правка `docs/runbooks/standalone-install.md` — в «Памятке для ИТ», блок «Служба», после строки о команде `markiro-host stop-service` дописать пункт:

```markdown
- **Ключ пробного периода** (план ЛЦ-2): `markiro-host install` создаёт ключ реестра
  `HKLM\SOFTWARE\Markiro\Standalone\Trial` и даёт учётной записи службы (`LocalService`) право читать
  его и записывать в него значения — только в этот ключ. Служба записывает туда начало пробного периода
  (`StartedAt`), идентификатор хоста (`HostId`) и ИНН мастера (`Inn`). Удаление программы ключ не
  удаляет: переустановка не начинает пробный период заново. Если ключ создать не удалось, установка
  продолжается, а начало пробного периода хранится только в базе.
```

Правка `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — дописать в конец (после §18, если он есть; иначе после §17):

```markdown
## 19. Уточнения плана ЛЦ-2

План `docs/superpowers/plans/2026-10-13-standalone-lc2-host-license.md`. Решения при написании
(подробно — «Допущения» плана):

- **Столбцы сверх списка брифа:** `licenses.host_id`, `licenses.plan_version_id`;
  `license_clock.wrong_host_since`, `last_state`, `last_state_at`. Времена в обеих таблицах —
  миллисекунды UTC, на проводе — RFC 3339 хоста.
- **Форма ответов:** `OfficeLicense` получил `since`, `opensNewShifts`, `license.kid`;
  `DeviceLicense` — `emergencyUntil`; предпросмотр отдаёт `before` всегда (пробный период —
  `plan: "trial"`); состояние на проводе — слово, не перечисление. Новое ограничение
  `emergency_not_needed`.
- **Ограничитель загрузки — на адрес**, как у входа (общий для предпросмотра и загрузки), не на
  сессию.
- **Старшинство состояний:** `wrong_host` → `inn_mismatch` → сроки файла; без файла — пробный
  период. Первая оценка ставит точку отсчёта без строки аудита; дальше одна строка `license.state` и
  одна ревизия на смену состояния.
- **Возможности (ЛО23):** `labelEditor` закрывает создание шаблона и правку имени или макета, не
  включение, категории и удаление; `pallets` — план и создание смены с паллетами и включение паллет,
  не открытие запланированной смены с паллетами; `handheld` — сопряжение ТСД (до траты кода).
- **Мастер (ЛО24, ЛО27):** хост и вебвью требуют ИНН с верной контрольной суммой только в мастере;
  тестовый ИНН `7701234567` контрольную сумму не проходит и заменён на `7707083893`.
- **Импорт из облака ИНН не пишет** (`routes/cloud_import.rs` обновляет в `org_profile` только
  шаблоны по умолчанию): пересчёт после импорта оставлен для единообразия.
- **Станция этапа 2a** показывает неизвестное ограничение отказа открытия (`license_restricted`)
  общим текстом «не удалось» (`src/floor/shifts/shift-entry.ts`, `new-shift.ts`); свой текст
  приносит план ЛЦ-3 с обновлением станций, хост обновляется первым (раздел 17, третий пункт).
- **Ключ реестра** создаётся PowerShell в `markiro-host install` (права `ReadKey, SetValue` для
  `*S-1-5-19` только на этот ключ, лучшее усилие), значения пишет и читает служба через `reg.exe`.

_Отклонения при исполнении дописываются сюда исполнителем._
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test license_routes
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs
```

Ожидается: PASS (второй — вне песочницы). Если тест классификации нашёл маршрут, которого нет в таблицах (ветка-основа новее), — добавить его в `NEVER` (или в `GATED`, если задачи 9–11 его закрывают) и записать.

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --tests
git diff --check
git add apps/standalone/host/src/license/gate.rs apps/standalone/host/tests/license_routes.rs apps/standalone/host/tests/no_secrets_in_logs.rs apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F - <<'EOF'
feat(standalone): every host route closed by the license or never; the log keeps license files out; docs (plan ЛЦ-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Итоговая проверка плана

1. Предусловие ЛЦ-1 выполнено (раздел «Заметки для исполнения»); `git log --format=%B <основа>..HEAD` — 14 коммитов, в каждом ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`; `-p markiro-host --lib`; `-p markiro-host --test license_schema --test license_office --test license_load --test license_state --test license_gate --test license_seats --test license_features --test license_trial --test license_routes --test restore --test install --test bootstrap` — PASS. Гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы (`no_secrets_in_logs`, `hello`, `ipc` открывают сокет), частями, если весь не помещается; перед ним `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`).
3. Вебвью: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS.
4. `pnpm format:check` для тронутых путей (или `node_modules/.bin/prettier --ignore-path .prettierignore --check` по списку «Файлы»); `git diff --check`.
5. `git diff --stat <основа> -- apps/standalone/host/migrations` — только `0030_license.sql`; `-- apps/standalone/src-tauri/migrations` — пусто; `git diff <основа> -- apps/standalone/host/Cargo.toml apps/standalone/proto/Cargo.toml Cargo.lock apps/standalone/package.json pnpm-lock.yaml` — пусто.
6. `grep -rn "7701234567" apps/standalone/host/tests` — пусто; `grep -rn "license_restricted" apps/standalone/host/src` — только `license/gate.rs` (через `constraints`) и `proto`.
7. Мутации (по одной, файл возвращается `cp` и проверяется `cmp`): `opens_new_shifts` без `|| emergency_until.is_some()` — FAIL `the_emergency_opens_new_shifts…`; `used < limit` → `used <= limit` в `require_seat` — FAIL `stations_and_handhelds…`; `license.sequence <= newest` → `<` в `admit` — FAIL `a_newer_file_replaces…`; удалить проверку `require_new_shifts` в создании смены станцией — FAIL `a_planned_shift_does_not_open…`; в `LicenseClock::observe` убрать `.max(self.mark)` — FAIL `a_clock_set_back_two_days…`; в `carry_licenses` фильтр `row.sequence > newest` → `>=` — PASS ожидаем (дубли гасит `INSERT OR IGNORE`): мутация показывает, что фильтр — оптимизация, записать.

## Перенесено

- **Раздел «Лицензия» страницы «Информация», баннеры офиса, «Обзор», строка состояния станции, тексты отказов `seat_limit`, `feature_disabled` и `license_restricted` на станции и в офисе, сохранение запроса активации в `Документы\Markiro\Лицензия`** — план ЛЦ-3 (контракт провода этого плана — его вход).
- **Свои тексты станции для `license_restricted`** приходят с обновлением станций (ЛЦ-3); станция этапа 2a показывает общий отказ.
- **Квота `kiosks`** только показывается: киоска в автономе нет (`DeviceKind::Kiosk` — будущее).
- **`chzIntegration`, `inventory`, `commerceMl`, `publicApi`** только показываются (ЛО23).
- **Ограничитель загрузки на сессию** (§8.3) — если владелец захочет; сейчас на адрес, как вход.
- **Тест интервала фоновой задачи** (60 с) — не пишется: её тело — `refresh`, у которого свои тесты.

## Не проверено

- Ничего на Windows: реестр (`reg.exe query/add` под `LocalService`, достаточно ли прав `ReadKey, SetValue` или `reg add` на существующем ключе просит больше), скрипт ключа под администратором из установщика, 32/64-битное представление реестра установщика NSIS против `reg.exe` и PowerShell из `System32`, то, что удаление программы ключ оставляет.
- Монотонные часы Windows (`Instant` поверх `QueryPerformanceCounter`) при переводе даты и времени в параметрах Windows: флаг `clockBehind`, время лицензии не идёт назад, скачок вперёд не принимается.
- Настоящая служба: проверка при старте, фоновая задача, переход фазы в полночь и пробуждение станций; восстановление на новом ПК с идентичностью (лицензия действует) и без неё (`wrong_host`).
- Станция и офис с настоящим хостом по сети: отказ открытия, `seat_limit` на экране сопряжения (ЛЦ-3), чтение `GET /v1/device` со старой станцией (поле `license` терпимо — по коду, не по прогону).
- Фикстуры ЛЦ-1 и облачный выпуск ЛЦ-0: паритет проверен тестом на фикстурах; настоящий файл SaaS-админки с боевым ключом при написании не существовал.
- Время записи `refresh` после правок профиля и импорта на большой базе (одна короткая транзакция записи).

## Отклонения при исполнении

_Пусто: дописывает исполнитель._
