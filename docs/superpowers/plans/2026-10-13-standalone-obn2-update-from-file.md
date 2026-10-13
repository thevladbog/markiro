# План ОБН-2: обновление «Markiro Автоном» из файла — черновик манифеста в `prepare.mjs`, подпись `sign-update.mjs`, поиск пакетов, проверка подписи и установщика через неразделяемый дескриптор, запуск с UAC и выход мимо стража киоск-режима, раздел «Обновление», строка `app.update.start` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор ставит новую версию автонома с флешки или из папки `Документы\Markiro\Обновления`, не выходя из программы: оболочка находит пакет (установщик и подписанный манифест `*.update.jws`), проверяет подпись манифеста встроенным ключом выпусков и SHA-256 установщика через дескриптор, который никто не может изменить до запуска, применяет правила версий (без понижения, `minUpgradeFrom`, «сначала хост»), на ПК хоста сначала просит хост сделать резервную копию, записывает в журнал хоста `app.update.start` и запускает тот самый установщик с запросом прав администратора Windows, после чего выходит мимо стража закрытия киоск-режима. При следующем старте программа говорит, обновилась ли она. CI пишет неподписанный черновик манифеста; владелец подписывает его на своей машине инструментом `sign-update.mjs`. Контракт выпуска закрепляет, что сетевых крейтов не прибавилось.

**Architecture:**

- Задача 1 — `markiro_proto::update`: `AppVersion` (строго `X.Y.Z`, как `prepare.mjs`), `installer_name`, `hash_exact` (SHA-256 ровно `size` байт потоком), тело `UpdateStarted` (`deny_unknown_fields`) и фикстура `update-started.json`; Zod `updateStartedSchema` и построитель `updateStarted` в `src/host/requests.ts`.
- Задача 2 — хост: `POST /v1/office/updates/started` (администратор, без ревизии) → строка `app.update.start` с устройством сессии; `HostApi.recordUpdateStarted`.
- Задача 3 — `prepare.mjs` пишет `markiro-standalone-<версия>.update-draft.json` (`version`, `sourceSha`, `installer`, `protocol`, `minProtocol` из `proto/src/lib.rs`), проверка выпуска знает четвёртый файл; контракт «без интернета»: список сетевых крейтов `Cargo.lock` автонома закреплён, updater- и HTTP-плагинов нет.
- Задача 4 — `tools/standalone-release/sign-update.mjs` (ES256 через `node:crypto`, `typ` `markiro-standalone-update+jws`, парольная фраза только с терминала, ключ и папка результата вне репозитория, повторный хеш против `release-evidence.json`, порядок Authenticode → `prepare.mjs` → `sign-update`), его контрактные тесты; генератор и закоммиченные тестовые манифесты для тестов оболочки.
- Задача 5 — оболочка, `src-tauri/src/update/`: `rules.rs` (решение по версиям), `package.rs` (поиск в `Документы\Markiro\Обновления`, в корне и папке `Markiro\` съёмных дисков за трейтом `RemovableDrives`; чтение манифеста через `markiro_proto::trust::verify_update_manifest`; установщик через дескриптор `FILE_SHARE_READ` без следования ссылкам), корень `office_files::UPDATES_ROOT`; шаг владельца — фичи `windows-sys`.
- Задача 6 — оболочка: `launch.rs` (`ShellExecuteExW` с `runas` и `/P /UPDATE /R` за трейтом `Launcher`), `pending.rs` (`update-pending.json` и итог при старте), `lockdown::release_for_exit`, `host_probe::host_versions` (версии хоста без отказа по протоколу).
- Задача 7 — оболочка: `UpdateState` и команды `update_scan`, `update_verify`, `update_install`, `update_outcome`, `update_outcome_dismiss`, `update_open_folder`; `manage_state`; контракт IPC в `tests/ipc.rs`, правила и проверка хоста в `tests/update.rs`.
- Задача 8 — вебвью: `src/office/info/update-shell.ts` (команды, Zod, коды отказов), `update-context.tsx`, `update-flow.ts` (предупреждения перед запуском, ожидание свежей копии хоста, отчёт `app.update.start`, запуск).
- Задача 9 — вебвью: раздел `UpdateSection` в `ABOUT_SECTIONS` после «Лицензии», тексты `office.about.update.*`, тесты.
- Задача 10 — установщик: обновление (`$UpdateMode = 1`) не задаёт вопрос о профиле сети; `smoke.ps1` проверяет пассивное обновление `/P /UPDATE` на раннере; контракты.
- Задача 11 — документы: `apps/standalone/AGENTS.md`, памятка `docs/runbooks/standalone-install.md` (обновление из файла, запасной ручной путь, порядок с Authenticode, памятка ИТ), §22 спецификации.

**Tech Stack:** Rust (Tauri 2.11, axum 0.8.9, sqlx 0.8.6, `sha2` в `markiro-proto`, `windows-sys` 0.61.2), Node 24 `node:crypto` и `node:test`, TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, React 19.2, `@tanstack/react-query` 5, Vitest 4 с jsdom.

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (принята, редакция 3): §10.1–§10.5, §10.7, §10.8, §10.9, §10.10, §9.3 (часть «Из файла»), §8.2 (строка `POST /v1/office/updates/started`), §8.3 (`app.update.start`), §12.1 («Оболочка», «Контракты выпуска»), §12.2, §13 (строка 5); этот план пишет §22 при исполнении.
- Бриф писателей планов `/tmp/claude/fb/license-plans-brief.md` (контракт имён ЛЦ-1, ОБН-1, ОБН-2).
- Код: `tools/standalone-release/{prepare.mjs,sign-overlay.mjs,smoke.ps1,test/*}`, задание `standalone-windows-build` в `.github/workflows/ci.yml`, `apps/standalone/src-tauri/{Cargo.toml,src/lib.rs,src/lockdown.rs,src/office_files.rs,src/host_probe.rs,src/installation.rs,windows/installer-hooks.nsh,tauri.installer.conf.json}`, `apps/standalone/host/src/backup/key_file.rs` (образец неразделяемого дескриптора), `apps/standalone/host/src/routes/office_exports.rs` (образец «офис сообщил» — `shift.export`), ветка `claude/fb-about` (`apps/standalone/src/office/info/*`, коммит `32d6aa5fa`).
- Шаблон установщика Tauri NSIS (встроен в `@tauri-apps/cli` 2.11.4, прочитан строками бинарника при написании плана): ключи `/P` (пассивный режим), `/UPDATE` (обновление без удаления прежней копии; деинсталлятор при этом получает `/UPDATE` тоже), `/R` (после пассивной или тихой установки запустить приложение от имени вошедшего пользователя через `nsis_tauri_utils::RunAsUser`), `/ARGS`; макрос `CheckIfAppIsRunning` в пассивном режиме без вопроса завершает работающее приложение; секция `EarlyChecks` отказывает в понижении версии при `allowDowngrades: false` **только** в тихом режиме (`${Silent}`).

## Допущения

- **Д1 — тело `POST /v1/office/updates/started`: `{ from, to, installerSha256, source }`, без `deviceId`.** Спецификация (§8.2) называет `deviceId`; хост берёт устройство из сессии (`OfficeContext.device_id`, `host/src/auth.rs:171`): офисная сессия привязана к устройству, а идентификатор, присланный только клиентом, не доверяется (корневой `AGENTS.md`, «Tenancy and identity»). `source` — `"file"` или `"host"`: ОБН-3 шлёт тот же отчёт для установщика, скачанного с хоста, без изменения формы. `to` не меньше `from` (равная версия — ремонт, §10.8).
- **Д2 — строка `app.update.start` пишется до запуска.** Порядок §10.4 (шаг 4 перед шагом 5): если Windows не дала прав администратора, строка остаётся, а следующая попытка пишет ещё одну. Строка говорит «офис начал обновление этого ПК», как `shift.export` — «офис сообщил»; что ПК действительно обновился, показывает его версия при следующем подключении (ОБН-1). Если хост не отвечает и администратор подтвердил обновление без хоста (§10.7, ЛО12), отказ транспорта при отчёте установку не останавливает.
- **Д3 — ключи установщика `/P /UPDATE /R`, без `/ROLE`.** `/UPDATE` обязателен: без него пассивная установка поверх может выбрать «удалить перед установкой», и хук `NSIS_HOOK_PREUNINSTALL` с `$UpdateMode <> 1` снимет роль и `installation.json` (памятка `standalone-install.md`, «Обновление», пункт 2 описывает это для оконного режима). `/R` перезапускает приложение после установки. Пассивный режим сам завершает работающее приложение (`CheckIfAppIsRunning`), поэтому выход программы сразу после запуска — не условие корректности, а вежливость.
- **Д4 — понижение версии для запуска из программы закрывает только сама программа.** `bundle.windows.allowDowngrades: false` (ОБН-1) отказывает старому установщику в тихом режиме и в окне выбора, но пассивный `/P /UPDATE` с меньшей версией шаблон пропускает (`PageLeaveReinstall` в режиме обновления сразу идёт к установке). Правило §10.8 «старее установленной — отказ» в оболочке (`rules::decide`) — единственная граница для этого пути; тест закрепляет его в Rust и в вебвью.
- **Д5 — манифест проверяется уже при поиске.** Проверка подписи — миллисекунды; поэтому список §10.5 показывает версию только у подписанных пакетов, а «не проверено» относится к установщику (его SHA-256 считается по «Проверить»). Неподписанный, чужой или испорченный файл виден в списке с причиной, без версии.
- **Д6 — путь пакета webview называет только из последнего поиска.** `update_verify` и `update_install` принимают путь строкой и сверяют его с путями, которые нашла сама оболочка (`invalid_request` иначе, §10.4 шаг 1). Установщик открывается рядом с манифестом по имени `markiro-standalone-<версия манифеста>-windows-x86_64-setup.exe` (`installer_name`); другое имя в подписанном манифесте — `manifest_malformed`.
- **Д7 — дескриптор установщика.** Windows: `share_mode(FILE_SHARE_READ)` (другие могут только читать — установщик, который Windows запускает под UAC, открывает файл на чтение и исполнение) и `FILE_FLAG_OPEN_REPARSE_POINT` (ссылка открывается как ссылка и отвергается). Дескриптор держится от хеша до выхода программы. Прочие ОС (разработка): проверка «тот же файл» по `dev`/`ino`, как `key_file::still_named`. Константы — числами с комментарием, как `key_file.rs` (только `std`).
- **Д8 — итог при старте — в памяти, отметка — `update-pending.json` с `startedAtMs`.** Спецификация (§10.11.4) называет `startedAt`; у оболочки нет крейта времени, поэтому миллисекунды UTC. При старте: версия равна `to` — итог «обновлено», отметка удаляется сразу; равна `from` — «не завершилось», отметка остаётся до «Скрыть» (`update_outcome_dismiss`) или следующей попытки; иначе отметка устарела и удаляется. Команд шесть, а не четыре брифа: `update_outcome_dismiss` и `update_open_folder` («Открыть папку», §10.5) — дополнения, имена брифа не меняются.
- **Д9 — проверка хоста — по `hello` без закрепления сертификата.** `host_probe::host_versions` читает `product`, `protocol`, `minProtocol`, `version` любым протоколом (`observe_hello` отвергает несовместимый хост, а ПК, отставший от хоста, именно этим и интересен). Подмена ответа может лишь отказать или пропустить «сначала обновите хост» — вопрос совместимости, не безопасности: подлинность пакета держит подпись. На ПК с ролью `host` хост не спрашивается (§10.7: его обновляет тот же установщик).
- **Д10 — предупреждения, которые знает только офис, — в вебвью.** Список устройств, которые не подключатся после обновления хоста (`minProtocol` манифеста больше их протокола, §10.7), и открытая смена этого ПК (§10.7, §9.3 п. 3) считаются в `update-flow.ts` из `GET /v1/office/devices` (поле `protocol` — ОБН-1) и `GET /v1/office/shifts`; подтверждения, которые проверяет оболочка (`reinstall`, `host_unreachable`), передаются в `update_install` и сверяются заново.
- **Д11 — корень «Обновления» не входит в `office_files::ROOTS`.** `ROOTS` — папки, куда офис **пишет** (`save_office_files`); в «Обновления» программа только смотрит. Новая константа `UPDATES_ROOT`, папку создаёт и показывает `update_open_folder`.
- **Д12 — тексты — `office.about.update.*`.** Спецификация (§9.7) предлагала `office.info.*`; каркас `claude/fb-about` и бриф используют `office.about.*`.
- **Д13 — поле протокола устройства — `DeviceRecord.protocol`.** Бриф называет список устройств `OfficeDevice`; в коде это `markiro_proto::DeviceRecord` (`proto/src/lib.rs:503`) и `deviceRecordSchema` (`src/host/protocol.ts:175`). План читает `protocol: number | null`, которое добавляет ОБН-1 (`null` — устройство версии до ОБН-1 не сообщило).
- **Д14 — тестовые манифесты для Rust подписывает генератор этого плана тестовым ключом ЛЦ-1.** Одной фикстуры ЛЦ-1 `update-manifest.jws` мало (нужны новее, старее, с `minUpgradeFrom`, с протоколом выше хоста, испорченная). Генератор `tools/standalone-release/generate-update-fixtures.mjs` подписывает их тем же `signCompact`, что и `sign-update.mjs`; установщики тестов не коммитятся — тест пишет их байты (`markiro test installer <версия>\n`), а манифест несёт их SHA-256. В CI генератор не запускается; контракт проверяет подписи закоммиченных файлов.
- **Д15 — часть «С хоста» раздела, таблица «Устройства и версии», история, загрузка пакета на хост (§10.4 шаг 3, §9.3 п. 4 и 6) и блок «Обновления» сведений для поддержки (§9.4) — ОБН-3** (раздел «Перенесено»).

## Global Constraints

**Распределение (BINDING, бриф 2026-10-13):**

- Миграции хоста: `0030_license.sql` (ЛЦ-2), `0031_device_versions.sql` (ОБН-1), `0032`–`0033` — резерв направления. Другие открытые ветки используют `0017`–`0018` (`fb-codesearch`, `fb-people`, `fb-templates`, `fb-mode`) — не трогать. **Этот план миграций хоста не добавляет.**
- Оболочка (`src-tauri/migrations`) — в этом направлении новых миграций нет (`0030`–`0031` зарезервированы и не используются). **Этот план миграций оболочки не добавляет.**
- Облако (`packages/db/migrations`) — только ЛЦ-0. Этот план облако не трогает.
- Разделы «Уточнения плана …» спецификации: §18 ЛЦ-1, §19 ЛЦ-2, §20 ОБН-1, §21 ЛЦ-3, **§22 ОБН-2**, §23 ОБН-3, §24 ЛЦ-0.
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (ЛЦ-3 ∥ ОБН-2) → ОБН-3.
- Имена контракта (используются ровно так): `markiro_proto::trust::{verify_update_manifest, update_keyset, Keyset, TrustError, UpdateManifestV1}`, фича `test-keys` у `markiro-proto`; `STANDALONE_UPDATE_TYP = "markiro-standalone-update+jws"`; `standaloneUpdateManifestV1Schema` в `@markiro/domain`; фикстуры `packages/domain/fixtures/standalone-license/{test-keyset.json,test-private-keys.json,update-manifest.jws,license-subscription.jws}`; `DeviceRecord.protocol` (ОБН-1); команды `update_scan`, `update_verify`, `update_install`, `update_outcome`; маршрут `POST /v1/office/updates/started`; `APP_UPDATE_START = "app.update.start"`; раздел `{ id: "update", titleKey: "office.about.update.title" }` после `license`; `tools/standalone-release/sign-update.mjs`; черновик манифеста в `prepare.mjs`.

**Правила для всех задач**

- TDD: сначала падающий тест, затем код; существующие утверждения не ослабляются (тесты, которым меняется ожидаемое — состав выпуска, оглавление «Информации», шаги `smoke.ps1`, — получают **больше** проверок, а не меньше).
- Формы на проводе — `proto`, Zod и фикстуры вместе; типы ответов терпимы, типы запросов — `deny_unknown_fields` и `.strict()`.
- Аудит — точные субъект, действие, цель, итог и разобранные `details`. В `details`, логах и тексте сведений для поддержки нет ни ключей, ни парольной фразы, ни текста манифеста; SHA-256 установщика — контрольная сумма для сверки, не секрет (как SHA-256 копии в `backup.create`). Логи — только код ошибки и вид ошибки ввода-вывода, без путей (путь называет пользователя Windows).
- i18n — только `apps/standalone/src/i18n/ru.json`; `@markiro/ui` переиспользуется; доступность: клавиатура, видимый фокус, подписи, состояние не только цветом, ход операции — в вежливой живой области.
- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов.
- Rust: `cargo fmt` чистый, сборка без предупреждений. `Cargo.lock` **не меняется**. `src-tauri/Cargo.toml` меняется только двумя правками: фича `test-keys` у `markiro-proto` в `[dev-dependencies]` (исполнитель; фичи в `Cargo.lock` не записываются) и фичи `windows-sys` (шаг владельца, задача 5). `package.json` и `pnpm-lock.yaml` не меняются — новых JS-зависимостей нет.
- Никакого исходящего соединения: ни updater-плагина, ни HTTP-клиента к адресам кроме закреплённого хоста (§10.10); задача 3 закрепляет это контрактом.
- Коммиты — явные пути, сообщение из файла, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR и выпуск — не задачи плана.

## Заметки для исполнения

**Основа и предусловия.** План исполняется после ЛЦ-1, ОБН-1 и слияния `claude/fb-about`, параллельно с ЛЦ-3. Перед задачей 1 проверить в рабочем дереве и **остановиться с отчётом**, если чего-то нет:

```bash
grep -n "pub fn verify_update_manifest\|pub fn update_keyset\|pub struct UpdateManifestV1\|pub enum TrustError" apps/standalone/proto/src/trust.rs
grep -n "test-keys" apps/standalone/proto/Cargo.toml
grep -rn "standaloneUpdateManifestV1Schema" packages/domain/src/index.ts packages/domain/src/standalone-license/
ls packages/domain/fixtures/standalone-license/test-keyset.json packages/domain/fixtures/standalone-license/test-private-keys.json packages/domain/fixtures/standalone-license/update-manifest.jws packages/domain/fixtures/standalone-license/license-subscription.jws
grep -n "protocol" apps/standalone/src/host/protocol.ts | grep -n "deviceRecordSchema\|protocol:" | head
ls apps/standalone/src/office/info/sections.tsx apps/standalone/src/office/info/about-data.ts
grep -n "allowDowngrades" apps/standalone/src-tauri/tauri.installer.conf.json apps/standalone/src-tauri/tauri.conf.json
```

Ожидается: четыре имени `trust`, фича `test-keys`, экспорт схемы манифеста, четыре фикстуры, поле `protocol` в `deviceRecordSchema` (ОБН-1), файлы каркаса «Информации», `allowDowngrades` (ОБН-1). Поля `UpdateManifestV1` план читает как serde-зеркало §10.2 в snake_case: `version: String`, `product: String`, `channel`, `released_at`, `source_sha`, `installer.name: String`, `installer.sha256: String`, `installer.size_bytes: u64`, `protocol: u32`, `min_protocol: u32`, `min_upgrade_from: String`, `notes: Vec<String>`, `derive(Serialize, Deserialize)`. Другое имя или тип поля — применить по смыслу и записать в «Отклонения при исполнении». Если у `UpdateManifestV1` нет `Serialize`, отчёт оболочки собирает `manifest` полями вручную (тот же JSON).

**ЛЦ-2.** Если в основе есть таблицы классификации маршрутов ЛЦ-2 («закрываемые» / «никогда», §3.3; `grep -rn "updates/started\|never" apps/standalone/host/src/license/`), задача 2 добавляет `POST /v1/office/updates/started` в таблицу «никогда» (обновление не закрывается ни в каком состоянии лицензии), и тест классификации ЛЦ-2 проходит. Если ЛЦ-2 ещё не слит — шаг пропускается и записывается.

**Пересечения с ЛЦ-3.** Обе ветки правят `apps/standalone/src/office/info/sections.tsx` (ЛЦ-3 — `LicenseSection`, этот план — новая запись), ключ `office.about` в `ru.json` и тест оглавления в `test/about-page.test.tsx`. Правки этого плана — добавочные: при слиянии оставить обе.

**Фрагменты.** «Фрагмент … заменить на …» дан так, как стоит в файле основы `claude/fb-license` (`f38f4a3e9`) и в `claude/fb-about` (`32d6aa5fa`); на копии не прогонялся. Не находится — применить по смыслу и записать в «Отклонения при исполнении».

**Перед каждым коммитом.** `node_modules/.bin/prettier --ignore-path .prettierignore --write` на изменённые TS, TSX, JSON, MJS и MD, затем `--check` на них же (prettier не покрывает `smoke.ps1` и `.nsh`); `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint` (если тронут вебвью); `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (если тронут Rust); `git diff --check`.

**pnpm, git, Cargo.** pnpm — только с `--config.verifyDepsBeforeRun=false`, без `pnpm install`/`add`; команды из корня, без `cd`; без `git stash`. В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'` (сборка `@markiro/domain` с ЛЦ-1). Cargo — `--offline --locked`. Перед `-p markiro-standalone` в свежем worktree — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`). `--test ipc`, `--test update` (оболочка) открывают сокет на 127.0.0.1 — вне песочницы; `-p markiro-proto --test update`, `-p markiro-host --test app_updates`, `--lib` оболочки и `node --test` сокета не открывают. Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный вывод `rtk` — `rtk proxy <команда>`.

**Windows.** Код под `#[cfg(windows)]` (запуск `ShellExecuteExW`, `GetLogicalDrives`/`GetDriveTypeW`, флаги дескриптора, тест совместного доступа) на macOS не компилируется; его компилирует и тестирует только задание `standalone-windows-build` после шага владельца (фичи `windows-sys`, задача 5). Push до шага владельца уронит это задание.

## Файлы

- Create (протокол): `apps/standalone/proto/src/update.rs`, `apps/standalone/proto/tests/update.rs`, `apps/standalone/proto/fixtures/update-started.json`
- Create (хост): `apps/standalone/host/src/routes/app_updates.rs`, `apps/standalone/host/tests/app_updates.rs`
- Create (выпуск): `tools/standalone-release/sign-update.mjs`, `tools/standalone-release/generate-update-fixtures.mjs`, `tools/standalone-release/test/sign-update.test.mjs`, `tools/standalone-release/test/update-fixtures.test.mjs`, `tools/standalone-release/test/offline.test.mjs`, `apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.2.0.update.jws`, `apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.3.0.update.jws`, `apps/standalone/src-tauri/tests/fixtures/update/tampered/markiro-standalone-0.2.0.update.jws`
- Create (оболочка): `apps/standalone/src-tauri/src/update/mod.rs`, `apps/standalone/src-tauri/src/update/rules.rs`, `apps/standalone/src-tauri/src/update/package.rs`, `apps/standalone/src-tauri/src/update/launch.rs`, `apps/standalone/src-tauri/src/update/pending.rs`, `apps/standalone/src-tauri/tests/update.rs`
- Create (вебвью): `apps/standalone/src/office/info/update-shell.ts`, `apps/standalone/src/office/info/update-context.tsx`, `apps/standalone/src/office/info/update-flow.ts`, `apps/standalone/src/office/info/UpdateSection.tsx`, `apps/standalone/test/update-shell.test.ts`, `apps/standalone/test/update-flow.test.ts`, `apps/standalone/test/update-section.test.tsx`
- Modify (протокол): `apps/standalone/proto/src/lib.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`, `apps/standalone/test/protocol.test.ts`
- Modify (хост): `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`; если есть ЛЦ-2 — его таблица «никогда»
- Modify (вебвью, API): `apps/standalone/src/host/api.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/support/office.tsx`
- Modify (выпуск): `tools/standalone-release/prepare.mjs`, `tools/standalone-release/test/prepare.test.mjs`, `tools/standalone-release/smoke.ps1`, `tools/standalone-release/test/workflow.test.mjs`, `tools/standalone-release/test/installer.test.mjs`
- Modify (оболочка): `apps/standalone/src-tauri/Cargo.toml` (dev-фича исполнителем; фичи `windows-sys` — владелец), `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/src/lockdown.rs`, `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src-tauri/src/host_probe.rs`, `apps/standalone/src-tauri/tests/ipc.rs`, `apps/standalone/src-tauri/windows/installer-hooks.nsh`
- Modify (вебвью, страница): `apps/standalone/src/office/info/sections.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/about-page.test.tsx`
- Modify (документы): `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`

---

### Task 1: Протокол обновления — `AppVersion`, хеш ровно по размеру, отчёт `UpdateStarted`, Zod и построитель

**Files:**

- Create: `apps/standalone/proto/src/update.rs`, `apps/standalone/proto/fixtures/update-started.json`, `apps/standalone/proto/tests/update.rs`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/requests.ts`
- Test: `apps/standalone/proto/tests/update.rs`, `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- Consumes: `sha2` (уже зависимость `markiro-proto`), `serde`.
- Produces: `markiro_proto::update::{PRODUCT, AppVersion, NotAVersion, installer_name, hash_exact, HashError, UpdateSource, UpdateStarted}`; фикстура `update-started.json`; `appVersionSchema`, `updateStartedSchema`, `type UpdateStarted` в `src/host/protocol.ts`; `updateStarted(input, source)` и `UpdateStartedInput` в `src/host/requests.ts`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/proto/fixtures/update-started.json`:

```json
{
  "from": "0.1.0",
  "to": "0.2.0",
  "installerSha256": "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
  "source": "file"
}
```

Создать `apps/standalone/proto/tests/update.rs`:

```rust
//! The update wire and rules the host and the shell share (plan ОБН-2): the
//! version form `prepare.mjs` accepts, the installer's name, the SHA-256 of
//! exactly the bytes a manifest names, and the office's report of a start.

use std::io::{self, Read};

use markiro_proto::update::{
    hash_exact, installer_name, AppVersion, HashError, UpdateSource, UpdateStarted, PRODUCT,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

#[test]
fn a_version_is_three_plain_numbers_and_orders_as_numbers() {
    let parse = |text: &str| text.parse::<AppVersion>();
    assert_eq!(
        parse("0.1.0"),
        Ok(AppVersion {
            major: 0,
            minor: 1,
            patch: 0
        })
    );
    assert_eq!(parse("12.0.345").unwrap().to_string(), "12.0.345");
    for bad in [
        "",
        "0.1",
        "v0.1.0",
        "0.1.0-beta.1",
        "01.1.0",
        "0.01.0",
        "1.2.3.4",
        "1..3",
        " 1.2.3",
        "1.2.3\n",
        "1.2.+3",
        "4294967296.0.0",
        "١.٢.٣",
    ] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
    let v = |text: &str| parse(text).unwrap();
    assert!(v("0.2.0") > v("0.1.9"));
    assert!(v("0.10.0") > v("0.9.0"));
    assert!(v("1.0.0") > v("0.99.99"));
    assert_eq!(v("0.2.0"), v("0.2.0"));
}

#[test]
fn the_installer_and_the_product_are_named_as_prepare_mjs_names_them() {
    let version: AppVersion = "0.2.0".parse().unwrap();
    assert_eq!(
        installer_name(&version),
        "markiro-standalone-0.2.0-windows-x86_64-setup.exe"
    );
    assert_eq!(PRODUCT, "markiro-standalone");
}

struct Broken;

impl Read for Broken {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }
}

#[test]
fn the_hash_covers_exactly_the_size_the_manifest_names() {
    assert_eq!(
        hash_exact(&b"abc"[..], 3),
        Ok("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned())
    );
    assert_eq!(hash_exact(&b"abc"[..], 4), Err(HashError::TooShort));
    assert_eq!(hash_exact(&b"abc"[..], 2), Err(HashError::TooLong));
    assert_eq!(
        hash_exact(&b""[..], 0),
        Ok("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned())
    );
    // More than one 64 KiB piece, and one byte past the size.
    let big = vec![7u8; 200_000];
    let expected: String = Sha256::digest(&big)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(hash_exact(&big[..], 200_000), Ok(expected));
    assert_eq!(hash_exact(&big[..], 199_999), Err(HashError::TooLong));
    assert_eq!(
        hash_exact(Broken, 1),
        Err(HashError::Io(io::ErrorKind::PermissionDenied))
    );
}

#[test]
fn the_report_of_a_started_update_round_trips_and_refuses_what_the_host_does_not_read() {
    let original = fixture("update-started.json");
    let record: UpdateStarted = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(record.source, UpdateSource::File);
    assert_eq!(serde_json::to_value(&record).unwrap(), original);
    let mut from_host = original.clone();
    from_host["source"] = "host".into();
    assert_eq!(
        serde_json::from_value::<UpdateStarted>(from_host)
            .unwrap()
            .source,
        UpdateSource::Host
    );
    // The device is the session's: a body that names one is refused.
    for (field, value) in [
        ("deviceId", Value::from("7c9e6679-7425-40de-944b-e07fc1f90ae7")),
        ("source", Value::from("usb")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        assert!(
            serde_json::from_value::<UpdateStarted>(changed).is_err(),
            "{field}"
        );
    }
    let mut missing = original;
    missing.as_object_mut().unwrap().remove("installerSha256");
    assert!(serde_json::from_value::<UpdateStarted>(missing).is_err());
}
```

Правка `apps/standalone/test/protocol.test.ts`:

Фрагмент 1 (импорт схем из `../src/host/protocol.js`; список в алфавитном порядке, `updateStartedSchema` встаёт по порядку):

<!-- prettier-ignore -->
```ts
  shiftExportRecordSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  shiftExportRecordSchema,
  updateStartedSchema,
```

Если `updateStartedSchema` по алфавиту должен стоять ниже другого имени в этом списке — поставить по алфавиту.

Фрагмент 2 (импорт построителей из `../src/host/requests.js`):

<!-- prettier-ignore -->
```ts
  shiftExportRecord,
```

заменить на:

<!-- prettier-ignore -->
```ts
  shiftExportRecord,
  updateStarted,
```

Фрагмент 3 (таблица `REQUESTS`):

<!-- prettier-ignore -->
```ts
  ["shift-export-record.json", shiftExportRecordSchema],
```

заменить на:

<!-- prettier-ignore -->
```ts
  ["shift-export-record.json", shiftExportRecordSchema],
  ["update-started.json", updateStartedSchema],
```

В конец файла добавить:

<!-- prettier-ignore -->
```ts
describe("the report of a started update (plan ОБН-2)", () => {
  const record = fixture("update-started.json") as Record<string, unknown>;

  it("is built field by field, the source named, and no device: the host takes the session's", () => {
    expect(
      updateStarted(
        {
          from: "0.1.0",
          to: "0.2.0",
          installerSha256: "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
        },
        "file",
      ),
    ).toStrictEqual(record);
    expect(updateStartedSchema.parse({ ...record, source: "host" }).source).toBe("host");
  });

  it("takes only plain versions, a lower-case SHA-256 and a known source", () => {
    for (const change of [
      { from: "0.1" },
      { to: "v0.2.0" },
      { to: "0.2.0-beta.1" },
      { from: "01.1.0" },
      { installerSha256: String(record.installerSha256).toUpperCase() },
      { installerSha256: "ab" },
      { source: "usb" },
    ]) {
      expect(updateStartedSchema.safeParse({ ...record, ...change }).success, JSON.stringify(change)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test update
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts
```

Ожидается: Rust — FAIL компиляции (`unresolved import markiro_proto::update`); Vitest — FAIL (`updateStartedSchema` и `updateStarted` не экспортированы, файл не собирается).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/proto/src/update.rs`:

```rust
//! Updates of «Markiro Автоном» from a file (plan ОБН-2, spec §10): the
//! version rule every side shares, the installer's name, the SHA-256 of an
//! installer read to its exact size, and the report the office sends when it
//! starts one. The signed manifest itself is `trust::UpdateManifestV1`
//! (plan ЛЦ-1).

use std::fmt;
use std::io::{self, Read};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The product an update manifest names.
pub const PRODUCT: &str = "markiro-standalone";

/// A release version `MAJOR.MINOR.PATCH`, the form `prepare.mjs` accepts:
/// decimal numbers without leading zeros and nothing before, between or
/// after them. Ordered as numbers, `MAJOR` first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AppVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// A text that is not a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAVersion;

impl FromStr for AppVersion {
    type Err = NotAVersion;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let mut parts = text.split('.');
        let mut next = || -> Result<u32, NotAVersion> {
            let part = parts.next().ok_or(NotAVersion)?;
            // `u32::from_str` takes a leading `+`: only ASCII digits pass here.
            let plain = !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'));
            if !plain {
                return Err(NotAVersion);
            }
            part.parse().map_err(|_| NotAVersion)
        };
        let version = AppVersion {
            major: next()?,
            minor: next()?,
            patch: next()?,
        };
        if parts.next().is_some() {
            return Err(NotAVersion);
        }
        Ok(version)
    }
}

impl fmt::Display for AppVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The installer's name `prepare.mjs` gives a version (`standaloneInstallerName`).
pub fn installer_name(version: &AppVersion) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// Where the installer of a started update came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    /// A package found on this computer (plan ОБН-2).
    File,
    /// A package downloaded from the host (plan ОБН-3).
    Host,
}

/// `POST /v1/office/updates/started` (spec §8.2, §10.4): the office starts
/// an installer on its PC. The device is the office session's own, never a
/// field; the host checks the versions and the hash's form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStarted {
    pub from: String,
    pub to: String,
    pub installer_sha256: String,
    pub source: UpdateSource,
}

/// Why [`hash_exact`] gave no hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashError {
    /// The reader ended before `size` bytes.
    TooShort,
    /// The reader had a byte past `size`.
    TooLong,
    Io(io::ErrorKind),
}

/// The lower-case hex SHA-256 of exactly `size` bytes of `reader`, read in
/// 64 KiB pieces, never whole: fewer bytes is [`HashError::TooShort`], one
/// byte more is [`HashError::TooLong`], found as soon as it is read.
pub fn hash_exact<R: Read>(mut reader: R, size: u64) -> Result<String, HashError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut read: u64 = 0;
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(HashError::Io(error.kind())),
        };
        if n == 0 {
            break;
        }
        read = read.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        if read > size {
            return Err(HashError::TooLong);
        }
        hasher.update(&buffer[..n]);
    }
    if read < size {
        return Err(HashError::TooShort);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
```

Правка `apps/standalone/proto/src/lib.rs` (ЛЦ-1 мог добавить здесь `pub mod trust;` — оставить его):

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
pub mod pairing;
pub mod update;
```

Правка `apps/standalone/src/host/protocol.ts` — после блока `shiftExportRecordSchema` (фрагмент `export type ShiftExportRecord = z.infer<typeof shiftExportRecordSchema>;`) добавить:

<!-- prettier-ignore -->
```ts

/** `MAJOR.MINOR.PATCH` as `markiro_proto::update::AppVersion` reads it: no leading zeros, nothing around it. */
export const appVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

/**
 * Mirrors `markiro_proto::update::UpdateStarted`: `POST /v1/office/updates/started`
 * (plan ОБН-2), the office starts an installer on its PC. No device: the host
 * takes the session's.
 */
export const updateStartedSchema = z
  .object({
    from: appVersionSchema,
    to: appVersionSchema,
    installerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    source: z.enum(["file", "host"]),
  })
  .strict();
export type UpdateStarted = z.infer<typeof updateStartedSchema>;
```

Правка `apps/standalone/src/host/requests.ts`:

Фрагмент 1 (импорт типов):

<!-- prettier-ignore -->
```ts
  TemplateUpdate,
} from "./protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
  TemplateUpdate,
  UpdateStarted,
} from "./protocol.js";
```

Фрагмент 2 — в конец файла добавить:

<!-- prettier-ignore -->
```ts

