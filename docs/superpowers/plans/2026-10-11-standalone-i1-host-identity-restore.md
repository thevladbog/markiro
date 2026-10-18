# План I1: восстановление на новом ПК сохраняет подключение станций (удостоверение хоста в копии) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост автономного продукта, восстановленный из копии на НОВОМ ПК, остаётся для станций тем же хостом: тот же `hostId`, тот же закреплённый сертификат, те же ключи устройств. Станции и ПК офиса не подключаются заново, а только узнают новый адрес (тот же IP нового ПК или «Изменить адрес хоста»), и вся работа плана РК-С — возврат блоков SSCC, повторная отправка записей 30 дней, удержание до «Возобновить» — идёт как при восстановлении на том же ПК. Для этого рядом с каждой копией лежит файл удостоверения `<имя>.identity` (`host.json` и сертификат TLS с закрытым ключом), закрытый от всех, кроме учётной записи службы, SYSTEM и администраторов; `markiro-host restore` ставит его на место (или отказывается при чужом работающем хосте без явного флага), не меняя запасов счётчиков инфраструктурного исправления C1.

**Architecture:**

- Удостоверение (задача 1, `host/src/backup/identity.rs`): `HostIdentity` (чтение из каталога данных, файл `.identity` формата 1 — JSON с base64 DER, проверка «ключ подходит к сертификату», `Debug` без ключа), `IdentityRef` в манифесте, `attach` / `replicate` / `read_beside`, защита файла ключа — трейт `KeyFileGuard`: на Unix `0600`, на Windows `IcaclsGuard` поверх `install::Commands` (`icacls /inheritance:r /grant:r` SYSTEM, Администраторы, OWNER RIGHTS). Windows-часть — за трейтом и проверяется подменой `Commands`.
- Копии (задача 2): `Manifest.identity` (необязательное поле, формат манифеста остаётся 1), `make_copy_with_identity`, работник копий читает удостоверение каталога данных перед каждой копией, вторая папка получает его через `replicate_guarded`; ротация и очистка уносят `.identity` вместе с копией; `BackupCopy.hostIdentity` в `proto`, фикстуре и Zod.
- Проверка копии и правило (задача 3, `restore.rs`): `VerifiedCopy.identity` (`Absent` / `Present` / `Damaged`), чистая функция `identity_plan` (`Same` / `Install` / `KeepFolder` / `Create`) по выбору `Auto` / `--keep-identity` / `--take-identity`; `verify-copy` печатает удостоверение и падает на испорченном.
- Восстановление (задача 4): удостоверение копии пишется в `identity.partial/` до маркера, ставится на место после подмены базы под тем же маркером (ключ, сертификат, `host.json` последним), прерванное восстановление доделывает его первым; `foreign` для C1 считается по удостоверению каталога ДО восстановления, поэтому восстановленное удостоверение никогда не делает историю «известной»; `RestoreOptions`, `restore_with`, `restore_now`, флаги CLI, строки сводки и слово `identity` в строке аудита `host.restore`.
- Офис (задача 5): столбец «Ключ хоста» в таблице копий, предупреждения `localNoIdentity` / `secondNoIdentity`, строка о новом ПК в карточке «Восстановление».
- Станция (задача 6): кода не меняет — «Изменить адрес хоста» (план УСТ, `device_change_address`) уже держит подключение, если по новому адресу тот же сертификат и ключ устройства принят. Сквозной тест оболочки на настоящих хостах: восстановление удостоверения в новый каталог данных, станция на новом адресе с закреплённым сертификатом; без удостоверения — `address_other_host`.
- Документы (задача 7): памятка `standalone-backup-restore.md` (раздел 6 переписан, правки разделов 2, 5, 7, 8, 9, 10), `standalone-install.md`, `apps/standalone/AGENTS.md`, раздел 26 спецификации пилота и снятие формулировки «открытое решение владельца» в разделе 24.

**Tech Stack:** Rust — `markiro-host` (sqlx 0.8.6, rustls 0.23.45 с aws-lc-rs, rcgen 0.14.10, base64 0.22.1, tokio 1.53.1), `markiro-proto`, оболочка `markiro-standalone` (только тест на настоящих хостах); React 19.2, TypeScript 6 (strict), zod 4.4.3, i18next, `@markiro/ui` (`Table`, `Alert`, `Card`), Vitest 4 в jsdom.

**Спецификации и источники:**

- `.superpowers/sdd/OWNER-DECISIONS.md`, «DECISIONS 2026-10-11»: «I1 = option 1 (host identity host.json+tls goes into the backup copy so stations keep their pairing)»; там же запись «РК-С I1» с вариантами (1)–(3).
- `.superpowers/sdd/rks-task-2-review.md` (I1 и M1–M7), `.superpowers/sdd/rks-final-review-report.md` (I-3), `.superpowers/sdd/infra-final-review-report.md` и `infra-final-fix-report.md` (C1: `history_known = current == Read && initialized && !foreign`).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §11 («досылать факты, хранящиеся 30 дней»), §22 (РК), §23 (УСТ: «Изменить адрес хоста», `host_origin`), §24 (РК-С: «Открытое решение владельца: восстановление на новом ПК»).
- `docs/runbooks/standalone-backup-restore.md` (разделы 2, 5–10), `docs/runbooks/standalone-install.md` («Новый адрес хоста»).
- `apps/standalone/AGENTS.md` — «Backups and restore», «Network and TLS», «Installer and service», «Verification».
- Код: `host/src/restore.rs`, `host/src/backup/{copy,folder,worker}.rs`, `host/src/tls.rs` («Devices pin the SHA-256 of the certificate DER, so the names inside the certificate do not matter»), `host/src/config.rs`, `host/src/install.rs` (`Commands`, `run_checked`, `SystemCommands`), `src-tauri/src/device.rs` (`change_address`, `host_origin`), `src-tauri/src/host_client.rs` (закрепление по отпечатку, имя сервера не проверяется), `src-tauri/tests/host_address.rs`.

## Допущения

Владелец выбрал вариант 1 (контроллер, 2026-10-11). Остальное решено планировщиком; если владелец решит иначе, ниже сказано, что поменять.

- **Д1. Файл удостоверения — рядом с каждой копией, а не один на папку.** Копия — самостоятельная тройка `…db`, `…json`, `…identity`: её переносят на флешку и восстанавливают на ПК, где нет второй папки. Лишних «копий ключа» это не создаёт: ключ один и тот же, права те же. Манифест называет файл косвенно (`<имя>.identity` рядом с `<имя>.db`) и хранит его отпечаток сертификата, размер и SHA-256.
- **Д2. Сертификат не перевыпускается.** Станции закрепляют SHA-256 DER сертификата (`host_client.rs`, `pinned_builder`), имя сервера и SAN не проверяются (`tls.rs`). Сертификат старого ПК подходит к любому адресу нового. Перевыпуск под новые SAN сменил бы отпечаток и уничтожил бы смысл плана.
- **Д3. Новый адрес — без поиска хоста.** mDNS перенесён планом УСТ. Способы: (а) лучший — новому ПК отдают адрес старого (тот же IP или имя в DNS, резервирование DHCP у ИТ клиента), станции выходят на связь сами; (б) иначе на каждой станции и ПК офиса «Офис» → «Изменить адрес хоста» (план УСТ: адрес принимается, только если там тот же сертификат и хост принимает ключ устройства). Офис не может сообщить станциям адрес (связи с ними нет), мастер не меняется.
- **Д4. Без шифрования ключа в пилоте; риск записан честно.** DPAPI привязан к машине — на новом ПК бесполезен. Пароль восстановления — новый секрет, который человек должен хранить и вводить; потеря пароля возвращает к варианту 3. Защита — права на файл (`0600` / `icacls`), правила второй папки и сейфа для флешки в памятке. **Риск:** кто прочёл `.identity`, может в сети цеха выдать себя за хост: станции отправят ему записи и ключи устройств и примут от него справочники (операторов, товары, шаблоны). Копия и без ключа содержит хеши PIN и бейджей (короткие PIN перебираются быстро), так что копия и раньше требовала защиты как ПК хоста; ключ добавляет активную подмену. Утечка копии с ключом — повод сменить удостоверение (всем устройствам подключиться заново); команды для этого нет, это «Перенесено».
- **Д5. Папка, которую нельзя закрыть, получает копию без удостоверения.** `icacls` падает на FAT32/exFAT и на общей папке, отказавшей в ACL. Копия базы важнее: она делается, манифест этой папки не называет удостоверения, офис предупреждает («…без ключа хоста»). Копия никогда не падает из-за удостоверения.
- **Д6. Правило восстановления (`identity_plan`).** Без флага (`Auto`): копия без удостоверения — как прежде (каталог сохраняет своё или получает новое); удостоверение каталога совпадает с копией (`hostId`, сертификат и ключ) — ничего не меняется; в каталоге удостоверения нет или его хост не рабочий (база отсутствует или прочитана без пройденного мастера — база установщика нового ПК) — ставится удостоверение копии; в каталоге рабочий хост другого удостоверения (мастер пройден или база не читается) — отказ, ничего не меняется, текст называет `--take-identity` и `--keep-identity`. `--keep-identity` никогда не берёт удостоверение копии; `--take-identity` берёт его и над рабочим хостом. Испорченное удостоверение рядом с копией — отказ без флага и с `--take-identity`; с `--keep-identity` данные восстанавливаются без него. `--without-manifest` удостоверение не читает.
- **Д7. Запасы C1 не меняются.** `foreign` (а с ним `history_known`, запас +100 000 и перенос отзывов) считается по `host.json` каталога ДО восстановления, как сейчас. Восстановленное удостоверение не делает базу установщика или чужую базу «историей копии». Тест и мутант это закрепляют. На новом ПК поэтому счётчики встают не ниже +100 000 над копией (как и раньше), а блоки, выданные станциям после копии, вдобавок регистрируются возвратом блоков РК-С.
- **Д8. Удостоверение ставится после подмены базы, под тем же маркером.** `identity.partial/` (ключ, сертификат, `host.json`) пишется и синхронизируется до маркера; маркер получает `identity: true` (`#[serde(default)]`, старые маркеры читаются); после подмены базы файлы переименовываются: ключ, сертификат, `host.json` последним. Пока маркер есть, хост не запускается — сертификат без своего ключа никогда не обслуживает станции. Прерванное восстановление доделывает удостоверение первым (`finish_interrupted` теперь вызывается до чтения `host.json`); откат подмены удаляет `identity.partial/`. Заменённое удостоверение каталога копируется в `restore-<время>/identity/`, если папка `restore-<время>` есть (база установщика — есть всегда).
- **Д9. Порт — из копии.** `host.json` удостоверения — целиком копии: станции хранят адрес с портом. Если порт отличается от открытого в брандмауэре установщиком (по умолчанию 45710), сводка просит запустить установщик ещё раз (он открывает порт из `host.json`, `install::configured_port`).
- **Д10. Формат манифеста остаётся 1.** Поле `identity` необязательное (`#[serde(default, skip_serializing_if = "Option::is_none")]`); манифест без удостоверения сериализуется байт в байт как раньше; старые сборки поле игнорируют (манифест без `deny_unknown_fields`); копии старых сборок восстанавливаются как прежде (станции подключаются заново).
- **Д11. Миграций нет.** Удостоверение живёт в файлах; ни оболочка, ни хост схем не меняют. Номер миграции хоста `0013`, отложенный за I1, **не занят** — контроллер может отдать его другому плану.
- **Д12. Код станции не меняется.** `change_address` уже делает всё нужное; строка состояния «записи прежнего подключения не отправлены» (вариант РК-С) при копии с ключом не нужна. Станция на самом ПК хоста (роль «хост и станция») на новом ПК — новая установка; если её открыли до восстановления, она подключилась к удостоверению установщика и после восстановления подключается заново (памятка).
- **Д13. Старый ПК после восстановления — без службы хоста.** Два хоста с одним удостоверением в одной сети: станция ходит к тому, кто ответил по её адресу. Памятка требует остановить и отключить службу на ожившем старом ПК и удалить роль хоста.

## Global Constraints

**Решение и порядок владельца**

- «I1 = option 1 (host identity host.json+tls goes into the backup copy so stations keep their pairing)» (OWNER-DECISIONS, 2026-10-11).
- «MAXIMUM SPEED»: план для исполнителей sonnet, по одной задаче со свежим контекстом, не больше 8 задач, каждая проверяется отдельно. После всех планов — push и первая бета (не дело этого плана: здесь только коммиты, push и PR не разрешены).
- Поток MISC: ХП → **I1** → ОЧ. Предпосылка — ветка после ХП; от кода ХП план не зависит.

**Правила исполненного состояния**

- Применённые миграции не меняются (оболочка `0001`–`0009`, хост `0001`–`0012`); план новых миграций не добавляет.
- Фикстуры `proto/fixtures` — общие для Rust и Zod: форма меняется в одном коммите с обоими тестами.
- Ключи `src/i18n/ru.json` уникальны; текст — буквами; доступность: состояние словами, не цветом.
- Журнал процесса не видит ни байта закрытого ключа: `HostIdentity` печатает в `Debug` только `hostId`, порт и отпечаток; ошибки разбора файла удостоверения — без содержимого (строка и столбец).
- Отказ `restore` до подмены ничего не меняет в каталоге данных («Nothing was changed…» / `made.unchanged`).

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются.
- Не меняются: `apps/station`, `packages/*`, исходники `src-tauri/src` и `src/local`, `src/floor`, `src/app` вебвью.
- Коммиты — явные пути, сообщение из файла, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан так, как он стоит в файле интеграционной ветки на `2c726efba` (рабочее дерево `/tmp/claude/wt/integ`). Если ХП или другой план сдвинул текст, правка вносится по смыслу рядом с тем же местом, отличие пишется в «Отклонения при исполнении». Внутри шага правки одного файла идут сверху вниз.
- «Создать» — новый файл ровно как в блоке, с переводом строки в конце.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть фрагмента.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (задачи с Rust) — молчит; prettier на изменённые TS, TSX, JSON и MD из корня: `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <пути>` → `All matched files use Prettier code style!`; `git diff --check` — молчит.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` и своим `CARGO_TARGET_DIR` для рабочего дерева.
- Тесты хоста `--test restore`, `--test backup_copy`, `--test backup_worker` и `--lib` сокета не открывают и идут в песочнице. Тест оболочки `--test restore_identity` поднимает настоящих хостов на 127.0.0.1 — вне песочницы (как `--test host_address`). Перед `-p markiro-standalone` в свежем дереве — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает сборку вебвью).
- Перед Vitest в свежем дереве — `pnpm --config.verifyDepsBeforeRun=false install --frozen-lockfile --prefer-offline --filter '@markiro/standalone...'` и `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`, из корня, без `cd`. Не использовать `git stash`. Если вывод урезан обёрткой `rtk`, запускать `rtk proxy <команда>`; не передавать вывод тестов в `tail`/`grep`, когда нужен код возврата.

**Счёт тестов (приращения; базу исполнитель записывает перед задачей 1)**

- Задача 1: `markiro-host --lib` +7 (`backup::identity::tests`).
- Задача 2: `--test backup_copy` +4, `--test backup_worker` +2; `markiro-proto --test backup` и Vitest `backups.test.ts` — 0 (проверки дописаны в существующие тесты).
- Задача 3: `--lib` +1 (`restore::identity_tests`), `--test restore` +1.
- Задача 4: `--test restore` +5, `markiro-host` бинарь (`main.rs`) +1.
- Задача 5: Vitest +2 (`backup-warnings.test.ts` +1, `backups-page.test.tsx` +1).
- Задача 6: оболочка `--test restore_identity` +2 (новый файл).

**Что исполнитель может проверить на macOS и чего не может**

- Может: файл удостоверения, права `0600`, подмену `Commands` для `icacls`, всё восстановление на настоящих каталогах данных (без сокета), сквозной тест со станцией и двумя настоящими хостами на 127.0.0.1, офис в jsdom.
- Не может: `icacls` на NTFS, на общей папке другого ПК и на флешке FAT32/exFAT; владельца файла (OWNER RIGHTS) при службе под `LocalService` или локальной учётной записью; переименование поверх `tls/key.der` под антивирусом; восстановление на настоящем новом ПК Windows с двумя станциями и тем же IP через DHCP. Это — памятка, раздел 10, пункты 9 и 11.

## Файлы

Создаются:

- `apps/standalone/host/src/backup/identity.rs` — удостоверение, файл `.identity`, защита ключа (задача 1).
- `apps/standalone/src-tauri/tests/restore_identity.rs` — сквозной тест со станцией (задача 6).

Меняются:

- `apps/standalone/host/src/backup/mod.rs`, `host/src/tls.rs` (задача 1).
- `apps/standalone/host/src/backup/copy.rs`, `folder.rs`, `worker.rs`; `proto/src/backup.rs`, `proto/fixtures/backup-state.json`, `proto/tests/backup.rs`; `src/host/backups.ts`, `test/backups.test.ts`, `test/support/backups.ts`; `host/tests/support/backup.rs`, `host/tests/backup_copy.rs`, `host/tests/backup_worker.rs`, `host/tests/restore.rs` (литерал `Manifest`) (задача 2).
- `apps/standalone/host/src/restore.rs`, `host/src/main.rs`, `host/tests/restore.rs` (задачи 3–4).
- `apps/standalone/src/office/backups/backup-warnings.ts`, `BackupsPage.tsx`, `src/i18n/ru.json`, `test/backup-warnings.test.ts`, `test/backups-page.test.tsx` (задача 5).
- `docs/runbooks/standalone-backup-restore.md`, `docs/runbooks/standalone-install.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`; если есть в дереве — `docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md` (одна строка) (задача 7).

## Контракт для других планов

- `Manifest.identity: Option<IdentityRef>` (`fingerprint`, `sizeBytes`, `sha256`), файл `<имя>.identity` рядом с `<имя>.db`; `BackupCopy.hostIdentity: bool` (Rust `#[serde(default)]`, Zod обязательное).
- `markiro_host::restore::{RestoreOptions, IdentityChoice, IdentityOutcome, restore_with, restore_now}`, `RestoreReport.identity`, `CrashPoint::IdentityPartly`; имя `identity.partial` в каталоге данных занято восстановлением.
- `markiro_host::backup::identity::{HostIdentity, KeyFileGuard, OwnerOnly, IcaclsGuard, platform_guard}`; `Backups::new_with_guard`.
- Миграции не заняты; раздел спецификации пилота — 26.

---

### Task 1: Удостоверение хоста — файл `.identity` и защита закрытого ключа

**Files:**

- Create: `apps/standalone/host/src/backup/identity.rs`
- Modify: `apps/standalone/host/src/backup/mod.rs`, `apps/standalone/host/src/tls.rs`

**Interfaces:**

- `pub struct HostIdentity` — `new(host_id, port, cert_der, key_der) -> Result<Self, IdentityError>`, `read(&HostPaths)`, `host_id()`, `port()`, `fingerprint()`, `cert_der()`, `key_der()`, `config() -> HostConfig`, `same_as(&Self) -> bool`, `to_file_bytes()`, `from_file_bytes(&[u8])`.
- `pub struct IdentityRef { fingerprint, size_bytes, sha256 }` (serde camelCase).
- `pub fn identity_path(db) -> PathBuf`, `pub fn attach(db, &HostIdentity, &dyn KeyFileGuard) -> Option<IdentityRef>`, `pub fn replicate(source_db, target_db, &IdentityRef, &dyn KeyFileGuard) -> Option<IdentityRef>`, `pub fn read_beside(db, host_id, &IdentityRef) -> Result<HostIdentity, String>`.
- `pub trait KeyFileGuard: Send + Sync { fn protect(&self, path: &Path) -> Result<(), String>; }`, `OwnerOnly`, `IcaclsGuard<C: Commands + Send>`, `pub fn key_file_acl_args(path) -> Vec<String>`, `pub fn platform_guard() -> Arc<dyn KeyFileGuard>`.
- `TlsIdentity::from_der(cert_der, private_der) -> Result<Self, TlsError>`, `TlsIdentity::private_der(&self) -> &[u8]`.

- [ ] **Step 1: `TlsIdentity` из DER и доступ к ключу**

В `apps/standalone/host/src/tls.rs` фрагмент

```rust
    pub fn load_or_create(tls_dir: &Path, host_id: &str) -> Result<Self, TlsError> {
```

заменить на

```rust
    /// An identity from its DER files as a copy carries them (plan I1),
    /// checked like [`Self::load`]: rustls refuses a key that does not match
    /// the certificate.
    pub fn from_der(cert_der: Vec<u8>, private_der: Vec<u8>) -> Result<Self, TlsError> {
        let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
        let identity = Self {
            cert_der,
            private_der,
            fingerprint,
        };
        identity.server_config()?;
        Ok(identity)
    }

    /// The private key's DER: only for the files of the host identity in a
    /// copy (plan I1), never for a log.
    pub fn private_der(&self) -> &[u8] {
        &self.private_der
    }

    pub fn load_or_create(tls_dir: &Path, host_id: &str) -> Result<Self, TlsError> {
```

- [ ] **Step 2: модуль в `backup`**

В `apps/standalone/host/src/backup/mod.rs` фрагмент

```rust
//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay, `worker` makes them
//! on a schedule and on request. `crate::restore` puts one back.

pub mod copy;
pub mod folder;
```

заменить на

```rust
//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay, `worker` makes them
//! on a schedule and on request, `identity` puts the host's identity beside
//! each copy (plan I1). `crate::restore` puts one back.

pub mod copy;
pub mod folder;
pub mod identity;
```

- [ ] **Step 3: создать `apps/standalone/host/src/backup/identity.rs`**

