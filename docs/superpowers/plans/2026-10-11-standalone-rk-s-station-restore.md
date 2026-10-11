# План РК-С: станция после восстановления хоста из копии — эпоха в `hello`, возврат блоков SSCC, справочники с нуля, повторная отправка записей, удержание `restore_pending` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Станция сама узнаёт, что хост восстановлен из копии (новая `restoreEpoch` в `hello`), возвращает ему все свои блоки SSCC через `POST /v1/device/sscc/blocks/known`, перестаёт печатать номера из блоков, которые хост отклонил, пересобирает справочники с нуля, снова ставит в очередь записи последних 30 дней и не отправляет ни одной записи, пока блоки не возвращены; ответ `restore_pending` — отдельное состояние «отправка ждёт администратора» с повтором раз в минуту, без потери записей и без остановки цеха; офис показывает, какие станции вернули блоки.

**Architecture:**

- Оболочка, `src-tauri/src/connection.rs`: перед каждым потоком ленты задача связи читает `GET /v1/hello` тем же клиентом с закреплённым сертификатом (`PinnedClient`, без ключа), разбирает ответ `host_probe::classify_hello` и кладёт `restoreEpoch` в статус `Online` (`HostStatus.restore_epoch`, в JSON — `restoreEpoch`, только когда есть). Неудачное чтение поток не останавливает.
- Вебвью, база станции: миграция оболочки `0009_restore_epochs.sql` — таблица `floor_restore_epochs` (одна строка на подключение: эпоха, когда увидена, когда исполнена, сколько блоков отклонено), класс `Disposable`. `src/local/restore-reconcile.ts`: `noteRestoreEpoch` (новая эпоха — обязательство), `restoreDue`, `readRestoreStatus`, `reconcileRestore` (блоки по 64; отклонённый блок — курсор за конец; затем одной транзакцией `from_zero` для ленты, записи за 30 дней снова в очереди, обязательство закрыто). `src/local/reference-sync.ts`: `FROM_ZERO_SQL` и ветка «с нуля» по метке. `HostApi.registerKnownBlocks`.
- Вебвью, связь: `useHostLink` записывает новую эпоху из статуса, запускает сверку при каждом событии связи и повторяет её с ожиданиями ленты; отправка очереди ждёт, пока обязательство не исполнено; `restore_pending` — сбой `held` с ожиданием `RESTORE_HOLD_RETRY_MS` (60 с, как `Retry-After` хоста). Строка состояния цеха — три новых предупреждения в своей вежливой области.
- Офис: карточка удержания на «Резервных копиях» показывает у станции «Вернула» / «Не вернула», окно возобновления — «Вернули свои блоки SSCC: N из M станций»; тексты, которые после плана стали бы неправдой, переписаны.
- Документы: `apps/standalone/AGENTS.md`, памятка `docs/runbooks/standalone-backup-restore.md`, раздел 22 спецификации пилота.

**Tech Stack:** Rust — reqwest через уже имеющийся `host_client::PinnedClient`, serde, sqlx 0.8.6 (только тесты оболочки), tokio; TypeScript — React 19, Zod 4.4.3, Vitest 4 с jsdom, `node:sqlite` за `LocalExecutor` в тестах, `@testing-library/react`, `@markiro/ui` (`Alert`, `Table`).

**База:** `claude/integration` на `370ec784c` (влиты 2a2, 2a3, 2a4, 2a5, 2a6, ПЛ-Х) плюс `claude/infra-rk` на `cfddf8b15` (хостовая часть плана РК, задачи 1–8; слияние — перемотка, конфликтов нет). Копия — `/tmp/claude/p-rks-scratch`, коммиты задач копии `99efe7890`, `7c10393c9`, `1a2fab6ee`, `045f011f3`, `122c3ce4d`. На копии **нет** планов 2a7 (миграция оболочки `0007`, `floor_print_jobs`), ПЛ-Ц (`0008`, паллеты цеха), 2a8 (исключения, закрытие, срок хранения), ЧЗ, О-Ф, ИМП, УСТ: где они сдвигают якоря, сказано в «Заметках». Каждый фрагмент плана применён к копии сценарием шаг за шагом (каждый «фрагмент» найден ровно один раз, после каждой задачи дерево совпало с её коммитом байт в байт), тесты каждой задачи падали после шага 1 ровно так, как написано в шаге 2, и проходили после шага 3. Не воспроизведено ничего из кода плана; не воспроизведено только слияние с 2a7, ПЛ-Ц и 2a8.

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — раздел 11, абзац «Повторная регистрация блоков» (станция, увидевшая новую эпоху, отправляет блоки; затем досылает факты, хранящиеся 30 дней), раздел 19 «Уточнения плана РК» (сторона станции — план РК-С, «сброс по эпохе — условие пилота»), раздел 15.
- `docs/superpowers/plans/2026-10-09-standalone-rk-backups.md` — Global Constraints 6–9, «Решения планировщика» (удержание, возврат блоков, протокол), «Перенесено», п. 1; отчёты `.superpowers/sdd/rk-task-{1..8}-report.md`, `rk-task-5-review.md`, `rk-minors.md` (п. 9 и 10 — что должна сделать станция).
- `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` — §4.4 (квитанция хранится бессрочно; та же запись — та же квитанция), §5.5 (очередь), §5.7.4 (блоки, правило половины), решение 31 (станция хранит подтверждённые записи 30 дней).
- `docs/runbooks/standalone-backup-restore.md` — разделы 5.8, 7 (проверки перед «Возобновить»), 8, 9, 10 (п. 9 — учебное восстановление «после плана РК-С»).
- `apps/standalone/AGENTS.md` — «Local database», «Reference sync», «Connection to the host», «Floor work», «Backups and restore», «Verification».

## Допущения по вопросам владельцу

Новых вопросов из раздела 14 спецификации пилота план не касается. Решения планировщика, которые владелец может поменять (сказано, где правка):

- **С1 — записи последних 30 дней уходят снова.** Спецификация (§11) велит после блоков «повторно дослать факты, хранящиеся 30 дней»: хост, восстановленный из копии, не знает записей, принятых после копии. Станция не знает, когда сделана копия, поэтому после возврата блоков все записи подключения с квитанцией не старше 30 дней (`acked_at`) снова ждут отправки. Ничего не применяется дважды: на запись, которую хост знает, он отвечает той же квитанцией (2a, §4.4; `host/src/facts/mod.rs`). Цена — повторная отправка до 30 дней записей одной станции (сотни пакетов по 100). Окно — одна константа `RESEND_WINDOW_MS`.
- **С2 — `Retry-After` записан с обеих сторон.** Оболочка передаёт вебвью только статус и тело ответа (`host_request`), заголовков нет. Станция ждёт `RESTORE_HOLD_RETRY_MS = 60 000` — столько же, сколько хост пишет в `Retry-After` (`RESTORE_RETRY_AFTER_SECS` в `host/src/server.rs`); тест читает число из `server.rs` и падает, если оно разойдётся. Передача заголовков через оболочку меняла бы контракт `host_request` для всех вызовов — «Перенесено», п. 1.
- **С3 — эпоху читает оболочка, а не вебвью.** Вебвью сам HTTP не делает, а `host_hello` — неподтверждённая проба для подключения. Поэтому задача связи читает `hello` закреплённым клиентом перед каждым потоком: восстановление всегда перезапускает хоста, поток рвётся, и следующее подключение читает новую эпоху до первого статуса `Online`.
- **С4 — отклонённый блок станция больше не использует.** Ответ `block_overlap` значит, что номера блока есть у другого устройства; `block_mismatch`, `prefix_unknown`, `range_invalid` — что хост этот блок принять не может. Номер из такого блока либо повторил бы чужой SSCC, либо получил бы `sscc_not_issued` навсегда. Курсор блока уходит за его конец; короба закрываются остальными блоками, новый блок станция запрашивает по правилу половины. Сколько блоков отклонено, говорит строка состояния цеха.
- **С5 — первая увиденная эпоха тоже новая.** Станция, которая впервые видит эпоху (обновилась до РК-С после давнего восстановления, или подключена после него), исполняет обязательство: блоки хост узнает (`known`), лента пересоберётся, записи 30 дней уйдут снова и получат те же квитанции. Так проще и безопаснее, чем угадывать, видела ли станция восстановление.
- **С6 — пока блоки не возвращены, записи не уходят, даже если приём уже возобновлён.** Короб, закрытый номером блока, которого хост не знает, получил бы отказ навсегда. Если хост отвечает на возврат блоков отказом, который не исправится сам, записи станции ждут, а строка состояния держит «станция возвращает ему свои блоки» — это видно и разбирается поддержкой; молча записи не пропадают.
- **С7 — офис говорит правду.** После плана тексты «станции пока не возвращают блоки» стали бы ложью; хост уже отдаёт `reconciled` по станции (план РК), поэтому карточка показывает столбец «Блоки SSCC», а окно — «N из M». Проверки памятки остаются обязательными: станция на мёртвом ПК блоков не вернёт.
- **С8 — `floor_restore_epochs` — `Disposable`.** Обязательство принадлежит подключению; новое подключение (новый `deviceId`) старому хосту ничего не должно, а записи старого подключения после «Забыть» не уходят вовсе.
- **Номер миграции оболочки — `0009`.** Планы 2a7 и ПЛ-Ц заняли `0007_floor_printing.sql` и `0008_floor_pallets.sql`; `0009` хоста (`0009_shifts_sscc_blocks.sql`) — другой каталог. Если к исполнению номер занят, миграция получает следующий свободный; тесты номер не называют.
- **Номер раздела спецификации — 22.** Заняты 18 (ПЛ-Х), 19 (РК, ПЛ-Ц, ЧЗ, 2a7 — каждый в своей ветке), 20 (2a8), 21 (О-Ф).

## Шаги владельца