/** What a started update reports: this PC's version, the new one and the installer's SHA-256. */
export interface UpdateStartedInput {
  from: string;
  to: string;
  installerSha256: string;
}

/**
 * `POST /v1/office/updates/started` (`update-started.json`, plan ОБН-2):
 * every field named, the source given. The device is never a field: the host
 * takes the office session's.
 */
export function updateStarted(
  input: UpdateStartedInput,
  source: UpdateStarted["source"],
): UpdateStarted {
  return {
    from: input.from,
    to: input.to,
    installerSha256: input.installerSha256,
    source,
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts
```

Ожидается: PASS (новые 4 теста `--test update`, остальные тесты протокола без изменений; Vitest — фикстура в `REQUESTS` и два новых теста).

- [ ] **Step 5: Гейты и коммит**

Гейты из «Заметок для исполнения» (prettier на `update-started.json`, `protocol.ts`, `requests.ts`, `protocol.test.ts`; `typecheck`, `lint`; `cargo fmt … --check`; `git diff --check`).

```bash
git add apps/standalone/proto/src/update.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/fixtures/update-started.json apps/standalone/proto/tests/update.rs apps/standalone/src/host/protocol.ts apps/standalone/src/host/requests.ts apps/standalone/test/protocol.test.ts
git commit -F /tmp/claude/obn2-t1-msg.txt
```

Сообщение (`/tmp/claude/obn2-t1-msg.txt`):

```text
feat(standalone): update wire — versions, the installer's exact hash, the started report (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 2: Хост — `POST /v1/office/updates/started` и строка `app.update.start`; `HostApi.recordUpdateStarted`

**Files:**

- Create: `apps/standalone/host/src/routes/app_updates.rs`, `apps/standalone/host/tests/app_updates.rs`
- Modify: `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`; если в основе есть ЛЦ-2 — его таблица классификации маршрутов
- Test: `apps/standalone/host/tests/app_updates.rs`, `apps/standalone/test/api.test.ts`

**Interfaces:**

- Consumes: `markiro_proto::update::{AppVersion, UpdateStarted}` (задача 1); `OfficeContext::{require_admin, require_admin_in, actor, device_id}`, `audit::record`, `db::begin_write`, `ApiJson`.
- Produces: `audit::actions::APP_UPDATE_START = "app.update.start"`; маршрут `POST /v1/office/updates/started` → `204`, администратор, без ревизии; `HostApi.recordUpdateStarted(token, record): Promise<void>`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/host/tests/app_updates.rs`:

```rust
//! `POST /v1/office/updates/started` (plan ОБН-2): one `app.update.start` row
//! by the administrator with the session's device as its target, no
//! revision; every refusal writes nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, request,
    with_device, with_session, Admin,
};

const PATH: &str = "/v1/office/updates/started";
const SHA: &str = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

fn started(from: &str, to: &str) -> Value {
    json!({ "from": from, "to": to, "installerSha256": SHA, "source": "file" })
}

/// The station the administrator's session is bound to.
async fn session_device(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn an_administrator_records_the_start_of_an_update_of_the_sessions_device() {
    let admin = admin().await;
    let device = session_device(&admin).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", PATH, Some(started("0.1.0", "0.2.0")))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    // A reinstall of the same version is an update too (spec §10.8), and a
    // package from the host is reported the same way (plan ОБН-3).
    let mut from_host = started("0.2.0", "0.2.0");
    from_host["source"] = json!("host");
    let (status, body) = admin.call("POST", PATH, Some(from_host)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        audit_trail(&admin.app, "app.update.start").await,
        vec![
            admin.row(
                "app.update.start",
                "device",
                &device,
                json!({ "from": "0.1.0", "to": "0.2.0", "installerSha256": SHA, "source": "file" }),
            ),
            admin.row(
                "app.update.start",
                "device",
                &device,
                json!({ "from": "0.2.0", "to": "0.2.0", "installerSha256": SHA, "source": "host" }),
            ),
        ]
    );
    assert_eq!(
        host_revision(&admin.app).await,
        rev,
        "nothing changed, no revision"
    );
}

#[tokio::test]
async fn only_an_administrators_session_records_and_a_refusal_writes_nothing() {
    let admin = admin().await;
    let body = started("0.1.0", "0.2.0");
    let (status, answer) = admin
        .app
        .send(json_request(request("POST", PATH), body.clone()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no credential {answer}");
    let (status, answer) = admin
        .app
        .send(json_request(
            with_device(request("POST", PATH), &admin.key),
            body.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a device key alone {answer}");
    let (status, answer) = admin
        .app
        .send(json_request(
            with_session(request("POST", PATH), &admin.key, "not-a-token"),
            body.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unknown token {answer}");
    let technologist = admin.technologist().await;
    let (status, answer) = admin
        .call_as(&technologist, "POST", PATH, Some(body))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(audit_trail(&admin.app, "app.update.start").await, vec![]);
}

#[tokio::test]
async fn a_body_that_is_not_the_report_is_refused_and_writes_nothing() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let mut cases: Vec<(&str, Value)> = vec![
        ("from", started("0.1", "0.2.0")),
        ("from", started("v0.1.0", "0.2.0")),
        ("to", started("0.1.0", "0.2.0-beta.1")),
        ("to", started("0.2.0", "0.1.0")),
        ("to", started("0.10.0", "0.9.0")),
    ];
    for sha in [
        SHA.to_uppercase(),
        SHA[1..].to_owned(),
        format!("{SHA}0"),
        "g".repeat(64),
    ] {
        let mut body = started("0.1.0", "0.2.0");
        body["installerSha256"] = json!(sha);
        cases.push(("installerSha256", body));
    }
    let mut device = started("0.1.0", "0.2.0");
    device["deviceId"] = json!("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    cases.push(("deviceId", device));
    let mut usb = started("0.1.0", "0.2.0");
    usb["source"] = json!("usb");
    cases.push(("source", usb));
    let mut missing = started("0.1.0", "0.2.0");
    missing.as_object_mut().unwrap().remove("from");
    cases.push(("missing from", missing));
    for (what, body) in cases {
        let (status, answer) = admin.call("POST", PATH, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what} {body} {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{what}");
    }
    let mut short = started("0.1.0", "0.2.0");
    short["installerSha256"] = json!("ab");
    for (field, body) in [
        ("from", started("0.1", "0.2.0")),
        ("to", started("0.2.0", "0.1.0")),
        ("installerSha256", short),
    ] {
        let (_, answer) = admin.call("POST", PATH, Some(body)).await;
        assert_eq!(answer["error"]["details"]["field"], field);
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}
```

Правка `apps/standalone/test/api.test.ts`:

Фрагмент 1 (рядом с `EXPORT_RECORD`):

<!-- prettier-ignore -->
```ts
const EXPORT_RECORD = shiftExportRecordSchema.parse(fixture("shift-export-record.json"));
```

заменить на:

<!-- prettier-ignore -->
```ts
const EXPORT_RECORD = shiftExportRecordSchema.parse(fixture("shift-export-record.json"));
const UPDATE_STARTED = updateStartedSchema.parse(fixture("update-started.json"));
```

и добавить `updateStartedSchema` в импорт из `../src/host/protocol.js` (рядом с `shiftExportRecordSchema`).

Фрагмент 2 (таблица `CASES`):

<!-- prettier-ignore -->
```ts
  [
    "recordShiftExport",
    null,
    (api) => api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
```

заменить на:

<!-- prettier-ignore -->
```ts
  [
    "recordShiftExport",
    null,
    (api) => api.recordShiftExport(TOKEN, SHIFT_ID, EXPORT_RECORD),
    { method: "POST", path: `/v1/office/shifts/${SHIFT_ID}/exports`, body: EXPORT_RECORD },
  ],
  [
    "recordUpdateStarted",
    null,
    (api) => api.recordUpdateStarted(TOKEN, UPDATE_STARTED),
    { method: "POST", path: "/v1/office/updates/started", body: UPDATE_STARTED },
  ],
```

Фрагмент 3 (после теста «resolves a recorded export with nothing…»):

<!-- prettier-ignore -->
```ts
  it("resolves a delete with nothing, and rejects an answer that carries a body", async () => {
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("resolves a recorded update start with nothing, and rejects an answer that carries a body", async () => {
    await expect(
      recording(null).api.recordUpdateStarted(TOKEN, UPDATE_STARTED),
    ).resolves.toBeUndefined();
    await expect(recording(shift).api.recordUpdateStarted(TOKEN, UPDATE_STARTED)).rejects.toThrow();
  });

  it("resolves a delete with nothing, and rejects an answer that carries a body", async () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test app_updates
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts
```

Ожидается: Rust — три теста FAIL (`404 not_found` вместо `204`/`403`/`400`); Vitest — FAIL типов и вызова (`recordUpdateStarted` нет в `HostApi`).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/src/routes/app_updates.rs`:

```rust
//! `POST /v1/office/updates/started` (plan ОБН-2, spec §8.2, §10.4): the
//! office reports that it starts an installer on its PC, and the host writes
//! one `app.update.start` row. Administrators only. Like `shift.export`, the
//! row records what the office session reported, not what happened: the host
//! never sees the installer, Windows may still refuse the administrator
//! rights, and the device's next connection shows the version it really runs
//! (plan ОБН-1). The device is the session's own, never one the body names;
//! nothing else changes and no revision is taken.

use axum::extract::State;
use axum::http::StatusCode;
use markiro_proto::update::{AppVersion, UpdateStarted};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

fn version(field: &str, text: &str) -> Result<AppVersion, ApiError> {
    text.parse()
        .map_err(|_| ApiError::validation(field, "a version is MAJOR.MINOR.PATCH"))
}

/// `204`; `validation_failed` on `from`, `to` (not a version, or older than
/// `from`) or `installerSha256` (not 64 lower-case hex digits).
pub async fn record_started(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(record): ApiJson<UpdateStarted>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    let from = version("from", &record.from)?;
    let to = version("to", &record.to)?;
    if to < from {
        return Err(ApiError::validation(
            "to",
            "an update never goes to an older version",
        ));
    }
    let hex = record.installer_sha256.len() == 64
        && record
            .installer_sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !hex {
        return Err(ApiError::validation(
            "installerSha256",
            "64 lower-case hex digits",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::APP_UPDATE_START,
            target_type: Some("device"),
            target_id: Some(&context.device_id),
            outcome: Outcome::Ok,
            details: json!({
                "from": record.from,
                "to": record.to,
                "installerSha256": record.installer_sha256,
                "source": record.source,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
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
    /// The office started an installer on its PC (plan ОБН-2): the session's
    /// device is the target, and the row records what the office reported,
    /// as `shift.export` does.
    pub const APP_UPDATE_START: &str = "app.update.start";
}
```

(ЛЦ-2 и ОБН-1 добавляют сюда свои имена — оставить их.)

Правка `apps/standalone/host/src/routes/mod.rs`:

Фрагмент:

```rust
pub mod backups;
```

заменить на:

```rust
pub mod app_updates;
pub mod backups;
```

Правка `apps/standalone/host/src/server.rs`:

Фрагмент:

```rust
        .route(
            "/v1/office/backups/resume",
            post(crate::routes::backups::resume_facts),
        )
```

заменить на:

```rust
        .route(
            "/v1/office/backups/resume",
            post(crate::routes::backups::resume_facts),
        )
        .route(
            "/v1/office/updates/started",
            post(crate::routes::app_updates::record_started),
        )
```

**ЛЦ-2 (если слит):** добавить `"/v1/office/updates/started"` (метод `POST`) в таблицу маршрутов «никогда» модуля лицензии с комментарием «обновление программы не закрывается ни в каком состоянии лицензии (§3.3)»; тест классификации ЛЦ-2 должен пройти. Нет ЛЦ-2 — записать в «Отклонения».

Правка `apps/standalone/src/host/api.ts`:

Фрагмент 1 — добавить `type UpdateStarted,` в импорт типов из `./protocol.js` (по алфавиту).

Фрагмент 2 (интерфейс `HostApi`):

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
  /**
   * Plan ОБН-2: the office starts an installer on this PC; the host writes one
   * `app.update.start` row with this session's device. Administrators only.
   */
  recordUpdateStarted: (token: string, record: UpdateStarted) => Promise<void>;
}
```

Фрагмент 3 (`createHostApi`):

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
    recordUpdateStarted: async (token, record) => {
      await client.request("POST", "/v1/office/updates/started", {
        body: record,
        officeToken: token,
        schema: NO_CONTENT,
      });
    },
  };
}
```

Правка `apps/standalone/test/support/office.tsx` — в `fakeHostApi` после строки `resumeFacts: …` добавить:

<!-- prettier-ignore -->
```ts
    recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(() =>
      unexpected("recordUpdateStarted"),
    ),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test app_updates
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/api.test.ts test/protocol.test.ts
```

Ожидается: PASS. Если в основе есть тест классификации маршрутов ЛЦ-2 — `cargo test … -p markiro-host --test <его файл>` тоже PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
git add apps/standalone/host/src/routes/app_updates.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/app_updates.rs apps/standalone/src/host/api.ts apps/standalone/test/api.test.ts apps/standalone/test/support/office.tsx
# и файл таблицы ЛЦ-2, если правился
git commit -F /tmp/claude/obn2-t2-msg.txt
```

Сообщение:

```text
feat(standalone): the office reports a started update — app.update.start on the session's device (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 3: Черновик манифеста в `prepare.mjs` и контракт «без интернета»

**Files:**

- Create: `tools/standalone-release/test/offline.test.mjs`
- Modify: `tools/standalone-release/prepare.mjs`
- Test: `tools/standalone-release/test/prepare.test.mjs`, `tools/standalone-release/test/offline.test.mjs`

**Interfaces:**

- Consumes: `apps/standalone/proto/src/lib.rs` (`PROTOCOL_VERSION`, `MIN_PROTOCOL_VERSION`), `apps/standalone/Cargo.lock`, манифесты оболочки и хоста, `apps/standalone/package.json`, `tauri.conf.json`, памятка `standalone-install.md`.
- Produces: `STANDALONE_PROTO_LIB`, `UPDATE_PRODUCT`, `updateDraftName(version)`, `readProtocolRange(path?)`, `buildUpdateDraft(...)`; `prepareStandaloneRelease({ …, protocol, minProtocol })` пишет `markiro-standalone-<версия>.update-draft.json` и включает его в `SHA256SUMS`; `verifyPreparedStandaloneRelease` знает четыре файла и возвращает `{ directory, name, evidence, draft, draftName }`. Задание CI не меняется: `main()` читает диапазон протокола сам.

- [ ] **Step 1: Написать падающие тесты**

Правка `tools/standalone-release/test/prepare.test.mjs`:

Фрагмент 1:

<!-- prettier-ignore -->
```js
import {
  prepareStandaloneRelease,
  readStandaloneVersion,
  standaloneInstallerName,
  verifyPreparedStandaloneRelease,
} from "../prepare.mjs";

const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const SOURCE = { sourceRepository: "thevladbog/markiro", sourceSha: "a".repeat(40) };
```

заменить на:

<!-- prettier-ignore -->
```js
import {
  prepareStandaloneRelease,
  readProtocolRange,
  readStandaloneVersion,
  standaloneInstallerName,
  updateDraftName,
  verifyPreparedStandaloneRelease,
} from "../prepare.mjs";

const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const DRAFT = "markiro-standalone-0.1.0.update-draft.json";
// The protocol range travels with the source in every call below.
const SOURCE = {
  sourceRepository: "thevladbog/markiro",
  sourceSha: "a".repeat(40),
  protocol: 3,
  minProtocol: 1,
};
const byLocale = (left, right) => left.localeCompare(right);
```

Фрагмент 2 (тест «prepares the installer, its evidence and checksums, and verifies them»):

<!-- prettier-ignore -->
```js
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "SHA256SUMS",
    INSTALLER,
    "release-evidence.json",
  ]);
```

заменить на:

<!-- prettier-ignore -->
```js
  assert.deepEqual(
    (await readdir(outputDir)).sort(),
    ["SHA256SUMS", INSTALLER, DRAFT, "release-evidence.json"].sort(),
  );
```

Фрагмент 3 (там же):

<!-- prettier-ignore -->
```js
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    sums
      .trim()
      .split("\n")
      .map((line) => line.slice(66)),
    [INSTALLER, "release-evidence.json"],
  );
});
```

заменить на:

<!-- prettier-ignore -->
```js
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    sums
      .trim()
      .split("\n")
      .map((line) => line.slice(66)),
    [INSTALLER, DRAFT, "release-evidence.json"].sort(byLocale),
  );
  // The unsigned draft holds what the build knows, in the manifest's order
  // (spec §10.2, §10.3); the owner adds the rest and signs it elsewhere.
  const draft = JSON.parse(await readFile(join(outputDir, DRAFT), "utf8"));
  assert.deepEqual(draft, {
    v: 1,
    product: "markiro-standalone",
    version: VERSION,
    sourceSha: "a".repeat(40),
    installer: {
      name: INSTALLER,
      sha256: "07fb0332d384ea8d15c76c2c6a4e176e93345d9f403b1cd17e8b0dd2e4d1ac62",
      sizeBytes: 47,
    },
    protocol: 3,
    minProtocol: 1,
  });
  assert.deepEqual(Object.keys(draft), [
    "v",
    "product",
    "version",
    "sourceSha",
    "installer",
    "protocol",
    "minProtocol",
  ]);
  assert.deepEqual(prepared.draft, draft);
  assert.equal(prepared.draftName, DRAFT);
  assert.equal(updateDraftName(VERSION), DRAFT);
  assert.throws(() => updateDraftName("0.1"), /not a version/);
});
```

Фрагмент 4 (тест детерминизма):

<!-- prettier-ignore -->
```js
  for (const name of ["SHA256SUMS", INSTALLER, "release-evidence.json"]) {
```

заменить на:

<!-- prettier-ignore -->
```js
  for (const name of ["SHA256SUMS", INSTALLER, DRAFT, "release-evidence.json"]) {
```

и в том же тесте после проверки `evidence` добавить:

<!-- prettier-ignore -->
```js
  const draft = await readFile(join(first, DRAFT), "utf8");
  assert.doesNotMatch(draft, /\d{4}-\d\d-\d\d|\/tmp|\/var|[A-Z]:\\|releasedAt|notes/);
```

Фрагмент 5 (таблица `cases` теста «SHA256SUMS must list exactly…»):

<!-- prettier-ignore -->
```js
    "a missing line": [(lines) => lines.slice(1), /names unexpected assets/],
```

заменить на:

<!-- prettier-ignore -->
```js
    "a changed draft hash": [
      (lines) =>
        lines.map((line) =>
          line.endsWith("update-draft.json") ? `${"0".repeat(64)}  ${DRAFT}` : line,
        ),
      /checksum mismatch: markiro-standalone-0\.1\.0\.update-draft\.json/,
    ],
    "a missing line": [(lines) => lines.slice(1), /names unexpected assets/],
```

В конец файла добавить:

<!-- prettier-ignore -->
```js
/** Rewrites the draft and keeps SHA256SUMS consistent with it. */
async function rewriteDraft(directory, change) {
  const path = join(directory, DRAFT);
  const draft = JSON.parse(await readFile(path, "utf8"));
  change(draft);
  const bytes = `${JSON.stringify(draft, null, 2)}\n`;
  await writeFile(path, bytes);
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => (line.endsWith(DRAFT) ? `${sha(bytes)}  ${DRAFT}` : line));
  await writeFile(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

test("reads the protocol range of the build from the wire crate, the one hello.json names", async () => {
  const hello = JSON.parse(await readFile("apps/standalone/proto/fixtures/hello.json", "utf8"));
  assert.deepEqual(await readProtocolRange(), {
    protocol: hello.protocol,
    minProtocol: hello.minProtocol,
  });
  const dir = await mkdtemp(join(tmpdir(), "standalone-proto-"));
  const lib = join(dir, "lib.rs");
  await writeFile(lib, "pub const PROTOCOL_VERSION: u32 = 3;\n");
  await assert.rejects(readProtocolRange(lib), /has no MIN_PROTOCOL_VERSION/);
  await writeFile(lib, "pub const PROTOCOL_VERSION: u32 = 2;\npub const MIN_PROTOCOL_VERSION: u32 = 3;\n");
  await assert.rejects(readProtocolRange(lib), /protocol range is invalid/);
});

test("a protocol range that is not one is refused before anything is written", async () => {
  for (const range of [
    { protocol: 0, minProtocol: 0 },
    { protocol: 1, minProtocol: 2 },
    { protocol: 3.5, minProtocol: 1 },
    { protocol: 3, minProtocol: undefined },
  ]) {
    const { bundleDir, outputDir } = await bundle("x-setup.exe");
    await assert.rejects(
      prepareStandaloneRelease({
        version: VERSION,
        ...SOURCE,
        ...range,
        bundleDir,
        outputDir,
        authenticode: "NotSigned",
      }),
      /protocol range is invalid/,
      JSON.stringify(range),
    );
    await assert.rejects(stat(outputDir), { code: "ENOENT" });
  }
});

test("a draft that does not describe the installer is refused even when the sums agree", async () => {
  for (const [what, change] of Object.entries({
    hash: (draft) => (draft.installer.sha256 = "0".repeat(64)),
    size: (draft) => (draft.installer.sizeBytes += 1),
    version: (draft) => (draft.version = "0.2.0"),
    commit: (draft) => (draft.sourceSha = "b".repeat(40)),
    "a protocol as text": (draft) => (draft.protocol = "3"),
    "a range upside down": (draft) => (draft.minProtocol = 4),
    "an extra key": (draft) => (draft.channel = "stable"),
    "another product": (draft) => (draft.product = "station"),
  })) {
    const directory = await prepared();
    await rewriteDraft(directory, change);
    await assert.rejects(
      verifyPreparedStandaloneRelease({ directory, version: VERSION }),
      /update draft is invalid/,
      what,
    );
  }
});
```

Создать `tools/standalone-release/test/offline.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// «Исходящих соединений в интернет нет» (spec §1.1, §10.10): the update comes
// as a file and is checked locally, so nothing the standalone product links
// may reach out. These contracts fail on a new network crate, an updater or
// an HTTP plugin until a person has checked it reaches nothing but the
// site's own host and named it here.

const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

/** Every package name in the standalone workspace's Cargo.lock, once each, sorted. */
function lockedCrates(lock) {
  return [...new Set([...lock.matchAll(/^name = "([^"]+)"$/gmu)].map((match) => match[1]))].sort();
}

/** Crates that speak a network protocol, resolve names or wrap sockets and TLS. */
const NETWORK =
  /^(?:reqwest|ureq|curl.*|isahc|surf|attohttpc|hyper.*|h2|h3.*|quinn.*|tungstenite|tokio-tungstenite|async-tungstenite|.*websocket.*|native-tls|openssl.*|hickory.*|trust-dns.*|axum.*|tower-http|tokio-rustls|rustls.*|webpki.*|socket2|mio|if-addrs|url|cookie.*|ipnet|tauri-plugin-.*)$/u;

// What the workspace links today: the host's own HTTPS server (axum, hyper,
// tokio-rustls), the shell's client pinned to that host (reqwest with
// rustls; quinn and the platform verifier come with reqwest and are never
// used: the client speaks HTTP/1.1 and HTTP/2 over a pinned certificate),
// the host's listing of its own addresses (if-addrs) and the single-instance
// plugin (a local pipe, no network).
const KNOWN = [
  "axum",
  "axum-core",
  "cookie",
  "hyper",
  "hyper-rustls",
  "hyper-util",
  "if-addrs",
  "ipnet",
  "mio",
  "openssl-probe",
  "quinn",
  "quinn-proto",
  "quinn-udp",
  "reqwest",
  "rustls",
  "rustls-native-certs",
  "rustls-pki-types",
  "rustls-platform-verifier",
  "rustls-platform-verifier-android",
  "rustls-webpki",
  "socket2",
  "tauri-plugin-single-instance",
  "tokio-rustls",
  "tower-http",
  "url",
  "webpki-root-certs",
];

test("the standalone workspace links no network crate beyond the ones it has", async () => {
  const crates = lockedCrates(await text("apps/standalone/Cargo.lock"));
  assert.deepEqual(
    crates.filter((name) => NETWORK.test(name)),
    KNOWN,
  );
});

test("no updater and no HTTP plugin in the shell, the host or the webview", async () => {
  for (const path of ["apps/standalone/src-tauri/Cargo.toml", "apps/standalone/host/Cargo.toml"]) {
    assert.doesNotMatch(await text(path), /tauri-plugin-(?:updater|http|upload|websocket)/u, path);
  }
  const webview = JSON.parse(await text("apps/standalone/package.json"));
  const dependencies = Object.keys({ ...webview.dependencies, ...webview.devDependencies });
  assert.deepEqual(
    dependencies.filter((name) => /^@tauri-apps\/plugin-/u.test(name)),
    [],
  );
  for (const path of [
    "apps/standalone/src-tauri/tauri.conf.json",
    "apps/standalone/src-tauri/tauri.installer.conf.json",
  ]) {
    const config = JSON.parse(await text(path));
    assert.equal(config.plugins?.updater, undefined, path);
    assert.equal(config.bundle?.createUpdaterArtifacts, undefined, path);
  }
});

test("the guide for IT keeps its promise", async () => {
  assert.match(await text("docs/runbooks/standalone-install.md"), /Исходящих соединений в интернет нет/u);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node --test tools/standalone-release/test/prepare.test.mjs tools/standalone-release/test/offline.test.mjs
```

Ожидается: `prepare.test.mjs` — FAIL (импорт `readProtocolRange` и `updateDraftName` не находится, файл не загружается); `offline.test.mjs` — PASS (контракт закрепляет нынешнее состояние; если список крейтов основы отличается от `KNOWN`, взять фактический список **основы до правок этого плана** и записать разницу в «Отклонения»).

- [ ] **Step 3: Реализация**

Заменить `tools/standalone-release/prepare.mjs` целиком:

<!-- prettier-ignore -->
```js
// The installer of «Markiro Автоном» as a self-verifying artifact (plan УСТ):
// the NSIS installer under a stable name, `release-evidence.json` (version,
// source commit, roles, hash and size, Authenticode status), the unsigned
// draft of its update manifest (plan ОБН-2, spec §10.3) and `SHA256SUMS`.
// The `standalone-windows-build` job runs it after the installer's smoke test
// and uploads the directory; nothing is published anywhere else. The draft
// holds what the build knows — the version, the commit, the installer and the
// protocol range of `apps/standalone/proto/src/lib.rs` — and the owner adds
// the channel, the date, `minUpgradeFrom` and the notes and signs it on their
// own machine (`sign-update.mjs`). No key reaches CI.
//
//   node tools/standalone-release/prepare.mjs --bundle-dir <nsis dir> --output-dir <dir> \
//     --source-repository <owner/repo> --source-sha <40 hex> --authenticode <status>

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STANDALONE_TAURI_CONFIG = "apps/standalone/src-tauri/tauri.conf.json";
/** The wire crate the host and the app share: its protocol range goes into the draft. */
export const STANDALONE_PROTO_LIB = "apps/standalone/proto/src/lib.rs";
export const EVIDENCE_FILE = "release-evidence.json";
export const CHECKSUM_FILE = "SHA256SUMS";
/** The product an update manifest names (`markiro_proto::update::PRODUCT`). */
export const UPDATE_PRODUCT = "markiro-standalone";
/** The installer's roles (`src-tauri/windows/installer-hooks.nsh`). */
export const ROLES = Object.freeze(["host", "station", "office"]);
/** `Get-AuthenticodeSignature`'s status for a signed and for an unsigned file. */
export const AUTHENTICODE_STATUSES = Object.freeze(["Valid", "NotSigned"]);

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function standaloneInstallerName(version) {
  if (!VERSION.test(version ?? "")) throw new Error(`${String(version)} is not a version`);
  return `markiro-standalone-${version}-windows-x86_64-setup.exe`;
}

/** The draft beside the installer: `markiro-standalone-<version>.update-draft.json`. */
export function updateDraftName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}.update-draft.json`;
}

/** The single source of the version: the app's Tauri config. */
export async function readStandaloneVersion(configPath = STANDALONE_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!VERSION.test(config?.version ?? "")) {
    throw new Error(`${configPath} has no usable version`);
  }
  return config.version;
}

function validateProtocolRange(range) {
  const { protocol, minProtocol } = range ?? {};
  if (
    !Number.isSafeInteger(protocol) ||
    !Number.isSafeInteger(minProtocol) ||
    minProtocol < 1 ||
    minProtocol > protocol
  ) {
    throw new Error("the protocol range is invalid: 1 <= minProtocol <= protocol");
  }
}

/** `PROTOCOL_VERSION` and `MIN_PROTOCOL_VERSION` of this build, read from the wire crate's source. */
export async function readProtocolRange(path = STANDALONE_PROTO_LIB) {
  const source = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  const constant = (name) => {
    const match = new RegExp(`^pub const ${name}: u32 = ([0-9]+);$`, "mu").exec(source);
    if (match === null) throw new Error(`${path} has no ${name}`);
    return Number(match[1]);
  };
  const range = {
    protocol: constant("PROTOCOL_VERSION"),
    minProtocol: constant("MIN_PROTOCOL_VERSION"),
  };
  validateProtocolRange(range);
  return range;
}

/**
 * The unsigned manifest draft (spec §10.2, §10.3): exactly what the build
 * knows, in the order the signed manifest keeps it.
 */
export function buildUpdateDraft({ version, sourceSha, name, sha256, size, protocol, minProtocol }) {
  return {
    v: 1,
    product: UPDATE_PRODUCT,
    version,
    sourceSha,
    installer: { name, sha256, sizeBytes: size },
    protocol,
    minProtocol,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSource(repository, sha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("source repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("source SHA must be a full lowercase Git commit SHA");
  }
}

function readDraft(bytes) {
  try {
    const draft = JSON.parse(bytes.toString("utf8"));
    validateProtocolRange(draft);
    return draft;
  } catch {
    throw new Error("prepared standalone update draft is invalid");
  }
}

export async function prepareStandaloneRelease({
  version,
  sourceRepository,
  sourceSha,
  bundleDir,
  outputDir,
  authenticode,
  protocol,
  minProtocol,
}) {
  validateSource(sourceRepository, sourceSha);
  const name = standaloneInstallerName(version);
  validateProtocolRange({ protocol, minProtocol });
  if (!AUTHENTICODE_STATUSES.includes(authenticode)) {
    throw new Error(`Authenticode status ${String(authenticode)} is neither signed nor unsigned`);
  }
  const installers = (await readdir(bundleDir)).filter((name) => name.endsWith("-setup.exe"));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one NSIS installer in ${bundleDir}`);
  }
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length !== 0) {
    throw new Error(`prepared release directory is not empty: ${outputDir}`);
  }
  const bytes = await readFile(join(bundleDir, installers[0]));
  await writeFile(join(outputDir, name), bytes);
  const hash = sha256(bytes);
  const evidence = {
    schemaVersion: 1,
    product: "standalone",
    version,
    source: { repository: sourceRepository, sha: sourceSha },
    roles: [...ROLES],
    authenticode,
    assets: { [name]: { sha256: hash, size: bytes.length } },
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, EVIDENCE_FILE), evidenceBytes);
  const draftName = updateDraftName(version);
  const draft = buildUpdateDraft({
    version,
    sourceSha,
    name,
    sha256: hash,
    size: bytes.length,
    protocol,
    minProtocol,
  });
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, draftName), draftBytes);
  const sums = [
    [EVIDENCE_FILE, sha256(evidenceBytes)],
    [name, hash],
    [draftName, sha256(draftBytes)],
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  await writeFile(join(outputDir, CHECKSUM_FILE), sums, "utf8");
  return verifyPreparedStandaloneRelease({ directory: outputDir, version });
}

export async function verifyPreparedStandaloneRelease({ directory, version }) {
  const name = standaloneInstallerName(version);
  const draftName = updateDraftName(version);
  const expected = [CHECKSUM_FILE, EVIDENCE_FILE, name, draftName].sort();
  const entries = (await readdir(directory)).sort();
  if (entries.join("\n") !== expected.join("\n")) {
    throw new Error("prepared standalone release has an unexpected asset set");
  }
  const bytes = Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(join(directory, entry))]),
    ),
  );
  const evidence = JSON.parse(bytes[EVIDENCE_FILE].toString("utf8"));
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.product !== "standalone" ||
    evidence?.version !== version ||
    JSON.stringify(evidence?.roles) !== JSON.stringify(ROLES) ||
    !AUTHENTICODE_STATUSES.includes(evidence?.authenticode)
  ) {
    throw new Error("prepared standalone release evidence is invalid");
  }
  validateSource(evidence.source?.repository, evidence.source?.sha);
  const asset = evidence.assets?.[name];
  if (
    Object.keys(evidence.assets ?? {}).length !== 1 ||
    asset?.sha256 !== sha256(bytes[name]) ||
    asset?.size !== bytes[name].length
  ) {
    throw new Error(`prepared standalone release checksum mismatch: ${name}`);
  }
  const lines = bytes[CHECKSUM_FILE].toString("utf8").trim().split("\n");
  const sums = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("prepared standalone SHA256SUMS is invalid");
    sums.set(match[2], match[1]);
  }
  if ([...sums.keys()].sort().join("\n") !== [EVIDENCE_FILE, name, draftName].sort().join("\n")) {
    throw new Error("prepared standalone SHA256SUMS names unexpected assets");
  }
  for (const [file, hash] of sums) {
    if (sha256(bytes[file]) !== hash) {
      throw new Error(`prepared standalone release checksum mismatch: ${file}`);
    }
  }
  const draft = readDraft(bytes[draftName]);
  const described = buildUpdateDraft({
    version,
    sourceSha: evidence.source.sha,
    name,
    sha256: asset.sha256,
    size: asset.size,
    protocol: draft.protocol,
    minProtocol: draft.minProtocol,
  });
  if (JSON.stringify(draft) !== JSON.stringify(described)) {
    throw new Error("prepared standalone update draft is invalid");
  }
  return { directory, name, evidence, draft, draftName };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "bundle-dir": { type: "string" },
      "output-dir": { type: "string" },
      "source-repository": { type: "string" },
      "source-sha": { type: "string" },
      authenticode: { type: "string" },
    },
    strict: true,
  });
  const prepared = await prepareStandaloneRelease({
    version: await readStandaloneVersion(),
    sourceRepository: values["source-repository"],
    sourceSha: values["source-sha"],
    bundleDir: values["bundle-dir"],
    outputDir: values["output-dir"],
    authenticode: values.authenticode,
    ...(await readProtocolRange()),
  });
  process.stdout.write(
    `${prepared.name} ${prepared.evidence.assets[prepared.name].sha256} (${prepared.evidence.authenticode})\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

Порядок проверок в `verifyPreparedStandaloneRelease`: сначала суммы (тест «a changed draft hash» ждёт `checksum mismatch: …update-draft.json`), затем содержимое черновика (тесты `rewriteDraft` держат суммы согласованными и ждут `update draft is invalid`).

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
node --test tools/standalone-release/test/prepare.test.mjs tools/standalone-release/test/offline.test.mjs
pnpm test:standalone-release:contract
```

Ожидается: PASS; `workflow.test.mjs` не менялся и проходит (шаг `prepare.mjs` в CI тот же). Если порядок строк `SHA256SUMS` по `localeCompare` на машине исполнителя другой — тест сравнивает с тем же компаратором, расхождения быть не должно.

- [ ] **Step 5: Гейты и коммит**

```bash
git add tools/standalone-release/prepare.mjs tools/standalone-release/test/prepare.test.mjs tools/standalone-release/test/offline.test.mjs
git commit -F /tmp/claude/obn2-t3-msg.txt
```

Сообщение:

```text
feat(standalone-release): the unsigned update manifest draft and the offline contract (plan ОБН-2)

prepare.mjs writes markiro-standalone-<version>.update-draft.json with the
installer and the protocol range of the build; the release checks it with
the rest. A contract pins the network crates of the standalone lock and
refuses an updater or an HTTP plugin.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 4: `sign-update.mjs` — подпись манифеста на машине владельца; тестовые манифесты для оболочки

**Files:**

- Create: `tools/standalone-release/sign-update.mjs`, `tools/standalone-release/generate-update-fixtures.mjs`, `tools/standalone-release/test/sign-update.test.mjs`, `tools/standalone-release/test/update-fixtures.test.mjs`, `apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.2.0.update.jws`, `apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.3.0.update.jws`, `apps/standalone/src-tauri/tests/fixtures/update/tampered/markiro-standalone-0.2.0.update.jws` (три последних пишет генератор)
- Test: `tools/standalone-release/test/sign-update.test.mjs`, `tools/standalone-release/test/update-fixtures.test.mjs`

**Interfaces:**

- Consumes: `prepare.mjs` (`EVIDENCE_FILE`, `UPDATE_PRODUCT`, `standaloneInstallerName`, `verifyPreparedStandaloneRelease` с `draft`, задача 3); фикстуры ЛЦ-1 `packages/domain/fixtures/standalone-license/{test-private-keys.json,test-keyset.json,update-manifest.jws}`.
- Produces: `UPDATE_TYP`, `CHANNELS`, `MAX_NOTES`, `MAX_NOTE_CHARS`, `manifestFileName`, `updateFolderName`, `compareVersions`, `parseNotes`, `checkManifest`, `buildManifest`, `signCompact`, `verifyCompact`, `assertOutsideRepository`, `readPassphrase`, `signUpdate`; генератор `FIXTURE_RELEASES`, `testInstallerBytes`, `fixtureManifest`, `findJwk`, `SHELL_FIXTURES`, `TEST_KEYS`, `TEST_UPDATE_KID`; закоммиченные `*.update.jws` для тестов оболочки (задачи 5–7).

- [ ] **Step 1: Написать падающие тесты**

Создать `tools/standalone-release/test/sign-update.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findJwk } from "../generate-update-fixtures.mjs";
import { prepareStandaloneRelease } from "../prepare.mjs";
import {
  MAX_NOTE_CHARS,
  buildManifest,
  checkManifest,
  compareVersions,
  manifestFileName,
  parseNotes,
  signCompact,
  signUpdate,
  updateFolderName,
  verifyCompact,
} from "../sign-update.mjs";

const SIGN = join(import.meta.dirname, "..", "sign-update.mjs");
const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const PASSPHRASE = "a passphrase only this test knows";
const OPTIONS = {
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  minUpgradeFrom: "0.1.0",
  notes: ["Лицензия площадки и страница «Информация»"],
};
const DRAFT = {
  v: 1,
  product: "markiro-standalone",
  version: "0.3.0",
  sourceSha: "b".repeat(40),
  installer: {
    name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
    sha256: "c".repeat(64),
    sizeBytes: 61234567,
  },
  protocol: 4,
  minProtocol: 2,
};

/** A release as prepare.mjs writes it, in a temporary directory outside the repository. */
async function release() {
  const root = await mkdtemp(join(tmpdir(), "standalone-sign-"));
  const bundleDir = join(root, "nsis");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "Markiro Standalone_0.1.0_x64-setup.exe"), "bytes of the installer");
  const releaseDir = join(root, "prepared");
  await prepareStandaloneRelease({
    version: VERSION,
    sourceRepository: "thevladbog/markiro",
    sourceSha: "a".repeat(40),
    bundleDir,
    outputDir: releaseDir,
    authenticode: "NotSigned",
    protocol: 3,
    minProtocol: 1,
  });
  return { root, releaseDir };
}

/** A fresh release key and its PKCS#8 PEM under the test's passphrase. */
function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: PASSPHRASE,
  });
  return { keyPem, privateKey, publicKey };
}

test("notes are 1-30 trimmed lines of at most 200 characters, without control characters", () => {
  assert.deepEqual(parseNotes("\uFEFF  Первая строка \r\n\r\nВторая\n"), ["Первая строка", "Вторая"]);
  assert.deepEqual(parseNotes("ё".repeat(MAX_NOTE_CHARS)), ["ё".repeat(MAX_NOTE_CHARS)]);
  for (const bad of [
    "",
    "\n \n",
    Array.from({ length: 31 }, (_, index) => `строка ${index}`).join("\n"),
    "я".repeat(MAX_NOTE_CHARS + 1),
    "табуляция\tвнутри",
  ]) {
    assert.throws(() => parseNotes(bad), /notes/u, JSON.stringify(bad.slice(0, 20)));
  }
});

test("versions compare as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.throws(() => compareVersions("0.2", "0.2.0"), /not a version/u);
});

test("the manifest is the draft with the owner's channel, date, minimum and notes, in the spec's order", () => {
  const manifest = buildManifest(DRAFT, { ...OPTIONS, minUpgradeFrom: "0.2.0" });
  assert.deepEqual(manifest, {
    v: 1,
    product: "markiro-standalone",
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "b".repeat(40),
    installer: DRAFT.installer,
    protocol: 4,
    minProtocol: 2,
    minUpgradeFrom: "0.2.0",
    notes: OPTIONS.notes,
  });
  assert.deepEqual(Object.keys(manifest), [
    "v",
    "product",
    "version",
    "channel",
    "releasedAt",
    "sourceSha",
    "installer",
    "protocol",
    "minProtocol",
    "minUpgradeFrom",
    "notes",
  ]);
  assert.equal(buildManifest(DRAFT, { ...OPTIONS, channel: "beta" }).channel, "beta");
  for (const [what, options, expected] of [
    ["a channel", { ...OPTIONS, channel: "nightly" }, /stable or beta/u],
    ["a date", { ...OPTIONS, releasedAt: "2026-11-02 10:00" }, /release time/u],
    ["a date with fractions", { ...OPTIONS, releasedAt: "2026-11-02T10:00:00.000Z" }, /release time/u],
    ["a newer minimum", { ...OPTIONS, minUpgradeFrom: "0.4.0" }, /not be newer/u],
    ["no version", { ...OPTIONS, minUpgradeFrom: "0.2" }, /not a version/u],
  ]) {
    assert.throws(() => buildManifest(DRAFT, options), expected, what);
  }
  for (const [what, draft] of [
    ["an extra key", { ...DRAFT, channel: "stable" }],
    ["another installer name", { ...DRAFT, installer: { ...DRAFT.installer, name: "setup.exe" } }],
    ["a range upside down", { ...DRAFT, minProtocol: 5 }],
    ["another product", { ...DRAFT, product: "station" }],
    ["a short hash", { ...DRAFT, installer: { ...DRAFT.installer, sha256: "c".repeat(63) } }],
  ]) {
    assert.throws(() => buildManifest(draft, OPTIONS), /draft|shape/u, what);
  }
});

test("a compact JWS ES256 of the update type: canonical base64url and a 64-byte signature", () => {
  const { privateKey, publicKey } = releaseKey();
  const manifest = buildManifest(DRAFT, OPTIONS);
  const compact = signCompact(privateKey, "upd-2026-1", manifest);
  const [header, payload, signature] = compact.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    typ: "markiro-standalone-update+jws",
    alg: "ES256",
    kid: "upd-2026-1",
  });
  assert.equal(Buffer.from(payload, "base64url").toString("utf8"), JSON.stringify(manifest));
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.doesNotMatch(compact, /[=+/\s]/u);
  assert.deepEqual(verifyCompact(publicKey, compact).payload, manifest);
  // A changed payload, another key, a license's type: refused.
  const changed = Buffer.from(JSON.stringify({ ...manifest, version: "0.3.1" })).toString("base64url");
  assert.throws(() => verifyCompact(publicKey, `${header}.${changed}.${signature}`), /does not verify/u);
  assert.throws(() => verifyCompact(releaseKey().publicKey, compact), /does not verify/u);
  const license = Buffer.from(
    JSON.stringify({ typ: "markiro-standalone-license+jws", alg: "ES256", kid: "upd-2026-1" }),
  ).toString("base64url");
  assert.throws(() => verifyCompact(publicKey, `${license}.${payload}.${signature}`), /header/u);
  for (const [what, key] of [
    ["P-384", generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey],
    ["Ed25519", generateKeyPairSync("ed25519").privateKey],
  ]) {
    assert.throws(() => signCompact(key, "upd-2026-1", manifest), /P-256/u, what);
  }
  assert.throws(() => signCompact(privateKey, "a kid with spaces", manifest), /key id/u);
});

test("signs a prepared release into the folder the customer gets, after checking every byte again", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, publicKey } = releaseKey();
  const outputDir = join(root, "signed");
  const result = await signUpdate({
    releaseDir,
    ...OPTIONS,
    keyPem,
    passphrase: PASSPHRASE,
    kid: "upd-2026-1",
    outputDir,
  });
  assert.equal(result.folder, join(outputDir, updateFolderName(VERSION)));
  assert.deepEqual(
    (await readdir(result.folder)).sort(),
    [INSTALLER, manifestFileName(VERSION)].sort(),
  );
  const compact = (await readFile(join(result.folder, manifestFileName(VERSION)), "utf8")).trim();
  assert.equal(compact, result.compact);
  const { payload } = verifyCompact(publicKey, compact);
  const installer = await readFile(join(result.folder, INSTALLER));
  assert.deepEqual(payload.installer, {
    name: INSTALLER,
    sha256: createHash("sha256").update(installer).digest("hex"),
    sizeBytes: installer.length,
  });
  assert.deepEqual(checkManifest(payload), payload);
  assert.deepEqual([payload.protocol, payload.minProtocol], [3, 1]);
  for (const name of await readdir(result.folder)) {
    assert.doesNotMatch(await readFile(join(result.folder, name), "utf8"), /PRIVATE KEY|a passphrase only/u);
  }
  // The folder is never written twice.
  await assert.rejects(
    signUpdate({ releaseDir, ...OPTIONS, keyPem, passphrase: PASSPHRASE, kid: "upd-2026-1", outputDir }),
    /EEXIST/u,
  );
});

test("a wrong passphrase, a key without one and an installer changed after prepare.mjs are refused, and nothing is written", async () => {
  const { root, releaseDir } = await release();
  const { keyPem, privateKey } = releaseKey();
  const base = { releaseDir, ...OPTIONS, keyPem, passphrase: PASSPHRASE, kid: "upd-2026-1" };
  await assert.rejects(
    signUpdate({ ...base, passphrase: "wrong", outputDir: join(root, "a") }),
    /does not open/u,
  );
  const plain = privateKey.export({ type: "pkcs8", format: "pem" });
  await assert.rejects(
    signUpdate({ ...base, keyPem: plain, outputDir: join(root, "b") }),
    /encrypted PKCS#8/u,
  );
  // Authenticode after prepare.mjs changes the bytes: sign first, then prepare, then this tool.
  await writeFile(join(releaseDir, INSTALLER), "bytes of the installer, signed afterwards");
  await assert.rejects(signUpdate({ ...base, outputDir: join(root, "c") }), /Authenticode first/u);
  for (const dir of ["a", "b", "c"]) {
    await assert.rejects(stat(join(root, dir)), { code: "ENOENT" });
  }
});

test("the owner's tool signs as plan ЛЦ-1's fixtures do: its test key verifies, and its manifest has this shape", async () => {
  const keys = "packages/domain/fixtures/standalone-license";
  const privateJwk = findJwk(JSON.parse(await readFile(join(keys, "test-private-keys.json"), "utf8")), "test-upd-1");
  const publicJwk = findJwk(JSON.parse(await readFile(join(keys, "test-keyset.json"), "utf8")).update, "test-upd-1");
  const privateKey = createPrivateKey({
    key: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    format: "jwk",
  });
  const publicKey = createPublicKey({
    key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    format: "jwk",
  });
  const manifest = buildManifest(DRAFT, OPTIONS);
  assert.deepEqual(verifyCompact(publicKey, signCompact(privateKey, "test-upd-1", manifest)).payload, manifest);
  const fixture = verifyCompact(publicKey, (await readFile(join(keys, "update-manifest.jws"), "utf8")).trim());
  assert.deepEqual(fixture.header, { typ: "markiro-standalone-update+jws", alg: "ES256", kid: "test-upd-1" });
  assert.deepEqual(checkManifest(fixture.payload), fixture.payload);
});

/** Inputs of the command line: a release, an encrypted key and notes, all outside the repository. */
async function cliInputs() {
  const { root, releaseDir } = await release();
  const key = join(root, "release-key.pem");
  await writeFile(key, releaseKey().keyPem);
  const notes = join(root, "notes.txt");
  await writeFile(notes, "Строка заметок\n");
  return { root, releaseDir, key, notes };
}

function cliArgs({ releaseDir, key, notes, out }) {
  return [
    SIGN,
    "--release-dir",
    releaseDir,
    "--notes",
    notes,
    "--min-upgrade-from",
    "0.1.0",
    "--channel",
    "stable",
    "--key",
    key,
    "--kid",
    "upd-2026-1",
    "--output-dir",
    out,
  ];
}

test("the command line reads the passphrase from a terminal only, and keeps the key and the result out of the repository", async () => {
  const inputs = await cliInputs();
  const out = join(inputs.root, "signed");
  const piped = spawnSync(process.execPath, cliArgs({ ...inputs, out }), {
    encoding: "utf8",
    input: `${PASSPHRASE}\n`,
  });
  assert.notEqual(piped.status, 0);
  assert.match(piped.stderr, /terminal only/u);
  assert.equal(piped.stdout, "");
  await assert.rejects(stat(out), { code: "ENOENT" });
  const inside = spawnSync(process.execPath, cliArgs({ ...inputs, key: SIGN, out }), { encoding: "utf8" });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /release key must live outside the repository/u);
  const here = join(import.meta.dirname, "signed-here");
  const intoRepository = spawnSync(process.execPath, cliArgs({ ...inputs, out: here }), { encoding: "utf8" });
  assert.notEqual(intoRepository.status, 0);
  assert.match(intoRepository.stderr, /signed update must live outside the repository/u);
  await assert.rejects(stat(here), { code: "ENOENT" });
  const unknown = spawnSync(process.execPath, [SIGN, "--passphrase", "x"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /passphrase/u);
});

test("importing the module runs nothing, and CI never signs", async () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(`file://${SIGN}`)})`],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(workflow, /sign-update|generate-update-fixtures|update-key|STANDALONE_UPDATE/u);
});
```

Создать `tools/standalone-release/test/update-fixtures.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_RELEASES,
  SHELL_FIXTURES,
  TEST_KEYS,
  TEST_UPDATE_KID,
  findJwk,
  fixtureManifest,
} from "../generate-update-fixtures.mjs";
import { manifestFileName, verifyCompact } from "../sign-update.mjs";

// The signed manifests the shell's tests read (plan ОБН-2) stay what the
// generator signs: a stale or hand-edited fixture would test nothing.

const keyset = JSON.parse(await readFile(join(TEST_KEYS, "test-keyset.json"), "utf8"));
const jwk = findJwk(keyset.update, TEST_UPDATE_KID);
const publicKey = createPublicKey({
  key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  format: "jwk",
});
const compact = async (...path) => (await readFile(join(SHELL_FIXTURES, ...path), "utf8")).trim();

test("the shell's update fixtures are the releases the generator signs and one tampered manifest", async () => {
  assert.deepEqual(
    (await readdir(SHELL_FIXTURES)).sort(),
    [...FIXTURE_RELEASES.map((release) => manifestFileName(release.version)), "tampered"].sort(),
  );
  assert.deepEqual(await readdir(join(SHELL_FIXTURES, "tampered")), [manifestFileName("0.2.0")]);
});

test("each signed fixture verifies with the test release key and names its test installer", async () => {
  for (const release of FIXTURE_RELEASES) {
    const { header, payload } = verifyCompact(publicKey, await compact(manifestFileName(release.version)));
    assert.deepEqual(header, { typ: "markiro-standalone-update+jws", alg: "ES256", kid: TEST_UPDATE_KID });
    assert.deepEqual(payload, fixtureManifest(release));
  }
});

test("the tampered fixture does not verify", async () => {
  const text = await compact("tampered", manifestFileName("0.2.0"));
  assert.throws(() => verifyCompact(publicKey, text), /does not verify/u);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node --test tools/standalone-release/test/sign-update.test.mjs tools/standalone-release/test/update-fixtures.test.mjs
```

Ожидается: FAIL загрузки (`../sign-update.mjs`, `../generate-update-fixtures.mjs` нет).

- [ ] **Step 3: Реализация**

Создать `tools/standalone-release/sign-update.mjs`:

<!-- prettier-ignore -->
```js
// An update of «Markiro Автоном», signed on the owner's machine (plan ОБН-2,
// spec §5.1, §10.2, §10.3, §10.9):
//
//   node tools/standalone-release/sign-update.mjs --release-dir <prepared dir> \
//     --notes <notes.txt> --min-upgrade-from <X.Y.Z> --channel <stable|beta> \
//     --key <encrypted PKCS#8 PEM outside the repository> --kid <kid> \
//     --output-dir <dir outside the repository> [--released-at <YYYY-MM-DDTHH:MM:SSZ>]
//
// `--release-dir` is what prepare.mjs wrote (the CI artifact): the installer,
// release-evidence.json, the manifest draft and SHA256SUMS. All of it is
// checked again from the bytes — the installer's SHA-256 and size against the
// evidence and the sums — before anything is signed. The key's passphrase is
// asked on the terminal only: never an argument, never the environment. The
// result is `<output>/markiro-standalone-<version>-update/` with the
// installer and `markiro-standalone-<version>.update.jws`, one line of compact
// JWS ES256 (`typ` markiro-standalone-update+jws): the folder the owner hands
// to the customer.
//
// Authenticode changes the installer's bytes, so with a code-signing
// certificate the order is: the build signed (sign-overlay.mjs), prepare.mjs
// on that installer, then this tool. An installer signed after prepare.mjs no
// longer matches its evidence and is refused. The release key never reaches
// CI or the SaaS panel.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  EVIDENCE_FILE,
  UPDATE_PRODUCT,
  standaloneInstallerName,
  verifyPreparedStandaloneRelease,
} from "./prepare.mjs";

export const UPDATE_TYP = "markiro-standalone-update+jws";
export const CHANNELS = Object.freeze(["stable", "beta"]);
export const MAX_NOTES = 30;
export const MAX_NOTE_CHARS = 200;
export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

const MANIFEST_KEYS = Object.freeze([
  "v",
  "product",
  "version",
  "channel",
  "releasedAt",
  "sourceSha",
  "installer",
  "protocol",
  "minProtocol",
  "minUpgradeFrom",
  "notes",
]);
const DRAFT_KEYS = Object.freeze(["v", "product", "version", "sourceSha", "installer", "protocol", "minProtocol"]);
const INSTALLER_KEYS = Object.freeze(["name", "sha256", "sizeBytes"]);
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const KID = /^[A-Za-z0-9._-]{1,64}$/u;
/** A C0 control character or DEL: never in a note (no-control-regex keeps this out of a pattern). */
const hasControl = (text) =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

export function manifestFileName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}.update.jws`;
}

export function updateFolderName(version) {
  standaloneInstallerName(version);
  return `markiro-standalone-${version}-update`;
}

/** -1, 0 or 1 for two versions `X.Y.Z`, compared as numbers. */
export function compareVersions(left, right) {
  const parts = (text) => {
    const match = VERSION.exec(text ?? "");
    if (match === null) throw new Error(`${String(text)} is not a version`);
    return match.slice(1).map(Number);
  };
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** The notes file: 1-30 non-empty lines, each trimmed, at most 200 characters, no control character. */
export function parseNotes(text) {
  const lines = String(text)
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0 || lines.length > MAX_NOTES) {
    throw new Error(`the notes hold 1-${MAX_NOTES} lines`);
  }
  for (const line of lines) {
    if ([...line].length > MAX_NOTE_CHARS) {
      throw new Error(`a line of the notes is longer than ${MAX_NOTE_CHARS} characters`);
    }
    if (hasControl(line)) throw new Error("the notes hold a control character");
  }
  return lines;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** `manifest` when it has exactly the shape of spec §10.2; throws otherwise. */
export function checkManifest(manifest) {
  const m = manifest;
  const ok =
    exactKeys(m, MANIFEST_KEYS) &&
    m.v === 1 &&
    m.product === UPDATE_PRODUCT &&
    VERSION.test(m.version ?? "") &&
    CHANNELS.includes(m.channel) &&
    INSTANT.test(m.releasedAt ?? "") &&
    /^[0-9a-f]{40}$/u.test(m.sourceSha ?? "") &&
    exactKeys(m.installer, INSTALLER_KEYS) &&
    m.installer.name === standaloneInstallerName(m.version) &&
    /^[0-9a-f]{64}$/u.test(m.installer.sha256 ?? "") &&
    Number.isSafeInteger(m.installer.sizeBytes) &&
    m.installer.sizeBytes > 0 &&
    Number.isSafeInteger(m.protocol) &&
    Number.isSafeInteger(m.minProtocol) &&
    m.minProtocol >= 1 &&
    m.minProtocol <= m.protocol &&
    VERSION.test(m.minUpgradeFrom ?? "") &&
    compareVersions(m.minUpgradeFrom, m.version) <= 0 &&
    Array.isArray(m.notes) &&
    m.notes.length >= 1 &&
    m.notes.length <= MAX_NOTES &&
    m.notes.every(
      (note) =>
        typeof note === "string" &&
        note !== "" &&
        note.trim() === note &&
        [...note].length <= MAX_NOTE_CHARS &&
        !hasControl(note),
    );
  if (!ok) throw new Error("the manifest does not have the shape of a markiro-standalone update v1");
  return manifest;
}

/** The manifest of spec §10.2: prepare.mjs's draft and what the owner adds. */
export function buildManifest(draft, { channel, releasedAt, minUpgradeFrom, notes }) {
  if (!exactKeys(draft, DRAFT_KEYS) || !exactKeys(draft.installer, INSTALLER_KEYS)) {
    throw new Error("the manifest draft is not what prepare.mjs writes");
  }
  if (!CHANNELS.includes(channel)) throw new Error("the channel is stable or beta");
  if (!INSTANT.test(releasedAt ?? "")) {
    throw new Error("the release time is YYYY-MM-DDTHH:MM:SSZ (UTC, no fractions)");
  }
  if (compareVersions(minUpgradeFrom, draft.version) > 0) {
    throw new Error("minUpgradeFrom must not be newer than the version itself");
  }
  return checkManifest({
    v: draft.v,
    product: draft.product,
    version: draft.version,
    channel,
    releasedAt,
    sourceSha: draft.sourceSha,
    installer: {
      name: draft.installer.name,
      sha256: draft.installer.sha256,
      sizeBytes: draft.installer.sizeBytes,
    },
    protocol: draft.protocol,
    minProtocol: draft.minProtocol,
    minUpgradeFrom,
    notes: [...notes],
  });
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** A compact JWS ES256 of `payload`: the exact bytes `header.payload` are signed, no JSON canonicalization. */
export function signCompact(privateKey, kid, payload) {
  if (
    privateKey?.type !== "private" ||
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("the release key must be an ECDSA P-256 private key");
  }
  if (!KID.test(kid ?? "")) {
    throw new Error("the key id is 1-64 letters, digits, dots, dashes or underscores");
  }
  const input = `${base64url(JSON.stringify({ typ: UPDATE_TYP, alg: "ES256", kid }))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(input, "ascii"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64url(signature)}`;
}

/** The header and the payload of `compact` when `publicKey` verifies it as an update manifest; throws otherwise. */
export function verifyCompact(publicKey, compact) {
  const parts = String(compact).split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const decode = (segment) => {
    const bytes = Buffer.from(segment, "base64url");
    if (base64url(bytes) !== segment) throw new Error("not canonical base64url");
    return bytes;
  };
  const [header, payload, signature] = parts.map(decode);
  const parsed = JSON.parse(header.toString("utf8"));
  if (!exactKeys(parsed, ["typ", "alg", "kid"]) || parsed.typ !== UPDATE_TYP || parsed.alg !== "ES256") {
    throw new Error("not an update manifest's header");
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  if (
    signature.length !== 64 ||
    !verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
  ) {
    throw new Error("the signature does not verify");
  }
  return { header: parsed, payload: JSON.parse(payload.toString("utf8")) };
}

/** `path` resolved when it lies outside the repository; throws when it is inside. */
export async function assertOutsideRepository(path, what, root = REPOSITORY_ROOT) {
  const target = resolve(path);
  let real = target;
  try {
    real = await realpath(target);
  } catch {
    // Not there yet (an output folder): the path as given is what counts.
  }
  const inside = (base) => {
    const rel = relative(base, real);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (inside(root) || inside(await realpath(root))) {
    throw new Error(`${what} must live outside the repository`);
  }
  return real;
}

/** The passphrase typed on the terminal, not echoed. Anything but a terminal is refused. */
export async function readPassphrase(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("the passphrase is read from a terminal only");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise((resolvePassphrase, reject) => {
    let typed = "";
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (error === null) resolvePassphrase(typed);
      else reject(error);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(null);
        if (char === "\u0003" || char === "\u0004") return finish(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
      return undefined;
    };
    input.on("data", onData);
  });
}

/** Signs a prepared release (see the header); returns the folder, the compact JWS and the manifest. */
export async function signUpdate({
  releaseDir,
  notes,
  minUpgradeFrom,
  channel,
  releasedAt,
  keyPem,
  passphrase,
  kid,
  outputDir,
}) {
  let prepared;
  try {
    const evidence = JSON.parse(await readFile(join(releaseDir, EVIDENCE_FILE), "utf8"));
    prepared = await verifyPreparedStandaloneRelease({ directory: releaseDir, version: evidence?.version });
  } catch (error) {
    throw new Error(
      `${error.message}. The installer must be exactly what prepare.mjs hashed: sign it with Authenticode first, run prepare.mjs on it, then this tool`,
    );
  }
  const manifest = buildManifest(prepared.draft, { channel, releasedAt, minUpgradeFrom, notes });
  if (!String(keyPem).includes("-----BEGIN ENCRYPTED PRIVATE KEY-----")) {
    throw new Error("the release key must be an encrypted PKCS#8 PEM: a passphrase protects it");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: keyPem, format: "pem", passphrase });
  } catch {
    throw new Error("the release key does not open: a wrong passphrase, or not a PKCS#8 key");
  }
  const compact = signCompact(privateKey, kid, manifest);
  verifyCompact(createPublicKey(privateKey), compact);
  const folder = join(outputDir, updateFolderName(manifest.version));
  await mkdir(outputDir, { recursive: true });
  await mkdir(folder);
  await writeFile(join(folder, prepared.name), await readFile(join(releaseDir, prepared.name)), { flag: "wx" });
  // What the customer gets is read back: it must be what was signed.
  const copied = await readFile(join(folder, prepared.name));
  if (
    copied.length !== manifest.installer.sizeBytes ||
    createHash("sha256").update(copied).digest("hex") !== manifest.installer.sha256
  ) {
    throw new Error("the copied installer does not match the manifest");
  }
  await writeFile(join(folder, manifestFileName(manifest.version)), `${compact}\n`, { flag: "wx" });
  return { folder, compact, manifest };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "release-dir": { type: "string" },
      notes: { type: "string" },
      "min-upgrade-from": { type: "string" },
      channel: { type: "string" },
      "released-at": { type: "string" },
      key: { type: "string" },
      kid: { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
  });
  for (const option of ["release-dir", "notes", "min-upgrade-from", "channel", "key", "kid", "output-dir"]) {
    if (values[option] === undefined) throw new Error(`--${option} is required`);
  }
  const keyPath = await assertOutsideRepository(values.key, "the release key");
  await assertOutsideRepository(values["output-dir"], "the signed update");
  const notes = parseNotes(await readFile(values.notes, "utf8"));
  const passphrase = await readPassphrase("Парольная фраза ключа выпусков: ");
  const result = await signUpdate({
    releaseDir: values["release-dir"],
    notes,
    minUpgradeFrom: values["min-upgrade-from"],
    channel: values.channel,
    releasedAt: values["released-at"] ?? new Date().toISOString().replace(/\.[0-9]{3}Z$/u, "Z"),
    keyPem: await readFile(keyPath, "utf8"),
    passphrase,
    kid: values.kid,
    outputDir: values["output-dir"],
  });
  process.stdout.write(`${result.folder}\n${result.manifest.installer.name} ${result.manifest.installer.sha256}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

Создать `tools/standalone-release/generate-update-fixtures.mjs`:

<!-- prettier-ignore -->
```js
// The signed update manifests the shell's tests read (plan ОБН-2):
// apps/standalone/src-tauri/tests/fixtures/update. Signed with the TEST
// release key of packages/domain/fixtures/standalone-license (kid
// test-upd-1, plan ЛЦ-1) by the signCompact the owner's tool uses. The
// installers are not committed: a test writes `markiro test installer
// <version>\n` beside a manifest, and the manifest names that text's SHA-256
// and size. Never run in CI; ECDSA signatures are randomized, so the tests
// verify the files and never compare their bytes.
//
//   node tools/standalone-release/generate-update-fixtures.mjs

import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { UPDATE_PRODUCT, standaloneInstallerName } from "./prepare.mjs";
import { checkManifest, manifestFileName, signCompact } from "./sign-update.mjs";

export const SHELL_FIXTURES = "apps/standalone/src-tauri/tests/fixtures/update";
export const TEST_KEYS = "packages/domain/fixtures/standalone-license";
export const TEST_UPDATE_KID = "test-upd-1";

/** 0.2.0 follows the installed 0.1.0 on the same protocol; 0.3.0 needs 0.2.0 first and a newer host. */
export const FIXTURE_RELEASES = Object.freeze([
  {
    version: "0.2.0",
    channel: "stable",
    protocol: 3,
    minProtocol: 1,
    minUpgradeFrom: "0.1.0",
    notes: ["Тестовый выпуск 0.2.0"],
  },
  {
    version: "0.3.0",
    channel: "beta",
    protocol: 4,
    minProtocol: 2,
    minUpgradeFrom: "0.2.0",
    notes: ["Тестовый выпуск 0.3.0", "Протокол 4: хост площадки обновляется первым"],
  },
]);

/** The bytes of the test installer of `version` (the shell's tests write the same). */
export function testInstallerBytes(version) {
  return Buffer.from(`markiro test installer ${version}\n`, "utf8");
}

export function fixtureManifest({ version, channel, protocol, minProtocol, minUpgradeFrom, notes }) {
  const installer = testInstallerBytes(version);
  return checkManifest({
    v: 1,
    product: UPDATE_PRODUCT,
    version,
    channel,
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "a".repeat(40),
    installer: {
      name: standaloneInstallerName(version),
      sha256: createHash("sha256").update(installer).digest("hex"),
      sizeBytes: installer.length,
    },
    protocol,
    minProtocol,
    minUpgradeFrom,
    notes: [...notes],
  });
}

/** The JWK of `kid` anywhere in a key file of plan ЛЦ-1: an object `{ kid, jwk }` or a JWK with its own `kid`. */
export function findJwk(value, kid) {
  if (value === null || typeof value !== "object") return null;
  if (value.kid === kid) {
    if (value.jwk !== null && typeof value.jwk === "object") return value.jwk;
    if (value.kty === "EC") return value;
  }
  for (const inner of Object.values(value)) {
    const found = findJwk(inner, kid);
    if (found !== null) return found;
  }
  return null;
}

async function main() {
  const jwk = findJwk(
    JSON.parse(await readFile(join(TEST_KEYS, "test-private-keys.json"), "utf8")),
    TEST_UPDATE_KID,
  );
  if (jwk === null || typeof jwk.d !== "string") {
    throw new Error(`no private ${TEST_UPDATE_KID} in ${TEST_KEYS}/test-private-keys.json`);
  }
  const key = createPrivateKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    format: "jwk",
  });
  await mkdir(join(SHELL_FIXTURES, "tampered"), { recursive: true });
  for (const release of FIXTURE_RELEASES) {
    const compact = signCompact(key, TEST_UPDATE_KID, fixtureManifest(release));
    await writeFile(join(SHELL_FIXTURES, manifestFileName(release.version)), `${compact}\n`);
  }
  // A manifest changed after signing: 0.2.0's header and signature over other notes.
  const [first] = FIXTURE_RELEASES;
  const [header, , signature] = signCompact(key, TEST_UPDATE_KID, fixtureManifest(first)).split(".");
  const changed = Buffer.from(
    JSON.stringify(fixtureManifest({ ...first, notes: ["Подменённые заметки"] })),
  ).toString("base64url");
  await writeFile(
    join(SHELL_FIXTURES, "tampered", manifestFileName(first.version)),
    `${header}.${changed}.${signature}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

Сгенерировать фикстуры один раз:

```bash
node tools/standalone-release/generate-update-fixtures.mjs
ls apps/standalone/src-tauri/tests/fixtures/update apps/standalone/src-tauri/tests/fixtures/update/tampered
```

Ожидается: `markiro-standalone-0.2.0.update.jws`, `markiro-standalone-0.3.0.update.jws`, `tampered/markiro-standalone-0.2.0.update.jws`.

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
node --test tools/standalone-release/test/sign-update.test.mjs tools/standalone-release/test/update-fixtures.test.mjs
pnpm test:standalone-release:contract
```

Ожидается: PASS. Если схема ЛЦ-1 (`update-manifest.jws`) расходится с `checkManifest` (тест «the owner's tool signs as plan ЛЦ-1's fixtures do») — это расхождение формата между доменом и инструментом владельца: остановиться и сверить с §10.2 спецификации; правится сторона, отошедшая от §10.2, и записывается в «Отклонения».

- [ ] **Step 5: Гейты и коммит**

Prettier на два новых `.mjs` и два теста (фикстуры `.jws` prettier не трогает). `grep -rn "PRIVATE KEY" tools/standalone-release apps/standalone/src-tauri/tests/fixtures` — пусто (тесты создают ключи во временной папке).

```bash
git add tools/standalone-release/sign-update.mjs tools/standalone-release/generate-update-fixtures.mjs tools/standalone-release/test/sign-update.test.mjs tools/standalone-release/test/update-fixtures.test.mjs apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.2.0.update.jws apps/standalone/src-tauri/tests/fixtures/update/markiro-standalone-0.3.0.update.jws apps/standalone/src-tauri/tests/fixtures/update/tampered/markiro-standalone-0.2.0.update.jws
git commit -F /tmp/claude/obn2-t4-msg.txt
```

Сообщение:

```text
feat(standalone-release): sign-update.mjs — the owner signs an update manifest offline (plan ОБН-2)

ES256 compact JWS of type markiro-standalone-update+jws over prepare.mjs's
draft, after the installer is hashed again against its evidence; the
passphrase comes from the terminal only, the key and the result stay
outside the repository. Signed test manifests for the shell's tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 5: Оболочка — правила версий, поиск пакетов, установщик через неразделяемый дескриптор, версии хоста; шаг владельца `windows-sys`

**Files:**

- Create: `apps/standalone/src-tauri/src/update/mod.rs`, `apps/standalone/src-tauri/src/update/rules.rs`, `apps/standalone/src-tauri/src/update/package.rs`
- Modify: `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src-tauri/src/host_probe.rs`, `apps/standalone/src-tauri/Cargo.toml` (dev-фича — исполнитель; фичи `windows-sys` — владелец)
- Test: модули `update::rules`, `update::package`, `host_probe` (`cargo test … --lib`)

**Interfaces:**

- Consumes: `markiro_proto::trust::{verify_update_manifest, Keyset, TrustError, UpdateManifestV1, update_keyset}` (ЛЦ-1; тестовые ключи — фича `test-keys`), `markiro_proto::update::{AppVersion, installer_name, hash_exact, HashError, PRODUCT}` (задача 1), фикстуры задачи 4.
- Produces:
  - `update::rules::{Comparison, Refusal, Confirmation, HostCheck, Offered, Decision, decide}`;
  - `update::package::{MANIFEST_SUFFIX, MAX_MANIFEST_BYTES, MAX_FOUND, DRIVE_FOLDER, DRIVE_REMOVABLE, RemovableDrives, SystemDrives, FixedDrives, removable_roots, PlaceKind, Place, places, FoundPackage, PackageError, Manifest, Checked, read_manifest, scan, verify, open_installer, ensure_folder}`;
  - `host_probe::{HostVersions, read_versions, host_versions}` (`observe_hello` ведёт себя как прежде);
  - `office_files::{UPDATES_ROOT, show_folder}`.

- [ ] **Step 1: Шаг владельца и dev-фича**

**Исполнитель** — правка `apps/standalone/src-tauri/Cargo.toml`:

Фрагмент:

```toml
[dev-dependencies]
markiro-host = { path = "../host" }
```

заменить на:

```toml
[dev-dependencies]
markiro-host = { path = "../host" }
# The test keys of plan ЛЦ-1 for the shell's tests only; resolver 2 keeps
# them out of the app's own build.
markiro-proto = { path = "../proto", features = ["test-keys"] }
```

Проверить: `git diff --stat apps/standalone/Cargo.lock` — пусто (фичи в `Cargo.lock` не пишутся).

**ШАГ ВЛАДЕЛЬЦА (вне песочницы, до push)** — в `[target.'cfg(windows)'.dependencies]` того же файла:

Фрагмент:

```toml
# Win32_System_Power with Win32_System_Threading: set_system_awake
# (power/windows.rs; PowerCreateRequest takes a REASON_CONTEXT).
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_Graphics_Printing",
  "Win32_Security",
  "Win32_Security_Cryptography",
  "Win32_Storage_Xps",
  "Win32_System_Power",
  "Win32_System_Threading",
  "Win32_UI_WindowsAndMessaging",
] }
```

заменить на:

```toml
# Win32_System_Power with Win32_System_Threading: set_system_awake
# (power/windows.rs; PowerCreateRequest takes a REASON_CONTEXT).
# Win32_Storage_FileSystem: GetLogicalDrives and GetDriveTypeW, the removable
# drives an update is looked for on (update/package.rs). Win32_UI_Shell with
# Win32_System_Registry: ShellExecuteExW with the "runas" verb
# (update/launch.rs; SHELLEXECUTEINFOW holds an HKEY, so windows-sys gates
# the struct and the function on Win32_System_Registry).
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_Graphics_Printing",
  "Win32_Security",
  "Win32_Security_Cryptography",
  "Win32_Storage_FileSystem",
  "Win32_Storage_Xps",
  "Win32_System_Power",
  "Win32_System_Registry",
  "Win32_System_Threading",
  "Win32_UI_Shell",
  "Win32_UI_WindowsAndMessaging",
] }
```

`Cargo.lock` от этого не меняется. (Проверено по исходникам `windows-sys` 0.61.2: `ShellExecuteExW` и `SHELLEXECUTEINFOW` под `Win32_System_Registry`, `GetLogicalDrives`/`GetDriveTypeW` — `Win32_Storage_FileSystem`, `SW_SHOWNORMAL` — `Win32_UI_WindowsAndMessaging`, `GetLastError`/`CloseHandle`/`ERROR_CANCELLED` — `Win32_Foundation`.) Если исполнителю правка этого блока разрешена — он делает её сам и записывает это; компилирует код под `cfg(windows)` только задание `standalone-windows-build`.

- [ ] **Step 2: Написать падающие тесты**

Создать `apps/standalone/src-tauri/src/update/mod.rs` (задачи 6 и 7 дописывают его):

```rust
//! Updates from a file (plan ОБН-2, spec §10.1–§10.5): the shell finds the
//! packages, checks the signed manifest and the installer beside it, and
//! starts that very installer with Windows' administrator prompt. The
//! webview names a package only by a path this module found itself; the
//! keys, the installer's bytes and the launch stay here.
//!
//! - [`package`] finds `*.update.jws` in `Документы\Markiro\Обновления` and on
//!   removable drives, and reads an installer through a handle that lets
//!   nobody write, rename or delete it while the app holds it;
//! - [`rules`] decides what the version rules of spec §10.7–§10.8 allow.

pub mod package;
pub mod rules;
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент:

```rust
pub mod secret_store;
pub mod tls;
```

заменить на:

```rust
pub mod secret_store;
pub mod tls;
pub mod update;
```

Создать `rules.rs` и `package.rs` из шага 4 так: типы, константы и сигнатуры — как в шаге 4, тела публичных функций — `unimplemented!("ОБН-2, задача 5")`, тестовые модули (`mod tests`, `mod windows_tests`) — целиком из шага 4. В `host_probe.rs` — `HostVersions`, `read_versions` с телом `unimplemented!()` и новый тест из шага 4 (фрагмент 3).

- [ ] **Step 3: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib -- update:: host_probe::
```

Ожидается: тесты `update::rules::tests::*`, `update::package::tests::*` (кроме `every_refusal_has_its_own_code`) и `host_probe::tests::the_versions_of_any_markiro_host_are_read` — FAIL (`not implemented`); прежние тесты `host_probe` — PASS.

- [ ] **Step 4: Реализация**

Заменить `apps/standalone/src-tauri/src/update/rules.rs` целиком:

```rust
//! The version rules of an update from a file (spec §10.7, §10.8): never an
//! older version; the same one only as a confirmed reinstall; not past a
//! version it must not skip (`minUpgradeFrom`); on a PC that is not the
//! host's, not ahead of the host's protocol, and only with a confirmation
//! while the host does not answer. Pure: the inputs are read elsewhere.

use std::cmp::Ordering;

use markiro_proto::update::AppVersion;
use serde::Serialize;

use crate::host_probe::HostVersions;

/// The package's version against this app's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Newer,
    Same,
    Older,
}

/// Why the package may not be installed here, with what the text names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Refusal {
    /// The package is older than this app: never a downgrade (§10.8).
    Older { installed: String },
    /// This app is older than the package's `minUpgradeFrom` (§10.2).
    MinUpgrade {
        #[serde(rename = "minUpgradeFrom")]
        min_upgrade_from: String,
    },
    /// The package speaks a newer protocol than the host: the host first (§10.7).
    HostFirst {
        #[serde(rename = "hostProtocol")]
        host_protocol: u32,
        protocol: u32,
    },
}

/// A warning a person confirms before the install (the webview sends its code back).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confirmation {
    /// The same version again: a repair (§10.8).
    Reinstall,
    /// The host did not answer: this PC may end up ahead of it (§10.7, ЛО12).
    HostUnreachable,
}

impl Confirmation {
    /// The confirmation of a code the webview sends; `None` for any other text.
    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "reinstall" => Some(Self::Reinstall),
            "host_unreachable" => Some(Self::HostUnreachable),
            _ => None,
        }
    }
}

/// What is known of the host this PC answers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCheck {
    /// This is the host's own PC: the same installer updates the host.
    NotNeeded,
    /// The host answered `hello`.
    Seen(HostVersions),
    /// The host did not answer.
    Silent,
}

/// What the signed manifest offers.
#[derive(Debug, Clone, Copy)]
pub struct Offered<'a> {
    pub version: &'a AppVersion,
    pub min_upgrade_from: &'a AppVersion,
    pub protocol: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub comparison: Comparison,
    pub refusal: Option<Refusal>,
    pub confirmations: Vec<Confirmation>,
}

pub fn decide(offered: Offered<'_>, installed: &AppVersion, host: &HostCheck) -> Decision {
    let comparison = match offered.version.cmp(installed) {
        Ordering::Greater => Comparison::Newer,
        Ordering::Equal => Comparison::Same,
        Ordering::Less => Comparison::Older,
    };
    let mut confirmations = Vec::new();
    if comparison == Comparison::Same {
        confirmations.push(Confirmation::Reinstall);
    }
    let refusal = if comparison == Comparison::Older {
        Some(Refusal::Older {
            installed: installed.to_string(),
        })
    } else if installed < offered.min_upgrade_from {
        Some(Refusal::MinUpgrade {
            min_upgrade_from: offered.min_upgrade_from.to_string(),
        })
    } else {
        match host {
            HostCheck::NotNeeded => None,
            HostCheck::Silent => {
                confirmations.push(Confirmation::HostUnreachable);
                None
            }
            HostCheck::Seen(seen) if offered.protocol > seen.protocol => {
                Some(Refusal::HostFirst {
                    host_protocol: seen.protocol,
                    protocol: offered.protocol,
                })
            }
            HostCheck::Seen(_) => None,
        }
    };
    Decision {
        comparison,
        refusal,
        confirmations,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn v(text: &str) -> AppVersion {
        text.parse().unwrap()
    }

    fn seen(protocol: u32) -> HostCheck {
        HostCheck::Seen(HostVersions {
            version: Some("0.2.0".into()),
            protocol,
            min_protocol: 1,
        })
    }

    fn offered<'a>(version: &'a AppVersion, min: &'a AppVersion, protocol: u32) -> Offered<'a> {
        Offered {
            version,
            min_upgrade_from: min,
            protocol,
        }
    }

    #[test]
    fn a_newer_package_installs_without_a_question() {
        let (version, min) = (v("0.2.0"), v("0.1.0"));
        let expected = Decision {
            comparison: Comparison::Newer,
            refusal: None,
            confirmations: vec![],
        };
        assert_eq!(
            decide(offered(&version, &min, 3), &v("0.1.0"), &HostCheck::NotNeeded),
            expected
        );
        assert_eq!(
            decide(offered(&version, &min, 3), &v("0.1.0"), &seen(3)),
            expected
        );
    }

    #[test]
    fn an_older_package_is_refused_and_the_same_one_asks_first() {
        let (version, min) = (v("0.2.0"), v("0.1.0"));
        let older = decide(offered(&version, &min, 3), &v("0.3.0"), &HostCheck::Silent);
        assert_eq!(older.comparison, Comparison::Older);
        assert_eq!(
            older.refusal,
            Some(Refusal::Older {
                installed: "0.3.0".into()
            })
        );
        assert_eq!(older.confirmations, vec![]);
        let same = decide(offered(&version, &min, 3), &v("0.2.0"), &HostCheck::NotNeeded);
        assert_eq!(
            (same.comparison, same.refusal, same.confirmations),
            (Comparison::Same, None, vec![Confirmation::Reinstall])
        );
        let same_alone = decide(offered(&version, &min, 3), &v("0.2.0"), &HostCheck::Silent);
        assert_eq!(
            same_alone.confirmations,
            vec![Confirmation::Reinstall, Confirmation::HostUnreachable]
        );
    }

    #[test]
    fn a_package_that_skips_a_needed_version_is_refused() {
        let (version, min) = (v("0.3.0"), v("0.2.0"));
        assert_eq!(
            decide(offered(&version, &min, 3), &v("0.1.0"), &HostCheck::NotNeeded).refusal,
            Some(Refusal::MinUpgrade {
                min_upgrade_from: "0.2.0".into()
            })
        );
        assert_eq!(
            decide(offered(&version, &min, 3), &v("0.2.0"), &HostCheck::NotNeeded).refusal,
            None
        );
    }

    #[test]
    fn a_pc_that_is_not_the_hosts_waits_for_its_host() {
        let (version, min) = (v("0.3.0"), v("0.2.0"));
        assert_eq!(
            decide(offered(&version, &min, 4), &v("0.2.0"), &seen(3)).refusal,
            Some(Refusal::HostFirst {
                host_protocol: 3,
                protocol: 4
            })
        );
        assert_eq!(
            decide(offered(&version, &min, 4), &v("0.2.0"), &seen(4)).refusal,
            None
        );
        let silent = decide(offered(&version, &min, 4), &v("0.2.0"), &HostCheck::Silent);
        assert_eq!(
            (silent.refusal, silent.confirmations),
            (None, vec![Confirmation::HostUnreachable])
        );
        // The host's own PC is updated by the same installer: no host is asked.
        assert_eq!(
            decide(offered(&version, &min, 4), &v("0.2.0"), &HostCheck::NotNeeded).refusal,
            None
        );
    }

    #[test]
    fn the_reasons_cross_ipc_in_the_webviews_words() {
        assert_eq!(
            serde_json::to_value(Refusal::MinUpgrade {
                min_upgrade_from: "0.2.0".into()
            })
            .unwrap(),
            json!({ "code": "min_upgrade", "minUpgradeFrom": "0.2.0" })
        );
        assert_eq!(
            serde_json::to_value(Refusal::HostFirst {
                host_protocol: 3,
                protocol: 4
            })
            .unwrap(),
            json!({ "code": "host_first", "hostProtocol": 3, "protocol": 4 })
        );
        assert_eq!(
            serde_json::to_value(Refusal::Older {
                installed: "0.3.0".into()
            })
            .unwrap(),
            json!({ "code": "older", "installed": "0.3.0" })
        );
        assert_eq!(
            serde_json::to_value(Confirmation::HostUnreachable).unwrap(),
            json!("host_unreachable")
        );
        assert_eq!(
            serde_json::to_value(Comparison::Newer).unwrap(),
            json!("newer")
        );
        for confirmation in [Confirmation::Reinstall, Confirmation::HostUnreachable] {
            let code = serde_json::to_value(confirmation).unwrap();
            assert_eq!(
                Confirmation::from_code(code.as_str().unwrap()),
                Some(confirmation)
            );
        }
        assert_eq!(Confirmation::from_code("yes"), None);
    }
}
```

Заменить `apps/standalone/src-tauri/src/update/package.rs` целиком:

```rust
//! Update packages on this computer (plan ОБН-2, spec §10.1, §10.4, §10.5):
//! a signed manifest `*.update.jws` and the installer it names, side by side.
//! [`scan`] looks in `Документы\Markiro\Обновления` and in the root and the
//! `Markiro\` folder of every removable drive, no deeper, and checks each
//! manifest's signature at once (milliseconds), so a version is shown only
//! for a signed one. [`verify`] reads the manifest again, and the installer
//! through [`open_installer`]'s handle, which the caller holds until Windows
//! has started that very file. A failure is logged by its kind, never by a
//! path: a path names the Windows user.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use markiro_proto::trust::{self, Keyset, TrustError, UpdateManifestV1};
use markiro_proto::update::{self, AppVersion, HashError};
use serde::Serialize;
use serde_json::Value;

use crate::update::rules::Offered;

/// The end of a manifest's file name, in any case.
pub const MANIFEST_SUFFIX: &str = ".update.jws";
/// The largest manifest read (the host takes the same bound, spec §10.11.2).
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// The most packages one search lists.
pub const MAX_FOUND: usize = 32;
/// The folder of a removable drive looked into besides its root.
pub const DRIVE_FOLDER: &str = "Markiro";
/// `GetDriveTypeW`'s answer for a removable drive (`DRIVE_REMOVABLE` lives in
/// `Win32_System_WindowsProgramming`; one constant is no reason for a feature).
pub const DRIVE_REMOVABLE: u32 = 2;

/// `FILE_SHARE_READ`: others may only read the installer while it is held.
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;
/// `FILE_FLAG_OPEN_REPARSE_POINT`: a link is opened as itself, never followed.
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// The removable drives of this computer, behind a trait so tests name their own.
pub trait RemovableDrives: Send + Sync {
    fn roots(&self) -> Vec<PathBuf>;
}

/// This computer's removable drives (`GetLogicalDrives`, `GetDriveTypeW`).
pub struct SystemDrives;

impl RemovableDrives for SystemDrives {
    #[cfg(windows)]
    fn roots(&self) -> Vec<PathBuf> {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
        // SAFETY: no arguments; the answer is a mask of the drive letters in use.
        let mask = unsafe { GetLogicalDrives() };
        removable_roots(mask, |root| {
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is a NUL-terminated `X:\`, alive for the call.
            unsafe { GetDriveTypeW(wide.as_ptr()) }
        })
    }

    /// Elsewhere (development) there are none.
    #[cfg(not(windows))]
    fn roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

/// Drives a test names.
pub struct FixedDrives(pub Vec<PathBuf>);

impl RemovableDrives for FixedDrives {
    fn roots(&self) -> Vec<PathBuf> {
        self.0.clone()
    }
}

/// `X:\` for every letter of a `GetLogicalDrives` mask whose type is
/// removable, from `C:` on: `A:` and `B:` are floppies, slow to wake.
pub fn removable_roots(mask: u32, drive_type: impl Fn(&str) -> u32) -> Vec<PathBuf> {
    (2u8..26)
        .filter(|bit| mask & (1u32 << bit) != 0)
        .filter_map(|bit| {
            let root = format!("{}:\\", char::from(b'A' + bit));
            (drive_type(&root) == DRIVE_REMOVABLE).then(|| PathBuf::from(root))
        })
        .collect()
}

/// Where a package was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceKind {
    /// `Документы\Markiro\Обновления`.
    Documents,
    /// A removable drive's root or its `Markiro\` folder.
    Removable,
}

/// One folder a search reads, not deeper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub kind: PlaceKind,
    pub dir: PathBuf,
}

/// The updates folder first, then each drive's root and its `Markiro\`.
pub fn places(updates_dir: Option<&Path>, roots: &[PathBuf]) -> Vec<Place> {
    let mut places: Vec<Place> = updates_dir
        .map(|dir| Place {
            kind: PlaceKind::Documents,
            dir: dir.to_path_buf(),
        })
        .into_iter()
        .collect();
    for root in roots {
        places.push(Place {
            kind: PlaceKind::Removable,
            dir: root.clone(),
        });
        places.push(Place {
            kind: PlaceKind::Removable,
            dir: root.join(DRIVE_FOLDER),
        });
    }
    places
}

/// Why a package does not hold: the bare code the webview reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    /// Not a manifest of this product, too large, not text, a payload of
    /// another shape, another installer name, a link.
    ManifestMalformed,
    /// Signed with a key this build does not know (or a retired one).
    ManifestUnknownKey,
    /// The signature does not verify: changed after it was signed.
    ManifestSignature,
    /// No installer of the manifest's name beside it.
    InstallerMissing,
    /// The installer's size or SHA-256 is not the manifest's, or it is a link.
    InstallerMismatch,
    /// The disk refused (no access, a drive pulled out).
    Storage,
}

impl PackageError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ManifestMalformed => "manifest_malformed",
            Self::ManifestUnknownKey => "manifest_unknown_key",
            Self::ManifestSignature => "manifest_signature",
            Self::InstallerMissing => "installer_missing",
            Self::InstallerMismatch => "installer_mismatch",
            Self::Storage => "storage",
        }
    }
}

fn storage(error: &io::Error) -> PackageError {
    eprintln!("standalone: update storage: {:?}", error.kind());
    PackageError::Storage
}

/// One package a search found. `path` is what the webview sends back;
/// `manifest` is the signed manifest (camelCase, as `@markiro/domain` reads
/// it) or `None` with `problem` naming why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundPackage {
    pub path: String,
    pub place: PlaceKind,
    pub file_name: String,
    pub manifest: Option<Value>,
    pub problem: Option<&'static str>,
    #[serde(skip)]
    pub source: PathBuf,
}

/// A manifest whose signature verified, with its versions read.
pub struct Manifest {
    pub manifest: UpdateManifestV1,
    pub kid: String,
    pub version: AppVersion,
    pub min_upgrade_from: AppVersion,
}

impl Manifest {
    pub fn offered(&self) -> Offered<'_> {
        Offered {
            version: &self.version,
            min_upgrade_from: &self.min_upgrade_from,
            protocol: self.manifest.protocol,
        }
    }
}

/// A package that holds: its manifest and its installer, open and held.
pub struct Checked {
    pub manifest: Manifest,
    pub installer_path: PathBuf,
    /// Keep it until the installer runs: on Windows nobody can change the
    /// file while this handle is open (`open_installer`).
    pub installer: File,
}

/// Reads and verifies the manifest at `path`: a regular file (not a link) of
/// at most [`MAX_MANIFEST_BYTES`], signed by a key of `keyset`, of this
/// product, naming the installer of its own version and a `minUpgradeFrom`
/// no newer than it.
pub fn read_manifest(path: &Path, keyset: &Keyset) -> Result<Manifest, PackageError> {
    let meta = fs::symlink_metadata(path).map_err(|error| storage(&error))?;
    if !meta.file_type().is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return Err(PackageError::ManifestMalformed);
    }
    let text = fs::read_to_string(path).map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidData {
            PackageError::ManifestMalformed
        } else {
            storage(&error)
        }
    })?;
    let (manifest, kid) =
        trust::verify_update_manifest(text.trim(), keyset).map_err(|error| match error {
            TrustError::Malformed => PackageError::ManifestMalformed,
            TrustError::UnknownKey => PackageError::ManifestUnknownKey,
            TrustError::BadSignature => PackageError::ManifestSignature,
        })?;
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| PackageError::ManifestMalformed)?;
    let min_upgrade_from: AppVersion = manifest
        .min_upgrade_from
        .parse()
        .map_err(|_| PackageError::ManifestMalformed)?;
    if manifest.product != update::PRODUCT
        || manifest.installer.name != update::installer_name(&version)
        || min_upgrade_from > version
    {
        return Err(PackageError::ManifestMalformed);
    }
    Ok(Manifest {
        manifest,
        kid,
        version,
        min_upgrade_from,
    })
}

/// The packages in `places`, at most [`MAX_FOUND`], each folder's by name. A
/// folder that is missing or unreadable is skipped.
pub fn scan(places: &[Place], keyset: &Keyset) -> Vec<FoundPackage> {
    let mut found = Vec::new();
    for place in places {
        let Ok(entries) = fs::read_dir(&place.dir) else {
            continue;
        };
        let mut manifests: Vec<(String, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                name.to_lowercase()
                    .ends_with(MANIFEST_SUFFIX)
                    .then(|| (name, entry.path()))
            })
            .collect();
        manifests.sort();
        for (file_name, path) in manifests {
            if found.len() == MAX_FOUND {
                return found;
            }
            let (manifest, problem) = match read_manifest(&path, keyset) {
                Ok(read) => match serde_json::to_value(&read.manifest) {
                    Ok(value) => (Some(value), None),
                    Err(_) => (None, Some(PackageError::ManifestMalformed.code())),
                },
                Err(error) => (None, Some(error.code())),
            };
            found.push(FoundPackage {
                path: path.to_string_lossy().into_owned(),
                place: place.kind,
                file_name,
                manifest,
                problem,
                source: path,
            });
        }
    }
    found
}

/// Opens the installer for reading, never through a link. On Windows the
/// handle shares reading only (`FILE_SHARE_READ`): while it is open nobody
/// can write, rename or delete the file, and the installer Windows starts
/// under the administrator prompt can still open it to read and run it; a
/// link is opened as itself (`FILE_FLAG_OPEN_REPARSE_POINT`) and refused.
/// Elsewhere (development) a link or another file put in its place between
/// the look and the open is refused by comparing the two.
pub fn open_installer(path: &Path) -> Result<File, PackageError> {
    let before = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(PackageError::InstallerMissing)
        }
        Err(error) => return Err(storage(&error)),
    };
    if !before.file_type().is_file() {
        return Err(PackageError::InstallerMismatch);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            PackageError::InstallerMissing
        } else {
            storage(&error)
        }
    })?;
    let after = file.metadata().map_err(|error| storage(&error))?;
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev() && before.ino() == after.ino()
    };
    #[cfg(not(unix))]
    let same = true;
    if !after.is_file() || !same {
        return Err(PackageError::InstallerMismatch);
    }
    Ok(file)
}

/// The package of the manifest at `manifest_path`: the manifest verified
/// again (it may have changed since the search), the installer beside it
/// opened by [`open_installer`], its size and SHA-256 the manifest's.
pub fn verify(manifest_path: &Path, keyset: &Keyset) -> Result<Checked, PackageError> {
    let manifest = read_manifest(manifest_path, keyset)?;
    let dir = manifest_path
        .parent()
        .ok_or(PackageError::InstallerMissing)?;
    let installer_path = dir.join(&manifest.manifest.installer.name);
    let installer = open_installer(&installer_path)?;
    let size = manifest.manifest.installer.size_bytes;
    let meta = installer.metadata().map_err(|error| storage(&error))?;
    if meta.len() != size {
        return Err(PackageError::InstallerMismatch);
    }
    let hash = update::hash_exact(&installer, size).map_err(|error| match error {
        HashError::Io(kind) => storage(&io::Error::from(kind)),
        HashError::TooShort | HashError::TooLong => PackageError::InstallerMismatch,
    })?;
    if !hash.eq_ignore_ascii_case(&manifest.manifest.installer.sha256) {
        return Err(PackageError::InstallerMismatch);
    }
    Ok(Checked {
        manifest,
        installer_path,
        installer,
    })
}

/// Makes `folder` (`Документы\Markiro\Обновления`) when it is missing; a
/// file or a link in its place is refused.
pub fn ensure_folder(folder: &Path) -> Result<(), PackageError> {
    if let Some(parent) = folder.parent() {
        fs::create_dir_all(parent).map_err(|error| storage(&error))?;
    }
    match fs::create_dir(folder) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage(&error)),
    }
    match fs::symlink_metadata(folder) {
        Ok(meta) if meta.file_type().is_dir() => Ok(()),
        Ok(_) => Err(PackageError::Storage),
        Err(error) => Err(storage(&error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/update");
    const LICENSE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/domain/fixtures/standalone-license/license-subscription.jws"
    );

    fn keyset() -> Keyset {
        markiro_proto::trust::update_keyset()
    }

    /// The bytes the generator signed for `version`'s test installer.
    fn test_installer(version: &str) -> Vec<u8> {
        format!("markiro test installer {version}\n").into_bytes()
    }

    fn installer_file(version: &str) -> String {
        format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
    }

    /// The signed test manifest of `version` in `dir`, its installer beside it.
    fn put_package(dir: &Path, version: &str) -> PathBuf {
        let name = format!("markiro-standalone-{version}.update.jws");
        fs::copy(Path::new(FIXTURES).join(&name), dir.join(&name)).unwrap();
        fs::write(dir.join(installer_file(version)), test_installer(version)).unwrap();
        dir.join(name)
    }

    #[test]
    fn removable_roots_are_the_removable_letters_from_c() {
        // A, C, E and F in use; A and E removable.
        let mask = 1 | (1 << 2) | (1 << 4) | (1 << 5);
        let kind = |root: &str| match root {
            "A:\\" | "E:\\" => DRIVE_REMOVABLE,
            _ => 3,
        };
        assert_eq!(removable_roots(mask, kind), vec![PathBuf::from("E:\\")]);
        assert_eq!(removable_roots(0, kind), Vec::<PathBuf>::new());
    }

    #[test]
    fn places_are_the_updates_folder_then_each_drive_and_its_markiro_folder() {
        let roots = [PathBuf::from("E"), PathBuf::from("F")];
        let place = |kind, dir: PathBuf| Place { kind, dir };
        assert_eq!(
            places(Some(Path::new("docs")), &roots),
            vec![
                place(PlaceKind::Documents, PathBuf::from("docs")),
                place(PlaceKind::Removable, PathBuf::from("E")),
                place(PlaceKind::Removable, Path::new("E").join("Markiro")),
                place(PlaceKind::Removable, PathBuf::from("F")),
                place(PlaceKind::Removable, Path::new("F").join("Markiro")),
            ]
        );
        assert_eq!(places(None, &[]), vec![]);
    }

    #[test]
    fn a_search_shows_signed_packages_with_their_versions_and_others_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        put_package(dir.path(), "0.2.0");
        fs::copy(
            Path::new(FIXTURES).join("markiro-standalone-0.3.0.update.jws"),
            dir.path().join("UPPER.UPDATE.JWS"),
        )
        .unwrap();
        fs::copy(
            Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
            dir.path().join("broken.update.jws"),
        )
        .unwrap();
        // A license is signed too, but it is no update manifest (another `typ`).
        fs::copy(LICENSE, dir.path().join("license.update.jws")).unwrap();
        fs::write(
            dir.path().join("big.update.jws"),
            vec![b'a'; usize::try_from(MAX_MANIFEST_BYTES).unwrap() + 1],
        )
        .unwrap();
        fs::write(dir.path().join("notes.txt"), "не пакет").unwrap();
        let found = scan(&places(Some(dir.path()), &[]), &keyset());
        let seen: Vec<(String, Option<String>, Option<&str>)> = found
            .iter()
            .map(|package| {
                (
                    package.file_name.clone(),
                    package
                        .manifest
                        .as_ref()
                        .map(|manifest| manifest["version"].as_str().unwrap().to_owned()),
                    package.problem,
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                ("UPPER.UPDATE.JWS".to_owned(), Some("0.3.0".to_owned()), None),
                ("big.update.jws".to_owned(), None, Some("manifest_malformed")),
                ("broken.update.jws".to_owned(), None, Some("manifest_signature")),
                ("license.update.jws".to_owned(), None, Some("manifest_malformed")),
                (
                    "markiro-standalone-0.2.0.update.jws".to_owned(),
                    Some("0.2.0".to_owned()),
                    None
                ),
            ]
        );
        assert!(found.iter().all(|package| package.place == PlaceKind::Documents));
        assert_eq!(
            found[4].path,
            dir.path()
                .join("markiro-standalone-0.2.0.update.jws")
                .to_string_lossy()
        );
        // The source stays in Rust: the webview sees the path and nothing else of it.
        let json = serde_json::to_value(&found[4]).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["fileName", "manifest", "path", "place", "problem"]);
    }

    #[test]
    fn a_drive_is_read_in_its_root_and_its_markiro_folder_only() {
        let drive = tempfile::tempdir().unwrap();
        let markiro = drive.path().join("Markiro");
        let deeper = markiro.join("old");
        fs::create_dir_all(&deeper).unwrap();
        put_package(drive.path(), "0.2.0");
        put_package(&markiro, "0.3.0");
        put_package(&deeper, "0.2.0");
        let found = scan(&places(None, &[drive.path().to_path_buf()]), &keyset());
        let versions: Vec<&str> = found
            .iter()
            .map(|package| package.manifest.as_ref().unwrap()["version"].as_str().unwrap())
            .collect();
        assert_eq!(versions, ["0.2.0", "0.3.0"]);
        assert!(found.iter().all(|package| package.place == PlaceKind::Removable));
        // A missing folder is no error: nothing there.
        let none = drive.path().join("none");
        assert_eq!(scan(&places(Some(none.as_path()), &[]), &keyset()), vec![]);
    }

    #[test]
    fn a_package_holds_only_with_its_own_installer_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = put_package(dir.path(), "0.2.0");
        let checked = verify(&manifest, &keyset()).unwrap();
        assert_eq!(checked.manifest.kid, "test-upd-1");
        assert_eq!(checked.manifest.version.to_string(), "0.2.0");
        assert_eq!(checked.manifest.min_upgrade_from.to_string(), "0.1.0");
        assert_eq!(checked.installer_path, dir.path().join(installer_file("0.2.0")));
        drop(checked);
        let installer = dir.path().join(installer_file("0.2.0"));
        // One byte more, the same size with another byte, no installer.
        let mut longer = test_installer("0.2.0");
        longer.push(b'!');
        fs::write(&installer, &longer).unwrap();
        assert_eq!(verify(&manifest, &keyset()).err(), Some(PackageError::InstallerMismatch));
        let mut changed = test_installer("0.2.0");
        changed[0] = b'M';
        fs::write(&installer, &changed).unwrap();
        assert_eq!(verify(&manifest, &keyset()).err(), Some(PackageError::InstallerMismatch));
        fs::remove_file(&installer).unwrap();
        assert_eq!(verify(&manifest, &keyset()).err(), Some(PackageError::InstallerMissing));
        // A manifest changed after signing.
        let tampered = tempfile::tempdir().unwrap();
        let path = tampered.path().join("markiro-standalone-0.2.0.update.jws");
        fs::copy(
            Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
            &path,
        )
        .unwrap();
        fs::write(tampered.path().join(installer_file("0.2.0")), test_installer("0.2.0")).unwrap();
        assert_eq!(verify(&path, &keyset()).err(), Some(PackageError::ManifestSignature));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_installer_or_the_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let manifest = put_package(dir.path(), "0.2.0");
        let installer = dir.path().join(installer_file("0.2.0"));
        let real = elsewhere.path().join("real.exe");
        fs::rename(&installer, &real).unwrap();
        std::os::unix::fs::symlink(&real, &installer).unwrap();
        assert_eq!(verify(&manifest, &keyset()).err(), Some(PackageError::InstallerMismatch));
        let linked = dir.path().join("linked.update.jws");
        std::os::unix::fs::symlink(&manifest, &linked).unwrap();
        assert_eq!(
            read_manifest(&linked, &keyset()).err(),
            Some(PackageError::ManifestMalformed)
        );
    }

    #[test]
    fn the_updates_folder_is_made_when_missing_and_a_file_in_its_place_is_refused() {
        let documents = tempfile::tempdir().unwrap();
        let folder = documents.path().join("Markiro").join("Обновления");
        assert_eq!(ensure_folder(&folder), Ok(()));
        assert!(folder.is_dir());
        assert_eq!(ensure_folder(&folder), Ok(()));
        let file = documents.path().join("Markiro").join("file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(ensure_folder(&file), Err(PackageError::Storage));
    }

    #[test]
    fn every_refusal_has_its_own_code() {
        let codes = [
            PackageError::ManifestMalformed,
            PackageError::ManifestUnknownKey,
            PackageError::ManifestSignature,
            PackageError::InstallerMissing,
            PackageError::InstallerMismatch,
            PackageError::Storage,
        ]
        .map(PackageError::code);
        assert_eq!(
            codes,
            [
                "manifest_malformed",
                "manifest_unknown_key",
                "manifest_signature",
                "installer_missing",
                "installer_mismatch",
                "storage"
            ]
        );
    }
}

/// The handle's sharing on NTFS, which only Windows shows (the
/// `standalone-windows-build` job runs it).
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// ERROR_SHARING_VIOLATION.
    const SHARING_VIOLATION: i32 = 32;

    #[test]
    fn while_the_shell_holds_the_installer_nobody_can_write_rename_or_delete_it_but_anybody_can_read_it(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("markiro-standalone-0.2.0-windows-x86_64-setup.exe");
        fs::write(&path, b"markiro test installer 0.2.0\n").unwrap();
        let held = open_installer(&path).unwrap();
        let write = OpenOptions::new().write(true).open(&path).unwrap_err();
        assert_eq!(write.raw_os_error(), Some(SHARING_VIOLATION), "{write}");
        assert!(fs::rename(&path, dir.path().join("moved.exe")).is_err());
        assert!(fs::remove_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"markiro test installer 0.2.0\n");
        drop(held);
        fs::remove_file(&path).unwrap();
    }
}
```

Правка `apps/standalone/src-tauri/src/office_files.rs`:

Фрагмент 1:

```rust
/// The folder under the documents folder.
pub const APP_FOLDER: &str = "Markiro";
```

заменить на:

```rust
/// The folder under the documents folder.
pub const APP_FOLDER: &str = "Markiro";

/// The folder under [`APP_FOLDER`] where an administrator puts update
/// packages (plan ОБН-2, spec §10.5). The office never writes into it, so it
/// is not one of [`ROOTS`]; `update_open_folder` makes it and shows it.
pub const UPDATES_ROOT: &str = "Обновления";
```

Фрагмент 2:

```rust
fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(folder, "open_office_folder")
}
```

заменить на:

```rust
fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(folder, "open_office_folder")
}

/// Shows a folder of the app other than the office's (the updates folder,
/// plan ОБН-2) in Windows Explorer, started as for the office's folders.
pub(crate) fn show_folder(folder: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(folder, "update_open_folder")
}
```

Правка `apps/standalone/src-tauri/src/host_probe.rs`:

Фрагмент 1:

```rust
pub async fn observe_hello(address: &str) -> Result<HelloObservation, ProbeError> {
    let seen = Arc::new(Mutex::new(None::<String>));
```

заменить на:

```rust
/// The protocol range and the version a Markiro host's `hello` names, read
/// whatever its protocol (plan ОБН-2): an update compares them with the
/// package, while [`observe_hello`] refuses a host this build cannot talk to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostVersions {
    pub version: Option<String>,
    pub protocol: u32,
    pub min_protocol: u32,
}

/// [`HostVersions`] of a `hello` body; another service is `NotMarkiroHost`.
pub fn read_versions(body: &serde_json::Value) -> Result<HostVersions, ProbeError> {
    let envelope: HelloEnvelope =
        serde_json::from_value(body.clone()).map_err(|_| ProbeError::NotMarkiroHost)?;
    if envelope.product != HOST_PRODUCT {
        return Err(ProbeError::NotMarkiroHost);
    }
    Ok(HostVersions {
        version: body
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        protocol: envelope.protocol,
        min_protocol: envelope.min_protocol,
    })
}

/// The versions of the host at `address`, without trusting its certificate:
/// a number to compare, not a credential (spec §10.7).
pub async fn host_versions(address: &str) -> Result<HostVersions, ProbeError> {
    let (body, _) = fetch_hello(address).await?;
    read_versions(&body)
}

pub async fn observe_hello(address: &str) -> Result<HelloObservation, ProbeError> {
    let (body, fingerprint) = fetch_hello(address).await?;
    let hello = classify_hello(body)?;
    let fingerprint = fingerprint.ok_or(ProbeError::Unreachable)?;
    Ok(HelloObservation { hello, fingerprint })
}

/// `GET /v1/hello` at `address` through the observing verifier: the body and
/// the fingerprint of the certificate the host presented.
async fn fetch_hello(address: &str) -> Result<(serde_json::Value, Option<String>), ProbeError> {
    let seen = Arc::new(Mutex::new(None::<String>));
```

Фрагмент 2 (конец прежнего тела `observe_hello`, теперь — `fetch_hello`):

```rust
    let hello = classify_hello(body)?;
    let fingerprint = seen
        .lock()
        .expect("fingerprint lock")
        .clone()
        .ok_or(ProbeError::Unreachable)?;
    Ok(HelloObservation { hello, fingerprint })
}
```

заменить на:

```rust
    let fingerprint = seen.lock().expect("fingerprint lock").clone();
    Ok((body, fingerprint))
}
```

Фрагмент 3 (в `mod tests`):

```rust
    #[test]
    fn a_compatible_hello_is_read() {
```

заменить на:

```rust
    #[test]
    fn the_versions_of_any_markiro_host_are_read() {
        // A host this build could not talk to still names its versions.
        assert_eq!(
            read_versions(&json!({
                "product": HOST_PRODUCT, "protocol": 9, "minProtocol": 5, "version": "0.9.0"
            })),
            Ok(HostVersions {
                version: Some("0.9.0".into()),
                protocol: 9,
                min_protocol: 5
            })
        );
        assert_eq!(
            read_versions(&json!({ "product": HOST_PRODUCT, "protocol": 3, "minProtocol": 1 })),
            Ok(HostVersions {
                version: None,
                protocol: 3,
                min_protocol: 1
            })
        );
        for body in [
            json!({ "product": "other", "protocol": 3, "minProtocol": 1 }),
            json!({ "status": "ok" }),
        ] {
            assert_eq!(read_versions(&body), Err(ProbeError::NotMarkiroHost));
        }
    }

    #[test]
    fn a_compatible_hello_is_read() {
```

- [ ] **Step 5: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown --test host_probe
```

Ожидается: PASS; `windows_tests` на macOS не собирается (идёт в задании Windows). Прежние тесты `office_files` — PASS (`ROOTS` не менялся).

- [ ] **Step 6: Гейты и коммит**

`cargo fmt … --check`; `cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone` без предупреждений; `git diff --stat apps/standalone/Cargo.lock` — пусто.

```bash
git add apps/standalone/src-tauri/src/update/mod.rs apps/standalone/src-tauri/src/update/rules.rs apps/standalone/src-tauri/src/update/package.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/src/office_files.rs apps/standalone/src-tauri/src/host_probe.rs apps/standalone/src-tauri/Cargo.toml
git commit -F /tmp/claude/obn2-t5-msg.txt
```

Сообщение:

```text
feat(standalone): find and check update packages — version rules, a held installer handle (plan ОБН-2)

Packages are looked for in Документы\Markiro\Обновления and on removable
drives; a manifest is verified with the build's release keys at once, the
installer is hashed through a handle that shares reading only and follows
no link. The host's versions are read whatever its protocol.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Сделан ли шаг владельца (фичи `windows-sys`) в этом коммите — записать в «Отклонения»; если нет, он остаётся предусловием push.

---

### Task 6: Оболочка — запуск с UAC за трейтом, отметка `update-pending.json`, выход мимо стража киоск-режима

**Files:**

- Create: `apps/standalone/src-tauri/src/update/launch.rs`, `apps/standalone/src-tauri/src/update/pending.rs`
- Modify: `apps/standalone/src-tauri/src/update/mod.rs`, `apps/standalone/src-tauri/src/lockdown.rs`
- Test: модули `update::launch`, `update::pending`, `lockdown` (`--lib`)

**Interfaces:**

- Consumes: `windows-sys` (`Win32_UI_Shell`, `Win32_System_Registry`, `Win32_Foundation`, `Win32_UI_WindowsAndMessaging`; шаг владельца задачи 5), `LockdownState`.
- Produces: `update::launch::{INSTALLER_ARGUMENTS, LaunchError, Launcher, SystemLauncher}`; `update::pending::{FILE_NAME, Pending, UpdateOutcome, now_ms, write, remove, take_outcome}`; `lockdown::release_for_exit(&LockdownState)`.

- [ ] **Step 1: Написать падающие тесты**

Как в задаче 5: создать `launch.rs` и `pending.rs` из шага 3 с телами публичных функций `unimplemented!("ОБН-2, задача 6")` и тестовыми модулями целиком; в `lockdown.rs` добавить тест (фрагмент 2 шага 3) и функцию `release_for_exit` с телом `unimplemented!()`. Правка `apps/standalone/src-tauri/src/update/mod.rs`:

Фрагмент:

```rust
//! - [`rules`] decides what the version rules of spec §10.7–§10.8 allow.

pub mod package;
pub mod rules;
```

заменить на:

```rust
//! - [`rules`] decides what the version rules of spec §10.7–§10.8 allow;
//! - [`launch`] starts the installer with Windows' administrator prompt
//!   (`ShellExecuteExW`, verb `runas`; a fake in tests);
//! - [`pending`] keeps `update-pending.json`, the outcome the next start reads.

pub mod launch;
pub mod package;
pub mod pending;
pub mod rules;
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib -- update::launch update::pending lockdown::
```

Ожидается: FAIL (`not implemented`) в `update::pending::tests::*` и `lockdown::tests::releasing_for_an_exit_turns_the_flag_off_without_a_window`; `update::launch::tests::*` проверяют константы и коды — они PASS уже сейчас (константа задана), это закрепление, а не красная фаза; записать.

- [ ] **Step 3: Реализация**

Заменить `apps/standalone/src-tauri/src/update/launch.rs` целиком:

```rust
//! Starting the installer (plan ОБН-2, spec §10.4): the very file whose hash
//! was checked, through the shell's `runas` verb, so Windows asks for an
//! administrator's rights (the installer is per machine) while the app keeps
//! running as the station's ordinary user. Behind [`Launcher`]: tests record
//! the call, only the Windows build calls `ShellExecuteExW`.

use std::path::Path;

/// The Tauri NSIS installer's arguments for an update the app starts:
/// passive (`/P`: a progress window, no questions, and the running app is
/// closed by the installer itself), an update of the installed copy
/// (`/UPDATE`: the previous one is not uninstalled first, so the role and
/// `installation.json` stay), and the app opened again as the signed-in user
/// afterwards (`/R`). Never `/ROLE=`: the hooks take the role from the
/// registry and would refuse another (`installer-hooks.nsh`).
pub const INSTALLER_ARGUMENTS: &str = "/P /UPDATE /R";

/// Why the installer did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    /// Windows' administrator prompt was refused or cancelled (`ERROR_CANCELLED`).
    Cancelled,
    /// Windows did not start it: the error code, for the log only.
    Failed(u32),
    /// Not Windows (a development build).
    Unsupported,
}

impl LaunchError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "uac_cancelled",
            Self::Failed(_) => "launch_failed",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Starts `installer` with `arguments` and returns once Windows started it
/// (or refused); never waits for it to finish.
pub trait Launcher: Send + Sync {
    fn launch(&self, installer: &Path, arguments: &str) -> Result<(), LaunchError>;
}

/// The real launch: `ShellExecuteExW` with `runas` on Windows.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    #[cfg(windows)]
    fn launch(&self, installer: &Path, arguments: &str) -> Result<(), LaunchError> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED};
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
            SHELLEXECUTEINFOW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        fn wide(text: &OsStr) -> Vec<u16> {
            text.encode_wide().chain(std::iter::once(0)).collect()
        }
        let verb = wide(OsStr::new("runas"));
        let file = wide(installer.as_os_str());
        let parameters = wide(OsStr::new(arguments));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: u32::try_from(std::mem::size_of::<SHELLEXECUTEINFOW>()).unwrap_or(u32::MAX),
            // The process handle back (closed at once: nothing waits for the
            // installer), the call finished before it returns, and no error
            // dialog of the shell's own: the office shows the refusal.
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            lpParameters: parameters.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..Default::default()
        };
        // SAFETY: `info` is sized and filled as the call expects; the wide
        // strings it points to live until the call returns.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            // SAFETY: plain call, right after the failing one.
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_CANCELLED {
                LaunchError::Cancelled
            } else {
                LaunchError::Failed(code)
            });
        }
        if !info.hProcess.is_null() {
            // SAFETY: the handle `SEE_MASK_NOCLOSEPROCESS` gave back, closed once.
            unsafe { CloseHandle(info.hProcess) };
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn launch(&self, _installer: &Path, _arguments: &str) -> Result<(), LaunchError> {
        Err(LaunchError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installer_updates_passively_keeps_its_role_and_opens_the_app_again() {
        let arguments: Vec<&str> = INSTALLER_ARGUMENTS.split(' ').collect();
        assert_eq!(arguments, ["/P", "/UPDATE", "/R"]);
        // A silent run would hide a hook's refusal; a role would be refused.
        assert!(!INSTALLER_ARGUMENTS.contains("/S"));
        assert!(!INSTALLER_ARGUMENTS.contains("/ROLE"));
    }

    #[test]
    fn refusals_are_the_webviews_codes() {
        assert_eq!(LaunchError::Cancelled.code(), "uac_cancelled");
        assert_eq!(LaunchError::Failed(2).code(), "launch_failed");
        assert_eq!(LaunchError::Unsupported.code(), "unsupported");
    }

    #[cfg(not(windows))]
    #[test]
    fn nothing_is_started_outside_windows() {
        assert_eq!(
            SystemLauncher.launch(Path::new("setup.exe"), INSTALLER_ARGUMENTS),
            Err(LaunchError::Unsupported)
        );
    }
}
```

Заменить `apps/standalone/src-tauri/src/update/pending.rs` целиком:

```rust
//! `update-pending.json` in the app's data folder (plan ОБН-2, spec
//! §10.11.4): written right before the installer starts, read at the next
//! start. This version is the one the update went to — «обновлено», and the
//! mark goes; it is still the one it came from — «не завершилось», and the
//! mark stays until the person hides the message or starts again; anything
//! else is a stale mark and goes. The time is milliseconds since the epoch:
//! the shell has no calendar crate.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "update-pending.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub from: String,
    pub to: String,
    pub started_at_ms: u64,
}

/// What the last update came to, as the next start found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateOutcome {
    Updated {
        from: String,
        to: String,
    },
    NotFinished {
        from: String,
        to: String,
        #[serde(rename = "startedAtMs")]
        started_at_ms: u64,
    },
}

/// Milliseconds since the epoch on this computer's clock.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Writes the mark whole: a partial file, flushed, then renamed over the name.
pub fn write(dir: &Path, pending: &Pending) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let partial = dir.join(format!("{FILE_NAME}.partial"));
    let bytes = serde_json::to_vec(pending).map_err(io::Error::other)?;
    {
        let mut file = File::create(&partial)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&partial, dir.join(FILE_NAME))
}

/// Removes the mark; none is no error.
pub fn remove(dir: &Path) -> io::Result<()> {
    match fs::remove_file(dir.join(FILE_NAME)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// The outcome of the mark in `dir` for this app's version `installed`; the
/// mark is removed unless the update did not finish.
pub fn take_outcome(dir: &Path, installed: &str) -> Option<UpdateOutcome> {
    let text = fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    let Ok(pending) = serde_json::from_str::<Pending>(&text) else {
        let _ = remove(dir);
        return None;
    };
    if pending.to == installed {
        let _ = remove(dir);
        Some(UpdateOutcome::Updated {
            from: pending.from,
            to: pending.to,
        })
    } else if pending.from == installed {
        Some(UpdateOutcome::NotFinished {
            from: pending.from,
            to: pending.to,
            started_at_ms: pending.started_at_ms,
        })
    } else {
        let _ = remove(dir);
        None
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn mark(dir: &Path) {
        write(
            dir,
            &Pending {
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                started_at_ms: 1_760_000_000_000,
            },
        )
        .unwrap();
    }

    #[test]
    fn the_new_version_says_updated_and_the_mark_goes() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        assert!(!dir.path().join("update-pending.json.partial").exists());
        assert_eq!(
            take_outcome(dir.path(), "0.2.0"),
            Some(UpdateOutcome::Updated {
                from: "0.1.0".into(),
                to: "0.2.0".into()
            })
        );
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(take_outcome(dir.path(), "0.2.0"), None);
    }

    #[test]
    fn the_old_version_says_not_finished_and_the_mark_stays() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        for _ in 0..2 {
            assert_eq!(
                take_outcome(dir.path(), "0.1.0"),
                Some(UpdateOutcome::NotFinished {
                    from: "0.1.0".into(),
                    to: "0.2.0".into(),
                    started_at_ms: 1_760_000_000_000
                })
            );
        }
        remove(dir.path()).unwrap();
        remove(dir.path()).unwrap();
        assert_eq!(take_outcome(dir.path(), "0.1.0"), None);
    }

    #[test]
    fn a_stale_or_unreadable_mark_goes_with_nothing_to_say() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        assert_eq!(take_outcome(dir.path(), "0.3.0"), None);
        assert!(!dir.path().join(FILE_NAME).exists());
        for text in [
            "{",
            r#"{"from":"0.1.0","to":"0.2.0","startedAtMs":1,"extra":true}"#,
            r#"{"from":"0.1.0","to":"0.2.0"}"#,
        ] {
            fs::write(dir.path().join(FILE_NAME), text).unwrap();
            assert_eq!(take_outcome(dir.path(), "0.1.0"), None, "{text}");
            assert!(!dir.path().join(FILE_NAME).exists());
        }
    }

    #[test]
    fn the_outcome_crosses_ipc_in_the_webviews_words() {
        assert_eq!(
            serde_json::to_value(UpdateOutcome::NotFinished {
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                started_at_ms: 1
            })
            .unwrap(),
            json!({ "kind": "not_finished", "from": "0.1.0", "to": "0.2.0", "startedAtMs": 1 })
        );
        assert_eq!(
            serde_json::to_value(UpdateOutcome::Updated {
                from: "0.1.0".into(),
                to: "0.2.0".into()
            })
            .unwrap(),
            json!({ "kind": "updated", "from": "0.1.0", "to": "0.2.0" })
        );
        assert!(now_ms() > 1_700_000_000_000);
    }
}
```

Правка `apps/standalone/src-tauri/src/lockdown.rs`:

Фрагмент 1:

```rust
/// The window-event guard `run` installs: a close request (the frame's
```

заменить на:

```rust
/// The way out for an update (plan ОБН-2, spec §10.4 step 7): the flag goes
/// off, so the close that the app's exit brings is never refused by
/// [`refuse_close_while_locked`]; the window's properties are left as they
/// are, since the app is leaving. Only the shell's update path calls it,
/// right before it exits, once Windows has started the installer.
pub fn release_for_exit(state: &LockdownState) {
    state.set(false);
}

/// The window-event guard `run` installs: a close request (the frame's
```

Фрагмент 2 (в `mod tests`):

```rust
    #[test]
    fn refusals_are_bare_codes() {
```

заменить на:

```rust
    #[test]
    fn releasing_for_an_exit_turns_the_flag_off_without_a_window() {
        let state = LockdownState::default();
        state.set(true);
        release_for_exit(&state);
        assert!(!state.is_locked());
        release_for_exit(&state);
        assert!(!state.is_locked());
    }

    #[test]
    fn refusals_are_bare_codes() {
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test lockdown
```

Ожидается: PASS. Ветка `#[cfg(windows)]` `SystemLauncher::launch` компилируется только в задании Windows после шага владельца.

- [ ] **Step 5: Гейты и коммит**

```bash
git add apps/standalone/src-tauri/src/update/launch.rs apps/standalone/src-tauri/src/update/pending.rs apps/standalone/src-tauri/src/update/mod.rs apps/standalone/src-tauri/src/lockdown.rs
git commit -F /tmp/claude/obn2-t6-msg.txt
```

Сообщение:

```text
feat(standalone): start the installer with the administrator prompt and leave past the kiosk guard (plan ОБН-2)

ShellExecuteExW with runas and /P /UPDATE /R behind a Launcher trait,
update-pending.json and the outcome the next start reads, and the one way
out of kiosk mode that is not an administrator's: the update's exit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 7: Оболочка — `UpdateState` и команды обновления; контракт IPC

**Files:**

- Create: `apps/standalone/src-tauri/tests/update.rs`
- Modify: `apps/standalone/src-tauri/src/update/mod.rs`, `apps/standalone/src-tauri/src/lib.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- Test: `apps/standalone/src-tauri/tests/ipc.rs`, `apps/standalone/src-tauri/tests/update.rs`

**Interfaces:**

- Consumes: `update::{package, rules, launch, pending}` (задачи 5–6), `DeviceState::{status, install_role}`, `host_probe::host_versions`, `lockdown::release_for_exit`, `office_files::{APP_FOLDER, UPDATES_ROOT, show_folder, OfficeFilesError}`, `markiro_proto::trust::{Keyset, update_keyset}`.
- Produces: `update::{UpdateError, UpdateConfig, UpdateState, VerifiedReport}` и методы `UpdateState::{load, scan, verify, install, outcome, dismiss_outcome, open_folder, exit_for_update}`; команды `update_scan`, `update_verify { path }`, `update_install { path, confirm }`, `update_outcome`, `update_outcome_dismiss`, `update_open_folder`; `manage_state` управляет `UpdateState`; `lib::local_host_address` — `pub(crate)`.

IPC (для `src/office/info/update-shell.ts`, задача 8):

| Команда                  | Аргументы                     | Ответ                                                                                                                                                       | Отказы (голые строки)                                                                                                                                      |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_scan`            | —                             | `[{ path, place: "documents" \| "removable", fileName, manifest \| null, problem \| null }]`                                                                | `storage`                                                                                                                                                  |
| `update_verify`          | `{ path }`                    | `{ path, kid, manifest, installed, installerPath, comparison, refusal \| null, confirmations: string[], host: { version, protocol, minProtocol } \| null }` | `invalid_request`, `manifest_malformed`, `manifest_unknown_key`, `manifest_signature`, `installer_missing`, `installer_mismatch`, `storage`, `unsupported` |
| `update_install`         | `{ path, confirm: string[] }` | `null` (затем приложение выходит)                                                                                                                           | то же и `update_refused`, `confirmation_required`, `uac_cancelled`, `launch_failed`                                                                        |
| `update_outcome`         | —                             | `{ kind: "updated", from, to } \| { kind: "not_finished", from, to, startedAtMs } \| null`                                                                  | —                                                                                                                                                          |
| `update_outcome_dismiss` | —                             | `null`                                                                                                                                                      | `storage`                                                                                                                                                  |
| `update_open_folder`     | —                             | `null`                                                                                                                                                      | `documents_unavailable`, `storage`, `unsupported`, `invalid_request`                                                                                       |

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1 (импорты):

```rust
use markiro_standalone_lib::secret_store;
use serde_json::{json, Value};
```

заменить на:

```rust
use markiro_standalone_lib::secret_store;
use markiro_standalone_lib::update::launch::{LaunchError, Launcher};
use markiro_standalone_lib::update::package::FixedDrives;
use markiro_standalone_lib::update::{UpdateConfig, UpdateState};
use serde_json::{json, Value};
```

Фрагмент 2 (тест `the_app_manages_every_state_its_commands_read`):

```rust
    assert!(app.try_state::<OfficeFilesState>().is_some());
```

заменить на:

```rust
    assert!(app.try_state::<OfficeFilesState>().is_some());
    assert!(app.try_state::<UpdateState>().is_some());
```

и в конце того же теста (перед закрывающей `}`), после проверки `set_system_awake`:

```rust
    // No update was pending in a fresh data folder.
    assert_eq!(invoke(&webview, "update_outcome", json!({})), Ok(Value::Null));
```

В конец файла добавить:

```rust
const UPDATE_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/update");

/// The bytes `tools/standalone-release/generate-update-fixtures.mjs` signed
/// for `version`'s test installer.
fn test_installer(version: &str) -> Vec<u8> {
    format!("markiro test installer {version}\n").into_bytes()
}

/// The signed test manifest of `version` copied into `dir`, its installer beside it.
fn put_package(dir: &std::path::Path, version: &str) -> String {
    let name = format!("markiro-standalone-{version}.update.jws");
    std::fs::copy(std::path::Path::new(UPDATE_FIXTURES).join(&name), dir.join(&name)).unwrap();
    std::fs::write(
        dir.join(format!("markiro-standalone-{version}-windows-x86_64-setup.exe")),
        test_installer(version),
    )
    .unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

/// A launcher that records what it was asked to start and answers `answer`.
struct RecordingLauncher {
    calls: std::sync::Mutex<Vec<(std::path::PathBuf, String)>>,
    answer: Result<(), LaunchError>,
}

impl Launcher for RecordingLauncher {
    fn launch(&self, installer: &std::path::Path, arguments: &str) -> Result<(), LaunchError> {
        self.calls
            .lock()
            .unwrap()
            .push((installer.to_path_buf(), arguments.to_owned()));
        self.answer
    }
}

/// The shell of the host's own PC (no host to ask) with an update state
/// over temporary folders, a recording launcher and a recorded exit.
struct UpdateApp {
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    launcher: std::sync::Arc<RecordingLauncher>,
    exits: std::sync::Arc<std::sync::Mutex<Vec<i32>>>,
    data: tempfile::TempDir,
    updates: std::path::PathBuf,
    _documents: tempfile::TempDir,
    _device: tempfile::TempDir,
}

fn update_app(
    installed: &str,
    answer: Result<(), LaunchError>,
    before_start: impl FnOnce(&std::path::Path),
) -> UpdateApp {
    let data = tempfile::tempdir().unwrap();
    let documents = tempfile::tempdir().unwrap();
    let device = tempfile::tempdir().unwrap();
    before_start(data.path());
    let updates = documents.path().join("Markiro").join("Обновления");
    std::fs::create_dir_all(&updates).unwrap();
    let launcher = std::sync::Arc::new(RecordingLauncher {
        calls: std::sync::Mutex::new(Vec::new()),
        answer,
    });
    let exits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = std::sync::Arc::clone(&exits);
    let state = UpdateState::load(UpdateConfig {
        installed: installed.to_owned(),
        data_dir: data.path().to_path_buf(),
        documents: Some(documents.path().to_path_buf()),
        drives: std::sync::Arc::new(FixedDrives(Vec::new())),
        launcher: launcher.clone(),
        keyset: markiro_proto::trust::update_keyset(),
        exit: std::sync::Arc::new(move |code: i32| recorded.lock().unwrap().push(code)),
    });
    let app = mock_builder()
        .manage(
            DeviceState::load(device.path().to_path_buf()).with_install_role(Some(InstallRole::Host)),
        )
        .manage(LockdownState::default())
        .manage(state)
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    UpdateApp {
        app,
        webview,
        launcher,
        exits,
        data,
        updates,
        _documents: documents,
        _device: device,
    }
}

/// `update_scan` lists `{ path, place, fileName, manifest, problem }`;
/// `update_verify` takes only a path that scan found and answers the report;
/// `update_install` takes the confirmations as codes, writes the mark,
/// starts the installer with `/P /UPDATE /R`, lets kiosk mode's guard go and
/// exits with 0 (spec §10.4).
#[test]
fn update_commands_answer_through_the_ipc_shapes() {
    let update = update_app("0.1.0", Ok(()), |_| {});
    let path = put_package(&update.updates, "0.2.0");
    assert_eq!(
        invoke(&update.webview, "update_verify", json!({ "path": path })),
        Err(json!("invalid_request")),
        "not found by a scan yet"
    );
    let found = invoke(&update.webview, "update_scan", json!({})).unwrap();
    assert_eq!(found.as_array().unwrap().len(), 1);
    assert_eq!(found[0]["path"], json!(path));
    assert_eq!(found[0]["place"], json!("documents"));
    assert_eq!(
        found[0]["fileName"],
        json!("markiro-standalone-0.2.0.update.jws")
    );
    assert_eq!(found[0]["manifest"]["version"], json!("0.2.0"));
    assert_eq!(found[0]["problem"], Value::Null);

    let report = invoke(&update.webview, "update_verify", json!({ "path": path })).unwrap();
    assert_eq!(report["path"], json!(path));
    assert_eq!(report["kid"], json!("test-upd-1"));
    assert_eq!(report["installed"], json!("0.1.0"));
    assert_eq!(report["comparison"], json!("newer"));
    assert_eq!(report["refusal"], Value::Null);
    assert_eq!(report["confirmations"], json!([]));
    assert_eq!(report["host"], Value::Null, "the host's own PC asks no host");
    assert_eq!(
        report["manifest"]["installer"]["name"],
        json!("markiro-standalone-0.2.0-windows-x86_64-setup.exe")
    );
    let installer = update
        .updates
        .join("markiro-standalone-0.2.0-windows-x86_64-setup.exe");
    assert_eq!(
        report["installerPath"],
        json!(installer.to_string_lossy())
    );

    assert_eq!(
        invoke(
            &update.webview,
            "update_install",
            json!({ "path": path, "confirm": ["yes"] })
        ),
        Err(json!("invalid_request")),
        "a confirmation of no known name"
    );
    assert!(update.launcher.calls.lock().unwrap().is_empty());
    // The mock window locks outside Windows only (see tests/lockdown.rs).
    if cfg!(not(windows)) {
        assert_eq!(
            invoke(&update.webview, "enter_lockdown", json!({})),
            Ok(Value::Null)
        );
        assert!(update.app.state::<LockdownState>().is_locked());
    }
    assert_eq!(
        invoke(
            &update.webview,
            "update_install",
            json!({ "path": path, "confirm": [] })
        ),
        Ok(Value::Null)
    );
    assert_eq!(
        *update.launcher.calls.lock().unwrap(),
        vec![(installer, "/P /UPDATE /R".to_owned())]
    );
    assert_eq!(*update.exits.lock().unwrap(), vec![0]);
    assert!(
        !update.app.state::<LockdownState>().is_locked(),
        "the close guard lets the exit through"
    );
    let mark: Value = serde_json::from_slice(
        &std::fs::read(update.data.path().join("update-pending.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(mark["from"], json!("0.1.0"));
    assert_eq!(mark["to"], json!("0.2.0"));
    assert!(mark["startedAtMs"].as_u64().unwrap() > 0);
}

/// A refused administrator prompt keeps the app open and locked and drops
/// the mark; nothing else changed.
#[test]
fn a_refused_administrator_prompt_keeps_the_app_and_drops_the_mark() {
    let update = update_app("0.1.0", Err(LaunchError::Cancelled), |_| {});
    let path = put_package(&update.updates, "0.2.0");
    invoke(&update.webview, "update_scan", json!({})).unwrap();
    if cfg!(not(windows)) {
        invoke(&update.webview, "enter_lockdown", json!({})).unwrap();
    }
    assert_eq!(
        invoke(
            &update.webview,
            "update_install",
            json!({ "path": path, "confirm": [] })
        ),
        Err(json!("uac_cancelled"))
    );
    assert_eq!(update.launcher.calls.lock().unwrap().len(), 1);
    assert!(update.exits.lock().unwrap().is_empty());
    assert_eq!(
        update.app.state::<LockdownState>().is_locked(),
        cfg!(not(windows))
    );
    assert!(!update.data.path().join("update-pending.json").exists());
}

/// The mark of an update that did not finish is reported until it is
/// hidden; the mark of one that did is reported once and is gone at start.
#[test]
fn the_outcome_of_the_last_update_answers_through_the_ipc_shape() {
    let mark = |dir: &std::path::Path| {
        std::fs::write(
            dir.join("update-pending.json"),
            r#"{"from":"0.1.0","to":"0.2.0","startedAtMs":1760000000000}"#,
        )
        .unwrap();
    };
    let unfinished = update_app("0.1.0", Ok(()), mark);
    let expected = json!({ "kind": "not_finished", "from": "0.1.0", "to": "0.2.0", "startedAtMs": 1_760_000_000_000_u64 });
    assert_eq!(
        invoke(&unfinished.webview, "update_outcome", json!({})),
        Ok(expected.clone())
    );
    assert_eq!(
        invoke(&unfinished.webview, "update_outcome", json!({})),
        Ok(expected)
    );
    assert_eq!(
        invoke(&unfinished.webview, "update_outcome_dismiss", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&unfinished.webview, "update_outcome", json!({})),
        Ok(Value::Null)
    );
    assert!(!unfinished.data.path().join("update-pending.json").exists());

    let updated = update_app("0.2.0", Ok(()), mark);
    assert_eq!(
        invoke(&updated.webview, "update_outcome", json!({})),
        Ok(json!({ "kind": "updated", "from": "0.1.0", "to": "0.2.0" }))
    );
    assert!(!updated.data.path().join("update-pending.json").exists());
}
```

Создать `apps/standalone/src-tauri/tests/update.rs`:

```rust
//! Updates from a file (plan ОБН-2) through `UpdateState`'s own methods: the
//! version rules on the host's own PC, a package that does not hold, a
//! removable drive, and the check of the host a station answers to. The
//! last two tests start a real `markiro-host` on 127.0.0.1 or dial a closed
//! port there, so the sandbox must allow a local socket.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::installation::InstallRole;
use markiro_standalone_lib::lockdown::LockdownState;
use markiro_standalone_lib::secret_store;
use markiro_standalone_lib::update::launch::{LaunchError, Launcher};
use markiro_standalone_lib::update::package::{FixedDrives, PlaceKind};
use markiro_standalone_lib::update::rules::Confirmation;
use markiro_standalone_lib::update::{UpdateConfig, UpdateError, UpdateState};
use serde_json::json;
use tauri::async_runtime::block_on;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/update");

fn test_installer(version: &str) -> Vec<u8> {
    format!("markiro test installer {version}\n").into_bytes()
}

fn installer_path(dir: &Path, version: &str) -> PathBuf {
    dir.join(format!("markiro-standalone-{version}-windows-x86_64-setup.exe"))
}

fn put_package(dir: &Path, version: &str) -> String {
    let name = format!("markiro-standalone-{version}.update.jws");
    std::fs::copy(Path::new(FIXTURES).join(&name), dir.join(&name)).unwrap();
    std::fs::write(installer_path(dir, version), test_installer(version)).unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

/// Nothing is ever started in these tests.
struct NoLauncher;

impl Launcher for NoLauncher {
    fn launch(&self, _: &Path, _: &str) -> Result<(), LaunchError> {
        panic!("these tests start nothing")
    }
}

struct Site {
    state: UpdateState,
    updates: PathBuf,
    _dirs: [tempfile::TempDir; 2],
}

fn site(installed: &str, drives: Vec<PathBuf>) -> Site {
    let data = tempfile::tempdir().unwrap();
    let documents = tempfile::tempdir().unwrap();
    let updates = documents.path().join("Markiro").join("Обновления");
    std::fs::create_dir_all(&updates).unwrap();
    let state = UpdateState::load(UpdateConfig {
        installed: installed.to_owned(),
        data_dir: data.path().to_path_buf(),
        documents: Some(documents.path().to_path_buf()),
        drives: Arc::new(FixedDrives(drives)),
        launcher: Arc::new(NoLauncher),
        keyset: markiro_proto::trust::update_keyset(),
        exit: Arc::new(|_: i32| panic!("these tests never exit")),
    });
    Site {
        state,
        updates,
        _dirs: [data, documents],
    }
}

fn host_pc(dir: &Path) -> DeviceState {
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Host))
}

#[test]
fn on_the_hosts_pc_an_older_package_is_refused_and_the_same_one_asks_first() {
    let device_dir = tempfile::tempdir().unwrap();
    let device = host_pc(device_dir.path());
    let lockdown = LockdownState::default();

    let older = site("0.3.0", vec![]);
    let path = put_package(&older.updates, "0.2.0");
    block_on(older.state.scan()).unwrap();
    let report = block_on(older.state.verify(&device, &path)).unwrap();
    assert_eq!(
        serde_json::to_value(&report.refusal).unwrap(),
        json!({ "code": "older", "installed": "0.3.0" })
    );
    assert_eq!(
        block_on(older.state.install(&device, &lockdown, &path, &[])).err(),
        Some(UpdateError::UpdateRefused)
    );

    let same = site("0.2.0", vec![]);
    let path = put_package(&same.updates, "0.2.0");
    block_on(same.state.scan()).unwrap();
    let report = block_on(same.state.verify(&device, &path)).unwrap();
    assert_eq!(report.confirmations, vec![Confirmation::Reinstall]);
    assert_eq!(
        block_on(same.state.install(&device, &lockdown, &path, &[])).err(),
        Some(UpdateError::ConfirmationRequired)
    );

    let skipping = site("0.1.0", vec![]);
    let path = put_package(&skipping.updates, "0.3.0");
    block_on(skipping.state.scan()).unwrap();
    assert_eq!(
        serde_json::to_value(
            &block_on(skipping.state.verify(&device, &path))
                .unwrap()
                .refusal
        )
        .unwrap(),
        json!({ "code": "min_upgrade", "minUpgradeFrom": "0.2.0" })
    );
}

#[test]
fn a_package_that_does_not_hold_is_refused_with_its_reason() {
    let device_dir = tempfile::tempdir().unwrap();
    let device = host_pc(device_dir.path());
    let site = site("0.1.0", vec![]);
    let path = put_package(&site.updates, "0.2.0");
    block_on(site.state.scan()).unwrap();
    std::fs::write(installer_path(&site.updates, "0.2.0"), b"another installer").unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::InstallerMismatch)
    );
    std::fs::remove_file(installer_path(&site.updates, "0.2.0")).unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::InstallerMissing)
    );
    std::fs::copy(
        Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
        &path,
    )
    .unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::ManifestSignature)
    );
    // A path the last scan did not find is no package of this shell.
    let elsewhere = tempfile::tempdir().unwrap();
    let other = put_package(elsewhere.path(), "0.2.0");
    assert_eq!(
        block_on(site.state.verify(&device, &other)).err(),
        Some(UpdateError::InvalidRequest)
    );
}

#[test]
fn a_removable_drive_is_searched_in_its_root_and_markiro_folder() {
    let drive = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(drive.path().join("Markiro")).unwrap();
    put_package(&drive.path().join("Markiro"), "0.2.0");
    let site = site("0.1.0", vec![drive.path().to_path_buf()]);
    let found = block_on(site.state.scan()).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].place, PlaceKind::Removable);
}

