# План ОБН-1: безопасная миграция и учёт версий — копия базы хоста и оболочки перед миграциями, правило хранения, `host.upgrade`, запрет понижения установщиком, версии устройств (миграция хоста `0031`, заголовок `X-Markiro-App-Version`), памятка «Откат» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждая база «Markiro Автоном» копируется перед тем, как к ней применятся новые миграции: хост делает проверенную копию механизмом плана РК (`VACUUM INTO`, `integrity_check`, манифест, идентичность I1) с меткой `pre-upgrade-<от>-<до>` в локальную папку копий и хранит её не меньше 14 дней, пишет строку `host.upgrade`, а при неудачной копии не запускает ни одной миграции и не стартует; оболочка копирует `standalone-station.db` в `standalone-station.pre-<версия>.db` и хранит одну такую копию. Установщик больше не ставит старую версию поверх новой (`bundle.windows.allowDowngrades: false`). Хост узнаёт версию и протокол каждого устройства из заголовка `X-Markiro-App-Version`, который оболочка шлёт с каждым запросом, хранит их (`devices.app_version`, `protocol`, новая `version_seen_at`, миграция `0031`) и показывает на странице «Устройства». Памятка установки получает раздел «Откат».

**Architecture:**

- Задача 1 — провод и данные: `markiro_proto::APP_VERSION_HEADER`, поля `protocol` и `versionSeenAt` у `DeviceRecord` (ответ `GET /v1/office/devices`), фикстуры (текущая и «от хоста до ОБН-1»), Zod `deviceRecordSchema` (новые поля необязательны), миграция хоста `0031_device_versions.sql`, чтение в `routes/devices.rs`.
- Задача 2 — хост записывает версию: `auth::authenticate` (пишущий вариант, `AuthDevice`) обновляет `app_version`, `protocol`, `version_seen_at`, когда сообщённое отличается от сохранённого или ещё ничего не сообщалось; `AskingDevice` по-прежнему ничего не пишет; без ревизии и без строки аудита.
- Задача 3 — оболочка шлёт заголовок: `host_client::pinned_builder` ставит `default_headers` с `CARGO_PKG_VERSION` для обоих клиентов (`PinnedClient`, `StreamClient`).
- Задача 4 — модуль `host/src/upgrade.rs`: `pending` (что база ещё не получила), метка `pre-upgrade-<от>-<до>`, `is_pre_upgrade`; правило хранения в `backup/retention.rs` — такая копия живёт не меньше 14 дней.
- Задача 5 — `db::open_upgrading` и `upgrade::prepare`: копия перед миграциями через `backup::copy::make_copy_with_identity_tagged`, строки `host.upgrade` (`ok`, `failed` копии, `failed` миграции), повторное использование копии при цикле перезапусков службы.
- Задача 6 — `crate::start` открывает базу через `db::open_upgrading`; хост с неудачной копией не стартует; сквозная проверка на `127.0.0.1` — копия до миграций и первая копия рабочего хоста живут рядом.
- Задача 7 — оболочка: `LocalDb::open` копирует `standalone-station.db` перед своими миграциями, одна копия; неудачная копия — миграций нет, `OpenFailure::Other`.
- Задача 8 — вебвью: колонка «Версия» на странице «Устройства».
- Задача 9 — установщик и документы: `allowDowngrades: false` и контракт выпуска, памятка установки («Обновление», новый раздел «Откат»), `apps/standalone/AGENTS.md`, раздел 20 спецификации.

**Tech Stack:** Rust (axum, sqlx 0.8.6, aws-lc-rs, reqwest 0.13.4, Tauri 2), TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, React 19.2, Vitest 4 с jsdom, `node --test` для контрактов выпуска.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — §10.6 (копия перед миграциями и откат), §10.8 (без понижения версии), §10.11.7 (учёт версий, ЛО11), §8.3 (строка `host.upgrade`), §12.1 («Копия перед миграциями», «Контракты выпуска»), §12.2, §13 строка 3, §13.1 (номера); этот план пишет §20.
- `/tmp/claude/fb/license-plans-brief.md` — распределение номеров и раздел «ОБН-1 produces» (обязательные имена).
- `apps/standalone/AGENTS.md` — «Audit», «Local database», «Protocol», «Network and TLS», «Installer and service», «Backups and restore», «Logs», «Verification».
- План РК (`docs/superpowers/plans/2026-10-09-standalone-rk-backups.md`) и план I1 — копия, манифест, идентичность, ротация.
- Схема Tauri: `node_modules/.pnpm/@tauri-apps+cli@2.11.4/node_modules/@tauri-apps/cli/config.schema.json` (ключ `bundle.windows.allowDowngrades`, «The default value of this flag is `true`»), `tauri-utils-2.9.3/src/config.rs:1062` (`allow_downgrades: bool`) и `:1091` (умолчание `true`).

## Допущения

- **Д1 — `OfficeDevice` в коде нет.** Запись устройства в офисе — `markiro_proto::DeviceRecord` (`proto/src/lib.rs:503`, ответ `GET /v1/office/devices`, `PUT /v1/office/devices/{id}`, `POST …/revoke`; список только для администраторов, `routes/devices.rs`, `list_devices`). Контрактное «`OfficeDevice` exposes `appVersion`/`protocol`/`versionSeenAt`» исполняется на `DeviceRecord`: `appVersion` там уже есть, добавляются `protocol` и `versionSeenAt`. В Zod оба новых поля **необязательны**: офис версии N с тем же протоколом может говорить с хостом N−1 (§10.11.6), который их не шлёт; фикстура `device-record-legacy.json` закрепляет это.
- **Д2 — `db::open` остаётся как есть.** Им пользуются тесты (`support/app.rs`, свежая база) и собственные проверки восстановления (`restore.rs`, копия базы), где защищать нечего. Старт хоста идёт через новый `db::open_upgrading(path, &upgrade::PreUpgrade)` — это и есть контрактное «`db::open` copies before pending migrations». Других вызывающих у старта нет: копия срабатывает при любом способе обновления, ручная переустановка включительно.
- **Д3 — `<от>` и `<до>` — номера миграций**, а не версии приложения: `from` — наибольшая применённая миграция базы, `to` — наибольшая миграция сборки. Прежнюю версию приложения хост нигде не хранит. Метка — `pre-upgrade-16-31`, имя — `markiro-host-20261013T090000Z-pre-upgrade-16-31.db` (проходит `copy::is_copy_file_name` и у прежних сборок). Версия новой сборки — в `details.appVersion` строки `host.upgrade`. Поздно пришедшая меньшая миграция (sqlx применяет пропуски) тоже «ожидающая»: тогда `from` может равняться `to` (`pre-upgrade-31-31`), а число миграций говорит `details.migrations`.
- **Д4 — у копии перед обновлением в манифесте `trigger: "scheduled"`.** Новый вариант `BackupTrigger` сломал бы ровно то, ради чего копия делается: `read_manifest` прежней сборки (`BackupTrigger` — строгий enum, `proto/src/backup.rs:63–69`) отказал бы в манифесте, и `markiro-host restore` прежней версии при откате (§10.6, шаг 3) не принял бы копию; строгий `backupTriggerSchema = z.enum(["scheduled", "manual"])` (`src/host/backups.ts:40`) уронил бы страницу «Резервные копии» офиса N−1. Отличие несёт имя (`upgrade::is_pre_upgrade`). Офис показывает такую копию как обычную «по расписанию» — пометка перенесена.
- **Д5 — хранение 14 дней считается от самой новой копии папки.** `retention::keep` не знает часов (`host/src/backup/retention.rs:16`, «Retention is relative to the copies' own times»): копия перед обновлением остаётся, пока она не старше самой новой копии папки больше чем на 14 дней (граница включительно), что бы ни сказали остальные правила. Ротация идёт только после новой проверенной копии, и самая новая — только что сделанная, так что это «14 дней по часам хоста» без отдельного источника времени. Копия кладётся только в локальную папку (§10.6) и во вторую папку не реплицируется.
- **Д6 — цикл перезапусков службы.** Служба, которая не стартовала, перезапускается Windows через 5, 30 и далее каждые 60 с (`install.rs`, политика восстановления). Без защиты падающая миграция делала бы полную копию базы раз в минуту. Правило: если самая новая строка `audit_log` — `host.upgrade` `failed` тех же `from`/`to` с именем копии, а копия на месте (манифест читается, размер совпадает), — ничего не записывалось с той попытки (хост не стартовал), и эта копия используется снова (`reused: true`), новой нет. Неудачная копия пробуется заново при каждом старте (свободное место могло появиться), а её строка `failed` пишется один раз, пока повторяется тот же код.
- **Д7 — неудачная миграция после хорошей копии** пишет `host.upgrade` `failed` с `code: "migration_failed"` и именем копии (сверх спецификации: поддержка сразу видит, к какой копии откатываться). Коды неудачной копии — `markiro_proto::backup::failure`.
- **Д8 — запись версии устройства.** `authenticate` с `touch` пишет `app_version`, `protocol` и `version_seen_at`, когда сообщённая пара (версия, протокол) отличается от сохранённой или `version_seen_at` пуст; `version_seen_at` — когда хост впервые услышал от устройства его нынешнюю версию. Ревизии и строки аудита нет (как у `last_seen_at`: это не правка офиса). Версия из заголовка — простой текст 1–50 символов (`validate::clean_text`, то же правило, что у `appVersion` при сопряжении); иное молча не записывается. Протокол — из `server::ClientProtocol` (его ставит `protocol_guard`), а вне стража (будущие маршруты ОБН-3) — из заголовка протокола, целое 1–1000. Спецификация говорит «при открытии потока изменений и при каждом скачивании» (§10.11.7); обязательный контракт брифа — «пишущий вариант `authenticate`» — покрывает и поток, и скачивание.
- **Д9 — неудачная копия оболочки = миграций нет.** `LocalDb::open` отказывает ошибкой `sqlx::Error::Io`, которую `open_failure_of` относит к `OpenFailure::Other`: файл остаётся на месте, приложение открывается без локальной базы (как при базе более новой сборки) и после освобождения места открывается заново. Ошибка проверки «есть ли ожидающие» отдаётся как есть, поэтому испорченный файл по-прежнему `Corrupt`. Версия в имени — `CARGO_PKG_VERSION` новой сборки (§10.6: `pre-<версия>`). «Забыть» копию не трогает: она хранит хеши PIN и бейджей на момент обновления — вопрос владельцу, перенесено.
- **Д10 — `allowDowngrades`.** Ключ и умолчание сверены по схеме Tauri 2.11.4 и `tauri-utils 2.9.3` (см. источники). Как шаблон NSIS отказывает (окно, тихий `/S`, «удалить перед установкой»), без Windows не видно — «Не проверено».
- **Д11 — откат хоста откатывает и станцию на ПК хоста.** Роль `host` ставит службу и станцию одним установщиком; если выпуск менял миграции оболочки, прежнее приложение на ПК хоста не откроет свою локальную базу (`OpenFailure::Other`). Спецификация говорит «Откат станции не предусмотрен» (§10.6); памятка «Откат» для ПК хоста велит положить `standalone-station.pre-<версия>.db` на место базы (более новая база откладывается в папку, не удаляется). Записи этой станции, сделанные после обновления, хост после отката не получит — сказано в памятке.
- **Д12 — `PROTOCOL_VERSION` не повышается.** Заголовок добавочный (хост до ОБН-1 его не читает), новые поля ответа — добавочные и читаются терпимо, `hello` не меняется.

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` — план ЛЦ-2; **`0031_device_versions.sql` — этот план** (`ALTER TABLE devices ADD COLUMN version_seen_at TEXT`; `devices.app_version` и `devices.protocol` есть с `0002`); `0032`–`0033` — резерв. Открытые ветки используют `0017`–`0018` (fb-codesearch, fb-people, fb-templates, fb-mode) — не трогать.
- Миграции оболочки (`src-tauri/migrations`) — в этом направлении новых нет (`0030`–`0031` зарезервированы и не используются). Этот план миграций оболочки не добавляет.
- Облачные миграции (`packages/db/migrations`) — не этого плана.
- Уточнения при исполнении пишутся в `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`, раздел **§20 «Уточнения плана ОБН-1»** (§18 ЛЦ-1, §19 ЛЦ-2, §21 ЛЦ-3, §22 ОБН-2, §23 ОБН-3, §24 ЛЦ-0 — не трогать).
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (ЛЦ-3 ∥ ОБН-2) → ОБН-3. ОБН-1 кода ЛЦ-1 не использует.
- Имена контракта «ОБН-1 produces»: миграция `0031_device_versions.sql`; `markiro_proto::APP_VERSION_HEADER = "x-markiro-app-version"`; `host_client` шлёт его с каждым запросом; `auth::authenticate` (пишущий вариант, не `AskingDevice`) обновляет `devices.app_version`, `devices.protocol`, `version_seen_at` при изменении; офисная запись устройства отдаёт `appVersion`, `protocol`, `versionSeenAt` (на `DeviceRecord`, Д1); копия перед миграциями через код копий РК с меткой `pre-upgrade-<from>-<to>` (Д2, Д3); `audit::actions::HOST_UPGRADE = "host.upgrade"`; оболочка копирует `standalone-station.db` в `standalone-station.pre-<version>.db` перед своими миграциями; `bundle.windows.allowDowngrades: false`.

**Правила исполненного состояния**

- Применённые миграции не меняются: хост `0001`–`0016` (и `0030`, если ЛЦ-2 уже влит), оболочка — все. sqlx принимает пропуски и поздние меньшие номера.
- Изменение формы на проводе — `proto`, Zod (`src/host/protocol.ts`) и фикстуры вместе; типы ответов терпимы, типы запросов — `deny_unknown_fields` (в этом плане новых запросов нет).
- Аудит: точные субъект, действие, цель, итог и разобранные `details`. Имя действия — только из `audit::actions`. В `details` и в журнале процесса нет ключей, токенов, хешей, кодов; SHA-256 копии в `host.upgrade` не пишется (он в манифесте).
- Журнал процесса хоста: коды отказа, номера миграций, имя копии; оболочка — только вид ошибки ввода-вывода, без пути (`AGENTS.md`, «Logs»).
- i18n только через `apps/standalone/src/i18n/ru.json`; `@markiro/ui`; доступность (текст, а не только цвет).

**Код и процесс**

- TDD: сначала падающий тест, затем код. Существующие утверждения не ослабляются; тест, которому новое поле меняет точный JSON (`host/tests/device_line.rs`), дополняется, а не упрощается.
- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml` и `Cargo.lock` не меняются (`reqwest::header` и `sqlx::migrate` уже есть); `package.json` и `pnpm-lock.yaml` не меняются.
- Коммиты — явные пути, сообщение из файла, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR, выпуск и бета — не задачи плана.

## Заметки для исполнения

**Основа.** Ветка плана от `claude/fb-license` (или от `claude/integration` `a4eef5cd6` и новее — ОБН-1 от ЛЦ-1 не зависит). Перед задачей 1 убедиться: есть `apps/standalone/host/migrations/0016_pallet_sheets_logo.sql`, `apps/standalone/host/src/backup/copy.rs` с `make_copy_tagged` и `make_copy_with_identity`, `apps/standalone/src-tauri/tauri.installer.conf.json` без `allowDowngrades`; **нет** `host/migrations/0031_*.sql` и `host/src/upgrade.rs`. Иначе остановиться и назвать расхождение в отчёте. Если план ЛЦ-2 уже влит, `0030_license.sql` на месте — это нормально, тесты этого плана от `0030` не зависят.

**Параллельные планы.** ЛЦ-2 правит `audit.rs` (свои действия), `routes/pairing.rs`, `apps/standalone/AGENTS.md`: при слиянии конфликт в соседних строках `audit::actions` и в документах решается сохранением обеих сторон. ОБН-2 и ОБН-3 опираются на `APP_VERSION_HEADER`, `DeviceRecord.protocol`/`versionSeenAt`, строки `host.upgrade` и `upgrade::is_pre_upgrade`.

**Фрагменты.** Взяты из дерева `/tmp/claude/wt/fb-license` (`f38f4a3e9`), на копии не прогонялись. «Фрагмент … заменить на …» дан так, как стоит в файле; не находится — применить по смыслу и записать в «Отклонения при исполнении».

**Мутации.** Для задач 2, 4, 5 и 7: `cp <файл> /tmp/claude/before && shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL названного теста; `cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum` тот же. Мутацию не коммитить.

**Перед каждым коммитом.** `node_modules/.bin/prettier --ignore-path .prettierignore --write` на изменённые TS, TSX, JSON, MJS и MD, затем `--check`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint` (если тронут TS); Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.

**pnpm, git, Cargo.** pnpm — только с `--config.verifyDepsBeforeRun=false`, без `pnpm install`/`add`; команды из корня репозитория, без `cd`; без `git stash`. В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`, а перед `-p markiro-standalone` — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`). Cargo — `--offline --locked`. В песочнице идут: `-p markiro-proto`, `-p markiro-host --test upgrade --test devices --test device_line --test backup_retention --test codes --lib`, `-p markiro-standalone --test local_db --lib`. Сокет на `127.0.0.1` открывают и идут **вне песочницы**: `-p markiro-host --test backup_start`, `-p markiro-standalone --test device`. Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный `rtk` вывод — `rtk proxy <команда>`. После кода — `graphify update .`, если есть `graphify-out/graph.json`.