```rust
//! The host's identity beside a copy (plan I1): `host.json` and the TLS
//! certificate with its private key, in one file `<name>.identity` next to
//! `<name>.db`. A restore on a new computer puts it back, so every paired
//! device keeps its pairing: the same `hostId`, the same pinned certificate
//! and the same device keys in the copy.
//!
//! The file holds the host's PRIVATE KEY: whoever reads it can answer the
//! stations as their host on the network. It is written owner-only
//! (`0600`) and closed by a [`KeyFileGuard`] before it gets its name: on
//! Windows only SYSTEM, the administrators and the file's owner (the
//! service's account) keep access. A folder that cannot be closed (a
//! FAT32 or exFAT flash drive, a share that refuses ACLs) gets the copy
//! without the identity, and the manifest of that folder names none.
//! Nothing here logs a byte of the key: `Debug` prints the host id, the
//! port and the fingerprint only, and a file that does not parse is
//! reported by line and column, never by its contents.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use aws_lc_rs::digest::{digest, SHA256};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::copy::{create_private, partial_path};
use crate::config::{HostConfig, HostPaths};
use crate::install::{run_checked, Commands};
use crate::tls::TlsIdentity;

/// The identity file format this build writes and reads.
pub const IDENTITY_FORMAT: u32 = 1;

/// What a Windows key file grants once its inherited entries are gone:
/// SYSTEM, the administrators and OWNER RIGHTS (the account that wrote it,
/// the service's), each full control. Nobody else.
pub const KEY_FILE_GRANTS: [&str; 3] = ["*S-1-5-18:F", "*S-1-5-32-544:F", "*S-1-3-4:F"];

/// `<name>.identity` beside the copy `<name>.db`.
pub fn identity_path(db: &Path) -> PathBuf {
    db.with_extension("identity")
}

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    /// A file could not be read; the text names the file, never its contents.
    #[error("{0}")]
    Unreadable(String),
    /// The files read, but they are no usable identity.
    #[error("{0}")]
    Invalid(String),
}

/// What a manifest says of the identity beside its copy: enough to check
/// the file before a restore trusts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    /// SHA-256 of the certificate's DER: the fingerprint devices pin.
    pub fingerprint: String,
    /// Of the identity file.
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the identity file.
    pub sha256: String,
}

/// A host identity, checked: a UUID `hostId`, a port, and a private key that
/// matches its certificate.
pub struct HostIdentity {
    host_id: String,
    port: u16,
    tls: TlsIdentity,
}

impl std::fmt::Debug for HostIdentity {
    // The private key must never reach a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostIdentity")
            .field("host_id", &self.host_id)
            .field("port", &self.port)
            .field("fingerprint", &self.tls.fingerprint)
            .finish_non_exhaustive()
    }
}

/// The identity file: `host.json`'s two fields and the TLS files in base64.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityFile {
    format: u32,
    host_id: String,
    port: u16,
    /// Base64 of the certificate's DER.
    certificate: String,
    /// Base64 of the PKCS#8 private key's DER.
    private_key: String,
}

impl HostIdentity {
    pub fn new(
        host_id: String,
        port: u16,
        cert_der: Vec<u8>,
        key_der: Vec<u8>,
    ) -> Result<Self, IdentityError> {
        if uuid::Uuid::parse_str(&host_id).is_err() {
            return Err(IdentityError::Invalid(
                "the identity's hostId is not a UUID".into(),
            ));
        }
        if port == 0 {
            return Err(IdentityError::Invalid("the identity's port is 0".into()));
        }
        let tls = TlsIdentity::from_der(cert_der, key_der).map_err(|error| {
            IdentityError::Invalid(format!("the identity's TLS key is unusable: {error}"))
        })?;
        Ok(Self { host_id, port, tls })
    }

    /// The data folder's identity: `host.json` and both TLS files, checked.
    /// Creates nothing.
    pub fn read(paths: &HostPaths) -> Result<Self, IdentityError> {
        let config = HostConfig::load(paths)
            .map_err(|error| IdentityError::Unreadable(error.to_string()))?;
        let tls = TlsIdentity::load(&paths.tls_dir())
            .map_err(|error| IdentityError::Unreadable(error.to_string()))?;
        Ok(Self {
            host_id: config.host_id,
            port: config.port,
            tls,
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn fingerprint(&self) -> &str {
        &self.tls.fingerprint
    }

    pub fn cert_der(&self) -> &[u8] {
        &self.tls.cert_der
    }

    /// The private key's DER: only for the files of an identity, never for
    /// a log.
    pub fn key_der(&self) -> &[u8] {
        self.tls.private_der()
    }

    /// `host.json` of this identity.
    pub fn config(&self) -> HostConfig {
        HostConfig {
            host_id: self.host_id.clone(),
            port: self.port,
        }
    }

    /// The same host to a device: the same `hostId`, certificate and key.
    /// The port is no part of it.
    pub fn same_as(&self, other: &Self) -> bool {
        self.host_id == other.host_id
            && self.cert_der() == other.cert_der()
            && self.key_der() == other.key_der()
    }

    pub fn to_file_bytes(&self) -> Vec<u8> {
        let file = IdentityFile {
            format: IDENTITY_FORMAT,
            host_id: self.host_id.clone(),
            port: self.port,
            certificate: STANDARD.encode(self.cert_der()),
            private_key: STANDARD.encode(self.key_der()),
        };
        serde_json::to_vec_pretty(&file).expect("an identity file serializes")
    }

    pub fn from_file_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        let file: IdentityFile = serde_json::from_slice(bytes).map_err(|error| {
            IdentityError::Invalid(format!(
                "the identity file is no identity (line {}, column {})",
                error.line(),
                error.column()
            ))
        })?;
        if file.format != IDENTITY_FORMAT {
            return Err(IdentityError::Invalid(format!(
                "identity format {} is not {IDENTITY_FORMAT}",
                file.format
            )));
        }
        let cert_der = STANDARD.decode(file.certificate.as_bytes()).map_err(|_| {
            IdentityError::Invalid("the identity's certificate is not base64".into())
        })?;
        let key_der = STANDARD.decode(file.private_key.as_bytes()).map_err(|_| {
            IdentityError::Invalid("the identity's private key is not base64".into())
        })?;
        Self::new(file.host_id, file.port, cert_der, key_der)
    }
}

/// Closes a file that holds the host's private key to everyone but its
/// owner, SYSTEM and the administrators.
pub trait KeyFileGuard: Send + Sync {
    /// Blocking. `Err` is a text for the process log.
    fn protect(&self, path: &Path) -> Result<(), String>;
}

/// Owner-only (`0600`) on Unix, whatever the file was created with; nothing
/// elsewhere.
pub struct OwnerOnly;

impl KeyFileGuard for OwnerOnly {
    fn protect(&self, path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
        #[cfg(not(unix))]
        let _ = path;
        Ok(())
    }
}

/// Windows: `icacls <file> /inheritance:r /grant:r <KEY_FILE_GRANTS…>`
/// through [`Commands`]. A folder without ACLs (FAT32, exFAT) or a share that
/// refuses them makes icacls fail: the identity then stays out of that
/// folder.
pub struct IcaclsGuard<C> {
    commands: Mutex<C>,
}

impl<C> IcaclsGuard<C> {
    pub fn new(commands: C) -> Self {
        Self {
            commands: Mutex::new(commands),
        }
    }
}

impl<C: Commands + Send> KeyFileGuard for IcaclsGuard<C> {
    fn protect(&self, path: &Path) -> Result<(), String> {
        let mut commands = self.commands.lock().unwrap_or_else(PoisonError::into_inner);
        run_checked(&mut *commands, "icacls", &key_file_acl_args(path))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// `icacls <path> /inheritance:r /grant:r <KEY_FILE_GRANTS…>`.
pub fn key_file_acl_args(path: &Path) -> Vec<String> {
    let mut args = vec![
        path.display().to_string(),
        "/inheritance:r".to_owned(),
        "/grant:r".to_owned(),
    ];
    args.extend(KEY_FILE_GRANTS.iter().map(|grant| (*grant).to_owned()));
    args
}

/// The guard of this system: icacls on Windows, owner-only elsewhere.
pub fn platform_guard() -> Arc<dyn KeyFileGuard> {
    #[cfg(windows)]
    {
        Arc::new(IcaclsGuard::new(crate::install::SystemCommands))
    }
    #[cfg(not(windows))]
    {
        Arc::new(OwnerOnly)
    }
}

/// Write `bytes` to `<target>.partial` (owner-only, synced), close it with
/// `guard`, then rename it to `target`. `None`, with nothing of it left, when
/// a step fails; the reason goes to the process log only. Blocking.
fn put_file(target: &Path, bytes: &[u8], guard: &dyn KeyFileGuard) -> Option<()> {
    let partial = partial_path(target);
    let written = (|| -> Result<(), String> {
        let text = |error: std::io::Error| format!("{}: {error}", partial.display());
        let mut file = create_private(&partial, false).map_err(text)?;
        file.write_all(bytes).map_err(text)?;
        file.sync_all().map_err(text)?;
        drop(file);
        guard.protect(&partial)?;
        fs::rename(&partial, target).map_err(text)
    })();
    match written {
        Ok(()) => Some(()),
        Err(reason) => {
            let _ = fs::remove_file(&partial);
            tracing::warn!(
                %reason,
                "the host identity was not put beside the copy: the copy goes without it"
            );
            None
        }
    }
}

/// Put `identity` beside the copy `db`. `None` when the file could not be
/// written or closed: the copy is good without it. Blocking.
pub fn attach(db: &Path, identity: &HostIdentity, guard: &dyn KeyFileGuard) -> Option<IdentityRef> {
    let bytes = identity.to_file_bytes();
    let reference = IdentityRef {
        fingerprint: identity.fingerprint().to_owned(),
        size_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
    };
    put_file(&identity_path(db), &bytes, guard).map(|()| reference)
}

/// Copy the identity beside `source_db` beside `target_db`, checked against
/// `reference` (the manifest's) and closed by `guard`. `None` when it is
/// missing, differs, or could not be written or closed there. Blocking.
pub fn replicate(
    source_db: &Path,
    target_db: &Path,
    reference: &IdentityRef,
    guard: &dyn KeyFileGuard,
) -> Option<IdentityRef> {
    let source = identity_path(source_db);
    let bytes = match fs::read(&source) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(
                %error,
                file = %source.display(),
                "the host identity beside the copy did not read: the second folder gets the copy without it"
            );
            return None;
        }
    };
    if bytes.len() as u64 != reference.size_bytes || sha256_hex(&bytes) != reference.sha256 {
        tracing::warn!(
            file = %source.display(),
            "the host identity beside the copy differs from its manifest: the second folder gets the copy without it"
        );
        return None;
    }
    put_file(&identity_path(target_db), &bytes, guard).map(|()| reference.clone())
}

/// Read the identity beside the copy `db` and check it against its
/// manifest: the size and SHA-256 of `reference`, the copy's `host_id`, the
/// certificate `reference` names. Blocking.
pub fn read_beside(db: &Path, host_id: &str, reference: &IdentityRef) -> Result<HostIdentity, String> {
    let path = identity_path(db);
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() as u64 != reference.size_bytes || sha256_hex(&bytes) != reference.sha256 {
        return Err(format!(
            "{} does not match the manifest (size or SHA-256)",
            path.display()
        ));
    }
    let identity = HostIdentity::from_file_bytes(&bytes).map_err(|error| error.to_string())?;
    if identity.host_id() != host_id {
        return Err(format!(
            "{} is the identity of another host than the copy's",
            path.display()
        ));
    }
    if identity.fingerprint() != reference.fingerprint {
        return Err(format!(
            "{} holds another certificate than the manifest names",
            path.display()
        ));
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::install::{CommandOutput, InstallError};

    const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const OTHER: &str = "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d";
    const COPY: &str = "markiro-host-20261009T140000Z-7c1e2a9b.db";

    /// A fresh identity of `host_id`, as a host makes it on its first start.
    fn made(dir: &Path, host_id: &str) -> HostIdentity {
        let tls = TlsIdentity::load_or_create(dir, host_id).unwrap();
        HostIdentity::new(
            host_id.to_owned(),
            45710,
            tls.cert_der.clone(),
            tls.private_der().to_vec(),
        )
        .unwrap()
    }

    /// A folder that cannot be closed: a FAT32 flash drive, a share that
    /// refuses ACLs.
    struct Refusing;

    impl KeyFileGuard for Refusing {
        fn protect(&self, _path: &Path) -> Result<(), String> {
            Err("icacls ended with code 5".to_owned())
        }
    }

    type Calls = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    struct Recorded {
        code: i32,
        calls: Calls,
    }

    impl Commands for Recorded {
        fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_owned(), args.to_vec()));
            Ok(CommandOutput {
                code: Some(self.code),
                stdout: Vec::new(),
            })
        }
    }

    #[test]
    fn an_identity_file_reads_back_as_the_same_host() {
        let dir = tempfile::tempdir().unwrap();
        let identity = made(dir.path(), HOST);
        let read = HostIdentity::from_file_bytes(&identity.to_file_bytes()).unwrap();
        assert!(read.same_as(&identity));
        assert_eq!(
            (read.host_id(), read.port(), read.fingerprint()),
            (HOST, 45710, identity.fingerprint())
        );
        assert_eq!(
            read.config(),
            HostConfig {
                host_id: HOST.to_owned(),
                port: 45710
            }
        );
    }

    #[test]
    fn a_key_of_another_certificate_or_a_bad_host_id_is_no_identity() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = made(a.path(), HOST);
        let second = made(b.path(), OTHER);
        let new = |host_id: &str, port: u16, key: &[u8]| {
            HostIdentity::new(host_id.to_owned(), port, first.cert_der().to_vec(), key.to_vec())
        };
        assert!(matches!(
            new(HOST, 45710, second.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(matches!(
            new("host-1", 45710, first.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(matches!(
            new(HOST, 0, first.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(!first.same_as(&second));
    }

    #[test]
    fn nothing_prints_the_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let identity = made(dir.path(), HOST);
        let key = STANDARD.encode(identity.key_der());
        let printed = format!("{identity:?}");
        assert!(
            printed.contains(identity.fingerprint()) && !printed.contains(&key),
            "{printed}"
        );
        let mut damaged = identity.to_file_bytes();
        damaged.truncate(damaged.len() / 2);
        let error = HostIdentity::from_file_bytes(&damaged)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(&key[..16]), "{error}");
    }

    #[test]
    fn the_data_folders_identity_is_read_without_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(dir.path());
        assert!(matches!(
            HostIdentity::read(&paths),
            Err(IdentityError::Unreadable(_))
        ));
        assert!(
            fs::read_dir(dir.path()).unwrap().next().is_none(),
            "nothing was created"
        );
        paths.ensure().unwrap();
        let config = HostConfig::load_or_create(&paths, None).unwrap();
        assert!(
            matches!(HostIdentity::read(&paths), Err(IdentityError::Unreadable(_))),
            "no TLS files yet"
        );
        let tls = TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id).unwrap();
        let read = HostIdentity::read(&paths).unwrap();
        assert_eq!(
            (read.host_id(), read.fingerprint()),
            (config.host_id.as_str(), tls.fingerprint.as_str())
        );
    }

    #[test]
    fn an_identity_goes_beside_its_copy_only_when_it_could_be_closed() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        assert_eq!(attach(&db, &identity, &Refusing), None);
        assert!(
            fs::read_dir(copies.path()).unwrap().next().is_none(),
            "nothing of it is left"
        );
        let reference = attach(&db, &identity, &OwnerOnly).expect("written and closed");
        assert_eq!(reference.fingerprint, identity.fingerprint());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(identity_path(&db)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(read_beside(&db, HOST, &reference).unwrap().same_as(&identity));
        assert!(read_beside(&db, OTHER, &reference)
            .unwrap_err()
            .contains("another host"));
        let mut bytes = fs::read(identity_path(&db)).unwrap();
        bytes[10] ^= 1;
        fs::write(identity_path(&db), &bytes).unwrap();
        assert!(read_beside(&db, HOST, &reference)
            .unwrap_err()
            .contains("does not match the manifest"));
    }

    #[test]
    fn the_second_folder_gets_the_identity_only_as_the_manifest_names_it() {
        let keys = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let source = local.path().join(COPY);
        let target = second.path().join(COPY);
        let reference = attach(&source, &identity, &OwnerOnly).unwrap();
        assert_eq!(replicate(&source, &target, &reference, &Refusing), None);
        assert!(!identity_path(&target).exists());
        assert_eq!(
            replicate(&source, &target, &reference, &OwnerOnly),
            Some(reference.clone())
        );
        assert_eq!(
            fs::read(identity_path(&target)).unwrap(),
            fs::read(identity_path(&source)).unwrap()
        );
        let changed = IdentityRef {
            sha256: "0".repeat(64),
            ..reference
        };
        let elsewhere = second.path().join("markiro-host-20261009T150000Z-0d4f6b21.db");
        assert_eq!(replicate(&source, &elsewhere, &changed, &OwnerOnly), None);
        assert!(!identity_path(&elsewhere).exists());
    }

    #[test]
    fn windows_closes_the_key_file_to_all_but_system_the_administrators_and_its_owner() {
        let path = Path::new(
            r"\\ADMIN-PC\MarkiroCopies\markiro-host-20261009T140000Z-7c1e2a9b.identity.partial",
        );
        assert_eq!(
            key_file_acl_args(path),
            [
                path.display().to_string(),
                "/inheritance:r".to_owned(),
                "/grant:r".to_owned(),
                "*S-1-5-18:F".to_owned(),
                "*S-1-5-32-544:F".to_owned(),
                "*S-1-3-4:F".to_owned(),
            ]
        );
        let calls: Calls = Arc::default();
        let guard = IcaclsGuard::new(Recorded {
            code: 0,
            calls: calls.clone(),
        });
        guard.protect(path).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            [("icacls".to_owned(), key_file_acl_args(path))]
        );
        let refused = IcaclsGuard::new(Recorded {
            code: 1332,
            calls: Arc::default(),
        });
        assert_eq!(
            refused.protect(path).unwrap_err(),
            "icacls ended with code 1332"
        );
    }
}
```

- [ ] **Step 4: тесты модуля**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --lib backup::identity`
Expected: `test result: ok. 7 passed`.

- [ ] **Step 5: мутации (не коммитить)**

Для каждой: копия файла, правка, команда шага 4, возврат и `cmp`.

- В `same_as` убрать `&& self.key_der() == other.key_der()` — эквивалентный мутант: `HostIdentity` проверяет, что ключ подходит к сертификату, поэтому при одном сертификате ключ другим не бывает. Записать как эквивалентный, не убивать.
- В `KEY_FILE_GRANTS` заменить `"*S-1-3-4:F"` на `"*S-1-1-0:F"` (Все) — FAIL `windows_closes_the_key_file_to_all_but_system_the_administrators_and_its_owner`.
- В `put_file` убрать `guard.protect(&partial)?;` — FAIL `an_identity_goes_beside_its_copy_only_when_it_could_be_closed`.
- В `read_beside` убрать проверку `host_id` — FAIL тот же тест.

- [ ] **Step 6: формат и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `git diff --check` — молчит.

```bash
git add apps/standalone/host/src/backup/identity.rs apps/standalone/host/src/backup/mod.rs apps/standalone/host/src/tls.rs
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the host identity beside a copy — the .identity file and a guard that closes the private key (plan I1)` и строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 2: Копии несут удостоверение — манифест, работник, вторая папка, ротация, `hostIdentity`

**Files:**

- Modify: `apps/standalone/host/src/backup/copy.rs`, `folder.rs`, `worker.rs`
- Modify: `apps/standalone/proto/src/backup.rs`, `proto/fixtures/backup-state.json`, `proto/tests/backup.rs`
- Modify: `apps/standalone/src/host/backups.ts`, `test/backups.test.ts`, `test/support/backups.ts`
- Modify (tests): `apps/standalone/host/tests/support/backup.rs`, `host/tests/backup_copy.rs`, `host/tests/backup_worker.rs`, `host/tests/restore.rs`

**Interfaces:**

- `Manifest.identity: Option<IdentityRef>`; `Manifest::copy()` даёт `host_identity`.
- `pub async fn make_copy_with_identity(conn, dir, at, trigger, host_id, identity: Option<Arc<HostIdentity>>, guard: Arc<dyn KeyFileGuard>) -> Result<Manifest, Failure>`; `make_copy`/`make_copy_tagged` — как были (без удостоверения).
- `pub fn replicate_guarded(source_dir, manifest, dest_dir, guard: &dyn KeyFileGuard) -> Result<(), Failure>`; `replicate` — то же с `platform_guard()`.
- `Backups::new_with_guard(data_dir, local_dir, db_path, host_id, guard)`, поле `pub guard: Arc<dyn KeyFileGuard>`.
- `BackupCopy.host_identity: bool` (`hostIdentity`), Zod `hostIdentity: z.boolean()`.
- Тестовая помощь `support::backup::write_identity(dir, host_id) -> HostIdentity`.

- [ ] **Step 1: тестовая помощь и литералы `Manifest`**

В `apps/standalone/host/tests/support/backup.rs` фрагмент

```rust
use markiro_host::backup::copy::{copy_name, manifest_path, sha256_file, Manifest};
```

заменить на

```rust
use markiro_host::backup::copy::{copy_name, manifest_path, sha256_file, Manifest};
use markiro_host::backup::identity::HostIdentity;
use markiro_host::config::HostPaths;
```

В том же файле фрагмент

```rust
        schema_version: latest_migration(),
        size_bytes,
        sha256,
    };
```

заменить на

```rust
        schema_version: latest_migration(),
        size_bytes,
        sha256,
        identity: None,
    };
```

и в конец файла дописать

```rust