/// A real host on its own runtime (as `tests/ipc.rs` starts one).
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

/// A station paired with the host at `address` (no host issued the key).
fn station_paired_at(dir: &Path, address: &str) -> DeviceState {
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: address.into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some("Станция на линии 1".into()),
            device_key: secret_store::protect("device-key-value").unwrap(),
        },
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Station))
}

#[test]
fn a_station_does_not_get_ahead_of_its_hosts_protocol() {
    let host = Host::start();
    let device_dir = tempfile::tempdir().unwrap();
    let device = station_paired_at(device_dir.path(), &host.address());
    let site = site("0.2.0", vec![]);
    let newer = put_package(&site.updates, "0.3.0");
    block_on(site.state.scan()).unwrap();
    let report = block_on(site.state.verify(&device, &newer)).unwrap();
    assert_eq!(
        serde_json::to_value(&report.refusal).unwrap(),
        json!({ "code": "host_first", "hostProtocol": markiro_proto::PROTOCOL_VERSION, "protocol": 4 })
    );
    let seen = report.host.unwrap();
    assert_eq!(seen.protocol, markiro_proto::PROTOCOL_VERSION);
    assert!(seen.version.is_some());
    host.stop();
}

#[test]
fn a_station_whose_host_is_silent_needs_a_confirmation() {
    // A port that was free a moment ago: the connection is refused at once.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("https://{}", listener.local_addr().unwrap())
    };
    let device_dir = tempfile::tempdir().unwrap();
    let device = station_paired_at(device_dir.path(), &closed);
    let lockdown = LockdownState::default();
    let site = site("0.1.0", vec![]);
    let path = put_package(&site.updates, "0.2.0");
    block_on(site.state.scan()).unwrap();
    let report = block_on(site.state.verify(&device, &path)).unwrap();
    assert_eq!(report.confirmations, vec![Confirmation::HostUnreachable]);
    assert_eq!(report.refusal, None);
    assert_eq!(report.host, None);
    assert_eq!(
        block_on(site.state.install(&device, &lockdown, &path, &[])).err(),
        Some(UpdateError::ConfirmationRequired)
    );
}
```

Тест `a_station_does_not_get_ahead_of_its_hosts_protocol` ждёт протокол хоста `3` (протокол фикстуры 0.3.0 — `4`): если к исполнению `PROTOCOL_VERSION` основы уже `4` или выше, отказ `host_first` не наступит — тогда поднять протокол фикстуры 0.3.0 в генераторе задачи 4 до `PROTOCOL_VERSION + 1`, перегенерировать и записать.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --test update
```