Новых зависимостей нет: `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются. Владелец даёт для приёмки (в автоматических проверках этого нет): два ПК с Windows 10/11 и учебное восстановление по памятке, раздел 10, п. 9.

## Global Constraints

**Решения спецификаций, обязательные для РК-С**

1. Станция, увидевшая новую эпоху, отправляет свои блоки (`floor_sscc_blocks`) маршрутом `POST /v1/device/sscc/blocks/known` (пилот, §11).
2. Затем станция повторно досылает факты, хранящиеся N = 30 дней (пилот, §11; 2a, решение 31).
3. Сброс ленты по эпохе — условие пилота, а не доработка (пилот, §19, «Ревизия»).
4. Отправка блоков частями по 64, затем фактов (пилот, §19; `known_blocks::MAX_BLOCKS = 64`).
5. До решения администратора хост отвечает на факты и проверки кодов `restore_pending` (503, `Retry-After: 60`, `details.since`); станция досылает их позже, ничего не теряя (пилот, §19; РК, Global Constraints 9).
6. Станция работает без хоста: печатает из своих блоков, пишет в свою базу, копит записи (памятка, 5.8; AGENTS корня — «Offline operation and sync»).
7. Квитанция хранится бессрочно; та же запись — та же квитанция (2a, §4.4).

**Решения планировщика** (задача 5 записывает их в `AGENTS.md` и в раздел 22 спецификации пилота)

- Эпоха — из статуса оболочки (`HostStatus.restoreEpoch`, только у `Online`); строгая схема `hostStatusSchema` принимает её необязательной, `z.uuid()`.
- Обязательство — строка `floor_restore_epochs` подключения с `reconciled_at IS NULL`; записывается раньше любого вопроса «должна ли станция блоки»; переживает перезапуск; новая эпоха сбрасывает `reconciled_at` и `refused`.
- Блоки — все блоки подключения, и израсходованные, по `received_at, block_id`, ровно как хост их выдал; ответ проверяется по числу и по `id` каждого результата (иначе `KnownBlocksMismatchError`, ничего не сохраняется). `conflict` с `details.constraint = "no_restore"` — возвращать нечего.
- Конец сверки — одна транзакция: `FROM_ZERO_SQL`, повторное открытие записей с `acked_at >= now − 30 дней`, закрытие обязательства с `expectedChanges: 1` по той эпохе, которую прогон прочитал.
- Лента «с нуля» по метке `from_zero` в `sync_state`: следующий прогон идёт с ревизии 0, первая страница стирает и заполняет копии одной транзакцией (как уже делает ветка «хост вернулся назад»), метка уходит вместе с `sync_state`.
- Связь: сверка — отдельный планировщик `createSyncScheduler`, запускается при каждом событии связи и при новой эпохе, повторяется с ожиданиями `nextSyncRetryMs`, после успеха — синхронизация справочников и отправка очереди. Отправка очереди сначала записывает новую эпоху, затем спрашивает `restoreDue`. `restore_pending` → `FactsFailure` `held`, повтор через `RESTORE_HOLD_RETRY_MS`.
- Строка состояния: «Хост восстановлен из копии — отправка ждёт администратора…» (`held`), «…станция возвращает ему свои блоки номеров SSCC…» (обязательство не исполнено), «Блоков номеров SSCC, которые хост не принял после восстановления: N…» (`refused > 0`); все три — в существующей вежливой области предупреждений, `role="presentation"`.

**Код и процесс**

- Правила `apps/standalone/AGENTS.md`: «Local database» (только `local_query`/`local_transaction`, класс каждой таблицы в `TABLE_CLASSES`, без внешних ключей), «Floor work» (запись никогда не удаляется и не пропускается), i18n — строки в `ru.json`.
- Не меняются: хост (`host/`), `proto/`, `apps/station`, `packages/*`, `apps/api`, миграции `0001`–`0006` оболочки, `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`.
- Журнал процесса: ничего нового (эпоха — не секрет, но и не пишется).
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало шага, с отступами; в этот момент он встречается в файле один раз. Внутри шага правки одного файла идут сверху вниз и применяются по порядку. Шаг тестов применяется раньше шага реализации (в `src-tauri/src/connection.rs` шаг 1 задачи 1 трогает только модуль тестов, шаг 3 — остальное).
- «Создать» — новый файл, ровно как в блоке, с переводом строки в конце.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован `cargo fmt` и prettier. Фрагмент может начинаться пустой строкой — она часть фрагмента.
- Русский текст — буквами, не `\uXXXX`.

**Слияние с 2a7, ПЛ-Ц и 2a8** (их нет на копии; если они влиты раньше, фрагмент вносится по смыслу рядом с тем же местом, а отличие пишется в «Отклонения при исполнении»)

- `src-tauri/src/local_db.rs` (`TABLE_CLASSES`): 2a7 добавляет `floor_print_jobs` и таблицы рабочего места, ПЛ-Ц — `floor_pallets` и др.; строка `("floor_restore_epochs", TableClass::Disposable),` встаёт по алфавиту. Списки таблиц в `src-tauri/tests/local_db.rs` (`opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`) и `test/local-executor.test.ts` («has exactly the shell's tables») — так же по алфавиту; в `test/floor-schema.test.ts` правка устойчива (`[...DEVICE_TABLES, "floor_restore_epochs"].sort()`). Числа «Of the 20 tables 12 are `Disposable`» в `AGENTS.md` пересчитать.
- `src/floor/FloorStatusBar.tsx`, `src/i18n/ru.json` (`floor.status`): 2a7 и 2a8 добавляют свои предупреждения и ключи; три новых `Alert` ставятся перед предупреждением `factsLocal`, ключи — после `factsLocal`.
- `src/app/App.tsx`: 2a8 вставляет перед `useHostLink` проход срока хранения; правка РК-С касается только списка параметров `useHostLink`.
- `src/app/host-link.ts`: если 2a7, ПЛ-Ц или 2a8 добавили в `useHostLink` параметр, `registerKnownBlocks` ставится после `sendFacts` и в массив зависимостей эффекта; вызовы в `test/host-link-facts.test.ts`, `test/host-link-shifts.test.ts`, `test/app.test.tsx` — так же.
- 2a8, срок хранения (`src/local/retention.ts`): он оставляет `floor_sscc_blocks` (тест 2a8 это закрепляет: «a restored host asks the station for them») и удаляет только смены, все записи которых с квитанциями, — записи, снова открытые сверкой, удержат смену до повторной отправки. `RESEND_WINDOW_MS` и `RETENTION_DAYS` 2a8 — одно и то же решение 31: после слияния можно выразить одно через другое.
- ПЛ-Ц: блоки паллет — строки `floor_sscc_blocks` с `extension = 1`; сверка отправляет их вместе с блоками коробов без правок.

**Мутации**

- Для каждой: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL названного теста; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить.

**Перед каждым коммитом**

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (задачи с Rust); prettier на изменённые TS, TSX, JSON и MD — из корня, путями от корня: `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <пути>` → `All matched files use Prettier code style!` (живая проверка гейта: заведомо кривой `docs/runbooks/zz.md` и `apps/standalone/src/zz.ts` дают `[warn]` — проверено на копии); `git diff --check`.

**Cargo, pnpm и git**

- Cargo — с `--offline --locked` и своим `CARGO_TARGET_DIR` для каждого рабочего дерева (общий каталог сборки двух деревьев отдаёт тестам библиотеку другого дерева).
- Оболочка встраивает сборку вебвью (`tauri::generate_context!`): перед `-p markiro-standalone` в свежем дереве — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`. Перед Vitest в свежем дереве — `pnpm --config.verifyDepsBeforeRun=false install --frozen-lockfile --prefer-offline --filter '@markiro/standalone...'` (сеть: registry.npmjs.org) и `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`.
- `--test connection` оболочки поднимает настоящего хоста на 127.0.0.1 — в песочнице падает на `bind`, запускать вне её; `--lib connection` и `--test local_db` идут и в песочнице.
- pnpm — только с `--config.verifyDepsBeforeRun=false`, из корня, без `cd`; `pnpm install`/`pnpm add` сверх рецепта не запускать.
- Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если вывод урезан обёрткой `rtk`, запускать `rtk proxy <команда>`.

**Счёт тестов**

- База (копия на `cfddf8b15`): cargo `--workspace` — 63 строки `test result`, 960 тестов; Vitest — 107 файлов, 3116 тестов.
- После плана: cargo — 63 строки, 962 теста; Vitest — 109 файлов, 3138 тестов. Приращения: задача 1 — оболочка `--lib` +1 (`connection` 12 → 13), `--test connection` +1 (6 → 7), Vitest +1 (`connection.test.ts` 5 → 6); задача 2 — Vitest +1 файл, +13 (`restore-reconcile` 11, `reference-sync` +1, `api` +1); задача 3 — Vitest +1 файл, +8 (`host-link-restore` 6, `floor-status-bar` +2); задача 4 — 0 (два теста переписаны); задача 5 — 0.
- Под посторонней нагрузкой (средняя 56–70 при написании) полный прогон Vitest дал 13 отказов по пределу 5 с в `shift-dialog`, `shifts-page`, `template-defaults-page`, `template-editor`, `templates-page`; первые три прошли отдельным запуском, `templates-page` и `template-editor` падали по тайм-ауту и отдельно (3 теста `template-editor` — даже при `--testTimeout=20000`). Ни одного из этих файлов план не трогает; такие отказы описаны и в планах ЧЗ и РК на их базах. Гейтом остаётся обычный предел; отказ повторить отдельным запуском файла.

**Что исполнитель может проверить на macOS и чего не может**

- Может: всё выше — чтение эпохи оболочкой у настоящего хоста на 127.0.0.1 (эпоху пишет тест в `site`, как её оставляет `markiro-host restore`), сверку на `node:sqlite` с настоящими формами запросов и ответов (фикстуры `known-blocks-request.json`, `known-blocks-response.json`, `hello-restored.json`), связь в `renderHook`, строку состояния и страницу офиса в jsdom.
- Не может: Windows, WebView2, настоящий `markiro-host restore` при станции, которая печатает, две станции и сеть; это — памятка, раздел 10, п. 9, и приёмка у владельца.

## Файлы

```
apps/standalone/src-tauri/src/connection.rs, src-tauri/tests/connection.rs                 задача 1
apps/standalone/src/host/protocol.ts, test/connection.test.ts                              задача 1
apps/standalone/src-tauri/migrations/0009_restore_epochs.sql, src-tauri/src/local_db.rs    задача 2
apps/standalone/src-tauri/tests/local_db.rs, test/{local-executor,floor-schema}.test.ts    задача 2
apps/standalone/src/local/{restore-reconcile,reference-sync}.ts, src/host/api.ts           задача 2
apps/standalone/test/{restore-reconcile,reference-sync,api}.test.ts, test/support/office.tsx   задача 2
apps/standalone/src/app/{host-link,shell}.ts, src/app/App.tsx                              задача 3
apps/standalone/src/floor/FloorStatusBar.tsx, src/i18n/ru.json                             задачи 3, 4
apps/standalone/test/{host-link-restore,host-link-facts,host-link-shifts}.test.ts          задача 3
apps/standalone/test/{floor-status-bar,app}.test.tsx                                       задача 3
apps/standalone/src/office/backups/BackupsPage.tsx, test/backups-page.test.tsx             задача 4
apps/standalone/AGENTS.md, docs/runbooks/standalone-backup-restore.md,
  docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md                         задача 5
```

Порядок: сначала станция узнаёт эпоху (задача 1: оболочка и схема статуса), потом всё, что она должна восстановленному хосту, как чистая логика над базой станции (задача 2), потом связь и цех: когда это делать, что ждёт и что видно (задача 3), офис (задача 4), документы (задача 5). Задачи 1 и 2 независимы друг от друга, но задача 3 читает обе.

## Контракт для других планов

- **2a8 (срок хранения):** не удалять `floor_sscc_blocks` и `floor_restore_epochs`; запись, снова открытая сверкой (`acked_at IS NULL`), — неотправленная, смена с ней не удаляется. Закрытие смены, которое уходит повторно, получает прежнюю квитанцию.
- **ПЛ-Ц:** блоки паллет уходят в сверке автоматически; если ПЛ-Ц добавит таблицу блоков вне `floor_sscc_blocks`, сверка должна отправлять и их (`BLOCKS_SQL` в `restore-reconcile.ts`).
- **2a7:** три новых предупреждения строки состояния стоят в той же вежливой области; задания печати сверка не трогает.
- **Хост (поток Б, если понадобится):** подключение без блоков маршрут не вызывает (хост требует 1–64 блока), и офис показывает его «Не вернула»; разрешить пустой список — правка `routes/known_blocks.rs` («Перенесено», п. 2).

---

### Task 1: Оболочка читает эпоху хоста — `hello` перед каждым потоком, `restoreEpoch` в статусе `Online`

Восстановление всегда перезапускает хоста, поэтому поток ленты станции рвётся, и следующее подключение — то место, где станция узнаёт новую эпоху. Задача связи читает `GET /v1/hello` закреплённым клиентом без ключа прямо перед потоком и кладёт `restoreEpoch` в статус, который первое событие потока публикует как `Online`: вебвью получает эпоху вместе с «на связи» и не делает ни одного запроса сам. Ответ, который не читается как `hello` совместимого хоста Markiro (не 200, чужой продукт, не та схема), эпохи не даёт; неудачное чтение поток не останавливает. Новое подключение и отсутствие подключения эпоху очищают. В JSON поле есть только со значением, поэтому ни одна существующая форма статуса не меняется. Интеграционный тест поднимает настоящего хоста, пишет эпоху в его `site` так, как это делает `markiro-host restore`, перезапускает его на том же адресе и ждёт её в статусе.

**Files:**

- Modify: `apps/standalone/src-tauri/src/connection.rs`, `apps/standalone/src/host/protocol.ts`
- Test: `apps/standalone/src-tauri/src/connection.rs` (модуль `tests`), `apps/standalone/src-tauri/tests/connection.rs`, `apps/standalone/test/connection.test.ts`

**Interfaces:**

- Consumes: `host_client::{PinnedClient, Credentials, HostResponse}`, `host_probe::classify_hello`, `markiro_proto::Hello.restore_epoch` (план РК), фикстура `proto/fixtures/hello-restored.json`.
- Produces: `connection::HostStatus.restore_epoch: Option<String>` (JSON `restoreEpoch`, пропускается при `None`), заполняется только статусом `Online`; Zod `hostStatusSchema.restoreEpoch: z.uuid().optional()`, тип `HostStatus["restoreEpoch"]: string | undefined`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            last_error: Some(LinkError::CertificateMismatch),
            seq: 4,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "offline", "lastContactAt": 1_700_000_000_000u64, "lastError": "certificate_mismatch", "seq": 4 })
        );
        assert_eq!(
```

заменить на

<!-- prettier-ignore -->
```rust
            last_error: Some(LinkError::CertificateMismatch),
            seq: 4,
            restore_epoch: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "offline", "lastContactAt": 1_700_000_000_000u64, "lastError": "certificate_mismatch", "seq": 4 })
        );
        let restored = HostStatus {
            state: LinkState::Online,
            last_contact_at: Some(1_700_000_000_000),
            last_error: None,
            seq: 5,
            restore_epoch: Some(EPOCH.to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            json!({ "state": "online", "lastContactAt": 1_700_000_000_000u64, "lastError": null, "seq": 5, "restoreEpoch": EPOCH })
        );
        assert_eq!(
```

2. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
        );
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        );
    }

    /// `restoreEpoch` of `proto/fixtures/hello-restored.json`.
    const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";

    #[test]
    fn the_epoch_comes_only_from_a_hello_that_reads() {
        let restored: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/hello-restored.json")).unwrap();
        let epoch =
            |status: u16, body: Option<serde_json::Value>| epoch_of(&HostResponse { status, body });
        assert_eq!(epoch(200, Some(restored.clone())), Some(EPOCH.to_owned()));
        let mut never = restored.clone();
        never.as_object_mut().unwrap().remove("restoreEpoch");
        assert_eq!(epoch(200, Some(never)), None, "a host never restored");
        assert_eq!(epoch(503, Some(restored.clone())), None);
        assert_eq!(epoch(200, None), None);
        let mut foreign = restored.clone();
        foreign["product"] = json!("other");
        assert_eq!(epoch(200, Some(foreign)), None, "not a Markiro host");
        let mut unreadable = restored;
        unreadable["restoreEpoch"] = json!(7);
        assert_eq!(epoch(200, Some(unreadable)), None);
    }
}
```

3. В `apps/standalone/src-tauri/tests/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::{DeviceState, HostLink};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
```

заменить на

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::{DeviceState, HostLink};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
```

4. В `apps/standalone/src-tauri/tests/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 1,
        })
    );
```

заменить на

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 1,
            restore_epoch: None,
        })
    );
```

5. В `apps/standalone/src-tauri/tests/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 1,
        }
    );
```

заменить на

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 1,
            restore_epoch: None,
        }
    );
```

6. В `apps/standalone/src-tauri/tests/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
    status_in(&mut heard, LinkState::Online).await;
    assert_eq!(next_revision(&mut heard).await, 0);
    task.abort();
    host.stop().await.unwrap();
```

заменить на

<!-- prettier-ignore -->
```rust
    status_in(&mut heard, LinkState::Online).await;
    assert_eq!(next_revision(&mut heard).await, 0);
    task.abort();
    host.stop().await.unwrap();
}

/// What `markiro-host restore` leaves in the stopped host's `site` (plan РК):
/// a new restore epoch, which `hello` names from then on.
async fn mark_restored(dir: &Path, epoch: &str) {
    let mut db = SqliteConnectOptions::new()
        .filename(HostPaths::new(dir).database_file())
        .connect()
        .await
        .unwrap();
    let marked = sqlx::query("UPDATE site SET restore_epoch = ? WHERE id = 1")
        .bind(epoch)
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(marked.rows_affected(), 1);
    db.close().await.unwrap();
}

#[tokio::test]
async fn the_online_status_names_the_epoch_of_a_restored_host() {
    const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let bound = host.addr.to_string();
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, state, task) = follow(device.watch_link());
    let first = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(
        first.restore_epoch, None,
        "a host never restored names none"
    );

    host.stop().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(offline.restore_epoch, None);
    mark_restored(host_dir.path(), EPOCH).await;
    let host = start_host(host_dir.path(), &bound).await;
    let back = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(back.restore_epoch.as_deref(), Some(EPOCH));
    assert_eq!(state.snapshot().restore_epoch.as_deref(), Some(EPOCH));
    task.abort();
    host.stop().await.unwrap();
```

7. В `apps/standalone/test/connection.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  });

  it("stops listening when asked", async () => {
    const events = fakeEvents();
```

заменить на

<!-- prettier-ignore -->
```typescript
  });

  it("passes on the restore epoch the shell read from the host's hello, and drops a malformed one", async () => {
    // `restoreEpoch` of `proto/fixtures/hello-restored.json`.
    const epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    const events = fakeEvents();
    const onStatus = vi.fn();
    await createTauriConnectionApi(async () => status(1), events.listen).watch({
      onStatus,
      onRevision: vi.fn(),
    });
    events.emit(HOST_STATUS_EVENT, { ...status(2), restoreEpoch: epoch });
    events.emit(HOST_STATUS_EVENT, { ...status(3), restoreEpoch: "epoch-1" });
    events.emit(HOST_STATUS_EVENT, { ...status(4), restoreEpoch: null });
    expect(onStatus.mock.calls).toEqual([[status(1)], [{ ...status(2), restoreEpoch: epoch }]]);
  });

  it("stops listening when asked", async () => {
    const events = fakeEvents();
```

- [ ] **Step 2: Тесты падают**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib connection`

Expected: FAIL при сборке: «error[E0560]: struct `connection::HostStatus` has no field named `restore_epoch`» и «error[E0425]: cannot find function `epoch_of` in this scope» (3 ошибки).

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test connection`

Expected: FAIL при сборке: «error[E0560]: struct `HostStatus` has no field named `restore_epoch`» и «error[E0609]: no field `restore_epoch` on type `HostStatus`» (6 ошибок).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/connection.test.ts`

Expected: FAIL: `Tests  1 failed | 5 passed (6)` — «passes on the restore epoch the shell read from the host's hello, and drops a malformed one».

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
//! the webview how the link is (`standalone://host-status`) and which
//! revision the host reached (`standalone://host-revision`). The webview syncs
//! reference data on every revision; it never opens the stream itself.

use std::convert::Infallible;
```

заменить на

<!-- prettier-ignore -->
```rust
//! the webview how the link is (`standalone://host-status`) and which
//! revision the host reached (`standalone://host-revision`). The webview syncs
//! reference data on every revision; it never opens the stream itself. Before
//! each stream it reads `GET /v1/hello` with the same pinned certificate, and
//! the `Online` status carries the host's restore epoch (plan РК-С).

use std::convert::Infallible;
```

2. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust

use crate::device::HostLink;
use crate::host_client::{HostResponse, RequestError, StreamClient, StreamOpen};

pub const STATUS_EVENT: &str = "standalone://host-status";
pub const REVISION_EVENT: &str = "standalone://host-revision";
const STREAM_PATH: &str = "/v1/changes/stream";
/// An event longer than this is not from a Markiro host.
const MAX_EVENT_BYTES: usize = 64 * 1024;
```

заменить на

<!-- prettier-ignore -->
```rust

use crate::device::HostLink;
use crate::host_client::{
    Credentials, HostResponse, PinnedClient, RequestError, StreamClient, StreamOpen,
};
use crate::host_probe::classify_hello;

pub const STATUS_EVENT: &str = "standalone://host-status";
pub const REVISION_EVENT: &str = "standalone://host-revision";
const STREAM_PATH: &str = "/v1/changes/stream";
const HELLO_PATH: &str = "/v1/hello";
/// An event longer than this is not from a Markiro host.
const MAX_EVENT_BYTES: usize = 64 * 1024;
```

3. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
    /// `connection_status` answer against events that raced it.
    pub seq: u64,
}

```

заменить на

<!-- prettier-ignore -->
```rust
    /// `connection_status` answer against events that raced it.
    pub seq: u64,
    /// The host's `hello.restoreEpoch` (plan РК-С) as the connection that came
    /// online last read it, with the pinned certificate, just before it opened
    /// the stream: a new value tells the webview the host went back to a copy.
    /// `None`, and absent from the JSON, before the host's first restore,
    /// before this pairing's first connection came online, and when that read
    /// failed: the stream opens all the same, and the next connection reads
    /// again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
}

```

4. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 0,
        }
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            last_error: None,
            seq: 0,
            restore_epoch: None,
        }
    }
```

5. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            current.last_error = None;
            current.last_contact_at = None;
        });
    }
```

заменить на

<!-- prettier-ignore -->
```rust
            current.last_error = None;
            current.last_contact_at = None;
            current.restore_epoch = None;
        });
    }
```

6. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if fresh_link {
                current.last_contact_at = None;
            }
        });
```

заменить на

<!-- prettier-ignore -->
```rust
            if fresh_link {
                current.last_contact_at = None;
                current.restore_epoch = None;
            }
        });
```

7. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
        Err(error) => return (request_error(error), false),
    };
    let mut stream = match client.open(STREAM_PATH, link.key()).await {
        Ok(StreamOpen::Open(stream)) => stream,
```

заменить на

<!-- prettier-ignore -->
```rust
        Err(error) => return (request_error(error), false),
    };
    // Read before the stream opens, so that the `Online` status its first
    // event publishes already carries it.
    let mut epoch = restore_epoch(link).await;
    let mut stream = match client.open(STREAM_PATH, link.key()).await {
        Ok(StreamOpen::Open(stream)) => stream,
```

8. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            if !online {
                online = true;
                state.publish(events, LinkState::Online, None);
            }
            if let SseItem::Revision(rev) = item {
```

заменить на

<!-- prettier-ignore -->
```rust
            if !online {
                online = true;
                let epoch = epoch.take();
                state.publish_with(events, |current| {
                    current.state = LinkState::Online;
                    current.last_error = None;
                    current.restore_epoch = epoch;
                });
            }
            if let SseItem::Revision(rev) = item {
```

9. В `apps/standalone/src-tauri/src/connection.rs` фрагмент

<!-- prettier-ignore -->
```rust
            }
        }
    }
}

fn request_error(error: RequestError) -> LinkError {
```

заменить на

<!-- prettier-ignore -->
```rust
            }
        }
    }
}

/// `GET /v1/hello` with the pinned certificate and no key: the host's restore
/// epoch, `None` when it names none or the read fails.
async fn restore_epoch(link: &HostLink) -> Option<String> {
    let client = PinnedClient::new(&link.address, &link.fingerprint).ok()?;
    let response = client
        .send("GET", HELLO_PATH, None, Credentials::default())
        .await
        .ok()?;
    epoch_of(&response)
}

/// The `restoreEpoch` of a `hello` answer: only from a 200 that reads as a
/// compatible Markiro host's `hello` (`host_probe::classify_hello`).
fn epoch_of(response: &HostResponse) -> Option<String> {
    if response.status != 200 {
        return None;
    }
    classify_hello(response.body.clone()?).ok()?.restore_epoch
}

fn request_error(error: RequestError) -> LinkError {
```

10. В `apps/standalone/src/host/protocol.ts` фрагмент

<!-- prettier-ignore -->
```typescript
    /** Grows with every status the shell publishes. */
    seq: z.number().int().nonnegative(),
  })
  .strict();
```

заменить на

<!-- prettier-ignore -->
```typescript
    /** Grows with every status the shell publishes. */
    seq: z.number().int().nonnegative(),
    /**
     * The host's `hello.restoreEpoch` as the connection that came online last
     * read it (plan РК-С); absent before the host's first restore and when
     * that read failed.
     */
    restoreEpoch: z.uuid().optional(),
  })
  .strict();
```

- [ ] **Step 4: Тесты проходят**

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib connection`

Expected: PASS: `test result: ok. 13 passed`.