/// The host identity of the data folder `dir` as a host that started there
/// has it (plan I1): `host.json` (port 45710) and `tls/`.
pub fn write_identity(dir: &Path, host_id: &str) -> HostIdentity {
    let paths = HostPaths::new(dir);
    paths.ensure().unwrap();
    std::fs::write(
        paths.config_file(),
        serde_json::json!({ "hostId": host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), host_id).unwrap();
    HostIdentity::read(&paths).unwrap()
}
```

В `apps/standalone/host/tests/restore.rs` у литерала `let manifest = Manifest {` (около строки 1386) последним полем дописать `identity: None,` (по смыслу; литерал — единственный в файле).

- [ ] **Step 2: падающие тесты — копия и папка**

В `apps/standalone/host/tests/backup_copy.rs` фрагмент

```rust
use std::path::Path;
use std::time::Duration;
```

заменить на

```rust
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
```

и фрагмент

```rust
use markiro_host::backup::folder::{clean, list, probe, replicate, rotate};
use markiro_proto::backup::{dir_problems, failure, BackupTrigger};
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use support::app::{admin, Admin};
use support::backup::{at, fake_copy, latest_migration, names, worker_conn};
```

заменить на

```rust
use markiro_host::backup::copy::{make_copy_with_identity, Manifest};
use markiro_host::backup::folder::{clean, list, probe, replicate, replicate_guarded, rotate};
use markiro_host::backup::identity::{identity_path, HostIdentity, KeyFileGuard, OwnerOnly};
use markiro_host::config::HostPaths;
use markiro_proto::backup::{dir_problems, failure, BackupTrigger};
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use support::app::{admin, Admin};
use support::backup::{at, fake_copy, latest_migration, names, worker_conn, write_identity};
```

(Если `cargo fmt` переставит импорты `markiro_host::backup::copy::…`, принять его порядок.)

и в конец файла дописать

```rust

const IDENTITY_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/// A folder that cannot be closed: a FAT32 flash drive, a share that
/// refuses ACLs.
struct Refusing;

impl KeyFileGuard for Refusing {
    fn protect(&self, _path: &Path) -> Result<(), String> {
        Err("icacls ended with code 5".to_owned())
    }
}

/// A copy of `admin`'s database in `dir` with the host identity of its data
/// folder beside it (plan I1).
async fn copy_with_identity(admin: &Admin, dir: &Path, guard: Arc<dyn KeyFileGuard>) -> Manifest {
    write_identity(admin.app.dir(), IDENTITY_HOST);
    let identity = HostIdentity::read(&HostPaths::new(admin.app.dir())).unwrap();
    let mut conn = worker_conn(&admin.app).await;
    make_copy_with_identity(
        &mut conn,
        dir,
        at(CREATED),
        BackupTrigger::Scheduled,
        IDENTITY_HOST,
        Some(Arc::new(identity)),
        guard,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_copy_carries_the_host_identity_beside_it_closed_to_others() {
    let admin = admin().await;
    let dir = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, dir.path(), Arc::new(OwnerOnly)).await;
    let db = dir.path().join(&manifest.file);
    assert_eq!(
        names(dir.path()),
        [
            manifest.file.clone(),
            manifest.file.replace(".db", ".identity"),
            manifest.file.replace(".db", ".json"),
        ]
    );
    let source = HostIdentity::read(&HostPaths::new(admin.app.dir())).unwrap();
    let reference = manifest.identity.clone().expect("the manifest names it");
    assert_eq!(reference.fingerprint, source.fingerprint());
    assert_eq!(read_manifest(&db).unwrap(), manifest);
    let beside = HostIdentity::from_file_bytes(&std::fs::read(identity_path(&db)).unwrap()).unwrap();
    assert!(beside.same_as(&source));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(identity_path(&db)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(list(dir.path()).unwrap()[0].copy().host_identity);
    // A copy whose identity file is gone is listed without it.
    std::fs::remove_file(identity_path(&db)).unwrap();
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn a_folder_that_cannot_be_closed_gets_the_copy_without_the_identity() {
    let admin = admin().await;
    let dir = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, dir.path(), Arc::new(Refusing)).await;
    assert_eq!(manifest.identity, None);
    assert_eq!(
        names(dir.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn the_second_folder_gets_the_identity_or_a_manifest_without_it() {
    let admin = admin().await;
    let local = tempfile::tempdir().unwrap();
    let closed = tempfile::tempdir().unwrap();
    let open = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, local.path(), Arc::new(OwnerOnly)).await;
    replicate_guarded(local.path(), &manifest, closed.path(), &OwnerOnly).unwrap();
    assert_eq!(names(closed.path()), names(local.path()));
    assert_eq!(
        read_manifest(&closed.path().join(&manifest.file)).unwrap(),
        manifest
    );
    replicate_guarded(local.path(), &manifest, open.path(), &Refusing).unwrap();
    assert_eq!(
        names(open.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    let there = read_manifest(&open.path().join(&manifest.file)).unwrap();
    assert_eq!(there.identity, None);
    assert_eq!(
        Manifest {
            identity: manifest.identity.clone(),
            ..there
        },
        manifest,
        "only the identity differs"
    );
}

#[test]
fn rotation_and_cleaning_take_the_identity_with_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    // 26 copies of one hour: the rule keeps the newest 24.
    let copies: Vec<_> = (0..26)
        .map(|minute| {
            let manifest = fake_copy(
                dir.path(),
                &format!("2026-10-09T10:{minute:02}:00Z"),
                &format!("{minute:08x}"),
            );
            std::fs::write(identity_path(&dir.path().join(&manifest.file)), b"identity").unwrap();
            manifest
        })
        .collect();
    let staying = rotate(dir.path(), None).unwrap();
    assert_eq!(staying.len(), 24);
    for gone in &copies[..2] {
        assert!(!identity_path(&dir.path().join(&gone.file)).exists());
    }
    for kept in &copies[2..] {
        assert!(identity_path(&dir.path().join(&kept.file)).exists());
    }
    // An identity whose copy lost its manifest is a leftover.
    let orphan = dir.path().join("markiro-host-20261009T090000Z-deadbeef.identity");
    std::fs::write(&orphan, b"identity").unwrap();
    assert_eq!(clean(dir.path()).unwrap(), 1);
    assert!(!orphan.exists());
    assert!(identity_path(&dir.path().join(&copies[25].file)).exists());
}
```

В `apps/standalone/host/tests/backup_worker.rs` фрагмент

```rust
use support::backup::{at, fake_copy, names};
```

заменить на

```rust
use support::backup::{at, fake_copy, names, write_identity};
```

и в конец файла дописать

```rust

/// Plan I1: the worker reads the data folder's identity before each copy and
/// puts it beside the copy in both folders.
#[tokio::test]
async fn the_worker_puts_the_host_identity_beside_each_copy_in_both_folders() {
    let admin = admin().await;
    write_identity(admin.app.dir(), HOST_ID);
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let made = worker.tick().await.unwrap().local.unwrap();
    assert!(made.identity.is_some());
    assert_eq!(
        names(&second),
        [
            made.file.clone(),
            made.file.replace(".db", ".identity"),
            made.file.replace(".db", ".json"),
        ]
    );
    let status = state(&admin, &backups, Some(&second));
    assert!(status.local.copies[0].host_identity);
    assert!(status.second.unwrap().copies[0].host_identity);
}

/// An identity that names another host than the worker's stays out of the
/// copy: a data folder that was mixed up says nothing of this host.
#[tokio::test]
async fn an_identity_of_another_host_stays_out_of_the_copy() {
    let admin = admin().await;
    write_identity(admin.app.dir(), "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d");
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let made = worker(&admin, &backups).tick().await.unwrap().local.unwrap();
    assert_eq!(made.identity, None);
    assert!(!names(&local).iter().any(|name| name.ends_with(".identity")));
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test backup_copy --test backup_worker`
Expected: не собирается (`make_copy_with_identity`, `replicate_guarded`, `identity`, `host_identity` не существуют).

- [ ] **Step 3: `proto` — `hostIdentity`**

В `apps/standalone/proto/src/backup.rs` фрагмент

```rust
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    pub sha256: String,
}
```

(первое вхождение — `BackupCopy`) заменить на

```rust
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    pub sha256: String,
    /// The host's identity lies beside the copy (plan I1): restored on a new
    /// computer, it keeps every device's pairing.
    #[serde(default)]
    pub host_identity: bool,
}
```

В `apps/standalone/proto/fixtures/backup-state.json` первой копии `local.copies` после `"sha256": "9f2b…2c1b"` дописать `"hostIdentity": true`, второй (`…0d4f6b21.db`) — `"hostIdentity": false` (через запятую после `sha256`).

В `apps/standalone/proto/tests/backup.rs` фрагмент

```rust
    assert_eq!(state.local.copies[1].trigger, BackupTrigger::Manual);
```

заменить на

```rust
    assert_eq!(state.local.copies[1].trigger, BackupTrigger::Manual);
    assert!(state.local.copies[0].host_identity);
    assert!(!state.local.copies[1].host_identity);
```

В `apps/standalone/src/host/backups.ts` фрагмент

<!-- prettier-ignore -->
```ts
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type BackupCopy = z.infer<typeof backupCopySchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  /** The host's identity lies beside the copy (plan I1): on a new computer the devices keep their pairing. */
  hostIdentity: z.boolean(),
});
export type BackupCopy = z.infer<typeof backupCopySchema>;
```

В `apps/standalone/test/support/backups.ts` фрагмент

<!-- prettier-ignore -->
```ts
    sha256: "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
    sha256: "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
    hostIdentity: true,
  };
}
```

В `apps/standalone/test/backups.test.ts` фрагмент

<!-- prettier-ignore -->
```ts
    expect(state.local.copies.map((copy) => copy.trigger)).toEqual(["scheduled", "manual"]);
```

заменить на

<!-- prettier-ignore -->
```ts
    expect(state.local.copies.map((copy) => copy.trigger)).toEqual(["scheduled", "manual"]);
    expect(state.local.copies.map((copy) => copy.hostIdentity)).toEqual([true, false]);
```

- [ ] **Step 4: `copy.rs` — манифест и копия с удостоверением**

В `apps/standalone/host/src/backup/copy.rs`:

Фрагмент

```rust
//! inherits the ACL of its folder, which the installer hardens for the data
//! folder and the administrator chooses for the second one.
```

заменить на

```rust
//! inherits the ACL of its folder, which the installer hardens for the data
//! folder and the administrator chooses for the second one. The host
//! identity beside a copy (`<name>.identity`, plan I1) holds the TLS private
//! key and is closed explicitly (`super::identity`).
```

Фрагмент

```rust
use std::path::{Path, PathBuf};

use aws_lc_rs::digest::{Context, SHA256};
```

заменить на

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_lc_rs::digest::{Context, SHA256};
```

Фрагмент

```rust
use crate::clock::format_timestamp;
```

заменить на

```rust
use super::identity::{identity_path, HostIdentity, IdentityRef, KeyFileGuard};
use crate::clock::format_timestamp;
```

Фрагмент

```rust
    pub size_bytes: u64,
    pub sha256: String,
}

impl Manifest {
    pub fn copy(&self) -> BackupCopy {
        BackupCopy {
            file: self.file.clone(),
            created_at: self.created_at.clone(),
            trigger: self.trigger,
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
        }
    }
}
```

заменить на

```rust
    pub size_bytes: u64,
    pub sha256: String,
    /// The host identity beside the copy (`<name>.identity`, plan I1);
    /// `None` for a copy without one: an older build's, or one whose folder
    /// could not be closed to others. Optional, so the format stays 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityRef>,
}

impl Manifest {
    pub fn copy(&self) -> BackupCopy {
        BackupCopy {
            file: self.file.clone(),
            created_at: self.created_at.clone(),
            trigger: self.trigger,
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
            host_identity: self.identity.is_some(),
        }
    }
}
```

Фрагмент (функция `make_copy_tagged` целиком)

```rust
pub async fn make_copy_tagged(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    tag: &str,
) -> Result<Manifest, Failure> {
    let name = copy_name(at, tag);
```

заменить на

```rust
pub async fn make_copy_tagged(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    tag: &str,
) -> Result<Manifest, Failure> {
    make_copy_in(conn, dir, at, trigger, host_id, tag, None).await
}

/// [`make_copy`] with the host's identity beside the copy (plan I1):
/// `<name>.identity`, closed by `guard`, named in the manifest. A folder the
/// guard cannot close gets the copy without it (its manifest names none):
/// the copy never fails for the identity.
pub async fn make_copy_with_identity(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    identity: Option<Arc<HostIdentity>>,
    guard: Arc<dyn KeyFileGuard>,
) -> Result<Manifest, Failure> {
    let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    let identity = identity.map(|identity| (identity, guard));
    make_copy_in(conn, dir, at, trigger, host_id, &tag, identity).await
}

/// An identity and the guard that closes it beside a copy.
type Attached = Option<(Arc<HostIdentity>, Arc<dyn KeyFileGuard>)>;

async fn make_copy_in(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    tag: &str,
    identity: Attached,
) -> Result<Manifest, Failure> {
    let name = copy_name(at, tag);
```

Фрагмент

```rust
    let made = write_copy(conn, &db, &partial, &name, at, trigger, host_id).await;
    if made.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&db);
        let _ = fs::remove_file(partial_path(&manifest_path(&db)));
    }
    made
}

async fn write_copy(
    conn: &mut SqliteConnection,
    db: &Path,
    partial: &Path,
    name: &str,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
) -> Result<Manifest, Failure> {
```

заменить на

```rust
    let made = write_copy(conn, &db, &partial, &name, at, trigger, host_id, identity).await;
    if made.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&db);
        let _ = fs::remove_file(partial_path(&manifest_path(&db)));
        let _ = fs::remove_file(identity_path(&db));
        let _ = fs::remove_file(partial_path(&identity_path(&db)));
    }
    made
}

#[allow(clippy::too_many_arguments)]
async fn write_copy(
    conn: &mut SqliteConnection,
    db: &Path,
    partial: &Path,
    name: &str,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    identity: Attached,
) -> Result<Manifest, Failure> {
```

Фрагмент (конец `write_copy`)

```rust
        schema_version,
        size_bytes,
        sha256,
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    let (partial, db) = (partial.to_path_buf(), db.to_path_buf());
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        sync_file(&partial)?;
        fs::rename(&partial, &db)?;
        write_synced(&manifest_path(&db), &bytes)
    })
    .await
    .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
    .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    Ok(manifest)
}
```

заменить на

```rust
        schema_version,
        size_bytes,
        sha256,
        identity: None,
    };
    let (partial, db) = (partial.to_path_buf(), db.to_path_buf());
    tokio::task::spawn_blocking(move || -> std::io::Result<Manifest> {
        sync_file(&partial)?;
        fs::rename(&partial, &db)?;
        // The identity before the manifest, which names it: a copy is a copy
        // only once its manifest is there.
        let identity = identity.as_ref().and_then(|(identity, guard)| {
            super::identity::attach(&db, identity, guard.as_ref())
        });
        let manifest = Manifest {
            identity,
            ..manifest
        };
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
        write_synced(&manifest_path(&db), &bytes)?;
        Ok(manifest)
    })
    .await
    .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
    .map_err(|error| Failure::new(classify_io(&error), error.to_string()))
}
```

- [ ] **Step 5: `folder.rs` — список, очистка, ротация, вторая папка**

В `apps/standalone/host/src/backup/folder.rs`:

Фрагмент

```rust
use super::retention;
use crate::clock::parse_timestamp;
```

заменить на

```rust
use super::identity::{identity_path, platform_guard, KeyFileGuard};
use super::retention;
use crate::clock::parse_timestamp;
```

Фрагмент

```rust
        if metadata.len() != manifest.size_bytes || parse_timestamp(&manifest.created_at).is_err() {
            continue;
        }
        copies.push(manifest);
```

заменить на

```rust
        if metadata.len() != manifest.size_bytes || parse_timestamp(&manifest.created_at).is_err() {
            continue;
        }
        // An identity the manifest names but the folder lacks is none.
        let mut manifest = manifest;
        if let Some(identity) = &manifest.identity {
            let beside = fs::metadata(identity_path(&path))
                .is_ok_and(|metadata| metadata.len() == identity.size_bytes);
            if !beside {
                manifest.identity = None;
            }
        }
        copies.push(manifest);
```

Фрагмент

```rust
        let broken =
            name.ends_with(".partial") || (name.ends_with(".db") && !manifest_path(&path).exists());
```

заменить на

```rust
        // An identity whose copy lost its manifest (plan I1) is a leftover
        // too: `<name>.identity` beside no `<name>.json`.
        let broken = name.ends_with(".partial")
            || (name.ends_with(".db") && !manifest_path(&path).exists())
            || (name.ends_with(".identity") && !path.with_extension("json").exists());
```

Фрагмент

```rust
        let db = dir.join(&copy.file);
        fs::remove_file(manifest_path(&db))?;
        fs::remove_file(&db)?;
```

заменить на

```rust
        let db = dir.join(&copy.file);
        fs::remove_file(manifest_path(&db))?;
        match fs::remove_file(identity_path(&db)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::remove_file(&db)?;
```

Фрагмент

```rust
pub fn replicate(source_dir: &Path, manifest: &Manifest, dest_dir: &Path) -> Result<(), Failure> {
    if !is_copy_file_name(&manifest.file) {
```

заменить на

```rust
pub fn replicate(source_dir: &Path, manifest: &Manifest, dest_dir: &Path) -> Result<(), Failure> {
    replicate_guarded(source_dir, manifest, dest_dir, platform_guard().as_ref())
}

/// [`replicate`] with the guard that closes the host identity beside the
/// copy (plan I1): a folder it cannot close gets the copy and a manifest
/// that names no identity.
pub fn replicate_guarded(
    source_dir: &Path,
    manifest: &Manifest,
    dest_dir: &Path,
    guard: &dyn KeyFileGuard,
) -> Result<(), Failure> {
    if !is_copy_file_name(&manifest.file) {
```

Фрагмент

```rust
    let copied = copy_and_check(&source, &partial, &target, manifest, &mut renamed);
    if copied.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(partial_path(&manifest_path(&target)));
        if renamed && !was_there {
            let _ = fs::remove_file(&target);
        }
    }
    copied
}

fn copy_and_check(
    source: &Path,
    partial: &Path,
    target: &Path,
    manifest: &Manifest,
    renamed: &mut bool,
) -> Result<(), Failure> {
```

заменить на

```rust
    let copied = copy_and_check(&source, &partial, &target, manifest, &mut renamed, guard);
    if copied.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(partial_path(&manifest_path(&target)));
        let _ = fs::remove_file(partial_path(&identity_path(&target)));
        if renamed && !was_there {
            let _ = fs::remove_file(&target);
            let _ = fs::remove_file(identity_path(&target));
        }
    }
    copied
}

fn copy_and_check(
    source: &Path,
    partial: &Path,
    target: &Path,
    manifest: &Manifest,
    renamed: &mut bool,
    guard: &dyn KeyFileGuard,
) -> Result<(), Failure> {
```

Фрагмент (конец `copy_and_check`)

```rust
    fs::rename(partial, target).map_err(io)?;
    *renamed = true;
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    write_synced(&manifest_path(target), &bytes).map_err(io)
}
```

заменить на

```rust
    fs::rename(partial, target).map_err(io)?;
    *renamed = true;
    // The identity before the manifest; the manifest of this folder names it
    // only when it is here and closed.
    let identity = manifest
        .identity
        .as_ref()
        .and_then(|reference| super::identity::replicate(source, target, reference, guard));
    let manifest = Manifest {
        identity,
        ..manifest.clone()
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    write_synced(&manifest_path(target), &bytes).map_err(io)
}
```

- [ ] **Step 6: `worker.rs` — удостоверение перед каждой копией**

В `apps/standalone/host/src/backup/worker.rs`:

Фрагмент

```rust
use super::copy::{make_copy, Failure, Manifest};
use super::folder;
```

заменить на

```rust
use super::copy::{make_copy_with_identity, Failure, Manifest};
use super::folder;
use super::identity::{platform_guard, HostIdentity, KeyFileGuard};
```

Фрагмент

```rust
pub struct Backups {
    pub data_dir: PathBuf,
    pub local_dir: PathBuf,
    pub db_path: PathBuf,
    pub host_id: String,
    status: Mutex<Status>,
    wake: Notify,
}
```

заменить на

```rust
pub struct Backups {
    pub data_dir: PathBuf,
    pub local_dir: PathBuf,
    pub db_path: PathBuf,
    pub host_id: String,
    /// Closes the host identity beside each copy (plan I1).
    pub guard: Arc<dyn KeyFileGuard>,
    status: Mutex<Status>,
    wake: Notify,
}
```

Фрагмент

```rust
    pub fn new(
        data_dir: PathBuf,
        local_dir: PathBuf,
        db_path: PathBuf,
        host_id: impl Into<String>,
    ) -> Arc<Self> {
        let local = FolderStatus::new(local_dir.display().to_string());
        Arc::new(Self {
            data_dir,
            local_dir,
            db_path,
            host_id: host_id.into(),
```

заменить на

```rust
    pub fn new(
        data_dir: PathBuf,
        local_dir: PathBuf,
        db_path: PathBuf,
        host_id: impl Into<String>,
    ) -> Arc<Self> {
        Self::new_with_guard(data_dir, local_dir, db_path, host_id, platform_guard())
    }

    /// [`Self::new`] with the guard that closes the host identity beside
    /// each copy (a test's own).
    pub fn new_with_guard(
        data_dir: PathBuf,
        local_dir: PathBuf,
        db_path: PathBuf,
        host_id: impl Into<String>,
        guard: Arc<dyn KeyFileGuard>,
    ) -> Arc<Self> {
        let local = FolderStatus::new(local_dir.display().to_string());
        Arc::new(Self {
            data_dir,
            local_dir,
            db_path,
            host_id: host_id.into(),
            guard,
```

Фрагмент

```rust
    let local = make_copy(&mut conn, &backups.local_dir, at, trigger, &backups.host_id).await;
```

заменить на

```rust
    // The data folder's identity, read before each copy (it may have been
    // put back by a restore since the host started); a copy goes without it
    // when it does not read or names another host.
    let identity = {
        let paths = HostPaths::new(backups.data_dir.clone());
        match tokio::task::spawn_blocking(move || HostIdentity::read(&paths)).await {
            Ok(Ok(identity)) if identity.host_id() == backups.host_id => Some(Arc::new(identity)),
            Ok(Ok(_)) => {
                tracing::warn!("the host identity names another host: the copy goes without it");
                None
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "the host identity did not read: the copy goes without it");
                None
            }
            Err(_) => None,
        }
    };
    let local = make_copy_with_identity(
        &mut conn,
        &backups.local_dir,
        at,
        trigger,
        &backups.host_id,
        identity,
        backups.guard.clone(),
    )
    .await;
```

Фрагмент

```rust
    let second = second_dir.clone();
    let folders = tokio::task::spawn_blocking(move || {
```

заменить на

```rust
    let second = second_dir.clone();
    let guard = backups.guard.clone();
    let folders = tokio::task::spawn_blocking(move || {
```

Фрагмент

```rust
                    .and_then(|_| folder::replicate(&local_dir, manifest, &dir)),
```

заменить на

```rust
                    .and_then(|_| folder::replicate_guarded(&local_dir, manifest, &dir, guard.as_ref())),
```

- [ ] **Step 7: прогон**

Run:

- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test backup_copy --test backup_worker --test restore --test backup_routes`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-proto --test backup`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --lib`
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts test/backup-warnings.test.ts test/backups-page.test.tsx`
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: всё зелёное; `backup_copy` +4, `backup_worker` +2.

- [ ] **Step 8: мутации (не коммитить)**

- В `copy_and_check` писать в папку исходный `manifest` вместо `Manifest { identity, ..}` — FAIL `the_second_folder_gets_the_identity_or_a_manifest_without_it`.
- В `rotate` убрать удаление `identity_path(&db)` — FAIL `rotation_and_cleaning_take_the_identity_with_its_copy`.
- В `run_once` убрать условие `identity.host_id() == backups.host_id` (брать любое) — FAIL `an_identity_of_another_host_stays_out_of_the_copy`.
- В `list` не сбрасывать `manifest.identity` при отсутствующем файле — FAIL `a_copy_carries_the_host_identity_beside_it_closed_to_others`.

- [ ] **Step 9: формат и коммит**

`cargo fmt … -- --check`; prettier на `apps/standalone/src/host/backups.ts apps/standalone/test/backups.test.ts apps/standalone/test/support/backups.ts apps/standalone/proto/fixtures/backup-state.json`; `git diff --check`.

```bash
git add apps/standalone/host/src/backup/copy.rs apps/standalone/host/src/backup/folder.rs apps/standalone/host/src/backup/worker.rs apps/standalone/proto/src/backup.rs apps/standalone/proto/fixtures/backup-state.json apps/standalone/proto/tests/backup.rs apps/standalone/src/host/backups.ts apps/standalone/test/backups.test.ts apps/standalone/test/support/backups.ts apps/standalone/host/tests/support/backup.rs apps/standalone/host/tests/backup_copy.rs apps/standalone/host/tests/backup_worker.rs apps/standalone/host/tests/restore.rs
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): every copy carries the host identity — the manifest names it, the second folder gets it closed or not at all, rotation takes it along (plan I1)` и трейлер.

---

### Task 3: Проверка копии читает удостоверение; правило `identity_plan`; `verify-copy`

**Files:**

- Modify: `apps/standalone/host/src/restore.rs`, `apps/standalone/host/src/main.rs`, `apps/standalone/host/tests/restore.rs`

**Interfaces:**

- `pub enum CopyIdentity { Absent, Present(Arc<HostIdentity>), Damaged(String) }`; `VerifiedCopy.identity: CopyIdentity`.
- `pub enum IdentityChoice { Auto, Keep, Take }`; `enum IdentityPlan { Same, Install, KeepFolder, Create }` (внутренний); `fn identity_plan(copy, folder: Option<Result<&HostIdentity, &str>>, established, choice) -> Result<IdentityPlan, String>`.

- [ ] **Step 1: падающий тест `verify_copy`**

В `apps/standalone/host/tests/restore.rs` фрагмент

```rust
use std::path::{Path, PathBuf};
```

заменить на

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;
```

и фрагмент

```rust
use markiro_host::backup::copy::{make_copy, manifest_path, sha256_file, Manifest};
use markiro_host::config::HostPaths;
use markiro_host::restore::{
    restore, restore_crashing, summary, verify_copy, Carried, CrashPoint, Current, Interrupted,
    RestoreReport, SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
```

заменить на

```rust
use markiro_host::backup::copy::{
    make_copy, make_copy_with_identity, manifest_path, sha256_file, Manifest,
};
use markiro_host::backup::identity::{identity_path, platform_guard, HostIdentity};
use markiro_host::config::HostPaths;
use markiro_host::restore::{
    restore, restore_crashing, summary, verify_copy, Carried, CopyIdentity, CrashPoint, Current,
    Interrupted, RestoreReport, SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
```

Фрагмент

```rust
use support::backup::{at, latest_migration, names, worker_conn};
```

заменить на

```rust
use support::backup::{at, latest_migration, names, worker_conn, write_identity};
```

После функции `copy` (перед `/// Stop using the app's database as a service that stopped cleanly has:`) вставить

```rust
/// A verified copy of `app`'s database with its data folder's host identity
/// beside it (plan I1), and that identity.
async fn copy_with_identity(app: &TestApp) -> (PathBuf, Manifest, HostIdentity) {
    let identity = write_identity(app.dir(), &app.state.host_id);
    let folder = app.dir().join("backups");
    let mut conn = worker_conn(app).await;
    let manifest = make_copy_with_identity(
        &mut conn,
        &folder,
        app.state.now(),
        BackupTrigger::Scheduled,
        &app.state.host_id,
        Some(Arc::new(HostIdentity::read(&HostPaths::new(app.dir())).unwrap())),
        platform_guard(),
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    assert!(manifest.identity.is_some(), "the copy carries the identity");
    (folder.join(&manifest.file), manifest, identity)
}
```

В конец файла дописать

```rust

/// Plan I1: `verify_copy` reads the identity the manifest names, says when it
/// is damaged, and reads none with `--without-manifest` or beside a copy
/// without one.
#[tokio::test]
async fn verify_copy_reads_the_identity_beside_a_copy_as_its_manifest_names_it() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert!(
        matches!(&verified.identity, CopyIdentity::Present(identity) if identity.same_as(&source))
    );
    assert!(matches!(
        verify_copy(&copy_path, true).await.unwrap().identity,
        CopyIdentity::Absent
    ));
    std::fs::remove_file(identity_path(&copy_path)).unwrap();
    assert!(matches!(
        verify_copy(&copy_path, false).await.unwrap().identity,
        CopyIdentity::Damaged(_)
    ));
    let (plain, _) = copy(&admin.app).await;
    assert!(matches!(
        verify_copy(&plain, false).await.unwrap().identity,
        CopyIdentity::Absent
    ));
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test restore verify_copy_reads`
Expected: не собирается (`CopyIdentity`, `identity` нет).

- [ ] **Step 2: типы и чтение в `restore.rs`**

В `apps/standalone/host/src/restore.rs`:

Фрагмент

```rust
use crate::clock::{format_timestamp, parse_timestamp};
use crate::config::{ConfigError, HostConfig, HostPaths};
```

заменить на

```rust
use crate::backup::identity::{read_beside, HostIdentity};
use crate::clock::{format_timestamp, parse_timestamp};
use crate::config::{ConfigError, HostConfig, HostPaths};
```

Фрагмент

```rust
    /// A WAL with frames lay beside the copy (`--without-manifest` only): its
    /// commits were folded into a private copy, which is what is put in place.
    pub wal_folded: bool,
    staged: Arc<Source>,
}
```

заменить на

```rust
    /// A WAL with frames lay beside the copy (`--without-manifest` only): its
    /// commits were folded into a private copy, which is what is put in place.
    pub wal_folded: bool,
    /// The host identity beside the copy (plan I1).
    pub identity: CopyIdentity,
    staged: Arc<Source>,
}

/// The host identity beside a copy (plan I1), as `verify_copy` found it.
#[derive(Debug, Clone)]
pub enum CopyIdentity {
    /// None: an older build's copy, one whose folder could not be closed, or
    /// `--without-manifest`, which reads none.
    Absent,
    Present(Arc<HostIdentity>),
    /// The manifest names one, but the file is missing, changed or unusable.
    Damaged(String),
}

/// What `markiro-host restore` does with the copy's host identity (plan I1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityChoice {
    /// The copy's identity wherever no paired device can lose its host: a
    /// data folder without one, or one whose host never finished its wizard
    /// (the installer's). Refused over a working host of another identity.
    Auto,
    /// `--keep-identity`: never the copy's; the data folder keeps its own (or
    /// gets a new one), and every device pairs again.
    Keep,
    /// `--take-identity`: the copy's, also over a working host of another
    /// identity (whose devices then pair again).
    Take,
}

/// What a restore does with the host identity, decided before anything
/// moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdentityPlan {
    /// The data folder already has the copy's identity.
    Same,
    /// The copy's identity goes into place.
    Install,
    /// The data folder keeps its own.
    KeepFolder,
    /// No identity anywhere: a new one is created.
    Create,
}

impl IdentityPlan {
    /// The word of the `host.restore` audit row.
    fn audit_word(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::Install => "restored",
            Self::KeepFolder => "kept",
            Self::Create => "created",
        }
    }
}

/// The rule of plan I1. `folder`: the data folder's identity when it has a
/// `host.json` (`Err` when its TLS files do not read); `established`: the
/// current database is a working host's (read with its wizard done, or
/// unreadable).
fn identity_plan(
    copy: &CopyIdentity,
    folder: Option<Result<&HostIdentity, &str>>,
    established: bool,
    choice: IdentityChoice,
) -> Result<IdentityPlan, String> {
    let own = if folder.is_some() {
        IdentityPlan::KeepFolder
    } else {
        IdentityPlan::Create
    };
    let copied = match copy {
        CopyIdentity::Present(identity) => identity.as_ref(),
        CopyIdentity::Absent if choice == IdentityChoice::Take => {
            return Err("the copy carries no host identity (an older copy, one checked with --without-manifest, or one whose folder could not be closed to others): restore it without --take-identity; every device pairs again".to_owned());
        }
        CopyIdentity::Damaged(reason) if choice != IdentityChoice::Keep => {
            return Err(format!(
                "the host identity beside the copy is damaged ({reason}): restore with --keep-identity to put the data back without it (every device pairs again), or take another copy"
            ));
        }
        CopyIdentity::Absent | CopyIdentity::Damaged(_) => return Ok(own),
    };
    match folder {
        Some(Ok(folder)) if folder.same_as(copied) => Ok(IdentityPlan::Same),
        _ if choice == IdentityChoice::Keep => Ok(own),
        None => Ok(IdentityPlan::Install),
        Some(_) if !established || choice == IdentityChoice::Take => Ok(IdentityPlan::Install),
        Some(Ok(folder)) => Err(format!(
            "this data folder is host {folder_host} and its database is a working host's, while the copy is host {copy_host}: run the command again with --take-identity to make this computer host {copy_host} (the devices paired with host {folder_host} pair again), or with --keep-identity to put the copy's data back under host {folder_host} (every device pairs again)",
            folder_host = folder.host_id(),
            copy_host = copied.host_id(),
        )),
        Some(Err(reason)) => Err(format!(
            "this data folder's host identity does not read ({reason}) and its database is a working host's: run the command again with --take-identity to put the copy's identity (host {}) in place, or with --keep-identity",
            copied.host_id()
        )),
    }
}
```

Фрагмент в `verify_copy`

```rust
    if let Some(manifest) = &manifest {
        if manifest.size_bytes != size_bytes || manifest.sha256 != sha256 {
            return Err(format!(
                "{} does not match its manifest (size or SHA-256): the copy is damaged",
                path.display()
            )
            .into());
        }
    }
```

заменить на

```rust
    if let Some(manifest) = &manifest {
        if manifest.size_bytes != size_bytes || manifest.sha256 != sha256 {
            return Err(format!(
                "{} does not match its manifest (size or SHA-256): the copy is damaged",
                path.display()
            )
            .into());
        }
    }
    // The identity the manifest names (plan I1); a damaged one does not make
    // the copy fail here: the restore decides (`identity_plan`).
    let identity = match manifest.as_ref() {
        Some(Manifest {
            identity: Some(reference),
            host_id,
            ..
        }) => {
            let (db, host_id, reference) = (path.to_path_buf(), host_id.clone(), reference.clone());
            match tokio::task::spawn_blocking(move || read_beside(&db, &host_id, &reference)).await? {
                Ok(identity) => CopyIdentity::Present(Arc::new(identity)),
                Err(reason) => CopyIdentity::Damaged(reason),
            }
        }
        _ => CopyIdentity::Absent,
    };
```

Фрагмент (в конце `verify_copy`)

```rust
        schema_version,
        wal_folded: source._folder.is_some(),
        staged: Arc::new(source),
    })
}
```

заменить на

```rust
        schema_version,
        wal_folded: source._folder.is_some(),
        identity,
        staged: Arc::new(source),
    })
}
```

В самый конец файла `restore.rs` дописать модуль тестов правила:

```rust

#[cfg(test)]
mod identity_tests {
    use super::*;

    const A: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const B: &str = "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d";

    fn host(dir: &Path, host_id: &str) -> HostIdentity {
        let tls = crate::tls::TlsIdentity::load_or_create(dir, host_id).unwrap();
        HostIdentity::new(
            host_id.to_owned(),
            45710,
            tls.cert_der.clone(),
            tls.private_der().to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn the_copys_identity_goes_only_where_no_paired_device_loses_its_host() {
        use IdentityChoice::{Auto, Keep, Take};
        use IdentityPlan::{Create, Install, KeepFolder, Same};
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let copied = CopyIdentity::Present(Arc::new(host(a_dir.path(), A)));
        // The same files read again: the same host.
        let same = host(a_dir.path(), A);
        let other = host(b_dir.path(), B);
        let plan = identity_plan;
        for choice in [Auto, Take] {
            assert_eq!(plan(&copied, None, false, choice), Ok(Install));
            assert_eq!(plan(&copied, Some(Ok(&same)), true, choice), Ok(Same));
            assert_eq!(plan(&copied, Some(Ok(&other)), false, choice), Ok(Install));
            assert_eq!(plan(&copied, Some(Err("tls")), false, choice), Ok(Install));
        }
        // A working host of another identity: only on the engineer's word.
        let refused = plan(&copied, Some(Ok(&other)), true, Auto).unwrap_err();
        assert!(
            refused.contains("--take-identity") && refused.contains("--keep-identity"),
            "{refused}"
        );
        assert!(plan(&copied, Some(Err("tls")), true, Auto).is_err());
        assert_eq!(plan(&copied, Some(Ok(&other)), true, Take), Ok(Install));
        assert_eq!(plan(&copied, Some(Err("tls")), true, Take), Ok(Install));
        // --keep-identity never takes the copy's.
        assert_eq!(plan(&copied, Some(Ok(&other)), true, Keep), Ok(KeepFolder));
        assert_eq!(plan(&copied, Some(Ok(&same)), true, Keep), Ok(Same));
        assert_eq!(plan(&copied, None, false, Keep), Ok(Create));
        // A copy without one: as before plan I1.
        assert_eq!(plan(&CopyIdentity::Absent, None, false, Auto), Ok(Create));
        assert_eq!(
            plan(&CopyIdentity::Absent, Some(Ok(&other)), true, Auto),
            Ok(KeepFolder)
        );
        assert!(plan(&CopyIdentity::Absent, None, false, Take)
            .unwrap_err()
            .contains("carries no host identity"));
        // A damaged one: refused unless kept out.
        let damaged = CopyIdentity::Damaged("changed".to_owned());
        assert!(plan(&damaged, None, false, Auto)
            .unwrap_err()
            .contains("--keep-identity"));
        assert!(plan(&damaged, None, false, Take).is_err());
        assert_eq!(plan(&damaged, Some(Ok(&other)), false, Keep), Ok(KeepFolder));
    }
}
```

- [ ] **Step 3: `verify-copy` печатает удостоверение**

В `apps/standalone/host/src/main.rs` фрагмент

```rust
    println!(
        "{}: ok ({} bytes, sha256 {}, migration {}, {made})",
        verified.path.display(),
        verified.size_bytes,
        verified.sha256,
        verified.schema_version
    );
    Ok(())
}
```

заменить на

```rust
    println!(
        "{}: ok ({} bytes, sha256 {}, migration {}, {made})",
        verified.path.display(),
        verified.size_bytes,
        verified.sha256,
        verified.schema_version
    );
    match &verified.identity {
        CopyIdentity::Present(identity) => println!(
            "host identity: host {} (certificate {})",
            identity.host_id(),
            markiro_proto::display_fingerprint(identity.fingerprint())
        ),
        CopyIdentity::Absent => {
            println!("host identity: none (restored on a new computer, every device pairs again)");
        }
        CopyIdentity::Damaged(reason) => {
            return Err(format!(
                "host identity: DAMAGED ({reason}); restore this copy only with --keep-identity, or take another copy"
            )
            .into());
        }
    }
    Ok(())
}
```

и фрагмент

```rust
use markiro_host::network_profile::{self, PUBLIC_REMAINS};
```

заменить на

```rust
use markiro_host::network_profile::{self, PUBLIC_REMAINS};
use markiro_host::restore::CopyIdentity;
```

- [ ] **Step 4: прогон**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --lib restore::identity_tests` → `1 passed`; `cargo test … -p markiro-host --test restore` → всё зелёное, +1; `cargo test … -p markiro-host --bin markiro-host` → зелёное.

- [ ] **Step 5: мутации (не коммитить)**

- В `identity_plan` убрать `|| choice == IdentityChoice::Take` — FAIL `the_copys_identity_goes_only_where_no_paired_device_loses_its_host`.
- Заменить `!established` на `true` (всегда ставить) — FAIL тот же тест.
- В `verify_copy` для `--without-manifest` читать удостоверение — недостижимо (`manifest` = `None`); записать как эквивалентный.

- [ ] **Step 6: формат и коммит**

```bash
git add apps/standalone/host/src/restore.rs apps/standalone/host/src/main.rs apps/standalone/host/tests/restore.rs
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): verify-copy reads the host identity beside a copy, and the rule of what a restore does with it (plan I1)` и трейлер.

---

### Task 4: Восстановление ставит удостоверение копии — маркер, прерывание, флаги, сводка

**Files:**

- Modify: `apps/standalone/host/src/restore.rs`, `apps/standalone/host/src/main.rs`, `apps/standalone/host/tests/restore.rs`

**Interfaces:**

- `pub struct RestoreOptions { pub without_manifest: bool, pub identity: IdentityChoice }`.
- `pub async fn restore_with(paths, source, options, now)`, `pub async fn restore_now(paths, source, options)`; `restore` и `restore_crashing` — прежние подписи (`Auto`).
- `pub enum IdentityOutcome { Same, Restored { host_id, fingerprint, port, replaced, saved_in, former_port }, Kept { copy_had_one }, Created }`; `RestoreReport.identity`.
- `CrashPoint::IdentityPartly`; `Intent.identity: bool` (`#[serde(default)]`).
- CLI: `markiro-host restore <copy> [--data-dir] [--without-manifest] [--keep-identity | --take-identity]`.

- [ ] **Step 1: падающие тесты восстановления**

В `apps/standalone/host/tests/restore.rs` фрагмент импорта

```rust
use markiro_host::restore::{
    restore, restore_crashing, summary, verify_copy, Carried, CopyIdentity, CrashPoint, Current,
    Interrupted, RestoreReport, SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
```

заменить на

```rust
use markiro_host::restore::{
    restore, restore_crashing, restore_with, summary, verify_copy, Carried, CopyIdentity,
    CrashPoint, Current, IdentityChoice, IdentityOutcome, Interrupted, RestoreOptions,
    RestoreReport, SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
```

В тесте `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases` фрагмент

```rust
            "carried": { "devices": 0, "operators": 0, "badges": 0, "officeUsers": 0 },
            "sessionsEnded": 1,
        })
```

заменить на

```rust
            "carried": { "devices": 0, "operators": 0, "badges": 0, "officeUsers": 0 },
            "sessionsEnded": 1,
            "identity": "kept",
        })
```

В конец файла дописать

```rust

/// A new computer's installer started the host once: `host.json`, a TLS
/// identity and a migrated database whose wizard never ran, as
/// `markiro_host::start` leaves them (without binding a port).
async fn installed(paths: &HostPaths) -> HostIdentity {
    paths.ensure().unwrap();
    let config = markiro_host::config::HostConfig::load_or_create(paths, None).unwrap();
    markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id).unwrap();
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
        .close()
        .await;
    HostIdentity::read(paths).unwrap()
}

/// Restore with `--keep-identity` or `--take-identity`.
async fn restore_choosing(
    paths: &HostPaths,
    copy_path: &Path,
    identity: IdentityChoice,
) -> RestoreReport {
    restore_with(
        paths,
        copy_path,
        RestoreOptions {
            without_manifest: false,
            identity,
        },
        at(NOW),
    )
    .await
    .unwrap()
}

/// The runbook's new computer (plan I1): the installer started the host once,
/// and the copy carries its host's identity. The identity goes into place —
/// the devices keep their pairing — and the margins stay those of a
/// database that is not the copy's history: the installer's database knows
/// nothing the copy's host issued after the copy.
#[tokio::test]
async fn a_new_computer_takes_the_copys_identity_and_keeps_the_unread_margins() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&admin, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let copy_audit = newest_audit_id(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_unread_margins(&paths, &report, copy_audit).await;
    let aside = report.saved_as.clone().expect("the installer's database went aside");
    assert_eq!(
        report.identity,
        IdentityOutcome::Restored {
            host_id: admin.app.state.host_id.clone(),
            fingerprint: source.fingerprint().to_owned(),
            port: 45710,
            replaced: Some(installer.host_id().to_owned()),
            saved_in: Some(aside.join("identity")),
            former_port: Some(45710),
        }
    );
    assert!(!report.other_host, "the devices keep their pairing");
    assert!(!report.new_identity);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    let saved: Value = serde_json::from_slice(
        &std::fs::read(aside.join("identity").join("host.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["hostId"], installer.host_id());
    assert_eq!(
        std::fs::read(aside.join("identity").join("key.der")).unwrap(),
        installer.key_der()
    );
    assert!(!fresh.path().join("identity.partial").exists());
    let lines = summary(&report);
    assert!(
        lines.iter().any(|line| line.starts_with(&format!(
            "the copy's host identity was put in place (host {}",
            admin.app.state.host_id
        ))),
        "{lines:#?}"
    );
    assert!(
        lines.contains(&format!(
            "the identity this data folder had (host {}) was replaced; its files are in {}",
            installer.host_id(),
            aside.join("identity").display()
        )),
        "{lines:#?}"
    );
    let pool = reopen(&paths).await;
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["identity"],
        "restored"
    );
}

/// A copy of host A over a working host B: the identity waits for the
/// engineer's `--take-identity`, B's identity is kept aside, and the margins
/// stay those of a database that is not the copy's history. (A `foreign`
/// decided after the identity moved would give two blocks: the mutant of
/// step 4.)
#[tokio::test]
async fn over_a_working_host_of_another_identity_the_copys_identity_waits_for_take_identity() {
    let a = admin().await;
    ask_block(&a, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&a, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _, source) = copy_with_identity(&a.app).await;
    let copy_audit = newest_audit_id(&a.app).await;
    let b = admin().await;
    let paths = stop(&b.app).await;
    let own = write_identity(b.app.dir(), &b.app.state.host_id);

    let error = refused(&paths, &copy_path, false).await;
    assert!(
        error.contains("--take-identity") && error.contains("--keep-identity"),
        "{error}"
    );
    assert!(HostIdentity::read(&paths).unwrap().same_as(&own));

    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Take).await;
    assert_unread_margins(&paths, &report, copy_audit).await;
    assert!(
        matches!(&report.identity, IdentityOutcome::Restored { replaced: Some(host_id), saved_in: Some(_), .. } if host_id == &b.app.state.host_id),
        "{:?}",
        report.identity
    );
    assert!(!report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
}

/// The same computer: the copy's identity is the folder's own; nothing of it
/// changes and the history is known as before.
#[tokio::test]
async fn on_the_same_computer_the_identity_is_the_folders_own() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let paths = stop(&admin.app).await;
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.identity, IdentityOutcome::Same);
    assert!(report.history_known);
    assert!(!report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    assert!(summary(&report)
        .contains(&"the host identity is the copy's: devices keep their pairing".to_owned()));
}

/// A damaged identity beside the copy is refused, and with `--keep-identity`
/// the data goes back without it: every device pairs again.
#[tokio::test]
async fn a_damaged_identity_is_refused_and_keep_identity_restores_without_it() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let file = identity_path(&copy_path);
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[10] ^= 1;
    std::fs::write(&file, &bytes).unwrap();
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;

    let error = refused(&paths, &copy_path, false).await;
    assert!(
        error.contains("damaged") && error.contains("--keep-identity"),
        "{error}"
    );
    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Keep).await;
    assert_eq!(report.identity, IdentityOutcome::Kept { copy_had_one: true });
    assert!(report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&installer));
    assert!(summary(&report).contains(
        &"the copy's host identity was not used (--keep-identity): every device pairs with this host again"
            .to_owned()
    ));
}

/// A restore cut off after the new database took its place, or inside the
/// identity (the key renamed, not the certificate or `host.json`): the host
/// does not start, and the next restore finishes the identity first.
#[tokio::test]
async fn a_restore_cut_off_inside_the_identity_is_finished_by_the_next_one() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    for (crash, with_installer) in [
        (CrashPoint::NewDatabaseInPlace, true),
        (CrashPoint::IdentityPartly, true),
        (CrashPoint::IdentityPartly, false),
    ] {
        let fresh = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(fresh.path());
        if with_installer {
            installed(&paths).await;
        }
        restore_crashing(&paths, &copy_path, false, at(NOW), crash)
            .await
            .unwrap();
        assert_waits_for_the_restore(&start_refused(&paths).await);
        assert!(
            !HostIdentity::read(&paths).is_ok_and(|identity| identity.same_as(&source)),
            "{crash:?}: the identity is not whole yet"
        );

        let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

        assert_eq!(report.interrupted, Some(Interrupted::Finished), "{crash:?}");
        assert_eq!(report.identity, IdentityOutcome::Same, "{crash:?}");
        assert!(
            HostIdentity::read(&paths).unwrap().same_as(&source),
            "{crash:?}"
        );
        assert!(!fresh.path().join("identity.partial").exists());
        assert!(!paths.restore_intent_file().exists());
    }
}
```

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test restore`
Expected: не собирается (`restore_with`, `RestoreOptions`, `IdentityOutcome`, `CrashPoint::IdentityPartly`).

- [ ] **Step 2: `restore.rs` — типы отчёта, маркер, точка обрыва**

В `apps/standalone/host/src/restore.rs`:

Фрагмент

```rust
/// A restore that was cut off, found by the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interrupted {
```

заменить на

```rust
/// How `markiro-host restore` was asked to restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestoreOptions {
    /// `--without-manifest`: only the integrity is checked, and no identity
    /// is read.
    pub without_manifest: bool,
    pub identity: IdentityChoice,
}

/// What a restore did with the host identity (plan I1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityOutcome {
    /// The data folder already had the copy's identity.
    Same,
    /// The copy's identity was put in place: the devices paired with that
    /// host keep their pairing.
    Restored {
        host_id: String,
        fingerprint: String,
        port: u16,
        /// The host id of the identity the data folder had; `None` when it
        /// had none.
        replaced: Option<String>,
        /// Where that identity's files were kept (`<aside>/identity`).
        saved_in: Option<PathBuf>,
        /// The port of the identity the data folder had.
        former_port: Option<u16>,
    },
    /// The data folder kept its own identity; `copy_had_one`: the copy
    /// brought one that was not used (`--keep-identity`).
    Kept { copy_had_one: bool },
    /// No identity anywhere: a new one was created (`new_identity`).
    Created,
}

/// A restore that was cut off, found by the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interrupted {
```

Фрагмент

```rust
    /// When the copy was made: its manifest's time or, without one, its
    /// newest audit row's.
    pub copy_made: String,
}
```

заменить на

```rust
    /// When the copy was made: its manifest's time or, without one, its
    /// newest audit row's.
    pub copy_made: String,
    /// What became of the host identity (plan I1).
    pub identity: IdentityOutcome,
}
```

Фрагмент

```rust
pub enum CrashPoint {
    WalAside,
    DatabaseAside,
    NewDatabaseInPlace,
}
```

заменить на

```rust
pub enum CrashPoint {
    WalAside,
    DatabaseAside,
    NewDatabaseInPlace,
    /// The copy's identity half in place: the key renamed, the certificate
    /// and `host.json` not yet (plan I1).
    IdentityPartly,
}
```

Фрагмент

```rust
    /// The new database's `site.restore_epoch`.
    epoch: String,
    started_at: String,
}
```

заменить на

```rust
    /// The new database's `site.restore_epoch`.
    epoch: String,
    started_at: String,
    /// The copy's host identity waits in `identity.partial/` and goes into
    /// place after the database (plan I1); `false` in an older marker.
    #[serde(default)]
    identity: bool,
}
```

- [ ] **Step 3: `restore.rs` — постановка удостоверения и прерванное восстановление**

Перед функцией `/// Finish a restore of `paths` that was cut off (see the module's table).` вставить