(вне песочницы: сокет на 127.0.0.1). Ожидается: FAIL компиляции — `UpdateState`, `UpdateConfig`, `UpdateError` не найдены.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/update/mod.rs` — после строк `pub mod launch; … pub mod rules;` добавить:

```rust

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use markiro_proto::trust::Keyset;
use markiro_proto::update::AppVersion;
use serde::Serialize;
use serde_json::Value;

use crate::device::DeviceState;
use crate::host_probe::{self, HostVersions};
use crate::installation::InstallRole;
use crate::lockdown::{self, LockdownState};
use crate::office_files::{self, OfficeFilesError};
use launch::{LaunchError, Launcher, INSTALLER_ARGUMENTS};
use package::{Checked, FoundPackage, PackageError, RemovableDrives};
use pending::{Pending, UpdateOutcome};
use rules::{Comparison, Confirmation, Decision, HostCheck, Refusal};

/// Why an update command failed: the bare code the webview reads
/// (`src/office/info/update-shell.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    /// A path the last search did not find, or a confirmation of no known name.
    InvalidRequest,
    DocumentsUnavailable,
    Storage,
    /// Not Windows, or this build's version is no `X.Y.Z` (a development build).
    Unsupported,
    ManifestMalformed,
    ManifestUnknownKey,
    ManifestSignature,
    InstallerMissing,
    InstallerMismatch,
    /// The version rules refuse this package (the report says why).
    UpdateRefused,
    /// A warning of the report the person has not confirmed.
    ConfirmationRequired,
    /// Windows' administrator prompt was refused or cancelled.
    UacCancelled,
    LaunchFailed,
}