## Файлы

- Create: `apps/standalone/host/migrations/0031_device_versions.sql`, `apps/standalone/host/src/upgrade.rs`, `apps/standalone/host/tests/upgrade.rs`, `apps/standalone/proto/fixtures/device-record-legacy.json`, `apps/standalone/src/office/devices/device-version.ts`
- Modify (протокол): `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/device-record.json`, `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/src/host/protocol.ts`
- Modify (хост): `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/db.rs`, `apps/standalone/host/src/auth.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/routes/devices.rs`, `apps/standalone/host/src/backup/copy.rs`, `apps/standalone/host/src/backup/retention.rs`
- Modify (тесты хоста): `apps/standalone/host/tests/devices.rs`, `apps/standalone/host/tests/device_line.rs`, `apps/standalone/host/tests/backup_retention.rs`, `apps/standalone/host/tests/backup_start.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/support/backup.rs`
- Modify (оболочка): `apps/standalone/src-tauri/src/host_client.rs`, `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/src-tauri/tests/device.rs`, `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/src-tauri/tauri.installer.conf.json`
- Modify (вебвью): `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/devices-page.test.tsx`
- Modify (выпуск и документы): `tools/standalone-release/test/installer.test.mjs`, `docs/runbooks/standalone-install.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`

---

### Task 1: Провод и данные — `APP_VERSION_HEADER`, `DeviceRecord.protocol`/`versionSeenAt`, миграция `0031`

**Files:**

- Create: `apps/standalone/host/migrations/0031_device_versions.sql`, `apps/standalone/proto/fixtures/device-record-legacy.json`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/device-record.json`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/host/src/routes/devices.rs`
- Test: `apps/standalone/proto/tests/fixtures.rs`, `apps/standalone/test/protocol.test.ts`, `apps/standalone/host/tests/devices.rs`, `apps/standalone/host/tests/device_line.rs`

**Interfaces:**

- Consumes: `DeviceRecord`, `DEVICES`, `DeviceRow`, `record` (`routes/devices.rs`); `deviceRecordSchema`.
- Produces: `markiro_proto::APP_VERSION_HEADER = "x-markiro-app-version"`; `DeviceRecord { …, app_version, protocol: u32, version_seen_at: Option<String>, … }` (`"protocol"`, `"versionSeenAt"`); Zod `protocol?: number`, `versionSeenAt?: string | null`; колонка `devices.version_seen_at TEXT` (миграция `0031`).

- [ ] **Step 1: Написать падающие тесты**

Заменить `apps/standalone/proto/fixtures/device-record.json` целиком:

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "kind": "station",
  "name": "Станция на линии 2",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "appVersion": "0.1.0",
  "protocol": 3,
  "versionSeenAt": "2026-09-26T10:40:00Z",
  "pairedAt": "2026-09-26T09:15:00Z",
  "lastSeenAt": "2026-09-26T10:40:00Z",
  "revokedAt": null
}
```

Создать `apps/standalone/proto/fixtures/device-record-legacy.json` (ответ хоста до ОБН-1 — прежняя фикстура):

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

Правка `apps/standalone/proto/tests/fixtures.rs`:

Фрагмент:

```rust
    let record: DeviceRecord = round_trip("device-record.json");
    assert_eq!(record.kind, DeviceKind::Station);
    assert_eq!(record.revoked_at, None);
}
```

заменить на:

```rust
    let record: DeviceRecord = round_trip("device-record.json");
    assert_eq!(record.kind, DeviceKind::Station);
    assert_eq!(record.revoked_at, None);
    // Plan ОБН-1: what the device reported on its last request.
    assert_eq!(
        (record.protocol, record.version_seen_at.as_deref()),
        (3, Some("2026-09-26T10:40:00Z"))
    );
}

/// The header every request of the shell carries (plan ОБН-1): one name for
/// the shell, which sends it, and the host, which records it.
#[test]
fn the_app_version_header_has_one_name() {
    assert_eq!(markiro_proto::APP_VERSION_HEADER, "x-markiro-app-version");
}
```

Правка `apps/standalone/test/protocol.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  it("device record", () => {
    expect(deviceRecordSchema.parse(fixture("device-record.json"))).toMatchObject({
      kind: "station",
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      revokedAt: null,
    });
  });
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("device record", () => {
    expect(deviceRecordSchema.parse(fixture("device-record.json"))).toMatchObject({
      kind: "station",
      lineId: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      revokedAt: null,
      protocol: 3,
      versionSeenAt: "2026-09-26T10:40:00Z",
    });
    // A host before plan ОБН-1 (same protocol) sends neither field.
    const legacy = deviceRecordSchema.parse(fixture("device-record-legacy.json"));
    expect(legacy.protocol).toBeUndefined();
    expect(legacy.versionSeenAt).toBeUndefined();
    expect(
      deviceRecordSchema.safeParse({ ...(fixture("device-record.json") as object), protocol: 0 })
        .success,
    ).toBe(false);
  });
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  ["device-record.json", deviceRecordSchema],
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["device-record.json", deviceRecordSchema],
  ["device-record-legacy.json", deviceRecordSchema],
```

Правка `apps/standalone/host/tests/devices.rs` — в конец файла:

```rust
/// The office reads a device's protocol and when its version was last
/// reported (plan ОБН-1): a device paired now spoke protocol 3 at pairing
/// and has reported nothing since.
#[tokio::test]
async fn the_office_reads_a_devices_protocol_and_when_its_version_was_seen() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let record = device(&admin, &station).await;
    assert_eq!(
        (
            record["appVersion"].clone(),
            record["protocol"].clone(),
            record["versionSeenAt"].clone()
        ),
        (
            json!("0.1.0"),
            json!(markiro_proto::PROTOCOL_VERSION),
            Value::Null
        )
    );
}

/// `0031` adds `version_seen_at` to the devices a host already has: each
/// keeps its row, and the column stays empty until the device reports.
#[tokio::test]
async fn migration_0031_keeps_every_device_and_adds_an_empty_version_seen_at() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let before = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != 31)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    assert_eq!(
        before.iter().count() + 1,
        markiro_host::db::MIGRATOR.iter().count()
    );
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before.run(&mut old).await.unwrap();
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('d1', 'station', 'Станция', 'hash-1', '0.1.0', 2, '2026-10-01T08:00:00Z')",
    )
    .execute(&mut old)
    .await
    .unwrap();

    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();

    let row: (String, String, i64, Option<String>) =
        sqlx::query_as("SELECT id, app_version, protocol, version_seen_at FROM devices")
            .fetch_one(&mut old)
            .await
            .unwrap();
    assert_eq!(row, ("d1".to_owned(), "0.1.0".to_owned(), 2, None));
}
```

Правка `apps/standalone/host/tests/device_line.rs` (точный ответ списка устройств получает новые поля):

Фрагмент 1:

```rust
                "id": station_id,
                "kind": "station",
                "name": "Тестовое устройство",
                "lineId": lines[0],
                "appVersion": "0.1.0",
                "pairedAt": now,
```

заменить на:

```rust
                "id": station_id,
                "kind": "station",
                "name": "Тестовое устройство",
                "lineId": lines[0],
                "appVersion": "0.1.0",
                "protocol": markiro_proto::PROTOCOL_VERSION,
                "versionSeenAt": null,
                "pairedAt": now,
```

Фрагмент 2:

```rust
                "id": office_id,
                "kind": "office",
                "name": "Тестовое устройство",
                "lineId": null,
                "appVersion": "0.1.0",
                "pairedAt": now,
```

заменить на:

```rust
                "id": office_id,
                "kind": "office",
                "name": "Тестовое устройство",
                "lineId": null,
                "appVersion": "0.1.0",
                "protocol": markiro_proto::PROTOCOL_VERSION,
                "versionSeenAt": null,
                "pairedAt": now,
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test devices --test device_line
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts
```

Ожидается: `markiro-proto` не собирается (`no field protocol`, `APP_VERSION_HEADER` не найден); хост — FAIL `the_office_reads_a_devices_protocol…` (`protocol` — `null`), `migration_0031_…` (`assert_eq!(before.iter().count() + 1, …)` — версии 31 нет), тест `device_line` со списком устройств (нет `protocol`); Vitest — FAIL «device record» (нет `protocol`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/migrations/0031_device_versions.sql`:

```sql
-- Plan ОБН-1 (spec §10.11.7): when the host first heard a device report the
-- version and protocol it runs now (the shell's `X-Markiro-App-Version` on
-- every request). `app_version` and `protocol` exist since 0002 and hold what
-- the device said when it paired until it reports; NULL here means it has
-- not reported since (an app before plan ОБН-1).
ALTER TABLE devices ADD COLUMN version_seen_at TEXT;
```

Правка `apps/standalone/proto/src/lib.rs`:

Фрагмент 1:

```rust
/// Request header carrying the office session token.
pub const OFFICE_SESSION_HEADER: &str = "x-office-session";
```

заменить на:

```rust
/// Request header carrying the office session token.
pub const OFFICE_SESSION_HEADER: &str = "x-office-session";
/// Request header carrying the app's own version on every request of the
/// shell (plan ОБН-1): the host records it on the device
/// (`devices.app_version`, spec §10.11.7). A host before it ignores it.
pub const APP_VERSION_HEADER: &str = "x-markiro-app-version";
```

Фрагмент 2:

```rust
pub struct DeviceRecord {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub app_version: String,
    pub paired_at: String,
```

заменить на:

```rust
pub struct DeviceRecord {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    /// The version the device last reported (`APP_VERSION_HEADER`), or the
    /// one it named when it paired until it reports (plan ОБН-1).
    pub app_version: String,
    /// The protocol it spoke when it last reported, or at pairing.
    pub protocol: u32,
    /// When the host first heard it report its current version and
    /// protocol; `None` while it has reported nothing since it paired.
    pub version_seen_at: Option<String>,
    pub paired_at: String,
```

Правка `apps/standalone/src/host/protocol.ts`:

Фрагмент:

<!-- prettier-ignore -->
```ts
  appVersion: z.string(),
  pairedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
```

заменить на:

<!-- prettier-ignore -->
```ts
  appVersion: z.string(),
  /**
   * The protocol the device spoke when it last reported its version, or at
   * pairing (plan ОБН-1). Optional: a host before ОБН-1 of the same protocol
   * does not send it.
   */
  protocol: z.number().int().positive().optional(),
  /** When the host first heard the device report its current version; `null` while it has not. */
  versionSeenAt: z.iso.datetime().nullable().optional(),
  pairedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
```

Правка `apps/standalone/host/src/routes/devices.rs`:

Фрагмент:

```rust
const DEVICES: &str = "SELECT id, kind, name, line_id, app_version, paired_at, last_seen_at, \
     revoked_at FROM devices";

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

fn record(row: DeviceRow) -> Result<DeviceRecord, ApiError> {
    let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
    Ok(DeviceRecord {
        id: row.id,
        kind,
        name: row.name,
        line_id: row.line_id,
        app_version: row.app_version,
        paired_at: row.paired_at,
```

заменить на:

```rust
const DEVICES: &str = "SELECT id, kind, name, line_id, app_version, protocol, version_seen_at, \
     paired_at, last_seen_at, revoked_at FROM devices";

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    kind: String,
    name: String,
    line_id: Option<String>,
    app_version: String,
    protocol: i64,
    version_seen_at: Option<String>,
    paired_at: String,
    last_seen_at: Option<String>,
    revoked_at: Option<String>,
}

fn record(row: DeviceRow) -> Result<DeviceRecord, ApiError> {
    let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
    Ok(DeviceRecord {
        id: row.id,
        kind,
        name: row.name,
        line_id: row.line_id,
        app_version: row.app_version,
        protocol: u32::try_from(row.protocol).map_err(ApiError::internal)?,
        version_seen_at: row.version_seen_at,
        paired_at: row.paired_at,
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Команды шага 2 — PASS. Дополнительно (поиск других точных сравнений записи устройства):

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing --test pairing_codes --test claim --test foundation --test org_logo --test backup_schema
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts test/devices-page.test.tsx
```

Ожидается: PASS. Тест, который сравнивал запись устройства целиком и упал на новых полях, дополняется полями (`"protocol": 3`, `"versionSeenAt": null`) и записывается в «Отклонения».

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/proto/fixtures/device-record.json apps/standalone/proto/fixtures/device-record-legacy.json apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/migrations/0031_device_versions.sql apps/standalone/proto/src/lib.rs apps/standalone/proto/fixtures/device-record.json apps/standalone/proto/fixtures/device-record-legacy.json apps/standalone/proto/tests/fixtures.rs apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/host/src/routes/devices.rs apps/standalone/host/tests/devices.rs apps/standalone/host/tests/device_line.rs
git commit -F /tmp/claude/msg-obn1-1.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — device versions on the wire (APP_VERSION_HEADER, protocol, versionSeenAt, migration 0031)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 2: Хост записывает версию и протокол устройства при каждом пишущем входе

**Files:**

- Modify: `apps/standalone/host/src/auth.rs`
- Test: `apps/standalone/host/src/auth.rs` (модуль `tests`), `apps/standalone/host/tests/devices.rs`

**Interfaces:**

- Consumes: `APP_VERSION_HEADER`, `PROTOCOL_HEADER`, `server::ClientProtocol`, `validate::clean_text`, колонка `version_seen_at` (задача 1).
- Produces: `pub fn auth::reported(parts: &Parts) -> Option<(String, u32)>`; `authenticate(…, touch = true)` пишет `app_version`, `protocol`, `version_seen_at` по Д8; `AskingDevice` не пишет ничего.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/host/src/auth.rs` — в конец файла:

```rust
#[cfg(test)]
mod tests {
    use axum::http::Request;