```rust
/// Where the copy's identity waits for the swap (plan I1).
fn identity_staging(paths: &HostPaths) -> PathBuf {
    paths.data_dir.join("identity.partial")
}

/// Remove what a restore staged of an identity and never put in place.
fn remove_identity_staging(paths: &HostPaths) {
    let staged = identity_staging(paths);
    if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
        sync_dir(&paths.data_dir);
    }
}

/// Write the copy's identity whole into `identity.partial/` (owner-only,
/// each file synced) before the marker: what [`install_identity`] renames
/// into place after the database.
fn stage_identity(paths: &HostPaths, identity: &HostIdentity) -> Result<(), BoxError> {
    remove_identity_staging(paths);
    let staged = identity_staging(paths);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&staged)?;
    let config = serde_json::to_vec_pretty(&identity.config())?;
    for (name, bytes) in [
        ("key.der", identity.key_der()),
        ("cert.der", identity.cert_der()),
        ("host.json", config.as_slice()),
    ] {
        let mut file = create_private(&staged.join(name), true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    sync_dir(&staged);
    sync_dir(&paths.data_dir);
    Ok(())
}

/// Rename the staged identity into place: the key, the certificate, then
/// `host.json`, each rename synced. A file the data folder already has is
/// first copied into `<aside>/identity/` when there is an aside folder (a
/// replaced identity stays on disk, like the database it served). A staged
/// file already gone was moved by a run that was cut off: it is skipped, so
/// the next run finishes the first. The marker is still there meanwhile, so
/// the host never starts on a certificate without its key.
fn install_identity(
    paths: &HostPaths,
    aside: Option<&Path>,
    crash: Option<CrashPoint>,
) -> Result<(), BoxError> {
    let staged = identity_staging(paths);
    let tls = paths.tls_dir();
    fs::create_dir_all(&tls)?;
    let moves = [
        ("key.der", tls.join("key.der")),
        ("cert.der", tls.join("cert.der")),
        ("host.json", paths.config_file()),
    ];
    for (name, target) in &moves {
        let from = staged.join(name);
        if !from.exists() {
            continue;
        }
        if let Some(aside) = aside {
            let saved = aside.join("identity").join(name);
            if target.exists() && !saved.exists() {
                fs::create_dir_all(aside.join("identity"))?;
                copy_private(target, &saved)?;
            }
        }
        rename_retrying(&from, target, RENAME_RETRY_DELAY)?;
        sync_dir(target.parent().unwrap_or(&paths.data_dir));
        if *name == "key.der" && crash == Some(CrashPoint::IdentityPartly) {
            return Err(Box::new(Crashed));
        }
    }
    match fs::remove_dir(&staged) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    sync_dir(&paths.data_dir);
    Ok(())
}

```