impl UpdateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::DocumentsUnavailable => "documents_unavailable",
            Self::Storage => "storage",
            Self::Unsupported => "unsupported",
            Self::ManifestMalformed => "manifest_malformed",
            Self::ManifestUnknownKey => "manifest_unknown_key",
            Self::ManifestSignature => "manifest_signature",
            Self::InstallerMissing => "installer_missing",
            Self::InstallerMismatch => "installer_mismatch",
            Self::UpdateRefused => "update_refused",
            Self::ConfirmationRequired => "confirmation_required",
            Self::UacCancelled => "uac_cancelled",
            Self::LaunchFailed => "launch_failed",
        }
    }
}

impl From<PackageError> for UpdateError {
    fn from(error: PackageError) -> Self {
        match error {
            PackageError::ManifestMalformed => Self::ManifestMalformed,
            PackageError::ManifestUnknownKey => Self::ManifestUnknownKey,
            PackageError::ManifestSignature => Self::ManifestSignature,
            PackageError::InstallerMissing => Self::InstallerMissing,
            PackageError::InstallerMismatch => Self::InstallerMismatch,
            PackageError::Storage => Self::Storage,
        }
    }
}

impl From<LaunchError> for UpdateError {
    fn from(error: LaunchError) -> Self {
        match error {
            LaunchError::Cancelled => Self::UacCancelled,
            LaunchError::Failed(_) => Self::LaunchFailed,
            LaunchError::Unsupported => Self::Unsupported,
        }
    }
}