    use super::*;
    use crate::server::ClientProtocol;

    fn parts(version: Option<&str>, guard: Option<u32>, header: Option<&str>) -> Parts {
        let mut builder = Request::builder().uri("/v1/device");
        if let Some(version) = version {
            builder = builder.header(markiro_proto::APP_VERSION_HEADER, version);
        }
        if let Some(protocol) = header {
            builder = builder.header(markiro_proto::PROTOCOL_HEADER, protocol);
        }
        let (mut parts, ()) = builder.body(()).unwrap().into_parts();
        if let Some(protocol) = guard {
            parts.extensions.insert(ClientProtocol(protocol));
        }
        parts
    }

    /// A version is recorded only as plain text of 1-50 characters, with a
    /// protocol: the guard's, or outside the guard the header's (plan ОБН-3's
    /// routes), a whole number 1-1000.
    #[test]
    fn a_reported_version_is_plain_text_with_a_protocol() {
        assert_eq!(
            reported(&parts(Some(" 0.2.0 "), Some(3), None)),
            Some(("0.2.0".to_owned(), 3))
        );
        assert_eq!(
            reported(&parts(Some("0.2.0"), None, Some("1"))),
            Some(("0.2.0".to_owned(), 1))
        );
        // The guard's protocol wins over the header's.
        assert_eq!(
            reported(&parts(Some("0.2.0"), Some(3), Some("2"))),
            Some(("0.2.0".to_owned(), 3))
        );
        for (version, header) in [
            (Some("0.2.0"), Some("0")),
            (Some("0.2.0"), Some("1001")),
            (Some("0.2.0"), Some("3x")),
            (Some("0.2.0"), None),
            (None, Some("3")),
            (Some(""), Some("3")),
            (Some("   "), Some("3")),
        ] {
            assert_eq!(reported(&parts(version, None, header)), None, "{version:?} {header:?}");
        }
        let long = "9".repeat(51);
        assert_eq!(reported(&parts(Some(&long), Some(3), None)), None);
    }
}
```

Правка `apps/standalone/host/tests/devices.rs`:

Фрагмент (импорт):

```rust
use support::app::{
    admin, audit_trail, empty, host_revision, login, pair_device, request, seed_office_user,
    with_device, with_session, Admin,
};
```

заменить на:

```rust
use support::app::{
    admin, audit_rows, audit_trail, code_hash, empty, host_revision, login, pair_device,
    request, seed_office_user, with_device, with_session, Admin,
};
```

В конец файла:

```rust
/// `GET /v1/device` with `key`, naming `version` in the app's header when
/// given (plan ОБН-1).
async fn ask_device(admin: &Admin, key: &str, version: Option<&str>) -> StatusCode {
    let mut builder = with_device(request("GET", "/v1/device"), key);
    if let Some(version) = version {
        builder = builder.header(markiro_proto::APP_VERSION_HEADER, version);
    }
    admin.app.send(empty(builder)).await.0
}

/// A device's version, protocol and when they were seen, as the office reads
/// them.
async fn version_of(admin: &Admin, id: &str) -> (Value, Value, Value) {
    let record = device(admin, id).await;
    (
        record["appVersion"].clone(),
        record["protocol"].clone(),
        record["versionSeenAt"].clone(),
    )
}