В `finish_interrupted` фрагмент

```rust
        remove_intent(paths)?;
        remove_staging(staging);
        return Ok(Some(Interrupted::RolledBack));
    }
    if read_epoch(db).await.as_deref() == Some(intent.epoch.as_str()) {
        remove_intent(paths)?;
        return Ok(Some(Interrupted::Finished));
    }
```

заменить на

```rust
        remove_intent(paths)?;
        remove_staging(staging);
        remove_identity_staging(paths);
        return Ok(Some(Interrupted::RolledBack));
    }
    if read_epoch(db).await.as_deref() == Some(intent.epoch.as_str()) {
        // The new database is in place; the identity that was to follow it
        // goes now, before the marker (plan I1).
        if intent.identity {
            install_identity(paths, aside.as_deref(), None)?;
        }
        remove_intent(paths)?;
        return Ok(Some(Interrupted::Finished));
    }
```

- [ ] **Step 4: `restore.rs` — точки входа и `restore_until`**

Фрагмент (функции `restore` и `restore_crashing` целиком)

```rust
pub async fn restore(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
) -> Result<RestoreReport, BoxError> {
    restore_until(paths, source, without_manifest, now, None).await
}
```

заменить на

```rust
pub async fn restore(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
) -> Result<RestoreReport, BoxError> {
    let options = RestoreOptions {
        without_manifest,
        identity: IdentityChoice::Auto,
    };
    restore_until(paths, source, options, now, None).await
}

/// [`restore`] with `--keep-identity` or `--take-identity` (plan I1).
pub async fn restore_with(
    paths: &HostPaths,
    source: &Path,
    options: RestoreOptions,
    now: OffsetDateTime,
) -> Result<RestoreReport, BoxError> {
    restore_until(paths, source, options, now, None).await
}

/// [`restore_with`] at the present moment: `markiro-host restore`'s own call.
pub async fn restore_now(
    paths: &HostPaths,
    source: &Path,
    options: RestoreOptions,
) -> Result<RestoreReport, BoxError> {
    restore_with(paths, source, options, OffsetDateTime::now_utc()).await
}
```

Фрагмент

```rust
    match restore_until(paths, source, without_manifest, now, Some(crash)).await {
```

заменить на

```rust
    let options = RestoreOptions {
        without_manifest,
        identity: IdentityChoice::Auto,
    };
    match restore_until(paths, source, options, now, Some(crash)).await {
```

Функцию `restore_until` заменить целиком (от `async fn restore_until(` до её закрывающей `}` перед `/// What the restore knew of the data before the copy:`) на

```rust
async fn restore_until(
    paths: &HostPaths,
    source: &Path,
    options: RestoreOptions,
    now: OffsetDateTime,
    crash: Option<CrashPoint>,
) -> Result<RestoreReport, BoxError> {
    if is_own_database(source, paths) {
        return Err(untouched(format!(
            "{} is the host's own database (or the new database of an interrupted restore), not a copy",
            source.display()
        )));
    }
    // The copy is checked before the data folder is touched at all.
    let copy = verify_copy(source, options.without_manifest)
        .await
        .map_err(untouched)?;
    let mut made = Made {
        folder: !paths.data_dir.is_dir(),
        ..Made::default()
    };
    fs::create_dir_all(&paths.data_dir)
        .map_err(|error| untouched(format!("{}: {error}", paths.data_dir.display())))?;
    made.lock_file = !paths.lock_file().exists();
    let lock = paths.lock().map_err(|error| match error {
        ConfigError::Locked { .. } => made.unchanged(
            paths,
            format!(
                "the host is running: {error}. Stop the service (sc stop MarkiroHost) and run the command again"
            ),
        ),
        other => made.unchanged(paths, other),
    })?;
    let db = paths.database_file();
    let staging = partial_path(&db);
    // A restore that was cut off is finished first, before `host.json` is
    // read: a cut while the copy's identity went into place leaves
    // `host.json` for last (plan I1).
    made.interrupted = finish_interrupted(paths, &db, &staging).await?;
    // What an earlier restore that was interrupted before its marker left.
    remove_staging(&staging);
    remove_identity_staging(paths);
    // A data folder without host.json gets a new identity, on purpose (the
    // restore of a new computer from a copy without one: the runbook says
    // devices pair again), but only once the new database is ready.
    let existing = match HostConfig::load(paths) {
        Ok(config) => Some(config),
        Err(ConfigError::Missing { .. }) if !HostConfig::would_orphan_host_data(paths) => None,
        Err(ConfigError::Missing { .. }) => {
            return Err(made.unchanged(
                paths,
                format!(
                    "{} is missing but host data is there: put it back from where it was kept before restoring, instead of starting a new host identity",
                    paths.config_file().display()
                ),
            ));
        }
        Err(other) => return Err(made.unchanged(paths, other)),
    };
    let (current, mut known, revoked, initialized) = current_state(&db)
        .await
        .map_err(|error| made.unchanged(paths, error))?;
    // What the current database issued after the copy is known only when it
    // is the copy's own host's, past its wizard. A new computer's installer
    // starts the host once and leaves a database whose wizard never ran; a
    // copy of another host says nothing of what this one issued (a folder
    // without `host.json` gets a new identity: another host too). Its
    // numbers still count as floors. `foreign` is of the identity the folder
    // had BEFORE this restore: the copy's identity put in place (plan I1)
    // never makes the installer's or another host's database the copy's
    // history.
    let foreign = existing
        .as_ref()
        .is_none_or(|config| other_host(&copy, config));
    let history_known = current == Current::Read && initialized && !foreign;
    let revoked = revoked.filter(|_| history_known);
    // What becomes of the host identity, decided before anything is built:
    // a refusal changes nothing.
    let folder_identity = existing
        .as_ref()
        .map(|_| HostIdentity::read(paths).map_err(|error| error.to_string()));
    let established =
        current == Current::Unreadable || (current == Current::Read && initialized);
    let plan = identity_plan(
        &copy.identity,
        folder_identity
            .as_ref()
            .map(|read| read.as_ref().map_err(String::as_str)),
        established,
        options.identity,
    )
    .map_err(|error| made.unchanged(paths, error))?;
    let installing = match (plan, &copy.identity) {
        (IdentityPlan::Install, CopyIdentity::Present(identity)) => Some(identity.clone()),
        _ => None,
    };
    let former = existing
        .as_ref()
        .map(|config| (config.host_id.clone(), config.port));
    known.merge(aside_floors(&paths.data_dir).await);
    // A WAL beside no database would be read by the restored one: it goes
    // aside too.
    let leftovers = database_files(&db).iter().any(|file| file.exists());
    let aside = leftovers.then(|| aside_dir(paths, now));
    let staged = stage(
        &copy,
        &staging,
        Before {
            current,
            history_known,
            known: &known,
            revoked: revoked.as_ref(),
            identity: plan.audit_word(),
        },
        aside.as_deref(),
        now,
    )
    .await;
    let raised = match staged {
        Ok(raised) => raised,
        Err(error) => {
            remove_staging(&staging);
            return Err(made.unchanged(paths, error));
        }
    };
    let (config, new_identity) = match (&installing, existing) {
        (Some(identity), _) => (identity.config(), false),
        (None, Some(config)) => (config, false),
        (None, None) => match HostConfig::load_or_create(paths, None) {
            Ok(config) => {
                made.identity = true;
                (config, true)
            }
            Err(error) => {
                remove_staging(&staging);
                return Err(made.unchanged(paths, error));
            }
        },
    };
    if let Some(identity) = &installing {
        if let Err(error) = stage_identity(paths, identity) {
            remove_staging(&staging);
            remove_identity_staging(paths);
            return Err(made.unchanged(
                paths,
                format!("the copy's host identity could not be staged: {error}"),
            ));
        }
    }
    let intent = Intent {
        format: INTENT_FORMAT,
        step: "swap".to_owned(),
        aside: aside
            .as_deref()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned()),
        staging: staging
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        epoch: raised.epoch.clone(),
        started_at: format_timestamp(now),
        identity: installing.is_some(),
    };
    if let Err(error) = write_intent(paths, &intent) {
        remove_staging(&staging);
        remove_identity_staging(paths);
        return Err(made.unchanged(
            paths,
            format!("the restore marker could not be written: {error}"),
        ));
    }
    if let Err(failure) = swap(&db, &staging, aside.as_deref(), RENAME_RETRY_DELAY, crash) {
        if failure.crashed {
            drop(lock);
            return Err(Box::new(Crashed));
        }
        if failure.stranded.is_empty() {
            // Everything is back: the marker goes, then the new database (a
            // cut between leaves a stale `host.db.partial`, nothing worse).
            let marker = remove_intent(paths);
            remove_staging(&staging);
            remove_identity_staging(paths);
            let cause = format!(
                "the new database could not be put in place: {}. The previous database was put back",
                failure.cause
            );
            return Err(match marker {
                Ok(()) => made.unchanged(paths, cause),
                Err(error) => format!(
                    "{cause}, but {} could not be removed ({error}): delete it before the service is started",
                    paths.restore_intent_file().display()
                )
                .into(),
            });
        }
        // The marker and the new database stay: the next restore puts the
        // previous files back first.
        return Err(format!(
            "the new database could not be put in place: {}. THE PREVIOUS DATABASE COULD NOT BE PUT BACK ({}): its files are in {}. Run the same markiro-host restore command again: it puts them back first (the host does not start until then); if that fails too, call support",
            failure.cause,
            failure.stranded.join("; "),
            aside.as_deref().map_or_else(String::new, |dir| dir.display().to_string()),
        )
        .into());
    }
    if installing.is_some() {
        if let Err(error) = install_identity(paths, aside.as_deref(), crash) {
            if error.is::<Crashed>() {
                drop(lock);
                return Err(error);
            }
            return Err(format!(
                "the copy is in place, but its host identity could not be put in place ({error}): run the same markiro-host restore command again: it finishes that first; the host does not start until then"
            )
            .into());
        }
    }
    if let Err(error) = remove_intent(paths) {
        return Err(format!(
            "the copy is in place, but {} could not be removed ({error}): run the same markiro-host restore command again, or delete that file, before the service is started",
            paths.restore_intent_file().display()
        )
        .into());
    }
    drop(lock);
    let identity = match (plan, &installing) {
        (IdentityPlan::Install, Some(identity)) => IdentityOutcome::Restored {
            host_id: identity.host_id().to_owned(),
            fingerprint: identity.fingerprint().to_owned(),
            port: identity.port(),
            replaced: former.as_ref().map(|(host_id, _)| host_id.clone()),
            saved_in: aside
                .as_ref()
                .filter(|_| former.is_some())
                .map(|dir| dir.join("identity")),
            former_port: former.as_ref().map(|(_, port)| *port),
        },
        (IdentityPlan::Same, _) => IdentityOutcome::Same,
        (IdentityPlan::KeepFolder, _) => IdentityOutcome::Kept {
            copy_had_one: !matches!(copy.identity, CopyIdentity::Absent),
        },
        _ => IdentityOutcome::Created,
    };
    Ok(RestoreReport {
        other_host: other_host(&copy, &config),
        copy,
        data_dir: std::path::absolute(&paths.data_dir).unwrap_or_else(|_| paths.data_dir.clone()),
        current,
        history_known,
        saved_as: aside,
        epoch: raised.epoch,
        counters: raised.counters,
        shift_numbers: raised.shift_numbers,
        new_identity,
        revision: raised.revision,
        carried: raised.carried,
        sessions_ended: raised.sessions_ended,
        interrupted: made.interrupted,
        copy_made: raised.copy_made,
        identity,
    })
}
```

Фрагмент