/// What the report of a checked package tells the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedReport {
    pub path: String,
    pub kid: String,
    /// The signed manifest, camelCase, as `@markiro/domain` reads it.
    pub manifest: Value,
    /// This app's version.
    pub installed: String,
    /// The installer's full path, for a manual install and `Get-FileHash`.
    pub installer_path: String,
    pub comparison: Comparison,
    pub refusal: Option<Refusal>,
    pub confirmations: Vec<Confirmation>,
    /// The host this PC answers to, as its `hello` said; `None` on the host's
    /// own PC (not asked) or when it did not answer.
    pub host: Option<HostVersions>,
}

/// What [`UpdateState::load`] is built from; `run` gives the real ones, tests their own.
pub struct UpdateConfig {
    /// This build's version (`tauri.conf.json`, as `getVersion()` reads it).
    pub installed: String,
    /// The app's local data folder, where `update-pending.json` lives.
    pub data_dir: PathBuf,
    /// The system's documents folder, `None` when the user has none.
    pub documents: Option<PathBuf>,
    pub drives: Arc<dyn RemovableDrives>,
    pub launcher: Arc<dyn Launcher>,
    /// The release keys this build trusts (`markiro_proto::trust::update_keyset`).
    pub keyset: Keyset,
    /// Leaves the app (`AppHandle::exit` in `run`).
    pub exit: Arc<dyn Fn(i32) + Send + Sync>,
}

/// The update commands' state: what the last search found (the only paths
/// `update_verify` and `update_install` take) and the outcome the start read.
pub struct UpdateState {
    installed: String,
    data_dir: PathBuf,
    updates_dir: Option<PathBuf>,
    drives: Arc<dyn RemovableDrives>,
    launcher: Arc<dyn Launcher>,
    keyset: Arc<Keyset>,
    exit: Arc<dyn Fn(i32) + Send + Sync>,
    found: Mutex<Vec<PathBuf>>,
    outcome: Mutex<Option<UpdateOutcome>>,
}

/// Runs blocking file work (a search, a 60 MB hash, the launch) off the IPC thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, UpdateError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| UpdateError::Storage)
}

/// The host this PC answers to: none asked on the host's own PC; else the
/// pairing's address, or this computer's host when there is no pairing.
async fn host_check(device: &DeviceState) -> HostCheck {
    if device.install_role() == Some(InstallRole::Host) {
        return HostCheck::NotNeeded;
    }
    let address = match device.status() {
        Ok(Some(status)) => status.host_address,
        _ => crate::local_host_address(),
    };
    match host_probe::host_versions(&address).await {
        Ok(seen) => HostCheck::Seen(seen),
        Err(_) => HostCheck::Silent,
    }
}

impl UpdateState {
    /// The state, with the outcome of the last update read from the data
    /// folder (`pending::take_outcome`).
    pub fn load(config: UpdateConfig) -> Self {
        let outcome = pending::take_outcome(&config.data_dir, &config.installed);
        Self {
            updates_dir: config.documents.map(|documents| {
                documents
                    .join(office_files::APP_FOLDER)
                    .join(office_files::UPDATES_ROOT)
            }),
            installed: config.installed,
            data_dir: config.data_dir,
            drives: config.drives,
            launcher: config.launcher,
            keyset: Arc::new(config.keyset),
            exit: config.exit,
            found: Mutex::new(Vec::new()),
            outcome: Mutex::new(outcome),
        }
    }

    fn installed_version(&self) -> Result<AppVersion, UpdateError> {
        self.installed.parse().map_err(|_| UpdateError::Unsupported)
    }

    fn found_path(&self, path: &str) -> Result<PathBuf, UpdateError> {
        self.found
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|found| found.to_string_lossy() == path)
            .cloned()
            .ok_or(UpdateError::InvalidRequest)
    }

    /// The packages in the updates folder and on removable drives; their
    /// paths become the ones the other commands take.
    pub async fn scan(&self) -> Result<Vec<FoundPackage>, UpdateError> {
        let drives = Arc::clone(&self.drives);
        let updates_dir = self.updates_dir.clone();
        let keyset = Arc::clone(&self.keyset);
        let found = blocking(move || {
            package::scan(
                &package::places(updates_dir.as_deref(), &drives.roots()),
                &keyset,
            )
        })
        .await?;
        *self.found.lock().unwrap_or_else(PoisonError::into_inner) =
            found.iter().map(|package| package.source.clone()).collect();
        Ok(found)
    }

    /// The package at `path` checked whole, and what the rules say of it.
    async fn check(
        &self,
        device: &DeviceState,
        path: &str,
    ) -> Result<(Checked, Decision, HostCheck), UpdateError> {
        let source = self.found_path(path)?;
        let installed = self.installed_version()?;
        let host = host_check(device).await;
        let keyset = Arc::clone(&self.keyset);
        let checked = blocking(move || package::verify(&source, &keyset)).await??;
        let decision = rules::decide(checked.manifest.offered(), &installed, &host);
        Ok((checked, decision, host))
    }

    pub async fn verify(
        &self,
        device: &DeviceState,
        path: &str,
    ) -> Result<VerifiedReport, UpdateError> {
        let (checked, decision, host) = self.check(device, path).await?;
        Ok(VerifiedReport {
            path: path.to_owned(),
            kid: checked.manifest.kid.clone(),
            manifest: serde_json::to_value(&checked.manifest.manifest)
                .map_err(|_| UpdateError::ManifestMalformed)?,
            installed: self.installed.clone(),
            installer_path: checked.installer_path.to_string_lossy().into_owned(),
            comparison: decision.comparison,
            refusal: decision.refusal,
            confirmations: decision.confirmations,
            host: match host {
                HostCheck::Seen(seen) => Some(seen),
                HostCheck::NotNeeded | HostCheck::Silent => None,
            },
        })
    }

    /// Checks the package again, refuses what the rules refuse or what was
    /// not confirmed, writes the mark, starts the installer with the
    /// administrator prompt and leaves the app (spec §10.4 steps 2, 5–7).
    pub async fn install(
        &self,
        device: &DeviceState,
        lockdown: &LockdownState,
        path: &str,
        confirmed: &[Confirmation],
    ) -> Result<(), UpdateError> {
        let (checked, decision, _) = self.check(device, path).await?;
        if decision.refusal.is_some() {
            return Err(UpdateError::UpdateRefused);
        }
        if decision
            .confirmations
            .iter()
            .any(|needed| !confirmed.contains(needed))
        {
            return Err(UpdateError::ConfirmationRequired);
        }
        let mark = Pending {
            from: self.installed.clone(),
            to: checked.manifest.manifest.version.clone(),
            started_at_ms: pending::now_ms(),
        };
        pending::write(&self.data_dir, &mark).map_err(|error| {
            eprintln!(
                "standalone: update_install could not write its mark: {:?}",
                error.kind()
            );
            UpdateError::Storage
        })?;
        let launcher = Arc::clone(&self.launcher);
        // The handle opened for the hash goes along and is held until the
        // app leaves: nothing changes the file between the hash and the start.
        let joined = blocking(move || {
            let launched = launcher.launch(&checked.installer_path, INSTALLER_ARGUMENTS);
            (launched, checked)
        })
        .await;
        let (launched, _held) = match joined {
            Ok(done) => done,
            Err(error) => {
                let _ = pending::remove(&self.data_dir);
                return Err(error);
            }
        };
        match launched {
            Ok(()) => {
                self.exit_for_update(lockdown);
                Ok(())
            }
            Err(error) => {
                if let Err(io) = pending::remove(&self.data_dir) {
                    eprintln!(
                        "standalone: update_install could not drop its mark: {:?}",
                        io.kind()
                    );
                }
                eprintln!(
                    "standalone: update_install: the installer did not start: {}",
                    error.code()
                );
                Err(error.into())
            }
        }
    }

    /// The one way the app leaves for an update: kiosk mode's flag off first
    /// (its close guard would refuse the window's close), then the exit.
    pub fn exit_for_update(&self, lockdown: &LockdownState) {
        lockdown::release_for_exit(lockdown);
        (self.exit)(0);
    }

    pub fn outcome(&self) -> Option<UpdateOutcome> {
        self.outcome
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// «Скрыть»: the mark goes, and the outcome with it.
    pub fn dismiss_outcome(&self) -> Result<(), UpdateError> {
        pending::remove(&self.data_dir).map_err(|error| {
            eprintln!(
                "standalone: update_outcome_dismiss storage: {:?}",
                error.kind()
            );
            UpdateError::Storage
        })?;
        *self.outcome.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }

    /// «Открыть папку»: makes `Документы\Markiro\Обновления` and shows it.
    pub fn open_folder(&self) -> Result<(), UpdateError> {
        let folder = self
            .updates_dir
            .as_ref()
            .ok_or(UpdateError::DocumentsUnavailable)?;
        package::ensure_folder(folder)?;
        office_files::show_folder(folder).map_err(|error| match error {
            OfficeFilesError::InvalidRequest => UpdateError::InvalidRequest,
            OfficeFilesError::DocumentsUnavailable => UpdateError::DocumentsUnavailable,
            OfficeFilesError::Storage => UpdateError::Storage,
            OfficeFilesError::Unsupported => UpdateError::Unsupported,
        })
    }
}

fn code(error: UpdateError) -> String {
    error.code().to_owned()
}

#[tauri::command]
pub async fn update_scan(
    state: tauri::State<'_, UpdateState>,
) -> Result<Vec<FoundPackage>, String> {
    state.scan().await.map_err(code)
}

#[tauri::command]
pub async fn update_verify(
    state: tauri::State<'_, UpdateState>,
    device: tauri::State<'_, DeviceState>,
    path: String,
) -> Result<VerifiedReport, String> {
    state.verify(&device, &path).await.map_err(code)
}

/// `confirm` holds the codes of the report's confirmations the person
/// accepted; an unknown code is `invalid_request` before anything is read.
#[tauri::command]
pub async fn update_install(
    state: tauri::State<'_, UpdateState>,
    device: tauri::State<'_, DeviceState>,
    lockdown: tauri::State<'_, LockdownState>,
    path: String,
    confirm: Vec<String>,
) -> Result<(), String> {
    let confirmed = confirm
        .iter()
        .map(|text| Confirmation::from_code(text))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| code(UpdateError::InvalidRequest))?;
    state
        .install(&device, &lockdown, &path, &confirmed)
        .await
        .map_err(code)
}

#[tauri::command]
pub fn update_outcome(state: tauri::State<'_, UpdateState>) -> Option<UpdateOutcome> {
    state.outcome()
}

#[tauri::command]
pub fn update_outcome_dismiss(state: tauri::State<'_, UpdateState>) -> Result<(), String> {
    state.dismiss_outcome().map_err(code)
}

#[tauri::command]
pub async fn update_open_folder(state: tauri::State<'_, UpdateState>) -> Result<(), String> {
    state.open_folder().map_err(code)
}
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

```rust
/// The host service on this computer.
fn local_host_address() -> String {
```

заменить на:

```rust
/// The host service on this computer.
pub(crate) fn local_host_address() -> String {
```

Фрагмент 2 (`invoke_handler`):

```rust
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file
    ]
```

заменить на:

```rust
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file,
        update::update_scan,
        update::update_verify,
        update::update_install,
        update::update_outcome,
        update::update_outcome_dismiss,
        update::update_open_folder
    ]
```

(`claude/fb-about` добавляет сюда `open_external_link` — оставить.)

Фрагмент 3 (`manage_state`):

```rust
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    link
}
```

заменить на:

```rust
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    let handle = app.clone();
    app.manage(update::UpdateState::load(update::UpdateConfig {
        installed: app.package_info().version.to_string(),
        data_dir: dir.to_path_buf(),
        documents: app.path().document_dir().ok(),
        drives: Arc::new(update::package::SystemDrives),
        launcher: Arc::new(update::launch::SystemLauncher),
        keyset: markiro_proto::trust::update_keyset(),
        exit: Arc::new(move |code| handle.exit(code)),
    }));
    link
}
```

и в doc-комментарии `manage_state` дописать в перечень «… and the office's folder under the documents folder (plan ЧЗ)» — «, and the update state with the outcome of the last update (plan ОБН-2)».

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --test update
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib
```

(вне песочницы). Ожидается: PASS. В `ipc` остальные тесты не меняются.

- [ ] **Step 5: Гейты и коммит**

```bash
git add apps/standalone/src-tauri/src/update/mod.rs apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/ipc.rs apps/standalone/src-tauri/tests/update.rs
git commit -F /tmp/claude/obn2-t7-msg.txt
```

Сообщение:

```text
feat(standalone): the update commands — scan, verify, install, outcome (plan ОБН-2)

update_scan, update_verify and update_install take only paths the shell
found; the install checks the package again, refuses what the version
rules refuse or what was not confirmed, writes update-pending.json, starts
the installer and leaves past the kiosk guard. The IPC contract is pinned
through the mock runtime.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 8: Вебвью — команды оболочки, предупреждения перед запуском, копия хоста, отчёт и запуск

**Files:**

- Create: `apps/standalone/src/office/info/update-shell.ts`, `apps/standalone/src/office/info/update-context.tsx`, `apps/standalone/src/office/info/update-flow.ts`, `apps/standalone/test/update-shell.test.ts`, `apps/standalone/test/update-flow.test.ts`
- Test: `apps/standalone/test/update-shell.test.ts`, `apps/standalone/test/update-flow.test.ts`

**Interfaces:**

- Consumes: IPC задачи 7; `standaloneUpdateManifestV1Schema` (`@markiro/domain`, ЛЦ-1); `HostApi.{startBackup, getBackups, recordUpdateStarted, listDevices, listShifts}`; `updateStarted` (задача 1); `HostError`; `DeviceRecord.protocol` (ОБН-1); `InstallRole`.
- Produces: `UPDATE_SHELL_CODES`, `UpdateShellError`, `PACKAGE_PROBLEMS`, `foundPackageSchema`, `verifiedReportSchema`, `updateOutcomeSchema`, `confirmationSchema`, типы `FoundPackage`, `VerifiedReport`, `UpdateOutcome`, `Confirmation`, `UpdateManifest`, интерфейс `UpdateShell`, `createTauriUpdateShell(call?)`; `TAURI_UPDATE_SHELL`, `UpdateShellProvider`, `useUpdateShell`; `BACKUP_WAIT_MS`, `BACKUP_POLL_MS`, `BackupFailedError`, `BackupTimeoutError`, `InstallWarnings`, `installWarnings`, `BackupDeps`, `awaitFreshBackup`, `UpdatePhase`, `RunDeps`, `runUpdate`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/update-shell.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  UpdateShellError,
  createTauriUpdateShell,
  type FoundPackage,
  type VerifiedReport,
} from "../src/office/info/update-shell.js";

const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";
const PATH = "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0.update.jws";
const MANIFEST: VerifiedReport["manifest"] = {
  v: 1,
  product: "markiro-standalone",
  version: "0.2.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "a".repeat(40),
  installer: { name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe", sha256: SHA, sizeBytes: 29 },
  protocol: 3,
  minProtocol: 1,
  minUpgradeFrom: "0.1.0",
  notes: ["Тестовый выпуск 0.2.0"],
};
const FOUND: FoundPackage = {
  path: PATH,
  place: "documents",
  fileName: "markiro-standalone-0.2.0.update.jws",
  manifest: MANIFEST,
  problem: null,
};
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: MANIFEST,
  installed: "0.1.0",
  installerPath: PATH.replace(".update.jws", "-windows-x86_64-setup.exe"),
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.1.0", protocol: 3, minProtocol: 1 },
};

describe("the update commands of the shell", () => {
  it("send the names the shell takes and read the answers it gives", async () => {
    const answers: Record<string, unknown> = {
      update_scan: [FOUND, { ...FOUND, fileName: "broken.update.jws", manifest: null, problem: "manifest_signature" }],
      update_verify: REPORT,
      update_install: null,
      update_outcome: { kind: "not_finished", from: "0.1.0", to: "0.2.0", startedAtMs: 1760000000000 },
      update_outcome_dismiss: null,
      update_open_folder: null,
    };
    const call = vi.fn(async (command: string) => answers[command]);
    const shell = createTauriUpdateShell(call);
    expect(await shell.scan()).toEqual(answers.update_scan);
    expect(await shell.verify(PATH)).toEqual(REPORT);
    await expect(shell.install(PATH, ["reinstall"])).resolves.toBeUndefined();
    expect(await shell.outcome()).toEqual(answers.update_outcome);
    await shell.dismissOutcome();
    await shell.openFolder();
    expect(call.mock.calls).toEqual([
      ["update_scan", {}],
      ["update_verify", { path: PATH }],
      ["update_install", { path: PATH, confirm: ["reinstall"] }],
      ["update_outcome", {}],
      ["update_outcome_dismiss", {}],
      ["update_open_folder", {}],
    ]);
  });

  it("read no outcome as null, and refuse an answer of another shape", async () => {
    expect(await createTauriUpdateShell(async () => null).outcome()).toBeNull();
    await expect(
      createTauriUpdateShell(async () => [{ ...FOUND, manifest: { ...MANIFEST, extra: true } }]).scan(),
    ).rejects.toThrow();
    await expect(
      createTauriUpdateShell(async () => ({ ...REPORT, refusal: { code: "too_old" } })).verify(PATH),
    ).rejects.toThrow();
  });

  it("turn a bare code into its error, and anything else into unsupported", async () => {
    for (const [rejection, code] of [
      ["uac_cancelled", "uac_cancelled"],
      ["installer_mismatch", "installer_mismatch"],
      ["confirmation_required", "confirmation_required"],
      ["something new", "unsupported"],
      [new Error("no Tauri here"), "unsupported"],
    ] as const) {
      const shell = createTauriUpdateShell(async () => {
        throw rejection;
      });
      const error = await shell.install(PATH, []).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(UpdateShellError);
      expect(error instanceof UpdateShellError ? error.code : null).toBe(code);
    }
  });
});
```

Создать `apps/standalone/test/update-flow.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { HostApi } from "../src/host/api.js";
import type { BackupState } from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import { officeShiftSchema, type DeviceRecord, type OfficeShift } from "../src/host/protocol.js";
import {
  BACKUP_POLL_MS,
  BACKUP_WAIT_MS,
  BackupFailedError,
  BackupTimeoutError,
  awaitFreshBackup,
  installWarnings,
  runUpdate,
  type RunDeps,
  type UpdatePhase,
} from "../src/office/info/update-flow.js";
import type { UpdateShell, VerifiedReport } from "../src/office/info/update-shell.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { DEVICE_ID } from "./support/fixtures.js";

const testModuleUrl = import.meta.url;
const SHIFT: OfficeShift = officeShiftSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/office-shift.json", testModuleUrl), "utf8")),
);
const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

function report(overrides: Partial<VerifiedReport> = {}): VerifiedReport {
  return {
    path: "C:\\Updates\\markiro-standalone-0.2.0.update.jws",
    kid: "test-upd-1",
    manifest: {
      v: 1,
      product: "markiro-standalone",
      version: "0.2.0",
      channel: "stable",
      releasedAt: "2026-11-02T10:00:00Z",
      sourceSha: "a".repeat(40),
      installer: { name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe", sha256: SHA, sizeBytes: 29 },
      protocol: 3,
      minProtocol: 2,
      minUpgradeFrom: "0.1.0",
      notes: ["Тестовый выпуск 0.2.0"],
    },
    installed: "0.1.0",
    installerPath: "C:\\Updates\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
    comparison: "newer",
    refusal: null,
    confirmations: [],
    host: null,
    ...overrides,
  };
}

let devices = 0;

/** A paired device; `protocol` is what plan ОБН-1 records (`null`: never reported). */
function device(name: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  devices += 1;
  return {
    id: `00000000-0000-4000-8000-${String(devices).padStart(12, "0")}`,
    kind: "station",
    name,
    lineId: null,
    appVersion: "0.1.0",
    protocol: 1,
    versionSeenAt: "2026-10-09T14:00:00Z",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt: "2026-10-09T14:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

const RUNNING: BackupState = {
  ...HEALTHY_BACKUPS,
  running: { trigger: "manual", startedAt: "2026-10-09T14:21:00Z" },
};
const DONE: BackupState = {
  ...HEALTHY_BACKUPS,
  local: {
    ...HEALTHY_BACKUPS.local,
    lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok: true, code: null },
  },
};

/** Deps of a run whose clock moves only when it sleeps. */
function deps(api: Partial<RunDeps["api"]>, install = vi.fn<UpdateShell["install"]>(async () => undefined)) {
  let clock = 0;
  const phases: UpdatePhase[] = [];
  const full: RunDeps = {
    call: (operation) => operation("office-session-token"),
    api: {
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => DONE),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
      ...api,
    },
    shell: { install },
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    onPhase: (phase) => phases.push(phase),
  };
  return { deps: full, phases, install };
}

describe("the warnings before an update (spec §9.3, §10.7)", () => {
  it("name, on the host's PC, the devices the new host will not take, and this PC's open shift", () => {
    const warnings = installWarnings({
      report: report(),
      role: "host",
      devices: [
        device("Станция линии 2"),
        device("Станция линии 3", { protocol: 2 }),
        device("Старая станция", { revokedAt: "2026-10-01T10:00:00Z" }),
        device("Не сообщала", { protocol: null }),
        device("Этот ПК", { id: DEVICE_ID }),
      ],
      shifts: [SHIFT],
      thisDeviceId: DEVICE_ID,
    });
    expect(warnings).toEqual({
      hostRole: true,
      incompatibleDevices: ["Станция линии 2"],
      openShift: "OCT26-004",
      reinstall: false,
      hostSilent: false,
    });
  });

  it("name no devices on another PC, no shift of another device, and pass the shell's confirmations on", () => {
    const warnings = installWarnings({
      report: report({ confirmations: ["reinstall", "host_unreachable"] }),
      role: "station",
      devices: [device("Станция линии 2")],
      shifts: [{ ...SHIFT, ownerDeviceId: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21" }, { ...SHIFT, status: "planned" }],
      thisDeviceId: DEVICE_ID,
    });
    expect(warnings).toEqual({
      hostRole: false,
      incompatibleDevices: [],
      openShift: null,
      reinstall: true,
      hostSilent: true,
    });
  });
});

describe("the copy before the host's PC is updated", () => {
  it("asks the host for a copy, waits for it and takes it only when that copy succeeded", async () => {
    const getBackups = vi
      .fn<HostApi["getBackups"]>()
      .mockResolvedValueOnce(RUNNING)
      .mockResolvedValueOnce(DONE);
    const { deps: run } = deps({ getBackups });
    await awaitFreshBackup(run);
    expect(run.api.startBackup).toHaveBeenCalledTimes(1);
    expect(getBackups).toHaveBeenCalledTimes(2);
    expect(run.sleep).toHaveBeenCalledWith(BACKUP_POLL_MS);
  });

  it("fails with the host's reason, and an attempt older than the copy asked for is no copy", async () => {
    const failed: BackupState = {
      ...DONE,
      local: { ...DONE.local, lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok: false, code: "disk_full" } },
    };
    await expect(awaitFreshBackup(deps({ getBackups: async () => failed }).deps)).rejects.toEqual(
      new BackupFailedError("disk_full"),
    );
    // HEALTHY_BACKUPS' last attempt is 14:00, before the copy started at 14:21.
    const error = await awaitFreshBackup(deps({ getBackups: async () => HEALTHY_BACKUPS }).deps).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(error instanceof BackupFailedError ? error.code : "?").toBeNull();
  });

  it("gives up after ten minutes of a copy that does not end", async () => {
    const getBackups = vi.fn<HostApi["getBackups"]>(async () => RUNNING);
    await expect(awaitFreshBackup(deps({ getBackups }).deps)).rejects.toBeInstanceOf(BackupTimeoutError);
    expect(getBackups.mock.calls.length).toBe(BACKUP_WAIT_MS / BACKUP_POLL_MS + 1);
  });

  it("waits for a copy already running, then asks for its own", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "a copy is being made already",
      details: { constraint: "backup_running" },
    });
    const startBackup = vi.fn<HostApi["startBackup"]>().mockRejectedValueOnce(busy).mockResolvedValueOnce(RUNNING);
    const getBackups = vi
      .fn<HostApi["getBackups"]>()
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(DONE);
    await awaitFreshBackup(deps({ startBackup, getBackups }).deps);
    expect(startBackup).toHaveBeenCalledTimes(2);
  });
});