/// Every device request records the version the app names, once it changes
/// (plan ОБН-1, spec §10.11.7): no revision, no audit row, a request without
/// the header or with a version that is no plain text changes nothing, and
/// the code check, which writes nothing, does not record it either.
#[tokio::test]
async fn a_device_request_records_the_version_the_app_names_once_it_changes() {
    let admin = admin().await;
    let (station, key) = pair_device(&admin.app, "station").await;
    let protocol = json!(markiro_proto::PROTOCOL_VERSION);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;

    let first = admin.app.state.timestamp();
    assert_eq!(ask_device(&admin, &key, Some("0.2.0")).await, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // The same version later: nothing is written, the time stays the first.
    admin.app.clock.advance(time::Duration::minutes(5));
    assert_eq!(ask_device(&admin, &key, Some("0.2.0")).await, StatusCode::OK);
    assert_eq!(ask_device(&admin, &key, None).await, StatusCode::OK);
    let long = "9".repeat(51);
    assert_eq!(ask_device(&admin, &key, Some(&long)).await, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // The code check answers within 300 ms and never writes.
    let (status, _) = admin
        .app
        .send(empty(
            with_device(
                request("GET", &format!("/v1/device/codes/{}", code_hash(1))),
                &key,
            )
            .header(markiro_proto::APP_VERSION_HEADER, "0.4.0"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // A new version: recorded with the time it was first heard.
    let second = admin.app.state.timestamp();
    assert_eq!(ask_device(&admin, &key, Some("0.3.0-beta.1")).await, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.3.0-beta.1"), protocol.clone(), json!(second))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// An office request records the version of the device it comes from: the
/// office session rides on the device's key (`OfficeContext`).
#[tokio::test]
async fn an_office_request_records_the_version_of_its_device() {
    let admin = admin().await;
    let (status, _) = admin
        .app
        .send(empty(
            with_session(request("GET", "/v1/office/me"), &admin.key, &admin.token)
                .header(markiro_proto::APP_VERSION_HEADER, "0.5.0"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = admin.call("GET", "/v1/office/devices", None).await;
    let own = list
        .as_array()
        .unwrap()
        .iter()
        .find(|device| device["appVersion"] == "0.5.0")
        .cloned();
    assert!(own.is_some(), "{list}");
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib auth::tests
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test devices
```

Ожидается: `--lib` не собирается (`reported` не найдена); `devices` — FAIL `a_device_request_records…` (`appVersion` остаётся `0.1.0`), `an_office_request_records…`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/auth.rs`:

Фрагмент 1 (импорты):

```rust
use markiro_proto::{
    codes, credentials, DeviceKind, OfficeRole, OfficeUser, OFFICE_SESSION_HEADER,
};
```

заменить на:

```rust
use markiro_proto::{
    codes, credentials, DeviceKind, OfficeRole, OfficeUser, APP_VERSION_HEADER,
    OFFICE_SESSION_HEADER, PROTOCOL_HEADER,
};
```

Фрагмент 2:

```rust
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, kind, last_seen_at FROM devices WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(key_hash(key))
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (id, kind, last_seen_at) = row.ok_or_else(|| {
        ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
    })?;
```

заменить на:

```rust
    let row: Option<DeviceAuthRow> = sqlx::query_as(
        "SELECT id, kind, last_seen_at, app_version, protocol, version_seen_at FROM devices \
         WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(key_hash(key))
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (id, kind, last_seen_at, app_version, protocol, version_seen_at) = row.ok_or_else(|| {
        ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
    })?;
```

Фрагмент 3:

```rust
    if touch {
        let now = state.now();
        let due = format_timestamp(now - time::Duration::minutes(1));
```

заменить на:

```rust
    if touch {
        let now = state.now();
        // The version the app names on every request (plan ОБН-1): written
        // only when it, or the protocol, differs from what is stored, or
        // nothing was reported since pairing, so a working device takes the
        // write lock for it once per upgrade. No revision, no audit row: like
        // `last_seen_at`, this is no office change.
        if let Some((reported_version, reported_protocol)) = reported(parts) {
            let reported_protocol = i64::from(reported_protocol);
            if version_seen_at.is_none()
                || app_version != reported_version
                || protocol != reported_protocol
            {
                sqlx::query(
                    "UPDATE devices SET app_version = ?, protocol = ?, version_seen_at = ? \
                     WHERE id = ? AND (version_seen_at IS NULL OR app_version IS NOT ? \
                     OR protocol IS NOT ?)",
                )
                .bind(&reported_version)
                .bind(reported_protocol)
                .bind(format_timestamp(now))
                .bind(&id)
                .bind(&reported_version)
                .bind(reported_protocol)
                .execute(&state.pool)
                .await
                .map_err(ApiError::internal)?;
            }
        }
        let due = format_timestamp(now - time::Duration::minutes(1));
```

Фрагмент 4 (перед `impl AuthDevice {`):

```rust
impl AuthDevice {
    /// The device is still paired and not revoked, read inside the write
```

заменить на:

```rust
/// `id, kind, last_seen_at, app_version, protocol, version_seen_at` of a
/// device found by its key.
type DeviceAuthRow = (String, String, Option<String>, String, i64, Option<String>);

/// The largest protocol read from the header outside `protocol_guard`.
const MAX_REPORTED_PROTOCOL: u32 = 1000;

/// The version and protocol a request reports (plan ОБН-1): the app's
/// header as plain text of 1-50 characters (the pairing's rule for
/// `appVersion`), with the protocol `protocol_guard` read, or, on a route
/// outside the guard, the protocol header's whole number 1-1000. `None`
/// when either is missing or malformed: nothing is recorded then.
pub fn reported(parts: &Parts) -> Option<(String, u32)> {
    let version = parts
        .headers
        .get(APP_VERSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| crate::validate::clean_text("appVersion", value, 50, "the app version").ok())?
        .to_owned();
    let protocol = match parts.extensions.get::<crate::server::ClientProtocol>() {
        Some(protocol) => protocol.0,
        None => parts
            .headers
            .get(PROTOCOL_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|protocol| (1..=MAX_REPORTED_PROTOCOL).contains(protocol))?,
    };
    Some((version, protocol))
}

impl AuthDevice {
    /// The device is still paired and not revoked, read inside the write
```

В документацию `AskingDevice` («`last_seen_at` is never touched») дописать: «nor the version it reports (plan ОБН-1)».

- [ ] **Step 4: Убедиться, что тесты проходят; мутации**

Команды шага 2 — PASS; затем `--test codes --test office_auth --test changes_stream --test device_line` — PASS.

Мутации (каждая — FAIL названного теста, затем откат):

- M1: условие `if version_seen_at.is_none() || …` → `if true` — FAIL `a_device_request_records…` (время перезаписано через 5 минут).
- M2: в `AskingDevice::from_request_parts` `authenticate(parts, state, false)` → `true` — FAIL (`0.4.0` записан кодом проверки).
- M3: `.filter(|protocol| (1..=MAX_REPORTED_PROTOCOL).contains(protocol))` убрать — FAIL `a_reported_version_is_plain_text_with_a_protocol` (`0`, `1001`).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/auth.rs apps/standalone/host/tests/devices.rs
git commit -F /tmp/claude/msg-obn1-2.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the host records each device's reported version and protocol` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 3: Оболочка шлёт `X-Markiro-App-Version` с каждым запросом

**Files:**

- Modify: `apps/standalone/src-tauri/src/host_client.rs`
- Test: `apps/standalone/src-tauri/src/host_client.rs` (модуль `tests`), `apps/standalone/src-tauri/tests/device.rs`

**Interfaces:**

- Consumes: `APP_VERSION_HEADER` (задача 1), запись версии хостом (задача 2).
- Produces: `fn default_headers() -> HeaderMap` в `host_client`; `pinned_builder` ставит его обоим клиентам.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/src/host_client.rs` — в модуль `#[cfg(test)] mod tests` (после `fn credentials_debug_output_hides_the_key_and_the_token`):

```rust
    /// Every request to the host names the app's version (plan ОБН-1): the
    /// host records it on the device. Both clients take these headers from
    /// `pinned_builder`.
    #[test]
    fn every_request_names_the_apps_version() {
        let headers = default_headers();
        assert_eq!(headers.len(), 1);
        assert_eq!(
            headers
                .get(markiro_proto::APP_VERSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }
```

Правка `apps/standalone/src-tauri/tests/device.rs`:

Фрагмент:

```rust
use serde_json::json;

const NAME: &str = "Рабочее место хоста";
```

заменить на:

```rust
use serde_json::json;
use sqlx::{ConnectOptions, Connection};

const NAME: &str = "Рабочее место хоста";

/// What the host stores of a device's version (plan ОБН-1), read from its
/// stopped database.
async fn recorded_version(host_dir: &std::path::Path, device_id: &str) -> (String, i64, Option<String>) {
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(HostPaths::new(host_dir).database_file())
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let row = sqlx::query_as(
        "SELECT app_version, protocol, version_seen_at FROM devices WHERE id = ?",
    )
    .bind(device_id)
    .fetch_one(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    row
}
```

В конец файла:

```rust
/// A paired app names its version on every request, and the host records
/// it (plan ОБН-1, spec §10.11.7): the pairing named 0.0.9, the first device
/// request says this build's version.
#[tokio::test]
async fn every_request_names_the_app_version_and_the_host_records_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let status = state
        .local_pair(&address(&host), NAME, "0.0.9")
        .await
        .unwrap();
    let response = state
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    host.stop().await.unwrap();
    let (version, protocol, seen) = recorded_version(host_dir.path(), &status.device_id).await;
    assert_eq!(
        (version.as_str(), protocol),
        (
            env!("CARGO_PKG_VERSION"),
            i64::from(markiro_proto::PROTOCOL_VERSION)
        )
    );
    assert!(seen.is_some(), "the host notes when it first heard the version");
}
```

Если `markiro_proto` не в зависимостях тестов оболочки напрямую — использовать `markiro_standalone_lib`-реэкспорт или константу `3` с комментарием и записать в «Отклонения» (проверить `src-tauri/Cargo.toml`: `markiro-proto` — обычная зависимость оболочки, `host_client.rs` её импортирует).

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib host_client
# вне песочницы (сокет на 127.0.0.1):
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test device every_request_names
```

Ожидается: `--lib` не собирается (`default_headers` не найдена); `--test device` — FAIL (`0.0.9` вместо `CARGO_PKG_VERSION`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/host_client.rs`:

Фрагмент 1:

```rust
use markiro_proto::{Secret, OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION};
use reqwest::Method;
```

заменить на:

```rust
use markiro_proto::{
    Secret, APP_VERSION_HEADER, OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION,
};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Method;
```

Фрагмент 2:

```rust
/// A client builder that trusts only the certificate with `fingerprint`:
/// no proxy, no redirects, HTTPS only, 2 s to connect.
fn pinned_builder(fingerprint: &str) -> Result<reqwest::ClientBuilder, RequestError> {
    let config = tls::client_config(FingerprintPolicy::Pin {
        expected: fingerprint.to_owned(),
    })
    .map_err(|_| RequestError::Unreachable)?;
    Ok(reqwest::Client::builder()
        .use_preconfigured_tls(config)
```

заменить на:

```rust
/// The headers every request to the host carries besides the protocol (plan
/// ОБН-1): the app's own version, which the host records on the device
/// (`devices.app_version`, spec §10.11.7).
fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        APP_VERSION_HEADER,
        HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
    headers
}

/// A client builder that trusts only the certificate with `fingerprint`:
/// no proxy, no redirects, HTTPS only, 2 s to connect, and the app's version
/// on every request ([`default_headers`]).
fn pinned_builder(fingerprint: &str) -> Result<reqwest::ClientBuilder, RequestError> {
    let config = tls::client_config(FingerprintPolicy::Pin {
        expected: fingerprint.to_owned(),
    })
    .map_err(|_| RequestError::Unreachable)?;
    Ok(reqwest::Client::builder()
        .default_headers(default_headers())
        .use_preconfigured_tls(config)
```

Документацию модуля («the protocol header on every request») дополнить: «and the app's version (plan ОБН-1)».

- [ ] **Step 4: Убедиться, что тесты проходят**

Команды шага 2 — PASS; затем вне песочницы `--test device --test claim --test connection --test host_address --test host_request_timeout` и в песочнице `--test ipc` — PASS (контракт IPC не меняется).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/src-tauri/src/host_client.rs apps/standalone/src-tauri/tests/device.rs
git commit -F /tmp/claude/msg-obn1-3.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the shell names its version on every request to the host` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 4: Модуль `upgrade` — ожидающие миграции, метка `pre-upgrade`, правило хранения 14 дней

**Files:**

- Create: `apps/standalone/host/src/upgrade.rs`, `apps/standalone/host/tests/upgrade.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/backup/retention.rs`
- Test: `apps/standalone/host/tests/upgrade.rs`, `apps/standalone/host/tests/backup_retention.rs`

**Interfaces:**

- Consumes: `db::MIGRATOR`, `backup::copy::{COPY_PREFIX, copy_name, is_copy_file_name}`.
- Produces: `upgrade::{Pending { from, to, migrations }, Pending::tag, pending(conn, migrator), is_pre_upgrade(file), TAG_PREFIX, KEEP_DAYS}`; `retention::keep` хранит копию перед обновлением 14 дней (Д5).

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/host/tests/upgrade.rs`:

```rust
//! The copy of the master database before this build's pending migrations
//! (plan ОБН-1, spec §10.6): `upgrade::pending` reads what a database lacks,
//! and a copy before an upgrade is known by its name. No socket: runs in the
//! sandbox.

mod support;

use std::borrow::Cow;

use markiro_host::backup::copy::{copy_name, is_copy_file_name};
use markiro_host::db::MIGRATOR;
use markiro_host::upgrade::{self, Pending};
use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};
use support::backup::at;

const AT: &str = "2026-10-13T09:00:00Z";
/// The migration this plan adds: the databases below lack it.
const ADDED: i64 = 31;

fn without(version: i64) -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version != version)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// The newest migration of a database without `ADDED`, and of this build.
fn versions() -> (i64, i64) {
    let all = || MIGRATOR.iter().map(|migration| migration.version);
    (
        all().filter(|version| *version != ADDED).max().unwrap(),
        all().max().unwrap(),
    )
}

async fn memory() -> SqliteConnection {
    SqliteConnection::connect("sqlite::memory:").await.unwrap()
}

#[tokio::test]
async fn pending_names_what_a_database_lacks_and_nothing_for_a_new_or_a_foreign_one() {
    assert!(MIGRATOR.iter().any(|migration| migration.version == ADDED));
    let (from, to) = versions();
    // A new file: no migrations table.
    let mut fresh = memory().await;
    assert_eq!(upgrade::pending(&mut fresh, &MIGRATOR).await.unwrap(), None);
    // The table without a row: a first start that stopped before its first
    // migration has nothing to protect.
    Migrator {
        migrations: Cow::Owned(vec![]),
        ..Migrator::DEFAULT
    }
    .run(&mut fresh)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut fresh, &MIGRATOR).await.unwrap(), None);

    let mut old = memory().await;
    without(ADDED).run(&mut old).await.unwrap();
    assert_eq!(
        upgrade::pending(&mut old, &MIGRATOR).await.unwrap(),
        Some(Pending {
            from,
            to,
            migrations: 1
        })
    );
    // A lower migration that arrives late is pending too: sqlx applies it.
    let mut gap = memory().await;
    without(11).run(&mut gap).await.unwrap();
    assert_eq!(
        upgrade::pending(&mut gap, &MIGRATOR).await.unwrap(),
        Some(Pending {
            from: to,
            to,
            migrations: 1
        })
    );
    // Up to date: nothing.
    MIGRATOR.run(&mut old).await.unwrap();
    assert_eq!(upgrade::pending(&mut old, &MIGRATOR).await.unwrap(), None);
    // A migration this build does not know: sqlx refuses the database as
    // before, and there is nothing to copy for.
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'newer', 1, x'00', 0)",
    )
    .execute(&mut old)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut old, &MIGRATOR).await.unwrap(), None);
    // A migration recorded as failed: sqlx refuses it as dirty.
    let mut dirty = memory().await;
    without(ADDED).run(&mut dirty).await.unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?, 'device versions', 0, x'00', 0)",
    )
    .bind(ADDED)
    .execute(&mut dirty)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut dirty, &MIGRATOR).await.unwrap(), None);
}

#[test]
fn a_copy_before_an_upgrade_is_known_by_its_name() {
    let pending = Pending {
        from: 16,
        to: 31,
        migrations: 2,
    };
    assert_eq!(pending.tag(), "pre-upgrade-16-31");
    let name = copy_name(at(AT), &pending.tag());
    assert_eq!(name, "markiro-host-20261013T090000Z-pre-upgrade-16-31.db");
    // Every build since plan РК takes it as a copy's name: the rollback's
    // `restore` of the previous version reads it.
    assert!(is_copy_file_name(&name));
    assert!(upgrade::is_pre_upgrade(&name));
    assert!(!upgrade::is_pre_upgrade(&copy_name(at(AT), "1a2b3c4d")));
    assert!(!upgrade::is_pre_upgrade("markiro-host-pre-upgrade-16-31.db"));
    assert!(!upgrade::is_pre_upgrade("other-20261013T090000Z-pre-upgrade-16-31.db"));
}
```

Правка `apps/standalone/host/tests/backup_retention.rs` — в конец файла:

```rust
/// A copy made before pending migrations (plan ОБН-1) stays at least 14 days
/// after it was made, counted back from the folder's newest copy, whatever
/// the hourly, daily and monthly rule says; nothing else the rule keeps
/// changes.
#[test]
fn a_copy_before_an_upgrade_stays_fourteen_days_whatever_the_rule_says() {
    use markiro_host::backup::copy::copy_name;

    let named = |created: &str, tag: &str| {
        copy(
            &copy_name(markiro_host::clock::parse_timestamp(created).unwrap(), tag),
            created,
        )
    };
    // One copy an hour from 1 to 20 October 2026; the newest is 20 October
    // 23:00, so the floor is 6 October 23:00.
    let mut copies = Vec::new();
    for day in 1..=20 {
        for hour in 0..24 {
            copies.push(named(
                &format!("2026-10-{day:02}T{hour:02}:00:00Z"),
                &format!("{day:02}{hour:02}0000"),
            ));
        }
    }
    let by_rule = kept(&copies);
    // 13 days 15 hours old, exactly 14 days old, 14 days 30 minutes old.
    let young = named("2026-10-07T08:00:30Z", "pre-upgrade-16-31");
    let boundary = named("2026-10-06T23:00:00Z", "pre-upgrade-12-16");
    let old = named("2026-10-06T22:30:00Z", "pre-upgrade-11-12");
    copies.extend([young.clone(), boundary.clone(), old.clone()]);
    let with = kept(&copies);
    assert!(with.contains(&young.0), "{with:?}");
    assert!(with.contains(&boundary.0), "{with:?}");
    assert!(!with.contains(&old.0), "{with:?}");
    let mut expected = by_rule;
    expected.extend([young.0, boundary.0]);
    expected.sort();
    assert_eq!(with, expected);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test upgrade --test backup_retention
```

Ожидается: `upgrade` не собирается (`markiro_host::upgrade` не найден); `backup_retention` — FAIL `a_copy_before_an_upgrade_stays…` (`young` и `boundary` удалены правилом).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/src/upgrade.rs`:

```rust
//! The copy of the master database before this build's pending migrations
//! (plan ОБН-1, spec §10.6). `db::open_upgrading` opens the database without
//! migrating it, asks [`pending`] whether this build brings migrations the
//! database lacks and, when it does, makes a verified copy through the
//! backups' own code (`backup::copy`, plan РК: `VACUUM INTO`,
//! `integrity_check`, the manifest, the host identity of plan I1) into the
//! local folder of copies before a single migration runs. Its name carries
//! the tag `pre-upgrade-<from>-<to>` (migration numbers); the retention keeps
//! it for [`KEEP_DAYS`] days whatever its other rules say.
//!
//! The manifest of such a copy says `trigger: "scheduled"`: a new trigger
//! would make it unreadable to the build an administrator rolls back to
//! (`read_manifest` refuses an unknown variant, so that build's `restore`
//! would refuse the very copy the rollback needs), and the strict
//! `backupTriggerSchema` of an older office would fail its whole page of
//! copies. The name is the mark ([`is_pre_upgrade`]).

use sqlx::migrate::Migrator;
use sqlx::SqliteConnection;

use crate::backup::copy::COPY_PREFIX;

/// The tag of a copy made before pending migrations: `pre-upgrade-<from>-<to>`.
pub const TAG_PREFIX: &str = "pre-upgrade-";
/// How many days such a copy stays at least (spec §10.6).
pub const KEEP_DAYS: i64 = 14;

/// Migrations of this build that a database lacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pending {
    /// The newest migration the database has.
    pub from: i64,
    /// The newest migration of this build.
    pub to: i64,
    /// How many of this build's migrations the database lacks (a lower one
    /// that arrives late counts: sqlx applies it).
    pub migrations: usize,
}

impl Pending {
    /// `pre-upgrade-<from>-<to>`: the tag in the copy's name.
    pub fn tag(&self) -> String {
        format!("{TAG_PREFIX}{}-{}", self.from, self.to)
    }
}

/// Whether `file` is the name of a copy made before pending migrations:
/// `markiro-host-<UTC time, 16 characters>-pre-upgrade-…`.
pub fn is_pre_upgrade(file: &str) -> bool {
    file.strip_prefix(COPY_PREFIX)
        .and_then(|rest| rest.get(17..))
        .is_some_and(|tag| tag.starts_with(TAG_PREFIX))
}

/// What this build's `migrator` would add to the database on `conn`, on top
/// of at least one migration it has. `None` for a new file (no migrations
/// table, or no row in it), for a database that is up to date, and for one
/// with a failed migration or one this build does not know: sqlx refuses
/// those as before, and a copy would protect nothing new.
pub async fn pending(
    conn: &mut SqliteConnection,
    migrator: &Migrator,
) -> Result<Option<Pending>, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(&mut *conn)
    .await?;
    if tables == 0 {
        return Ok(None);
    }
    let applied: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations")
            .fetch_all(&mut *conn)
            .await?;
    let known: Vec<i64> = migrator
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .collect();
    if applied
        .iter()
        .any(|(version, success)| !success || !known.contains(version))
    {
        return Ok(None);
    }
    let Some(from) = applied.iter().map(|(version, _)| *version).max() else {
        return Ok(None);
    };
    let Some(to) = known.iter().copied().max() else {
        return Ok(None);
    };
    let migrations = known
        .iter()
        .filter(|version| !applied.iter().any(|(applied, _)| applied == *version))
        .count();
    Ok((migrations > 0).then_some(Pending {
        from,
        to,
        migrations,
    }))
}
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент:

```rust
pub mod templates;
pub mod tls;
pub mod validate;
```

заменить на:

```rust
pub mod templates;
pub mod tls;
pub mod upgrade;
pub mod validate;
```

Правка `apps/standalone/host/src/backup/retention.rs`:

Фрагмент 1:

```rust
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason.
```

заменить на:

```rust
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason. A copy made before
//! pending migrations (plan ОБН-1, `crate::upgrade`) stays besides for
//! `upgrade::KEEP_DAYS` days.
```

Фрагмент 2:

```rust
        let month = (at.year(), at.month());
        if months.len() < MONTHLY && !months.contains(&month) {
            months.push(month);
            kept.insert(name.clone());
        }
    }
    kept
}
```

заменить на:

```rust
        let month = (at.year(), at.month());
        if months.len() < MONTHLY && !months.contains(&month) {
            months.push(month);
            kept.insert(name.clone());
        }
    }
    // A copy before an upgrade stays while it is no more than
    // `upgrade::KEEP_DAYS` days older than the folder's newest copy: the rule
    // has no clock of its own, and the newest copy is the one a run just made.
    if let Some(newest) = newest_first.first().map(|copy| copy.1) {
        let floor = newest - time::Duration::days(crate::upgrade::KEEP_DAYS);
        for (name, at) in &newest_first {
            if *at >= floor && crate::upgrade::is_pre_upgrade(name) {
                kept.insert(name.clone());
            }
        }
    }
    kept
}
```

- [ ] **Step 4: Убедиться, что тесты проходят; мутации**

Команда шага 2 — PASS; `--test backup_worker --test backup_copy` — PASS.

Мутации: M4 — `*at >= floor` → `*at > floor` (FAIL `boundary`); M5 — убрать `|| !known.contains(version)` из условия (FAIL случай `9999`); M6 — `rest.get(17..)` → `rest.get(16..)` (FAIL `is_pre_upgrade`).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/upgrade.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/backup/retention.rs apps/standalone/host/tests/upgrade.rs apps/standalone/host/tests/backup_retention.rs
git commit -F /tmp/claude/msg-obn1-4.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — pending migrations, the pre-upgrade tag and its 14-day retention` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 5: `db::open_upgrading` — копия перед миграциями, `host.upgrade`, неудача без миграций

**Files:**

- Modify: `apps/standalone/host/src/upgrade.rs`, `apps/standalone/host/src/db.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/backup/copy.rs`, `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/support/backup.rs`
- Test: `apps/standalone/host/tests/upgrade.rs`

**Interfaces:**

- Consumes: `upgrade::pending`, `Pending::tag` (задача 4); `copy::make_copy_in`, `read_manifest`, `is_copy_file_name`; `HostIdentity::read`, `platform_guard`, `KeyFileGuard`; `audit::record`.
- Produces: `audit::actions::HOST_UPGRADE = "host.upgrade"`; `copy::make_copy_with_identity_tagged`; `upgrade::{PreUpgrade { data_dir, backups_dir, host_id, guard, at }, PreUpgrade::for_paths, OpenError { Database, Copy { pending, failure } }, Prepared, prepare, record_done, record_failed_migration, MIGRATION_FAILED}`; `db::open_upgrading(path, &PreUpgrade) -> Result<SqlitePool, OpenError>`; тестовые помощники `support::backup::database_without`, `support::app::audit_trail_in`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/host/tests/support/backup.rs`:

Фрагмент:

```rust
use sqlx::{ConnectOptions, SqliteConnection};
```

заменить на:

```rust
use sqlx::{ConnectOptions, Connection, SqliteConnection};
```

В конец файла:

```rust
/// `host.db` of the data folder `dir` with every migration of this build but
/// `version` (plan ОБН-1): what a host of the previous build left behind.
pub async fn database_without(dir: &Path, version: i64) {
    let path = HostPaths::new(dir).database_file();
    let mut conn = markiro_host::db::options(&path)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != version)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
}
```

Правка `apps/standalone/host/tests/support/app.rs`:

Фрагмент:

```rust
/// Every audit row of `action`, oldest first.
pub async fn audit_trail(app: &TestApp, action: &str) -> Vec<AuditRow> {
```

заменить на:

```rust
/// Every audit row of `action`, oldest first.
pub async fn audit_trail(app: &TestApp, action: &str) -> Vec<AuditRow> {
    audit_trail_in(&app.state.pool, action).await
}

/// [`audit_trail`] of any pool: a database a test opened itself (plan ОБН-1).
pub async fn audit_trail_in(pool: &sqlx::SqlitePool, action: &str) -> Vec<AuditRow> {
```

и в теле прежней функции `.fetch_all(&app.state.pool)` заменить на `.fetch_all(pool)`.

Правка `apps/standalone/host/tests/upgrade.rs`:

Фрагмент (импорты):

```rust
use markiro_host::backup::copy::{copy_name, is_copy_file_name};
use markiro_host::db::MIGRATOR;
use markiro_host::upgrade::{self, Pending};
use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};
use support::backup::at;
```

заменить на:

```rust
use std::sync::Arc;

use markiro_host::backup::copy::{copy_name, is_copy_file_name, read_manifest, verify_database};
use markiro_host::backup::identity::OwnerOnly;
use markiro_host::config::HostPaths;
use markiro_host::db::{self, MIGRATOR};
use markiro_host::upgrade::{self, OpenError, Pending, PreUpgrade};
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::migrate::Migrator;
use sqlx::{ConnectOptions, Connection, SqliteConnection, SqlitePool};
use support::app::{audit_trail_in, AuditRow};
use support::backup::{at, database_without, names, write_identity};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

В конец файла:

```rust
/// A data folder whose `host.db` has every migration but `ADDED`, one line,
/// and the host identity of a host that ran there.
async fn old_host(dir: &std::path::Path) -> HostPaths {
    write_identity(dir, HOST_ID);
    database_without(dir, ADDED).await;
    let paths = HostPaths::new(dir);
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query(
        "INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, 'Линия 1', 'линия 1', 0, 1)",
    )
    .bind(LINE)
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    paths
}

fn pre(paths: &HostPaths, when: &str) -> PreUpgrade {
    PreUpgrade {
        data_dir: paths.data_dir.clone(),
        backups_dir: paths.backups_dir(),
        host_id: HOST_ID.to_owned(),
        guard: Arc::new(OwnerOnly),
        at: at(when),
    }
}

/// The applied migrations of the folder's database, read without migrating.
async fn applied(paths: &HostPaths) -> Vec<i64> {
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    let versions = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
    )
    .fetch_all(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    versions
}

/// A pool on the folder's database without migrations: what a test reads
/// the audit from after a start that gave no pool.
async fn raw_pool(paths: &HostPaths) -> SqlitePool {
    SqlitePool::connect_with(db::options(&paths.database_file()))
        .await
        .unwrap()
}

fn upgrade_row(file: Option<&str>, result: &str, details: serde_json::Value) -> AuditRow {
    (
        "system".to_owned(),
        None,
        "host.upgrade".to_owned(),
        Some("backup".to_owned()),
        file.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

/// A database of the previous build is copied before its migrations: a
/// verified copy with the host identity in the local folder, named for the
/// migrations, holding the data as it was; then every migration runs, and
/// one `host.upgrade` row says so. The next start has nothing pending.
#[tokio::test]
async fn a_database_with_pending_migrations_is_copied_before_they_run() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();

    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .unwrap();

    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));
    let stem = file.trim_end_matches(".db");
    assert_eq!(
        names(&paths.backups_dir()),
        [file.clone(), format!("{stem}.identity"), format!("{stem}.json")]
    );
    let copy = paths.backups_dir().join(&file);
    let manifest = read_manifest(&copy).unwrap();
    assert_eq!(
        (manifest.trigger, manifest.host_id.as_str(), manifest.schema_version),
        (BackupTrigger::Scheduled, HOST_ID, from)
    );
    assert!(manifest.identity.is_some(), "the copy carries the host identity (plan I1)");
    assert_eq!(verify_database(&copy).await, Ok(from));
    let mut read = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&copy)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .unwrap();
    let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lines WHERE id = ?")
        .bind(LINE)
        .fetch_one(&mut read)
        .await
        .unwrap();
    assert_eq!(lines, 1);
    read.close().await.unwrap();
    let all: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let now: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(now, all);
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![upgrade_row(
            Some(&file),
            "ok",
            json!({
                "from": from, "to": to, "migrations": 1, "file": file, "reused": false,
                "code": null, "appVersion": env!("CARGO_PKG_VERSION"),
            }),
        )]
    );
    pool.close().await;

    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T10:00:00Z"))
        .await
        .unwrap();
    assert_eq!(names(&paths.backups_dir()).len(), 3, "nothing pending: no copy");
    assert_eq!(audit_trail_in(&pool, "host.upgrade").await.len(), 1);
    pool.close().await;
}

/// A new database (the installer's first start) has nothing to protect: no
/// copy, no row.
#[tokio::test]
async fn a_new_database_takes_its_migrations_without_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .unwrap();
    assert!(names(&paths.backups_dir()).is_empty());
    assert!(audit_trail_in(&pool, "host.upgrade").await.is_empty());
    pool.close().await;
}

/// A copy that fails runs no migration and says why: the database stays at
/// the previous build's schema, a file already there is never replaced, and
/// the `failed` row is written once while the same failure repeats.
#[tokio::test]
async fn a_copy_that_fails_runs_no_migration_and_says_so_once() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));
    std::fs::write(paths.backups_dir().join(&file), b"not ours").unwrap();

    for _ in 0..2 {
        match db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await {
            Err(error @ OpenError::Copy { .. }) => {
                assert!(error.to_string().contains("no migration ran"), "{error}");
                let OpenError::Copy { pending, failure } = error else { unreachable!() };
                assert_eq!(pending, Pending { from, to, migrations: 1 });
                assert_eq!(failure.code, "write_failed");
            }
            other => panic!("{other:?}"),
        }
        let versions = applied(&paths).await;
        assert_eq!(versions.last(), Some(&from));
        assert!(!versions.contains(&ADDED), "{versions:?}");
    }
    assert_eq!(
        std::fs::read(paths.backups_dir().join(&file)).unwrap(),
        b"not ours"
    );
    let pool = raw_pool(&paths).await;
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![upgrade_row(
            None,
            "failed",
            json!({
                "from": from, "to": to, "migrations": 1, "file": null, "reused": false,
                "code": "write_failed", "appVersion": env!("CARGO_PKG_VERSION"),
            }),
        )]
    );
    pool.close().await;
}

/// A migration that fails after a good copy says which copy protects it; the
/// service's next starts (Windows retries every 60 s) use that copy again
/// rather than making another, and the start that succeeds names it too.
#[tokio::test]
async fn a_migration_that_fails_keeps_its_copy_and_the_next_start_uses_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    // `0031` adds a column the database already has: its ALTER fails.
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query("ALTER TABLE devices ADD COLUMN version_seen_at TEXT")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));

    for _ in 0..2 {
        // The second try with the same time would meet the first copy's name
        // and fail as `write_failed` if it copied again.
        let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
        assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    }
    assert_eq!(names(&paths.backups_dir()).len(), 3, "one copy for both tries");

    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query("ALTER TABLE devices DROP COLUMN version_seen_at")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:05:00Z"))
        .await
        .unwrap();
    assert_eq!(names(&paths.backups_dir()).len(), 3);
    let common = |reused: bool, code: Option<&str>| {
        json!({
            "from": from, "to": to, "migrations": 1, "file": file, "reused": reused,
            "code": code, "appVersion": env!("CARGO_PKG_VERSION"),
        })
    };
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![
            upgrade_row(Some(&file), "failed", common(false, Some("migration_failed"))),
            upgrade_row(Some(&file), "ok", common(true, None)),
        ]
    );
    pool.close().await;
}
```

Если в среде исполнителя `SqlitePool` не реализует `Debug` для `{opened:?}`/`{other:?}` — заменить сообщение на текст без `Debug` и записать в «Отклонения».

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test upgrade
```