Run (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test connection`

Expected: PASS: `test result: ok. 7 passed`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/connection.test.ts`

Expected: PASS: `Tests  6 passed (6)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Каждую — по процедуре «Заметок».

- **M1** (эпоха не читается): в `apps/standalone/src-tauri/src/connection.rs` `    let mut epoch = restore_epoch(link).await;` → `    let mut epoch: Option<String> = None;` (собирается с предупреждениями о неиспользуемом коде).
  Команда (вне песочницы): `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test connection`. Ожидается: FAIL — `the_online_status_names_the_epoch_of_a_restored_host`.
- **M2** (эпоха из ответа с ошибкой): в `apps/standalone/src-tauri/src/connection.rs` удалить три строки `    if response.status != 200 {` / `        return None;` / `    }` в `epoch_of`.
  Команда: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --lib connection`. Ожидается: FAIL — `connection::tests::the_epoch_comes_only_from_a_hello_that_reads`.
- **M3** (эпоха любой строкой): в `apps/standalone/src/host/protocol.ts` `    restoreEpoch: z.uuid().optional(),` → `    restoreEpoch: z.string().optional(),`.
  Команда: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/connection.test.ts`. Ожидается: FAIL — «passes on the restore epoch the shell read from the host's hello, and drops a malformed one».

Очистка эпохи при новом подключении и при отключении (`fresh_link`, `unpaired`) мутантом не проверяется: статус без `Online` вебвью не читает (задача 3), а статус `Online` всегда несёт эпоху своего подключения; очистка — гигиена, а не правило.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <изменённые TS, TSX, JSON, MD>` — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src-tauri/src/connection.rs apps/standalone/src-tauri/tests/connection.rs apps/standalone/src/host/protocol.ts apps/standalone/test/connection.test.ts
git commit -m "feat(standalone): the station's link reads the host's restore epoch from hello before each stream" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Что станция должна восстановленному хосту — обязательство `0009`, блоки по 64, отклонённые блоки, лента с нуля, записи 30 дней

Вся логика сверки — над базой станции и одним вызовом хоста, без связи и без экранов, поэтому она проверяется на `node:sqlite` с настоящими формами запроса и ответа. Новая эпоха — строка `floor_restore_epochs` без `reconciled_at`: это обязательство, оно переживает перезапуск. `reconcileRestore` отправляет все блоки подключения, израсходованные тоже (их номера напечатаны), по 64, ровно как хост их выдал, проверяет ответ по числу и по `id`; отклонённому блоку курсор уходит за конец в транзакции после этого ответа, так что ни один короб уже не закроется его номером. Затем одной транзакцией: метка `from_zero` для ленты, записи с квитанцией за 30 дней снова ждут отправки, обязательство закрыто — только если эпоха та, что прочитана (иначе `changes_mismatch`, и следующий прогон исполнит новую). `conflict` с `no_restore` — возвращать нечего; любой другой сбой — обязательство остаётся, следующий прогон отправляет всё снова (хост ответит `known`). Лента по метке идёт с ревизии 0 и стирает копии в транзакции первой страницы, как уже делает ветка «хост вернулся назад»: до неё копии рабочие. `HostApi.registerKnownBlocks` — маршрут хоста плана РК.

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0009_restore_epochs.sql`, `apps/standalone/src/local/restore-reconcile.ts`, `apps/standalone/test/restore-reconcile.test.ts`
- Modify: `apps/standalone/src-tauri/src/local_db.rs` (`TABLE_CLASSES`), `apps/standalone/src/local/reference-sync.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/test/support/office.tsx`
- Test: `apps/standalone/test/reference-sync.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/src-tauri/tests/local_db.rs`, `apps/standalone/test/local-executor.test.ts`, `apps/standalone/test/floor-schema.test.ts`

**Interfaces:**

- Consumes: `floor_sscc_blocks`, `outbox`, `sync_state` (миграции `0001`, `0006`); Zod `knownBlocksRequestSchema`, `knownBlocksResponseSchema`, типы `KnownBlocksRequest`, `KnownBlocksResponse` (`src/host/backups.ts`, план РК); `HostError`; `remainingSerials` (2a6, в тесте); фикстуры `known-blocks-request.json`, `known-blocks-response.json`.
- Produces: таблица `floor_restore_epochs(host_id, device_id, epoch, seen_at, reconciled_at, refused)`, `TableClass::Disposable`; `src/local/restore-reconcile.ts`: `MAX_KNOWN_BLOCKS = 64`, `RESEND_WINDOW_MS`, `class KnownBlocksMismatchError`, `noteRestoreEpoch(local, pairing, epoch, now: Date): Promise<boolean>`, `restoreDue(local, pairing): Promise<boolean>`, `readRestoreStatus(local, pairing): Promise<RestoreStatus>` (`{ due: boolean; refused: number }`), `reconcileRestore(context: ReconcileContext): Promise<ReconcileResult>` (`ReconcileContext = { local, pairing, register, now }`, `ReconcileResult = { kind: "none" } | { kind: "reconciled"; epoch; registered; known; refused }`); `reference-sync.ts`: `FROM_ZERO_SQL`; `HostApi.registerKnownBlocks(request): Promise<KnownBlocksResponse>`.

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/restore-reconcile.test.ts`:

<!-- prettier-ignore -->
```typescript
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { remainingSerials } from "../src/floor/work/block-supply.js";
import {
  knownBlocksRequestSchema,
  knownBlocksResponseSchema,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import { LocalDbError } from "../src/local/executor.js";
import {
  KnownBlocksMismatchError,
  MAX_KNOWN_BLOCKS,
  noteRestoreEpoch,
  readRestoreStatus,
  reconcileRestore,
  restoreDue,
  RESEND_WINDOW_MS,
} from "../src/local/restore-reconcile.js";
import {
  failingWrites,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/** The block of `known-blocks-request.json`, as the host once issued it to this station. */
const REQUEST = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
const [FIXTURE_BLOCK] = REQUEST.blocks;
/** `restoreEpoch` of `hello-restored.json`, and the epoch of a later restore. */
const EPOCH = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const LATER_EPOCH = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const NOW = new Date("2026-10-11T08:00:00.000Z");

/** Block ids `…b0001`, `…b0002`, … */
function blockId(index: number): string {
  return `00000000-0000-4000-8000-b${String(index).padStart(11, "0")}`;
}

/** The fixture's block, received first, then `more` blocks of 2 000 serials above it. */
function seedBlocks(db: DatabaseSync, more = 0): void {
  if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
  seedBlock(db, {
    blockId: FIXTURE_BLOCK.id,
    from: FIXTURE_BLOCK.fromSerial,
    to: FIXTURE_BLOCK.toSerial,
    next: FIXTURE_BLOCK.fromSerial + 100,
    receivedAt: "2026-10-08T06:00:00.000Z",
  });
  for (let index = 1; index <= more; index += 1) {
    const from = FIXTURE_BLOCK.toSerial + 1 + (index - 1) * 2000;
    seedBlock(db, {
      blockId: blockId(index),
      from,
      to: from + 1999,
      receivedAt: `2026-10-09T06:${String(index % 60).padStart(2, "0")}:00.000Z`,
    });
  }
}

/** The host's answer: each block `known`, unless `outcomes` names another. */
function answering(outcomes: Record<string, KnownBlocksResponse["results"][number]> = {}) {
  return vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> =>
    knownBlocksResponseSchema.parse({
      results: request.blocks.map(
        (block) => outcomes[block.id] ?? { id: block.id, outcome: "known", code: null },
      ),
    }),
  );
}

function refused(id: string, code: string) {
  return { id, outcome: "refused" as const, code };
}

function epochs(db: DatabaseSync) {
  return rows(
    db,
    "SELECT host_id, device_id, epoch, seen_at, reconciled_at, refused FROM floor_restore_epochs " +
      "ORDER BY device_id",
  );
}

function fromZero(db: DatabaseSync) {
  return rows(db, "SELECT value FROM sync_state WHERE key = 'from_zero'");
}

describe("the host's restore epoch on the station", () => {
  it("is noted once per pairing, and the station owes the host its blocks until it reconciles", async () => {
    const { db, executor } = openLocalDb();
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(true);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date(NOW.getTime() + 1))).toBe(
      false,
    );
    expect(epochs(db)).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        epoch: EPOCH,
        seen_at: NOW.toISOString(),
        reconciled_at: null,
        refused: 0,
      },
    ]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    // Another pairing's epoch is its own.
    const other = { ...PAIRING, deviceId: OTHER_DEVICE };
    expect(await restoreDue(executor, other)).toBe(false);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: answering(),
      now: () => NOW,
    });
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    expect(await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW)).toBe(false);
    expect(await restoreDue(executor, PAIRING)).toBe(false);
    // A later restore owes everything again.
    expect(await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW)).toBe(true);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    expect(epochs(db)).toMatchObject([{ epoch: LATER_EPOCH, reconciled_at: null, refused: 0 }]);
  });

  it("does nothing while no new epoch is owed", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    const register = answering();
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "none" });
    expect(register).not.toHaveBeenCalled();
    expect(fromZero(db)).toEqual([]);
  });
});

describe("the reconciliation after a restore", () => {
  it("sends every block of the pairing as the host issued it, in requests of 64", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    seedBlock(db, { blockId: blockId(999), from: 900_000, to: 901_999, deviceId: OTHER_DEVICE });
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering({
      [blockId(1)]: { id: blockId(1), outcome: "registered", code: null },
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 1, known: 64, refused: 0 });
    const sent = register.mock.calls.map(([request]) => request);
    expect(sent.map((request) => request.blocks.length)).toEqual([64, 1]);
    // The station's first block goes exactly as the host's fixture names it.
    expect(sent[0]?.blocks[0]).toEqual(FIXTURE_BLOCK);
    for (const request of sent) expect(knownBlocksRequestSchema.parse(request)).toEqual(request);
    expect(sent.flatMap((request) => request.blocks).map((block) => block.id)).not.toContain(
      blockId(999),
    );
    expect(epochs(db)).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        epoch: EPOCH,
        seen_at: NOW.toISOString(),
        reconciled_at: NOW.toISOString(),
        refused: 0,
      },
    ]);
  });

  it("stops using every block the host refused, so the boxes close from the blocks it kept", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, 2);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const before = await remainingSerials(executor, PAIRING, PREFIX);
    expect(before).toBe(1900 + 2000 + 2000);
    const register = answering({
      [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap"),
      [blockId(2)]: refused(blockId(2), "prefix_unknown"),
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 1, refused: 2 });
    expect(
      rows(db, "SELECT block_id, next_serial, to_serial FROM floor_sscc_blocks ORDER BY block_id"),
    ).toEqual([
      { block_id: blockId(1), next_serial: 5500, to_serial: 7499 },
      { block_id: blockId(2), next_serial: 9500, to_serial: 9499 },
      { block_id: FIXTURE_BLOCK.id, next_serial: 5500, to_serial: 5499 },
    ]);
    expect(await remainingSerials(executor, PAIRING, PREFIX)).toBe(2000);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({ due: false, refused: 2 });
  });

  it("asks the next sync to start from zero and sends the records of the last 30 days again", async () => {
    const { db, executor } = openLocalDb();
    const [recent, old, waiting] = await unsentScans(executor, 3);
    const ack = (id: string | undefined, at: Date) =>
      db
        .prepare(
          "UPDATE outbox SET outcome = 'rejected', outcome_code = 'sscc_not_issued', " +
            "outcome_details = '{\"x\":1}', acked_at = ? WHERE id = ?",
        )
        .run(at.toISOString(), id ?? "");
    ack(recent, new Date(NOW.getTime() - RESEND_WINDOW_MS + 60_000));
    ack(old, new Date(NOW.getTime() - RESEND_WINDOW_MS - 60_000));
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = answering();
    await reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW });
    // No block: nothing to ask the host.
    expect(register).not.toHaveBeenCalled();
    expect(
      rows(
        db,
        "SELECT id, outcome, outcome_code, outcome_details, acked_at FROM outbox ORDER BY seq",
      ),
    ).toEqual([
      { id: recent, outcome: null, outcome_code: null, outcome_details: null, acked_at: null },
      {
        id: old,
        outcome: "rejected",
        outcome_code: "sscc_not_issued",
        outcome_details: '{"x":1}',
        acked_at: new Date(NOW.getTime() - RESEND_WINDOW_MS - 60_000).toISOString(),
      },
      { id: waiting, outcome: null, outcome_code: null, outcome_details: null, acked_at: null },
    ]);
    expect(fromZero(db)).toEqual([{ value: EPOCH }]);
  });

  it("keeps owing the blocks when a request fails, and the next run sends them all again", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    const [recent] = await unsentScans(executor, 1);
    db.prepare("UPDATE outbox SET outcome = 'accepted', acked_at = ? WHERE id = ?").run(
      NOW.toISOString(),
      recent ?? "",
    );
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const register = answering({ [FIXTURE_BLOCK.id]: refused(FIXTURE_BLOCK.id, "block_overlap") });
    const first = register.getMockImplementation();
    register.mockImplementationOnce(async (request) => {
      if (first === undefined) throw new Error("no answer");
      return first(request);
    });
    register.mockImplementationOnce(async () => {
      throw down;
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBe(down);
    // The refused block is not used meanwhile; nothing else moved.
    expect(
      rows(db, "SELECT next_serial FROM floor_sscc_blocks WHERE block_id = ?", FIXTURE_BLOCK.id),
    ).toEqual([{ next_serial: 5500 }]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
    expect(fromZero(db)).toEqual([]);
    expect(rows(db, "SELECT acked_at FROM outbox")).toEqual([{ acked_at: NOW.toISOString() }]);

    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 64, refused: 1 });
    expect(register.mock.calls.map(([request]) => request.blocks.length)).toEqual([64, 1, 64, 1]);
    expect(epochs(db)).toMatchObject([{ reconciled_at: NOW.toISOString(), refused: 1 }]);
    expect(rows(db, "SELECT acked_at FROM outbox")).toEqual([{ acked_at: null }]);
  });

  it("owes nothing more to a host that says it was never restored", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, MAX_KNOWN_BLOCKS);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "the host was never restored: it lost no block",
        details: { constraint: "no_restore" },
      });
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).resolves.toEqual({ kind: "reconciled", epoch: EPOCH, registered: 0, known: 0, refused: 0 });
    expect(register).toHaveBeenCalledTimes(1);
    expect(fromZero(db)).toEqual([{ value: EPOCH }]);
  });

  it("keeps owing the blocks after any other refusal of the host", async () => {
    const { executor, db } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const forbidden = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "other",
      details: { constraint: "something_else" },
    });
    const register = vi.fn(async (): Promise<KnownBlocksResponse> => {
      throw forbidden;
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toBe(forbidden);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });

  it("keeps nothing of an answer that does not answer the blocks sent", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db, 1);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    if (FIXTURE_BLOCK === undefined) throw new Error("the fixture names a block");
    const short = vi.fn(async (): Promise<KnownBlocksResponse> => ({
      results: [refused(FIXTURE_BLOCK.id, "block_overlap")],
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register: short, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    const swapped = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => ({
      results: request.blocks.map((_, index) =>
        refused(request.blocks[1 - index]?.id ?? "", "block_overlap"),
      ),
    }));
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register: swapped, now: () => NOW }),
    ).rejects.toBeInstanceOf(KnownBlocksMismatchError);
    expect(
      rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks WHERE next_serial > to_serial"),
    ).toEqual([{ n: 0 }]);
    expect(await restoreDue(executor, PAIRING)).toBe(true);
  });

  it("does not settle a later epoch noted while it ran", async () => {
    const { db, executor } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    const register = vi.fn(async (request: KnownBlocksRequest): Promise<KnownBlocksResponse> => {
      // The host was restored again while the first answer was on its way.
      await noteRestoreEpoch(executor, PAIRING, LATER_EPOCH, NOW);
      return {
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      };
    });
    await expect(
      reconcileRestore({ local: executor, pairing: PAIRING, register, now: () => NOW }),
    ).rejects.toMatchObject({ code: "changes_mismatch" });
    await expect(
      reconcileRestore({
        local: executor,
        pairing: PAIRING,
        register: answering(),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ kind: "reconciled", epoch: LATER_EPOCH });
    expect(fromZero(db)).toEqual([{ value: LATER_EPOCH }]);
  });

  it("keeps owing everything when this computer cannot write the end", async () => {
    const { executor, db } = openLocalDb();
    seedBlocks(db);
    await noteRestoreEpoch(executor, PAIRING, EPOCH, NOW);
    await expect(
      reconcileRestore({
        local: failingWrites(executor),
        pairing: PAIRING,
        register: answering(),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(await readRestoreStatus(executor, PAIRING)).toEqual({ due: true, refused: 0 });
  });
});
```

2. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  createSyncScheduler,
  ENTITY_SET,
  SyncFeedError,
  syncReferences,
```

заменить на

<!-- prettier-ignore -->
```typescript
  createSyncScheduler,
  ENTITY_SET,
  FROM_ZERO_SQL,
  SyncFeedError,
  syncReferences,
```

3. В `apps/standalone/test/reference-sync.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
    // case where it actually holds an entry).
    expect(quarantine(db)).toEqual([]);
  });

```

заменить на

<!-- prettier-ignore -->
```typescript
    // case where it actually holds an entry).
    expect(quarantine(db)).toEqual([]);
  });

  it("starts from zero once after a restore asked it, keeping the copies until the first page", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Plan РК-С: the station saw the host's new restore epoch. The restored
    // host answers the copy's revision plus one, which may be above the
    // station's 20, so the host going back is not seen in the feed.
    await executor.transaction([
      { sql: FROM_ZERO_SQL, values: ["5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e"] },
    ]);
    const before = tables(db);
    const down = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: down, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(down.mock.calls).toEqual([[0]]);
    // The copies stay usable until the first page from zero lands.
    expect(tables(db).lines).toEqual(before.lines);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: DEVICE_ID })).toBe(true);

    const changes = feed({ 0: page(25, [line(LINE_1, 25, "Линия 1 (из копии)")]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 25, quarantined: 0 });
    expect(changes.mock.calls).toEqual([[0]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (из копии)", archived: 0, rev: 25 },
    ]);
    // The wipe took the mark with it: the next sync goes on from 25.
    expect(tables(db).state).toEqual(state(25));
    const next = feed({ 25: page(25, []) });
    await syncReferences({ changes: next, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(next.mock.calls).toEqual([[25]]);
  });

```

4. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript

import { CODE_CHECK_TIMEOUT_MS, createHostApi, type HostApi } from "../src/host/api.js";
import {
  createTauriHostClient,
```

заменить на

<!-- prettier-ignore -->
```typescript

import { CODE_CHECK_TIMEOUT_MS, createHostApi, type HostApi } from "../src/host/api.js";
import { knownBlocksRequestSchema } from "../src/host/backups.js";
import {
  createTauriHostClient,
```

5. В `apps/standalone/test/api.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  });

  it("is stood in for by a fake that refuses the three calls loudly until a test stubs them", async () => {
    const fake = fakeHostApi();
```

заменить на

<!-- prettier-ignore -->
```typescript
  });

  it("gives the host back the station's blocks after a restore, with the device key only", async () => {
    const request = knownBlocksRequestSchema.parse(fixture("known-blocks-request.json"));
    const known = recording(fixture("known-blocks-response.json"));
    await expect(known.api.registerKnownBlocks(request)).resolves.toEqual(
      fixture("known-blocks-response.json"),
    );
    expect(known.sent).toEqual([
      {
        method: "POST",
        path: "/v1/device/sscc/blocks/known",
        body: request,
        officeToken: undefined,
      },
    ]);
    await expect(
      recording({ results: [{ id: "x", outcome: "lost", code: null }] }).api.registerKnownBlocks(
        request,
      ),
    ).rejects.toThrow();
    await expect(fakeHostApi().registerKnownBlocks(request)).rejects.toThrow(
      "unexpected HostApi.registerKnownBlocks call",
    );
  });

  it("is stood in for by a fake that refuses the three calls loudly until a test stubs them", async () => {
    const fake = fakeHostApi();
```

6. В `apps/standalone/src-tauri/tests/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

заменить на

<!-- prettier-ignore -->
```rust
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_restore_epochs",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

7. В `apps/standalone/test/local-executor.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      "floor_codes",
      "floor_exceptions",
      "floor_scans",
      "floor_shifts",
```

заменить на

<!-- prettier-ignore -->
```typescript
      "floor_codes",
      "floor_exceptions",
      "floor_restore_epochs",
      "floor_scans",
      "floor_shifts",
```

8. В `apps/standalone/test/floor-schema.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      z.object({ tableName: z.string(), columnName: z.string(), required: z.number() }),
    );
    expect(columns).toEqual(
      DEVICE_TABLES.flatMap((tableName) => [
        { tableName, columnName: "device_id", required: 1 },
        { tableName, columnName: "host_id", required: 1 },
```

заменить на

<!-- prettier-ignore -->
```typescript
      z.object({ tableName: z.string(), columnName: z.string(), required: z.number() }),
    );
    // `floor_restore_epochs` (migration `0009`) is a pairing's own
    // bookkeeping that a forget empties, tagged the same way.
    expect(columns).toEqual(
      [...DEVICE_TABLES, "floor_restore_epochs"].sort().flatMap((tableName) => [
        { tableName, columnName: "device_id", required: 1 },
        { tableName, columnName: "host_id", required: 1 },
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/restore-reconcile.test.ts test/reference-sync.test.ts test/api.test.ts test/local-executor.test.ts test/floor-schema.test.ts`

Expected: FAIL: `Test Files  5 failed (5)`, `Tests  4 failed | 221 passed (225)` — `restore-reconcile.test.ts` не собирается («Failed to resolve import "../src/local/restore-reconcile.js"»), «starts from zero once after a restore asked it, keeping the copies until the first page» (`Cannot read properties of undefined (reading 'trim')`: `FROM_ZERO_SQL` ещё нет), «gives the host back the station's blocks after a restore, with the device key only» (`registerKnownBlocks is not a function`), «has exactly the shell's tables» и «tag every row with its pairing and have no foreign key» (таблицы `floor_restore_epochs` ещё нет).

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test local_db`

Expected: FAIL: `test result: FAILED. 26 passed; 1 failed` — `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data`.

- [ ] **Step 3: Реализация**

1. Создать `apps/standalone/src-tauri/migrations/0009_restore_epochs.sql`:

<!-- prettier-ignore -->
```sql
-- Plan РК-С: the station's side of a host restored from a copy. The host's
-- `hello` names a new `restoreEpoch` at every restore (plan РК); the link
-- reads it on each connection, and a pairing that sees a new one owes the
-- host its SSCC blocks (`POST /v1/device/sscc/blocks/known`), a sync of the
-- copies from zero and its acknowledged records of the last 30 days again.
-- The row is that obligation: written before anything else is done, it
-- survives a restart, and the outbox waits while `reconciled_at` is NULL.
-- `refused` counts the blocks the host refused at the last reconciliation:
-- no serial of them is used again (`next_serial` past their end), and the
-- floor's status bar says how many. One row per pairing, no foreign key (see
-- `0006`); a forget empties the table with the copies
-- (`TableClass::Disposable`): the new pairing owes the host nothing of the
-- old one's. Times are UTC RFC 3339 text as `Date.toISOString` writes it.
CREATE TABLE floor_restore_epochs (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  reconciled_at TEXT,
  refused INTEGER NOT NULL DEFAULT 0 CHECK (refused >= 0),
  PRIMARY KEY (host_id, device_id)
);
```

2. В `apps/standalone/src-tauri/src/local_db.rs` фрагмент

<!-- prettier-ignore -->
```rust
    ("floor_codes", TableClass::DeviceData),
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_scans", TableClass::DeviceData),
    ("floor_shifts", TableClass::DeviceData),