```rust
struct Before<'a> {
    current: Current,
    /// See [`RestoreReport::history_known`].
    history_known: bool,
    known: &'a Floors,
    revoked: Option<&'a Revoked>,
}
```

заменить на

```rust
struct Before<'a> {
    current: Current,
    /// See [`RestoreReport::history_known`].
    history_known: bool,
    known: &'a Floors,
    revoked: Option<&'a Revoked>,
    /// The audit word of what becomes of the host identity (plan I1).
    identity: &'static str,
}
```

В `raise_in` фрагмент

```rust
    let Before {
        current,
        history_known,
        known,
        revoked,
    } = before;
```

заменить на

```rust
    let Before {
        current,
        history_known,
        known,
        revoked,
        identity,
    } = before;
```

и фрагмент

```rust
                "sessionsEnded": sessions_ended,
            }),
```

заменить на

```rust
                "sessionsEnded": sessions_ended,
                "identity": identity,
            }),
```

- [ ] **Step 5: `restore.rs` — строки сводки**

В `summary` фрагмент

```rust
    if report.new_identity {
        lines.push(format!(
            "a new host identity was created in {}: every device pairs with this host again",
            report.data_dir.join("host.json").display()
        ));
    }
```

заменить на

```rust
    if report.new_identity {
        lines.push(format!(
            "a new host identity was created in {}: every device pairs with this host again",
            report.data_dir.join("host.json").display()
        ));
    }
    match &report.identity {
        IdentityOutcome::Same => {
            lines.push("the host identity is the copy's: devices keep their pairing".to_owned());
        }
        IdentityOutcome::Restored {
            host_id,
            fingerprint,
            port,
            replaced,
            saved_in,
            former_port,
        } => {
            lines.push(format!(
                "the copy's host identity was put in place (host {host_id}, certificate {}): devices paired with that host keep their pairing; at a new address, give this computer the old one's address or change the host address on each device (Офис → «Изменить адрес хоста»)",
                markiro_proto::display_fingerprint(fingerprint)
            ));
            if let Some(replaced) = replaced {
                lines.push(match saved_in {
                    Some(dir) => format!(
                        "the identity this data folder had (host {replaced}) was replaced; its files are in {}",
                        dir.display()
                    ),
                    None => format!("the identity this data folder had (host {replaced}) was replaced"),
                });
            }
            let opened = former_port.unwrap_or(markiro_proto::DEFAULT_PORT);
            if *port != opened {
                lines.push(format!(
                    "the restored identity listens on port {port}, not on {opened}: run the installer again so the firewall opens port {port}"
                ));
            }
        }
        IdentityOutcome::Kept { copy_had_one: true } => lines.push(
            "the copy's host identity was not used (--keep-identity): every device pairs with this host again"
                .to_owned(),
        ),
        IdentityOutcome::Kept { copy_had_one: false } | IdentityOutcome::Created => {}
    }
```

- [ ] **Step 6: CLI — флаги `--keep-identity` / `--take-identity`**

В `apps/standalone/host/src/main.rs`:

Фрагмент

```rust
use markiro_host::restore::CopyIdentity;
```

заменить на

```rust
use markiro_host::restore::{CopyIdentity, IdentityChoice, RestoreOptions};
```

Фрагмент

```rust
    Restore {
        data_dir: PathBuf,
        copy: PathBuf,
        without_manifest: bool,
    },
```

заменить на

```rust
    Restore {
        data_dir: PathBuf,
        copy: PathBuf,
        without_manifest: bool,
        identity: IdentityChoice,
    },
```

Фрагмент

```rust
       markiro-host restore <copy> [--data-dir <path>] [--without-manifest]
```

заменить на

```rust
       markiro-host restore <copy> [--data-dir <path>] [--without-manifest] [--keep-identity | --take-identity]
```

Фрагмент

```rust
    let mut without_manifest = false;
    let mut index = 0;
```

заменить на

```rust
    let mut without_manifest = false;
    let mut identity = IdentityChoice::Auto;
    let mut index = 0;
```

Фрагмент

```rust
            "--without-manifest" => {
                without_manifest = true;
                index += 1;
            }
```

заменить на

```rust
            "--without-manifest" => {
                without_manifest = true;
                index += 1;
            }
            flag @ ("--keep-identity" | "--take-identity") => {
                let chosen = if flag == "--keep-identity" {
                    IdentityChoice::Keep
                } else {
                    IdentityChoice::Take
                };
                if identity != IdentityChoice::Auto && identity != chosen {
                    return Err(format!(
                        "--keep-identity and --take-identity exclude each other\n{USAGE}"
                    ));
                }
                identity = chosen;
                index += 1;
            }
```

Фрагмент

```rust
    match (command.as_str(), copy) {
        ("run", None) if !without_manifest => Ok(Command::Run {
```

заменить на

```rust
    // The identity flags belong to `restore` alone.
    if identity != IdentityChoice::Auto && command.as_str() != "restore" {
        return Err(USAGE.to_owned());
    }
    match (command.as_str(), copy) {
        ("run", None) if !without_manifest => Ok(Command::Run {
```

Фрагмент

```rust
        ("restore", Some(copy)) if port.is_none() => Ok(Command::Restore {
            data_dir: data_dir_or_default(data_dir),
            copy,
            without_manifest,
        }),
```

заменить на

```rust
        ("restore", Some(copy)) if port.is_none() => Ok(Command::Restore {
            data_dir: data_dir_or_default(data_dir),
            copy,
            without_manifest,
            identity,
        }),
```

Фрагмент

```rust
        Command::Restore {
            data_dir,
            copy,
            without_manifest,
        } => restore(data_dir, copy, without_manifest),
```

заменить на

```rust
        Command::Restore {
            data_dir,
            copy,
            without_manifest,
            identity,
        } => restore(data_dir, copy, without_manifest, identity),
```

Фрагмент

```rust
fn restore(data_dir: PathBuf, copy: PathBuf, without_manifest: bool) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(markiro_host::restore::restore(
        &paths,
        &copy,
        without_manifest,
        time::OffsetDateTime::now_utc(),
    ));
```

заменить на

```rust
fn restore(
    data_dir: PathBuf,
    copy: PathBuf,
    without_manifest: bool,
    identity: IdentityChoice,
) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(markiro_host::restore::restore_now(
        &paths,
        &copy,
        RestoreOptions {
            without_manifest,
            identity,
        },
    ));
```

В тестах `main.rs`: в обоих ожидаемых `Command::Restore { … }` теста `restore_and_verify_copy_take_the_copy_first` последним полем дописать `identity: IdentityChoice::Auto,`; в `restore_of_a_missing_copy_is_an_error_and_writes_nothing` вызов `restore(dir.path().to_path_buf(), dir.path().join("no-such-copy.db"), true,)` дополнить аргументом `IdentityChoice::Auto`. После теста `restore_and_verify_copy_take_the_copy_first` вставить

```rust
    #[test]
    fn restore_takes_one_identity_flag_and_no_other_command_takes_one() {
        assert_eq!(
            parse(&args(&["restore", "a.db", "--take-identity"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: false,
                identity: IdentityChoice::Take,
            })
        );
        assert_eq!(
            parse(&args(&["restore", "a.db", "--keep-identity", "--keep-identity"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: false,
                identity: IdentityChoice::Keep,
            })
        );
        assert!(parse(&args(&["restore", "a.db", "--keep-identity", "--take-identity"])).is_err());
        assert!(parse(&args(&["verify-copy", "a.db", "--take-identity"])).is_err());
        assert!(parse(&args(&["run", "--keep-identity"])).is_err());
    }
```

- [ ] **Step 7: прогон**

Run:

- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test restore --test restore_hold --test backup_routes`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --lib`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --bin markiro-host`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-host --test no_secrets_in_logs`

Expected: всё зелёное; `--test restore` +5, бинарь +1.

- [ ] **Step 8: мутации (не коммитить)**

- Считать `foreign` после удостоверения: в `restore_until` заменить `existing.as_ref().is_none_or(|config| other_host(&copy, config))` на `installing.as_ref().map(|identity| identity.config()).or(existing.clone()).as_ref().is_none_or(|config| other_host(&copy, config))` — FAIL `over_a_working_host_of_another_identity_the_copys_identity_waits_for_take_identity` (запас 9500/440 вместо 110 000).
- В `install_identity` переставить `host.json` первым — FAIL `a_restore_cut_off_inside_the_identity_is_finished_by_the_next_one` (вариант без установщика: удостоверение читается до конца).
- В `finish_interrupted` убрать `install_identity` в ветке `Finished` — FAIL тот же тест.
- Вернуть `finish_interrupted` после чтения `host.json` — FAIL тот же тест (третий случай: «host.json is missing but host data is there»).
- В `identity_plan` вызывать с `established = false` всегда — FAIL `over_a_working_host…` (нет отказа).

- [ ] **Step 9: формат и коммит**

```bash
git add apps/standalone/host/src/restore.rs apps/standalone/host/src/main.rs apps/standalone/host/tests/restore.rs
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): restore puts the copy's host identity in place under the marker — the stations keep their pairing on a new computer, the unread margins stay (plan I1)` и трейлер.

---

### Task 5: Офис — «Ключ хоста» у копий и предупреждения

**Files:**

- Modify: `apps/standalone/src/office/backups/backup-warnings.ts`, `apps/standalone/src/office/backups/BackupsPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/backup-warnings.test.ts`, `apps/standalone/test/backups-page.test.tsx`

- [ ] **Step 1: падающие тесты**

В `apps/standalone/test/backup-warnings.test.ts` перед `it("warns of a copy running for more than half an hour", () => {` вставить

<!-- prettier-ignore -->
```ts
  it("warns of a newest copy without the host identity, in either folder", () => {
    const bare = { ...backupCopy("2026-10-09T14:00:00Z"), hostIdentity: false };
    expect(
      backupWarnings(state({ local: { ...HEALTHY_BACKUPS.local, copies: [bare] } })),
    ).toEqual([{ kind: "localNoIdentity" }]);
    expect(
      backupWarnings(
        state({ second: { dir: "\\\\ADMIN-PC\\MarkiroCopies", lastAttempt: null, copies: [bare] } }),
      ),
    ).toEqual([{ kind: "secondNoIdentity" }]);
    // An older copy without it does not count: a restore takes the newest.
    const older = { ...backupCopy("2026-10-09T11:35:12Z"), hostIdentity: false };
    expect(
      backupWarnings(
        state({
          local: { ...HEALTHY_BACKUPS.local, copies: [backupCopy("2026-10-09T14:00:00Z"), older] },
        }),
      ),
    ).toEqual([]);
    expect(warningTone({ kind: "secondNoIdentity" })).toBe("warn");
    expect(warningText({ kind: "localNoIdentity" })).toEqual({
      key: "office.backups.warnings.localNoIdentity",
    });
  });

```

В `apps/standalone/test/backups-page.test.tsx` перед `it("writes every time in the organization's zone and says so", async () => {` вставить

<!-- prettier-ignore -->
```tsx
  it("says which copies carry the host identity, and warns when the newest lacks it", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      local: {
        ...HEALTHY_BACKUPS.local,
        copies: [
          { ...backupCopy("2026-10-09T14:00:00Z"), hostIdentity: false },
          backupCopy("2026-10-09T11:35:12Z", "manual"),
        ],
      },
    });
    await openBackups(session);
    expect(screen.getByText(ru.office.backups.warnings.localNoIdentity)).toBeTruthy();
    const table = card("Копии на компьютере хоста");
    expect(within(table).getByRole("columnheader", { name: "Ключ хоста" })).toBeTruthy();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("нет")).toBeTruthy();
    expect(within(rows[1]!).getByText("есть")).toBeTruthy();
    expect(within(card("Восстановление")).getByText(ru.office.backups.restore.newPc)).toBeTruthy();
  });

```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts test/backups-page.test.tsx`
Expected: FAIL — два новых теста.

- [ ] **Step 2: предупреждения**

В `apps/standalone/src/office/backups/backup-warnings.ts` фрагмент

<!-- prettier-ignore -->
```ts
  | { kind: "secondStale" }
  | { kind: "clockBehind" }
```

заменить на

<!-- prettier-ignore -->
```ts
  | { kind: "secondStale" }
  | { kind: "localNoIdentity" }
  | { kind: "secondNoIdentity" }
  | { kind: "clockBehind" }
```

Фрагмент

<!-- prettier-ignore -->
```ts
/** Whether the folder's newest copy is later than the host's `now` by more than `CLOCK_AHEAD_MS`. */
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * Whether the folder's newest copy lacks the host identity (plan I1): restored on a new
 * computer, every device would pair again. The host could not close the key in that folder
 * (FAT32, exFAT, a share without ACLs), or the copy is an older build's.
 */
function withoutIdentity(destination: BackupDestination | null): boolean {
  const newest = destination?.copies[0];
  return newest !== undefined && !newest.hostIdentity;
}

/** Whether the folder's newest copy is later than the host's `now` by more than `CLOCK_AHEAD_MS`. */
```

Фрагмент

<!-- prettier-ignore -->
```ts
  if (ahead(state.local, now) || ahead(state.second, now)) {
```

заменить на

<!-- prettier-ignore -->
```ts
  if (withoutIdentity(state.local)) warnings.push({ kind: "localNoIdentity" });
  if (withoutIdentity(state.second)) warnings.push({ kind: "secondNoIdentity" });
  if (ahead(state.local, now) || ahead(state.second, now)) {
```

В JSDoc `backupWarnings` после `no second folder,` дописать `a newest copy without the host identity in either folder,`.

- [ ] **Step 3: таблица и карточка восстановления**

В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      render: (copy) => formatSize(copy.sizeBytes, t),
    },
  ];
```

заменить на

<!-- prettier-ignore -->
```tsx
      render: (copy) => formatSize(copy.sizeBytes, t),
    },
    {
      key: "identity",
      title: t("office.backups.table.identity"),
      render: (copy) =>
        t(copy.hostIdentity ? "office.backups.identity.yes" : "office.backups.identity.no"),
    },
  ];
```

Фрагмент

<!-- prettier-ignore -->
```tsx
            <p className="office-note">{t("office.backups.restore.after")}</p>
```

заменить на

<!-- prettier-ignore -->
```tsx
            <p className="office-note">{t("office.backups.restore.after")}</p>
            <p className="office-note">{t("office.backups.restore.newPc")}</p>
```

- [ ] **Step 4: тексты `ru.json`**

В `apps/standalone/src/i18n/ru.json` (блок `office.backups`):

Фрагмент

<!-- prettier-ignore -->
```json
        "trigger": "Как",
        "size": "Размер"
      },
```

заменить на

<!-- prettier-ignore -->
```json
        "trigger": "Как",
        "size": "Размер",
        "identity": "Ключ хоста"
      },
      "identity": {
        "yes": "есть",
        "no": "нет"
      },
```

Фрагмент

<!-- prettier-ignore -->
```json
        "secondStale": "Во второй папке нет проверенной копии за последние сутки.",
```

заменить на

<!-- prettier-ignore -->
```json
        "secondStale": "Во второй папке нет проверенной копии за последние сутки.",
        "localNoIdentity": "Последняя копия на компьютере хоста — без ключа хоста: восстановленная на новом компьютере, она потребует подключить все устройства заново. Сделайте копию сейчас; если предупреждение не уходит, сообщите разработчику.",
        "secondNoIdentity": "Последняя копия во второй папке — без ключа хоста: хост не смог закрыть ключ от других пользователей этой папки (на флешке FAT32 или exFAT так всегда). Восстановленная из этой папки на новом компьютере, копия потребует подключить все устройства заново.",
```

Фрагмент

<!-- prettier-ignore -->
```json
        "after": "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом. Станции, выйдя на связь, сами возвращают ему свои блоки SSCC; приём их данных администратор возобновляет здесь, после проверок SSCC."
      }
```

заменить на

<!-- prettier-ignore -->
```json
        "after": "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом. Станции, выйдя на связь, сами возвращают ему свои блоки SSCC; приём их данных администратор возобновляет здесь, после проверок SSCC.",
        "newPc": "На новом компьютере — те же шаги. Копия с ключом хоста (файл .identity рядом с копией) сохраняет подключение станций: им нужен только новый адрес хоста. Без ключа все устройства подключаются заново."
      }
```

- [ ] **Step 5: прогон и коммит**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts test/backups-page.test.tsx test/backups.test.ts`, затем `… run typecheck` и `… run lint`.
Expected: всё зелёное, +2.

Prettier на изменённые файлы; `git diff --check`.

```bash
git add apps/standalone/src/office/backups/backup-warnings.ts apps/standalone/src/office/backups/BackupsPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/backup-warnings.test.ts apps/standalone/test/backups-page.test.tsx
git commit -F <файл сообщения>
```

Сообщение: `feat(standalone): the office says which copies carry the host identity and warns when the newest lacks it (plan I1)` и трейлер.

---

### Task 6: Станция сохраняет подключение — сквозная проверка с настоящими хостами

**Files:**

- Create: `apps/standalone/src-tauri/tests/restore_identity.rs`

Код оболочки не меняется: `DeviceState::change_address` (план УСТ) уже принимает новый адрес, только если там закреплённый сертификат и хост принимает ключ устройства.

- [ ] **Step 1: создать `apps/standalone/src-tauri/tests/restore_identity.rs`**

```rust
//! A host restored on a NEW computer (plan I1) against real `markiro-host`s
//! on 127.0.0.1. With the copy's identity the station keeps its pairing —
//! the same key, the same pinned certificate, the same device — and only
//! learns the new address. Without it the new computer is another host: the
//! station's pinned client refuses it before its key goes anywhere.

use std::path::{Path, PathBuf};
use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, IdentityOutcome, RestoreOptions};
use markiro_host::{start, RunningHost, StartOptions};
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::installation::InstallRole;
use serde_json::Value;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

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

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

/// The host PC's own pairing after the wizard, and the administrator's token.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let office = DeviceState::load(dir.to_path_buf());
    office
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = office
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (office, token)
}

/// A station paired by a code from the office.
async fn station(host: &RunningHost, office: &DeviceState, token: &str, dir: &Path) -> DeviceState {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    let code = created.body.unwrap()["code"].as_str().unwrap().to_owned();
    let station =
        DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Station));
    station
        .claim(
            &address(host),
            &host.fingerprint,
            &code,
            "Станция линии 1",
            "0.1.0",
        )
        .await
        .unwrap();
    station
}

/// «Сделать копию сейчас», and the copy it made once the worker is done: the
/// database file in the host's local folder and whether the host identity
/// lies beside it.
async fn copy_now(host_dir: &Path, office: &DeviceState, token: &str) -> (PathBuf, bool) {
    let asked = office
        .request("POST", "/v1/office/backups", None, Some(token))
        .await
        .unwrap();
    assert_eq!(asked.status, 202, "{:?}", asked.body);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let state = office
            .request("GET", "/v1/office/backups", None, Some(token))
            .await
            .unwrap()
            .body
            .unwrap();
        let manual = state["local"]["copies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|copy| copy["trigger"] == "manual")
            .cloned();
        if let (true, Some(copy)) = (state["running"].is_null(), manual) {
            let file = copy["file"].as_str().unwrap();
            return (
                host_dir.join("backups").join(file),
                copy["hostIdentity"].as_bool().unwrap(),
            );
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no manual copy: {state}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The new computer's installer started the host once: a fresh identity and
/// a database without a wizard. Returns that identity's fingerprint.
async fn installed(dir: &Path) -> String {
    let host = start_host(dir).await;
    let fingerprint = host.fingerprint.clone();
    host.stop().await.unwrap();
    fingerprint
}

fn saved(dir: &Path) -> DeviceConfig {
    device_config::load(dir).unwrap().unwrap()
}

/// The old host with a paired station and a copy made after the pairing; the
/// old host is stopped (its computer died). Returns the station, the copy,
/// the station's `device.json` before, and the old host's fingerprint, id
/// and address.
struct Before {
    station: DeviceState,
    copy: PathBuf,
    with_identity: bool,
    config: DeviceConfig,
    fingerprint: String,
    host_id: String,
    address: String,
}

async fn old_host_died(old_dir: &Path, office_dir: &Path, station_dir: &Path) -> Before {
    let old = start_host(old_dir).await;
    let (office, token) = office(&old, office_dir).await;
    let station = station(&old, &office, &token, station_dir).await;
    let (copy, with_identity) = copy_now(old_dir, &office, &token).await;
    let before = Before {
        station,
        copy,
        with_identity,
        config: saved(station_dir),
        fingerprint: old.fingerprint.clone(),
        host_id: old.host_id.clone(),
        address: address(&old),
    };
    old.stop().await.unwrap();
    before
}

#[tokio::test]
async fn a_station_keeps_its_pairing_with_its_host_restored_on_a_new_computer() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    assert!(before.with_identity, "the copy carries the host identity");

    let fresh = installed(new_dir.path()).await;
    assert_ne!(fresh, before.fingerprint);
    let report = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        RestoreOptions {
            without_manifest: false,
            identity: IdentityChoice::Auto,
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(report.identity, IdentityOutcome::Restored { .. }),
        "{:?}",
        report.identity
    );
    let new = start_host(new_dir.path()).await;
    assert_eq!(
        (new.fingerprint.as_str(), new.host_id.as_str()),
        (before.fingerprint.as_str(), before.host_id.as_str()),
        "the same host to the station"
    );
    assert_ne!(address(&new), before.address, "another address");

    assert_eq!(
        before.station.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::Request(RequestError::Unreachable)),
        "nothing answers at the old address"
    );
    let status = before.station.change_address(&address(&new)).await.unwrap();
    assert_eq!(status.host_address, address(&new));
    assert_eq!(
        saved(station_dir.path()),
        DeviceConfig {
            host_address: address(&new),
            ..before.config
        },
        "only the address changes: the key, the fingerprint and the device stay"
    );
    let device = before
        .station
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(device.status, 200, "the restored host knows the station's key");
    new.stop().await.unwrap();
}

#[tokio::test]
async fn without_the_identity_the_new_computer_is_another_host() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;

    installed(new_dir.path()).await;
    let report = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        RestoreOptions {
            without_manifest: false,
            identity: IdentityChoice::Keep,
        },
    )
    .await
    .unwrap();
    assert!(report.other_host);
    let new = start_host(new_dir.path()).await;
    assert_ne!(new.fingerprint, before.fingerprint);

    assert_eq!(
        before.station.change_address(&address(&new)).await,
        Err(DeviceError::AddressOtherHost)
    );
    assert_eq!(saved(station_dir.path()), before.config, "nothing changed");
    new.stop().await.unwrap();
}
```

- [ ] **Step 2: прогон (вне песочницы)**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (если сборки вебвью нет), затем `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test restore_identity`
Expected: `test result: ok. 2 passed`.

Если `claim` с ролью `Station` требует чего-то сверх кода (линия выбирается после подключения), взять `InstallRole::Office`, как `host_address.rs`, и записать отличие: план проверяет подключение устройства, не роль.

- [ ] **Step 3: мутация (не коммитить)**

- В `host/src/restore.rs` `identity_plan`: ветку `None => Ok(IdentityPlan::Install)` и `Some(_) if !established …` заменить на `Ok(own)` (никогда не ставить) — FAIL `a_station_keeps_its_pairing_with_its_host_restored_on_a_new_computer` (`AddressOtherHost`).

- [ ] **Step 4: формат и коммит**

```bash
git add apps/standalone/src-tauri/tests/restore_identity.rs
git commit -F <файл сообщения>
```

Сообщение: `test(standalone): a station keeps its pairing with its host restored on a new computer, against real hosts (plan I1)` и трейлер.

---

### Task 7: Документы — памятка, установка, AGENTS, раздел 26 спецификации, полная проверка

**Files:**

- Modify: `docs/runbooks/standalone-backup-restore.md`, `docs/runbooks/standalone-install.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`
- Modify (если файл есть в дереве): `docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md`

- [ ] **Step 1: памятка — раздел 2 (флешка и права)**

В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
  2. Скопировать на неё самую свежую пару файлов `markiro-host-…db` и `markiro-host-…json`.
```