Ожидается: не собирается (`db::open_upgrading`, `upgrade::PreUpgrade`, `OpenError` не найдены).

- [ ] **Step 3: Реализация**

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
    /// The host copied its database before this build's pending migrations
    /// (plan ОБН-1); `failed` when the copy or the migrations failed. The
    /// host is the actor, the copy its target.
    pub const HOST_UPGRADE: &str = "host.upgrade";
}
```

Правка `apps/standalone/host/src/backup/copy.rs`:

Фрагмент:

```rust
/// An identity and the guard that closes it beside a copy.
type Attached = Option<(Arc<HostIdentity>, Arc<dyn KeyFileGuard>)>;
```

заменить на:

```rust
/// [`make_copy_with_identity`] with the name's `tag` given: the copy before
/// pending migrations (plan ОБН-1) is named for them
/// (`…-pre-upgrade-<from>-<to>.db`). A copy of that name already in `dir` is
/// never replaced.
#[allow(clippy::too_many_arguments)]
pub async fn make_copy_with_identity_tagged(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    tag: &str,
    identity: Option<Arc<HostIdentity>>,
    guard: Arc<dyn KeyFileGuard>,
) -> Result<Manifest, Failure> {
    let identity = identity.map(|identity| (identity, guard));
    make_copy_in(conn, dir, at, trigger, host_id, tag, identity).await
}

/// An identity and the guard that closes it beside a copy.
type Attached = Option<(Arc<HostIdentity>, Arc<dyn KeyFileGuard>)>;
```

Правка `apps/standalone/host/src/upgrade.rs`:

Фрагмент (импорты):

```rust
use sqlx::migrate::Migrator;
use sqlx::SqliteConnection;

use crate::backup::copy::COPY_PREFIX;
```

заменить на:

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;

use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use sqlx::migrate::Migrator;
use sqlx::{SqliteConnection, SqlitePool};
use time::OffsetDateTime;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::backup::copy::{self, Failure, COPY_PREFIX};
use crate::backup::identity::{platform_guard, HostIdentity, KeyFileGuard};
use crate::clock::format_timestamp;
use crate::config::HostPaths;
```

В конец файла:

```rust
/// `details.code` of a `host.upgrade` row whose copy was made and whose
/// migrations then failed (a failed copy's codes are
/// `markiro_proto::backup::failure`).
pub const MIGRATION_FAILED: &str = "migration_failed";

/// Where and as whom [`prepare`] copies the database.
pub struct PreUpgrade {
    /// The data folder: its host identity goes beside the copy (plan I1).
    pub data_dir: PathBuf,
    /// The local folder of copies (`<data dir>/backups`).
    pub backups_dir: PathBuf,
    pub host_id: String,
    /// Closes the host identity beside the copy.
    pub guard: Arc<dyn KeyFileGuard>,
    /// The copy's time and the audit row's.
    pub at: OffsetDateTime,
}

impl PreUpgrade {
    /// The host's own folders and guard, at `at`.
    pub fn for_paths(paths: &HostPaths, host_id: impl Into<String>, at: OffsetDateTime) -> Self {
        Self {
            data_dir: paths.data_dir.clone(),
            backups_dir: paths.backups_dir(),
            host_id: host_id.into(),
            guard: platform_guard(),
            at,
        }
    }
}

/// Why `db::open_upgrading` gave no pool.
#[derive(Debug)]
pub enum OpenError {
    /// SQLite or a migration failed, as `db::open` reports it.
    Database(sqlx::Error),
    /// The copy before the migrations failed: none of them ran.
    Copy { pending: Pending, failure: Failure },
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "{error}"),
            Self::Copy { pending, failure } => write!(
                formatter,
                "the copy of the database before migrations {} to {} failed ({}): no migration \
                 ran and the host does not start; free space or restore access in the folder \
                 of copies, then start the service again",
                pending.from, pending.to, failure.code
            ),
        }
    }
}

impl std::error::Error for OpenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Copy { .. } => None,
        }
    }
}

impl From<sqlx::Error> for OpenError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// The copy that protects the pending migrations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub pending: Pending,
    /// The copy's file name in the local folder.
    pub file: String,
    /// The copy of an earlier start whose migrations failed, used again.
    pub reused: bool,
}

/// The newest audit row, when it is a failed `host.upgrade` of the same
/// migrations: nothing has written to the database since (the host did not
/// start in between).
struct LastFailure {
    file: Option<String>,
    code: String,
}

/// Before the migrations: `None` when nothing is pending, otherwise the copy
/// that protects them — the earlier start's (when its migrations failed and
/// nothing wrote since, so a service restarting every minute does not fill
/// the disk), or a new verified copy. A copy that fails is
/// [`OpenError::Copy`] with one `host.upgrade` `failed` row, which a repeat
/// of the same failure does not write again.
pub async fn prepare(
    pool: &SqlitePool,
    migrator: &Migrator,
    pre: &PreUpgrade,
) -> Result<Option<Prepared>, OpenError> {
    let mut conn = pool.acquire().await?;
    let Some(pending) = pending(&mut conn, migrator).await? else {
        return Ok(None);
    };
    let last = last_failure(&mut conn, &pending).await?;
    if let Some(file) = last.as_ref().and_then(|last| last.file.clone()) {
        if reusable(&pre.backups_dir, &file).await {
            tracing::info!(
                %file,
                from = pending.from,
                to = pending.to,
                "the copy of the earlier start protects the migrations again"
            );
            return Ok(Some(Prepared {
                pending,
                file,
                reused: true,
            }));
        }
    }
    let identity = read_identity(pre).await;
    let made = copy::make_copy_with_identity_tagged(
        &mut conn,
        &pre.backups_dir,
        pre.at,
        BackupTrigger::Scheduled,
        &pre.host_id,
        &pending.tag(),
        identity,
        pre.guard.clone(),
    )
    .await;
    match made {
        Ok(manifest) => {
            tracing::info!(
                file = %manifest.file,
                size = manifest.size_bytes,
                from = pending.from,
                to = pending.to,
                "the database was copied before its migrations"
            );
            Ok(Some(Prepared {
                pending,
                file: manifest.file,
                reused: false,
            }))
        }
        Err(failure) => {
            tracing::error!(
                code = failure.code,
                detail = %failure.detail,
                from = pending.from,
                to = pending.to,
                "the copy before the migrations failed: no migration runs and the host does not start"
            );
            let repeated = last
                .as_ref()
                .is_some_and(|last| last.file.is_none() && last.code == failure.code);
            if !repeated {
                record(&mut conn, pre, &pending, None, false, Some(failure.code), Outcome::Failed)
                    .await;
            }
            Err(OpenError::Copy { pending, failure })
        }
    }
}

/// The migrations ran: the `ok` row.
pub async fn record_done(pool: &SqlitePool, prepared: &Prepared, pre: &PreUpgrade) {
    match pool.acquire().await {
        Ok(mut conn) => {
            record(
                &mut conn,
                pre,
                &prepared.pending,
                Some(&prepared.file),
                prepared.reused,
                None,
                Outcome::Ok,
            )
            .await;
        }
        Err(error) => tracing::error!(%error, "the host.upgrade audit row was not written"),
    }
}

/// The migrations failed after a good copy: one `failed` row naming it. A
/// reused copy's start writes none: the earlier row says the same.
pub async fn record_failed_migration(pool: &SqlitePool, prepared: &Prepared, pre: &PreUpgrade) {
    if prepared.reused {
        return;
    }
    match pool.acquire().await {
        Ok(mut conn) => {
            record(
                &mut conn,
                pre,
                &prepared.pending,
                Some(&prepared.file),
                false,
                Some(MIGRATION_FAILED),
                Outcome::Failed,
            )
            .await;
        }
        Err(error) => tracing::error!(%error, "the host.upgrade audit row was not written"),
    }
}

async fn last_failure(
    conn: &mut SqliteConnection,
    pending: &Pending,
) -> Result<Option<LastFailure>, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'",
    )
    .fetch_one(&mut *conn)
    .await?;
    if tables == 0 {
        return Ok(None);
    }
    let newest: Option<(String, String, String)> =
        sqlx::query_as("SELECT action, result, details FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(&mut *conn)
            .await?;
    let Some((action, result, details)) = newest else {
        return Ok(None);
    };
    if action != actions::HOST_UPGRADE || result != "failed" {
        return Ok(None);
    }
    let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
    if details["from"] != json!(pending.from) || details["to"] != json!(pending.to) {
        return Ok(None);
    }
    Ok(Some(LastFailure {
        file: details["file"].as_str().map(str::to_owned),
        code: details["code"].as_str().unwrap_or_default().to_owned(),
    }))
}

/// Whether `file`, which an earlier start named, is still a verified copy in
/// `dir`: a copy's name, its manifest reads and names it, and the file has
/// the manifest's size.
async fn reusable(dir: &Path, file: &str) -> bool {
    if !copy::is_copy_file_name(file) {
        return false;
    }
    let db = dir.join(file);
    tokio::task::spawn_blocking(move || {
        copy::read_manifest(&db).is_ok_and(|manifest| {
            std::fs::metadata(&db).is_ok_and(|metadata| metadata.len() == manifest.size_bytes)
        })
    })
    .await
    .unwrap_or(false)
}

/// The data folder's identity when it reads and names this host, as the
/// backup worker reads it before each copy; otherwise the copy goes without.
async fn read_identity(pre: &PreUpgrade) -> Option<Arc<HostIdentity>> {
    let paths = HostPaths::new(pre.data_dir.clone());
    match tokio::task::spawn_blocking(move || HostIdentity::read(&paths)).await {
        Ok(Ok(identity)) if identity.host_id() == pre.host_id => Some(Arc::new(identity)),
        Ok(Ok(_)) => {
            tracing::warn!("the host identity names another host: the copy before the migrations goes without it");
            None
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "the host identity did not read: the copy before the migrations goes without it");
            None
        }
        Err(_) => None,
    }
}

/// One `host.upgrade` row: the host as the actor, the copy as the target.
/// Only numbers, the copy's name and a code: never an error's text.
async fn record(
    conn: &mut SqliteConnection,
    pre: &PreUpgrade,
    pending: &Pending,
    file: Option<&str>,
    reused: bool,
    code: Option<&str>,
    outcome: Outcome,
) {
    let details = json!({
        "from": pending.from,
        "to": pending.to,
        "migrations": pending.migrations,
        "file": file,
        "reused": reused,
        "code": code,
        "appVersion": env!("CARGO_PKG_VERSION"),
    });
    let entry = Entry {
        actor: Actor::System,
        action: actions::HOST_UPGRADE,
        target_type: Some("backup"),
        target_id: file,
        outcome,
        details,
    };
    if let Err(error) = audit::record(conn, &format_timestamp(pre.at), entry).await {
        tracing::error!(%error, "the host.upgrade audit row was not written");
    }
}
```