```

заменить на

<!-- prettier-ignore -->
```rust
    ("floor_codes", TableClass::DeviceData),
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_restore_epochs", TableClass::Disposable),
    ("floor_scans", TableClass::DeviceData),
    ("floor_shifts", TableClass::DeviceData),
```

3. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** Makes the copies read as unsynced: `readState` then starts from zero. */
const DROP_LAST_REV = "DELETE FROM sync_state WHERE key = 'last_rev'";
```

заменить на

<!-- prettier-ignore -->
```typescript
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Asks the next sync to start from zero (plan РК-С: the host went back to a
 * copy, and its revision may still be above the one the copies reached): it
 * fetches from revision 0, and its first page wipes the copies in the
 * transaction that refills them, so they stay usable until then. The wipe
 * deletes this mark with the rest of `sync_state`. The value is the epoch.
 */
export const FROM_ZERO_SQL =
  "INSERT INTO sync_state (key, value) VALUES ('from_zero', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** Makes the copies read as unsynced: `readState` then starts from zero. */
const DROP_LAST_REV = "DELETE FROM sync_state WHERE key = 'last_rev'";
```

4. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  deviceId: string | null;
  entitySet: string | null;
}

```

заменить на

<!-- prettier-ignore -->
```typescript
  deviceId: string | null;
  entitySet: string | null;
  /** `FROM_ZERO_SQL` asked the next run to start from zero. */
  fromZero: boolean;
}

```

5. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```typescript
    deviceId: value("device_id"),
    entitySet: value("entity_set"),
  };
}
```

заменить на

<!-- prettier-ignore -->
```typescript
    deviceId: value("device_id"),
    entitySet: value("entity_set"),
    fromZero: value("from_zero") !== null,
  };
}
```

6. В `apps/standalone/src/local/reference-sync.ts` фрагмент

<!-- prettier-ignore -->
```typescript
    stored.lastRev !== null
  ) {
    since = stored.lastRev;
  } else {
    if (stored.hostId === null || stored.deviceId === null) {
```

заменить на

<!-- prettier-ignore -->
```typescript
    stored.lastRev !== null
  ) {
    // A restore of the host asks for the whole feed again (`FROM_ZERO_SQL`):
    // the first page wipes the copies as it refills them.
    since = stored.fromZero ? 0 : stored.lastRev;
    wipe = stored.fromZero;
  } else {
    if (stored.hostId === null || stored.deviceId === null) {
```

7. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```typescript
import { z } from "zod";

import { backupStateSchema, type BackupSettingsUpdate, type BackupState } from "./backups.js";
import type { HostClient } from "./client.js";
import {
```

заменить на

<!-- prettier-ignore -->
```typescript
import { z } from "zod";

import {
  backupStateSchema,
  knownBlocksResponseSchema,
  type BackupSettingsUpdate,
  type BackupState,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "./backups.js";
import type { HostClient } from "./client.js";
import {
```

8. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```typescript
   */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /** The copies in both folders (plan РК); every office role reads them. */
  getBackups: (token: string) => Promise<BackupState>;
```

заменить на

<!-- prettier-ignore -->
```typescript
   */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /**
   * After the host's restore epoch changed (plan РК-С): blocks this station
   * holds, 1-64 a request, as the host issued them; a result for each, in
   * their order. Stations only; `conflict` on `no_restore` from a host that
   * was never restored.
   */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  /** The copies in both folders (plan РК); every office role reads them. */
  getBackups: (token: string) => Promise<BackupState>;
```

9. В `apps/standalone/src/host/api.ts` фрагмент

<!-- prettier-ignore -->
```typescript
        })
      ).receipts,
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
```

заменить на

<!-- prettier-ignore -->
```typescript
        })
      ).receipts,
    registerKnownBlocks: (request) =>
      client.request("POST", "/v1/device/sscc/blocks/known", {
        body: request,
        schema: knownBlocksResponseSchema,
      }),
    closeShift: (token, id, close) =>
      client.request("POST", `/v1/office/shifts/${id}/close`, {
```

10. В `apps/standalone/test/support/office.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    checkCode: vi.fn<HostApi["checkCode"]>(() => unexpected("checkCode")),
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
    // «Обзор» reads the copies on every office test: healthy ones warn of nothing.
    getBackups: vi.fn<HostApi["getBackups"]>(async () => HEALTHY_BACKUPS),
```

заменить на

<!-- prettier-ignore -->
```tsx
    checkCode: vi.fn<HostApi["checkCode"]>(() => unexpected("checkCode")),
    sendFacts: vi.fn<HostApi["sendFacts"]>(() => unexpected("sendFacts")),
    registerKnownBlocks: vi.fn<HostApi["registerKnownBlocks"]>(() =>
      unexpected("registerKnownBlocks"),
    ),
    // «Обзор» reads the copies on every office test: healthy ones warn of nothing.
    getBackups: vi.fn<HostApi["getBackups"]>(async () => HEALTHY_BACKUPS),
```

11. Создать `apps/standalone/src/local/restore-reconcile.ts`:

<!-- prettier-ignore -->
```typescript
import { z } from "zod";

import type { KnownBlocksRequest, KnownBlocksResponse } from "../host/backups.js";
import { HostError } from "../host/client.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";
import { FROM_ZERO_SQL, type Pairing } from "./reference-sync.js";

/** The most blocks one `POST /v1/device/sscc/blocks/known` carries (`known_blocks::MAX_BLOCKS`). */
export const MAX_KNOWN_BLOCKS = 64;

/**
 * How far back a reconciliation sends the acknowledged records again: the
 * station keeps them 30 days (stage 2a, decision 31), so a copy of the host
 * younger than that gets back every record it lost.
 */
export const RESEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The host's answer does not answer the blocks sent: nothing of it is kept, and the run fails. */
export class KnownBlocksMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnownBlocksMismatchError";
  }
}

/**
 * Notes the host's restore epoch for this pairing (migration `0009`): a new
 * one — the first this pairing sees, or another than the last — makes the
 * pairing owe the host its blocks again, and the outbox waits until
 * `reconcileRestore` settles it. Returns whether the epoch was new.
 */
export async function noteRestoreEpoch(
  local: LocalExecutor,
  pairing: Pairing,
  epoch: string,
  now: Date,
): Promise<boolean> {
  const [changed] = await local.transaction([
    {
      sql:
        "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (host_id, device_id) DO UPDATE SET epoch = excluded.epoch, " +
        "seen_at = excluded.seen_at, reconciled_at = NULL, refused = 0 " +
        "WHERE floor_restore_epochs.epoch <> excluded.epoch",
      values: [pairing.hostId, pairing.deviceId, epoch, now.toISOString()],
    },
  ]);
  return changed === 1;
}

const dueRow = z.object({ epoch: z.string() });

const DUE_SQL =
  "SELECT epoch FROM floor_restore_epochs WHERE host_id = ? AND device_id = ? " +
  "AND reconciled_at IS NULL";

/** Whether this pairing still owes the host its blocks after a restore: the outbox waits meanwhile. */
export async function restoreDue(local: LocalExecutor, pairing: Pairing): Promise<boolean> {
  const due = await local.query(DUE_SQL, [pairing.hostId, pairing.deviceId], dueRow);
  return due.length > 0;
}

const statusRow = z.object({
  due: z.number().int(),
  refused: z.number().int().nonnegative(),
});

/** What the floor's status bar says of a restore: whether blocks are owed, and how many the host refused. */
export interface RestoreStatus {
  due: boolean;
  refused: number;
}

export async function readRestoreStatus(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<RestoreStatus> {
  const [row] = await local.query(
    "SELECT reconciled_at IS NULL AS due, refused FROM floor_restore_epochs " +
      "WHERE host_id = ? AND device_id = ?",
    [pairing.hostId, pairing.deviceId],
    statusRow,
  );
  return row === undefined
    ? { due: false, refused: 0 }
    : { due: row.due === 1, refused: row.refused };
}

const blockRow = z.object({
  block_id: z.string(),
  issuer_prefix: z.string(),
  extension: z.number().int(),
  from_serial: z.number().int(),
  to_serial: z.number().int(),
});

/** Every block this pairing holds, in the order they arrived: the used up ones too, their serials are printed. */
const BLOCKS_SQL =
  "SELECT block_id, issuer_prefix, extension, from_serial, to_serial FROM floor_sscc_blocks " +
  "WHERE host_id = ? AND device_id = ? ORDER BY received_at, block_id";

/** No serial of these blocks (`ids`, a JSON array) is used again: the cursor goes past the end. */
function retireStatement(pairing: Pairing, ids: string): LocalStatement {
  return {
    sql:
      "UPDATE floor_sscc_blocks SET next_serial = to_serial + 1 " +
      "WHERE host_id = ? AND device_id = ? AND block_id IN (SELECT value FROM json_each(?))",
    values: [pairing.hostId, pairing.deviceId, ids],
  };
}

/** The records the host acknowledged since `since`: waiting again, as if never sent. */
function reopenStatement(pairing: Pairing, since: string): LocalStatement {
  return {
    sql:
      "UPDATE outbox SET outcome = NULL, outcome_code = NULL, outcome_details = NULL, " +
      "acked_at = NULL WHERE host_id = ? AND device_id = ? AND acked_at >= ?",
    values: [pairing.hostId, pairing.deviceId, since],
  };
}

/** A host that was never restored lost no block (`conflict` on `no_restore`). */
function neverRestored(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.kind === "api" &&
    error.code === "conflict" &&
    error.details["constraint"] === "no_restore"
  );
}

export interface ReconcileContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** `HostApi.registerKnownBlocks`. */
  register: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  now: () => Date;
}

export type ReconcileResult =
  | { kind: "none" }
  | { kind: "reconciled"; epoch: string; registered: number; known: number; refused: number };

/**
 * What a pairing owes a host restored from a copy (plan РК-С, pilot spec
 * §11), once `noteRestoreEpoch` noted the new epoch:
 *
 * 1. every block it holds goes back, 64 to a request, as the host issued it;
 *    a block the host refuses (`block_overlap`, `block_mismatch`,
 *    `prefix_unknown`, `range_invalid`) is never used again — its cursor goes
 *    past its end in the transaction after that answer — so no box closes
 *    with a serial that may be another device's or that the host will refuse;
 * 2. then, in ONE transaction: the next sync starts from zero
 *    (`FROM_ZERO_SQL`), the records acknowledged in the last 30 days wait to
 *    go again (the host answers a record it has with the receipt it keeps,
 *    and takes one it lost), and the epoch is settled with the count of the
 *    refused blocks — only if it is still the epoch this run read, or a later
 *    restore noted meanwhile fails the batch (`changes_mismatch`) and is
 *    settled by the next run.
 *
 * A failed request or write rejects, and the next run sends every block
 * again (the host answers `known` for one it took). A host that says it was
 * never restored owes nothing back. Nothing is asked of the host for a
 * pairing without blocks.
 */
export async function reconcileRestore(context: ReconcileContext): Promise<ReconcileResult> {
  const { local, pairing, register, now } = context;
  const [due] = await local.query(DUE_SQL, [pairing.hostId, pairing.deviceId], dueRow);
  if (due === undefined) return { kind: "none" };
  const blocks = await local.query(BLOCKS_SQL, [pairing.hostId, pairing.deviceId], blockRow);
  let registered = 0;
  let known = 0;
  let refused = 0;
  for (let start = 0; start < blocks.length; start += MAX_KNOWN_BLOCKS) {
    const chunk = blocks.slice(start, start + MAX_KNOWN_BLOCKS);
    let answer: KnownBlocksResponse;
    try {
      answer = await register({
        blocks: chunk.map((block) => ({
          id: block.block_id,
          issuerPrefix: block.issuer_prefix,
          extension: block.extension,
          fromSerial: block.from_serial,
          toSerial: block.to_serial,
        })),
      });
    } catch (error) {
      if (neverRestored(error)) break;
      throw error;
    }
    if (answer.results.length !== chunk.length) {
      throw new KnownBlocksMismatchError(
        `${answer.results.length} results for ${chunk.length} blocks`,
      );
    }
    const refusedHere: string[] = [];
    chunk.forEach((block, index) => {
      const result = answer.results[index];
      if (result === undefined || result.id !== block.block_id) {
        throw new KnownBlocksMismatchError(`result ${index} names another block`);
      }
      if (result.outcome === "registered") registered += 1;
      else if (result.outcome === "known") known += 1;
      else refusedHere.push(block.block_id);
    });
    if (refusedHere.length > 0) {
      await local.transaction([retireStatement(pairing, JSON.stringify(refusedHere))]);
      refused += refusedHere.length;
    }
  }
  const at = now();
  await local.transaction([
    { sql: FROM_ZERO_SQL, values: [due.epoch] },
    reopenStatement(pairing, new Date(at.getTime() - RESEND_WINDOW_MS).toISOString()),
    {
      sql:
        "UPDATE floor_restore_epochs SET reconciled_at = ?, refused = ? " +
        "WHERE host_id = ? AND device_id = ? AND epoch = ? AND reconciled_at IS NULL",
      values: [at.toISOString(), refused, pairing.hostId, pairing.deviceId, due.epoch],
      expectedChanges: 1,
    },
  ]);
  return { kind: "reconciled", epoch: due.epoch, registered, known, refused };
}
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/restore-reconcile.test.ts test/reference-sync.test.ts test/api.test.ts test/local-executor.test.ts test/floor-schema.test.ts`

Expected: PASS: `Test Files  5 passed (5)`, `Tests  236 passed (236)`.

Run: `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked -p markiro-standalone --test local_db`

Expected: PASS: `test result: ok. 27 passed` (`every_table_has_a_forget_class` видит `floor_restore_epochs` в `TABLE_CLASSES`).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `… run lint`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Файл — `apps/standalone/src/local/restore-reconcile.ts`, если не сказано иначе; команда — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/restore-reconcile.test.ts` (R7, R8 — `test/reference-sync.test.ts`).