заменить на

<!-- prettier-ignore -->
```markdown
  2. Скопировать на неё самую свежую тройку файлов `markiro-host-…db`, `markiro-host-…json` и
     `markiro-host-…identity` (ключ хоста, план I1; на флешке FAT32 или exFAT его права не держатся —
     храните флешку в сейфе).
```

Фрагмент

<!-- prettier-ignore -->
```markdown
     `markiro-host verify-copy E:\markiro-host-20261009T140000Z-7c1e2a9b.db` — ответ
     `…: ok (… bytes, sha256 …, migration …, made …)`. На ПК без `markiro-host` —
```

заменить на

<!-- prettier-ignore -->
```markdown
     `markiro-host verify-copy E:\markiro-host-20261009T140000Z-7c1e2a9b.db` — ответ
     `…: ok (… bytes, sha256 …, migration …, made …)` и вторая строка `host identity: host …
     (certificate …)`; `host identity: none` — копия без ключа (раздел 6), `DAMAGED` — ключ рядом с
     копией испорчен, возьмите другую. На ПК без `markiro-host` —
```

Фрагмент

<!-- prettier-ignore -->
```markdown
  - Флешка с FAT32 или exFAT прав не знает: её защищает только хранение в сейфе или шифрование диска.
```

заменить на

<!-- prettier-ignore -->
```markdown
  - Флешка с FAT32 или exFAT прав не знает: её защищает только хранение в сейфе или шифрование диска.
- **Ключ хоста в копиях (план I1).** Рядом с каждой копией хост кладёт файл `markiro-host-…identity`:
  `hostId`, порт и сертификат TLS хоста **с закрытым ключом**. По нему восстановленный на новом ПК
  хост остаётся для станций тем же хостом (раздел 6). Кто прочтёт этот файл, может в сети цеха выдать
  себя за хост: станции отправят ему записи и ключи устройств и примут от него справочники.
  - Хост закрывает файл сам: на Windows `icacls` оставляет доступ только SYSTEM, группе
    «Администраторы» и владельцу файла (учётной записи службы), на других системах — права `0600`.
  - Если папка прав не держит (FAT32/exFAT, общая папка, отказавшая в правах), ключ в неё не
    кладётся: копия делается без него, а офис предупреждает «Последняя копия во второй папке — без
    ключа хоста…». Восстановленная на новом ПК, такая копия потребует подключить все устройства
    заново.
  - Если копия с ключом попала в чужие руки, вызовите разработчика: смена удостоверения хоста означает
    повторное подключение всех устройств (готовой команды для этого пока нет).
```

- [ ] **Step 2: памятка — раздел 5, шаг 5 (строки ответа)**

Фрагмент

<!-- prettier-ignore -->
```markdown
   - новую эпоху (`restore epoch …`).
6. Если команда прервалась (отключили питание, закрыли окно), **запустить ту же команду ещё раз**,
```

заменить на

<!-- prettier-ignore -->
```markdown
   - новую эпоху (`restore epoch …`);
   - что стало с ключом хоста: на том же ПК — «the host identity is the copy's: devices keep their
     pairing» (копия с ключом) или ничего (копия без ключа, удостоверение каталога данных осталось).
6. Если команда прервалась (отключили питание, закрыли окно), **запустить ту же команду ещё раз**,
```

- [ ] **Step 3: памятка — раздел 6 целиком**

Раздел 6 (от строки `## 6. Восстановление на новом ПК` до строки перед `## 7. Памятка о восстановлении: проверки перед «Возобновить приём данных станций»`) заменить на

<!-- prettier-ignore -->
```markdown
## 6. Восстановление на новом ПК

С плана I1 рядом с каждой копией лежит файл `markiro-host-…identity` — удостоверение хоста:
`hostId`, порт и сертификат TLS с закрытым ключом (раздел 2). Копия с ним переносит на новый ПК
**самого хоста**: тот же `hostId`, тот же сертификат, те же ключи устройств. Станции и ПК офиса
сохраняют подключение, очередь и справочники; им нужен только новый адрес. Возврат блоков SSCC и
повторная отправка записей 30 дней (план РК-С) идут так же, как при восстановлении на том же ПК.

1. Если старый ПК жив и замена плановая — дождитесь, пока «Не отправлено» на станциях станет нулём,
   закройте смены, сделайте копию сейчас («Сделать копию сейчас») и только потом выключайте его.
2. Выбрать копию **с ключом хоста**: на странице «Резервные копии» в столбце «Ключ хоста» — «есть»;
   на диске рядом с `…db` и `…json` лежит `…identity`. Копии, сделанные до обновления, ключа не несут
   (подраздел «Копия без ключа хоста» ниже).
3. Установить «Markiro Автоном» с ролью хоста (план УСТ), **не проходить мастер и не открывать
   приложение на этом ПК** до конца восстановления. Все ПК площадки — на той же версии (раздел 5).
4. Остановить службу: `sc stop MarkiroHost` и дождаться `STATE: STOPPED`.
5. Скопировать три файла копии (`.db`, `.json`, `.identity`) со второй папки или флешки в папку на
   новом ПК (например, `C:\MarkiroRestore\`). Файл `.identity` во второй папке открыт только
   администраторам ПК, где она лежит, и учётной записи службы: копируйте его, войдя на тот ПК
   администратором, или с флешки. Проверить: `markiro-host verify-copy C:\MarkiroRestore\markiro-host-….db`
   — вторая строка `host identity: host … (certificate …)`.
6. Восстановить, как в разделе 5, шаги 5–7: `markiro-host restore <копия.db> --data-dir
   "%ProgramData%\Markiro\Host"`. В ответе:
   - «the copy's host identity was put in place (host …, certificate …): …» — ключ хоста перенесён;
   - «the identity this data folder had (host …) was replaced; its files are in
     …\restore-<время>\identity» — удостоверение, которое создал установщик; ни одно устройство с ним
     не подключено;
   - «the current database is not this copy's history (…): every SSCC counter is at least 100000
     above the copy's highest number» и «the previous database was not read: … are active again» —
     как и прежде: база установщика не знает, что выдал хост после копии. Строки «revocations carried
     over» здесь быть не должно: если она есть, остановитесь и вызовите разработчика;
   - «the restored identity listens on port …, not on …: run the installer again…» — порт копии не
     тот, что открыл установщик: запустите установщик ещё раз (он откроет порт из `host.json`);
   - отказ «this data folder is host … and its database is a working host's…» — в каталоге данных уже
     хост с пройденным мастером. Если мастер прошли по ошибке — та же команда с `--take-identity`;
     если удостоверение этого ПК нужно сохранить намеренно — с `--keep-identity` (тогда все устройства
     подключаются заново, подраздел «Копия без ключа хоста»);
   - отказ «the host identity beside the copy is damaged…» — возьмите другую копию или восстановите
     с `--keep-identity`.
7. Адрес. Станции помнят адрес старого ПК. Сертификат тот же, а устройства закрепляют его отпечаток,
   а не имя или адрес, поэтому подходит любой адрес нового ПК:
   - **лучше всего** дать новому ПК адрес старого (тот же IP или то же имя в DNS; резервирование DHCP
     — у ИТ клиента): станции выйдут на связь сами;
   - иначе на каждой станции и ПК офиса: «Офис» → под формой входа «Изменить адрес хоста» → адрес
     нового ПК (`192.168.1.20` или `192.168.1.20:45710`). Приложение примет адрес, только если там тот
     же хост (тот же сертификат) и он принимает ключ устройства; подключение, очередь и справочники
     остаются (`standalone-install.md`, «Новый адрес хоста»);
   - станция на самом новом ПК хоста — новая установка: если приложение на нём открывали до
     восстановления, оно подключилось к удостоверению установщика — «Подключить заново».
8. Запустить службу и выполнить раздел 5, шаги 8–9, и проверки раздела 7. Станции, вышедшие на
   связь, вернут блоки и снова поставят в очередь записи 30 дней; в «Резервные копии» у них «Вернула».
9. **Старый ПК.** Если он ожил — не запускать на нём службу хоста (`sc stop MarkiroHost`,
   `sc config MarkiroHost start= disabled`) и удалить «Markiro Автоном» с ролью хоста. Два хоста с
   одним ключом в одной сети: станция будет выходить на связь то с одним, то с другим.

### Что теряется и на новом ПК с ключом хоста

- Станции, подключённые **после** копии: копия их не знает, ключ отклоняется («Хост больше не
  принимает это устройство»). Они подключаются заново и теряют то же, что в проверке 4 раздела 7.
- Станция, которая работала на самом сломанном ПК хоста (роль «хост и станция»), умерла вместе с
  диском: её неотправленные записи и последние номера SSCC не вернутся. Проверка 1 по ней обязательна.
- Станция, не вышедшая на связь до «Возобновить», вернёт блоки позже; проверка 1 по ней обязательна,
  как на том же ПК.
- Отзывы и пароли после копии — как в проверке 3 раздела 7 (база нового ПК не история копии: отзывы
  не переносятся).

### Копия без ключа хоста

Копия, сделанная до обновления, копия из папки, права на которую хост не смог закрыть (флешка
FAT32/exFAT, общая папка без прав), или восстановление с `--keep-identity`: новый хост имеет другой
`hostId` и другой сертификат, и каждое устройство подключается заново по коду из офиса
(«Устройства → Подключить устройство»), офис на ПК администратора — тоже. Ключи устройств из копии
остаются в ней действительными: когда все станции подключены заново, отзовите в «Устройствах»
записи, которых больше нет. Всё, что станция делает для восстановленного хоста, привязано к её
текущему подключению, поэтому прежнее подключение с новым хостом больше не связано:

- записи, которые прежний хост принял после копии, на новом хосте не появятся, и ничто на экране об
  этом не скажет;
- неотправленные записи остаются на диске станции: «Подключить заново» сначала говорит, сколько их,
  и сбрасывает подключение только по кнопке «Сбросить всё равно»; отправить их потом нельзя;
- короба открытой смены не попадут ни в отчёты, ни в выгрузки хоста;
- блоки SSCC, полученные станцией после копии, новому хосту не сообщаются: уникальность SSCC держится
  на запасе счётчиков (не ниже, чем на 100 000 над копией) и на **проверке 1 раздела 7, которая здесь
  обязательна по каждой станции, по каждому префиксу и виду**;
- на странице «Резервные копии» станции, подключённые заново, остаются «Не вернула»: это не сбой.

Что делать: если старый ПК жив — до замены дождитесь нуля в «Не отправлено» и закройте смены; если
умер — **до повторного подключения** запишите на каждой станции последний напечатанный SSCC, номер
открытой смены, число коробов в ней и «Не отправлено»; не удаляйте каталог данных станции; работу за
период между копией и заменой ПК внесите в учёт вручную.
```

- [ ] **Step 4: памятка — разделы 7, 8, 9, 10**

Фрагмент (раздел 7, вступление)

<!-- prettier-ignore -->
```markdown
больше не использует, хотя номера из него уже могли быть напечатаны, а станция, подключённая заново
на новом ПК, не вернёт ничего (раздел 6). Решение принимает администратор.
```

заменить на

<!-- prettier-ignore -->
```markdown
больше не использует, хотя номера из него уже могли быть напечатаны, а станция, подключённая заново
(новый ПК из копии без ключа хоста или станция, подключённая после копии), не вернёт ничего
(раздел 6). Решение принимает администратор.
```

Фрагмент (проверка 1)

<!-- prettier-ignore -->
```markdown
  восстановления проверка обязательна, по всем станциям. **На новом ПК она обязательна всегда:**
  блоки, выданные станциям после копии, хосту не сообщит никто (раздел 6), и кроме запаса
  счётчиков от повторного SSCC на двух коробах эта проверка единственная защита.
```

заменить на

<!-- prettier-ignore -->
```markdown
  восстановления проверка обязательна, по всем станциям. **На новом ПК из копии без ключа хоста она
  обязательна всегда:** блоки, выданные станциям после копии, хосту не сообщит никто (раздел 6), и
  кроме запаса счётчиков от повторного SSCC на двух коробах эта проверка единственная защита. С
  ключом хоста станции вернут блоки сами, но база нового ПК всё равно не история копии — проверка по
  всем станциям обязательна, как сказано выше.
```

Фрагмент (раздел 8)

<!-- prettier-ignore -->
```markdown
  блоки номеров SSCC». На новом ПК предупреждения нет: прежнее подключение эпохи нового хоста не
  видит (раздел 6).
```

заменить на

<!-- prettier-ignore -->
```markdown
  блоки номеров SSCC». На новом ПК из копии с ключом хоста — так же. Из копии без ключа предупреждения
  нет: прежнее подключение эпохи нового хоста не видит (раздел 6).
```

Фрагмент

<!-- prettier-ignore -->
```markdown
- **Новый ПК.** Записи, блоки и смена прежнего подключения не переносятся в новое (раздел 6,
  открытое решение владельца).
- **Копия другого хоста.** Хост получает новое удостоверение, станции подключаются заново, а ключи
  устройств копии не отзываются автоматически (раздел 6, шаг 4).
```

заменить на

<!-- prettier-ignore -->
```markdown
- **Новый ПК.** С ключом хоста станции сохраняют подключение (раздел 6; решение владельца
  2026-10-11, план I1). Из копии без ключа записи, блоки и смена прежнего подключения в новое не
  переносятся (раздел 6, «Копия без ключа хоста»).
- **Ключ хоста в копиях.** Файл `.identity` — закрытый ключ хоста; защищён правами файла, не
  шифрованием (раздел 2). Папка без прав получает копию без него.
- **Копия другого хоста.** Без ключа хост получает новое удостоверение, станции подключаются заново,
  а ключи устройств копии не отзываются автоматически (раздел 6, «Копия без ключа хоста»). Поверх
  рабочего хоста другого удостоверения ключ копии ставится только с `--take-identity`.
```

Фрагмент

<!-- prettier-ignore -->
```markdown
  восстановления в офисе, копия удостоверения хоста (`host.json`, `tls/`; от этого зависит
  восстановление на новом ПК, раздел 6), постоянная строка
```

заменить на

<!-- prettier-ignore -->
```markdown
  восстановления в офисе, шифрование ключа хоста в копиях паролем, команда смены удостоверения хоста,
  поиск хоста в сети (станции узнают новый адрес вручную или по тому же IP), постоянная строка
```

Фрагмент (раздел 9)

<!-- prettier-ignore -->
```markdown
- [ ] Для нового ПК: до повторного подключения с каждой станции сняты последний SSCC, номер открытой
      смены и «Не отправлено»; проверка 1 сделана по каждой станции без исключений (раздел 6).
```

заменить на

<!-- prettier-ignore -->
```markdown
- [ ] Для нового ПК: копия с ключом хоста («host identity: host …» в `verify-copy`), ответ
      `restore` — «the copy's host identity was put in place»; новому ПК дан адрес старого или на
      каждой станции и ПК офиса изменён адрес хоста; служба хоста на старом ПК отключена (раздел 6).
      Из копии без ключа: до повторного подключения с каждой станции сняты последний SSCC, номер
      открытой смены и «Не отправлено»; проверка 1 сделана по каждой станции без исключений.
```

Фрагмент (раздел 10, пункт 9)

<!-- prettier-ignore -->
```markdown
   станции во время запуска службы: станция догоняет всё при возврате связи. Третий — восстановление
   на новом ПК со станциями, подключёнными заново (раздел 6): записать, что именно пропало (записи
   после копии, открытая смена, блок после копии), и проверить, что проверка 1 ловит повторный
   SSCC. Всё это не выполнялось: ни Windows, ни WebView2, ни настоящий `markiro-host restore`, ни
   две станции, ни настоящий принтер и сканер.
```

заменить на

<!-- prettier-ignore -->
```markdown
   станции во время запуска службы: станция догоняет всё при возврате связи. Третий — восстановление
   на новом ПК из копии с ключом хоста (раздел 6): станции на «Изменить адрес хоста» (и второй раз —
   новый ПК с IP старого) сохраняют подключение, возвращают блоки, «Вернула» у всех, после
   «Возобновить» нет `sscc_not_issued` и повторных SSCC. Четвёртый — из копии без ключа
   (`--keep-identity`): записать, что именно пропало (записи после копии, открытая смена, блок после
   копии), и проверить, что проверка 1 ловит повторный SSCC. Всё это не выполнялось: ни Windows, ни
   WebView2, ни настоящий `markiro-host restore`, ни две станции, ни настоящий принтер и сканер.
```

После пункта 10 раздела 10 дописать

<!-- prettier-ignore -->
```markdown
11. **Ключ хоста в копиях (план I1).** `icacls` закрывает `.identity` в локальной папке и в общей
    папке другого ПК рабочей группы (доступ только SYSTEM, «Администраторы» и учётная запись службы;
    обычный пользователь того ПК файл не открывает); флешка FAT32/exFAT второй папкой — копия без
    ключа, в офисе предупреждение «…без ключа хоста»; служба под `LocalService` и под локальной
    учётной записью — владелец файла и OWNER RIGHTS; администратор нового ПК читает `.identity`,
    скопированный с флешки; восстановление переименовывает `tls\key.der`, `tls\cert.der` и
    `host.json` при работающем антивирусе; старый ПК с отключённой службой не мешает новому.
```

- [ ] **Step 5: `standalone-install.md` — новый адрес хоста**

В `docs/runbooks/standalone-install.md` фрагмент

<!-- prettier-ignore -->
```markdown
     адрес. Если сертификат хоста действительно сменился (ПК хоста переустановлен с новыми данными или
     хост восстановлен на новом ПК, `standalone-backup-restore.md`, раздел 6), то отпечаток на ПК хоста
     (`markiro-host print-fingerprint`) уже не тот, что подключение помнит, и каждое устройство
     подключается заново по коду.
```

заменить на

<!-- prettier-ignore -->
```markdown
     адрес. Если сертификат хоста действительно сменился (ПК хоста переустановлен с новыми данными или
     хост восстановлен на новом ПК из копии без ключа хоста, `standalone-backup-restore.md`,
     раздел 6), то отпечаток на ПК хоста (`markiro-host print-fingerprint`) уже не тот, что
     подключение помнит, и каждое устройство подключается заново по коду.
   - Хост восстановлен на новом ПК из копии с ключом хоста (план I1): сертификат тот же — введите
     адрес нового ПК, подключение, очередь и справочники останутся.
```

- [ ] **Step 6: `apps/standalone/AGENTS.md`**

В разделе «Backups and restore» фрагмент

<!-- prettier-ignore -->
```markdown
- scheduled: at most one copy per UTC hour, in the first minute of an hour
```

заменить на

<!-- prettier-ignore -->
```markdown
- beside each copy the worker puts the host identity (plan I1,
  `backup/identity.rs`): `<name>.identity` holds `host.json`'s `hostId` and
  port and the TLS certificate and PKCS#8 key (JSON, base64 DER, format 1),
  and the manifest names it (`identity { fingerprint, sizeBytes, sha256 }`,
  optional: an older manifest or build reads on, and the format stays 1). It
  is written owner-only as `.partial`, closed by a `KeyFileGuard` (Unix
  `0600`; Windows `icacls /inheritance:r /grant:r` SYSTEM, Administrators and
  OWNER RIGHTS — the service's account), renamed, and only then is the
  manifest written. The worker reads the data folder's identity before every
  copy and leaves it out when it does not read or names another host. A
  guard or write that fails leaves the copy without it (that folder's
  manifest names none; the office warns `localNoIdentity`/`secondNoIdentity`
  when a folder's newest copy lacks it, and lists «Ключ хоста» per copy): the
  copy never fails for the identity. The second folder's replica is checked
  against the manifest and closed by that folder's guard; rotation deletes it
  with its copy (manifest, identity, database), cleaning removes an
  `.identity` beside no manifest. The file IS the host's private key: whoever
  reads it can answer the stations as their host, so it is protected like the
  copy's PIN hashes, never encrypted (no key to keep outside the copies;
  pilot spec §26). `HostIdentity`'s `Debug` prints the host id, port and
  fingerprint only;
- scheduled: at most one copy per UTC hour, in the first minute of an hour
```

