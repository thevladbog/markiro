# План РК: резервные копии и восстановление «Markiro Автоном» — копии хоста на ходу, вторая папка, страница офиса, восстановление с подъёмом счётчиков и сверкой станций — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост сам делает проверенные копии главной базы — по расписанию (не чаще раза в час, пока база меняется, и хотя бы раз в сутки) и по кнопке «Сделать копию сейчас», — хранит их по правилу 24/14/12 в своей папке и во второй папке (общая папка на другом ПК или флешка), показывает состояние и сбои в офисе; `markiro-host restore` возвращает копию при остановленной службе, поднимает счётчики SSCC и номера смен над обеими базами, объявляет новую эпоху в `hello` и держит факты станций, пока станции не вернут свои блоки и администратор не возобновит приём.

**Architecture:**

- Хост, `host/src/backup/`: `copy.rs` — одна копия (`VACUUM INTO` в `.partial` на собственном соединении, `PRAGMA integrity_check` на файле копии, размер и SHA-256, манифест `<имя>.json`); `folder.rs` — список проверенных копий папки, уборка остатков, ротация, перенос во вторую папку со сверкой SHA-256, проба папки; `retention.rs` — правило 24/14/12 по UTC; `worker.rs` — задача-исполнитель: расписание по `PRAGMA data_version`, ручная копия, состояние в памяти, строка журнала `backup.create`. `crate::start` запускает исполнителя и ждёт его при остановке.
- Хост, маршруты: `routes/backups.rs` — `GET /v1/office/backups` (все роли), `POST /v1/office/backups` (копия сейчас, `202`), `PUT /v1/office/backups/settings` (вторая папка с пробой), `POST /v1/office/backups/resume` (возобновить приём фактов); `routes/known_blocks.rs` — `POST /v1/device/sscc/blocks/known` (станция возвращает блоки после восстановления); слой `server::restore_hold` отвечает на факты и проверки кодов станций `restore_pending`, пока приём удержан.
- Хост, CLI: `host/src/restore.rs` и `markiro-host restore <копия> [--data-dir] [--without-manifest]`, `markiro-host verify-copy <копия> [--without-manifest]`.
- Миграция `0011_backups.sql`: `backup_settings` (вторая папка), `site.restore_epoch`, `site.facts_held_since`, `devices.known_blocks_epoch`.
- `proto/src/backup.rs` и фикстуры; `Hello.restoreEpoch`; код ошибки `restore_pending`. Вебвью: `src/host/backups.ts` (Zod), `HostApi.{getBackups,startBackup,updateBackupSettings,resumeFacts}`, страница «Сервис → Резервные копии» (`src/office/backups/`) и предупреждения на «Обзоре».
- `docs/runbooks/standalone-backup-restore.md` — настройка второй папки, еженедельная флешка, восстановление на том же и на новом ПК.

**Tech Stack:** Rust — sqlx 0.8.6 (SQLite: `VACUUM INTO`, `PRAGMA data_version`, `integrity_check`, read-only и immutable соединения), axum 0.8.9 (`middleware::from_fn_with_state`), tokio 1.53.1 (`Notify`, `interval`, `spawn_blocking`), aws-lc-rs 1.18.1 (`digest::Context`, SHA-256), time 0.3.55, serde, uuid 1; TypeScript — React 19, Zod 4.4.3, react-query 5, react-hook-form 7, Vitest 4, `@markiro/ui` (`Card`, `DefinitionGrid`, `Table`, `Alert`, `ConfirmDialog`, `Input`).

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — раздел 11 (копии и восстановление), строка 16 таблицы 4.1, вопрос П14 раздела 14, сокращение 8 раздела 13, раздел 15 (что нельзя проверить без Windows), раздел 16 (цеховой ПК как хост).
- `docs/superpowers/specs/2026-09-26-standalone-station-design.md` — §9.3 (копии и восстановление), §11 (таблица отказов: испорчена база, кончается место), §12.1 (цикл «копия → восстановление»), §15 (24 часовые, 14 суточных, 12 месячных).
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §4.1 (каталог данных; `host.lock` в копию не входит), §4.2 (прагмы), журнал действий, ошибки, роли.
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — §4.3 (блоки SSCC), §4.4 (квитанции хранятся бессрочно), решение 31 (станция хранит подтверждённые факты 30 дней).
- `docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md` и `.superpowers/sdd/2a2-task-2-review.md` (решение владельца 1: отказ в квитанции хранится навсегда; РК держит факты до сверки).
- `apps/standalone/AGENTS.md` — «Audit», «Writes», «Protocol», «Shifts», «Logs», «Verification»; образцы планов — `docs/superpowers/plans/2026-10-08-standalone-2a1-host-shifts.md`, `docs/superpowers/plans/2026-10-09-standalone-imp-cloud-import.md`.

## Допущения по вопросам владельцу

Владелец не ответил на вопросы раздела 14 спецификации пилота. План принимает рекомендованный ответ каждого вопроса, который касается копий; ниже — что принято и что поправить при другом ответе.

- **П14 — вторая папка: общая папка на ПК, где не стоит хост, плюс еженедельная флешка.** Хост пишет во вторую папку по полному сетевому пути (`\\ПК-АДМИНИСТРАТОРА\MarkiroCopies`) или в папку на флешке (`E:\Markiro`) — путь задаёт администратор, хост его пробует перед сохранением. Флешка раз в неделю — ручная процедура памятки (раздел 2) с проверкой `markiro-host verify-copy` или `Get-FileHash`. Если владелец выберет только флешку — та же настройка с путём на флешке, код не меняется.
- **П14, следствие для Windows (решение владельца с ИТ клиента).** Служба `MarkiroHost` пишет в общую папку от имени своей учётной записи. План УСТ ставит её под `NT AUTHORITY\LocalService`, а эта учётная запись в сети входит анонимно; в рабочей группе без домена общая папка другого ПК её запись не примет (офис покажет «нет прав на запись»). Принято по умолчанию: вторая папка по сети работает, когда служба запущена под локальной учётной записью с одним именем и паролем на обоих ПК (`markiro-backup`, памятка, раздел 2) — это меняет решение плана УСТ и требует шага владельца; до него вторая папка — флешка, вставленная в ПК хоста (`E:\Markiro`; `LocalService` пишет на FAT32/exFAT и на NTFS с правом «Прошедшие проверку»). Код плана от выбора не зависит; проверяется только на Windows.
- **П1 — Б (ответ владельца, записан в плане УСТ).** Хост на ПК станции: локальная папка — на ПК станции, вторая — на ПК администратора (или флешка). Удостоверение хоста (`host.json`, `tls/`) в копию не входит, как сказано в спецификации этапа 1 (§10, «лечится повторным подключением»): при восстановлении на новый ПК устройства подключаются заново («Перенесено», п. 3).
- **П10 — рекомендации этапа 2a приняты:** станция хранит подтверждённые факты 30 дней (решение 31); памятка предупреждает о копии старше 30 дней.
- **П13 — обновления переустановкой:** копии «перед обновлением» (спецификация, §9.3) нет — «Перенесено», п. 5.
- **Сокращение 8 раздела 13 не принято:** хостовая часть повторной регистрации блоков в плане (задача 6); сторона станции — малый план РК-С после исполнения 2a5 и 2a6 («Перенесено», п. 1): план 2a6 относит её к РК, а кода станции на ветке ещё нет.
- **Решение владельца 1 из ревью задачи 2 плана 2a2 (отказ в квитанции хранится навсегда) принято как есть:** вместо изменения квитанций хост после восстановления держит факты и проверки кодов (`restore_pending`), пока администратор не возобновит приём (задача 6).
- **Номер миграции.** Последняя миграция в планах — `0010_facts.sql` плана 2a2; планы ПЛ-Х и О-Х ещё не написаны. План берёт `0011_backups.sql`. Если к исполнению номер занят, миграция получает следующий свободный номер; тесты номер не называют (`latest_migration()` читает его из `MIGRATOR`).

## Шаги владельца

Новых зависимостей нет: `Cargo.toml`, `Cargo.lock`, `package.json` и `pnpm-lock.yaml` не меняются, задачи «шаг владельца» нет. SHA-256 считает уже подключённый `aws-lc-rs`, SQLite-копию — `VACUUM INTO` штатного sqlx. Владелец даёт для испытаний (их нет в автоматических проверках):

1. Решение с ИТ клиента об учётной записи службы `MarkiroHost` для записи в общую папку на ПК администратора: план УСТ ставит службу под `LocalService`, которая в рабочей группе в чужую общую папку не пишет (памятка, раздел 2; «Перенесено», п. 7). До решения вторая папка — флешка в ПК хоста.
2. Два ПК с Windows 10/11 в одной рабочей группе для проверки второй папки по сети, флешку, учебное восстановление на испытаниях (памятка, разделы 5–7).

## Global Constraints

**Решения спецификаций, обязательные для РК**

1. Хост делает копию на ходу штатным механизмом SQLite: ежечасно во время работы, ежесуточно и по кнопке «Сделать копию сейчас» (пилот, §11).
2. Каждая копия проверяется `PRAGMA integrity_check` на самой копии (пилот, §11).
3. Хранятся 24 часовые, 14 суточных и 12 месячных копий (пилот, §11; родительская спецификация, §15).
4. Копии — в локальной папке на ПК хоста и во второй папке (сетевая папка на другом ПК площадки или флешка); сбой копирования во вторую папку — заметное предупреждение в офисе, а не строка журнала (пилот, §11).
5. Офис, «Сервис → Резервные копии»: время последней проверенной копии в каждой папке, настройка второй папки, ручная копия, список копий (пилот, §11).
6. Восстановление в пилоте — процедура поддержки: `markiro-host restore <файл>` при остановленной службе; текущая база сохраняется рядом; счётчики SSCC поднимаются на два размера блока по каждому расширению и префиксу, номера смен — на 10; хост получает новую «эпоху» в `hello` (пилот, §11).
7. Станция, увидевшая новую эпоху, отправляет свои блоки `POST /v1/device/sscc/blocks/known`; хост регистрирует блок, если тот не пересекается с блоками других устройств, и поднимает над ним счётчик; затем станция досылает факты (пилот, §11).
8. `host.lock` — не данные, в копию и восстановление не входит (этап 1, §4.1).
9. Квитанции хранятся бессрочно (2a, §4.4); отказ в квитанции после восстановления был бы окончательным — поэтому до сверки хост отвечает на факты транспортной ошибкой, а не квитанцией (ревью 2a2, решение владельца 1).

**Решения планировщика** (уточнения; задача 8 записывает их в `AGENTS.md` и в раздел 11 спецификации пилота)

- **Копия** — `VACUUM INTO '<папка>/markiro-host-<UTC-время>-<8 hex>.db.partial'` на собственном соединении исполнителя: это читатель, он не ждёт писателя и не видит незакоммиченного (тест держит блокировку записи всю копию). Затем `integrity_check` на файле, открытом только для чтения и неизменяемым (рядом не появляются `-wal`/`-shm`), размер и SHA-256, переименование, манифест `<имя>.json` (`format` 1, `file`, `createdAt`, `trigger`, `hostId`, `schemaVersion`, `sizeBytes`, `sha256`). Любой сбой не оставляет от копии ничего.
- **«Ежечасно во время работы»** — не больше одной плановой копии в час по UTC, в первую минуту часа, в котором база изменилась после прошлой удачной копии; «изменилась» — `PRAGMA data_version` собственного соединения исполнителя, которое двигают только чужие соединения (строка журнала самого исполнителя копию не вызывает). **«Ежесуточно»** — хотя бы одна копия за сутки по UTC, даже без изменений. Неудачный час не повторяется до следующего; копия делается и при каждом запуске хоста.
- **Ротация** — один поток копий: 24 последних, последняя копия каждого из 14 последних дней и каждого из 12 последних месяцев (UTC), при равном времени — по имени. Хост трогает только имена `markiro-host-*`; `.partial` и `.db` без манифеста — остатки сломанной копии, их убирает следующий запуск.
- **Вторая папка** получает только проверенную локальную копию: `.partial`, синхронизация, чтение обратно и сверка размера и SHA-256 с манифестом, переименование, тот же манифест. Хост никогда не создаёт вторую папку. Перед сохранением настройки хост пробует папку вне блокировки записи и не дольше 8 с (`conflict` на `backup_dir` с `details.reason`: `missing`, `not_a_directory`, `access_denied`, `unwritable`, `timeout`, `inside_data_dir`); путь — абсолютный, 1–260 символов без управляющих (`validation_failed` на `secondDir`); `secondDir` в теле обязателен, `null` — перестать копировать.
- **Сбои** — коды `destination_unavailable`, `access_denied`, `disk_full`, `write_failed`, `verify_failed`, `local_copy_failed`, `internal` (`markiro_proto::backup::failure`). Исход каждой папки — в состоянии в памяти (`GET /v1/office/backups`) и в строке журнала `backup.create` (`failed`, если хоть одна папка копию не получила). Прогон — отдельная задача: паника — сбой `internal` этого прогона, исполнитель продолжает. Офис предупреждает: удержание фактов, неудачная последняя попытка в любой папке, нет копий, последней копии больше 26 часов (по часам хоста), вторая папка не задана, копия идёт дольше 30 минут — на странице и на «Обзоре».
- **Ручная копия** — `POST` отвечает `202` сразу, исполнитель делает копию и пишет строку журнала от имени администратора; пока копия идёт или ждёт — `conflict` на `backup_running`; сам запрос строки журнала не пишет. Страница перечитывает состояние каждую секунду, пока копия идёт.
- **Восстановление** ничего не трогает, пока копия не прошла проверку (манифест или `--without-manifest`, `integrity_check`, каждая миграция копии известна этой сборке с той же контрольной суммой, мастер пройден). Текущая база читается только для чтения, если открывается, — и с WAL, оставленным остановившимся хостом (созданные чтением `-wal`/`-shm` удаляются). Затем она переносится в `restore-<UTC-время>/`, копия встаёт на место и мигрируется, и одной транзакцией на одном соединении (закрытом до конца команды) счётчик каждого префикса и расширения поднимается на 2 блока своего расширения над наибольшим номером, известным любой из баз (не дальше последнего номера префикса), номер смены каждого месяца — на 10 над обеими, от месяца копии до текущего (± сутки); новая `site.restore_epoch`, `site.facts_held_since`, одна строка `host.restore`. Любой сбой после переноса возвращает текущую базу. Каталог без `host.json` получает новое удостоверение.
- **Удержание фактов**: от восстановления до решения администратора слой над всем роутером отвечает на `POST /v1/device/facts` и `GET /v1/device/codes/{…}` кодом `restore_pending` (503, `details.since`) раньше маршрута и проверки устройства — путь удерживается, какой бы план ни добавил его маршрут (на ветке без 2a2 маршрута ещё нет). Блоки, смены и лента не удерживаются. `POST /v1/office/backups/resume` (администратор) снимает удержание; без удержания ничего не меняет.
- **Возврат блоков**: только станция, только после восстановления (`conflict` на `no_restore`), 1–64 блока; каждый блок — `known` (такой же блок этой станции есть), `refused` `block_mismatch` (другой блок с этим id или id уже был запросом станции), `prefix_unknown`, `range_invalid`, `block_overlap` (общий номер с любым блоком, отозванные тоже) или `registered` (id блока становится id запроса, счётчик поднимается только вперёд). Одна ревизия, если что-то зарегистрировано; станция отмечается эпохой (`devices.known_blocks_epoch`) при любом исходе — офис показывает, какие станции вернули блоки.
- **Протокол** остаётся 2: новые поля и маршруты добавочные; `restoreEpoch` в `hello` есть только после восстановления (`skip_serializing_if`), строгая схема Zod `helloSchema` принимает его необязательным. Код `restore_pending` добавлен в `codes::ALL`, `error-codes.json` и `API_ERROR_CODES`.

**Журнал действий** (словарь `audit::actions`)

| Действие                 | Исполнитель                                        | `target_type`/`target_id`     | `details`                                                                                                                         |
| ------------------------ | -------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `backup.create`          | хост (плановая) или администратор, нажавший кнопку | `backup`/имя файла или `null` | `{ trigger, file, sizeBytes, sha256, local: { ok, code }, second: null \| { ok, code } }`; `failed`, если папка не получила копию |
| `backup.settings.update` | администратор                                      | `backup_settings`/`1`         | `{ changed: ["secondDir"], secondDir: { from, to } }`                                                                             |
| `host.restore`           | хост                                               | `site`/`1`                    | `{ file, sha256, copyCreatedAt, current, savedAs, epoch, counters: [...], shiftNumbers: [...] }`                                  |
| `host.restore.resume`    | администратор                                      | `site`/`1`                    | `{ since, epoch, stations, reconciled }`                                                                                          |
| `sscc.block.register`    | станция                                            | `sscc_block`/id блока         | `{ issuerPrefix, extension, fromSerial, toSerial }`                                                                               |

Не пишут строк: запрос ручной копии, отказы (`validation_failed`, `forbidden`, `conflict`, `stale_revision`), повтор той же папки, возобновление без удержания, блоки `known` и `refused`.

**Код и процесс**

- Правила записи из `apps/standalone/AGENTS.md` («Writes»): `begin_write`, одна `next_revision` на меняющую транзакцию с данными ленты или офиса, коммит через `commit_with_revision`, пул не трогать при открытой транзакции записи, нет изменений — нет ревизии, строки и строки журнала. Отметка станции и снятие удержания — не данные ленты, ревизии не берут.
- В журнале процесса — пути и коды; никаких хешей, ключей, токенов; в строке журнала действий — только коды сбоев, не текст ошибки.
- Не меняются: `apps/station`, `packages/*`, `apps/api`, `src-tauri`, миграции `0001`–`0010`, `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`.
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, и встречается в файле один раз; правки одного файла идут сверху вниз. Шаг тестов применяется раньше шага реализации.
- «Создать» — новый файл, ровно как в блоке. `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть файла. Блоки уже отформатированы `cargo fmt` и prettier.
- Русский текст — буквами, не `\uXXXX`.
- План проверен на копии репозитория с HEAD `7cf28790e` (без 2a2, ИМП, 2a3–2a5): блоки всех 8 задач применены по порядку на чистое дерево, после каждой задачи файлы совпали побайтно с проверенной историей, тесты каждой задачи падали до реализации и проходили после, мутации каждой задачи — ниже. Если к исполнению в общие файлы (`server.rs`, `audit.rs`, `lib.rs`, `routes/mod.rs`, `proto/src/lib.rs`, `error-codes.json`, `errors.ts`, `ru.json`, `nav.ts`, `routes.tsx`, `api.ts`, `test/support/office.tsx`, `AGENTS.md`) влит параллельный план и фрагмент не находится, правка вносится по смыслу рядом с тем же местом, а отличие записывается в «Отклонения при исполнении».

**Мутации**

- Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (для задач с Rust); `node_modules/.bin/prettier --check` на изменённые JS, TS, JSON и MD; `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` и **своим `CARGO_TARGET_DIR` для каждого рабочего дерева** (например, `CARGO_TARGET_DIR=/tmp/claude/<дерево>-target`). Общий каталог сборки двух деревьев с одинаковой структурой отдаёт тестам библиотеку `markiro-host` другого дерева: при написании плана тесты одного дерева так собрались против кода другого («could not find `backup` in `markiro_host`» при исправном коде); лечится `cargo clean -p markiro-host -p markiro-proto`.
- Наборы, которые слушают 127.0.0.1, в песочнице падают на `bind`: `--test hello`, `--test backup_start` и весь `cargo test -p markiro-host` — вне песочницы. Остальные новые наборы (`backup_schema`, `backup_copy`, `backup_retention`, `backup_worker`, `backup_routes`, `restore`, `known_blocks`, `restore_hold`) и `-p markiro-proto` — в ней. Если Xcode требует принять лицензию, команды `git` и `cargo` запускаются с `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- pnpm — только с `--config.verifyDepsBeforeRun=false`, из корня, без `cd`; в свежем рабочем дереве сначала `pnpm --config.verifyDepsBeforeRun=false install --frozen-lockfile --prefer-offline --filter '@markiro/standalone...'` (сеть: registry.npmjs.org) и `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Если вывод выглядит урезанным (локальная обёртка `rtk`), запускайте `rtk proxy <команда>`.
- Тесты хоста не зависят от плана 2a2: они трогают таблицы этапа 1, `0009` и `0011`. На ветке без 2a2 `POST /v1/device/facts` без удержания отвечает `not_found` — тест `a_host_that_holds_nothing_lets_the_facts_through` проверяет только, что это не `restore_pending`.

**Счёт тестов**

- До плана (HEAD `7cf28790e`): `cargo test -p markiro-host -p markiro-proto` — 34 итоговые строки `test result`, 410 тестов; Vitest — 67 файлов, 1744 теста.
- После: cargo — 44 строки, 477 тестов (хост +61: `backup_schema` 4, `backup_copy` 15, `backup_retention` 4, `backup_worker` 8, `backup_start` 2, `backup_routes` 7, `restore` 9, `known_blocks` 7, `restore_hold` 4, разбор команд `markiro-host` +1; `proto` +6); Vitest — 70 файлов, 1766 тестов (`backups.test.ts` 6, `backup-warnings.test.ts` 7, `backups-page.test.tsx` 9). Под посторонней нагрузкой на машине тесты редакторов шаблонов (`template-editor`, `template-defaults-page`, `templates-page`, `template-code-downloads`) падают по тайм-ауту 5 с и на базе `7cf28790e` (проверено при написании плана: та же картина на чистой базе) — запускать полный набор без параллельных сборок.
- Если до исполнения в ветку влиты 2a2, ИМП или другие планы, базовые числа больше на их тесты; прибавка РК та же.

**Что исполнитель может проверить на macOS и чего не может**

- Может: всё выше — копия при удержанной блокировке записи, повреждённые и чужие файлы, папка без прав (`chmod 0555`), ротация, вторая папка во временном каталоге, расписание на ручных часах, маршруты, восстановление с WAL «упавшего» хоста и откат при сбое, удержание и возврат блоков, страница в jsdom.
- Не может: службу Windows и её учётную запись при записи в общую папку другого ПК, UNC-пути и их тайм-ауты, буквы флешек и флешку, вынутую посреди копии, коды ошибок Windows (`ERROR_BAD_NETPATH` и др., ветка `cfg(windows)` в `classify_io`), настоящий полный диск (проверено искусственным `SQLITE_FULL` через `max_page_count`), `sc stop`/`sc start`, права службы на восстановленные файлы, печать и WebView2. Это — раздел 7 памятки и приёмка у владельца.

## Файлы

```
apps/standalone/host/migrations/0011_backups.sql                                           задача 1
apps/standalone/proto/src/{backup.rs,lib.rs}, proto/tests/backup.rs                         задача 1
apps/standalone/proto/fixtures/{backup-state,backup-state-running,backup-state-held,backup-settings-update,
  known-blocks-request,known-blocks-response,hello-restored,backup-codes,error-restore-pending,error-codes}.json   задача 1
apps/standalone/host/src/{server.rs,config.rs}, host/tests/backup_schema.rs                 задача 1
apps/standalone/src/host/{backups.ts,protocol.ts,errors.ts}, src/i18n/ru.json, test/backups.test.ts   задача 1
apps/standalone/host/src/{db.rs,lib.rs}, host/src/backup/{mod,copy,folder,retention}.rs     задача 2
apps/standalone/host/tests/{backup_copy,backup_retention}.rs, tests/support/{app,mod,backup}.rs   задача 2
apps/standalone/host/src/backup/{worker,mod}.rs, host/src/{audit,server,lib}.rs             задача 3
apps/standalone/host/tests/{backup_worker,backup_start}.rs                                  задача 3
apps/standalone/host/src/routes/{backups,mod}.rs, host/src/{server,audit}.rs                задача 4
apps/standalone/host/tests/{backup_routes,backup_start}.rs                                  задача 4
apps/standalone/host/src/{restore,lib,audit,main}.rs, host/tests/restore.rs                 задача 5
apps/standalone/host/src/routes/{known_blocks,backups,mod}.rs, host/src/{server,audit}.rs   задача 6
apps/standalone/host/tests/{known_blocks,restore_hold}.rs                                   задача 6
apps/standalone/src/host/api.ts, src/office/backups/*, src/office/{OfficeOverview.tsx,access.ts,nav.ts,
  office-query.ts,routes.tsx}, src/i18n/ru.json                                             задача 7
apps/standalone/test/{backup-warnings.test.ts,backups-page.test.tsx}, test/support/{backups.ts,office.tsx}   задача 7
docs/runbooks/standalone-backup-restore.md, apps/standalone/AGENTS.md,
  docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md                          задача 8
```

Порядок: сначала контракт (задача 1) — формы, миграция и фикстуры, которые читают все остальные; потом одна копия и папки без исполнителя (2), исполнитель и его запуск с хостом (3), маршруты офиса (4), восстановление (5), сверка после восстановления (6), страница офиса (7); документы — последней (8). Хостовые задачи не зависят от планов цеха (2a5–2a8) и от 2a2: слой удержания держит путь фактов независимо от того, есть ли его маршрут. Общие с другими потоками файлы получают только добавления: `proto/src/lib.rs`, `proto/fixtures/error-codes.json`, `host/src/{lib,audit,server,db,config,main}.rs`, `routes/mod.rs`, `tests/support/{app,mod}.rs`, `src/host/{api,protocol,errors}.ts`, `test/support/office.tsx`, `src/office/{nav.ts,routes.tsx,access.ts,office-query.ts,OfficeOverview.tsx}`, `src/i18n/ru.json`, `AGENTS.md`. Если план ИМП влит раньше, ключ `office.nav.sections.service` («Сервис») уже есть — второй раз его не добавлять.

---

### Task 1: Контракт копий — миграция `0011`, `proto::backup` и фикстуры, `restoreEpoch` в `hello`, код `restore_pending`, папка копий

Все формы, которые читают следующие задачи, появляются сразу и сверяются с одними фикстурами в Rust и Zod: состояние копий для офиса (с удержанием фактов после восстановления), настройка второй папки, возврат блоков станцией, `hello` с эпохой восстановления, отказ `restore_pending`. Миграция `0011` заводит настройку второй папки (одна строка, путь до 260 символов), эпоху и удержание в `site` и отметку станции в `devices`. `hello` читает эпоху из `site` и называет её только после первого восстановления. `HostPaths::backups_dir` — `<каталог данных>/backups`, его создаёт `ensure`.

**Files:**

- Create: `apps/standalone/host/migrations/0011_backups.sql`, `apps/standalone/proto/src/backup.rs`, `apps/standalone/src/host/backups.ts`
- Modify: `apps/standalone/proto/src/lib.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/config.rs`, `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/errors.ts`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/proto/fixtures/backup-state.json`, `apps/standalone/proto/fixtures/backup-state-running.json`, `apps/standalone/proto/fixtures/backup-settings-update.json`, `apps/standalone/proto/fixtures/known-blocks-request.json`, `apps/standalone/proto/fixtures/known-blocks-response.json`, `apps/standalone/proto/fixtures/hello-restored.json`, `apps/standalone/proto/fixtures/backup-codes.json`, `apps/standalone/proto/fixtures/backup-state-held.json`, `apps/standalone/proto/fixtures/error-restore-pending.json`, `apps/standalone/proto/fixtures/error-codes.json`, `apps/standalone/proto/tests/backup.rs`, `apps/standalone/host/tests/backup_schema.rs`, `apps/standalone/test/backups.test.ts`

**Interfaces:**

- Consumes: `site`, `devices` (этап 1); `markiro_proto::Hello`, `codes` (этап 1); Zod `helloSchema`, `errorBodySchema`, `API_ERROR_CODES` (вебвью).
- Produces: таблица `backup_settings (id = 1, second_dir, rev)`, столбцы `site.restore_epoch`, `site.facts_held_since`, `devices.known_blocks_epoch`; `markiro_proto::backup::{failure, dir_problems, known_block_codes, BackupTrigger, BackupCopy, BackupAttempt, BackupDestination, BackupRunning, RestoreHoldStation, RestoreHold, BackupState, BackupSettingsUpdate, KnownBlock, KnownBlocksRequest, KnownBlockOutcome, KnownBlockResult, KnownBlocksResponse}`; `Hello::restore_epoch: Option<String>`; `codes::RESTORE_PENDING`; `HostPaths::backups_dir() -> PathBuf`; вебвью `src/host/backups.ts`: `BACKUP_FAILURES`, `BACKUP_DIR_PROBLEMS`, `KNOWN_BLOCK_CODES`, `backupStateSchema`, `restoreHoldSchema`, `backupSettingsUpdateSchema`, `knownBlocksRequestSchema`, `knownBlocksResponseSchema` и типы `BackupState`, `BackupCopy`, `BackupDestination`, `BackupAttempt`, `BackupTrigger`, `BackupFailure`, `BackupDirProblem`, `BackupSettingsUpdate`, `RestoreHold`, `KnownBlocksRequest`, `KnownBlocksResponse`; `helloSchema.restoreEpoch`; ключ `errors.api.restore_pending`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/proto/fixtures/backup-state.json`:

<!-- prettier-ignore -->
```json
{
  "now": "2026-10-09T14:20:00Z",
  "local": {
    "dir": "C:\\ProgramData\\Markiro\\Host\\backups",
    "lastAttempt": {
      "at": "2026-10-09T14:00:03Z",
      "trigger": "scheduled",
      "ok": true,
      "code": null
    },
    "copies": [
      {
        "file": "markiro-host-20261009T140000Z-7c1e2a9b.db",
        "createdAt": "2026-10-09T14:00:00Z",
        "trigger": "scheduled",
        "sizeBytes": 4194304,
        "sha256": "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b"
      },
      {
        "file": "markiro-host-20261009T113512Z-0d4f6b21.db",
        "createdAt": "2026-10-09T11:35:12Z",
        "trigger": "manual",
        "sizeBytes": 4190208,
        "sha256": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"
      }
    ]
  },
  "second": {
    "dir": "\\\\ADMIN-PC\\MarkiroCopies",
    "lastAttempt": {
      "at": "2026-10-09T14:00:04Z",
      "trigger": "scheduled",
      "ok": false,
      "code": "destination_unavailable"
    },
    "copies": []
  },
  "settingsRev": 7,
  "running": null,
  "restoreHold": null
}
```

2. Создать `apps/standalone/proto/fixtures/backup-state-running.json`:

<!-- prettier-ignore -->
```json
{
  "now": "2026-10-09T14:20:00Z",
  "local": {
    "dir": "/var/lib/markiro/backups",
    "lastAttempt": null,
    "copies": []
  },
  "second": null,
  "settingsRev": 0,
  "running": { "trigger": "manual", "startedAt": "2026-10-09T14:19:58Z" },
  "restoreHold": null
}
```

3. Создать `apps/standalone/proto/fixtures/backup-settings-update.json`:

<!-- prettier-ignore -->
```json
{ "secondDir": "\\\\ADMIN-PC\\MarkiroCopies", "expectedRev": 7 }
```

4. Создать `apps/standalone/proto/fixtures/known-blocks-request.json`:

<!-- prettier-ignore -->
```json
{
  "blocks": [
    {
      "id": "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "issuerPrefix": "460068200",
      "extension": 0,
      "fromSerial": 3500,
      "toSerial": 5499
    }
  ]
}
```

5. Создать `apps/standalone/proto/fixtures/known-blocks-response.json`:

<!-- prettier-ignore -->
```json
{
  "results": [
    { "id": "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "outcome": "registered", "code": null },
    { "id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "outcome": "known", "code": null },
    { "id": "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", "outcome": "refused", "code": "block_overlap" }
  ]
}
```

6. Создать `apps/standalone/proto/fixtures/hello-restored.json`:

<!-- prettier-ignore -->
```json
{
  "product": "markiro-host",
  "protocol": 2,
  "minProtocol": 1,
  "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "version": "0.1.0",
  "time": "2026-10-09T15:02:00Z",
  "initialized": true,
  "restoreEpoch": "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e"
}
```

7. Создать `apps/standalone/proto/fixtures/backup-codes.json`:

<!-- prettier-ignore -->
```json
{
  "failures": [
    "destination_unavailable",
    "access_denied",
    "disk_full",
    "write_failed",
    "verify_failed",
    "local_copy_failed",
    "internal"
  ],
  "dirProblems": [
    "missing",
    "not_a_directory",
    "access_denied",
    "unwritable",
    "timeout",
    "inside_data_dir"
  ],
  "knownBlockCodes": ["block_mismatch", "block_overlap", "prefix_unknown", "range_invalid"]
}
```

8. Создать `apps/standalone/proto/fixtures/backup-state-held.json`:

<!-- prettier-ignore -->
```json
{
  "now": "2026-10-09T15:10:00Z",
  "local": {
    "dir": "C:\\ProgramData\\Markiro\\Host\\backups",
    "lastAttempt": null,
    "copies": []
  },
  "second": null,
  "settingsRev": 7,
  "running": null,
  "restoreHold": {
    "since": "2026-10-09T15:00:00Z",
    "epoch": "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
    "stations": [
      {
        "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        "name": "Станция линии 1",
        "lastSeenAt": "2026-10-09T15:06:00Z",
        "reconciled": true
      },
      {
        "id": "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
        "name": "Станция линии 2",
        "lastSeenAt": null,
        "reconciled": false
      }
    ]
  }
}
```

9. Создать `apps/standalone/proto/fixtures/error-restore-pending.json`:

<!-- prettier-ignore -->
```json
{
  "error": {
    "code": "restore_pending",
    "message": "the host was restored from a copy: facts wait until the office resumes them",
    "details": { "since": "2026-10-09T15:00:00Z" }
  }
}
```

10. В `apps/standalone/proto/fixtures/error-codes.json` фрагмент

<!-- prettier-ignore -->
```json
    "internal",
    "pairing_code_invalid",
    "pairing_code_expired",
    "sscc_exhausted"
  ]
}
```

заменить на

<!-- prettier-ignore -->
```json
    "internal",
    "pairing_code_invalid",
    "pairing_code_expired",
    "sscc_exhausted",
    "restore_pending"
  ]
}
```

11. Создать `apps/standalone/proto/tests/backup.rs`:

<!-- prettier-ignore -->
```rust
//! The backup and restore shapes (plan РК) against their fixtures, which
//! `test/backups.test.ts` parses with the Zod schemas too.

use markiro_proto::backup::{
    dir_problems, failure, known_block_codes, BackupSettingsUpdate, BackupState, BackupTrigger,
    KnownBlockOutcome, KnownBlocksRequest, KnownBlocksResponse,
};
use markiro_proto::{codes, ErrorBody, Hello};
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
fn backup_states_round_trip() {
    let state: BackupState = round_trip("backup-state.json");
    assert_eq!(state.local.copies.len(), 2);
    assert_eq!(state.local.copies[1].trigger, BackupTrigger::Manual);
    let second = state.second.expect("the fixture has a second folder");
    assert_eq!(
        second.last_attempt.unwrap().code.as_deref(),
        Some(failure::DESTINATION_UNAVAILABLE)
    );
    let running: BackupState = round_trip("backup-state-running.json");
    assert_eq!(running.second, None);
    assert_eq!(running.running.unwrap().trigger, BackupTrigger::Manual);
    assert_eq!(running.restore_hold, None);
}

#[test]
fn a_held_host_names_its_stations_and_refuses_facts_with_restore_pending() {
    let held: BackupState = round_trip("backup-state-held.json");
    let hold = held.restore_hold.expect("the fixture holds the facts");
    assert_eq!(hold.since, "2026-10-09T15:00:00Z");
    let reconciled: Vec<bool> = hold.stations.iter().map(|each| each.reconciled).collect();
    assert_eq!(reconciled, [true, false]);
    assert_eq!(hold.stations[1].last_seen_at, None);
    let refusal: ErrorBody = round_trip("error-restore-pending.json");
    assert_eq!(refusal.error.code, codes::RESTORE_PENDING);
    assert!(codes::ALL.contains(&codes::RESTORE_PENDING));
}

#[test]
fn the_settings_update_is_strict_and_clears_with_null() {
    let update: BackupSettingsUpdate = round_trip("backup-settings-update.json");
    assert_eq!(update.expected_rev, 7);
    let cleared: BackupSettingsUpdate =
        serde_json::from_value(json!({ "secondDir": null, "expectedRev": 1 })).unwrap();
    assert_eq!(cleared.second_dir, None);
    let extra = json!({ "secondDir": null, "expectedRev": 1, "localDir": "/x" });
    assert!(serde_json::from_value::<BackupSettingsUpdate>(extra).is_err());
    let missing = json!({ "expectedRev": 1 });
    assert!(serde_json::from_value::<BackupSettingsUpdate>(missing).is_err());
}

#[test]
fn known_blocks_round_trip_and_the_request_is_strict() {
    let request: KnownBlocksRequest = round_trip("known-blocks-request.json");
    assert_eq!(request.blocks[0].to_serial, 5499);
    let mut extra = fixture("known-blocks-request.json");
    extra["blocks"][0]["nextSerial"] = json!(3600);
    assert!(serde_json::from_value::<KnownBlocksRequest>(extra).is_err());
    let response: KnownBlocksResponse = round_trip("known-blocks-response.json");
    let outcomes: Vec<_> = response.results.iter().map(|each| each.outcome).collect();
    assert_eq!(
        outcomes,
        [
            KnownBlockOutcome::Registered,
            KnownBlockOutcome::Known,
            KnownBlockOutcome::Refused
        ]
    );
}

#[test]
fn hello_carries_the_restore_epoch_only_after_a_restore() {
    let restored: Hello = round_trip("hello-restored.json");
    assert_eq!(
        restored.restore_epoch.as_deref(),
        Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
    );
    let plain: Hello = round_trip("hello.json");
    assert_eq!(plain.restore_epoch, None);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("restoreEpoch")
        .is_none());
}

#[test]
fn the_code_lists_match_their_fixture() {
    let listed = fixture("backup-codes.json");
    let names = |key: &str| -> Vec<String> {
        listed[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(names("failures"), failure::ALL);
    assert_eq!(names("dirProblems"), dir_problems::ALL);
    assert_eq!(names("knownBlockCodes"), known_block_codes::ALL);
}
```

12. Создать `apps/standalone/host/tests/backup_schema.rs`:

<!-- prettier-ignore -->
```rust
//! Migration `0011` (plan РК): the second folder setting and the restore
//! epoch that `hello` reports.

mod support;

use axum::http::StatusCode;
use support::app::{empty, request, TestApp};

#[tokio::test]
async fn a_new_host_has_no_second_folder_and_no_restore_epoch() {
    let app = TestApp::new().await;
    let settings: (Option<String>, i64) =
        sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(settings, (None, 0));
    let site: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT restore_epoch, facts_held_since FROM site WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(site, (None, None));
    let (device, _) = support::app::pair_device(&app, "station").await;
    let known: Option<String> =
        sqlx::query_scalar("SELECT known_blocks_epoch FROM devices WHERE id = ?")
            .bind(&device)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(known, None);
}

#[tokio::test]
async fn the_settings_table_holds_one_row_and_a_bounded_folder() {
    let app = TestApp::new().await;
    for statement in [
        "INSERT INTO backup_settings (id) VALUES (2)",
        "UPDATE backup_settings SET second_dir = '' WHERE id = 1",
    ] {
        let error = sqlx::query(statement)
            .execute(&app.state.pool)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("CHECK"), "{statement}: {error}");
    }
    let long = "x".repeat(261);
    let error = sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind(&long)
        .execute(&app.state.pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("CHECK"), "{error}");
    sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind("x".repeat(260))
        .execute(&app.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn hello_names_the_restore_epoch_only_once_there_is_one() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("restoreEpoch").is_none(), "{body}");
    assert_eq!(body["initialized"], false);
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    sqlx::query("UPDATE site SET restore_epoch = ?, initialized_at = '2026-10-09T15:00:00Z'")
        .bind(epoch)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, body) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restoreEpoch"], epoch);
    assert_eq!(body["initialized"], true);
}

#[test]
fn the_backups_folder_is_part_of_the_data_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(dir.path());
    assert_eq!(paths.backups_dir(), dir.path().join("backups"));
    paths.ensure().unwrap();
    assert!(paths.backups_dir().is_dir());
}
```

13. Создать `apps/standalone/test/backups.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BACKUP_DIR_PROBLEMS,
  BACKUP_FAILURES,
  backupSettingsUpdateSchema,
  backupStateSchema,
  KNOWN_BLOCK_CODES,
  knownBlocksRequestSchema,
  knownBlocksResponseSchema,
} from "../src/host/backups.js";
import { errorBodySchema, helloSchema } from "../src/host/protocol.js";

// Bound first: Vite rewrites a literal `new URL(…, import.meta.url)` for the
// browser, which breaks a fixture read under jsdom (`protocol.test.ts`).
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as unknown;
}

describe("backup shapes (proto/fixtures)", () => {
  it("read the host's states, which may grow", () => {
    const state = backupStateSchema.parse(fixture("backup-state.json"));
    expect(state.second?.lastAttempt?.code).toBe("destination_unavailable");
    expect(state.local.copies.map((copy) => copy.trigger)).toEqual(["scheduled", "manual"]);
    const running = backupStateSchema.parse(fixture("backup-state-running.json"));
    expect(running.running).toEqual({ trigger: "manual", startedAt: "2026-10-09T14:19:58Z" });
    expect(running.second).toBeNull();
    const grown = { ...(fixture("backup-state.json") as Record<string, unknown>), extra: 1 };
    expect(backupStateSchema.safeParse(grown).success).toBe(true);
  });

  it("read a host that holds the facts since a restore, and its refusal of a fact", () => {
    const held = backupStateSchema.parse(fixture("backup-state-held.json"));
    expect(held.restoreHold?.stations.map((station) => station.reconciled)).toEqual([true, false]);
    expect(backupStateSchema.parse(fixture("backup-state.json")).restoreHold).toBeNull();
    const refusal = errorBodySchema.parse(fixture("error-restore-pending.json"));
    expect(refusal.error.code).toBe("restore_pending");
    expect(refusal.error.details).toEqual({ since: "2026-10-09T15:00:00Z" });
  });

  it("send the settings strictly, with a folder or null", () => {
    expect(backupSettingsUpdateSchema.parse(fixture("backup-settings-update.json"))).toEqual({
      secondDir: "\\\\ADMIN-PC\\MarkiroCopies",
      expectedRev: 7,
    });
    expect(backupSettingsUpdateSchema.safeParse({ secondDir: null, expectedRev: 1 }).success).toBe(
      true,
    );
    expect(
      backupSettingsUpdateSchema.safeParse({ secondDir: null, expectedRev: 1, extra: true })
        .success,
    ).toBe(false);
  });

  it("read the known blocks a station sends and the host's answer", () => {
    const request = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
    expect(request.blocks[0]?.toSerial).toBe(5499);
    const withNext = fixture("known-blocks-request.json") as { blocks: Record<string, unknown>[] };
    withNext.blocks[0] = { ...withNext.blocks[0], nextSerial: 3600 };
    expect(knownBlocksRequestSchema.safeParse(withNext).success).toBe(false);
    const response = knownBlocksResponseSchema.parse(fixture("known-blocks-response.json"));
    expect(response.results.map((each) => each.outcome)).toEqual([
      "registered",
      "known",
      "refused",
    ]);
  });

  it("read hello with and without the restore epoch", () => {
    expect(helloSchema.parse(fixture("hello-restored.json")).restoreEpoch).toBe(
      "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
    );
    expect(helloSchema.parse(fixture("hello.json")).restoreEpoch).toBeUndefined();
  });

  it("list exactly the host's codes (proto/fixtures/backup-codes.json)", () => {
    const codes = fixture("backup-codes.json") as Record<string, string[]>;
    expect([...BACKUP_FAILURES]).toEqual(codes.failures);
    expect([...BACKUP_DIR_PROBLEMS]).toEqual(codes.dirProblems);
    expect([...KNOWN_BLOCK_CODES]).toEqual(codes.knownBlockCodes);
  });
});
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test backup`
Expected: FAIL — `` error[E0432]: unresolved import `markiro_proto::backup` `` и `` error[E0609]: no field `restore_epoch` on type `Hello` ``

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_schema`
Expected: FAIL — `` error[E0599]: no method named `backups_dir` found for struct `HostPaths` ``

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts`
Expected: FAIL — `Failed to resolve import "../src/host/backups.js" from "test/backups.test.ts"`

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/migrations/0011_backups.sql`:

<!-- prettier-ignore -->
```sql
-- Backups and restore (plan РК). The second folder for copies is an office
-- setting (one row; NULL until an administrator names a folder). The local
-- folder is fixed (`<data dir>/backups`) and is no setting.
CREATE TABLE backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  second_dir TEXT CHECK (second_dir IS NULL OR length(second_dir) BETWEEN 1 AND 260),
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO backup_settings (id) VALUES (1);

-- A new UUID at every `markiro-host restore`, which `hello` reports as
-- `restoreEpoch`: a device that sees it change knows the host went back to
-- a copy. NULL until the first restore.
ALTER TABLE site ADD COLUMN restore_epoch TEXT;

-- Set by a restore, cleared by an administrator ("resume"): while it is set
-- the host answers the stations' facts and code checks `restore_pending`
-- instead of a receipt, since a receipt is kept for good and the copy may
-- lack the shift or the block a fact names.
ALTER TABLE site ADD COLUMN facts_held_since TEXT;

-- The restore epoch for which a station sent its blocks back
-- (`POST /v1/device/sscc/blocks/known`); the office lists the stations that
-- did not yet.
ALTER TABLE devices ADD COLUMN known_blocks_epoch TEXT;
```

2. Создать `apps/standalone/proto/src/backup.rs`:

<!-- prettier-ignore -->
```rust
//! Backups and restore (plan РК): the office's view of the host's copies
//! (`GET /v1/office/backups`), the second folder setting, and a station's
//! blocks of SSCC serials that it registers again after the host was
//! restored from a copy (`POST /v1/device/sscc/blocks/known`).

use serde::{Deserialize, Serialize};

/// Why a copy into one folder failed (`BackupAttempt::code`); the office
/// shows text by code.
pub mod failure {
    /// The folder is not there: an unplugged USB drive, a computer that is
    /// off, a share that is gone.
    pub const DESTINATION_UNAVAILABLE: &str = "destination_unavailable";
    /// The host's account may not write there.
    pub const ACCESS_DENIED: &str = "access_denied";
    pub const DISK_FULL: &str = "disk_full";
    /// Any other write failure.
    pub const WRITE_FAILED: &str = "write_failed";
    /// The copy was written but did not check out (`integrity_check`, size
    /// or SHA-256): it was deleted.
    pub const VERIFY_FAILED: &str = "verify_failed";
    /// The second folder got nothing because the local copy failed.
    pub const LOCAL_COPY_FAILED: &str = "local_copy_failed";
    /// The copy stopped on an error of the host itself.
    pub const INTERNAL: &str = "internal";

    pub const ALL: &[&str] = &[
        DESTINATION_UNAVAILABLE,
        ACCESS_DENIED,
        DISK_FULL,
        WRITE_FAILED,
        VERIFY_FAILED,
        LOCAL_COPY_FAILED,
        INTERNAL,
    ];
}

/// `details.reason` of a `conflict` on `backup_dir`: why the second folder
/// cannot be used. The host tries the folder before it saves it.
pub mod dir_problems {
    pub const MISSING: &str = "missing";
    pub const NOT_A_DIRECTORY: &str = "not_a_directory";
    pub const ACCESS_DENIED: &str = "access_denied";
    pub const UNWRITABLE: &str = "unwritable";
    /// The folder did not answer in time (a share on a computer that is off).
    pub const TIMEOUT: &str = "timeout";
    /// The folder is the host's data folder or inside it: a copy there dies
    /// with the data.
    pub const INSIDE_DATA_DIR: &str = "inside_data_dir";

    pub const ALL: &[&str] = &[
        MISSING,
        NOT_A_DIRECTORY,
        ACCESS_DENIED,
        UNWRITABLE,
        TIMEOUT,
        INSIDE_DATA_DIR,
    ];
}

/// What started a copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    /// The host's schedule: hourly while the data changes, at least daily.
    Scheduled,
    /// «Сделать копию сейчас» in the office.
    Manual,
}

/// One verified copy in a folder: the database file `file` and its manifest
/// beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCopy {
    pub file: String,
    /// UTC RFC 3339.
    pub created_at: String,
    pub trigger: BackupTrigger,
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    pub sha256: String,
}

/// The last copy the host tried to make in a folder since it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAttempt {
    pub at: String,
    pub trigger: BackupTrigger,
    pub ok: bool,
    /// One of [`failure`] when `ok` is false.
    pub code: Option<String>,
}

/// One folder of copies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDestination {
    pub dir: String,
    /// `None` until the host tried this folder after it started.
    pub last_attempt: Option<BackupAttempt>,
    /// The verified copies in the folder, newest first.
    pub copies: Vec<BackupCopy>,
}

/// A copy in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunning {
    pub trigger: BackupTrigger,
    pub started_at: String,
}

/// A station after a restore: whether it gave its blocks back yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHoldStation {
    pub id: String,
    pub name: String,
    pub last_seen_at: Option<String>,
    /// It sent its blocks (`POST /v1/device/sscc/blocks/known`) since the
    /// restore.
    pub reconciled: bool,
}

/// The host holds the stations' facts since `markiro-host restore`: it
/// answers them `restore_pending` until an administrator resumes, so no
/// fact is refused for good against a copy that lacks its shift or block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHold {
    pub since: String,
    pub epoch: String,
    /// The unrevoked stations.
    pub stations: Vec<RestoreHoldStation>,
}

/// `GET /v1/office/backups`; `POST` (a copy now), `PUT …/settings` and
/// `POST …/resume` answer it too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupState {
    /// The host's clock: how old the newest copy is.
    pub now: String,
    pub local: BackupDestination,
    /// `None` until an administrator names a second folder.
    pub second: Option<BackupDestination>,
    /// For `expectedRev` of the settings.
    pub settings_rev: i64,
    pub running: Option<BackupRunning>,
    /// `Some` from a restore until an administrator resumes the facts.
    pub restore_hold: Option<RestoreHold>,
}

/// `PUT /v1/office/backups/settings`: the second folder (an absolute path:
/// a folder on a USB drive or a share, `\\PC\Share\Markiro`), or `null` to
/// stop copying there. `secondDir` is required: a body without it must not
/// clear the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettingsUpdate {
    #[serde(deserialize_with = "Option::deserialize")]
    pub second_dir: Option<String>,
    pub expected_rev: i64,
}

/// One block a station holds, as it got it from the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownBlock {
    pub id: String,
    pub issuer_prefix: String,
    pub extension: u8,
    pub from_serial: u64,
    pub to_serial: u64,
}

/// `POST /v1/device/sscc/blocks/known`: after the host's `restoreEpoch`
/// changed, a station sends every block it holds; the host takes back those
/// a copy lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownBlocksRequest {
    pub blocks: Vec<KnownBlock>,
}

/// What became of one block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownBlockOutcome {
    /// The host had lost it and holds it again.
    Registered,
    /// The host has it already, exactly so.
    Known,
    /// The host cannot take it (`code`): the serials may never be used.
    Refused,
}

/// Codes of a refused block.
pub mod known_block_codes {
    /// The host has a block with this id, but another one.
    pub const BLOCK_MISMATCH: &str = "block_mismatch";
    /// Another block holds some of these serials.
    pub const BLOCK_OVERLAP: &str = "block_overlap";
    /// The host has no counter of this prefix and extension.
    pub const PREFIX_UNKNOWN: &str = "prefix_unknown";
    /// The serials are no range of this prefix.
    pub const RANGE_INVALID: &str = "range_invalid";

    pub const ALL: &[&str] = &[BLOCK_MISMATCH, BLOCK_OVERLAP, PREFIX_UNKNOWN, RANGE_INVALID];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownBlockResult {
    pub id: String,
    pub outcome: KnownBlockOutcome,
    /// One of [`known_block_codes`] when refused.
    pub code: Option<String>,
}

/// The answer: one result per block, in the request's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownBlocksResponse {
    pub results: Vec<KnownBlockResult>,
}
```

3. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// The SSCC counter of a prefix reached the end of its serials: no block
    /// of it can be issued any more.
    pub const SSCC_EXHAUSTED: &str = "sscc_exhausted";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
```

заменить на

<!-- prettier-ignore -->
```rust
    /// The SSCC counter of a prefix reached the end of its serials: no block
    /// of it can be issued any more.
    pub const SSCC_EXHAUSTED: &str = "sscc_exhausted";
    /// The host was restored from a copy and holds the stations' facts (and
    /// code checks) until an administrator resumes them (plan РК): a station
    /// sends them again later, as after a lost connection.
    pub const RESTORE_PENDING: &str = "restore_pending";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
```

4. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
        SSCC_EXHAUSTED,
    ];
}

```

заменить на

<!-- prettier-ignore -->
```rust
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
        SSCC_EXHAUSTED,
        RESTORE_PENDING,
    ];
}

```

5. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const PASSWORD: &str = "password";
}

pub mod pairing;

/// Serde for a field of a partial update that may be absent (keep the stored
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const PASSWORD: &str = "password";
}

pub mod backup;
pub mod pairing;

/// Serde for a field of a partial update that may be absent (keep the stored
```

6. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// Host clock, UTC RFC 3339.
    pub time: String,
    pub initialized: bool,
}

/// The part of `hello` that keeps its shape in every protocol version.
```

заменить на

<!-- prettier-ignore -->
```rust
    /// Host clock, UTC RFC 3339.
    pub time: String,
    pub initialized: bool,
    /// Set by `markiro-host restore` (plan РК), a new UUID at every restore:
    /// a device that sees it change knows the host went back to a copy and
    /// registers its SSCC blocks again (`POST /v1/device/sscc/blocks/known`).
    /// Absent until the first restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
}

/// The part of `hello` that keeps its shape in every protocol version.
```

7. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let initialized = crate::db::is_initialized(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
```

заменить на

<!-- prettier-ignore -->
```rust
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let (initialized, restore_epoch): (bool, Option<String>) =
        sqlx::query_as("SELECT initialized_at IS NOT NULL, restore_epoch FROM site WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
```

8. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: state.timestamp(),
        initialized,
    }))
}

```

заменить на

<!-- prettier-ignore -->
```rust
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: state.timestamp(),
        initialized,
        restore_epoch,
    }))
}

```

9. В `apps/standalone/host/src/config.rs` фрагмент

<!-- prettier-ignore -->
```rust
        self.data_dir.join("logs")
    }

    pub fn ensure(&self) -> Result<(), ConfigError> {
        for dir in [self.data_dir.clone(), self.tls_dir(), self.logs_dir()] {
            fs::create_dir_all(&dir).map_err(|source| ConfigError::Io {
                path: dir.clone(),
                source,
```

заменить на

<!-- prettier-ignore -->
```rust
        self.data_dir.join("logs")
    }

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
            fs::create_dir_all(&dir).map_err(|source| ConfigError::Io {
                path: dir.clone(),
                source,
```

10. Создать `apps/standalone/src/host/backups.ts`:

<!-- prettier-ignore -->
```ts
import { z } from "zod";

// Backups and restore (plan РК): mirrors `markiro_proto::backup`. The host's
// answers are lenient like the Rust response types; the request bodies are
// strict like `deny_unknown_fields`. `proto/fixtures/backup-*.json`,
// `known-blocks-*.json` and `backup-codes.json` hold the shapes both sides
// read.

/** Why a copy into a folder failed (`markiro_proto::backup::failure`). */
export const BACKUP_FAILURES = [
  "destination_unavailable",
  "access_denied",
  "disk_full",
  "write_failed",
  "verify_failed",
  "local_copy_failed",
  "internal",
] as const;
export type BackupFailure = (typeof BACKUP_FAILURES)[number];

/** `details.reason` of a `conflict` on `backup_dir` (`markiro_proto::backup::dir_problems`). */
export const BACKUP_DIR_PROBLEMS = [
  "missing",
  "not_a_directory",
  "access_denied",
  "unwritable",
  "timeout",
  "inside_data_dir",
] as const;
export type BackupDirProblem = (typeof BACKUP_DIR_PROBLEMS)[number];

/** Codes of a refused block (`markiro_proto::backup::known_block_codes`). */
export const KNOWN_BLOCK_CODES = [
  "block_mismatch",
  "block_overlap",
  "prefix_unknown",
  "range_invalid",
] as const;

export const backupTriggerSchema = z.enum(["scheduled", "manual"]);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;

/** One verified copy in a folder. */
export const backupCopySchema = z.object({
  file: z.string(),
  createdAt: z.iso.datetime(),
  trigger: backupTriggerSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type BackupCopy = z.infer<typeof backupCopySchema>;

/** The last copy the host tried to make in a folder since it started; `code` when it failed. */
export const backupAttemptSchema = z.object({
  at: z.iso.datetime(),
  trigger: backupTriggerSchema,
  ok: z.boolean(),
  code: z.string().nullable(),
});
export type BackupAttempt = z.infer<typeof backupAttemptSchema>;

/** One folder of copies, its copies newest first. */
export const backupDestinationSchema = z.object({
  dir: z.string(),
  lastAttempt: backupAttemptSchema.nullable(),
  copies: z.array(backupCopySchema),
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

/**
 * The host holds the stations' facts since a restore, until an administrator
 * resumes them; each unrevoked station says whether it gave its blocks back.
 */
export const restoreHoldSchema = z.object({
  since: z.iso.datetime(),
  epoch: z.uuid(),
  stations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      lastSeenAt: z.iso.datetime().nullable(),
      reconciled: z.boolean(),
    }),
  ),
});
export type RestoreHold = z.infer<typeof restoreHoldSchema>;

/** `GET /v1/office/backups`; `POST`, `PUT …/settings` and `POST …/resume` answer it too. */
export const backupStateSchema = z.object({
  /** The host's clock: a copy's age is measured by it, never by this PC's. */
  now: z.iso.datetime(),
  local: backupDestinationSchema,
  second: backupDestinationSchema.nullable(),
  settingsRev: z.number().int(),
  running: z.object({ trigger: backupTriggerSchema, startedAt: z.iso.datetime() }).nullable(),
  restoreHold: restoreHoldSchema.nullable(),
});
export type BackupState = z.infer<typeof backupStateSchema>;

/** `PUT /v1/office/backups/settings`: the second folder, or `null` to stop copying there. */
export const backupSettingsUpdateSchema = z
  .object({ secondDir: z.string().nullable(), expectedRev: z.number().int() })
  .strict();
export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>;

/** One block a station holds, as the host issued it. */
export const knownBlockSchema = z
  .object({
    id: z.uuid(),
    issuerPrefix: z.string(),
    extension: z.number().int().min(0).max(9),
    fromSerial: z.number().int().nonnegative(),
    toSerial: z.number().int().nonnegative(),
  })
  .strict();

/** `POST /v1/device/sscc/blocks/known`: every block the station holds, after a restore. */
export const knownBlocksRequestSchema = z.object({ blocks: z.array(knownBlockSchema) }).strict();
export type KnownBlocksRequest = z.infer<typeof knownBlocksRequestSchema>;

/** What became of each block, in the request's order. */
export const knownBlocksResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      outcome: z.enum(["registered", "known", "refused"]),
      code: z.string().nullable(),
    }),
  ),
});
export type KnownBlocksResponse = z.infer<typeof knownBlocksResponseSchema>;
```

11. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    version: z.string().min(1),
    time: z.iso.datetime(),
    initialized: z.boolean(),
  })
  .strict();
export type Hello = z.infer<typeof helloSchema>;
```

заменить на

<!-- prettier-ignore -->
```ts
    version: z.string().min(1),
    time: z.iso.datetime(),
    initialized: z.boolean(),
    /** A new UUID at every restore of the host from a copy (plan РК); absent before the first. */
    restoreEpoch: z.uuid().optional(),
  })
  .strict();
export type Hello = z.infer<typeof helloSchema>;
```

12. В `apps/standalone/src/host/errors.ts` фрагмент

<!-- prettier-ignore -->
```ts
  "pairing_code_invalid",
  "pairing_code_expired",
  "sscc_exhausted",
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);
```

заменить на

<!-- prettier-ignore -->
```ts
  "pairing_code_invalid",
  "pairing_code_expired",
  "sscc_exhausted",
  "restore_pending",
] as const;

const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);
```

13. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "internal": "На хосте произошла ошибка. Повторите попытку.",
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе.",
      "sscc_exhausted": "Номера SSCC этого префикса закончились. Нужен новый GLN организации."
    },
    "device": {
      "config_unreadable": "Настройки подключения к хосту повреждены.",
```

заменить на

<!-- prettier-ignore -->
```json
      "internal": "На хосте произошла ошибка. Повторите попытку.",
      "pairing_code_invalid": "Код подключения неверен или больше не действует. Получите новый код в офисе.",
      "pairing_code_expired": "Срок кода подключения истёк. Получите новый код в офисе.",
      "sscc_exhausted": "Номера SSCC этого префикса закончились. Нужен новый GLN организации.",
      "restore_pending": "Хост восстановлен из копии и пока не принимает данные станций. Администратор возобновит приём на странице «Резервные копии»."
    },
    "device": {
      "config_unreadable": "Настройки подключения к хосту повреждены.",
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: PASS — `tests/backup.rs` 6 passed, `tests/fixtures.rs` 40 passed (среди них `the_error_code_fixture_lists_every_code`)

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_schema`
Expected: PASS — 4 passed

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts test/protocol.test.ts test/errors.test.ts`
Expected: PASS — 3 файла

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — `hello` без эпохи. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        initialized,
        restore_epoch,
```

заменить на

<!-- prettier-ignore -->
```rust
        initialized,
        restore_epoch: restore_epoch.filter(|_| false),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_schema`
Expected: FAIL — `hello_names_the_restore_epoch_only_once_there_is_one`

М2 — путь второй папки длиннее 260 символов. В `apps/standalone/host/migrations/0011_backups.sql` фрагмент

<!-- prettier-ignore -->
```sql
BETWEEN 1 AND 260
```

заменить на

<!-- prettier-ignore -->
```sql
BETWEEN 1 AND 261
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_schema`
Expected: FAIL — `the_settings_table_holds_one_row_and_a_bounded_folder`

М3 — `secondDir` можно не прислать. В `apps/standalone/proto/src/backup.rs` фрагмент

<!-- prettier-ignore -->
```rust
    #[serde(deserialize_with = "Option::deserialize")]
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test backup`
Expected: FAIL — `the_settings_update_is_strict_and_clears_with_null`

М4 — схема Zod `hello` без эпохи. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```ts
    restoreEpoch: z.uuid().optional(),
```

удалить.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups.test.ts`
Expected: FAIL — `read hello with and without the restore epoch`

М5 — `restore_pending` нет в списке кодов. В `apps/standalone/proto/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        SSCC_EXHAUSTED,
        RESTORE_PENDING,
    ];
```

заменить на

<!-- prettier-ignore -->
```rust
        SSCC_EXHAUSTED,
    ];
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`
Expected: FAIL — `a_held_host_names_its_stations_and_refuses_facts_with_restore_pending`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --check apps/standalone/proto/fixtures/backup-state.json apps/standalone/proto/fixtures/backup-state-running.json apps/standalone/proto/fixtures/backup-settings-update.json apps/standalone/proto/fixtures/known-blocks-request.json apps/standalone/proto/fixtures/known-blocks-response.json apps/standalone/proto/fixtures/hello-restored.json apps/standalone/proto/fixtures/backup-codes.json apps/standalone/proto/fixtures/backup-state-held.json apps/standalone/proto/fixtures/error-restore-pending.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/test/backups.test.ts apps/standalone/src/host/backups.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json
git diff --check
git add apps/standalone/proto/fixtures/backup-state.json apps/standalone/proto/fixtures/backup-state-running.json apps/standalone/proto/fixtures/backup-settings-update.json apps/standalone/proto/fixtures/known-blocks-request.json apps/standalone/proto/fixtures/known-blocks-response.json apps/standalone/proto/fixtures/hello-restored.json apps/standalone/proto/fixtures/backup-codes.json apps/standalone/proto/fixtures/backup-state-held.json apps/standalone/proto/fixtures/error-restore-pending.json apps/standalone/proto/fixtures/error-codes.json apps/standalone/proto/tests/backup.rs apps/standalone/host/tests/backup_schema.rs apps/standalone/test/backups.test.ts apps/standalone/host/migrations/0011_backups.sql apps/standalone/proto/src/backup.rs apps/standalone/proto/src/lib.rs apps/standalone/host/src/server.rs apps/standalone/host/src/config.rs apps/standalone/src/host/backups.ts apps/standalone/src/host/protocol.ts apps/standalone/src/host/errors.ts apps/standalone/src/i18n/ru.json
git commit -F - <<'EOF'
feat(standalone): the backup contract — migration 0011, proto backup shapes and fixtures, hello's restore epoch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Одна проверенная копия и папки копий — `backup/{copy,folder,retention}.rs`

Копия делается `VACUUM INTO` на собственном соединении (параметры пула — `db::options`, миграции не запускаются): это читатель, писатель с открытой транзакцией его не задерживает и в копию не попадает — тест держит блокировку записи всё время копии и падает по тайм-ауту, если копия ждёт. Файл копии проверяется `integrity_check` (ответ не `ok` или ошибка чтения — `verify_failed`), хешируется потоково, переименовывается, рядом пишется манифест. Сбой классифицируется по коду SQLite (`SQLITE_FULL` — `disk_full`, `SQLITE_CANTOPEN` у отсутствующей папки — `destination_unavailable`, у существующей — `access_denied`) или по виду ошибки ввода-вывода. Список копий папки — только пары «файл + манифест» с совпадающим размером; уборка удаляет `.partial` и `.db` без манифеста; ротация — правило 24/14/12, сначала манифест, потом файл. Перенос во вторую папку сверяет SHA-256 после записи и не создаёт папку. Проба папки создаёт и удаляет пробный файл и отказывает папке внутри каталога данных (сравнение канонических путей).

**Files:**

- Create: `apps/standalone/host/src/backup/mod.rs`, `apps/standalone/host/src/backup/retention.rs`, `apps/standalone/host/src/backup/copy.rs`, `apps/standalone/host/src/backup/folder.rs`
- Modify: `apps/standalone/host/src/db.rs`, `apps/standalone/host/src/lib.rs`
- Test: `apps/standalone/host/tests/support/app.rs`, `apps/standalone/host/tests/support/mod.rs`, `apps/standalone/host/tests/support/backup.rs`, `apps/standalone/host/tests/backup_copy.rs`, `apps/standalone/host/tests/backup_retention.rs`

**Interfaces:**

- Consumes: `markiro_proto::backup::{failure, dir_problems, BackupCopy, BackupTrigger}` (задача 1); `clock::{format_timestamp, parse_timestamp}`.
- Produces: `db::options(path: &Path) -> SqliteConnectOptions`; `backup::copy::{COPY_PREFIX, MANIFEST_FORMAT, Failure { code: &'static str, detail: String }, Manifest { format, file, created_at, trigger, host_id, schema_version, size_bytes, sha256 } (+ `Manifest::copy() -> BackupCopy`), utc_stamp(OffsetDateTime) -> String, copy_name(OffsetDateTime, &str) -> String, manifest_path(&Path) -> PathBuf, partial_path(&Path) -> PathBuf, sha256_file(&Path) -> io::Result<(u64, String)>, write_synced(&Path, &[u8]) -> io::Result<()>, read_manifest(&Path) -> Result<Manifest, String>, verify_database(&Path) -> Result<i64, Failure> (async), classify_io(&io::Error) -> &'static str, classify_sqlite(&sqlx::Error, &Path) -> &'static str, make_copy(&mut SqliteConnection, &Path, OffsetDateTime, BackupTrigger, &str) -> Result<Manifest, Failure> (async)}`; `backup::folder::{list(&Path) -> io::Result<Vec<Manifest>>, clean(&Path) -> io::Result<usize>, rotate(&Path) -> io::Result<Vec<Manifest>>, replicate(&Path, &Manifest, &Path) -> Result<(), Failure>, probe(&Path, &Path) -> Result<(), &'static str>}`; `backup::retention::{HOURLY, DAILY, MONTHLY, keep(&[(String, OffsetDateTime)]) -> BTreeSet<String>}`; помощники тестов `support::backup::{worker_conn, latest_migration, at, names, fake_copy}` и `TestApp::dir()`.

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/host/tests/support/app.rs` фрагмент

<!-- prettier-ignore -->
```rust

    pub async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        self.send_from(LOOPBACK, request).await
    }
}

```

заменить на

<!-- prettier-ignore -->
```rust

    pub async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        self.send_from(LOOPBACK, request).await
    }

    /// The temporary data folder: `host.db` is in it.
    pub fn dir(&self) -> &std::path::Path {
        self._dir.path()
    }
}

```

2. В `apps/standalone/host/tests/support/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
#![allow(dead_code)]

pub mod app;

use std::sync::Arc;

```

заменить на

<!-- prettier-ignore -->
```rust
#![allow(dead_code)]

pub mod app;
pub mod backup;

use std::sync::Arc;

```

3. Создать `apps/standalone/host/tests/support/backup.rs`:

<!-- prettier-ignore -->
```rust
//! Helpers of the backup suites (plan РК).

use std::path::Path;

use markiro_host::backup::copy::{copy_name, manifest_path, sha256_file, Manifest};
use markiro_proto::backup::BackupTrigger;
use sqlx::{ConnectOptions, SqliteConnection};
use time::OffsetDateTime;

use super::app::TestApp;

/// A connection like the backup worker's: the app's database, no
/// migrations.
pub async fn worker_conn(app: &TestApp) -> SqliteConnection {
    markiro_host::db::options(&app.dir().join("host.db"))
        .connect()
        .await
        .unwrap()
}

/// The newest migration this build applies: what a copy's manifest names
/// as its `schemaVersion`.
pub fn latest_migration() -> i64 {
    markiro_host::db::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap()
}

/// A UTC instant from RFC 3339 text.
pub fn at(text: &str) -> OffsetDateTime {
    markiro_host::clock::parse_timestamp(text).unwrap()
}

/// The file names in `dir`, sorted.
pub fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// A copy that is no database, with a manifest that fits it: enough for the
/// listing, the retention rule and the second folder, which never open a
/// copy.
pub fn fake_copy(dir: &Path, created: &str, tag: &str) -> Manifest {
    let name = copy_name(at(created), tag);
    let db = dir.join(&name);
    std::fs::write(&db, format!("copy {tag}")).unwrap();
    let (size_bytes, sha256) = sha256_file(&db).unwrap();
    let manifest = Manifest {
        format: 1,
        file: name,
        created_at: created.to_owned(),
        trigger: BackupTrigger::Scheduled,
        host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".to_owned(),
        schema_version: latest_migration(),
        size_bytes,
        sha256,
    };
    std::fs::write(
        manifest_path(&db),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}
```

4. Создать `apps/standalone/host/tests/backup_copy.rs`:

<!-- prettier-ignore -->
```rust
//! One copy and its folder (plan РК): `VACUUM INTO` while a writer holds the
//! lock, the check, the manifest, a folder that is not there, the listing,
//! what a broken copy leaves, and the second folder.

mod support;

use std::path::Path;
use std::time::Duration;

use markiro_host::backup::copy::{
    classify_io, classify_sqlite, make_copy, manifest_path, read_manifest, sha256_file,
    verify_database,
};
use markiro_host::backup::folder::{clean, list, probe, replicate, rotate};
use markiro_proto::backup::{dir_problems, failure, BackupTrigger};
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use support::app::{admin, Admin};
use support::backup::{at, fake_copy, latest_migration, names, worker_conn};

const CREATED: &str = "2026-10-09T14:00:00Z";

/// The organization's name in the database at `path`, read the way a
/// restore would read a copy.
async fn org_name(path: &Path) -> String {
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .unwrap();
    sqlx::query_scalar("SELECT name FROM org_profile WHERE id = 1")
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

async fn copy_of(admin: &Admin, dir: &Path) -> markiro_host::backup::copy::Manifest {
    let mut conn = worker_conn(&admin.app).await;
    copy_with(&mut conn, dir).await.unwrap()
}

async fn copy_with(
    conn: &mut SqliteConnection,
    dir: &Path,
) -> Result<markiro_host::backup::copy::Manifest, markiro_host::backup::copy::Failure> {
    make_copy(
        conn,
        dir,
        at(CREATED),
        BackupTrigger::Scheduled,
        "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    )
    .await
}

#[tokio::test]
async fn a_copy_is_taken_while_a_writer_holds_the_lock_and_holds_no_uncommitted_change() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE org_profile SET name = 'Не закоммичено' WHERE id = 1")
        .execute(&mut *holder)
        .await
        .unwrap();
    let mut conn = worker_conn(&admin.app).await;
    // The writer keeps its lock for the whole copy: a copy that waited for it
    // would never finish, and the timeout turns that into a failure.
    let manifest =
        tokio::time::timeout(Duration::from_secs(10), copy_with(&mut conn, folder.path()))
            .await
            .expect("a copy waits for no writer")
            .unwrap();
    holder.rollback().await.unwrap();
    let db = folder.path().join(&manifest.file);
    assert_eq!(org_name(&db).await, "ООО «Атолл»");
    assert_eq!(
        names(folder.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    assert!(manifest.file.starts_with("markiro-host-20261009T140000Z-"));
    assert!(manifest.file.ends_with(".db"));
    assert_eq!(
        manifest.file.len(),
        "markiro-host-20261009T140000Z-12345678.db".len()
    );
    assert_eq!(manifest.created_at, CREATED);
    assert_eq!(manifest.trigger, BackupTrigger::Scheduled);
    assert_eq!(manifest.host_id, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f");
    assert_eq!(manifest.schema_version, latest_migration());
    assert_eq!(
        sha256_file(&db).unwrap(),
        (manifest.size_bytes, manifest.sha256.clone())
    );
    assert_eq!(read_manifest(&db).unwrap(), manifest);
}

#[tokio::test]
async fn the_manifest_is_plain_json_beside_its_copy() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let text = std::fs::read_to_string(manifest_path(&folder.path().join(&manifest.file))).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "format": 1,
            "file": manifest.file,
            "createdAt": CREATED,
            "trigger": "scheduled",
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "schemaVersion": latest_migration(),
            "sizeBytes": manifest.size_bytes,
            "sha256": manifest.sha256,
        })
    );
}

#[tokio::test]
async fn the_check_refuses_a_damaged_file_and_anything_that_is_no_database() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let db = folder.path().join(&manifest.file);
    assert_eq!(verify_database(&db).await, Ok(latest_migration()));
    let mut bytes = std::fs::read(&db).unwrap();
    for byte in &mut bytes[4096 * 3..4096 * 3 + 200] {
        *byte = 0x5a;
    }
    let damaged = folder.path().join("damaged.db");
    std::fs::write(&damaged, &bytes).unwrap();
    assert_eq!(
        verify_database(&damaged).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
    let text = folder.path().join("text.db");
    std::fs::write(&text, "not a database at all, just some text").unwrap();
    assert_eq!(
        verify_database(&text).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
    let empty = folder.path().join("empty.db");
    sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&empty)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    // A database, but no host's: nothing was ever migrated in it.
    assert_eq!(
        verify_database(&empty).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
}

#[tokio::test]
async fn the_check_refuses_an_index_that_no_longer_matches_its_table() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let db = folder.path().join(&manifest.file);
    {
        // A file SQLite still opens and reads, whose index of audit times
        // now claims to index actions: only `integrity_check` sees it.
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db)
            .connect()
            .await
            .unwrap();
        sqlx::query("PRAGMA writable_schema = ON")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE sqlite_master SET sql = 'CREATE INDEX audit_log_at ON audit_log (action)' \
             WHERE name = 'audit_log_at'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    let failed = verify_database(&db).await.unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert!(
        failed.detail.starts_with("integrity_check: "),
        "{}",
        failed.detail
    );
}

#[tokio::test]
async fn a_copy_into_a_folder_that_is_not_there_fails_and_leaves_nothing() {
    let admin = admin().await;
    let parent = tempfile::tempdir().unwrap();
    let missing = parent.path().join("unplugged");
    let mut conn = worker_conn(&admin.app).await;
    let failed = copy_with(&mut conn, &missing).await.unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
    assert!(names(parent.path()).is_empty());
    assert!(!missing.exists(), "nothing is created in its place");
}

#[cfg(unix)]
#[tokio::test]
async fn a_copy_into_a_folder_the_host_may_not_write_is_access_denied_and_leaves_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let mut conn = worker_conn(&admin.app).await;
    let failed = copy_with(&mut conn, folder.path()).await.unwrap_err();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(failed.code, failure::ACCESS_DENIED);
    assert!(names(folder.path()).is_empty());
}

#[tokio::test]
async fn the_listing_holds_only_verified_copies_newest_first() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let older = fake_copy(dir, "2026-10-09T12:00:00Z", "00000001");
    let newer = fake_copy(dir, "2026-10-09T13:00:00Z", "00000002");
    // A copy whose file is not the size its manifest says.
    let grown = fake_copy(dir, "2026-10-09T13:30:00Z", "00000003");
    std::fs::write(
        dir.join(&grown.file),
        "a longer file than the manifest says",
    )
    .unwrap();
    // A copy whose manifest names another file.
    let renamed = fake_copy(dir, "2026-10-09T13:40:00Z", "00000004");
    std::fs::rename(
        dir.join(&renamed.file),
        dir.join(renamed.file.replace("00000004", "00000005")),
    )
    .unwrap();
    std::fs::rename(
        manifest_path(&dir.join(&renamed.file)),
        manifest_path(&dir.join(renamed.file.replace("00000004", "00000005"))),
    )
    .unwrap();
    // A copy without its manifest, a half-written one, and files of others.
    std::fs::write(dir.join("markiro-host-20261009T135000Z-00000006.db"), "x").unwrap();
    std::fs::write(
        dir.join("markiro-host-20261009T135500Z-00000007.db.partial"),
        "x",
    )
    .unwrap();
    std::fs::write(dir.join("notes.txt"), "someone else's").unwrap();
    std::fs::write(dir.join("other.db"), "someone else's").unwrap();
    let files: Vec<String> = list(dir)
        .unwrap()
        .into_iter()
        .map(|copy| copy.file)
        .collect();
    assert_eq!(files, [newer.file.clone(), older.file.clone()]);
    assert_eq!(clean(dir).unwrap(), 2);
    let left = names(dir);
    assert!(!left.contains(&"markiro-host-20261009T135000Z-00000006.db".to_owned()));
    assert!(!left.contains(&"markiro-host-20261009T135500Z-00000007.db.partial".to_owned()));
    for kept in [
        "notes.txt",
        "other.db",
        &older.file,
        &newer.file,
        &grown.file,
    ] {
        assert!(left.contains(&kept.to_owned()), "{kept} stays");
    }
}

#[tokio::test]
async fn rotation_deletes_what_the_rule_does_not_keep_and_nothing_else() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    // 26 hourly copies of one day: the two oldest go.
    let copies: Vec<_> = (0..26)
        .map(|hour| {
            let created = format!("2026-10-{:02}T{:02}:00:00Z", 8 + hour / 24, hour % 24);
            fake_copy(dir, &created, &format!("{hour:08}"))
        })
        .collect();
    std::fs::write(dir.join("notes.txt"), "someone else's").unwrap();
    let staying = rotate(dir).unwrap();
    assert_eq!(staying.len(), 24);
    let staying: Vec<&str> = staying.iter().map(|copy| copy.file.as_str()).collect();
    for (index, copy) in copies.iter().enumerate() {
        let db = dir.join(&copy.file);
        let kept = index >= 2;
        assert_eq!(db.exists(), kept, "{}", copy.file);
        assert_eq!(manifest_path(&db).exists(), kept, "{}", copy.file);
        assert_eq!(staying.contains(&copy.file.as_str()), kept);
    }
    assert!(dir.join("notes.txt").exists());
}

#[tokio::test]
async fn the_second_folder_gets_the_same_bytes_and_manifest() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000a");
    replicate(source.path(), &copy, dest.path()).unwrap();
    let db = dest.path().join(&copy.file);
    assert_eq!(std::fs::read(&db).unwrap(), b"copy 0000000a");
    assert_eq!(read_manifest(&db).unwrap(), copy);
    assert_eq!(names(dest.path()).len(), 2);
}

#[tokio::test]
async fn a_second_folder_that_is_not_there_gets_nothing_and_is_not_created() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000b");
    let missing = parent.path().join("ADMIN-PC");
    let failed = replicate(source.path(), &copy, &missing).unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
    assert!(!missing.exists());
    let file = parent.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let failed = replicate(source.path(), &copy, &file).unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
}

#[tokio::test]
async fn a_copy_that_changed_on_the_way_is_refused_and_removed() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000c");
    std::fs::write(source.path().join(&copy.file), "copy 0000000X").unwrap();
    let failed = replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert!(names(dest.path()).is_empty());
}

#[tokio::test]
async fn a_folder_is_tried_before_it_is_saved() {
    let data = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    assert_eq!(probe(other.path(), data.path()), Ok(()));
    assert!(names(other.path()).is_empty(), "the probe file is removed");
    assert_eq!(
        probe(&other.path().join("missing"), data.path()),
        Err(dir_problems::MISSING)
    );
    let file = other.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(
        probe(&file, data.path()),
        Err(dir_problems::NOT_A_DIRECTORY)
    );
    let inside = data.path().join("backups-too");
    std::fs::create_dir(&inside).unwrap();
    assert_eq!(
        probe(&inside, data.path()),
        Err(dir_problems::INSIDE_DATA_DIR)
    );
    assert_eq!(
        probe(data.path(), data.path()),
        Err(dir_problems::INSIDE_DATA_DIR)
    );
}

#[cfg(unix)]
#[test]
fn a_folder_the_host_may_not_write_is_refused_as_such() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let probed = probe(folder.path(), data.path());
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probed, Err(dir_problems::ACCESS_DENIED));
}

#[test]
fn io_errors_are_sorted_by_what_a_person_can_do() {
    use std::io::{Error, ErrorKind};
    let cases = [
        (ErrorKind::NotFound, failure::DESTINATION_UNAVAILABLE),
        (ErrorKind::NotADirectory, failure::DESTINATION_UNAVAILABLE),
        (ErrorKind::PermissionDenied, failure::ACCESS_DENIED),
        (ErrorKind::ReadOnlyFilesystem, failure::ACCESS_DENIED),
        (ErrorKind::StorageFull, failure::DISK_FULL),
        (ErrorKind::QuotaExceeded, failure::DISK_FULL),
        (ErrorKind::Interrupted, failure::WRITE_FAILED),
        (ErrorKind::Other, failure::WRITE_FAILED),
    ];
    for (kind, code) in cases {
        assert_eq!(classify_io(&Error::from(kind)), code, "{kind:?}");
    }
}

#[tokio::test]
async fn sqlite_errors_are_sorted_by_what_a_person_can_do() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("small.db");
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (x BLOB)")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA max_page_count = 3")
        .execute(&mut conn)
        .await
        .unwrap();
    let full = sqlx::query("INSERT INTO t VALUES (zeroblob(100000))")
        .execute(&mut conn)
        .await
        .unwrap_err();
    assert_eq!(classify_sqlite(&full, folder.path()), failure::DISK_FULL);
    let wrong = sqlx::query("INSERT INTO nowhere VALUES (1)")
        .execute(&mut conn)
        .await
        .unwrap_err();
    assert_eq!(
        classify_sqlite(&wrong, folder.path()),
        failure::WRITE_FAILED
    );
    let mut read_only = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let refused = sqlx::query("INSERT INTO t VALUES (x'00')")
        .execute(&mut read_only)
        .await
        .unwrap_err();
    assert_eq!(
        classify_sqlite(&refused, folder.path()),
        failure::ACCESS_DENIED
    );
}
```

5. Создать `apps/standalone/host/tests/backup_retention.rs`:

<!-- prettier-ignore -->
```rust
//! Which copies a folder keeps (plan РК, design §15): 24 newest, the newest
//! of each of 14 days and of each of 12 months, in UTC.

use std::collections::BTreeSet;

use markiro_host::backup::retention::keep;
use time::OffsetDateTime;

fn copy(name: &str, created: &str) -> (String, OffsetDateTime) {
    (
        name.to_owned(),
        markiro_host::clock::parse_timestamp(created).unwrap(),
    )
}

fn kept(copies: &[(String, OffsetDateTime)]) -> Vec<String> {
    keep(copies).into_iter().collect()
}

#[test]
fn up_to_twenty_four_copies_are_all_kept() {
    let copies: Vec<_> = (0..24)
        .map(|hour| {
            copy(
                &format!("h{hour:02}"),
                &format!("2026-10-09T{hour:02}:00:00Z"),
            )
        })
        .collect();
    assert_eq!(keep(&copies).len(), 24);
    assert_eq!(keep(&[]), BTreeSet::new());
}

#[test]
fn a_copy_a_day_keeps_twenty_four_days_and_the_newest_of_each_older_month() {
    // One copy a day from 1 July to 9 October 2026 (101 days).
    let first = time::Date::from_calendar_date(2026, time::Month::July, 1).unwrap();
    let copies: Vec<_> = (0..101)
        .map(|day| {
            let date = first + time::Duration::days(day);
            copy(&format!("d{date}"), &format!("{date}T03:00:00Z"))
        })
        .collect();
    let mut expected: Vec<String> = (77..101)
        .map(|day| format!("d{}", first + time::Duration::days(day)))
        .collect();
    // 16 September (day 77) is the oldest of the 24 newest; months July,
    // August and September add their newest copies (the 31st, the 31st and
    // the 30th, which the 24 newest already hold).
    expected.push("d2026-07-31".to_owned());
    expected.push("d2026-08-31".to_owned());
    expected.sort();
    assert_eq!(kept(&copies), expected);
}

#[test]
fn many_copies_a_day_keep_the_newest_of_fourteen_days_beyond_the_newest_hours() {
    // Six copies a day, at 08:00 to 13:00, from 1 to 20 October.
    let mut copies = Vec::new();
    for day in 1..=20 {
        for hour in 8..14 {
            copies.push(copy(
                &format!("{day:02}-{hour:02}"),
                &format!("2026-10-{day:02}T{hour:02}:00:00Z"),
            ));
        }
    }
    let mut expected: Vec<String> = Vec::new();
    // The 24 newest: 17 October 08:00 … 20 October 13:00.
    for day in 17..=20 {
        for hour in 8..14 {
            expected.push(format!("{day:02}-{hour:02}"));
        }
    }
    // The newest of each of the 14 newest days: 7 … 20 October at 13:00.
    for day in 7..=16 {
        expected.push(format!("{day:02}-13"));
    }
    expected.sort();
    assert_eq!(kept(&copies), expected);
}

#[test]
fn the_order_of_the_listing_never_changes_the_choice() {
    let mut copies = vec![
        copy("b", "2026-10-09T10:00:00Z"),
        copy("a", "2026-10-09T10:00:00Z"),
        copy("c", "2026-09-30T10:00:00Z"),
    ];
    let forward = keep(&copies);
    copies.reverse();
    assert_eq!(keep(&copies), forward);
    // Of two copies of the same second the later name is the newer one.
    let mut many: Vec<_> = (0..24)
        .map(|hour| {
            copy(
                &format!("n{hour:02}"),
                &format!("2026-10-10T{hour:02}:00:00Z"),
            )
        })
        .collect();
    many.push(copy("tie-a", "2026-10-09T23:00:00Z"));
    many.push(copy("tie-b", "2026-10-09T23:00:00Z"));
    let chosen = keep(&many);
    assert!(chosen.contains("tie-b"), "the newest of 9 October");
    assert!(!chosen.contains("tie-a"));
}
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy --test backup_retention`
Expected: FAIL — `` error[E0433]: failed to resolve: could not find `backup` in `markiro_host` ``

- [ ] **Step 3: Реализация**

1. В `apps/standalone/host/src/db.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// edited: sqlx refuses to start when a checksum changes.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
```

заменить на

<!-- prettier-ignore -->
```rust
/// edited: sqlx refuses to start when a checksum changes.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// The pragmas of every connection to the master database: WAL, every
/// transaction synced, foreign keys, a 5 s busy timeout. The pool and the
/// backup worker's own connection (plan РК) use them alike.
pub fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
}

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options(path).create_if_missing(true))
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
```

2. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust

pub mod audit;
pub mod auth;
pub mod clock;
pub mod config;
pub mod db;
```

заменить на

<!-- prettier-ignore -->
```rust

pub mod audit;
pub mod auth;
pub mod backup;
pub mod clock;
pub mod config;
pub mod db;
```

3. Создать `apps/standalone/host/src/backup/mod.rs`:

<!-- prettier-ignore -->
```rust
//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay.

pub mod copy;
pub mod folder;
pub mod retention;
```

4. Создать `apps/standalone/host/src/backup/retention.rs`:

<!-- prettier-ignore -->
```rust
//! Which copies a folder keeps (design §15): the newest 24, the newest copy
//! of each of the 14 newest days and of each of the 12 newest months that
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason.

use std::collections::BTreeSet;

use time::OffsetDateTime;

pub const HOURLY: usize = 24;
pub const DAILY: usize = 14;
pub const MONTHLY: usize = 12;

/// The names to keep among `copies` (`(file, created at)`, any order).
pub fn keep(copies: &[(String, OffsetDateTime)]) -> BTreeSet<String> {
    let mut newest_first: Vec<&(String, OffsetDateTime)> = copies.iter().collect();
    // Newest first; the name breaks a tie, so the choice never depends on the
    // order a folder listed its files in.
    newest_first.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    let mut kept = BTreeSet::new();
    for (name, _) in newest_first.iter().take(HOURLY) {
        kept.insert(name.clone());
    }
    let mut days = Vec::new();
    let mut months = Vec::new();
    for (name, at) in &newest_first {
        let day = at.date();
        if days.len() < DAILY && !days.contains(&day) {
            days.push(day);
            kept.insert(name.clone());
        }
        let month = (at.year(), at.month());
        if months.len() < MONTHLY && !months.contains(&month) {
            months.push(month);
            kept.insert(name.clone());
        }
    }
    kept
}
```

5. Создать `apps/standalone/host/src/backup/copy.rs`:

<!-- prettier-ignore -->
```rust
//! One copy of the master database: `VACUUM INTO` a `.partial` file while
//! the host runs, `PRAGMA integrity_check` on that file, its size and
//! SHA-256, then the database file and its manifest under their final
//! names. A reader of the database: it waits for no writer and a writer
//! waits for it neither (WAL), and a transaction still open when the copy
//! starts is not in it.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aws_lc_rs::digest::{Context, SHA256};
use markiro_proto::backup::{failure, BackupCopy, BackupTrigger};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::OffsetDateTime;

use crate::clock::format_timestamp;

/// Every file of a copy starts with this.
pub const COPY_PREFIX: &str = "markiro-host-";
/// The manifest format this build writes and reads.
pub const MANIFEST_FORMAT: u32 = 1;

/// Why a copy failed: `code` is one of `markiro_proto::backup::failure` (the
/// office's text), `detail` is for the process log only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub detail: String,
}

impl Failure {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// The manifest beside a copy (`<name>.json` for `<name>.db`): what the
/// listing, the second folder and `markiro-host restore` check a copy by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub file: String,
    pub created_at: String,
    pub trigger: BackupTrigger,
    pub host_id: String,
    /// The newest migration applied in the copy.
    pub schema_version: i64,
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

/// `20261009T140000Z`: a UTC time in a file name.
pub fn utc_stamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// `markiro-host-20261009T140000Z-1a2b3c4d.db`: the UTC time first, so names
/// sort by time; `tag` (8 hex digits) keeps two copies of one second apart.
pub fn copy_name(at: OffsetDateTime, tag: &str) -> String {
    format!("{COPY_PREFIX}{}-{tag}.db", utc_stamp(at))
}

/// `<name>.json` beside `<name>.db`.
pub fn manifest_path(db: &Path) -> PathBuf {
    db.with_extension("json")
}

/// `<file>.partial`: where a copy is written before it checks out.
pub fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".partial");
    PathBuf::from(name)
}

/// The size and lower-case hex SHA-256 of a file. Blocking.
pub fn sha256_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        context.update(&buffer[..read]);
    }
    let digest = context.finish();
    let hex = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((size, hex))
}

/// Write `bytes` to `path` through `<path>.partial`, synced before the
/// rename, so a crash never leaves a half-written file under the final
/// name. Blocking.
pub fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = partial_path(path);
    {
        let mut file = fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&partial, path)
}

/// Read and check the manifest of `db`: format 1 and naming `db` itself.
/// Blocking.
pub fn read_manifest(db: &Path) -> Result<Manifest, String> {
    let path = manifest_path(db);
    let text = fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(format!(
            "{}: manifest format {} is not {MANIFEST_FORMAT}",
            path.display(),
            manifest.format
        ));
    }
    let name = db.file_name().and_then(|name| name.to_str());
    if name != Some(manifest.file.as_str()) {
        return Err(format!(
            "{}: the manifest names {}",
            path.display(),
            manifest.file
        ));
    }
    Ok(manifest)
}

/// Open `path` read-only and immutable (no `-wal`, `-shm` or lock beside
/// it), run `PRAGMA integrity_check` and return the newest migration
/// applied in it. Anything else than one row `ok` is `verify_failed`.
pub async fn verify_database(path: &Path) -> Result<i64, Failure> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    let checked = check(&mut conn).await;
    let _ = conn.close().await;
    checked
}

async fn check(conn: &mut SqliteConnection) -> Result<i64, Failure> {
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *conn)
        .await
        .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    if rows != ["ok"] {
        return Err(Failure::new(
            failure::VERIFY_FAILED,
            format!("integrity_check: {}", rows.join("; ")),
        ));
    }
    let version: Option<i64> =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    version.ok_or_else(|| Failure::new(failure::VERIFY_FAILED, "no migration applied"))
}

/// The failure code of an I/O error. A share that is gone, an unplugged
/// drive and a path through a file are all a folder that is not there.
pub fn classify_io(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    #[cfg(windows)]
    {
        // ERROR_BAD_NETPATH, ERROR_NETNAME_DELETED, ERROR_BAD_NET_NAME,
        // ERROR_NOT_READY (a drive letter without its USB drive),
        // ERROR_DEV_NOT_EXIST: a folder that is not there, whatever kind
        // the standard library gives them.
        if let Some(53 | 64 | 67 | 21 | 55) = error.raw_os_error() {
            return failure::DESTINATION_UNAVAILABLE;
        }
    }
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => failure::DESTINATION_UNAVAILABLE,
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => failure::ACCESS_DENIED,
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => failure::DISK_FULL,
        _ => failure::WRITE_FAILED,
    }
}

/// The failure code of `VACUUM INTO` a file in `dir`: SQLITE_FULL (13) is a
/// full disk; SQLITE_CANTOPEN (14) is a folder that is not there, or one the
/// host may not write when the folder is there (SQLite says the same for
/// both); SQLITE_PERM (3) and SQLITE_READONLY (8) a folder the host may not
/// write; anything else, a failed write.
pub fn classify_sqlite(error: &sqlx::Error, dir: &Path) -> &'static str {
    let code = error
        .as_database_error()
        .and_then(|database| database.code());
    match code.as_deref() {
        Some("13") => failure::DISK_FULL,
        Some("14") if dir.is_dir() => failure::ACCESS_DENIED,
        Some("14") => failure::DESTINATION_UNAVAILABLE,
        Some("3" | "8") => failure::ACCESS_DENIED,
        _ => failure::WRITE_FAILED,
    }
}

/// Make one verified copy of the database `conn` is open on in `dir`, named
/// for `at`: `VACUUM INTO` `<name>.partial`, check it, hash it, rename it,
/// then write the manifest. On any failure nothing of this copy stays in
/// `dir`.
pub async fn make_copy(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
) -> Result<Manifest, Failure> {
    let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    let name = copy_name(at, &tag);
    let db = dir.join(&name);
    let partial = partial_path(&db);
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
    let target = partial.to_str().ok_or_else(|| {
        Failure::new(
            failure::WRITE_FAILED,
            format!("{} is no UTF-8 path", partial.display()),
        )
    })?;
    sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(&mut *conn)
        .await
        .map_err(|error| {
            let dir = db.parent().unwrap_or(Path::new("."));
            Failure::new(classify_sqlite(&error, dir), error.to_string())
        })?;
    let schema_version = verify_database(partial).await?;
    let hashed = partial.to_path_buf();
    let (size_bytes, sha256) = tokio::task::spawn_blocking(move || sha256_file(&hashed))
        .await
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
        .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    let manifest = Manifest {
        format: MANIFEST_FORMAT,
        file: name.to_owned(),
        created_at: format_timestamp(at),
        trigger,
        host_id: host_id.to_owned(),
        schema_version,
        size_bytes,
        sha256,
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    let (partial, db) = (partial.to_path_buf(), db.to_path_buf());
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        fs::File::open(&partial)?.sync_all()?;
        fs::rename(&partial, &db)?;
        write_synced(&manifest_path(&db), &bytes)
    })
    .await
    .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
    .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    Ok(manifest)
}
```

6. Создать `apps/standalone/host/src/backup/folder.rs`:

<!-- prettier-ignore -->
```rust
//! A folder of copies: what it holds, what is left of a broken copy, which
//! copies it keeps, how a copy reaches the second folder, and whether a
//! folder can take copies at all. Only names that start with
//! [`COPY_PREFIX`] are ever touched: a folder may hold other files. All
//! blocking.

use std::fs;
use std::path::Path;

use markiro_proto::backup::{dir_problems, failure};

use super::copy::{
    classify_io, manifest_path, partial_path, read_manifest, sha256_file, write_synced, Failure,
    Manifest, COPY_PREFIX,
};
use super::retention;
use crate::clock::parse_timestamp;

fn ours(name: &str) -> bool {
    name.starts_with(COPY_PREFIX)
}

/// The verified copies in `dir`, newest first: a `<name>.db` whose
/// manifest reads and names it, with the size the manifest says. A copy
/// without them is no copy.
pub fn list(dir: &Path) -> std::io::Result<Vec<Manifest>> {
    let mut copies = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !ours(name) || !name.ends_with(".db") {
            continue;
        }
        let path = entry.path();
        let Ok(manifest) = read_manifest(&path) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() != manifest.size_bytes || parse_timestamp(&manifest.created_at).is_err() {
            continue;
        }
        copies.push(manifest);
    }
    copies.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.file.cmp(&a.file))
    });
    Ok(copies)
}

/// Remove what broken copies left in `dir`: `.partial` files and a `.db`
/// without its manifest. Returns how many files went.
pub fn clean(dir: &Path) -> std::io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !ours(name) {
            continue;
        }
        let path = entry.path();
        let broken =
            name.ends_with(".partial") || (name.ends_with(".db") && !manifest_path(&path).exists());
        if broken {
            fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Delete the copies of `dir` that [`retention::keep`] does not keep: the
/// manifest first, so a copy half deleted is a `.db` without one, which
/// [`clean`] removes. Returns the copies that stay, newest first.
pub fn rotate(dir: &Path) -> std::io::Result<Vec<Manifest>> {
    let copies = list(dir)?;
    let dated: Vec<(String, time::OffsetDateTime)> = copies
        .iter()
        .filter_map(|copy| {
            parse_timestamp(&copy.created_at)
                .ok()
                .map(|at| (copy.file.clone(), at))
        })
        .collect();
    let kept = retention::keep(&dated);
    let mut staying = Vec::new();
    for copy in copies {
        if kept.contains(&copy.file) {
            staying.push(copy);
            continue;
        }
        let db = dir.join(&copy.file);
        fs::remove_file(manifest_path(&db))?;
        fs::remove_file(&db)?;
    }
    Ok(staying)
}

/// Put the verified copy `manifest` of `source_dir` into `dest_dir`:
/// `<name>.db.partial`, synced, read back and hashed, compared with the
/// manifest, renamed, and the same manifest beside it. A folder that is not
/// there is `destination_unavailable`; nothing is created in its place.
pub fn replicate(source_dir: &Path, manifest: &Manifest, dest_dir: &Path) -> Result<(), Failure> {
    match fs::metadata(dest_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(Failure::new(
                failure::DESTINATION_UNAVAILABLE,
                format!("{} is not a folder", dest_dir.display()),
            ))
        }
        Err(error) => return Err(Failure::new(classify_io(&error), error.to_string())),
    }
    let source = source_dir.join(&manifest.file);
    let target = dest_dir.join(&manifest.file);
    let partial = partial_path(&target);
    let copied = copy_and_check(&source, &partial, &target, manifest);
    if copied.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&target);
        let _ = fs::remove_file(partial_path(&manifest_path(&target)));
    }
    copied
}

fn copy_and_check(
    source: &Path,
    partial: &Path,
    target: &Path,
    manifest: &Manifest,
) -> Result<(), Failure> {
    let io = |error: std::io::Error| Failure::new(classify_io(&error), error.to_string());
    fs::copy(source, partial).map_err(io)?;
    fs::File::open(partial)
        .and_then(|file| file.sync_all())
        .map_err(io)?;
    let (size, sha256) = sha256_file(partial).map_err(io)?;
    if size != manifest.size_bytes || sha256 != manifest.sha256 {
        return Err(Failure::new(
            failure::VERIFY_FAILED,
            format!("{} differs from its source", partial.display()),
        ));
    }
    fs::rename(partial, target).map_err(io)?;
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    write_synced(&manifest_path(target), &bytes).map_err(io)
}

/// Whether `dir` can take copies: it is there, is a folder, and the host
/// can create and remove a file in it. `data_dir` is the host's data
/// folder: a folder inside it dies with the data. `Err` is one of
/// `markiro_proto::backup::dir_problems`.
pub fn probe(dir: &Path, data_dir: &Path) -> Result<(), &'static str> {
    let metadata = match fs::metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(match classify_io(&error) {
                failure::ACCESS_DENIED => dir_problems::ACCESS_DENIED,
                _ => dir_problems::MISSING,
            })
        }
    };
    if !metadata.is_dir() {
        return Err(dir_problems::NOT_A_DIRECTORY);
    }
    if let (Ok(dir), Ok(data_dir)) = (fs::canonicalize(dir), fs::canonicalize(data_dir)) {
        if dir.starts_with(&data_dir) {
            return Err(dir_problems::INSIDE_DATA_DIR);
        }
    }
    let probe = dir.join(format!(".markiro-probe-{}", uuid::Uuid::new_v4().simple()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            fs::remove_file(&probe).map_err(|_| dir_problems::UNWRITABLE)
        }
        Err(error) => Err(match classify_io(&error) {
            failure::ACCESS_DENIED => dir_problems::ACCESS_DENIED,
            _ => dir_problems::UNWRITABLE,
        }),
    }
}
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy --test backup_retention --test backup_schema`
Expected: PASS — 15, 4 и 4 passed

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — часовых копий на одну меньше. В `apps/standalone/host/src/backup/retention.rs` фрагмент

<!-- prettier-ignore -->
```rust
.take(HOURLY)
```

заменить на

<!-- prettier-ignore -->
```rust
.take(HOURLY - 1)
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy --test backup_retention`
Expected: FAIL — `rotation_deletes_what_the_rule_does_not_keep_and_nothing_else`

М2 — при равном времени выбирается меньшее имя. В `apps/standalone/host/src/backup/retention.rs` фрагмент

<!-- prettier-ignore -->
```rust
newest_first.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
```

заменить на

<!-- prettier-ignore -->
```rust
newest_first.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_retention`
Expected: FAIL — `the_order_of_the_listing_never_changes_the_choice`

М3 — в список попадает копия любого размера. В `apps/standalone/host/src/backup/folder.rs` фрагмент

<!-- prettier-ignore -->
```rust
if metadata.len() != manifest.size_bytes || parse_timestamp
```

заменить на

<!-- prettier-ignore -->
```rust
if parse_timestamp
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `the_listing_holds_only_verified_copies_newest_first`

М4 — вторая папка без сверки SHA-256. В `apps/standalone/host/src/backup/folder.rs` фрагмент

<!-- prettier-ignore -->
```rust
if size != manifest.size_bytes || sha256 != manifest.sha256 {
```

заменить на

<!-- prettier-ignore -->
```rust
if size != manifest.size_bytes {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `a_copy_that_changed_on_the_way_is_refused_and_removed`

М5 — существующая папка без прав не `access_denied`. В `apps/standalone/host/src/backup/copy.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some("14") if dir.is_dir() => failure::ACCESS_DENIED,
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `a_copy_into_a_folder_the_host_may_not_write_is_access_denied_and_leaves_nothing`

М6 — проверка принимает любой ответ `integrity_check`. В `apps/standalone/host/src/backup/copy.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if rows != ["ok"] {
```

заменить на

<!-- prettier-ignore -->
```rust
    if rows.is_empty() {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `the_check_refuses_an_index_that_no_longer_matches_its_table`

М7 — уборка оставляет копию без манифеста. В `apps/standalone/host/src/backup/folder.rs` фрагмент

<!-- prettier-ignore -->
```rust
            name.ends_with(".partial") || (name.ends_with(".db") && !manifest_path(&path).exists());
```

заменить на

<!-- prettier-ignore -->
```rust
            name.ends_with(".partial");
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `the_listing_holds_only_verified_copies_newest_first`

М8 — проба пропускает каталог данных. В `apps/standalone/host/src/backup/folder.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if dir.starts_with(&data_dir) {
```

заменить на

<!-- prettier-ignore -->
```rust
        if dir == data_dir.join("never") {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `a_folder_is_tried_before_it_is_saved`

М9 — полный диск — просто ошибка записи. В `apps/standalone/host/src/backup/copy.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some("13") => failure::DISK_FULL,
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_copy`
Expected: FAIL — `sqlite_errors_are_sorted_by_what_a_person_can_do`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/support/app.rs apps/standalone/host/tests/support/mod.rs apps/standalone/host/tests/support/backup.rs apps/standalone/host/tests/backup_copy.rs apps/standalone/host/tests/backup_retention.rs apps/standalone/host/src/db.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/backup/mod.rs apps/standalone/host/src/backup/retention.rs apps/standalone/host/src/backup/copy.rs apps/standalone/host/src/backup/folder.rs
git commit -F - <<'EOF'
feat(standalone): one verified copy of the master database and the folders of copies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Исполнитель копий — расписание, «Сделать копию сейчас», вторая папка, состояние, журнал; запуск с хостом

Одна задача делает все копии по очереди. Раз в минуту она спрашивает, пора ли плановой копии (`scheduled_due`: база изменилась после прошлой удачной копии или копии за сегодня нет) и не занят ли час; «Сделать копию сейчас» (`Backups::request_manual`) будит её сразу и до конца копии держит `running`, так что вторая просьба и плановая копия ждут. Прогон — отдельная задача: уборка, копия, ротация, перенос во вторую папку (или `local_copy_failed`, если локальная не вышла), список копий обеих папок в состояние, строка `backup.create`. Состояние в памяти: последняя попытка и копии каждой папки; вторая папка — по пути из настройки. `crate::start` создаёт `Backups` из `HostPaths`, отдаёт его в `AppState::with_backups` и запускает задачу; `RunningHost::stop` ждёт её до 10 с.

**Files:**

- Create: `apps/standalone/host/src/backup/worker.rs`
- Modify: `apps/standalone/host/src/backup/mod.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/lib.rs`
- Test: `apps/standalone/host/tests/backup_worker.rs`, `apps/standalone/host/tests/backup_start.rs`

**Interfaces:**

- Consumes: `backup::copy::*`, `backup::folder::*` (задача 2); `audit::record`; `clock::Clock`; `db::options`; `HostPaths::backups_dir` (задача 1).
- Produces: `backup::worker::{TICK, Backups, Worker, RunReport { trigger, local: Result<Manifest, Failure>, second: Option<Result<(), Failure>> }, scheduled_due(bool, Option<OffsetDateTime>, OffsetDateTime) -> bool, spawn(Arc<Backups>, Arc<dyn Clock>, watch::Receiver<bool>) -> JoinHandle<()>}`; `Backups::{new(PathBuf, PathBuf, PathBuf, impl Into<String>) -> Arc<Self>, from_paths(&HostPaths, impl Into<String>) -> Arc<Self>, request_manual(&str, OffsetDateTime) -> bool, state(String, Option<String>, i64) -> BackupState}` и поля `data_dir`, `local_dir`, `db_path`, `host_id`; `Worker::{new(Arc<Backups>, Arc<dyn Clock>), scan(), tick() -> Option<RunReport>, run_manual() -> Option<RunReport>, close()}` (async); `AppState::backups: Option<Arc<Backups>>`, `AppState::with_backups`; `audit::actions::BACKUP_CREATE`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/backup_worker.rs`:

<!-- prettier-ignore -->
```rust
//! The backup worker (plan РК): a scheduled copy at most once an hour while
//! the data changes and at least once a day, «Сделать копию сейчас», the
//! second folder, failures in the status and the audit, and the task that
//! runs it all.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use markiro_host::backup::worker::{scheduled_due, spawn};
use markiro_host::backup::{Backups, Worker};
use markiro_proto::backup::{failure, BackupAttempt, BackupState, BackupTrigger};
use serde_json::json;
use support::app::{add_operator, admin, audit_trail, Admin, AuditRow};
use support::backup::{at, fake_copy, names};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/// The copies of `admin`'s host, kept in `local`.
fn backups_in(admin: &Admin, local: &Path) -> Arc<Backups> {
    Backups::new(
        admin.app.dir().to_path_buf(),
        local.to_path_buf(),
        admin.app.dir().join("host.db"),
        HOST_ID,
    )
}

/// A local folder in the app's data folder, as the host has it.
fn local_folder(admin: &Admin) -> PathBuf {
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    local
}

fn worker(admin: &Admin, backups: &Arc<Backups>) -> Worker {
    Worker::new(backups.clone(), admin.app.clock.clone())
}

async fn set_second_dir(admin: &Admin, dir: Option<&Path>) {
    sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind(dir.map(|dir| dir.display().to_string()))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

fn state(admin: &Admin, backups: &Backups, second: Option<&Path>) -> BackupState {
    backups.state(
        admin.app.state.timestamp(),
        second.map(|dir| dir.display().to_string()),
        0,
    )
}

fn attempt(at: &str, trigger: BackupTrigger, code: Option<&str>) -> Option<BackupAttempt> {
    Some(BackupAttempt {
        at: at.to_owned(),
        trigger,
        ok: code.is_none(),
        code: code.map(str::to_owned),
    })
}

/// The `backup.create` row the host writes for a scheduled run.
fn system_row(result: &str, details: serde_json::Value, file: Option<&str>) -> AuditRow {
    (
        "system".to_owned(),
        None,
        "backup.create".to_owned(),
        Some("backup".to_owned()),
        file.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

const T0: &str = "2026-09-21T14:13:20Z";

#[tokio::test]
async fn a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let first = worker.tick().await.expect("no copy yet: one is due");
    let first = first.local.unwrap();
    assert_eq!(first.created_at, T0);
    assert_eq!(first.trigger, BackupTrigger::Scheduled);
    assert_eq!(
        audit_trail(&admin.app, "backup.create").await,
        [system_row(
            "ok",
            json!({
                "trigger": "scheduled",
                "file": first.file,
                "sizeBytes": first.size_bytes,
                "sha256": first.sha256,
                "local": { "ok": true, "code": null },
                "second": null,
            }),
            Some(&first.file),
        )]
    );
    let after_first = state(&admin, &backups, None);
    assert_eq!(after_first.local.copies, [first.copy()]);
    assert_eq!(
        after_first.local.last_attempt,
        attempt(T0, BackupTrigger::Scheduled, None)
    );
    assert_eq!(after_first.running, None);

    // A change in the same hour waits for the next hour.
    add_operator(&admin, "1001").await;
    assert!(worker.tick().await.is_none(), "one scheduled copy an hour");
    admin.app.clock.advance(time::Duration::hours(1));
    let second = worker
        .tick()
        .await
        .expect("the data changed")
        .local
        .unwrap();
    assert_eq!(second.created_at, "2026-09-21T15:13:20Z");

    // Nothing changed since, not even by the copy's own audit row.
    admin.app.clock.advance(time::Duration::hours(1));
    assert!(worker.tick().await.is_none(), "an idle hour makes no copy");
    admin.app.clock.advance(time::Duration::hours(7));
    assert!(worker.tick().await.is_none(), "still 21 September");

    // A new day gets its copy even when nothing changed.
    admin.app.clock.advance(time::Duration::hours(1));
    let daily = worker.tick().await.expect("no copy of 22 September yet");
    assert_eq!(daily.local.unwrap().created_at, "2026-09-22T00:13:20Z");
    assert_eq!(state(&admin, &backups, None).local.copies.len(), 3);
    assert_eq!(names(&local).len(), 6);
}

#[tokio::test]
async fn a_failed_copy_is_in_the_status_and_the_audit_and_the_next_hour_tries_again() {
    let admin = admin().await;
    let local = admin.app.dir().join("backups");
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let failed = worker.tick().await.unwrap();
    assert_eq!(
        failed.local.unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    assert_eq!(failed.second, None);
    let status = state(&admin, &backups, None);
    assert_eq!(
        status.local.last_attempt,
        attempt(
            T0,
            BackupTrigger::Scheduled,
            Some(failure::DESTINATION_UNAVAILABLE)
        )
    );
    assert!(status.local.copies.is_empty());
    assert_eq!(
        audit_trail(&admin.app, "backup.create").await,
        [system_row(
            "failed",
            json!({
                "trigger": "scheduled",
                "file": null,
                "sizeBytes": null,
                "sha256": null,
                "local": { "ok": false, "code": "destination_unavailable" },
                "second": null,
            }),
            None,
        )]
    );

    std::fs::create_dir_all(&local).unwrap();
    assert!(
        worker.tick().await.is_none(),
        "the failed hour is not retried"
    );
    admin.app.clock.advance(time::Duration::hours(1));
    let retried = worker.tick().await.expect("a failed copy is due again");
    assert!(retried.local.is_ok());
    assert_eq!(
        state(&admin, &backups, None).local.last_attempt,
        attempt("2026-09-21T15:13:20Z", BackupTrigger::Scheduled, None)
    );
}

#[tokio::test]
async fn the_second_folder_gets_every_copy_and_its_failure_is_its_own() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let report = worker.tick().await.unwrap();
    let made = report.local.unwrap();
    assert_eq!(report.second, Some(Ok(())));
    assert_eq!(
        names(&second),
        [made.file.clone(), made.file.replace(".db", ".json")]
    );
    let status = state(&admin, &backups, Some(&second));
    let second_status = status.second.unwrap();
    assert_eq!(second_status.dir, second.display().to_string());
    assert_eq!(second_status.copies, [made.copy()]);
    assert_eq!(
        second_status.last_attempt,
        attempt(T0, BackupTrigger::Scheduled, None)
    );

    // The share goes away: the local copy is still made.
    std::fs::rename(&second, second_parent.path().join("gone")).unwrap();
    add_operator(&admin, "1001").await;
    admin.app.clock.advance(time::Duration::hours(1));
    let report = worker.tick().await.unwrap();
    let kept = report.local.unwrap();
    assert_eq!(
        report.second.unwrap().unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    let status = state(&admin, &backups, Some(&second));
    assert_eq!(
        status.local.last_attempt,
        attempt("2026-09-21T15:13:20Z", BackupTrigger::Scheduled, None)
    );
    let second_status = status.second.unwrap();
    assert_eq!(
        second_status.last_attempt,
        attempt(
            "2026-09-21T15:13:20Z",
            BackupTrigger::Scheduled,
            Some(failure::DESTINATION_UNAVAILABLE)
        )
    );
    assert_eq!(
        second_status.copies,
        [made.copy()],
        "the last copy known there"
    );
    let rows = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(
        rows.last().unwrap(),
        &system_row(
            "failed",
            json!({
                "trigger": "scheduled",
                "file": kept.file,
                "sizeBytes": kept.size_bytes,
                "sha256": kept.sha256,
                "local": { "ok": true, "code": null },
                "second": { "ok": false, "code": "destination_unavailable" },
            }),
            Some(&kept.file),
        )
    );
    assert!(!second.exists(), "the host never creates the second folder");
}

#[tokio::test]
async fn a_failed_local_copy_gives_the_second_folder_nothing() {
    let admin = admin().await;
    let second = tempfile::tempdir().unwrap();
    set_second_dir(&admin, Some(second.path())).await;
    let backups = backups_in(&admin, &admin.app.dir().join("backups"));
    let mut worker = worker(&admin, &backups);
    let report = worker.tick().await.unwrap();
    assert_eq!(
        report.local.unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    assert_eq!(
        report.second.unwrap().unwrap_err().code,
        failure::LOCAL_COPY_FAILED
    );
    assert!(names(second.path()).is_empty());
    assert_eq!(
        state(&admin, &backups, Some(second.path()))
            .second
            .unwrap()
            .last_attempt,
        attempt(
            T0,
            BackupTrigger::Scheduled,
            Some(failure::LOCAL_COPY_FAILED)
        )
    );
}

#[tokio::test]
async fn a_manual_copy_names_its_office_user_and_holds_off_other_copies_while_it_waits() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    assert!(worker.run_manual().await.is_none(), "nobody asked");

    assert!(backups.request_manual(&admin.id, at(T0)));
    assert!(!backups.request_manual(&admin.id, at(T0)), "one at a time");
    let waiting = state(&admin, &backups, None);
    let running = waiting.running.unwrap();
    assert_eq!(running.trigger, BackupTrigger::Manual);
    assert_eq!(running.started_at, T0);
    assert!(worker.tick().await.is_none(), "the manual copy goes first");

    let made = worker.run_manual().await.unwrap().local.unwrap();
    assert_eq!(made.trigger, BackupTrigger::Manual);
    let rows = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(
        rows,
        [(
            "office_user".to_owned(),
            Some(admin.id.clone()),
            "backup.create".to_owned(),
            Some("backup".to_owned()),
            Some(made.file.clone()),
            "ok".to_owned(),
            json!({
                "trigger": "manual",
                "file": made.file,
                "sizeBytes": made.size_bytes,
                "sha256": made.sha256,
                "local": { "ok": true, "code": null },
                "second": null,
            }),
        )]
    );
    let done = state(&admin, &backups, None);
    assert_eq!(done.running, None);
    assert_eq!(
        done.local.last_attempt,
        attempt(T0, BackupTrigger::Manual, None)
    );
    assert!(worker.tick().await.is_none(), "the manual copy is today's");
    assert!(backups.request_manual(&admin.id, at(T0)), "asked again");
}

#[tokio::test]
async fn the_folders_are_read_at_start_and_a_new_second_folder_starts_empty() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second = tempfile::tempdir().unwrap();
    let old_local = fake_copy(&local, "2026-09-20T10:00:00Z", "0000000a");
    let old_second = fake_copy(second.path(), "2026-09-20T10:00:00Z", "0000000b");
    set_second_dir(&admin, Some(second.path())).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    worker.scan().await;
    let status = state(&admin, &backups, Some(second.path()));
    assert_eq!(status.local.copies, [old_local.copy()]);
    assert_eq!(status.local.last_attempt, None);
    let second_status = status.second.unwrap();
    assert_eq!(second_status.copies, [old_second.copy()]);
    assert_eq!(second_status.last_attempt, None);
    let other = tempfile::tempdir().unwrap();
    let elsewhere = state(&admin, &backups, Some(other.path())).second.unwrap();
    assert_eq!(elsewhere.dir, other.path().display().to_string());
    assert!(elsewhere.copies.is_empty());
    assert_eq!(state(&admin, &backups, None).second, None);
}

#[test]
fn a_copy_is_due_when_the_data_changed_or_today_has_none() {
    let now = at("2026-10-09T14:05:00Z");
    assert!(scheduled_due(true, Some(at("2026-10-09T13:00:00Z")), now));
    assert!(!scheduled_due(false, Some(at("2026-10-09T00:00:00Z")), now));
    assert!(scheduled_due(false, Some(at("2026-10-08T23:59:59Z")), now));
    assert!(scheduled_due(false, None, now));
}

/// Wait until `done` holds of the status, failing after 10 s rather than
/// hanging.
async fn wait_for(admin: &Admin, backups: &Backups, done: impl Fn(&BackupState) -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done(&state(admin, backups, None)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the worker task answered in time");
}

#[tokio::test]
async fn the_worker_task_copies_at_start_and_at_once_when_asked_then_stops() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let stopping = tokio::sync::watch::channel(false).0;
    let task = spawn(
        backups.clone(),
        admin.app.clock.clone(),
        stopping.subscribe(),
    );
    wait_for(&admin, &backups, |state| state.local.last_attempt.is_some()).await;
    assert!(backups.request_manual(&admin.id, at(T0)));
    wait_for(&admin, &backups, |state| {
        state.running.is_none() && state.local.copies.len() == 2
    })
    .await;
    let rows = audit_trail(&admin.app, "backup.create").await;
    let actors: Vec<_> = rows.iter().map(|row| row.0.as_str()).collect();
    assert_eq!(actors, ["system", "office_user"]);
    stopping.send_replace(true);
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("the worker stops")
        .unwrap();
}
```

2. Создать `apps/standalone/host/tests/backup_start.rs`:

<!-- prettier-ignore -->
```rust
//! The host starts its backup worker with itself (plan РК): a copy right
//! after the start, and the worker stops with the host. Listens on
//! 127.0.0.1, so it runs outside the sandbox.

use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};

fn manifests(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            let name = name.to_string_lossy();
            name.starts_with("markiro-host-") && name.ends_with(".json")
        })
        .count()
}

#[tokio::test]
async fn a_started_host_copies_its_database_and_stops_its_worker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&paths, options).await.unwrap();
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the worker made a copy at start");
    tokio::time::timeout(Duration::from_secs(15), host.stop())
        .await
        .expect("the host stops with its worker")
        .unwrap();
    assert_eq!(manifests(&backups), 1);
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT actor_kind, result FROM audit_log WHERE action = 'backup.create'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, [("system".to_owned(), "ok".to_owned())]);
    pool.close().await;
}
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `` error[E0432]: unresolved import `markiro_host::backup::worker` `` и `` unresolved imports `markiro_host::backup::Backups`, `markiro_host::backup::Worker` ``

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start  # вне песочницы`
Expected: FAIL — `a_started_host_copies_its_database_and_stops_its_worker`: `the worker made a copy at start: Elapsed(())` (через 10 с)

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/backup/worker.rs`:

<!-- prettier-ignore -->
```rust
//! The host's copies on a schedule and on request (plan РК). One worker
//! task makes every copy, one at a time, on a connection of its own:
//!
//! - every minute it asks whether a scheduled copy is due: at most one an
//!   hour (UTC), made in the first minute of the hour in which the
//!   database changed since the last good copy (`PRAGMA data_version` of
//!   the worker's connection, which only other connections move, so the
//!   worker's own audit row does not count), or in which there is no copy
//!   of today (UTC) yet, changed or not;
//! - «Сделать копию сейчас» ([`Backups::request_manual`]) wakes it at once.
//!
//! A run makes the local copy (`copy::make_copy`), keeps the local folder
//! to the retention rule, copies the new copy into the second folder when
//! one is set, writes one `backup.create` audit row and puts the outcome
//! of each folder into the status the office reads. A failure is in that
//! status and in the audit row, never only in the process log; the next
//! hour tries again. A run is a task of its own: a panic in it is the
//! run's `internal` failure, and the worker goes on.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::backup::{
    failure, BackupAttempt, BackupCopy, BackupDestination, BackupRunning, BackupState,
    BackupTrigger,
};
use serde_json::json;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::OffsetDateTime;
use tokio::sync::{watch, Notify};
use tokio::task::JoinHandle;

use super::copy::{make_copy, Failure, Manifest};
use super::folder;
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::{format_timestamp, parse_timestamp, Clock};
use crate::config::HostPaths;

/// How often the worker asks whether a scheduled copy is due.
pub const TICK: Duration = Duration::from_secs(60);
/// The office lists at most this many copies of a folder.
const LISTED: usize = 50;

#[derive(Debug, Clone)]
struct FolderStatus {
    dir: String,
    last_attempt: Option<BackupAttempt>,
    copies: Vec<BackupCopy>,
}

impl FolderStatus {
    fn new(dir: String) -> Self {
        Self {
            dir,
            last_attempt: None,
            copies: Vec::new(),
        }
    }

    fn destination(&self) -> BackupDestination {
        BackupDestination {
            dir: self.dir.clone(),
            last_attempt: self.last_attempt.clone(),
            copies: self.copies.clone(),
        }
    }
}

#[derive(Debug)]
struct Status {
    running: Option<BackupRunning>,
    /// The office user whose «Сделать копию сейчас» waits for the worker;
    /// `running` is set with it, so `running` alone says whether a copy runs
    /// or waits.
    pending_manual: Option<String>,
    local: FolderStatus,
    /// Keyed by the folder as the settings name it.
    second: Option<FolderStatus>,
}

/// The copies' shared state: what the office reads and how it asks for a
/// copy. The worker task ([`spawn`]) makes the copies.
pub struct Backups {
    pub data_dir: PathBuf,
    pub local_dir: PathBuf,
    pub db_path: PathBuf,
    pub host_id: String,
    status: Mutex<Status>,
    wake: Notify,
}

fn listed(copies: &[Manifest]) -> Vec<BackupCopy> {
    copies.iter().take(LISTED).map(Manifest::copy).collect()
}

impl Backups {
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
            status: Mutex::new(Status {
                running: None,
                pending_manual: None,
                local,
                second: None,
            }),
            wake: Notify::new(),
        })
    }

    /// The host's own folders: `<data dir>/backups` and `<data dir>/host.db`.
    pub fn from_paths(paths: &HostPaths, host_id: impl Into<String>) -> Arc<Self> {
        Self::new(
            paths.data_dir.clone(),
            paths.backups_dir(),
            paths.database_file(),
            host_id,
        )
    }

    fn status(&self) -> std::sync::MutexGuard<'_, Status> {
        // A panic while the lock was held leaves plain data behind; the
        // status stays readable.
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// «Сделать копию сейчас» of the office user `user_id`: `false` while a
    /// copy runs or waits already (nothing changes then).
    pub fn request_manual(&self, user_id: &str, at: OffsetDateTime) -> bool {
        let mut status = self.status();
        if status.running.is_some() {
            return false;
        }
        status.running = Some(BackupRunning {
            trigger: BackupTrigger::Manual,
            started_at: format_timestamp(at),
        });
        status.pending_manual = Some(user_id.to_owned());
        drop(status);
        self.wake.notify_one();
        true
    }

    /// What `GET /v1/office/backups` answers. `second_dir` and `settings_rev`
    /// come from the settings row: a folder the worker has not tried since it
    /// was set shows no attempt and no copies yet.
    pub fn state(&self, now: String, second_dir: Option<String>, settings_rev: i64) -> BackupState {
        let status = self.status();
        let second = second_dir.map(|dir| match &status.second {
            Some(known) if known.dir == dir => known.destination(),
            _ => FolderStatus::new(dir).destination(),
        });
        BackupState {
            now,
            local: status.local.destination(),
            second,
            settings_rev,
            running: status.running.clone(),
            // The hold lives in the database; the office's routes read it.
            restore_hold: None,
        }
    }

    /// The newest verified local copy's time.
    fn newest_local(&self) -> Option<OffsetDateTime> {
        let status = self.status();
        status
            .local
            .copies
            .first()
            .and_then(|copy| parse_timestamp(&copy.created_at).ok())
    }

    /// Mark a scheduled copy as running: `false` if another runs or waits.
    fn begin_scheduled(&self, at: OffsetDateTime) -> bool {
        let mut status = self.status();
        if status.running.is_some() {
            return false;
        }
        status.running = Some(BackupRunning {
            trigger: BackupTrigger::Scheduled,
            started_at: format_timestamp(at),
        });
        true
    }

    fn take_manual(&self) -> Option<String> {
        self.status().pending_manual.take()
    }
}

/// Whether a scheduled copy is due at `now`: the data changed since the last
/// good copy, or the newest copy is not of today (UTC). The hour slot is the
/// caller's.
pub fn scheduled_due(changed: bool, newest: Option<OffsetDateTime>, now: OffsetDateTime) -> bool {
    changed || newest.is_none_or(|at| at.date() != now.date())
}

/// What one run did.
#[derive(Debug, Clone)]
pub struct RunReport {
    pub trigger: BackupTrigger,
    pub local: Result<Manifest, Failure>,
    /// `None` without a second folder.
    pub second: Option<Result<(), Failure>>,
}

/// The worker's connection: the master database without migrations (the
/// pool ran them), with the pool's pragmas.
async fn connect(db_path: &Path) -> Result<SqliteConnection, sqlx::Error> {
    crate::db::options(db_path)
        .create_if_missing(false)
        .connect()
        .await
}

async fn data_version(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("PRAGMA data_version")
        .fetch_one(conn)
        .await
}

/// Makes the copies; see the module documentation.
pub struct Worker {
    backups: Arc<Backups>,
    clock: Arc<dyn Clock>,
    conn: Option<SqliteConnection>,
    /// `PRAGMA data_version` read before the last good local copy.
    copied_version: Option<i64>,
    /// The UTC hour (`unix time / 3600`) of the last scheduled run.
    last_hour: Option<i64>,
}

impl Worker {
    pub fn new(backups: Arc<Backups>, clock: Arc<dyn Clock>) -> Self {
        Self {
            backups,
            clock,
            conn: None,
            copied_version: None,
            last_hour: None,
        }
    }

    async fn conn(&mut self) -> Result<&mut SqliteConnection, sqlx::Error> {
        if self.conn.is_none() {
            self.conn = Some(connect(&self.backups.db_path).await?);
        }
        Ok(self.conn.as_mut().expect("just opened"))
    }

    async fn second_dir(&mut self) -> Result<Option<String>, sqlx::Error> {
        let conn = self.conn().await?;
        sqlx::query_scalar("SELECT second_dir FROM backup_settings WHERE id = 1")
            .fetch_one(conn)
            .await
    }

    /// Read both folders into the status (at start, before any copy). A
    /// folder that cannot be read lists nothing.
    pub async fn scan(&mut self) {
        let second_dir = match self.second_dir().await {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!(%error, "reading the backup settings failed");
                None
            }
        };
        let local_dir = self.backups.local_dir.clone();
        let second = second_dir.clone();
        let listed = tokio::task::spawn_blocking(move || {
            let local = folder::list(&local_dir).map(|copies| listed(&copies));
            let second =
                second.map(|dir| folder::list(Path::new(&dir)).map(|copies| listed(&copies)));
            (local, second)
        })
        .await;
        let Ok((local, second)) = listed else { return };
        let mut status = self.backups.status();
        status.local.copies = local.unwrap_or_default();
        status.second = second_dir.map(|dir| FolderStatus {
            dir,
            last_attempt: None,
            copies: second.and_then(Result::ok).unwrap_or_default(),
        });
    }

    /// A scheduled copy if one is due ([`scheduled_due`]) and nothing else
    /// runs; `None` otherwise.
    pub async fn tick(&mut self) -> Option<RunReport> {
        let now = self.clock.now();
        let hour = now.unix_timestamp().div_euclid(3600);
        if self.last_hour == Some(hour) {
            return None;
        }
        let version = match self.conn().await {
            Ok(conn) => data_version(conn).await.ok(),
            Err(_) => None,
        };
        let changed = version.is_none() || version != self.copied_version;
        if !scheduled_due(changed, self.backups.newest_local(), now) {
            return None;
        }
        if !self.backups.begin_scheduled(now) {
            return None;
        }
        self.last_hour = Some(hour);
        Some(self.run(BackupTrigger::Scheduled, None, now).await)
    }

    /// The copy an office user asked for, if one waits.
    pub async fn run_manual(&mut self) -> Option<RunReport> {
        let user = self.backups.take_manual()?;
        let now = self.clock.now();
        Some(self.run(BackupTrigger::Manual, Some(user), now).await)
    }

    async fn run(
        &mut self,
        trigger: BackupTrigger,
        user: Option<String>,
        at: OffsetDateTime,
    ) -> RunReport {
        let conn = self.conn.take();
        let backups = self.backups.clone();
        let task = tokio::spawn(run_once(backups, conn, trigger, at));
        let (conn, version, report) = match task.await {
            Ok(done) => done,
            Err(error) => {
                tracing::error!(panicked = error.is_panic(), "a backup run did not finish");
                let failed = Failure::new(failure::INTERNAL, "the run did not finish");
                (None, None, failed_report(trigger, failed))
            }
        };
        self.conn = conn;
        if report.local.is_ok() {
            self.copied_version = version;
        }
        self.record(&report, user.as_deref(), at).await;
        self.finish(&report, at);
        report
    }

    fn finish(&self, report: &RunReport, at: OffsetDateTime) {
        let attempt = |result: Result<(), &Failure>| BackupAttempt {
            at: format_timestamp(at),
            trigger: report.trigger,
            ok: result.is_ok(),
            code: result.err().map(|failure| failure.code.to_owned()),
        };
        let mut status = self.backups.status();
        status.running = None;
        status.local.last_attempt = Some(attempt(report.local.as_ref().map(|_| ())));
        if let (Some(second), Some(result)) = (status.second.as_mut(), report.second.as_ref()) {
            second.last_attempt = Some(attempt(result.as_ref().map(|_| ())));
        }
    }

    /// One `backup.create` row: the scheduled copy's actor is the host, a
    /// manual one's the office user who asked. Only the outcome of each
    /// folder, never a detail of an error.
    async fn record(&mut self, report: &RunReport, user: Option<&str>, at: OffsetDateTime) {
        let outcome = |result: Result<(), &Failure>| match result {
            Ok(()) => json!({ "ok": true, "code": null }),
            Err(failure) => json!({ "ok": false, "code": failure.code }),
        };
        let manifest = report.local.as_ref().ok();
        let file = manifest.map(|manifest| manifest.file.clone());
        let ok = report.local.is_ok() && report.second.as_ref().is_none_or(Result::is_ok);
        let details = json!({
            "trigger": report.trigger,
            "file": file,
            "sizeBytes": manifest.map(|manifest| manifest.size_bytes),
            "sha256": manifest.map(|manifest| manifest.sha256.clone()),
            "local": outcome(report.local.as_ref().map(|_| ())),
            "second": report.second.as_ref().map(|result| outcome(result.as_ref().map(|_| ()))),
        });
        let entry = Entry {
            actor: user.map_or(Actor::System, Actor::OfficeUser),
            action: actions::BACKUP_CREATE,
            target_type: Some("backup"),
            target_id: file.as_deref(),
            outcome: if ok { Outcome::Ok } else { Outcome::Failed },
            details,
        };
        let written = match self.conn().await {
            Ok(conn) => audit::record(conn, &format_timestamp(at), entry).await,
            Err(error) => Err(error),
        };
        if let Err(error) = written {
            tracing::error!(%error, "the backup audit row was not written");
        }
    }

    /// Close the worker's connection.
    pub async fn close(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.close().await;
        }
    }
}

fn failed_report(trigger: BackupTrigger, failed: Failure) -> RunReport {
    RunReport {
        trigger,
        local: Err(failed),
        second: None,
    }
}

/// One run on `conn` (opened here when `None`); returns the connection for
/// the next run, the data version read before the copy, and the report.
async fn run_once(
    backups: Arc<Backups>,
    conn: Option<SqliteConnection>,
    trigger: BackupTrigger,
    at: OffsetDateTime,
) -> (Option<SqliteConnection>, Option<i64>, RunReport) {
    let mut conn = match conn {
        Some(conn) => conn,
        None => match connect(&backups.db_path).await {
            Ok(conn) => conn,
            Err(error) => {
                let failed = Failure::new(failure::INTERNAL, error.to_string());
                return (None, None, failed_report(trigger, failed));
            }
        },
    };
    let version = data_version(&mut conn).await.ok();
    let second_dir: Option<String> =
        match sqlx::query_scalar("SELECT second_dir FROM backup_settings WHERE id = 1")
            .fetch_one(&mut conn)
            .await
        {
            Ok(dir) => dir,
            Err(error) => {
                let failed = Failure::new(failure::INTERNAL, error.to_string());
                return (Some(conn), None, failed_report(trigger, failed));
            }
        };
    let local_dir = backups.local_dir.clone();
    let cleaned = tokio::task::spawn_blocking(move || folder::clean(&local_dir)).await;
    if let Ok(Err(error)) = cleaned {
        tracing::warn!(%error, "cleaning the local backup folder failed");
    }
    let local = make_copy(&mut conn, &backups.local_dir, at, trigger, &backups.host_id).await;
    match &local {
        Ok(manifest) => tracing::info!(
            file = %manifest.file,
            size = manifest.size_bytes,
            "backup copy made"
        ),
        Err(failed) => tracing::warn!(
            code = failed.code,
            detail = %failed.detail,
            "backup copy failed"
        ),
    }
    let local_dir = backups.local_dir.clone();
    let made = local.clone().ok();
    let second = second_dir.clone();
    let folders = tokio::task::spawn_blocking(move || {
        let local_copies = folder::rotate(&local_dir).map(|copies| listed(&copies));
        let second = second.map(|dir| {
            let dir = PathBuf::from(dir);
            let result = match &made {
                Some(manifest) => folder::clean(&dir)
                    .map_err(|error| {
                        Failure::new(super::copy::classify_io(&error), error.to_string())
                    })
                    .and_then(|_| folder::replicate(&local_dir, manifest, &dir)),
                None => Err(Failure::new(
                    failure::LOCAL_COPY_FAILED,
                    "the local copy failed",
                )),
            };
            let copies = if result.is_ok() {
                folder::rotate(&dir)
            } else {
                folder::list(&dir)
            };
            (result, copies.map(|copies| listed(&copies)))
        });
        (local_copies, second)
    })
    .await;
    let (local_copies, second_result) = match folders {
        Ok(folders) => folders,
        Err(error) => {
            tracing::error!(
                panicked = error.is_panic(),
                "a backup folder task did not finish"
            );
            let failed = Failure::new(failure::INTERNAL, "the folder task did not finish");
            (
                Ok(Vec::new()),
                second_dir.as_ref().map(|_| (Err(failed), Ok(Vec::new()))),
            )
        }
    };
    if let Some((Err(failed), _)) = &second_result {
        tracing::warn!(
            code = failed.code,
            detail = %failed.detail,
            "backup copy into the second folder failed"
        );
    }
    {
        let mut status = backups.status();
        match local_copies {
            Ok(copies) => status.local.copies = copies,
            Err(error) => tracing::warn!(%error, "listing the local backup folder failed"),
        }
        match (&second_dir, &second_result) {
            (Some(dir), Some((_, copies))) => {
                let entry = match status.second.take() {
                    Some(known) if &known.dir == dir => known,
                    _ => FolderStatus::new(dir.clone()),
                };
                let mut entry = entry;
                if let Ok(copies) = copies {
                    entry.copies = copies.clone();
                }
                status.second = Some(entry);
            }
            _ => status.second = None,
        }
    }
    let report = RunReport {
        trigger,
        local,
        second: second_result.map(|(result, _)| result),
    };
    (Some(conn), version, report)
}

/// The worker task: a run at once when asked, a scheduled check every
/// [`TICK`], until `stopping` turns `true`.
pub fn spawn(
    backups: Arc<Backups>,
    clock: Arc<dyn Clock>,
    mut stopping: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut worker = Worker::new(backups.clone(), clock);
        worker.scan().await;
        let mut ticks = tokio::time::interval(TICK);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                // The `Ref` the wait answers is not `Send`: drop it inside.
                () = async {
                    let _ = stopping.wait_for(|stopping| *stopping).await;
                } => break,
                () = backups.wake.notified() => {
                    worker.run_manual().await;
                }
                _ = ticks.tick() => {
                    worker.tick().await;
                }
            }
        }
        worker.close().await;
    })
}
```

2. В `apps/standalone/host/src/backup/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay.

pub mod copy;
pub mod folder;
pub mod retention;
```

заменить на

<!-- prettier-ignore -->
```rust
//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay, `worker` makes them
//! on a schedule and on request. `crate::restore` puts one back.

pub mod copy;
pub mod folder;
pub mod retention;
pub mod worker;

pub use worker::{Backups, Worker};
```

3. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
}

/// `details.reason` of a denied row: every denial names one.
```

4. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// How often a change stream writes a comment to keep the connection
    /// alive (15 s; tests shorten it).
    pub stream_heartbeat: Duration,
}

impl AppState {
```

заменить на

<!-- prettier-ignore -->
```rust
    /// How often a change stream writes a comment to keep the connection
    /// alive (15 s; tests shorten it).
    pub stream_heartbeat: Duration,
    /// The copies of the database (plan РК); `None` answers the office's
    /// backup routes `not_found`. `crate::start` always sets it.
    pub backups: Option<Arc<crate::backup::Backups>>,
}

impl AppState {
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            stopping: Arc::new(watch::channel(false).0),
            revocations: Arc::new(watch::channel(0).0),
            stream_heartbeat: Duration::from_secs(15),
            clock,
        }
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            stopping: Arc::new(watch::channel(false).0),
            revocations: Arc::new(watch::channel(0).0),
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            clock,
        }
    }
```

6. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// Change-stream heartbeat interval; tests use a short one.
    pub fn with_stream_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.stream_heartbeat = heartbeat;
        self
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
    /// Change-stream heartbeat interval; tests use a short one.
    pub fn with_stream_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.stream_heartbeat = heartbeat;
        self
    }

    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }
}
```

7. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub host_id: String,
    stopping: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    pool: SqlitePool,
    _lock: std::fs::File,
}
```

заменить на

<!-- prettier-ignore -->
```rust
    pub host_id: String,
    stopping: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
    pool: SqlitePool,
    _lock: std::fs::File,
}
```

8. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
                tracing::warn!("graceful shutdown timed out; aborting open connections");
                task.abort();
            }
        }
        self.pool.close().await;
        tracing::info!("markiro-host stopped");
```

заменить на

<!-- prettier-ignore -->
```rust
                tracing::warn!("graceful shutdown timed out; aborting open connections");
                task.abort();
            }
        }
        // A copy in progress finishes first; one that takes longer than the
        // deadline is abandoned, and its `.partial` file is removed by the
        // next run.
        let mut backups = self.backups;
        if tokio::time::timeout(SHUTDOWN_DEADLINE, &mut backups)
            .await
            .is_err()
        {
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
        self.pool.close().await;
        tracing::info!("markiro-host stopped");
```

9. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port));
    let listener = server::TlsListener::bind(bind, identity.server_config()?).await?;
    let addr = listener.bound_addr();
    let state = server::AppState::new(
        pool.clone(),
        config.host_id.clone(),
        std::sync::Arc::new(clock::SystemClock),
    )
    .with_endpoint(identity.fingerprint.clone(), addr.port());
    let stopping = state.stopping.clone();
    let mut stopped = state.stopping.subscribe();
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = stopped.wait_for(|stopping| *stopping).await;
```

заменить на

<!-- prettier-ignore -->
```rust
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port));
    let listener = server::TlsListener::bind(bind, identity.server_config()?).await?;
    let addr = listener.bound_addr();
    let clock: std::sync::Arc<dyn clock::Clock> = std::sync::Arc::new(clock::SystemClock);
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone());
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
    let mut stopped = state.stopping.subscribe();
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = stopped.wait_for(|stopping| *stopping).await;
```

10. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        host_id: config.host_id,
        stopping,
        task,
        pool,
        _lock: lock,
    })
```

заменить на

<!-- prettier-ignore -->
```rust
        host_id: config.host_id,
        stopping,
        task,
        backups: backup_worker,
        pool,
        _lock: lock,
    })
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker --test backup_copy`
Expected: PASS — 8 и 15 passed

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start --test hello  # вне песочницы`
Expected: PASS — 1 и 5 passed

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — изменение базы не вызывает копию. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
    changed || newest.is_none_or(|at| at.date() != now.date())
```

заменить на

<!-- prettier-ignore -->
```rust
    newest.is_none_or(|at| at.date() != now.date())
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_copy_is_due_when_the_data_changed_or_today_has_none`, `a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day`, `the_second_folder_gets_every_copy_and_its_failure_is_its_own`

М2 — новый день без копии. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
    changed || newest.is_none_or(|at| at.date() != now.date())
```

заменить на

<!-- prettier-ignore -->
```rust
    changed || newest.is_none()
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_copy_is_due_when_the_data_changed_or_today_has_none`, `a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day`

М3 — нет часового слота. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
        self.last_hour = Some(hour);
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_failed_copy_is_in_the_status_and_the_audit_and_the_next_hour_tries_again`, `a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day`

М4 — версия базы удачной копии не запоминается. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
            self.copied_version = version;
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_manual_copy_names_its_office_user_and_holds_off_other_copies_while_it_waits`, `a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day`

М5 — ручная копия записывается от имени хоста. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
            actor: user.map_or(Actor::System, Actor::OfficeUser),
```

заменить на

<!-- prettier-ignore -->
```rust
            actor: user.map_or(Actor::System, |_| Actor::System),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_manual_copy_names_its_office_user_and_holds_off_other_copies_while_it_waits`, `the_worker_task_copies_at_start_and_at_once_when_asked_then_stops`

М6 — плановая копия при ждущей ручной. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
    fn begin_scheduled(&self, at: OffsetDateTime) -> bool {
        let mut status = self.status();
        if status.running.is_some() {
            return false;
        }
```

заменить на

<!-- prettier-ignore -->
```rust
    fn begin_scheduled(&self, at: OffsetDateTime) -> bool {
        let mut status = self.status();
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_manual_copy_names_its_office_user_and_holds_off_other_copies_while_it_waits`

М7 — сбой второй папки записывается как успех. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
        let ok = report.local.is_ok() && report.second.as_ref().is_none_or(Result::is_ok);
```

заменить на

<!-- prettier-ignore -->
```rust
        let ok = report.local.is_ok();
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `the_second_folder_gets_every_copy_and_its_failure_is_its_own`

М8 — вторая папка «успешна» без локальной копии. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
                None => Err(Failure::new(
                    failure::LOCAL_COPY_FAILED,
                    "the local copy failed",
                )),
```

заменить на

<!-- prettier-ignore -->
```rust
                None => Ok(()),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `a_failed_local_copy_gives_the_second_folder_nothing`

М9 — хост не запускает исполнителя. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
```

заменить на

<!-- prettier-ignore -->
```rust
    let backup_worker = tokio::spawn(async move {
        let _ = (backups, clock);
    });
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start` # вне песочницы
Expected: FAIL — `a_started_host_copies_its_database_and_stops_its_worker`

М10 — исполнитель не останавливается. В `apps/standalone/host/src/backup/worker.rs` фрагмент

<!-- prettier-ignore -->
```rust
                    let _ = stopping.wait_for(|stopping| *stopping).await;
```

заменить на

<!-- prettier-ignore -->
```rust
                    let _ = stopping.wait_for(|_| false).await;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_worker`
Expected: FAIL — `the_worker_task_copies_at_start_and_at_once_when_asked_then_stops`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/backup_worker.rs apps/standalone/host/tests/backup_start.rs apps/standalone/host/src/backup/worker.rs apps/standalone/host/src/backup/mod.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/server.rs apps/standalone/host/src/lib.rs
git commit -F - <<'EOF'
feat(standalone): the backup worker — hourly while the data changes, daily, on request, the second folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Копии в офисе — состояние, копия сейчас, вторая папка с пробой (`routes/backups.rs`)

`GET` отдаёт состояние исполнителя, настройку и удержание фактов (если оно есть: каждая неотозванная станция и вернула ли она блоки для текущей эпохи) — одним снимком базы. `POST` — только администратор, `202` с идущей копией или `conflict` на `backup_running`. `PUT …/settings` проверяет путь (абсолютный, 1–260 символов, без управляющих), пробует папку вне блокировки записи и не дольше 8 с, затем в `BEGIN IMMEDIATE` перепроверяет права администратора, `expectedRev` и отсутствие изменений, пишет настройку с новой ревизией, строку журнала `backup.settings.update` и будит потоки. Без `Backups` в `AppState` маршруты отвечают `not_found`. Второй тест `backup_start` проходит весь путь запущенного хоста: подключение, мастер, вход и `GET` по HTTPS.

**Files:**

- Create: `apps/standalone/host/src/routes/backups.rs`
- Modify: `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/audit.rs`
- Test: `apps/standalone/host/tests/backup_routes.rs`, `apps/standalone/host/tests/backup_start.rs`

**Interfaces:**

- Consumes: `Backups::{request_manual, state}`, `AppState::backups` (задача 3); `folder::probe` (задача 2); `OfficeContext::{require_admin, require_admin_in, actor}`; `audit::update_details`.
- Produces: `routes::backups::{PROBE_TIMEOUT, get_backups, start_backup, put_settings}`; маршруты `GET`/`POST /v1/office/backups`, `PUT /v1/office/backups/settings`; закрытые помощники `read_settings`, `read_hold`, `answer` (задача 6 дописывает в этот файл `resume_facts`); `audit::actions::BACKUP_SETTINGS_UPDATE`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/backup_routes.rs`:

<!-- prettier-ignore -->
```rust
//! Backups in the office (plan РК): the state for every role, a copy now for
//! administrators, and the second folder, tried before it is saved.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use markiro_host::backup::{Backups, Worker};
use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, pair_device, request,
    seed_office_user, turn_the_user_off_at_the_next_activity, with_device, Admin,
};

/// Give `admin`'s host its copies in `<data dir>/backups`.
fn with_backups(admin: &mut Admin) -> Arc<Backups> {
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    let backups = Backups::new(
        admin.app.dir().to_path_buf(),
        local,
        admin.app.dir().join("host.db"),
        admin.app.state.host_id.clone(),
    );
    admin.app.state = admin.app.state.clone().with_backups(backups.clone());
    backups
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

async fn settings(admin: &Admin) -> (Option<String>, i64) {
    sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn every_office_role_reads_the_state_and_a_device_key_alone_does_not() {
    let mut admin = admin().await;
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found")),
        "a host without copies: {body}"
    );
    with_backups(&mut admin);
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "now": "2026-09-21T14:13:20Z",
            "local": {
                "dir": admin.app.dir().join("backups").display().to_string(),
                "lastAttempt": null,
                "copies": [],
            },
            "second": null,
            "settingsRev": 0,
            "running": null,
            "restoreHold": null,
        })
    );
    let tech = admin.technologist().await;
    let (status, read) = admin
        .call_as(&tech, "GET", "/v1/office/backups", None)
        .await;
    assert_eq!((status, read), (StatusCode::OK, body));
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/backups"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

#[tokio::test]
async fn an_administrator_asks_for_a_copy_and_the_worker_makes_it() {
    let mut admin = admin().await;
    let backups = with_backups(&mut admin);
    let rows = audit_rows(&admin.app).await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "POST", "/v1/office/backups", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );

    let (status, body) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(
        body["running"],
        json!({ "trigger": "manual", "startedAt": "2026-09-21T14:13:20Z" })
    );
    let (status, again) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(
        (status, refusal(&again)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), json!({ "constraint": "backup_running" }))
        )
    );
    assert_eq!(
        audit_rows(&admin.app).await,
        rows + 1,
        "only the technologist's sign-in; asking writes no row"
    );

    let mut worker = Worker::new(backups.clone(), admin.app.clock.clone());
    let made = worker.run_manual().await.unwrap().local.unwrap();
    assert_eq!(made.trigger, BackupTrigger::Manual);
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["running"], Value::Null);
    assert_eq!(body["local"]["copies"][0]["file"], json!(made.file));
    assert_eq!(
        body["local"]["lastAttempt"],
        json!({ "at": "2026-09-21T14:13:20Z", "trigger": "manual", "ok": true, "code": null })
    );
    let trail = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(trail.len(), 1);
    assert_eq!(trail[0].0, "office_user");
    assert_eq!(trail[0].1.as_deref(), Some(admin.id.as_str()));
}

#[tokio::test]
async fn the_second_folder_is_tried_saved_audited_and_cleared() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().display().to_string();
    let mut wake = admin.app.state.revisions.subscribe();
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": format!("  {dir} "), "expectedRev": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rev = host_revision(&admin.app).await;
    assert_eq!(body["settingsRev"], json!(rev));
    assert_eq!(
        body["second"],
        json!({ "dir": dir, "lastAttempt": null, "copies": [] })
    );
    assert_eq!(settings(&admin).await, (Some(dir.clone()), rev));
    assert!(wake.has_changed().unwrap(), "the change wakes the streams");
    assert_eq!(*wake.borrow_and_update(), rev);
    assert_eq!(
        audit_trail(&admin.app, "backup.settings.update").await,
        [admin.row(
            "backup.settings.update",
            "backup_settings",
            "1",
            json!({ "changed": ["secondDir"], "secondDir": { "from": null, "to": dir } }),
        )]
    );
    assert!(
        std::fs::read_dir(folder.path()).unwrap().next().is_none(),
        "the probe left nothing"
    );

    // The same folder again changes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": dir, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, same["settingsRev"].clone()),
        (StatusCode::OK, json!(rev))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(!wake.has_changed().unwrap());

    let (status, cleared) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": null, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["second"], Value::Null);
    let cleared_rev = host_revision(&admin.app).await;
    assert_eq!(settings(&admin).await, (None, cleared_rev));
    let trail = audit_trail(&admin.app, "backup.settings.update").await;
    assert_eq!(
        trail.last().unwrap().6,
        json!({ "changed": ["secondDir"], "secondDir": { "from": dir, "to": null } })
    );
}

async fn refused_without_a_trace(admin: &Admin, body: Value) -> (StatusCode, Value) {
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let before = settings(admin).await;
    let (status, answer) = admin
        .call("PUT", "/v1/office/backups/settings", Some(body))
        .await;
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(settings(admin).await, before);
    (status, answer)
}

#[tokio::test]
async fn a_folder_that_cannot_take_copies_is_refused_before_anything_is_written() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let parent = tempfile::tempdir().unwrap();
    let file = parent.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let inside = admin.app.dir().join("copies-too");
    std::fs::create_dir(&inside).unwrap();
    let cases = [
        (parent.path().join("unplugged"), "missing"),
        (file.clone(), "not_a_directory"),
        (inside.clone(), "inside_data_dir"),
        (admin.app.dir().join("backups"), "inside_data_dir"),
    ];
    for (dir, reason) in cases {
        let (status, body) = refused_without_a_trace(
            &admin,
            json!({ "secondDir": dir.display().to_string(), "expectedRev": 0 }),
        )
        .await;
        assert_eq!(
            (status, refusal(&body)),
            (
                StatusCode::CONFLICT,
                (
                    json!("conflict"),
                    json!({ "constraint": "backup_dir", "reason": reason })
                )
            ),
            "{}",
            dir.display()
        );
    }
    for text in [
        "copies",
        "   ",
        "/tmp/a\u{7}b",
        &format!("/{}", "x".repeat(260)),
    ] {
        let (status, body) =
            refused_without_a_trace(&admin, json!({ "secondDir": text, "expectedRev": 0 })).await;
        assert_eq!(
            (status, refusal(&body)),
            (
                StatusCode::BAD_REQUEST,
                (json!("validation_failed"), json!({ "field": "secondDir" }))
            ),
            "{text:?}"
        );
    }
    let (status, body) = refused_without_a_trace(&admin, json!({ "expectedRev": 0 })).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed")),
        "a body without secondDir clears nothing"
    );
}

#[tokio::test]
async fn a_stale_form_and_a_technologist_are_refused() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().display().to_string();
    let (status, body) = refused_without_a_trace(
        &admin,
        json!({ "secondDir": dir.clone(), "expectedRev": 99 }),
    )
    .await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (json!("stale_revision"), json!({ "currentRev": 0 }))
        )
    );
    let tech = admin.technologist().await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call_as(
            &tech,
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": dir, "expectedRev": 0 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(settings(&admin).await, (None, 0));
}

#[tokio::test]
async fn an_administrator_turned_off_after_the_extractor_saves_nothing() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let other = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    let folder = tempfile::tempdir().unwrap();
    turn_the_user_off_at_the_next_activity(&admin.app, &other).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call_as(
            &token,
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": folder.path().display().to_string(), "expectedRev": 0 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session")),
        "{body}"
    );
    assert_eq!(settings(&admin).await, (None, 0));
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_held_host_lists_its_stations_and_which_gave_their_blocks_back() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    let own = device["id"].as_str().unwrap().to_owned();
    let (late, _) = pair_device(&admin.app, "station").await;
    let (revoked, _) = pair_device(&admin.app, "station").await;
    pair_device(&admin.app, "office").await;
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    let pool = &admin.app.state.pool;
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = '2026-10-09T15:00:00Z'")
        .bind(epoch)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET revoked_at = '2026-10-09T15:01:00Z' WHERE id = ?")
        .bind(&revoked)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET known_blocks_epoch = ? WHERE id = ?")
        .bind(epoch)
        .bind(&own)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET known_blocks_epoch = 'an older epoch' WHERE id = ?")
        .bind(&late)
        .execute(pool)
        .await
        .unwrap();
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut stations = vec![
        json!({ "id": own, "name": "Тестовое устройство", "lastSeenAt": "2026-09-21T14:13:20Z", "reconciled": true }),
        json!({ "id": late, "name": "Тестовое устройство", "lastSeenAt": "2026-09-21T14:13:20Z", "reconciled": false }),
    ];
    stations.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    assert_eq!(
        body["restoreHold"],
        json!({ "since": "2026-10-09T15:00:00Z", "epoch": epoch, "stations": stations })
    );
}
```

2. В `apps/standalone/host/tests/backup_start.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! The host starts its backup worker with itself (plan РК): a copy right
//! after the start, and the worker stops with the host. Listens on
//! 127.0.0.1, so it runs outside the sandbox.

use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};

fn manifests(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
```

заменить на

<!-- prettier-ignore -->
```rust
//! The host starts its backup worker with itself (plan РК): a copy right
//! after the start, which the office reads, and the worker stops with the
//! host. Listens on 127.0.0.1, so it runs outside the sandbox.

mod support;

use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::{OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION};
use serde_json::{json, Value};

fn manifests(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
```

3. В `apps/standalone/host/tests/backup_start.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .count()
}

#[tokio::test]
async fn a_started_host_copies_its_database_and_stops_its_worker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&paths, options).await.unwrap();
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) == 0 {
```

заменить на

<!-- prettier-ignore -->
```rust
        .count()
}

async fn start_host(paths: &HostPaths) -> RunningHost {
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    start(paths, options).await.unwrap()
}

#[tokio::test]
async fn a_started_host_copies_its_database_and_stops_its_worker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) == 0 {
```

4. В `apps/standalone/host/tests/backup_start.rs` фрагмент

<!-- prettier-ignore -->
```rust
    assert_eq!(rows, [("system".to_owned(), "ok".to_owned())]);
    pool.close().await;
}
```

заменить на

<!-- prettier-ignore -->
```rust
    assert_eq!(rows, [("system".to_owned(), "ok".to_owned())]);
    pool.close().await;
}

#[tokio::test]
async fn the_office_of_a_started_host_reads_its_copies() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
    let client = support::pinned_client(&host.fingerprint);
    let base = format!("https://{}", host.addr);
    let protocol = PROTOCOL_VERSION.to_string();
    let paired: Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(PROTOCOL_HEADER, &protocol)
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = paired["deviceKey"].as_str().unwrap().to_owned();
    let booted: Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(PROTOCOL_HEADER, &protocol)
        .bearer_auth(&key)
        .json(&support::app::bootstrap_body())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = booted["session"]["token"].as_str().unwrap().to_owned();
    let state = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state: Value = client
                .get(format!("{base}/v1/office/backups"))
                .header(PROTOCOL_HEADER, &protocol)
                .header(OFFICE_SESSION_HEADER, &token)
                .bearer_auth(&key)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(state.get("error").is_none(), "{state}");
            if state["local"]["copies"]
                .as_array()
                .is_some_and(|copies| !copies.is_empty())
            {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the worker made a copy at start");
    assert_eq!(
        state["local"]["dir"],
        json!(paths.backups_dir().display().to_string())
    );
    assert_eq!(state["local"]["lastAttempt"]["ok"], json!(true));
    drop(client);
    host.stop().await.unwrap();
}
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — 7 failed: маршрутов нет, `left: 404` / `left: (404, (String("not_found"), Null))`

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start  # вне песочницы`
Expected: FAIL — `the_office_of_a_started_host_reads_its_copies`: `{"error":{"code":"not_found","message":"no route for GET /v1/office/backups"}}`

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/routes/backups.rs`:

<!-- prettier-ignore -->
```rust
//! Backups in the office (plan РК): `GET /v1/office/backups` (every role:
//! the state of both folders), `POST /v1/office/backups` (administrators:
//! «Сделать копию сейчас», answered at once with `202`; the worker makes the
//! copy, and the office reads the state again until nothing runs) and
//! `PUT /v1/office/backups/settings` (administrators: the second folder,
//! with `expectedRev`). A folder is tried before it is saved, outside the
//! write lock and for at most [`PROBE_TIMEOUT`]: a share on a computer that
//! is off can take much longer to fail than the office waits.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::backup::{
    dir_problems, BackupSettingsUpdate, BackupState, RestoreHold, RestoreHoldStation,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::backup::{folder, Backups};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

/// How long trying a folder may take; the office gives up after 10 s.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// The longest folder path the settings keep (the table's CHECK).
const MAX_DIR_CHARS: usize = 260;

fn backups(state: &AppState) -> Result<&Arc<Backups>, ApiError> {
    state
        .backups
        .as_ref()
        .ok_or_else(|| ApiError::not_found("this host keeps no copies"))
}

async fn read_settings(conn: &mut SqliteConnection) -> Result<(Option<String>, i64), ApiError> {
    sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)
}

/// The hold a restore set, with every unrevoked station and whether it sent
/// its blocks back for the current epoch; `None` without a hold.
async fn read_hold(conn: &mut SqliteConnection) -> Result<Option<RestoreHold>, ApiError> {
    let (since, epoch): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT facts_held_since, restore_epoch FROM site WHERE id = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let Some(since) = since else {
        return Ok(None);
    };
    // A restore sets both; an epoch missing beside a hold matches no station.
    let epoch = epoch.unwrap_or_default();
    let stations: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, last_seen_at, known_blocks_epoch FROM devices \
         WHERE kind = 'station' AND revoked_at IS NULL ORDER BY name, id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let stations = stations
        .into_iter()
        .map(|(id, name, last_seen_at, known)| RestoreHoldStation {
            id,
            name,
            last_seen_at,
            reconciled: !epoch.is_empty() && known.as_deref() == Some(epoch.as_str()),
        })
        .collect();
    Ok(Some(RestoreHold {
        since,
        epoch,
        stations,
    }))
}

/// The state as the office reads it: the worker's folders, the settings and
/// the hold, read through `conn`.
async fn answer(
    conn: &mut SqliteConnection,
    backups: &Backups,
    now: String,
) -> Result<BackupState, ApiError> {
    let (second_dir, rev) = read_settings(&mut *conn).await?;
    let mut state = backups.state(now, second_dir, rev);
    state.restore_hold = read_hold(conn).await?;
    Ok(state)
}

pub async fn get_backups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<BackupState>, ApiError> {
    let backups = backups(&state)?;
    // One snapshot for the settings and the hold; nothing is written.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let answered = answer(&mut tx, backups, state.timestamp()).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    answered.map(Json)
}

pub async fn start_backup(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<(StatusCode, Json<BackupState>), ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    if !backups.request_manual(&context.user.id, state.now()) {
        return Err(ApiError::conflict(
            "backup_running",
            "a copy is being made already",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let answered = answer(&mut tx, backups, state.timestamp()).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok((StatusCode::ACCEPTED, Json(answered?)))
}

/// The folder as typed, trimmed: 1-260 characters, no control character,
/// an absolute path.
fn second_dir(text: &str) -> Result<String, ApiError> {
    let text = text.trim();
    let count = text.chars().take(MAX_DIR_CHARS + 1).count();
    if !(1..=MAX_DIR_CHARS).contains(&count) || text.chars().any(char::is_control) {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must be 1-260 characters without control characters",
        ));
    }
    if !Path::new(text).is_absolute() {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must be an absolute path",
        ));
    }
    Ok(text.to_owned())
}

/// Try `dir` off the async threads, for at most [`PROBE_TIMEOUT`]; a folder
/// that cannot take copies is a `conflict` on `backup_dir` with
/// `details.reason`.
async fn probe(dir: &str, data_dir: &Path) -> Result<(), ApiError> {
    let (dir, data_dir) = (dir.to_owned(), data_dir.to_path_buf());
    let probed = tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::task::spawn_blocking(move || folder::probe(Path::new(&dir), &data_dir)),
    )
    .await;
    let problem = match probed {
        Ok(Ok(Ok(()))) => return Ok(()),
        Ok(Ok(Err(problem))) => problem,
        Ok(Err(error)) => return Err(ApiError::internal(error)),
        Err(_) => dir_problems::TIMEOUT,
    };
    Err(
        ApiError::conflict("backup_dir", "the folder cannot take copies")
            .with_details(json!({ "constraint": "backup_dir", "reason": problem })),
    )
}

pub async fn put_settings(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<BackupSettingsUpdate>,
) -> Result<Json<BackupState>, ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    let wanted = update.second_dir.as_deref().map(second_dir).transpose()?;
    if let Some(dir) = &wanted {
        probe(dir, &backups.data_dir).await?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let (current, rev) = read_settings(&mut tx).await?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    if current == wanted {
        // Nothing changes: no revision, no row, no audit; the transaction
        // rolls back when dropped.
        return answer(&mut tx, backups, at).await.map(Json);
    }
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE backup_settings SET second_dir = ?, rev = ? WHERE id = 1")
        .bind(&wanted)
        .bind(new_rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::BACKUP_SETTINGS_UPDATE,
            target_type: Some("backup_settings"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: audit::update_details(&[("secondDir", json!(current), json!(wanted))])
                .unwrap_or_else(|| json!({ "changed": [] })),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // Read through the transaction before the commit releases the lock.
    let answered = answer(&mut tx, backups, at).await?;
    commit_with_revision(tx, &state.revisions, new_rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(answered))
}
```

2. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! Route handlers, one module per area; `server::router` wires them.

pub mod bootstrap;
pub mod changes;
pub mod counterparties;
```

заменить на

<!-- prettier-ignore -->
```rust
//! Route handlers, one module per area; `server::router` wires them.

pub mod backups;
pub mod bootstrap;
pub mod changes;
pub mod counterparties;
```

3. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

заменить на

<!-- prettier-ignore -->
```rust
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/backups",
            get(crate::routes::backups::get_backups).post(crate::routes::backups::start_backup),
        )
        .route(
            "/v1/office/backups/settings",
            put(crate::routes::backups::put_settings),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
```

4. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
}

/// `details.reason` of a denied row: every denial names one.
```

заменить на

<!-- prettier-ignore -->
```rust
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
    /// An administrator set or cleared the second folder of copies.
    pub const BACKUP_SETTINGS_UPDATE: &str = "backup.settings.update";
}

/// `details.reason` of a denied row: every denial names one.
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: PASS — 7 passed

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start  # вне песочницы`
Expected: PASS — 2 passed

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — нет перепроверки прав в транзакции. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    context.require_admin_in(&mut tx).await?;
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `an_administrator_turned_off_after_the_extractor_saves_nothing`

М2 — изменение никого не будит. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    commit_with_revision(tx, &state.revisions, new_rev)
```

заменить на

<!-- prettier-ignore -->
```rust
    commit_with_revision(tx, &state.revisions, 0)
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `the_second_folder_is_tried_saved_audited_and_cleared`

М3 — папка сохраняется без пробы. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if let Some(dir) = &wanted {
        probe(dir, &backups.data_dir).await?;
    }
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `a_folder_that_cannot_take_copies_is_refused_before_anything_is_written`

М4 — та же папка снова — изменение. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if current == wanted {
```

заменить на

<!-- prettier-ignore -->
```rust
    if current == wanted && current.is_none() {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `the_second_folder_is_tried_saved_audited_and_cleared`

М5 — относительный путь принимается. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !Path::new(text).is_absolute() {
```

заменить на

<!-- prettier-ignore -->
```rust
    if text.is_empty() {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `a_folder_that_cannot_take_copies_is_refused_before_anything_is_written`

М6 — технолог может попросить копию. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    context.require_admin()?;
    let backups = backups(&state)?;
    if !backups.request_manual
```

заменить на

<!-- prettier-ignore -->
```rust
    let backups = backups(&state)?;
    if !backups.request_manual
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `an_administrator_asks_for_a_copy_and_the_worker_makes_it`

М7 — запущенный хост не отдаёт маршрутам `Backups`. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .with_backups(backups.clone());
```

заменить на

<!-- prettier-ignore -->
```rust
;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_start` # вне песочницы
Expected: FAIL — `the_office_of_a_started_host_reads_its_copies`

М8 — любая эпоха считается текущей. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
            reconciled: !epoch.is_empty() && known.as_deref() == Some(epoch.as_str()),
```

заменить на

<!-- prettier-ignore -->
```rust
            reconciled: known.is_some(),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `a_held_host_lists_its_stations_and_which_gave_their_blocks_back`

М9 — отозванная станция в списке. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
WHERE kind = 'station' AND revoked_at IS NULL ORDER BY name, id
```

заменить на

<!-- prettier-ignore -->
```rust
WHERE kind = 'station' ORDER BY name, id
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test backup_routes`
Expected: FAIL — `a_held_host_lists_its_stations_and_which_gave_their_blocks_back`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/backup_routes.rs apps/standalone/host/tests/backup_start.rs apps/standalone/host/src/routes/backups.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs
git commit -F - <<'EOF'
feat(standalone): backups in the office — the state, a copy now, the second folder tried before it is saved

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `markiro-host restore` и `verify-copy` — счётчики над обеими базами, новая эпоха, удержание фактов, откат при сбое

Восстановление — процедура поддержки при остановленной службе (блокировка каталога данных). Сначала проверка копии без единой записи в каталог; затем чтение текущей базы только для чтения (её WAL после сбоя питания тоже читается; файлы, которые создало чтение, удаляются), перенос её в `restore-<время>/`, копия на место через `.partial` со сверкой SHA-256, миграции и одна транзакция на одном соединении: счётчики, номера смен, эпоха, удержание, строка `host.restore`. Пул здесь не годится: его `close` может вернуться, пока последнее соединение ещё закрывается, и оно оставило бы WAL рядом с базой, которую откат возвращает на место (найдено при написании плана тестом отката). Сбой после переноса возвращает текущую базу. `summary` печатает итог; `verify-copy` — те же проверки без восстановления.

**Files:**

- Create: `apps/standalone/host/src/restore.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/audit.rs`, `apps/standalone/host/src/main.rs`
- Test: `apps/standalone/host/tests/restore.rs`

**Interfaces:**

- Consumes: `backup::copy::{read_manifest, sha256_file, partial_path, utc_stamp, Manifest}` (задача 2); `db::{MIGRATOR, options, next_revision}`; `HostConfig::load_or_create`, `HostPaths::lock`; `shifts::month_key`; `validate::serial_capacity`.
- Produces: `restore::{SSCC_MARGIN_BLOCKS = 2, SHIFT_NUMBER_MARGIN = 10, VerifiedCopy { path, size_bytes, sha256, manifest, schema_version }, CounterRaise { issuer_prefix, extension, from, to }, ShiftNumberRaise { month_key, from, to }, Current { Read, Unreadable, Absent }, RestoreReport { copy, current, saved_as, epoch, counters, shift_numbers }, verify_copy(&Path, bool) -> Result<VerifiedCopy, BoxError>, restore(&HostPaths, &Path, bool, OffsetDateTime) -> Result<RestoreReport, BoxError>, summary(&RestoreReport) -> Vec<String>}`; команды `markiro-host restore <копия> [--data-dir <путь>] [--without-manifest]` и `markiro-host verify-copy <копия> [--without-manifest]`; `audit::actions::HOST_RESTORE`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/restore.rs`:

<!-- prettier-ignore -->
```rust
//! `markiro-host restore` (plan РК): the copy back in place, every SSCC
//! counter and shift number above both databases, a new restore epoch, one
//! audit row; and every refusal leaves the data folder as it was.

mod support;

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use markiro_host::backup::copy::{make_copy, manifest_path, sha256_file, Manifest};
use markiro_host::config::HostPaths;
use markiro_host::restore::{restore, summary, verify_copy, Current};
use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use sqlx::{ConnectOptions, Connection, SqlitePool};
use support::app::{
    admin, json as json_request, plan_shift, request, shift_body, shift_setup, with_device, Admin,
    TestApp,
};
use support::backup::{at, latest_migration, names, worker_conn};

const PREFIX: &str = "460068200";
const NOW: &str = "2026-10-09T15:00:00Z";

async fn ask_block(admin: &Admin, request_id: &str) -> Value {
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({ "requestId": request_id, "issuerPrefix": PREFIX, "extension": 0 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

/// A verified copy of `app`'s database in `<data dir>/backups`.
async fn copy(app: &TestApp) -> (PathBuf, Manifest) {
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
    (folder.join(&manifest.file), manifest)
}

/// Stop using the app's database as a service that stopped cleanly has:
/// every connection closed and the WAL folded into the file (a WAL left
/// behind is `the_commits_a_crashed_host_left_in_its_wal_count_too`). A
/// pool's `close` can return while a connection is still on its way out,
/// so one more connection folds the WAL in and closes, until no WAL is
/// left. The data folder gets what a host's has: `host.json`, the folders
/// and the lock file, released.
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

async fn reopen(paths: &HostPaths) -> SqlitePool {
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
}

async fn counters(pool: &SqlitePool) -> Vec<(String, i64, i64)> {
    sqlx::query_as("SELECT issuer_prefix, extension, next_serial FROM sscc_counters ORDER BY 1, 2")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn shift_numbers(pool: &SqlitePool) -> Vec<(String, i64)> {
    sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY 1")
        .fetch_all(pool)
        .await
        .unwrap()
}

fn restore_dirs(dir: &Path) -> Vec<String> {
    names(dir)
        .into_iter()
        .filter(|name| name.starts_with("restore-"))
        .collect()
}

#[tokio::test]
async fn a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    plan_shift(&admin, shift_body(&setup)).await;
    let (copy_path, manifest) = copy(&admin.app).await;
    let copy_rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    // After the copy: a block and a shift the copy never saw.
    let lost = ask_block(&admin, "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d").await;
    assert_eq!(
        (lost["fromSerial"].clone(), lost["toSerial"].clone()),
        (json!(3500), json!(5499))
    );
    plan_shift(&admin, shift_body(&setup)).await;
    let paths = stop(&admin.app).await;
    let current = std::fs::read(paths.database_file()).unwrap();

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Read);
    let aside = paths.data_dir.join("restore-20261009T150000Z");
    assert_eq!(report.saved_as.as_deref(), Some(aside.as_path()));
    assert_eq!(std::fs::read(aside.join("host.db")).unwrap(), current);
    assert_eq!(report.copy.sha256, manifest.sha256);
    let pool = reopen(&paths).await;
    // Boxes: the current database had issued to 5499; two blocks of 2000
    // above it. Pallets: the wizard's 40, two blocks of 200 above it.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 9500), (PREFIX.to_owned(), 1, 440)]
    );
    assert_eq!(
        report
            .counters
            .iter()
            .map(|raise| (raise.extension, raise.from, raise.to))
            .collect::<Vec<_>>(),
        [(0, Some(3500), 9500), (1, Some(40), 440)]
    );
    // October had one shift in the copy and two in the current database;
    // September (the copy's month, a day before it) had none.
    assert_eq!(
        shift_numbers(&pool).await,
        [("OCT26".to_owned(), 12), ("SEP26".to_owned(), 10)]
    );
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sscc_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks, 1,
        "the block the copy never saw is the station's to register"
    );
    let (epoch, held): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT restore_epoch, facts_held_since FROM site")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(epoch.as_deref(), Some(report.epoch.as_str()));
    assert_eq!(held.as_deref(), Some(NOW), "the facts wait for the office");
    assert!(uuid::Uuid::parse_str(&report.epoch).is_ok());
    let (rev, counter_revs): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rev FROM host_revision), (SELECT min(rev) FROM sscc_counters)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((rev, counter_revs), (copy_rev + 1, copy_rev + 1));
    let row: (
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT at, actor_id, actor_kind, action, target_type, target_id, details \
         FROM audit_log WHERE action = 'host.restore'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (
            row.0.as_str(),
            row.1,
            row.2.as_str(),
            row.4.as_str(),
            row.5.as_str()
        ),
        (NOW, None, "system", "site", "1")
    );
    let details: Value = serde_json::from_str(&row.6).unwrap();
    assert_eq!(
        details,
        json!({
            "file": manifest.file,
            "sha256": manifest.sha256,
            "copyCreatedAt": "2026-09-21T14:13:20Z",
            "current": "read",
            "savedAs": "restore-20261009T150000Z",
            "epoch": report.epoch,
            "counters": [
                { "issuerPrefix": PREFIX, "extension": 0, "from": 3500, "to": 9500 },
                { "issuerPrefix": PREFIX, "extension": 1, "from": 40, "to": 440 },
            ],
            "shiftNumbers": [
                { "monthKey": "OCT26", "from": 1, "to": 12 },
                { "monthKey": "SEP26", "from": null, "to": 10 },
            ],
        })
    );
    assert_eq!(
        sha256_file(&copy_path).unwrap(),
        (manifest.size_bytes, manifest.sha256.clone()),
        "the copy itself is untouched"
    );
    assert!(!paths.data_dir.join("host.db.partial").exists());
    assert_eq!(
        summary(&report),
        [
            format!(
                "restored {} (sha256 {}, made 2026-09-21T14:13:20Z)",
                copy_path.display(),
                manifest.sha256
            ),
            format!("the previous database is in {}", aside.display()),
            format!("SSCC {PREFIX}/0: 3500 -> 9500"),
            format!("SSCC {PREFIX}/1: 40 -> 440"),
            "shift numbers OCT26: 1 -> 12".to_owned(),
            "shift numbers SEP26: - -> 10".to_owned(),
            format!(
                "restore epoch {}: stations register their SSCC blocks again when they connect",
                report.epoch
            ),
            "the stations' facts wait: resume them in the office (Резервные копии) once every station gave its blocks back".to_owned(),
            "start the host again: sc start MarkiroHost".to_owned(),
        ]
    );
    // The host answers the new epoch.
    let app = markiro_host::server::AppState::new(
        pool,
        admin.app.state.host_id.clone(),
        admin.app.clock.clone(),
    );
    let response = tower::ServiceExt::oneshot(
        markiro_host::server::router(app),
        support::app::empty(request("GET", "/v1/hello")),
    )
    .await
    .unwrap();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let hello: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(hello["restoreEpoch"], json!(report.epoch));
}

#[tokio::test]
async fn the_commits_a_crashed_host_left_in_its_wal_count_too() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    // The files as a host that lost its power leaves them: the block is in
    // the WAL only.
    let crashed = tempfile::tempdir().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        std::fs::copy(admin.app.dir().join(&name), crashed.path().join(&name)).unwrap();
    }
    std::fs::write(
        crashed.path().join("host.json"),
        json!({ "hostId": admin.app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    let mut file_alone = ConnectOptions::connect(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(crashed.path().join("host.db"))
            .read_only(true)
            .immutable(true),
    )
    .await
    .unwrap();
    let tables: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sscc_counters'")
            .fetch_one(&mut file_alone)
            .await
            .unwrap();
    file_alone.close().await.unwrap();
    assert_eq!(tables, 0, "everything is still in the WAL");
    let paths = HostPaths::new(crashed.path());
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.current, Current::Read);
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    let saved = report.saved_as.unwrap();
    assert!(
        saved.join("host.db-wal").exists(),
        "the WAL is saved with it"
    );
}

#[tokio::test]
async fn an_unreadable_current_database_leaves_the_margins_over_the_copy() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    std::fs::write(paths.database_file(), b"what is left of a dead disk").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.current, Current::Unreadable);
    let saved = report.saved_as.clone().unwrap();
    assert_eq!(
        std::fs::read(saved.join("host.db")).unwrap(),
        b"what is left of a dead disk"
    );
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 5500), (PREFIX.to_owned(), 1, 440)]
    );
    assert!(summary(&report).contains(
        &"the previous database could not be read: SSCC counters rose by the margin only"
            .to_owned()
    ));
}

#[tokio::test]
async fn a_new_computer_gets_the_copy_and_a_new_identity() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(
        (report.current, report.saved_as.clone()),
        (Current::Absent, None)
    );
    assert!(restore_dirs(fresh.path()).is_empty());
    let config = markiro_host::config::HostConfig::load(&paths).unwrap();
    assert_ne!(config.host_id, admin.app.state.host_id);
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 5500), (PREFIX.to_owned(), 1, 440)]
    );
    assert!(summary(&report).contains(&"there was no previous database".to_owned()));
}

/// The data folder's names, and the bytes of the database and its WAL.
fn snapshot(paths: &HostPaths) -> (Vec<String>, Vec<u8>, Option<Vec<u8>>) {
    let wal = std::fs::read(format!("{}-wal", paths.database_file().display())).ok();
    (
        names(&paths.data_dir),
        std::fs::read(paths.database_file()).unwrap(),
        wal,
    )
}

/// Restore `copy_path` into `paths` and expect a refusal that left the data
/// folder exactly as it was.
async fn refused(paths: &HostPaths, copy_path: &Path, without_manifest: bool) -> String {
    let before = snapshot(paths);
    let error = restore(paths, copy_path, without_manifest, at(NOW))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        snapshot(paths) == before,
        "the data folder changed: {error}"
    );
    error
}

#[tokio::test]
async fn a_damaged_copy_is_refused_and_nothing_moves() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let mut bytes = std::fs::read(&copy_path).unwrap();
    bytes[5000] ^= 0xff;
    std::fs::write(&copy_path, &bytes).unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("does not match its manifest"), "{error}");
    std::fs::remove_file(manifest_path(&copy_path)).unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("--without-manifest"), "{error}");
}

#[tokio::test]
async fn a_copy_this_build_cannot_read_is_refused_and_nothing_moves() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let foreign = paths.data_dir.join("foreign.db");
    std::fs::copy(&copy_path, &foreign).unwrap();
    {
        let mut conn =
            ConnectOptions::connect(&sqlx::sqlite::SqliteConnectOptions::new().filename(&foreign))
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (9999, 'from a newer host', 1, x'00', 0)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    let error = refused(&paths, &foreign, true).await;
    // Refused before anything moved, not by the migrator after the move.
    assert!(
        error.contains("migration 9999 of the copy is unknown to this markiro-host"),
        "{error}"
    );
    std::fs::remove_file(&foreign).unwrap();

    let blank = TestApp::new().await;
    let (blank_copy, _) = copy(&blank).await;
    let error = refused(&paths, &blank_copy, false).await;
    assert!(error.contains("wizard never finished"), "{error}");
    let text = paths.data_dir.join("text.db");
    std::fs::write(&text, "no database").unwrap();
    refused(&paths, &text, true).await;
    std::fs::remove_file(&text).unwrap();
}

#[tokio::test]
async fn a_running_host_keeps_its_data_folder() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let lock = paths.lock().unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("locked"), "{error}");
    drop(lock);
}

#[tokio::test]
async fn a_failure_after_the_move_puts_the_current_database_back() {
    let admin = admin().await;
    // The copy carries a trigger that stops the restore's own transaction;
    // the current database has none.
    sqlx::query(
        "CREATE TRIGGER no_epoch BEFORE UPDATE OF restore_epoch ON site \
         BEGIN SELECT RAISE(ABORT, 'no epoch here'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    sqlx::query("DROP TRIGGER no_epoch")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("no epoch here"), "{error}");
    let pool = reopen(&paths).await;
    let triggers: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(triggers, 0, "the current database is back");
}

#[tokio::test]
async fn verify_copy_reports_a_good_copy() {
    let admin = admin().await;
    let (copy_path, manifest) = copy(&admin.app).await;
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert_eq!(
        (
            verified.size_bytes,
            verified.sha256,
            verified.schema_version
        ),
        (
            manifest.size_bytes,
            manifest.sha256.clone(),
            latest_migration()
        )
    );
    assert_eq!(verified.manifest, Some(manifest));
    let unchecked = verify_copy(&copy_path, true).await.unwrap();
    assert_eq!(unchecked.manifest, None);
}
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `` error[E0432]: unresolved import `markiro_host::restore` ``

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/restore.rs`:

<!-- prettier-ignore -->
```rust
//! `markiro-host restore <copy>` and `markiro-host verify-copy <copy>` (plan
//! РК): putting a verified copy back while the service is stopped. A
//! support procedure, not an office screen
//! (`docs/runbooks/standalone-backup-restore.md`).
//!
//! The copy is older than the data it replaces, and stations may have
//! printed SSCCs from blocks the copy never saw. So the restore:
//!
//! 1. checks the copy (its manifest's size and SHA-256 unless
//!    `--without-manifest`, `PRAGMA integrity_check`, migrations this
//!    build knows with the same checksums, a host that finished its
//!    wizard);
//! 2. reads what the current database knew, if it still opens: each SSCC
//!    counter (and the end of each block) and each month's shift number;
//! 3. moves the current database aside (`restore-<time>/` in the data
//!    folder), puts the copy in its place and migrates it;
//! 4. in one transaction raises every SSCC counter above both databases by
//!    two block sizes of its extension (never past the prefix's last
//!    serial) and every month's shift number by 10 above both, from the
//!    copy's month to the current one; sets a new `site.restore_epoch`,
//!    which `hello` reports so stations register their blocks again; holds
//!    the stations' facts (`site.facts_held_since`) until an administrator
//!    resumes them; and writes one `host.restore` audit row.
//!
//! A failure after step 3 puts the current database back as it was.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::{Month, OffsetDateTime};

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::backup::copy::{partial_path, read_manifest, sha256_file, utc_stamp, Manifest};
use crate::clock::{format_timestamp, parse_timestamp};
use crate::config::{HostConfig, HostPaths};
use crate::db::{self, next_revision};
use crate::BoxError;

/// How far a restore lifts each SSCC counter: this many blocks of its
/// extension's size above the highest serial either database knew.
pub const SSCC_MARGIN_BLOCKS: i64 = 2;
/// How far a restore lifts each month's shift number.
pub const SHIFT_NUMBER_MARGIN: i64 = 10;

/// A copy that checked out.
#[derive(Debug, Clone)]
pub struct VerifiedCopy {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    /// `None` with `--without-manifest`.
    pub manifest: Option<Manifest>,
    pub schema_version: i64,
}

/// An SSCC counter after a restore: `from` is the copy's (`None` when only
/// the current database had the counter).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterRaise {
    pub issuer_prefix: String,
    pub extension: i64,
    pub from: Option<i64>,
    pub to: i64,
}

/// A month's shift number after a restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftNumberRaise {
    pub month_key: String,
    pub from: Option<i64>,
    pub to: i64,
}

/// What the current database was when the restore began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Current {
    /// It opened and was read: its counters count too.
    Read,
    /// It was there but could not be read: the margins alone protect.
    Unreadable,
    /// There was none (a new computer).
    Absent,
}

impl Current {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Unreadable => "unreadable",
            Self::Absent => "absent",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RestoreReport {
    pub copy: VerifiedCopy,
    pub current: Current,
    /// Where the current database went; `None` when there was none.
    pub saved_as: Option<PathBuf>,
    pub epoch: String,
    pub counters: Vec<CounterRaise>,
    pub shift_numbers: Vec<ShiftNumberRaise>,
}

fn open_read_only(path: &Path, immutable: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(immutable)
}

/// Check `path` as `markiro-host verify-copy` and `restore` do.
pub async fn verify_copy(path: &Path, without_manifest: bool) -> Result<VerifiedCopy, BoxError> {
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()).into());
    }
    let manifest = if without_manifest {
        None
    } else {
        Some(read_manifest(path).map_err(|error| {
            format!(
                "{error}; without its manifest the copy is checked only with --without-manifest"
            )
        })?)
    };
    let hashed = path.to_path_buf();
    let (size_bytes, sha256) = tokio::task::spawn_blocking(move || sha256_file(&hashed)).await??;
    if let Some(manifest) = &manifest {
        if manifest.size_bytes != size_bytes || manifest.sha256 != sha256 {
            return Err(format!(
                "{} does not match its manifest (size or SHA-256): the copy is damaged",
                path.display()
            )
            .into());
        }
    }
    let mut conn = open_read_only(path, true).connect().await?;
    let checked = check_copy(&mut conn).await;
    let _ = conn.close().await;
    let schema_version = checked?;
    Ok(VerifiedCopy {
        path: path.to_path_buf(),
        size_bytes,
        sha256,
        manifest,
        schema_version,
    })
}

async fn check_copy(conn: &mut SqliteConnection) -> Result<i64, BoxError> {
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *conn)
        .await?;
    if rows != ["ok"] {
        return Err(format!("the copy is damaged: {}", rows.join("; ")).into());
    }
    let applied: Vec<(i64, bool, Vec<u8>)> =
        sqlx::query_as("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *conn)
            .await
            .map_err(|_| "the copy is no markiro-host database")?;
    let known: BTreeMap<i64, &[u8]> = db::MIGRATOR
        .iter()
        .map(|migration| (migration.version, migration.checksum.as_ref()))
        .collect();
    for (version, success, checksum) in &applied {
        if !success || known.get(version) != Some(&checksum.as_slice()) {
            return Err(format!(
                "migration {version} of the copy is unknown to this markiro-host {}: restore it with the version that made it",
                env!("CARGO_PKG_VERSION")
            )
            .into());
        }
    }
    let Some(&(schema_version, _, _)) = applied.last() else {
        return Err("the copy is no markiro-host database".into());
    };
    let initialized: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    if initialized.is_none() {
        return Err("the copy is of a host whose wizard never finished".into());
    }
    Ok(schema_version)
}

/// What a database knew: per `(prefix, extension)` the first serial no
/// block or counter reached, and per month the last shift number.
#[derive(Debug, Default, Clone)]
struct Floors {
    counters: BTreeMap<(String, i64), i64>,
    shift_numbers: BTreeMap<String, i64>,
}

async fn read_floors(conn: &mut SqliteConnection) -> Result<Floors, sqlx::Error> {
    let counters: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT c.issuer_prefix, c.extension, max(c.next_serial, coalesce(( \
           SELECT max(b.to_serial) + 1 FROM sscc_blocks b \
           WHERE b.issuer_prefix = c.issuer_prefix AND b.extension = c.extension), 0)) \
         FROM sscc_counters c",
    )
    .fetch_all(&mut *conn)
    .await?;
    let shift_numbers: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(&mut *conn)
            .await?;
    Ok(Floors {
        counters: counters
            .into_iter()
            .map(|(prefix, extension, floor)| ((prefix, extension), floor))
            .collect(),
        shift_numbers: shift_numbers.into_iter().collect(),
    })
}

/// The current database's floors, if it opens read-only and reads. A
/// stopped host may leave its WAL behind, with the last commits in it: a
/// read-only connection that is not immutable reads them. The `-wal` and
/// `-shm` files that connection creates where there were none are removed
/// again, so the folder is left as it was found.
async fn current_floors(path: &Path) -> (Current, Floors) {
    if !path.exists() {
        return (Current::Absent, Floors::default());
    }
    let [_, wal, shm] = database_files(path);
    let (had_wal, had_shm) = (wal.exists(), shm.exists());
    let read = async {
        let mut conn = open_read_only(path, false).connect().await?;
        let floors = read_floors(&mut conn).await;
        let _ = conn.close().await;
        floors
    }
    .await;
    if !had_wal {
        let _ = fs::remove_file(&wal);
    }
    if !had_shm {
        let _ = fs::remove_file(&shm);
    }
    match read {
        Ok(floors) => (Current::Read, floors),
        Err(error) => {
            tracing::warn!(%error, "the current database could not be read");
            (Current::Unreadable, Floors::default())
        }
    }
}

/// The month keys (`MONYY`) from `from`'s month to `to`'s, both included.
fn months_between(from: time::Date, to: time::Date) -> Vec<String> {
    let mut keys = Vec::new();
    let (mut year, mut month) = (from.year(), from.month());
    while (year, u8::from(month)) <= (to.year(), u8::from(to.month())) {
        let first = time::Date::from_calendar_date(year, month, 1).expect("the first of a month");
        keys.push(crate::shifts::month_key(first));
        if month == Month::December {
            year += 1;
        }
        month = month.next();
    }
    keys
}

/// The files of the database at `db`: itself, its WAL and its shared memory.
fn database_files(db: &Path) -> [PathBuf; 3] {
    let with = |suffix: &str| {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [db.to_path_buf(), with("-wal"), with("-shm")]
}

/// Move the current database's files into `aside`; returns the moves made.
fn move_aside(db: &Path, aside: &Path) -> std::io::Result<Vec<(PathBuf, PathBuf)>> {
    fs::create_dir(aside)?;
    let mut moved = Vec::new();
    for file in database_files(db) {
        if !file.exists() {
            continue;
        }
        let target = aside.join(file.file_name().expect("a database file has a name"));
        fs::rename(&file, &target)?;
        moved.push((file, target));
    }
    Ok(moved)
}

/// Undo a restore that failed after the move: remove what the restore put in
/// place and move the current database back.
fn put_back(db: &Path, moved: &[(PathBuf, PathBuf)], aside: Option<&Path>) {
    for file in database_files(db) {
        let _ = fs::remove_file(&file);
    }
    let _ = fs::remove_file(partial_path(db));
    for (original, target) in moved {
        if let Err(error) = fs::rename(target, original) {
            eprintln!(
                "markiro-host: could not move {} back to {}: {error}",
                target.display(),
                original.display()
            );
        }
    }
    if let Some(aside) = aside {
        let _ = fs::remove_dir(aside);
    }
}

/// Put `source` in place of `db`: copied through `<db>.partial`, synced,
/// read back and compared with the verified copy.
fn place(source: &VerifiedCopy, db: &Path) -> Result<(), BoxError> {
    let partial = partial_path(db);
    fs::copy(&source.path, &partial)?;
    fs::File::open(&partial)?.sync_all()?;
    let (size, sha256) = sha256_file(&partial)?;
    if size != source.size_bytes || sha256 != source.sha256 {
        return Err("the copy changed while it was put in place".into());
    }
    fs::rename(&partial, db)?;
    Ok(())
}

/// Restore `source` into the host at `paths` (the service must be stopped:
/// the data folder's lock says so). `now` is the restore's time.
pub async fn restore(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
) -> Result<RestoreReport, BoxError> {
    // The copy is checked before the data folder is touched at all.
    let copy = verify_copy(source, without_manifest).await?;
    paths.ensure()?;
    let lock = paths.lock()?;
    // A data folder without host.json gets a new identity here, on purpose:
    // the restore of a new computer (the runbook says devices pair again).
    HostConfig::load_or_create(paths, None)?;
    let db = paths.database_file();
    let (current, current_floors) = current_floors(&db).await;
    let aside = paths.data_dir.join(format!("restore-{}", utc_stamp(now)));
    let moved = if current == Current::Absent {
        Vec::new()
    } else {
        move_aside(&db, &aside)?
    };
    let aside = (!moved.is_empty()).then_some(aside);
    let restored = async {
        place(&copy, &db)?;
        // One connection, closed before this returns: a pool can still be
        // closing a connection when its `close` returns, and that connection
        // would leave a WAL beside whichever database then lies here.
        let mut conn = db::options(&db).connect().await?;
        let raised = async {
            db::MIGRATOR.run(&mut conn).await?;
            raise(
                &mut conn,
                &copy,
                current,
                &current_floors,
                aside.as_deref(),
                now,
            )
            .await
        }
        .await;
        conn.close().await?;
        raised
    }
    .await;
    match restored {
        Ok((epoch, counters, shift_numbers)) => {
            drop(lock);
            Ok(RestoreReport {
                copy,
                current,
                saved_as: aside,
                epoch,
                counters,
                shift_numbers,
            })
        }
        Err(error) => {
            put_back(&db, &moved, aside.as_deref());
            Err(error)
        }
    }
}

type Raised = (String, Vec<CounterRaise>, Vec<ShiftNumberRaise>);

/// Lift the counters, set the epoch and write the audit row in one write
/// transaction on `conn`, rolled back on any failure. No change stream
/// listens to a restore, so it commits without one.
async fn raise(
    conn: &mut SqliteConnection,
    copy: &VerifiedCopy,
    current: Current,
    current_floors: &Floors,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    match raise_in(&mut tx, copy, current, current_floors, aside, now).await {
        Ok(raised) => {
            tx.commit().await?;
            Ok(raised)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}

async fn raise_in(
    tx: &mut SqliteConnection,
    copy: &VerifiedCopy,
    current: Current,
    current_floors: &Floors,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    let at = format_timestamp(now);
    let copy_floors = read_floors(&mut *tx).await?;
    let copy_counters: BTreeMap<(String, i64), i64> = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT issuer_prefix, extension, next_serial FROM sscc_counters",
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(prefix, extension, next)| ((prefix, extension), next))
    .collect();
    let (box_size, pallet_size): (i64, i64) =
        sqlx::query_as("SELECT box_block_size, pallet_block_size FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await?;
    let rev = next_revision(&mut *tx).await?;
    let keys: BTreeSet<&(String, i64)> = copy_floors
        .counters
        .keys()
        .chain(current_floors.counters.keys())
        .collect();
    let mut counters = Vec::new();
    for key in keys {
        let (prefix, extension) = key;
        let floor = copy_floors
            .counters
            .get(key)
            .copied()
            .max(current_floors.counters.get(key).copied())
            .unwrap_or(0);
        let size = if *extension == 0 {
            box_size
        } else {
            pallet_size
        };
        let capacity = i64::try_from(crate::validate::serial_capacity(prefix))?;
        let to = (floor + SSCC_MARGIN_BLOCKS * size).min(capacity);
        let from = copy_counters.get(key).copied();
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (issuer_prefix, extension) DO UPDATE SET next_serial = ?3, rev = ?4",
        )
        .bind(prefix)
        .bind(extension)
        .bind(to)
        .bind(rev)
        .execute(&mut *tx)
        .await?;
        counters.push(CounterRaise {
            issuer_prefix: prefix.clone(),
            extension: *extension,
            from,
            to,
        });
    }
    let copy_made = copy
        .manifest
        .as_ref()
        .and_then(|manifest| parse_timestamp(&manifest.created_at).ok())
        .unwrap_or(now);
    let mut months: BTreeSet<String> = copy_floors
        .shift_numbers
        .keys()
        .chain(current_floors.shift_numbers.keys())
        .cloned()
        .collect();
    // A shift numbered after the copy may be of the copy's month or any
    // later one; a day either side keeps a time zone off UTC covered.
    months.extend(months_between(
        (copy_made - time::Duration::days(1)).date(),
        (now + time::Duration::days(1)).date(),
    ));
    let mut shift_numbers = Vec::new();
    for month_key in months {
        let from = copy_floors.shift_numbers.get(&month_key).copied();
        let base = from
            .max(current_floors.shift_numbers.get(&month_key).copied())
            .unwrap_or(0);
        let to = base + SHIFT_NUMBER_MARGIN;
        sqlx::query(
            "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?1, ?2) \
             ON CONFLICT (month_key) DO UPDATE SET last_seq = ?2",
        )
        .bind(&month_key)
        .bind(to)
        .execute(&mut *tx)
        .await?;
        shift_numbers.push(ShiftNumberRaise {
            month_key,
            from,
            to,
        });
    }
    let epoch = uuid::Uuid::new_v4().to_string();
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = ? WHERE id = 1")
        .bind(&epoch)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    let file = copy
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    audit::record(
        &mut *tx,
        &at,
        Entry {
            actor: Actor::System,
            action: actions::HOST_RESTORE,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "file": file,
                "sha256": copy.sha256,
                "copyCreatedAt": copy.manifest.as_ref().map(|manifest| manifest.created_at.clone()),
                "current": current.as_str(),
                "savedAs": aside.and_then(Path::file_name).map(|name| name.to_string_lossy().into_owned()),
                "epoch": epoch,
                "counters": counters.iter().map(|raise| json!({
                    "issuerPrefix": raise.issuer_prefix,
                    "extension": raise.extension,
                    "from": raise.from,
                    "to": raise.to,
                })).collect::<Vec<_>>(),
                "shiftNumbers": shift_numbers.iter().map(|raise| json!({
                    "monthKey": raise.month_key,
                    "from": raise.from,
                    "to": raise.to,
                })).collect::<Vec<_>>(),
            }),
        },
    )
    .await?;
    Ok((epoch, counters, shift_numbers))
}

/// The lines `markiro-host restore` prints.
pub fn summary(report: &RestoreReport) -> Vec<String> {
    let made = report
        .copy
        .manifest
        .as_ref()
        .map_or("unknown", |manifest| manifest.created_at.as_str());
    let mut lines = vec![format!(
        "restored {} (sha256 {}, made {made})",
        report.copy.path.display(),
        report.copy.sha256
    )];
    lines.push(match &report.saved_as {
        Some(dir) => format!("the previous database is in {}", dir.display()),
        None => "there was no previous database".to_owned(),
    });
    if report.current == Current::Unreadable {
        lines.push(
            "the previous database could not be read: SSCC counters rose by the margin only"
                .to_owned(),
        );
    }
    let or_dash = |value: Option<i64>| value.map_or("-".to_owned(), |value| value.to_string());
    for raise in &report.counters {
        lines.push(format!(
            "SSCC {}/{}: {} -> {}",
            raise.issuer_prefix,
            raise.extension,
            or_dash(raise.from),
            raise.to
        ));
    }
    for raise in &report.shift_numbers {
        lines.push(format!(
            "shift numbers {}: {} -> {}",
            raise.month_key,
            or_dash(raise.from),
            raise.to
        ));
    }
    lines.push(format!(
        "restore epoch {}: stations register their SSCC blocks again when they connect",
        report.epoch
    ));
    lines.push(
        "the stations' facts wait: resume them in the office (Резервные копии) once every station gave its blocks back"
            .to_owned(),
    );
    lines.push("start the host again: sc start MarkiroHost".to_owned());
    lines
}
```

2. В `apps/standalone/host/src/lib.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod network;
pub mod pairing_code;
pub mod rate_limit;
pub mod routes;
pub mod secrets;
pub mod server;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod network;
pub mod pairing_code;
pub mod rate_limit;
pub mod restore;
pub mod routes;
pub mod secrets;
pub mod server;
```

3. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
/// the audit screen (plan 5) translates one list.
pub mod actions {
    pub const HOST_BOOTSTRAP: &str = "host.bootstrap";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
```

заменить на

<!-- prettier-ignore -->
```rust
/// the audit screen (plan 5) translates one list.
pub mod actions {
    pub const HOST_BOOTSTRAP: &str = "host.bootstrap";
    /// `markiro-host restore` put a copy back (plan РК); the host is the
    /// actor.
    pub const HOST_RESTORE: &str = "host.restore";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
```

4. В `apps/standalone/host/src/main.rs` фрагмент

<!-- prettier-ignore -->
```rust
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint

use std::path::PathBuf;
use std::process::ExitCode;
```

заменить на

<!-- prettier-ignore -->
```rust
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint
//!   restore <copy> [--data-dir <path>] [--without-manifest]
//!                                             put a copy back (the service stopped)
//!   verify-copy <copy> [--without-manifest]   check a copy

use std::path::PathBuf;
use std::process::ExitCode;
```

5. В `apps/standalone/host/src/main.rs` фрагмент

<!-- prettier-ignore -->
```rust
    PrintFingerprint {
        data_dir: PathBuf,
    },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    let mut data_dir = None;
    let mut port = None;
    let mut index = 0;
    while index < rest.len() {
        let value = rest.get(index + 1);
        match rest[index].as_str() {
            "--data-dir" => {
                data_dir = Some(PathBuf::from(value.ok_or("--data-dir needs a path")?));
            }
            "--port" => {
                let text = value.ok_or("--port needs a number")?;
                port = Some(text.parse::<u16>().map_err(|_| "--port must be 1-65535")?);
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
        index += 2;
    }
    match command.as_str() {
        "run" => Ok(Command::Run {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
            port,
        }),
        "service" if rest.is_empty() => Ok(Command::Service),
        "print-fingerprint" if port.is_none() => Ok(Command::PrintFingerprint {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
        }),
        _ => Err(USAGE.to_owned()),
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
    PrintFingerprint {
        data_dir: PathBuf,
    },
    Restore {
        data_dir: PathBuf,
        copy: PathBuf,
        without_manifest: bool,
    },
    VerifyCopy {
        copy: PathBuf,
        without_manifest: bool,
    },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]
       markiro-host restore <copy> [--data-dir <path>] [--without-manifest]
       markiro-host verify-copy <copy> [--without-manifest]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    // `restore` and `verify-copy` take the copy first.
    let (copy, rest) = match command.as_str() {
        "restore" | "verify-copy" => match rest.split_first() {
            Some((copy, rest)) if !copy.starts_with("--") => (Some(PathBuf::from(copy)), rest),
            _ => return Err(USAGE.to_owned()),
        },
        _ => (None, rest),
    };
    let mut data_dir = None;
    let mut port = None;
    let mut without_manifest = false;
    let mut index = 0;
    while index < rest.len() {
        let value = rest.get(index + 1);
        match rest[index].as_str() {
            "--data-dir" => {
                data_dir = Some(PathBuf::from(value.ok_or("--data-dir needs a path")?));
                index += 2;
            }
            "--port" => {
                let text = value.ok_or("--port needs a number")?;
                port = Some(text.parse::<u16>().map_err(|_| "--port must be 1-65535")?);
                index += 2;
            }
            "--without-manifest" => {
                without_manifest = true;
                index += 1;
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    let data_dir_or_default =
        |data_dir: Option<PathBuf>| data_dir.unwrap_or_else(HostPaths::default_data_dir);
    match (command.as_str(), copy) {
        ("run", None) if !without_manifest => Ok(Command::Run {
            data_dir: data_dir_or_default(data_dir),
            port,
        }),
        ("service", None) if rest.is_empty() => Ok(Command::Service),
        ("print-fingerprint", None) if port.is_none() && !without_manifest => {
            Ok(Command::PrintFingerprint {
                data_dir: data_dir_or_default(data_dir),
            })
        }
        ("restore", Some(copy)) if port.is_none() => Ok(Command::Restore {
            data_dir: data_dir_or_default(data_dir),
            copy,
            without_manifest,
        }),
        ("verify-copy", Some(copy)) if port.is_none() && data_dir.is_none() => {
            Ok(Command::VerifyCopy {
                copy,
                without_manifest,
            })
        }
        _ => Err(USAGE.to_owned()),
    }
}
```

6. В `apps/standalone/host/src/main.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Command::Run { data_dir, port } => run_foreground(data_dir, port),
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
```

заменить на

<!-- prettier-ignore -->
```rust
        Command::Run { data_dir, port } => run_foreground(data_dir, port),
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
        Command::Restore {
            data_dir,
            copy,
            without_manifest,
        } => restore(data_dir, copy, without_manifest),
        Command::VerifyCopy {
            copy,
            without_manifest,
        } => verify_copy(copy, without_manifest),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
```

7. В `apps/standalone/host/src/main.rs` фрагмент

<!-- prettier-ignore -->
```rust
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
```

заменить на

<!-- prettier-ignore -->
```rust
    Ok(())
}

fn restore(data_dir: PathBuf, copy: PathBuf, without_manifest: bool) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    let report = runtime.block_on(markiro_host::restore::restore(
        &paths,
        &copy,
        without_manifest,
        time::OffsetDateTime::now_utc(),
    ))?;
    for line in markiro_host::restore::summary(&report) {
        println!("{line}");
    }
    Ok(())
}

fn verify_copy(copy: PathBuf, without_manifest: bool) -> Result<(), BoxError> {
    let runtime = tokio::runtime::Runtime::new()?;
    let verified = runtime.block_on(markiro_host::restore::verify_copy(&copy, without_manifest))?;
    let made = verified.manifest.as_ref().map_or_else(
        || "the manifest was not checked".to_owned(),
        |manifest| format!("made {}", manifest.created_at),
    );
    println!(
        "{}: ok ({} bytes, sha256 {}, migration {}, {made})",
        verified.path.display(),
        verified.size_bytes,
        verified.sha256,
        verified.schema_version
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
```

8. В `apps/standalone/host/src/main.rs` фрагмент

<!-- prettier-ignore -->
```rust
    }

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(print_fingerprint(dir.path().to_path_buf()).is_err());
```

заменить на

<!-- prettier-ignore -->
```rust
    }

    #[test]
    fn restore_and_verify_copy_take_the_copy_first() {
        assert_eq!(
            parse(&args(&[
                "restore",
                "C:/copies/a.db",
                "--data-dir",
                "/tmp/h"
            ])),
            Ok(Command::Restore {
                data_dir: PathBuf::from("/tmp/h"),
                copy: PathBuf::from("C:/copies/a.db"),
                without_manifest: false,
            })
        );
        assert_eq!(
            parse(&args(&["restore", "a.db", "--without-manifest"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: true,
            })
        );
        assert_eq!(
            parse(&args(&["verify-copy", "a.db", "--without-manifest"])),
            Ok(Command::VerifyCopy {
                copy: PathBuf::from("a.db"),
                without_manifest: true,
            })
        );
        assert!(parse(&args(&["restore"])).is_err());
        assert!(parse(&args(&["restore", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["restore", "a.db", "--port", "1"])).is_err());
        assert!(parse(&args(&["verify-copy", "a.db", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["run", "--without-manifest"])).is_err());
        assert!(parse(&args(&["print-fingerprint", "--without-manifest"])).is_err());
    }

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(print_fingerprint(dir.path().to_path_buf()).is_err());
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore --bin markiro-host`
Expected: PASS — 9 и 4 passed

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — запас в один блок. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub const SSCC_MARGIN_BLOCKS: i64 = 2;
```

заменить на

<!-- prettier-ignore -->
```rust
pub const SSCC_MARGIN_BLOCKS: i64 = 1;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_new_computer_gets_the_copy_and_a_new_identity`, `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases`, `an_unreadable_current_database_leaves_the_margins_over_the_copy`, `the_commits_a_crashed_host_left_in_its_wal_count_too`

М2 — учитывается только копия. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
            .max(current_floors.counters.get(key).copied())
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases`, `the_commits_a_crashed_host_left_in_its_wal_count_too`

М3 — WAL после сбоя не читается. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
        let mut conn = open_read_only(path, false).connect().await?;
```

заменить на

<!-- prettier-ignore -->
```rust
        let mut conn = open_read_only(path, true).connect().await?;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `the_commits_a_crashed_host_left_in_its_wal_count_too`

М4 — сбой оставляет копию на месте. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
            put_back(&db, &moved, aside.as_deref());
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_failure_after_the_move_puts_the_current_database_back`

М5 — файлы, созданные чтением, остаются. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !had_wal {
        let _ = fs::remove_file(&wal);
    }
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_failure_after_the_move_puts_the_current_database_back`

М6 — повреждённая копия проходит. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if manifest.size_bytes != size_bytes || manifest.sha256 != sha256 {
```

заменить на

<!-- prettier-ignore -->
```rust
        if manifest.size_bytes != size_bytes {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_damaged_copy_is_refused_and_nothing_moves`

М7 — копия более новой сборки проходит проверку. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if !success || known.get(version) != Some(&checksum.as_slice()) {
```

заменить на

<!-- prettier-ignore -->
```rust
        if !success {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_copy_this_build_cannot_read_is_refused_and_nothing_moves`

М8 — факты не удерживаются. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = ? WHERE id = 1")
        .bind(&epoch)
        .bind(&at)
```

заменить на

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET restore_epoch = ? WHERE id = 1")
        .bind(&epoch)
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases`

М9 — номера смен поднимаются на 9. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub const SHIFT_NUMBER_MARGIN: i64 = 10;
```

заменить на

<!-- prettier-ignore -->
```rust
pub const SHIFT_NUMBER_MARGIN: i64 = 9;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases`

М10 — без месяцев между копией и сегодня. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
    months.extend(months_between(
```

заменить на

<!-- prettier-ignore -->
```rust
    let _ = (months_between(
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases`

М11 — копия хоста без мастера проходит. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if initialized.is_none() {
```

заменить на

<!-- prettier-ignore -->
```rust
    if initialized.is_none() && false {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_copy_this_build_cannot_read_is_refused_and_nothing_moves`

М12 — восстановление при запущенном хосте. В `apps/standalone/host/src/restore.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let lock = paths.lock()?;
```

заменить на

<!-- prettier-ignore -->
```rust
    let lock = ();
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore`
Expected: FAIL — `a_running_host_keeps_its_data_folder`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/restore.rs apps/standalone/host/src/restore.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/main.rs
git commit -F - <<'EOF'
feat(standalone): markiro-host restore and verify-copy — counters above both databases, a new restore epoch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Сверка после восстановления — удержание фактов, возврат блоков станцией, возобновление приёма

Квитанция хранится бессрочно (2a2), поэтому факт, отвергнутый по копии, где нет его смены или блока, остался бы отвергнутым навсегда. Слой `restore_hold` над всем роутером отвечает `restore_pending` (503) на `POST /v1/device/facts` и `GET /v1/device/codes/{…}`, пока стоит `site.facts_held_since`: раньше маршрута и проверки ключа, поэтому путь удерживается, даже когда его маршрут добавит план 2a2 позже. `POST /v1/device/sscc/blocks/known` принимает блоки станции (порядок проверок — в комментарии модуля) и отмечает станцию эпохой. `POST /v1/office/backups/resume` снимает удержание — решение администратора, который видит, какие станции вернули блоки.

**Files:**

- Create: `apps/standalone/host/src/routes/known_blocks.rs`
- Modify: `apps/standalone/host/src/routes/backups.rs`, `apps/standalone/host/src/routes/mod.rs`, `apps/standalone/host/src/server.rs`, `apps/standalone/host/src/audit.rs`
- Test: `apps/standalone/host/tests/known_blocks.rs`, `apps/standalone/host/tests/restore_hold.rs`

**Interfaces:**

- Consumes: `site.restore_epoch`, `site.facts_held_since`, `devices.known_blocks_epoch` (задачи 1, 5); `read_hold`, `answer` (задача 4); `AuthDevice::require_station_in`; `validate::{client_uuid, serial_capacity}`.
- Produces: `server::restore_hold` (слой роутера); `routes::known_blocks::{MAX_BLOCKS = 64, register_known_blocks}`; `routes::backups::resume_facts`; маршруты `POST /v1/device/sscc/blocks/known`, `POST /v1/office/backups/resume`; `audit::actions::{SSCC_BLOCK_REGISTER, HOST_RESTORE_RESUME}`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/host/tests/known_blocks.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/device/sscc/blocks/known` (plan РК): after a restore a station
//! gives the host back the blocks the copy lost; a block the host knows is
//! `known`, one it cannot take is `refused`, and only a station after a
//! restore is heard.

mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::error::ApiJson;
use markiro_host::routes::known_blocks::register_known_blocks;
use markiro_proto::backup::KnownBlocksRequest;
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    request, with_device, Admin,
};

const PREFIX: &str = "460068200";
const ISSUED: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const LOST: &str = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

fn block(id: &str, prefix: &str, extension: u8, from: u64, to: u64) -> Value {
    json!({
        "id": id, "issuerPrefix": prefix, "extension": extension,
        "fromSerial": from, "toSerial": to
    })
}

async fn send(admin: &Admin, key: &str, blocks: Vec<Value>) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), key),
            json!({ "blocks": blocks }),
        ))
        .await
}

/// A host after a restore, whose station got the block `ISSUED` (1500 …
/// 3499) before the copy; returns the block as the station holds it.
async fn restored(admin: &Admin) -> Value {
    let (status, issued) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({ "requestId": ISSUED, "issuerPrefix": PREFIX, "extension": 0 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    sqlx::query("UPDATE site SET restore_epoch = '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    block(issued["id"].as_str().unwrap(), PREFIX, 0, 1500, 3499)
}

async fn box_counter(admin: &Admin) -> (i64, i64) {
    sqlx::query_as(
        "SELECT next_serial, rev FROM sscc_counters WHERE issuer_prefix = ? AND extension = 0",
    )
    .bind(PREFIX)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

/// Every block row: `(id, device, request, from, to)`, by serial.
async fn block_rows(admin: &Admin) -> Vec<(String, String, String, i64, i64)> {
    sqlx::query_as(
        "SELECT id, device_id, request_id, from_serial, to_serial FROM sscc_blocks \
         ORDER BY from_serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

async fn device_id(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_station_gives_back_the_block_a_restore_lost_and_its_known_blocks_change_nothing() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let rev = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    let lost = block(LOST, PREFIX, 0, 3500, 5499);
    let (status, body) = send(&admin, &admin.key, vec![issued.clone(), lost.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "results": [
            { "id": issued["id"], "outcome": "known", "code": null },
            { "id": LOST, "outcome": "registered", "code": null },
        ] })
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert!(
        wake.has_changed().unwrap(),
        "the registration wakes the streams"
    );
    assert_eq!(*wake.borrow_and_update(), rev + 1);
    assert_eq!(box_counter(&admin).await, (5500, rev + 1));
    let rows = block_rows(&admin).await;
    assert_eq!(
        rows[1],
        (
            LOST.to_owned(),
            station.clone(),
            LOST.to_owned(),
            3500,
            5499
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "sscc.block.register").await,
        [(
            "device".to_owned(),
            Some(station),
            "sscc.block.register".to_owned(),
            Some("sscc_block".to_owned()),
            Some(LOST.to_owned()),
            "ok".to_owned(),
            json!({ "issuerPrefix": PREFIX, "extension": 0, "fromSerial": 3500, "toSerial": 5499 }),
        )]
    );

    // Sent again: known, and nothing is written.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = send(&admin, &admin.key, vec![lost]).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["results"][0]["outcome"], "known");
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(!wake.has_changed().unwrap());
}

#[tokio::test]
async fn a_block_below_the_counter_leaves_the_counter_where_it_is() {
    let admin = admin().await;
    restored(&admin).await;
    // The restore lifted the counter above the lost block already.
    sqlx::query("UPDATE sscc_counters SET next_serial = 9500 WHERE extension = 0")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, before_rev) = box_counter(&admin).await;
    let (status, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 3500, 5499)]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "registered");
    assert_eq!(box_counter(&admin).await, (9500, before_rev));
}

#[tokio::test]
async fn a_block_the_host_cannot_take_is_refused_and_nothing_is_written() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let mut changed = issued.clone();
    changed["toSerial"] = json!(3498);
    let blocks = vec![
        changed,
        block(LOST, PREFIX, 0, 3000, 3999),
        block(OTHER, "460068299", 0, 1, 10),
        block("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "46x", 0, 1, 10),
        block("2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 2, 1, 10),
        block("3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 0, 10, 9),
        block(
            "4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
            PREFIX,
            0,
            9_999_000,
            10_000_000,
        ),
        // The id the station once sent as a request id: another block.
        block(ISSUED, PREFIX, 0, 6000, 6099),
    ];
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let counter = box_counter(&admin).await;
    let before = block_rows(&admin).await;
    let (status, body) = send(&admin, &admin.key, blocks).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let codes: Vec<(&str, &str)> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            (
                each["outcome"].as_str().unwrap(),
                each["code"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        codes,
        [
            ("refused", "block_mismatch"),
            ("refused", "block_overlap"),
            ("refused", "prefix_unknown"),
            ("refused", "prefix_unknown"),
            ("refused", "prefix_unknown"),
            ("refused", "range_invalid"),
            ("refused", "range_invalid"),
            ("refused", "block_mismatch"),
        ]
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(box_counter(&admin).await, counter);
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_revoked_block_still_holds_its_serials_and_the_last_serial_fits() {
    let admin = admin().await;
    restored(&admin).await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = '2026-09-21T14:00:00Z'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 3499, 3600)]).await;
    assert_eq!(body["results"][0]["code"], "block_overlap", "{body}");
    let (_, body) = send(
        &admin,
        &admin.key,
        vec![block(OTHER, PREFIX, 0, 9_999_000, 9_999_999)],
    )
    .await;
    assert_eq!(body["results"][0]["outcome"], "registered", "{body}");
    assert_eq!(box_counter(&admin).await.0, 10_000_000);
}

#[tokio::test]
async fn only_a_station_after_a_restore_is_heard() {
    let admin = admin().await;
    let (status, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 1, 10)]).await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!({ "constraint": "no_restore" })
        ),
        "a host never restored lost no block"
    );
    restored(&admin).await;
    let (_, office_key) = pair_device(&admin.app, "office").await;
    let (status, body) = send(&admin, &office_key, vec![block(LOST, PREFIX, 0, 1, 10)]).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    for (blocks, field) in [
        (vec![], "blocks"),
        (vec![block(LOST, PREFIX, 0, 1, 10); 65], "blocks"),
        (
            vec![
                block(LOST, PREFIX, 0, 1, 10),
                block("not-a-uuid", PREFIX, 0, 1, 10),
            ],
            "blocks.1.id",
        ),
    ] {
        let (status, body) = send(&admin, &admin.key, blocks).await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
}

#[tokio::test]
async fn a_station_revoked_while_it_waited_registers_nothing() {
    let admin = admin().await;
    restored(&admin).await;
    let station = device_id(&admin).await;
    sqlx::query("UPDATE devices SET revoked_at = '2026-09-21T14:13:20Z' WHERE id = ?")
        .bind(&station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = block_rows(&admin).await;
    let request: KnownBlocksRequest =
        serde_json::from_value(json!({ "blocks": [block(LOST, PREFIX, 0, 3500, 5499)] })).unwrap();
    let outcome = register_known_blocks(
        State(admin.app.state.clone()),
        AuthDevice {
            id: station,
            kind: DeviceKind::Station,
        },
        ApiJson(request),
    )
    .await;
    let response = match outcome {
        Ok(answer) => answer.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_station_that_sends_only_known_blocks_is_marked_without_a_revision() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let known_epoch = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT known_blocks_epoch FROM devices WHERE id = ?",
        )
        .bind(&station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(known_epoch().await, None);
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = send(&admin, &admin.key, vec![issued.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(
        known_epoch().await.as_deref(),
        Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
```

2. Создать `apps/standalone/host/tests/restore_hold.rs`:

<!-- prettier-ignore -->
```rust
//! The hold of the stations' facts after a restore (plan РК): a held host
//! answers facts and code checks `restore_pending` and nothing else, and an
//! administrator resumes them.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use markiro_host::backup::Backups;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, login, request,
    seed_office_user, turn_the_user_off_at_the_next_activity, with_device, Admin,
};

const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const SINCE: &str = "2026-10-09T15:00:00Z";

/// A host restored at `SINCE`, with its copies in `<data dir>/backups`.
async fn held() -> (Admin, Arc<Backups>) {
    let mut admin = admin().await;
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    let backups = Backups::new(
        admin.app.dir().to_path_buf(),
        local,
        admin.app.dir().join("host.db"),
        admin.app.state.host_id.clone(),
    );
    admin.app.state = admin.app.state.clone().with_backups(backups.clone());
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = ?")
        .bind(EPOCH)
        .bind(SINCE)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    (admin, backups)
}

async fn facts(admin: &Admin) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/facts"), &admin.key),
            json!({ "records": [] }),
        ))
        .await
}

fn restore_pending() -> (StatusCode, Value, Value) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        json!("restore_pending"),
        json!({ "since": SINCE }),
    )
}

fn refusal(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

async fn held_since(admin: &Admin) -> Option<String> {
    sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_held_host_answers_facts_and_code_checks_restore_pending_and_nothing_else() {
    let (admin, _) = held().await;
    let (status, body) = facts(&admin).await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", "ab".repeat(32))),
            &admin.key,
        )))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    // The hold is the same for any caller; it tells nothing but the time.
    let (status, body) = admin
        .app
        .send(json_request(request("POST", "/v1/device/facts"), json!({})))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({
                "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
                "issuerPrefix": "460068200",
                "extension": 0
            }),
        ))
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a station still gets blocks: {block}"
    );
    let (status, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let (status, hello) = admin.app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(
        (status, hello["restoreEpoch"].clone()),
        (StatusCode::OK, json!(EPOCH))
    );
}

#[tokio::test]
async fn a_host_that_holds_nothing_lets_the_facts_through() {
    let admin = admin().await;
    let (status, body) = facts(&admin).await;
    assert_ne!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_ne!(body["error"]["code"], "restore_pending", "{body}");
}

#[tokio::test]
async fn an_administrator_resumes_the_facts_once() {
    let (admin, _) = held().await;
    let tech = admin.technologist().await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call_as(&tech, "POST", "/v1/office/backups/resume", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(held_since(&admin).await.as_deref(), Some(SINCE));

    let (status, body) = admin.call("POST", "/v1/office/backups/resume", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restoreHold"], Value::Null);
    assert_eq!(held_since(&admin).await, None);
    assert_eq!(host_revision(&admin.app).await, rev, "no feed data changed");
    assert_eq!(
        audit_trail(&admin.app, "host.restore.resume").await,
        [admin.row(
            "host.restore.resume",
            "site",
            "1",
            json!({ "since": SINCE, "epoch": EPOCH, "stations": 1, "reconciled": 0 }),
        )]
    );
    let (status, body) = facts(&admin).await;
    assert_ne!(body["error"]["code"], "restore_pending", "{status} {body}");

    let rows = audit_rows(&admin.app).await;
    let (status, again) = admin.call("POST", "/v1/office/backups/resume", None).await;
    assert_eq!(
        (status, again["restoreHold"].clone()),
        (StatusCode::OK, Value::Null)
    );
    assert_eq!(audit_rows(&admin.app).await, rows, "nothing to resume");
}

#[tokio::test]
async fn an_administrator_turned_off_after_the_extractor_resumes_nothing() {
    let (admin, _) = held().await;
    let other = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    turn_the_user_off_at_the_next_activity(&admin.app, &other).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, body) = admin
        .call_as(&token, "POST", "/v1/office/backups/resume", None)
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session")),
        "{body}"
    );
    assert_eq!(held_since(&admin).await.as_deref(), Some(SINCE));
}
```

- [ ] **Step 2: Запустить — FAIL**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `` error[E0432]: unresolved import `markiro_host::routes::known_blocks` ``

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — 3 failed, 1 passed: удержания нет (`left: (404, String("not_found"), Null)` против `restore_pending`), `POST /v1/office/backups/resume` отвечает 404; `a_host_that_holds_nothing_lets_the_facts_through` проходит

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/host/src/routes/known_blocks.rs`:

<!-- prettier-ignore -->
```rust
//! `POST /v1/device/sscc/blocks/known` (plan РК): after `markiro-host
//! restore` (`hello` names a new `restoreEpoch`) a station sends every block
//! of SSCC serials it holds, and the host takes back the ones its copy lost,
//! so the station's boxes closed with their serials are not refused as
//! `sscc_not_issued`.
//!
//! Each block, in order, in one write transaction:
//!
//! - a block with its id is `known` when it is this station's with the same
//!   prefix, extension and serials, and `refused` `block_mismatch` otherwise;
//! - else it is `refused` `prefix_unknown` without a counter of its prefix
//!   and extension, `range_invalid` when its serials are no range of that
//!   prefix, and `block_overlap` when any block (of any device, revoked ones
//!   too: their serials may be printed) holds one of its serials;
//! - else it is `registered`: stored under the station with its own id as
//!   the request id, and the counter moves past it if it was below.
//!
//! One revision when anything was registered, and one
//! `sscc.block.register` audit row per registered block. The station is
//! marked as having sent its blocks for the current epoch
//! (`devices.known_blocks_epoch`), which the office shows before it resumes
//! the facts. Only a station, only after a restore (`conflict` on
//! `no_restore` before any), at most [`MAX_BLOCKS`] blocks; the facts' hold
//! does not stop it.

use axum::extract::State;
use axum::Json;
use markiro_proto::backup::{
    known_block_codes, KnownBlock, KnownBlockOutcome, KnownBlockResult, KnownBlocksRequest,
    KnownBlocksResponse,
};
use markiro_proto::DeviceKind;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

/// The most blocks one request may carry; a station holds one or two per
/// prefix.
pub const MAX_BLOCKS: usize = 64;

const FORBIDDEN: &str = "only a station registers SSCC blocks";

fn refused(id: &str, code: &str) -> KnownBlockResult {
    KnownBlockResult {
        id: id.to_owned(),
        outcome: KnownBlockOutcome::Refused,
        code: Some(code.to_owned()),
    }
}

fn result(id: &str, outcome: KnownBlockOutcome) -> KnownBlockResult {
    KnownBlockResult {
        id: id.to_owned(),
        outcome,
        code: None,
    }
}

/// The block's serials as stored, if they are a range of its prefix.
fn serials(block: &KnownBlock) -> Option<(i64, i64)> {
    let capacity = validate::serial_capacity(&block.issuer_prefix);
    if block.from_serial > block.to_serial || block.to_serial >= capacity {
        return None;
    }
    Some((
        i64::try_from(block.from_serial).ok()?,
        i64::try_from(block.to_serial).ok()?,
    ))
}

/// What becomes of one block; its serials when it is to be registered.
async fn decide(
    conn: &mut SqliteConnection,
    device_id: &str,
    block: &KnownBlock,
) -> Result<(KnownBlockResult, Option<(i64, i64)>), ApiError> {
    let stored: Option<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT device_id, issuer_prefix, extension, from_serial, to_serial \
         FROM sscc_blocks WHERE id = ?",
    )
    .bind(&block.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if let Some((device, prefix, extension, from, to)) = stored {
        let same = device == device_id
            && prefix == block.issuer_prefix
            && extension == i64::from(block.extension)
            && i64::try_from(block.from_serial) == Ok(from)
            && i64::try_from(block.to_serial) == Ok(to);
        return Ok(if same {
            (result(&block.id, KnownBlockOutcome::Known), None)
        } else {
            (refused(&block.id, known_block_codes::BLOCK_MISMATCH), None)
        });
    }
    let prefix_ok = (4..=12).contains(&block.issuer_prefix.len())
        && block
            .issuer_prefix
            .bytes()
            .all(|byte| byte.is_ascii_digit());
    let counter: Option<i64> = if prefix_ok {
        sqlx::query_scalar("SELECT 1 FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?")
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?
    } else {
        None
    };
    if counter.is_none() {
        return Ok((refused(&block.id, known_block_codes::PREFIX_UNKNOWN), None));
    }
    let Some((from, to)) = serials(block) else {
        return Ok((refused(&block.id, known_block_codes::RANGE_INVALID), None));
    };
    let overlapping: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE issuer_prefix = ? AND extension = ? \
         AND from_serial <= ? AND to_serial >= ? LIMIT 1",
    )
    .bind(&block.issuer_prefix)
    .bind(i64::from(block.extension))
    .bind(to)
    .bind(from)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if overlapping.is_some() {
        return Ok((refused(&block.id, known_block_codes::BLOCK_OVERLAP), None));
    }
    // The block's id becomes its request id; one the station used for
    // another block already makes it another block.
    let request_taken: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sscc_blocks WHERE device_id = ? AND request_id = ?")
            .bind(device_id)
            .bind(&block.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if request_taken.is_some() {
        return Ok((refused(&block.id, known_block_codes::BLOCK_MISMATCH), None));
    }
    Ok((
        result(&block.id, KnownBlockOutcome::Registered),
        Some((from, to)),
    ))
}

pub async fn register_known_blocks(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<KnownBlocksRequest>,
) -> Result<Json<KnownBlocksResponse>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden(FORBIDDEN));
    }
    if request.blocks.is_empty() || request.blocks.len() > MAX_BLOCKS {
        return Err(ApiError::validation("blocks", "1-64 blocks"));
    }
    for (index, block) in request.blocks.iter().enumerate() {
        validate::client_uuid(&format!("blocks.{index}.id"), &block.id)?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device.require_station_in(&mut tx, FORBIDDEN).await?;
    let epoch: Option<String> = sqlx::query_scalar("SELECT restore_epoch FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let Some(epoch) = epoch else {
        return Err(ApiError::conflict(
            "no_restore",
            "the host was never restored: it lost no block",
        ));
    };
    let mut results = Vec::with_capacity(request.blocks.len());
    let mut rev = None;
    for block in &request.blocks {
        let (outcome, registered) = decide(&mut tx, &device.id, block).await?;
        if let Some((from, to)) = registered {
            let rev = match rev {
                Some(rev) => rev,
                None => {
                    let new = next_revision(&mut tx).await.map_err(ApiError::internal)?;
                    rev = Some(new);
                    new
                }
            };
            sqlx::query(
                "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
                 from_serial, to_serial, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&block.id)
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .bind(&device.id)
            .bind(&block.id)
            .bind(from)
            .bind(to)
            .bind(&at)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            // The counter only moves forward: past the block if it was not.
            sqlx::query(
                "UPDATE sscc_counters SET next_serial = ?1, rev = ?2 \
                 WHERE issuer_prefix = ?3 AND extension = ?4 AND next_serial < ?1",
            )
            .bind(to + 1)
            .bind(rev)
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: actions::SSCC_BLOCK_REGISTER,
                    target_type: Some("sscc_block"),
                    target_id: Some(&block.id),
                    outcome: Outcome::Ok,
                    details: json!({
                        "issuerPrefix": block.issuer_prefix,
                        "extension": block.extension,
                        "fromSerial": block.from_serial,
                        "toSerial": block.to_serial,
                    }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
        }
        results.push(outcome);
    }
    // The station gave its blocks back for this epoch, whatever became of
    // each: the office lists the stations that did not yet.
    let marked = sqlx::query(
        "UPDATE devices SET known_blocks_epoch = ?1 WHERE id = ?2 \
         AND known_blocks_epoch IS NOT ?1",
    )
    .bind(&epoch)
    .bind(&device.id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    match rev {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev)
            .await
            .map_err(ApiError::internal)?,
        // Devices are no feed data: marking one takes no revision.
        None if marked > 0 => tx.commit().await.map_err(ApiError::internal)?,
        // Nothing changed: the transaction rolls back when dropped.
        None => drop(tx),
    }
    Ok(Json(KnownBlocksResponse { results }))
}
```

2. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! «Сделать копию сейчас», answered at once with `202`; the worker makes the
//! copy, and the office reads the state again until nothing runs) and
//! `PUT /v1/office/backups/settings` (administrators: the second folder,
//! with `expectedRev`). A folder is tried before it is saved, outside the
//! write lock and for at most [`PROBE_TIMEOUT`]: a share on a computer that
//! is off can take much longer to fail than the office waits.

use std::path::Path;
use std::sync::Arc;
```

заменить на

<!-- prettier-ignore -->
```rust
//! «Сделать копию сейчас», answered at once with `202`; the worker makes the
//! copy, and the office reads the state again until nothing runs) and
//! `PUT /v1/office/backups/settings` (administrators: the second folder,
//! with `expectedRev`) and `POST /v1/office/backups/resume` (administrators:
//! end the hold of the stations' facts a restore set). A folder is tried
//! before it is saved, outside the write lock and for at most
//! [`PROBE_TIMEOUT`]: a share on a computer that is off can take much longer
//! to fail than the office waits.

use std::path::Path;
use std::sync::Arc;
```

3. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .map_err(ApiError::internal)?;
    Ok(Json(answered))
}
```

заменить на

<!-- prettier-ignore -->
```rust
        .map_err(ApiError::internal)?;
    Ok(Json(answered))
}

/// End the hold a restore set: the stations' facts and code checks are
/// answered again. Whether every station gave its blocks back first is the
/// administrator's call (a station on a dead computer never will); the
/// answer and the audit row say how many did. Resuming without a hold
/// changes nothing and writes no row. Devices and the hold are no feed data:
/// no revision.
pub async fn resume_facts(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<BackupState>, ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let Some(hold) = read_hold(&mut tx).await? else {
        return answer(&mut tx, backups, at).await.map(Json);
    };
    sqlx::query("UPDATE site SET facts_held_since = NULL WHERE id = 1")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let reconciled = hold.stations.iter().filter(|each| each.reconciled).count();
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::HOST_RESTORE_RESUME,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "since": hold.since,
                "epoch": hold.epoch,
                "stations": hold.stations.len(),
                "reconciled": reconciled,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let answered = answer(&mut tx, backups, at).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answered))
}
```

4. В `apps/standalone/host/src/routes/mod.rs` фрагмент

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
```

заменить на

<!-- prettier-ignore -->
```rust
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod known_blocks;
pub mod lines;
pub mod office_auth;
pub mod office_shifts;
```

5. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{Method, Uri};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
```

заменить на

<!-- prettier-ignore -->
```rust
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
```

6. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .with_state(state)
}

/// Routes behind the protocol guard.
```

заменить на

<!-- prettier-ignore -->
```rust
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), restore_hold))
        .with_state(state)
}

/// What a restore holds (plan РК): a station's facts and its code checks,
/// whose answers depend on the shifts, blocks and codes a copy may lack.
fn held_by_a_restore(path: &str) -> bool {
    path == "/v1/device/facts" || path.starts_with("/v1/device/codes/")
}

/// From `markiro-host restore` until an administrator resumes, a held path
/// answers `restore_pending` (503) instead of a receipt: a receipt is kept
/// for good, so a fact refused against a copy that lacks its shift or block
/// would stay refused, while a station sends a fact the host did not take
/// again later. A layer over the whole router, so a held path is held
/// whichever plan adds its route.
pub async fn restore_hold(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if held_by_a_restore(request.uri().path()) {
        let since: Option<String> =
            sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id = 1")
                .fetch_one(&state.pool)
                .await
                .map_err(ApiError::internal)?;
        if let Some(since) = since {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                markiro_proto::codes::RESTORE_PENDING,
                "the host was restored from a copy: facts wait until the office resumes them",
            )
            .with_details(serde_json::json!({ "since": since })));
        }
    }
    Ok(next.run(request).await)
}

/// Routes behind the protocol guard.
```

7. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route(
            "/v1/device/sscc/blocks/known",
            post(crate::routes::known_blocks::register_known_blocks),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
```

8. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/backups/settings",
            put(crate::routes::backups::put_settings),
        )
        .route(
            "/v1/office/users",
```

заменить на

<!-- prettier-ignore -->
```rust
        .route(
            "/v1/office/backups/settings",
            put(crate::routes::backups::put_settings),
        )
        .route(
            "/v1/office/backups/resume",
            post(crate::routes::backups::resume_facts),
        )
        .route(
            "/v1/office/users",
```

9. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// `markiro-host restore` put a copy back (plan РК); the host is the
    /// actor.
    pub const HOST_RESTORE: &str = "host.restore";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
```

заменить на

<!-- prettier-ignore -->
```rust
    /// `markiro-host restore` put a copy back (plan РК); the host is the
    /// actor.
    pub const HOST_RESTORE: &str = "host.restore";
    /// An administrator resumed the stations' facts a restore held.
    pub const HOST_RESTORE_RESUME: &str = "host.restore.resume";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
```

10. В `apps/standalone/host/src/audit.rs` фрагмент

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
```

заменить на

<!-- prettier-ignore -->
```rust
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// After a restore, a station gave the host back a block the copy had
    /// lost (plan РК).
    pub const SSCC_BLOCK_REGISTER: &str = "sscc.block.register";
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
```

- [ ] **Step 4: Запустить — PASS**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks --test restore_hold --test backup_routes --test sscc_blocks`
Expected: PASS — 7, 4, 7 passed и прежний `sscc_blocks`

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — соприкасающиеся блоки не пересекаются. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
AND from_serial <= ? AND to_serial >= ? LIMIT 1
```

заменить на

<!-- prettier-ignore -->
```rust
AND from_serial < ? AND to_serial > ? LIMIT 1
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `a_revoked_block_still_holds_its_serials_and_the_last_serial_fits`

М2 — блоки принимаются без восстановления. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let Some(epoch) = epoch else {
```

заменить на

<!-- prettier-ignore -->
```rust
    let Some(epoch) = epoch.or(Some(String::new())) else {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `only_a_station_after_a_restore_is_heard`

М3 — счётчик идёт назад. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
WHERE issuer_prefix = ?3 AND extension = ?4 AND next_serial < ?1
```

заменить на

<!-- prettier-ignore -->
```rust
WHERE issuer_prefix = ?3 AND extension = ?4
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `a_block_below_the_counter_leaves_the_counter_where_it_is`

М4 — нет перепроверки станции в транзакции. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
    device.require_station_in(&mut tx, FORBIDDEN).await?;
```

удалить.

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `a_station_revoked_while_it_waited_registers_nothing`

М5 — станция не отмечается. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
        None if marked > 0 => tx.commit().await.map_err(ApiError::internal)?,
```

заменить на

<!-- prettier-ignore -->
```rust
        None if marked > 0 => drop(tx),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `a_station_that_sends_only_known_blocks_is_marked_without_a_revision`

М6 — регистрация никого не будит. В `apps/standalone/host/src/routes/known_blocks.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Some(rev) => commit_with_revision(tx, &state.revisions, rev)
```

заменить на

<!-- prettier-ignore -->
```rust
        Some(rev) => commit_with_revision(tx, &state.revisions, rev - rev)
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test known_blocks`
Expected: FAIL — `a_station_gives_back_the_block_a_restore_lost_and_its_known_blocks_change_nothing`

М7 — проверки кодов не удерживаются. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    path == "/v1/device/facts" || path.starts_with("/v1/device/codes/")
```

заменить на

<!-- prettier-ignore -->
```rust
    path == "/v1/device/facts"
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `a_held_host_answers_facts_and_code_checks_restore_pending_and_nothing_else`

М8 — ничего не удерживается. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
        if let Some(since) = since {
```

заменить на

<!-- prettier-ignore -->
```rust
        if let Some(since) = since.filter(|_| false) {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `a_held_host_answers_facts_and_code_checks_restore_pending_and_nothing_else`

М9 — удержание держит всё. В `apps/standalone/host/src/server.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if held_by_a_restore(request.uri().path()) {
```

заменить на

<!-- prettier-ignore -->
```rust
    if !request.uri().path().is_empty() {
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `a_held_host_answers_facts_and_code_checks_restore_pending_and_nothing_else`, `an_administrator_resumes_the_facts_once`, `an_administrator_turned_off_after_the_extractor_resumes_nothing`

М10 — возобновление оставляет удержание. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET facts_held_since = NULL WHERE id = 1")
```

заменить на

<!-- prettier-ignore -->
```rust
    sqlx::query("UPDATE site SET facts_held_since = facts_held_since WHERE id = 1")
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `an_administrator_resumes_the_facts_once`

М11 — возобновление без перепроверки прав. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let Some(hold)
```

заменить на

<!-- prettier-ignore -->
```rust
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let Some(hold)
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `an_administrator_turned_off_after_the_extractor_resumes_nothing`

М12 — строка журнала не считает станции. В `apps/standalone/host/src/routes/backups.rs` фрагмент

<!-- prettier-ignore -->
```rust
                "stations": hold.stations.len(),
```

заменить на

<!-- prettier-ignore -->
```rust
                "stations": 0,
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test restore_hold`
Expected: FAIL — `an_administrator_resumes_the_facts_once`

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/tests/known_blocks.rs apps/standalone/host/tests/restore_hold.rs apps/standalone/host/src/routes/known_blocks.rs apps/standalone/host/src/routes/backups.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs
git commit -F - <<'EOF'
feat(standalone): after a restore the host holds the facts, a station gives back its blocks, the office resumes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Страница «Резервные копии» и предупреждения на «Обзоре»

Страница читает состояние и перечитывает его каждую секунду, пока копия идёт. Предупреждения (`backupWarnings`) считаются по часам хоста из ответа, а не по часам этого ПК. Карточки: удержание фактов со станциями и кнопкой «Возобновить приём данных станций» (через `ConfirmDialog`, текст зависит от того, все ли станции вернули блоки), папка хоста с кнопкой «Сделать копию сейчас», вторая папка с формой (отказ хоста по причине — под полем), копии на хосте, восстановление. Технолог видит всё без кнопок и формы (`useCan("manageBackups")`). «Обзор» показывает те же предупреждения и ссылку на страницу, а пока ответа нет или он с ошибкой — ничего. Тестовая подделка `HostApi` по умолчанию отвечает здоровым состоянием, чтобы «Обзор» в прежних тестах ничего не показывал.

**Files:**

- Create: `apps/standalone/src/office/backups/backup-format.ts`, `apps/standalone/src/office/backups/backup-warnings.ts`, `apps/standalone/src/office/backups/BackupWarnings.tsx`, `apps/standalone/src/office/backups/SecondDirForm.tsx`, `apps/standalone/src/office/backups/BackupsPage.tsx`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/src/office/OfficeOverview.tsx`, `apps/standalone/src/office/access.ts`, `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/support/backups.ts`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/backup-warnings.test.ts`, `apps/standalone/test/backups-page.test.tsx`

**Interfaces:**

- Consumes: `backupStateSchema`, `BACKUP_FAILURES`, `BACKUP_DIR_PROBLEMS`, типы (задача 1); маршруты задач 4 и 6; `plainTextRule` (`src/lib/rules.ts`), `writeFailure`, `alertFailure`, `failureMessage`, `useOfficeQuery`, `useOfficeMutation`, `useCan`.
- Produces: `HostApi.{getBackups, startBackup, updateBackupSettings, resumeFacts}`; `officeKeys.backups`; способность `manageBackups` (администратор); маршрут `/backups`, пункт меню `office.nav.backups` в разделе `office.nav.sections.service`; `src/office/backups/{backup-format.ts (formatWhen, formatSize), backup-warnings.ts (STALE_AFTER_MS, STUCK_AFTER_MS, BackupWarning, failureReason, backupWarnings, warningTone, warningText), BackupWarnings.tsx, SecondDirForm.tsx, BackupsPage.tsx (BACKUP_POLL_MS, BackupsPage)}`; ключи `office.backups.*`; тестовые `HEALTHY_BACKUPS`, `backupCopy`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/support/backups.ts`:

<!-- prettier-ignore -->
```ts
import type { BackupCopy, BackupState } from "../../src/host/backups.js";

/** A copy made at `createdAt`, 4 MiB. */
export function backupCopy(
  createdAt: string,
  trigger: BackupCopy["trigger"] = "scheduled",
): BackupCopy {
  const stamp = createdAt.replace(/[-:]/g, "");
  return {
    file: `markiro-host-${stamp}-7c1e2a9b.db`,
    createdAt,
    trigger,
    sizeBytes: 4 * 1024 * 1024,
    sha256: "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
  };
}

/**
 * Copies as they should be: both folders copied at 14:00 by the host's
 * clock, nothing running. The office's default answer: it warns of nothing.
 */
export const HEALTHY_BACKUPS: BackupState = {
  now: "2026-10-09T14:20:00Z",
  local: {
    dir: "C:\\ProgramData\\Markiro\\Host\\backups",
    lastAttempt: { at: "2026-10-09T14:00:03Z", trigger: "scheduled", ok: true, code: null },
    copies: [backupCopy("2026-10-09T14:00:00Z"), backupCopy("2026-10-09T11:35:12Z", "manual")],
  },
  second: {
    dir: "\\\\ADMIN-PC\\MarkiroCopies",
    lastAttempt: { at: "2026-10-09T14:00:04Z", trigger: "scheduled", ok: true, code: null },
    copies: [backupCopy("2026-10-09T14:00:00Z")],
  },
  settingsRev: 7,
  running: null,
  restoreHold: null,
};
```

2. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { Office, type OfficeProps } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import type { LabelRendering } from "../../src/office/templates/label-rendering.js";
import { SESSION } from "./fixtures.js";

/** A `HostApi` of mocks. */
```

заменить на

<!-- prettier-ignore -->
```tsx
import { Office, type OfficeProps } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import type { LabelRendering } from "../../src/office/templates/label-rendering.js";
import { HEALTHY_BACKUPS } from "./backups.js";
import { SESSION } from "./fixtures.js";

/** A `HostApi` of mocks. */
```

3. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
    ...overrides,
  };
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    updateTemplateDefaults: vi.fn<HostApi["updateTemplateDefaults"]>(() =>
      unexpected("updateTemplateDefaults"),
    ),
    // «Обзор» reads the copies on every office test: healthy ones warn of nothing.
    getBackups: vi.fn<HostApi["getBackups"]>(async () => HEALTHY_BACKUPS),
    startBackup: vi.fn<HostApi["startBackup"]>(() => unexpected("startBackup")),
    updateBackupSettings: vi.fn<HostApi["updateBackupSettings"]>(() =>
      unexpected("updateBackupSettings"),
    ),
    resumeFacts: vi.fn<HostApi["resumeFacts"]>(() => unexpected("resumeFacts")),
    ...overrides,
  };
}
```

4. Создать `apps/standalone/test/backup-warnings.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from "vitest";

import type { BackupState } from "../src/host/backups.js";
import {
  backupWarnings,
  failureReason,
  warningText,
  warningTone,
} from "../src/office/backups/backup-warnings.js";
import { formatWhen } from "../src/office/backups/backup-format.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";

function state(change: Partial<BackupState>): BackupState {
  return { ...HEALTHY_BACKUPS, ...change };
}

describe("backupWarnings", () => {
  it("is quiet when both folders have a fresh copy", () => {
    expect(backupWarnings(HEALTHY_BACKUPS)).toEqual([]);
  });

  it("names a failed folder first, with its reason", () => {
    const failed = state({
      local: {
        ...HEALTHY_BACKUPS.local,
        lastAttempt: {
          at: "2026-10-09T14:00:03Z",
          trigger: "scheduled",
          ok: false,
          code: "disk_full",
        },
      },
      second: {
        ...HEALTHY_BACKUPS.local,
        dir: "E:\\Markiro",
        lastAttempt: {
          at: "2026-10-09T14:00:03Z",
          trigger: "scheduled",
          ok: false,
          code: "from_a_newer_host",
        },
      },
    });
    const warnings = backupWarnings(failed);
    expect(warnings).toEqual([
      { kind: "localFailed", reason: "disk_full" },
      { kind: "secondFailed", reason: "unknown" },
    ]);
    expect(warnings.map(warningTone)).toEqual(["error", "error"]);
    expect(warningText(warnings[0]!)).toEqual({
      key: "office.backups.warnings.localFailed",
      reason: "office.backups.failures.disk_full",
    });
  });

  it("warns of no copy, a copy older than 26 hours and no second folder", () => {
    expect(
      backupWarnings(state({ local: { ...HEALTHY_BACKUPS.local, copies: [] }, second: null })),
    ).toEqual([{ kind: "noCopies" }, { kind: "noSecond" }]);
    const old = [backupCopy("2026-10-08T12:19:59Z")];
    const exactly = [backupCopy("2026-10-08T12:20:00Z")];
    expect(
      backupWarnings(
        state({
          local: { ...HEALTHY_BACKUPS.local, copies: old },
          second: { ...HEALTHY_BACKUPS.local, copies: old },
        }),
      ),
    ).toEqual([{ kind: "stale" }, { kind: "secondStale" }]);
    expect(
      backupWarnings(
        state({
          local: { ...HEALTHY_BACKUPS.local, copies: exactly },
          second: { ...HEALTHY_BACKUPS.local, copies: exactly },
        }),
      ),
    ).toEqual([]);
    expect(warningTone({ kind: "stale" })).toBe("warn");
    expect(warningText({ kind: "noSecond" })).toEqual({ key: "office.backups.warnings.noSecond" });
  });

  it("does not repeat a stale second folder whose last attempt failed", () => {
    const old = [backupCopy("2026-10-01T00:00:00Z")];
    expect(
      backupWarnings(
        state({
          second: {
            dir: "E:\\Markiro",
            copies: old,
            lastAttempt: {
              at: "2026-10-09T14:00:03Z",
              trigger: "scheduled",
              ok: false,
              code: "destination_unavailable",
            },
          },
        }),
      ),
    ).toEqual([{ kind: "secondFailed", reason: "destination_unavailable" }]);
  });

  it("warns of a copy running for more than half an hour", () => {
    const running = (startedAt: string) => state({ running: { trigger: "manual", startedAt } });
    expect(backupWarnings(running("2026-10-09T13:50:00Z"))).toEqual([]);
    expect(backupWarnings(running("2026-10-09T13:49:59Z"))).toEqual([{ kind: "stuck" }]);
    expect(warningTone({ kind: "stuck" })).toBe("warn");
  });

  it("puts the facts a restore holds first, with how many stations gave their blocks back", () => {
    const held = state({
      restoreHold: {
        since: "2026-10-09T15:00:00Z",
        epoch: "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
        stations: [
          {
            id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            name: "Станция 1",
            lastSeenAt: null,
            reconciled: true,
          },
          {
            id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            name: "Станция 2",
            lastSeenAt: null,
            reconciled: false,
          },
        ],
      },
      second: null,
    });
    const warnings = backupWarnings(held);
    expect(warnings).toEqual([
      { kind: "held", since: "2026-10-09T15:00:00Z", reconciled: 1, stations: 2 },
      { kind: "noSecond" },
    ]);
    expect(warningTone(warnings[0]!)).toBe("error");
    expect(warningText(warnings[0]!)).toEqual({
      key: "office.backups.warnings.held",
      values: { since: formatWhen("2026-10-09T15:00:00Z"), reconciled: 1, stations: 2 },
    });
  });

  it("reads only the failure codes it has words for", () => {
    expect(failureReason("verify_failed")).toBe("verify_failed");
    expect(failureReason(null)).toBe("unknown");
    expect(failureReason("toString")).toBe("unknown");
  });
});
```

5. Создать `apps/standalone/test/backups-page.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { BackupState } from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import { formatSize, formatWhen } from "../src/office/backups/backup-format.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

/** The second folder's last copy failed: the share is off. */
const SECOND_FAILED: BackupState = {
  ...HEALTHY_BACKUPS,
  second: {
    dir: "\\\\ADMIN-PC\\MarkiroCopies",
    lastAttempt: {
      at: "2026-10-09T14:00:04Z",
      trigger: "scheduled",
      ok: false,
      code: "destination_unavailable",
    },
    copies: [backupCopy("2026-10-09T10:00:00Z")],
  },
};

function conflict(details: Record<string, unknown>): HostError {
  return new HostError({ kind: "api", code: "conflict", message: "", status: 409, details });
}

async function openBackups(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Резервные копии" }));
  await screen.findByRole("heading", { name: "Резервные копии", level: 1 });
}

function card(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  const found = heading.closest(".mk-card");
  if (!(found instanceof HTMLElement)) throw new Error(`no card ${title}`);
  return found;
}

describe("Резервные копии", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist both folders, the failed copy and how to restore, with no controls", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    await openBackups(session);
    expect(
      screen.getByText("Последняя копия во вторую папку не удалась: папка недоступна."),
    ).toBeTruthy();
    const local = card("Папка на компьютере хоста");
    expect(within(local).getByText("C:\\ProgramData\\Markiro\\Host\\backups")).toBeTruthy();
    expect(
      within(local).getByText(
        `${formatWhen("2026-10-09T14:00:00Z")}, ${formatSize(4 * 1024 * 1024)}`,
      ),
    ).toBeTruthy();
    expect(within(local).getByText(`${formatWhen("2026-10-09T14:00:03Z")}: успешно`)).toBeTruthy();
    const second = card("Вторая папка");
    expect(within(second).getByText("\\\\ADMIN-PC\\MarkiroCopies")).toBeTruthy();
    expect(
      within(second).getByText(
        `${formatWhen("2026-10-09T14:00:04Z")}: не удалась — папка недоступна`,
      ),
    ).toBeTruthy();
    expect(
      within(second).getByText("Изменять эти данные может только администратор."),
    ).toBeTruthy();
    const rows = within(card("Копии на компьютере хоста")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("Вручную")).toBeTruthy();
    expect(within(card("Восстановление")).getByText(/sc stop MarkiroHost/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сделать копию сейчас" })).toBeNull();
    expect(screen.queryByLabelText("Путь ко второй папке")).toBeNull();
  });

  it("makes a copy now and follows it until it is made", async () => {
    const session = fakeOfficeSession();
    const running: BackupState = {
      ...HEALTHY_BACKUPS,
      running: { trigger: "manual", startedAt: "2026-10-09T14:20:00Z" },
    };
    const made: BackupState = {
      ...HEALTHY_BACKUPS,
      now: "2026-10-09T14:20:05Z",
      local: {
        ...HEALTHY_BACKUPS.local,
        lastAttempt: { at: "2026-10-09T14:20:00Z", trigger: "manual", ok: true, code: null },
        copies: [backupCopy("2026-10-09T14:20:00Z", "manual"), ...HEALTHY_BACKUPS.local.copies],
      },
    };
    session.api.getBackups
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(running)
      .mockResolvedValue(made);
    session.api.startBackup.mockResolvedValue(running);
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    expect(await screen.findByRole("button", { name: "Копия делается…" })).toBeTruthy();
    expect(session.api.startBackup).toHaveBeenCalledWith("office-session-token");
    expect(
      await screen.findByText("Копия сделана и проверена.", undefined, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сделать копию сейчас" })).toBeTruthy();
    expect(within(card("Копии на компьютере хоста")).getAllByRole("row")).toHaveLength(4);
  }, 10_000);

  it("says a copy runs already and reads the state again", async () => {
    const session = fakeOfficeSession();
    session.api.startBackup.mockRejectedValue(conflict({ constraint: "backup_running" }));
    await openBackups(session);
    const reads = session.api.getBackups.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    expect(await screen.findByText("Копия уже делается — дождитесь её.")).toBeTruthy();
    await waitFor(() => expect(session.api.getBackups.mock.calls.length).toBe(reads + 1));
  });

  it("saves the second folder, and shows why the host refused one", async () => {
    const session = fakeOfficeSession();
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
    session.api.updateBackupSettings
      .mockRejectedValueOnce(conflict({ constraint: "backup_dir", reason: "missing" }))
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "",
          status: 400,
          details: { field: "secondDir" },
        }),
      )
      .mockResolvedValueOnce({
        ...HEALTHY_BACKUPS,
        second: { dir: "E:\\Markiro", lastAttempt: null, copies: [] },
        settingsRev: 8,
      });
    await openBackups(session);
    expect(screen.getByText("Вторая папка не задана.")).toBeTruthy();
    const input = screen.getByLabelText("Путь ко второй папке");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите полный путь к папке, до 260 символов")).toBeTruthy();
    expect(session.api.updateBackupSettings).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: " E:\\Markiro " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Папка не найдена. Проверьте путь и что компьютер или флешка подключены.",
      ),
    ).toBeTruthy();
    expect(session.api.updateBackupSettings).toHaveBeenLastCalledWith("office-session-token", {
      secondDir: "E:\\Markiro",
      expectedRev: 7,
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите полный путь к папке, до 260 символов")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(within(card("Вторая папка")).getByText("E:\\Markiro")).toBeTruthy();
    expect(screen.getByText("Ещё не было")).toBeTruthy();
  });

  it("stops copying into the second folder", async () => {
    const session = fakeOfficeSession();
    session.api.updateBackupSettings.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      second: null,
      settingsRev: 8,
    });
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Не копировать во вторую папку" }));
    expect(await screen.findByText("Вторая папка не задана.")).toBeTruthy();
    expect(session.api.updateBackupSettings).toHaveBeenCalledWith("office-session-token", {
      secondDir: null,
      expectedRev: 7,
    });
    expect(
      screen.getByText(
        "Вторая папка не задана: если сломается компьютер хоста, копий не останется.",
      ),
    ).toBeTruthy();
  });

  it("shows the stations a restore waits for, and an administrator resumes the facts", async () => {
    const session = fakeOfficeSession();
    const held: BackupState = {
      ...HEALTHY_BACKUPS,
      restoreHold: {
        since: "2026-10-09T15:00:00Z",
        epoch: "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
        stations: [
          {
            id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            name: "Станция линии 1",
            lastSeenAt: "2026-10-09T15:06:00Z",
            reconciled: true,
          },
          {
            id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            name: "Станция линии 2",
            lastSeenAt: null,
            reconciled: false,
          },
        ],
      },
    };
    session.api.getBackups.mockResolvedValue(held);
    session.api.resumeFacts.mockResolvedValue(HEALTHY_BACKUPS);
    await openBackups(session);
    expect(
      screen.getByText(
        `Хост восстановлен из копии ${formatWhen("2026-10-09T15:00:00Z")} и не принимает данные станций. Блоки вернули станций: 1 из 2.`,
      ),
    ).toBeTruthy();
    const hold = card("Приём данных станций остановлен");
    const rows = within(hold).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Вернула")).toBeTruthy();
    expect(within(rows[1]!).getByText("Ещё нет")).toBeTruthy();
    fireEvent.click(within(hold).getByRole("button", { name: "Возобновить приём данных станций" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/1 из 2 ещё нет/)).toBeTruthy();
    expect(session.api.resumeFacts).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Возобновить приём данных станций" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Приём данных станций остановлен" })).toBeNull(),
    );
    expect(session.api.resumeFacts).toHaveBeenCalledWith("office-session-token");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows a technologist the hold with no way to resume", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      restoreHold: {
        since: "2026-10-09T15:00:00Z",
        epoch: "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
        stations: [],
      },
    });
    await openBackups(session);
    expect(
      within(card("Приём данных станций остановлен")).getByText("Подключённых станций нет"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Возобновить приём данных станций" })).toBeNull();
  });

  it("warns on «Обзор» and leads to the page", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    renderOffice(session);
    expect(
      await screen.findByText("Последняя копия во вторую папку не удалась: папка недоступна."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Открыть «Резервные копии»" }));
    expect(await screen.findByRole("heading", { name: "Резервные копии", level: 1 })).toBeTruthy();
  });

  it("says nothing on «Обзор» while the copies are well", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getBackups).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Открыть «Резервные копии»" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — FAIL**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts test/backups-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/office/backups/backup-warnings.js"` и `"../src/office/backups/backup-format.js"`

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  badgeInfoSchema,
```

заменить на

<!-- prettier-ignore -->
```ts
import { z } from "zod";

import { backupStateSchema, type BackupSettingsUpdate, type BackupState } from "./backups.js";
import type { HostClient } from "./client.js";
import {
  badgeInfoSchema,
```

2. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
}

/** A 204 answer parses as `null`. */
```

заменить на

<!-- prettier-ignore -->
```ts
    token: string,
    update: TemplateDefaultsUpdate,
  ) => Promise<TemplateDefaults>;
  /** The copies in both folders (plan РК); every office role reads them. */
  getBackups: (token: string) => Promise<BackupState>;
  /**
   * «Сделать копию сейчас»: `202` with the copy running; the host makes it on
   * its own, and the office reads the state again until nothing runs.
   */
  startBackup: (token: string) => Promise<BackupState>;
  updateBackupSettings: (token: string, update: BackupSettingsUpdate) => Promise<BackupState>;
  /** End the hold of the stations' facts a restore set; without a hold it changes nothing. */
  resumeFacts: (token: string) => Promise<BackupState>;
}

/** A 204 answer parses as `null`. */
```

3. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
  };
}
```

заменить на

<!-- prettier-ignore -->
```ts
        officeToken: token,
        schema: templateDefaultsSchema,
      }),
    getBackups: (token) =>
      client.request("GET", "/v1/office/backups", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    startBackup: (token) =>
      client.request("POST", "/v1/office/backups", {
        officeToken: token,
        schema: backupStateSchema,
      }),
    updateBackupSettings: (token, update) =>
      client.request("PUT", "/v1/office/backups/settings", {
        body: update,
        officeToken: token,
        schema: backupStateSchema,
      }),
    resumeFacts: (token) =>
      client.request("POST", "/v1/office/backups/resume", {
        officeToken: token,
        schema: backupStateSchema,
      }),
  };
}
```

4. Создать `apps/standalone/src/office/backups/backup-format.ts`:

<!-- prettier-ignore -->
```ts
const DATE_TIME = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** An instant the host reported, in this PC's time zone. */
export function formatWhen(instant: string): string {
  return DATE_TIME.format(new Date(instant));
}

/** A file's size: kilobytes below a megabyte, megabytes with one decimal above. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${NUMBER.format(Math.ceil(bytes / 1024))} КБ`;
  return `${NUMBER.format(bytes / (1024 * 1024))} МБ`;
}
```

5. Создать `apps/standalone/src/office/backups/backup-warnings.ts`:

<!-- prettier-ignore -->
```ts
import {
  BACKUP_FAILURES,
  type BackupDestination,
  type BackupFailure,
  type BackupState,
} from "../../host/backups.js";
import { formatWhen } from "./backup-format.js";

/** A copy older than this, by the host's clock, is a warning: the daily copy was missed. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** A copy running longer than this is a warning: a folder that hangs holds every later copy. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

/** What the office warns about, most serious first; `reason` is a failure code. */
export type BackupWarning =
  | { kind: "held"; since: string; reconciled: number; stations: number }
  | { kind: "localFailed"; reason: BackupFailure | "unknown" }
  | { kind: "secondFailed"; reason: BackupFailure | "unknown" }
  | { kind: "noCopies" }
  | { kind: "stale" }
  | { kind: "noSecond" }
  | { kind: "secondStale" }
  | { kind: "stuck" };

/** A failure code the office has words for; a newer host's other code is `unknown`. */
export function failureReason(code: string | null): BackupFailure | "unknown" {
  return BACKUP_FAILURES.find((known) => known === code) ?? "unknown";
}

function lastFailure(destination: BackupDestination): BackupFailure | "unknown" | null {
  const attempt = destination.lastAttempt;
  return attempt === null || attempt.ok ? null : failureReason(attempt.code);
}

/** Whether the folder's newest copy is older than `STALE_AFTER_MS` at the host's `now`. */
function stale(destination: BackupDestination, now: number): boolean {
  const newest = destination.copies[0];
  return newest !== undefined && now - Date.parse(newest.createdAt) > STALE_AFTER_MS;
}

/**
 * The warnings of a backup state: the stations' facts held since a restore,
 * a failed last attempt in either folder, no copy at all, a newest copy
 * older than a day and a bit, no second folder, a copy running for more than
 * half an hour. A copy in progress hides nothing: the last attempt still
 * counts until it ends.
 */
export function backupWarnings(state: BackupState): BackupWarning[] {
  const now = Date.parse(state.now);
  const warnings: BackupWarning[] = [];
  const hold = state.restoreHold;
  if (hold !== null) {
    warnings.push({
      kind: "held",
      since: hold.since,
      reconciled: hold.stations.filter((station) => station.reconciled).length,
      stations: hold.stations.length,
    });
  }
  const local = lastFailure(state.local);
  if (local !== null) warnings.push({ kind: "localFailed", reason: local });
  const second = state.second === null ? null : lastFailure(state.second);
  if (second !== null) warnings.push({ kind: "secondFailed", reason: second });
  if (state.local.copies.length === 0) {
    warnings.push({ kind: "noCopies" });
  } else if (stale(state.local, now)) {
    warnings.push({ kind: "stale" });
  }
  if (state.second === null) {
    warnings.push({ kind: "noSecond" });
  } else if (second === null && stale(state.second, now)) {
    warnings.push({ kind: "secondStale" });
  }
  if (state.running !== null && now - Date.parse(state.running.startedAt) > STUCK_AFTER_MS) {
    warnings.push({ kind: "stuck" });
  }
  return warnings;
}

/** The alert tone of a warning: held facts and a failure are errors, the rest warnings. */
export function warningTone(warning: BackupWarning): "error" | "warn" {
  return warning.kind === "held" ||
    warning.kind === "localFailed" ||
    warning.kind === "secondFailed"
    ? "error"
    : "warn";
}

/**
 * The i18n key of a warning's text and its values; `reason` is itself an
 * i18n key, to translate before it goes into the text.
 */
export function warningText(warning: BackupWarning): {
  key: string;
  reason?: string;
  values?: Record<string, string | number>;
} {
  const key = `office.backups.warnings.${warning.kind}`;
  if (warning.kind === "localFailed" || warning.kind === "secondFailed") {
    return { key, reason: `office.backups.failures.${warning.reason}` };
  }
  if (warning.kind === "held") {
    return {
      key,
      values: {
        since: formatWhen(warning.since),
        reconciled: warning.reconciled,
        stations: warning.stations,
      },
    };
  }
  return { key };
}
```

6. Создать `apps/standalone/src/office/backups/BackupWarnings.tsx`:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { BackupState } from "../../host/backups.js";
import { backupWarnings, warningText, warningTone } from "./backup-warnings.js";

/** The warnings of `state`, one alert each; nothing when all is well. */
export function BackupWarnings({ state }: { state: BackupState }) {
  const { t } = useTranslation();
  return (
    <>
      {backupWarnings(state).map((warning) => {
        const text = warningText(warning);
        const values = {
          ...text.values,
          ...(text.reason === undefined ? {} : { reason: t(text.reason) }),
        };
        return (
          <Alert key={warning.kind} tone={warningTone(warning)}>
            {t(text.key, values)}
          </Alert>
        );
      })}
    </>
  );
}
```

7. Создать `apps/standalone/src/office/backups/SecondDirForm.tsx`:

<!-- prettier-ignore -->
```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input } from "@markiro/ui";

import { BACKUP_DIR_PROBLEMS, type BackupState } from "../../host/backups.js";
import { HostError } from "../../host/client.js";
import { plainTextRule } from "../../lib/rules.js";
import { alertFailure, useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/** The host's limit (`routes/backups.rs`): 1-260 characters, no control character. */
const secondDirSchema = z.object({
  secondDir: plainTextRule(260, "office.backups.secondDirRule"),
});
type SecondDirFields = z.infer<typeof secondDirSchema>;

const SECOND_DIR_FIELDS = {
  secondDir: { field: "secondDir", message: "office.backups.secondDirRule" },
} as const;

/** The text of a folder the host could not use (`details.reason` of a `backup_dir` conflict). */
function dirProblemKey(error: unknown): string | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "backup_dir") return null;
  const reason = BACKUP_DIR_PROBLEMS.find((problem) => problem === error.details.reason);
  return `office.backups.dirProblems.${reason ?? "unknown"}`;
}

export interface SecondDirFormProps {
  state: BackupState;
  onSaved: (state: BackupState) => void;
  onSubmitStart: () => void;
  onReload: () => void;
}

/**
 * The second folder of copies; administrators only. The host tries the
 * folder before it saves it, so a share that is off or a drive that is
 * unplugged is refused here, under the field.
 */
export function SecondDirForm({ state, onSaved, onSubmitStart, onReload }: SecondDirFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, secondDir: string | null) =>
    api.updateBackupSettings(token, { secondDir, expectedRev: state.settingsRev }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<SecondDirFields>({
    resolver: zodResolver(secondDirSchema),
    defaultValues: { secondDir: state.second?.dir ?? "" },
  });

  const save = async (secondDir: string | null) => {
    onSubmitStart();
    setFailure(null);
    let saved: BackupState;
    try {
      saved = await update.mutateAsync(secondDir);
    } catch (error) {
      const problem = dirProblemKey(error);
      if (problem !== null) {
        setError("secondDir", { type: "server", message: problem });
        return;
      }
      const outcome =
        secondDir === null ? alertFailure(error) : writeFailure(error, SECOND_DIR_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  };
  const submit = handleSubmit((fields) => save(fields.secondDir));

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        label={t("office.backups.secondDir")}
        hint={t("office.backups.secondDirHint")}
        mono
        {...fieldError(errors.secondDir?.message)}
        {...register("secondDir")}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
        {state.second !== null && (
          <Button
            variant="secondary"
            disabled={isSubmitting || update.isPending}
            onClick={() => void save(null)}
          >
            {t("office.backups.clearSecond")}
          </Button>
        )}
      </div>
    </form>
  );
}
```

8. Создать `apps/standalone/src/office/backups/BackupsPage.tsx`:

<!-- prettier-ignore -->
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DefinitionGrid,
  PageHeader,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type {
  BackupCopy,
  BackupDestination,
  BackupState,
  RestoreHold,
} from "../../host/backups.js";
import { HostError } from "../../host/client.js";
import { useCan } from "../access.js";
import { alertFailure, failureMessage, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { formatSize, formatWhen } from "./backup-format.js";
import { failureReason } from "./backup-warnings.js";
import { BackupWarnings } from "./BackupWarnings.js";
import { SecondDirForm } from "./SecondDirForm.js";

/** How often the page reads the state again while a copy runs. */
export const BACKUP_POLL_MS = 1000;

/**
 * «Резервные копии» (plan РК): the stations' facts a restore holds, both
 * folders, their last copy and attempt, the copies on the host, «Сделать
 * копию сейчас», the second folder and resuming the facts for
 * administrators, and how a copy is restored (by support, on the host).
 */
export function BackupsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.backups.title")} />
      <BackupsContent />
    </>
  );
}

function isRunningConflict(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "backup_running"
  );
}

function BackupsContent() {
  const { t } = useTranslation();
  const canManage = useCan("manageBackups");
  const queryClient = useQueryClient();
  // While a copy runs the page reads again every second, until it ends.
  const cached = queryClient.getQueryData<BackupState>(officeKeys.backups);
  const backups = useOfficeQuery(
    officeKeys.backups,
    (api, token) => api.getBackups(token),
    cached?.running ? { refetchInterval: BACKUP_POLL_MS } : {},
  );
  const start = useOfficeMutation<void, BackupState>((api, token) => api.startBackup(token));
  const [started, setStarted] = useState(false);
  const [startFailure, setStartFailure] = useState<AlertFailure | "running" | null>(null);
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (backups.isPending) return <PageLoading />;
  if (backups.isError) {
    return <LoadError error={backups.error} onRetry={() => void backups.refetch()} />;
  }
  const state = backups.data;
  const running = state.running !== null;
  const done = started && !running && state.local.lastAttempt?.ok === true;

  const copyNow = async () => {
    setStartFailure(null);
    setStarted(false);
    try {
      queryClient.setQueryData(officeKeys.backups, await start.mutateAsync());
      setStarted(true);
    } catch (error) {
      if (isRunningConflict(error)) {
        setStartFailure("running");
        void backups.refetch();
      } else {
        setStartFailure(alertFailure(error));
      }
    }
  };

  return (
    <>
      <BackupWarnings state={state} />
      {state.restoreHold !== null && (
        <RestoreHoldCard
          hold={state.restoreHold}
          canManage={canManage}
          onResumed={(next) => queryClient.setQueryData(officeKeys.backups, next)}
        />
      )}
      <Card title={t("office.backups.local")} titleAs="h2">
        {done && <Alert tone="ok">{t("office.backups.done")}</Alert>}
        {startFailure === "running" && (
          <Alert tone="info">{t("office.backups.alreadyRunning")}</Alert>
        )}
        {startFailure !== null && startFailure !== "running" && (
          <Alert tone="error">{t(failureMessage(startFailure))}</Alert>
        )}
        <Destination destination={state.local} />
        {canManage && (
          <div className="standalone-form__actions">
            <Button loading={running || start.isPending} onClick={() => void copyNow()}>
              {running ? t("office.backups.running") : t("office.backups.copyNow")}
            </Button>
          </div>
        )}
      </Card>
      <Card title={t("office.backups.second")} titleAs="h2">
        {savedRev === state.settingsRev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        {state.second === null ? (
          <p className="office-note">{t("office.backups.secondNotSet")}</p>
        ) : (
          <Destination destination={state.second} />
        )}
        {canManage ? (
          <SecondDirForm
            key={state.settingsRev}
            state={state}
            onSaved={(next) => {
              queryClient.setQueryData(officeKeys.backups, next);
              setSavedRev(next.settingsRev);
            }}
            onSubmitStart={() => setSavedRev(null)}
            onReload={() => void backups.refetch()}
          />
        ) : (
          <p className="office-note">{t("office.common.readOnly")}</p>
        )}
      </Card>
      <Card title={t("office.backups.copies")} titleAs="h2">
        <CopiesTable copies={state.local.copies} />
      </Card>
      <Card title={t("office.backups.restore.title")} titleAs="h2">
        <p>{t("office.backups.restore.who")}</p>
        <ol>
          <li>{t("office.backups.restore.stop")}</li>
          <li>{t("office.backups.restore.run")}</li>
          <li>{t("office.backups.restore.start")}</li>
        </ol>
        <p className="office-note">{t("office.backups.restore.after")}</p>
      </Card>
    </>
  );
}

type HoldStation = RestoreHold["stations"][number];

interface RestoreHoldCardProps {
  hold: RestoreHold;
  canManage: boolean;
  onResumed: (state: BackupState) => void;
}

/**
 * The stations after a restore: which gave their blocks back, and, for an
 * administrator, resuming the facts the host holds until then.
 */
function RestoreHoldCard({ hold, canManage, onResumed }: RestoreHoldCardProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const resume = useOfficeMutation<void, BackupState>((api, token) => api.resumeFacts(token));
  const waiting = hold.stations.filter((station) => !station.reconciled).length;
  const columns: TableColumn<HoldStation>[] = [
    { key: "name", title: t("office.backups.hold.station"), render: (station) => station.name },
    {
      key: "lastSeen",
      title: t("office.backups.hold.lastSeen"),
      render: (station) =>
        station.lastSeenAt === null ? t("office.common.none") : formatWhen(station.lastSeenAt),
    },
    {
      key: "blocks",
      title: t("office.backups.hold.blocks"),
      render: (station) =>
        t(station.reconciled ? "office.backups.hold.reconciled" : "office.backups.hold.waiting"),
    },
  ];
  const confirm = async () => {
    try {
      onResumed(await resume.mutateAsync());
    } catch (error) {
      setFailure(alertFailure(error));
    }
    setConfirming(false);
  };
  return (
    <Card title={t("office.backups.hold.title")} titleAs="h2">
      <p>{t("office.backups.hold.text", { since: formatWhen(hold.since) })}</p>
      <Table
        columns={columns}
        rows={hold.stations}
        getRowKey={(station) => station.id}
        empty={t("office.backups.hold.noStations")}
        scrollLabel={t("office.backups.hold.title")}
      />
      {failure !== null && <Alert tone="error">{t(failureMessage(failure))}</Alert>}
      {canManage && (
        <div className="standalone-form__actions">
          <Button
            onClick={() => {
              setFailure(null);
              setConfirming(true);
            }}
          >
            {t("office.backups.hold.resume")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("office.backups.hold.confirmTitle")}
        description={
          waiting === 0
            ? t("office.backups.hold.confirmAll")
            : t("office.backups.hold.confirmWaiting", {
                waiting,
                stations: hold.stations.length,
              })
        }
        confirmLabel={t("office.backups.hold.resume")}
        cancelLabel={t("office.common.cancel")}
        busy={resume.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      />
    </Card>
  );
}

function Destination({ destination }: { destination: BackupDestination }) {
  const { t } = useTranslation();
  const newest = destination.copies[0];
  const attempt = destination.lastAttempt;
  let attemptText = t("office.backups.notTried");
  if (attempt !== null) {
    attemptText = attempt.ok
      ? t("office.backups.attemptOk", { when: formatWhen(attempt.at) })
      : t("office.backups.attemptFailed", {
          when: formatWhen(attempt.at),
          reason: t(`office.backups.failures.${failureReason(attempt.code)}`),
        });
  }
  return (
    <DefinitionGrid
      items={[
        { id: "dir", term: t("office.backups.dir"), description: destination.dir, mono: true },
        {
          id: "last-copy",
          term: t("office.backups.lastCopy"),
          description:
            newest === undefined
              ? t("office.common.none")
              : t("office.backups.copyOf", {
                  when: formatWhen(newest.createdAt),
                  size: formatSize(newest.sizeBytes),
                }),
        },
        { id: "last-attempt", term: t("office.backups.lastAttempt"), description: attemptText },
      ]}
    />
  );
}

function CopiesTable({ copies }: { copies: BackupCopy[] }) {
  const { t } = useTranslation();
  const columns: TableColumn<BackupCopy>[] = [
    {
      key: "createdAt",
      title: t("office.backups.table.createdAt"),
      render: (copy) => formatWhen(copy.createdAt),
    },
    {
      key: "trigger",
      title: t("office.backups.table.trigger"),
      render: (copy) => t(`office.backups.triggers.${copy.trigger}`),
    },
    {
      key: "size",
      title: t("office.backups.table.size"),
      align: "right",
      mono: true,
      render: (copy) => formatSize(copy.sizeBytes),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={copies}
      getRowKey={(copy) => copy.file}
      empty={t("office.backups.noCopiesYet")}
      scrollLabel={t("office.backups.copies")}
    />
  );
}
```

9. В `apps/standalone/src/office/OfficeOverview.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { Card, PageHeader } from "@markiro/ui";

import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
```

заменить на

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Card, PageHeader } from "@markiro/ui";

import { backupWarnings } from "./backups/backup-warnings.js";
import { BackupWarnings } from "./backups/BackupWarnings.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";
import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
```

10. В `apps/standalone/src/office/OfficeOverview.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader title={t("office.overview.title")} />
      <Card>
        <p>{t("office.overview.greeting", { name: user.name })}</p>
        <p>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</p>
```

заменить на

<!-- prettier-ignore -->
```tsx
  return (
    <>
      <PageHeader title={t("office.overview.title")} />
      <OverviewBackups />
      <Card>
        <p>{t("office.overview.greeting", { name: user.name })}</p>
        <p>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</p>
```

11. В `apps/standalone/src/office/OfficeOverview.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    </>
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
    </>
  );
}

/**
 * The backup warnings where the office opens (plan РК: a failed copy is
 * visible, not a line in a log). Nothing while the state loads or when it
 * does not: «Резервные копии» explains a host that does not answer.
 */
function OverviewBackups() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  if (!backups.isSuccess || backupWarnings(backups.data).length === 0) return null;
  return (
    <section aria-label={t("office.backups.title")} className="standalone-form">
      <BackupWarnings state={backups.data} />
      <Link to="/backups">{t("office.backups.overviewLink")}</Link>
    </section>
  );
}
```

12. В `apps/standalone/src/office/access.ts` фрагмент

<!-- prettier-ignore -->
```ts
  editReference: ["admin"],
  /** The catalog, label templates and their defaults (plan 1e). */
  editCatalog: ["admin", "technologist"],
} as const satisfies Record<string, readonly OfficeRole[]>;

export type OfficeCapability = keyof typeof CAPABILITIES;
```

заменить на

<!-- prettier-ignore -->
```ts
  editReference: ["admin"],
  /** The catalog, label templates and their defaults (plan 1e). */
  editCatalog: ["admin", "technologist"],
  /** «Сделать копию сейчас» and the second folder of copies (plan РК); every role reads them. */
  manageBackups: ["admin"],
} as const satisfies Record<string, readonly OfficeRole[]>;

export type OfficeCapability = keyof typeof CAPABILITIES;
```

13. В `apps/standalone/src/office/nav.ts` фрагмент

<!-- prettier-ignore -->
```ts
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
];
```

заменить на

<!-- prettier-ignore -->
```ts
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
  {
    to: "/backups",
    labelKey: "office.nav.backups",
    sectionKey: "office.nav.sections.service",
    roles: ["admin", "technologist"],
  },
];
```

14. В `apps/standalone/src/office/office-query.ts` фрагмент

<!-- prettier-ignore -->
```ts
  products: ["office", "products"],
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

заменить на

<!-- prettier-ignore -->
```ts
  products: ["office", "products"],
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
```

15. В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { RouteObject } from "react-router";

import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { LinesPage } from "./lines/LinesPage.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { RouteObject } from "react-router";

import { BackupsPage } from "./backups/BackupsPage.js";
import { CounterpartiesPage } from "./counterparties/CounterpartiesPage.js";
import { DevicesPage } from "./devices/DevicesPage.js";
import { LinesPage } from "./lines/LinesPage.js";
```

16. В `apps/standalone/src/office/routes.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          </RequireRole>
        ),
      },
    ],
  },
];
```

заменить на

<!-- prettier-ignore -->
```tsx
          </RequireRole>
        ),
      },
      { path: "backups", element: <BackupsPage /> },
    ],
  },
];
```

17. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "organization": "Организация",
        "production": "Производство",
        "catalog": "Каталог",
        "access": "Доступ"
      },
      "overview": "Обзор",
      "orgProfile": "Профиль",
```

заменить на

<!-- prettier-ignore -->
```json
        "organization": "Организация",
        "production": "Производство",
        "catalog": "Каталог",
        "access": "Доступ",
        "service": "Сервис"
      },
      "overview": "Обзор",
      "orgProfile": "Профиль",
```

18. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "products": "Товары",
      "templates": "Шаблоны",
      "templateDefaults": "Умолчания шаблонов",
      "users": "Пользователи"
    },
    "common": {
      "loading": "Загрузка…",
```

заменить на

<!-- prettier-ignore -->
```json
      "products": "Товары",
      "templates": "Шаблоны",
      "templateDefaults": "Умолчания шаблонов",
      "users": "Пользователи",
      "backups": "Резервные копии"
    },
    "backups": {
      "title": "Резервные копии",
      "local": "Папка на компьютере хоста",
      "second": "Вторая папка",
      "secondNotSet": "Вторая папка не задана.",
      "dir": "Папка",
      "lastCopy": "Последняя проверенная копия",
      "lastAttempt": "Последняя попытка",
      "copyOf": "{{when}}, {{size}}",
      "attemptOk": "{{when}}: успешно",
      "attemptFailed": "{{when}}: не удалась — {{reason}}",
      "notTried": "Ещё не было",
      "copyNow": "Сделать копию сейчас",
      "running": "Копия делается…",
      "done": "Копия сделана и проверена.",
      "alreadyRunning": "Копия уже делается — дождитесь её.",
      "copies": "Копии на компьютере хоста",
      "noCopiesYet": "Копий пока нет",
      "table": {
        "createdAt": "Сделана",
        "trigger": "Как",
        "size": "Размер"
      },
      "triggers": {
        "scheduled": "По расписанию",
        "manual": "Вручную"
      },
      "secondDir": "Путь ко второй папке",
      "secondDirHint": "Общая папка на другом компьютере — полным сетевым путём (\\\\ПК-АДМИНИСТРАТОРА\\Копии), не буквой сетевого диска; или папка на флешке (E:\\Markiro). Хост проверит её перед сохранением.",
      "secondDirRule": "Укажите полный путь к папке, до 260 символов",
      "clearSecond": "Не копировать во вторую папку",
      "failures": {
        "destination_unavailable": "папка недоступна",
        "access_denied": "у службы хоста нет прав на запись",
        "disk_full": "диск заполнен",
        "write_failed": "ошибка записи",
        "verify_failed": "копия не прошла проверку и удалена",
        "local_copy_failed": "копия на компьютере хоста не сделана",
        "internal": "внутренняя ошибка хоста",
        "unknown": "неизвестная ошибка"
      },
      "dirProblems": {
        "missing": "Папка не найдена. Проверьте путь и что компьютер или флешка подключены.",
        "not_a_directory": "Это файл, а не папка.",
        "access_denied": "У службы хоста нет прав на запись в эту папку.",
        "unwritable": "В эту папку не удаётся записать файл.",
        "timeout": "Папка не ответила за 8 секунд. Проверьте, что компьютер с ней включён.",
        "inside_data_dir": "Это папка с данными хоста: копия там пропадёт вместе с данными.",
        "unknown": "Хост не может делать копии в эту папку."
      },
      "warnings": {
        "localFailed": "Последняя копия на компьютере хоста не удалась: {{reason}}.",
        "secondFailed": "Последняя копия во вторую папку не удалась: {{reason}}.",
        "noCopies": "Проверенных копий ещё нет.",
        "stale": "Последней проверенной копии больше суток.",
        "noSecond": "Вторая папка не задана: если сломается компьютер хоста, копий не останется.",
        "secondStale": "Во второй папке нет проверенной копии за последние сутки.",
        "stuck": "Копия делается дольше 30 минут: проверьте вторую папку и место на диске.",
        "held": "Хост восстановлен из копии {{since}} и не принимает данные станций. Блоки вернули станций: {{reconciled}} из {{stations}}."
      },
      "hold": {
        "title": "Приём данных станций остановлен",
        "text": "Хост восстановлен из копии {{since}}. Станции продолжают работу и копят данные у себя; хост примет их, когда администратор возобновит приём. Сначала каждая станция должна вернуть свои блоки SSCC — она делает это сама, когда подключается к хосту.",
        "station": "Станция",
        "lastSeen": "Была на связи",
        "blocks": "Блоки SSCC",
        "reconciled": "Вернула",
        "waiting": "Ещё нет",
        "noStations": "Подключённых станций нет",
        "resume": "Возобновить приём данных станций",
        "confirmTitle": "Возобновить приём данных станций?",
        "confirmAll": "Все станции вернули блоки. Хост начнёт принимать их данные.",
        "confirmWaiting": "Блоки вернули не все станции ({{waiting}} из {{stations}} ещё нет). Данные этих станций по блокам, выданным после копии, хост отклонит, и разбирать их придётся поддержке."
      },
      "overviewLink": "Открыть «Резервные копии»",
      "restore": {
        "title": "Восстановление",
        "who": "Копию возвращает поддержка, на компьютере хоста:",
        "stop": "остановить службу: sc stop MarkiroHost;",
        "run": "выполнить markiro-host restore <файл копии .db> (файл .json с тем же именем — рядом);",
        "start": "запустить службу: sc start MarkiroHost.",
        "after": "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом, а станции заново передают свои блоки SSCC."
      }
    },
    "common": {
      "loading": "Загрузка…",
```

- [ ] **Step 4: Запустить — PASS**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts test/backups-page.test.tsx test/office.test.tsx test/errors.test.ts`
Expected: PASS — 4 файла

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`
Expected: PASS — без вывода

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint`
Expected: PASS — без вывода

- [ ] **Step 5: Мутации**

Каждая — по правилу «Мутации» из «Заметок для исполнения».

М1 — копия ровно 26-часовой давности — устаревшая. В `apps/standalone/src/office/backups/backup-warnings.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return newest !== undefined && now - Date.parse(newest.createdAt) > STALE_AFTER_MS;
```

заменить на

<!-- prettier-ignore -->
```ts
  return newest !== undefined && now - Date.parse(newest.createdAt) >= STALE_AFTER_MS;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts`
Expected: FAIL — `warns of no copy, a copy older than 26 hours and no second folder`

М2 — нет предупреждения без второй папки. В `apps/standalone/src/office/backups/backup-warnings.ts` фрагмент

<!-- prettier-ignore -->
```ts
    warnings.push({ kind: "noSecond" });
```

заменить на

<!-- prettier-ignore -->
```ts
    void 0;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts`
Expected: FAIL — `puts the facts a restore holds first, with how many stations gave their blocks back`, `warns of no copy, a copy older than 26 hours and no second folder`

М3 — отказ папки не виден под полем. В `apps/standalone/src/office/backups/SecondDirForm.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      if (problem !== null) {
```

заменить на

<!-- prettier-ignore -->
```tsx
      if (problem === "never") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `saves the second folder, and shows why the host refused one`

М4 — страница не следит за идущей копией. В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    cached?.running ? { refetchInterval: BACKUP_POLL_MS } : {},
```

заменить на

<!-- prettier-ignore -->
```tsx
    {},
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `makes a copy now and follows it until it is made`

М5 — «Обзор» ничего не показывает. В `apps/standalone/src/office/OfficeOverview.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  if (!backups.isSuccess || backupWarnings(backups.data).length === 0) return null;
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (!backups.isSuccess || backupWarnings(backups.data).length >= 0) return null;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `warns on «Обзор» and leads to the page`

М6 — возобновление без подтверждения. В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
              setConfirming(true);
```

заменить на

<!-- prettier-ignore -->
```tsx
              void confirm();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `shows the stations a restore waits for, and an administrator resumes the facts`

М7 — удержание не ошибка. В `apps/standalone/src/office/backups/backup-warnings.ts` фрагмент

<!-- prettier-ignore -->
```ts
  return warning.kind === "held" ||
```

заменить на

<!-- prettier-ignore -->
```ts
  return warning.kind === "stuck" ||
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backup-warnings.test.ts`
Expected: FAIL — `puts the facts a restore holds first, with how many stations gave their blocks back`, `warns of a copy running for more than half an hour`

М8 — технолог может делать копии. В `apps/standalone/src/office/access.ts` фрагмент

<!-- prettier-ignore -->
```ts
  manageBackups: ["admin"],
```

заменить на

<!-- prettier-ignore -->
```ts
  manageBackups: ["admin", "technologist"],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `shows a technologist both folders, the failed copy and how to restore, with no controls`, `shows a technologist the hold with no way to resume`

М9 — «Не копировать во вторую папку» шлёт прежний путь. В `apps/standalone/src/office/backups/SecondDirForm.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            onClick={() => void save(null)}
```

заменить на

<!-- prettier-ignore -->
```tsx
            onClick={() => void save(state.second?.dir ?? null)}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`
Expected: FAIL — `stops copying into the second folder`

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check apps/standalone/test/support/backups.ts apps/standalone/test/support/office.tsx apps/standalone/test/backup-warnings.test.ts apps/standalone/test/backups-page.test.tsx apps/standalone/src/host/api.ts apps/standalone/src/office/backups/backup-format.ts apps/standalone/src/office/backups/backup-warnings.ts apps/standalone/src/office/backups/BackupWarnings.tsx apps/standalone/src/office/backups/SecondDirForm.tsx apps/standalone/src/office/backups/BackupsPage.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/access.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json
git diff --check
git add apps/standalone/test/support/backups.ts apps/standalone/test/support/office.tsx apps/standalone/test/backup-warnings.test.ts apps/standalone/test/backups-page.test.tsx apps/standalone/src/host/api.ts apps/standalone/src/office/backups/backup-format.ts apps/standalone/src/office/backups/backup-warnings.ts apps/standalone/src/office/backups/BackupWarnings.tsx apps/standalone/src/office/backups/SecondDirForm.tsx apps/standalone/src/office/backups/BackupsPage.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/access.ts apps/standalone/src/office/nav.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/routes.tsx apps/standalone/src/i18n/ru.json
git commit -F - <<'EOF'
feat(standalone): «Резервные копии» in the office and the warnings on «Обзор»

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Памятка «Резервные копии и восстановление», `AGENTS.md`, уточнения спецификации пилота, итоговые проверки

Памятка — для нашего инженера и ИТ клиента: что хост делает сам, вторая папка и учётная запись службы, еженедельная флешка, восстановление на том же и на новом ПК (с удержанием фактов и возобновлением), что проверяется только на Windows. `AGENTS.md` получает раздел «Backups and restore» и действия журнала; раздел 11 спецификации пилота — уточнения плана. Это последняя задача: тексты опираются на имена задач 1–7.

**Files:**

- Create: `docs/runbooks/standalone-backup-restore.md`
- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

**Interfaces:**

- Consumes: всё выше.
- Produces: `docs/runbooks/standalone-backup-restore.md`, раздел `AGENTS.md` «Backups and restore», «Уточнения плана РК» в спецификации пилота.

- [ ] **Step 1: Реализация**

1. Создать `docs/runbooks/standalone-backup-restore.md`:

<!-- prettier-ignore -->
```md
# Резервные копии и восстановление «Markiro Автоном»

Памятка к плану РК (`docs/superpowers/plans/2026-10-09-standalone-rk-backups.md`) и разделу 11
спецификации пилота (`docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`). Настройку
второй папки делает наш инженер вместе с ИТ клиента; восстановление — только наш инженер.

Копия содержит всё, что знает хост: хеши паролей, PIN и бейджей, соль бейджей, хеши ключей устройств.
Папки копий доступны только службе хоста и администраторам ПК; копии не пересылают почтой и
мессенджерами.

## 1. Что делает хост сам

- **Папка на ПК хоста:** `%ProgramData%\Markiro\Host\backups` (каталог данных хоста + `backups`).
- **Расписание:**
  - не больше одной копии в час (по UTC), в первую минуту часа, в котором база изменилась после
    прошлой удачной копии;
  - хотя бы одна копия за сутки (по UTC), даже если база не менялась;
  - копия при каждом запуске службы;
  - «Сделать копию сейчас» в офисе («Сервис → Резервные копии», только администратор).
- **Проверка:** каждая копия проверяется `PRAGMA integrity_check`, рядом пишется манифест
  `<имя>.json` с размером и SHA-256. Копия без манифеста — не копия: хост удалит её при следующем
  запуске копирования.
- **Хранение:** в каждой папке — 24 последние копии, последняя копия каждого из 14 последних дней и
  каждого из 12 последних месяцев (дни и месяцы по UTC). Хост трогает только файлы, имя которых
  начинается с `markiro-host-`.
- **Вторая папка:** после проверенной локальной копии хост копирует её туда, читает обратно и
  сверяет SHA-256 с манифестом. Сам хост папку не создаёт: недоступная папка — ошибка, а не новая
  папка в другом месте.
- **Сбои** видны на странице «Резервные копии» и на «Обзоре» офиса: приём данных станций
  остановлен после восстановления, неудачная последняя попытка в любой папке, нет копий, последней
  копии больше 26 часов, вторая папка не задана, копия идёт дольше 30 минут. Каждая копия пишет строку журнала действий `backup.create` (`failed`, если хоть одна
  папка её не получила).

## 2. Вторая папка (вопрос П14: общая папка на ПК, где не стоит хост, плюс флешка раз в неделю)

Хост работает службой Windows `MarkiroHost`, поэтому:

- **Путь — только полный сетевой (`\\ПК-АДМИНИСТРАТОРА\MarkiroCopies`), не буква сетевого диска.**
  Служба не видит дисков, подключённых пользователем.
- **Права.** Служба обращается к общей папке от имени своей учётной записи:
  - `LocalService` в сети выступает анонимно, `NetworkService` и `LocalSystem` — учётной записью
    компьютера, которой в рабочей группе без домена нет. Запись в общую папку на другом ПК от их
    имени в рабочей группе не пройдёт (`access_denied` в офисе).
  - **Рекомендуемый способ для рабочей группы:** локальная учётная запись `markiro-backup` с одним и
    тем же паролем на обоих ПК; служба `MarkiroHost` запускается от её имени
    (`sc config MarkiroHost obj= .\markiro-backup password= <пароль>`, право «Вход в качестве
    службы»), у неё есть права на каталог данных хоста, а общая папка на ПК администратора даёт ей
    право «Изменение». Это решение ИТ клиента и плана УСТ (учётная запись службы); пароль в журналы
    и задачи не попадает.
  - **В домене:** общая папка даёт право «Изменение» учётной записи компьютера хоста (`ДОМЕН\ПК$`)
    при службе от `NetworkService`.
- **Настройка:**
  1. На ПК администратора создать папку (например, `D:\MarkiroCopies`), открыть к ней общий доступ
     и выдать права, как выше.
  2. В офисе на странице «Резервные копии» ввести путь второй папки и нажать «Сохранить». Хост
     создаст и удалит в ней пробный файл; если не может — покажет причину под полем (не найдена, нет
     прав, не ответила за 8 секунд, это папка с данными хоста).
  3. Нажать «Сделать копию сейчас» и дождаться «Копия сделана и проверена»; в карточке «Вторая
     папка» — последняя попытка «успешно».
- **Флешка раз в неделю** (вручную):
  1. Вставить флешку в ПК хоста или в ПК со второй папкой.
  2. Скопировать на неё самую свежую пару файлов `markiro-host-…db` и `markiro-host-…json`.
  3. Проверить копию на флешке на ПК хоста:
     `markiro-host verify-copy E:\markiro-host-20261009T140000Z-7c1e2a9b.db` — ответ
     `…: ok (… bytes, sha256 …, migration …, made …)`. На ПК без `markiro-host` —
     `Get-FileHash -Algorithm SHA256 <файл .db>` и сравнить с полем `sha256` в файле `.json`.
  4. Хранить флешку вне цеха; держать две флешки и чередовать их.
- Флешку можно задать и второй папкой (`E:\Markiro`), если ПК со второй папкой нет; тогда копии
  идут на неё каждый час, пока она вставлена, а без неё офис показывает «папка недоступна».

## 3. Еженедельная проверка

1. Открыть «Резервные копии»: предупреждений нет, последняя проверенная копия в обеих папках не
   старше часа (в рабочее время) или суток.
2. Сделать копию на флешку и проверить её (раздел 2).
3. Раз в месяц — учебное восстановление на другом ПК (раздел 6) из копии с флешки.

## 4. Когда восстанавливать

- База хоста испорчена (хост не запускается, в журнале процесса ошибка SQLite «malformed»).
- ПК хоста заменён (диск умер, ПК украден).
- Данные испорчены по ошибке, и исправить их в офисе нельзя.

Копия старше 30 дней опасна: станции хранят подтверждённые факты 30 дней (решение 31 этапа 2a), и
факты между копией и началом этого окна не вернутся. Берите самую свежую проверенную копию.

## 5. Восстановление на том же ПК

Выполняется в консоли администратора на ПК хоста; `markiro-host.exe` — из каталога установки.

1. Записать, что делается на линии: идущая смена, номер последнего короба. Станция продолжает
   работать без хоста, пока он остановлен.
2. Выбрать копию: самую свежую из `%ProgramData%\Markiro\Host\backups`, из второй папки или с
   флешки; рядом с ней должен лежать её `.json`.
3. Проверить её: `markiro-host verify-copy <копия.db>`.
4. Остановить службу: `sc stop MarkiroHost`. Восстановление откажется работать при запущенной
   службе («another markiro-host is using this data directory»).
5. Восстановить: `markiro-host restore <копия.db> --data-dir "%ProgramData%\Markiro\Host"`.
   Без манифеста — только с `--without-manifest` (проверяется лишь целостность). Ответ команды
   сохранить в задачу поддержки: какая копия, куда сохранена текущая база
   (`restore-<время>` в каталоге данных), как подняты счётчики SSCC (`SSCC 460068200/0: 3500 ->
9500`) и номера смен, новая эпоха.
6. Запустить службу: `sc start MarkiroHost`. Хост держит приём данных станций: факты и проверки
   кодов он не принимает (`restore_pending`), станции копят их у себя.
7. Дождаться, пока каждая станция вернёт блоки SSCC: страница «Резервные копии», карточка «Приём
   данных станций остановлен», столбец «Блоки SSCC» — «Вернула». Станция делает это сама при
   подключении (после плана РК-С, который пишется после 2a5 и 2a6); до него станции этого не умеют — см. шаг 9.
8. Проверить в офисе:
   - «SSCC»: счётчик коробов выше номера последнего напечатанного короба (с этикетки или из
     выгрузки). Если копия старше суток и станция успела напечатать больше двух блоков после неё,
     поднять счётчик вручную выше последнего напечатанного номера.
   - «Смены»: смены, созданные или открытые после копии, хост не знает. Идущую смену станция
     досылает, когда научится (план РК-С); до этого — закрыть смену на станции нельзя, её закрывают в
     офисе с причиной, новые короба — в новой смене (сокращение 8 раздела 13 спецификации пилота).
   - Всё, что изменили в офисе после копии, пропало: операторы, бейджи, товары, шаблоны, линии,
     пользователи офиса, вторая папка. Повторить эти изменения; устройство, отозванное после копии,
     отозвать снова.
   - Устройства, подключённые после копии, хост не знает: на них «Подключить заново» и новый код.
9. Возобновить приём: «Возобновить приём данных станций» (только администратор). Если не все
   станции вернули блоки, офис предупредит: их факты по блокам, выданным после копии, хост
   отклонит (`sscc_not_issued`), как и факты смен, открытых или созданных после копии
   (`unknown_shift`, `not_entered`); такие записи остаются на станции для разбора. Станцию на
   сломанном ПК не ждать.
10. Если восстановление нужно отменить: остановить службу, удалить `host.db`, `host.db-wal` и
    `host.db-shm` в каталоге данных и перенести на их место файлы из `restore-<время>`, запустить
    службу. Счётчики при этом вернутся к значениям текущей базы, а они не ниже настоящих.

Если команда `restore` упала после переноса текущей базы, она сама вернула её на место; каталога
`restore-<время>` тогда нет.

## 6. Восстановление на новом ПК

1. Установить «Markiro Автоном» с ролью хоста (план УСТ), не проходить мастер.
2. Остановить службу: `sc stop MarkiroHost`.
3. Восстановить копию со второй папки или флешки, как в разделе 5, шаги 3–9. Если каталог данных
   новый и пустой, текущей базы нет («there was no previous database»): счётчики поднимаются на два
   блока над копией.
4. У хоста новый сертификат и новый `hostId`: каждое устройство подключается заново по коду из
   офиса («Устройства → Новый код»), офис на ПК администратора — тоже.
5. Проверить счётчик SSCC коробов, как в разделе 5, шаг 8: если копия старше суток, поднять его
   вручную выше последнего напечатанного номера.

## 7. Что проверяется только на Windows

- Служба под выбранной учётной записью пишет в общую папку на другом ПК рабочей группы; её отказ
  виден в офисе как «нет прав на запись».
- Путь `\\ПК\Папка` с кириллицей, буква флешки после повторного подключения, флешка, вынутая
  посреди копии (`.partial` остаётся и удаляется следующим запуском).
- Полный диск (`disk_full`) и общая папка выключенного ПК (ответ за 8 секунд при сохранении, в
  копировании — сколько ждёт Windows).
- `sc stop`/`sc start`, `markiro-host restore` из консоли администратора, права службы на
  восстановленные файлы (наследуются от каталога данных).
- Учебное восстановление на испытаниях: хост из часовой копии, станция досылает, повторных SSCC
  нет — после плана РК-С.
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```md
because it may be 256 KB. A station's writes (shift create and open, SSCC
blocks) carry the device as the actor (`Actor::Device`), and a request a
station repeats (a create, a re-entry, a block) writes no row.
Details never hold pairing codes, keys, tokens, passwords, salts or hashes, and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
```

заменить на

<!-- prettier-ignore -->
```md
because it may be 256 KB. A station's writes (shift create and open, SSCC
blocks) carry the device as the actor (`Actor::Device`), and a request a
station repeats (a create, a re-entry, a block) writes no row.
Backups (plan РК) write `backup.create` (the host or the office user who asked;
`failed` when a folder did not get the copy), `backup.settings.update`,
`host.restore` (the host), `host.restore.resume` and `sscc.block.register`
(the station).
Details never hold pairing codes, keys, tokens, passwords, salts or hashes, and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```md
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

заменить на

<!-- prettier-ignore -->
```md
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b.

## Backups and restore

Plan РК (`docs/superpowers/plans/2026-10-09-standalone-rk-backups.md`, the
pilot spec's §11; the procedure is
`docs/runbooks/standalone-backup-restore.md`). One worker task
(`backup/worker.rs`, started by `crate::start`) makes every copy of the
master database, one at a time, on a connection of its own:

- a copy is `VACUUM INTO <name>.db.partial` while the host runs (a reader:
  it waits for no writer and holds no uncommitted change), then
  `PRAGMA integrity_check` on that file opened read-only and immutable, its
  size and SHA-256, the rename to `markiro-host-<UTC time>-<tag>.db` and a
  manifest `<name>.json` beside it (`backup/copy.rs`); a failure leaves
  nothing of the copy behind;
- scheduled: at most one copy per UTC hour, in the first minute of an hour
  in which the database changed since the last good copy
  (`PRAGMA data_version` of the worker's connection, which the worker's own
  audit row does not move) or in which today (UTC) has no copy yet;
  «Сделать копию сейчас» wakes the worker at once. One attempt per hour: a
  failed hour is not retried before the next;
- the local folder is `<data dir>/backups`; the second folder is the office
  setting `backup_settings.second_dir` (`0011`). A copy reaches the second
  folder only after the local one checked out: copied as `.partial`, synced,
  read back and compared with the manifest by size and SHA-256, then renamed;
  the host never creates the second folder, so an unplugged drive or a share
  that is off is `destination_unavailable`, not a new folder somewhere;
- each folder keeps the newest 24 copies, the newest copy of each of the 14
  newest days and of each of the 12 newest months (UTC; `backup/retention.rs`),
  and loses only names that start with `markiro-host-`; a `.partial` file and
  a `.db` without its manifest are leftovers of a broken copy and go at the
  next run;
- a run's outcome per folder is in memory (`Backups::state`, the office's
  `GET /v1/office/backups`) and in one `backup.create` audit row (the host as
  the actor for a scheduled copy, the office user for a manual one; `failed`
  when any folder did not get the copy; `details` hold the failure codes,
  never an error text). A run is a task of its own, so a panic is that run's
  `internal` failure and the worker goes on; a host that stops waits up to
  10 s for a copy in progress.

The office (`routes/backups.rs`): every role reads the state; administrators
ask for a copy (`202`, `conflict` on `backup_running` while one runs or
waits; the request itself writes no audit row, the worker's run does) and
set or clear the second folder with `expectedRev`. A folder is tried before
it is saved, off the async threads and for at most 8 s: missing, not a
folder, no right to write, unwritable, timed out, or inside the data folder
is a `conflict` on `backup_dir` with `details.reason`; a path that is not
absolute is `validation_failed`. A service sees no mapped drive letters, so
a share is named by its UNC path. «Резервные копии» shows both folders and
the copies on the host; «Обзор» repeats the warnings (a failed copy, no copy,
a newest copy older than 26 hours by the host's clock, no second folder, a
copy running for more than 30 minutes).

`markiro-host restore <copy> [--data-dir] [--without-manifest]` runs with the
service stopped (the data folder's lock says so) and changes nothing until
the copy checked out: the manifest's size and SHA-256, `integrity_check`,
every migration known to this build with its checksum, a finished wizard.
It reads the current database read-only if it opens (a WAL a stopped host
left counts too; a `-wal` or `-shm` that reading created is removed again),
moves it aside into `restore-<UTC time>/`, puts the copy in place, migrates
it, and in one transaction on one connection (closed before the restore
returns, so no connection writes beside a database that is moved back)
raises every SSCC counter to two blocks of its extension above the highest
serial either database knew (never past the prefix's last serial), every
month's shift number by 10 above both, from the copy's month to the current
one, sets a new `site.restore_epoch`, holds the stations' facts
(`site.facts_held_since`) and writes one `host.restore` audit row (the host
as the actor). Any failure after the move puts the current database back. A data folder without `host.json` gets a new identity: every
device pairs again. `markiro-host verify-copy` runs the same checks.

`hello` names `restoreEpoch` once there was a restore. A station that sees it
change sends every block it holds to `POST /v1/device/sscc/blocks/known`
(`routes/known_blocks.rs`): a block the host has is `known`, or `refused`
`block_mismatch` if it differs; a lost one is `registered` under the station
with its own id as the request id and moves its counter forward, unless it
names no counter (`prefix_unknown`), is no range of its prefix
(`range_invalid`) or shares a serial with any block, revoked ones included
(`block_overlap`). One revision when anything was registered, one
`sscc.block.register` row per block; the station is marked for the epoch
(`devices.known_blocks_epoch`) whatever became of each block. Only a station,
only after a restore (`conflict` on `no_restore`), 1-64 blocks.

A receipt is kept for good (plan 2a2), and a copy may lack the shift, the
participant row or the block a station's fact names. So from a restore until
an administrator resumes (`POST /v1/office/backups/resume`, «Возобновить
приём данных станций»), a layer over the whole router answers
`POST /v1/device/facts` and `GET /v1/device/codes/{…}` with
`restore_pending` (503, `details.since`) before any route or device check,
and a station sends them again later; blocks, shifts and the feed are not
held. The office lists every unrevoked station and whether it sent its
blocks back; resuming is the administrator's call (a station on a dead
computer never will) and writes one `host.restore.resume` row with how many
did. The station's side — reacting to the epoch, a feed from zero, sending
the blocks and then the facts — is plan РК-С's, written after plans 2a5
and 2a6 (plan 2a6 leaves it to plan РК); shifts a station opened or
created after the copy have no re-registration yet (their facts are refused
once the facts resume: `unknown_shift`, `not_entered`).

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
```

4. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```md
  - Без этого шага факты `box_closed` с номерами, выданными после копии, получили бы
    `sscc_not_issued`.

## 12. Планы, зависимости, расписание

### 12.1. Состояние на вечер 2026-10-09
```

заменить на

<!-- prettier-ignore -->
```md
  - Без этого шага факты `box_closed` с номерами, выданными после копии, получили бы
    `sscc_not_issued`.

**Уточнения плана РК** (`docs/superpowers/plans/2026-10-09-standalone-rk-backups.md`):

- «Ежечасно во время работы» — не больше одной копии в час (UTC), в первую минуту часа, в котором
  база изменилась после прошлой удачной копии; «ежесуточно» — хотя бы одна копия за сутки (UTC).
  24, 14 и 12 копий выбираются из одного потока копий.
- Копия — `VACUUM INTO` с манифестом (размер, SHA-256); во вторую папку попадает только проверенная
  копия, сверенная по SHA-256 после записи. Путь второй папки — сетевой (UNC), учётная запись службы
  должна иметь право записи (памятка, раздел 2).
- Восстановление поднимает счётчики над обеими базами, восстановленной и текущей, если текущая
  читается. Повторная регистрация блоков отказывает, пока восстановления не было (`no_restore`).
  Сторона станции (эпоха, лента с нуля, отправка блоков, затем фактов) — малый план РК-С после
  исполнения 2a5 и 2a6.
- Квитанция хранится бессрочно (2a2), поэтому от восстановления до решения администратора хост
  отвечает на факты и проверки кодов станций `restore_pending` (503), а не квитанциями; станция
  досылает их позже. Администратор видит, какие станции вернули блоки, и возобновляет приём на
  странице «Резервные копии». Повторной регистрации смен после восстановления пока нет.

## 12. Планы, зависимости, расписание

### 12.1. Состояние на вечер 2026-10-09
```

- [ ] **Step 2: Коммит**

```bash
node_modules/.bin/prettier --check docs/runbooks/standalone-backup-restore.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git diff --check
git add docs/runbooks/standalone-backup-restore.md apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -F - <<'EOF'
docs(standalone): the backup and restore runbook, AGENTS «Backups and restore», the pilot spec takes plan РК's refinements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Итоговая проверка плана

- [ ] `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — без вывода.
- [ ] `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto` (вне песочницы) — 44 итоговые строки `test result`, 477 тестов, 0 failed (к базовым числам ветки на момент исполнения прибавляется 10 строк и 67 тестов).
- [ ] `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone...'`, затем `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace` (вне песочницы) — без отказов: оболочка `src-tauri` компилируется с новым полем `Hello::restore_epoch`, её тесты не меняются.
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run` — 70 файлов, 1766 тестов, без отказов (без параллельной нагрузки: под нагрузкой тесты редактора шаблонов падают по тайм-ауту и без этого плана).
- [ ] `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint` — без вывода.
- [ ] `node_modules/.bin/prettier --check` по всем изменённым файлам и `git diff --check` — чисто; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*`, `apps/api`, `src-tauri` и миграции `0001`–`0010` не менялись.
- [ ] Каждый из 8 коммитов несёт ровно одну строку `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- [ ] Не проверено автоматически и названо в отчёте отдельно (раздел 7 памятки): служба Windows и запись под её учётной записью в общую папку другого ПК, UNC-пути и их тайм-ауты, флешка (буква, извлечение посреди копии), коды ошибок Windows, настоящий полный диск, `sc stop`/`sc start` и `markiro-host restore` из консоли администратора, права службы на восстановленные файлы, страница в WebView2, учебное восстановление с досылкой станции (после плана РК-С).

## Перенесено

1. **Сторона станции в сверке после восстановления — новый малый план «РК-С» после исполнения 2a5 и 2a6.** План 2a6 («Перенесено», последний пункт) относит повторную регистрацию блоков станции к РК, а кода станции (`floor_sscc_blocks` плана 2a5, доставка очереди и `useHostLink` плана 2a6) на ветке ещё нет — этот план не может проверить код станции и даёт только контракт: `hello.restoreEpoch` (`proto/fixtures/hello-restored.json`), `POST /v1/device/sscc/blocks/known` (`known-blocks-request.json`, `known-blocks-response.json`, Zod `knownBlocksRequestSchema`, `knownBlocksResponseSchema` в `src/host/backups.ts`; метода `HostApi` пока нет), отказ `restore_pending` (`error-restore-pending.json`; 2a6 уже повторяет пачку при ответе без квитанций). РК-С: станция хранит последнюю виденную эпоху хоста; при новой — синхронизирует копии с нуля (как при `rev < since`), отправляет все свои блоки этого подключения частями по 64 и только потом возобновляет доставку очереди; отказанные блоки и удержание показывает строка состояния (с планом ОЧ). Около 2 задач; без него сверку после восстановления делает поддержка по памятке (раздел 5, шаг 9).
2. **Повторная регистрация смен и их участников после восстановления** (смена, созданная или открытая станцией после копии, иначе даёт `unknown_shift` / `not_entered` после возобновления). Рекомендуемый вид — маршрут, подобный возврату блоков: станция присылает свои смены с номером и снимком, хост создаёт отсутствующие с теми же id. Вместе с РК-С или отдельным малым планом (хостовая часть и сторона станции); до тех пор памятка (раздел 5, шаг 9) описывает, какие записи останутся отвергнутыми.
3. **Копия удостоверения хоста** (`host.json`, `tls/`) рядом с копиями базы — этап 5 (спецификация этапа 1, §10). Становится обязательной, если на вопрос П1 владелец ответит «А» (хост на ПК администратора): иначе станция после восстановления на новый ПК подключается заново и теряет связь своих блоков с хостом.
4. **Слежение за свободным местом** (родительская спецификация, §11: «хост следит за свободным местом и предупреждает») — этап 5; нужен системный вызов (`GetDiskFreeSpaceExW`/`statvfs`), то есть новая зависимость или FFI — отдельный шаг владельца. Сейчас полный диск виден как сбой копии `disk_full`.
5. **Копия перед обновлением** (§9.3) — этап 5; в пилоте обновление — переустановка (П13).
6. **Мастер восстановления в офисе** (§9.3) — этап 5; в пилоте — `markiro-host restore` из консоли.
7. **Учётная запись службы для записи в общую папку** — план УСТ ставит службу под `LocalService`; для второй папки на другом ПК рабочей группы нужна учётная запись, которая там входит (памятка, раздел 2: `markiro-backup` с тем же паролем на обоих ПК, или в домене `NetworkService` с правом для учётной записи компьютера). Изменение установщика (учётная запись и пароль службы) — решение владельца и поправка плана УСТ.
8. **Постоянная строка предупреждения в шапке офиса** — экран состояния этапа 5; сейчас предупреждения на «Обзоре» и на странице «Резервные копии».
9. **Последняя попытка переживает перезапуск хоста** — сейчас она в памяти (после запуска хост делает новую копию и перечитывает папки); хранить её в базе — этап 5, если понадобится.
10. **Зависшая общая папка.** Запись в неотвечающую общую папку держит исполнителя, пока её не прервёт Windows; офис показывает «Копия делается дольше 30 минут». Прерывание по тайм-ауту — этап 5.
11. **ТСД в списке удержания** — сейчас перечислены только станции (`kind = 'station'`); ТСД — этап 7.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-09 — 2026-10-10. Задачи 1–8 исполнены в ветке `claude/infra-rk` (основа `370ec784c`, 10 коммитов `53390e8ef…cfddf8b15`: восемь задач, раунд исправлений задачи 5 `6fc8536ff` и правка нестабильного теста `cfddf8b15`); на 2026-10-11 ветка **не влита** в `claude/integration` (поверх неё лежат ещё коммиты планов УСТ и ИМП, к этому плану не относящиеся). Итоговое ревью части (общее с УСТ и ИМП-1, HEAD `310bfed51`) и волна исправлений `f4aa73145…bab6f7e5b` записаны в абзаце «Итоговое ревью части и волна исправлений» ниже; поправки по задачам — по отчётам и ревью задач (подробное ревью было у задачи 5). Станционная сторона сверки после восстановления вынесена в отдельный план РК-С.

**Поправки плана по ходу исполнения**

- Задача 1 (`53390e8ef`). Нумерация миграции оставлена: `0011` применяется на базе, где уже есть `0012` (sqlx не отвергает меньшую ещё не применённую версию); доказано тестом `a_database_that_already_has_0012_takes_0011_late` (он строит `Migrator` через скрытые поля `Migrator::DEFAULT`, при обновлении sqlx его, возможно, придётся тронуть). `hello-restored.json` с `protocol` 3, а не 2 плана (такова `PROTOCOL_VERSION` дерева). `hello` читает `initialized` и `restore_epoch` одним запросом к `site`; `db::is_initialized` оставлен. Тестов больше плановых: `fixtures.rs` 47 (в плане 40), `backup_schema` 5 (4), `backups.test.ts` 8 (6) — добавлены строгость `KnownBlocksRequest` и границы блока в Zod.
- Задача 2 (`a36445511`). Сверх плана: файлы копии и реплики создаются с правами 0600 на Unix (копия содержит всё, что `host.db`, включая хеши PIN и бейджей и ключи сопряжения); копия не заменяет и не удаляет уже проверенную (`make_copy_tagged` отказывает занятому имени; `replicate` убирает только то, что записал сам, — в плане `target` удалялся безусловно); имя файла из манифеста проверяется (`is_copy_file_name`), чтобы не выйти из папки. Предварительной проверки свободного места нет (нужна новая зависимость — шаг владельца): полный диск обрабатывается после факта как `disk_full`.
- Задача 3 (`8109f5d21`). Сверх плана: ротация только после удавшегося `make_copy` (в плане — после каждого прогона, удавшегося или нет); `clean` вызывается только внутри прогона, перед копией, в обеих папках; часы хоста, ушедшие назад (`Worker.last_run`), начинают расписание заново без внеочередной копии.
- Задача 4 (`66f44751d`). Проверка `second_dir` строже плана: 1–260 символов, без управляющих, абсолютный путь, без частей `..` и без пространств имён Windows `\\?\`, `\\.\` (законный `\\?\UNC\…` отвергается — в памятке указано писать `\\PC\Share`); проба папки идёт до записи, не дольше 8 с, в `spawn_blocking`, отказ — `409 conflict` с `details.constraint = "backup_dir"` и причиной; менять папки и делать копию может только администратор (технолог читает), ключ устройства без сеанса получает 401 на всех трёх запросах. Тестов: `backup_routes` 7 плановых, `backup_start` +1 (`the_office_of_a_started_host_reads_its_copies`).
- Задача 5 (`4c7c8660b`, раунд `6fc8536ff`). Первая версия отклонилась от брифа так: новая база строится рядом с текущей и подменяется переименованием (в брифе текущая сначала уносилась, затем возвращалась при сбое); ревизии и номера журнала поднимались выше обеих баз; нижние границы читались шире счётчиков и блоков (концы блоков, серии всех коробов и паллет, наибольший номер смены); `UNREADABLE_CURRENT_MARGIN = 1 000 000`; `RUNTIME_SHUTDOWN_TIMEOUT = 5 с` в `main.rs` и `service.rs` (пункт 5 очереди); `RestoreReport` получил `other_host` и `revision`. Ревью задачи 5: Critical 2, Important 3, Minor 8 («нужны исправления»). Раунд исправлений:
  - C1. Ревизия поднята выше обеих баз отключала существующую сверку станции «хост откатился» (`src/local/reference-sync.ts`: `page.rev < since` — полный сброс и повтор с нуля); возвращено правило брифа `ревизия = ревизия копии + 1`, а тест закрепляет и `rev < live_rev`. Журнал аудита оставлен выше обеих баз (id события не должен совпасть с id в отложенной базе). Сверка остаётся «по возможности»: она не заметит станцию с курсором не выше `копия + 1` и ту, что вернётся после новых записей хоста; сброс по эпохе станции — предпосылка пилота и дело РК-С.
  - C2. Обрыв между переименованиями при повторном запуске выдавал тот же блок SSCC заново (воспроизведено: счётчик 5500 при выданном блоке 5500..7499). Введён маркер намерения `<data>/host.restore-intent`: пишется до первого переименования и снимается после последнего; `crate::start` отказывает, пока он есть; повторный `restore` откатывает или завершает подмену по таблице состояний; нижние границы читаются и из каждой `restore-*/host.db` с его WAL; синхронизируются каталоги (на Windows `FlushFileBuffers` по дескриптору папки); крушения моделируются скрытыми `restore_crashing` / `CrashPoint`.
  - I1. Отзывы после копии возвращались: теперь при чтении прежней базы ей переносятся `devices.revoked_at`, `operators.active = 0` и отметка об удалении, `operator_badges.revoked_at`, `office_users.active = 0` (только в сторону «отозван»), всегда стираются `office_sessions`; в details аудита `host.restore` добавлены `carried` и `sessionsEnded`. Смена паролей после копии не переносится и копийные устройства при `other_host` не отзываются — решения владельца не приняты.
  - I2. При непрочитанной прежней базе каждый счётчик не ниже `max(копия + 2 блока, округление вверх до 10 000 от копия + 100 000)`; цена — около 1 % диапазона серийных номеров префикса (7 знаков) на один такой возврат; сводка не обещает того, чего нет (станции пока блоки не регистрируют).
  - I3. Копия с непустым WAL рядом сворачивается через `VACUUM INTO` во временную папку (с манифестом такая копия отказывается — манифест описывает один файл).
  - M1–M8: тест на повреждение внутри файла копии без манифеста; `READ_ATTEMPTS = 4` и отказ при занятой базе вместо «не прочитана»; `restore` больше не вызывает `paths.ensure()` и честно называет, что создал (папка данных, новая идентичность); время копии без манифеста — по самому новому `audit_log.at`; предложение подождать `STATE: STOPPED`; переименованный тест `a_failure_while_the_new_database_is_built_changes_nothing`; `is_own_database` знает `host.db.partial`. `quick_check` прежней базы не добавлен. Тестов: набор `restore` 9 в плане → 17 → 30, библиотека 82 → 89, на конец раунда `cargo test --workspace` 941 пройден (было 921).
- Задача 6 (`d4ee75011`). Расширение блока выше 9 — `range_invalid` (граница Zod); 2–9 остаются `prefix_unknown`, как в тесте брифа (если владелец хотел «всё, кроме 0 и 1», это строка `MAX_EXTENSION = 1`). На 503 `restore_pending` добавлен `Retry-After: 60` (в брифе заголовка не было; станции его пока не читают). Слой удержания читает метку из базы на каждый запрос и закрывается при ошибке чтения. Регистрация блоков станциями удержание не снимает — только `POST /v1/office/backups/resume` администратора с аудитом `host.restore.resume` (`since`, `epoch`, `stations`, `reconciled`). Тестов `known_blocks` 11 (в плане 7), `restore_hold` 8 (4).
- Задача 7 (`529eb7427`). Шесть смысловых отклонений от брифа по дополнениям: предупреждение `held` без `reconciled` и без «Блоки вернули станций: N из M» (станционного кода нет); в таблице удержания нет столбца блоков; диалог «Возобновить приём данных станций» говорит правду («хост не может сказать, сколько станций вернули блоки», флажок «Проверки SSCC выполнены…», кнопка недоступна без него); страница ждёт профиль организации (времена в её поясе, иначе пояс этого ПК с пометкой); свой цикл опроса вместо `refetchInterval` (1 / 2 / 5 с во время копии, 60 с в покое, пауза в скрытой вкладке); `app/shell.css` получил `.backup-alerts` (вне списка файлов брифа, в браузере не смотрелся). Тестов в 5 новых файлах 85 (`backup-dir` 26, `backup-format` 3, `backup-warnings` 9, `backup-polling` 12, `backups-page` 35). Тесты 2a3 не менялись.
- Задача 8 (`c22bdc5d2`, `cfddf8b15`). Памятка `docs/runbooks/standalone-backup-restore.md` (394 строки) написана по коду, а не по брифу: исправлены ложные места брифа («ждать, пока станции вернут блоки» — станционного кода нет; откат «удалить host.db и вернуть файлы» — заменён `restore restore-<время>\host.db --without-manifest`; запас нового ПК «два блока» — на деле не ниже 100 000; конструкция «сначала унести, потом положить» — теперь строится рядом; хранение «последняя копия каждого из 14 дней» — по дням, в которых копии есть). Раздел 7 памятки — проверки SSCC до «Возобновить приём». Раздел спецификации пилота — «19. Уточнения плана РК» (ПЛ-Ц, ЧЗ и О-Ф тоже дописывают в этот файл; номера пересчитываются при слиянии); таблицы плана в §12 не правились (там по-прежнему «6 задач»). Нестабильность `backup_start::the_office_of_a_started_host_reads_its_copies` (1 из 6 под нагрузкой: рабочий кладёт копию в папку раньше, чем записывает `lastAttempt`) исправлена ожиданием `lastAttempt`; шесть зелёных прогонов согласуются с исправлением, но не доказывают его.

**Итоговое ревью части и волна исправлений**

Ревью потока инфраструктуры (РК 1–8, ИМП-1, УСТ 1–7), HEAD `310bfed51`: нужны исправления — Critical 2, Important 2, Minor 9. Собственные мутанты ревьюера по РК: восемь убиты, один выжил (закрыт тестом). Волна исправлений — 15 коммитов `f4aa73145…bab6f7e5b` в `claude/infra-rk` (тесты отдельными коммитами перед кодом; коммиты `a4ac97ff4`, `9508d4609`, `5c5bd6f83`, `bab6f7e5b` — тесты, закрывшие защиту, которую выживший мутант показал незакреплённой; в коммитах-исправлениях механически изменены и прежние тесты, поведение которых изменилось, например `tests/install.rs`). Поправки, найденные ревью и волной:

- **C1.** Восстановление на новый ПК по памятке (§6: установщик уже запустил службу и создал пустую базу без мастера) давало `Current::Read` и запас два блока вместо 100 000, а сводка писала «revocations carried over… 0»; воспроизведено (счётчики 9500/440 вместо 110 000). Исправлено в `restore.rs` (`f4aa73145`, `3b2aca4a6`, `a4ac97ff4`): `read_live` читает ещё и `site.initialized_at`; запасы и строка «не прочитана» действуют, если `!history_known` (`history_known = Read && initialized && !foreign`, где `foreign` — нет `host.json` или хост манифеста другой); отзывы тогда не переносятся (`carried = None`), `RestoreReport` получил `history_known`, в аудите `host.restore` `details.carried = null`; добавлена строка «текущая база — не история этой копии». Тестов +3. Это **расширяет** решение раунда исправлений задачи 5 (I2: запас при непрочитанной прежней базе) на случай «база прочитана, но не история копии». Мутант `foreign` как `is_some_and` равносилен (при `existing == None` базы нет: иначе `would_orphan_host_data` отказывает), мутант «без проверки `initialized`» выжил один раз и убит тестом `a4ac97ff4`.
  - Остаток: когда база прочитана, но чужая, строка сводки по-прежнему начинается «the previous database was not read» (реальная причина печатается строкой раньше; тесты закрепляют старый текст).
- **C2.** На Windows каждая копия падала бы на `sync_all` дескриптора только для чтения (`FlushFileBuffers` требует права записи). Введён `backup::copy::sync_file` (открытие для записи), им пользуются `make_copy` и `restore.rs` (свой приватный вариант удалён); шаг хоста в `smoke.ps1` ждёт до 120 с проверенную копию `markiro-host-*.db` с `.json` в `backups` и проверяет права `backups` и копии (SID `S-1-5-18,S-1-5-19,S-1-5-32-544`); `workflow.test.mjs` закрепляет проверки. Мутант «`make_copy` снова через `File::open(..).sync_all()`» на Unix **не убивается**; доказать может только шаг на Windows.
- **I1 (пункт 6 очереди).** Ротация всегда оставляет только что сделанную копию (`folder::rotate(dir, keep_also)`, рабочий передаёт `manifest.file` для обеих папок); офис получил предупреждение `clockBehind` (`CLOCK_AHEAD_MS` = 1 ч: новейшая копия любой из папок позже `now` хоста больше чем на час; ровно час — тихо, час и секунда — предупреждение). Пункт 6 очереди **закрыт**.
- **M1.** `restore_hold.rs`: тест с переименованным `site.facts_held_since` — записи и проверки кодов отвечают 500 `internal`; мутант «сбой чтения удержания открывает» (`.unwrap_or(None)`) теперь убит.
- **M2 (пункт 8 очереди).** `start_backup` читает настройки и удержание в откатываемой транзакции до `request_manual`, затем строит состояние из памяти; сбой чтения — 500 без постановки копии (затем `GET` даёт `running == null`, повторный `POST` — 202); ответ для хоста с удержанием несёт удержание (мутант без удержания выжил и убит `5c5bd6f83`). Пункт 8 очереди **закрыт**.
- **M3, M4** (общие с УСТ): тайм-аут запуска — код 4; владелец каталога данных — Администраторы; см. план УСТ.
- **M5.** Шаг `pnpm test:standalone-export` добавлен в задание `standalone-windows-build` сразу после сборки `@markiro/standalone...` (там собирается `@markiro/domain`), порядок закреплён контрактным тестом. Ревью относило M5 к задаче 3 ИМП, но поручение волны требовало добавить шаг сразу; при возврате к ИМП-3 откатить одну строку `run:` и тест (коммиты `9fa0ab79e`, `af4d13612` содержат и M8).
- **M6, M7 (документы).** Пример ключа месяца — `OCT26`; смена PIN и бейджей после копии откатывается (§4 и проверка 3 §7 памятки); «хеши ключей устройств» в §2 памятки и в §19 спецификации; все ПК площадки должны быть на версии хоста до восстановления (схема не ослаблена).
- **M8.** Шаг подготовки получил `env: PR_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}` и `--source-sha "$env:PR_HEAD_SHA"`; контракт «нет `env` у шагов» теперь исключает ровно этот шаг, отдельный тест закрепляет его `env`.
- **M9.** `worker.rs`: `folder_outcome` — если задача папки не завершилась (паника в `spawn_blocking`), возвращаются списки с `Err`, не затирающие статус, вторая папка получает сбой `internal`; тест на настоящем `JoinError`.
- **Вход для РК-С.** В `rk-minors` добавлен пункт 11: после восстановления на новый ПК станции сопрягаются с новыми идентификаторами устройств, блоки копии отвечают `block_mismatch`, а факты из этих блоков получили бы `sscc_not_issued`. Решение владельца не принято (запись «РК-С I1»; см. «Открыто» в плане РК-С).
- **Нумерация.** Раздел спецификации «19. Уточнения плана РК» по чек-листу слияния получает номер 22 (УСТ — 23, РК-С — 24); ссылки на «19» в памятке (строка 3) и в AGENTS «Backups and restore» (§11 и §19) при слиянии исправляются.

**Перенесено**

- План РК-С (станционная сторона): читать `restoreEpoch` из `hello`, при смене отдавать хосту все известные блоки (`blocks/known`, частями), при отказе блока помечать «эти номера использовать нельзя» и показывать это, учитывать `Retry-After` и держать факты в очереди на `restore_pending`, сбрасывать справочники по эпохе. До него сверка станции после восстановления — «по возможности», а `reconciled` в офисе остаётся нулём. Исполнено после записи этого пункта: план РК-С реализован в ветке `claude/floor-2a7` (эпоха из `hello`, блоки частями по 64, сброс по эпохе, строки состояния, столбец «Блоки SSCC» в офисе; см. «Отклонения при исполнении» плана РК-С), но не прогонялся на Windows и с настоящим восстановлением; открыто решение владельца о восстановлении на новый ПК.
- Пункты 6 и 8 очереди закрыты итоговой волной (I1 и M2 выше): ротация не трогает только что сделанную копию; `start_backup` читает состояние до постановки копии. Остаются: пункт 4 очереди (проверка свободного места, переименование против антивируса, UNC — нужна зависимость или Windows); `quick_check` текущей базы при восстановлении (низкая ценность); зависшая общая папка второй копии тормозит рабочего (этап 5; в офисе предупреждение «зависла»); остаток M4: если пользователь заранее создал `%ProgramData%\Markiro`, у этой папки остаётся унаследованное право CREATOR OWNER (в памятке сказано; полное решение — укрепить такую папку или отказать).
- Решения владельца: смена паролей после копии и отзыв копийных устройств при `other_host`; `MAX_EXTENSION`; потеря около 1 % диапазона серийных номеров префикса на каждое восстановление без прежней базы; тексты диалога возобновления и раздела 7 памятки (написаны исполнителем).
- Этап 5 (из «Перенесено» плана): копия `host.json` и `tls/`, слежение за свободным местом, копия перед обновлением, мастер восстановления в офисе, постоянная строка предупреждения в шапке, хранение последней попытки в базе, прерывание зависшей общей папки, ТСД в списке удержания.

**Не проверено**

- Всё из раздела 10 памятки (ручной список для Windows): служба под выбранной учётной записью, пишущая в общую папку другого ПК (`LocalService` для этого не годится); UNC и их тайм-ауты; выдернутая USB-флешка во время копии и её буква; коды ошибок Windows; настоящий переполненный диск (имитирован только `max_page_count`); переименование против антивируса; сброс буферов папки; наследование ACL файлами `restore-<время>`, копиями и подменяемой базой; `sc stop` и время до `STATE: STOPPED`; отказ `sc start` при наличии `host.restore-intent`; `markiro-host restore` из консоли администратора; страница в WebView2 (отступ `.backup-alerts`, порядок фокуса, чтение диктором, `visibilityState` при свёрнутом окне).
- Учебное восстановление при работающей станции (РК-С исполнен в ветке `claude/floor-2a7`, но на настоящей линии не прогонялся); процедура проверки 1 из раздела 7 памятки никем не прогонялась на настоящей линии, а граница «два размера блока» выведена из правила половины (`block-supply.ts`), не измерена. Поведение станции на настоящем `restore_pending` (строка состояния, отображение `HostError`) не наблюдалось.
- Код под `cfg(windows)` (`sync_dir` на `FlushFileBuffers`) скомпилирован пробным крейтом вне репозитория под `x86_64-pc-windows-msvc` и под хост без ошибок и предупреждений, но не исполнялся.
- После итоговой волны на Windows не исполнялось ничего из нового: сброс копии через дескриптор для записи (C2) и проверяющий его шаг `smoke.ps1`, `icacls /setowner` (в том числе даёт ли `/C` ненулевой код при сбое элемента), сохранение учётной записи службы через `ChangeServiceConfigW` с NULL, код 4 по тайм-ауту через NSIS. Первый прогон `standalone-windows-build` в CI станет первой настоящей проверкой.

**Счёт.** План: `cargo test -p markiro-host -p markiro-proto` — 44 строки результата, 477 тестов; Vitest 70 файлов, 1766 тестов. Измерено на `cfddf8b15`: `cargo test --offline --locked --workspace --no-fail-fast` вне песочницы — 63 строки результата, 960 пройдено, 0 отказов; Vitest одним прогоном с `--testTimeout=60000 --hookTimeout=60000` — 107 файлов, 3116 тестов; `typecheck`, `lint`, `build`, `cargo fmt --check` и `cargo check --all-targets` без предупреждений — чисто. Разница с планом — тесты влитых потоков и приращения сверх брифов. После итоговой волны (`bab6f7e5b`, ветка `claude/infra-rk`): `cargo test --workspace --no-fail-fast` вне песочницы — 67 строк результата, **1029** пройдено (до волны 1019), 0 отказов; Vitest с теми же ключами — 107 файлов, **3142** теста (до волны 3141); `pnpm test:standalone-release:contract` — 51, `pnpm test:standalone-export` — 37, `node --test tools/ci/test/*.test.mjs` — 47; фокусные наборы: `restore` 33, `backup_copy` 28, `backup_worker` 13, `backup_routes` 14, `install` 28, `restore_hold` 9; `typecheck`, `lint`, `build`, `cargo fmt --check` — чисто.