- **R1** (отклонённый блок остаётся в работе): удалить строку `      await local.transaction([retireStatement(pairing, JSON.stringify(refusedHere))]);`. Ожидается: FAIL — «stops using every block the host refused, so the boxes close from the blocks it kept», «keeps owing the blocks when a request fails, and the next run sends them all again».
- **R2** (снова открываются все записи, без окна): `acked_at = NULL WHERE host_id = ? AND device_id = ? AND acked_at >= ?` → `acked_at = NULL WHERE host_id = ? AND device_id = ? AND ? IS NOT NULL`. Ожидается: FAIL — «asks the next sync to start from zero and sends the records of the last 30 days again».
- **R3** (обязательство закрывается без проверки эпохи): удалить строку `      expectedChanges: 1,`. Ожидается: FAIL — «does not settle a later epoch noted while it ran».
- **R4** (`no_restore` — как любой сбой): удалить строку `      if (neverRestored(error)) break;`. Ожидается: FAIL — «owes nothing more to a host that says it was never restored».
- **R5** (ответ не сверяется по `id`): `if (result === undefined || result.id !== block.block_id) {` → `if (result === undefined) {`. Ожидается: FAIL — «keeps nothing of an answer that does not answer the blocks sent».
- **R6** (та же эпоха — снова новая): `        "WHERE floor_restore_epochs.epoch <> excluded.epoch",` → `        "WHERE true",`. Ожидается: FAIL — «is noted once per pairing, and the station owes the host its blocks until it reconciles».
- **R7** (метка без стирания копий): в `apps/standalone/src/local/reference-sync.ts` `    wipe = stored.fromZero;` → `    wipe = false;`. Ожидается: FAIL — «starts from zero once after a restore asked it, keeping the copies until the first page».
- **R8** (метка не читается): в `apps/standalone/src/local/reference-sync.ts` `    since = stored.fromZero ? 0 : stored.lastRev;` → `    since = stored.lastRev;`. Ожидается: FAIL — тот же тест.

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <изменённые TS, TSX, JSON, MD>` — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src-tauri/migrations/0009_restore_epochs.sql apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs apps/standalone/src/local/restore-reconcile.ts apps/standalone/src/local/reference-sync.ts apps/standalone/src/host/api.ts apps/standalone/test/restore-reconcile.test.ts apps/standalone/test/reference-sync.test.ts apps/standalone/test/api.test.ts apps/standalone/test/local-executor.test.ts apps/standalone/test/floor-schema.test.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): the station settles a restore of the host: its SSCC blocks back, the copies from zero, its recent records again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Связь и цех — сверка до очереди, удержание `restore_pending`, три строки состояния

`useHostLink` записывает новую эпоху из статуса `Online` и запускает сверку; сверка — ещё один планировщик связи: при каждом событии связи (подписка, ревизия, возврат на связь), с ожиданиями ленты после сбоя, а после успеха — синхронизация справочников с нуля и отправка очереди. Отправка очереди сначала сама записывает новую эпоху (оболочка в приложении отвечает позже, чем тест, поэтому без этого очередь могла бы уйти раньше обязательства — тест держит запись «медленной», как `local_transaction`), затем спрашивает `restoreDue` и, пока блоки не возвращены, ничего не шлёт. Ответ `restore_pending` — сбой `held`: повтор ровно через `RESTORE_HOLD_RETRY_MS`, а не через 2, 4, 8 с; цех работает как без хоста, проверки кодов пропускают скан при любом сбое, как и раньше. Строка состояния читает состояние сверки вместе с очередью (`outboxVersion`) и говорит в своей вежливой области: хост держит записи; станция возвращает блоки; сколько блоков хост не принял.

**Files:**

- Create: `apps/standalone/test/host-link-restore.test.ts`
- Modify: `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-status-bar.test.tsx`, `apps/standalone/test/host-link-facts.test.ts`, `apps/standalone/test/host-link-shifts.test.ts`, `apps/standalone/test/app.test.tsx`

**Interfaces:**

- Consumes: задача 1 — `HostStatus.restoreEpoch`; задача 2 — `noteRestoreEpoch`, `restoreDue`, `reconcileRestore`, `readRestoreStatus`, `RestoreStatus`, `HostApi.registerKnownBlocks`, `ENTITY_SET` (в тесте); `createSyncScheduler`, `nextSyncRetryMs`, `shellActionFor`; `sendFactBatch` (2a6).
- Produces: `HostLinkOptions.registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>` (обязательный; `App` передаёт `hostApi.registerKnownBlocks`); `RESTORE_HOLD_RETRY_MS = 60_000`; `FactsFailure = "offline" | "host" | "held" | "local"`, `factsFailureOf(restore_pending) === "held"`; ключи `floor.status.restoreHeld`, `floor.status.restoreDue`, `floor.status.restoreRefused` (`{{n}}`).

- [ ] **Step 1: Тесты — сначала они**

1. Создать `apps/standalone/test/host-link-restore.test.ts`:

<!-- prettier-ignore -->
```typescript
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { factsFailureOf, RESTORE_HOLD_RETRY_MS, useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import {
  knownBlocksRequestSchema,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import type {
  ChangesResponse,
  DeviceStatus,
  FactReceipt,
  HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { ENTITY_SET } from "../src/local/reference-sync.js";
import { noteRestoreEpoch, reconcileRestore } from "../src/local/restore-reconcile.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { PAIRING, rows, seedBlock, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function read(path: string): string {
  return readFileSync(new URL(path, testModuleUrl), "utf8");
}

const [BLOCK] = knownBlocksRequestSchema.parse(
  JSON.parse(read("../proto/fixtures/known-blocks-request.json")),
).blocks;
/** `restoreEpoch` of `hello-restored.json`. */
const EPOCH = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const RESTORED: HostStatus = { ...ONLINE, restoreEpoch: EPOCH };
const HELD = new HostError({
  kind: "api",
  code: "restore_pending",
  status: 503,
  message: "the host was restored from a copy: facts wait until the office resumes them",
  details: { since: "2026-10-09T15:00:00Z" },
});

/** The shell's link as the test drives it: `watch` reports `first` at once. */
function fakeConnection(first: HostStatus) {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(first);
      return () => {
        handlers = null;
      };
    }),
  };
  return {
    connection,
    status: (status: HostStatus) =>
      act(async () => {
        handlers?.onStatus(status);
      }),
  };
}

async function acceptAll(records: readonly unknown[]): Promise<FactReceipt[]> {
  return records.map((record) => ({ id: (record as { id: string }).id, outcome: "accepted" }));
}

function knownAll(request: KnownBlocksRequest): Promise<KnownBlocksResponse> {
  return Promise.resolve({
    results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
  });
}

/** The link over `db` with the station's block and two records waiting; `order` says what reached the host when. */
async function link(options: {
  first: HostStatus;
  register?: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  send?: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  database?: { db: DatabaseSync; executor: LocalExecutor };
  /** Every write of the link answers a turn later, as the shell's `local_transaction` does. */
  slowWrites?: boolean;
}) {
  const { db, executor: stored } = options.database ?? openLocalDb();
  const executor: LocalExecutor = options.slowWrites
    ? {
        query: (sql, params, row) => stored.query(sql, params, row),
        transaction: async (statements) => {
          await new Promise((resolve) => setImmediate(resolve));
          return stored.transaction(statements);
        },
      }
    : stored;
  if (BLOCK === undefined) throw new Error("the fixture names a block");
  seedBlock(db, { blockId: BLOCK.id, from: BLOCK.fromSerial, to: BLOCK.toSerial });
  await unsentScans(stored, 2);
  const order: string[] = [];
  const connection = fakeConnection(options.first);
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (since: number): Promise<ChangesResponse> => {
    order.push(`changes ${since}`);
    return { hostId: HOST_ID, rev: 30, hasMore: false, items: [] };
  });
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const registerImpl = options.register ?? knownAll;
  // The host's answer takes a turn, as over the network.
  const register = vi.fn(async (request: KnownBlocksRequest) => {
    order.push("blocks");
    await new Promise((resolve) => setImmediate(resolve));
    const answer = await registerImpl(request);
    order.push("blocks answered");
    return answer;
  });
  const sendImpl = options.send ?? acceptAll;
  const send = vi.fn(async (records: readonly unknown[]) => {
    order.push("facts");
    return sendImpl(records);
  });
  const hook = renderHook(() =>
    useHostLink({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      connection: connection.connection,
      local: executor,
      changes,
      refresh,
      deviceShifts: async () => [],
      sendFacts: send,
      registerKnownBlocks: register,
      dispatch,
    }),
  );
  const unsent = () =>
    rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")[0]?.["n"];
  const failures = () =>
    dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "facts_failed");
  return {
    db,
    executor,
    connection,
    dispatch,
    changes,
    register,
    send,
    hook,
    order,
    unsent,
    failures,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the link after a restore of the host", () => {
  it("gives the blocks back first, then syncs from zero and sends the records", async () => {
    const { db, executor } = openLocalDb();
    // The copies reached revision 20 before the restore.
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '20'), ('host_id', ?), " +
        "('device_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, DEVICE_ID, ENTITY_SET);
    const station = await link({ first: RESTORED, database: { db, executor }, slowWrites: true });
    await waitFor(() => expect(station.unsent()).toBe(0));
    await waitFor(() => expect(station.order).toContain("changes 0"));
    expect(station.register).toHaveBeenCalledTimes(1);
    expect(station.register.mock.calls[0]?.[0]).toEqual({ blocks: [BLOCK] });
    const answered = station.order.indexOf("blocks answered");
    expect(answered).toBeGreaterThan(-1);
    expect(station.order.indexOf("facts")).toBeGreaterThan(answered);
    expect(station.order.lastIndexOf("changes 0")).toBeGreaterThan(answered);
    expect(
      rows(db, "SELECT epoch, reconciled_at IS NOT NULL AS done FROM floor_restore_epochs"),
    ).toEqual([{ epoch: EPOCH, done: 1 }]);
    expect(station.dispatch).toHaveBeenCalledWith({ type: "outbox_changed" });
    station.hook.unmount();
  });

  it("sends no record while the blocks are owed, across a restart, and retries the blocks after 2 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    // Noted before a restart; this connection's read of `hello` failed.
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    let answer: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse> = () =>
      Promise.reject(down);
    const station = await link({
      first: ONLINE,
      register: (request) => answer(request),
      database: { db, executor },
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    expect(station.unsent()).toBe(2);
    answer = knownAll;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("asks nothing of the host for an epoch it already settled", async () => {
    const { db, executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: knownAll,
      now: () => new Date(),
    });
    // The records the reconciliation reopened are none: two new ones wait.
    const station = await link({ first: RESTORED, database: { db, executor } });
    await waitFor(() => expect(station.unsent()).toBe(0));
    await settle();
    expect(station.register).not.toHaveBeenCalled();
    station.hook.unmount();
  });
});

describe("the outbox while the restored host holds the facts", () => {
  it("says the host holds the records, waits a minute, and sends them once the hold ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let held = true;
    const station = await link({
      first: ONLINE,
      send: async (records) => {
        if (held) throw HELD;
        return acceptAll(records);
      },
    });
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(station.failures()).toEqual([{ type: "facts_failed", failure: "held" }]),
    );
    // The usual 2 s, 4 s, … would knock every few seconds; the host said a minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_HOLD_RETRY_MS - 1_000);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.unsent()).toBe(2);
    held = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    expect(station.dispatch).toHaveBeenCalledWith({ type: "facts_sent" });
    station.hook.unmount();
  });

  it("tells the hold apart from the host's other failures", () => {
    expect(factsFailureOf(HELD)).toBe("held");
    expect(
      factsFailureOf(new HostError({ kind: "api", code: "internal", status: 500, message: "" })),
    ).toBe("host");
    expect(
      factsFailureOf(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBe("offline");
  });

  it("waits exactly as long as the host's Retry-After says", () => {
    const server = read("../host/src/server.rs");
    const seconds = /pub const RESTORE_RETRY_AFTER_SECS: u64 = (\d+);/.exec(server)?.[1];
    expect(seconds).toBeDefined();
    expect(RESTORE_HOLD_RETRY_MS).toBe(Number(seconds) * 1000);
  });
});
```

2. В `apps/standalone/test/floor-status-bar.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { seedBlock, unsentScans } from "./support/floor-work.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { noteRestoreEpoch, reconcileRestore } from "../src/local/restore-reconcile.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { seedBlock, unsentScans } from "./support/floor-work.js";
```

3. В `apps/standalone/test/floor-status-bar.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  });

  it("does not say the host fails the delivery, or that the link is up, while the host's refusal waits", async () => {
    const { executor } = openLocalDb();
```

заменить на

<!-- prettier-ignore -->
```tsx
  });

  it("says in the polite region that a host restored from a copy holds the records", async () => {
    const { executor } = openLocalDb();
    const view = render(bar({ local: executor, factsFailure: null }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    const before = politeRegions();
    expect(screen.queryByText(/отправка ждёт администратора/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: "held" }));
    const held = screen.getByText(
      "Хост восстановлен из копии — отправка ждёт администратора. Станция работает и хранит записи на этом компьютере.",
    );
    expect(heardOnce(before, held)).toBe(true);
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
  });

  it("says while the station owes a restored host its blocks, and then how many the host refused", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 3500, to: 5499 });
    seedBlock(db, { blockId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 5500, to: 7499 });
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const view = render(bar({ local: executor }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    const before = politeRegions();
    const due = await screen.findByText(
      "Хост восстановлен из копии — станция возвращает ему свои блоки номеров SSCC. Записи смены ждут и хранятся на этом компьютере.",
    );
    expect(heardOnce(before, due)).toBe(true);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async (request) => ({
        results: request.blocks.map((block) => ({
          id: block.id,
          outcome: "refused" as const,
          code: "block_overlap",
        })),
      }),
      now: () => new Date(),
    });
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    const refused = await screen.findByText(
      "Блоков номеров SSCC, которые хост не принял после восстановления: 2. Станция больше не печатает номера из них — сообщите администратору.",
    );
    expect(heardOnce(before, refused)).toBe(true);
    expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull();
  });

  it("does not say the host fails the delivery, or that the link is up, while the host's refusal waits", async () => {
    const { executor } = openLocalDb();
```

4. В `apps/standalone/test/host-link-facts.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
        deviceShifts: async () => [],
        sendFacts: send,
        dispatch,
      }),
```

заменить на

<!-- prettier-ignore -->
```typescript
        deviceShifts: async () => [],
        sendFacts: send,
        registerKnownBlocks: async () => ({ results: [] }),
        dispatch,
      }),
```

5. В `apps/standalone/test/host-link-shifts.test.ts` фрагмент

<!-- prettier-ignore -->
```typescript
        deviceShifts,
        sendFacts: async () => [],
        dispatch,
      }),
```

заменить на

<!-- prettier-ignore -->
```typescript
        deviceShifts,
        sendFacts: async () => [],
        registerKnownBlocks: async () => ({ results: [] }),
        dispatch,
      }),
```

6. В `apps/standalone/test/app.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          deviceShifts: async () => [],
          sendFacts: async () => [],
          dispatch,
        }),
```

заменить на

<!-- prettier-ignore -->
```tsx
          deviceShifts: async () => [],
          sendFacts: async () => [],
          registerKnownBlocks: async () => ({ results: [] }),
          dispatch,
        }),
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-restore.test.ts test/floor-status-bar.test.tsx test/host-link-facts.test.ts test/host-link-shifts.test.ts`

Expected: FAIL: `Test Files  2 failed | 2 passed (4)`, `Tests  7 failed | 83 passed (90)` — пять тестов `host-link-restore.test.ts` («gives the blocks back first, then syncs from zero and sends the records», «sends no record while the blocks are owed, across a restart, and retries the blocks after 2 s», «says the host holds the records, waits a minute, and sends them once the hold ends», «tells the hold apart from the host's other failures», «waits exactly as long as the host's Retry-After says») и два новых теста строки состояния. «asks nothing of the host for an epoch it already settled» проходит и до реализации: он держит границу (уже исполненная эпоха ничего не спрашивает у хоста), которую реализация не должна нарушить.

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```typescript
 * names a failure that is not the link's.
 */
export type FactsFailure = "offline" | "host" | "local";

/**
```

заменить на

<!-- prettier-ignore -->
```typescript
 * names a failure that is not the link's.
 */
export type FactsFailure = "offline" | "host" | "held" | "local";

/**
```

2. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
import { useCallback, useEffect, useMemo, useRef } from "react";

import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
```

заменить на

<!-- prettier-ignore -->
```typescript
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { KnownBlocksRequest, KnownBlocksResponse } from "../host/backups.js";
import { HostError } from "../host/client.js";
import type { ConnectionApi } from "../host/connection.js";
```

3. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  syncReferences,
} from "../local/reference-sync.js";
import {
  deviceRejection,
```

заменить на

<!-- prettier-ignore -->
```typescript
  syncReferences,
} from "../local/reference-sync.js";
import { noteRestoreEpoch, reconcileRestore, restoreDue } from "../local/restore-reconcile.js";
import {
  deviceRejection,
```

4. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
export function nextSyncRetryMs(attempt: number): number {
  return RETRY_MS[attempt - 1] ?? RETRY_CAP_MS;
}

```

заменить на

<!-- prettier-ignore -->
```typescript
export function nextSyncRetryMs(attempt: number): number {
  return RETRY_MS[attempt - 1] ?? RETRY_CAP_MS;
}

/**
 * How long the outbox waits after the host answered `restore_pending` (plan
 * РК-С): the `Retry-After` of a held answer, `RESTORE_RETRY_AFTER_SECS` in
 * the host's `server.rs` (a test reads it there). The shell passes the
 * webview status and body only, so the number lives on both sides.
 */
export const RESTORE_HOLD_RETRY_MS = 60_000;

/** The host was restored from a copy and holds the stations' facts until the office resumes them. */
function restoreHeld(error: unknown): boolean {
  return error instanceof HostError && error.kind === "api" && error.code === "restore_pending";
}

```

5. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
 */
export function factsFailureOf(error: unknown): FactsFailure {
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code !== "invalid_response" ? "offline" : "host";
```

заменить на

<!-- prettier-ignore -->
```typescript
 */
export function factsFailureOf(error: unknown): FactsFailure {
  if (restoreHeld(error)) return "held";
  if (error instanceof HostError) {
    return error.kind === "transport" && error.code !== "invalid_response" ? "offline" : "host";
```

6. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  /** `HostApi.sendFacts`: the outbox's records to the host, a receipt for each. */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  dispatch: (action: ShellAction) => void;
}
```

заменить на

<!-- prettier-ignore -->
```typescript
  /** `HostApi.sendFacts`: the outbox's records to the host, a receipt for each. */
  sendFacts: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  /** `HostApi.registerKnownBlocks`: this station's blocks back to a host restored from a copy. */
  registerKnownBlocks: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  dispatch: (action: ShellAction) => void;
}
```

7. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
 * everywhere. It lives exactly as long as the link: a refusal waiting for the
 * operator to leave the shift stops the link (`App`), and the delivery with
 * it. Returns the requests for a sync and for the delivery.
 */
export function useHostLink({
```

заменить на

<!-- prettier-ignore -->
```typescript
 * everywhere. It lives exactly as long as the link: a refusal waiting for the
 * operator to leave the shift stops the link (`App`), and the delivery with
 * it. After a restore of the host (plan РК-С) an online status names its new
 * epoch: the pairing notes it and owes the host its blocks, a sync from zero
 * and its recent records again (`reconcileRestore`), at once and at every
 * link event until that is settled, retried like the reads above; no record
 * goes meanwhile. While the host holds the facts (`restore_pending`) a send
 * waits `RESTORE_HOLD_RETRY_MS`, and the floor goes on offline. Returns the
 * requests for a sync and for the delivery.
 */
export function useHostLink({
```

8. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
  deviceShifts,
  sendFacts,
  dispatch,
}: HostLinkOptions): HostLinkControls {
```

заменить на

<!-- prettier-ignore -->
```typescript
  deviceShifts,
  sendFacts,
  registerKnownBlocks,
  dispatch,
}: HostLinkOptions): HostLinkControls {
```

9. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      factRetry = null;
    };
    // Nothing more should reach a host that refused this device's key or
    // presented another certificate.
```

заменить на

<!-- prettier-ignore -->
```typescript
      factRetry = null;
    };
    // And for settling a restore of the host.
    let reconcileFailures = 0;
    let reconcileRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelReconcileRetry = () => {
      if (reconcileRetry === null) return;
      clearTimeout(reconcileRetry);
      reconcileRetry = null;
    };
    const pairing = { hostId, deviceId };
    // The restore epoch the link's last online status named, and the one this
    // link wrote down: a new epoch is written before anything asks whether
    // blocks are owed, so the outbox never goes out ahead of it.
    let epochSeen: string | null = null;
    let epochNoted: string | null = null;
    const noteEpoch = async () => {
      const epoch = epochSeen;
      if (epoch === null || epoch === epochNoted) return;
      const changed = await noteRestoreEpoch(local, pairing, epoch, new Date());
      epochNoted = epoch;
      // The status bar says what the station owes.
      if (changed && active) dispatch({ type: "outbox_changed" });
    };
    // Nothing more should reach a host that refused this device's key or
    // presented another certificate.
```

10. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      shiftReader.stop();
      factSender.stop();
      cancelRetry();
      cancelRefreshRetry();
      cancelShiftRetry();
      cancelFactRetry();
    };
    const scheduler = createSyncScheduler(async () => {
```

заменить на

<!-- prettier-ignore -->
```typescript
      shiftReader.stop();
      factSender.stop();
      reconciler.stop();
      cancelRetry();
      cancelRefreshRetry();
      cancelShiftRetry();
      cancelFactRetry();
      cancelReconcileRetry();
    };
    const scheduler = createSyncScheduler(async () => {
```

11. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      cancelFactRetry();
      try {
        const { sent, more } = await sendFactBatch(
          local,
```

заменить на

<!-- prettier-ignore -->
```typescript
      cancelFactRetry();
      try {
        // A restored host gets this station's blocks back first: a box closed
        // with a serial the host lost would be refused for good.
        await noteEpoch();
        if (await restoreDue(local, pairing)) return;
        const { sent, more } = await sendFactBatch(
          local,
```

12. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
        factFailures += 1;
        if (online) {
          factRetry = setTimeout(() => {
            factRetry = null;
            factSender.trigger();
          }, nextSyncRetryMs(factFailures));
        }
      }
```

заменить на

<!-- prettier-ignore -->
```typescript
        factFailures += 1;
        if (online) {
          factRetry = setTimeout(
            () => {
              factRetry = null;
              factSender.trigger();
            },
            // The host said when to ask again.
            restoreHeld(error) ? RESTORE_HOLD_RETRY_MS : nextSyncRetryMs(factFailures),
          );
        }
      }
    });
    // One settling of a restore at a time, retried like the reads above; it
    // asks nothing of the host while nothing is owed.
    const reconciler = createSyncScheduler(async () => {
      if (!active) return;
      cancelReconcileRetry();
      try {
        await noteEpoch();
        const result = await reconcileRestore({
          local,
          pairing,
          register: registerKnownBlocks,
          now: () => new Date(),
        });
        if (!active) return;
        reconcileFailures = 0;
        if (result.kind === "reconciled") {
          // The status bar, the copies from zero and the records waiting again.
          dispatch({ type: "outbox_changed" });
          scheduler.trigger();
          factSender.trigger();
        }
      } catch (error) {
        if (!active) return;
        const action = shellActionFor(error, null);
        if (action) {
          stopAll();
          dispatch(action);
          return;
        }
        if (error instanceof HostError && error.code === "not_paired") return;
        reconcileFailures += 1;
        if (online) {
          reconcileRetry = setTimeout(() => {
            reconcileRetry = null;
            reconciler.trigger();
          }, nextSyncRetryMs(reconcileFailures));
        }
      }
```

13. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      shiftReader.trigger();
      factSender.trigger();
    };
    syncNow.current = everything;
```

заменить на

<!-- prettier-ignore -->
```typescript
      shiftReader.trigger();
      factSender.trigger();
      reconciler.trigger();
    };
    syncNow.current = everything;
```

14. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
            cancelShiftRetry();
            cancelFactRetry();
            return;
          }
          if (failures > 0 && !running && retry === null) {
```

заменить на

<!-- prettier-ignore -->
```typescript
            cancelShiftRetry();
            cancelFactRetry();
            cancelReconcileRetry();
            return;
          }
          if (status.restoreEpoch !== undefined && status.restoreEpoch !== epochSeen) {
            epochSeen = status.restoreEpoch;
            reconciler.trigger();
          }
          if (failures > 0 && !running && retry === null) {
```

15. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
          if (factFailures > 0 && factRetry === null) factSender.trigger();
        },
        onRevision: (rev) => {
```

заменить на

<!-- prettier-ignore -->
```typescript
          if (shiftFailures > 0 && shiftRetry === null) shiftReader.trigger();
          if (factFailures > 0 && factRetry === null) factSender.trigger();
          if (reconcileFailures > 0 && reconcileRetry === null) reconciler.trigger();
        },
        onRevision: (rev) => {
```

16. В `apps/standalone/src/app/host-link.ts` фрагмент

<!-- prettier-ignore -->
```typescript
      unwatch?.();
    };
  }, [hostId, deviceId, connection, local, changes, refresh, deviceShifts, sendFacts, dispatch]);
  const requestSync = useCallback(() => syncNow.current(), []);
  const requestFacts = useCallback(() => factsNow.current(), []);
```

заменить на

<!-- prettier-ignore -->
```typescript
      unwatch?.();
    };
  }, [
    hostId,
    deviceId,
    connection,
    local,
    changes,
    refresh,
    deviceShifts,
    sendFacts,
    registerKnownBlocks,
    dispatch,
  ]);
  const requestSync = useCallback(() => syncNow.current(), []);
  const requestFacts = useCallback(() => factsNow.current(), []);
```

17. В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    deviceShifts: hostApi.getDeviceShifts,
    sendFacts: hostApi.sendFacts,
    dispatch,
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    deviceShifts: hostApi.getDeviceShifts,
    sendFacts: hostApi.sendFacts,
    registerKnownBlocks: hostApi.registerKnownBlocks,
    dispatch,
  });
```

18. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import {
```

заменить на

<!-- prettier-ignore -->
```tsx
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readRestoreStatus, type RestoreStatus } from "../local/restore-reconcile.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import {
```

19. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
 * computer; the link's own failure the link's line says) with how long the
 * oldest record has waited and how often it was sent, which stay while
 * the failure does, and that the serials are running out or gone. While
 * the host's refusal waits nothing is sent, so the failure of an earlier send
 * is not news. A failed read of the copies leaves the names out, and of the
```

заменить на

<!-- prettier-ignore -->
```tsx
 * computer; the link's own failure the link's line says) with how long the
 * oldest record has waited and how often it was sent, which stay while
 * the failure does, and that the serials are running out or gone. Plan РК-С
 * adds, in the same region, that a host restored from a copy holds the
 * records, that the station still owes it its blocks, and how many blocks it
 * refused (their serials are no longer used), read with the outbox. While
 * the host's refusal waits nothing is sent, so the failure of an earlier send
 * is not news. A failed read of the copies leaves the names out, and of the
```

20. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  // Only the number of the shift on screen: none after it is left.
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  const [outbox, setOutbox] = useState<OutboxStatus | null>(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
  // Only the number of the shift on screen: none after it is left.
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    readRestoreStatus(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setRestore(next);
      },
      () => {
        if (!cancelled) setRestore(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);

  const [outbox, setOutbox] = useState<OutboxStatus | null>(null);
```

21. В `apps/standalone/src/floor/FloorStatusBar.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
            </Alert>
          )}
          {!refusalHeld && factsFailure === "local" && (
            <Alert tone="warn" role="presentation">
```

заменить на

<!-- prettier-ignore -->
```tsx
            </Alert>
          )}
          {!refusalHeld && factsFailure === "held" && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.restoreHeld")}
            </Alert>
          )}
          {!refusalHeld && restore !== null && restore.due && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.restoreDue")}
            </Alert>
          )}
          {restore !== null && restore.refused > 0 && (
            <Alert tone="error" role="presentation">
              {t("floor.status.restoreRefused", { n: restore.refused })}
            </Alert>
          )}
          {!refusalHeld && factsFailure === "local" && (
            <Alert tone="warn" role="presentation">
```

22. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
      "factsHost": "Хост не принимает записи смены: на хосте ошибка. Станция повторяет отправку, записи хранятся на этом компьютере.",
      "factsLocal": "Ответ хоста не удалось записать в базу этого компьютера. Станция повторяет отправку.",
      "stuck": "Самая старая запись ждёт отправки уже {{age}}, попыток отправки: {{attempts}}.",
      "stuckLast": "Самая старая запись ждёт отправки уже {{age}}, попыток отправки: {{attempts}}, последняя — {{last}} назад.",
```

заменить на

<!-- prettier-ignore -->
```json
      "factsHost": "Хост не принимает записи смены: на хосте ошибка. Станция повторяет отправку, записи хранятся на этом компьютере.",
      "factsLocal": "Ответ хоста не удалось записать в базу этого компьютера. Станция повторяет отправку.",
      "restoreHeld": "Хост восстановлен из копии — отправка ждёт администратора. Станция работает и хранит записи на этом компьютере.",
      "restoreDue": "Хост восстановлен из копии — станция возвращает ему свои блоки номеров SSCC. Записи смены ждут и хранятся на этом компьютере.",
      "restoreRefused": "Блоков номеров SSCC, которые хост не принял после восстановления: {{n}}. Станция больше не печатает номера из них — сообщите администратору.",
      "stuck": "Самая старая запись ждёт отправки уже {{age}}, попыток отправки: {{attempts}}.",
      "stuckLast": "Самая старая запись ждёт отправки уже {{age}}, попыток отправки: {{attempts}}, последняя — {{last}} назад.",
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-restore.test.ts test/floor-status-bar.test.tsx test/host-link-facts.test.ts test/host-link-shifts.test.ts`

Expected: PASS: `Test Files  4 passed (4)`, `Tests  90 passed (90)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/floor-app.test.tsx test/shell.test.ts test/host-link.test.ts`

Expected: PASS: `Tests  348 passed (348)` (связь в приложении не изменилась для хоста без эпохи).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `… run lint`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Файл — `apps/standalone/src/app/host-link.ts` (S1–S3 — `apps/standalone/src/floor/FloorStatusBar.tsx`); команда — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-link-restore.test.ts` (S1–S3 — `test/floor-status-bar.test.tsx`).

- **L1** (очередь не ждёт блоков): удалить строку `        if (await restoreDue(local, pairing)) return;`. Ожидается: FAIL — «sends no record while the blocks are owed, across a restart, and retries the blocks after 2 s».
- **L2** (очередь не записывает эпоху сама): удалить строку `        await noteEpoch();` перед `        if (await restoreDue(local, pairing)) return;` (только в `factSender`). Ожидается: FAIL — «gives the blocks back first, then syncs from zero and sends the records».
- **L3** (удержание — обычные ожидания): `restoreHeld(error) ? RESTORE_HOLD_RETRY_MS : nextSyncRetryMs(factFailures)` → `nextSyncRetryMs(factFailures)`. Ожидается: FAIL — «says the host holds the records, waits a minute, and sends them once the hold ends».
- **L4** (удержание — сбой хоста): удалить строку `  if (restoreHeld(error)) return "held";`. Ожидается: FAIL — «says the host holds the records, waits a minute, …», «tells the hold apart from the host's other failures».
- **L5** (сверка не запускается при подключении): в `everything` удалить строку `      reconciler.trigger();`. Ожидается: FAIL — «sends no record while the blocks are owed, across a restart, and retries the blocks after 2 s».
- **L6** (эпоха из статуса не читается): удалить строку `            epochSeen = status.restoreEpoch;`. Ожидается: FAIL — «gives the blocks back first, then syncs from zero and sends the records».
- **L7** (после сверки ленту не синхронизируют): в ветке `result.kind === "reconciled"` удалить строку `          scheduler.trigger();`. Ожидается: FAIL — «gives the blocks back first, then syncs from zero and sends the records».
- **S1** (не сказано, что блоки должны): `{!refusalHeld && restore !== null && restore.due && (` → `{!refusalHeld && restore !== null && restore.due && false && (`. Ожидается: FAIL — «says while the station owes a restored host its blocks, and then how many the host refused».
- **S2** (отклонённые блоки не видны): `restore.refused > 0 && (` → `restore.refused > 2 && (`. Ожидается: FAIL — тот же тест.
- **S3** (удержание не видно): `{!refusalHeld && factsFailure === "held" && (` → `{!refusalHeld && factsFailure === "host" && false && (`. Ожидается: FAIL — «says in the polite region that a host restored from a copy holds the records».

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <изменённые TS, TSX, JSON, MD>` — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/app/shell.ts apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/host-link-restore.test.ts apps/standalone/test/floor-status-bar.test.tsx apps/standalone/test/host-link-facts.test.ts apps/standalone/test/host-link-shifts.test.ts apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): the link settles a restore before the outbox goes, and waits a minute while the host holds the facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Офис — какие станции вернули блоки

Хост отдаёт `reconciled` по каждой станции с плана РК, но карточка удержания его не показывала: станции блоков не возвращали, и тексты честно говорили «пока не возвращают». После задачи 3 это неправда. Карточка получает столбец «Блоки SSCC» («Вернула» / «Не вернула»), окно возобновления — «Вернули свои блоки SSCC: N из M станций.», отметка и пояснения переписаны; проверки памятки остаются обязательными, потому что станция на выключенном или сломанном ПК блоков не вернёт.

**Files:**

- Modify: `apps/standalone/src/office/backups/BackupsPage.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/backups-page.test.tsx`

**Interfaces:**

- Consumes: `restoreHoldSchema.stations[].reconciled` (план РК), фикстура `backup-state-held.json` (одна станция вернула, одна нет).
- Produces: ключи `office.backups.hold.blocks`, `.returned`, `.notReturned`; `office.backups.hold.confirmCount` с `{{returned}}` и `{{total}}`; новые тексты `blocksNote`, `confirmCheck`, `office.backups.restore.after`.

- [ ] **Step 1: Тесты — сначала они**

1. В `apps/standalone/test/backups-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  });

  it("shows the stations a restore waits for, and says it cannot count the blocks they gave back", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
```

заменить на

<!-- prettier-ignore -->
```tsx
  });

  it("shows the stations a restore waits for, and which of them gave their blocks back", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
```

2. В `apps/standalone/test/backups-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    expect(within(rows[0]!).getByText(at("2026-10-09T15:06:00Z"))).toBeTruthy();
    expect(within(rows[1]!).getByText("—")).toBeTruthy();
    // No claim about stations that "gave their blocks back": no station code does it yet.
    expect(within(hold).queryByText("Вернула")).toBeNull();
    expect(screen.queryByText(/Блоки вернули/)).toBeNull();
    expect(
      within(hold).getByText(/Станции в этой версии пока не возвращают блоки SSCC сами/),
    ).toBeTruthy();
  });

```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(within(rows[0]!).getByText(at("2026-10-09T15:06:00Z"))).toBeTruthy();
    expect(within(rows[1]!).getByText("—")).toBeTruthy();
    // Plan РК-С: a station gives its blocks back by itself once it is online.
    expect(within(rows[0]!).getByText("Вернула")).toBeTruthy();
    expect(within(rows[1]!).getByText("Не вернула")).toBeTruthy();
    expect(within(hold).getByRole("columnheader", { name: "Блоки SSCC" })).toBeTruthy();
    expect(
      within(hold).getByText(
        "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Станция на выключенном или неисправном компьютере их не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/пока не возвращают/)).toBeNull();
  });

```

3. В `apps/standalone/test/backups-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Не возобновляйте приём до проверок SSCC/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Сколько станций вернули свои блоки SSCC, хост сказать не может/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
```

заменить на

<!-- prettier-ignore -->
```tsx
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Не возобновляйте приём до проверок SSCC/)).toBeTruthy();
    expect(within(dialog).getByText("Вернули свои блоки SSCC: 1 из 2 станций.")).toBeTruthy();
    expect(
      within(dialog).getByText(
```

4. В `apps/standalone/test/backups-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
      ),
    ).toBeTruthy();
    // No number of stations that "gave their blocks back" is claimed.
    expect(within(dialog).queryByText(/1 из 2/)).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: RESUME }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
```

заменить на

<!-- prettier-ignore -->
```tsx
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: RESUME }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
```

5. В `apps/standalone/test/backups-page.test.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Проверки SSCC выполнены. Я возобновляю приём, зная, что станции не возвращали свои блоки.",
      }),
    );
```

заменить на

<!-- prettier-ignore -->
```tsx
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Проверки SSCC выполнены. Я возобновляю приём, зная, какие станции не вернули свои блоки.",
      }),
    );
```

- [ ] **Step 2: Тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`

Expected: FAIL: `Tests  2 failed | 33 passed (35)` — «shows the stations a restore waits for, and which of them gave their blocks back», «makes an administrator confirm the resume in words that tell the truth, and then resumes».

- [ ] **Step 3: Реализация**

1. В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx

/**
 * The stations after a restore, and, for an administrator, resuming the facts
 * the host holds until then. No station gives its blocks back yet (plan РК-С),
 * so the host cannot say how many did and this card does not pretend to: the
 * administrator resumes only after the SSCC checks, and says so in a
 * confirmation that is not one click.
 */
function RestoreHoldCard({ hold, canManage, format, onResumed }: RestoreHoldCardProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx

/**
 * The stations after a restore, each with whether it gave its blocks back
 * (plan РК-С: a station does by itself once it is online), and, for an
 * administrator, resuming the facts the host holds until then. A station on a
 * dead computer never gives them back, so the administrator resumes only after
 * the SSCC checks, and says so in a confirmation that is not one click.
 */
function RestoreHoldCard({ hold, canManage, format, onResumed }: RestoreHoldCardProps) {
```

