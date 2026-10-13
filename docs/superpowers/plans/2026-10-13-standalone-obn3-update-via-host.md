# План ОБН-3: раздача обновления через хост — хранилище пакета `updates\`, загрузка из офиса, продвижение, маршруты устройств с `Range`, `update_fetch` и `update_stage` в оболочке, правило «доступно обновление», таблица «Устройства и версии», окно совместимости N−1 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор загружает подписанный пакет обновления (манифест и установщик) на хост — с ПК офиса или с ПК хоста; хост сам проверяет подпись и SHA-256, держит пакет ожидающим (`staged\`), а после своего обновления делает его текущим (`current\`, прежний — `previous\`) и раздаёт только его. Каждое сопряжённое устройство видит в `hello`, что хост новее, читает сведения о пакете маршрутом устройства, по нажатию администратора скачивает установщик **с хоста** по закреплённому TLS (с продолжением после обрыва), проверяет подпись манифеста встроенным ключом выпуска и хеш, сверяет версию пакета с версией хоста и ставит его командами плана ОБН-2 (`update_verify`, `update_install`). Офис показывает полосу «Доступно обновление», раздел «Обновление» — блок «С хоста», загрузку пакета на хост и таблицу «Устройства и версии»; станция — строку на хабе вне экрана работы; экран «Версии не совпадают» и станция вне окна совместимости — кнопку «Обновить с хоста». Пакет не входит в резервные копии и не трогается восстановлением. Контракт выпуска держит окно совместимости N−1 по `tools/standalone-release/releases.json`.

**Architecture:**

- Задача 1 — провод: подмодуль `markiro_proto::update::distribution` модуля ОБН-2 (`PackageState`, `DeviceUpdateOffer`, `UpdatePackageManifestRequest`/`Upload`/`Staged`, `OfficeUpdateStatus`, ограничения, причины); версии, имя установщика и хеш ровно по размеру — `markiro_proto::update::{AppVersion, installer_name, hash_exact, PRODUCT}` ОБН-2; коды ошибок `package_verifying` и `update_busy`; подпись тестовых манифестов под фичей `test-keys`; фикстуры (и общая `app-versions.json`); зеркало Zod `src/host/distribution.ts` с `parseAppVersion`/`compareAppVersions`.
- Задача 2 — хост: `HostPaths::updates_dir` (создаётся в `ensure`), модуль `host/src/updates/` — `UpdateStore`: проверка папки пакета целиком, уборка при старте, продвижение `staged` → `current` → `previous`, отметки файлов (размер, время изменения и создания, inode), загрузка в `incoming-<id>.partial\`, место на диске.
- Задача 3 — хост: офисные маршруты `POST /v1/office/update-package/manifest` (свой предел тела) и `PUT /v1/office/update-package/{uploadId}/installer` (тело потоком, `Content-Length` = `sizeBytes`, SHA-256 на лету, лишний байт обрывает), аудит `update.package.stage`.
- Задача 4 — хост: старт службы — уборка, продвижение, полная проверка, строки `update.package.promote`; ежечасный повтор продвижения; `HOST_VERSION`.
- Задача 5 — хост: маршруты чтения — `GET /v1/device/update` вне `protocol_guard`, но с `AuthDevice`; `GET /v1/office/update-status` (каждая офисная роль): версии устройств, состояние, «Скачан», «Запущена установка», история.
- Задача 6 — хост: `GET /v1/device/update/installer` — своя обработка `Range`/`If-Range`/`ETag`, `200`/`206`/`416`/`409`/`503`, поток кусками по 64 КиБ без загрузки в память, 60 с без продвижения — обрыв, ограничители (одно скачивание на устройство, три на хост, 30 запросов в минуту), `update.download` только с байта 0.
- Задача 7 — хост: гигиена — пакет не попадает в копию и не трогается `restore`; журнал службы без ключа устройства и токена; таблица классификации маршрутов ЛЦ-2 («никогда»).
- Задача 8 — оболочка: `TransferClient::download`, `update_fetch` (закреплённый клиент, продолжение с `Range`/`If-Range`, предел размера, проверка хеша целиком через `hash_exact`, гигиена папки `updates` в локальных данных), `update_check_manifest`, исключение `/v1/device/update/installer` из `host_request`, событие прогресса.
- Задача 9 — оболочка: `TransferClient::upload`, `update_stage` (установщик с диска потоком с сессией офиса; путь — `UpdateState::found_path` ОБН-2), исключение `/v1/office/update-package/…` из `host_request`; в коде ОБН-2: `found_path` принимает манифест скачанного, `Offered::from_host` и `Refusal::HostDiffers` (версия хоста равна версии пакета, §10.11.4), `take_outcome` убирает скачанное.
- Задача 10 — оболочка и вебвью: статус связи несёт версию и протокол хоста из `hello`; ошибки связи `app_too_old`/`host_too_old` вместо `stream_refused`; Zod, тексты.
- Задача 11 — вебвью: чистое правило «доступно обновление» (четыре условия), `UpdatesApi` над командами раздачи, `HostApi.getDeviceUpdate`/`getUpdateStatus`, хук `useHostUpdateOffer` в `App`, диалог `UpdateFromHostDialog` (скачать → `UpdateShell.verify` ОБН-2 → запуск, который даёт вызывающий).
- Задача 12 — вебвью: раздел «Обновление» ОБН-2 получает блок «С хоста» (запуск — `runUpdate` ОБН-2 с источником `host`), «Загрузить пакет на хост», «Устройства и версии» со сводкой, состоянием пакета и историей; вкладчик сведений для поддержки.
- Задача 13 — вебвью: полоса офиса (точки Т3/Т6), строка станции на хабе, экран «Версии не совпадают» с «Обновить с хоста» и тот же экран для ПК офиса, сопряжённого с удалённым хостом.
- Задача 14 — контракт выпуска (окно N−1, `releases.json`, равенство версий в манифестах сборки), `AGENTS.md`, памятка установки, §23 спецификации.

**Tech Stack:** Rust (axum 0.8.9, sqlx 0.8.6, aws-lc-rs 1.18.1, reqwest 0.13.4 с `stream`, tokio 1.53.1), TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, React 19.2, Vitest 4 с jsdom, `node:test` для `tools/standalone-release`.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — §10.11 целиком (10.11.1–10.11.8), §10.4 (запуск установщика), §10.7, §10.8, §11 (раздача через хост), §12.1/§12.2 (раздача), §13 строка 6; этот план дописывает §23.
- Бриф `/tmp/claude/fb/license-plans-brief.md` — распределение, контракт имён, «ОБН-3 produces».
- План ОБН-1 `docs/superpowers/plans/2026-10-13-standalone-obn1-safe-migration-versions.md` — `APP_VERSION_HEADER`, запись версии в `authenticate` (Д8 ОБН-1: вне стража протокол читается из заголовка), `DeviceRecord.protocol`/`versionSeenAt`, `HOST_UPGRADE`, `default_headers` в `pinned_builder`.
- `apps/standalone/AGENTS.md` — «Three identities», «Audit», «Protocol», «Network and TLS», «Connection to the host», «Installer and service», «Backups and restore», «Logs», «Verification».
- Каркас «Информация» — ветка `claude/fb-about` (`32d6aa5fa`): `apps/standalone/src/office/info/{sections.tsx,support-blocks.ts,about-api.ts,about-data.ts,ProgramSection.tsx}`.

## Допущения

- **Д1 — основа.** План исполняется после ЛЦ-1, ОБН-1, ОБН-2 и слияния `claude/fb-about`; ЛЦ-2 и ЛЦ-3 — желательно (Д10, Д17). Кода этих планов при написании в дереве не было: имена ЛЦ-1 взяты из контракта брифа, имена ОБН-1, ОБН-2 и ЛЦ-3 — из их планов (`docs/superpowers/plans/2026-10-13-standalone-{obn1,obn2,lc3}-*.md`), фрагменты их кода — из этих планов; расхождение с тем, как их исполнили, правится по смыслу и пишется в «Отклонения».
- **Д2 — Rust-форма манифеста ЛЦ-1.** `markiro_proto::trust::verify_update_manifest(compact, &Keyset) -> Result<(UpdateManifestV1, String), TrustError>`, `TrustError { Malformed, UnknownKey, BadSignature }`, `update_keyset()`; поля `UpdateManifestV1` — snake_case полей §10.2: `product`, `version`, `channel`, `released_at`, `source_sha`, `installer: { name, sha256, size_bytes }`, `protocol`, `min_protocol`, `min_upgrade_from`, `notes`. Тестовые закрытые ключи — `packages/domain/fixtures/standalone-license/test-private-keys.json` в форме `{ "license": { "kid", "jwk" }, "update": { "kid": "test-upd-1", "jwk": { "kty", "crv", "x", "y", "d" } } }`. Другие имена полей или форма файла — правка по смыслу в задачах 1–2 с записью в «Отклонения».
- **Д3 — провод раздачи — подмодуль `markiro_proto::update::distribution`, без второго порядка версий и второго хеша.** ОБН-2 заводит `markiro_proto::update` (`proto/src/update.rs`: `AppVersion` с `FromStr`, `installer_name`, `hash_exact`, `PRODUCT`, `UpdateStarted`); этот план кладёт свои формы в подмодуль `proto/src/update/distribution.rs` (`pub mod distribution;` в `update.rs`) и всё, что о версиях, имени установщика и хеше, берёт у родителя: хост, оболочка и тесты сравнивают версии `"0.3.0".parse::<AppVersion>()`, хешируют установщик `hash_exact(reader, size)`, сверяют имя `installer_name(&version)`. Хост проверяет хеш тем же `hash_exact`, а не `backup::copy::sha256_file`. `markiro_proto::DeviceUpdate` занят телом `PUT /v1/office/devices/{id}` (`proto/src/lib.rs:520`), поэтому ответ устройству — `DeviceUpdateOffer`, Zod — `deviceUpdateOfferSchema` в `src/host/distribution.ts` (по образцу `src/host/backups.ts`). Порядка версий в вебвью у ОБН-2 нет (только форма `appVersionSchema`), поэтому `compareAppVersions` — здесь, сверенный с `AppVersion` общей фикстурой `app-versions.json`.
- **Д4 — версии.** Формат версии — тот, что принимает `prepare.mjs` (`VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/`, `tools/standalone-release/prepare.mjs:24`), без суффиксов; бета различается полем `channel` манифеста. Собственная версия оболочки для обновления — `app.package_info().version` (`tauri.conf.json`), как `UpdateConfig.installed` ОБН-2 и `getVersion()` вебвью; хоста — `env!("CARGO_PKG_VERSION")` хоста (`hello.version`, `server.rs:469`); заголовок `X-Markiro-App-Version` ОБН-1 шлёт `env!("CARGO_PKG_VERSION")` оболочки. Их равенство в одной сборке до этого плана ничем не проверялось; задача 14 добавляет контракт.
- **Д5 — коды и ограничения.** Новые коды ошибок: `package_verifying` (`503`, `Retry-After: 5`) и `update_busy` (`503`, `Retry-After: 30`, четвёртое скачивание на хост). Второе скачивание того же устройства и 31-й запрос в минуту — существующий `rate_limited` (`429`). `conflict` на `package_not_newer`, `package_unavailable`, `upload_unknown` (загрузка с таким `uploadId` не ждёт: её заменила новая или хост перезапущен), `disk_full` (нехватка места — `conflict`, текущий пакет не тронут). `validation_failed` с `details.reason`: на `manifest` — `manifest_malformed`, `manifest_unknown_key`, `manifest_signature`, `wrong_product`, `too_large`; на `installer` — `size_mismatch` (`Content-Length` нет или не равен `sizeBytes`, тело короче), `too_long` (байт сверх `sizeBytes`), `hash_mismatch`; на `range` — `416`.
- **Д6 — «идентификатор файла» перед отдачей.** Стабильный `std` не даёт индекс файла на Windows (`MetadataExt::file_index` нестабилен), а `windows-sys` в зависимостях хоста нет (`host/Cargo.toml:17-38`). Отметка файла — размер, время изменения, время создания и на Unix inode; переименование другого файла на место текущего на NTFS меняет время создания. Граница безопасности — проверка на устройстве (§10.11.2), отметка — гигиена.
- **Д7 — поток и `Range` своим кодом.** `tower-http` и `tokio-util` у хоста не зависимости (`host/Cargo.toml`), у `tokio` нет фичи `fs`. Отдача: читатель в `spawn_blocking` по 64 КиБ, канал ёмкостью 1, `Body::from_stream` (`futures-util` есть); 60 с без забора куска — читатель уходит, тело кончается раньше `Content-Length`, и hyper рвёт соединение. Разбор `Range` — одна область `bytes=N-` или `bytes=N-M`; список областей, суффикс `bytes=-N`, мусор и `N ≥ размер` — `416` с `Content-Range: bytes */<размер>`.
- **Д8 — предел тела.** `DefaultBodyLimit` действует только на экстракторы, которые его применяют; `axum::body::Body` его не применяет (`axum-core-0.5.6/src/extract/request_parts.rs:164`: `Ok(req.into_body())`). Маршрут установщика читает `Body` и держит предел сам (`sizeBytes` ≤ 256 МиБ из проверенного манифеста); маршрут манифеста получает свой `DefaultBodyLimit::max(MANIFEST_BODY_LIMIT)`, как `/v1/office/import` (`server.rs:405-410`). Общий предел остальных маршрутов не меняется.
- **Д9 — экран «Версии не совпадают» есть только для хоста на этом ПК.** `nextShellView` показывает `host_missing` с `app_too_old` лишь при `status.hostAddress === localAddress` (`src/app/shell.ts:308-323`); у станции, сопряжённой с хостом в сети, несовместимый `hello` оболочка превращает в `stream_refused` (`connection.rs:325-333`), и станция просто офлайн. План: связь называет причину (`app_too_old`, `host_too_old`, задача 10; версии `hello` любым протоколом читает `host_probe::read_versions` ОБН-2); ПК офиса, сопряжённый с удалённым хостом, получает экран «Версии не совпадают» (офис ему недоступен — `protocol_guard`); станция вне окна **продолжает работу офлайн** (§10.11.6: «продолжает работу офлайн: факты копятся в очереди») и получает строку на хабе (без кнопок) и на экране входа оператора — панель с кнопкой «Обновить с хоста» (ЛО16, разрешение — UAC); экран работы смены не прерывается никогда (§10.11.5). Это отклонение от буквы §10.11.6 («экран») ради непрерывности линии.
- **Д10 — «хаб».** Отдельного экрана «хаб» в основе нет (`src/floor/FloorApp.tsx:73-81`: `list`, `new_shift`, `work`, `warehouse`, `setup`, `queue`; ветка `claude/fb-hub` пуста). Хаб в этом плане — экраны цеха вне работы смены: вход оператора и список смен; строка состояния `FloorStatusBar` показывает строку обновления только при `shiftId === null` (`ShellState.floorWork`, `App.tsx:728`). Если к исполнению появится компонент хаба, строка переезжает туда по смыслу.
- **Д11 — `update_check_manifest`.** Вебвью не может проверить подпись манифеста сама (ключ выпусков — в сборке оболочки, `markiro_proto::trust`), а условие 4 правила требует проверки до показа заметок. Третья команда оболочки сверх контракта (`update_stage`, `update_fetch`) — `update_check_manifest { manifest }`: подпись, продукт, вид для показа.
- **Д12 — фичи в `src-tauri/Cargo.toml`.** Поток тела запроса — `reqwest::Body::from(tokio::fs::File)` при фиче `stream`; запись файла — `tokio::fs` и `AsyncWriteExt` (фичи `fs`, `io-util`). `Cargo.lock` не меняется: `stream` у reqwest уже включает Tauri на мобильных целях (`cargo tree --offline --locked --target all -e features -i reqwest` — `reqwest feature "stream"` ← `tauri v2.11.6`), его зависимости в замке есть; у `tokio` фичи без новых крейтов. Если `cargo build --offline --locked` всё же требует правки замка — остановиться: шаг владельца вне песочницы.
- **Д13 — история и состояния считает хост.** `GET /v1/office/update-status` отдаёт по каждому неотозванному устройству версию, протокол, `versionSeenAt`, состояние (`current`, `behind`, `incompatible`, `newer`, `unknown` — «неизвестно», пока устройство ни разу не прислало заголовок версии, `version_seen_at IS NULL`), «Скачан» по последней строке `update.download`, «Запущена установка» по последней `app.update.start`, линию по имени; и последние 20 строк аудита раздачи (`host.upgrade`, `update.package.stage`, `update.package.promote`, `update.download`, `app.update.start`). Отдельного маршрута чтения аудита в офисе нет; если ОБН-2 уже ввёл историю обновлений, исполнитель не дублирует её и пишет это в «Отклонения». Индекса на `audit_log.action` нет (`0002`: только `audit_log_at`); журнал растёт медленно (строки — правки офиса, сопряжения, блоки), полного прохода на открытие страницы достаточно; миграций хоста план не добавляет.
- **Д14 — устройство строки `app.update.start`.** ОБН-2 (Д1 его плана) шлёт тело `{ from, to, installerSha256, source }` без `deviceId` и берёт устройство из сессии; в цель или в `details` оно ложится — по коду ОБН-2. Хост этого плана берёт `target_id` при цели `device`, иначе `details.deviceId`; пакет с хоста ОБН-3 отчитывается тем же отчётом с `source: "host"` (`runUpdate(…, "host")`, задача 12).
- **Д15 — строки продвижения.** `update.package.promote` `ok` — `{ version, previous }` при продвижении; `failed` — `{ version, previous: null, reason }`: `invalid`, когда ожидающий пакет не прошёл проверку (он удаляется), и при старте — `mismatch` или `invalid`, когда текущий пакет не версии хоста или испорчен (восстановление от другой версии, правка файла). Устаревший ожидающий пакет (не новее хоста) удаляется без строки. Ежечасный проход — повтор неудавшегося переименования (версия хоста за время работы не меняется), строки — только при продвижении или неудаче проверки.
- **Д16 — одна загрузка.** Новый `POST …/manifest` заменяет незаконченную загрузку (её папка удаляется); `PUT` с прежним `uploadId` — `conflict` `upload_unknown`. Загрузку может закончить любой администратор, знающий `uploadId`; права перепроверяются в транзакции строки аудита (`require_admin_in`). Отказанная загрузка строк не пишет (§10.11.8); отказ подписи логируется кодом.
- **Д17 — полоса офиса.** Точку Т3 ввёл ЛЦ-3: `LicenseBanner` (`src/office/LicenseBanner.tsx`, вежливая область `.office-banner` между шапкой и `main` в `OfficeShell`). Общего реестра полос ЛЦ-3 не вводит, и этот план его не вводит: `UpdateBanner` — своя вежливая область того же класса сразу после `<LicenseBanner />`; третья полоса, если появится, — повод для реестра. Если ЛЦ-3 не слит, `UpdateBanner` встаёт на то же место один (запись в «Отклонения»).
- **Д18 — вкладчик поддержки.** `SupportContext` каркаса (`support-blocks.ts`: `{ t, facts, about }`) хоста не видит. Задача 12 добавляет в контекст `office: OfficeSessionValue | null` (`SupportSection` передаёт сессию); если ЛЦ-3 или ОБН-2 уже дали контексту доступ к хосту, используется он.
- **Д19 — прогресс скачивания** — событие `standalone://update-progress` `{ received, total }`; загрузка на хост прогресса не шлёт (кнопка в состоянии `loading`).
- **Д21 — проверка и запуск скачанного пакета — команды ОБН-2.** `update_fetch` только скачивает и сверяет хеш целиком; дальше скачанный манифест идёт в `update_verify`/`update_install` ОБН-2 (дескриптор без совместной записи, правила версий, отметка `update-pending.json`, `release_for_exit`). ОБН-3 добавляет в код ОБН-2 три вещи: `UpdateState::found_path` принимает `<данные>/updates/<версия>/markiro-standalone-<версия>.update.jws`; `rules::Offered::from_host` и отказ `Refusal::HostDiffers { hostVersion }` (`code: "host_differs"`), когда хост на другой версии, чем пакет с хоста (§10.11.4; молчащий хост — прежнее подтверждение `host_unreachable`, ЛО12); `pending::take_outcome` после «обновлено» удаляет папку скачанного. В офисе запуск — `runUpdate` ОБН-2 с новым параметром `source`; где офиса нет (экран несовместимости, станция вне окна) — `UpdateShell.install` сам, без отчёта (его маршрут офисный).
- **Д20 — `releases.json`.** Первая запись — бета `0.1.0` (протокол 3, мин. 1: `proto/src/lib.rs`, `tauri.conf.json`). Исполнитель сверяет с тегом выпуска беты (`git tag --list 'standalone-v*'`); расхождение — «Отклонения». Запись нового выпуска добавляет владелец в коммите выпуска (памятка).

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` — ЛЦ-2, `0031_device_versions.sql` — ОБН-1, `0032`–`0033` — резерв направления. **ОБН-3 миграций хоста не добавляет.** Открытые ветки используют `0017`–`0018` (fb-codesearch, fb-people, fb-templates, fb-mode) — не трогать.
- Оболочка (`src-tauri/migrations`) — новых миграций нет (`0030`–`0031` — резерв, не используются).
- Облако (`packages/db/migrations`) — этот план не трогает.
- Уточнения при исполнении — **§23** спецификации `2026-10-13-standalone-license-and-updates-design.md`.
- Имена контракта «ОБН-3 produces»: `HostPaths::updates_dir`; маршруты `POST /v1/office/update-package/manifest`, `PUT /v1/office/update-package/{uploadId}/installer`, `GET /v1/office/update-status`, `GET /v1/device/update`, `GET /v1/device/update/installer` (вне `protocol_guard`, с ключом устройства, `Range`/`If-Range`); аудит `audit::actions::UPDATE_PACKAGE_STAGE = "update.package.stage"`, `UPDATE_PACKAGE_PROMOTE = "update.package.promote"`, `UPDATE_DOWNLOAD = "update.download"`; команды оболочки `update_stage`, `update_fetch` (и `update_check_manifest`, Д11); таблица «Устройства и версии», полоса, строка станции на хабе, «Обновить с хоста» на экране несовместимости. Отклонения от контракта — Д3, Д9, Д10, Д11, Д21.

**Правила**

- Никогда `git stash`; команды из корня репозитория, пути абсолютные или от корня, без `cd`; pnpm — `pnpm --config.verifyDepsBeforeRun=false …`, без `pnpm install`/`add` (новая зависимость JS — шаг владельца; план их не добавляет); cargo — `--offline --locked`; интеграционные тесты, открывающие сокет на петле (`markiro_host::start`, `src-tauri/tests/update_*.rs`, `host/tests/update_logs.rs`), — вне песочницы.
- TDD: сначала падающий тест, потом код. Существующие утверждения не ослабляются. Аудит проверяется точно: субъект, действие, цель, итог, разобранные `details`.
- В журнале службы и в аудите — ни ключа устройства, ни токена сессии, ни текста манифеста целиком; путь запроса, `ETag` (SHA-256 — контрольная сумма, не секрет) и область — можно.
- Провод меняется вместе: `proto` + Zod + фикстуры. Типы ответов терпимы, тела запросов — `deny_unknown_fields`/`.strict()`. Ответы маршрутов устройств заморожены, как `HelloEnvelope`: поля только добавочные, неизвестное состояние пакета читается как «недоступно».
- Тексты — только через `apps/standalone/src/i18n/ru.json` (`en.json` в приложении нет). Компоненты — из `@markiro/ui`. Клавиатура, видимый фокус, подписи; состояние словами и значком, не только цветом.
- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов.
- Гейты перед каждым коммитом: `node_modules/.bin/prettier --ignore-path .prettierignore --check` на изменённые TS/TSX/JSON/MD/MJS; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint` (если менялся вебвью); `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` и сборка без предупреждений (если менялся Rust); `git diff --check`.
- Коммиты — явные пути, сообщение из файла, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR, выпуск — не задачи плана.

## Заметки для исполнения

**Предусловия (проверить до задачи 1; иначе остановиться и назвать, чего нет):**

```bash
test -f apps/standalone/src/office/info/sections.tsx            # fb-about слит
grep -n "pub fn verify_update_manifest" -r apps/standalone/proto/src   # ЛЦ-1
grep -n "pub fn update_keyset" -r apps/standalone/proto/src            # ЛЦ-1
grep -n 'test-keys' apps/standalone/proto/Cargo.toml apps/standalone/host/Cargo.toml   # ЛЦ-1
test -f packages/domain/fixtures/standalone-license/test-private-keys.json             # ЛЦ-1
grep -n "APP_VERSION_HEADER" apps/standalone/proto/src/lib.rs           # ОБН-1
grep -n "version_seen_at" apps/standalone/host/migrations/0031_device_versions.sql      # ОБН-1
grep -n "HOST_UPGRADE" apps/standalone/host/src/audit.rs               # ОБН-1
grep -n "APP_UPDATE_START" apps/standalone/host/src/audit.rs           # ОБН-2
grep -n "pub fn hash_exact\|pub fn installer_name\|impl FromStr for AppVersion" apps/standalone/proto/src/update.rs   # ОБН-2
grep -n "fn found_path\|pub async fn verify\|pub async fn install" apps/standalone/src-tauri/src/update/mod.rs        # ОБН-2
grep -n "pub enum Refusal\|pub struct Offered\|pub fn decide" apps/standalone/src-tauri/src/update/rules.rs        # ОБН-2
grep -n "pub fn take_outcome" apps/standalone/src-tauri/src/update/pending.rs                                         # ОБН-2
grep -n "pub fn read_versions" apps/standalone/src-tauri/src/host_probe.rs                                            # ОБН-2
grep -n "export async function runUpdate\|export function refusalText\|export function updateErrorText" apps/standalone/src/office/info/update-flow.ts apps/standalone/src/office/info/UpdateSection.tsx   # ОБН-2
grep -n '"update"' apps/standalone/src/office/info/sections.tsx         # ОБН-2: раздел «Обновление»
grep -n "LicenseBanner" apps/standalone/src/office/OfficeShell.tsx      # ЛЦ-3 (желательно)
```

**Имена ОБН-2, на которые опирается план** (из его плана; сверить с кодом до задачи 1): `markiro_proto::update::{AppVersion, NotAVersion, installer_name, hash_exact, HashError, PRODUCT, UpdateStarted, UpdateSource}`; оболочка — модуль `src-tauri/src/update/` (`rules.rs`: `decide`, `Offered`, `Refusal`, `Confirmation`, `HostCheck`; `package.rs`: `verify`, `Manifest::offered`, `MAX_MANIFEST_BYTES`; `launch.rs`; `pending.rs`: `take_outcome`), `UpdateState::{found_path, check, verify, install}`, `UpdateError::code`, команды `update_scan`, `update_verify { path }`, `update_install { path, confirm }`, `update_outcome`, `update_outcome_dismiss`, `update_open_folder`, `host_probe::{HostVersions, read_versions, host_versions}`, `lockdown::release_for_exit`, `office_files::UPDATES_ROOT` (папка «Документы\Markiro\Обновления», не путать с папкой скачанного `<локальные данные>\updates`); вебвью — `src/office/info/{update-shell.ts (UpdateShell, UpdateShellError, verifiedReportSchema, refusalSchema, VerifiedReport), update-context.tsx (useUpdateShell, UpdateShellProvider, TAURI_UPDATE_SHELL), update-flow.ts (installWarnings, runUpdate), UpdateSection.tsx (UpdateSection, refusalText, updateErrorText)}`; ЛЦ-3 — `src/office/LicenseBanner.tsx` в `OfficeShell`. Другое имя в исполненном коде — правка по смыслу и запись в «Отклонения».

**Фрагменты.** Фрагменты основы взяты из дерева `/tmp/claude/wt/fb-license` (`f38f4a3e9`, основа `claude/integration` `a4eef5cd6`) и `claude/fb-about` (`32d6aa5fa`); ЛЦ-1, ЛЦ-2, ОБН-1 и ОБН-2 меняют соседние строки тех же файлов (`audit.rs`, `server.rs`, `lib.rs`, `proto/src/lib.rs`, `ru.json`). Фрагмент, который не находится дословно, применяется по смыслу и записывается в «Отклонения при исполнении».

**Тестовые пакеты.** Манифесты для тестов подписываются во время теста тестовым ключом выпусков (`markiro_proto::update::distribution::testing::sign_update_manifest`, фича `test-keys`, задача 1); установщик теста — несколько сотен КиБ текста, чтобы поток шёл несколькими кусками по 64 КиБ. Предел 256 МиБ проверяется подставным пределом (`UpdateStore::with_max_installer`), а не настоящим файлом.

**pnpm, git, Cargo.** В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`; перед `-p markiro-standalone` — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`). Тесты `markiro-proto`, `--test update_store`, `--test update_package`, `--test update_start`, `--test update_device`, `--test update_download`, `--test update_hygiene` хоста сокета не открывают и идут в песочнице; `--test update_logs` хоста и `--test update_fetch`, `--test update_stage`, `--test ipc` оболочки — вне песочницы. Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный вывод `rtk` — `rtk proxy <команда>`.

## Файлы

- Create (провод): `apps/standalone/proto/src/update/distribution.rs`, `apps/standalone/proto/tests/distribution.rs`, `apps/standalone/proto/fixtures/{app-versions.json,device-update-offer.json,device-update-offer-missing.json,device-update-offer-future.json,update-package-manifest-request.json,update-package-upload.json,update-package-staged.json,office-update-status.json}`, `apps/standalone/src/host/distribution.ts`, `apps/standalone/test/distribution.test.ts`
- Create (хост): `apps/standalone/host/src/updates/{mod.rs,store.rs,stream.rs,limits.rs,worker.rs}`, `apps/standalone/host/src/routes/{update_package.rs,device_update.rs,update_status.rs}`, `apps/standalone/host/tests/support/update.rs`, `apps/standalone/host/tests/{update_store.rs,update_package.rs,update_start.rs,update_device.rs,update_download.rs,update_hygiene.rs,update_logs.rs}`
- Create (оболочка): `apps/standalone/src-tauri/src/update/{fetch.rs,stage.rs}`, `apps/standalone/src-tauri/tests/{update_fetch.rs,update_stage.rs}`
- Create (вебвью): `apps/standalone/src/update/{host-offer.ts,updates-api.ts,updates-context.tsx,use-host-offer.ts,UpdateFromHostDialog.tsx}`, `apps/standalone/src/office/info/{HostUpdateBlock.tsx,DeviceVersionsBlock.tsx,StageToHostButton.tsx,update-status.ts,update-support.ts}`, `apps/standalone/src/office/banners/UpdateBanner.tsx`, `apps/standalone/test/{host-offer.test.ts,updates-api.test.ts,update-from-host-dialog.test.tsx,update-section-host.test.tsx,update-status.test.ts,update-banner.test.tsx}`
- Create (выпуск): `tools/standalone-release/releases.json`, `tools/standalone-release/releases.mjs`, `tools/standalone-release/test/releases.test.mjs`
- Modify (провод): `apps/standalone/proto/src/update.rs` (ОБН-2), `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/fixtures/error-codes.json`, `apps/standalone/src/host/errors.ts`, `apps/standalone/src/host/protocol.ts`
- Modify (хост): `apps/standalone/host/src/{lib.rs,config.rs,server.rs,audit.rs}`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/tests/support/app.rs`, таблица классификации маршрутов ЛЦ-2 (файл — по ЛЦ-2)
- Modify (оболочка): `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/src-tauri/src/{lib.rs,host_client.rs,device.rs,connection.rs}`, файлы ОБН-2 `apps/standalone/src-tauri/src/update/{mod.rs,rules.rs,package.rs,pending.rs}`, `apps/standalone/src-tauri/tests/{ipc.rs,connection.rs,update.rs}`
- Modify (вебвью): `apps/standalone/src/host/{api.ts,connection.ts}`, `apps/standalone/src/app/{App.tsx,shell.ts,screens.tsx,HostStatusLine.tsx}`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/office/{Office.tsx,OfficeShell.tsx,office-query.ts}`, `apps/standalone/src/office/info/{support-blocks.ts,SupportSection.tsx}` и файлы ОБН-2 `apps/standalone/src/office/info/{UpdateSection.tsx,update-shell.ts,update-flow.ts}` с их тестами, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/{protocol.test.ts,errors.test.ts,connection.test.ts,host-status-line.test.tsx,app.test.tsx,floor-status-bar.test.tsx}`
- Modify (выпуск и документы): `tools/standalone-release/prepare.mjs`, `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`

---

### Task 1: Провод раздачи — `markiro_proto::update::distribution`, коды, фикстуры, Zod

**Files:**

- Create: `apps/standalone/proto/src/update/distribution.rs`, `apps/standalone/proto/tests/distribution.rs`, восемь фикстур (раздел «Файлы»), `apps/standalone/src/host/distribution.ts`, `apps/standalone/test/distribution.test.ts`
- Modify: `apps/standalone/proto/src/update.rs` (ОБН-2: `pub mod distribution;`), `apps/standalone/proto/src/lib.rs` (коды), `apps/standalone/proto/fixtures/error-codes.json`, `apps/standalone/src/host/errors.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/proto/tests/distribution.rs`, `apps/standalone/proto/tests/fixtures.rs` (существующая сверка `error-codes.json`), `apps/standalone/test/distribution.test.ts`, `apps/standalone/test/errors.test.ts`

**Interfaces:**

- Consumes: `markiro_proto::update::{AppVersion, NotAVersion, installer_name, hash_exact, PRODUCT}` (ОБН-2); `markiro_proto::DeviceKind`, `codes::ALL`; фича `test-keys`, `aws-lc-rs` и `base64` в `proto` (ЛЦ-1); `appVersionSchema` (ОБН-2, `src/host/protocol.ts`).
- Produces: `markiro_proto::update::distribution::{PackageState, OfferedPackage, DeviceUpdateOffer, UpdatePackageManifestRequest, UpdatePackageUpload, UpdatePackageStaged, HostPackage, DeviceVersionState, UpdateMark, DeviceVersion, UpdateHistoryItem, OfficeUpdateStatus, MAX_MANIFEST_BYTES, MAX_INSTALLER_BYTES, constraints, reasons}`, `distribution::testing::sign_update_manifest` (фича `test-keys`); `codes::PACKAGE_VERIFYING`, `codes::UPDATE_BUSY`; фикстура `app-versions.json` (общие случаи порядка версий для `AppVersion` ОБН-2 и вебвью); TS `parseAppVersion`, `compareAppVersions`, `deviceUpdateOfferSchema`, `officeUpdateStatusSchema`, типы `DeviceUpdateOffer`, `OfficeUpdateStatus`, `DeviceVersion`, `DeviceVersionState`.

- [ ] **Step 1: Фикстуры и падающие тесты**

Создать `apps/standalone/proto/fixtures/app-versions.json` (`AppVersion` ОБН-2 — три `u32`, без суффиксов и ведущих нулей):

```json
{
  "valid": [
    ["0.1.0", [0, 1, 0]],
    ["0.10.0", [0, 10, 0]],
    ["1.2.3", [1, 2, 3]],
    ["4294967295.0.0", [4294967295, 0, 0]]
  ],
  "invalid": [
    "",
    "0.1",
    "0.1.0.0",
    "01.2.3",
    "0.01.3",
    "0.1.0-beta.1",
    "v0.1.0",
    "0.1.x",
    " 0.1.0",
    "0.1.0 ",
    "4294967296.0.0",
    "-1.0.0",
    "+1.0.0"
  ],
  "order": [
    ["0.9.3", "0.10.0", -1],
    ["0.3.0", "0.3.0", 0],
    ["1.0.0", "0.99.99", 1],
    ["0.2.1", "0.3.0", -1],
    ["0.3.1", "0.3.0", 1]
  ]
}
```

Создать `apps/standalone/proto/fixtures/device-update-offer.json` (манифест — форма компактного JWS, подпись не настоящая: фикстура закрепляет форму ответа):

```json
{
  "hostVersion": "0.3.0",
  "package": {
    "state": "ok",
    "manifest": "eyJ0eXAiOiJtYXJraXJvLXN0YW5kYWxvbmUtdXBkYXRlK2p3cyIsImFsZyI6IkVTMjU2Iiwia2lkIjoidGVzdC11cGQtMSJ9.eyJ2IjoxfQ.c2lnbmF0dXJl",
    "version": "0.3.0",
    "sizeBytes": 61234567,
    "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae"
  }
}
```

`device-update-offer-missing.json`:

```json
{ "hostVersion": "0.3.0", "package": { "state": "missing" } }
```

`device-update-offer-future.json` (ответ будущего хоста: неизвестное состояние и поля):

```json
{
  "hostVersion": "0.5.0",
  "package": { "state": "quarantined", "reason": "a newer host's word" },
  "mirror": "a newer host's field"
}
```

`update-package-manifest-request.json`:

```json
{
  "manifest": "eyJ0eXAiOiJtYXJraXJvLXN0YW5kYWxvbmUtdXBkYXRlK2p3cyIsImFsZyI6IkVTMjU2Iiwia2lkIjoidGVzdC11cGQtMSJ9.eyJ2IjoxfQ.c2lnbmF0dXJl"
}
```

`update-package-upload.json`:

```json
{
  "uploadId": "6b1f2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "version": "0.3.0",
  "sizeBytes": 61234567,
  "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae"
}
```

`update-package-staged.json`:

```json
{
  "version": "0.3.0",
  "sizeBytes": 61234567,
  "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae"
}
```

`office-update-status.json` (по строке на каждое состояние устройства):

```json
{
  "hostVersion": "0.3.0",
  "protocol": 4,
  "minProtocol": 3,
  "package": {
    "state": "ok",
    "version": "0.3.0",
    "staged": null,
    "previous": "0.2.1",
    "diskBytes": 122469134
  },
  "devices": [
    {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "kind": "station",
      "name": "Станция линии 1",
      "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      "lineName": "Линия 1",
      "appVersion": "0.3.0",
      "protocol": 4,
      "versionSeenAt": "2026-11-03T07:10:00Z",
      "lastSeenAt": "2026-11-03T09:00:00Z",
      "state": "current",
      "downloaded": { "at": "2026-11-03T06:55:00Z", "version": "0.3.0" },
      "installStarted": { "at": "2026-11-03T07:00:00Z", "version": "0.3.0" }
    },
    {
      "id": "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
      "kind": "station",
      "name": "Станция линии 2",
      "lineId": null,
      "lineName": null,
      "appVersion": "0.2.1",
      "protocol": 3,
      "versionSeenAt": "2026-11-02T15:00:00Z",
      "lastSeenAt": "2026-11-03T08:59:00Z",
      "state": "behind",
      "downloaded": null,
      "installStarted": null
    },
    {
      "id": "2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a8b",
      "kind": "office",
      "name": "ПК бухгалтерии",
      "lineId": null,
      "lineName": null,
      "appVersion": "0.1.0",
      "protocol": 2,
      "versionSeenAt": "2026-10-20T10:00:00Z",
      "lastSeenAt": "2026-10-20T10:05:00Z",
      "state": "incompatible",
      "downloaded": null,
      "installStarted": null
    },
    {
      "id": "3b4c5d6e-7f80-4192-8b3c-4d5e6f7a8b9c",
      "kind": "station",
      "name": "Станция склада",
      "lineId": null,
      "lineName": null,
      "appVersion": "0.4.0",
      "protocol": 4,
      "versionSeenAt": "2026-11-03T08:00:00Z",
      "lastSeenAt": "2026-11-03T08:30:00Z",
      "state": "newer",
      "downloaded": null,
      "installStarted": null
    },
    {
      "id": "4c5d6e7f-8091-42a3-9c4d-5e6f7a8b9c0d",
      "kind": "handheld",
      "name": "ТСД 1",
      "lineId": null,
      "lineName": null,
      "appVersion": "0.1.0",
      "protocol": 1,
      "versionSeenAt": null,
      "lastSeenAt": null,
      "state": "unknown",
      "downloaded": null,
      "installStarted": null
    }
  ],
  "history": [
    {
      "at": "2026-11-03T07:00:00Z",
      "action": "app.update.start",
      "result": "ok",
      "actor": "Ирина Смирнова",
      "version": null,
      "from": "0.2.1",
      "to": "0.3.0"
    },
    {
      "at": "2026-11-03T06:55:00Z",
      "action": "update.download",
      "result": "ok",
      "actor": "Станция линии 1",
      "version": "0.3.0",
      "from": null,
      "to": null
    }
  ]
}
```

Создать `apps/standalone/proto/tests/distribution.rs`:

```rust
//! The update distribution shapes (plan ОБН-3) against their fixtures, which
//! `test/distribution.test.ts` parses with the Zod schemas too, and the
//! order of app versions (`markiro_proto::update::AppVersion`, plan ОБН-2)
//! the webview mirrors (`app-versions.json`).

use std::cmp::Ordering;

use markiro_proto::codes;
use markiro_proto::update::distribution::{
    DeviceUpdateOffer, DeviceVersionState, OfficeUpdateStatus, PackageState,
    UpdatePackageManifestRequest, UpdatePackageStaged, UpdatePackageUpload, MAX_INSTALLER_BYTES,
    MAX_MANIFEST_BYTES,
};
use markiro_proto::update::AppVersion;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

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

#[test]
fn versions_read_and_order_as_the_shared_fixture_says() {
    let cases = fixture("app-versions.json");
    for case in cases["valid"].as_array().unwrap() {
        let text = case[0].as_str().unwrap();
        let parts: Vec<u64> = case[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part.as_u64().unwrap())
            .collect();
        let version: AppVersion = text.parse().unwrap_or_else(|_| panic!("{text} reads"));
        assert_eq!(
            vec![
                u64::from(version.major),
                u64::from(version.minor),
                u64::from(version.patch)
            ],
            parts,
            "{text}"
        );
        assert_eq!(version.to_string(), text);
    }
    for text in cases["invalid"].as_array().unwrap() {
        let text = text.as_str().unwrap();
        assert!(text.parse::<AppVersion>().is_err(), "{text:?}");
    }
    for case in cases["order"].as_array().unwrap() {
        let left: AppVersion = case[0].as_str().unwrap().parse().unwrap();
        let right: AppVersion = case[1].as_str().unwrap().parse().unwrap();
        let expected = match case[2].as_i64().unwrap() {
            -1 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        assert_eq!(left.cmp(&right), expected, "{case}");
    }
}

#[test]
fn a_devices_offer_round_trips_and_reads_a_newer_hosts_answer() {
    let offer: DeviceUpdateOffer = round_trip("device-update-offer.json");
    assert_eq!(offer.package.state, PackageState::Ok);
    assert_eq!(offer.package.size_bytes, Some(61_234_567));
    let missing: DeviceUpdateOffer = round_trip("device-update-offer-missing.json");
    assert_eq!(
        (missing.package.state, missing.package.manifest),
        (PackageState::Missing, None)
    );
    // Frozen like `hello`: a state this build does not know is unknown, not an error.
    let future: DeviceUpdateOffer =
        serde_json::from_value(fixture("device-update-offer-future.json")).unwrap();
    assert_eq!(
        (future.host_version.as_str(), future.package.state),
        ("0.5.0", PackageState::Unknown)
    );
}

#[test]
fn the_upload_shapes_round_trip_and_the_request_takes_no_other_field() {
    let request: UpdatePackageManifestRequest =
        round_trip("update-package-manifest-request.json");
    assert!(request.manifest.starts_with("eyJ"));
    let mut extra = fixture("update-package-manifest-request.json");
    extra["installer"] = json!("bytes");
    assert!(serde_json::from_value::<UpdatePackageManifestRequest>(extra).is_err());
    let upload: UpdatePackageUpload = round_trip("update-package-upload.json");
    assert_eq!(upload.size_bytes, 61_234_567);
    let staged: UpdatePackageStaged = round_trip("update-package-staged.json");
    assert_eq!(staged.version, "0.3.0");
}

#[test]
fn the_offices_status_round_trips_with_every_device_state() {
    let status: OfficeUpdateStatus = round_trip("office-update-status.json");
    assert_eq!(
        status
            .devices
            .iter()
            .map(|device| device.state)
            .collect::<Vec<_>>(),
        [
            DeviceVersionState::Current,
            DeviceVersionState::Behind,
            DeviceVersionState::Incompatible,
            DeviceVersionState::Newer,
            DeviceVersionState::Unknown,
        ]
    );
    assert_eq!(status.package.previous.as_deref(), Some("0.2.1"));
    assert_eq!(status.history.len(), 2);
}

#[test]
fn limits_and_codes_are_the_specs() {
    assert_eq!(MAX_MANIFEST_BYTES, 64 * 1024);
    assert_eq!(MAX_INSTALLER_BYTES, 256 * 1024 * 1024);
    assert!(codes::ALL.contains(&codes::PACKAGE_VERIFYING));
    assert!(codes::ALL.contains(&codes::UPDATE_BUSY));
}

#[cfg(feature = "test-keys")]
#[test]
fn a_manifest_signed_for_tests_checks_out_with_the_test_update_key() {
    let payload = json!({
        "v": 1, "product": "markiro-standalone", "version": "0.3.0", "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": {
            "name": "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
            "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
            "sizeBytes": 22
        },
        "protocol": 4, "minProtocol": 3, "minUpgradeFrom": "0.2.0", "notes": ["Тест"]
    });
    let compact = markiro_proto::update::distribution::testing::sign_update_manifest(&payload);
    let (manifest, kid) = markiro_proto::trust::verify_update_manifest(
        &compact,
        &markiro_proto::trust::update_keyset(),
    )
    .expect("the test key signs what the test keyset trusts");
    assert_eq!((manifest.version.as_str(), kid.as_str()), ("0.3.0", "test-upd-1"));
}
```

Создать `apps/standalone/test/distribution.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compareAppVersions,
  deviceUpdateOfferSchema,
  officeUpdateStatusSchema,
  parseAppVersion,
} from "../src/host/distribution.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

const versionCases = z.object({
  valid: z.array(z.tuple([z.string(), z.tuple([z.number(), z.number(), z.number()])])),
  invalid: z.array(z.string()),
  order: z.array(
    z.tuple([z.string(), z.string(), z.union([z.literal(-1), z.literal(0), z.literal(1)])]),
  ),
});

describe("app versions (proto/fixtures/app-versions.json)", () => {
  const cases = versionCases.parse(fixture("app-versions.json"));

  it("read as markiro_proto::update::AppVersion reads them", () => {
    for (const [text, parts] of cases.valid) expect(parseAppVersion(text), text).toEqual(parts);
    for (const text of cases.invalid) expect(parseAppVersion(text), text).toBeNull();
  });

  it("order by number, not by text", () => {
    for (const [left, right, order] of cases.order) {
      expect(compareAppVersions(left, right), `${left} ${right}`).toBe(order);
    }
    expect(compareAppVersions("0.3.0", "0.3")).toBeNull();
  });
});

describe("distribution shapes (proto/fixtures)", () => {
  it("read a device's offer, and a newer host's unknown state as text", () => {
    const offer = deviceUpdateOfferSchema.parse(fixture("device-update-offer.json"));
    expect(offer.package).toMatchObject({ state: "ok", version: "0.3.0", sizeBytes: 61234567 });
    expect(
      deviceUpdateOfferSchema.parse(fixture("device-update-offer-missing.json")).package,
    ).toEqual({ state: "missing" });
    const future = deviceUpdateOfferSchema.parse(fixture("device-update-offer-future.json"));
    expect(future.package.state).toBe("quarantined");
  });

  it("read the office's status with every device state", () => {
    const status = officeUpdateStatusSchema.parse(fixture("office-update-status.json"));
    expect(status.devices.map((device) => device.state)).toEqual([
      "current",
      "behind",
      "incompatible",
      "newer",
      "unknown",
    ]);
    expect(status.history[0]).toMatchObject({
      action: "app.update.start",
      from: "0.2.1",
      to: "0.3.0",
    });
  });
});
```

Правка `apps/standalone/test/errors.test.ts` не нужна: тест «list exactly the host's error codes» падает сам, пока `API_ERROR_CODES` не знает новых кодов фикстуры.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test distribution
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/distribution.test.ts
```

Ожидается: Rust не собирается (`markiro_proto::update::distribution` не найден); Vitest — FAIL (модуль `src/host/distribution.js` не найден).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/proto/src/update.rs` (модуль ОБН-2) — после строки `use sha2::{Digest, Sha256};` добавить:

```rust

/// Update distribution through the host (plan ОБН-3): `update/distribution.rs`.
pub mod distribution;
```

Создать `apps/standalone/proto/src/update/distribution.rs` (подмодуль файла-модуля `update.rs`: Rust ищет его в папке `update/` рядом):

```rust
//! Update distribution through the host (plan ОБН-3, spec §10.11): the state
//! of the host's package and the shapes of the office's upload, a device's
//! offer and the office's table of versions. The version rule, the
//! installer's name and the exact-size hash are the parent module's (plan
//! ОБН-2).
//!
//! `GET /v1/device/update` answers devices of any protocol version (it is
//! outside `protocol_guard`, like `hello`), so [`DeviceUpdateOffer`] is frozen
//! the same way: new fields only additive, read leniently, and a package
//! state this build does not know reads as [`PackageState::Unknown`].

use serde::{Deserialize, Serialize};

use crate::DeviceKind;

/// The longest manifest the host takes (spec §10.11.2).
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// The largest installer the host takes and a device downloads (spec §10.11.2).
pub const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;

/// `details.constraint` of a `conflict` on the distribution routes.
pub mod constraints {
    /// The uploaded manifest is not newer than the running host.
    pub const PACKAGE_NOT_NEWER: &str = "package_not_newer";
    /// The host has no package to serve (`missing`, `mismatch`, `invalid`).
    pub const PACKAGE_UNAVAILABLE: &str = "package_unavailable";
    /// No upload of this id waits for its installer: another replaced it, or
    /// the host restarted.
    pub const UPLOAD_UNKNOWN: &str = "upload_unknown";
    /// The host's disk is full; the current package is untouched.
    pub const DISK_FULL: &str = "disk_full";
}

/// `details.reason` of a `validation_failed` on `manifest` or `installer`.
pub mod reasons {
    pub const MANIFEST_MALFORMED: &str = "manifest_malformed";
    pub const MANIFEST_UNKNOWN_KEY: &str = "manifest_unknown_key";
    pub const MANIFEST_SIGNATURE: &str = "manifest_signature";
    pub const WRONG_PRODUCT: &str = "wrong_product";
    /// The manifest is over 64 KiB, or names an installer over the limit.
    pub const TOO_LARGE: &str = "too_large";
    /// No `Content-Length`, one other than `sizeBytes`, or a shorter body.
    pub const SIZE_MISMATCH: &str = "size_mismatch";
    /// A byte beyond `sizeBytes`: the upload was cut there.
    pub const TOO_LONG: &str = "too_long";
    pub const HASH_MISMATCH: &str = "hash_mismatch";
}

/// The state of the host's current package (spec §10.11.2); only `ok` is
/// served.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageState {
    Ok,
    Missing,
    /// The manifest's version is not the host's (a restore from a copy of
    /// another version, a package that was never promoted).
    Mismatch,
    /// The signature, the size or the SHA-256 does not check out.
    Invalid,
    /// The files changed since the last full check, which runs now.
    Verifying,
    /// A state of a newer host: a device reads it as «unavailable». Never
    /// written by this build.
    #[serde(other)]
    Unknown,
}

/// The package part of [`DeviceUpdateOffer`]; the fields beside `state` are
/// there only for `ok`, and only for showing before the device checked
/// `manifest` itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedPackage {
    pub state: PackageState,
    /// The signed manifest's text, as uploaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl OfferedPackage {
    /// A package that is not served: the state alone.
    pub fn unavailable(state: PackageState) -> Self {
        Self {
            state,
            manifest: None,
            version: None,
            size_bytes: None,
            sha256: None,
        }
    }
}

/// `GET /v1/device/update` (spec §10.11.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUpdateOffer {
    pub host_version: String,
    pub package: OfferedPackage,
}

/// `POST /v1/office/update-package/manifest`: the signed manifest's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePackageManifestRequest {
    pub manifest: String,
}

/// The answer to the manifest: the upload the installer goes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackageUpload {
    pub upload_id: String,
    pub version: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// `PUT /v1/office/update-package/{uploadId}/installer`: the package is
/// `staged\` now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackageStaged {
    pub version: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// The host's packages as the office sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPackage {
    pub state: PackageState,
    /// The current package's version (`ok`, `mismatch`).
    pub version: Option<String>,
    /// The waiting package's version, when one waits.
    pub staged: Option<String>,
    pub previous: Option<String>,
    /// What `updates\` takes on the host's disk.
    pub disk_bytes: u64,
}

/// A device's version against the host's (spec §10.11.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceVersionState {
    Current,
    /// Older, its protocol still taken: works, the update is offered.
    Behind,
    /// Its protocol is below the host's minimum: it does not connect.
    Incompatible,
    Newer,
    /// The device never sent its version (`version_seen_at` is empty).
    Unknown,
}

/// When and of which version a device's last download or installation began.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMark {
    pub at: String,
    pub version: Option<String>,
}

/// One row of «Устройства и версии».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceVersion {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub line_name: Option<String>,
    pub app_version: String,
    pub protocol: u32,
    pub version_seen_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub state: DeviceVersionState,
    pub downloaded: Option<UpdateMark>,
    pub install_started: Option<UpdateMark>,
}

/// One row of the update history: an audit row of the distribution, the
/// actor by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHistoryItem {
    pub at: String,
    pub action: String,
    pub result: String,
    pub actor: Option<String>,
    pub version: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `GET /v1/office/update-status` (every office role).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUpdateStatus {
    pub host_version: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub package: HostPackage,
    pub devices: Vec<DeviceVersion>,
    pub history: Vec<UpdateHistoryItem>,
}

/// Update manifests signed during a test with the TEST release key of
/// `packages/domain/fixtures/standalone-license/test-private-keys.json`: the
/// host's and the shell's suites need packages of the running build's
/// version, which committed fixtures (plan ОБН-2) cannot know. Feature
/// `test-keys` only: a release build has neither the key nor this code.
#[cfg(feature = "test-keys")]
pub mod testing {
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use serde_json::{json, Value};

    const TEST_PRIVATE_KEYS: &str = include_str!(
        "../../../../../packages/domain/fixtures/standalone-license/test-private-keys.json"
    );

    /// `payload` (the manifest of spec §10.2) as a compact JWS of the update
    /// type, signed with the test release key.
    pub fn sign_update_manifest(payload: &Value) -> String {
        sign("markiro-standalone-update+jws", "update", payload)
    }

    fn sign(typ: &str, purpose: &str, payload: &Value) -> String {
        let keys: Value = serde_json::from_str(TEST_PRIVATE_KEYS).expect("the test keys read");
        let entry = &keys[purpose];
        let kid = entry["kid"].as_str().expect("a test key names its kid");
        let part = |name: &str| {
            URL_SAFE_NO_PAD
                .decode(entry["jwk"][name].as_str().expect("a JWK part"))
                .expect("base64url")
        };
        let mut public = vec![4u8];
        public.extend(part("x"));
        public.extend(part("y"));
        let pair = EcdsaKeyPair::from_private_key_and_public_key(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &part("d"),
            &public,
        )
        .expect("the test key pair");
        let header = json!({ "typ": typ, "alg": "ES256", "kid": kid });
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        let signature = pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .expect("signing");
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
}
```

Если проверка ЛЦ-1 требует точного порядка ключей заголовка (`typ`, `alg`, `kid`), а `serde_json` без `preserve_order` сортирует их, заголовок строится строкой `format!(r#"{{"typ":"{typ}","alg":"ES256","kid":"{kid}"}}"#)`; если форма `test-private-keys.json` иная (Д2) — чтение ключа правится по смыслу. Оба случая — в «Отклонения». Если генератор ОБН-2 (`tools/standalone-release/generate-update-fixtures.mjs`, `findJwk`) уже ищет ключ по `kid` в этом файле, его способ поиска повторяется здесь.

Правка `apps/standalone/proto/src/lib.rs` (модуль `codes`):

Фрагмент 1:

```rust
    pub const RESTORE_PENDING: &str = "restore_pending";

    /// Every code above, for the parity fixture the webview also reads.
```

заменить на:

```rust
    pub const RESTORE_PENDING: &str = "restore_pending";
    /// The host checks its update package again after its files changed
    /// (plan ОБН-3): `503` with `Retry-After`, ask again in a moment.
    pub const PACKAGE_VERIFYING: &str = "package_verifying";
    /// Three devices download the update from the host already (plan
    /// ОБН-3): `503` with `Retry-After: 30`.
    pub const UPDATE_BUSY: &str = "update_busy";

    /// Every code above, for the parity fixture the webview also reads.
```

Фрагмент 2:

```rust
        RESTORE_PENDING,
    ];
```

заменить на:

```rust
        RESTORE_PENDING,
        PACKAGE_VERIFYING,
        UPDATE_BUSY,
    ];
```

`apps/standalone/proto/fixtures/error-codes.json`: после `"restore_pending"` добавить `"package_verifying"`, `"update_busy"`.

Создать `apps/standalone/src/host/distribution.ts`:

```ts
import { z } from "zod";

import { deviceKindSchema } from "./protocol.js";

// Update distribution through the host (plan ОБН-3): mirrors
// `markiro_proto::update::distribution`. The host's answers are lenient
// like the Rust response types; `proto/fixtures/device-update-*.json`,
// `office-update-status.json` and `app-versions.json` hold the shapes both
// sides read.

const PART = /^(0|[1-9][0-9]*)$/;
/** `u32::MAX`: `markiro_proto::update::AppVersion` keeps three `u32`. */
const MAX_PART = 4_294_967_295;

/** `MAJOR.MINOR.PATCH` as `markiro_proto::update::AppVersion` reads it; `null` for anything else. */
export function parseAppVersion(text: string): [number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) return null;
  const [major, minor, patch] = parts.map(Number);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (major > MAX_PART || minor > MAX_PART || patch > MAX_PART) return null;
  return [major, minor, patch];
}

/** `-1`, `0` or `1` as `a` is older than, equal to or newer than `b`; `null` when either does not read. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** `GET /v1/device/update` (frozen like `hello`: additive only; a newer host's state stays text). */
export const deviceUpdateOfferSchema = z.object({
  hostVersion: z.string(),
  package: z.object({
    state: z.string(),
    manifest: z.string().optional(),
    version: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
  }),
});
export type DeviceUpdateOffer = z.infer<typeof deviceUpdateOfferSchema>;

export const DEVICE_VERSION_STATES = [
  "current",
  "behind",
  "incompatible",
  "newer",
  "unknown",
] as const;
export type DeviceVersionState = (typeof DEVICE_VERSION_STATES)[number];

const updateMarkSchema = z.object({ at: z.iso.datetime(), version: z.string().nullable() });

export const deviceVersionSchema = z.object({
  id: z.uuid(),
  kind: deviceKindSchema,
  name: z.string(),
  lineId: z.uuid().nullable(),
  lineName: z.string().nullable(),
  appVersion: z.string(),
  protocol: z.number().int().nonnegative(),
  versionSeenAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  state: z.enum(DEVICE_VERSION_STATES),
  downloaded: updateMarkSchema.nullable(),
  installStarted: updateMarkSchema.nullable(),
});
export type DeviceVersion = z.infer<typeof deviceVersionSchema>;

/** `GET /v1/office/update-status` (every office role). */
export const officeUpdateStatusSchema = z.object({
  hostVersion: z.string(),
  protocol: z.number().int().nonnegative(),
  minProtocol: z.number().int().nonnegative(),
  package: z.object({
    state: z.string(),
    version: z.string().nullable(),
    staged: z.string().nullable(),
    previous: z.string().nullable(),
    diskBytes: z.number().int().nonnegative(),
  }),
  devices: z.array(deviceVersionSchema),
  history: z.array(
    z.object({
      at: z.iso.datetime(),
      action: z.string(),
      result: z.string(),
      actor: z.string().nullable(),
      version: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
  ),
});
export type OfficeUpdateStatus = z.infer<typeof officeUpdateStatusSchema>;
```

(`appVersionSchema` ОБН-2 — регулярное выражение формы; `parseAppVersion` добавляет предел `u32`, которого форма не знает, и порядок, которого у вебвью до этого плана не было.)

Правка `apps/standalone/src/host/errors.ts` — фрагмент:

<!-- prettier-ignore -->
```ts
  "sscc_exhausted",
  "restore_pending",
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  "sscc_exhausted",
  "restore_pending",
  "package_verifying",
  "update_busy",
] as const;
```

Правка `apps/standalone/src/i18n/ru.json` — в `errors.api` после `"restore_pending": "…"` добавить:

<!-- prettier-ignore -->
```json
      "package_verifying": "Хост заново проверяет пакет обновления. Повторите через минуту.",
      "update_busy": "С хоста уже скачивают обновление три устройства. Повторите через полминуты."
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test distribution --test fixtures --test update
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --features test-keys --test distribution
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/distribution.test.ts test/errors.test.ts test/protocol.test.ts
```

Ожидается: PASS (`--test update` — тесты ОБН-2 модуля-родителя не тронуты). Мутация: в `parseAppVersion` убрать проверку `MAX_PART` — FAIL «read as markiro_proto::update::AppVersion reads them» (`4294967296.0.0` читается); файл восстановить (`cmp`, тот же `shasum`).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/proto/fixtures/app-versions.json apps/standalone/proto/fixtures/device-update-offer.json apps/standalone/proto/fixtures/device-update-offer-missing.json apps/standalone/proto/fixtures/device-update-offer-future.json apps/standalone/proto/fixtures/update-package-manifest-request.json apps/standalone/proto/fixtures/update-package-upload.json apps/standalone/proto/fixtures/update-package-staged.json apps/standalone/proto/fixtures/office-update-status.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/src/host/distribution.ts apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json apps/standalone/test/distribution.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/proto/src/update.rs apps/standalone/proto/src/update/distribution.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/distribution.rs apps/standalone/proto/fixtures/app-versions.json apps/standalone/proto/fixtures/device-update-offer.json apps/standalone/proto/fixtures/device-update-offer-missing.json apps/standalone/proto/fixtures/device-update-offer-future.json apps/standalone/proto/fixtures/update-package-manifest-request.json apps/standalone/proto/fixtures/update-package-upload.json apps/standalone/proto/fixtures/update-package-staged.json apps/standalone/proto/fixtures/office-update-status.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/src/host/distribution.ts apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json apps/standalone/test/distribution.test.ts
git commit -F /tmp/claude/msg-obn3-1.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the wire of update distribution (offer, upload, status, codes)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 2: Хранилище пакета на хосте — `updates\`, проверка, уборка, продвижение, загрузка

**Files:**

- Create: `apps/standalone/host/src/updates/mod.rs`, `apps/standalone/host/src/updates/store.rs`, `apps/standalone/host/tests/support/update.rs`, `apps/standalone/host/tests/update_store.rs`
- Modify: `apps/standalone/host/src/config.rs`, `apps/standalone/host/src/lib.rs` (`pub mod updates;`), `apps/standalone/host/tests/support/mod.rs` (`pub mod update;`)
- Test: `apps/standalone/host/tests/update_store.rs`

**Interfaces:**

- Consumes: `markiro_proto::update::distribution::*` (задача 1), `markiro_proto::update::{AppVersion, installer_name, hash_exact, PRODUCT}` (ОБН-2), `markiro_proto::trust::{verify_update_manifest, Keyset, TrustError}` (ЛЦ-1), `backup::copy::write_synced`.
- Produces: `HostPaths::updates_dir()`; `updates::{UpdateStore, Package, CheckedManifest, ManifestRefusal, Upload, UploadError, Promotion, StartReport, Serve, FileStamp, check_manifest, MANIFEST_FILE, STAGED, CURRENT, PREVIOUS}`; `UpdateStore::{new, with_max_installer, dir, host_version, max_installer, open_blocking, promote_blocking, reverify_blocking, serve_blocking, status_blocking, check_manifest, begin_upload_blocking, upload, finish_upload_blocking, abandon_upload_blocking}`.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/support/update.rs`:

```rust
//! Update packages of the distribution suites (plan ОБН-3): manifests signed
//! with the test release key, installers of a few hundred KiB so a stream
//! goes in several 64 KiB pieces.

use std::path::Path;

use markiro_proto::update::distribution::testing::sign_update_manifest;
use serde_json::{json, Value};

/// The bytes of a test installer of `version`: unlike any other version's.
pub fn installer_bytes(version: &str) -> Vec<u8> {
    format!("MZ markiro test installer {version}\n")
        .repeat(8_000)
        .into_bytes()
}

pub fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    markiro_proto::update::hash_exact(bytes, bytes.len() as u64).unwrap()
}

/// The manifest of spec §10.2 for an installer of `bytes`.
pub fn manifest_payload(version: &str, bytes: &[u8]) -> Value {
    json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": {
            "name": installer_name(version), "sha256": sha256_hex(bytes), "sizeBytes": bytes.len()
        },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.1.0",
        "notes": ["Тестовый выпуск"]
    })
}

pub fn signed_manifest(version: &str, bytes: &[u8]) -> String {
    sign_update_manifest(&manifest_payload(version, bytes))
}

/// A package of `version` in `<updates>/<folder>`: its manifest and its
/// installer bytes.
pub fn write_package(updates: &Path, folder: &str, version: &str) -> (String, Vec<u8>) {
    let bytes = installer_bytes(version);
    let dir = updates.join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = signed_manifest(version, &bytes);
    std::fs::write(dir.join("manifest.update.jws"), &manifest).unwrap();
    std::fs::write(dir.join(installer_name(version)), &bytes).unwrap();
    (manifest, bytes)
}

/// Flip one byte of `path` in place (the size stays).
pub fn flip_byte(path: &Path, at: usize) {
    let mut bytes = std::fs::read(path).unwrap();
    bytes[at] ^= 0x01;
    std::fs::write(path, bytes).unwrap();
}

/// The keyset of the release key with the test key in it (`test-keys`).
pub fn keyset() -> markiro_proto::trust::Keyset {
    markiro_proto::trust::update_keyset()
}
```

В `apps/standalone/host/tests/support/mod.rs` после `pub mod backup;` добавить `pub mod update;`.

Создать `apps/standalone/host/tests/update_store.rs`:

```rust
//! The host's update packages on disk (plan ОБН-3, spec §10.11.2): the start
//! cleans `updates\`, promotes `staged\` of the running version, verifies
//! `current\` whole; a changed file is checked again before it is served;
//! one upload at a time goes through `incoming-<id>.partial\`.

mod support;

use std::path::Path;

use markiro_host::updates::{
    ManifestRefusal, Promotion, Serve, UpdateStore, UploadError, CURRENT, PREVIOUS, STAGED,
};
use markiro_proto::update::distribution::PackageState;
use support::backup::names;
use support::update::{
    flip_byte, installer_bytes, installer_name, keyset, manifest_payload, signed_manifest,
    write_package,
};

fn store(dir: &Path, host: &str) -> UpdateStore {
    UpdateStore::new(dir.join("updates"), keyset(), host)
}

#[test]
fn the_start_removes_strays_and_partial_uploads_and_keeps_the_three_folders() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, CURRENT, "0.3.0");
    write_package(&updates, PREVIOUS, "0.2.0");
    std::fs::create_dir_all(updates.join("incoming-1a2b.partial")).unwrap();
    std::fs::write(updates.join("incoming-1a2b.partial/x.partial"), b"half").unwrap();
    std::fs::write(updates.join("notes.txt"), b"stray").unwrap();
    std::fs::write(updates.join(STAGED), b"a file where a folder belongs").unwrap();
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(names(&updates), [CURRENT, PREVIOUS]);
    assert_eq!(
        (report.promotion, report.current, report.current_version.as_deref()),
        (Promotion::None, PackageState::Ok, Some("0.3.0"))
    );
}

#[test]
fn a_staged_package_of_the_running_version_becomes_current_and_the_current_previous() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    write_package(&updates, CURRENT, "0.2.0");
    write_package(&updates, PREVIOUS, "0.1.0");
    let store = store(dir.path(), "0.3.0");
    let report = store.open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Promoted {
            version: "0.3.0".to_owned(),
            previous: Some("0.2.0".to_owned())
        }
    );
    assert_eq!(names(&updates), [CURRENT, PREVIOUS]);
    assert!(updates.join(CURRENT).join(installer_name("0.3.0")).exists());
    assert!(updates.join(PREVIOUS).join(installer_name("0.2.0")).exists());
    assert_eq!(report.current, PackageState::Ok);
    let status = store.status_blocking();
    assert_eq!(
        (status.version.as_deref(), status.staged, status.previous.as_deref()),
        (Some("0.3.0"), None, Some("0.2.0"))
    );
    let expected = 2 * installer_bytes("0.3.0").len() as u64;
    assert!(status.disk_bytes >= expected, "{}", status.disk_bytes);
}

#[test]
fn a_staged_package_not_newer_than_the_host_goes_and_a_newer_one_waits() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.2.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Stale {
            version: "0.2.0".to_owned()
        }
    );
    assert!(!updates.join(STAGED).exists());

    write_package(&updates, STAGED, "0.4.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Waiting {
            version: "0.4.0".to_owned()
        }
    );
    assert!(updates.join(STAGED).exists());
}

#[test]
fn a_staged_package_that_does_not_check_out_is_removed_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    flip_byte(&updates.join(STAGED).join(installer_name("0.3.0")), 10);
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Failed {
            version: Some("0.3.0".to_owned())
        }
    );
    assert!(!updates.join(STAGED).exists());
    assert_eq!(report.current, PackageState::Missing);
}

#[test]
fn a_current_package_of_another_version_is_a_mismatch_and_a_broken_one_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, CURRENT, "0.2.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        (report.current, report.current_version.as_deref()),
        (PackageState::Mismatch, Some("0.2.0"))
    );
    flip_byte(&updates.join(CURRENT).join("manifest.update.jws"), 30);
    let report = store(dir.path(), "0.2.0").open_blocking().unwrap();
    assert_eq!(report.current, PackageState::Invalid);
}

#[test]
fn a_file_changed_after_the_check_is_checked_again_before_it_is_served() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let (manifest, bytes) = write_package(&updates, CURRENT, "0.3.0");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    match store.serve_blocking() {
        Serve::Ready(package) => {
            assert_eq!(package.manifest_text, manifest.trim());
            assert_eq!(package.size_bytes, bytes.len() as u64);
            assert_eq!(package.kid, "test-upd-1");
        }
        other => panic!("{other:?}"),
    }
    flip_byte(&updates.join(CURRENT).join(installer_name("0.3.0")), 10);
    assert!(matches!(store.serve_blocking(), Serve::Changed));
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Verifying)
    ));
    store.reverify_blocking();
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Invalid)
    ));
}

#[test]
fn a_manifest_is_refused_for_its_signature_product_size_and_form() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path(), "0.3.0").with_max_installer(100_000);
    let bytes = installer_bytes("0.4.0");
    // Over the substitute limit: the installer is a few hundred KiB.
    assert_eq!(
        store
            .check_manifest(&signed_manifest("0.4.0", &bytes))
            .unwrap_err(),
        ManifestRefusal::TooLarge
    );
    let store = store_without_limit(dir.path());
    let good = signed_manifest("0.4.0", &bytes);
    let mut tampered = good.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    assert_eq!(
        store.check_manifest(&tampered).unwrap_err(),
        ManifestRefusal::Signature
    );
    let mut other = manifest_payload("0.4.0", &bytes);
    other["product"] = serde_json::json!("markiro-station");
    let other = markiro_proto::update::distribution::testing::sign_update_manifest(&other);
    assert_eq!(
        store.check_manifest(&other).unwrap_err(),
        ManifestRefusal::WrongProduct
    );
    assert_eq!(
        store.check_manifest("not a manifest").unwrap_err(),
        ManifestRefusal::Malformed
    );
    assert_eq!(
        store.check_manifest(&"x".repeat(64 * 1024 + 1)).unwrap_err(),
        ManifestRefusal::TooLarge
    );
    // A trailing new line, as a file written by hand ends, is no refusal.
    assert!(store.check_manifest(&format!("{good}\n")).is_ok());
}

fn store_without_limit(dir: &Path) -> UpdateStore {
    store(dir, "0.3.0")
}

#[test]
fn one_upload_at_a_time_becomes_staged_and_a_package_not_newer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    let bytes = installer_bytes("0.3.0");
    let same = store
        .check_manifest(&signed_manifest("0.3.0", &bytes))
        .unwrap();
    assert!(matches!(
        store.begin_upload_blocking(same),
        Err(UploadError::NotNewer)
    ));

    let bytes = installer_bytes("0.4.0");
    let first = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    let second = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    assert!(!first.dir.exists(), "a new upload replaces the one before");
    assert!(store.upload(&first.id).is_none());
    std::fs::write(second.partial(), &bytes).unwrap();
    store.finish_upload_blocking(&second.id).unwrap();
    assert_eq!(names(&updates), [STAGED]);
    assert_eq!(
        names(&updates.join(STAGED)),
        ["manifest.update.jws".to_owned(), installer_name("0.4.0")]
    );
    assert!(matches!(
        store.finish_upload_blocking(&second.id),
        Err(UploadError::Unknown)
    ));
    assert_eq!(store.status_blocking().staged.as_deref(), Some("0.4.0"));
}

#[test]
fn an_abandoned_upload_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    let bytes = installer_bytes("0.4.0");
    let upload = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    std::fs::write(upload.partial(), &bytes[..100]).unwrap();
    store.abandon_upload_blocking(&upload.id);
    assert!(names(&updates).is_empty());
}

#[test]
fn the_data_folder_has_an_updates_folder_from_the_first_start() {
    let dir = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(dir.path());
    paths.ensure().unwrap();
    assert_eq!(paths.updates_dir(), dir.path().join("updates"));
    assert!(paths.updates_dir().is_dir());
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_store
```

Ожидается: не собирается (`markiro_host::updates` и `HostPaths::updates_dir` не найдены).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/config.rs`:

Фрагмент:

```rust
    /// The local folder of copies of the database (plan РК).
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    pub fn ensure(&self) -> Result<(), ConfigError> {
        for dir in [
            self.data_dir.clone(),
            self.tls_dir(),
            self.logs_dir(),
            self.backups_dir(),
        ] {
```

заменить на:

```rust
    /// The local folder of copies of the database (plan РК).
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    /// The update packages the host keeps and serves (plan ОБН-3): never in
    /// a copy of the database, never touched by `markiro-host restore`. Its
    /// rights come from the data folder (the installer's ACL).
    pub fn updates_dir(&self) -> PathBuf {
        self.data_dir.join("updates")
    }

    pub fn ensure(&self) -> Result<(), ConfigError> {
        for dir in [
            self.data_dir.clone(),
            self.tls_dir(),
            self.logs_dir(),
            self.backups_dir(),
            self.updates_dir(),
        ] {
```

Правка `apps/standalone/host/src/lib.rs` — фрагмент:

```rust
pub mod tls;
pub mod validate;
```

заменить на:

```rust
pub mod tls;
pub mod updates;
pub mod validate;
```

Создать `apps/standalone/host/src/updates/mod.rs`:

```rust
//! The host's update packages (plan ОБН-3, spec §10.11.2) in `updates\` of
//! the data folder: at most `staged\` (newer than the running host),
//! `current\` (the running host's version: the one devices get),
//! `previous\` (the current before it, for a rollback of the host) and one
//! `incoming-<id>.partial\` upload. Each package folder holds
//! `manifest.update.jws` and the installer under the manifest's name. None of
//! it goes into a copy of the database, and `markiro-host restore` never
//! touches it: the package is no data of the site, and its authenticity
//! rests on its signature, which every device checks itself.

pub mod store;

pub use store::{
    check_manifest, CheckedManifest, FileStamp, ManifestRefusal, Package, Promotion, Serve,
    StartReport, UpdateStore, Upload, UploadError, CURRENT, MANIFEST_FILE, PREVIOUS, STAGED,
};
```

Создать `apps/standalone/host/src/updates/store.rs`:

```rust
//! The package folders and their checks. Every function here is blocking:
//! an async caller goes through `spawn_blocking`.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

use markiro_proto::trust::{self, Keyset, TrustError};
use markiro_proto::update::distribution::{
    HostPackage, PackageState, MAX_INSTALLER_BYTES, MAX_MANIFEST_BYTES,
};
use markiro_proto::update::{hash_exact, installer_name, AppVersion, PRODUCT};

use crate::backup::copy::write_synced;

/// The signed manifest of a package folder.
pub const MANIFEST_FILE: &str = "manifest.update.jws";
pub const STAGED: &str = "staged";
pub const CURRENT: &str = "current";
pub const PREVIOUS: &str = "previous";
const INCOMING_PREFIX: &str = "incoming-";
const PARTIAL: &str = ".partial";

/// A package whose manifest, size and SHA-256 checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    /// The manifest's text as uploaded (trimmed): what a device checks.
    pub manifest_text: String,
    pub version: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kid: String,
    pub installer: PathBuf,
}

/// Size, change time, creation time and, on Unix, the inode of a file: what
/// the host compares before each answer to a download (spec §10.11.2). A
/// file index is not in stable `std` on Windows, where another file renamed
/// into place has another creation time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    pub fn of(path: &Path) -> io::Result<Self> {
        let meta = fs::metadata(path)?;
        Ok(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
            #[cfg(unix)]
            inode: std::os::unix::fs::MetadataExt::ino(&meta),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamps {
    manifest: FileStamp,
    installer: FileStamp,
}

/// A manifest whose signature and fields checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedManifest {
    pub text: String,
    pub version: AppVersion,
    pub installer_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kid: String,
}

/// Why a manifest was refused; the route names it as `details.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestRefusal {
    Malformed,
    UnknownKey,
    Signature,
    WrongProduct,
    TooLarge,
}

/// Check a manifest's text with `keyset`: the signature (of the update type,
/// `markiro_proto::trust`), the product, the version, an installer name a
/// folder can hold, a SHA-256 of 64 lower-case hex digits and a size within
/// `max_installer`.
pub fn check_manifest(
    text: &str,
    keyset: &Keyset,
    max_installer: u64,
) -> Result<CheckedManifest, ManifestRefusal> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestRefusal::TooLarge);
    }
    let text = text.trim();
    let (manifest, kid) =
        trust::verify_update_manifest(text, keyset).map_err(|error| match error {
            TrustError::Malformed => ManifestRefusal::Malformed,
            TrustError::UnknownKey => ManifestRefusal::UnknownKey,
            TrustError::BadSignature => ManifestRefusal::Signature,
        })?;
    if manifest.product != PRODUCT {
        return Err(ManifestRefusal::WrongProduct);
    }
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| ManifestRefusal::Malformed)?;
    let installer = &manifest.installer;
    let hex = installer.sha256.len() == 64
        && installer
            .sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    // The release's own name for the version (plan ОБН-2): never a path.
    if installer.name != installer_name(&version) || !hex || installer.size_bytes == 0 {
        return Err(ManifestRefusal::Malformed);
    }
    if installer.size_bytes > max_installer {
        return Err(ManifestRefusal::TooLarge);
    }
    Ok(CheckedManifest {
        text: text.to_owned(),
        version,
        installer_name: installer.name.clone(),
        sha256: installer.sha256.clone(),
        size_bytes: installer.size_bytes,
        kid,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    Missing,
    Invalid,
}

/// At most one byte more than a manifest may have, as text.
fn read_manifest_file(path: &Path) -> io::Result<String> {
    let mut text = String::new();
    fs::File::open(path)?
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)?;
    Ok(text)
}

/// Verify the package in `dir` whole: the manifest, then the installer's
/// size and SHA-256, the installer unchanged while it was hashed.
fn read_package(
    dir: &Path,
    keyset: &Keyset,
    max_installer: u64,
) -> Result<(Package, Stamps), Fault> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let text = match read_manifest_file(&manifest_path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(Fault::Missing),
        Err(_) => return Err(Fault::Invalid),
    };
    let checked = check_manifest(&text, keyset, max_installer).map_err(|_| Fault::Invalid)?;
    let installer = dir.join(&checked.installer_name);
    let before = FileStamp::of(&installer).map_err(|_| Fault::Invalid)?;
    let file = fs::File::open(&installer).map_err(|_| Fault::Invalid)?;
    // Exactly the manifest's size, in 64 KiB pieces (`markiro_proto::update`, plan ОБН-2).
    let sha256 = hash_exact(file, checked.size_bytes).map_err(|_| Fault::Invalid)?;
    let after = FileStamp::of(&installer).map_err(|_| Fault::Invalid)?;
    if sha256 != checked.sha256 || after != before {
        return Err(Fault::Invalid);
    }
    let manifest = FileStamp::of(&manifest_path).map_err(|_| Fault::Invalid)?;
    Ok((
        Package {
            manifest_text: checked.text,
            version: checked.version.to_string(),
            sha256,
            size_bytes: checked.size_bytes,
            kid: checked.kid,
            installer,
        },
        Stamps {
            manifest,
            installer: before,
        },
    ))
}

/// The version of the package in `dir` when its manifest's signature checks
/// out; the installer is not read.
fn signed_version(dir: &Path, keyset: &Keyset) -> Option<String> {
    let text = read_manifest_file(&dir.join(MANIFEST_FILE)).ok()?;
    check_manifest(&text, keyset, MAX_INSTALLER_BYTES)
        .ok()
        .map(|checked| checked.version.to_string())
}

enum Current {
    Ready(Package, Stamps),
    Verifying,
    Missing,
    Mismatch(String),
    Invalid,
}

/// The one upload in progress (spec §10.11.2: «плюс одна загрузка»).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub id: String,
    pub dir: PathBuf,
    pub manifest: CheckedManifest,
}

impl Upload {
    /// Where the installer is written until it checks out.
    pub fn partial(&self) -> PathBuf {
        self.dir
            .join(format!("{}{PARTIAL}", self.manifest.installer_name))
    }
}

struct Inner {
    current: Current,
    upload: Option<Upload>,
}

/// What the start and each hourly pass did with `staged\` (spec §10.11.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Promotion {
    /// No `staged\`.
    None,
    /// Newer than the running host: it waits for the host's update.
    Waiting { version: String },
    /// Not newer than the running host: removed.
    Stale { version: String },
    Promoted {
        version: String,
        /// The version that moved to `previous\`, when there was a current.
        previous: Option<String>,
    },
    /// It did not check out: removed.
    Failed { version: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartReport {
    pub promotion: Promotion,
    pub current: PackageState,
    pub current_version: Option<String>,
}

/// What [`UpdateStore::serve_blocking`] answers.
#[derive(Debug)]
pub enum Serve {
    Ready(Package),
    /// A file changed since the last full check: the state is `verifying`
    /// until the caller's [`UpdateStore::reverify_blocking`] ends.
    Changed,
    Unavailable(PackageState),
}

#[derive(Debug)]
pub enum UploadError {
    NotNewer,
    Unknown,
    Io(io::Error),
}

pub struct UpdateStore {
    dir: PathBuf,
    keyset: Keyset,
    host_version: String,
    max_installer: u64,
    inner: Mutex<Inner>,
}

impl UpdateStore {
    /// The packages in `dir` of a host running `host_version`, trusting the
    /// release keys of `keyset`.
    pub fn new(dir: PathBuf, keyset: Keyset, host_version: impl Into<String>) -> Self {
        Self {
            dir,
            keyset,
            host_version: host_version.into(),
            max_installer: MAX_INSTALLER_BYTES,
            inner: Mutex::new(Inner {
                current: Current::Missing,
                upload: None,
            }),
        }
    }

    /// Another limit of the installer's size; tests use a small one.
    pub fn with_max_installer(mut self, bytes: u64) -> Self {
        self.max_installer = bytes;
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn host_version(&self) -> &str {
        &self.host_version
    }

    pub fn max_installer(&self) -> u64 {
        self.max_installer
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while the lock was held leaves plain data behind.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The service starts (after the migrations): strays and a partial
    /// upload go, `staged\` of the running version becomes current, and
    /// `current\` is verified whole.
    pub fn open_blocking(&self) -> io::Result<StartReport> {
        fs::create_dir_all(&self.dir)?;
        self.clean();
        let promotion = self.promote_blocking();
        self.reverify_blocking();
        let (current, current_version) = self.current_state();
        Ok(StartReport {
            promotion,
            current,
            current_version,
        })
    }

    /// Everything in `updates\` but the three package folders goes (spec
    /// §10.11.2, «Гигиена диска»).
    fn clean(&self) {
        self.lock().upload = None;
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let folder = entry.file_type().is_ok_and(|kind| kind.is_dir());
            let known = matches!(entry.file_name().to_str(), Some(STAGED | CURRENT | PREVIOUS));
            if !(folder && known) {
                remove_any(&entry.path());
            }
        }
    }

    /// `staged\` of the running version becomes `current\`, the current one
    /// `previous\` (the previous one goes); an older or broken `staged\`
    /// goes; a newer one waits.
    pub fn promote_blocking(&self) -> Promotion {
        let staged = self.dir.join(STAGED);
        if !staged.is_dir() {
            return Promotion::None;
        }
        let package = match read_package(&staged, &self.keyset, self.max_installer) {
            Ok((package, _)) => package,
            Err(_) => {
                let version = signed_version(&staged, &self.keyset);
                remove_any(&staged);
                return Promotion::Failed { version };
            }
        };
        let host = self.host_version.parse::<AppVersion>().ok();
        match (package.version.parse::<AppVersion>().ok(), host) {
            (Some(version), Some(host)) if version > host => Promotion::Waiting {
                version: package.version,
            },
            (Some(version), Some(host)) if version == host => {
                let current = self.dir.join(CURRENT);
                let previous = self.dir.join(PREVIOUS);
                let moved = signed_version(&current, &self.keyset);
                let promoted = (|| -> io::Result<()> {
                    remove_any_io(&previous)?;
                    if current.exists() {
                        fs::rename(&current, &previous)?;
                    }
                    fs::rename(&staged, &current)
                })();
                match promoted {
                    Ok(()) => Promotion::Promoted {
                        version: package.version,
                        previous: moved,
                    },
                    Err(error) => {
                        tracing::warn!(%error, "the staged update package did not become current; the next pass tries again");
                        Promotion::Waiting {
                            version: package.version,
                        }
                    }
                }
            }
            _ => {
                remove_any(&staged);
                Promotion::Stale {
                    version: package.version,
                }
            }
        }
    }

    /// Verify `current\` whole and remember the result.
    pub fn reverify_blocking(&self) {
        let next = match read_package(&self.dir.join(CURRENT), &self.keyset, self.max_installer) {
            Ok((package, stamps)) => {
                let host = self.host_version.parse::<AppVersion>().ok();
                if host.is_some() && package.version.parse::<AppVersion>().ok() == host {
                    Current::Ready(package, stamps)
                } else {
                    Current::Mismatch(package.version)
                }
            }
            Err(Fault::Missing) => Current::Missing,
            Err(Fault::Invalid) => Current::Invalid,
        };
        self.lock().current = next;
    }

    fn current_state(&self) -> (PackageState, Option<String>) {
        match &self.lock().current {
            Current::Ready(package, _) => (PackageState::Ok, Some(package.version.clone())),
            Current::Verifying => (PackageState::Verifying, None),
            Current::Missing => (PackageState::Missing, None),
            Current::Mismatch(version) => (PackageState::Mismatch, Some(version.clone())),
            Current::Invalid => (PackageState::Invalid, None),
        }
    }

    /// The current package for one answer to a device, its files unchanged
    /// since the last full check. A change turns the state to `verifying`.
    pub fn serve_blocking(&self) -> Serve {
        let manifest_path = self.dir.join(CURRENT).join(MANIFEST_FILE);
        let mut inner = self.lock();
        let (package, stamps) = match &inner.current {
            Current::Ready(package, stamps) => (package.clone(), stamps.clone()),
            Current::Verifying => return Serve::Unavailable(PackageState::Verifying),
            Current::Missing => return Serve::Unavailable(PackageState::Missing),
            Current::Mismatch(_) => return Serve::Unavailable(PackageState::Mismatch),
            Current::Invalid => return Serve::Unavailable(PackageState::Invalid),
        };
        let same = FileStamp::of(&package.installer).ok().as_ref() == Some(&stamps.installer)
            && FileStamp::of(&manifest_path).ok().as_ref() == Some(&stamps.manifest);
        if same {
            Serve::Ready(package)
        } else {
            inner.current = Current::Verifying;
            Serve::Changed
        }
    }

    /// The packages as the office sees them.
    pub fn status_blocking(&self) -> HostPackage {
        let (state, version) = self.current_state();
        HostPackage {
            state,
            version,
            staged: signed_version(&self.dir.join(STAGED), &self.keyset),
            previous: signed_version(&self.dir.join(PREVIOUS), &self.keyset),
            disk_bytes: disk_bytes(&self.dir),
        }
    }

    /// [`check_manifest`] with this store's keys and limit.
    pub fn check_manifest(&self, text: &str) -> Result<CheckedManifest, ManifestRefusal> {
        check_manifest(text, &self.keyset, self.max_installer)
    }

    /// Open the upload of a package newer than the running host: its folder
    /// with the manifest. An upload in progress goes first.
    pub fn begin_upload_blocking(&self, manifest: CheckedManifest) -> Result<Upload, UploadError> {
        match self.host_version.parse::<AppVersion>().ok() {
            Some(host) if manifest.version > host => {}
            _ => return Err(UploadError::NotNewer),
        }
        let replaced = self.lock().upload.take();
        if let Some(replaced) = replaced {
            remove_any(&replaced.dir);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.dir.join(format!("{INCOMING_PREFIX}{id}{PARTIAL}"));
        fs::create_dir_all(&self.dir).map_err(UploadError::Io)?;
        fs::create_dir(&dir).map_err(UploadError::Io)?;
        if let Err(error) = write_synced(&dir.join(MANIFEST_FILE), manifest.text.as_bytes()) {
            remove_any(&dir);
            return Err(UploadError::Io(error));
        }
        let upload = Upload { id, dir, manifest };
        self.lock().upload = Some(upload.clone());
        Ok(upload)
    }

    /// The upload of `id`, while it waits for its installer.
    pub fn upload(&self, id: &str) -> Option<Upload> {
        self.lock()
            .upload
            .clone()
            .filter(|upload| upload.id == id)
    }

    fn take_upload(&self, id: &str) -> Option<Upload> {
        let mut inner = self.lock();
        match inner.upload.take() {
            Some(upload) if upload.id == id => Some(upload),
            other => {
                inner.upload = other;
                None
            }
        }
    }

    /// The installer arrived whole and checked: it takes its name, and the
    /// upload's folder replaces `staged\`.
    pub fn finish_upload_blocking(&self, id: &str) -> Result<Upload, UploadError> {
        let upload = self.take_upload(id).ok_or(UploadError::Unknown)?;
        let installed = (|| -> io::Result<()> {
            fs::rename(
                upload.partial(),
                upload.dir.join(&upload.manifest.installer_name),
            )?;
            let staged = self.dir.join(STAGED);
            remove_any_io(&staged)?;
            fs::rename(&upload.dir, &staged)
        })();
        match installed {
            Ok(()) => Ok(upload),
            Err(error) => {
                remove_any(&upload.dir);
                Err(UploadError::Io(error))
            }
        }
    }

    /// A refused or broken upload: its folder goes.
    pub fn abandon_upload_blocking(&self, id: &str) {
        if let Some(upload) = self.take_upload(id) {
            remove_any(&upload.dir);
        }
    }
}

fn remove_any_io(path: &Path) -> io::Result<()> {
    let removed = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn remove_any(path: &Path) {
    if let Err(error) = remove_any_io(path) {
        tracing::warn!(%error, path = %path.display(), "a leftover in updates could not be removed");
    }
}

/// What `updates\` takes: its files and those of its folders.
fn disk_bytes(dir: &Path) -> u64 {
    fn walk(dir: &Path, depth: u8) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match entry.metadata() {
                Ok(meta) if meta.is_dir() && depth > 0 => walk(&entry.path(), depth - 1),
                Ok(meta) if meta.is_file() => meta.len(),
                _ => 0,
            })
            .sum()
    }
    walk(dir, 1)
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_store
```

Ожидается: PASS. Мутации (каждая — FAIL названного теста, файл восстановить): в `promote_blocking` сравнение `version > host` → `version >= host` — FAIL `a_staged_package_of_the_running_version…`; в `serve_blocking` `if same` → `if true` — FAIL `a_file_changed_after_the_check…`; в `clean` убрать `folder &&` — FAIL `the_start_removes_strays…` (файл `staged` остаётся).

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/config.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/updates/mod.rs apps/standalone/host/src/updates/store.rs apps/standalone/host/tests/support/mod.rs apps/standalone/host/tests/support/update.rs apps/standalone/host/tests/update_store.rs
git commit -F /tmp/claude/msg-obn3-2.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the host's update packages on disk (check, clean, promote, upload)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 3: Загрузка пакета из офиса — манифест, установщик потоком, `update.package.stage`

**Files:**

- Create: `apps/standalone/host/src/routes/update_package.rs`, `apps/standalone/host/tests/update_package.rs`
- Modify: `apps/standalone/host/src/server.rs` (`AppState::updates`, `with_updates`, два маршрута), `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/tests/support/app.rs` (`TestApp::keep_updates`, `keep_updates_with`)
- Test: `apps/standalone/host/tests/update_package.rs`

**Interfaces:**

- Consumes: `UpdateStore` (задача 2), `OfficeContext::{require_admin, require_admin_in, actor}`, `ApiJson`, `ApiPath`, `backup::copy::{classify_io, create_private}`, `db::begin_write`.
- Produces: `POST /v1/office/update-package/manifest` → `UpdatePackageUpload`; `PUT /v1/office/update-package/{upload_id}/installer` → `UpdatePackageStaged`; `audit::actions::{UPDATE_PACKAGE_STAGE, UPDATE_PACKAGE_PROMOTE, UPDATE_DOWNLOAD}`; `AppState::updates: Option<Arc<UpdateStore>>`, `AppState::with_updates`; `routes::update_package::{store, MANIFEST_BODY_LIMIT}`.

- [ ] **Step 1: Падающие тесты**

Правка `apps/standalone/host/tests/support/app.rs` — фрагмент:

```rust
    /// The temporary data folder: `host.db` is in it.
    pub fn dir(&self) -> &std::path::Path {
        self._dir.path()
    }
}
```

заменить на:

```rust
    /// The temporary data folder: `host.db` is in it.
    pub fn dir(&self) -> &std::path::Path {
        self._dir.path()
    }

    /// Keep update packages in `<dir>/updates` for a host of `version` (plan
    /// ОБН-3), the test release key trusted, the store started as the
    /// service starts it.
    pub fn keep_updates(&mut self, version: &str) -> Arc<markiro_host::updates::UpdateStore> {
        let store = markiro_host::updates::UpdateStore::new(
            self.dir().join("updates"),
            markiro_proto::trust::update_keyset(),
            version,
        );
        self.keep_updates_with(store)
    }

    /// [`Self::keep_updates`] with a store a test built (a small limit).
    pub fn keep_updates_with(
        &mut self,
        store: markiro_host::updates::UpdateStore,
    ) -> Arc<markiro_host::updates::UpdateStore> {
        store.open_blocking().unwrap();
        let store = Arc::new(store);
        self.state = self.state.clone().with_updates(store.clone());
        store
    }
}
```

Создать `apps/standalone/host/tests/update_package.rs`:

```rust
//! Upload of an update package by an administrator (plan ОБН-3, spec
//! §10.11.2): the signed manifest opens the one upload, the installer comes
//! as a stream of exactly the manifest's size, and the package waits as
//! `staged\`. A refused upload leaves no folder and no audit row.

mod support;

use axum::body::Body;
use axum::http::StatusCode;
use markiro_host::updates::{UpdateStore, CURRENT, STAGED};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, json as json_request, request, with_device, with_session,
    Admin,
};
use support::backup::names;
use support::update::{
    installer_bytes, installer_name, keyset, manifest_payload, sha256_hex, signed_manifest,
};

async fn host_of(version: &str) -> Admin {
    let mut admin = admin().await;
    admin.app.keep_updates(version);
    admin
}

async fn post_manifest(admin: &Admin, token: &str, manifest: &str) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "POST",
            "/v1/office/update-package/manifest",
            Some(json!({ "manifest": manifest })),
        )
        .await
}

/// `PUT …/installer` of `body` with `token`'s session, declaring `length`
/// (no `Content-Length` at all for `None`).
async fn put_installer(
    admin: &Admin,
    token: &str,
    upload_id: &str,
    body: Vec<u8>,
    length: Option<usize>,
) -> (StatusCode, Value) {
    let mut builder = with_session(
        request(
            "PUT",
            &format!("/v1/office/update-package/{upload_id}/installer"),
        ),
        &admin.key,
        token,
    )
    .header("content-type", "application/octet-stream");
    if let Some(length) = length {
        builder = builder.header("content-length", length.to_string());
    }
    admin.app.send(builder.body(Body::from(body)).unwrap()).await
}

fn updates(admin: &Admin) -> std::path::PathBuf {
    admin.app.dir().join("updates")
}

#[tokio::test]
async fn an_administrator_uploads_a_newer_package_and_it_waits_as_staged() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let (status, upload) =
        post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    assert_eq!(
        (&upload["version"], &upload["sizeBytes"], &upload["sha256"]),
        (&json!("0.3.0"), &json!(bytes.len()), &json!(sha256_hex(&bytes)))
    );
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (status, staged) =
        put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    assert_eq!(
        staged,
        json!({ "version": "0.3.0", "sizeBytes": bytes.len(), "sha256": sha256_hex(&bytes) })
    );
    assert_eq!(names(&updates(&admin)), [STAGED]);
    assert_eq!(
        std::fs::read(updates(&admin).join(STAGED).join(installer_name("0.3.0"))).unwrap(),
        bytes
    );
    assert!(!updates(&admin).join(CURRENT).exists(), "a staged package is not served");
    assert_eq!(
        audit_trail(&admin.app, "update.package.stage").await,
        [admin.row(
            "update.package.stage",
            "update_package",
            "0.3.0",
            json!({
                "version": "0.3.0", "sha256": sha256_hex(&bytes),
                "sizeBytes": bytes.len(), "kid": "test-upd-1"
            })
        )]
    );
}

#[tokio::test]
async fn only_an_administrators_session_uploads() {
    let admin = host_of("0.2.0").await;
    let tech = admin.technologist().await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let (status, body) = post_manifest(&admin, &tech, &manifest).await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::FORBIDDEN, &json!("forbidden"))
    );
    // A device key alone never opens an office route.
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/office/update-package/manifest"), &admin.key),
            json!({ "manifest": manifest }),
        ))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "session" }))
    );
    let (_, upload) = post_manifest(&admin, &admin.token, &manifest).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (status, _) = put_installer(&admin, &tech, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(audit_trail(&admin.app, "update.package.stage")
        .await
        .is_empty());
}

#[tokio::test]
async fn a_package_not_newer_than_the_running_host_is_refused() {
    let admin = host_of("0.2.0").await;
    let rows = audit_rows(&admin.app).await;
    for version in ["0.2.0", "0.1.9"] {
        let bytes = installer_bytes(version);
        let (status, body) =
            post_manifest(&admin, &admin.token, &signed_manifest(version, &bytes)).await;
        assert_eq!(
            (status, &body["error"]["details"]),
            (
                StatusCode::CONFLICT,
                &json!({ "constraint": "package_not_newer", "hostVersion": "0.2.0" })
            ),
            "{version}"
        );
    }
    assert!(names(&updates(&admin)).is_empty());
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_manifest_that_does_not_check_out_is_refused_by_its_reason() {
    let mut admin = admin().await;
    admin.app.keep_updates_with(
        UpdateStore::new(admin.app.dir().join("updates"), keyset(), "0.2.0")
            .with_max_installer(100_000),
    );
    let bytes = installer_bytes("0.3.0");
    let good = signed_manifest("0.3.0", &bytes);
    let mut tampered = good.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    let mut station = manifest_payload("0.3.0", &bytes);
    station["product"] = json!("markiro-station");
    let station = markiro_proto::update::distribution::testing::sign_update_manifest(&station);
    for (manifest, reason) in [
        (tampered, "manifest_signature"),
        (station, "wrong_product"),
        ("not a manifest".to_owned(), "manifest_malformed"),
        ("x".repeat(64 * 1024 + 1), "too_large"),
        // The installer is a few hundred KiB, over this host's limit.
        (good, "too_large"),
    ] {
        let (status, body) = post_manifest(&admin, &admin.token, &manifest).await;
        assert_eq!(
            (status, &body["error"]["code"], &body["error"]["details"]),
            (
                StatusCode::BAD_REQUEST,
                &json!("validation_failed"),
                &json!({ "field": "manifest", "reason": reason })
            ),
            "{reason}"
        );
    }
    // Beyond the route's own body limit the request does not even read.
    let (status, body) = post_manifest(&admin, &admin.token, &"x".repeat(80 * 1024)).await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("validation_failed"))
    );
    assert!(names(&updates(&admin)).is_empty());
}

#[tokio::test]
async fn an_installer_of_another_size_or_hash_is_refused_and_leaves_nothing() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let mut longer = bytes.clone();
    longer.push(b'!');
    let mut other = bytes.clone();
    other[100] ^= 0x01;
    let rows = audit_rows(&admin.app).await;
    for (body, length, reason) in [
        (bytes.clone(), None, "size_mismatch"),
        (bytes.clone(), Some(bytes.len() - 1), "size_mismatch"),
        (bytes[..bytes.len() - 1].to_vec(), Some(bytes.len()), "size_mismatch"),
        (longer, Some(bytes.len()), "too_long"),
        (other, Some(bytes.len()), "hash_mismatch"),
    ] {
        let (_, upload) = post_manifest(&admin, &admin.token, &manifest).await;
        let id = upload["uploadId"].as_str().unwrap().to_owned();
        let (status, answer) = put_installer(&admin, &admin.token, &id, body, length).await;
        assert_eq!(
            (status, &answer["error"]["details"]),
            (
                StatusCode::BAD_REQUEST,
                &json!({ "field": "installer", "reason": reason })
            ),
            "{reason}"
        );
        assert!(names(&updates(&admin)).is_empty(), "{reason}: the folder went");
        let (status, answer) =
            put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
        assert_eq!(
            (status, &answer["error"]["details"]["constraint"]),
            (StatusCode::CONFLICT, &json!("upload_unknown")),
            "{reason}: the refused upload is gone"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_new_manifest_replaces_the_upload_in_progress() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let (_, first) = post_manifest(&admin, &admin.token, &manifest).await;
    let (_, second) = post_manifest(&admin, &admin.token, &manifest).await;
    let first = first["uploadId"].as_str().unwrap();
    let second = second["uploadId"].as_str().unwrap();
    let (status, _) =
        put_installer(&admin, &admin.token, first, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) =
        put_installer(&admin, &admin.token, second, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(names(&updates(&admin)), [STAGED]);
}

#[tokio::test]
async fn a_host_without_packages_answers_not_found() {
    let admin = admin().await;
    let (status, body) = post_manifest(&admin, &admin.token, "x").await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::NOT_FOUND, &json!("not_found"))
    );
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_package
```

Ожидается: не собирается (`AppState::with_updates` не найден).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/server.rs`:

Фрагмент 1:

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
    /// The update packages (plan ОБН-3); `None` answers the office's upload
    /// routes `not_found` and a device's offer `missing`. `crate::start`
    /// always sets it.
    pub updates: Option<Arc<crate::updates::UpdateStore>>,
}
```

Фрагмент 2:

```rust
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            clock,
```

заменить на:

```rust
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            updates: None,
            clock,
```

Фрагмент 3:

```rust
    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }
```

заменить на:

```rust
    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }

    /// The update packages the distribution routes serve (plan ОБН-3).
    pub fn with_updates(mut self, updates: Arc<crate::updates::UpdateStore>) -> Self {
        self.updates = Some(updates);
        self
    }
```

Фрагмент 4 (в `protected_routes`):

```rust
        .route(
            "/v1/office/import",
            post(crate::routes::cloud_import::import).layer(axum::extract::DefaultBodyLimit::max(
                crate::routes::cloud_import::MAX_BODY_BYTES,
            )),
        )
```

заменить на:

```rust
        .route(
            "/v1/office/import",
            post(crate::routes::cloud_import::import).layer(axum::extract::DefaultBodyLimit::max(
                crate::routes::cloud_import::MAX_BODY_BYTES,
            )),
        )
        .route(
            "/v1/office/update-package/manifest",
            post(crate::routes::update_package::post_manifest).layer(
                axum::extract::DefaultBodyLimit::max(
                    crate::routes::update_package::MANIFEST_BODY_LIMIT,
                ),
            ),
        )
        // The installer is read as a `Body`, which no `DefaultBodyLimit`
        // limits: the handler holds the manifest's size itself (plan ОБН-3).
        .route(
            "/v1/office/update-package/{upload_id}/installer",
            put(crate::routes::update_package::put_installer),
        )
```

`apps/standalone/host/src/routes/mod.rs`: после `pub mod templates;` добавить `pub mod update_package;`.

Правка `apps/standalone/host/src/audit.rs` (в конец модуля `actions`, после строк ЛЦ-2/ОБН-1/ОБН-2):

```rust
    /// An administrator uploaded an update package; the host keeps it as
    /// `staged\` until it runs that version (plan ОБН-3).
    pub const UPDATE_PACKAGE_STAGE: &str = "update.package.stage";
    /// The host made the staged package current at its start or hourly; at
    /// its start also `failed` for a current package that is not of its
    /// version or does not check out (plan ОБН-3). The host is the actor.
    pub const UPDATE_PACKAGE_PROMOTE: &str = "update.package.promote";
    /// A device began downloading the installer from byte 0; a resumed
    /// download writes none (plan ОБН-3).
    pub const UPDATE_DOWNLOAD: &str = "update.download";
```

Создать `apps/standalone/host/src/routes/update_package.rs`:

```rust
//! Upload of an update package by an administrator (plan ОБН-3, spec
//! §10.11.2). `POST /v1/office/update-package/manifest` checks the signed
//! manifest (the release keys built in, the product, a version newer than
//! the running host, an installer within the limit) and opens the one
//! upload. `PUT /v1/office/update-package/{uploadId}/installer` takes the
//! installer as a stream of exactly the manifest's size (`Content-Length`
//! required and equal), hashes it on the fly, cuts it at the first byte
//! beyond, and makes the package `staged\` with one `update.package.stage`
//! row. The installer never passes the webview: the shell's `update_stage`
//! sends it from the disk. A refused upload changes nothing and writes no
//! row; a refused signature is logged by its code.

use std::io::Write;
use std::sync::Arc;

use aws_lc_rs::digest::{Context, SHA256};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::CONTENT_LENGTH;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use futures_util::StreamExt;
use markiro_proto::codes;
use markiro_proto::update::distribution::{
    constraints, reasons, UpdatePackageManifestRequest, UpdatePackageStaged, UpdatePackageUpload,
    MAX_MANIFEST_BYTES,
};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::backup::copy::{classify_io, create_private};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::updates::{ManifestRefusal, UpdateStore, Upload, UploadError};

/// The manifest route's own body limit: a manifest of 64 KiB in its JSON
/// envelope.
pub const MANIFEST_BODY_LIMIT: usize = MAX_MANIFEST_BYTES + 4 * 1024;

/// The host's packages, or `not_found` on a host that keeps none.
pub fn store(state: &AppState) -> Result<&Arc<UpdateStore>, ApiError> {
    state
        .updates
        .as_ref()
        .ok_or_else(|| ApiError::not_found("this host keeps no update packages"))
}

fn refused(field: &str, reason: &str) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        codes::VALIDATION_FAILED,
        format!("{field}: {reason}"),
    )
    .with_details(json!({ "field": field, "reason": reason }))
}

fn manifest_refused(refusal: ManifestRefusal) -> ApiError {
    let reason = match refusal {
        ManifestRefusal::Malformed => reasons::MANIFEST_MALFORMED,
        ManifestRefusal::UnknownKey => reasons::MANIFEST_UNKNOWN_KEY,
        ManifestRefusal::Signature => reasons::MANIFEST_SIGNATURE,
        ManifestRefusal::WrongProduct => reasons::WRONG_PRODUCT,
        ManifestRefusal::TooLarge => reasons::TOO_LARGE,
    };
    tracing::warn!(reason, "an update manifest was refused");
    refused("manifest", reason)
}

fn io_refused(error: &std::io::Error) -> ApiError {
    if classify_io(error) == markiro_proto::backup::failure::DISK_FULL {
        ApiError::conflict(constraints::DISK_FULL, "the host's disk is full")
    } else {
        ApiError::internal(error)
    }
}

fn upload_refused(error: UploadError, host_version: &str) -> ApiError {
    match error {
        UploadError::NotNewer => ApiError::conflict(
            constraints::PACKAGE_NOT_NEWER,
            "the package is not newer than the running host",
        )
        .with_details(json!({
            "constraint": constraints::PACKAGE_NOT_NEWER,
            "hostVersion": host_version,
        })),
        UploadError::Unknown => {
            ApiError::conflict(constraints::UPLOAD_UNKNOWN, "no upload of this id waits")
        }
        UploadError::Io(error) => io_refused(&error),
    }
}

async fn abandon(store: &Arc<UpdateStore>, id: &str) {
    let store = store.clone();
    let id = id.to_owned();
    let _ = tokio::task::spawn_blocking(move || store.abandon_upload_blocking(&id)).await;
}

pub async fn post_manifest(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(request): ApiJson<UpdatePackageManifestRequest>,
) -> Result<Json<UpdatePackageUpload>, ApiError> {
    context.require_admin()?;
    let store = store(&state)?.clone();
    let checked = store
        .check_manifest(&request.manifest)
        .map_err(manifest_refused)?;
    let opening = store.clone();
    let upload = tokio::task::spawn_blocking(move || opening.begin_upload_blocking(checked))
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| upload_refused(error, store.host_version()))?;
    Ok(Json(UpdatePackageUpload {
        upload_id: upload.id,
        version: upload.manifest.version.to_string(),
        size_bytes: upload.manifest.size_bytes,
        sha256: upload.manifest.sha256,
    }))
}

pub async fn put_installer(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(upload_id): ApiPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<UpdatePackageStaged>, ApiError> {
    context.require_admin()?;
    let store = store(&state)?.clone();
    let upload = store
        .upload(&upload_id)
        .ok_or_else(|| upload_refused(UploadError::Unknown, store.host_version()))?;
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared != Some(upload.manifest.size_bytes) {
        abandon(&store, &upload_id).await;
        return Err(refused("installer", reasons::SIZE_MISMATCH));
    }
    if let Err(error) = receive(&upload, body).await {
        abandon(&store, &upload_id).await;
        return Err(error);
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if let Err(error) = context.require_admin_in(&mut tx).await {
        abandon(&store, &upload_id).await;
        return Err(error);
    }
    let version = upload.manifest.version.to_string();
    audit::record(
        &mut tx,
        &state.timestamp(),
        Entry {
            actor: context.actor(),
            action: actions::UPDATE_PACKAGE_STAGE,
            target_type: Some("update_package"),
            target_id: Some(&version),
            outcome: Outcome::Ok,
            details: json!({
                "version": version,
                "sha256": upload.manifest.sha256,
                "sizeBytes": upload.manifest.size_bytes,
                "kid": upload.manifest.kid,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // The row and the files go together: a failed rename rolls the row back.
    let finishing = store.clone();
    let id = upload_id.clone();
    tokio::task::spawn_blocking(move || finishing.finish_upload_blocking(&id))
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| upload_refused(error, store.host_version()))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(UpdatePackageStaged {
        version,
        size_bytes: upload.manifest.size_bytes,
        sha256: upload.manifest.sha256,
    }))
}

enum Written {
    TooLong,
    Io(std::io::Error),
}

/// The body into the upload's partial file, hashed on the fly: exactly the
/// manifest's size, the manifest's SHA-256. The writing runs on a blocking
/// thread fed by a small channel, so a slow disk slows the client, not the
/// host.
async fn receive(upload: &Upload, body: Body) -> Result<(), ApiError> {
    let size = upload.manifest.size_bytes;
    let path = upload.partial();
    let (chunks, mut queue) = tokio::sync::mpsc::channel::<Bytes>(8);
    let writer = tokio::task::spawn_blocking(move || -> Result<(u64, String), Written> {
        let mut file = create_private(&path, true).map_err(Written::Io)?;
        let mut hash = Context::new(&SHA256);
        let mut written = 0u64;
        while let Some(chunk) = queue.blocking_recv() {
            written += chunk.len() as u64;
            if written > size {
                return Err(Written::TooLong);
            }
            file.write_all(&chunk).map_err(Written::Io)?;
            hash.update(&chunk);
        }
        file.sync_all().map_err(Written::Io)?;
        let hex = hash
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok((written, hex))
    });
    let mut stream = body.into_data_stream();
    let mut cut = false;
    while let Some(frame) = stream.next().await {
        match frame {
            Ok(bytes) => {
                if chunks.send(bytes).await.is_err() {
                    break; // the writer stopped: too long, or the disk
                }
            }
            Err(_) => {
                cut = true;
                break;
            }
        }
    }
    drop(chunks);
    let written = writer.await.map_err(ApiError::internal)?;
    match written {
        Err(Written::TooLong) => Err(refused("installer", reasons::TOO_LONG)),
        Err(Written::Io(error)) => Err(io_refused(&error)),
        Ok(_) if cut => Err(refused("installer", reasons::SIZE_MISMATCH)),
        Ok((written, _)) if written != size => Err(refused("installer", reasons::SIZE_MISMATCH)),
        Ok((_, sha256)) if sha256 != upload.manifest.sha256 => {
            Err(refused("installer", reasons::HASH_MISMATCH))
        }
        Ok(_) => Ok(()),
    }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_package --test update_store
```

Ожидается: PASS. Мутации (FAIL названного теста, файл восстановить): `if written > size` → `if written > size + 1` — FAIL `an_installer_of_another_size…` (`too_long` читается как `hash_mismatch`); строку `context.require_admin()?;` в `put_installer` удалить — FAIL `only_an_administrators_session_uploads`.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/server.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/update_package.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/update_package.rs
git commit -F /tmp/claude/msg-obn3-3.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — an administrator uploads an update package to the host (manifest, streamed installer, update.package.stage)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 4: Старт службы и ежечасный проход — продвижение, полная проверка, `update.package.promote`

**Files:**

- Create: `apps/standalone/host/src/updates/worker.rs`, `apps/standalone/host/tests/update_start.rs`
- Modify: `apps/standalone/host/src/updates/mod.rs`, `apps/standalone/host/src/lib.rs` (`HOST_VERSION`, `start`, `RunningHost`), `apps/standalone/host/src/server.rs` (`hello` через `HOST_VERSION`)
- Test: `apps/standalone/host/tests/update_start.rs`

**Interfaces:**

- Consumes: `UpdateStore::{open_blocking, promote_blocking, reverify_blocking}`, `Promotion`, `StartReport` (задача 2); `audit::{record, actions::UPDATE_PACKAGE_PROMOTE}` (задача 3); `db::begin_write`; `clock::{Clock, format_timestamp}`.
- Produces: `markiro_host::HOST_VERSION`; `updates::worker::{record_start, record_promotion, tick, spawn, PROMOTE_EVERY}`; `start` открывает хранилище после миграций и до первого запроса, пишет строку старта, запускает ежечасный проход; `RunningHost::stop` останавливает его.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/update_start.rs`:

```rust
//! What the start of the service and the hourly pass write about the update
//! packages (plan ОБН-3, spec §10.11.2, §10.11.8): `update.package.promote`
//! `ok` for a promotion, `failed` for a staged package that does not check
//! out and, at the start, for a current one of another version or broken;
//! nothing for no package, a waiting or a stale one.

mod support;

use std::path::Path;
use std::sync::Arc;

use markiro_host::clock::ManualClock;
use markiro_host::updates::{worker, Serve, UpdateStore, CURRENT, STAGED};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use support::app::START;
use support::update::{flip_byte, installer_name, keyset, write_package};

type Row = (String, Option<String>, Option<String>, Option<String>, String, Value);

async fn promote_rows(pool: &SqlitePool) -> Vec<Row> {
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'update.package.promote' ORDER BY id",
        )
        .fetch_all(pool)
        .await
        .unwrap();
    rows.into_iter()
        .map(|(kind, id, target_type, target_id, result, details)| {
            (kind, id, target_type, target_id, result, serde_json::from_str(&details).unwrap())
        })
        .collect()
}

fn row(result: &str, version: Option<&str>, details: Value) -> Row {
    (
        "system".to_owned(),
        None,
        version.map(|_| "update_package".to_owned()),
        version.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

async fn started(dir: &Path, host: &str) -> (SqlitePool, Arc<UpdateStore>) {
    let pool = markiro_host::db::open(&dir.join("host.db")).await.unwrap();
    let store = Arc::new(UpdateStore::new(dir.join("updates"), keyset(), host));
    let report = store.open_blocking().unwrap();
    worker::record_start(&pool, "2026-11-03T06:00:00Z", &report)
        .await
        .unwrap();
    (pool, store)
}

#[tokio::test]
async fn a_promotion_at_the_start_is_one_ok_row_of_the_host() {
    let dir = tempfile::tempdir().unwrap();
    write_package(&dir.path().join("updates"), STAGED, "0.3.0");
    write_package(&dir.path().join("updates"), CURRENT, "0.2.0");
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "ok",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": "0.2.0" })
        )]
    );
}

#[tokio::test]
async fn a_staged_package_that_does_not_check_out_is_a_failed_row() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    flip_byte(&updates.join(STAGED).join(installer_name("0.3.0")), 10);
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "failed",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": null, "reason": "invalid" })
        )]
    );
}

#[tokio::test]
async fn a_current_package_of_another_version_is_a_failed_row_at_the_start() {
    let dir = tempfile::tempdir().unwrap();
    write_package(&dir.path().join("updates"), CURRENT, "0.2.0");
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "failed",
            Some("0.2.0"),
            json!({ "version": "0.2.0", "previous": null, "reason": "mismatch" })
        )]
    );
}

#[tokio::test]
async fn no_package_a_waiting_or_a_stale_one_writes_no_row() {
    for staged in [None, Some("0.4.0"), Some("0.2.0")] {
        let dir = tempfile::tempdir().unwrap();
        if let Some(version) = staged {
            write_package(&dir.path().join("updates"), STAGED, version);
        }
        let (pool, _) = started(dir.path(), "0.3.0").await;
        assert!(promote_rows(&pool).await.is_empty(), "{staged:?}");
    }
}

#[tokio::test]
async fn the_hourly_pass_promotes_what_the_start_could_not_and_serves_it() {
    let dir = tempfile::tempdir().unwrap();
    let (pool, store) = started(dir.path(), "0.3.0").await;
    // A staged package of the running version that a locked file kept back.
    write_package(&dir.path().join("updates"), STAGED, "0.3.0");
    let clock = ManualClock::new(time::OffsetDateTime::from_unix_timestamp(START).unwrap());
    worker::tick(&store, &pool, &clock).await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "ok",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": null })
        )]
    );
    assert!(matches!(store.serve_blocking(), Serve::Ready(_)));
    worker::tick(&store, &pool, &clock).await;
    assert_eq!(promote_rows(&pool).await.len(), 1, "nothing staged: no row");
}

#[test]
fn the_pass_runs_every_hour() {
    assert_eq!(worker::PROMOTE_EVERY, std::time::Duration::from_secs(3600));
    assert_eq!(markiro_host::HOST_VERSION, env!("CARGO_PKG_VERSION"));
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_start
```

Ожидается: не собирается (`updates::worker`, `HOST_VERSION` не найдены).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/updates/mod.rs` — фрагмент:

```rust
pub mod store;
```

заменить на:

```rust
pub mod store;
pub mod worker;
```

Создать `apps/standalone/host/src/updates/worker.rs`:

```rust
//! The host's own work on its packages (plan ОБН-3, spec §10.11.2): the
//! start of the service opens the store (strays out, `staged\` promoted,
//! `current\` verified whole) and writes what it found to the audit log;
//! then every hour the promotion is tried again. The running version does
//! not change while the host runs, so the hourly pass only retries a
//! promotion a locked file held back.

use std::sync::Arc;
use std::time::Duration;

use markiro_proto::update::distribution::PackageState;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::{Promotion, StartReport, UpdateStore};
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::{format_timestamp, Clock};
use crate::db::begin_write;

/// How often the promotion is tried again.
pub const PROMOTE_EVERY: Duration = Duration::from_secs(3600);

type Row = (Outcome, Option<String>, Value);

/// The row of a promotion; none for no package, a waiting or a stale one.
fn promotion_row(promotion: &Promotion) -> Option<Row> {
    match promotion {
        Promotion::Promoted { version, previous } => Some((
            Outcome::Ok,
            Some(version.clone()),
            json!({ "version": version, "previous": previous }),
        )),
        Promotion::Failed { version } => Some((
            Outcome::Failed,
            version.clone(),
            json!({ "version": version, "previous": null, "reason": "invalid" }),
        )),
        Promotion::None | Promotion::Waiting { .. } | Promotion::Stale { .. } => None,
    }
}

/// The row of a start: the promotion's, else one `failed` row for a current
/// package of another version (`mismatch`: a restore from a copy of another
/// version) or one that does not check out (`invalid`).
fn start_row(report: &StartReport) -> Option<Row> {
    promotion_row(&report.promotion).or_else(|| {
        let reason = match report.current {
            PackageState::Mismatch => "mismatch",
            PackageState::Invalid => "invalid",
            _ => return None,
        };
        Some((
            Outcome::Failed,
            report.current_version.clone(),
            json!({ "version": report.current_version, "previous": null, "reason": reason }),
        ))
    })
}

async fn write(pool: &SqlitePool, at: &str, row: Option<Row>) -> Result<(), sqlx::Error> {
    let Some((outcome, version, details)) = row else {
        return Ok(());
    };
    let mut tx = begin_write(pool).await?;
    audit::record(
        &mut tx,
        at,
        Entry {
            actor: Actor::System,
            action: actions::UPDATE_PACKAGE_PROMOTE,
            target_type: version.as_ref().map(|_| "update_package"),
            target_id: version.as_deref(),
            outcome,
            details,
        },
    )
    .await?;
    tx.commit().await
}

/// What the start found, in the audit log.
pub async fn record_start(
    pool: &SqlitePool,
    at: &str,
    report: &StartReport,
) -> Result<(), sqlx::Error> {
    write(pool, at, start_row(report)).await
}

/// What a pass did, in the audit log.
pub async fn record_promotion(
    pool: &SqlitePool,
    at: &str,
    promotion: &Promotion,
) -> Result<(), sqlx::Error> {
    write(pool, at, promotion_row(promotion)).await
}

/// One pass: promote, verify what became current, write the row.
pub async fn tick(store: &Arc<UpdateStore>, pool: &SqlitePool, clock: &dyn Clock) {
    let promoting = store.clone();
    let Ok(promotion) = tokio::task::spawn_blocking(move || {
        let promotion = promoting.promote_blocking();
        if matches!(promotion, Promotion::Promoted { .. }) {
            promoting.reverify_blocking();
        }
        promotion
    })
    .await
    else {
        return;
    };
    if let Err(error) = record_promotion(pool, &format_timestamp(clock.now()), &promotion).await {
        tracing::error!(%error, "the promotion of an update package was not recorded");
    }
}

/// The hourly pass, until `stopping` turns `true`. The start made the first.
pub fn spawn(
    store: Arc<UpdateStore>,
    pool: SqlitePool,
    clock: Arc<dyn Clock>,
    mut stopping: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(PROMOTE_EVERY);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticks.tick().await;
        loop {
            tokio::select! {
                // The `Ref` the wait answers is not `Send`: drop it inside.
                () = async {
                    let _ = stopping.wait_for(|stopping| *stopping).await;
                } => break,
                _ = ticks.tick() => tick(&store, &pool, &*clock).await,
            }
        }
    })
}
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент 1:

```rust
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
```

заменить на:

```rust
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The version this host runs: what `hello` reports and what the update
/// packages are compared with (plan ОБН-3).
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
```

Фрагмент 2 (поле `RunningHost`):

```rust
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
```

заменить на:

```rust
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
    /// The hourly pass over the update packages (plan ОБН-3).
    updates: tokio::task::JoinHandle<()>,
```

Фрагмент 3 (в `RunningHost::stop`):

```rust
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
```

заменить на:

```rust
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
        let mut updates = self.updates;
        if tokio::time::timeout(SHUTDOWN_DEADLINE, &mut updates)
            .await
            .is_err()
        {
            updates.abort();
        }
```

Фрагмент 4 (в `start`, в редакции после ОБН-1, где `clock` объявлен до пула):

```rust
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone());
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
```

заменить на:

```rust
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
    // The update packages (plan ОБН-3): opened after the migrations and
    // before the first request, so a device never gets an unchecked package.
    let packages = std::sync::Arc::new(updates::UpdateStore::new(
        paths.updates_dir(),
        markiro_proto::trust::update_keyset(),
        HOST_VERSION,
    ));
    let opening = packages.clone();
    let opened = tokio::task::spawn_blocking(move || opening.open_blocking()).await??;
    updates::worker::record_start(&pool, &crate::clock::format_timestamp(clock.now()), &opened).await?;
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone())
        .with_updates(packages.clone());
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock.clone(), stopping.subscribe());
    let update_worker =
        updates::worker::spawn(packages, pool.clone(), clock, stopping.subscribe());
```

Фрагмент 5 (конструктор `RunningHost` в конце `start`):

```rust
        backups: backup_worker,
        pool,
```

заменить на:

```rust
        backups: backup_worker,
        updates: update_worker,
        pool,
```

Правка `apps/standalone/host/src/server.rs` (в `hello`):

```rust
        version: env!("CARGO_PKG_VERSION").to_owned(),
```

заменить на:

```rust
        version: crate::HOST_VERSION.to_owned(),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_start --test update_store --test update_package
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
```

Ожидается: PASS, сборка без предупреждений. Вне песочницы — `--test hello --test foundation` (запускают `start` на петле) — PASS: старт открывает пустое `updates\` без строк аудита. Мутация: в `start_row` убрать ветку `PackageState::Mismatch` — FAIL `a_current_package_of_another_version…`.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/updates/mod.rs apps/standalone/host/src/updates/worker.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/update_start.rs
git commit -F /tmp/claude/msg-obn3-4.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the host promotes and verifies its update package at start and hourly (update.package.promote)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 5: Маршруты чтения — `GET /v1/device/update` вне стража протокола и `GET /v1/office/update-status`

**Files:**

- Create: `apps/standalone/host/src/routes/device_update.rs`, `apps/standalone/host/src/routes/update_status.rs`, `apps/standalone/host/tests/update_device.rs`
- Modify: `apps/standalone/host/src/updates/mod.rs` (`serve`), `apps/standalone/host/src/server.rs` (`router`, `update_routes`, маршрут статуса), `apps/standalone/host/src/routes/mod.rs`
- Test: `apps/standalone/host/tests/update_device.rs`, модульный тест `update_status::tests`

**Interfaces:**

- Consumes: `AuthDevice` (с записью версии ОБН-1: вне стража протокол — из заголовка, Д8 ОБН-1), `OfficeContext`, `UpdateStore::{serve_blocking, reverify_blocking, status_blocking}`, `actions::{UPDATE_DOWNLOAD, APP_UPDATE_START, HOST_UPGRADE, UPDATE_PACKAGE_STAGE, UPDATE_PACKAGE_PROMOTE}`, колонки `devices.version_seen_at` (ОБН-1).
- Produces: `updates::serve(&Arc<UpdateStore>) -> Result<Package, PackageState>`; `GET /v1/device/update` → `DeviceUpdateOffer` для любого протокола (и без заголовка) с ключом устройства; `GET /v1/office/update-status` → `OfficeUpdateStatus` (каждая офисная роль); `update_status::{device_state, HISTORY_ROWS}`; `server::update_routes`.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/update_device.rs`:

```rust
//! What devices and the office read about the update (plan ОБН-3, spec
//! §10.11.3, §10.11.7). `GET /v1/device/update` answers any protocol version
//! (and none), outside the protocol guard, but only a live device key; a
//! restore's hold does not hold it. `GET /v1/office/update-status` gives
//! every office role the versions of the devices against the host.

mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use support::app::{admin, empty, pair_device, request, with_device, Admin, TestApp};
use support::update::{flip_byte, installer_name, sha256_hex, write_package};

/// `GET /v1/device/update` with `key` and the protocol header `protocol`
/// (none at all for `None`).
async fn offer(app: &TestApp, key: &str, protocol: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("GET")
        .uri("/v1/device/update")
        .header("authorization", format!("Bearer {key}"));
    if let Some(protocol) = protocol {
        builder = builder.header(markiro_proto::PROTOCOL_HEADER, protocol);
    }
    app.send(builder.body(Body::empty()).unwrap()).await
}

/// A host of `host` with a current package of `current`, if any.
async fn host_with(current: Option<&str>, host: &str) -> Admin {
    let mut admin = admin().await;
    if let Some(version) = current {
        write_package(&admin.app.dir().join("updates"), "current", version);
    }
    admin.app.keep_updates(host);
    admin
}

#[tokio::test]
async fn a_device_reads_the_current_package_of_the_hosts_version() {
    let mut admin = admin().await;
    let (manifest, bytes) = write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    let (status, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "hostVersion": "0.3.0",
            "package": {
                "state": "ok", "manifest": manifest, "version": "0.3.0",
                "sizeBytes": bytes.len(), "sha256": sha256_hex(&bytes)
            }
        })
    );
}

#[tokio::test]
async fn each_state_of_the_package_is_told_and_only_ok_carries_the_manifest() {
    for (current, host, state) in [
        (None, "0.3.0", "missing"),
        (Some("0.2.0"), "0.3.0", "mismatch"),
    ] {
        let admin = host_with(current, host).await;
        let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
        assert_eq!(
            body,
            json!({ "hostVersion": host, "package": { "state": state } }),
            "{state}"
        );
    }
    let mut admin = admin().await;
    let updates = admin.app.dir().join("updates");
    write_package(&updates, "current", "0.3.0");
    flip_byte(&updates.join("current").join(installer_name("0.3.0")), 10);
    admin.app.keep_updates("0.3.0");
    let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(body["package"], json!({ "state": "invalid" }));

    // A file changed after the check: `verifying` at once, then the result.
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let updates = admin.app.dir().join("updates");
    flip_byte(&updates.join("current").join(installer_name("0.3.0")), 10);
    let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(body["package"], json!({ "state": "verifying" }));
    let mut state = Value::Null;
    for _ in 0..200 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        // Past the 30 requests a minute of task 6.
        admin.app.clock.advance(time::Duration::seconds(3));
        state = offer(&admin.app, &admin.key, Some("3")).await.1["package"]["state"].clone();
        if state != json!("verifying") {
            break;
        }
    }
    assert_eq!(state, json!("invalid"));
}

#[tokio::test]
async fn the_offer_answers_any_protocol_but_only_a_live_device_key() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    for protocol in [Some("1"), Some("7"), Some("abc"), None] {
        let (status, body) = offer(&admin.app, &admin.key, protocol).await;
        assert_eq!(
            (status, &body["package"]["state"]),
            (StatusCode::OK, &json!("ok")),
            "{protocol:?}"
        );
    }
    // Every other device route still refuses an unknown protocol.
    let (status, body) = admin
        .app
        .send(empty(
            Request::builder()
                .method("GET")
                .uri("/v1/device")
                .header(markiro_proto::PROTOCOL_HEADER, "7")
                .header("authorization", format!("Bearer {}", admin.key)),
        ))
        .await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("protocol_unsupported"))
    );
    // No key, an office session without a key, a revoked key: 401 on the device.
    let (status, body) = admin
        .app
        .send(empty(request("GET", "/v1/device/update")))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "device" }))
    );
    let (status, _) = admin
        .app
        .send(empty(
            request("GET", "/v1/device/update")
                .header(markiro_proto::OFFICE_SESSION_HEADER, &admin.token),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (station, key) = pair_device(&admin.app, "station").await;
    let (status, _) = admin
        .call("POST", &format!("/v1/office/devices/{station}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = offer(&admin.app, &key, Some("3")).await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "device" }))
    );
}

#[tokio::test]
async fn a_read_outside_the_guard_still_records_the_devices_version() {
    // Plan ОБН-1 (its Д8) records the version on every writing `AuthDevice`
    // and reads the protocol from the header outside the guard (spec §10.11.7).
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let (_, me) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    let id = me["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .app
        .send(empty(
            Request::builder()
                .method("GET")
                .uri("/v1/device/update")
                .header("authorization", format!("Bearer {}", admin.key))
                .header(markiro_proto::PROTOCOL_HEADER, "2")
                .header(markiro_proto::APP_VERSION_HEADER, "0.2.5"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let row: (String, i64, bool) = sqlx::query_as(
        "SELECT app_version, protocol, version_seen_at IS NOT NULL FROM devices WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(row, ("0.2.5".to_owned(), 2, true));
}

#[tokio::test]
async fn a_restore_hold_does_not_hold_the_update() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    sqlx::query("UPDATE site SET facts_held_since = '2026-11-03T06:00:00Z' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!((status, &body["package"]["state"]), (StatusCode::OK, &json!("ok")));
}

#[tokio::test]
async fn a_host_that_keeps_no_packages_offers_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let (status, body) = offer(&app, &key, Some("3")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "hostVersion": markiro_host::HOST_VERSION, "package": { "state": "missing" } })
    );
}

/// Set what the host knows of a device's version, as plan ОБН-1 records it.
async fn version_of(admin: &Admin, id: &str, version: &str, protocol: i64, seen: Option<&str>) {
    sqlx::query(
        "UPDATE devices SET app_version = ?, protocol = ?, version_seen_at = ? WHERE id = ?",
    )
    .bind(version)
    .bind(protocol)
    .bind(seen)
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

async fn audit_insert(admin: &Admin, action: &str, actor: (&str, &str), target: Option<&str>, at: &str, details: Value) {
    sqlx::query(
        "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, result, details) \
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)",
    )
    .bind(at)
    .bind(actor.0)
    .bind(actor.1)
    .bind(action)
    .bind(target.map(|_| "device"))
    .bind(target)
    .bind(details.to_string())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn the_office_reads_every_devices_version_against_the_host() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let (_, me) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    let here = me["id"].as_str().unwrap().to_owned();
    let (behind, _) = pair_device(&admin.app, "station").await;
    let (newer, _) = pair_device(&admin.app, "office").await;
    let (old, _) = pair_device(&admin.app, "station").await;
    let (unknown, _) = pair_device(&admin.app, "station").await;
    let (revoked, _) = pair_device(&admin.app, "station").await;
    admin
        .call("POST", &format!("/v1/office/devices/{revoked}/revoke"), None)
        .await;
    version_of(&admin, &here, "0.3.0", 3, Some("2026-11-03T07:10:00Z")).await;
    version_of(&admin, &behind, "0.2.1", 3, Some("2026-11-02T15:00:00Z")).await;
    version_of(&admin, &newer, "0.4.0", 3, Some("2026-11-03T08:00:00Z")).await;
    // Below the host's minimum protocol: it does not connect.
    version_of(&admin, &old, "0.0.9", 0, Some("2026-10-20T10:00:00Z")).await;
    sqlx::query("UPDATE devices SET line_id = (SELECT id FROM lines WHERE name = 'Линия 1') WHERE id = ?")
        .bind(&here)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    audit_insert(&admin, "update.download", ("device", &behind), None, "2026-11-03T06:55:00Z",
        json!({ "version": "0.3.0", "sha256": "ab", "sizeBytes": 1 })).await;
    audit_insert(&admin, "app.update.start", ("office_user", &admin.id), Some(&behind),
        "2026-11-03T07:00:00Z", json!({ "deviceId": behind, "from": "0.2.1", "to": "0.3.0" })).await;
    // A row that names its device only in the details (Д14).
    audit_insert(&admin, "app.update.start", ("office_user", &admin.id), None,
        "2026-11-03T07:05:00Z", json!({ "deviceId": newer, "from": "0.3.0", "to": "0.4.0" })).await;

    let (status, body) = admin.call("GET", "/v1/office/update-status", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (&body["hostVersion"], &body["protocol"], &body["minProtocol"]),
        (
            &json!("0.3.0"),
            &json!(markiro_proto::PROTOCOL_VERSION),
            &json!(markiro_proto::MIN_PROTOCOL_VERSION)
        )
    );
    assert_eq!(
        (&body["package"]["state"], &body["package"]["version"], &body["package"]["staged"]),
        (&json!("ok"), &json!("0.3.0"), &Value::Null)
    );
    assert!(body["package"]["diskBytes"].as_u64().unwrap() > 0);
    let device = |id: &str| -> Value {
        body["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(device(&revoked), Value::Null, "a revoked device is not listed");
    assert_eq!(body["devices"].as_array().unwrap().len(), 5);
    assert_eq!(
        (&device(&here)["state"], &device(&here)["lineName"]),
        (&json!("current"), &json!("Линия 1"))
    );
    assert_eq!(device(&behind)["state"], json!("behind"));
    assert_eq!(
        device(&behind)["downloaded"],
        json!({ "at": "2026-11-03T06:55:00Z", "version": "0.3.0" })
    );
    assert_eq!(
        device(&behind)["installStarted"],
        json!({ "at": "2026-11-03T07:00:00Z", "version": "0.3.0" })
    );
    assert_eq!(device(&newer)["state"], json!("newer"));
    assert_eq!(
        device(&newer)["installStarted"],
        json!({ "at": "2026-11-03T07:05:00Z", "version": "0.4.0" })
    );
    assert_eq!(device(&old)["state"], json!("incompatible"));
    assert_eq!(
        (&device(&unknown)["state"], &device(&unknown)["versionSeenAt"]),
        (&json!("unknown"), &Value::Null)
    );
    assert_eq!(
        body["history"][0],
        json!({
            "at": "2026-11-03T07:05:00Z", "action": "app.update.start", "result": "ok",
            "actor": "Ирина Смирнова", "version": null, "from": "0.3.0", "to": "0.4.0"
        })
    );
    assert_eq!(body["history"][2]["action"], json!("update.download"));
    assert_eq!(body["history"][2]["actor"], json!("Тестовое устройство"));
}

#[tokio::test]
async fn the_technologist_reads_it_too_and_a_device_key_alone_does_not() {
    let admin = host_with(None, "0.3.0").await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/update-status", None)
        .await;
    assert_eq!((status, &body["package"]["state"]), (StatusCode::OK, &json!("missing")));
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/office/update-status"), &admin.key)))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "session" }))
    );
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_device
```

Ожидается: FAIL — маршруты отвечают `404 not_found`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/updates/mod.rs` — после блока `pub use store::{…};` добавить:

```rust
use std::sync::Arc;

use markiro_proto::update::distribution::PackageState;

/// [`UpdateStore::serve_blocking`] for an async handler: a package whose
/// files changed is checked again in the background, and this answer is
/// `verifying` (spec §10.11.2).
pub async fn serve(store: &Arc<UpdateStore>) -> Result<Package, PackageState> {
    let checking = store.clone();
    match tokio::task::spawn_blocking(move || checking.serve_blocking()).await {
        Ok(Serve::Ready(package)) => Ok(package),
        Ok(Serve::Changed) => {
            let verifying = store.clone();
            tokio::task::spawn_blocking(move || verifying.reverify_blocking());
            Err(PackageState::Verifying)
        }
        Ok(Serve::Unavailable(state)) => Err(state),
        Err(_) => Err(PackageState::Invalid),
    }
}
```

Создать `apps/standalone/host/src/routes/device_update.rs`:

```rust
//! The update routes of devices (plan ОБН-3, spec §10.11.3), outside
//! `protocol_guard`: a device of any protocol version — one the host
//! already refuses as `app_too_old` included — learns of its update and
//! gets it, but only with a live device key (`AuthDevice`); an office
//! session alone opens neither, and the device key opens no office upload.
//! Their answers are frozen like `hello`'s: new fields only additive.
//! `AuthDevice` records the device's version too (plan ОБН-1), so every
//! read keeps «Устройства и версии» current.

use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{DeviceUpdateOffer, OfferedPackage, PackageState};

use crate::auth::AuthDevice;
use crate::error::ApiError;
use crate::server::AppState;

/// `GET /v1/device/update`: the host's version and its current package;
/// the manifest only for `ok`, which the device checks itself.
pub async fn offer(
    State(state): State<AppState>,
    _device: AuthDevice,
) -> Result<Json<DeviceUpdateOffer>, ApiError> {
    let Some(store) = state.updates.as_ref() else {
        return Ok(Json(DeviceUpdateOffer {
            host_version: crate::HOST_VERSION.to_owned(),
            package: OfferedPackage::unavailable(PackageState::Missing),
        }));
    };
    let package = match crate::updates::serve(store).await {
        Ok(package) => OfferedPackage {
            state: PackageState::Ok,
            manifest: Some(package.manifest_text),
            version: Some(package.version),
            size_bytes: Some(package.size_bytes),
            sha256: Some(package.sha256),
        },
        Err(state) => OfferedPackage::unavailable(state),
    };
    Ok(Json(DeviceUpdateOffer {
        host_version: store.host_version().to_owned(),
        package,
    }))
}
```

Создать `apps/standalone/host/src/routes/update_status.rs`:

```rust
//! `GET /v1/office/update-status` (plan ОБН-3, spec §10.11.7; every office
//! role): the host's version and packages, each unrevoked device's version
//! against the host's, its last download (`update.download`) and its last
//! installation (`app.update.start`), and the last rows of the
//! distribution's audit. Reads only; nothing here needs a write lock.

use std::cmp::Ordering;
use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{
    DeviceVersion, DeviceVersionState, HostPackage, OfficeUpdateStatus, PackageState,
    UpdateHistoryItem, UpdateMark,
};
use markiro_proto::update::AppVersion;
use markiro_proto::{DeviceKind, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::audit::actions;
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// How many rows of the distribution's audit the office sees.
pub const HISTORY_ROWS: i64 = 20;

/// A device's version against the host's (spec §10.11.6). A device that
/// never sent its version (`seen` false) is unknown, whatever its pairing
/// recorded.
pub fn device_state(
    host: Option<AppVersion>,
    min_protocol: u32,
    app_version: &str,
    protocol: u32,
    seen: bool,
) -> DeviceVersionState {
    let (Some(host), Some(app), true) = (host, app_version.parse::<AppVersion>().ok(), seen) else {
        return DeviceVersionState::Unknown;
    };
    match app.cmp(&host) {
        Ordering::Equal => DeviceVersionState::Current,
        Ordering::Greater => DeviceVersionState::Newer,
        Ordering::Less if protocol >= min_protocol => DeviceVersionState::Behind,
        Ordering::Less => DeviceVersionState::Incompatible,
    }
}

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    kind: String,
    name: String,
    line_id: Option<String>,
    line_name: Option<String>,
    app_version: String,
    protocol: i64,
    version_seen_at: Option<String>,
    last_seen_at: Option<String>,
}

fn text(details: &Value, key: &str) -> Option<String> {
    details.get(key).and_then(Value::as_str).map(str::to_owned)
}

async fn read_tables(
    conn: &mut SqliteConnection,
    host: Option<AppVersion>,
) -> Result<(Vec<DeviceVersion>, Vec<UpdateHistoryItem>), ApiError> {
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT d.id, d.kind, d.name, d.line_id, l.name AS line_name, d.app_version, \
         d.protocol, d.version_seen_at, d.last_seen_at \
         FROM devices d LEFT JOIN lines l ON l.id = d.line_id \
         WHERE d.revoked_at IS NULL ORDER BY d.kind, d.name, d.id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let marks: Vec<(String, String, Option<String>, Option<String>, String, String)> =
        sqlx::query_as(
            "SELECT action, actor_kind, actor_id, \
             CASE WHEN target_type = 'device' THEN target_id END, at, details \
             FROM audit_log WHERE action IN (?, ?) AND result = 'ok' ORDER BY id",
        )
        .bind(actions::UPDATE_DOWNLOAD)
        .bind(actions::APP_UPDATE_START)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let mut downloaded: HashMap<String, UpdateMark> = HashMap::new();
    let mut started: HashMap<String, UpdateMark> = HashMap::new();
    for (action, actor_kind, actor_id, target_device, at, details) in marks {
        let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
        if action == actions::UPDATE_DOWNLOAD {
            if let (Some(device), "device") = (actor_id, actor_kind.as_str()) {
                let version = text(&details, "version");
                downloaded.insert(device, UpdateMark { at, version });
            }
        } else if let Some(device) = target_device.or_else(|| text(&details, "deviceId")) {
            let version = text(&details, "to");
            started.insert(device, UpdateMark { at, version });
        }
    }
    let devices = rows
        .into_iter()
        .map(|row| {
            let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
            let protocol = u32::try_from(row.protocol).unwrap_or(0);
            let state = device_state(
                host,
                MIN_PROTOCOL_VERSION,
                &row.app_version,
                protocol,
                row.version_seen_at.is_some(),
            );
            Ok(DeviceVersion {
                downloaded: downloaded.remove(&row.id),
                install_started: started.remove(&row.id),
                id: row.id,
                kind,
                name: row.name,
                line_id: row.line_id,
                line_name: row.line_name,
                app_version: row.app_version,
                protocol,
                version_seen_at: row.version_seen_at,
                last_seen_at: row.last_seen_at,
                state,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let history: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT a.at, a.action, a.result, COALESCE(u.name, d.name), a.details \
         FROM audit_log a \
         LEFT JOIN office_users u ON a.actor_kind = 'office_user' AND u.id = a.actor_id \
         LEFT JOIN devices d ON a.actor_kind = 'device' AND d.id = a.actor_id \
         WHERE a.action IN (?, ?, ?, ?, ?) ORDER BY a.id DESC LIMIT ?",
    )
    .bind(actions::HOST_UPGRADE)
    .bind(actions::UPDATE_PACKAGE_STAGE)
    .bind(actions::UPDATE_PACKAGE_PROMOTE)
    .bind(actions::UPDATE_DOWNLOAD)
    .bind(actions::APP_UPDATE_START)
    .bind(HISTORY_ROWS)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let history = history
        .into_iter()
        .map(|(at, action, result, actor, details)| {
            let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
            UpdateHistoryItem {
                version: text(&details, "version"),
                from: text(&details, "from"),
                to: text(&details, "to"),
                at,
                action,
                result,
                actor,
            }
        })
        .collect();
    Ok((devices, history))
}

pub async fn update_status(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeUpdateStatus>, ApiError> {
    let (host_version, package) = match state.updates.as_ref() {
        Some(store) => {
            let reading = store.clone();
            let package = tokio::task::spawn_blocking(move || reading.status_blocking())
                .await
                .map_err(ApiError::internal)?;
            (store.host_version().to_owned(), package)
        }
        None => (
            crate::HOST_VERSION.to_owned(),
            HostPackage {
                state: PackageState::Missing,
                version: None,
                staged: None,
                previous: None,
                disk_bytes: 0,
            },
        ),
    };
    let host = host_version.parse::<AppVersion>().ok();
    // One snapshot for the devices and the audit; nothing is written.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = read_tables(&mut tx, host).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (devices, history) = read?;
    Ok(Json(OfficeUpdateStatus {
        host_version,
        protocol: PROTOCOL_VERSION,
        min_protocol: MIN_PROTOCOL_VERSION,
        package,
        devices,
        history,
    }))
}

#[cfg(test)]
mod tests {
    use markiro_proto::update::distribution::DeviceVersionState;
    use markiro_proto::update::AppVersion;

    use super::device_state;

    #[test]
    fn a_devices_state_follows_the_versions_and_the_protocol_window() {
        let host = "0.3.0".parse::<AppVersion>().ok();
        assert_eq!(device_state(host, 3, "0.3.0", 4, true), DeviceVersionState::Current);
        assert_eq!(device_state(host, 3, "0.2.1", 3, true), DeviceVersionState::Behind);
        assert_eq!(
            device_state(host, 3, "0.1.0", 2, true),
            DeviceVersionState::Incompatible
        );
        assert_eq!(device_state(host, 3, "0.4.0", 4, true), DeviceVersionState::Newer);
        assert_eq!(device_state(host, 3, "0.3.0", 4, false), DeviceVersionState::Unknown);
        assert_eq!(device_state(host, 3, "dev", 4, true), DeviceVersionState::Unknown);
        assert_eq!(device_state(None, 3, "0.3.0", 4, true), DeviceVersionState::Unknown);
    }
}
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент 1:

```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
```

заменить на:

```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .merge(update_routes())
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
```

Фрагмент 2 (перед `/// Routes behind the protocol guard.`):

```rust
/// Routes behind the protocol guard.
fn protected_routes() -> Router<AppState> {
```

заменить на:

```rust
/// The update routes of devices (plan ОБН-3, spec §10.11.3): outside the
/// protocol guard like `hello`, so a device the host refuses as
/// `app_too_old` can still get its update, yet every handler takes
/// `AuthDevice`: no key, no answer. Their shapes are frozen like `hello`'s.
pub fn update_routes() -> Router<AppState> {
    Router::new().route("/v1/device/update", get(crate::routes::device_update::offer))
}

/// Routes behind the protocol guard.
fn protected_routes() -> Router<AppState> {
```

Фрагмент 3 (в `protected_routes`, после маршрутов загрузки пакета задачи 3):

```rust
        .route(
            "/v1/office/update-package/{upload_id}/installer",
            put(crate::routes::update_package::put_installer),
        )
```

заменить на:

```rust
        .route(
            "/v1/office/update-package/{upload_id}/installer",
            put(crate::routes::update_package::put_installer),
        )
        .route(
            "/v1/office/update-status",
            get(crate::routes::update_status::update_status),
        )
```

`apps/standalone/host/src/routes/mod.rs`: добавить `pub mod device_update;` (после `pub mod device_shifts;`) и `pub mod update_status;` (после `pub mod update_package;`).

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_device
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib update_status
```

Ожидается: PASS. Мутации (FAIL названного, файл восстановить): маршрут `/v1/device/update` перенести в `protected_routes` — FAIL `the_offer_answers_any_protocol…` (`"7"` и без заголовка — `protocol_unsupported`); в `device_state` `protocol >= min_protocol` → `protocol > min_protocol` — FAIL модульного теста.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/updates/mod.rs apps/standalone/host/src/routes/device_update.rs apps/standalone/host/src/routes/update_status.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/update_device.rs
git commit -F /tmp/claude/msg-obn3-5.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — a device reads its update outside the protocol guard; the office reads the devices' versions` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 6: Скачивание установщика — `Range`/`If-Range`/`ETag`, поток, ограничители, `update.download`

**Files:**

- Create: `apps/standalone/host/src/updates/stream.rs`, `apps/standalone/host/src/updates/limits.rs`, `apps/standalone/host/tests/update_download.rs`
- Modify: `apps/standalone/host/src/updates/mod.rs`, `apps/standalone/host/src/routes/device_update.rs` (`installer`, ограничитель в `offer`), `apps/standalone/host/src/server.rs` (`AppState::{update_limits, download_stall}`, `with_download_stall`, маршрут в `update_routes`)
- Test: `apps/standalone/host/tests/update_download.rs`, модульные тесты `updates::stream::tests`, `updates::limits::tests`

**Interfaces:**

- Consumes: `updates::serve` (задача 5), `AuthDevice::require_live_in`, `audit::record`, `actions::UPDATE_DOWNLOAD`, `db::begin_write`, `Clock`.
- Produces: `GET /v1/device/update/installer` (вне стража, с ключом устройства): `200`/`206`/`416`/`409 package_unavailable`/`503 package_verifying` (`Retry-After: 5`)/`429 rate_limited`/`503 update_busy` (`Retry-After: 30`); `updates::stream::{file_body, requested_span, Span, Unsatisfiable, CHUNK, STALL_LIMIT}`; `updates::limits::{DownloadLimits, DownloadSlot, Busy, HOST_DOWNLOADS, DEVICE_REQUESTS, BUSY_RETRY_AFTER_SECS}`; `AppState::update_limits`, `AppState::download_stall`, `AppState::with_download_stall`; строка `update.download` с байта 0.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/host/tests/update_download.rs`:

```rust
//! Downloading the installer from the host (plan ОБН-3, spec §10.11.3): the
//! whole file or one range of it, `If-Range` against the package's SHA-256,
//! `416` for a range the file lacks; one download per device, three on the
//! host, 30 requests a minute; exactly one `update.download` row for a
//! download from byte 0 and none for a resumed one or a refusal.

mod support;

use axum::body::Body;
use axum::http::{HeaderMap, Request, Response, StatusCode};
use http_body_util::BodyExt;
use markiro_host::server::router;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, empty, pair_device, request, with_device, Admin, AuditRow, TestApp};
use support::update::{flip_byte, installer_name, sha256_hex, write_package};
use tower::ServiceExt;

/// A host of 0.3.0 that serves its package; the administrator's station and
/// the installer's bytes.
async fn serving() -> (Admin, Vec<u8>) {
    let mut admin = admin().await;
    let (_, bytes) = write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    (admin, bytes)
}

/// `GET /v1/device/update/installer` with `key`, protocol 1 and `headers`;
/// the body is not read, so a held answer holds its download's slot.
async fn open(app: &TestApp, key: &str, headers: &[(&str, &str)]) -> Response<Body> {
    let mut builder = Request::builder()
        .method("GET")
        .uri("/v1/device/update/installer")
        .header("authorization", format!("Bearer {key}"))
        .header(markiro_proto::PROTOCOL_HEADER, "1");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    router(app.state.clone())
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn read(response: Response<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn device_id(app: &TestApp, key: &str) -> String {
    let (_, device) = app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    device["id"].as_str().unwrap().to_owned()
}

fn download_row(device: &str, bytes: &[u8]) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        "update.download".to_owned(),
        Some("update_package".to_owned()),
        Some("0.3.0".to_owned()),
        "ok".to_owned(),
        json!({ "version": "0.3.0", "sha256": sha256_hex(bytes), "sizeBytes": bytes.len() }),
    )
}

#[tokio::test]
async fn the_whole_installer_comes_with_its_etag_and_one_audit_row() {
    let (admin, bytes) = serving().await;
    let device = device_id(&admin.app, &admin.key).await;
    let (status, headers, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, bytes);
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    assert_eq!(
        (
            header(&headers, "content-length"),
            header(&headers, "etag"),
            header(&headers, "accept-ranges"),
            header(&headers, "content-type"),
        ),
        (
            Some(bytes.len().to_string().as_str()),
            Some(etag.as_str()),
            Some("bytes"),
            Some("application/octet-stream"),
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "update.download").await,
        [download_row(&device, &bytes)]
    );
}

#[tokio::test]
async fn a_range_resumes_without_a_row_and_a_range_from_zero_writes_one() {
    let (admin, bytes) = serving().await;
    let device = device_id(&admin.app, &admin.key).await;
    let size = bytes.len();
    for (range, from, to) in [
        ("bytes=100-", 100, size - 1),
        ("bytes=100-199", 100, 199),
        ("bytes=100-99999999", 100, size - 1),
    ] {
        let (status, headers, body) =
            read(open(&admin.app, &admin.key, &[("range", range)]).await).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(body, bytes[from..=to], "{range}");
        assert_eq!(
            header(&headers, "content-range"),
            Some(format!("bytes {from}-{to}/{size}").as_str()),
            "{range}"
        );
    }
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
    let (status, _, body) =
        read(open(&admin.app, &admin.key, &[("range", "bytes=0-99")]).await).await;
    assert_eq!((status, body.len()), (StatusCode::PARTIAL_CONTENT, 100));
    assert_eq!(
        audit_trail(&admin.app, "update.download").await,
        [download_row(&device, &bytes)]
    );
}

#[tokio::test]
async fn if_range_with_another_etag_gives_the_whole_file_again() {
    let (admin, bytes) = serving().await;
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    let (status, _, body) = read(
        open(&admin.app, &admin.key, &[("range", "bytes=100-"), ("if-range", "\"another\"")]).await,
    )
    .await;
    assert_eq!((status, body.len()), (StatusCode::OK, bytes.len()));
    assert_eq!(audit_trail(&admin.app, "update.download").await.len(), 1);
    let (status, _, body) = read(
        open(&admin.app, &admin.key, &[("range", "bytes=100-"), ("if-range", etag.as_str())]).await,
    )
    .await;
    assert_eq!((status, body.len()), (StatusCode::PARTIAL_CONTENT, bytes.len() - 100));
    assert_eq!(audit_trail(&admin.app, "update.download").await.len(), 1);
}

#[tokio::test]
async fn a_range_the_file_lacks_is_416_and_writes_nothing() {
    let (admin, bytes) = serving().await;
    let size = bytes.len();
    let beyond = format!("bytes={size}-");
    for range in [
        beyond.as_str(),
        "bytes=5-1",
        "bytes=0-1,5-6",
        "bytes=-100",
        "items=0-1",
        "bytes=x-",
        "bytes=",
    ] {
        let (status, headers, body) =
            read(open(&admin.app, &admin.key, &[("range", range)]).await).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
        assert_eq!(
            header(&headers, "content-range"),
            Some(format!("bytes */{size}").as_str()),
            "{range}"
        );
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["details"], json!({ "field": "range" }), "{range}");
    }
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn a_package_that_is_not_ok_is_not_served() {
    let mut admin = admin().await;
    admin.app.keep_updates("0.3.0");
    let (status, _, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::CONFLICT, &json!({ "constraint": "package_unavailable" }))
    );

    let (admin, _) = serving().await;
    let current = admin.app.dir().join("updates/current");
    flip_byte(&current.join(installer_name("0.3.0")), 10);
    let (status, headers, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["code"], header(&headers, "retry-after")),
        (StatusCode::SERVICE_UNAVAILABLE, &json!("package_verifying"), Some("5"))
    );
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn one_download_per_device_and_three_on_the_host() {
    let (admin, _) = serving().await;
    let first = open(&admin.app, &admin.key, &[]).await;
    assert_eq!(first.status(), StatusCode::OK);
    let (status, _, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::TOO_MANY_REQUESTS, &json!("rate_limited"))
    );
    let mut held = vec![first];
    for _ in 0..2 {
        let (_, key) = pair_device(&admin.app, "station").await;
        let answer = open(&admin.app, &key, &[]).await;
        assert_eq!(answer.status(), StatusCode::OK);
        held.push(answer);
    }
    let (_, fourth) = pair_device(&admin.app, "station").await;
    let (status, headers, body) = read(open(&admin.app, &fourth, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["code"], header(&headers, "retry-after")),
        (StatusCode::SERVICE_UNAVAILABLE, &json!("update_busy"), Some("30"))
    );
    // A device that went away frees its slot.
    drop(held.remove(0));
    let mut status = StatusCode::SERVICE_UNAVAILABLE;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        admin.app.clock.advance(time::Duration::seconds(3));
        status = open(&admin.app, &fourth, &[]).await.status();
        if status == StatusCode::OK {
            break;
        }
    }
    assert_eq!(status, StatusCode::OK);
}

async fn offer_status(app: &TestApp, key: &str) -> StatusCode {
    app.send(empty(with_device(request("GET", "/v1/device/update"), key)))
        .await
        .0
}

#[tokio::test]
async fn thirty_update_requests_a_minute_per_device() {
    let (admin, _) = serving().await;
    for _ in 0..30 {
        assert_eq!(offer_status(&admin.app, &admin.key).await, StatusCode::OK);
    }
    assert_eq!(
        offer_status(&admin.app, &admin.key).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    let (status, _, _) = read(open(&admin.app, &admin.key, &[]).await).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "both routes count");
    admin.app.clock.advance(time::Duration::seconds(61));
    assert_eq!(offer_status(&admin.app, &admin.key).await, StatusCode::OK);
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn the_download_answers_any_protocol_but_only_a_device_key() {
    let (admin, bytes) = serving().await;
    let answer = router(admin.app.state.clone())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/device/update/installer")
                .header("authorization", format!("Bearer {}", admin.key))
                .header(markiro_proto::PROTOCOL_HEADER, "7")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, _, body) = read(answer).await;
    assert_eq!((status, body.len()), (StatusCode::OK, bytes.len()));
    let (status, _, _) = read(
        router(admin.app.state.clone())
            .oneshot(
                request("GET", "/v1/device/update/installer")
                    .header(markiro_proto::OFFICE_SESSION_HEADER, &admin.token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_download
```

Ожидается: FAIL — `404` на маршруте установщика; `thirty_update_requests…` — 31-й запрос `200`.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/host/src/updates/mod.rs` — фрагмент:

```rust
pub mod store;
pub mod worker;
```

заменить на:

```rust
pub mod limits;
pub mod store;
pub mod stream;
pub mod worker;
```

Создать `apps/standalone/host/src/updates/limits.rs`:

```rust
//! Limits of the update routes (spec §10.11.3): one download per device at
//! a time (a second is `429 rate_limited`), at most [`HOST_DOWNLOADS`] on the
//! host (`503 update_busy` with `Retry-After`), and [`DEVICE_REQUESTS`]
//! requests a minute per device to both routes. Kept by device, not by
//! address (`crate::rate_limit` counts addresses). A refusal writes no row.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::http::StatusCode;
use time::{Duration, OffsetDateTime};

use crate::clock::Clock;
use crate::error::ApiError;

/// Downloads the host serves at once.
pub const HOST_DOWNLOADS: usize = 3;
/// Requests to the update routes a minute per device.
pub const DEVICE_REQUESTS: usize = 30;
/// `Retry-After` of a fourth download.
pub const BUSY_RETRY_AFTER_SECS: u64 = 30;

/// Why a download did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Device,
    Host,
}

pub struct DownloadLimits {
    clock: Arc<dyn Clock>,
    requests: Mutex<HashMap<String, VecDeque<OffsetDateTime>>>,
    active: Mutex<HashSet<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DownloadLimits {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            requests: Mutex::new(HashMap::new()),
            active: Mutex::new(HashSet::new()),
        }
    }

    /// Count one request of `device`; refuse it when its minute is full.
    pub fn check_rate(&self, device: &str) -> Result<(), ApiError> {
        let now = self.clock.now();
        let window = Duration::minutes(1);
        let mut requests = locked(&self.requests);
        requests.retain(|_, seen| {
            while seen.front().is_some_and(|at| *at <= now - window) {
                seen.pop_front();
            }
            !seen.is_empty()
        });
        let seen = requests.entry(device.to_owned()).or_default();
        if seen.len() >= DEVICE_REQUESTS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                markiro_proto::codes::RATE_LIMITED,
                "too many update requests from this device",
            ));
        }
        seen.push_back(now);
        Ok(())
    }

    /// A slot for one download of `device`, held until the slot is dropped.
    pub fn acquire(self: &Arc<Self>, device: &str) -> Result<DownloadSlot, Busy> {
        let mut active = locked(&self.active);
        if active.contains(device) {
            return Err(Busy::Device);
        }
        if active.len() >= HOST_DOWNLOADS {
            return Err(Busy::Host);
        }
        active.insert(device.to_owned());
        Ok(DownloadSlot {
            limits: self.clone(),
            device: device.to_owned(),
        })
    }
}

/// One download in progress; dropping it frees the slot.
pub struct DownloadSlot {
    limits: Arc<DownloadLimits>,
    device: String,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        locked(&self.limits.active).remove(&self.device);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::clock::ManualClock;

    #[test]
    fn a_slot_is_one_per_device_three_per_host_and_free_again_when_dropped() {
        let clock = Arc::new(ManualClock::new(OffsetDateTime::UNIX_EPOCH));
        let limits = Arc::new(DownloadLimits::new(clock));
        let a = limits.acquire("a").unwrap();
        assert_eq!(limits.acquire("a").err(), Some(Busy::Device));
        let _b = limits.acquire("b").unwrap();
        let _c = limits.acquire("c").unwrap();
        assert_eq!(limits.acquire("d").err(), Some(Busy::Host));
        drop(a);
        assert!(limits.acquire("d").is_ok());
    }
}
```

Создать `apps/standalone/host/src/updates/stream.rs`:

```rust
//! The installer as a response body and the range a request asks for (spec
//! §10.11.3). The file is read 64 KiB at a time on a blocking thread and
//! handed over a channel of one piece, never whole in memory; when the
//! client takes nothing for the stall limit the reader gives up, the body
//! ends before its `Content-Length`, and the connection is cut. `Range` and
//! `If-Range` are parsed here: one `bytes=N-` or `bytes=N-M`, nothing else.

use std::io::Read;
use std::time::Duration;

use axum::body::{Body, Bytes};

/// What one read takes from the file.
pub const CHUNK: usize = 64 * 1024;
/// How long the client may take nothing before the download is cut.
pub const STALL_LIMIT: Duration = Duration::from_secs(60);

/// `len` bytes of `file` from where it stands, in pieces of [`CHUNK`].
/// `guard` lives as long as the reader (a download's slot).
pub fn file_body<G: Send + 'static>(
    file: std::fs::File,
    len: u64,
    stall: Duration,
    guard: G,
) -> Body {
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    tokio::spawn(async move {
        let _guard = guard;
        let mut file = file;
        let mut left = len;
        while left > 0 {
            let want = usize::try_from(left.min(CHUNK as u64)).unwrap_or(CHUNK);
            let read = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0u8; want];
                let read = file.read(&mut buffer)?;
                buffer.truncate(read);
                Ok::<_, std::io::Error>((file, buffer))
            })
            .await;
            let (back, buffer) = match read {
                Ok(Ok((back, buffer))) if !buffer.is_empty() => (back, buffer),
                _ => {
                    let _ = sender
                        .send(Err(std::io::Error::other("the installer could not be read")))
                        .await;
                    return;
                }
            };
            file = back;
            left -= buffer.len() as u64;
            match tokio::time::timeout(stall, sender.send(Ok(Bytes::from(buffer)))).await {
                Ok(Ok(())) => {}
                // The client went away, or took nothing for `stall`.
                _ => return,
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
    ))
}

/// The part of the file a request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Span {
    Whole,
    /// `start..=end`, both inside the file.
    Part { start: u64, end: u64 },
}

/// A range the file of that size does not have: `416`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsatisfiable;

/// The span of a file of `size` bytes (`size` > 0) that `range` asks for. An
/// `If-Range` naming another ETag than `etag` asks for the whole file: the
/// package changed, and a device must not resume an old one.
pub fn requested_span(
    range: Option<&str>,
    if_range: Option<&str>,
    etag: &str,
    size: u64,
) -> Result<Span, Unsatisfiable> {
    let Some(range) = range else {
        return Ok(Span::Whole);
    };
    if if_range.is_some_and(|tag| tag.trim() != etag) {
        return Ok(Span::Whole);
    }
    let spec = range.trim().strip_prefix("bytes=").ok_or(Unsatisfiable)?;
    let (first, last) = spec.split_once('-').ok_or(Unsatisfiable)?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if spec.contains(',') || !digits(first) {
        return Err(Unsatisfiable);
    }
    let start: u64 = first.parse().map_err(|_| Unsatisfiable)?;
    let end = if last.is_empty() {
        size - 1
    } else if digits(last) {
        last.parse::<u64>().map_err(|_| Unsatisfiable)?.min(size - 1)
    } else {
        return Err(Unsatisfiable);
    };
    if start >= size || start > end {
        return Err(Unsatisfiable);
    }
    Ok(Span::Part { start, end })
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;

    use super::*;

    const TAG: &str = "\"ab\"";

    #[test]
    fn one_open_or_closed_range_is_read_and_anything_else_is_unsatisfiable() {
        let span = |range: &str| requested_span(Some(range), None, TAG, 1000);
        assert_eq!(requested_span(None, None, TAG, 1000), Ok(Span::Whole));
        assert_eq!(span("bytes=10-"), Ok(Span::Part { start: 10, end: 999 }));
        assert_eq!(span("bytes=10-19"), Ok(Span::Part { start: 10, end: 19 }));
        assert_eq!(span("bytes=0-5000"), Ok(Span::Part { start: 0, end: 999 }));
        for bad in ["bytes=1000-", "bytes=5-1", "bytes=0-1,4-5", "bytes=-10", "x=0-1", "bytes=a-"] {
            assert_eq!(span(bad), Err(Unsatisfiable), "{bad}");
        }
        assert_eq!(
            requested_span(Some("bytes=10-"), Some("\"cd\""), TAG, 1000),
            Ok(Span::Whole)
        );
        assert_eq!(
            requested_span(Some("bytes=10-"), Some(TAG), TAG, 1000),
            Ok(Span::Part { start: 10, end: 999 })
        );
    }

    struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    #[tokio::test]
    async fn a_client_that_takes_nothing_for_the_stall_limit_gets_a_short_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer");
        std::fs::write(&path, vec![7u8; CHUNK * 4]).unwrap();
        let (sender, mut dropped) = tokio::sync::oneshot::channel();
        let mut body = file_body(
            std::fs::File::open(&path).unwrap(),
            (CHUNK * 4) as u64,
            Duration::from_millis(50),
            Dropped(Some(sender)),
        );
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.len(), CHUNK);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut rest = 0;
        while let Some(frame) = body.frame().await {
            rest += frame.unwrap().into_data().unwrap().len();
        }
        assert!(CHUNK + rest < CHUNK * 4, "the reader gave up: {rest}");
        assert!(dropped.try_recv().is_ok(), "the slot went with the reader");
    }

    #[tokio::test]
    async fn a_client_that_reads_gets_every_byte_in_pieces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer");
        let bytes: Vec<u8> = (0..CHUNK * 3 + 17).map(|n| (n % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let body = file_body(
            std::fs::File::open(&path).unwrap(),
            bytes.len() as u64,
            STALL_LIMIT,
            (),
        );
        assert_eq!(body.collect().await.unwrap().to_bytes().to_vec(), bytes);
    }
}
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент 1 (поле после `updates`, задача 3):

```rust
    pub updates: Option<Arc<crate::updates::UpdateStore>>,
}
```

заменить на:

```rust
    pub updates: Option<Arc<crate::updates::UpdateStore>>,
    /// One download per device, three on the host, 30 update requests a
    /// minute per device (plan ОБН-3).
    pub update_limits: Arc<crate::updates::limits::DownloadLimits>,
    /// How long a download waits for the client to take its next piece
    /// (60 s; tests shorten it).
    pub download_stall: Duration,
}
```

Фрагмент 2:

```rust
            backups: None,
            updates: None,
            clock,
```

заменить на:

```rust
            backups: None,
            updates: None,
            update_limits: Arc::new(crate::updates::limits::DownloadLimits::new(clock.clone())),
            download_stall: crate::updates::stream::STALL_LIMIT,
            clock,
```

Фрагмент 3 (после `with_updates`):

```rust
    /// The update packages the distribution routes serve (plan ОБН-3).
    pub fn with_updates(mut self, updates: Arc<crate::updates::UpdateStore>) -> Self {
        self.updates = Some(updates);
        self
    }
```

заменить на:

```rust
    /// The update packages the distribution routes serve (plan ОБН-3).
    pub fn with_updates(mut self, updates: Arc<crate::updates::UpdateStore>) -> Self {
        self.updates = Some(updates);
        self
    }

    /// Another stall limit of a download; tests use a short one.
    pub fn with_download_stall(mut self, stall: Duration) -> Self {
        self.download_stall = stall;
        self
    }
```

Фрагмент 4 (`update_routes`, задача 5):

```rust
    Router::new().route("/v1/device/update", get(crate::routes::device_update::offer))
```

заменить на:

```rust
    Router::new()
        .route("/v1/device/update", get(crate::routes::device_update::offer))
        .route(
            "/v1/device/update/installer",
            get(crate::routes::device_update::installer),
        )
```

Правка `apps/standalone/host/src/routes/device_update.rs`:

Фрагмент 1 (импорты):

```rust
use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{DeviceUpdateOffer, OfferedPackage, PackageState};

use crate::auth::AuthDevice;
use crate::error::ApiError;
use crate::server::AppState;
```

заменить на:

```rust
use std::io::{Seek, SeekFrom};

use axum::extract::State;
use axum::http::header::{
    HeaderName, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE,
    RANGE, RETRY_AFTER,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::codes;
use markiro_proto::update::distribution::{constraints, DeviceUpdateOffer, OfferedPackage, PackageState};
use serde_json::json;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::ApiError;
use crate::server::AppState;
use crate::updates::limits::{Busy, BUSY_RETRY_AFTER_SECS};
use crate::updates::stream::{file_body, requested_span, Span, Unsatisfiable};

/// How soon a device asks again while the host checks its package.
pub const VERIFYING_RETRY_AFTER_SECS: u64 = 5;

fn with_retry_after(error: ApiError, seconds: u64) -> Response {
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from(seconds));
    response
}

fn unavailable() -> ApiError {
    ApiError::conflict(
        constraints::PACKAGE_UNAVAILABLE,
        "the host has no update package to give",
    )
}

fn verifying() -> Response {
    with_retry_after(
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            codes::PACKAGE_VERIFYING,
            "the host checks its update package again",
        ),
        VERIFYING_RETRY_AFTER_SECS,
    )
}
```

Фрагмент 2:

```rust
pub async fn offer(
    State(state): State<AppState>,
    _device: AuthDevice,
) -> Result<Json<DeviceUpdateOffer>, ApiError> {
    let Some(store) = state.updates.as_ref() else {
```

заменить на:

```rust
pub async fn offer(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceUpdateOffer>, ApiError> {
    state.update_limits.check_rate(&device.id)?;
    let Some(store) = state.updates.as_ref() else {
```

В конец файла добавить:

```rust
/// `GET /v1/device/update/installer`: the current package's installer,
/// whole or one range of it (spec §10.11.3). A download from byte 0 writes
/// one `update.download` row; a resumed one writes none.
pub async fn installer(
    State(state): State<AppState>,
    device: AuthDevice,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    state.update_limits.check_rate(&device.id)?;
    let store = state.updates.as_ref().ok_or_else(unavailable)?;
    let package = match crate::updates::serve(store).await {
        Ok(package) => package,
        Err(PackageState::Verifying) => return Ok(verifying()),
        Err(_) => return Err(unavailable()),
    };
    let etag = format!("\"{}\"", package.sha256);
    let header = |name: HeaderName| headers.get(name).and_then(|value| value.to_str().ok());
    let span = match requested_span(header(RANGE), header(IF_RANGE), &etag, package.size_bytes) {
        Ok(span) => span,
        Err(Unsatisfiable) => {
            let mut response = ApiError::new(
                StatusCode::RANGE_NOT_SATISFIABLE,
                codes::VALIDATION_FAILED,
                "the file has no such range",
            )
            .with_details(json!({ "field": "range" }))
            .into_response();
            response.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{}", package.size_bytes))
                    .map_err(ApiError::internal)?,
            );
            return Ok(response);
        }
    };
    let slot = match state.update_limits.acquire(&device.id) {
        Ok(slot) => slot,
        Err(Busy::Device) => {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                codes::RATE_LIMITED,
                "this device downloads the update already",
            ))
        }
        Err(Busy::Host) => {
            return Ok(with_retry_after(
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    codes::UPDATE_BUSY,
                    "three devices download the update already",
                ),
                BUSY_RETRY_AFTER_SECS,
            ))
        }
    };
    let (start, end) = match span {
        Span::Whole => (0, package.size_bytes - 1),
        Span::Part { start, end } => (start, end),
    };
    let path = package.installer.clone();
    let file = tokio::task::spawn_blocking(move || -> std::io::Result<std::fs::File> {
        let mut file = std::fs::File::open(&path)?;
        file.seek(SeekFrom::Start(start))?;
        Ok(file)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|_| unavailable())?;
    if start == 0 {
        let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
        device.require_live_in(&mut tx).await?;
        audit::record(
            &mut tx,
            &state.timestamp(),
            Entry {
                actor: Actor::Device(&device.id),
                action: actions::UPDATE_DOWNLOAD,
                target_type: Some("update_package"),
                target_id: Some(&package.version),
                outcome: Outcome::Ok,
                details: json!({
                    "version": package.version,
                    "sha256": package.sha256,
                    "sizeBytes": package.size_bytes,
                }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        tx.commit().await.map_err(ApiError::internal)?;
    }
    tracing::info!(device = %device.id, start, end, etag = %etag, "an update download began");
    let mut response = Response::builder()
        .status(if span == Span::Whole {
            StatusCode::OK
        } else {
            StatusCode::PARTIAL_CONTENT
        })
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(CONTENT_LENGTH, end - start + 1)
        .header(ETAG, &etag)
        .header(ACCEPT_RANGES, "bytes");
    if span != Span::Whole {
        response = response.header(
            CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", package.size_bytes),
        );
    }
    response
        .body(file_body(file, end - start + 1, state.download_stall, slot))
        .map_err(ApiError::internal)
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_download --test update_device
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib updates::
```

Ожидается: PASS. Мутации (FAIL названного, файл восстановить): `if start == 0` → `if true` — FAIL `a_range_resumes_without_a_row…`; в `requested_span` убрать проверку `If-Range` — FAIL `if_range_with_another_etag…`; в `acquire` `>= HOST_DOWNLOADS` → `> HOST_DOWNLOADS` — FAIL `one_download_per_device_and_three_on_the_host`.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/updates/mod.rs apps/standalone/host/src/updates/limits.rs apps/standalone/host/src/updates/stream.rs apps/standalone/host/src/routes/device_update.rs apps/standalone/host/src/server.rs apps/standalone/host/tests/update_download.rs
git commit -F /tmp/claude/msg-obn3-6.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — a device downloads the installer from the host (ranges, limits, update.download)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 7: Гигиена хоста — копии и восстановление без пакета, журнал без секретов, классификация маршрутов

**Files:**

- Create: `apps/standalone/host/tests/update_hygiene.rs`, `apps/standalone/host/tests/update_logs.rs`
- Modify: таблица классификации маршрутов ЛЦ-2 (модуль найти: `grep -rn "license_restricted" apps/standalone/host/src`), если ЛЦ-2 слит
- Test: `apps/standalone/host/tests/update_hygiene.rs`, `apps/standalone/host/tests/update_logs.rs` (вне песочницы), тест классификации ЛЦ-2

**Interfaces:**

- Consumes: `backup::copy::make_copy`, `restore::restore`, `markiro_host::{start, logging::init, HOST_VERSION}`, `support::pinned_client`.
- Produces: закреплено тестами — копия базы не содержит пакета (`backup/copy.rs` пишет только `<имя>.db`, `<имя>.json` и `<имя>.identity`), `markiro-host restore` не трогает `updates\` (`restore.rs`: шаг 4 переносит файлы базы и идентичность, строки 51–60), журнал службы — без ключа устройства, токена и текста манифеста; пять новых маршрутов — в таблице «никогда» ЛЦ-2.

- [ ] **Step 1: Тесты (код хоста задачами 2–6 уже написан: ожидается PASS, кроме классификации ЛЦ-2)**

Создать `apps/standalone/host/tests/update_hygiene.rs`:

```rust
//! The update package is no data of the site (plan ОБН-3, spec §10.11.2):
//! a copy of the database never holds it, and `markiro-host restore` leaves
//! `updates\` as it was, on the same computer and on a new one.

mod support;

use std::path::{Path, PathBuf};

use markiro_host::backup::copy::make_copy;
use markiro_host::config::HostPaths;
use markiro_host::restore::restore;
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::{ConnectOptions, Connection};
use support::app::{admin, TestApp};
use support::backup::{at, names, worker_conn};
use support::update::{installer_name, write_package};

const NOW: &str = "2026-11-03T06:00:00Z";

async fn copy(app: &TestApp) -> PathBuf {
    let folder = app.dir().join("backups");
    std::fs::create_dir_all(&folder).unwrap();
    let mut conn = worker_conn(app).await;
    let manifest = make_copy(
        &mut conn,
        &folder,
        app.state.now(),
        BackupTrigger::Scheduled,
        &app.state.host_id,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    folder.join(&manifest.file)
}

/// The data folder as a stopped host leaves it (`restore.rs`'s own `stop`).
async fn stop(app: &TestApp) -> HostPaths {
    app.state.pool.close().await;
    let db = app.dir().join("host.db");
    let wal = app.dir().join("host.db-wal");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let mut conn = markiro_host::db::options(&db).connect().await.unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&mut conn)
                .await
                .unwrap();
            conn.close().await.unwrap();
            if !wal.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the database closed");
    std::fs::write(
        app.dir().join("host.json"),
        json!({ "hostId": app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    let paths = HostPaths::new(app.dir());
    paths.ensure().unwrap();
    drop(paths.lock().unwrap());
    paths
}

/// Every file under `dir` with its bytes, in order.
fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    for folder in names(dir) {
        for name in names(&dir.join(&folder)) {
            found.push((format!("{folder}/{name}"), std::fs::read(dir.join(&folder).join(&name)).unwrap()));
        }
    }
    found
}

#[tokio::test]
async fn a_copy_of_the_database_holds_no_package() {
    let mut admin = admin().await;
    write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    copy(&admin.app).await;
    let copies = names(&admin.app.dir().join("backups"));
    assert!(!copies.is_empty());
    assert!(
        copies
            .iter()
            .all(|name| name.ends_with(".db") || name.ends_with(".json")),
        "{copies:?}"
    );
}

#[tokio::test]
async fn a_restore_on_the_same_computer_leaves_the_packages_as_they_were() {
    let mut admin = admin().await;
    let updates = admin.app.dir().join("updates");
    write_package(&updates, "current", "0.3.0");
    write_package(&updates, "staged", "0.4.0");
    admin.app.keep_updates("0.3.0");
    let before = files(&updates);
    let copy_path = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(files(&updates), before);
    assert!(updates.join("current").join(installer_name("0.3.0")).exists());
}

#[tokio::test]
async fn a_restore_on_a_new_computer_brings_no_package() {
    let admin = admin().await;
    let copy_path = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let updates = paths.updates_dir();
    assert!(!updates.exists() || names(&updates).is_empty());
}
```

Создать `apps/standalone/host/tests/update_logs.rs` (свой бинарь: ставит глобальный подписчик журнала):

```rust
//! The process log of the distribution (plan ОБН-3, spec §10.11.3 «Логи»):
//! a download names its device, range and ETag, a refused manifest its
//! reason; never the device key, the session token or a manifest's text.
//! A real host on 127.0.0.1: run outside the sandbox.

mod support;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions, HOST_VERSION};
use markiro_proto::update::AppVersion;
use serde_json::json;
use support::update::{installer_bytes, signed_manifest, write_package};

#[tokio::test]
async fn the_distribution_logs_no_key_token_or_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let (current_manifest, current) = write_package(&paths.updates_dir(), "current", HOST_VERSION);
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let host = start(
        &paths,
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap();
    let base = format!("https://{}", host.addr);
    let client = support::pinned_client(&host.fingerprint);
    let protocol = (
        markiro_proto::PROTOCOL_HEADER,
        markiro_proto::PROTOCOL_VERSION.to_string(),
    );
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
    let wizard: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "inn": "7707083893", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = wizard["session"]["token"].as_str().unwrap().to_owned();

    let whole = client
        .get(format!("{base}/v1/device/update/installer"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.bytes().await.unwrap().to_vec(), current);
    let part = client
        .get(format!("{base}/v1/device/update/installer"))
        .header(protocol.0, &protocol.1)
        .header("range", "bytes=1000-")
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(part.bytes().await.unwrap().len(), current.len() - 1000);

    let host_version: AppVersion = HOST_VERSION.parse().unwrap();
    let newer = AppVersion { minor: host_version.minor + 1, patch: 0, ..host_version }.to_string();
    let bytes = installer_bytes(&newer);
    let manifest = signed_manifest(&newer, &bytes);
    let mut tampered = manifest.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    let refused = client
        .post(format!("{base}/v1/office/update-package/manifest"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "manifest": tampered }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 400);
    let upload: serde_json::Value = client
        .post(format!("{base}/v1/office/update-package/manifest"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "manifest": manifest }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let staged = client
        .put(format!(
            "{base}/v1/office/update-package/{}/installer",
            upload["uploadId"].as_str().unwrap()
        ))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(staged.status(), 200);
    host.stop().await.unwrap();
    drop(guard);

    let mut log = String::new();
    for entry in std::fs::read_dir(paths.logs_dir()).unwrap() {
        log.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(log.contains("an update download began"), "a download is logged");
    assert!(log.contains("manifest_signature"), "a refused manifest names its reason");
    for secret in [
        key.as_str(),
        token.as_str(),
        manifest.as_str(),
        current_manifest.as_str(),
        manifest.rsplit('.').next().unwrap(),
        tampered.as_str(),
    ] {
        assert!(!log.contains(secret), "the log holds {secret:?}");
    }
}
```

Если ЛЦ-2 слит: прогнать его тест классификации маршрутов (`cargo test … -p markiro-host <тест ЛЦ-2>`); он падает, называя `GET /v1/device/update`, `GET /v1/device/update/installer`, `POST /v1/office/update-package/manifest`, `PUT /v1/office/update-package/{upload_id}/installer`, `GET /v1/office/update-status` неклассифицированными.

- [ ] **Step 2: Прогон**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_hygiene
# вне песочницы:
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_logs
```

Ожидается: PASS (код задач 2–6 уже ведёт себя так; тест закрепляет). Если `update_logs` находит секрет в журнале — это дефект задач 3/6: исправить наименьшей правкой и записать в «Отклонения». Мутация: в `manifest_refused` (задача 3) записать в журнал текст манифеста (`tracing::warn!(reason, manifest = %request.manifest, …)` — добавить параметр) — FAIL `the_distribution_logs_no_key…`; восстановить.

- [ ] **Step 3: Классификация маршрутов (ЛЦ-2)**

В таблицу «никогда» ЛЦ-2 (§3.3 спецификации: маршруты, которые ограниченный режим не закрывает) добавить пять маршрутов этого плана: раздача обновления — не открытие смены, а станции вне лицензии всё равно должны уметь обновиться. Тест классификации ЛЦ-2 — PASS. Если ЛЦ-2 к исполнению не слит — шаг пропускается и записывается в «Отклонения» (ЛЦ-2, слившись позже, классифицирует эти маршруты сам: его тест перечисляет маршруты маршрутизатора).

- [ ] **Step 4: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/update_hygiene.rs apps/standalone/host/tests/update_logs.rs
# и файл таблицы ЛЦ-2, если правился
git commit -F /tmp/claude/msg-obn3-7.txt
```

Сообщение: `test(standalone): plan ОБН-3 — no package in a copy or a restore, no secret in the distribution's log` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 8: Оболочка скачивает с хоста — `TransferClient::download`, `update_fetch`, `update_check_manifest`

**Files:**

- Create: `apps/standalone/src-tauri/src/update/fetch.rs`, `apps/standalone/src-tauri/tests/update_fetch.rs`
- Modify: `apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/src-tauri/src/host_client.rs`, `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/update/mod.rs` (ОБН-2), `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Test: `apps/standalone/src-tauri/tests/update_fetch.rs` (вне песочницы), модульные тесты `update::fetch::tests` и `device::tests`, `tests/ipc.rs`

**Interfaces:**

- Consumes: `markiro_proto::update::distribution::{DeviceUpdateOffer, PackageState, MAX_INSTALLER_BYTES}` (задача 1); `markiro_proto::update::{AppVersion, installer_name, hash_exact, PRODUCT}` (ОБН-2); `markiro_proto::trust::{verify_update_manifest, update_keyset, TrustError, UpdateManifestV1}` (ЛЦ-1); `DeviceState::watch_link`, `HostLink::{address, fingerprint, key}`; `pinned_builder` с `default_headers` (ОБН-1).
- Produces: `host_client::{TransferClient, Download, TRANSFER_SILENCE_LIMIT}` (`TransferClient::new`, `download`; `Download::{status, range_start, chunk, into_error}`); `update::fetch::{fetch, check_offer, read_manifest, fits, FetchOptions, FetchError, Fetched, FetchProgress, ManifestView, DownloadsDir, DOWNLOADS, OFFER_PATH, INSTALLER_PATH, PROGRESS_EVENT}`; команды `update_fetch` (`→ { version, manifestPath, sizeBytes }`, отказ — голый код) и `update_check_manifest { manifest }` (`→ ManifestView`); `/v1/device/update/installer` вне `host_request`; состояние `DownloadsDir` в `manage_state`.

- [ ] **Step 1: Фичи зависимостей (Д12)**

Правка `apps/standalone/src-tauri/Cargo.toml`:

Фрагмент 1:

```toml
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
```

заменить на:

```toml
# `stream`: the installer goes to the host as a stream of the file (plan ОБН-3).
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls", "stream"] }
```

Фрагмент 2:

```toml
tokio = { version = "=1.53.1", features = ["sync", "macros", "time"] }
```

заменить на:

```toml
# `fs`, `io-util`: the downloaded installer is written to the disk (plan ОБН-3).
tokio = { version = "=1.53.1", features = ["sync", "macros", "time", "fs", "io-util"] }
```

Фрагмент 3 (в `[dev-dependencies]`, если ОБН-2 этого ещё не сделал):

```toml
markiro-host = { path = "../host" }
```

заменить на:

```toml
markiro-host = { path = "../host" }
# The test release key signs the suites' manifests (plan ОБН-3); never in a release build.
markiro-proto = { path = "../proto", features = ["test-keys"] }
```

Проверка, что замок не меняется:

```bash
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone
git diff --exit-code apps/standalone/Cargo.lock
```

Ожидается: сборка проходит, `Cargo.lock` без изменений. Иначе — остановиться (шаг владельца вне песочницы: `cargo update -p reqwest --precise 0.13.4` не нужен, нужен разбор, что потянула фича) и записать в «Отклонения».

- [ ] **Step 2: Падающие тесты**

Правка `apps/standalone/src-tauri/src/device.rs` (тест `webview_reachable_routes_exclude_pairing_the_line_and_the_stream`):

Фрагмент 1:

```rust
            "/v1/office/sscc/counters/460068200/0?since=1",
        ] {
            assert!(webview_may_reach(route), "{route}");
        }
```

заменить на:

```rust
            "/v1/office/sscc/counters/460068200/0?since=1",
            // The offer is small JSON (plan ОБН-3).
            "/v1/device/update",
        ] {
            assert!(webview_may_reach(route), "{route}");
        }
```

Фрагмент 2:

```rust
            "/v1/changes/stream",
            "/v1/changes/",
            "/v1/changesx",
        ] {
            assert!(!webview_may_reach(route), "{route}");
        }
```

заменить на:

```rust
            "/v1/changes/stream",
            "/v1/changes/",
            "/v1/changesx",
            // Tens of MB never cross IPC: only `update_fetch` reads it (plan ОБН-3).
            "/v1/device/update/installer",
            "/v1/device/update/installer?x=1",
        ] {
            assert!(!webview_may_reach(route), "{route}");
        }
```

Создать `apps/standalone/src-tauri/tests/update_fetch.rs`:

```rust
//! `update_fetch` against a real `markiro-host` on 127.0.0.1 (plan ОБН-3,
//! spec §10.11.4): the package of the host's version into
//! `<local data>/updates/<version>/`, resumed after a break with one
//! `update.download` row in all, started again when the host's package
//! changed, refused before a byte for a downgrade. Outside the sandbox.

use std::path::Path;
use std::sync::{Arc, Mutex};

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions, HOST_VERSION};
use markiro_proto::update::distribution::testing::sign_update_manifest;
use markiro_standalone_lib::device::{DeviceState, HostLink};
use markiro_standalone_lib::host_client::TransferClient;
use markiro_standalone_lib::update::fetch::{fetch, FetchError, FetchOptions, INSTALLER_PATH};
use serde_json::json;
use sqlx::ConnectOptions;

fn installer(version: &str, tag: &str) -> Vec<u8> {
    format!("MZ {tag} installer {version}\n")
        .repeat(10_000)
        .into_bytes()
}

fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// A current package of `version` with `bytes` in the host's data folder.
fn seed(dir: &Path, version: &str, bytes: &[u8]) {
    let current = HostPaths::new(dir).updates_dir().join("current");
    std::fs::create_dir_all(&current).unwrap();
    let size = bytes.len() as u64;
    let sha256 = markiro_proto::update::hash_exact(bytes, size).unwrap();
    let manifest = sign_update_manifest(&json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": { "name": installer_name(version), "sha256": sha256, "sizeBytes": size },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.0.1", "notes": ["Тест"]
    }));
    std::fs::write(current.join("manifest.update.jws"), manifest).unwrap();
    std::fs::write(current.join(installer_name(version)), bytes).unwrap();
}

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

/// A station paired over loopback; a download needs no wizard.
async fn station(host: &RunningHost, dir: &Path) -> Arc<HostLink> {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&format!("https://{}", host.addr), "Станция", "0.0.1")
        .await
        .unwrap();
    let link = station.watch_link().borrow().clone();
    link.unwrap()
}

fn options<'a>(downloads: &'a Path, own: &'a str, stop_after: Option<u64>) -> FetchOptions<'a> {
    FetchOptions {
        own_version: own,
        downloads,
        stop_after,
    }
}

fn quiet(_: u64, _: u64) {}

/// The `update.download` rows of a stopped host.
async fn download_rows(dir: &Path) -> i64 {
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(dir.join("host.db"))
        .connect()
        .await
        .unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'update.download'")
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_station_downloads_the_hosts_package_and_names_its_manifest() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "first");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    std::fs::create_dir_all(downloads.join("0.0.5")).unwrap();
    let seen = Mutex::new(Vec::new());
    let fetched = fetch(&link, options(&downloads, "0.0.1", None), &|received, total| {
        seen.lock().unwrap().push((received, total))
    })
    .await
    .unwrap();
    let dir = downloads.join(HOST_VERSION);
    assert_eq!(fetched.version, HOST_VERSION);
    assert_eq!(
        fetched.manifest_path,
        dir.join(format!("markiro-standalone-{HOST_VERSION}.update.jws"))
            .display()
            .to_string()
    );
    assert_eq!(std::fs::read(dir.join(installer_name(HOST_VERSION))).unwrap(), bytes);
    assert!(!downloads.join("0.0.5").exists(), "another version's download went");
    let total = bytes.len() as u64;
    assert_eq!(seen.lock().unwrap().last(), Some(&(total, total)));
    host.stop().await.unwrap();
    assert_eq!(download_rows(host_dir.path()).await, 1);
}

#[tokio::test]
async fn a_broken_download_resumes_where_it_stopped_with_one_audit_row() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "resume");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    let first = fetch(&link, options(&downloads, "0.0.1", Some(70_000)), &quiet).await;
    assert_eq!(first.unwrap_err(), FetchError::Interrupted);
    let partial = downloads
        .join(HOST_VERSION)
        .join(format!("{}.partial", installer_name(HOST_VERSION)));
    let kept = std::fs::metadata(&partial).unwrap().len();
    assert!(kept >= 70_000 && kept < bytes.len() as u64, "{kept}");
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(downloads.join(HOST_VERSION).join(installer_name(HOST_VERSION))).unwrap(),
        bytes
    );
    assert!(!partial.exists());
    host.stop().await.unwrap();
    assert_eq!(download_rows(host_dir.path()).await, 1, "a resumed download writes no row");
}

#[tokio::test]
async fn a_package_that_changed_between_attempts_is_downloaded_again_whole() {
    let host_dir = tempfile::tempdir().unwrap();
    seed(host_dir.path(), HOST_VERSION, &installer(HOST_VERSION, "old"));
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    let first = fetch(&link, options(&downloads, "0.0.1", Some(70_000)), &quiet).await;
    assert_eq!(first.unwrap_err(), FetchError::Interrupted);
    let fresh = installer(HOST_VERSION, "new");
    seed(host_dir.path(), HOST_VERSION, &fresh);
    let mut result = fetch(&link, options(&downloads, "0.0.1", None), &quiet).await;
    for _ in 0..50 {
        if result != Err(FetchError::Verifying) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        result = fetch(&link, options(&downloads, "0.0.1", None), &quiet).await;
    }
    result.unwrap();
    assert_eq!(
        std::fs::read(downloads.join(HOST_VERSION).join(installer_name(HOST_VERSION))).unwrap(),
        fresh
    );
    // The host itself answers an old ETag with the whole file.
    let client = TransferClient::new(&link.address, &link.fingerprint).unwrap();
    let answer = client
        .download(INSTALLER_PATH, link.key(), Some((100, "\"another\"")))
        .await
        .unwrap();
    assert_eq!(answer.status(), 200);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_whole_file_that_is_not_the_manifests_is_removed_and_fetched_again() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "hash");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    // A whole partial file one byte off (a disk error, a hand): never installed.
    let dir = downloads.join(HOST_VERSION);
    let target = dir.join(installer_name(HOST_VERSION));
    let partial = dir.join(format!("{}.partial", installer_name(HOST_VERSION)));
    let mut broken = std::fs::read(&target).unwrap();
    broken[10] ^= 0x01;
    std::fs::remove_file(&target).unwrap();
    std::fs::write(&partial, &broken).unwrap();
    assert_eq!(
        fetch(&link, options(&downloads, "0.0.1", None), &quiet)
            .await
            .unwrap_err(),
        FetchError::HashMismatch
    );
    assert!(!partial.exists() && !target.exists());
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn no_downgrade_and_no_package_download_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    seed(host_dir.path(), HOST_VERSION, &installer(HOST_VERSION, "same"));
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    assert_eq!(
        fetch(&link, options(&downloads, HOST_VERSION, None), &quiet)
            .await
            .unwrap_err(),
        FetchError::NotNewer
    );
    assert!(!downloads.exists(), "nothing was written");
    host.stop().await.unwrap();
    assert_eq!(download_rows(host_dir.path()).await, 0);

    let empty_dir = tempfile::tempdir().unwrap();
    let host = start_host(empty_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    assert_eq!(
        fetch(&link, options(&app_dir.path().join("updates"), "0.0.1", None), &quiet)
            .await
            .unwrap_err(),
        FetchError::Unavailable
    );
    host.stop().await.unwrap();
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1 (в `mock_app_with`):

```rust
        .manage(ConnectionState::default())
        .manage(SystemAwakeState::default())
```

заменить на:

```rust
        .manage(ConnectionState::default())
        .manage(SystemAwakeState::default())
        .manage(markiro_standalone_lib::update::fetch::DownloadsDir(
            std::env::temp_dir().join("markiro-ipc-updates"),
        ))
```

Фрагмент 2 (в тесте `manage_state`, после `OfficeFilesState`):

```rust
    assert!(app.try_state::<OfficeFilesState>().is_some());
```

заменить на:

```rust
    assert!(app.try_state::<OfficeFilesState>().is_some());
    assert!(app
        .try_state::<markiro_standalone_lib::update::fetch::DownloadsDir>()
        .is_some());
```

Фрагмент 3 (в тесте `an_unpaired_device_reports_null_and_refuses_host_requests`, перед закрывающей скобкой теста, после проверки `/v1/local-pair`):

```rust
        Err(json!("invalid_request"))
    );
}
```

заменить на (первое вхождение — в этом тесте):

```rust
        Err(json!("invalid_request"))
    );
    // Plan ОБН-3: the installer never crosses IPC, and an unpaired device
    // downloads nothing.
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("GET", "/v1/device/update/installer", Value::Null, None)
        ),
        Err(json!("invalid_request"))
    );
    assert_eq!(
        invoke(&webview, "update_fetch", json!({})),
        Err(json!("not_paired"))
    );
    assert_eq!(
        invoke(&webview, "update_check_manifest", json!({ "manifest": "not.a.jws" })),
        Err(json!("manifest_malformed"))
    );
    let manifest = markiro_proto::update::distribution::testing::sign_update_manifest(&json!({
        "v": 1, "product": "markiro-standalone", "version": "0.3.0", "channel": "beta",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": {
            "name": "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
            "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
            "sizeBytes": 22
        },
        "protocol": 4, "minProtocol": 3, "minUpgradeFrom": "0.2.0", "notes": ["Тест"]
    }));
    assert_eq!(
        invoke(&webview, "update_check_manifest", json!({ "manifest": manifest })),
        Ok(json!({
            "version": "0.3.0", "channel": "beta", "releasedAt": "2026-11-02T10:00:00Z",
            "notes": ["Тест"], "minUpgradeFrom": "0.2.0", "protocol": 4, "minProtocol": 3,
            "sizeBytes": 22
        }))
    );
}
```

- [ ] **Step 3: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib device::
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc
```

Ожидается: модульный тест `device` — FAIL (`/v1/device/update/installer` проходит); `ipc` и `update_fetch` не собираются (`update::fetch` не найден).

- [ ] **Step 4: Реализация**

Правка `apps/standalone/src-tauri/src/host_client.rs`:

Фрагмент 1:

```rust
/// How long a stream may stay silent before the link counts as lost: three
/// missed 15 s heartbeats.
pub const STREAM_SILENCE_LIMIT: Duration = Duration::from_secs(45);
```

заменить на:

```rust
/// How long a stream may stay silent before the link counts as lost: three
/// missed 15 s heartbeats.
pub const STREAM_SILENCE_LIMIT: Duration = Duration::from_secs(45);
/// How long a transfer of the installer may go without a byte before it
/// counts as lost (spec §10.11.4).
pub const TRANSFER_SILENCE_LIMIT: Duration = Duration::from_secs(60);
```

Фрагмент 2 (перед `/// A client builder that trusts only the certificate with `fingerprint`:`):

```rust
/// A client builder that trusts only the certificate with `fingerprint`:
```

заменить на:

```rust
/// Long transfers with the paired host — the installer down
/// (`update_fetch`) and up (`update_stage`, plan ОБН-3) — with the same
/// pinned certificate, headers and path rules as [`PinnedClient`], no limit
/// on the whole exchange, and [`TRANSFER_SILENCE_LIMIT`] of silence.
#[derive(Debug, Clone)]
pub struct TransferClient {
    client: reqwest::Client,
    address: String,
}

/// An answer to a download: its status and headers at once, its body piece
/// by piece.
#[derive(Debug)]
pub struct Download {
    response: reqwest::Response,
}

impl TransferClient {
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .read_timeout(TRANSFER_SILENCE_LIMIT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }

    /// `GET path` with the device key. `resume` asks for the bytes from an
    /// offset, only if the file is still the one of that ETag (`Range`,
    /// `If-Range`); the host answers the whole file otherwise.
    pub async fn download(
        &self,
        path: &str,
        key: &Secret,
        resume: Option<(u64, &str)>,
    ) -> Result<Download, RequestError> {
        validate_path(path)?;
        let mut request = self
            .client
            .get(format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
            .bearer_auth(key.expose());
        if let Some((from, etag)) = resume {
            request = request
                .header(reqwest::header::RANGE, format!("bytes={from}-"))
                .header(reqwest::header::IF_RANGE, etag);
        }
        match request.send().await {
            Ok(response) => Ok(Download { response }),
            Err(error) if is_fingerprint_mismatch(&error) => Err(RequestError::CertificateMismatch),
            Err(_) => Err(RequestError::Unreachable),
        }
    }
}

impl Download {
    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    /// Where a `206` begins (`Content-Range: bytes N-M/S`).
    pub fn range_start(&self) -> Option<u64> {
        self.response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)?
            .to_str()
            .ok()?
            .strip_prefix("bytes ")?
            .split_once('-')?
            .0
            .parse()
            .ok()
    }

    /// The next bytes, `None` at the end. Silence past
    /// [`TRANSFER_SILENCE_LIMIT`] or a dropped connection is an error.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, RequestError> {
        match self.response.chunk().await {
            Ok(chunk) => Ok(chunk.map(|bytes| bytes.to_vec())),
            Err(_) => Err(RequestError::Unreachable),
        }
    }

    /// An answer that is not the file: the host's error, read whole.
    pub async fn into_error(self) -> HostResponse {
        let status = self.status();
        let bytes = self.response.bytes().await.unwrap_or_default();
        HostResponse {
            status,
            body: serde_json::from_slice(&bytes).ok(),
        }
    }
}

/// A client builder that trusts only the certificate with `fingerprint`:
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 1:

```rust
/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned and the name it gave the device.
const DEVICE_ROUTE: &str = "/v1/device";
```

заменить на:

```rust
/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned and the name it gave the device.
const DEVICE_ROUTE: &str = "/v1/device";

/// The update's installer (plan ОБН-3): tens of MB, which only
/// `update_fetch` reads, straight to the disk; never through IPC.
const INSTALLER_ROUTE: &str = "/v1/device/update/installer";
```

Фрагмент 2 (в `webview_may_reach`):

```rust
    let device_route =
        route == "/v1/device" || (route.starts_with("/v1/device/") && route != LINE_ROUTE);
```

заменить на:

```rust
    let device_route = route == "/v1/device"
        || (route.starts_with("/v1/device/") && route != LINE_ROUTE && route != INSTALLER_ROUTE);
```

Документацию `webview_may_reach` дополнить фразой: «The installer of an update goes through `update_fetch` only (plan ОБН-3).»

В `apps/standalone/src-tauri/src/update/mod.rs` (модуль ОБН-2) добавить `pub mod fetch;`.

Создать `apps/standalone/src-tauri/src/update/fetch.rs`:

```rust
//! The host's update package on this device (plan ОБН-3, spec §10.11.4).
//! `update_fetch` reads the offer (`GET /v1/device/update`), checks the
//! manifest with the release keys built in — TLS proves only that our host
//! answered; the signature proves a release of Markiro —, refuses a
//! package not newer than this app, not of the host's version or above
//! this app's `minUpgradeFrom`, and downloads the installer over the pinned
//! connection into `<local data>\updates\<version>\`, resuming after a break
//! (`Range`, `If-Range`), never past the manifest's size, then checks the
//! whole file's SHA-256. One package is kept: another version's goes. The
//! launch is `update_install`'s (plan ОБН-2), which checks the pair again
//! through a handle nobody else may write. `update_check_manifest` checks a
//! manifest's signature for the webview, which shows notes only after it.

use std::path::{Path, PathBuf};

use markiro_proto::trust::{self, TrustError, UpdateManifestV1};
use markiro_proto::update::distribution::{DeviceUpdateOffer, PackageState, MAX_INSTALLER_BYTES};
use markiro_proto::update::{hash_exact, installer_name, AppVersion, PRODUCT};
use serde::Serialize;
use tauri::{Emitter, Manager, Runtime};
use tokio::io::AsyncWriteExt;

use crate::device::{DeviceState, HostLink};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError, TransferClient};

/// The folder of downloads under the app's local data folder.
pub const DOWNLOADS: &str = "updates";
pub const OFFER_PATH: &str = "/v1/device/update";
pub const INSTALLER_PATH: &str = "/v1/device/update/installer";
/// `{ received, total }` while the installer downloads.
pub const PROGRESS_EVENT: &str = "standalone://update-progress";

/// Where `update_fetch` keeps its package (Tauri state).
#[derive(Debug, Clone)]
pub struct DownloadsDir(pub PathBuf);

/// Why a fetch stopped; [`FetchError::code`] is what the webview reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    NotPaired,
    Unreachable,
    CertificateMismatch,
    KeyRejected,
    /// The host has no package to give (`missing`, `mismatch`, `invalid`).
    Unavailable,
    /// The host checks its package again: ask in a moment.
    Verifying,
    /// This device downloads already, or the host serves three others.
    Busy,
    ManifestMalformed,
    ManifestUnknownKey,
    ManifestSignature,
    /// Not newer than this app: no downgrade (spec §10.8).
    NotNewer,
    /// The package is not of the host's version (spec §10.11.4).
    HostMismatch,
    /// This app is older than the manifest's `minUpgradeFrom`.
    NeedsIntermediate,
    /// A byte beyond the manifest's size: the file was removed.
    TooLong,
    /// The whole file is not the manifest's SHA-256: it was removed.
    HashMismatch,
    /// The download broke off; the next fetch resumes it.
    Interrupted,
    /// The file could not be written on this computer.
    Storage,
    /// Any other answer of the host.
    Refused,
}

impl FetchError {
    pub fn code(self) -> &'static str {
        match self {
            FetchError::NotPaired => "not_paired",
            FetchError::Unreachable => "unreachable",
            FetchError::CertificateMismatch => "certificate_mismatch",
            FetchError::KeyRejected => "key_rejected",
            FetchError::Unavailable => "package_unavailable",
            FetchError::Verifying => "package_verifying",
            FetchError::Busy => "update_busy",
            FetchError::ManifestMalformed => "manifest_malformed",
            FetchError::ManifestUnknownKey => "manifest_unknown_key",
            FetchError::ManifestSignature => "manifest_signature",
            FetchError::NotNewer => "not_newer",
            FetchError::HostMismatch => "host_mismatch",
            FetchError::NeedsIntermediate => "needs_intermediate",
            FetchError::TooLong => "too_long",
            FetchError::HashMismatch => "hash_mismatch",
            FetchError::Interrupted => "interrupted",
            FetchError::Storage => "storage",
            FetchError::Refused => "refused",
        }
    }
}

fn request_error(error: RequestError) -> FetchError {
    match error {
        RequestError::CertificateMismatch => FetchError::CertificateMismatch,
        _ => FetchError::Unreachable,
    }
}

/// What a finished fetch gives the webview: the manifest beside the
/// installer, which `update_install` takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub version: String,
    pub manifest_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FetchProgress {
    pub received: u64,
    pub total: u64,
}

/// A checked manifest as the webview shows it (notes as text, never markup).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    pub version: String,
    pub channel: String,
    pub released_at: String,
    pub notes: Vec<String>,
    pub min_upgrade_from: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub size_bytes: u64,
}

impl ManifestView {
    fn of(manifest: &UpdateManifestV1) -> Self {
        Self {
            version: manifest.version.clone(),
            channel: manifest.channel.clone(),
            released_at: manifest.released_at.clone(),
            notes: manifest.notes.clone(),
            min_upgrade_from: manifest.min_upgrade_from.clone(),
            protocol: manifest.protocol,
            min_protocol: manifest.min_protocol,
            size_bytes: manifest.installer.size_bytes,
        }
    }
}

/// The manifest of `text`, checked with `keyset`: the signature, the
/// product, a version and an installer name that can be a file's.
pub fn read_manifest(
    text: &str,
    keyset: &trust::Keyset,
) -> Result<UpdateManifestV1, FetchError> {
    let (manifest, _kid) =
        trust::verify_update_manifest(text.trim(), keyset).map_err(|error| match error {
            TrustError::Malformed => FetchError::ManifestMalformed,
            TrustError::UnknownKey => FetchError::ManifestUnknownKey,
            TrustError::BadSignature => FetchError::ManifestSignature,
        })?;
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    // The release's own name for the version (plan ОБН-2): never a path.
    if manifest.product != PRODUCT || manifest.installer.name != installer_name(&version) {
        return Err(FetchError::ManifestMalformed);
    }
    Ok(manifest)
}

/// The rules of spec §10.11.4 before a byte is downloaded: newer than this
/// app, of the host's version, this app not below `minUpgradeFrom`, a size
/// within the limit.
pub fn check_offer(
    manifest: &UpdateManifestV1,
    host_version: &str,
    own_version: &str,
) -> Result<(), FetchError> {
    let package: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    let own: AppVersion = own_version.parse().map_err(|_| FetchError::Refused)?;
    if package <= own {
        return Err(FetchError::NotNewer);
    }
    if host_version.parse::<AppVersion>().ok() != Some(package) {
        return Err(FetchError::HostMismatch);
    }
    let floor: AppVersion = manifest
        .min_upgrade_from
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    if own < floor {
        return Err(FetchError::NeedsIntermediate);
    }
    let size = manifest.installer.size_bytes;
    if size == 0 || size > MAX_INSTALLER_BYTES {
        return Err(FetchError::ManifestMalformed);
    }
    Ok(())
}

/// Whether `chunk` more bytes after `received` stay within `total`.
pub fn fits(received: u64, chunk: usize, total: u64) -> bool {
    received
        .checked_add(chunk as u64)
        .is_some_and(|sum| sum <= total)
}

/// How a fetch runs. `stop_after` ends an attempt after that many bytes, as
/// a dropped Wi-Fi would — for tests; the app passes `None`.
pub struct FetchOptions<'a> {
    pub own_version: &'a str,
    pub downloads: &'a Path,
    pub stop_after: Option<u64>,
}

fn offer_of(answer: &HostResponse) -> Result<DeviceUpdateOffer, FetchError> {
    match answer.status {
        200 => answer
            .body
            .clone()
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(FetchError::Refused),
        401 => Err(FetchError::KeyRejected),
        429 => Err(FetchError::Busy),
        _ => Err(FetchError::Refused),
    }
}

fn refusal(answer: &HostResponse) -> FetchError {
    let code = answer
        .body
        .as_ref()
        .and_then(|body| body["error"]["code"].as_str());
    match (answer.status, code) {
        (401, _) => FetchError::KeyRejected,
        (409, _) => FetchError::Unavailable,
        (503, Some("package_verifying")) => FetchError::Verifying,
        (503, _) | (429, _) => FetchError::Busy,
        _ => FetchError::Refused,
    }
}

async fn remove_file(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// Everything under `downloads` but `version`'s folder goes; that folder is
/// made.
async fn prepare_dir(downloads: &Path, version: &str) -> Result<PathBuf, FetchError> {
    tokio::fs::create_dir_all(downloads)
        .await
        .map_err(|_| FetchError::Storage)?;
    let mut entries = tokio::fs::read_dir(downloads)
        .await
        .map_err(|_| FetchError::Storage)?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_name().to_str() == Some(version) {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
    }
    let dir = downloads.join(version);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| FetchError::Storage)?;
    Ok(dir)
}

/// Whether the file at `path` is exactly `total` bytes of `sha256`
/// (`markiro_proto::update::hash_exact`, plan ОБН-2).
async fn matches_manifest(path: &Path, total: u64, sha256: &str) -> bool {
    let path = path.to_path_buf();
    let hashed = tauri::async_runtime::spawn_blocking(move || {
        std::fs::File::open(&path)
            .ok()
            .and_then(|file| hash_exact(file, total).ok())
    })
    .await;
    matches!(hashed, Ok(Some(hex)) if hex == sha256)
}

/// The package the host serves, into `options.downloads`.
pub async fn fetch(
    link: &HostLink,
    options: FetchOptions<'_>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Fetched, FetchError> {
    let pinned = PinnedClient::new(&link.address, &link.fingerprint).map_err(request_error)?;
    let credentials = Credentials {
        device_key: Some(link.key()),
        office_token: None,
    };
    let answer = pinned
        .send("GET", OFFER_PATH, None, credentials)
        .await
        .map_err(request_error)?;
    let offer = offer_of(&answer)?;
    let text = match (offer.package.state, offer.package.manifest) {
        (PackageState::Ok, Some(text)) => text,
        (PackageState::Verifying, _) => return Err(FetchError::Verifying),
        _ => return Err(FetchError::Unavailable),
    };
    let manifest = read_manifest(&text, &trust::update_keyset())?;
    check_offer(&manifest, &offer.host_version, options.own_version)?;
    let dir = prepare_dir(options.downloads, &manifest.version).await?;
    let manifest_path = dir.join(format!("markiro-standalone-{}.update.jws", manifest.version));
    let target = dir.join(&manifest.installer.name);
    let partial = dir.join(format!("{}.partial", manifest.installer.name));
    // A partial file of another package of the same version (the host's
    // package changed between attempts) is never resumed.
    let kept = tokio::fs::read_to_string(&manifest_path).await.ok();
    if kept.as_deref().map(str::trim) != Some(text.trim()) {
        remove_file(&partial).await;
        remove_file(&target).await;
    }
    tokio::fs::write(&manifest_path, text.trim().as_bytes())
        .await
        .map_err(|_| FetchError::Storage)?;
    let total = manifest.installer.size_bytes;
    let sha256 = manifest.installer.sha256.clone();
    if !matches_manifest(&target, total, &sha256).await {
        remove_file(&target).await;
        download(
            link,
            &partial,
            total,
            &format!("\"{sha256}\""),
            options.stop_after,
            progress,
        )
        .await?;
        if !matches_manifest(&partial, total, &sha256).await {
            remove_file(&partial).await;
            return Err(FetchError::HashMismatch);
        }
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|_| FetchError::Storage)?;
    }
    Ok(Fetched {
        version: manifest.version.clone(),
        manifest_path: manifest_path.display().to_string(),
        size_bytes: total,
    })
}

/// The installer into `partial`, resumed from what it holds.
async fn download(
    link: &HostLink,
    partial: &Path,
    total: u64,
    etag: &str,
    stop_after: Option<u64>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), FetchError> {
    let client = TransferClient::new(&link.address, &link.fingerprint).map_err(request_error)?;
    let mut received = tokio::fs::metadata(partial)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    if received > total {
        remove_file(partial).await;
        received = 0;
    }
    if received == total {
        return Ok(());
    }
    let resume = (received > 0).then_some((received, etag));
    let mut answer = client
        .download(INSTALLER_PATH, link.key(), resume)
        .await
        .map_err(request_error)?;
    let mut file = match answer.status() {
        200 => {
            received = 0;
            tokio::fs::File::create(partial)
                .await
                .map_err(|_| FetchError::Storage)?
        }
        206 if received > 0 && answer.range_start() == Some(received) => {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(partial)
                .await
                .map_err(|_| FetchError::Storage)?
        }
        206 | 416 => {
            remove_file(partial).await;
            return Err(FetchError::Interrupted);
        }
        _ => return Err(refusal(&answer.into_error().await)),
    };
    progress(received, total);
    let mut this_attempt = 0u64;
    loop {
        let chunk = match answer.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                let _ = file.flush().await;
                return Err(FetchError::Interrupted);
            }
        };
        if !fits(received, chunk.len(), total) {
            drop(file);
            remove_file(partial).await;
            return Err(FetchError::TooLong);
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| FetchError::Storage)?;
        received += chunk.len() as u64;
        this_attempt += chunk.len() as u64;
        progress(received, total);
        if stop_after.is_some_and(|limit| this_attempt >= limit) {
            file.flush().await.map_err(|_| FetchError::Storage)?;
            return Err(FetchError::Interrupted);
        }
    }
    file.flush().await.map_err(|_| FetchError::Storage)?;
    file.sync_all().await.map_err(|_| FetchError::Storage)?;
    if received == total {
        Ok(())
    } else {
        Err(FetchError::Interrupted)
    }
}

/// `update_fetch`: the host's package of its version for this app; progress
/// as [`PROGRESS_EVENT`]; a refusal is a bare code ([`FetchError::code`]).
#[tauri::command]
pub async fn update_fetch<R: Runtime>(
    app: tauri::AppHandle<R>,
    device: tauri::State<'_, DeviceState>,
    downloads: tauri::State<'_, DownloadsDir>,
) -> Result<Fetched, String> {
    let link = {
        let current = device.watch_link().borrow().clone();
        current.ok_or_else(|| FetchError::NotPaired.code().to_owned())?
    };
    // This build's version as `tauri.conf.json` has it, as plan ОБН-2's
    // `UpdateConfig.installed` and the webview's `getVersion()` read it.
    let own = app.package_info().version.to_string();
    let progress = move |received: u64, total: u64| {
        let _ = app.emit(PROGRESS_EVENT, FetchProgress { received, total });
    };
    fetch(
        &link,
        FetchOptions {
            own_version: &own,
            downloads: &downloads.0,
            stop_after: None,
        },
        &progress,
    )
    .await
    .map_err(|error| error.code().to_owned())
}

/// `update_check_manifest`: the signature and the view of a manifest the
/// webview read from the host; a refusal is a bare code.
#[tauri::command]
pub fn update_check_manifest(manifest: String) -> Result<ManifestView, String> {
    read_manifest(&manifest, &trust::update_keyset())
        .map(|manifest| ManifestView::of(&manifest))
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use markiro_proto::update::distribution::testing::sign_update_manifest;
    use serde_json::json;

    use super::*;

    fn manifest(version: &str, min_upgrade_from: &str) -> String {
        sign_update_manifest(&json!({
            "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
            "releasedAt": "2026-11-02T10:00:00Z",
            "sourceSha": "0123456789abcdef0123456789abcdef01234567",
            "installer": {
                "name": format!("markiro-standalone-{version}-windows-x86_64-setup.exe"),
                "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
                "sizeBytes": 22
            },
            "protocol": 3, "minProtocol": 1, "minUpgradeFrom": min_upgrade_from, "notes": ["Тест"]
        }))
    }

    fn read(text: &str) -> UpdateManifestV1 {
        read_manifest(text, &trust::update_keyset()).unwrap()
    }

    #[test]
    fn the_rules_hold_before_a_byte_is_downloaded() {
        let package = read(&manifest("0.3.0", "0.2.0"));
        assert_eq!(check_offer(&package, "0.3.0", "0.2.1"), Ok(()));
        assert_eq!(check_offer(&package, "0.3.0", "0.3.0"), Err(FetchError::NotNewer));
        assert_eq!(check_offer(&package, "0.3.0", "0.4.0"), Err(FetchError::NotNewer));
        assert_eq!(check_offer(&package, "0.3.1", "0.2.1"), Err(FetchError::HostMismatch));
        assert_eq!(check_offer(&package, "0.2.9", "0.2.1"), Err(FetchError::HostMismatch));
        let later = read(&manifest("0.3.0", "0.2.5"));
        assert_eq!(check_offer(&later, "0.3.0", "0.2.1"), Err(FetchError::NeedsIntermediate));
    }

    #[test]
    fn a_manifest_changed_after_signing_or_not_a_manifest_is_refused() {
        let mut tampered = manifest("0.3.0", "0.2.0");
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert_eq!(
            read_manifest(&tampered, &trust::update_keyset()).unwrap_err(),
            FetchError::ManifestSignature
        );
        assert_eq!(
            read_manifest("not.a.jws", &trust::update_keyset()).unwrap_err(),
            FetchError::ManifestMalformed
        );
    }

    #[test]
    fn a_byte_beyond_the_size_does_not_fit() {
        assert!(fits(0, 10, 10));
        assert!(fits(10, 0, 10));
        assert!(!fits(5, 6, 10));
        assert!(!fits(u64::MAX, 1, u64::MAX));
    }

    #[test]
    fn the_codes_the_webview_reads_are_stable() {
        assert_eq!(FetchError::Unavailable.code(), "package_unavailable");
        assert_eq!(FetchError::Verifying.code(), "package_verifying");
        assert_eq!(FetchError::Busy.code(), "update_busy");
        assert_eq!(FetchError::NeedsIntermediate.code(), "needs_intermediate");
    }
}
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1 (в `invoke_handler`):

```rust
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file
    ]
```

заменить на (команды ОБН-2 остаются, где они):

```rust
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file,
        update::fetch::update_fetch,
        update::fetch::update_check_manifest
    ]
```

Фрагмент 2 (в `manage_state`):

```rust
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    link
```

заменить на:

```rust
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    // The package `update_fetch` downloads from the host (plan ОБН-3): in
    // the local data folder, never a roaming one.
    app.manage(update::fetch::DownloadsDir(dir.join(update::fetch::DOWNLOADS)));
    link
```

Документацию `manage_state` дополнить: «… and the folder of the update's downloads (plan ОБН-3).»

- [ ] **Step 5: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib device:: update::fetch::
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc
# вне песочницы:
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test update_fetch
```

Ожидается: PASS. Мутации (FAIL названного, файл восстановить): в `fetch` убрать сброс частичного файла при другом манифесте — FAIL `a_package_that_changed_between_attempts…` (`hash_mismatch`); `fits` → `sum < total` — FAIL `a_byte_beyond_the_size_does_not_fit`; в `download` убрать `stop_after` (`if stop_after.is_some_and(…)` → `if false`) — FAIL `a_broken_download_resumes…` (первая попытка не прерывается).

- [ ] **Step 6: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git diff --exit-code apps/standalone/Cargo.lock
git add apps/standalone/src-tauri/Cargo.toml apps/standalone/src-tauri/src/host_client.rs apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/update/mod.rs apps/standalone/src-tauri/src/update/fetch.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src-tauri/tests/update_fetch.rs
git commit -F /tmp/claude/msg-obn3-8.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the shell downloads the update from the host (update_fetch, resume, update_check_manifest)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 9: Оболочка загружает пакет на хост и ставит пакет с хоста — `update_stage`, ветка `update_install`, уборка

**Files:**

- Create: `apps/standalone/src-tauri/src/update/stage.rs`, `apps/standalone/src-tauri/tests/update_stage.rs`
- Modify: `apps/standalone/src-tauri/src/host_client.rs` (`TransferClient::upload`), `apps/standalone/src-tauri/src/device.rs` (исключение `/v1/office/update-package/…`), `apps/standalone/src-tauri/src/update/fetch.rs` (`downloaded_manifest`), файлы ОБН-2: `apps/standalone/src-tauri/src/update/mod.rs` (`UpdateState::found_path`, `check`, `pub mod stage`), `apps/standalone/src-tauri/src/update/rules.rs` (`Offered::from_host`, `Refusal::HostDiffers`), `apps/standalone/src-tauri/src/update/package.rs` (`Manifest::offered`), `apps/standalone/src-tauri/src/update/pending.rs` (`take_outcome` убирает скачанное), `apps/standalone/src/office/info/update-shell.ts` (`refusalSchema`), `apps/standalone/src/office/info/UpdateSection.tsx` (`refusalText`); `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/tests/ipc.rs`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/src-tauri/tests/update_stage.rs` (вне песочницы), модульные тесты `update::fetch::tests`, `update::rules::tests`, `update::pending::tests`, `device::tests`, `tests/ipc.rs`, `apps/standalone/test/update-shell.test.ts` (ОБН-2)

**Interfaces:**

- Consumes: `read_manifest`, `DOWNLOADS` (задача 8); ОБН-2: `UpdateState::{found_path, check, verify, install}`, `rules::{decide, Offered, Refusal, HostCheck, Confirmation::HostUnreachable}`, `package::Manifest::offered`, `pending::take_outcome`, `host_probe::HostVersions`, `UpdateError::code`, Zod `refusalSchema`, `refusalText`; `UpdatePackageUpload` (задача 1).
- Produces: `TransferClient::upload(path, Credentials, tokio::fs::File, length) -> Result<HostResponse, RequestError>`; `update::stage::{stage, StageError, Staged, MANIFEST_PATH}`; команда `update_stage { manifestPath, officeToken } → { version, sizeBytes }` (путь — `UpdateState::found_path`, иначе `invalid_request`); `update::fetch::downloaded_manifest`; `UpdateState::found_path` (`pub(crate)`) принимает и манифест скачанного с хоста пакета; `Offered::from_host`; `Refusal::HostDiffers { hostVersion }` (`code: "host_differs"`) — пакет с хоста, а хост на другой версии (§10.11.4); молчащий хост — прежнее подтверждение `host_unreachable` (ЛО12); `take_outcome` после «обновлено» удаляет папку скачанного.

- [ ] **Step 1: Падающие тесты**

Правка `apps/standalone/src-tauri/src/device.rs` (тест маршрутов вебвью, оба списка задачи 8):

```rust
            // The offer is small JSON (plan ОБН-3).
            "/v1/device/update",
```

заменить на:

```rust
            // The offer and the office's table are small JSON (plan ОБН-3).
            "/v1/device/update",
            "/v1/office/update-status",
```

и

```rust
            "/v1/device/update/installer",
            "/v1/device/update/installer?x=1",
```

заменить на:

```rust
            "/v1/device/update/installer",
            "/v1/device/update/installer?x=1",
            // The upload goes through `update_stage` only.
            "/v1/office/update-package/manifest",
            "/v1/office/update-package/6b1f2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/installer",
```

В модуль тестов `apps/standalone/src-tauri/src/update/fetch.rs` добавить:

```rust
    #[test]
    fn only_a_manifest_this_app_downloaded_counts_as_one() {
        let downloads = std::path::Path::new("/data/updates");
        assert!(downloaded_manifest(
            downloads,
            &downloads.join("0.3.0").join("markiro-standalone-0.3.0.update.jws")
        ));
        for path in [
            downloads.join("markiro-standalone-0.3.0.update.jws"),
            downloads.join("0.3.0").join("markiro-standalone-0.4.0.update.jws"),
            downloads.join("x").join("markiro-standalone-x.update.jws"),
            downloads.join("0.3.0").join("..").join("markiro-standalone-0.3.0.update.jws"),
            std::path::PathBuf::from("/elsewhere/0.3.0/markiro-standalone-0.3.0.update.jws"),
        ] {
            assert!(!downloaded_manifest(downloads, &path), "{}", path.display());
        }
    }

```

В модуль тестов `apps/standalone/src-tauri/src/update/rules.rs` (ОБН-2; помощник `v` там есть) добавить:

```rust
    #[test]
    fn a_package_from_the_host_needs_the_host_on_its_very_version() {
        let version = v("0.3.0");
        let floor = v("0.2.0");
        let offered = Offered {
            version: &version,
            min_upgrade_from: &floor,
            protocol: 3,
            from_host: true,
        };
        let host = |version: &str| {
            HostCheck::Seen(HostVersions {
                version: Some(version.into()),
                protocol: 3,
                min_protocol: 1,
            })
        };
        assert_eq!(decide(offered, &v("0.2.1"), &host("0.3.0")).refusal, None);
        assert_eq!(
            decide(offered, &v("0.2.1"), &host("0.2.9")).refusal,
            Some(Refusal::HostDiffers {
                host_version: "0.2.9".into()
            })
        );
        assert_eq!(
            decide(offered, &v("0.2.1"), &host("0.4.0")).refusal,
            Some(Refusal::HostDiffers {
                host_version: "0.4.0".into()
            })
        );
        // A silent host asks for the same confirmation as for a file (ЛО12).
        assert_eq!(
            decide(offered, &v("0.2.1"), &HostCheck::Silent).confirmations,
            vec![Confirmation::HostUnreachable]
        );
        // A package from a file keeps plan ОБН-2's rule: the protocol, not the version.
        let from_file = Offered {
            from_host: false,
            ..offered
        };
        assert_eq!(decide(from_file, &v("0.2.1"), &host("0.2.9")).refusal, None);
        assert_eq!(
            serde_json::to_value(Refusal::HostDiffers {
                host_version: "0.2.9".into()
            })
            .unwrap(),
            json!({ "code": "host_differs", "hostVersion": "0.2.9" })
        );
    }
```

В модуль тестов `apps/standalone/src-tauri/src/update/pending.rs` (ОБН-2; помощник `mark` пишет отметку `0.1.0 → 0.2.0`) добавить:

```rust
    #[test]
    fn a_finished_update_takes_the_downloaded_package_and_an_unfinished_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = dir.path().join(crate::update::fetch::DOWNLOADS);
        let package = downloads.join("0.2.0");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("installer"), b"MZ").unwrap();
        mark(dir.path());
        assert!(matches!(
            take_outcome(dir.path(), "0.1.0"),
            Some(UpdateOutcome::NotFinished { .. })
        ));
        assert!(package.exists(), "«Повторить» installs the same file");
        assert!(matches!(
            take_outcome(dir.path(), "0.2.0"),
            Some(UpdateOutcome::Updated { .. })
        ));
        assert!(!downloads.exists());
    }
```

В `apps/standalone/test/update-shell.test.ts` (ОБН-2) добавить случай: отчёт `update_verify` с `refusal: { code: "host_differs", hostVersion: "0.2.9" }` читается `verifiedReportSchema`; в тест раздела (`test/update-section.test.tsx`) — текст отказа «Хост работает на версии 0.2.9, а пакет — другой: установка отменена. Проверьте хост.».

Создать `apps/standalone/src-tauri/tests/update_stage.rs`:

```rust
//! `update_stage` against a real `markiro-host` on 127.0.0.1 (plan ОБН-3,
//! spec §10.11.2): a package found on this computer goes to the host with
//! the office session and waits there as `staged\`; a wrong file stops
//! before the network, a package not newer than the host is refused by the
//! host. Outside the sandbox.

use std::path::{Path, PathBuf};

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions, HOST_VERSION};
use markiro_proto::update::distribution::testing::sign_update_manifest;
use markiro_proto::update::AppVersion;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::update::stage::{stage, StageError};
use serde_json::{json, Value};

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// A package folder as `sign-update.mjs` leaves it; the manifest's path.
fn package(dir: &Path, version: &str) -> PathBuf {
    let bytes = format!("MZ staged installer {version}\n").repeat(10_000).into_bytes();
    let size = bytes.len() as u64;
    let sha256 = markiro_proto::update::hash_exact(&bytes[..], size).unwrap();
    let manifest = sign_update_manifest(&json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": { "name": installer_name(version), "sha256": sha256, "sizeBytes": size },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.0.1", "notes": ["Тест"]
    }));
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("markiro-standalone-{version}.update.jws"));
    std::fs::write(&path, format!("{manifest}\n")).unwrap();
    std::fs::write(dir.join(installer_name(version)), bytes).unwrap();
    path
}

fn newer() -> String {
    let host: AppVersion = HOST_VERSION.parse().unwrap();
    AppVersion { minor: host.minor + 1, patch: 0, ..host }.to_string()
}

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

/// The host's PC after the wizard, with the administrator's session.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&format!("https://{}", host.addr), "Рабочее место хоста", "0.0.1")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = station
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (station, token)
}

#[tokio::test]
async fn a_found_package_goes_to_the_host_and_waits_there_as_staged() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    let files = tempfile::tempdir().unwrap();
    let version = newer();
    let manifest = package(files.path(), &version);
    let staged = stage(&link, &token, &manifest).await.unwrap();
    assert_eq!(staged.version, version);
    host.stop().await.unwrap();
    let staged_dir = HostPaths::new(host_dir.path()).updates_dir().join("staged");
    assert_eq!(
        std::fs::read(staged_dir.join(installer_name(&version))).unwrap(),
        std::fs::read(files.path().join(installer_name(&version))).unwrap()
    );
}

#[tokio::test]
async fn a_wrong_file_stops_here_and_an_old_package_at_the_host() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    let files = tempfile::tempdir().unwrap();

    let same = package(&files.path().join("same"), HOST_VERSION);
    assert_eq!(stage(&link, &token, &same).await.unwrap_err(), StageError::NotNewer);

    let version = newer();
    let tampered = package(&files.path().join("tampered"), &version);
    let mut text = std::fs::read_to_string(&tampered).unwrap().trim().to_owned();
    let last = text.pop().unwrap();
    text.push(if last == 'A' { 'B' } else { 'A' });
    std::fs::write(&tampered, text).unwrap();
    assert_eq!(
        stage(&link, &token, &tampered).await.unwrap_err(),
        StageError::ManifestRefused
    );

    let short = package(&files.path().join("short"), &version);
    std::fs::write(files.path().join("short").join(installer_name(&version)), b"MZ").unwrap();
    assert_eq!(
        stage(&link, &token, &short).await.unwrap_err(),
        StageError::InstallerRefused
    );

    let lost = package(&files.path().join("lost"), &version);
    std::fs::remove_file(files.path().join("lost").join(installer_name(&version))).unwrap();
    assert_eq!(stage(&link, &token, &lost).await.unwrap_err(), StageError::NotFound);

    assert_eq!(
        stage(&link, "not-a-session", &package(&files.path().join("ok"), &version))
            .await
            .unwrap_err(),
        StageError::SessionEnded
    );
    host.stop().await.unwrap();
    assert!(!HostPaths::new(host_dir.path()).updates_dir().join("staged").exists());
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs` (в тесте задачи 8, после проверки `update_check_manifest` с подписанным манифестом):

```rust
    // Only a manifest `update_scan` found goes to the host (plan ОБН-2's list).
    assert_eq!(
        invoke(
            &webview,
            "update_stage",
            json!({ "manifestPath": "/elsewhere/markiro-standalone-0.3.0.update.jws", "officeToken": "t" })
        ),
        Err(json!("invalid_request"))
    );
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("POST", "/v1/office/update-package/manifest", json!({ "manifest": "x" }), Some("t"))
        ),
        Err(json!("invalid_request"))
    );
```

В `apps/standalone/src-tauri/tests/update.rs` (ОБН-2; хост на 127.0.0.1 и поддельный `Launcher`) добавить по образцу его теста `update_install` случай: пакет записан в `<data_dir>/updates/<версия хоста>/` (манифест подписан `markiro_proto::update::distribution::testing::sign_update_manifest`, установщик рядом) — `update_verify` по этому пути отвечает отчётом без отказа, а тот же пакет версии, не равной версии хоста, — `refusal.code == "host_differs"`, и `update_install` отвечает `update_refused`, поддельный `Launcher` не вызван; путь `<data_dir>/updates/x/…` — `invalid_request`.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib device:: update::
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc
```

Ожидается: `device` — FAIL (`/v1/office/update-package/…` проходит); `fetch` и `update_stage` не собираются (`downloaded_manifest`, `update::stage` не найдены).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/host_client.rs` (в `impl TransferClient`, после `download`):

```rust
    /// `PUT path` of exactly `length` bytes of `file`, streamed, with the
    /// device key and the office session (`update_stage`, plan ОБН-3).
    pub async fn upload(
        &self,
        path: &str,
        credentials: Credentials<'_>,
        file: tokio::fs::File,
        length: u64,
    ) -> Result<HostResponse, RequestError> {
        validate_path(path)?;
        let mut request = self
            .client
            .put(format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, length)
            .body(reqwest::Body::from(file));
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key.expose());
        }
        if let Some(token) = credentials.office_token {
            request = request.header(OFFICE_SESSION_HEADER, token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_builder() => return Err(RequestError::InvalidRequest),
            Err(error) if is_fingerprint_mismatch(&error) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        Ok(HostResponse {
            status,
            body: serde_json::from_slice(&bytes).ok(),
        })
    }
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 1 (после `INSTALLER_ROUTE`, задача 8):

```rust
const INSTALLER_ROUTE: &str = "/v1/device/update/installer";
```

заменить на:

```rust
const INSTALLER_ROUTE: &str = "/v1/device/update/installer";

/// The upload of an update package (plan ОБН-3): only `update_stage` sends
/// it, the installer streamed from the disk; never through IPC.
const UPDATE_PACKAGE_PREFIX: &str = "/v1/office/update-package/";
```

Фрагмент 2 (в `webview_may_reach`):

```rust
        || route.starts_with("/v1/office/")
}
```

заменить на:

```rust
        || (route.starts_with("/v1/office/") && !route.starts_with(UPDATE_PACKAGE_PREFIX))
}
```

В `apps/standalone/src-tauri/src/update/fetch.rs` (перед `#[cfg(test)]`) добавить:

```rust
/// Whether `path` is the manifest of a package this app downloaded:
/// `<downloads>/<version>/markiro-standalone-<version>.update.jws` and
/// nothing else (`update_install` takes such a path besides the found ones).
pub fn downloaded_manifest(downloads: &Path, path: &Path) -> bool {
    let (Some(folder), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return false;
    };
    let Some(version) = folder.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    folder.parent() == Some(downloads)
        && version.parse::<AppVersion>().is_ok()
        && name == format!("markiro-standalone-{version}.update.jws")
}
```

Создать `apps/standalone/src-tauri/src/update/stage.rs`:

```rust
//! `update_stage` (plan ОБН-3, spec §10.11.2): a package found on this
//! computer (`update_scan`, plan ОБН-2) goes to the host, which keeps it as
//! `staged\` and serves it to the other devices once it runs that version.
//! The manifest is checked here first, so a wrong file stops before the
//! network; then it goes with the office session, and the installer follows
//! as a stream of the file with its exact size — never through the webview.
//! The host checks the signature, the size and the SHA-256 again.

use std::path::Path;

use markiro_proto::update::distribution::{UpdatePackageUpload, MAX_MANIFEST_BYTES};
use markiro_proto::trust;
use serde::Serialize;
use serde_json::json;

use super::fetch::read_manifest;
use crate::device::HostLink;
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError, TransferClient};

pub const MANIFEST_PATH: &str = "/v1/office/update-package/manifest";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageError {
    NotPaired,
    InvalidRequest,
    /// The manifest or the installer beside it is not on the disk.
    NotFound,
    Unreachable,
    CertificateMismatch,
    /// The office session ended: sign in again.
    SessionEnded,
    Forbidden,
    NotNewer,
    ManifestRefused,
    InstallerRefused,
    DiskFull,
    Storage,
    Refused,
}

impl StageError {
    pub fn code(self) -> &'static str {
        match self {
            StageError::NotPaired => "not_paired",
            StageError::InvalidRequest => "invalid_request",
            StageError::NotFound => "not_found",
            StageError::Unreachable => "unreachable",
            StageError::CertificateMismatch => "certificate_mismatch",
            StageError::SessionEnded => "session_ended",
            StageError::Forbidden => "forbidden",
            StageError::NotNewer => "package_not_newer",
            StageError::ManifestRefused => "manifest_refused",
            StageError::InstallerRefused => "installer_refused",
            StageError::DiskFull => "disk_full",
            StageError::Storage => "storage",
            StageError::Refused => "refused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub version: String,
    pub size_bytes: u64,
}

fn transport(error: RequestError) -> StageError {
    match error {
        RequestError::CertificateMismatch => StageError::CertificateMismatch,
        RequestError::InvalidRequest => StageError::InvalidRequest,
        _ => StageError::Unreachable,
    }
}

fn refusal(answer: &HostResponse) -> StageError {
    let error = answer.body.as_ref().map(|body| &body["error"]);
    let detail = |name: &str| error.and_then(|error| error["details"][name].as_str());
    match answer.status {
        401 => StageError::SessionEnded,
        403 => StageError::Forbidden,
        409 => match detail("constraint") {
            Some("package_not_newer") => StageError::NotNewer,
            Some("disk_full") => StageError::DiskFull,
            _ => StageError::Refused,
        },
        400 => match detail("field") {
            Some("installer") => StageError::InstallerRefused,
            _ => StageError::ManifestRefused,
        },
        _ => StageError::Refused,
    }
}

/// The package of `manifest_path` (its installer beside it, by the
/// manifest's name) to the host of `link`, with `office_token`'s session.
pub async fn stage(
    link: &HostLink,
    office_token: &str,
    manifest_path: &Path,
) -> Result<Staged, StageError> {
    let text = tokio::fs::read_to_string(manifest_path)
        .await
        .map_err(|_| StageError::NotFound)?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(StageError::ManifestRefused);
    }
    let manifest =
        read_manifest(&text, &trust::update_keyset()).map_err(|_| StageError::ManifestRefused)?;
    let folder = manifest_path.parent().ok_or(StageError::InvalidRequest)?;
    let file = tokio::fs::File::open(folder.join(&manifest.installer.name))
        .await
        .map_err(|_| StageError::NotFound)?;
    let length = file
        .metadata()
        .await
        .map_err(|_| StageError::Storage)?
        .len();
    if length != manifest.installer.size_bytes {
        return Err(StageError::InstallerRefused);
    }
    let credentials = Credentials {
        device_key: Some(link.key()),
        office_token: Some(office_token),
    };
    let pinned = PinnedClient::new(&link.address, &link.fingerprint).map_err(transport)?;
    let answer = pinned
        .send(
            "POST",
            MANIFEST_PATH,
            Some(&json!({ "manifest": text.trim() })),
            credentials,
        )
        .await
        .map_err(transport)?;
    if answer.status != 200 {
        return Err(refusal(&answer));
    }
    let upload: UpdatePackageUpload = answer
        .body
        .and_then(|body| serde_json::from_value(body).ok())
        .ok_or(StageError::Refused)?;
    let client = TransferClient::new(&link.address, &link.fingerprint).map_err(transport)?;
    let answer = client
        .upload(
            &format!("/v1/office/update-package/{}/installer", upload.upload_id),
            credentials,
            file,
            length,
        )
        .await
        .map_err(transport)?;
    if answer.status != 200 {
        return Err(refusal(&answer));
    }
    Ok(Staged {
        version: upload.version,
        size_bytes: upload.size_bytes,
    })
}
```

Команда `update_stage` — в том же файле. Путь проверяется `UpdateState::found_path` ОБН-2 до любой проверки сопряжения, как `host_request` проверяет маршрут:

```rust
/// `update_stage`: a manifest `update_scan` found (another path is
/// `invalid_request`) and its installer go to the host with the office
/// session; a refusal is a bare code ([`StageError::code`]).
#[tauri::command]
pub async fn update_stage(
    device: tauri::State<'_, crate::device::DeviceState>,
    updates: tauri::State<'_, super::UpdateState>,
    manifest_path: String,
    office_token: String,
) -> Result<Staged, String> {
    let path = updates
        .found_path(&manifest_path)
        .map_err(|error| error.code().to_owned())?;
    let link = {
        let current = device.watch_link().borrow().clone();
        current.ok_or_else(|| StageError::NotPaired.code().to_owned())?
    };
    stage(&link, &office_token, &path)
        .await
        .map_err(|error| error.code().to_owned())
}
```

В `apps/standalone/src-tauri/src/update/mod.rs` добавить `pub mod stage;`; в `invoke_handler` (`lib.rs`) после `update::fetch::update_check_manifest` добавить `update::stage::update_stage`.

Ветка «пакет с хоста» в коде ОБН-2.

Правка `apps/standalone/src-tauri/src/update/mod.rs` — фрагмент 1 (`UpdateState::found_path`):

```rust
    fn found_path(&self, path: &str) -> Result<PathBuf, UpdateError> {
        self.found
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|found| found.to_string_lossy() == path)
            .cloned()
            .ok_or(UpdateError::InvalidRequest)
    }
```

заменить на:

```rust
    /// A path the last search found, or the manifest of a package this app
    /// downloaded from the host (plan ОБН-3, `fetch::downloaded_manifest`);
    /// anything else is `invalid_request`. `update_stage` asks it too.
    pub(crate) fn found_path(&self, path: &str) -> Result<PathBuf, UpdateError> {
        let found = self
            .found
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|found| found.to_string_lossy() == path)
            .cloned();
        if let Some(found) = found {
            return Ok(found);
        }
        let downloaded = PathBuf::from(path);
        if fetch::downloaded_manifest(&self.downloads(), &downloaded) {
            return Ok(downloaded);
        }
        Err(UpdateError::InvalidRequest)
    }

    /// Where `update_fetch` keeps the package from the host (plan ОБН-3).
    fn downloads(&self) -> PathBuf {
        self.data_dir.join(fetch::DOWNLOADS)
    }
```

Фрагмент 2 (`UpdateState::check`):

```rust
        let decision = rules::decide(checked.manifest.offered(), &installed, &host);
```

заменить на:

```rust
        // A package from the host must be of the host's very version (plan
        // ОБН-3, spec §10.11.4); a file keeps the protocol rule of §10.7.
        let mut offered = checked.manifest.offered();
        offered.from_host = fetch::downloaded_manifest(&self.downloads(), &source);
        let decision = rules::decide(offered, &installed, &host);
```

Правка `apps/standalone/src-tauri/src/update/rules.rs`:

Фрагмент 1 (в `Refusal`, после `HostFirst { … },`):

```rust
    HostFirst {
        #[serde(rename = "hostProtocol")]
        host_protocol: u32,
        protocol: u32,
    },
}
```

заменить на:

```rust
    HostFirst {
        #[serde(rename = "hostProtocol")]
        host_protocol: u32,
        protocol: u32,
    },
    /// A package downloaded from the host while the host runs another
    /// version: it was rolled back, or its package changed (plan ОБН-3, §10.11.4).
    HostDiffers {
        #[serde(rename = "hostVersion")]
        host_version: String,
    },
}
```

Фрагмент 2 (`Offered`):

```rust
pub struct Offered<'a> {
    pub version: &'a AppVersion,
    pub min_upgrade_from: &'a AppVersion,
    pub protocol: u32,
}
```

заменить на:

```rust
pub struct Offered<'a> {
    pub version: &'a AppVersion,
    pub min_upgrade_from: &'a AppVersion,
    pub protocol: u32,
    /// Downloaded from the host (plan ОБН-3): the host must run exactly
    /// this version.
    pub from_host: bool,
}
```

Фрагмент 3 (в `decide`):

```rust
            HostCheck::Seen(seen) if offered.protocol > seen.protocol => {
```

заменить на:

```rust
            HostCheck::Seen(seen)
                if offered.from_host
                    && seen.version.as_deref() != Some(offered.version.to_string().as_str()) =>
            {
                Some(Refusal::HostDiffers {
                    host_version: seen.version.clone().unwrap_or_default(),
                })
            }
            HostCheck::Seen(seen) if offered.protocol > seen.protocol => {
```

В `apps/standalone/src-tauri/src/update/package.rs` (`Manifest::offered`) в конструктор `Offered { … }` добавить `from_host: false,` (файлы — путь ОБН-2); в литералы `Offered { … }` тестов ОБН-2 — то же.

Правка `apps/standalone/src-tauri/src/update/pending.rs` (`take_outcome`):

```rust
    if pending.to == installed {
        let _ = remove(dir);
```

заменить на:

```rust
    if pending.to == installed {
        let _ = remove(dir);
        // The package downloaded from the host did its work (plan ОБН-3).
        let _ = fs::remove_dir_all(dir.join(crate::update::fetch::DOWNLOADS));
```

Правка `apps/standalone/src/office/info/update-shell.ts` (`refusalSchema`, ОБН-2): в `z.discriminatedUnion("code", [ … ])` добавить вариант

<!-- prettier-ignore -->
```ts
  z.object({ code: z.literal("host_differs"), hostVersion: z.string() }),
```

и в `refusalText` (`src/office/info/UpdateSection.tsx`, ОБН-2) ветку `case "host_differs": return t("office.about.update.refusal.hostDiffers", { host: report.refusal.hostVersion });` — по образцу его веток; ключ в `ru.json` рядом с ключами отказов ОБН-2:

```json
"hostDiffers": "Хост работает на версии {{host}}, а пакет — другой: установка отменена. Проверьте хост."
```

Если `mock_app_with` в `tests/ipc.rs` не управляет `UpdateState` (ОБН-2 мог дать его только своим тестам), исполнитель добавляет его по образцу ОБН-2, иначе `update_stage` отвечает текстом Tauri о неуправляемом состоянии вместо `invalid_request`.

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc
# вне песочницы:
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test update_stage --test update_fetch
```

Ожидается: PASS (и тесты ОБН-2: `--lib update::`, `--test update` вне песочницы, `test/update-shell.test.ts`, `test/update-section.test.tsx`). Мутации (FAIL названного, файл восстановить): в `decide` условие `!=` версии заменить на «хост не старше пакета» — FAIL `a_package_from_the_host_needs_the_host_on_its_very_version` (`0.4.0`); в `refusal` ветку `Some("package_not_newer") => StageError::NotNewer` удалить — FAIL `a_wrong_file_stops_here…` (`refused` вместо `package_not_newer`). Локальные сверки манифеста и длины до сети тестом не отличимы от отказа хоста (тот же код) — они экономят загрузку десятков МБ, а не меняют исход; это записано, а не закреплено.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git diff --exit-code apps/standalone/Cargo.lock
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/update-shell.ts apps/standalone/src/office/info/UpdateSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/update-shell.test.ts apps/standalone/test/update-section.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git add apps/standalone/src-tauri/src/host_client.rs apps/standalone/src-tauri/src/device.rs apps/standalone/src-tauri/src/update/ apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src-tauri/tests/update.rs apps/standalone/src-tauri/tests/update_stage.rs apps/standalone/src/office/info/update-shell.ts apps/standalone/src/office/info/UpdateSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/update-shell.test.ts apps/standalone/test/update-section.test.tsx
git commit -F /tmp/claude/msg-obn3-9.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the shell stages a package on the host and installs one from the host only at the host's version` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 10: Статус связи знает версию хоста — поля из `hello`, причины `app_too_old`/`host_too_old`

**Files:**

- Modify: `apps/standalone/src-tauri/src/connection.rs`, `apps/standalone/src/host/protocol.ts` (`hostStatusSchema`), `apps/standalone/src/i18n/ru.json` (`errors.link.*`)
- Test: модульные тесты `connection::tests`, `apps/standalone/src-tauri/tests/connection.rs` (вне песочницы; правка ожиданий по смыслу), `apps/standalone/test/connection.test.ts`, `apps/standalone/test/host-status-line.test.tsx`

**Interfaces:**

- Consumes: `host_probe::{classify_hello, ProbeError}`; `host_probe::{HostVersions, read_versions}` (ОБН-2: версии `hello` любым протоколом).
- Produces: `HostStatus { …, host_version, host_protocol, host_min_protocol }` (`hostVersion`, `hostProtocol`, `hostMinProtocol`, нет в JSON, пока не прочитаны); `LinkError::{HostTooOld, AppTooOld}` (`host_too_old`, `app_too_old`) вместо `stream_refused` для несовместимого `hello`; версии берутся из каждого прочитанного `hello` Markiro (и несовместимого), держатся, пока устройство сопряжено с тем же хостом, и сбрасываются со сменой сопряжения.

- [ ] **Step 1: Падающие тесты**

В модуль тестов `apps/standalone/src-tauri/src/connection.rs`:

Фрагмент 1 (тест `every_link_state_and_error_serializes_to_its_wire_string`):

```rust
            (LinkError::StreamRefused, "stream_refused"),
            (LinkError::StreamEnded, "stream_ended"),
        ];
```

заменить на:

```rust
            (LinkError::StreamRefused, "stream_refused"),
            (LinkError::StreamEnded, "stream_ended"),
            (LinkError::HostTooOld, "host_too_old"),
            (LinkError::AppTooOld, "app_too_old"),
        ];
```

Фрагмент 2 (тест `statuses_and_revisions_serialize_to_the_webview_shape`): в обоих литералах `HostStatus { … restore_epoch: … }` добавить `host_version: None, host_protocol: None, host_min_protocol: None,` (их JSON не меняется), и перед проверкой `HostRevision` добавить:

```rust
        let known = HostStatus {
            state: LinkState::Offline,
            last_contact_at: None,
            last_error: Some(LinkError::AppTooOld),
            seq: 6,
            restore_epoch: None,
            host_version: Some("0.3.0".to_owned()),
            host_protocol: Some(4),
            host_min_protocol: Some(4),
        };
        assert_eq!(
            serde_json::to_value(&known).unwrap(),
            json!({
                "state": "offline", "lastContactAt": null, "lastError": "app_too_old", "seq": 6,
                "hostVersion": "0.3.0", "hostProtocol": 4, "hostMinProtocol": 4
            })
        );
```

Добавить тест:

```rust
    #[test]
    fn a_hello_of_an_incompatible_host_names_why_and_still_tells_its_versions() {
        let hello: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/hello.json")).unwrap();
        let answer = |body: serde_json::Value| HostResponse {
            status: 200,
            body: Some(body),
        };
        let mut old = hello.clone();
        old["protocol"] = json!(1);
        old["minProtocol"] = json!(1);
        assert_eq!(epoch_of(&answer(old.clone())), Err(LinkError::HostTooOld));
        assert_eq!(
            versions_of(&answer(old)),
            Some(HostVersions {
                version: Some("0.1.0".to_owned()),
                protocol: 1,
                min_protocol: 1
            })
        );
        let mut newer = hello.clone();
        newer["protocol"] = json!(99);
        newer["minProtocol"] = json!(99);
        newer["version"] = json!("9.0.0");
        assert_eq!(epoch_of(&answer(newer.clone())), Err(LinkError::AppTooOld));
        assert_eq!(
            versions_of(&answer(newer)).and_then(|seen| seen.version),
            Some("9.0.0".to_owned())
        );
        // Not a Markiro host: no versions at all.
        let mut foreign = hello;
        foreign["product"] = json!("other");
        assert_eq!(versions_of(&answer(foreign)), None);
    }
```

Правка `apps/standalone/test/host-status-line.test.tsx` — фрагмент:

<!-- prettier-ignore -->
```ts
    const reasons = hostStatusSchema.shape.lastError.unwrap().options;
    expect(reasons).toHaveLength(5);
```

заменить на:

<!-- prettier-ignore -->
```ts
    const reasons = hostStatusSchema.shape.lastError.unwrap().options;
    expect(reasons).toHaveLength(7);
```

и добавить тест:

<!-- prettier-ignore -->
```ts
  it("says which side to update when the versions do not match", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "app_too_old", hostVersion: "0.3.0" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Это приложение старее хоста: обновите его с хоста.")).toBeTruthy();
  });
```

В `apps/standalone/test/connection.test.ts` добавить тест:

<!-- prettier-ignore -->
```ts
  it("reads the host's version, protocol and minimum the shell took from hello", async () => {
    const events = fakeEvents();
    const known = {
      ...status(3, "offline"),
      lastError: "app_too_old",
      hostVersion: "0.3.0",
      hostProtocol: 4,
      hostMinProtocol: 4,
    };
    const call = vi.fn(async () => known);
    const seen: HostStatus[] = [];
    await createTauriConnectionApi(call, events.listen).watch({
      onStatus: (next) => seen.push(next),
      onRevision: () => undefined,
    });
    expect(seen).toEqual([known]);
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib connection::
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/connection.test.ts test/host-status-line.test.tsx
```

Ожидается: Rust не собирается (`LinkError::AppTooOld`, `versions_of` не найдены); Vitest — FAIL (строгая схема отвергает `hostVersion`; 5 причин вместо 7).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/connection.rs`:

Фрагмент 1:

```rust
    /// The stream closed, went silent or carried something unreadable.
    StreamEnded,
}
```

заменить на:

```rust
    /// The stream closed, went silent or carried something unreadable.
    StreamEnded,
    /// The host's `hello` says it is older than this app (plan ОБН-3): the
    /// host is updated first.
    HostTooOld,
    /// The host's `hello` says this app is older than it takes (plan
    /// ОБН-3): this PC updates from the host (`GET /v1/device/update`,
    /// outside the protocol guard).
    AppTooOld,
}
```

Фрагмент 2 (поле `HostStatus`):

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
}
```

заменить на:

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
    /// The host's `hello.version`, `protocol` and `minProtocol` as the last
    /// `hello` of this pairing's host read them (plan ОБН-3, spec
    /// §10.11.3): an incompatible host's too, so the webview can offer the
    /// update. Absent until one was read; cleared with the pairing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_protocol: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_min_protocol: Option<u32>,
}
```

Фрагмент 3 (`impl Default for HostStatus`):

```rust
            seq: 0,
            restore_epoch: None,
        }
```

заменить на:

```rust
            seq: 0,
            restore_epoch: None,
            host_version: None,
            host_protocol: None,
            host_min_protocol: None,
        }
```

Фрагмент 4 (после `fn touch`):

```rust
    fn touch(&self) {
        self.0.lock().expect("status lock").last_contact_at = Some(now_ms());
    }
```

заменить на:

```rust
    fn touch(&self) {
        self.0.lock().expect("status lock").last_contact_at = Some(now_ms());
    }

    /// Keep what a `hello` told of the host's versions without publishing:
    /// the next status carries it. A read that told nothing keeps the last.
    fn note_host(&self, versions: Option<HostVersions>) {
        let Some(versions) = versions else {
            return;
        };
        let mut current = self.0.lock().expect("status lock");
        current.host_version = versions.version;
        current.host_protocol = Some(versions.protocol);
        current.host_min_protocol = Some(versions.min_protocol);
    }
```

Фрагмент 5 (в `unpaired`):

```rust
            current.last_contact_at = None;
            current.restore_epoch = None;
        });
    }
```

заменить на:

```rust
            current.last_contact_at = None;
            current.restore_epoch = None;
            current.host_version = None;
            current.host_protocol = None;
            current.host_min_protocol = None;
        });
    }
```

Фрагмент 6 (в `hold`):

```rust
            if fresh_link {
                current.last_contact_at = None;
                current.restore_epoch = None;
            }
```

заменить на:

```rust
            if fresh_link {
                current.last_contact_at = None;
                current.restore_epoch = None;
                current.host_version = None;
                current.host_protocol = None;
                current.host_min_protocol = None;
            }
```

Фрагмент 7 (в `follow`):

```rust
    let mut epoch = match restore_epoch(link).await {
        Ok(epoch) => epoch,
        Err(error) => return (error, false),
    };
```

заменить на:

```rust
    let (versions, epoch) = read_hello(link).await;
    state.note_host(versions);
    let mut epoch = match epoch {
        Ok(epoch) => epoch,
        Err(error) => return (error, false),
    };
```

Фрагмент 8 (функции чтения `hello`):

```rust
async fn restore_epoch(link: &HostLink) -> Result<Option<String>, LinkError> {
    let client = PinnedClient::new(&link.address, &link.fingerprint).map_err(request_error)?;
    let response = client
        .send("GET", HELLO_PATH, None, Credentials::default())
        .await
        .map_err(request_error)?;
    epoch_of(&response)
}
```

заменить на:

```rust
async fn read_hello(link: &HostLink) -> (Option<HostVersions>, Result<Option<String>, LinkError>) {
    let client = match PinnedClient::new(&link.address, &link.fingerprint) {
        Ok(client) => client,
        Err(error) => return (None, Err(request_error(error))),
    };
    match client
        .send("GET", HELLO_PATH, None, Credentials::default())
        .await
    {
        Ok(response) => (versions_of(&response), epoch_of(&response)),
        Err(error) => (None, Err(request_error(error))),
    }
}

/// The versions a `hello` of a Markiro host names, whatever its protocol
/// (`host_probe::read_versions`, plan ОБН-2); `None` for anything else.
fn versions_of(response: &HostResponse) -> Option<HostVersions> {
    let body = response.body.as_ref().filter(|_| response.status == 200)?;
    read_versions(body).ok()
}
```

В документации `restore_epoch` над этой функцией (абзац «`GET /v1/hello` with the pinned certificate…») заменить имя на `read_hello` и добавить: «…and what it tells of the host's versions, whatever the verdict».

Фрагмент 9 (в `epoch_of`):

```rust
    classify_hello(body)
        .map(|hello| hello.restore_epoch)
        .map_err(|_| LinkError::StreamRefused)
}
```

заменить на:

```rust
    classify_hello(body)
        .map(|hello| hello.restore_epoch)
        .map_err(|error| match error {
            ProbeError::HostTooOld => LinkError::HostTooOld,
            ProbeError::AppTooOld => LinkError::AppTooOld,
            _ => LinkError::StreamRefused,
        })
}
```

и в импортах модуля `classify_hello` дополнить: `use crate::host_probe::{classify_hello, read_versions, HostVersions, ProbeError};` (по месту существующего импорта; `HostVersions` и `read_versions` — ОБН-2).

Правка `apps/standalone/src/host/protocol.ts` (`hostStatusSchema`):

Фрагмент:

<!-- prettier-ignore -->
```ts
        "stream_refused",
        "stream_ended",
      ])
      .nullable(),
```

заменить на:

<!-- prettier-ignore -->
```ts
        "stream_refused",
        "stream_ended",
        "host_too_old",
        "app_too_old",
      ])
      .nullable(),
```

и после `restoreEpoch: z.uuid().optional(),` добавить:

<!-- prettier-ignore -->
```ts
    /** The host's `hello.version`, `protocol` and `minProtocol` as the last read named them (plan ОБН-3). */
    hostVersion: z.string().min(1).optional(),
    hostProtocol: z.number().int().nonnegative().optional(),
    hostMinProtocol: z.number().int().nonnegative().optional(),
```

Правка `apps/standalone/src/i18n/ru.json` — в `errors.link` после `"stream_ended": …`:

<!-- prettier-ignore -->
```json
      "host_too_old": "Хост старее этого приложения: сначала обновите хост.",
      "app_too_old": "Это приложение старее хоста: обновите его с хоста."
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib connection::
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/connection.test.ts test/host-status-line.test.tsx test/app.test.tsx
# вне песочницы:
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test connection
```

Ожидается: PASS. Тест `tests/connection.rs`, сравнивающий статус `Online` целиком, дополняется `hostVersion`/`hostProtocol`/`hostMinProtocol` настоящего хоста (запись в «Отклонения»). Мутации: в `epoch_of` вернуть `.map_err(|_| LinkError::StreamRefused)` — FAIL `a_hello_of_an_incompatible_host…`; в `hold` убрать сброс `host_version` при `fresh_link` — исполнитель добавляет в `tests/connection.rs` тест «новое сопряжение начинает без версии хоста» по образцу существующего теста `restoreEpoch` и убеждается, что мутация его валит.

- [ ] **Step 5: Гейты и коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/host/protocol.ts apps/standalone/src/i18n/ru.json apps/standalone/test/connection.test.ts apps/standalone/test/host-status-line.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/src-tauri/src/connection.rs apps/standalone/src-tauri/tests/connection.rs apps/standalone/src/host/protocol.ts apps/standalone/src/i18n/ru.json apps/standalone/test/connection.test.ts apps/standalone/test/host-status-line.test.tsx
git commit -F /tmp/claude/msg-obn3-10.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the link names the host's version and why the versions do not match` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 11: Вебвью — правило «доступно обновление», `UpdatesApi`, `useHostUpdateOffer`, диалог «Обновить с хоста»

**Files:**

- Create: `apps/standalone/src/update/host-offer.ts`, `apps/standalone/src/update/updates-api.ts`, `apps/standalone/src/update/updates-context.tsx`, `apps/standalone/src/update/use-host-offer.ts`, `apps/standalone/src/update/UpdateFromHostDialog.tsx`, `apps/standalone/test/host-offer.test.ts`, `apps/standalone/test/updates-api.test.ts`, `apps/standalone/test/update-from-host-dialog.test.tsx`
- Modify: `apps/standalone/src/host/api.ts` (`getDeviceUpdate`, `getUpdateStatus`), `apps/standalone/src/app/App.tsx` (проп `updates`, хук, `UpdatesProvider`), `apps/standalone/src/i18n/ru.json` (`update.*`), `apps/standalone/test/support/office.tsx` (`fakeHostApi`)
- Test: три новых файла, `apps/standalone/test/api.test.ts`, `apps/standalone/test/app.test.tsx` (без изменений: PASS)

**Interfaces:**

- Consumes: `compareAppVersions`, `deviceUpdateOfferSchema`, `officeUpdateStatusSchema` (задача 1); `HostStatus.hostVersion`, `lastError: "app_too_old"` (задача 10); команды `update_fetch`, `update_check_manifest`, `update_stage` (задачи 8–9); ОБН-2: `UpdateShell` (`verify`, `install`), `useUpdateShell`, `UpdateShellProvider`, `VerifiedReport`, `refusalText`, `updateErrorText`, подтверждение `host_unreachable`.
- Produces: `hostUpdateOffer(input) → HostUpdateOffer` (`none` | `host_older` | `unavailable` | `needs_intermediate` | `available { required }`); `UpdatesApi { appVersion, checkManifest, fetch, stage }`, `createTauriUpdatesApi`, `UpdateError`, `UPDATE_ERROR_CODES`, `UPDATE_PROGRESS_EVENT`, `manifestViewSchema`; `UpdatesProvider`, `useUpdates`, `TAURI_UPDATES`; `useHostUpdateOffer({ link, paired, host, updates })`; `UpdateFromHostDialog { open, offer, onClose, start }` (скачать → `UpdateShell.verify` → `start(report)`); `HostApi.getDeviceUpdate()`, `HostApi.getUpdateStatus(token)`; `AppProps.updates`.

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/test/host-offer.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DeviceUpdateOffer } from "../src/host/distribution.js";
import { hostUpdateOffer, type HostOfferInput } from "../src/update/host-offer.js";
import type { ManifestView } from "../src/update/updates-api.js";

const MANIFEST: ManifestView = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: ["Лицензия площадки"],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 61234567,
};

const OFFER: DeviceUpdateOffer = {
  hostVersion: "0.3.0",
  package: { state: "ok", manifest: "a.b.c", version: "0.3.0", sizeBytes: 61234567, sha256: "ab" },
};

function input(overrides: Partial<HostOfferInput> = {}): HostOfferInput {
  return {
    appVersion: "0.2.1",
    hostVersion: "0.3.0",
    offer: OFFER,
    manifest: MANIFEST,
    appTooOld: false,
    ...overrides,
  };
}

describe("«Доступно обновление» (spec §10.11.5)", () => {
  it("holds when all four conditions do", () => {
    expect(hostUpdateOffer(input())).toEqual({
      kind: "available",
      hostVersion: "0.3.0",
      manifest: MANIFEST,
      required: false,
    });
    expect(hostUpdateOffer(input({ appTooOld: true }))).toMatchObject({ required: true });
  });

  it("1: the host must be newer than this PC; an older host is said, never a downgrade", () => {
    expect(hostUpdateOffer(input({ appVersion: "0.3.0" }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ hostVersion: null }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ appVersion: null }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ appVersion: "0.4.0" }))).toEqual({
      kind: "host_older",
      hostVersion: "0.3.0",
      appVersion: "0.4.0",
    });
  });

  it("2: the host must give a package of its own version", () => {
    for (const state of ["missing", "mismatch", "invalid", "verifying", "quarantined"]) {
      expect(
        hostUpdateOffer(input({ offer: { hostVersion: "0.3.0", package: { state } } })),
      ).toEqual({ kind: "unavailable", hostVersion: "0.3.0", reason: state });
    }
    expect(
      hostUpdateOffer(
        input({ offer: { ...OFFER, package: { ...OFFER.package, version: "0.2.9" } } }),
      ),
    ).toEqual({ kind: "unavailable", hostVersion: "0.3.0", reason: "version_differs" });
    expect(hostUpdateOffer(input({ offer: null }))).toMatchObject({ reason: "unread" });
  });

  it("3: this PC must not be below the manifest's minUpgradeFrom", () => {
    expect(hostUpdateOffer(input({ appVersion: "0.1.9" }))).toEqual({
      kind: "needs_intermediate",
      hostVersion: "0.3.0",
      minUpgradeFrom: "0.2.0",
    });
  });

  it("4: the manifest's signature must have checked out, and name the host's version", () => {
    expect(hostUpdateOffer(input({ manifest: { refused: "manifest_signature" } }))).toEqual({
      kind: "unavailable",
      hostVersion: "0.3.0",
      reason: "manifest_signature",
    });
    expect(hostUpdateOffer(input({ manifest: null }))).toMatchObject({ reason: "unread" });
    expect(hostUpdateOffer(input({ manifest: { ...MANIFEST, version: "0.3.1" } }))).toMatchObject({
      reason: "version_differs",
    });
  });
});
```

Создать `apps/standalone/test/updates-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createTauriUpdatesApi,
  UPDATE_ERROR_CODES,
  UPDATE_PROGRESS_EVENT,
  UpdateError,
} from "../src/update/updates-api.js";

type Handler = (event: { payload: unknown }) => void;

function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const listen = vi.fn(async (event: string, handler: Handler) => {
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  return { listen, handlers };
}

describe("the shell's update commands", () => {
  it("fetch reports progress while it runs and stops listening after", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      expect(command).toBe("update_fetch");
      events.handlers.get(UPDATE_PROGRESS_EVENT)?.({ payload: { received: 10, total: 20 } });
      return { version: "0.3.0", manifestPath: "C:\\u\\0.3.0\\m.update.jws", sizeBytes: 20 };
    });
    const api = createTauriUpdatesApi(call, events.listen, async () => "0.2.1");
    const seen: unknown[] = [];
    await expect(api.fetch((progress) => seen.push(progress))).resolves.toEqual({
      version: "0.3.0",
      manifestPath: "C:\\u\\0.3.0\\m.update.jws",
      sizeBytes: 20,
    });
    expect(seen).toEqual([{ received: 10, total: 20 }]);
    expect(events.handlers.size).toBe(0);
  });

  it("a bare code becomes an UpdateError of that code, anything else `refused`", async () => {
    const events = fakeEvents();
    for (const [rejection, code] of [
      ["needs_intermediate", "needs_intermediate"],
      ["host_mismatch", "host_mismatch"],
      [new Error("boom"), "refused"],
    ] as const) {
      const api = createTauriUpdatesApi(
        vi.fn(async () => {
          throw rejection;
        }),
        events.listen,
        async () => "0.2.1",
      );
      const failed = await api.checkManifest("x").catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(UpdateError);
      expect((failed as UpdateError).code).toBe(code);
    }
    expect(UPDATE_ERROR_CODES).toContain("package_verifying");
  });

  it("stage names its arguments as the shell reads them", async () => {
    const events = fakeEvents();
    const call = vi.fn(async () => ({ version: "0.3.0", sizeBytes: 20 }));
    const api = createTauriUpdatesApi(call, events.listen, async () => "0.2.1");
    await api.stage("D:\\Markiro\\m.update.jws", "token");
    expect(call).toHaveBeenCalledWith("update_stage", {
      manifestPath: "D:\\Markiro\\m.update.jws",
      officeToken: "token",
    });
  });
});
```

Создать `apps/standalone/test/update-from-host-dialog.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { UpdateShellProvider } from "../src/office/info/update-context.js";
import type { UpdateShell, VerifiedReport } from "../src/office/info/update-shell.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateFromHostDialog } from "../src/update/UpdateFromHostDialog.js";
import { UpdateError, type UpdatesApi } from "../src/update/updates-api.js";
import { UpdatesProvider } from "../src/update/updates-context.js";

const MANIFEST = {
  version: "0.3.0",
  channel: "beta",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: ["Лицензия площадки", "Раздача обновления через хост"],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 200,
};

const OFFER: Extract<HostUpdateOffer, { kind: "available" }> = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: MANIFEST,
};

const PATH =
  "C:\\Users\\st\\AppData\\Local\\app.markiro.standalone\\updates\\0.3.0\\markiro-standalone-0.3.0.update.jws";

/** `update_verify`'s report of the downloaded package (plan ОБН-2's shape). */
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: {
    v: 1,
    product: "markiro-standalone",
    version: "0.3.0",
    channel: "beta",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    installer: {
      name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
      sha256: "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
      sizeBytes: 200,
    },
    protocol: 4,
    minProtocol: 3,
    minUpgradeFrom: "0.2.0",
    notes: MANIFEST.notes,
  },
  installed: "0.2.1",
  installerPath: PATH.replace(".update.jws", "-windows-x86_64-setup.exe"),
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.3.0", protocol: 4, minProtocol: 3 },
};

function fakeUpdates(overrides: Partial<UpdatesApi> = {}): UpdatesApi {
  return {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => MANIFEST),
    fetch: vi.fn(async (onProgress) => {
      onProgress({ received: 100, total: 200 });
      return { version: "0.3.0", manifestPath: PATH, sizeBytes: 200 };
    }),
    stage: vi.fn(async () => ({ version: "0.3.0", sizeBytes: 200 })),
    ...overrides,
  };
}

function fakeShell(report: VerifiedReport = REPORT): UpdateShell {
  return {
    scan: vi.fn(async () => []),
    verify: vi.fn(async () => report),
    install: vi.fn(async () => undefined),
    outcome: vi.fn(async () => null),
    dismissOutcome: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
  };
}

function open(
  updates: UpdatesApi,
  shell: UpdateShell,
  start = vi.fn<(report: VerifiedReport) => Promise<void>>(async () => undefined),
) {
  const onClose = vi.fn();
  render(
    <ThemeProvider defaultTheme="dark">
      <UpdatesProvider value={updates}>
        <UpdateShellProvider value={shell}>
          <UpdateFromHostDialog open offer={OFFER} onClose={onClose} start={start} />
        </UpdateShellProvider>
      </UpdatesProvider>
    </ThemeProvider>,
  );
  return { onClose, start };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("«Обновить с хоста»", () => {
  it("shows the notes as text, downloads, checks the package again and starts it", async () => {
    const updates = fakeUpdates();
    const shell = fakeShell();
    const { onClose, start } = open(updates, shell);
    expect(screen.getByText("Бета-версия")).toBeTruthy();
    expect(screen.getByText("Раздача обновления через хост")).toBeTruthy();
    await click("Скачать с хоста");
    expect(updates.fetch).toHaveBeenCalledTimes(1);
    expect(shell.verify).toHaveBeenCalledWith(PATH);
    await click("Установить обновление");
    expect(start).toHaveBeenCalledWith(REPORT);
    expect(onClose).toHaveBeenCalled();
  });

  it("explains a refused download and moves the focus to it", async () => {
    open(
      fakeUpdates({
        fetch: vi.fn(async () => Promise.reject(new UpdateError("update_busy", "x"))),
      }),
      fakeShell(),
    );
    await click("Скачать с хоста");
    const alert = screen.getByText(
      "С хоста уже скачивают обновление три устройства. Повторите через полминуты.",
    );
    expect(alert.closest("[tabindex='-1']")).toBe(document.activeElement);
  });

  it("asks before installing while the host is silent", async () => {
    const shell = fakeShell({ ...REPORT, host: null, confirmations: ["host_unreachable"] });
    const { start } = open(fakeUpdates(), shell);
    await click("Скачать с хоста");
    expect(screen.getByText(/Хост не отвечает/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    await click("Установить без проверки хоста");
    expect(start).toHaveBeenCalledWith({
      ...REPORT,
      host: null,
      confirmations: ["host_unreachable"],
    });
  });

  it("refuses a package the host no longer runs, with no button to install", async () => {
    const shell = fakeShell({ ...REPORT, refusal: { code: "host_differs", hostVersion: "0.2.9" } });
    const { start } = open(fakeUpdates(), shell);
    await click("Скачать с хоста");
    expect(screen.getByText(/Хост работает на версии 0\.2\.9, а пакет — другой/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
```

В `apps/standalone/test/api.test.ts` добавить (по образцу соседних тестов `createHostApi` с поддельным клиентом):

<!-- prettier-ignore -->
```ts
  it("reads the device's update offer and the office's update status", async () => {
    const { client, requests } = recordingClient([
      fixtureOf("device-update-offer.json"),
      fixtureOf("office-update-status.json"),
    ]);
    const api = createHostApi(client);
    expect((await api.getDeviceUpdate()).package.state).toBe("ok");
    expect((await api.getUpdateStatus("token")).devices).toHaveLength(5);
    expect(requests).toEqual([
      { method: "GET", path: "/v1/device/update" },
      { method: "GET", path: "/v1/office/update-status", officeToken: "token" },
    ]);
  });
```

(`recordingClient`/`fixtureOf` — помощники `test/api.test.ts`; если их нет под этими именами — по образцу ближайшего теста, записывающего запросы, с записью в «Отклонения».)

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-offer.test.ts test/updates-api.test.ts test/update-from-host-dialog.test.tsx test/api.test.ts
```

Ожидается: FAIL — модули `src/update/*` не найдены; `getDeviceUpdate` не функция.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/update/updates-api.ts`:

```ts
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

// The shell's commands of the distribution through the host (plan ОБН-3,
// src-tauri `update::fetch`, `update::stage`). The check and the launch are
// plan ОБН-2's (`office/info/update-shell.ts`). The webview never sees the
// installer: it gets paths the shell found or wrote.

/** `update_check_manifest`: a manifest whose signature checked out, as it is shown. */
export const manifestViewSchema = z
  .object({
    version: z.string(),
    channel: z.string(),
    releasedAt: z.string(),
    notes: z.array(z.string()),
    minUpgradeFrom: z.string(),
    protocol: z.number().int().nonnegative(),
    minProtocol: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ManifestView = z.infer<typeof manifestViewSchema>;

const fetchedSchema = z
  .object({
    version: z.string(),
    manifestPath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type FetchedPackage = z.infer<typeof fetchedSchema>;

const stagedSchema = z
  .object({ version: z.string(), sizeBytes: z.number().int().nonnegative() })
  .strict();
export type StagedPackage = z.infer<typeof stagedSchema>;

const progressSchema = z
  .object({ received: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
  .strict();
export type FetchProgress = z.infer<typeof progressSchema>;

/** `{ received, total }` while `update_fetch` downloads. */
export const UPDATE_PROGRESS_EVENT = "standalone://update-progress";

/** The bare codes of `update_fetch`, `update_stage` and `update_check_manifest` (plan ОБН-2's commands have their own, `UPDATE_SHELL_CODES`). */
export const UPDATE_ERROR_CODES = [
  "not_paired",
  "unreachable",
  "certificate_mismatch",
  "key_rejected",
  "package_unavailable",
  "package_verifying",
  "update_busy",
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "not_newer",
  "host_mismatch",
  "needs_intermediate",
  "too_long",
  "hash_mismatch",
  "interrupted",
  "storage",
  "invalid_request",
  "not_found",
  "session_ended",
  "forbidden",
  "package_not_newer",
  "manifest_refused",
  "installer_refused",
  "disk_full",
  "refused",
] as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

/** Every member is a function-typed property (`@typescript-eslint/unbound-method`). */
export interface UpdatesApi {
  /** This build's version (`tauri.conf.json`). */
  appVersion: () => Promise<string>;
  checkManifest: (manifest: string) => Promise<ManifestView>;
  /** The host's package into this PC's local data; `onProgress` while it runs. */
  fetch: (onProgress: (progress: FetchProgress) => void) => Promise<FetchedPackage>;
  /** A found package to the host, with the office session. */
  stage: (manifestPath: string, officeToken: string) => Promise<StagedPackage>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

function failure(command: string, error: unknown): UpdateError {
  const code = UPDATE_ERROR_CODES.find((candidate) => candidate === error);
  return new UpdateError(code ?? "refused", `${command}: ${String(error)}`);
}

export function createTauriUpdatesApi(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
  version: () => Promise<string> = getVersion,
): UpdatesApi {
  async function run<T>(
    command: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let answer: unknown;
    try {
      answer = await call(command, args);
    } catch (error) {
      throw failure(command, error);
    }
    return schema.parse(answer);
  }
  return {
    appVersion: version,
    checkManifest: (manifest) => run("update_check_manifest", { manifest }, manifestViewSchema),
    fetch: async (onProgress) => {
      const stop = await subscribe(UPDATE_PROGRESS_EVENT, (event) => {
        const parsed = progressSchema.safeParse(event.payload);
        if (parsed.success) onProgress(parsed.data);
      });
      try {
        return await run("update_fetch", {}, fetchedSchema);
      } finally {
        stop();
      }
    },
    stage: (manifestPath, officeToken) =>
      run("update_stage", { manifestPath, officeToken }, stagedSchema),
  };
}
```

Проверка и запуск скачанного пакета — команды ОБН-2 (`UpdateShell.verify`, `UpdateShell.install`, `runUpdate`); `UpdatesApi` их не дублирует.

Создать `apps/standalone/src/update/updates-context.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import { createTauriUpdatesApi, type UpdatesApi } from "./updates-api.js";

/** The shell's update commands; a test passes its own through `UpdatesProvider`. */
export const TAURI_UPDATES: UpdatesApi = createTauriUpdatesApi();

const UpdatesContext = createContext<UpdatesApi>(TAURI_UPDATES);

export function UpdatesProvider({ value, children }: { value: UpdatesApi; children: ReactNode }) {
  return <UpdatesContext value={value}>{children}</UpdatesContext>;
}

export function useUpdates(): UpdatesApi {
  return useContext(UpdatesContext);
}
```

Создать `apps/standalone/src/update/host-offer.ts`:

```ts
import { compareAppVersions, type DeviceUpdateOffer } from "../host/distribution.js";
import type { ManifestView } from "./updates-api.js";

/** What this PC's update from the host is (spec §10.11.5). */
export type HostUpdateOffer =
  /** The host is not newer, or one version is unknown. */
  | { kind: "none" }
  /** The host is older than this PC: update the host. Never a downgrade. */
  | { kind: "host_older"; hostVersion: string; appVersion: string }
  /** The host is newer but gives no package of its version; `reason` is its state or the refusal. */
  | { kind: "unavailable"; hostVersion: string; reason: string }
  /** This PC is below the package's `minUpgradeFrom`: an intermediate version from a file first. */
  | { kind: "needs_intermediate"; hostVersion: string; minUpgradeFrom: string }
  /** All four conditions hold; `required` while the host refuses this app (`app_too_old`). */
  | { kind: "available"; hostVersion: string; manifest: ManifestView; required: boolean };

export interface HostOfferInput {
  appVersion: string | null;
  /** `hello.version` as the link read it. */
  hostVersion: string | null;
  /** `GET /v1/device/update`, or `null` when it was not read. */
  offer: DeviceUpdateOffer | null;
  /** The shell's check of the offer's manifest: its view, or the code it refused with. */
  manifest: ManifestView | { refused: string } | null;
  appTooOld: boolean;
}

const NONE: HostUpdateOffer = { kind: "none" };

/**
 * «Доступно обновление» — when, at once: (1) the host is newer than this PC;
 * (2) it gives a package (`ok`) of exactly its version; (3) this PC is not
 * below the manifest's `minUpgradeFrom`; (4) the manifest's signature
 * checked out. A host older than this PC is said, never offered.
 */
export function hostUpdateOffer(input: HostOfferInput): HostUpdateOffer {
  const { appVersion, hostVersion, offer, manifest, appTooOld } = input;
  if (appVersion === null || hostVersion === null) return NONE;
  const order = compareAppVersions(hostVersion, appVersion);
  if (order === null || order === 0) return NONE;
  if (order < 0) return { kind: "host_older", hostVersion, appVersion };
  if (offer === null) return { kind: "unavailable", hostVersion, reason: "unread" };
  if (offer.package.state !== "ok") {
    return { kind: "unavailable", hostVersion, reason: offer.package.state };
  }
  const packaged = offer.package.version;
  if (packaged === undefined || compareAppVersions(packaged, hostVersion) !== 0) {
    return { kind: "unavailable", hostVersion, reason: "version_differs" };
  }
  if (manifest === null) return { kind: "unavailable", hostVersion, reason: "unread" };
  if ("refused" in manifest) return { kind: "unavailable", hostVersion, reason: manifest.refused };
  if (compareAppVersions(manifest.version, hostVersion) !== 0) {
    return { kind: "unavailable", hostVersion, reason: "version_differs" };
  }
  const floor = compareAppVersions(appVersion, manifest.minUpgradeFrom);
  if (floor === null || floor < 0) {
    return { kind: "needs_intermediate", hostVersion, minUpgradeFrom: manifest.minUpgradeFrom };
  }
  return { kind: "available", hostVersion, manifest, required: appTooOld };
}
```

Создать `apps/standalone/src/update/use-host-offer.ts`:

```ts
import { useEffect, useState } from "react";

import type { HostApi } from "../host/api.js";
import { compareAppVersions, type DeviceUpdateOffer } from "../host/distribution.js";
import type { HostStatus } from "../host/protocol.js";
import { hostUpdateOffer, type HostOfferInput, type HostUpdateOffer } from "./host-offer.js";
import { UpdateError, type UpdatesApi } from "./updates-api.js";

interface OfferRead {
  key: string;
  offer: DeviceUpdateOffer | null;
  manifest: HostOfferInput["manifest"];
}

/**
 * The update the host offers this PC, for the office's banner, the
 * station's line and the version screen. The offer is read (with the shell
 * checking its manifest) only while the host is newer than this PC, again
 * when the host's version changes and each time the link comes online or
 * the host refuses this app; never on a timer.
 */
export function useHostUpdateOffer({
  link,
  paired,
  host,
  updates,
}: {
  link: HostStatus | null;
  paired: boolean;
  host: Pick<HostApi, "getDeviceUpdate">;
  updates: Pick<UpdatesApi, "appVersion" | "checkManifest">;
}): HostUpdateOffer {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    updates.appVersion().then(
      (version) => {
        if (alive) setAppVersion(version);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [updates]);
  const hostVersion = link?.hostVersion ?? null;
  const appTooOld = link?.lastError === "app_too_old";
  const newer =
    paired &&
    appVersion !== null &&
    hostVersion !== null &&
    compareAppVersions(hostVersion, appVersion) === 1;
  const moment = link?.state === "online" ? "online" : appTooOld ? "too_old" : "away";
  const key = newer ? `${hostVersion}:${moment}` : null;
  const [read, setRead] = useState<OfferRead | null>(null);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void (async () => {
      let offer: DeviceUpdateOffer | null = null;
      let manifest: OfferRead["manifest"] = null;
      try {
        offer = await host.getDeviceUpdate();
        const text = offer.package.state === "ok" ? offer.package.manifest : undefined;
        if (text !== undefined) {
          manifest = await updates.checkManifest(text).catch((error: unknown) => ({
            refused: error instanceof UpdateError ? error.code : "refused",
          }));
        }
      } catch {
        offer = null;
      }
      if (alive) setRead({ key, offer, manifest });
    })();
    return () => {
      alive = false;
    };
  }, [key, host, updates]);
  const current = read !== null && read.key === key ? read : null;
  return hostUpdateOffer({
    appVersion,
    hostVersion,
    offer: current?.offer ?? null,
    manifest: current?.manifest ?? null,
    appTooOld,
  });
}
```

Создать `apps/standalone/src/update/UpdateFromHostDialog.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal } from "@markiro/ui";

import { useUpdateShell } from "../office/info/update-context.js";
import type { VerifiedReport } from "../office/info/update-shell.js";
import { refusalText, updateErrorText } from "../office/info/UpdateSection.js";
import type { HostUpdateOffer } from "./host-offer.js";
import { UpdateError } from "./updates-api.js";
import { useUpdates } from "./updates-context.js";

type Step =
  | { step: "idle" }
  | { step: "downloading"; received: number; total: number }
  | { step: "checking" }
  | { step: "ready"; report: VerifiedReport }
  | { step: "starting"; report: VerifiedReport }
  | { step: "failed"; message: string; report: VerifiedReport | null };

export interface UpdateFromHostDialogProps {
  open: boolean;
  offer: Extract<HostUpdateOffer, { kind: "available" }>;
  onClose: () => void;
  /**
   * Starts the checked package. In the office: plan ОБН-2's `runUpdate`
   * with the source `host` (a copy first on the host's PC, the
   * `app.update.start` row, the launch). Where no office opens (the
   * version screen, a station the host refuses): the shell's
   * `update_install` alone — Windows' administrator prompt is the
   * permission (ЛО16).
   */
  start: (report: VerifiedReport) => Promise<void>;
}

/**
 * «Обновить с хоста» (spec §10.11.4–10.11.5): the notes as text, «Скачать с
 * хоста» with its progress, then the shell checks the downloaded package
 * again (plan ОБН-2's `update_verify`: the signature, the SHA-256 through a
 * handle nobody else may write, the host on the package's very version) and
 * only then «Установить обновление». Nothing starts on its own; a silent
 * host is asked about first (ЛО12); a refusal leaves no button to install.
 */
export function UpdateFromHostDialog({ open, offer, onClose, start }: UpdateFromHostDialogProps) {
  const { t } = useTranslation();
  const updates = useUpdates();
  const shell = useUpdateShell();
  const [state, setState] = useState<Step>({ step: "idle" });
  const failure = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.step === "failed") failure.current?.focus();
  }, [state.step]);
  const busy =
    state.step === "downloading" || state.step === "checking" || state.step === "starting";

  const download = async () => {
    setState({ step: "downloading", received: 0, total: offer.manifest.sizeBytes });
    let manifestPath: string;
    try {
      const fetched = await updates.fetch(({ received, total }) =>
        setState({ step: "downloading", received, total }),
      );
      manifestPath = fetched.manifestPath;
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : "refused";
      setState({ step: "failed", message: t(`update.errors.${code}`), report: null });
      return;
    }
    setState({ step: "checking" });
    try {
      const report = await shell.verify(manifestPath);
      const refused = refusalText(t, report);
      setState(
        refused === null
          ? { step: "ready", report }
          : { step: "failed", message: refused, report: null },
      );
    } catch (error) {
      setState({ step: "failed", message: updateErrorText(t, error), report: null });
    }
  };

  const install = async (report: VerifiedReport) => {
    setState({ step: "starting", report });
    try {
      await start(report);
      onClose();
    } catch (error) {
      setState({ step: "failed", message: updateErrorText(t, error), report });
    }
  };

  const percent =
    state.step === "downloading" && state.total > 0
      ? Math.floor((state.received * 100) / state.total)
      : 0;
  // The checked package, when there is one to start (again, after a failed start).
  const report = state.step === "ready" || state.step === "failed" ? state.report : null;
  const silent = report?.confirmations.includes("host_unreachable") ?? false;

  let action: ReactNode = null;
  if (state.step === "idle" || (state.step === "failed" && state.report === null)) {
    action = <Button onClick={() => void download()}>{t("update.dialog.download")}</Button>;
  } else if (state.step === "downloading" || state.step === "checking") {
    action = <Button loading>{t("update.dialog.download")}</Button>;
  } else if (state.step === "starting") {
    action = <Button loading>{t("update.dialog.install")}</Button>;
  } else if (report !== null) {
    action = silent ? (
      <Button variant="destructive" onClick={() => void install(report)}>
        {t("update.dialog.installAnyway")}
      </Button>
    ) : (
      <Button onClick={() => void install(report)}>{t("update.dialog.install")}</Button>
    );
  }

  return (
    <Modal
      open={open}
      title={t("update.dialog.title", { version: offer.manifest.version })}
      closeLabel={t("update.dialog.close")}
      {...(busy ? {} : { onClose })}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("update.dialog.cancel")}
          </Button>
          {action}
        </>
      }
    >
      {offer.manifest.channel === "beta" && <Alert tone="info">{t("update.dialog.beta")}</Alert>}
      <p>{t("update.dialog.from", { host: offer.hostVersion })}</p>
      <ul className="update-notes">
        {offer.manifest.notes.map((note, index) => (
          // Notes are plain text and may repeat; their order is their identity.
          <li key={`${index}:${note}`}>{note}</li>
        ))}
      </ul>
      <p className="office-note">{t("update.dialog.uac")}</p>
      <div aria-live="polite">
        {state.step === "downloading" && <p>{t("update.dialog.progress", { percent })}</p>}
        {state.step === "checking" && <p>{t("update.dialog.checking")}</p>}
        {state.step === "ready" && !silent && <p>{t("update.dialog.checked")}</p>}
      </div>
      {silent && report !== null && <Alert tone="warn">{t("update.dialog.hostSilent")}</Alert>}
      {state.step === "failed" && (
        <div ref={failure} tabIndex={-1}>
          <Alert tone="error">{state.message}</Alert>
        </div>
      )}
    </Modal>
  );
}
```

Правка `apps/standalone/src/host/api.ts`:

Фрагмент 1 (конец интерфейса `HostApi`):

<!-- prettier-ignore -->
```ts
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
  /** `GET /v1/device/update` (plan ОБН-3): the host's version and package; any protocol, the device key. */
  getDeviceUpdate: () => Promise<DeviceUpdateOffer>;
  /** `GET /v1/office/update-status` (plan ОБН-3): every office role. */
  getUpdateStatus: (token: string) => Promise<OfficeUpdateStatus>;
}
```

Фрагмент 2 (конец `createHostApi`):

<!-- prettier-ignore -->
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

<!-- prettier-ignore -->
```ts
    resumeFacts: (token) =>
      client.request("POST", "/v1/office/backups/resume", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    getDeviceUpdate: () =>
      client.request("GET", "/v1/device/update", { schema: deviceUpdateOfferSchema }),
    getUpdateStatus: (token) =>
      client.request("GET", "/v1/office/update-status", {
        officeToken: token,
        schema: officeUpdateStatusSchema,
      }),
  };
}
```

и в импорты `api.ts` добавить:

```ts
import {
  deviceUpdateOfferSchema,
  officeUpdateStatusSchema,
  type DeviceUpdateOffer,
  type OfficeUpdateStatus,
} from "./distribution.js";
```

Правка `apps/standalone/test/support/office.tsx` — в `fakeHostApi` после `resumeFacts`:

<!-- prettier-ignore -->
```ts
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
```

заменить на:

<!-- prettier-ignore -->
```ts
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    // The host is never newer in a test about something else: no offer is read.
    getDeviceUpdate: vi.fn<HostApi["getDeviceUpdate"]>(() => unexpected("getDeviceUpdate")),
    getUpdateStatus: vi.fn<HostApi["getUpdateStatus"]>(() => unexpected("getUpdateStatus")),
```

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1 (`AppProps`):

<!-- prettier-ignore -->
```ts
  /** Kiosk mode of the window: the shell's commands outside development by default. */
  lockdown?: LockdownLifecycle;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** Kiosk mode of the window: the shell's commands outside development by default. */
  lockdown?: LockdownLifecycle;
  /** The shell's update commands (plan ОБН-3); tests give their own. */
  updates?: UpdatesApi;
}
```

Фрагмент 2 (деструктуризация):

<!-- prettier-ignore -->
```ts
  signInSyncGapMs = SIGN_IN_SYNC_GAP_MS,
  lockdown,
}: AppProps) {
```

заменить на:

<!-- prettier-ignore -->
```ts
  signInSyncGapMs = SIGN_IN_SYNC_GAP_MS,
  lockdown,
  updates = TAURI_UPDATES,
}: AppProps) {
```

Фрагмент 3 (после строки `const pairedStatus = …`):

<!-- prettier-ignore -->
```ts
  const pairedStatus = state.device.kind === "ready" ? state.device.status : null;
```

заменить на:

<!-- prettier-ignore -->
```ts
  const pairedStatus = state.device.kind === "ready" ? state.device.status : null;
  // The update the host offers this PC (plan ОБН-3): the office's banner, the
  // station's line off the work screen and the version screen read it.
  const updateOffer = useHostUpdateOffer({
    link: state.link,
    paired: pairedStatus !== null,
    host: hostApi,
    updates,
  });
```

Корневой элемент разметки `App` обернуть в `<UpdatesProvider value={updates}>…</UpdatesProvider>` (по месту возвращаемого JSX). Импорты: `TAURI_UPDATES`, `UpdatesProvider` из `../update/updates-context.js`, `useHostUpdateOffer` из `../update/use-host-offer.js`, `type UpdatesApi` из `../update/updates-api.js`. `updateOffer` в этой задаче ещё не читается (задача 13 передаёт его вниз): чтобы линтер не ругался на неиспользуемую переменную, задача 11 передаёт его пропом `updateOffer` в `Office` (проп вводится в задаче 13; до неё — `void updateOffer;` с комментарием «задача 13»). Исполнитель может слить задачи 11 и 13 по `App.tsx`, если так чище, и записать это.

Правка `apps/standalone/src/i18n/ru.json` — новый корневой раздел `update` (рядом с `errors`):

<!-- prettier-ignore -->
```json
  "update": {
    "dialog": {
      "title": "Обновление {{version}} с хоста",
      "from": "Хост площадки уже работает на версии {{host}}. Установщик скачается с хоста по локальной сети.",
      "beta": "Бета-версия",
      "uac": "Windows спросит учётную запись администратора. Приложение закроется на 1–3 минуты и откроется снова.",
      "download": "Скачать с хоста",
      "progress": "Скачано {{percent}} %",
      "checking": "Проверяем подпись пакета и установщик…",
      "checked": "Подпись проверена: выпуск Маркиро. Установщик совпадает с пакетом.",
      "install": "Установить обновление",
      "installAnyway": "Установить без проверки хоста",
      "hostSilent": "Хост не отвечает: проверить, что он на той же версии, нельзя. Если хост откатили, этот ПК может стать несовместимым с ним. Устанавливайте, только если уверены.",
      "cancel": "Отмена",
      "close": "Закрыть"
    },
    "errors": {
      "not_paired": "Этот компьютер не подключён к хосту.",
      "unreachable": "Хост не отвечает. Проверьте связь и повторите.",
      "certificate_mismatch": "Сертификат хоста не совпадает с сохранённым при подключении.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "package_unavailable": "На хосте нет пакета обновления его версии. Загрузите пакет на хост в разделе «Информация» → «Обновление».",
      "package_verifying": "Хост заново проверяет пакет обновления. Повторите через минуту.",
      "update_busy": "С хоста уже скачивают обновление три устройства. Повторите через полминуты.",
      "manifest_malformed": "Пакет обновления повреждён или это не пакет Маркиро.",
      "manifest_unknown_key": "Пакет подписан ключом, который эта версия не знает. Обновите этот ПК из файла.",
      "manifest_signature": "Подпись пакета не сходится: пакет изменён после выпуска. Установка невозможна.",
      "not_newer": "Эта версия не новее установленной: понижения версии нет.",
      "host_mismatch": "Хост работает на другой версии, чем этот пакет: установка отменена. Проверьте хост.",
      "needs_intermediate": "Этот ПК слишком старый для прямого обновления: сначала установите промежуточную версию из файла.",
      "too_long": "Хост прислал больше данных, чем в пакете: скачанное удалено. Повторите.",
      "hash_mismatch": "Скачанный установщик не совпадает с пакетом: файл удалён. Скачайте снова.",
      "interrupted": "Скачивание прервалось. Нажмите «Скачать с хоста» — оно продолжится с места обрыва.",
      "storage": "Не удалось записать файл на этом компьютере.",
      "invalid_request": "Этот пакет не из найденных приложением.",
      "not_found": "Файл пакета не найден: его убрали с диска.",
      "session_ended": "Сессия офиса закончилась. Войдите снова.",
      "forbidden": "Загружать пакет на хост может только администратор.",
      "package_not_newer": "Пакет не новее версии хоста: загружать его не нужно.",
      "manifest_refused": "Хост не принял манифест пакета: подпись не сходится или файл повреждён.",
      "installer_refused": "Хост не принял установщик: размер или контрольная сумма не совпадают с манифестом.",
      "disk_full": "На диске хоста нет места для пакета. Текущий пакет не тронут.",
      "refused": "Хост отказал. Повторите позже."
    }
  },
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-offer.test.ts test/updates-api.test.ts test/update-from-host-dialog.test.tsx test/api.test.ts test/app.test.tsx
```

Ожидается: PASS; `app.test.tsx` — без изменений (связь в тестах приложения не называет версии хоста, предложение не читается). Новые файлы с React — один прогон `--reporter=verbose` (нет `stderr |`). Мутация: в `hostUpdateOffer` убрать проверку `minUpgradeFrom` — FAIL «3: this PC must not be below…».

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/update apps/standalone/src/host/api.ts apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/host-offer.test.ts apps/standalone/test/updates-api.test.ts apps/standalone/test/update-from-host-dialog.test.tsx apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/src/update apps/standalone/src/host/api.ts apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/host-offer.test.ts apps/standalone/test/updates-api.test.ts apps/standalone/test/update-from-host-dialog.test.tsx apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx
git commit -F /tmp/claude/msg-obn3-11.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the webview's rule of an available update, the shell's update commands and «Обновить с хоста»` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 12: Раздел «Обновление» — «С хоста», «Загрузить пакет на хост», «Устройства и версии», сведения для поддержки

**Files:**

- Create: `apps/standalone/src/update/offer-context.tsx`, `apps/standalone/src/office/info/update-status.ts`, `apps/standalone/src/office/info/DeviceVersionsBlock.tsx`, `apps/standalone/src/office/info/HostUpdateBlock.tsx`, `apps/standalone/src/office/info/StageToHostButton.tsx`, `apps/standalone/src/office/info/update-support.ts`, `apps/standalone/test/update-status.test.ts`, `apps/standalone/test/update-section-host.test.tsx`
- Modify: `apps/standalone/src/office/Office.tsx` (пропы `updateOffer`, `updates`), `apps/standalone/src/app/App.tsx` (передать их в `Office`), `apps/standalone/src/office/office-query.ts` (`officeKeys.updateStatus`), `apps/standalone/src/office/info/support-blocks.ts` (`SupportContext.office`, вкладчик), `apps/standalone/src/office/info/SupportSection.tsx`, файлы ОБН-2: `apps/standalone/src/office/info/UpdateSection.tsx` (блоки), `apps/standalone/src/office/info/update-flow.ts` (`runUpdate(…, source)`), `apps/standalone/test/update-flow.test.ts`; `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css` (строки таблицы и заметок)
- Test: два новых файла, `apps/standalone/test/support-report.test.ts` (каркас: PASS), `apps/standalone/test/about-page.test.tsx` (каркас: PASS)

**Interfaces:**

- Consumes: `HostApi.getUpdateStatus`, `UpdatesApi.stage`, `UpdateFromHostDialog`, `HostUpdateOffer` (задача 11); `useAboutData` (роль ПК, версия), `useOfficeSession`, `useOfficeQuery`, `useBackupTime`, `formatSize`; компонент предупреждений ОБН-2 перед установкой; `SUPPORT_CONTRIBUTORS`.
- Produces: `UpdateOfferProvider`, `useUpdateOffer` (по умолчанию `{ kind: "none" }`); `OfficeProps.updateOffer`, `OfficeProps.updates`; `officeKeys.updateStatus`; `summarize`, `packageStateKey`, `DEVICE_STATE_PHASE`; блоки `HostUpdateBlock` (не на ПК хоста; «Обновить с хоста» — только администратор), `DeviceVersionsBlock` (обе роли), `StageToHostButton` (только администратор); `updateDistributionContributor` в `SUPPORT_CONTRIBUTORS`; `SupportContext.office: OfficeSessionValue | null` (Д18).

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/test/update-status.test.ts`:

```ts
import { readFileSync } from "node:fs";

import i18n from "i18next";
import { describe, expect, it } from "vitest";

import { officeUpdateStatusSchema } from "../src/host/distribution.js";
import { packageStateKey, summarize } from "../src/office/info/update-status.js";
import { updateDistributionContributor } from "../src/office/info/update-support.js";
import { fakeOfficeSession } from "./support/office.js";

const testModuleUrl = import.meta.url;
const STATUS = officeUpdateStatusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-update-status.json", testModuleUrl), "utf8"),
  ) as unknown,
);

describe("«Устройства и версии»", () => {
  it("counts the devices by state", () => {
    expect(summarize(STATUS)).toEqual({
      hostVersion: "0.3.0",
      total: 5,
      current: 1,
      behind: 1,
      incompatible: 1,
      newer: 1,
      unknown: 1,
    });
  });

  it("names a newer host's package state as unknown", () => {
    expect(packageStateKey("ok")).toBe("ok");
    expect(packageStateKey("quarantined")).toBe("unknown");
  });

  it("adds a support block of the package and the devices, without a hash", async () => {
    const session = fakeOfficeSession();
    session.api.getUpdateStatus.mockResolvedValue(STATUS);
    const block = await updateDistributionContributor({
      t: i18n.t.bind(i18n),
      facts: { generatedAt: new Date("2026-11-03T09:00:00Z") } as never,
      about: {} as never,
      office: session,
    });
    expect(block?.title).toBe("Раздача обновления");
    expect(block?.lines).toContainEqual(["Пакет на хосте", "проверен, 0.3.0"]);
    expect(block?.lines).toContainEqual([
      "Станция линии 2 (station)",
      "0.2.1 · протокол 3 · отстаёт",
    ]);
    expect(JSON.stringify(block)).not.toContain("7863191b");
    await expect(
      updateDistributionContributor({
        t: i18n.t.bind(i18n),
        facts: {} as never,
        about: {} as never,
        office: null,
      }),
    ).resolves.toBeNull();
  });
});
```

(Приведения `as never` — только в тесте, для полей контекста, которые вкладчик не читает; в исходниках приведений нет.)

Создать `apps/standalone/test/update-section-host.test.tsx`:

```tsx
import { readFileSync } from "node:fs";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { officeUpdateStatusSchema } from "../src/host/distribution.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { DeviceVersionsBlock } from "../src/office/info/DeviceVersionsBlock.js";
import { HostUpdateBlock } from "../src/office/info/HostUpdateBlock.js";
import { StageToHostButton } from "../src/office/info/StageToHostButton.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateOfferProvider } from "../src/update/offer-context.js";
import { UpdateError, type UpdatesApi } from "../src/update/updates-api.js";
import { UpdatesProvider } from "../src/update/updates-context.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const testModuleUrl = import.meta.url;
const STATUS = officeUpdateStatusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-update-status.json", testModuleUrl), "utf8"),
  ) as unknown,
);

const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: ["Раздача обновления через хост"],
    minUpgradeFrom: "0.2.0",
    protocol: 4,
    minProtocol: 3,
    sizeBytes: 200,
  },
};

function about(role: "host" | "station" | "office"): AboutApi {
  return {
    appVersion: async () => "0.2.1",
    installRole: async () => role,
    pairing: async () => DEVICE_STATUS,
    hello: async () => observation(true),
    system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
    openLink: async () => undefined,
  };
}

function fakeUpdates(overrides: Partial<UpdatesApi> = {}): UpdatesApi {
  return {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => {
      throw new UpdateError("refused", "x");
    }),
    fetch: vi.fn(async () => ({ version: "0.3.0", manifestPath: "m", sizeBytes: 200 })),
    stage: vi.fn(async () => ({ version: "0.4.0", sizeBytes: 200 })),
    ...overrides,
  };
}

function sessionOf(user?: typeof TECHNOLOGIST): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getUpdateStatus.mockResolvedValue(STATUS);
  return session;
}

function renderWith(
  node: ReactNode,
  {
    session = sessionOf(),
    role = "station",
    offer = AVAILABLE,
    updates = fakeUpdates(),
  }: {
    session?: FakeOfficeSession;
    role?: "host" | "station" | "office";
    offer?: HostUpdateOffer;
    updates?: UpdatesApi;
  } = {},
) {
  render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <AboutProvider value={about(role)}>
            <UpdatesProvider value={updates}>
              <UpdateOfferProvider value={offer}>{node}</UpdateOfferProvider>
            </UpdatesProvider>
          </AboutProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { session, updates };
}

describe("«Устройства и версии»", () => {
  it("shows the summary, the host's package and every device's state in words", async () => {
    renderWith(<DeviceVersionsBlock />, { session: sessionOf(TECHNOLOGIST) });
    expect(
      await screen.findByText(
        "Хост: 0.3.0. Актуальны: 1 из 5; отстают: 1; несовместимы: 1; новее хоста: 1; версия неизвестна: 1",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Пакет обновления 0\.3\.0 на хосте проверен/)).toBeTruthy();
    for (const state of [
      "Актуальная",
      "Отстаёт, совместима",
      "Несовместима — не подключится",
      "Новее хоста",
      "Неизвестно",
    ]) {
      expect(screen.getByText(state)).toBeTruthy();
    }
    expect(screen.getByText(/Запущена установка/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "История обновлений", level: 4 })).toBeTruthy();
  });
});

describe("«С хоста»", () => {
  it("offers the administrator the update and opens «Обновить с хоста»", async () => {
    renderWith(<HostUpdateBlock />);
    expect(
      await screen.findByText(
        "Хост работает на версии 0.3.0, этот ПК — 0.2.1. Доступно обновление.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(screen.getByRole("dialog", { name: "Обновление 0.3.0 с хоста" })).toBeTruthy();
  });

  it("tells the technologist that an administrator installs it", async () => {
    renderWith(<HostUpdateBlock />, { session: sessionOf(TECHNOLOGIST) });
    expect(await screen.findByText("Доступно обновление; установит администратор.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Обновить с хоста" })).toBeNull();
  });

  it("is not on the host's PC, which updates from a file", async () => {
    renderWith(<HostUpdateBlock />, { role: "host" });
    // The role is read once; after it the block stays empty.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("heading", { name: "С хоста" })).toBeNull();
  });

  it("explains a host that gives no package and one older than this PC", async () => {
    renderWith(<HostUpdateBlock />, {
      offer: { kind: "unavailable", hostVersion: "0.3.0", reason: "missing" },
    });
    expect(await screen.findByText(/на нём нет пакета обновления этой версии/)).toBeTruthy();
  });
});

describe("«Загрузить пакет на хост»", () => {
  it("stages a found package with the session and says so", async () => {
    const { updates } = renderWith(<StageToHostButton manifestPath="E:\\Markiro\\m.update.jws" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Загрузить пакет на хост" }));
    });
    expect(updates.stage).toHaveBeenCalledWith("E:\\Markiro\\m.update.jws", SESSION.token);
    expect(screen.getByText("Пакет 0.4.0 загружен на хост и ждёт обновления хоста.")).toBeTruthy();
  });

  it("explains a refusal", async () => {
    renderWith(<StageToHostButton manifestPath="m" />, {
      updates: fakeUpdates({
        stage: vi.fn(async () => Promise.reject(new UpdateError("package_not_newer", "x"))),
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Загрузить пакет на хост" }));
    });
    expect(screen.getByText("Пакет не новее версии хоста: загружать его не нужно.")).toBeTruthy();
  });

  it("is hidden from a technologist", () => {
    renderWith(<StageToHostButton manifestPath="m" />, { session: sessionOf(TECHNOLOGIST) });
    expect(screen.queryByRole("button", { name: "Загрузить пакет на хост" })).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-status.test.ts test/update-section-host.test.tsx
```

Ожидается: FAIL — модули не найдены.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/update/offer-context.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { HostUpdateOffer } from "./host-offer.js";

const NONE: HostUpdateOffer = { kind: "none" };
const UpdateOfferContext = createContext<HostUpdateOffer>(NONE);

/** The update the host offers this PC (`useHostUpdateOffer` in `App`), for the office. */
export function UpdateOfferProvider({
  value,
  children,
}: {
  value: HostUpdateOffer;
  children: ReactNode;
}) {
  return <UpdateOfferContext value={value}>{children}</UpdateOfferContext>;
}

export function useUpdateOffer(): HostUpdateOffer {
  return useContext(UpdateOfferContext);
}
```

Создать `apps/standalone/src/office/info/update-status.ts`:

```ts
import type { TagPhase } from "@markiro/ui";

import type { DeviceVersionState, OfficeUpdateStatus } from "../../host/distribution.js";

/** A device's state as a tag (the word goes beside it: never colour alone). */
export const DEVICE_STATE_PHASE: Readonly<Record<DeviceVersionState, TagPhase>> = {
  current: "done",
  behind: "attention",
  incompatible: "failed",
  newer: "attention",
  unknown: "none",
};

export interface UpdateSummary {
  hostVersion: string;
  total: number;
  current: number;
  behind: number;
  incompatible: number;
  newer: number;
  unknown: number;
}

/** «Хост: 0.3.0. Актуальны 3 из 5 …» (spec §10.11.7) as numbers. */
export function summarize(status: OfficeUpdateStatus): UpdateSummary {
  const count = (state: DeviceVersionState) =>
    status.devices.filter((device) => device.state === state).length;
  return {
    hostVersion: status.hostVersion,
    total: status.devices.length,
    current: count("current"),
    behind: count("behind"),
    incompatible: count("incompatible"),
    newer: count("newer"),
    unknown: count("unknown"),
  };
}

const PACKAGE_STATES = ["ok", "missing", "mismatch", "invalid", "verifying"] as const;

/** The i18n key's last part of the host's package state; a newer host's word is `unknown`. */
export function packageStateKey(state: string): (typeof PACKAGE_STATES)[number] | "unknown" {
  return PACKAGE_STATES.find((known) => known === state) ?? "unknown";
}
```

Создать `apps/standalone/src/office/info/DeviceVersionsBlock.tsx`:

```tsx
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Card, StatusChip, Table, type TableColumn } from "@markiro/ui";

import type { DeviceVersion, OfficeUpdateStatus } from "../../host/distribution.js";
import { formatSize } from "../backups/backup-format.js";
import { useBackupTime } from "../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { DEVICE_STATE_PHASE, packageStateKey, summarize } from "./update-status.js";

/**
 * «Устройства и версии» (spec §10.11.7, extension point T5): the host's
 * version and package, each device's version, protocol and state in words,
 * its last download and installation, when it was last seen; then the
 * update history. Both office roles read it.
 */
export function DeviceVersionsBlock() {
  const { t } = useTranslation();
  const status = useOfficeQuery(officeKeys.updateStatus, (api, token) =>
    api.getUpdateStatus(token),
  );
  const time = useBackupTime(status.isSuccess);
  let body;
  if (status.isPending || (status.isSuccess && !time.ready)) body = <PageLoading />;
  else if (status.isError)
    body = <LoadError error={status.error} onRetry={() => void status.refetch()} />;
  else body = <Versions status={status.data} format={time.format} />;
  return (
    <Card title={t("office.about.update.devices.title")} titleAs="h3">
      {body}
    </Card>
  );
}

function summaryText(status: OfficeUpdateStatus, t: TFunction): string {
  const summary = summarize(status);
  const parts = [
    t("office.about.update.devices.summary", {
      host: summary.hostVersion,
      current: summary.current,
      total: summary.total,
    }),
  ];
  for (const state of ["behind", "incompatible", "newer", "unknown"] as const) {
    if (summary[state] > 0) {
      parts.push(t(`office.about.update.devices.count.${state}`, { count: summary[state] }));
    }
  }
  return parts.join("; ");
}

function Versions({
  status,
  format,
}: {
  status: OfficeUpdateStatus;
  format: (instant: string) => string;
}) {
  const { t } = useTranslation();
  const columns: TableColumn<DeviceVersion>[] = [
    {
      key: "name",
      title: t("office.about.update.devices.device"),
      wrap: true,
      render: (device) =>
        `${device.name} · ${t(`office.about.update.devices.kind.${device.kind}`)}`,
    },
    {
      key: "line",
      title: t("office.about.update.devices.line"),
      render: (device) => device.lineName ?? "—",
    },
    {
      key: "version",
      title: t("office.about.update.devices.version"),
      mono: true,
      render: (device) =>
        t("office.about.update.devices.versionProtocol", {
          version: device.appVersion,
          protocol: device.protocol,
        }),
    },
    {
      key: "state",
      title: t("office.about.update.devices.state.title"),
      render: (device) => (
        <StatusChip
          phase={DEVICE_STATE_PHASE[device.state]}
          label={t(`office.about.update.devices.state.${device.state}`)}
        />
      ),
    },
    {
      key: "package",
      title: t("office.about.update.devices.package"),
      wrap: true,
      render: (device) =>
        [
          device.downloaded === null
            ? null
            : t("office.about.update.devices.downloaded", { when: format(device.downloaded.at) }),
          device.installStarted === null
            ? null
            : t("office.about.update.devices.installStarted", {
                when: format(device.installStarted.at),
              }),
        ]
          .filter((part): part is string => part !== null)
          .join("; ") || "—",
    },
    {
      key: "seen",
      title: t("office.about.update.devices.seen"),
      render: (device) => (device.lastSeenAt === null ? "—" : format(device.lastSeenAt)),
    },
  ];
  const state = packageStateKey(status.package.state);
  return (
    <>
      <p>{summaryText(status, t)}</p>
      <p>
        {t(`office.about.update.package.${state}`, { version: status.package.version ?? "" })}{" "}
        {t("office.about.update.package.disk", { size: formatSize(status.package.diskBytes, t) })}
      </p>
      {status.package.staged !== null && (
        <p>{t("office.about.update.package.staged", { version: status.package.staged })}</p>
      )}
      <Table
        columns={columns}
        rows={status.devices}
        scrollLabel={t("office.about.update.devices.table")}
        empty={t("office.about.update.devices.empty")}
      />
      <h4>{t("office.about.update.history.title")}</h4>
      {status.history.length === 0 ? (
        <p className="office-note">{t("office.about.update.history.empty")}</p>
      ) : (
        <ul className="update-history">
          {status.history.map((item) => (
            <li key={`${item.at}:${item.action}:${item.actor ?? ""}`}>
              {format(item.at)} —{" "}
              {t(`office.about.update.history.action.${item.action}`, {
                actor: item.actor ?? "—",
                version: item.version ?? item.to ?? "",
                from: item.from ?? "",
                to: item.to ?? "",
              })}
              {item.result === "ok" ? "" : ` (${t("office.about.update.history.failed")})`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
```

Создать `apps/standalone/src/office/info/HostUpdateBlock.tsx`:

```tsx
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { HostUpdateOffer } from "../../update/host-offer.js";
import { useUpdateOffer } from "../../update/offer-context.js";
import { UpdateFromHostDialog } from "../../update/UpdateFromHostDialog.js";
import { useOfficeSession } from "../office-session.js";
import { useAboutData } from "./about-data.js";
import { useUpdateShell } from "./update-context.js";
import { runUpdate } from "./update-flow.js";
import type { VerifiedReport } from "./update-shell.js";

function offerText(offer: HostUpdateOffer, appVersion: string, t: TFunction): string {
  switch (offer.kind) {
    case "none":
      return t("office.about.update.host.none");
    case "host_older":
      return t("office.about.update.host.hostOlder", {
        host: offer.hostVersion,
        app: offer.appVersion,
      });
    case "unavailable":
      return offer.reason === "verifying"
        ? t("office.about.update.host.verifying", { host: offer.hostVersion })
        : t("office.about.update.host.unavailable", { host: offer.hostVersion });
    case "needs_intermediate":
      return t("office.about.update.host.intermediate", { min: offer.minUpgradeFrom });
    case "available":
      return t("office.about.update.host.available", { host: offer.hostVersion, app: appVersion });
  }
}

/**
 * «С хоста» (spec §9.3, §10.11.5): on every PC but the host's — the host
 * updates from a file — what the host offers this PC. Only an administrator
 * downloads and installs; a technologist reads it.
 */
export function HostUpdateBlock() {
  const { t } = useTranslation();
  const offer = useUpdateOffer();
  const about = useAboutData();
  const session = useOfficeSession();
  const shell = useUpdateShell();
  const [open, setOpen] = useState(false);
  if (about.isPending || about.data?.role === "host") return null;
  const { user } = session;
  const appVersion = about.data?.appVersion ?? "—";
  // Plan ОБН-2's launch from the office: the `app.update.start` row with the
  // source `host`, then the shell checks the package again and starts it.
  const start = (report: VerifiedReport) =>
    runUpdate(
      {
        call: session.call,
        api: session.api,
        shell,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onPhase: () => undefined,
      },
      report,
      about.data?.role ?? "unknown",
      "host",
    );
  return (
    <Card title={t("office.about.update.host.title")} titleAs="h3">
      <p>{offerText(offer, appVersion, t)}</p>
      {offer.kind === "available" && user.role === "admin" && (
        <>
          <Button onClick={() => setOpen(true)}>{t("office.about.update.host.open")}</Button>
          <UpdateFromHostDialog
            open={open}
            offer={offer}
            onClose={() => setOpen(false)}
            start={start}
          />
        </>
      )}
      {offer.kind === "available" && user.role !== "admin" && (
        <p className="office-note">{t("office.about.update.host.adminOnly")}</p>
      )}
    </Card>
  );
}
```

Предупреждения перед запуском ОБН-2 (`installWarnings`: открытая смена этого ПК, роль) раздел «Обновление» ОБН-2 показывает для пакетов из файла; для пакета с хоста на ПК без роли `host` из них остаётся открытая смена — диалог берёт её из `installWarnings` тем же способом, если исполнитель найдёт это дешёвым, иначе запись в «Перенесено».

Правка `apps/standalone/src/office/info/update-flow.ts` (ОБН-2) — источник отчёта `app.update.start`:

```ts
export async function runUpdate(
  deps: RunDeps,
  report: VerifiedReport,
  role: InstallRole | "unknown",
): Promise<void> {
```

заменить на:

```ts
export async function runUpdate(
  deps: RunDeps,
  report: VerifiedReport,
  role: InstallRole | "unknown",
  source: "file" | "host" = "file",
): Promise<void> {
```

и в теле

<!-- prettier-ignore -->
```ts
            installerSha256: report.manifest.installer.sha256,
          },
          "file",
        ),
```

заменить на:

<!-- prettier-ignore -->
```ts
            installerSha256: report.manifest.installer.sha256,
          },
          source,
        ),
```

В `apps/standalone/test/update-flow.test.ts` (ОБН-2) по образцу его теста отчёта добавить: `runUpdate(deps, report, "station", "host")` шлёт `recordUpdateStarted` с телом `source: "host"`, без копии хоста.

Создать `apps/standalone/src/office/info/StageToHostButton.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { UpdateError, type UpdateErrorCode } from "../../update/updates-api.js";
import { useUpdates } from "../../update/updates-context.js";
import { officeKeys } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";

type Stage =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; version: string }
  | { kind: "failed"; code: UpdateErrorCode };

/**
 * «Загрузить пакет на хост» (spec §10.11.2) beside a package found on this
 * PC: the shell sends the manifest and streams the installer with the
 * office session; the host keeps it as waiting. Administrators only.
 */
export function StageToHostButton({ manifestPath }: { manifestPath: string }) {
  const { t } = useTranslation();
  const { user, call } = useOfficeSession();
  const updates = useUpdates();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Stage>({ kind: "idle" });
  if (user.role !== "admin") return null;
  const stage = async () => {
    setState({ kind: "busy" });
    try {
      const staged = await call((token) => updates.stage(manifestPath, token));
      setState({ kind: "done", version: staged.version });
      await queryClient.invalidateQueries({ queryKey: officeKeys.updateStatus });
    } catch (error) {
      setState({ kind: "failed", code: error instanceof UpdateError ? error.code : "refused" });
    }
  };
  return (
    <div className="update-stage">
      <Button variant="secondary" loading={state.kind === "busy"} onClick={() => void stage()}>
        {t("office.about.update.stage.button")}
      </Button>
      <div aria-live="polite">
        {state.kind === "done" && (
          <Alert tone="ok">{t("office.about.update.stage.done", { version: state.version })}</Alert>
        )}
        {state.kind === "failed" && <Alert tone="error">{t(`update.errors.${state.code}`)}</Alert>}
      </div>
    </div>
  );
}
```

Создать `apps/standalone/src/office/info/update-support.ts`:

```ts
import type { SupportContributor } from "./support-blocks.js";
import { packageStateKey } from "./update-status.js";

/**
 * The support block «Раздача обновления» (spec §9.4): the host's package
 * and «Устройства и версии», without hashes, keys or paths.
 */
export const updateDistributionContributor: SupportContributor = async ({ t, office }) => {
  if (office === null) return null;
  const status = await office.call((token) => office.api.getUpdateStatus(token));
  const state = t(`office.about.update.support.state.${packageStateKey(status.package.state)}`);
  return {
    title: t("office.about.update.support.title"),
    lines: [
      [
        t("office.about.update.support.package"),
        status.package.version === null ? state : `${state}, ${status.package.version}`,
      ],
      [t("office.about.update.support.staged"), status.package.staged ?? "—"],
      [t("office.about.update.support.previous"), status.package.previous ?? "—"],
      ...status.devices.map(
        (device) =>
          [
            `${device.name} (${device.kind})`,
            t("office.about.update.support.device", {
              version: device.appVersion,
              protocol: device.protocol,
              state: t(`office.about.update.support.deviceState.${device.state}`),
            }),
          ] as const,
      ),
    ],
  };
};
```

Правка `apps/standalone/src/office/info/support-blocks.ts` (каркас `claude/fb-about`):

Фрагмент 1:

```ts
import type { AboutData } from "./about-data.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";

/** What a contributor may read: the facts the base text already carries and what the page learned. */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
}
```

заменить на:

```ts
import type { OfficeSessionValue } from "../office-session.js";
import type { AboutData } from "./about-data.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";
import { updateDistributionContributor } from "./update-support.js";

/**
 * What a contributor may read: the facts the base text already carries,
 * what the page learned, and the office session for a contributor that
 * asks the host (plan ОБН-3); `null` outside an office.
 */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
  office: OfficeSessionValue | null;
}
```

Фрагмент 2:

```ts
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [];
```

заменить на (вкладчики ЛЦ-3 и ОБН-2 — перед ним):

```ts
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [updateDistributionContributor];
```

Правка `apps/standalone/src/office/info/SupportSection.tsx`: `const session = useOfficeSession();` рядом с прочими хуками, и

<!-- prettier-ignore -->
```ts
    const blocks = await collectSupportBlocks(SUPPORT_CONTRIBUTORS, { t, facts, about: fresh });
```

заменить на:

<!-- prettier-ignore -->
```ts
    const blocks = await collectSupportBlocks(SUPPORT_CONTRIBUTORS, {
      t,
      facts,
      about: fresh,
      office: session,
    });
```

(Если ЛЦ-3/ОБН-2 уже дали контексту доступ к хосту под другим именем, вкладчик читает его, а поле `office` не добавляется.)

Правка `apps/standalone/src/office/office-query.ts` — в `officeKeys` после `backups`:

<!-- prettier-ignore -->
```ts
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
  /** The host's update package and the devices' versions (plan ОБН-3). */
  updateStatus: ["office", "update-status"],
```

Правка `apps/standalone/src/office/Office.tsx`: в `OfficeProps` добавить

<!-- prettier-ignore -->
```ts
  /** The update the host offers this PC (plan ОБН-3); none outside the app. */
  updateOffer?: HostUpdateOffer;
  /** The shell's update commands (plan ОБН-3); a test passes its own. */
  updates?: UpdatesApi;
```

деструктуризацию `updateOffer = NO_UPDATE, updates = TAURI_UPDATES` (с `const NO_UPDATE: HostUpdateOffer = { kind: "none" };` на уровне модуля) и обернуть содержимое провайдеров `Office` в `<UpdatesProvider value={updates}><UpdateOfferProvider value={updateOffer}>…</UpdateOfferProvider></UpdatesProvider>` (внутри `OfficeSessionProvider`, рядом с `OfficeLinkProvider`).

Правка `apps/standalone/src/app/App.tsx` (вызов `<Office …>`):

<!-- prettier-ignore -->
```tsx
        deviceId={pairedStatus?.deviceId ?? null}
        windowMode={windowMode}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        deviceId={pairedStatus?.deviceId ?? null}
        windowMode={windowMode}
        updateOffer={updateOffer}
        updates={updates}
      />
```

и убрать `void updateOffer;` задачи 11.

В раздел «Обновление» ОБН-2 (по смыслу, в его компоненте из сверки): первым блоком — `<HostUpdateBlock />`; после блока «Из файла» — `<DeviceVersionsBlock />`; в строке каждого проверенного пакета из файла (и на ПК хоста, и на ПК офиса) — `<StageToHostButton manifestPath={…путь манифеста этой строки…} />`.

Правка `apps/standalone/src/i18n/ru.json` — в `office.about.update` (раздел ОБН-2) добавить:

<!-- prettier-ignore -->
```json
        "host": {
          "title": "С хоста",
          "none": "Обновления с хоста нет: этот ПК работает на версии хоста или новее.",
          "hostOlder": "Хост старее этого ПК ({{host}} < {{app}}): обновите хост.",
          "unavailable": "Хост работает на версии {{host}}, но на нём нет пакета обновления этой версии или пакет не прошёл проверку. Загрузите пакет на хост.",
          "verifying": "Хост работает на версии {{host}} и заново проверяет пакет обновления. Загляните через минуту.",
          "intermediate": "Нужна промежуточная версия: обновите этот ПК из файла до версии {{min}} или новее.",
          "available": "Хост работает на версии {{host}}, этот ПК — {{app}}. Доступно обновление.",
          "open": "Обновить с хоста",
          "adminOnly": "Доступно обновление; установит администратор."
        },
        "stage": {
          "button": "Загрузить пакет на хост",
          "done": "Пакет {{version}} загружен на хост и ждёт обновления хоста."
        },
        "package": {
          "ok": "Пакет обновления {{version}} на хосте проверен.",
          "missing": "Пакета обновления на хосте нет — загрузите его.",
          "mismatch": "Пакет обновления на хосте ({{version}}) не соответствует версии хоста — загрузите его снова.",
          "invalid": "Пакет обновления на хосте не прошёл проверку — загрузите его снова.",
          "verifying": "Хост заново проверяет пакет обновления.",
          "unknown": "Состояние пакета обновления неизвестно этой версии.",
          "disk": "Пакеты занимают на хосте {{size}}.",
          "staged": "Ожидает: пакет {{version}} — станет текущим после обновления хоста."
        },
        "devices": {
          "title": "Устройства и версии",
          "summary": "Хост: {{host}}. Актуальны: {{current}} из {{total}}",
          "count": {
            "behind": "отстают: {{count}}",
            "incompatible": "несовместимы: {{count}}",
            "newer": "новее хоста: {{count}}",
            "unknown": "версия неизвестна: {{count}}"
          },
          "device": "Устройство",
          "kind": { "station": "станция", "office": "офис", "handheld": "ТСД" },
          "line": "Линия",
          "version": "Версия, протокол",
          "versionProtocol": "{{version}} · {{protocol}}",
          "state": {
            "title": "Состояние",
            "current": "Актуальная",
            "behind": "Отстаёт, совместима",
            "incompatible": "Несовместима — не подключится",
            "newer": "Новее хоста",
            "unknown": "Неизвестно"
          },
          "package": "Пакет",
          "downloaded": "Скачан {{when}}",
          "installStarted": "Запущена установка {{when}}",
          "seen": "На связи",
          "table": "Устройства и версии",
          "empty": "Устройств нет."
        },
        "history": {
          "title": "История обновлений",
          "empty": "Обновлений ещё не было.",
          "failed": "не удалось",
          "action": {
            "host.upgrade": "хост обновлён до {{to}}",
            "update.package.stage": "{{actor}} загрузил(а) пакет {{version}} на хост",
            "update.package.promote": "пакет {{version}} стал текущим",
            "update.download": "{{actor}} скачал(о) пакет {{version}}",
            "app.update.start": "{{actor}}: установка {{from}} → {{to}}"
          }
        },
        "support": {
          "title": "Раздача обновления",
          "package": "Пакет на хосте",
          "staged": "Ожидающий пакет",
          "previous": "Предыдущий пакет",
          "state": {
            "ok": "проверен",
            "missing": "нет",
            "mismatch": "не версии хоста",
            "invalid": "не прошёл проверку",
            "verifying": "проверяется",
            "unknown": "неизвестно"
          },
          "device": "{{version}} · протокол {{protocol}} · {{state}}",
          "deviceState": {
            "current": "актуальная",
            "behind": "отстаёт",
            "incompatible": "несовместима",
            "newer": "новее хоста",
            "unknown": "неизвестно"
          }
        }
```

Строка `host.upgrade` журнала ОБН-1 несёт `from`/`to` (§10.6); если ОБН-2 уже выводит историю — ключи `history` не дублируются (Д13).

`apps/standalone/src/app/shell.css`: `.update-history`, `.update-notes` — список без маркеров с отступом по токенам `packages/ui` (`var(--space-2)`); `.update-stage` — колонка с промежутком `var(--space-2)`.

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-status.test.ts test/update-section-host.test.tsx test/support-report.test.ts test/about-page.test.tsx test/app.test.tsx
```

Ожидается: PASS; тесты каркаса не меняются (вкладчик получает `office` из сессии страницы; без мока `getUpdateStatus` он отвергает, и `collectSupportBlocks` теряет только его блок — проверить, что текст тестов каркаса этого не ждёт; если ждёт — в `fakeHostApi` дать `getUpdateStatus` ответ по умолчанию и записать). Новые файлы с React — прогон `--reporter=verbose` без `stderr |`. Мутация: в `HostUpdateBlock` убрать условие `user.role === "admin"` у кнопки — FAIL «tells the technologist…».

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/update/offer-context.tsx apps/standalone/src/office/info apps/standalone/src/office/Office.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/update-status.test.ts apps/standalone/test/update-section-host.test.tsx apps/standalone/test/update-flow.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/src/update/offer-context.tsx apps/standalone/src/office/info apps/standalone/src/office/Office.tsx apps/standalone/src/office/office-query.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/update-status.test.ts apps/standalone/test/update-section-host.test.tsx apps/standalone/test/update-flow.test.ts
git commit -F /tmp/claude/msg-obn3-12.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — «Обновление» gets «С хоста», the upload to the host and «Устройства и версии»` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 13: Полоса офиса, строка станции на хабе, «Обновить с хоста» на экране «Версии не совпадают»

**Files:**

- Create: `apps/standalone/src/office/banners/UpdateBanner.tsx`, `apps/standalone/src/floor/FloorUpdateLine.tsx`, `apps/standalone/src/floor/FloorUpdatePanel.tsx`, `apps/standalone/test/update-banner.test.tsx`, `apps/standalone/test/floor-update.test.tsx`
- Modify: `apps/standalone/src/office/OfficeShell.tsx` (`<UpdateBanner />` после `<LicenseBanner />` ЛЦ-3), `apps/standalone/src/floor/FloorStatusBar.tsx` (проп `updateOffer`, строка в вежливой области), `apps/standalone/src/app/screens.tsx` (`HostMissingScreen.onUpdate`), `apps/standalone/src/app/shell.ts` (`nextShellView`: ПК офиса с удалённым хостом при несовместимости), `apps/standalone/src/app/App.tsx` (диалог, панель, проп экрану), `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: два новых файла, `apps/standalone/test/shell.test.ts`, `apps/standalone/test/floor-status-bar.test.tsx` и `apps/standalone/test/app.test.tsx` (PASS без правок)

**Interfaces:**

- Consumes: `useUpdateOffer`, `UpdateFromHostDialog`, `HostUpdateOffer` (задачи 11–12); `HostStatus.lastError` (`app_too_old`, `host_too_old`, задача 10); `ShellState.link`, `ShellState.floorWork`.
- Produces: `UpdateBanner` в полосе офиса (Т3/Т6: администратору — «Доступно обновление 0.3.0 с хоста. Установить» → `/about#update`, технологу — «установит администратор»; закрывается на сеанс); `FloorUpdateLine` в строке состояния цеха только вне работы смены (`shiftId === null`), без кнопок; `FloorUpdatePanel` с «Обновить с хоста» (кнопка цеха, `size="floor"`) на экране входа оператора, только когда хост уже отвергает эту станцию (`required`, ЛО16); `HostMissingScreen` с `onUpdate`; `nextShellView` даёт ПК офиса, сопряжённому с хостом в сети, экран «Версии не совпадают» при `app_too_old`/`host_too_old` (Д9).

- [ ] **Step 1: Падающие тесты**

Создать `apps/standalone/test/update-banner.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { UpdateBanner } from "../src/office/banners/UpdateBanner.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateOfferProvider } from "../src/update/offer-context.js";
import { fakeOfficeSession, TECHNOLOGIST } from "./support/office.js";

const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: [],
    minUpgradeFrom: "0.2.0",
    protocol: 4,
    minProtocol: 3,
    sizeBytes: 200,
  },
};

function show(offer: HostUpdateOffer, user?: typeof TECHNOLOGIST) {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OfficeSessionProvider value={session}>
          <UpdateOfferProvider value={offer}>
            <UpdateBanner />
          </UpdateOfferProvider>
        </OfficeSessionProvider>
      ),
    },
  ]);
  render(
    <ThemeProvider defaultTheme="dark">
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

describe("the office's strip «Доступно обновление» (spec §10.11.5, T6)", () => {
  it("leads the administrator to «Информация» → «Обновление» and closes for the session", () => {
    show(AVAILABLE);
    expect(screen.getByText(/Доступно обновление 0\.3\.0 с хоста\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Установить" }).getAttribute("href")).toBe(
      "/about#update",
    );
    fireEvent.click(screen.getByRole("button", { name: "Скрыть до следующего входа" }));
    expect(screen.queryByText(/Доступно обновление/)).toBeNull();
  });

  it("tells the technologist that an administrator installs it, with no link", () => {
    show(AVAILABLE, TECHNOLOGIST);
    expect(screen.getByText("Доступно обновление; установит администратор.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Установить" })).toBeNull();
  });

  it("is nothing without an available update", () => {
    show({ kind: "none" });
    expect(screen.queryByText(/обновление/i)).toBeNull();
  });
});
```

Создать `apps/standalone/test/floor-update.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostMissingScreen } from "../src/app/screens.js";
import { FloorUpdateLine } from "../src/floor/FloorUpdateLine.js";
import { FloorUpdatePanel } from "../src/floor/FloorUpdatePanel.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";

const MANIFEST = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: [],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 4,
  sizeBytes: 200,
};
const BEHIND: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: MANIFEST,
};
const REQUIRED: HostUpdateOffer = { ...BEHIND, required: true };

function inTheme(node: React.ReactNode) {
  return render(<ThemeProvider defaultTheme="dark">{node}</ThemeProvider>);
}

describe("the station's line (spec §10.11.5)", () => {
  it("says a new version waits for the administrator, only off a shift's work", () => {
    const { rerender } = inTheme(
      <FloorUpdateLine offer={BEHIND} appTooOld={false} inShift={false} />,
    );
    expect(screen.getByText("Есть новая версия программы; установит администратор.")).toBeTruthy();
    rerender(
      <ThemeProvider defaultTheme="dark">
        <FloorUpdateLine offer={BEHIND} appTooOld={false} inShift />
      </ThemeProvider>,
    );
    expect(screen.queryByText(/новая версия/)).toBeNull();
  });

  it("says this station is too old for the host, and holds nothing to press", () => {
    inTheme(<FloorUpdateLine offer={REQUIRED} appTooOld inShift={false} />);
    expect(screen.getByText(/слишком старая для хоста/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says there is no package when the host refuses this station and gives none", () => {
    inTheme(
      <FloorUpdateLine
        offer={{ kind: "unavailable", hostVersion: "0.3.0", reason: "missing" }}
        appTooOld
        inShift={false}
      />,
    );
    expect(screen.getByText(/пакета обновления на хосте нет/)).toBeTruthy();
  });
});

describe("«Обновить с хоста» when the host refuses this PC (ЛО16)", () => {
  it("is a floor button on the sign-in screen", () => {
    const onUpdate = vi.fn();
    inTheme(<FloorUpdatePanel offer={REQUIRED} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("is on the version screen for an app the host finds too old, never for an old host", () => {
    const onUpdate = vi.fn();
    const { rerender } = inTheme(
      <HostMissingScreen
        reason="app_too_old"
        address="https://192.168.1.10:45710"
        onRetry={vi.fn()}
        onNetwork={null}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(onUpdate).toHaveBeenCalled();
    rerender(
      <ThemeProvider defaultTheme="dark">
        <HostMissingScreen
          reason="host_too_old"
          address="x"
          onRetry={vi.fn()}
          onNetwork={null}
          onUpdate={onUpdate}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("button", { name: "Обновить с хоста" })).toBeNull();
  });
});
```

В `apps/standalone/test/shell.test.ts` добавить (импорты `initialShellState`, `nextShellView`, `type ShellState` из `../src/app/shell.js`, `DEVICE_STATUS` из `./support/fixtures.js`, `LOCAL_HOST_ADDRESS` из `../src/host/protocol.js` — те, что в файле уже есть, не дублировать):

```ts
describe("a PC paired with a host in the network, when the versions do not match (plan ОБН-3)", () => {
  const remote = { ...DEVICE_STATUS, hostAddress: "https://192.168.1.10:45710" };
  const refused = {
    state: "offline",
    lastContactAt: null,
    lastError: "app_too_old",
    seq: 2,
    hostVersion: "0.3.0",
    hostProtocol: 4,
    hostMinProtocol: 4,
  } as const;

  it("shows an office PC the version screen: the office is closed to it", () => {
    const state: ShellState = {
      ...initialShellState,
      device: { kind: "ready", status: { ...remote, kind: "office" } },
      link: refused,
    };
    expect(nextShellView(state, LOCAL_HOST_ADDRESS)).toEqual({
      kind: "host_missing",
      reason: "app_too_old",
    });
    const older: ShellState = { ...state, link: { ...refused, lastError: "host_too_old" } };
    expect(nextShellView(older, LOCAL_HOST_ADDRESS)).toEqual({
      kind: "host_missing",
      reason: "host_too_old",
    });
  });

  it("keeps a station on its floor: it works offline, and the floor offers the update", () => {
    const state: ShellState = {
      ...initialShellState,
      device: { kind: "ready", status: remote },
      link: refused,
    };
    expect(nextShellView(state, LOCAL_HOST_ADDRESS)).toEqual({ kind: "floor" });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-banner.test.tsx test/floor-update.test.tsx test/shell.test.ts
```

Ожидается: FAIL — модули не найдены; `nextShellView` даёт ПК офиса `office_login`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/banners/UpdateBanner.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, IconButton } from "@markiro/ui";

import { useUpdateOffer } from "../../update/offer-context.js";
import { useOfficeSession } from "../office-session.js";

/**
 * «Доступно обновление» above the office's pages (spec §10.11.5, points
 * T3/T6): the administrator gets a link to «Информация» → «Обновление», a
 * technologist the word that an administrator installs it. Closed for the
 * session: `OfficeShell` lives as long as the session does.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const offer = useUpdateOffer();
  const { user } = useOfficeSession();
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const version = offer.kind === "available" ? offer.manifest.version : null;
  const shown = version !== null && closedFor !== version;
  // A polite region on the screen from the start, like `LicenseBanner`'s,
  // so a strip that appears is heard.
  return (
    <div className="office-banner" aria-live="polite">
      {shown && (
        <Alert
          tone="info"
          action={
            <IconButton
              variant="secondary"
              icon={<span aria-hidden="true">×</span>}
              aria-label={t("office.banner.update.close")}
              onClick={() => setClosedFor(version)}
            />
          }
        >
          {user.role === "admin" ? (
            <>
              {t("office.banner.update.admin", { version })}{" "}
              <Link to="/about#update">{t("office.banner.update.install")}</Link>
            </>
          ) : (
            t("office.banner.update.technologist")
          )}
        </Alert>
      )}
    </div>
  );
}
```

Правка `apps/standalone/src/office/OfficeShell.tsx` (после ЛЦ-3, задача «полоса»: `<LicenseBanner />` стоит между шапкой и `main`):

Фрагмент 1 (импорты):

```tsx
import { LicenseBanner } from "./LicenseBanner.js";
```

заменить на:

```tsx
import { UpdateBanner } from "./banners/UpdateBanner.js";
import { LicenseBanner } from "./LicenseBanner.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
        <LicenseBanner />
        <main ref={mainRef} tabIndex={-1} className="office-shell__content">
```

заменить на:

<!-- prettier-ignore -->
```tsx
        <LicenseBanner />
        <UpdateBanner />
        <main ref={mainRef} tabIndex={-1} className="office-shell__content">
```

Если ЛЦ-3 к исполнению не слит, `<UpdateBanner />` ставится между `</header>` и `<main …>` сам (импорт — без `LicenseBanner`), и это пишется в «Отклонения»; ЛЦ-3 при слиянии ставит свою полосу перед ним. Переход по `/about#update` фокусирует раздел «Обновление» тем же способом, что ЛЦ-3 ввёл для `#license` (`AboutPage` по якорю).

Создать `apps/standalone/src/floor/FloorUpdateLine.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import type { HostUpdateOffer } from "../update/host-offer.js";

/**
 * The station's line about an update (spec §10.11.5): words only, never a
 * control, and never during a shift's work — an update never interrupts a
 * shift. An administrator installs it from the office on this PC; a station
 * the host refuses already gets the button on the sign-in screen
 * (`FloorUpdatePanel`).
 */
export function FloorUpdateLine({
  offer,
  appTooOld,
  inShift,
}: {
  offer: HostUpdateOffer;
  appTooOld: boolean;
  inShift: boolean;
}) {
  const { t } = useTranslation();
  if (inShift) return null;
  if (offer.kind === "available") {
    return (
      <p className="floor-status__note">
        {offer.required
          ? t("floor.update.required", { host: offer.hostVersion })
          : t("floor.update.available")}
      </p>
    );
  }
  if (appTooOld) return <p className="floor-status__note">{t("floor.update.requiredNoPackage")}</p>;
  return null;
}
```

Создать `apps/standalone/src/floor/FloorUpdatePanel.tsx`:

```tsx
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { HostUpdateOffer } from "../update/host-offer.js";

/**
 * «Обновить с хоста» on the sign-in screen of a station the host refuses
 * already (`app_too_old`, ЛО16): no office opens for it, so the button is
 * here; Windows asks for an administrator (UAC) before anything is
 * installed. Nobody is signed in, so no shift's work is interrupted.
 */
export function FloorUpdatePanel({
  offer,
  onUpdate,
}: {
  offer: Extract<HostUpdateOffer, { kind: "available" }>;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="floor-update">
      <p>{t("floor.update.panel", { host: offer.hostVersion, version: offer.manifest.version })}</p>
      <Button size="floor" onClick={onUpdate}>
        {t("floor.update.fromHost")}
      </Button>
    </Card>
  );
}
```

(Если `Card` не принимает `className`, обёртка — `<div className="floor-update">`.)

Правка `apps/standalone/src/floor/FloorStatusBar.tsx`: в `FloorStatusBarProps` после `factsFailure` добавить

<!-- prettier-ignore -->
```ts
  /** The update the host offers this station (plan ОБН-3); none by default. */
  updateOffer?: HostUpdateOffer;
```

в деструктуризацию — `updateOffer = NO_UPDATE` (`const NO_UPDATE: HostUpdateOffer = { kind: "none" };` на уровне модуля), а в вежливую область предупреждений (ту, где `refusalHeld`/`deviceNotSaved`) первым элементом:

<!-- prettier-ignore -->
```tsx
        <FloorUpdateLine
          offer={updateOffer}
          appTooOld={link?.lastError === "app_too_old"}
          inShift={shiftId !== null}
        />
```

Абзац документации компонента дополнить: «Plan ОБН-3 adds, off a shift's work only, that a new version waits for an administrator, or that the host refuses this station already.»

Правка `apps/standalone/src/app/screens.tsx` (`HostMissingScreen`):

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  /** Pair with a host in the network instead; `null` for a device that is already paired. */
  onNetwork: (() => void) | null;
}) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /** Pair with a host in the network instead; `null` for a device that is already paired. */
  onNetwork: (() => void) | null;
  /** «Обновить с хоста» (plan ОБН-3, ЛО16): only for `app_too_old` with a package on offer. */
  onUpdate?: (() => void) | null;
}) {
```

и в деструктуризацию добавить `onUpdate = null`.

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
        <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
      </div>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {reason === "app_too_old" && onUpdate !== null && (
          <Button onClick={onUpdate}>{t("shell.version.fromHost")}</Button>
        )}
        <Button onClick={onRetry}>{t("shell.hostMissing.retry")}</Button>
      </div>
```

Правка `apps/standalone/src/app/shell.ts` (`nextShellView`, после блока хоста на этом компьютере):

<!-- prettier-ignore -->
```ts
      return { kind: "host_missing", reason: localHost.reason };
    }
  }
  switch (state.office.kind) {
```

заменить на:

<!-- prettier-ignore -->
```ts
      return { kind: "host_missing", reason: localHost.reason };
    }
  } else if (
    status.kind === "office" &&
    state.office.kind !== "open" &&
    (state.link?.lastError === "app_too_old" || state.link?.lastError === "host_too_old")
  ) {
    // Plan ОБН-3: an office PC paired with a host in the network has no
    // floor and no office its host takes; it says why. A station keeps its
    // floor offline, and the floor offers the update (`FloorUpdateLine`).
    return { kind: "host_missing", reason: state.link.lastError };
  }
  switch (state.office.kind) {
```

Правка `apps/standalone/src/app/App.tsx`:

1. Состояние диалога: `const [updateOpen, setUpdateOpen] = useState(false);` и `const offerToInstall = updateOffer.kind === "available" ? updateOffer : null;`.
2. `HostMissingScreen` — проп `onUpdate={offerToInstall === null || pairedStatus === null ? null : () => setUpdateOpen(true)}`.
3. `FloorStatusBar` — проп `updateOffer={updateOffer}`.
4. На экране входа оператора (`view.kind === "floor"`), перед `OperatorSignIn`: `{offerToInstall?.required === true && <FloorUpdatePanel offer={offerToInstall} onUpdate={() => setUpdateOpen(true)} />}`.
5. В конце разметки (внутри `UpdatesProvider`): `{offerToInstall !== null && <UpdateFromHostDialog open={updateOpen} offer={offerToInstall} onClose={() => setUpdateOpen(false)} start={(report) => updateShell.install(report.path, report.confirmations)} />}` с `const updateShell = useUpdateShell();` (ОБН-2, `src/office/info/update-context.js`; вне офиса — `TAURI_UPDATE_SHELL` по умолчанию). Здесь офиса нет (экран «Версии не совпадают», станция, которую хост отвергает): отчёта `app.update.start` не будет — его маршрут офисный и хост этот ПК не пускает; разрешение — UAC (ЛО16). Подтверждения отчёта (`host_unreachable`) пользователь даёт в диалоге до `install`.

Правка `apps/standalone/src/i18n/ru.json`:

- в `shell.version` добавить `"fromHost": "Обновить с хоста"`;
- в `office` добавить раздел (или дополнить раздел ЛЦ-3 `office.banner`):

<!-- prettier-ignore -->
```json
    "banner": {
      "update": {
        "admin": "Доступно обновление {{version}} с хоста.",
        "install": "Установить",
        "technologist": "Доступно обновление; установит администратор.",
        "close": "Скрыть до следующего входа"
      }
    },
```

- в `floor` добавить:

<!-- prettier-ignore -->
```json
    "update": {
      "available": "Есть новая версия программы; установит администратор.",
      "required": "Версия этой станции слишком старая для хоста ({{host}}): станция работает без связи. Обновите её с хоста — кнопка на экране входа.",
      "requiredNoPackage": "Версия этой станции слишком старая для хоста, а пакета обновления на хосте нет. Сообщите администратору.",
      "panel": "Хост площадки работает на версии {{host}} и больше не принимает эту станцию. Обновление {{version}} можно скачать с хоста; Windows спросит учётную запись администратора.",
      "fromHost": "Обновить с хоста"
    },
```

`apps/standalone/src/app/shell.css`: `.floor-update` — отступ сверху `var(--space-3)` (класс полосы `.office-banner` — ЛЦ-3).

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-banner.test.tsx test/floor-update.test.tsx test/shell.test.ts test/floor-status-bar.test.tsx test/app.test.tsx
```

Ожидается: PASS. Новые файлы с React — прогон `--reporter=verbose` без `stderr |`. Мутации: в `FloorUpdateLine` убрать `if (inShift) return null;` — FAIL «only off a shift's work»; в `nextShellView` убрать условие `status.kind === "office"` — FAIL «keeps a station on its floor».

Контракт `tools/production-browser` (≥ 64 px у интерактивных элементов станции, память проекта): кнопка `FloorUpdatePanel` — `size="floor"`; кнопка экрана «Версии не совпадают» — как соседние кнопки экрана. Если правка экрана задевает его спеки — прогнать `pnpm test:production-bundle:contract` (вне песочницы) и записать результат.

- [ ] **Step 5: Гейты и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/banners apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/floor/FloorUpdateLine.tsx apps/standalone/src/floor/FloorUpdatePanel.tsx apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/app/shell.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/update-banner.test.tsx apps/standalone/test/floor-update.test.tsx apps/standalone/test/shell.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
git add apps/standalone/src/office/banners apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/floor/FloorUpdateLine.tsx apps/standalone/src/floor/FloorUpdatePanel.tsx apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/screens.tsx apps/standalone/src/app/shell.ts apps/standalone/src/app/App.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/update-banner.test.tsx apps/standalone/test/floor-update.test.tsx apps/standalone/test/shell.test.ts
git commit -F /tmp/claude/msg-obn3-13.txt
```

Сообщение: `feat(standalone): plan ОБН-3 — the office's update strip, the station's line off a shift and «Обновить с хоста» where the host refuses this PC` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 14: Окно совместимости N−1, версии сборки, документы, §23 спецификации

**Files:**

- Create: `tools/standalone-release/releases.json`, `tools/standalone-release/releases.mjs`, `tools/standalone-release/test/releases.test.mjs`
- Modify: `tools/standalone-release/prepare.mjs` (`main`: окно перед черновиком), `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Test: `tools/standalone-release/test/releases.test.mjs`, `pnpm test:standalone-release:contract`

**Interfaces:**

- Consumes: `readStandaloneVersion`, `readProtocolRange` (`prepare.mjs`, ОБН-2), `compareVersions` (`sign-update.mjs`, ОБН-2).
- Produces: `RELEASES_FILE`, `readReleases(path?)`, `checkCompatibilityWindow({ version, protocol, minProtocol }, releases) → { previous }`; контракт: `MIN_PROTOCOL_VERSION` сборки не выше `PROTOCOL_VERSION` предыдущего выпуска из `releases.json`, запись о выпуске этой версии совпадает со сборкой, список строгий и по возрастанию; версии `tauri.conf.json`, `src-tauri/Cargo.toml`, `host/Cargo.toml`, `proto/Cargo.toml` и `apps/standalone/package.json` равны (Д4); `prepare.mjs` отказывает выпуску вне окна до записи черновика; разделы `AGENTS.md` и памятки; §23.

- [ ] **Step 1: Падающие тесты**

Создать `tools/standalone-release/test/releases.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProtocolRange, readStandaloneVersion } from "../prepare.mjs";
import { checkCompatibilityWindow, readReleases } from "../releases.mjs";

test("this build stays within one release of the one before it (N−1, spec §10.11.6)", async () => {
  const build = { version: await readStandaloneVersion(), ...(await readProtocolRange()) };
  checkCompatibilityWindow(build, await readReleases());
});

test("the build's version is one across its manifests", async () => {
  const version = await readStandaloneVersion();
  const cargo = async (path) => /^version = "([^"]+)"$/mu.exec(await readFile(path, "utf8"))?.[1];
  for (const path of [
    "apps/standalone/src-tauri/Cargo.toml",
    "apps/standalone/host/Cargo.toml",
    "apps/standalone/proto/Cargo.toml",
  ]) {
    assert.equal(await cargo(path), version, path);
  }
  const app = JSON.parse(await readFile("apps/standalone/package.json", "utf8"));
  assert.equal(app.version, version);
});

test("a minimum protocol above the release before it is refused", () => {
  const releases = [{ version: "0.2.0", protocol: 3, minProtocol: 1 }];
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.3.0", protocol: 5, minProtocol: 4 }, releases),
    /N−1/u,
  );
  assert.deepEqual(
    checkCompatibilityWindow({ version: "0.3.0", protocol: 4, minProtocol: 3 }, releases).previous,
    releases[0],
  );
  // The first release has nothing before it.
  assert.equal(
    checkCompatibilityWindow({ version: "0.1.0", protocol: 9, minProtocol: 9 }, releases).previous,
    null,
  );
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.3.0", protocol: 2, minProtocol: 1 }, releases),
    /goes back/u,
  );
});

test("a recorded release must be the build it names", () => {
  const releases = [{ version: "0.2.0", protocol: 3, minProtocol: 1 }];
  assert.throws(
    () => checkCompatibilityWindow({ version: "0.2.0", protocol: 4, minProtocol: 1 }, releases),
    /recorded/u,
  );
});

test("the list of releases is strict and in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "markiro-releases-"));
  const file = join(dir, "releases.json");
  const write = (releases) =>
    writeFile(file, JSON.stringify({ schemaVersion: 1, releases }), "utf8");
  await write([{ version: "0.1.0", protocol: 3, minProtocol: 1, date: "x" }]);
  await assert.rejects(readReleases(file), /keys/u);
  await write([
    { version: "0.2.0", protocol: 3, minProtocol: 1 },
    { version: "0.1.0", protocol: 3, minProtocol: 1 },
  ]);
  await assert.rejects(readReleases(file), /order/u);
  await write([{ version: "0.1.0", protocol: 1, minProtocol: 2 }]);
  await assert.rejects(readReleases(file), /protocol/u);
  await write([{ version: "0.1", protocol: 3, minProtocol: 1 }]);
  await assert.rejects(readReleases(file), /not a version/u);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node --test tools/standalone-release/test/releases.test.mjs
```

Ожидается: FAIL — модуль `../releases.mjs` не найден.

- [ ] **Step 3: Реализация**

Создать `tools/standalone-release/releases.json` (Д20: первая бета; сверить с тегом выпуска):

```json
{
  "schemaVersion": 1,
  "releases": [{ "version": "0.1.0", "protocol": 3, "minProtocol": 1 }]
}
```

Создать `tools/standalone-release/releases.mjs`:

```js
// The releases of «Markiro Автоном» that reached sites, and the window of
// compatibility during a rollout (plan ОБН-3, spec §10.11.6): one release
// back. Every release keeps its MIN_PROTOCOL_VERSION at or below the
// PROTOCOL_VERSION of the release before it, so a device of N−1 still works
// with a host of N, and only N−2 meets «Версии не совпадают». The owner adds
// a release's line in the commit that releases it.

import { readFile } from "node:fs/promises";

import { compareVersions } from "./sign-update.mjs";

export const RELEASES_FILE = "tools/standalone-release/releases.json";

const KEYS = "minProtocol,protocol,version";

/** The recorded releases, checked: exact keys, protocol ranges, strictly ascending versions. */
export async function readReleases(path = RELEASES_FILE) {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (data?.schemaVersion !== 1 || !Array.isArray(data.releases)) {
    throw new Error(`${path} is not a list of releases`);
  }
  const releases = data.releases.map((entry) => {
    const keys = Object.keys(entry ?? {})
      .sort()
      .join(",");
    if (keys !== KEYS) throw new Error(`${path}: a release has the keys ${keys}, not ${KEYS}`);
    compareVersions(entry.version, entry.version);
    const { protocol, minProtocol } = entry;
    if (
      !Number.isInteger(protocol) ||
      !Number.isInteger(minProtocol) ||
      minProtocol < 1 ||
      minProtocol > protocol
    ) {
      throw new Error(`${path}: release ${entry.version} has no usable protocol range`);
    }
    return { version: entry.version, protocol, minProtocol };
  });
  for (let index = 1; index < releases.length; index += 1) {
    if (compareVersions(releases[index - 1].version, releases[index].version) >= 0) {
      throw new Error(`${path}: releases are not in order at ${releases[index].version}`);
    }
  }
  return releases;
}

/**
 * Throws unless `build` keeps the window of one release back against
 * `releases`; the release before it (or `null`) when it does.
 */
export function checkCompatibilityWindow(build, releases) {
  const same = releases.find((release) => compareVersions(release.version, build.version) === 0);
  if (
    same !== undefined &&
    (same.protocol !== build.protocol || same.minProtocol !== build.minProtocol)
  ) {
    throw new Error(
      `release ${build.version} is recorded with protocol ${same.minProtocol}..${same.protocol}, the build has ${build.minProtocol}..${build.protocol}`,
    );
  }
  const previous =
    releases.filter((release) => compareVersions(release.version, build.version) < 0).at(-1) ??
    null;
  if (previous !== null && build.protocol < previous.protocol) {
    throw new Error(
      `PROTOCOL_VERSION ${build.protocol} goes back from ${previous.protocol} of release ${previous.version}`,
    );
  }
  if (previous !== null && build.minProtocol > previous.protocol) {
    throw new Error(
      `MIN_PROTOCOL_VERSION ${build.minProtocol} is above PROTOCOL_VERSION ${previous.protocol} of release ${previous.version}: a device of the release before would not connect (window N−1, spec §10.11.6)`,
    );
  }
  return { previous };
}
```

Правка `tools/standalone-release/prepare.mjs` (`main`, в редакции ОБН-2, где он читает `readProtocolRange()`): перед вызовом `prepareStandaloneRelease(…)` добавить

<!-- prettier-ignore -->
```js
  // Plan ОБН-3: a release outside the window of one release back never gets a draft.
  checkCompatibilityWindow({ version, ...range }, await readReleases());
```

(имена переменных версии и диапазона — как в `main` ОБН-2; импорт `import { checkCompatibilityWindow, readReleases } from "./releases.mjs";`). В `prepareStandaloneRelease` проверка не ставится: тесты ОБН-2 зовут его с вымышленными версиями.

- [ ] **Step 4: Документы**

`apps/standalone/AGENTS.md` — после раздела `## Updates from a file` (ОБН-2) новый раздел:

<!-- prettier-ignore -->
```markdown
## Update distribution

Plan ОБН-3 (spec `2026-10-13-standalone-license-and-updates-design.md`,
§10.11) lets every paired PC take the update from the host. An
administrator uploads a package in the office (`update_stage`: the shell
sends the manifest, `POST /v1/office/update-package/manifest`, and streams
the installer from the disk, `PUT /v1/office/update-package/{uploadId}/installer`,
`Content-Length` equal to the manifest's `sizeBytes`, hashed on the fly; the
route reads a `Body`, which no `DefaultBodyLimit` limits, and holds the size
itself). The host keeps at most `updates\staged` (newer than it runs),
`updates\current` (its own version: the only one served) and
`updates\previous`, plus one `incoming-<id>.partial`; the start and an hourly
pass promote `staged` of the running version, the start verifies `current`
whole (`mismatch`, `invalid`, `missing` are not served) and removes
everything else, and a file whose size, change or creation time (inode off
Windows) changed is verified again before it is served (`503
package_verifying`). The packages are no data of the site: no copy holds
them and `markiro-host restore` leaves `updates\` alone.

`GET /v1/device/update` and `GET /v1/device/update/installer` are outside
`protocol_guard` (`server::update_routes`), so a device the host refuses as
`app_too_old` still gets its update, yet both take `AuthDevice`; their
shapes are frozen like `hello`'s. The installer is served whole or as one
`bytes=N-`/`bytes=N-M` range, `If-Range` with another ETag (the SHA-256)
gives the whole file, anything else is `416`; one download per device, three
on the host (`503 update_busy`), 30 update requests a minute per device;
60 s without the client taking a piece cuts it. `update.download` is written
for a download from byte 0 only; `update.package.stage` and
`update.package.promote` (the host) complete the audit. `host_request`
refuses `/v1/device/update/installer` and `/v1/office/update-package/…`:
only `update_fetch` and `update_stage` reach them.

On the device `update_fetch` downloads into `<local data>\updates\<version>\`
over the pinned connection with resume, never past `sizeBytes`, checks the
whole file with `hash_exact`, and the package goes through plan ОБН-2's
`update_verify`/`update_install`, which take that folder's manifest too and
refuse it (`host_differs`) unless the host's `hello` names the package's
very version. The link reports the host's version, protocol and minimum
from every `hello` and `app_too_old`/`host_too_old` instead of
`stream_refused`; the webview offers the update only when the host is newer,
gives a package of its version, this PC is not below `minUpgradeFrom` and
the manifest's signature checked out (`update_check_manifest`). An office
PC paired with a host in the network sees «Версии не совпадают»; a station
keeps working offline, its line says so off a shift's work, and the sign-in
screen offers «Обновить с хоста» (ЛО16). Releases keep the window of one
release back: `tools/standalone-release/releases.json` and its contract.
Nothing here ran on Windows or over a real Wi-Fi.
```

В разделе `## Network and TLS` фразу

<!-- prettier-ignore -->
```markdown
and only the routes `/v1/device[/…]` except `/v1/device/line`,
```

заменить на

<!-- prettier-ignore -->
```markdown
and only the routes `/v1/device[/…]` except `/v1/device/line` and
`/v1/device/update/installer` (plan ОБН-3),
```

и ``and `/v1/office/…`.`` того же предложения — на ``and `/v1/office/…` except `/v1/office/update-package/…` (plan ОБН-3).``. В разделе `## Audit` после предложения о копиях (`Backups (plan РК) write …`) добавить: «Update distribution (plan ОБН-3) writes `update.package.stage` (the administrator), `update.package.promote` (the host; `failed` with `reason`) and `update.download` (the device, from byte 0 only).» В разделе `## Backups and restore` в конце первого абзаца добавить: «The update packages in `updates\` (plan ОБН-3) are in no copy and a restore never touches them.»

`docs/runbooks/standalone-install.md`:

- в «Памятке для ИТ» после пункта «Исходящих соединений в интернет нет: …» добавить пункт: «Обновления приходят файлом от Маркиро; устройства площадки получают их с хоста по локальной сети, по тому же соединению на порту 45710 — ни новых портов, ни правил брандмауэра, ни исходящих соединений.»;
- в разделе «Обновление из файла (раздел «Информация» → «Обновление»)» (ОБН-2) после подраздела «Запасной путь: вручную» добавить подраздел:

<!-- prettier-ignore -->
```markdown
### Обновление станций и ПК офиса с хоста

1. Загрузите пакет на хост: «Информация» → «Обновление» → у найденного пакета «Загрузить пакет на
   хост» (на ПК офиса или на ПК хоста, администратор). Хост проверяет подпись и SHA-256 и держит
   пакет ожидающим.
2. Обновите ПК хоста из файла между сменами (раздел выше). После перезапуска службы пакет становится
   текущим: в таблице «Устройства и версии» — «Пакет обновления … на хосте проверен».
3. По желанию отработайте одну смену на станции ПК хоста: пока остальные станции не обновлены, откат
   хоста ещё возможен (раздел «Откат»).
4. На каждой станции и ПК офиса между её сменами: администратор входит в офис на этом ПК →
   «Информация» → «Обновление» → «Обновить с хоста» → «Скачать с хоста» → «Установить обновление».
   Windows спросит учётную запись администратора. Станция, которую хост уже не принимает (на ней
   строка «Версия этой станции слишком старая для хоста»), обновляется кнопкой «Обновить с хоста»
   на экране входа оператора; ПК офиса — с экрана «Версии не совпадают».
5. Станции прежней версии работают с обновлённым хостом до своего обновления (окно в один выпуск);
   станции на две версии старше не подключатся — обновите их в тот же день.

Пакет не входит в резервные копии. После восстановления хоста на новом ПК или из копии другой версии
загрузите пакет снова: таблица скажет «Пакета обновления на хосте нет» или «не соответствует версии
хоста».

Выпуск: владелец добавляет строку выпуска в `tools/standalone-release/releases.json` в коммите выпуска;
`prepare.mjs` отказывает сборке, чей минимальный протокол выше протокола предыдущего выпуска.
```

`docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — в конец (после §22, если он есть; иначе после последнего раздела уточнений с пометкой номера) добавить раздел `## 23. Уточнения плана ОБН-3` — короткий список того, что исполнение уточнило против §10.11: Д3 (`markiro_proto::update::distribution`, порядок версий и хеш ОБН-2), Д5 (коды `package_verifying`, `update_busy`, `disk_full` — `conflict`), Д6 (отметка файла без индекса Windows), Д7–Д8 (`Range` и предел тела своим кодом), Д9–Д10 (экран несовместимости для ПК офиса, станция работает офлайн, кнопка на экране входа; «хаб» — экраны вне работы смены), Д11 (`update_check_manifest`), Д13 (история в `update-status`), Д15 (строки продвижения), Д17 (полоса после `LicenseBanner`), Д21 (`host_differs` в правилах ОБН-2, `runUpdate(…, "host")`), и каждое «Отклонение при исполнении» задач 1–13. Без кода; ссылки — на файлы.

- [ ] **Step 5: Прогон и гейты**

```bash
node --test tools/standalone-release/test/releases.test.mjs
pnpm --config.verifyDepsBeforeRun=false test:standalone-release:contract
node_modules/.bin/prettier --ignore-path .prettierignore --check tools/standalone-release/releases.json tools/standalone-release/releases.mjs tools/standalone-release/test/releases.test.mjs tools/standalone-release/prepare.mjs apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git diff --check
```

Ожидается: PASS. Мутация: в `releases.json` у записи `0.1.0` поставить `"protocol": 2` — FAIL «this build stays within one release…» (запись выпуска не совпадает со сборкой); восстановить.

- [ ] **Step 6: Коммит**

```bash
git add tools/standalone-release/releases.json tools/standalone-release/releases.mjs tools/standalone-release/test/releases.test.mjs tools/standalone-release/prepare.mjs apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F /tmp/claude/msg-obn3-14.txt
```

Сообщение: `docs(standalone): plan ОБН-3 — the window of one release back, the build's one version, update distribution in AGENTS.md, the runbook and §23` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

После коммита — `graphify update .` (если в worktree есть `graphify-out/graph.json`).

## Итоговая проверка плана

1. Провод: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto` и с `--features test-keys` — PASS.
2. Хост: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test update_store --test update_package --test update_start --test update_device --test update_download --test update_hygiene` и `--lib` — PASS в песочнице; вне песочницы `--test update_logs --test hello --test foundation --test no_secrets_in_logs` — PASS.
3. Оболочка: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`, затем `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib` — PASS; вне песочницы `--test ipc --test update --test update_fetch --test update_stage --test connection --test device --test line` — PASS.
4. Весь Rust: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы, частями, если весь не помещается; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; сборка без предупреждений; `git diff --exit-code apps/standalone/Cargo.lock` — пусто (Д12).
5. Вебвью: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; новые файлы с React — прогон `--reporter=verbose` без `stderr |`.
6. Выпуск: `pnpm --config.verifyDepsBeforeRun=false test:standalone-release:contract` — PASS; при правке экрана станции — `pnpm test:production-bundle:contract` (вне песочницы).
7. `pnpm --config.verifyDepsBeforeRun=false format:check`; `git diff --check`.
8. `git diff --stat <основа> -- apps/standalone/host/migrations apps/standalone/src-tauri/migrations packages/db/migrations` — пусто; `grep -rn "sha256_hex_of\|fn is_installer_name\|struct AppVersion" apps/standalone/proto/src/update/` — пусто (Д3: второго порядка версий и хеша нет).
9. `git log --format=%B` каждого коммита плана — ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».

## Перенесено

- **Предзагрузка пакета в простое** (ЛО15) — в первой версии скачивание только по нажатию.
- **Индекс `audit_log (action, actor_id)`** для «Устройств и версий» на большом журнале — миграцией `0032` (резерв направления), если замер на журнале клиента покажет медленное открытие (Д13).
- **Идентификатор файла Windows** в отметке пакета (`GetFileInformationByHandle`) — после того как `windows-sys` станет зависимостью хоста (Д6).
- **Прогресс загрузки пакета на хост** — сейчас кнопка в состоянии загрузки без процентов (Д19).
- **Предупреждение об открытой смене этой станции перед установкой с хоста** берётся из `installWarnings` ОБН-2, если это дёшево в задаче 12; иначе — отдельной задачей.
- **Реестр полос офиса** — при третьей полосе (Д17).
- **ТСД и киоск** получают обновление с хоста позже: маршруты устройств уже открыты для любого вида устройства, клиента получения у них нет.

## Не проверено

- Ничего из этого плана не запускалось на Windows: права `updates\` после установки и смены учётной записи службы, продвижение пакета после обновления службы, `ShellExecuteExW` с `runas` для скачанного установщика, перезапуск приложения после установки, итог `update_outcome` и уборка папки скачанного.
- Настоящая сеть площадки: установщик 60+ МБ по Wi-Fi на две-три станции одновременно, обрыв точки доступа посреди скачивания и продолжение, 60 с без продвижения на медленном канале, нагрузка на хост во время смены на его станции.
- Антивирус, сканирующий `%LOCALAPPDATA%\app.markiro.standalone\updates\` между проверкой и запуском (дескриптор без совместной записи ОБН-2 против антивируса); метка загрузки и SmartScreen у файла, скачанного своим клиентом (ожидается без метки).
- Загрузка пакета на хост с ПК офиса по сети (поток десятков МБ, hyper и `Content-Length` у reqwest с телом из файла).
- Восстановление на новом ПК: пакета нет и он не раздаётся; восстановление на том же ПК от копии другой версии — `mismatch` (проверено тестами на macOS, не на Windows).
- Станция N−1 со смены до смены после обновления хоста; станция N−2 видит строку и панель на экране входа и обновляется через UAC; ПК офиса — с экрана «Версии не совпадают».
- Поведение hyper при теле короче `Content-Length` (обрыв соединения) проверено только тем, что поток кончается; на настоящем сокете — нет.
- Браузерная проверка экранов (вне jsdom) — нет; DOM-тесты не заменяют визуальную проверку.

## Отклонения при исполнении