Фрагмент

<!-- prettier-ignore -->
```markdown
the files fit neither, refuses and leaves them for support. A data folder
without `host.json` gets a new identity after the new database is checked:
every device pairs again. `markiro-host verify-copy` runs the same checks.
```

заменить на

<!-- prettier-ignore -->
```markdown
the files fit neither, refuses and leaves them for support. The host
identity (plan I1, `identity_plan`): a copy without one keeps the data
folder's (or creates a new one in a folder without `host.json`: every device
pairs again); a folder that already has the copy's identity changes nothing;
a folder without one, or whose database is absent or read without a wizard
(the new PC's installer), gets the copy's; a working host of another
identity (wizard done, or unreadable) is refused unless `--take-identity`
(its files are kept in `restore-<time>/identity/`); `--keep-identity` never
takes the copy's; a damaged identity beside the copy is refused unless
`--keep-identity`; `--without-manifest` reads none. The copy's identity is
staged in `identity.partial/` before the marker (`Intent.identity`) and
renamed into place after the database — key, certificate, `host.json` last —
so the host (refused while the marker is there) never serves a certificate
without its key; a cut-off restore finishes it first (`finish_interrupted`
now runs before `host.json` is read). `foreign` — and with it
`history_known`, the 100 000 margin and the carried revocations — is of the
identity the folder had BEFORE the restore: a restored identity never makes
the installer's or another host's database the copy's history. The `host.restore`
row names `identity` (`same`, `restored`, `kept`, `created`). `markiro-host
verify-copy` runs the same checks and prints the identity (a damaged one
fails it).
```

Абзац, начинающийся строкой `A restore on a NEW PC is not covered, and that is an open owner decision. The` и кончающийся строкой `this are the runbook's, done by a person before the resume.`, заменить целиком на

<!-- prettier-ignore -->
```markdown
A restore on a NEW PC keeps the stations' pairing when the copy carries the
host identity (owner decision 2026-10-11, plan I1): the same `hostId`,
certificate and device keys, so everything above applies unchanged. The
stations learn the new address by the PC taking the old one's IP or name, or
by «Изменить адрес хоста» (plan УСТ, `device_change_address`, which keeps the
pairing only where the pinned certificate answers and the host takes the
key); the certificate is not reissued — devices pin its SHA-256, not its
names. Still lost on a new PC: stations paired after the copy (the copy
does not know them, their key is refused, they pair again; as on any
restore), and the station that ran on the dead host PC itself. A copy
without the identity (older, from a folder that could not be closed, or
`--keep-identity`) keeps the old limit: every device pairs again, and what
the old pairing did after the copy never reaches the restored host (its
records acknowledged after the copy, its unsent records — they stay on the
disk, `device_forget` refuses with `unsent_facts` until confirmed — its open
shift's boxes and its post-copy SSCC blocks); SSCC uniqueness then rests on
the +100 000 margin and the runbook's check 1, which is mandatory. Two hosts
with one identity on one network would split the stations: the runbook
disables the old PC's service.
```

В разделе «Verification» фрагмент

<!-- prettier-ignore -->
```markdown
  copies of the station equal to the office's; and a restore on a new PC with
  the stations paired again (item 9, third run). Until then it has run only
```

заменить на

<!-- prettier-ignore -->
```markdown
  copies of the station equal to the office's; a restore on a new PC from a
  copy with the host identity, the stations keeping their pairing at the new
  address, and one without it, the stations paired again (item 9, third and
  fourth runs; the key file's ACLs, item 11). Until then it has run only
```

- [ ] **Step 7: спецификация пилота — раздел 24 и новый раздел 26**

В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` в разделе 24 фрагмент

<!-- prettier-ignore -->
```markdown
  - строка состояния для записей, оставшихся под прежним подключением (см. ниже);
```

заменить на

<!-- prettier-ignore -->
```markdown
  - строка состояния для записей, оставшихся под прежним подключением (при копии с ключом хоста не
    нужна, раздел 26);
```

Пункт, начинающийся `- **Открытое решение владельца: восстановление на новом ПК.**` и кончающийся `написана по варианту (3) и при выборе другого переписывается.`, заменить целиком на

<!-- prettier-ignore -->
```markdown
- **Восстановление на новом ПК — решено (владелец, 2026-10-11, вариант 1; план I1, раздел 26).**
  Копия несёт удостоверение хоста (`host.json` и сертификат с закрытым ключом), и на новом ПК
  станции сохраняют подключение: всё, что делает этот план, работает как на том же ПК. Прежняя
  потеря остаётся только для копии без ключа хоста (сделанной до плана I1, из папки без прав или с
  `--keep-identity`): тогда станции подключаются заново, записи и блоки прежнего подключения до
  восстановленного хоста не доходят, проверка 1 памятки обязательна по каждой станции. Станция,
  подключённая после копии, при любом восстановлении подключается заново, как и прежде.
```

В конец файла (после последнего раздела; если план ХП уже дописал раздел 25 — после него) дописать

<!-- prettier-ignore -->
```markdown

## 26. Уточнения плана I1

Источник — `docs/superpowers/plans/2026-10-11-standalone-i1-host-identity-restore.md`.

- **Решение владельца 2026-10-11 — вариант 1.** Копия несёт удостоверение хоста, и восстановленный
  на новом ПК хост остаётся для станций тем же: тот же `hostId`, тот же закреплённый сертификат, те
  же ключи устройств. Станции не подключаются заново; возврат блоков SSCC, повторная отправка
  записей 30 дней и удержание (раздел 24) работают как на том же ПК.
- **Файл.** Рядом с каждой копией — `markiro-host-…identity` (JSON формата 1: `hostId`, порт,
  сертификат и закрытый ключ в base64); манифест называет его отпечатком сертификата, размером и
  SHA-256 (необязательное поле, формат манифеста остаётся 1). Тройка `.db`, `.json`, `.identity` —
  самостоятельная копия: её переносят на флешку и восстанавливают где угодно.
- **Защита ключа.** Файл пишется только для владельца и закрывается до того, как получит имя: на
  Windows `icacls` оставляет доступ SYSTEM, «Администраторам» и владельцу файла (учётной записи
  службы), на Unix — `0600`. Папка, права которой закрыть нельзя (FAT32/exFAT, общая папка без
  прав), получает копию без удостоверения; копия из-за удостоверения не падает никогда. Шифрования
  нет: DPAPI привязан к машине, а пароль восстановления — новый секрет, утрата которого вернула бы
  к прежней потере. **Риск:** кто прочёл файл, может в сети цеха выдать себя за хост (станции
  отправят ему записи и ключи и примут справочники). Копия и раньше хранила хеши PIN и бейджей и
  требовала защиты как ПК хоста; ключ добавляет активную подмену. Утечка — повод сменить
  удостоверение (повторное подключение всех устройств; команды пока нет).
- **Восстановление.** Без флага ключ копии ставится, где ни одно подключённое устройство не теряет
  хоста: каталог без удостоверения или с удостоверением хоста, мастер которого не пройден (база
  установщика нового ПК); совпадающее удостоверение не меняется; над рабочим хостом другого
  удостоверения — отказ, пока инженер не скажет `--take-identity` (удостоверение каталога
  сохраняется в `restore-<время>/identity/`) или `--keep-identity` (ключ копии не берётся, все
  устройства подключаются заново). Испорченный ключ рядом с копией — отказ без `--keep-identity`.
  Удостоверение ставится после подмены базы под тем же маркером (ключ, сертификат, `host.json`
  последним), прерванное восстановление доделывает его первым; хост не запускается, пока маркер
  есть.
- **Запасы счётчиков не меняются.** Знает ли хост историю после копии, решается по удостоверению
  каталога ДО восстановления (исправление C1 инфраструктуры): на новом ПК база установщика не
  история копии, поэтому счётчики встают не ниже, чем на 100 000 над копией, а блоки, выданные
  станциям после копии, вдобавок регистрируются их возвратом (раздел 24).
- **Новый адрес.** Сертификат не перевыпускается: устройства закрепляют его отпечаток, а не имя или
  адрес. Станции узнают адрес двумя способами: новому ПК дают адрес старого (тот же IP или имя в
  DNS) — станции выходят на связь сами; иначе на каждой станции и ПК офиса «Изменить адрес хоста»
  (раздел 23). Поиска хоста в сети нет, офис адрес станциям не сообщает. Порт берётся из копии;
  если он не тот, что открыл установщик, сводка просит запустить установщик ещё раз. Старый ПК
  после восстановления — без службы хоста (два хоста с одним ключом делят станции).
- **Офис.** В таблице копий — «Ключ хоста» («есть»/«нет»), предупреждения, если последняя копия
  папки без ключа, строка о новом ПК в карточке «Восстановление». `verify-copy` печатает
  удостоверение и падает на испорченном.
- **Что теряется и с ключом:** станции, подключённые после копии (подключаются заново, как при любом
  восстановлении), и станция, работавшая на самом сломанном ПК хоста. Без ключа — прежняя потеря
  (раздел 24, памятка, раздел 6, «Копия без ключа хоста»).
- **Миграций нет**: удостоверение живёт в файлах.
- **Не сделано:** шифрование ключа паролем; команда смены удостоверения хоста; поиск хоста в сети и
  рассылка адреса из офиса.
- **Не проверено:** `icacls` на NTFS, на общей папке другого ПК и на флешке; владелец файла при
  службе под `LocalService` и локальной учётной записью; восстановление на настоящем новом ПК
  Windows с двумя станциями, тем же IP через DHCP и антивирусом (памятка, раздел 10, пункты 9 и
  11). Проверено на macOS: файл и права `0600`, `icacls` через подмену команд, восстановление на
  настоящих каталогах данных, станция на новом адресе против двух настоящих хостов на 127.0.0.1.
```

- [ ] **Step 8: план РК-С (если файл есть в дереве)**

Если в дереве есть `docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md`, пункт, начинающийся `- **Открыто (решение владельца, I-3).**`, заменить на

<!-- prettier-ignore -->
```markdown
- **Решено (владелец, 2026-10-11, вариант 1; план I1).** Восстановление на новом ПК: копия несёт
  удостоверение хоста, станции сохраняют подключение, и этот план работает без изменений. Прежняя
  потеря остаётся для копии без ключа хоста; памятка (раздел 6), `AGENTS.md` и раздел 24
  спецификации переписаны планом I1 (раздел 26).
```

Если файла нет — пропустить и записать в «Отклонения при исполнении».

- [ ] **Step 9: полная проверка**

Run:

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
- `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked --workspace` (вне песочницы — тесты оболочки поднимают хостов); счёт сверить с «Счётом тестов».
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `… run lint`, `… exec vitest run`
- `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check docs/runbooks/standalone-backup-restore.md docs/runbooks/standalone-install.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (и план РК-С, если правился)
- `git diff --check`

Expected: всё зелёное; отказы по пределу 5 с в посторонних файлах Vitest повторить отдельным запуском файла и записать.

После правок кода — `graphify update .`, если в дереве есть `graphify-out/graph.json`.

- [ ] **Step 10: коммит**

```bash
git add docs/runbooks/standalone-backup-restore.md docs/runbooks/standalone-install.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -F <файл сообщения>
```

(плюс путь плана РК-С, если он правился). Сообщение: `docs(standalone): a restore on a new PC keeps the stations' pairing — runbook section 6, AGENTS and pilot spec §26 (plan I1)` и трейлер.

## Перенесено

- **Шифрование `.identity` паролем** (ключ вне папки копий). Причина — Д4: новый секрет, утрата которого возвращает к варианту 3; DPAPI бесполезен на новом ПК.
- **Команда смены удостоверения хоста** (`markiro-host new-identity`): после утечки копии с ключом сейчас — разработчик вручную и повторное подключение всех устройств.
- **Поиск хоста в сети (mDNS) и рассылка адреса из офиса**: станции узнают адрес вручную или по тому же IP (Д3; mDNS перенесён ещё планом УСТ).
- **Перенос записей и блоков станций, подключённых после копии** (вариант 2 РК-С для них): они подключаются заново при любом восстановлении, как и раньше.
- **Хвосты ревью РК-С, не связанные с удостоверением**: M1 (хост не принимает пустой список блоков — «Не вернула» у станции без блоков), M2 (порядок частей блоков), M3 (окно 30 дней по записям, не по сменам), M4 (`refused_blocks`), M5 (строка «ждёт отправки 29 сут»), M6 (отказы `unknown_shift`) — не трогаются; это план ОЧ и последующие.
- **Проверка прав папки до сохранения**: хост не проверяет заранее, удержит ли вторая папка права ключа; узнаётся по первой копии (предупреждение офиса).

## Не проверено (без Windows и без настоящего восстановления)

- `icacls /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *S-1-3-4:F` на NTFS локальной папки, на общей папке другого ПК рабочей группы и на флешке FAT32/exFAT (ожидаемый отказ → копия без ключа); вызов идёт через `SystemCommands` по абсолютному пути из `%SystemRoot%`, но ни разу не исполнялся.
- Владелец файла и OWNER RIGHTS при службе под `LocalService`, `NetworkService` и локальной учётной записью `markiro-backup`; чтение `.identity` администратором нового ПК (с флешки) и пользователем ПК со второй папкой (должен быть отказ).
- Переименование поверх `tls\key.der`, `tls\cert.der`, `host.json` под антивирусом (повторы `rename_retrying` те же, что у базы).
- Восстановление на настоящем новом ПК Windows: установщик, `restore`, две станции, «Изменить адрес хоста» в WebView2, новый ПК с IP старого через DHCP, старый ПК с отключённой службой.
- Столбец «Ключ хоста» и предупреждения в WebView2 (только jsdom).

## Отклонения при исполнении

- **Задача 1.**
  - Защита файла ключа усилена сверх брифа: `<имя>.identity.partial` создаётся исключительно (`create_new`, `0600`), закрывается охранником ещё пустым, и только потом в него пишется ключ (в брифе — запись, затем защита).
  - Старый `.partial` удаляется заранее, так что запись не идёт через подложенную ссылку.
  - Чтение ограничено 64 КиБ (`MAX_IDENTITY_BYTES`, `read_bounded`); `IdentityError::code()` даёт стабильные коды `identity_unreadable` / `identity_invalid`.
  - Тестов модуля 18 вместо 7.
  - Итоговое ревью нашло, что ключ всё же дописывался по пути после закрытия (гонка с открытым дескриптором на Windows и подмена ссылкой на Unix); исправлено волной итогового ревью (`110efa811`).
- **Задача 2.**
  - Сверх брифа 8 тестов `backup_copy` и 2 `backup_worker` (сбой копии после записи удостоверения, сбой второй папки, ротация, очистка, отказ охранника, нечитаемое удостоверение каталога).
  - Якорь фикстуры `backup-state.json` найден по `sha256`, а не по имени файла копии.
  - Ротация останавливалась на `.identity`, которое нельзя удалить (закреплено мутантом F07); итоговое ревью перевернуло это решение (`dc6b8d424`).
- **Задача 3.**
  - `CopyIdentity::Damaged(String)` заменён на `Damaged(IdentityDamage { code, reason })` ради стабильных кодов.
  - В `identity.rs` добавлен `read_beside_coded` (`read_beside` — обёртка над ним с прежними текстами), хотя бриф этот файл не называл.
  - Временные `#[cfg_attr(not(test), allow(dead_code))]` у `IdentityPlan`, `audit_word`, `identity_plan` сняты в задаче 4.
  - Сверх плана: таблица на 90 сочетаний с оракулом по Д6, тест испорченных удостоверений через `verify_copy`, файл в 1 МиБ, тест настоящего бинаря `verify-copy`.
  - `verify-copy` печатает строку `ok (…)` до отказа по испорченному удостоверению; код возврата и `DAMAGED` в stderr верны.
- **Задача 4.**
  - Помощник теста `installed()` берёт блокировку, как `start`: без этого отказ видел файл блокировки как изменение каталога.
  - Папка `restore-<время>` создаётся и тогда, когда базы нет, а удостоверение каталога заменяется (Д8 говорил «если папка есть»); `saved_as`, `savedAs` аудита и строка сводки по-прежнему привязаны к настоящей отложенной базе.
  - Добавлены точки обрыва `IdentityStaged`, `IdentityKeySaving`, `IdentityCertificate`, `IdentityInPlace` (`#[doc(hidden)]`); `finish_interrupted` получает `crash`.
  - `keep_replaced` копирует через синхронизированный `.partial` с переименованием, а не `copy_private` сразу в итоговое имя.
  - После установки удостоверение должно прочитаться целиком (`HostIdentity::read`), иначе маркер остаётся.
  - Подготовленное удостоверение удаляется до маркера при обоих откатах.
  - Тестов `--test restore` +13 вместо +5, `--lib` +2.
  - Строка «отозванные после копии снова действуют» первого прогона теряется, если восстановление доделано следующим прогоном; сирота `identity.partial/` после обрыва до маркера остаётся до следующего восстановления. Оба ограничения записаны в памятку (задача 7).
- **Задача 5.**
  - Тексты `localNoIdentity` / `secondNoIdentity` называют все причины (прежняя версия хоста, пропавший файл, для второй папки — FAT32/exFAT): список несёт только `hostIdentity: boolean` и не отличает «нет ключа» от «ключ испорчен».
  - Сверх плана: пояснительная строка `identity.note` под таблицей копий.
  - Тестов Vitest +5 вместо +2.
- **Задача 6.**
  - Сквозной тест расширен: удержание фактов, регистрация блоков, «Возобновить», вход офиса заново после смены адреса (восстановление удаляет все сеансы офиса), номер ревизии и устройства.
  - Сверх плана пять отрицательных случаев: копия без ключа, копия другого хоста, три вида порчи (байт при той же длине, чужой ключ под этим сертификатом, пропавший файл).
  - Тестов 7 вместо 2.
  - Помощник `copy_now` повторяет запрос до 202: автоматическая копия работника давала 409 `backup_running`.
  - «Новый адрес» в тесте — другой порт петли, не другой ПК.
- **Задача 7.**
  - Исполнена после слияния `claude/integration` (`f10dacf70`). Первый полный Vitest дал 3 отказа `forms-parity.test.ts` из-за устаревшего `packages/domain/dist`; после сборки `@markiro/domain` всё зелёное.
  - В документах — настоящая надпись кнопки «Сменить адрес хоста», а не «Изменить адрес хоста»; строку сводки хоста исправила волна итогового ревью. В разделе «Не проверено» этого плана осталась прежняя надпись.
  - Текст предупреждения офиса взят из задачи 5, а не из брифа.
  - Файла плана РК-С `2026-10-11-standalone-rk-s-station-restore.md` в дереве нет, шаг 8 пропущен.
  - Спецификация на ветке кончалась разделом 24, поэтому раздел 26 дописан в конец.
  - Сверх брифа исправлены устаревшие места памятки и спецификации: шапка, раздел 7, раздел 8 «Не реализовано», упоминание пары файлов в разделе 5, перекрёстные ссылки, §22, описание `verify-copy`.
- **Слияние с ХП и ОЧ.** В памятке восстановления сохранена структура I1 (копия с ключом / без ключа), формулировки ОЧ и ХП влиты в неё; в спецификации раздел I1 остался 26-м после 25-го (ХП).
- **Счёт тестов.** Числа плана — приращения. Измерено: `markiro-host --lib` +18 (задача 1), +4 (3), +2 (4); `--test backup_copy` 28 → 40, `--test backup_worker` 13 → 17; `--test restore` 33 → 37 → 50; бинарь +1; `--test restore_identity` 7; Vitest +5 (148 файлов, 4612 тестов). `cargo test --workspace`: 1142 после задачи 1, 1189 после задач 6 и 7, 1197 после волны итогового ревью.
- **Итоговое ревью.**
  - Критических замечаний нет, важных три, мелких восемь.
  - Волна из четырёх коммитов:
    - `110efa811` — ключ пишется через тот же дескриптор, что закрыл охранник, без повторного открытия по пути; на Windows — `share_mode(0)`; на Unix перед переименованием проверяется, что имя всё ещё указывает на открытый файл, иначе ключ стирается из отодвинутого файла, а копия идёт без удостоверения. Сверх ревью — новый модуль `key_file.rs` (ради проверки ветки Windows отдельным крейтом).
    - `dc6b8d424` — ротация удаляет манифест, базу, затем удостоверение; неудаляемое `.identity` или его `.partial` пишется в журнал и не останавливает ни ротацию, ни очистку. Тест F07 заменён тестом нового поведения.
    - `2f554933b` — сводка восстановления называет «Сменить адрес хоста»; текст доделанного прерванного восстановления; тест, что после полного отката подмены не остаётся `identity.partial` (выживший мутант K05).
    - `9632d9194` — памятка и §26: устройство, отозванное после копии, само подключается к восстановленному на новом ПК хосту, поэтому сначала другой адрес и отзыв заново, потом адрес старого ПК; проверка подмены не ловит подмену с правкой манифеста; права NTFS на флешке ключ не защищают; отмена восстановления на новом ПК не возвращает прежнее удостоверение.
  - Перенесены владельцу (проверка на Windows, памятка, раздел 10, пункт 11) или в последующие планы:
    - `icacls` при `share_mode(0)`, OWNER RIGHTS, переименование под антивирусом, неудаляемое `.identity` после смены учётной записи службы;
    - удаление сироты `identity.partial/` при старте хоста;
    - различение «нет ключа» и «ключ испорчен» в списке копий (нужно поле протокола);
    - строка `ok` у `verify-copy` перед отказом;
    - реакция станции на новую эпоху восстановления, WebView2, настоящий второй ПК.