2. В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
        station.lastSeenAt === null ? t("office.common.none") : format(station.lastSeenAt),
    },
  ];
  const open = () => {
    setFailure(null);
```

заменить на

<!-- prettier-ignore -->
```tsx
        station.lastSeenAt === null ? t("office.common.none") : format(station.lastSeenAt),
    },
    {
      key: "blocks",
      title: t("office.backups.hold.blocks"),
      render: (station) =>
        t(station.reconciled ? "office.backups.hold.returned" : "office.backups.hold.notReturned"),
    },
  ];
  const returned = hold.stations.filter((station) => station.reconciled).length;
  const open = () => {
    setFailure(null);
```

3. В `apps/standalone/src/office/backups/BackupsPage.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
          <div className="standalone-form">
            <p>{t("office.backups.hold.confirmChecks")}</p>
            <p>{t("office.backups.hold.confirmCount")}</p>
            <p>{t("office.backups.hold.confirmRisk")}</p>
            <p>
```

заменить на

<!-- prettier-ignore -->
```tsx
          <div className="standalone-form">
            <p>{t("office.backups.hold.confirmChecks")}</p>
            <p>
              {t("office.backups.hold.confirmCount", {
                returned,
                total: hold.stations.length,
              })}
            </p>
            <p>{t("office.backups.hold.confirmRisk")}</p>
            <p>
```

4. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "station": "Станция",
        "lastSeen": "Была на связи",
        "noStations": "Подключённых станций нет",
        "blocksNote": "Станции в этой версии пока не возвращают блоки SSCC сами: этот шаг ещё не готов. Сколько станций вернули блоки, хост сказать не может, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
        "resume": "Возобновить приём данных станций",
        "confirmTitle": "Возобновить приём данных станций?",
        "confirmChecks": "Не возобновляйте приём до проверок SSCC: сверьте счётчики и блоки по памятке о восстановлении.",
        "confirmCount": "Сколько станций вернули свои блоки SSCC, хост сказать не может: станционная часть этого шага ещё не написана, станции блоки не возвращают.",
        "confirmRisk": "Если станция работала с блоками, выданными после копии, хост может отклонить её данные, и разбирать их придётся поддержке.",
        "confirmFacts": "Приём остановлен с {{since}}, эпоха восстановления {{epoch}}.",
        "confirmCheck": "Проверки SSCC выполнены. Я возобновляю приём, зная, что станции не возвращали свои блоки."
      },
      "overviewLink": "Открыть «Резервные копии»",
```

заменить на

<!-- prettier-ignore -->
```json
        "station": "Станция",
        "lastSeen": "Была на связи",
        "blocks": "Блоки SSCC",
        "returned": "Вернула",
        "notReturned": "Не вернула",
        "noStations": "Подключённых станций нет",
        "blocksNote": "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Станция на выключенном или неисправном компьютере их не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
        "resume": "Возобновить приём данных станций",
        "confirmTitle": "Возобновить приём данных станций?",
        "confirmChecks": "Не возобновляйте приём до проверок SSCC: сверьте счётчики и блоки по памятке о восстановлении.",
        "confirmCount": "Вернули свои блоки SSCC: {{returned}} из {{total}} станций.",
        "confirmRisk": "Если станция работала с блоками, выданными после копии, хост может отклонить её данные, и разбирать их придётся поддержке.",
        "confirmFacts": "Приём остановлен с {{since}}, эпоха восстановления {{epoch}}.",
        "confirmCheck": "Проверки SSCC выполнены. Я возобновляю приём, зная, какие станции не вернули свои блоки."
      },
      "overviewLink": "Открыть «Резервные копии»",
```

5. В `apps/standalone/src/i18n/ru.json` фрагмент

<!-- prettier-ignore -->
```json
        "run": "выполнить markiro-host restore <файл копии .db> (файл .json с тем же именем — рядом);",
        "start": "запустить службу: sc start MarkiroHost.",
        "after": "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом. Станции пока не возвращают свои блоки SSCC сами: приём их данных администратор возобновляет здесь, после проверок SSCC."
      }
    },
```

заменить на

<!-- prettier-ignore -->
```json
        "run": "выполнить markiro-host restore <файл копии .db> (файл .json с тем же именем — рядом);",
        "start": "запустить службу: sc start MarkiroHost.",
        "after": "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом. Станции, выйдя на связь, сами возвращают ему свои блоки SSCC; приём их данных администратор возобновляет здесь, после проверок SSCC."
      }
    },
```

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx test/backup-warnings.test.ts`

Expected: PASS: `Tests  44 passed (44)`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `… run lint`

Expected: без ошибок.

- [ ] **Step 5: Мутации**

Файл — `apps/standalone/src/office/backups/BackupsPage.tsx`; команда — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/backups-page.test.tsx`.

- **O1** (каждая станция «вернула»): `t(station.reconciled ? "office.backups.hold.returned" : "office.backups.hold.notReturned")` → `t("office.backups.hold.returned")`. Ожидается: FAIL — «shows the stations a restore waits for, and which of them gave their blocks back».
- **O2** (счёт по всем станциям): `hold.stations.filter((station) => station.reconciled).length` → `hold.stations.length`. Ожидается: FAIL — «makes an administrator confirm the resume in words that tell the truth, and then resumes».

- [ ] **Step 6: Проверки и коммит**

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — молчит; `pnpm --config.verifyDepsBeforeRun=false exec prettier --ignore-path .prettierignore --check <изменённые TS, TSX, JSON, MD>` — `All matched files use Prettier code style!`; `git diff --check` — молчит.

```bash
git add apps/standalone/src/office/backups/BackupsPage.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/backups-page.test.tsx
git commit -m "feat(standalone): the office shows which stations gave their blocks back after a restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Документы — `AGENTS.md`, памятка о восстановлении, раздел 22 спецификации пилота, полная проверка

`AGENTS.md`: класс новой таблицы и число таблиц («Local database»), лента с нуля по эпохе («Reference sync»), чтение `hello` задачей связи («Connection to the host»), сторона станции вместо «The station's side is NOT written» и честное ожидание `restore_pending` («Backups and restore»), ручная проверка («Verification»). Памятка: что в этой версии есть, что станция делает при удержании (5.8), что видно перед «Возобновить» (раздел 7, проверка 5, текст отметки), справочники (раздел 8), контрольный список (раздел 9), учебное восстановление как ручная проверка (раздел 10, п. 9). Спецификация пилота: указатели в §11 и §19 и новый раздел 22.

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

- [ ] **Step 1: Правки документов**

1. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
(`src-tauri/src/local_db.rs`; stage 2a spec §5.2, decision 30):
`Disposable` — the copies of the host's data, `sync_state`,
`sync_quarantine` and `floor_sign_in_failures`; `DeviceData` — what the
device records itself (plans 2a5–2a8: shifts, boxes, scans, the outbox), each
row tagged with the pairing that wrote it; `Workstation` — the PC's own
settings (plan 2a7), which outlive any pairing. Of the 19 tables 11 are
`Disposable` and the 8 of migration `0006` are `DeviceData` (below);
`Workstation` stays empty until plan 2a7 adds tables. `tests/local_db.rs` fails on a table without a class and on a class
```

заменить на

<!-- prettier-ignore -->
```markdown
(`src-tauri/src/local_db.rs`; stage 2a spec §5.2, decision 30):
`Disposable` — the copies of the host's data, `sync_state`,
`sync_quarantine`, `floor_sign_in_failures` and `floor_restore_epochs` (plan
РК-С: what a pairing owes a restored host is moot for a new one); `DeviceData` — what the
device records itself (plans 2a5–2a8: shifts, boxes, scans, the outbox), each
row tagged with the pairing that wrote it; `Workstation` — the PC's own
settings (plan 2a7), which outlive any pairing. Of the 20 tables 12 are
`Disposable` and the 8 of migration `0006` are `DeviceData` (below);
`Workstation` stays empty until plan 2a7 adds tables. `tests/local_db.rs` fails on a table without a class and on a class
```

2. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
rejection. A host restored from a copy answers the revision of the copy plus
one (`markiro-host restore`, plan РК), below what the station last read, so a
station whose cursor passed it sees `rev < since` and starts again from zero;
that is best effort. A station whose cursor is at or below the copy's next
revision does not notice, nor does one that reconnects only after the host's
later writes passed its cursor. The station does not read `hello.restoreEpoch`
yet: the epoch wipe is plan РК-С's, written after plans 2a5 and 2a6.

## Protocol
```

заменить на

<!-- prettier-ignore -->
```markdown
rejection. A host restored from a copy answers the revision of the copy plus
one (`markiro-host restore`, plan РК), below what the station last read, so a
station whose cursor passed it sees `rev < since` and starts again from zero.
That alone is best effort (a cursor at or below the copy's next revision sees
nothing), so the station also reads `hello.restoreEpoch` (plan РК-С, "Backups
and restore"): a new epoch writes `from_zero` into `sync_state`
(`FROM_ZERO_SQL`), and the next run fetches from 0 and wipes the copies in the
transaction of its first page, which deletes the mark with the rest of
`sync_state`; until that page lands the copies stay usable.

## Protocol
```

3. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
webview received; an event's own `lastContactAt` is always the value
current when that event was published. The webview syncs reference data on
each revision and never opens the stream itself.

## Hardware
```

заменить на

<!-- prettier-ignore -->
```markdown
webview received; an event's own `lastContactAt` is always the value
current when that event was published. The webview syncs reference data on
each revision and never opens the stream itself. Before each stream the task
reads `GET /v1/hello` with the same pinned client and no key; the `Online`
status carries its `restoreEpoch` (plan РК-С, absent from the JSON when the
host names none or the read failed: the stream opens all the same, and the
next connection reads again). A fresh pairing and an unpaired device clear it.

## Hardware
```

4. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
`POST /v1/device/facts` and `GET /v1/device/codes/{…}` with `restore_pending`
(503, `Retry-After: 60`, `details.since`) before any route or device check,
and the station sends them again later (the station's own retry backs off to
60 s; it does not read `Retry-After`); blocks, shifts and the feed are not
held. The office lists every unrevoked station and whether it sent its blocks
back; resuming is the administrator's call, behind a dialog that asks for an
explicit confirmation of the runbook's SSCC checks (a station on a dead
```

заменить на

<!-- prettier-ignore -->
```markdown
`POST /v1/device/facts` and `GET /v1/device/codes/{…}` with `restore_pending`
(503, `Retry-After: 60`, `details.since`) before any route or device check,
and the station sends them again a minute later (`RESTORE_HOLD_RETRY_MS`);
blocks, shifts and the feed are not held. The office lists every unrevoked station and whether it sent its blocks
back; resuming is the administrator's call, behind a dialog that asks for an
explicit confirmation of the runbook's SSCC checks (a station on a dead
```

5. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
how many did.

The station's side is NOT written. Plan РК-С, written after plans 2a5 and 2a6
(plan 2a6 leaves it to plan РК), is to: keep the last seen epoch; on a new one
sync the copies from zero, send every block it holds in parts of 64 before it
resumes delivery, honour `Retry-After`, and show refused blocks and the hold in
the status bar. Until then no station returns a block, `reconciled` stays 0,
the epoch wipe of the copies is best effort (above), and a shift a station
opened or created after the copy has no re-registration (its facts are refused
once the facts resume: `unknown_shift`, `not_entered`). The checks that make up
for it are the runbook's, done by a person before the resume.

Migration `0011` may be applied after `0012` on a database that already had
```

заменить на

<!-- prettier-ignore -->
```markdown
how many did.

The station's side is plan РК-С. The shell's link reads `hello` before every
stream and the `Online` status names `restoreEpoch` ("Connection to the
host"). `useHostLink` notes a new one for the pairing in `floor_restore_epochs`
(migration `0009`, `noteRestoreEpoch`) before anything asks whether blocks are
owed: the row is the obligation and survives a restart. While it is not
settled (`reconciled_at` NULL) the outbox sends nothing (`restoreDue`), and
`reconcileRestore` — at once, at every link event, retried like the reads —
sends every block of `floor_sscc_blocks` of the pairing, used up ones too, 64
to a request and as the host issued it; a refused block gets its cursor past
its end in the transaction after that answer, so no box closes with a serial
the host refused (the box close keeps the other blocks and asks for a new one
by the half rule); `conflict` on `no_restore` means nothing is owed. Then ONE
transaction writes `from_zero` for the sync, puts the records acknowledged in
the last 30 days (`RESEND_WINDOW_MS`, decision 31) back in the outbox and
settles the epoch with the count of refused blocks, only if the epoch is still
the one read (a later restore noted meanwhile fails it with `changes_mismatch`
and the next run settles that one). The host answers a record it has with the
receipt it keeps, so nothing is applied twice. A send answered
`restore_pending` is the failure `held` and waits `RESTORE_HOLD_RETRY_MS` (60
s, the host's `RESTORE_RETRY_AFTER_SECS`, which a test reads in `server.rs`:
the shell passes the webview no headers); the floor scans and closes boxes
offline meanwhile, and code checks that meet the hold let the scan through as
any failed check does. The status bar says, in its polite region, that the
host holds the records, that blocks are owed, and how many the host refused.
The office's hold card shows per station whether it gave its blocks back
(`reconciled`) and the dialog how many of how many. Left open: a pairing
without blocks never calls the route, so the office lists it as «Не вернула»
(the host asks for 1–64 blocks); a connection whose `hello` read failed
learns of the restore only at the next connection, and sends its facts
meanwhile (the hold covers that until the resume); the marks a `conflict`
receipt left on scans and boxes stay when the record goes again; a shift a
station opened or created after the copy has no re-registration (its facts
are refused once the facts resume: `unknown_shift`, `not_entered`). The checks
that make up for a station that never comes back are the runbook's, done by a
person before the resume.

Migration `0011` may be applied after `0012` on a database that already had
```

6. В `apps/standalone/AGENTS.md` фрагмент

<!-- prettier-ignore -->
```markdown
    request, the full box and the records). Neither shows a real host, a real
    scanner or a real Windows.
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
```

заменить на

<!-- prettier-ignore -->
```markdown
    request, the full box and the records). Neither shows a real host, a real
    scanner or a real Windows.
- The station after a restore of the host (plan РК-С) by hand, on two
  Windows PCs: the runbook's section 10, item 9 — a station closing boxes
  while the host is restored from an hourly copy, the blocks it got after the
  copy registered again, the hold's line and its one-minute retries, nothing
  lost, no `sscc_not_issued` and no repeated SSCC after the resume, and the
  copies of the station equal to the office's. Until then it has run only
  under jsdom and node:sqlite with a fake `HostApi`; the shell's `hello` read
  ran against a real host on 127.0.0.1 whose `site.restore_epoch` a test
  wrote, never against `markiro-host restore`.
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
```

7. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
- Есть: копии хоста, вторая папка, страница «Резервные копии», `markiro-host restore` и
  `markiro-host verify-copy`, удержание данных станций после восстановления.
- Нет: сторона станции в сверке после восстановления (план РК-С, он пишется после планов 2a5 и 2a6).
  Станции **не возвращают** хосту свои блоки SSCC и не узнают сами, что хост восстановлен из копии.
  Поэтому проверки раздела 7 делает человек, прежде чем нажать «Возобновить приём данных станций».

## 1. Что делает хост сам
```

заменить на

<!-- prettier-ignore -->
```markdown
- Есть: копии хоста, вторая папка, страница «Резервные копии», `markiro-host restore` и
  `markiro-host verify-copy`, удержание данных станций после восстановления.
- Есть и сторона станции (план РК-С, раздел 22 спецификации пилота): станция, выйдя на связь с
  восстановленным хостом, сама узнаёт об этом по новой эпохе, возвращает хосту свои блоки SSCC,
  пересобирает справочники с нуля и снова отправляет записи последних 30 дней. Станция на
  выключенном или сломанном ПК этого не сделает, поэтому проверки раздела 7 по-прежнему делает
  человек, прежде чем нажать «Возобновить приём данных станций».

## 1. Что делает хост сам
```

8. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
     записи в очереди;
   - на `POST /v1/device/facts` и на проверки кодов хост отвечает 503 `restore_pending` с
     `Retry-After: 60`; станция повторяет отправку сама (интервал растёт до 60 секунд), в строке
     состояния растёт «Не отправлено»;
   - смены, блоки SSCC, лента справочников и офис работают.
9. Выполнить памятку о восстановлении (раздел 7), и только после неё нажать «Возобновить приём
```

заменить на

<!-- prettier-ignore -->
```markdown
     записи в очереди;
   - на `POST /v1/device/facts` и на проверки кодов хост отвечает 503 `restore_pending` с
     `Retry-After: 60`; станция повторяет отправку раз в минуту, в строке состояния цеха —
     «Хост восстановлен из копии — отправка ждёт администратора», растёт «Не отправлено»;
   - станция, выйдя на связь, сама возвращает хосту свои блоки SSCC (строка состояния: «станция
     возвращает ему свои блоки номеров SSCC»), пересобирает справочники с нуля и ставит в очередь
     снова записи последних 30 дней: хост не примет их до возобновления, а запись, которую он уже
     знает, получит прежнюю квитанцию. Какие станции вернули блоки — столбец «Блоки SSCC» на
     странице «Резервные копии»;
   - смены, блоки SSCC, лента справочников и офис работают.
9. Выполнить памятку о восстановлении (раздел 7), и только после неё нажать «Возобновить приём
```

9. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown

Окно «Возобновить приём данных станций?» в офисе говорит: «Не возобновляйте приём до проверок SSCC:
сверьте счётчики и блоки по памятке о восстановлении». Это она. Хост этих проверок не делает и не
может: ни одна станция не возвращает ему свои блоки (план РК-С), поэтому он не знает, сколько
станций «сверилось»; страница «Резервные копии» этого числа и не показывает. Решение принимает
администратор.

```

заменить на

<!-- prettier-ignore -->
```markdown

Окно «Возобновить приём данных станций?» в офисе говорит: «Не возобновляйте приём до проверок SSCC:
сверьте счётчики и блоки по памятке о восстановлении». Это она. Хост этих проверок не делает.
Станции, вышедшие на связь, сами возвращают ему свои блоки (план РК-С), и страница «Резервные копии»
показывает, какие вернули («Блоки SSCC»: «Вернула» или «Не вернула»), а окно — сколько из скольких.
Но станция на выключенном или сломанном ПК блоков не вернёт, а блок, который хост не принял, станция
больше не использует, хотя номера из него уже могли быть напечатаны. Решение принимает
администратор.

```

10. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
### Проверка 5. Станции и лента справочников

Хост назвал себя восстановленным (в `hello` появилась новая эпоха), но станции эпоху пока не читают.
Лента справочников у них пересоберётся с нуля только тогда, когда номер ревизии хоста окажется ниже
того, что они запомнили: хост после восстановления получает ревизию копии, а не ревизию прежней базы,
поэтому станция, которая запомнила более высокую, начинает ленту заново. Это работает не всегда:

- станция, чей запомненный номер ревизии не выше ревизии копии плюс один, ничего не заметит;
- станция, которая подключилась только после того, как хост успел сделать новые записи сверх её
  номера, тоже.

Результат: у такой станции остаются операторы, товары и шаблоны, изменённые после копии, а хост их
не знает. Поэтому после восстановления проверьте на каждой станции, что список операторов и товаров
совпадает с офисом; расхождение лечится «Подключить заново» (станция снова загружает справочники)
и повтором изменений в офисе. Надёжно это закроет план РК-С.

### Нажать «Возобновить приём данных станций»

Только администратор. Нажать после проверок 1–5, поставив отметку «Проверки SSCC выполнены. Я
возобновляю приём, зная, что станции не возвращали свои блоки». Что происходит дальше:

- станции повторяют отправку, хост принимает записи и отдаёт квитанции; обычное для станции
```

заменить на

<!-- prettier-ignore -->
```markdown
### Проверка 5. Станции и лента справочников

Хост назвал себя восстановленным: в `hello` появилась новая эпоха. Станция читает её при каждом
подключении (план РК-С) и, увидев новую, пересобирает справочники с нуля, возвращает хосту свои блоки
SSCC и снова ставит в очередь записи последних 30 дней. На каждой станции, которая работает:

- в строке состояния цеха нет «Хост восстановлен из копии — станция возвращает ему свои блоки номеров
  SSCC» (строка держится, пока хост не ответил; если держится долго — нет связи с хостом);
- если есть строка «Блоков номеров SSCC, которые хост не принял после восстановления: N» — номера из
  этих блоков станция больше не печатает; такой блок пересекается с блоком другой станции или
  относится к префиксу, которого хост не знает. Сообщите разработчику и сверьте проверку 1 по этой
  станции особенно тщательно;
- в «Резервные копии» у станции «Вернула».

Станция, которая прочитала эпоху неудачно (обрыв связи ровно в момент подключения), узнает о
восстановлении при следующем подключении.

### Нажать «Возобновить приём данных станций»

Только администратор. Нажать после проверок 1–5, поставив отметку «Проверки SSCC выполнены. Я
возобновляю приём, зная, какие станции не вернули свои блоки». Что происходит дальше:

- станции повторяют отправку, хост принимает записи и отдаёт квитанции; обычное для станции
```

11. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
  такое восстановление «сжигает» около 1 % диапазона на каждый префикс и каждое расширение (короба и
  паллеты считаются отдельно). Если прежняя база читалась, расход — два блока.
- **Справочники станций.** Лента справочников у станции пересобирается не всегда (раздел 7,
  проверка 5): надёжно это сделает план РК-С.
- **Сроки хранения станции.** Подтверждённые факты станция хранит 30 дней (решение 31, план 2a8).
  Копия старше 30 дней опасна.
```

заменить на

<!-- prettier-ignore -->
```markdown
  такое восстановление «сжигает» около 1 % диапазона на каждый префикс и каждое расширение (короба и
  паллеты считаются отдельно). Если прежняя база читалась, расход — два блока.
- **Справочники станций.** Станция пересобирает ленту справочников с нуля, когда видит новую
  эпоху (план РК-С); пока первая страница не пришла, она работает по прежним копиям.
- **Сроки хранения станции.** Подтверждённые факты станция хранит 30 дней (решение 31, план 2a8).
  Копия старше 30 дней опасна.
```

12. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
      (проверка 3); пароли офиса при необходимости сменены.
- [ ] Устройства и смены, появившиеся после копии, подключены или закрыты (проверка 4).
- [ ] Справочники на станциях совпадают с офисом (проверка 5).
- [ ] Приём возобновлён; в «Резервные копии» нет красных предупреждений; счёт «Не отправлено» на
      станциях ушёл к нулю.
```

заменить на

<!-- prettier-ignore -->
```markdown
      (проверка 3); пароли офиса при необходимости сменены.
- [ ] Устройства и смены, появившиеся после копии, подключены или закрыты (проверка 4).
- [ ] На каждой станции нет строки «станция возвращает ему свои блоки номеров SSCC», непринятые
      блоки (если есть) переданы разработчику, в «Резервные копии» у станций «Вернула»
      (проверка 5).
- [ ] Приём возобновлён; в «Резервные копии» нет красных предупреждений; счёт «Не отправлено» на
      станциях ушёл к нулю.
```

13. В `docs/runbooks/standalone-backup-restore.md` фрагмент

<!-- prettier-ignore -->
```markdown
   из консоли администратора; **отказ `sc start` пока есть маркер `host.restore-intent`** (служба не
   должна запускаться, а причина должна быть видна администратору).
9. **Учебное восстановление на испытаниях:** хост из часовой копии, станция досылает, повторных SSCC
   нет — после плана РК-С.
10. **Страница «Резервные копии» в WebView2:** отступы, порядок фокуса, объявления для чтения с
    экрана; пауза опроса при свёрнутом окне.
```

заменить на

<!-- prettier-ignore -->
```markdown
   из консоли администратора; **отказ `sc start` пока есть маркер `host.restore-intent`** (служба не
   должна запускаться, а причина должна быть видна администратору).
9. **Учебное восстановление на испытаниях (план РК-С).** Станция на втором ПК, хост на первом:
   смена с коробами идёт, копия часовой давности, после копии закрыто ещё несколько коробов, и один
   блок SSCC станция получила уже после копии. Хост остановлен и восстановлен из копии, пока
   станция печатает без него. Проверить: станция продолжает закрывать короба; после запуска службы
   строка «станция возвращает ему свои блоки номеров SSCC» появляется и уходит, затем держится
   «отправка ждёт администратора» (раз в минуту, без потери записей: «Не отправлено» только растёт);
   в «Резервные копии» у станции «Вернула», в журнале — `sscc.block.register` по блоку, выданному
   после копии; после «Возобновить приём» «Не отправлено» уходит к нулю, отклонённых
   `sscc_not_issued` нет, повторных SSCC в выгрузке нет, справочники станции совпадают с офисом
   (оператор, добавленный после копии, на станции пропал). Второй прогон — с выключенной сетью на
   станции во время запуска службы: станция догоняет всё при возврате связи.
10. **Страница «Резервные копии» в WebView2:** отступы, порядок фокуса, объявления для чтения с
    экрана; пауза опроса при свёрнутом окне.
```

14. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```markdown
План РК (подмножество этапа 5). План исполнен в 8 задачах (хост, восстановление, страница офиса,
памятка), а не в 6; его уточнения — в разделе 19. Сторона станции в сверке после восстановления
(абзац «Повторная регистрация блоков» ниже) отдана малому плану РК-С и в этой версии не написана.

- **Копия.**
```

заменить на

<!-- prettier-ignore -->
```markdown
План РК (подмножество этапа 5). План исполнен в 8 задачах (хост, восстановление, страница офиса,
памятка), а не в 6; его уточнения — в разделе 19. Сторона станции в сверке после восстановления
(абзац «Повторная регистрация блоков» ниже) — план РК-С, его уточнения — в разделе 22.

- **Копия.**
```

15. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```markdown
  `POST /v1/device/sscc/blocks/known` (блок, которого хост не знает, регистрируется, если не
  пересекается с другими; расширение вне цифры — `range_invalid`; до восстановления `no_restore`).
  Сторона станции (эпоха, лента с нуля, отправка блоков частями по 64, затем фактов) — малый план
  РК-С после исполнения 2a5 и 2a6; до него станции блоков не возвращают.
- **Квитанция хранится бессрочно** (2a2), поэтому от восстановления до решения администратора хост
  отвечает на факты и проверки кодов станций `restore_pending` (503, `Retry-After: 60`), а не
  квитанциями; станция досылает их позже. Блоки, смены и лента не удерживаются. Администратор
  возобновляет приём на странице «Резервные копии», подтвердив проверки SSCC из памятки (раздел 7):
  число станций, вернувших блоки, пока всегда 0. Повторной регистрации смен после восстановления
  нет: факты по сменам, открытым или созданным после копии, после возобновления получат
  `unknown_shift` и `not_entered`.
```

заменить на

<!-- prettier-ignore -->
```markdown
  `POST /v1/device/sscc/blocks/known` (блок, которого хост не знает, регистрируется, если не
  пересекается с другими; расширение вне цифры — `range_invalid`; до восстановления `no_restore`).
  Сторона станции (эпоха, лента с нуля, отправка блоков частями по 64, затем фактов) — план РК-С,
  раздел 22.
- **Квитанция хранится бессрочно** (2a2), поэтому от восстановления до решения администратора хост
  отвечает на факты и проверки кодов станций `restore_pending` (503, `Retry-After: 60`), а не
  квитанциями; станция досылает их позже. Блоки, смены и лента не удерживаются. Администратор
  возобновляет приём на странице «Резервные копии», подтвердив проверки SSCC из памятки (раздел 7);
  сколько станций вернули блоки, страница показывает с планом РК-С (раздел 22). Повторной регистрации смен после восстановления
  нет: факты по сменам, открытым или созданным после копии, после возобновления получат
  `unknown_shift` и `not_entered`.
```

16. В `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` фрагмент

<!-- prettier-ignore -->
```markdown
  диск, переименование при антивирусе, сброс папки на диск, наследование прав, `sc start` при
  маркере `host.restore-intent`, WebView2 для страницы. Список — в памятке, раздел 10.
```

заменить на

<!-- prettier-ignore -->
```markdown
  диск, переименование при антивирусе, сброс папки на диск, наследование прав, `sc start` при
  маркере `host.restore-intent`, WebView2 для страницы. Список — в памятке, раздел 10.

## 22. Уточнения плана РК-С

План `docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md` (сторона станции в
сверке после восстановления) уточняет абзац «Повторная регистрация блоков» раздела 11 и раздел 19
так. Номер раздела — следующий свободный по всем планам на момент написания (ПЛ-Х — 18; РК, ПЛ-Ц,
ЧЗ и 2a7 — 19 в своих ветках; 2a8 — 20; О-Ф — 21); при слиянии разделы нумеруются заново, а ссылки
на «раздел 22» в памятке и в `apps/standalone/AGENTS.md` поправляются вместе с ними.

- **Где станция берёт эпоху.** Оболочка перед каждым потоком ленты читает `GET /v1/hello` тем же
  клиентом с закреплённым сертификатом; статус «на связи» несёт `restoreEpoch`. Неудачное чтение
  поток не останавливает: эпоха прочитается при следующем подключении. Вебвью сам запросов не
  делает.
- **Обязательство.** Новую для этого подключения станции эпоху станция записывает в свою базу
  (`floor_restore_epochs`, миграция оболочки `0009`) раньше всего остального; запись переживает
  перезапуск. Пока обязательство не исполнено, записи смены хосту не уходят: короб, закрытый номером
  блока, которого хост не знает, получил бы отказ навсегда.
- **Блоки.** Станция отправляет все свои блоки этого подключения, и израсходованные тоже (их номера
  напечатаны), по 64 в запросе, ровно как хост их выдал. Блок, который хост отклонил
  (`block_overlap`, `block_mismatch`, `prefix_unknown`, `range_invalid`), станция больше не
  использует: курсор уходит за конец блока, короба закрываются остальными блоками, а новый блок
  запрашивается по правилу половины. Сколько блоков отклонено, говорит строка состояния цеха. Ответ
  `conflict` с `no_restore` значит, что возвращать нечего. Сбой запроса — повтор с тем же
  нарастающим ожиданием, что у ленты; хост отвечает `known` на блок, который уже принял.
- **Затем одной транзакцией:** следующая синхронизация справочников начинается с нуля (копии
  остаются рабочими, пока не пришла первая страница), записи, подтверждённые хостом за последние
  30 дней (решение 31 этапа 2a), снова ждут отправки, обязательство закрыто. Хост отвечает на
  известную ему запись прежней квитанцией, поэтому ничего не применяется дважды. Если за это время
  хост восстановили ещё раз, транзакция не проходит, и следующий прогон исполняет новую эпоху.
- **Удержание.** Ответ `restore_pending` — не сбой хоста, а отдельное состояние: станция повторяет
  отправку через 60 секунд (`Retry-After` хоста; оболочка заголовков вебвью не передаёт, поэтому
  число записано с обеих сторон и сверяется тестом), строка состояния говорит «Хост восстановлен из
  копии — отправка ждёт администратора», цех сканирует и закрывает короба без хоста, проверка кода
  при удержании пропускает скан, как при любом сбое проверки. Ничего не теряется.
- **Офис.** Карточка удержания на странице «Резервные копии» показывает у каждой станции, вернула
  ли она блоки, а окно возобновления — сколько из скольких; проверки памятки остаются обязательными.
- **Не сделано:** подключение без блоков маршрут не вызывает (хост принимает 1–64 блока), и офис
  показывает его как «Не вернула»; станция, у которой чтение `hello` не удалось, узнает о
  восстановлении только при следующем подключении; пометки конфликта на сканах и коробах остаются,
  когда запись уходит повторно; повторной регистрации смен нет.
- **Не проверено:** всё на Windows и на настоящем восстановлении `markiro-host restore` со станцией,
  которая печатает (памятка, раздел 10, пункт 9); чтение эпохи оболочкой проверено на настоящем хосте
  на 127.0.0.1 с эпохой, записанной тестом в `site`.
```

- [ ] **Step 2: Полная проверка**

Run (вне песочницы, без параллельных сборок): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` и `cargo test --manifest-path apps/standalone/Cargo.toml --offline --locked --workspace --no-fail-fast`

Expected: 63 строки `test result: ok`, 962 теста, 0 отказов (на копии: так и есть).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run`

Expected: 109 файлов, 3138 тестов. Отказы по пределу 5 с в файлах, которые план не трогает (см. «Счёт тестов»), повторить отдельным запуском файла; на копии при нагрузке 56–70: 13 таких отказов, после повтора — только `template-editor` и `templates-page`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `… run lint`, `… run build`

Expected: без ошибок.

Run: prettier по всем изменённым планом TS, TSX, JSON и MD (26 файлов на копии) путями от корня с `--ignore-path .prettierignore`; `git diff --check <база>..HEAD`; `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`

Expected: `All matched files use Prettier code style!`; молчит; молчит.

- [ ] **Step 3: Коммит**

```bash
git add apps/standalone/AGENTS.md docs/runbooks/standalone-backup-restore.md docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md
git commit -m "docs(standalone): plan РК-С in AGENTS, the restore runbook and the pilot spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- **Покрытие спецификации.** §11 «станция, увидевшая новую эпоху, отправляет свои блоки» — задача 1 (эпоха), задача 2 (`reconcileRestore`), задача 3 (когда); «затем повторно досылает факты, хранящиеся 30 дней» — задача 2 (`RESEND_WINDOW_MS`, повторное открытие в той же транзакции), задача 3 (очередь после сверки); §19 «сброс по эпохе — условие пилота» — задача 2 (`FROM_ZERO_SQL`), задача 3 (синхронизация после сверки); «частями по 64, затем фактов» — задачи 2 и 3 (L1, L2); удержание `restore_pending` без потерь — задача 3 (`held`, 60 с, тест на две отправки и ноль потерь); видимость — задача 3 (строка состояния), задача 4 (офис); документы — задача 5.
- **Мутанты.** Каждое новое правило держит хотя бы один тест: чтение и разбор эпохи (M1–M3), обязательство, окно, проверка ответа, `no_restore`, отклонённые блоки, гонка эпох, метка ленты (R1–R8), порядок «блоки раньше очереди», запись эпохи очередью, ожидание удержания, запуск и повтор сверки (L1–L7), три строки состояния (S1–S3), офис (O1, O2). Все 25 убиты на копии. Не мутировалась очистка эпохи при новом подключении (задача 1, причина там).
- **Типы и имена между задачами** сверены: `HostStatus.restoreEpoch` (1) → `useHostLink` (3); `noteRestoreEpoch`/`restoreDue`/`reconcileRestore`/`readRestoreStatus`/`RestoreStatus` (2) → `host-link.ts`, `FloorStatusBar.tsx` (3); `HostApi.registerKnownBlocks` (2) → `App.tsx` (3); `FactsFailure` `held` (3) → `FloorStatusBar.tsx` (3).
- **Проверки на копии.** Сценарий применил каждый шаг к копии с базы: шаг 1 каждой задачи дал ровно отказы шага 2, шаг 3 — проходы шага 4, дерево после каждой задачи совпало с её коммитом байт в байт. Полный прогон после задачи 3: cargo `--workspace` — 63 строки, 962 теста, всё зелёное (вне песочницы); Vitest — 109 файлов, 3138 тестов, из них 13 отказов по пределу 5 с в пяти файлах, которых план не касается (см. «Счёт тестов»); `typecheck`, `lint`, `build` — без ошибок на итоговом коммите; prettier (26 файлов), `cargo fmt --check`, `git diff --check` — чисто.

## Перенесено

1. **`Retry-After` через оболочку.** Сейчас число записано с обеих сторон и сверяется тестом (С2). Если хост начнёт менять `Retry-After` по обстоятельствам, `host_request` должен вернуть заголовок (`HostResponse.retryAfter`), а `HostError` — нести его; это правка оболочки, Zod `hostResponseSchema` и всех фейков `host_request`.
2. **Подключение без блоков.** Хост принимает 1–64 блока, поэтому станция без блоков маршрут не вызывает, и офис показывает её «Не вернула», хотя возвращать ей нечего. Правка хоста: разрешить пустой список и отмечать `known_blocks_epoch`; станция тогда отправит пустой запрос.
3. **Пометки конфликта.** Квитанция `conflict` оставила `floor_scans.conflict` и `floor_boxes.needs_fix`; если повторная отправка той же записи примет её, пометки остаются. Снимать их по новой квитанции — решение плана очереди (ОЧ).
4. **Неудачное чтение `hello`.** Подключение, у которого чтение эпохи не удалось, узнаёт о восстановлении только при следующем подключении и тем временем отправляет записи; до возобновления их держит хост, после — нет. Повторять чтение `hello` по таймеру или читать его и при первой ревизии — после пилота, если это увидят.
5. **Повторная регистрация смен** после восстановления — по-прежнему нет (план РК, «Перенесено»); факты смен, созданных или открытых после копии, получат `unknown_shift`/`not_entered`.
6. **Окно повторной отправки по времени копии.** Станция снова отправляет записи всех 30 дней, потому что не знает времени копии. Если хост начнёт отдавать время копии (например, в `restoreHold` или в `hello`), окно можно сузить до него.

## Что должен предоставить владелец

1. Учебное восстановление на двух ПК с Windows по памятке, раздел 10, п. 9: станция печатает, хост восстановлен из часовой копии, блок, выданный после копии, зарегистрирован снова, «отправка ждёт администратора» раз в минуту, после «Возобновить» — ноль `sscc_not_issued`, ноль повторных SSCC, справочники станции совпадают с офисом.
2. Решение по С1 (окно 30 дней) и по С6 (записи ждут, пока блоки не возвращены, даже после возобновления), если хочется иначе.

## Не проверено (без Windows и без настоящего восстановления)

- Настоящий `markiro-host restore` при станции, которая печатает: чтение эпохи оболочкой проверено на настоящем хосте на 127.0.0.1, но эпоху в `site` писал тест; связь, сверка и строка состояния — только в jsdom и на `node:sqlite` с фейковым `HostApi`.
- WebView2, Windows, две станции и сеть; объявления вежливой области для чтения с экрана — только jsdom.
- Объём повторной отправки 30 дней записей реальной станции (сотни пакетов) по сети цеха.
- Слияние с 2a7, ПЛ-Ц и 2a8 (их нет на копии; места сдвига — в «Заметках»).

## Отклонения при исполнении