Правка `apps/standalone/host/src/db.rs`:

Фрагмент:

```rust
pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options(path).create_if_missing(true))
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}
```

заменить на:

```rust
/// The master database, migrated, with no copy before the migrations: for a
/// new database and the restore's own staging, where nothing needs
/// protecting. The host's start uses [`open_upgrading`].
pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options(path).create_if_missing(true))
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// The master database for the host's start (plan ОБН-1, spec §10.6): the
/// pool opens without migrations, and when this build brings migrations the
/// database lacks, `upgrade::prepare` copies it first. A copy that fails
/// runs no migration (`upgrade::OpenError::Copy`); one `host.upgrade` row
/// says what happened.
pub async fn open_upgrading(
    path: &Path,
    pre: &crate::upgrade::PreUpgrade,
) -> Result<SqlitePool, crate::upgrade::OpenError> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options(path).create_if_missing(true))
        .await?;
    let prepared = match crate::upgrade::prepare(&pool, &MIGRATOR, pre).await {
        Ok(prepared) => prepared,
        Err(error) => {
            pool.close().await;
            return Err(error);
        }
    };
    if let Err(error) = MIGRATOR.run(&pool).await {
        if let Some(prepared) = &prepared {
            crate::upgrade::record_failed_migration(&pool, prepared, pre).await;
        }
        pool.close().await;
        return Err(crate::upgrade::OpenError::Database(error.into()));
    }
    if let Some(prepared) = &prepared {
        crate::upgrade::record_done(&pool, prepared, pre).await;
    }
    Ok(pool)
}
```

- [ ] **Step 4: Убедиться, что тесты проходят; мутации**

Команда шага 2 — PASS; затем `--test backup_copy --test backup_worker --test restore --test foundation --test no_secrets_in_logs` — PASS.

Мутации: M7 — в `prepare` убрать ветку повторного использования (`if let Some(file) = …`) — FAIL `a_migration_that_fails_keeps_its_copy…` (`write_failed` на второй попытке); M8 — `if !repeated` → `if true` — FAIL `a_copy_that_fails…` (две строки); M9 — в `open_upgrading` при `Err` из `prepare` всё равно запускать `MIGRATOR.run` — FAIL (`ADDED` применена); M10 — `record_failed_migration` без `if prepared.reused { return; }` — FAIL (лишняя строка).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/upgrade.rs apps/standalone/host/src/db.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/backup/copy.rs apps/standalone/host/tests/upgrade.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/support/backup.rs
git commit -F /tmp/claude/msg-obn1-5.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the host copies its database before pending migrations (host.upgrade)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 6: Старт хоста через `db::open_upgrading`; неудачная копия — хост не стартует

**Files:**

- Modify: `apps/standalone/host/src/lib.rs`
- Test: `apps/standalone/host/tests/upgrade.rs`, `apps/standalone/host/tests/backup_start.rs`

**Interfaces:**

- Consumes: `db::open_upgrading`, `upgrade::PreUpgrade::for_paths` (задача 5).
- Produces: `crate::start` копирует перед миграциями и возвращает `Err` (текст `OpenError::Copy`) без миграций, если копия не удалась.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/host/tests/upgrade.rs` — в конец файла:

```rust
/// `crate::start` over a database of the previous build whose copy cannot be
/// written (the folder of copies is closed to the host) does not start and
/// runs no migration (spec §10.6: `install` then answers 4). It fails before
/// binding any socket.
#[cfg(unix)]
#[tokio::test]
async fn a_host_whose_copy_fails_does_not_start_and_runs_no_migration() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, _) = versions();
    let backups = paths.backups_dir();
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o500)).unwrap();
    let started = markiro_host::start(
        &paths,
        markiro_host::StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await;
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o700)).unwrap();
    let error = match started {
        Ok(_) => panic!("the host started over a database it could not copy"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("no migration ran"), "{error}");
    assert!(error.contains("access_denied"), "{error}");
    let versions = applied(&paths).await;
    assert_eq!(versions.last(), Some(&from));
    assert!(!versions.contains(&ADDED), "{versions:?}");
    assert!(names(&backups).is_empty(), "nothing of the copy stays");
}
```

Правка `apps/standalone/host/tests/backup_start.rs` — в конец файла:

```rust
/// A host started over a database of the previous build copies it before
/// its migrations (plan ОБН-1), then the worker makes its own first copy at
/// once, and the rule keeps both; one `host.upgrade` row names the copy.
#[tokio::test]
async fn a_started_host_copies_an_older_database_before_its_migrations_and_keeps_that_copy() {
    let dir = tempfile::tempdir().unwrap();
    support::backup::write_identity(dir.path(), "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f");
    support::backup::database_without(dir.path(), 31).await;
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the copy before the migrations and the worker's first copy");
    tokio::time::timeout(Duration::from_secs(15), host.stop())
        .await
        .expect("the host stops with its worker")
        .unwrap();
    let copies: Vec<String> = support::backup::names(&backups)
        .into_iter()
        .filter(|name| name.ends_with(".db"))
        .collect();
    assert_eq!(copies.len(), 2, "{copies:?}");
    let before: Vec<&String> = copies
        .iter()
        .filter(|name| markiro_host::upgrade::is_pre_upgrade(name))
        .collect();
    assert_eq!(before.len(), 1, "{copies:?}");
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT actor_kind, result, target_id FROM audit_log WHERE action = 'host.upgrade'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [("system".to_owned(), "ok".to_owned(), Some(before[0].clone()))]
    );
    pool.close().await;
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test upgrade a_host_whose_copy_fails
# вне песочницы (сокет на 127.0.0.1):
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start
```

Ожидается: `a_host_whose_copy_fails…` — FAIL (хост стартует: `db::open` мигрирует без копии); `backup_start` — FAIL нового теста (одна копия, нет `host.upgrade`). Прежний тест `a_started_host_copies_its_database_and_stops_its_worker` (свежая база, одна копия) — PASS и после реализации.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент 1:

```rust
    let config = HostConfig::load_or_create(paths, options.port_override)?;
    let pool = db::open(&paths.database_file()).await?;
```

заменить на:

```rust
    let config = HostConfig::load_or_create(paths, options.port_override)?;
    let clock: std::sync::Arc<dyn clock::Clock> = std::sync::Arc::new(clock::SystemClock);
    // The copy before this build's pending migrations (plan ОБН-1): one that
    // fails stops the start before any migration runs.
    let pre_upgrade = upgrade::PreUpgrade::for_paths(paths, config.host_id.clone(), clock.now());
    let pool = db::open_upgrading(&paths.database_file(), &pre_upgrade).await?;
```

Фрагмент 2:

```rust
    let clock: std::sync::Arc<dyn clock::Clock> = std::sync::Arc::new(clock::SystemClock);
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
```

заменить на:

```rust
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Команды шага 2 — PASS; затем вне песочницы `--test hello --test installer_cli --test backup_routes` — PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/lib.rs apps/standalone/host/tests/upgrade.rs apps/standalone/host/tests/backup_start.rs
git commit -F /tmp/claude/msg-obn1-6.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the host starts through the pre-upgrade copy and refuses without it` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 7: Оболочка копирует `standalone-station.db` перед своими миграциями

**Files:**

- Modify: `apps/standalone/src-tauri/src/local_db.rs`
- Test: `apps/standalone/src-tauri/tests/local_db.rs`

**Interfaces:**

- Consumes: `MIGRATOR`, `rename_retrying`, `RENAME_ATTEMPTS`, `RENAME_RETRY_DELAY`, `open_failure_of`.
- Produces: `local_db::{PRE_UPGRADE_PREFIX, pre_upgrade_file(version)}`; `#[doc(hidden)] LocalDb::open_versioned(dir, version)`; `LocalDb::open` = `open_versioned(dir, env!("CARGO_PKG_VERSION"))`; неудачная копия — ошибка `sqlx::Error::Io` (`OpenFailure::Other`) без миграций (Д9).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/local_db.rs`:

Фрагмент (импорт):

```rust
use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalDbState, LocalStatement, OpenFailure, TableClass,
    UnsentGuard, FILE_NAME, MIGRATOR, TABLE_CLASSES,
};
```

заменить на:

```rust
use markiro_standalone_lib::local_db::{
    pre_upgrade_file, table_class, LocalDb, LocalDbError, LocalDbState, LocalStatement,
    OpenFailure, TableClass, UnsentGuard, FILE_NAME, MIGRATOR, PRE_UPGRADE_PREFIX,
    TABLE_CLASSES,
};
```

В конец файла:

```rust
/// The newest migration of the shell, and the newest below it.
fn shell_versions() -> (i64, i64) {
    let newest = MIGRATOR.iter().map(|migration| migration.version).max().unwrap();
    let previous = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| *version < newest)
        .max()
        .unwrap();
    (previous, newest)
}

/// A database of the previous build (every migration below the newest) with
/// one line.
async fn previous_build_database(dir: &std::path::Path) {
    let (_, newest) = shell_versions();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < newest)
        .cloned()
        .collect();
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.join(FILE_NAME))
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
    sqlx::query(INSERT_LINE)
        .bind(LINE_1)
        .bind("Линия 1")
        .bind(0)
        .bind(1)
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
}

/// The copies before an upgrade in `dir`, sorted.
fn pre_upgrade_copies(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with(PRE_UPGRADE_PREFIX))
        .collect();
    names.sort();
    names
}

/// The newest migration a database file has, read without migrating it.
async fn newest_applied(path: &std::path::Path) -> i64 {
    let mut raw = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let newest = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
    newest
}

/// The copy before this build's pending migrations (plan ОБН-1, spec §10.6):
/// `standalone-station.pre-<version>.db` beside the database, sound, of the
/// schema before the migrations and with the data; the older copy goes, so
/// one stays.
#[tokio::test]
async fn a_database_with_pending_migrations_is_copied_before_they_run_and_one_copy_stays() {
    let dir = tempfile::tempdir().unwrap();
    let (previous, newest) = shell_versions();
    previous_build_database(dir.path()).await;
    std::fs::write(dir.path().join(pre_upgrade_file("0.0.1")), b"an older copy").unwrap();

    let db = LocalDb::open_versioned(dir.path(), "9.9.9").await.unwrap();

    assert_eq!(
        pre_upgrade_copies(dir.path()),
        ["standalone-station.pre-9.9.9.db"]
    );
    let copy = dir.path().join(pre_upgrade_file("9.9.9"));
    let mut read = SqliteConnectOptions::new()
        .filename(&copy)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .unwrap();
    let check: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut read)
        .await
        .unwrap();
    assert_eq!(check, ["ok"]);
    let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ref_lines")
        .fetch_one(&mut read)
        .await
        .unwrap();
    assert_eq!(lines, 1);
    read.close().await.unwrap();
    assert_eq!(newest_applied(&copy).await, previous);
    assert_eq!(lines_count(&db).await, 1);
    assert_eq!(newest_applied(&dir.path().join(FILE_NAME)).await, newest);
}

/// A new file and an up-to-date database take no copy.
#[tokio::test]
async fn a_new_or_current_database_takes_no_copy() {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::open_versioned(dir.path(), "9.9.9").await.unwrap();
    drop(db);
    let db = LocalDb::open_versioned(dir.path(), "9.9.10").await.unwrap();
    drop(db);
    assert!(pre_upgrade_copies(dir.path()).is_empty());
}

/// A copy that cannot be made runs no migration: the database stays at the
/// previous build's schema and is no corrupt file, so a forget never sets it
/// aside (`OpenFailure::Other`).
#[tokio::test]
async fn a_copy_that_fails_runs_no_migration_and_keeps_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let (previous, _) = shell_versions();
    previous_build_database(dir.path()).await;
    // A folder where the copy's partial file must go: it cannot be cleared.
    std::fs::create_dir(
        dir.path()
            .join(format!("{}.partial", pre_upgrade_file(env!("CARGO_PKG_VERSION")))),
    )
    .unwrap();

    let local = LocalDbState::open(dir.path()).await;

    assert!(local.get().is_err());
    assert_eq!(local.open_failure(), Some(OpenFailure::Other));
    assert_eq!(newest_applied(&dir.path().join(FILE_NAME)).await, previous);
}

async fn lines_count(db: &LocalDb) -> usize {
    db.query("SELECT id FROM ref_lines", vec![]).await.unwrap().len()
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db
```

Ожидается: не собирается (`pre_upgrade_file`, `PRE_UPGRADE_PREFIX`, `LocalDb::open_versioned` не найдены).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/local_db.rs`:

Фрагмент 1:

```rust
pub const FILE_NAME: &str = "standalone-station.db";
```

заменить на:

```rust
pub const FILE_NAME: &str = "standalone-station.db";
/// The copy of the database before this build's pending migrations (plan
/// ОБН-1, spec §10.6): `standalone-station.pre-<app version>.db` beside it.
/// Only the newest is kept.
pub const PRE_UPGRADE_PREFIX: &str = "standalone-station.pre-";