describe("an update the office starts (spec §10.4)", () => {
  it("on a station: reports the start, then lets the shell start the installer", async () => {
    const { deps: run, phases, install } = deps({});
    await runUpdate(run, report(), "station");
    expect(phases).toEqual(["reporting", "launching"]);
    expect(run.api.startBackup).not.toHaveBeenCalled();
    expect(run.api.recordUpdateStarted).toHaveBeenCalledWith("office-session-token", {
      from: "0.1.0",
      to: "0.2.0",
      installerSha256: SHA,
      source: "file",
    });
    expect(install).toHaveBeenCalledWith("C:\\Updates\\markiro-standalone-0.2.0.update.jws", []);
    const recorded = vi.mocked(run.api.recordUpdateStarted).mock.invocationCallOrder[0] ?? 0;
    expect(install.mock.invocationCallOrder[0]).toBeGreaterThan(recorded);
  });

  it("on the host's PC: a fresh copy first; a failed copy stops everything", async () => {
    const { deps: run, phases, install } = deps({});
    await runUpdate(run, report(), "host");
    expect(phases).toEqual(["backup", "reporting", "launching"]);
    expect(install).toHaveBeenCalledTimes(1);

    const failed: BackupState = {
      ...DONE,
      local: { ...DONE.local, lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok: false, code: "write_failed" } },
    };
    const broken = deps({ getBackups: async () => failed });
    await expect(runUpdate(broken.deps, report(), "host")).rejects.toBeInstanceOf(BackupFailedError);
    expect(broken.deps.api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(broken.install).not.toHaveBeenCalled();
  });

  it("goes on without the report only when the person confirmed an update without the host", async () => {
    const silent = new HostError({ kind: "transport", code: "unreachable", message: "no host" });
    const recordUpdateStarted = vi.fn<HostApi["recordUpdateStarted"]>(async () => {
      throw silent;
    });
    const confirmed = deps({ recordUpdateStarted });
    await runUpdate(confirmed.deps, report({ confirmations: ["host_unreachable"] }), "station");
    expect(confirmed.install).toHaveBeenCalledWith(expect.any(String), ["host_unreachable"]);
    const unconfirmed = deps({ recordUpdateStarted });
    await expect(runUpdate(unconfirmed.deps, report(), "station")).rejects.toBe(silent);
    expect(unconfirmed.install).not.toHaveBeenCalled();
  });
});
```

Поля `DeviceRecord` в `device()` — как их назвал ОБН-1 (`protocol`, `versionSeenAt`); другое имя — по смыслу, записать.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-shell.test.ts test/update-flow.test.ts
```

Ожидается: FAIL (модулей `update-shell.ts`, `update-flow.ts` нет).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/update-shell.ts`:

<!-- prettier-ignore -->
```ts
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { standaloneUpdateManifestV1Schema } from "@markiro/domain";

// The shell's update commands (plan ОБН-2, `src-tauri/src/update/mod.rs`).
// The webview names a package only by a path the shell found; the keys, the
// installer's bytes and the launch stay in Rust. Answers are read with the
// schemas below; a refusal is a bare code (`UpdateError::code`), and a
// rejection that is none — no shell at all in a browser or a test — reads as
// `unsupported`.

/** The codes the update commands refuse with. */
export const UPDATE_SHELL_CODES = [
  "invalid_request",
  "documents_unavailable",
  "storage",
  "unsupported",
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "installer_missing",
  "installer_mismatch",
  "update_refused",
  "confirmation_required",
  "uac_cancelled",
  "launch_failed",
] as const;
export type UpdateShellCode = (typeof UPDATE_SHELL_CODES)[number];

export class UpdateShellError extends Error {
  readonly code: UpdateShellCode;

  constructor(code: UpdateShellCode, message: string) {
    super(message);
    this.name = "UpdateShellError";
    this.code = code;
  }
}

/** Why a found package shows no version (`PackageError::code` of a search). */
export const PACKAGE_PROBLEMS = [
  "manifest_malformed",
  "manifest_unknown_key",
  "manifest_signature",
  "storage",
] as const;

/** The signed manifest (spec §10.2), as the domain reads it. */
export const updateManifestSchema = standaloneUpdateManifestV1Schema;
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

/** One package `update_scan` found; the manifest only when its signature verified. */
export const foundPackageSchema = z.object({
  path: z.string().min(1),
  place: z.enum(["documents", "removable"]),
  fileName: z.string().min(1),
  manifest: updateManifestSchema.nullable(),
  problem: z.enum(PACKAGE_PROBLEMS).nullable(),
});
export type FoundPackage = z.infer<typeof foundPackageSchema>;

export const confirmationSchema = z.enum(["reinstall", "host_unreachable"]);
export type Confirmation = z.infer<typeof confirmationSchema>;

export const refusalSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("older"), installed: z.string() }),
  z.object({ code: z.literal("min_upgrade"), minUpgradeFrom: z.string() }),
  z.object({
    code: z.literal("host_first"),
    hostProtocol: z.number().int(),
    protocol: z.number().int(),
  }),
]);
export type Refusal = z.infer<typeof refusalSchema>;

/** `update_verify`: the package checked whole and what the version rules say of it. */
export const verifiedReportSchema = z.object({
  path: z.string().min(1),
  kid: z.string().min(1),
  manifest: updateManifestSchema,
  installed: z.string(),
  installerPath: z.string().min(1),
  comparison: z.enum(["newer", "same", "older"]),
  refusal: refusalSchema.nullable(),
  confirmations: z.array(confirmationSchema),
  host: z
    .object({
      version: z.string().nullable(),
      protocol: z.number().int(),
      minProtocol: z.number().int(),
    })
    .nullable(),
});
export type VerifiedReport = z.infer<typeof verifiedReportSchema>;

/** What the last update came to, as the app's start found it. */
export const updateOutcomeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("updated"), from: z.string(), to: z.string() }),
    z.object({
      kind: z.literal("not_finished"),
      from: z.string(),
      to: z.string(),
      startedAtMs: z.number().int(),
    }),
  ])
  .nullable();
export type UpdateOutcome = z.infer<typeof updateOutcomeSchema>;

/**
 * The update commands as the office calls them. Every member is a
 * function-typed property (`@typescript-eslint/unbound-method`); a test
 * passes its own through `UpdateShellProvider`.
 */
export interface UpdateShell {
  scan: () => Promise<FoundPackage[]>;
  verify: (path: string) => Promise<VerifiedReport>;
  /** Starts the installer; the app leaves, so on success the promise never settles. */
  install: (path: string, confirm: readonly Confirmation[]) => Promise<void>;
  outcome: () => Promise<UpdateOutcome>;
  dismissOutcome: () => Promise<void>;
  openFolder: () => Promise<void>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function createTauriUpdateShell(call: Invoke = invoke): UpdateShell {
  async function run<T>(
    command: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let answer: unknown;
    try {
      answer = await call(command, args);
    } catch (error) {
      const code = UPDATE_SHELL_CODES.find((candidate) => candidate === error) ?? "unsupported";
      throw new UpdateShellError(code, `${command}: ${String(error)}`);
    }
    return schema.parse(answer);
  }
  return {
    scan: () => run("update_scan", {}, z.array(foundPackageSchema)),
    verify: (path) => run("update_verify", { path }, verifiedReportSchema),
    install: async (path, confirm) => {
      await run("update_install", { path, confirm: [...confirm] }, z.null());
    },
    outcome: () => run("update_outcome", {}, updateOutcomeSchema),
    dismissOutcome: async () => {
      await run("update_outcome_dismiss", {}, z.null());
    },
    openFolder: async () => {
      await run("update_open_folder", {}, z.null());
    },
  };
}
```

Создать `apps/standalone/src/office/info/update-context.tsx`:

<!-- prettier-ignore -->
```tsx
import { createContext, useContext, type ReactNode } from "react";

import { createTauriUpdateShell, type UpdateShell } from "./update-shell.js";

/** The shell's update commands; a test passes its own through `UpdateShellProvider`. */
export const TAURI_UPDATE_SHELL: UpdateShell = createTauriUpdateShell();

const UpdateShellContext = createContext<UpdateShell>(TAURI_UPDATE_SHELL);

export function UpdateShellProvider({ value, children }: { value: UpdateShell; children: ReactNode }) {
  return <UpdateShellContext value={value}>{children}</UpdateShellContext>;
}

export function useUpdateShell(): UpdateShell {
  return useContext(UpdateShellContext);
}
```

Создать `apps/standalone/src/office/info/update-flow.ts`:

<!-- prettier-ignore -->
```ts
import type { HostApi } from "../../host/api.js";
import type { BackupState } from "../../host/backups.js";
import { HostError } from "../../host/client.js";
import type { InstallRole } from "../../host/device.js";
import type { DeviceRecord, OfficeShift } from "../../host/protocol.js";
import { updateStarted } from "../../host/requests.js";
import type { UpdateShell, VerifiedReport } from "./update-shell.js";

/** How long the host may take for the copy made before its own PC is updated (spec §10.4 step 3). */
export const BACKUP_WAIT_MS = 10 * 60_000;
/** How often that copy's state is read while it runs. */
export const BACKUP_POLL_MS = 2000;

/** The copy before the update failed; `code` is the host's (`BackupFailure`), `null` when it named none. */
export class BackupFailedError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super(`the copy before the update failed: ${code ?? "no attempt"}`);
    this.name = "BackupFailedError";
    this.code = code;
  }
}

/** The copy before the update did not end within `BACKUP_WAIT_MS`. */
export class BackupTimeoutError extends Error {
  constructor() {
    super("the copy before the update did not end in time");
    this.name = "BackupTimeoutError";
  }
}

/** What the confirmation before the launch says (spec §9.3 item 3, §10.7). */
export interface InstallWarnings {
  /** The host's PC: a copy first, and the host stops for 1-3 minutes. */
  hostRole: boolean;
  /** Paired devices whose protocol the new host no longer takes, by name. */
  incompatibleDevices: string[];
  /** The number of the shift this PC has open, if any. */
  openShift: string | null;
  /** The same version again (the shell asks for `reinstall`). */
  reinstall: boolean;
  /** The host did not answer (the shell asks for `host_unreachable`). */
  hostSilent: boolean;
}

export function installWarnings(input: {
  report: VerifiedReport;
  role: InstallRole | "unknown";
  devices: readonly DeviceRecord[];
  shifts: readonly OfficeShift[];
  thisDeviceId: string | null;
}): InstallWarnings {
  const hostRole = input.role === "host";
  const minProtocol = input.report.manifest.minProtocol;
  return {
    hostRole,
    incompatibleDevices: hostRole
      ? input.devices
          .filter(
            (device) =>
              device.revokedAt === null &&
              device.id !== input.thisDeviceId &&
              typeof device.protocol === "number" &&
              device.protocol < minProtocol,
          )
          .map((device) => device.name)
      : [],
    openShift:
      input.thisDeviceId === null
        ? null
        : (input.shifts.find(
            (shift) => shift.status === "active" && shift.ownerDeviceId === input.thisDeviceId,
          )?.number ?? null),
    reinstall: input.report.confirmations.includes("reinstall"),
    hostSilent: input.report.confirmations.includes("host_unreachable"),
  };
}

export interface BackupDeps {
  call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
  api: Pick<HostApi, "startBackup" | "getBackups">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

async function waitIdle(deps: BackupDeps, deadline: number): Promise<BackupState> {
  for (;;) {
    const state = await deps.call((token) => deps.api.getBackups(token));
    if (state.running === null) return state;
    if (deps.now() >= deadline) throw new BackupTimeoutError();
    await deps.sleep(BACKUP_POLL_MS);
  }
}

function copyRunning(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "backup_running"
  );
}

/**
 * «Сделать копию сейчас» before the host's own PC is updated (spec §10.4
 * step 3): asks the host for a copy (after the one already running, if
 * any), waits up to `BACKUP_WAIT_MS` and resolves only when the local
 * folder's last attempt is that copy and it succeeded.
 */
export async function awaitFreshBackup(deps: BackupDeps): Promise<void> {
  const deadline = deps.now() + BACKUP_WAIT_MS;
  let started: BackupState;
  try {
    started = await deps.call((token) => deps.api.startBackup(token));
  } catch (error) {
    if (!copyRunning(error)) throw error;
    await waitIdle(deps, deadline);
    started = await deps.call((token) => deps.api.startBackup(token));
  }
  const since = started.running === null ? null : Date.parse(started.running.startedAt);
  const settled = started.running === null ? started : await waitIdle(deps, deadline);
  const attempt = settled.local.lastAttempt;
  if (attempt === null || !attempt.ok || (since !== null && Date.parse(attempt.at) < since)) {
    throw new BackupFailedError(attempt !== null && !attempt.ok ? attempt.code : null);
  }
}

export type UpdatePhase = "backup" | "reporting" | "launching";

export interface RunDeps extends BackupDeps {
  api: Pick<HostApi, "startBackup" | "getBackups" | "recordUpdateStarted">;
  shell: Pick<UpdateShell, "install">;
  onPhase: (phase: UpdatePhase) => void;
}

/**
 * The launch of spec §10.4 from the office: on the host's PC a fresh copy
 * first, then the `app.update.start` row, then the shell checks the package
 * again and starts the installer, and the app leaves. A host that does not
 * answer the report stops nothing only when the person confirmed an update
 * without the host (§10.7, ЛО12).
 */
export async function runUpdate(
  deps: RunDeps,
  report: VerifiedReport,
  role: InstallRole | "unknown",
): Promise<void> {
  if (role === "host") {
    deps.onPhase("backup");
    await awaitFreshBackup(deps);
  }
  deps.onPhase("reporting");
  try {
    await deps.call((token) =>
      deps.api.recordUpdateStarted(
        token,
        updateStarted(
          {
            from: report.installed,
            to: report.manifest.version,
            installerSha256: report.manifest.installer.sha256,
          },
          "file",
        ),
      ),
    );
  } catch (error) {
    const withoutHost =
      error instanceof HostError &&
      error.kind === "transport" &&
      report.confirmations.includes("host_unreachable");
    if (!withoutHost) throw error;
  }
  deps.onPhase("launching");
  await deps.shell.install(report.path, report.confirmations);
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-shell.test.ts test/update-flow.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
```

Ожидается: PASS. Если `standaloneUpdateManifestV1Schema` ЛЦ-1 строже или мягче §10.2 (тест «refuse an answer of another shape» ждёт отказ на лишнем поле) — сверить с §10.2 и записать.

- [ ] **Step 5: Гейты и коммит**

```bash
git add apps/standalone/src/office/info/update-shell.ts apps/standalone/src/office/info/update-context.tsx apps/standalone/src/office/info/update-flow.ts apps/standalone/test/update-shell.test.ts apps/standalone/test/update-flow.test.ts
git commit -F /tmp/claude/obn2-t8-msg.txt
```

Сообщение:

```text
feat(standalone): the office's side of an update — shell commands, warnings, a fresh copy, the report (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 9: Раздел «Обновление» на странице «Информация»

**Files:**

- Create: `apps/standalone/src/office/info/UpdateSection.tsx`, `apps/standalone/test/update-section.test.tsx`
- Modify: `apps/standalone/src/office/info/sections.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/about-page.test.tsx`
- Test: `apps/standalone/test/update-section.test.tsx`, `apps/standalone/test/about-page.test.tsx`

**Interfaces:**

- Consumes: `useUpdateShell`, `installWarnings`, `runUpdate`, `BackupFailedError`, `BackupTimeoutError`, `UpdateShellError` (задача 8); `useAboutData` (роль ПК, версия; каркас `claude/fb-about`); `useOfficeSession`, `useThisDeviceId`, `errorMessageKey`, `PageLoading`; `@markiro/ui` — `Alert`, `Badge`, `Button`, `Card`, `ConfirmDialog`, `DefinitionGrid`.
- Produces: `UpdateSection`, `UPDATE_PACKAGES_KEY`, `UPDATE_OUTCOME_KEY`, `updateErrorText`, `refusalText`; запись `{ id: "update", titleKey: "office.about.update.title", roles: BOTH_ROLES, Component: UpdateSection }` в `ABOUT_SECTIONS` сразу после `license`; ключи `office.about.update.*`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/update-section.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../src/host/api.js";
import type { BackupState } from "../src/host/backups.js";
import { officeShiftSchema, type DeviceRecord, type OfficeShift } from "../src/host/protocol.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { UpdateShellProvider } from "../src/office/info/update-context.js";
import { UpdateSection } from "../src/office/info/UpdateSection.js";
import {
  UpdateShellError,
  type FoundPackage,
  type UpdateShell,
  type VerifiedReport,
} from "../src/office/info/update-shell.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { ThisDeviceProvider } from "../src/office/this-device.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { DEVICE_ID, DEVICE_STATUS, SESSION, observation } from "./support/fixtures.js";
import { fakeHostApi, fakeOfficeSession, TECHNOLOGIST, type FakeHostApi } from "./support/office.js";

const testModuleUrl = import.meta.url;
/** An active shift whose owner is `DEVICE_ID`, this PC. */
const SHIFT: OfficeShift = officeShiftSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/office-shift.json", testModuleUrl), "utf8")),
);
const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";
const PATH = "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0.update.jws";
const MANIFEST: VerifiedReport["manifest"] = {
  v: 1,
  product: "markiro-standalone",
  version: "0.2.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "a".repeat(40),
  installer: { name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe", sha256: SHA, sizeBytes: 29 },
  protocol: 3,
  minProtocol: 2,
  minUpgradeFrom: "0.1.0",
  notes: ["Лицензия площадки и страница «Информация»"],
};
const FOUND: FoundPackage = {
  path: PATH,
  place: "documents",
  fileName: "markiro-standalone-0.2.0.update.jws",
  manifest: MANIFEST,
  problem: null,
};
const BROKEN: FoundPackage = {
  path: "E:\\broken.update.jws",
  place: "removable",
  fileName: "broken.update.jws",
  manifest: null,
  problem: "manifest_signature",
};
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: MANIFEST,
  installed: "0.1.0",
  installerPath: "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.1.0", protocol: 3, minProtocol: 1 },
};

type FakeShell = { [K in keyof UpdateShell]: Mock<UpdateShell[K]> };

function fakeShell(overrides: Partial<FakeShell> = {}): FakeShell {
  return {
    scan: vi.fn<UpdateShell["scan"]>(async () => [FOUND, BROKEN]),
    verify: vi.fn<UpdateShell["verify"]>(async () => REPORT),
    install: vi.fn<UpdateShell["install"]>(async () => undefined),
    outcome: vi.fn<UpdateShell["outcome"]>(async () => null),
    dismissOutcome: vi.fn<UpdateShell["dismissOutcome"]>(async () => undefined),
    openFolder: vi.fn<UpdateShell["openFolder"]>(async () => undefined),
    ...overrides,
  };
}

function fakeAbout(role: "host" | "station" | "office"): AboutApi {
  return {
    appVersion: async () => "0.1.0",
    installRole: async () => role,
    pairing: async () => DEVICE_STATUS,
    hello: async () => observation(true),
    system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
    openLink: async () => undefined,
  };
}

function renderUpdate(options: {
  shell?: FakeShell;
  api?: FakeHostApi;
  role?: "host" | "station" | "office";
  technologist?: boolean;
}) {
  const shell = options.shell ?? fakeShell();
  const api =
    options.api ??
    fakeHostApi({
      listShifts: vi.fn<HostApi["listShifts"]>(async () => []),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
  const session = fakeOfficeSession(options.technologist === true ? { api, user: TECHNOLOGIST } : { api });
  render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <ThisDeviceProvider deviceId={DEVICE_ID}>
            <AboutProvider value={fakeAbout(options.role ?? "station")}>
              <UpdateShellProvider value={shell}>
                <UpdateSection />
              </UpdateShellProvider>
            </AboutProvider>
          </ThisDeviceProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { shell, api };
}

const RUNNING: BackupState = { ...HEALTHY_BACKUPS, running: { trigger: "manual", startedAt: "2026-10-09T14:21:00Z" } };
function copied(ok: boolean, code: string | null = null): BackupState {
  return {
    ...HEALTHY_BACKUPS,
    local: { ...HEALTHY_BACKUPS.local, lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok, code } },
  };
}

async function checkAndOpenTheDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
  await screen.findByText("Подпись проверена: выпуск Маркиро.");
  fireEvent.click(screen.getByRole("button", { name: "Установить обновление" }));
  return screen.findByRole("dialog");
}

describe("«Обновление»", () => {
  it("shows a technologist this PC's version and who installs, and searches nothing", async () => {
    const { shell } = renderUpdate({ technologist: true });
    await screen.findByText("Обновление устанавливает администратор.");
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Искать снова" })).toBeNull();
    expect(shell.scan).not.toHaveBeenCalled();
  });

  it("lists what an administrator's search found: a version for a signed package, a reason for another", async () => {
    const { shell } = renderUpdate({});
    const list = await screen.findByRole("list", { name: "Найденные пакеты обновления" });
    expect(within(list).getByText("markiro-standalone-0.2.0.update.jws")).toBeTruthy();
    expect(within(list).getByText("0.2.0 — установщик не проверен")).toBeTruthy();
    expect(
      within(list).getByText("Подпись пакета не сходится: файл изменён после выпуска. Запросите пакет заново."),
    ).toBeTruthy();
    expect(screen.getByText(/Документы\\Markiro\\Обновления/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Искать снова" }));
    await waitFor(() => expect(shell.scan).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Открыть папку" }));
    await waitFor(() => expect(shell.openFolder).toHaveBeenCalledTimes(1));
  });

  it("tells what a checked package is, and on a station reports the start before the shell starts it", async () => {
    const { shell, api } = renderUpdate({ role: "station" });
    const dialog = await checkAndOpenTheDialog();
    expect(shell.verify).toHaveBeenCalledWith(PATH);
    expect(screen.getByText("0.2.0 (сейчас 0.1.0)")).toBeTruthy();
    expect(screen.getByText("02.11.2026")).toBeTruthy();
    expect(screen.getByText("Лицензия площадки и страница «Информация»")).toBeTruthy();
    expect(within(dialog).getByText("Установить версию 0.2.0?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Окно программы закроется на 1–3 минуты; Windows спросит права администратора. После установки программа откроется снова.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText("Запуск установщика. Программа закроется.");
    expect(api.recordUpdateStarted).toHaveBeenCalledWith(SESSION.token, {
      from: "0.1.0",
      to: "0.2.0",
      installerSha256: SHA,
      source: "file",
    });
    expect(shell.install).toHaveBeenCalledWith(PATH, []);
    expect(shell.install.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.recordUpdateStarted.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(api.startBackup).not.toHaveBeenCalled();
    expect(api.listDevices).not.toHaveBeenCalled();
  });

  it("on the host's PC names the devices that will not connect and this PC's open shift, and copies first", async () => {
    const station = (name: string, protocol: number | null, revokedAt: string | null = null): DeviceRecord => ({
      id: name === "Станция линии 2" ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000003",
      kind: "station",
      name,
      lineId: null,
      appVersion: "0.1.0",
      protocol,
      versionSeenAt: null,
      pairedAt: "2026-09-26T09:15:00Z",
      lastSeenAt: null,
      revokedAt,
    });
    const api = fakeHostApi({
      listDevices: vi.fn<HostApi["listDevices"]>(async () => [
        station("Станция линии 2", 1),
        station("Списанная станция", 1, "2026-10-01T10:00:00Z"),
      ]),
      listShifts: vi.fn<HostApi["listShifts"]>(async () => [SHIFT]),
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => copied(true)),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
    const { shell } = renderUpdate({ role: "host", api });
    const dialog = await checkAndOpenTheDialog();
    expect(
      within(dialog).getByText(
        "После обновления хоста эти устройства не подключатся, пока их не обновят: Станция линии 2.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("На этом ПК открыта смена OCT26-004: программа закроется на 1–3 минуты, смена продолжится после."),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Это ПК хоста: перед установкой хост сделает резервную копию/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await waitFor(() => expect(shell.install).toHaveBeenCalledWith(PATH, []));
    expect(api.startBackup.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      api.recordUpdateStarted.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops at a failed copy with its reason and starts nothing", async () => {
    const api = fakeHostApi({
      listDevices: vi.fn<HostApi["listDevices"]>(async () => []),
      listShifts: vi.fn<HostApi["listShifts"]>(async () => []),
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => copied(false, "disk_full")),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
    const { shell } = renderUpdate({ role: "host", api });
    const dialog = await checkAndOpenTheDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText(
      "Резервная копия не получилась (disk_full): обновление не запущено. Проверьте «Резервные копии».",
    );
    expect(api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
  });

  it("says why a package is refused and offers no install", async () => {
    renderUpdate({
      shell: fakeShell({
        verify: vi.fn<UpdateShell["verify"]>(async () => ({
          ...REPORT,
          installed: "0.3.0",
          comparison: "older",
          refusal: { code: "older", installed: "0.3.0" },
        })),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Эта версия старее установленной (0.3.0): понижать версию нельзя.");
    expect(screen.getByRole("button", { name: "Установить обновление" })).toHaveProperty("disabled", true);
  });

  it("passes a confirmed reinstall on, and says so when Windows refused the rights", async () => {
    const shell = fakeShell({
      verify: vi.fn<UpdateShell["verify"]>(async () => ({
        ...REPORT,
        installed: "0.2.0",
        comparison: "same",
        confirmations: ["reinstall"],
      })),
      install: vi.fn<UpdateShell["install"]>(async () => {
        throw new UpdateShellError("uac_cancelled", "update_install: uac_cancelled");
      }),
    });
    renderUpdate({ shell });
    const dialog = await checkAndOpenTheDialog();
    expect(within(dialog).getByText("Переустановить версию 0.2.0?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText("Обновление не запущено: Windows не дала прав администратора.");
    expect(shell.install).toHaveBeenCalledWith(PATH, ["reinstall"]);
  });

  it("reports an update that did not finish until it is hidden", async () => {
    const outcome = vi
      .fn<UpdateShell["outcome"]>()
      .mockResolvedValueOnce({ kind: "not_finished", from: "0.1.0", to: "0.2.0", startedAtMs: 1760000000000 })
      .mockResolvedValue(null);
    const shell = fakeShell({ outcome });
    renderUpdate({ shell });
    const text =
      "Обновление до версии 0.2.0 не завершилось: установлена версия 0.1.0. Найдите пакет и запустите установку снова.";
    await screen.findByText(text);
    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(shell.dismissOutcome).toHaveBeenCalledTimes(1);
  });
});
```

Смена теста хоста — `proto/fixtures/office-shift.json` (активная, `ownerDeviceId` = `DEVICE_ID`). Поля `DeviceRecord` в `station()` — как их назвал ОБН-1.

Правка `apps/standalone/test/about-page.test.tsx` (тест «has a table of contents…»):

Фрагмент:

<!-- prettier-ignore -->
```ts
    expect(links.map((link) => link.textContent)).toEqual([
      "О программе",
      "Лицензия",
      "Контакты и поддержка",
      "Сведения для поддержки",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#program",
      "#license",
      "#contacts",
      "#support",
    ]);
    for (const id of ["program", "license", "contacts", "support"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(ABOUT_SECTIONS.map((section) => section.id)).toEqual([
      "program",
      "license",
      "contacts",
      "support",
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
    expect(links.map((link) => link.textContent)).toEqual([
      "О программе",
      "Лицензия",
      "Обновление",
      "Контакты и поддержка",
      "Сведения для поддержки",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#program",
      "#license",
      "#update",
      "#contacts",
      "#support",
    ]);
    for (const id of ["program", "license", "update", "contacts", "support"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(ABOUT_SECTIONS.map((section) => section.id)).toEqual([
      "program",
      "license",
      "update",
      "contacts",
      "support",
    ]);
    // «Обновление» comes right after «Лицензия» for both roles (spec §9.1).
    const update = ABOUT_SECTIONS.find((section) => section.id === "update");
    expect(update?.titleKey).toBe("office.about.update.title");
    expect(update?.roles).toEqual(["admin", "technologist"]);
```

(ЛЦ-3 мог изменить название раздела «Лицензия» в этом тесте — оставить его правку.) Тест «is a page of the office's «Сервис» for both roles, and works without the shell» не меняется: без Tauri раздел «Обновление» показывает «Поиск пакетов обновления на этом компьютере недоступен.» и страница стоит.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-section.test.tsx test/about-page.test.tsx
```

Ожидается: FAIL (`UpdateSection.tsx` нет; оглавление без «Обновление»).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/UpdateSection.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DefinitionGrid,
  type DefinitionGridItem,
} from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import { useOfficeSession } from "../office-session.js";
import { PageLoading } from "../page-state.js";
import { useThisDeviceId } from "../this-device.js";
import { useAboutData } from "./about-data.js";
import { useUpdateShell } from "./update-context.js";
import {
  BackupFailedError,
  BackupTimeoutError,
  installWarnings,
  runUpdate,
  type InstallWarnings,
  type UpdatePhase,
} from "./update-flow.js";
import {
  UpdateShellError,
  type FoundPackage,
  type UpdateOutcome,
  type VerifiedReport,
} from "./update-shell.js";

export const UPDATE_PACKAGES_KEY = ["office", "about", "update", "packages"] as const;
export const UPDATE_OUTCOME_KEY = ["office", "about", "update", "outcome"] as const;

const RELEASE_DATE = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** The text of a failed search, check or launch. */
export function updateErrorText(t: TFunction, error: unknown): string {
  if (error instanceof UpdateShellError) return t(`office.about.update.error.${error.code}`);
  if (error instanceof BackupFailedError) {
    return t("office.about.update.error.backup_failed", { code: error.code ?? "—" });
  }
  if (error instanceof BackupTimeoutError) return t("office.about.update.error.backup_timeout");
  return t(errorMessageKey(error));
}

/** Why the report refuses the package, in words; `null` when it does not. */
export function refusalText(t: TFunction, report: VerifiedReport): string | null {
  const refusal = report.refusal;
  if (refusal === null) return null;
  switch (refusal.code) {
    case "older":
      return t("office.about.update.refusal.older", { installed: refusal.installed });
    case "min_upgrade":
      return t("office.about.update.refusal.min_upgrade", { version: refusal.minUpgradeFrom });
    case "host_first":
      return t("office.about.update.refusal.host_first", {
        protocol: refusal.protocol,
        host: refusal.hostProtocol,
      });
  }
}

/**
 * «Обновление» (spec §9.3, the part «Из файла»): this PC's version, what the
 * last update came to and, for an administrator, the packages found on this
 * PC — checked, then installed with Windows' administrator prompt.
 */
export function UpdateSection() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const about = useAboutData();
  const shell = useUpdateShell();
  const outcome = useQuery({ queryKey: UPDATE_OUTCOME_KEY, queryFn: () => shell.outcome() });
  const items: DefinitionGridItem[] = [
    {
      id: "thisVersion",
      term: t("office.about.update.thisVersion"),
      description: about.data?.appVersion ?? t("office.about.report.unknown"),
      mono: true,
    },
  ];
  return (
    <Card title={t("office.about.update.title")} titleAs="h2">
      <DefinitionGrid items={items} />
      {outcome.data ? (
        <OutcomeAlert outcome={outcome.data} onHidden={() => void outcome.refetch()} />
      ) : null}
      {user.role === "admin" ? (
        <UpdateFromFile />
      ) : (
        <p className="office-note">{t("office.about.update.adminOnly")}</p>
      )}
    </Card>
  );
}

function OutcomeAlert({
  outcome,
  onHidden,
}: {
  outcome: NonNullable<UpdateOutcome>;
  onHidden: () => void;
}) {
  const { t } = useTranslation();
  const shell = useUpdateShell();
  const [failed, setFailed] = useState(false);
  const hide = async () => {
    try {
      await shell.dismissOutcome();
      onHidden();
    } catch {
      setFailed(true);
    }
  };
  const updated = outcome.kind === "updated";
  return (
    <Alert
      tone={updated ? "ok" : "warn"}
      action={
        <Button variant="secondary" size="compact" onClick={() => void hide()}>
          {t("office.about.update.outcome.dismiss")}
        </Button>
      }
    >
      {updated
        ? t("office.about.update.outcome.updated", { to: outcome.to })
        : t("office.about.update.outcome.notFinished", { from: outcome.from, to: outcome.to })}
      {failed ? ` ${t("office.about.update.error.storage")}` : null}
    </Alert>
  );
}

function UpdateFromFile() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const about = useAboutData();
  const thisDeviceId = useThisDeviceId();
  const shell = useUpdateShell();
  const packages = useQuery({ queryKey: UPDATE_PACKAGES_KEY, queryFn: () => shell.scan() });
  const [checking, setChecking] = useState<string | null>(null);
  const [report, setReport] = useState<VerifiedReport | null>(null);
  const [warnings, setWarnings] = useState<InstallWarnings | null>(null);
  const [phase, setPhase] = useState<UpdatePhase | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const role = about.data?.role ?? "unknown";

  const check = async (found: FoundPackage) => {
    setChecking(found.path);
    setReport(null);
    setFailure(null);
    try {
      setReport(await shell.verify(found.path));
    } catch (error) {
      setFailure(error);
    } finally {
      setChecking(null);
    }
  };

  const prepare = async (checked: VerifiedReport) => {
    setFailure(null);
    try {
      const [devices, shifts] = await Promise.all([
        role === "host" ? session.call((token) => session.api.listDevices(token)) : Promise.resolve([]),
        // Without the host there is no list: no shift to name, the shell's own warning says the rest.
        session.call((token) => session.api.listShifts(token)).catch(() => []),
      ]);
      setWarnings(installWarnings({ report: checked, role, devices, shifts, thisDeviceId }));
    } catch (error) {
      setFailure(error);
    }
  };

  const install = async (checked: VerifiedReport) => {
    setWarnings(null);
    setFailure(null);
    try {
      await runUpdate(
        {
          call: session.call,
          api: session.api,
          shell,
          now: () => Date.now(),
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            }),
          onPhase: setPhase,
        },
        checked,
        role,
      );
    } catch (error) {
      setFailure(error);
      setPhase(null);
    }
  };

  const openFolder = async () => {
    setFailure(null);
    try {
      await shell.openFolder();
    } catch (error) {
      setFailure(error);
    }
  };

  const busy = checking !== null || phase !== null;
  return (
    <section aria-labelledby="update-from-file">
      <h3 id="update-from-file">{t("office.about.update.fromFile")}</h3>
      <p className="office-note">{t("office.about.update.hint")}</p>
      <div>
        <Button
          variant="secondary"
          loading={packages.isFetching}
          disabled={busy}
          onClick={() => void packages.refetch()}
        >
          {t("office.about.update.search")}
        </Button>{" "}
        <Button variant="secondary" onClick={() => void openFolder()}>
          {t("office.about.update.openFolder")}
        </Button>
      </div>
      {packages.isPending ? (
        <PageLoading />
      ) : packages.isError ? (
        <Alert tone={packages.error instanceof UpdateShellError && packages.error.code === "unsupported" ? "info" : "error"}>
          {packages.error instanceof UpdateShellError && packages.error.code === "unsupported"
            ? t("office.about.update.unavailable")
            : updateErrorText(t, packages.error)}
        </Alert>
      ) : packages.data.length === 0 ? (
        <p className="office-note">{t("office.about.update.none")}</p>
      ) : (
        <ul aria-label={t("office.about.update.found")}>
          {packages.data.map((found) => (
            <li key={found.path}>
              <span>{found.fileName}</span>{" "}
              <span>
                (
                {found.place === "documents"
                  ? t("office.about.update.placeDocuments")
                  : t("office.about.update.placeRemovable")}
                )
              </span>{" "}
              {found.manifest === null ? (
                <span>{t(`office.about.update.problem.${found.problem ?? "manifest_malformed"}`)}</span>
              ) : (
                <>
                  <span>{t("office.about.update.notChecked", { version: found.manifest.version })}</span>{" "}
                  {found.manifest.channel === "beta" ? (
                    <Badge tone="warn">{t("office.about.update.beta")}</Badge>
                  ) : null}{" "}
                  <Button
                    size="compact"
                    variant="secondary"
                    loading={checking === found.path}
                    disabled={busy}
                    onClick={() => void check(found)}
                  >
                    {t("office.about.update.check")}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {report !== null ? (
        <ReportCard report={report} busy={busy} onInstall={() => void prepare(report)} />
      ) : null}
      {failure !== null ? <Alert tone="error">{updateErrorText(t, failure)}</Alert> : null}
      <p role="status" aria-live="polite">
        {checking !== null
          ? t("office.about.update.checking")
          : phase !== null
            ? t(`office.about.update.phase.${phase}`)
            : ""}
      </p>
      {report !== null && warnings !== null ? (
        <ConfirmDialog
          open
          title={t(
            warnings.reinstall
              ? "office.about.update.confirm.reinstallTitle"
              : "office.about.update.confirm.title",
            { version: report.manifest.version },
          )}
          description={<WarningList warnings={warnings} />}
          confirmLabel={t("office.about.update.confirm.go")}
          cancelLabel={t("office.about.update.confirm.cancel")}
          onConfirm={() => void install(report)}
          onCancel={() => setWarnings(null)}
        />
      ) : null}
    </section>
  );
}

function ReportCard({
  report,
  busy,
  onInstall,
}: {
  report: VerifiedReport;
  busy: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const refusal = refusalText(t, report);
  const facts: DefinitionGridItem[] = [
    {
      id: "version",
      term: t("office.about.update.versionTerm"),
      description: t("office.about.update.version", {
        version: report.manifest.version,
        installed: report.installed,
      }),
      mono: true,
    },
    {
      id: "releasedAt",
      term: t("office.about.update.releasedAt"),
      description: RELEASE_DATE.format(new Date(report.manifest.releasedAt)),
    },
  ];
  return (
    <div>
      <Alert tone="ok">{t("office.about.update.signed")}</Alert>
      {report.manifest.channel === "beta" ? (
        <Badge tone="warn">{t("office.about.update.beta")}</Badge>
      ) : null}
      <DefinitionGrid items={facts} />
      <h4>{t("office.about.update.notes")}</h4>
      <ul>
        {report.manifest.notes.map((note, index) => (
          <li key={`${index}:${note}`}>{note}</li>
        ))}
      </ul>
      {refusal === null ? null : <Alert tone="error">{refusal}</Alert>}
      <Button variant="primary" disabled={refusal !== null || busy} onClick={onInstall}>
        {t("office.about.update.install")}
      </Button>
      <details>
        <summary>{t("office.about.update.manual")}</summary>
        <p className="office-note">{t("office.about.update.manualHint")}</p>
        <DefinitionGrid
          items={[
            {
              id: "installerPath",
              term: t("office.about.update.installerPath"),
              description: report.installerPath,
              mono: true,
            },
            {
              id: "installerSha256",
              term: t("office.about.update.installerSha256"),
              description: report.manifest.installer.sha256,
              mono: true,
            },
          ]}
        />
      </details>
    </div>
  );
}

function WarningList({ warnings }: { warnings: InstallWarnings }) {
  const { t } = useTranslation();
  const lines = [t("office.about.update.confirm.window")];
  if (warnings.hostRole) lines.push(t("office.about.update.confirm.hostRole"));
  if (warnings.incompatibleDevices.length > 0) {
    lines.push(
      t("office.about.update.confirm.devices", { names: warnings.incompatibleDevices.join(", ") }),
    );
  }
  if (warnings.openShift !== null) {
    lines.push(t("office.about.update.confirm.openShift", { number: warnings.openShift }));
  }
  if (warnings.hostSilent) lines.push(t("office.about.update.confirm.hostSilent"));
  if (warnings.reinstall) lines.push(t("office.about.update.confirm.reinstall"));
  return (
    <ul>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
```

Правка `apps/standalone/src/office/info/sections.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { SupportSection } from "./SupportSection.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { SupportSection } from "./SupportSection.js";
import { UpdateSection } from "./UpdateSection.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  {
    id: "license",
    titleKey: "office.about.license.title",
    roles: BOTH_ROLES,
    Component: LicenseSection,
  },
```

заменить на:

<!-- prettier-ignore -->
```tsx
  {
    id: "license",
    titleKey: "office.about.license.title",
    roles: BOTH_ROLES,
    Component: LicenseSection,
  },
  {
    id: "update",
    titleKey: "office.about.update.title",
    roles: BOTH_ROLES,
    Component: UpdateSection,
  },
```

Правка `apps/standalone/src/i18n/ru.json` — в объект `office.about` после ключа `"license": { … }` добавить:

```json
"update": {
  "title": "Обновление",
  "thisVersion": "Версия этого ПК",
  "adminOnly": "Обновление устанавливает администратор.",
  "fromFile": "Обновление из файла",
  "hint": "Положите оба файла пакета — установщик (.exe) и подписанный манифест (.update.jws) — в папку Документы\\Markiro\\Обновления этого ПК или на флешку: в её корень или в папку Markiro.",
  "search": "Искать снова",
  "openFolder": "Открыть папку",
  "found": "Найденные пакеты обновления",
  "none": "Пакетов обновления не найдено.",
  "unavailable": "Поиск пакетов обновления на этом компьютере недоступен.",
  "placeDocuments": "папка «Обновления»",
  "placeRemovable": "съёмный диск",
  "notChecked": "{{version}} — установщик не проверен",
  "beta": "Бета-версия",
  "check": "Проверить",
  "checking": "Проверка подписи и установщика…",
  "signed": "Подпись проверена: выпуск Маркиро.",
  "versionTerm": "Версия",
  "version": "{{version}} (сейчас {{installed}})",
  "releasedAt": "Дата выпуска",
  "notes": "Что нового",
  "install": "Установить обновление",
  "manual": "Установить вручную",
  "manualHint": "Если запуск из программы не удался, запустите установщик сами, сначала сверив его SHA-256 в PowerShell: Get-FileHash <путь к установщику>.",
  "installerPath": "Установщик",
  "installerSha256": "SHA-256",
  "problem": {
    "manifest_malformed": "Это не пакет обновления Маркиро или файл повреждён.",
    "manifest_unknown_key": "Пакет подписан ключом, который эта версия не знает. Запросите пакет у Маркиро заново.",
    "manifest_signature": "Подпись пакета не сходится: файл изменён после выпуска. Запросите пакет заново.",
    "storage": "Файл пакета не читается: проверьте флешку и права на папку."
  },
  "refusal": {
    "older": "Эта версия старее установленной ({{installed}}): понижать версию нельзя.",
    "min_upgrade": "Сначала установите версию {{version}}: с версии этого ПК на эту обновиться напрямую нельзя.",
    "host_first": "Сначала обновите хост площадки: эта версия работает с протоколом {{protocol}}, а хост — с протоколом {{host}}."
  },
  "error": {
    "invalid_request": "Пакета больше нет в списке найденных. Нажмите «Искать снова».",
    "documents_unavailable": "У этого пользователя Windows нет папки «Документы».",
    "storage": "Не удалось прочитать файлы пакета или записать отметку обновления: проверьте флешку, место на диске и права на папку.",
    "unsupported": "Запустить установщик из программы можно только на Windows.",
    "manifest_malformed": "Это не пакет обновления Маркиро или файл повреждён.",
    "manifest_unknown_key": "Пакет подписан ключом, который эта версия не знает. Запросите пакет у Маркиро заново.",
    "manifest_signature": "Подпись пакета не сходится: файл изменён после выпуска. Запросите пакет заново.",
    "installer_missing": "Рядом с манифестом нет установщика. Скопируйте оба файла пакета в одну папку.",
    "installer_mismatch": "Установщик не совпадает с манифестом (размер или SHA-256): файл повреждён или подменён. Скопируйте пакет заново.",
    "update_refused": "Этот пакет нельзя установить на этот ПК: причина указана выше.",
    "confirmation_required": "Подтвердите предупреждения и запустите установку снова.",
    "uac_cancelled": "Обновление не запущено: Windows не дала прав администратора.",
    "launch_failed": "Windows не запустила установщик. Запустите его вручную (ниже).",
    "backup_failed": "Резервная копия не получилась ({{code}}): обновление не запущено. Проверьте «Резервные копии».",
    "backup_timeout": "Резервная копия не закончилась за 10 минут: обновление не запущено."
  },
  "confirm": {
    "title": "Установить версию {{version}}?",
    "reinstallTitle": "Переустановить версию {{version}}?",
    "window": "Окно программы закроется на 1–3 минуты; Windows спросит права администратора. После установки программа откроется снова.",
    "hostRole": "Это ПК хоста: перед установкой хост сделает резервную копию, на время установки служба хоста остановится. Станции на других ПК продолжат работу и дошлют записи.",
    "devices": "После обновления хоста эти устройства не подключатся, пока их не обновят: {{names}}.",
    "openShift": "На этом ПК открыта смена {{number}}: программа закроется на 1–3 минуты, смена продолжится после.",
    "hostSilent": "Хост не отвечает: обновление этого ПК без хоста может оставить его несовместимым с хостом.",
    "reinstall": "Эта версия уже установлена: установщик заменит файлы программы той же версией.",
    "go": "Установить",
    "cancel": "Отмена"
  },
  "phase": {
    "backup": "Хост делает резервную копию…",
    "reporting": "Запись в журнал хоста…",
    "launching": "Запуск установщика. Программа закроется."
  },
  "outcome": {
    "updated": "Программа обновлена до версии {{to}}.",
    "notFinished": "Обновление до версии {{to}} не завершилось: установлена версия {{from}}. Найдите пакет и запустите установку снова.",
    "dismiss": "Скрыть"
  }
}
```

(Отступы — по файлу; prettier выровняет.)

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/update-section.test.tsx test/about-page.test.tsx --reporter=verbose
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
```

Ожидается: PASS, без строк `stderr |` в выводе verbose (предупреждения `act` и необработанные отклонения — дефект теста, не шум). Если тест оглавления ЛЦ-3 уже правил — свести обе правки.

- [ ] **Step 5: Гейты и коммит**

```bash
git add apps/standalone/src/office/info/UpdateSection.tsx apps/standalone/src/office/info/sections.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/update-section.test.tsx apps/standalone/test/about-page.test.tsx
git commit -F /tmp/claude/obn2-t9-msg.txt
```

Сообщение:

```text
feat(standalone): «Обновление» on the office's «Информация» — packages, check, install (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 10: Установщик — обновление без вопросов о сети; `smoke.ps1` проверяет пассивное обновление

**Files:**

- Modify: `apps/standalone/src-tauri/windows/installer-hooks.nsh`, `tools/standalone-release/smoke.ps1`
- Test: `tools/standalone-release/test/installer.test.mjs`, `tools/standalone-release/test/workflow.test.mjs`

**Interfaces:**

- Consumes: ключи шаблона Tauri NSIS `/P`, `/UPDATE` (Д3).
- Produces: хук `NSIS_HOOK_POSTINSTALL` не задаёт вопрос «Перевести сеть в частную?» при `$UpdateMode = 1` (обновление, запущенное программой, не останавливается на вопросе первой установки; проверка сети и строка журнала остаются); шаг `smoke.ps1` «an update the app starts (/P /UPDATE) keeps the role, the host and its data».

- [ ] **Step 1: Написать падающие тесты**

Правка `tools/standalone-release/test/installer.test.mjs` — в конец файла добавить:

<!-- prettier-ignore -->
```js
test("an update the app starts asks nothing: the network question belongs to the first installation", () => {
  // `/P /UPDATE` (plan ОБН-2) is passive, not silent: a question would wait
  // for a click while the app that started the update has already left.
  const postinstall = macro("NSIS_HOOK_POSTINSTALL");
  const question = postinstall.slice(
    postinstall.indexOf('${If} $0 == "3"'),
    postinstall.indexOf("markiro_keep_profile:"),
  );
  assert.match(question, /\$\{IfNot\} \$\{Silent\}\n\s+\$\{AndIf\} \$UpdateMode <> 1\n\s+MessageBox MB_YESNO/);
  // The check itself still runs and is logged on every installation.
  assert.match(postinstall, /"\$INSTDIR\\markiro-host\.exe" network-check'\n\s+Pop \$0/);
  assert.match(question, /DetailPrint "Сеть отнесена к общедоступным/);
});
```

Правка `tools/standalone-release/test/workflow.test.mjs`:

Фрагмент 1 (тест «the smoke test checks what the installer promises»):

<!-- prettier-ignore -->
```js
    "Install @('/S')",
```

заменить на:

<!-- prettier-ignore -->
```js
    "Install @('/S')",
    "Install @('/P', '/UPDATE')",
```

Фрагмент 2 (тест «the smoke test follows the installer's life in order…»):

<!-- prettier-ignore -->
```js
    "a reinstall keeps the role and the host",
```

заменить на:

<!-- prettier-ignore -->
```js
    "a reinstall keeps the role and the host",
    "an update the app starts (/P /UPDATE) keeps the role, the host and its data",
```

В конец файла добавить:

<!-- prettier-ignore -->
```js
test("the passive update the app starts keeps the role, the host's identity and its rule, and opens no app", () => {
  const update = smoke.slice(
    smoke.indexOf("Step 'an update the app starts"),
    smoke.indexOf("Step 'a reinstall over an unfinished restore"),
  );
  assert.ok(update.length > 0, "the step comes before the restore marker's");
  assert.match(update, /\(Install @\('\/P', '\/UPDATE'\)\) -eq 0\) 'the passive update succeeds/u);
  assert.match(update, /RoleFileIs 'host'/u);
  assert.match(update, /\(RegValue \$roleKey 'Role'\) -ceq 'host'/u);
  assert.match(update, /host\.json'\)\) -eq \$hostJson\) 'the host identity is the same'/u);
  assert.match(update, /@\(Get-NetFirewallRule -Name 'MarkiroHost'\)\.Count -eq 1/u);
  assert.match(update, /WaitFor \{ HostAnswers \} 120/u);
  // `/R` would open the app on the runner; the app's own launch adds it (update/launch.rs).
  assert.doesNotMatch(update, /'\/R'/u);
  assert.doesNotMatch(update, /\/ROLE=/u);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node --test tools/standalone-release/test/installer.test.mjs tools/standalone-release/test/workflow.test.mjs
```

Ожидается: FAIL трёх новых проверок (нет `$UpdateMode <> 1` у вопроса, нет шага `smoke.ps1`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/windows/installer-hooks.nsh` (файл в UTF-8 **с BOM** — сохранить BOM; тест «the hooks file is UTF-8 with a byte order mark» это проверяет):

Фрагмент:

```nsis
    ${If} $0 == "3"
      DetailPrint "Сеть отнесена к общедоступным: порт хоста на ней закрыт."
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION
```

заменить на:

```nsis
    ${If} $0 == "3"
      DetailPrint "Сеть отнесена к общедоступным: порт хоста на ней закрыт."
      ; An update the app started (/P /UPDATE, plan ОБН-2) asks nothing: the
      ; question belongs to the first installation, and the office warns.
      ${IfNot} ${Silent}
      ${AndIf} $UpdateMode <> 1
        MessageBox MB_YESNO|MB_ICONEXCLAMATION
```

(остаток строки `MessageBox …` и всё после неё — без изменений).

Правка `tools/standalone-release/smoke.ps1`:

Фрагмент 1 (заголовок):

```powershell
  after a crash, a reinstall that keeps the host, a reinstall over an
  unfinished restore (the host's exit code 4), a refused role change, and
```

заменить на:

```powershell
  after a crash, a reinstall that keeps the host, the passive update the app
  starts (/P /UPDATE, plan ОБН-2), a reinstall over an unfinished restore
  (the host's exit code 4), a refused role change, and
```

Фрагмент 2 (после шага «a reinstall keeps the role and the host», перед `Step 'a reinstall over an unfinished restore …'`):

```powershell
WaitFor { HostAnswers } 60 'the host answers after that reinstall too'

Step 'a reinstall over an unfinished restore ends with exit 4: a warning, not a failure'
```

заменить на:

```powershell
WaitFor { HostAnswers } 60 'the host answers after that reinstall too'

Step 'an update the app starts (/P /UPDATE) keeps the role, the host and its data'
# The arguments update/launch.rs gives the installer, without /R: on this
# runner the app must not be opened. Passive is not silent: a hook's question
# would hang here, which the 600 s bound of Install turns into a failure.
Check ((Install @('/P', '/UPDATE')) -eq 0) 'the passive update succeeds without a role'
Check (RoleFileIs 'host') 'the role stays host'
Check ((RegValue $roleKey 'Role') -ceq 'host') 'the registry keeps the role'
Check ((Get-Content -Raw (Join-Path $dataDir 'host.json')) -eq $hostJson) 'the host identity is the same'
Check (@(Get-NetFirewallRule -Name 'MarkiroHost').Count -eq 1) 'still one firewall rule'
WaitFor { HostAnswers } 120 'the host answers after the update'
Check ($null -ne (RunValue)) 'the station still opens at sign-in'

Step 'a reinstall over an unfinished restore ends with exit 4: a warning, not a failure'
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm test:standalone-release:contract
```

Ожидается: PASS (в том числе «smoke.ps1 is balanced and written defensively» — новых `Start-Process`, `Remove-Item`, `-Uri` нет; ожидания ограничены 120 с).

- [ ] **Step 5: Гейты и коммит**

`git diff --check`; проверить BOM: `head -c 3 apps/standalone/src-tauri/windows/installer-hooks.nsh | od -An -tx1` → `ef bb bf`.

```bash
git add apps/standalone/src-tauri/windows/installer-hooks.nsh tools/standalone-release/smoke.ps1 tools/standalone-release/test/installer.test.mjs tools/standalone-release/test/workflow.test.mjs
git commit -F /tmp/claude/obn2-t10-msg.txt
```

Сообщение:

```text
feat(standalone-release): the passive update asks nothing and the smoke test runs it (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 11: Документы — `AGENTS.md`, памятка установки, §22 спецификации

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-install.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Test: `tools/standalone-release/test/offline.test.mjs` (фраза памятки ИТ остаётся)

**Interfaces:**

- Consumes: всё сделанное задачами 1–10 и «Отклонения при исполнении».
- Produces: раздел `## Updates from a file` в `apps/standalone/AGENTS.md`; раздел памятки «Обновление из файла»; §22 «Уточнения плана ОБН-2».

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

После раздела `## Installer and service` (перед `## Office pages`) добавить раздел:

```markdown
## Updates from a file

Plan ОБН-2 (spec `2026-10-13-standalone-license-and-updates-design.md`, §10)
updates a PC from a package: the installer `prepare.mjs` names and its signed
manifest `markiro-standalone-<version>.update.jws` (compact JWS ES256, `typ`
`markiro-standalone-update+jws`), side by side. CI writes the unsigned draft
(`markiro-standalone-<version>.update-draft.json`: version, commit, installer,
the protocol range of `proto/src/lib.rs`); the owner adds the channel, the
date, `minUpgradeFrom` and the notes and signs it offline with
`tools/standalone-release/sign-update.mjs` (passphrase from the terminal, key
and result outside the repository, the installer hashed again against its
evidence; Authenticode first, then `prepare.mjs`, then the signing). No key
reaches CI; `test/offline.test.mjs` pins the network crates of the lock and
refuses an updater or HTTP plugin.

The shell (`src-tauri/src/update/`) looks for `*.update.jws` in
`Документы\Markiro\Обновления` (`office_files::UPDATES_ROOT`, not one of the
roots the office writes) and in the root and `Markiro\` folder of removable
drives, no deeper, and verifies each manifest with
`markiro_proto::trust::verify_update_manifest` at once. `update_verify` and
`update_install` take only a path the last `update_scan` found. The installer
beside a manifest must be named for its version and is read through a handle
that shares reading only and opens no link (`package::open_installer`); the
handle is held from the hash to the launch. `rules::decide` refuses an older
version always (the passive installer would not: `allowDowngrades` stops only
`/S` and the dialog), a version below `minUpgradeFrom`, and, on a PC whose
role is not `host`, a protocol above the host's `hello`
(`host_probe::host_versions`, read whatever the protocol); the same version
and a silent host need a confirmation the webview sends back. The launch is
`ShellExecuteExW` with `runas` and `/P /UPDATE /R` behind `launch::Launcher`
(no `/ROLE`: the hooks take it from the registry; `/UPDATE` keeps the role
and `installation.json`). Before it the shell writes `update-pending.json`
(`{ from, to, startedAtMs }`); after it `lockdown::release_for_exit` lets the
close guard go and the app exits. The next start reads the mark: «обновлено»
(the mark goes) or «не завершилось» (it stays until «Скрыть»).

The office (`src/office/info/UpdateSection.tsx`, after «Лицензия» in
`ABOUT_SECTIONS`) shows the version and the outcome to both roles; only an
administrator searches, checks and installs. On the host's PC it asks the
host for a copy first (`POST /v1/office/backups`, up to 10 minutes) and names
the paired devices whose protocol the new `minProtocol` refuses; it names
this PC's open shift. Then `POST /v1/office/updates/started` writes
`app.update.start` (administrator, the session's device as the target,
`{ from, to, installerSha256, source }`, no revision — what the office
reported, like `shift.export`), and the shell starts the installer. Nothing
here runs on Windows in the tests: the administrator prompt, the handle's
sharing on NTFS (one Windows-only unit test), removable drives and the
passive update with the hooks (`smoke.ps1` runs `/P /UPDATE` without `/R`)
are checked by the Windows job and by hand.
```

- [ ] **Step 2: Памятка `docs/runbooks/standalone-install.md`**

Фрагмент 1 (раздел «Обновление (вопрос П13: переустановкой)», заголовок и пункт 1 до «2. Запустите новый установщик.»):

```markdown
## Обновление (вопрос П13: переустановкой)

1. Закройте приложение на каждой станции. На станции: администратор входит в офис, нажимает «Оконный
   режим» и закрывает окно. Иначе установщик Tauri сам предложит закрыть приложение (не проверялось).
   Повторный запуск приложения, пока оно уже работает, ничего не делает: второй экземпляр не
   находит спрятанное окно.
2. Запустите новый установщик.
```

заменить на:

```markdown
## Обновление из файла (раздел «Информация» → «Обновление»)

Пакет обновления — папка `markiro-standalone-<версия>-update` от Маркиро с двумя файлами: установщик
`markiro-standalone-<версия>-windows-x86_64-setup.exe` и подписанный манифест
`markiro-standalone-<версия>.update.jws`. Порядок на площадке: **сначала ПК хоста, затем станции и
ПК офиса**; между сменами.

1. Скопируйте оба файла в папку `Документы\Markiro\Обновления` этого ПК («Открыть папку» в разделе
   «Обновление» создаёт и открывает её) или на флешку — в корень или в папку `Markiro`.
2. Войдите в офис администратором, откройте «Информация» → «Обновление». Пакет виден в списке с
   версией; «Проверить» проверяет подпись манифеста и SHA-256 установщика.
3. Программа откажет, если версия старее установленной, если нужна промежуточная версия
   (`minUpgradeFrom`) или если на ПК станции или офиса хост ещё не обновлён («Сначала обновите хост
   площадки»). Та же версия — «Переустановить» с подтверждением; хост не отвечает — только с
   подтверждением.
4. «Установить обновление» показывает предупреждения: окно закроется на 1–3 минуты, открытая смена
   этого ПК продолжится после; на ПК хоста — какие устройства не подключатся, пока их не обновят, и
   что хост сначала сделает резервную копию (до 10 минут; неудача копии — установка не начинается).
5. Windows спрашивает права администратора. Отказ — «Обновление не запущено…», ничего не изменилось.
   После согласия программа закрывается сама, установщик работает с полосой хода и открывает
   программу снова. Если она не открылась — откройте вручную (на станции — выйти и войти в Windows).
6. При следующем запуске раздел «Обновление» пишет «Программа обновлена до версии …» или «Обновление
   … не завершилось» (повторите шаги 2–5).

Обновление пишет в журнал хоста строку `app.update.start` (кто, какой ПК, с какой версии на какую,
SHA-256 установщика).

### Запасной путь: вручную

Если программа не может запустить установщик (раздел «Обновление» → «Установить вручную» показывает
путь и SHA-256):

1. Сверьте SHA-256 в PowerShell: `Get-FileHash "<путь к установщику>"` — должно совпасть с разделом.
   Не запускайте файл, хеш которого не совпал.
2. Закройте приложение на этом ПК. На станции: администратор входит в офис, нажимает «Оконный
   режим» и закрывает окно. Иначе установщик Tauri сам предложит закрыть приложение (не проверялось).
   Повторный запуск приложения, пока оно уже работает, ничего не делает: второй экземпляр не
   находит спрятанное окно.
3. Запустите установщик.
```

Фрагмент 2 (там же, подпункты прежнего пункта 2; в памятке они с отступом в три пробела):

<!-- prettier-ignore -->
```markdown
   - Тихо: `<установщик> /S` — роль прежняя (из реестра).
```

заменить на:

<!-- prettier-ignore -->
```markdown
   - Как программа: `<установщик> /P /UPDATE` — с полосой хода, роль прежняя (из реестра).
   - Тихо: `<установщик> /S` — роль прежняя (из реестра).
```

Остальные пункты прежнего раздела (остановка службы, без понижения версии, учётная запись службы,
«Версии не совпадают») переименовать по порядку `4.`–`7.` и оставить.

Фрагмент 3 (раздел «Памятка для ИТ», строка 114 и её продолжение — найти предложение, начинающееся
с «Исходящих соединений в интернет нет»): в конец этого пункта дописать предложение «Обновления —
файлом от Маркиро; программа проверяет его подпись и SHA-256 сама и в интернет не обращается.»
Фраза «Исходящих соединений в интернет нет» остаётся дословно (её закрепляет
`tools/standalone-release/test/offline.test.mjs`).

Фрагмент 4 (раздел «Подпись Authenticode (вопрос П12)») — в конец раздела добавить абзац:

```markdown
Порядок с подписью манифеста обновления (план ОБН-2): подпись Authenticode меняет байты установщика,
поэтому сначала подписанная сборка (`sign-overlay.mjs`), затем `prepare.mjs` на этом установщике,
затем `sign-update.mjs`. Установщик, подписанный после `prepare.mjs`, `sign-update.mjs` отвергает:
его SHA-256 не совпадает с `release-evidence.json`.
```

(ОБН-1 добавляет в памятку раздел «Откат» — не трогать его.)

- [ ] **Step 3: §22 спецификации**

В конец `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (после §21, если он уже есть; иначе — после §17 с пометкой номера) добавить раздел `## 22. Уточнения плана ОБН-2` — короткий список того, что исполнение уточнило против §10: Д1 (тело без `deviceId`, `source`), Д3–Д4 (ключи `/P /UPDATE /R`, понижение в пассивном режиме закрывает только программа), Д5 (подпись проверяется при поиске), Д8 (`startedAtMs`, шесть команд), Д11 (`UPDATES_ROOT` не в `ROOTS`), Д12 (`office.about.update.*`), Д13 (`DeviceRecord.protocol`), вопрос сети не задаётся при обновлении (задача 10), и каждое «Отклонение при исполнении» задач 1–10. Без кода; ссылки — на файлы.

- [ ] **Step 4: Проверка и коммит**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
node --test tools/standalone-release/test/offline.test.mjs
git diff --check
```

Ожидается: PASS.

```bash
git add apps/standalone/AGENTS.md docs/runbooks/standalone-install.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F /tmp/claude/obn2-t11-msg.txt
```

Сообщение:

```text
docs(standalone): updates from a file — AGENTS.md, the install guide, spec §22 (plan ОБН-2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## Итоговая проверка плана

1. Протокол и хост: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto` и `-p markiro-host --test app_updates` — PASS (в песочнице). Если слит ЛЦ-2 — его тест классификации маршрутов тоже PASS.
2. Оболочка: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib` (в песочнице), `--test ipc --test update --test lockdown --test host_probe` (вне песочницы: сокет на 127.0.0.1) — PASS. Гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы, частями, если весь не помещается.
3. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone` без предупреждений; `git diff --stat <основа> -- apps/standalone/Cargo.lock` — пусто; `git diff <основа> -- apps/standalone/src-tauri/Cargo.toml` — только dev-фича `test-keys` и (если сделан шаг владельца) три фичи `windows-sys`.
4. Вебвью: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `typecheck`, `lint`, `build` — PASS; `update-section.test.tsx` и `about-page.test.tsx` — один прогон `--reporter=verbose` без `stderr |`.
5. Выпуск: `pnpm test:standalone-release:contract` — PASS (`prepare`, `offline`, `sign-update`, `update-fixtures`, `installer`, `workflow`, `sign-overlay`).
6. `pnpm format:check` (или prettier `--check` на всех изменённых TS, TSX, JSON, MJS, MD); `git diff --check`.
7. `git diff --stat <основа> -- apps/standalone/host/migrations apps/standalone/src-tauri/migrations packages/db/migrations` — пусто.
8. `grep -rn "PRIVATE KEY" tools/standalone-release apps/standalone/src-tauri/tests` — пусто; `grep -rn "sign-update\|update-key" .github/workflows` — пусто.
9. `git log --format=%B <основа>..HEAD` — у каждого коммита ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
10. `graphify update .`, если в дереве есть `graphify-out/graph.json`.

## Перенесено

- **ОБН-3 (раздача через хост, §10.11):** часть «С хоста» раздела «Обновление»; таблица «Устройства и версии» и история (`host.upgrade`, `update.package.stage`, `update.download`, `app.update.start`) — нужен `GET /v1/office/update-status`; загрузка пакета на хост перед обновлением ПК хоста (§10.4 шаг 3, §10.11.2) и команда `update_stage`; блок «Обновления» сведений для поддержки (§9.4, вкладчик в `SUPPORT_CONTRIBUTORS`); полоса «Доступно обновление» (Т6); кнопка «Обновить с хоста» на экране «Версии не совпадают»; отчёт `app.update.start` с `source: "host"` (форма уже есть).
- **Общие примитивы для ОБН-3.** `markiro_proto::update::{AppVersion (FromStr, Ord, Display), installer_name, hash_exact, PRODUCT}` и `update::package::{read_manifest, open_installer, verify}` оболочки — то, что план ОБН-3 (модуль `distribution`, Д3 его плана) должен переиспользовать вместо собственных `AppVersion::parse` и `sha256_hex_of`, как его план и предусматривает («если ОБН-2 уже завёл порядок версий»).
- **Окно совместимости N−1 в контракте выпуска** (`minProtocol` нового выпуска ≤ `protocol` предыдущего по `tools/standalone-release/releases.json`, §10.11.6, §12.1) — ОБН-3: черновик манифеста этого плана даёт ему `minProtocol`.
- **Проверка `markiro-host trust-keys` в `smoke.ps1` и контракте («в сборке выпуска нет `test-`», §5.2, §12.1)** — ЛЦ-1 вводит команду; если ЛЦ-1 её не закрепил в `smoke.ps1`, добавить отдельной задачей (`update_keyset` оболочки зависит от той же сборки ключей).
- **Открытые ключи выпусков** (`proto/fixtures/trust-keys.json`) — шаг владельца ЛЦ-1. До него сборка не знает ни одного ключа выпусков, и каждый пакет — «Пакет подписан ключом, который эта версия не знает».
- **Предзагрузка и подсказка «Доступно обновление» на станции** (ЛО15) — после первой версии.
- **Диалог выбора файла** (ЛО10, альтернатива) — не делается.

## Не проверено

- **Windows целиком.** Запрос UAC при запуске из приложения под обычным пользователем станции; отказ UAC (`ERROR_CANCELLED`); запуск из запертого окна (окно UAC на защищённом столе поверх киоск-окна); выход программы мимо стража закрытия и завершение её пассивным установщиком (`CheckIfAppIsRunning`); установщик заменяет файлы работающей программы; перезапуск программы ключом `/R` от имени пользователя; поведение хуков при `/P /UPDATE` (роль из реестра, служба остановлена и запущена, `installation.json` на месте) — частично покрывает шаг `smoke.ps1` (без `/R`, на раннере, где UAC не спрашивает).
- **Дескриптор `FILE_SHARE_READ` на NTFS**: мешает записи, переименованию и удалению установщика, а установщик под UAC его читает и исполняет (один модульный тест под `cfg(windows)` — запись, переименование, удаление; запуск под UAC — только вручную); антивирус, открывающий файл между хешем и запуском.
- **Съёмные диски**: `GetLogicalDrives`/`GetDriveTypeW` на флешке FAT32/exFAT/NTFS, кардридер без карты, `Документы` при перенаправленной папке (OneDrive, сетевая папка), права на `Документы\Markiro\Обновления` в киоск-сеансе.
- **Код под `cfg(windows)` не компилировался при написании плана** (macOS): `ShellExecuteExW`, `SHELLEXECUTEINFOW` с `Default`, `GetDriveTypeW`; его компилирует задание `standalone-windows-build` после шага владельца.
- **Ключи шаблона Tauri NSIS** прочитаны в строках бинарника `@tauri-apps/cli` 2.11.4 (`/P`, `/UPDATE`, `/R`, `/ARGS`, `EarlyChecks` только в тихом режиме, `CheckIfAppIsRunning` в пассивном режиме завершает приложение без вопроса); `makensis` хуки не компилировал, другая версия CLI может отличаться.
- **Резервная копия перед обновлением** на реальной базе клиента (время, место на диске), обновление хоста при работающих станциях на других ПК, вопрос о профиле сети при первой установке после правки хука.
- **SmartScreen и «Неизвестный издатель»** для неподписанного установщика в окне UAC (до Authenticode, ЛО13).
- **Браузер и вебвью WebView2**: раздел «Обновление», `<details>`, диалог подтверждения и живая область проверены только jsdom.
- **`sign-update.mjs` на машине владельца**: ввод парольной фразы в терминале (сырой режим) — только вручную; тесты проверяют отказ без терминала.

## Отклонения при исполнении

_(заполняет исполнитель)_