/// `standalone-station.pre-<version>.db`.
pub fn pre_upgrade_file(version: &str) -> String {
    format!("{PRE_UPGRADE_PREFIX}{version}.db")
}
```

Фрагмент 2:

```rust
    /// Open `standalone-station.db` in `dir`, creating the directory, the
    /// file and the schema as needed.
    pub async fn open(dir: &Path) -> Result<Self, sqlx::Error> {
        std::fs::create_dir_all(dir)?;
```

заменить на:

```rust
    /// Open `standalone-station.db` in `dir`, creating the directory, the
    /// file and the schema as needed. Before this build's pending migrations
    /// the database is copied to `standalone-station.pre-<version>.db` (plan
    /// ОБН-1); a copy that fails runs no migration and fails the open as an
    /// I/O error ([`OpenFailure::Other`]: the file stays where it is).
    pub async fn open(dir: &Path) -> Result<Self, sqlx::Error> {
        Self::open_versioned(dir, env!("CARGO_PKG_VERSION")).await
    }

    /// [`Self::open`] as the app of `version`, for tests.
    #[doc(hidden)]
    pub async fn open_versioned(dir: &Path, version: &str) -> Result<Self, sqlx::Error> {
        std::fs::create_dir_all(dir)?;
```

Фрагмент 3:

```rust
        if let Err(error) = MIGRATOR.run(&writer).await {
            // Closed before the error goes back, not left to close on its
            // own: an open handle keeps the file from moving on Windows.
            writer.close().await;
            return Err(error.into());
        }
```

заменить на:

```rust
        // A failure to read the migrations goes back as it is: a corrupt
        // file stays `Corrupt` for the forget.
        match has_pending_migrations(&writer).await {
            Ok(false) => {}
            Ok(true) => {
                if let Err(error) = copy_before_migrations(&writer, dir, version).await {
                    // The kind only: a path names the Windows user.
                    eprintln!(
                        "standalone: the copy of the local database before its migrations failed: {:?}",
                        error.kind()
                    );
                    writer.close().await;
                    return Err(sqlx::Error::Io(error));
                }
            }
            Err(error) => {
                writer.close().await;
                return Err(error);
            }
        }
        if let Err(error) = MIGRATOR.run(&writer).await {
            // Closed before the error goes back, not left to close on its
            // own: an open handle keeps the file from moving on Windows.
            writer.close().await;
            return Err(error.into());
        }
```

Фрагмент 4 (перед `/// \`rename\` tried up to \`attempts\` times`):

```rust
/// `rename` tried up to `attempts` times, `delay` apart. A source that is not
/// there is final at once: nothing will bring it back.
```

заменить на:

```rust
/// Whether this build brings migrations the database lacks, on top of at
/// least one it has. A new file, a failed migration and one this build does
/// not know answer `false`: nothing to protect, or sqlx refuses it anyway.
async fn has_pending_migrations(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?;
    if tables == 0 {
        return Ok(false);
    }
    let applied: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations")
            .fetch_all(pool)
            .await?;
    let known: Vec<i64> = MIGRATOR
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .collect();
    if applied.is_empty()
        || applied
            .iter()
            .any(|(version, success)| !success || !known.contains(version))
    {
        return Ok(false);
    }
    Ok(known
        .iter()
        .any(|version| !applied.iter().any(|(applied, _)| applied == version)))
}

/// `VACUUM INTO <copy>.partial`, `integrity_check` on it read-only, flushed,
/// renamed to `standalone-station.pre-<version>.db` (over one of that name),
/// then every older such copy goes. A failure leaves the database as it was
/// and no partial file behind.
async fn copy_before_migrations(
    pool: &SqlitePool,
    dir: &Path,
    version: &str,
) -> std::io::Result<()> {
    let name = pre_upgrade_file(version);
    let target = dir.join(&name);
    let partial = dir.join(format!("{name}.partial"));
    match std::fs::remove_file(&partial) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Err(error) = write_pre_upgrade(pool, &partial).await {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    rename_retrying(RENAME_ATTEMPTS, RENAME_RETRY_DELAY, || {
        std::fs::rename(&partial, &target)
    })
    .await?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Some(other) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let older = other != name
            && other.starts_with(PRE_UPGRADE_PREFIX)
            && (other.ends_with(".db") || other.ends_with(".db.partial"));
        if older {
            // The new copy is in place: an older one that does not go is
            // only noted.
            if let Err(error) = std::fs::remove_file(entry.path()) {
                eprintln!(
                    "standalone: an older copy of the local database could not be removed: {:?}",
                    error.kind()
                );
            }
        }
    }
    Ok(())
}

async fn write_pre_upgrade(pool: &SqlitePool, partial: &Path) -> std::io::Result<()> {
    let target = partial.to_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "the copy's path is no UTF-8")
    })?;
    sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(pool)
        .await
        .map_err(std::io::Error::other)?;
    let mut check = SqliteConnectOptions::new()
        .filename(partial)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .map_err(std::io::Error::other)?;
    let rows: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut check)
        .await;
    let _ = check.close().await;
    if rows.map_err(std::io::Error::other)? != ["ok"] {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the copy did not check out",
        ));
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open(partial)?
        .sync_all()
}

/// `rename` tried up to `attempts` times, `delay` apart. A source that is not
/// there is final at once: nothing will bring it back.
```

- [ ] **Step 4: Убедиться, что тесты проходят; мутации**

Команда шага 2 — PASS (весь `local_db`: тесты миграций `0008`…`0013` теперь оставляют копию в своей временной папке — ничего не проверяют о ней; тесты отложения и `only_a_corrupt_file_is_recorded_as_corrupt` — PASS: испорченная таблица миграций по-прежнему `Corrupt`). Затем `--lib` и `--test ipc` — PASS.

Мутации: M11 — `Err(error) => { writer.close().await; return Err(error); }` в проверке ожидающих заменить на `Err(_) => {}` — FAIL `only_a_corrupt_file_is_recorded_as_corrupt`; M12 — при ошибке копии не возвращать, а продолжать — FAIL `a_copy_that_fails_runs_no_migration…`; M13 — убрать удаление старых копий — FAIL `…one_copy_stays`.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs
git commit -F /tmp/claude/msg-obn1-7.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the shell copies its local database before its migrations` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 8: «Устройства» — колонка «Версия»

**Files:**

- Create: `apps/standalone/src/office/devices/device-version.ts`
- Modify: `apps/standalone/src/office/devices/DevicesPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/devices-page.test.tsx`

**Interfaces:**

- Consumes: `DeviceRecord` с `protocol?`, `versionSeenAt?` (задача 1).
- Produces: `deviceVersionText(device, t): string`; колонка `version` таблицы «Устройства»; ключи `office.devices.table.version`, `office.devices.version.reported`, `office.devices.version.paired`.

- [ ] **Step 1: Написать падающий тест**

Правка `apps/standalone/test/devices-page.test.tsx` — после теста «lists the devices, naming lines from the host's list»:

<!-- prettier-ignore -->
```ts
  it("shows the version each device reported with its protocol, and the pairing's for one that reported none", async () => {
    const session = adminSession();
    session.api.listDevices.mockResolvedValue([
      { ...HOST_PC, appVersion: "0.3.0", protocol: 3, versionSeenAt: "2026-10-13T09:00:00Z" },
      PACKING,
      { ...OFFICE_PC, protocol: 3, versionSeenAt: null },
      RETIRED,
    ]);
    await openDevices(session);
    expect(screen.getByRole("columnheader", { name: "Версия" })).toBeTruthy();
    expect(within(rowOf("Рабочее место хоста")).getByText("0.3.0, протокол 3")).toBeTruthy();
    // An app before plan ОБН-1, or a host before it: the version named at pairing.
    expect(within(rowOf("Станция упаковки")).getByText("0.1.0 (при подключении)")).toBeTruthy();
    expect(within(rowOf("Офис бухгалтерии")).getByText("0.1.0 (при подключении)")).toBeTruthy();
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx
```

Ожидается: FAIL нового теста (нет колонки «Версия»).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/devices/device-version.ts`:

```ts
import type { TFunction } from "i18next";

import type { DeviceRecord } from "../../host/protocol.js";

/**
 * The version column of «Устройства» (plan ОБН-1): what the device reported
 * on its requests, with its protocol; or, for a device that has reported
 * nothing since it paired (an app before ОБН-1, or a host before it that
 * sends neither field), the version it named when it paired.
 */
export function deviceVersionText(device: DeviceRecord, t: TFunction): string {
  if (
    device.versionSeenAt === undefined ||
    device.versionSeenAt === null ||
    device.protocol === undefined
  ) {
    return t("office.devices.version.paired", { version: device.appVersion });
  }
  return t("office.devices.version.reported", {
    version: device.appVersion,
    protocol: device.protocol,
  });
}
```

Правка `apps/standalone/src/office/devices/DevicesPage.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { DeviceDialog } from "./DeviceDialog.js";
import { lineLabel } from "./line-label.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { DeviceDialog } from "./DeviceDialog.js";
import { deviceVersionText } from "./device-version.js";
import { lineLabel } from "./line-label.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
    {
      key: "line",
      title: t("office.devices.table.line"),
      render: (device) => lineLabel(lines.data ?? [], device.lineId, t),
    },
```

заменить на:

<!-- prettier-ignore -->
```ts
    {
      key: "line",
      title: t("office.devices.table.line"),
      render: (device) => lineLabel(lines.data ?? [], device.lineId, t),
    },
    {
      // What the device reports on every request since plan ОБН-1.
      key: "version",
      title: t("office.devices.table.version"),
      render: (device) => deviceVersionText(device, t),
    },
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент:

<!-- prettier-ignore -->
```json
        "line": "Линия",
        "pairedAt": "Подключено",
        "lastSeenAt": "Последний раз",
        "status": "Доступ",
        "actions": "Действия"
      },
      "kinds": {
        "station": "Станция",
```

заменить на:

<!-- prettier-ignore -->
```json
        "line": "Линия",
        "version": "Версия",
        "pairedAt": "Подключено",
        "lastSeenAt": "Последний раз",
        "status": "Доступ",
        "actions": "Действия"
      },
      "version": {
        "reported": "{{version}}, протокол {{protocol}}",
        "paired": "{{version}} (при подключении)"
      },
      "kinds": {
        "station": "Станция",
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/protocol.test.ts test/api.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/devices-page.test.tsx
```

Ожидается: PASS; в verbose-прогоне нет `stderr |`. Тест «lists the devices…» по-прежнему находит единственное «—» в строке «Старый ТСД» (колонка версии его не пишет).

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/devices/device-version.ts apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/devices-page.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/src/office/devices/device-version.ts apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/devices-page.test.tsx
git commit -F /tmp/claude/msg-obn1-8.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — the devices page shows each device's version and protocol` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 9: Установщик без понижения, памятка «Обновление» и «Откат», `AGENTS.md`, раздел 20 спецификации

**Files:**

- Modify: `apps/standalone/src-tauri/tauri.installer.conf.json`, `tools/standalone-release/test/installer.test.mjs`, `docs/runbooks/standalone-install.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`

**Interfaces:**

- Consumes: всё задач 1–8 (как исполнено; «Отклонения» каждой задачи).
- Produces: `bundle.windows.allowDowngrades: false` и его закрепление в контракте выпуска; документы говорят то, что делает код; §20 спецификации.

- [ ] **Step 1: Падающий контракт**

Правка `tools/standalone-release/test/installer.test.mjs` — после теста «only the installer build bundles the host…»:

```js
test("an older installer never goes over a newer one: a rollback is an uninstall and the older installer (plan ОБН-1)", () => {
  // Tauri's default is `true` (config.schema.json of @tauri-apps/cli 2.11.4).
  assert.equal(overlay.bundle.windows.allowDowngrades, false);
  // The base config never turns it back on for another build.
  assert.equal(base.bundle.windows?.allowDowngrades, undefined);
});
```

```bash
node --test tools/standalone-release/test/installer.test.mjs
```

Ожидается: FAIL нового теста (`undefined !== false`).

- [ ] **Step 2: Установщик**

Заменить `apps/standalone/src-tauri/tauri.installer.conf.json` целиком:

```json
{
  "bundle": {
    "externalBin": ["binaries/markiro-host"],
    "windows": {
      "allowDowngrades": false,
      "nsis": {
        "installMode": "perMachine",
        "languages": ["Russian"],
        "installerHooks": "windows/installer-hooks.nsh"
      }
    }
  }
}
```

```bash
pnpm --config.verifyDepsBeforeRun=false test:standalone-release:contract
```

Ожидается: PASS (первый тест сравнивает только `overlay.bundle.windows.nsis`).

- [ ] **Step 3: Памятка `docs/runbooks/standalone-install.md`**

Фрагмент:

```markdown
4. Не ставьте более старую версию поверх новой: миграции базы идут только вперёд, и старая служба не
   сможет открыть базу, в которой применены более новые миграции (поведение библиотеки миграций,
   не проверялось).
5. Учётная запись службы обновлением не меняется (`sc qc MarkiroHost` показывает прежнюю); вторая
   папка копий по сети продолжает работать под той учётной записью, которую выставил ИТ клиента.
6. Версия хоста и версия приложения должны совпадать по протоколу: приложение старее службы или служба
   старее приложения покажет экран «Версии не совпадают».
```

заменить на:

```markdown
4. **Копия базы перед обновлением.** Если новая версия меняет базу, служба при первом запуске сначала
   делает проверенную копию — `%ProgramData%\Markiro\Host\backups\markiro-host-<время UTC>-pre-upgrade-<от>-<до>.db`
   с манифестом и ключом хоста рядом, как у обычной копии (`<от>` и `<до>` — номера изменений базы), —
   и только потом меняет базу. Такая копия хранится не меньше 14 дней, даже когда обычные копии того дня
   уже вытеснены; на странице «Резервные копии» она видна как копия по расписанию. В журнале аудита —
   строка `host.upgrade`.
5. **Если копия не удалась** (кончилось место на диске с `%ProgramData%`, нет прав на папку `backups`),
   база не меняется и служба не запускается: установщик покажет предупреждение кода 4, а в
   `logs\host.<дата>.log` будет «the copy of the database before migrations … failed (<код>): no migration
   ran». Освободите место или верните права и запустите службу: `sc start MarkiroHost` (Windows и сама
   повторяет запуск каждые 60 секунд). Если копия получилась, а изменение базы не прошло, служба тоже не
   запускается, а копия остаётся — по ней делается откат (раздел «Откат»).
6. **Станции и ПК офиса** делают то же со своей локальной базой: перед изменениями рядом с
   `standalone-station.db` в `%LOCALAPPDATA%\app.markiro.standalone` появляется
   `standalone-station.pre-<версия>.db` (хранится одна, последняя). Если её сделать не удалось, база не
   меняется, и приложение открывается без локальной базы: освободите место и перезапустите приложение.
7. Не ставьте более старую версию поверх новой: установщик откажет (`allowDowngrades: false`; как именно
   выглядит отказ установщика Tauri, на Windows не проверялось), а старая служба всё равно не открыла бы
   базу, в которой применены более новые миграции. Вернуться к прежней версии можно только по разделу
   «Откат».
8. Учётная запись службы обновлением не меняется (`sc qc MarkiroHost` показывает прежнюю); вторая
   папка копий по сети продолжает работать под той учётной записью, которую выставил ИТ клиента.
9. Версия хоста и версия приложения должны совпадать по протоколу: приложение старее службы или служба
   старее приложения покажет экран «Версии не совпадают». Какую версию сообщило каждое устройство,
   видно в офисе на странице «Устройства» (колонка «Версия»; «при подключении» — устройство ещё не
   сообщало версию после подключения).
10. Обновляйте сначала ПК хоста и, если можно, отработайте одну смену, прежде чем обновлять станции:
    пока станции не обновлены, откат хоста ещё возможен.

## Откат хоста к прежней версии

Только пока станции и ПК офиса на других ПК ещё не обновлены. Откат — это обычное восстановление из
копии (`standalone-backup-restore.md`, раздел 5) со всеми его следствиями: эпоха восстановления,
удержание данных станций до «Возобновить приём данных станций», повторная отправка станциями записей за
30 дней — поэтому записи, сделанные между обновлением и откатом на станциях других ПК, дойдут до хоста.

1. Остановите службу: `sc stop MarkiroHost` и дождитесь `STATE: STOPPED` в ответе `sc query MarkiroHost`.
2. Удалите программу («Приложения» → «Markiro Standalone» → «Удалить»): данные хоста и приложения
   остаются. Поставьте прежнюю версию её установщиком с той же ролью. Служба прежней версии не
   запустится — база новее неё; установщик покажет предупреждение кода 4. Это ожидаемо.
3. Снова `sc stop MarkiroHost` и дождитесь `STATE: STOPPED` (Windows повторяет запуск каждые 60 секунд).
4. Восстановите копию перед обновлением программой **прежней** версии:
   `markiro-host restore "%ProgramData%\Markiro\Host\backups\markiro-host-<время>-pre-upgrade-<от>-<до>.db" --data-dir "%ProgramData%\Markiro\Host"`.
   Нужна копия с той меткой `pre-upgrade`, что появилась при неудачном обновлении (самая новая).
5. `sc start MarkiroHost`, проверки памятки восстановления (`standalone-backup-restore.md`, раздел 7) и
   «Возобновить приём данных станций».
6. **Станция на ПК хоста** откатывается вместе с ним. Если новая версия меняла и локальную базу
   приложения, прежнее приложение её не откроет и покажет, что локальная база недоступна. Тогда:
   закройте приложение; в `%LOCALAPPDATA%\app.markiro.standalone` перенесите `standalone-station.db`
   (и `standalone-station.db-wal`, `standalone-station.db-shm`, если есть) в отдельную папку — не
   удаляйте: там записи этой станции после обновления, их читает поддержка; переименуйте
   `standalone-station.pre-<версия>.db` в `standalone-station.db`; запустите приложение. Записи, сделанные
   этой станцией после обновления, на хост не попадут.
7. Станции на других ПК, которые не обновлялись, ничего не делают: после «Возобновить приём данных
   станций» они дошлют свои записи сами.

Откат станции или ПК офиса на другом ПК не предусмотрен: их локальная база после обновления новее
прежней версии. Неудачное обновление такой станции чинится следующим выпуском или повторной установкой
той же версии; в крайнем случае подключение станции забывают и подключают её заново (неотправленные
записи остаются в локальной базе). Ни один шаг этого раздела не проверялся на Windows.
```

- [ ] **Step 4: `apps/standalone/AGENTS.md`**

Фрагмент 1 (раздел «Audit»):

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
(the station). The copy before an upgrade (plan ОБН-1) writes `host.upgrade`
(the host; see «Backups and restore»).
```

Фрагмент 2 (раздел «Local database», в конец раздела, перед строкой `## Writes`) — добавить абзац:

```markdown
Before this build's pending migrations (plan ОБН-1) `LocalDb::open` copies the
database: `VACUUM INTO standalone-station.pre-<app version>.db.partial`,
`integrity_check` on it read-only, flushed, renamed over a copy of that name,
and every older `standalone-station.pre-*.db` goes, so one stays. A new file,
a failed or an unknown migration take no copy (sqlx decides as before). A copy
that fails runs no migration: the open fails as `OpenFailure::Other` (the file
stays, the app starts without its local database), and a failure to read the
migrations goes back as it is, so a corrupt file stays `Corrupt`. Nothing else
reads or removes the copy; a forget leaves it, with the PIN and badge hashes it
held at the upgrade (carried to the owner).
```

Фрагмент 3 (раздел «Network and TLS», после первого абзаца, перед `` `host_request`, the webview's generic way ``) — добавить абзац:

```markdown
Every request of `host_client` (both clients, through `pinned_builder`'s
default headers) carries `x-markiro-app-version`
(`markiro_proto::APP_VERSION_HEADER`, the shell's `CARGO_PKG_VERSION`; plan
ОБН-1). `auth::authenticate` (`AuthDevice`, never `AskingDevice`) writes
`devices.app_version`, `protocol` and `version_seen_at` when the reported
version or protocol differs from the stored one or nothing was reported since
pairing: no revision, no audit row, like `last_seen_at`. A header that is not
plain text of 1–50 characters is ignored; the protocol is the guard's
`ClientProtocol` or, outside the guard, the header's whole number 1–1000.
`GET /v1/office/devices` answers `protocol` and `versionSeenAt` (optional in
Zod: a host of the same protocol before ОБН-1 sends neither), and «Устройства»
shows «0.3.0, протокол 3» or «0.1.0 (при подключении)».
```

Фрагмент 4 (раздел «Installer and service», в конец абзаца, который кончается «…the `.nsh` hooks.»):

```markdown
the Tauri overlay for a certificate in the build machine's store, and no
signing material ever reaches CI. Prettier does not cover `smoke.ps1` or the
`.nsh` hooks.
```

заменить на:

```markdown
the Tauri overlay for a certificate in the build machine's store, and no
signing material ever reaches CI. Prettier does not cover `smoke.ps1` or the
`.nsh` hooks. The overlay sets `bundle.windows.allowDowngrades: false` (plan
ОБН-1; Tauri's default is `true`), and the release contract pins it: an older
installer over a newer one refuses, so a rollback is an uninstall, the older
installer and `markiro-host restore` of the copy before the upgrade
(`docs/runbooks/standalone-install.md`, «Откат»). How the NSIS template
refuses, with and without `/S`, has not been seen on Windows. A copy before
the migrations that fails is one more cause of `install`'s exit code 4.
```

Фрагмент 5 (раздел «Backups and restore», перед абзацем «Migration `0011` may be applied after `0012`…») — добавить абзац:

```markdown
Plan ОБН-1 adds the copy before an upgrade. `crate::start` opens the master
database through `db::open_upgrading`: the pool opens without migrations,
`upgrade::pending` compares `_sqlx_migrations` with the build's migrations,
and when the build brings any the database lacks (on top of at least one it
has; a new file, a failed or an unknown migration are left to sqlx as before)
`upgrade::prepare` makes a verified copy through `backup::copy` (`VACUUM INTO`,
`integrity_check`, the manifest, the host identity) into the local folder,
named `markiro-host-<UTC time>-pre-upgrade-<from>-<to>.db` (`from` the newest
migration the database has, `to` the build's newest), and only then do the
migrations run. One `host.upgrade` row: the host as the actor, target `backup`
and the copy's name, details `from`, `to`, `migrations`, `file`, `reused`,
`code`, `appVersion`. A copy that fails runs no migration and the host does not
start (`upgrade::OpenError::Copy`; the service exits, `install` answers 4,
Windows retries every 60 s); its `failed` row is written once while the same
failure repeats. A migration that fails after a good copy writes `failed` with
`code: "migration_failed"` and the copy's name, and the next start — the
newest audit row being that one shows nothing wrote since — uses that copy
again (`reused: true`), so a crash loop does not fill the disk. The manifest
says `trigger: "scheduled"` on purpose: an older build's `read_manifest` and
an older office's `backupTriggerSchema` refuse an unknown trigger, and the
rollback needs the older `restore` to read this copy; the name is the mark
(`upgrade::is_pre_upgrade`). `retention::keep` keeps such a copy while it is no
more than 14 days older than the folder's newest copy, whatever the other
rules say; it is not replicated to the second folder. `db::open` (no copy)
stays for a new database and the restore's own staging.
```

- [ ] **Step 5: Раздел 20 спецификации**

В `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` добавить в конец файла (если §18–§19 ещё нет — всё равно §20; номера распределены брифом):

```markdown
## 20. Уточнения плана ОБН-1

План: `docs/superpowers/plans/2026-10-13-standalone-obn1-safe-migration-versions.md`.

- **Копия перед миграциями хоста** — `db::open_upgrading` и `upgrade::prepare`; `db::open` без копии
  остаётся для новой базы и собственных проверок восстановления. `<от>` и `<до>` метки и строки
  `host.upgrade` — номера миграций (прежнюю версию приложения хост не хранит); версия новой сборки —
  `details.appVersion`.
- **Триггер копии в манифесте — `scheduled`**: новый вариант сделал бы манифест нечитаемым для
  `restore` прежней версии (откат) и уронил бы страницу копий офиса N−1; отличие несёт имя.
- **Хранение** — 14 дней от самой новой копии папки (у правила нет часов); копия только в локальной
  папке.
- **Цикл перезапусков службы**: неудачная миграция пишет `failed` с `migration_failed` и именем копии;
  следующие старты используют эту копию снова (`reused`), пока самая новая строка журнала — эта.
- **Учёт версий** — при каждом пишущем входе устройства (`authenticate` с `touch`), когда версия или
  протокол изменились или ещё не сообщались; без ревизии и аудита. Офисная запись устройства —
  `DeviceRecord` (имени `OfficeDevice` в коде нет), поля `protocol` и `versionSeenAt` в Zod
  необязательны.
- **Оболочка**: неудачная копия — миграций нет, `OpenFailure::Other`.
- **Откат ПК хоста** откатывает и его станцию: памятка кладёт `standalone-station.pre-<версия>.db` на
  место базы (§10.6 «откат станции не предусмотрен» относится к станциям на других ПК).
- **`allowDowngrades: false`** — в оверлее установщика, закреплено контрактом выпуска.

Отклонения при исполнении: <перенести сюда раздел «Отклонения при исполнении» плана>.
```

Исполнитель заменяет последнюю строку итогом своих «Отклонений» (кратко, по задачам).

- [ ] **Step 6: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src-tauri/tauri.installer.conf.json tools/standalone-release/test/installer.test.mjs docs/runbooks/standalone-install.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src-tauri/tauri.installer.conf.json tools/standalone-release/test/installer.test.mjs docs/runbooks/standalone-install.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
pnpm --config.verifyDepsBeforeRun=false test:standalone-release:contract
git diff --check
git add apps/standalone/src-tauri/tauri.installer.conf.json tools/standalone-release/test/installer.test.mjs docs/runbooks/standalone-install.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F /tmp/claude/msg-obn1-9.txt
```

Сообщение: `feat(standalone): plan ОБН-1 — no downgrade installer, the rollback runbook, docs and spec §20` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Итоговая проверка плана

1. Вебвью: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS. Падение старого теста под нагрузкой записывается и разбирается, а не лечится повтором.
2. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; в песочнице `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`, `-p markiro-host --lib --test upgrade --test devices --test device_line --test backup_retention --test backup_copy --test backup_worker --test codes --test restore --test no_secrets_in_logs`, `-p markiro-standalone --lib --test local_db --test ipc` — PASS. Вне песочницы: `-p markiro-host --test backup_start --test hello`, `-p markiro-standalone --test device --test claim --test connection`, затем гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` (частями, если весь не помещается) — PASS.
3. Контракты выпуска: `pnpm --config.verifyDepsBeforeRun=false test:standalone-release:contract` — PASS.
4. Мутации M1–M13 — каждая FAIL названного теста; файлы восстановлены (`cmp`, тот же `shasum`); `git status --short` после всех — пуст.
5. `git diff --stat <основа> -- apps/standalone/host/migrations` — только `0031_device_versions.sql`; `-- apps/standalone/src-tauri/migrations` — пусто; `-- packages/db` — пусто; `Cargo.lock`, `pnpm-lock.yaml`, `package.json` не менялись.
6. `grep -rn "OfficeDevice" apps/standalone` — пусто; `grep -rn "host.upgrade" apps/standalone/host/src` — только `audit.rs` (константа) и документация `upgrade.rs`; `grep -rn "pre-upgrade" apps/standalone/host/src` — `upgrade.rs` и `retention.rs` (через `crate::upgrade`).
7. `node_modules/.bin/prettier --ignore-path .prettierignore --check` на все изменённые TS, TSX, JSON, MJS и MD — PASS; `git diff --check` — пусто.
8. `git log --format=%B` каждого коммита — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы» (и записанные в «Отклонения»).
9. `graphify update .`, если есть `graphify-out/graph.json`.

## Перенесено

- **Пометка копии перед обновлением на странице «Резервные копии»** (сейчас «по расписанию», Д4) — по имени файла (`is_pre_upgrade` на стороне вебвью); не входит в ОБН-1.
- **История `host.upgrade`** на странице «Информация» → «Обновление» и в сведениях для поддержки (последние три с именем копии, §9.4) — план ОБН-2; таблица «Устройства и версии», состояния «Актуальная / Отстаёт / Несовместима» и `GET /v1/office/update-status` для обеих ролей — план ОБН-3 (этот план даёт им `protocol`, `versionSeenAt` и запись версий).
- **`standalone-station.pre-*.db` при «Забыть»**: копия держит хеши PIN и бейджей на момент обновления; удалять ли её при забывании — решение владельца (Д9).
- **Проверка свободного места перед копией** — как в плане РК, не делается (нужна зависимость); нехватка — `disk_full` и отказ старта.
- **Окно предупреждения установщика (код 4)** не различает «копия не удалась» и «незаконченное восстановление» — текст хуков не менялся; различение — в журнале службы и памятке.
- **`smoke.ps1`** не проверяет установку старой версии поверх новой (в задании CI собирается одна версия).

## Не проверено

- Windows вообще: служба `LocalService`, пишущая копию перед миграциями в `%ProgramData%\Markiro\Host\backups` (права наследуются от каталога данных, как у обычных копий), время копии большой базы клиента против 30 секунд ожидания `install` (код 4), повторы запуска Windows каждые 60 секунд при неудачной копии и при неудачной миграции.
- Шаблон NSIS Tauri с `allowDowngrades: false`: окно отказа, тихий `/S`, путь «удалить перед установкой» с нашими хуками; что ручной запуск старого установщика действительно отказывает.
- Откат хоста по разделу «Откат» на двух ПК со станцией: `markiro-host restore` прежней версии, читающий текущую базу более новой схемы только для чтения; станция ПК хоста с подложенной копией `standalone-station.pre-<версия>.db`; станции других ПК, досылающие записи.
- Оболочка на Windows: `VACUUM INTO` в `%LOCALAPPDATA%` с антивирусом, переименование поверх существующей копии (`MoveFileExW`), нехватка места на ПК станции; приложение без локальной базы после неудачной копии на настоящей станции в киоск-режиме.
- Заголовок версии через настоящую сеть цеха и `StreamClient` (поток проверен только через общий построитель `pinned_builder` и модульный тест заголовков; сквозной тест — `PinnedClient` на `127.0.0.1`).
- Вебвью: колонка «Версия» проверена только в jsdom; WebView2 и узкий экран 1024 × 768 не открывались.

## Отклонения при исполнении

</content>
</invoke>
